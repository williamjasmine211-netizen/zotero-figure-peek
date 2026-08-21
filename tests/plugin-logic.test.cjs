const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");
const FigurePeekPlugin = require("../figure-peek.js");

function page(textLines, pageIndex) {
  const chars = [];
  for (const { text, x = 40, y, width = 7 } of textLines) {
    const glyphs = Array.from(text);
    let cursor = x;
    glyphs.forEach((glyph, index) => {
      const glyphWidth = glyph === " " ? width * 0.55 : width;
      chars.push({
        c: glyph,
        rect: [cursor, y, cursor + glyphWidth, y + 10],
        fontSize: 10,
        lineBreakAfter: index === glyphs.length - 1,
      });
      cursor += glyphWidth;
    });
  }
  return { pageIndex, chars, overlays: [], viewBox: [0, 0, 600, 800] };
}

function makePlugin(pages) {
  const plugin = new FigurePeekPlugin({
    Zotero: { debug() {}, logError(error) { throw error; } },
    Services: {},
    pluginID: "test@example.invalid",
    core,
  });
  const view = { _pdfPages: {} };
  const viewState = {
    view,
    app: {
      pdfDocument: {
        numPages: pages.length,
        async getPageData({ pageIndex }) { return pages[pageIndex]; },
      },
    },
    pageCache: new Map(),
    renderCache: new Map(),
  };
  return { plugin, viewState };
}

test("plugin search finds a nearby real caption and returns a crop", async () => {
  const pages = [
    page([{ text: "正文中如图3.4所示可以观察到明显变化。", y: 500 }], 0),
    page([
      { text: "上方正文形成图像区域边界并且文字长度足够。", y: 720 },
      { text: "图3.4 不同温度下样品的显微组织", x: 100, y: 300 },
      { text: "下方正文继续解释图片所呈现的实验结果。", y: 270 },
    ], 1),
    page([{ text: "本页没有对应的图注。", y: 500 }], 2),
  ];
  const { plugin, viewState } = makePlugin(pages);
  const reference = core.findFigureReferences("图3.4")[0];
  const result = await plugin._resolveFigure(
    viewState,
    0,
    { reference },
    null,
    () => {},
    () => false,
  );
  assert.equal(result.pageIndex, 1);
  assert.equal(result.reference.key, "3.4");
  assert.equal(result.crop.direction, "above");
  assert.ok(result.figureRect[3] > result.caption.rect[3]);
});

test("plugin resolves an equation reference to the displayed equation region", async () => {
  const pages = [
    page([{ text: "由公式（3.8）可进一步计算取向一致性。", y: 500 }], 0),
    page([{ text: "I = I₀ + kx                                      (3.8)", x: 95, y: 340 }], 1),
  ];
  const { plugin, viewState } = makePlugin(pages);
  const reference = core.findEquationReferences("公式（3.8）")[0];
  const result = await plugin._resolveFigure(viewState, 0, { reference }, null, () => {}, () => false);
  assert.equal(result.pageIndex, 1);
  assert.equal(result.reference.kind, "equation");
  assert.equal(result.crop.direction, "equation");
  assert.ok(result.figureRect[2] - result.figureRect[0] > 500);
});

test("high-Bing regression: a page-75 reference can find the page-45 Figure 3.4 caption", async () => {
  const pages = Array.from({ length: 80 }, (_, pageIndex) => page([], pageIndex));
  pages[45] = page([
    { text: "图 3.4 存在显著聚合物残留的阵列管样品的 SEM 图像。", x: 90, y: 300 },
  ], 45);
  pages[75] = page([
    { text: "根据扫描图像，还可以排查阵列中是否存在各种如前文图 3.4 所示的聚合物富集情况。", y: 500 },
  ], 75);
  const { plugin, viewState } = makePlugin(pages);
  const reference = core.findFigureReferences("图 3.4")[0];
  const result = await plugin._resolveFigure(
    viewState,
    75,
    { reference },
    null,
    () => {},
    () => false,
  );
  assert.equal(result.pageIndex, 45);
  assert.match(result.caption.text, /聚合物残留/u);
  assert.ok(viewState.pageCache.size <= 32);
});

test("a strongly positioned caption is not discarded merely because it starts with shows", async () => {
  const pages = [
    page([{ text: "The discussion refers to Figure 3.4 in the next page.", y: 500 }], 0),
    page([
      { text: "A preceding body paragraph spans most of the page width before the figure.", y: 720 },
      { text: "Figure 3.4 shows the measured microstructure of the sample.", x: 80, y: 300 },
      { text: "The following body paragraph continues the scientific discussion.", y: 270 },
    ], 1),
  ];
  const { plugin, viewState } = makePlugin(pages);
  const reference = core.findFigureReferences("Figure 3.4")[0];
  const result = await plugin._resolveFigure(viewState, 0, { reference }, null, () => {}, () => false);
  assert.equal(result.pageIndex, 1);
  assert.equal(result.caption.bodyLike, true);
  assert.ok(result.caption.score >= 112);
});

test("plugin prefers an existing Zotero internal-link destination", async () => {
  const pages = [page([{ text: "图3.4", y: 500 }], 0), page([], 1)];
  const { plugin, viewState } = makePlugin(pages);
  const reference = core.findFigureReferences("图3.4")[0];
  const result = await plugin._resolveFigure(
    viewState,
    0,
    { reference },
    { pageIndex: 1, rects: [[100, 280, 280, 300]] },
    () => {},
    () => false,
  );
  assert.equal(result.pageIndex, 1);
  assert.equal(result.caption.score, 999);
  assert.equal(result.caption.confidence, "high");
});

test("plugin returns null when the exact caption is absent", async () => {
  const pages = [page([{ text: "正文中提到图9.9，但文档没有图注。", y: 500 }], 0)];
  const { plugin, viewState } = makePlugin(pages);
  const reference = core.findFigureReferences("图9.9")[0];
  const result = await plugin._resolveFigure(
    viewState,
    0,
    { reference },
    null,
    () => {},
    () => false,
  );
  assert.equal(result, null);
});

test("page-data cache is bounded for long theses", async () => {
  const pages = Array.from({ length: 50 }, (_, pageIndex) => page([], pageIndex));
  const { plugin, viewState } = makePlugin(pages);
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    await plugin._getPageData(viewState, pageIndex);
  }
  assert.equal(viewState.pageCache.size, 32);
  assert.equal(viewState.pageCache.has(0), false);
  assert.equal(viewState.pageCache.has(49), true);
});

test("renderer clips directly into one bounded canvas and reuses the result", async () => {
  const { plugin, viewState } = makePlugin([page([], 0)]);
  let renderCount = 0;
  const calls = [];
  viewState.rendererBridge = {
    async render(...args) {
      renderCount++;
      calls.push(args);
      return JSON.stringify({ image: "data:image/png;base64,TEST", width: 470, height: 470 });
    },
    cancel() {},
  };
  viewState.app.pdfViewer = { maxCanvasPixels: 2_000_000 };
  viewState.renderTasks = new Set();
  viewState.closed = false;

  const first = await plugin._renderPDFRegion(viewState, 0, [100, 200, 300, 400]);
  const second = await plugin._renderPDFRegion(viewState, 0, [100, 200, 300, 400]);
  assert.equal(first.image, "data:image/png;base64,TEST");
  assert.deepEqual(second, first);
  assert.equal(renderCount, 1);
  assert.deepEqual(calls[0].slice(1, 9), [0, 100, 200, 300, 400, 0, 2_000_000, true]);

  viewState.app.pdfViewer.pagesRotation = 90;
  await plugin._renderPDFRegion(viewState, 0, [100, 200, 300, 400]);
  assert.equal(renderCount, 2, "manual rotation must invalidate the cached image");
  assert.equal(calls[1][6], 90);
});

test("non-PDF readers are ignored without creating lifecycle state", async () => {
  const { plugin } = makePlugin([]);
  await plugin.ensureReader({ type: "epub" }, null);
  assert.equal(plugin.getStatus().readers, 0);
});

test("single-click delay covers the plugin's 340ms double-click window", () => {
  assert.ok(FigurePeekPlugin.SINGLE_CLICK_DELAY >= 340);
});

test("canceling a panel render stops its task and evicts the pending cache entry", () => {
  const { plugin } = makePlugin([]);
  let canceled = 0;
  const renderCache = new Map([["pending", Promise.resolve()]]);
  const panel = {
    activeRenderTask: { cancel() { canceled++; } },
    activeRenderCacheKey: "pending",
    activeViewState: { renderCache },
  };
  plugin._cancelPanelRender(panel);
  assert.equal(canceled, 1);
  assert.equal(renderCache.has("pending"), false);
  assert.equal(panel.activeRenderTask, null);
});

test("a render waiting in the PDF bridge is owned and evicted before a replacement starts", async () => {
  const { plugin, viewState } = makePlugin([page([], 0)]);
  let rejectRender;
  let cancelCount = 0;
  viewState.app.pdfViewer = { pagesRotation: 0 };
  viewState.rendererBridge = {
    render: () => new Promise((resolve, reject) => { rejectRender = reject; }),
    cancel() {
      cancelCount++;
      const error = new Error("图片渲染已取消");
      error.name = "RenderingCancelledException";
      rejectRender(error);
    },
  };
  viewState.renderTasks = new Set();
  viewState.closed = false;
  const panel = {
    closed: false,
    renderID: 4,
    activeRenderTask: null,
    activeRenderCacheKey: null,
    activeViewState: viewState,
  };

  const pending = plugin._renderPDFRegion(viewState, 0, [100, 200, 300, 400], panel, 4);
  assert.ok(panel.activeRenderCacheKey, "the cache entry must be cancelable while getPage is pending");
  assert.equal(viewState.renderCache.has(panel.activeRenderCacheKey), true);

  panel.renderID++;
  plugin._cancelPanelRender(panel);
  assert.equal(viewState.renderCache.size, 0);
  assert.equal(cancelCount, 1);
  await assert.rejects(pending, error => error.name === "RenderingCancelledException");
});

test("capture click blocks a confirmed native PDF internal link", () => {
  const { plugin } = makePlugin([]);
  const anchor = {};
  const target = { closest(selector) { return selector === ".annotationLayer a" ? anchor : null; } };
  let prevented = 0;
  let stopped = 0;
  plugin._onClick({ blockNativeLinkClickUntil: Date.now() + 500, blockNativeLinkElement: anchor }, {
    target,
    preventDefault() { prevented++; },
    stopPropagation() { stopped++; },
  });
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test("coordinate hit-testing finds a text layer behind the top event target", () => {
  const { plugin } = makePlugin([]);
  const textLayer = {};
  const textSpan = { closest(selector) { return selector === ".textLayer" ? textLayer : null; } };
  const topTarget = { nodeType: 1, closest() { return null; } };
  const viewState = {
    window: { document: { elementsFromPoint() { return [topTarget, textSpan]; } } },
  };
  const found = plugin._closestElementAtEvent(viewState, {
    target: topTarget,
    clientX: 10,
    clientY: 20,
  }, ".textLayer");
  assert.equal(found, textLayer);
});

test("a recognized pointerdown schedules opening without relying on pointerup", () => {
  const { plugin } = makePlugin([]);
  const pageData = page([{ text: "图3.4", x: 100, y: 300 }], 0);
  const textLayer = {};
  const target = {
    nodeType: 1,
    closest(selector) {
      if (selector === ".textLayer") return textLayer;
      return null;
    },
  };
  const viewState = {
    closed: false,
    view: { _tool: { type: "pointer" }, _pdfPages: { 0: pageData } },
    window: {
      getSelection() { return { isCollapsed: true }; },
      document: { elementsFromPoint() { return [target]; } },
    },
    lastPointerDown: null,
    pointerCandidate: null,
    openTimer: null,
  };
  plugin._pointerLocation = () => ({ pageIndex: 0, point: { x: 105, y: 305 } });
  plugin._outerAnchor = () => ({ x: 100, y: 100 });
  plugin._findNativeDestination = () => null;
  let scheduled = 0;
  plugin._scheduleOpen = () => { scheduled++; };

  plugin._onPointerDown(viewState, {
    target,
    pointerId: 1,
    clientX: 10,
    clientY: 20,
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  });
  assert.equal(scheduled, 1);
  assert.equal(viewState.pointerCandidate.hit.reference.key, "3.4");
});

test("a text reference behind an annotation link still schedules caption search", () => {
  const { plugin } = makePlugin([]);
  const pageData = page([{ text: "图3.4", x: 100, y: 300 }], 0);
  const textLayer = {};
  const annotationLink = {};
  const target = {
    nodeType: 1,
    closest(selector) {
      return selector === ".annotationLayer a" ? annotationLink : null;
    },
  };
  const textSpan = {
    closest(selector) {
      return selector === ".textLayer" ? textLayer : null;
    },
  };
  const viewState = {
    closed: false,
    view: { _tool: { type: "pointer" }, _pdfPages: { 0: pageData } },
    window: {
      getSelection() { return { isCollapsed: true }; },
      document: { elementsFromPoint() { return [target, textSpan]; } },
    },
    lastPointerDown: null,
    pointerCandidate: null,
    openTimer: null,
  };
  plugin._pointerLocation = () => ({ pageIndex: 0, point: { x: 105, y: 305 } });
  plugin._outerAnchor = () => ({ x: 100, y: 100 });
  plugin._findNativeDestination = () => null;
  let scheduled = 0;
  plugin._scheduleOpen = () => { scheduled++; };

  plugin._onPointerDown(viewState, {
    target,
    pointerId: 1,
    clientX: 10,
    clientY: 20,
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  });
  assert.equal(scheduled, 1);
});

test("cross-compartment overlay failures degrade to plain-text lookup", () => {
  const { plugin } = makePlugin([]);
  plugin.core = {
    ...core,
    findDestinationOverlay() { throw new Error("Permission denied to pass object to privileged code"); },
  };
  const viewState = {
    view: {
      _getSelectableOverlay() { throw new Error("Permission denied to pass object to privileged code"); },
    },
  };
  assert.equal(plugin._findNativeDestination(
    viewState,
    { overlays: [] },
    { pageIndex: 0, point: { x: 10, y: 20 } },
  ), null);
});

test("a transient single-character selection on pointerup does not cancel opening", () => {
  const { plugin } = makePlugin([]);
  const candidate = {
    pointerId: 1,
    clientX: 10,
    clientY: 20,
    annotationLink: null,
    nativeDestination: null,
  };
  const viewState = {
    closed: false,
    view: { _tool: { type: "pointer" } },
    window: { getSelection() { return { isCollapsed: false }; } },
    pointerCandidate: candidate,
    openTimer: 123,
    suppressClickUntil: 0,
  };
  plugin._onPointerUp(viewState, {
    pointerId: 1,
    clientX: 10,
    clientY: 20,
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  });
  assert.equal(viewState.openTimer, 123);
  assert.equal(viewState.pointerCandidate, null);
});

test("the default preview panel is substantially larger but still fits the reader", () => {
  const { plugin } = makePlugin([]);
  assert.deepEqual(plugin._defaultPanelSize({ innerWidth: 1000, innerHeight: 730 }), {
    width: 720,
    height: 569,
  });
  assert.deepEqual(plugin._defaultPanelSize({ innerWidth: 400, innerHeight: 300 }), {
    width: 360,
    height: 272,
  });
});

test("manual panel resizing is clamped to the visible reader area", () => {
  const { plugin } = makePlugin([]);
  const style = {};
  const panel = {
    readerState: { doc: { defaultView: { innerWidth: 1000, innerHeight: 730 } } },
    host: { style: {} },
    element: {
      style,
      getBoundingClientRect() { return { left: 200, top: 100 }; },
    },
  };
  assert.deepEqual(plugin._applyPanelSize(panel, 900, 800, true), {
    width: 786,
    height: 616,
  });
  assert.equal(style.width, "786px");
  assert.equal(style.height, "616px");
  assert.equal(panel.host.style.width, "786px");
  assert.equal(panel.host.style.height, "616px");
});

test("image zoom controls move between fit and enlarged views", () => {
  const { plugin } = makePlugin([]);
  const panel = {
    closed: false,
    currentResult: {},
    image: { src: "data:image/png;base64,test" },
    imageStage: { style: {} },
    content: { scrollLeft: 12, scrollTop: 18 },
    zoomOutButton: {},
    zoomInButton: {},
    zoomResetButton: {},
  };
  plugin._setPanelZoom(panel, 1.5);
  assert.equal(panel.zoom, 1.5);
  assert.equal(panel.imageStage.style.width, "150%");
  assert.equal(panel.zoomResetButton.textContent, "150%");
  assert.equal(panel.zoomOutButton.disabled, false);
  plugin._setPanelZoom(panel, 1);
  assert.equal(panel.zoomResetButton.textContent, "适配");
  assert.equal(panel.zoomOutButton.disabled, true);
  assert.equal(panel.content.scrollLeft, 0);
  assert.equal(panel.content.scrollTop, 0);
});
