"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIRouter = void 0;
const axios_1 = require("axios");
const validator_1 = require("./validator");
class AIRouter {
    constructor(config) {
        this.OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
        this.MAX_CHAIN_DEPTH = 10; // Sonsuz döngü koruması
        this.config = config;
    }
    async run(prompt, taskType) {
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
        const attempts = [];
        let currentAgentKey = task.primary;
        let depth = 0;
        while (currentAgentKey && depth < this.MAX_CHAIN_DEPTH) {
            depth++;
            // Key doğrula
            const keyCheck = (0, validator_1.validateAgentKey)(currentAgentKey);
            if (!keyCheck.valid)
                break;
            const agent = this.config.agents[currentAgentKey];
            if (!agent)
                break;
            // Model doğrula
            const modelCheck = (0, validator_1.validateModel)(agent.model);
            if (!modelCheck.valid) {
                attempts.push(currentAgentKey);
                if (agent.fallback) {
                    currentAgentKey = agent.fallback;
                    continue;
                }
                return this.errorResult(attempts, `Geçersiz model: ${agent.model}`);
            }
            attempts.push(currentAgentKey);
            const maxRetries = Math.min(Math.max(agent.maxRetries || 1, 1), 5);
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    const content = await this.callModel(agent, prompt);
                    return { success: true, content, usedAgent: currentAgentKey, usedModel: agent.model, attempts };
                }
                catch (err) {
                    const status = err?.response?.status;
                    const isRateLimit = status === 429;
                    const isQuota = status === 402 || err?.message?.includes("quota") || err?.message?.includes("insufficient");
                    const isAuth = status === 401 || status === 403;
                    // Auth hatası — fallback'e geç, denemeden vazgeç
                    if (isAuth) {
                        if (agent.fallback) {
                            currentAgentKey = agent.fallback;
                            break;
                        }
                        return this.errorResult(attempts, "API key geçersiz veya yetkisiz");
                    }
                    // Quota/rate limit — fallback'e geç
                    if (isRateLimit || isQuota) {
                        if (agent.fallback) {
                            currentAgentKey = agent.fallback;
                            break;
                        }
                        return this.errorResult(attempts, "Token limiti doldu ve fallback yok");
                    }
                    // Son deneme ve fallback var
                    if (attempt === maxRetries - 1) {
                        if (agent.fallback) {
                            currentAgentKey = agent.fallback;
                            break;
                        }
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
    async callModel(agent, prompt) {
        const messages = [];
        if (agent.systemPrompt && agent.systemPrompt.trim()) {
            messages.push({ role: "system", content: agent.systemPrompt.trim() });
        }
        messages.push({ role: "user", content: prompt });
        const response = await axios_1.default.post(this.OPENROUTER_URL, { model: agent.model, messages, max_tokens: 4096 }, {
            headers: {
                Authorization: `Bearer ${this.config.openRouterKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/sencerCetinturk/ai-chain",
                "X-Title": "AI Chain VSCode Extension",
            },
            timeout: 120000,
        });
        const content = response.data?.choices?.[0]?.message?.content;
        if (!content)
            throw new Error("Model boş yanıt döndürdü");
        return content;
    }
    errorResult(attempts, error) {
        return { success: false, content: "", usedAgent: "", usedModel: "", attempts, error };
    }
    updateConfig(config) {
        this.config = config;
    }
}
exports.AIRouter = AIRouter;
//# sourceMappingURL=router.js.map