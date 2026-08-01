"use strict";

const SUPPORTED_SERVICES = new Set(["microsoft", "tencent"]);

function translatePage() {
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    element.textContent = browser.i18n.getMessage(key);
  });
}

const tencentSecretIdInput   = document.getElementById("tencentSecretId");
const tencentSecretKeyInput  = document.getElementById("tencentSecretKey");
const tencentRegionInput     = document.getElementById("tencentRegion");
const tencentProjectIdInput  = document.getElementById("tencentProjectId");
const importZoteroTencentBtn = document.getElementById("importZoteroTencent");
const zoteroPrefsFileInput   = document.getElementById("zoteroPrefsFile");
const testTencentBtn         = document.getElementById("testTencentConnection");
const saveBtn                = document.getElementById("save");
const statusDiv              = document.getElementById("status");
const tencentTestStatus      = document.getElementById("tencentTestStatus");
const tencentUsageText       = document.getElementById("tencentUsage");
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
  return "microsoft";
}

function setSelectedService(service) {
  const normalized = SUPPORTED_SERVICES.has(service) ? service : "microsoft";
  for (const radio of serviceRadios) {
    radio.checked = radio.value === normalized;
  }
}

async function loadSettings() {
  const settings = await browser.storage.local.get({
    service: "microsoft",
    tencentSecretId: "",
    tencentSecretKey: "",
    tencentRegion: "ap-shanghai",
    tencentProjectId: "0",
  });

  setSelectedService(settings.service);
  tencentSecretIdInput.value = settings.tencentSecretId;
  tencentSecretKeyInput.value = settings.tencentSecretKey;
  tencentRegionInput.value = settings.tencentRegion;
  tencentProjectIdInput.value = settings.tencentProjectId;
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

  try {
    const contents = await file.text();
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
    zoteroPrefsFileInput.value = "";
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
  const service = getSelectedService();
  const tencentSecretId = tencentSecretIdInput.value.trim();
  const tencentSecretKey = tencentSecretKeyInput.value.trim();

  if (service === "tencent" && (!tencentSecretId || !tencentSecretKey)) {
    showStatusText("Tencent SecretId and SecretKey are required.", true);
    return;
  }

  const result = await browser.runtime.sendMessage({
    command: "saveSettings",
    service,
    tencentSecretId,
    tencentSecretKey,
    tencentRegion: tencentRegionInput.value.trim() || "ap-shanghai",
    tencentProjectId: tencentProjectIdInput.value.trim() || "0",
  });
  if (!result?.success) {
    showStatusText(result?.error || "Settings could not be saved.", true);
    return;
  }
  showStatus("settingsSaved", false);
});

translatePage();
loadSettings().catch(error => showStatusText(error.message, true));
