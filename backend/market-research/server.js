require('dotenv').config({ path: '../.env' });
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const pptxgen = require('pptxgenjs');

// ============ GLOBAL ERROR HANDLERS ============
process.on('unhandledRejection', (reason, promise) => {
  console.error('=== UNHANDLED PROMISE REJECTION ===');
  console.error('Reason:', reason);
  console.error('Stack:', reason?.stack || 'No stack trace');
});

process.on('uncaughtException', (error) => {
  console.error('=== UNCAUGHT EXCEPTION ===');
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
});

// ============ EXPRESS SETUP ============
const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Check required environment variables
const requiredEnvVars = ['DEEPSEEK_API_KEY', 'PERPLEXITY_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}

// ============ COST TRACKING ============
const costTracker = {
  date: new Date().toISOString().split('T')[0],
  totalCost: 0,
  calls: []
};

// Pricing per 1M tokens (from DeepSeek docs - Dec 2024)
// Both deepseek-chat and deepseek-reasoner use same pricing
// deepseek-chat = V3.2 Non-thinking Mode (max 8K output)
// deepseek-reasoner = V3.2 Thinking Mode (max 64K output)
const PRICING = {
  'deepseek-chat': { input: 0.28, output: 0.42 },      // Cache miss pricing
  'deepseek-reasoner': { input: 0.28, output: 0.42 }, // Same pricing, but thinking mode
  'perplexity': { perSearch: 0.005 },                  // Sonar basic
  'perplexity-pro': { perSearch: 0.015 }               // Sonar Pro
};

function trackCost(model, inputTokens, outputTokens, searchCount = 0) {
  let cost = 0;
  const pricing = PRICING[model];

  if (pricing) {
    if (pricing.perSearch) {
      cost = searchCount * pricing.perSearch;
    } else {
      cost = (inputTokens / 1000000) * pricing.input + (outputTokens / 1000000) * pricing.output;
    }
  }

  costTracker.totalCost += cost;
  costTracker.calls.push({ model, inputTokens, outputTokens, searchCount, cost, time: new Date().toISOString() });
  console.log(`  [Cost] ${model}: $${cost.toFixed(4)} (Total: $${costTracker.totalCost.toFixed(4)})`);
  return cost;
}

// ============ AI TOOLS ============

// DeepSeek Chat - for lighter tasks (scope parsing)
async function callDeepSeekChat(prompt, systemPrompt = '', maxTokens = 4096) {
  try {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        max_tokens: maxTokens,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`DeepSeek Chat HTTP error ${response.status}:`, errorText.substring(0, 200));
      return { content: '', usage: { input: 0, output: 0 } };
    }

    const data = await response.json();
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    trackCost('deepseek-chat', inputTokens, outputTokens);

    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: { input: inputTokens, output: outputTokens }
    };
  } catch (error) {
    console.error('DeepSeek Chat API error:', error.message);
    return { content: '', usage: { input: 0, output: 0 } };
  }
}

// DeepSeek Reasoner (R1) - for deep thinking analysis
async function callDeepSeek(prompt, systemPrompt = '', maxTokens = 16384) {
  try {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages,
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`DeepSeek Reasoner HTTP error ${response.status}:`, errorText.substring(0, 200));
      // Fallback to chat model
      console.log('Falling back to deepseek-chat...');
      return callDeepSeekChat(prompt, systemPrompt, maxTokens);
    }

    const data = await response.json();
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    trackCost('deepseek-reasoner', inputTokens, outputTokens);

    // R1 returns reasoning_content + content
    const content = data.choices?.[0]?.message?.content || '';
    const reasoning = data.choices?.[0]?.message?.reasoning_content || '';

    console.log(`  [DeepSeek R1] Reasoning: ${reasoning.length} chars, Output: ${content.length} chars`);

    return {
      content,
      reasoning,
      usage: { input: inputTokens, output: outputTokens }
    };
  } catch (error) {
    console.error('DeepSeek Reasoner API error:', error.message);
    return { content: '', usage: { input: 0, output: 0 } };
  }
}

// Perplexity API for web search - using sonar-pro for deeper research
async function callPerplexity(query) {
  try {
    // Use sonar-pro for more thorough search results
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [{
          role: 'system',
          content: 'You are a market research analyst. Provide detailed, factual information with specific numbers, dates, and sources. Focus on recent data (2023-2025).'
        }, {
          role: 'user',
          content: query
        }],
        max_tokens: 4096,
        temperature: 0.1,
        search_recency_filter: 'year',
        return_citations: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Perplexity HTTP error ${response.status}:`, errorText.substring(0, 200));
      // Fallback to basic sonar model
      return callPerplexityBasic(query);
    }

    const data = await response.json();
    trackCost('perplexity-pro', 0, 0, 1);

    return {
      content: data.choices?.[0]?.message?.content || '',
      citations: data.citations || []
    };
  } catch (error) {
    console.error('Perplexity API error:', error.message);
    return { content: '', citations: [] };
  }
}

// Fallback to basic sonar model
async function callPerplexityBasic(query) {
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: query }],
        max_tokens: 2048,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      return { content: '', citations: [] };
    }

    const data = await response.json();
    trackCost('perplexity', 0, 0, 1);

    return {
      content: data.choices?.[0]?.message?.content || '',
      citations: data.citations || []
    };
  } catch (error) {
    return { content: '', citations: [] };
  }
}

// ============ RESEARCH FRAMEWORK ============
// Expanded queries for thorough research (~30-40 searches per country)

const RESEARCH_FRAMEWORK = {
  macroContext: {
    name: 'Macro Context',
    queries: [
      '{country} GDP 2024 2025 economic growth forecast',
      '{country} population demographics urban rural industrial workforce',
      '{country} industrial sector manufacturing contribution GDP 2024',
      '{country} energy consumption by sector industrial commercial residential',
      '{country} energy intensity trends comparison regional',
      '{country} economic development plan industrial policy 2024 2030'
    ]
  },
  policyRegulatory: {
    name: 'Policy & Regulatory Environment',
    queries: [
      '{country} national energy policy 2024 2025 targets',
      '{country} renewable energy targets carbon neutrality net zero timeline',
      '{country} foreign direct investment rules energy sector restrictions',
      '{country} foreign ownership limits power energy companies percentage',
      '{country} ESCO energy service companies government support incentives',
      '{country} energy efficiency regulations mandatory standards industrial',
      '{country} investment promotion board energy incentives tax breaks',
      '{country} power purchase agreement PPA regulations private sector'
    ]
  },
  marketDynamics: {
    name: 'Market Dynamics',
    queries: [
      '{country} energy services market size value 2024 2025 forecast',
      '{country} ESCO market size energy performance contracting',
      '{country} electricity tariff industrial commercial rates 2024',
      '{country} natural gas price industrial LNG spot 2024',
      '{country} energy demand growth industrial sector manufacturing',
      '{country} power generation capacity mix coal gas renewable',
      '{country} district cooling heating market size',
      '{country} industrial energy audit market demand'
    ]
  },
  competitiveLandscape: {
    name: 'Competitive Landscape',
    queries: [
      '{country} energy service companies ESCO major players list',
      '{country} ESCO association members registered companies',
      'Japanese companies {country} energy investment Tokyo Gas Osaka Gas JERA',
      '{country} foreign energy companies European American presence',
      '{country} state owned energy utility company market dominance',
      '{country} energy market entry barriers foreign companies challenges',
      '{country} energy sector M&A acquisitions partnerships 2023 2024',
      '{country} energy consulting engineering firms major players'
    ]
  },
  infrastructure: {
    name: 'Infrastructure & Ecosystem',
    queries: [
      '{country} LNG import terminal regasification capacity utilization',
      '{country} natural gas pipeline network infrastructure coverage',
      '{country} industrial zones estates economic corridors list',
      '{country} smart grid pilot projects energy management systems',
      '{country} power grid reliability transmission distribution quality',
      '{country} renewable energy infrastructure solar wind capacity'
    ]
  },
  partnershipOpportunities: {
    name: 'Partnership & Entry Opportunities',
    queries: [
      '{country} energy sector joint venture opportunities local partners',
      '{country} industrial companies seeking energy efficiency solutions',
      '{country} conglomerates energy subsidiary diversification',
      '{country} energy sector privatization opportunities upcoming',
      '{country} government energy projects tender bidding opportunities'
    ]
  }
};

// ============ SCOPE PARSER ============

async function parseScope(userPrompt) {
  console.log('\n=== STAGE 1: SCOPE PARSING ===');
  console.log('User prompt:', userPrompt);

  const systemPrompt = `You are a scope parser for market research requests. Extract structured parameters from the user's prompt.

Return a JSON object with these fields:
- projectType: "market_entry" | "competitive_analysis" | "market_sizing" | "other"
- industry: string (the industry/sector being researched)
- targetMarkets: string[] (list of countries/regions to analyze)
- clientContext: string (any context about the client making the request)
- focusAreas: string[] (specific aspects to emphasize)

If countries are vague like "Southeast Asia" or "SEA", expand to: ["Thailand", "Vietnam", "Indonesia", "Malaysia", "Philippines"]
If countries are vague like "ASEAN", expand to: ["Thailand", "Vietnam", "Indonesia", "Malaysia", "Philippines", "Singapore"]

Return ONLY valid JSON, no markdown or explanation.`;

  // Use lighter chat model for simple parsing task
  const result = await callDeepSeekChat(userPrompt, systemPrompt, 1024);

  try {
    // Clean up response - remove markdown code blocks if present
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    const scope = JSON.parse(jsonStr);
    console.log('Parsed scope:', JSON.stringify(scope, null, 2));
    return scope;
  } catch (error) {
    console.error('Failed to parse scope:', error.message);
    // Default fallback
    return {
      projectType: 'market_entry',
      industry: 'energy services',
      targetMarkets: ['Thailand', 'Vietnam', 'Malaysia', 'Philippines', 'Indonesia'],
      clientContext: 'Japanese company',
      focusAreas: ['market size', 'competition', 'regulations']
    };
  }
}

// ============ COUNTRY RESEARCH AGENT ============

async function researchCountry(country, industry, clientContext) {
  console.log(`\n=== RESEARCHING: ${country} ===`);
  const startTime = Date.now();

  const researchData = {};

  // Run all research queries
  for (const [sectionKey, section] of Object.entries(RESEARCH_FRAMEWORK)) {
    console.log(`  [${section.name}]`);
    const sectionData = [];

    for (const queryTemplate of section.queries) {
      const query = queryTemplate.replace(/{country}/g, country).replace(/{industry}/g, industry);
      console.log(`    Searching: ${query.substring(0, 60)}...`);

      const result = await callPerplexity(query);
      if (result.content) {
        sectionData.push({
          query,
          content: result.content,
          citations: result.citations
        });
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    researchData[sectionKey] = sectionData;
  }

  // Synthesize research into structured output using DeepSeek
  console.log(`  [Synthesizing ${country} data...]`);

  const synthesisPrompt = `You are a strategy consultant analyzing ${country} for a ${clientContext} considering entering the ${industry} market.

Based on the following research data, create a structured analysis. Be specific with numbers and cite sources.

RESEARCH DATA:
${JSON.stringify(researchData, null, 2)}

Return a JSON object with this structure:
{
  "country": "${country}",
  "macroContext": {
    "gdp": "value with year",
    "population": "value",
    "industrialGdpShare": "percentage",
    "energyIntensity": "description",
    "keyObservation": "one sentence"
  },
  "policyRegulatory": {
    "governmentStance": "supportive/neutral/restrictive with detail",
    "keyLegislation": ["list of relevant laws/policies"],
    "foreignOwnershipRules": "specific restrictions",
    "incentives": ["list of available incentives"],
    "regulatoryRisk": "low/medium/high with explanation"
  },
  "marketDynamics": {
    "marketSize": "value with year and growth rate",
    "demand": "description of demand drivers",
    "pricing": "electricity/gas prices with context",
    "supplyChain": "description of supply infrastructure"
  },
  "competitiveLandscape": {
    "localPlayers": [{"name": "...", "description": "..."}],
    "foreignPlayers": [{"name": "...", "description": "..."}],
    "entryBarriers": ["list of barriers"],
    "competitiveIntensity": "low/medium/high with explanation"
  },
  "infrastructure": {
    "energyInfrastructure": "description",
    "industrialZones": ["list of key zones"],
    "logisticsQuality": "description"
  },
  "summaryAssessment": {
    "opportunities": ["list of 3-5 key opportunities"],
    "obstacles": ["list of 3-5 key obstacles"],
    "attractivenessRating": "1-10 with justification",
    "feasibilityRating": "1-10 with justification",
    "keyInsight": "one paragraph with Data->Pattern->Mechanism->Implication structure"
  }
}

Return ONLY valid JSON, no markdown or explanation.`;

  const synthesis = await callDeepSeek(synthesisPrompt, '', 8192);

  try {
    let jsonStr = synthesis.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    const countryAnalysis = JSON.parse(jsonStr);
    countryAnalysis.researchTimeMs = Date.now() - startTime;
    console.log(`  Completed ${country} in ${countryAnalysis.researchTimeMs}ms`);
    return countryAnalysis;
  } catch (error) {
    console.error(`Failed to synthesize ${country}:`, error.message);
    return {
      country,
      error: 'Synthesis failed',
      rawData: researchData,
      researchTimeMs: Date.now() - startTime
    };
  }
}

// ============ SINGLE COUNTRY DEEP DIVE ============

async function synthesizeSingleCountry(countryAnalysis, scope) {
  console.log('\n=== STAGE 3: SINGLE COUNTRY DEEP DIVE ===');
  console.log(`Generating deep analysis for ${countryAnalysis.country}...`);

  const systemPrompt = `You are a senior strategy consultant at a top consulting firm. Your task is to generate a comprehensive market entry strategy for a single country.

Your analysis must follow the "Data → Pattern → Mechanism → Implication" framework for all insights:
- DATA: Specific observations from the research
- PATTERN: What emerges when you look across the data points
- MECHANISM: Why this pattern exists (causal explanation)
- IMPLICATION: What this means for the client's decision

Be specific. Avoid generic statements. Every insight should be actionable.`;

  const prompt = `Client context: ${scope.clientContext}
Industry: ${scope.industry}
Project type: ${scope.projectType}
Target market: ${countryAnalysis.country}

COUNTRY ANALYSIS:
${JSON.stringify(countryAnalysis, null, 2)}

Generate a comprehensive deep-dive analysis with:

1. EXECUTIVE SUMMARY (3-5 bullets highlighting the most critical findings)

2. MARKET OPPORTUNITY ASSESSMENT:
   - Total addressable market
   - Serviceable market
   - Growth trajectory and drivers
   - Timing considerations

3. COMPETITIVE POSITIONING:
   - Key players and their strengths/weaknesses
   - White spaces and opportunities
   - Potential partners vs competitors

4. REGULATORY PATHWAY:
   - Key regulations to navigate
   - Licensing requirements
   - Timeline and cost estimates
   - Risks and mitigation

5. ENTRY STRATEGY OPTIONS:
   - Option A: [Description with pros/cons]
   - Option B: [Description with pros/cons]
   - Option C: [Description with pros/cons]
   - Recommended option with rationale

6. KEY INSIGHTS (3-5 major insights using Data→Pattern→Mechanism→Implication)

7. IMPLEMENTATION ROADMAP:
   - Phase 1 (0-6 months): [actions]
   - Phase 2 (6-12 months): [actions]
   - Phase 3 (12-24 months): [actions]

8. RISK ASSESSMENT:
   - Critical risks with mitigation strategies
   - Go/No-Go criteria

9. NEXT STEPS (specific immediate actions)

Return as JSON with these sections as keys. Each insight must follow the Data→Pattern→Mechanism→Implication structure explicitly.`;

  const result = await callDeepSeek(prompt, systemPrompt, 12000);

  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    const synthesis = JSON.parse(jsonStr);
    synthesis.isSingleCountry = true;
    synthesis.country = countryAnalysis.country;
    return synthesis;
  } catch (error) {
    console.error('Failed to parse single country synthesis:', error.message);
    return {
      isSingleCountry: true,
      country: countryAnalysis.country,
      executiveSummary: ['Deep analysis parsing failed - raw content available'],
      rawContent: result.content
    };
  }
}

// ============ CROSS-COUNTRY SYNTHESIS ============

async function synthesizeFindings(countryAnalyses, scope) {
  // Handle single country differently - do deep dive instead of comparison
  const isSingleCountry = countryAnalyses.length === 1;

  if (isSingleCountry) {
    return synthesizeSingleCountry(countryAnalyses[0], scope);
  }

  console.log('\n=== STAGE 3: CROSS-COUNTRY SYNTHESIS ===');

  const systemPrompt = `You are a senior strategy consultant at a top consulting firm. Your task is to synthesize market research across multiple countries and generate strategic insights.

Your analysis must follow the "Data → Pattern → Mechanism → Implication" framework for all insights:
- DATA: Specific observations from the research
- PATTERN: What emerges when you look across countries/data points
- MECHANISM: Why this pattern exists (causal explanation)
- IMPLICATION: What this means for the client's decision

Be specific. Avoid generic statements. Every insight should be actionable.`;

  const prompt = `Client context: ${scope.clientContext}
Industry: ${scope.industry}
Project type: ${scope.projectType}

COUNTRY ANALYSES:
${JSON.stringify(countryAnalyses, null, 2)}

Generate a comprehensive synthesis with:

1. EXECUTIVE SUMMARY (3-5 bullets)
2. COUNTRY RANKING (with scores and rationale)
3. COMPARATIVE ANALYSIS:
   - Market size comparison
   - Regulatory environment comparison
   - Competitive intensity comparison
   - Infrastructure comparison
4. KEY INSIGHTS (3-5 major insights using Data→Pattern→Mechanism→Implication)
5. STRATEGIC RECOMMENDATIONS:
   - Recommended entry sequence
   - Entry mode recommendations by country
   - Risk mitigation strategies
6. NEXT STEPS (specific actions)

Return as JSON with these sections as keys. Each insight must follow the Data→Pattern→Mechanism→Implication structure explicitly.`;

  const result = await callDeepSeek(prompt, systemPrompt, 12000);

  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error('Failed to parse synthesis:', error.message);
    return {
      executiveSummary: ['Synthesis parsing failed - raw content available'],
      rawContent: result.content
    };
  }
}

// ============ PPT GENERATION ============

// Single country deep-dive PPT
async function generateSingleCountryPPT(synthesis, countryAnalysis, scope) {
  console.log(`Generating single-country PPT for ${synthesis.country}...`);

  const pptx = new pptxgen();
  pptx.author = 'Market Research AI';
  pptx.title = `${scope.industry} Market Entry - ${synthesis.country}`;
  pptx.subject = scope.projectType;

  const COLORS = {
    primary: '1a365d',
    secondary: '2c5282',
    accent: 'ed8936',
    text: '2d3748',
    lightBg: 'f7fafc',
    white: 'ffffff',
    green: '38a169',
    red: 'c53030'
  };

  function addSlide(title, subtitle = '') {
    const slide = pptx.addSlide();
    slide.addText(title, {
      x: 0.5, y: 0.3, w: 9, h: 0.5,
      fontSize: 24, bold: true, color: COLORS.primary
    });
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.5, y: 0.8, w: 9, h: 0.3,
        fontSize: 12, color: COLORS.secondary
      });
    }
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: 0.5, y: 7.2, w: 9, h: 0.02,
      fill: { color: COLORS.primary }
    });
    return slide;
  }

  // SLIDE 1: Title
  const titleSlide = pptx.addSlide();
  titleSlide.addText(synthesis.country.toUpperCase(), {
    x: 0.5, y: 1.8, w: 9, h: 0.8,
    fontSize: 42, bold: true, color: COLORS.primary
  });
  titleSlide.addText(`${scope.industry} Market Entry Analysis`, {
    x: 0.5, y: 2.7, w: 9, h: 0.5,
    fontSize: 24, color: COLORS.secondary
  });
  titleSlide.addText('Deep Dive Assessment', {
    x: 0.5, y: 3.3, w: 9, h: 0.4,
    fontSize: 16, color: COLORS.text
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5, y: 6.5, w: 9, h: 0.3,
    fontSize: 12, color: COLORS.text
  });

  // SLIDE 2: Executive Summary
  const execSlide = addSlide('Executive Summary');
  const execBullets = synthesis.executiveSummary || ['Analysis complete'];
  execSlide.addText(execBullets.map(b => ({ text: b, options: { bullet: true } })), {
    x: 0.5, y: 1.3, w: 9, h: 5.5,
    fontSize: 14, color: COLORS.text, valign: 'top'
  });

  // SLIDE 3: Market Opportunity
  const marketSlide = addSlide('Market Opportunity Assessment', synthesis.country);
  const marketOpp = synthesis.marketOpportunityAssessment || synthesis.marketOpportunity || {};
  const marketText = [
    `Total Addressable Market: ${marketOpp.totalAddressableMarket || marketOpp.tam || 'See analysis'}`,
    `Serviceable Market: ${marketOpp.serviceableMarket || marketOpp.sam || 'See analysis'}`,
    `Growth: ${marketOpp.growthTrajectory || marketOpp.growth || 'See analysis'}`,
    `Timing: ${marketOpp.timingConsiderations || marketOpp.timing || 'See analysis'}`
  ];
  marketSlide.addText(marketText.map(t => ({ text: t, options: { bullet: true } })), {
    x: 0.5, y: 1.3, w: 9, h: 5.5,
    fontSize: 13, color: COLORS.text, valign: 'top', lineSpacing: 24
  });

  // SLIDE 4: Competitive Landscape
  const compSlide = addSlide('Competitive Positioning', synthesis.country);
  const compPos = synthesis.competitivePositioning || synthesis.competitiveLandscape || {};

  compSlide.addText('Key Players', {
    x: 0.5, y: 1.3, w: 4, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.secondary
  });
  const players = compPos.keyPlayers || compPos.players || [];
  compSlide.addText((Array.isArray(players) ? players.slice(0, 5) : []).map(p => ({
    text: typeof p === 'string' ? p : `${p.name}: ${p.strengths || p.description || ''}`,
    options: { bullet: true }
  })), {
    x: 0.5, y: 1.7, w: 4.2, h: 2.5,
    fontSize: 10, color: COLORS.text, valign: 'top'
  });

  compSlide.addText('White Spaces & Opportunities', {
    x: 5, y: 1.3, w: 4.5, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.green
  });
  const whiteSpaces = compPos.whiteSpaces || compPos.opportunities || [];
  compSlide.addText((Array.isArray(whiteSpaces) ? whiteSpaces.slice(0, 4) : []).map(w => ({
    text: typeof w === 'string' ? w : w.description || w.opportunity,
    options: { bullet: true }
  })), {
    x: 5, y: 1.7, w: 4.5, h: 2.5,
    fontSize: 10, color: COLORS.text, valign: 'top'
  });

  compSlide.addText('Potential Partners', {
    x: 0.5, y: 4.5, w: 9, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.accent
  });
  const partners = compPos.potentialPartners || compPos.partners || [];
  compSlide.addText((Array.isArray(partners) ? partners.slice(0, 3) : []).map(p => ({
    text: typeof p === 'string' ? p : `${p.name}: ${p.rationale || p.description || ''}`,
    options: { bullet: true }
  })), {
    x: 0.5, y: 4.9, w: 9, h: 2,
    fontSize: 10, color: COLORS.text, valign: 'top'
  });

  // SLIDE 5: Regulatory Pathway
  const regSlide = addSlide('Regulatory Pathway', synthesis.country);
  const regulatory = synthesis.regulatoryPathway || synthesis.regulatory || {};

  const regText = [
    `Key Regulations: ${regulatory.keyRegulations || 'See analysis'}`,
    `Licensing: ${regulatory.licensingRequirements || regulatory.licensing || 'See analysis'}`,
    `Timeline: ${regulatory.timeline || regulatory.timelineEstimate || 'See analysis'}`,
    `Risks: ${regulatory.risks || 'See analysis'}`
  ];
  regSlide.addText(regText.map(t => ({ text: t, options: { bullet: true } })), {
    x: 0.5, y: 1.3, w: 9, h: 5.5,
    fontSize: 12, color: COLORS.text, valign: 'top', lineSpacing: 28
  });

  // SLIDE 6: Entry Strategy Options
  const stratSlide = addSlide('Entry Strategy Options', synthesis.country);
  const entryOpts = synthesis.entryStrategyOptions || synthesis.entryOptions || {};

  let yPos = 1.3;
  ['optionA', 'optionB', 'optionC', 'A', 'B', 'C'].forEach(key => {
    const opt = entryOpts[key] || entryOpts[`option${key}`];
    if (opt && yPos < 5.5) {
      const optText = typeof opt === 'string' ? opt :
        `${opt.name || opt.title || key}: ${opt.description || ''}\nPros: ${opt.pros || 'N/A'} | Cons: ${opt.cons || 'N/A'}`;
      stratSlide.addText(optText, {
        x: 0.5, y: yPos, w: 9, h: 1.3,
        fontSize: 11, color: COLORS.text, valign: 'top'
      });
      yPos += 1.5;
    }
  });

  const recommended = entryOpts.recommendedOption || entryOpts.recommendation;
  if (recommended) {
    stratSlide.addText(`Recommended: ${typeof recommended === 'string' ? recommended : recommended.option || JSON.stringify(recommended)}`, {
      x: 0.5, y: 6, w: 9, h: 0.8,
      fontSize: 12, bold: true, color: COLORS.accent, valign: 'top'
    });
  }

  // SLIDE 7: Key Insights
  const insightSlide = addSlide('Key Strategic Insights');
  const insights = synthesis.keyInsights || [];
  let insightY = 1.3;
  (Array.isArray(insights) ? insights.slice(0, 3) : []).forEach((insight, idx) => {
    const text = typeof insight === 'string' ? insight :
      `${insight.pattern || insight.title || 'Insight ' + (idx + 1)}\n→ ${insight.implication || insight.description || ''}`;
    insightSlide.addText(`${idx + 1}. ${text}`, {
      x: 0.5, y: insightY, w: 9, h: 1.8,
      fontSize: 11, color: COLORS.text, valign: 'top'
    });
    insightY += 1.9;
  });

  // SLIDE 8: Implementation Roadmap
  const roadmapSlide = addSlide('Implementation Roadmap', synthesis.country);
  const roadmap = synthesis.implementationRoadmap || synthesis.roadmap || {};

  const phases = [
    { key: 'phase1', label: 'Phase 1 (0-6 months)', color: COLORS.secondary },
    { key: 'phase2', label: 'Phase 2 (6-12 months)', color: COLORS.accent },
    { key: 'phase3', label: 'Phase 3 (12-24 months)', color: COLORS.green }
  ];

  let phaseY = 1.3;
  phases.forEach(phase => {
    const actions = roadmap[phase.key] || roadmap[phase.label] || [];
    roadmapSlide.addText(phase.label, {
      x: 0.5, y: phaseY, w: 9, h: 0.3,
      fontSize: 13, bold: true, color: phase.color
    });
    const actionText = Array.isArray(actions) ? actions.join(', ') : String(actions);
    roadmapSlide.addText(actionText, {
      x: 0.5, y: phaseY + 0.35, w: 9, h: 1.2,
      fontSize: 10, color: COLORS.text, valign: 'top'
    });
    phaseY += 1.7;
  });

  // SLIDE 9: Risks
  const riskSlide = addSlide('Risk Assessment', synthesis.country);
  const riskAssess = synthesis.riskAssessment || synthesis.risks || {};
  const criticalRisks = riskAssess.criticalRisks || riskAssess.risks || [];
  const goNoGo = riskAssess.goNoGoCriteria || riskAssess.goNoGo || [];

  riskSlide.addText('Critical Risks', {
    x: 0.5, y: 1.3, w: 9, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.red
  });
  riskSlide.addText((Array.isArray(criticalRisks) ? criticalRisks.slice(0, 5) : []).map(r => ({
    text: typeof r === 'string' ? r : `${r.risk || r.name}: ${r.mitigation || ''}`,
    options: { bullet: true }
  })), {
    x: 0.5, y: 1.7, w: 9, h: 2.5,
    fontSize: 11, color: COLORS.text, valign: 'top'
  });

  riskSlide.addText('Go/No-Go Criteria', {
    x: 0.5, y: 4.5, w: 9, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.secondary
  });
  riskSlide.addText((Array.isArray(goNoGo) ? goNoGo.slice(0, 4) : []).map(g => ({
    text: typeof g === 'string' ? g : g.criteria || g.description,
    options: { bullet: true }
  })), {
    x: 0.5, y: 4.9, w: 9, h: 2,
    fontSize: 11, color: COLORS.text, valign: 'top'
  });

  // SLIDE 10: Next Steps
  const nextSlide = addSlide('Next Steps');
  const nextSteps = synthesis.nextSteps || [
    'Validate findings with in-country experts',
    'Conduct detailed partner identification',
    'Develop financial model',
    'Schedule market visit'
  ];
  nextSlide.addText((Array.isArray(nextSteps) ? nextSteps : [nextSteps]).map((step, idx) => ({
    text: `${idx + 1}. ${typeof step === 'string' ? step : step.action || step.description}`,
    options: { bullet: false }
  })), {
    x: 0.5, y: 1.3, w: 9, h: 5,
    fontSize: 14, color: COLORS.text, valign: 'top', lineSpacing: 28
  });

  // SLIDE 11: Methodology
  const methodSlide = addSlide('Research Methodology & Cost');
  methodSlide.addText([
    { text: 'Methodology', options: { bold: true, fontSize: 14 } },
    { text: '\n\nThis deep-dive analysis was generated using AI-powered research:', options: { fontSize: 11 } },
    { text: '\n• 15+ targeted web searches using Perplexity AI', options: { bullet: false, fontSize: 11 } },
    { text: '\n• Deep analysis using DeepSeek thinking model', options: { bullet: false, fontSize: 11 } },
    { text: '\n• Strategy consulting frameworks for insight generation', options: { bullet: false, fontSize: 11 } },
    { text: `\n\nTotal research cost: $${costTracker.totalCost.toFixed(2)}`, options: { fontSize: 11, bold: true } },
    { text: `\nGenerated: ${new Date().toISOString()}`, options: { fontSize: 11 } }
  ], {
    x: 0.5, y: 1.3, w: 9, h: 5,
    color: COLORS.text, valign: 'top'
  });

  const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
  console.log(`Single-country PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB`);
  return pptxBuffer;
}

// Multi-country comparison PPT
async function generatePPT(synthesis, countryAnalyses, scope) {
  console.log('\n=== STAGE 4: PPT GENERATION ===');

  // Route to single-country PPT if applicable
  if (synthesis.isSingleCountry) {
    return generateSingleCountryPPT(synthesis, countryAnalyses[0], scope);
  }

  const pptx = new pptxgen();

  // Set presentation properties
  pptx.author = 'Market Research AI';
  pptx.title = `${scope.industry} Market Analysis - ${scope.targetMarkets.join(', ')}`;
  pptx.subject = scope.projectType;

  // Define colors
  const COLORS = {
    primary: '1a365d',      // Dark blue
    secondary: '2c5282',    // Medium blue
    accent: 'ed8936',       // Orange
    text: '2d3748',         // Dark gray
    lightBg: 'f7fafc',      // Light gray
    white: 'ffffff'
  };

  // Helper function to add slide with consistent styling
  function addSlide(title, subtitle = '') {
    const slide = pptx.addSlide();

    // Title
    slide.addText(title, {
      x: 0.5, y: 0.3, w: 9, h: 0.5,
      fontSize: 24, bold: true, color: COLORS.primary
    });

    // Subtitle
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.5, y: 0.8, w: 9, h: 0.3,
        fontSize: 12, color: COLORS.secondary
      });
    }

    // Footer line
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: 0.5, y: 7.2, w: 9, h: 0.02,
      fill: { color: COLORS.primary }
    });

    return slide;
  }

  // SLIDE 1: Title Slide
  const titleSlide = pptx.addSlide();
  titleSlide.addText(scope.industry.toUpperCase(), {
    x: 0.5, y: 2, w: 9, h: 0.8,
    fontSize: 36, bold: true, color: COLORS.primary
  });
  titleSlide.addText('Market Entry Analysis', {
    x: 0.5, y: 2.8, w: 9, h: 0.5,
    fontSize: 24, color: COLORS.secondary
  });
  titleSlide.addText(scope.targetMarkets.join(' | '), {
    x: 0.5, y: 3.5, w: 9, h: 0.4,
    fontSize: 16, color: COLORS.text
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5, y: 6.5, w: 9, h: 0.3,
    fontSize: 12, color: COLORS.text
  });

  // SLIDE 2: Executive Summary
  const execSlide = addSlide('Executive Summary');
  const execBullets = synthesis.executiveSummary || ['Analysis complete'];
  execSlide.addText(execBullets.map(b => ({ text: b, options: { bullet: true } })), {
    x: 0.5, y: 1.3, w: 9, h: 5,
    fontSize: 14, color: COLORS.text, valign: 'top'
  });

  // SLIDE 3: Country Ranking
  const rankSlide = addSlide('Country Ranking', 'Overall market attractiveness assessment');

  // Create ranking table
  const rankingData = synthesis.countryRanking || countryAnalyses.map(c => ({
    country: c.country,
    attractiveness: c.summaryAssessment?.attractivenessRating || 'N/A',
    feasibility: c.summaryAssessment?.feasibilityRating || 'N/A'
  }));

  const rankRows = [
    [
      { text: 'Country', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Attractiveness', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Feasibility', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Rationale', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } }
    ]
  ];

  (Array.isArray(rankingData) ? rankingData : []).forEach(r => {
    rankRows.push([
      { text: r.country || 'Unknown' },
      { text: String(r.attractiveness || r.score || 'N/A') },
      { text: String(r.feasibility || 'N/A') },
      { text: (r.rationale || '').substring(0, 60) + '...' }
    ]);
  });

  rankSlide.addTable(rankRows, {
    x: 0.5, y: 1.5, w: 9,
    fontSize: 11,
    border: { pt: 0.5, color: COLORS.text },
    colW: [1.5, 1.5, 1.5, 4.5]
  });

  // SLIDES 4+: Individual Country Analysis
  for (const country of countryAnalyses) {
    if (country.error) continue;

    const countrySlide = addSlide(country.country, 'Market Assessment');

    // Left column: Key metrics
    const metrics = [
      `GDP: ${country.macroContext?.gdp || 'N/A'}`,
      `Population: ${country.macroContext?.population || 'N/A'}`,
      `Market Size: ${country.marketDynamics?.marketSize || 'N/A'}`,
      `Regulatory Risk: ${country.policyRegulatory?.regulatoryRisk || 'N/A'}`,
      `Competitive Intensity: ${country.competitiveLandscape?.competitiveIntensity || 'N/A'}`
    ];

    countrySlide.addText('Key Metrics', {
      x: 0.5, y: 1.3, w: 4, h: 0.3,
      fontSize: 14, bold: true, color: COLORS.secondary
    });

    countrySlide.addText(metrics.map(m => ({ text: m, options: { bullet: true } })), {
      x: 0.5, y: 1.7, w: 4, h: 2.5,
      fontSize: 11, color: COLORS.text, valign: 'top'
    });

    // Right column: Opportunities and Obstacles
    countrySlide.addText('Opportunities', {
      x: 5, y: 1.3, w: 4.5, h: 0.3,
      fontSize: 14, bold: true, color: '38a169'
    });

    const opps = country.summaryAssessment?.opportunities || [];
    countrySlide.addText(opps.slice(0, 3).map(o => ({ text: o, options: { bullet: true } })), {
      x: 5, y: 1.7, w: 4.5, h: 1.5,
      fontSize: 10, color: COLORS.text, valign: 'top'
    });

    countrySlide.addText('Obstacles', {
      x: 5, y: 3.3, w: 4.5, h: 0.3,
      fontSize: 14, bold: true, color: 'c53030'
    });

    const obs = country.summaryAssessment?.obstacles || [];
    countrySlide.addText(obs.slice(0, 3).map(o => ({ text: o, options: { bullet: true } })), {
      x: 5, y: 3.7, w: 4.5, h: 1.5,
      fontSize: 10, color: COLORS.text, valign: 'top'
    });

    // Key Insight
    countrySlide.addText('Key Insight', {
      x: 0.5, y: 5.3, w: 9, h: 0.3,
      fontSize: 14, bold: true, color: COLORS.accent
    });

    countrySlide.addText(country.summaryAssessment?.keyInsight || 'Analysis pending', {
      x: 0.5, y: 5.7, w: 9, h: 1.3,
      fontSize: 11, color: COLORS.text, valign: 'top'
    });

    // Ratings
    countrySlide.addText(
      `Attractiveness: ${country.summaryAssessment?.attractivenessRating || 'N/A'}/10  |  Feasibility: ${country.summaryAssessment?.feasibilityRating || 'N/A'}/10`,
      {
        x: 0.5, y: 7, w: 9, h: 0.2,
        fontSize: 10, bold: true, color: COLORS.primary
      }
    );
  }

  // SLIDE: Key Insights
  const insightSlide = addSlide('Key Strategic Insights');
  const insights = synthesis.keyInsights || synthesis.strategicRecommendations?.keyInsights || [];

  let yPos = 1.3;
  (Array.isArray(insights) ? insights.slice(0, 3) : []).forEach((insight, idx) => {
    const insightText = typeof insight === 'string' ? insight :
      `${insight.pattern || insight.title || 'Insight ' + (idx + 1)}\n${insight.implication || insight.description || ''}`;

    insightSlide.addText(`${idx + 1}. ${insightText}`, {
      x: 0.5, y: yPos, w: 9, h: 1.5,
      fontSize: 11, color: COLORS.text, valign: 'top'
    });
    yPos += 1.8;
  });

  // SLIDE: Recommendations
  const recoSlide = addSlide('Strategic Recommendations');
  const recommendations = synthesis.strategicRecommendations || synthesis.recommendations || {};

  // Entry sequence
  recoSlide.addText('Recommended Entry Sequence', {
    x: 0.5, y: 1.3, w: 9, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.secondary
  });

  const entrySeq = recommendations.entrySequence || recommendations.recommendedEntrySequence ||
    countryAnalyses.map(c => c.country).join(' → ');
  recoSlide.addText(typeof entrySeq === 'string' ? entrySeq : entrySeq.join(' → '), {
    x: 0.5, y: 1.7, w: 9, h: 0.4,
    fontSize: 12, color: COLORS.text
  });

  // Entry mode recommendations
  recoSlide.addText('Entry Mode by Country', {
    x: 0.5, y: 2.3, w: 9, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.secondary
  });

  const entryModes = recommendations.entryModeRecommendations || recommendations.entryModes || [];
  const modeText = Array.isArray(entryModes) ?
    entryModes.map(m => typeof m === 'string' ? m : `${m.country}: ${m.mode || m.recommendation}`).join('\n') :
    JSON.stringify(entryModes);

  recoSlide.addText(modeText, {
    x: 0.5, y: 2.7, w: 9, h: 2,
    fontSize: 11, color: COLORS.text, valign: 'top'
  });

  // Risk mitigation
  recoSlide.addText('Risk Mitigation', {
    x: 0.5, y: 5, w: 9, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.secondary
  });

  const risks = recommendations.riskMitigation || recommendations.riskMitigationStrategies || [];
  recoSlide.addText((Array.isArray(risks) ? risks.slice(0, 4) : []).map(r => ({
    text: typeof r === 'string' ? r : r.strategy || r.description,
    options: { bullet: true }
  })), {
    x: 0.5, y: 5.4, w: 9, h: 1.5,
    fontSize: 10, color: COLORS.text, valign: 'top'
  });

  // SLIDE: Next Steps
  const nextSlide = addSlide('Next Steps');
  const nextSteps = synthesis.nextSteps || synthesis.recommendations?.nextSteps || [
    'Validate findings with in-country experts',
    'Conduct detailed partner identification',
    'Develop financial model for priority market',
    'Schedule market visit'
  ];

  nextSlide.addText((Array.isArray(nextSteps) ? nextSteps : [nextSteps]).map((step, idx) => ({
    text: `${idx + 1}. ${typeof step === 'string' ? step : step.action || step.description}`,
    options: { bullet: false }
  })), {
    x: 0.5, y: 1.3, w: 9, h: 5,
    fontSize: 14, color: COLORS.text, valign: 'top', lineSpacing: 28
  });

  // SLIDE: Cost Summary
  const costSlide = addSlide('Research Methodology & Cost');
  costSlide.addText([
    { text: 'Methodology', options: { bold: true, fontSize: 14 } },
    { text: '\n\nThis analysis was generated using AI-powered research agents that:', options: { fontSize: 11 } },
    { text: '\n• Searched 50+ web sources per country using Perplexity AI', options: { bullet: false, fontSize: 11 } },
    { text: '\n• Synthesized findings using DeepSeek deep-thinking model', options: { bullet: false, fontSize: 11 } },
    { text: '\n• Applied strategy consulting frameworks for insight generation', options: { bullet: false, fontSize: 11 } },
    { text: `\n\nTotal research cost: $${costTracker.totalCost.toFixed(2)}`, options: { fontSize: 11, bold: true } },
    { text: `\nCountries analyzed: ${countryAnalyses.length}`, options: { fontSize: 11 } },
    { text: `\nGenerated: ${new Date().toISOString()}`, options: { fontSize: 11 } }
  ], {
    x: 0.5, y: 1.3, w: 9, h: 5,
    color: COLORS.text, valign: 'top'
  });

  // Generate file
  const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
  console.log(`PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB`);

  return pptxBuffer;
}

// ============ EMAIL DELIVERY ============

async function sendEmail(to, subject, html, attachment) {
  console.log('\n=== STAGE 5: EMAIL DELIVERY ===');
  console.log(`Sending to: ${to}`);

  const emailData = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: process.env.SENDER_EMAIL, name: 'Market Research AI' },
    subject: subject,
    content: [{ type: 'text/html', value: html }],
    attachments: [{
      filename: attachment.filename,
      content: attachment.content,
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      disposition: 'attachment'
    }]
  };

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailData)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Email failed: ${error}`);
  }

  console.log('Email sent successfully');
  return { success: true };
}

// ============ MAIN ORCHESTRATOR ============

async function runMarketResearch(userPrompt, email) {
  const startTime = Date.now();
  console.log('\n========================================');
  console.log('MARKET RESEARCH - START');
  console.log('========================================');
  console.log('Time:', new Date().toISOString());
  console.log('Email:', email);

  // Reset cost tracker
  costTracker.totalCost = 0;
  costTracker.calls = [];

  try {
    // Stage 1: Parse scope
    const scope = await parseScope(userPrompt);

    // Stage 2: Research each country (in parallel with limit)
    console.log('\n=== STAGE 2: COUNTRY RESEARCH ===');
    console.log(`Researching ${scope.targetMarkets.length} countries...`);

    const countryAnalyses = [];

    // Process countries in batches of 2 to manage API rate limits
    for (let i = 0; i < scope.targetMarkets.length; i += 2) {
      const batch = scope.targetMarkets.slice(i, i + 2);
      const batchResults = await Promise.all(
        batch.map(country => researchCountry(country, scope.industry, scope.clientContext))
      );
      countryAnalyses.push(...batchResults);
    }

    // Stage 3: Synthesize findings
    const synthesis = await synthesizeFindings(countryAnalyses, scope);

    // Stage 4: Generate PPT
    const pptBuffer = await generatePPT(synthesis, countryAnalyses, scope);

    // Stage 5: Send email
    const filename = `Market_Research_${scope.industry.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pptx`;

    const emailHtml = `
      <h2>Market Research Complete</h2>
      <p>Your market research analysis is attached.</p>
      <h3>Summary</h3>
      <ul>
        <li><strong>Industry:</strong> ${scope.industry}</li>
        <li><strong>Markets Analyzed:</strong> ${scope.targetMarkets.join(', ')}</li>
        <li><strong>Research Cost:</strong> $${costTracker.totalCost.toFixed(2)}</li>
        <li><strong>Processing Time:</strong> ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes</li>
      </ul>
      <h3>Executive Summary</h3>
      <ul>
        ${(synthesis.executiveSummary || []).map(s => `<li>${s}</li>`).join('')}
      </ul>
      <p style="color: #666; font-size: 12px;">Generated by Market Research AI</p>
    `;

    await sendEmail(email, `Market Research: ${scope.industry} - ${scope.targetMarkets.join(', ')}`, emailHtml, {
      filename,
      content: pptBuffer.toString('base64')
    });

    const totalTime = (Date.now() - startTime) / 1000;
    console.log('\n========================================');
    console.log('MARKET RESEARCH - COMPLETE');
    console.log('========================================');
    console.log(`Total time: ${totalTime.toFixed(0)} seconds (${(totalTime / 60).toFixed(1)} minutes)`);
    console.log(`Total cost: $${costTracker.totalCost.toFixed(2)}`);
    console.log(`Countries analyzed: ${countryAnalyses.length}`);

    return {
      success: true,
      scope,
      countriesAnalyzed: countryAnalyses.length,
      totalCost: costTracker.totalCost,
      totalTimeSeconds: totalTime
    };

  } catch (error) {
    console.error('Market research failed:', error);

    // Try to send error email
    try {
      await sendEmail(email, 'Market Research Failed', `
        <h2>Market Research Error</h2>
        <p>Your market research request encountered an error:</p>
        <pre>${error.message}</pre>
        <p>Please try again or contact support.</p>
      `, { filename: 'error.txt', content: Buffer.from(error.stack || error.message).toString('base64') });
    } catch (emailError) {
      console.error('Failed to send error email:', emailError);
    }

    throw error;
  }
}

// ============ API ENDPOINTS ============

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'market-research',
    timestamp: new Date().toISOString(),
    costToday: costTracker.totalCost
  });
});

// Main research endpoint
app.post('/api/market-research', async (req, res) => {
  const { prompt, email } = req.body;

  if (!prompt || !email) {
    return res.status(400).json({ error: 'Missing required fields: prompt, email' });
  }

  // Respond immediately - research runs in background
  res.json({
    success: true,
    message: 'Market research started. Results will be emailed when complete.',
    estimatedTime: '30-60 minutes'
  });

  // Run research in background
  runMarketResearch(prompt, email).catch(error => {
    console.error('Background research failed:', error);
  });
});

// Cost tracking endpoint
app.get('/api/costs', (req, res) => {
  res.json(costTracker);
});

// ============ START SERVER ============

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`Market Research server running on port ${PORT}`);
  console.log('Environment check:');
  console.log('  - DEEPSEEK_API_KEY:', process.env.DEEPSEEK_API_KEY ? 'Set' : 'MISSING');
  console.log('  - PERPLEXITY_API_KEY:', process.env.PERPLEXITY_API_KEY ? 'Set' : 'MISSING');
  console.log('  - SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'Set' : 'MISSING');
  console.log('  - SENDER_EMAIL:', process.env.SENDER_EMAIL || 'MISSING');
});
