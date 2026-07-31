"use strict";

// Keep in sync with DEFAULT_TRANSLATE_PROMPT in background.js
const DEFAULT_TRANSLATE_PROMPT =
`You are a professional {SOURCE_LANG} ({SOURCE_CODE}) to {TARGET_LANG} ({TARGET_CODE}) translator. Your goal is to accurately convey the meaning and nuances of the original {SOURCE_LANG} text while adhering to {TARGET_LANG} grammar, vocabulary, and cultural sensitivities.
Produce only the {TARGET_LANG} translation, without any additional explanations or commentary. Please translate the following {SOURCE_LANG} text into {TARGET_LANG}:

{TEXT}`;

// Keep in sync with DEFAULT_DETECT_PROMPT in background.js
const DEFAULT_DETECT_PROMPT =
`Identify the language of the following text. Reply with ONLY the ISO 639-1 two-letter language code.
Examples: "en" for English, "tl" for Filipino/Tagalog, "fr" for French, "de" for German,
"es" for Spanish, "ja" for Japanese, "zh" for Chinese, "ko" for Korean, "ar" for Arabic.
No explanation. Just the two-letter code.

Text: {TEXT}`;

function translatePage() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    el.textContent = browser.i18n.getMessage(key);
  });
  document.querySelectorAll("[title-i18n]").forEach((el) => {
    const key = el.getAttribute("title-i18n");
    el.setAttribute("title", browser.i18n.getMessage(key));
  });
}

// --- Element refs ---
const urlInput                = document.getElementById("ollamaUrl");
const modelSelect             = document.getElementById("model");
const detectionModelSelect    = document.getElementById("detectionModel");
const ollamaApiKeyInput       = document.getElementById("ollamaApiKey");
const libreUrlInput           = document.getElementById("libreUrl");
const libreApiKeyInput        = document.getElementById("libreApiKey");
const googleFallbackSelect    = document.getElementById("googleFallbackService");
const tencentSecretIdInput    = document.getElementById("tencentSecretId");
const tencentSecretKeyInput   = document.getElementById("tencentSecretKey");
const tencentRegionInput      = document.getElementById("tencentRegion");
const tencentProjectIdInput   = document.getElementById("tencentProjectId");
const importZoteroTencentBtn  = document.getElementById("importZoteroTencent");
const zoteroPrefsFileInput    = document.getElementById("zoteroPrefsFile");
const refreshBtn              = document.getElementById("refreshModels");
const refreshDetectionBtn     = document.getElementById("refreshDetectionModels");
const testBtn                 = document.getElementById("testConnection");
const testLibreBtn            = document.getElementById("testLibreConnection");
const testTencentBtn          = document.getElementById("testTencentConnection");
const saveBtn                 = document.getElementById("save");
const statusDiv               = document.getElementById("status");
const ollamaTestStatus        = document.getElementById("ollamaTestStatus");
const libreTestStatus         = document.getElementById("libreTestStatus");
const tencentTestStatus       = document.getElementById("tencentTestStatus");
const tencentUsageText        = document.getElementById("tencentUsage");
const serviceRadios           = document.querySelectorAll("input[name='service']");
const ollamaTranslatePromptTA = document.getElementById("ollamaTranslatePrompt");
const ollamaDetectPromptTA    = document.getElementById("ollamaDetectPrompt");

// --- Status ---
function showStatus(messageKey, isError, replacements = {}) {
  const message = browser.i18n.getMessage(messageKey, Object.values(replacements));
  statusDiv.textContent = message || messageKey;
  statusDiv.className = "status " + (isError ? "error" : "success");
}

function clearStatus() {
  statusDiv.className = "status";
  statusDiv.textContent = "";
}

function showStatusText(message, isError) {
  statusDiv.textContent = message;
  statusDiv.className = "status " + (isError ? "error" : "success");
}

// --- Service radio helpers ---
function getSelectedService() {
  for (const r of serviceRadios) {
    if (r.checked) return r.value;
  }
  return "microsoft";
}

function setSelectedService(service) {
  for (const r of serviceRadios) {
    r.checked = (r.value === service);
  }
}

// --- Load settings ---
async function loadSettings() {
  const settings = await browser.storage.local.get({
    ollamaUrl: "http://localhost:11434",
    model: "",
    detectionModel: "",
    ollamaApiKey: "",
    libreUrl: "https://libretranslate.com",
    libreApiKey: "",
    service: "microsoft",
    googleFallbackService: "microsoft",
    tencentSecretId: "",
    tencentSecretKey: "",
    tencentRegion: "ap-shanghai",
    tencentProjectId: "0",
    ollamaTranslatePrompt: "",
    ollamaDetectPrompt: "",
  });

  urlInput.value = settings.ollamaUrl;
  ollamaApiKeyInput.value = settings.ollamaApiKey;
  libreUrlInput.value = settings.libreUrl;
  libreApiKeyInput.value = settings.libreApiKey;
  googleFallbackSelect.value = settings.googleFallbackService;
  tencentSecretIdInput.value = settings.tencentSecretId;
  tencentSecretKeyInput.value = settings.tencentSecretKey;
  tencentRegionInput.value = settings.tencentRegion;
  tencentProjectIdInput.value = settings.tencentProjectId;
  ollamaTranslatePromptTA.value = settings.ollamaTranslatePrompt || DEFAULT_TRANSLATE_PROMPT;
  ollamaDetectPromptTA.value    = settings.ollamaDetectPrompt    || DEFAULT_DETECT_PROMPT;
  setSelectedService(settings.service);

  await loadModels(settings.model);
  await loadDetectionModels(settings.detectionModel);
  await loadTencentUsage();
}

async function loadTencentUsage() {
  const result = await browser.runtime.sendMessage({ command: "getTencentUsage" });
  if (!result?.success) {
    tencentUsageText.textContent = "Local Thunderbird usage is unavailable.";
    return;
  }

  const formatter = new Intl.NumberFormat();
  const percent = result.freeLimit > 0 ? (result.used / result.freeLimit) * 100 : 0;
  tencentUsageText.textContent =
    `Thunderbird observed in ${result.month}: ${formatter.format(result.used)} / ` +
    `${formatter.format(result.freeLimit)} characters (${percent.toFixed(2)}%). ` +
    "This local counter does not include Zotero, other devices, or Tencent console usage.";
  tencentUsageText.style.color = percent >= 95
    ? "#a4000f"
    : percent >= 80 ? "#856404" : "#666";
}

function readZoteroPreference(contents, preferenceName) {
  const escapedName = preferenceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = contents.match(new RegExp(
    `^user_pref\\("${escapedName}",\\s*(.*)\\);$`,
    "m"
  ));
  if (!match) return "";

  try {
    return JSON.parse(match[1]);
  } catch {
    return "";
  }
}

importZoteroTencentBtn.addEventListener("click", () => {
  clearStatus();
  zoteroPrefsFileInput.value = "";
  zoteroPrefsFileInput.click();
});

zoteroPrefsFileInput.addEventListener("change", async () => {
  clearStatus();
  const file = zoteroPrefsFileInput.files?.[0];
  if (!file) return;

  let contents = "";
  try {
    contents = await file.text();
    const prefix = "extensions.zotero.ZoteroPDFTranslate.tencent.";
    const secretId = readZoteroPreference(contents, prefix + "secretId");
    const secretKey = readZoteroPreference(contents, prefix + "secretKey");
    const region = readZoteroPreference(contents, prefix + "region") || "ap-shanghai";
    const projectId = readZoteroPreference(contents, prefix + "projectId") || "0";

    if (!secretId || !secretKey) {
      throw new Error("Tencent SecretId or SecretKey was not found in the selected Zotero prefs.js.");
    }

    tencentSecretIdInput.value = secretId;
    tencentSecretKeyInput.value = secretKey;
    tencentRegionInput.value = region;
    tencentProjectIdInput.value = projectId;
    showStatusText("Tencent settings imported. Click Save to store them in Thunderbird.", false);
  } catch (error) {
    showStatusText(error.message, true);
  } finally {
    contents = "";
    zoteroPrefsFileInput.value = "";
  }
});

// --- Models ---
async function loadModels(selectedModel, ollamaUrl) {
  const result = await browser.runtime.sendMessage({ command: "getModels", ollamaUrl });

  modelSelect.innerHTML = "";

  if (!result.success) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = browser.i18n.getMessage("cannotLoadModels");
    modelSelect.appendChild(opt);
    if (selectedModel) {
      const saved = document.createElement("option");
      saved.value = selectedModel;
      saved.textContent = selectedModel + " " + browser.i18n.getMessage("saved");
      saved.selected = true;
      modelSelect.appendChild(saved);
    }
    return;
  }

  if (result.models.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = browser.i18n.getMessage("noModelsFound");
    modelSelect.appendChild(opt);
    return;
  }

  for (const name of result.models) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === selectedModel) opt.selected = true;
    modelSelect.appendChild(opt);
  }

  if (selectedModel && !result.models.includes(selectedModel)) {
    const saved = document.createElement("option");
    saved.value = selectedModel;
    saved.textContent = selectedModel + " " + browser.i18n.getMessage("notFound");
    saved.selected = true;
    modelSelect.prepend(saved);
  }
}

// --- Detection Models ---
async function loadDetectionModels(selectedModel, ollamaUrl) {
  const result = await browser.runtime.sendMessage({ command: "getModels", ollamaUrl });

  // Keep the "Same as Translate Model" blank option, then populate the rest
  detectionModelSelect.innerHTML = '<option value="">Same as Translate Model</option>';

  if (!result.success) {
    if (selectedModel) {
      const saved = document.createElement("option");
      saved.value = selectedModel;
      saved.textContent = selectedModel + " " + browser.i18n.getMessage("saved");
      saved.selected = true;
      detectionModelSelect.appendChild(saved);
    }
    return;
  }

  for (const name of result.models) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === selectedModel) opt.selected = true;
    detectionModelSelect.appendChild(opt);
  }

  if (selectedModel && !result.models.includes(selectedModel) && selectedModel !== "") {
    const saved = document.createElement("option");
    saved.value = selectedModel;
    saved.textContent = selectedModel + " " + browser.i18n.getMessage("notFound");
    saved.selected = true;
    detectionModelSelect.prepend(saved);
  }
}

refreshBtn.addEventListener("click", async () => {
  clearStatus();
  await loadModels(modelSelect.value, urlInput.value.trim());
  showStatus("modelsRefreshed", false);
});

refreshDetectionBtn.addEventListener("click", async () => {
  clearStatus();
  await loadDetectionModels(detectionModelSelect.value, urlInput.value.trim());
  showStatus("modelsRefreshed", false);
});

function showInlineStatus(el, text, isError) {
  el.textContent = text;
  el.className = "status " + (isError ? "error" : "success");
}

testBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) { showInlineStatus(ollamaTestStatus, browser.i18n.getMessage("urlRequired") || "URL required", true); return; }
  const result = await browser.runtime.sendMessage({ command: "testConnection", ollamaUrl: url });
  if (result.success) {
    showInlineStatus(ollamaTestStatus, (browser.i18n.getMessage("connectionSuccess", [result.models.length]) || `Connected. ${result.models.length} models available.`), false);
    await loadModels(modelSelect.value, url);
    await loadDetectionModels(detectionModelSelect.value, url);
  } else {
    showInlineStatus(ollamaTestStatus, (browser.i18n.getMessage("connectionFailed", [result.error]) || `Connection failed: ${result.error}`), true);
  }
});

testLibreBtn.addEventListener("click", async () => {
  const url = libreUrlInput.value.trim();
  if (!url) { showInlineStatus(libreTestStatus, browser.i18n.getMessage("urlRequired") || "URL required", true); return; }
  try {
    const base = url.replace(/\/+$/, "").replace(/\/translate$/, "");
    const apiKey = libreApiKeyInput.value.trim();
    const endpoint = base + "/languages" + (apiKey ? "?api_key=" + encodeURIComponent(apiKey) : "");
    const resp = await fetch(endpoint);
    if (!resp.ok) throw new Error("HTTP " + resp.status + " " + resp.statusText);
    const langs = await resp.json();
    if (!Array.isArray(langs)) throw new Error("Unexpected response format");
    showInlineStatus(libreTestStatus, "Connected. " + langs.length + " languages available.", false);
  } catch (e) {
    showInlineStatus(libreTestStatus, "Connection failed: " + e.message, true);
  }
});

testTencentBtn.addEventListener("click", async () => {
  const tencentSecretId = tencentSecretIdInput.value.trim();
  const tencentSecretKey = tencentSecretKeyInput.value.trim();
  if (!tencentSecretId || !tencentSecretKey) {
    showInlineStatus(tencentTestStatus, "SecretId and SecretKey are required.", true);
    return;
  }

  const result = await browser.runtime.sendMessage({
    command: "testTencentConnection",
    tencentSecretId,
    tencentSecretKey,
    tencentRegion: tencentRegionInput.value.trim() || "ap-shanghai",
    tencentProjectId: tencentProjectIdInput.value.trim() || "0",
  });
  showInlineStatus(
    tencentTestStatus,
    result.success ? "Connected successfully." : `Connection failed: ${result.error}`,
    !result.success
  );
  if (result.success) await loadTencentUsage();
});

saveBtn.addEventListener("click", async () => {
  clearStatus();

  const service             = getSelectedService();
  const ollamaUrl           = urlInput.value.trim();
  const model               = modelSelect.value;
  const detectionModel      = detectionModelSelect.value;
  const ollamaApiKey        = ollamaApiKeyInput.value.trim();
  const libreUrl            = libreUrlInput.value.trim();
  const libreApiKey         = libreApiKeyInput.value.trim();
  const googleFallbackService = googleFallbackSelect.value;
  const tencentSecretId     = tencentSecretIdInput.value.trim();
  const tencentSecretKey    = tencentSecretKeyInput.value.trim();
  const tencentRegion       = tencentRegionInput.value.trim() || "ap-shanghai";
  const tencentProjectId    = tencentProjectIdInput.value.trim() || "0";
  const ollamaTranslatePrompt = ollamaTranslatePromptTA.value.trim();
  const ollamaDetectPrompt    = ollamaDetectPromptTA.value.trim();

  if (service === "ollama" && !ollamaUrl) {
    showStatus("urlRequired", true); return;
  }
  if (service === "libretranslate" && !libreUrl) {
    showStatus("urlRequired", true); return;
  }
  if (service === "tencent" && (!tencentSecretId || !tencentSecretKey)) {
    showStatusText("Tencent SecretId and SecretKey are required.", true); return;
  }

  await browser.runtime.sendMessage({
    command: "saveSettings",
    ollamaUrl, model, detectionModel, ollamaApiKey,
    libreUrl, libreApiKey, service,
    googleFallbackService,
    tencentSecretId, tencentSecretKey, tencentRegion, tencentProjectId,
    ollamaTranslatePrompt, ollamaDetectPrompt,
  });

  showStatus("settingsSaved", false);
});

translatePage();
loadSettings();
