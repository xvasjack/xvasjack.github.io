# AI Model Cost Optimization Analysis

**Generated:** December 20, 2025
**Platform:** Find Target - M&A Intelligence Platform

---

## Executive Summary

This analysis identifies opportunities to reduce AI costs across the platform's 9 products while maintaining output quality. Key findings suggest potential cost savings of **40-60%** by strategically replacing GPT-4o with newer, more cost-effective models like Gemini 2.5 Flash-Lite and DeepSeek V3.2.

---

## Current Pricing Reference (December 2025)

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Notes |
|-------|----------------------|------------------------|-------|
| **GPT-4o** | $2.50 | $10.00 | High quality, expensive |
| **GPT-4o-mini** | $0.15 | $0.60 | Good for simpler tasks |
| **o1** | $15.00 | $60.00 | Best reasoning, very expensive |
| **o3-mini** | $1.10 | $4.40 | Good reasoning, expensive |
| **Gemini 2.0 Flash** | $0.10 | $0.40 | Currently in use |
| **Gemini 2.5 Flash-Lite** | $0.10 | $0.40 | Same price as 2.0, better quality |
| **Gemini 2.5 Flash** | $0.30 | $2.50 | With thinking capability |
| **DeepSeek V3.2** | $0.28 | $0.42 | Cache miss pricing |
| **DeepSeek V3.2** | $0.028 | $0.42 | Cache hit (90% cheaper) |
| **Perplexity Sonar** | $1.00 + $5/1K searches | $1.00 | Web search capability |

---

## Product-by-Product Analysis

### 1. Profile Slides Generator (`/api/profile-slides`)

**Current Usage:**
- 6 AI agents, ALL using **GPT-4o**
- Agent 1: Extract basic info (company name, year, location)
- Agent 2: Extract business info (description, message)
- Agent 3: Extract key metrics
- Agent 3b: Extract products breakdown
- Agent 3c: Extract financial metrics
- Agent 4: Search for missing info (uses gpt-4o-mini-search-preview)
- Agent 5: Search additional metrics (uses gpt-4o-mini-search-preview)

**Cost Impact:** HIGH - 6 GPT-4o calls per company = ~$0.10-0.15 per company

**Recommendation: Replace Agents 1, 3c with Gemini 2.5 Flash-Lite**

| Agent | Current Model | Recommended Model | Rationale |
|-------|---------------|-------------------|-----------|
| Agent 1 (Basic Info) | GPT-4o | **Gemini 2.5 Flash-Lite** | Simple extraction task |
| Agent 2 (Business Info) | GPT-4o | GPT-4o-mini | Structured output, doesn't need full GPT-4o |
| Agent 3 (Key Metrics) | GPT-4o | GPT-4o-mini | Pattern-based extraction |
| Agent 3b (Products) | GPT-4o | GPT-4o-mini | Category segmentation |
| Agent 3c (Financial) | GPT-4o | **Gemini 2.5 Flash-Lite** | Number extraction |

**Estimated Savings:** 60-70% per company ($0.10 → $0.03-0.04)

---

### 2. Trading Comparable (`/api/trading-comparable`)

**Current Usage:**
- Phase 1: **o1** for deep analysis (with o3-mini fallback)
- Phase 2: **Gemini 2.0 Flash** for relevance check
- Phase 3: **Perplexity Sonar** for web verification
- Majority voting across 3 AIs

**Cost Impact:** VERY HIGH - o1 is $15/$60 per million tokens

**Recommendation: Replace o1 with Gemini 2.5 Flash (thinking mode)**

| Phase | Current Model | Recommended Model | Rationale |
|-------|---------------|-------------------|-----------|
| Phase 1 (Deep Analysis) | o1 ($15/$60) | **Gemini 2.5 Flash** ($0.30/$2.50) | 10x cheaper, comparable reasoning |
| Fallback | o3-mini ($1.10/$4.40) | **DeepSeek V3.2 Reasoner** | 3x cheaper |
| Phase 2 | Gemini 2.0 Flash | **Gemini 2.5 Flash-Lite** | Better quality, same price |

**Estimated Savings:** 80-90% per request

---

### 3. Speeda Validation (`/api/validation`)

**Current Usage:**
- Website finding: Multiple search APIs
- Company validation: **GPT-4o** (gpt-4o line 1391: "Use smarter model for better validation")
- Batch size: 15 companies parallel

**Cost Impact:** MEDIUM - ~$0.02-0.05 per company

**Recommendation: Two-tier approach**

| Task | Current Model | Recommended Model | Rationale |
|------|---------------|-------------------|-----------|
| Initial validation | GPT-4o | **Gemini 2.5 Flash-Lite** | Simple yes/no classification |
| Uncertain cases | GPT-4o | GPT-4o (keep) | Complex edge cases need quality |

**Estimated Savings:** 40-50% (most validations are straightforward)

---

### 4. Write Like Anil (`/api/write-like-anil`)

**Current Usage:**
- Single call to **GPT-4o** with custom system prompt
- Two modes: generate or rewrite

**Cost Impact:** LOW-MEDIUM - ~$0.01-0.03 per email

**Recommendation: Use GPT-4o-mini**

| Mode | Current Model | Recommended Model | Rationale |
|------|---------------|-------------------|-----------|
| Generate | GPT-4o | **GPT-4o-mini** | Email writing doesn't need GPT-4o |
| Rewrite | GPT-4o | **GPT-4o-mini** | Style mimicking works well with mini |

**Estimated Savings:** 90% per email ($0.02 → $0.002)

---

### 5. Due Diligence Report (`/api/due-diligence`)

**Current Usage:**
- Primary: **DeepSeek V3.2** (already optimized!)
- Fallback: GPT-4o
- Translation: GPT-4o-mini
- Transcription: Whisper-1

**Cost Impact:** Already optimized with DeepSeek-first approach

**Recommendation: No changes needed** - Already using the most cost-effective strategy

---

### 6. Find Target v3/v4 (`/api/find-target`, `/api/find-target-slow`, `/api/find-target-v4`)

**Current Usage:**
- 14 parallel search strategies using:
  - SerpAPI (5 strategies)
  - Perplexity Sonar (6 strategies)
  - gpt-4o-mini-search-preview (2 strategies)
  - Gemini 2.0 Flash (3 queries)
- Company extraction: GPT-4o-mini
- Deduplication: GPT-4o-mini

**Cost Impact:** HIGH per search (many API calls) but already diversified

**Recommendation: Upgrade Gemini 2.0 → 2.5 Flash-Lite**

| Component | Current Model | Recommended Model | Rationale |
|-----------|---------------|-------------------|-----------|
| Search diversity | Gemini 2.0 Flash | **Gemini 2.5 Flash-Lite** | Same price, better results |
| Company extraction | GPT-4o-mini | GPT-4o-mini (keep) | Already optimized |

**Estimated Savings:** 5-10% improvement in search quality (same cost)

---

### 7. Understanding The Business (UTB) (`/api/utb`)

**Current Usage:**
- Research: Multiple Perplexity calls
- Analysis: Likely GPT-4o (needs verification)

**Recommendation: Use DeepSeek V3.2 for analysis** (similar to DD approach)

---

## Implementation Priority Matrix

| Priority | Product | Current Cost | Potential Savings | Effort |
|----------|---------|--------------|-------------------|--------|
| 1 | Trading Comparable | Very High | 80-90% | Low |
| 2 | Profile Slides | High | 60-70% | Medium |
| 3 | Write Like Anil | Medium | 90% | Very Low |
| 4 | Validation | Medium | 40-50% | Low |
| 5 | Find Target | High | 5-10% quality boost | Very Low |

---

## Recommended Code Changes

### 1. Trading Comparable - Replace o1 with Gemini 2.5 Flash

```javascript
// Current (server.js line ~3080)
const response = await openai.chat.completions.create({
  model: 'o1',
  messages: [{ role: 'user', content: prompt + '\n\nRespond with valid JSON only.' }]
});

// Recommended
const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' }
  })
});
```

### 2. Profile Slides - Replace GPT-4o with Gemini 2.5 Flash-Lite for basic extraction

```javascript
// Create new helper function
async function callGeminiFlashLite(prompt) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}
```

### 3. Write Like Anil - Use GPT-4o-mini

```javascript
// Current (server.js line ~4681)
model: 'gpt-4o',

// Recommended
model: 'gpt-4o-mini',
```

---

## Model Upgrade Path: Gemini 2.0 → 2.5

Since Gemini 2.0 Flash is being deprecated, all Gemini 2.0 Flash calls should migrate to either:

1. **Gemini 2.5 Flash-Lite** ($0.10/$0.40) - Same price, better quality, no thinking
2. **Gemini 2.5 Flash** ($0.30/$2.50) - For tasks requiring reasoning

### Files to Update:
- `server.js` line 190: Update API endpoint from `gemini-2.0-flash` to `gemini-2.5-flash-lite`

```javascript
// Current
const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {

// Recommended
const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`, {
```

---

## Cost Projection Summary

| Product | Current Est. Cost/Request | After Optimization | Monthly Savings (100 reqs) |
|---------|--------------------------|-------------------|---------------------------|
| Profile Slides | $0.12 | $0.04 | $8.00 |
| Trading Comparable | $0.50+ | $0.05 | $45.00 |
| Write Like Anil | $0.02 | $0.002 | $1.80 |
| Validation (per company) | $0.04 | $0.02 | $2.00 |
| Find Target | $0.80 | $0.75 | $5.00 |
| **TOTAL MONTHLY SAVINGS** | | | **~$60+** |

*Note: Actual savings depend on usage volume and token consumption patterns.*

---

## Testing Recommendations

Before deploying model changes:

1. **A/B Test Quality:** Run 20 sample requests through both models and compare output quality
2. **Latency Check:** Ensure response times remain acceptable
3. **Error Rate Monitoring:** Monitor for increased failures with new models
4. **Fallback Chains:** Maintain GPT-4o as fallback for critical failures

---

## Sources

- [OpenAI Pricing](https://openai.com/api/pricing/)
- [Gemini API Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [DeepSeek API Pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [Perplexity API Pricing](https://docs.perplexity.ai/getting-started/pricing)
- [Gemini 2.5 Flash-Lite Announcement](https://developers.googleblog.com/en/gemini-25-flash-lite-is-now-stable-and-generally-available/)
