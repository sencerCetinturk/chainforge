const { test } = require("node:test");
const assert = require("node:assert");
const {
  validateRelativeFilePath,
  validateModel,
  validateAgentName,
  validateFilename,
} = require("../out/validator.js");

test("validateRelativeFilePath — meşru göreli yolları kabul eder", () => {
  assert.strictEqual(validateRelativeFilePath("utils/math.js").valid, true);
  assert.strictEqual(validateRelativeFilePath("index.ts").valid, true);
  assert.strictEqual(validateRelativeFilePath("src/agent/orchestrator.ts").valid, true);
});

test("validateRelativeFilePath — path traversal denemelerini reddeder", () => {
  assert.strictEqual(validateRelativeFilePath("../x.js").valid, false);
  assert.strictEqual(validateRelativeFilePath("a/../../b.js").valid, false);
  assert.strictEqual(validateRelativeFilePath("..\\..\\x.js").valid, false);
});

test("validateRelativeFilePath — mutlak yolları reddeder", () => {
  assert.strictEqual(validateRelativeFilePath("/etc/passwd").valid, false);
  assert.strictEqual(validateRelativeFilePath("C:\\Windows\\x").valid, false);
  assert.strictEqual(validateRelativeFilePath("D:/malware.exe").valid, false);
  assert.strictEqual(validateRelativeFilePath("~/.ssh/id_rsa").valid, false);
});

test("validateRelativeFilePath — boş/geçersiz girdiyi reddeder", () => {
  assert.strictEqual(validateRelativeFilePath("").valid, false);
  assert.strictEqual(validateRelativeFilePath("a\0b").valid, false);
});

test("validateModel — geçerli/geçersiz model formatları", () => {
  assert.strictEqual(validateModel("minimax/minimax-m3").valid, true);
  assert.strictEqual(validateModel("qwen/qwen3-coder:free").valid, true);
  assert.strictEqual(validateModel("openrouter/auto").valid, true);
  assert.strictEqual(validateModel("").valid, false);
  assert.strictEqual(validateModel("<script>alert(1)</script>").valid, false);
});

test("validateAgentName — script injection denemesini reddeder", () => {
  assert.strictEqual(validateAgentName("Kod Yazıcı").valid, true);
  assert.strictEqual(validateAgentName("<img onerror=alert(1)>").valid, false);
  assert.strictEqual(validateAgentName("javascript:alert(1)").valid, false);
});

test("validateFilename — path traversal ve özel karakterleri reddeder", () => {
  assert.strictEqual(validateFilename("rapor.md").valid, true);
  assert.strictEqual(validateFilename("../rapor.md").valid, false);
  assert.strictEqual(validateFilename("a/b.md").valid, false);
});
