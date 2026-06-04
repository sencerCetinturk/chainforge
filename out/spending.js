"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpendingManager = void 0;
exports.estimateCost = estimateCost;
// OpenRouter model fiyatları ($/M token, girdi/çıktı)
const PRICING = [
    ["claude-opus", 15, 75],
    ["claude-sonnet", 3, 15],
    ["claude-haiku", 0.25, 1.25],
    ["gpt-4o-mini", 0.15, 0.6],
    ["gpt-4o", 2.5, 10],
    ["gpt-4-turbo", 10, 30],
    ["gemini-flash", 0.075, 0.3],
    ["gemini-pro", 1.25, 5],
    ["deepseek-chat", 0.14, 0.28],
    ["deepseek-coder", 0.14, 0.28],
    ["minimax-m3", 0.2, 1.1],
    ["llama-3", 0.05, 0.05],
    ["mistral", 0.25, 0.25],
];
function estimateCost(model, promptTokens, completionTokens) {
    const m = model.toLowerCase();
    const entry = PRICING.find(([key]) => m.includes(key));
    if (!entry)
        return 0;
    const [, inputPrice, outputPrice] = entry;
    return (promptTokens / 1000000 * inputPrice) + (completionTokens / 1000000 * outputPrice);
}
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
        this.context.globalState.update(SpendingManager.KEY, []);
    }
}
exports.SpendingManager = SpendingManager;
SpendingManager.KEY = "chainforge.usageRecords";
//# sourceMappingURL=spending.js.map