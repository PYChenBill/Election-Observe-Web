/*
 * 資料後端（暫時版，靜態檔案）
 * ------------------------------------------------------------
 * data/real/elections.json（tools/build_real_data.py 產生）：
 *   - 2026 議員選區範圍與應選名額（中選會公告）
 *   - 2026 候選人（島民觀察室整理之登記名冊，截至 2026-10-08；已扣除 10-16 中選會審定未通過者）
 *   - 現任議員（2022 年當選人）、2022 議員選舉各選區政黨得票
 *   - 各選區、各縣市 2014 / 2018 / 2022 縣市長選舉結果
 * data/predictions.json：你自己的預測（候選人得票率）。有填的地方以預測為準；
 *   沒填的地方以 2022 實際得票當「基準」：縣市以 2022 縣市長結果、議員選區以 2022 議員選舉政黨得票。
 */
(function () {
  const PARTIES = {
    KMT: { name: "中國國民黨", short: "國民黨", color: "#1F4FA8" },
    DPP: { name: "民主進步黨", short: "民進黨", color: "#1E8F4A" },
    TPP: { name: "台灣民眾黨", short: "民眾黨", color: "#25AFB0" },
    NPP: { name: "時代力量", short: "時力", color: "#E3B21F" },
    IND: { name: "無黨籍及其他", short: "無黨籍", color: "#8C95A0" }
  };

  const load = (globalName, url) => (window[globalName]
    ? Promise.resolve(window[globalName])
    : fetch(url).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  let dataPromise;
  const data = () => (dataPromise ||= Promise.all([
    load("REAL_ELECTIONS", "data/real/elections.json"),
    load("PREDICTIONS", "data/predictions.json")
  ]));

  const sortedShares = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

  // 依預測得票率標出前 N 名當選，並加總為政黨得票
  function applyPrediction(candidates, pred, seats) {
    const list = candidates.map((c) => ({ ...c, share: pred[c.name] ?? null, elected: false }));
    const ranked = list.filter((c) => c.share != null).sort((a, b) => b.share - a.share);
    ranked.slice(0, seats).forEach((c) => (c.elected = true));
    list.sort((a, b) => (b.share ?? -1) - (a.share ?? -1));
    const partyShares = {};
    ranked.forEach((c) => (partyShares[c.party] = +((partyShares[c.party] || 0) + c.share).toFixed(1)));
    return { list, partyShares };
  }

  // 基準席次：以 2022 政黨得票做最高平均數法分配，但不超過該黨 2026 登記人數
  function dhondt(shares, seats, caps) {
    const won = {};
    for (let i = 0; i < seats; i++) {
      let best = null, bestQ = -1;
      for (const [k, v] of Object.entries(shares)) {
        if ((won[k] || 0) >= (caps[k] || 0)) continue;
        const q = v / ((won[k] || 0) + 1);
        if (q > bestQ) { bestQ = q; best = k; }
      }
      if (!best) break;
      won[best] = (won[best] || 0) + 1;
    }
    return won;
  }

  // 本區縣市長預測：{ 候選人: 得票率 }，用來決定預測頁的選區底色
  function districtMayor(mayorCandidates, pred) {
    if (!pred || !Object.keys(pred).length) return null;
    const top = applyPrediction(mayorCandidates, pred, 1).list.filter((x) => x.share != null);
    if (!top.length) return null;
    return { candidates: top, leader: top[0].party, leaderName: top[0].name,
      margin: +(top[0].share - (top[1] ? top[1].share : 0)).toFixed(1) };
  }

  function buildDistrict(d, pred, mayorForecast = null) {
    const caps = {};
    d.candidates.forEach((c) => (caps[c.party] = (caps[c.party] || 0) + 1));
    let candidates, partyShares, seatsByParty, basis;
    if (pred && Object.keys(pred).length) {
      const r = applyPrediction(d.candidates, pred, d.seats);
      candidates = r.list; partyShares = r.partyShares; basis = "prediction";
      seatsByParty = {};
      candidates.filter((c) => c.elected).forEach((c) => (seatsByParty[c.party] = (seatsByParty[c.party] || 0) + 1));
    } else {
      candidates = d.candidates.map((c) => ({ ...c, share: null, elected: false }))
        .sort((a, b) => b.incumbent - a.incumbent);
      partyShares = d.party2022 || {};
      seatsByParty = dhondt(partyShares, d.seats, caps);
      basis = "2022";
    }
    const s = sortedShares(partyShares);
    return {
      ...d, hasGeometry: !!d.towns, candidates, seatsByParty, mayorForecast,
      forecast: { basis, partyShares, leader: s.length ? s[0][0] : null, margin: s.length ? +(s[0][1] - (s[1] ? s[1][1] : 0)).toFixed(1) : 0 }
    };
  }

  function buildMayor(c, pred) {
    if (pred && Object.keys(pred).length) {
      const { list } = applyPrediction(c.mayorCandidates, pred, 1);
      const top = list.filter((x) => x.share != null);
      return { basis: "prediction", candidates: list, leader: top[0].party, leaderName: top[0].name,
        margin: +(top[0].share - (top[1] ? top[1].share : 0)).toFixed(1) };
    }
    const h = c.mayorHistory[c.mayorHistory.length - 1];
    return { basis: "2022", candidates: c.mayorCandidates.map((x) => ({ ...x, share: null })).sort((a, b) => b.incumbent - a.incumbent),
      leader: h.results[0].party, leaderName: h.results[0].name, margin: +(h.results[0].share - h.results[1].share).toFixed(1) };
  }

  const cache = {};
  function buildCounty(c, preds) {
    if (cache[c.code]) return cache[c.code];
    const p = preds[c.code] || {};
    const dp = p.districts || {};
    const mp = p.mayorByDistrict || {};
    const districts = c.districts.map((d) => buildDistrict(d, dp[d.no], districtMayor(c.mayorCandidates, mp[d.no])));
    const indigenous = c.indigenous.map((d) => buildDistrict(d, dp[d.no]));
    const seatForecast = {}, seatPredicted = {};
    [...districts, ...indigenous].forEach((d) => Object.entries(d.seatsByParty).forEach(([k, n]) => {
      seatForecast[k] = (seatForecast[k] || 0) + n;
      if (d.forecast.basis === "prediction") seatPredicted[k] = (seatPredicted[k] || 0) + n;
    }));
    return (cache[c.code] = {
      id: c.code, name: c.name, totalSeats: c.totalSeats, seatForecast, seatPredicted,
      seatBasis: Object.keys(dp).length ? "mixed" : "2022",
      mayor: buildMayor(c, p.mayor), mayorHistory: c.mayorHistory, districts, indigenous
    });
  }

  const clone = (v) => JSON.parse(JSON.stringify(v));

  window.MockBackend = {
    // GET /api/meta
    async getMeta() {
      const [d, preds] = await data();
      return { election: "2026 地方公職人員選舉", voteDate: "2026-11-28", updatedAt: "2026-10-16",
        parties: PARTIES, hasPredictions: Object.keys(preds).length > 0, source: d.source };
    },
    // GET /api/counties
    async getCounties() {
      const [d, preds] = await data();
      return Object.values(d.counties).map((c) => {
        const x = buildCounty(c, preds);
        return clone({ id: x.id, name: x.name, totalSeats: x.totalSeats, seatForecast: x.seatForecast, seatPredicted: x.seatPredicted, seatBasis: x.seatBasis,
          candidateCount: [...x.districts, ...x.indigenous].reduce((a, z) => a + z.candidates.length, 0),
          mayor: x.mayor, mayorHistory: x.mayorHistory });
      });
    },
    // GET /api/counties/:id
    async getCounty(id) {
      const [d, preds] = await data();
      if (!d.counties[id]) throw new Error(`找不到縣市：${id}`);
      return clone(buildCounty(d.counties[id], preds));
    }
  };
})();
