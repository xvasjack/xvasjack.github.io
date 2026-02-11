// Redeploy trigger: 2026-02-05
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { securityHeaders, rateLimiter, escapeHtml } = require('./shared/security');
const { requestLogger, healthCheck } = require('./shared/middleware');
const { setupGlobalErrorHandlers } = require('./shared/logging');
const { createTracker, trackingContext } = require('./shared/tracking');

// Extracted modules
const { costTracker, callGeminiResearch, resetBudget } = require('./ai-clients');
const { parseScope } = require('./research-framework');
const { researchCountry, synthesizeFindings } = require('./research-orchestrator');
const { generatePPT } = require('./ppt-multi-country');
const {
  validateResearchQuality,
  validateSynthesisQuality,
  validatePptData,
} = require('./quality-gates');

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
const requiredEnvVars = ['GEMINI_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
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

async function runMarketResearch(userPrompt, email, options = {}) {
  const startTime = Date.now();
  console.log('\n========================================');
  console.log('MARKET RESEARCH - START');
  console.log('========================================');
  console.log('Time:', new Date().toISOString());
  console.log('Email:', email);

  // Reset cost tracker
  // NOTE: Global costTracker has race condition with concurrent requests — acceptable for single-instance deployment
  costTracker.totalCost = 0;
  costTracker.calls = [];
  resetBudget();

  const tracker = createTracker('market-research', email, { prompt: userPrompt.substring(0, 200) });

  return trackingContext.run(tracker, async () => {
    try {
      // Stage 1: Parse scope
      const scope = await parseScope(userPrompt);
      if (options && typeof options === 'object') {
        if (
          options.templateSlideSelections &&
          typeof options.templateSlideSelections === 'object'
        ) {
          scope.templateSlideSelections = options.templateSlideSelections;
        }
        if (typeof options.templateStrictMode === 'boolean') {
          scope.templateStrictMode = options.templateStrictMode;
        }
      }

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
          // Fix 22: Cap retry loop at 2 minutes
          const RETRY_TIMEOUT = 2 * 60 * 1000;
          const retryLoop = async () => {
            for (const topic of researchGate.retryTopics.slice(0, 5)) {
              try {
                const ind = scope.industry || 'the industry';
                const queryMap = {
                  market_size: `${ca.country} ${ind} market size value statistics and trends`,
                  market_demand: `${ca.country} ${ind} demand by sector analysis`,
                  market_supplyChain: `${ca.country} ${ind} supply chain infrastructure`,
                  market_adjacentServices: `${ca.country} ${ind} services ecosystem providers`,
                  market_pricing: `${ca.country} ${ind} pricing and cost structure`,
                  market_services: `${ca.country} ${ind} specialized services market`,
                  policy_regulatory: `${ca.country} ${ind} regulatory framework laws`,
                  policy_incentives: `${ca.country} ${ind} incentives and subsidies`,
                  competitors_players: `${ca.country} major ${ind} companies and players`,
                };
                const retryQuery =
                  queryMap[topic] || `${ca.country} ${scope.industry} ${topic.replace(/_/g, ' ')}`;
                const retry = await callGeminiResearch(
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
            return { timedOut: false };
          };
          const retryResult = await Promise.race([
            retryLoop(),
            new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), RETRY_TIMEOUT)),
          ]);
          if (retryResult.timedOut) {
            console.warn(`[Quality Gate] Retry loop timed out after 2 minutes for ${ca.country}`);
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
          finalConfidenceScore: ca.finalConfidenceScore ?? null,
          readyForClient: ca.readyForClient ?? null,
          readiness: ca.readiness || null,
          finalReview: ca.finalReview
            ? {
                grade: ca.finalReview.overallGrade || null,
                coherenceScore: ca.finalReview.coherenceScore ?? null,
                criticalIssues: (ca.finalReview.issues || []).filter(
                  (i) => i.severity === 'critical'
                ).length,
                majorIssues: (ca.finalReview.issues || []).filter((i) => i.severity === 'major')
                  .length,
              }
            : null,
        })),
        totalCost: costTracker.totalCost,
        apiCalls: costTracker.calls.length,
        stage: 'complete',
      };

      // Depth/readiness gate: block clearly weak outputs before synthesis/PPT generation.
      const notReadyCountries = countryAnalyses.filter((ca) => ca && ca.readyForClient === false);
      if (notReadyCountries.length > 0) {
        const notReadyDiagnostics = notReadyCountries.map((ca) => ({
          country: ca.country,
          effectiveScore: Number(ca?.readiness?.effectiveScore || 0),
          confidenceScore: Number(ca?.readiness?.confidenceScore || 0),
          finalConfidenceScore: Number(ca?.readiness?.finalConfidenceScore || 0),
          codeGateScore: Number(ca?.readiness?.codeGateScore || 0),
          finalReviewCoherence: Number(ca?.readiness?.finalReviewCoherence || 0),
          finalReviewCritical: Number(ca?.readiness?.finalReviewCritical || 0),
          finalReviewMajor: Number(ca?.readiness?.finalReviewMajor || 0),
          finalReviewOpenGaps: Number(ca?.readiness?.finalReviewOpenGaps || 0),
          readinessReasons: Array.isArray(ca?.readiness?.reasons) ? ca.readiness.reasons : [],
          synthesisFailures: Array.isArray(ca?.contentValidation?.failures)
            ? ca.contentValidation.failures
            : [],
        }));
        const list = notReadyCountries
          .map((ca) => {
            const score = Number(ca?.readiness?.effectiveScore || 0);
            const coherence = Number(ca?.readiness?.finalReviewCoherence || 0);
            return `${ca.country} (effective=${score}, coherence=${coherence})`;
          })
          .join(', ');
        if (lastRunDiagnostics) {
          lastRunDiagnostics.stage = 'quality_gate_failed';
          lastRunDiagnostics.notReadyCountries = notReadyDiagnostics;
          lastRunDiagnostics.error = `Country analysis quality gate failed: ${list}. Refusing to generate deck below required quality threshold (>=80).`;
        }
        console.warn(`[Quality Gate] Countries not fully ready: ${list}`);
        throw new Error(
          `Country analysis quality gate failed: ${list}. Refusing to generate deck below required quality threshold (>=80).`
        );
      }

      // NOTE: rawData is preserved here — PPT generation needs it for citations and fallback content.
      // It will be cleaned up AFTER PPT generation to free memory.

      // Stage 3: Synthesize findings
      const synthesis = await synthesizeFindings(countryAnalyses, scope);

      // Quality Gate 2: Validate synthesis quality (Fix 14: pass industry for specificity scoring)
      let finalSynthesis = synthesis;
      const synthesisGate = validateSynthesisQuality(finalSynthesis, scope.industry);
      console.log(
        '[Quality Gate] Synthesis:',
        JSON.stringify({
          pass: synthesisGate.pass,
          overall: synthesisGate.overall,
          failures: synthesisGate.failures,
        })
      );
      if (!synthesisGate.pass) {
        if (synthesisGate.overall < 40) {
          throw new Error(`Synthesis quality too low (${synthesisGate.overall}/100). Aborting.`);
        }
        if (synthesisGate.overall < 60) {
          console.log(
            `[Quality Gate] Quality marginal (${synthesisGate.overall}/100), retrying synthesis with boosted tokens...`
          );
          // Retry synthesis once with boosted maxTokens
          const boostedScope = { ...scope, maxTokens: 24576 };
          finalSynthesis = await synthesizeFindings(countryAnalyses, boostedScope);
          const retryGate = validateSynthesisQuality(finalSynthesis, scope.industry);
          console.log(
            '[Quality Gate] Retry synthesis:',
            JSON.stringify({
              pass: retryGate.pass,
              overall: retryGate.overall,
              failures: retryGate.failures,
            })
          );
          if (!retryGate.pass && retryGate.overall < 40) {
            throw new Error(
              `Synthesis quality still too low after retry (${retryGate.overall}/100). Aborting.`
            );
          }
        }
      }

      // Quality Gate 3: Validate PPT data completeness before rendering
      for (const ca of countryAnalyses) {
        const sections = ['policy', 'market', 'competitors', 'depth', 'insights'].filter(
          (s) => ca[s]
        );
        const blocks = sections.map((s) => ({
          key: s,
          type: typeof ca[s] === 'object' ? 'section' : 'unavailable',
          title: s,
          content: ca[s]?._synthesisError ? 'Data unavailable' : JSON.stringify(ca[s]).slice(0, 50),
          chartData: ca[s]?.chartData || ca[s]?.tpes?.chartData || null,
        }));
        const pptGate = validatePptData(blocks);
        console.log(
          `[Quality Gate] PPT data for ${ca.country}:`,
          JSON.stringify({
            pass: pptGate.pass,
            emptyBlocks: pptGate.emptyBlocks.length,
            chartIssues: pptGate.chartIssues.length,
            overflowRisks: pptGate.overflowRisks.length,
          })
        );
        if (!pptGate.pass) {
          console.warn(
            `[Quality Gate] PPT data issues for ${ca.country}:`,
            JSON.stringify({ emptyBlocks: pptGate.emptyBlocks, chartIssues: pptGate.chartIssues })
          );
        }
      }

      // Stage 4: Generate PPT
      const pptBuffer = await generatePPT(finalSynthesis, countryAnalyses, scope);
      const pptMetrics = (pptBuffer && (pptBuffer.__pptMetrics || pptBuffer.pptMetrics)) || null;

      // Content-first policy:
      // Formatting deviations are logged as warnings, not hard failures.
      // We only hard-fail on catastrophic rendering loss (too many failed blocks).
      if (pptMetrics) {
        const templateTotal = Number(pptMetrics.templateTotal || 0);
        const failureCount = Number(pptMetrics.slideRenderFailureCount || 0);
        const failureRate = templateTotal > 0 ? failureCount / templateTotal : 0;

        if (failureRate > 0.35 || failureCount >= 10) {
          throw new Error(
            `PPT rendering quality failed: failures=${failureCount}, totalBlocks=${templateTotal}, failureRate=${failureRate.toFixed(2)}`
          );
        }

        const formattingWarnings = [];
        if (Number(pptMetrics.templateCoverage || 0) < 90) {
          formattingWarnings.push(`templateCoverage=${pptMetrics.templateCoverage}%`);
        }
        if (Number(pptMetrics.tableRecoveryCount || 0) > 0) {
          formattingWarnings.push(`tableRecoveries=${pptMetrics.tableRecoveryCount}`);
        }
        if (Number(pptMetrics.nonTemplatePatternCount || 0) > 0) {
          formattingWarnings.push(`nonTemplatePatterns=${pptMetrics.nonTemplatePatternCount}`);
        }
        if (Number(pptMetrics.geometryIssueCount || 0) > 0) {
          formattingWarnings.push(`geometryIssues=${pptMetrics.geometryIssueCount}`);
        }
        if (Number(pptMetrics.geometryMaxDelta || 0) > 0.15) {
          formattingWarnings.push(`geometryMaxDelta=${pptMetrics.geometryMaxDelta}`);
        }
        if (formattingWarnings.length > 0) {
          console.warn(
            `[Quality Gate] Formatting warnings (content-first mode): ${formattingWarnings.join(', ')}`
          );
          if (lastRunDiagnostics) {
            lastRunDiagnostics.formattingWarnings = formattingWarnings;
          }
        }
      }

      if (lastRunDiagnostics) {
        lastRunDiagnostics.ppt = pptMetrics || {
          templateCoverage: null,
          templateBackedCount: null,
          templateTotal: null,
          nonTemplatePatternCount: null,
          slideRenderFailureCount: null,
          tableRecoveryCount: null,
          geometryCheckCount: null,
          geometryAlignedCount: null,
          geometryMaxDelta: null,
          geometryIssueCount: null,
        };
      }

      // Clean up rawData AFTER PPT generation to free memory (citations already used by PPT renderer)
      for (const ca of countryAnalyses) {
        if (ca.rawData) {
          delete ca.rawData;
        }
      }

      // Stage 5: Send email
      const filename = `Market_Research_${scope.industry.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pptx`;

      const emailHtml = `
      <p>Your market research report is attached.</p>
      <p style="color: #666; font-size: 12px;">${escapeHtml(scope.industry)} - ${escapeHtml(scope.targetMarkets.join(', '))}</p>
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
        ...(lastRunDiagnostics || {}),
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
        <pre>${escapeHtml(error.message)}</pre>
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

      // Mark that error email was already sent to prevent double-send from outer catch
      error._errorEmailSent = true;
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

// Main research endpoint
app.post('/api/market-research', async (req, res) => {
  const { prompt, email, options, templateSlideSelections, templateStrictMode } = req.body;

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

  // Run research in background with 25-minute global pipeline timeout + abort signal
  const PIPELINE_TIMEOUT = 25 * 60 * 1000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, PIPELINE_TIMEOUT);
  const timeoutPromise = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new Error('Pipeline timeout after 25 minutes'));
    });
  });
  const mergedOptions = { ...(options || {}) };
  if (templateSlideSelections && typeof templateSlideSelections === 'object') {
    mergedOptions.templateSlideSelections = templateSlideSelections;
  }
  if (typeof templateStrictMode === 'boolean') {
    mergedOptions.templateStrictMode = templateStrictMode;
  }
  Promise.race([runMarketResearch(prompt, email, mergedOptions), timeoutPromise])
    .then(() => {
      clearTimeout(timeoutId);
    })
    .catch(async (error) => {
      clearTimeout(timeoutId);
      console.error('Background research failed:', error);
      // Only send error email if runMarketResearch didn't already send one
      if (!error._errorEmailSent) {
        try {
          await sendEmail({
            to: email,
            subject: 'Market Research Failed',
            html: `<h2>Market Research Error</h2><p>Your request failed: ${escapeHtml(error.message)}</p><p>Please try again.</p>`,
            fromName: 'Market Research AI',
          });
        } catch (emailErr) {
          console.error('Failed to send error email:', emailErr);
        }
      }
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
  console.log('  - GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'Set' : 'MISSING');
  console.log('  - SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'Set' : 'MISSING');
  console.log('  - SENDER_EMAIL:', process.env.SENDER_EMAIL || 'MISSING');
});
