"use strict";

// Network-backed providers that do not depend on Thunderbird APIs.
// Keeping them in a separate file makes provider behavior testable without
// loading the extension background page.
(function initializeTranslatorProviders(root) {
  const MICROSOFT_AUTH_URL = "https://edge.microsoft.com/translate/auth";
  const MICROSOFT_API_URL = "https://api-edge.cognitive.microsofttranslator.com/translate";
  const TENCENT_API_URL = "https://tmt.tencentcloudapi.com";
  const DEFAULT_TENCENT_REGION = "ap-shanghai";
  const DEFAULT_TENCENT_PROJECT_ID = "0";
  const DEFAULT_TIMEOUT_MS = 20000;

  let microsoftToken = "";
  let microsoftTokenExpiresAt = 0;

  function splitLongText(text, maxChars) {
    if (!Number.isInteger(maxChars) || maxChars < 1) {
      throw new Error("maxChars must be a positive integer");
    }
    if (text.length <= maxChars) return [text];

    const parts = [];
    let remaining = text;
    while (remaining.length > maxChars) {
      const windowText = remaining.slice(0, maxChars);
      const candidates = [
        windowText.lastIndexOf("\n"),
        windowText.lastIndexOf(". "),
        windowText.lastIndexOf("! "),
        windowText.lastIndexOf("? "),
        windowText.lastIndexOf("。"),
        windowText.lastIndexOf("！"),
        windowText.lastIndexOf("？"),
        windowText.lastIndexOf(" "),
      ];
      let cut = Math.max(...candidates);
      if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
      else cut += 1;
      parts.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (remaining) parts.push(remaining);
    return parts;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`Translation request timed out after ${timeoutMs / 1000}s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function microsoftLanguageCode(language) {
    return language === "zh" ? "zh-Hans" : language;
  }

  async function getMicrosoftToken(forceRefresh = false) {
    if (!forceRefresh && microsoftToken && Date.now() < microsoftTokenExpiresAt) {
      return microsoftToken;
    }

    const response = await fetchWithTimeout(MICROSOFT_AUTH_URL, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Microsoft Translator auth error: ${response.status}`);
    }

    microsoftToken = (await response.text()).trim();
    if (!microsoftToken) throw new Error("Microsoft Translator returned an empty token");
    microsoftTokenExpiresAt = Date.now() + 8 * 60 * 1000;
    return microsoftToken;
  }

  async function requestMicrosoftBatch(texts, targetLanguage, forceRefresh = false) {
    const token = await getMicrosoftToken(forceRefresh);
    const params = new URLSearchParams({
      to: microsoftLanguageCode(targetLanguage),
      "api-version": "3.0",
      includeSentenceLength: "true",
    });
    const response = await fetchWithTimeout(`${MICROSOFT_API_URL}?${params}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(texts.map(Text => ({ Text }))),
    });

    if (response.status === 401 && !forceRefresh) {
      microsoftToken = "";
      microsoftTokenExpiresAt = 0;
      return requestMicrosoftBatch(texts, targetLanguage, true);
    }
    if (!response.ok) {
      throw new Error(`Microsoft Translator error: ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error("Microsoft Translator returned an invalid response");
    }
    return {
      translations: data.map(item => item?.translations?.[0]?.text ?? ""),
      detectedLang: data[0]?.detectedLanguage?.language || null,
    };
  }

  async function translateWithMicrosoft(text, targetLanguage) {
    if (!text) return { translated: "", detectedLang: null };

    const paragraphs = text.split("\n\n");
    const pieces = [];
    paragraphs.forEach((paragraph, paragraphIndex) => {
      if (!paragraph) return;
      splitLongText(paragraph, 4000).forEach((piece, pieceIndex) => {
        pieces.push({ paragraphIndex, pieceIndex, text: piece });
      });
    });

    const translatedPieces = new Array(pieces.length);
    let detectedLang = null;
    for (let start = 0; start < pieces.length;) {
      const batch = [];
      let batchChars = 0;
      let end = start;
      while (end < pieces.length && batch.length < 50) {
        const next = pieces[end].text;
        if (batch.length > 0 && batchChars + next.length > 40000) break;
        batch.push(next);
        batchChars += next.length;
        end += 1;
      }

      const result = await requestMicrosoftBatch(batch, targetLanguage);
      if (!detectedLang) detectedLang = result.detectedLang;
      result.translations.forEach((value, offset) => {
        translatedPieces[start + offset] = value;
      });
      start = end;
    }

    const rebuilt = paragraphs.map(() => []);
    pieces.forEach((piece, index) => {
      rebuilt[piece.paragraphIndex][piece.pieceIndex] = translatedPieces[index];
    });
    const pieceSeparator = ["zh", "ja", "ko"].includes(targetLanguage) ? "" : " ";
    return {
      translated: paragraphs.map((paragraph, index) =>
        paragraph ? rebuilt[index].join(pieceSeparator) : ""
      ).join("\n\n"),
      detectedLang,
    };
  }

  function formEncode(value) {
    return encodeURIComponent(String(value))
      .replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/%20/g, "+");
  }

  function bytesToBase64(bytes) {
    if (typeof btoa === "function") {
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    }
    return Buffer.from(bytes).toString("base64");
  }

  async function hmacSha1Base64(message, secretKey) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secretKey),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
    return bytesToBase64(new Uint8Array(signature));
  }

  async function buildTencentRequest(text, targetLanguage, settings, clock = {}) {
    const {
      tencentSecretId,
      tencentSecretKey,
      tencentRegion,
      tencentProjectId,
    } = settings;

    if (!tencentSecretId || !tencentSecretKey) {
      throw new Error("Tencent credentials are not configured. Open add-on settings first.");
    }

    const timestamp = clock.timestamp ?? Math.floor(Date.now() / 1000);
    const nonce = clock.nonce ?? Math.floor(Math.random() * 900000) + 100000;
    const params = {
      Action: "TextTranslate",
      Language: "zh-CN",
      Nonce: String(nonce),
      ProjectId: String(tencentProjectId || DEFAULT_TENCENT_PROJECT_ID),
      Region: tencentRegion || DEFAULT_TENCENT_REGION,
      SecretId: tencentSecretId,
      Source: "auto",
      SourceText: text,
      Target: targetLanguage,
      Timestamp: String(timestamp),
      Version: "2018-03-21",
    };

    const sortedKeys = Object.keys(params).sort();
    const raw = sortedKeys.map(key => `${key}=${params[key]}`).join("&");
    const signature = await hmacSha1Base64(
      `POSTtmt.tencentcloudapi.com/?${raw}`,
      tencentSecretKey
    );
    const body = sortedKeys
      .map(key => `${formEncode(key)}=${formEncode(params[key])}`)
      .join("&") + `&Signature=${formEncode(signature)}`;
    return { body, params };
  }

  async function translateTencentChunk(text, targetLanguage, settings) {
    const { body } = await buildTencentRequest(text, targetLanguage, settings);
    const response = await fetchWithTimeout(TENCENT_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new Error(`Tencent Translation HTTP error: ${response.status}`);
    }

    const data = await response.json();
    if (data?.Response?.Error) {
      const code = data.Response.Error.Code || "UnknownError";
      const retiredHint = /UnsupportedOperation|InvalidAction|ActionNotFound/i.test(code)
        ? " The legacy TextTranslate API may no longer be available."
        : "";
      throw new Error(`Tencent Translation error: ${code}.${retiredHint}`.trim());
    }
    if (!data?.Response?.TargetText) {
      throw new Error("Tencent Translation returned an invalid response");
    }
    return {
      translated: data.Response.TargetText.trim(),
      detectedLang: data.Response.Source || null,
    };
  }

  async function translateWithTencent(text, targetLanguage, settings) {
    if (!text) return { translated: "", detectedLang: null };

    const paragraphs = text.split("\n\n");
    const translatedParagraphs = [];
    let detectedLang = null;
    let requestCount = 0;

    for (const paragraph of paragraphs) {
      if (!paragraph) {
        translatedParagraphs.push("");
        continue;
      }

      const translatedPieces = [];
      for (const piece of splitLongText(paragraph, 1800)) {
        if (requestCount > 0) {
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        const result = await translateTencentChunk(piece, targetLanguage, settings);
        translatedPieces.push(result.translated);
        if (!detectedLang) detectedLang = result.detectedLang;
        requestCount += 1;
      }
      const pieceSeparator = ["zh", "ja", "ko"].includes(targetLanguage) ? "" : " ";
      translatedParagraphs.push(translatedPieces.join(pieceSeparator));
    }

    return {
      translated: translatedParagraphs.join("\n\n"),
      detectedLang,
    };
  }

  function resetMicrosoftTokenForTests() {
    microsoftToken = "";
    microsoftTokenExpiresAt = 0;
  }

  const api = {
    translateWithMicrosoft,
    translateWithTencent,
    splitLongText,
    microsoftLanguageCode,
    buildTencentRequest,
    resetMicrosoftTokenForTests,
    constants: {
      MICROSOFT_AUTH_URL,
      MICROSOFT_API_URL,
      TENCENT_API_URL,
      DEFAULT_TENCENT_REGION,
      DEFAULT_TENCENT_PROJECT_ID,
    },
  };

  root.TranslatorProviders = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
