"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpendingManager = void 0;
exports.refreshPricingCache = refreshPricingCache;
exports.estimateCost = estimateCost;
const https = require("https");
let dynamicPricing = null;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 saat
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
function httpsGetJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const options = {
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: "GET",
            headers: { "Accept": "application/json" },
        };
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                try {
                    resolve(JSON.parse(raw));
                }
                catch {
                    resolve(null);
                }
            });
        });
        req.on("error", () => resolve(null)); // ağ hatası → sessizce null dön
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
        req.end();
    });
}
/**
 * OpenRouter'dan güncel model fiyatlarını çek ve önbelleğe al.
 * Uzantı aktif edilirken çağrılır. Başarısız olursa statik tabloya düşer.
 */
async function refreshPricingCache(context) {
    // Önce globalState'ten yükle
    const cached = context.globalState.get("chainforge.pricingCache");
    if (cached && (Date.now() - cached.updatedAt) < CACHE_TTL) {
        dynamicPricing = cached;
        return;
    }
    try {
        const response = await httpsGetJson(OPENROUTER_MODELS_URL, 15000);
        const models = {};
        if (response?.data && Array.isArray(response.data)) {
            for (const m of response.data) {
                const id = (m.id || "").toLowerCase();
                // OpenRouter API fiyatı token başına döner → $/M token'a çevir
                const promptPrice = parseFloat(String(m.pricing?.prompt || "0")) * 1000000;
                const completionPrice = parseFloat(String(m.pricing?.completion || "0")) * 1000000;
                models[id] = { inputPrice: promptPrice, outputPrice: completionPrice };
            }
        }
        dynamicPricing = { updatedAt: Date.now(), models };
        context.globalState.update("chainforge.pricingCache", dynamicPricing);
        console.log(`[ChainForge] ${Object.keys(models).length} model fiyatı OpenRouter'dan güncellendi`);
    }
    catch {
        // Ağ hatası → eski önbelleği varsa kullan, yoksa statik tabloya düş
        if (!dynamicPricing) {
            dynamicPricing = cached || null;
        }
    }
}
// ── Statik fiyat tablosu (fallback) ──
// OpenRouter model fiyatları ($/M token, girdi/çıktı)
// Sıralama: önce daha spesifik anahtarlar, sonra genel olanlar
const STATIC_PRICING = [
    // ── Anthropic Claude ──
    ["claude-opus-4-8", 15, 75],
    ["claude-opus-4", 15, 75],
    ["claude-3-opus", 15, 75],
    ["claude-opus", 15, 75],
    ["claude-sonnet-4-6", 3, 15],
    ["claude-sonnet-4", 3, 15],
    ["claude-3.5-sonnet", 3, 15],
    ["claude-3-sonnet", 3, 15],
    ["claude-sonnet", 3, 15],
    ["claude-haiku-4-5", 0.25, 1.25],
    ["claude-haiku-4", 0.25, 1.25],
    ["claude-3.5-haiku", 0.8, 4],
    ["claude-3-haiku", 0.25, 1.25],
    ["claude-haiku", 0.25, 1.25],
    ["claude", 3, 15],
    // ── OpenAI ──
    ["o3-pro", 10, 40],
    ["o3-mini-high", 1.1, 4.4],
    ["o3-mini", 1.1, 4.4],
    ["o1-pro", 15, 60],
    ["o1-preview", 15, 60],
    ["o1-mini", 3, 12],
    ["o1", 15, 60],
    ["gpt-4.1-nano", 0.1, 0.4],
    ["gpt-4.1-mini", 0.4, 1.6],
    ["gpt-4.1", 2, 8],
    ["gpt-4o-mini-2024-07-18", 0.15, 0.6],
    ["gpt-4o-mini", 0.15, 0.6],
    ["gpt-4o-2024-11-20", 2.5, 10],
    ["gpt-4o-2024-08-06", 2.5, 10],
    ["gpt-4o-2024-05-13", 5, 15],
    ["gpt-4o", 2.5, 10],
    ["gpt-4-turbo-2024-04-09", 10, 30],
    ["gpt-4-turbo", 10, 30],
    ["gpt-4.5-preview", 75, 150],
    ["gpt-4-32k", 60, 120],
    ["gpt-4", 30, 60],
    ["gpt-3.5-turbo-0125", 0.5, 1.5],
    ["gpt-3.5-turbo", 0.5, 1.5],
    ["chatgpt-4o", 2.5, 10],
    // ── Google Gemini ──
    ["gemini-2.5-flash-lite", 0.0375, 0.15],
    ["gemini-2.5-flash", 0.075, 0.3],
    ["gemini-2.5-pro", 1.25, 5],
    ["gemini-2.0-flash-lite", 0.075, 0.3],
    ["gemini-2.0-flash", 0.1, 0.4],
    ["gemini-2.0-pro", 1.25, 5],
    ["gemini-1.5-flash-8b", 0.0375, 0.15],
    ["gemini-1.5-flash", 0.075, 0.3],
    ["gemini-1.5-pro", 1.25, 5],
    ["gemini-flash-lite", 0.0375, 0.15],
    ["gemini-flash", 0.075, 0.3],
    ["gemini-pro", 1.25, 5],
    ["gemma-4-31b", 0, 0],
    ["gemma-3-27b", 0, 0],
    ["gemma-3-12b", 0, 0],
    ["gemma-3-4b", 0, 0],
    ["gemma-3-1b", 0, 0],
    ["gemma-2-27b", 0.05, 0.05],
    ["gemma-2-9b", 0.03, 0.03],
    ["gemma-2-2b", 0, 0],
    ["gemma", 0, 0],
    ["gemini", 0.1, 0.4],
    // ── DeepSeek ──
    ["deepseek-r1-distill-qwen-32b", 0.12, 0.18],
    ["deepseek-r1-distill-llama-70b", 0.12, 0.18],
    ["deepseek-r1-distill-llama-8b", 0.03, 0.04],
    ["deepseek-r1-distill-qwen-14b", 0.06, 0.08],
    ["deepseek-r1-distill-qwen-7b", 0.03, 0.04],
    ["deepseek-r1-distill-qwen-1.5b", 0, 0],
    ["deepseek-r1", 0.55, 2.19],
    ["deepseek-v3-0324", 0.14, 0.28],
    ["deepseek-v3", 0.14, 0.28],
    ["deepseek-coder-v2", 0.14, 0.28],
    ["deepseek-coder", 0.14, 0.28],
    ["deepseek-chat-v3-0324", 0.14, 0.28],
    ["deepseek-chat-v3", 0.14, 0.28],
    ["deepseek-chat", 0.14, 0.28],
    ["deepseek-llm-67b-chat", 0.14, 0.28],
    ["deepseek", 0.14, 0.28],
    // ── Meta LLaMA ──
    ["llama-4-maverick", 0.2, 0.9],
    ["llama-4-scout", 0.1, 0.4],
    ["llama-3.3-70b-instruct", 0.12, 0.3],
    ["llama-3.2-90b-vision-instruct", 0.9, 0.9],
    ["llama-3.2-11b-vision-instruct", 0.06, 0.06],
    ["llama-3.2-3b-instruct", 0.015, 0.015],
    ["llama-3.2-1b-instruct", 0.01, 0.01],
    ["llama-3.1-405b-instruct", 0.8, 0.8],
    ["llama-3.1-70b-instruct", 0.35, 0.4],
    ["llama-3.1-8b-instruct", 0.06, 0.06],
    ["llama-3-70b-instruct", 0.35, 0.4],
    ["llama-3-8b-instruct", 0.06, 0.06],
    ["llama-3", 0.05, 0.05],
    ["llama-2-70b", 0.06, 0.06],
    ["llama-2-13b", 0.02, 0.02],
    ["llama-2-7b", 0.01, 0.01],
    ["llama", 0.05, 0.05],
    // ── Mistral ──
    ["mistral-large-2", 4, 12],
    ["mistral-large", 4, 12],
    ["mistral-medium", 2.7, 8.1],
    ["mistral-small-3", 0.1, 0.1],
    ["mistral-small", 0.1, 0.1],
    ["mistral-7b", 0.06, 0.06],
    ["mistral-nemo", 0.15, 0.15],
    ["mistral-tiny", 0.25, 0.25],
    ["mixtral-8x22b-instruct", 0.9, 0.9],
    ["mixtral-8x7b-instruct", 0.27, 0.27],
    ["mixtral-8x22b", 0.9, 0.9],
    ["mixtral-8x7b", 0.27, 0.27],
    ["mixtral", 0.27, 0.27],
    ["codestral-2501", 0.3, 0.9],
    ["codestral", 0.3, 0.9],
    ["ministral-8b", 0.1, 0.1],
    ["ministral-3b", 0.04, 0.04],
    ["mistral", 0.25, 0.25],
    // ── Qwen ──
    ["qwen3-coder-480b", 0.5, 1.5],
    ["qwen3-coder", 0.15, 0.3],
    ["qwen3-next-80b-a3b", 0, 0],
    ["qwen3-next-80b", 0, 0],
    ["qwen3-235b-a22b", 0.1, 0.1],
    ["qwen3-32b", 0.05, 0.05],
    ["qwen3-14b", 0.03, 0.03],
    ["qwen3-8b", 0.02, 0.02],
    ["qwen3-4b", 0.01, 0.01],
    ["qwen3-1.7b", 0.005, 0.005],
    ["qwen2.5-72b-instruct", 0.35, 0.4],
    ["qwen2.5-32b-instruct", 0.15, 0.15],
    ["qwen2.5-14b-instruct", 0.07, 0.07],
    ["qwen2.5-7b-instruct", 0.03, 0.04],
    ["qwen2.5-coder-32b", 0.15, 0.15],
    ["qwen2.5-coder-14b", 0.07, 0.07],
    ["qwen2.5-coder-7b", 0.03, 0.04],
    ["qwen2.5-72b", 0.35, 0.4],
    ["qwen2.5-32b", 0.15, 0.15],
    ["qwen2.5-14b", 0.07, 0.07],
    ["qwen2.5-7b", 0.03, 0.04],
    ["qwen2.5", 0.07, 0.07],
    ["qwq-32b", 0.2, 0.2],
    ["qwen-max", 2.5, 10],
    ["qwen-plus", 1.5, 4],
    ["qwen-turbo", 0.35, 0.4],
    ["qwen", 0.07, 0.07],
    // ── MiniMax ──
    ["minimax-m3", 0.2, 1.1],
    ["minimax-m2", 0.2, 1.1],
    ["minimax-m1", 0.5, 5],
    ["minimax-text-01", 0.5, 5],
    ["minimax", 0.2, 1.1],
    // ── NVIDIA ──
    ["nemotron-super-120b", 0, 0],
    ["nemotron-nano-9b", 0, 0],
    ["nemotron-3-super", 0, 0],
    ["nemotron-3-nano", 0, 0],
    ["nemotron", 0, 0],
    ["llama-3.1-nemotron-70b", 0.12, 0.3],
    // ── Cohere ──
    ["command-r-plus-08-2024", 2.5, 10],
    ["command-r-plus", 2.5, 10],
    ["command-r-08-2024", 0.5, 1.5],
    ["command-r", 0.5, 1.5],
    ["command", 0.5, 1.5],
    ["command-a", 2.5, 10],
    // ── AI21 ──
    ["jamba-1.5-large", 2, 8],
    ["jamba-1.5-mini", 0.2, 0.4],
    ["jamba-large", 2, 8],
    ["jamba-mini", 0.2, 0.4],
    ["jamba", 2, 8],
    // ── xAI (Grok) ──
    ["grok-3", 3, 15],
    ["grok-2-1212", 2, 10],
    ["grok-2-vision-1212", 2, 10],
    ["grok-2", 2, 10],
    ["grok-beta", 5, 15],
    ["grok-vision-beta", 5, 15],
    ["grok", 3, 15],
    // ── Nous Research ──
    ["hermes-3-llama-3.1-405b", 0.8, 0.8],
    ["hermes-3-llama-3.1-70b", 0.35, 0.4],
    ["hermes-3-llama-3.1-8b", 0.06, 0.06],
    ["hermes-3-llama-3.2-3b", 0.015, 0.015],
    ["hermes-3", 0.06, 0.06],
    ["hermes-2-pro-llama-3-8b", 0.06, 0.06],
    ["hermes-2-pro-mistral-7b", 0.06, 0.06],
    ["hermes-2-theta-llama-3-8b", 0.06, 0.06],
    ["hermes", 0.06, 0.06],
    // ── Microsoft Phi ──
    ["phi-4-mini", 0.05, 0.05],
    ["phi-4", 0.1, 0.1],
    ["phi-3.5-mini", 0.05, 0.05],
    ["phi-3.5", 0.05, 0.05],
    ["phi-3-mini", 0.05, 0.05],
    ["phi-3-medium", 0.15, 0.15],
    ["phi-3", 0.1, 0.1],
    ["phi", 0.1, 0.1],
    // ── Moonshot / Kimi ──
    ["kimi-k2.6", 0, 0],
    ["kimi-k2", 0, 0],
    ["moonshot-v1-8k", 0.06, 0.06],
    ["moonshot-v1-32k", 0.06, 0.06],
    ["moonshot-v1-128k", 0.06, 0.06],
    ["kimi", 0, 0],
    // ── GLM ──
    ["glm-4.5-air", 0, 0],
    ["glm-4.5", 0.2, 0.2],
    ["glm-4-plus", 0.5, 0.5],
    ["glm-4", 0.1, 0.1],
    ["glm-3", 0.05, 0.05],
    ["glm", 0.1, 0.1],
    // ── GPT-OSS ──
    ["gpt-oss-120b", 0, 0],
    ["gpt-oss-20b", 0, 0],
    ["gpt-oss", 0, 0],
    // ── Perplexity ──
    ["sonar-pro", 5, 15],
    ["sonar-reasoning-pro", 5, 15],
    ["sonar-reasoning", 1, 5],
    ["sonar", 1, 5],
    ["pplx-70b-online", 0.5, 0.5],
    ["pplx-7b-online", 0.05, 0.05],
    // ── Databricks ──
    ["dbrx-instruct", 0.6, 0.6],
    ["dbrx", 0.6, 0.6],
    // ── WizardLM ──
    ["wizardlm-2-8x22b", 0.9, 0.9],
    ["wizardlm-2-7b", 0.06, 0.06],
    ["wizardlm", 0.06, 0.06],
    // ── Reka ──
    ["reka-flash-3", 0.2, 2],
    ["reka-core", 2, 15],
    ["reka-edge", 0.4, 0.8],
    ["reka", 0.4, 0.8],
];
/**
 * Model için tahmini maliyet hesapla.
 * 1) :free → 0
 * 2) Dinamik önbellekte tam eşleşme → OpenRouter güncel fiyatı
 * 3) Statik tabloda substring eşleşme → fallback
 */
function estimateCost(model, promptTokens, completionTokens) {
    if (promptTokens === 0 && completionTokens === 0)
        return 0;
    const raw = model.toLowerCase().trim();
    // :free etiketli modeller → ücretsiz
    if (raw.includes(":free"))
        return 0;
    // Model adını normalize et: ekleri temizle
    const normalized = raw
        .replace(/:online$/, "")
        .replace(/:free$/, "")
        .replace(/:latest$/, "")
        .replace(/:beta$/, "")
        .replace(/:experimental$/, "");
    // 1) Dinamik önbellekte tam eşleşme ara (OpenRouter güncel fiyatı)
    if (dynamicPricing) {
        const candidates = [normalized];
        if (normalized.includes("/")) {
            // provider prefix'siz hallerini de dene
            candidates.push(normalized.split("/").slice(1).join("/"));
            candidates.push(normalized.split("/").pop());
        }
        for (const c of candidates) {
            const dyn = dynamicPricing.models[c];
            if (dyn) {
                return (promptTokens / 1000000 * dyn.inputPrice) + (completionTokens / 1000000 * dyn.outputPrice);
            }
        }
    }
    // 2) Statik tabloda substring eşleşme (fallback)
    const variants = [normalized];
    if (normalized.includes("/")) {
        variants.push(normalized.split("/").slice(1).join("/"));
        variants.push(normalized.split("/").pop());
    }
    for (const v of variants) {
        const entry = STATIC_PRICING.find(([key]) => v.includes(key));
        if (entry) {
            const [, inputPrice, outputPrice] = entry;
            return (promptTokens / 1000000 * inputPrice) + (completionTokens / 1000000 * outputPrice);
        }
    }
    return 0;
}
// ── Harcama Yöneticisi ──
class SpendingManager {
    constructor(context) {
        this.context = context;
    }
    addRecord(record) {
        const all = this.getAll();
        all.push(record);
        // Son 3000 kaydı tut
        this.context.globalState.update(SpendingManager.KEY, all.slice(-3000));
    }
    getAll() {
        return this.context.globalState.get(SpendingManager.KEY, []);
    }
    getMonthlyStats() {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const records = this.getAll().filter(r => r.timestamp >= startOfMonth);
        const byModel = {};
        for (const r of records) {
            if (!byModel[r.model])
                byModel[r.model] = { tokens: 0, cost: 0, requests: 0 };
            byModel[r.model].tokens += r.totalTokens;
            byModel[r.model].cost += r.estimatedCostUsd;
            byModel[r.model].requests += 1;
        }
        return {
            byModel,
            totalCost: records.reduce((s, r) => s + r.estimatedCostUsd, 0),
            totalTokens: records.reduce((s, r) => s + r.totalTokens, 0),
            totalRequests: records.length,
            month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
        };
    }
    clearAll() {
        return Promise.resolve(this.context.globalState.update(SpendingManager.KEY, []));
    }
}
exports.SpendingManager = SpendingManager;
SpendingManager.KEY = "chainforge.usageRecords";
//# sourceMappingURL=spending.js.map