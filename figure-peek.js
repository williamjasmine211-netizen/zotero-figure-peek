(function (root, factory) {
  const Plugin = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = Plugin;
  }
  else {
    root.FigurePeekPlugin = Plugin;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PANEL_ID = "zotero-figure-peek-panel";
  const SEARCH_BATCH_SIZE = 4;
  const MAX_RENDER_PIXELS = 10_000_000;
  const PAGE_CACHE_LIMIT = 32;
  const RENDER_CACHE_LIMIT = 10;
  const SINGLE_CLICK_DELAY = 360;
  const PANEL_MARGIN = 14;
  const PANEL_MIN_WIDTH = 360;
  const PANEL_MIN_HEIGHT = 280;
  const PANEL_MAX_WIDTH = 760;
  const PANEL_MAX_HEIGHT = 640;
  const PANEL_MAXIMIZED_TOP = 52;
  const PANEL_ZOOM_LEVELS = [1, 1.25, 1.5, 2, 3, 4];
  const PANEL_WHEEL_THRESHOLD = 40;
  const PANEL_SCROLLBAR_HIT_SIZE = 16;

  class FigurePeekPlugin {
    constructor({ Zotero, Services, pluginID, rootURI, core }) {
      this.Zotero = Zotero;
      this.Services = Services;
      this.pluginID = pluginID;
      this.rootURI = rootURI;
      this.core = core;
      this._renderSequence = 0;
      this._preferredPanelSize = null;
      this._readerMap = new WeakMap();
      this._readerStates = new Set();
      this._started = false;
      this._stopped = false;
      this._toolbarHandler = event => {
        this.ensureReader(event.reader, event.doc).catch(error => this._reportError(error));
      };
    }

    async start() {
      if (this._started) {
        return;
      }
      this._started = true;
      this.Zotero.Reader.registerEventListener("renderToolbar", this._toolbarHandler, this.pluginID);

      const readers = this.Zotero.Reader._readers ? Array.from(this.Zotero.Reader._readers) : [];
      const results = await Promise.allSettled(readers.map(reader => this.ensureReader(reader, this._readerDocument(reader))));
      for (const result of results) {
        if (result.status === "rejected") {
          this._reportError(result.reason);
        }
      }
      this._debug(`已启动，检测到 ${readers.length} 个已打开阅读器`);
    }

    async shutdown() {
      this._stopped = true;
      for (const state of [...this._readerStates]) {
        this._cleanupReader(state);
      }
      this._readerStates.clear();
      this._debug("已停止");
    }

    getStatus() {
      const readers = [...this._readerStates];
      return {
        started: this._started,
        stopped: this._stopped,
        readers: readers.length,
        views: readers.reduce((sum, state) => sum + state.views.size, 0),
        openPanels: readers.filter(state => state.panel).length,
      };
    }

    async ensureReader(reader, doc) {
      if (this._stopped || !reader || reader.type !== "pdf") {
        return;
      }
      let state = this._readerMap.get(reader);
      if (!state || state.closed) {
        state = {
          reader,
          doc: doc || this._readerDocument(reader),
          views: new Map(),
          panel: null,
          requestID: 0,
          attachPromise: null,
          probeTimer: null,
          closed: false,
          docWindow: null,
          onDocumentUnload: null,
        };
        this._readerMap.set(reader, state);
        this._readerStates.add(state);
      }
      this._bindReaderDocument(state, doc || state.doc);
      this._scheduleReaderProbe(state);

      if (state.attachPromise) {
        return state.attachPromise;
      }
      state.attachPromise = this._attachReaderViews(state).finally(() => {
        state.attachPromise = null;
      });
      return state.attachPromise;
    }

    async _attachReaderViews(readerState) {
      const { reader } = readerState;
      if (this._isCancelled(readerState)) {
        return;
      }
      if (typeof reader._waitForReader === "function") {
        await reader._waitForReader();
      }
      if (this._isCancelled(readerState)) {
        return;
      }
      const internalReader = reader._internalReader;
      if (!internalReader) {
        return;
      }
      readerState.doc ||= this._readerDocument(reader);
      this._bindReaderDocument(readerState, readerState.doc);
      const views = [internalReader._primaryView, internalReader._secondaryView].filter(Boolean);
      for (const view of views) {
        await this._attachView(readerState, view);
      }
    }

    async _attachView(readerState, view) {
      if (this._isCancelled(readerState)) {
        return;
      }
      if (view.initializedPromise) {
        await this._withTimeout(view.initializedPromise, 12_000, "PDF 阅读器初始化超时");
      }
      if (this._isCancelled(readerState)) {
        return;
      }
      const pdfWindow = view._iframeWindow;
      if (!pdfWindow || readerState.views.has(pdfWindow)) {
        return;
      }
      const app = await this._waitForValue(
        () => pdfWindow.PDFViewerApplication,
        8_000,
        () => this._isCancelled(readerState) || view._iframeWindow !== pdfWindow,
      );
      if (!app || this._isCancelled(readerState) || view._iframeWindow !== pdfWindow) {
        return;
      }
      await this._waitForValue(
        () => app.pdfDocument,
        12_000,
        () => this._isCancelled(readerState) || view._iframeWindow !== pdfWindow,
      );
      if (!app.pdfDocument || !app.pdfViewer || this._isCancelled(readerState) || view._iframeWindow !== pdfWindow) {
        return;
      }

      const bridgeWindow = pdfWindow.wrappedJSObject || pdfWindow;
      if (!bridgeWindow.FigurePeekRendererBridge) {
        this.Services.scriptloader.loadSubScript(
          `${this.rootURI}renderer-bridge.js`,
          pdfWindow,
          "UTF-8",
        );
      }
      const rendererBridge = bridgeWindow.FigurePeekRendererBridge;
      if (!rendererBridge?.render || !rendererBridge?.cancel) {
        throw new Error("无法初始化 PDF 图像渲染桥接器");
      }

      const viewState = {
        readerState,
        view,
        window: pdfWindow,
        app,
        rendererBridge,
        pageCache: new Map(),
        renderCache: new Map(),
        renderTasks: new Set(),
        pointerCandidate: null,
        suppressClickUntil: 0,
        blockNativeLinkClickUntil: 0,
        blockNativeLinkElement: null,
        openTimer: null,
        lastPointerDown: null,
        closed: false,
      };
      viewState.onPointerDown = event => this._onPointerDown(viewState, event);
      viewState.onPointerMove = event => this._onPointerMove(viewState, event);
      viewState.onPointerUp = event => this._onPointerUp(viewState, event);
      viewState.onClick = event => this._onClick(viewState, event);
      viewState.onKeyDown = event => {
        if (event.key === "Escape" && readerState.panel && !readerState.panel.closed) {
          event.preventDefault();
          event.stopPropagation();
          this._closePanel(readerState.panel);
        }
      };
      viewState.onUnload = () => this._cleanupView(viewState);

      if (this._isCancelled(readerState) || view._iframeWindow !== pdfWindow) {
        return;
      }
      pdfWindow.document.addEventListener("pointerdown", viewState.onPointerDown, true);
      pdfWindow.document.addEventListener("pointermove", viewState.onPointerMove, true);
      pdfWindow.document.addEventListener("pointerup", viewState.onPointerUp, true);
      pdfWindow.document.addEventListener("click", viewState.onClick, true);
      pdfWindow.addEventListener("keydown", viewState.onKeyDown, true);
      pdfWindow.addEventListener("unload", viewState.onUnload, { once: true });
      readerState.views.set(pdfWindow, viewState);
      this._debug("已连接 PDF 阅读视图");
    }

    _onPointerDown(viewState, event) {
      viewState.pointerCandidate = null;
      if (!this._isSimplePointerEvent(viewState, event)) {
        return;
      }
      const target = this._eventElement(event);
      const annotationLink = target?.closest?.(".annotationLayer a");
      const textLayer = this._closestElementAtEvent(viewState, event, ".textLayer");
      if ((!textLayer && !annotationLink)
        || (!annotationLink && target.closest("a, button, input, textarea, [contenteditable='true']"))) {
        return;
      }
      const selection = viewState.window.getSelection?.();
      if (selection && !selection.isCollapsed) {
        return;
      }
      const location = this._pointerLocation(viewState, event);
      if (!location) {
        return;
      }
      const pageData = viewState.view._pdfPages?.[location.pageIndex];
      if (!pageData?.chars?.length) {
        return;
      }
      const hit = this.core.findReferenceAtPoint(pageData, location.point);
      if (!hit) {
        return;
      }
      const now = Date.now();
      const previous = viewState.lastPointerDown;
      const repeated = previous
        && now - previous.time < 340
        && Math.hypot(event.clientX - previous.clientX, event.clientY - previous.clientY) < 8;
      viewState.lastPointerDown = repeated ? null : { time: now, clientX: event.clientX, clientY: event.clientY };
      if (repeated && viewState.openTimer) {
        clearTimeout(viewState.openTimer);
        viewState.openTimer = null;
      }
      const nativeDestination = this._findNativeDestination(viewState, pageData, location);
      const candidate = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        location,
        pageData,
        hit,
        anchor: this._outerAnchor(viewState, event.clientX, event.clientY),
        skipOpen: repeated,
        annotationLink,
        nativeDestination,
      };
      viewState.pointerCandidate = candidate;
      // A PDF annotation link can sit above a valid text layer.  Some PDFs expose
      // that link without a destination shape Zotero's private API can read.  The
      // text reference is still usable, so fall back to caption search instead of
      // silently turning the plug-in off for that click.
      if (!candidate.skipOpen && (!annotationLink || nativeDestination || textLayer)) {
        this._scheduleOpen(viewState, () => this._openFigure(
          viewState,
          candidate.location,
          candidate.hit,
          candidate.anchor,
          candidate.nativeDestination,
        ));
      }
    }

    _onPointerMove(viewState, event) {
      const candidate = viewState.pointerCandidate;
      if (!candidate || candidate.pointerId !== event.pointerId) {
        return;
      }
      if (Math.hypot(event.clientX - candidate.clientX, event.clientY - candidate.clientY) > 5) {
        viewState.pointerCandidate = null;
        if (viewState.openTimer) {
          clearTimeout(viewState.openTimer);
          viewState.openTimer = null;
        }
      }
    }

    _onPointerUp(viewState, event) {
      const candidate = viewState.pointerCandidate;
      viewState.pointerCandidate = null;
      if (!candidate || candidate.pointerId !== event.pointerId || !this._isSimplePointerEvent(viewState, event)) {
        return;
      }
      const movement = Math.hypot(event.clientX - candidate.clientX, event.clientY - candidate.clientY);
      if (movement > 5) {
        if (viewState.openTimer) {
          clearTimeout(viewState.openTimer);
          viewState.openTimer = null;
        }
        return;
      }
      const nativeDestination = candidate.nativeDestination;
      if (candidate.annotationLink && !nativeDestination) {
        return;
      }
      if (nativeDestination) {
        // Zotero navigates internal links in a bubbling window pointerup listener.
        // Intercept only that case; plain text figure references keep Zotero's full
        // pointer lifecycle, including annotation and selection cleanup.
        event.preventDefault();
        event.stopPropagation();
        this._releaseReaderGesture(viewState.view);
        if (candidate.annotationLink) {
          viewState.blockNativeLinkClickUntil = Date.now() + 900;
          viewState.blockNativeLinkElement = candidate.annotationLink;
        }
      }
      viewState.suppressClickUntil = Date.now() + 600;
    }

    _onClick(viewState, event) {
      const target = this._eventElement(event);
      const annotationLink = target?.closest?.(".annotationLayer a");
      if (annotationLink
        && annotationLink === viewState.blockNativeLinkElement
        && Date.now() < viewState.blockNativeLinkClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        viewState.blockNativeLinkElement = null;
        viewState.blockNativeLinkClickUntil = 0;
        return;
      }
      if (Date.now() < viewState.suppressClickUntil || !this._isSimplePointerEvent(viewState, event)) {
        return;
      }
      if (event.detail > 1) {
        // Repeated pointerdowns already cancel the pending single-click action.
        // Do not cancel here: Gecko can report a stale click count for synthetic
        // or accessibility-generated clicks even when this is a new gesture.
        return;
      }
      if (!this._closestElementAtEvent(viewState, event, ".textLayer")
        || target.closest("a, button, input, textarea, [contenteditable='true']")) {
        return;
      }
      const selection = viewState.window.getSelection?.();
      if (selection && !selection.isCollapsed) {
        return;
      }
      const location = this._pointerLocation(viewState, event);
      if (!location) {
        return;
      }
      const anchor = this._outerAnchor(viewState, event.clientX, event.clientY);
      this._scheduleOpen(viewState, () => this._openFromUncachedClick(viewState, location, anchor));
    }

    _scheduleOpen(viewState, operation) {
      if (viewState.openTimer) {
        clearTimeout(viewState.openTimer);
      }
      viewState.openTimer = setTimeout(async () => {
        viewState.openTimer = null;
        if (viewState.closed || this._isCancelled(viewState.readerState)) {
          return;
        }
        try {
          await operation();
        }
        catch (error) {
          this._reportPanelError(viewState.readerState, error);
        }
      }, SINGLE_CLICK_DELAY);
    }

    async _openFromUncachedClick(viewState, location, anchor) {
      const pageData = await this._getPageData(viewState, location.pageIndex);
      const hit = this.core.findReferenceAtPoint(pageData, location.point);
      if (!hit) {
        return;
      }
      const nativeDestination = this._findNativeDestination(viewState, pageData, location);
      await this._openFigure(viewState, location, hit, anchor, nativeDestination);
    }

    async _openFigure(viewState, location, hit, anchor, nativeDestination) {
      const readerState = viewState.readerState;
      const requestID = ++readerState.requestID;
      const panel = this._ensurePanel(readerState, anchor);
      this._cancelPanelRender(panel);
      panel.renderID++;
      panel.currentResult = null;
      panel.activeViewState = viewState;
      panel.title.textContent = hit.reference.display;
      const targetLabel = hit.reference.kind === "equation"
        ? "公式"
        : hit.reference.kind === "table" ? "表题" : "图注";
      this._setPanelLoading(panel, `${hit.reference.display} · 正在定位${targetLabel}…`);

      const result = await this._resolveFigure(
        viewState,
        location.pageIndex,
        hit,
        nativeDestination,
        progress => {
          if (readerState.requestID === requestID) {
            this._setPanelLoading(panel, progress);
          }
        },
        () => readerState.requestID !== requestID || panel.closed,
      );
      if (readerState.requestID !== requestID || panel.closed) {
        return;
      }
      if (!result) {
        this._showPanelError(panel, `没有找到 ${hit.reference.display} 的${targetLabel}。可先确认 PDF 已完成 OCR，或点击正文中更完整的引用。`);
        return;
      }
      panel.currentResult = result;
      await this._renderPanelResult(panel, result, "figure");
    }

    async _resolveFigure(viewState, sourcePageIndex, hit, nativeDestination, onProgress, isCancelled) {
      const pageCount = viewState.app.pdfDocument.numPages || viewState.app.pagesCount || 0;
      if (!pageCount) {
        throw new Error("无法读取 PDF 页数");
      }

      if (nativeDestination && Number.isInteger(nativeDestination.pageIndex)) {
        const targetData = await this._getPageData(viewState, nativeDestination.pageIndex);
        const targetRect = this.core.unionRects(nativeDestination.rects || []);
        if (targetRect) {
          const caption = {
            pageIndex: nativeDestination.pageIndex,
            rect: targetRect,
            referenceRect: targetRect,
            text: "PDF 内部链接定位",
            confidence: "high",
            score: 999,
          };
          return this._makeResult(viewState, targetData, caption, hit.reference);
        }
      }

      const order = this.core.makeSearchOrder(sourcePageIndex, pageCount);
      const nearby = order.filter(pageIndex => Math.abs(pageIndex - sourcePageIndex) <= 5);
      const remaining = order.filter(pageIndex => Math.abs(pageIndex - sourcePageIndex) > 5);
      const allCandidates = [];

      await this._scanPages(viewState, nearby, hit.reference, sourcePageIndex, allCandidates, onProgress, isCancelled);
      if (isCancelled()) {
        return null;
      }
      let best = this.core.chooseBestCaption(allCandidates, sourcePageIndex);
      if (!best || best.score < 150 || best.bodyLike) {
        await this._scanPages(viewState, remaining, hit.reference, sourcePageIndex, allCandidates, onProgress, isCancelled);
        best = this.core.chooseBestCaption(allCandidates, sourcePageIndex);
      }
      if (isCancelled() || !best || best.score < 112) {
        return null;
      }
      const targetData = await this._getPageData(viewState, best.pageIndex);
      return this._makeResult(viewState, targetData, best, hit.reference);
    }

    async _scanPages(viewState, pageIndices, reference, sourcePageIndex, output, onProgress, isCancelled) {
      for (let offset = 0; offset < pageIndices.length; offset += SEARCH_BATCH_SIZE) {
        if (isCancelled()) {
          return;
        }
        const batch = pageIndices.slice(offset, offset + SEARCH_BATCH_SIZE);
        const settled = await Promise.allSettled(batch.map(async pageIndex => ({
          pageIndex,
          pageData: await this._getPageData(viewState, pageIndex),
        })));
        for (const result of settled) {
          if (result.status !== "fulfilled") {
            continue;
          }
          const findCandidates = reference.kind === "equation"
            ? this.core.findEquationCandidates
            : this.core.findCaptionCandidates;
          output.push(...findCandidates(result.value.pageData, reference, {
            pageIndex: result.value.pageIndex,
            sourcePageIndex,
          }));
        }
        const completed = Math.min(offset + batch.length, pageIndices.length);
        if (pageIndices.length > 12 && (completed === pageIndices.length || completed % 20 < SEARCH_BATCH_SIZE)) {
          onProgress(`${reference.display} · 已检索 ${completed}/${pageIndices.length} 页…`);
        }
      }
    }

    _makeResult(viewState, pageData, caption, reference) {
      const crop = reference.kind === "equation"
        ? this.core.makeEquationCrop(pageData, caption)
        : reference.kind === "table"
          ? this.core.makeTableCrop(pageData, caption)
          : this.core.makeFigureCrop(pageData, caption);
      const pageRect = this.core.normalizeRect(pageData.viewBox) || [0, 0, 612, 792];
      return {
        viewState,
        pageIndex: caption.pageIndex,
        reference,
        caption,
        figureRect: crop.rect,
        pageRect,
        crop,
      };
    }

    async _getPageData(viewState, pageIndex) {
      if (viewState.pageCache.has(pageIndex)) {
        const cached = viewState.pageCache.get(pageIndex);
        viewState.pageCache.delete(pageIndex);
        viewState.pageCache.set(pageIndex, cached);
        return cached;
      }
      const promise = (async () => {
        const existing = viewState.view._pdfPages?.[pageIndex];
        const data = existing || await viewState.app.pdfDocument.getPageData({ pageIndex });
        if (!data || !Array.isArray(data.chars)) {
          throw new Error("当前 Zotero 版本未返回可用的页面文本数据");
        }
        if (!Number.isInteger(data.pageIndex)) {
          data.pageIndex = pageIndex;
        }
        return data;
      })();
      viewState.pageCache.set(pageIndex, promise);
      while (viewState.pageCache.size > PAGE_CACHE_LIMIT) {
        viewState.pageCache.delete(viewState.pageCache.keys().next().value);
      }
      promise.catch(() => {
        if (viewState.pageCache.get(pageIndex) === promise) {
          viewState.pageCache.delete(pageIndex);
        }
      });
      return promise;
    }

    _ensurePanel(readerState, anchor) {
      if (readerState.panel && !readerState.panel.closed) {
        this._positionPanel(readerState.panel, anchor);
        readerState.panel.host.hidden = false;
        return readerState.panel;
      }
      const doc = readerState.doc || this._readerDocument(readerState.reader);
      if (!doc?.documentElement) {
        throw new Error("无法访问 Zotero 阅读器界面");
      }
      const stale = doc.getElementById?.(PANEL_ID);
      stale?.remove();

      const host = doc.createElement("div");
      host.id = PANEL_ID;
      host.style.position = "fixed";
      host.style.zIndex = "2147483647";
      host.style.left = "20px";
      host.style.top = "20px";
      const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
      root.innerHTML = `
        <style>
          :host { all: initial; }
          .panel {
            position: relative; width: min(720px, calc(100vw - 28px)); height: min(570px, calc(100vh - 28px));
            min-width: 360px; min-height: 280px; overflow: hidden;
            display: flex; flex-direction: column; color: #202124; background: rgba(252,252,252,.98);
            border: 0; border-radius: 12px; box-shadow: 0 12px 38px rgba(0,0,0,.28);
            font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
          }
          header { height: 38px; flex: 0 0 38px; display: flex; align-items: center; gap: 6px;
            padding: 0 8px 0 12px; background: rgba(242,242,244,.98); cursor: grab; user-select: none; touch-action: none; }
          .panel.is-dragging header { cursor: grabbing; }
          .title { min-width: 0; flex: 1; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          button { appearance: none; border: 0; border-radius: 7px; padding: 5px 8px; color: inherit;
            background: transparent; font: inherit; cursor: pointer; }
          button:hover { background: rgba(0,0,0,.08); }
          button:disabled { opacity: .45; cursor: default; background: transparent; }
          button.zoom { min-width: 27px; padding-inline: 6px; font-size: 16px; line-height: 18px; }
          button.zoom-label { min-width: 47px; padding-inline: 5px; font-size: 11px; }
          button.close { width: 28px; padding: 4px; font-size: 19px; line-height: 20px; }
          .content { position: relative; flex: 1; min-height: 0; overflow: auto;
            background: #fff; }
          .image-stage { display: none; width: 100%; height: 100%; min-width: 100%; min-height: 100%;
            align-items: center; justify-content: center; background: #fff; }
          img { display: block; width: 100%; height: 100%; object-fit: contain; user-select: none; }
          .content.is-pannable .image-stage, .content.is-pannable img { cursor: grab; touch-action: none; }
          .content.is-panning .image-stage, .content.is-panning img { cursor: grabbing; }
          .status { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px;
            color: #555; text-align: center; box-sizing: border-box; }
          .status.error { color: #9f2525; }
          .resize-handle { position: absolute; right: 0; bottom: 0; width: 24px; height: 24px; z-index: 8;
            cursor: nwse-resize; touch-action: none; }
          .resize-handle::after { content: ""; position: absolute; right: 5px; bottom: 5px; width: 11px; height: 11px;
            opacity: .65; background: repeating-linear-gradient(135deg, transparent 0 3px, currentColor 3px 4px); }
          @media (prefers-color-scheme: dark) {
            .panel { color: #eee; background: rgba(39,39,42,.98); box-shadow: 0 12px 42px rgba(0,0,0,.55); }
            header { background: rgba(48,48,52,.98); }
            .content { background: #202124; }
            .image-stage { background: #202124; }
            .status { color: #bbb; }
            button:hover { background: rgba(255,255,255,.12); }
            .status.error { color: #ff9b9b; }
          }
        </style>
        <section class="panel" role="dialog" aria-label="图片预览" aria-live="polite">
          <header>
            <span class="title">图窗</span>
            <button type="button" class="zoom" data-action="zoom-out" title="缩小图片" disabled>−</button>
            <button type="button" class="zoom-label" data-action="zoom-reset" title="恢复适合窗口" disabled>适配</button>
            <button type="button" class="zoom" data-action="zoom-in" title="放大图片" disabled>＋</button>
            <button type="button" data-action="toggle-page" title="在图像裁剪和整页之间切换" disabled>整页</button>
            <button type="button" data-action="locate" title="跳转到原图位置" disabled>原图</button>
            <button type="button" data-action="maximize" title="放大图窗">放大</button>
            <button type="button" class="close" data-action="close" title="关闭（Esc）" aria-label="关闭">×</button>
          </header>
          <div class="content"><div class="status">准备中…</div><div class="image-stage"><img alt="对应内容预览" draggable="false"></div></div>
          <div class="resize-handle" data-action="resize" title="拖动调整图窗大小" aria-label="调整图窗大小"></div>
        </section>`;
      (doc.body || doc.documentElement).append(host);

      const panel = {
        readerState,
        host,
        root,
        element: root.querySelector(".panel"),
        header: root.querySelector("header"),
        title: root.querySelector(".title"),
        status: root.querySelector(".status"),
        content: root.querySelector(".content"),
        imageStage: root.querySelector(".image-stage"),
        image: root.querySelector("img"),
        toggleButton: root.querySelector("[data-action='toggle-page']"),
        locateButton: root.querySelector("[data-action='locate']"),
        zoomOutButton: root.querySelector("[data-action='zoom-out']"),
        zoomResetButton: root.querySelector("[data-action='zoom-reset']"),
        zoomInButton: root.querySelector("[data-action='zoom-in']"),
        maximizeButton: root.querySelector("[data-action='maximize']"),
        resizeHandle: root.querySelector("[data-action='resize']"),
        currentResult: null,
        activeViewState: null,
        activeRenderTask: null,
        activeRenderCacheKey: null,
        mode: "figure",
        zoom: 1,
        wheelRemainder: 0,
        maximized: false,
        restoreBox: null,
        renderID: 0,
        closed: false,
        cleanups: [],
      };
      readerState.panel = panel;
      const initialSize = this._preferredPanelSize || this._defaultPanelSize(doc.defaultView);
      this._applyPanelSize(panel, initialSize.width, initialSize.height);
      this._wirePanel(panel);
      this._positionPanel(panel, anchor);
      return panel;
    }

    _wirePanel(panel) {
      const outerWindow = panel.readerState.doc.defaultView;
      const onClick = event => {
        const action = event.target?.dataset?.action;
        if (action === "close") {
          this._closePanel(panel);
        }
        else if (action === "toggle-page" && panel.currentResult) {
          const mode = panel.mode === "figure" ? "page" : "figure";
          this._renderPanelResult(panel, panel.currentResult, mode).catch(error => {
            if (error?.name !== "RenderingCancelledException") {
              this._showPanelError(panel, error.message);
            }
          });
        }
        else if (action === "locate" && panel.currentResult) {
          const result = panel.currentResult;
          panel.readerState.reader.navigate?.({
            position: { pageIndex: result.pageIndex, rects: [result.caption.referenceRect || result.caption.rect] },
          });
        }
        else if (action === "zoom-in" && panel.currentResult) {
          this._stepPanelZoom(panel, 1);
        }
        else if (action === "zoom-out" && panel.currentResult) {
          this._stepPanelZoom(panel, -1);
        }
        else if (action === "zoom-reset" && panel.currentResult) {
          this._setPanelZoom(panel, 1);
        }
        else if (action === "maximize") {
          this._togglePanelMaximize(panel);
        }
      };
      panel.root.addEventListener("click", onClick);
      panel.cleanups.push(() => panel.root.removeEventListener("click", onClick));

      const onKeyDown = event => {
        if (event.key === "Escape" && !panel.closed) {
          this._closePanel(panel);
        }
      };
      outerWindow.addEventListener("keydown", onKeyDown, true);
      panel.cleanups.push(() => outerWindow.removeEventListener("keydown", onKeyDown, true));

      let drag = null;
      let pan = null;
      let resize = null;
      const onPointerDown = event => {
        if (event.button !== 0 || panel.maximized || event.target.closest("button")) {
          return;
        }
        const rect = panel.host.getBoundingClientRect();
        drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        panel.element.classList.add("is-dragging");
        panel.header.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      };
      const onPointerMove = event => {
        if (resize) {
          if (resize.pointerId !== event.pointerId) {
            return;
          }
          const width = resize.width + event.clientX - resize.x;
          const height = resize.height + event.clientY - resize.y;
          this._applyPanelSize(panel, width, height, true);
          event.preventDefault();
          return;
        }
        if (pan) {
          if (pan.pointerId !== event.pointerId) {
            return;
          }
          this._movePanelPan(panel, pan, event);
          event.preventDefault();
          return;
        }
        if (drag) {
          if (drag.pointerId !== event.pointerId) {
            return;
          }
          const rect = panel.element.getBoundingClientRect();
          const maxLeft = Math.max(PANEL_MARGIN, outerWindow.innerWidth - rect.width - PANEL_MARGIN);
          const maxTop = Math.max(PANEL_MARGIN, outerWindow.innerHeight - rect.height - PANEL_MARGIN);
          panel.host.style.left = `${Math.max(PANEL_MARGIN, Math.min(maxLeft, drag.left + event.clientX - drag.x))}px`;
          panel.host.style.top = `${Math.max(PANEL_MARGIN, Math.min(maxTop, drag.top + event.clientY - drag.y))}px`;
        }
      };
      const onPointerUp = event => {
        if (resize && resize.pointerId === event.pointerId) {
          try { panel.resizeHandle.releasePointerCapture?.(event.pointerId); }
          catch (_) {}
          resize = null;
          panel.maximized = false;
          panel.restoreBox = null;
          panel.maximizeButton.textContent = "放大";
          this._rememberPanelSize(panel);
        }
        if (pan && pan.pointerId === event.pointerId) {
          try { panel.content.releasePointerCapture?.(event.pointerId); }
          catch (_) {}
          pan = null;
          panel.content.classList.remove("is-panning");
        }
        if (drag && drag.pointerId === event.pointerId) {
          try { panel.header.releasePointerCapture?.(event.pointerId); }
          catch (_) {}
          drag = null;
          panel.element.classList.remove("is-dragging");
        }
      };
      const onResizePointerDown = event => {
        if (event.button !== 0) {
          return;
        }
        const rect = panel.element.getBoundingClientRect();
        resize = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
        panel.resizeHandle.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      };
      const onContentPointerDown = event => {
        if (
          event.button !== 0
          || !panel.currentResult
          || !panel.image.src
          || panel.zoom <= 1
          || !event.target?.closest?.(".image-stage, img")
        ) {
          return;
        }
        pan = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: panel.content.scrollLeft,
          top: panel.content.scrollTop,
        };
        panel.content.classList.add("is-panning");
        panel.content.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      };
      const onWheel = event => this._handlePanelWheel(panel, event);
      const onDoubleClickImage = () => {
        this._setPanelZoom(panel, panel.zoom === 1 ? 2 : 1);
      };
      const onWindowResize = () => {
        if (panel.maximized) {
          panel.host.style.left = `${PANEL_MARGIN}px`;
          panel.host.style.top = `${PANEL_MAXIMIZED_TOP}px`;
          this._applyPanelSize(
            panel,
            outerWindow.innerWidth - PANEL_MARGIN * 2,
            outerWindow.innerHeight - PANEL_MAXIMIZED_TOP - PANEL_MARGIN,
            true,
          );
        }
        this._keepPanelInBounds(panel);
      };
      panel.header.addEventListener("pointerdown", onPointerDown);
      panel.resizeHandle.addEventListener("pointerdown", onResizePointerDown);
      panel.content.addEventListener("pointerdown", onContentPointerDown);
      panel.content.addEventListener("wheel", onWheel, { passive: false });
      panel.image.addEventListener("dblclick", onDoubleClickImage);
      outerWindow.addEventListener("pointermove", onPointerMove, true);
      outerWindow.addEventListener("pointerup", onPointerUp, true);
      outerWindow.addEventListener("pointercancel", onPointerUp, true);
      outerWindow.addEventListener("resize", onWindowResize);
      panel.cleanups.push(() => panel.header.removeEventListener("pointerdown", onPointerDown));
      panel.cleanups.push(() => panel.resizeHandle.removeEventListener("pointerdown", onResizePointerDown));
      panel.cleanups.push(() => panel.content.removeEventListener("pointerdown", onContentPointerDown));
      panel.cleanups.push(() => panel.content.removeEventListener("wheel", onWheel));
      panel.cleanups.push(() => panel.image.removeEventListener("dblclick", onDoubleClickImage));
      panel.cleanups.push(() => outerWindow.removeEventListener("pointermove", onPointerMove, true));
      panel.cleanups.push(() => outerWindow.removeEventListener("pointerup", onPointerUp, true));
      panel.cleanups.push(() => outerWindow.removeEventListener("pointercancel", onPointerUp, true));
      panel.cleanups.push(() => outerWindow.removeEventListener("resize", onWindowResize));
    }

    _defaultPanelSize(outerWindow) {
      const innerWidth = Math.max(320, Number(outerWindow?.innerWidth) || 1000);
      const innerHeight = Math.max(260, Number(outerWindow?.innerHeight) || 730);
      const maxWidth = Math.max(240, innerWidth - PANEL_MARGIN * 2);
      const maxHeight = Math.max(220, innerHeight - PANEL_MARGIN * 2);
      const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
      const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
      return {
        width: Math.min(maxWidth, Math.max(minWidth, Math.min(PANEL_MAX_WIDTH, Math.round(innerWidth * 0.72)))),
        height: Math.min(maxHeight, Math.max(minHeight, Math.min(PANEL_MAX_HEIGHT, Math.round(innerHeight * 0.78)))),
      };
    }

    _applyPanelSize(panel, width, height, respectPosition = false) {
      const outerWindow = panel.readerState.doc.defaultView;
      const innerWidth = Math.max(240, Number(outerWindow.innerWidth) || 1000);
      const innerHeight = Math.max(220, Number(outerWindow.innerHeight) || 730);
      const currentRect = panel.element.getBoundingClientRect?.() || { left: PANEL_MARGIN, top: PANEL_MARGIN };
      const left = respectPosition ? Math.max(PANEL_MARGIN, currentRect.left) : PANEL_MARGIN;
      const top = respectPosition ? Math.max(PANEL_MARGIN, currentRect.top) : PANEL_MARGIN;
      const maxWidth = Math.max(240, innerWidth - left - PANEL_MARGIN);
      const maxHeight = Math.max(220, innerHeight - top - PANEL_MARGIN);
      const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
      const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
      const safeWidth = Math.min(maxWidth, Math.max(minWidth, Number(width) || minWidth));
      const safeHeight = Math.min(maxHeight, Math.max(minHeight, Number(height) || minHeight));
      const widthPx = `${Math.round(safeWidth)}px`;
      const heightPx = `${Math.round(safeHeight)}px`;
      // A shadow child can paint outside its host without enlarging the host's
      // pointer hit-test box. Keep both boxes synchronized so controls and the
      // resize handle remain clickable after the panel grows.
      panel.host.style.width = widthPx;
      panel.host.style.height = heightPx;
      panel.element.style.width = widthPx;
      panel.element.style.height = heightPx;
      return { width: Math.round(safeWidth), height: Math.round(safeHeight) };
    }

    _rememberPanelSize(panel) {
      if (!panel || panel.closed || panel.maximized) {
        return;
      }
      const rect = panel.element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        this._preferredPanelSize = { width: Math.round(rect.width), height: Math.round(rect.height) };
      }
    }

    _keepPanelInBounds(panel) {
      if (!panel || panel.closed) {
        return;
      }
      const outerWindow = panel.readerState.doc.defaultView;
      let rect = panel.element.getBoundingClientRect();
      if (rect.width > outerWindow.innerWidth - PANEL_MARGIN * 2
        || rect.height > outerWindow.innerHeight - PANEL_MARGIN * 2) {
        this._applyPanelSize(
          panel,
          Math.min(rect.width, outerWindow.innerWidth - PANEL_MARGIN * 2),
          Math.min(rect.height, outerWindow.innerHeight - PANEL_MARGIN * 2),
        );
        rect = panel.element.getBoundingClientRect();
      }
      const left = Math.max(PANEL_MARGIN, Math.min(
        Number.parseFloat(panel.host.style.left) || rect.left || PANEL_MARGIN,
        outerWindow.innerWidth - rect.width - PANEL_MARGIN,
      ));
      const top = Math.max(PANEL_MARGIN, Math.min(
        Number.parseFloat(panel.host.style.top) || rect.top || PANEL_MARGIN,
        outerWindow.innerHeight - rect.height - PANEL_MARGIN,
      ));
      panel.host.style.left = `${Math.round(left)}px`;
      panel.host.style.top = `${Math.round(top)}px`;
    }

    _togglePanelMaximize(panel) {
      if (!panel || panel.closed) {
        return;
      }
      const outerWindow = panel.readerState.doc.defaultView;
      if (!panel.maximized) {
        const rect = panel.element.getBoundingClientRect();
        panel.restoreBox = {
          left: Number.parseFloat(panel.host.style.left) || rect.left || PANEL_MARGIN,
          top: Number.parseFloat(panel.host.style.top) || rect.top || PANEL_MARGIN,
          width: rect.width,
          height: rect.height,
        };
        panel.host.style.left = `${PANEL_MARGIN}px`;
        // The top part of Zotero's Reader is covered by its own toolbar hit-test
        // layer. Keep the panel header below it so visible controls stay clickable.
        panel.host.style.top = `${PANEL_MAXIMIZED_TOP}px`;
        this._applyPanelSize(
          panel,
          outerWindow.innerWidth - PANEL_MARGIN * 2,
          outerWindow.innerHeight - PANEL_MAXIMIZED_TOP - PANEL_MARGIN,
          true,
        );
        panel.maximized = true;
        panel.maximizeButton.textContent = "还原";
      }
      else {
        const restore = panel.restoreBox || this._preferredPanelSize || this._defaultPanelSize(outerWindow);
        panel.maximized = false;
        panel.restoreBox = null;
        panel.host.style.left = `${restore.left ?? PANEL_MARGIN}px`;
        panel.host.style.top = `${restore.top ?? PANEL_MARGIN}px`;
        this._applyPanelSize(panel, restore.width, restore.height);
        panel.maximizeButton.textContent = "放大";
        this._keepPanelInBounds(panel);
        this._rememberPanelSize(panel);
      }
    }

    _handlePanelWheel(panel, event) {
      if (!panel || panel.closed || !panel.currentResult || !panel.image?.src || !panel.content) {
        return false;
      }
      const scrollbarAxis = this._getPanelScrollbarAxis(panel, event);
      if (scrollbarAxis) {
        const delta = this._getPanelWheelDelta(panel, event, scrollbarAxis);
        if (!Number.isFinite(delta) || delta === 0) {
          return false;
        }
        panel.wheelRemainder = 0;
        event.preventDefault?.();
        event.stopPropagation?.();
        if (scrollbarAxis === "vertical") {
          const maxScrollTop = Math.max(0, (Number(panel.content.scrollHeight) || 0) - (Number(panel.content.clientHeight) || 0));
          panel.content.scrollTop = Math.max(0, Math.min(maxScrollTop, (Number(panel.content.scrollTop) || 0) + delta));
        }
        else {
          const maxScrollLeft = Math.max(0, (Number(panel.content.scrollWidth) || 0) - (Number(panel.content.clientWidth) || 0));
          panel.content.scrollLeft = Math.max(0, Math.min(maxScrollLeft, (Number(panel.content.scrollLeft) || 0) + delta));
        }
        return true;
      }
      const delta = this._getPanelWheelDelta(panel, event, "vertical");
      if (!Number.isFinite(delta) || delta === 0) {
        return false;
      }
      const total = (Number(panel.wheelRemainder) || 0) + delta;
      event.preventDefault?.();
      event.stopPropagation?.();
      if (Math.abs(total) < PANEL_WHEEL_THRESHOLD) {
        panel.wheelRemainder = total;
        return true;
      }
      panel.wheelRemainder = 0;
      const rect = panel.content.getBoundingClientRect();
      this._stepPanelZoom(panel, total < 0 ? 1 : -1, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
      return true;
    }

    _getPanelWheelDelta(panel, event, axis) {
      const mode = Number(event?.deltaMode) || 0;
      const multiplier = mode === 1 ? 16 : (mode === 2 ? panel.content.clientHeight || 640 : 1);
      const verticalDelta = Number(event?.deltaY);
      const horizontalDelta = Number(event?.deltaX);
      const rawDelta = axis === "horizontal" && Number.isFinite(horizontalDelta) && horizontalDelta !== 0
        ? horizontalDelta
        : verticalDelta;
      return rawDelta * multiplier;
    }

    _movePanelPan(panel, pan, event) {
      const content = panel?.content;
      if (!content || !pan || !event) {
        return false;
      }
      const maxScrollLeft = Math.max(0, (Number(content.scrollWidth) || 0) - (Number(content.clientWidth) || 0));
      const maxScrollTop = Math.max(0, (Number(content.scrollHeight) || 0) - (Number(content.clientHeight) || 0));
      const nextLeft = (Number(pan.left) || 0) - ((Number(event.clientX) || 0) - (Number(pan.x) || 0));
      const nextTop = (Number(pan.top) || 0) - ((Number(event.clientY) || 0) - (Number(pan.y) || 0));
      content.scrollLeft = Math.max(0, Math.min(maxScrollLeft, nextLeft));
      content.scrollTop = Math.max(0, Math.min(maxScrollTop, nextTop));
      return true;
    }

    _getPanelScrollbarAxis(panel, event) {
      const content = panel?.content;
      const rect = content?.getBoundingClientRect?.();
      if (!content || !rect) {
        return null;
      }
      const width = Number(rect.width) || Number(content.offsetWidth) || Number(content.clientWidth) || 0;
      const height = Number(rect.height) || Number(content.offsetHeight) || Number(content.clientHeight) || 0;
      const pointX = Number(event?.clientX) - Number(rect.left);
      const pointY = Number(event?.clientY) - Number(rect.top);
      if (!Number.isFinite(pointX) || !Number.isFinite(pointY) || pointX < 0 || pointY < 0 || pointX > width || pointY > height) {
        return null;
      }
      const clientWidth = Number(content.clientWidth) || width;
      const clientHeight = Number(content.clientHeight) || height;
      const hasVerticalScroll = (Number(content.scrollHeight) || clientHeight) > clientHeight;
      const hasHorizontalScroll = (Number(content.scrollWidth) || clientWidth) > clientWidth;
      // Firefox may render overlay scrollbars without subtracting their size from
      // clientWidth/clientHeight. Keep a narrow edge hit area for that case.
      const verticalScrollbarWidth = hasVerticalScroll
        ? Math.max(PANEL_SCROLLBAR_HIT_SIZE, (Number(content.offsetWidth) || width) - clientWidth)
        : 0;
      const horizontalScrollbarHeight = hasHorizontalScroll
        ? Math.max(PANEL_SCROLLBAR_HIT_SIZE, (Number(content.offsetHeight) || height) - clientHeight)
        : 0;
      const overVerticalScrollbar = hasVerticalScroll
        && verticalScrollbarWidth > 0
        && pointX >= width - verticalScrollbarWidth
        && pointY < height - horizontalScrollbarHeight;
      const overHorizontalScrollbar = hasHorizontalScroll
        && horizontalScrollbarHeight > 0
        && pointY >= height - horizontalScrollbarHeight;
      if (overVerticalScrollbar) {
        return "vertical";
      }
      return overHorizontalScrollbar ? "horizontal" : null;
    }

    _setPanelZoom(panel, zoom, anchor = null) {
      if (!panel || panel.closed) {
        return;
      }
      const previousZoom = Number(panel.zoom) || 1;
      const safeZoom = PANEL_ZOOM_LEVELS.reduce((best, level) => (
        Math.abs(level - Number(zoom)) < Math.abs(best - Number(zoom)) ? level : best
      ), PANEL_ZOOM_LEVELS[0]);
      panel.zoom = safeZoom;
      panel.imageStage.style.width = `${safeZoom * 100}%`;
      panel.imageStage.style.height = `${safeZoom * 100}%`;
      panel.zoomResetButton.textContent = safeZoom === 1 ? "适配" : `${Math.round(safeZoom * 100)}%`;
      const ready = Boolean(panel.currentResult && panel.image.src);
      panel.content?.classList?.toggle("is-pannable", ready && safeZoom > 1);
      panel.zoomOutButton.disabled = !ready || safeZoom <= PANEL_ZOOM_LEVELS[0];
      panel.zoomInButton.disabled = !ready || safeZoom >= PANEL_ZOOM_LEVELS.at(-1);
      panel.zoomResetButton.disabled = !ready || safeZoom === 1;
      if (safeZoom === 1) {
        panel.content.scrollLeft = 0;
        panel.content.scrollTop = 0;
      }
      else if (anchor && previousZoom > 0) {
        const pointX = Math.max(0, Number(anchor.x) || 0);
        const pointY = Math.max(0, Number(anchor.y) || 0);
        const imageX = (panel.content.scrollLeft + pointX) / previousZoom;
        const imageY = (panel.content.scrollTop + pointY) / previousZoom;
        panel.content.scrollLeft = Math.max(0, imageX * safeZoom - pointX);
        panel.content.scrollTop = Math.max(0, imageY * safeZoom - pointY);
      }
    }

    _stepPanelZoom(panel, direction, anchor = null) {
      const currentIndex = Math.max(0, PANEL_ZOOM_LEVELS.indexOf(panel.zoom));
      const nextIndex = Math.max(0, Math.min(PANEL_ZOOM_LEVELS.length - 1, currentIndex + direction));
      if (nextIndex === currentIndex) {
        return false;
      }
      this._setPanelZoom(panel, PANEL_ZOOM_LEVELS[nextIndex], anchor);
      return true;
    }

    _fitPanelToRenderedImage(panel, rendered) {
      if (!panel || panel.closed || panel.maximized || !rendered?.width || !rendered?.height) {
        return;
      }
      const outerWindow = panel.readerState.doc.defaultView;
      const maxWidth = Math.min(PANEL_MAX_WIDTH, Math.max(240, outerWindow.innerWidth - PANEL_MARGIN * 2));
      const maxHeight = Math.min(PANEL_MAX_HEIGHT, Math.max(220, outerWindow.innerHeight - PANEL_MARGIN * 2));
      const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
      const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
      const chromeHeight = 38;
      const aspectRatio = rendered.width / rendered.height;
      if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
        return;
      }
      const currentWidth = panel.element.getBoundingClientRect().width || this._defaultPanelSize(outerWindow).width;
      let width = Math.min(maxWidth, Math.max(minWidth, currentWidth));
      let height = width / aspectRatio + chromeHeight;
      if (height > maxHeight) {
        height = maxHeight;
        width = (height - chromeHeight) * aspectRatio;
      }
      if (height < minHeight) {
        height = minHeight;
        width = Math.min(maxWidth, Math.max(minWidth, (height - chromeHeight) * aspectRatio));
      }
      this._applyPanelSize(panel, width, height, true);
      this._keepPanelInBounds(panel);
    }

    _positionPanel(panel, anchor) {
      if (!anchor || panel.closed) {
        return;
      }
      const outerWindow = panel.readerState.doc.defaultView;
      const rect = panel.element.getBoundingClientRect();
      const estimatedWidth = rect.width || this._defaultPanelSize(outerWindow).width;
      const estimatedHeight = rect.height || this._defaultPanelSize(outerWindow).height;
      const left = anchor.x + 16 + estimatedWidth + PANEL_MARGIN <= outerWindow.innerWidth
        ? anchor.x + 16
        : Math.max(PANEL_MARGIN, anchor.x - estimatedWidth - 16);
      const top = anchor.y + 16 + estimatedHeight + PANEL_MARGIN <= outerWindow.innerHeight
        ? anchor.y + 16
        : Math.max(PANEL_MARGIN, outerWindow.innerHeight - estimatedHeight - PANEL_MARGIN);
      panel.host.style.left = `${left}px`;
      panel.host.style.top = `${top}px`;
      this._keepPanelInBounds(panel);
    }

    _setPanelLoading(panel, message) {
      if (panel.closed) {
        return;
      }
      panel.status.textContent = message;
      panel.status.classList.remove("error");
      panel.status.style.display = "block";
      panel.imageStage.style.display = "none";
      panel.toggleButton.disabled = true;
      panel.locateButton.disabled = true;
      panel.zoom = 1;
      panel.zoomOutButton.disabled = true;
      panel.zoomInButton.disabled = true;
      panel.zoomResetButton.disabled = true;
      panel.zoomResetButton.textContent = "适配";
    }

    _showPanelError(panel, message) {
      if (panel.closed) {
        return;
      }
      panel.status.textContent = message;
      panel.status.classList.add("error");
      panel.status.style.display = "block";
      panel.imageStage.style.display = "none";
      panel.toggleButton.disabled = true;
      panel.locateButton.disabled = true;
    }

    async _renderPanelResult(panel, result, mode) {
      if (panel.closed) {
        return;
      }
      this._cancelPanelRender(panel);
      const renderID = ++panel.renderID;
      panel.mode = mode;
      panel.toggleButton.textContent = mode === "figure" ? "整页" : "只看图";
      this._setPanelLoading(panel, mode === "figure" ? "正在生成图片预览…" : "正在生成整页预览…");
      const rect = mode === "figure" ? result.figureRect : result.pageRect;
      const rendered = await this._renderPDFRegion(result.viewState, result.pageIndex, rect, panel, renderID);
      if (panel.closed || renderID !== panel.renderID) {
        return;
      }
      panel.image.src = rendered.image;
      panel.imageStage.style.display = "flex";
      panel.status.style.display = "none";
      panel.toggleButton.disabled = false;
      panel.locateButton.disabled = false;
      this._fitPanelToRenderedImage(panel, rendered);
      this._setPanelZoom(panel, 1);
    }

    async _renderPDFRegion(viewState, pageIndex, pdfRect, panel = null, renderID = null) {
      const normalized = this.core.normalizeRect(pdfRect);
      if (!normalized) {
        throw new Error("图片区域无效");
      }
      const pageView = viewState.app.pdfViewer.getPageView?.(pageIndex) || viewState.app.pdfViewer._pages?.[pageIndex];
      const pageViewRotation = Number(pageView?.viewport?.rotation);
      const pagesRotation = Number(viewState.app.pdfViewer.pagesRotation) || 0;
      const rotationKey = Number.isFinite(pageViewRotation) ? pageViewRotation : pagesRotation;
      const cacheKey = `${pageIndex}:${rotationKey}:${normalized.map(value => value.toFixed(1)).join(",")}`;
      if (viewState.renderCache.has(cacheKey)) {
        const cached = viewState.renderCache.get(cacheKey);
        viewState.renderCache.delete(cacheKey);
        viewState.renderCache.set(cacheKey, cached);
        this._trackPanelRenderPromise(panel, viewState, cacheKey, cached, renderID);
        return cached;
      }
      const promise = (async () => {
        if (panel && (panel.closed || panel.renderID !== renderID)) {
          const error = new Error("图片渲染已取消");
          error.name = "RenderingCancelledException";
          throw error;
        }
        const rotation = Number.isFinite(pageViewRotation)
          ? pageViewRotation
          : pagesRotation;
        const includePageRotation = !Number.isFinite(pageViewRotation);
        const zoteroLimit = Number(viewState.app.pdfViewer.maxCanvasPixels);
        const pixelLimit = Number.isFinite(zoteroLimit) && zoteroLimit > 0
          ? Math.min(MAX_RENDER_PIXELS, zoteroLimit)
          : MAX_RENDER_PIXELS;
        const token = `${this.pluginID}:${Date.now()}:${++this._renderSequence}`;
        const renderTask = {
          cancel: () => viewState.rendererBridge.cancel(token),
        };
        try {
          viewState.renderTasks.add(renderTask);
          if (panel && !panel.closed && panel.renderID === renderID) {
            panel.activeRenderTask = renderTask;
            panel.activeRenderCacheKey = cacheKey;
          }
          const payload = await viewState.rendererBridge.render(
            token,
            pageIndex,
            normalized[0],
            normalized[1],
            normalized[2],
            normalized[3],
            rotation,
            pixelLimit,
            includePageRotation,
          );
          if (viewState.closed) {
            throw new Error("PDF 阅读视图已关闭");
          }
          const rendered = JSON.parse(payload);
          if (!rendered?.image || !rendered.width || !rendered.height) {
            throw new Error("PDF 图像渲染结果无效");
          }
          return rendered;
        }
        finally {
          viewState.renderTasks.delete(renderTask);
          if (panel?.activeRenderTask === renderTask) {
            panel.activeRenderTask = null;
            panel.activeRenderCacheKey = null;
          }
        }
      })();
      viewState.renderCache.set(cacheKey, promise);
      this._trackPanelRenderPromise(panel, viewState, cacheKey, promise, renderID);
      promise.catch(() => {
        if (viewState.renderCache.get(cacheKey) === promise) {
          viewState.renderCache.delete(cacheKey);
        }
      });
      if (viewState.renderCache.size > RENDER_CACHE_LIMIT) {
        const oldest = viewState.renderCache.keys().next().value;
        if (oldest !== cacheKey) {
          viewState.renderCache.delete(oldest);
        }
      }
      return promise;
    }

    _trackPanelRenderPromise(panel, viewState, cacheKey, promise, renderID) {
      if (!panel || panel.closed || panel.renderID !== renderID) {
        return;
      }
      panel.activeViewState = viewState;
      panel.activeRenderCacheKey = cacheKey;
      const clearPendingOwner = () => {
        if (panel.renderID === renderID
          && panel.activeRenderCacheKey === cacheKey
          && !panel.activeRenderTask) {
          panel.activeRenderCacheKey = null;
        }
      };
      promise.then(clearPendingOwner, clearPendingOwner);
    }

    _isSimplePointerEvent(viewState, event) {
      return !viewState.closed
        && event.button === 0
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey
        && (viewState.view._tool?.type || "pointer") === "pointer";
    }

    _findNativeDestination(viewState, pageData, location) {
      // Both pageData.overlays and PDFView live in the unprivileged reader
      // compartment.  A malformed/cross-compartment overlay must never prevent
      // the plain-text figure-number fallback from opening.
      try {
        const fromPageData = this.core.findDestinationOverlay(pageData, location.point);
        if (fromPageData) {
          return fromPageData;
        }
      }
      catch (error) {
        this._debug(`页面内部链接识别降级：${error.message}`);
      }
      try {
        const position = {
          pageIndex: location.pageIndex,
          rects: [[location.point.x, location.point.y, location.point.x, location.point.y]],
        };
        const overlay = viewState.view._getSelectableOverlay?.(position);
        return overlay?.type === "internal-link" ? overlay.destinationPosition : null;
      }
      catch (error) {
        this._debug(`内部链接识别降级：${error.message}`);
        return null;
      }
    }

    _pointerLocation(viewState, event) {
      const pageElement = this._closestElementAtEvent(viewState, event, ".page");
      const pageNumber = Number(pageElement?.dataset?.pageNumber || pageElement?.getAttribute?.("data-page-number"));
      if (!pageElement || !Number.isInteger(pageNumber) || pageNumber < 1) {
        return null;
      }
      const pageIndex = pageNumber - 1;
      const pageView = viewState.app.pdfViewer.getPageView?.(pageIndex) || viewState.app.pdfViewer._pages?.[pageIndex];
      if (!pageView?.viewport?.convertToPdfPoint) {
        return null;
      }
      const bounds = pageElement.getBoundingClientRect();
      const [x, y] = pageView.viewport.convertToPdfPoint(event.clientX - bounds.left, event.clientY - bounds.top);
      return { pageIndex, point: { x, y } };
    }

    _outerAnchor(viewState, clientX, clientY) {
      const iframe = viewState.view._iframe;
      const rect = iframe?.getBoundingClientRect?.();
      if (rect) {
        return { x: rect.left + clientX, y: rect.top + clientY };
      }
      const outerWindow = viewState.readerState.doc?.defaultView;
      return { x: outerWindow ? outerWindow.innerWidth / 2 : 300, y: outerWindow ? outerWindow.innerHeight / 2 : 250 };
    }

    _eventElement(event) {
      const target = event.target;
      return target?.nodeType === 3 ? target.parentElement : target;
    }

    _closestElementAtEvent(viewState, event, selector) {
      const target = this._eventElement(event);
      const direct = target?.closest?.(selector);
      if (direct) {
        return direct;
      }
      const elements = viewState.window.document.elementsFromPoint?.(event.clientX, event.clientY) || [];
      for (const element of elements) {
        const match = element?.closest?.(selector);
        if (match) {
          return match;
        }
      }
      return null;
    }

    _releaseReaderGesture(view) {
      try {
        view._pointerDownTriggered = false;
        view.action = null;
        view.pointerDownPosition = null;
        view._selectedOverlay = null;
        if (view._overlayPopupDelayer?.close) {
          view._overlayPopupDelayer.close(() => view._onSetOverlayPopup?.(null));
        }
        else {
          view._onSetOverlayPopup?.(null);
        }
        view.updateCursor?.();
        view._render?.();
        view._updateViewStats?.();
      }
      catch (error) {
        this._reportError(error);
      }
    }

    _closePanel(panel) {
      if (!panel || panel.closed) {
        return;
      }
      if (panel.maximized && panel.restoreBox) {
        this._preferredPanelSize = {
          width: Math.round(panel.restoreBox.width),
          height: Math.round(panel.restoreBox.height),
        };
      }
      else {
        this._rememberPanelSize(panel);
      }
      this._cancelPanelRender(panel);
      panel.closed = true;
      panel.renderID++;
      panel.readerState.requestID++;
      panel.currentResult = null;
      panel.activeViewState = null;
      for (const cleanup of panel.cleanups.splice(0)) {
        try { cleanup(); }
        catch (error) { this._reportError(error); }
      }
      panel.host.remove();
      if (panel.readerState.panel === panel) {
        panel.readerState.panel = null;
      }
    }

    _cancelPanelRender(panel) {
      if (!panel) {
        return;
      }
      const task = panel.activeRenderTask;
      const cacheKey = panel.activeRenderCacheKey;
      panel.activeRenderTask = null;
      panel.activeRenderCacheKey = null;
      if (cacheKey && panel.activeViewState?.renderCache) {
        panel.activeViewState.renderCache.delete(cacheKey);
      }
      if (task) {
        try { task.cancel(); }
        catch (error) { this._reportError(error); }
      }
    }

    _cleanupView(viewState) {
      if (!viewState || viewState.closed) {
        return;
      }
      viewState.closed = true;
      if (viewState.openTimer) {
        clearTimeout(viewState.openTimer);
        viewState.openTimer = null;
      }
      try {
        viewState.window.document.removeEventListener("pointerdown", viewState.onPointerDown, true);
        viewState.window.document.removeEventListener("pointermove", viewState.onPointerMove, true);
        viewState.window.document.removeEventListener("pointerup", viewState.onPointerUp, true);
        viewState.window.document.removeEventListener("click", viewState.onClick, true);
        viewState.window.removeEventListener("keydown", viewState.onKeyDown, true);
        viewState.window.removeEventListener("unload", viewState.onUnload);
      }
      catch (error) {
        this._reportError(error);
      }
      for (const renderTask of viewState.renderTasks) {
        try { renderTask.cancel(); }
        catch (error) { this._reportError(error); }
      }
      viewState.renderTasks.clear();
      if (viewState.readerState.panel?.activeViewState === viewState) {
        this._closePanel(viewState.readerState.panel);
      }
      viewState.pageCache.clear();
      viewState.renderCache.clear();
      viewState.readerState.views.delete(viewState.window);
    }

    _cleanupReader(readerState) {
      if (!readerState || readerState.closed) {
        return;
      }
      readerState.closed = true;
      readerState.requestID++;
      if (readerState.probeTimer) {
        clearTimeout(readerState.probeTimer);
        readerState.probeTimer = null;
      }
      if (readerState.docWindow && readerState.onDocumentUnload) {
        try { readerState.docWindow.removeEventListener("unload", readerState.onDocumentUnload); }
        catch (error) { this._reportError(error); }
      }
      readerState.docWindow = null;
      readerState.onDocumentUnload = null;
      this._closePanel(readerState.panel);
      for (const viewState of [...readerState.views.values()]) {
        this._cleanupView(viewState);
      }
      this._readerStates.delete(readerState);
      this._readerMap.delete(readerState.reader);
    }

    _bindReaderDocument(readerState, doc) {
      const docWindow = doc?.defaultView;
      if (!docWindow || (readerState.docWindow === docWindow && readerState.onDocumentUnload)) {
        if (doc) {
          readerState.doc = doc;
        }
        return;
      }
      if (readerState.docWindow && readerState.onDocumentUnload) {
        try { readerState.docWindow.removeEventListener("unload", readerState.onDocumentUnload); }
        catch (error) { this._reportError(error); }
      }
      readerState.doc = doc;
      readerState.docWindow = docWindow;
      readerState.onDocumentUnload = () => this._cleanupReader(readerState);
      docWindow.addEventListener("unload", readerState.onDocumentUnload, { once: true });
    }

    _scheduleReaderProbe(readerState) {
      if (this._isCancelled(readerState) || readerState.probeTimer) {
        return;
      }
      const timer = setTimeout(() => {
        if (readerState.probeTimer !== timer) {
          return;
        }
        readerState.probeTimer = null;
        if (this._isCancelled(readerState)) {
          return;
        }
        this.ensureReader(readerState.reader, this._readerDocument(readerState.reader) || readerState.doc)
          .catch(error => this._reportError(error));
      }, 2500);
      readerState.probeTimer = timer;
      timer?.unref?.();
    }

    _isCancelled(readerState) {
      return this._stopped || !readerState || readerState.closed;
    }

    _readerDocument(reader) {
      return reader?._iframeWindow?.document || reader?._iframe?.contentDocument || null;
    }

    async _waitForValue(getter, timeout, isCancelled = () => false) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (isCancelled()) {
          return null;
        }
        const value = getter();
        if (value) {
          return value;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return null;
    }

    async _withTimeout(promise, timeout, message) {
      let timer;
      try {
        return await Promise.race([
          promise,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(message)), timeout);
          }),
        ]);
      }
      finally {
        clearTimeout(timer);
      }
    }

    _reportPanelError(readerState, error) {
      if (error?.name === "RenderingCancelledException") {
        return;
      }
      this._reportError(error);
      if (readerState.panel && !readerState.panel.closed) {
        this._showPanelError(readerState.panel, `图像预览失败：${error.message || error}`);
      }
    }

    _debug(message) {
      this.Zotero.debug(`[Figure Peek] ${message}`);
    }

    _reportError(error) {
      this.Zotero.logError(error instanceof Error ? error : new Error(`[Figure Peek] ${error}`));
    }
  }

  FigurePeekPlugin.SINGLE_CLICK_DELAY = SINGLE_CLICK_DELAY;
  FigurePeekPlugin.PANEL_WHEEL_THRESHOLD = PANEL_WHEEL_THRESHOLD;
  FigurePeekPlugin.PANEL_SCROLLBAR_HIT_SIZE = PANEL_SCROLLBAR_HIT_SIZE;
  return FigurePeekPlugin;
});
