"use strict";

const fs = require("node:fs");
const path = require("node:path");
const providers = require("../providers.js");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value == null) {
      throw new Error("Arguments must use --name value pairs");
    }
    args[key.slice(2)] = value;
  }
  return args;
}

async function timedTranslate(fn) {
  const started = performance.now();
  try {
    const result = await fn();
    return {
      output: result.translated,
      detectedLang: result.detectedLang || null,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      requestCount: result.requestCount ?? 0,
      retryCount: result.retryCount ?? 0,
      networkRequests: (result.requestCount ?? 0) + (result.retryCount ?? 0),
      durationMs: Math.round(performance.now() - started),
      error: null,
    };
  } catch (error) {
    return {
      output: null,
      detectedLang: null,
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
      retryCount: 0,
      networkRequests: 0,
      durationMs: Math.round(performance.now() - started),
      error: error.message,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const outputPath = path.resolve(args.output || "translation-benchmark-results.json");

  const cases = JSON.parse(fs.readFileSync(
    path.join(__dirname, "translation-quality-cases.json"),
    "utf8"
  ));
  const tencentSettings = {
    tencentApiKey: process.env.TOKENHUB_API_KEY || "",
    tencentModel: args.model || "hy-mt2-lite",
  };
  if (!tencentSettings.tencentApiKey) {
    throw new Error("TOKENHUB_API_KEY must be set for the live benchmark");
  }

  const results = [];

  for (const testCase of cases) {
    const target = testCase.direction.endsWith("-zh") ? "zh" : "en";
    const tencent = await timedTranslate(() =>
      providers.translateWithTencent(testCase.source, target, tencentSettings)
    );

    results.push({
      id: testCase.id,
      direction: testCase.direction,
      category: testCase.category,
      source: testCase.source,
      critical_checks: testCase.critical_checks,
      translated: tencent.output,
      durationMs: tencent.durationMs,
      detectedLang: tencent.detectedLang,
      inputTokens: tencent.inputTokens,
      outputTokens: tencent.outputTokens,
      providerRequests: tencent.requestCount,
      retries: tencent.retryCount,
      networkRequests: tencent.networkRequests,
      error: tencent.error,
    });
  }

  tencentSettings.tencentApiKey = "";
  const successfulResults = results.filter(result => !result.error);
  const durations = successfulResults
    .map(result => result.durationMs)
    .sort((a, b) => a - b);
  const medianDurationMs = durations.length === 0
    ? null
    : durations[Math.floor(durations.length / 2)];
  const summary = {
    cases: results.length,
    succeeded: successfulResults.length,
    failed: results.length - successfulResults.length,
    medianDurationMs,
    totalDurationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    providerRequests: results.reduce((sum, result) => sum + result.providerRequests, 0),
    retries: results.reduce((sum, result) => sum + result.retries, 0),
    networkRequests: results.reduce((sum, result) => sum + result.networkRequests, 0),
  };

  fs.writeFileSync(outputPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    provider: "tencent",
    summary,
    cases: results,
    credentialsWritten: false,
  }, null, 2));

  console.log(JSON.stringify({
    ...summary,
    outputPath,
    credentialsWritten: false,
  }));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, timedTranslate };
