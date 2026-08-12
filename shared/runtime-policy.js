"use strict";

// Runtime policy shared by the background page, message content script, and
// Node-based regression tests. Keep service selection and timeout behavior in
// one place so a provider outage cannot silently become a new default.
(function initializeTranslatorRuntimePolicy(root) {
  const DEFAULT_SERVICE = "none";
  const AVAILABLE_SERVICES = Object.freeze(["tencent"]);
  const RETIRED_SETTING_KEYS = Object.freeze([
    "microsoftTargetLang",
    "microsoftComposeLang",
    "tencentSecretId",
    "tencentSecretKey",
    "tencentRegion",
    "tencentProjectId",
    "tencentUsageChars",
  ]);
  const SETTINGS_VERSION = 4;
  const READ_TRANSLATION_TIMEOUT_MS = 5 * 60 * 1000;
  const COMPOSE_TRANSLATION_TIMEOUT_MS = 2 * 60 * 1000;
  const CONTROL_REQUEST_TIMEOUT_MS = 30 * 1000;
  const MAX_ERROR_DETAIL_LENGTH = 240;

  function requestTimeout(command, mode = "read") {
    if (command === "doTranslate") return READ_TRANSLATION_TIMEOUT_MS;
    if (command === "doTranslateSelection" || mode === "compose") {
      return COMPOSE_TRANSLATION_TIMEOUT_MS;
    }
    return CONTROL_REQUEST_TIMEOUT_MS;
  }

  function normalizeService(service) {
    return AVAILABLE_SERVICES.includes(service) ? service : DEFAULT_SERVICE;
  }

  function normalizeError(error) {
    const raw = typeof error === "string" ? error : error?.message;
    const message = String(raw || "Translation failed").trim();
    if (/Failed to fetch|NetworkError/i.test(message)) return "Server unreachable";
    if (message.length <= MAX_ERROR_DETAIL_LENGTH) return message;
    return `${message.slice(0, MAX_ERROR_DETAIL_LENGTH - 1)}…`;
  }

  function isCancellationError(error) {
    const message = typeof error === "string" ? error : error?.message;
    return error?.name === "AbortError" || /translation cancelled/i.test(String(message || ""));
  }

  const api = {
    DEFAULT_SERVICE,
    AVAILABLE_SERVICES,
    RETIRED_SETTING_KEYS,
    SETTINGS_VERSION,
    READ_TRANSLATION_TIMEOUT_MS,
    COMPOSE_TRANSLATION_TIMEOUT_MS,
    CONTROL_REQUEST_TIMEOUT_MS,
    requestTimeout,
    normalizeService,
    normalizeError,
    isCancellationError,
  };

  root.TranslatorRuntimePolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
