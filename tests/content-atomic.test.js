"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const runtimePolicy = require("../shared/runtime-policy.js");
const contentScript = fs.readFileSync(
  path.join(__dirname, "..", "content", "translator.js"),
  "utf8"
);

function createHarness({
  texts = ["Original message body"],
  parentTag = "p",
} = {}) {
  const posted = [];
  const listeners = [];
  const elementsById = new Map();
  const styleValues = new Map();

  function createElement(tagName) {
    const element = {
      tagName: tagName.toUpperCase(),
      id: "",
      textContent: "",
      children: [],
      style: {
        setProperty(name, value) { styleValues.set(name, value); },
        removeProperty(name) { styleValues.delete(name); },
      },
      appendChild(child) { this.children.push(child); },
      setAttribute() {},
      getBoundingClientRect() { return { height: 52 }; },
      remove() {
        if (this.id) elementsById.delete(this.id);
      },
    };
    return element;
  }

  const body = createElement("body");
  const head = createElement("head");
  head.appendChild = element => {
    head.children.push(element);
    if (element.id) elementsById.set(element.id, element);
  };
  body.insertBefore = element => {
    body.children.unshift(element);
    body.firstChild = element;
    if (element.id) elementsById.set(element.id, element);
  };

  const paragraph = createElement(parentTag);
  paragraph.parentElement = body;
  const textNodes = texts.map(textContent => ({ textContent, parentElement: paragraph }));
  const textNode = textNodes[0];
  body.children.push(paragraph);
  body.firstChild = paragraph;
  body.contains = node => textNodes.includes(node) || body.children.includes(node) || node === paragraph;

  const document = {
    body,
    head,
    getElementById(id) { return elementsById.get(id) || null; },
    createElement,
    createTreeWalker(root, whatToShow, filter) {
      let nextIndex = 0;
      return {
        currentNode: null,
        nextNode() {
          while (nextIndex < textNodes.length) {
            const candidate = textNodes[nextIndex++];
            if (filter.acceptNode(candidate) !== 1) continue;
            this.currentNode = candidate;
            return true;
          }
          return false;
        },
      };
    },
  };

  const port = {
    onMessage: { addListener(listener) { listeners.push(listener); } },
    postMessage(message) { posted.push(message); },
  };
  const browser = {
    runtime: { connect() { return port; } },
    storage: { local: { async get() { return { autoTranslate: false }; } } },
    i18n: { getMessage() { return ""; } },
  };
  const window = {
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
  };

  vm.runInNewContext(contentScript, {
    browser,
    console,
    document,
    window,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    TranslatorRuntimePolicy: runtimePolicy,
    requestAnimationFrame(callback) { callback(); },
    setTimeout,
    clearTimeout,
    Map,
    Set,
    Error,
    Promise,
  }, { filename: "content/translator.js" });

  return { posted, listener: listeners[0], textNode, textNodes, document };
}

async function settle() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

test("body text is not mutated when subject translation fails", async () => {
  const harness = createHarness();
  const command = harness.listener({ command: "doTranslate", reqId: 50, targetLang: "zh" });
  await settle();

  const bodyRequest = harness.posted.find(message => message.command === "translateBatch");
  assert.ok(bodyRequest);
  await harness.listener({ id: bodyRequest.id, success: true, translations: ["正文译文"] });
  await settle();

  const subjectRequest = harness.posted.find(message => message.command === "getTranslatedSubject");
  assert.ok(subjectRequest);
  assert.equal(harness.textNode.textContent, "Original message body");

  await harness.listener({ id: subjectRequest.id, success: false, error: "subject failed" });
  await command;

  assert.equal(harness.textNode.textContent, "Original message body");
  const done = harness.posted.find(message => message.command === "translateDone");
  assert.equal(done.success, false);
  assert.equal(done.error, "subject failed");
  assert.ok(harness.document.getElementById("__translator_error_bar__"));
});

test("body text is committed only after body and subject both succeed", async () => {
  const harness = createHarness();
  const command = harness.listener({ command: "doTranslate", reqId: 51, targetLang: "zh" });
  await settle();

  const bodyRequest = harness.posted.find(message => message.command === "translateBatch");
  await harness.listener({ id: bodyRequest.id, success: true, translations: ["正文译文"] });
  await settle();
  assert.equal(harness.textNode.textContent, "Original message body");

  const subjectRequest = harness.posted.find(message => message.command === "getTranslatedSubject");
  await harness.listener({
    id: subjectRequest.id,
    success: true,
    translated: "主题译文",
    serviceLabel: "Tencent TokenHub (Hy-MT2)",
    serviceUrl: "https://cloud.tencent.com/product/tokenhub",
  });
  await command;

  assert.equal(harness.textNode.textContent, "正文译文");
  const done = harness.posted.find(message => message.command === "translateDone");
  assert.equal(done.success, true);
  assert.ok(harness.document.getElementById("__translator_subject_bar__"));
});

test("cancelling an in-flight message translation leaves the body unchanged", async () => {
  const harness = createHarness();
  const command = harness.listener({ command: "doTranslate", reqId: 52, targetLang: "zh" });
  await settle();

  const bodyRequest = harness.posted.find(message => message.command === "translateBatch");
  assert.ok(bodyRequest);
  await harness.listener({ command: "doCancel", reqId: 53 });
  await command;

  assert.equal(harness.textNode.textContent, "Original message body");
  assert.ok(harness.posted.some(message =>
    message.command === "cancelTranslate" && message.id === bodyRequest.id
  ));
  const done = harness.posted.find(message => message.command === "translateDone");
  assert.equal(done.success, false);
  assert.equal(done.cancelled, true);
});

test("plain-text nodes are batched once with source order preserved", async () => {
  const harness = createHarness({
    parentTag: "pre",
    texts: ["First segment", "Second segment", "Third segment"],
  });
  const command = harness.listener({ command: "doTranslate", reqId: 54, targetLang: "zh" });
  await settle();

  const bodyRequests = harness.posted.filter(message => message.command === "translateBatch");
  assert.equal(bodyRequests.length, 1);
  assert.deepEqual(
    Array.from(bodyRequests[0].texts),
    ["First segment", "Second segment", "Third segment"]
  );

  const subjectRequest = harness.posted.find(message => message.command === "getTranslatedSubject");
  assert.ok(subjectRequest);
  await harness.listener({
    id: subjectRequest.id,
    success: true,
    translated: "主题译文",
    serviceLabel: "Tencent TokenHub (Hy-MT2)",
    serviceUrl: "https://cloud.tencent.com/product/tokenhub",
  });
  await harness.listener({
    id: bodyRequests[0].id,
    success: true,
    translations: ["第一段", "第二段", "第三段"],
    requestCount: 1,
  });
  await command;

  assert.deepEqual(
    harness.textNodes.map(node => node.textContent),
    ["第一段", "第二段", "第三段"]
  );
  const progress = harness.posted.filter(message => message.command === "translationProgress");
  assert.equal(progress.at(-1).current, 2);
  assert.equal(progress.at(-1).total, 2);
});

test("duplicate plain-text segments are translated once and mapped to every source node", async () => {
  const harness = createHarness({
    parentTag: "pre",
    texts: ["Repeated segment", "Repeated segment", "Unique segment"],
  });
  const command = harness.listener({ command: "doTranslate", reqId: 58, targetLang: "zh" });
  await settle();

  const bodyRequests = harness.posted.filter(message => message.command === "translateBatch");
  assert.equal(bodyRequests.length, 1);
  assert.deepEqual(
    Array.from(bodyRequests[0].texts),
    ["Repeated segment", "Unique segment"]
  );

  await harness.listener({
    id: bodyRequests[0].id,
    success: true,
    translations: ["重复段", "唯一段"],
    requestCount: 1,
  });
  await settle();
  const subjectRequest = harness.posted.find(message => message.command === "getTranslatedSubject");
  assert.ok(subjectRequest);
  await harness.listener({
    id: subjectRequest.id,
    success: true,
    translated: "主题译文",
    serviceLabel: "Tencent TokenHub (Hy-MT2)",
    serviceUrl: "https://cloud.tencent.com/product/tokenhub",
    requestCount: 1,
  });
  await command;

  assert.deepEqual(
    harness.textNodes.map(node => node.textContent),
    ["重复段", "重复段", "唯一段"]
  );
  const done = harness.posted.find(message => message.command === "translateDone");
  assert.equal(done.metrics.sourceSegments, 4);
  assert.equal(done.metrics.scheduledTasks, 2);
  assert.equal(done.metrics.deduplicatedSegments, 1);
  assert.equal(done.metrics.providerRequests, 2);
  assert.equal(done.metrics.networkRequests, 2);
});

test("cancelling concurrent body-batch and subject requests cancels both", async () => {
  const harness = createHarness({
    parentTag: "pre",
    texts: ["First segment", "Second segment", "Third segment"],
  });
  const command = harness.listener({ command: "doTranslate", reqId: 55, targetLang: "zh" });
  await settle();

  const bodyRequests = harness.posted.filter(message => message.command === "translateBatch");
  assert.equal(bodyRequests.length, 1);
  const subjectRequest = harness.posted.find(message => message.command === "getTranslatedSubject");
  assert.ok(subjectRequest);
  await harness.listener({ command: "doCancel", reqId: 56 });
  await command;

  const cancelledIds = harness.posted
    .filter(message => message.command === "cancelTranslate")
    .map(message => message.id)
    .sort((a, b) => a - b);
  assert.deepEqual(
    cancelledIds,
    [bodyRequests[0].id, subjectRequest.id].sort((a, b) => a - b)
  );
  assert.deepEqual(
    harness.textNodes.map(node => node.textContent),
    ["First segment", "Second segment", "Third segment"]
  );
});

test("a failed body batch cancels subject translation without partial commit", async () => {
  const harness = createHarness({
    parentTag: "pre",
    texts: ["First segment", "Second segment", "Third segment"],
  });
  const command = harness.listener({ command: "doTranslate", reqId: 57, targetLang: "zh" });
  await settle();

  const bodyRequests = harness.posted.filter(message => message.command === "translateBatch");
  assert.equal(bodyRequests.length, 1);
  const subjectRequest = harness.posted.find(message => message.command === "getTranslatedSubject");
  assert.ok(subjectRequest);
  await harness.listener({ id: bodyRequests[0].id, success: false, error: "provider failed" });
  await command;

  assert.equal(
    harness.posted.filter(message => message.command === "translateBatch").length,
    1
  );
  assert.ok(harness.posted.some(message =>
    message.command === "cancelTranslate" && message.id === subjectRequest.id
  ));
  assert.deepEqual(
    harness.textNodes.map(node => node.textContent),
    ["First segment", "Second segment", "Third segment"]
  );
  const done = harness.posted.find(message => message.command === "translateDone");
  assert.equal(done.success, false);
  assert.equal(done.error, "provider failed");
});
