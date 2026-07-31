"use strict";

// Translation fallback policy, isolated from Thunderbird and provider APIs so
// the behavior can be unit-tested. Credentialed/metered services are never
// eligible for automatic fallback.
(function initializeTranslationRouter(root) {
  async function translateWithFallback({
    service,
    text,
    targetLang,
    settings,
    sourceLang,
    translateUsingService,
  }) {
    try {
      return await translateUsingService(service, text, targetLang, settings, sourceLang);
    } catch (primaryError) {
      if (service !== "google" || settings.googleFallbackService !== "microsoft") {
        throw primaryError;
      }

      try {
        const fallback = await translateUsingService(
          "microsoft",
          text,
          targetLang,
          settings,
          sourceLang
        );
        return {
          ...fallback,
          fallbackFrom: "google",
          fallbackReason: primaryError.message,
        };
      } catch (fallbackError) {
        throw new Error(
          `${primaryError.message}; Microsoft fallback failed: ${fallbackError.message}`
        );
      }
    }
  }

  const api = { translateWithFallback };
  root.TranslatorRouter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
