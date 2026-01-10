require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const pptxgen = require('pptxgenjs');
const XLSX = require('xlsx');
const multer = require('multer');
const { createClient } = require('@deepgram/sdk');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const { S3Client } = require('@aws-sdk/client-s3');
const Anthropic = require('@anthropic-ai/sdk');
const JSZip = require('jszip');
const { securityHeaders, rateLimiter, escapeHtml } = require('./shared/security');
const { requestLogger, healthCheck } = require('./shared/middleware');

// ============ GLOBAL ERROR HANDLERS - PREVENT CRASHES ============
// Memory logging helper for debugging Railway OOM issues
function logMemoryUsage(label = '') {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  console.log(`  [Memory${label ? ': ' + label : ''}] Heap: ${heapUsedMB}/${heapTotalMB}MB, RSS: ${rssMB}MB`);
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('=== UNHANDLED PROMISE REJECTION ===');
  console.error('Reason:', reason);
  console.error('Promise:', promise);
  console.error('Stack:', reason?.stack || 'No stack trace');
  logMemoryUsage('at rejection');
  // Don't exit - keep the server running
});

process.on('uncaughtException', (error) => {
  console.error('=== UNCAUGHT EXCEPTION ===');
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
  logMemoryUsage('at exception');
  // Don't exit - keep the server running
});

// ============ TYPE SAFETY HELPERS ============
// Ensure a value is a string (AI models may return objects/arrays instead of strings)
function ensureString(value, defaultValue = '') {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return defaultValue;
  // Handle arrays - join with comma
  if (Array.isArray(value)) return value.map(v => ensureString(v)).join(', ');
  // Handle objects - try to extract meaningful string
  if (typeof value === 'object') {
    // Common patterns from AI responses
    if (value.city && value.country) return `${value.city}, ${value.country}`;
    if (value.text) return ensureString(value.text);
    if (value.value) return ensureString(value.value);
    if (value.name) return ensureString(value.name);
    // Fallback: stringify
    try { return JSON.stringify(value); } catch { return defaultValue; }
  }
  // Convert other types to string
  return String(value);
}

// Normalize label to Title Case (e.g., "employees" -> "Employees", "export countries" -> "Export Countries")
// This prevents lowercase labels from appearing in slides
function normalizeLabel(label) {
  if (!label || typeof label !== 'string') return label;
  return label
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// Capitalize first letter of each word (title case)
function toTitleCase(name) {
  if (!name || typeof name !== 'string') return name;
  return name
    .toLowerCase()
    .split(/\s+/)
    .map(word => {
      // Keep acronyms uppercase (2-4 letter all-caps words)
      if (/^[A-Z]{2,4}$/i.test(word) && word === word.toUpperCase()) {
        return word.toUpperCase();
      }
      // Capitalize first letter
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

// Strip company suffixes from customer/partner names (simpler than cleanCompanyName)
// Just removes suffixes, doesn't reject non-ASCII or descriptive names
function stripCompanySuffix(name) {
  if (!name || typeof name !== 'string') return name;
  return name
    .replace(/\s*(Sdn\.?\s*Bhd\.?|Bhd\.?|Berhad|Pte\.?\s*Ltd\.?|Ltd\.?|Limited|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?,?\s*Ltd\.?|LLC|LLP|GmbH|S\.?A\.?|Tbk\.?|JSC|PLC|Public\s*Limited|Private\s*Limited|Joint\s*Stock|Company|\(.*?\))$/gi, '')
    .replace(/^(PT\.?|CV\.?)\s+/gi, '')  // Remove PT/CV prefix
    .trim();
}

// Filter garbage from customer/partner name arrays before display
// Removes image artifacts, URLs, descriptions, product names mixed in customer lists
// Optional companyName parameter to filter out the company's own name
function filterGarbageNames(names, companyName = '') {
  if (!Array.isArray(names)) return [];

  const companyLower = (companyName || '').toLowerCase().replace(/\s+/g, '');

  return names.filter(name => {
    if (!name || typeof name !== 'string') return false;
    const lower = name.toLowerCase();
    const normalized = lower.replace(/\s+/g, '');

    // Too short (1-2 chars) or too long (>60 chars)
    if (name.length < 3 || name.length > 60) return false;

    // Filter out company's own name
    if (companyLower && normalized.includes(companyLower)) return false;
    if (companyLower && companyLower.includes(normalized) && normalized.length > 5) return false;

    // HTML artifacts
    if (/<[^>]+>/.test(name)) return false; // HTML tags
    if (/style\s*=|href\s*=|src\s*=|class\s*=/i.test(name)) return false; // HTML attributes
    if (/&[a-z]+;|&#\d+;/i.test(name)) return false; // HTML entities
    if (/alt\s+text/i.test(name)) return false;

    // Page elements and navigation
    const pageElements = [
      'home', 'footer', 'header', 'copyright', 'loading', 'contact', 'menu',
      'product & system', 'cctv & vms', 'about us', 'our services', 'our products',
      'read more', 'learn more', 'click here', 'download', 'subscribe',
      'navigation', 'sidebar', 'breadcrumb', 'pagination', 'next', 'previous'
    ];
    if (pageElements.includes(lower.trim())) return false;
    if (/^(page|section|slide)\s*\d*$/i.test(name)) return false;

    // Generic single-word garbage
    const genericTerms = [
      'logo', 'email', 'phone', 'address', 'fax', 'website', 'english', 'indonesia',
      'image', 'photo', 'picture', 'icon', 'button', 'link', 'banner', 'background',
      'thumbnail', 'gallery', 'slider', 'carousel', 'video', 'animation'
    ];
    if (genericTerms.includes(lower.trim())) return false;

    // Product names that aren't customers (security industry specific)
    const productTerms = [
      'ai camera', 'smart home', 'turnstile', 'access control', 'barrier gate',
      'cctv system', 'fingerprint', 'visitor management', 'fire alarm',
      'smart security', 'building solution', 'integration system', 'security system'
    ];
    if (productTerms.some(p => lower === p || lower === p + 's')) return false;

    // Image artifacts (more specific patterns)
    if (/[-_]removebg|removebg[-_]/i.test(name)) return false;
    if (/[-_]preview|preview[-_]|\spreview$/i.test(name)) return false;
    if (/[-_]scaled|scaled[-_]|\d+x\s*scaled/i.test(name)) return false;
    if (/[-_]cover[-_]|home[-_]page[-_]cover/i.test(name)) return false;
    if (/\d+x\d*$/.test(name)) return false; // Dimensions like "140x"
    if (/[-_]\d{5,}[-_\.]/.test(name)) return false; // Long number sequences in filenames

    // URLs and paths
    if (name.includes('~') || name.includes('://')) return false;
    if (/\/\d+\/|\/blog\/|\/images?\//i.test(name)) return false;
    if (/\d{4}\/\d+\/\d+/.test(name)) return false; // Date paths
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf)$/i.test(name)) return false; // File extensions

    // Descriptions (sentences)
    if (name.split(/\s+/).length > 8) return false;
    if (/^a\s+\w+\s+with\s+/i.test(name)) return false;
    if (/^the\s+\w+\s+(is|are|was|has)/i.test(name)) return false;
    if (/\s+displaying\s+|\s+showing\s+|\s+featuring\s+/i.test(name)) return false;
    if (/multiple\s+(security|camera|monitor)/i.test(name)) return false;
    if (/camera\s+feeds|control\s+room\s+with|group\s+of\s+people/i.test(name)) return false;

    // Combined brand/product listings
    if (/hanwha.*hikvision|hikvision.*hanwha/i.test(name)) return false;
    if (/dahua.*hikvision|hikvision.*dahua/i.test(name)) return false;

    return true;
  }).map(name => toTitleCase(stripCompanySuffix(name))); // Strip suffixes and title case
}

// ===== QUOTE VERIFICATION SYSTEM =====
// Verifies that AI-extracted data actually exists in the scraped content
// This prevents hallucination by requiring proof for every claim

// Normalize text for comparison (handles whitespace, numbers, encoding)
function normalizeTextForComparison(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')           // Normalize whitespace
    .replace(/[,\.]/g, '')           // Remove commas and periods from numbers
    .replace(/&amp;/g, '&')          // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/['']/g, "'")           // Normalize quotes
    .replace(/[""]/g, '"')
    .trim();
}

// Extract key numbers from text for verification (more lenient matching)
function extractNumbersFromText(text) {
  if (!text) return [];
  const numbers = text.match(/\d+(?:[,\.]\d+)*/g) || [];
  return numbers.map(n => n.replace(/[,\.]/g, ''));
}

// Translate non-English units to English in metric values
// Covers: Thai, Vietnamese, Indonesian/Malay, Chinese, Japanese, Korean, Hindi, Bengali, Arabic
function translateUnitsToEnglish(text) {
  if (!text || typeof text !== 'string') return text;

  const translations = {
    // === THAI ===
    'ตัน/เดือน': 'tons/month', 'ตัน/ปี': 'tons/year', 'ต่อเดือน': '/month', 'ต่อปี': '/year',
    'ตัน': 'tons', 'ไร่': 'rai', 'งาน': 'ngan', 'ตารางวา': 'sq wah',
    'ตร.ม.': 'sqm', 'ตารางเมตร': 'sqm', 'เครื่องจักร': 'machines', 'เครื่อง': 'machines',
    'พนักงาน': 'employees', 'บุคลากร': 'staff', 'คน': 'people',
    'พันธมิตร': 'partners', 'ตัวแทนจำหน่าย': 'distributors', 'ผู้จัดจำหน่าย': 'distributors', 'ราย': 'units',
    'ลูกค้า': 'customers', 'ประเทศ': 'countries', 'สาขา': 'branches', 'ร้าน': 'stores',
    'โรงงาน': 'factories', 'คลังสินค้า': 'warehouses', 'ผลิตภัณฑ์': 'products', 'รายการ': 'items',

    // === VIETNAMESE ===
    'tấn/tháng': 'tons/month', 'tấn/năm': 'tons/year', 'mỗi tháng': '/month', 'mỗi năm': '/year',
    'tấn': 'tons', 'nhân viên': 'employees', 'người lao động': 'workers', 'người': 'people',
    'văn phòng': 'offices', 'chi nhánh': 'branches', 'cửa hàng': 'stores',
    'máy móc': 'machines', 'máy': 'machines', 'thiết bị': 'equipment',
    'đối tác': 'partners', 'nhà phân phối': 'distributors', 'đại lý': 'agents',
    'khách hàng': 'customers', 'sản phẩm': 'products', 'mặt hàng': 'items',

    // === INDONESIAN/MALAY ===
    'ton/bulan': 'tons/month', 'ton/tahun': 'tons/year', 'per bulan': '/month', 'per tahun': '/year',
    'karyawan': 'employees', 'pekerja': 'workers', 'staf': 'staff',
    'mesin': 'machines', 'peralatan': 'equipment', 'unit mesin': 'machine units',
    'kantor': 'offices', 'cabang': 'branches', 'lokasi': 'locations', 'toko': 'stores',
    'mitra': 'partners', 'distributor': 'distributors', 'agen': 'agents',
    'pelanggan': 'customers', 'produk': 'products', 'jenis': 'types',
    'meter persegi': 'sqm', 'hektar': 'hectares',

    // === CHINESE (Simplified & Traditional) ===
    '吨/月': 'tons/month', '吨/年': 'tons/year', '噸/月': 'tons/month', '噸/年': 'tons/year',
    '每月': '/month', '每年': '/year', '吨': 'tons', '噸': 'tons',
    '名员工': 'employees', '名員工': 'employees', '员工': 'employees', '員工': 'employees',
    '職員': 'staff', '雇员': 'workers', '人': 'people',
    '台设备': 'machines', '台設備': 'machines', '设备': 'equipment', '設備': 'equipment',
    '機器': 'machines', '机器': 'machines', '機械': 'machinery', '机械': 'machinery',
    '个办事处': 'offices', '個辦事處': 'offices', '办公室': 'offices', '辦公室': 'offices',
    '分公司': 'branches', '门店': 'stores', '門店': 'stores',
    '家经销商': 'distributors', '家經銷商': 'distributors', '经销商': 'distributors', '經銷商': 'distributors',
    '合作伙伴': 'partners', '合作夥伴': 'partners', '代理商': 'agents',
    '家客户': 'customers', '家客戶': 'customers', '客户': 'customers', '客戶': 'customers',
    '种产品': 'products', '種產品': 'products', '产品': 'products', '產品': 'products',
    '平方米': 'sqm', '平米': 'sqm', '亩': 'mu', '畝': 'mu', '坪': 'ping',
    '产能': 'capacity', '產能': 'capacity', '产量': 'output', '產量': 'output',

    // === JAPANESE ===
    'トン/月': 'tons/month', 'トン/年': 'tons/year', 'トン': 'tons',
    '名の従業員': 'employees', '名従業員': 'employees', '従業員': 'employees', '社員': 'employees',
    'スタッフ': 'staff', '名': 'people',
    '台の設備': 'machines', '台設備': 'machines', '設備': 'equipment', '機械': 'machinery',
    'の事務所': 'offices', '事務所': 'offices', '支店': 'branches', '店舗': 'stores', '拠点': 'locations',
    'パートナー': 'partners', '代理店': 'agents', '販売店': 'dealers',
    '顧客': 'customers', '製品': 'products', '種類': 'types',
    '平方メートル': 'sqm',

    // === KOREAN ===
    '톤/월': 'tons/month', '톤/년': 'tons/year', '월간': '/month', '연간': '/year', '톤': 'tons',
    '명의 직원': 'employees', '명 직원': 'employees', '직원': 'employees', '임직원': 'employees',
    '근로자': 'workers', '명': 'people',
    '대 기계': 'machines', '대 설비': 'machines', '기계': 'machines', '설비': 'equipment', '장비': 'equipment',
    '개 사무소': 'offices', '사무소': 'offices', '지점': 'branches', '매장': 'stores', '센터': 'centers',
    '개 파트너': 'partners', '파트너': 'partners', '대리점': 'agents', '유통업체': 'distributors', '협력사': 'partners',
    '개 고객': 'customers', '고객': 'customers', '거래처': 'clients',
    '개 제품': 'products', '제품': 'products', '상품': 'products', '품목': 'items',
    '제곱미터': 'sqm', '평': 'pyeong', '㎡': 'sqm',

    // === HINDI ===
    'टन/माह': 'tons/month', 'टन/वर्ष': 'tons/year', 'प्रति माह': '/month', 'प्रति वर्ष': '/year', 'टन': 'tons',
    'कर्मचारी': 'employees', 'कार्यालय': 'offices', 'शाखा': 'branches',
    'मशीन': 'machines', 'मशीनें': 'machines', 'उपकरण': 'equipment',
    'भागीदार': 'partners', 'वितरक': 'distributors', 'डीलर': 'dealers', 'एजेंट': 'agents',
    'ग्राहक': 'customers', 'उत्पाद': 'products',
    'उत्पादन क्षमता': 'production capacity', 'क्षमता': 'capacity',

    // === BENGALI ===
    'টন/মাস': 'tons/month', 'টন/বছর': 'tons/year', 'টন': 'tons',
    'কর্মচারী': 'employees', 'কর্মী': 'workers',
    'মেশিন': 'machines', 'যন্ত্র': 'machines', 'যন্ত্রপাতি': 'machinery',
    'অংশীদার': 'partners', 'পরিবেশক': 'distributors', 'ডিলার': 'dealers', 'এজেন্ট': 'agents',
    'গ্রাহক': 'customers', 'পণ্য': 'products',
    'উৎপাদন ক্ষমতা': 'production capacity', 'ক্ষমতা': 'capacity',

    // === ARABIC ===
    'طن/شهر': 'tons/month', 'طن/سنة': 'tons/year', 'طن': 'tons',
    'موظف': 'employees', 'موظفين': 'employees', 'عامل': 'workers',
    'آلة': 'machines', 'آلات': 'machines', 'معدات': 'equipment',
    'مكتب': 'offices', 'مكاتب': 'offices', 'فرع': 'branches', 'فروع': 'branches',
    'شريك': 'partners', 'شركاء': 'partners', 'موزع': 'distributors',
    'عميل': 'customers', 'عملاء': 'customers', 'منتج': 'products', 'منتجات': 'products',
    'متر مربع': 'sqm', 'هكتار': 'hectares',
  };

  let result = text;
  // Sort by length descending to match longer phrases first
  const sortedTranslations = Object.entries(translations).sort((a, b) => b[0].length - a[0].length);
  for (const [foreign, english] of sortedTranslations) {
    result = result.replace(new RegExp(foreign, 'gi'), english);
  }

  return result;
}

// Verify that a source quote exists in the scraped content
// Returns true if quote is found (with fuzzy matching for formatting differences)
function verifyQuoteInContent(quote, scrapedContent) {
  if (!quote || !scrapedContent) return false;

  const normalizedQuote = normalizeTextForComparison(quote);
  const normalizedContent = normalizeTextForComparison(scrapedContent);

  // Method 1: Direct substring match
  if (normalizedContent.includes(normalizedQuote)) {
    return true;
  }

  // Method 2: Check if all significant numbers from quote exist in content
  // This handles cases where formatting differs but numbers are correct
  const quoteNumbers = extractNumbersFromText(quote);
  if (quoteNumbers.length > 0) {
    const contentNumbers = extractNumbersFromText(scrapedContent);
    const allNumbersFound = quoteNumbers.every(num =>
      contentNumbers.some(contentNum => contentNum === num || contentNum.includes(num))
    );
    if (allNumbersFound) {
      // For non-ASCII text (Thai, Chinese, etc.), just verify numbers exist
      // Thai/CJK doesn't have word boundaries, so word matching doesn't work
      const hasNonAscii = /[^\x00-\x7F]/.test(quote);
      if (hasNonAscii) {
        // For Thai/CJK: if numbers match, that's good enough
        return true;
      }

      // For ASCII text: also check for key non-numeric words (at least 2 must match)
      const quoteWords = normalizedQuote.split(' ').filter(w => w.length > 3 && !/^\d+$/.test(w));
      const matchedWords = quoteWords.filter(word => normalizedContent.includes(word));
      if (matchedWords.length >= Math.min(2, quoteWords.length)) {
        return true;
      }
    }
  }

  // Method 3: For non-ASCII quotes (ANY language), check if significant portions exist
  // Covers: Thai, Chinese, Japanese, Korean, Vietnamese, Hindi, Arabic, Russian, etc.
  const hasNonAscii = /[^\x00-\x7F]/.test(quote);
  if (hasNonAscii) {
    // Method 3a: Extract ALL non-ASCII word sequences and check if ANY exist in content
    // This works for Thai, Chinese, Japanese, Korean, Vietnamese, Hindi, Arabic, Cyrillic, etc.
    const nonAsciiKeywords = quote.match(/[^\x00-\x7F\s\d]+/g) || [];
    if (nonAsciiKeywords.length > 0) {
      const matchedKeywords = nonAsciiKeywords.filter(kw => kw.length >= 2 && scrapedContent.includes(kw));
      if (matchedKeywords.length >= 1) {
        // At least one non-ASCII keyword matches - good enough
        return true;
      }
    }

    // Method 3b: Check for ANY 3+ character substring match
    for (let i = 0; i < quote.length - 2; i++) {
      const substring = quote.substring(i, i + 3);
      if (/[^\x00-\x7F]/.test(substring) && scrapedContent.includes(substring)) {
        return true; // Found a 3-char non-ASCII substring in content
      }
    }

    // Method 3c: Split by spaces and numbers, check if any chunk exists
    const chunks = quote.split(/[\s\d]+/).filter(c => c.length > 1);
    const matchedChunks = chunks.filter(chunk => scrapedContent.includes(chunk));
    if (matchedChunks.length >= 1) {
      return true; // At least one chunk found
    }
  }

  // Method 4: Check for word overlap (for text-heavy quotes) - ASCII only
  const quoteWords = normalizedQuote.split(' ').filter(w => w.length > 2);
  if (quoteWords.length >= 3) {
    const matchedWords = quoteWords.filter(word => normalizedContent.includes(word));
    const matchRatio = matchedWords.length / quoteWords.length;
    if (matchRatio >= 0.7) { // 70% word match
      return true;
    }
  }

  return false;
}

// Verify all quotes for a metric and return verification result
function verifyMetricQuotes(metric, scrapedContent) {
  if (!metric || !metric.source_quotes || !Array.isArray(metric.source_quotes)) {
    return { verified: false, reason: 'no_source_quotes' };
  }

  if (metric.source_quotes.length === 0) {
    return { verified: false, reason: 'empty_source_quotes' };
  }

  const verificationResults = metric.source_quotes.map(quote => ({
    quote,
    found: verifyQuoteInContent(quote, scrapedContent)
  }));

  const allFound = verificationResults.every(r => r.found);
  const someFound = verificationResults.some(r => r.found);

  if (allFound) {
    return { verified: true, results: verificationResults };
  } else if (someFound) {
    // Partial verification - some quotes found
    return {
      verified: 'partial',
      results: verificationResults,
      reason: 'some_quotes_not_found'
    };
  } else {
    return {
      verified: false,
      results: verificationResults,
      reason: 'no_quotes_found'
    };
  }
}

// Filter metrics based on quote verification
// Only keeps metrics where source quotes are verified
function filterMetricsByVerification(metrics, scrapedContent, companyIndex) {
  if (!metrics || !Array.isArray(metrics)) return [];

  const verifiedMetrics = [];
  let rejectedCount = 0;

  for (const metric of metrics) {
    // Skip metrics without source quotes entirely (legacy or regex-extracted)
    if (!metric.source_quotes) {
      // For metrics without quotes, apply strict validation
      // Only keep if value has actual data (not placeholders)
      if (metric.value && typeof metric.value === 'string') {
        const valueLower = metric.value.toLowerCase();
        // Reject obvious placeholders and vague values
        if (valueLower.includes('not specified') ||
            valueLower.includes('not available') ||
            valueLower.includes('various') ||
            /customer\s*[a-z1-9]/i.test(valueLower) ||
            /client\s*[a-z1-9]/i.test(valueLower) ||
            /supplier\s*[a-z1-9]/i.test(valueLower) ||
            /partner\s*[a-z1-9]/i.test(valueLower) ||
            /^0\s+\w/i.test(metric.value)) { // "0 Something" pattern
          rejectedCount++;
          continue;
        }
      }
      // Translate any non-English units in the metric value
      verifiedMetrics.push({
        label: metric.label,
        value: translateUnitsToEnglish(metric.value)
      });
      continue;
    }

    const verification = verifyMetricQuotes(metric, scrapedContent);

    if (verification.verified === true) {
      // Fully verified - keep the metric (translate any non-English units)
      verifiedMetrics.push({
        label: metric.label,
        value: translateUnitsToEnglish(metric.value)
      });
    } else if (verification.verified === 'partial') {
      // Partially verified - keep but log warning (translate any non-English units)
      console.log(`  [${companyIndex}] Partial verification for "${metric.label}" - some quotes not found`);
      verifiedMetrics.push({
        label: metric.label,
        value: translateUnitsToEnglish(metric.value)
      });
    } else {
      // Not verified - reject as potential hallucination
      console.log(`  [${companyIndex}] REJECTED "${metric.label}" - source quotes not found in content (potential hallucination)`);
      rejectedCount++;
    }
  }

  if (rejectedCount > 0) {
    console.log(`  [${companyIndex}] Quote verification: kept ${verifiedMetrics.length}, rejected ${rejectedCount} unverified metrics`);
  }

  return verifiedMetrics;
}

// Extract a company name from URL for inaccessible websites
function extractCompanyNameFromUrl(url) {
  try {
    const urlObj = new URL(url);
    let domain = urlObj.hostname.replace(/^www\./, '');
    // Remove common TLDs and country codes
    domain = domain.replace(/\.(com|co|org|net|io|ai|jp|cn|kr|sg|my|th|vn|id|ph|tw|hk|in|de|uk|fr|it|es|au|nz|ca|us|br|mx|ru|nl|be|ch|at|se|no|dk|fi|pl|cz|hu|ro|bg|gr|tr|ae|sa|il|za|ng|eg|ke)(\.[a-z]{2,3})?$/i, '');
    // Convert to title case
    const name = domain.split(/[-_.]/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
    return name || domain;
  } catch (e) {
    return url;
  }
}

// Clean company name: remove suffixes, convert to English, reject descriptions
function cleanCompanyName(name, fallbackUrl = '') {
  if (!name || typeof name !== 'string') {
    return fallbackUrl ? extractCompanyNameFromUrl(fallbackUrl) : '';
  }

  let cleaned = name.trim();

  // Convert common non-ASCII characters to ASCII equivalents
  const charMap = {
    'บริษัท': '', 'จำกัด': '', '(มหาชน)': '', // Thai: Company, Limited, Public
    '株式会社': '', '有限会社': '', '合同会社': '', // Japanese
    '公司': '', '有限': '', '集团': '', // Chinese
    'Công ty': '', 'TNHH': '', // Vietnamese
    // Diacritics
    'á': 'a', 'à': 'a', 'ả': 'a', 'ã': 'a', 'ạ': 'a', 'ă': 'a', 'ắ': 'a', 'ằ': 'a', 'ẳ': 'a', 'ẵ': 'a', 'ặ': 'a',
    'â': 'a', 'ấ': 'a', 'ầ': 'a', 'ẩ': 'a', 'ẫ': 'a', 'ậ': 'a',
    'é': 'e', 'è': 'e', 'ẻ': 'e', 'ẽ': 'e', 'ẹ': 'e', 'ê': 'e', 'ế': 'e', 'ề': 'e', 'ể': 'e', 'ễ': 'e', 'ệ': 'e',
    'í': 'i', 'ì': 'i', 'ỉ': 'i', 'ĩ': 'i', 'ị': 'i',
    'ó': 'o', 'ò': 'o', 'ỏ': 'o', 'õ': 'o', 'ọ': 'o', 'ô': 'o', 'ố': 'o', 'ồ': 'o', 'ổ': 'o', 'ỗ': 'o', 'ộ': 'o',
    'ơ': 'o', 'ớ': 'o', 'ờ': 'o', 'ở': 'o', 'ỡ': 'o', 'ợ': 'o',
    'ú': 'u', 'ù': 'u', 'ủ': 'u', 'ũ': 'u', 'ụ': 'u', 'ư': 'u', 'ứ': 'u', 'ừ': 'u', 'ử': 'u', 'ữ': 'u', 'ự': 'u',
    'ý': 'y', 'ỳ': 'y', 'ỷ': 'y', 'ỹ': 'y', 'ỵ': 'y',
    'đ': 'd', 'Đ': 'D',
    'ñ': 'n', 'ü': 'u', 'ö': 'o', 'ä': 'a', 'ß': 'ss',
    'ç': 'c', 'ø': 'o', 'å': 'a', 'æ': 'ae', 'œ': 'oe'
  };

  for (const [from, to] of Object.entries(charMap)) {
    cleaned = cleaned.split(from).join(to);
  }

  // Remove company suffixes (expanded list)
  cleaned = cleaned
    .replace(/\s*(Sdn\.?\s*Bhd\.?|Bhd\.?|Berhad|Pte\.?\s*Ltd\.?|Ltd\.?|Limited|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?,?\s*Ltd\.?|LLC|LLP|GmbH|S\.?A\.?|PT\.?|CV\.?|Tbk\.?|JSC|PLC|Public\s*Limited|Private\s*Limited|Joint\s*Stock|Company|\(.*?\))$/gi, '')
    .replace(/^(PT\.?|CV\.?)\s+/gi, '')  // Remove PT/CV prefix
    .trim();

  // Check if name looks like a description (too many generic/marketing words)
  const descriptionWords = [
    'leading', 'provider', 'solutions', 'services', 'industrial', 'manufacturing',
    'global', 'world', 'class', 'premier', 'best', 'top', 'quality', 'excellence',
    'innovative', 'advanced', 'professional', 'trusted', 'reliable', 'expert'
  ];
  const words = cleaned.toLowerCase().split(/\s+/);
  const descWordCount = words.filter(w => descriptionWords.includes(w)).length;

  // If more than 40% of words are generic description words, reject it
  if (words.length >= 3 && descWordCount / words.length > 0.4) {
    console.log(`  Rejecting descriptive company name: "${cleaned}"`);
    return fallbackUrl ? extractCompanyNameFromUrl(fallbackUrl) : '';
  }

  // Check if name contains non-ASCII characters (likely non-English)
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(cleaned)) {
    console.log(`  Rejecting non-English company name: "${cleaned}"`);
    return fallbackUrl ? extractCompanyNameFromUrl(fallbackUrl) : '';
  }

  return cleaned || (fallbackUrl ? extractCompanyNameFromUrl(fallbackUrl) : '');
}

const app = express();
app.use(securityHeaders);
app.use(rateLimiter);
app.use(cors());
app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Multer configuration for file uploads (memory storage)
// Add 50MB limit to prevent OOM on Railway containers
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }  // 50MB max
});

// Check required environment variables
const requiredEnvVars = ['OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'GEMINI_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
const optionalEnvVars = ['SERPAPI_API_KEY', 'DEEPSEEK_API_KEY', 'DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY']; // Optional but recommended
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}
if (!process.env.SERPAPI_API_KEY) {
  console.warn('SERPAPI_API_KEY not set - Google search will be skipped');
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.warn('DEEPSEEK_API_KEY not set - Due Diligence reports will use GPT-4o fallback');
}
if (!process.env.DEEPGRAM_API_KEY) {
  console.warn('DEEPGRAM_API_KEY not set - Real-time transcription will not work');
}
// Note: ANTHROPIC_API_KEY is optional - V5 uses Gemini + ChatGPT for search/validation

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'missing'
});

// ============ RATE LIMIT RETRY WRAPPER ============
// Retries API calls with exponential backoff when hitting rate limits (429)
async function withRetry(apiCall, maxRetries = 3, baseDelay = 2000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (error) {
      lastError = error;
      const isRateLimit = error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('rate limit');
      const isServerError = error?.status >= 500;

      if ((isRateLimit || isServerError) && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt); // 2s, 4s, 8s
        console.log(`    ⚠ Rate limit/server error, retrying in ${delay/1000}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

// ============ FETCH WITH TIMEOUT AND RETRY (for Gemini) ============
// Gemini API calls need timeout (can hang) and retry (can fail)
async function fetchWithTimeoutAndRetry(url, options, timeoutMs = 30000, maxRetries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const isRetryable = response.status === 429 || response.status >= 500;
        if (isRetryable && attempt < maxRetries) {
          const delay = 2000 * Math.pow(2, attempt); // 2s, 4s
          console.log(`    ⚠ Gemini API error ${response.status}, retrying in ${delay/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`Gemini API error: ${response.status}`);
      }

      return response;
    } catch (error) {
      lastError = error;

      const isTimeout = error.name === 'AbortError';
      const isNetworkError = error.message?.includes('fetch') || error.message?.includes('network');

      if ((isTimeout || isNetworkError) && attempt < maxRetries) {
        const delay = 2000 * Math.pow(2, attempt);
        console.log(`    ⚠ Gemini ${isTimeout ? 'timeout' : 'network error'}, retrying in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

// ============ MARKER AI (Gemini Flash) ============
// Scans FULL website content and extracts key snippets for extraction
// This solves the truncation blind spot - marker sees everything, extractors get curated content
async function markImportantContent(fullContent, website) {
  try {
    console.log(`    Running Marker AI (Gemini Flash) on ${fullContent.length} chars...`);

    // Gemini Flash can handle large context cheaply
    const contentToScan = fullContent.substring(0, 100000); // 100k chars max

    const prompt = `You are a content marker for company profile extraction. Scan this website content and extract ALL important snippets that contain:

## WHAT TO EXTRACT (copy exact text, preserve numbers):

### 1. COMPANY IDENTITY
- Company name, founding year, history
- Addresses, locations, headquarters (EXACT addresses with postal codes, provinces, districts)
- Contact information

### 2. STATISTICS & METRICS (CRITICAL - extract ALL numbers)
- Production capacity (tons, units, sqm per month/year)
- Number of employees, machines, production lines
- Number of customers, partners, distributors
- Years of experience, projects completed
- Export percentages, countries served
- Any counter/statistic displays (e.g., "880 Colour Matching", "60 Customers")

### 3. BUSINESS RELATIONSHIPS
- Partner companies (especially Japanese, international)
- Client/customer names
- Distribution network (countries, agents, offices)
- Certifications, affiliations

### 4. PRODUCTS & SERVICES
- Product categories and types
- Industries served
- Applications

## OUTPUT FORMAT:
Return a JSON object with these sections. For each section, include the RAW TEXT SNIPPETS from the website (not summaries):

{
  "identity_snippets": ["exact text about company name/history...", "exact address text..."],
  "statistics_snippets": ["800 tons per month...", "300 employees...", "250 machines..."],
  "relationships_snippets": ["partner with Dainichiseika...", "distributors in 9 countries..."],
  "products_snippets": ["flexographic inks...", "packaging solutions..."],
  "location_hints": ["Samut Sakhon", "123 Moo 4, Bangplee..."]
}

IMPORTANT:
- Extract EXACT text, don't summarize
- Include ALL numbers and statistics you find
- Include ALL location/address mentions
- If you find counter displays or infographics text, include those

Website: ${website}

CONTENT TO SCAN:
${contentToScan}`;

    // Use fetchWithTimeoutAndRetry for reliability (30s timeout, 2 retries)
    const response = await fetchWithTimeoutAndRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8000,
            responseMimeType: 'application/json'
          }
        })
      },
      30000,  // 30 second timeout
      2       // 2 retries
    );

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      console.log('    Marker AI returned empty response');
      return null;
    }

    const markers = JSON.parse(text);

    // Warn if critical snippets are empty - these might indicate Marker missed important content
    if (!markers.statistics_snippets?.length) {
      console.log(`    ⚠ WARNING: Marker found no statistics - validator will need to catch these`);
    }
    if (!markers.location_hints?.length) {
      console.log(`    ⚠ WARNING: Marker found no location hints - relying on extractBasicInfo with raw content`);
    }
    if (!markers.identity_snippets?.length) {
      console.log(`    ⚠ WARNING: Marker found no company identity info`);
    }

    // Combine all snippets into a focused content block for extractors
    const markedContent = [
      '=== COMPANY IDENTITY ===',
      ...(markers.identity_snippets || []),
      '',
      '=== STATISTICS & METRICS ===',
      ...(markers.statistics_snippets || []),
      '',
      '=== BUSINESS RELATIONSHIPS ===',
      ...(markers.relationships_snippets || []),
      '',
      '=== PRODUCTS & SERVICES ===',
      ...(markers.products_snippets || []),
      '',
      '=== LOCATION HINTS ===',
      ...(markers.location_hints || [])
    ].join('\n');

    console.log(`    Marker AI: condensed ${fullContent.length} → ${markedContent.length} chars`);
    console.log(`    Found: ${markers.statistics_snippets?.length || 0} stats, ${markers.location_hints?.length || 0} locations`);

    return {
      markedContent,
      markers,
      originalLength: fullContent.length,
      markedLength: markedContent.length
    };

  } catch (error) {
    console.error(`    Marker AI error: ${error.message}`);
    return null;
  }
}

// Initialize Anthropic (Claude)
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Initialize Deepgram
const deepgram = process.env.DEEPGRAM_API_KEY ? createClient(process.env.DEEPGRAM_API_KEY) : null;

// Initialize Cloudflare R2 (S3-compatible)
const r2Client = (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY)
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    })
  : null;

const R2_BUCKET = process.env.R2_BUCKET_NAME || 'dd-recordings';

if (!r2Client) {
  console.warn('R2 not configured - recordings will only be stored in memory. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME');
}


// Extract text from .docx files (Word documents)
async function extractDocxText(base64Content) {
  try {
    const buffer = Buffer.from(base64Content, 'base64');
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');

    if (!documentXml) {
      return '[Could not extract text from Word document]';
    }

    // Extract text from XML, removing tags
    const text = documentXml
      .replace(/<w:t[^>]*>([^<]*)<\/w:t>/g, '$1')  // Extract text content
      .replace(/<w:p[^>]*>/g, '\n')  // Paragraph breaks
      .replace(/<[^>]+>/g, '')  // Remove remaining tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\n\s*\n/g, '\n\n')  // Clean up multiple newlines
      .trim();

    console.log(`[DD] Extracted ${text.length} chars from DOCX`);
    return text || '[Empty Word document]';
  } catch (error) {
    console.error('[DD] DOCX extraction error:', error.message);
    return `[Error extracting Word document: ${error.message}]`;
  }
}

// Extract text from .pptx files (PowerPoint)
async function extractPptxText(base64Content) {
  try {
    const buffer = Buffer.from(base64Content, 'base64');
    const zip = await JSZip.loadAsync(buffer);

    const allText = [];
    let slideNum = 1;

    // Iterate through slide files
    for (const filename of Object.keys(zip.files)) {
      if (filename.match(/ppt\/slides\/slide\d+\.xml$/)) {
        const slideXml = await zip.file(filename)?.async('string');
        if (slideXml) {
          // Extract text from slide
          const slideText = slideXml
            .replace(/<a:t>([^<]*)<\/a:t>/g, '$1 ')  // Extract text
            .replace(/<a:p[^>]*>/g, '\n')  // Paragraph breaks
            .replace(/<[^>]+>/g, '')  // Remove tags
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();

          if (slideText) {
            allText.push(`[Slide ${slideNum}]\n${slideText}`);
          }
          slideNum++;
        }
      }
    }

    const result = allText.join('\n\n') || '[Empty PowerPoint]';
    console.log(`[DD] Extracted ${result.length} chars from PPTX (${slideNum - 1} slides)`);
    return result;
  } catch (error) {
    console.error('[DD] PPTX extraction error:', error.message);
    return `[Error extracting PowerPoint: ${error.message}]`;
  }
}

// Extract text from .xlsx files (Excel)
async function extractXlsxText(base64Content) {
  try {
    const buffer = Buffer.from(base64Content, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });

    const allText = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) {
        allText.push(`[Sheet: ${sheetName}]\n${csv}`);
      }
    }

    const result = allText.join('\n\n') || '[Empty Excel file]';
    console.log(`[DD] Extracted ${result.length} chars from XLSX`);
    return result;
  } catch (error) {
    console.error('[DD] XLSX extraction error:', error.message);
    return `[Error extracting Excel: ${error.message}]`;
  }
}


// Send email using SendGrid API
async function sendEmail(to, subject, html, attachments = null, maxRetries = 3) {
  const senderEmail = process.env.SENDER_EMAIL;
  const emailData = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: senderEmail, name: 'Find Target' },
    subject: subject,
    content: [{ type: 'text/html', value: html }]
  };

  if (attachments) {
    const attachmentList = Array.isArray(attachments) ? attachments : [attachments];
    emailData.attachments = attachmentList.map(a => ({
      filename: a.filename || a.name,  // Support both 'filename' and 'name' properties
      content: a.content,
      type: 'application/octet-stream',
      disposition: 'attachment'
    }));
  }

  // Retry logic with exponential backoff
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailData)
      });

      if (response.ok) {
        if (attempt > 1) {
          console.log(`  Email sent successfully on attempt ${attempt}`);
        }
        return { success: true };
      }

      const error = await response.text();
      lastError = new Error(`Email failed (attempt ${attempt}/${maxRetries}): ${error}`);
      console.error(lastError.message);

      // Don't retry on 4xx client errors (except 429 rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw lastError;
      }
    } catch (fetchError) {
      lastError = fetchError;
      console.error(`  Email attempt ${attempt}/${maxRetries} failed:`, fetchError.message);
    }

    // Exponential backoff: 2s, 4s, 8s
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`  Retrying email in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Email failed after all retries');
}

// ============ AI TOOLS ============

// Gemini 2.5 Flash-Lite - cost-effective for general tasks ($0.10/$0.40 per 1M tokens)
async function callGemini(prompt) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      timeout: 90000
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini 2.5 Flash-Lite HTTP error ${response.status}:`, errorText.substring(0, 200));
      return '';
    }

    const data = await response.json();

    if (data.error) {
      console.error('Gemini 2.5 Flash-Lite API error:', data.error.message);
      return '';
    }

    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!result) {
      console.warn('Gemini 2.5 Flash-Lite returned empty response');
    }
    return result;
  } catch (error) {
    console.error('Gemini 2.5 Flash-Lite error:', error.message);
    return '';
  }
}

// Gemini 2.5 Flash - stable model for validation tasks (upgraded from gemini-3-flash-preview which was unstable)
// With GPT-4o fallback when Gemini fails or times out
async function callGemini3Flash(prompt, jsonMode = false) {
  try {
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1  // Low temperature for consistent validation
      }
    };

    // Add JSON mode if requested
    if (jsonMode) {
      requestBody.generationConfig.responseMimeType = 'application/json';
    }

    // Using stable gemini-2.5-flash (gemini-3-flash-preview was unreliable)
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      timeout: 30000  // Reduced from 120s to 30s - fail fast and use GPT-4o fallback
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini 3 Flash HTTP error ${response.status}:`, errorText.substring(0, 200));
      // Fallback to GPT-4o on HTTP errors
      return await callGPT4oFallback(prompt, jsonMode, `Gemini HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      console.error('Gemini 3 Flash API error:', data.error.message);
      // Fallback to GPT-4o
      return await callGPT4oFallback(prompt, jsonMode, 'Gemini 3 Flash API error');
    }

    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!result) {
      // Empty response, try fallback
      return await callGPT4oFallback(prompt, jsonMode, 'Gemini 3 Flash empty response');
    }
    return result;
  } catch (error) {
    console.error('Gemini 3 Flash error:', error.message);
    // Fallback to GPT-4o on network timeout or other errors
    return await callGPT4oFallback(prompt, jsonMode, `Gemini error: ${error.message}`);
  }
}

// GPT-4o fallback function for when Gemini fails
async function callGPT4oFallback(prompt, jsonMode = false, reason = '') {
  try {
    console.log(`  Falling back to GPT-4o (reason: ${reason})...`);

    const requestOptions = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1
    };

    // Add JSON mode if requested
    if (jsonMode) {
      requestOptions.response_format = { type: 'json_object' };
    }

    const response = await openai.chat.completions.create(requestOptions);
    const result = response.choices?.[0]?.message?.content || '';

    if (result) {
      console.log('  GPT-4o fallback successful');
    }
    return result;
  } catch (fallbackError) {
    console.error('GPT-4o fallback error:', fallbackError.message);
    return ''; // Return empty if both fail
  }
}

// Gemini 2.5 Pro - Most capable model for critical validation tasks
// Use this for final data accuracy verification where errors are unacceptable
async function callGemini2Pro(prompt, jsonMode = false) {
  try {
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.0  // Zero temperature for deterministic validation
      }
    };

    if (jsonMode) {
      requestBody.generationConfig.responseMimeType = 'application/json';
    }

    // Using stable gemini-2.5-pro (upgraded from deprecated gemini-2.5-pro-preview-06-05)
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      timeout: 180000  // Longer timeout for Pro model
    });
    const data = await response.json();

    if (data.error) {
      console.error('Gemini 2.5 Pro API error:', data.error.message);
      return '';
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (error) {
    console.error('Gemini 2.5 Pro error:', error.message);
    return '';
  }
}

// Claude (Anthropic) - excellent reasoning and analysis
async function callClaude(prompt, systemPrompt = null, jsonMode = false) {
  if (!anthropic) {
    console.warn('Claude not available - ANTHROPIC_API_KEY not set');
    return '';
  }
  try {
    const messages = [{ role: 'user', content: prompt }];
    const requestParams = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages
    };

    if (systemPrompt) {
      requestParams.system = systemPrompt;
    }

    const response = await anthropic.messages.create(requestParams);
    const text = response.content?.[0]?.text || '';

    return text;
  } catch (error) {
    console.error('Claude error:', error.message);
    return '';
  }
}


async function callPerplexity(prompt) {
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-pro',  // Upgraded from 'sonar' for better search results
        messages: [{ role: 'user', content: prompt }]
      }),
      timeout: 90000
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Perplexity HTTP error ${response.status}:`, errorText.substring(0, 200));
      return '';
    }

    const data = await response.json();

    if (data.error) {
      console.error('Perplexity API error:', data.error.message || data.error);
      return '';
    }

    const result = data.choices?.[0]?.message?.content || '';
    if (!result) {
      console.warn('Perplexity returned empty response for prompt:', prompt.substring(0, 100));
    }
    return result;
  } catch (error) {
    console.error('Perplexity error:', error.message);
    return '';
  }
}

async function callChatGPT(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    });
    const result = response.choices[0].message.content || '';
    if (!result) {
      console.warn('ChatGPT returned empty response for prompt:', prompt.substring(0, 100));
    }
    return result;
  } catch (error) {
    console.error('ChatGPT error:', error.message);
    return '';
  }
}

// OpenAI Search model - has real-time web search capability
// Updated to use gpt-4o-search-preview (more stable than mini version)
async function callOpenAISearch(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-search-preview',
      messages: [{ role: 'user', content: prompt }]
    });
    const result = response.choices[0].message.content || '';
    if (!result) {
      console.warn('OpenAI Search returned empty response, falling back to ChatGPT');
      return callChatGPT(prompt);
    }
    return result;
  } catch (error) {
    console.error('OpenAI Search error:', error.message, '- falling back to ChatGPT');
    // Fallback to regular gpt-4o if search model not available
    return callChatGPT(prompt);
  }
}


// SerpAPI - Google Search integration
async function callSerpAPI(query) {
  if (!process.env.SERPAPI_API_KEY) {
    return '';
  }
  try {
    const params = new URLSearchParams({
      q: query,
      api_key: process.env.SERPAPI_API_KEY,
      engine: 'google',
      num: 100 // Get more results
    });
    const response = await fetch(`https://serpapi.com/search?${params}`, {
      timeout: 30000
    });
    const data = await response.json();

    // Extract organic results
    const results = [];
    if (data.organic_results) {
      for (const result of data.organic_results) {
        results.push({
          title: result.title || '',
          link: result.link || '',
          snippet: result.snippet || ''
        });
      }
    }
    return JSON.stringify(results);
  } catch (error) {
    console.error('SerpAPI error:', error.message);
    return '';
  }
}

// DeepSeek V3.2 - Cost-effective alternative to GPT-4o
async function callDeepSeek(prompt, maxTokens = 4000) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('DeepSeek API key not set, falling back to GPT-4o');
    return null; // Caller should handle fallback
  }
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3
      }),
      timeout: 120000
    });
    const data = await response.json();
    if (data.error) {
      console.error('DeepSeek API error:', data.error);
      return null;
    }
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('DeepSeek error:', error.message);
    return null;
  }
}


// ============ SEARCH CONFIGURATION ============

const CITY_MAP = {
  'malaysia': ['Kuala Lumpur', 'Penang', 'Johor Bahru', 'Shah Alam', 'Petaling Jaya', 'Selangor', 'Ipoh', 'Klang', 'Subang', 'Melaka', 'Kuching', 'Kota Kinabalu'],
  'singapore': ['Singapore', 'Jurong', 'Tuas', 'Woodlands'],
  'thailand': ['Bangkok', 'Chonburi', 'Rayong', 'Samut Prakan', 'Ayutthaya', 'Chiang Mai', 'Pathum Thani', 'Nonthaburi', 'Samut Sakhon'],
  'indonesia': ['Jakarta', 'Surabaya', 'Bandung', 'Medan', 'Bekasi', 'Tangerang', 'Semarang', 'Sidoarjo', 'Cikarang', 'Karawang', 'Bogor'],
  'vietnam': ['Ho Chi Minh City', 'Hanoi', 'Da Nang', 'Hai Phong', 'Binh Duong', 'Dong Nai', 'Long An', 'Ba Ria', 'Can Tho'],
  'philippines': ['Manila', 'Cebu', 'Davao', 'Quezon City', 'Makati', 'Laguna', 'Cavite', 'Batangas', 'Bulacan'],
  'southeast asia': ['Kuala Lumpur', 'Singapore', 'Bangkok', 'Jakarta', 'Ho Chi Minh City', 'Manila', 'Penang', 'Johor Bahru', 'Surabaya', 'Hanoi']
};

const LOCAL_SUFFIXES = {
  'malaysia': ['Sdn Bhd', 'Berhad'],
  'singapore': ['Pte Ltd', 'Private Limited'],
  'thailand': ['Co Ltd', 'Co., Ltd.'],
  'indonesia': ['PT', 'CV'],
  'vietnam': ['Co Ltd', 'JSC', 'Công ty'],
  'philippines': ['Inc', 'Corporation']
};

const DOMAIN_MAP = {
  'malaysia': '.my',
  'singapore': '.sg',
  'thailand': '.th',
  'indonesia': '.co.id',
  'vietnam': '.vn',
  'philippines': '.ph'
};

const LOCAL_LANGUAGE_MAP = {
  'thailand': { lang: 'Thai', examples: ['หมึก', 'สี', 'เคมี'] },
  'vietnam': { lang: 'Vietnamese', examples: ['mực in', 'sơn', 'hóa chất'] },
  'indonesia': { lang: 'Bahasa Indonesia', examples: ['tinta', 'cat', 'kimia'] },
  'philippines': { lang: 'Tagalog', examples: ['tinta', 'pintura'] },
  'malaysia': { lang: 'Bahasa Malaysia', examples: ['dakwat', 'cat'] }
};

// ============ 14 SPECIALIZED SEARCH STRATEGIES (inspired by n8n workflow) ============

function buildOutputFormat() {
  return `For each company provide: company_name, website (URL starting with http), hq (format: "City, Country" only).
Be thorough - include all companies you find. We will verify them later.`;
}

// Strategy 1: Broad Google Search (SerpAPI)
function strategy1_BroadSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  // Generate synonyms and variations
  const terms = business.split(/\s+or\s+|\s+and\s+|,/).map(t => t.trim()).filter(t => t);

  for (const c of countries) {
    queries.push(
      `${business} companies ${c}`,
      `${business} manufacturers ${c}`,
      `${business} suppliers ${c}`,
      `list of ${business} companies in ${c}`,
      `${business} industry ${c}`
    );
    for (const term of terms) {
      queries.push(`${term} ${c}`);
    }
  }

  return queries;
}

// Strategy 2: Broad Perplexity Search (EXPANDED)
function strategy2_BroadPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  // General queries
  queries.push(
    `Find ALL ${business} companies headquartered in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Complete list of ${business} manufacturers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} producers and makers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `All local ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `SME and family-owned ${business} businesses in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Independent ${business} companies in ${country} not owned by multinationals. ${outputFormat}`
  );

  // Per-country queries for more specificity
  for (const c of countries) {
    queries.push(
      `List all ${business} companies based in ${c}. ${outputFormat}`,
      `${business} factories and plants in ${c}. ${outputFormat}`,
      `Local ${business} manufacturers in ${c}. ${outputFormat}`
    );
  }

  return queries;
}

// Strategy 3: Lists, Rankings, Top Companies (SerpAPI)
function strategy3_ListsSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  for (const c of countries) {
    queries.push(
      `top ${business} companies ${c}`,
      `biggest ${business} ${c}`,
      `leading ${business} manufacturers ${c}`,
      `list of ${business} ${c}`,
      `best ${business} suppliers ${c}`,
      `${business} industry ${c} overview`,
      `major ${business} players ${c}`
    );
  }

  return queries;
}

// Strategy 4: City-Specific Search (Perplexity) - EXPANDED to ALL cities
function strategy4_CitiesPerplexity(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const outputFormat = buildOutputFormat();
  const queries = [];

  for (const c of countries) {
    const cities = CITY_MAP[c.toLowerCase()] || [c];
    // Use ALL cities, not just top 5
    for (const city of cities) {
      queries.push(
        `${business} companies in ${city}, ${c}. Exclude ${exclusion}. ${outputFormat}`,
        `${business} manufacturers near ${city}. ${outputFormat}`
      );
    }
  }

  return queries;
}

// Strategy 5: Industrial Zones + Local Naming (SerpAPI)
function strategy5_IndustrialSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  for (const c of countries) {
    const suffixes = LOCAL_SUFFIXES[c.toLowerCase()] || [];

    // Local naming conventions
    for (const suffix of suffixes) {
      queries.push(`${business} ${suffix} ${c}`);
    }

    // Industrial zones
    queries.push(
      `${business} industrial estate ${c}`,
      `${business} manufacturing zone ${c}`,
      `${business} factory ${c}`
    );
  }

  return queries;
}

// Strategy 6: Associations & Directories (Perplexity)
function strategy6_DirectoriesPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} companies in trade associations in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} firms in Kompass directory for ${country}. Not ${exclusion}. ${outputFormat}`,
    `Chamber of commerce ${business} members in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${country} ${business} industry association member list. No ${exclusion}. ${outputFormat}`,
    `${business} companies on Yellow Pages ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} business directory ${country}. Exclude ${exclusion}. ${outputFormat}`
  ];
}

// Strategy 7: Trade Shows & Exhibitions (Perplexity)
function strategy7_ExhibitionsPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} exhibitors at trade shows in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies at industry exhibitions in ${country} region. Not ${exclusion}. ${outputFormat}`,
    `${business} participants at expos and conferences in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors at international fairs from ${country}. Not ${exclusion}. ${outputFormat}`
  ];
}

// Strategy 8: Import/Export & Supplier Databases (Perplexity)
function strategy8_TradePerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} importers and exporters in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} suppliers on Alibaba from ${country}. Not ${exclusion}. ${outputFormat}`,
    `${country} ${business} companies on Global Sources. Exclude ${exclusion}. ${outputFormat}`,
    `${business} OEM suppliers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} contract manufacturers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} approved vendors in ${country}. Exclude ${exclusion}. ${outputFormat}`
  ];
}

// Strategy 9: Local Domains + News (Perplexity)
function strategy9_DomainsPerplexity(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const outputFormat = buildOutputFormat();
  const queries = [];

  for (const c of countries) {
    const domain = DOMAIN_MAP[c.toLowerCase()];
    if (domain) {
      queries.push(
        `${business} companies with ${domain} websites. Exclude ${exclusion}. ${outputFormat}`
      );
    }
  }

  queries.push(
    `Recent news about ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} company announcements and press releases ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  return queries;
}

// Strategy 10: Government Registries (SerpAPI)
function strategy10_RegistriesSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  for (const c of countries) {
    queries.push(
      `${business} company registration ${c}`,
      `${business} registered companies ${c}`,
      `${business} business registry ${c}`
    );
  }

  return queries;
}

// Strategy 11: City + Industrial Areas (SerpAPI) - EXPANDED
function strategy11_CityIndustrialSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  for (const c of countries) {
    const cities = CITY_MAP[c.toLowerCase()] || [c];
    // Use ALL cities
    for (const city of cities) {
      queries.push(
        `${business} ${city}`,
        `${business} companies ${city}`,
        `${business} factory ${city}`,
        `${business} manufacturer ${city}`
      );
    }
  }

  return queries;
}

// Strategy 12: Deep Web Search (OpenAI Search) - EXPANDED with real-time search
function strategy12_DeepOpenAISearch(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  // General deep searches
  queries.push(
    `Search the web for ${business} companies in ${country}. Find company websites, LinkedIn profiles, industry directories. Exclude ${exclusion}. ${outputFormat}`,
    `Find lesser-known ${business} companies in ${country} that may not appear in top search results. ${outputFormat}`,
    `Search for small and medium ${business} enterprises (SMEs) in ${country}. ${outputFormat}`,
    `Find independent local ${business} companies in ${country}, not subsidiaries of multinationals. ${outputFormat}`,
    `Search industry news and press releases for ${business} companies in ${country}. ${outputFormat}`,
    `Find ${business} startups and new companies in ${country}. ${outputFormat}`
  );

  // Per-country deep searches
  for (const c of countries) {
    queries.push(
      `Search for all ${business} manufacturers in ${c}. Include company name, website, and location. ${outputFormat}`,
      `Find ${business} producers in ${c} with their official websites. ${outputFormat}`
    );
  }

  return queries;
}

// Strategy 13: Industry Publications (Perplexity)
function strategy13_PublicationsPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} companies mentioned in industry magazines and trade publications for ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} market report ${country} - list all companies mentioned. Not ${exclusion}. ${outputFormat}`,
    `${business} industry analysis ${country} - companies covered. Exclude ${exclusion}. ${outputFormat}`,
    `${business} ${country} magazine articles listing companies. Not ${exclusion}. ${outputFormat}`
  ];
}

// Strategy 14: Final Sweep - Local Language + Comprehensive (OpenAI Search)
function strategy14_LocalLanguageOpenAISearch(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const outputFormat = buildOutputFormat();
  const queries = [];

  // Local language searches
  queries.push(
    `Search for ${business} companies in ${country} using local language terms. Translate "${business}" to Thai, Vietnamese, Bahasa Indonesia, Tagalog, Malay as appropriate. ${outputFormat}`
  );

  for (const c of countries) {
    const langInfo = LOCAL_LANGUAGE_MAP[c.toLowerCase()];
    if (langInfo) {
      queries.push(
        `Search in ${langInfo.lang} for ${business} companies in ${c}. ${outputFormat}`,
        `Find ${business} manufacturers in ${c} using local language search terms. ${outputFormat}`
      );
    }
  }

  // Supply chain and related industry searches
  queries.push(
    `Find companies in the ${business} supply chain in ${country}. Include raw material suppliers and equipment makers. ${outputFormat}`,
    `Search for ${business} related companies in ${country}: formulators, blenders, repackagers. ${outputFormat}`,
    `Find niche and specialty ${business} companies in ${country}. ${outputFormat}`
  );

  // Final comprehensive sweep
  queries.push(
    `Comprehensive search: Find ALL ${business} companies in ${country} that have not been mentioned yet. Search obscure directories, local business listings, industry forums. ${outputFormat}`
  );

  return queries;
}

// ============ EXTRACTION WITH GPT-4o-mini ============

async function extractCompanies(text, country) {
  if (!text || text.length < 50) return [];
  try {
    const extraction = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extract company information from the text. Return JSON: {"companies": [{"company_name": "...", "website": "...", "hq": "..."}]}

RULES:
- Extract ALL companies mentioned that could be in: ${country}
- website must start with http:// or https://
- If website not in text, you may look it up if you know it's a real company
- hq must be "City, Country" format ONLY
- Include companies even if some info is incomplete - we'll verify later
- Be thorough - extract every company that might match`
        },
        { role: 'user', content: text.substring(0, 15000) }
      ],
      response_format: { type: 'json_object' }
    });
    const parsed = JSON.parse(extraction.choices[0].message.content);
    return Array.isArray(parsed.companies) ? parsed.companies : [];
  } catch (e) {
    console.error('Extraction error:', e.message);
    return [];
  }
}

// ============ DEDUPLICATION (Enhanced for v20) ============

function normalizeCompanyName(name) {
  if (!name) return '';
  return name.toLowerCase()
    // Remove ALL common legal suffixes globally (expanded list)
    .replace(/\s*(sdn\.?\s*bhd\.?|bhd\.?|berhad|pte\.?\s*ltd\.?|ltd\.?|limited|inc\.?|incorporated|corp\.?|corporation|co\.?,?\s*ltd\.?|llc|llp|gmbh|s\.?a\.?|pt\.?|cv\.?|tbk\.?|jsc|plc|public\s*limited|private\s*limited|joint\s*stock|company|\(.*?\))$/gi, '')
    // Also remove these if they appear anywhere (for cases like "PT Company Name")
    .replace(/^(pt\.?|cv\.?)\s+/gi, '')
    .replace(/[^\w\s]/g, '')  // Remove special characters
    .replace(/\s+/g, ' ')      // Normalize spaces
    .trim();
}

function normalizeWebsite(url) {
  if (!url) return '';
  return url.toLowerCase()
    .replace(/^https?:\/\//, '')           // Remove protocol
    .replace(/^www\./, '')                  // Remove www
    .replace(/\/+$/, '')                    // Remove trailing slashes
    // Remove common path suffixes that don't differentiate companies
    .replace(/\/(home|index|main|default|about|about-us|contact|products?|services?|en|th|id|vn|my|sg|ph|company)(\/.*)?$/i, '')
    .replace(/\.(html?|php|aspx?|jsp)$/i, ''); // Remove file extensions
}

// Extract domain root for additional deduplication
function extractDomainRoot(url) {
  const normalized = normalizeWebsite(url);
  // Get just the domain without any path
  return normalized.split('/')[0];
}

function dedupeCompanies(allCompanies) {
  const seenWebsites = new Map();
  const seenDomains = new Map();
  const seenNames = new Map();
  const results = [];

  for (const c of allCompanies) {
    if (!c || !c.website || !c.company_name) continue;
    if (!c.website.startsWith('http')) continue;

    const websiteKey = normalizeWebsite(c.website);
    const domainKey = extractDomainRoot(c.website);
    const nameKey = normalizeCompanyName(c.company_name);

    // Skip if we've seen this exact URL, domain, or normalized name
    if (seenWebsites.has(websiteKey)) continue;
    if (seenDomains.has(domainKey)) continue;
    if (nameKey && seenNames.has(nameKey)) continue;

    seenWebsites.set(websiteKey, true);
    seenDomains.set(domainKey, true);
    if (nameKey) seenNames.set(nameKey, true);
    results.push(c);
  }

  return results;
}

// ============ PRE-FILTER: Remove only obvious non-company URLs ============

function isSpamOrDirectoryURL(url) {
  if (!url) return true;
  const urlLower = url.toLowerCase();

  // Only filter out obvious non-company URLs (very conservative)
  const obviousSpam = [
    'wikipedia.org',
    'facebook.com',
    'twitter.com',
    'instagram.com',
    'youtube.com'
  ];

  for (const pattern of obviousSpam) {
    if (urlLower.includes(pattern)) return true;
  }

  return false;
}


// ============ EXHAUSTIVE PARALLEL SEARCH WITH 14 STRATEGIES ============

// Process SerpAPI results and extract companies using GPT
async function processSerpResults(serpResults, business, country, exclusion) {
  if (!serpResults || serpResults.length === 0) return [];

  const outputFormat = buildOutputFormat();
  const prompt = `From these Google search results, extract companies that match:
- Business: ${business}
- Country: ${country}
- Exclude: ${exclusion}

Search Results:
${serpResults.join('\n\n')}

${outputFormat}`;

  const response = await callChatGPT(prompt);
  return extractCompanies(response, country);
}


// ============ WEBSITE VERIFICATION ============

async function verifyWebsite(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);

    if (!response.ok) return { valid: false, reason: `HTTP ${response.status}` };

    const html = await response.text();
    const lowerHtml = html.toLowerCase();

    // Check for parked domain / placeholder signs
    const parkedSigns = [
      'domain is for sale',
      'buy this domain',
      'this domain is parked',
      'parked by',
      'domain parking',
      'this page is under construction',
      'coming soon',
      'website coming soon',
      'under maintenance',
      'godaddy',
      'namecheap parking',
      'sedoparking',
      'hugedomains',
      'afternic',
      'domain expired',
      'this site can\'t be reached',
      'page not found',
      '404 not found',
      'website not found'
    ];

    for (const sign of parkedSigns) {
      if (lowerHtml.includes(sign)) {
        return { valid: false, reason: `Parked/placeholder: "${sign}"` };
      }
    }

    // Check for minimal content (likely placeholder)
    const textContent = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (textContent.length < 200) {
      return { valid: false, reason: 'Too little content (likely placeholder)' };
    }

    return { valid: true, content: textContent.substring(0, 15000) };
  } catch (e) {
    return { valid: false, reason: e.message || 'Connection failed' };
  }
}


// ============ FETCH WEBSITE FOR VALIDATION ============

async function fetchWebsite(url) {
  // Security block patterns - these indicate WAF/Cloudflare/bot protection
  const securityBlockPatterns = [
    'checking your browser',
    'please wait',
    'just a moment',
    'ddos protection',
    'cloudflare',
    'security check',
    'access denied',
    'not acceptable',
    'mod_security',
    'forbidden',
    'blocked',
    'captcha',
    'verify you are human',
    'bot detection',
    'please enable javascript',
    'enable cookies'
  ];

  const tryFetch = async (targetUrl) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000); // Increased to 20 seconds
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        },
        signal: controller.signal,
        redirect: 'follow'
      });
      clearTimeout(timeout);

      // Check for HTTP-level blocks
      if (response.status === 403 || response.status === 406) {
        return { status: 'security_blocked', reason: `HTTP ${response.status} - WAF/Security block` };
      }
      if (!response.ok) return { status: 'error', reason: `HTTP ${response.status}` };

      const html = await response.text();
      const lowerHtml = html.toLowerCase();

      // Check for security block patterns in content
      for (const pattern of securityBlockPatterns) {
        if (lowerHtml.includes(pattern) && html.length < 5000) {
          // Only flag as security block if page is small (likely a challenge page)
          return { status: 'security_blocked', reason: `Security protection detected: "${pattern}"` };
        }
      }

      const cleanText = html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 15000);

      if (cleanText.length > 100) {
        return { status: 'ok', content: cleanText };
      }
      return { status: 'insufficient', reason: 'Content too short' };
    } catch (e) {
      return { status: 'error', reason: e.message || 'Connection failed' };
    }
  };

  // Parse base URL
  let baseUrl = url;
  try {
    const parsed = new URL(url);
    baseUrl = `${parsed.protocol}//${parsed.host}`;
  } catch (e) {
    baseUrl = url.replace(/\/+$/, '');
  }

  // Try original URL first
  let result = await tryFetch(url);
  if (result.status === 'ok') return result;
  if (result.status === 'security_blocked') return result; // Return security block immediately

  // Try with/without www
  const hasWww = baseUrl.includes('://www.');
  const altBaseUrl = hasWww ? baseUrl.replace('://www.', '://') : baseUrl.replace('://', '://www.');

  // Try alternative paths on BOTH original and www/non-www variants
  const urlVariants = [baseUrl, altBaseUrl];
  const urlPaths = ['', '/en', '/home', '/about', '/index.html', '/index.php'];

  for (const variant of urlVariants) {
    for (const path of urlPaths) {
      const testUrl = variant + path;
      result = await tryFetch(testUrl);
      if (result.status === 'ok') return result;
      if (result.status === 'security_blocked') return result;
    }
  }

  // Try HTTPS if original was HTTP (on both variants)
  if (url.startsWith('http://')) {
    for (const variant of urlVariants) {
      const httpsVariant = variant.replace('http://', 'https://');
      result = await tryFetch(httpsVariant);
      if (result.status === 'ok') return result;
      if (result.status === 'security_blocked') return result;
    }
  }

  return { status: 'inaccessible', reason: 'Could not fetch content from any URL variation' };
}

// ============ DYNAMIC EXCLUSION RULES BUILDER (n8n-style PAGE SIGNAL detection) ============

function buildExclusionRules(exclusion, business) {
  const exclusionLower = exclusion.toLowerCase();
  let rules = '';

  // Detect if user wants to exclude LARGE companies - use PAGE SIGNALS like n8n
  if (exclusionLower.includes('large') || exclusionLower.includes('big') ||
      exclusionLower.includes('mnc') || exclusionLower.includes('multinational') ||
      exclusionLower.includes('major') || exclusionLower.includes('giant')) {
    rules += `
LARGE COMPANY DETECTION - Look for these PAGE SIGNALS to REJECT:
- "global presence", "worldwide operations", "global leader", "world's largest"
- Stock ticker symbols or mentions of: NYSE, NASDAQ, SGX, SET, IDX, listed, IPO
- "multinational", "global network", offices/operations in 10+ countries
- Revenue figures >$100M, employee count >1000
- "Fortune 500", "Forbes Global"
- Company name contains known MNC: Toyo Ink, Sakata, Flint, Siegwerk, Sun Chemical, DIC
- Website says "subsidiary of", "part of [X] Group", "member of [X] Group"
- Company name ends with "Tbk" (Indonesian listed)

If NONE of these signals are found → ACCEPT (assume local company)
`;
  }

  // Detect if user wants to exclude LISTED/PUBLIC companies
  if (exclusionLower.includes('listed') || exclusionLower.includes('public')) {
    rules += `
LISTED COMPANY DETECTION - REJECT if page shows:
- Stock ticker, NYSE, NASDAQ, SGX, SET, IDX, or any stock exchange
- "publicly traded", "listed company", "IPO"
- Company name contains "Tbk"
`;
  }

  // Detect if user wants to exclude DISTRIBUTORS
  if (exclusionLower.includes('distributor')) {
    rules += `
DISTRIBUTOR DETECTION - REJECT only if:
- Company ONLY distributes/resells with NO manufacturing
- No mention of factory, plant, production facility, "we manufacture"

ACCEPT if they manufacture (even if also distribute) - most manufacturers also sell their products
`;
  }

  return rules;
}

// ============ VALIDATION (v24 - GPT-4o with LENIENT filtering) ============

async function validateCompanyStrict(company, business, country, exclusion, pageText) {
  // If we couldn't fetch the website, validate by name only (give benefit of doubt)
  const contentToValidate = (typeof pageText === 'string' && pageText) ? pageText : `Company name: ${company.company_name}. Validate based on name only.`;

  const exclusionRules = buildExclusionRules(exclusion, business);

  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o',  // Use smarter model for better validation
      messages: [
        {
          role: 'system',
          content: `You are a company validator for M&A research. Be LENIENT - when in doubt, ACCEPT.

VALIDATION TASK:
- Business sought: "${business}"
- Target countries: ${country}
- Exclusions: ${exclusion}

VALIDATION RULES:

1. LOCATION CHECK:
- Is HQ in one of the target countries (${country})?
- IMPORTANT: If country is a REGION like "Southeast Asia", accept companies in ANY Southeast Asian country (Malaysia, Thailand, Vietnam, Indonesia, Philippines, Singapore, etc.)
- If HQ is clearly outside the target region → REJECT

2. BUSINESS MATCH (BE LENIENT):
- Does the company's business relate to "${business}"?
- Accept related products, services, manufacturers, suppliers
- Only reject if COMPLETELY unrelated

3. EXCLUSION CHECK:
${exclusionRules}
- For "large companies" exclusion: REJECT both large multinationals AND their subsidiaries
- Example: "DIC Indonesia", "Toyo Ink Philippines", "Sun Chemical" → REJECT (subsidiaries of large corporations)
- Only accept truly independent SMEs and local companies

4. SPAM CHECK:
- Only reject obvious directories, marketplaces, domain-for-sale sites

OUTPUT: Return JSON only: {"valid": true/false, "reason": "one sentence"}`
        },
        {
          role: 'user',
          content: `COMPANY: ${company.company_name}
WEBSITE: ${company.website}
HQ: ${company.hq}

PAGE CONTENT:
${contentToValidate.substring(0, 10000)}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(validation.choices[0].message.content);
    if (result.valid === true) {
      return { valid: true, corrected_hq: company.hq };
    }
    console.log(`    Rejected: ${company.company_name} - ${result.reason}`);
    return { valid: false };
  } catch (e) {
    // On error, accept (benefit of doubt)
    console.log(`    Error validating ${company.company_name}, accepting`);
    return { valid: true, corrected_hq: company.hq };
  }
}

async function parallelValidationStrict(companies, business, country, exclusion) {
  console.log(`\nSTRICT Validating ${companies.length} verified companies...`);
  const startTime = Date.now();
  const batchSize = 10; // Increased for better parallelization
  const validated = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    try {
      const batch = companies.slice(i, i + batchSize);
      if (!batch || batch.length === 0) continue;

      // Use cached _pageContent from verification step, or fetch if not available
      // Add .catch() to prevent any single failure from crashing the batch
      const pageTexts = await Promise.all(
        batch.map(c => {
          try {
            return c?._pageContent ? Promise.resolve(c._pageContent) : fetchWebsite(c?.website).catch(() => null);
          } catch (e) {
            return Promise.resolve(null);
          }
        })
      );

      // Add .catch() to each validation to prevent single failures from crashing batch
      const validations = await Promise.all(
        batch.map((company, idx) => {
          try {
            return validateCompanyStrict(company, business, country, exclusion, pageTexts[idx])
              .catch(e => {
                console.error(`  Validation error for ${company?.company_name}: ${e.message}`);
                return { valid: true, corrected_hq: company?.hq }; // Accept on error
              });
          } catch (e) {
            return Promise.resolve({ valid: true, corrected_hq: company?.hq });
          }
        })
      );

      batch.forEach((company, idx) => {
        try {
          if (validations[idx]?.valid && company) {
            // Remove internal _pageContent before adding to results
            const { _pageContent, ...cleanCompany } = company;
            validated.push({
              ...cleanCompany,
              hq: validations[idx].corrected_hq || company.hq
            });
          }
        } catch (e) {
          console.error(`  Error processing company ${company?.company_name}: ${e.message}`);
        }
      });

      console.log(`  Validated ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid: ${validated.length}`);
    } catch (batchError) {
      console.error(`  Batch error at ${i}-${i + batchSize}: ${batchError.message}`);
      // Continue to next batch instead of crashing
    }
  }

  console.log(`STRICT Validation done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Valid: ${validated.length}`);
  return validated;
}

// ============ VALIDATION FOR SLOW MODE (v23 - n8n style) ============

async function validateCompany(company, business, country, exclusion, pageText) {
  const exclusionRules = buildExclusionRules(exclusion, business);

  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a company validator. Be LENIENT on business match. Be STRICT on exclusions by detecting signals in page content.

VALIDATION TASK:
- Business sought: "${business}"
- Target countries: ${country}
- Exclusions: ${exclusion}

VALIDATION RULES:

1. LOCATION CHECK:
- Is HQ actually in one of the target countries (${country})?
- If HQ is outside these countries → REJECT

2. BUSINESS MATCH (BE LENIENT):
- Does the company's business relate to "${business}"?
- Accept related products, services, or sub-categories
- Only reject if completely unrelated

3. EXCLUSION CHECK - DETECT VIA PAGE SIGNALS:
${exclusionRules}

4. SPAM CHECK:
- Is this a directory, marketplace, domain-for-sale, or aggregator site? → REJECT

OUTPUT: Return JSON: {"valid": true/false, "reason": "brief", "corrected_hq": "City, Country or null"}`
        },
        {
          role: 'user',
          content: `COMPANY: ${company.company_name}
WEBSITE: ${company.website}
HQ: ${company.hq}

PAGE CONTENT:
${(typeof pageText === 'string' && pageText) ? pageText.substring(0, 8000) : 'Could not fetch - validate by name only'}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(validation.choices[0].message.content);
    if (result.valid === true) {
      return { valid: true, corrected_hq: result.corrected_hq || company.hq };
    }
    console.log(`    Rejected: ${company.company_name} - ${result.reason}`);
    return { valid: false };
  } catch (e) {
    // On error, accept (benefit of doubt)
    console.log(`    Error validating ${company.company_name}, accepting`);
    return { valid: true, corrected_hq: company.hq };
  }
}

async function parallelValidation(companies, business, country, exclusion) {
  console.log(`\nValidating ${companies.length} companies (strict large company filter)...`);
  const startTime = Date.now();
  const batchSize = 8; // Smaller batch for more thorough validation
  const validated = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    try {
      const batch = companies.slice(i, i + batchSize);
      if (!batch || batch.length === 0) continue;

      const pageTexts = await Promise.all(
        batch.map(c => fetchWebsite(c?.website).catch(() => null))
      );
      const validations = await Promise.all(
        batch.map((company, idx) =>
          validateCompany(company, business, country, exclusion, pageTexts[idx])
            .catch(e => {
              console.error(`  Validation error for ${company?.company_name}: ${e.message}`);
              return { valid: true, corrected_hq: company?.hq };
            })
        )
      );

      batch.forEach((company, idx) => {
        try {
          if (validations[idx]?.valid && company) {
            validated.push({
              ...company,
              hq: validations[idx].corrected_hq || company.hq
            });
          }
        } catch (e) {
          console.error(`  Error processing company ${company?.company_name}: ${e.message}`);
        }
      });

      console.log(`  Validated ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid: ${validated.length}`);
    } catch (batchError) {
      console.error(`  Batch error at ${i}-${i + batchSize}: ${batchError.message}`);
    }
  }

  console.log(`Validation done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Valid: ${validated.length}`);
  return validated;
}

// ============ EMAIL ============

function buildEmailHTML(companies, business, country, exclusion) {
  let html = `
    <h2>Find Target Results</h2>
    <p><strong>Business:</strong> ${escapeHtml(business)}</p>
    <p><strong>Country:</strong> ${escapeHtml(country)}</p>
    <p><strong>Exclusion:</strong> ${escapeHtml(exclusion)}</p>
    <p><strong>Companies Found:</strong> ${companies.length}</p>
    <br>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead style="background-color: #f0f0f0;">
        <tr><th>#</th><th>Company</th><th>Website</th><th>Headquarters</th></tr>
      </thead>
      <tbody>
  `;
  companies.forEach((c, i) => {
    html += `<tr><td>${i + 1}</td><td>${escapeHtml(c.company_name)}</td><td><a href="${escapeHtml(c.website)}">${escapeHtml(c.website)}</a></td><td>${escapeHtml(c.hq)}</td></tr>`;
  });
  html += '</tbody></table>';
  return html;
}

// ============ FAST ENDPOINT ============

// ============ PROFILE SLIDES ============

// Country to flag code mapping
const COUNTRY_FLAG_MAP = {
  'philippines': 'PH', 'ph': 'PH', 'manila': 'PH',
  'thailand': 'TH', 'th': 'TH', 'bangkok': 'TH',
  'malaysia': 'MY', 'my': 'MY', 'kuala lumpur': 'MY',
  'indonesia': 'ID', 'id': 'ID', 'jakarta': 'ID',
  'singapore': 'SG', 'sg': 'SG',
  'vietnam': 'VN', 'vn': 'VN', 'ho chi minh': 'VN', 'hanoi': 'VN',
  'japan': 'JP', 'jp': 'JP', 'tokyo': 'JP',
  'china': 'CN', 'cn': 'CN', 'beijing': 'CN', 'shanghai': 'CN',
  'korea': 'KR', 'kr': 'KR', 'seoul': 'KR',
  'taiwan': 'TW', 'tw': 'TW', 'taipei': 'TW',
  'usa': 'US', 'us': 'US', 'united states': 'US', 'america': 'US',
  'uk': 'GB', 'united kingdom': 'GB', 'england': 'GB', 'london': 'GB',
  'australia': 'AU', 'au': 'AU', 'sydney': 'AU',
  'india': 'IN', 'in': 'IN', 'mumbai': 'IN', 'delhi': 'IN',
  'hong kong': 'HK', 'hk': 'HK'
};

// Valid Singapore areas/districts (hardcoded since Singapore is small)
// "Central" is NOT a valid area - it's a made-up placeholder
const VALID_SINGAPORE_AREAS = [
  // West
  'jurong', 'jurong east', 'jurong west', 'tuas', 'pioneer', 'boon lay', 'clementi', 'bukit batok', 'bukit panjang', 'choa chu kang',
  // North
  'woodlands', 'sembawang', 'yishun', 'admiralty', 'marsiling',
  // Northeast
  'sengkang', 'punggol', 'hougang', 'serangoon', 'ang mo kio', 'bishan',
  // East
  'changi', 'tampines', 'pasir ris', 'bedok', 'simei', 'tanah merah', 'loyang',
  // Central
  'orchard', 'somerset', 'bugis', 'city hall', 'raffles place', 'marina bay', 'tanjong pagar', 'chinatown', 'little india', 'lavender', 'kallang', 'geylang', 'aljunied', 'paya lebar', 'eunos', 'kembangan', 'macpherson',
  // South
  'sentosa', 'harbourfront', 'telok blangah', 'bukit merah', 'alexandra', 'queenstown', 'commonwealth', 'tiong bahru',
  // Industrial areas
  'toh tuck', 'ubi', 'tai seng', 'benoi', 'kaki bukit', 'defu', 'senoko', 'kranji', 'sungei kadut', 'joo koon'
];

// Check if a Singapore area is valid
function isValidSingaporeArea(area) {
  if (!area) return false;
  const lower = area.toLowerCase().trim();
  // "Central" alone is NOT valid
  if (lower === 'central') return false;
  // Check if any valid area matches
  return VALID_SINGAPORE_AREAS.some(valid => lower.includes(valid) || valid.includes(lower));
}

// Common shortform definitions
const SHORTFORM_DEFINITIONS = {
  'HQ': 'Headquarters',
  'SEA': 'Southeast Asia',
  'THB': 'Thai Baht',
  'PHP': 'Philippine Peso',
  'MYR': 'Malaysian Ringgit',
  'IDR': 'Indonesian Rupiah',
  'SGD': 'Singapore Dollar',
  'VND': 'Vietnamese Dong',
  'USD': 'US Dollar',
  'JPY': 'Japanese Yen',
  'CNY': 'Chinese Yuan',
  'KRW': 'Korean Won',
  'TWD': 'Taiwan Dollar',
  'INR': 'Indian Rupee',
  'HKD': 'Hong Kong Dollar',
  'AUD': 'Australian Dollar',
  'GBP': 'British Pound',
  'EUR': 'Euro',
  'ISO': 'International Organization for Standardization',
  'B2B': 'Business to Business',
  'B2C': 'Business to Consumer',
  'R&D': 'Research and Development',
  'OEM': 'Original Equipment Manufacturer',
  'ODM': 'Original Design Manufacturer',
  'SME': 'Small and Medium Enterprise',
  'CAGR': 'Compound Annual Growth Rate',
  'YoY': 'Year over Year',
  'QoQ': 'Quarter over Quarter',
  'FY': 'Fiscal Year',
  'M': 'Million',
  'B': 'Billion',
  'K': 'Thousand',
  'DBD': 'Department of Business Development',
  'EBITDA': 'Earnings Before Interest, Taxes, Depreciation and Amortization',
  'ROE': 'Return on Equity',
  'ROI': 'Return on Investment',
  'GM': 'Gross Margin',
  'NM': 'Net Margin',
  'JV': 'Joint Venture',
  'M&A': 'Mergers and Acquisitions',
  'IPO': 'Initial Public Offering',
  'CEO': 'Chief Executive Officer',
  'CFO': 'Chief Financial Officer',
  'COO': 'Chief Operating Officer',
  'HoHo': 'Ho Chi Minh City',
  'KL': 'Kuala Lumpur',
  'BKK': 'Bangkok',
  'JKT': 'Jakarta',
  'MNL': 'Manila',
  'SG': 'Singapore',
  'ISP': 'Internet Service Provider',
  'IBC': 'International Broadcasting',
  'IT': 'Information Technology',
  'AI': 'Artificial Intelligence',
  'IoT': 'Internet of Things',
  'ERP': 'Enterprise Resource Planning',
  'CRM': 'Customer Relationship Management',
  'SaaS': 'Software as a Service',
  'API': 'Application Programming Interface',
  'IP-KVM': 'Internet Protocol Keyboard Video Mouse',
  'KVM': 'Keyboard Video Mouse',
  'CCTV': 'Closed-Circuit Television',
  'UPS': 'Uninterruptible Power Supply',
  'NEC': 'Nippon Electric Company',
  'HACCP': 'Hazard Analysis Critical Control Point',
  'GMP': 'Good Manufacturing Practice',
  'CE': 'Conformité Européenne',
  'FDA': 'Food and Drug Administration',
  'SKU': 'Stock Keeping Unit',
  'POE': 'Power over Ethernet',
  'LAN': 'Local Area Network',
  'WAN': 'Wide Area Network',
  'VPN': 'Virtual Private Network'
};

// Exchange rate mapping by country (for footnote)
const EXCHANGE_RATE_MAP = {
  'PH': '為替レート: PHP 100M = 3億円',
  'TH': '為替レート: THB 100M = 5億円',
  'MY': '為替レート: MYR 10M = 3億円',
  'ID': '為替レート: IDR 100B = 10億円',
  'SG': '為替レート: SGD 1M = 1億円',
  'VN': '為替レート: VND 100B = 6億円',
  'JP': '',
  'CN': '為替レート: CNY 10M = 2億円',
  'KR': '為替レート: KRW 1B = 1億円',
  'TW': '為替レート: TWD 10M = 0.5億円',
  'US': '為替レート: USD 1M = 1.5億円',
  'GB': '為替レート: GBP 1M = 2億円',
  'AU': '為替レート: AUD 1M = 1億円',
  'IN': '為替レート: INR 100M = 2億円',
  'HK': '為替レート: HKD 10M = 2億円'
};

// Get country code from location string - MUST match HQ country only
function getCountryCode(location) {
  if (!location) return null;
  const loc = location.toLowerCase();

  // HARD RULE: Extract HQ country FIRST - flag must match HQ, not other locations
  // Check for "HQ:" prefix and extract only HQ location
  const hqMatch = loc.match(/hq:\s*([^\n]+)/i);
  if (hqMatch) {
    const hqLocation = hqMatch[1].trim();
    // Get country from the end of HQ line (last comma-separated part)
    const parts = hqLocation.split(',').map(p => p.trim());
    const country = parts[parts.length - 1];
    for (const [key, code] of Object.entries(COUNTRY_FLAG_MAP)) {
      if (country.includes(key)) return code;
    }
  }

  // If no HQ prefix, check if it's a simple location (City, Country format)
  // Use the LAST part which should be the country
  const parts = loc.split(',').map(p => p.trim());
  if (parts.length >= 1) {
    const lastPart = parts[parts.length - 1];
    for (const [key, code] of Object.entries(COUNTRY_FLAG_MAP)) {
      if (lastPart.includes(key)) return code;
    }
  }

  // Fallback: search entire string (but this shouldn't happen with proper location format)
  for (const [key, code] of Object.entries(COUNTRY_FLAG_MAP)) {
    if (loc.includes(key)) return code;
  }
  return null;
}

// HARD RULE: Filter out empty/meaningless Key Metrics
// Remove metrics that say "No specific X stated", "Not specified", etc.
function filterEmptyMetrics(keyMetrics) {
  if (!keyMetrics || !Array.isArray(keyMetrics)) return [];

  // Patterns that indicate empty/meaningless metric VALUES
  const emptyValuePatterns = [
    /no specific/i,
    /not specified/i,
    /not stated/i,
    /not available/i,
    /not found/i,
    /not provided/i,
    /not mentioned/i,
    /not disclosed/i,
    /unknown/i,
    /n\/a/i,
    /none listed/i,
    /none specified/i,
    /none stated/i,
    /no information/i,
    /no data/i,
    /^\s*-?\s*$/,  // Empty or just dashes
    // ZERO VALUE PATTERNS - metrics with "0" values are garbage
    /^0\s+\w/i,               // "0 Something" - starts with "0 "
    /^-?\s*0\s+\w/i,          // "- 0 Something" - bullet point with 0
    /\b0\s+(customers?|clients?|projects?|partners?|employees?|staff|machines?|years?)/i,  // "0 customers", "0 projects", etc.
    // Placeholder text patterns
    /client\s*\d+/i,          // "Client 1", "Client 2", etc.
    /client\s*[a-e]/i,        // "Client A", "Client B", etc.
    /customer\s*\d+/i,        // "Customer 1", "Customer 2", etc.
    /customer\s*[a-e]/i,      // "Customer A", "Customer B", etc.
    /supplier\s*\d+/i,        // "Supplier 1", "Supplier 2", etc.
    /partner\s*\d+/i,         // "Partner 1", "Partner 2", etc.
    /company\s*\d+/i,         // "Company 1", "Company 2", etc.
    /brand\s*\d+/i,           // "brand1", "brand2", etc.
    /brands?\s*\d+\s*,\s*brands?\s*\d+/i,  // "brand1, brand2, brand3"
    /product\s*\d+/i,         // "product1", "product2", etc.
    /item\s*\d+/i,            // "item1", "item2", etc.
    /distributor\s*[a-e]/i,   // "Distributor A", "Distributor B", etc.
    /distributor\s*\d+/i,     // "Distributor 1", "Distributor 2", etc.
    // Generic industry descriptions without specifics
    /various\s+(printers|companies|manufacturers|customers|suppliers|partners)/i,
    /multiple\s+(printers|companies|manufacturers|customers|suppliers|partners)/i,
    /local\s+printers\s+and\s+multinational/i,  // Too vague
    // Values without actual data (just descriptions)
    /^-?\s*production capacity of(?!\s*\d)/i,  // "Production capacity of" without numbers
    /^-?\s*factory area of(?!\s*\d)/i,         // "Factory area of" without numbers
    /^-?\s*number of(?!\s*\d)/i,               // "Number of" without numbers
    /intensive r&d/i,         // Generic R&D statements
    /product improvement and innovation/i,
    /focus(ing|ed)?\s+on\s+(quality|innovation|customer)/i,  // Generic focus statements
    /commitment to/i,         // Generic commitment statements
    /world of color/i,        // Corporate slogans
    /value creation/i,        // Generic value statements
    /environmental impact/i,  // Generic sustainability
    /high standards in/i,     // "High standards in customer service"
    /constant.*innovation/i,  // "Constant technical innovation"
    /continuous improvement/i,
    /excellence in/i,         // "Excellence in service"
    /dedicated to/i,          // "Dedicated to quality"
    // Factory locations masquerading as factory size
    /facilities?\s+located\s+in/i,
    /located\s+in\s+.*city/i,
  ];

  // Labels that should be filtered out entirely (inappropriate for M&A slides)
  const badLabels = [
    /corporate vision/i,
    /vision statement/i,
    /mission statement/i,
    /company values/i,
    /core values/i,
    /our philosophy/i,
    /company motto/i,
    /slogan/i,
    /tagline/i,
    /years of experience/i,
    /awards/i,
    /achievements/i,
    /recognitions/i,
    // Garbage metrics - meaningless fluff
    /quality standards/i,
    /quality assurance/i,
    /quality control/i,
    /quality focus/i,
    /innovation focus/i,
    /r&d focus/i,
    /research focus/i,
    /customer service/i,
    /service excellence/i,
    /technical support/i,
    /customer satisfaction/i,
    /commitment/i,
    /dedication/i,
  ];

  return keyMetrics.filter(metric => {
    if (!metric || !metric.value) return false;
    const value = String(metric.value).trim();
    const label = String(metric.label || '').trim();
    if (!value) return false;

    // Check if label is inappropriate
    for (const pattern of badLabels) {
      if (pattern.test(label)) {
        console.log(`    Removing inappropriate metric: "${label}" = "${value}"`);
        return false;
      }
    }

    // Check if value matches any empty/meaningless pattern
    for (const pattern of emptyValuePatterns) {
      if (pattern.test(value)) {
        console.log(`    Removing empty/generic metric: "${label}" = "${value}"`);
        return false;
      }
    }

    // Clean up the value for certain labels
    const lowerLabel = label.toLowerCase();
    if (lowerLabel.includes('factory size') || lowerLabel.includes('factory area')) {
      // Remove "Factory occupies", "+/-", "approximately" etc.
      metric.value = value
        .replace(/factory\s+occupies\s*/i, '')
        .replace(/approximately\s*/i, '')
        .replace(/\+\/-\s*/g, '')
        .replace(/~\s*/g, '')
        .trim();
    }

    return true;
  });
}

// Common shortforms that don't need explanation
const COMMON_SHORTFORMS = [
  'M', 'B', 'K',           // Million, Billion, Thousand
  'HQ',                    // Headquarters
  'CEO', 'CFO', 'COO',     // C-suite titles
  // All currency codes - well known
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'KRW', 'TWD',
  'IDR', 'SGD', 'MYR', 'THB', 'PHP', 'VND', 'INR', 'HKD', 'AUD',
  'ISO',                   // Well-known standard
  'FY',                    // Fiscal Year
  'YoY', 'QoQ',            // Year over Year, Quarter over Quarter
  'B2B', 'B2C',            // Business models
  'AI', 'IT', 'IoT',       // Tech terms - widely known
  'CE', 'UL', 'FDA', 'GMP', 'HACCP'  // Well-known certifications
];

// Detect shortforms in text and return formatted note (only uncommon ones)
function detectShortforms(companyData) {
  // Collect all text including key_metrics array
  const textParts = [
    companyData.company_name,
    companyData.location,
    companyData.business,
    companyData.metrics,
    companyData.footnote
  ];

  // Also include key_metrics array values
  if (companyData.key_metrics && Array.isArray(companyData.key_metrics)) {
    companyData.key_metrics.forEach(metric => {
      if (metric?.label) textParts.push(ensureString(metric.label));
      if (metric?.value) textParts.push(ensureString(metric.value));
    });
  }

  // Also include breakdown_items
  if (companyData.breakdown_items && Array.isArray(companyData.breakdown_items)) {
    companyData.breakdown_items.forEach(item => {
      if (item?.label) textParts.push(ensureString(item.label));
      if (item?.value) textParts.push(ensureString(item.value));
    });
  }

  const allText = textParts.filter(Boolean).join(' ');

  const foundShortforms = [];

  // First, extract inline abbreviations like "PU (Polyurethane)" from text
  // Pattern: 2-6 uppercase/mixed case letters followed by (explanation)
  const inlinePattern = /\b([A-Z][A-Za-z]{1,5})\s*\(([^)]+)\)/g;
  let match;
  const inlineAbbrevs = new Map();
  while ((match = inlinePattern.exec(allText)) !== null) {
    const abbrev = match[1].toUpperCase();
    const fullForm = match[2].trim();
    // Skip common ones
    if (!COMMON_SHORTFORMS.includes(abbrev) && !inlineAbbrevs.has(abbrev)) {
      inlineAbbrevs.set(abbrev, fullForm);
    }
  }

  // Add inline abbreviations to found shortforms
  for (const [abbrev, fullForm] of inlineAbbrevs) {
    foundShortforms.push(`${abbrev} (${fullForm})`);
  }

  // Then check SHORTFORM_DEFINITIONS for any remaining abbreviations
  for (const [shortform, definition] of Object.entries(SHORTFORM_DEFINITIONS)) {
    // Skip common shortforms that don't need explanation
    if (COMMON_SHORTFORMS.includes(shortform)) continue;
    // Skip if already found inline
    if (inlineAbbrevs.has(shortform.toUpperCase())) continue;

    // Match shortform as whole word (with word boundaries)
    const regex = new RegExp(`\\b${shortform}\\b`, 'i');
    if (regex.test(allText)) {
      foundShortforms.push(`${shortform} (${definition})`);
    }
  }

  if (foundShortforms.length > 0) {
    return 'Note: ' + foundShortforms.join(', ');
  }
  return null;
}

// Strip inline longforms from text, leaving only abbreviations
// "PU (Polyurethane), EVA (Ethylene Vinyl Acetate)" -> "PU, EVA"
function stripInlineLongforms(text) {
  if (!text || typeof text !== 'string') return text;
  // Pattern: ABBREV (Full Form) -> ABBREV
  return text.replace(/\b([A-Z][A-Za-z]{1,5})\s*\([^)]+\)/g, '$1');
}

// Apply stripping to all breakdown items and key metrics
function cleanupInlineLongforms(companyData) {
  if (companyData.breakdown_items && Array.isArray(companyData.breakdown_items)) {
    companyData.breakdown_items = companyData.breakdown_items.map(item => ({
      ...item,
      value: stripInlineLongforms(item.value)
    }));
  }
  if (companyData.key_metrics && Array.isArray(companyData.key_metrics)) {
    companyData.key_metrics = companyData.key_metrics.map(metric => ({
      ...metric,
      value: stripInlineLongforms(metric.value)
    }));
  }
  return companyData;
}

// Fetch image as base64
async function fetchImageAsBase64(url) {
  try {
    const response = await fetch(url, { timeout: 5000 });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  } catch (e) {
    console.log('Failed to fetch image:', url);
    return null;
  }
}

// Generate PPTX using PptxGenJS - matching YCP template
// inaccessibleWebsites: websites that couldn't be scraped (appear on summary slide only, no individual profiles)
async function generatePPTX(companies, targetDescription = '', inaccessibleWebsites = [], rightLayout = 'table-6') {
  try {
    console.log('Generating PPTX with PptxGenJS...');
    if (inaccessibleWebsites.length > 0) {
      console.log(`  Including ${inaccessibleWebsites.length} inaccessible website(s) on summary slide only`);
    }

    const pptx = new pptxgen();
    pptx.author = 'YCP';
    pptx.title = 'Company Profile Slides';
    pptx.subject = 'Company Profiles';

    // Set exact slide size to match template (13.333" x 7.5" = 16:9 widescreen)
    pptx.defineLayout({ name: 'YCP', width: 13.333, height: 7.5 });
    pptx.layout = 'YCP';

    // YCP Theme Colors (from template)
    const COLORS = {
      headerLine: '293F55',    // Dark navy for header/footer lines
      accent3: '011AB7',       // Dark blue - label column background
      white: 'FFFFFF',
      black: '000000',
      gray: 'BFBFBF',          // Dashed border color
      dk2: '1F497D',           // Section underline color
      footerText: '808080'     // Gray footer text
    };

    // ===== DEFINE MASTER SLIDE WITH FIXED LINES (CANNOT BE MOVED) =====
    // Lines are part of the master template background, not individual shapes
    pptx.defineSlideMaster({
      title: 'YCP_MASTER',
      background: { color: 'FFFFFF' },
      objects: [
        // Thick header line (y: 1.02")
        { line: { x: 0, y: 1.02, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 4.5 } } },
        // Thin header line (y: 1.10")
        { line: { x: 0, y: 1.10, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } } },
        // Footer line (y: 7.24")
        { line: { x: 0, y: 7.24, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } } }
      ]
    });

    // ===== TARGET LIST SLIDE (FIRST SLIDE) =====
    // Include both accessible companies and inaccessible websites on the summary slide
    const allCompaniesForSummary = [...companies, ...inaccessibleWebsites];
    if (targetDescription && allCompaniesForSummary.length > 0) {
      try {
      console.log('Generating Target List slide...');
      const meceData = await generateMECESegments(targetDescription, allCompaniesForSummary);

      // Use master slide - lines are fixed in background
      const targetSlide = pptx.addSlide({ masterName: 'YCP_MASTER' });

      // Title Case helper function
      const toTitleCase = (str) => {
        return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
      };

      // Simplify country lists to regions
      const simplifyRegion = (desc) => {
        const seaCountries = ['malaysia', 'indonesia', 'singapore', 'thailand', 'vietnam', 'philippines', 'myanmar', 'cambodia', 'laos', 'brunei'];
        const lowerDesc = desc.toLowerCase();

        // Count how many SE Asian countries are mentioned
        const mentionedSEA = seaCountries.filter(c => lowerDesc.includes(c));

        // If 3+ SE Asian countries are listed, replace with "Southeast Asia"
        if (mentionedSEA.length >= 3) {
          // Build regex to match the country list (including "and", commas)
          const countryListPattern = new RegExp(
            `\\b(in|from)?\\s*(${seaCountries.join('|')})(\\s*,\\s*(${seaCountries.join('|')}))*\\s*(,?\\s*(and)?\\s*(${seaCountries.join('|')}))?`,
            'gi'
          );
          return desc.replace(countryListPattern, (match) => {
            // Check if it started with "in" or "from"
            const startsWithIn = /^\s*in\s/i.test(match);
            const startsWithFrom = /^\s*from\s/i.test(match);
            if (startsWithIn) return 'in Southeast Asia';
            if (startsWithFrom) return 'from Southeast Asia';
            return 'Southeast Asia';
          });
        }
        return desc;
      };

      // Title: "Target List – {Target Description}" in Title Case
      // Simplify multi-country lists to region names
      const simplifiedDesc = simplifyRegion(targetDescription);
      const formattedTitle = `Target List – ${toTitleCase(simplifiedDesc)}`;
      targetSlide.addText(formattedTitle, {
        x: 0.38, y: 0.07, w: 12.5, h: 0.9,
        fontSize: 24, fontFace: 'Segoe UI',
        color: '000000', valign: 'bottom'
      });

      // Helper function to parse location (handles JSON format like {"HQ":"Singapore"})
      // Also cleans up "HQ:", "- HQ:" prefixes from location values
      const parseLocation = (location) => {
        if (!location) return { country: 'Other', hqCity: '' };
        let loc = ensureString(location);

        // Clean up "- HQ:" or "HQ:" prefix from the start
        loc = loc.replace(/^-?\s*HQ:\s*/i, '').trim();

        // Check if location is JSON format (e.g., {"HQ":"Chatuchak, Bangkok, Thailand"})
        if (loc.includes('{') && loc.includes('}')) {
          try {
            // Try to extract the value from JSON-like string
            const match = loc.match(/"HQ"\s*:\s*"([^"]+)"/i) || loc.match(/"([^"]+)"\s*:\s*"([^"]+)"/);
            if (match) {
              let hqValue = match[1] || match[2] || '';
              // Clean up any remaining "HQ:" prefix
              hqValue = hqValue.replace(/^-?\s*HQ:\s*/i, '').trim();
              const parts = hqValue.split(',').map(p => p.trim());
              // Country is always last part
              const country = parts[parts.length - 1] || 'Other';
              // HQ city is first part only (just the district/area, not including state)
              const hqCity = parts[0] || '';
              return { country, hqCity };
            }
          } catch (e) {
            // Fall through to normal parsing
          }
        }

        // Normal parsing - extract country from location (last part after comma)
        const parts = loc.split(',').map(p => p.trim());
        const country = parts[parts.length - 1] || 'Other';
        // HQ city is first part only (just the district/area)
        // If only 1 part (country only), hqCity should be empty, not the country name
        let hqCity = parts.length > 1 ? (parts[0] || '') : '';

        // SINGAPORE VALIDATION: If country is Singapore, validate the area
        if (country.toLowerCase() === 'singapore') {
          if (!hqCity || !isValidSingaporeArea(hqCity)) {
            // Invalid or missing area - leave empty rather than making one up
            // "Central" is NOT a valid Singapore area
            hqCity = '';
          }
        }
        return { country, hqCity };
      };

      // Group companies by country
      const companyByCountry = {};
      companies.forEach((c) => {
        const { country, hqCity } = parseLocation(c.location);
        if (!companyByCountry[country]) companyByCountry[country] = [];
        companyByCountry[country].push({ ...c, hqCity });
      });

      // Assign sequential numbers AFTER grouping (so numbers are in order by country)
      let sequentialIndex = 1;
      Object.keys(companyByCountry).forEach(country => {
        companyByCountry[country].forEach(comp => {
          comp.index = sequentialIndex++;
        });
      });

      // Determine if single country or multi-country
      const countries = Object.keys(companyByCountry);
      const isMultiCountry = countries.length > 1;

      // Build table data
      const segments = meceData.segments || [];
      const companySegments = meceData.companySegments || {};

      // Template colors (from analysis of YCP Target List Slide Template)
      const TL_COLORS = {
        headerBg: '1524A9',      // Dark blue for header row
        countryBg: '011AB7',     // Dark blue for country column (accent3)
        companyBg: '007FFF',     // Bright blue for company column (accent1)
        white: 'FFFFFF',
        black: '000000',
        gray: 'BFBFBF',          // Gray for dotted borders between rows
        checkMark: '00B050'      // Green for check marks
      };

      // Build table rows
      const tableRows = [];

      // Row 1: Merged header for products (spans all segment columns)
      const productHeaderRow = [];

      if (isMultiCountry) {
        // Empty cell for country column header (white background)
        productHeaderRow.push({
          text: '',
          options: {
            fill: TL_COLORS.white,
            valign: 'middle',
            align: 'center',
            border: { pt: 3, color: TL_COLORS.white }
          }
        });
      }

      // Empty cell for company column header
      productHeaderRow.push({
        text: '',
        options: {
          fill: TL_COLORS.white,
          valign: 'middle',
          align: 'center',
          border: { pt: 3, color: TL_COLORS.white }
        }
      });

      // HQ column header with rowspan: 2 (spans both header rows)
      productHeaderRow.push({
        text: 'HQ',
        options: {
          rowspan: 2,
          fill: TL_COLORS.headerBg,
          color: TL_COLORS.white,
          bold: false,
          valign: 'middle',
          align: 'center',
          border: { pt: 3, color: TL_COLORS.white }
        }
      });

      // Merged header for all product columns (spans all segment columns)
      if (segments.length > 0) {
        productHeaderRow.push({
          text: 'Products / Services',
          options: {
            colspan: segments.length,
            fill: TL_COLORS.headerBg,
            color: TL_COLORS.white,
            bold: false,
            align: 'center',
            valign: 'middle',
            border: { pt: 3, color: TL_COLORS.white }
          }
        });
      }

      tableRows.push(productHeaderRow);

      // Row 2: Segment names (sub-headers for products)
      const headerRow = [];

      if (isMultiCountry) {
        // Empty cell for country column header (white background)
        headerRow.push({
          text: '',
          options: {
            fill: TL_COLORS.white,
            valign: 'middle',
            align: 'center',
            border: { pt: 3, color: TL_COLORS.white }
          }
        });
      }

      // Empty cell for company column header
      headerRow.push({
        text: '',
        options: {
          fill: TL_COLORS.white,
          valign: 'middle',
          align: 'center',
          border: { pt: 3, color: TL_COLORS.white }
        }
      });

      // HQ column is merged from row above (rowspan: 2), so no cell here

      // Segment headers (bright blue background like company names, white text)
      segments.forEach(seg => {
        headerRow.push({
          text: seg,
          options: {
            fill: TL_COLORS.companyBg,
            color: TL_COLORS.white,
            bold: false,
            align: 'center',
            valign: 'middle',
            border: { pt: 3, color: TL_COLORS.white }
          }
        });
      });

      tableRows.push(headerRow);

      // Data rows grouped by country
      const countryKeys = Object.keys(companyByCountry);
      countryKeys.forEach((country) => {
        const countryCompanies = companyByCountry[country];
        countryCompanies.forEach((comp, idx) => {
          const row = [];
          const isFirstInCountry = idx === 0;
          const isLastInCountry = idx === countryCompanies.length - 1;

          // Determine if this is the last company in the last country (for bottom border)
          const isLastCountry = countryKeys.indexOf(country) === countryKeys.length - 1;
          const isVeryLastRow = isLastCountry && isLastInCountry;

          // Border style: dotted gray between ALL rows including last row
          const rowBottomBorder = { pt: 1, color: TL_COLORS.gray, type: 'dash' };

          if (isMultiCountry) {
            // Country column (only show text for first company in group, use rowspan)
            if (isFirstInCountry) {
              row.push({
                text: country,
                options: {
                  rowspan: countryCompanies.length,
                  fill: TL_COLORS.countryBg,
                  color: TL_COLORS.white,
                  bold: false,
                  align: 'center',
                  valign: 'middle',
                  border: { pt: 3, color: TL_COLORS.white }
                }
              });
            }
          }

          // Company name with numbering (bright blue background, WHITE text, left-aligned)
          // Keep 3pt white borders on ALL sides for company name cells
          // Apply cleanCompanyName to ensure no suffixes (PT, Ltd) and English only
          const rawName = comp.title || comp.company_name || '';
          const companyName = cleanCompanyName(rawName, comp.website) || 'Unknown';
          row.push({
            text: `${comp.index}. ${companyName}`,
            options: {
              fill: TL_COLORS.companyBg,
              color: TL_COLORS.white,
              bold: false,
              align: 'left',
              valign: 'middle',
              border: { pt: 3, color: TL_COLORS.white },
              hyperlink: { url: comp.website || '' }
            }
          });

          // HQ column (white background, black text)
          const hqCity = comp.hqCity || '';
          row.push({
            text: hqCity,
            options: {
              fill: TL_COLORS.white,
              color: TL_COLORS.black,
              bold: false,
              align: 'left',
              valign: 'middle',
              border: [
                { pt: 3, color: TL_COLORS.white },    // top
                { pt: 3, color: TL_COLORS.white },    // right
                rowBottomBorder,                       // bottom (dotted between rows)
                { pt: 3, color: TL_COLORS.white }     // left
              ]
            }
          });

          // Segment tick marks (white background, green check marks)
          const compSegments = companySegments[String(comp.index)] || [];
          segments.forEach((seg, segIdx) => {
            const hasTick = compSegments[segIdx] === true;
            row.push({
              text: hasTick ? '✓' : '',
              options: {
                fill: TL_COLORS.white,
                color: TL_COLORS.checkMark,
                align: 'center',
                valign: 'middle',
                border: [
                  { pt: 3, color: TL_COLORS.white },    // top
                  { pt: 3, color: TL_COLORS.white },    // right
                  rowBottomBorder,                       // bottom (dotted between rows)
                  { pt: 3, color: TL_COLORS.white }     // left
                ]
              }
            });
          });

          tableRows.push(row);
        });
      });

      // Calculate column widths (from template: Country=1.12", Company=2.14", HQ=1.5", Segments=~1.17" each)
      const tableWidth = 12.6;
      let colWidths = [];

      if (isMultiCountry) {
        const countryColWidth = 1.12;
        const companyColWidth = 2.14;
        const hqColWidth = 1.5;
        const remainingWidth = tableWidth - countryColWidth - companyColWidth - hqColWidth;
        const segmentColWidth = segments.length > 0 ? remainingWidth / segments.length : 1.17;
        colWidths = [countryColWidth, companyColWidth, hqColWidth];
        segments.forEach(() => colWidths.push(segmentColWidth));
      } else {
        // Single country - no country column, company column takes more space
        const companyColWidth = 2.5;
        const hqColWidth = 1.5;
        const remainingWidth = tableWidth - companyColWidth - hqColWidth;
        const segmentColWidth = segments.length > 0 ? remainingWidth / segments.length : 1.17;
        colWidths = [companyColWidth, hqColWidth];
        segments.forEach(() => colWidths.push(segmentColWidth));
      }

      // Add target list table (position from template: x=0.3663", y=1.467")
      // Cell margins: 0.04 inch (0.1cm) left/right, 0 inch top/bottom
      // Font size 14 per design requirements
      targetSlide.addTable(tableRows, {
        x: 0.37, y: 1.47, w: tableWidth,
        colW: colWidths,
        fontFace: 'Segoe UI',
        fontSize: 14,
        valign: 'middle',
        rowH: 0.30,
        margin: [0, 0.04, 0, 0.04]  // [top, right, bottom, left] in inches
      });

      // Footnote (from template: x=0.3754", y=6.6723", font 10pt)
      targetSlide.addText('Source: Company disclosures, industry databases', {
        x: 0.38, y: 6.67, w: 12.54, h: 0.42,
        fontSize: 10, fontFace: 'Segoe UI',
        color: COLORS.black, valign: 'top'
      });

      console.log('Target List slide generated');
      } catch (targetListError) {
        console.error('ERROR generating Target List slide:', targetListError.message);
        console.error('Target List error stack:', targetListError.stack);
        // Continue without target list slide
      }
    }

    // ===== INDIVIDUAL COMPANY PROFILE SLIDES =====
    // NOTE: M&A Strategies slide removed - belongs in UTB service only
    for (const company of companies) {
      try {
      // Skip companies with no meaningful info (only has website, no business/location/metrics)
      // Helper to check if value is a placeholder (e.g., "Not found", "N/A", etc.)
      const isPlaceholder = (val) => {
        if (!val) return true;
        const lower = String(val).toLowerCase().trim();
        const placeholders = ['not found', 'not specified', 'n/a', 'unknown', 'not available', 'none', 'not provided', 'not disclosed'];
        return placeholders.includes(lower) || lower.length === 0;
      };

      const hasBusinessInfo = company.business && !isPlaceholder(company.business);
      const hasLocation = company.location && !isPlaceholder(company.location);
      const hasCompanyName = company.company_name && !isPlaceholder(company.company_name);
      const hasMetrics = company.key_metrics && company.key_metrics.length > 0;
      const hasBreakdown = company.breakdown_items && company.breakdown_items.length > 0;

      // If company has NO meaningful data at all, skip it entirely
      if (!hasCompanyName && !hasBusinessInfo && !hasLocation && !hasMetrics && !hasBreakdown) {
        console.log(`  Skipping slide for ${company.website} - no meaningful info extracted (all fields are empty/placeholder)`);
        continue;
      }

      console.log(`  Generating slide for: ${company.company_name || company.website}`);

      // Step 1: Detect shortforms FIRST (before cleanup) to get footnote from original data with inline longforms
      const shortformNote = detectShortforms(company);

      // Step 2: Clean up inline longforms from tables (e.g., "PU (Polyurethane)" -> "PU")
      // This makes tables cleaner; the longforms are already captured in shortformNote
      cleanupInlineLongforms(company);

      // NOTE: Business Overview slide removed - user requested single profile slide only

      // Use master slide - lines are fixed in background and cannot be moved
      const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });

      // ===== TITLE + MESSAGE (combined in one text box) =====
      const titleText = company.title || company.company_name || 'Company Profile';
      const messageText = company.message || '';

      // Create combined text with title (font 24) and message (font 16)
      const titleContent = messageText ? [
        { text: titleText, options: { fontSize: 24, fontFace: 'Segoe UI', color: COLORS.black, breakLine: true } },
        { text: messageText, options: { fontSize: 16, fontFace: 'Segoe UI', color: COLORS.black } }
      ] : titleText;

      slide.addText(titleContent, {
        x: 0.38, y: 0.07, w: 9.5, h: 0.9,
        fontSize: 24, fontFace: 'Segoe UI',
        color: COLORS.black, valign: 'bottom',
        margin: [0, 0, 0, 0]  // No left/right margin
      });

      // ===== FLAG (top right) =====
      const countryCode = getCountryCode(company.location);
      if (countryCode) {
        try {
          const flagUrl = `https://flagcdn.com/w80/${countryCode.toLowerCase()}.png`;
          const flagBase64 = await fetchImageAsBase64(flagUrl);
          if (flagBase64) {
            const flagX = 10.64, flagY = 0.22, flagW = 0.83, flagH = 0.55;
            // Add flag image
            slide.addImage({
              data: `data:image/png;base64,${flagBase64}`,
              x: flagX, y: flagY, w: flagW, h: flagH
            });
            // Add 1pt black outline around flag
            slide.addShape(pptx.shapes.RECTANGLE, {
              x: flagX, y: flagY, w: flagW, h: flagH,
              fill: { type: 'none' },
              line: { color: '000000', width: 1 }
            });
          }
        } catch (e) {
          console.log('Flag fetch failed for', countryCode);
        }
      }

      // ===== LOGO (top right of slide) =====
      // Use pre-extracted logo from processing pipeline (cascade: Clearbit → og:image → apple-touch-icon → img[logo] → favicon)
      if (company._logo?.data) {
        try {
          console.log(`  Using pre-extracted logo (source: ${company._logo.source})`);
          slide.addImage({
            data: company._logo.data,
            x: 12.1, y: 0.12, w: 0.7, h: 0.7,
            sizing: { type: 'contain', w: 0.7, h: 0.7 }
          });
        } catch (e) {
          console.log('Logo add failed for', company.website, e.message);
        }
      } else {
        console.log(`  No logo available for ${company.website} - skipping (no placeholder)`);
      }

      // ===== SECTION HEADERS =====
      // Left: "会社概要資料" - positioned per ref v4
      slide.addText('会社概要資料', {
        x: 0.37, y: 1.37, w: 6.1, h: 0.35,
        fontSize: 14, fontFace: 'Segoe UI',
        color: COLORS.black, align: 'center'
      });
      slide.addShape(pptx.shapes.LINE, {
        x: 0.37, y: 1.79, w: 6.1, h: 0,
        line: { color: COLORS.dk2, width: 1.75 }
      });

      // Right: Dynamic title based on breakdown_title - positioned at 6.86" x 1.37"
      const rightSectionTitle = company.breakdown_title || 'Products and Applications';
      slide.addText(rightSectionTitle, {
        x: 6.86, y: 1.37, w: 6.1, h: 0.35,
        fontSize: 14, fontFace: 'Segoe UI',
        color: COLORS.black, align: 'center'
      });
      slide.addShape(pptx.shapes.LINE, {
        x: 6.86, y: 1.79, w: 6.1, h: 0,
        line: { color: COLORS.dk2, width: 1.75 }
      });

      // ===== LEFT TABLE (会社概要資料) =====
      // Determine if single location (for HQ label)
      const locationText = ensureString(company.location);
      const locationLines = locationText.split('\n').filter(line => line.trim());
      const isSingleLocation = locationLines.length <= 1 && !locationText.toLowerCase().includes('branch') && !locationText.toLowerCase().includes('factory') && !locationText.toLowerCase().includes('warehouse');
      const locationLabel = isSingleLocation ? 'HQ' : 'Location';

      // Helper function to check if value is empty or placeholder text
      const isEmptyValue = (val) => {
        if (!val) return true;
        const strVal = ensureString(val);
        const lower = strVal.toLowerCase().trim();
        const emptyPhrases = [
          '', 'not specified', 'n/a', 'unknown', 'not available', 'not found',
          'not explicitly mentioned', 'not mentioned', 'none', 'none specified',
          'not disclosed', 'not provided', 'no information', 'no data',
          'none explicitly mentioned'
        ];
        // Check exact match or if value contains placeholder phrases
        if (emptyPhrases.includes(lower)) return true;
        // Check if value contains placeholder phrases (e.g., "Number of Employees: Not specified")
        const containsPhrases = ['not specified', 'not available', 'not found', 'not disclosed',
                                  'not provided', 'not mentioned', 'not explicitly', 'none explicitly',
                                  'no information', 'no data', 'n/a', 'unknown'];
        for (const phrase of containsPhrases) {
          if (lower.includes(phrase)) return true;
        }
        // CRITICAL: Detect alphabetical/numbered placeholder patterns like "Distributor A, B, C" or "Partner X, Y, Z"
        // Pattern: word followed by single letter (A, B, C...) or number (1, 2, 3...)
        const placeholderPatterns = [
          /\b(distributor|partner|supplier|customer|client|vendor)\s+[a-c]\b/gi,
          /\b(distributor|partner|supplier|customer|client|vendor)\s+[x-z]\b/gi,
          /\b(distributor|partner|supplier|customer|client|vendor)\s+[1-3]\b/gi,
          /\b[a-z]+\s+[a-c],\s*[a-z]+\s+[a-c]/gi,  // "Something A, Something B"
          /\b[a-z]+\s+[x-z],\s*[a-z]+\s+[x-z]/gi,  // "Something X, Something Y"
          /\b(brand|product|item|supplier|customer)\s*\d+\s*,/gi,  // "brand1, brand2" or "product 1, product 2"
          /\bbrand\d+\b.*\bbrand\d+\b/gi,  // "brands1, brands2, brands3" pattern
        ];
        for (const pattern of placeholderPatterns) {
          if (pattern.test(strVal)) return true;
        }
        // Also check for simple numbered placeholder patterns like "brands1, brands2"
        if (/\b\w+[1-3]\s*,\s*\w+[1-3]/i.test(strVal)) return true;
        return false;
      };

      // Helper function to remove company suffixes and prefixes
      const removeCompanySuffix = (name) => {
        if (!name) return name;
        return name
          // Remove PT., CV. prefix from Indonesian companies
          .replace(/^(PT\.?|CV\.?)\s+/gi, '')
          // Remove suffixes
          .replace(/\s*(Company\s+Limited|Co\.,?\s*Ltd\.?|Ltd\.?|Limited|Sdn\.?\s*Bhd\.?|Pte\.?\s*Ltd\.?|Inc\.?|Corp\.?|Corporation|LLC|GmbH|JSC|PT\.?|Tbk\.?|S\.?A\.?|PLC|Company)\s*$/gi, '')
          .trim();
      };

      // Helper function to clean location value (remove JSON format and "HQ:" prefix)
      // ALSO enforces Singapore 2-level rule at display time
      const cleanLocationValue = (location, label) => {
        if (!location) return location;
        let cleaned = location;

        // Handle JSON format like {"HQ":"Chatuchak, Bangkok, Thailand"} or {"HQ":"CBD, Singapore"}
        if (cleaned.includes('{') && cleaned.includes('}')) {
          try {
            // Try to extract the value from JSON-like string
            // First regex: /"HQ":"value"/ - match[1] is the value
            // Second regex: /"key":"value"/ - match[1] is key, match[2] is value
            const match = cleaned.match(/"HQ"\s*:\s*"([^"]+)"/i) || cleaned.match(/"([^"]+)"\s*:\s*"([^"]+)"/);
            if (match) {
              // Prefer match[2] (value from second regex) over match[1] (could be key from second regex)
              cleaned = match[2] || match[1] || cleaned;
            }
          } catch (e) {
            // Fall through to normal cleaning
          }
        }

        // If label is HQ, remove "- HQ:" or "HQ:" prefix from value
        if (label === 'HQ') {
          cleaned = cleaned.replace(/^-?\s*HQ:\s*/i, '').trim();
        }

        // FINAL SINGAPORE FIX: If location is just "Singapore", try to extract area from address
        // or leave as-is (can't make up areas)
        const parts = cleaned.split(',').map(p => p.trim()).filter(p => p);
        const isSingapore = parts[parts.length - 1]?.toLowerCase() === 'singapore' ||
                           cleaned.toLowerCase() === 'singapore';

        if (isSingapore && parts.length > 2) {
          // Too many levels for Singapore - keep only first part + Singapore
          cleaned = `${parts[0]}, Singapore`;
        }

        return cleaned;
      };

      // Base company info rows - only add if value exists
      const tableData = [];

      // Always add Name with hyperlink (remove company suffix)
      // Use title as fallback if company_name is empty
      const companyName = company.company_name || company.title || '';
      if (!isEmptyValue(companyName)) {
        const cleanName = removeCompanySuffix(companyName);
        tableData.push(['Name', cleanName, company.website || null]);
      }

      // Add Est. Year if available
      if (!isEmptyValue(company.established_year)) {
        tableData.push(['Est. Year', company.established_year, null]);
      }

      // Add Location if available (clean up HQ: prefix if needed)
      if (!isEmptyValue(company.location)) {
        const cleanLocation = cleanLocationValue(company.location, locationLabel);
        tableData.push([locationLabel, cleanLocation, null]);
      }

      // Add Shareholding row after HQ - always present with yellow highlight
      // Fourth element: { highlight: true } indicates yellow background for value cell
      tableData.push(['Shareholding', 'check speeda & DBD', { highlight: true }]);

      // Add Business if available
      if (!isEmptyValue(company.business)) {
        tableData.push(['Business', company.business, null]);
      }

      // Track existing labels to prevent duplicates
      const existingLabels = new Set(tableData.map(row => row[0].toLowerCase()));

      // Metrics to exclude (worthless or duplicate)
      const EXCLUDED_METRICS = [
        'market position', 'market share', 'market leader',
        'number of branches', 'branches', 'number of locations', 'locations',
        'operating hours', 'business hours', 'office hours',
        'years of experience', 'experience', 'years in business',
        'awards', 'recognitions', 'achievements',
        'certification', 'certifications', 'iso', 'accreditation', 'accreditations',
        // Garbage metrics - meaningless fluff
        'quality standards', 'quality assurance', 'quality control', 'quality focus',
        'innovation focus', 'innovation', 'r&d focus', 'research focus',
        'customer service', 'service excellence', 'technical support',
        'customer satisfaction', 'commitment', 'dedication', 'focus on'
      ];

      // Get the right table category to exclude from left table (prevent duplication)
      const rightTableCategory = ensureString(company.breakdown_title).toLowerCase();
      // Map breakdown titles to keywords to exclude
      const categoryKeywords = {
        'customers': ['customer', 'client', 'buyer'],
        'services': ['service'],
        'products and applications': ['product', 'application'],
        'key suppliers': ['supplier', 'vendor', 'partner'],
        'key partnerships': ['partner', 'partnership']
      };
      const excludeKeywords = categoryKeywords[rightTableCategory] || [];

      // Add key metrics as separate rows if available (skip duplicates and empty values)
      if (company.key_metrics && Array.isArray(company.key_metrics)) {
        company.key_metrics.forEach(metric => {
          // Ensure label and value are strings (AI may return objects/arrays)
          const metricLabel = ensureString(metric?.label);
          const metricValue = ensureString(metric?.value);

          if (metricLabel && metricValue && !isEmptyValue(metricValue)) {
            const labelLower = metricLabel.toLowerCase();

            // Skip excluded metrics
            const isExcluded = EXCLUDED_METRICS.some(ex => labelLower.includes(ex));

            // Skip if this category is already shown on the right table
            const isInRightTable = excludeKeywords.some(kw => labelLower.includes(kw));

            // Skip if this label already exists or is duplicate of business/location
            if (!isExcluded &&
                !isInRightTable &&
                !existingLabels.has(labelLower) &&
                !labelLower.includes('business') &&
                !labelLower.includes('location')) {
              // Always normalize label to Title Case for consistent display
              tableData.push([normalizeLabel(metricLabel), metricValue, null]);
              existingLabels.add(labelLower);
            }
          }
        });
      } else if (company.metrics && !isEmptyValue(company.metrics)) {
        // Fallback for old format (single string)
        tableData.push(['Key Metrics', company.metrics, null]);
      }

      // Add Principal Partners row if available (from businessRelationships)
      const relationships = company._businessRelationships || {};

      // Get company name for filtering (to exclude company's own name from customers list)
      const companyNameForFilter = company.company_name || company.title || '';

      if (relationships.principals && relationships.principals.length > 0) {
        const cleanedPrincipals = filterGarbageNames(relationships.principals, companyNameForFilter);
        if (cleanedPrincipals.length > 0) {
          const principalsList = cleanedPrincipals.slice(0, 10).join(', ');
          if (!existingLabels.has('principal partners') && !existingLabels.has('principals')) {
            tableData.push(['Principal Partners', principalsList, null]);
            existingLabels.add('principal partners');
            console.log(`    Added Principal Partners: ${principalsList}`);
          }
        }
      } else {
        console.log(`    No principals found in _businessRelationships`);
      }

      // Add Key Customers row if available and not already shown on right side
      if (relationships.customers && relationships.customers.length > 0) {
        const rightTitle = ensureString(company.breakdown_title).toLowerCase();
        const isCustomersOnRight = rightTitle.includes('customer') || rightTitle.includes('client');
        if (!isCustomersOnRight && !existingLabels.has('customers') && !existingLabels.has('key customers')) {
          const cleanedCustomers = filterGarbageNames(relationships.customers, companyNameForFilter);
          if (cleanedCustomers.length > 0) {
            const customersList = cleanedCustomers.slice(0, 10).join(', ');
            tableData.push(['Customers', customersList, null]);
            existingLabels.add('customers');
            console.log(`    Added Customers: ${customersList.substring(0, 80)}...`);
          }
        }
      }

      // Helper function to format cell text with bullet points
      // Uses regular bullet • (U+2022) directly in text
      const formatCellText = (text) => {
        if (!text || typeof text !== 'string') return text;

        // Check if text has multiple lines or bullet markers
        const hasMultipleLines = text.includes('\n');
        const hasBulletMarkers = text.includes('■') || text.includes('•') || text.includes('\n-') || text.startsWith('-');

        if (hasMultipleLines || hasBulletMarkers) {
          // Split by newline and filter out empty lines
          const lines = text.split('\n').filter(line => line.trim());

          // Format ALL lines with bullets (even single line if it starts with -)
          const formattedLines = lines.map(line => {
            const cleanLine = line.replace(/^[■\-•]\s*/, '').trim();
            return '• ' + cleanLine;
          });
          return formattedLines.join('\n');
        }
        return text;
      };

      const rows = tableData.map((row) => {
        // Check if third element is an options object (for highlighting) or a URL string
        const thirdElement = row[2];
        const isHighlighted = thirdElement && typeof thirdElement === 'object' && thirdElement.highlight;
        const isHyperlink = typeof thirdElement === 'string' && thirdElement.length > 0;

        const valueCell = {
          text: formatCellText(row[1]),
          options: {
            // Yellow highlight for Shareholding row, white otherwise
            fill: { color: isHighlighted ? 'FFFF00' : COLORS.white },
            color: COLORS.black,
            align: 'left',
            border: [
              { pt: 1, color: COLORS.gray, type: 'dash' },
              { pt: 0 },
              { pt: 1, color: COLORS.gray, type: 'dash' },
              { pt: 0 }
            ]
          }
        };

        // Add hyperlink if URL is provided (third element in row array)
        if (isHyperlink) {
          valueCell.options.hyperlink = { url: thirdElement, tooltip: 'Visit company website' };
          valueCell.options.color = '0563C1'; // Blue hyperlink color
        }

        return [
          {
            text: row[0],
            options: {
              fill: { color: COLORS.accent3 },
              color: COLORS.white,
              align: 'center',
              bold: false
            }
          },
          valueCell
        ];
      });

      const tableStartY = 1.85;
      const rowHeight = 0.35;

      // Skip table if no data (prevents PptxGenJS error "Array expected")
      if (rows.length === 0) {
        console.log(`  Skipping table for ${company.company_name || company.website} - no table data`);
      } else {
        slide.addTable(rows, {
        x: 0.37, y: tableStartY,
        w: 6.1,
        colW: [1.4, 4.7],
        rowH: rowHeight,
        fontFace: 'Segoe UI',
        fontSize: 14,
        valign: 'middle',
        border: { pt: 2.5, color: COLORS.white },
        margin: [0, 0.04, 0, 0.04]
        });
      }

      // ===== RIGHT SECTION (varies by layout selection and business type) =====
      // rightLayout options: 'table-6' (default), 'table-unlimited', 'table-half', 'images', 'images-6', 'images-labeled', 'empty'
      console.log(`  Right layout setting: ${rightLayout}`);

      // Skip entire right section if empty layout selected
      if (rightLayout === 'empty') {
        console.log('  Skipping right section (empty layout selected)');
      } else {
        const businessType = company.business_type || 'industrial';
        const preExtractedImages = company._productProjectImages || [];
        const hasPreExtractedImages = preExtractedImages.length > 0;

        // Check if this is a B2C or project-based business with images to show
        const isImageBusiness = (businessType === 'b2c' || businessType === 'consumer' || businessType === 'project');
        const hasAIProjects = company.projects && company.projects.length > 0;
        const hasAIProducts = company.products && company.products.length > 0;

        // Determine if we should show images or table based on rightLayout
        const forceImages = rightLayout.startsWith('images');
        const forceTable = rightLayout.startsWith('table-');
        const hasImages = hasPreExtractedImages || hasAIProjects || hasAIProducts;

        if ((forceImages && hasImages) || (!forceTable && isImageBusiness && hasImages)) {
        // IMAGE LAYOUTS: Show product/project images
        // Use pre-extracted images first, fallback to AI-extracted data

        if (hasPreExtractedImages) {
          // Use pre-extracted images (from HTML scraping)
          console.log(`  Using ${preExtractedImages.length} pre-extracted images for right side (layout: ${rightLayout})`);

          const gridStartX = 6.86;
          const gridStartY = 1.91;

          if (rightLayout === 'images-labeled') {
            // Layout: Image on left, label on right - 3-4 rows
            const rowHeight = 1.15;
            const imageW = 2.0;
            const imageH = 1.0;
            const labelX = gridStartX + imageW + 0.15;
            const labelW = 3.8;

            for (let i = 0; i < Math.min(preExtractedImages.length, 4); i++) {
              const img = preExtractedImages[i];
              const cellY = gridStartY + (i * rowHeight);

              try {
                const imgBase64 = await fetchImageAsBase64(img.url);
                if (imgBase64) {
                  slide.addImage({
                    data: `data:image/jpeg;base64,${imgBase64}`,
                    x: gridStartX, y: cellY, w: imageW, h: imageH,
                    sizing: { type: 'contain', w: imageW, h: imageH }
                  });

                  if (img.label) {
                    slide.addText(img.label, {
                      x: labelX, y: cellY, w: labelW, h: imageH,
                      fontSize: 14, fontFace: 'Segoe UI',
                      color: COLORS.black, align: 'left', valign: 'middle'
                    });
                  }
                }
              } catch (imgErr) {
                console.log(`  Failed to fetch image: ${img.url}`);
              }
            }
          } else if (rightLayout === 'images-6') {
            // Layout: 2x3 grid for 6 images
            const colWidth = 3.0;
            const rowHeight = 1.5;
            const imageW = 2.8;
            const imageH = 1.2;

            for (let i = 0; i < Math.min(preExtractedImages.length, 6); i++) {
              const img = preExtractedImages[i];
              const col = i % 2;
              const row = Math.floor(i / 2);
              const cellX = gridStartX + (col * colWidth);
              const cellY = gridStartY + (row * rowHeight);

              try {
                const imgBase64 = await fetchImageAsBase64(img.url);
                if (imgBase64) {
                  slide.addImage({
                    data: `data:image/jpeg;base64,${imgBase64}`,
                    x: cellX, y: cellY, w: imageW, h: imageH,
                    sizing: { type: 'contain', w: imageW, h: imageH }
                  });

                  if (img.label) {
                    slide.addText(img.label, {
                      x: cellX, y: cellY + imageH + 0.02, w: imageW, h: 0.25,
                      fontSize: 11, fontFace: 'Segoe UI',
                      color: COLORS.black, align: 'center', valign: 'top'
                    });
                  }
                }
              } catch (imgErr) {
                console.log(`  Failed to fetch image: ${img.url}`);
              }
            }
          } else {
            // Default: 2x2 grid for 4 images
            const colWidth = 3.0;
            const rowHeight = 2.2;
            const imageW = 2.8;
            const imageH = 1.6;

            for (let i = 0; i < Math.min(preExtractedImages.length, 4); i++) {
              const img = preExtractedImages[i];
              const col = i % 2;
              const row = Math.floor(i / 2);
              const cellX = gridStartX + (col * colWidth);
              const cellY = gridStartY + (row * rowHeight);

              try {
                const imgBase64 = await fetchImageAsBase64(img.url);
                if (imgBase64) {
                  slide.addImage({
                    data: `data:image/jpeg;base64,${imgBase64}`,
                    x: cellX, y: cellY, w: imageW, h: imageH,
                    sizing: { type: 'contain', w: imageW, h: imageH }
                  });

                  if (img.label) {
                    slide.addText(img.label, {
                      x: cellX, y: cellY + imageH + 0.05, w: imageW, h: 0.3,
                      fontSize: 14, fontFace: 'Segoe UI',
                      color: COLORS.black, align: 'center', valign: 'top'
                    });
                  }
                }
              } catch (imgErr) {
                console.log(`  Failed to fetch image: ${img.url}`);
              }
            }
          }
        } else if (businessType === 'project' && hasAIProjects) {
          // Fallback: Use AI-extracted project data
          const projects = company.projects.slice(0, 4);

          const gridStartX = 6.86;
          const gridStartY = 1.91;
          const colWidth = 3.0;
          const rowHeight = 2.4;
          const imageW = 1.4;
          const imageH = 1.1;
          const textOffsetX = 1.5;
          const textWidth = 1.4;

          for (let i = 0; i < projects.length; i++) {
            const project = projects[i];
            const col = i % 2;
            const row = Math.floor(i / 2);
            const cellX = gridStartX + (col * colWidth);
            const cellY = gridStartY + (row * rowHeight);

            if (project.image_url) {
              try {
                const imgBase64 = await fetchImageAsBase64(project.image_url);
                if (imgBase64) {
                  slide.addImage({
                    data: `data:image/jpeg;base64,${imgBase64}`,
                    x: cellX, y: cellY, w: imageW, h: imageH,
                    sizing: { type: 'cover', w: imageW, h: imageH }
                  });
                }
              } catch (imgErr) {
                console.log(`  Failed to fetch project image: ${project.image_url}`);
              }
            }

            slide.addText(project.name || '', {
              x: cellX + textOffsetX, y: cellY, w: textWidth, h: 0.5,
              fontSize: 14, fontFace: 'Segoe UI', bold: true,
              color: COLORS.black, valign: 'top'
            });

            const metricsText = (project.metrics || []).join('\n');
            if (metricsText) {
              slide.addText(metricsText, {
                x: cellX + textOffsetX, y: cellY + 0.5, w: textWidth, h: 0.8,
                fontSize: 9, fontFace: 'Segoe UI',
                color: COLORS.black, valign: 'top'
              });
            }
          }
        } else if ((businessType === 'consumer' || businessType === 'b2c') && hasAIProducts) {
          // Fallback: Use AI-extracted product data
          const products = company.products.slice(0, 4);
          const productWidth = 1.4;
          const productStartX = 6.86;
          const productY = 1.91;

          for (let i = 0; i < products.length; i++) {
            const product = products[i];
            const xPos = productStartX + (i * (productWidth + 0.15));

            if (product.image_url) {
              try {
                const imgBase64 = await fetchImageAsBase64(product.image_url);
                if (imgBase64) {
                  slide.addImage({
                    data: `data:image/jpeg;base64,${imgBase64}`,
                    x: xPos, y: productY, w: productWidth, h: 1.2,
                    sizing: { type: 'contain', w: productWidth, h: 1.2 }
                  });
                }
              } catch (imgErr) {
                console.log(`  Failed to fetch product image: ${product.image_url}`);
              }
            }

            slide.addText(product.name || '', {
              x: xPos, y: productY + 1.25, w: productWidth, h: 0.35,
              fontSize: 14, fontFace: 'Segoe UI', bold: true,
              color: COLORS.black, align: 'center', valign: 'top'
            });
          }
        }
      } else if (forceTable || !isImageBusiness || !hasImages) {
        // TABLE LAYOUT: Show table format - THEMATIC (one category only based on breakdown_title)
        // Right side should focus on ONE thing: products, OR customers, OR suppliers, etc.
        // Row limit based on rightLayout: 'table-6' = 6 rows, 'table-unlimited' = no limit, 'table-half' = 3-4 rows

        // Determine max rows based on layout
        let maxRows;
        if (rightLayout === 'table-unlimited') {
          maxRows = 999; // effectively no limit
        } else if (rightLayout === 'table-half') {
          maxRows = 4;
        } else {
          maxRows = 6; // default for table-6
        }

        // Get business relationships
        const relationships = company._businessRelationships || {};
        const breakdownTitle = ensureString(company.breakdown_title).toLowerCase();
        const companyNameForFilter = company.company_name || company.title || '';

        // Build right-side table - THEMATIC based on breakdown_title
        let prioritizedItems = [];

        // Determine what category the right side should show based on breakdown_title
        if (breakdownTitle.includes('customer') || breakdownTitle.includes('client')) {
          // Show customers only - filter garbage data first
          const cleanedCustomers = filterGarbageNames(relationships.customers || [], companyNameForFilter);
          if (cleanedCustomers.length > 0) {
            cleanedCustomers.slice(0, maxRows).forEach(customer => {
              prioritizedItems.push({ label: customer, value: '' });
            });
            console.log(`  Right side (Customers): ${cleanedCustomers.length} items after filtering`);
          }
        } else if (breakdownTitle.includes('supplier') || breakdownTitle.includes('principal') || breakdownTitle.includes('partner')) {
          // Show suppliers/principals only - filter garbage data first
          const cleanedPrincipals = filterGarbageNames(relationships.principals || [], companyNameForFilter);
          if (cleanedPrincipals.length > 0) {
            cleanedPrincipals.slice(0, maxRows).forEach(principal => {
              prioritizedItems.push({ label: principal, value: '' });
            });
            console.log(`  Right side (Principals): ${cleanedPrincipals.length} items after filtering`);
          } else {
            const cleanedSuppliers = filterGarbageNames(relationships.suppliers || [], companyNameForFilter);
            if (cleanedSuppliers.length > 0) {
              cleanedSuppliers.slice(0, maxRows).forEach(supplier => {
                prioritizedItems.push({ label: supplier, value: '' });
              });
              console.log(`  Right side (Suppliers): ${cleanedSuppliers.length} items after filtering`);
            }
          }
        } else if (breakdownTitle.includes('brand')) {
          // Show brands only - filter garbage data first
          const cleanedBrands = filterGarbageNames(relationships.brands || [], companyNameForFilter);
          if (cleanedBrands.length > 0) {
            cleanedBrands.slice(0, maxRows).forEach(brand => {
              prioritizedItems.push({ label: brand, value: '' });
            });
            console.log(`  Right side (Brands): ${cleanedBrands.length} items after filtering`);
          }
        } else {
          // Default: Products/Applications/Services - use breakdown_items
          let validBreakdownItems = (company.breakdown_items || [])
            .map(item => ({
              label: normalizeLabel(ensureString(item?.label)),
              value: ensureString(item?.value)
            }))
            .filter(item => item.label && item.value && !isEmptyValue(item.label) && !isEmptyValue(item.value));

          // Truncate values to max 3 lines
          validBreakdownItems = validBreakdownItems.map(item => {
            let value = item.value;
            const lines = value.split('\n');
            if (lines.length > 3) {
              value = lines.slice(0, 3).join('\n');
            }
            return { label: item.label, value };
          });

          prioritizedItems = validBreakdownItems;
          console.log(`  Right side (Products/Apps): ${prioritizedItems.length} items`);
        }

        // Limit to maxRows (based on rightLayout setting)
        if (prioritizedItems.length > maxRows) {
          prioritizedItems = prioritizedItems.slice(0, maxRows);
        }

        if (prioritizedItems.length >= 1) {
          const rightTableData = prioritizedItems.map(item => [String(item.label || ''), String(item.value || '')]);

          // Calculate row height to distribute evenly within 4.75" height
          const rightTableHeight = 4.75;
          const rightRowHeight = rightTableHeight / rightTableData.length;

          const rightRows = rightTableData.map((row) => [
            {
              text: String(row[0] || ''),
              options: {
                fill: { color: COLORS.accent3 },
                color: COLORS.white,
                align: 'center',
                bold: false
              }
            },
            {
              text: String(row[1] || ''),
              options: {
                fill: { color: COLORS.white },
                color: COLORS.black,
                align: 'left',
                border: [
                  { pt: 1, color: COLORS.gray, type: 'dash' },
                  { pt: 0 },
                  { pt: 1, color: COLORS.gray, type: 'dash' },
                  { pt: 0 }
                ]
              }
            }
          ]);

          slide.addTable(rightRows, {
            x: 6.86, y: 1.91,
            w: 6.1,
            h: rightTableHeight,
            colW: [1.4, 4.7],
            rowH: rightRowHeight,
            fontFace: 'Segoe UI',
            fontSize: 14,
            valign: 'middle',
            border: { pt: 2.5, color: COLORS.white },
            margin: [0, 0.04, 0, 0.04]
          });
        }
      }
      } // End of rightLayout !== 'empty' else block

      // ===== FOOTNOTE (single text box with stacked content) =====
      const footnoteLines = [];

      // Line 1: Note with shortform explanations (only uncommon ones)
      // shortformNote was computed earlier before cleanupInlineLongforms
      if (shortformNote) {
        footnoteLines.push(shortformNote);
      }

      // Line 2: Exchange rate - always add for countries with pre-set rates (especially SEA)
      const exchangeRate = countryCode ? EXCHANGE_RATE_MAP[countryCode] : null;
      if (exchangeRate) {
        footnoteLines.push(exchangeRate);
      }

      // Line 3: Source
      footnoteLines.push('Source: Company website');

      // Create single text box with all footnote content stacked
      const footnoteContent = footnoteLines.join('\n');
      const footnoteHeight = 0.18 * footnoteLines.length;

      slide.addText(footnoteContent, {
        x: 0.38, y: 6.85, w: 12.5, h: footnoteHeight,
        fontSize: 10, fontFace: 'Segoe UI',
        color: COLORS.black, valign: 'top',
        margin: [0, 0, 0, 0]  // No left/right margin
      });
      } catch (slideError) {
        console.error(`  ERROR generating slide for ${company.company_name || company.website}:`, slideError.message);
        console.error('  Slide error stack:', slideError.stack);
        // Continue with next company instead of failing entire PPTX
      }
    }

    // Generate base64
    const base64Content = await pptx.write({ outputType: 'base64' });

    console.log('PPTX generated successfully');

    return {
      success: true,
      content: base64Content
    };
  } catch (error) {
    console.error('PptxGenJS error:', error);
    console.error('PptxGenJS error stack:', error.stack);
    return {
      success: false,
      error: error.message
    };
  }
}

// Currency exchange mapping by country
const CURRENCY_EXCHANGE = {
  'philippines': '為替レート: PHP 100M = 3億円',
  'thailand': '為替レート: THB 100M = 5億円',
  'malaysia': '為替レート: MYR 10M = 3億円',
  'indonesia': '為替レート: IDR 10B = 1億円',
  'singapore': '為替レート: SGD 1M = 1億円',
  'vietnam': '為替レート: VND 100B = 6億円'
};

// Scrape website and convert to clean text (similar to fetchWebsite but returns more content)
// Returns: { success, content, rawHtml, url } - rawHtml for logo/structured data extraction
async function scrapeWebsite(url) {
  try {
    // Normalize URL
    if (!url.startsWith('http')) {
      url = 'https://' + url;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const html = await response.text();

    // Clean HTML to readable text (similar to n8n's markdownify)
    const cleanText = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanText.length < 100) {
      return { success: false, error: 'Insufficient content' };
    }

    // Return both cleaned content AND raw HTML for logo/metadata extraction
    return { success: true, content: cleanText.substring(0, 25000), rawHtml: html, url };
  } catch (e) {
    return { success: false, error: e.message || 'Connection failed' };
  }
}

// ===== DYNAMIC PAGE DISCOVERY =====
// Extract all navigation links from HTML and prioritize by importance
function discoverPagesFromNavigation(html, origin) {
  if (!html || !origin) return [];

  const discoveredUrls = new Set();

  // Priority keywords - pages likely to have important company info
  // Higher priority = lower number = scraped first
  const priorityKeywords = {
    // Highest priority - manufacturing/production info
    'manufacturing': 1, 'production': 1, 'factory': 1, 'facilities': 1, 'plant': 1,
    'capabilities': 2, 'capacity': 2, 'operations': 2,
    // Company info
    'about': 3, 'about-us': 3, 'aboutus': 3, 'company': 3, 'profile': 3, 'company-profile': 3,
    'history': 4, 'milestone': 4, 'journey': 4, 'story': 4,
    // Products and services
    'products': 5, 'product': 5, 'services': 5, 'service': 5, 'solutions': 5,
    // Contact and location
    'contact': 6, 'contact-us': 6, 'contactus': 6, 'location': 6, 'locations': 6,
    // Partners and clients
    'partners': 7, 'clients': 7, 'customers': 7, 'portfolio': 7,
    // Quality and certifications
    'quality': 8, 'certification': 8, 'certifications': 8, 'awards': 8,
    // Team
    'team': 9, 'leadership': 9, 'management': 9
  };

  // Pages to SKIP - not useful for company profiles
  const skipKeywords = [
    'blog', 'news', 'article', 'post', 'press', 'media',
    'career', 'careers', 'jobs', 'vacancy', 'vacancies', 'recruitment',
    'privacy', 'policy', 'terms', 'legal', 'disclaimer', 'cookie',
    'login', 'signin', 'signup', 'register', 'account', 'cart', 'checkout',
    'faq', 'help', 'support', 'sitemap', 'search',
    'facebook', 'twitter', 'linkedin', 'instagram', 'youtube', 'whatsapp',
    '.pdf', '.doc', '.xls', '.zip', '.jpg', '.png', '.gif'
  ];

  // Extract links from navigation elements, header, and main content
  // Pattern matches: <a href="...">
  const linkPattern = /<a[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    let href = match[1].trim();

    // Skip empty, javascript:, mailto:, tel:, anchors
    if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') ||
        href.startsWith('tel:') || href.startsWith('#') || href.length > 200) {
      continue;
    }

    // Convert relative URLs to absolute
    let fullUrl;
    try {
      if (href.startsWith('http://') || href.startsWith('https://')) {
        fullUrl = new URL(href);
        // Skip external domains
        if (fullUrl.origin !== origin) continue;
      } else if (href.startsWith('//')) {
        fullUrl = new URL('https:' + href);
        if (fullUrl.origin !== origin) continue;
      } else if (href.startsWith('/')) {
        fullUrl = new URL(origin + href);
      } else {
        fullUrl = new URL(origin + '/' + href);
      }
    } catch {
      continue; // Invalid URL
    }

    // Normalize: remove trailing slash, query params, fragments
    let normalizedPath = fullUrl.pathname.replace(/\/+$/, '').toLowerCase();
    if (!normalizedPath) normalizedPath = '/';

    // Skip homepage (already scraped)
    if (normalizedPath === '/' || normalizedPath === '/index.html' || normalizedPath === '/index.php' ||
        normalizedPath === '/home' || normalizedPath === '/en' || normalizedPath === '/th' ||
        normalizedPath === '/id' || normalizedPath === '/vn') {
      continue;
    }

    // Skip unwanted pages
    const pathLower = normalizedPath.toLowerCase();
    if (skipKeywords.some(kw => pathLower.includes(kw))) {
      continue;
    }

    discoveredUrls.add(origin + normalizedPath);
  }

  // Convert to array and sort by priority
  const urlsWithPriority = Array.from(discoveredUrls).map(url => {
    const path = new URL(url).pathname.toLowerCase();
    let priority = 100; // Default low priority

    for (const [keyword, prio] of Object.entries(priorityKeywords)) {
      if (path.includes(keyword)) {
        priority = Math.min(priority, prio);
      }
    }

    return { url, priority, path };
  });

  // Sort by priority (lower = more important)
  urlsWithPriority.sort((a, b) => a.priority - b.priority);

  return urlsWithPriority.map(item => item.url);
}

// Scrape multiple pages from a website using dynamic page discovery
// 1. Scrape homepage
// 2. Discover all pages from navigation links
// 3. Prioritize pages by importance (manufacturing, production, about, etc.)
// 4. Scrape top priority pages
async function scrapeMultiplePages(baseUrl) {
  if (!baseUrl.startsWith('http')) {
    baseUrl = 'https://' + baseUrl;
  }

  try {
    const parsedUrl = new URL(baseUrl);
    const origin = parsedUrl.origin;

    const results = {
      homepage: null,
      allContent: '',
      allRawHtml: '',
      pagesScraped: []
    };

    // Step 1: Scrape homepage first
    const homepageResult = await scrapeWebsite(baseUrl);
    if (!homepageResult.success) {
      return homepageResult; // Return error if homepage fails
    }

    results.homepage = homepageResult;
    results.allContent = homepageResult.content + '\n\n';
    results.allRawHtml = homepageResult.rawHtml + '\n\n';
    results.pagesScraped.push(baseUrl);

    // Step 2: Discover pages from navigation
    const discoveredPages = discoverPagesFromNavigation(homepageResult.rawHtml, origin);

    // Step 3: Also add common fallback paths that might not be in navigation
    // (some sites hide these in footer or don't link them prominently)
    const fallbackPaths = [
      '/manufacturing', '/production', '/factory', '/facilities', '/plant',
      '/capabilities', '/capacity', '/operations',
      '/about', '/about-us', '/about.html', '/aboutus', '/company', '/profile', '/company-profile',
      '/contact', '/contact-us', '/contact.html', '/contactus',
      '/products', '/services'
    ];

    for (const path of fallbackPaths) {
      const fallbackUrl = origin + path;
      if (!discoveredPages.includes(fallbackUrl) && !results.pagesScraped.includes(fallbackUrl)) {
        discoveredPages.push(fallbackUrl);
      }
    }

    // Step 4: Scrape discovered pages (limit to 8 to balance coverage vs timeout)
    const MAX_PAGES = 8;
    const scrapedUrls = new Set([baseUrl]);

    for (const pageUrl of discoveredPages) {
      if (results.pagesScraped.length >= MAX_PAGES) break;

      // Skip if already scraped (handles duplicates and variations)
      const normalizedUrl = pageUrl.replace(/\/+$/, '').toLowerCase();
      if (scrapedUrls.has(normalizedUrl)) continue;
      scrapedUrls.add(normalizedUrl);

      try {
        const pageResult = await scrapeWebsite(pageUrl);
        if (pageResult.success && pageResult.content && pageResult.content.length > 200) {
          // Extract path for logging
          const pagePath = new URL(pageUrl).pathname;
          results.allContent += `\n\n=== ${pagePath.toUpperCase()} PAGE ===\n` + pageResult.content;
          results.allRawHtml += pageResult.rawHtml + '\n\n';
          results.pagesScraped.push(pageUrl);
          console.log(`    Scraped additional page: ${pagePath}`);
        }
      } catch {
        // Ignore failed pages - they might not exist
      }
    }

    return {
      success: true,
      content: results.allContent.substring(0, 80000), // Increased limit for more pages
      rawHtml: results.allRawHtml,
      pagesScraped: results.pagesScraped,
      url: baseUrl
    };
  } catch (e) {
    // Fallback to single page if multi-page fails
    console.log(`    Multi-page scraping failed: ${e.message}, falling back to single page`);
    return scrapeWebsite(baseUrl);
  }
}

// Extract logo from website using cascade: Clearbit → og:image → apple-touch-icon → img[logo] → favicon
async function extractLogoFromWebsite(websiteUrl, rawHtml) {
  if (!websiteUrl) return null;

  try {
    // Normalize URL and extract domain
    if (!websiteUrl.startsWith('http')) {
      websiteUrl = 'https://' + websiteUrl;
    }
    const parsedUrl = new URL(websiteUrl);
    const domain = parsedUrl.hostname.replace(/^www\./, '');
    const origin = parsedUrl.origin;

    console.log(`  [Logo] Trying extraction cascade for ${domain}`);

    // 1. Try Clearbit (works for many companies)
    try {
      const clearbitUrl = `https://logo.clearbit.com/${domain}`;
      const logoBase64 = await fetchImageAsBase64(clearbitUrl);
      if (logoBase64) {
        console.log(`  [Logo] Found via Clearbit`);
        return { data: `data:image/png;base64,${logoBase64}`, source: 'clearbit' };
      }
    } catch { /* continue to next */ }

    // 2. Try og:image from HTML (common for brand logos)
    if (rawHtml) {
      const ogImageMatch = rawHtml.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                           rawHtml.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
      if (ogImageMatch && ogImageMatch[1]) {
        try {
          let ogUrl = ogImageMatch[1];
          if (ogUrl.startsWith('/')) ogUrl = origin + ogUrl;
          if (ogUrl.startsWith('http')) {
            const logoBase64 = await fetchImageAsBase64(ogUrl);
            if (logoBase64) {
              console.log(`  [Logo] Found via og:image: ${ogUrl}`);
              return { data: `data:image/png;base64,${logoBase64}`, source: 'og:image' };
            }
          }
        } catch { /* continue */ }
      }

      // 3. Try apple-touch-icon (high-quality brand icon)
      const appleIconMatch = rawHtml.match(/<link[^>]*rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i) ||
                             rawHtml.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']apple-touch-icon["']/i);
      if (appleIconMatch && appleIconMatch[1]) {
        try {
          let iconUrl = appleIconMatch[1];
          if (iconUrl.startsWith('/')) iconUrl = origin + iconUrl;
          if (iconUrl.startsWith('http')) {
            const logoBase64 = await fetchImageAsBase64(iconUrl);
            if (logoBase64) {
              console.log(`  [Logo] Found via apple-touch-icon: ${iconUrl}`);
              return { data: `data:image/png;base64,${logoBase64}`, source: 'apple-touch-icon' };
            }
          }
        } catch { /* continue */ }
      }

      // 4. Try finding <img> with "logo" in src, class, id, or alt
      const imgLogoPatterns = [
        /<img[^>]*src=["']([^"']*logo[^"']*)["']/gi,
        /<img[^>]*class=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/gi,
        /<img[^>]*id=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/gi,
        /<img[^>]*alt=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/gi
      ];

      for (const pattern of imgLogoPatterns) {
        const matches = [...rawHtml.matchAll(pattern)];
        for (const match of matches) {
          if (match[1]) {
            try {
              let imgUrl = match[1];
              // Skip tiny icons, sprites, placeholder images
              if (imgUrl.includes('sprite') || imgUrl.includes('1x1') || imgUrl.includes('placeholder')) continue;
              if (imgUrl.startsWith('/')) imgUrl = origin + imgUrl;
              if (imgUrl.startsWith('http')) {
                const logoBase64 = await fetchImageAsBase64(imgUrl);
                if (logoBase64) {
                  console.log(`  [Logo] Found via img[logo]: ${imgUrl}`);
                  return { data: `data:image/png;base64,${logoBase64}`, source: 'html-img' };
                }
              }
            } catch { /* continue */ }
          }
        }
      }
    }

    // 5. Try Google Favicon as last resort (at least shows something)
    try {
      const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
      const logoBase64 = await fetchImageAsBase64(faviconUrl);
      if (logoBase64) {
        console.log(`  [Logo] Using Google favicon for ${domain}`);
        return { data: `data:image/png;base64,${logoBase64}`, source: 'google-favicon' };
      }
    } catch { /* no logo available */ }

    console.log(`  [Logo] No logo found for ${domain}`);
    return null;
  } catch (e) {
    console.log(`  [Logo] Error extracting logo: ${e.message}`);
    return null;
  }
}

// Extract customer/partner names from image alt texts and filenames
// ONLY extracts from sections that are explicitly marked as client/customer/partner areas
// This prevents extracting random product images as customer names
function extractCustomerNamesFromImages(rawHtml) {
  if (!rawHtml) return [];

  const customerNames = new Set();

  // First, find sections that contain client/customer/partner keywords
  // Only extract from these sections to avoid product images, banners, etc.
  const sectionKeywords = ['client', 'customer', 'partner', 'trusted by', 'our clients', 'our customers'];
  const sectionPatterns = sectionKeywords.map(kw =>
    new RegExp(`<(?:section|div|ul)[^>]*(?:class|id)=["'][^"']*${kw}[^"']*["'][^>]*>[\\s\\S]*?<\\/(?:section|div|ul)>`, 'gi')
  );

  let clientSectionsHtml = '';
  for (const pattern of sectionPatterns) {
    const matches = rawHtml.match(pattern) || [];
    clientSectionsHtml += matches.join('\n');
  }

  // If no explicit client sections found, skip alt text extraction entirely
  // This prevents extracting random product/service images as customers
  if (clientSectionsHtml.length > 0) {
    // Pattern 1: Extract from alt text ONLY within client sections
    const imgAltPattern = /<img[^>]*alt=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = imgAltPattern.exec(clientSectionsHtml)) !== null) {
      const altText = match[1].trim();
      // Skip generic/garbage alt texts
      if (altText.length > 2 && altText.length < 60 &&
          !/logo|image|photo|icon|banner|button|arrow|background/i.test(altText) &&
          !/\.(jpg|png|gif|webp|svg)$/i.test(altText) &&
          !/<|>|style=|href=/i.test(altText)) {
        const cleaned = cleanCompanyName(altText);
        if (cleaned && cleaned.length > 2 && cleaned.length < 50) {
          customerNames.add(cleaned);
        }
      }
    }
  }

  // Pattern 2: Extract from image filenames in client/customer directories
  // e.g., /images/clients/sinarmas-logo.png → Sinarmas
  // This is more reliable as directory structure indicates intent
  const imgSrcPattern = /<img[^>]*src=["']([^"']+(?:client|customer|partner)[^"']+)["'][^>]*>/gi;
  let match;
  while ((match = imgSrcPattern.exec(rawHtml)) !== null) {
    const src = match[1];
    const filename = src.split('/').pop().split('.')[0];
    if (filename) {
      const name = filename
        .replace(/-logo|-icon|-brand|-img|-image$/gi, '')
        .replace(/[-_]/g, ' ')
        .replace(/\d+$/g, '')
        .trim();
      if (name.length > 2 && name.length < 50 && !/removebg|preview|scaled|cover/i.test(name)) {
        const capitalized = name.split(' ')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ');
        const cleaned = cleanCompanyName(capitalized);
        if (cleaned) {
          customerNames.add(cleaned);
        }
      }
    }
  }

  return Array.from(customerNames).slice(0, 15); // Limit to 15 names
}

// Multilingual regex extraction for key metrics (deterministic, no AI hallucination)
// Covers: English, Thai, Vietnamese, Indonesian, Malay, Korean, Hindi, Chinese, Japanese
function extractMetricsFromText(text) {
  if (!text) return {};

  const metrics = {};

  // ===== OFFICE/BRANCH COUNTS =====
  // English: "12 offices", "5 branches", "8 locations"
  // Thai: "12 สาขา" (branches), "5 สำนักงาน" (offices)
  // Vietnamese: "12 văn phòng" (offices), "5 chi nhánh" (branches)
  // Indonesian/Malay: "12 kantor" (offices), "5 cabang" (branches)
  // Korean: "12개 사무소" (offices), "5개 지점" (branches)
  // Hindi: "12 कार्यालय" (offices)
  // Chinese: "12个办事处" (offices), "5个分公司" (branches)
  // Japanese: "12の事務所" (offices), "5支店" (branches)
  const officePatterns = [
    /(\d+)\s*(?:offices?|branches?|locations?|outlets?|showrooms?|centers?|stores?)/gi,
    /(\d+)\s*(?:สาขา|สำนักงาน)/gi, // Thai
    /(\d+)\s*(?:văn phòng|chi nhánh|cửa hàng)/gi, // Vietnamese
    /(\d+)\s*(?:kantor|cabang|lokasi|toko)/gi, // Indonesian/Malay
    /(\d+)개?\s*(?:사무소|지점|매장|센터)/gi, // Korean
    /(\d+)\s*(?:कार्यालय|शाखा)/gi, // Hindi
    /(\d+)个?\s*(?:办事处|分公司|门店|办公室)/gi, // Chinese
    /(\d+)の?\s*(?:事務所|支店|店舗|拠点)/gi, // Japanese
    /across\s+(\d+)\s+(?:countries|cities|regions)/gi,
    /in\s+(\d+)\s+(?:countries|cities|locations)/gi,
    /presence\s+in\s+(\d+)\s+(?:countries|cities)/gi
  ];

  for (const pattern of officePatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0]);
        if (num >= 2 && num <= 500) { // Reasonable range
          metrics.office_count = num;
          metrics.office_text = match[0];
          break;
        }
      }
    }
  }

  // ===== EMPLOYEE COUNTS =====
  // English: "500 employees", "1,000+ staff", "over 200 workers"
  // Thai: "500 พนักงาน"
  // Vietnamese: "500 nhân viên"
  // Indonesian/Malay: "500 karyawan", "500 pekerja"
  // Korean: "500명의 직원", "직원 500명"
  // Hindi: "500 कर्मचारी"
  // Chinese: "500名员工", "员工500人"
  // Japanese: "500名の従業員", "従業員500人"
  const employeePatterns = [
    /(\d{1,3}(?:,\d{3})*|\d+)\s*\+?\s*(?:employees?|staff|workers?|personnel|people|team members?)/gi,
    /(?:over|more than|approximately|about|around)\s+(\d{1,3}(?:,\d{3})*|\d+)\s*(?:employees?|staff|workers?)/gi,
    /(\d{1,3}(?:,\d{3})*|\d+)\s*(?:พนักงาน|คน)/gi, // Thai: "300 พนักงาน"
    /(?:พนักงาน|บุคลากร)\s*(?:มากกว่า|กว่า)?\s*(\d{1,3}(?:,\d{3})*|\d+)\s*(?:คน)?/gi, // Thai reversed: "พนักงาน 300 คน"
    /(\d{1,3}(?:,\d{3})*|\d+)\s*(?:nhân viên|người lao động)/gi, // Vietnamese
    /(\d{1,3}(?:,\d{3})*|\d+)\s*(?:karyawan|pekerja|staf)/gi, // Indonesian/Malay
    /(\d{1,3}(?:,\d{3})*|\d+)명?의?\s*(?:직원|임직원|근로자)/gi, // Korean
    /(?:직원|임직원)\s*(\d{1,3}(?:,\d{3})*|\d+)명/gi, // Korean (reversed)
    /(\d{1,3}(?:,\d{3})*|\d+)\s*(?:कर्मचारी)/gi, // Hindi
    /(\d{1,3}(?:,\d{3})*|\d+)名?(?:员工|職員|雇员)/gi, // Chinese
    /(?:员工|職員)\s*(\d{1,3}(?:,\d{3})*|\d+)(?:人|名)/gi, // Chinese (reversed)
    /(\d{1,3}(?:,\d{3})*|\d+)名?の?\s*(?:従業員|社員|スタッフ)/gi, // Japanese
    /(?:従業員|社員)\s*(\d{1,3}(?:,\d{3})*|\d+)(?:人|名)/gi // Japanese (reversed)
  ];

  for (const pattern of employeePatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d{1,3}(?:,\d{3})*|\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0].replace(/,/g, ''));
        if (num >= 5 && num <= 1000000) { // Reasonable range
          metrics.employee_count = num;
          metrics.employee_text = match[0];
          break;
        }
      }
    }
  }

  // ===== PRODUCTION CAPACITY =====
  // Covers: English, Thai, Vietnamese, Indonesian/Malay, Chinese, Korean, Hindi, Bengali
  const capacityPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:tons?|MT|tonnes?|metric tons?)\s*(?:per|\/)\s*(?:year|month|day|annum)/gi,
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:units?|pieces?|pcs)\s*(?:per|\/)\s*(?:year|month|day)/gi,
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:sqm|square meters?|sq\.?\s*m)\s*(?:per|\/|of)?\s*(?:year|month|production)?/gi,
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:MW|megawatts?|GW|gigawatts?)\s*(?:capacity|installed)?/gi,
    /capacity\s*(?:of|:)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:tons?|MT|units?|MW)/gi,
    /(?:over|more than)?\s*(\d{1,3}(?:,\d{3})*)\s*(?:tons?|MT)\s*(?:per|\/|a)\s*month/gi,
    // Thai: "800 ตัน/เดือน", "กำลังการผลิต 800 ตัน", "ผลิตได้ 800 ตัน"
    /(\d{1,3}(?:,\d{3})*)\s*(?:ตัน)(?:\/เดือน|ต่อเดือน|\/ปี|ต่อปี)?/gi,
    /กำลังการผลิต.*?(\d{1,3}(?:,\d{3})*)\s*ตัน/gi,
    /(?:ผลิตได้|ความสามารถในการผลิต)\s*(\d{1,3}(?:,\d{3})*)\s*ตัน/gi,
    // Vietnamese: "800 tấn/tháng", "công suất 800 tấn"
    /(\d{1,3}(?:,\d{3})*)\s*(?:tấn)(?:\/tháng|\/năm|mỗi tháng|mỗi năm)/gi,
    /công suất.*?(\d{1,3}(?:,\d{3})*)\s*tấn/gi,
    // Indonesian/Malay: "800 ton/bulan", "kapasitas 800 ton"
    /(\d{1,3}(?:,\d{3})*)\s*(?:ton)(?:\/bulan|\/tahun|per bulan|per tahun)/gi,
    /kapasitas.*?(\d{1,3}(?:,\d{3})*)\s*ton/gi,
    // Chinese (Simplified & Traditional): "800吨/月", "产能800吨", "產能800噸"
    /(\d{1,3}(?:,\d{3})*)\s*(?:吨|噸)(?:\/月|\/年|每月|每年)/gi,
    /(?:产能|產能|产量|產量).*?(\d{1,3}(?:,\d{3})*)\s*(?:吨|噸)/gi,
    // Korean: "800톤/월", "생산능력 800톤"
    /(\d{1,3}(?:,\d{3})*)\s*(?:톤)(?:\/월|\/년|월간|연간)/gi,
    /(?:생산능력|생산량).*?(\d{1,3}(?:,\d{3})*)\s*톤/gi,
    // Hindi: "800 टन/माह", "उत्पादन क्षमता 800 टन"
    /(\d{1,3}(?:,\d{3})*)\s*(?:टन)(?:\/माह|\/वर्ष|प्रति माह|प्रति वर्ष)/gi,
    /(?:उत्पादन क्षमता|क्षमता).*?(\d{1,3}(?:,\d{3})*)\s*टन/gi,
    // Bengali: "800 টন/মাস", "উৎপাদন ক্ষমতা 800 টন"
    /(\d{1,3}(?:,\d{3})*)\s*(?:টন)(?:\/মাস|\/বছর)/gi,
    /(?:উৎপাদন ক্ষমতা|ক্ষমতা).*?(\d{1,3}(?:,\d{3})*)\s*টন/gi
  ];

  for (const pattern of capacityPatterns) {
    const match = text.match(pattern);
    if (match) {
      metrics.capacity_text = match[0];
      break;
    }
  }

  // ===== MACHINE COUNTS =====
  // Covers: English, Thai, Vietnamese, Indonesian/Malay, Chinese, Korean, Hindi, Bengali
  const machinePatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\s*\+?\s*(?:machines?|equipment|production lines?|manufacturing lines?)/gi,
    /(?:over|more than|approximately)\s+(\d{1,3}(?:,\d{3})*)\s*(?:machines?|equipment)/gi,
    // Thai: "250 เครื่อง", "เครื่องจักร 250 เครื่อง", "มีเครื่องจักร 250 เครื่อง"
    /(\d{1,3}(?:,\d{3})*)\s*(?:เครื่อง|เครื่องจักร)/gi,
    /(?:เครื่องจักร|เครื่อง)\s*(?:จำนวน|มากกว่า)?\s*(\d{1,3}(?:,\d{3})*)\s*(?:เครื่อง|ตัว)?/gi,
    /มี\s*(?:เครื่องจักร|เครื่อง)\s*(\d{1,3}(?:,\d{3})*)/gi,
    // Vietnamese: "250 máy", "thiết bị 250"
    /(\d{1,3}(?:,\d{3})*)\s*(?:máy|thiết bị|máy móc)/gi,
    // Indonesian/Malay: "250 mesin", "peralatan 250"
    /(\d{1,3}(?:,\d{3})*)\s*(?:mesin|peralatan|unit mesin)/gi,
    // Chinese: "250台设备", "设备250台", "機器250台"
    /(\d{1,3}(?:,\d{3})*)\s*(?:台|臺)?\s*(?:设备|機器|机器|機械|机械)/gi,
    /(?:设备|機器|机器|機械|机械).*?(\d{1,3}(?:,\d{3})*)\s*(?:台|臺|套)/gi,
    // Korean: "250대 기계", "설비 250대"
    /(\d{1,3}(?:,\d{3})*)\s*(?:대|台)?\s*(?:기계|설비|장비)/gi,
    /(?:기계|설비|장비).*?(\d{1,3}(?:,\d{3})*)\s*대/gi,
    // Hindi: "250 मशीन", "उपकरण 250"
    /(\d{1,3}(?:,\d{3})*)\s*(?:मशीन|मशीनें|उपकरण)/gi,
    // Bengali: "250 মেশিন", "যন্ত্রপাতি 250"
    /(\d{1,3}(?:,\d{3})*)\s*(?:মেশিন|যন্ত্র|যন্ত্রপাতি)/gi
  ];

  for (const pattern of machinePatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d{1,3}(?:,\d{3})*|\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0].replace(/,/g, ''));
        if (num >= 2 && num <= 10000) { // Reasonable range for machines (lowered from 10)
          metrics.machine_count = num;
          metrics.machine_text = match[0];
          break;
        }
      }
    }
  }

  // ===== BUSINESS PARTNERS / DISTRIBUTORS =====
  // Covers: English, Thai, Vietnamese, Indonesian/Malay, Chinese, Korean, Hindi, Bengali
  const partnerPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\s*\+?\s*(?:domestic\s+)?(?:partners?|distributors?|dealers?|resellers?|agents?)/gi,
    /(?:over|more than)\s+(\d{1,3}(?:,\d{3})*)\s*(?:partners?|distributors?|dealers?)/gi,
    // Thai: "700 พันธมิตร", "ตัวแทนจำหน่าย 700 ราย"
    /(\d{1,3}(?:,\d{3})*)\s*(?:พันธมิตร|ตัวแทน|ตัวแทนจำหน่าย|ผู้จัดจำหน่าย|ราย)/gi,
    /(?:พันธมิตรทางธุรกิจ|ตัวแทนจำหน่าย).*?(\d{1,3}(?:,\d{3})*)/gi,
    // Vietnamese: "700 đối tác", "nhà phân phối 700"
    /(\d{1,3}(?:,\d{3})*)\s*(?:đối tác|nhà phân phối|đại lý|đại lý phân phối)/gi,
    // Indonesian/Malay: "700 mitra", "distributor 700"
    /(\d{1,3}(?:,\d{3})*)\s*(?:mitra|distributor|agen|mitra bisnis|mitra usaha)/gi,
    // Chinese: "700家经销商", "合作伙伴700家", "經銷商700家"
    /(\d{1,3}(?:,\d{3})*)\s*(?:家|個)?\s*(?:经销商|經銷商|合作伙伴|合作夥伴|代理商|分销商|分銷商)/gi,
    /(?:经销商|經銷商|合作伙伴|合作夥伴|代理商).*?(\d{1,3}(?:,\d{3})*)\s*(?:家|個)?/gi,
    // Korean: "700개 파트너", "대리점 700개"
    /(\d{1,3}(?:,\d{3})*)\s*(?:개|家)?\s*(?:파트너|대리점|유통업체|협력사)/gi,
    /(?:파트너|대리점|유통업체|협력사).*?(\d{1,3}(?:,\d{3})*)\s*개/gi,
    // Hindi: "700 भागीदार", "वितरक 700"
    /(\d{1,3}(?:,\d{3})*)\s*(?:भागीदार|वितरक|डीलर|एजेंट)/gi,
    // Bengali: "700 অংশীদার", "পরিবেশক 700"
    /(\d{1,3}(?:,\d{3})*)\s*(?:অংশীদার|পরিবেশক|ডিলার|এজেন্ট)/gi
  ];

  for (const pattern of partnerPatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d{1,3}(?:,\d{3})*|\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0].replace(/,/g, ''));
        if (num >= 2 && num <= 10000) { // Reasonable range for partners (lowered from 10)
          metrics.partner_count = num;
          metrics.partner_text = match[0];
          break;
        }
      }
    }
  }

  // ===== EXPORT REGIONS =====
  // Capture region names like "Southeast Asia, South Asia, North Africa"
  const exportRegionPatterns = [
    /(?:export(?:ing|s)?|market(?:s)?|expand(?:ed)?)\s+(?:to|into|in)\s+([A-Za-z\s,]+(?:Asia|Africa|Europe|America|Middle East)[A-Za-z\s,]*)/gi,
    /(?:Southeast Asia|South Asia|North Africa|Middle East|Europe|North America|Latin America|East Asia|Central Asia|Sub-Saharan Africa)[,\s]+(?:and\s+)?(?:Southeast Asia|South Asia|North Africa|Middle East|Europe|North America|Latin America|East Asia|Central Asia|Sub-Saharan Africa)/gi
  ];

  for (const pattern of exportRegionPatterns) {
    const match = text.match(pattern);
    if (match) {
      metrics.export_regions = match[0];
      break;
    }
  }

  // ===== YEARS OF EXPERIENCE =====
  const yearsPatterns = [
    /(\d+)\s*(?:\+\s*)?years?\s*(?:of\s+)?(?:experience|in\s+business|in\s+the\s+industry|in\s+operation)/gi,
    /(?:over|more than)\s+(\d+)\s*years?/gi,
    /since\s+(19\d{2}|20[0-2]\d)/gi,
    /established\s+(?:in\s+)?(19\d{2}|20[0-2]\d)/gi,
    /(\d+)\s*ปี\s*(?:ประสบการณ์|ในอุตสาหกรรม)/gi, // Thai
    /(\d+)\s*năm\s*(?:kinh nghiệm|hoạt động)/gi, // Vietnamese
    /(\d+)\s*tahun\s*(?:pengalaman|beroperasi)/gi, // Indonesian
    /(\d+)년\s*(?:경험|역사|전통)/gi // Korean
  ];

  for (const pattern of yearsPatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0]);
        if ((num >= 1 && num <= 100) || (num >= 1900 && num <= 2025)) {
          metrics.years_experience = num <= 100 ? num : (2025 - num);
          metrics.years_text = match[0];
          break;
        }
      }
    }
  }

  // ===== CERTIFICATIONS =====
  const certPatterns = [
    /ISO\s*\d{4,5}(?::\d{4})?/gi,
    /HACCP|GMP|HALAL|FDA|CE|BSCI|WRAP|SEDEX|OEKO-TEX|FSC|PEFC/gi,
    /(?:certified|certification|accredited)\s+(?:by|with)\s+[A-Z][A-Za-z\s]+/gi
  ];

  const certs = [];
  for (const pattern of certPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      certs.push(...matches.map(m => m.toUpperCase().trim()));
    }
  }
  if (certs.length > 0) {
    metrics.certifications = [...new Set(certs)].slice(0, 10);
  }

  // ===== EXPORT COUNTRIES (selling TO) =====
  // CRITICAL: Only match "export to", "sell to", "distribute to" - NOT "source from"
  const exportPatterns = [
    /export(?:ing|s)?\s+to\s+(\d+)\s+(?:countries|nations|markets)/gi,
    /sell(?:ing|s)?\s+to\s+(\d+)\s+(?:countries|nations|markets)/gi,
    /distribut(?:e|ing|ion)\s+to\s+(\d+)\s+(?:countries|markets)/gi,
    /(?:present|presence|available)\s+in\s+(\d+)\s+(?:countries|markets)/gi,
    /(\d+)\s+export\s+(?:countries|destinations|markets)/gi
  ];

  for (const pattern of exportPatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0]);
        if (num >= 2 && num <= 200) {
          metrics.export_countries = num;
          metrics.export_text = match[0];
          break;
        }
      }
    }
  }

  // ===== SOURCE/PROCUREMENT COUNTRIES (buying FROM) =====
  // CRITICAL: "source from", "procure from", "import from" - OPPOSITE of export
  const sourcePatterns = [
    /sourc(?:e|ing)\s+from\s+(\d+)\s+(?:countries|nations|origins)/gi,
    /procur(?:e|ing|ement)\s+from\s+(\d+)\s+(?:countries|nations)/gi,
    /import(?:ing|s)?\s+from\s+(\d+)\s+(?:countries|nations|origins)/gi,
    /(?:raw materials?|ingredients?|products?)\s+from\s+(\d+)\s+(?:countries|origins)/gi,
    /(\d+)\s+(?:source|procurement|origin)\s+countries/gi
  ];

  for (const pattern of sourcePatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0]);
        if (num >= 2 && num <= 200) {
          metrics.source_countries = num;
          metrics.source_text = match[0];
          break;
        }
      }
    }
  }

  // ===== FACTORY SIZE / LAND AREA =====
  // Covers: sqm, sq ft, rai (Thai), acres, hectares, 坪 (ping), 평 (pyeong)
  const factorySizePatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\s*(?:sqm|square meters?|sq\.?\s*m|m2|m²)\s*(?:factory|plant|facility|warehouse|production|land)?/gi,
    /(?:factory|plant|facility|warehouse|land area)\s*(?:of|:)?\s*(\d{1,3}(?:,\d{3})*)\s*(?:sqm|square meters?|sq\.?\s*ft|acres?)/gi,
    /(\d{1,3}(?:,\d{3})*)\s*(?:sq\.?\s*ft|square feet)/gi,
    // Thai: rai (ไร่), sqm (ตร.ม.), ngan (งาน), tarang wah (ตารางวา)
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:ไร่|งาน|ตารางวา|ตร\.ม\.|ตารางเมตร)/gi,
    /(?:พื้นที่|เนื้อที่)\s*(?:โรงงาน|ที่ดิน)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:ไร่|งาน|ตร\.ม\.)/gi,
    // Indonesian: m2, hektar
    /(\d{1,3}(?:,\d{3})*)\s*(?:m2|meter persegi|hektar|ha)/gi,
    // Chinese: 平方米, 亩, 坪
    /(\d{1,3}(?:,\d{3})*)\s*(?:平方米|平米|亩|畝|坪)/gi,
    // Korean: 평 (pyeong), 제곱미터
    /(\d{1,3}(?:,\d{3})*)\s*(?:평|제곱미터|㎡)/gi,
    // General
    /(\d{1,3}(?:,\d{3})*)\s*(?:rai|acres?|hectares?|ha)/gi
  ];

  for (const pattern of factorySizePatterns) {
    const match = text.match(pattern);
    if (match) {
      metrics.factory_size = match[0];
      break;
    }
  }

  // ===== PRODUCTS / SKUs COUNT =====
  // Important for distributors, manufacturers, retailers
  const productCountPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\s*\+?\s*(?:products?|SKUs?|items?|varieties|models?|types?)/gi,
    /(?:over|more than)\s+(\d{1,3}(?:,\d{3})*)\s*(?:products?|SKUs?|items?)/gi,
    // Thai: "500 รายการสินค้า", "500 ผลิตภัณฑ์"
    /(\d{1,3}(?:,\d{3})*)\s*(?:รายการ|ผลิตภัณฑ์|สินค้า|ชนิด)/gi,
    // Vietnamese: "500 sản phẩm"
    /(\d{1,3}(?:,\d{3})*)\s*(?:sản phẩm|mặt hàng|loại)/gi,
    // Indonesian: "500 produk"
    /(\d{1,3}(?:,\d{3})*)\s*(?:produk|jenis|item|macam)/gi,
    // Chinese: "500种产品", "500款"
    /(\d{1,3}(?:,\d{3})*)\s*(?:种|種|款|个|個)?\s*(?:产品|產品|商品)/gi,
    // Korean: "500개 제품"
    /(\d{1,3}(?:,\d{3})*)\s*(?:개|종)?\s*(?:제품|상품|품목)/gi
  ];

  for (const pattern of productCountPatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d{1,3}(?:,\d{3})*|\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0].replace(/,/g, ''));
        if (num >= 3 && num <= 100000) { // Lowered from 10
          metrics.product_count = num;
          metrics.product_text = match[0];
          break;
        }
      }
    }
  }

  // ===== CUSTOMERS COUNT =====
  // Important for all businesses
  const customerCountPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\s*\+?\s*(?:customers?|clients?|buyers?|accounts?)/gi,
    /(?:over|more than|serving)\s+(\d{1,3}(?:,\d{3})*)\s*(?:customers?|clients?)/gi,
    // Thai: "500 ลูกค้า"
    /(\d{1,3}(?:,\d{3})*)\s*(?:ลูกค้า|ราย|บริษัท)/gi,
    // Vietnamese: "500 khách hàng"
    /(\d{1,3}(?:,\d{3})*)\s*(?:khách hàng|khách)/gi,
    // Indonesian: "500 pelanggan"
    /(\d{1,3}(?:,\d{3})*)\s*(?:pelanggan|klien|pembeli)/gi,
    // Chinese: "500家客户"
    /(\d{1,3}(?:,\d{3})*)\s*(?:家|位|个|個)?\s*(?:客户|客戶|顾客|顧客)/gi,
    // Korean: "500개 고객"
    /(\d{1,3}(?:,\d{3})*)\s*(?:개|명)?\s*(?:고객|거래처|클라이언트)/gi
  ];

  for (const pattern of customerCountPatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d{1,3}(?:,\d{3})*|\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0].replace(/,/g, ''));
        if (num >= 3 && num <= 1000000) { // Lowered from 5
          metrics.customer_count = num;
          metrics.customer_text = match[0];
          break;
        }
      }
    }
  }

  // ===== FLEET / TRUCKS / VEHICLES =====
  // Important for logistics, distribution, delivery companies
  const fleetPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\s*\+?\s*(?:trucks?|vehicles?|vans?|lorries?|fleet|delivery vehicles?)/gi,
    /fleet\s*(?:of|:)?\s*(\d{1,3}(?:,\d{3})*)\s*(?:trucks?|vehicles?)/gi,
    // Thai: "100 คัน", "รถบรรทุก 100 คัน"
    /(\d{1,3}(?:,\d{3})*)\s*(?:คัน)/gi,
    /(?:รถบรรทุก|รถขนส่ง|ยานพาหนะ).*?(\d{1,3}(?:,\d{3})*)\s*คัน/gi,
    // Vietnamese: "100 xe tải"
    /(\d{1,3}(?:,\d{3})*)\s*(?:xe tải|xe|phương tiện)/gi,
    // Indonesian: "100 truk"
    /(\d{1,3}(?:,\d{3})*)\s*(?:truk|kendaraan|mobil|unit armada)/gi,
    // Chinese: "100辆卡车"
    /(\d{1,3}(?:,\d{3})*)\s*(?:辆|輛|台|臺)\s*(?:卡车|貨車|车辆|車輛|运输车|運輸車)/gi,
    // Korean: "100대 트럭"
    /(\d{1,3}(?:,\d{3})*)\s*(?:대|台)\s*(?:트럭|차량|운송차)/gi
  ];

  for (const pattern of fleetPatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d{1,3}(?:,\d{3})*|\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0].replace(/,/g, ''));
        if (num >= 2 && num <= 10000) { // Lowered from 5
          metrics.fleet_count = num;
          metrics.fleet_text = match[0];
          break;
        }
      }
    }
  }

  // ===== RETAIL OUTLETS / STORES / BRANCHES =====
  // Important for retail chains, franchise businesses
  const outletPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\s*\+?\s*(?:outlets?|stores?|shops?|branches?|showrooms?|retail locations?)/gi,
    /(?:over|more than)\s+(\d{1,3}(?:,\d{3})*)\s*(?:outlets?|stores?|branches?)/gi,
    // Thai: "100 สาขา", "100 ร้าน"
    /(\d{1,3}(?:,\d{3})*)\s*(?:สาขา|ร้าน|ร้านค้า|จุดขาย)/gi,
    // Vietnamese: "100 cửa hàng"
    /(\d{1,3}(?:,\d{3})*)\s*(?:cửa hàng|chi nhánh|điểm bán)/gi,
    // Indonesian: "100 toko"
    /(\d{1,3}(?:,\d{3})*)\s*(?:toko|outlet|cabang|gerai)/gi,
    // Chinese: "100家门店"
    /(\d{1,3}(?:,\d{3})*)\s*(?:家|个|個)?\s*(?:门店|門店|店铺|店鋪|分店|零售店)/gi,
    // Korean: "100개 매장"
    /(\d{1,3}(?:,\d{3})*)\s*(?:개|곳)?\s*(?:매장|점포|지점|대리점)/gi
  ];

  for (const pattern of outletPatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d{1,3}(?:,\d{3})*|\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0].replace(/,/g, ''));
        if (num >= 2 && num <= 50000) {
          metrics.outlet_count = num;
          metrics.outlet_text = match[0];
          break;
        }
      }
    }
  }

  // ===== BRANDS CARRIED =====
  // Important for distributors
  const brandCountPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\s*\+?\s*(?:brands?|principals?|labels?)/gi,
    /(?:carrying|distributing|representing)\s+(\d{1,3}(?:,\d{3})*)\s*(?:brands?)/gi,
    // Thai: "50 แบรนด์"
    /(\d{1,3}(?:,\d{3})*)\s*(?:แบรนด์|ยี่ห้อ|ตรา)/gi,
    // Vietnamese: "50 thương hiệu"
    /(\d{1,3}(?:,\d{3})*)\s*(?:thương hiệu|nhãn hiệu)/gi,
    // Indonesian: "50 merek"
    /(\d{1,3}(?:,\d{3})*)\s*(?:merek|brand)/gi,
    // Chinese: "50个品牌"
    /(\d{1,3}(?:,\d{3})*)\s*(?:个|個)?\s*(?:品牌|牌子)/gi,
    // Korean: "50개 브랜드"
    /(\d{1,3}(?:,\d{3})*)\s*(?:개)?\s*(?:브랜드|상표)/gi
  ];

  for (const pattern of brandCountPatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d{1,3}(?:,\d{3})*|\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0].replace(/,/g, ''));
        if (num >= 2 && num <= 1000) {
          metrics.brand_count = num;
          metrics.brand_text = match[0];
          break;
        }
      }
    }
  }

  // ===== DAILY/MONTHLY OUTPUT (units, not weight) =====
  // Important for manufacturing
  const outputPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\s*(?:units?|pieces?|pcs|items?)\s*(?:per|\/|a)\s*(?:day|month)/gi,
    /(?:daily|monthly)\s*(?:output|production|capacity)\s*(?:of|:)?\s*(\d{1,3}(?:,\d{3})*)/gi,
    // Thai: "10,000 ชิ้น/วัน"
    /(\d{1,3}(?:,\d{3})*)\s*(?:ชิ้น|หน่วย)(?:\/วัน|\/เดือน|ต่อวัน|ต่อเดือน)/gi,
    // Vietnamese: "10,000 sản phẩm/ngày"
    /(\d{1,3}(?:,\d{3})*)\s*(?:sản phẩm|đơn vị|chiếc)(?:\/ngày|\/tháng)/gi,
    // Chinese: "日产10,000件"
    /(?:日产|月产|日產|月產).*?(\d{1,3}(?:,\d{3})*)/gi,
    /(\d{1,3}(?:,\d{3})*)\s*(?:件|个|個)(?:\/天|\/月|每天|每月)/gi
  ];

  for (const pattern of outputPatterns) {
    const match = text.match(pattern);
    if (match) {
      metrics.output_text = match[0];
      break;
    }
  }

  // ===== WAREHOUSE COUNT =====
  // Important for distribution, logistics
  const warehousePatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\s*\+?\s*(?:warehouses?|distribution centers?|DCs?|storage facilities?)/gi,
    // Thai: "10 คลังสินค้า"
    /(\d{1,3}(?:,\d{3})*)\s*(?:คลังสินค้า|โกดัง|คลัง)/gi,
    // Vietnamese: "10 kho"
    /(\d{1,3}(?:,\d{3})*)\s*(?:kho|nhà kho|kho hàng)/gi,
    // Indonesian: "10 gudang"
    /(\d{1,3}(?:,\d{3})*)\s*(?:gudang|warehouse)/gi,
    // Chinese: "10个仓库"
    /(\d{1,3}(?:,\d{3})*)\s*(?:个|個)?\s*(?:仓库|倉庫|配送中心)/gi,
    // Korean: "10개 물류센터"
    /(\d{1,3}(?:,\d{3})*)\s*(?:개)?\s*(?:물류센터|창고|배송센터)/gi
  ];

  for (const pattern of warehousePatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d{1,3}(?:,\d{3})*|\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0].replace(/,/g, ''));
        if (num >= 1 && num <= 500) {
          metrics.warehouse_count = num;
          metrics.warehouse_text = match[0];
          break;
        }
      }
    }
  }

  // ===== COUNTRIES/MARKETS PRESENCE =====
  // Important for international companies
  const countryPresencePatterns = [
    // English
    /(?:present|presence|operating|available)\s+in\s+(\d+)\s+(?:countries|markets|nations)/gi,
    /(\d+)\s+(?:countries|markets)\s+(?:worldwide|globally|across)/gi,
    // Thai: "50 ประเทศ"
    /(\d+)\s*(?:ประเทศ)/gi,
    // Vietnamese: "50 quốc gia"
    /(\d+)\s*(?:quốc gia|nước)/gi,
    // Chinese: "50个国家"
    /(\d+)\s*(?:个|個)?\s*(?:国家|國家|市场|市場)/gi,
    // Korean: "50개국"
    /(\d+)\s*(?:개국|개 국가|개 시장)/gi
  ];

  for (const pattern of countryPresencePatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0]);
        if (num >= 2 && num <= 200) {
          metrics.country_presence = num;
          metrics.country_presence_text = match[0];
          break;
        }
      }
    }
  }

  // ===== PROJECTS COMPLETED =====
  // Important for construction, engineering, service companies
  const projectPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\s*\+?\s*(?:projects?|installations?|implementations?)\s*(?:completed|delivered)?/gi,
    /(?:completed|delivered)\s+(\d{1,3}(?:,\d{3})*)\s*(?:projects?)/gi,
    // Thai: "500 โครงการ"
    /(\d{1,3}(?:,\d{3})*)\s*(?:โครงการ|งาน)/gi,
    // Vietnamese: "500 dự án"
    /(\d{1,3}(?:,\d{3})*)\s*(?:dự án|công trình)/gi,
    // Indonesian: "500 proyek"
    /(\d{1,3}(?:,\d{3})*)\s*(?:proyek|projek)/gi,
    // Chinese: "500个项目"
    /(\d{1,3}(?:,\d{3})*)\s*(?:个|個)?\s*(?:项目|項目|工程)/gi,
    // Korean: "500개 프로젝트"
    /(\d{1,3}(?:,\d{3})*)\s*(?:개)?\s*(?:프로젝트|공사|시공)/gi
  ];

  for (const pattern of projectPatterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/\d{1,3}(?:,\d{3})*|\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0].replace(/,/g, ''));
        if (num >= 3 && num <= 100000) { // Lowered from 10
          metrics.project_count = num;
          metrics.project_text = match[0];
          break;
        }
      }
    }
  }

  // ===== INDUSTRY-SPECIFIC: Awards/Recognition =====
  const awardPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:awards?|recognitions?|accolades?|honors?)/gi,
    /(?:won|received|earned)\s*(\d{1,3}(?:,\d{3})*)\+?\s*(?:awards?|prizes?)/gi,
    // Thai: "20 รางวัล" (awards)
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:รางวัล)/gi,
    // Vietnamese: "20 giải thưởng"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:giải thưởng)/gi,
    // Chinese: "20项荣誉" / "20個獎項"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:项荣誉|個獎項|个奖项|项奖)/gi,
    // Indonesian: "20 penghargaan"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:penghargaan)/gi,
    // Korean: "20개 수상"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:개\s*수상)/gi,
  ];
  for (const pattern of awardPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const num = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (num >= 3 && num <= 1000) {
        metrics.award_count = num;
        metrics.award_text = match[0];
        break;
      }
    }
    if (metrics.award_count) break;
  }

  // ===== INDUSTRY-SPECIFIC: Patents =====
  const patentPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:patents?|intellectual propert)/gi,
    /(?:hold|own|filed)\s*(\d{1,3}(?:,\d{3})*)\+?\s*(?:patents?)/gi,
    // Chinese: "50项专利" / "50項專利"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:项专利|項專利|个专利)/gi,
    // Korean: "50개 특허"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:개\s*특허)/gi,
    // Thai: "50 สิทธิบัตร"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:สิทธิบัตร)/gi,
  ];
  for (const pattern of patentPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const num = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (num >= 5 && num <= 50000) {
        metrics.patent_count = num;
        metrics.patent_text = match[0];
        break;
      }
    }
    if (metrics.patent_count) break;
  }

  // ===== HOSPITALITY: Hotel Rooms =====
  const roomPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:rooms?|suites?|guest rooms?|keys)/gi,
    /(?:has|with|offers?)\s*(\d{1,3}(?:,\d{3})*)\+?\s*(?:rooms?)/gi,
    // Thai: "200 ห้องพัก"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:ห้องพัก|ห้อง)/gi,
    // Vietnamese: "200 phòng"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:phòng)/gi,
    // Chinese: "200间客房" / "200間客房"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:间客房|間客房|个房间)/gi,
    // Indonesian: "200 kamar"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:kamar)/gi,
  ];
  for (const pattern of roomPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const num = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (num >= 10 && num <= 10000) {
        metrics.room_count = num;
        metrics.room_text = match[0];
        break;
      }
    }
    if (metrics.room_count) break;
  }

  // ===== HEALTHCARE: Hospital Beds =====
  const bedPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:beds?|patient beds?|hospital beds?)/gi,
    /(?:hospital with|clinic with)\s*(\d{1,3}(?:,\d{3})*)\+?\s*(?:beds?)/gi,
    // Thai: "500 เตียง"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:เตียง)/gi,
    // Vietnamese: "500 giường bệnh"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:giường bệnh|giường)/gi,
    // Chinese: "500张病床" / "500張病床"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:张病床|張病床|个床位)/gi,
    // Indonesian: "500 tempat tidur"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:tempat tidur)/gi,
  ];
  for (const pattern of bedPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const num = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (num >= 5 && num <= 10000) { // Lowered from 20
        metrics.bed_count = num;
        metrics.bed_text = match[0];
        break;
      }
    }
    if (metrics.bed_count) break;
  }

  // ===== HEALTHCARE: Doctors/Specialists =====
  const doctorPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:doctors?|physicians?|specialists?|medical staff)/gi,
    // Thai: "100 แพทย์"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:แพทย์|หมอ)/gi,
    // Vietnamese: "100 bác sĩ"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:bác sĩ)/gi,
    // Chinese: "100位医生" / "100位醫生"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:位医生|位醫生|名医生)/gi,
    // Indonesian: "100 dokter"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:dokter)/gi,
  ];
  for (const pattern of doctorPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const num = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (num >= 3 && num <= 10000) { // Lowered from 5
        metrics.doctor_count = num;
        metrics.doctor_text = match[0];
        break;
      }
    }
    if (metrics.doctor_count) break;
  }

  // ===== EDUCATION: Students =====
  const studentPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:students?|learners?|graduates?|alumni)/gi,
    /(?:trained|educated)\s*(\d{1,3}(?:,\d{3})*)\+?\s*(?:students?)/gi,
    // Thai: "5,000 นักเรียน"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:นักเรียน|นักศึกษา)/gi,
    // Vietnamese: "5,000 học sinh"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:học sinh|sinh viên)/gi,
    // Chinese: "5,000名学生" / "5,000名學生"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:名学生|名學生|个学生)/gi,
    // Indonesian: "5,000 siswa"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:siswa|mahasiswa)/gi,
    // Korean: "5,000명 학생"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:명\s*학생)/gi,
  ];
  for (const pattern of studentPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const num = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (num >= 10 && num <= 1000000) { // Lowered from 50
        metrics.student_count = num;
        metrics.student_text = match[0];
        break;
      }
    }
    if (metrics.student_count) break;
  }

  // ===== EDUCATION: Courses =====
  const coursePatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:courses?|programs?|classes?|training modules?)/gi,
    // Thai: "100 หลักสูตร"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:หลักสูตร|คอร์ส)/gi,
    // Vietnamese: "100 khóa học"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:khóa học)/gi,
    // Chinese: "100门课程" / "100門課程"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:门课程|門課程|个课程)/gi,
  ];
  for (const pattern of coursePatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const num = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (num >= 3 && num <= 10000) { // Lowered from 10
        metrics.course_count = num;
        metrics.course_text = match[0];
        break;
      }
    }
    if (metrics.course_count) break;
  }

  // ===== REAL ESTATE: Units/Properties =====
  const unitPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:units?|properties|apartments?|condos?|villas?|homes?)/gi,
    /(?:developed|built|sold)\s*(\d{1,3}(?:,\d{3})*)\+?\s*(?:units?|properties)/gi,
    // Thai: "1,000 ยูนิต"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:ยูนิต|ห้องชุด)/gi,
    // Vietnamese: "1,000 căn hộ"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:căn hộ|căn)/gi,
    // Chinese: "1,000套房产" / "1,000套物業"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:套房产|套物業|个单位)/gi,
    // Indonesian: "1,000 unit"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:unit)/gi,
  ];
  for (const pattern of unitPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const num = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (num >= 3 && num <= 100000) { // Lowered from 10
        metrics.unit_count = num;
        metrics.unit_text = match[0];
        break;
      }
    }
    if (metrics.unit_count) break;
  }

  // ===== AGRICULTURE: Acreage/Hectares =====
  const acreagePatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\+?\s*(?:acres?|hectares?|ha)\s*(?:of land|of farm|cultivated)?/gi,
    // Thai: "1,000 ไร่" (rai = 0.16 hectares)
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\+?\s*(?:ไร่)/gi,
    // Vietnamese: "1,000 hecta"
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\+?\s*(?:hecta|mẫu)/gi,
    // Chinese: "1,000公顷" / "1,000畝"
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\+?\s*(?:公顷|畝|亩)/gi,
    // Indonesian: "1,000 hektar"
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\+?\s*(?:hektar)/gi,
  ];
  for (const pattern of acreagePatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const num = parseFloat(String(match[1]).replace(/,/g, ''));
      if (num >= 3 && num <= 1000000) { // Lowered from 10
        metrics.acreage = num;
        metrics.acreage_text = match[0];
        break;
      }
    }
    if (metrics.acreage) break;
  }

  // ===== TECH/DIGITAL: Users/Subscribers =====
  const userPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:users?|subscribers?|members?|registered users?|active users?)/gi,
    /(?:over|more than)\s*(\d{1,3}(?:,\d{3})*)\+?\s*(?:users?|subscribers?)/gi,
    // Chinese: "100万用户" / "100萬用戶"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:万用户|萬用戶|个用户|名用户)/gi,
    // Thai: "1,000,000 ผู้ใช้"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:ผู้ใช้|สมาชิก)/gi,
    // Vietnamese: "1,000,000 người dùng"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:người dùng|thành viên)/gi,
    // Indonesian: "1,000,000 pengguna"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:pengguna|anggota)/gi,
    // Korean: "100만 사용자"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:만\s*사용자|명\s*회원)/gi,
  ];
  for (const pattern of userPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const num = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (num >= 10 && num <= 1000000000) { // Lowered from 100
        metrics.user_count = num;
        metrics.user_text = match[0];
        break;
      }
    }
    if (metrics.user_count) break;
  }

  // ===== TECH/DIGITAL: Downloads =====
  const downloadPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:downloads?|installs?|app downloads?)/gi,
    // Chinese: "100万下载" / "100萬下載"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:万下载|萬下載|次下载)/gi,
    // Thai: "1,000,000 ดาวน์โหลด"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:ดาวน์โหลด)/gi,
    // Vietnamese: "1,000,000 lượt tải"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:lượt tải|tải xuống)/gi,
    // Indonesian: "1,000,000 unduhan"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:unduhan)/gi,
  ];
  for (const pattern of downloadPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const num = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (num >= 100 && num <= 10000000000) { // Lowered from 1000
        metrics.download_count = num;
        metrics.download_text = match[0];
        break;
      }
    }
    if (metrics.download_count) break;
  }

  // ===== F&B: Menu Items/Recipes =====
  const menuPatterns = [
    // English
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:menu items?|dishes?|recipes?|food items?)/gi,
    // Thai: "100 เมนู"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:เมนู|รายการอาหาร)/gi,
    // Vietnamese: "100 món ăn"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:món ăn|thực đơn)/gi,
    // Chinese: "100道菜" / "100道菜品"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:道菜|道菜品|个菜品)/gi,
    // Indonesian: "100 menu"
    /(\d{1,3}(?:,\d{3})*)\+?\s*(?:menu makanan)/gi,
  ];
  for (const pattern of menuPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const num = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (num >= 20 && num <= 5000) {
        metrics.menu_count = num;
        metrics.menu_text = match[0];
        break;
      }
    }
    if (metrics.menu_count) break;
  }

  return metrics;
}

// Extract JSON-LD structured data for address information
function extractStructuredAddress(rawHtml) {
  if (!rawHtml) return null;

  try {
    // Find JSON-LD script tags
    const jsonLdPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = jsonLdPattern.exec(rawHtml)) !== null) {
      try {
        const jsonData = JSON.parse(match[1]);

        // Handle array of schemas
        const schemas = Array.isArray(jsonData) ? jsonData : [jsonData];

        for (const schema of schemas) {
          // Look for Organization, LocalBusiness, or Corporation
          if (schema['@type'] && /Organization|LocalBusiness|Corporation|Company/i.test(schema['@type'])) {
            const address = schema.address;
            if (address) {
              // Address could be a string or PostalAddress object
              if (typeof address === 'string') {
                return { formatted: address };
              } else if (address['@type'] === 'PostalAddress' || address.streetAddress) {
                return {
                  street: address.streetAddress,
                  city: address.addressLocality,
                  region: address.addressRegion,
                  country: address.addressCountry,
                  postal: address.postalCode,
                  formatted: [
                    address.addressLocality,
                    address.addressRegion,
                    typeof address.addressCountry === 'object' ? address.addressCountry.name : address.addressCountry
                  ].filter(Boolean).join(', ')
                };
              }
            }
          }
        }
      } catch {
        // Invalid JSON, continue to next match
      }
    }
  } catch (e) {
    console.log(`  [StructuredData] Error parsing: ${e.message}`);
  }

  return null;
}

// ===== FIX #1: Extract full 3-level address with retry mechanism =====
// When initial extraction returns incomplete address (1-2 levels), retry with Contact page focus
async function extractFullAddress(scrapedContent, websiteUrl, currentLocation) {
  // Check if current location needs fixing
  if (!currentLocation) return null;

  const parts = currentLocation.split(',').map(p => p.trim()).filter(p => p);
  const isSingapore = parts[parts.length - 1]?.toLowerCase() === 'singapore';

  // 2 levels for all countries (state/province, country)
  const requiredLevels = 2;
  if (parts.length >= requiredLevels) {
    return currentLocation; // Already valid
  }

  console.log(`  [HQ Retry] Location "${currentLocation}" has ${parts.length} levels, need ${requiredLevels}. Re-extracting...`);

  try {
    // Look for Contact page content in scraped content
    const contactSection = scrapedContent.match(/=== \/CONTACT[^=]*===([\s\S]*?)(?:===|$)/i)?.[1] || '';
    const contentToSearch = contactSection || scrapedContent;

    const response = await withRetry(() => openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an address extraction specialist. Extract the headquarters location.

TASK: Find the location and return EXACTLY 2 levels: "State/Province, Country"

${isSingapore ? `
SINGAPORE FORMAT (2 levels): "Area/District, Singapore"
Examples: "Jurong West, Singapore", "Tuas, Singapore", "Woodlands, Singapore"
Look for: postal codes (6 digits), street names, building names to identify the area.
` : `
FORMAT (2 levels): "State/Province, Country"
Examples:
- Thailand: "Bangkok, Thailand" or "Samut Prakan, Thailand"
- Malaysia: "Selangor, Malaysia" or "Penang, Malaysia"
- Indonesia: "Banten, Indonesia" or "East Java, Indonesia"
- Vietnam: "Ho Chi Minh City, Vietnam" or "Hanoi, Vietnam"
- Philippines: "Metro Manila, Philippines" or "Cebu, Philippines"

CRITICAL: Extract the STATE/PROVINCE level (not city/district) + Country
`}

Current incomplete location: "${currentLocation}"
You MUST find more specific location details from the content.

Return JSON: { "location": "Province, Country" } or { "location": "Area, Singapore" }
If you cannot find more details, return: { "location": "" }`
        },
        {
          role: 'user',
          content: `Find the complete headquarters address from this content:\n\n${contentToSearch.substring(0, 15000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1
    }));

    const result = JSON.parse(response.choices[0].message.content);
    if (result.location && result.location !== currentLocation) {
      const newParts = result.location.split(',').map(p => p.trim()).filter(p => p);
      if (newParts.length >= requiredLevels) {
        console.log(`  [HQ Retry] SUCCESS: "${currentLocation}" → "${result.location}"`);
        return result.location;
      }
    }

    console.log(`  [HQ Retry] Could not improve location, keeping: "${currentLocation}"`);
    return currentLocation;
  } catch (e) {
    console.log(`  [HQ Retry] Error: ${e.message}`);
    return currentLocation;
  }
}

// ===== FIX #3: Extract product/project images for B2C and project-based companies =====
// Returns array of { url, label } objects for display on right side of slide
function extractProductProjectImages(rawHtml, businessType, websiteUrl) {
  if (!rawHtml) return [];

  const images = [];
  const origin = websiteUrl?.startsWith('http') ? new URL(websiteUrl).origin : `https://${websiteUrl?.split('/')[0]}`;

  // Define section patterns based on business type
  const sectionPatterns = businessType === 'b2c' || businessType === 'consumer'
    ? [
        /class=["'][^"']*(?:product|menu|dish|food|item|catalog|gallery)[^"']*["']/gi,
        /<section[^>]*(?:product|menu|gallery|catalog)[^>]*>([\s\S]*?)<\/section>/gi,
        /id=["'][^"']*(?:product|menu|gallery)[^"']*["']/gi
      ]
    : [
        /class=["'][^"']*(?:project|portfolio|work|case-study|showcase)[^"']*["']/gi,
        /<section[^>]*(?:project|portfolio|work)[^>]*>([\s\S]*?)<\/section>/gi,
        /id=["'][^"']*(?:project|portfolio|gallery)[^"']*["']/gi
      ];

  // Find images in product/project sections
  // Pattern: <img> tags with meaningful src (not icons, sprites, placeholders)
  const imgPattern = /<img[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*?)["'])?[^>]*>|<img[^>]*(?:alt=["']([^"']*?)["'])[^>]*src=["']([^"']+)["'][^>]*>/gi;

  // Also look for figure elements with captions
  const figurePattern = /<figure[^>]*>[\s\S]*?<img[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?<figcaption[^>]*>([^<]+)<\/figcaption>[\s\S]*?<\/figure>/gi;

  // Extract from figure elements first (they have captions)
  let match;
  while ((match = figurePattern.exec(rawHtml)) !== null && images.length < 6) {
    const [, src, caption] = match;
    if (src && !isIconOrPlaceholder(src)) {
      let imgUrl = src;
      if (imgUrl.startsWith('/')) imgUrl = origin + imgUrl;
      if (imgUrl.startsWith('http')) {
        images.push({
          url: imgUrl,
          label: cleanImageLabel(caption)
        });
      }
    }
  }

  // Then extract from img tags in relevant sections
  // Look for images in product/project/portfolio/menu sections
  const relevantSectionHtml = extractRelevantSections(rawHtml, businessType);

  while ((match = imgPattern.exec(relevantSectionHtml)) !== null && images.length < 6) {
    const src = match[1] || match[4];
    const alt = match[2] || match[3];

    if (src && !isIconOrPlaceholder(src) && !images.some(i => i.url.includes(src))) {
      let imgUrl = src;
      if (imgUrl.startsWith('/')) imgUrl = origin + imgUrl;
      if (imgUrl.startsWith('http')) {
        images.push({
          url: imgUrl,
          label: cleanImageLabel(alt) || extractLabelFromFilename(src)
        });
      }
    }
  }

  return images.slice(0, 6); // Max 6 images for slide layout (images-6 option)
}

// Helper: Check if image is an icon, placeholder, or junk
function isIconOrPlaceholder(src) {
  const skipPatterns = [
    // Icons and UI elements
    /icon/i, /sprite/i, /placeholder/i, /1x1/i, /blank/i, /spacer/i,
    /logo/i, /favicon/i, /avatar/i, /profile/i, /user/i,
    /arrow/i, /button/i, /bg[-_]/i, /background/i,
    /\.svg$/i, /data:image/i,
    // Social media
    /social/i, /facebook/i, /twitter/i, /linkedin/i, /instagram/i, /youtube/i,
    /\d+x\d+/,  // Dimension patterns like 16x16
    // Stock photo sites
    /shutterstock/i, /istockphoto/i, /gettyimages/i, /unsplash/i, /pexels/i,
    /stock[-_]?photo/i, /depositphotos/i, /dreamstime/i, /123rf/i,
    // Common junk patterns
    /banner/i, /hero[-_]?image/i, /slider/i, /carousel/i,
    /header[-_]?bg/i, /footer/i, /sidebar/i,
    /thumbnail[-_]?placeholder/i, /loading/i, /spinner/i,
    /badge/i, /certificate/i, /award[-_]?icon/i,
    // Tracking pixels
    /pixel/i, /tracking/i, /analytics/i, /beacon/i
  ];
  return skipPatterns.some(p => p.test(src));
}

// Helper: Extract HTML sections relevant to products/projects
function extractRelevantSections(rawHtml, businessType) {
  let keywords;
  if (businessType === 'b2c' || businessType === 'consumer') {
    keywords = ['product', 'menu', 'dish', 'food', 'item', 'catalog', 'gallery', 'offering', 'service'];
  } else if (businessType === 'project') {
    keywords = ['project', 'portfolio', 'work', 'case', 'showcase', 'gallery', 'client-work', 'completed'];
  } else {
    // Industrial: manufacturing, equipment, capabilities, facilities
    keywords = ['product', 'equipment', 'machinery', 'manufacturing', 'capability', 'facility', 'solution', 'gallery', 'showcase'];
  }

  let relevantHtml = '';

  // Extract sections/divs that contain these keywords in class/id
  for (const keyword of keywords) {
    const sectionRegex = new RegExp(
      `<(?:section|div|article)[^>]*(?:class|id)=["'][^"']*${keyword}[^"']*["'][^>]*>[\\s\\S]*?<\\/(?:section|div|article)>`,
      'gi'
    );
    const matches = rawHtml.match(sectionRegex) || [];
    relevantHtml += matches.join('\n');
  }

  // If no sections found, try main content (but limit to avoid random images)
  if (!relevantHtml) {
    const mainContent = rawHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
                        rawHtml.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1];
    // Only use main content if it exists, don't fall back to random HTML chunk
    return mainContent || '';
  }

  return relevantHtml;
}

// Helper: Clean image label
function cleanImageLabel(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '') // Remove HTML
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 50); // Limit length
}

// Helper: Extract label from filename
function extractLabelFromFilename(src) {
  const filename = src.split('/').pop()?.split('?')[0]?.split('.')[0] || '';
  return filename
    .replace(/[-_]/g, ' ')
    .replace(/\d+$/g, '')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .trim()
    .substring(0, 50);
}

// ===== FIX #5: Extract categorized business relationships from section context =====
// Returns: { customers: [], suppliers: [], principals: [], brands: [] }
function extractBusinessRelationships(rawHtml) {
  if (!rawHtml) return { customers: [], suppliers: [], principals: [], brands: [] };

  const results = {
    customers: new Set(),    // Companies we sell to
    suppliers: new Set(),    // Companies we buy from
    principals: new Set(),   // Companies we represent/distribute for
    brands: new Set()        // Brands we carry/distribute
  };

  // Category-specific section keywords (English + Indonesian + Thai + Vietnamese + Malay + Chinese)
  const categoryKeywords = {
    customers: [
      // English
      'client', 'customer', 'served', 'trusted by', 'work with', 'our clients', 'our customers', 'they trust us',
      // Indonesian
      'pelanggan', 'klien', 'mitra-pelanggan',
      // Thai
      'ลูกค้า', 'ผู้ใช้บริการ',
      // Vietnamese
      'khách hàng',
      // Chinese
      '客户', '客戶'
    ],
    suppliers: [
      // English
      'supplier', 'vendor', 'source', 'procurement', 'our suppliers', 'supply chain', 'raw material',
      // Indonesian
      'pemasok', 'vendor',
      // Thai
      'ผู้จัดจำหน่าย', 'ซัพพลายเออร์'
    ],
    principals: [
      // English
      'principal', 'represent', 'authorized', 'distributor for', 'agency', 'our principals', 'we represent',
      'partner', 'our partners', 'technology partner', 'strategic partner',
      // Indonesian
      'mitra', 'mitra-utama', 'mitra bisnis', 'mitra kami', 'partner',
      // Thai
      'พันธมิตร', 'ตัวแทนจำหน่าย', 'เอเจนซี่',
      // Vietnamese
      'đối tác', 'đại lý',
      // Chinese
      '合作伙伴', '合作夥伴', '代理'
    ],
    brands: [
      // English
      'brand', 'carry', 'distribute', 'portfolio', 'our brands', 'brands we', 'product line',
      // Indonesian
      'merek', 'brand-kami',
      // Thai
      'แบรนด์', 'ยี่ห้อ',
      // Vietnamese
      'thương hiệu',
      // Chinese
      '品牌'
    ]
  };

  // Extract names from a section
  function extractNamesFromSection(sectionHtml) {
    const names = new Set();
    let match;

    // Method 1: Alt text from images
    const altPattern = /<img[^>]*alt=["']([^"']+)["'][^>]*>/gi;
    while ((match = altPattern.exec(sectionHtml)) !== null) {
      const name = cleanCustomerName(match[1]);
      if (name) names.add(name);
    }

    // Method 2: Title attribute
    const titlePattern = /<[^>]*title=["']([^"']+)["'][^>]*>/gi;
    while ((match = titlePattern.exec(sectionHtml)) !== null) {
      const name = cleanCustomerName(match[1]);
      if (name) names.add(name);
    }

    // Method 3: aria-label attribute
    const ariaPattern = /<[^>]*aria-label=["']([^"']+)["'][^>]*>/gi;
    while ((match = ariaPattern.exec(sectionHtml)) !== null) {
      const name = cleanCustomerName(match[1]);
      if (name) names.add(name);
    }

    // Method 4: Figure captions
    const figcaptionPattern = /<figcaption[^>]*>([^<]+)<\/figcaption>/gi;
    while ((match = figcaptionPattern.exec(sectionHtml)) !== null) {
      const name = cleanCustomerName(match[1]);
      if (name) names.add(name);
    }

    // Method 5: List items
    const liPattern = /<li[^>]*>([^<]{2,50})<\/li>/gi;
    while ((match = liPattern.exec(sectionHtml)) !== null) {
      const name = cleanCustomerName(match[1]);
      if (name) names.add(name);
    }

    // Method 6: Image filenames (including lazy-loaded data-src)
    const imgSrcPattern = /<img[^>]*(?:src|data-src|data-lazy-src|data-original)=["']([^"']+)["'][^>]*>/gi;
    while ((match = imgSrcPattern.exec(sectionHtml)) !== null) {
      const src = match[1];
      if (src.startsWith('data:')) continue; // Skip data URIs
      if (/client|customer|partner|brand|principal|supplier/i.test(src)) {
        const filename = src.split('/').pop()?.split('.')[0] || '';
        const name = cleanCustomerName(
          filename.replace(/[-_]/g, ' ').replace(/logo|img|image|\d+/gi, '').trim()
        );
        if (name) names.add(name);
      }
    }

    // Method 7: Inline text (span, strong, em)
    const inlinePattern = /<(?:span|strong|em|b)[^>]*>([A-Z][^<]{1,40})<\/(?:span|strong|em|b)>/g;
    while ((match = inlinePattern.exec(sectionHtml)) !== null) {
      const text = match[1].trim();
      if (text.length >= 2 && text.length <= 40 && /^[A-Z]/.test(text)) {
        const name = cleanCustomerName(text);
        if (name) names.add(name);
      }
    }

    return names;
  }

  // Process each category
  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    // Build section pattern for this category
    const keywordPattern = keywords.join('|');

    // Find sections by class/id
    const sectionPattern = new RegExp(
      `<(?:section|div|ul|article)[^>]*(?:class|id)=["'][^"']*(?:${keywordPattern})[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:section|div|ul|article)>`,
      'gi'
    );

    // Find sections by heading
    const headingPattern = new RegExp(
      `<h[1-6][^>]*>[^<]*(?:${keywordPattern})[^<]*<\\/h[1-6]>([\\s\\S]{0,5000}?)(?=<h[1-6]|<\\/section|<\\/main|$)`,
      'gi'
    );

    let match;
    while ((match = sectionPattern.exec(rawHtml)) !== null) {
      const sectionHtml = match[1] || match[0];
      const names = extractNamesFromSection(sectionHtml);
      names.forEach(name => results[category].add(name));
    }

    while ((match = headingPattern.exec(rawHtml)) !== null) {
      const sectionHtml = match[1] || match[0];
      const names = extractNamesFromSection(sectionHtml);
      names.forEach(name => results[category].add(name));
    }
  }

  // Convert Sets to Arrays and limit
  return {
    customers: Array.from(results.customers).slice(0, 20),
    suppliers: Array.from(results.suppliers).slice(0, 20),
    principals: Array.from(results.principals).slice(0, 20),
    brands: Array.from(results.brands).slice(0, 20)
  };
}

// Legacy wrapper for backward compatibility
function extractCustomersFromSections(rawHtml) {
  const relationships = extractBusinessRelationships(rawHtml);
  // Return all as one array for backward compatibility
  return [...new Set([
    ...relationships.customers,
    ...relationships.suppliers,
    ...relationships.principals,
    ...relationships.brands
  ])].slice(0, 30);
}

// ===== GPT-4o Vision-based Logo Reading =====
// Extracts company/brand names by actually reading logo images with GPT-4o vision
async function extractNamesFromLogosWithVision(rawHtml, websiteUrl) {
  if (!rawHtml) return { customers: [], brands: [] };

  try {
    // Step 1: Find images in customer/client/partner/brand sections
    // Includes English + Indonesian + Thai + Vietnamese + Chinese keywords
    const sectionKeywords = [
      // English
      'client', 'customer', 'partner', 'brand', 'principal', 'supplier',
      'trusted', 'work with', 'served', 'portfolio', 'logo',
      // Indonesian
      'mitra', 'pelanggan', 'klien', 'merek', 'pemasok',
      // Thai
      'พันธมิตร', 'ลูกค้า', 'แบรนด์',
      // Vietnamese
      'đối tác', 'khách hàng',
      // Chinese
      '合作', '客户', '品牌'
    ];
    const keywordPattern = sectionKeywords.join('|');

    // Find relevant sections
    const sectionPattern = new RegExp(
      `<(?:section|div|ul|article)[^>]*(?:class|id)=["'][^"']*(?:${keywordPattern})[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:section|div|ul|article)>`,
      'gi'
    );
    const headingPattern = new RegExp(
      `<h[1-6][^>]*>[^<]*(?:${keywordPattern})[^<]*<\\/h[1-6]>([\\s\\S]{0,5000}?)(?=<h[1-6]|<\\/section|<\\/main|$)`,
      'gi'
    );

    let relevantHtml = '';
    let match;
    while ((match = sectionPattern.exec(rawHtml)) !== null) {
      relevantHtml += match[0] + '\n';
    }
    while ((match = headingPattern.exec(rawHtml)) !== null) {
      relevantHtml += match[0] + '\n';
    }

    // If no relevant sections found, check for logo grids anywhere
    if (!relevantHtml) {
      const logoGridPattern = /<(?:div|ul)[^>]*class=["'][^"']*(?:logo|grid|carousel|slider|swiper|owl|slick)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|ul)>/gi;
      while ((match = logoGridPattern.exec(rawHtml)) !== null) {
        relevantHtml += match[0] + '\n';
      }
    }

    // AGGRESSIVE FALLBACK: If still nothing found, scan entire page for image clusters
    // Look for any div/section containing 3+ images (likely a logo grid)
    if (!relevantHtml) {
      console.log('    Vision: No keyword sections found, scanning for image clusters...');
      const allSections = rawHtml.match(/<(?:div|section|ul)[^>]*>[\s\S]*?<\/(?:div|section|ul)>/gi) || [];
      for (const section of allSections) {
        const imgCount = (section.match(/<img/gi) || []).length;
        if (imgCount >= 3 && section.length < 50000) {
          relevantHtml += section + '\n';
        }
      }
    }

    if (!relevantHtml) {
      console.log('    Vision: No customer/brand sections found');
      return { customers: [], brands: [] };
    }

    // Step 2: Extract image URLs from relevant sections
    // Handle both regular src and lazy-loaded images (data-src, data-lazy-src, data-original)
    const imageUrls = new Set();

    // Pattern 1: Regular src attribute
    const srcPattern = /<img[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi;
    while ((match = srcPattern.exec(relevantHtml)) !== null) {
      const url = match[1];
      if (!url.startsWith('data:')) imageUrls.add(url);
    }

    // Pattern 2: Lazy-loaded data-src attribute
    const dataSrcPattern = /<img[^>]*\sdata-src=["']([^"']+)["'][^>]*>/gi;
    while ((match = dataSrcPattern.exec(relevantHtml)) !== null) {
      imageUrls.add(match[1]);
    }

    // Pattern 3: Lazy-loaded data-lazy-src attribute
    const dataLazySrcPattern = /<img[^>]*\sdata-lazy-src=["']([^"']+)["'][^>]*>/gi;
    while ((match = dataLazySrcPattern.exec(relevantHtml)) !== null) {
      imageUrls.add(match[1]);
    }

    // Pattern 4: data-original (common in jQuery lazy load)
    const dataOriginalPattern = /<img[^>]*\sdata-original=["']([^"']+)["'][^>]*>/gi;
    while ((match = dataOriginalPattern.exec(relevantHtml)) !== null) {
      imageUrls.add(match[1]);
    }

    // Process and filter URLs
    const processedUrls = [];
    for (let imgUrl of imageUrls) {
      // Skip tiny images, icons, and data URIs
      if (imgUrl.startsWith('data:')) continue;
      if (/icon|favicon|pixel|spacer|1x1|loading|placeholder/i.test(imgUrl)) continue;

      // Convert relative URLs to absolute
      if (!imgUrl.startsWith('http')) {
        try {
          const base = new URL(websiteUrl);
          imgUrl = new URL(imgUrl, base.origin).href;
        } catch {
          continue;
        }
      }

      processedUrls.push(imgUrl);
    }

    // Limit to 8 images to avoid rate limits and keep response time reasonable
    const limitedUrls = processedUrls.slice(0, 8);

    if (limitedUrls.length === 0) {
      console.log('    Vision: No logo images found in sections');
      return { customers: [], brands: [] };
    }

    console.log(`    Vision: Found ${limitedUrls.length} logo images to analyze`);

    // Step 3: Fetch images as base64 (parallel, with timeout)
    const imageContents = [];
    const fetchPromises = limitedUrls.map(async (url) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout per image

        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProfileBot/1.0)' }
        });
        clearTimeout(timeout);

        if (!response.ok) return null;

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('image')) return null;

        const buffer = await response.buffer();
        if (buffer.length < 500) return null; // Skip tiny images
        if (buffer.length > 2 * 1024 * 1024) return null; // Skip > 2MB

        const base64 = buffer.toString('base64');
        const mimeType = contentType.split(';')[0] || 'image/jpeg';

        return { url, base64, mimeType };
      } catch {
        return null;
      }
    });

    const results = await Promise.all(fetchPromises);
    const validImages = results.filter(r => r !== null);

    if (validImages.length === 0) {
      console.log('    Vision: Failed to fetch any logo images');
      return { customers: [], brands: [] };
    }

    console.log(`    Vision: Successfully fetched ${validImages.length} images, sending to GPT-4o...`);

    // Step 4: Send to GPT-4o Vision (single API call with all images)
    const visionContent = [
      {
        type: 'text',
        text: `These are logo images from a company website's "clients", "partners", or "brands" section.
For each logo image, identify the company or brand name shown.
Return ONLY a JSON object with this exact format:
{"customers": ["Company A", "Company B"], "brands": ["Brand X", "Brand Y"]}

Rules:
- "customers" = companies that appear to be clients/customers (usually corporate logos)
- "brands" = product brands or consumer brands (usually product logos)
- If you can't read a logo clearly, skip it
- Return empty arrays if no names can be identified
- Do NOT include generic words like "logo", "image", "client"
- Return ONLY the JSON, no explanation`
      }
    ];

    // Add all images to the content
    for (const img of validImages) {
      visionContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimeType};base64,${img.base64}`,
          detail: 'low' // Use low detail to reduce tokens and speed up
        }
      });
    }

    const visionResponse = await withRetry(async () => {
      return await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: visionContent }],
        max_tokens: 500,
        temperature: 0.1
      });
    }, 2, 3000); // 2 retries, 3s base delay for rate limits

    const responseText = visionResponse.choices[0]?.message?.content || '{}';

    // Parse JSON response
    let parsed = { customers: [], brands: [] };
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch (parseErr) {
      console.log(`    Vision: Failed to parse response: ${responseText.substring(0, 100)}`);
    }

    // Clean and validate names
    const cleanNames = (arr) => {
      if (!Array.isArray(arr)) return [];
      return arr
        .map(name => cleanCustomerName(String(name)))
        .filter(name => name && name.length >= 2);
    };

    const result = {
      customers: cleanNames(parsed.customers),
      brands: cleanNames(parsed.brands)
    };

    console.log(`    Vision: Identified ${result.customers.length} customers, ${result.brands.length} brands`);

    return result;

  } catch (error) {
    console.log(`    Vision: Error - ${error.message}`);
    return { customers: [], brands: [] };
  }
}

// ===== Full-Page Screenshot + Vision Analysis =====
// Takes a screenshot of the entire page and uses GPT-4o Vision to identify partner/customer logos
// This bypasses all HTML parsing issues - sees what humans see
async function extractPartnersFromScreenshot(websiteUrl) {
  if (!websiteUrl) return { customers: [], brands: [], principals: [] };

  // Check if screenshot API is configured
  const screenshotApiKey = process.env.SCREENSHOT_API_KEY;
  const screenshotApiUrl = process.env.SCREENSHOT_API_URL || 'https://shot.screenshotapi.net/screenshot';

  if (!screenshotApiKey) {
    console.log('    Screenshot: Skipped (SCREENSHOT_API_KEY not configured)');
    return { customers: [], brands: [], principals: [] };
  }

  try {
    console.log('    Screenshot: Taking full-page screenshot...');

    // Normalize URL
    let url = websiteUrl;
    if (!url.startsWith('http')) {
      url = 'https://' + url;
    }

    // Take screenshot using external API
    // Supports: screenshotapi.net, screenshotone.com, or similar services
    const screenshotParams = new URLSearchParams({
      token: screenshotApiKey,
      url: url,
      output: 'image',
      file_type: 'png',
      wait_for_event: 'load',
      delay: 2000,  // Wait 2s for JS to render
      full_page: 'false',  // Just viewport, not full page (faster, cheaper)
      width: 1280,
      height: 800
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(`${screenshotApiUrl}?${screenshotParams}`, {
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`    Screenshot: API returned ${response.status}`);
      return { customers: [], brands: [], principals: [] };
    }

    const imageBuffer = await response.buffer();
    if (imageBuffer.length < 10000) {
      console.log('    Screenshot: Image too small, likely failed');
      return { customers: [], brands: [], principals: [] };
    }

    const base64Image = imageBuffer.toString('base64');
    console.log(`    Screenshot: Got ${Math.round(imageBuffer.length / 1024)}KB image, analyzing with Vision...`);

    // Send to GPT-4o Vision
    const visionResponse = await withRetry(async () => {
      return await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
                detail: 'high'  // Use high detail for better logo recognition
              }
            },
            {
              type: 'text',
              text: `Analyze this company website screenshot. Look for sections showing:
- Partners / Principal brands (companies they distribute for or represent)
- Customers / Clients (companies they sell to)
- Brands they carry or distribute

These are typically shown as logo grids, carousels, or lists with company names.

Return ONLY a JSON object:
{
  "principals": ["Brand A", "Brand B"],
  "customers": ["Customer 1", "Customer 2"],
  "brands": ["Brand X", "Brand Y"]
}

Rules:
- Extract actual company/brand names visible on the page
- "principals" = brands/companies this company distributes for or represents
- "customers" = companies that buy from this company
- "brands" = product brands this company carries
- Skip generic text like "Our Partners", "Clients", etc.
- If a section is not visible or empty, return empty array
- Return ONLY valid JSON, no explanation`
            }
          ]
        }],
        max_tokens: 800,
        temperature: 0.1
      });
    }, 2, 3000);

    const responseText = visionResponse.choices[0]?.message?.content || '{}';

    // Parse JSON response
    let parsed = { customers: [], brands: [], principals: [] };
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch (parseErr) {
      console.log(`    Screenshot: Failed to parse response`);
    }

    // Clean names
    const cleanNames = (arr) => {
      if (!Array.isArray(arr)) return [];
      return arr
        .map(name => cleanCustomerName(String(name)))
        .filter(name => name && name.length >= 2);
    };

    const result = {
      customers: cleanNames(parsed.customers),
      brands: cleanNames(parsed.brands),
      principals: cleanNames(parsed.principals)
    };

    const total = result.customers.length + result.brands.length + result.principals.length;
    console.log(`    Screenshot: Found ${result.principals.length} principals, ${result.customers.length} customers, ${result.brands.length} brands`);

    return result;

  } catch (error) {
    console.log(`    Screenshot: Error - ${error.message}`);
    return { customers: [], brands: [], principals: [] };
  }
}

// ===== Business Type Detection =====
// Detects B2C, project-based, or industrial based on keywords in business description
function detectBusinessType(businessDescription, scrapedContent) {
  const text = `${businessDescription || ''} ${scrapedContent || ''}`.toLowerCase();

  // B2C keywords (restaurants, hotels, retail, consumer products)
  const b2cKeywords = [
    'restaurant', 'cafe', 'coffee', 'bakery', 'food service', 'catering',
    'hotel', 'resort', 'hospitality', 'accommodation', 'lodging',
    'retail', 'shop', 'store', 'boutique', 'mall', 'outlet',
    'salon', 'spa', 'beauty', 'wellness', 'fitness', 'gym',
    'clinic', 'dental', 'medical center', 'healthcare',
    'school', 'education', 'training center', 'academy',
    'entertainment', 'cinema', 'theater', 'amusement',
    'consumer', 'b2c', 'end user', 'retail customer',
    'menu', 'dine', 'dining', 'cuisine', 'chef',
    'fashion', 'clothing', 'apparel', 'accessories',
    'supermarket', 'grocery', 'convenience store', 'minimart'
  ];

  // Project-based keywords (construction, engineering, development)
  const projectKeywords = [
    'construction', 'contractor', 'builder', 'developer',
    'engineering', 'epc', 'design and build', 'turnkey',
    'infrastructure', 'civil works', 'building project',
    'architecture', 'interior design', 'renovation',
    'property development', 'real estate development',
    'installation', 'commissioning', 'project management',
    'marine', 'offshore', 'shipyard', 'vessel',
    'power plant', 'oil and gas', 'refinery',
    'completed project', 'project portfolio', 'project reference',
    'our project', 'past project', 'recent project'
  ];

  // Count keyword matches
  let b2cScore = 0;
  let projectScore = 0;

  for (const keyword of b2cKeywords) {
    if (text.includes(keyword)) b2cScore++;
  }

  for (const keyword of projectKeywords) {
    if (text.includes(keyword)) projectScore++;
  }

  // Determine type based on scores
  if (b2cScore >= 2 || (b2cScore >= 1 && projectScore === 0)) {
    return 'b2c';
  } else if (projectScore >= 2 || (projectScore >= 1 && b2cScore === 0)) {
    return 'project';
  }

  return null; // Let AI decide
}


// Helper: Clean and validate customer name
function cleanCustomerName(text) {
  if (!text || typeof text !== 'string') return '';

  let name = text.trim()
    .replace(/<[^>]+>/g, '') // Remove HTML
    .replace(/&amp;/g, '&') // Decode HTML entity
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '') // Remove numeric HTML entities
    .replace(/\s+/g, ' ')
    .trim();

  // Skip generic terms
  const skipTerms = [
    'logo', 'image', 'photo', 'icon', 'banner', 'client', 'customer', 'partner',
    'view', 'click', 'here', 'more', 'read', 'learn', 'see', 'our', 'the', 'and',
    'trusted', 'brands', 'companies', 'clients', 'partners', 'customers'
  ];

  const lowerName = name.toLowerCase();
  if (skipTerms.some(term => lowerName === term || lowerName.startsWith(term + ' '))) {
    return '';
  }

  // Skip if too short, too long, or contains only numbers
  if (name.length < 2 || name.length > 50 || /^\d+$/.test(name)) {
    return '';
  }

  // ========== Filter out garbage data ==========

  // Skip image filenames and artifacts (specific patterns to avoid false positives)
  const imageGarbagePatterns = [
    /[-_]removebg|removebg[-_]/i, // removebg artifact
    /[-_]preview|preview[-_]|\spreview$/i, // "xxx preview" or "xxx-preview"
    /[-_]scaled|scaled[-_]|\d+x\s*scaled/i, // scaled artifact
    /[-_]cover[-_]|home[-_]page[-_]cover/i, // cover as filename part
    /\d+x\d*$/, // Dimensions like "140x" at end
    /^\d+$/, // Just numbers
    /_\d+$/, // Trailing numbers like "_1"
    /\.(jpg|jpeg|png|gif|webp|svg|ico)$/i, // File extensions
    /^(img|image|pic|photo|logo|icon)[-_]/i, // Image prefixes
  ];

  if (imageGarbagePatterns.some(pattern => pattern.test(name))) {
    return '';
  }

  // Skip URL fragments and paths (but allow S/A which is common in company names)
  if (name.includes('~')) return '';
  if (/\/\d+\/|\/blog\/|\/images?\//i.test(name)) return '';
  if (/\d{4}\/\d+\/\d+/.test(name)) return ''; // Date paths like 2025/6/4

  // Skip image descriptions (more specific patterns)
  const descriptionPatterns = [
    /^a\s+\w+\s+with\s+/i, // "A room with..."
    /^the\s+\w+\s+(is|are|was|has)/i, // "The company is..."
    /\s+displaying\s+/i,
    /\s+showing\s+/i,
    /\s+featuring\s+/i,
    /multiple\s+(security|camera|monitor)/i,
    /various\s+(camera|security|monitor)/i,
    /camera\s+feeds/i,
    /security\s+monitors\s+displaying/i,
    /control\s+room\s+with/i,
    /group\s+of\s+people/i,
  ];

  if (descriptionPatterns.some(pattern => pattern.test(name))) {
    return '';
  }

  // Skip if looks like a sentence (too many words for a company name)
  const wordCount = name.split(/\s+/).length;
  if (wordCount > 8) {
    return '';
  }

  // Skip CSS class-like patterns
  if (/^[a-z]+-[a-z]+-[a-z]+$/i.test(name) && !name.includes(' ')) {
    return '';
  }

  // Skip "Page Client Sponsor" patterns
  if (/page\s*client\s*sponsor/i.test(name)) {
    return '';
  }

  // ========== END FILTERS ==========

  // Clean company name (remove suffixes)
  name = cleanCompanyName(name);

  return name;
}

// AI Agent 1: Extract company name, established year, location
// Using GPT-4o (not mini) because location extraction is CRITICAL and needs:
// - Accurate non-English parsing (Thai, Vietnamese addresses)
// - Simple 2-level format (State/Province, Country)
// - This is the most important extraction - wrong HQ ruins the profile
async function extractBasicInfo(scrapedContent, websiteUrl) {
  try {
    const response = await withRetry(() => openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You extract company information from website content.

OUTPUT JSON with these fields:
- company_name: Company name with first letter of each word capitalized. Remove suffixes like Limited, Ltd, Sdn Bhd, Pte Ltd, PT, Inc, Corp, Company.
- established_year: Clean numbers only (e.g., "1995"), leave empty if not found
- location: HEADQUARTERS ONLY - extract ONLY the main HQ location.

LOCATION FORMAT - EXACTLY 2 LEVELS: "State/Province, Country"
- NO city names, NO district names, NO street addresses
- Just STATE/PROVINCE and COUNTRY

CORRECT EXAMPLES (2 levels only):
- Malaysia: "Selangor, Malaysia", "Johor, Malaysia", "Penang, Malaysia"
- Thailand: "Bangkok, Thailand", "Samut Prakan, Thailand", "Rayong, Thailand", "Chonburi, Thailand"
- Indonesia: "West Java, Indonesia", "Banten, Indonesia", "East Java, Indonesia"
- Vietnam: "Ho Chi Minh City, Vietnam", "Hanoi, Vietnam", "Binh Duong, Vietnam"
- Philippines: "Metro Manila, Philippines", "Cebu, Philippines"
- Singapore: "Area, Singapore" - MUST include REAL area! e.g., "Jurong, Singapore", "Tuas, Singapore", "Tampines, Singapore", "Changi, Singapore", "Woodlands, Singapore"
  - Look for Singapore postal codes to identify area: 60xxxx=Jurong, 62xxxx=Tuas, 01-09xxxx=Raffles Place, 5xxxxx=Changi, 7xxxxx=Woodlands
  - "Central" is NOT a valid area - NEVER use it. If no area identifiable, just use "Singapore"

WRONG (too many levels - NO city/district names!):
- "Shah Alam, Selangor, Malaysia" ← WRONG! Just "Selangor, Malaysia"
- "Bang Bon, Bangkok, Thailand" ← WRONG! Just "Bangkok, Thailand"
- "Tangerang, Banten, Indonesia" ← WRONG! Just "Banten, Indonesia"

WRONG (includes addresses):
- "22, Jalan Sementa 27/91, Shah Alam" ← WRONG! No addresses!

CRITICAL - ENGLISH ONLY:
- ALL output MUST be in English letters (A-Z) only
- NEVER output Thai: กรุงเทพ → "Bangkok", สมุทรสาคร → "Samut Sakhon"
- NEVER output Vietnamese with diacritics: "Hồ Chí Minh" → "Ho Chi Minh City"
- NEVER output Chinese: 北京 → "Beijing"
- If you see Thai/Chinese/Vietnamese text, TRANSLATE it to English

RULES:
- ONLY extract HQ location - ignore branches, factories, warehouses
- Extract province/state from actual address on website
- Most Thai industrial companies are NOT in Bangkok - check actual address!
- If you cannot find an address, leave location empty
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Website: ${websiteUrl}
Content: ${scrapedContent.substring(0, 25000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    }));

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 1 error:', e.message);
    return { company_name: '', established_year: '', location: '' };
  }
}

// Post-process and validate HQ location format
// ALL countries: EXACTLY 2 levels (State/Province, Country)
// Singapore: "Area, Singapore" preferred, "Singapore" as fallback
function validateAndFixHQFormat(location, websiteUrl) {
  if (!location || typeof location !== 'string') return location;

  let loc = location.trim();

  // SAFETY: Reject non-ASCII (Thai/Chinese/Vietnamese) text entirely
  if (/[^\x00-\x7F]/.test(loc)) {
    console.log(`  [HQ Fix] REJECTED non-English location: "${loc}"`);
    return ''; // Return empty - extraction prompt should have given English
  }

  // Remove any "HQ:" prefix
  loc = loc.replace(/^-?\s*HQ:\s*/i, '').trim();

  const parts = loc.split(',').map(p => p.trim()).filter(p => p);
  const lastPart = parts[parts.length - 1]?.toLowerCase() || '';

  // Check if Singapore
  const isSingapore = lastPart === 'singapore' || loc.toLowerCase() === 'singapore';

  if (isSingapore) {
    // Singapore: keep "Area, Singapore" if we have 2 parts, otherwise just "Singapore"
    if (parts.length >= 2) {
      // e.g., "Jurong, Singapore" or "CBD, Singapore"
      return parts.slice(-2).join(', ');
    }
    // Just "Singapore" - AI couldn't find specific area
    return 'Singapore';
  }

  // Non-Singapore: must be exactly 2 levels (State/Province, Country)
  if (parts.length > 2) {
    // Too many levels, keep last 2 only
    const fixed = parts.slice(-2).join(', ');
    console.log(`  [HQ Fix] Trimmed to 2 levels: "${loc}" → "${fixed}"`);
    return fixed;
  }
  if (parts.length === 1) {
    // Only country name - incomplete
    console.log(`  [HQ Warning] Location missing province: "${loc}"`);
    return ''; // Return empty
  }
  return loc; // Already 2 levels
}

// AI Agent 2: Extract business, message, footnote, title
// Using gpt-4o-mini (cheaper) since Marker AI pre-identifies content and Validator catches misses
async function extractBusinessInfo(scrapedContent, basicInfo) {
  // Ensure locationText is always a string (AI might return object/array)
  const locationText = typeof basicInfo.location === 'string' ? basicInfo.location : '';
  const hqMatch = locationText.match(/HQ:\s*([^,\n]+),\s*([^\n]+)/i);
  const hqCountry = hqMatch ? hqMatch[2].trim().toLowerCase() : '';
  const currencyExchange = CURRENCY_EXCHANGE[hqCountry] || '';

  try {
    const response = await withRetry(() => openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You extract business information from website content for M&A discussion slides.

INPUT:
- HTML content from company website
- Previously extracted: company name, year, location

OUTPUT JSON:
1. business: Description of what company does. Use 1-3 bullet points - ONLY as many as needed, NOT always 3. Format each line starting with "- ".

   FORMAT REQUIREMENT: Use this structure (vary the connector words naturally):
   - "Manufacture [category] including [top 3 products]"
   - "Distribute [category] for [applications]"
   - "Provide [service type] for [use cases]"

   Connector options: "such as", "including", "for", "like", "covering" - vary them naturally, don't always use "such as".

   Examples:
   "- Manufacture printing inks including gravure inks, flexographic inks, and UV inks\\n- Provide technical services for printing process optimization"

   RULES FOR BUSINESS POINTS:
   - Use ONLY 1-3 points depending on what the company actually does
   - If company only manufactures, use 1 point. Don't add filler.
   - NEVER include generic statements like "Conduct R&D", "Provide quality products", "Focus on innovation"
   - NEVER include vague services like "customized solutions", "quality assurance" unless those are their PRIMARY business
   - Only include points with SPECIFIC, CONCRETE content

   CRITICAL - NO MARKETING/BOASTING LANGUAGE:
   - NEVER use: "high-quality", "premium", "world-class", "leading", "best-in-class", "superior", "excellent", "top-tier"
   - NEVER use: "state-of-the-art", "cutting-edge", "innovative", "advanced", "modern"
   - These are unverified claims from the company - we haven't contacted them to verify quality
   - Use neutral language: "Manufacture printing inks" NOT "Manufacture high-quality printing inks"

2. message: One-liner introductory message about the company. NO marketing words (high-quality, premium, leading, etc.)
   Example: "Malaysia-based distributor specializing in electronic components and industrial automation products across Southeast Asia."
   NOT: "Malaysia-based leading distributor of high-quality electronic components..."

3. footnote: Two parts:
   - Notes (optional): If unusual shortforms used, write full-form like "SKU (Stock Keeping Unit)". Separate multiple with comma.
   - Currency: ${currencyExchange || 'Leave empty if no matching currency'}
   Separate notes and currency with semicolon. Always end with new line: "出典: 会社ウェブサイト、SPEEDA"

4. title: Company name WITHOUT suffix (remove Pte Ltd, Sdn Bhd, Co Ltd, JSC, PT, Inc, etc.)

RULES:
- Write ALL text using regular English alphabet only (A-Z, no diacritics/accents)
- Convert ALL Vietnamese: "Phú" → "Phu", "Đông" → "Dong", "Nguyễn" → "Nguyen", "Bình" → "Binh", "Thạnh" → "Thanh", "Cương" → "Cuong"
- Convert ALL foreign characters: "São" → "Sao", "北京" → "Beijing", "東京" → "Tokyo"
- All bullet points must use "- " (dash followed by space)
- Each bullet point on new line using "\\n"
- Keep it to the MOST KEY items only (3 bullet points max)
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Company: ${basicInfo.company_name}
Established: ${basicInfo.established_year}
Location: ${basicInfo.location}

Website Content:
${scrapedContent.substring(0, 25000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    }));

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 2 error:', e.message);
    return { business: '', message: '', footnote: '', title: basicInfo.company_name || '' };
  }
}

// AI Agent 3: Extract key metrics for M&A evaluation
// Using gpt-4o-mini (cheaper) since Marker AI pre-identifies content and Validator catches misses
async function extractKeyMetrics(scrapedContent, previousData) {
  try {
    const response = await withRetry(() => openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst extracting COMPREHENSIVE key business metrics for potential buyers evaluating this company.

CRITICAL - VISIBLE STATISTICS FIRST:
Before anything else, scan the ENTIRE page for ANY prominently displayed numbers/statistics:
- Look for large numbers displayed on the homepage (e.g., "880", "300+", "60", "12")
- These are often shown in counter/stat sections with labels below them
- Common patterns: "60 Customers", "880 Colour Matching", "300+ Employees", "12 New Projects"
- TRANSLATE any non-English labels to English (e.g., "Kota Distribusi" = "Distribution Cities", "Project Baru" = "New Projects")
- Include ALL visible statistics with their labels in the "Key Metrics" field

NON-ENGLISH WEBSITE PATTERNS (CRITICAL - recognize these!):

THAI: "800 ตัน/เดือน" = 800 tons/month, "250 เครื่อง" = 250 machines, "700 พันธมิตร" = 700 partners
VIETNAMESE: "800 tấn/tháng" = 800 tons/month, "250 máy" = 250 machines, "700 đối tác" = 700 partners
INDONESIAN: "800 ton/bulan" = 800 tons/month, "250 mesin" = 250 machines, "700 mitra" = 700 partners
CHINESE: "800吨/月" = 800 tons/month, "250台设备" = 250 machines, "700家经销商" = 700 distributors
KOREAN: "800톤/월" = 800 tons/month, "250대 기계" = 250 machines, "700개 파트너" = 700 partners
HINDI: "800 टन/माह" = 800 tons/month, "250 मशीन" = 250 machines, "700 वितरक" = 700 distributors
BENGALI: "800 টন/মাস" = 800 tons/month, "250 মেশিন" = 250 machines, "700 পরিবেশক" = 700 distributors

Numbers next to ANY non-English text are likely important metrics - EXTRACT THEM and TRANSLATE the label to English!

EXTRACT AS MANY OF THESE METRICS AS POSSIBLE (aim for 8-15 metrics):

CUSTOMERS & MARKET (CRITICAL - LOOK EVERYWHERE FOR CLIENTS):
- Key customer names (look for: "Clients", "Customers", "Our Clients", logo sections, testimonials)
- IMPORTANT: If website shows CLIENT LOGOS, extract those company names (e.g., Sinarmas, Dole, SCG logos = customer names)
- Number of customers (total active customers)
- Customer segments served

SUPPLIERS & PARTNERSHIPS (CRITICAL FOR DISTRIBUTORS):
- Principal brands/suppliers (for distributors: look for "Our Brands", "Principals", "Partners" with LOGOS)
- IMPORTANT: If website shows SUPPLIER/BRAND LOGOS, extract those company names!
- Key supplier/partner names
- Notable partnerships, JVs, technology transfers
- Exclusive distribution agreements
- For distributors: the brands they distribute are CRITICAL info - capture ALL of them!

OPERATIONS & SCALE:
- Production capacity (units/month, tons/month)
- Factory/warehouse size (m², sq ft)
- Number of machines/equipment
- Number of employees/headcount
- Number of SKUs/products

GEOGRAPHIC REACH (CRITICAL - CAPTURE ALL DISTRIBUTION INFO):
- Export countries (list ALL countries mentioned: Thailand, Sri Lanka, Pakistan, Bangladesh, UAE, etc.)
- Distribution network (distributors, agents, dealers - include country names)
- Markets served (if domestic only, write "Nationwide" instead of listing regions)
- CRITICAL: If website mentions "agents and distributors across [countries]" or "network in [countries]" - LIST ALL COUNTRIES!
- Example: "agents and distributors across Thailand, Sri Lanka, Pakistan, Bangladesh, UAE, Papua New Guinea, Vietnam, Poland, East Malaysia" → capture ALL 9 countries
- This is CRITICAL M&A info showing international expansion - never skip it!

INDUSTRIES SERVED:
- List the industries/applications the company serves (e.g., "Gravure Printing, Screen Printing, Footwear, Leather, Rubber")
- Look for "Industries We Serve", "Applications", "Markets" sections

QUALITY & COMPLIANCE:
- Certifications (ISO, HACCP, GMP, FDA, CE, halal, etc.)
- Patents or proprietary technology

OUTPUT JSON - CRITICAL: INCLUDE SOURCE QUOTES FOR VERIFICATION:
{
  "key_metrics": [
    {
      "label": "Key Metrics",
      "value": "- Production capacity of 800 tons/month\\n- 250 machines\\n- 300 employees",
      "source_quotes": ["กำลังการผลิต 800 ตัน/เดือน", "250 เครื่องจักร", "พนักงาน 300 คน"]
    },
    {
      "label": "Key Suppliers",
      "value": "6 suppliers including Hikvision, Dahua, Paradox, ZKTeco, Ruijie",
      "source_quotes": ["Our partners include Hikvision, Dahua, Paradox, ZKTeco, and Ruijie"]
    },
    {
      "label": "Export Countries",
      "value": "Thailand, Sri Lanka, Bangladesh, UAE, Vietnam",
      "source_quotes": ["we export to Thailand, Sri Lanka, Bangladesh, UAE, and Vietnam"]
    },
    {
      "label": "Certification",
      "value": "ISO 9001, ISO 14001",
      "source_quotes": ["ISO 9001:2015", "ISO 14001:2015"]
    }
  ]
}

SOURCE QUOTE RULES (ANTI-HALLUCINATION):
1. Every metric MUST include "source_quotes" array with text from the website that proves this data
2. Source quotes can be in ANY language (Thai, Chinese, etc.) - copy text from the website
3. For numerical metrics, the quote MUST contain the actual number
4. The system verifies quotes exist in scraped content - unverifiable quotes = metric rejected
5. NEVER make up data - if you can't quote it from the website, don't include it
6. Quote matching is FLEXIBLE: partial matches, number + context words will work
7. Extract ALL metrics you can find AND quote - comprehensive extraction is critical

MERGE DUPLICATIVE INFORMATION:
When you find BOTH a count AND specific names for the same category, MERGE them into ONE coherent entry:
- BAD: {"label": "Number of Suppliers", "value": "6"} AND {"label": "Key Suppliers", "value": "Hikvision, Dahua, Paradox"}
- GOOD: {"label": "Key Suppliers", "value": "6 suppliers including Hikvision, Dahua, Paradox, ZKTeco, Ruijie"}

- BAD: {"label": "Number of Customers", "value": "250,000"} AND {"label": "Key Customers", "value": "Installers, Dealers, Integrators"}
- GOOD: {"label": "Key Customers", "value": "Over 250,000 installations including Installers, Dealers, System Integrators"}

- BAD: {"label": "Number of Employees", "value": "100+"} in metrics array
- GOOD: Include employee count in "Key Metrics" bullet point

SEGMENTATION REQUIREMENT:
For metrics with MANY items (e.g., Customers, Suppliers), segment them by category using POINT FORM:
Example for Customers:
{"label": "Customers", "value": "- Residential: Customer1, Customer2, Customer3\\n- Commercial: Customer4, Customer5\\n- Industrial: Customer6, Customer7"}

Example for Suppliers:
{"label": "Suppliers", "value": "- Raw Materials: Supplier1, Supplier2\\n- Packaging: Supplier3, Supplier4\\n- Equipment: Supplier5"}

IMPORTANT: Always use "- " prefix for each segment line to create point form for easier reading.

RULES:
- HARD RULE - TRANSLATE ALL NON-ENGLISH TEXT TO ENGLISH:
  - ALL text in ANY non-English language MUST be translated to English
  - This applies to ALL languages: Thai, Vietnamese, Chinese, Malay, Indonesian, Hindi, Korean, Japanese, Arabic, Spanish, etc.
  - Units: "ไร่" → "rai", "ตร.ม." → "sqm", "ตัน/เดือน" → "tons/month", "พนักงาน" → "employees"
  - NEVER leave Thai, Chinese, or other non-English characters in the output
  - The user CANNOT translate - you MUST translate everything to English
- UNCOMMON ABBREVIATIONS - INCLUDE DEFINITIONS INLINE:
  - For technical/industry abbreviations that are NOT common knowledge, include the full form in parentheses
  - Example: "PU (Polyurethane)", "EVA (Ethylene Vinyl Acetate)", "ABS (Acrylonitrile Butadiene Styrene)"
  - Example: "OPP (Oriented Polypropylene)", "PET (Polyethylene Terephthalate)", "HDPE (High-Density Polyethylene)"
  - Common abbreviations that DON'T need explanation: ISO, FDA, GMP, HACCP, B2B, B2C, CEO, CFO, HQ, USD, EUR, sqm, kg
  - Use your judgment: if a reader unfamiliar with the industry wouldn't know what it means, include the definition
- Write ALL text using regular English alphabet only (A-Z, no diacritics, no foreign characters)
- Remove company suffixes from ALL names: Co., Ltd, JSC, Sdn Bhd, Pte Ltd, Inc, Corp, LLC, GmbH
- Extract as many metrics as found (8-15 ideally)
- For metrics with multiple items, use "- " bullet points separated by "\\n"
- For long lists of customers/suppliers, SEGMENT by category as shown above
- Labels should be 1-3 words
- Be specific with numbers when available
- For Shareholding: ONLY include if EXPLICITLY stated on website (e.g., "family-owned", "publicly traded", "PE-backed"). NEVER assume ownership structure.
- DO NOT include: years of experience, awards, recognitions, market position, operating hours, number of branches/locations (not useful for M&A)
- DO NOT include: corporate vision, mission statement, company values, slogans, taglines
- DO NOT include garbage metrics like: "Quality Standards", "Innovation Focus", "Customer Service", "Technical Support", "R&D Focus", "Quality Assurance", "Service Excellence" - these are meaningless fluff
- DO NOT include vague phrases like "High standards in customer service", "Constant innovation", "Focus on quality" - these have no concrete value
- DO NOT include metrics with NO MEANINGFUL VALUES - if you don't have specific data, don't include the metric at all
- CRITICAL - NEVER GENERATE FAKE/PLACEHOLDER DATA:
  - NEVER write alphabetical placeholders like "Distributor A, Distributor B", "Partner X, Partner Y", "Customer 1, Customer 2"
  - NEVER write "Client 1, Client 2", "Customer A, Customer B", "Supplier A, Supplier B"
  - NEVER write "Not specified", "Various", "Multiple", "Several"
  - If you don't have REAL names, DO NOT include the metric at all
- NEVER use generic industry descriptions like "Printing Industry: Various Printers" or "Packaging Industry: Various Companies" - either provide ACTUAL company names or don't include the metric
- NEVER include metrics without actual numbers. BAD: "Production capacity of solvent-based inks". GOOD: "Production capacity: 500 tons/month"
- NEVER include generic R&D statements like "Intensive R&D for product improvement"
- For Factory Size: ONLY include actual measurements (e.g., "7,500 m²"). Do NOT include factory locations - those go in the HQ/Location field.
- If you cannot find actual customer/supplier names, DO NOT include those metrics at all
- NEVER make up data - only include what's explicitly stated on the website
- SHORT LIST FORMATTING: If only 2-3 items, write comma-separated inline (e.g., "Singapore, Sri Lanka"), NOT point form
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Company: ${previousData.company_name}
Industry/Business: ${previousData.business}

Website Content (extract ALL M&A-relevant metrics):
${scrapedContent.substring(0, 35000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    }));

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 3 error:', e.message);
    return { key_metrics: [] };
  }
}

// AI Agent 3a-focused: Extract SPECIFIC missed metrics identified by validator
// This is a focused re-extraction that knows exactly what to look for
async function extractKeyMetricsWithFocus(scrapedContent, context) {
  try {
    console.log('    Running focused re-extraction for missed items...');

    const response = await withRetry(() => openai.chat.completions.create({
      model: 'gpt-4o',  // Use stronger model for focused extraction
      messages: [
        {
          role: 'system',
          content: `You are extracting SPECIFIC metrics that were missed in the first extraction pass.

## ALREADY EXTRACTED (do NOT duplicate):
${context.existingMetrics || 'None yet'}

## MISSED ITEMS TO FIND (the validator identified these were in the content but not extracted):
- ${context.missedItems || 'None specified'}

## YOUR TASK:
Search the content for the MISSED ITEMS above and extract them as key_metrics.

## OUTPUT FORMAT:
{
  "key_metrics": [
    { "value": "800", "label": "tons/month production capacity" },
    { "value": "300", "label": "employees" },
    { "value": "9", "label": "export countries" }
  ]
}

RULES:
- ONLY extract the missed items listed above
- Do NOT include items already in "ALREADY EXTRACTED"
- If you cannot find a missed item in the content, skip it
- Return empty array if nothing new found
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Company: ${context.company_name}
Business: ${context.business}

Content to search:
${scrapedContent.substring(0, 30000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    }));

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Focused extraction error:', e.message);
    return { key_metrics: [] };
  }
}

// AI Agent 3b: Extract rich content for right-side table
// Using gpt-4o-mini (cheaper) since Marker AI pre-identifies content and Validator catches misses
async function extractProductsBreakdown(scrapedContent, previousData) {
  try {
    const response = await withRetry(() => openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst creating the RIGHT-SIDE content for a company profile slide.

FIRST: Determine the BUSINESS TYPE:
1. PROJECT-BASED: Construction, building materials, engineering, architecture, contractors
   - These companies showcase PROJECTS with photos on their website
   - Look for: "Projects", "Portfolio", "Case Studies", "Our Work", project galleries

2. CONSUMER-FACING: Consumer products, retail, F&B, cosmetics, fashion
   - These companies showcase PRODUCTS with photos
   - Look for: Product catalogs, product images, consumer goods

3. INDUSTRIAL B2B: Manufacturing, chemicals, inks, coatings, industrial supplies
   - These companies have product lines for different applications/industries
   - Focus on: Product categories by APPLICATION or INDUSTRY

OUTPUT FORMAT based on business type:

FOR PROJECT-BASED (construction, building, engineering):
{
  "business_type": "project",
  "breakdown_title": "Past Projects",
  "projects": [
    {
      "name": "Metrojet Hangar at Clark Philippines",
      "image_url": "https://example.com/project1.jpg",
      "metrics": ["Area: 7,400m²", "Material: Pre-painted Steel"]
    },
    {
      "name": "Al Rayyan Stadium Qatar",
      "image_url": "https://example.com/project2.jpg",
      "metrics": ["Area: 26,400m²", "Material: Aluminium PVDF"]
    }
  ]
}

FOR CONSUMER-FACING (consumer products):
{
  "business_type": "consumer",
  "breakdown_title": "Product Range",
  "products": [
    {
      "name": "Premium Ink Series",
      "image_url": "https://example.com/product1.jpg",
      "description": "High-quality printing inks"
    }
  ]
}

FOR INDUSTRIAL B2B (manufacturing, chemicals):
{
  "business_type": "industrial",
  "breakdown_title": "Products and Applications",
  "breakdown_items": [
    {"label": "Flexographic Inks", "value": "Water-based inks for paper packaging, corrugated boxes, flexible packaging"},
    {"label": "Screen Printing", "value": "UV-curable, solvent-based inks for plastics, glass, metal substrates"},
    {"label": "Paper & Board", "value": "High-gloss, matt finish inks for magazines, brochures, folding cartons"},
    {"label": "Specialty Coatings", "value": "Overprint varnishes, UV coatings, anti-scuff lacquers"}
  ]
}

CRITICAL RULES FOR INDUSTRIAL B2B TABLE:
- Labels should be PRODUCT LINES or APPLICATION CATEGORIES (like "Flexographic Inks", "Screen Printing", "Paper & Board")
- NOT generic labels like "Products", "Applications", "Industries Served", "Services"
- Look at company's actual product naming/categorization
- 6-8 rows required (more rows = better coverage of product lines)
- VALUE DESCRIPTIONS MUST BE SPECIFIC - NOT GENERIC:
  - BAD: "Chemicals for water treatment applications" (too vague - reader knows nothing new)
  - GOOD: "Flocculants, coagulants, pH adjusters, scale inhibitors" (specific products)
  - BAD: "Inks for printing industry" (obvious and useless)
  - GOOD: "UV-curable inks for flexible packaging, metallized films" (specific applications)
- If you can't be more specific than "X for Y applications", look deeper in the website content

CRITICAL: For projects/products, extract ACTUAL image URLs from the website content!
Look for: <img src="...">, background-image: url(...), data-src="...", srcset="..."

Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: `Company: ${previousData.company_name}
Industry/Business: ${previousData.business}

Website Content:
${scrapedContent.substring(0, 35000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    }));

    const result = JSON.parse(response.choices[0].message.content);

    // Validate based on business type
    if (result.business_type === 'project' && result.projects) {
      result.projects = result.projects
        .filter(p => p && typeof p === 'object' && p.name)
        .map(p => ({
          name: String(p.name || ''),
          image_url: String(p.image_url || ''),
          metrics: Array.isArray(p.metrics) ? p.metrics.map(m => String(m)) : []
        }))
        .slice(0, 4); // Max 4 projects
    } else if (result.business_type === 'consumer' && result.products) {
      result.products = result.products
        .filter(p => p && typeof p === 'object' && p.name)
        .map(p => ({
          name: String(p.name || ''),
          image_url: String(p.image_url || ''),
          description: String(p.description || '')
        }))
        .slice(0, 4); // Max 4 products
    } else {
      // Default to industrial/table format
      result.business_type = 'industrial';
      if (result.breakdown_items && Array.isArray(result.breakdown_items)) {
        result.breakdown_items = result.breakdown_items
          .filter(item => item && typeof item === 'object')
          .map(item => ({
            label: String(item.label || ''),
            value: String(item.value || '')
          }))
          .filter(item => item.label && item.value);
      } else {
        result.breakdown_items = [];
      }
    }

    return result;
  } catch (e) {
    console.error('Agent 3b (products) error:', e.message);
    return { business_type: 'industrial', breakdown_title: 'Products and Applications', breakdown_items: [] };
  }
}

// AI Agent 3c: Extract financial metrics for 財務実績 section
// Using GPT-4o-mini with retry for rate limits
async function extractFinancialMetrics(scrapedContent, previousData) {
  try {
    const response = await withRetry(() => openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst extracting financial performance metrics from website content.

Focus on financial metrics important for M&A evaluation:

PRIORITY FINANCIAL METRICS:
1. Revenue: Annual revenue, sales figures, turnover
2. Profit: Net profit, operating profit, EBITDA
3. Growth: Revenue growth rate, YoY growth
4. Employees: Number of employees, workforce size
5. Assets: Total assets, net assets
6. Capital: Registered capital, paid-up capital

OUTPUT JSON with this structure:
{
  "financial_metrics": [
    {"label": "Revenue", "value": "USD 50M (2023)"},
    {"label": "Net Profit", "value": "USD 5M"},
    {"label": "Growth Rate", "value": "15% YoY"},
    {"label": "Employees", "value": "500+"}
  ]
}

IMPORTANT RULES:
- Only extract financial data that is EXPLICITLY mentioned on the website
- Include currency and year if available
- If no financial data found, return empty array
- Maximum 4 financial metrics
- Do NOT make up financial figures

Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: `Company: ${previousData.company_name}
Industry/Business: ${previousData.business}

Website Content (extract financial metrics):
${scrapedContent.substring(0, 15000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    }));

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 3b error:', e.message);
    return { financial_metrics: [] };
  }
}

// AI Agent 4: Search for missing company information (est year, location, HQ)
// Wrapped with retry for reliability
async function searchMissingInfo(companyName, website, missingFields) {
  if (!companyName || missingFields.length === 0) {
    return {};
  }

  try {
    console.log(`  Searching for missing info: ${missingFields.join(', ')}`);

    // Use OpenAI Search model which has web search capability
    // Wrapped with retry for rate limits
    const response = await withRetry(() => openai.chat.completions.create({
      model: 'gpt-4o-search-preview',
      messages: [
        {
          role: 'user',
          content: `Search for information about "${companyName}" (website: ${website}).

I need to find:
${missingFields.includes('established_year') ? '- When was this company founded/established? (year only)' : ''}
${missingFields.includes('location') ? '- Where is this company headquartered? (city, country)' : ''}

Return ONLY a JSON object with these fields (include only fields you can find with confidence):
{
  ${missingFields.includes('established_year') ? '"established_year": "YYYY",' : ''}
  ${missingFields.includes('location') ? '"location": "City, Country"' : ''}
}

If you cannot find reliable information for a field, omit it from the response.
Return ONLY valid JSON, no explanations.`
        }
      ]
    }));

    const content = response.choices[0].message.content || '';

    // Try to parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      console.log(`  Found missing info:`, result);
      return result;
    }

    return {};
  } catch (e) {
    console.error('Agent 4 (search) error:', e.message);

    // Fallback to Perplexity if OpenAI search fails
    try {
      const perplexityPrompt = `What is the founding year and headquarters location of ${companyName} (${website})? Reply ONLY with JSON: {"established_year": "YYYY", "location": "City, Country"}`;
      const perplexityResponse = await callPerplexity(perplexityPrompt);

      const jsonMatch = perplexityResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        console.log(`  Found via Perplexity:`, result);
        return result;
      }
    } catch (pe) {
      console.error('Perplexity fallback error:', pe.message);
    }

    return {};
  }
}

// AI Agent 5: Search web for additional company metrics
async function searchAdditionalMetrics(companyName, website, existingMetrics) {
  if (!companyName) {
    return { additional_metrics: [] };
  }

  try {
    console.log(`  Step 6: Searching web for additional metrics...`);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-search-preview',
      messages: [
        {
          role: 'user',
          content: `Search for detailed business information about "${companyName}" (website: ${website}).

I need M&A-relevant metrics for an acquisition discussion. Find:

1. COMPANY SCALE:
   - Number of employees/headcount
   - Revenue figures (annual revenue)
   - Number of retail stores, offices, branches
   - Market capitalization (if public)

2. OPERATIONS:
   - Number of products/SKUs
   - Production capacity
   - Factory/warehouse locations and sizes
   - Number of suppliers

3. CUSTOMERS & MARKET:
   - Number of customers
   - Key customer names or segments
   - Market share
   - Geographic markets served

4. CERTIFICATIONS & QUALITY:
   - ISO certifications
   - Industry-specific certifications
   - Awards

5. PARTNERSHIPS:
   - Key partnerships
   - Joint ventures
   - Major suppliers

Already have: ${existingMetrics.map(m => m.label).join(', ')}

Return ONLY a JSON object:
{
  "additional_metrics": [
    {"label": "Employees", "value": "164,000+ worldwide"},
    {"label": "Retail Stores", "value": "500+ stores globally"},
    {"label": "Revenue", "value": "USD 383B (2023)"}
  ]
}

Only include metrics you can verify. Do not repeat metrics already provided.
Return ONLY valid JSON.`
        }
      ]
    });

    const content = response.choices[0].message.content || '';

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      console.log(`  Found ${result.additional_metrics?.length || 0} additional metrics via web search`);
      return result;
    }

    return { additional_metrics: [] };
  } catch (e) {
    console.error('Agent 5 (additional metrics search) error:', e.message);
    return { additional_metrics: [] };
  }
}

// AI Agent 6: Generate MECE segments for target list slide
async function generateMECESegments(targetDescription, companies) {
  if (!targetDescription || companies.length === 0) {
    return { segments: [], companySegments: {} };
  }

  try {
    console.log('Generating MECE segments for target list...');

    // Prepare company summaries for AI - include breakdown_items for better categorization
    const companySummaries = companies.map((c, i) => {
      // Extract product/service names from breakdown_items if available
      let products = '';
      if (c.breakdown_items && Array.isArray(c.breakdown_items)) {
        products = c.breakdown_items.map(item => item.label || item.name || '').filter(Boolean).join(', ');
      }
      return {
        id: i + 1,
        name: c.title || c.company_name || 'Unknown',
        business: c.business || '',
        products: products,
        location: c.location || ''
      };
    });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst creating a target list slide. Given a target description and company information, create segments to categorize these companies.

CRITICAL - HOW TO CREATE GOOD SEGMENTS:
1. ANALYZE what products/services the companies ACTUALLY offer (look at their business descriptions)
2. CREATE segments that MATCH how companies describe themselves, not theoretical categories
3. EVERY company MUST have at least ONE tick - if a company has no ticks, your segmentation is WRONG

EXAMPLE - INK INDUSTRY:
- If companies describe products as: "oil-based inks, water-based inks, UV inks, solvent-based inks"
  → Create segments: "Oil-based Inks", "Water-based Inks", "UV Inks", "Solvent-based Inks"
- If companies describe by printing method: "gravure inks, flexo inks, offset inks"
  → Create segments: "Gravure Inks", "Flexo Inks", "Offset Inks"
- PREFER the categorization that companies use, not textbook categories

MAPPING RULES - Map related terms:
- "Oil-based inks" → likely serves Offset printing
- "Solvent-based inks" → likely serves Gravure, Flexo
- "Water-based inks" → likely serves Flexo, packaging
- If a company makes "oil-based, solvent-based, water-based inks" → they likely serve multiple printing methods

CRITICAL:
- ALL segments must be PARALLEL (same category type)
- EVERY company MUST have at least one segment ticked
- If a company has no ticks, either the segmentation is wrong OR the company doesn't belong in this list

OUTPUT JSON:
{
  "segments": ["Segment 1", "Segment 2", "Segment 3", "Segment 4"],
  "companySegments": {
    "1": [true, false, true, false],
    "2": [false, true, true, true]
  }
}

Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: `Target Description: ${targetDescription}

Companies:
${companySummaries.map(c => `${c.id}. ${c.name}\n   Business: ${c.business}${c.products ? `\n   Products: ${c.products}` : ''}\n   Location: ${c.location}`).join('\n\n')}

Create segments for these ${targetDescription} companies. Ensure EVERY company has at least one tick.`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    const result = JSON.parse(response.choices[0].message.content);
    console.log(`Generated ${result.segments?.length || 0} MECE segments`);

    // Filter out segments that have NO ticks from any company (useless columns)
    if (result.segments && result.companySegments) {
      const segmentsWithTicks = [];
      const indicesToKeep = [];

      result.segments.forEach((seg, segIdx) => {
        // Check if ANY company has a tick for this segment
        const hasTick = Object.values(result.companySegments).some(
          ticks => Array.isArray(ticks) && ticks[segIdx] === true
        );
        if (hasTick) {
          segmentsWithTicks.push(seg);
          indicesToKeep.push(segIdx);
        } else {
          console.log(`  Removing empty segment column: "${seg}" (no companies ticked)`);
        }
      });

      // Update segments and companySegments to only keep columns with ticks
      if (indicesToKeep.length < result.segments.length) {
        result.segments = segmentsWithTicks;
        for (const companyId of Object.keys(result.companySegments)) {
          const oldTicks = result.companySegments[companyId];
          result.companySegments[companyId] = indicesToKeep.map(idx => oldTicks[idx] || false);
        }
        console.log(`  Filtered to ${result.segments.length} segments with ticks`);
      }

      // WARNING: Check for companies with NO ticks at all
      for (const companyId of Object.keys(result.companySegments)) {
        const ticks = result.companySegments[companyId];
        const hasTick = Array.isArray(ticks) && ticks.some(t => t === true);
        if (!hasTick) {
          const company = companySummaries.find(c => c.id === parseInt(companyId));
          console.warn(`  WARNING: Company "${company?.name || companyId}" has NO segment ticks - check segmentation!`);
        }
      }
    }

    return result;
  } catch (e) {
    console.error('MECE segmentation error:', e.message);
    return { segments: [], companySegments: {} };
  }
}

// AI Agent 7: Generate Hypothetical M&A Strategies by region
// Creates regional M&A strategy recommendations based on target description and company profiles
async function generateMAStrategies(targetDescription, companies) {
  if (!targetDescription || companies.length === 0) {
    return { strategies: [] };
  }

  try {
    console.log('Generating M&A strategies for regions...');

    // Group companies by region
    const regionMap = {};
    companies.forEach(c => {
      const location = ensureString(c.location).toLowerCase();
      let region = 'Other';

      // Southeast Asia
      if (location.includes('singapore') || location.includes('malaysia') ||
          location.includes('thailand') || location.includes('vietnam') ||
          location.includes('indonesia') || location.includes('philippines')) {
        region = 'Southeast Asia';
      }
      // Greater China
      else if (location.includes('china') || location.includes('hong kong') ||
               location.includes('taiwan')) {
        region = 'Greater China';
      }
      // Northeast Asia (Japan, Korea)
      else if (location.includes('japan') || location.includes('korea')) {
        region = 'Northeast Asia';
      }
      // South Asia
      else if (location.includes('india') || location.includes('bangladesh') ||
               location.includes('pakistan') || location.includes('sri lanka')) {
        region = 'South Asia';
      }

      if (!regionMap[region]) regionMap[region] = [];
      regionMap[region].push(c);
    });

    // Prepare region summaries
    const regionSummaries = Object.entries(regionMap).map(([region, comps]) => ({
      region,
      companies: comps.map(c => ({
        name: c.title || c.company_name || 'Unknown',
        business: c.business || ''
      }))
    }));

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an M&A strategist creating hypothetical regional expansion strategies.

Given a target industry and companies grouped by region, create M&A strategy recommendations.

CRITICAL RULES:
1. Do NOT mention specific company names in strategies
2. Use generic terms like "target companies", "regional players", "local distributors", etc.
3. Focus on strategic rationale, not specific targets
4. Strategies should be actionable and region-specific

OUTPUT JSON:
{
  "strategies": [
    {
      "region": "Southeast Asia",
      "strategy": "Acquire a regional distributor to establish footprint and leverage local distribution networks",
      "rationale": "Access to high-growth ASEAN markets with favorable demographics and cost-effective manufacturing base"
    },
    {
      "region": "Greater China",
      "strategy": "Target local manufacturers for technology and scale expansion",
      "rationale": "Access to advanced manufacturing capabilities and strategic positioning in key supply chain hub"
    }
  ]
}

IMPORTANT:
- Keep strategies generic (no company names)
- Each strategy should be 1-2 sentences
- Each rationale should explain the business value
- Only include regions that have companies in the input

Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: `Target Industry: ${targetDescription}

Regions and Companies:
${regionSummaries.map(r => `${r.region}:\n${r.companies.map(c => `  - ${c.name}: ${c.business}`).join('\n')}`).join('\n\n')}

Generate M&A strategies for each region WITHOUT mentioning specific company names.`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.4
    });

    const result = JSON.parse(response.choices[0].message.content);
    console.log(`Generated ${result.strategies?.length || 0} regional M&A strategies`);
    return result;
  } catch (e) {
    console.error('M&A strategy generation error:', e.message);
    return { strategies: [] };
  }
}

// AI Review Agent: Validate extraction against source content and fix issues
// Uses GPT-4o for accurate validation - compares extracted data against source
// Returns { data, issuesFound, missedItems } for iterative extraction
async function reviewAndCleanData(companyData, scrapedContent, markers = null) {
  try {
    console.log('  Step 6: Running AI validator (GPT-4o) - comparing extraction vs source...');

    // Use markers if available (structured snippets), otherwise use raw content
    let sourceSection;
    if (markers) {
      sourceSection = `## MARKED IMPORTANT CONTENT (pre-identified by Marker AI):

=== STATISTICS (look for these numbers!) ===
${(markers.statistics_snippets || []).join('\n')}

=== LOCATION HINTS ===
${(markers.location_hints || []).join('\n')}

=== BUSINESS RELATIONSHIPS ===
${(markers.relationships_snippets || []).join('\n')}

=== IDENTITY ===
${(markers.identity_snippets || []).join('\n')}`;
    } else {
      // Truncate to 15000 chars to avoid token limit (128K tokens ≈ 100K chars)
      sourceSection = `## SOURCE WEBSITE CONTENT (this is the truth):
${scrapedContent ? scrapedContent.substring(0, 15000) : 'No source content available'}`;
    }

    const prompt = `You are a data VALIDATION and CLEANUP agent. Your job is to VERIFY extracted data against SOURCE CONTENT and REMOVE anything that cannot be verified.

CRITICAL RULE: You can ONLY REMOVE or FIX data. You CANNOT ADD new data.
- If something is not in the extracted data, DO NOT add it
- If something in extracted data cannot be verified in source, REMOVE IT
- The extraction step already happened - your job is just to clean up mistakes

${sourceSection}

## EXTRACTED DATA (verify each item against source):
${JSON.stringify({
      ...companyData,
      // Truncate large arrays to avoid token overflow
      breakdown_items: (companyData.breakdown_items || []).slice(0, 10),
      key_metrics: (companyData.key_metrics || []).slice(0, 15),
      // Remove internal fields not needed for validation
      _businessRelationships: undefined,
      _productProjectImages: undefined,
      rawContent: undefined
    }, null, 2)}

## YOUR TASKS:

### 1. VALIDATE HQ/LOCATION
- Search SOURCE for actual address/location
- If extracted location cannot be verified in source, keep it but note the uncertainty
- FORMAT: "Province/State, Country" (e.g., "Bangkok, Thailand", "Selangor, Malaysia")
- Singapore: Must have real area name - "Jurong", "Tuas", "Woodlands", "Changi", etc.
  - INVALID areas to REMOVE: "Central" (not a real place), "Singapore" alone
  - If postal code visible: 60xxxx=Jurong, 62xxxx=Tuas, 7xxxxx=Woodlands
  - If cannot find real area in source, leave location empty rather than guess
- TRANSLATE to English if in Thai/Chinese/etc.

### 2. VERIFY KEY METRICS (REMOVE WHAT CAN'T BE VERIFIED)
For EACH metric in key_metrics:
- Search SOURCE for evidence of this data
- If you CANNOT find the number/claim in the source content, REMOVE the metric
- Example: If key_metrics says "300 employees" but source has no mention of 300 or employees, REMOVE IT
- If metric has placeholder pattern (brand1, Customer A, etc.), REMOVE IT
- If metric has "0" value (e.g., "0 Customers", "0 Projects"), REMOVE IT
- If metric says "Not specified", "N/A", "Unknown", REMOVE IT

### 3. CLEANUP (REMOVE GARBAGE)
REMOVE any metric containing:
- Placeholder patterns: "brand1, brand2", "Customer A, Customer B", "Supplier 1, Supplier 2"
- Zero values: "0 Something", starting with "0 "
- Empty values: "Not specified", "N/A", "Unknown", "Not available", "Various"
- Vague descriptions: "Quality Standards", "Innovation Focus", "Service Excellence"
- Marketing fluff without data: "High quality products", "Industry leading"

### 4. TRANSLATE TO ENGLISH
- All output must be English (A-Z only)
- Translate Thai/Chinese/Vietnamese text to English
- Units: "ไร่" → "rai", "ตร.ม." → "sqm", "ตัน/เดือน" → "tons/month"
- NEVER leave non-English characters in output

### 5. UNCOMMON ABBREVIATIONS
- For technical abbreviations NOT common knowledge, include full form inline
- Example: "PU (Polyurethane)", "EVA (Ethylene Vinyl Acetate)", "ABS (Acrylonitrile Butadiene Styrene)"
- Common abbreviations DON'T need explanation: ISO, FDA, GMP, B2B, B2C, HQ, USD, sqm, kg

### 6. CHECK FOR REDUNDANCY
- If "Factory Established" has same year as "Est. Year", REMOVE "Factory Established" metric
- Merge duplicate information

## OUTPUT FORMAT
{
  "company_name": "...",
  "established_year": "...",
  "location": "VERIFIED location or empty if unverifiable",
  "business": "...",
  "message": "...",
  "title": "...",
  "key_metrics": [ONLY metrics that can be VERIFIED in source - remove unverifiable ones],
  "breakdown_title": "...",
  "breakdown_items": [...],
  "validation_notes": ["Removed unverifiable metric X", "Fixed location from A to B"],
  "issues_found": true/false,
  "removed_metrics": ["List of metrics that were removed because they couldn't be verified"]
}

REMEMBER: You can only REMOVE or FIX. Never ADD new data. If in doubt, REMOVE.

Return ONLY valid JSON.`;

    // Wrap OpenAI call with retry for rate limits
    const response = await withRetry(() => openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a data validation agent. Compare extracted data against source content and fix any discrepancies. Add any missing information found in the source.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    }));

    const result = response.choices[0].message.content;

    if (!result) {
      console.log('  AI validator returned empty, keeping original data');
      return { data: companyData, issuesFound: false, missedItems: [] };
    }

    // Parse JSON from response
    let validated;
    try {
      validated = JSON.parse(result);
    } catch (parseError) {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        validated = JSON.parse(jsonMatch[0]);
      } else {
        console.log('  Failed to parse validator response, keeping original data');
        return { data: companyData, issuesFound: false, missedItems: [] };
      }
    }

    // Log what was fixed/added
    if (validated.validation_notes && validated.validation_notes.length > 0) {
      validated.validation_notes.forEach(note => {
        console.log(`    [Validator] ${note}`);
      });
    }

    // Merge validated data with original (preserve fields not in output)
    // Apply cleanCompanyName to ensure English names without suffixes or descriptions
    const rawCompanyName = validated.company_name || companyData.company_name;
    const rawTitle = validated.title || companyData.title;
    const websiteUrl = companyData.website || '';
    const cleanedCompanyName = cleanCompanyName(rawCompanyName, websiteUrl);
    const cleanedTitle = cleanCompanyName(rawTitle, websiteUrl);

    // SAFETY: Reject validator location if it contains non-ASCII (Thai/Chinese/Vietnamese)
    // Keep original location instead
    let finalLocation = validated.location || companyData.location;
    if (finalLocation && /[^\x00-\x7F]/.test(finalLocation)) {
      console.log(`    [Validator] REJECTED non-English location: "${finalLocation}" - keeping original`);
      finalLocation = companyData.location; // Keep original English location
    }

    const mergedData = {
      ...companyData,
      company_name: cleanedCompanyName,
      established_year: validated.established_year || companyData.established_year,
      location: finalLocation,
      business: validated.business || companyData.business,
      message: validated.message || companyData.message,
      title: cleanedTitle || cleanedCompanyName,
      key_metrics: validated.key_metrics || companyData.key_metrics,
      breakdown_title: validated.breakdown_title || companyData.breakdown_title,
      breakdown_items: validated.breakdown_items || companyData.breakdown_items
    };

    return {
      data: mergedData,
      issuesFound: validated.issues_found || false,
      missedItems: validated.missed_items || []
    };
  } catch (e) {
    console.error('Validator error:', e.message);
    return { data: companyData, issuesFound: false, missedItems: [] }; // Return original data if validation fails
  }
}

// Build profile slides email HTML (simple version with PPTX attached)
function buildProfileSlidesEmailHTML(companies, errors, hasPPTX) {
  const companyNames = companies.map(c => c.title || c.company_name).join(', ');

  let html = `
    <h2>Profile Slides</h2>
    <p>Your profile slides have been generated.</p>
    <br>
    <p><strong>Companies Extracted:</strong> ${companies.length}</p>
    <p><strong>Companies:</strong> ${companyNames || 'N/A'}</p>
  `;

  if (hasPPTX) {
    html += `<br><p style="color: #16a34a;"><strong>✓ PowerPoint file attached.</strong></p>`;
  } else {
    html += `<br><p style="color: #dc2626;"><strong>⚠ PPTX generation failed. Data included below.</strong></p>`;

    // Include extracted data as fallback
    companies.forEach((c, i) => {
      html += `
        <div style="margin: 16px 0; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h4 style="margin: 0 0 8px 0;">${i + 1}. ${ensureString(c.title || c.company_name) || 'Unknown'}</h4>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Website:</strong> ${ensureString(c.website)}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Established:</strong> ${ensureString(c.established_year) || '-'}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Location:</strong> ${ensureString(c.location) || '-'}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Business:</strong> ${ensureString(c.business) || '-'}</p>
        </div>
      `;
    });
  }

  // Errors section
  if (errors.length > 0) {
    html += `<br><h3 style="color: #dc2626;">Failed Extractions</h3>`;
    html += `<ul>`;
    errors.forEach(e => {
      html += `<li><strong>${e.website}</strong>: ${e.error}</li>`;
    });
    html += `</ul>`;
  }

  return html;
}

// Helper function to process a single website (used for parallel processing)
async function processSingleWebsite(website, index, total) {
  const trimmedWebsite = website.trim();
  if (!trimmedWebsite) return null;

  console.log(`\n[${index + 1}/${total}] Processing: ${trimmedWebsite}`);
  logMemoryUsage(`start company ${index + 1}`);

  try {
    // Step 1: Scrape website (now scrapes multiple pages: homepage + contact + about + partners)
    console.log(`  [${index + 1}] Step 1: Scraping website (multi-page)...`);
    const scraped = await scrapeMultiplePages(trimmedWebsite);

    if (!scraped.success) {
      console.log(`  [${index + 1}] Failed to scrape: ${scraped.error}`);
      // Mark as inaccessible - will appear on summary slide but not individual profile
      const companyName = extractCompanyNameFromUrl(trimmedWebsite);
      return {
        website: trimmedWebsite,
        company_name: companyName,
        title: companyName,
        location: '',
        _inaccessible: true,
        _error: `Failed to scrape: ${scraped.error}`
      };
    }
    const pagesScrapedCount = scraped.pagesScraped?.length || 1;
    console.log(`  [${index + 1}] Scraped ${scraped.content.length} characters from ${pagesScrapedCount} pages`);
    if (scraped.pagesScraped) {
      console.log(`  [${index + 1}] Pages scraped: ${scraped.pagesScraped.join(', ')}`);
    }
    // Log content preview for debugging (first 500 chars, useful for seeing what was scraped)
    console.log(`  [${index + 1}] Content preview: ${scraped.content.substring(0, 500).replace(/\n/g, ' ').replace(/\s+/g, ' ')}...`);

    // Step 1a: Pre-extract metrics using deterministic regex (no AI hallucination)
    console.log(`  [${index + 1}] Step 1a: Pre-extracting metrics with regex...`);
    const regexMetrics = extractMetricsFromText(scraped.content);
    if (Object.keys(regexMetrics).length > 0) {
      console.log(`  [${index + 1}] Regex found: ${Object.keys(regexMetrics).filter(k => !k.endsWith('_text')).join(', ')}`);
    }

    // Step 1b: Extract structured address from JSON-LD (if available)
    const structuredAddress = extractStructuredAddress(scraped.rawHtml);
    if (structuredAddress) {
      console.log(`  [${index + 1}] Found JSON-LD address: ${structuredAddress.formatted}`);
    }

    // Step 1c: Extract logo using cascade (Clearbit → og:image → apple-touch-icon → img[logo] → favicon)
    console.log(`  [${index + 1}] Step 1c: Extracting company logo...`);
    const logoResult = await extractLogoFromWebsite(trimmedWebsite, scraped.rawHtml);
    if (logoResult) {
      console.log(`  [${index + 1}] Logo found via ${logoResult.source}`);
    }

    // Step 1d: Extract customer/partner names from image alt texts
    const customerNamesFromImages = extractCustomerNamesFromImages(scraped.rawHtml);
    if (customerNamesFromImages.length > 0) {
      console.log(`  [${index + 1}] Customer names from images: ${customerNamesFromImages.slice(0, 5).join(', ')}${customerNamesFromImages.length > 5 ? '...' : ''}`);
    }

    // Step 2: Run Marker AI to identify important content (avoids truncation blind spots)
    console.log(`  [${index + 1}] Step 2: Running Marker AI to identify key content...`);
    const markerResult = await markImportantContent(scraped.content, trimmedWebsite);

    // Use marked content if available, otherwise fall back to raw content
    // Marked content is pre-curated snippets (smaller, focused), raw content is full text (needs truncation)
    const contentForExtraction = markerResult?.markedContent || scraped.content;
    const usingMarkedContent = !!markerResult?.markedContent;
    if (usingMarkedContent) {
      console.log(`  [${index + 1}] Using marked content (${markerResult.markedLength} chars from ${markerResult.originalLength})`);
    } else {
      console.log(`  [${index + 1}] Marker failed, using truncated raw content`);
    }

    // Step 3: Extract basic info (company name, year, location)
    // CRITICAL: Use RAW content for location extraction - this is the most important field
    // Marker might miss the actual address, so give extractBasicInfo the full picture
    console.log(`  [${index + 1}] Step 3: Extracting company name, year, location...`);
    const basicInfo = await extractBasicInfo(scraped.content, trimmedWebsite);
    console.log(`  [${index + 1}] Company: ${basicInfo.company_name || 'Not found'}`);
    if (basicInfo.location) console.log(`  [${index + 1}] Location extracted: ${basicInfo.location}`);

    // Step 4: Extract business details
    console.log(`  [${index + 1}] Step 4: Extracting business, message, footnote, title...`);
    const businessInfo = await extractBusinessInfo(contentForExtraction, basicInfo);

    // Step 5: Extract key metrics
    console.log(`  [${index + 1}] Step 5: Extracting key metrics...`);
    const metricsInfo = await extractKeyMetrics(contentForExtraction, {
      company_name: basicInfo.company_name,
      business: businessInfo.business
    });

    // Step 5b: Extract products/applications breakdown for right table
    console.log(`  [${index + 1}] Step 5b: Extracting products/applications breakdown...`);
    const productsBreakdown = await extractProductsBreakdown(contentForExtraction, {
      company_name: basicInfo.company_name,
      business: businessInfo.business
    });

    // Step 6: Search online for missing mandatory info (established_year, location)
    // These are mandatory fields - search online if not found on website
    const missingFields = [];
    if (!basicInfo.established_year) missingFields.push('established_year');
    if (!basicInfo.location) missingFields.push('location');

    let searchedInfo = {};
    if (missingFields.length > 0 && basicInfo.company_name) {
      console.log(`  [${index + 1}] Step 6: Searching online for missing mandatory info: ${missingFields.join(', ')}...`);
      searchedInfo = await searchMissingInfo(basicInfo.company_name, trimmedWebsite, missingFields);
    }

    // Use only key metrics from scraped website (no web search for metrics to prevent hallucination)
    const rawKeyMetrics = metricsInfo.key_metrics || [];

    // ===== QUOTE VERIFICATION =====
    // Filter AI-extracted metrics by verifying source quotes exist in scraped content
    // This prevents hallucination by requiring proof for every claim
    console.log(`  [${index + 1}] Step 5c: Verifying ${rawKeyMetrics.length} AI-extracted metrics against source content...`);
    const allKeyMetrics = filterMetricsByVerification(rawKeyMetrics, scraped.content, index + 1);

    // ===== PRIORITIZE REGEX OVER AI =====
    // Regex metrics are ground truth (deterministic, no hallucination)
    // ALWAYS include regex metrics first, then add AI metrics only for uncovered types
    const regexBasedMetrics = [];
    const regexCoveredTypes = new Set();

    // Build regex metrics first (these are guaranteed accurate)
    if (regexMetrics.office_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.office_count), label: normalizeLabel(regexMetrics.office_text || 'Offices') });
      regexCoveredTypes.add('office');
    }
    if (regexMetrics.employee_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.employee_count), label: 'Employees' });
      regexCoveredTypes.add('employee');
    }
    if (regexMetrics.years_experience) {
      regexBasedMetrics.push({ value: String(regexMetrics.years_experience), label: 'Years Experience' });
      regexCoveredTypes.add('year');
    }
    if (regexMetrics.export_countries) {
      regexBasedMetrics.push({ value: String(regexMetrics.export_countries), label: 'Export Countries' });
      regexCoveredTypes.add('export');
    }
    if (regexMetrics.source_countries) {
      regexBasedMetrics.push({ value: String(regexMetrics.source_countries), label: 'Source Countries' });
      regexCoveredTypes.add('source');
    }
    if (regexMetrics.capacity_text) {
      regexBasedMetrics.push({ value: translateUnitsToEnglish(regexMetrics.capacity_text), label: 'Production Capacity' });
      regexCoveredTypes.add('capacity');
    }
    if (regexMetrics.certifications?.length > 0) {
      regexBasedMetrics.push({ value: regexMetrics.certifications.join(', '), label: 'Certifications' });
      regexCoveredTypes.add('certif');
    }
    if (regexMetrics.machine_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.machine_count) + '+', label: 'Machines' });
      regexCoveredTypes.add('machine');
    }
    if (regexMetrics.partner_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.partner_count) + '+', label: 'Business Partners' });
      regexCoveredTypes.add('partner');
    }
    if (regexMetrics.export_regions) {
      regexBasedMetrics.push({ value: regexMetrics.export_regions, label: 'Export Markets' });
      regexCoveredTypes.add('market');
    }
    if (regexMetrics.product_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.product_count) + '+', label: 'Products' });
      regexCoveredTypes.add('product');
    }
    if (regexMetrics.customer_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.customer_count) + '+', label: 'Customers' });
      regexCoveredTypes.add('customer');
    }
    if (regexMetrics.fleet_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.fleet_count) + '+', label: 'Vehicles' });
      regexCoveredTypes.add('vehicle');
    }
    if (regexMetrics.outlet_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.outlet_count) + '+', label: 'Outlets' });
      regexCoveredTypes.add('outlet');
    }
    if (regexMetrics.brand_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.brand_count) + '+', label: 'Brands Carried' });
      regexCoveredTypes.add('brand');
    }
    if (regexMetrics.output_text) {
      regexBasedMetrics.push({ value: translateUnitsToEnglish(regexMetrics.output_text), label: 'Output' });
      regexCoveredTypes.add('output');
    }
    if (regexMetrics.warehouse_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.warehouse_count) + '+', label: 'Warehouses' });
      regexCoveredTypes.add('warehouse');
    }
    if (regexMetrics.country_presence) {
      regexBasedMetrics.push({ value: String(regexMetrics.country_presence) + '+', label: 'Countries' });
      regexCoveredTypes.add('countr');
    }
    if (regexMetrics.project_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.project_count) + '+', label: 'Projects Completed' });
      regexCoveredTypes.add('project');
    }
    if (regexMetrics.factory_size) {
      regexBasedMetrics.push({ value: translateUnitsToEnglish(regexMetrics.factory_size), label: 'Factory Size' });
      regexCoveredTypes.add('factory');
    }
    if (regexMetrics.award_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.award_count) + '+', label: 'Awards' });
      regexCoveredTypes.add('award');
    }
    if (regexMetrics.patent_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.patent_count) + '+', label: 'Patents' });
      regexCoveredTypes.add('patent');
    }
    if (regexMetrics.room_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.room_count) + '+', label: 'Rooms' });
      regexCoveredTypes.add('room');
    }
    if (regexMetrics.bed_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.bed_count) + '+', label: 'Beds' });
      regexCoveredTypes.add('bed');
    }
    if (regexMetrics.doctor_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.doctor_count) + '+', label: 'Doctors' });
      regexCoveredTypes.add('doctor');
    }
    if (regexMetrics.student_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.student_count) + '+', label: 'Students' });
      regexCoveredTypes.add('student');
    }
    if (regexMetrics.course_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.course_count) + '+', label: 'Courses' });
      regexCoveredTypes.add('course');
    }
    if (regexMetrics.unit_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.unit_count) + '+', label: 'Units' });
      regexCoveredTypes.add('unit');
    }
    if (regexMetrics.acreage) {
      regexBasedMetrics.push({ value: translateUnitsToEnglish(regexMetrics.acreage_text), label: 'Land Area' });
      regexCoveredTypes.add('acre');
    }
    if (regexMetrics.user_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.user_count) + '+', label: 'Users' });
      regexCoveredTypes.add('user');
    }
    if (regexMetrics.download_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.download_count) + '+', label: 'Downloads' });
      regexCoveredTypes.add('download');
    }
    if (regexMetrics.menu_count) {
      regexBasedMetrics.push({ value: String(regexMetrics.menu_count) + '+', label: 'Menu Items' });
      regexCoveredTypes.add('menu');
    }

    // Now add AI metrics ONLY for types not covered by regex
    // This prevents AI hallucination from overriding deterministic regex results
    const mergedMetrics = [...regexBasedMetrics];
    for (const aiMetric of allKeyMetrics) {
      const labelLower = aiMetric.label.toLowerCase();
      // Check if regex already covered this type
      const alreadyCovered = [...regexCoveredTypes].some(type => labelLower.includes(type));
      if (!alreadyCovered) {
        mergedMetrics.push(aiMetric);
      }
    }

    console.log(`  [${index + 1}] Merged metrics: ${regexBasedMetrics.length} from regex + ${mergedMetrics.length - regexBasedMetrics.length} from AI = ${mergedMetrics.length} total`);

    // Determine location: prefer AI extraction, fallback to JSON-LD structured address
    let finalLocation = ensureString(basicInfo.location || searchedInfo.location);
    if (!finalLocation && structuredAddress?.formatted) {
      finalLocation = structuredAddress.formatted;
      console.log(`  [${index + 1}] Using JSON-LD address as fallback: ${finalLocation}`);
    }

    // Validate and fix HQ format
    let validatedLocation = validateAndFixHQFormat(finalLocation, trimmedWebsite);

    // FIX #1: If location is incomplete (< 2 levels), retry with focused extraction
    if (validatedLocation) {
      const locParts = validatedLocation.split(',').map(p => p.trim()).filter(p => p);
      const requiredLevels = 2; // 2 levels for all countries (state/province, country)
      if (locParts.length < requiredLevels) {
        console.log(`  [${index + 1}] Step 6b: HQ incomplete (${locParts.length}/${requiredLevels} levels), retrying...`);
        const improvedLocation = await extractFullAddress(scraped.content, trimmedWebsite, validatedLocation);
        if (improvedLocation && improvedLocation !== validatedLocation) {
          validatedLocation = validateAndFixHQFormat(improvedLocation, trimmedWebsite);
        }
      }
    }

    // Determine business type: keyword detection can override AI's classification
    let businessType = productsBreakdown.business_type || 'industrial';
    const detectedType = detectBusinessType(businessInfo.business, scraped.content);
    // Only use keyword detection as fallback when AI didn't provide classification
    if (!productsBreakdown.business_type && detectedType) {
      console.log(`  [${index + 1}] Business type: "${detectedType}" (keyword fallback, AI had no classification)`);
      businessType = detectedType;
    }

    // FIX #3: Extract product/project images for ALL business types
    // Images are only displayed if user selects an image layout option
    let productProjectImages = [];
    console.log(`  [${index + 1}] Step 6c: Extracting product/project images...`);
    productProjectImages = extractProductProjectImages(scraped.rawHtml, businessType, trimmedWebsite);
    if (productProjectImages.length > 0) {
      console.log(`  [${index + 1}] Found ${productProjectImages.length} images for right side`);
    }

    // FIX #5: Extract categorized business relationships (customers, suppliers, principals, brands)
    console.log(`  [${index + 1}] Step 6d: Extracting business relationships (metadata)...`);
    const businessRelationships = extractBusinessRelationships(scraped.rawHtml);

    // Step 6e: Use GPT-4o Vision to read logo images (more accurate than metadata)
    console.log(`  [${index + 1}] Step 6e: Reading logos with GPT-4o Vision...`);
    const visionResults = await extractNamesFromLogosWithVision(scraped.rawHtml, trimmedWebsite);

    // Step 6f: Screenshot fallback - if vision/metadata extraction found few partners, use full-page screenshot
    let screenshotResults = { customers: [], brands: [], principals: [] };
    const totalFromVision = visionResults.customers.length + visionResults.brands.length;
    const totalFromMeta = businessRelationships.customers.length + businessRelationships.principals.length + businessRelationships.brands.length;

    if (totalFromVision + totalFromMeta < 3 && process.env.SCREENSHOT_API_KEY) {
      console.log(`  [${index + 1}] Step 6f: Few partners found (${totalFromVision + totalFromMeta}), trying screenshot analysis...`);
      screenshotResults = await extractPartnersFromScreenshot(trimmedWebsite);
    }

    // Merge results with CONFIDENCE-BASED prioritization
    // HIGH confidence: Vision API, Screenshot analysis (AI actually sees images)
    // LOW confidence: Alt text extraction, metadata regex (prone to garbage)
    // Strategy: Only use low-confidence sources if high-confidence found < 3 items

    const highConfidenceCustomers = [...new Set([
      ...visionResults.customers,
      ...screenshotResults.customers
    ])];

    const lowConfidenceCustomers = [...new Set([
      ...customerNamesFromImages,
      ...businessRelationships.customers
    ])];

    // Only add low-confidence customers if we don't have enough from high-confidence
    const allCustomers = highConfidenceCustomers.length >= 3
      ? highConfidenceCustomers
      : [...new Set([...highConfidenceCustomers, ...lowConfidenceCustomers])];

    const allBrands = [...new Set([
      ...visionResults.brands,
      ...screenshotResults.brands,
      ...businessRelationships.brands
    ])];
    const allPrincipals = [...new Set([
      ...screenshotResults.principals,
      ...businessRelationships.principals
    ])];

    businessRelationships.customers = allCustomers;
    businessRelationships.brands = allBrands;
    businessRelationships.principals = allPrincipals;

    const relationshipCounts = Object.entries(businessRelationships)
      .filter(([, arr]) => arr.length > 0)
      .map(([key, arr]) => `${key}: ${arr.length}`)
      .join(', ');
    if (relationshipCounts) {
      console.log(`  [${index + 1}] Total relationships: ${relationshipCounts}`);
    }

    // Combine all extracted data (mandatory fields supplemented by web search)
    // Use ensureString() for all AI-generated fields to prevent [object Object] issues
    let companyData = {
      website: scraped.url,
      company_name: ensureString(basicInfo.company_name),
      established_year: ensureString(basicInfo.established_year || searchedInfo.established_year),
      location: validatedLocation,
      business: ensureString(businessInfo.business),
      message: ensureString(businessInfo.message),
      footnote: ensureString(businessInfo.footnote),
      title: ensureString(businessInfo.title),
      key_metrics: mergedMetrics,  // Merged: AI + regex (ground truth)
      // Right-side content (varies by business type)
      business_type: businessType,
      breakdown_title: ensureString(productsBreakdown.breakdown_title) || 'Products and Applications',
      breakdown_items: productsBreakdown.breakdown_items || [],
      projects: productsBreakdown.projects || [],  // For project-based businesses
      products: productsBreakdown.products || [],  // For consumer-facing businesses
      metrics: ensureString(metricsInfo.metrics),  // Fallback for old format
      // Pre-extracted logo (from cascade: Clearbit → og:image → apple-touch-icon → img[logo] → favicon)
      _logo: logoResult,
      // Categorized business relationships (customers, suppliers, principals, brands)
      _businessRelationships: businessRelationships,
      // Product/project images for right side (B2C and project-based)
      _productProjectImages: productProjectImages
    };

    // Log metrics count before review
    console.log(`  [${index + 1}] Metrics extracted before review: ${companyData.key_metrics?.length || 0}`);
    if (companyData.key_metrics?.length > 0) {
      console.log(`  [${index + 1}] Raw metrics: ${companyData.key_metrics.map(m => m.label).join(', ')}`);
    }

    // Step 7: Run AI validator to compare extraction vs source and fix issues
    // IMPORTANT: Pass RAW scraped content (not marked content) so validator can catch what Marker missed
    const validatorResult = await reviewAndCleanData(companyData, scraped.content, markerResult?.markers);
    companyData = validatorResult.data;

    // Step 7b: ITERATIVE EXTRACTION - If validator found missed items, try to extract them
    // Trigger re-extraction if validator identified specific things that were missed
    const hasMissedItems = validatorResult.missedItems && validatorResult.missedItems.length > 0;
    const needsReExtraction = validatorResult.issuesFound && hasMissedItems;

    if (needsReExtraction) {
      console.log(`  [${index + 1}] Step 7b: Re-extracting ${validatorResult.missedItems.length} missed items...`);
      validatorResult.missedItems.forEach(item => console.log(`    - ${item}`));

      // Build focused prompt with explicit missed items
      const missedItemsText = validatorResult.missedItems.join('\n- ');
      const existingMetricsText = (companyData.key_metrics || [])
        .map(m => `${m.value} ${m.label}`)
        .join(', ');

      // Re-run metrics extraction with explicit focus on missed items
      // Use RAW scraped content so it can find things Marker missed
      const reExtractedMetrics = await extractKeyMetricsWithFocus(scraped.content, {
        company_name: companyData.company_name,
        business: companyData.business,
        existingMetrics: existingMetricsText,
        missedItems: missedItemsText
      });

      // Merge new metrics with existing (avoid duplicates by checking both label and value)
      if (reExtractedMetrics.key_metrics?.length > 0) {
        const existingLabels = new Set((companyData.key_metrics || []).map(m => m.label?.toLowerCase()));
        const existingValues = new Set((companyData.key_metrics || []).map(m => m.value?.toLowerCase()));
        const newMetrics = reExtractedMetrics.key_metrics.filter(m =>
          !existingLabels.has(m.label?.toLowerCase()) &&
          !existingValues.has(m.value?.toLowerCase())
        );
        if (newMetrics.length > 0) {
          console.log(`  [${index + 1}] Added ${newMetrics.length} new metrics from re-extraction`);
          companyData.key_metrics = [...(companyData.key_metrics || []), ...newMetrics];
        }
      }

      // Re-run validator one more time to catch anything else
      // Use raw content so it can validate against full source
      const finalValidation = await reviewAndCleanData(companyData, scraped.content, markerResult?.markers);
      companyData = finalValidation.data;
    }

    // Step 7: Filter out empty/meaningless Key Metrics
    // Remove metrics that say "No specific X stated", "Not specified", etc.
    const metricsBefore = companyData.key_metrics?.length || 0;
    companyData.key_metrics = filterEmptyMetrics(companyData.key_metrics);
    const metricsAfter = companyData.key_metrics?.length || 0;
    if (metricsBefore !== metricsAfter) {
      console.log(`  [${index + 1}] Step 7: Filtered ${metricsBefore - metricsAfter} empty metrics (${metricsBefore} → ${metricsAfter})`);
    }

    console.log(`  [${index + 1}] ✓ Completed: ${companyData.title || companyData.company_name} (${companyData.key_metrics?.length || 0} metrics after review)`);

    // Memory cleanup: Release large objects to prevent OOM on Railway
    // scraped.content and rawHtml can be 1-5MB per website, must release before next iteration
    if (scraped) {
      scraped.content = null;
      scraped.rawHtml = null;
    }

    return companyData;

  } catch (error) {
    console.error(`  [${index + 1}] Error processing ${trimmedWebsite}:`, error.message);
    return {
      website: trimmedWebsite,
      error: error.message,
      step: 0
    };
  }
}

// Process websites in parallel batches
// Reduced to 2 to avoid rate limits (each website now makes more API calls with Marker AI)
const PARALLEL_BATCH_SIZE = 2;

async function processWebsitesInParallel(websites) {
  const results = [];
  const total = websites.length;

  // Process in batches of PARALLEL_BATCH_SIZE
  for (let batchStart = 0; batchStart < websites.length; batchStart += PARALLEL_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + PARALLEL_BATCH_SIZE, websites.length);
    const batch = websites.slice(batchStart, batchEnd);

    console.log(`\n${'─'.repeat(40)}`);
    console.log(`BATCH ${Math.floor(batchStart / PARALLEL_BATCH_SIZE) + 1}: Processing ${batch.length} websites in parallel (${batchStart + 1}-${batchEnd} of ${total})`);
    console.log('─'.repeat(40));

    // Process batch in parallel
    const batchPromises = batch.map((website, i) =>
      processSingleWebsite(website, batchStart + i, total)
    );

    const batchResults = await Promise.all(batchPromises);

    // Add non-null results
    for (const result of batchResults) {
      if (result) results.push(result);
    }

    // Force garbage collection hint between batches (if available)
    // This helps Railway containers stay under memory limits
    if (global.gc) {
      global.gc();
    }
    logMemoryUsage(`after batch ${Math.floor(batchStart / PARALLEL_BATCH_SIZE) + 1}`);
  }

  return results;
}

// Main profile slides endpoint
app.post('/api/profile-slides', async (req, res) => {
  const { websites, email, targetDescription, rightLayout } = req.body;
  // rightLayout options: 'table-6' (default), 'table-unlimited', 'table-half', 'images', 'empty'

  if (!websites || !Array.isArray(websites) || websites.length === 0) {
    return res.status(400).json({ error: 'Please provide an array of website URLs' });
  }

  if (!email) {
    return res.status(400).json({ error: 'Please provide an email address' });
  }

  if (!targetDescription) {
    return res.status(400).json({ error: 'Please provide a target description' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`PROFILE SLIDES REQUEST: ${new Date().toISOString()}`);
  console.log(`Target: ${targetDescription}`);
  console.log(`Processing ${websites.length} website(s)`);
  console.log(`Email: ${email}`);
  console.log('='.repeat(50));

  // Return immediately - process in background
  res.json({
    success: true,
    message: 'Request received. Results will be emailed within 5-10 minutes.',
    companies: [],
    errors: [],
    total: websites.length
  });

  // Process in background using parallel batch processing
  try {
    // Process websites in parallel batches of 4 for ~3x faster processing
    const results = await processWebsitesInParallel(websites);

    // Separate successful companies, inaccessible websites, and errors
    const companies = results.filter(r => !r.error && !r._inaccessible);
    const inaccessibleWebsites = results.filter(r => r._inaccessible);
    const errors = results.filter(r => r.error && !r._inaccessible);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`PROFILE SLIDES EXTRACTION COMPLETE`);
    console.log(`Extracted: ${companies.length}/${websites.length} successful`);
    if (inaccessibleWebsites.length > 0) {
      console.log(`Inaccessible (will appear on summary only): ${inaccessibleWebsites.length}`);
    }
    console.log('='.repeat(50));

    // Memory cleanup before PPTX generation (which is memory-intensive)
    // Clear the results array since we only need companies/errors now
    results.length = 0;
    if (global.gc) global.gc();
    logMemoryUsage('before PPTX generation');

    // Generate PPTX using PptxGenJS (with target list slide)
    // Pass inaccessible websites to include on summary slide
    let pptxResult = null;
    if (companies.length > 0 || inaccessibleWebsites.length > 0) {
      pptxResult = await generatePPTX(companies, targetDescription, inaccessibleWebsites, rightLayout || 'table-6');
      logMemoryUsage('after PPTX generation');
      // Force GC after PPTX generation to free memory before email
      if (global.gc) global.gc();
    }

    // Build email content
    const companyNames = companies.slice(0, 3).map(c => c.title || c.company_name).join(', ');
    const subject = `Profile Slides: ${companies.length} companies${companyNames ? ` (${companyNames}${companies.length > 3 ? '...' : ''})` : ''}`;
    const htmlContent = buildProfileSlidesEmailHTML(companies, errors, pptxResult?.success);

    // Send email with PPTX attachment
    const attachment = pptxResult?.success ? {
      content: pptxResult.content,
      name: `Profile_Slides_${new Date().toISOString().split('T')[0]}.pptx`
    } : null;

    await sendEmail(email, subject, htmlContent, attachment);

    console.log(`Email sent to ${email}${attachment ? ' with PPTX attachment' : ''}`);
    console.log('='.repeat(50));

    // Memory cleanup after email sent
    if (pptxResult) pptxResult.content = null;
    pptxResult = null;

  } catch (error) {
    console.error('Profile slides error:', error);
    try {
      await sendEmail(email, 'Profile Slides - Error', `<p>Error processing your request: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});


// ============ GENERATE PPT ENDPOINT (returns content, no email) ============
// Used by v6 search to generate PPT and attach to its own email
app.post('/api/generate-ppt', async (req, res) => {
  const { websites, targetDescription, rightLayout } = req.body;

  if (!websites || !Array.isArray(websites) || websites.length === 0) {
    return res.status(400).json({ error: 'Please provide an array of website URLs' });
  }

  if (!targetDescription) {
    return res.status(400).json({ error: 'Please provide a target description' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`GENERATE PPT REQUEST: ${new Date().toISOString()}`);
  console.log(`Target: ${targetDescription}`);
  console.log(`Processing ${websites.length} website(s)`);
  console.log('='.repeat(50));

  try {
    const results = [];

    for (let i = 0; i < websites.length; i++) {
      const website = websites[i].trim();
      if (!website) continue;

      console.log(`\n[${i + 1}/${websites.length}] Processing: ${website}`);
      logMemoryUsage(`start company ${i + 1}`);

      try {
        // Step 1: Scrape website (now scrapes multiple pages)
        console.log('  Step 1: Scraping website (multi-page)...');
        const scraped = await scrapeMultiplePages(website);

        if (!scraped.success) {
          console.log(`  Failed to scrape: ${scraped.error}`);
          // Mark as inaccessible - will appear on summary slide but not individual profile
          const companyName = extractCompanyNameFromUrl(website);
          results.push({
            website,
            company_name: companyName,
            title: companyName,
            location: '',
            _inaccessible: true,
            _error: `Failed to scrape: ${scraped.error}`
          });
          console.log(`  Marked as inaccessible: ${companyName}`);
          continue;
        }
        const pagesScrapedCount = scraped.pagesScraped?.length || 1;
        console.log(`  Scraped ${scraped.content.length} characters from ${pagesScrapedCount} pages`);
        // Log content preview for debugging (first 500 chars, useful for seeing what was scraped)
        console.log(`  Content preview: ${scraped.content.substring(0, 500).replace(/\n/g, ' ').replace(/\s+/g, ' ')}...`);

        // Step 1a: Pre-extract metrics using deterministic regex
        const regexMetrics = extractMetricsFromText(scraped.content);
        if (Object.keys(regexMetrics).length > 0) {
          console.log(`  Regex found: ${Object.keys(regexMetrics).filter(k => !k.endsWith('_text')).join(', ')}`);
        }

        // Step 1b: Extract structured address from JSON-LD
        const structuredAddress = extractStructuredAddress(scraped.rawHtml);
        if (structuredAddress) {
          console.log(`  Found JSON-LD address: ${structuredAddress.formatted}`);
        }

        // Step 1c: Extract logo using cascade
        console.log('  Step 1c: Extracting company logo...');
        const logoResult = await extractLogoFromWebsite(website, scraped.rawHtml);
        if (logoResult) {
          console.log(`  Logo found via ${logoResult.source}`);
        }

        // Step 1d: Extract customer/partner names from image alt texts
        const customerNamesFromImages = extractCustomerNamesFromImages(scraped.rawHtml);
        if (customerNamesFromImages.length > 0) {
          console.log(`  Customer names from images: ${customerNamesFromImages.slice(0, 5).join(', ')}${customerNamesFromImages.length > 5 ? '...' : ''}`);
        }

        // Step 2: Extract basic info
        console.log('  Step 2: Extracting company name, year, location...');
        const basicInfo = await extractBasicInfo(scraped.content, website);
        console.log(`  Company: ${basicInfo.company_name || 'Not found'}`);
        if (basicInfo.location) console.log(`  Location extracted: ${basicInfo.location}`);

        // Step 3: Extract business details
        console.log('  Step 3: Extracting business, message, footnote, title...');
        const businessInfo = await extractBusinessInfo(scraped.content, basicInfo);

        // Step 4: Extract key metrics
        console.log('  Step 4: Extracting key metrics...');
        const metricsInfo = await extractKeyMetrics(scraped.content, {
          company_name: basicInfo.company_name,
          business: businessInfo.business
        });

        // Step 4b: Extract products/applications breakdown
        console.log('  Step 4b: Extracting products/applications breakdown...');
        const productsBreakdown = await extractProductsBreakdown(scraped.content, {
          company_name: basicInfo.company_name,
          business: businessInfo.business
        });

        // Step 5: Search online for missing mandatory info
        const missingFields = [];
        if (!basicInfo.established_year) missingFields.push('established_year');
        if (!basicInfo.location) missingFields.push('location');

        let searchedInfo = {};
        if (missingFields.length > 0 && basicInfo.company_name) {
          console.log(`  Step 5: Searching online for missing info: ${missingFields.join(', ')}...`);
          searchedInfo = await searchMissingInfo(basicInfo.company_name, website, missingFields);
        }

        // Merge regex metrics with VERIFIED AI metrics (REGEX FIRST - ground truth)
        const rawKeyMetrics = metricsInfo.key_metrics || [];
        const allKeyMetrics = filterMetricsByVerification(rawKeyMetrics, scraped.content, 1);

        // Build regex metrics first (deterministic, no hallucination)
        const regexBasedMetrics = [];
        const regexCoveredTypes = new Set();
        if (regexMetrics.office_count) { regexBasedMetrics.push({ value: String(regexMetrics.office_count), label: normalizeLabel(regexMetrics.office_text || 'Offices') }); regexCoveredTypes.add('office'); }
        if (regexMetrics.employee_count) { regexBasedMetrics.push({ value: String(regexMetrics.employee_count), label: 'Employees' }); regexCoveredTypes.add('employee'); }
        if (regexMetrics.years_experience) { regexBasedMetrics.push({ value: String(regexMetrics.years_experience), label: 'Years Experience' }); regexCoveredTypes.add('year'); }
        if (regexMetrics.export_countries) { regexBasedMetrics.push({ value: String(regexMetrics.export_countries), label: 'Export Countries' }); regexCoveredTypes.add('export'); }
        if (regexMetrics.source_countries) { regexBasedMetrics.push({ value: String(regexMetrics.source_countries), label: 'Source Countries' }); regexCoveredTypes.add('source'); }
        if (regexMetrics.capacity_text) { regexBasedMetrics.push({ value: translateUnitsToEnglish(regexMetrics.capacity_text), label: 'Production Capacity' }); regexCoveredTypes.add('capacity'); }
        if (regexMetrics.certifications?.length > 0) { regexBasedMetrics.push({ value: regexMetrics.certifications.join(', '), label: 'Certifications' }); regexCoveredTypes.add('certif'); }
        if (regexMetrics.machine_count) { regexBasedMetrics.push({ value: String(regexMetrics.machine_count) + '+', label: 'Machines' }); regexCoveredTypes.add('machine'); }
        if (regexMetrics.partner_count) { regexBasedMetrics.push({ value: String(regexMetrics.partner_count) + '+', label: 'Business Partners' }); regexCoveredTypes.add('partner'); }
        if (regexMetrics.export_regions) { regexBasedMetrics.push({ value: regexMetrics.export_regions, label: 'Export Markets' }); regexCoveredTypes.add('market'); }
        if (regexMetrics.product_count) { regexBasedMetrics.push({ value: String(regexMetrics.product_count) + '+', label: 'Products' }); regexCoveredTypes.add('product'); }
        if (regexMetrics.customer_count) { regexBasedMetrics.push({ value: String(regexMetrics.customer_count) + '+', label: 'Customers' }); regexCoveredTypes.add('customer'); }
        if (regexMetrics.fleet_count) { regexBasedMetrics.push({ value: String(regexMetrics.fleet_count) + '+', label: 'Vehicles' }); regexCoveredTypes.add('vehicle'); }
        if (regexMetrics.factory_size) { regexBasedMetrics.push({ value: translateUnitsToEnglish(regexMetrics.factory_size), label: 'Factory Size' }); regexCoveredTypes.add('factory'); }

        // Add AI metrics only for types not covered by regex
        const mergedMetrics = [...regexBasedMetrics];
        for (const aiMetric of allKeyMetrics) {
          const labelLower = aiMetric.label.toLowerCase();
          const alreadyCovered = [...regexCoveredTypes].some(type => labelLower.includes(type));
          if (!alreadyCovered) { mergedMetrics.push(aiMetric); }
        }

        // Determine location: prefer AI extraction, fallback to JSON-LD
        let finalLocation = ensureString(basicInfo.location || searchedInfo.location);
        if (!finalLocation && structuredAddress?.formatted) {
          finalLocation = structuredAddress.formatted;
          console.log(`  Using JSON-LD address as fallback: ${finalLocation}`);
        }

        // Validate and fix HQ format
        let validatedLocation = validateAndFixHQFormat(finalLocation, website);

        // FIX #1: If location is incomplete (< 2 levels), retry with focused extraction
        if (validatedLocation) {
          const locParts = validatedLocation.split(',').map(p => p.trim()).filter(p => p);
          const requiredLevels = 2; // 2 levels for all countries (state/province, country)
          if (locParts.length < requiredLevels) {
            console.log(`  HQ incomplete (${locParts.length}/${requiredLevels} levels), retrying...`);
            const improvedLocation = await extractFullAddress(scraped.content, website, validatedLocation);
            if (improvedLocation && improvedLocation !== validatedLocation) {
              validatedLocation = validateAndFixHQFormat(improvedLocation, website);
            }
          }
        }

        // Determine business type: keyword detection can override AI's classification
        let businessType = productsBreakdown.business_type || 'industrial';
        const detectedType = detectBusinessType(businessInfo.business, scraped.content);
        // Only use keyword detection as fallback when AI didn't provide classification
        if (!productsBreakdown.business_type && detectedType) {
          console.log(`  Business type: "${detectedType}" (keyword fallback, AI had no classification)`);
          businessType = detectedType;
        }

        // FIX #3: Extract product/project images for ALL business types
        let productProjectImages = [];
        productProjectImages = extractProductProjectImages(scraped.rawHtml, businessType, website);
        if (productProjectImages.length > 0) {
          console.log(`  Found ${productProjectImages.length} images for right side`);
        }

        // FIX #5: Extract categorized business relationships (customers, suppliers, principals, brands)
        console.log('  Step 5b: Extracting business relationships (metadata)...');
        const businessRelationships = extractBusinessRelationships(scraped.rawHtml);

        // Step 5c: Use GPT-4o Vision to read logo images
        console.log('  Step 5c: Reading logos with GPT-4o Vision...');
        const visionResults = await extractNamesFromLogosWithVision(scraped.rawHtml, website);

        // Step 5d: Screenshot fallback - if vision/metadata extraction found few partners, use full-page screenshot
        let screenshotResults = { customers: [], brands: [], principals: [] };
        const totalFromVision = visionResults.customers.length + visionResults.brands.length;
        const totalFromMeta = businessRelationships.customers.length + businessRelationships.principals.length + businessRelationships.brands.length;

        if (totalFromVision + totalFromMeta < 3 && process.env.SCREENSHOT_API_KEY) {
          console.log(`  Step 5d: Few partners found (${totalFromVision + totalFromMeta}), trying screenshot analysis...`);
          screenshotResults = await extractPartnersFromScreenshot(website);
        }

        // Merge results with CONFIDENCE-BASED prioritization
        const highConfidenceCustomers = [...new Set([
          ...visionResults.customers,
          ...screenshotResults.customers
        ])];
        const lowConfidenceCustomers = [...new Set([
          ...customerNamesFromImages,
          ...businessRelationships.customers
        ])];
        // Only add low-confidence if high-confidence found < 3
        const allCustomers = highConfidenceCustomers.length >= 3
          ? highConfidenceCustomers
          : [...new Set([...highConfidenceCustomers, ...lowConfidenceCustomers])];

        const allBrands = [...new Set([
          ...visionResults.brands,
          ...screenshotResults.brands,
          ...businessRelationships.brands
        ])];
        const allPrincipals = [...new Set([
          ...screenshotResults.principals,
          ...businessRelationships.principals
        ])];

        businessRelationships.customers = allCustomers;
        businessRelationships.brands = allBrands;
        businessRelationships.principals = allPrincipals;

        const relationshipCounts = Object.entries(businessRelationships)
          .filter(([, arr]) => arr.length > 0)
          .map(([key, arr]) => `${key}: ${arr.length}`)
          .join(', ');
        if (relationshipCounts) {
          console.log(`  Total relationships: ${relationshipCounts}`);
        }

        let companyData = {
          website: scraped.url,
          company_name: ensureString(basicInfo.company_name),
          established_year: ensureString(basicInfo.established_year || searchedInfo.established_year),
          location: validatedLocation,
          business: ensureString(businessInfo.business),
          message: ensureString(businessInfo.message),
          footnote: ensureString(businessInfo.footnote),
          title: ensureString(businessInfo.title),
          key_metrics: mergedMetrics,
          // Right-side content (varies by business type)
          business_type: businessType,
          breakdown_title: ensureString(productsBreakdown.breakdown_title) || 'Products and Applications',
          breakdown_items: productsBreakdown.breakdown_items || [],
          projects: productsBreakdown.projects || [],  // For project-based businesses
          products: productsBreakdown.products || [],  // For consumer-facing businesses
          metrics: ensureString(metricsInfo.metrics),
          // Pre-extracted logo
          _logo: logoResult,
          // Categorized business relationships (customers, suppliers, principals, brands)
          _businessRelationships: businessRelationships,
          // Product/project images
          _productProjectImages: productProjectImages
        };

        // Step 6: Run AI validator to compare extraction vs source and fix issues
        companyData = await reviewAndCleanData(companyData, scraped.content);

        // Step 7: Filter empty metrics
        const metricsBefore = companyData.key_metrics?.length || 0;
        companyData.key_metrics = filterEmptyMetrics(companyData.key_metrics);
        const metricsAfter = companyData.key_metrics?.length || 0;
        if (metricsBefore !== metricsAfter) {
          console.log(`  Step 7: Filtered ${metricsBefore - metricsAfter} empty metrics`);
        }

        console.log(`  ✓ Completed: ${companyData.title || companyData.company_name}`);
        results.push(companyData);

        if (scraped) {
          scraped.content = null;
          scraped.rawHtml = null;
        }

      } catch (error) {
        console.error(`  Error processing ${website}:`, error.message);
        results.push({
          website,
          error: error.message,
          step: 0
        });
      }

      if (global.gc) global.gc();
    }

    // Separate successful companies, inaccessible websites, and errors
    const companies = results.filter(r => !r.error && !r._inaccessible);
    const inaccessibleWebsites = results.filter(r => r._inaccessible);
    const errors = results.filter(r => r.error && !r._inaccessible);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`EXTRACTION COMPLETE: ${companies.length}/${websites.length} successful`);
    if (inaccessibleWebsites.length > 0) {
      console.log(`Inaccessible (will appear on summary only): ${inaccessibleWebsites.length}`);
    }
    console.log('='.repeat(50));

    results.length = 0;
    if (global.gc) global.gc();

    // Generate PPTX - pass inaccessible websites to include on summary slide
    let pptxResult = null;
    if (companies.length > 0 || inaccessibleWebsites.length > 0) {
      pptxResult = await generatePPTX(companies, targetDescription, inaccessibleWebsites, rightLayout || 'table-6');
    }

    if (pptxResult?.success) {
      console.log('PPT generated successfully');
      return res.json({
        success: true,
        content: pptxResult.content,
        filename: `Profile_Slides_${new Date().toISOString().split('T')[0]}.pptx`,
        companiesProcessed: companies.length,
        errors: errors.length
      });
    } else {
      return res.json({
        success: false,
        error: 'Failed to generate PPT',
        companiesProcessed: companies.length,
        errors: errors.length
      });
    }

  } catch (error) {
    console.error('Generate PPT error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============ HEALTH CHECK ============
app.get('/health', healthCheck('profile-slides'));

// ============ HEALTHCHECK ============
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'profile-slides' });
});

// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Profile Slides server running on port ${PORT}`);
});
