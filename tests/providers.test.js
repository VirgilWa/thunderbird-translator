"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac, webcrypto } = require("node:crypto");

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const providers = require("../providers.js");

function fakeResponse({ status = 200, text = "", json = null }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() { return text; },
    async json() { return json; },
  };
}

test("splitLongText preserves content and respects the limit", () => {
  const input = "First sentence. Second sentence.\nThird sentence with a longer tail.";
  const parts = providers.splitLongText(input, 24);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => part.length <= 24));
  assert.equal(parts.join(""), input);
});

test("Microsoft maps simplified Chinese to zh-Hans", () => {
  assert.equal(providers.microsoftLanguageCode("zh"), "zh-Hans");
  assert.equal(providers.microsoftLanguageCode("ja"), "ja");
});

test("Tencent signing is deterministic and never sends SecretKey", async () => {
  const settings = {
    tencentSecretId: "test-id",
    tencentSecretKey: "test-key",
    tencentRegion: "ap-shanghai",
    tencentProjectId: "0",
  };
  const request = await providers.buildTencentRequest(
    "hello world",
    "zh",
    settings,
    { timestamp: 1700000000, nonce: 123456 }
  );

  const sortedKeys = Object.keys(request.params).sort();
  const raw = sortedKeys.map(key => `${key}=${request.params[key]}`).join("&");
  const expected = createHmac("sha1", settings.tencentSecretKey)
    .update(`POSTtmt.tencentcloudapi.com/?${raw}`)
    .digest("base64");
  const encoded = new URLSearchParams(request.body);

  assert.equal(encoded.get("Signature"), expected);
  assert.equal(encoded.get("SecretId"), settings.tencentSecretId);
  assert.equal(request.body.includes(settings.tencentSecretKey), false);
});

test("Tencent exposes the API-reported UsedAmount", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => fakeResponse({
    json: {
      Response: {
        Source: "en",
        Target: "zh",
        TargetText: "用量测试",
        UsedAmount: 10,
      },
    },
  });

  try {
    const result = await providers.translateWithTencent("usage test", "zh", {
      tencentSecretId: "test-id",
      tencentSecretKey: "test-key",
      tencentRegion: "ap-shanghai",
      tencentProjectId: "0",
    });
    assert.equal(result.translated, "用量测试");
    assert.equal(result.detectedLang, "en");
    assert.equal(result.usedAmount, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Microsoft refreshes an expired token after one 401", async () => {
  providers.resetMicrosoftTokenForTests();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return fakeResponse({ text: "token-one" });
    if (calls.length === 2) return fakeResponse({ status: 401 });
    if (calls.length === 3) return fakeResponse({ text: "token-two" });
    return fakeResponse({
      json: [{
        detectedLanguage: { language: "en" },
        translations: [{ text: "你好" }],
      }],
    });
  };

  try {
    const result = await providers.translateWithMicrosoft("hello", "zh");
    assert.equal(result.translated, "你好");
    assert.equal(result.detectedLang, "en");
    assert.equal(calls.length, 4);
    assert.equal(calls[1].options.headers.Authorization, "Bearer token-one");
    assert.equal(calls[3].options.headers.Authorization, "Bearer token-two");
  } finally {
    globalThis.fetch = originalFetch;
    providers.resetMicrosoftTokenForTests();
  }
});

test("Microsoft batches long input without exceeding provider limits", async () => {
  providers.resetMicrosoftTokenForTests();
  const originalFetch = globalThis.fetch;
  const batchSizes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/translate/auth")) {
      return fakeResponse({ text: "token" });
    }
    const requestItems = JSON.parse(options.body);
    batchSizes.push({
      count: requestItems.length,
      chars: requestItems.reduce((sum, item) => sum + item.Text.length, 0),
    });
    return fakeResponse({
      json: requestItems.map(item => ({
        detectedLanguage: { language: "en" },
        translations: [{ text: item.Text }],
      })),
    });
  };

  try {
    const input = "a".repeat(4100) + "\n\n" + "b".repeat(4100);
    const result = await providers.translateWithMicrosoft(input, "en");
    assert.ok(batchSizes.every(batch => batch.count <= 50 && batch.chars <= 40000));
    assert.ok(result.translated.includes("a".repeat(100)));
    assert.ok(result.translated.includes("b".repeat(100)));
  } finally {
    globalThis.fetch = originalFetch;
    providers.resetMicrosoftTokenForTests();
  }
});
