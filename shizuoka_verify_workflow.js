export const meta = {
  name: 'shizuoka-verify',
  description: 'Per-candidate screen + size from official sources (cheap model), QC re-check on critical rows',
  phases: [
    { title: 'Verify', detail: 'one cheap agent per candidate: confirm HQ/independence, screen band, pull cols 7-10 from official site' },
    { title: 'QC', detail: 'sonnet re-check of listed-blank-revenue / 10x-off / low-confidence rows' },
  ],
}

const CANDS = Array.isArray(args) ? args : (args && args.candidates) || [];

const VSCHEMA = {
  type:'object', additionalProperties:false,
  properties:{
    name:{type:'string'},
    nameEn:{type:['string','null']},
    officialUrl:{type:['string','null'], description:'company OWN official website'},
    hqInShizuoka:{type:'boolean', description:'registered HQ 本店/本社 is in Shizuoka Prefecture (not just a plant)'},
    hqCity:{type:['string','null']},
    independent:{type:'boolean', description:'NOT a branch/subsidiary of an operating parent based outside Shizuoka. A 〇〇ホールディングス family parent = independent. PE fund / major shareholder does NOT make it dependent.'},
    parentNote:{type:['string','null']},
    industry:{type:'string'},
    address:{type:['string','null'], description:'HQ address from official site'},
    zip:{type:['string','null']},
    representative:{type:['string','null'], description:'代表者 / 代表取締役'},
    registeredCapital:{type:['string','null'], description:'資本金 as shown on official site, e.g. "100百万円"'},
    revenueJPYM:{type:['number','null'], description:'revenue in JPY MILLIONS from OFFICIAL source only (億円×100=百万円). null if not on official source.'},
    revenueBasis:{type:['string','null'], description:'"group" (consolidated/連結) or "standalone" (単体) — which basis revenueJPYM is.'},
    revenueOku:{type:['number','null'], description:'same revenue in 億円 (for band test). May come from official OR third-party screening source.'},
    headcount:{type:['number','null'], description:'従業員数 from official source (note group vs standalone in note).'},
    overseas:{type:['string','null'], description:'overseas presence BY COUNTRY from official site, e.g. "China; Thailand; USA". "None" if domestic only. null if not stated.'},
    listed:{type:'boolean'},
    ticker:{type:['string','null']},
    familyOwned:{type:'boolean'},
    deprioritized:{type:'boolean', description:'true if core industry is automotive / energy / semiconductor / real estate / high-tech'},
    deprioritizeReason:{type:['string','null']},
    decision:{type:'string', enum:['qualified','screened_out','unsizable']},
    reason:{type:'string', description:'concise reason for the decision (esp. for screened_out / unsizable)'},
    officialSourceUrls:{type:'array', items:{type:'string'}, description:'official URLs that columns 7-10 came from'},
    screeningSourceUrls:{type:'array', items:{type:'string'}, description:'third-party URLs used ONLY to decide in/out'},
    confidence:{type:'string', enum:['high','med','low']}
  },
  required:['name','hqInShizuoka','independent','industry','listed','decision','reason','officialSourceUrls']
}

function vprompt(c){
  return `You are sizing ONE company for an M&A target census. Company: "${c.name}"${c.ticker?` (ticker ${c.ticker})`:''}. Discovery hints (may be wrong — verify): HQ city=${c.hqCity||'?'}, industry=${c.industry||'?'}, listed=${c.listed}, rev≈${c.revenueEstOku??'?'}億, headcount≈${c.headcountEst??'?'}. Hint source(s): ${(c.sourceUrls||[]).join(' , ')||'n/a'}.

STEP 1 — Find the company's OWN official website (会社概要/企業情報/IR). Use WebSearch then WebFetch the 会社概要 page.
STEP 2 — Confirm registered HQ (本社/本店所在地) is in Shizuoka Prefecture (静岡県). A mere factory/plant in Shizuoka does NOT count. If HQ is outside Shizuoka → decision=screened_out, reason="HQ not in Shizuoka (本店は○○)".
STEP 3 — Confirm INDEPENDENCE. If it is a branch/子会社 of an OPERATING parent based OUTSIDE Shizuoka → screened_out, reason="subsidiary of <parent> (HQ outside Shizuoka)". NOTE: a 〇〇ホールディングス family holding parent = INDEPENDENT (keep). A PE fund or large shareholder does NOT make it dependent (keep).
STEP 4 — Exclusions: bank / securities / 信用金庫 / captive finance company, or sports club → screened_out with that reason.
STEP 5 — SIZE for the band test (¥5B–¥100B = 50–1000億円):
  • Prefer GROUP/consolidated (連結) revenue; else standalone (単体) — set revenueBasis accordingly.
  • For LISTED firms revenue is ALWAYS disclosed: open IR / 決算短信 / 有価証券報告書 and GET it. Do NOT leave revenue blank for a listed firm.
  • Convert carefully: 億円 × 100 = 百万円 (JPY millions). e.g. 250億 = 25,000百万円. Put JPY-millions in revenueJPYM and 億 in revenueOku.
  • revenueJPYM MUST come from an OFFICIAL source (own site / own filing / 官報決算公告). If revenue only exists on a third-party aggregator, leave revenueJPYM=null but put the number in revenueOku and the aggregator in screeningSourceUrls (used for in/out only).
STEP 6 — DECISION:
  • revenue 50–1000億 → qualified.
  • revenue < 50億 AND headcount < 200 → screened_out (reason="too small <¥5B").
  • revenue > 1000億 → screened_out (reason="too large >¥100B").
  • PRIVATE with undisclosed revenue BUT headcount > 200 → qualified.
  • If HQ-in-Shizuoka + independent are CONFIRMED but you can get NEITHER a revenue figure (official or any third-party you actually checked) NOR a headcount → decision=unsizable.
STEP 7 — If qualified (or unsizable), fill OUTPUT columns from the OFFICIAL site ONLY (blank/null if not there): officialUrl, industry, address, zip, representative, registeredCapital(資本金), revenueJPYM(+basis), headcount(従業員数), overseas (海外拠点/海外展開 by COUNTRY, e.g. "China; Thailand; USA"; "None" if domestic-only; null if unstated).
STEP 8 — Flags: familyOwned=true if founding-family controlled / same-surname representative / known family firm. deprioritized=true if core business is automotive, energy, semiconductor, real estate, or high-tech (still keep it, just flag).
List every official URL you pulled cols 7-10 from in officialSourceUrls. Set confidence. Be accurate over complete; null is fine when the official site doesn't show it.`;
}

function qcPrompt(prev, c){
  return `QC RE-CHECK of a sized company. Prior result for "${prev.name}": decision=${prev.decision}, revenueJPYM=${prev.revenueJPYM}, revenueOku=${prev.revenueOku}, basis=${prev.revenueBasis}, headcount=${prev.headcount}, listed=${prev.listed}, officialUrl=${prev.officialUrl}. Discovery hint rev≈${c.revenueEstOku??'?'}億.

Independently RE-VERIFY from the company's OWN official IR / 決算短信 / 有価証券報告書 / 会社概要:
1. Is the revenue figure right? Watch for 億⇄百万 errors (億円×100=百万円; a figure 10× off its source is the classic bug). State group vs standalone correctly.
2. For a LISTED firm revenue must NOT be null — fetch it from IR.
3. Re-confirm the band decision (50–1000億 = qualified) and that HQ is in Shizuoka.
Return the corrected full record (same schema). Cite the official URL(s) in officialSourceUrls. If the prior result was already correct, return it unchanged with confidence=high.`;
}

phase('Verify');
const out = await pipeline(
  CANDS,
  c => agent(vprompt(c), { label:`verify:${c.name}`, phase:'Verify', schema:VSCHEMA, model:'haiku' })
        .then(v => v ? { ...v, _id:c.id, hqCity: v.hqCity || c.hqCity || '', sourceUrls:c.sourceUrls||[], _estOku:c.revenueEstOku??null } : null),
  async (prev, c) => {
    if (!prev) return null;
    const flag = prev.decision==='qualified' && (
      prev.confidence==='low' ||
      (prev.listed && (prev.revenueJPYM==null && prev.revenueOku==null)) ||
      (c.revenueEstOku!=null && prev.revenueOku!=null && (prev.revenueOku > c.revenueEstOku*5 || prev.revenueOku < c.revenueEstOku/5))
    );
    if (!flag) return prev;
    const q = await agent(qcPrompt(prev, c), { label:`qc:${prev.name}`, phase:'QC', schema:VSCHEMA, model:'sonnet' });
    return q ? { ...prev, ...q, _id:prev._id, _qc:true, sourceUrls:prev.sourceUrls } : prev;
  }
);

const rows = out.filter(Boolean);
const q = rows.filter(r=>r.decision==='qualified').length;
const so = rows.filter(r=>r.decision==='screened_out').length;
const un = rows.filter(r=>r.decision==='unsizable').length;
log(`Verify done: ${rows.length} verified | qualified=${q} screened_out=${so} unsizable=${un}`);
return { rows };
