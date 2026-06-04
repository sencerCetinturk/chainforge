"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIRouter = void 0;
const https = require("https");
const validator_1 = require("./validator");
// Native HTTPS POST — axios bağımlılığını kaldırır (VSIX paketleme sorunu çözümü)
function httpsPostJson(url, body, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const payload = JSON.stringify(body);
        const options = {
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
                let data = null;
                try {
                    data = raw ? JSON.parse(raw) : null;
                }
                catch {
                    data = raw;
                }
                if (status >= 400) {
                    // axios benzeri hata objesi — mevcut error handling status'a bakıyor
                    const err = new Error(data?.error?.message || data?.message || `HTTP ${status}`);
                    err.response = { status, data };
                    reject(err);
                }
                else {
                    resolve({ status, data });
                }
            });
        });
        req.on("error", (e) => {
            // DNS/bağlantı hatalarını anlaşılır mesaja çevir
            if (e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN") {
                const err = new Error("openrouter.ai adresine ulaşılamıyor. İnternet/VPN bağlantınızı kontrol edin (Türkiye'den erişim için VPN gerekebilir).");
                err.code = e.code;
                reject(err);
            }
            else if (e?.code === "ECONNRESET" || e?.code === "ETIMEDOUT") {
                const err = new Error("Bağlantı kesildi. Tekrar deneyin.");
                err.code = e.code;
                reject(err);
            }
            else {
                reject(e);
            }
        });
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("İstek zaman aşımına uğradı")); });
        req.write(payload);
        req.end();
    });
}
class AIRouter {
    constructor(config) {
        this.OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
        this.MAX_CHAIN_DEPTH = 10; // Sonsuz döngü koruması
        this.config = config;
    }
    // Token takibi için kanca bağla (extension → SpendingManager)
    setUsageSink(fn) {
        this.usageSink = fn;
    }
    // Config'e dışarıdan erişim (Postacı için)
    getConfig() {
        return this.config;
    }
    // Postacı için: belirli bir modeli doğrudan çağır (agent config gerekmez)
    async callDirect(model, systemPrompt, userPrompt, online = false) {
        try {
            const agent = { name: "direct", model, role: "custom", systemPrompt };
            const res = await this.callModel(agent, userPrompt, online);
            return { success: true, content: res.content, usage: res.usage };
        }
        catch (err) {
            return { success: false, content: "", error: err?.message || "Bilinmeyen hata" };
        }
    }
    // Belirli bir agent rolüne sahip ilk agent'ı bul (Postacı için)
    findAgentByRole(role) {
        for (const [key, agent] of Object.entries(this.config.agents)) {
            if (agent.role === role)
                return key;
        }
        return null;
    }
    async run(prompt, taskType) {
        const task = this.config.tasks[taskType];
        if (!task) {
            return this.errorResult([], `Bilinmeyen görev tipi: ${taskType}`);
        }
        return this.runFromAgent(task.primary, prompt);
    }
    // Belirli bir agent'tan başlayarak fallback zinciriyle çalıştır (Postacı doğrudan çağırır)
    async runFromAgent(startAgentKey, prompt, onlineSearch = false) {
        // Prompt güvenlik kontrolü
        if (!prompt || prompt.trim() === "") {
            return this.errorResult([], "Prompt boş olamaz");
        }
        if (prompt.length > 200000) {
            return this.errorResult([], "Prompt çok uzun (max 200000 karakter)");
        }
        const attempts = [];
        const visited = new Set(); // Fallback döngüsü koruması
        let currentAgentKey = startAgentKey;
        let depth = 0;
        let lastError = "";
        while (currentAgentKey && depth < this.MAX_CHAIN_DEPTH) {
            depth++;
            // DÖNGÜ KORUMASI: bu agent zaten denendiyse zincir kendine dönüyor demektir
            if (visited.has(currentAgentKey)) {
                return this.errorResult(attempts, `Fallback döngüsü: "${currentAgentKey}" tekrar geldi. Son hata: ${lastError || "bilinmiyor"}`);
            }
            visited.add(currentAgentKey);
            // Key doğrula
            const keyCheck = (0, validator_1.validateAgentKey)(currentAgentKey);
            if (!keyCheck.valid)
                break;
            const agent = this.config.agents[currentAgentKey];
            if (!agent) {
                return this.errorResult(attempts, `Agent bulunamadı: "${currentAgentKey}". Fallback yanlış olabilir.`);
            }
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
                    const result = await this.callModel(agent, prompt, onlineSearch);
                    return { success: true, content: result.content, usedAgent: currentAgentKey, usedModel: agent.model, attempts, usage: result.usage };
                }
                catch (err) {
                    const status = err?.response?.status;
                    const msg = (err?.message || "").toLowerCase();
                    const dataMsg = (JSON.stringify(err?.response?.data || "")).toLowerCase();
                    const combined = msg + " " + dataMsg;
                    lastError = `${agent.model}: ${err?.message || "hata"}`;
                    const isAuth = status === 401 || status === 403;
                    // Quota/rate limit'i HEM status koduyla HEM mesaj içeriğiyle yakala
                    // (minimax gibi modeller 429 yerine metin mesajı dönebiliyor)
                    const isQuota = status === 402 || status === 429 ||
                        /quota|insufficient|rate.?limit|rate limit|exceeded|too many|capacity|overloaded|token.{0,20}(limit|exceed|doldu)|limit.{0,20}(reach|exceed|doldu)|credits?/.test(combined);
                    // Auth veya quota/limit → DENEMEDEN fallback'e geç
                    if (isAuth || isQuota) {
                        const reason = isAuth ? "yetki hatası" : "token/limit doldu";
                        if (agent.fallback) {
                            currentAgentKey = agent.fallback;
                            break;
                        }
                        return this.errorResult(attempts, `"${agent.name || currentAgentKey}" ${reason} ve yedek (fallback) tanımlı değil. Agentler bölümünden bu agent'a fallback ekleyin.`);
                    }
                    // Son deneme ve fallback var → fallback'e geç
                    if (attempt === maxRetries - 1) {
                        if (agent.fallback) {
                            currentAgentKey = agent.fallback;
                            break;
                        }
                        return this.errorResult(attempts, lastError);
                    }
                    // Tekrar dene (kısa bekleme)
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                }
            }
        }
        if (depth >= this.MAX_CHAIN_DEPTH) {
            return this.errorResult(attempts, `Çok uzun fallback zinciri. Denenen: ${attempts.join(" → ")}. Son hata: ${lastError}`);
        }
        return this.errorResult(attempts, lastError || "Tüm fallback zinciri tükendi");
    }
    async callModel(agent, prompt, onlineSearch = false) {
        const messages = [];
        if (agent.systemPrompt && agent.systemPrompt.trim()) {
            messages.push({ role: "system", content: agent.systemPrompt.trim() });
        }
        messages.push({ role: "user", content: prompt });
        const modelName = onlineSearch && !agent.model.includes(":online")
            ? agent.model + ":online"
            : agent.model;
        // Agent'ın kendi API key'i varsa → direkt provider'a çağrı (OpenRouter değil)
        if (agent.apiKey) {
            return this.callProviderDirect(agent, modelName, messages);
        }
        // Yoksa normal OpenRouter çağrısı
        const response = await httpsPostJson(this.OPENROUTER_URL, { model: modelName, messages, max_tokens: 8192 }, {
            Authorization: `Bearer ${this.config.openRouterKey}`,
            "HTTP-Referer": "https://github.com/sencerCetinturk/chainforge",
            "X-Title": "ChainForge VSCode Extension",
        }, 120000);
        const content = response.data?.choices?.[0]?.message?.content;
        if (!content)
            throw new Error("Model boş yanıt döndürdü");
        const u = response.data?.usage;
        const usage = u ? {
            promptTokens: u.prompt_tokens || 0,
            completionTokens: u.completion_tokens || 0,
            totalTokens: u.total_tokens || 0,
        } : undefined;
        if (usage)
            this.usageSink?.(agent.model, usage);
        return { content, usage };
    }
    // Agent'ın kendi API key'i ile direkt provider çağrısı (OpenAI uyumlu endpoint)
    async callProviderDirect(agent, modelName, messages) {
        // Varsayılan endpoint OpenAI formatı
        const endpoint = agent.apiEndpoint || "https://api.openai.com/v1/chat/completions";
        const response = await httpsPostJson(endpoint, { model: modelName, messages, max_tokens: 8192 }, {
            Authorization: `Bearer ${agent.apiKey}`,
        }, 120000);
        const content = response.data?.choices?.[0]?.message?.content;
        if (!content)
            throw new Error("Model boş yanıt döndürdü");
        const u = response.data?.usage;
        const usage = u ? {
            promptTokens: u.prompt_tokens || 0,
            completionTokens: u.completion_tokens || 0,
            totalTokens: u.total_tokens || 0,
        } : undefined;
        if (usage)
            this.usageSink?.(modelName, usage);
        return { content, usage };
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