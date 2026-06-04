"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIRouter = void 0;
const https = require("https");
const validator_1 = require("./validator");
// Native HTTPS POST — axios bağımlılığını kaldırır (VSIX paketleme sorunu çözümü)
function httpsPostJson(url, body, headers, timeoutMs, signal) {
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
        if (signal?.aborted) {
            reject(new Error("İptal edildi"));
            return;
        }
        const req = https.request(options, (res) => {
            // Chunk'ları Buffer olarak topla — UTF-8 çok-byte karakterler (ş,ü,ğ) chunk
            // sınırında bölünürse bozulmasın diye en sonda BİR KEZ decode ediyoruz.
            const chunks = [];
            res.on("data", (chunk) => { chunks.push(chunk); });
            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
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
        // İptal: kullanıcı işi keserse isteği kapat
        if (signal)
            signal.addEventListener("abort", () => { try {
                req.destroy();
            }
            catch { } reject(new Error("İptal edildi")); }, { once: true });
        req.write(payload);
        req.end();
    });
}
class AIRouter {
    constructor(config) {
        this.OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
        this.MAX_CHAIN_DEPTH = 10; // Sonsuz döngü koruması
        this.isPro = true; // Pro değilse yalnızca ilk 3 agent aktif
        this.languageHint = "en"; // Seçili dil (AI yanıt dili için)
        this.config = config;
    }
    // AI yanıt dilini ayarla
    setLanguageHint(lang) {
        this.languageHint = lang;
    }
    getLangInstruction() {
        switch (this.languageHint) {
            case "tr": return "\n\n[Lütfen Türkçe yanıt ver.]";
            case "de": return "\n\n[Bitte antworte auf Deutsch.]";
            case "fr": return "\n\n[Réponds en français.]";
            case "es": return "\n\n[Responde en español.]";
            case "ja": return "\n\n[日本語で回答してください。]";
            case "zh": return "\n\n[请用中文回答。]";
            default: return "\n\n[Respond in English.]";
        }
    }
    // Pro durumunu ayarla — free ise ilk 3 dışındaki agent'lar devre dışı sayılır
    setProStatus(pro) {
        this.isPro = pro;
    }
    // Şu an kullanılabilir agent anahtarları (free ise ilk 3)
    allowedAgentKeys() {
        const keys = Object.keys(this.config.agents);
        return this.isPro ? keys : keys.slice(0, AIRouter.FREE_AGENT_LIMIT);
    }
    // Bir agent free planda devre dışı mı?
    isAgentDisabled(key) {
        return !this.allowedAgentKeys().includes(key);
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
    async callDirect(model, systemPrompt, userPrompt, online = false, signal) {
        try {
            const agent = { name: "direct", model, role: "custom", systemPrompt };
            const res = await this.callModel(agent, userPrompt, online, undefined, 4096, signal);
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
    // history verilirse sohbet hafızası olarak kullanılır
    async runFromAgent(startAgentKey, prompt, onlineSearch = false, history) {
        // Prompt güvenlik kontrolü (history modunda prompt boş olabilir)
        if ((!prompt || prompt.trim() === "") && (!history || history.length === 0)) {
            return this.errorResult([], "Prompt boş olamaz");
        }
        if (prompt.length > 200000) {
            return this.errorResult([], "Prompt çok uzun (max 200000 karakter)");
        }
        // Free planda ilk 3 dışındaki agent devre dışı
        if (this.isAgentDisabled(startAgentKey)) {
            return this.errorResult([], `Bu agent ücretsiz planda devre dışı (yalnızca ilk 3 agent kullanılabilir). Pro'ya geçin veya başka agent seçin.`);
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
            let curMaxTokens = 4096; // kredi yetersizse düşürülür
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    const result = await this.callModel(agent, prompt, onlineSearch, history, curMaxTokens);
                    return { success: true, content: result.content, usedAgent: currentAgentKey, usedModel: agent.model, attempts, usage: result.usage };
                }
                catch (err) {
                    const status = err?.response?.status;
                    const msg = (err?.message || "").toLowerCase();
                    const dataMsg = (JSON.stringify(err?.response?.data || "")).toLowerCase();
                    const combined = msg + " " + dataMsg;
                    // AKILLI: "can only afford X tokens" → max_tokens'ı X'e düşür, AYNI modeli tekrar dene
                    const afford = combined.match(/afford (\d+)/);
                    if (afford && parseInt(afford[1]) > 200 && curMaxTokens > parseInt(afford[1])) {
                        curMaxTokens = parseInt(afford[1]) - 50;
                        attempt--; // bu denemeyi boşa sayma
                        continue;
                    }
                    lastError = `${agent.model}: ${err?.message || "hata"}`;
                    const isAuth = status === 401 || status === 403;
                    // Quota/rate limit
                    const isQuota = status === 402 || status === 429 ||
                        /quota|insufficient|rate.?limit|rate limit|exceeded|too many|capacity|overloaded|token.{0,20}(limit|exceed|doldu)|limit.{0,20}(reach|exceed|doldu)|credits?/.test(combined);
                    // Provider/server hatası (5xx, "provider returned error") — retry boşa zaman, hemen geç
                    const isProviderError = (status && status >= 500) ||
                        /provider returned error|no endpoints|not a valid model|model.*(unavailable|not found)|bad gateway|service unavailable/.test(combined);
                    // Auth / quota / provider hatası → DENEMEDEN (retry'sız) hemen fallback'e geç
                    if (isAuth || isQuota || isProviderError) {
                        if (agent.fallback) {
                            currentAgentKey = agent.fallback;
                            break;
                        }
                        const reason = isAuth ? "yetki hatası" : isQuota ? "token/limit doldu" : "model şu an yanıt vermiyor";
                        return this.errorResult(attempts, `"${agent.name || currentAgentKey}" ${reason} ve yedek tanımlı değil.`);
                    }
                    // Son deneme ve fallback var → fallback'e geç
                    if (attempt === maxRetries - 1) {
                        if (agent.fallback) {
                            currentAgentKey = agent.fallback;
                            break;
                        }
                        return this.errorResult(attempts, lastError);
                    }
                    // Geçici hata — kısa bekleyip tekrar dene (eski 1-3sn yerine 0.4-1.2sn)
                    await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                }
            }
        }
        if (depth >= this.MAX_CHAIN_DEPTH) {
            return this.errorResult(attempts, `Çok uzun fallback zinciri. Denenen: ${attempts.join(" → ")}. Son hata: ${lastError}`);
        }
        return this.errorResult(attempts, lastError || "Tüm fallback zinciri tükendi");
    }
    async callModel(agent, prompt, onlineSearch = false, history, maxTokens = 4096, signal) {
        const messages = [];
        if (agent.systemPrompt && agent.systemPrompt.trim()) {
            messages.push({ role: "system", content: agent.systemPrompt.trim() });
        }
        // Sohbet geçmişi varsa onu kullan (hafıza), yoksa tek prompt
        // Yalnızca user/assistant rolleri — UI notları (info vb.) API'leri bozar
        const cleanHistory = (history || []).filter(m => m.role === "user" || m.role === "assistant");
        // Dil talimatını son kullanıcı mesajına ekle (tüm AI çağrılarında seçili dile uyulur)
        const langInstr = this.getLangInstruction();
        if (cleanHistory.length > 0) {
            for (const m of cleanHistory)
                messages.push({ role: m.role, content: m.content });
            // Son user mesajına dil talimatını ekle
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") {
                    messages[i].content += langInstr;
                    break;
                }
            }
        }
        else {
            messages.push({ role: "user", content: prompt + langInstr });
        }
        const modelName = onlineSearch && !agent.model.includes(":online")
            ? agent.model + ":online"
            : agent.model;
        // Agent'ın kendi API key'i varsa → direkt provider'a çağrı (OpenRouter değil)
        if (agent.apiKey) {
            return this.callProviderDirect(agent, modelName, messages, maxTokens, signal);
        }
        // Yoksa normal OpenRouter çağrısı
        const response = await httpsPostJson(this.OPENROUTER_URL, { model: modelName, messages, max_tokens: maxTokens }, {
            Authorization: `Bearer ${this.config.openRouterKey}`,
            "HTTP-Referer": "https://github.com/sencerCetinturk/chainforge",
            "X-Title": "ChainForge VSCode Extension",
        }, 120000, signal);
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
    async callProviderDirect(agent, modelName, messages, maxTokens = 4096, signal) {
        // Endpoint verilmemişse modelin sağlayıcısından tahmin et
        const endpoint = agent.apiEndpoint || this.guessEndpoint(modelName);
        // Native API'ler "provider/model" değil sade model adı ister → prefix'i temizle
        const nativeModel = endpoint.includes("openrouter.ai") ? modelName : modelName.replace(/^[^/]+\//, "").replace(/:.*$/, "");
        const response = await httpsPostJson(endpoint, { model: nativeModel, messages, max_tokens: maxTokens }, {
            Authorization: `Bearer ${agent.apiKey}`,
        }, 120000, signal);
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
    // Kendi API key kullanılırken endpoint verilmemişse modelden tahmin et
    guessEndpoint(model) {
        const m = model.toLowerCase();
        if (m.startsWith("deepseek"))
            return "https://api.deepseek.com/v1/chat/completions";
        if (m.startsWith("groq") || m.includes("llama") && m.includes("groq"))
            return "https://api.groq.com/openai/v1/chat/completions";
        if (m.startsWith("mistral"))
            return "https://api.mistral.ai/v1/chat/completions";
        if (m.startsWith("google") || m.startsWith("gemini"))
            return "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
        // Varsayılan: OpenAI uyumlu
        return "https://api.openai.com/v1/chat/completions";
    }
    errorResult(attempts, error) {
        return { success: false, content: "", usedAgent: "", usedModel: "", attempts, error };
    }
    updateConfig(config) {
        this.config = config;
    }
}
exports.AIRouter = AIRouter;
AIRouter.FREE_AGENT_LIMIT = 3;
//# sourceMappingURL=router.js.map