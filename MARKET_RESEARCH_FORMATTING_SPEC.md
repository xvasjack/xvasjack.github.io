# Market Research Slide Formatting Specification

This document provides formatting rules for the Market Research tool to match YCP profile slides styling.

---

## 0. Project Escort Hard Requirements (2026-02-11)

These are non-negotiable delivery rules for the market-research pipeline.

1. Template fidelity must be slide-repository driven.
- Maintain a 20-30 slide template repository with extracted per-slide geometry/style metadata.
- Slide generation must select from this repository and render using extracted coordinates/styles.
- Target is pixel-level consistency with selected template slides (not approximate similarity).

2. Content quality threshold is minimum 80/100.
- Decks must clear a hard quality gate of >=80 effective score before delivery.
- Storyline must be insightful (clear "why now", causal logic, and actionable recommendations).

3. Post-fix verification protocol is mandatory.
- After each fix, run 2 additional verification passes to confirm the root cause is actually resolved.
- Use up to 5 total refinement/fix rounds for a run.

4. Root-cause standard: no assumption-based fixes.
- Diagnose with concrete evidence from diagnostics/logs/output artifacts.
- If evidence is missing, improve diagnostics first, then re-run.

---

## 1. FONT SPECIFICATIONS

| Element | Font | Size | Weight | Color |
|---------|------|------|--------|-------|
| Slide Title | Segoe UI | 24pt | Bold | Navy #1F497D |
| Message/Subtitle | Segoe UI | 16pt | Regular | Blue #007FFF |
| Body Content | Segoe UI | 14pt | Regular | Black #000000 |
| Table Header | Segoe UI | 14pt | Bold | White on #011AB7 |
| Table Body | Segoe UI | 14pt | Regular | Black #000000 |
| Section Label | Segoe UI | 14pt | Bold | Orange #E46C0A or Green #2E7D32 |
| Footnote/Source | Segoe UI | 10pt | Regular | Gray #666666 |

---

## 2. SLIDE LAYOUT RULES

### 2.1 Section Divider Line
- **Required**: Navy blue horizontal line under section headers
- **Color**: #1F497D
- **Width**: 2.5pt (22225 EMUs)
- **Position**: Below section header text, spanning the section width

### 2.2 Content Boundaries
- **Left margin**: 0.35 inches from slide edge
- **Right margin**: 0.35 inches from slide edge
- **Top content start**: Below title area (~1.2 inches from top)
- **Bottom limit**: 0.5 inches from slide bottom
- **CRITICAL**: No text may exceed these boundaries. Truncate or split slides if needed.

### 2.3 Slide Title Area Structure
```
┌──────────────────────────────────────────────────────┐
│ [TITLE] - Action-oriented, insight-driven headline   │
│ [MESSAGE] - One sentence "so what" summary           │
├──────────────────────────────────────────────────────┤
│ _______________ (navy divider line) _______________ │
│                                                      │
│ [CONTENT AREA]                                       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## 3. CONTENT DENSITY RULES

### 3.1 Text Limits
| Element | Maximum |
|---------|---------|
| Bullet points per section | 4 |
| Characters per bullet | 80 |
| Lines per bullet | 2 |
| Table rows visible | 6 (split to new slide if more) |
| Table columns | 4 (use 2-3 if possible) |

### 3.2 Writing Style
- **NO long paragraphs** - use short phrases
- **NO walls of text** - break into bullets
- **Truncate gracefully** - end with complete thought, not "..."
- **Action-oriented** - start bullets with verbs when possible

### 3.3 Overflow Handling
If content exceeds slide boundaries:
1. First: Reduce text (summarize)
2. Second: Split into multiple slides
3. Never: Let text run off the slide

---

## 4. CHART USAGE GUIDELINES

### 4.1 When to Use Charts
The AI should decide whether a chart adds value. Use charts when:
- Comparing numbers (market size, growth rates, market share)
- Showing trends over time
- Comparing multiple options
- Visualizing proportions/percentages

Do NOT force charts when:
- Data is qualitative (descriptions, policies)
- Only 1-2 data points exist
- A simple table is clearer

### 4.2 Chart Type Selection Guide

| Data Type | Recommended Chart | Example Use |
|-----------|------------------|-------------|
| Market size breakdown | Bar Chart (horizontal or vertical) | Segment sizes in USD |
| Growth over time | Line Chart | CAGR 2025-2030 |
| Market share | Pie Chart or Stacked Bar | Competitor % |
| Comparison of options | Harvey Balls, Radar, or Matrix | Entry strategy pros/cons |
| Risk assessment | Heat Map or Traffic Lights | Risk severity |
| Timeline/Roadmap | Gantt or Arrow Timeline | Implementation phases |
| Yes/No features | Checkmarks table | Regulatory requirements |

### 4.3 Chart Styling
- **Colors**: Use YCP color scheme
  - Primary: #007FFF (blue)
  - Secondary: #011AB7 (dark blue)
  - Accent: #E46C0A (orange)
  - Positive: #2E7D32 (green)
  - Negative: #C62828 (red)
- **Labels**: Segoe UI, 12pt
- **Keep simple**: Max 6 segments in pie charts, max 8 bars in bar charts

---

## 5. INSIGHT FRAMEWORK

### 5.1 Every Content Slide Must Have a Story
Each slide should answer: **"So what?"** and **"Now what?"**

Structure insights as:
```
DATA: [What the numbers say]
     ↓
PATTERN: [What it means]
     ↓
ACTION: [What to do about it]
```

### 5.2 Example Transformation

**BAD (jargon-heavy):**
> "Thailand's energy service demand is structurally driven by demographic headwinds and macroeconomic deceleration, necessitating productivity optimization through mandated efficiency paradigms—creating a robust, non-cyclical $300M+ market for strategic upgrades and ESCO contract frameworks."

**BAD (too simplistic):**
> "Thailand is getting older so factories need to save money. The government makes them do energy checks. This means there's a $300M market."

**GOOD (Economist-style):**
> **Title**: Labor pressure unlocks $300M efficiency market
>
> **Key Points**:
> - Manufacturing wages rose 8% annually 2021-2024 while productivity gained only 2%. The median factory worker is now 45.
> - The 2022 Energy Conservation Act mandates audits for facilities >2MW. DEDE has 23 auditors for 4,200 qualifying factories - enforcement is selective.
> - Result: Structural demand for ESCO contracts, concentrated in the EEC corridor where 60% of target factories operate.
>
> **Action**: Target the 180 factories in Rayong province (highest energy intensity, most audit pressure) before Japanese competitors consolidate.

---

## 6. SLIDE TYPE TEMPLATES

### 6.1 Title Slide
- Large country/topic name
- Subtitle with research focus
- Clean, minimal

### 6.2 Executive Summary / Key Findings
- Max 3-4 key takeaways
- Each takeaway: 1-2 lines max
- Optional: One summary visual (chart or icon)

### 6.3 Market Overview
- Key metrics in table OR chart (AI decides)
- If >5 metrics, use table
- If comparing sizes, use bar chart

### 6.4 Competitive Landscape
- Company table with Type and Notes columns
- If market share data exists, add pie chart
- Barriers to entry as separate bullet section

### 6.5 Regulatory/Policy
- Table format: Area | Details
- Highlight key risks in colored callout box
- Keep policies as short phrases, not full sentences

### 6.6 Opportunities & Obstacles
- Two-column layout preferred
- Green header for Opportunities
- Orange/Red header for Obstacles
- Max 4 items per column

### 6.7 Key Insights
- Max 3 insights per slide
- Each insight: Bold headline + 2-3 line explanation
- Use "Data → Pattern → Action" framework

### 6.8 Entry Options / Strategy
- Comparison table or matrix
- If 3+ options: use Harvey Balls or scoring table
- Clear recommendation with reasoning

### 6.9 Risk Assessment
- Risk + Mitigation table
- Optional: color-code severity (red/orange/green)
- Go/No-Go checklist as checkmarks

### 6.10 Roadmap / Timeline
- Timeline visual preferred over bullet list
- Group by phase (Months 0-6, 6-12, 12-24)
- Max 4 items per phase

---

## 7. COLOR USAGE

### 7.1 Table Headers
- Background: #011AB7 (dark blue)
- Text: White

### 7.2 Section Labels
- Opportunities: #2E7D32 (green) or #E46C0A (orange)
- Obstacles/Risks: #E46C0A (orange) or #C62828 (red)
- Neutral sections: #1F497D (navy)

### 7.3 Callout Boxes
- Recommendation: Light blue background (#EDFDFF) with blue border
- Warning: Light orange background with orange border
- Key Insight: Light gray background with navy text

---

## 8. QUALITY CHECKLIST

Before generating final output, verify:

- [ ] All text uses Segoe UI font
- [ ] Body content is 14pt
- [ ] Title is 24pt, Message is 16pt
- [ ] Navy divider line under section headers
- [ ] No text overflows slide boundaries
- [ ] Max 4 bullets per section
- [ ] Each bullet under 80 characters
- [ ] Charts used where numbers benefit from visualization
- [ ] Each slide has clear "so what" message
- [ ] Tables have max 6 rows (split if more)
- [ ] Footnotes/sources in 10pt at bottom

---

## 9. IMPLEMENTATION NOTES

### 9.1 python-pptx Font Settings
```python
from pptx.util import Pt
from pptx.dml.color import RgbColor

# Font settings
run.font.name = 'Segoe UI'
run.font.size = Pt(14)  # Body content
run.font.color.rgb = RgbColor(0x00, 0x00, 0x00)  # Black

# Title
title_run.font.size = Pt(24)
title_run.font.bold = True
title_run.font.color.rgb = RgbColor(0x1F, 0x49, 0x7D)  # Navy

# Message
message_run.font.size = Pt(16)
message_run.font.color.rgb = RgbColor(0x00, 0x7F, 0xFF)  # Blue
```

### 9.2 Adding Divider Line
```python
from pptx.util import Inches, Pt
from pptx.dml.color import RgbColor

# Add line shape
line = slide.shapes.add_connector(
    MSO_CONNECTOR.STRAIGHT,
    Inches(0.35), Inches(1.1),  # start x, y
    Inches(9.65), Inches(1.1)   # end x, y
)
line.line.color.rgb = RgbColor(0x1F, 0x49, 0x7D)
line.line.width = Pt(2.5)
```

### 9.3 Chart Colors
```python
# YCP color palette for charts
CHART_COLORS = [
    RgbColor(0x00, 0x7F, 0xFF),  # Blue (primary)
    RgbColor(0x01, 0x1A, 0xB7),  # Dark blue
    RgbColor(0xE4, 0x6C, 0x0A),  # Orange
    RgbColor(0x2E, 0x7D, 0x32),  # Green
    RgbColor(0x1F, 0x49, 0x7D),  # Navy
    RgbColor(0xC6, 0x28, 0x28),  # Red
]
```

---

## 10. EXAMPLE PROMPT STRUCTURE FOR AI

When generating slide content, the AI should be prompted to:

```
For each slide, provide:
1. TITLE: Action-oriented headline (max 10 words)
2. MESSAGE: One sentence insight (max 20 words)
3. CONTENT: Choose appropriate format:
   - BULLETS: Max 4 items, each max 80 chars
   - TABLE: Max 6 rows, 2-4 columns
   - CHART: Specify type and data points
4. INSIGHT_BOX (optional): Data → Pattern → Action

Content must fit within slide. Prioritize clarity over completeness.
When numbers exist, consider if a chart would communicate better than text.
```

---

*Last updated: 2025-12-30*
*Reference: YCP profile slide template v3.pptx*
