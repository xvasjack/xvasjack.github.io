const JSZip = require('jszip');

const DEFAULT_THEME_COLORS = {
  dk1: '000000',
  lt1: 'FFFFFF',
  dk2: '1F497D',
  lt2: '1F497D',
  accent1: '007FFF',
  accent2: 'EDFDFF',
  accent3: '011AB7',
  accent4: '1524A9',
  accent5: '001C44',
  accent6: 'E46C0A',
};

function normalizeHex(value, fallback) {
  const v = String(value || '')
    .trim()
    .replace(/^#/, '')
    .toUpperCase();
  if (/^[0-9A-F]{6}$/.test(v)) return v;
  return String(fallback || '')
    .trim()
    .replace(/^#/, '')
    .toUpperCase();
}

function replaceThemeColor(xml, key, hex) {
  let out = xml;
  const srgb = new RegExp(`(<a:${key}[^>]*>[\\s\\S]*?<a:srgbClr[^>]*\\bval=\")([0-9A-Fa-f]{6})(\")`, 'i');
  if (srgb.test(out)) {
    out = out.replace(srgb, `$1${hex}$3`);
    return out;
  }
  const sys = new RegExp(
    `(<a:${key}[^>]*>[\\s\\S]*?<a:sysClr[^>]*\\blastClr=\")([0-9A-Fa-f]{6})(\")`,
    'i'
  );
  if (sys.test(out)) {
    out = out.replace(sys, `$1${hex}$3`);
  }
  return out;
}

function replaceLatinTypeface(xml, blockName, face) {
  if (!face) return xml;
  const re = new RegExp(
    `(<a:${blockName}>[\\s\\S]*?<a:latin[^>]*\\btypeface=\")([^\"]*)(\")`,
    'i'
  );
  if (!re.test(xml)) return xml;
  return xml.replace(re, `$1${face}$3`);
}

async function normalizeThemeToTemplate(
  pptxBuffer,
  { colors = {}, majorFontFace = 'Segoe UI', minorFontFace = 'Segoe UI' } = {}
) {
  if (!Buffer.isBuffer(pptxBuffer) || pptxBuffer.length === 0) return pptxBuffer;
  const zip = await JSZip.loadAsync(pptxBuffer);
  const themePath = 'ppt/theme/theme1.xml';
  const themeEntry = zip.file(themePath);
  if (!themeEntry) return pptxBuffer;

  const baseColors = { ...DEFAULT_THEME_COLORS, ...(colors || {}) };
  const nextColors = {};
  for (const [k, v] of Object.entries(baseColors)) {
    nextColors[k] = normalizeHex(v, DEFAULT_THEME_COLORS[k] || '000000');
  }

  const xml = await themeEntry.async('string');
  let nextXml = xml;
  nextXml = replaceLatinTypeface(nextXml, 'majorFont', majorFontFace);
  nextXml = replaceLatinTypeface(nextXml, 'minorFont', minorFontFace);

  const keys = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
  for (const k of keys) {
    nextXml = replaceThemeColor(nextXml, k, nextColors[k]);
  }

  if (nextXml === xml) return pptxBuffer;
  zip.file(themePath, nextXml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { normalizeThemeToTemplate, DEFAULT_THEME_COLORS };

