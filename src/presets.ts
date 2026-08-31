import { ChainConfig } from "./router";
import { DEFAULT_CONFIG } from "./configManager";

export interface Preset {
  key: string;
  label: string;
  description: string;
  requiresKey: boolean; // API key gerektiren ücretli model içeriyor mu?
  config: ChainConfig;
}

// Aynı rol/görev yapısını (DEFAULT_CONFIG) koruyup sadece model seçimini değiştiren
// hazır kurulumlar. Kullanıcı tek tıkla "worker/fallback/supervisor" agent'larını
// bu modellerle yeniden oluşturabilir — sıfırdan yapılandırma sürtünmesini kaldırır.
function withModels(worker: string, fallback: string, supervisor: string): ChainConfig {
  return {
    ...DEFAULT_CONFIG,
    agents: {
      worker: { ...DEFAULT_CONFIG.agents.worker, model: worker },
      fallback: { ...DEFAULT_CONFIG.agents.fallback, model: fallback },
      supervisor: { ...DEFAULT_CONFIG.agents.supervisor, model: supervisor },
    },
  };
}

export const PRESETS: Preset[] = [
  {
    key: "free",
    label: "🆓 Ücretsiz",
    description: "Tamamen ücretsiz modeller — API key olmadan da çalışır.",
    requiresKey: false,
    config: withModels(
      "cohere/north-mini-code:free",
      "minimax/minimax-m3:free",
      "z-ai/glm-5.2:free"
    ),
  },
  {
    key: "balanced",
    label: "⚖️ Dengeli",
    description: "Ücretsiz + düşük maliyetli modellerin karışımı (varsayılan).",
    requiresKey: false,
    config: DEFAULT_CONFIG,
  },
  {
    key: "powerful",
    label: "🚀 Güçlü",
    description: "Claude & GPT ağırlıklı — en iyi kalite, OpenRouter key gerektirir.",
    requiresKey: true,
    config: withModels(
      "anthropic/claude-sonnet-4.6",
      "openai/gpt-4.1",
      "anthropic/claude-opus-4.8"
    ),
  },
];
