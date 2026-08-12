"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");
const contentSource = fs.readFileSync(
  path.join(root, "content", "translator.js"),
  "utf8"
);
const benchmarkSource = fs.readFileSync(
  path.join(root, "benchmarks", "run-live-benchmark.js"),
  "utf8"
);
const benchmark = require("../benchmarks/run-live-benchmark.js");

test("live benchmark targets the active provider and reports network work", async () => {
  assert.doesNotMatch(benchmarkSource, /translateWithMicrosoft/);
  const result = await benchmark.timedTranslate(async () => ({
    translated: "译文",
    detectedLang: "en",
    inputTokens: 12,
    outputTokens: 7,
    requestCount: 2,
    retryCount: 1,
  }));

  assert.equal(result.output, "译文");
  assert.equal(result.inputTokens, 12);
  assert.equal(result.outputTokens, 7);
  assert.equal(result.requestCount, 2);
  assert.equal(result.retryCount, 1);
  assert.equal(result.networkRequests, 3);
});

test("reload injection covers open messages without auto-translating them", () => {
  assert.match(backgroundSource, /injectReadScriptsIntoOpenMessages/);
  assert.match(backgroundSource, /__thunderbirdTranslatorSkipAutoTranslateOnce = true/);
  assert.match(contentSource, /skipAutoTranslateOnLoad/);
  assert.match(contentSource, /if \(!skipAutoTranslateOnLoad\)/);
});

test("stored performance metrics contain counts but no message text", () => {
  const start = backgroundSource.indexOf("function recordTranslationPerformance");
  const end = backgroundSource.indexOf("function finishTranslationAccounting", start);
  const recorder = backgroundSource.slice(start, end);

  assert.match(recorder, /durationMs/);
  assert.match(recorder, /networkRequests/);
  assert.match(recorder, /deduplicatedSegments/);
  assert.doesNotMatch(recorder, /message\.text|translated|sourceText/);
});
