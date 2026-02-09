/**
 * Complete Template PPTX Extractor
 * Extracts EVERY formatting property from all 26 slides + master + layouts + charts + theme
 * Output: complete JSON replacing template-patterns.json
 */
const JSZip = require('jszip');
const fs = require('fs');

const TEMPLATE_PATH =
  '/home/xvasjack/xvasjack.github.io/Market_Research_energy_services_2025-12-31 (6).pptx';
const EMU_PER_INCH = 914400;
const EMU_PER_PT = 12700;

function emuToInches(emu) {
  return emu ? Math.round((parseInt(emu) / EMU_PER_INCH) * 10000) / 10000 : 0;
}

function emuToPoints(emu) {
  return emu ? Math.round((parseInt(emu) / EMU_PER_PT) * 100) / 100 : 0;
}

function hundredthsPtToPoints(val) {
  return val ? parseInt(val) / 100 : null;
}

// Simple XML tag extractor (no dependency needed — regex-based)
function getAttr(xml, attr) {
  const m = xml.match(new RegExp(`${attr}="([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

function getTag(xml, tag) {
  // Match self-closing or content tags
  const re = new RegExp(`<${tag}([^>]*?)(?:/>|>(.*?)</${tag}>)`, 's');
  const m = xml.match(re);
  if (!m) return null;
  return { attrs: m[1] || '', content: m[2] || '', full: m[0] };
}

function getAllTags(xml, tag) {
  return getAllNestedTags(xml, tag);
}

// Check if char after tag name indicates exact match (not prefix of longer tag)
function isExactTagMatch(xml, pos, tagLen) {
  const charAfter = xml[pos + tagLen];
  return (
    charAfter === '>' ||
    charAfter === ' ' ||
    charAfter === '/' ||
    charAfter === '\t' ||
    charAfter === '\n' ||
    charAfter === '\r'
  );
}

// Find all top-level occurrences of a tag with balanced matching
function getAllNestedTags(xml, tag) {
  const results = [];
  const openTag = `<${tag}`;
  const closeTag = `</${tag}>`;
  let searchStart = 0;

  while (searchStart < xml.length) {
    const idx = xml.indexOf(openTag, searchStart);
    if (idx === -1) break;

    // Make sure it's actually this tag and not a prefix (e.g. p:sp vs p:spTree)
    if (!isExactTagMatch(xml, idx, openTag.length)) {
      searchStart = idx + 1;
      continue;
    }

    // Check self-closing
    const tagEnd = xml.indexOf('>', idx);
    if (tagEnd === -1) break;
    if (xml[tagEnd - 1] === '/') {
      results.push(xml.substring(idx, tagEnd + 1));
      searchStart = tagEnd + 1;
      continue;
    }

    // Find balanced closing tag
    let depth = 1;
    let pos = tagEnd + 1;
    while (pos < xml.length && depth > 0) {
      const nextOpen = xml.indexOf(openTag, pos);
      const nextClose = xml.indexOf(closeTag, pos);

      if (nextClose === -1) break;

      if (
        nextOpen !== -1 &&
        nextOpen < nextClose &&
        isExactTagMatch(xml, nextOpen, openTag.length)
      ) {
        depth++;
        pos = nextOpen + openTag.length;
      } else {
        depth--;
        if (depth === 0) {
          results.push(xml.substring(idx, nextClose + closeTag.length));
          searchStart = nextClose + closeTag.length;
        }
        pos = nextClose + closeTag.length;
      }
    }

    if (depth > 0) {
      // Unbalanced — skip this occurrence
      searchStart = idx + 1;
    }
  }

  return results;
}

// Get first occurrence of a nested tag
function getNestedTag(xml, tag) {
  const results = getAllNestedTags(xml, tag);
  return results.length > 0 ? results[0] : null;
}

// Extract position/size from xfrm
function parseXfrm(xml) {
  const xfrm = getNestedTag(xml, 'a:xfrm') || getNestedTag(xml, 'p:xfrm');
  if (!xfrm) return null;

  const off = getTag(xfrm, 'a:off');
  const ext = getTag(xfrm, 'a:ext');

  if (!off || !ext) return null;

  return {
    x: emuToInches(getAttr(off.full, 'x')),
    y: emuToInches(getAttr(off.full, 'y')),
    w: emuToInches(getAttr(ext.full, 'cx')),
    h: emuToInches(getAttr(ext.full, 'cy')),
    rotation: getAttr(xfrm, 'rot') ? parseInt(getAttr(xfrm, 'rot')) / 60000 : 0,
    flipH: getAttr(xfrm, 'flipH') === '1',
    flipV: getAttr(xfrm, 'flipV') === '1',
    // Keep raw EMU values too
    _emu: {
      x: parseInt(getAttr(off.full, 'x') || 0),
      y: parseInt(getAttr(off.full, 'y') || 0),
      cx: parseInt(getAttr(ext.full, 'cx') || 0),
      cy: parseInt(getAttr(ext.full, 'cy') || 0),
    },
  };
}

// Extract solid fill color
function parseFill(xml) {
  if (!xml) return null;

  // No fill
  if (xml.includes('<a:noFill/>') || xml.includes('<a:noFill />')) {
    return { type: 'none' };
  }

  // Solid fill
  const solidFill = getNestedTag(xml, 'a:solidFill');
  if (solidFill) {
    const srgb = getTag(solidFill, 'a:srgbClr');
    if (srgb) {
      const color = getAttr(srgb.full, 'val');
      const alpha = getTag(srgb.content || solidFill, 'a:alpha');
      return {
        type: 'solid',
        color: color,
        alpha: alpha ? parseInt(getAttr(alpha.full, 'val')) / 1000 : 100,
      };
    }
    const schemeClr = getTag(solidFill, 'a:schemeClr');
    if (schemeClr) {
      return {
        type: 'scheme',
        scheme: getAttr(schemeClr.full, 'val'),
      };
    }
  }

  // Gradient fill
  const gradFill = getNestedTag(xml, 'a:gradFill');
  if (gradFill) {
    const stops = getAllTags(gradFill, 'a:gs');
    return {
      type: 'gradient',
      stops: stops.map((gs) => {
        const pos = getAttr(gs, 'pos');
        const srgb = getTag(gs, 'a:srgbClr');
        return {
          pos: pos ? parseInt(pos) / 1000 : 0,
          color: srgb ? getAttr(srgb.full, 'val') : null,
        };
      }),
    };
  }

  // Pattern fill
  const pattFill = getNestedTag(xml, 'a:pattFill');
  if (pattFill) {
    return {
      type: 'pattern',
      preset: getAttr(pattFill, 'prst'),
    };
  }

  return null;
}

// Extract line properties
function parseLine(xml) {
  const ln = getNestedTag(xml, 'a:ln');
  if (!ln) return null;

  const width = getAttr(ln, 'w');
  const fill = parseFill(ln);
  const dash = getTag(ln, 'a:prstDash');
  const headEnd = getTag(ln, 'a:headEnd');
  const tailEnd = getTag(ln, 'a:tailEnd');

  return {
    width: width ? emuToPoints(width) : null,
    widthPt: width ? Math.round((parseInt(width) / 12700) * 100) / 100 : null,
    fill: fill,
    dash: dash ? getAttr(dash.full, 'val') : null,
    cap: getAttr(ln, 'cap') || null,
    compound: getAttr(ln, 'cmpd') || null,
    headEnd: headEnd
      ? {
          type: getAttr(headEnd.full, 'type'),
          w: getAttr(headEnd.full, 'w'),
          len: getAttr(headEnd.full, 'len'),
        }
      : null,
    tailEnd: tailEnd
      ? {
          type: getAttr(tailEnd.full, 'type'),
          w: getAttr(tailEnd.full, 'w'),
          len: getAttr(tailEnd.full, 'len'),
        }
      : null,
  };
}

// Parse run properties (font info)
function parseRunProps(rPr) {
  if (!rPr) return null;

  const props = {
    lang: getAttr(rPr, 'lang'),
    size: getAttr(rPr, 'sz') ? parseInt(getAttr(rPr, 'sz')) / 100 : null,
    bold: getAttr(rPr, 'b') === '1',
    italic: getAttr(rPr, 'i') === '1',
    underline: getAttr(rPr, 'u') || null,
    strike: getAttr(rPr, 'strike') || null,
    baseline: getAttr(rPr, 'baseline') ? parseInt(getAttr(rPr, 'baseline')) : null,
  };

  // Font color
  const fill = parseFill(rPr);
  if (fill && fill.type === 'solid') {
    props.color = fill.color;
  } else if (fill && fill.type === 'scheme') {
    props.schemeColor = fill.scheme;
  }

  // Font face
  const latin = getTag(rPr, 'a:latin');
  if (latin) props.fontFamily = getAttr(latin.full, 'typeface');

  const ea = getTag(rPr, 'a:ea');
  if (ea) props.fontFamilyEA = getAttr(ea.full, 'typeface');

  const cs = getTag(rPr, 'a:cs');
  if (cs) props.fontFamilyCS = getAttr(cs.full, 'typeface');

  // Highlight
  const highlight = getTag(rPr, 'a:highlight');
  if (highlight) {
    const hclr = getTag(highlight.full, 'a:srgbClr');
    if (hclr) props.highlight = getAttr(hclr.full, 'val');
  }

  return props;
}

// Parse paragraph properties
function parseParagraphProps(pPr) {
  if (!pPr) return {};

  const props = {
    alignment: getAttr(pPr, 'algn') || null,
    indent: getAttr(pPr, 'indent') ? emuToInches(getAttr(pPr, 'indent')) : null,
    indentEmu: getAttr(pPr, 'indent') ? parseInt(getAttr(pPr, 'indent')) : null,
    marginLeft: getAttr(pPr, 'marL') ? emuToInches(getAttr(pPr, 'marL')) : null,
    marginLeftEmu: getAttr(pPr, 'marL') ? parseInt(getAttr(pPr, 'marL')) : null,
    level: getAttr(pPr, 'lvl') ? parseInt(getAttr(pPr, 'lvl')) : null,
    rtl: getAttr(pPr, 'rtl') === '1',
  };

  // Line spacing
  const lnSpc = getNestedTag(pPr, 'a:lnSpc');
  if (lnSpc) {
    const spcPct = getTag(lnSpc, 'a:spcPct');
    const spcPts = getTag(lnSpc, 'a:spcPts');
    if (spcPct) props.lineSpacingPct = parseInt(getAttr(spcPct.full, 'val')) / 1000;
    if (spcPts) props.lineSpacingPts = parseInt(getAttr(spcPts.full, 'val')) / 100;
  }

  // Space before/after
  const spcBef = getNestedTag(pPr, 'a:spcBef');
  if (spcBef) {
    const pts = getTag(spcBef, 'a:spcPts');
    if (pts) props.spaceBefore = parseInt(getAttr(pts.full, 'val')) / 100;
  }
  const spcAft = getNestedTag(pPr, 'a:spcAft');
  if (spcAft) {
    const pts = getTag(spcAft, 'a:spcPts');
    if (pts) props.spaceAfter = parseInt(getAttr(pts.full, 'val')) / 100;
  }

  // Bullet
  const buNone = pPr.includes('<a:buNone');
  const buChar = getTag(pPr, 'a:buChar');
  const buAutoNum = getTag(pPr, 'a:buAutoNum');
  const buSzPct = getTag(pPr, 'a:buSzPct');
  const buFont = getTag(pPr, 'a:buFont');
  const buClr = getNestedTag(pPr, 'a:buClr');

  if (buNone) {
    props.bullet = { type: 'none' };
  } else if (buChar) {
    props.bullet = {
      type: 'char',
      char: getAttr(buChar.full, 'char'),
      sizePct: buSzPct ? parseInt(getAttr(buSzPct.full, 'val')) / 1000 : null,
      font: buFont ? getAttr(buFont.full, 'typeface') : null,
    };
    if (buClr) {
      const srgb = getTag(buClr, 'a:srgbClr');
      if (srgb) props.bullet.color = getAttr(srgb.full, 'val');
    }
  } else if (buAutoNum) {
    props.bullet = {
      type: 'autoNum',
      scheme: getAttr(buAutoNum.full, 'type'),
    };
  }

  return props;
}

// Parse text body fully
function parseTextBody(xml) {
  const txBody = getNestedTag(xml, 'p:txBody') || getNestedTag(xml, 'a:txBody');
  if (!txBody) return null;

  // Body properties
  const bodyPr = getNestedTag(txBody, 'a:bodyPr');
  const bodyProps = {};
  if (bodyPr) {
    bodyProps.wrap = getAttr(bodyPr, 'wrap') || null;
    bodyProps.anchor = getAttr(bodyPr, 'anchor') || null;
    bodyProps.anchorCtr = getAttr(bodyPr, 'anchorCtr') === '1';
    bodyProps.rtlCol = getAttr(bodyPr, 'rtlCol') === '1';
    bodyProps.vert = getAttr(bodyPr, 'vert') || null;
    bodyProps.rot = getAttr(bodyPr, 'rot') ? parseInt(getAttr(bodyPr, 'rot')) / 60000 : null;

    // Margins
    const lIns = getAttr(bodyPr, 'lIns');
    const rIns = getAttr(bodyPr, 'rIns');
    const tIns = getAttr(bodyPr, 'tIns');
    const bIns = getAttr(bodyPr, 'bIns');
    if (lIns) bodyProps.marginLeft = emuToInches(lIns);
    if (rIns) bodyProps.marginRight = emuToInches(rIns);
    if (tIns) bodyProps.marginTop = emuToInches(tIns);
    if (bIns) bodyProps.marginBottom = emuToInches(bIns);

    // Auto fit
    if (bodyPr.includes('<a:spAutoFit')) bodyProps.autoFit = true;
    if (bodyPr.includes('<a:noAutofit')) bodyProps.autoFit = false;
    if (bodyPr.includes('<a:normAutofit')) {
      bodyProps.autoFit = 'normal';
      const normFit = getTag(bodyPr, 'a:normAutofit');
      if (normFit) {
        const fontScale = getAttr(normFit.full, 'fontScale');
        if (fontScale) bodyProps.fontScale = parseInt(fontScale) / 1000;
      }
    }
  }

  // Paragraphs
  const paragraphs = getAllNestedTags(txBody, 'a:p');
  const paras = paragraphs.map((p) => {
    const pPr = getNestedTag(p, 'a:pPr');
    const paraProps = parseParagraphProps(pPr || '');

    // Text runs
    const runs = getAllNestedTags(p, 'a:r');
    const textRuns = runs.map((r) => {
      const rPr = getNestedTag(r, 'a:rPr');
      const tTag = getTag(r, 'a:t');
      return {
        text: tTag ? tTag.content : '',
        props: parseRunProps(rPr || ''),
      };
    });

    // End paragraph run props
    const endRPr = getNestedTag(p, 'a:endParaRPr');

    return {
      props: paraProps,
      runs: textRuns,
      endRunProps: parseRunProps(endRPr || ''),
      fullText: textRuns.map((r) => r.text).join(''),
    };
  });

  return {
    bodyProps,
    paragraphs: paras,
    fullText: paras.map((p) => p.fullText).join('\n'),
  };
}

// Parse geometry
function parseGeometry(xml) {
  const prstGeom = getTag(xml, 'a:prstGeom');
  if (prstGeom) {
    return { type: 'preset', preset: getAttr(prstGeom.full, 'prst') };
  }
  const custGeom = getNestedTag(xml, 'a:custGeom');
  if (custGeom) {
    return { type: 'custom' };
  }
  return null;
}

// Parse shape properties
function parseShapeProps(xml) {
  const spPr = getNestedTag(xml, 'p:spPr') || getNestedTag(xml, 'a:spPr');
  if (!spPr) return {};

  return {
    xfrm: parseXfrm(spPr),
    geometry: parseGeometry(spPr),
    fill: parseFill(spPr),
    line: parseLine(spPr),
  };
}

// Parse a single table cell
function parseTableCell(tc) {
  const txBody = parseTextBody(tc);

  // Cell properties
  const tcPr = getNestedTag(tc, 'a:tcPr');
  const cellProps = {};
  if (tcPr) {
    // Margins
    const marL = getAttr(tcPr, 'marL');
    const marR = getAttr(tcPr, 'marR');
    const marT = getAttr(tcPr, 'marT');
    const marB = getAttr(tcPr, 'marB');
    if (marL) cellProps.marginLeft = emuToInches(marL);
    if (marR) cellProps.marginRight = emuToInches(marR);
    if (marT) cellProps.marginTop = emuToInches(marT);
    if (marB) cellProps.marginBottom = emuToInches(marB);

    cellProps.anchor = getAttr(tcPr, 'anchor') || null;

    // Borders
    const borders = {};
    for (const side of ['lnL', 'lnR', 'lnT', 'lnB']) {
      const ln = getNestedTag(tcPr, `a:${side}`);
      if (ln) {
        const w = getAttr(ln, 'w');
        const fill = parseFill(ln);
        const dash = getTag(ln, 'a:prstDash');
        borders[side] = {
          width: w ? emuToPoints(w) : null,
          fill: fill,
          dash: dash ? getAttr(dash.full, 'val') : null,
        };
      }
    }
    if (Object.keys(borders).length > 0) cellProps.borders = borders;

    // Cell fill
    cellProps.fill = parseFill(tcPr);

    // Merge info
    const gridSpan = getAttr(tc, 'gridSpan');
    const rowSpan = getAttr(tc, 'rowSpan');
    const hMerge = getAttr(tc, 'hMerge');
    const vMerge = getAttr(tc, 'vMerge');
    if (gridSpan) cellProps.gridSpan = parseInt(gridSpan);
    if (rowSpan) cellProps.rowSpan = parseInt(rowSpan);
    if (hMerge) cellProps.hMerge = true;
    if (vMerge) cellProps.vMerge = true;
  }

  return {
    text: txBody,
    cellProps,
  };
}

// Parse a full table
function parseTable(xml) {
  const tbl = getNestedTag(xml, 'a:tbl');
  if (!tbl) return null;

  // Table properties
  const tblPr = getNestedTag(tbl, 'a:tblPr');
  const tableProps = {};
  if (tblPr) {
    tableProps.bandRow = getAttr(tblPr, 'bandRow') !== '0';
    tableProps.bandCol = getAttr(tblPr, 'bandCol') !== '0';
    tableProps.firstRow = getAttr(tblPr, 'firstRow') === '1';
    tableProps.firstCol = getAttr(tblPr, 'firstCol') === '1';
    tableProps.lastRow = getAttr(tblPr, 'lastRow') === '1';
    tableProps.lastCol = getAttr(tblPr, 'lastCol') === '1';
    tableProps.rtl = getAttr(tblPr, 'rtl') === '1';
  }

  // Grid columns
  const gridCols = getAllTags(tbl, 'a:gridCol');
  const columns = gridCols.map((gc) => ({
    width: emuToInches(getAttr(gc, 'w')),
    widthEmu: parseInt(getAttr(gc, 'w') || 0),
  }));

  // Rows
  const rows = getAllNestedTags(tbl, 'a:tr');
  const tableRows = rows.map((tr) => {
    const height = getAttr(tr, 'h');
    const cells = getAllNestedTags(tr, 'a:tc');
    return {
      height: height ? emuToInches(height) : null,
      heightEmu: height ? parseInt(height) : null,
      cells: cells.map(parseTableCell),
    };
  });

  return {
    props: tableProps,
    columns,
    rows: tableRows,
    columnCount: columns.length,
    rowCount: tableRows.length,
  };
}

// Parse a single shape (p:sp)
function parseShape(sp) {
  // Non-visual properties
  const nvSpPr = getNestedTag(sp, 'p:nvSpPr');
  const cNvPr = nvSpPr ? getNestedTag(nvSpPr, 'p:cNvPr') : null;
  const name = cNvPr ? getAttr(cNvPr, 'name') : null;
  const id = cNvPr ? getAttr(cNvPr, 'id') : null;
  const descr = cNvPr ? getAttr(cNvPr, 'descr') : null;

  // Shape properties
  const shapeProps = parseShapeProps(sp);

  // Text body
  const textBody = parseTextBody(sp);

  return {
    type: 'shape',
    id: id ? parseInt(id) : null,
    name,
    description: descr,
    position: shapeProps.xfrm,
    geometry: shapeProps.geometry,
    fill: shapeProps.fill,
    line: shapeProps.line,
    textBody,
  };
}

// Parse connection shape (p:cxnSp)
function parseConnectionShape(cxnSp) {
  const nvCxnSpPr = getNestedTag(cxnSp, 'p:nvCxnSpPr');
  const cNvPr = nvCxnSpPr ? getNestedTag(nvCxnSpPr, 'p:cNvPr') : null;
  const name = cNvPr ? getAttr(cNvPr, 'name') : null;
  const id = cNvPr ? getAttr(cNvPr, 'id') : null;

  const shapeProps = parseShapeProps(cxnSp);

  return {
    type: 'connector',
    id: id ? parseInt(id) : null,
    name,
    position: shapeProps.xfrm,
    geometry: shapeProps.geometry,
    fill: shapeProps.fill,
    line: shapeProps.line,
  };
}

// Parse graphic frame (tables, charts, etc.)
function parseGraphicFrame(gf) {
  const nvPr = getNestedTag(gf, 'p:nvGraphicFramePr');
  const cNvPr = nvPr ? getNestedTag(nvPr, 'p:cNvPr') : null;
  const name = cNvPr ? getAttr(cNvPr, 'name') : null;
  const id = cNvPr ? getAttr(cNvPr, 'id') : null;
  const descr = cNvPr ? getAttr(cNvPr, 'descr') : null;

  const xfrm = parseXfrm(gf);

  // Determine content type
  const graphicData = getNestedTag(gf, 'a:graphicData');
  const uri = graphicData ? getAttr(graphicData, 'uri') : null;

  const result = {
    id: id ? parseInt(id) : null,
    name,
    description: descr,
    position: xfrm,
  };

  if (uri && uri.includes('chart')) {
    result.type = 'chart';
    const chartTag = getTag(graphicData, 'c:chart');
    if (chartTag) {
      result.chartRelId = getAttr(chartTag.full, 'r:id');
    }
  } else if (uri && uri.includes('table')) {
    result.type = 'table';
    result.table = parseTable(graphicData);
  } else {
    result.type = 'graphicFrame';
    result.uri = uri;
  }

  return result;
}

// Parse group shape (p:grpSp)
function parseGroupShape(grpSp) {
  const nvGrpSpPr = getNestedTag(grpSp, 'p:nvGrpSpPr');
  const cNvPr = nvGrpSpPr ? getNestedTag(nvGrpSpPr, 'p:cNvPr') : null;
  const name = cNvPr ? getAttr(cNvPr, 'name') : null;
  const id = cNvPr ? getAttr(cNvPr, 'id') : null;

  const grpSpPr = getNestedTag(grpSp, 'p:grpSpPr');
  const xfrm = grpSpPr ? parseXfrm(grpSpPr) : null;

  // Child shapes
  const children = parseSlideElements(grpSp);

  return {
    type: 'group',
    id: id ? parseInt(id) : null,
    name,
    position: xfrm,
    children,
  };
}

// Parse all elements on a slide
function parseSlideElements(xml) {
  const elements = [];

  // Shapes (p:sp) — excluding the root nvGrpSpPr/grpSpPr
  const shapes = getAllNestedTags(xml, 'p:sp');
  for (const sp of shapes) {
    elements.push(parseShape(sp));
  }

  // Graphic frames (p:graphicFrame)
  const gfs = getAllNestedTags(xml, 'p:graphicFrame');
  for (const gf of gfs) {
    elements.push(parseGraphicFrame(gf));
  }

  // Connection shapes (p:cxnSp)
  const cxns = getAllNestedTags(xml, 'p:cxnSp');
  for (const cxn of cxns) {
    elements.push(parseConnectionShape(cxn));
  }

  // Group shapes (p:grpSp) — skip the root one
  const grps = getAllNestedTags(xml, 'p:grpSp');
  for (const grp of grps) {
    // Skip root group (the spTree itself)
    if (grp.includes('<p:nvGrpSpPr><p:cNvPr id="1" name=""')) continue;
    elements.push(parseGroupShape(grp));
  }

  // Picture shapes (p:pic)
  const pics = getAllNestedTags(xml, 'p:pic');
  for (const pic of pics) {
    const nvPicPr = getNestedTag(pic, 'p:nvPicPr');
    const cNvPr = nvPicPr ? getNestedTag(nvPicPr, 'p:cNvPr') : null;
    const name = cNvPr ? getAttr(cNvPr, 'name') : null;
    const id = cNvPr ? getAttr(cNvPr, 'id') : null;
    const xfrm = parseXfrm(pic);

    elements.push({
      type: 'picture',
      id: id ? parseInt(id) : null,
      name,
      position: xfrm,
    });
  }

  return elements;
}

// Parse chart XML
function parseChartXml(xml) {
  const result = {
    type: null,
    title: null,
    series: [],
    axes: [],
    legend: null,
    plotArea: {},
  };

  // Chart type detection
  const chartTypes = [
    'c:barChart',
    'c:bar3DChart',
    'c:lineChart',
    'c:pieChart',
    'c:pie3DChart',
    'c:areaChart',
    'c:scatterChart',
    'c:doughnutChart',
    'c:radarChart',
    'c:bubbleChart',
    'c:stockChart',
    'c:surfaceChart',
    'c:ofPieChart',
  ];

  for (const ct of chartTypes) {
    if (xml.includes(`<${ct}`)) {
      result.type = ct.replace('c:', '');

      const chartBlock = getNestedTag(xml, ct);
      if (chartBlock) {
        // Bar direction
        const dir = getTag(chartBlock, 'c:barDir');
        if (dir) result.barDir = getAttr(dir.full, 'val');

        // Grouping
        const grp = getTag(chartBlock, 'c:grouping');
        if (grp) result.grouping = getAttr(grp.full, 'val');

        // Series
        const serList = getAllNestedTags(chartBlock, 'c:ser');
        result.series = serList.map((ser) => {
          const idx = getTag(ser, 'c:idx');
          const order = getTag(ser, 'c:order');
          const tx = getNestedTag(ser, 'c:tx');

          // Series name
          let serName = null;
          if (tx) {
            const strRef = getNestedTag(tx, 'c:strRef');
            if (strRef) {
              const strCache = getNestedTag(strRef, 'c:strCache');
              if (strCache) {
                const pt = getNestedTag(strCache, 'c:pt');
                if (pt) {
                  const v = getTag(pt, 'c:v');
                  if (v) serName = v.content;
                }
              }
            }
          }

          // Series fill color
          const spPr = getNestedTag(ser, 'c:spPr');
          const fill = spPr ? parseFill(spPr) : null;

          // Category count
          const cat = getNestedTag(ser, 'c:cat');
          let catCount = 0;
          if (cat) {
            const numRef = getNestedTag(cat, 'c:numRef');
            const strRef = getNestedTag(cat, 'c:strRef');
            const cache = numRef
              ? getNestedTag(numRef, 'c:numCache')
              : strRef
                ? getNestedTag(strRef, 'c:strCache')
                : null;
            if (cache) {
              const ptCount = getTag(cache, 'c:ptCount');
              if (ptCount) catCount = parseInt(getAttr(ptCount.full, 'val') || 0);
            }
          }

          return {
            index: idx ? parseInt(getAttr(idx.full, 'val')) : null,
            order: order ? parseInt(getAttr(order.full, 'val')) : null,
            name: serName,
            fill,
            categoryCount: catCount,
          };
        });
      }
      break;
    }
  }

  // Title
  const title = getNestedTag(xml, 'c:title');
  if (title) {
    const txBody = getNestedTag(title, 'c:tx');
    if (txBody) {
      const rich = getNestedTag(txBody, 'c:rich');
      if (rich) {
        const runs = getAllNestedTags(rich, 'a:r');
        result.title = runs
          .map((r) => {
            const t = getTag(r, 'a:t');
            return t ? t.content : '';
          })
          .join('');
      }
    }
  }

  // Axes
  const axTypes = ['c:catAx', 'c:valAx', 'c:dateAx', 'c:serAx'];
  for (const axType of axTypes) {
    const axes = getAllNestedTags(xml, axType);
    for (const ax of axes) {
      const axId = getTag(ax, 'c:axId');
      const del = getTag(ax, 'c:delete');
      const pos = getTag(ax, 'c:axPos');
      const numFmt = getTag(ax, 'c:numFmt');

      result.axes.push({
        type: axType.replace('c:', ''),
        id: axId ? getAttr(axId.full, 'val') : null,
        deleted: del ? getAttr(del.full, 'val') === '1' : false,
        position: pos ? getAttr(pos.full, 'val') : null,
        numFormat: numFmt ? getAttr(numFmt.full, 'formatCode') : null,
      });
    }
  }

  // Legend
  const legend = getNestedTag(xml, 'c:legend');
  if (legend) {
    const legendPos = getTag(legend, 'c:legendPos');
    result.legend = {
      position: legendPos ? getAttr(legendPos.full, 'val') : null,
    };
  }

  // Plot area fill
  const plotArea = getNestedTag(xml, 'c:plotArea');
  if (plotArea) {
    const spPr = getNestedTag(plotArea, 'c:spPr');
    if (spPr) {
      result.plotArea.fill = parseFill(spPr);
    }
  }

  // Chart style
  const style = getTag(xml, 'c:style');
  if (style) result.styleVal = getAttr(style.full, 'val');

  return result;
}

// Parse slide relationships
async function parseSlideRels(zip, slideNum) {
  const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
  const file = zip.file(relsPath);
  if (!file) return {};

  const xml = await file.async('string');
  const rels = {};
  const relTags = getAllTags(xml, 'Relationship');
  for (const rel of relTags) {
    const id = getAttr(rel, 'Id');
    const type = getAttr(rel, 'Type');
    const target = getAttr(rel, 'Target');
    if (id) {
      rels[id] = { type: type ? type.split('/').pop() : null, target };
    }
  }
  return rels;
}

// Main extraction
async function extractTemplate() {
  console.log('Loading template PPTX...');
  const buffer = fs.readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(buffer);

  const result = {
    _meta: {
      source: 'Market_Research_energy_services_2025-12-31 (6).pptx',
      extractedAt: new Date().toISOString(),
      slideCount: 26,
      chartCount: 6,
    },
    presentation: {},
    theme: {},
    slideMaster: {},
    slideLayout: {},
    slides: [],
    charts: [],
  };

  // ===== PRESENTATION PROPS =====
  console.log('Extracting presentation properties...');
  const presXml = await zip.file('ppt/presentation.xml').async('string');
  const sldSz = getTag(presXml, 'p:sldSz');
  if (sldSz) {
    result.presentation.slideWidth = emuToInches(getAttr(sldSz.full, 'cx'));
    result.presentation.slideHeight = emuToInches(getAttr(sldSz.full, 'cy'));
    result.presentation.slideWidthEmu = parseInt(getAttr(sldSz.full, 'cx') || 0);
    result.presentation.slideHeightEmu = parseInt(getAttr(sldSz.full, 'cy') || 0);
  }

  // ===== THEME =====
  console.log('Extracting theme...');
  const themeXml = await zip.file('ppt/theme/theme1.xml').async('string');

  // Color scheme
  const clrScheme = getNestedTag(themeXml, 'a:clrScheme');
  if (clrScheme) {
    const colors = {};
    const colorNames = [
      'dk1',
      'lt1',
      'dk2',
      'lt2',
      'accent1',
      'accent2',
      'accent3',
      'accent4',
      'accent5',
      'accent6',
      'hlink',
      'folHlink',
    ];
    for (const cn of colorNames) {
      const tag = getNestedTag(clrScheme, `a:${cn}`);
      if (tag) {
        const srgb = getTag(tag, 'a:srgbClr');
        const sysClr = getTag(tag, 'a:sysClr');
        if (srgb) {
          colors[cn] = { type: 'srgb', val: getAttr(srgb.full, 'val') };
        } else if (sysClr) {
          colors[cn] = {
            type: 'sys',
            val: getAttr(sysClr.full, 'val'),
            lastClr: getAttr(sysClr.full, 'lastClr'),
          };
        }
      }
    }
    result.theme.colorScheme = colors;
  }

  // Font scheme
  const fontScheme = getNestedTag(themeXml, 'a:fontScheme');
  if (fontScheme) {
    const majorFont = getNestedTag(fontScheme, 'a:majorFont');
    const minorFont = getNestedTag(fontScheme, 'a:minorFont');
    result.theme.fontScheme = {
      name: getAttr(fontScheme, 'name'),
      majorLatin: majorFont ? getAttr(getTag(majorFont, 'a:latin')?.full || '', 'typeface') : null,
      minorLatin: minorFont ? getAttr(getTag(minorFont, 'a:latin')?.full || '', 'typeface') : null,
    };
  }

  // ===== SLIDE MASTER =====
  console.log('Extracting slide master...');
  const masterXml = await zip.file('ppt/slideMasters/slideMaster1.xml').async('string');
  result.slideMaster = {
    elements: parseSlideElements(masterXml),
  };

  // ===== SLIDE LAYOUT =====
  console.log('Extracting slide layout...');
  const layoutXml = await zip.file('ppt/slideLayouts/slideLayout1.xml').async('string');
  result.slideLayout = {
    elements: parseSlideElements(layoutXml),
  };

  // ===== SLIDES (all 26) =====
  for (let i = 1; i <= 26; i++) {
    console.log(`Extracting slide ${i}/26...`);
    const slideXml = await zip.file(`ppt/slides/slide${i}.xml`).async('string');

    // Get slide name
    const cSld = getTag(slideXml, 'p:cSld');
    const slideName = cSld ? getAttr(`<tag ${cSld.attrs}>`, 'name') : null;

    // Parse relationships
    const rels = await parseSlideRels(zip, i);

    // Parse all elements
    const elements = parseSlideElements(slideXml);

    // Resolve chart references
    for (const el of elements) {
      if (el.type === 'chart' && el.chartRelId && rels[el.chartRelId]) {
        el.chartFile = rels[el.chartRelId].target;
      }
    }

    result.slides.push({
      slideNumber: i,
      name: slideName,
      elements,
      relationships: rels,
      elementCount: elements.length,
      elementTypes: [...new Set(elements.map((e) => e.type))],
    });
  }

  // ===== CHARTS =====
  for (let i = 1; i <= 6; i++) {
    console.log(`Extracting chart ${i}/6...`);
    const chartXml = await zip.file(`ppt/charts/chart${i}.xml`).async('string');
    const chart = parseChartXml(chartXml);
    chart.chartIndex = i;
    chart.fileName = `chart${i}.xml`;
    result.charts.push(chart);
  }

  // Write output
  const outputPath =
    '/home/xvasjack/xvasjack.github.io/backend/market-research/template-extracted.json';
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`\nDone! Output: ${outputPath}`);
  console.log(`Slides: ${result.slides.length}`);
  console.log(`Charts: ${result.charts.length}`);
  console.log(`Total elements: ${result.slides.reduce((s, sl) => s + sl.elementCount, 0)}`);

  // Summary per slide
  console.log('\n=== SLIDE SUMMARY ===');
  for (const sl of result.slides) {
    const types = sl.elements.map((e) => e.type).join(', ');
    console.log(`Slide ${sl.slideNumber} (${sl.name}): ${sl.elementCount} elements [${types}]`);
  }
}

extractTemplate().catch((err) => {
  console.error('Error:', err.message);
  console.error(err.stack);
});
