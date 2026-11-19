/*
 * 即時開票
 * ------------------------------------------------------------
 * 網站每分鐘讀一次 data/live.json（格式見 README「即時開票資料格式」與 data/live.sample.json），
 * 開票當晚由你的電腦每 1–2 分鐘把中選會資料轉成這個格式並 push；mayor 為空時「開票」分頁不會出現。
 *
 * 網址加 ?sim=1（或 window.LIVE_SIM = true）改用模擬資料：以 data/predictions.json 為中心加上
 * 隨機誤差當作「最後結果」，再依時間推進開票進度。模擬資料不會寫進任何檔案。
 *
 * window.Live = {
 *   start(onFrame)    開始輪詢（或模擬播放），每有新資料呼叫 onFrame(frame)
 *   isSim             是否為模擬
 *   summarize(...)    把 live.json 的一個縣市整理成畫面要用的格式
 * }
 */
(function () {
  const params = new URLSearchParams(location.search);
  const isSim = window.LIVE_SIM === true || params.has("sim");
  const POLL_MS = 60 * 1000;

  // ---------- 共用：整理一個開票單位（縣市長或議員選區） ----------
  // unit = { reported, stations, votes: {姓名: 票數}, elected: 姓名 或 [姓名] }
  function tally(unit, candidates, seats) {
    if (!unit) return null;
    const votes = unit.votes || {};
    const total = Object.values(votes).reduce((a, b) => a + b, 0);
    const elected = new Set([].concat(unit.elected || []));
    const list = candidates.map((c) => ({ ...c, votes: votes[c.name] || 0,
      share: total ? (votes[c.name] || 0) / total * 100 : 0, elected: elected.has(c.name) }))
      .sort((a, b) => b.votes - a.votes || (a.number ?? 99) - (b.number ?? 99));
    list.forEach((c, i) => (c.leading = total > 0 && i < seats));
    const progress = unit.stations ? Math.min(1, unit.reported / unit.stations) : 0;
    return { list, total, progress, reported: unit.reported || 0, stations: unit.stations || 0,
      done: progress >= 1 && elected.size >= Math.min(seats, list.length) };
  }

  // 縣市長：實際 vs 預測。gap > 0 代表我預測的領先者表現比預測更好
  function summarizeMayor(county, unit) {
    const t = tally(unit, county.mayor.candidates, 1);
    if (!t || !t.total) return t && { ...t, leader: null };
    const top = t.list[0], second = t.list[1];
    const r = { ...t, leader: top, margin: top.share - (second ? second.share : 0), winner: t.list.find((c) => c.elected) || null };
    const m = county.mayor;
    if (m.basis === "prediction") {
      const ranked = m.candidates.filter((c) => c.share != null).sort((a, b) => b.share - a.share);
      const pa = ranked[0], pb = ranked[1];
      const act = (name) => (t.list.find((c) => c.name === name) || { share: 0 }).share;
      const predMargin = pa.share - (pb ? pb.share : (m.otherShare ?? 0));
      const actMargin = act(pa.name) - (pb ? act(pb.name) : 100 - act(pa.name) - 0);
      r.pred = { name: pa.name, party: pa.party, share: pa.share, runner: pb ? pb.name : null, runnerParty: pb ? pb.party : "IND", margin: predMargin };
      r.gap = actMargin - predMargin;  // 我預測的勝方，實際領先幅度比預測多（正）或少（負）幾個百分點
      r.gapParty = r.gap >= 0 ? pa.party : (pb ? pb.party : "IND");
      r.flipped = top.name !== pa.name;
      r.shareGap = act(pa.name) - pa.share;
    }
    return r;
  }

  function summarizeDistrict(d, unit) {
    const t = tally(unit, d.candidates, d.seats);
    if (!t) return null;
    // 已當選者先占席次，剩下的席次給目前排名在前、尚未確定的候選人（「領先」）
    const electedSeats = {}, lead = {};
    t.list.filter((c) => c.elected).forEach((c) => (electedSeats[c.party] = (electedSeats[c.party] || 0) + 1));
    let room = d.seats - t.list.filter((c) => c.elected).length;
    t.list.filter((c) => !c.elected && t.total > 0).forEach((c) => { if (room-- > 0) { lead[c.party] = (lead[c.party] || 0) + 1; c.leading = true; } else c.leading = false; });
    return { ...t, electedSeats, leadSeats: lead };
  }

  // ---------- 模擬 ----------
  // 以字串為種子的亂數，讓每次重新整理看到同一場「模擬選舉」
  function rng(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const gauss = (r) => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

  const SIM_START = 16 * 60, SIM_END = 22 * 60;  // 模擬時鐘 16:00 → 22:00
  let simModel = null;

  // 建立模擬選舉：每個縣市的開票速度、最後得票、開票初期偏差
  function buildSim(real, preds, seed) {
    const model = { counties: {} };
    const sizeRank = Object.values(real.counties).map((c) => c.totalSeats).sort((a, b) => a - b);
    Object.values(real.counties).forEach((c) => {
      const r = rng(seed + c.code);
      const p = preds[c.code] || {};
      const size = sizeRank.indexOf(c.totalSeats) / sizeRank.length;  // 大縣市開得慢
      const start = 0.02 + r() * 0.04;
      const end = 0.32 + size * 0.38 + r() * 0.15;
      const electors = p.mayorElectors || (c.mayorHistory.at(-1).electors || 300000);
      const voted = p.mayorVoted || Math.round(electors * (0.58 + r() * 0.1));
      const stations = Math.max(20, Math.round(electors / 1350));

      // 縣市長最後得票率：預測 ± 誤差；「其他」平均分給沒列名的候選人
      const pm = p.mayor || {};
      const named = c.mayorCandidates.filter((x) => pm[x.name] != null);
      const rest = c.mayorCandidates.filter((x) => pm[x.name] == null);
      const base = {};
      c.mayorCandidates.forEach((x) => (base[x.name] = pm[x.name] ?? ((pm["其他"] ?? (named.length ? 2 : 100 / c.mayorCandidates.length)) / Math.max(1, rest.length))));
      const final = {}, bias = {};
      Object.entries(base).forEach(([n, s]) => {
        final[n] = Math.max(0.2, s + gauss(r) * (s > 15 ? 2.6 : 0.6));
        bias[n] = gauss(r) * (s > 15 ? 4.5 : 0.8);
      });
      const council = {};
      [...c.districts, ...c.indigenous].forEach((d) => {
        const rd = rng(seed + d.id);
        const pv = d.party2022Votes || {};
        const dVoted = Math.round((Object.values(pv).reduce((a, b) => a + b, 0) || 15000 * d.seats) * (0.95 + rd() * 0.12));
        const byParty = {};
        d.candidates.forEach((x) => (byParty[x.party] = (byParty[x.party] || 0) + 1));
        const w = {}, b = {};
        d.candidates.forEach((x) => {
          const ps = (d.party2022 || {})[x.party] ?? 4;
          w[x.name] = Math.max(0.3, (ps / byParty[x.party]) * Math.exp(gauss(rd) * 0.35) * (x.incumbent ? 1.25 : 1));
          b[x.name] = gauss(rd) * w[x.name] * 0.25;
        });
        const sum = Object.values(w).reduce((a, z) => a + z, 0);
        Object.keys(w).forEach((k) => (w[k] = w[k] / sum * 100));
        council[d.no] = { voted: dVoted, final: w, bias: b, stations: Math.max(4, Math.round(dVoted / 900)), seats: d.seats,
          lag: (rd() - 0.5) * 0.08, names: d.candidates.map((x) => x.name) };
      });
      model.counties[c.code] = { start, end, voted, stations, final, bias, council };
    });
    return model;
  }

  // 依「目前得票率」把票數分給各候選人；初期偏差（百分點）隨開票進度消失
  function counted(final, bias, p, voted) {
    const cur = {};
    let sum = 0;
    Object.keys(final).forEach((n) => { cur[n] = Math.max(0.05, final[n] + bias[n] * (1 - p) ** 1.3); sum += cur[n]; });
    const out = {};
    Object.keys(cur).forEach((n) => (out[n] = Math.round(voted * p * cur[n] / sum)));
    return out;
  }

  // 模擬時間 t（0–1）的 live.json
  function simFrame(t) {
    const out = { schema: 1, source: "simulation", updatedAt: null, mayor: {}, council: {} };
    const mins = SIM_START + (SIM_END - SIM_START) * t;
    out.updatedAt = `2026-11-28T${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(Math.floor(mins % 60)).padStart(2, "0")}:00+08:00`;
    Object.entries(simModel.counties).forEach(([code, m]) => {
      const p = smooth((t - m.start) / (m.end - m.start));
      const reported = Math.round(m.stations * p);
      const pr = reported / m.stations;
      const votes = counted(m.final, m.bias, pr, m.voted);
      const ranked = Object.entries(m.final).sort((a, b) => b[1] - a[1]);
      const cur = Object.entries(votes).sort((a, b) => b[1] - a[1]);
      // 當選確定：目前領先者就是最後勝方，且領先票數超過剩餘票數的 35%（模擬媒體宣布的時機）
      const lead = cur.length > 1 ? cur[0][1] - cur[1][1] : cur[0][1];
      const remaining = m.voted * (1 - pr);
      const elected = pr >= 1 || (pr > 0.3 && cur[0][0] === ranked[0][0] && lead > remaining * 0.35) ? ranked[0][0] : null;
      out.mayor[code] = { reported, stations: m.stations, votes, elected };
      const council = {};
      Object.entries(m.council).forEach(([no, d]) => {
        const dp = smooth((t - m.start - 0.01) / (m.end + d.lag - m.start));
        const rep = Math.round(d.stations * dp);
        const dpr = rep / d.stations;
        const v = counted(d.final, d.bias, dpr, d.voted);
        const fin = Object.entries(d.final).sort((a, b) => b[1] - a[1]);
        const cv = Object.entries(v).sort((a, b) => b[1] - a[1]);
        const cutoff = cv[d.seats] ? cv[d.seats][1] : 0;
        const rem = d.voted * (1 - dpr);
        const winners = new Set(fin.slice(0, d.seats).map((x) => x[0]));
        const el = dpr >= 1 ? [...winners]
          : dpr > 0.4 ? cv.slice(0, d.seats).filter(([n, x]) => winners.has(n) && x - cutoff > rem * 0.12).map((x) => x[0]) : [];
        council[no] = { reported: rep, stations: d.stations, votes: v, elected: el };
      });
      out.council[code] = council;
    });
    return out;
  }

  // ---------- 播放控制（模擬）／輪詢（正式） ----------
  const player = { t: 0, playing: false, durationMs: 120000, timer: null, onFrame: null, last: 0 };

  function emit() { player.onFrame(simFrame(player.t)); updateBar(); }

  function tick(now) {
    if (!player.playing) return;
    const dt = now - player.last;
    if (dt >= 1200) {  // 每 1.2 秒更新一次畫面，像真的資料一筆一筆進來
      player.t = Math.min(1, player.t + dt / player.durationMs);
      player.last = now;
      emit();
      if (player.t >= 1) { player.playing = false; updateBar(); return; }
    }
    player.timer = requestAnimationFrame(tick);
  }

  function play(on) {
    player.playing = on;
    if (on) { if (player.t >= 1) player.t = 0; player.last = performance.now(); player.timer = requestAnimationFrame(tick); }
    else cancelAnimationFrame(player.timer);
    updateBar();
  }

  function clock(t) {
    const m = SIM_START + (SIM_END - SIM_START) * t;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.floor(m % 60)).padStart(2, "0")}`;
  }

  let bar;
  function mountBar() {
    bar = document.createElement("div");
    bar.className = "simbar";
    bar.innerHTML = `
      <span class="simbar-tag">模擬開票</span>
      <button type="button" class="simbar-play" aria-label="播放">▶</button>
      <input type="range" min="0" max="1000" value="0" aria-label="模擬時間">
      <span class="simbar-clock num">16:00</span>
      <span class="simbar-speed" role="group" aria-label="播放速度">
        <button type="button" data-ms="360000">慢</button><button type="button" data-ms="120000" aria-pressed="true">中</button><button type="button" data-ms="40000">快</button>
      </span>
      <span class="simbar-note">資料為依我的預測加上隨機誤差產生，非真實開票</span>`;
    document.querySelector(".top").after(bar);
    bar.querySelector(".simbar-play").addEventListener("click", () => play(!player.playing));
    bar.querySelector("input").addEventListener("input", (e) => { player.t = e.target.value / 1000; emit(); });
    bar.querySelectorAll("[data-ms]").forEach((b) => b.addEventListener("click", () => {
      player.durationMs = +b.dataset.ms;
      bar.querySelectorAll("[data-ms]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }));
  }
  function updateBar() {
    if (!bar) return;
    bar.querySelector("input").value = Math.round(player.t * 1000);
    bar.querySelector(".simbar-clock").textContent = clock(player.t);
    const pb = bar.querySelector(".simbar-play");
    pb.textContent = player.playing ? "❚❚" : player.t >= 1 ? "↺" : "▶";
    pb.setAttribute("aria-label", player.playing ? "暫停" : "播放");
  }

  async function poll(onFrame) {
    try {
      // 加時間參數避開 GitHub Pages 約 10 分鐘的快取
      const r = await fetch(`data/live.json?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (j && j.mayor && Object.keys(j.mayor).length) onFrame(j); }
    } catch (e) { /* 還沒有開票資料 */ }
    setTimeout(() => poll(onFrame), POLL_MS);
  }

  window.Live = {
    isSim,
    async start(onFrame) {
      player.onFrame = onFrame;
      if (!isSim) { poll(onFrame); return; }
      const [real, preds] = await window.MockBackend.raw();
      simModel = buildSim(real, preds, "2026-sim-" + (params.get("sim") || "1"));
      mountBar();
      player.t = Math.max(0, Math.min(1, +(params.get("t") || 0.18)));
      emit();
      if (!params.has("paused")) play(true);
    },
    summarizeMayor, summarizeDistrict,
    // 模擬模式下取任一時間點的 live.json（產生範例檔用）
    simFrame: (t) => (simModel ? simFrame(t) : null)
  };
})();
