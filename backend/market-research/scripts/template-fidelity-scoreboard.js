#!/usr/bin/env node
'use strict';

/**
 * Template Fidelity Scoreboard
 *
 * Compares generated PPTX output against template contracts (template-patterns.json)
 * to measure geometry and style fidelity per slide.
 *
 * Reads PPTX files via JSZip, extracts shape/table/chart positions from the XML,
 * then checks each slide against the compiled contract for that slide's pattern.
 *
 * Output:
 *   reports/fidelity-scoreboard.json   — machine-readable results
 *   reports/fidelity-scoreboard.md     — human-readable report with root-cause analysis
 *
 * Usage:
 *   node scripts/template-fidelity-scoreboard.js [file1.pptx] [file2.pptx ...]
 *   (defaults to test-output.pptx and vietnam-output.pptx if no args)
 *
 * No paid API calls. Purely offline analysis.
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const BASE_DIR = path.join(__dirname, '..');
const REPORTS_DIR = path.join(BASE_DIR, 'reports');

// Load template contracts
const templatePatterns = require(path.join(BASE_DIR, 'template-patterns.json'));
const { compile, BLOCK_TEMPLATE_PATTERN_MAP, BLOCK_TEMPLATE_SLIDE_MAP } = require(
  path.join(BASE_DIR, 'template-contract-compiler')
);

// ---------------------------------------------------------------------------
// EMU conversion helpers (mirrored from extract-template-complete.js)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// XML parsing helpers (lightweight regex-based, no external dependency)
// ---------------------------------------------------------------------------

function getAttr(xml, attr) {
  const m = xml.match(new RegExp(`${attr}="([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

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

function getAllNestedTags(xml, tag) {
  const results = [];
  const openTag = `<${tag}`;
  const closeTag = `</${tag}>`;
  let searchStart = 0;

  while (searchStart < xml.length) {
    const idx = xml.indexOf(openTag, searchStart);
    if (idx === -1) break;

    if (!isExactTagMatch(xml, idx, openTag.length)) {
      searchStart = idx + 1;
      continue;
    }

    const tagEnd = xml.indexOf('>', idx);
    if (tagEnd === -1) break;
    if (xml[tagEnd - 1] === '/') {
      results.push(xml.substring(idx, tagEnd + 1));
      searchStart = tagEnd + 1;
      continue;
    }

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
      searchStart = idx + 1;
    }
  }

  return results;
}

function getNestedTag(xml, tag) {
  const results = getAllNestedTags(xml, tag);
  return results.length > 0 ? results[0] : null;
}

// ---------------------------------------------------------------------------
// PPTX slide geometry extraction
// ---------------------------------------------------------------------------

function parseXfrm(xml) {
  const xfrm = getNestedTag(xml, 'a:xfrm') || getNestedTag(xml, 'p:xfrm');
  if (!xfrm) return null;

  const offMatch = xfrm.match(/<a:off[^>]*>/);
  const extMatch = xfrm.match(/<a:ext[^>]*>/);
  if (!offMatch || !extMatch) return null;

  return {
    x: emuToInches(getAttr(offMatch[0], 'x')),
    y: emuToInches(getAttr(offMatch[0], 'y')),
    w: emuToInches(getAttr(extMatch[0], 'cx')),
    h: emuToInches(getAttr(extMatch[0], 'cy')),
  };
}

function extractFontInfo(xml) {
  const fonts = [];
  // Look for a:latin, a:ea, a:cs font refs
  const latinMatches = xml.matchAll(/<a:latin[^>]*typeface="([^"]*)"[^>]*>/gi);
  for (const m of latinMatches) {
    fonts.push({ type: 'latin', family: m[1] });
  }
  const eaMatches = xml.matchAll(/<a:ea[^>]*typeface="([^"]*)"[^>]*>/gi);
  for (const m of eaMatches) {
    fonts.push({ type: 'ea', family: m[1] });
  }
  return fonts;
}

function extractFontSizes(xml) {
  const sizes = [];
  const matches = xml.matchAll(/\bsz="(\d+)"/g);
  for (const m of matches) {
    sizes.push(hundredthsPtToPoints(m[1]));
  }
  return [...new Set(sizes.filter(Boolean))];
}

function extractColors(xml) {
  const colors = new Set();
  // srgbClr val="RRGGBB"
  const srgbMatches = xml.matchAll(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/g);
  for (const m of srgbMatches) {
    colors.add(m[1].toUpperCase());
  }
  // solidFill with srgbClr
  return [...colors];
}

function extractShapes(slideXml) {
  const shapes = [];
  const spTags = getAllNestedTags(slideXml, 'p:sp');
  for (const sp of spTags) {
    const nameMatch = sp.match(/<p:cNvPr[^>]*name="([^"]*)"/);
    const name = nameMatch ? nameMatch[1] : '';
    const pos = parseXfrm(sp);
    const fonts = extractFontInfo(sp);
    const fontSizes = extractFontSizes(sp);
    const colors = extractColors(sp);

    // Detect placeholder type (e.g., <p:ph type="title"/>)
    const phMatch = sp.match(/<p:ph[^>]*type="([^"]*)"/);
    const placeholderType = phMatch ? phMatch[1] : null;
    // Also detect placeholders without explicit type (default body placeholder)
    const isPlaceholder = sp.includes('<p:ph');

    // Detect shape type
    const prstGeom = sp.match(/<a:prstGeom\s+prst="([^"]*)"/);
    const shapeType = prstGeom ? prstGeom[1] : null;

    // Detect fill
    const solidFillMatch = sp.match(/<a:solidFill>\s*<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/);
    const fillColor = solidFillMatch ? solidFillMatch[1].toUpperCase() : null;

    // For placeholder shapes without explicit xfrm, use the template-expected position
    // (the shape inherits its geometry from the slide layout/master)
    let effectivePos = pos;
    if (!pos && placeholderType === 'title') {
      // Use the template title position as the inherited position
      const tp = templatePatterns.pptxPositions?.title;
      if (tp) {
        effectivePos = { x: tp.x, y: tp.y, w: tp.w, h: tp.h, inherited: true };
      }
    }

    shapes.push({
      name,
      position: effectivePos,
      fonts,
      fontSizes,
      colors,
      shapeType,
      fillColor,
      placeholderType,
      isPlaceholder,
    });
  }
  return shapes;
}

function extractTables(slideXml) {
  const tables = [];
  const tblTags = getAllNestedTags(slideXml, 'a:tbl');
  // Also get the graphicFrame wrapping each table for position
  const gfTags = getAllNestedTags(slideXml, 'p:graphicFrame');

  for (let i = 0; i < gfTags.length; i++) {
    const gf = gfTags[i];
    if (!gf.includes('<a:tbl')) continue;

    const pos = parseXfrm(gf);
    const tbl = getNestedTag(gf, 'a:tbl');
    if (!tbl) continue;

    const rows = getAllNestedTags(tbl, 'a:tr');
    const rowCount = rows.length;
    const colCount = rows.length > 0 ? getAllNestedTags(rows[0], 'a:tc').length : 0;

    // Extract table fonts and colors
    const fonts = extractFontInfo(tbl);
    const fontSizes = extractFontSizes(tbl);
    const colors = extractColors(tbl);

    // Check border styles
    const borderWidth = [];
    const borderMatches = tbl.matchAll(/<a:ln\s+w="(\d+)"/g);
    for (const m of borderMatches) {
      borderWidth.push(emuToPoints(m[1]));
    }

    tables.push({
      position: pos,
      rowCount,
      colCount,
      fonts,
      fontSizes,
      colors,
      borderWidths: [...new Set(borderWidth)],
    });
  }
  return tables;
}

function extractCharts(slideXml) {
  const charts = [];
  const gfTags = getAllNestedTags(slideXml, 'p:graphicFrame');

  for (const gf of gfTags) {
    // Charts are referenced via c:chart or r:id pointing to chart XML
    if (!gf.includes('chart') && !gf.includes('c:chart')) continue;
    if (gf.includes('<a:tbl')) continue; // Skip tables

    const pos = parseXfrm(gf);
    if (pos) {
      charts.push({ position: pos });
    }
  }
  return charts;
}

function extractLines(slideXml) {
  const lines = [];
  const cxnTags = getAllNestedTags(slideXml, 'p:cxnSp');
  for (const cxn of cxnTags) {
    const pos = parseXfrm(cxn);
    const colorMatch = cxn.match(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/);
    const widthMatch = cxn.match(/<a:ln\s+w="(\d+)"/);
    lines.push({
      position: pos,
      color: colorMatch ? colorMatch[1].toUpperCase() : null,
      width: widthMatch ? emuToPoints(widthMatch[1]) : null,
    });
  }
  return lines;
}

function extractSlideTitle(shapes) {
  // 1. Look for explicit title placeholder (<p:ph type="title"/>)
  const phTitle = shapes.find((s) => s.placeholderType === 'title');
  if (phTitle) return phTitle;

  // 2. Look for shapes named "Title*" with position near top
  const namedTitle = shapes.find((s) => /^title/i.test(s.name) && s.position && s.position.y < 1.3);
  if (namedTitle) return namedTitle;

  // 3. Look for shapes named "Title*" even without position (inherited from layout)
  const namedTitleNoPos = shapes.find((s) => /^title/i.test(s.name));
  if (namedTitleNoPos) return namedTitleNoPos;

  return null;
}

function extractTexts(slideXml) {
  return (slideXml.match(/<a:t>([^<]*)<\/a:t>/g) || [])
    .map((m) => (m.match(/<a:t>([^<]*)<\/a:t>/) || [])[1]?.trim())
    .filter(Boolean);
}

async function extractSlideGeometry(zip, slideNum) {
  const file = zip.file(`ppt/slides/slide${slideNum}.xml`);
  if (!file) return null;

  const xml = await file.async('string');
  const shapes = extractShapes(xml);
  const tables = extractTables(xml);
  const charts = extractCharts(xml);
  const lines = extractLines(xml);
  const texts = extractTexts(xml);
  const titleShape = extractSlideTitle(shapes);

  // Collect all font families used
  const allFonts = new Set();
  for (const s of shapes) {
    for (const f of s.fonts) {
      if (f.family && !f.family.startsWith('+')) allFonts.add(f.family);
    }
  }
  for (const t of tables) {
    for (const f of t.fonts) {
      if (f.family && !f.family.startsWith('+')) allFonts.add(f.family);
    }
  }

  // Collect all font sizes used
  const allFontSizes = new Set();
  for (const s of shapes) {
    for (const sz of s.fontSizes) allFontSizes.add(sz);
  }
  for (const t of tables) {
    for (const sz of t.fontSizes) allFontSizes.add(sz);
  }

  // Collect all colors used
  const allColors = new Set();
  for (const s of shapes) {
    for (const c of s.colors) allColors.add(c);
  }
  for (const t of tables) {
    for (const c of t.colors) allColors.add(c);
  }

  return {
    slideNum,
    shapes,
    tables,
    charts,
    lines,
    texts,
    titleShape,
    fonts: [...allFonts],
    fontSizes: [...allFontSizes].sort((a, b) => a - b),
    colors: [...allColors],
    textContent: texts.join(' '),
    charCount: texts.join('').length,
  };
}

// ---------------------------------------------------------------------------
// Fidelity comparison logic
// ---------------------------------------------------------------------------

const POSITION_TOLERANCE_INCHES = 0.15; // Allow 0.15" deviation
const SIZE_TOLERANCE_INCHES = 0.3; // Allow 0.3" deviation for w/h

function positionDelta(actual, expected) {
  if (!actual || !expected) return null;
  const result = {
    dx: Math.abs((actual.x || 0) - (expected.x || 0)),
    dy: Math.abs((actual.y || 0) - (expected.y || 0)),
  };
  // Only compute w/h deltas if the expected value is defined
  result.dw = expected.w != null ? Math.abs((actual.w || 0) - expected.w) : 0;
  result.dh = expected.h != null ? Math.abs((actual.h || 0) - expected.h) : 0;
  result.wChecked = expected.w != null;
  result.hChecked = expected.h != null;
  return result;
}

function positionPass(delta) {
  if (!delta) return false;
  const posOk = delta.dx <= POSITION_TOLERANCE_INCHES && delta.dy <= POSITION_TOLERANCE_INCHES;
  const wOk = !delta.wChecked || delta.dw <= SIZE_TOLERANCE_INCHES;
  const hOk = !delta.hChecked || delta.dh <= SIZE_TOLERANCE_INCHES;
  return posOk && wOk && hOk;
}

function findClosestShape(shapes, expectedPos) {
  if (!shapes || shapes.length === 0 || !expectedPos) return null;
  let best = null;
  let bestDist = Infinity;
  for (const s of shapes) {
    if (!s.position) continue;
    const dist =
      Math.abs(s.position.x - (expectedPos.x || 0)) + Math.abs(s.position.y - (expectedPos.y || 0));
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

function findClosestTable(tables, expectedPos) {
  if (!tables || tables.length === 0 || !expectedPos) return null;
  let best = null;
  let bestDist = Infinity;
  for (const t of tables) {
    if (!t.position) continue;
    const dist =
      Math.abs(t.position.x - (expectedPos.x || 0)) + Math.abs(t.position.y - (expectedPos.y || 0));
    if (dist < bestDist) {
      bestDist = dist;
      best = t;
    }
  }
  return best;
}

/**
 * Score a single slide against its template contract.
 *
 * Returns:
 *  - geometryChecks: array of { check, pass, expected, actual, delta }
 *  - styleChecks: array of { check, pass, expected, actual }
 *  - structuralChecks: array of { check, pass, expected, actual }
 *  - score: 0-100 overall fidelity score
 */
function scoreSlide(slideGeometry, patternKey, patternContract) {
  const checks = {
    geometry: [],
    style: [],
    structural: [],
  };

  if (!slideGeometry || !patternContract) {
    return { checks, score: 0, slideNum: slideGeometry?.slideNum, patternKey };
  }

  const elements = patternContract.elementConstraints || {};
  const tp = templatePatterns;

  // ------- Structural checks -------

  // Check if title shape exists (most slides should have one)
  if (patternKey !== 'cover' && patternKey !== 'section_divider') {
    const hasTitle = slideGeometry.titleShape !== null;
    checks.structural.push({
      check: 'title_shape_exists',
      pass: hasTitle,
      expected: true,
      actual: hasTitle,
    });
  }

  // Check if slide has content (not empty)
  const hasContent = slideGeometry.charCount > 10;
  if (patternKey !== 'section_divider') {
    checks.structural.push({
      check: 'has_content',
      pass: hasContent,
      expected: true,
      actual: hasContent,
      detail: `${slideGeometry.charCount} chars`,
    });
  }

  // Check table presence for table-type patterns
  const patternGeomType = patternContract.geometryType;
  if (patternGeomType === 'table') {
    const hasTable = slideGeometry.tables.length > 0;
    checks.structural.push({
      check: 'table_exists',
      pass: hasTable,
      expected: true,
      actual: hasTable,
      detail: `${slideGeometry.tables.length} tables found`,
    });
  }

  // Check chart presence for chart-type patterns
  if (patternGeomType === 'chart') {
    const hasChart = slideGeometry.charts.length > 0;
    checks.structural.push({
      check: 'chart_exists',
      pass: hasChart,
      expected: true,
      actual: hasChart,
      detail: `${slideGeometry.charts.length} charts found`,
    });
  }

  // ------- Geometry checks -------

  // Check title bar position
  if (elements.titleBar) {
    const expected = {
      x: elements.titleBar.x,
      y: elements.titleBar.y,
      w: elements.titleBar.w,
      h: elements.titleBar.h,
    };
    const titleShape = slideGeometry.titleShape;
    if (titleShape && titleShape.position) {
      if (titleShape.position.inherited) {
        // Inherited from layout -- position matches template by definition
        checks.geometry.push({
          check: 'titleBar_position',
          pass: true,
          expected,
          actual: titleShape.position,
          detail: 'inherited from slide layout (matches template)',
        });
      } else {
        const delta = positionDelta(titleShape.position, expected);
        checks.geometry.push({
          check: 'titleBar_position',
          pass: positionPass(delta),
          expected,
          actual: titleShape.position,
          delta,
        });
      }
    } else if (titleShape) {
      // Title shape exists but has no position at all (rare edge case)
      checks.geometry.push({
        check: 'titleBar_position',
        pass: true,
        expected,
        actual: null,
        detail: 'title shape exists as placeholder (position inherited from layout)',
      });
    } else {
      checks.geometry.push({
        check: 'titleBar_position',
        pass: false,
        expected,
        actual: null,
        detail: 'title shape not found',
      });
    }
  }

  // Check table position
  if (elements.table && slideGeometry.tables.length > 0) {
    const expected = {
      x: elements.table.x,
      y: elements.table.y,
      w: elements.table.w,
      h: elements.table.h,
    };
    const closestTable = findClosestTable(slideGeometry.tables, expected);
    if (closestTable && closestTable.position) {
      const delta = positionDelta(closestTable.position, expected);
      checks.geometry.push({
        check: 'table_position',
        pass: positionPass(delta),
        expected,
        actual: closestTable.position,
        delta,
      });
    }
  }

  // Check chart position
  if (elements.chart && slideGeometry.charts.length > 0) {
    const expected = {
      x: elements.chart.x,
      y: elements.chart.y,
      w: elements.chart.w,
      h: elements.chart.h,
    };
    const closestChart = slideGeometry.charts[0];
    if (closestChart && closestChart.position) {
      const delta = positionDelta(closestChart.position, expected);
      checks.geometry.push({
        check: 'chart_position',
        pass: positionPass(delta),
        expected,
        actual: closestChart.position,
        delta,
      });
    }
  }

  // Check chartLeft/chartRight for dual chart patterns
  if (elements.chartLeft) {
    const expected = {
      x: elements.chartLeft.x,
      y: elements.chartLeft.y,
      w: elements.chartLeft.w,
      h: elements.chartLeft.h,
    };
    if (slideGeometry.charts.length > 0) {
      const chart = slideGeometry.charts[0];
      if (chart && chart.position) {
        const delta = positionDelta(chart.position, expected);
        checks.geometry.push({
          check: 'chartLeft_position',
          pass: positionPass(delta),
          expected,
          actual: chart.position,
          delta,
        });
      }
    }
  }

  if (elements.chartRight) {
    const expected = {
      x: elements.chartRight.x,
      y: elements.chartRight.y,
      w: elements.chartRight.w,
      h: elements.chartRight.h,
    };
    if (slideGeometry.charts.length > 1) {
      const chart = slideGeometry.charts[1];
      if (chart && chart.position) {
        const delta = positionDelta(chart.position, expected);
        checks.geometry.push({
          check: 'chartRight_position',
          pass: positionPass(delta),
          expected,
          actual: chart.position,
          delta,
        });
      }
    }
  }

  // Check source bar position
  if (elements.sourceBar) {
    const expected = {
      x: elements.sourceBar.x,
      y: elements.sourceBar.y,
      w: elements.sourceBar.w,
      h: elements.sourceBar.h,
    };
    // Source bar is typically a text shape near the bottom
    const sourceShape = slideGeometry.shapes.find(
      (s) => s.position && s.position.y > 6.0 && s.position.y < 7.5
    );
    if (sourceShape && sourceShape.position) {
      const delta = positionDelta(sourceShape.position, expected);
      checks.geometry.push({
        check: 'sourceBar_position',
        pass: positionPass(delta),
        expected,
        actual: sourceShape.position,
        delta,
      });
    }
  }

  // ------- Style checks -------

  // Check fonts used (should be Segoe UI per template)
  const expectedFont = tp.style?.fonts?.majorLatin || 'Segoe UI';
  const actualFonts = slideGeometry.fonts;
  const usesCorrectFont = actualFonts.length === 0 || actualFonts.some((f) => f === expectedFont);
  checks.style.push({
    check: 'font_family',
    pass: usesCorrectFont,
    expected: expectedFont,
    actual: actualFonts.length > 0 ? actualFonts.join(', ') : '(theme default)',
  });

  // Check title font size
  if (patternKey !== 'cover' && patternKey !== 'section_divider' && slideGeometry.titleShape) {
    const expectedTitleSize = tp.style?.fonts?.title?.size || 20;
    const titleFontSizes = slideGeometry.titleShape.fontSizes;
    const hasTitleSize =
      titleFontSizes.length === 0 ||
      titleFontSizes.some((sz) => Math.abs(sz - expectedTitleSize) <= 2);
    checks.style.push({
      check: 'title_font_size',
      pass: hasTitleSize,
      expected: expectedTitleSize,
      actual: titleFontSizes.length > 0 ? titleFontSizes.join(', ') : '(default)',
    });
  }

  // Check table font sizes if applicable
  if (patternGeomType === 'table' && slideGeometry.tables.length > 0) {
    const expectedBodySize = tp.style?.fonts?.tableBody?.size || 14;
    const table = slideGeometry.tables[0];
    const tableFontSizes = table.fontSizes;
    // Allow some flexibility: expected +/- 4pt
    const hasCorrectSize =
      tableFontSizes.length === 0 ||
      tableFontSizes.some((sz) => Math.abs(sz - expectedBodySize) <= 4);
    checks.style.push({
      check: 'table_body_font_size',
      pass: hasCorrectSize,
      expected: expectedBodySize,
      actual: tableFontSizes.length > 0 ? tableFontSizes.join(', ') : '(default)',
    });
  }

  // Check header line colors (should be 293F55)
  const expectedLineColor = tp.style?.headerLines?.top?.color || '293F55';
  const headerLines = slideGeometry.lines.filter(
    (l) => l.position && l.position.y >= 0.9 && l.position.y <= 1.2
  );
  if (headerLines.length > 0) {
    const hasCorrectColor = headerLines.some(
      (l) => l.color && l.color.toUpperCase() === expectedLineColor.toUpperCase()
    );
    checks.style.push({
      check: 'header_line_color',
      pass: hasCorrectColor,
      expected: expectedLineColor,
      actual: headerLines.map((l) => l.color || 'unknown').join(', '),
    });
  }

  // Check table border style
  if (patternGeomType === 'table' && slideGeometry.tables.length > 0) {
    const expectedBorderWidth = tp.style?.table?.borderWidth || 1;
    const table = slideGeometry.tables[0];
    if (table.borderWidths.length > 0) {
      const hasCorrectBorder = table.borderWidths.some(
        (bw) => Math.abs(bw - expectedBorderWidth) <= 1
      );
      checks.style.push({
        check: 'table_border_width',
        pass: hasCorrectBorder,
        expected: expectedBorderWidth,
        actual: table.borderWidths.join(', '),
      });
    }
  }

  // ------- Compute overall score -------
  const allChecks = [...checks.geometry, ...checks.style, ...checks.structural];
  const totalChecks = allChecks.length;
  const passedChecks = allChecks.filter((c) => c.pass).length;
  const score = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 100;

  return {
    slideNum: slideGeometry.slideNum,
    patternKey,
    checks,
    totalChecks,
    passedChecks,
    failedChecks: totalChecks - passedChecks,
    score,
  };
}

// ---------------------------------------------------------------------------
// Slide-to-pattern classification
// ---------------------------------------------------------------------------

/**
 * Classify what pattern a slide likely represents based on its content and geometry.
 * Uses heuristics: text content, element counts, position in deck.
 */
function classifySlide(slideGeometry, slideNum, totalSlides) {
  if (!slideGeometry) return { patternKey: 'unknown', confidence: 0 };

  const text = (slideGeometry.textContent || '').toLowerCase();
  const charCount = slideGeometry.charCount;
  const tableCount = slideGeometry.tables.length;
  const chartCount = slideGeometry.charts.length;

  // Slide 1 is almost always cover
  if (slideNum === 1) return { patternKey: 'cover', confidence: 0.95 };

  // TOC detection
  if (text.includes('table of contents')) {
    return { patternKey: 'toc_divider', confidence: 0.9 };
  }

  // Section divider detection (sparse text, no tables/charts)
  if (charCount < 80 && tableCount === 0 && chartCount === 0) {
    const words = text.trim().split(/\s+/);
    if (words.length <= 6) {
      return { patternKey: 'section_divider', confidence: 0.7 };
    }
  }

  // Executive summary detection
  if (text.includes('executive summary')) {
    return { patternKey: 'executive_summary', confidence: 0.85 };
  }

  // Country overview
  if (text.includes('country overview') || text.includes('country snapshot')) {
    return { patternKey: 'country_overview', confidence: 0.8 };
  }

  // Chart-based slides
  if (chartCount > 0 && tableCount === 0) {
    if (chartCount >= 2) return { patternKey: 'chart_callout_dual', confidence: 0.6 };
    return { patternKey: 'chart_with_grid', confidence: 0.6 };
  }

  // Table-based slides with regulatory/policy content
  if (tableCount > 0 && chartCount === 0) {
    if (
      text.includes('regulation') ||
      text.includes('policy') ||
      text.includes('incentive') ||
      text.includes('restriction')
    ) {
      return { patternKey: 'regulatory_table', confidence: 0.7 };
    }
    if (text.includes('competitor') || text.includes('player') || text.includes('company')) {
      return { patternKey: 'company_comparison', confidence: 0.65 };
    }
    if (text.includes('case study') || text.includes('case:')) {
      return { patternKey: 'case_study_rows', confidence: 0.65 };
    }
    if (text.includes('glossary') || text.includes('definition')) {
      return { patternKey: 'glossary', confidence: 0.7 };
    }
    // Default table slide
    return { patternKey: 'regulatory_table', confidence: 0.5 };
  }

  // Mixed chart + table
  if (chartCount > 0 && tableCount > 0) {
    return { patternKey: 'chart_insight_panels', confidence: 0.5 };
  }

  return { patternKey: 'regulatory_table', confidence: 0.3 };
}

// ---------------------------------------------------------------------------
// Main scoring pipeline
// ---------------------------------------------------------------------------

async function scorePptx(filePath) {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const fileName = path.basename(filePath);

  // Count slides
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)[1]);
      const numB = parseInt(b.match(/slide(\d+)/)[1]);
      return numA - numB;
    });
  const totalSlides = slideFiles.length;

  // Compile template contracts
  const compiled = compile();
  const patternContracts = compiled.patternContracts;

  // Extract geometry from each slide
  const slideResults = [];
  for (let i = 0; i < totalSlides; i++) {
    const slideNum = i + 1;
    const geometry = await extractSlideGeometry(zip, slideNum);
    if (!geometry) continue;

    // Classify slide to find its pattern
    const classification = classifySlide(geometry, slideNum, totalSlides);
    const patternKey = classification.patternKey;
    const contract = patternContracts[patternKey] || null;

    // Score against contract
    const result = scoreSlide(geometry, patternKey, contract);
    result.classification = classification;
    result.fileName = fileName;

    slideResults.push(result);
  }

  // Compute file-level summary
  const totalScore =
    slideResults.length > 0
      ? Math.round(slideResults.reduce((sum, r) => sum + r.score, 0) / slideResults.length)
      : 0;

  const passCount = slideResults.filter((r) => r.score >= 70).length;
  const failCount = slideResults.filter((r) => r.score < 70).length;

  // Find top deltas (worst geometry deviations)
  const allDeltas = [];
  for (const result of slideResults) {
    for (const check of result.checks.geometry) {
      if (check.delta) {
        const maxDev = Math.max(check.delta.dx, check.delta.dy, check.delta.dw, check.delta.dh);
        allDeltas.push({
          slideNum: result.slideNum,
          patternKey: result.patternKey,
          check: check.check,
          maxDeviation: maxDev,
          delta: check.delta,
          pass: check.pass,
        });
      }
    }
  }
  allDeltas.sort((a, b) => b.maxDeviation - a.maxDeviation);
  const topDeltas = allDeltas.slice(0, 10);

  // Find all failing checks
  const allFailures = [];
  for (const result of slideResults) {
    const allChecks = [
      ...result.checks.geometry,
      ...result.checks.style,
      ...result.checks.structural,
    ];
    for (const check of allChecks) {
      if (!check.pass) {
        allFailures.push({
          slideNum: result.slideNum,
          patternKey: result.patternKey,
          category: result.checks.geometry.includes(check)
            ? 'geometry'
            : result.checks.style.includes(check)
              ? 'style'
              : 'structural',
          check: check.check,
          expected: check.expected,
          actual: check.actual,
          detail: check.detail,
        });
      }
    }
  }

  return {
    fileName,
    filePath,
    totalSlides,
    totalScore,
    passCount,
    failCount,
    passRate: totalSlides > 0 ? Math.round((passCount / totalSlides) * 100) : 0,
    slideResults,
    topDeltas,
    allFailures,
  };
}

// ---------------------------------------------------------------------------
// Root cause analysis
// ---------------------------------------------------------------------------

function analyzeRootCauses(results) {
  const causes = [];
  const failureCounts = {};

  for (const fileResult of results) {
    for (const failure of fileResult.allFailures) {
      const key = `${failure.category}:${failure.check}`;
      if (!failureCounts[key]) {
        failureCounts[key] = {
          category: failure.category,
          check: failure.check,
          count: 0,
          slides: [],
          examples: [],
        };
      }
      failureCounts[key].count++;
      failureCounts[key].slides.push(`${fileResult.fileName}:slide${failure.slideNum}`);
      if (failureCounts[key].examples.length < 3) {
        failureCounts[key].examples.push({
          slide: failure.slideNum,
          file: fileResult.fileName,
          expected: failure.expected,
          actual: failure.actual,
        });
      }
    }
  }

  // Sort by frequency
  const sorted = Object.values(failureCounts).sort((a, b) => b.count - a.count);

  for (const item of sorted) {
    let rootCause = '';
    let remediation = '';

    if (item.check === 'font_family') {
      rootCause =
        'Slide uses a font family not matching the template spec (Segoe UI). This usually means pptxgenjs defaults or a hardcoded font override in ppt-single-country.js or ppt-utils.js.';
      remediation =
        'Ensure all addText/addTable calls use fontFace from template-patterns.json style.fonts.majorLatin.';
    } else if (item.check === 'title_font_size') {
      rootCause =
        'Title text uses a font size different from template (20pt). May be a hardcoded fontSize in the title rendering code.';
      remediation =
        'Use template-patterns.json style.fonts.title.size instead of hardcoded values.';
    } else if (item.check === 'table_body_font_size') {
      rootCause =
        'Table body cells use a font size different from template (14pt). Font size may be dynamically adjusted for content overflow.';
      remediation =
        'Set default table body fontSize from template-patterns.json style.fonts.tableBody.size. Allow autoFit to shrink but not grow.';
    } else if (item.check === 'titleBar_position') {
      rootCause =
        'Title bar position deviates from template. The title shape x/y/w/h does not match pptxPositions.title from template-patterns.json.';
      remediation =
        'Use TEMPLATE.title coordinates from ppt-utils.js (sourced from template-patterns.json) for all title shapes.';
    } else if (item.check === 'table_position') {
      rootCause =
        'Table position deviates from the pattern contract. The table x/y/w may be hardcoded instead of sourced from the pattern elements.';
      remediation =
        'Use pattern.elements.table position from template-patterns.json for table placement.';
    } else if (item.check === 'chart_position') {
      rootCause =
        'Chart position deviates from the pattern contract. Chart x/y/w/h may be hardcoded.';
      remediation =
        'Source chart dimensions from pattern.elements.chart in template-patterns.json.';
    } else if (item.check === 'has_content') {
      rootCause =
        'Slide has very little or no text content. This may be a rendering failure, content truncation, or a slide that was added as a placeholder but never populated.';
      remediation =
        'Check the block rendering pipeline for this slide type. Ensure research data is being passed through and not silently dropped.';
    } else if (item.check === 'table_exists') {
      rootCause =
        'A slide that should contain a table has no table element. The table rendering code may have skipped this slide due to missing data.';
      remediation =
        'Ensure the data pipeline provides table data for all table-type blocks. Check for null/undefined guards that silently skip rendering.';
    } else if (item.check === 'chart_exists') {
      rootCause =
        'A slide that should contain a chart has no chart element. Chart rendering may have failed or been skipped due to data format issues.';
      remediation =
        'Check chart data normalization. Ensure chart-data-normalizer.js produces valid data for the chart renderer.';
    } else if (item.check === 'header_line_color') {
      rootCause =
        'Header line color does not match template (293F55). May be using a different color constant.';
      remediation =
        'Use template-patterns.json style.headerLines.top.color for header line rendering.';
    } else if (item.check === 'table_border_width') {
      rootCause = 'Table border width deviates from template spec.';
      remediation =
        'Use template-patterns.json style.table.borderWidth for table border rendering.';
    } else if (item.check === 'sourceBar_position') {
      rootCause =
        'Source bar position deviates from template. The source attribution text box is not placed at the correct y-position.';
      remediation =
        'Use TEMPLATE.sourceBar coordinates from ppt-utils.js for source bar placement.';
    } else if (item.check === 'title_shape_exists') {
      rootCause =
        'Content slide is missing a title shape. The title may not be rendered, or may be rendered as a plain text box without the expected name attribute.';
      remediation =
        'Ensure every content slide includes a title shape with position matching pptxPositions.title.';
    } else {
      rootCause = `Check "${item.check}" failed on ${item.count} slide(s). Review the rendering code for this element type.`;
      remediation =
        'Compare the rendering code against template-patterns.json for the specific element.';
    }

    causes.push({
      check: item.check,
      category: item.category,
      frequency: item.count,
      affectedSlides: item.slides.slice(0, 10),
      rootCause,
      remediation,
      examples: item.examples,
    });
  }

  return causes;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateJsonReport(results, rootCauses) {
  const overallScore =
    results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.totalScore, 0) / results.length)
      : 0;

  const totalSlides = results.reduce((sum, r) => sum + r.totalSlides, 0);
  const totalPass = results.reduce((sum, r) => sum + r.passCount, 0);
  const totalFail = results.reduce((sum, r) => sum + r.failCount, 0);

  return {
    reportType: 'template_fidelity_scoreboard',
    generatedAt: new Date().toISOString(),
    contractVersion: '1.0.0',
    templateSource: templatePatterns._meta?.source || 'unknown',
    tolerances: {
      positionInches: POSITION_TOLERANCE_INCHES,
      sizeInches: SIZE_TOLERANCE_INCHES,
    },
    overall: {
      score: overallScore,
      totalSlides,
      passCount: totalPass,
      failCount: totalFail,
      passRate: totalSlides > 0 ? Math.round((totalPass / totalSlides) * 100) : 0,
      filesAnalyzed: results.length,
    },
    files: results.map((r) => ({
      fileName: r.fileName,
      totalSlides: r.totalSlides,
      score: r.totalScore,
      passCount: r.passCount,
      failCount: r.failCount,
      passRate: r.passRate,
      topDeltas: r.topDeltas,
      slideResults: r.slideResults.map((sr) => ({
        slideNum: sr.slideNum,
        patternKey: sr.patternKey,
        classification: sr.classification,
        score: sr.score,
        totalChecks: sr.totalChecks,
        passedChecks: sr.passedChecks,
        failedChecks: sr.failedChecks,
        failures: [
          ...sr.checks.geometry.filter((c) => !c.pass),
          ...sr.checks.style.filter((c) => !c.pass),
          ...sr.checks.structural.filter((c) => !c.pass),
        ],
      })),
    })),
    rootCauses,
  };
}

function generateMarkdownReport(results, rootCauses) {
  const overallScore =
    results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.totalScore, 0) / results.length)
      : 0;

  const totalSlides = results.reduce((sum, r) => sum + r.totalSlides, 0);
  const totalPass = results.reduce((sum, r) => sum + r.passCount, 0);
  const totalFail = results.reduce((sum, r) => sum + r.failCount, 0);

  let md = '';

  md += '# Template Fidelity Scoreboard\n\n';
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Template: ${templatePatterns._meta?.source || 'unknown'}\n`;
  md += `Contract Version: 1.0.0\n`;
  md += `Position Tolerance: ${POSITION_TOLERANCE_INCHES}" | Size Tolerance: ${SIZE_TOLERANCE_INCHES}"\n\n`;

  // Overall summary
  md += '## Overall Summary\n\n';
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Overall Score | **${overallScore}/100** |\n`;
  md += `| Total Slides | ${totalSlides} |\n`;
  md += `| Pass (>=70) | ${totalPass} |\n`;
  md += `| Fail (<70) | ${totalFail} |\n`;
  md += `| Pass Rate | ${totalSlides > 0 ? Math.round((totalPass / totalSlides) * 100) : 0}% |\n`;
  md += `| Files Analyzed | ${results.length} |\n\n`;

  // Per-file results
  for (const fileResult of results) {
    md += `## ${fileResult.fileName}\n\n`;
    md += `Score: **${fileResult.totalScore}/100** | Slides: ${fileResult.totalSlides} | Pass: ${fileResult.passCount} | Fail: ${fileResult.failCount}\n\n`;

    // Slide scoreboard table
    md += '### Per-Slide Scores\n\n';
    md += '| Slide | Pattern | Score | Checks | Pass | Fail | Status |\n';
    md += '|-------|---------|-------|--------|------|------|--------|\n';
    for (const sr of fileResult.slideResults) {
      const status = sr.score >= 70 ? 'PASS' : 'FAIL';
      md += `| ${sr.slideNum} | ${sr.patternKey} | ${sr.score} | ${sr.totalChecks} | ${sr.passedChecks} | ${sr.failedChecks} | ${status} |\n`;
    }
    md += '\n';

    // Top deltas
    if (fileResult.topDeltas.length > 0) {
      md += '### Top Geometry Deltas\n\n';
      md += '| Slide | Pattern | Check | Max Dev (in) | dx | dy | dw | dh | Pass |\n';
      md += '|-------|---------|-------|-------------|----|----|----|----|------|\n';
      for (const d of fileResult.topDeltas.slice(0, 10)) {
        md += `| ${d.slideNum} | ${d.patternKey} | ${d.check} | ${d.maxDeviation.toFixed(3)} | ${d.delta.dx.toFixed(3)} | ${d.delta.dy.toFixed(3)} | ${d.delta.dw.toFixed(3)} | ${d.delta.dh.toFixed(3)} | ${d.pass ? 'YES' : 'NO'} |\n`;
      }
      md += '\n';
    }

    // Failing slides detail
    const failingSlides = fileResult.slideResults.filter((sr) => sr.score < 70);
    if (failingSlides.length > 0) {
      md += '### Failing Slides Detail\n\n';
      for (const sr of failingSlides) {
        md += `#### Slide ${sr.slideNum} (${sr.patternKey}) - Score: ${sr.score}/100\n\n`;
        const failures = [
          ...sr.checks.geometry.filter((c) => !c.pass),
          ...sr.checks.style.filter((c) => !c.pass),
          ...sr.checks.structural.filter((c) => !c.pass),
        ];
        if (failures.length > 0) {
          md += '| Check | Expected | Actual |\n';
          md += '|-------|----------|--------|\n';
          for (const f of failures) {
            const expected =
              typeof f.expected === 'object' ? JSON.stringify(f.expected) : String(f.expected);
            const actual =
              typeof f.actual === 'object'
                ? JSON.stringify(f.actual)
                : String(f.actual ?? f.detail ?? 'N/A');
            md += `| ${f.check} | ${expected.substring(0, 60)} | ${actual.substring(0, 60)} |\n`;
          }
          md += '\n';
        }
      }
    }
  }

  // Root cause analysis
  md += '## Root Cause Analysis\n\n';
  if (rootCauses.length === 0) {
    md += 'No failures detected. All slides pass fidelity checks.\n\n';
  } else {
    for (const cause of rootCauses) {
      md += `### ${cause.category}: ${cause.check} (${cause.frequency} occurrences)\n\n`;
      md += `**Root Cause:** ${cause.rootCause}\n\n`;
      md += `**Remediation:** ${cause.remediation}\n\n`;
      md += `**Affected Slides:** ${cause.affectedSlides.slice(0, 5).join(', ')}`;
      if (cause.affectedSlides.length > 5) {
        md += ` (+${cause.affectedSlides.length - 5} more)`;
      }
      md += '\n\n';
    }
  }

  // Coverage summary
  md += '## Pattern Coverage\n\n';
  const patternsSeen = new Set();
  for (const fileResult of results) {
    for (const sr of fileResult.slideResults) {
      patternsSeen.add(sr.patternKey);
    }
  }
  const allPatterns = Object.keys(templatePatterns.patterns || {});
  md += `| Pattern | In Template | Seen in Output |\n`;
  md += `|---------|-------------|----------------|\n`;
  for (const p of allPatterns) {
    const seen = patternsSeen.has(p) ? 'Yes' : 'No';
    md += `| ${p} | Yes | ${seen} |\n`;
  }
  md += `\nCoverage: ${patternsSeen.size}/${allPatterns.length} patterns (${Math.round((patternsSeen.size / allPatterns.length) * 100)}%)\n\n`;

  return md;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  let files = process.argv.slice(2);

  // Default files if none specified
  if (files.length === 0) {
    const defaults = ['test-output.pptx', 'vietnam-output.pptx'];
    files = defaults.map((f) => path.join(BASE_DIR, f)).filter((f) => fs.existsSync(f));
    if (files.length === 0) {
      console.error('No PPTX files found. Specify file paths as arguments.');
      process.exit(1);
    }
  }

  console.log(`Template Fidelity Scoreboard`);
  console.log(`Analyzing ${files.length} file(s)...\n`);

  const results = [];
  for (const filePath of files) {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      console.error(`File not found: ${absPath}`);
      continue;
    }
    console.log(`  Scoring: ${path.basename(absPath)}...`);
    const result = await scorePptx(absPath);
    results.push(result);
    console.log(
      `    Score: ${result.totalScore}/100 | Slides: ${result.totalSlides} | Pass: ${result.passCount} | Fail: ${result.failCount}`
    );
  }

  // Root cause analysis
  const rootCauses = analyzeRootCauses(results);

  // Generate reports
  const jsonReport = generateJsonReport(results, rootCauses);
  const mdReport = generateMarkdownReport(results, rootCauses);

  // Ensure reports directory exists
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const jsonPath = path.join(REPORTS_DIR, 'fidelity-scoreboard.json');
  const mdPath = path.join(REPORTS_DIR, 'fidelity-scoreboard.md');

  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
  fs.writeFileSync(mdPath, mdReport);

  console.log(`\nReports written:`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${mdPath}`);

  // Print summary
  console.log(`\n=== SCOREBOARD SUMMARY ===`);
  console.log(`Overall Score: ${jsonReport.overall.score}/100`);
  console.log(`Pass Rate: ${jsonReport.overall.passRate}%`);
  console.log(`Total Slides: ${jsonReport.overall.totalSlides}`);

  if (rootCauses.length > 0) {
    console.log(`\nTop Failure Modes:`);
    for (const cause of rootCauses.slice(0, 5)) {
      console.log(`  [${cause.category}] ${cause.check}: ${cause.frequency} occurrences`);
    }
  }

  // Exit with code based on score
  process.exit(jsonReport.overall.score >= 50 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
