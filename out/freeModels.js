"use strict";
// ÜCRETSİZ MODELLER — OpenRouter :free uçları
// tier: "free"    → tam ücretsiz, günlük cömert limit
//       "limited" → ücretsiz ama düşük günlük/dakika limiti (yoğun kullanımda biter)
Object.defineProperty(exports, "__esModule", { value: true });
exports.FREE_FALLBACK_CHAIN = exports.FREE_MODELS = void 0;
exports.isFreeModel = isFreeModel;
exports.getFreeModel = getFreeModel;
exports.FREE_MODELS = [
    // — Kod odaklı —
    { id: "qwen/qwen3-coder:free", label: "Qwen3 Coder", tier: "free", goodFor: "Kod yazma" },
    { id: "deepseek/deepseek-chat-v3-0324:free", label: "DeepSeek V3", tier: "free", goodFor: "Kod & mantık" },
    // — Güçlü genel —
    { id: "openai/gpt-oss-120b:free", label: "GPT-OSS 120B", tier: "free", goodFor: "Güçlü genel" },
    { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B", tier: "free", goodFor: "Genel amaçlı" },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron Super 120B", tier: "free", goodFor: "Güçlü akıl yürütme" },
    { id: "qwen/qwen3-next-80b-a3b-instruct:free", label: "Qwen3 Next 80B", tier: "free", goodFor: "Genel amaçlı" },
    { id: "nousresearch/hermes-3-llama-3.1-405b:free", label: "Hermes 3 405B", tier: "limited", goodFor: "Çok güçlü, yaratıcı" },
    // — Hızlı —
    { id: "z-ai/glm-4.5-air:free", label: "GLM 4.5 Air", tier: "free", goodFor: "Hızlı genel" },
    { id: "openai/gpt-oss-20b:free", label: "GPT-OSS 20B", tier: "free", goodFor: "Hızlı, dengeli" },
    { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B", tier: "limited", goodFor: "Hızlı yanıt" },
    { id: "moonshotai/kimi-k2.6:free", label: "Kimi K2.6", tier: "limited", goodFor: "Uzun bağlam" },
    // — Hafif / çok hızlı —
    { id: "meta-llama/llama-3.2-3b-instruct:free", label: "Llama 3.2 3B", tier: "limited", goodFor: "Çok hızlı, basit" },
    { id: "nvidia/nemotron-nano-9b-v2:free", label: "Nemotron Nano 9B", tier: "limited", goodFor: "Hafif görevler" },
    { id: "qwen/qwen-2.5-72b-instruct:free", label: "Qwen 2.5 72B", tier: "limited", goodFor: "Genel amaçlı" },
];
// Postacı/koordinatör için varsayılan ücretsiz zincir (sırayla denenir)
exports.FREE_FALLBACK_CHAIN = [
    "qwen/qwen3-coder:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "z-ai/glm-4.5-air:free",
    "openai/gpt-oss-120b:free",
];
function isFreeModel(modelId) {
    return modelId.includes(":free") || exports.FREE_MODELS.some(m => m.id === modelId);
}
function getFreeModel(id) {
    return exports.FREE_MODELS.find(m => m.id === id);
}
//# sourceMappingURL=freeModels.js.map