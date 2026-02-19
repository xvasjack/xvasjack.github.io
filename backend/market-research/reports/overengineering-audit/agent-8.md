# Agent 8: Synthesis Notes

**Role**: Read all 7 agent reports and produce the consolidated master plan.

---

## 1. Cross-Cutting Themes

Seven agents examined the codebase from different angles. Five themes emerged independently across multiple agents:

### Theme A: The Pipeline Destroys Its Own Output
Agents 2, 3 both independently identified the content size check as the single worst content-destroying mechanism. Agent 2 called it "the single worst content-destroying mechanism" and Agent 3 labeled it "REMOVE" with the highest priority score of +7. Agent 2 also identified context-fit-agent.js as "paying for an LLM call to make content shorter/shallower." The pipeline spends $20-30 generating deep content and then deterministic code truncates, compacts, or compresses it. This was the clearest consensus finding across all agents and occupies Rank 1 in the master plan.

### Theme B: Gates Reject Good Content for Wrong Reasons
Agents 1, 2, 3 all flagged the content quality engine and gate infrastructure. Agent 1 characterized it as "2275 lines of post-hoc code trying to validate what the AI should have produced correctly in the first place." Agent 2 showed that `scoreDecisionUsefulness` rejects content with informal company references ("Toyota's Daihatsu subsidiary" scores 0 on the company dimension). Agent 3 identified it as the gate that "BLOCKS MOST OFTEN." Agent 2 also found that canonical key enforcement rejects valid content BEFORE normalization can save it -- the accept function runs before the normalize function, triggering content-degrading retries for purely structural reasons.

### Theme C: Validation Code Vastly Exceeds Content Code
Agents 1, 2, 7 all quantified this imbalance:
- Agent 1: 17% content code vs 53% validation+test code
- Agent 2: Only 22% of pipeline code generates content; 78% validates/gates/retries/sanitizes
- Agent 7: 18 production files but 27 non-production files in root; 44 env vars; 7 server.js gates

### Theme D: Review Loops Churn Without Converging
Agents 1, 2, 4, 7 all identified the triple-nested review loop as a major complexity center. Agent 4 rated the final review loop 4/10 ("high complexity, diminishing returns after 1st iteration, reviewer noise makes multi-pass verification unreliable"). Agent 2 demonstrated that re-synthesis passes can LOSE content from previous passes without detection. Agent 7 showed all three loops do the same thing (score -> find gaps -> research -> re-synthesize) and could be merged.

### Theme E: Dead Code and Dev Tools Inflate the Codebase
Agents 5, 6, 7 all catalogued non-production code:
- Agent 7: ~11,918 lines of non-production JS alongside production code; 6 dead specialized agents + synthesizeSingleCountry = ~1,700 lines of unreachable code
- Agent 6: 13,123 LOC of test files deletable immediately; 88.5% of test LOC guards non-content concerns
- Agent 5: 4,091 LOC of production formatting code removable/movable

---

## 2. Contradictions Between Agents

### Contradiction 1: Competitor 4-Part Split -- Overengineering or Smart Decomposition?

**Agent 2** flagged the 4-part competitor synthesis as a content-harming pattern because "the LLM cannot see what it generated for Japanese players when generating foreign players" -- no cross-referencing is possible. Agent 2 gave it Priority +3.

**Agent 4** called it "smart decomposition, not overengineering" and scored it 9/10, arguing "breaking competitors into 4 parts produces better results than a single massive prompt because each competitor category has different data patterns and validation needs."

**Resolution**: Both are partially right. The decomposition is sound (different competitor categories benefit from different prompts) but the lack of context passing is a real flaw. The master plan recommends keeping the 4-part split but passing previous chunks as context to subsequent calls (Rank 15). This preserves the decomposition benefits while enabling cross-referencing.

### Contradiction 2: Retry Patterns -- Overbuilt or Essential?

**Agent 1** rated the 5-tier synthesis fallback at Priority -1 to +3, viewing it as overengineered.

**Agent 4** gave most retry patterns scores of 7-10/10, viewing them as essential for content quality, and rated the overall pipeline as "3.5/10 mildly overengineered." Agent 4 explicitly stated: "No patterns should be removed entirely. Every retry/fallback serves the core product goal of content quality."

**Agent 2** showed that retries actively DEGRADE content because later tiers strip the style guide and anti-padding rules from prompts.

**Resolution**: The retries themselves are valuable (Agent 4 is right that they prevent empty sections). But the tier design degrades content on retry (Agent 2's point is critical). The master plan recommends keeping the retry structure but reducing tiers and NEVER stripping quality instructions from retry prompts. This preserves the safety net while preventing content degradation.

### Contradiction 3: Schema Firewall -- Remove or Keep?

**Agent 1** ranked it as Hotspot 5 (Priority +2) and recommended "Replace with ajv + prompt fixes."

**Agent 3** classified it as "REMOVE or DOWNGRADE" noting it's "NOT in server.js" and "NOT called in production pipeline."

**Agent 6** kept schema-firewall.test.js as one of only 4 test files to keep, saying it "validates data shape, prevents malformed synthesis from crashing the PPT builder."

**Resolution**: Agent 3's factual finding that it's not imported by server.js settles this. The module is not in the production path. The test file (schema-firewall.test.js) is kept because it tests useful validation concepts, but the module itself is removed from production. If schema validation is needed, the orchestrator's inline validation already covers it.

### Contradiction 4: ensureSummaryCompleteness -- Safety Net or Content Destroyer?

**Agent 2** flagged it as content-destroying (Priority +4), showing that hardcoded defaults replace LLM-generated industry-specific analysis with generic consulting templates. Found "energy services" hardcoded in violation of NO HARDCODED INDUSTRY LOGIC rule.

**Agent 4** scored it 7/10 and recommended KEEP, noting it's "zero cost, prevents empty slides" and "hardcoded content is generic but overwritten by AI-generated content when available."

**Resolution**: Both agents have valid points. The hardcoded defaults prevent empty slides (Agent 4) but include industry-specific language violations (Agent 2). The master plan recommends removing the hardcoded defaults but only AFTER improving synthesis prompts to generate complete depth sections. The energy-specific `ensurePartnerDescription` is removed immediately regardless.

---

## 3. Confidence Levels

| Rank | Item | Confidence | Why |
|------|------|-----------|-----|
| 1 | Remove content size check | **Very High** | 2 agents independently identified, consistent with mistakes.md row 37, clear content destruction |
| 2 | Downgrade content gate | **High** | 3 agents flagged, clear false-positive evidence, but some risk of letting bad content through |
| 3 | Fix key enforcement ordering | **High** | Agent 2 showed clear evidence of normalization running after rejection, straightforward fix |
| 4 | Remove context-fit agent | **High** | Clear anti-pattern (LLM to shorten LLM output), Agent 7 confirmed not in production imports |
| 5 | Delete stress tests | **Very High** | 3 agents agree, clearly not production code, two redundant frameworks |
| 6 | Remove hardcoded defaults | **Medium** | Agents disagree (2 vs 4). Correct long-term but needs prompt improvement first |
| 7 | Delete non-production gates | **Very High** | 4 agents agree, factually not in server.js import tree |
| 8 | Reduce sanitization passes | **High** | Single agent but evidence is clear (4+ recursive walks of same object) |
| 9 | Consolidate review loops | **Medium** | 4 agents agree on problem but the refactor is complex and risky |
| 10 | Simplify synthesis tiers | **High** | 3 agents agree, but Agent 4's data shows Pro tier is sometimes needed |
| 11 | Reduce gate stack | **High** | 3 agents agree, clear overlap between gates |
| 12 | Delete test files | **High** | Single agent (6) but thorough analysis with clear categorization |
| 13 | Delete dead code | **Very High** | Agent 7 found useDynamicFramework hardcoded to true, dead branch is provably unreachable |
| 14 | Move dev tools | **Very High** | 2 agents agree, zero production risk |
| 15 | Fix competitor context | **Medium** | Agent 2 identified problem, Agent 4 disagrees on severity |
| 16 | Remove prompt checklists | **High** | Clear reasoning (LLMs bad at self-counting), low risk |
| 17 | Thin response threshold | **High** | Agent 2 evidence is clear, Agent 4 agrees the retry is sometimes useful |
| 18 | Delete coherence checker | **Medium** | Only 1 agent flagged it, but the duplication argument is strong |
| 19 | Deduplicate utils | **Very High** | Agent 1 found clear textbook duplication |
| 20 | Consolidate charts | **Medium** | Low priority, formatting concern |

---

## 4. Methodology for Ranking

### Scoring Formula
Priority Score = (Content Impact + Simplicity Gain) - Risk - Effort

This formula was specified in the assignment and used consistently by all agents. Higher scores mean: more content improvement, more simplification, less risk, less effort.

### Cross-Agent Score Reconciliation

When multiple agents scored the same item differently, I used this approach:

1. **If agents agree on direction** (all say REMOVE or all say KEEP): averaged the scores.
2. **If agents disagree on direction**: examined the factual evidence each agent provided. Factual evidence (e.g., "not imported by server.js") overrides opinion-based ratings.
3. **Agent 4's perspective** was weighted carefully. Agent 4 audited retry/fallback patterns from an "is this retry valuable for content quality?" perspective and found most retries essential. This is a valid perspective but it optimizes for reliability, not simplicity. The master plan preserves the retry capability while simplifying the mechanism.

### Ranking Tiebreakers

When multiple items had the same Priority Score, I ranked by:
1. **Content Impact** (higher = higher rank) -- content depth is the #1 business priority
2. **Risk** (lower = higher rank) -- prefer safe changes over risky ones
3. **Number of agents flagging it** (more = higher rank) -- cross-validation increases confidence
4. **Effort** (lower = higher rank) -- do quick wins first within the same priority tier

### Phase Assignment

Items were assigned to phases based on:
- **Phase 1**: Priority >= +3 AND Risk <= 1 AND Effort <= 1. These are pure deletions or simple changes with zero content risk.
- **Phase 2**: Priority >= +2 AND Risk <= 3. These require testing with real runs but are bounded changes.
- **Phase 3**: Risk >= 3 OR Effort >= 3. These are architectural changes that need A/B testing.

### What I Did NOT Include

Several agent findings were not promoted to Top 20:

- **Agent 1's Hotspot 1** (deck-builder-single.js 7620-line monolith): Priority -1 because effort (4) and risk (4) are too high for a formatting file that's secondary to content quality. Deferred to post-Phase-3.
- **Agent 1's Hotspot 13** (ops-runbook as code): Only 1082 lines, low impact. Included in Phase 1 as a move-to-scripts item (Rank 14) rather than a standalone action.
- **Agent 2's Finding 13** (validateContentDepth quantity over quality): Priority 0, Agent 2 acknowledged it's "hard to fix without redesigning scoring." Deferred.
- **Agent 5's Rec 6** (prune template-patterns.json): Priority -1. High effort (must audit every field access) for no content benefit. Included in Phase 3 as a stretch goal.
- **Agent 7's Rec 8** (reduce 44 env vars to mode presets): Good idea but effort 3 and no content impact. Mentioned in Phase 3 but not in Top 20.

---

## 5. Implementation Dependencies

Some actions depend on others:

```
Rank 7 (delete gate files) must happen BEFORE Rank 12 (delete test files)
  -- because some test files test the deleted modules

Rank 1 (remove content size check) should happen BEFORE Rank 2 (downgrade content gate)
  -- because content size check removal increases content volume, which may affect content scores

Rank 6 (remove hardcoded defaults) should happen AFTER improved synthesis prompts are tested
  -- otherwise some depth sections may be empty

Rank 9 (consolidate review loops) should be the LAST major change
  -- highest risk, needs stable baseline to compare against

Rank 5 (delete stress tests) has NO dependencies
  -- pure dead code removal, safe to do anytime
```

---

## 6. Expected Outcomes

### After Phase 1 (1-2 days)
- Codebase shrinks from 66,975 to ~40,200 JS LOC
- Non-content test code drops from 88.5% to ~50%
- content size check removal should INCREASE word counts in final output
- Pipeline reliability improves (fewer files to load, fewer potential failure points)
- No content regression expected

### After Phase 2 (3-5 days)
- Pipeline failure rate drops (content gate no longer kills runs)
- Synthesis retries produce better content (style guide preserved in retry prompts)
- Fewer unnecessary re-synthesis cycles from key enforcement
- ~30% fewer LLM calls per run (from reduced tiers and sanitization passes)
- Cost per run drops from ~$5-7 to ~$4-5

### After Phase 3 (1-2 weeks)
- Single review loop replaces triple-loop (~800 fewer lines)
- Competitor section gains cross-referencing capability
- template-patterns.json drops from 64,705 to ~15,000 lines
- Total codebase: ~37,000 JS LOC + 15,000 JSON (from 67,000 JS + 65,000 JSON)
- LLM calls per country: ~35-45 (from ~48-80)
- Content quality: equal or better (generation-first architecture)
