"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRESETS = void 0;
const configManager_1 = require("./configManager");
// Aynı rol/görev yapısını (DEFAULT_CONFIG) koruyup sadece model seçimini değiştiren
// hazır kurulumlar. Kullanıcı tek tıkla "worker/fallback/supervisor" agent'larını
// bu modellerle yeniden oluşturabilir — sıfırdan yapılandırma sürtünmesini kaldırır.
function withModels(worker, fallback, supervisor) {
    return {
        ...configManager_1.DEFAULT_CONFIG,
        agents: {
            worker: { ...configManager_1.DEFAULT_CONFIG.agents.worker, model: worker },
            fallback: { ...configManager_1.DEFAULT_CONFIG.agents.fallback, model: fallback },
            supervisor: { ...configManager_1.DEFAULT_CONFIG.agents.supervisor, model: supervisor },
        },
    };
}
exports.PRESETS = [
    {
        key: "free",
        label: "🆓 Ücretsiz",
        description: "Tamamen ücretsiz modeller — API key olmadan da çalışır.",
        requiresKey: false,
        config: withModels("cohere/north-mini-code:free", "minimax/minimax-m3:free", "z-ai/glm-5.2:free"),
    },
    {
        key: "balanced",
        label: "⚖️ Dengeli",
        description: "Ücretsiz + düşük maliyetli modellerin karışımı (varsayılan).",
        requiresKey: false,
        config: configManager_1.DEFAULT_CONFIG,
    },
    {
        key: "powerful",
        label: "🚀 Güçlü",
        description: "Claude & GPT ağırlıklı — en iyi kalite, OpenRouter key gerektirir.",
        requiresKey: true,
        config: withModels("anthropic/claude-sonnet-4.6", "openai/gpt-4.1", "anthropic/claude-opus-4.8"),
    },
];
//# sourceMappingURL=presets.js.map