"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIChainPanel = void 0;
const vscode = require("vscode");
const i18n_1 = require("./i18n");
const freeModels_1 = require("./freeModels");
const presets_1 = require("./presets");
const freeModels_2 = require("./freeModels");
class AIChainPanel {
    constructor(extensionUri, config, onTask, onOpenConfig, onSaveKey, onSaveConfig, onActivateLicense, onDeactivateLicense, isPro, lang = "en", licenseKey = "", spendingManager, hasApiKey = false, telemetryConsent = "ask", chatProvider = () => [], chatSummary = { projectCount: 0, totalMessages: 0, currentCount: 0 }, customInstructions = [], saveLang = () => { }, chatModel = "__auto_free__", saveChatModel = () => { }, lastTaskSteps = [], opHistory = [], getLiveFreeModelIds = () => null) {
        this.extensionUri = extensionUri;
        this.config = config;
        this.onTask = onTask;
        this.onOpenConfig = onOpenConfig;
        this.onSaveKey = onSaveKey;
        this.onSaveConfig = onSaveConfig;
        this.onActivateLicense = onActivateLicense;
        this.onDeactivateLicense = onDeactivateLicense;
        this.isPro = isPro;
        this.lang = lang;
        this.licenseKey = licenseKey;
        this.spendingManager = spendingManager;
        this.hasApiKey = hasApiKey;
        this.telemetryConsent = telemetryConsent;
        this.chatProvider = chatProvider;
        this.chatSummary = chatSummary;
        this.customInstructions = customInstructions;
        this.saveLang = saveLang;
        this.chatModel = chatModel;
        this.saveChatModel = saveChatModel;
        this.lastTaskSteps = lastTaskSteps;
        this.opHistory = opHistory;
        this.getLiveFreeModelIds = getLiveFreeModelIds;
        this.disposables = [];
        this.nonce = "";
        this.nonce = this.generateNonce();
    }
    resolveWebviewView(webviewView, _context, _token) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        this.update();
        webviewView.onDidDispose(() => {
            this.view = undefined;
            while (this.disposables.length) {
                const d = this.disposables.pop();
                if (d)
                    d.dispose();
            }
        }, null, this.disposables);
        webviewView.webview.onDidReceiveMessage(async (message) => {
            await this.handleMessage(message);
        }, null, this.disposables);
    }
    focus() {
        if (this.view?.show)
            this.view.show(true);
        else if (this.view?.reveal)
            this.view.reveal(undefined, true);
    }
    // Kenar çubuğundaki dar görünümün alternatifi: aynı paneli büyük, editör alanında bir
    // sekme olarak açar (chainforge.openFullView komutu). Aynı örneği (this) kullandığı için
    // config/isPro/customInstructions gibi durum hep senkron kalır — sadece FİZİKSEL webview
    // hedefi değişir. NOT: aynı anda hem kenar çubuğu hem tam sekme açıksa, sadece EN SON
    // odaklanan canlı güncelleme alır (basitlik için kabul edilen bir sınırlama).
    attachWebviewPanel(panel) {
        this.view = panel;
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        this.update();
        panel.onDidDispose(() => {
            this.view = undefined;
            while (this.disposables.length) {
                const d = this.disposables.pop();
                if (d)
                    d.dispose();
            }
        }, null, this.disposables);
        panel.webview.onDidReceiveMessage(async (message) => {
            await this.handleMessage(message);
        }, null, this.disposables);
    }
    // Dışarıdan (extension.ts) tetiklenen yenileme — fiyat önbelleği geldiğinde,
    // sohbet temizlendiğinde vb. panelin tamamını (istatistikler dahil) yeniden çizer.
    refreshView() {
        this.update();
    }
    generateNonce() {
        let text = "";
        const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        for (let i = 0; i < 32; i++)
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        return text;
    }
    async handleMessage(message) {
        if (!message || typeof message.command !== "string")
            return;
        switch (message.command) {
            case "runTask": {
                if (typeof message.prompt !== "string" || typeof message.taskType !== "string")
                    return;
                if (message.prompt.length > 50000) {
                    this.view?.webview.postMessage({ command: "result", data: { success: false, error: "Prompt çok uzun" } });
                    return;
                }
                this.view?.webview.postMessage({ command: "loading" });
                const result = await this.onTask(message.prompt, message.taskType);
                this.view?.webview.postMessage({ command: "result", data: result });
                break;
            }
            case "openConfig":
                this.onOpenConfig();
                break;
            case "revertLastChange": {
                vscode.commands.executeCommand("chainforge.revertLastChange", (payload) => {
                    this.view?.webview.postMessage(payload);
                });
                break;
            }
            case "addCustomInstruction": {
                if (typeof message.text !== "string")
                    return;
                const text = message.text.trim().slice(0, 300);
                if (!text)
                    return;
                if (this.customInstructions.length >= 20) {
                    this.view?.webview.postMessage({ command: "customInstructionsError", error: "En fazla 20 talimat ekleyebilirsin." });
                    return;
                }
                this.customInstructions = [...this.customInstructions, text];
                await this.saveCustomInstructions();
                break;
            }
            case "applyPreset": {
                if (typeof message.key !== "string")
                    return;
                const preset = presets_1.PRESETS.find(p => p.key === message.key);
                if (!preset)
                    return;
                if (preset.requiresKey && !this.hasApiKey) {
                    this.view?.webview.postMessage({ command: "presetError", error: "Bu preset OpenRouter API key gerektirir. Önce Ayarlar'dan key ekle." });
                    return;
                }
                const ans = await vscode.window.showWarningMessage(`"${preset.label}" preseti uygulansın mı? Mevcut worker/fallback/supervisor agent'larının üzerine yazılacak.`, { modal: true }, "Evet, Uygula");
                if (ans !== "Evet, Uygula")
                    return;
                this.config = preset.config;
                this.onSaveConfig(this.config);
                this.update();
                break;
            }
            case "removeCustomInstruction": {
                if (typeof message.index !== "number")
                    return;
                this.customInstructions = this.customInstructions.filter((_, i) => i !== message.index);
                await this.saveCustomInstructions();
                break;
            }
            case "agentTask": {
                if (typeof message.prompt !== "string")
                    return;
                vscode.commands.executeCommand("chainforge.agentTask", message.prompt, !!message.applyFiles, (payload) => {
                    this.view?.webview.postMessage(payload);
                }, this.lang);
                break;
            }
            case "saveChatModel": {
                if (typeof message.model !== "string")
                    return;
                this.chatModel = message.model;
                this.saveChatModel(message.model);
                break;
            }
            case "changeLang": {
                if (typeof message.lang !== "string")
                    return;
                const validLangs = ["en", "tr", "de", "fr", "es", "ja", "zh"];
                if (validLangs.includes(message.lang)) {
                    this.lang = message.lang;
                    this.saveLang(message.lang);
                    this.update();
                }
                break;
            }
            case "openUrl": {
                if (typeof message.url !== "string")
                    return;
                const allowed = ["openrouter.ai", "dodopayments.com", "checkout.dodopayments.com", "dodo.pe"];
                try {
                    const u = new URL(message.url);
                    if (allowed.some(d => u.hostname === d || u.hostname.endsWith("." + d))) {
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                    }
                }
                catch { }
                break;
            }
            case "saveKey": {
                if (typeof message.key !== "string")
                    return;
                if (!message.key.startsWith("sk-or-") && !message.key.startsWith("sk-")) {
                    this.view?.webview.postMessage({ command: "keyError", error: "Geçersiz OpenRouter key formatı" });
                    return;
                }
                this.onSaveKey(message.key);
                this.view?.webview.postMessage({ command: "keySaved" });
                break;
            }
            case "saveAgent": {
                if (!message.agent || typeof message.agent !== "object")
                    return;
                const result = this.validateAndApplyAgent(message.agent, message.isEdit);
                if (result && !result.success) {
                    this.view?.webview.postMessage({ command: "agentError", error: result.error });
                    return;
                }
                if (this.config) {
                    const r = this.applyAgent(message.agent, message.isEdit);
                    if (!r.success) {
                        this.view?.webview.postMessage({ command: "agentError", error: r.error });
                        return;
                    }
                    this.onSaveConfig(this.config);
                    this.update();
                    this.view?.webview.postMessage({ command: "agentSaved" });
                }
                break;
            }
            case "deleteAgent": {
                if (typeof message.key !== "string" || !/^[a-zA-Z0-9_\-]{1,50}$/.test(message.key))
                    return;
                if (this.config?.agents[message.key]) {
                    const dependents = Object.entries(this.config.agents)
                        .filter(([k, a]) => a.fallback === message.key && k !== message.key)
                        .map(([k]) => k);
                    if (dependents.length > 0) {
                        this.view?.webview.postMessage({ command: "agentError", error: `Önce şu agent'ların fallback'ini değiştirin: ${dependents.join(", ")}` });
                        return;
                    }
                    const ans = await vscode.window.showWarningMessage(`"${message.key}" agent'ı silinsin mi?`, { modal: true }, "Sil");
                    if (ans !== "Sil")
                        return;
                    delete this.config.agents[message.key];
                    this.onSaveConfig(this.config);
                    this.update();
                }
                break;
            }
            case "saveTask": {
                if (!message.task || typeof message.task !== "object")
                    return;
                const r = this.applyTask(message.task, message.isEdit);
                if (!r.success) {
                    this.view?.webview.postMessage({ command: "taskError", error: r.error });
                    return;
                }
                this.onSaveConfig(this.config);
                this.update();
                this.view?.webview.postMessage({ command: "taskSaved" });
                break;
            }
            case "deleteTask": {
                if (typeof message.key !== "string" || !/^[a-zA-Z0-9_\-]{1,50}$/.test(message.key))
                    return;
                if (this.config?.tasks[message.key]) {
                    const ans = await vscode.window.showWarningMessage(`"${message.key}" görevi silinsin mi?`, { modal: true }, "Sil");
                    if (ans !== "Sil")
                        return;
                    delete this.config.tasks[message.key];
                    this.onSaveConfig(this.config);
                    this.update();
                }
                break;
            }
            case "saveFile": {
                if (typeof message.content !== "string" || typeof message.filename !== "string")
                    return;
                if (!/^[a-zA-Z0-9_\-\.]{1,100}$/.test(message.filename)) {
                    this.view?.webview.postMessage({ command: "fileError", error: "Geçersiz dosya adı" });
                    return;
                }
                await this.saveFile(message.content, message.filename);
                break;
            }
            case "activateLicense": {
                if (typeof message.key !== "string")
                    return;
                if (!/^[A-Za-z0-9\-_]{10,100}$/.test(message.key.trim())) {
                    this.view?.webview.postMessage({ command: "licenseError", error: "Geçersiz lisans key formatı" });
                    return;
                }
                this.view?.webview.postMessage({ command: "licenseLoading" });
                const result = await this.onActivateLicense(message.key.trim());
                if (result.success) {
                    this.isPro = true;
                    this.update();
                    this.view?.webview.postMessage({ command: "licenseActivated" });
                }
                else {
                    this.view?.webview.postMessage({ command: "licenseError", error: result.error || "Aktivasyon başarısız" });
                }
                break;
            }
            case "deactivateLicense": {
                const answer = await vscode.window.showWarningMessage("Lisansı iptal etmek istediğinizden emin misiniz?\nBu lisans yalnızca 1 cihazda kullanılabilir. İptal ettiğinizde Pro özellikler devre dışı kalır.", { modal: true }, "Evet, İptal Et");
                if (answer === "Evet, İptal Et") {
                    await this.onDeactivateLicense();
                    this.isPro = false;
                    this.licenseKey = "";
                    this.update();
                    this.view?.webview.postMessage({ command: "licenseDeactivated" });
                }
                break;
            }
            case "getFileContext": {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const content = editor.document.getText();
                    const filename = editor.document.fileName.split(/[\\/]/).pop() || "file";
                    this.view?.webview.postMessage({ command: "fileContext", content, filename });
                }
                break;
            }
            case "applyToFile": {
                if (typeof message.content !== "string")
                    return;
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    editor.edit(editBuilder => {
                        if (editor.selection.isEmpty) {
                            editBuilder.insert(editor.selection.active, message.content);
                        }
                        else {
                            editBuilder.replace(editor.selection, message.content);
                        }
                    });
                }
                break;
            }
            case "clearStats": {
                await this.spendingManager?.clearAll();
                this.update();
                break;
            }
            case "setTelemetry": {
                this.telemetryConsent = message.enabled ? "granted" : "denied";
                vscode.commands.executeCommand("chainforge.setTelemetry", !!message.enabled);
                break;
            }
            case "runInspection": {
                vscode.commands.executeCommand("chainforge.inspectFromPanel", (payload) => {
                    this.view?.webview.postMessage(payload);
                });
                break;
            }
            case "fixErrors": {
                vscode.commands.executeCommand("chainforge.fixErrors", (payload) => {
                    this.view?.webview.postMessage(payload);
                });
                break;
            }
            case "chat": {
                if (!Array.isArray(message.history))
                    return;
                const modelId = typeof message.modelId === "string" ? message.modelId : "__auto_free__";
                vscode.commands.executeCommand("chainforge.chat", message.history, (payload) => {
                    this.view?.webview.postMessage(payload);
                }, modelId, this.lang);
                break;
            }
            case "cancelChat": {
                vscode.commands.executeCommand("chainforge.cancelChat");
                break;
            }
            case "cancelAgentTask": {
                vscode.commands.executeCommand("chainforge.cancelAgentTask");
                break;
            }
            case "saveChat": {
                if (Array.isArray(message.history)) {
                    await vscode.commands.executeCommand("chainforge.saveChat", message.history);
                }
                break;
            }
            case "clearChat": {
                const scope = message.scope === "all" ? "all" : "current";
                await vscode.commands.executeCommand("chainforge.clearChat", scope);
                break;
            }
        }
    }
    validateAndApplyAgent(data, isEdit) {
        if (!data.key || !/^[a-zA-Z0-9_\-]{1,50}$/.test(data.key))
            return { success: false, error: "Key geçersiz" };
        if (!data.name || data.name.length > 100)
            return { success: false, error: "İsim geçersiz" };
        // provider/ kısmı opsiyonel — kendi API key ile native model adları (deepseek-v4-pro) da geçerli
        if (!data.model || !/^[a-zA-Z0-9_\-]+(\/[a-zA-Z0-9_\-\.]+)?(:[a-zA-Z0-9\-]+)?$/.test(data.model))
            return { success: false, error: "Model formatı geçersiz (örn: deepseek/deepseek-chat veya deepseek-chat)" };
        if (!["coding", "math", "routing", "long-coding", "fallback", "supervisor", "custom"].includes(data.role))
            return { success: false, error: "Geçersiz rol" };
        if (data.systemPrompt && data.systemPrompt.length > 2000)
            return { success: false, error: "Sistem promptu max 2000 karakter" };
        if (data.systemPrompt && /<script|javascript:|eval\(/i.test(data.systemPrompt))
            return { success: false, error: "Sistem promptunda geçersiz içerik" };
        if (data.fallback && data.fallback === data.key)
            return { success: false, error: "Agent kendine fallback olamaz" };
        // Fallback HALKASI kontrolü: A→B→A gibi döngü oluşmasını engelle
        if (data.fallback && this.config?.agents) {
            const visited = new Set([data.key]);
            let cur = data.fallback;
            while (cur) {
                if (visited.has(cur)) {
                    return { success: false, error: `Fallback halkası! "${cur}" zincirde tekrar ediyor. Fallback bir zincir olmalı, halka değil (örn: A→B→C, A→B→A DEĞİL).` };
                }
                visited.add(cur);
                cur = this.config.agents[cur]?.fallback;
            }
        }
        if (data.apiKey && data.apiKey.length > 200)
            return { success: false, error: "API key max 200 karakter" };
        if (data.apiEndpoint && data.apiEndpoint.length > 300)
            return { success: false, error: "API endpoint max 300 karakter" };
        if (data.apiEndpoint && !/^https?:\/\/.+/.test(data.apiEndpoint))
            return { success: false, error: "API endpoint geçersiz URL" };
        return { success: true };
    }
    applyAgent(data, isEdit) {
        const v = this.validateAndApplyAgent(data, isEdit);
        if (!v.success)
            return v;
        if (!this.config)
            return { success: false, error: "Config yüklenemedi" };
        if (!isEdit && this.config.agents[data.key])
            return { success: false, error: `'${data.key}' zaten mevcut` };
        const freeLimit = 3;
        if (!isEdit && !this.isPro && Object.keys(this.config.agents).length >= freeLimit) {
            return { success: false, error: "Ücretsiz sürümde max 3 agent. Pro'ya geçin." };
        }
        this.config.agents[data.key] = {
            name: data.name.trim(),
            model: data.model.trim().toLowerCase(),
            role: data.role,
            fallback: data.fallback || undefined,
            maxRetries: Math.min(Math.max(parseInt(data.maxRetries) || 2, 1), 5),
            systemPrompt: data.systemPrompt?.trim() || undefined,
            apiKey: data.apiKey?.trim() || undefined,
            apiEndpoint: data.apiEndpoint?.trim() || undefined,
        };
        return { success: true };
    }
    applyTask(data, isEdit) {
        if (!data.key || !/^[a-zA-Z0-9_\-]{1,50}$/.test(data.key))
            return { success: false, error: "Key geçersiz" };
        if (!data.description || data.description.length > 200)
            return { success: false, error: "Açıklama geçersiz" };
        if (!this.config?.agents[data.primary])
            return { success: false, error: `Agent bulunamadı: ${data.primary}` };
        if (/<|>|script/i.test(data.description))
            return { success: false, error: "Açıklamada geçersiz içerik" };
        if (!isEdit && this.config.tasks[data.key])
            return { success: false, error: `'${data.key}' zaten mevcut` };
        this.config.tasks[data.key] = {
            primary: data.primary,
            description: data.description.trim(),
        };
        return { success: true };
    }
    async saveFile(content, filename) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(filename) });
            if (!uri)
                return;
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
            vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
            return;
        }
        const filePath = vscode.Uri.joinPath(workspaceFolders[0].uri, filename);
        await vscode.workspace.fs.writeFile(filePath, Buffer.from(content, "utf8"));
        const doc = await vscode.workspace.openTextDocument(filePath);
        vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        vscode.window.showInformationMessage(`AI Chain: ${filename} oluşturuldu.`);
    }
    updateConfig(config) {
        this.config = config;
        this.update();
    }
    update() {
        this.nonce = this.generateNonce();
        if (this.view)
            this.view.webview.html = this.getHtml();
    }
    escapeHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#x27;");
    }
    // Geçmişte bu projede uygulanan agent görevlerinin listesi (en yeni üstte)
    renderOpHistory() {
        if (this.opHistory.length === 0) {
            return `<p class="empty" style="margin:4px 0;font-size:11px">Bu projede henüz uygulanmış bir agent görevi yok.</p>`;
        }
        const items = [...this.opHistory].reverse().slice(0, 20).map(op => {
            const date = new Date(op.ts);
            const when = isNaN(date.getTime()) ? op.ts : date.toLocaleString("tr-TR");
            const fileCount = op.files?.length || 0;
            const costPart = typeof op.costUsd === "number" ? ` · $${op.costUsd.toFixed(4)}` : "";
            return `
        <div style="padding:6px 0;border-bottom:1px solid var(--vscode-panel-border);font-size:11px">
          <div style="font-weight:500">${this.escapeHtml(op.summary || op.prompt || "(özet yok)")}</div>
          <div style="color:var(--vscode-descriptionForeground);margin-top:2px">
            ${this.escapeHtml(when)} · ${this.escapeHtml(op.model || "?")} · ${fileCount} dosya${costPart}
          </div>
        </div>`;
        }).join("");
        return `<div style="max-height:260px;overflow-y:auto">${items}</div>`;
    }
    // Özel talimatlar listesini (ayarlar > Pro > modal) render eder
    renderCustomInstructionsList() {
        if (this.customInstructions.length === 0) {
            return `<p class="empty" style="margin:4px 0">Henüz talimat eklemedin.</p>`;
        }
        return this.customInstructions.map((text, i) => `
      <div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--vscode-panel-border);font-size:12px">
        <div style="flex:1;word-break:break-word">${this.escapeHtml(text)}</div>
        <span data-ci-remove="${i}" title="Kaldır" style="cursor:pointer;color:var(--vscode-descriptionForeground);flex-shrink:0">✕</span>
      </div>`).join("");
    }
    // Diziyi kalıcı ayara yaz + webview'daki listeyi (tam sayfa reload olmadan) güncelle
    async saveCustomInstructions() {
        await vscode.workspace.getConfiguration("chainforge").update("customInstructions", this.customInstructions, vscode.ConfigurationTarget.Global);
        this.view?.webview.postMessage({ command: "customInstructionsList", data: this.renderCustomInstructionsList() });
    }
    // Sohbet model seçici için option'lar: ücretsiz modeller + kullanıcının agent'ları
    getModelOptions() {
        const sel = (value) => value === this.chatModel ? " selected" : "";
        let html = `<optgroup label="Ücretsiz (key gerekmez)">`;
        html += `<option value="__auto_free__"${sel("__auto_free__")}>⚡ Otomatik (ücretsiz)</option>`;
        const effectiveFreeModels = (0, freeModels_2.filterAliveModels)(freeModels_1.FREE_MODELS, this.getLiveFreeModelIds());
        for (const m of effectiveFreeModels) {
            const mark = m.tier === "limited" ? " · sınırlı" : "";
            html += `<option value="${this.escapeHtml(m.id)}"${sel(m.id)}>${this.escapeHtml(m.label)}${mark} — ${this.escapeHtml(m.goodFor)}</option>`;
        }
        html += `</optgroup>`;
        if (this.config?.agents && Object.keys(this.config.agents).length > 0) {
            html += `<optgroup label="Kendi Agent'larım (API key gerekir)">`;
            const keys = Object.keys(this.config.agents);
            keys.forEach((key, i) => {
                const a = this.config.agents[key];
                const disabled = !this.isPro && i >= 3; // free: ilk 3 dışı devre dışı
                const label = `${this.escapeHtml(a.name || key)} (${this.escapeHtml(a.model)})`;
                html += `<option value="agent:${this.escapeHtml(key)}"${sel("agent:" + key)} ${disabled ? "disabled" : ""}>${label}${disabled ? " 🔒 Pro" : ""}</option>`;
            });
            html += `</optgroup>`;
        }
        return html;
    }
    // Profesyonel inline SVG ikonlar (Lucide tarzı, currentColor stroke)
    icon(name) {
        const p = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">';
        const paths = {
            send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
            search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
            file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
            trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
            chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
            agents: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 16h.01M16 16h.01"/>',
            tasks: '<path d="M11 12H3M16 6H3M16 18H3M18 9l3 3-3 3"/>',
            chart: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
            settings: '<circle cx="12" cy="12" r="3"/><path d="M12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
            wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.7-.6-.6-2.7Z"/>',
            sparkle: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>',
            shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
        };
        return p + (paths[name] || "") + "</svg>";
    }
    getAgentCards(t) {
        if (!this.config?.agents || Object.keys(this.config.agents).length === 0) {
            return `<p class='empty'>${t('agentsEmpty')}</p>`;
        }
        const roleColors = {
            routing: "#f59e0b", math: "#10b981", coding: "#3b82f6",
            "long-coding": "#ec4899", fallback: "#6b7280", supervisor: "#ef4444", custom: "#8b5cf6",
        };
        const entries = Object.entries(this.config.agents);
        const cards = entries.map(([key, agent], i) => {
            const disabled = !this.isPro && i >= 3; // free: ilk 3 dışı devre dışı
            const color = roleColors[agent.role] || "#6b7280";
            const safeKey = this.escapeHtml(key);
            const safeName = this.escapeHtml(agent.name || key);
            const safeModel = this.escapeHtml(agent.model);
            const safeRole = this.escapeHtml(agent.role);
            const safeFallback = agent.fallback ? this.escapeHtml(agent.fallback) : "";
            return `
        <div class="card${disabled ? " card-disabled" : ""}" data-key="${safeKey}">
          <div class="card-top">
            <div style="flex:1;min-width:0">
              <div class="card-name">${safeName}${disabled ? ' <span class="pro-lock">🔒 Pro</span>' : ""}</div>
              <div class="card-model">${safeModel}</div>
            </div>
            <span class="badge" style="background:${color}20;color:${color}">${safeRole}</span>
          </div>
          ${safeFallback ? `<div class="card-fallback">→ ${safeFallback}</div>` : ""}
          ${disabled ? `<div class="card-fallback" style="color:#f59e0b">Devre dışı — Pro gerekli</div>` : ""}
          <div class="card-actions">
            <button class="btn-sm edit-agent-btn" data-key="${safeKey}">${t('editBtn')}</button>
            <button class="btn-sm btn-danger delete-agent-btn" data-key="${safeKey}">${t('deleteBtn')}</button>
          </div>
        </div>`;
        }).join("");
        // Free planda fazla agent uyarısı
        const disabledCount = !this.isPro ? Math.max(0, entries.length - 3) : 0;
        const warn = disabledCount > 0
            ? `<div class="warn-box">⚠ ${disabledCount} agent ücretsiz planda devre dışı. İlk 3 agent çalışır; gerisi Pro'ya geçince aktifleşir (silinmez).</div>`
            : "";
        return warn + cards;
    }
    getTaskCards(t) {
        if (!this.config?.tasks || Object.keys(this.config.tasks).length === 0) {
            return `<p class='empty'>${t('tasksEmpty')}</p>`;
        }
        return Object.entries(this.config.tasks).map(([key, task]) => {
            const agent = this.config.agents[task.primary];
            const safeKey = this.escapeHtml(key);
            const safeDesc = this.escapeHtml(task.description || key);
            const safeAgent = this.escapeHtml(agent?.name || task.primary);
            return `
        <div class="card" data-key="${safeKey}">
          <div class="card-top">
            <div style="flex:1;min-width:0">
              <div class="card-name">${safeDesc}</div>
              <div class="card-model">key: ${safeKey}</div>
            </div>
            <span class="badge" style="background:#3b82f620;color:#3b82f6">${safeAgent}</span>
          </div>
          <div class="card-actions">
            <button class="btn-sm edit-task-btn" data-key="${safeKey}">${t('editBtn')}</button>
            <button class="btn-sm btn-danger delete-task-btn" data-key="${safeKey}">${t('deleteBtn')}</button>
          </div>
        </div>`;
        }).join("");
    }
    getAgentOptions(selected) {
        if (!this.config?.agents)
            return "";
        return Object.entries(this.config.agents).map(([key, a]) => `<option value="${this.escapeHtml(key)}" ${selected === key ? "selected" : ""}>${this.escapeHtml(a.name || key)}</option>`).join("");
    }
    getTaskOptions() {
        if (!this.config?.tasks)
            return "";
        return Object.entries(this.config.tasks).map(([key, task]) => `<option value="${this.escapeHtml(key)}">${this.escapeHtml(task.description || key)}</option>`).join("");
    }
    getHtml() {
        const agentsJson = Buffer.from(JSON.stringify(this.config?.agents || {})).toString('base64');
        const tasksJson = Buffer.from(JSON.stringify(this.config?.tasks || {})).toString('base64');
        const chatJson = Buffer.from(JSON.stringify(this.chatProvider() || [])).toString('base64');
        const freeLimit = 3;
        const agentCount = Object.keys(this.config?.agents || {}).length;
        const atLimit = !this.isPro && agentCount >= freeLimit;
        const n = this.nonce;
        const lang = (this.lang || "en");
        const t = (key) => i18n_1.translations[lang]?.[key] || i18n_1.translations["en"]?.[key] || key;
        const langOptions = Object.entries(i18n_1.languageNames).map(([code, name]) => `<option value="${code}" ${code === lang ? "selected" : ""}>${name}</option>`).join("");
        // Harcama istatistikleri
        const stats = this.spendingManager?.getMonthlyStats() || { byModel: {}, totalCost: 0, totalTokens: 0, totalRequests: 0, month: "" };
        const statsJson = JSON.stringify(stats);
        // Script içinde kullanılacak çevirileri JSON olarak inject et
        const i18nJson = JSON.stringify({
            noResult: t('noResult'),
            running: t('running'),
            keyEmpty: t('keyEmpty') || "Key boş olamaz",
            deactivateConfirm: t('deactivateConfirm'),
            agentDeleteConfirm: t('agentDeleteConfirm') || "agent silinsin mi?",
            taskDeleteConfirm: t('taskDeleteConfirm') || "görevi silinsin mi?",
            agentFieldsRequired: t('agentFieldsRequired') || "Key, isim ve model zorunludur",
            taskFieldsRequired: t('taskFieldsRequired') || "Tüm alanlar zorunludur",
            filenameEmpty: t('filenameEmpty') || "Dosya adı boş olamaz",
            filenameInvalid: t('filenameInvalid') || "Geçersiz dosya adı",
            keySaved: t('keySaved'),
            unknownError: t('unknownError') || "Bilinmeyen hata",
            statsClear: t('statsClear') || "Clear Statistics",
            statsEmpty: t('statsEmpty') || "No usage yet.",
            statsTitle: t('statsTitle') || "Usage",
            chatCancelled: t('chatCancelled') || "Cancelled",
        });
        return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Chain</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:var(--vscode-font-family);background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-size:13px;display:flex;flex-direction:column;overflow:hidden}
/* Sohbet tabı tam yükseklik: scroll üstte, giriş çubuğu altta sabit */
#content-run.active{display:flex;flex-direction:column;flex:1;min-height:0;padding:0}
.run-scroll{flex:1;min-height:0;overflow-y:auto;padding:14px 16px}
.input-bar{border-top:1px solid var(--vscode-panel-border);padding:10px 14px;background:var(--vscode-editor-background)}
.input-bar textarea{min-height:48px;max-height:160px}
.model-bar{display:flex;align-items:center;gap:8px;margin-bottom:7px}
.model-bar select{flex:0 1 auto;max-width:60%;font-size:11px;padding:4px 8px;border-radius:6px}
.live-status{flex:1;font-size:11px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.live-dot{width:7px;height:7px;border-radius:50%;background:#7fb37f;flex-shrink:0}
.live-dot.busy{background:#d9a05b;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.input-row{display:flex;align-items:center;gap:6px;margin-top:8px}
.btn-icon{background:transparent;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);padding:6px 8px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center}
.btn-icon:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-editor-foreground)}
.btn-send{background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:7px 12px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center}
.btn-send.btn-cancel{background:#ef444433;color:#ef4444}
.btn-send.btn-cancel:hover{background:#ef444455}
.btn-soft-amber{background:#d9a05b22;color:#c88a4a;border:1px solid #d9a05b44;border-radius:7px;display:inline-flex;align-items:center;gap:5px}
.btn-soft-amber:hover{background:#d9a05b33}
.soft-check{display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;color:var(--vscode-descriptionForeground)}
.settings-group{margin-bottom:8px;border:1px solid var(--vscode-panel-border);border-radius:8px;overflow:hidden}
.settings-group>summary{padding:10px 12px;cursor:pointer;font-size:12px;font-weight:500;list-style:none;display:flex;align-items:center;gap:7px;user-select:none}
.settings-group>summary::-webkit-details-marker{display:none}
.settings-group>summary:hover{background:var(--vscode-toolbar-hoverBackground)}
.settings-group[open]>summary{border-bottom:1px solid var(--vscode-panel-border)}
.settings-group>div{padding:10px 12px}
/* İkonlar: soft, tek renk */
svg{opacity:.7;color:var(--vscode-descriptionForeground)}
button svg{opacity:.85;color:currentColor}
.tab svg{width:13px;height:13px}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--vscode-panel-border);position:sticky;top:0;background:var(--vscode-editor-background);z-index:10}
.topbar-title{font-size:15px;font-weight:600}
.topbar-sub{font-size:10px;color:var(--vscode-descriptionForeground)}
.tabs{display:flex;border-bottom:1px solid var(--vscode-panel-border);padding:0 16px;background:var(--vscode-editor-background);position:sticky;top:42px;z-index:9}
.tab{padding:8px 12px;font-size:12px;cursor:pointer;border:none;border-bottom:2px solid transparent;color:var(--vscode-descriptionForeground);background:none;font-family:inherit}
.tab.active{color:var(--vscode-editor-foreground);border-bottom-color:var(--vscode-focusBorder)}
.tab svg{opacity:.85}
button svg{flex-shrink:0}
.btn-row button{display:inline-flex;align-items:center;gap:5px;justify-content:center}
.tab-content{display:none;padding:16px}
.tab-content.active{display:block}
input,select,textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:6px 10px;font-size:13px;font-family:inherit;width:100%;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--vscode-focusBorder)}
textarea{resize:vertical;min-height:70px}
label{font-size:11px;color:var(--vscode-descriptionForeground);display:block;margin-bottom:3px;margin-top:10px}
label:first-of-type{margin-top:0}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:7px;padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit;transition:background .12s}
button:hover{background:var(--vscode-button-hoverBackground)}
button:disabled{opacity:.5;cursor:not-allowed}
.btn-sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-sec:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
.btn-sm{padding:3px 10px;font-size:11px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-sm:hover{background:var(--vscode-button-secondaryHoverBackground)}
.btn-danger{background:#ef444420 !important;color:#ef4444 !important}
.btn-danger:hover{background:#ef444440 !important}
.btn-row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;margin-bottom:12px}
.card{background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px}
.card-disabled{opacity:.55;border-style:dashed}
.pro-lock{font-size:9px;background:#f59e0b22;color:#f59e0b;padding:1px 5px;border-radius:4px;font-weight:600;white-space:nowrap}
.card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px}
.card-name{font-weight:500;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-model{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-fallback{font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:6px}
.card-actions{display:flex;gap:6px}
.badge{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:500;white-space:nowrap;flex-shrink:0}
.sec-label{font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
.modal-overlay{display:none;position:fixed;inset:0;background:#00000088;z-index:100;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:20px;width:340px;max-height:85vh;overflow-y:auto}
.modal-title{font-size:14px;font-weight:600;margin-bottom:14px}
.result-box{background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px;min-height:80px;font-family:var(--vscode-editor-font-family);font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow-y:auto;line-height:1.5}
.chat-area{display:flex;flex-direction:column;gap:8px;padding:4px}
.chat-msg{padding:8px 11px;border-radius:10px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-width:92%}
.chat-user{align-self:flex-end;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-bottom-right-radius:3px}
.chat-ai{align-self:flex-start;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-bottom-left-radius:3px}
.chat-err{align-self:flex-start;background:#ef444415;border:1px solid #ef444440;color:#ef4444;border-radius:10px}
.chat-info{align-self:center;font-size:10.5px;color:var(--vscode-descriptionForeground);background:var(--vscode-textBlockQuote-background);border-radius:6px;padding:4px 10px;max-width:95%}
.chat-empty{color:var(--vscode-descriptionForeground);font-size:12px;text-align:center;padding:30px 10px;line-height:1.6}
.chat-typing{align-self:flex-start;color:var(--vscode-descriptionForeground);font-style:italic;font-size:12px;padding:6px 10px}
.meta-row{display:flex;gap:10px;font-size:11px;color:var(--vscode-descriptionForeground);margin-top:6px;flex-wrap:wrap}
.loading{color:var(--vscode-descriptionForeground);font-style:italic}
.err-msg{color:#ef4444;font-size:11px;margin-top:4px;display:none}
.ok-msg{color:#10b981;font-size:11px;margin-top:4px;display:none}
.warn-box{background:var(--vscode-inputValidation-warningBackground);border:1px solid var(--vscode-inputValidation-warningBorder);border-radius:4px;padding:8px 12px;font-size:12px;margin-bottom:12px}
.pro-box{background:#f59e0b15;border:1px solid #f59e0b40;border-radius:6px;padding:12px;margin-bottom:12px}
.pro-badge{background:#f59e0b20;color:#f59e0b;font-size:10px;padding:2px 7px;border-radius:4px}
.active-badge{background:#10b98120;color:#10b981;font-size:11px;padding:3px 8px;border-radius:4px}
.divider{border:none;border-top:1px solid var(--vscode-panel-border);margin:14px 0}
.empty{color:var(--vscode-descriptionForeground);font-size:12px;padding:4px 0}
.limit-note{font-size:11px;color:#f59e0b;margin:6px 0 10px}
.key-row{display:flex;gap:8px}
a{color:var(--vscode-textLink-foreground)}
</style>
</head>
<body>

<div class="topbar">
  <div>
    <div class="topbar-title">⛓ ChainForge</div>
    <div class="topbar-sub">${t('appSub')}</div>
  </div>
  <div style="display:flex;gap:6px;align-items:center">
    <select id="langSelect" style="padding:3px 6px;font-size:11px;width:auto">
      ${langOptions}
    </select>
    ${this.isPro
            ? `<span class="active-badge" title="Desteğin için teşekkürler!">${t('proActive')}</span>`
            : `<button id="btnShowPro" class="btn-sec" style="font-size:11px">${t('upgradeBtn')}</button>`}
  </div>
</div>

<div class="tabs">
  <button class="tab active" id="tab-run">${this.icon('chat')} ${t('tabRunPlain') || 'Sohbet'}</button>
  <button class="tab" id="tab-agents">${this.icon('agents')} ${t('tabAgentsPlain') || 'Agentlar'}</button>
  <button class="tab" id="tab-tasks">${this.icon('tasks')} ${t('tabTasksPlain') || 'Görevler'}</button>
  <button class="tab" id="tab-stats">${this.icon('chart')} ${t('tabStats') || 'Kullanım'}</button>
  <button class="tab" id="tab-settings">${this.icon('settings')} ${t('tabSettingsPlain') || 'Ayarlar'}</button>
</div>

<!-- RUN TAB (Sohbet) -->
<div class="tab-content active" id="content-run">
  <!-- Kaydırılabilir içerik: sohbet + sonuçlar -->
  <div class="run-scroll" id="runScroll">
    <div class="chat-area" id="chatArea"></div>

    <!-- Görev modu sonucu (dosya içerikleri) -->
    <div class="result-box" id="result" style="${this.lastTaskSteps.length > 0 ? "display:block" : "display:none"}">${this.lastTaskSteps.length > 0
            ? `📋 Son görev adımları (kaydedilmiş):\n\n${this.escapeHtml(this.lastTaskSteps.join("\n"))}`
            : t('noResult')}</div>
    <div class="meta-row" id="meta" style="display:none">
      <span>${t('modelLabel')} <span id="metaModel"></span></span>
      <span id="metaTokens" style="display:none"><span id="metaTokenCount"></span> token</span>
      <span id="metaCost" style="display:none">$<span id="metaCostVal"></span></span>
      <span id="metaAgent" style="display:none"></span>
      <span id="metaAttempts" style="display:none"></span>
    </div>
    <div class="btn-row" id="saveRow" style="display:none">
      <button id="btnShowSave" class="btn-sec">${t('saveFile')}</button>
      <button id="btnApplyFile" class="btn-sec" title="Editördeki dosyaya uygula">${this.icon('file')} Dosyaya Uygula</button>
    </div>
    <div class="btn-row" id="revertRow" style="display:none">
      <button id="btnRevertLast" class="btn-sec" title="Son uygulanan değişikliği geri al">↩ Son Değişikliği Geri Al</button>
    </div>

    <!-- Denetim sonuçları -->
    <div id="inspectSection" style="display:none;margin-top:8px">
      <div class="sec-label">${this.icon('search')} Denetim <span id="inspectSummary" style="font-weight:400;font-size:11px"></span></div>
      <label class="soft-check">
        <input type="checkbox" id="autoFix" checked style="width:auto;margin:0" />
        Hata bulununca otomatik düzelt
      </label>
      <div class="result-box" id="inspectResult" style="max-height:340px"></div>
      <div class="btn-row" id="inspectActions" style="display:none">
        <button id="btnFixErrors" class="btn-soft-amber">${this.icon('wrench')} Hataları Düzelt</button>
      </div>
    </div>
  </div>

  <!-- Sabit alt giriş çubuğu -->
  <div class="input-bar">
    <div class="model-bar">
      <select id="modelSelect" title="Hangi yapay zeka çalışsın?">${this.getModelOptions()}</select>
      <span id="liveStatus" class="live-status"></span>
    </div>
    <textarea id="prompt" placeholder="Bir şey sor, ya da yapılacak işi yaz…"></textarea>
    <div class="input-row">
      <label class="soft-check" style="flex:1">
        <input type="checkbox" id="applyFiles" style="width:auto;margin:0" />
        Dosyalara uygula
      </label>
      <button id="btnFileCtx" class="btn-icon" title="Aktif dosyayı ekle">${this.icon('file')}</button>
      <button id="btnInspect" class="btn-icon" title="Workspace'i tara">${this.icon('search')}</button>
      <button id="btnClear" class="btn-icon" title="Sohbeti temizle">${this.icon('trash')}</button>
      <button id="btnRun" class="btn-send">${this.icon('send')}</button>
    </div>
  </div>
</div>

<!-- AGENTS TAB -->
<div class="tab-content" id="content-agents">
  <details class="settings-group" style="margin-bottom:12px">
    <summary>${this.icon('agents')} Agent nedir? Alanlar ne işe yarar?</summary>
    <div style="padding:10px 12px;font-size:11.5px;line-height:1.7;color:var(--vscode-foreground)">
      <p style="margin-bottom:8px"><b>Agent</b>, belirli bir yapay zeka modelini belirli bir görev için ayarladığın "uzman"dır. Her agent bir modeli + bir rolü + bir kişiliği (sistem promptu) temsil eder.</p>
      <div style="display:grid;gap:6px;margin-bottom:10px">
        <div><b>Anahtar (ID):</b> Agent'ın benzersiz kimliği. Görevler ve yedekler bu ID ile referans verir. <i>(ör: worker)</i></div>
        <div><b>İsim:</b> Arayüzde görünen ad. <i>(ör: Kod Yazarı)</i></div>
        <div><b>Model:</b> Hangi AI çalışsın. <i>(ör: qwen/qwen3-coder:free)</i></div>
        <div><b>Rol:</b> Agent'ın işlevi — sistemin onu nerede kullanacağını belirler (aşağıda).</div>
        <div><b>Yedek (Fallback):</b> Bu agent başarısız olursa hangi agent devralsın. Halka kurma (A→B→A) — zincir olmalı.</div>
        <div><b>Max Deneme:</b> Geçici hatada kaç kez tekrar denesin (1–5).</div>
        <div><b>Sistem Promptu:</b> Agent'a kimlik ve talimat veren metin. "Sen kıdemli bir geliştiricisin…" gibi. Davranışı buradan şekillenir.</div>
      </div>
      <p style="margin-bottom:6px"><b>Roller ve sistemin onları kullandığı yer:</b></p>
      <div style="display:grid;gap:5px">
        <div><span class="badge" style="background:#3b82f620;color:#3b82f6">coding</span> Asıl kodu yazar. "Dosyalara uygula" görevlerinde devreye girer.</div>
        <div><span class="badge" style="background:#f59e0b20;color:#f59e0b">routing</span> Koordinatör. Planlar: hangi dosyalar değişecek, araştırma gerekli mi. (ücretsiz model önerilir)</div>
        <div><span class="badge" style="background:#10b98120;color:#10b981">math</span> Hesaplama/matematik gerektiğinde çağrılır. Yoksa coding üstlenir.</div>
        <div><span class="badge" style="background:#ef444420;color:#ef4444">supervisor</span> Denetmen. <b>Yalnızca</b> "Tara" butonuyla kodu denetler. Kod üretimine karışmaz.</div>
        <div><span class="badge" style="background:#6b728020;color:#6b7280">fallback</span> Yedek. Başka agent çökünce devreye girer.</div>
        <div><span class="badge" style="background:#8b5cf620;color:#8b5cf6">custom</span> Özel amaç. Kendi sistem promptunla istediğin işi tanımlarsın.</div>
      </div>
    </div>
  </details>
  <details class="settings-group" style="margin-bottom:12px">
    <summary>⚡ Hızlı Kurulum</summary>
    <div style="padding:10px 12px">
      <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:8px">
        Bir preset seç — mevcut worker/fallback/supervisor agent'larının <b>üzerine yazılır</b>.
      </p>
      <div class="btn-row" style="flex-wrap:wrap">
        ${presets_1.PRESETS.map(p => `<button class="btn-sec preset-btn" data-preset="${p.key}" title="${this.escapeHtml(p.description)}">${p.label}</button>`).join("")}
      </div>
      <div id="presetErr" class="err-msg"></div>
    </div>
  </details>
  <div class="sec-label">${t('agentsTitle')}</div>
  <div class="cards-grid" id="agentCards">${this.getAgentCards(t)}</div>
  ${atLimit ? `<p class="limit-note">⚠ ${t('limitNote')}</p>` : ""}
  <button id="btnNewAgent" ${atLimit ? "disabled" : ""}>${t('newAgent')}</button>
  <div id="agentErr" class="err-msg"></div>
</div>

<!-- TASKS TAB -->
<div class="tab-content" id="content-tasks">
  <details class="settings-group" style="margin-bottom:12px">
    <summary>${this.icon('tasks')} Görev nedir? Nasıl çalışır?</summary>
    <div style="padding:10px 12px;font-size:11.5px;line-height:1.7;color:var(--vscode-foreground)">
      <p style="margin-bottom:8px"><b>Görev (Task)</b>, bir iş türünü hangi agent'ın yürüteceğini belirler. "Kod yazma → Kod Yazarı agent'ı", "İnceleme → Denetmen agent'ı" gibi eşleştirmeler.</p>
      <div style="display:grid;gap:6px;margin-bottom:10px">
        <div><b>Anahtar (ID):</b> Görevin benzersiz kimliği. <i>(ör: coding)</i></div>
        <div><b>Açıklama:</b> Görevin ne yaptığı. <i>(ör: Kod yazma, düzenleme)</i></div>
        <div><b>Birincil Agent:</b> Bu görevi başlatacak agent. O agent başarısız olursa kendi yedek zincirine geçilir.</div>
      </div>
      <p style="margin-bottom:6px"><b>Arka planda görev akışı (Dosyalara uygula açıkken):</b></p>
      <div style="display:grid;gap:4px;color:var(--vscode-descriptionForeground)">
        <div>1. <b>Koordinatör (routing)</b> projeyi tarar, planı kurar — hangi dosyalar, araştırma/hesap gerekli mi.</div>
        <div>2. Gerekirse <b>araştırma</b> (web) ve <b>math</b> uzmanı bilgi toplar.</div>
        <div>3. Toplanan bilgiyle <b>birincil agent (coding)</b> kodu üretir — geçmiş değişiklikler de bağlama eklenir.</div>
        <div>4. Üretilen kod sana <b>diff onayıyla</b> sunulur, onaylarsan dosyaya yazılır ve loglanır.</div>
        <div>5. <b>Denetmen</b> yalnızca sen "Tara" deyince devreye girer — otomatik değil.</div>
      </div>
    </div>
  </details>
  <div class="sec-label">${t('tasksTitle')}</div>
  <div class="cards-grid" id="taskCards">${this.getTaskCards(t)}</div>
  <button id="btnNewTask">${t('newTask')}</button>
  <div id="taskErr" class="err-msg"></div>
</div>

<!-- STATS TAB -->
<div class="tab-content" id="content-stats">
  <div class="sec-label" id="statsTitle">${new Date().toLocaleString(lang === 'tr' ? 'tr-TR' : lang === 'de' ? 'de-DE' : lang === 'fr' ? 'fr-FR' : lang === 'es' ? 'es-ES' : lang === 'ja' ? 'ja-JP' : lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'long', year: 'numeric' })} ${t('statsTitle') || 'Kullanımı'}</div>
  <div id="statsContent"></div>
  <div class="divider"></div>
  <button id="btnClearStats" class="btn-danger btn-sec" style="font-size:11px">🗑 İstatistikleri Temizle</button>
</div>

<!-- SETTINGS TAB -->
<div class="tab-content" id="content-settings">
  <div class="sec-label">${t('settingsKey')}</div>
  ${this.hasApiKey ? `<div style="font-size:11px;color:#10b981;margin-bottom:6px">✓ API key kayıtlı. Değiştirmek için yeni key girin.</div>` : ""}
  <div class="key-row">
    <input type="password" id="apiKey" placeholder="${this.hasApiKey ? "•••••••• (kayıtlı)" : "sk-or-..."}" autocomplete="off" />
    <button id="btnSaveKey">${t('btnSaveKey')}</button>
  </div>
  <div id="keyErr" class="err-msg"></div>
  <div id="keyOk" class="ok-msg">✓ ${t('keySaved')}</div>
  <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:6px">
    ${t('freeKey')} <a id="linkOpenRouter" href="#">openrouter.ai</a>
  </p>

  ${this.isPro ? `
  <div class="divider"></div>
  <div class="sec-label">${t('proLicenseTitle') || 'Pro License'} <span style="font-weight:400">💙</span></div>
  <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:10px">
    ChainForge Pro'yu desteklediğin için teşekkürler. Bağımsız bir geliştirici olarak bu satışlar sayesinde projeye devam edebiliyorum.
  </div>
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
    <div style="flex:1;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:4px;padding:6px 10px;font-size:12px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
      ${this.licenseKey ? this.licenseKey.slice(0, 4) + "••••••••••••" + this.licenseKey.slice(-4) : "••••••••••••"}
    </div>
    <button id="btnCopyKey" class="btn-sec" style="flex-shrink:0;font-size:11px" data-key="${this.escapeHtml(this.licenseKey)}">📋 Kopyala</button>
  </div>
  <div id="copyOk" class="ok-msg">✓ Kopyalandı</div>
  <button id="btnCustomInstructions" class="btn-sec" style="margin-bottom:8px">✏️ Özel Talimatlarım (Pro)</button>
  <button id="btnDeactivate" class="btn-danger btn-sec">${t('deactivate')}</button>
  ` : ""}

  <!-- ÖZEL TALİMATLAR MODAL (Pro) -->
  <div class="modal-overlay" id="instructionsModal">
    <div class="modal">
      <div class="modal-title">✏️ Özel Talimatlarım</div>
      <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:0">
        Buraya eklediğin her satır, her sohbet ve agent görevine otomatik eklenir (kodlama tarzı, tercih ettiğin kütüphaneler, kurallar vb.).
      </p>
      <div id="ciList" style="max-height:220px;overflow-y:auto;margin-bottom:10px">
        ${this.renderCustomInstructionsList()}
      </div>
      <div class="key-row">
        <input id="ciInput" placeholder="Örn: Her zaman TypeScript kullan" maxlength="300" autocomplete="off" />
        <button id="btnCiAdd">Ekle</button>
      </div>
      <div id="ciErr" class="err-msg"></div>
      <div class="btn-row">
        <button id="btnCiClose" class="btn-sec">Kapat</button>
      </div>
    </div>
  </div>

  <div class="divider"></div>
  <details class="settings-group">
    <summary>${this.icon('shield')} İzinler & Gizlilik</summary>
    <div style="padding:8px 2px 2px">
      <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:8px">
        Anonim hata ve kullanım verileri toolu geliştirmemize yardım eder (VS Code arayüz dili dahil). Kod, prompt, API anahtarı ve IP adresi asla gönderilmez.
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;margin-bottom:6px">
        <input type="checkbox" id="telemetryToggle" ${this.telemetryConsent === "granted" ? "checked" : ""} style="width:auto;margin:0" />
        Anonim veri paylaşımı
      </label>
      <div id="telemetryStatus" style="font-size:11px;color:${this.telemetryConsent === "granted" ? "#7fb37f" : "var(--vscode-descriptionForeground)"}">
        ${this.telemetryConsent === "granted" ? "Etkin" : this.telemetryConsent === "denied" ? "Kapalı" : "Onay bekliyor"}
      </div>
    </div>
  </details>

  <details class="settings-group">
    <summary>${this.icon('chat')} Sohbet Geçmişi</summary>
    <div style="padding:8px 2px 2px">
      <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:8px">
        Sohbetler bu cihazda <b>proje bazlı</b> saklanır. Bu projede ${this.chatSummary.currentCount} mesaj, toplam ${this.chatSummary.projectCount} projede ${this.chatSummary.totalMessages} mesaj.
      </div>
      <div class="btn-row" style="margin-top:0">
        <button id="btnClearProjectChat" class="btn-sec">${this.icon('trash')} Bu Projeyi Temizle</button>
        <button id="btnClearAllChat" class="btn-danger btn-sec">${this.icon('trash')} Tüm Sohbetleri Temizle</button>
      </div>
    </div>
  </details>

  <details class="settings-group">
    <summary>${this.icon('agents')} İşlem Geçmişi <span style="font-weight:400;font-size:11px">(${this.opHistory.length})</span></summary>
    <div style="padding:8px 2px 2px">
      ${this.renderOpHistory()}
    </div>
  </details>

  <details class="settings-group">
    <summary>${this.icon('settings')} ${t('advanced')}</summary>
    <div style="padding:8px 2px 2px">
      <button id="btnOpenConfig" class="btn-sec">${t('editConfig')}</button>
    </div>
  </details>
</div>

<!-- AGENT MODAL -->
<div class="modal-overlay" id="agentModal">
  <div class="modal">
    <div class="modal-title" id="agentModalTitle">${t('agentNew')}</div>
    <label>${t('agentKey')}</label>
    <input id="agentKey" placeholder="${t('agentKeyPlaceholder')}" maxlength="50" autocomplete="off" />
    <label>${t('agentName')}</label>
    <input id="agentName" placeholder="${t('agentNamePlaceholder')}" maxlength="100" />
    <label>${t('agentModel')} <span style="font-size:10px;color:var(--vscode-descriptionForeground)">(provider/model-name)</span></label>
    <input id="agentModel" placeholder="${t('agentModelPlaceholder')}" maxlength="100" autocomplete="off" />
    <p style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px">
      ${t('models')} <a id="linkModels" href="#">openrouter.ai/models</a> &nbsp;|&nbsp;
      Otomatik: <code style="background:var(--vscode-textBlockQuote-background);padding:1px 4px;border-radius:2px">openrouter/auto</code>
    </p>
    <label>${t('agentRole')}</label>
    <select id="agentRole">
      <option value="coding">coding</option>
      <option value="math">math</option>
      <option value="routing">routing</option>
      <option value="long-coding">long-coding</option>
      <option value="fallback">fallback</option>
      <option value="supervisor">supervisor</option>
      <option value="custom">custom</option>
    </select>
    <label>${t('agentFallback')}</label>
    <select id="agentFallback">
      <option value="">${t('noFallback')}</option>
      ${this.getAgentOptions()}
    </select>
    <label>${t('agentRetries')}</label>
    <input id="agentRetries" type="number" value="2" min="1" max="5" />
    <label>${t('agentPrompt')}</label>
    <textarea id="agentSystemPrompt" placeholder="${t('agentPromptPlaceholder')}" maxlength="2000"></textarea>
    ${this.isPro ? `
    <div style="background:#f59e0b10;border:1px solid #f59e0b30;border-radius:4px;padding:8px;margin-top:10px">
      <label style="color:#f59e0b;margin-top:0">🔑 Kendi API Key (Pro)</label>
      <input type="password" id="agentApiKey" placeholder="sk-... (boş bırakılırsa OpenRouter kullanılır)" maxlength="200" autocomplete="off" style="margin-top:4px" />
      <label style="margin-top:6px">API Endpoint (opsiyonel)</label>
      <input id="agentApiEndpoint" placeholder="https://api.openai.com/v1/chat/completions" maxlength="300" autocomplete="off" style="margin-top:4px" />
      <p style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px">Kendi API key'inizi girerseniz, bu agent OpenRouter yerine doğrudan provider'a bağlanır.</p>
    </div>
    ` : ""}
    <div id="agentModalErr" class="err-msg" style="margin-top:8px"></div>
    <div class="btn-row">
      <button id="btnSaveAgent">${t('saveBtn')}</button>
      <button id="btnCancelAgent" class="btn-sec">${t('cancelBtn')}</button>
    </div>
  </div>
</div>

<!-- TASK MODAL -->
<div class="modal-overlay" id="taskModal">
  <div class="modal">
    <div class="modal-title" id="taskModalTitle">${t('taskNew')}</div>
    <label>${t('taskKey')}</label>
    <input id="taskKey" placeholder="${t('taskKeyPlaceholder')}" maxlength="50" autocomplete="off" />
    <label>${t('taskDesc')}</label>
    <input id="taskDescription" placeholder="${t('taskDescPlaceholder')}" maxlength="200" />
    <label>${t('taskPrimary')}</label>
    <select id="taskPrimary">${this.getAgentOptions()}</select>
    <div id="taskModalErr" class="err-msg" style="margin-top:8px"></div>
    <div class="btn-row">
      <button id="btnSaveTask">${t('saveBtn')}</button>
      <button id="btnCancelTask" class="btn-sec">${t('cancelBtn')}</button>
    </div>
  </div>
</div>

<!-- SAVE FILE MODAL -->
<div class="modal-overlay" id="saveModal">
  <div class="modal">
    <div class="modal-title">${t('saveFile')}</div>
    <label>${t('filenameLabel')}</label>
    <input id="saveFilename" placeholder="output.ts" maxlength="100" />
    <div id="saveErr" class="err-msg" style="margin-top:6px"></div>
    <div class="btn-row">
      <button id="btnDoSave">${t('saveBtn')}</button>
      <button id="btnCancelSave" class="btn-sec">${t('cancelBtn')}</button>
    </div>
  </div>
</div>

<!-- PRO MODAL -->
<div class="modal-overlay" id="proModal">
  <div class="modal">
    <div class="modal-title">${t('proTitle')}</div>
    <div class="pro-box">
      <div style="font-size:12px;line-height:1.8">
        ${t('proFeature1')}<br>
        ${t('proFeature2')}<br>
        ${t('proFeature3')}<br>
        ${t('proFeature4')}<br>
        ${t('proFeature5')}<br>
        ${t('proFeature7')}<br>
        ${t('proFeature8')}<br>
        ${t('proFeature6')}
      </div>
    </div>
    <div style="margin-bottom:12px">
      <button id="btnBuyPro" style="width:100%;background:#f59e0b;color:#000;font-weight:600;padding:10px">
        ${t('buyBtn')}
      </button>
    </div>
    <div class="divider"></div>
    <label>${t('licenseKey')}</label>
    <input id="licenseKey" placeholder="${t('licenseKeyPlaceholder')}" maxlength="100" autocomplete="off" />
    <div id="licenseErr" class="err-msg" style="margin-top:6px"></div>
    <div id="licenseLoading" style="display:none;font-size:11px;color:var(--vscode-descriptionForeground);margin-top:6px">⏳ ${t('verifying') || 'Verifying...'}</div>
    <div class="btn-row">
      <button id="btnActivate">${t('activateBtn')}</button>
      <button id="btnCancelPro" class="btn-sec">${t('cancelBtn')}</button>
    </div>
  </div>
</div>

<script>
(function() {
  var vscode = acquireVsCodeApi();
  // base64 → UTF-8 (atob tek başına Latin-1 verir, Türkçe karakterleri bozar)
  function b64utf8(s){ return new TextDecoder().decode(Uint8Array.from(atob(s), function(c){ return c.charCodeAt(0); })); }
  var agents = JSON.parse(b64utf8('${agentsJson}'));
  var tasks = JSON.parse(b64utf8('${tasksJson}'));
  var i18n = ${i18nJson};
  var stats = ${statsJson};
  var lastResult = "";
  var editingAgentKey = null;
  var editingTaskKey = null;

  // Stats tabını doldur
  function renderStats() {
    var el = document.getElementById('statsContent');
    if (!el) return;
    var s = stats;
    var models = Object.keys(s.byModel || {});
    if (models.length === 0) {
      el.innerHTML = '<p class="empty" style="margin-top:8px">Henüz kullanım yok.</p>';
      return;
    }
    var rows = models.sort(function(a,b){ return (s.byModel[b].cost||0)-(s.byModel[a].cost||0); }).map(function(m) {
      var d = s.byModel[m];
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--vscode-panel-border);font-size:11px">'
        + '<div style="flex:1;min-width:0"><div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + m + '</div>'
        + '<div style="color:var(--vscode-descriptionForeground)">' + d.requests + ' istek · ' + (d.tokens||0).toLocaleString() + ' token</div></div>'
        + '<div style="font-weight:600;color:#10b981;margin-left:8px">$' + (d.cost||0).toFixed(4) + '</div></div>';
    }).join('');
    el.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:10px">'
      + '<div><div style="font-size:20px;font-weight:700;color:#10b981">$' + (s.totalCost||0).toFixed(4) + '</div>'
      + '<div style="font-size:11px;color:var(--vscode-descriptionForeground)">Toplam maliyet</div></div>'
      + '<div style="text-align:right"><div style="font-size:16px;font-weight:600">' + (s.totalTokens||0).toLocaleString() + '</div>'
      + '<div style="font-size:11px;color:var(--vscode-descriptionForeground)">' + (s.totalRequests||0) + ' istek</div></div></div>'
      + rows;
  }
  renderStats();

  // ===== SOHBET (hafızalı) =====
  var chatHistory = JSON.parse(b64utf8('${chatJson}'));

  function escapeChat(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function saveChat() {
    vscode.postMessage({ command: 'saveChat', history: chatHistory });
  }
  function renderChat(typing) {
    var area = document.getElementById('chatArea');
    if (!area) return;
    if (chatHistory.length === 0 && !typing) {
      area.innerHTML = '<div class="chat-empty">Merhaba! Bir şey sorabilir veya bir görev verebilirsin.<br>Kod yazdırmak için alttaki kutuya yaz.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < chatHistory.length; i++) {
      var m = chatHistory[i];
      if (m.role === 'info') {
        html += '<div class="chat-info">ℹ ' + escapeChat(m.content) + '</div>';
        continue;
      }
      var cls = m.role === 'user' ? 'chat-user' : (m.error ? 'chat-err' : 'chat-ai');
      html += '<div class="chat-msg ' + cls + '">' + escapeChat(m.content) + '</div>';
    }
    if (typing) html += '<div class="chat-typing" id="chatTyping">yazıyor…</div>';
    area.innerHTML = html;
    var scroll = document.getElementById('runScroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }
  renderChat(false);

  // Dil değiştirme
  document.getElementById('langSelect').addEventListener('change', function(e) {
    vscode.postMessage({ command: 'changeLang', lang: e.target.value });
  });

  // Tab switching + aktif sekme KORUMA (render sonrası sohbete dönmesin)
  function activateTab(name) {
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
    var tb = document.getElementById('tab-' + name);
    var ct = document.getElementById('content-' + name);
    if (tb) tb.classList.add('active');
    if (ct) ct.classList.add('active');
  }
  ['run','agents','tasks','stats','settings'].forEach(function(name) {
    var btn = document.getElementById('tab-' + name);
    if (btn) btn.addEventListener('click', function() {
      activateTab(name);
      // Aktif sekmeyi sakla — bir sonraki render bu sekmede açılsın
      var st = vscode.getState() || {};
      st.activeTab = name;
      vscode.setState(st);
    });
  });
  // Render sonrası: kayıtlı sekmeyi geri yükle
  (function() {
    var st = vscode.getState();
    if (st && st.activeTab && st.activeTab !== 'run') activateTab(st.activeTab);
  })();

  // Run
  // Dosya bağlamı
  var btnFileCtx = document.getElementById('btnFileCtx');
  if (btnFileCtx) btnFileCtx.addEventListener('click', function() {
    vscode.postMessage({ command: 'getFileContext' });
  });

  // Dosyaya uygula
  var btnApplyFile = document.getElementById('btnApplyFile');
  if (btnApplyFile) btnApplyFile.addEventListener('click', function() {
    if (lastResult) vscode.postMessage({ command: 'applyToFile', content: lastResult });
  });

  // Son değişikliği geri al
  var btnRevertLast = document.getElementById('btnRevertLast');
  if (btnRevertLast) btnRevertLast.addEventListener('click', function() {
    btnRevertLast.disabled = true;
    vscode.postMessage({ command: 'revertLastChange' });
  });

  // Stats temizle
  var btnClearStats = document.getElementById('btnClearStats');
  if (btnClearStats) btnClearStats.addEventListener('click', function() {
    if (confirm('Bu ayki tüm kullanım istatistikleri silinsin mi?')) {
      vscode.postMessage({ command: 'clearStats' });
    }
  });

  var busyMode = ''; // 'chat' | 'agent' — iptal butonunun doğru komutu göndermesi için
  var modelSelectEl = document.getElementById('modelSelect');
  if (modelSelectEl) modelSelectEl.addEventListener('change', function() {
    vscode.postMessage({ command: 'saveChatModel', model: modelSelectEl.value });
  });

  var btnRun = document.getElementById('btnRun');
  if (btnRun) btnRun.addEventListener('click', function() {
    if (isBusy) { vscode.postMessage({ command: busyMode === 'agent' ? 'cancelAgentTask' : 'cancelChat' }); }
    else { runTask(); }
  });

  // Dosyaları Tara / Denetle butonu
  var btnInspect = document.getElementById('btnInspect');
  if (btnInspect) btnInspect.addEventListener('click', function() {
    document.getElementById('inspectSection').style.display = 'block';
    document.getElementById('inspectResult').innerHTML = '<span class="loading">⏳ Dosyalar taranıyor, AI analiz ediyor...</span>';
    document.getElementById('inspectSummary').textContent = '';
    document.getElementById('inspectActions').style.display = 'none';
    btnInspect.disabled = true;
    vscode.postMessage({ command: 'runInspection' });
  });

  // Hataları Düzelt butonu — Postacı'ya ilet
  var btnFixErrors = document.getElementById('btnFixErrors');
  if (btnFixErrors) btnFixErrors.addEventListener('click', function() {
    btnFixErrors.disabled = true;
    btnFixErrors.textContent = 'Düzeltiliyor…';
    vscode.postMessage({ command: 'fixErrors' });
  });

  var btnClear = document.getElementById('btnClear');
  if (btnClear) btnClear.addEventListener('click', function() {
    if (chatHistory.length === 0) return;
    if (!confirm('Sohbet geçmişi silinsin mi?')) return;
    chatHistory = [];
    renderChat(false);
    vscode.postMessage({ command: 'clearChat', scope: 'current' });
    document.getElementById('result').style.display = 'none';
    document.getElementById('meta').style.display = 'none';
    document.getElementById('saveRow').style.display = 'none';
    lastResult = '';
  });

  var promptEl = document.getElementById('prompt');
  if (promptEl) promptEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runTask(); }
  });

  // Canlı model/token göstergesi
  var lastUserMsg = ''; // iptal edilince geri yazmak için
  var isBusy = false;
  var liveSteps = []; // agent görevi sırasında canlı biriken adım listesi (thinking display)
  function selectedModelLabel() {
    var sel = document.getElementById('modelSelect');
    if (!sel) return '';
    var opt = sel.options[sel.selectedIndex];
    return opt ? opt.textContent.split(' — ')[0].replace('⚡ ', '') : '';
  }
  function setLive(text, state) {
    var el = document.getElementById('liveStatus');
    if (!el) return;
    var dot = state === 'busy' ? '<span class="live-dot busy"></span>' : (state === 'done' ? '<span class="live-dot"></span>' : '');
    el.innerHTML = dot + '<span>' + text + '</span>';
  }
  // Gönder ↔ İptal butonu durumu
  function setBusy(busy, mode) {
    isBusy = busy;
    if (busy && mode) busyMode = mode;
    if (!busy) busyMode = '';
    var btn = document.getElementById('btnRun');
    if (!btn) return;
    if (busy) {
      btn.classList.add('btn-cancel');
      btn.innerHTML = '${this.icon('trash').replace(/'/g, "\\'")}';
      btn.title = 'İptal et';
    } else {
      btn.classList.remove('btn-cancel');
      btn.innerHTML = '${this.icon('send').replace(/'/g, "\\'")}';
      btn.title = 'Gönder';
    }
  }

  function runTask() {
    var promptBox = document.getElementById('prompt');
    var prompt = promptBox.value.trim();
    if (!prompt) return;
    var applyEl = document.getElementById('applyFiles');
    var applyFiles = applyEl ? applyEl.checked : false;
    var modelSel = document.getElementById('modelSelect');
    var modelId = modelSel ? modelSel.value : '__auto_free__';
    promptBox.value = '';

    setLive(selectedModelLabel() + ' çalışıyor…', 'busy');

    if (applyFiles) {
      // GÖREV MODU — dosya yazar
      chatHistory.push({ role: 'user', content: prompt });
      renderChat(true);
      document.getElementById('result').style.display = 'none';
      document.getElementById('meta').style.display = 'none';
      document.getElementById('saveRow').style.display = 'none';
      liveSteps = [];
      setBusy(true, 'agent');
      vscode.postMessage({ command: 'agentTask', prompt: prompt, applyFiles: true });
    } else {
      // SOHBET MODU — hafızalı, seçili model
      lastUserMsg = prompt;
      chatHistory.push({ role: 'user', content: prompt });
      renderChat(true);
      setBusy(true, 'chat');
      vscode.postMessage({ command: 'chat', history: chatHistory, modelId: modelId });
    }
  }

  // Settings
  var btnSaveKey = document.getElementById('btnSaveKey');
  if (btnSaveKey) btnSaveKey.addEventListener('click', function() {
    var key = document.getElementById('apiKey').value.trim();
    showErr('keyErr', '');
    showOk('keyOk', '');
    if (!key) { showErr('keyErr', i18n.keyEmpty); return; }
    vscode.postMessage({ command: 'saveKey', key: key });
  });

  var telemetryToggle = document.getElementById('telemetryToggle');
  if (telemetryToggle) telemetryToggle.addEventListener('change', function() {
    vscode.postMessage({ command: 'setTelemetry', enabled: telemetryToggle.checked });
    var st = document.getElementById('telemetryStatus');
    if (st) {
      st.textContent = 'Durum: ' + (telemetryToggle.checked ? '✓ Etkin' : 'Kapalı');
      st.style.color = telemetryToggle.checked ? '#10b981' : 'var(--vscode-descriptionForeground)';
    }
  });

  // Sohbet geçmişi temizleme (Ayarlar)
  var btnClearProjectChat = document.getElementById('btnClearProjectChat');
  if (btnClearProjectChat) btnClearProjectChat.addEventListener('click', function() {
    if (!confirm('Bu projedeki sohbet geçmişi silinsin mi?')) return;
    chatHistory = [];
    renderChat(false);
    vscode.postMessage({ command: 'clearChat', scope: 'current' });
    btnClearProjectChat.textContent = 'Temizlendi ✓';
  });
  var btnClearAllChat = document.getElementById('btnClearAllChat');
  if (btnClearAllChat) btnClearAllChat.addEventListener('click', function() {
    if (confirm('Tüm projelerdeki sohbet geçmişi silinsin mi?')) {
      chatHistory = [];
      renderChat(false);
      vscode.postMessage({ command: 'clearChat', scope: 'all' });
      btnClearAllChat.textContent = 'Tümü Temizlendi ✓';
    }
  });

  var btnOpenConfig = document.getElementById('btnOpenConfig');
  if (btnOpenConfig) btnOpenConfig.addEventListener('click', function() {
    vscode.postMessage({ command: 'openConfig' });
  });

  var btnCopyKey = document.getElementById('btnCopyKey');
  if (btnCopyKey) btnCopyKey.addEventListener('click', function() {
    var key = btnCopyKey.dataset.key || '';
    if (!key) return;
    navigator.clipboard.writeText(key).then(function() {
      showOk('copyOk', '✓ Kopyalandı');
      setTimeout(function() { showOk('copyOk', ''); }, 2000);
    });
  });

  var btnDeactivate = document.getElementById('btnDeactivate');
  if (btnDeactivate) btnDeactivate.addEventListener('click', function() {
    vscode.postMessage({ command: 'deactivateLicense' });
  });

  document.querySelectorAll('.preset-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var errEl = document.getElementById('presetErr');
      if (errEl) errEl.textContent = '';
      vscode.postMessage({ command: 'applyPreset', key: btn.getAttribute('data-preset') });
    });
  });

  var btnCustomInstructions = document.getElementById('btnCustomInstructions');
  if (btnCustomInstructions) btnCustomInstructions.addEventListener('click', function() {
    openModal('instructionsModal');
  });
  var btnCiClose = document.getElementById('btnCiClose');
  if (btnCiClose) btnCiClose.addEventListener('click', function() { closeModal('instructionsModal'); });
  var btnCiAdd = document.getElementById('btnCiAdd');
  var ciInput = document.getElementById('ciInput');
  function submitCiAdd() {
    var val = (ciInput.value || '').trim();
    document.getElementById('ciErr').textContent = '';
    if (!val) return;
    vscode.postMessage({ command: 'addCustomInstruction', text: val });
    ciInput.value = '';
  }
  if (btnCiAdd) btnCiAdd.addEventListener('click', submitCiAdd);
  if (ciInput) ciInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') submitCiAdd(); });
  var ciList = document.getElementById('ciList');
  if (ciList) ciList.addEventListener('click', function(e) {
    var idx = e.target && e.target.getAttribute && e.target.getAttribute('data-ci-remove');
    if (idx !== null && idx !== undefined) {
      vscode.postMessage({ command: 'removeCustomInstruction', index: parseInt(idx, 10) });
    }
  });

  // Links
  var linkOR = document.getElementById('linkOpenRouter');
  if (linkOR) linkOR.addEventListener('click', function(e) {
    e.preventDefault();
    vscode.postMessage({ command: 'openUrl', url: 'https://openrouter.ai/keys' });
  });
  var linkModels = document.getElementById('linkModels');
  if (linkModels) linkModels.addEventListener('click', function(e) {
    e.preventDefault();
    vscode.postMessage({ command: 'openUrl', url: 'https://openrouter.ai/models' });
  });

  // Agent operations
  var btnNewAgent = document.getElementById('btnNewAgent');
  if (btnNewAgent) btnNewAgent.addEventListener('click', function() { openAgentModal(null); });

  var agentCards = document.getElementById('agentCards');
  if (agentCards) agentCards.addEventListener('click', function(e) {
    var editBtn = e.target.closest('.edit-agent-btn');
    var delBtn = e.target.closest('.delete-agent-btn');
    if (editBtn) openAgentModal(editBtn.dataset.key);
    if (delBtn) deleteAgent(delBtn.dataset.key);
  });

  var btnSaveAgent = document.getElementById('btnSaveAgent');
  if (btnSaveAgent) btnSaveAgent.addEventListener('click', saveAgent);
  var btnCancelAgent = document.getElementById('btnCancelAgent');
  if (btnCancelAgent) btnCancelAgent.addEventListener('click', function() { closeModal('agentModal'); });

  // Task operations
  var btnNewTask = document.getElementById('btnNewTask');
  if (btnNewTask) btnNewTask.addEventListener('click', function() { openTaskModal(null); });

  var taskCards = document.getElementById('taskCards');
  if (taskCards) taskCards.addEventListener('click', function(e) {
    var editBtn = e.target.closest('.edit-task-btn');
    var delBtn = e.target.closest('.delete-task-btn');
    if (editBtn) openTaskModal(editBtn.dataset.key);
    if (delBtn) deleteTask(delBtn.dataset.key);
  });

  var btnSaveTask = document.getElementById('btnSaveTask');
  if (btnSaveTask) btnSaveTask.addEventListener('click', saveTask);
  var btnCancelTask = document.getElementById('btnCancelTask');
  if (btnCancelTask) btnCancelTask.addEventListener('click', function() { closeModal('taskModal'); });

  // Save file
  var btnShowSave = document.getElementById('btnShowSave');
  if (btnShowSave) btnShowSave.addEventListener('click', function() {
    document.getElementById('saveFilename').value = guessFilename(lastResult);
    openModal('saveModal');
  });
  var btnDoSave = document.getElementById('btnDoSave');
  if (btnDoSave) btnDoSave.addEventListener('click', function() {
    var filename = document.getElementById('saveFilename').value.trim();
    showErr('saveErr', '');
    if (!filename) { showErr('saveErr', i18n.filenameEmpty); return; }
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(filename)) { showErr('saveErr', i18n.filenameInvalid); return; }
    vscode.postMessage({ command: 'saveFile', content: lastResult, filename: filename });
    closeModal('saveModal');
  });
  var btnCancelSave = document.getElementById('btnCancelSave');
  if (btnCancelSave) btnCancelSave.addEventListener('click', function() { closeModal('saveModal'); });

  // Pro modal
  var btnShowPro = document.getElementById('btnShowPro');
  if (btnShowPro) btnShowPro.addEventListener('click', function() { openModal('proModal'); });
  var btnCancelPro = document.getElementById('btnCancelPro');
  if (btnCancelPro) btnCancelPro.addEventListener('click', function() { closeModal('proModal'); });
  var btnBuyPro = document.getElementById('btnBuyPro');
  if (btnBuyPro) btnBuyPro.addEventListener('click', function() {
    vscode.postMessage({ command: 'openUrl', url: 'https://checkout.dodopayments.com/buy/pdt_0NgH0yzoqvbfRJzcI6m3F' });
  });
  var btnActivate = document.getElementById('btnActivate');
  if (btnActivate) btnActivate.addEventListener('click', function() {
    var key = document.getElementById('licenseKey').value.trim();
    showErr('licenseErr', '');
    if (!key) { showErr('licenseErr', i18n.keyEmpty); return; }
    vscode.postMessage({ command: 'activateLicense', key: key });
  });

  // Modal functions
  function openAgentModal(key) {
    editingAgentKey = key;
    var titleEl = document.getElementById('agentModalTitle');
    if (titleEl) titleEl.textContent = key ? ${JSON.stringify(t('agentEdit'))} : ${JSON.stringify(t('agentNew'))};
    document.getElementById('agentKey').disabled = !!key;
    showErr('agentModalErr', '');
    if (key && agents[key]) {
      var a = agents[key];
      document.getElementById('agentKey').value = key;
      document.getElementById('agentName').value = a.name || '';
      document.getElementById('agentModel').value = a.model || '';
      document.getElementById('agentRole').value = a.role || 'coding';
      document.getElementById('agentFallback').value = a.fallback || '';
      document.getElementById('agentRetries').value = a.maxRetries || 2;
      document.getElementById('agentSystemPrompt').value = a.systemPrompt || '';
      // Pro: API key
      var akEl = document.getElementById('agentApiKey');
      var epEl = document.getElementById('agentApiEndpoint');
      if (akEl) akEl.value = a.apiKey || '';
      if (epEl) epEl.value = a.apiEndpoint || '';
    } else {
      document.getElementById('agentKey').value = '';
      document.getElementById('agentName').value = '';
      document.getElementById('agentModel').value = '';
      document.getElementById('agentRole').value = 'coding';
      document.getElementById('agentFallback').value = '';
      document.getElementById('agentRetries').value = 2;
      document.getElementById('agentSystemPrompt').value = '';
    }
    openModal('agentModal');
  }

  function saveAgent() {
    showErr('agentModalErr', '');
    var data = {
      key: document.getElementById('agentKey').value.trim(),
      name: document.getElementById('agentName').value.trim(),
      model: document.getElementById('agentModel').value.trim(),
      role: document.getElementById('agentRole').value,
      fallback: document.getElementById('agentFallback').value,
      maxRetries: document.getElementById('agentRetries').value,
      systemPrompt: document.getElementById('agentSystemPrompt').value,
    };
    // Pro: agent API key ve endpoint
    var apiKeyEl = document.getElementById('agentApiKey');
    var apiEpEl = document.getElementById('agentApiEndpoint');
    if (apiKeyEl && apiKeyEl.value.trim()) {
      data.apiKey = apiKeyEl.value.trim();
      if (apiEpEl && apiEpEl.value.trim()) data.apiEndpoint = apiEpEl.value.trim();
    }
    if (!data.key || !data.name || !data.model) {
      showErr('agentModalErr', i18n.agentFieldsRequired);
      return;
    }
    vscode.postMessage({ command: 'saveAgent', isEdit: !!editingAgentKey, agent: data });
  }

  function deleteAgent(key) {
    // Onay extension tarafında (webview confirm çalışmıyor)
    vscode.postMessage({ command: 'deleteAgent', key: key });
  }

  function openTaskModal(key) {
    editingTaskKey = key;
    var titleEl = document.getElementById('taskModalTitle');
    if (titleEl) titleEl.textContent = key ? ${JSON.stringify(t('taskEdit'))} : ${JSON.stringify(t('taskNew'))};
    document.getElementById('taskKey').disabled = !!key;
    showErr('taskModalErr', '');
    if (key && tasks[key]) {
      document.getElementById('taskKey').value = key;
      document.getElementById('taskDescription').value = tasks[key].description || '';
      document.getElementById('taskPrimary').value = tasks[key].primary || '';
    } else {
      document.getElementById('taskKey').value = '';
      document.getElementById('taskDescription').value = '';
    }
    openModal('taskModal');
  }

  function saveTask() {
    showErr('taskModalErr', '');
    var data = {
      key: document.getElementById('taskKey').value.trim(),
      description: document.getElementById('taskDescription').value.trim(),
      primary: document.getElementById('taskPrimary').value,
    };
    if (!data.key || !data.description || !data.primary) {
      showErr('taskModalErr', i18n.taskFieldsRequired);
      return;
    }
    vscode.postMessage({ command: 'saveTask', isEdit: !!editingTaskKey, task: data });
  }

  function deleteTask(key) {
    vscode.postMessage({ command: 'deleteTask', key: key });
  }

  function openModal(id) { var el = document.getElementById(id); if (el) el.classList.add('open'); }
  function closeModal(id) { var el = document.getElementById(id); if (el) el.classList.remove('open'); }

  function showErr(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  function showOk(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  function guessFilename(content) {
    if (!content) return 'output.txt';
    if (content.includes('<!DOCTYPE') || content.includes('<html')) return 'output.html';
    if (content.includes('#include') || content.includes('using namespace')) return 'output.cpp';
    if (content.includes('import ') && content.includes(' from ')) return 'output.ts';
    if (content.includes('function ') || content.includes('const ')) return 'output.js';
    if (content.includes('def ') || content.includes('import ')) return 'output.py';
    return 'output.txt';
  }

  // Message listener
  window.addEventListener('message', function(e) {
    var msg = e.data;
    if (!msg || !msg.command) return;

    switch(msg.command) {
      case 'loading':
        // Görev modu — sohbet zaten "yazıyor" gösteriyor
        break;
      case 'chatLoading':
        renderChat(true);
        setBusy(true);
        break;
      case 'chatTrying':
        // O an GERÇEKTEN denenen model (fallback'e geçtiyse de doğru gösterir)
        setLive((msg.model || '') + ' çalışıyor…', 'busy');
        break;
      case 'chatCancelled':
        // Son kullanıcı mesajını geri al ve textbox'a yaz
        setBusy(false);
        setLive('İptal edildi', '');
        if (chatHistory.length && chatHistory[chatHistory.length-1].role === 'user') {
          chatHistory.pop();
        }
        renderChat(false);
        var pb = document.getElementById('prompt');
        if (pb && lastUserMsg) pb.value = lastUserMsg;
        saveChat();
        break;
      case 'chatReply':
        setBusy(false);
        if (msg.data && msg.data.success) {
          if (msg.data.notice) chatHistory.push({ role: 'info', content: msg.data.notice });
          chatHistory.push({ role: 'assistant', content: msg.data.content });
          renderChat(false);
          var modelName = msg.data.model || selectedModelLabel();
          var tok = msg.data.tokens ? (' · ' + msg.data.tokens.toLocaleString() + ' token') : '';
          setLive(modelName + tok, 'done');
        } else {
          chatHistory.push({ role: 'assistant', content: '⚠ ' + ((msg.data && msg.data.error) || 'Bir şeyler ters gitti.'), error: true });
          renderChat(false);
          setLive('', '');
        }
        saveChat();
        break;
      case 'agentStep':
        // Postacı'nın anlık adımı — canlı gösterge (thinking display) + biriken adım listesi
        if (msg.step) {
          setLive(String(msg.step).replace(/^\s+/, '').slice(0, 80), 'busy');
          liveSteps.push(String(msg.step));
          var liveBox = document.getElementById('result');
          if (liveBox) {
            liveBox.textContent = liveSteps.join('\\n');
            liveBox.style.display = 'block';
            liveBox.scrollTop = liveBox.scrollHeight;
          }
        }
        break;
      case 'persistentErrors':
        if (msg.data && msg.data.count > 0) {
          chatHistory.push({ role: 'info', content: '⚠ ' + msg.data.count + ' dosyada kalıcı hata var (önceki denetimden beri giderilmemiş). "Hataları Düzelt" ile Postacı\\'ya düzelttirebilirsin.' });
          renderChat(false);
          saveChat();
        }
        break;
      case 'result':
        // GÖREV modu sonucu (agentTask) — meşgul durumunu her zaman kapat
        setBusy(false);
        setLive('', '');
        if (msg.data && msg.data.success) {
          lastResult = msg.data.content;
          // Kısa özet baloncuk + detay result-box'ta
          chatHistory.push({ role: 'assistant', content: '✅ İşlem tamamlandı (' + (msg.data.usedModel || 'AI') + '). Sonuç aşağıda.' });
          renderChat(false);
          var rb = document.getElementById('result');
          rb.textContent = msg.data.content;
          rb.style.display = 'block';
          document.getElementById('metaModel').textContent = msg.data.usedModel || '';
          document.getElementById('meta').style.display = 'flex';
          document.getElementById('saveRow').style.display = 'flex';
          var revertRow = document.getElementById('revertRow');
          if (revertRow) revertRow.style.display = msg.data.revertible ? 'flex' : 'none';
          if (btnRevertLast) btnRevertLast.disabled = false;
        } else {
          chatHistory.push({ role: 'assistant', content: '⚠ ' + ((msg.data && msg.data.error) || i18n.unknownError), error: true });
          renderChat(false);
        }
        saveChat();
        break;
      case 'revertDone': {
        var rr = document.getElementById('revertRow');
        var hasMore = !!(msg.data && msg.data.hasMore);
        if (rr) rr.style.display = hasMore ? 'flex' : 'none';
        if (btnRevertLast) btnRevertLast.disabled = false;
        var ok = msg.data && msg.data.failed && msg.data.failed.length === 0;
        var extra = hasMore ? ' (daha fazla geri alınabilir — Pro)' : '';
        chatHistory.push({ role: 'assistant', content: (ok ? '↩ ' : '⚠ ') + (msg.data ? msg.data.reverted : 0) + ' dosya geri alındı.' + extra, error: !ok });
        renderChat(false);
        saveChat();
        break;
      }
      case 'fileContext':
        var promptEl2 = document.getElementById('prompt');
        if (promptEl2 && msg.content) {
          var sep = promptEl2.value ? '\\n\\n' : '';
          promptEl2.value = sep + '--- ' + msg.filename + ' ---\\n' + msg.content;
        }
        break;
      case 'agentSaved':
        closeModal('agentModal');
        break;
      case 'agentError':
        showErr('agentModalErr', msg.error || 'Error');
        showErr('agentErr', msg.error || 'Error');
        break;
      case 'taskSaved':
        closeModal('taskModal');
        break;
      case 'taskError':
        showErr('taskModalErr', msg.error || 'Error');
        break;
      case 'keyError':
        showErr('keyErr', msg.error || 'Error');
        break;
      case 'keySaved':
        showOk('keyOk', '✓ ' + i18n.keySaved);
        setTimeout(function() { showOk('keyOk', ''); }, 3000);
        break;
      case 'licenseLoading':
        document.getElementById('licenseLoading').style.display = 'block';
        document.getElementById('btnActivate').disabled = true;
        break;
      case 'licenseActivated':
        closeModal('proModal');
        chatHistory.push({ role: 'info', content: '🎉 Pro aktif! Tüm agent limitin kalktı, kendi API key\\'ini bağlayabilirsin. Desteğin için gerçekten teşekkürler 💙' });
        renderChat(false);
        saveChat();
        break;
      case 'licenseError':
        document.getElementById('licenseLoading').style.display = 'none';
        document.getElementById('btnActivate').disabled = false;
        showErr('licenseErr', msg.error || 'Error');
        break;
      case 'licenseDeactivated':
        break;
      case 'customInstructionsList': {
        var ciListEl = document.getElementById('ciList');
        if (ciListEl) ciListEl.innerHTML = msg.data || '';
        var ciErrEl1 = document.getElementById('ciErr');
        if (ciErrEl1) ciErrEl1.textContent = '';
        break;
      }
      case 'presetError': {
        var presetErrEl = document.getElementById('presetErr');
        if (presetErrEl) presetErrEl.textContent = msg.error || '';
        break;
      }
      case 'customInstructionsError': {
        var ciErrEl2 = document.getElementById('ciErr');
        if (ciErrEl2) ciErrEl2.textContent = msg.error || '';
        break;
      }
      case 'inspectionProgress':
        if (msg.data) {
          var pct = msg.data.total > 0 ? Math.round(msg.data.checked / msg.data.total * 100) : 0;
          document.getElementById('inspectResult').innerHTML = '<span class="loading">⏳ Taranıyor: '
            + msg.data.checked + '/' + msg.data.total + ' (%' + pct + ') — ' + (msg.data.currentFile || '') + '</span>';
        }
        break;
      case 'inspectionDone':
        if (msg.data) {
          var d = msg.data;
          var btn = document.getElementById('btnInspect');
          if (btn) btn.disabled = false;
          document.getElementById('inspectSummary').textContent =
            '— ' + d.checked + ' dosya, ' + d.errors + ' hatalı, ' + d.clean + ' temiz';
          // Hatalı dosya varsa düzelt butonunu göster
          var fixBtn = document.getElementById('btnFixErrors');
          var actRow = document.getElementById('inspectActions');
          if (actRow && fixBtn && d.errors > 0) {
            actRow.style.display = 'flex';
            fixBtn.disabled = false;
            fixBtn.textContent = 'Hataları Düzelt';
            // Otomatik düzeltme açıksa Postacı'yı kendiliğinden tetikle
            var autoFixEl = document.getElementById('autoFix');
            if (autoFixEl && autoFixEl.checked) {
              fixBtn.disabled = true;
              fixBtn.textContent = 'Düzeltiliyor…';
              setTimeout(function() { vscode.postMessage({ command: 'fixErrors' }); }, 1200);
            }
          } else if (actRow) {
            actRow.style.display = 'none';
          }

          // Rapor metni varsa onu direkt göster (zaten formatlı)
          if (d.report) {
            document.getElementById('inspectResult').innerHTML =
              '<pre style="font-family:var(--vscode-editor-font-family);font-size:11px;line-height:1.4;white-space:pre-wrap;margin:0">'
              + d.report + '</pre>';
          } else {
            var html = '';
            if (d.files && d.files.length > 0) {
              // Hatalı dosyalar
              var errFiles = d.files.filter(function(f) { return f.status === 'error'; });
              var cleanFiles = d.files.filter(function(f) { return f.status === 'clean'; });

              if (errFiles.length > 0) {
                html += '<div style="font-weight:600;color:#ef4444;margin-bottom:8px">❌ HATALI DOSYALAR (' + errFiles.length + ')</div>';
                for (var i = 0; i < errFiles.length; i++) {
                  var f = errFiles[i];
                  html += '<div style="margin-bottom:10px;padding:8px;background:var(--vscode-sideBar-background);border-left:3px solid #ef4444;border-radius:4px">';
                  html += '<div style="font-weight:600;margin-bottom:4px">📄 ' + f.path + ' — ' + f.issues.length + ' sorun</div>';
                  for (var j = 0; j < f.issues.length; j++) {
                    var iss = f.issues[j];
                    var sevColor = iss.severity === 'error' ? '#ef4444' : '#f59e0b';
                    html += '<div style="margin:6px 0;padding:6px;background:var(--vscode-editor-background);border-radius:3px">';
                    html += '<span style="color:' + sevColor + ';font-weight:600">Satır ' + iss.line + ' [' + iss.severity + ']</span>';
                    html += '<div style="margin-top:3px">' + iss.message + '</div>';
                    if (iss.code) html += '<pre style="font-size:10px;color:var(--vscode-descriptionForeground);margin:4px 0 0;padding:4px;background:var(--vscode-textBlockQuote-background);border-radius:2px;overflow-x:auto">' + iss.code + '</pre>';
                    html += '</div>';
                  }
                  html += '</div>';
                }
              }
              if (cleanFiles.length > 0) {
                html += '<div style="font-weight:600;color:#10b981;margin:12px 0 6px">✅ TEMİZ DOSYALAR (' + cleanFiles.length + ')</div>';
                html += '<div style="font-size:11px;color:var(--vscode-descriptionForeground)">';
                for (var k = 0; k < cleanFiles.length; k++) {
                  html += '✅ ' + cleanFiles[k].path + '<br>';
                }
                html += '</div>';
              }
            }
            document.getElementById('inspectResult').innerHTML = html || '<p style="color:var(--vscode-descriptionForeground)">Kontrol edilecek dosya bulunamadı.</p>';
          }
        }
        break;
      case 'inspectionError':
        var btn2 = document.getElementById('btnInspect');
        if (btn2) btn2.disabled = false;
        document.getElementById('inspectResult').innerHTML = '<span style="color:#ef4444">❌ ' + (msg.error || 'Denetim hatası') + '</span>';
        break;
    }
  });

})();
</script>
</body>
</html>`;
    }
}
exports.AIChainPanel = AIChainPanel;
AIChainPanel.viewType = "chainforgeView";
//# sourceMappingURL=panel.js.map