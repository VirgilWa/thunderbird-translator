"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { translateWithFallback } = require("../translation-router.js");

test("Tencent is routed directly with request options", async () => {
  const calls = [];
  const requestOptions = { marker: "request-options" };
  const result = await translateWithFallback({
    service: "tencent",
    text: "hello",
    targetLang: "zh",
    settings: {},
    sourceLang: null,
    requestOptions,
    async translateUsingService(service, text, targetLang, settings, sourceLang, forwardedOptions) {
      calls.push({ service, forwardedOptions });
      return { translated: "你好", detectedLang: "en", provider: service };
    },
  });

  assert.deepEqual(calls, [{ service: "tencent", forwardedOptions: requestOptions }]);
  assert.equal(result.translated, "你好");
  assert.equal(result.provider, "tencent");
});

test("retired Microsoft provider is rejected", async () => {
  await assert.rejects(
    translateWithFallback({
      service: "microsoft",
      text: "hello",
      targetLang: "zh",
      settings: {},
      sourceLang: null,
      async translateUsingService() {
        throw new Error("should not be called");
      },
    }),
    /Unsupported translation service: microsoft/
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
