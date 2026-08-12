"use strict";

// Provider routing policy, isolated from Thunderbird and provider APIs so the
// supported-service boundary can be unit-tested.
(function initializeTranslationRouter(root) {
  const SUPPORTED_SERVICES = new Set(["tencent"]);

  async function translateWithFallback({
    service,
    text,
    targetLang,
    settings,
    sourceLang,
    requestOptions = {},
    translateUsingService,
  }) {
    if (!SUPPORTED_SERVICES.has(service)) {
      throw new Error(`Unsupported translation service: ${service}`);
    }
    return translateUsingService(
      service,
      text,
      targetLang,
      settings,
      sourceLang,
      requestOptions
    );
  }

  const api = { translateWithFallback };
  root.TranslatorRouter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
