"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../assets/core.js");

test("countStats counts lines and mixed-language words", () => {
  const result = core.countStats("# 标题\n\nHello world");
  assert.equal(result.lines, 3);
  assert.equal(result.words, 4);
  assert.equal(result.readingMinutes, 1);
});

test("extractHeadings skips fenced code and creates unique ids", () => {
  const markdown = "# Intro\n## 相同\n```md\n# ignored\n```\n## 相同";
  const headings = core.extractHeadings(markdown);
  assert.deepEqual(headings.map((item) => item.title), ["Intro", "相同", "相同"]);
  assert.deepEqual(headings.map((item) => item.id), ["intro", "相同", "相同-2"]);
});

test("interpolate maps progress between chapter anchors in both directions", () => {
  const points = [
    { source: 0, preview: 0 },
    { source: .5, preview: .25 },
    { source: 1, preview: 1 }
  ];
  assert.equal(core.interpolate(.25, points), .125);
  assert.equal(core.interpolate(.25, points, "preview", "source"), .5);
});

test("sanitizeFileName removes unsafe path characters and changes extension", () => {
  assert.equal(core.sanitizeFileName('a<b>:c?.md', ".html"), "a-b--c-.html");
});

test("standalone export escapes the title and includes rendered body", () => {
  const html = core.buildStandaloneHtml("<unsafe>", "<h1>Hello</h1>");
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.match(html, /<!doctype html>/i);
});
