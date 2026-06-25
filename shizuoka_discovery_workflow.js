export const meta = {
  name: 'shizuoka-discovery',
  description: 'Discover candidate companies HQ in Shizuoka across all required source types, dedup, loop until saturated',
  phases: [
    { title: 'Discovery', detail: 'fan out across source types + municipality sweep, loop until 2 dry rounds' },
  ],
}

// ---- dedup helper: NFKC fold, strip corporate-form suffixes + spaces ----
function normKey(name){
  let s = (name||'').normalize('NFKC');
  s = s.replace(/株式会社|有限会社|合同会社|合資会社|合名会社|（株）|\(株\)|（有）|\(有\)|（合）|\(合\)/g, '');
  s = s.replace(/[\s　]/g, '');
  return s.toLowerCase();
}
function merge(into, c){
  // accumulate source urls + best size info
  if (c.sourceUrl && into._srcs.indexOf(c.sourceUrl)<0) into._srcs.push(c.sourceUrl);
  if (into.revenueEstOku==null && c.revenueEstOku!=null) into.revenueEstOku=c.revenueEstOku;
  if (into.headcountEst==null && c.headcountEst!=null) into.headcountEst=c.headcountEst;
  if ((!into.ticker) && c.ticker) { into.ticker=c.ticker; into.listed=true; }
  if (into.sizeBand==='unknown' && c.sizeBand && c.sizeBand!=='unknown') into.sizeBand=c.sizeBand;
  if ((!into.hqCity||into.hqCity==='') && c.hqCity) into.hqCity=c.hqCity;
  if ((!into.industry||into.industry==='') && c.industry) into.industry=c.industry;
}

const SCHEMA = {
  type:'object', additionalProperties:false,
  properties:{
    companies:{ type:'array', items:{
      type:'object', additionalProperties:false,
      properties:{
        name:{type:'string', description:'official Japanese company name as found'},
        hqCity:{type:'string', description:'city in Shizuoka where HQ (本社/本店) is; empty if HQ not in Shizuoka'},
        industry:{type:'string'},
        listed:{type:'boolean'},
        ticker:{type:['string','null']},
        revenueEstOku:{type:['number','null'], description:'rough revenue in 億円 (oku JPY). 50oku=5B, 1000oku=100B'},
        headcountEst:{type:['number','null']},
        sizeBand:{type:'string', enum:['likely_in','too_small','too_big','excluded','unknown']},
        excludeReason:{type:['string','null']},
        sourceUrl:{type:'string'},
        note:{type:['string','null']}
      },
      required:['name','hqCity','industry','listed','sizeBand','sourceUrl']
    }}
  },
  required:['companies']
}

const INDUSTRIES = '機械/金属/電機, 食品・飲料, 化学・素材・医薬, 製紙・パルプ, 輸送機器・自動車部品, 小売・卸売, 建設・不動産, 物流・運輸, サービス(冠婚葬祭/教育/医療/人材), メディア・IT, 繊維・その他製造';
const SCREEN = `SCREENING (tag sizeBand honestly):
- likely_in: revenue roughly 50–1000億円 (¥5–100B), OR revenue unknown but headcount > 200.
- too_small: revenue < 50億 AND headcount < 200.
- too_big: revenue > 1000億 (¥100B).
- excluded: HQ NOT in Shizuoka (本店所在地 outside the prefecture) / bank・securities・captive finance / sports club / a branch or subsidiary whose operating parent is based OUTSIDE Shizuoka. (A 〇〇ホールディングス family parent counts as INDEPENDENT, not excluded.)
- unknown: cannot tell size.
Be INCLUSIVE: when unsure between likely_in and unknown, use unknown (kept for later verification). Only include companies you actually found on a real page; put that page in sourceUrl. HQ (本社/本店) must be in Shizuoka Prefecture (静岡県) — a mere factory/plant there does NOT qualify.`;
const COMMON = `Use WebSearch + WebFetch on REAL pages. Return as many qualifying Shizuoka-HQ companies as you can actually find (aim for completeness, not a sample). ${SCREEN}`;

const ROUND1 = [
  { label:'listed-roster', prompt:`Enumerate the FULL roster of every company whose HEAD OFFICE is in Shizuoka Prefecture and that is LISTED on a Japanese stock exchange (Prime/Standard/Growth/etc). The known total is ~58 companies — keep going until you have the complete roster, do not stop at 20. Use these sources (if one 403s/404s, find an equivalent via search): J-LiC https://j-lic.com/prefectures/22 and its market sub-pages, kabutan/minkabu Shizuoka, Ullet area 22 (https://www.ullet.com), kabutore https://www.kabutore.biz/todofuken/kenno23.html . For each: name, ticker, market, industry, and latest annual revenue (give revenueEstOku in 億円). Listed=true for all. Tag sizeBand by revenue (>1000億 = too_big e.g. Suzuki/Yamaha/Yamaha発動機/浜松ホトニクス; 静岡銀行 = excluded bank). ${COMMON}` },
  { label:'revenue-houjin', prompt:`Walk a revenue (売上高/純売上 net_sales) ranking of companies in Shizuoka Prefecture (pref code 22) down to ¥5B (50億円). Primary source: houjin.jp net_sales ranking for 静岡県 (e.g. https://houjin.jp/ — find the 静岡県 売上高ランキング and page through ALL pages until revenue drops below 50億). Also try 業界動向サーチ, ランキングサイト. Capture every company with revenue ≥ 50億, both listed and private, with revenueEstOku. ${COMMON}` },
  { label:'employee-rank', prompt:`Build a list of Shizuoka-HQ companies ranked by EMPLOYEE COUNT (従業員数) — this catches large PRIVATE firms with undisclosed revenue. Sources: ts-hikaku area 22 (https://ts-hikaku.com/ 静岡県 従業員数), ねとらぼ headcount articles for 静岡県 東部/中部/西部 ("従業員数が多い企業ランキング 静岡"), 転職・就活サイトの従業員数ランキング. Capture every company with headcount > 200, with headcountEst and HQ city. Many will be private (listed=false, revenue unknown→sizeBand likely_in if headcount>200). ${COMMON}` },
  { label:'famous-private-assoc', prompt:`Find well-known PRIVATE / family-owned / 老舗 / regional companies HQ'd in Shizuoka, and members of industry associations & chambers of commerce. Sources: "静岡 有名企業 非上場", "静岡 同族会社 / ファミリー企業", 静岡県経営者協会, 各市 商工会議所 会員名簿 (静岡/浜松/沼津/富士), 業界団体 (食品・製紙・茶業・輸送機器). Focus on firms likely ¥5–100B or >200 employees. ${COMMON}` },
  { label:'muni-shizuoka-city', prompt:`Municipality sweep — 静岡市 (Shizuoka City, incl 葵区/駿河区/清水区). Find companies HQ'd here across EACH industry: ${INDUSTRIES}. Search "静岡市 本社 企業 売上"/"清水 企業" etc. ${COMMON}` },
  { label:'muni-hamamatsu', prompt:`Municipality sweep — 浜松市 (Hamamatsu City). Find HQ'd companies across EACH industry: ${INDUSTRIES}. Hamamatsu is strong in 輸送機器・楽器・光・繊維. Search "浜松市 本社 企業 売上". ${COMMON}` },
  { label:'muni-tobu-A', prompt:`Municipality sweep — 沼津市・三島市・裾野市・御殿場市 (東部). Find HQ'd companies across EACH industry: ${INDUSTRIES}. Search each city + "本社 企業 売上". ${COMMON}` },
  { label:'muni-tobu-B', prompt:`Municipality sweep — 富士市・富士宮市 (東部). Strong in 製紙・パルプ・化学. Find HQ'd companies across EACH industry: ${INDUSTRIES}. Search each city + "本社 企業 製紙 売上". ${COMMON}` },
  { label:'muni-chubu', prompt:`Municipality sweep — 島田市・焼津市・藤枝市 (中部). Strong in 食品・水産・茶・物流. Find HQ'd companies across EACH industry: ${INDUSTRIES}. ${COMMON}` },
  { label:'muni-seibu', prompt:`Municipality sweep — 磐田市・掛川市・袋井市・湖西市 (西部). Strong in 輸送機器部品・電機・化学・食品. Find HQ'd companies across EACH industry: ${INDUSTRIES}. ${COMMON}` },
]

const seen = new Map();
const roundLog = [];
let dry = 0, round = 0;
const MAXR = 5;

while (dry < 2 && round < MAXR) {
  round++;
  phase(`Round ${round}`);
  let agents;
  if (round === 1) {
    agents = ROUND1;
  } else {
    const names = [...seen.values()].map(c=>c.name).join(' / ');
    agents = [
      { label:`houjin-deep-r${round}`, prompt:`Gap-fill round. Page DEEPER into Shizuoka (pref 22) revenue rankings on houjin.jp and 業界動向 sites, focusing on the 50–300億 (¥5–30B) band where smaller firms hide. Also pull 帝国データバンク / 東京商工リサーチ Shizuoka company rankings. Find companies NOT already in this list: ${names}. ${COMMON}` },
      { label:`industry-deep-A-r${round}`, prompt:`Gap-fill: deep dive Shizuoka-HQ firms in 製紙・パルプ / 化学・素材・医薬 / 食品・飲料 / 茶業(製茶) / 水産. Search e.g. "静岡 製紙会社", "富士 製紙 企業", "静岡 食品メーカー 売上", "静岡 製茶 会社", "焼津 水産加工 会社". Find firms NOT already here: ${names}. ${COMMON}` },
      { label:`industry-deep-B-r${round}`, prompt:`Gap-fill: deep dive Shizuoka-HQ firms in 機械・金属・電機 / 輸送機器・自動車部品 / 物流・運輸 / 建設・不動産 / 小売・卸売 / サービス(冠婚葬祭・教育・医療・人材) / メディア・IT. Find firms NOT already here: ${names}. ${COMMON}` },
      { label:`assoc-deep-r${round}`, prompt:`Gap-fill: industry-association & chamber member directories for Shizuoka — 静岡県商工会議所連合会, 浜松・静岡・沼津・富士 商工会議所 会員, 静岡県経営者協会, 各業界団体(輸送機器/食品/製紙/物流). Extract member companies HQ'd in Shizuoka sized ¥5–100B or >200 employees, NOT already here: ${names}. ${COMMON}` },
      { label:`critic-r${round}`, prompt:`COMPLETENESS CRITIC. Here is the current candidate list of Shizuoka-HQ companies:\n${names}\n\nWhat NOTABLE Shizuoka-headquartered companies sized ¥5–100B revenue OR >200 employees are MISSING from this list? Think across all cities (静岡/浜松/沼津/富士/富士宮/磐田/掛川/島田/焼津/袋井/湖西/三島/御殿場/裾野) and industries. Verify each candidate's HQ is actually in Shizuoka via web before returning. Return ONLY companies not already in the list above. ${COMMON}` },
    ];
  }
  const results = await parallel(agents.map(a => () => agent(a.prompt, { label:a.label, phase:`Round ${round}`, schema:SCHEMA, model:'sonnet' })));
  let newInBand = 0, newTotal = 0;
  const covered = [];
  results.forEach((r,i)=>{
    covered.push(agents[i].label);
    if (!r) return;
    for (const c of (r.companies||[])) {
      const key = normKey(c.name);
      if (!key) continue;
      if (seen.has(key)) { merge(seen.get(key), c); continue; }
      const rec = { ...c, _srcs:[c.sourceUrl].filter(Boolean) };
      seen.set(key, rec);
      newTotal++;
      if (c.sizeBand==='likely_in' || c.sizeBand==='unknown') newInBand++;
    }
  });
  roundLog.push({ round, agents:covered, newInBand, newTotal, cumulative:seen.size });
  log(`Round ${round}: +${newInBand} in-band (+${newTotal} total), ${seen.size} cumulative candidates`);
  if (newInBand === 0) dry++; else dry = 0;
}

const ledger = [...seen.values()].map((c,i)=>({
  id:i+1, name:c.name, normKey:normKey(c.name), hqCity:c.hqCity||'', industry:c.industry||'',
  listed:!!c.listed, ticker:c.ticker||null, revenueEstOku:c.revenueEstOku??null,
  headcountEst:c.headcountEst??null, sizeBand:c.sizeBand, excludeReason:c.excludeReason||null,
  sourceUrls:c._srcs||[], note:c.note||null
}));

const byBand = {};
for (const c of ledger) byBand[c.sizeBand]=(byBand[c.sizeBand]||0)+1;
const listedCount = ledger.filter(c=>c.listed).length;
log(`DONE discovery: ${ledger.length} candidates | bands=${JSON.stringify(byBand)} | listed=${listedCount} | rounds=${round} dry=${dry}`);

return { ledger, roundLog, summary:{ total:ledger.length, byBand, listedCount, rounds:round } };
