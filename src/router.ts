import * as https from "https";
import { validateModel, validateAgentKey } from "./validator";

// Native HTTPS POST — axios bağımlılığını kaldırır (VSIX paketleme sorunu çözümü)
function httpsPostJson(
  url: string,
  body: object,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const options: https.RequestOptions = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        const status = res.statusCode || 0;
        let data: any = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
        if (status >= 400) {
          // axios benzeri hata objesi — mevcut error handling status'a bakıyor
          const err: any = new Error(data?.error?.message || data?.message || `HTTP ${status}`);
          err.response = { status, data };
          reject(err);
        } else {
          resolve({ status, data });
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("İstek zaman aşımına uğradı")); });
    req.write(payload);
    req.end();
  });
}

export interface AgentConfig {
  name: string;
  model: string;
  role: string;
  fallback?: string;
  maxRetries?: number;
  systemPrompt?: string;
}

export interface ChainConfig {
  version: string;
  openRouterKey: string;
  agents: { [key: string]: AgentConfig };
  tasks: {
    [taskType: string]: {
      primary: string;
      description: string;
    };
  };
}

export interface RouterResult {
  success: boolean;
  content: string;
  usedAgent: string;
  usedModel: string;
  attempts: string[];
  error?: string;
}

export class AIRouter {
  private config: ChainConfig;
  private readonly OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
  private readonly MAX_CHAIN_DEPTH = 10; // Sonsuz döngü koruması

  constructor(config: ChainConfig) {
    this.config = config;
  }

  async run(prompt: string, taskType: string): Promise<RouterResult> {
    // Prompt güvenlik kontrolü
    if (!prompt || prompt.trim() === "") {
      return this.errorResult([], "Prompt boş olamaz");
    }
    if (prompt.length > 50000) {
      return this.errorResult([], "Prompt çok uzun (max 50000 karakter)");
    }

    const task = this.config.tasks[taskType];
    if (!task) {
      return this.errorResult([], `Bilinmeyen görev tipi: ${taskType}`);
    }

    const attempts: string[] = [];
    let currentAgentKey = task.primary;
    let depth = 0;

    while (currentAgentKey && depth < this.MAX_CHAIN_DEPTH) {
      depth++;

      // Key doğrula
      const keyCheck = validateAgentKey(currentAgentKey);
      if (!keyCheck.valid) break;

      const agent = this.config.agents[currentAgentKey];
      if (!agent) break;

      // Model doğrula
      const modelCheck = validateModel(agent.model);
      if (!modelCheck.valid) {
        attempts.push(currentAgentKey);
        if (agent.fallback) { currentAgentKey = agent.fallback; continue; }
        return this.errorResult(attempts, `Geçersiz model: ${agent.model}`);
      }

      attempts.push(currentAgentKey);
      const maxRetries = Math.min(Math.max(agent.maxRetries || 1, 1), 5);

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const content = await this.callModel(agent, prompt);
          return { success: true, content, usedAgent: currentAgentKey, usedModel: agent.model, attempts };
        } catch (err: any) {
          const status = err?.response?.status;
          const isRateLimit = status === 429;
          const isQuota = status === 402 || err?.message?.includes("quota") || err?.message?.includes("insufficient");
          const isAuth = status === 401 || status === 403;

          // Auth hatası — fallback'e geç, denemeden vazgeç
          if (isAuth) {
            if (agent.fallback) { currentAgentKey = agent.fallback; break; }
            return this.errorResult(attempts, "API key geçersiz veya yetkisiz");
          }

          // Quota/rate limit — fallback'e geç
          if (isRateLimit || isQuota) {
            if (agent.fallback) { currentAgentKey = agent.fallback; break; }
            return this.errorResult(attempts, "Token limiti doldu ve fallback yok");
          }

          // Son deneme ve fallback var
          if (attempt === maxRetries - 1) {
            if (agent.fallback) { currentAgentKey = agent.fallback; break; }
            return this.errorResult(attempts, err?.message || "Bilinmeyen hata");
          }

          // Tekrar dene (kısa bekleme)
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    if (depth >= this.MAX_CHAIN_DEPTH) {
      return this.errorResult(attempts, "Maksimum fallback derinliğine ulaşıldı");
    }

    return this.errorResult(attempts, "Tüm fallback zinciri tükendi");
  }

  private async callModel(agent: AgentConfig, prompt: string): Promise<string> {
    const messages: any[] = [];
    if (agent.systemPrompt && agent.systemPrompt.trim()) {
      messages.push({ role: "system", content: agent.systemPrompt.trim() });
    }
    messages.push({ role: "user", content: prompt });

    const response = await httpsPostJson(
      this.OPENROUTER_URL,
      { model: agent.model, messages, max_tokens: 4096 },
      {
        Authorization: `Bearer ${this.config.openRouterKey}`,
        "HTTP-Referer": "https://github.com/sencerCetinturk/chainforge",
        "X-Title": "ChainForge VSCode Extension",
      },
      120000
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Model boş yanıt döndürdü");
    return content;
  }

  private errorResult(attempts: string[], error: string): RouterResult {
    return { success: false, content: "", usedAgent: "", usedModel: "", attempts, error };
  }

  updateConfig(config: ChainConfig) {
    this.config = config;
  }
}
