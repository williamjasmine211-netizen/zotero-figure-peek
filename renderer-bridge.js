(function (root) {
  "use strict";

  if (root.FigurePeekRendererBridge) {
    return;
  }

  const tasks = new Map();
  const normalizeRect = rect => {
    if (!Array.isArray(rect) || rect.length < 4 || rect.some(value => !Number.isFinite(value))) {
      return null;
    }
    return [
      Math.min(rect[0], rect[2]),
      Math.min(rect[1], rect[3]),
      Math.max(rect[0], rect[2]),
      Math.max(rect[1], rect[3]),
    ];
  };

  root.FigurePeekRendererBridge = {
    async render(token, pageIndex, x1, y1, x2, y2, rotation, pixelLimit, includePageRotation) {
      const page = await root.PDFViewerApplication.pdfDocument.getPage(pageIndex + 1);
      const pdfRect = normalizeRect([x1, y1, x2, y2]);
      if (!pdfRect) {
        throw new Error("图片区域无效");
      }

      const viewerRotation = Number.isFinite(rotation) ? rotation : 0;
      const normalizedRotation = includePageRotation
        ? ((Number(page.rotate) || 0) + viewerRotation) % 360
        : viewerRotation;
      const baseViewport = page.getViewport({ scale: 1, rotation: normalizedRotation });
      const baseCrop = normalizeRect(baseViewport.convertToViewportRectangle(pdfRect));
      if (!baseCrop) {
        throw new Error("无法换算图片区域");
      }
      const cropWidth = baseCrop[2] - baseCrop[0];
      const cropHeight = baseCrop[3] - baseCrop[1];
      if (!(cropWidth > 0) || !(cropHeight > 0)) {
        throw new Error("图片区域为空");
      }

      let scale = Math.min(2.35, Math.max(1.25, 1100 / cropWidth));
      const safeLimit = Number.isFinite(pixelLimit) && pixelLimit > 0 ? pixelLimit : 10_000_000;
      const initialPixels = cropWidth * scale * cropHeight * scale;
      if (initialPixels > safeLimit) {
        scale *= Math.sqrt(safeLimit / initialPixels);
      }

      const width = Math.max(1, Math.ceil(cropWidth * scale));
      const height = Math.max(1, Math.ceil(cropHeight * scale));
      const viewport = page.getViewport({
        scale,
        rotation: normalizedRotation,
        offsetX: -baseCrop[0] * scale,
        offsetY: -baseCrop[1] * scale,
      });
      const canvas = root.document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      let task = null;
      try {
        const context = canvas.getContext("2d", { alpha: false });
        task = page.render({
          canvasContext: context,
          viewport,
          background: "rgb(255,255,255)",
        });
        tasks.set(token, task);
        await task.promise;
        return JSON.stringify({
          image: canvas.toDataURL("image/png"),
          width,
          height,
        });
      }
      finally {
        if (tasks.get(token) === task) {
          tasks.delete(token);
        }
        canvas.width = 0;
        canvas.height = 0;
      }
    },

    cancel(token) {
      const task = tasks.get(token);
      if (task) {
        task.cancel();
        tasks.delete(token);
      }
    },
  };
})(globalThis);
