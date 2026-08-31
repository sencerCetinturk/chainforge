"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const router_1 = require("./router");
const configManager_1 = require("./configManager");
const panel_1 = require("./panel");
const license_1 = require("./license");
const spending_1 = require("./spending");
const chatStore_1 = require("./chatStore");
const telemetry_1 = require("./telemetry");
const freeModels_1 = require("./freeModels");
const modelCatalog_1 = require("./modelCatalog");
const orchestrator_1 = require("./agent/orchestrator");
const workspaceScanner_1 = require("./agent/workspaceScanner");
const changeLogger_1 = require("./agent/changeLogger");
const codeIndex_1 = require("./agent/codeIndex");
const fileApplier_1 = require("./agent/fileApplier");
const inspector_1 = require("./agent/inspector");
const undoStore_1 = require("./agent/undoStore");
let router = null;
let configManager = null;
let licenseManager = null;
let spendingManager = null;
let telemetry = null;
let chatStore = null;
let chainPanel = null;
let activeChatAbort = null; // sohbet iptali için
let activeAgentAbort = null; // agent task iptali için
// OpenRouter'ın canlı :free kataloğuna göre doğrulanmış model ID'leri — extension açılışında
// bir kez çekilir (modelCatalog.ts). null = henüz çekilmedi/ağ hatası → statik listeye düş.
let liveFreeModelIds = null;
// Şu an sürmekte olan bir görevin GERÇEK maliyetini (o göreve ait tüm AI çağrılarının toplamı)
// izlemek için — recordUsage bu aktifken maliyeti buraya da ekler.
let activeTaskCost = null;
// "Geri Al" geçmişi — diskte kalıcı (globalStorage/chainforge-logs/.../undo/), pencere kapansa da kaybolmaz.
// Free: sadece son 1 batch. Pro: son 20 batch (çoklu undo).
// NOT: UndoStore workspace klasörünü constructor'da okur, bu yüzden ChangeLogger deseninde
// olduğu gibi HER kullanımda taze bir örnek oluşturulur (tekil/singleton yapılmaz).
const MAX_UNDO_HISTORY_PRO = 20;
async function pushAppliedBatch(context, batch) {
    if (batch.length === 0)
        return;
    const pro = (await licenseManager?.isPro()) || false;
    await new undoStore_1.UndoStore(context).push(batch, pro ? MAX_UNDO_HISTORY_PRO : 1);
}
// Model ID'yi kısa okunur ada çevir (UI canlı gösterge için)
function shortModel(id) {
    const fm = (0, freeModels_1.getFreeModel)(id);
    if (fm)
        return fm.label;
    const parts = id.replace(":free", "").split("/");
    return parts[parts.length - 1] || id;
}
// Teknik hata mesajlarını kullanıcı dostu tek satıra indirger (sorun: hata yağmuru)
function simplifyError(raw) {
    const m = (raw || "").toLowerCase();
    if (/enotfound|getaddrinfo|network|econn/.test(m))
        return "İnternete ulaşılamıyor. Bağlantınızı (veya VPN'i) kontrol edin.";
    if (/401|403|unauthorized|api key|geçersiz.*key|invalid.*key/.test(m))
        return "API anahtarı geçersiz. Ayarlar'dan kontrol edin veya ücretsiz modu kullanın.";
    if (/quota|rate.?limit|exceeded|token.*(limit|doldu)|credits?/.test(m))
        return "Bu modelin limiti doldu. Birazdan tekrar deneyin veya başka model seçin.";
    if (/not a valid model|no endpoints|model.*not found/.test(m))
        return "Seçili model şu an kullanılamıyor. Ayarlar'dan başka bir model seçin.";
    if (/döngü|loop/.test(m))
        return "Yedek ayarlarında döngü var. Ayarlar'dan agent yedeklerini kontrol edin.";
    if (/timeout|zaman aşımı/.test(m))
        return "İstek zaman aşımına uğradı. Tekrar deneyin.";
    if (!raw)
        return "Bir şeyler ters gitti. Tekrar deneyin.";
    return raw.length > 120 ? raw.slice(0, 120) + "…" : raw;
}
// Seçilen dile göre AI sistem promptu oluşturur
// PRO ÖZELLİĞİ: kullanıcının tanımladığı özel talimatlar her chat/agent görevine otomatik eklenir.
// Free kullanıcıda ayar dolu olsa bile uygulanmaz (isPro kontrolü çağıran tarafta yapılır).
// Takım/proje bazlı paylaşılabilir talimatlar: workspace kökünde ".chainforge/instructions.md"
// varsa (repo'ya committ edilip takımla paylaşılabilir) okunur. Kişisel talimatlarla (VS Code
// ayarları, sadece bu makinede) birleştirilir — proje talimatları önce gelir.
async function getProjectInstructions() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders)
        return "";
    try {
        const uri = vscode.Uri.joinPath(folders[0].uri, ".chainforge", "instructions.md");
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        return raw.trim().slice(0, 4000);
    }
    catch {
        return ""; // dosya yok — normal, çoğu proje için beklenen durum
    }
}
async function getCustomInstructions() {
    const isPro = (await licenseManager?.isPro()) || false;
    if (!isPro)
        return "";
    const list = vscode.workspace.getConfiguration("chainforge").get("customInstructions") || [];
    const personal = list.filter(s => s && s.trim()).map(s => `- ${s.trim()}`).join("\n").slice(0, 4000);
    const project = await getProjectInstructions();
    const parts = [];
    if (project)
        parts.push(`[PROJE TALİMATLARI — .chainforge/instructions.md]\n${project}`);
    if (personal)
        parts.push(`[KİŞİSEL TALİMATLAR]\n${personal}`);
    return parts.join("\n\n");
}
// Uygulanan dosya değişikliklerinden ucuz bir ücretsiz modelle conventional-commits formatında
// tek satırlık bir commit mesajı üretir. Tam diff yerine sadece dosya adı+aksiyon + görev
// niyeti gönderilir — hem ucuz hem genelde yeterli bağlam sağlar.
async function generateCommitMessage(changes, intent) {
    if (!router)
        return null;
    const model = (0, freeModels_1.filterAliveChain)(freeModels_1.FREE_FALLBACK_CHAIN, liveFreeModelIds)[0];
    if (!model)
        return null;
    const fileList = changes.map(c => `${c.action}: ${c.filePath}`).join("\n");
    const prompt = `Şu görev ve değişen dosyalara göre, conventional commits formatında (feat/fix/refactor/chore + kısa açıklama), İNGİLİZCE, TEK SATIRLIK bir git commit mesajı yaz. SADECE mesajı yaz, tırnak/açıklama ekleme.\n\nGörev: ${intent}\n\nDosyalar:\n${fileList}`;
    try {
        const res = await router.callDirect(model, "Sen kısa, net commit mesajları yazan bir asistansın.", prompt, false);
        if (!res.success || !res.content.trim())
            return null;
        return res.content.trim().split("\n")[0].replace(/^["'`]+|["'`]+$/g, "").slice(0, 200);
    }
    catch {
        return null;
    }
}
function getChatSystemPrompt(lang) {
    switch (lang) {
        case "tr": return "Sen yardımcı bir kod ve geliştirme asistanısın. Net, doğru ve özlü yanıt ver. Türkçe yanıt ver.";
        case "de": return "Du bist ein hilfreicher Code- und Entwicklungsassistent. Sei klar, genau und präzise. Antworte auf Deutsch.";
        case "fr": return "Tu es un assistant de code et de développement utile. Sois clair, précis et concis. Réponds en français.";
        case "es": return "Eres un asistente de código y desarrollo útil. Sé claro, preciso y conciso. Responde en español.";
        case "ja": return "あなたは役立つコーディング・開発アシスタントです。明確に、正確に、簡潔に答えてください。日本語で回答してください。";
        case "zh": return "你是一个有用的编程和开发助手。请清晰、准确、简洁地回答。请用中文回答。";
        default: return "You are a helpful coding and development assistant. Be clear, accurate, and concise. Respond in English.";
    }
}
function getLanguageInstruction(lang) {
    switch (lang) {
        case "tr": return "Türkçe yanıt ver.";
        case "de": return "Antworte auf Deutsch.";
        case "fr": return "Réponds en français.";
        case "es": return "Responde en español.";
        case "ja": return "日本語で回答してください。";
        case "zh": return "请用中文回答。";
        default: return "Respond in English.";
    }
}
async function activate(context) {
    configManager = new configManager_1.ConfigManager(context);
    licenseManager = new license_1.LicenseManager(context);
    spendingManager = new spending_1.SpendingManager(context);
    // OpenRouter'dan güncel fiyatları arka planda çek (token harcamaz); gelince stats'ı yenile
    (0, spending_1.refreshPricingCache)(context).then(() => chainPanel?.refreshView()).catch(() => { });
    chatStore = new chatStore_1.ChatStore(context);
    // MULTI-ROOT UYARISI: ChainForge şu an sadece ilk workspace klasörünü kullanıyor
    // (workspaceScanner, fileApplier, changeLogger, undoStore hep folders[0]'a yazar/okur).
    // Bunu gizlemek yerine kullanıcıya açıkça söylüyoruz.
    const warnIfMultiRoot = () => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length <= 1)
            return;
        const key = `chainforge.multiRootWarned.${folders.length}`;
        if (context.globalState.get(key))
            return;
        context.globalState.update(key, true);
        vscode.window.showInformationMessage(`ChainForge şu an yalnızca ilk workspace klasörünü ("${folders[0].name}") kullanıyor. Çoklu-root desteği henüz yok.`);
    };
    warnIfMultiRoot();
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(warnIfMultiRoot));
    const version = context.extension?.packageJSON?.version || "0.0.0";
    telemetry = new telemetry_1.TelemetryManager(context, version);
    context.subscriptions.push({ dispose: () => telemetry?.dispose() });
    // Oturum başlangıcı + onay (ilk açılışta sorar)
    telemetry.record({ type: "session", name: "activate" });
    telemetry.ensureConsent();
    // Sürüm güncelleme bildirimi — yeni versiyon ilk açılışında "Yenilikler" göster
    const lastSeenVersion = context.globalState.get("chainforge.lastSeenVersion", "");
    if (lastSeenVersion && lastSeenVersion !== version) {
        const changelog = {
            "1.4.2": "• Path traversal ve lisans bypass güvenlik açıkları kapatıldı\n• Tek tık \"Geri Al\" (Pro: sınırsız geçmiş)\n• Özel Global Talimatlar (Pro)\n• Aylık harcama tavanı ve git-kirli uyarısı\n• Hızlı Kurulum preset'leri, onboarding turu\n• Çoklu routing agent desteği ve öncelik sırası\n• Denetmen ↔ Postacı otomatik hata giderme döngüsü (kalıcı hata tespiti)",
        };
        const notes = changelog[version] || "Hata düzeltmeleri ve iyileştirmeler.";
        vscode.window.showInformationMessage(`ChainForge ${version} — Yenilikler:\n${notes}`, "Tamam");
    }
    context.globalState.update("chainforge.lastSeenVersion", version);
    // Ücretsiz model kataloğunu OpenRouter'ın canlı listesine karşı doğrula (key gerekmez,
    // 24 saat önbelleklenir). Statik listelerdeki (freeModels.ts) modeller zamanla ölebiliyor —
    // bu, ölü modellere düşmeyi önler. Arka planda çalışır, hazır olunca paneli tazeler.
    (0, modelCatalog_1.refreshFreeModelCatalog)(context).then(ids => {
        liveFreeModelIds = ids;
        chainPanel?.refreshView();
    });
    // Her AI çağrısının token kullanımını otomatik kaydet (orchestrator, inspector, fixErrors dahil)
    const recordUsage = (model, usage) => {
        const cost = (0, spending_1.estimateCost)(model, usage.promptTokens, usage.completionTokens);
        if (activeTaskCost?.active)
            activeTaskCost.total += cost;
        spendingManager.addRecord({
            timestamp: Date.now(),
            model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            estimatedCostUsd: cost,
        });
        // Anonim kullanım telemetrisi (model adı + token sayısı, içerik değil)
        telemetry?.record({ type: "usage", name: "ai_call", model, tokens: usage.totalTokens, costUsd: cost });
        checkBudgetThreshold(context);
    };
    // Aylık harcama tavanına yaklaşıldığında/aşıldığında bir kez uyar (spam yapmaz)
    const checkBudgetThreshold = (ctx) => {
        const budget = vscode.workspace.getConfiguration("chainforge").get("monthlyBudgetUsd") || 0;
        if (budget <= 0 || !spendingManager)
            return;
        const stats = spendingManager.getMonthlyStats();
        const ratio = stats.totalCost / budget;
        const warnKey = (pct) => `chainforge.budgetWarned.${stats.month}.${pct}`;
        if (ratio >= 1 && !ctx.globalState.get(warnKey(100))) {
            ctx.globalState.update(warnKey(100), true);
            vscode.window.showWarningMessage(`ChainForge: Aylık tahmini harcama $${stats.totalCost.toFixed(2)} — belirlediğiniz $${budget} tavanı aşıldı.`);
        }
        else if (ratio >= 0.8 && !ctx.globalState.get(warnKey(80))) {
            ctx.globalState.update(warnKey(80), true);
            vscode.window.showInformationMessage(`ChainForge: Aylık tahmini harcama $${stats.totalCost.toFixed(2)} — $${budget} tavanının %80'ine ulaştı.`);
        }
    };
    // Dil ayarı — hesaba bağlı, globalState'te (workspace'ten ve vscode ayarlarından bağımsız,
    // böylece farklı klasörden açılsa bile kullanıcının seçimi kalıcı olur)
    const getLang = () => {
        return (context.globalState.get("chainforge.language") || "en");
    };
    const saveLang = (lang) => {
        context.globalState.update("chainforge.language", lang);
        router?.setLanguageHint(lang);
    };
    // Router oluşturulduğunda token kancasını + Pro durumunu + dil ayarını bağla
    const makeRouter = (cfg) => {
        const r = new router_1.AIRouter(cfg);
        r.setUsageSink(recordUsage);
        licenseManager.isPro().then(pro => r.setProStatus(pro));
        r.setLanguageHint(getLang());
        return r;
    };
    // Workspace'e özgü anahtar (görev adımları/işlem geçmişi/sohbet modeli gibi proje bazlı verileri ayırmak için)
    const wsKey = () => {
        const folders = vscode.workspace.workspaceFolders;
        return folders && folders.length > 0 ? folders[0].uri.fsPath : "__global__";
    };
    // Sohbet modeli — proje bazlı (ChatStore ile aynı desende)
    const getChatModel = () => context.globalState.get(`chainforge.chatModel.${wsKey()}`) || "__auto_free__";
    const saveChatModel = (model) => context.globalState.update(`chainforge.chatModel.${wsKey()}`, model);
    const onSaveConfig = async (newConfig) => {
        await configManager.saveConfig(newConfig);
        if (!router)
            router = makeRouter(newConfig);
        else
            router.updateConfig(newConfig);
    };
    const onActivateLicense = async (key) => {
        const result = await licenseManager.activateLicense(key);
        if (result.valid) {
            router?.setProStatus(true);
            telemetry?.record({ type: "feature", name: "pro_activated" });
            // Satın alan herkese görünür, samimi bir teşekkür — sessizce geçmesin
            vscode.window.showInformationMessage("🎉 ChainForge Pro'ya hoş geldin! Bunu bağımsız geliştiren biri olarak, desteğin gerçekten çok kıymetli. Teşekkür ederim — Sencer 💙");
        }
        return { success: result.valid, error: result.error };
    };
    const onDeactivateLicense = async () => {
        await licenseManager.deactivateLicense();
        router?.setProStatus(false); // Pro kaldırıldı → ilk 3 dışı agent'lar devre dışı
    };
    const onTask = async (prompt, taskType) => {
        if (!router)
            return { success: false, error: "Router başlatılmadı", content: "", usedAgent: "", usedModel: "", attempts: [] };
        const result = await router.run(prompt, taskType);
        // Token kaydı artık router.usageSink ile otomatik — burada sadece maliyeti UI'ya iletiyoruz
        if (result.success && result.usage) {
            const cost = (0, spending_1.estimateCost)(result.usedModel, result.usage.promptTokens, result.usage.completionTokens);
            return { ...result, estimatedCost: cost };
        }
        return result;
    };
    // WebviewViewProvider olarak panel oluştur
    const createPanel = async () => {
        const currentConfig = await configManager.loadConfig();
        const currentIsPro = await licenseManager.isPro();
        if (currentConfig && router)
            router.updateConfig(currentConfig);
        chainPanel = new panel_1.AIChainPanel(context.extensionUri, currentConfig, onTask, () => configManager.openConfigFile(), async (key) => {
            await vscode.workspace.getConfiguration("chainforge").update("openRouterKey", key, vscode.ConfigurationTarget.Global);
            // ATTRIBUTION (anonim): bu kullanıcı OpenRouter key bağladı — key ASLA gönderilmez,
            // sadece olay + anonim oturum ID. ChainForge'un OpenRouter'a getirdiği kullanıcı kanıtı.
            if (typeof key === "string" && key.startsWith("sk-or-")) {
                telemetry?.record({ type: "feature", name: "openrouter_key_connected" });
            }
        }, onSaveConfig, onActivateLicense, onDeactivateLicense, currentIsPro, getLang(), licenseManager.getSavedKey(), spendingManager, !!vscode.workspace.getConfiguration("chainforge").get("openRouterKey"), telemetry?.getConsent() || "ask", () => chatStore.get(), // proje bazlı geçmiş sohbet (canlı)
        chatStore.summary(), // ayarlar için özet
        vscode.workspace.getConfiguration("chainforge").get("customInstructions") || [], saveLang, // dil → globalState (workspace bağımsız)
        getChatModel(), // sohbet modeli → proje bazlı
        saveChatModel, context.globalState.get(`chainforge.lastTaskSteps.${wsKey()}`, []), context.globalState.get(`chainforge.opHistory.${wsKey()}`, []), () => liveFreeModelIds);
        return chainPanel;
    };
    // Komutları HEMEN kaydet
    const openPanel = vscode.commands.registerCommand("chainforge.openPanel", async () => {
        // Sadece view'a focus et — WebviewViewProvider halleder
        await vscode.commands.executeCommand("chainforgeView.focus");
    });
    // Kenar çubuğundaki (bazen dar kalan) görünümün alternatifi: aynı paneli büyük bir editör
    // sekmesinde açar. Aynı chainPanel örneğini kullanır — tüm durum (config/isPro/vs.) ortak.
    let fullViewPanel;
    const openFullView = vscode.commands.registerCommand("chainforge.openFullView", async () => {
        if (fullViewPanel) {
            fullViewPanel.reveal();
            return;
        }
        fullViewPanel = vscode.window.createWebviewPanel("chainforgeFullView", "ChainForge", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] });
        fullViewPanel.iconPath = vscode.Uri.joinPath(context.extensionUri, "icon-activitybar.svg");
        // NOT: chainPanel henüz oluşmamış olabilir (createPanel() async) — panelPromise'ı
        // bekleyerek, sidebar view'ın kendisinin yaptığı gibi güvenli şekilde erişiyoruz.
        const panel = await panelPromise;
        panel.attachWebviewPanel(fullViewPanel);
        fullViewPanel.onDidDispose(() => { fullViewPanel = undefined; });
    });
    // Editörde seçili koda sağ-tık ile doğrudan agent görevi başlatma — panele gitme sürtünmesini
    // kaldırır. Seçim yoksa dosyanın tamamı bağlam olarak eklenir.
    const agentTaskFromSelection = vscode.commands.registerCommand("chainforge.agentTaskFromSelection", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("ChainForge: Açık bir dosya yok.");
            return;
        }
        const selection = editor.selection;
        const selectedText = selection && !selection.isEmpty ? editor.document.getText(selection) : "";
        const relPath = vscode.workspace.workspaceFolders
            ? vscode.workspace.asRelativePath(editor.document.uri, false)
            : editor.document.fileName;
        const instruction = await vscode.window.showInputBox({
            prompt: selectedText ? `Seçili kodla (${relPath}) ne yapmak istiyorsun?` : `${relPath} ile ne yapmak istiyorsun?`,
            placeHolder: "Örn: bu fonksiyona hata yönetimi ekle",
        });
        if (!instruction)
            return;
        const contextBlock = selectedText
            ? `\n\nDosya: ${relPath}\nSeçili kod:\n\`\`\`\n${selectedText}\n\`\`\``
            : `\n\nDosya: ${relPath}`;
        const presetPrompt = instruction + contextBlock;
        await vscode.commands.executeCommand("chainforge.agentTask", presetPrompt, true, undefined, getLang());
    });
    // Problems panelindeki (derleyici/linter) hatalara doğrudan "ChainForge ile düzelt" hızlı
    // düzeltmesi ekler — Denetmen'in ayrı tam-tarama akışından bağımsız, TEK bir tanıya odaklı.
    const fixDiagnostic = vscode.commands.registerCommand("chainforge.fixDiagnostic", async (uri, diag) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const startLine = Math.max(0, diag.range.start.line - 3);
        const endLine = Math.min(doc.lineCount - 1, diag.range.end.line + 3);
        const contextCode = doc.getText(new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length));
        const relPath = vscode.workspace.workspaceFolders ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath;
        const presetPrompt = `Şu hatayı düzelt: "${diag.message}" (${relPath}, satır ${diag.range.start.line + 1})\n\nİlgili kod:\n\`\`\`\n${contextCode}\n\`\`\``;
        await vscode.commands.executeCommand("chainforge.agentTask", presetPrompt, true, undefined, getLang());
    });
    const codeActionProvider = vscode.languages.registerCodeActionsProvider({ scheme: "file" }, {
        provideCodeActions(document, _range, ctx) {
            return ctx.diagnostics
                .filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
                .map(diag => {
                const action = new vscode.CodeAction(`ChainForge ile düzelt: ${diag.message.slice(0, 60)}`, vscode.CodeActionKind.QuickFix);
                action.command = { command: "chainforge.fixDiagnostic", title: "ChainForge ile düzelt", arguments: [document.uri, diag] };
                action.diagnostics = [diag];
                return action;
            });
        },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] });
    const runTask = vscode.commands.registerCommand("chainforge.runTask", async () => {
        if (!router) {
            vscode.window.showErrorMessage("ChainForge: Önce yapılandırın.");
            return;
        }
        const config = await configManager.loadConfig();
        if (!config)
            return;
        const taskTypes = Object.entries(config.tasks).map(([key, task]) => ({
            label: task.description || key, value: key
        }));
        const selected = await vscode.window.showQuickPick(taskTypes.map(t => t.label), { placeHolder: "Görev tipi seçin" });
        if (!selected)
            return;
        const taskKey = taskTypes.find(t => t.label === selected)?.value || "general";
        const editor = vscode.window.activeTextEditor;
        const selectedText = editor?.document.getText(editor.selection);
        const prompt = await vscode.window.showInputBox({ prompt: "Promptunuzu girin", value: selectedText || "" });
        if (!prompt)
            return;
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "ChainForge çalışıyor..." }, async () => {
            const result = await onTask(prompt, taskKey);
            if (result.success) {
                const doc = await vscode.workspace.openTextDocument({ content: result.content, language: "markdown" });
                vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            }
            else {
                vscode.window.showErrorMessage(`ChainForge Hata: ${result.error}`);
            }
        });
    });
    const configure = vscode.commands.registerCommand("chainforge.configure", async () => {
        await configManager.openConfigFile();
    });
    // SOHBET — hafızalı konuşma (dosya yazmaz, önceki mesajları hatırlar)
    // modelId: "__auto_free__" | "<provider/model:free>" | "agent:<key>"
    const chat = vscode.commands.registerCommand("chainforge.chat", async (history, sendToPanel, modelId = "__auto_free__", lang = "en") => {
        if (!router) {
            sendToPanel({ command: "chatReply", data: { success: false, error: "Önce başlangıç ayarlarını yapın." } });
            return;
        }
        const config = await configManager.loadConfig();
        if (config)
            router.updateConfig(config);
        sendToPanel({ command: "chatLoading" });
        // Yeni iptal denetleyici
        activeChatAbort = new AbortController();
        const signal = activeChatAbort.signal;
        // AI'ya yalnızca user/assistant rolleri gider — "info" gibi UI notları API'yi bozar
        // Token taşmasını önlemek için: toplam karakter ~60k altında kalacak şekilde eski mesajları kırp
        const clean = history.filter(m => m.role === "user" || m.role === "assistant");
        let trimmed = [];
        let charCount = 0;
        for (let i = clean.length - 1; i >= 0; i--) {
            charCount += clean[i].content.length;
            if (charCount > 60000)
                break;
            trimmed.unshift(clean[i]);
        }
        if (trimmed.length === 0 && clean.length > 0)
            trimmed = clean.slice(-1); // en azından son mesaj
        // PROJE FARKINDALIĞI — dosyaları DOĞRUDAN okur (açık olmaları gerekmez)
        let systemPrompt = getChatSystemPrompt(lang || "en");
        const customInstructions = await getCustomInstructions();
        if (customInstructions) {
            systemPrompt += `\n\n[TALİMATLAR]\n${customInstructions}`;
        }
        if (vscode.workspace.workspaceFolders) {
            try {
                const scanner = new workspaceScanner_1.WorkspaceScanner();
                const files = await scanner.scanAll();
                const fileList = files.slice(0, 60).map(f => f.path).join(", ");
                const ctxLabel = (lang === "tr") ? "PROJE BAĞLAMI" : "PROJECT CONTEXT";
                const ctxFiles = (lang === "tr") ? "Projedeki dosyalar" : "Project files";
                systemPrompt += `\n\n[${ctxLabel}]\n${ctxFiles}: ${fileList || (lang === "tr" ? "(henüz dosya yok)" : "(no files yet)")}.`;
                // Kullanıcının son sorusuna en alakalı dosyaları OKU (açık olması gerekmez)
                const lastUserMsg = [...trimmed].reverse().find(m => m.role === "user")?.content || "";
                const relevant = scanner.rankByRelevance(files, lastUserMsg, 4);
                for (const rf of relevant) {
                    const content = await scanner.readFile(rf.path);
                    if (content) {
                        systemPrompt += `\n\n--- DOSYA: ${rf.path} ---\n${content.slice(0, 2500)}`;
                    }
                }
                // Editörde açık dosya varsa onu da ekle (öncelikli bağlam)
                const editor = vscode.window.activeTextEditor;
                if (editor && editor.document.uri.scheme === "file") {
                    const fname = editor.document.fileName.split(/[\\/]/).pop();
                    const openLabel = (lang === "tr") ? "ŞU AN AÇIK" : "CURRENTLY OPEN";
                    systemPrompt += `\n\n[${openLabel}] "${fname}":\n${editor.document.getText().slice(0, 3000)}`;
                }
                const ctxInstr = (lang === "tr")
                    ? "Yukarıdaki dosya içeriklerini kullanarak yanıt ver. Proje hakkındaki sorulara bu bağlamla cevap verebilirsin."
                    : "Use the above file contents to answer. You can answer project-related questions with this context.";
                systemPrompt += `\n\n${ctxInstr}`;
            }
            catch { /* workspace okunamadıysa bağlamsız devam */ }
        }
        // Agent başarısız olup ücretsiz modele geçildiğinde kullanıcıyı bilgilendiren not
        let fallbackNotice = "";
        try {
            // 1) Kendi agent'ı seçildiyse → o agent'la dene; başarısızsa ücretsiz modele DÜŞ
            if (modelId.startsWith("agent:")) {
                const agentKey = modelId.slice(6);
                if (config?.agents[agentKey]) {
                    const agentName = config.agents[agentKey].name || agentKey;
                    const result = await router.runFromAgent(agentKey, "", false, trimmed);
                    if (result.success && result.content.trim()) {
                        finishChat(true, result.content, result.usedModel, result.usage, undefined, sendToPanel);
                        return;
                    }
                    // Agent çalışmadı → kullanıcıya neden geçildiğini bildir
                    fallbackNotice = `"${agentName}" çalışmadı (${simplifyError(result.error || "")}). Ücretsiz modele geçildi.`;
                }
            }
            // 2a) Otomatik seçili ve routing agent varsa → önce router'ı(ları) dene
            if (modelId === "__auto_free__") {
                const routingKeys = router.findAllAgentsByRole("routing");
                for (const rKey of routingKeys) {
                    if (signal.aborted) {
                        sendToPanel({ command: "chatCancelled" });
                        return;
                    }
                    const rName = config?.agents[rKey]?.name || rKey;
                    sendToPanel({ command: "chatTrying", model: rName });
                    const rResult = await router.runFromAgent(rKey, "", false, trimmed);
                    if (signal.aborted) {
                        sendToPanel({ command: "chatCancelled" });
                        return;
                    }
                    if (rResult.success && rResult.content.trim()) {
                        finishChat(true, rResult.content, rResult.usedModel, rResult.usage, undefined, sendToPanel);
                        return;
                    }
                }
            }
            // 2b) Ücretsiz model(ler) — seçili model başarısızsa diğer ücretsizlere düş
            const isSingleChoice = modelId !== "__auto_free__" && !modelId.startsWith("agent:");
            const chosenLabel = isSingleChoice ? shortModel(modelId) : "";
            const effectiveFallbackChain = (0, freeModels_1.filterAliveChain)(freeModels_1.FREE_FALLBACK_CHAIN, liveFreeModelIds);
            const tryModels = (modelId === "__auto_free__" || modelId.startsWith("agent:"))
                ? effectiveFallbackChain
                : [modelId, ...effectiveFallbackChain.filter(m => m !== modelId)]; // seçili önce, sonra yedekler
            let lastErr = "";
            for (let i = 0; i < tryModels.length; i++) {
                if (signal.aborted) {
                    sendToPanel({ command: "chatCancelled" });
                    return;
                }
                const model = tryModels[i];
                sendToPanel({ command: "chatTrying", model: shortModel(model) });
                const r = await router.callDirect(model, systemPrompt, "", false, signal, trimmed);
                if (signal.aborted) {
                    sendToPanel({ command: "chatCancelled" });
                    return;
                }
                if (r.success && r.content.trim()) {
                    const tokens = r.usage?.totalTokens || 0;
                    // Seçili model dışında bir modele düşüldüyse bilgilendir
                    let notice = fallbackNotice;
                    if (!notice && isSingleChoice && i > 0) {
                        notice = `${chosenLabel} şu an yanıt vermedi, ${shortModel(model)} ile cevaplandı.`;
                    }
                    sendToPanel({ command: "chatReply", data: { success: true, content: r.content, model: shortModel(model), tokens, notice } });
                    telemetry?.record({ type: "feature", name: "chat", success: true, model });
                    return;
                }
                lastErr = r.error || "boş yanıt";
            }
            sendToPanel({ command: "chatReply", data: { success: false, error: simplifyError(lastErr) } });
            telemetry?.recordError("chat", lastErr, undefined, { tool: "chat/freeModel" });
        }
        catch (err) {
            sendToPanel({ command: "chatReply", data: { success: false, error: simplifyError(err?.message || "") } });
            telemetry?.recordError("chat_crash", err?.message || "", undefined, { tool: "chat", err });
        }
        function finishChat(ok, content, model, usage, error, send) {
            if (ok) {
                send({ command: "chatReply", data: { success: true, content, model: shortModel(model), tokens: usage?.totalTokens || 0 } });
                telemetry?.record({ type: "feature", name: "chat", success: true, model });
            }
            else {
                send({ command: "chatReply", data: { success: false, error: simplifyError(error || "") } });
                telemetry?.recordError("chat", error || "", model, { tool: "chat/agent" });
            }
        }
    });
    // DENETMEN — dosyaları kontrol et (ilk kez tümü, sonra sadece değişenler)
    const inspect = vscode.commands.registerCommand("chainforge.inspect", async () => {
        if (!router) {
            vscode.window.showErrorMessage("ChainForge: Önce API key ayarlayın.");
            return;
        }
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showErrorMessage("ChainForge: Bir klasör açın.");
            return;
        }
        const config = await configManager.loadConfig();
        if (config)
            router.updateConfig(config);
        const output = vscode.window.createOutputChannel("ChainForge Denetmen");
        output.show(true);
        output.appendLine(`\n[${new Date().toLocaleString("tr-TR")}] 🔎 Denetim başladı`);
        const log = (m) => output.appendLine(m);
        const scanner = new workspaceScanner_1.WorkspaceScanner();
        const changeLogger = new changeLogger_1.ChangeLogger(context);
        const inspector = new inspector_1.Inspector(router, scanner, changeLogger, context, log, undefined, (persistentPaths) => {
            vscode.window.showWarningMessage(`Denetmen: ${persistentPaths.length} dosyada kalıcı hata var. Postacı düzeltsin mi?`, "Evet, Düzelt", "Hayır").then(choice => {
                if (choice === "Evet, Düzelt") {
                    vscode.commands.executeCommand("chainforge.fixErrors", log);
                }
            });
        });
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "ChainForge Denetmen...", cancellable: false }, async () => {
            try {
                const r = await inspector.inspect();
                // Tek rapor dosyasına yaz
                await inspector.writeInspectionReport(r.results, { checked: r.checked, errors: r.errors, clean: r.clean });
                log(`\n✅ Denetim tamamlandı: ${r.checked} dosya, ${r.errors} hatalı, ${r.clean} temiz.`);
                vscode.window.showInformationMessage(`Denetmen: ${r.checked} dosya kontrol edildi, ${r.errors} hatalı.`);
            }
            catch (err) {
                log(`\n❌ Hata: ${err?.message}`);
            }
        });
    });
    // Panel tabanlı denetim — sonuçları panele geri gönderir
    const inspectFromPanel = vscode.commands.registerCommand("chainforge.inspectFromPanel", async (sendToPanel) => {
        if (!router) {
            sendToPanel({ command: "inspectionError", error: "Önce API key ayarlayın." });
            return;
        }
        if (!vscode.workspace.workspaceFolders) {
            sendToPanel({ command: "inspectionError", error: "Bir klasör açın (File → Open Folder)." });
            return;
        }
        const config = await configManager.loadConfig();
        if (config)
            router.updateConfig(config);
        const scanner = new workspaceScanner_1.WorkspaceScanner();
        const changeLogger = new changeLogger_1.ChangeLogger(context);
        // Panel ilerleme bildirimi
        const onProgress = (checked, total, currentFile) => {
            sendToPanel({ command: "inspectionProgress", data: { checked, total, currentFile } });
        };
        // Output channel'a da yaz ( debug için )
        const output = vscode.window.createOutputChannel("ChainForge Denetmen");
        const log = (m) => { output.appendLine(m); };
        const inspector = new inspector_1.Inspector(router, scanner, changeLogger, context, log, onProgress, (persistentPaths) => {
            sendToPanel({ command: "persistentErrors", data: { paths: persistentPaths, count: persistentPaths.length } });
        });
        try {
            // Rapor dosyalarının zaman damgasına göre inkremental/tam tarama yapar
            const r = await inspector.inspect(false);
            // Raporu dosyaya yazdır ve panelde göster
            const files = r.results.map(res => ({
                path: res.filePath,
                status: res.status,
                issues: res.issues,
            }));
            // Rapor metnini okuyup panele de gönder
            const reportText = await inspector.writeInspectionReport(r.results, {
                checked: r.checked, errors: r.errors, clean: r.clean,
            });
            telemetry?.record({ type: "feature", name: "inspect", success: true, meta: { checked: r.checked, errors: r.errors, clean: r.clean } });
            sendToPanel({
                command: "inspectionDone",
                data: {
                    checked: r.checked,
                    errors: r.errors,
                    clean: r.clean,
                    files,
                    report: reportText,
                },
            });
        }
        catch (err) {
            telemetry?.recordError("inspect", err?.message || "", undefined, { tool: "inspector", err });
            sendToPanel({ command: "inspectionError", error: err?.message || "Denetim hatası" });
        }
    });
    // POSTACI — Denetmen'in hata raporunu okuyup ilgili AI'lara düzeltme emri verir
    const fixErrors = vscode.commands.registerCommand("chainforge.fixErrors", async (sendToPanel) => {
        if (!router) {
            sendToPanel({ command: "result", data: { success: false, error: "Önce API key ayarlayın." } });
            return;
        }
        if (!vscode.workspace.workspaceFolders) {
            sendToPanel({ command: "result", data: { success: false, error: "Bir klasör açın." } });
            return;
        }
        const config = await configManager.loadConfig();
        if (config)
            router.updateConfig(config);
        const scanner = new workspaceScanner_1.WorkspaceScanner();
        const changeLogger = new changeLogger_1.ChangeLogger(context);
        const applier = new fileApplier_1.FileApplier();
        const codingTaskType = Object.keys(config?.tasks || {})[0] || "";
        sendToPanel({ command: "loading" });
        try {
            // 1. En son denetim raporunu oku (Inspector ile aynı globalStorage konumu)
            const wsKey2 = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/[:\\/]/g, "_").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(-80);
            const logDir = vscode.Uri.joinPath(context.globalStorageUri, "chainforge-logs", wsKey2, "inspections");
            let reportFiles = [];
            try {
                reportFiles = await vscode.workspace.fs.readDirectory(logDir);
            }
            catch { /* yok */ }
            // En son JSON raporu bul
            let latestJson = "";
            for (const [name] of reportFiles) {
                const m = name.match(/^rapor_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.json$/);
                if (m && m[1] > latestJson)
                    latestJson = m[1];
            }
            if (!latestJson) {
                sendToPanel({ command: "result", data: { success: false, error: "Henüz denetim raporu yok. Önce Dosyaları Tara ile denetim yapın." } });
                return;
            }
            const reportUri = vscode.Uri.joinPath(logDir, `rapor_${latestJson}.json`);
            const reportRaw = Buffer.from(await vscode.workspace.fs.readFile(reportUri)).toString("utf8");
            const report = JSON.parse(reportRaw);
            const errorFiles = (report.files || []).filter((f) => f.status === "error");
            if (errorFiles.length === 0) {
                sendToPanel({ command: "result", data: { success: true, content: "✅ Tüm dosyalar zaten temiz, düzeltilecek bir şey yok." } });
                return;
            }
            sendToPanel({ command: "result", data: { success: true, content: `${errorFiles.length} hatalı dosya düzeltiliyor…` } });
            // 2. Her hatalı dosya için düzeltme promptu hazırla
            const allChanges = [];
            // AI yanıtından dosya içeriğini parse eden yardımcı
            const extractCode = (response) => {
                // Format: <<<FILE: path | ACTION: modify>>> ... <<<END>>>
                const m = response.match(/<<<FILE:[^>]+>>>\s*([\s\S]*?)<<<END>>>/i);
                if (m)
                    return m[1].trim();
                // Format: ``` ... ```
                const m2 = response.match(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/);
                if (m2)
                    return m2[1].trim();
                return null;
            };
            for (const ef of errorFiles) {
                const filePath = ef.path;
                const issues = ef.issues || [];
                // Dosya içeriğini oku
                const fileContent = await scanner.readFile(filePath);
                if (fileContent === null)
                    continue;
                // Hata detaylarını prompta ekle
                const issueList = issues.map((iss, i) => `  ${i + 1}. Satır ${iss.line} [${iss.severity}]: ${iss.message}`).join("\n");
                const fixPrompt = `Aşağıdaki dosyada Denetmen tarafından tespit edilen HATALARI DÜZELT.

DOSYA: ${filePath}

TESPİT EDİLEN HATALAR:
${issueList}

MEVCUT KOD:
\`\`\`
${fileContent}
\`\`\`

TALİMATLAR:
- SADECE yukarıda listelenen hataları düzelt, çalışan koda dokunma
- Her düzeltmede güvenli ve doğru yaklaşımı kullan
- Düzeltilmiş dosyanın TAMAMINI yaz
- Yanıtında SADECE düzeltilmiş kodu ver, açıklama yazma
- <<<FILE: path | ACTION: modify>>> ... <<<END>>> formatını KULLAN`;
                // Coding agent'a gönder
                const codingStart = config?.tasks[codingTaskType]?.primary || Object.keys(config?.agents || {})[0];
                if (!codingStart)
                    continue;
                const codeRes = await router.runFromAgent(codingStart, fixPrompt);
                if (codeRes.success && codeRes.content) {
                    const newContent = extractCode(codeRes.content);
                    if (newContent) {
                        allChanges.push({
                            filePath,
                            action: "modify",
                            originalContent: fileContent,
                            newContent,
                            description: `Denetmen hataları düzeltildi: ${filePath}`,
                        });
                    }
                    else {
                        // Kod bloğu bulunamazsa tüm yanıtı yeni içerik olarak al
                        allChanges.push({
                            filePath,
                            action: "modify",
                            originalContent: fileContent,
                            newContent: codeRes.content,
                            description: `Denetmen hataları düzeltildi: ${filePath}`,
                        });
                    }
                }
                // İlerleme bildir
                sendToPanel({
                    command: "result",
                    data: {
                        success: true,
                        content: `   ✓ ${filePath} — ${issues.length} hata için düzeltme hazırlandı (${codeRes.usedModel})`,
                        usedAgent: codeRes.usedAgent,
                        usedModel: codeRes.usedModel,
                    },
                });
            }
            // 3. Değişiklikleri uygula
            if (allChanges.length > 0) {
                const { applied, skipped } = await applier.applyBatch(allChanges);
                for (const change of applied) {
                    await changeLogger.log(change, "postman-fix", router.getConfig().agents[codingTaskType]?.model || "?", "Denetmen hatalarının düzeltilmesi");
                }
                if (applied.length > 0)
                    await pushAppliedBatch(context, applied);
                sendToPanel({
                    command: "result",
                    data: {
                        success: true,
                        content: `\n✅ ${applied.length} dosya düzeltildi, ${skipped.length} atlandı.\n\nDeğişiklikler loglandı. Tekrar "Dosyaları Tara" ile kontrol edebilirsiniz.`,
                        revertible: applied.length > 0,
                    },
                });
                vscode.window.showInformationMessage(`ChainForge: ${applied.length} hata düzeltildi.`);
            }
            else {
                sendToPanel({
                    command: "result",
                    data: { success: true, content: "\n⚠ Hiçbir düzeltme üretilemedi. Hataları manuel inceleyin." },
                });
            }
        }
        catch (err) {
            sendToPanel({ command: "result", data: { success: false, error: err?.message || "Düzeltme hatası" } });
            vscode.window.showErrorMessage(`ChainForge düzeltme hatası: ${err?.message}`);
        }
    });
    // Denetmen checkpoint sıfırla (sonraki kontrol tüm dosyaları tarar)
    const inspectReset = vscode.commands.registerCommand("chainforge.inspectReset", async () => {
        const scanner = new workspaceScanner_1.WorkspaceScanner();
        const changeLogger = new changeLogger_1.ChangeLogger(context);
        if (router) {
            const inspector = new inspector_1.Inspector(router, scanner, changeLogger, context, () => { });
            inspector.resetCheckpoint();
            vscode.window.showInformationMessage("Denetmen checkpoint sıfırlandı — sonraki kontrol tüm dosyaları tarayacak.");
        }
    });
    // AGENT MODU — Postacı: dosyaları tarar, araştırır, kod yazar
    // applyFiles=true → diff onayıyla dosyaya yazar + loglar
    // applyFiles=false → sadece adımları + üretilen içeriği gösterir
    const agentTask = vscode.commands.registerCommand("chainforge.agentTask", async (presetPrompt, applyFiles = false, sendToPanel, lang = "en") => {
        if (!router) {
            const e = "Önce config + API key ayarlayın.";
            vscode.window.showErrorMessage(`ChainForge: ${e}`);
            sendToPanel?.({ command: "result", data: { success: false, error: e } });
            return;
        }
        if (!vscode.workspace.workspaceFolders) {
            const e = "Bir klasör açın (File → Open Folder).";
            vscode.window.showErrorMessage(`ChainForge: ${e}`);
            sendToPanel?.({ command: "result", data: { success: false, error: e } });
            return;
        }
        const rawPrompt = presetPrompt || await vscode.window.showInputBox({
            prompt: "Ne yapmak istiyorsun?",
            placeHolder: "Görevini doğal dilde yaz...",
        });
        if (!rawPrompt)
            return;
        // Seçilen dile göre yanıt dili talimatını ekle + Pro: özel talimatlar
        const customInstructions = await getCustomInstructions();
        const userPrompt = rawPrompt + "\n\n[" + getLanguageInstruction(lang) + "]"
            + (customInstructions ? `\n\n[TALİMATLAR]\n${customInstructions}` : "");
        const config = await configManager.loadConfig();
        if (config)
            router.updateConfig(config);
        const output = vscode.window.createOutputChannel("ChainForge Agent");
        output.show(true);
        output.appendLine(`\n[${new Date().toLocaleString("tr-TR")}] ▶ ${userPrompt}`);
        output.appendLine(`   Mod: ${applyFiles ? "Dosyalara uygula" : "Sadece göster"}\n`);
        const steps = [];
        const log = (m) => {
            output.appendLine(m);
            steps.push(m);
            sendToPanel?.({ command: "agentStep", step: m });
        };
        const saveSteps = () => {
            const key = `chainforge.lastTaskSteps.${wsKey()}`;
            context.globalState.update(key, steps.slice(-200));
        };
        const saveOperationHistory = (summary, model, files, costUsd) => {
            const key = `chainforge.opHistory.${wsKey()}`;
            const history = context.globalState.get(key, []);
            history.push({ ts: new Date().toISOString(), prompt: rawPrompt.slice(0, 120), summary, model, files, costUsd });
            if (history.length > 50)
                history.splice(0, history.length - 50);
            context.globalState.update(key, history);
        };
        // İptal kontrolörü — kullanıcı durdurursa orchestrator'ın sonucu görmezden gelinir
        activeAgentAbort = new AbortController();
        const agentSignal = activeAgentAbort.signal;
        const scanner = new workspaceScanner_1.WorkspaceScanner();
        const changeLogger = new changeLogger_1.ChangeLogger(context);
        const codeIndexStore = new codeIndex_1.CodeIndexStore(context);
        const orchestrator = new orchestrator_1.Orchestrator(router, scanner, log, undefined, changeLogger, codeIndexStore);
        const applier = new fileApplier_1.FileApplier();
        const codingTaskType = config ? Object.keys(config.tasks)[0] || "" : "";
        const t0 = Date.now();
        activeTaskCost = { active: true, total: 0 }; // bu görevin AI çağrılarının GERÇEK toplam maliyetini izle
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "ChainForge çalışıyor...", cancellable: false }, async () => {
            try {
                const result = await orchestrator.run(userPrompt, codingTaskType);
                if (agentSignal.aborted) {
                    // kullanıcı iptal ettiyse sonucu görmezden gel ama paneli "meşgul değil" durumuna döndür
                    sendToPanel?.({ command: "result", data: { success: false, error: "İptal edildi." } });
                    return;
                }
                if (!result.success) {
                    log(`\n❌ Hata: ${result.error}`);
                    saveSteps();
                    telemetry?.recordError("agentTask", result.error || "", result.codingModel, { tool: "orchestrator" });
                    sendToPanel?.({ command: "result", data: { success: false, error: result.error } });
                    return;
                }
                telemetry?.record({ type: "feature", name: "agentTask", success: true, durationMs: Date.now() - t0, model: result.codingModel, meta: { applyFiles, changeCount: result.changes.length } });
                if (result.flowEvents && result.flowEvents.length > 0) {
                    telemetry?.recordFlow(result.flowEvents, result.codingModel, rawPrompt.slice(0, 100));
                }
                if (result.changes.length === 0) {
                    log("\n⚠ Dosya değişikliği üretilmedi.");
                    sendToPanel?.({ command: "result", data: { success: true, content: steps.join("\n") + "\n\n" + (result.rawResponse || ""), usedAgent: result.codingAgent, usedModel: result.codingModel, attempts: result.attempts } });
                    return;
                }
                // Panele gösterilecek içerik: adımlar + dosya içerikleri
                let displayContent = steps.join("\n") + "\n\n";
                for (const c of result.changes) {
                    displayContent += `\n═══ ${c.filePath} (${c.action}) ═══\n${c.newContent}\n`;
                }
                let revertible = false;
                if (applyFiles) {
                    // Diff onayı + uygula + logla
                    const { applied, skipped } = await applier.applyBatch(result.changes);
                    for (const change of applied) {
                        await changeLogger.log(change, result.codingAgent, result.codingModel, result.plan?.intent || userPrompt);
                    }
                    if (applied.length > 0) {
                        await pushAppliedBatch(context, applied);
                        revertible = true;
                    }
                    log(`\n✅ ${applied.length} dosya uygulandı, ${skipped.length} atlandı.`);
                    const logDirPath = changeLogger.getLogDir();
                    if (logDirPath)
                        log(`   Loglar: ${logDirPath}`);
                    vscode.window.showInformationMessage(`ChainForge: ${applied.length} dosya güncellendi.`, "Logları Göster", "Commit Mesajı Oluştur").then(async (choice) => {
                        if (choice === "Logları Göster" && logDirPath) {
                            vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(logDirPath));
                        }
                        else if (choice === "Commit Mesajı Oluştur") {
                            const msg = await generateCommitMessage(applied, result.plan?.intent || userPrompt);
                            if (msg) {
                                await vscode.env.clipboard.writeText(msg);
                                vscode.window.showInformationMessage(`Commit mesajı panoya kopyalandı:\n"${msg}"`);
                            }
                            else {
                                vscode.window.showWarningMessage("ChainForge: Commit mesajı oluşturulamadı.");
                            }
                        }
                    });
                    // Tamamlanma özeti
                    const summaryLines = [];
                    if (result.plan?.intent)
                        summaryLines.push(`**Görev:** ${result.plan.intent}`);
                    if (result.codingModel)
                        summaryLines.push(`**Model:** ${result.codingModel}`);
                    if (applied.length > 0) {
                        summaryLines.push(`\n**Uygulanan dosyalar (${applied.length}):**`);
                        for (const c of applied)
                            summaryLines.push(`• \`${c.filePath}\` — ${c.action === "create" ? "oluşturuldu" : c.action === "delete" ? "silindi" : "güncellendi"}`);
                    }
                    if (skipped.length > 0)
                        summaryLines.push(`\n**Atlanan (${skipped.length}):** ${skipped.map(c => c.filePath).join(", ")}`);
                    const taskCost = activeTaskCost?.total || 0;
                    if (taskCost > 0)
                        summaryLines.push(`\n**Gerçek maliyet:** $${taskCost.toFixed(4)}`);
                    displayContent = steps.join("\n") + "\n\n---\n" + summaryLines.join("\n");
                }
                else {
                    log(`\n📄 ${result.changes.length} dosya üretildi (uygulanmadı — checkbox kapalı).`);
                }
                const taskCostForLog = activeTaskCost?.total || 0;
                if (taskCostForLog > 0)
                    log(`   💰 Bu görevin gerçek maliyeti: $${taskCostForLog.toFixed(4)}`);
                saveSteps();
                if (applyFiles && result.changes.length > 0) {
                    saveOperationHistory((result.plan?.intent || rawPrompt).slice(0, 200), result.codingModel, result.changes.map(c => c.filePath), taskCostForLog || undefined);
                }
                sendToPanel?.({
                    command: "result",
                    data: {
                        success: true,
                        content: displayContent,
                        usedAgent: result.codingAgent,
                        usedModel: result.codingModel,
                        attempts: result.attempts,
                        revertible,
                    },
                });
            }
            catch (err) {
                log(`\n❌ Beklenmeyen hata: ${err?.message}`);
                saveSteps();
                telemetry?.recordError("agentTask_crash", err?.message || "", undefined, { tool: "orchestrator", err });
                sendToPanel?.({ command: "result", data: { success: false, error: err?.message } });
                vscode.window.showErrorMessage(`ChainForge hatası: ${err?.message}`);
            }
            finally {
                activeTaskCost = null; // sonraki (agent dışı) AI çağrıları bu göreve yanlışlıkla eklenmesin
            }
        });
    });
    const setTelemetry = vscode.commands.registerCommand("chainforge.setTelemetry", (enabled) => {
        telemetry?.setConsent(enabled ? "granted" : "denied");
    });
    // Sohbet geçmişini kaydet (proje bazlı)
    const saveChat = vscode.commands.registerCommand("chainforge.saveChat", async (messages) => {
        if (Array.isArray(messages))
            await chatStore?.save(messages);
    });
    // Sohbeti yarıda kes
    const cancelChat = vscode.commands.registerCommand("chainforge.cancelChat", () => {
        activeChatAbort?.abort();
    });
    const cancelAgentTask = vscode.commands.registerCommand("chainforge.cancelAgentTask", () => {
        activeAgentAbort?.abort();
        activeAgentAbort = null;
    });
    // GERİ AL — diskteki geçmişten en son batch'i geri alır (LIFO). Free: tek adım. Pro: son 20 adıma kadar zincirleme.
    const revertLastChange = vscode.commands.registerCommand("chainforge.revertLastChange", async (sendToPanel) => {
        const store = new undoStore_1.UndoStore(context);
        const batch = await store.popLatest();
        if (!batch || batch.length === 0) {
            vscode.window.showInformationMessage("ChainForge: Geri alınacak bir değişiklik yok.");
            return;
        }
        const answer = await vscode.window.showWarningMessage(`${batch.length} dosyadaki değişiklik geri alınsın mı?`, { modal: true }, "Evet, Geri Al");
        if (answer !== "Evet, Geri Al") {
            // Vazgeçildi — kaydı diske geri koy ki kaybolmasın
            const isPro = (await licenseManager?.isPro()) || false;
            await store.push(batch, isPro ? MAX_UNDO_HISTORY_PRO : 1);
            return;
        }
        const applier = new fileApplier_1.FileApplier();
        const { reverted, failed } = await applier.revertBatch(batch);
        const hasMore = await store.hasAny();
        if (failed.length > 0) {
            vscode.window.showWarningMessage(`ChainForge: ${reverted} dosya geri alındı, ${failed.length} dosya geri alınamadı: ${failed.join(", ")}`);
        }
        else {
            vscode.window.showInformationMessage(`ChainForge: ${reverted} dosya geri alındı.${hasMore ? " (daha fazla adım geri alınabilir)" : ""}`);
        }
        sendToPanel?.({ command: "revertDone", data: { reverted, failed, hasMore } });
    });
    // Sohbet temizle: scope "current" (bu proje) | "all" (tümü)
    const clearChat = vscode.commands.registerCommand("chainforge.clearChat", async (scope) => {
        if (scope === "all")
            await chatStore?.clearAll();
        else
            await chatStore?.clearCurrent();
        chainPanel?.refreshView(); // panel yeniden yüklensin (sohbet + sayılar güncellensin)
    });
    const openUrl = vscode.commands.registerCommand("chainforge.openUrl", async (url) => {
        const allowed = ["openrouter.ai", "dodopayments.com", "checkout.dodopayments.com", "dodo.pe"];
        try {
            const u = new URL(url);
            if (allowed.some(d => u.hostname === d || u.hostname.endsWith("." + d))) {
                // ATTRIBUTION (anonim): kullanıcı OpenRouter'a yönlendirildi
                if (u.hostname.endsWith("openrouter.ai")) {
                    telemetry?.record({ type: "feature", name: "openrouter_link_click" });
                }
                await vscode.env.openExternal(vscode.Uri.parse(url));
            }
        }
        catch { }
    });
    // WebviewViewProvider kaydet — panel lazy oluşturulur
    const panelPromise = createPanel();
    const webviewProvider = {
        resolveWebviewView: async (webviewView, ctx, token) => {
            const panel = await panelPromise;
            panel.resolveWebviewView(webviewView, ctx, token);
        }
    };
    context.subscriptions.push(openPanel, openFullView, agentTaskFromSelection, fixDiagnostic, codeActionProvider, runTask, configure, openUrl, agentTask, chat, cancelChat, cancelAgentTask, revertLastChange, inspect, inspectFromPanel, fixErrors, inspectReset, setTelemetry, saveChat, clearChat, vscode.window.registerWebviewViewProvider(panel_1.AIChainPanel.viewType, webviewProvider, {
        webviewOptions: { retainContextWhenHidden: true }
    }));
    // Async başlatma
    configManager.loadConfig().then(config => {
        if (config)
            router = makeRouter(config);
    });
    licenseManager.checkSavedLicense();
    vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration("chainforge")) {
            // NOT: Dil artık panelden seçilip globalState'te tutuluyor (saveLang() zaten
            // router.setLanguageHint()'i orada çağırıyor) — burada ayrı bir "chainforge.language"
            // VS Code ayarı YOK, o yüzden burada tekrar okumaya gerek yok (kaldırılan hayalet ayar).
            const newConfig = await configManager.loadConfig();
            if (newConfig) {
                if (!router)
                    router = makeRouter(newConfig);
                else
                    router.updateConfig(newConfig);
            }
        }
    });
}
function deactivate() { }
//# sourceMappingURL=extension.js.map