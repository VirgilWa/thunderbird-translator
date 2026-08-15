"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "background.js"),
  "utf8"
);
const dispatcherStart = backgroundSource.indexOf(
  "function handleOptionsMessage(message)"
);
const registration =
  "messenger.runtime.onMessage.addListener(handleOptionsMessage);";
const registrationStart = backgroundSource.indexOf(
  registration,
  dispatcherStart
);

function loadDispatcher(handlers) {
  assert.notEqual(dispatcherStart, -1, "options message dispatcher is missing");
  assert.notEqual(registrationStart, -1, "dispatcher registration is missing");
  const dispatcherSource = backgroundSource.slice(
    dispatcherStart,
    registrationStart
  );
  return vm.runInNewContext(
    `"use strict";\n${dispatcherSource}\nhandleOptionsMessage;`,
    handlers
  );
}

test("runtime messages use a synchronous selective dispatcher", () => {
  assert.match(backgroundSource, /function handleOptionsMessage\(message\)/);
  assert.doesNotMatch(
    backgroundSource,
    /async function handleOptionsMessage\(message\)/
  );
  assert.match(backgroundSource, new RegExp(registration.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("known options commands return their handler results unchanged", () => {
  const calls = [];
  const sentinels = {
    test: { name: "test" },
    usage: { name: "usage" },
    save: { name: "save" },
  };
  const dispatcher = loadDispatcher({
    handleTestTencentConnection(message) {
      calls.push(["test", message]);
      return sentinels.test;
    },
    handleGetTencentUsage() {
      calls.push(["usage"]);
      return sentinels.usage;
    },
    handleSaveSettings(message) {
      calls.push(["save", message]);
      return sentinels.save;
    },
  });
  const testMessage = { command: "testTencentConnection" };
  const saveMessage = { command: "saveSettings" };

  assert.equal(dispatcher(testMessage), sentinels.test);
  assert.equal(dispatcher({ command: "getTencentUsage" }), sentinels.usage);
  assert.equal(dispatcher(saveMessage), sentinels.save);
  assert.deepEqual(calls, [
    ["test", testMessage],
    ["usage"],
    ["save", saveMessage],
  ]);
});

test("unknown runtime messages remain unclaimed", () => {
  const unexpected = () => {
    throw new Error("an unknown message must not invoke an options handler");
  };
  const dispatcher = loadDispatcher({
    handleTestTencentConnection: unexpected,
    handleGetTencentUsage: unexpected,
    handleSaveSettings: unexpected,
  });

  assert.equal(dispatcher({ command: "notForOptions" }), undefined);
  assert.equal(dispatcher({}), undefined);
  assert.equal(dispatcher(null), undefined);
});
