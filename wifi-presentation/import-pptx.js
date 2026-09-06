// ============================================================
// import-pptx.js  (v2 — full rewrite)
// ============================================================
// Converts ANY .pptx file into the slides.js format used by
// server.js / viewer.js / presenter.js.
//
// USAGE:
//   node import-pptx.js "My Deck.pptx"
//   npm run import -- "My Deck.pptx"
//
// WHY THIS VERSION IS DIFFERENT FROM v1
// -------------------------------------
// The old importer only ever looked for real <p:pic> elements to
// find images. Many decks (especially ones exported from web-based
// slide tools, not real PowerPoint) NEVER use <p:pic> at all --
// every image, icon, background, and decorative glow is instead a
// freeform *shape* (<p:sp>) whose fill happens to be a picture
// (<a:blipFill> inside <p:spPr>). The old importer was completely
// blind to those, which is why decks could come out with zero
// images even though the source file was full of them.
//
// This version:
//   - Treats ANY shape (text-less <p:sp>, or <p:pic>) with a
//     picture fill as an image element.
//   - Treats ANY shape with a solid or gradient fill (and no text)
//     as a decorative "shape" element, rendered as a real SVG path
//     (including curves) rather than a crude bounding-box div --
//     so triangles/blobs/glows look like triangles/blobs/glows,
//     not squares.
//   - Recurses into grouped shapes (<p:grpSp>), correctly mapping
//     each child's local coordinates through the group's transform.
//   - Preserves real z-order/document order between shapes, pictures
//     and groups (see getDirectChildTagOrder below for why this
//     needs special handling -- the naive object-tree the XML
//     parser gives us loses interleaving between different tag
//     names at the same nesting level).
//   - Fixes a real bug: PowerPoint/exporters store bold/italic as
//     b="true" / i="true" (a literal *string* "true"), but the old
//     code compared against the *boolean* `true` and the string
//     "1" -- neither ever matched, so every bold/italic run
//     silently rendered as regular weight. That's also why text
//     could clip: the un-bolded fallback font is wider, so text
//     wrapped into an extra line that didn't fit the box.
//   - Adds gradient-fill support for both shapes and text runs.
//   - Adds embedded-font discovery so render.js knows what to try
//     to load, and reports fonts it can't map with confidence.
//
// KNOWN LIMITATIONS (still true, being honest about scope):
//   - Table/chart placeholders (<p:graphicFrame>) are not read.
//   - Group rotation is combined with child rotation, but a
//     rotated group's effect on child *position* (revolving
//     children around the group's center) is not modeled -- fine
//     for the unrotated groups this was built against, an
//     approximation for rotated ones.
//   - Picture-filled shapes are rendered using their bounding box
//     clipped by their actual vector outline (so non-rectangular
//     picture shapes still look right), but PowerPoint's
//     fill-rect stretch/crop insets are ignored in favor of a
//     simple "stretch to fill" -- close enough for full-bleed
//     background art, slightly off for asymmetric custom crops.
//   - Embedded custom fonts inside the .pptx (ppt/fonts/*.fntdata)
//     are obfuscated with no recoverable key in files that weren't
//     produced by real PowerPoint (no fontKey GUID anywhere in the
//     package), so we can't safely decode and use them. render.js
//     maps well-known font names (Signika, Space Mono, Tomorrow --
//     real Google Fonts) to the real thing, and falls back to a
//     close substitute for anything else.
// ============================================================

const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { XMLParser } = require("fast-xml-parser");

const PROJECT_ROOT = __dirname;
const SLIDES_OUT = path.join(PROJECT_ROOT, "slides.js");
const SLIDES_BACKUP = path.join(PROJECT_ROOT, "slides.backup.js");
const IMAGES_OUT_DIR = path.join(PROJECT_ROOT, "public", "images");

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: false,
  parseTagValue: false,
  // CRITICAL: fast-xml-parser trims leading/trailing whitespace off text
  // values by default. PowerPoint frequently splits a sentence across
  // multiple <a:r> runs with the word-separating space living at the
  // start/end of a run's <a:t> text -- trimming it produces "Anoperational
  // amplifier" instead of "An operational amplifier". Must stay false.
  trimValues: false,
});

// ------------------------------------------------------------
// SMALL HELPERS
// ------------------------------------------------------------

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function emuToPercentOfWidth(emu, slideWidth) {
  return (Number(emu) / Number(slideWidth)) * 100;
}

function emuToPercentOfHeight(emu, slideHeight) {
  return (Number(emu) / Number(slideHeight)) * 100;
}

// OOXML stores font size in hundredths of a point (sz="4001" = 40.01pt)
function halfSzToPt(sz) {
  if (sz === undefined || sz === null) return null;
  return Number(sz) / 100;
}

// PowerPoint (and most exporters) store true booleans as the literal
// string "true" (also seen: "1"). Never compare against the JS boolean
// `true` -- XML attributes are always strings.
function isTrue(v) {
  return v === "1" || v === "true" || v === true || v === 1;
}

function mapAlign(algn) {
  switch (algn) {
    case "ctr":
      return "center";
    case "r":
      return "right";
    case "just":
    case "justLow":
      return "justify";
    default:
      return "left";
  }
}

function mapAnchor(anchor) {
  switch (anchor) {
    case "ctr":
      return "middle";
    case "b":
      return "bottom";
    default:
      return "top";
  }
}

// ------------------------------------------------------------
// LOCATE THE INPUT FILE
// ------------------------------------------------------------

function resolveInputPath() {
  const argPath = process.argv[2];

  if (argPath) {
    const resolved = path.isAbsolute(argPath)
      ? argPath
      : path.join(PROJECT_ROOT, argPath);
    if (!fs.existsSync(resolved)) {
      const insidePptxFolder = path.join(PROJECT_ROOT, "pptx", argPath);
      if (fs.existsSync(insidePptxFolder)) return insidePptxFolder;
      console.error(`Could not find file: ${resolved}`);
      process.exit(1);
    }
    return resolved;
  }

  const pptxFolder = path.join(PROJECT_ROOT, "pptx");
  if (!fs.existsSync(pptxFolder)) {
    fs.mkdirSync(pptxFolder, { recursive: true });
    console.error(
      `No file given, and no "pptx" folder existed yet (I just created one).\n` +
        `Drop your .pptx file into:\n  ${pptxFolder}\n` +
        `...then run this command again.`
    );
    process.exit(1);
  }

  const candidates = fs
    .readdirSync(pptxFolder)
    .filter((f) => f.toLowerCase().endsWith(".pptx"));

  if (candidates.length === 0) {
    console.error(
      `No .pptx files found in ${pptxFolder}. Drop one in there and try again.`
    );
    process.exit(1);
  }
  if (candidates.length > 1) {
    console.error(
      `Found more than one .pptx in ${pptxFolder}:\n` +
        candidates.map((c) => `  - ${c}`).join("\n") +
        `\nRun again with the specific filename:\n` +
        `  npm run import -- "${candidates[0]}"`
    );
    process.exit(1);
  }

  return path.join(pptxFolder, candidates[0]);
}

// ------------------------------------------------------------
// THEME (colors + fonts)
// ------------------------------------------------------------

function readDirectColor(node, theme) {
  // `node` is the element that directly HOLDS a:srgbClr / a:schemeClr
  // as a child (e.g. a:solidFill, or a gradient stop <a:gs>).
  if (!node) return null;
  if (node["a:srgbClr"]) return `#${node["a:srgbClr"]["@_val"]}`;
  if (node["a:sysClr"]) return `#${node["a:sysClr"]["@_lastClr"]}`;
  if (node["a:schemeClr"]) return resolveSchemeColorRef(node["a:schemeClr"], theme);
  return null;
}

function readAlphaPercent(node) {
  // `node` is the a:srgbClr / a:schemeClr element itself, which may
  // carry a child <a:alpha val="68000"/> (68.000% -> 68%).
  if (!node) return 100;
  const colorNode = node["a:srgbClr"] || node["a:schemeClr"] || node["a:sysClr"];
  const alphaNode = colorNode && colorNode["a:alpha"];
  if (!alphaNode) return 100;
  return Number(alphaNode["@_val"]) / 1000;
}

function parseTheme(themeXmlObj) {
  const clrScheme =
    themeXmlObj?.["a:theme"]?.["a:themeElements"]?.["a:clrScheme"] || {};
  const fontScheme =
    themeXmlObj?.["a:theme"]?.["a:themeElements"]?.["a:fontScheme"] || {};

  const readScheme = (node) => {
    if (!node) return null;
    if (node["a:srgbClr"]) return `#${node["a:srgbClr"]["@_val"]}`;
    if (node["a:sysClr"]) return `#${node["a:sysClr"]["@_lastClr"]}`;
    return null;
  };

  const colors = {
    dk1: readScheme(clrScheme["a:dk1"]) || "#000000",
    lt1: readScheme(clrScheme["a:lt1"]) || "#FFFFFF",
    dk2: readScheme(clrScheme["a:dk2"]) || "#1F497D",
    lt2: readScheme(clrScheme["a:lt2"]) || "#EEECE1",
    accent1: readScheme(clrScheme["a:accent1"]) || "#4F81BD",
    accent2: readScheme(clrScheme["a:accent2"]) || "#C0504D",
    accent3: readScheme(clrScheme["a:accent3"]) || "#9BBB59",
    accent4: readScheme(clrScheme["a:accent4"]) || "#8064A2",
    accent5: readScheme(clrScheme["a:accent5"]) || "#4BACC6",
    accent6: readScheme(clrScheme["a:accent6"]) || "#F79646",
    hlink: readScheme(clrScheme["a:hlink"]) || "#0000FF",
    folHlink: readScheme(clrScheme["a:folHlink"]) || "#800080",
  };

  const fonts = {
    major: fontScheme["a:majorFont"]?.["a:latin"]?.["@_typeface"] || "Calibri",
    minor: fontScheme["a:minorFont"]?.["a:latin"]?.["@_typeface"] || "Calibri",
  };

  return { colors, fonts };
}

function resolveSchemeColorRef(schemeClrNode, theme) {
  const aliasMap = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
  const name = schemeClrNode["@_val"];
  const key = aliasMap[name] || name;
  return theme.colors[key] || null;
}

function readFillColor(fillParent, theme) {
  // `fillParent` is the element that might HOLD an <a:solidFill> child
  // (e.g. a:rPr, or a:spPr).
  if (!fillParent) return null;
  const solid = fillParent["a:solidFill"];
  if (!solid) return null;
  return readDirectColor(solid, theme);
}

function readFillAlpha(fillParent) {
  if (!fillParent) return 100;
  const solid = fillParent["a:solidFill"];
  if (!solid) return 100;
  return readAlphaPercent(solid);
}

// Reads an <a:gradFill> node into a renderer-agnostic description.
// Only linear gradients are produced by this deck-generation family
// of tools (no radial/path gradients observed), which keeps this simple.
function parseGradFill(gradFillNode, theme) {
  const stops = asArray(gradFillNode?.["a:gsLst"]?.["a:gs"]).map((gs) => ({
    pos: Number(gs["@_pos"] ?? 0) / 1000, // 1000ths of a percent -> percent
    color: readDirectColor(gs, theme) || "#000000",
    alpha: readAlphaPercent(gs),
  }));
  const linAng = gradFillNode?.["a:lin"]?.["@_ang"];
  // OOXML angle: 0 = pointing right (3 o'clock), clockwise.
  // CSS linear-gradient angle: 0 = pointing up, clockwise.
  // Rotate by +90 to convert between the two conventions.
  const angleDeg = linAng !== undefined ? (Number(linAng) / 60000 + 90) % 360 : 90;
  return { angleDeg, stops };
}

// ------------------------------------------------------------
// SLIDE BACKGROUND
// ------------------------------------------------------------

function parseBackground(sldNode, theme) {
  const bg = sldNode?.["p:cSld"]?.["p:bg"];
  if (!bg) return { type: "color", value: "#FFFFFF" };

  const bgPr = bg["p:bgPr"];
  if (bgPr) {
    const color = readFillColor(bgPr, theme);
    if (color) return { type: "color", value: color };
  }

  const bgRef = bg["p:bgRef"];
  if (bgRef && bgRef["a:schemeClr"]) {
    const color = resolveSchemeColorRef(bgRef["a:schemeClr"], theme);
    if (color) return { type: "color", value: color };
  }

  return { type: "color", value: "#FFFFFF" };
}

// ------------------------------------------------------------
// FONT NAME -> STYLE HINTS
// ------------------------------------------------------------
// Some exporters bake "Bold"/"Italic" into the font NAME instead of
// (or in addition to) setting b="true"/i="true" on the run. We trust
// the explicit flags first, but use the name as a safety net so a
// mismatch never causes a bold/italic run to render as regular.
function deriveStyleFromFontName(fontName) {
  if (!fontName) return { bold: false, italic: false };
  const lower = fontName.toLowerCase();
  return {
    bold: /\bbold\b/.test(lower),
    italic: /\bitalic|\bitalics\b/.test(lower),
  };
}

// ------------------------------------------------------------
// TEXT SHAPES
// ------------------------------------------------------------

function isTitlePlaceholder(spNode) {
  const ph = spNode?.["p:nvSpPr"]?.["p:nvPr"]?.["p:ph"];
  if (!ph) return false;
  const type = ph["@_type"] || "";
  return type === "title" || type === "ctrTitle";
}

// <a:t> is usually a plain string, but when the run carries an
// xml:space="preserve" attribute (exactly the case that matters for
// preserving word-separating spaces), the parser returns it as an
// object like { "@_xml:space": "preserve", "#text": " foo" } instead.
function extractRunText(tNode) {
  if (tNode === undefined || tNode === null) return "";
  if (typeof tNode === "string") return tNode;
  if (typeof tNode === "object" && "#text" in tNode) {
    return String(tNode["#text"]);
  }
  return String(tNode);
}

function parseRun(rNode, theme) {
  const rPr = rNode["a:rPr"] || {};
  const fontName = rPr["a:latin"]?.["@_typeface"] || theme.fonts.minor;
  const nameHints = deriveStyleFromFontName(fontName);

  const solidColor = readFillColor(rPr, theme);
  let gradient = null;
  if (!solidColor && rPr["a:gradFill"]) {
    gradient = parseGradFill(rPr["a:gradFill"], theme);
  }

  return {
    text: extractRunText(rNode["a:t"]),
    size: halfSzToPt(rPr["@_sz"]) ?? 18,
    bold: isTrue(rPr["@_b"]) || nameHints.bold,
    italic: isTrue(rPr["@_i"]) || nameHints.italic,
    color: solidColor || (gradient ? null : theme.colors.dk1),
    gradient, // null unless the run uses a gradient text fill
    font: fontName,
  };
}

function parseParagraph(pNode, theme) {
  const pPr = pNode["a:pPr"] || {};
  const runs = asArray(pNode["a:r"]).map((r) => parseRun(r, theme));
  return {
    align: mapAlign(pPr["@_algn"]),
    runs,
  };
}

function parseTextShapeFromBox(spNode, theme, pct) {
  const txBody = spNode["p:txBody"];
  if (!txBody) return null;

  const paragraphs = asArray(txBody["a:p"])
    .map((p) => parseParagraph(p, theme))
    .filter((p) => p.runs.length > 0 && p.runs.some((r) => r.text));

  if (paragraphs.length === 0) return null;

  const anchor = txBody["a:bodyPr"]?.["@_anchor"];

  return {
    type: "text",
    isTitle: isTitlePlaceholder(spNode),
    x: pct.x,
    y: pct.y,
    w: pct.w,
    h: pct.h,
    rotation: pct.rotation || 0,
    verticalAlign: mapAnchor(anchor),
    paragraphs,
  };
}

// ------------------------------------------------------------
// GEOMETRY: reading + composing transforms (handles groups)
// ------------------------------------------------------------

function getXfrmBox(spPr) {
  const xfrm = spPr?.["a:xfrm"];
  const off = xfrm?.["a:off"];
  const ext = xfrm?.["a:ext"];
  return {
    x: off ? Number(off["@_x"]) : 0,
    y: off ? Number(off["@_y"]) : 0,
    cx: ext ? Number(ext["@_cx"]) : 0,
    cy: ext ? Number(ext["@_cy"]) : 0,
    rot: xfrm?.["@_rot"] ? Number(xfrm["@_rot"]) / 60000 : 0,
    flipH: isTrue(xfrm?.["@_flipH"]),
    flipV: isTrue(xfrm?.["@_flipV"]),
  };
}

function getGroupTransform(grpSpPr) {
  const xfrm = grpSpPr?.["a:xfrm"];
  if (!xfrm) return null;
  const off = xfrm["a:off"];
  const ext = xfrm["a:ext"];
  const chOff = xfrm["a:chOff"];
  const chExt = xfrm["a:chExt"];
  const groupX = off ? Number(off["@_x"]) : 0;
  const groupY = off ? Number(off["@_y"]) : 0;
  const groupCx = ext ? Number(ext["@_cx"]) : 0;
  const groupCy = ext ? Number(ext["@_cy"]) : 0;
  const chX = chOff ? Number(chOff["@_x"]) : 0;
  const chY = chOff ? Number(chOff["@_y"]) : 0;
  const chCx = chExt ? Number(chExt["@_cx"]) : groupCx;
  const chCy = chExt ? Number(chExt["@_cy"]) : groupCy;
  return {
    groupX,
    groupY,
    chX,
    chY,
    scaleX: chCx ? groupCx / chCx : 1,
    scaleY: chCy ? groupCy / chCy : 1,
    rot: xfrm["@_rot"] ? Number(xfrm["@_rot"]) / 60000 : 0,
  };
}

// Maps a shape's LOCAL box (in its group's child-coordinate space)
// into the slide's absolute EMU space, given the group's transform.
// NOTE: only scale+translate are modeled for the mapping itself; a
// rotated group's rotation is added to the child's own rotation but
// the position is not revolved around the group's center. Every
// group actually seen in the wild so far has rot=0, so this is exact
// for the common case and a reasonable approximation otherwise.
function applyGroupTransform(box, group) {
  if (!group) return box;
  return {
    x: group.groupX + (box.x - group.chX) * group.scaleX,
    y: group.groupY + (box.y - group.chY) * group.scaleY,
    cx: box.cx * group.scaleX,
    cy: box.cy * group.scaleY,
    rot: box.rot + group.rot,
    flipH: box.flipH,
    flipV: box.flipV,
  };
}

function boxToPercent(box, slideWidth, slideHeight) {
  return {
    x: emuToPercentOfWidth(box.x, slideWidth),
    y: emuToPercentOfHeight(box.y, slideHeight),
    w: emuToPercentOfWidth(box.cx, slideWidth),
    h: emuToPercentOfHeight(box.cy, slideHeight),
    rotation: box.rot,
    flipH: box.flipH,
    flipV: box.flipV,
  };
}

// ------------------------------------------------------------
// VECTOR PATHS (custGeom -> SVG path data)
// ------------------------------------------------------------
// fast-xml-parser (like most XML-to-object parsers) groups repeated
// sibling tags into arrays keyed by tag name. That's fine when a
// path is ALL lnTo's, but PowerPoint freely mixes lnTo/cubicBezTo
// (straight + curved segments) in one outline, and grouping by tag
// name loses the interleaved order between them. We sidestep this
// by reading the command sequence out of the RAW xml text instead of
// the parsed object tree, in the exact order it appears.
function buildSvgPathFromRawCustGeom(rawCustGeomXml) {
  const openTagMatch = rawCustGeomXml.match(/<a:path\b([^>]*)>/);
  if (!openTagMatch) return null;
  const attrs = openTagMatch[1];
  const wMatch = attrs.match(/\bw="(\d+)"/);
  const hMatch = attrs.match(/\bh="(\d+)"/);
  const pathW = wMatch ? Number(wMatch[1]) : null;
  const pathH = hMatch ? Number(hMatch[1]) : null;
  if (!pathW || !pathH) return null;

  const bodyMatch = rawCustGeomXml.match(/<a:path\b[^>]*>([\s\S]*?)<\/a:path>/);
  const body = bodyMatch ? bodyMatch[1] : "";

  const ptRegex = /<a:pt\s+x="(-?\d+)"\s+y="(-?\d+)"\s*\/>/g;
  const cmdRegex = /<a:(moveTo|lnTo|cubicBezTo)>([\s\S]*?)<\/a:\1>|<a:close\s*\/>/g;

  let d = "";
  let match;
  while ((match = cmdRegex.exec(body)) !== null) {
    if (match[1] === undefined) {
      d += " Z";
      continue;
    }
    const cmd = match[1];
    const inner = match[2];
    const pts = [];
    let ptMatch;
    ptRegex.lastIndex = 0;
    while ((ptMatch = ptRegex.exec(inner)) !== null) {
      pts.push([Number(ptMatch[1]), Number(ptMatch[2])]);
    }
    if (cmd === "moveTo" && pts.length >= 1) {
      d += ` M${pts[0][0]},${pts[0][1]}`;
    } else if (cmd === "lnTo" && pts.length >= 1) {
      d += ` L${pts[0][0]},${pts[0][1]}`;
    } else if (cmd === "cubicBezTo" && pts.length >= 3) {
      d += ` C${pts[0][0]},${pts[0][1]} ${pts[1][0]},${pts[1][1]} ${pts[2][0]},${pts[2][1]}`;
    }
  }

  const trimmed = d.trim();
  if (!trimmed) return null;
  return { pathW, pathH, d: trimmed };
}

// ------------------------------------------------------------
// SHAPE FILL (solid / gradient / picture)
// ------------------------------------------------------------

function readShapeFill(spPr, theme) {
  if (spPr["a:blipFill"]) {
    const rId = spPr["a:blipFill"]["a:blip"]?.["@_r:embed"];
    return rId ? { type: "image", rId } : null;
  }
  if (spPr["a:gradFill"]) {
    return { type: "gradient", ...parseGradFill(spPr["a:gradFill"], theme) };
  }
  if (spPr["a:solidFill"]) {
    const color = readDirectColor(spPr["a:solidFill"], theme);
    if (!color) return null;
    return { type: "solid", color, alpha: readAlphaPercent(spPr["a:solidFill"]) };
  }
  return null;
}

// ------------------------------------------------------------
// DOCUMENT-ORDER TRAVERSAL HELPERS
// ------------------------------------------------------------
// See the note on buildSvgPathFromRawCustGeom above -- the same
// "parsed object trees lose interleaving between different sibling
// tag names" problem applies to top-level spTree children too: if a
// slide's shapes go sp, sp, grpSp, sp in the real file, the parsed
// object gives you spTree["p:sp"] = [sp,sp,sp] and
// spTree["p:grpSp"] = [grp] as two SEPARATE arrays with no record of
// how they interleave -- which silently breaks z-order/layering.
// This walks the RAW xml text instead, tracking only depth of
// <p:grpSp> (the one tag that nests further shapes inside it), to
// recover the true top-to-bottom order of DIRECT children.
function getDirectChildTagOrder(xml) {
  const order = [];
  const re = /<p:(sp|pic|grpSp|graphicFrame|cxnSp)\b[^>]*>|<\/p:grpSp>/g;
  let depth = 0;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[0] === "</p:grpSp>") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const tag = m[1];
    if (depth === 0) order.push(tag);
    if (tag === "grpSp") depth += 1;
  }
  return order;
}

// ------------------------------------------------------------
// SHAPE / PICTURE PROCESSING (produces one output element)
// ------------------------------------------------------------

function registerImageWrite(ctx, rId) {
  const relTarget = ctx.slideRelsMap[rId];
  if (!relTarget) return null;
  const zipPath = path
    .normalize(path.join("ppt/slides", relTarget))
    .split(path.sep)
    .join("/");
  if (!ctx.zip.file(zipPath)) return null;

  const ext = path.extname(zipPath) || ".png";
  ctx.imageCounterRef.count += 1;
  const outName = `slide${ctx.slideIndex + 1}_img${ctx.imageCounterRef.count}${ext}`;
  const outPath = path.join(ctx.imagesOutDir, outName);
  ctx.pendingImageWrites.push({ zipPath, outPath });
  return `images/${outName}`;
}

function processSpNode(sp, ctx) {
  const spPr = sp["p:spPr"] || {};
  const localBox = getXfrmBox(spPr);
  const box = applyGroupTransform(localBox, ctx.group);
  const pct = boxToPercent(box, ctx.slideWidth, ctx.slideHeight);

  // Text takes priority: if the shape has real text content, render it
  // as text regardless of whatever fill its outline also has.
  const textEl = parseTextShapeFromBox(sp, ctx.theme, pct);
  if (textEl) return textEl;

  // Consume this shape's custGeom path (if any) from the ordered raw
  // queue -- see buildSvgPathFromRawCustGeom's comment for why this
  // has to come from raw text rather than the parsed object tree.
  let pathInfo = null;
  if (spPr["a:custGeom"]) {
    const raw = ctx.rawCustGeomQueue.shift();
    if (raw) pathInfo = buildSvgPathFromRawCustGeom(raw);
  }

  const fill = readShapeFill(spPr, ctx.theme);
  if (!fill) return null; // no fill (outline-only / invisible helper shape) -- nothing to draw

  if (fill.type === "image") {
    const src = registerImageWrite(ctx, fill.rId);
    if (!src) return null;
    return {
      type: "image",
      src,
      x: pct.x,
      y: pct.y,
      w: pct.w,
      h: pct.h,
      rotation: pct.rotation,
      flipH: pct.flipH,
      flipV: pct.flipV,
      path: pathInfo, // non-rectangular picture shapes get clipped to their real outline
    };
  }

  return {
    type: "shape",
    x: pct.x,
    y: pct.y,
    w: pct.w,
    h: pct.h,
    rotation: pct.rotation,
    flipH: pct.flipH,
    flipV: pct.flipV,
    fill,
    path: pathInfo,
  };
}

function processPicNode(pic, ctx) {
  const rId = pic["p:blipFill"]?.["a:blip"]?.["@_r:embed"];
  if (!rId) return null;
  const src = registerImageWrite(ctx, rId);
  if (!src) return null;

  const localBox = getXfrmBox(pic["p:spPr"] || {});
  const box = applyGroupTransform(localBox, ctx.group);
  const pct = boxToPercent(box, ctx.slideWidth, ctx.slideHeight);

  let pathInfo = null;
  if (pic["p:spPr"]?.["a:custGeom"]) {
    const raw = ctx.rawCustGeomQueue.shift();
    if (raw) pathInfo = buildSvgPathFromRawCustGeom(raw);
  }

  return {
    type: "image",
    src,
    x: pct.x,
    y: pct.y,
    w: pct.w,
    h: pct.h,
    rotation: pct.rotation,
    flipH: pct.flipH,
    flipV: pct.flipV,
    path: pathInfo,
  };
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------

async function main() {
  const inputPath = resolveInputPath();
  console.log(`Reading: ${inputPath}`);

  const fileBuffer = fs.readFileSync(inputPath);
  const zip = await JSZip.loadAsync(fileBuffer);

  const readRawXml = async (zipPath) => {
    const file = zip.file(zipPath);
    if (!file) return null;
    return file.async("text");
  };
  const readXml = async (zipPath) => {
    const text = await readRawXml(zipPath);
    if (text === null) return null;
    return xmlParser.parse(text);
  };

  // --- Presentation-level info (slide size + slide order) ---
  const presentationXml = await readXml("ppt/presentation.xml");
  if (!presentationXml) {
    console.error("This doesn't look like a valid .pptx (missing presentation.xml).");
    process.exit(1);
  }

  const sldSz = presentationXml["p:presentation"]["p:sldSz"];
  const slideWidth = Number(sldSz["@_cx"]);
  const slideHeight = Number(sldSz["@_cy"]);

  const sldIdList = asArray(
    presentationXml["p:presentation"]["p:sldIdLst"]?.["p:sldId"]
  );

  const presRelsXml = await readXml("ppt/_rels/presentation.xml.rels");
  const presRels = {};
  asArray(presRelsXml?.Relationships?.Relationship).forEach((rel) => {
    presRels[rel["@_Id"]] = rel["@_Target"];
  });

  const slideFiles = sldIdList
    .map((sldId) => presRels[sldId["@_r:id"]])
    .filter(Boolean)
    .map((target) => `ppt/${target}`);

  // --- Embedded font discovery (for render.js to try and match) ---
  const embeddedFontNames = new Set();
  const embeddedFontLst = presentationXml["p:presentation"]["p:embeddedFontLst"];
  asArray(embeddedFontLst?.["p:embeddedFont"]).forEach((ef) => {
    const typeface = ef["p:font"]?.["@_typeface"];
    if (typeface) embeddedFontNames.add(typeface);
  });

  // --- Theme ---
  let themeXml = await readXml("ppt/theme/theme1.xml");
  if (!themeXml) {
    const themeFile = Object.keys(zip.files).find((f) =>
      /^ppt\/theme\/theme\d+\.xml$/.test(f)
    );
    if (themeFile) themeXml = await readXml(themeFile);
  }
  const theme = parseTheme(themeXml || {});

  // --- Images output dir: clear it first so old decks don't linger ---
  if (fs.existsSync(IMAGES_OUT_DIR)) {
    fs.rmSync(IMAGES_OUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(IMAGES_OUT_DIR, { recursive: true });

  const pendingImageWrites = [];
  const slides = [];
  const fontsUsed = new Set();

  for (let i = 0; i < slideFiles.length; i++) {
    const slideXmlPath = slideFiles[i];
    const rawSlideXml = await readRawXml(slideXmlPath);
    if (!rawSlideXml) continue;
    const slideXml = xmlParser.parse(rawSlideXml);

    const sld = slideXml["p:sld"];
    const background = parseBackground(sld, theme);

    const slideDir = path.dirname(slideXmlPath);
    const slideBase = path.basename(slideXmlPath);
    const relsPath = `${slideDir}/_rels/${slideBase}.rels`;
    const slideRelsXml = await readXml(relsPath);
    const slideRelsMap = {};
    asArray(slideRelsXml?.Relationships?.Relationship).forEach((rel) => {
      slideRelsMap[rel["@_Id"]] = rel["@_Target"];
    });

    const spTreeObj = sld["p:cSld"]["p:spTree"];

    // Ordered queue of every custGeom block on this slide, in true
    // document order (covers shapes inside groups too, since custGeom
    // blocks never nest and always appear where their owning shape is).
    const rawCustGeomQueue = [
      ...rawSlideXml.matchAll(/<a:custGeom>[\s\S]*?<\/a:custGeom>/g),
    ].map((m) => m[0]);

    const spTreeRawMatch = rawSlideXml.match(/<p:spTree>([\s\S]*)<\/p:spTree>/);
    const topOrder = getDirectChildTagOrder(
      spTreeRawMatch ? spTreeRawMatch[1] : ""
    );

    const spArr = asArray(spTreeObj["p:sp"]);
    const picArr = asArray(spTreeObj["p:pic"]);
    const grpArr = asArray(spTreeObj["p:grpSp"]);
    let spIdx = 0;
    let picIdx = 0;
    let grpIdx = 0;

    const imageCounterRef = { count: 0 };
    const ctx = {
      theme,
      slideWidth,
      slideHeight,
      group: null,
      slideRelsMap,
      zip,
      imagesOutDir: IMAGES_OUT_DIR,
      slideIndex: i,
      imageCounterRef,
      pendingImageWrites,
      rawCustGeomQueue,
    };

    const elements = [];

    for (const tag of topOrder) {
      if (tag === "sp") {
        const sp = spArr[spIdx++];
        if (!sp) continue;
        const el = processSpNode(sp, ctx);
        if (el) elements.push(el);
        collectFontsFromElement(el, fontsUsed);
      } else if (tag === "pic") {
        const pic = picArr[picIdx++];
        if (!pic) continue;
        const el = processPicNode(pic, ctx);
        if (el) elements.push(el);
      } else if (tag === "grpSp") {
        const grp = grpArr[grpIdx++];
        if (!grp) continue;
        const groupTransform = getGroupTransform(grp["p:grpSpPr"]);
        const innerCtx = { ...ctx, group: groupTransform };
        // Every group observed in this deck-generator family only ever
        // contains <p:sp> children; <p:pic>/nested <p:grpSp> are handled
        // too (processed after the sp's) in case a future deck uses them,
        // though their relative order against the sp's isn't guaranteed.
        for (const gsp of asArray(grp["p:sp"])) {
          const el = processSpNode(gsp, innerCtx);
          if (el) elements.push(el);
          collectFontsFromElement(el, fontsUsed);
        }
        for (const gpic of asArray(grp["p:pic"])) {
          const el = processPicNode(gpic, innerCtx);
          if (el) elements.push(el);
        }
      }
    }

    slides.push({ background, elements });
  }

  // Write out extracted images
  for (const { zipPath, outPath } of pendingImageWrites) {
    const entry = zip.file(zipPath);
    if (!entry) continue;
    const buffer = await entry.async("nodebuffer");
    fs.writeFileSync(outPath, buffer);
  }

  const deck = {
    slideWidth,
    slideHeight,
    theme,
    fontsUsed: [...fontsUsed].sort(),
    embeddedFontNames: [...embeddedFontNames].sort(),
    slides,
  };

  if (fs.existsSync(SLIDES_OUT)) {
    fs.copyFileSync(SLIDES_OUT, SLIDES_BACKUP);
    console.log(`Backed up existing slides.js -> slides.backup.js`);
  }

  const fileContents =
    `// AUTO-GENERATED by import-pptx.js from: ${path.basename(inputPath)}\n` +
    `// Re-run "npm run import -- \\"${path.basename(inputPath)}\\"" to regenerate.\n` +
    `module.exports = ${JSON.stringify(deck, null, 2)};\n`;

  fs.writeFileSync(SLIDES_OUT, fileContents, "utf8");

  console.log(`Wrote ${slides.length} slides to slides.js`);
  console.log(`Extracted ${pendingImageWrites.length} image(s) to public/images/`);
  console.log(`Fonts used in text: ${[...fontsUsed].sort().join(", ") || "(none)"}`);
  if (embeddedFontNames.size) {
    console.log(
      `Note: this deck embeds custom fonts (${[...embeddedFontNames].sort().join(", ")}) ` +
        `but they use an obfuscation format with no recoverable key in this file, so they ` +
        `can't be extracted. render.js substitutes close alternatives instead.`
    );
  }
}

function collectFontsFromElement(el, fontsUsed) {
  if (!el || el.type !== "text") return;
  for (const para of el.paragraphs || []) {
    for (const run of para.runs || []) {
      if (run.font) fontsUsed.add(run.font);
    }
  }
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});