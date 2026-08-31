"use strict";
// ÜCRETSİZ MODELLER — OpenRouter :free uçları
// tier: "free"    → tam ücretsiz, günlük cömert limit
//       "limited" → ücretsiz ama düşük günlük/dakika limiti (yoğun kullanımda biter)
Object.defineProperty(exports, "__esModule", { value: true });
exports.FREE_FALLBACK_CHAIN = exports.FREE_MODELS = void 0;
exports.filterAliveModels = filterAliveModels;
exports.filterAliveChain = filterAliveChain;
exports.isFreeModel = isFreeModel;
exports.getFreeModel = getFreeModel;
// NOT (2026-08-31): OpenRouter'ın :free katalogu sık değişiyor — burada listelenen ID'ler
// openrouter.ai/api/v1/models canlı listesine karşı doğrulanmıştır. Bu liste periyodik
// olarak (ör. birkaç ayda bir) yeniden doğrulanmalı, aksi halde modeller sessizce ölebilir.
exports.FREE_MODELS = [
    // — Kod odaklı —
    { id: "cohere/north-mini-code:free", label: "North Mini Code", tier: "free", goodFor: "Kod yazma" },
    { id: "minimax/minimax-m3:free", label: "MiniMax M3", tier: "free", goodFor: "Kod & mantık" },
    // — Güçlü genel —
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron Ultra 550B", tier: "free", goodFor: "Güçlü genel" },
    { id: "z-ai/glm-5.2:free", label: "GLM 5.2", tier: "free", goodFor: "Güçlü akıl yürütme" },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron Super 120B", tier: "free", goodFor: "Genel amaçlı" },
    // — Hızlı —
    { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B", tier: "limited", goodFor: "Hızlı yanıt" },
    { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B", tier: "free", goodFor: "Hızlı, dengeli" },
    { id: "minimax/minimax-m2.7:free", label: "MiniMax M2.7", tier: "limited", goodFor: "Genel amaçlı" },
    // — Hafif / çok hızlı —
    { id: "liquid/lfm-2.5-2.6b:free", label: "LFM2.5 2.6B", tier: "limited", goodFor: "Çok hızlı, basit" },
    // — Uzun bağlam —
    { id: "thinkingmachines/inkling:free", label: "Inkling", tier: "limited", goodFor: "Uzun bağlam" },
    { id: "dots-studio/dots-3-note-preview:free", label: "Dots3 Note Preview", tier: "limited", goodFor: "Uzun bağlam" },
];
// Postacı/koordinatör için varsayılan ücretsiz zincir (sırayla denenir)
exports.FREE_FALLBACK_CHAIN = [
    "cohere/north-mini-code:free",
    "minimax/minimax-m3:free",
    "z-ai/glm-5.2:free",
    "google/gemma-4-31b-it:free",
];
// Canlı katalog kontrolü (modelCatalog.ts) sonucuna göre statik listeleri süzer. liveIds
// null/boşsa (ağ hatası ya da henüz çekilmediyse) statik listenin TAMAMI güvenle döner —
// bu fonksiyon davranışı asla daha kötü hale getirmez, sadece iyileştirir.
function filterAliveModels(models, liveIds) {
    if (!liveIds || liveIds.size === 0)
        return models;
    const alive = models.filter(m => liveIds.has(m.id.toLowerCase()));
    return alive.length > 0 ? alive : models; // hepsi ölü görünüyorsa (şüpheli) statik listeye güven
}
function filterAliveChain(chain, liveIds) {
    if (!liveIds || liveIds.size === 0)
        return chain;
    const alive = chain.filter(id => liveIds.has(id.toLowerCase()));
    return alive.length > 0 ? alive : chain;
}
function isFreeModel(modelId) {
    return modelId.includes(":free") || exports.FREE_MODELS.some(m => m.id === modelId);
}
function getFreeModel(id) {
    return exports.FREE_MODELS.find(m => m.id === id);
}
//# sourceMappingURL=freeModels.js.map