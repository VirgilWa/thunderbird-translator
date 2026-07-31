"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { translateWithFallback } = require("../translation-router.js");

test("Microsoft is routed directly without fallback", async () => {
  const calls = [];
  const result = await translateWithFallback({
    service: "microsoft",
    text: "hello",
    targetLang: "zh",
    settings: {},
    sourceLang: null,
    async translateUsingService(service) {
      calls.push(service);
      return { translated: "你好", detectedLang: "en", provider: service };
    },
  });

  assert.deepEqual(calls, ["microsoft"]);
  assert.equal(result.translated, "你好");
  assert.equal(result.provider, "microsoft");
});

test("retired providers are rejected", async () => {
  await assert.rejects(
    translateWithFallback({
      service: "unsupported",
      text: "hello",
      targetLang: "zh",
      settings: {},
      sourceLang: null,
      async translateUsingService() {
        throw new Error("should not be called");
      },
    }),
    /Unsupported translation service: unsupported/
  );
});

test("Tencent is never routed to another provider", async () => {
  const calls = [];
  await assert.rejects(
    translateWithFallback({
      service: "tencent",
      text: "hello",
      targetLang: "zh",
      settings: {},
      sourceLang: null,
      async translateUsingService(service) {
        calls.push(service);
        throw new Error("Tencent Translation error: quota");
      },
    }),
    /Tencent Translation error: quota/
  );
  assert.deepEqual(calls, ["tencent"]);
});
