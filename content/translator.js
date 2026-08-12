"use strict";

(() => {
  const skipAutoTranslateOnLoad = window.__thunderbirdTranslatorSkipAutoTranslateOnce === true;
  try {
    delete window.__thunderbirdTranslatorSkipAutoTranslateOnce;
  } catch {
    window.__thunderbirdTranslatorSkipAutoTranslateOnce = false;
  }
  if (window.__thunderbirdTranslatorLoaded) return;
  window.__thunderbirdTranslatorLoaded = true;

  console.log("[Translator] Content script loaded");

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED",
    "SVG", "MATH", "CODE", "TEXTAREA", "INPUT",
  ]);

  const BLOCK_TAGS = new Set([
    "P", "DIV", "TD", "TH", "LI", "H1", "H2", "H3", "H4", "H5", "H6",
    "BLOCKQUOTE", "CAPTION", "DT", "DD", "FIGCAPTION", "ARTICLE", "SECTION",
    "HEADER", "FOOTER", "TR", "PRE",
  ]);

  const MIN_TEXT_LENGTH = 3;
  const MAX_TRANSLATION_CONCURRENCY = 2;

  const nodeMap = new Map();
  let isTranslated = false;
  let isTranslating = false;
  let translationCached = false;
  let cachedLang = null;
  let translatedSubject = null;
  let subjectBar = null;
  let errorBar = null;
  let cancellationRequested = false;
  let cancellationFailure = null;

  function i18n(key, substitutions = [], fallback = "") {
    const translated = browser.i18n.getMessage(key, substitutions);
    return translated || fallback || key;
  }

  // --- Port to background ---

  const port = browser.runtime.connect({ name: "translator" });
  port.onDisconnect?.addListener?.(() => {
    window.__thunderbirdTranslatorLoaded = false;
  });
  const pendingRequests        = new Map(); // text translate requests
  const subjectPendingRequests = new Map(); // subject translate requests
  const exemptionPendingRequests = new Map(); // exemption check requests
  let nextRequestId = 0;

  port.onMessage.addListener(async (message) => {
    // Exemption check response
    if (message.id != null && exemptionPendingRequests.has(message.id)) {
      const { resolve, reject } = exemptionPendingRequests.get(message.id);
      exemptionPendingRequests.delete(message.id);
      if (message.success) resolve({ shouldRevert: message.shouldRevert });
      else reject(new Error(message.error));
      return;
    }
    // Subject translate response
    if (message.id != null && subjectPendingRequests.has(message.id)) {
      const { resolve, reject } = subjectPendingRequests.get(message.id);
      subjectPendingRequests.delete(message.id);
      if (message.success) resolve({
        translated: message.translated,
        serviceLabel: message.serviceLabel,
        serviceUrl: message.serviceUrl,
        requestCount: Number(message.requestCount) || 0,
        retryCount: Number(message.retryCount) || 0,
      });
      else reject(new Error(message.error));
      return;
    }
    // Text translate response
    if (message.id != null && pendingRequests.has(message.id)) {
      const { resolve, reject } = pendingRequests.get(message.id);
      pendingRequests.delete(message.id);
      if (message.success) resolve({
        translated: message.translated,
        translations: message.translations,
        requestCount: Number(message.requestCount) || 0,
        retryCount: Number(message.retryCount) || 0,
      });
      else reject(new Error(message.error));
      return;
    }

    // Commands from popup (via background)
    if (message.command === "doTranslate") {
      const result = await startTranslation(message.targetLang || null);
      port.postMessage({ command: "translateDone", reqId: message.reqId, isTranslated, ...result });
      return;
    }
    if (message.command === "doCancel") {
      cancelCurrentTranslation(message.reason || null);
      port.postMessage({
        command: "cancelDone",
        reqId: message.reqId,
        isTranslated,
        success: true,
        cancelled: true,
      });
      return;
    }
    if (message.command === "doRevert") {
      reloadPage();
      port.postMessage({ command: "revertDone", reqId: message.reqId, isTranslated: false, success: true });
      return;
    }
    if (message.command === "getState") {
      port.postMessage({
        command: "stateDone",
        reqId: message.reqId,
        isTranslated,
        isTranslating,
        success: true,
      });
      return;
    }
  });

  function cancelRequestMap(requests) {
    for (const [id, pending] of requests.entries()) {
      port.postMessage({ command: "cancelTranslate", id });
      pending.reject(new Error("Translation cancelled"));
    }
    requests.clear();
  }

  function cancelCurrentTranslation(reason = null) {
    if (!isTranslating) return;
    cancellationRequested = true;
    cancellationFailure = reason;
    cancelOutstandingTranslationRequests();
  }

  function cancelOutstandingTranslationRequests() {
    cancelRequestMap(pendingRequests);
    cancelRequestMap(subjectPendingRequests);
  }

  function throwIfCancelled() {
    if (cancellationRequested) throw new Error("Translation cancelled");
  }

  function sendTranslateRequest(text) {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      pendingRequests.set(id, { resolve, reject });
      port.postMessage({ command: "translate", id, text });
    });
  }

  function sendTranslateBatchRequest(texts) {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      pendingRequests.set(id, { resolve, reject });
      port.postMessage({ command: "translateBatch", id, texts });
    });
  }

  function sendSubjectTranslateRequest() {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      subjectPendingRequests.set(id, { resolve, reject });
      port.postMessage({ command: "getTranslatedSubject", id });
    });
  }

  function sendCheckExemptionRequest() {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      exemptionPendingRequests.set(id, { resolve, reject });
      port.postMessage({ command: "checkExemption", id });
    });
  }

  // --- Subject bar ---

  function createSubjectBarStyle() {
    if (document.getElementById("__translator_subject_bar_style__")) return;
    const style = document.createElement("style");
    style.id = "__translator_subject_bar_style__";
    style.textContent = `
      #__translator_subject_bar__ {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 9999;
        padding: 5px 12px 6px;
        background: Canvas;
        color: CanvasText;
        border-bottom: 1px solid GrayText;
        box-sizing: border-box;
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      #__translator_service_info__ {
        font-size: 11px;
        font-weight: normal;
        color: GrayText;
        margin-bottom: 2px;
      }
      #__translator_subject_text__ {
        font-size: 16px;
        font-weight: 600;
      }
      #__translator_error_bar__ {
        position: sticky;
        top: 0;
        z-index: 10000;
        box-sizing: border-box;
        width: 100%;
        padding: 8px 12px;
        color: #721c24;
        background: #f8d7da;
        border: 1px solid #f5c6cb;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        white-space: pre-wrap;
      }
    `;
    document.head.appendChild(style);
  }

  function injectSubjectBar({ translated, serviceLabel, serviceUrl }) {
    removeSubjectBar();
    createSubjectBarStyle();
    const bar = document.createElement("div");
    bar.id = "__translator_subject_bar__";

    const infoLine = document.createElement("div");
    infoLine.id = "__translator_service_info__";
    infoLine.textContent = serviceUrl
      ? "🌐 " + i18n(
        "translatedViaWithUrl",
        [serviceLabel, serviceUrl],
        `Translated via ${serviceLabel} (${serviceUrl})`
      )
      : "🌐 " + i18n("translatedVia", [serviceLabel], `Translated via ${serviceLabel}`);

    const subjectLine = document.createElement("div");
    subjectLine.id = "__translator_subject_text__";
    subjectLine.textContent = "📧 " + translated;

    bar.appendChild(infoLine);
    bar.appendChild(subjectLine);
    document.body.insertBefore(bar, document.body.firstChild);
    subjectBar = bar;
    requestAnimationFrame(() => {
      const height = bar.getBoundingClientRect().height || 52;
      document.body.style.setProperty("padding-top", height + "px", "important");
      document.body.style.setProperty("margin-top", "0", "important");
    });
  }

  function removeSubjectBar() {
    const existing = document.getElementById("__translator_subject_bar__");
    if (existing) existing.remove();
    document.body.style.removeProperty("padding-top");
    document.body.style.removeProperty("margin-top");
    subjectBar = null;
  }

  function showErrorBar(error) {
    removeErrorBar();
    createSubjectBarStyle();
    const detail = TranslatorRuntimePolicy.normalizeError(error);
    const bar = document.createElement("div");
    bar.id = "__translator_error_bar__";
    bar.setAttribute("role", "alert");
    bar.textContent = "⚠ " + i18n(
      "translationFailedDetail",
      [detail],
      `Translation failed: ${detail}`
    );
    document.body.insertBefore(bar, document.body.firstChild);
    errorBar = bar;
  }

  function removeErrorBar() {
    const existing = document.getElementById("__translator_error_bar__");
    if (existing) existing.remove();
    errorBar = null;
  }

  // --- DOM Text Extraction ---

  function getBlockParent(node) {
    let el = node.parentElement;
    while (el && el !== document.body) {
      if (BLOCK_TAGS.has(el.tagName)) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  function isVisible(node) {
    const el = node.parentElement;
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function extractTextBlocks() {
    const blocks = new Map();
    let blockId = 0;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          let parent = node.parentElement;
          while (parent) {
            if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
            parent = parent.parentElement;
          }
          const text = node.textContent.trim();
          if (text.length < MIN_TEXT_LENGTH) return NodeFilter.FILTER_REJECT;
          if (!isVisible(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const blockParent = getBlockParent(textNode);
      if (!blocks.has(blockParent)) {
        blocks.set(blockParent, { id: blockId++, text: "", nodes: [] });
      }
      const block = blocks.get(blockParent);
      block.nodes.push(textNode);
      const nodeData = nodeMap.get(textNode);
      const textToUse = nodeData?.original ?? textNode.textContent.trim();
      block.text += (block.text ? "\n" : "") + textToUse;
    }

    return Array.from(blocks.values());
  }

  // --- Translation Logic ---

  function stageBlockTranslation(block, translatedText) {
    const operations = [];
    if (block.nodes.length === 1) {
      const node = block.nodes[0];
      const existing = nodeMap.get(node);
      operations.push({
        node,
        original: existing?.original ?? node.textContent,
        translated: translatedText,
      });
    } else {
      const translatedLines = translatedText.split("\n").filter(l => l.trim().length > 0);
      for (let i = 0; i < block.nodes.length; i++) {
        const node = block.nodes[i];
        const existing = nodeMap.get(node);
        let nodeTranslation;
        if (i < translatedLines.length) {
          nodeTranslation = translatedLines[i];
        } else if (translatedLines.length > 0) {
          nodeTranslation = translatedLines[translatedLines.length - 1];
        } else {
          nodeTranslation = existing?.original ?? node.textContent;
        }
        if (i === block.nodes.length - 1 && translatedLines.length > block.nodes.length) {
          nodeTranslation += "\n" + translatedLines.slice(block.nodes.length).join("\n");
        }
        operations.push({
          node,
          original: existing?.original ?? node.textContent,
          translated: nodeTranslation,
        });
      }
    }
    return operations;
  }

  function isURL(text) {
    return /^https?:\/\/[^\s]+$/.test(text.trim());
  }

  function buildPreTranslationTasks(blocks) {
    const tasks = [];
    const tasksByText = new Map();
    let sourceSegmentCount = 0;

    for (const block of blocks) {
      for (const node of block.nodes) {
        const existing = nodeMap.get(node);
        const original = existing?.original ?? node.textContent;
        const originalText = original.trim();
        if (node.parentElement?.tagName === "A" || isURL(originalText)) continue;
        if (originalText.length < MIN_TEXT_LENGTH) continue;
        sourceSegmentCount += 1;

        let task = tasksByText.get(originalText);
        if (!task) {
          task = { originalText, occurrences: [] };
          tasksByText.set(originalText, task);
          tasks.push(task);
        }
        task.occurrences.push({ node, original });
      }
    }

    return {
      tasks,
      sourceSegmentCount,
      deduplicatedSegmentCount: sourceSegmentCount - tasks.length,
    };
  }

  function reportProgress(progress) {
    port.postMessage({
      command: "translationProgress",
      current: progress.current,
      total: progress.total,
    });
  }

  function addResultMetrics(metrics, result) {
    metrics.providerRequests += Number(result?.requestCount) || 0;
    metrics.retryCount += Number(result?.retryCount) || 0;
  }

  async function runTranslationTasks(tasks, progress, metrics) {
    if (tasks.length === 0) return [];

    const results = new Array(tasks.length);
    let nextIndex = 0;
    let firstError = null;

    async function worker() {
      while (!firstError) {
        try {
          throwIfCancelled();
        } catch (error) {
          if (!firstError) firstError = error;
          return;
        }

        const index = nextIndex;
        nextIndex += 1;
        if (index >= tasks.length) return;

        const task = tasks[index];
        try {
          const result = await task.run();
          results[index] = result;
          addResultMetrics(metrics, result);
          progress.current += 1;
          reportProgress(progress);
        } catch (error) {
          if (!firstError) {
            firstError = error;
            cancelOutstandingTranslationRequests();
          }
          return;
        }
      }
    }

    const workerCount = Math.min(MAX_TRANSLATION_CONCURRENCY, tasks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (firstError) throw firstError;
    return results;
  }

  async function translateBodyBatch(preTasks, blocks) {
    throwIfCancelled();
    const entries = [
      ...preTasks.map(task => ({ kind: "pre", text: task.originalText, task })),
      ...blocks.map(block => ({ kind: "block", text: block.text, block })),
    ];
    if (entries.length === 0) {
      return { kind: "body", operations: [], requestCount: 0, retryCount: 0 };
    }

    const response = await sendTranslateBatchRequest(entries.map(entry => entry.text));
    if (
      !Array.isArray(response.translations) ||
      response.translations.length !== entries.length
    ) {
      throw new Error("Translation response did not preserve message structure");
    }

    const operations = [];
    entries.forEach((entry, index) => {
      const translated = response.translations[index];
      if (entry.kind === "pre") {
        operations.push(...entry.task.occurrences.map(({ node, original }) => ({
          node,
          original,
          translated,
        })));
      } else {
        operations.push(...stageBlockTranslation(entry.block, translated));
      }
    });
    return {
      kind: "body",
      operations,
      requestCount: response.requestCount,
      retryCount: response.retryCount,
    };
  }

  async function translateSubjectTask() {
    throwIfCancelled();
    const subjectData = await sendSubjectTranslateRequest();
    return {
      kind: "subject",
      subjectData,
      requestCount: subjectData.requestCount,
      retryCount: subjectData.retryCount,
    };
  }

  function scheduleSubjectWithBodyTasks(bodyTasks, subjectTask) {
    if (bodyTasks.length <= 1) return [...bodyTasks, subjectTask];
    return [bodyTasks[0], bodyTasks[1], subjectTask, ...bodyTasks.slice(2)];
  }

  function commitTranslation(operations, subjectData) {
    const snapshots = operations.map(operation => ({
      node: operation.node,
      text: operation.node.textContent,
      hadMapEntry: nodeMap.has(operation.node),
      mapEntry: nodeMap.get(operation.node),
    }));

    try {
      for (const operation of operations) {
        if (!document.body.contains(operation.node)) {
          throw new Error("Message content changed while translation was running");
        }
        operation.node.textContent = operation.translated;
        nodeMap.set(operation.node, {
          original: operation.original,
          translated: operation.translated,
        });
      }
      if (subjectData?.translated) injectSubjectBar(subjectData);
    } catch (error) {
      removeSubjectBar();
      for (const snapshot of snapshots) {
        try {
          if (document.body.contains(snapshot.node)) snapshot.node.textContent = snapshot.text;
          if (snapshot.hadMapEntry) nodeMap.set(snapshot.node, snapshot.mapEntry);
          else nodeMap.delete(snapshot.node);
        } catch (rollbackError) {
          console.error("[Translator] Rollback failed:", rollbackError);
        }
      }
      throw error;
    }
  }

  async function startTranslation(targetLang) {
    if (isTranslating) return { success: false, error: "Translation already in progress" };
    const startedAt = Date.now();
    const metrics = {
      version: 1,
      cacheHit: false,
      sourceSegments: 0,
      scheduledTasks: 0,
      deduplicatedSegments: 0,
      providerRequests: 0,
      retryCount: 0,
    };
    const finalizedMetrics = () => ({
      ...metrics,
      networkRequests: metrics.providerRequests + metrics.retryCount,
      durationMs: Math.max(0, Date.now() - startedAt),
    });

    isTranslating = true;
    cancellationRequested = false;
    cancellationFailure = null;
    removeErrorBar();
    try {
      // Invalidate cache if language changed
      if (targetLang && targetLang !== cachedLang) {
        translationCached = false;
      }

      // Use cache if available
      if (translationCached && nodeMap.size > 0) {
        const cachedOperations = [];
        for (const [node, data] of nodeMap.entries()) {
          if (document.body.contains(node) && data.translated) {
            cachedOperations.push({
              node,
              original: data.original,
              translated: data.translated,
            });
          }
        }
        commitTranslation(cachedOperations, translatedSubject);
        isTranslated = true;
        metrics.cacheHit = true;
        return { success: true, metrics: finalizedMetrics() };
      }

      const blocks = extractTextBlocks();
      if (blocks.length === 0) {
        throw new Error(i18n("noTextToTranslate", [], "No text to translate"));
      }

      const preBlocks    = blocks.filter(b => b.nodes[0]?.parentElement?.tagName === "PRE");
      const nonPreBlocks = blocks.filter(b => !preBlocks.includes(b));
      const preTaskInfo = buildPreTranslationTasks(preBlocks);
      const bodyTasks = [{
        run: () => translateBodyBatch(preTaskInfo.tasks, nonPreBlocks),
      }];
      const scheduledTasks = scheduleSubjectWithBodyTasks(
        bodyTasks,
        { run: translateSubjectTask }
      );

      metrics.sourceSegments = preTaskInfo.sourceSegmentCount + nonPreBlocks.length + 1;
      metrics.scheduledTasks = scheduledTasks.length;
      metrics.deduplicatedSegments = preTaskInfo.deduplicatedSegmentCount;

      const progress = { current: 0, total: scheduledTasks.length };
      reportProgress(progress);

      const results = await runTranslationTasks(scheduledTasks, progress, metrics);
      throwIfCancelled();

      const operations = results
        .filter(result => result?.kind === "body")
        .flatMap(result => result.operations);
      const newTranslatedSubject = results.find(
        result => result?.kind === "subject"
      )?.subjectData || null;

      commitTranslation(operations, newTranslatedSubject);
      translatedSubject = newTranslatedSubject;

      isTranslated = true;
      translationCached = true;
      if (targetLang) cachedLang = targetLang;

      return { success: true, metrics: finalizedMetrics() };
    } catch (e) {
      const cancelled = !cancellationFailure &&
        (cancellationRequested || TranslatorRuntimePolicy.isCancellationError(e));
      const error = cancellationFailure || (cancelled
        ? i18n("translationCancelled", [], "Translation cancelled")
        : TranslatorRuntimePolicy.normalizeError(e));
      if (!cancelled) showErrorBar(error);
      else removeErrorBar();
      return { success: false, cancelled, error, metrics: finalizedMetrics() };
    } finally {
      isTranslating = false;
      cancellationRequested = false;
      cancellationFailure = null;
    }
  }

  function reloadPage() {
    removeSubjectBar();
    removeErrorBar();
    for (const [node, data] of nodeMap.entries()) {
      try {
        if (document.body.contains(node)) node.textContent = data.original;
      } catch (e) {
        console.error("[Translator] Error restoring node:", e);
      }
    }
    isTranslated = false;
  }

  // Auto-translate on load if setting is enabled
  if (!skipAutoTranslateOnLoad) browser.storage.local.get({ autoTranslate: false }).then(async (s) => {
    if (!s.autoTranslate) return;

    port.postMessage({ command: "setBadge" });
    const result = await startTranslation();

    if (result.success) {
      // After translation, check if the detected source language is in the never-translate list.
      // The detected lang is cached in background from the translation API response.
      try {
        const { shouldRevert } = await sendCheckExemptionRequest();
        if (shouldRevert) {
          reloadPage();
          port.postMessage({
            command: "clearBadge",
            success: true,
            metrics: result.metrics,
          });
          return;
        }
      } catch (e) {
        console.warn("[Translator] Exemption check failed, keeping translation:", e.message);
      }
    }

    port.postMessage({
      command: "clearBadge",
      success: result.success,
      cancelled: result.cancelled,
      error: result.error,
      metrics: result.metrics,
    });
  });

  console.log("[Translator] Ready");
})();
