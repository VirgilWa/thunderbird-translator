"use strict";

const DEFAULT_SERVICE = TranslatorRuntimePolicy.DEFAULT_SERVICE;
const CURRENT_SETTINGS_VERSION = TranslatorRuntimePolicy.SETTINGS_VERSION;
const DEFAULT_TENCENT_MODEL = TranslatorProviders.constants.DEFAULT_TENCENT_MODEL;
const SELECTABLE_SERVICES = new Set(TranslatorRuntimePolicy.AVAILABLE_SERVICES);

const SERVICE_INFO = {
  tencent: {
    label: "Tencent TokenHub (Hy-MT2)",
    serviceUrl: "https://cloud.tencent.com/product/tokenhub",
    targetLangKey: "tencentTargetLang",
    composeLangKey: "tencentComposeLang",
  },
};

const LANGUAGE_NAMES = {
  en: "English",
  it: "italiano",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  nl: "Nederlands",
  pt: "Português",
  ru: "Русский",
  ja: "日本語",
  zh: "中文",
  ko: "한국어",
  ar: "العربية",
  tr: "Türkçe",
  pl: "Polski",
  tl: "Filipino",
};

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "nl", label: "Nederlands" },
  { value: "de", label: "Deutsch" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
  { value: "it", label: "Italiano" },
  { value: "pt", label: "Português" },
  { value: "ru", label: "Русский" },
  { value: "ja", label: "日本語" },
  { value: "zh", label: "中文" },
  { value: "ko", label: "한국어" },
  { value: "ar", label: "العربية" },
  { value: "tr", label: "Türkçe" },
  { value: "pl", label: "Polski" },
  { value: "tl", label: "Filipino" },
];

const LANG_STORAGE_KEY = {
  tencent: "tencentTargetLang",
};

const COMPOSE_LANG_KEY = {
  tencent: "tencentComposeLang",
};

// --- Settings ---

const SETTINGS_DEFAULTS = Object.freeze({
  service: DEFAULT_SERVICE,
  settingsVersion: 0,
  tencentTargetLang: "en",
  tencentComposeLang: "en",
  tencentApiKey: "",
  tencentModel: DEFAULT_TENCENT_MODEL,
  autoTranslate: false,
  neverTranslateLangs: [],
});
const SETTINGS_STORAGE_KEYS = new Set(Object.keys(SETTINGS_DEFAULTS));
let cachedSettings = null;
let settingsLoadPromise = null;

function i18n(key, substitutions = [], fallback = "") {
  const translated = browser.i18n.getMessage(key, substitutions);
  return translated || fallback || key;
}

function normalizedError(error) {
  if (TranslatorRuntimePolicy.isCancellationError(error)) {
    return i18n("translationCancelled", [], "Translation cancelled");
  }
  return TranslatorRuntimePolicy.normalizeError(error);
}

function readButtonTitle(settings) {
  if (!SELECTABLE_SERVICES.has(settings.service)) {
    return i18n("setUpTranslation", [], "Set up translation");
  }
  const langKey = LANG_STORAGE_KEY[settings.service];
  const lang = (settings[langKey] || "en").toUpperCase();
  return i18n("translateLanguage", [lang], `Translate (${lang})`);
}

function composeButtonTitle(settings) {
  if (!SELECTABLE_SERVICES.has(settings.service)) {
    return i18n("setUpTranslation", [], "Set up translation");
  }
  const langKey = COMPOSE_LANG_KEY[settings.service];
  const lang = (settings[langKey] || "en").toUpperCase();
  return i18n("translateLanguage", [lang], `Translate (${lang})`);
}

async function updateReadButtonTitle(tabId = null) {
  const settings = await getSettings();
  const details = { title: readButtonTitle(settings) };
  if (tabId != null) details.tabId = tabId;
  await messenger.messageDisplayAction.setTitle(details);
}

async function updateComposeButtonTitle(tabId = null) {
  const settings = await getSettings();
  const details = { title: composeButtonTitle(settings) };
  if (tabId != null) details.tabId = tabId;
  await messenger.composeAction.setTitle(details);
}

async function getSettings() {
  if (cachedSettings) return cachedSettings;
  if (settingsLoadPromise) return settingsLoadPromise;

  settingsLoadPromise = loadSettings();
  try {
    cachedSettings = await settingsLoadPromise;
    return cachedSettings;
  } finally {
    settingsLoadPromise = null;
  }
}

async function loadSettings() {
  const settings = await messenger.storage.local.get(SETTINGS_DEFAULTS);
  const repairs = {};
  const normalizedService = TranslatorRuntimePolicy.normalizeService(settings.service);
  if (normalizedService !== settings.service) {
    settings.service = normalizedService;
    repairs.service = normalizedService;
  }
  if (settings.settingsVersion !== CURRENT_SETTINGS_VERSION) {
    await messenger.storage.local.remove(TranslatorRuntimePolicy.RETIRED_SETTING_KEYS);
    settings.settingsVersion = CURRENT_SETTINGS_VERSION;
    repairs.settingsVersion = CURRENT_SETTINGS_VERSION;
  }
  if (settings.service === DEFAULT_SERVICE && settings.autoTranslate) {
    settings.autoTranslate = false;
    repairs.autoTranslate = false;
  }
  const normalizedTencentModel = TranslatorProviders.normalizeTencentModel(settings.tencentModel);
  if (normalizedTencentModel !== settings.tencentModel) {
    settings.tencentModel = normalizedTencentModel;
    repairs.tencentModel = normalizedTencentModel;
  }
  for (const [service, info] of Object.entries(SERVICE_INFO)) {
    for (const key of [info.targetLangKey, info.composeLangKey]) {
      if (!TranslatorProviders.isTargetLanguageSupported(service, settings[key])) {
        settings[key] = "en";
        repairs[key] = "en";
      }
    }
  }
  if (Object.keys(repairs).length > 0) {
    await messenger.storage.local.set(repairs);
  }
  return settings;
}

messenger.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (Object.keys(changes).some(key => SETTINGS_STORAGE_KEYS.has(key))) {
    cachedSettings = null;
  }
});

async function writeSettings(updates) {
  await messenger.storage.local.set(updates);
  cachedSettings = null;
}

function currentLocalMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

let tencentUsageWriteQueue = Promise.resolve();
let pendingTencentInputTokens = 0;
let pendingTencentOutputTokens = 0;
let tencentUsageFlushTimer = null;

async function getStoredTencentUsageSummary() {
  const month = currentLocalMonth();
  const stored = await messenger.storage.local.get({
    tencentUsageMonth: "",
    tencentUsageInputTokens: 0,
    tencentUsageOutputTokens: 0,
  });
  return {
    month,
    inputTokens: stored.tencentUsageMonth === month
      ? Math.max(0, Number(stored.tencentUsageInputTokens) || 0)
      : 0,
    outputTokens: stored.tencentUsageMonth === month
      ? Math.max(0, Number(stored.tencentUsageOutputTokens) || 0)
      : 0,
  };
}

async function getTencentUsageSummary() {
  await tencentUsageWriteQueue.catch(() => undefined);
  const summary = await getStoredTencentUsageSummary();
  return {
    ...summary,
    inputTokens: summary.inputTokens + pendingTencentInputTokens,
    outputTokens: summary.outputTokens + pendingTencentOutputTokens,
  };
}

function scheduleTencentUsage(inputTokens, outputTokens) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  if (input <= 0 && output <= 0) return;

  pendingTencentInputTokens += input;
  pendingTencentOutputTokens += output;
  if (tencentUsageFlushTimer != null) clearTimeout(tencentUsageFlushTimer);
  tencentUsageFlushTimer = setTimeout(() => {
    tencentUsageFlushTimer = null;
    flushTencentUsage().catch(error => {
      console.warn("[Translator] Could not persist Tencent usage:", error.message);
    });
  }, 5000);
}

function flushTencentUsage() {
  if (tencentUsageFlushTimer != null) {
    clearTimeout(tencentUsageFlushTimer);
    tencentUsageFlushTimer = null;
  }

  const inputTokens = pendingTencentInputTokens;
  const outputTokens = pendingTencentOutputTokens;
  pendingTencentInputTokens = 0;
  pendingTencentOutputTokens = 0;
  if (inputTokens <= 0 && outputTokens <= 0) return tencentUsageWriteQueue;

  tencentUsageWriteQueue = tencentUsageWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const summary = await getStoredTencentUsageSummary();
      await messenger.storage.local.set({
        tencentUsageMonth: summary.month,
        tencentUsageInputTokens: summary.inputTokens + inputTokens,
        tencentUsageOutputTokens: summary.outputTokens + outputTokens,
      });
    });
  return tencentUsageWriteQueue;
}

function safeMetricInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function recordTranslationPerformance(message) {
  const metrics = message?.metrics;
  if (!metrics || typeof metrics !== "object") return Promise.resolve();

  return messenger.storage.local.set({
    lastTranslationPerformance: {
      version: 1,
      extensionVersion: messenger.runtime.getManifest().version,
      completedAt: new Date().toISOString(),
      success: message.success === true,
      cancelled: message.cancelled === true,
      cacheHit: metrics.cacheHit === true,
      durationMs: safeMetricInteger(metrics.durationMs),
      sourceSegments: safeMetricInteger(metrics.sourceSegments),
      scheduledTasks: safeMetricInteger(metrics.scheduledTasks),
      deduplicatedSegments: safeMetricInteger(metrics.deduplicatedSegments),
      providerRequests: safeMetricInteger(metrics.providerRequests),
      retryCount: safeMetricInteger(metrics.retryCount),
      networkRequests: safeMetricInteger(metrics.networkRequests),
    },
  });
}

function finishTranslationAccounting(message) {
  Promise.allSettled([
    flushTencentUsage(),
    recordTranslationPerformance(message),
  ]).then(results => {
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[Translator] Could not persist translation metrics:", result.reason);
      }
    }
  });
}

// --- Register content scripts ---

async function injectReadScriptsIntoOpenMessages() {
  if (!messenger.tabs?.executeScript || !messenger.messageDisplay?.getDisplayedMessage) return;

  const tabs = await messenger.tabs.query({});
  let injectedCount = 0;
  for (const tab of tabs) {
    if (tab?.id == null) continue;
    try {
      const displayedMessage = await messenger.messageDisplay.getDisplayedMessage(tab.id);
      if (!displayedMessage) continue;
      await messenger.tabs.executeScript(tab.id, {
        code: "window.__thunderbirdTranslatorSkipAutoTranslateOnce = true;",
      });
      await messenger.tabs.executeScript(tab.id, { file: "shared/runtime-policy.js" });
      await messenger.tabs.executeScript(tab.id, { file: "content/translator.js" });
      injectedCount += 1;
    } catch (error) {
      console.warn(
        `[Translator] Could not inject into open message tab ${tab.id}:`,
        error.message
      );
    }
  }
  if (injectedCount > 0) {
    console.log(`[Translator] Injected into ${injectedCount} open message tab(s)`);
  }
}

if (messenger.messageDisplayScripts) {
  messenger.messageDisplayScripts.register({
    js: [
      { file: "shared/runtime-policy.js" },
      { file: "content/translator.js" },
    ],
  }).then(async () => {
    console.log("[Translator] messageDisplayScripts registered");
    await injectReadScriptsIntoOpenMessages();
  }).catch(e => {
    console.warn("[Translator] messageDisplayScripts.register failed:", e.message);
  });
}

if (messenger.composeScripts) {
  messenger.composeScripts.register({
    js: [
      { file: "shared/runtime-policy.js" },
      { file: "content/composer.js" },
    ],
  }).then(() => {
    console.log("[Translator] composeScripts registered");
  }).catch(e => {
    console.warn("[Translator] composeScripts.register failed:", e.message);
  });
}

updateReadButtonTitle();
updateComposeButtonTitle();

// --- Detected language cache (tabId → lang code) ---
// Populated from provider translation responses.
// Cleared when a new message is displayed in that tab.

const detectedLangByTab = new Map();

// Tracks tabs where auto-translate is currently running.
// The Never/Always toggle is disabled while translation is in progress.
const translatingTabs = new Set();
const readProgressStateByTab = new Map();

messenger.messageDisplay.onMessageDisplayed.addListener((tab) => {
  if (tab?.id != null) {
    detectedLangByTab.delete(tab.id);
    translatingTabs.delete(tab.id);
    readProgressStateByTab.delete(tab.id);
    messenger.messageDisplayAction.setBadgeText({ tabId: tab.id, text: "" });
    updateReadButtonTitle(tab.id).catch(error => {
      console.warn("[Translator] Could not refresh action title:", error.message);
    });
  }
});

messenger.tabs.onRemoved.addListener((tabId) => {
  translatingTabs.delete(tabId);
  readProgressStateByTab.delete(tabId);
  const port = portMap.get(tabId);
  if (port) abortPortProviderRequests(port);
  portMap.delete(tabId);
  detectedLangByTab.delete(tabId);
});

// --- Port management ---

const portMap        = new Map();
const framePortMap   = new Map();
const composePortMap = new Map();
let lastActivePort   = null;

const pendingPopupRequests = new Map();
let nextPopupReqId = 0;

// Each content request owns an AbortController. The controller is cancelled
// when the user clicks the action again, the content script disconnects, or
// the message tab closes.
const providerRequestControllers = new Map();

function beginProviderRequest(port, requestId) {
  let requests = providerRequestControllers.get(port);
  if (!requests) {
    requests = new Map();
    providerRequestControllers.set(port, requests);
  }
  requests.get(requestId)?.abort();
  const controller = new AbortController();
  requests.set(requestId, controller);
  return controller;
}

function endProviderRequest(port, requestId, controller) {
  const requests = providerRequestControllers.get(port);
  if (!requests || requests.get(requestId) !== controller) return;
  requests.delete(requestId);
  if (requests.size === 0) providerRequestControllers.delete(port);
}

function cancelProviderRequest(port, requestId) {
  providerRequestControllers.get(port)?.get(requestId)?.abort();
}

function abortPortProviderRequests(port) {
  const requests = providerRequestControllers.get(port);
  if (!requests) return;
  for (const controller of requests.values()) controller.abort();
  providerRequestControllers.delete(port);
}

function sendToTabPort(tabId, command, extra = {}) {
  return new Promise((resolve, reject) => {
    const port = portMap.get(tabId);
    if (!port) { reject(new Error("No content script for this tab")); return; }
    const reqId = nextPopupReqId++;
    const timeoutMs = TranslatorRuntimePolicy.requestTimeout(command, "read");
    const timeoutId = setTimeout(() => {
      pendingPopupRequests.delete(reqId);
      const timeoutError = `Content script timeout after ${Math.round(timeoutMs / 1000)}s`;
      if (command === "doTranslate") {
        try {
          port.postMessage({ command: "doCancel", reqId: null, reason: timeoutError });
        } catch {
          // The timeout below remains the authoritative result.
        }
      }
      reject(new Error(timeoutError));
    }, timeoutMs);
    pendingPopupRequests.set(reqId, { resolve, reject, timeoutId, port });
    port.postMessage({ command, reqId, ...extra });
  });
}

function sendToComposePort(windowId, command, extra = {}) {
  return new Promise((resolve, reject) => {
    const port = composePortMap.get(windowId);
    if (!port) { reject(new Error("No compose content script for this window")); return; }
    const reqId = nextPopupReqId++;
    const timeoutMs = TranslatorRuntimePolicy.requestTimeout(command, "compose");
    const timeoutId = setTimeout(() => {
      pendingPopupRequests.delete(reqId);
      const timeoutError = `Compose script timeout after ${Math.round(timeoutMs / 1000)}s`;
      if (command === "doTranslateSelection") {
        try {
          port.postMessage({ command: "doCancelSelection", reqId: null });
        } catch {
          // The timeout below remains the authoritative result.
        }
      }
      reject(new Error(timeoutError));
    }, timeoutMs);
    pendingPopupRequests.set(reqId, { resolve, reject, timeoutId, port });
    port.postMessage({ command, reqId, ...extra });
  });
}

function resolvePending(reqId, result) {
  const pending = pendingPopupRequests.get(reqId);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  pendingPopupRequests.delete(reqId);
  pending.resolve(result);
}

async function showReadProgress(tabId, current = null, total = null) {
  translatingTabs.add(tabId);
  let state = readProgressStateByTab.get(tabId);
  if (!state) {
    state = { title: null };
    readProgressStateByTab.set(tabId, state);
    await Promise.all([
      messenger.messageDisplayAction.setBadgeText({ tabId, text: "…" }),
      messenger.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#f90" }),
    ]);
  }
  const title = current != null && total != null
    ? i18n(
      "translationProgress",
      [String(current), String(total)],
      `Translating ${current}/${total} — click again to cancel`
    )
    : i18n("translationStarting", [], "Translating — click again to cancel");
  if (state.title === title) return;
  state.title = title;
  await messenger.messageDisplayAction.setTitle({ tabId, title });
}

async function clearReadStatus(tabId) {
  translatingTabs.delete(tabId);
  readProgressStateByTab.delete(tabId);
  await messenger.messageDisplayAction.setBadgeText({ tabId, text: "" });
  await updateReadButtonTitle(tabId);
}

async function showReadSuccess(tabId) {
  translatingTabs.delete(tabId);
  readProgressStateByTab.delete(tabId);
  await messenger.messageDisplayAction.setBadgeText({ tabId, text: "✓" });
  await messenger.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#1a7f37" });
  await updateReadButtonTitle(tabId);
  setTimeout(() => {
    Promise.resolve(
      messenger.messageDisplayAction.setBadgeText({ tabId, text: "" })
    ).catch(() => undefined);
  }, 2000);
}

async function showReadFailure(tabId, error) {
  translatingTabs.delete(tabId);
  readProgressStateByTab.delete(tabId);
  const detail = normalizedError(error);
  await messenger.messageDisplayAction.setBadgeText({ tabId, text: "!" });
  await messenger.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#c00" });
  await messenger.messageDisplayAction.setTitle({
    tabId,
    title: i18n("translationFailedDetail", [detail], `Translation failed: ${detail}`),
  });
}

async function showComposeFailure(tabId, error) {
  const detail = normalizedError(error);
  await messenger.composeAction.setBadgeText({ tabId, text: "!" });
  await messenger.composeAction.setBadgeBackgroundColor({ tabId, color: "#c00" });
  await messenger.composeAction.setTitle({
    tabId,
    title: i18n("translationFailedDetail", [detail], `Translation failed: ${detail}`),
  });
}

messenger.runtime.onConnect.addListener((port) => {

  // --- Read-mode content script ---
  if (port.name === "translator") {
    const tabId   = port.sender?.tab?.id ?? null;
    const frameId = port.sender?.frameId ?? 0;
    const fKey    = `${tabId}-${frameId}`;

    if (tabId != null) portMap.set(tabId, port);
    framePortMap.set(fKey, port);
    lastActivePort = port;

    port.onDisconnect.addListener(() => {
      abortPortProviderRequests(port);
      flushTencentUsage().catch(() => undefined);
      if (tabId != null && portMap.get(tabId) === port) portMap.delete(tabId);
      framePortMap.delete(fKey);
      if (lastActivePort === port) {
        lastActivePort = portMap.size > 0 ? [...portMap.values()].at(-1) : null;
      }
      if (tabId != null) detectedLangByTab.delete(tabId);
      for (const [reqId, pending] of pendingPopupRequests.entries()) {
        if (pending.port === port) {
          clearTimeout(pending.timeoutId);
          pendingPopupRequests.delete(reqId);
          pending.reject(new Error("Content script disconnected"));
        }
      }
    });

    port.onMessage.addListener(async (message) => {

      if (message.command === "cancelTranslate") {
        cancelProviderRequest(port, message.id);
        return;
      }

      // Translate API request
      if (message.command === "translate") {
        const controller = beginProviderRequest(port, message.id);
        try {
          const settings = await getSettings();
          const sourceLang = tabId != null ? (detectedLangByTab.get(tabId) || null) : null;
          const result = await translateText(
            message.text,
            settings,
            null,
            sourceLang,
            { signal: controller.signal }
          );
          const { translated, detectedLang } = result;
          // Cache the provider-reported source language.
          if (tabId != null && detectedLang && !detectedLangByTab.has(tabId)) {
            detectedLangByTab.set(tabId, detectedLang);
          }
          port.postMessage({
            id: message.id,
            success: true,
            translated,
            provider: result.provider,
            fallbackFrom: result.fallbackFrom || null,
            requestCount: result.requestCount || 0,
            retryCount: result.retryCount || 0,
          });
        } catch (e) {
          port.postMessage({ id: message.id, success: false, error: normalizedError(e) });
        } finally {
          endProviderRequest(port, message.id, controller);
        }
        return;
      }

      if (message.command === "translateBatch") {
        const controller = beginProviderRequest(port, message.id);
        try {
          const settings = await getSettings();
          const sourceLang = tabId != null ? (detectedLangByTab.get(tabId) || null) : null;
          const result = await translateBatchText(
            message.texts,
            settings,
            null,
            sourceLang,
            { signal: controller.signal }
          );
          if (tabId != null && result.detectedLang && !detectedLangByTab.has(tabId)) {
            detectedLangByTab.set(tabId, result.detectedLang);
          }
          port.postMessage({
            id: message.id,
            success: true,
            translations: result.translations,
            provider: result.provider,
            fallbackFrom: null,
            requestCount: result.requestCount || 0,
            retryCount: result.retryCount || 0,
          });
        } catch (e) {
          port.postMessage({ id: message.id, success: false, error: normalizedError(e) });
        } finally {
          endProviderRequest(port, message.id, controller);
        }
        return;
      }

      // Exemption check: called after auto-translate completes.
      if (message.command === "checkExemption") {
        try {
          const settings = await getSettings();
          const { neverTranslateLangs = [] } = settings;
          let detectedLang = tabId != null ? (detectedLangByTab.get(tabId) || null) : null;

          const shouldRevert = !!(detectedLang && neverTranslateLangs.includes(detectedLang));
          port.postMessage({ id: message.id, success: true, shouldRevert });
        } catch (e) {
          port.postMessage({ id: message.id, success: false, error: e.message });
        }
        return;
      }

      // Subject translation request
      if (message.command === "getTranslatedSubject") {
        const controller = beginProviderRequest(port, message.id);
        try {
          const msg = await messenger.messageDisplay.getDisplayedMessage(tabId);
          const subject = msg?.subject || "";
          if (!subject) {
            port.postMessage({
              id: message.id,
              success: true,
              translated: null,
              requestCount: 0,
              retryCount: 0,
            });
            return;
          }
          const settings = await getSettings();
          const sourceLang = tabId != null ? (detectedLangByTab.get(tabId) || null) : null;
          const result = await translateText(
            subject,
            settings,
            null,
            sourceLang,
            { signal: controller.signal }
          );
          const actualService = result.provider || settings.service;
          const actualInfo = SERVICE_INFO[actualService] || { label: actualService };
          const fallbackInfo = result.fallbackFrom ? SERVICE_INFO[result.fallbackFrom] : null;
          const serviceLabel = fallbackInfo
            ? `${actualInfo.label} (fallback from ${fallbackInfo.label})`
            : actualInfo.label;
          const serviceUrl = actualInfo.urlKey
            ? settings[actualInfo.urlKey]
            : actualInfo.serviceUrl || null;
          port.postMessage({
            id: message.id,
            success: true,
            translated: result.translated,
            serviceLabel,
            serviceUrl,
            requestCount: result.requestCount || 0,
            retryCount: result.retryCount || 0,
          });
        } catch (e) {
          port.postMessage({ id: message.id, success: false, error: normalizedError(e) });
        } finally {
          endProviderRequest(port, message.id, controller);
        }
        return;
      }

      if (["translateDone", "revertDone", "stateDone", "cancelDone"].includes(message.command)) {
        if (message.command === "translateDone") finishTranslationAccounting(message);
        resolvePending(message.reqId, message);
        return;
      }

      if (message.command === "translationProgress") {
        if (tabId != null) await showReadProgress(tabId, message.current, message.total);
        return;
      }

      if (message.command === "setBadge") {
        if (tabId != null) await showReadProgress(tabId);
        return;
      }
      if (message.command === "clearBadge") {
        if (tabId == null) return;
        finishTranslationAccounting(message);
        if (message.cancelled) await clearReadStatus(tabId);
        else if (message.success) await showReadSuccess(tabId);
        else await showReadFailure(tabId, message.error);
        return;
      }
    });
    return;
  }

  // --- Compose content script ---
  if (port.name === "translator-composer") {
    const windowId = port.sender?.tab?.windowId ?? null;
    if (windowId != null) composePortMap.set(windowId, port);

    port.onDisconnect.addListener(() => {
      abortPortProviderRequests(port);
      flushTencentUsage().catch(() => undefined);
      if (windowId != null) composePortMap.delete(windowId);
      for (const [reqId, pending] of pendingPopupRequests.entries()) {
        if (pending.port === port) {
          clearTimeout(pending.timeoutId);
          pendingPopupRequests.delete(reqId);
          pending.reject(new Error("Compose script disconnected"));
        }
      }
    });

    port.onMessage.addListener(async (message) => {
      if (message.command === "cancelTranslate") {
        cancelProviderRequest(port, message.id);
        return;
      }
      if (message.command === "translate") {
        const controller = beginProviderRequest(port, message.id);
        try {
          const settings = await getSettings();
          const composeLangKey = COMPOSE_LANG_KEY[settings.service];
          const targetLang = settings[composeLangKey] || "en";
          const { translated } = await translateText(
            message.text,
            settings,
            targetLang,
            null,
            { signal: controller.signal }
          );
          port.postMessage({ id: message.id, success: true, translated });
        } catch (e) {
          port.postMessage({ id: message.id, success: false, error: normalizedError(e) });
        } finally {
          endProviderRequest(port, message.id, controller);
        }
        return;
      }
      if (message.command === "translateSelectionDone") {
        resolvePending(message.reqId, message);
      }
    });
    return;
  }
});

// --- Translation APIs ---
// All return { translated: string, detectedLang: string|null }

async function translateUsingService(
  service,
  text,
  targetLang,
  settings,
  sourceLang,
  requestOptions = {}
) {
  let result;
  switch (service) {
    case "tencent":
      result = await TranslatorProviders.translateWithTencent(
        text,
        targetLang,
        settings,
        requestOptions
      );
      scheduleTencentUsage(result.inputTokens, result.outputTokens);
      break;
    default:
      throw new Error(`Unknown service: ${service}`);
  }
  return { ...result, provider: service, fallbackFrom: null };
}

async function translateBatchText(
  texts,
  settings,
  targetLangOverride,
  sourceLang,
  requestOptions = {}
) {
  if (!Array.isArray(texts)) throw new Error("Translation batch must be an array");
  const service = settings.service || DEFAULT_SERVICE;
  if (!SELECTABLE_SERVICES.has(service)) {
    throw new Error(i18n(
      "chooseProviderError",
      [],
      "Choose an available translation provider in add-on settings."
    ));
  }
  const serviceInfo = SERVICE_INFO[service];
  if (!serviceInfo) throw new Error(`Unknown service: ${service}`);
  const targetLang = targetLangOverride || settings[serviceInfo.targetLangKey] || "en";
  if (!TranslatorProviders.isTargetLanguageSupported(service, targetLang)) {
    throw new Error(`Unsupported target language for ${service}: ${targetLang}`);
  }

  if (service !== "tencent") throw new Error(`Unknown service: ${service}`);
  const result = await TranslatorProviders.translateBatchWithTencent(
    texts,
    targetLang,
    settings,
    requestOptions
  );
  scheduleTencentUsage(result.inputTokens, result.outputTokens);
  return { ...result, provider: service, fallbackFrom: null, sourceLang };
}

async function translateText(
  text,
  settings,
  targetLangOverride,
  sourceLang,
  requestOptions = {}
) {
  const service = settings.service || DEFAULT_SERVICE;
  if (!SELECTABLE_SERVICES.has(service)) {
    throw new Error(i18n(
      "chooseProviderError",
      [],
      "Choose an available translation provider in add-on settings."
    ));
  }
  const serviceInfo = SERVICE_INFO[service];
  if (!serviceInfo) throw new Error(`Unknown service: ${service}`);

  const targetLang = targetLangOverride || settings[serviceInfo.targetLangKey] || "en";
  if (!TranslatorProviders.isTargetLanguageSupported(service, targetLang)) {
    throw new Error(`Unsupported target language for ${service}: ${targetLang}`);
  }
  return TranslatorRouter.translateWithFallback({
    service,
    text,
    targetLang,
    settings,
    sourceLang,
    requestOptions,
    translateUsingService,
  });
}

// --- Context menu ---

browser.menus.create({
  id: "auto-translate",
  title: i18n("autoTranslate", [], "Auto-translate"),
  type: "checkbox",
  checked: false,
  contexts: ["message_display_action"],
});

browser.menus.create({
  id: "sep-1",
  type: "separator",
  contexts: ["message_display_action"],
});

browser.menus.create({
  id: "translate-to-read",
  title: i18n("translateTo", [], "Translate to"),
  contexts: ["message_display_action"],
});
for (const lang of LANGUAGES) {
  browser.menus.create({
    id: `read-lang-${lang.value}`,
    parentId: "translate-to-read",
    title: lang.label,
    type: "radio",
    checked: lang.value === "en",
    contexts: ["message_display_action"],
  });
}

browser.menus.create({
  id: "sep-never",
  type: "separator",
  contexts: ["message_display_action"],
});

browser.menus.create({
  id: "never-translate-toggle",
  title: i18n("neverAutoTranslate", [], "Never auto-translate"),
  type: "normal",
  enabled: false,
  contexts: ["message_display_action"],
});

browser.menus.create({
  id: "translate-to-compose",
  title: i18n("translateTo", [], "Translate to"),
  contexts: ["compose_action"],
});
for (const lang of LANGUAGES) {
  browser.menus.create({
    id: `compose-lang-${lang.value}`,
    parentId: "translate-to-compose",
    title: lang.label,
    type: "radio",
    checked: lang.value === "en",
    contexts: ["compose_action"],
  });
}

browser.menus.onShown.addListener(async (info, tab) => {
  const isRead    = info.contexts.includes("message_display_action");
  const isCompose = info.contexts.includes("compose_action");
  if (!isRead && !isCompose) return;

  const settings = await getSettings();
  const tabId = tab?.id ?? null;
  const hasProvider = SELECTABLE_SERVICES.has(settings.service);

  if (isRead) {
    await browser.menus.update("auto-translate", {
      checked: hasProvider && settings.autoTranslate,
      enabled: hasProvider,
    });
    await browser.menus.update("sep-1", { visible: hasProvider });
    await browser.menus.update("translate-to-read", { visible: hasProvider });
    await browser.menus.update("sep-never", { visible: hasProvider });
    await browser.menus.update("never-translate-toggle", { visible: hasProvider });

    const readLangKey    = LANG_STORAGE_KEY[settings.service];
    const activeReadLang = settings[readLangKey] || "en";
    for (const lang of LANGUAGES) {
      const visible = TranslatorProviders.isTargetLanguageSupported(settings.service, lang.value);
      await browser.menus.update(`read-lang-${lang.value}`, {
        checked: hasProvider && visible && lang.value === activeReadLang,
        visible: hasProvider && visible,
      });
    }

    if (!hasProvider || !settings.autoTranslate) {
      await browser.menus.update("never-translate-toggle", {
        title: i18n("neverAutoTranslate", [], "Never auto-translate"),
        enabled: false,
      });
    } else if (tabId != null && translatingTabs.has(tabId)) {
      // Translation is currently running — disable toggle until it finishes
      await browser.menus.update("never-translate-toggle", {
        title: i18n("detectingLanguage", [], "Detecting language…"),
        enabled: false,
      });
    } else {
      let detectedLang = tabId != null ? detectedLangByTab.get(tabId) : null;

      if (detectedLang) {
        const langName   = LANGUAGE_NAMES[detectedLang] || detectedLang.toUpperCase();
        const neverLangs = settings.neverTranslateLangs || [];
        const isExcluded = neverLangs.includes(detectedLang);
        await browser.menus.update("never-translate-toggle", {
          title: isExcluded
            ? i18n("alwaysAutoTranslateLanguage", [langName], `Always auto-translate ${langName}`)
            : i18n("neverAutoTranslateLanguage", [langName], `Never auto-translate ${langName}`),
          enabled: true,
        });
      } else {
        await browser.menus.update("never-translate-toggle", {
          title: i18n("neverAutoTranslate", [], "Never auto-translate"),
          enabled: false,
        });
      }
    }
  }

  if (isCompose) {
    await browser.menus.update("translate-to-compose", { visible: hasProvider });
    const composeLangKey    = COMPOSE_LANG_KEY[settings.service];
    const activeComposeLang = settings[composeLangKey] || "en";
    for (const lang of LANGUAGES) {
      const visible = TranslatorProviders.isTargetLanguageSupported(settings.service, lang.value);
      await browser.menus.update(`compose-lang-${lang.value}`, {
        checked: hasProvider && visible && lang.value === activeComposeLang,
        visible: hasProvider && visible,
      });
    }
  }

  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "auto-translate") {
    const settings = await getSettings();
    if (!SELECTABLE_SERVICES.has(settings.service)) return;
    await writeSettings({ autoTranslate: info.checked });
    return;
  }

  if (info.menuItemId === "never-translate-toggle") {
    const tabId = tab?.id ?? null;
    const detectedLang = tabId != null ? detectedLangByTab.get(tabId) : null;
    if (!detectedLang) return;
    const { neverTranslateLangs = [] } = await messenger.storage.local.get({ neverTranslateLangs: [] });
    const isExcluded = neverTranslateLangs.includes(detectedLang);
    const updated = isExcluded
      ? neverTranslateLangs.filter(l => l !== detectedLang)
      : [...new Set([...neverTranslateLangs, detectedLang])];
    await writeSettings({ neverTranslateLangs: updated });
    return;
  }

  const { service: normalizedService } = await getSettings();
  if (!SELECTABLE_SERVICES.has(normalizedService)) return;
  if (String(info.menuItemId).startsWith("read-lang-")) {
    const lang    = info.menuItemId.replace("read-lang-", "");
    if (!TranslatorProviders.isTargetLanguageSupported(normalizedService, lang)) {
      console.warn(`[Translator] Ignoring unsupported ${normalizedService} target language: ${lang}`);
      return;
    }
    const langKey = LANG_STORAGE_KEY[normalizedService];
    await writeSettings({ [langKey]: lang });
    updateReadButtonTitle();
    return;
  }
  if (String(info.menuItemId).startsWith("compose-lang-")) {
    const lang    = info.menuItemId.replace("compose-lang-", "");
    if (!TranslatorProviders.isTargetLanguageSupported(normalizedService, lang)) {
      console.warn(`[Translator] Ignoring unsupported ${normalizedService} target language: ${lang}`);
      return;
    }
    const langKey = COMPOSE_LANG_KEY[normalizedService];
    await writeSettings({ [langKey]: lang });
    updateComposeButtonTitle();
  }
});

// --- messageDisplayAction toggle ---

messenger.messageDisplayAction.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  try {
    const state = await sendToTabPort(tabId, "getState");
    if (state.isTranslating) {
      await showReadProgress(tabId);
      await sendToTabPort(tabId, "doCancel");
      await clearReadStatus(tabId);
      return;
    }
    if (state.isTranslated) {
      await sendToTabPort(tabId, "doRevert");
      await clearReadStatus(tabId);
    } else {
      const settings = await getSettings();
      if (!SELECTABLE_SERVICES.has(settings.service)) {
        const error = i18n(
          "chooseProviderError",
          [],
          "Choose an available translation provider in add-on settings."
        );
        await showReadFailure(tabId, error);
        if (messenger.runtime.openOptionsPage) await messenger.runtime.openOptionsPage();
        return;
      }
      const langKey = SERVICE_INFO[settings.service].targetLangKey;
      const targetLang = settings[langKey] || "en";
      await showReadProgress(tabId);
      const result = await sendToTabPort(tabId, "doTranslate", { targetLang });
      if (result.cancelled) await clearReadStatus(tabId);
      else if (result.success) await showReadSuccess(tabId);
      else await showReadFailure(tabId, result.error);
    }
  } catch (e) {
    console.error("[Translator] onClicked error:", e.message);
    if (TranslatorRuntimePolicy.isCancellationError(e)) await clearReadStatus(tabId);
    else await showReadFailure(tabId, e);
  }
});

// --- composeAction ---

messenger.composeAction.onClicked.addListener(async (tab) => {
  const tabId    = tab.id;
  const windowId = tab.windowId;
  try {
    const settings = await getSettings();
    if (!SELECTABLE_SERVICES.has(settings.service)) {
      const error = i18n(
        "chooseProviderError",
        [],
        "Choose an available translation provider in add-on settings."
      );
      await showComposeFailure(tabId, error);
      if (messenger.runtime.openOptionsPage) await messenger.runtime.openOptionsPage();
      return;
    }
    await messenger.composeAction.setBadgeText({ tabId, text: "…" });
    await messenger.composeAction.setBadgeBackgroundColor({ tabId, color: "#f90" });
    await messenger.composeAction.setTitle({
      tabId,
      title: i18n("translationInProgress", [], "Translating…"),
    });
    const result = await sendToComposePort(windowId, "doTranslateSelection");
    if (result.success) {
      await messenger.composeAction.setBadgeText({ tabId, text: "✓" });
      await messenger.composeAction.setBadgeBackgroundColor({ tabId, color: "#1a7f37" });
      await updateComposeButtonTitle(tabId);
      setTimeout(() => {
        Promise.resolve(
          messenger.composeAction.setBadgeText({ tabId, text: "" })
        ).catch(() => undefined);
      }, 2000);
    } else {
      await showComposeFailure(tabId, result.error);
    }
  } catch (e) {
    console.error("[Translator] compose onClicked error:", e.message);
    await showComposeFailure(tabId, e);
  }
});

// --- Message handler (options page) ---

messenger.runtime.onMessage.addListener(async (message) => {
  if (message.command === "testTencentConnection") {
    try {
      const result = await TranslatorProviders.translateWithTencent("connection test", "zh", {
        tencentApiKey: message.tencentApiKey,
        tencentModel: message.tencentModel,
      });
      scheduleTencentUsage(result.inputTokens, result.outputTokens);
      await flushTencentUsage();
      return { success: true };
    } catch (e) {
      return { success: false, error: normalizedError(e) };
    }
  }
  if (message.command === "getTencentUsage") {
    return { success: true, ...(await getTencentUsageSummary()) };
  }
  if (message.command === "saveSettings") {
    if (!SELECTABLE_SERVICES.has(message.service)) {
      return {
        success: false,
        error: i18n(
          "chooseProviderError",
          [],
          "Choose an available translation provider in add-on settings."
        ),
      };
    }
    await writeSettings({
      service:               message.service,
      settingsVersion:       CURRENT_SETTINGS_VERSION,
      tencentApiKey:         message.tencentApiKey,
      tencentModel:          TranslatorProviders.normalizeTencentModel(message.tencentModel),
    });
    await updateReadButtonTitle();
    await updateComposeButtonTitle();
    return { success: true };
  }
});
