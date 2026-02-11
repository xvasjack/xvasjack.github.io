/**
 * PPTX Validator - Read and validate PPTX files using JSZip
 * Run: node pptx-validator.js <file.pptx> [--validate]
 */
const JSZip = require('jszip');
const fs = require('fs');

async function readPPTX(input) {
  const buffer = typeof input === 'string' ? fs.readFileSync(input) : input;
  return { zip: await JSZip.loadAsync(buffer), fileSize: buffer.length };
}

function findInvalidXmlCharIndex(text) {
  if (typeof text !== 'string' || text.length === 0) return -1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    // Invalid XML 1.0 control chars (allow tab/newline/carriage return).
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      return i;
    }

    // Unpaired high surrogate.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return i;
      i++; // Skip valid surrogate pair.
      continue;
    }

    // Unpaired low surrogate.
    if (code >= 0xdc00 && code <= 0xdfff) {
      return i;
    }
  }
  return -1;
}

async function scanXmlIntegrity(zip) {
  const xmlFiles = Object.keys(zip.files).filter((f) => /\.xml$/i.test(f));
  const issues = [];

  for (const filePath of xmlFiles) {
    const file = zip.file(filePath);
    if (!file) continue;
    const xml = await file.async('string');
    const badIdx = findInvalidXmlCharIndex(xml);
    if (badIdx >= 0) {
      issues.push({ file: filePath, index: badIdx });
      if (issues.length >= 25) break;
    }
  }

  return { issueCount: issues.length, issues };
}

function countSlides(zip) {
  return Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length;
}

function extractTextFromXML(xml) {
  return (xml.match(/<a:t>([^<]*)<\/a:t>/g) || [])
    .map((m) => (m.match(/<a:t>([^<]*)<\/a:t>/) || [])[1]?.trim())
    .filter(Boolean);
}

async function extractSlideText(zip, slideNum) {
  const file = zip.file(`ppt/slides/slide${slideNum}.xml`);
  if (!file) return { slideNum, exists: false, texts: [], fullText: '', charCount: 0 };
  const texts = extractTextFromXML(await file.async('string'));
  return {
    slideNum,
    exists: true,
    texts,
    fullText: texts.join(' '),
    charCount: texts.join('').length,
  };
}

async function extractAllText(zip) {
  const slides = await Promise.all(
    Array.from({ length: countSlides(zip) }, (_, i) => extractSlideText(zip, i + 1))
  );
  return {
    slideCount: slides.length,
    slides,
    totalCharCount: slides.reduce((s, x) => s + x.charCount, 0),
  };
}

async function countCharts(zip) {
  const chartFiles = Object.keys(zip.files).filter((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f));
  return { chartFiles: chartFiles.length, chartFilesList: chartFiles };
}

async function countTables(zip) {
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort();
  const tables = [];
  for (const sf of slideFiles) {
    const content = await zip.file(sf).async('string');
    const tableCount = (content.match(/<a:tbl[^>]*>/g) || []).length;
    const rowCount = (content.match(/<a:tr[^>]*>/g) || []).length;
    const colCount = (content.match(/<a:tc[^>]*>/g) || []).length;
    if (tableCount > 0) {
      tables.push({ slide: parseInt(sf.match(/slide(\d+)/)[1]), tableCount, rowCount, colCount });
    }
  }
  return { totalTables: tables.reduce((s, t) => s + t.tableCount, 0), tablesBySlide: tables };
}

async function findText(zip, searchText) {
  const textData = await extractAllText(zip);
  const searchLower = searchText.toLowerCase();
  const matches = textData.slides
    .filter((s) => s.fullText.toLowerCase().includes(searchLower))
    .map((s) => ({ slide: s.slideNum, context: s.fullText.substring(0, 200) }));
  return { found: matches.length > 0, matchCount: matches.length, matches };
}

async function countImages(zip) {
  const imageFiles = Object.keys(zip.files).filter((f) =>
    /^ppt\/media\/(image|picture)\d+\.(png|jpg|jpeg|gif|svg)$/i.test(f)
  );
  return { imageCount: imageFiles.length, imageFiles };
}

async function validatePPTX(input, exp = {}) {
  const results = { passed: [], failed: [], warnings: [] };
  const pass = (check, msg) => results.passed.push({ check, message: msg });
  const fail = (check, expected, actual) => results.failed.push({ check, expected, actual });
  const warn = (check, msg) => results.warnings.push({ check, message: msg });

  try {
    const { zip, fileSize } = await readPPTX(input);
    pass('File integrity', 'PPTX parsed successfully');

    const xmlIntegrity = await scanXmlIntegrity(zip);
    if (xmlIntegrity.issueCount > 0) {
      fail(
        'XML character integrity',
        'No invalid XML chars or unpaired surrogates',
        `${xmlIntegrity.issueCount} issue(s), e.g. ${xmlIntegrity.issues
          .slice(0, 3)
          .map((x) => `${x.file}@${x.index}`)
          .join(', ')}`
      );
    } else {
      pass('XML character integrity', 'No invalid characters found');
    }

    const minSize = exp.minFileSize || 50 * 1024,
      maxSize = exp.maxFileSize || 3 * 1024 * 1024;
    if (fileSize < minSize)
      fail('File size', `>= ${(minSize / 1024).toFixed(0)}KB`, `${(fileSize / 1024).toFixed(1)}KB`);
    else if (fileSize > maxSize)
      warn('File size', `${(fileSize / 1024 / 1024).toFixed(1)}MB (large)`);
    else pass('File size', `${(fileSize / 1024).toFixed(1)}KB`);

    const slideCount = countSlides(zip);
    if (exp.minSlides && slideCount < exp.minSlides)
      fail('Slide count', `>= ${exp.minSlides}`, slideCount);
    else pass('Slide count', `${slideCount} slides`);

    if (exp.titleContains) {
      const s1 = await extractSlideText(zip, 1);
      if (exp.titleContains.some((t) => s1.fullText.toLowerCase().includes(t.toLowerCase())))
        pass('Title content', 'Found');
      else fail('Title content', exp.titleContains.join(' OR '), s1.fullText.substring(0, 100));
    }

    if (exp.minCharts !== undefined) {
      const { chartFiles } = await countCharts(zip);
      if (chartFiles < exp.minCharts) fail('Chart count', `>= ${exp.minCharts}`, chartFiles);
      else pass('Chart count', `${chartFiles} charts`);
    }

    if (exp.minTables !== undefined) {
      const { totalTables } = await countTables(zip);
      if (totalTables < exp.minTables) fail('Table count', `>= ${exp.minTables}`, totalTables);
      else pass('Table count', `${totalTables} tables`);
    }

    if (exp.minImages !== undefined) {
      const { imageCount } = await countImages(zip);
      if (imageCount < exp.minImages) fail('Image count', `>= ${exp.minImages}`, imageCount);
      else pass('Image count', `${imageCount} images`);
    }

    if (exp.requireInsights) {
      const textData = await extractAllText(zip);
      if (textData.slides.some((s) => s.fullText.toLowerCase().includes('key insights')))
        pass('Insights panels', 'Found');
      else fail('Insights panels', 'Contains "Key Insights"', 'Not found');
    }

    if (exp.noEmptySlides !== false) {
      const textData = await extractAllText(zip);
      const empty = textData.slides.filter((s) => s.charCount < 50);
      if (empty.length > 0)
        warn('Empty slides', `Slides with <50 chars: ${empty.map((s) => s.slideNum).join(', ')}`);
      else pass('No empty slides', 'All slides have content');
    }

    if (exp.requiredText) {
      for (const text of exp.requiredText) {
        const r = await findText(zip, text);
        if (r.found)
          pass(`Text: "${text}"`, `Found on slides ${r.matches.map((m) => m.slide).join(', ')}`);
        else fail(`Text: "${text}"`, `Contains "${text}"`, 'Not found');
      }
    }

    if (exp.slideChecks) {
      const textData = await extractAllText(zip);
      for (const chk of exp.slideChecks) {
        const slide = textData.slides.find((s) => s.slideNum === chk.slide);
        if (!slide?.exists) {
          fail(`Slide ${chk.slide} exists`, 'Exists', 'Not found');
          continue;
        }
        if (chk.minChars && slide.charCount < chk.minChars)
          fail(`Slide ${chk.slide} length`, `>= ${chk.minChars}`, slide.charCount);
        else if (chk.minChars) pass(`Slide ${chk.slide} length`, `${slide.charCount} chars`);
        if (chk.mustContain) {
          for (const t of chk.mustContain) {
            if (slide.fullText.toLowerCase().includes(t.toLowerCase()))
              pass(`Slide ${chk.slide} "${t}"`, 'Found');
            else
              fail(`Slide ${chk.slide} "${t}"`, `Contains "${t}"`, slide.fullText.substring(0, 80));
          }
        }
      }
    }

    if (exp.tableChecks) {
      const tableData = await countTables(zip);
      for (const chk of exp.tableChecks) {
        const slideTable = tableData.tablesBySlide.find((t) => t.slide === chk.slide);
        if (chk.minTables && (!slideTable || slideTable.tableCount < chk.minTables))
          fail(`Slide ${chk.slide} tables`, `>= ${chk.minTables}`, slideTable?.tableCount || 0);
        else if (chk.minTables) pass(`Slide ${chk.slide} tables`, `${slideTable.tableCount}`);
        if (chk.minRows && (!slideTable || slideTable.rowCount < chk.minRows))
          fail(`Slide ${chk.slide} rows`, `>= ${chk.minRows}`, slideTable?.rowCount || 0);
        else if (chk.minRows) pass(`Slide ${chk.slide} rows`, `${slideTable?.rowCount || 0}`);
      }
    }
  } catch (err) {
    fail('File integrity', 'Valid PPTX', err.message);
  }

  return {
    valid: results.failed.length === 0,
    summary: {
      passed: results.passed.length,
      failed: results.failed.length,
      warnings: results.warnings.length,
    },
    ...results,
  };
}

async function generateReport(input) {
  const { zip, fileSize } = await readPPTX(input);
  const [chartData, tableData, textData, imageData] = await Promise.all([
    countCharts(zip),
    countTables(zip),
    extractAllText(zip),
    countImages(zip),
  ]);
  return {
    metadata: { fileSize: `${(fileSize / 1024).toFixed(1)}KB`, fileSizeBytes: fileSize },
    slides: {
      count: textData.slideCount,
      details: textData.slides.map((s) => ({
        slide: s.slideNum,
        chars: s.charCount,
        preview: s.fullText.substring(0, 100),
      })),
    },
    charts: chartData,
    tables: tableData,
    images: imageData,
    text: {
      total: textData.totalCharCount,
      avgPerSlide: Math.round(textData.totalCharCount / textData.slideCount),
    },
  };
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const flags = args.filter((a) => a.startsWith('--'));

  if (!file) {
    console.log('Usage: node pptx-validator.js <file.pptx> [--validate] [--country=Vietnam]');
    process.exit(0);
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  // Parse country flag
  const countryArg = flags.find((f) => f.startsWith('--country='));
  const country = countryArg ? countryArg.split('=')[1] : 'Vietnam';

  (async () => {
    if (flags.some((f) => f === '--validate')) {
      const r = await validatePPTX(file, {
        minSlides: 7,
        minCharts: 1,
        minTables: 3,
        requireInsights: true,
        titleContains: [country, 'Market'],
      });
      console.log(`Validating for: ${country}`);
      console.log(
        `Result: ${r.valid ? 'PASSED' : 'FAILED'} (${r.summary.passed}/${r.summary.passed + r.summary.failed})`
      );
      r.failed.forEach((f) =>
        console.log(`  [FAIL] ${f.check}: expected ${f.expected}, got ${f.actual}`)
      );
      process.exit(r.valid ? 0 : 1);
    } else {
      const r = await generateReport(file);
      console.log(
        `Size: ${r.metadata.fileSize} | Slides: ${r.slides.count} | Charts: ${r.charts.chartFiles} | Tables: ${r.tables.totalTables} | Images: ${r.images.imageCount}`
      );
      r.slides.details.forEach((s) =>
        console.log(`  Slide ${s.slide}: ${s.chars} chars - "${s.preview.substring(0, 60)}..."`)
      );
    }
  })();
}

module.exports = {
  readPPTX,
  scanXmlIntegrity,
  countSlides,
  extractSlideText,
  extractAllText,
  countCharts,
  countTables,
  countImages,
  findText,
  validatePPTX,
  generateReport,
};
