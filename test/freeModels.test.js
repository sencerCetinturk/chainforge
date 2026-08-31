const { test } = require("node:test");
const assert = require("node:assert");
const { filterAliveModels, filterAliveChain, FREE_MODELS, FREE_FALLBACK_CHAIN } = require("../out/freeModels.js");

test("filterAliveModels — liveIds null ise statik listenin TAMAMINI döner (davranış bozulmaz)", () => {
  const result = filterAliveModels(FREE_MODELS, null);
  assert.strictEqual(result.length, FREE_MODELS.length);
});

test("filterAliveModels — liveIds boşsa (Set boyutu 0) yine statik listeye düşer", () => {
  const result = filterAliveModels(FREE_MODELS, new Set());
  assert.strictEqual(result.length, FREE_MODELS.length);
});

test("filterAliveModels — sadece canlı ID'ler kalır, ölüler elenir", () => {
  const liveIds = new Set([FREE_MODELS[0].id, FREE_MODELS[1].id]);
  const result = filterAliveModels(FREE_MODELS, liveIds);
  assert.strictEqual(result.length, 2);
  assert.ok(result.every(m => liveIds.has(m.id)));
});

test("filterAliveModels — hepsi ölü görünüyorsa (şüpheli durum) statik listeye güvenle düşer", () => {
  const liveIds = new Set(["hic/olmayan-model:free"]);
  const result = filterAliveModels(FREE_MODELS, liveIds);
  assert.strictEqual(result.length, FREE_MODELS.length);
});

test("filterAliveChain — aynı mantık zincir (string[]) için de çalışır", () => {
  const liveIds = new Set([FREE_FALLBACK_CHAIN[0]]);
  const result = filterAliveChain(FREE_FALLBACK_CHAIN, liveIds);
  assert.deepStrictEqual(result, [FREE_FALLBACK_CHAIN[0]]);
});
