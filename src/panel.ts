import * as vscode from "vscode";
import { ChainConfig } from "./router";
import { translations, languageNames, Language } from "./i18n";
import { SpendingManager } from "./spending";

export class AIChainPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "chainforgeView";
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private nonce: string = "";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private config: ChainConfig | null,
    private onTask: (prompt: string, taskType: string) => Promise<any>,
    private onOpenConfig: () => void,
    private onSaveKey: (key: string) => void,
    private onSaveConfig: (config: ChainConfig) => void,
    private onActivateLicense: (key: string) => Promise<{ success: boolean; error?: string }>,
    private onDeactivateLicense: () => Promise<void>,
    private isPro: boolean,
    private lang: string = "en",
    private licenseKey: string = "",
    private spendingManager?: SpendingManager,
    private hasApiKey: boolean = false,
    private telemetryConsent: string = "ask"
  ) {
    this.nonce = this.generateNonce();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
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
        if (d) d.dispose();
      }
    }, null, this.disposables);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this.handleMessage(message);
    }, null, this.disposables);
  }

  public focus() {
    this.view?.show(true);
  }

  private generateNonce(): string {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
  }

  private async handleMessage(message: any) {
      if (!message || typeof message.command !== "string") return;

      switch (message.command) {
        case "runTask": {
          if (typeof message.prompt !== "string" || typeof message.taskType !== "string") return;
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
        case "agentTask": {
          if (typeof message.prompt !== "string") return;
          vscode.commands.executeCommand("chainforge.agentTask", message.prompt, !!message.applyFiles, (payload: any) => {
            this.view?.webview.postMessage(payload);
          });
          break;
        }
        case "changeLang": {
          if (typeof message.lang !== "string") return;
          const validLangs = ["en", "tr", "de", "fr", "es", "ja", "zh"];
          if (validLangs.includes(message.lang)) {
            this.lang = message.lang;
            vscode.workspace.getConfiguration("chainforge").update("language", message.lang, vscode.ConfigurationTarget.Global);
            this.update();
          }
          break;
        }
        case "openUrl": {
          if (typeof message.url !== "string") return;
          const allowed = ["openrouter.ai", "dodopayments.com", "checkout.dodopayments.com", "dodo.pe"];
          try {
            const u = new URL(message.url);
            if (allowed.some(d => u.hostname === d || u.hostname.endsWith("." + d))) {
              vscode.env.openExternal(vscode.Uri.parse(message.url));
            }
          } catch {}
          break;
        }
        case "saveKey": {
          if (typeof message.key !== "string") return;
          if (!message.key.startsWith("sk-or-") && !message.key.startsWith("sk-")) {
            this.view?.webview.postMessage({ command: "keyError", error: "Geçersiz OpenRouter key formatı" });
            return;
          }
          this.onSaveKey(message.key);
          this.view?.webview.postMessage({ command: "keySaved" });
          break;
        }
        case "saveAgent": {
          if (!message.agent || typeof message.agent !== "object") return;
          const result = this.validateAndApplyAgent(message.agent, message.isEdit);
          if (result && !result.success) {
            this.view?.webview.postMessage({ command: "agentError", error: result.error });
            return;
          }
          if (this.config) {
            const r = this.applyAgent(message.agent, message.isEdit);
            if (!r.success) { this.view?.webview.postMessage({ command: "agentError", error: r.error }); return; }
            this.onSaveConfig(this.config);
            this.update();
            this.view?.webview.postMessage({ command: "agentSaved" });
          }
          break;
        }
        case "deleteAgent": {
          if (typeof message.key !== "string" || !/^[a-zA-Z0-9_\-]{1,50}$/.test(message.key)) return;
          if (this.config?.agents[message.key]) {
            const dependents = Object.entries(this.config.agents)
              .filter(([k, a]) => a.fallback === message.key && k !== message.key)
              .map(([k]) => k);
            if (dependents.length > 0) {
              this.view?.webview.postMessage({ command: "agentError", error: `Önce şu agent'ların fallback'ini değiştirin: ${dependents.join(", ")}` });
              return;
            }
            delete this.config.agents[message.key];
            this.onSaveConfig(this.config);
            this.update();
          }
          break;
        }
        case "saveTask": {
          if (!message.task || typeof message.task !== "object") return;
          const r = this.applyTask(message.task, message.isEdit);
          if (!r.success) { this.view?.webview.postMessage({ command: "taskError", error: r.error }); return; }
          this.onSaveConfig(this.config!);
          this.update();
          this.view?.webview.postMessage({ command: "taskSaved" });
          break;
        }
        case "deleteTask": {
          if (typeof message.key !== "string" || !/^[a-zA-Z0-9_\-]{1,50}$/.test(message.key)) return;
          if (this.config?.tasks[message.key]) {
            delete this.config.tasks[message.key];
            this.onSaveConfig(this.config);
            this.update();
          }
          break;
        }
        case "saveFile": {
          if (typeof message.content !== "string" || typeof message.filename !== "string") return;
          if (!/^[a-zA-Z0-9_\-\.]{1,100}$/.test(message.filename)) {
            this.view?.webview.postMessage({ command: "fileError", error: "Geçersiz dosya adı" });
            return;
          }
          await this.saveFile(message.content, message.filename);
          break;
        }
        case "activateLicense": {
          if (typeof message.key !== "string") return;
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
          } else {
            this.view?.webview.postMessage({ command: "licenseError", error: result.error || "Aktivasyon başarısız" });
          }
          break;
        }
        case "deactivateLicense": {
          const answer = await vscode.window.showWarningMessage(
            "Lisansı iptal etmek istediğinizden emin misiniz?\nBu lisans yalnızca 1 cihazda kullanılabilir. İptal ettiğinizde Pro özellikler devre dışı kalır.",
            { modal: true },
            "Evet, İptal Et"
          );
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
          if (typeof message.content !== "string") return;
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            editor.edit(editBuilder => {
              if (editor.selection.isEmpty) {
                editBuilder.insert(editor.selection.active, message.content);
              } else {
                editBuilder.replace(editor.selection, message.content);
              }
            });
          }
          break;
        }
        case "clearStats": {
          this.spendingManager?.clearAll();
          this.update();
          break;
        }
        case "setTelemetry": {
          this.telemetryConsent = message.enabled ? "granted" : "denied";
          vscode.commands.executeCommand("chainforge.setTelemetry", !!message.enabled);
          break;
        }
        case "runInspection": {
          vscode.commands.executeCommand("chainforge.inspectFromPanel", (payload: any) => {
            this.view?.webview.postMessage(payload);
          });
          break;
        }
        case "fixErrors": {
          vscode.commands.executeCommand("chainforge.fixErrors", (payload: any) => {
            this.view?.webview.postMessage(payload);
          });
          break;
        }
      }
  }

  private validateAndApplyAgent(data: any, isEdit: boolean): { success: boolean; error?: string } {
    if (!data.key || !/^[a-zA-Z0-9_\-]{1,50}$/.test(data.key)) return { success: false, error: "Key geçersiz" };
    if (!data.name || data.name.length > 100) return { success: false, error: "İsim geçersiz" };
    if (!data.model || (!/^[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-\.]+$/.test(data.model) && data.model !== "openrouter/auto")) return { success: false, error: "Model formatı geçersiz (örn: minimax/minimax-m3)" };
    if (!["coding","math","routing","long-coding","fallback","supervisor","custom"].includes(data.role)) return { success: false, error: "Geçersiz rol" };
    if (data.systemPrompt && data.systemPrompt.length > 2000) return { success: false, error: "Sistem promptu max 2000 karakter" };
    if (data.systemPrompt && /<script|javascript:|eval\(/i.test(data.systemPrompt)) return { success: false, error: "Sistem promptunda geçersiz içerik" };
    if (data.fallback && data.fallback === data.key) return { success: false, error: "Agent kendine fallback olamaz" };
    // Fallback HALKASI kontrolü: A→B→A gibi döngü oluşmasını engelle
    if (data.fallback && this.config?.agents) {
      const visited = new Set<string>([data.key]);
      let cur: string | undefined = data.fallback;
      while (cur) {
        if (visited.has(cur)) {
          return { success: false, error: `Fallback halkası! "${cur}" zincirde tekrar ediyor. Fallback bir zincir olmalı, halka değil (örn: A→B→C, A→B→A DEĞİL).` };
        }
        visited.add(cur);
        cur = this.config.agents[cur]?.fallback;
      }
    }
    if (data.apiKey && data.apiKey.length > 200) return { success: false, error: "API key max 200 karakter" };
    if (data.apiEndpoint && data.apiEndpoint.length > 300) return { success: false, error: "API endpoint max 300 karakter" };
    if (data.apiEndpoint && !/^https?:\/\/.+/.test(data.apiEndpoint)) return { success: false, error: "API endpoint geçersiz URL" };
    return { success: true };
  }

  private applyAgent(data: any, isEdit: boolean): { success: boolean; error?: string } {
    const v = this.validateAndApplyAgent(data, isEdit);
    if (!v.success) return v;
    if (!this.config) return { success: false, error: "Config yüklenemedi" };

    if (!isEdit && this.config.agents[data.key]) return { success: false, error: `'${data.key}' zaten mevcut` };

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

  private applyTask(data: any, isEdit: boolean): { success: boolean; error?: string } {
    if (!data.key || !/^[a-zA-Z0-9_\-]{1,50}$/.test(data.key)) return { success: false, error: "Key geçersiz" };
    if (!data.description || data.description.length > 200) return { success: false, error: "Açıklama geçersiz" };
    if (!this.config?.agents[data.primary]) return { success: false, error: `Agent bulunamadı: ${data.primary}` };
    if (/<|>|script/i.test(data.description)) return { success: false, error: "Açıklamada geçersiz içerik" };

    if (!isEdit && this.config!.tasks[data.key]) return { success: false, error: `'${data.key}' zaten mevcut` };

    this.config!.tasks[data.key] = {
      primary: data.primary,
      description: data.description.trim(),
    };
    return { success: true };
  }

  private async saveFile(content: string, filename: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(filename) });
      if (!uri) return;
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

  public updateConfig(config: ChainConfig) {
    this.config = config;
    this.update();
  }

  private update() {
    this.nonce = this.generateNonce();
    if (this.view) this.view.webview.html = this.getHtml();
  }

  private escapeHtml(str: string): string {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  private getAgentCards(t: (key: string) => string): string {
    if (!this.config?.agents || Object.keys(this.config.agents).length === 0) {
      return `<p class='empty'>${t('agentsEmpty')}</p>`;
    }
    const roleColors: Record<string, string> = {
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
            <button class="btn-sm edit-agent-btn" data-key="${safeKey}">${t('editBtn')}</button>
            <button class="btn-sm btn-danger delete-agent-btn" data-key="${safeKey}">${t('deleteBtn')}</button>
          </div>
        </div>`;
    }).join("");
  }

  private getTaskCards(t: (key: string) => string): string {
    if (!this.config?.tasks || Object.keys(this.config.tasks).length === 0) {
      return `<p class='empty'>${t('tasksEmpty')}</p>`;
    }
    return Object.entries(this.config.tasks).map(([key, task]) => {
      const agent = this.config!.agents[task.primary];
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

  private getAgentOptions(selected?: string): string {
    if (!this.config?.agents) return "";
    return Object.entries(this.config.agents).map(([key, a]) =>
      `<option value="${this.escapeHtml(key)}" ${selected === key ? "selected" : ""}>${this.escapeHtml(a.name || key)}</option>`
    ).join("");
  }

  private getTaskOptions(): string {
    if (!this.config?.tasks) return "";
    return Object.entries(this.config.tasks).map(([key, task]) =>
      `<option value="${this.escapeHtml(key)}">${this.escapeHtml(task.description || key)}</option>`
    ).join("");
  }

  private getHtml(): string {
    const agentsJson = Buffer.from(JSON.stringify(this.config?.agents || {})).toString('base64');
    const tasksJson = Buffer.from(JSON.stringify(this.config?.tasks || {})).toString('base64');
    const freeLimit = 3;
    const agentCount = Object.keys(this.config?.agents || {}).length;
    const atLimit = !this.isPro && agentCount >= freeLimit;
    const n = this.nonce;
    const lang = (this.lang || "en") as Language;
    const t = (key: string) => translations[lang]?.[key] || translations["en"]?.[key] || key;
    const langOptions = Object.entries(languageNames).map(([code, name]) =>
      `<option value="${code}" ${code === lang ? "selected" : ""}>${name}</option>`
    ).join("");

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
      : `<button id="btnShowPro" class="btn-sec" style="font-size:11px">${t('upgradeBtn')}</button>`
    }
  </div>
</div>

<div class="tabs">
  <button class="tab active" id="tab-run">${t('tabRun')}</button>
  <button class="tab" id="tab-agents">${t('tabAgents')}</button>
  <button class="tab" id="tab-tasks">${t('tabTasks')}</button>
  <button class="tab" id="tab-stats">📊 ${t('tabStats') || 'Kullanım'}</button>
  <button class="tab" id="tab-settings">${t('tabSettings')}</button>
</div>

<!-- RUN TAB -->
<div class="tab-content active" id="content-run">
  <div class="sec-label">${t('taskType')}</div>
  <select id="taskType">${this.getTaskOptions()}</select>

  <label for="prompt">${t('prompt')}</label>
  <textarea id="prompt" placeholder="${t('promptPlaceholder') || ''}"></textarea>

  <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin:8px 0;cursor:pointer;color:var(--vscode-editor-foreground)">
    <input type="checkbox" id="applyFiles" style="width:auto;margin:0" />
    📝 Dosyalara uygula <span style="font-size:10px;color:var(--vscode-descriptionForeground)">(işaretsizse sadece gösterir)</span>
  </label>
  <div class="btn-row">
    <button id="btnRun">${t('btnRun')}</button>
    <button id="btnInspect" class="btn-sec">${t('btnInspect') || '🔍 Dosyaları Tara'}</button>
    <button id="btnClear" class="btn-sec">${t('btnClear')}</button>
    <button id="btnFileCtx" class="btn-sec" title="Aktif dosyayı prompta ekle">📎 ${t('btnFileCtx') || 'Dosya Ekle'}</button>
  </div>

  <div class="divider"></div>

  <div class="sec-label">${t('result')}</div>
  <div class="result-box" id="result">${t('noResult')}</div>
  <div class="meta-row" id="meta" style="display:none">
    <span>${t('agentLabel')} <b id="metaAgent"></b></span>
    <span>${t('modelLabel')} <span id="metaModel"></span></span>
    <span>${t('chainLabel')} <span id="metaAttempts"></span></span>
    <span id="metaTokens" style="display:none">🔢 <span id="metaTokenCount"></span> token</span>
    <span id="metaCost" style="display:none">💰 $<span id="metaCostVal"></span></span>
  </div>
  <div class="btn-row" id="saveRow" style="display:none">
    <button id="btnShowSave">${t('saveFile')}</button>
    <button id="btnApplyFile" class="btn-sec" title="Editördeki dosyaya uygula">📝 Dosyaya Uygula</button>
  </div>

  <!-- Denetim sonuçları alanı -->
  <div id="inspectSection" style="display:none;margin-top:14px">
    <div class="divider"></div>
    <div class="sec-label">🔍 Denetim Sonuçları <span id="inspectSummary" style="font-weight:400;font-size:11px"></span></div>
    <label style="display:flex;align-items:center;gap:6px;font-size:11px;margin:6px 0;cursor:pointer;color:var(--vscode-descriptionForeground)">
      <input type="checkbox" id="autoFix" checked style="width:auto;margin:0" />
      Hata bulununca Postacı otomatik düzeltsin
    </label>
    <div class="result-box" id="inspectResult" style="max-height:400px"></div>
    <div class="btn-row" id="inspectActions" style="display:none">
      <button id="btnFixErrors" class="btn-sec" style="background:#f59e0b20;color:#f59e0b">🛠 Hataları Düzelt (Postacı)</button>
    </div>
  </div>
</div>

<!-- AGENTS TAB -->
<div class="tab-content" id="content-agents">
  <div class="sec-label">${t('agentsTitle')}</div>
  <div class="cards-grid" id="agentCards">${this.getAgentCards(t)}</div>
  ${atLimit ? `<p class="limit-note">⚠ ${t('limitNote')}</p>` : ""}
  <button id="btnNewAgent" ${atLimit ? "disabled" : ""}>${t('newAgent')}</button>
  <div id="agentErr" class="err-msg"></div>
</div>

<!-- TASKS TAB -->
<div class="tab-content" id="content-tasks">
  <div class="sec-label">${t('tasksTitle')}</div>
  <div class="cards-grid" id="taskCards">${this.getTaskCards(t)}</div>
  <button id="btnNewTask">${t('newTask')}</button>
  <div id="taskErr" class="err-msg"></div>
</div>

<!-- STATS TAB -->
<div class="tab-content" id="content-stats">
  <div class="sec-label">📊 ${new Date().toLocaleString('tr-TR', {month:'long', year:'numeric'})} Kullanımı</div>
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
  <div class="sec-label">${t('proLicenseTitle') || 'Pro License'}</div>
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
    <div style="flex:1;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:4px;padding:6px 10px;font-size:12px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
      ${this.licenseKey ? this.licenseKey.slice(0,4) + "••••••••••••" + this.licenseKey.slice(-4) : "••••••••••••"}
    </div>
    <button id="btnCopyKey" class="btn-sec" style="flex-shrink:0;font-size:11px" data-key="${this.escapeHtml(this.licenseKey)}">📋 Kopyala</button>
  </div>
  <div id="copyOk" class="ok-msg">✓ Kopyalandı</div>
  <button id="btnDeactivate" class="btn-danger btn-sec">${t('deactivate')}</button>
  ` : ""}

  <div class="divider"></div>
  <div class="sec-label">📡 Anonim Veri Paylaşımı</div>
  <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:8px">
    Hata ve kullanım verileri (kod/prompt/key ASLA gönderilmez) toolu geliştirmemize yardım eder.
  </div>
  <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;margin-bottom:6px">
    <input type="checkbox" id="telemetryToggle" ${this.telemetryConsent === "granted" ? "checked" : ""} style="width:auto;margin:0" />
    Anonim veri paylaşımını etkinleştir
  </label>
  <div id="telemetryStatus" style="font-size:11px;color:${this.telemetryConsent === "granted" ? "#10b981" : "var(--vscode-descriptionForeground)"}">
    Durum: ${this.telemetryConsent === "granted" ? "✓ Etkin" : this.telemetryConsent === "denied" ? "Kapalı" : "Onay bekliyor"}
  </div>

  <div class="divider"></div>
  <div class="sec-label">${t('advanced')}</div>
  <button id="btnOpenConfig" class="btn-sec">${t('editConfig')}</button>
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
        ${t('proFeature5')}
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
  var agents = JSON.parse(atob('${agentsJson}'));
  var tasks = JSON.parse(atob('${tasksJson}'));
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

  // Dil değiştirme
  document.getElementById('langSelect').addEventListener('change', function(e) {
    vscode.postMessage({ command: 'changeLang', lang: e.target.value });
  });

  // Tab switching
  ['run','agents','tasks','stats','settings'].forEach(function(name) {
    var btn = document.getElementById('tab-' + name);
    if (btn) btn.addEventListener('click', function() {
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
      document.getElementById('tab-' + name).classList.add('active');
      document.getElementById('content-' + name).classList.add('active');
    });
  });

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

  // Stats temizle
  var btnClearStats = document.getElementById('btnClearStats');
  if (btnClearStats) btnClearStats.addEventListener('click', function() {
    vscode.postMessage({ command: 'clearStats' });
  });

  var btnRun = document.getElementById('btnRun');
  if (btnRun) btnRun.addEventListener('click', runTask);

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
    btnFixErrors.textContent = '⏳ Postacı hataları düzeltiyor...';
    vscode.postMessage({ command: 'fixErrors' });
  });

  var btnClear = document.getElementById('btnClear');
  if (btnClear) btnClear.addEventListener('click', function() {
    document.getElementById('result').textContent = i18n.noResult;
    document.getElementById('meta').style.display = 'none';
    document.getElementById('saveRow').style.display = 'none';
    lastResult = '';
  });

  var promptEl = document.getElementById('prompt');
  if (promptEl) promptEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runTask(); }
  });

  function runTask() {
    var prompt = document.getElementById('prompt').value.trim();
    if (!prompt) return;
    var applyEl = document.getElementById('applyFiles');
    var applyFiles = applyEl ? applyEl.checked : false;
    document.getElementById('result').innerHTML = '<span class="loading">⏳ ' + i18n.running + '</span>';
    document.getElementById('meta').style.display = 'none';
    document.getElementById('saveRow').style.display = 'none';
    vscode.postMessage({ command: 'agentTask', prompt: prompt, applyFiles: applyFiles });
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
    if (titleEl) titleEl.textContent = key ? '${t('agentEdit')}' : '${t('agentNew')}';
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
    if (confirm('"' + key + '" ' + i18n.agentDeleteConfirm)) {
      vscode.postMessage({ command: 'deleteAgent', key: key });
    }
  }

  function openTaskModal(key) {
    editingTaskKey = key;
    var titleEl = document.getElementById('taskModalTitle');
    if (titleEl) titleEl.textContent = key ? '${t('taskEdit')}' : '${t('taskNew')}';
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
    if (confirm('"' + key + '" ' + i18n.taskDeleteConfirm)) {
      vscode.postMessage({ command: 'deleteTask', key: key });
    }
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
        document.getElementById('result').innerHTML = '<span class="loading">⏳ ' + i18n.running + '</span>';
        break;
      case 'result':
        if (msg.data && msg.data.success) {
          lastResult = msg.data.content;
          document.getElementById('result').textContent = msg.data.content;
          document.getElementById('metaAgent').textContent = msg.data.usedAgent || '';
          document.getElementById('metaModel').textContent = msg.data.usedModel || '';
          document.getElementById('metaAttempts').textContent = (msg.data.attempts || []).join(' → ');
          if (msg.data.usage) {
            var u = msg.data.usage;
            document.getElementById('metaTokenCount').textContent = (u.totalTokens || 0).toLocaleString();
            document.getElementById('metaTokens').style.display = 'inline';
            if (msg.data.estimatedCost != null) {
              document.getElementById('metaCostVal').textContent = msg.data.estimatedCost.toFixed(4);
              document.getElementById('metaCost').style.display = 'inline';
            }
          }
          document.getElementById('meta').style.display = 'flex';
          document.getElementById('saveRow').style.display = 'flex';
        } else {
          document.getElementById('result').textContent = '❌ ' + ((msg.data && msg.data.error) || i18n.unknownError);
        }
        break;
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
        break;
      case 'licenseError':
        document.getElementById('licenseLoading').style.display = 'none';
        document.getElementById('btnActivate').disabled = false;
        showErr('licenseErr', msg.error || 'Error');
        break;
      case 'licenseDeactivated':
        break;
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
            fixBtn.textContent = '🛠 Hataları Düzelt (Postacı)';
            // Otomatik düzeltme açıksa Postacı'yı kendiliğinden tetikle
            var autoFixEl = document.getElementById('autoFix');
            if (autoFixEl && autoFixEl.checked) {
              fixBtn.disabled = true;
              fixBtn.textContent = '⏳ Postacı otomatik düzeltiyor...';
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
