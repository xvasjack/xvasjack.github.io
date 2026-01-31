const JSZip = require('jszip');
const fs = require('fs');

async function extractStructure(path, label) {
  const buf = fs.readFileSync(path);
  const zip = await JSZip.loadAsync(buf);
  const doc = await zip.file('word/document.xml').async('string');

  // Extract sections with formatting
  const sections = [];

  // Find all paragraphs with their styles
  const paraRegex = /<w:p[^>]*>(.*?)<\/w:p>/gs;
  let match;
  while ((match = paraRegex.exec(doc)) !== null) {
    const para = match[1];

    // Get style
    const styleMatch = para.match(/<w:pStyle w:val="([^"]+)"/);
    const style = styleMatch ? styleMatch[1] : 'Normal';

    // Get text
    const textParts = [];
    const textRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let tm;
    while ((tm = textRegex.exec(para)) !== null) {
      textParts.push(tm[1]);
    }
    const text = textParts.join('').trim();

    if (text) {
      sections.push({ style, text: text.substring(0, 100) + (text.length > 100 ? '...' : '') });
    }
  }

  // Find tables and extract their structure
  const tables = [];
  const tableRegex = /<w:tbl>(.*?)<\/w:tbl>/gs;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(doc)) !== null) {
    const tableXml = tableMatch[1];

    // Count rows
    const rowCount = (tableXml.match(/<w:tr>/g) || []).length;

    // Get first row cells (headers)
    const firstRowMatch = tableXml.match(/<w:tr>(.*?)<\/w:tr>/s);
    const headerCells = [];
    if (firstRowMatch) {
      const cellRegex = /<w:tc>(.*?)<\/w:tc>/gs;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(firstRowMatch[1])) !== null) {
        const cellText = cellMatch[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        headerCells.push(cellText.substring(0, 25));
      }
    }

    // Check for shading
    const hasShading = tableXml.includes('w:shd');
    const shadingColors = [];
    const shadingRegex = /<w:shd[^>]*w:fill="([^"]+)"/g;
    let shadingMatch;
    while ((shadingMatch = shadingRegex.exec(tableXml)) !== null) {
      if (!shadingColors.includes(shadingMatch[1])) {
        shadingColors.push(shadingMatch[1]);
      }
    }

    tables.push({
      rows: rowCount,
      cols: headerCells.length,
      headers: headerCells,
      shading: shadingColors,
    });
  }

  console.log('\n' + '='.repeat(60));
  console.log(label);
  console.log('='.repeat(60));

  console.log('\nTABLES (' + tables.length + '):');
  tables.forEach((t, i) => {
    console.log('  Table ' + (i + 1) + ': ' + t.rows + ' rows x ' + t.cols + ' cols');
    console.log('    Headers: ' + t.headers.join(' | '));
    console.log('    Shading: ' + (t.shading.length ? t.shading.join(', ') : 'none'));
  });

  console.log('\nSECTION STRUCTURE (first 40):');
  sections.slice(0, 40).forEach((s, i) => {
    console.log((i + 1).toString().padStart(2) + '. [' + s.style.padEnd(15) + '] ' + s.text);
  });
}

async function main() {
  await extractStructure(
    '/mnt/c/Users/User/Downloads/260114_SunCorp_Netpluz DD Report v4 (1).docx',
    'TEMPLATE'
  );
  await extractStructure('/tmp/dd-test-output-dd_1768666502475_e132sfxd7.docx', 'GENERATED');
}
main();
