# Claude Prompt Pack: Overengineering Audit (8 Agents)

Last updated: 2026-02-15

Use these prompts as independent parallel sessions (max 8 agents).

Shared objective for all agents:
- Find where the project is overengineered relative to business priorities.
- Prioritize simplifications that preserve or improve content depth, insight quality, and story flow.
- De-prioritize improvements that mostly optimize formatting precision or operational ceremony.

Shared business context to include in every agent:
- Product goal: one-prompt generation of market research decks across country/industry.
- Real user outcome: client-ready strategic deck; team can polish formatting afterward.
- Top priority: content depth, insights, story flow.
- Acceptable tradeoff: slower runtime and some format drift.
- Not acceptable: shallow content and weak insights.
- Runtime budget: up to 2 hours.
- Cost budget: up to USD 30.

---

## Agent 1 Prompt: Complexity Inventory and Hotspot Map

```text
You are Agent 1 in /home/xvasjack/xvasjack.github.io/backend/market-research.

Mission:
Build a precise complexity inventory and identify top overengineering hotspots.

Context:
- This project should stay simple.
- Highest priority is depth/insight/story quality, not perfect formatting.
- We accept slower runs and some format drift if content is excellent.

Tasks:
1) Build a hotspot map of complexity:
   - large files, high branch density, many feature flags, nested fallback chains, cross-module coupling
2) Score each hotspot using:
   - Business value to content quality (high/medium/low)
   - Complexity cost (high/medium/low)
   - Overengineering risk (high/medium/low)
3) Identify "likely removable complexity":
   - code paths that do not materially improve content quality
4) Produce top-15 simplification candidates with risk and rollback notes.

Evidence requirements:
- Use concrete file references and line anchors.
- Use at least one objective signal per finding (LOC, branch count, call fan-out, duplicate logic).
- Include before/after mental model for each candidate.

Output format:
1) Executive summary (<=15 lines)
2) Hotspot table (ranked)
3) Simplification candidates (top 15)
4) Recommended first 5 actions for immediate implementation

Constraints:
- Do not implement destructive refactors in this task.
- No paid backend runs.
- Focus on analysis quality and actionable simplification plan.
```

---

## Agent 2 Prompt: Content Pipeline First, Everything Else Second

```text
You are Agent 2 in /home/xvasjack/xvasjack.github.io/backend/market-research.

Mission:
Audit whether content depth/insight/storyflow logic is being overshadowed by non-content engineering complexity.

Context:
- Core success criterion is strategic insight depth, not pixel-perfect formatting.
- The worst failure is shallow content.

Tasks:
1) Trace full content path:
   prompt -> research -> synthesis -> quality checks -> slide narrative
2) Identify all places where non-content gates/fallbacks can block or dilute high-quality content.
3) Identify shallow-content leak paths that still pass current gates.
4) Propose simplified content-first gate stack:
   - minimal hard checks
   - score weighting aligned to business priority
5) Propose removal or downgrade of low-value checks.

Required deliverables:
- "Content Critical Path" diagram (text format acceptable).
- Top 10 failure modes that hurt insight quality.
- Proposed minimal gate policy:
  - hard fail checks
  - warning-only checks
  - removed checks

Evidence:
- File and function-level references.
- Examples of logic where formatting/reliability checks dominate content logic.

Constraints:
- Keep recommendations practical and mergeable.
- No paid backend runs.
- If uncertain, mark assumption explicitly.
```

---

## Agent 3 Prompt: Gate Rationalization and Policy Simplification

```text
You are Agent 3 in /home/xvasjack/xvasjack.github.io/backend/market-research.

Mission:
Find overengineering in preflight/release/smoke/gate policy and propose a simplified gate model aligned to business intent.

Context:
- Content quality is the only non-negotiable.
- Some format drift and slower runtime are acceptable.

Tasks:
1) Inventory all gates and classify by objective:
   - content quality
   - deck file safety/openability
   - formatting style match
   - operational hygiene
2) For each gate, determine:
   - does it protect content depth?
   - does it block release for non-critical reasons?
3) Propose gate-policy redesign:
   - Tier A hard blockers (must keep)
   - Tier B warnings (keep but non-blocking)
   - Tier C remove/deprecate
4) Draft a migration plan that reduces gate complexity without increasing shallow-output risk.

Output:
- Current gate matrix
- Proposed gate matrix
- Delta impact summary (complexity reduction vs risk)
- Concrete patch suggestions (file-level)

Evidence:
- Reference code and reports where gates create friction without content benefit.
- Include estimated maintenance-cost reduction.

Constraints:
- Do not remove file safety checks that prevent broken PPT files from opening.
- Emphasize content-focused gates.
```

---

## Agent 4 Prompt: Retry, Fallback, and Flow Complexity Audit

```text
You are Agent 4 in /home/xvasjack/xvasjack.github.io/backend/market-research.

Mission:
Audit retry/fallback/flow logic for unnecessary complexity and cost inflation.

Context:
- Runtime can be slower if quality is better.
- Budget target is USD 30/run.
- Simpler controls are preferred if they maintain quality.

Tasks:
1) Map all retry loops, fallback trees, and parallel fan-out points.
2) Identify loops that likely add cost without meaningful quality gain.
3) Detect potential retry storms or repeated low-signal loops.
4) Propose simplification:
   - lower fan-out
   - fewer fallback tiers
   - clearer stop criteria
   - content-quality-based stopping logic
5) Recommend a "simple default orchestration profile" for production.

Deliverables:
- Retry/fallback map
- Top 8 over-complex flow patterns
- Simplified policy with concrete parameter values
- Expected impact on cost, runtime, and output quality

Evidence:
- cite exact modules/functions
- include a likely cost-benefit rationale for each recommendation

Constraints:
- Keep Gemini retry base delay assumptions compatible with current policy unless justified.
- Avoid proposing complex flow controllers as replacement.
```

---

## Agent 5 Prompt: Formatting and Template style match Complexity Right-Sizing

```text
You are Agent 5 in /home/xvasjack/xvasjack.github.io/backend/market-research.

Mission:
Find where formatting/template style match logic may be overengineered relative to product goals.

Context:
- Formatting is useful but secondary.
- Team can polish decks after generation.
- Content quality dominates release value.

Tasks:
1) Inventory formatting-enforcement mechanisms:
   - strict failures
   - drift runInfo
   - normalization passes
2) Separate "must keep for openable PPT file safety" from "nice-to-have style match precision."
3) Flag any formatting checks that create frequent failures while not protecting content quality.
4) Propose right-sized policy:
   - file safety hard-fail checks
   - style match warning checks
   - optional deep-audit mode

Deliverables:
- Must-keep file safety controls list
- Candidate downgrade/remove list
- suggested runtime mode matrix:
  - `production_content_first`
  - `strict_template_audit`
  - `debug_deep_runInfo`

Evidence:
- Use concrete failures/warnings from logs/tests/reports.
- Tie each recommendation to user value and maintenance load.

Constraints:
- Do not recommend removing package-file safety checks that prevent repair prompts.
- Focus on reducing operational drag from low-value strictness.
```

---

## Agent 6 Prompt: Test Suite Overengineering and Value Density

```text
You are Agent 6 in /home/xvasjack/xvasjack.github.io/backend/market-research.

Mission:
Assess whether the test suite is overengineered, and identify tests that should be merged, downgraded, or removed.

Context:
- Tests should protect business-critical quality: deep insights and coherent narrative.
- Too many low-value tests increase maintenance burden.

Tasks:
1) Classify tests by business value:
   - content depth protection
   - file safety/openability protection
   - formatting precision
   - internal implementation detail
2) Identify:
   - overlapping/duplicate tests
   - brittle tests with low user-value protection
   - heavy tests that rarely catch meaningful regressions
3) Propose lean test pyramid:
   - core must-run set
   - extended CI set
   - optional nightly/deep set
4) Estimate runtime and maintenance savings.

Deliverables:
- test inventory with value score
- prune/merge recommendations
- proposed default test command set for daily development

Evidence:
- file-level references
- examples of duplicate assertion coverage

Constraints:
- Do not weaken tests that catch shallow-content regressions.
- keep file safety-critical checks.
```

---

## Agent 7 Prompt: User Journey and API Surface Simplification

```text
You are Agent 7 in /home/xvasjack/xvasjack.github.io/backend/market-research.

Mission:
Audit end-user flow and API surface for simplicity from "one prompt -> useful strategic deck".

Context:
- Product intent is one-prompt generation for country+industry market research.
- User value is strategic clarity, not internal pipeline sophistication.

Tasks:
1) Map the user journey and identify friction points or hidden complexity.
2) Audit API/request contracts and detect unnecessary parameters/feature modes.
3) Propose a simplified primary path:
   - single request schema
   - minimal required controls
   - predictable output contract
4) Identify internal options that should be hidden or moved to expert/debug mode.
5) Propose user-facing quality signals that reflect content strength (not internal machinery).

Deliverables:
- current vs simplified user flow
- request/response contract simplification proposal
- migration compatibility notes

Evidence:
- endpoints, request models, and code references
- examples where complexity does not improve client outcome

Constraints:
- Keep backward compatibility guidance explicit.
- prioritize clarity and maintainability.
```

---

## Agent 8 Prompt: Consolidated De-Overengineering Plan (Implementation-Ready)

```text
You are Agent 8 in /home/xvasjack/xvasjack.github.io/backend/market-research.

Mission:
Combine findings from Agents 1-7 into an implementation-ready simplification roadmap.

Context:
- Content depth and insight quality are the single most important outcome.
- Formatting drift and slower runtime are acceptable if content is excellent.

Tasks:
1) Consolidate all identified overengineering candidates.
2) Resolve conflicts across agent recommendations.
3) Produce phased execution plan:
   - Phase 1: low-risk high-impact removals
   - Phase 2: medium-risk consolidations
   - Phase 3: optional deeper simplification
4) For each action include:
   - why it exists today
   - why it is now overengineering
   - exact change proposal
   - rollback strategy
   - acceptance criteria tied to content quality
5) Define a "content-first operating mode" baseline config.

Required output:
- Final ranked backlog (top 20 changes)
- 2-week and 6-week plans
- owner suggestions (content, platform, QA)
- risks and mitigations
- clear Go/No-Go decision gates for each phase

Evidence standard:
- every recommendation must cite concrete evidence from prior agents or code references
- no speculative changes without check path

Constraints:
- keep plan simple and executable
- avoid introducing new flow-control complexity
- preserve deck openability and minimal file safety guarantees
```

---

## Single Meta Prompt (Optional FlowManager Prompt)

If you want one Claude session to launch and coordinate all 8 workers, use this:

```text
You are the coordinator for an 8-agent overengineering audit in /home/xvasjack/xvasjack.github.io/backend/market-research.

Business truth:
- Tool should be simple.
- Output goal: client market-research deck from one prompt.
- Top priority: deep insights + strong strategic story flow.
- Formatting style match is secondary; some drift is acceptable.
- Runtime up to 2 hours and cost up to $30 are acceptable.
- Shallow content is unacceptable.

Your job:
1) Spawn and coordinate 8 parallel agents using the exact agent missions in docs/claude-agent-prompts-overengineering-audit.md.
2) Require each agent to produce evidence-backed findings with file references.
3) Consolidate into one final decision memo with:
   - top overengineering hotspots
   - what to remove/downgrade/keep
   - phased implementation plan
   - risk-managed rollout
4) Optimize for simplicity and content quality, not maximal technical sophistication.

Quality bar for final memo:
- concrete
- prioritized
- conflict-resolved
- implementation-ready
- rollback-safe
```

