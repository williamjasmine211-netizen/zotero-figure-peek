const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("PDF-realm bridge renders a clipped canvas and releases its pixels", async () => {
  let viewportOptions;
  let renderCount = 0;
  const canvas = {
    width: 0,
    height: 0,
    getContext() { return { canvas: this }; },
    toDataURL() { return "data:image/png;base64,BRIDGE"; },
  };
  const page = {
    rotate: 0,
    getViewport(options) {
      if (options.offsetX !== undefined) {
        viewportOptions = options;
      }
      return {
        convertToViewportRectangle(rect) {
          return rect.map(value => value * options.scale);
        },
      };
    },
    render({ canvasContext }) {
      renderCount++;
      assert.equal(canvasContext.canvas.width, 470);
      assert.equal(canvasContext.canvas.height, 470);
      return { promise: Promise.resolve(), cancel() {} };
    },
  };
  const context = {
    PDFViewerApplication: { pdfDocument: { async getPage() { return page; } } },
    document: { createElement() { return canvas; } },
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer-bridge.js"), "utf8");
  vm.runInContext(source, context);

  const payload = await context.FigurePeekRendererBridge.render(
    "test-render",
    0,
    100,
    200,
    300,
    400,
    0,
    2_000_000,
    false,
  );
  const rendered = JSON.parse(payload);
  assert.equal(rendered.image, "data:image/png;base64,BRIDGE");
  assert.equal(rendered.width, 470);
  assert.equal(rendered.height, 470);
  assert.equal(renderCount, 1);
  assert.equal(viewportOptions.offsetX, -235);
  assert.equal(viewportOptions.offsetY, -470);
  assert.equal(viewportOptions.rotation, 0);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
});
