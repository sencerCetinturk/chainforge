import * as vscode from "vscode";
import { AIRouter, ChainConfig } from "./router";
import { ConfigManager } from "./configManager";
import { AIChainPanel } from "./panel";
import { LicenseManager } from "./license";
import { Language } from "./i18n";

let router: AIRouter | null = null;
let configManager: ConfigManager | null = null;
let licenseManager: LicenseManager | null = null;

export async function activate(context: vscode.ExtensionContext) {
  configManager = new ConfigManager(context);
  licenseManager = new LicenseManager(context);

  let config = await configManager.loadConfig();
  if (config) router = new AIRouter(config);

  const isPro = await licenseManager.checkSavedLicense();

  // Dil ayarını oku
  const getLang = (): Language => {
    const lang = vscode.workspace.getConfiguration("chainforge").get<string>("language") || "en";
    return lang as Language;
  };

  const onSaveConfig = async (newConfig: ChainConfig) => {
    await configManager!.saveConfig(newConfig);
    if (!router) router = new AIRouter(newConfig);
    else router.updateConfig(newConfig);
  };

  const onActivateLicense = async (key: string): Promise<{ success: boolean; error?: string }> => {
    const result = await licenseManager!.activateLicense(key);
    return { success: result.valid, error: result.error };
  };

  const onDeactivateLicense = async () => {
    await licenseManager!.deactivateLicense();
  };

  const openPanel = vscode.commands.registerCommand("chainforge.openPanel", async () => {
    const currentConfig = await configManager!.loadConfig();
    const currentIsPro = await licenseManager!.isPro();
    const currentLang = getLang();

    if (currentConfig && router) router.updateConfig(currentConfig);

    AIChainPanel.createOrShow(
      context.extensionUri,
      currentConfig,
      async (prompt, taskType) => {
        if (!router) return { success: false, error: "Router not initialized", content: "", usedAgent: "", usedModel: "", attempts: [] };
        return await router.run(prompt, taskType);
      },
      () => configManager!.openConfigFile(),
      async (key) => {
        await vscode.workspace.getConfiguration("chainforge").update("openRouterKey", key, vscode.ConfigurationTarget.Global);
      },
      onSaveConfig,
      onActivateLicense,
      onDeactivateLicense,
      currentIsPro,
      currentLang
    );
  });

  const runTask = vscode.commands.registerCommand("chainforge.runTask", async () => {
    if (!router) { vscode.window.showErrorMessage("ChainForge: Configure first."); return; }
    const config = await configManager!.loadConfig();
    if (!config) return;

    const taskTypes = Object.entries(config.tasks).map(([key, task]) => ({
      label: task.description || key, value: key
    }));
    const selected = await vscode.window.showQuickPick(taskTypes.map(t => t.label), { placeHolder: "Select task type" });
    if (!selected) return;

    const taskKey = taskTypes.find(t => t.label === selected)?.value || "general";
    const editor = vscode.window.activeTextEditor;
    const selectedText = editor?.document.getText(editor.selection);
    const prompt = await vscode.window.showInputBox({ prompt: "Enter your prompt", value: selectedText || "" });
    if (!prompt) return;

    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ChainForge running..." },
      async () => {
        const result = await router!.run(prompt, taskKey);
        if (result.success) {
          const doc = await vscode.workspace.openTextDocument({ content: result.content, language: "markdown" });
          vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        } else {
          vscode.window.showErrorMessage(`ChainForge Error: ${result.error}`);
        }
      }
    );
  });

  const configure = vscode.commands.registerCommand("chainforge.configure", async () => {
    await configManager!.openConfigFile();
  });

  const openUrl = vscode.commands.registerCommand("chainforge.openUrl", async (url: string) => {
    const allowed = ["openrouter.ai", "dodopayments.com", "test.checkout.dodopayments.com", "dodo.pe"];
    try {
      const u = new URL(url);
      if (allowed.some(d => u.hostname === d || u.hostname.endsWith("." + d))) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    } catch {}
  });

  context.subscriptions.push(openPanel, runTask, configure, openUrl);

  vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (e.affectsConfiguration("chainforge")) {
      const newConfig = await configManager!.loadConfig();
      if (newConfig) {
        if (!router) router = new AIRouter(newConfig);
        else router.updateConfig(newConfig);
      }
    }
  });
}

export function deactivate() {}
