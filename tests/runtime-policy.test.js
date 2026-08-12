"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const policy = require("../shared/runtime-policy.js");

test("fresh installs require explicit provider selection", () => {
  assert.equal(policy.DEFAULT_SERVICE, "none");
  assert.equal(policy.SETTINGS_VERSION, 4);
  assert.deepEqual(policy.AVAILABLE_SERVICES, ["tencent"]);
  assert.deepEqual(policy.RETIRED_SETTING_KEYS, [
    "microsoftTargetLang",
    "microsoftComposeLang",
    "tencentSecretId",
    "tencentSecretKey",
    "tencentRegion",
    "tencentProjectId",
    "tencentUsageChars",
  ]);
  assert.equal(policy.normalizeService("tencent"), "tencent");
  assert.equal(policy.normalizeService("microsoft"), "none");
  assert.equal(policy.normalizeService("unknown"), "none");
});

test("read, compose, and control requests have bounded purpose-specific timeouts", () => {
  assert.equal(policy.requestTimeout("doTranslate", "read"), 5 * 60 * 1000);
  assert.equal(policy.requestTimeout("doTranslateSelection", "compose"), 2 * 60 * 1000);
  assert.equal(policy.requestTimeout("getState", "read"), 30 * 1000);
});

test("network failures are normalized and long provider errors are bounded", () => {
  assert.equal(policy.normalizeError(new Error("TypeError: Failed to fetch")), "Server unreachable");
  assert.ok(policy.normalizeError("x".repeat(500)).length <= 240);
});

test("cancellation errors are recognized without hiding ordinary failures", () => {
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  assert.equal(policy.isCancellationError(abortError), true);
  assert.equal(policy.isCancellationError(new Error("Translation cancelled")), true);
  assert.equal(policy.isCancellationError(new Error("Tencent quota exceeded")), false);
});
