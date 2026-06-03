"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIChainPanel = void 0;
const vscode = require("vscode");
const i18n_1 = require("./i18n");
class AIChainPanel {
    static createOrShow(extensionUri, config, onTask, onOpenConfig, onSaveKey, onSaveConfig, onActivateLicense, onDeactivateLicense, isPro, lang = "en") {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : undefined;
        if (AIChainPanel.currentPanel) {
            AIChainPanel.currentPanel.panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel("aiChain", "⛓ AI Chain", column || vscode.ViewColumn.One, {
            enableScripts: true,
            localResourceRoots: [extensionUri],
            retainContextWhenHidden: true,
        });
        AIChainPanel.currentPanel = new AIChainPanel(panel, config, onTask, onOpenConfig, onSaveKey, onSaveConfig, onActivateLicense, onDeactivateLicense, isPro, lang);
    }
    generateNonce() {
        let text = "";
        const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        for (let i = 0; i < 32; i++)
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        return text;
    }
    constructor(panel, config, onTask, onOpenConfig, onSaveKey, onSaveConfig, onActivateLicense, onDeactivateLicense, isPro, lang = "en") {
        this.config = config;
        this.onTask = onTask;
        this.onOpenConfig = onOpenConfig;
        this.onSaveKey = onSaveKey;
        this.onSaveConfig = onSaveConfig;
        this.onActivateLicense = onActivateLicense;
        this.onDeactivateLicense = onDeactivateLicense;
        this.isPro = isPro;
        this.lang = lang;
        this.disposables = [];
        this.panel = panel;
        this.nonce = this.generateNonce();
        this.update();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(async (message) => {
            // Her mesaj tipi için strict tip kontrolü
            if (!message || typeof message.command !== "string")
                return;
            switch (message.command) {
                case "runTask": {
                    if (typeof message.prompt !== "string" || typeof message.taskType !== "string")
                        return;
                    if (message.prompt.length > 50000) {
                        this.panel.webview.postMessage({ command: "result", data: { success: false, error: "Prompt çok uzun" } });
                        return;
                    }
                    this.panel.webview.postMessage({ command: "loading" });
                    const result = await this.onTask(message.prompt, message.taskType);
                    this.panel.webview.postMessage({ command: "result", data: result });
                    break;
                }
                case "openConfig":
                    this.onOpenConfig();
                    break;
                case "changeLang": {
                    if (typeof message.lang !== "string")
                        return;
                    const validLangs = ["en", "tr", "de", "fr", "es", "ja", "zh"];
                    if (validLangs.includes(message.lang)) {
                        this.lang = message.lang;
                        vscode.workspace.getConfiguration("chainforge").update("language", message.lang, vscode.ConfigurationTarget.Global);
                        this.update();
                    }
                    break;
                }
                case "openUrl": {
                    if (typeof message.url !== "string")
                        return;
                    const allowed = ["openrouter.ai", "dodopayments.com", "test.checkout.dodopayments.com", "dodo.pe"];
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
                        this.panel.webview.postMessage({ command: "keyError", error: "Geçersiz OpenRouter key formatı" });
                        return;
                    }
                    this.onSaveKey(message.key);
                    this.panel.webview.postMessage({ command: "keySaved" });
                    break;
                }
                case "saveAgent": {
                    if (!message.agent || typeof message.agent !== "object")
                        return;
                    const result = this.panel.webview._context?.configManager?.validateAndAddAgent
                        ? null
                        : this.validateAndApplyAgent(message.agent, message.isEdit);
                    if (result && !result.success) {
                        this.panel.webview.postMessage({ command: "agentError", error: result.error });
                        return;
                    }
                    if (this.config) {
                        const r = this.applyAgent(message.agent, message.isEdit);
                        if (!r.success) {
                            this.panel.webview.postMessage({ command: "agentError", error: r.error });
                            return;
                        }
                        this.onSaveConfig(this.config);
                        this.update();
                        this.panel.webview.postMessage({ command: "agentSaved" });
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
                            this.panel.webview.postMessage({ command: "agentError", error: `Önce şu agent'ların fallback'ini değiştirin: ${dependents.join(", ")}` });
                            return;
                        }
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
                        this.panel.webview.postMessage({ command: "taskError", error: r.error });
                        return;
                    }
                    this.onSaveConfig(this.config);
                    this.update();
                    this.panel.webview.postMessage({ command: "taskSaved" });
                    break;
                }
                case "deleteTask": {
                    if (typeof message.key !== "string" || !/^[a-zA-Z0-9_\-]{1,50}$/.test(message.key))
                        return;
                    if (this.config?.tasks[message.key]) {
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
                        this.panel.webview.postMessage({ command: "fileError", error: "Geçersiz dosya adı" });
                        return;
                    }
                    await this.saveFile(message.content, message.filename);
                    break;
                }
                case "activateLicense": {
                    if (typeof message.key !== "string")
                        return;
                    if (!/^[A-Za-z0-9\-_]{10,100}$/.test(message.key.trim())) {
                        this.panel.webview.postMessage({ command: "licenseError", error: "Geçersiz lisans key formatı" });
                        return;
                    }
                    this.panel.webview.postMessage({ command: "licenseLoading" });
                    const result = await this.onActivateLicense(message.key.trim());
                    if (result.success) {
                        this.isPro = true;
                        this.update();
                        this.panel.webview.postMessage({ command: "licenseActivated" });
                    }
                    else {
                        this.panel.webview.postMessage({ command: "licenseError", error: result.error || "Aktivasyon başarısız" });
                    }
                    break;
                }
                case "deactivateLicense": {
                    await this.onDeactivateLicense();
                    this.isPro = false;
                    this.update();
                    this.panel.webview.postMessage({ command: "licenseDeactivated" });
                    break;
                }
            }
        }, null, this.disposables);
    }
    validateAndApplyAgent(data, isEdit) {
        if (!data.key || !/^[a-zA-Z0-9_\-]{1,50}$/.test(data.key))
            return { success: false, error: "Key geçersiz" };
        if (!data.name || data.name.length > 100)
            return { success: false, error: "İsim geçersiz" };
        if (!data.model || !/^[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-\.]+$/.test(data.model))
            return { success: false, error: "Model formatı geçersiz (örn: minimax/minimax-m3)" };
        if (!["coding", "math", "routing", "long-coding", "fallback", "supervisor", "custom"].includes(data.role))
            return { success: false, error: "Geçersiz rol" };
        if (data.systemPrompt && data.systemPrompt.length > 2000)
            return { success: false, error: "Sistem promptu max 2000 karakter" };
        if (data.systemPrompt && /<script|javascript:|eval\(/i.test(data.systemPrompt))
            return { success: false, error: "Sistem promptunda geçersiz içerik" };
        if (data.fallback && data.fallback === data.key)
            return { success: false, error: "Agent kendine fallback olamaz" };
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
        this.panel.webview.html = this.getHtml();
    }
    escapeHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#x27;");
    }
    getAgentCards() {
        if (!this.config?.agents || Object.keys(this.config.agents).length === 0) {
            return "<p class='empty'>Henüz agent yok. Yeni Agent butonuna tıklayın.</p>";
        }
        const roleColors = {
            routing: "#f59e0b", math: "#10b981", coding: "#3b82f6",
            "long-coding": "#ec4899", fallback: "#6b7280", supervisor: "#ef4444", custom: "#8b5cf6",
        };
        return Object.entries(this.config.agents).map(([key, agent]) => {
            const color = roleColors[agent.role] || "#6b7280";
            const safeKey = this.escapeHtml(key);
            const safeName = this.escapeHtml(agent.name || key);
            const safeModel = this.escapeHtml(agent.model);
            const safeRole = this.escapeHtml(agent.role);
            const safeFallback = agent.fallback ? this.escapeHtml(agent.fallback) : "";
            return `
        <div class="card" data-key="${safeKey}">
          <div class="card-top">
            <div style="flex:1;min-width:0">
              <div class="card-name">${safeName}</div>
              <div class="card-model">${safeModel}</div>
            </div>
            <span class="badge" style="background:${color}20;color:${color}">${safeRole}</span>
          </div>
          ${safeFallback ? `<div class="card-fallback">→ ${safeFallback}</div>` : ""}
          <div class="card-actions">
            <button class="btn-sm edit-agent-btn" data-key="${safeKey}">Düzenle</button>
            <button class="btn-sm btn-danger delete-agent-btn" data-key="${safeKey}">Sil</button>
          </div>
        </div>`;
        }).join("");
    }
    getTaskCards() {
        if (!this.config?.tasks || Object.keys(this.config.tasks).length === 0) {
            return "<p class='empty'>Henüz görev yok. Yeni Görev butonuna tıklayın.</p>";
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
            <button class="btn-sm edit-task-btn" data-key="${safeKey}">Düzenle</button>
            <button class="btn-sm btn-danger delete-task-btn" data-key="${safeKey}">Sil</button>
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
        const freeLimit = 3;
        const agentCount = Object.keys(this.config?.agents || {}).length;
        const atLimit = !this.isPro && agentCount >= freeLimit;
        const n = this.nonce;
        const lang = (this.lang || "en");
        const t = (key) => i18n_1.translations[lang]?.[key] || i18n_1.translations["en"]?.[key] || key;
        const langOptions = Object.entries(i18n_1.languageNames).map(([code, name]) => `<option value="${code}" ${code === lang ? "selected" : ""}>${name}</option>`).join("");
        return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Chain</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-size:13px}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--vscode-panel-border);position:sticky;top:0;background:var(--vscode-editor-background);z-index:10}
.topbar-title{font-size:15px;font-weight:600}
.topbar-sub{font-size:10px;color:var(--vscode-descriptionForeground)}
.tabs{display:flex;border-bottom:1px solid var(--vscode-panel-border);padding:0 16px;background:var(--vscode-editor-background);position:sticky;top:42px;z-index:9}
.tab{padding:8px 12px;font-size:12px;cursor:pointer;border:none;border-bottom:2px solid transparent;color:var(--vscode-descriptionForeground);background:none;font-family:inherit}
.tab.active{color:var(--vscode-editor-foreground);border-bottom-color:var(--vscode-focusBorder)}
.tab-content{display:none;padding:16px}
.tab-content.active{display:block}
input,select,textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:6px 10px;font-size:13px;font-family:inherit;width:100%;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--vscode-focusBorder)}
textarea{resize:vertical;min-height:70px}
label{font-size:11px;color:var(--vscode-descriptionForeground);display:block;margin-bottom:3px;margin-top:10px}
label:first-of-type{margin-top:0}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit}
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
            ? `<span class="active-badge">${t('proActive')}</span>`
            : `<button id="btnShowPro" class="btn-sec" style="font-size:11px">${t('upgradeBtn')}</button>`}
  </div>
</div>

<div class="tabs">
  <button class="tab active" id="tab-run">${t('tabRun')}</button>
  <button class="tab" id="tab-agents">${t('tabAgents')}</button>
  <button class="tab" id="tab-tasks">${t('tabTasks')}</button>
  <button class="tab" id="tab-settings">${t('tabSettings')}</button>
</div>

<!-- ÇALIŞTIR -->
<div class="tab-content active" id="content-run">
  <div class="sec-label">Görev Tipi</div>
  <select id="taskType">${this.getTaskOptions()}</select>

  <label for="prompt">Prompt</label>
  <textarea id="prompt" placeholder="Görevinizi yazın... (Enter = gönder, Shift+Enter = yeni satır)"></textarea>

  <div class="btn-row">
    <button id="btnRun">▶ Çalıştır</button>
    <button id="btnClear" class="btn-sec">Temizle</button>
  </div>

  <div class="divider"></div>

  <div class="sec-label">Sonuç</div>
  <div class="result-box" id="result">Henüz sonuç yok.</div>
  <div class="meta-row" id="meta" style="display:none">
    <span>🤖 <b id="metaAgent"></b></span>
    <span>📦 <span id="metaModel"></span></span>
    <span>🔄 <span id="metaAttempts"></span></span>
  </div>
  <div class="btn-row" id="saveRow" style="display:none">
    <button id="btnShowSave">💾 Dosyaya Kaydet</button>
  </div>
</div>

<!-- AGENTLAR -->
<div class="tab-content" id="content-agents">
  <div class="sec-label">Mevcut Agentlar</div>
  <div class="cards-grid" id="agentCards">${this.getAgentCards()}</div>
  ${atLimit ? `<p class="limit-note">⚠ Ücretsiz sürümde max ${freeLimit} agent. Pro'ya geçerek sınırsız agent ekleyebilirsiniz.</p>` : ""}
  <button id="btnNewAgent" ${atLimit ? "disabled" : ""}>+ Yeni Agent</button>
  <div id="agentErr" class="err-msg"></div>
</div>

<!-- GÖREVLER -->
<div class="tab-content" id="content-tasks">
  <div class="sec-label">Mevcut Görevler</div>
  <div class="cards-grid" id="taskCards">${this.getTaskCards()}</div>
  <button id="btnNewTask">+ Yeni Görev</button>
  <div id="taskErr" class="err-msg"></div>
</div>

<!-- AYARLAR -->
<div class="tab-content" id="content-settings">
  <div class="sec-label">OpenRouter API Key</div>
  <div class="key-row">
    <input type="password" id="apiKey" placeholder="sk-or-..." autocomplete="off" />
    <button id="btnSaveKey">Kaydet</button>
  </div>
  <div id="keyErr" class="err-msg"></div>
  <div id="keyOk" class="ok-msg">✓ Key kaydedildi</div>
  <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:6px">
    Ücretsiz key: <a id="linkOpenRouter" href="#">openrouter.ai</a>
  </p>

  ${this.isPro ? `
  <div class="divider"></div>
  <div class="sec-label">Pro Lisans</div>
  <div style="font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:8px">Aktif lisansınız mevcut.</div>
  <button id="btnDeactivate" class="btn-danger btn-sec">Lisansı İptal Et</button>
  ` : ""}

  <div class="divider"></div>
  <div class="sec-label">Gelişmiş</div>
  <button id="btnOpenConfig" class="btn-sec">📄 JSON Config Düzenle</button>
</div>

<!-- AGENT MODAL -->
<div class="modal-overlay" id="agentModal">
  <div class="modal">
    <div class="modal-title" id="agentModalTitle">Yeni Agent</div>
    <label>Anahtar (key) *</label>
    <input id="agentKey" placeholder="ornek: ue5_uzman" maxlength="50" autocomplete="off" />
    <label>İsim *</label>
    <input id="agentName" placeholder="UE5 Uzmanı" maxlength="100" />
    <label>Model * <span style="font-size:10px;color:var(--vscode-descriptionForeground)">(provider/model-adi)</span></label>
    <input id="agentModel" placeholder="minimax/minimax-m3" maxlength="100" autocomplete="off" />
    <p style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px">
      Modeller: <a id="linkModels" href="#">openrouter.ai/models</a>
    </p>
    <label>Rol</label>
    <select id="agentRole">
      <option value="coding">coding — Kod yazma</option>
      <option value="math">math — Matematik/mantık</option>
      <option value="routing">routing — Görev yönlendirme</option>
      <option value="long-coding">long-coding — Uzun görevler</option>
      <option value="fallback">fallback — Yedek</option>
      <option value="supervisor">supervisor — Denetmen</option>
      <option value="custom">custom — Özel</option>
    </select>
    <label>Fallback Agent</label>
    <select id="agentFallback">
      <option value="">— Yok —</option>
      ${this.getAgentOptions()}
    </select>
    <label>Max Deneme (1-5)</label>
    <input id="agentRetries" type="number" value="2" min="1" max="5" />
    <label>Sistem Promptu <span style="font-size:10px">(opsiyonel, max 2000 karakter)</span></label>
    <textarea id="agentSystemPrompt" placeholder="Sen deneyimli bir UE5 geliştiricisisin..." maxlength="2000"></textarea>
    <div id="agentModalErr" class="err-msg" style="margin-top:8px"></div>
    <div class="btn-row">
      <button id="btnSaveAgent">Kaydet</button>
      <button id="btnCancelAgent" class="btn-sec">İptal</button>
    </div>
  </div>
</div>

<!-- GÖREV MODAL -->
<div class="modal-overlay" id="taskModal">
  <div class="modal">
    <div class="modal-title" id="taskModalTitle">Yeni Görev</div>
    <label>Anahtar (key) *</label>
    <input id="taskKey" placeholder="ornek: ue5_kodlama" maxlength="50" autocomplete="off" />
    <label>Açıklama *</label>
    <input id="taskDescription" placeholder="UE5 C++ geliştirme" maxlength="200" />
    <label>Primary Agent *</label>
    <select id="taskPrimary">${this.getAgentOptions()}</select>
    <div id="taskModalErr" class="err-msg" style="margin-top:8px"></div>
    <div class="btn-row">
      <button id="btnSaveTask">Kaydet</button>
      <button id="btnCancelTask" class="btn-sec">İptal</button>
    </div>
  </div>
</div>

<!-- DOSYA KAYDET MODAL -->
<div class="modal-overlay" id="saveModal">
  <div class="modal">
    <div class="modal-title">Dosyaya Kaydet</div>
    <label>Dosya adı</label>
    <input id="saveFilename" placeholder="output.ts" maxlength="100" />
    <div id="saveErr" class="err-msg" style="margin-top:6px"></div>
    <div class="btn-row">
      <button id="btnDoSave">Kaydet</button>
      <button id="btnCancelSave" class="btn-sec">İptal</button>
    </div>
  </div>
</div>

<!-- PRO MODAL -->
<div class="modal-overlay" id="proModal">
  <div class="modal">
    <div class="modal-title">⭐ AI Chain Pro — $9.99</div>
    <div class="pro-box">
      <div style="font-size:12px;line-height:1.8">
        ✓ Sınırsız agent ekleme (ücretsiz: 3)<br>
        ✓ Her provider için ayrı API key<br>
        ✓ Gelişmiş fallback zinciri<br>
        ✓ Tüm gelecek güncellemeler<br>
        ✓ Tek seferlik ödeme, abonelik yok
      </div>
    </div>
    <div style="margin-bottom:12px">
      <button id="btnBuyPro" style="width:100%;background:#f59e0b;color:#000;font-weight:600;padding:10px">
        Satın Al — $9.99
      </button>
    </div>
    <div class="divider"></div>
    <label>Lisans Key (satın aldıysanız)</label>
    <input id="licenseKey" placeholder="Lisans key'inizi girin" maxlength="100" autocomplete="off" />
    <div id="licenseErr" class="err-msg" style="margin-top:6px"></div>
    <div id="licenseLoading" style="display:none;font-size:11px;color:var(--vscode-descriptionForeground);margin-top:6px">⏳ Doğrulanıyor...</div>
    <div class="btn-row">
      <button id="btnActivate">Aktive Et</button>
      <button id="btnCancelPro" class="btn-sec">İptal</button>
    </div>
  </div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  let agents = JSON.parse(atob('${agentsJson}'));
  let tasks = JSON.parse(atob('${tasksJson}'));
  let lastResult = "";
  let editingAgentKey = null;
  let editingTaskKey = null;

  // Tab switching
  // Dil değiştirme
  document.getElementById('langSelect')?.addEventListener('change', (e) => {
    const lang = (e.target as HTMLSelectElement).value;
    vscode.postMessage({ command: 'changeLang', lang });
  });

  ['run','agents','tasks','settings'].forEach(name => {
    document.getElementById('tab-' + name)?.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-' + name)?.classList.add('active');
      document.getElementById('content-' + name)?.classList.add('active');
    });
  });

  // Çalıştır
  document.getElementById('btnRun')?.addEventListener('click', runTask);
  document.getElementById('btnClear')?.addEventListener('click', () => {
    document.getElementById('result').textContent = 'Henüz sonuç yok.';
    document.getElementById('meta').style.display = 'none';
    document.getElementById('saveRow').style.display = 'none';
    lastResult = '';
  });
  document.getElementById('prompt')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runTask(); }
  });

  function runTask() {
    const prompt = document.getElementById('prompt').value.trim();
    const taskType = document.getElementById('taskType').value;
    if (!prompt) return;
    document.getElementById('result').innerHTML = '<span class="loading">⏳ Zincir çalışıyor...</span>';
    document.getElementById('meta').style.display = 'none';
    document.getElementById('saveRow').style.display = 'none';
    vscode.postMessage({ command: 'runTask', prompt, taskType });
  }

  // Ayarlar
  document.getElementById('btnSaveKey')?.addEventListener('click', () => {
    const key = document.getElementById('apiKey').value.trim();
    showErr('keyErr', '');
    showOk('keyOk', '');
    if (!key) { showErr('keyErr', 'Key boş olamaz'); return; }
    vscode.postMessage({ command: 'saveKey', key });
  });

  document.getElementById('btnOpenConfig')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'openConfig' });
  });

  document.getElementById('btnDeactivate')?.addEventListener('click', () => {
    if (confirm('Lisansı iptal etmek istiyor musunuz? Pro özellikler devre dışı kalacak.')) {
      vscode.postMessage({ command: 'deactivateLicense' });
    }
  });

  // Linkler
  document.getElementById('linkOpenRouter')?.addEventListener('click', e => {
    e.preventDefault();
    vscode.postMessage({ command: 'openUrl', url: 'https://openrouter.ai/keys' });
  });
  document.getElementById('linkModels')?.addEventListener('click', e => {
    e.preventDefault();
    vscode.postMessage({ command: 'openUrl', url: 'https://openrouter.ai/models' });
  });

  // Agent işlemleri
  document.getElementById('btnNewAgent')?.addEventListener('click', () => openAgentModal(null));

  document.getElementById('agentCards')?.addEventListener('click', e => {
    const editBtn = e.target.closest('.edit-agent-btn');
    const delBtn = e.target.closest('.delete-agent-btn');
    if (editBtn) openAgentModal(editBtn.dataset.key);
    if (delBtn) deleteAgent(delBtn.dataset.key);
  });

  document.getElementById('btnSaveAgent')?.addEventListener('click', saveAgent);
  document.getElementById('btnCancelAgent')?.addEventListener('click', () => closeModal('agentModal'));

  // Görev işlemleri
  document.getElementById('btnNewTask')?.addEventListener('click', () => openTaskModal(null));

  document.getElementById('taskCards')?.addEventListener('click', e => {
    const editBtn = e.target.closest('.edit-task-btn');
    const delBtn = e.target.closest('.delete-task-btn');
    if (editBtn) openTaskModal(editBtn.dataset.key);
    if (delBtn) deleteTask(delBtn.dataset.key);
  });

  document.getElementById('btnSaveTask')?.addEventListener('click', saveTask);
  document.getElementById('btnCancelTask')?.addEventListener('click', () => closeModal('taskModal'));

  // Dosya kaydet
  document.getElementById('btnShowSave')?.addEventListener('click', () => {
    document.getElementById('saveFilename').value = guessFilename(lastResult);
    openModal('saveModal');
  });
  document.getElementById('btnDoSave')?.addEventListener('click', () => {
    const filename = document.getElementById('saveFilename').value.trim();
    showErr('saveErr', '');
    if (!filename) { showErr('saveErr', 'Dosya adı boş olamaz'); return; }
    if (!/^[a-zA-Z0-9_\\-\\.]{1,100}$/.test(filename)) { showErr('saveErr', 'Geçersiz dosya adı'); return; }
    vscode.postMessage({ command: 'saveFile', content: lastResult, filename });
    closeModal('saveModal');
  });
  document.getElementById('btnCancelSave')?.addEventListener('click', () => closeModal('saveModal'));

  // Pro modal
  document.getElementById('btnShowPro')?.addEventListener('click', () => openModal('proModal'));
  document.getElementById('btnCancelPro')?.addEventListener('click', () => closeModal('proModal'));
  document.getElementById('btnBuyPro')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'openUrl', url: 'https://test.checkout.dodopayments.com/buy/pdt_0NgFOgq5Iq8z8tBXX5KtV' });
  });
  document.getElementById('btnActivate')?.addEventListener('click', () => {
    const key = document.getElementById('licenseKey').value.trim();
    showErr('licenseErr', '');
    if (!key) { showErr('licenseErr', 'Key boş olamaz'); return; }
    vscode.postMessage({ command: 'activateLicense', key });
  });

  // Modal fonksiyonları
  function openAgentModal(key) {
    editingAgentKey = key;
    document.getElementById('agentModalTitle').textContent = key ? 'Agent Düzenle' : 'Yeni Agent';
    document.getElementById('agentKey').disabled = !!key;
    showErr('agentModalErr', '');
    if (key && agents[key]) {
      const a = agents[key];
      document.getElementById('agentKey').value = key;
      document.getElementById('agentName').value = a.name || '';
      document.getElementById('agentModel').value = a.model || '';
      document.getElementById('agentRole').value = a.role || 'coding';
      document.getElementById('agentFallback').value = a.fallback || '';
      document.getElementById('agentRetries').value = a.maxRetries || 2;
      document.getElementById('agentSystemPrompt').value = a.systemPrompt || '';
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
    const data = {
      key: document.getElementById('agentKey').value.trim(),
      name: document.getElementById('agentName').value.trim(),
      model: document.getElementById('agentModel').value.trim(),
      role: document.getElementById('agentRole').value,
      fallback: document.getElementById('agentFallback').value,
      maxRetries: document.getElementById('agentRetries').value,
      systemPrompt: document.getElementById('agentSystemPrompt').value,
    };
    if (!data.key || !data.name || !data.model) {
      showErr('agentModalErr', 'Key, isim ve model zorunludur');
      return;
    }
    vscode.postMessage({ command: 'saveAgent', isEdit: !!editingAgentKey, agent: data });
  }

  function deleteAgent(key) {
    if (confirm('"' + key + '" agent silinsin mi?')) {
      vscode.postMessage({ command: 'deleteAgent', key });
    }
  }

  function openTaskModal(key) {
    editingTaskKey = key;
    document.getElementById('taskModalTitle').textContent = key ? 'Görev Düzenle' : 'Yeni Görev';
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
    const data = {
      key: document.getElementById('taskKey').value.trim(),
      description: document.getElementById('taskDescription').value.trim(),
      primary: document.getElementById('taskPrimary').value,
    };
    if (!data.key || !data.description || !data.primary) {
      showErr('taskModalErr', 'Tüm alanlar zorunludur');
      return;
    }
    vscode.postMessage({ command: 'saveTask', isEdit: !!editingTaskKey, task: data });
  }

  function deleteTask(key) {
    if (confirm('"' + key + '" görevi silinsin mi?')) {
      vscode.postMessage({ command: 'deleteTask', key });
    }
  }

  function openModal(id) { document.getElementById(id)?.classList.add('open'); }
  function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

  function showErr(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  function showOk(id, msg) {
    const el = document.getElementById(id);
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

  // Mesaj dinleyici
  window.addEventListener('message', e => {
    const msg = e.data;
    if (!msg?.command) return;

    switch(msg.command) {
      case 'loading':
        document.getElementById('result').innerHTML = '<span class="loading">⏳ Zincir çalışıyor...</span>';
        break;
      case 'result':
        if (msg.data?.success) {
          lastResult = msg.data.content;
          document.getElementById('result').textContent = msg.data.content;
          document.getElementById('metaAgent').textContent = msg.data.usedAgent || '';
          document.getElementById('metaModel').textContent = msg.data.usedModel || '';
          document.getElementById('metaAttempts').textContent = (msg.data.attempts || []).join(' → ');
          document.getElementById('meta').style.display = 'flex';
          document.getElementById('saveRow').style.display = 'flex';
        } else {
          document.getElementById('result').textContent = '❌ ' + (msg.data?.error || 'Bilinmeyen hata');
        }
        break;
      case 'agentSaved':
        closeModal('agentModal');
        break;
      case 'agentError':
        showErr('agentModalErr', msg.error || 'Hata');
        showErr('agentErr', msg.error || 'Hata');
        break;
      case 'taskSaved':
        closeModal('taskModal');
        break;
      case 'taskError':
        showErr('taskModalErr', msg.error || 'Hata');
        break;
      case 'keyError':
        showErr('keyErr', msg.error || 'Hata');
        break;
      case 'keySaved':
        showOk('keyOk', '✓ Key kaydedildi');
        setTimeout(() => showOk('keyOk', ''), 3000);
        break;
      case 'licenseLoading':
        document.getElementById('licenseLoading').style.display = 'block';
        document.getElementById('btnActivate').disabled = true;
        break;
      case 'licenseActivated':
        closeModal('proModal');
        break;
      case 'licenseError':
        document.getElementById('licenseLoading').style.display = 'none';
        document.getElementById('btnActivate').disabled = false;
        showErr('licenseErr', msg.error || 'Aktivasyon başarısız');
        break;
      case 'licenseDeactivated':
        break;
    }
  });

})();
</script>
</body>
</html>`;
    }
    dispose() {
        AIChainPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d)
                d.dispose();
        }
    }
}
exports.AIChainPanel = AIChainPanel;
//# sourceMappingURL=panel.js.map