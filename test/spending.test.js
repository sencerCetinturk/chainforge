const { test } = require("node:test");
const assert = require("node:assert");
const { estimateCost } = require("../out/spending.js");

test("estimateCost — :free etiketli modeller sıfır maliyetli", () => {
  assert.strictEqual(estimateCost("qwen/qwen3-coder:free", 1000, 1000), 0);
  assert.strictEqual(estimateCost("meta-llama/llama-3.3-70b-instruct:free", 5000, 5000), 0);
});

test("estimateCost — token sayısı sıfırsa maliyet sıfır", () => {
  assert.strictEqual(estimateCost("anthropic/claude-sonnet-4-6", 0, 0), 0);
});

test("estimateCost — statik tablodan substring eşleşmesiyle pozitif maliyet hesaplar", () => {
  const cost = estimateCost("anthropic/claude-sonnet-4-6", 1_000_000, 1_000_000);
  // claude-sonnet-4-6: input $3/M, output $15/M → 1M+1M token için $18
  assert.strictEqual(cost, 18);
});

test("estimateCost — provider prefix'i olmayan native model adıyla da eşleşir", () => {
  const cost = estimateCost("gpt-4o-mini", 1_000_000, 0);
  assert.ok(cost > 0, "gpt-4o-mini eşleşip pozitif maliyet döndürmeli");
});

test("estimateCost — bilinmeyen model için sıfır döner (hataya düşmez)", () => {
  assert.strictEqual(estimateCost("bilinmeyen-uydurma-model-xyz", 1000, 1000), 0);
});
