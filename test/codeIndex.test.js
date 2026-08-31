const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { extractHeaders } = require("../out/agent/codeHeaders.js");

test("extractHeaders — TypeScript fonksiyon ve sınıfları bulur", () => {
  const code = [
    "export function calculateTotal(items) {",
    "  return items.reduce((a, b) => a + b, 0);",
    "}",
    "",
    "export class OrderManager {",
    "  addItem(item) {",
    "    return item;",
    "  }",
    "}",
    "",
    "export interface Order {",
    "  id: string;",
    "}",
    "",
    "export type OrderId = string;",
  ].join("\n");

  const headers = extractHeaders("orders.ts", code);
  const names = headers.map(h => `${h.kind}:${h.name}:${h.line}`);

  assert.ok(names.includes("function:calculateTotal:1"), names.join(", "));
  assert.ok(names.includes("class:OrderManager:5"), names.join(", "));
  assert.ok(names.includes("interface:Order:11"), names.join(", "));
  assert.ok(names.includes("type:OrderId:15"), names.join(", "));
});

test("extractHeaders — arrow function const'ları ve Python def'i bulur", () => {
  const jsCode = "const reverseString = (s) => s.split('').reverse().join('');\n";
  const jsHeaders = extractHeaders("utils.js", jsCode);
  assert.strictEqual(jsHeaders.length, 1);
  assert.strictEqual(jsHeaders[0].name, "reverseString");
  assert.strictEqual(jsHeaders[0].line, 1);

  const pyCode = "def slugify(text):\n    return text.lower()\n";
  const pyHeaders = extractHeaders("utils.py", pyCode);
  assert.strictEqual(pyHeaders.length, 1);
  assert.strictEqual(pyHeaders[0].name, "slugify");
});

test("extractHeaders — boş/kod-dışı dosyada hiç başlık bulmaz", () => {
  const headers = extractHeaders("data.json", '{"a": 1}');
  assert.strictEqual(headers.length, 0);
});

test("extractHeaders — çok büyük dosyada dosya başına üst sınırı aşmaz", () => {
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(`function fn${i}() { return ${i}; }`);
  const headers = extractHeaders("big.js", lines.join("\n"));
  assert.ok(headers.length <= 40, `beklenen <=40, gelen ${headers.length}`);
});

test("extractHeaders — ChainForge'un kendi kaynak dosyasında (router.ts) gerçek semboller bulur", () => {
  const routerPath = path.join(__dirname, "..", "src", "router.ts");
  const content = fs.readFileSync(routerPath, "utf8");
  const headers = extractHeaders("router.ts", content);
  const names = headers.map(h => h.name);
  assert.ok(names.includes("AIRouter"), "AIRouter sınıfı bulunmalı: " + names.join(", "));
  assert.ok(headers.length > 3, "birden fazla sembol bulunmalı");
  // Her başlığın makul bir satır numarası olmalı
  for (const h of headers) {
    assert.ok(h.line >= 1 && h.line <= content.split("\n").length);
  }
});
