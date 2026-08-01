"use strict";

const DEFAULT_SERVICE = "microsoft";
const DEFAULT_TENCENT_REGION = "ap-shanghai";
const DEFAULT_TENCENT_PROJECT_ID = "0";
const TENCENT_MONTHLY_FREE_CHARS = 5000000;

const SERVICE_INFO = {
  microsoft: {
    label: "Microsoft Translator",
    serviceUrl: "https://www.microsoft.com/translator/",
    targetLangKey: "microsoftTargetLang",
    composeLangKey: "microsoftComposeLang",
  },
  tencent: {
    label: "Tencent Cloud Translation",
    serviceUrl: "https://cloud.tencent.com/product/tmt",
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
  microsoft: "microsoftTargetLang",
  tencent: "tencentTargetLang",
};

const COMPOSE_LANG_KEY = {
  microsoft: "microsoftComposeLang",
  tencent: "tencentComposeLang",
};

// --- Settings ---

async function updateReadButtonTitle() {
  const settings = await getSettings();
  const service = settings.service;
  const langKey = LANG_STORAGE_KEY[service];
  const lang = (settings[langKey] || "en").toUpperCase();
  messenger.messageDisplayAction.setTitle({ title: `Translate (${lang})` });
}

async function updateComposeButtonTitle() {
  const settings = await getSettings();
  const service = settings.service;
  const langKey = COMPOSE_LANG_KEY[service];
  const lang = (settings[langKey] || "en").toUpperCase();
  messenger.composeAction.setTitle({ title: `Translate (${lang})` });
}

async function getSettings() {
  const settings = await messenger.storage.local.get({
    service: DEFAULT_SERVICE,
    microsoftTargetLang: "en",
    tencentTargetLang: "en",
    microsoftComposeLang: "en",
    tencentComposeLang: "en",
    tencentSecretId: "",
    tencentSecretKey: "",
    tencentRegion: DEFAULT_TENCENT_REGION,
    tencentProjectId: DEFAULT_TENCENT_PROJECT_ID,
    autoTranslate: false,
    neverTranslateLangs: [],
  });
  const repairs = {};
  if (!SERVICE_INFO[settings.service]) {
    settings.service = DEFAULT_SERVICE;
    repairs.service = DEFAULT_SERVICE;
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

function currentLocalMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

let tencentUsageWriteQueue = Promise.resolve();

async function getTencentUsageSummary() {
  const month = currentLocalMonth();
  const stored = await messenger.storage.local.get({
    tencentUsageMonth: "",
    tencentUsageChars: 0,
  });
  const used = stored.tencentUsageMonth === month
    ? Math.max(0, Number(stored.tencentUsageChars) || 0)
    : 0;
  return {
    month,
    used,
    freeLimit: TENCENT_MONTHLY_FREE_CHARS,
  };
}

function recordTencentUsage(usedAmount) {
  const amount = Number(usedAmount);
  if (!Number.isFinite(amount) || amount <= 0) return Promise.resolve();

  tencentUsageWriteQueue = tencentUsageWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const summary = await getTencentUsageSummary();
      await messenger.storage.local.set({
        tencentUsageMonth: summary.month,
        tencentUsageChars: summary.used + amount,
      });
    });
  return tencentUsageWriteQueue;
}

// --- Register content scripts ---

if (messenger.messageDisplayScripts) {
  messenger.messageDisplayScripts.register({
    js: [{ file: "content/translator.js" }],
  }).then(() => {
    console.log("[Translator] messageDisplayScripts registered");
  }).catch(e => {
    console.warn("[Translator] messageDisplayScripts.register failed:", e.message);
  });
}

if (messenger.composeScripts) {
  messenger.composeScripts.register({
    js: [{ file: "content/composer.js" }],
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

messenger.messageDisplay.onMessageDisplayed.addListener((tab) => {
  if (tab?.id != null) {
    detectedLangByTab.delete(tab.id);
    translatingTabs.delete(tab.id);
    messenger.messageDisplayAction.setBadgeText({ tabId: tab.id, text: "" });
  }
});

messenger.tabs.onRemoved.addListener((tabId) => {
  translatingTabs.delete(tabId);
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

function sendToTabPort(tabId, command, extra = {}) {
  return new Promise((resolve, reject) => {
    const port = portMap.get(tabId);
    if (!port) { reject(new Error("No content script for this tab")); return; }
    const reqId = nextPopupReqId++;
    const timeoutId = setTimeout(() => {
      pendingPopupRequests.delete(reqId);
      reject(new Error("Content script timeout"));
    }, 30000);
    pendingPopupRequests.set(reqId, { resolve, reject, timeoutId, port });
    port.postMessage({ command, reqId, ...extra });
  });
}

function sendToComposePort(windowId, command, extra = {}) {
  return new Promise((resolve, reject) => {
    const port = composePortMap.get(windowId);
    if (!port) { reject(new Error("No compose content script for this window")); return; }
    const reqId = nextPopupReqId++;
    const timeoutId = setTimeout(() => {
      pendingPopupRequests.delete(reqId);
      reject(new Error("Compose script timeout"));
    }, 30000);
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

      // Translate API request
      if (message.command === "translate") {
        try {
          const settings = await getSettings();
          const sourceLang = tabId != null ? (detectedLangByTab.get(tabId) || null) : null;
          const result = await translateText(message.text, settings, null, sourceLang);
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
          });
        } catch (e) {
          port.postMessage({ id: message.id, success: false, error: e.message });
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
        try {
          const msg = await messenger.messageDisplay.getDisplayedMessage(tabId);
          const subject = msg?.subject || "";
          if (!subject) {
            port.postMessage({ id: message.id, success: true, translated: null });
            return;
          }
          const settings = await getSettings();
          const sourceLang = tabId != null ? (detectedLangByTab.get(tabId) || null) : null;
          const result = await translateText(subject, settings, null, sourceLang);
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
          });
        } catch (e) {
          port.postMessage({ id: message.id, success: false, error: e.message });
        }
        return;
      }

      if (["translateDone", "revertDone", "stateDone"].includes(message.command)) {
        resolvePending(message.reqId, message);
        return;
      }

      if (message.command === "setBadge") {
        translatingTabs.add(tabId);
        messenger.messageDisplayAction.setBadgeText({ tabId, text: "..." });
        messenger.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#f90" });
        return;
      }
      if (message.command === "clearBadge") {
        translatingTabs.delete(tabId);
        if (message.success) {
          messenger.messageDisplayAction.setBadgeText({ tabId, text: "✓" });
          messenger.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#1a7f37" });
          setTimeout(() => messenger.messageDisplayAction.setBadgeText({ tabId, text: "" }), 2000);
        } else {
          messenger.messageDisplayAction.setBadgeText({ tabId, text: "!" });
          messenger.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#c00" });
        }
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
      if (message.command === "translate") {
        try {
          const settings = await getSettings();
          const composeLangKey = COMPOSE_LANG_KEY[settings.service];
          const targetLang = settings[composeLangKey] || "en";
          const { translated } = await translateText(message.text, settings, targetLang, null);
          port.postMessage({ id: message.id, success: true, translated });
        } catch (e) {
          port.postMessage({ id: message.id, success: false, error: e.message });
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

async function translateUsingService(service, text, targetLang, settings, sourceLang) {
  let result;
  switch (service) {
    case "microsoft":
      result = await TranslatorProviders.translateWithMicrosoft(text, targetLang);
      break;
    case "tencent":
      result = await TranslatorProviders.translateWithTencent(text, targetLang, settings);
      await recordTencentUsage(result.usedAmount);
      break;
    default:
      throw new Error(`Unknown service: ${service}`);
  }
  return { ...result, provider: service, fallbackFrom: null };
}

async function translateText(text, settings, targetLangOverride, sourceLang) {
  const service = settings.service || DEFAULT_SERVICE;
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
    translateUsingService,
  });
}

// --- Context menu ---

browser.menus.create({
  id: "auto-translate",
  title: "Auto-translate",
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
  title: "Translate to",
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
  title: "Never auto-translate",
  type: "normal",
  enabled: false,
  contexts: ["message_display_action"],
});

browser.menus.create({
  id: "translate-to-compose",
  title: "Translate to",
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

  if (isRead) {
    await browser.menus.update("auto-translate", { checked: settings.autoTranslate });

    const readLangKey    = LANG_STORAGE_KEY[settings.service];
    const activeReadLang = settings[readLangKey] || "en";
    for (const lang of LANGUAGES) {
      const visible = TranslatorProviders.isTargetLanguageSupported(settings.service, lang.value);
      await browser.menus.update(`read-lang-${lang.value}`, {
        checked: visible && lang.value === activeReadLang,
        visible,
      });
    }

    if (!settings.autoTranslate) {
      await browser.menus.update("never-translate-toggle", {
        title: "Never auto-translate",
        enabled: false,
      });
    } else if (tabId != null && translatingTabs.has(tabId)) {
      // Translation is currently running — disable toggle until it finishes
      await browser.menus.update("never-translate-toggle", {
        title: "Detecting language…",
        enabled: false,
      });
    } else {
      let detectedLang = tabId != null ? detectedLangByTab.get(tabId) : null;

      if (detectedLang) {
        const langName   = LANGUAGE_NAMES[detectedLang] || detectedLang.toUpperCase();
        const neverLangs = settings.neverTranslateLangs || [];
        const isExcluded = neverLangs.includes(detectedLang);
        await browser.menus.update("never-translate-toggle", {
          title: isExcluded ? `Always auto-translate ${langName}` : `Never auto-translate ${langName}`,
          enabled: true,
        });
      } else {
        await browser.menus.update("never-translate-toggle", {
          title: "Never auto-translate",
          enabled: false,
        });
      }
    }
  }

  if (isCompose) {
    const composeLangKey    = COMPOSE_LANG_KEY[settings.service];
    const activeComposeLang = settings[composeLangKey] || "en";
    for (const lang of LANGUAGES) {
      const visible = TranslatorProviders.isTargetLanguageSupported(settings.service, lang.value);
      await browser.menus.update(`compose-lang-${lang.value}`, {
        checked: visible && lang.value === activeComposeLang,
        visible,
      });
    }
  }

  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "auto-translate") {
    await messenger.storage.local.set({ autoTranslate: info.checked });
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
    await messenger.storage.local.set({ neverTranslateLangs: updated });
    return;
  }

  const { service } = await messenger.storage.local.get({ service: DEFAULT_SERVICE });
  const normalizedService = SERVICE_INFO[service] ? service : DEFAULT_SERVICE;
  if (String(info.menuItemId).startsWith("read-lang-")) {
    const lang    = info.menuItemId.replace("read-lang-", "");
    if (!TranslatorProviders.isTargetLanguageSupported(normalizedService, lang)) {
      console.warn(`[Translator] Ignoring unsupported ${normalizedService} target language: ${lang}`);
      return;
    }
    const langKey = LANG_STORAGE_KEY[normalizedService];
    await messenger.storage.local.set({ [langKey]: lang });
    messenger.messageDisplayAction.setTitle({ title: `Translate (${lang.toUpperCase()})` });
    return;
  }
  if (String(info.menuItemId).startsWith("compose-lang-")) {
    const lang    = info.menuItemId.replace("compose-lang-", "");
    if (!TranslatorProviders.isTargetLanguageSupported(normalizedService, lang)) {
      console.warn(`[Translator] Ignoring unsupported ${normalizedService} target language: ${lang}`);
      return;
    }
    const langKey = COMPOSE_LANG_KEY[normalizedService];
    await messenger.storage.local.set({ [langKey]: lang });
    messenger.composeAction.setTitle({ title: `Translate (${lang.toUpperCase()})` });
  }
});

// --- messageDisplayAction toggle ---

messenger.messageDisplayAction.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  messenger.messageDisplayAction.setBadgeText({ tabId, text: "..." });
  messenger.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#f90" });
  try {
    const state = await sendToTabPort(tabId, "getState");
    if (state.isTranslated) {
      await sendToTabPort(tabId, "doRevert");
      messenger.messageDisplayAction.setBadgeText({ tabId, text: "" });
    } else {
      const settings = await getSettings();
      const langKey = SERVICE_INFO[settings.service].targetLangKey;
      const targetLang = settings[langKey] || "en";
      const result = await sendToTabPort(tabId, "doTranslate", { targetLang });
      if (result.success) {
        messenger.messageDisplayAction.setBadgeText({ tabId, text: "✓" });
        messenger.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#1a7f37" });
        setTimeout(() => messenger.messageDisplayAction.setBadgeText({ tabId, text: "" }), 2000);
      } else {
        messenger.messageDisplayAction.setBadgeText({ tabId, text: "!" });
        messenger.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#c00" });
      }
    }
  } catch (e) {
    console.error("[Translator] onClicked error:", e.message);
    messenger.messageDisplayAction.setBadgeText({ tabId, text: "!" });
    messenger.messageDisplayAction.setBadgeBackgroundColor({ tabId, color: "#c00" });
  }
});

// --- composeAction ---

messenger.composeAction.onClicked.addListener(async (tab) => {
  const tabId    = tab.id;
  const windowId = tab.windowId;
  messenger.composeAction.setBadgeText({ tabId, text: "..." });
  messenger.composeAction.setBadgeBackgroundColor({ tabId, color: "#f90" });
  try {
    const result = await sendToComposePort(windowId, "doTranslateSelection");
    if (result.success) {
      messenger.composeAction.setBadgeText({ tabId, text: "✓" });
      messenger.composeAction.setBadgeBackgroundColor({ tabId, color: "#1a7f37" });
      setTimeout(() => messenger.composeAction.setBadgeText({ tabId, text: "" }), 2000);
    } else {
      messenger.composeAction.setBadgeText({ tabId, text: "!" });
      messenger.composeAction.setBadgeBackgroundColor({ tabId, color: "#c00" });
    }
  } catch (e) {
    console.error("[Translator] compose onClicked error:", e.message);
    messenger.composeAction.setBadgeText({ tabId, text: "!" });
    messenger.composeAction.setBadgeBackgroundColor({ tabId, color: "#c00" });
  }
});

// --- Message handler (options page) ---

messenger.runtime.onMessage.addListener(async (message) => {
  if (message.command === "testTencentConnection") {
    try {
      const result = await TranslatorProviders.translateWithTencent("connection test", "zh", {
        tencentSecretId: message.tencentSecretId,
        tencentSecretKey: message.tencentSecretKey,
        tencentRegion: message.tencentRegion,
        tencentProjectId: message.tencentProjectId,
      });
      await recordTencentUsage(result.usedAmount);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  if (message.command === "getTencentUsage") {
    return { success: true, ...(await getTencentUsageSummary()) };
  }
  if (message.command === "saveSettings") {
    if (!SERVICE_INFO[message.service]) {
      return { success: false, error: `Unsupported translation service: ${message.service}` };
    }
    await messenger.storage.local.set({
      service:               message.service,
      tencentSecretId:       message.tencentSecretId,
      tencentSecretKey:      message.tencentSecretKey,
      tencentRegion:         message.tencentRegion,
      tencentProjectId:      message.tencentProjectId,
    });
    updateReadButtonTitle();
    updateComposeButtonTitle();
    return { success: true };
  }
});
