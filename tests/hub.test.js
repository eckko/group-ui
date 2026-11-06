"use strict";
// Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const hub = require("../js/hub.js");

test("a site's exact .itemrc tag is the item UI tag it loads", () => {
  assert.equal(hub.itemTagOf({ templateTag: "1.2.3" }), "1.2.3");
  assert.equal(hub.itemTagOf({ templateTag: " 1.0.0 " }), "1.0.0");
});

test("no tag, or one that is not an exact tag, gives the default", () => {
  for (const settings of [{}, null, undefined, { templateTag: "" },
    { templateTag: "3" }, { templateTag: "1.2" }, { templateTag: "v1.0.0" },
    { templateTag: "main" }, { templateTag: "1.0.0/../x" }]) {
    assert.equal(hub.itemTagOf(settings), hub.DEFAULT_ITEM_TAG);
  }
});

test("the default is the item UI tag that exists (1.x), not an old template tag", () => {
  assert.match(hub.DEFAULT_ITEM_TAG, /^1\.\d+\.\d+$/);
});

test("every item UI address is built from the chosen tag, never typed in", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "hub.js"), "utf8");
  assert.equal(/item-ui@\d/.test(source), false);
  assert.equal(source.includes("QUIZ_CDN"), false);
  assert.equal((source.match(/"item-ui@"/g) || []).length, 3);
});
