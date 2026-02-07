// Redeploy trigger: 2026-02-05
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { securityHeaders, rateLimiter } = require('./shared/security');
const { requestLogger, healthCheck } = require('./shared/middleware');
const { setupGlobalErrorHandlers } = require('./shared/logging');
const { createTracker, trackingContext } = require('./shared/tracking');

// Extracted modules
const { costTracker, callKimiDeepResearch } = require('./ai-clients');
const { parseScope } = require('./research-framework');
const { researchCountry, synthesizeFindings } = require('./research-orchestrator');
const { generatePPT } = require('./ppt-multi-country');
const { validateResearchQuality, validateSynthesisQuality } = require('./quality-gates');

// Setup global error handlers to prevent crashes
setupGlobalErrorHandlers({ logMemory: false });

// ============ EXPRESS SETUP ============
const app = express();
app.set('trust proxy', 1); // Trust Railway's reverse proxy for rate limiting
app.use(securityHeaders);
app.use(rateLimiter);
app.use(cors());
app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));

// Check required environment variables
const requiredEnvVars = ['KIMI_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}

// ============ EMAIL DELIVERY ============
// Fix 4: Use shared sendEmail with 3 retries + exponential backoff (was inline with zero retries)
const { sendEmail } = require('./shared/email.js');

// Pipeline diagnostics — stored after each run, exposed via /api/diagnostics
let lastRunDiagnostics = null;

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

  const tracker = createTracker('market-research', email, { prompt: userPrompt.substring(0, 200) });

  return trackingContext.run(tracker, async () => {
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
        const batchResults = await Promise.allSettled(
          batch.map((country) =>
            researchCountry(country, scope.industry, scope.clientContext, scope)
          )
        );
        const successResults = batchResults
          .filter((r) => r.status === 'fulfilled')
          .map((r) => r.value);
        const failedCountries = batchResults
          .filter((r) => r.status === 'rejected')
          .map((r, i) => ({ country: batch[i], error: r.reason.message }));
        if (failedCountries.length) console.error('Failed countries:', failedCountries);
        countryAnalyses.push(...successResults);
      }

      // Quality Gate 1: Validate research quality per country and retry weak topics
      for (const ca of countryAnalyses) {
        if (!ca.rawData) continue;
        const researchGate = validateResearchQuality(ca.rawData);
        console.log(
          '[Quality Gate] Research for',
          ca.country + ':',
          JSON.stringify({
            pass: researchGate.pass,
            score: researchGate.score,
            issues: researchGate.issues,
          })
        );
        if (!researchGate.pass && researchGate.retryTopics.length > 0) {
          console.log(
            '[Quality Gate] Retrying',
            researchGate.retryTopics.length,
            'weak topics for',
            ca.country + '...'
          );
          for (const topic of researchGate.retryTopics.slice(0, 5)) {
            try {
              const queryMap = {
                market_tpes: `${ca.country} total primary energy supply statistics and trends`,
                market_finalDemand: `${ca.country} final energy demand by sector`,
                market_electricity: `${ca.country} electricity generation mix and capacity`,
                market_gasLng: `${ca.country} natural gas and LNG market`,
                market_pricing: `${ca.country} energy pricing and tariffs`,
                policy_regulatory: `${ca.country} energy regulatory framework`,
                policy_incentives: `${ca.country} energy incentives and subsidies`,
                competitors_players: `${ca.country} major energy companies and players`,
              };
              const retryQuery =
                queryMap[topic] || `${ca.country} ${scope.industry} ${topic.replace(/_/g, ' ')}`;
              const retry = await callKimiDeepResearch(
                retryQuery + ' provide specific statistics and company names',
                ca.country,
                scope.industry
              );
              if (retry && retry.content && retry.content.length > 200) {
                ca.rawData[topic] = {
                  ...ca.rawData[topic],
                  content: retry.content,
                  citations: retry.citations || ca.rawData[topic].citations,
                  researchQuality: retry.researchQuality || 'retried',
                };
              }
            } catch (e) {
              console.warn('[Quality Gate] Retry failed for topic:', topic, e.message);
            }
          }
        }
      }

      // Collect pipeline diagnostics for each country
      lastRunDiagnostics = {
        timestamp: new Date().toISOString(),
        industry: scope.industry,
        countries: countryAnalyses.map((ca) => ({
          country: ca.country,
          error: ca.error || null,
          researchTopicCount: ca.rawData ? Object.keys(ca.rawData).length : 0,
          researchTopicChars: ca.rawData
            ? Object.fromEntries(
                Object.entries(ca.rawData).map(([k, v]) => [k, v?.content?.length || 0])
              )
            : {},
          synthesisScores: ca.contentValidation?.scores || null,
          synthesisFailures: ca.contentValidation?.failures || [],
          synthesisValid: ca.contentValidation?.valid ?? null,
          failedSections: ['policy', 'market', 'competitors'].filter((s) => ca[s]?._synthesisError),
        })),
        totalCost: costTracker.totalCost,
        apiCalls: costTracker.calls.length,
        stage: 'complete',
      };

      // Preserve citations, then clean up rawData to free memory
      for (const ca of countryAnalyses) {
        if (ca.rawData) {
          ca.citations = Object.values(ca.rawData)
            .flatMap((v) => v?.citations || [])
            .filter(Boolean);
          delete ca.rawData;
        }
      }

      // Stage 3: Synthesize findings
      const synthesis = await synthesizeFindings(countryAnalyses, scope);

      // Quality Gate 2: Validate synthesis quality
      const synthesisGate = validateSynthesisQuality(synthesis);
      console.log(
        '[Quality Gate] Synthesis:',
        JSON.stringify({
          pass: synthesisGate.pass,
          overall: synthesisGate.overall,
          failures: synthesisGate.failures,
        })
      );
      if (!synthesisGate.pass) {
        if (synthesisGate.overall < 20) {
          throw new Error(`Synthesis quality too low (${synthesisGate.overall}/100). Aborting.`);
        }
        console.warn(
          `[Quality Gate] Synthesis score ${synthesisGate.overall}/100 - below pass threshold but above abort threshold. Proceeding with caution.`
        );
      }

      // Stage 4: Generate PPT
      const pptBuffer = await generatePPT(synthesis, countryAnalyses, scope);

      // Stage 5: Send email
      const filename = `Market_Research_${scope.industry.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pptx`;

      const emailHtml = `
      <p>Your market research report is attached.</p>
      <p style="color: #666; font-size: 12px;">${scope.industry} - ${scope.targetMarkets.join(', ')}</p>
    `;

      await sendEmail({
        to: email,
        subject: `Market Research: ${scope.industry} - ${scope.targetMarkets.join(', ')}`,
        html: emailHtml,
        attachments: {
          filename,
          content: pptBuffer.toString('base64'),
        },
        fromName: 'Market Research AI',
      });

      const totalTime = (Date.now() - startTime) / 1000;
      console.log('\n========================================');
      console.log('MARKET RESEARCH - COMPLETE');
      console.log('========================================');
      console.log(
        `Total time: ${totalTime.toFixed(0)} seconds (${(totalTime / 60).toFixed(1)} minutes)`
      );
      console.log(`Total cost: $${costTracker.totalCost.toFixed(2)}`);
      console.log(`Countries analyzed: ${countryAnalyses.length}`);

      // Estimate costs from internal costTracker by aggregating per model
      const modelTokens = {};
      for (const call of costTracker.calls) {
        if (!modelTokens[call.model]) {
          modelTokens[call.model] = { input: 0, output: 0 };
        }
        modelTokens[call.model].input += call.inputTokens || 0;
        modelTokens[call.model].output += call.outputTokens || 0;
      }
      // Add model calls to shared tracker (pass numeric token counts directly)
      for (const [model, tokens] of Object.entries(modelTokens)) {
        tracker.addModelCall(model, tokens.input, tokens.output);
      }

      // Track usage
      await tracker.finish({
        countriesAnalyzed: countryAnalyses.length,
        industry: scope.industry,
      });

      return {
        success: true,
        scope,
        countriesAnalyzed: countryAnalyses.length,
        totalCost: costTracker.totalCost,
        totalTimeSeconds: totalTime,
      };
    } catch (error) {
      console.error('Market research failed:', error);
      lastRunDiagnostics = {
        timestamp: new Date().toISOString(),
        stage: 'error',
        error: error.message,
      };
      await tracker.finish({ status: 'error', error: error.message }).catch(() => {});

      // Try to send error email
      try {
        await sendEmail({
          to: email,
          subject: 'Market Research Failed',
          html: `
        <h2>Market Research Error</h2>
        <p>Your market research request encountered an error:</p>
        <pre>${error.message}</pre>
        <p>Please try again or contact support.</p>
      `,
          attachments: {
            filename: 'error.txt',
            content: Buffer.from(error.message).toString('base64'),
          },
          fromName: 'Market Research AI',
        });
      } catch (emailError) {
        console.error('Failed to send error email:', emailError);
      }

      throw error;
    }
  }); // end trackingContext.run
}

// ============ API ENDPOINTS ============

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'market-research',
    timestamp: new Date().toISOString(),
    costToday: costTracker.totalCost,
  });
});

// ============ HEALTH CHECK ============
app.get('/health', healthCheck('market-research'));

// Main research endpoint
app.post('/api/market-research', async (req, res) => {
  const { prompt, email } = req.body;

  if (!prompt || !email) {
    return res.status(400).json({ error: 'Missing required fields: prompt, email' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  // Respond immediately - research runs in background
  res.json({
    success: true,
    message: 'Market research started. Results will be emailed when complete.',
    estimatedTime: '30-60 minutes',
  });

  // Run research in background
  runMarketResearch(prompt, email).catch((error) => {
    console.error('Background research failed:', error);
  });
});

// Cost tracking endpoint
app.get('/api/costs', (req, res) => {
  res.json(costTracker);
});

// Pipeline diagnostics endpoint
app.get('/api/diagnostics', (req, res) => {
  if (!lastRunDiagnostics) {
    return res.json({ available: false, message: 'No completed run yet' });
  }
  res.json({ available: true, ...lastRunDiagnostics });
});

// ============ START SERVER ============

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`Market Research server running on port ${PORT}`);
  console.log('Environment check:');
  console.log('  - KIMI_API_KEY:', process.env.KIMI_API_KEY ? 'Set' : 'MISSING');
  console.log(
    '  - KIMI_API_BASE:',
    process.env.KIMI_API_BASE || 'https://api.moonshot.ai/v1 (default)'
  );
  console.log('  - PERPLEXITY_API_KEY:', process.env.PERPLEXITY_API_KEY ? 'Set' : 'MISSING');
  console.log('  - SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'Set' : 'MISSING');
  console.log('  - SENDER_EMAIL:', process.env.SENDER_EMAIL || 'MISSING');
});
