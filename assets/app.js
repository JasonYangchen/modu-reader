(function () {
  "use strict";

  const core = window.ModuCore;
  const markedApi = window.marked;
  const $ = (id) => document.getElementById(id);
  const els = {
    root: document.documentElement,
    workspace: $("workspace"),
    source: $("sourceEditor"),
    preview: $("preview"),
    previewPane: $("previewPane"),
    previewScroll: $("previewScroll"),
    fileInput: $("fileInput"),
    openButton: $("openButton"),
    saveMarkdownButton: $("saveMarkdownButton"),
    exportHtmlButton: $("exportHtmlButton"),
    printButton: $("printButton"),
    themeButton: $("themeButton"),
    syncButton: $("syncButton"),
    syncLabel: $("syncLabel"),
    focusButton: $("focusButton"),
    focusLabel: $("focusLabel"),
    fontDecrease: $("fontDecrease"),
    fontIncrease: $("fontIncrease"),
    outlineButton: $("outlineButton"),
    outlineClose: $("outlineClose"),
    outlineBackdrop: $("outlineBackdrop"),
    outlineDrawer: $("outlineDrawer"),
    outlineList: $("outlineList"),
    outlineCount: $("outlineCount"),
    findButton: $("findButton"),
    findBar: $("findBar"),
    findInput: $("findInput"),
    findCount: $("findCount"),
    findPrevious: $("findPrevious"),
    findNext: $("findNext"),
    findClose: $("findClose"),
    splitter: $("splitter"),
    fileName: $("fileName"),
    savedState: $("savedState"),
    lineCount: $("lineCount"),
    encodingLabel: $("encodingLabel"),
    readingMeta: $("readingMeta"),
    charCount: $("charCount"),
    positionText: $("positionText"),
    statusText: $("statusText"),
    dropOverlay: $("dropOverlay"),
    toast: $("toast"),
    documentEnd: $("documentEnd")
  };

  const state = {
    fileName: "ARCHITECTURE.md",
    encoding: "UTF-8",
    dirty: false,
    syncEnabled: true,
    syncing: false,
    focusMode: false,
    dragDepth: 0,
    renderTimer: null,
    searchTimer: null,
    toastTimer: null,
    syncPoints: [{ source: 0, preview: 0 }, { source: 1, preview: 1 }],
    headings: [],
    headingElements: [],
    searchMatches: [],
    searchIndex: -1,
    fontScale: 1
  };

  if (!core || !markedApi) {
    els.preview.innerHTML = '<div class="render-error"><strong>启动失败</strong><p>核心脚本未能加载，请确认 vendor 与 assets 目录完整。</p></div>';
    return;
  }

  markedApi.setOptions({ gfm: true, breaks: false });

  function safeUrl(value, kind) {
    const url = String(value || "").trim();
    if (!url) return "";
    if (kind === "image" && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(url)) return url;
    if (kind === "link" && /^(https?:|mailto:|tel:|#)/i.test(url)) return url;
    if (/^(javascript:|vbscript:|data:)/i.test(url)) return "";
    if (kind === "link" && !/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    return "";
  }

  function sanitizeHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "");
    template.content.querySelectorAll("script, iframe, object, embed, style, link, meta, base, form, audio, video, source").forEach((node) => node.remove());

    template.content.querySelectorAll("*").forEach((node) => {
      [...node.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        const keep = ["href", "src", "alt", "title", "class", "type", "checked", "disabled", "start"].includes(name);
        if (!keep || name.startsWith("on") || name === "srcdoc") node.removeAttribute(attr.name);
      });

      if (node.tagName === "A") {
        const href = safeUrl(node.getAttribute("href"), "link");
        if (href) node.setAttribute("href", href);
        else node.removeAttribute("href");
        node.setAttribute("rel", "noreferrer noopener");
        if (/^https?:/i.test(href)) node.setAttribute("target", "_blank");
      }

      if (node.tagName === "IMG") {
        const src = safeUrl(node.getAttribute("src"), "image");
        if (!src) {
          const placeholder = document.createElement("span");
          placeholder.className = "blocked-image";
          placeholder.textContent = `［已阻止外部图片${node.getAttribute("alt") ? `：${node.getAttribute("alt")}` : ""}］`;
          node.replaceWith(placeholder);
        } else {
          node.setAttribute("src", src);
          node.setAttribute("loading", "lazy");
          node.setAttribute("decoding", "async");
        }
      }

      if (node.tagName === "INPUT") {
        if ((node.getAttribute("type") || "").toLowerCase() !== "checkbox") node.remove();
        else node.setAttribute("disabled", "");
      }
    });
    return template.innerHTML;
  }

  function getScrollRatio(element) {
    const max = element.scrollHeight - element.clientHeight;
    return max > 0 ? element.scrollTop / max : 0;
  }

  function setScrollRatio(element, ratio) {
    const max = element.scrollHeight - element.clientHeight;
    element.scrollTop = Math.max(0, max * core.clamp(ratio));
  }

  function updateProgress() {
    const ratio = getScrollRatio(els.previewScroll);
    const percentage = Math.round(ratio * 100);
    els.previewPane.style.setProperty("--reading-progress", `${percentage}%`);
    els.positionText.textContent = `预览 ${percentage}%`;
  }

  function buildSyncPoints() {
    const totalLines = Math.max(1, els.source.value.split(/\r?\n/).length - 1);
    const previewMax = Math.max(1, els.previewScroll.scrollHeight - els.previewScroll.clientHeight);
    const points = [{ source: 0, preview: 0 }];

    state.headings.forEach((heading, index) => {
      const element = state.headingElements[index];
      if (!element) return;
      points.push({
        source: core.clamp(heading.line / totalLines),
        preview: core.clamp((element.offsetTop - 24) / previewMax)
      });
    });
    points.push({ source: 1, preview: 1 });
    state.syncPoints = core.normalizePoints(points);
  }

  function syncScroll(direction) {
    if (!state.syncEnabled || state.syncing) return;
    state.syncing = true;
    if (direction === "source") {
      const sourceRatio = getScrollRatio(els.source);
      setScrollRatio(els.previewScroll, core.interpolate(sourceRatio, state.syncPoints, "source", "preview"));
    } else {
      const previewRatio = getScrollRatio(els.previewScroll);
      setScrollRatio(els.source, core.interpolate(previewRatio, state.syncPoints, "preview", "source"));
    }
    requestAnimationFrame(() => { state.syncing = false; });
  }

  function showToast(message) {
    clearTimeout(state.toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add("is-visible");
    state.toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 1900);
  }

  function updateStats(markdown) {
    const stats = core.countStats(markdown);
    els.lineCount.textContent = `${stats.lines.toLocaleString("zh-CN")} 行`;
    els.readingMeta.textContent = `${stats.words.toLocaleString("zh-CN")} 字词 · ${stats.readingMinutes} 分钟`;
    els.charCount.textContent = `${stats.characters.toLocaleString("zh-CN")} 字符`;
  }

  function enhancePreview() {
    state.headings = core.extractHeadings(els.source.value);
    state.headingElements = [...els.preview.querySelectorAll("h1, h2, h3, h4, h5, h6")];
    const fallbackSlug = core.createSlugger();

    state.headingElements.forEach((element, index) => {
      element.id = state.headings[index] ? state.headings[index].id : fallbackSlug(element.textContent);
    });

    els.preview.querySelectorAll("pre").forEach((pre) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.textContent = "复制";
      button.setAttribute("aria-label", "复制代码块");
      pre.appendChild(button);
    });
    rebuildOutline();
  }

  function rebuildOutline() {
    els.outlineList.replaceChildren();
    els.outlineCount.textContent = String(state.headings.length);
    if (!state.headings.length) {
      const empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "当前文档没有标题";
      els.outlineList.appendChild(empty);
      return;
    }

    state.headings.forEach((heading, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "outline-item";
      button.dataset.level = String(heading.level);
      button.style.setProperty("--level", String(heading.level));
      button.textContent = heading.title;
      button.title = heading.title;
      button.addEventListener("click", () => {
        const element = state.headingElements[index];
        if (element) element.scrollIntoView({ block: "start", behavior: "smooth" });
        const totalLines = Math.max(1, els.source.value.split(/\r?\n/).length - 1);
        setScrollRatio(els.source, heading.line / totalLines);
        closeOutline();
      });
      els.outlineList.appendChild(button);
    });
  }

  function clearHighlights() {
    els.preview.querySelectorAll("mark.search-match").forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent || "")));
    els.preview.normalize();
    state.searchMatches = [];
    state.searchIndex = -1;
  }

  function highlightSearch(query) {
    clearHighlights();
    const needle = String(query || "").trim().toLocaleLowerCase();
    if (!needle) {
      els.findCount.textContent = "0 / 0";
      return;
    }

    const walker = document.createTreeWalker(els.preview, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.toLocaleLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest("button, .blocked-image")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach((node) => {
      const text = node.nodeValue;
      const lower = text.toLocaleLowerCase();
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      let index = lower.indexOf(needle);
      while (index !== -1) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, index)));
        const mark = document.createElement("mark");
        mark.className = "search-match";
        mark.textContent = text.slice(index, index + needle.length);
        fragment.appendChild(mark);
        state.searchMatches.push(mark);
        cursor = index + needle.length;
        index = lower.indexOf(needle, cursor);
      }
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
      node.replaceWith(fragment);
    });

    if (state.searchMatches.length) goToSearchResult(0, false);
    else els.findCount.textContent = "0 / 0";
  }

  function goToSearchResult(index, smooth = true) {
    if (!state.searchMatches.length) return;
    state.searchMatches.forEach((mark) => mark.classList.remove("is-current"));
    state.searchIndex = (index + state.searchMatches.length) % state.searchMatches.length;
    const current = state.searchMatches[state.searchIndex];
    current.classList.add("is-current");
    els.findCount.textContent = `${state.searchIndex + 1} / ${state.searchMatches.length}`;
    current.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  }

  function renderMarkdown(options = {}) {
    const keepScroll = options.keepScroll !== false;
    const markdown = els.source.value;
    const previewRatio = keepScroll ? getScrollRatio(els.previewScroll) : 0;
    try {
      const html = markedApi.parse(markdown);
      els.preview.innerHTML = sanitizeHtml(html);
      enhancePreview();
      els.documentEnd.hidden = !markdown.trim();
      updateStats(markdown);
      if (!els.findBar.hidden && els.findInput.value) highlightSearch(els.findInput.value);
      els.statusText.textContent = "正在排版";
      requestAnimationFrame(() => {
        buildSyncPoints();
        if (keepScroll) setScrollRatio(els.previewScroll, previewRatio);
        updateProgress();
        els.statusText.textContent = "已就绪";
      });
    } catch (error) {
      els.preview.innerHTML = `<div class="render-error"><strong>渲染失败</strong><p>${core.escapeHtml(error.message)}</p></div>`;
      els.statusText.textContent = "渲染失败";
    }
  }

  function scheduleRender() {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(() => renderMarkdown(), 100);
  }

  function decodeBuffer(buffer) {
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "UTF-8" };
    } catch (_) {
      try {
        return { text: new TextDecoder("gb18030", { fatal: true }).decode(buffer), encoding: "GB18030" };
      } catch (_) {
        return { text: new TextDecoder().decode(buffer), encoding: "自动识别" };
      }
    }
  }

  function setDocument(markdown, fileName, origin = "本地文件", encoding = "UTF-8") {
    state.fileName = core.sanitizeFileName(fileName || "未命名.md");
    state.encoding = encoding;
    state.dirty = false;
    els.source.value = String(markdown || "").replace(/^\uFEFF/, "");
    els.fileName.textContent = state.fileName;
    els.savedState.textContent = origin;
    els.encodingLabel.textContent = encoding;
    els.source.scrollTop = 0;
    els.previewScroll.scrollTop = 0;
    closeFind(false);
    renderMarkdown({ keepScroll: false });
  }

  async function openFile(file) {
    if (!file) return;
    const allowed = /\.(md|markdown|mdown|mkd|txt)$/i.test(file.name) || ["text/markdown", "text/plain", ""].includes(file.type);
    if (!allowed) return showToast("请选择 Markdown 或纯文本文件");
    if (file.size > 20 * 1024 * 1024 && !window.confirm("文件超过 20 MB，渲染可能较慢。仍要继续吗？")) return;

    try {
      els.statusText.textContent = "正在读取";
      const decoded = decodeBuffer(await file.arrayBuffer());
      setDocument(decoded.text, file.name, "本地文件", decoded.encoding);
      showToast(`已打开 ${file.name}`);
    } catch (_) {
      els.statusText.textContent = "读取失败";
      showToast("无法读取这个文件");
    }
  }

  function downloadBlob(content, type, name) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function saveMarkdown() {
    downloadBlob(els.source.value, "text/markdown;charset=utf-8", core.sanitizeFileName(state.fileName, ".md"));
    state.dirty = false;
    els.savedState.textContent = "已保存副本";
    showToast("Markdown 副本已保存");
  }

  function exportHtml() {
    const clone = els.preview.cloneNode(true);
    clone.querySelectorAll(".copy-code").forEach((button) => button.remove());
    clone.querySelectorAll("mark.search-match").forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent || "")));
    const title = state.headings[0] ? state.headings[0].title : state.fileName.replace(/\.[^.]+$/, "");
    const html = core.buildStandaloneHtml(title, clone.innerHTML);
    downloadBlob(html, "text/html;charset=utf-8", core.sanitizeFileName(state.fileName, ".html"));
    showToast("独立 HTML 已导出");
  }

  function applyTheme(theme) {
    if (theme === "dark") els.root.setAttribute("data-theme", "dark");
    else els.root.removeAttribute("data-theme");
    localStorage.setItem("modu-theme", theme);
  }

  function changeFont(delta) {
    state.fontScale = core.clamp(Math.round((state.fontScale + delta) * 100) / 100, .85, 1.3);
    els.root.style.setProperty("--reader-size", `${15.5 * state.fontScale}px`);
    localStorage.setItem("modu-font-scale", String(state.fontScale));
    requestAnimationFrame(buildSyncPoints);
    showToast(`阅读字号 ${Math.round(state.fontScale * 100)}%`);
  }

  function toggleSync() {
    state.syncEnabled = !state.syncEnabled;
    els.syncButton.classList.toggle("is-active", state.syncEnabled);
    els.syncButton.setAttribute("aria-pressed", String(state.syncEnabled));
    els.syncLabel.textContent = state.syncEnabled ? "同步" : "独立";
    if (state.syncEnabled) syncScroll("source");
    showToast(state.syncEnabled ? "已开启章节滚动同步" : "已关闭滚动同步");
  }

  function toggleFocus() {
    state.focusMode = !state.focusMode;
    els.workspace.classList.toggle("focus-mode", state.focusMode);
    els.focusButton.classList.toggle("is-active", state.focusMode);
    els.focusButton.setAttribute("aria-pressed", String(state.focusMode));
    els.focusLabel.textContent = state.focusMode ? "退出" : "专注";
    requestAnimationFrame(buildSyncPoints);
  }

  function openOutline() {
    els.previewPane.classList.add("outline-open");
    els.outlineButton.setAttribute("aria-expanded", "true");
    els.outlineDrawer.setAttribute("aria-hidden", "false");
  }

  function closeOutline() {
    els.previewPane.classList.remove("outline-open");
    els.outlineButton.setAttribute("aria-expanded", "false");
    els.outlineDrawer.setAttribute("aria-hidden", "true");
  }

  function toggleOutline() {
    if (els.previewPane.classList.contains("outline-open")) closeOutline();
    else openOutline();
  }

  function openFind() {
    closeOutline();
    els.findBar.hidden = false;
    requestAnimationFrame(() => {
      els.findInput.focus();
      els.findInput.select();
    });
  }

  function closeFind(restoreFocus = true) {
    if (!els.findBar.hidden) {
      els.findBar.hidden = true;
      clearHighlights();
      els.findCount.textContent = "0 / 0";
      if (restoreFocus) els.findButton.focus();
    }
  }

  function initSplitter() {
    let dragging = false;
    const setWidth = (clientX) => {
      const bounds = els.workspace.getBoundingClientRect();
      const width = Math.min(Math.max(280, bounds.width - 380), Math.max(280, clientX - bounds.left));
      els.root.style.setProperty("--source-width", `${width}px`);
      requestAnimationFrame(buildSyncPoints);
    };
    els.splitter.addEventListener("pointerdown", (event) => {
      dragging = true;
      els.splitter.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
    els.splitter.addEventListener("pointermove", (event) => { if (dragging) setWidth(event.clientX); });
    els.splitter.addEventListener("pointerup", (event) => {
      dragging = false;
      els.splitter.releasePointerCapture(event.pointerId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
    els.splitter.addEventListener("dblclick", () => els.root.style.setProperty("--source-width", "44%"));
    els.splitter.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const bounds = els.workspace.getBoundingClientRect();
      const current = els.source.closest(".pane").getBoundingClientRect().width;
      setWidth(bounds.left + current + (event.key === "ArrowLeft" ? -24 : 24));
    });
  }

  async function loadSample() {
    try {
      const response = await fetch("./examples/ARCHITECTURE.md", { cache: "no-store" });
      if (!response.ok) throw new Error("Sample unavailable");
      const decoded = decodeBuffer(await response.arrayBuffer());
      setDocument(decoded.text, "ARCHITECTURE.md", "示例文档", decoded.encoding);
    } catch (_) {
      setDocument(
        "# 欢迎使用墨读\n\n一个零构建、隐私友好的本地 Markdown 阅读器。\n\n## 开始使用\n\n点击右上角 **打开 Markdown**，或把文件拖到页面中。\n\n- 左侧编辑原文\n- 右侧实时预览\n- 章节级双向滚动同步\n- 目录、查找、专注阅读与导出\n\n> 文件只在当前浏览器页面中处理，不会上传。",
        "欢迎.md",
        "使用提示"
      );
    }
  }

  els.openButton.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    openFile(els.fileInput.files && els.fileInput.files[0]);
    els.fileInput.value = "";
  });
  els.saveMarkdownButton.addEventListener("click", saveMarkdown);
  els.exportHtmlButton.addEventListener("click", exportHtml);
  els.printButton.addEventListener("click", () => window.print());
  els.themeButton.addEventListener("click", () => applyTheme(els.root.dataset.theme === "dark" ? "light" : "dark"));
  els.syncButton.addEventListener("click", toggleSync);
  els.focusButton.addEventListener("click", toggleFocus);
  els.fontDecrease.addEventListener("click", () => changeFont(-.05));
  els.fontIncrease.addEventListener("click", () => changeFont(.05));
  els.outlineButton.addEventListener("click", toggleOutline);
  els.outlineClose.addEventListener("click", closeOutline);
  els.outlineBackdrop.addEventListener("click", closeOutline);
  els.findButton.addEventListener("click", openFind);
  els.findClose.addEventListener("click", () => closeFind());
  els.findPrevious.addEventListener("click", () => goToSearchResult(state.searchIndex - 1));
  els.findNext.addEventListener("click", () => goToSearchResult(state.searchIndex + 1));
  els.findInput.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => highlightSearch(els.findInput.value), 80);
  });
  els.findInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      goToSearchResult(state.searchIndex + (event.shiftKey ? -1 : 1));
    }
  });

  els.source.addEventListener("input", () => {
    state.dirty = true;
    els.savedState.textContent = "已修改";
    scheduleRender();
  });
  els.source.addEventListener("scroll", () => syncScroll("source"), { passive: true });
  els.previewScroll.addEventListener("scroll", () => {
    syncScroll("preview");
    updateProgress();
  }, { passive: true });

  els.preview.addEventListener("click", async (event) => {
    const copyButton = event.target.closest(".copy-code");
    if (copyButton) {
      const code = copyButton.parentElement.querySelector("code");
      try {
        await navigator.clipboard.writeText(code ? code.textContent : "");
        copyButton.textContent = "已复制";
        setTimeout(() => { copyButton.textContent = "复制"; }, 1200);
      } catch (_) {
        showToast("浏览器未允许复制");
      }
      return;
    }

    const link = event.target.closest('a[href^="#"]');
    if (link) {
      const target = document.getElementById(decodeURIComponent(link.getAttribute("href").slice(1)));
      if (target) {
        event.preventDefault();
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    }
  });

  window.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "o") {
      event.preventDefault();
      els.fileInput.click();
    } else if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveMarkdown();
    } else if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
    } else if (event.altKey && event.key === "ArrowLeft" && !els.findBar.hidden) {
      event.preventDefault();
      goToSearchResult(state.searchIndex - 1);
    } else if (event.altKey && event.key === "ArrowRight" && !els.findBar.hidden) {
      event.preventDefault();
      goToSearchResult(state.searchIndex + 1);
    } else if (event.key === "Escape") {
      if (!els.findBar.hidden) closeFind();
      else closeOutline();
    }
  });

  window.addEventListener("dragenter", (event) => {
    event.preventDefault();
    state.dragDepth += 1;
    els.dropOverlay.classList.add("is-visible");
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("dragleave", (event) => {
    event.preventDefault();
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) els.dropOverlay.classList.remove("is-visible");
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    state.dragDepth = 0;
    els.dropOverlay.classList.remove("is-visible");
    openFile(event.dataTransfer && event.dataTransfer.files[0]);
  });
  window.addEventListener("resize", () => requestAnimationFrame(buildSyncPoints));
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  const savedTheme = localStorage.getItem("modu-theme");
  applyTheme(savedTheme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const savedScale = Number(localStorage.getItem("modu-font-scale"));
  state.fontScale = Number.isFinite(savedScale) && savedScale >= .85 && savedScale <= 1.3 ? savedScale : 1;
  els.root.style.setProperty("--reader-size", `${15.5 * state.fontScale}px`);
  initSplitter();
  loadSample();
})();
