"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const router_1 = require("./router");
const configManager_1 = require("./configManager");
const panel_1 = require("./panel");
const license_1 = require("./license");
class ChainForgeViewProvider {
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        const openItem = new vscode.TreeItem("⛓ Open ChainForge Panel");
        openItem.command = {
            command: "chainforge.openPanel",
            title: "Open ChainForge Panel"
        };
        openItem.tooltip = "Click to open ChainForge";
        return [openItem];
    }
}
let router = null;
let configManager = null;
let licenseManager = null;
async function activate(context) {
    configManager = new configManager_1.ConfigManager(context);
    licenseManager = new license_1.LicenseManager(context);
    const getLang = () => {
        const lang = vscode.workspace.getConfiguration("chainforge").get("language") || "en";
        return lang;
    };
    const onSaveConfig = async (newConfig) => {
        await configManager.saveConfig(newConfig);
        if (!router)
            router = new router_1.AIRouter(newConfig);
        else
            router.updateConfig(newConfig);
    };
    const onActivateLicense = async (key) => {
        const result = await licenseManager.activateLicense(key);
        return { success: result.valid, error: result.error };
    };
    const onDeactivateLicense = async () => {
        await licenseManager.deactivateLicense();
    };
    // Komutları HEMEN kaydet — async beklemeden
    const openPanel = vscode.commands.registerCommand("chainforge.openPanel", async () => {
        const currentConfig = await configManager.loadConfig();
        const currentIsPro = await licenseManager.isPro();
        const currentLang = getLang();
        if (currentConfig && router)
            router.updateConfig(currentConfig);
        panel_1.AIChainPanel.createOrShow(context.extensionUri, currentConfig, async (prompt, taskType) => {
            if (!router)
                return { success: false, error: "Router not initialized", content: "", usedAgent: "", usedModel: "", attempts: [] };
            return await router.run(prompt, taskType);
        }, () => configManager.openConfigFile(), async (key) => {
            await vscode.workspace.getConfiguration("chainforge").update("openRouterKey", key, vscode.ConfigurationTarget.Global);
        }, onSaveConfig, onActivateLicense, onDeactivateLicense, currentIsPro, currentLang, licenseManager.getSavedKey());
    });
    const runTask = vscode.commands.registerCommand("chainforge.runTask", async () => {
        if (!router) {
            vscode.window.showErrorMessage("ChainForge: Configure first.");
            return;
        }
        const config = await configManager.loadConfig();
        if (!config)
            return;
        const taskTypes = Object.entries(config.tasks).map(([key, task]) => ({
            label: task.description || key, value: key
        }));
        const selected = await vscode.window.showQuickPick(taskTypes.map(t => t.label), { placeHolder: "Select task type" });
        if (!selected)
            return;
        const taskKey = taskTypes.find(t => t.label === selected)?.value || "general";
        const editor = vscode.window.activeTextEditor;
        const selectedText = editor?.document.getText(editor.selection);
        const prompt = await vscode.window.showInputBox({ prompt: "Enter your prompt", value: selectedText || "" });
        if (!prompt)
            return;
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "ChainForge running..." }, async () => {
            const result = await router.run(prompt, taskKey);
            if (result.success) {
                const doc = await vscode.workspace.openTextDocument({ content: result.content, language: "markdown" });
                vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            }
            else {
                vscode.window.showErrorMessage(`ChainForge Error: ${result.error}`);
            }
        });
    });
    const configure = vscode.commands.registerCommand("chainforge.configure", async () => {
        await configManager.openConfigFile();
    });
    const openUrl = vscode.commands.registerCommand("chainforge.openUrl", async (url) => {
        const allowed = ["openrouter.ai", "dodopayments.com", "test.checkout.dodopayments.com", "dodo.pe"];
        try {
            const u = new URL(url);
            if (allowed.some(d => u.hostname === d || u.hostname.endsWith("." + d))) {
                await vscode.env.openExternal(vscode.Uri.parse(url));
            }
        }
        catch { }
    });
    // TreeView kaydet
    const viewProvider = new ChainForgeViewProvider();
    context.subscriptions.push(openPanel, runTask, configure, openUrl, vscode.window.registerTreeDataProvider("chainforgeView", viewProvider));
    // Async başlatma — komutlar zaten kayıtlı, bu beklenebilir
    configManager.loadConfig().then(config => {
        if (config)
            router = new router_1.AIRouter(config);
    });
    licenseManager.checkSavedLicense();
    vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration("chainforge")) {
            const newConfig = await configManager.loadConfig();
            if (newConfig) {
                if (!router)
                    router = new router_1.AIRouter(newConfig);
                else
                    router.updateConfig(newConfig);
            }
        }
    });
}
function deactivate() { }
//# sourceMappingURL=extension.js.map