"use strict";

const SUPPORTED_SERVICES = new Set(["tencent"]);

function i18n(key, substitutions = [], fallback = "") {
  const translated = browser.i18n.getMessage(key, substitutions);
  return translated || fallback || key;
}

function translatePage() {
  document.documentElement.lang = browser.i18n.getUILanguage() || "en";
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    element.textContent = i18n(key);
  });
}

const tencentApiKeyInput     = document.getElementById("tencentApiKey");
const tencentModelInput      = document.getElementById("tencentModel");
const testTencentBtn         = document.getElementById("testTencentConnection");
const saveBtn                = document.getElementById("save");
const statusDiv              = document.getElementById("status");
const tencentTestStatus      = document.getElementById("tencentTestStatus");
const tencentUsageText       = document.getElementById("tencentUsage");
const lastPerformanceText    = document.getElementById("lastTranslationPerformance");
const serviceRadios          = document.querySelectorAll("input[name='service']");

function showStatus(messageKey, isError) {
  statusDiv.textContent = browser.i18n.getMessage(messageKey) || messageKey;
  statusDiv.className = "status " + (isError ? "error" : "success");
}

function showStatusText(message, isError) {
  statusDiv.textContent = message;
  statusDiv.className = "status " + (isError ? "error" : "success");
}

function showInlineStatus(element, message, isError) {
  element.textContent = message;
  element.className = "status " + (isError ? "error" : "success");
}

function clearStatus() {
  statusDiv.textContent = "";
  statusDiv.className = "status";
}

function getSelectedService() {
  for (const radio of serviceRadios) {
    if (radio.checked) return radio.value;
  }
  return null;
}

function setSelectedService(service) {
  const normalized = SUPPORTED_SERVICES.has(service) ? service : null;
  for (const radio of serviceRadios) {
    radio.checked = radio.value === normalized;
  }
}

async function loadSettings() {
  const settings = await browser.storage.local.get({
    service: "none",
    tencentApiKey: "",
    tencentModel: "hy-mt2-lite",
    lastTranslationPerformance: null,
  });

  setSelectedService(settings.service);
  tencentApiKeyInput.value = settings.tencentApiKey;
  tencentModelInput.value = settings.tencentModel;
  renderLastTranslationPerformance(settings.lastTranslationPerformance);
  await loadTencentUsage();
}

function renderLastTranslationPerformance(performance) {
  if (!performance || typeof performance !== "object") {
    lastPerformanceText.textContent = i18n(
      "noTranslationPerformance",
      [],
      "No local translation performance record yet."
    );
    return;
  }

  const durationSeconds = (Math.max(0, Number(performance.durationMs) || 0) / 1000)
    .toFixed(2);
  const completed = new Date(performance.completedAt);
  const completedLabel = Number.isNaN(completed.getTime())
    ? "—"
    : new Intl.DateTimeFormat(undefined, {
      dateStyle: "short",
      timeStyle: "medium",
    }).format(completed);
  lastPerformanceText.textContent = i18n(
    "lastTranslationPerformance",
    [
      durationSeconds,
      String(performance.networkRequests || 0),
      String(performance.retryCount || 0),
      String(performance.deduplicatedSegments || 0),
      completedLabel,
    ],
    `Last translation: ${durationSeconds}s, ${performance.networkRequests || 0} network ` +
      `requests, ${performance.retryCount || 0} retries, ` +
      `${performance.deduplicatedSegments || 0} duplicate segments removed; ${completedLabel}.`
  );
}

async function loadTencentUsage() {
  const result = await browser.runtime.sendMessage({ command: "getTencentUsage" });
  if (!result?.success) {
    tencentUsageText.textContent = i18n(
      "localUsageUnavailable",
      [],
      "Local Thunderbird usage is unavailable."
    );
    return;
  }

  const formatter = new Intl.NumberFormat();
  tencentUsageText.textContent = i18n(
    "tencentUsageSummary",
    [
      result.month,
      formatter.format(result.inputTokens),
      formatter.format(result.outputTokens),
    ],
    `Thunderbird observed in ${result.month}: ${formatter.format(result.inputTokens)} input ` +
      `tokens and ${formatter.format(result.outputTokens)} output tokens. ` +
      "Tencent Console remains authoritative for billing."
  );
  tencentUsageText.style.color = "GrayText";
}

testTencentBtn.addEventListener("click", async () => {
  const tencentApiKey = tencentApiKeyInput.value.trim();
  if (!tencentApiKey) {
    showInlineStatus(
      tencentTestStatus,
      i18n("tencentCredentialsRequired", [], "TokenHub API Key is required."),
      true
    );
    return;
  }

  testTencentBtn.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({
      command: "testTencentConnection",
      tencentApiKey,
      tencentModel: tencentModelInput.value,
    });
    showInlineStatus(
      tencentTestStatus,
      result.success
        ? i18n("connectedSuccessfully", [], "Connected successfully.")
        : i18n("connectionFailed", [result.error], `Connection failed: ${result.error}`),
      !result.success
    );
    if (result.success) await loadTencentUsage();
  } catch (error) {
    showInlineStatus(
      tencentTestStatus,
      i18n("connectionFailed", [error.message], `Connection failed: ${error.message}`),
      true
    );
  } finally {
    testTencentBtn.disabled = false;
  }
});

saveBtn.addEventListener("click", async () => {
  clearStatus();
  const service = getSelectedService();
  const tencentApiKey = tencentApiKeyInput.value.trim();

  if (!service) {
    showStatusText(i18n(
      "chooseProviderError",
      [],
      "Choose an available translation provider in add-on settings."
    ), true);
    return;
  }

  if (service === "tencent" && !tencentApiKey) {
    showStatusText(i18n(
      "tencentCredentialsRequired",
      [],
      "TokenHub API Key is required."
    ), true);
    return;
  }

  saveBtn.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({
      command: "saveSettings",
      service,
      tencentApiKey,
      tencentModel: tencentModelInput.value,
    });
    if (!result?.success) {
      showStatusText(
        result?.error || i18n("settingsSaveFailed", [], "Settings could not be saved."),
        true
      );
      return;
    }
    showStatus("settingsSaved", false);
  } catch (error) {
    showStatusText(error.message || i18n("settingsSaveFailed", [], "Settings could not be saved."), true);
  } finally {
    saveBtn.disabled = false;
  }
});

translatePage();
loadSettings().catch(error => showStatusText(error.message, true));
