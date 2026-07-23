(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ModuCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function clamp(value, min = 0, max = 1) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function countStats(markdown) {
    const text = String(markdown || "");
    const lines = text ? text.split(/\r?\n/).length : 0;
    const words = (text.match(/[A-Za-z0-9_]+|[\u3400-\u9fff]/g) || []).length;
    const characters = text.replace(/\s/g, "").length;
    const readingMinutes = words ? Math.max(1, Math.ceil(words / 420)) : 0;
    return { lines, words, characters, readingMinutes };
  }

  function createSlugger() {
    const used = new Set();
    return function slug(text) {
      const base = String(text || "")
        .trim()
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
        .replace(/\s+/g, "-") || "section";
      let result = base;
      let suffix = 2;
      while (used.has(result)) result = `${base}-${suffix++}`;
      used.add(result);
      return result;
    };
  }

  function extractHeadings(markdown) {
    const lines = String(markdown || "").split(/\r?\n/);
    const headings = [];
    let fence = null;
    const slug = createSlugger();

    lines.forEach((line, index) => {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (!fence) fence = marker;
        else if (fence === marker) fence = null;
        return;
      }
      if (fence) return;

      const atx = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (atx) {
        const title = atx[2].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "").trim();
        headings.push({ level: atx[1].length, title, line: index, id: slug(title) });
        return;
      }

      if (index > 0 && /^\s*(=+|-+)\s*$/.test(line) && lines[index - 1].trim()) {
        const title = lines[index - 1].trim().replace(/[*_`~]/g, "");
        headings.push({ level: line.includes("=") ? 1 : 2, title, line: index - 1, id: slug(title) });
      }
    });

    return headings;
  }

  function normalizePoints(points) {
    const normalized = (Array.isArray(points) ? points : [])
      .map((point) => ({ source: clamp(point.source), preview: clamp(point.preview) }))
      .sort((a, b) => a.source - b.source);
    if (!normalized.length || normalized[0].source > 0) normalized.unshift({ source: 0, preview: 0 });
    if (normalized[normalized.length - 1].source < 1) normalized.push({ source: 1, preview: 1 });
    return normalized;
  }

  function interpolate(value, points, fromKey = "source", toKey = "preview") {
    const x = clamp(value);
    const sorted = normalizePoints(points).sort((a, b) => a[fromKey] - b[fromKey]);
    for (let i = 1; i < sorted.length; i += 1) {
      const left = sorted[i - 1];
      const right = sorted[i];
      if (x <= right[fromKey]) {
        const span = right[fromKey] - left[fromKey];
        const local = span > 0 ? (x - left[fromKey]) / span : 0;
        return clamp(left[toKey] + local * (right[toKey] - left[toKey]));
      }
    }
    return 1;
  }

  function sanitizeFileName(name, extension = "") {
    const clean = String(name || "document")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "") || "document";
    if (!extension) return clean;
    const ext = extension.startsWith(".") ? extension : `.${extension}`;
    return clean.toLowerCase().endsWith(ext.toLowerCase()) ? clean : `${clean.replace(/\.[^.]+$/, "")}${ext}`;
  }

  function buildStandaloneHtml(title, bodyHtml) {
    const safeTitle = escapeHtml(title || "Markdown Document");
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:#f3f1eb;color:#242521;font:16px/1.8 Georgia,"Noto Serif CJK SC","Songti SC",serif}.page{width:min(900px,calc(100% - 40px));margin:32px auto;padding:56px clamp(26px,7vw,78px);background:#fff;border:1px solid #ddd9cf;border-radius:12px;box-shadow:0 18px 50px rgba(35,34,29,.08)}h1,h2,h3,h4,h5,h6{font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.3}h1{font-size:2.35rem}h2{margin-top:2em;padding-bottom:.35em;border-bottom:1px solid #ddd9cf}a{color:#d95432}blockquote{margin:1.5em 0;padding-left:1.1em;border-left:3px solid #e45c36;color:#666}code{padding:.15em .35em;border-radius:4px;background:#eee;font:85%/1.6 ui-monospace,Consolas,monospace}pre{padding:20px;border-radius:8px;background:#242523;color:#eceae2;overflow:auto}pre code{padding:0;background:none;color:inherit}table{display:block;width:100%;overflow:auto;border-collapse:collapse}th,td{padding:9px 12px;border:1px solid #d8d5cd;text-align:left}img{max-width:100%;height:auto}@media(max-width:600px){.page{width:100%;margin:0;border:0;border-radius:0;padding:30px 22px}}@media print{body{background:#fff}.page{width:100%;margin:0;padding:0;border:0;box-shadow:none}}@media(prefers-color-scheme:dark){body{background:#171815;color:#e9e8e1}.page{background:#20211e;border-color:#393a35}h2,th,td{border-color:#3c3d38}code{background:#30312d}}
  </style>
</head>
<body><main class="page">${bodyHtml}</main></body>
</html>`;
  }

  return {
    buildStandaloneHtml,
    clamp,
    countStats,
    createSlugger,
    escapeHtml,
    extractHeadings,
    interpolate,
    normalizePoints,
    sanitizeFileName
  };
});
