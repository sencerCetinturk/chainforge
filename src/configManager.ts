import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ChainConfig } from "./router";
import {
  validateAgentKey, validateAgentName, validateModel, validateRole,
  validateMaxRetries, validateSystemPrompt, validateTaskKey,
  validateTaskDescription, validateFallback
} from "./validator";

const DEFAULT_CONFIG: ChainConfig = {
  version: "1.0",
  openRouterKey: "",
  agents: {
    worker: {
      name: "AI Worker",
      model: "minimax/minimax-m3",
      role: "coding",
      fallback: "fallback",
      maxRetries: 3,
      systemPrompt: "You are an expert software developer. Write clean, efficient, well-documented code."
    },
    fallback: {
      name: "Fallback",
      model: "google/gemini-flash-1-5",
      role: "fallback",
      fallback: "supervisor",
      maxRetries: 2,
    },
    supervisor: {
      name: "Supervisor",
      model: "anthropic/claude-sonnet-4-5",
      role: "supervisor",
      maxRetries: 1,
      systemPrompt: "You are a senior software architect. Review and improve code quality."
    },
  },
  tasks: {
    coding: { primary: "worker", description: "Code writing, editing, refactor" },
    review: { primary: "supervisor", description: "Code review, architecture" },
    general: { primary: "worker", description: "General questions" },
  }
};

export class ConfigManager {
  constructor(private context: vscode.ExtensionContext) {}

  getConfigPath(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders?.length) {
      return path.join(workspaceFolders[0].uri.fsPath, ".aichain.json");
    }
    const globalDir = this.context.globalStorageUri.fsPath;
    if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });
    return path.join(globalDir, "config.json");
  }

  async loadConfig(): Promise<ChainConfig> {
    try {
      const configPath = this.getConfigPath();
      if (!fs.existsSync(configPath)) {
        await this.saveConfig(DEFAULT_CONFIG);
        return { ...DEFAULT_CONFIG };
      }
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw);
      const config = this.mergeWithDefaults(parsed);
      // API key VSCode settings'den al (güvenli)
      const settings = vscode.workspace.getConfiguration("aichain");
      config.openRouterKey = settings.get("openRouterKey") || "";
      return config;
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  async saveConfig(config: ChainConfig): Promise<void> {
    try {
      const configPath = this.getConfigPath();
      const toSave = { ...config, openRouterKey: "" }; // Key asla dosyaya yazılmaz
      fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), "utf8");
    } catch (err) {
      vscode.window.showErrorMessage(`AI Chain: Config kaydedilemedi: ${err}`);
    }
  }

  // Kullanıcıdan gelen agent verisini doğrula ve ekle
  validateAndAddAgent(config: ChainConfig, data: any, isEdit: boolean): { success: boolean; error?: string; config?: ChainConfig } {
    const checks = [
      validateAgentKey(data.key),
      validateAgentName(data.name),
      validateModel(data.model),
      validateRole(data.role),
      validateSystemPrompt(data.systemPrompt || ""),
      validateFallback(data.fallback || "", config.agents, data.key),
    ];

    const failed = checks.find(c => !c.valid);
    if (failed) return { success: false, error: failed.error };

    const retriesCheck = validateMaxRetries(parseInt(data.maxRetries) || 2);
    if (!retriesCheck.valid) return { success: false, error: retriesCheck.error };

    if (!isEdit && config.agents[data.key]) {
      return { success: false, error: `'${data.key}' key'i zaten mevcut` };
    }

    const newConfig = { ...config };
    newConfig.agents = { ...config.agents };
    newConfig.agents[data.key] = {
      name: data.name.trim(),
      model: data.model.trim().toLowerCase(),
      role: data.role,
      fallback: data.fallback || undefined,
      maxRetries: Math.min(Math.max(parseInt(data.maxRetries) || 2, 1), 5),
      systemPrompt: data.systemPrompt?.trim() || undefined,
    };

    return { success: true, config: newConfig };
  }

  // Kullanıcıdan gelen görev verisini doğrula ve ekle
  validateAndAddTask(config: ChainConfig, data: any, isEdit: boolean): { success: boolean; error?: string; config?: ChainConfig } {
    const keyCheck = validateTaskKey(data.key);
    if (!keyCheck.valid) return { success: false, error: keyCheck.error };

    const descCheck = validateTaskDescription(data.description);
    if (!descCheck.valid) return { success: false, error: descCheck.error };

    if (!config.agents[data.primary]) {
      return { success: false, error: `Agent bulunamadı: ${data.primary}` };
    }

    if (!isEdit && config.tasks[data.key]) {
      return { success: false, error: `'${data.key}' görevi zaten mevcut` };
    }

    const newConfig = { ...config };
    newConfig.tasks = { ...config.tasks };
    newConfig.tasks[data.key] = {
      primary: data.primary,
      description: data.description.trim(),
    };

    return { success: true, config: newConfig };
  }

  deleteAgent(config: ChainConfig, key: string): { success: boolean; error?: string; config?: ChainConfig } {
    const keyCheck = validateAgentKey(key);
    if (!keyCheck.valid) return { success: false, error: "Geçersiz key" };
    if (!config.agents[key]) return { success: false, error: "Agent bulunamadı" };

    // Bu agent'a bağımlı başka agent var mı?
    const dependents = Object.entries(config.agents)
      .filter(([k, a]) => a.fallback === key && k !== key)
      .map(([k]) => k);
    if (dependents.length > 0) {
      return { success: false, error: `Bu agent şu agent'ların fallback'i: ${dependents.join(", ")}. Önce onları güncelleyin.` };
    }

    const newConfig = { ...config };
    newConfig.agents = { ...config.agents };
    delete newConfig.agents[key];
    return { success: true, config: newConfig };
  }

  deleteTask(config: ChainConfig, key: string): { success: boolean; error?: string; config?: ChainConfig } {
    const keyCheck = validateTaskKey(key);
    if (!keyCheck.valid) return { success: false, error: "Geçersiz key" };
    if (!config.tasks[key]) return { success: false, error: "Görev bulunamadı" };

    const newConfig = { ...config };
    newConfig.tasks = { ...config.tasks };
    delete newConfig.tasks[key];
    return { success: true, config: newConfig };
  }

  private mergeWithDefaults(parsed: any): ChainConfig {
    return {
      version: parsed.version || "1.0",
      openRouterKey: "",
      agents: parsed.agents || {},
      tasks: parsed.tasks || {},
    };
  }

  async openConfigFile() {
    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) await this.saveConfig(DEFAULT_CONFIG);
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);
  }
}
