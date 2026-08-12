"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const providers = require("../providers.js");

function fakeResponse({ status = 200, json = null }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async json() { return json; },
  };
}

function tokenHubResponse(translations, options = {}) {
  return fakeResponse({
    json: {
      model: options.model || "hy-mt2-lite",
      choices: [{
        message: {
          content: JSON.stringify({
            source_language: options.sourceLanguage || "en",
            translations,
          }),
        },
        finish_reason: options.finishReason || "stop",
      }],
      usage: {
        prompt_tokens: options.inputTokens || 12,
        completion_tokens: options.outputTokens || 8,
      },
    },
  });
}

function tokenHubPlainResponse(content, options = {}) {
  return fakeResponse({
    json: {
      model: options.model || "hy-mt2-lite",
      choices: [{
        message: { content },
        finish_reason: options.finishReason || "stop",
      }],
      usage: {
        prompt_tokens: options.inputTokens || 12,
        completion_tokens: options.outputTokens || 8,
      },
    },
  });
}

function requestTexts(request) {
  const content = request.messages[1].content;
  const delimiter = providers.constants.DEFAULT_TENCENT_SEGMENT_DELIMITER;
  return content.includes(delimiter) ? content.split(delimiter) : [content];
}

test("splitLongText preserves content and respects the limit", () => {
  const input = "First sentence. Second sentence.\nThird sentence with a longer tail.";
  const parts = providers.splitLongText(input, 24);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => part.length <= 24));
  assert.equal(parts.join(""), input);
});

test("provider language policy limits Tencent to supported targets", () => {
  assert.deepEqual(providers.getSupportedTargetLanguages("tencent"), ["en", "zh"]);
  assert.deepEqual(providers.getSupportedTargetLanguages("microsoft"), []);
  assert.equal(providers.isTargetLanguageSupported("microsoft", "pl"), false);
  assert.equal(providers.isTargetLanguageSupported("tencent", "pl"), false);
  assert.throws(
    () => providers.targetLanguageCode("tencent", "nl"),
    /Unsupported target language for tencent: nl/
  );
});

test("TokenHub request uses Bearer API Key and never places it in the body", () => {
  const request = providers.buildTencentRequest(
    ["hello world"],
    "zh",
    { tencentApiKey: "test-tokenhub-key", tencentModel: "hy-mt2-lite" }
  );
  const body = JSON.parse(request.body);

  assert.equal(request.url, "https://tokenhub.tencentmaas.com/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer test-tokenhub-key");
  assert.equal(request.body.includes("test-tokenhub-key"), false);
  assert.equal(body.model, "hy-mt2-lite");
  assert.equal(body.temperature, 0);
  assert.equal(body.messages[1].role, "user");
  assert.equal(body.messages[1].content, "hello world");
  assert.match(body.messages[0].content, /strictly as data/i);
});

test("TokenHub multi-segment request follows the documented separator protocol", () => {
  const request = providers.buildTencentRequest(
    ["first", "second", "third"],
    "zh",
    { tencentApiKey: "test-key" }
  );
  const body = JSON.parse(request.body);

  assert.equal(request.segmentDelimiter, "<SEP>");
  assert.equal(body.messages[1].content, "first<SEP>second<SEP>third");
  assert.match(body.messages[0].content, /exactly 2 copies/i);
  assert.match(body.messages[0].content, /same order/i);
});

test("TokenHub selects a collision-free separator when source text contains SEP", () => {
  const request = providers.buildTencentRequest(
    ["source contains <SEP>", "second"],
    "zh",
    { tencentApiKey: "test-key" }
  );

  assert.equal(request.segmentDelimiter, "<TB_TRANSLATOR_SEP_1>");
  assert.equal(
    JSON.parse(request.body).messages[1].content,
    "source contains <SEP><TB_TRANSLATOR_SEP_1>second"
  );
});

test("unknown TokenHub model safely falls back to Hy-MT2-Lite", () => {
  assert.equal(providers.normalizeTencentModel("unknown"), "hy-mt2-lite");
  assert.equal(providers.normalizeTencentModel("hy-mt2-plus"), "hy-mt2-plus");
});

test("TokenHub exposes translations, detected language, token usage, and request count", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => tokenHubResponse(["用量测试"], {
    inputTokens: 17,
    outputTokens: 9,
  });

  try {
    const result = await providers.translateWithTencent("usage test", "zh", {
      tencentApiKey: "test-key",
      tencentModel: "hy-mt2-lite",
    });
    assert.equal(result.translated, "用量测试");
    assert.equal(result.detectedLang, "en");
    assert.equal(result.inputTokens, 17);
    assert.equal(result.outputTokens, 9);
    assert.equal(result.requestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("24 short message segments are translated in one TokenHub request", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async (url, options) => {
    requestCount += 1;
    const request = JSON.parse(options.body);
    const texts = requestTexts(request);
    return tokenHubPlainResponse(texts.map((_, index) => `译文${index + 1}`).join("<SEP>"));
  };
  const texts = Array.from({ length: 24 }, (_, index) => `Email segment ${index + 1}`);

  try {
    const result = await providers.translateBatchWithTencent(texts, "zh", {
      tencentApiKey: "test-key",
    });
    assert.equal(requestCount, 1);
    assert.equal(result.requestCount, 1);
    assert.equal(result.translations.length, 24);
    assert.equal(result.translations[23], "译文24");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("large translation batches are split and reassembled in source order", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async (url, options) => {
    requestCount += 1;
    const request = JSON.parse(options.body);
    const texts = requestTexts(request);
    return tokenHubPlainResponse(texts.map(text => `T:${text}`).join("<SEP>"));
  };

  try {
    const source = "文".repeat(6000);
    const result = await providers.translateBatchWithTencent([source, "tail"], "en", {
      tencentApiKey: "test-key",
    });
    assert.ok(requestCount >= 2);
    assert.equal(result.translations.length, 2);
    assert.match(result.translations[0], /^T:文/);
    assert.equal(result.translations[1], "T:tail");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TokenHub rate limiting retries twice with exponential backoff", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount <= 2) {
      return fakeResponse({
        status: 429,
        json: { error: { code: "rate_limit_exceeded", message: "slow down" } },
      });
    }
    return tokenHubResponse(["重试成功"]);
  };

  try {
    const result = await providers.translateWithTencent("retry", "zh", {
      tencentApiKey: "test-key",
    }, {
      maxRateLimitRetries: 2,
      rateLimitRetryDelayMs: 0,
    });
    assert.equal(requestCount, 3);
    assert.equal(result.translated, "重试成功");
    assert.equal(result.requestCount, 1);
    assert.equal(result.retryCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TokenHub accepts a plain-text single translation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => tokenHubPlainResponse("纯文本译文");
  try {
    const result = await providers.translateWithTencent(
      "plain text",
      "zh",
      { tencentApiKey: "test-key" }
    );
    assert.equal(result.translated, "纯文本译文");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TokenHub keeps JSON response compatibility", () => {
  const result = providers.parseTencentTranslations(
    JSON.stringify({ source_language: "en", translations: ["一", "二"] }),
    2,
    "<SEP>"
  );

  assert.deepEqual(result.translations, ["一", "二"]);
  assert.equal(result.detectedLang, "en");
});

test("TokenHub adaptively bisects batches when segment boundaries are unreliable", async () => {
  const originalFetch = globalThis.fetch;
  const requestSizes = [];
  globalThis.fetch = async (url, options) => {
    const request = JSON.parse(options.body);
    const texts = requestTexts(request);
    requestSizes.push(texts.length);
    if (texts.length > 1) {
      return tokenHubPlainResponse(
        texts.slice(0, -1).map(text => `T:${text}`).join("<SEP>"),
        { inputTokens: 10, outputTokens: 5 }
      );
    }
    return tokenHubPlainResponse(`T:${texts[0]}`, { inputTokens: 10, outputTokens: 5 });
  };
  try {
    const result = await providers.translateBatchWithTencent(
      ["first", "second", "third", "fourth"],
      "zh",
      { tencentApiKey: "test-key" },
      { structureRetryDelayMs: 0 }
    );
    assert.deepEqual(requestSizes, [4, 2, 1, 1, 2, 1, 1]);
    assert.deepEqual(result.translations, ["T:first", "T:second", "T:third", "T:fourth"]);
    assert.equal(result.requestCount, 7);
    assert.equal(result.inputTokens, 70);
    assert.equal(result.outputTokens, 35);
    assert.equal(result.retryCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TokenHub reports truncated output before attempting to parse it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => tokenHubPlainResponse(
    "partial output",
    { finishReason: "length" }
  );
  try {
    await assert.rejects(
      providers.translateWithTencent("long input", "zh", { tencentApiKey: "test-key" }),
      /translation output was truncated before completion/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TokenHub rate-limit backoff honors caller cancellation", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  let markFetchStarted;
  const fetchStarted = new Promise(resolve => { markFetchStarted = resolve; });
  globalThis.fetch = async () => {
    requestCount += 1;
    markFetchStarted();
    return fakeResponse({
      status: 429,
      json: { error: { code: "rate_limit_exceeded", message: "slow down" } },
    });
  };
  const controller = new AbortController();

  try {
    const request = providers.translateWithTencent("retry", "zh", {
      tencentApiKey: "test-key",
    }, {
      signal: controller.signal,
      rateLimitRetryDelayMs: 1000,
    });
    await fetchStarted;
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(request, error => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.message, "Translation cancelled");
      return true;
    });
    assert.equal(requestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider requests honor caller cancellation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  const controller = new AbortController();

  try {
    const request = providers.fetchWithTimeout(
      "https://example.invalid",
      {},
      1000,
      controller.signal
    );
    controller.abort();
    await assert.rejects(request, error => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.message, "Translation cancelled");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
