"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomInt } = require("node:crypto");
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

function readPreference(contents, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = contents.match(new RegExp(
    `^user_pref\\("${escaped}",\\s*(.*?)\\);\\r?$`,
    "m"
  ));
  return match ? JSON.parse(match[1]) : "";
}

async function timedTranslate(fn) {
  const started = performance.now();
  try {
    const result = await fn();
    return {
      output: result.translated,
      detectedLang: result.detectedLang || null,
      usedAmount: result.usedAmount ?? null,
      durationMs: Math.round(performance.now() - started),
      error: null,
    };
  } catch (error) {
    return {
      output: null,
      detectedLang: null,
      usedAmount: null,
      durationMs: Math.round(performance.now() - started),
      error: error.message,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const outputPath = path.resolve(args.output || "translation-quality-results.json");
  const keyPath = path.resolve(args.key || "translation-quality-key.json");
  const prefsPath = path.resolve(args["zotero-prefs"] || "");
  if (!prefsPath || !fs.existsSync(prefsPath)) {
    throw new Error("--zotero-prefs must point to an existing Zotero prefs.js");
  }

  const cases = JSON.parse(fs.readFileSync(
    path.join(__dirname, "translation-quality-cases.json"),
    "utf8"
  ));
  let prefs = fs.readFileSync(prefsPath, "utf8");
  const prefix = "extensions.zotero.ZoteroPDFTranslate.tencent.";
  const tencentSettings = {
    tencentSecretId: readPreference(prefs, prefix + "secretId"),
    tencentSecretKey: readPreference(prefs, prefix + "secretKey"),
    tencentRegion: readPreference(prefs, prefix + "region") || "ap-shanghai",
    tencentProjectId: readPreference(prefs, prefix + "projectId") || "0",
  };
  prefs = "";
  if (!tencentSettings.tencentSecretId || !tencentSettings.tencentSecretKey) {
    throw new Error("Tencent credentials were not found in the selected Zotero prefs.js");
  }

  const blindCases = [];
  const key = {
    createdAt: new Date().toISOString(),
    cases: {},
  };

  for (const testCase of cases) {
    const target = testCase.direction.endsWith("-zh") ? "zh" : "en";
    const microsoft = await timedTranslate(() =>
      providers.translateWithMicrosoft(testCase.source, target)
    );
    const tencent = await timedTranslate(() =>
      providers.translateWithTencent(testCase.source, target, tencentSettings)
    );
    const swap = randomInt(2) === 1;
    const candidates = swap
      ? { A: tencent.output, B: microsoft.output }
      : { A: microsoft.output, B: tencent.output };

    blindCases.push({
      id: testCase.id,
      direction: testCase.direction,
      category: testCase.category,
      source: testCase.source,
      critical_checks: testCase.critical_checks,
      candidates,
    });
    key.cases[testCase.id] = {
      A: swap ? "tencent" : "microsoft",
      B: swap ? "microsoft" : "tencent",
      microsoft: {
        durationMs: microsoft.durationMs,
        detectedLang: microsoft.detectedLang,
        error: microsoft.error,
      },
      tencent: {
        durationMs: tencent.durationMs,
        detectedLang: tencent.detectedLang,
        usedAmount: tencent.usedAmount,
        error: tencent.error,
      },
    };
  }

  tencentSettings.tencentSecretId = "";
  tencentSettings.tencentSecretKey = "";
  fs.writeFileSync(outputPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    rubric: {
      accuracy: "0-5: meaning, conditions, causality, and omissions",
      terminology: "0-5: domain and professional wording",
      fluency: "0-5: natural target-language prose",
      fidelity: "0-5: numbers, units, names, and formatting",
    },
    cases: blindCases,
  }, null, 2));
  fs.writeFileSync(keyPath, JSON.stringify(key, null, 2));

  console.log(JSON.stringify({
    cases: blindCases.length,
    outputPath,
    keyPath,
    credentialsWritten: false,
  }));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
