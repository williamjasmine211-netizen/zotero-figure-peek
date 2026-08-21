(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  else {
    root.FigurePeekCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FIGURE_ZH_LABEL_PATTERN = "(?:示意图|示意圖|流程图|流程圖|附图|附圖|图表|圖表|算法|演算法|清单|清單|图|圖)";
  const FIGURE_EN_LABEL_PATTERN = "(?:Figures?|Figs?\\.?|Schemes?|Charts?|Algorithms?|Algs?\\.?|Listings?|Lists?\\.?|Boxes?|Plates?)";
  const FIGURE_LABEL_PATTERN = `(?:${FIGURE_ZH_LABEL_PATTERN}|${FIGURE_EN_LABEL_PATTERN})`;
  const FIGURE_IDENTIFIER_PATTERN = "(?:(?:[Ss]\\s*)?\\d+|[A-Za-z]\\s*[.·\\-–—]\\s*\\d+)(?:\\s*[.·\\-–—]\\s*\\d+)*(?:\\s*\\(\\s*[A-Za-z](?:\\s*[-,–—]\\s*[A-Za-z])*\\s*\\)|[A-Za-z])?";
  const TABLE_ZH_LABEL_PATTERN = "(?:数据表|數據表|表格|表)";
  const TABLE_EN_LABEL_PATTERN = "(?:Tables?|Tabs?\\.?)";
  const TABLE_LABEL_PATTERN = `(?:${TABLE_ZH_LABEL_PATTERN}|${TABLE_EN_LABEL_PATTERN})`;
  const EQUATION_LABEL_PATTERN = "(?:公式|方程|算式|式|Equations?|Eqs?\\.?|Eqns?\\.?|Formulas?|Formula)";
  const EQUATION_IDENTIFIER_PATTERN = "\\d+(?:\\s*[.．]\\s*\\d+)+";

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/[\u00A0\u202F]/g, " ")
      .replace(/[‐‑‒–—―−]/g, "-");
  }

  function normalizeGlyph(value) {
    return normalizeText(value).replace(/[\r\n\t]/g, " ");
  }

  function normalizeRect(rect) {
    if (!Array.isArray(rect) || rect.length < 4 || rect.some(value => !Number.isFinite(value))) {
      return null;
    }
    return [
      Math.min(rect[0], rect[2]),
      Math.min(rect[1], rect[3]),
      Math.max(rect[0], rect[2]),
      Math.max(rect[1], rect[3]),
    ];
  }

  function unionRects(rects) {
    const valid = rects.map(normalizeRect).filter(Boolean);
    if (!valid.length) {
      return null;
    }
    return valid.reduce((union, rect) => [
      Math.min(union[0], rect[0]),
      Math.min(union[1], rect[1]),
      Math.max(union[2], rect[2]),
      Math.max(union[3], rect[3]),
    ]);
  }

  function rectWidth(rect) {
    return rect ? Math.max(0, rect[2] - rect[0]) : 0;
  }

  function rectHeight(rect) {
    return rect ? Math.max(0, rect[3] - rect[1]) : 0;
  }

  function rectDistance(point, rect) {
    if (!point || !rect) {
      return Infinity;
    }
    const dx = point.x < rect[0] ? rect[0] - point.x : point.x > rect[2] ? point.x - rect[2] : 0;
    const dy = point.y < rect[1] ? rect[1] - point.y : point.y > rect[3] ? point.y - rect[3] : 0;
    return Math.hypot(dx, dy);
  }

  function rectsIntersect(a, b, padding = 0) {
    return Boolean(a && b
      && a[0] <= b[2] + padding
      && a[2] + padding >= b[0]
      && a[1] <= b[3] + padding
      && a[3] + padding >= b[1]);
  }

  function canonicalizeFigureRef(value, explicitLabel) {
    let text = normalizeText(value).trim();
    const labelMatch = text.match(new RegExp(`^(${FIGURE_LABEL_PATTERN})`, "iu"));
    const label = explicitLabel || labelMatch?.[1] || "";
    if (labelMatch) {
      text = text.slice(labelMatch[0].length).trim();
    }
    text = text.replace(/^[.:：、]+/, "").trim();

    const normalizedLabel = normalizeText(label).toLowerCase();
    const plural = /^(?:figures|figs)/i.test(normalizedLabel);
    const language = new RegExp(`^${FIGURE_ZH_LABEL_PATTERN}`, "u").test(normalizedLabel) ? "zh" : "en";

    text = text.replace(/\s+/g, "").toLowerCase();
    let suffix = "";
    let subparts = "";
    const parenthesizedSuffix = text.match(/\(([a-z](?:[-,][a-z])*)\)$/i);
    if (parenthesizedSuffix) {
      subparts = parenthesizedSuffix[1].toLowerCase();
      if (!/[-,]/u.test(subparts)) {
        suffix = subparts;
      }
      text = text.slice(0, parenthesizedSuffix.index);
    }
    else {
      const directSuffix = text.match(/([a-z])$/i);
      if (directSuffix && !/^s$/i.test(text)) {
        suffix = directSuffix[1].toLowerCase();
        text = text.slice(0, -1);
      }
    }

    text = text.replace(/[·-]/g, ".").replace(/\.{2,}/g, ".").replace(/^\.|\.$/g, "");
    text = text.replace(/^s\.(?=\d)/i, "s");
    if (!/^(?:(?:s)?\d+|[a-z]\.\d+)(?:\.\d+)*$/i.test(text)) {
      return null;
    }
    const baseKey = text;
    return {
      kind: "figure",
      key: `${baseKey}${suffix || (subparts && /[-,]/u.test(subparts) ? `[${subparts}]` : "")}`,
      baseKey,
      suffix,
      subparts,
      label: normalizedLabel,
      language,
      plural,
      display: `${displayFigureLabel(normalizedLabel, language)}${baseKey}${subparts ? `(${subparts})` : suffix ? `(${suffix})` : ""}`,
    };
  }

  function displayFigureLabel(label, language) {
    if (language === "zh") {
      if (/^(?:算法|演算法)/u.test(label)) return "算法";
      if (/^清单/u.test(label)) return "清单";
      if (/^附图/u.test(label)) return "附图";
      if (/^流程图/u.test(label)) return "流程图";
      if (/^示意图/u.test(label)) return "示意图";
      return "图";
    }
    if (/^scheme/u.test(label)) return "Scheme ";
    if (/^chart/u.test(label)) return "Chart ";
    if (/^(?:algorithm|alg\\.)/u.test(label)) return "Algorithm ";
    if (/^(?:listing|list\\.)/u.test(label)) return "Listing ";
    if (/^box/u.test(label)) return "Box ";
    if (/^plate/u.test(label)) return "Plate ";
    return "Figure ";
  }

  function canonicalizeTableRef(value, explicitLabel) {
    let text = normalizeText(value).trim();
    const labelMatch = text.match(new RegExp(`^(${TABLE_LABEL_PATTERN})`, "iu"));
    const label = explicitLabel || labelMatch?.[1] || "";
    if (labelMatch) {
      text = text.slice(labelMatch[0].length).trim();
    }
    text = text.replace(/^[.:：、]+/, "").trim();

    const normalizedLabel = normalizeText(label).toLowerCase();
    const language = new RegExp(`^${TABLE_ZH_LABEL_PATTERN}`, "u").test(normalizedLabel) ? "zh" : "en";
    text = text.replace(/\s+/g, "").toLowerCase();
    let suffix = "";
    const parenthesizedSuffix = text.match(/\(([a-z])\)$/i);
    if (parenthesizedSuffix) {
      suffix = parenthesizedSuffix[1].toLowerCase();
      text = text.slice(0, parenthesizedSuffix.index);
    }
    else {
      const directSuffix = text.match(/([a-z])$/i);
      if (directSuffix && !/^s$/i.test(text)) {
        suffix = directSuffix[1].toLowerCase();
        text = text.slice(0, -1);
      }
    }
    text = text.replace(/[·-]/g, ".").replace(/\.{2,}/g, ".").replace(/^\.|\.$/g, "");
    text = text.replace(/^s\.(?=\d)/i, "s");
    if (!/^(?:(?:s)?\d+|[a-z]\.\d+)(?:\.\d+)*$/i.test(text)) {
      return null;
    }
    return {
      kind: "table",
      key: `${text}${suffix}`,
      baseKey: text,
      suffix,
      label: normalizedLabel,
      language,
      display: `${language === "zh" ? "表" : "Table "}${text}${suffix ? `(${suffix})` : ""}`,
    };
  }

  function canonicalizeEquationRef(value, explicitLabel) {
    let text = normalizeText(value).trim();
    const labelMatch = text.match(new RegExp(`^(${EQUATION_LABEL_PATTERN})`, "iu"));
    const label = explicitLabel || labelMatch?.[1] || "";
    if (labelMatch) {
      text = text.slice(labelMatch[0].length).trim();
    }
    text = text.replace(/^[.:：、]+/u, "").trim();
    text = text.replace(/^[（(]\s*/u, "").replace(/\s*[）)]$/u, "");
    text = text.replace(/\s+/g, "").replace(/[．]/g, ".");
    if (!/^\d+(?:\.\d+)+$/u.test(text)) {
      return null;
    }
    const normalizedLabel = normalizeText(label).toLowerCase();
    const language = /^(?:公式|方程|算式|式)/u.test(normalizedLabel) ? "zh" : "en";
    return {
      kind: "equation",
      key: text,
      baseKey: text,
      label: normalizedLabel,
      language,
      display: `${language === "zh" ? "公式" : "Equation "}${text}`,
    };
  }

  function findFigureReferences(value) {
    const text = normalizeText(value);
    const matches = [];
    const patterns = [
      { regex: new RegExp(`((?<label>${FIGURE_ZH_LABEL_PATTERN})\\s*(?<identifier>${FIGURE_IDENTIFIER_PATTERN}))(?!\\s*[.·\\-–—]\\s*\\d)(?!\\s*\\()(?![A-Za-z0-9_])`, "giu"), leadingGroup: null },
      { regex: new RegExp(`(^|[^\\p{L}\\p{N}_])((?<label>${FIGURE_EN_LABEL_PATTERN})\\s*(?<identifier>${FIGURE_IDENTIFIER_PATTERN}))(?!\\s*[.·\\-–—]\\s*\\d)(?!\\s*\\()(?![\\p{L}\\p{N}_])`, "giu"), leadingGroup: 1 },
    ];
    for (const { regex, leadingGroup } of patterns) {
      let result;
      while ((result = regex.exec(text))) {
        const leadingLength = leadingGroup ? (result[leadingGroup]?.length || 0) : 0;
        const full = leadingGroup ? result[2] : result[1];
        const start = result.index + leadingLength;
        const ref = canonicalizeFigureRef(result.groups.identifier, result.groups.label);
        if (!ref || (ref.plural && /-/u.test(normalizeText(result.groups.identifier)))) {
          continue;
        }
        matches.push({
          ...ref,
          raw: full,
          identifier: result.groups.identifier,
          start,
          end: start + full.length,
        });
      }
    }
    return matches.sort((a, b) => a.start - b.start || b.end - a.end);
  }

  function findTableReferences(value) {
    const text = normalizeText(value);
    const matches = [];
    const patterns = [
      { regex: new RegExp(`((?<label>${TABLE_ZH_LABEL_PATTERN})\\s*(?<identifier>${FIGURE_IDENTIFIER_PATTERN}))(?!\\s*[.·\\-–—]\\s*\\d)(?!\\s*\\()(?![A-Za-z0-9_])`, "giu"), leadingGroup: null },
      { regex: new RegExp(`(^|[^\\p{L}\\p{N}_])((?<label>${TABLE_EN_LABEL_PATTERN})\\s*(?<identifier>${FIGURE_IDENTIFIER_PATTERN}))(?!\\s*[.·\\-–—]\\s*\\d)(?!\\s*\\()(?![\\p{L}\\p{N}_])`, "giu"), leadingGroup: 1 },
    ];
    for (const { regex, leadingGroup } of patterns) {
      let result;
      while ((result = regex.exec(text))) {
        const leadingLength = leadingGroup ? (result[leadingGroup]?.length || 0) : 0;
        const full = leadingGroup ? result[2] : result[1];
        const start = result.index + leadingLength;
        const ref = canonicalizeTableRef(result.groups.identifier, result.groups.label);
        if (!ref) {
          continue;
        }
        matches.push({
          ...ref,
          raw: full,
          identifier: result.groups.identifier,
          start,
          end: start + full.length,
        });
      }
    }
    return matches.sort((a, b) => a.start - b.start || b.end - a.end);
  }

  function findEquationReferences(value) {
    const text = normalizeText(value);
    const matches = [];
    const patterns = [
      { regex: new RegExp(`((?<label>公式|方程|算式|式)\\s*(?:[（(]\\s*)?(?<identifier>${EQUATION_IDENTIFIER_PATTERN})(?:\\s*[）)])?)(?!\\s*[.．]\\s*\\d)(?![A-Za-z0-9_])`, "giu"), leadingGroup: null },
      { regex: new RegExp(`(^|[^\\p{L}\\p{N}_])((?<label>Equations?|Eqs?\\.?|Eqns?\\.?|Formulas?|Formula)\\s*(?:[（(]\\s*)?(?<identifier>${EQUATION_IDENTIFIER_PATTERN})(?:\\s*[）)])?)(?!\\s*[.．]\\s*\\d)(?![\\p{L}\\p{N}_])`, "giu"), leadingGroup: 1 },
    ];
    for (const { regex, leadingGroup } of patterns) {
      let result;
      while ((result = regex.exec(text))) {
        const leadingLength = leadingGroup ? (result[leadingGroup]?.length || 0) : 0;
        const full = leadingGroup ? result[2] : result[1];
        const start = result.index + leadingLength;
        const ref = canonicalizeEquationRef(result.groups.identifier, result.groups.label);
        if (!ref) {
          continue;
        }
        matches.push({
          ...ref,
          raw: full,
          identifier: result.groups.identifier,
          start,
          end: start + full.length,
        });
      }
    }
    return matches.sort((a, b) => a.start - b.start || b.end - a.end);
  }

  function findCaptionReferences(value) {
    return [...findFigureReferences(value), ...findTableReferences(value)]
      .sort((a, b) => a.start - b.start || b.end - a.end);
  }

  function findReferences(value) {
    return [...findCaptionReferences(value), ...findEquationReferences(value)]
      .sort((a, b) => a.start - b.start || b.end - a.end);
  }

  function buildTextLines(pageData) {
    const chars = Array.isArray(pageData?.chars) ? pageData.chars : [];
    const hasExplicitBreaks = chars.some(char => char?.lineBreakAfter || char?.paragraphBreakAfter);
    const lines = [];
    let line = newLine();
    let previousRect = null;

    function newLine() {
      return {
        text: "",
        indexMap: [],
        charIndices: [],
        rects: [],
        fontSizes: [],
        paragraphBreakAfter: false,
      };
    }

    function finishLine(paragraphBreakAfter = false) {
      while (line.text.endsWith(" ")) {
        line.text = line.text.slice(0, -1);
        line.indexMap.pop();
      }
      if (line.text.trim() || line.rects.length) {
        const fontSizes = line.fontSizes.filter(Number.isFinite).sort((a, b) => a - b);
        lines.push({
          ...line,
          rect: unionRects(line.rects),
          paragraphBreakAfter,
          averageFontSize: fontSizes.length ? fontSizes[Math.floor(fontSizes.length / 2)] : 10,
          order: lines.length,
        });
      }
      line = newLine();
      previousRect = null;
    }

    function geometryStartsNewLine(rect) {
      if (hasExplicitBreaks || !previousRect || !rect || !line.text) {
        return false;
      }
      const previousCenter = (previousRect[1] + previousRect[3]) / 2;
      const center = (rect[1] + rect[3]) / 2;
      const height = Math.max(1, rectHeight(previousRect), rectHeight(rect));
      return Math.abs(center - previousCenter) > height * 0.68
        || (rect[0] < previousRect[0] - height * 1.5 && Math.abs(center - previousCenter) > height * 0.2);
    }

    chars.forEach((char, charIndex) => {
      if (!char || char.ignorable) {
        return;
      }
      const rect = normalizeRect(char.rect || char.inlineRect);
      if (geometryStartsNewLine(rect)) {
        finishLine(false);
      }
      const glyph = normalizeGlyph(char.c ?? char.str ?? "");
      if (glyph) {
        line.text += glyph;
        for (let i = 0; i < glyph.length; i++) {
          line.indexMap.push(charIndex);
        }
        line.charIndices.push(charIndex);
        if (rect) {
          line.rects.push(rect);
          previousRect = rect;
        }
        if (Number.isFinite(char.fontSize)) {
          line.fontSizes.push(char.fontSize);
        }
      }
      if ((char.spaceAfter || char.wordBreakAfter) && line.text && !line.text.endsWith(" ")) {
        line.text += " ";
        line.indexMap.push(charIndex);
      }
      if (char.lineBreakAfter || char.paragraphBreakAfter) {
        finishLine(Boolean(char.paragraphBreakAfter));
      }
    });
    finishLine(false);
    return lines;
  }

  function charIndicesForMatch(line, match) {
    return [...new Set(line.indexMap.slice(match.start, match.end).filter(Number.isInteger))];
  }

  function rectForMatch(line, match, chars) {
    return unionRects(charIndicesForMatch(line, match).map(index => chars[index]?.rect || chars[index]?.inlineRect));
  }

  function trimLineForJoin(line, side) {
    const text = line.text || "";
    if (side === "start") {
      const start = text.search(/\S/u);
      return {
        text: start < 0 ? "" : text.slice(start),
        indexMap: start < 0 ? [] : line.indexMap.slice(start),
      };
    }
    let end = text.length;
    while (end > 0 && /\s/u.test(text[end - 1])) {
      end--;
    }
    return { text: text.slice(0, end), indexMap: line.indexMap.slice(0, end) };
  }

  function joinReferenceLines(first, second) {
    if (!first?.rect || !second?.rect) {
      return null;
    }
    const firstCenter = (first.rect[1] + first.rect[3]) / 2;
    const secondCenter = (second.rect[1] + second.rect[3]) / 2;
    const fontSize = Math.max(first.averageFontSize || 10, second.averageFontSize || 10);
    if (Math.abs(firstCenter - secondCenter) > fontSize * 3.5) {
      return null;
    }
    const left = trimLineForJoin(first, "end");
    const right = trimLineForJoin(second, "start");
    const text = `${left.text}${right.text}`;
    const boundary = left.text.length;
    const references = findReferences(text).filter(match => match.start < boundary && match.end > boundary);
    if (!references.length) {
      return null;
    }
    return {
      text,
      indexMap: [...left.indexMap, ...right.indexMap],
      rect: unionRects([first.rect, second.rect]),
      rects: [...(first.rects || []), ...(second.rects || [])],
      averageFontSize: fontSize,
      references,
    };
  }

  function nearestCharIndex(chars, point) {
    let winner = null;
    let bestDistance = Infinity;
    chars.forEach((char, index) => {
      if (!char || char.ignorable) {
        return;
      }
      const distance = rectDistance(point, normalizeRect(char.rect || char.inlineRect));
      if (distance < bestDistance) {
        winner = index;
        bestDistance = distance;
      }
    });
    return { index: winner, distance: bestDistance };
  }

  function findReferenceAtPoint(pageData, point, options = {}) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return null;
    }
    const chars = Array.isArray(pageData?.chars) ? pageData.chars : [];
    const nearest = nearestCharIndex(chars, point);
    const candidates = [];
    const lines = buildTextLines(pageData);
    const segments = lines.map(line => ({ line, references: findReferences(line.text) }));
    for (let lineIndex = 0; lineIndex + 1 < lines.length; lineIndex++) {
      const joined = joinReferenceLines(lines[lineIndex], lines[lineIndex + 1]);
      if (joined) {
        segments.push({ line: joined, references: joined.references });
      }
    }
    for (const { line, references } of segments) {
      for (const match of references) {
        const indices = charIndicesForMatch(line, match);
        const rect = rectForMatch(line, match, chars);
        if (!rect) {
          continue;
        }
        const distance = rectDistance(point, rect);
        const clickedMatchChar = indices.includes(nearest.index);
        const tolerance = options.tolerance ?? Math.max(1, Math.min(2, rectHeight(rect) * 0.15));
        if (clickedMatchChar || distance <= tolerance) {
          candidates.push({
            reference: match,
            line,
            rect,
            charIndices: indices,
            distance: clickedMatchChar ? -1 : distance,
          });
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || rectWidth(a.rect) - rectWidth(b.rect));
    return candidates[0] || null;
  }

  function captionContinuation(lines, startIndex) {
    const selected = [lines[startIndex]];
    const anchor = lines[startIndex];
    const anchorCenter = (anchor.rect[0] + anchor.rect[2]) / 2;
    // Long captions often wrap as centred lines. Their left edges can differ
    // substantially even though they belong to the same caption block.
    for (let i = startIndex + 1; i < Math.min(lines.length, startIndex + 6); i++) {
      const previous = selected[selected.length - 1];
      const current = lines[i];
      if (!previous.rect || !current.rect || findCaptionReferences(current.text).some(match => match.start <= 2)) {
        break;
      }
      const verticalGap = previous.rect[1] - current.rect[3];
      const fontSize = Math.max(previous.averageFontSize || 10, current.averageFontSize || 10);
      const currentCenter = (current.rect[0] + current.rect[2]) / 2;
      const leftAligned = Math.abs(current.rect[0] - anchor.rect[0]) < fontSize * 2.5;
      const centered = Math.abs(currentCenter - anchorCenter) < fontSize * 3;
      if (verticalGap < -fontSize * 0.5 || verticalGap > fontSize * 1.8 || (!leftAligned && !centered) || previous.paragraphBreakAfter) {
        break;
      }
      selected.push(current);
    }
    return selected;
  }

  function textGapAbove(lines, index) {
    const target = lines[index];
    if (!target.rect) {
      return 0;
    }
    let gap = Infinity;
    for (let i = 0; i < lines.length; i++) {
      if (i === index || !lines[i].rect) {
        continue;
      }
      const overlap = Math.min(target.rect[2], lines[i].rect[2]) - Math.max(target.rect[0], lines[i].rect[0]);
      if (overlap <= 0 || lines[i].rect[1] < target.rect[3]) {
        continue;
      }
      gap = Math.min(gap, lines[i].rect[1] - target.rect[3]);
    }
    return Number.isFinite(gap) ? gap : 0;
  }

  function findCaptionCandidates(pageData, reference, options = {}) {
    const ref = typeof reference === "string" ? canonicalizeFigureRef(reference) : reference;
    if (!ref || !["figure", "table"].includes(ref.kind)) {
      return [];
    }
    const pageIndex = Number.isInteger(options.pageIndex)
      ? options.pageIndex
      : Number.isInteger(pageData?.pageIndex) ? pageData.pageIndex : 0;
    const sourcePageIndex = Number.isInteger(options.sourcePageIndex) ? options.sourcePageIndex : pageIndex;
    const lines = buildTextLines(pageData);
    const chars = Array.isArray(pageData?.chars) ? pageData.chars : [];
    const candidates = [];
    const referenceFinder = ref.kind === "table" ? findTableReferences : findFigureReferences;
    const hasReferenceListTitle = ref.kind === "table"
      ? lines.some(line => /^(?:表目录|表目錄|数据表目录|數據表目錄|list of tables)\s*$/iu.test(line.text.trim()))
      : lines.some(line => /^(?:图目录|圖目錄|插图目录|插圖目錄|图表目录|圖表目錄|list of figures)\s*$/iu.test(line.text.trim()));
    const captionLikeCount = lines.reduce((count, line) =>
      count + referenceFinder(line.text).filter(match => match.start <= Math.max(2, line.text.search(/\S/u) + 1)).length, 0);
    const referenceListPenalty = hasReferenceListTitle ? 100 : captionLikeCount >= 6 ? 65 : 0;

    function subpartsContain(subparts, suffix) {
      if (!subparts || !suffix) {
        return false;
      }
      if (subparts.includes(",")) {
        return subparts.split(",").includes(suffix);
      }
      const range = subparts.match(/^([a-z])-([a-z])$/iu);
      return range
        ? suffix.charCodeAt(0) >= range[1].charCodeAt(0) && suffix.charCodeAt(0) <= range[2].charCodeAt(0)
        : subparts === suffix;
    }

    lines.forEach((line, lineIndex) => {
      const firstText = line.text.search(/\S/u);
      for (const match of referenceFinder(line.text)) {
        const incompatibleSubparts = ref.subparts && match.subparts && ref.subparts !== match.subparts;
        const incompatibleRefSuffix = ref.suffix && match.subparts && !subpartsContain(match.subparts, ref.suffix);
        const incompatibleMatchSuffix = ref.subparts && match.suffix && !subpartsContain(ref.subparts, match.suffix);
        if (match.plural
          || match.start > Math.max(2, firstText + 1)
          || match.baseKey !== ref.baseKey
          || (ref.suffix && match.suffix && ref.suffix !== match.suffix)
          || incompatibleSubparts
          || incompatibleRefSuffix
          || incompatibleMatchSuffix) {
          continue;
        }
        const tail = line.text.slice(match.end).trim();
        const bodyLike = /^(?:(?:所示|显示|展示|表明|可见|给出(?:了)?|中的?|为|表示|呈现|说明|可以看(?:到|出)|可知|描绘|反映(?:了)?|描述(?:了)?)|(?:(?:clearly|also|directly|schematically)\s+)?(?:shows?|presents?|illustrates?|demonstrates?|depicts?|displays?|reveals?|provides?|gives?|indicates?|plots?|compares?|summari[sz]es?|contains?)\b)/iu.test(tail);
        const dottedLeader = /(?:\.{3,}|…{2,}|·{4,}).*\d+\s*$/u.test(line.text);
        if (dottedLeader) {
          continue;
        }
        const continuation = captionContinuation(lines, lineIndex);
        const rect = unionRects(continuation.map(item => item.rect));
        const referenceRect = rectForMatch(line, match, chars);
        if (!rect || !referenceRect) {
          continue;
        }

        let score = match.key === ref.key
          ? 105
          : (ref.suffix || ref.subparts) && !match.suffix && !match.subparts ? 92
            : !ref.suffix && !ref.subparts && (match.suffix || match.subparts) ? 74 : 82;
        score += match.start <= Math.max(0, firstText) ? 28 : 0;
        score += tail.length >= 2 ? 12 : -8;
        score += /^[.:：、\-–—]/u.test(tail) ? 8 : 0;
        score += Math.max(0, 24 - Math.abs(pageIndex - sourcePageIndex) * 4);
        const gapAbove = textGapAbove(lines, lineIndex);
        score += gapAbove > 60 ? 24 : gapAbove > 28 ? 14 : 0;
        score -= referenceListPenalty;
        if (bodyLike) {
          score -= 58;
        }
        if (line.text.length > 220) {
          score -= 18;
        }

        candidates.push({
          pageIndex,
          score,
          confidence: score >= 155 ? "high" : score >= 125 ? "medium" : "low",
          match,
          lineIndex,
          rect,
          referenceRect,
          text: continuation.map(item => item.text.trim()).join(" "),
          tail,
          bodyLike,
          gapAbove,
        });
      }
    });
    return candidates.sort((a, b) => b.score - a.score || a.lineIndex - b.lineIndex);
  }

  function findTableCandidates(pageData, reference, options = {}) {
    const ref = typeof reference === "string" ? canonicalizeTableRef(reference) : reference;
    return findCaptionCandidates(pageData, ref, options);
  }

  function chooseBestCaption(candidates, sourcePageIndex = 0) {
    return [...(candidates || [])].sort((a, b) =>
      b.score - a.score
      || Math.abs(a.pageIndex - sourcePageIndex) - Math.abs(b.pageIndex - sourcePageIndex)
      || a.pageIndex - b.pageIndex)[0] || null;
  }

  function findEquationCandidates(pageData, reference, options = {}) {
    const ref = typeof reference === "string" ? canonicalizeEquationRef(reference) : reference;
    if (!ref || ref.kind !== "equation") {
      return [];
    }
    const pageIndex = Number.isInteger(options.pageIndex)
      ? options.pageIndex
      : Number.isInteger(pageData?.pageIndex) ? pageData.pageIndex : 0;
    const sourcePageIndex = Number.isInteger(options.sourcePageIndex) ? options.sourcePageIndex : pageIndex;
    const pageRect = normalizeRect(pageData?.viewBox) || [0, 0, 612, 792];
    const pageWidth = rectWidth(pageRect);
    const chars = Array.isArray(pageData?.chars) ? pageData.chars : [];
    const candidates = [];
    const displayNumber = /[（(]\s*(?<identifier>\d+(?:\s*[.．]\s*\d+)+)\s*[）)]/gu;
    const bodyCue = /(?:公式|方程|式|equations?|eqs?\.?|eqns?\.?)(?:中|由|为|所示|显示|表明|可见|给出|说明|shows?|presents?|illustrates?|demonstrates?|indicates?|gives?)/iu;

    for (const [lineIndex, line] of buildTextLines(pageData).entries()) {
      let match;
      while ((match = displayNumber.exec(line.text))) {
        const numberRef = canonicalizeEquationRef(match.groups.identifier, ref.label);
        if (!numberRef || numberRef.baseKey !== ref.baseKey) {
          continue;
        }
        const referenceRect = rectForMatch(line, {
          start: match.index,
          end: match.index + match[0].length,
        }, chars);
        if (!referenceRect || !line.rect) {
          continue;
        }
        const center = (referenceRect[0] + referenceRect[2]) / 2;
        const rightAligned = center > pageRect[0] + pageWidth * 0.72;
        const equationLike = /[=≈≠≤≥∝∑∫√±×÷]/u.test(line.text);
        const compact = line.text.replace(/\s+/gu, "").length <= 90;
        const before = line.text.slice(0, match.index);
        const after = line.text.slice(match.index + match[0].length);
        const labelBefore = new RegExp(`${EQUATION_LABEL_PATTERN}\\s*$`, "iu").test(before);
        const proseTail = /^(?:\s*(?:中|由|为|所示|显示|表明|可见|给出|说明|可知|shows?|presents?|illustrates?|demonstrates?|indicates?|gives?))/iu.test(after);
        const isBodyReference = bodyCue.test(line.text)
          || (labelBefore && proseTail)
          || /(?:如|见|參見|参见|see|shown|shown in)\s*$/iu.test(before);
        let score = 104;
        score += rightAligned ? 34 : 0;
        score += equationLike ? 35 : 0;
        score += compact ? 16 : -12;
        score += Math.max(0, 18 - Math.abs(pageIndex - sourcePageIndex) * 3);
        score -= isBodyReference ? 78 : 0;
        if (!equationLike && !rightAligned) {
          score -= 26;
        }
        candidates.push({
          pageIndex,
          score,
          confidence: score >= 155 ? "high" : score >= 125 ? "medium" : "low",
          lineIndex,
          rect: line.rect,
          referenceRect,
          text: line.text.trim(),
          bodyLike: isBodyReference,
          averageFontSize: line.averageFontSize,
        });
      }
    }
    return candidates.sort((a, b) => b.score - a.score || a.lineIndex - b.lineIndex);
  }

  function findDestinationOverlay(pageData, point) {
    const overlays = Array.isArray(pageData?.overlays) ? pageData.overlays : [];
    let winner = null;
    let bestDistance = Infinity;
    for (const overlay of overlays) {
      if (overlay?.type !== "internal-link" || !overlay.destinationPosition) {
        continue;
      }
      const sourceRects = overlay.position?.rects || overlay.rects || [];
      const sourceRect = unionRects(sourceRects);
      const distance = rectDistance(point, sourceRect);
      if (distance <= 5 && distance < bestDistance) {
        winner = overlay.destinationPosition;
        bestDistance = distance;
      }
    }
    return winner;
  }

  function isBodyLikeLine(line, columnRect, captionRect) {
    if (!line.rect || rectsIntersect(line.rect, captionRect, 2)) {
      return false;
    }
    const overlap = Math.min(line.rect[2], columnRect[2]) - Math.max(line.rect[0], columnRect[0]);
    const compactText = line.text.replace(/\s+/g, "");
    if (overlap <= 0 || findCaptionReferences(line.text).some(match => match.start <= 2)) {
      return false;
    }
    const widthRatio = rectWidth(line.rect) / Math.max(1, rectWidth(columnRect));
    return (compactText.length >= 12 && widthRatio >= 0.52)
      || (compactText.length >= 35 && widthRatio >= 0.38)
      || (/\p{Script=Han}/u.test(compactText) && compactText.length >= 20 && widthRatio >= 0.35);
  }

  function isTwoColumnLayout(lines, pageRect, captionRect) {
    const pageWidth = rectWidth(pageRect);
    const midpoint = (pageRect[0] + pageRect[2]) / 2;
    let left = 0;
    let right = 0;
    let spanning = 0;
    for (const line of lines) {
      if (!line.rect || rectsIntersect(line.rect, captionRect, 3)) {
        continue;
      }
      const widthRatio = rectWidth(line.rect) / pageWidth;
      const center = (line.rect[0] + line.rect[2]) / 2;
      if (widthRatio >= 0.7) {
        spanning++;
      }
      else if (widthRatio >= 0.18 && widthRatio <= 0.58) {
        if (center < midpoint - pageWidth * 0.06) {
          left++;
        }
        else if (center > midpoint + pageWidth * 0.06) {
          right++;
        }
      }
    }
    return left >= 4 && right >= 4 && spanning <= Math.max(2, Math.floor((left + right) * 0.2));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function makeFigureCrop(pageData, caption, options = {}) {
    const pageRect = normalizeRect(pageData?.viewBox) || [0, 0, 612, 792];
    const captionRect = normalizeRect(caption?.rect || caption?.referenceRect);
    if (!captionRect) {
      return { rect: pageRect, direction: "page", confidence: "low" };
    }
    const pageWidth = rectWidth(pageRect);
    const pageHeight = rectHeight(pageRect);
    const margin = Math.max(8, pageWidth * 0.025);
    const midpoint = (pageRect[0] + pageRect[2]) / 2;
    const captionCenter = (captionRect[0] + captionRect[2]) / 2;
    let columnRect = [pageRect[0] + margin, pageRect[1] + margin, pageRect[2] - margin, pageRect[3] - margin];
    const allLines = buildTextLines(pageData);
    const twoColumnLayout = isTwoColumnLayout(allLines, pageRect, captionRect);
    // Full width is the safe default: many papers use two-column body text but
    // place important figures across both columns. Column cropping is kept as
    // an explicit future/advanced option only when the caller has visual proof.
    if (options.allowColumnCrop === true && twoColumnLayout && rectWidth(captionRect) < pageWidth * 0.58) {
      if (captionCenter < midpoint - pageWidth * 0.08) {
        columnRect[2] = midpoint - margin * 0.35;
      }
      else if (captionCenter > midpoint + pageWidth * 0.08) {
        columnRect[0] = midpoint + margin * 0.35;
      }
    }

    const minimumFigureHeight = Math.max(145, pageHeight * 0.22);
    const desiredFigureHeight = clamp(pageHeight * 0.45, 190, 450);
    const lines = allLines.filter(line => isBodyLikeLine(line, columnRect, captionRect));
    const aboveLines = lines
      .filter(line => line.rect[1] >= captionRect[3])
      .sort((a, b) => a.rect[1] - b.rect[1]);
    const belowLines = lines
      .filter(line => line.rect[3] <= captionRect[1])
      .sort((a, b) => b.rect[3] - a.rect[3]);
    // Vector plots often expose their in-figure labels as PDF text. A nearby
    // label must not be mistaken for the body paragraph above the figure, so a
    // body boundary is trusted only when it leaves a plausible figure height.
    const upperBodyLine = aboveLines.find(line => line.rect[1] - captionRect[3] >= minimumFigureHeight);
    const lowerBodyLine = belowLines.find(line => captionRect[1] - line.rect[3] >= minimumFigureHeight);
    const upperBoundary = upperBodyLine ? upperBodyLine.rect[1] - 5 : pageRect[3] - margin;
    const lowerBoundary = lowerBodyLine ? lowerBodyLine.rect[3] + 5 : pageRect[1] + margin;
    const aboveSpace = Math.max(0, upperBoundary - captionRect[3]);
    const belowSpace = Math.max(0, captionRect[1] - lowerBoundary);
    const nearestAboveGap = aboveLines.length ? Math.max(0, aboveLines[0].rect[1] - captionRect[3]) : Infinity;
    const nearestBelowGap = belowLines.length ? Math.max(0, captionRect[1] - belowLines[0].rect[3]) : Infinity;
    const immediateTextGap = Math.max(45, pageHeight * 0.075);
    let direction = options.preferredDirection === "above" || options.preferredDirection === "below"
      ? options.preferredDirection
      : null;
    if (direction) {
      // Tables conventionally place the title above the content. Callers can
      // select that known direction without weakening the normal figure logic.
    }
    else if (nearestAboveGap <= immediateTextGap && nearestBelowGap <= immediateTextGap) {
      direction = "above";
    }
    else if (nearestBelowGap <= immediateTextGap) {
      direction = "above";
    }
    else if (nearestAboveGap <= immediateTextGap) {
      direction = "below";
    }
    else {
      direction = belowSpace > Math.max(minimumFigureHeight, aboveSpace * 1.3) ? "below" : "above";
    }
    let crop;
    let usedFallback = direction === "above" ? !upperBodyLine : !lowerBodyLine;

    if (direction === "above") {
      let top = upperBoundary;
      if (top - captionRect[1] < minimumFigureHeight) {
        usedFallback = true;
        top = Math.min(pageRect[3] - margin, captionRect[3] + desiredFigureHeight);
      }
      if (!upperBodyLine) {
        top = Math.min(top, captionRect[3] + pageHeight * 0.7);
      }
      crop = [columnRect[0], captionRect[1] - 7, columnRect[2], top];
    }
    else {
      let bottom = lowerBoundary;
      if (captionRect[3] - bottom < minimumFigureHeight) {
        usedFallback = true;
        bottom = Math.max(pageRect[1] + margin, captionRect[1] - desiredFigureHeight);
      }
      if (!lowerBodyLine) {
        bottom = Math.max(bottom, captionRect[1] - pageHeight * 0.7);
      }
      crop = [columnRect[0], bottom, columnRect[2], captionRect[3] + 7];
    }

    crop = [
      clamp(crop[0], pageRect[0], pageRect[2]),
      clamp(crop[1], pageRect[1], pageRect[3]),
      clamp(crop[2], pageRect[0], pageRect[2]),
      clamp(crop[3], pageRect[1], pageRect[3]),
    ];
    if (rectWidth(crop) < 40 || rectHeight(crop) < 40) {
      crop = pageRect;
      usedFallback = true;
    }
    return {
      rect: normalizeRect(crop),
      direction,
      column: columnRect[0] === pageRect[0] + margin && columnRect[2] === pageRect[2] - margin ? "full" : "column",
      confidence: usedFallback ? "low" : caption.confidence || options.confidence || "medium",
    };
  }

  function makeEquationCrop(pageData, equation) {
    const pageRect = normalizeRect(pageData?.viewBox) || [0, 0, 612, 792];
    const equationRect = normalizeRect(equation?.rect || equation?.referenceRect);
    if (!equationRect) {
      return { rect: pageRect, direction: "page", confidence: "low" };
    }
    const pageWidth = rectWidth(pageRect);
    const pageHeight = rectHeight(pageRect);
    const margin = Math.max(8, pageWidth * 0.025);
    const paddingY = Math.max(38, (equation?.averageFontSize || 10) * 4, pageHeight * 0.06);
    return {
      rect: [
        pageRect[0] + margin,
        clamp(equationRect[1] - paddingY, pageRect[1] + margin, pageRect[3] - margin),
        pageRect[2] - margin,
        clamp(equationRect[3] + paddingY, pageRect[1] + margin, pageRect[3] - margin),
      ],
      direction: "equation",
      column: "full",
      confidence: equation.confidence || "medium",
    };
  }

  function makeTableCrop(pageData, table, options = {}) {
    return makeFigureCrop(pageData, table, {
      ...options,
      preferredDirection: "below",
    });
  }

  function makeSearchOrder(currentPageIndex, pageCount) {
    const current = clamp(Number.isInteger(currentPageIndex) ? currentPageIndex : 0, 0, Math.max(0, pageCount - 1));
    const result = [];
    const seen = new Set();
    function add(pageIndex) {
      if (pageIndex >= 0 && pageIndex < pageCount && !seen.has(pageIndex)) {
        seen.add(pageIndex);
        result.push(pageIndex);
      }
    }
    add(current);
    for (let distance = 1; result.length < pageCount; distance++) {
      add(current + distance);
      add(current - distance);
    }
    return result;
  }

  return {
    normalizeText,
    normalizeRect,
    unionRects,
    rectWidth,
    rectHeight,
    rectDistance,
    rectsIntersect,
    canonicalizeFigureRef,
    canonicalizeTableRef,
    canonicalizeEquationRef,
    findFigureReferences,
    findTableReferences,
    findCaptionReferences,
    findEquationReferences,
    findReferences,
    buildTextLines,
    findReferenceAtPoint,
    findCaptionCandidates,
    findTableCandidates,
    findEquationCandidates,
    chooseBestCaption,
    findDestinationOverlay,
    makeFigureCrop,
    makeTableCrop,
    makeEquationCrop,
    makeSearchOrder,
  };
});
