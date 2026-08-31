"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshFreeModelCatalog = refreshFreeModelCatalog;
const https = require("https");
const CACHE_KEY = "chainforge.freeModelCatalogCache";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 saat — OpenRouter'ın :free kataloğu sık değişmiyor, günde bir yeter
function httpsGetJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    });
}
// OpenRouter'ın canlı model listesinden (key GEREKMEZ) hâlâ var olan ":free" model ID'lerini
// çeker. Kodun içindeki statik listeler (freeModels.ts) zamanla ölebiliyor — bu fonksiyon
// extension her açıldığında bir kez çalışıp gerçekten çalışan modelleri doğrular, 24 saat
// önbelleğe alır. Ağ hatasında eski önbellek varsa onu, yoksa null döner — null durumunda
// çağıran taraf statik listeye güvenle düşmeli (davranış hiç bozulmaz, sadece iyileştirme fırsatı kaçar).
async function refreshFreeModelCatalog(context) {
    const cached = context.globalState.get(CACHE_KEY);
    if (cached && Date.now() - cached.updatedAt < TTL_MS) {
        return new Set(cached.freeIds);
    }
    try {
        const json = await httpsGetJson("https://openrouter.ai/api/v1/models", 10000);
        const ids = (json?.data || [])
            .map((m) => String(m?.id || "").toLowerCase())
            .filter((id) => id.endsWith(":free"));
        if (ids.length === 0)
            throw new Error("Boş liste döndü");
        await context.globalState.update(CACHE_KEY, { updatedAt: Date.now(), freeIds: ids });
        return new Set(ids);
    }
    catch {
        return cached ? new Set(cached.freeIds) : null;
    }
}
//# sourceMappingURL=modelCatalog.js.map