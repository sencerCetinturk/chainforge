import * as vscode from "vscode";
import { AIRouter, ChainConfig } from "./router";
import { ConfigManager } from "./configManager";
import { AIChainPanel } from "./panel";
import { LicenseManager } from "./license";
import { SpendingManager, estimateCost, refreshPricingCache } from "./spending";
import { ChatStore } from "./chatStore";
import { TelemetryManager } from "./telemetry";
import { FREE_FALLBACK_CHAIN, getFreeModel } from "./freeModels";
import { Language } from "./i18n";
import { Orchestrator } from "./agent/orchestrator";
import { WorkspaceScanner } from "./agent/workspaceScanner";
import { ChangeLogger } from "./agent/changeLogger";
import { FileApplier } from "./agent/fileApplier";
import { Inspector } from "./agent/inspector";

let router: AIRouter | null = null;
let configManager: ConfigManager | null = null;
let licenseManager: LicenseManager | null = null;
let spendingManager: SpendingManager | null = null;
let telemetry: TelemetryManager | null = null;
let chatStore: ChatStore | null = null;
let chainPanel: AIChainPanel | null = null;
let activeChatAbort: AbortController | null = null; // sohbet iptali için

// Model ID'yi kısa okunur ada çevir (UI canlı gösterge için)
function shortModel(id: string): string {
  const fm = getFreeModel(id);
  if (fm) return fm.label;
  const parts = id.replace(":free", "").split("/");
  return parts[parts.length - 1] || id;
}

// Teknik hata mesajlarını kullanıcı dostu tek satıra indirger (sorun: hata yağmuru)
function simplifyError(raw: string): string {
  const m = (raw || "").toLowerCase();
  if (/enotfound|getaddrinfo|network|econn/.test(m)) return "İnternete ulaşılamıyor. Bağlantınızı (veya VPN'i) kontrol edin.";
  if (/401|403|unauthorized|api key|geçersiz.*key|invalid.*key/.test(m)) return "API anahtarı geçersiz. Ayarlar'dan kontrol edin veya ücretsiz modu kullanın.";
  if (/quota|rate.?limit|exceeded|token.*(limit|doldu)|credits?/.test(m)) return "Bu modelin limiti doldu. Birazdan tekrar deneyin veya başka model seçin.";
  if (/not a valid model|no endpoints|model.*not found/.test(m)) return "Seçili model şu an kullanılamıyor. Ayarlar'dan başka bir model seçin.";
  if (/döngü|loop/.test(m)) return "Yedek ayarlarında döngü var. Ayarlar'dan agent yedeklerini kontrol edin.";
  if (/timeout|zaman aşımı/.test(m)) return "İstek zaman aşımına uğradı. Tekrar deneyin.";
  if (!raw) return "Bir şeyler ters gitti. Tekrar deneyin.";
  return raw.length > 120 ? raw.slice(0, 120) + "…" : raw;
}

// Seçilen dile göre AI sistem promptu oluşturur
function getChatSystemPrompt(lang: string): string {
  switch (lang) {
    case "tr": return "Sen yardımcı bir kod ve geliştirme asistanısın. Net, doğru ve özlü yanıt ver. Türkçe yanıt ver.";
    case "de": return "Du bist ein hilfreicher Code- und Entwicklungsassistent. Sei klar, genau und präzise. Antworte auf Deutsch.";
    case "fr": return "Tu es un assistant de code et de développement utile. Sois clair, précis et concis. Réponds en français.";
    case "es": return "Eres un asistente de código y desarrollo útil. Sé claro, preciso y conciso. Responde en español.";
    case "ja": return "あなたは役立つコーディング・開発アシスタントです。明確に、正確に、簡潔に答えてください。日本語で回答してください。";
    case "zh": return "你是一个有用的编程和开发助手。请清晰、准确、简洁地回答。请用中文回答。";
    default:  return "You are a helpful coding and development assistant. Be clear, accurate, and concise. Respond in English.";
  }
}

function getLanguageInstruction(lang: string): string {
  switch (lang) {
    case "tr": return "Türkçe yanıt ver.";
    case "de": return "Antworte auf Deutsch.";
    case "fr": return "Réponds en français.";
    case "es": return "Responde en español.";
    case "ja": return "日本語で回答してください。";
    case "zh": return "请用中文回答。";
    default:  return "Respond in English.";
  }
}

export async function activate(context: vscode.ExtensionContext) {
  configManager = new ConfigManager(context);
  licenseManager = new LicenseManager(context);
  spendingManager = new SpendingManager(context);
  refreshPricingCache(context); // OpenRouter'dan güncel fiyatları arka planda çek (token harcamaz)
  chatStore = new ChatStore(context);

  const version = (context.extension?.packageJSON?.version as string) || "0.0.0";
  telemetry = new TelemetryManager(context, version);
  context.subscriptions.push({ dispose: () => telemetry?.dispose() });
  // Oturum başlangıcı + onay (ilk açılışta sorar)
  telemetry.record({ type: "session", name: "activate" });
  telemetry.ensureConsent();

  // Her AI çağrısının token kullanımını otomatik kaydet (orchestrator, inspector, fixErrors dahil)
  const recordUsage = (model: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => {
    const cost = estimateCost(model, usage.promptTokens, usage.completionTokens);
    spendingManager!.addRecord({
      timestamp: Date.now(),
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      estimatedCostUsd: cost,
    });
    // Anonim kullanım telemetrisi (model adı + token sayısı, içerik değil)
    telemetry?.record({ type: "usage", name: "ai_call", model, tokens: usage.totalTokens, costUsd: cost });
  };

  // Router oluşturulduğunda token kancasını + Pro durumunu + dil ayarını bağla
  const makeRouter = (cfg: ChainConfig): AIRouter => {
    const r = new AIRouter(cfg);
    r.setUsageSink(recordUsage);
    licenseManager!.isPro().then(pro => r.setProStatus(pro));
    const savedLang = vscode.workspace.getConfiguration("chainforge").get<string>("language") || "en";
    r.setLanguageHint(savedLang);
    return r;
  };

  const getLang = (): Language => {
    const lang = vscode.workspace.getConfiguration("chainforge").get<string>("language") || "en";
    return lang as Language;
  };

  const onSaveConfig = async (newConfig: ChainConfig) => {
    await configManager!.saveConfig(newConfig);
    if (!router) router = makeRouter(newConfig);
    else router.updateConfig(newConfig);
  };

  const onActivateLicense = async (key: string): Promise<{ success: boolean; error?: string }> => {
    const result = await licenseManager!.activateLicense(key);
    if (result.valid) router?.setProStatus(true);
    return { success: result.valid, error: result.error };
  };

  const onDeactivateLicense = async () => {
    await licenseManager!.deactivateLicense();
    router?.setProStatus(false); // Pro kaldırıldı → ilk 3 dışı agent'lar devre dışı
  };

  const onTask = async (prompt: string, taskType: string) => {
    if (!router) return { success: false, error: "Router başlatılmadı", content: "", usedAgent: "", usedModel: "", attempts: [] };
    const result = await router.run(prompt, taskType);
    // Token kaydı artık router.usageSink ile otomatik — burada sadece maliyeti UI'ya iletiyoruz
    if (result.success && result.usage) {
      const cost = estimateCost(result.usedModel, result.usage.promptTokens, result.usage.completionTokens);
      return { ...result, estimatedCost: cost };
    }
    return result;
  };

  // WebviewViewProvider olarak panel oluştur
  const createPanel = async () => {
    const currentConfig = await configManager!.loadConfig();
    const currentIsPro = await licenseManager!.isPro();
    if (currentConfig && router) router.updateConfig(currentConfig);
    chainPanel = new AIChainPanel(
      context.extensionUri,
      currentConfig,
      onTask,
      () => configManager!.openConfigFile(),
      async (key) => {
        await vscode.workspace.getConfiguration("chainforge").update("openRouterKey", key, vscode.ConfigurationTarget.Global);
      },
      onSaveConfig,
      onActivateLicense,
      onDeactivateLicense,
      currentIsPro,
      getLang(),
      licenseManager!.getSavedKey(),
      spendingManager!,
      !!vscode.workspace.getConfiguration("chainforge").get<string>("openRouterKey"),
      telemetry?.getConsent() || "ask",
      () => chatStore!.get(),   // proje bazlı geçmiş sohbet (canlı)
      chatStore!.summary()      // ayarlar için özet
    );
    return chainPanel;
  };

  // Komutları HEMEN kaydet
  const openPanel = vscode.commands.registerCommand("chainforge.openPanel", async () => {
    // Sadece view'a focus et — WebviewViewProvider halleder
    await vscode.commands.executeCommand("chainforgeView.focus");
  });

  const runTask = vscode.commands.registerCommand("chainforge.runTask", async () => {
    if (!router) { vscode.window.showErrorMessage("ChainForge: Önce yapılandırın."); return; }
    const config = await configManager!.loadConfig();
    if (!config) return;

    const taskTypes = Object.entries(config.tasks).map(([key, task]) => ({
      label: task.description || key, value: key
    }));
    const selected = await vscode.window.showQuickPick(taskTypes.map(t => t.label), { placeHolder: "Görev tipi seçin" });
    if (!selected) return;

    const taskKey = taskTypes.find(t => t.label === selected)?.value || "general";
    const editor = vscode.window.activeTextEditor;
    const selectedText = editor?.document.getText(editor.selection);
    const prompt = await vscode.window.showInputBox({ prompt: "Promptunuzu girin", value: selectedText || "" });
    if (!prompt) return;

    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ChainForge çalışıyor..." },
      async () => {
        const result = await onTask(prompt, taskKey);
        if (result.success) {
          const doc = await vscode.workspace.openTextDocument({ content: result.content, language: "markdown" });
          vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        } else {
          vscode.window.showErrorMessage(`ChainForge Hata: ${result.error}`);
        }
      }
    );
  });

  const configure = vscode.commands.registerCommand("chainforge.configure", async () => {
    await configManager!.openConfigFile();
  });

  // SOHBET — hafızalı konuşma (dosya yazmaz, önceki mesajları hatırlar)
  // modelId: "__auto_free__" | "<provider/model:free>" | "agent:<key>"
  const chat = vscode.commands.registerCommand(
    "chainforge.chat",
    async (
      history: { role: "user" | "assistant"; content: string }[],
      sendToPanel: (p: any) => void,
      modelId: string = "__auto_free__",
      lang: string = "en"
    ) => {
      if (!router) {
        sendToPanel({ command: "chatReply", data: { success: false, error: "Önce başlangıç ayarlarını yapın." } });
        return;
      }
      const config = await configManager!.loadConfig();
      if (config) router.updateConfig(config);

      sendToPanel({ command: "chatLoading" });
      // Yeni iptal denetleyici
      activeChatAbort = new AbortController();
      const signal = activeChatAbort.signal;
      // AI'ya yalnızca user/assistant rolleri gider — "info" gibi UI notları API'yi bozar
      const trimmed = history.filter(m => m.role === "user" || m.role === "assistant").slice(-20);

      // PROJE FARKINDALIĞI — dosyaları DOĞRUDAN okur (açık olmaları gerekmez)
      let systemPrompt = getChatSystemPrompt(lang || "en");
      if (vscode.workspace.workspaceFolders) {
        try {
          const scanner = new WorkspaceScanner();
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
        } catch { /* workspace okunamadıysa bağlamsız devam */ }
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

        // 2) Ücretsiz model(ler) — seçili model başarısızsa diğer ücretsizlere düş
        const isSingleChoice = modelId !== "__auto_free__" && !modelId.startsWith("agent:");
        const chosenLabel = isSingleChoice ? shortModel(modelId) : "";
        const tryModels = (modelId === "__auto_free__" || modelId.startsWith("agent:"))
          ? FREE_FALLBACK_CHAIN
          : [modelId, ...FREE_FALLBACK_CHAIN.filter(m => m !== modelId)]; // seçili önce, sonra yedekler
        const userLabel = (lang === "tr") ? "Kullanıcı" : "User";
        const asstLabel = (lang === "tr") ? "Asistan" : "Assistant";
        const convo = trimmed.map(m => `${m.role === "user" ? userLabel : asstLabel}: ${m.content}`).join("\n");
        let lastErr = "";
        for (let i = 0; i < tryModels.length; i++) {
          if (signal.aborted) { sendToPanel({ command: "chatCancelled" }); return; }
          const model = tryModels[i];
          // CANLI: o an gerçekten denenen modeli panele bildir
          sendToPanel({ command: "chatTrying", model: shortModel(model) });
          const r = await router.callDirect(model, systemPrompt, convo, false, signal);
          if (signal.aborted) { sendToPanel({ command: "chatCancelled" }); return; }
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
        telemetry?.recordError("chat", lastErr);
      } catch (err: any) {
        sendToPanel({ command: "chatReply", data: { success: false, error: simplifyError(err?.message || "") } });
      }

      function finishChat(ok: boolean, content: string, model: string, usage: any, error: string | undefined, send: any) {
        if (ok) {
          send({ command: "chatReply", data: { success: true, content, model: shortModel(model), tokens: usage?.totalTokens || 0 } });
          telemetry?.record({ type: "feature", name: "chat", success: true, model });
        } else {
          send({ command: "chatReply", data: { success: false, error: simplifyError(error || "") } });
          telemetry?.recordError("chat", error || "", model);
        }
      }
    }
  );

  // DENETMEN — dosyaları kontrol et (ilk kez tümü, sonra sadece değişenler)
  const inspect = vscode.commands.registerCommand("chainforge.inspect", async () => {
    if (!router) { vscode.window.showErrorMessage("ChainForge: Önce API key ayarlayın."); return; }
    if (!vscode.workspace.workspaceFolders) { vscode.window.showErrorMessage("ChainForge: Bir klasör açın."); return; }

    const config = await configManager!.loadConfig();
    if (config) router.updateConfig(config);

    const output = vscode.window.createOutputChannel("ChainForge Denetmen");
    output.show(true);
    output.appendLine(`\n[${new Date().toLocaleString("tr-TR")}] 🔎 Denetim başladı`);
    const log = (m: string) => output.appendLine(m);

    const scanner = new WorkspaceScanner();
    const changeLogger = new ChangeLogger();
    const inspector = new Inspector(router, scanner, changeLogger, context, log);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ChainForge Denetmen...", cancellable: false },
      async () => {
        try {
          const r = await inspector.inspect();
          // Tek rapor dosyasına yaz
          await inspector.writeInspectionReport(r.results, { checked: r.checked, errors: r.errors, clean: r.clean });
          log(`\n✅ Denetim tamamlandı: ${r.checked} dosya, ${r.errors} hatalı, ${r.clean} temiz.`);
          log(`   Rapor: .chainforge/logs/inspections/rapor_*.txt`);
          vscode.window.showInformationMessage(`Denetmen: ${r.checked} dosya kontrol edildi, ${r.errors} hatalı.`);
        } catch (err: any) {
          log(`\n❌ Hata: ${err?.message}`);
        }
      }
    );
  });

  // Panel tabanlı denetim — sonuçları panele geri gönderir
  const inspectFromPanel = vscode.commands.registerCommand(
    "chainforge.inspectFromPanel",
    async (sendToPanel: (payload: any) => void) => {
      if (!router) {
        sendToPanel({ command: "inspectionError", error: "Önce API key ayarlayın." });
        return;
      }
      if (!vscode.workspace.workspaceFolders) {
        sendToPanel({ command: "inspectionError", error: "Bir klasör açın (File → Open Folder)." });
        return;
      }

      const config = await configManager!.loadConfig();
      if (config) router.updateConfig(config);

      const scanner = new WorkspaceScanner();
      const changeLogger = new ChangeLogger();

      // Panel ilerleme bildirimi
      const onProgress = (checked: number, total: number, currentFile: string) => {
        sendToPanel({ command: "inspectionProgress", data: { checked, total, currentFile } });
      };

      // Output channel'a da yaz ( debug için )
      const output = vscode.window.createOutputChannel("ChainForge Denetmen");
      const log = (m: string) => { output.appendLine(m); };

      const inspector = new Inspector(router, scanner, changeLogger, context, log, onProgress);

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
      } catch (err: any) {
        telemetry?.recordError("inspect", err?.message || "");
        sendToPanel({ command: "inspectionError", error: err?.message || "Denetim hatası" });
      }
    }
  );

  // POSTACI — Denetmen'in hata raporunu okuyup ilgili AI'lara düzeltme emri verir
  const fixErrors = vscode.commands.registerCommand(
    "chainforge.fixErrors",
    async (sendToPanel: (payload: any) => void) => {
      if (!router) {
        sendToPanel({ command: "result", data: { success: false, error: "Önce API key ayarlayın." } });
        return;
      }
      if (!vscode.workspace.workspaceFolders) {
        sendToPanel({ command: "result", data: { success: false, error: "Bir klasör açın." } });
        return;
      }

      const config = await configManager!.loadConfig();
      if (config) router.updateConfig(config);

      const scanner = new WorkspaceScanner();
      const changeLogger = new ChangeLogger();
      const applier = new FileApplier();
      const codingTaskType = Object.keys(config?.tasks || {})[0] || "";

      sendToPanel({ command: "loading" });

      try {
        // 1. En son denetim raporunu oku
        const logDir = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, ".chainforge", "logs", "inspections");
        let reportFiles: [string, vscode.FileType][] = [];
        try { reportFiles = await vscode.workspace.fs.readDirectory(logDir); } catch { /* yok */ }

        // En son JSON raporu bul
        let latestJson = "";
        for (const [name] of reportFiles) {
          const m = name.match(/^rapor_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.json$/);
          if (m && m[1] > latestJson) latestJson = m[1];
        }

        if (!latestJson) {
          sendToPanel({ command: "result", data: { success: false, error: "Henüz denetim raporu yok. Önce Dosyaları Tara ile denetim yapın." } });
          return;
        }

        const reportUri = vscode.Uri.joinPath(logDir, `rapor_${latestJson}.json`);
        const reportRaw = Buffer.from(await vscode.workspace.fs.readFile(reportUri)).toString("utf8");
        const report = JSON.parse(reportRaw);
        const errorFiles = (report.files || []).filter((f: any) => f.status === "error");

        if (errorFiles.length === 0) {
          sendToPanel({ command: "result", data: { success: true, content: "✅ Tüm dosyalar zaten temiz, düzeltilecek bir şey yok." } });
          return;
        }

        sendToPanel({ command: "result", data: { success: true, content: `${errorFiles.length} hatalı dosya düzeltiliyor…` } });

        // 2. Her hatalı dosya için düzeltme promptu hazırla
        const allChanges: any[] = [];

        // AI yanıtından dosya içeriğini parse eden yardımcı
        const extractCode = (response: string): string | null => {
          // Format: <<<FILE: path | ACTION: modify>>> ... <<<END>>>
          const m = response.match(/<<<FILE:[^>]+>>>\s*([\s\S]*?)<<<END>>>/i);
          if (m) return m[1].trim();
          // Format: ``` ... ```
          const m2 = response.match(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/);
          if (m2) return m2[1].trim();
          return null;
        };

        for (const ef of errorFiles) {
          const filePath = ef.path;
          const issues = ef.issues || [];

          // Dosya içeriğini oku
          const fileContent = await scanner.readFile(filePath);
          if (fileContent === null) continue;

          // Hata detaylarını prompta ekle
          const issueList = issues.map((iss: any, i: number) =>
            `  ${i + 1}. Satır ${iss.line} [${iss.severity}]: ${iss.message}`
          ).join("\n");

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
          if (!codingStart) continue;

          const codeRes = await router.runFromAgent(codingStart, fixPrompt);
          if (codeRes.success && codeRes.content) {
            const newContent = extractCode(codeRes.content);
            if (newContent) {
              allChanges.push({
                filePath,
                action: "modify" as const,
                originalContent: fileContent,
                newContent,
                description: `Denetmen hataları düzeltildi: ${filePath}`,
              });
            } else {
              // Kod bloğu bulunamazsa tüm yanıtı yeni içerik olarak al
              allChanges.push({
                filePath,
                action: "modify" as const,
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

          sendToPanel({
            command: "result",
            data: {
              success: true,
              content: `\n✅ ${applied.length} dosya düzeltildi, ${skipped.length} atlandı.\n\nDeğişiklikler loglandı. Tekrar "Dosyaları Tara" ile kontrol edebilirsiniz.`,
            },
          });

          vscode.window.showInformationMessage(`ChainForge: ${applied.length} hata düzeltildi.`);
        } else {
          sendToPanel({
            command: "result",
            data: { success: true, content: "\n⚠ Hiçbir düzeltme üretilemedi. Hataları manuel inceleyin." },
          });
        }
      } catch (err: any) {
        sendToPanel({ command: "result", data: { success: false, error: err?.message || "Düzeltme hatası" } });
        vscode.window.showErrorMessage(`ChainForge düzeltme hatası: ${err?.message}`);
      }
    }
  );

  // Denetmen checkpoint sıfırla (sonraki kontrol tüm dosyaları tarar)
  const inspectReset = vscode.commands.registerCommand("chainforge.inspectReset", async () => {
    const scanner = new WorkspaceScanner();
    const changeLogger = new ChangeLogger();
    if (router) {
      const inspector = new Inspector(router, scanner, changeLogger, context, () => {});
      inspector.resetCheckpoint();
      vscode.window.showInformationMessage("Denetmen checkpoint sıfırlandı — sonraki kontrol tüm dosyaları tarayacak.");
    }
  });

  // AGENT MODU — Postacı: dosyaları tarar, araştırır, kod yazar
  // applyFiles=true → diff onayıyla dosyaya yazar + loglar
  // applyFiles=false → sadece adımları + üretilen içeriği gösterir
  const agentTask = vscode.commands.registerCommand(
    "chainforge.agentTask",
    async (presetPrompt?: string, applyFiles: boolean = false, sendToPanel?: (p: any) => void, lang: string = "en") => {
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
      if (!rawPrompt) return;

      // Seçilen dile göre yanıt dili talimatını ekle
      const userPrompt = rawPrompt + "\n\n[" + getLanguageInstruction(lang) + "]"

      const config = await configManager!.loadConfig();
      if (config) router.updateConfig(config);

      const output = vscode.window.createOutputChannel("ChainForge Agent");
      output.show(true);
      output.appendLine(`\n[${new Date().toLocaleString("tr-TR")}] ▶ ${userPrompt}`);
      output.appendLine(`   Mod: ${applyFiles ? "Dosyalara uygula" : "Sadece göster"}\n`);
      const steps: string[] = [];
      const log = (m: string) => { output.appendLine(m); steps.push(m); };

      const scanner = new WorkspaceScanner();
      const changeLogger = new ChangeLogger();
      const orchestrator = new Orchestrator(router, scanner, log, undefined, changeLogger);
      const applier = new FileApplier();
      const codingTaskType = config ? Object.keys(config.tasks)[0] || "" : "";

      const t0 = Date.now();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "ChainForge çalışıyor...", cancellable: false },
        async () => {
          try {
            const result = await orchestrator.run(userPrompt, codingTaskType);
            if (!result.success) {
              log(`\n❌ Hata: ${result.error}`);
              telemetry?.recordError("agentTask", result.error || "", result.codingModel);
              sendToPanel?.({ command: "result", data: { success: false, error: result.error } });
              return;
            }
            telemetry?.record({ type: "feature", name: "agentTask", success: true, durationMs: Date.now() - t0, model: result.codingModel, meta: { applyFiles, changeCount: result.changes.length } });
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

            if (applyFiles) {
              // Diff onayı + uygula + logla
              const { applied, skipped } = await applier.applyBatch(result.changes);
              for (const change of applied) {
                await changeLogger.log(change, result.codingAgent, result.codingModel, result.plan?.intent || userPrompt);
              }
              log(`\n✅ ${applied.length} dosya uygulandı, ${skipped.length} atlandı.`);
              log(`   Loglar: .chainforge/logs/changes/`);
              vscode.window.showInformationMessage(`ChainForge: ${applied.length} dosya güncellendi.`);
              displayContent = steps.join("\n");
            } else {
              log(`\n📄 ${result.changes.length} dosya üretildi (uygulanmadı — checkbox kapalı).`);
            }

            sendToPanel?.({
              command: "result",
              data: {
                success: true,
                content: displayContent,
                usedAgent: result.codingAgent,
                usedModel: result.codingModel,
                attempts: result.attempts,
              },
            });
          } catch (err: any) {
            log(`\n❌ Beklenmeyen hata: ${err?.message}`);
            telemetry?.recordError("agentTask_crash", err?.message || "");
            sendToPanel?.({ command: "result", data: { success: false, error: err?.message } });
            vscode.window.showErrorMessage(`ChainForge hatası: ${err?.message}`);
          }
        }
      );
    }
  );

  const setTelemetry = vscode.commands.registerCommand("chainforge.setTelemetry", (enabled: boolean) => {
    telemetry?.setConsent(enabled ? "granted" : "denied");
  });

  // Sohbet geçmişini kaydet (proje bazlı)
  const saveChat = vscode.commands.registerCommand("chainforge.saveChat", async (messages: any[]) => {
    if (Array.isArray(messages)) await chatStore?.save(messages);
  });

  // Sohbeti yarıda kes
  const cancelChat = vscode.commands.registerCommand("chainforge.cancelChat", () => {
    activeChatAbort?.abort();
  });

  // Sohbet temizle: scope "current" (bu proje) | "all" (tümü)
  const clearChat = vscode.commands.registerCommand("chainforge.clearChat", async (scope: string) => {
    if (scope === "all") await chatStore?.clearAll();
    else await chatStore?.clearCurrent();
  });

  const openUrl = vscode.commands.registerCommand("chainforge.openUrl", async (url: string) => {
    const allowed = ["openrouter.ai", "dodopayments.com", "checkout.dodopayments.com", "dodo.pe"];
    try {
      const u = new URL(url);
      if (allowed.some(d => u.hostname === d || u.hostname.endsWith("." + d))) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    } catch {}
  });

  // WebviewViewProvider kaydet — panel lazy oluşturulur
  const panelPromise = createPanel();
  const webviewProvider = {
    resolveWebviewView: async (
      webviewView: vscode.WebviewView,
      ctx: vscode.WebviewViewResolveContext,
      token: vscode.CancellationToken
    ) => {
      const panel = await panelPromise;
      panel.resolveWebviewView(webviewView, ctx, token);
    }
  };

  context.subscriptions.push(
    openPanel, runTask, configure, openUrl, agentTask, chat, cancelChat, inspect, inspectFromPanel, fixErrors, inspectReset, setTelemetry, saveChat, clearChat,
    vscode.window.registerWebviewViewProvider(AIChainPanel.viewType, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Async başlatma
  configManager.loadConfig().then(config => {
    if (config) router = makeRouter(config);
  });

  licenseManager.checkSavedLicense();

  vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (e.affectsConfiguration("chainforge")) {
      // Dil değişikliğini router'a ilet
      if (e.affectsConfiguration("chainforge.language")) {
        const newLang = vscode.workspace.getConfiguration("chainforge").get<string>("language") || "en";
        router?.setLanguageHint(newLang);
      }
      const newConfig = await configManager!.loadConfig();
      if (newConfig) {
        if (!router) router = makeRouter(newConfig);
        else router.updateConfig(newConfig);
      }
    }
  });
}

export function deactivate() {}
