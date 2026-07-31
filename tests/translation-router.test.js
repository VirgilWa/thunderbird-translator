"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { translateWithFallback } = require("../translation-router.js");

test("Google failure falls back to Microsoft and reports the actual provider", async () => {
  const calls = [];
  const result = await translateWithFallback({
    service: "google",
    text: "hello",
    targetLang: "zh",
    settings: { googleFallbackService: "microsoft" },
    sourceLang: null,
    async translateUsingService(service) {
      calls.push(service);
      if (service === "google") throw new Error("Google Translate error: 429");
      return { translated: "你好", detectedLang: "en", provider: service };
    },
  });

  assert.deepEqual(calls, ["google", "microsoft"]);
  assert.equal(result.translated, "你好");
  assert.equal(result.provider, "microsoft");
  assert.equal(result.fallbackFrom, "google");
  assert.equal(result.fallbackReason, "Google Translate error: 429");
});

test("disabled Google fallback preserves the original error", async () => {
  await assert.rejects(
    translateWithFallback({
      service: "google",
      text: "hello",
      targetLang: "zh",
      settings: { googleFallbackService: "none" },
      sourceLang: null,
      async translateUsingService() {
        throw new Error("Google Translate error: 429");
      },
    }),
    /Google Translate error: 429/
  );
});

test("Tencent is never routed to another provider", async () => {
  const calls = [];
  await assert.rejects(
    translateWithFallback({
      service: "tencent",
      text: "hello",
      targetLang: "zh",
      settings: { googleFallbackService: "microsoft" },
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
