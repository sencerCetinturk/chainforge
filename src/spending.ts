import * as vscode from "vscode";

export interface UsageRecord {
  timestamp: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

// OpenRouter model fiyatları ($/M token, girdi/çıktı)
const PRICING: [string, number, number][] = [
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

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const m = model.toLowerCase();
  const entry = PRICING.find(([key]) => m.includes(key));
  if (!entry) return 0;
  const [, inputPrice, outputPrice] = entry;
  return (promptTokens / 1_000_000 * inputPrice) + (completionTokens / 1_000_000 * outputPrice);
}

export class SpendingManager {
  private static KEY = "chainforge.usageRecords";

  constructor(private context: vscode.ExtensionContext) {}

  addRecord(record: UsageRecord): void {
    const all = this.getAll();
    all.push(record);
    // Son 3000 kaydı tut
    this.context.globalState.update(SpendingManager.KEY, all.slice(-3000));
  }

  getAll(): UsageRecord[] {
    return this.context.globalState.get<UsageRecord[]>(SpendingManager.KEY, []);
  }

  getMonthlyStats() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const records = this.getAll().filter(r => r.timestamp >= startOfMonth);

    const byModel: Record<string, { tokens: number; cost: number; requests: number }> = {};
    for (const r of records) {
      if (!byModel[r.model]) byModel[r.model] = { tokens: 0, cost: 0, requests: 0 };
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

  clearAll(): void {
    this.context.globalState.update(SpendingManager.KEY, []);
  }
}
