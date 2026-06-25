export const meta = {
  name: 'shizuoka-qc',
  description: 'Sonnet QC re-check: fix revenue conversion, re-screen independence/band from official sources',
  phases: [ { title: 'QC', detail: 'sonnet re-fetch official IR; correct figures + independence + band' } ],
}

const CANDS = [];  // BAKED_AT_RUNTIME

const VSCHEMA = {
  type:'object', additionalProperties:false,
  properties:{
    name:{type:'string'},
    nameEn:{type:['string','null']},
    officialUrl:{type:['string','null']},
    hqInShizuoka:{type:'boolean'},
    hqCity:{type:['string','null']},
    independent:{type:'boolean'},
    parentNote:{type:['string','null']},
    industry:{type:'string'},
    address:{type:['string','null']},
    zip:{type:['string','null']},
    representative:{type:['string','null']},
    registeredCapital:{type:['string','null']},
    revenueJPYM:{type:['number','null'], description:'JPY MILLIONS, must equal revenueOku*100'},
    revenueBasis:{type:['string','null'], description:'group or standalone'},
    revenueOku:{type:['number','null'], description:'億円'},
    headcount:{type:['number','null']},
    overseas:{type:['string','null']},
    listed:{type:'boolean'},
    ticker:{type:['string','null']},
    familyOwned:{type:'boolean'},
    deprioritized:{type:'boolean'},
    deprioritizeReason:{type:['string','null']},
    decision:{type:'string', enum:['qualified','screened_out','unsizable']},
    reason:{type:'string'},
    officialSourceUrls:{type:'array', items:{type:'string'}},
    screeningSourceUrls:{type:'array', items:{type:'string'}},
    confidence:{type:'string', enum:['high','med','low']}
  },
  required:['name','hqInShizuoka','independent','industry','listed','decision','reason','officialSourceUrls','revenueJPYM','revenueOku']
}

function qprompt(c){
  return `Re-verify and CORRECT this company's sizing & screening from its OWN official sources. The first pass flagged issues: ${(c.reasons||[]).join('; ')}.
Company: "${c.name}"${c.ticker?` (ticker ${c.ticker})`:''}. Official site (if known): ${c.officialUrl||'find it'}.
Prior pass: revenueJPYM=${c.priorRevenueJPYM}, revenueOku=${c.priorRevenueOku}, basis=${c.priorBasis}, headcount=${c.priorHeadcount}, decision=${c.priorDecision}. Prior parent note: ${c.parentNote||'n/a'}.

DO:
1. Open the official IR / 決算短信 / 有価証券報告書 / 会社概要 (WebFetch). Read the LATEST annual revenue (売上高). Report revenueOku (億円) and revenueJPYM (JPY MILLIONS) CONSISTENTLY — they MUST satisfy revenueJPYM = revenueOku × 100 exactly (1億 = 100百万). The classic bug is a figure 10× or 100× off; fix it. State revenueBasis = "group" (連結) or "standalone" (単体).
2. RE-SCREEN INDEPENDENCE strictly:
   • If this is a branch, or a consolidated / wholly-owned (100%) subsidiary of an OPERATING parent based OUTSIDE Shizuoka → decision = screened_out, reason = "subsidiary of <parent> (HQ in <prefecture>)".
   • A 〇〇ホールディングス FAMILY holding parent = INDEPENDENT → keep.
   • A mere major shareholder, PE fund, or equity affiliate (持分法/関連会社) is NOT a parent → keep (note it).
   • An independently LISTED company is independent even if another firm holds a large stake → keep.
   • A wholly-owned captive subsidiary of a Shizuoka-based operating parent → keep but set independent=false and reason note "captive subsidiary of <parent> (Shizuoka)".
3. RE-APPLY the band: 50–1000億 (¥5–100B) → qualified; >1000億 → screened_out "too large >¥100B"; <50億 AND headcount≤200 → screened_out "too small <¥5B"; private with undisclosed revenue BUT headcount>200 → qualified.
4. Confirm HQ (本社/本店) is in Shizuoka (not just a plant).
5. Fill output columns 7–10 from the OFFICIAL site only (registeredCapital, revenueJPYM(+basis), headcount, overseas by country). Set deprioritized=true for automotive/energy/semiconductor/real-estate/high-tech. Set familyOwned appropriately.
Return the corrected full record. Cite official URLs in officialSourceUrls. Be precise; accuracy over completeness.`;
}

phase('QC');
const out = await parallel(CANDS.map(c => () =>
  agent(qprompt(c), { label:`qc:${c.name}`, phase:'QC', schema:VSCHEMA, model:'sonnet' })
    .then(v => v ? { ...v, _qc:true } : null)
    .catch(() => null)
));
const rows = out.filter(Boolean);
log(`QC done: ${rows.length} re-checked of ${CANDS.length}`);
return { rows };
