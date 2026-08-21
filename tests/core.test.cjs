const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

function lineChars(text, { x = 40, y = 700, width = 6, height = 10, paragraph = false } = {}) {
  const glyphs = Array.from(text);
  let cursor = x;
  return glyphs.map((glyph, index) => {
    const glyphWidth = glyph === " " ? width * 0.55 : width;
    const char = {
      c: glyph,
      rect: [cursor, y, cursor + glyphWidth, y + height],
      fontSize: height,
      lineBreakAfter: index === glyphs.length - 1,
      paragraphBreakAfter: paragraph && index === glyphs.length - 1,
    };
    cursor += glyphWidth;
    return char;
  });
}

function pageWithLines(lines, viewBox = [0, 0, 600, 800]) {
  return {
    pageIndex: 0,
    viewBox,
    overlays: [],
    chars: lines.flatMap(line => lineChars(line.text, line)),
  };
}

test("recognizes Chinese, English, full-width, compact and subfigure references", () => {
  const samples = new Map([
    ["见图3.4", "3.4"],
    ["如图 ３．４（a）所示", "3.4a"],
    ["参见图3-4", "3.4"],
    ["参见图3−4", "3.4"],
    ["See Figure3.4 for details", "3.4"],
    ["See Figure 3.4b for details", "3.4b"],
    ["See Figure 3 ( a ) for details", "3a"],
    ["See Figure A.2 for details", "a.2"],
    ["See Figure A-2 for details", "a.2"],
    ["See Fig. S-3 for details", "s3"],
    ["See Figure 3(a–c) for all panels", "3[a-c]"],
    ["See Figure 3(a,b) for both panels", "3[a,b]"],
    ["See Fig. 3.4", "3.4"],
    ["See Fig.\u00AD 3.4", "3.4"],
    ["See Fig. S3b", "s3b"],
    ["See Figs. 3.4 for the overview", "3.4"],
  ]);
  for (const [text, key] of samples) {
    const matches = core.findFigureReferences(text);
    assert.equal(matches.length, 1, text);
    assert.equal(matches[0].key, key, text);
  }
});

test("rejects ambiguous or unrelated number strings", () => {
  for (const text of [
    "configuration3.4 remains unchanged",
    "Figure 3.4alpha is not a valid compact reference",
    "Figure 3Dprinting is a phrase, not a subfigure",
    "图3.4alpha 也不应被识别",
    "Figure 3(a;b) uses an unsupported panel separator",
    "Figs. 3–5 compare the samples",
    "表3.4给出了参数",
    "第3.4节讨论了这一问题",
  ]) {
    assert.deepEqual(core.findFigureReferences(text), [], text);
  }
});

test("maps a pointer to the exact figure-reference characters", () => {
  const page = pageWithLines([{ text: "在图3.4中可以看到", x: 10, y: 500 }]);
  const hit = core.findReferenceAtPoint(page, { x: 31, y: 505 });
  assert.ok(hit);
  assert.equal(hit.reference.key, "3.4");
  assert.equal(hit.line.text, "在图3.4中可以看到");

  const miss = core.findReferenceAtPoint(page, { x: 13, y: 505 });
  assert.equal(miss, null);
});

test("recognizes a figure reference split across two PDF text lines", () => {
  const page = pageWithLines([
    { text: "正文如图", x: 40, y: 500 },
    { text: "3.8 所示继续讨论。", x: 40, y: 485 },
  ]);
  const graphicChar = page.chars.find(char => char.c === "图");
  const numberChar = page.chars.find((char, index) => char.c === "3" && index > 2);
  const figureHit = core.findReferenceAtPoint(page, {
    x: (graphicChar.rect[0] + graphicChar.rect[2]) / 2,
    y: (graphicChar.rect[1] + graphicChar.rect[3]) / 2,
  });
  const numberHit = core.findReferenceAtPoint(page, {
    x: (numberChar.rect[0] + numberChar.rect[2]) / 2,
    y: (numberChar.rect[1] + numberChar.rect[3]) / 2,
  });
  assert.equal(figureHit.reference.kind, "figure");
  assert.equal(figureHit.reference.key, "3.8");
  assert.equal(numberHit.reference.key, "3.8");
});

test("recognizes Chinese and English equation references", () => {
  const samples = new Map([
    ["由公式（3.8）可得", "3.8"],
    ["式(3.8)说明了这一点", "3.8"],
    ["方程 3.8 给出边界条件", "3.8"],
    ["Equation (3.8) gives the result", "3.8"],
    ["See Eq. 3.8 for details", "3.8"],
    ["See Eqns. (3.8) for details", "3.8"],
  ]);
  for (const [text, key] of samples) {
    const matches = core.findEquationReferences(text);
    assert.equal(matches.length, 1, text);
    assert.equal(matches[0].kind, "equation", text);
    assert.equal(matches[0].key, key, text);
  }
});

test("finds a displayed equation rather than a prose equation citation", () => {
  const page = pageWithLines([
    { text: "由公式（3.8）可知该关系仍需结合实验结果讨论。", x: 45, y: 700, width: 7 },
    { text: "I = I₀ + kx                                      (3.8)", x: 100, y: 340, width: 7 },
  ]);
  const reference = core.findEquationReferences("公式（3.8）")[0];
  const candidates = core.findEquationCandidates(page, reference, { pageIndex: 3, sourcePageIndex: 1 });
  const best = core.chooseBestCaption(candidates, 1);
  assert.equal(best.lineIndex, 1);
  assert.equal(best.bodyLike, false);
  assert.ok(best.score >= 125);
  const crop = core.makeEquationCrop(page, best);
  assert.equal(crop.direction, "equation");
  assert.ok(crop.rect[2] > 550);
  assert.ok(crop.rect[3] - crop.rect[1] < 180);
});

test("finds a caption but rejects a list-of-figures leader", () => {
  const page = pageWithLines([
    { text: "上一段正文用于形成图像上边界，文字应当足够长。", x: 45, y: 720, width: 8 },
    { text: "图3.4 不同工艺条件下的显微组织", x: 90, y: 310, width: 8 },
    { text: "下一段正文继续讨论实验结果，文字也应当足够长。", x: 45, y: 275, width: 8 },
    { text: "图3.4 ........ 57", x: 45, y: 100, width: 8 },
  ]);
  const reference = core.findFigureReferences("如图3.4所示")[0];
  const candidates = core.findCaptionCandidates(page, reference, { pageIndex: 12, sourcePageIndex: 12 });
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].text, /^图3\.4/u);
  assert.ok(candidates[0].score >= 150);
});

test("prefers a real caption over a sentence beginning with the same figure number", () => {
  const page = pageWithLines([
    { text: "图3.4显示了不同样品之间的变化趋势并将在下文展开讨论。", x: 45, y: 650, width: 7 },
    { text: "前置正文形成明显的图像留白区域且长度足够。", x: 45, y: 590, width: 8 },
    { text: "图3.4 不同样品的相组成", x: 120, y: 300, width: 8 },
    { text: "后续正文继续分析相组成随温度发生的变化规律。", x: 45, y: 265, width: 8 },
  ]);
  const reference = core.findFigureReferences("图3.4")[0];
  const best = core.chooseBestCaption(core.findCaptionCandidates(page, reference, {
    pageIndex: 20,
    sourcePageIndex: 20,
  }), 20);
  assert.equal(best.lineIndex, 2);
  assert.ok(best.score > 150);
});

test("penalizes Chinese body-reference verbs without relying on ASCII word boundaries", () => {
  const reference = core.findFigureReferences("图3.4")[0];
  for (const text of [
    "图3.4所示为不同参数下的结果并将在本节继续展开讨论。",
    "图3.4显示了不同参数下的变化趋势并将在后文进行分析。",
    "图3.4给出了不同参数下的变化趋势并将在后文进行分析。",
    "图3.4中的曲线反映了温度变化并将在后文进行分析。",
    "图3.4为不同参数下的实验结果并将在后文进行分析。",
    "图3.4表示不同参数下的变化趋势并将在后文进行分析。",
    "Figure 3.4 presents the results that are discussed below.",
    "Figure 3.4 clearly shows the trend discussed below.",
    "Figure 3.4 displays the trend discussed below.",
    "Figure 3.4 reveals the trend discussed below.",
    "Figure 3.4 provides the comparison discussed below.",
    "图3.4可以看到明显变化并将在后文进行分析。",
    "图3.4反映了明显变化并将在后文进行分析。",
    "图3.4描述了明显变化并将在后文进行分析。",
  ]) {
    const page = pageWithLines([{ text, x: 45, y: 650, width: 7 }]);
    const candidates = core.findCaptionCandidates(page, reference, { pageIndex: 1, sourcePageIndex: 1 });
    assert.equal(candidates.length, 1, text);
    assert.equal(candidates[0].bodyLike, true, text);
    assert.ok(candidates[0].score < 125, text);
  }
});

test("rejects a conflicting subfigure caption", () => {
  const page = pageWithLines([
    { text: "Figure 3(b). Wrong panel", x: 80, y: 300, width: 7 },
  ]);
  const reference = core.findFigureReferences("Figure 3(a)")[0];
  assert.deepEqual(core.findCaptionCandidates(page, reference), []);
});

test("rejects a conflicting subfigure range but accepts the base caption", () => {
  const page = pageWithLines([
    { text: "Figure 3(d-f). Wrong range", x: 80, y: 400, width: 7 },
    { text: "Figure 3. Overall figure caption", x: 80, y: 300, width: 7 },
  ]);
  const reference = core.findFigureReferences("Figure 3(a-c)")[0];
  const candidates = core.findCaptionCandidates(page, reference);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].match.key, "3");
});

test("crops the figure above a conventional below-figure caption", () => {
  const page = pageWithLines([
    { text: "正文行正文行正文行正文行正文行正文行正文行", x: 45, y: 720, width: 8 },
    { text: "图3.4 样品组织形貌", x: 110, y: 300, width: 8 },
    { text: "正文行正文行正文行正文行正文行正文行正文行", x: 45, y: 268, width: 8 },
  ]);
  const caption = core.findCaptionCandidates(page, core.findFigureReferences("图3.4")[0])[0];
  const crop = core.makeFigureCrop(page, caption);
  assert.equal(crop.direction, "above");
  assert.ok(crop.rect[2] > 550, "single-column figures should not be cut to the left half-page");
  assert.ok(crop.rect[1] <= caption.rect[1]);
  assert.ok(crop.rect[3] > caption.rect[3] + 150);
});

test("supports the less common caption-above-figure layout", () => {
  const page = pageWithLines([
    { text: "正文行正文行正文行正文行正文行正文行正文行", x: 45, y: 750, width: 8 },
    { text: "Figure 3.4 Microstructure of the sample", x: 90, y: 710, width: 7 },
    { text: "The following paragraph contains enough body text to act as a boundary.", x: 45, y: 250, width: 6 },
  ]);
  const caption = core.findCaptionCandidates(page, core.findFigureReferences("Figure 3.4")[0])[0];
  const crop = core.makeFigureCrop(page, caption);
  assert.equal(crop.direction, "below");
  assert.ok(crop.rect[1] < caption.rect[1] - 150);
  assert.ok(crop.rect[3] >= caption.rect[3]);
});

test("does not cut a vector figure at a long in-figure text label", () => {
  const page = pageWithLines([
    { text: "这一行是图前正文并且横跨页面的大部分可用宽度用于确定边界。", x: 45, y: 720, width: 8 },
    { text: "More topography information and alignment observation", x: 160, y: 450, width: 5 },
    { text: "图3.4 样品组织形貌", x: 110, y: 300, width: 8 },
    { text: "这一行是图后正文并且横跨页面的大部分可用宽度用于确定边界。", x: 45, y: 265, width: 8 },
  ]);
  const caption = core.findCaptionCandidates(page, core.findFigureReferences("图3.4")[0])[0];
  const crop = core.makeFigureCrop(page, caption);
  assert.equal(crop.direction, "above");
  assert.ok(crop.rect[3] > 650, "the crop should extend beyond the in-figure label");
});

test("nearby body text below a caption keeps a small conventional figure above", () => {
  const page = pageWithLines([
    { text: "这一行是图前正文并且横跨页面的大部分可用宽度用于确定边界。", x: 45, y: 500, width: 8 },
    { text: "图3.4 小型实验结果图", x: 100, y: 300, width: 8 },
    { text: "这一行是紧随图注的正文并且横跨页面的大部分可用宽度。", x: 45, y: 265, width: 8 },
  ]);
  const caption = core.findCaptionCandidates(page, core.findFigureReferences("图3.4")[0])[0];
  const crop = core.makeFigureCrop(page, caption);
  assert.equal(crop.direction, "above");
  assert.ok(crop.rect[3] > caption.rect[3]);
});

test("when both sides contain nearby text, the conventional above-figure side wins", () => {
  const page = pageWithLines([
    { text: "这一行是图前正文并且横跨页面的大部分可用宽度用于确定边界。", x: 45, y: 500, width: 8 },
    { text: "Wide in-figure vector label close to caption", x: 90, y: 330, width: 7 },
    { text: "图3.4 小型实验结果图", x: 100, y: 300, width: 8 },
    { text: "这一行是紧随图注的正文并且横跨页面的大部分可用宽度。", x: 45, y: 265, width: 8 },
  ]);
  const caption = core.findCaptionCandidates(page, core.findFigureReferences("图3.4")[0])[0];
  const crop = core.makeFigureCrop(page, caption);
  assert.equal(crop.direction, "above");
});

test("a trusted body boundary is not clipped by the fallback 70-percent cap", () => {
  const page = pageWithLines([
    { text: "这一行是图前正文并且横跨页面的大部分可用宽度用于确定边界。", x: 45, y: 770, width: 8 },
    { text: "图3.4 整页大型实验结果图", x: 100, y: 100, width: 8 },
    { text: "这一行是紧随图注的正文并且横跨页面的大部分可用宽度。", x: 45, y: 65, width: 8 },
  ]);
  const caption = core.findCaptionCandidates(page, core.findFigureReferences("图3.4")[0])[0];
  const crop = core.makeFigureCrop(page, caption);
  assert.equal(crop.direction, "above");
  assert.ok(crop.rect[3] > 740);
});

test("two-column body text does not force a short spanning caption into half a page", () => {
  const lines = [];
  for (let row = 0; row < 5; row++) {
    lines.push({ text: "Left-column body text has enough width for layout detection.", x: 35, y: 720 - row * 24, width: 4 });
    lines.push({ text: "Right-column body text has enough width for layout detection.", x: 320, y: 720 - row * 24, width: 4 });
  }
  lines.push({ text: "Figure 3.4 Overview", x: 45, y: 300, width: 7 });
  const page = pageWithLines(lines);
  const caption = core.findCaptionCandidates(page, core.findFigureReferences("Figure 3.4")[0])[0];
  const crop = core.makeFigureCrop(page, caption);
  assert.equal(crop.column, "full");
  assert.ok(crop.rect[2] > 550);
});

test("downranks a dense figure-list page even without dotted leaders", () => {
  const lines = [{ text: "图目录", x: 220, y: 750, width: 8 }];
  for (let number = 1; number <= 7; number++) {
    lines.push({ text: `图3.${number} 示例图标题`, x: 60, y: 700 - number * 40, width: 8 });
  }
  const page = pageWithLines(lines);
  const reference = core.findFigureReferences("图3.4")[0];
  const candidates = core.findCaptionCandidates(page, reference);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].score < 100);
});

test("uses Zotero internal-link destinations when present", () => {
  const page = {
    overlays: [{
      type: "internal-link",
      position: { pageIndex: 2, rects: [[10, 10, 40, 20]] },
      destinationPosition: { pageIndex: 8, rects: [[50, 100, 150, 120]] },
    }],
  };
  const destination = core.findDestinationOverlay(page, { x: 20, y: 15 });
  assert.equal(destination.pageIndex, 8);
  assert.deepEqual(destination.rects[0], [50, 100, 150, 120]);
  assert.equal(core.findDestinationOverlay(page, { x: 200, y: 200 }), null);
});

test("search order expands outwards from the source page", () => {
  assert.deepEqual(core.makeSearchOrder(3, 7), [3, 4, 2, 5, 1, 6, 0]);
  assert.deepEqual(core.makeSearchOrder(0, 4), [0, 1, 2, 3]);
});
