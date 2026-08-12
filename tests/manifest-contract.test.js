"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
);

test("MV2 message display injection keeps its required permission", () => {
  assert.equal(manifest.manifest_version, 2);
  assert.ok(manifest.permissions.includes("messagesRead"));
  assert.ok(manifest.permissions.includes("messagesModify"));
});

test("runtime host permissions expose Tencent only", () => {
  const hostPermissions = manifest.permissions.filter(permission =>
    /^https?:\/\//.test(permission)
  );

  assert.deepEqual(hostPermissions, ["https://tokenhub.tencentmaas.com/*"]);
});
