"use strict";

const LANG_STORAGE_KEY = {
  ollama: "ollamaTargetLang",
  google: "googleTargetLang",
  libretranslate: "libreTargetLang",
};

const langEl    = document.getElementById("lang");
const actionBtn = document.getElementById("action-btn");
const statusEl  = document.getElementById("status");

async function init() {
  const s = await browser.storage.local.get({
    service: "google",
    ollamaTargetLang: "en",
    googleTargetLang: "en",
    libreTargetLang: "en",
  });
  const langKey = LANG_STORAGE_KEY[s.service] || "googleTargetLang";
  langEl.value = s[langKey] || "en";
}

langEl.addEventListener("change", async () => {
  const s = await browser.storage.local.get({ service: "google" });
  const langKey = LANG_STORAGE_KEY[s.service] || "googleTargetLang";
  await browser.storage.local.set({ [langKey]: langEl.value });
});

actionBtn.addEventListener("click", async () => {
  actionBtn.disabled = true;
  statusEl.textContent = "Translating…";
  statusEl.className = "";

  try {
    const win = await browser.windows.getCurrent();
    const result = await browser.runtime.sendMessage({
      command: "popupTranslateSelection",
      windowId: win.id,
    });

    if (result && result.success) {
      statusEl.textContent = "Done";
      statusEl.className = "success";
    } else {
      statusEl.textContent = result?.error || "Translation failed";
      statusEl.className = "error";
    }
  } catch (e) {
    statusEl.textContent = e.message || "Error";
    statusEl.className = "error";
  } finally {
    actionBtn.disabled = false;
  }
});

init();
