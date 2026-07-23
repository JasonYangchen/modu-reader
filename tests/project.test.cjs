"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const marked = require("../vendor/marked.umd.js");

const root = path.resolve(__dirname, "..");

test("index references only local runtime assets", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /\.\/vendor\/marked\.umd\.js/);
  assert.match(html, /\.\/assets\/core\.js/);
  assert.match(html, /\.\/assets\/app\.js/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("required open-source files are present", () => {
  for (const file of ["README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md", "vendor/marked.LICENSE.md"]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} should exist`);
  }
});

test("bundled architecture example renders as substantial GFM", () => {
  const markdown = fs.readFileSync(path.join(root, "examples", "ARCHITECTURE.md"), "utf8");
  const html = marked.parse(markdown, { gfm: true });
  assert.match(html, /<h1>/);
  assert.ok((html.match(/<h[1-6]>/g) || []).length >= 20);
  assert.ok((html.match(/<table>/g) || []).length >= 2);
  assert.ok((html.match(/<pre><code/g) || []).length >= 2);
});
