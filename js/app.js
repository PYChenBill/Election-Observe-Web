/*
 * 互動地圖
 * 全臺（縣市）→ 點擊縣市 → 議員選區 + 應選席次圓點
 */
(function () {
  const W = 760, H = 940;
  const svg = d3.select("#map").attr("viewBox", `0 0 ${W} ${H}`);
  const tip = document.getElementById("tip");
  const panel = document.getElementById("panel");
  const crumb = document.getElementById("crumb");

  const state = { meta: null, counties: [], byId: {}, detail: {}, view: null, fillDots: false, transform: { k: 1, x: 0, y: 0 },
    pinned: null, neighbors: {}, mode: "forecast" };
  let unpinTimer = null;

  let topo, projection, path, countyFeatures, districtGeo = {};
  const gView = svg.append("g").attr("class", "viewport");
  const gCounties = gView.append("g").attr("class", "layer-counties");
  const gComp = gView.append("g").attr("class", "layer-comp");
  const gDistricts = gView.append("g").attr("class", "layer-districts");
  const gDots = svg.append("g").attr("class", "layer-dots");

  const party = (k) => state.meta.parties[k] || state.meta.parties.IND;
  const strength = (margin) => 0.42 + Math.min(Math.max(margin, 0), 20) / 20 * 0.58;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const BLANK = "var(--blank)";
  const forecastMode = () => state.mode === "forecast";
  // 底色：預測頁只有填了預測的地方上色，其餘白底；歷史頁看最近一次縣市長選舉
  function countyFill(c) {
    if (forecastMode()) return c.mayor.basis === "prediction" ? { leader: c.mayor.leader, margin: c.mayor.margin } : null;
    const h = c.mayorHistory[c.mayorHistory.length - 1];
    return { leader: h.results[0].party, margin: h.results[0].share - (h.results[1] ? h.results[1].share : 0) };
  }
  function districtFill(d) {
    if (forecastMode()) return d.mayorForecast ? { leader: d.mayorForecast.leader, margin: d.mayorForecast.margin } : null;
    return districtMayor(d);
  }
  function applyFill(sel, fillOf, ms) {
    sel.classed("is-blank", (x) => !fillOf(x));
    (ms ? sel.transition().duration(ms) : sel).attr("fill", (x) => { const f = fillOf(x); return f ? party(f.leader).color : BLANK; })
      .attr("fill-opacity", (x) => { const f = fillOf(x); return f ? strength(f.margin) : 1; });
  }
  const seatsOf = (c) => (forecastMode() ? c.seatPredicted || {} : c.seatForecast);
  const dotSeats = (d) => (forecastMode() && d.forecast.basis !== "prediction" ? {} : d.seatsByParty);
  const isTouch = () => window.matchMedia("(hover: none)").matches;

  // ---------- 啟動 ----------
  async function init() {
    topo = window.DISTRICTS_TOPO || (await (await fetch("data/districts.topo.json")).json());
    projection = d3.geoIdentity().fitExtent([[16, 16], [W - 16, H - 16]], topojson.feature(topo, topo.objects.counties));
    path = d3.geoPath(projection);
    countyFeatures = topojson.feature(topo, topo.objects.counties).features;
    const nb = topojson.neighbors(topo.objects.counties.geometries);
    countyFeatures.forEach((f, i) => (state.neighbors[f.properties.COUNTYCODE] = nb[i].map((j) => countyFeatures[j].properties.COUNTYCODE)));
    topojson.feature(topo, topo.objects.districts).features.forEach((f) => {
      const g = f.geometry;
      districtGeo[f.properties.id] = g.type === "Polygon" ? { type: "MultiPolygon", coordinates: [g.coordinates] } : g;
    });

    const [meta, counties] = await Promise.all([API.getMeta(), API.getCounties()]);
    state.meta = meta;
    state.counties = counties;
    counties.forEach((c) => (state.byId[c.id] = c));
    document.getElementById("updated").textContent = `資料更新 ${meta.updatedAt}`;
    document.getElementById("mockflag").hidden = !!meta.hasPredictions;
    const sw = document.getElementById("modeswitch");
    sw.addEventListener("click", () => setMode(state.mode === "forecast" ? "history" : "forecast"));

    drawCounties();
    gComp.append("path").attr("class", "comp").attr("d", path(topojson.mesh(topo, topo.objects.compBorders)));
    renderNationPanel();

    const fromHash = countyFromHash();
    if (fromHash) openCounty(fromHash, false); else setCrumb();
    window.addEventListener("hashchange", () => {
      const c = countyFromHash();
      if (c && c !== state.view) openCounty(c, true);
      if (!c && state.view) closeCounty();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!tip.hidden && state.pinned) hideTip(); else { hideTip(); if (state.view) closeCounty(); }
    });
    svg.on("click", (e) => { if (e.target === svg.node()) hideTip(); });
  }

  function countyFromHash() {
    const m = location.hash.match(/^#county-([A-Z])$/);
    if (!m) return null;
    const f = countyFeatures.find((f) => f.properties.COUNTYID === m[1]);
    return f ? f.properties.COUNTYCODE : null;
  }

  // ---------- 全臺縣市 ----------
  function drawCounties() {
    gCounties.selectAll("path")
      .data(countyFeatures, (d) => d.properties.COUNTYCODE)
      .join("path")
      .attr("class", "region county")
      .attr("d", path)
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", (d) => `${state.byId[d.properties.COUNTYCODE].name}，點擊查看議員選區`)
      .call((sel) => applyFill(sel, (d) => countyFill(state.byId[d.properties.COUNTYCODE])))
      .on("mouseenter focus", function (e, d) {
        const code = d.properties.COUNTYCODE;
        if (state.view === code) return;
        d3.select(this).raise().classed("is-hover", true);
        if (state.view) {  // 縣市層：旁邊的縣市可點擊切換
          const show = () => showTip(switchTip(state.byId[code]), e, false, true);
          if (!isTouch() && !requestUnpin(show)) show();
          return;
        }
        highlightRow(code, true);
        if (isTouch() || state.pinned === code) return;
        const show = () => showTip(countyTip(state.byId[code]), e);
        if (!requestUnpin(show)) show();
      })
      .on("mousemove", (e) => { if (!isTouch()) moveTip(e); })
      .on("mouseleave blur", function (e, d) {
        clearTimeout(unpinTimer);
        d3.select(this).classed("is-hover", false);
        highlightRow(d.properties.COUNTYCODE, false);
        if (!state.pinned) hideTip();
      })
      .on("click", (e, d) => { if (state.view !== d.properties.COUNTYCODE) go(d.properties.COUNTYCODE); })
      .on("keydown", (e, d) => { if (e.key === "Enter" && state.view !== d.properties.COUNTYCODE) go(d.properties.COUNTYCODE); });
  }

  function setMode(mode) {
    state.mode = mode;
    document.getElementById("modeswitch").setAttribute("aria-checked", String(mode === "history"));
    document.getElementById("mockflag").hidden = mode === "history" || !!state.meta.hasPredictions;
    hideTip();
    applyFill(gCounties.selectAll("path"), (d) => countyFill(state.byId[d.properties.COUNTYCODE]), 300);
    applyFill(gDistricts.selectAll("path"), (s) => districtFill(s.d), 300);
    if (state.view) {
      const c = state.detail[state.view];
      renderCountyPanel(c);
      drawDots(c.districts.filter((d) => districtGeo[d.id]).map((d) => ({ d, geo: districtGeo[d.id] })), state.transform);
    } else renderNationPanel();
  }

  function go(name) {
    const f = countyFeatures.find((f) => f.properties.COUNTYCODE === name);
    location.hash = `county-${f.properties.COUNTYID}`;
  }

  // ---------- 縣市 → 議員選區 ----------
  async function openCounty(name, animate = true) {
    hideTip();
    state.view = name;
    const detail = state.detail[name] || (state.detail[name] = await API.getCounty(name));
    if (state.view !== name) return;

    const feature = countyFeatures.find((f) => f.properties.COUNTYCODE === name);
    const [[x0, y0], [x1, y1]] = path.bounds(feature);
    const pad = 0.86;
    const k = Math.min(pad * W / (x1 - x0), pad * H / (y1 - y0), 60);
    const t = { k, x: W / 2 - k * (x0 + x1) / 2, y: H / 2 - k * (y0 + y1) / 2 };

    svg.classed("is-zoomed", true);
    gCounties.selectAll("path").classed("is-hover", false)
      .classed("is-current", (d) => d.properties.COUNTYCODE === name)
      .classed("is-neighbor", (d) => state.neighbors[name].includes(d.properties.COUNTYCODE))
      .attr("aria-label", (d) => `${state.byId[d.properties.COUNTYCODE].name}，點擊切換`);
    gDots.selectAll("*").remove();

    const shapes = detail.districts.filter((d) => districtGeo[d.id]).map((d) => ({ d, geo: districtGeo[d.id] }));

    gDistricts.selectAll("path").remove();
    gDistricts.selectAll("path")
      .data(shapes)
      .join("path")
      .attr("class", "region district")
      .attr("d", (s) => path(s.geo))
      .attr("tabindex", 0)
      .attr("aria-label", (s) => `${s.d.name}，應選 ${s.d.seats} 席`)
      .call((sel) => applyFill(sel, (s) => districtFill(s.d)))
      .style("opacity", 0)
      .on("mouseenter focus", function (e, s) {
        d3.select(this).raise().classed("is-hover", true);
        highlightRow(s.d.id, true);
        liftDots(s.d.id, true);
        if (isTouch() || state.pinned === s.d.id) return;
        // 已有常駐明細時，滑到別的選區稍停才恢復 hover，避免移向明細框途中經過其他選區就被換掉
        if (!requestUnpin(() => showTip(districtTip(s.d, detail), e))) showTip(districtTip(s.d, detail), e);
      })
      .on("mousemove", (e) => { lastMouse = e; if (!isTouch()) moveTip(e); })
      .on("mouseleave blur", function (e, s) {
        clearTimeout(unpinTimer);
        d3.select(this).classed("is-hover", false);
        highlightRow(s.d.id, false);
        liftDots(s.d.id, false);
        if (!isTouch() && !state.pinned) hideTip();
      })
      .on("click", (e, s) => {
        if (isTouch()) { showTip(districtTip(s.d, detail), e, true); return; }
        if (state.pinned === s.d.id) { hideTip(); showTip(districtTip(s.d, detail), e); return; }  // 再點一次取消常駐
        if (tip.hidden) showTip(districtTip(s.d, detail), e);
        pinTip(s.d.id);
      });

    renderCountyPanel(detail);
    setCrumb(detail);

    zoomTo(t, animate ? 750 : 0, () => {
      if (state.view !== name) return;
      gDistricts.selectAll("path").transition().duration(animate ? 280 : 0).style("opacity", 1);
      drawDots(shapes, t);
    });
  }

  function closeCounty() {
    state.view = null;
    hideTip();
    gDots.selectAll("*").remove();
    gDistricts.selectAll("path").transition().duration(200).style("opacity", 0).remove();
    svg.classed("is-zoomed", false);
    gCounties.selectAll("path").classed("is-current", false).classed("is-neighbor", false)
      .attr("aria-label", (d) => `${state.byId[d.properties.COUNTYCODE].name}，點擊查看議員選區`);
    zoomTo({ k: 1, x: 0, y: 0 }, 650);
    renderNationPanel();
    setCrumb();
    if (location.hash) history.pushState("", document.title, location.pathname + location.search);
  }

  // 滑鼠滾輪縮放、拖曳平移（兩層都可用）；觸控裝置維持原本的頁面捲動
  const zoom = d3.zoom()
    .filter((e) => (e.type === "wheel" || e.type === "mousedown") && !e.button)
    .scaleExtent([1, 24])
    .on("zoom", (e) => {
      const t = e.transform;
      state.transform = { k: t.k, x: t.x, y: t.y };
      gView.attr("transform", t);
      svg.style("--lift", `${3.5 / t.k}px`).style("--stroke", `${1 / t.k}`);
      positionDots(state.transform);
      if (e.sourceEvent && !tip.hidden && !state.pinned) hideTip();
    });
  svg.call(zoom).on("dblclick.zoom", null);

  function zoomTo(t, ms, cb) {
    // 縣市層可縮小到基準的 0.6 倍、放大到 10 倍；全臺層 1–24 倍
    zoom.scaleExtent(state.view ? [t.k * 0.6, t.k * 10] : [1, 24]);
    const target = d3.zoomIdentity.translate(t.x, t.y).scale(t.k);
    if (!ms) { svg.interrupt().call(zoom.transform, target); if (cb) cb(); return; }
    let done = false;
    const finish = () => { if (!done && cb) { done = true; cb(); } };
    svg.transition().duration(ms).ease(d3.easeCubicInOut).call(zoom.transform, target)
      .on("end", finish).on("interrupt", finish);
  }

  // ---------- 應選席次圓點 ----------
  function interiorPoint(geo) {
    // 取面積最大的多邊形，以格點近似「離邊界最遠」的內部點
    let best = null, bestArea = -1;
    for (const poly of geo.coordinates) {
      const ring = poly[0].map((p) => projection(p));
      const a = Math.abs(d3.polygonArea(ring));
      if (a > bestArea) { bestArea = a; best = ring; }
    }
    const [x0, x1] = d3.extent(best, (p) => p[0]);
    const [y0, y1] = d3.extent(best, (p) => p[1]);
    let pt = d3.polygonCentroid(best), score = -1;
    const N = 24;
    for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) {
      const p = [x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * j / N];
      if (!d3.polygonContains(best, p)) continue;
      let m = Infinity;
      for (let q = 0; q < best.length; q += 2) m = Math.min(m, (best[q][0] - p[0]) ** 2 + (best[q][1] - p[1]) ** 2);
      if (m > score) { score = m; pt = p; }
    }
    return pt;
  }

  function drawDots(shapes, t) {
    gDots.selectAll("*").remove();
    dotNodes = [];
    const r = 5.5, gap = 3.5, step = r * 2 + gap;
    // 每個選區一組圓點，放在選區內部；市區選區很小時用碰撞力把圓點組推開並拉一條引線
    const nodes = shapes.map(({ d, geo }) => {
      const [px, py] = interiorPoint(geo);
      const cols = Math.min(d.seats, Math.ceil(Math.sqrt(d.seats * 1.8)));
      const rows = Math.ceil(d.seats / cols);
      const ax = px * t.k + t.x, ay = py * t.k + t.y;
      return { d, cols, rows, ax, ay, x: ax, y: ay, rad: Math.hypot(cols * step, rows * step) / 2 + 2 };
    });
    const sim = d3.forceSimulation(nodes)
      .force("x", d3.forceX((n) => n.ax).strength(0.3))
      .force("y", d3.forceY((n) => n.ay).strength(0.3))
      .force("collide", d3.forceCollide((n) => n.rad).iterations(3))
      .stop();
    for (let i = 0; i < 220; i++) sim.tick();
    nodes.forEach((n) => { n.x = Math.max(n.rad, Math.min(W - n.rad, n.x)); n.y = Math.max(n.rad, Math.min(H - n.rad, n.y)); });
    // 換回地圖座標，縮放時圓點大小不變、位置跟著地圖走
    nodes.forEach((n) => {
      n.mx = (n.x - t.x) / t.k; n.my = (n.y - t.y) / t.k;
      n.amx = (n.ax - t.x) / t.k; n.amy = (n.ay - t.y) / t.k;
      if (Math.hypot(n.x - n.ax, n.y - n.ay) > n.rad * 0.6) {
        n.line = gDots.append("line").attr("class", "seat-leader").attr("data-id", n.d.id);
        n.anchor = gDots.append("circle").attr("class", "seat-anchor").attr("r", 2);
      }
    });
    dotNodes = nodes;
    nodes.forEach(({ d, cols, rows, x: cx, y: cy }) => {
      const seatParties = Object.keys(state.meta.parties).flatMap((k) => Array(dotSeats(d)[k] || 0).fill(k));
      const g = gDots.append("g").attr("class", "seat-group").attr("data-id", d.id);
      nodes.find((n) => n.d === d).g = g;
      g.append("rect").attr("class", "seat-plate")
        .attr("x", -cols * step / 2 - 3).attr("y", -rows * step / 2 - 3)
        .attr("width", cols * step + 6).attr("height", rows * step + 6).attr("rx", r + 3);
      for (let i = 0; i < d.seats; i++) {
        const row = Math.floor(i / cols);
        const inRow = row === rows - 1 ? d.seats - row * cols : cols;
        const col = i - row * cols;
        g.append("circle").attr("class", "seat")
          .attr("r", r)
          .attr("cx", (col - (inRow - 1) / 2) * step)
          .attr("cy", (row - (rows - 1) / 2) * step)
          .attr("data-color", seatParties[i] ? party(seatParties[i]).color : "")
          .style("fill", state.fillDots && seatParties[i] ? party(seatParties[i]).color : null);
      }
    });
    positionDots(state.transform);
    gDots.style("opacity", 0).transition().duration(250).style("opacity", 1);
  }

  let dotNodes = [];
  function positionDots(t) {
    dotNodes.forEach((n) => {
      const x = n.mx * t.k + t.x, y = n.my * t.k + t.y, ax = n.amx * t.k + t.x, ay = n.amy * t.k + t.y;
      if (n.g) n.g.attr("transform", `translate(${x},${y})`);
      if (n.line) n.line.attr("x1", ax).attr("y1", ay).attr("x2", x).attr("y2", y);
      if (n.anchor) n.anchor.attr("cx", ax).attr("cy", ay);
    });
  }

  function liftDots(id, on) { gDots.selectAll(`.seat-group[data-id="${id}"]`).classed("is-hover", on); }

  function setFillDots(on) {
    state.fillDots = on;
    gDots.selectAll("circle.seat").style("fill", function () { return on && this.dataset.color ? this.dataset.color : null; });
  }

  // ---------- 對話框 ----------
  let lastMouse = null;
  function showTip(html, e, sheet, small) {
    clearTimeout(unpinTimer);
    state.pinned = null;
    tip.classList.remove("is-pinned");
    tip.innerHTML = html;
    tip.scrollTop = 0;
    tip.hidden = false;
    tip.classList.toggle("is-sheet", !!sheet);
    tip.classList.toggle("is-small", !!small);
    if (!sheet) moveTip(e);
    else tip.style.left = tip.style.top = "";
  }
  // 明細常駐：對話框停在原位，可捲動、可 hover 圖表
  function pinTip(id) {
    state.pinned = id;
    tip.classList.add("is-pinned");
  }
  // 常駐中移到別處：稍停 260ms 才換回 hover；回傳是否已排程
  function requestUnpin(then) {
    if (!state.pinned) return false;
    clearTimeout(unpinTimer);
    unpinTimer = setTimeout(() => {
      state.pinned = null;
      tip.classList.remove("is-pinned");
      if (then) then(); else tip.hidden = true;
      if (lastMouse) moveTip(lastMouse);
    }, 260);
    return true;
  }
  function moveTip(e) {
    if (e) lastMouse = e;
    if (tip.hidden || tip.classList.contains("is-sheet") || tip.classList.contains("is-pinned")) return;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + 18, y = e.clientY + 18;
    if (x + w + pad > window.innerWidth) x = e.clientX - w - 18;
    if (y + h + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - h - pad);
    tip.style.left = `${Math.max(pad, x)}px`;
    tip.style.top = `${y}px`;
  }
  function hideTip() {
    clearTimeout(unpinTimer);
    state.pinned = null;
    tip.classList.remove("is-pinned");
    tip.hidden = true;
    miniTip.hidden = true;
  }
  tip.addEventListener("mouseenter", () => clearTimeout(unpinTimer));

  // 對話框內的小提示（圓餅圖、歷次縣市長）
  const miniTip = document.createElement("div");
  miniTip.className = "minitip";
  miniTip.hidden = true;
  document.body.appendChild(miniTip);
  tip.addEventListener("pointerover", (e) => {
    const el = e.target.closest("[data-mt]");
    tip.querySelectorAll(".is-on").forEach((x) => x.classList.remove("is-on"));
    if (!el) { miniTip.hidden = true; return; }
    miniTip.innerHTML = el.dataset.mt;
    miniTip.hidden = false;
    if (el.dataset.key) tip.querySelectorAll(`[data-key="${el.dataset.key}"]`).forEach((x) => x.classList.add("is-on"));
    placeMini(e);
  });
  tip.addEventListener("pointermove", (e) => { if (!miniTip.hidden) placeMini(e); });
  tip.addEventListener("pointerleave", () => {
    miniTip.hidden = true;
    tip.querySelectorAll(".is-on").forEach((x) => x.classList.remove("is-on"));
  });
  function placeMini(e) {
    const w = miniTip.offsetWidth, h = miniTip.offsetHeight;
    let x = e.clientX + 14, y = e.clientY - h - 10;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
    if (y < 8) y = e.clientY + 16;
    miniTip.style.left = `${x}px`;
    miniTip.style.top = `${y}px`;
  }
  tip.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) hideTip();
    const g = e.target.closest("[data-go]");
    if (g) { hideTip(); go(g.dataset.go); }
  });

  function partyDot(k) { return `<i class="pdot" style="background:${party(k).color}"></i>`; }

  // 選區底色：該區最近一次縣市長選舉的領先者與領先幅度
  function districtMayor(d) {
    const h = d.mayorHistory && d.mayorHistory[d.mayorHistory.length - 1];
    if (!h || h.results.length < 1) return { leader: d.forecast.leader, margin: d.forecast.margin };
    return { leader: h.results[0].party, margin: h.results[0].share - (h.results[1] ? h.results[1].share : 0) };
  }

  function countyTip(c) {
    const m = c.mayor;
    return `
      <button class="tip-close" type="button" data-close aria-label="關閉">×</button>
      <header class="tip-head"><h3>${esc(c.name)}</h3><span class="tip-sub">2026 縣市長 · ${m.candidates.length} 位候選人</span></header>
      ${mayorList(m)}
      <p class="tip-pin"><span class="tip-pin-off">點右側清單可固定明細</span><span class="tip-pin-on">明細已固定，滑到地圖縣市或按 × 關閉</span></p>
      <section>
        <h4>歷次縣市長選舉 <span class="h4-note">中選會開票結果</span></h4>
        ${histTable(c.mayorHistory)}
      </section>
      <section>
        <h4>議員${seatLabel(c)}</h4>
        ${hemicycle(seatsOf(c), c.totalSeats)}
        <p class="tip-foot">議員應選 ${c.totalSeats} 席 · ${c.candidateCount} 位候選人</p>
      </section>
      <p class="tip-hint"><span class="tip-pin-off">點擊地圖查看議員選區</span><button type="button" class="tip-go tip-pin-on" data-go="${esc(c.id)}">查看議員選區 →</button></p>`;
  }

  function histTable(hist) {
    return `<table class="hist"><thead><tr><th>年</th><th class="num" style="text-align:right">投票率</th><th colspan="2"></th></tr></thead><tbody>${hist.map((h) => `
          <tr data-mt="${esc(histMini(h))}"><th class="num">${h.year}</th>
            <td class="num turnout">${h.turnout != null ? h.turnout.toFixed(1) + "%" : "—"}</td>
            <td><div class="stack thin">${h.results.map((r) => `<span style="flex:${r.share};background:${party(r.party).color}"></span>`).join("")}</div></td>
            <td class="hist-win">${partyDot(h.results[0].party)}${esc(h.results[0].name)} <span class="num">${h.results[0].share.toFixed(1)}%</span></td></tr>`).join("")}
        </tbody></table>`;
  }

  // 半圓議席圖：依席次基準（或預測）上色，滑過顯示政黨席次
  function hemicycle(sf, total) {
    const keys = ["DPP", "NPP", "TPP", "IND", "KMT"].filter((k) => sf[k]);
    const seats = keys.flatMap((k) => Array(sf[k]).fill(k));
    while (seats.length < total) seats.push(null);
    const rows = total <= 12 ? 2 : total <= 30 ? 3 : total <= 48 ? 4 : 5;
    const R = 92, r0 = R * 0.42, W2 = R * 2 + 12;
    const radii = d3.range(rows).map((i) => r0 + (R - r0) * (rows === 1 ? 1 : i / (rows - 1)));
    const sum = d3.sum(radii);
    const counts = radii.map((rr) => Math.round(total * rr / sum));
    counts[rows - 1] += total - d3.sum(counts);
    const pos = [];
    radii.forEach((rr, i) => {
      const n = counts[i];
      for (let j = 0; j < n; j++) {
        const a = Math.PI - (n === 1 ? Math.PI / 2 : (j / (n - 1)) * Math.PI);
        pos.push({ a, x: rr * Math.cos(a), y: -rr * Math.sin(a) });
      }
    });
    pos.sort((p, q) => q.a - p.a);  // 由左到右分配，同黨聚在一起
    const gapMin = Math.min(...radii.map((rr, i) => (Math.PI * rr) / Math.max(1, counts[i] - 1)), (R - r0) / Math.max(1, rows - 1));
    const dr = Math.max(2.2, Math.min(7, gapMin * 0.42));
    const mini = (k) => esc(k ? `${partyDot(k)}<b>${esc(party(k).name)}</b>　<span class="num">${sf[k]}</span> 席` : `未分配 <span class="num">${total - d3.sum(keys, (x) => sf[x])}</span> 席`);
    return `<div class="hemi-wrap"><svg class="hemi" viewBox="${-W2 / 2} ${-R - dr - 2} ${W2} ${R + 2 * dr + 6}" role="img" aria-label="議席圖 ${esc(seatSummary(sf))}">
      ${pos.map((p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${dr.toFixed(1)}" fill="${seats[i] ? party(seats[i]).color : "none"}" class="${seats[i] ? "" : "empty"}" data-key="${seats[i] || "none"}" data-mt="${mini(seats[i])}"></circle>`).join("")}
      <text x="0" y="-4" text-anchor="middle" class="hemi-total">${total}</text>
    </svg>
    <p class="hemi-legend">${keys.map((k) => `<span data-key="${k}" data-mt="${mini(k)}">${partyDot(k)}${party(k).short} <b class="num">${sf[k]}</b></span>`).join("")}</p></div>`;
  }

  function switchTip(c) {
    return `<header class="tip-head"><h3>${esc(c.name)}</h3><span class="tip-sub">議員應選 ${c.totalSeats} 席</span></header>
      <p class="tip-hint">點擊切換到${esc(c.name)}</p>`;
  }

  function districtTip(d, county) {
    const where = d.hasGeometry ? placeText(d) : (d.scope ? `${d.scope}之原住民選民` : "全縣市原住民選民") + "（無地理範圍）";
    const pred = d.forecast.basis === "prediction";
    const maxShare = Math.max(...d.candidates.map((c) => c.share || 0));
    const shares = sortedEntries(d.forecast.partyShares);
    return `
      <button class="tip-close" type="button" data-close aria-label="關閉">×</button>
      <header class="tip-head">
        <h3>${esc(county.name)} ${esc(d.name)}</h3>
        <span class="tip-sub">${esc(where)} · 應選 <b>${d.seats}</b> 席</span>
      </header>
      <p class="tip-pin"><span class="tip-pin-off">點擊選區可固定明細</span><span class="tip-pin-on">明細已固定，滑到其他選區或按 × 關閉</span></p>
      <section>
        <h4>現任議員 <span class="h4-note">2022 年得票，含落選前 2 名</span></h4>
        ${peopleList(d.result2022 || d.incumbents)}
        ${d.incumbentsNote ? `<p class="tip-note">${esc(d.incumbentsNote)}</p>` : ""}
      </section>
      <section>
        <h4>2026 候選人 <span class="h4-note">${d.candidates.length} 人爭取 ${d.seats} 席${pred ? "　✓ 我的預測當選" : ""}</span></h4>
        ${pred
          ? `<ol class="bars">${d.candidates.map((c) => barRow(`${c.elected ? '<b class="ok">✓</b>' : '<b class="ok"></b>'}${esc(c.name)}${c.incumbent ? "<em>現任</em>" : ""}`, c.party, c.share, maxShare)).join("")}</ol>`
          : candList(d.candidates)}
      </section>
      <section>
        <h4>${pred ? "我的預測：政黨得票" : "基準：2022 議員選舉政黨得票"} <span class="h4-note">${pred ? "" : "尚未填入預測"}</span></h4>
        ${shares.length ? pieChart(shares, pred ? null : d.party2022Votes) : `<p class="tip-note">此選區 2022 年未設立，沒有基準資料</p>`}
      </section>
      ${d.mayorForecast ? `<section>
        <h4>我的預測：本區縣市長得票 <span class="h4-note">領先 ${d.mayorForecast.margin.toFixed(1)} 個百分點</span></h4>
        <ol class="bars">${d.mayorForecast.candidates.map((x) => barRow(esc(x.name), x.party, x.share)).join("")}</ol>
      </section>` : ""}
      <section>
        <h4>本區歷次縣市長選舉 <span class="h4-note">中選會開票結果</span></h4>
        ${d.mayorHistory && d.mayorHistory.length ? histTable(d.mayorHistory) : `<p class="tip-note">原住民選區沒有地理範圍，無法對應各區縣市長開票結果</p>`}
      </section>`;
  }

  function peopleList(list) {
    if (!list.length) return `<p class="tip-note">無資料</p>`;
    return `<ol class="people">${list.map((p) => `
      <li class="${p.elected === false ? "lost" : ""}" title="${esc(p.partyName)}">
        <span class="who">${partyDot(p.party)}<b>${esc(p.name)}</b>${p.elected === false ? "<em>落選</em>" : ""}<small>${esc(party(p.party).short)}</small></span>
        <span class="num votes">${p.votes.toLocaleString()} 票</span>
        <span class="num">${p.share != null ? p.share.toFixed(2) + "%" : "—"}</span>
      </li>`).join("")}</ol>`;
  }

  function pieChart(shares, votes) {
    const size = 92, r = size / 2 - 3;
    const arcs = d3.pie().sort(null).value((x) => x[1])(shares);
    const arc = d3.arc().innerRadius(r * 0.5).outerRadius(r).padAngle(0.012);
    const mini = (k, v) => esc(`${partyDot(k)}<b>${esc(party(k).name)}</b><br>得票率 <span class="num">${v.toFixed(2)}%</span>`
      + (votes && votes[k] != null ? `<br>得票數 <span class="num">${votes[k].toLocaleString()}</span>` : ""));
    return `<div class="pie-wrap">
      <svg class="pie" width="${size}" height="${size}" viewBox="${-size / 2} ${-size / 2} ${size} ${size}" role="img" aria-label="政黨得票圓餅圖">
        ${arcs.map((a) => `<path d="${arc(a)}" fill="${party(a.data[0]).color}" data-key="${a.data[0]}" data-mt="${mini(a.data[0], a.data[1])}"></path>`).join("")}
      </svg>
      <ul class="pie-legend">${shares.map(([k, v]) => `<li data-key="${k}" data-mt="${mini(k, v)}"><span>${partyDot(k)}${party(k).short}</span>
        <span class="num">${v.toFixed(1)}%</span><span class="num votes">${votes && votes[k] != null ? votes[k].toLocaleString() + " 票" : ""}</span></li>`).join("")}</ul>
    </div>`;
  }

  function histMini(h) {
    return `<b>${h.year} 縣市長</b>${h.turnout != null ? `　投票率 ${h.turnout.toFixed(2)}%` : ""}`
      + `<table>${h.results.map((r) => `<tr><td>${partyDot(r.party)}${esc(r.name)}</td><td class="num">${r.share.toFixed(2)}%</td><td class="num">${r.votes.toLocaleString()} 票</td></tr>`).join("")}</table>`;
  }

  function sortedEntries(o) { return Object.entries(o || {}).sort((a, b) => b[1] - a[1]); }

  function candList(list) {
    return `<ul class="cands">${list.map((c) => `<li title="${esc(c.partyName)}">${partyDot(c.party)}${esc(c.name)}${c.incumbent ? "<em>現任</em>" : ""}</li>`).join("")}</ul>`;
  }

  function mayorList(m) {
    return m.basis === "prediction"
      ? `<ol class="bars">${m.candidates.map((x) => barRow(esc(x.name) + (x.incumbent ? "<em>現任</em>" : ""), x.party, x.share ?? 0)).join("")}</ol>`
      : `<ul class="cands mayor">${m.candidates.map((x) => `<li>${partyDot(x.party)}${esc(x.name)}<small>${esc(x.partyName)}</small>${x.incumbent ? "<em>現任</em>" : ""}</li>`).join("")}</ul>`;
  }

  function seatLabel(c) {
    return forecastMode() ? "席次預測" : "席次基準（依 2022 政黨得票推估）";
  }

  function placeText(d) {
    const v = d.villages && d.villages.length;
    return d.towns.map((t) => (v ? `${t}（部分，${v} 里）` : t)).join("、");
  }

  function lastMayor(hist) {
    const h = hist && hist[hist.length - 1];
    if (!h) return "";
    return `<p class="tip-foot">${h.year} 實際：${h.results.slice(0, 2).map((r) =>
      `${partyDot(r.party)}${esc(r.name)} <span class="num">${r.share.toFixed(1)}%</span>`).join("　")}</p>`;
  }

  function barRow(label, p, share, max = 100) {
    return `<li><span class="bar-label">${label}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(share / max) * 100}%;background:${party(p).color}"></span></span>
      <span class="num">${share.toFixed(1)}%</span></li>`;
  }

  function seatSummary(sf) {
    return Object.keys(state.meta.parties).filter((k) => sf[k])
      .map((k) => `${party(k).short} ${sf[k]}`).join("、");
  }

  // ---------- 側欄 ----------
  function legendHtml() {
    return `<div class="legend">
      ${["KMT", "DPP", "TPP", "NPP", "IND"].map((k) => `<span>${partyDot(k)}${party(k).short}</span>`).join("")}
      <p>${forecastMode()
        ? (state.meta.hasPredictions ? "底色為預測領先陣營，顏色越深領先越多；尚未預測的地區為白色。" : "尚未填入預測，地圖先以白色呈現。切換到「歷史紀錄」可看歷屆實際結果。")
        : "底色為 2022 縣市長實際得票領先政黨（縣市與議員選區都看該區 2022 縣市長得票）；顏色越深，領先越多。"}</p></div>`;
  }

  function renderNationPanel() {
    const led = {};
    let unpredicted = 0;
    state.counties.forEach((c) => {
      const f = countyFill(c);
      if (f) led[f.leader] = (led[f.leader] || 0) + 1; else unpredicted++;
    });
    const fm = forecastMode();
    // 直轄市 → 省轄市 → 其他縣市（由北到南、由西到東，離島最後）
    const order = ["63000", "65000", "68000", "66000", "67000", "64000", "10017", "10018", "10020",
      "10004", "10005", "10007", "10008", "10009", "10010", "10013", "10002", "10015", "10014", "10016", "09020", "09007"];
    const rank = (id) => (order.includes(id) ? order.indexOf(id) : 99);
    const sorted = [...state.counties].sort((a, b) => rank(a.id) - rank(b.id));
    const groupOf = (id) => (rank(id) < 6 ? "直轄市" : rank(id) < 9 ? "省轄市" : "縣");
    panel.innerHTML = `
      <p class="eyebrow">${esc(state.meta.election)} · 投票日 ${state.meta.voteDate.replace(/-/g, "/")}</p>
      <h2>${fm ? "2026 縣市長預測" : "縣市長歷史紀錄"}</h2>
      <div class="tally">${Object.keys(state.meta.parties).filter((k) => led[k]).map((k) =>
        `<div class="tally-item" style="--c:${party(k).color}"><span class="num">${led[k]}</span>${party(k).short}</div>`).join("")}${unpredicted
        ? `<div class="tally-item" style="--c:var(--line)"><span class="num">${unpredicted}</span>尚未預測</div>` : ""}</div>
      ${legendHtml()}
      ${fm ? `<div class="crow-head f"><span></span><span style="text-align:left">預測領先</span><span>得票率</span><span>領先</span></div>`
        : `<div class="crow-head"><span></span><span>年</span><span>投票率</span><span>當選者</span><span>得票率</span><span>領先</span></div>`}
      <ul class="rows">${sorted.map((c, i) => {
        const h = c.mayorHistory[c.mayorHistory.length - 1];
        const pred = c.mayor.basis !== "2022";
        const w = pred ? null : h.results[0];
        const newGroup = i > 0 && groupOf(c.id) !== groupOf(sorted[i - 1].id);
        if (fm) {
          const top = pred ? c.mayor.candidates.find((x) => x.name === c.mayor.leaderName) : null;
          return `
        <li class="${newGroup ? "grp" : ""}"><button type="button" class="row crow-f" data-row="${esc(c.id)}">
          <span class="row-name">${esc(c.name)}</span>
          ${pred ? `<span class="row-who">${partyDot(c.mayor.leader)}${esc(c.mayor.leaderName)}</span>
          <span class="num">${top && top.share != null ? top.share.toFixed(1) + "%" : "—"}</span>
          <span class="num row-margin">+${c.mayor.margin.toFixed(1)}</span>` : `<span class="none">尚未預測</span>`}
        </button></li>`;
        }
        const hw = h.results[0];
        return `
        <li class="${newGroup ? "grp" : ""}"><button type="button" class="row crow" data-row="${esc(c.id)}">
          <span class="row-name">${esc(c.name)}</span>
          <span class="num">${h.year}</span>
          <span class="num">${h.turnout != null ? h.turnout.toFixed(1) + "%" : "—"}</span>
          <span class="row-who">${partyDot(hw.party)}${esc(hw.name)}</span>
          <span class="num">${hw.share.toFixed(1)}%</span>
          <span class="num row-margin">+${(hw.share - (h.results[1] ? h.results[1].share : 0)).toFixed(1)}</span>
        </button></li>`;
      }).join("")}</ul>`;
    panel.querySelectorAll("[data-row]").forEach((b) => {
      const id = b.dataset.row;
      b.addEventListener("click", () => {
        if (isTouch()) { showTip(countyTip(state.byId[id]), null, true); return; }
        if (state.pinned !== id) { showTip(countyTip(state.byId[id]), { clientX: 0, clientY: 0 }); place(); }
        pinTip(id);
      });
      const place = () => {
        const r = b.getBoundingClientRect();
        tip.style.left = `${Math.max(14, r.left - tip.offsetWidth - 12)}px`;
        tip.style.top = `${Math.max(14, Math.min(r.top - 40, window.innerHeight - tip.offsetHeight - 14))}px`;
      };
      b.addEventListener("mouseenter", () => {
        setMapHover(".county", (d) => d.properties.COUNTYCODE === id, true);
        if (isTouch() || state.pinned === id) return;
        const show = () => { showTip(countyTip(state.byId[id]), { clientX: 0, clientY: 0 }); place(); };
        if (!requestUnpin(show)) show();
      });
      b.addEventListener("mouseleave", () => {
        clearTimeout(unpinTimer);
        setMapHover(".county", () => true, false);
        if (!state.pinned) hideTip();
      });
    });
  }

  function renderCountyPanel(c) {
    const all = [...c.districts, ...c.indigenous];
    const sf = seatsOf(c);
    const seatDots = Object.keys(state.meta.parties).flatMap((k) => Array(sf[k] || 0).fill(k));
    while (seatDots.length < c.totalSeats) seatDots.push(null);
    panel.innerHTML = `
      <button type="button" class="back" id="back">← 回到全臺</button>
      <h2>${esc(c.name)}</h2>
      <p class="eyebrow">議員應選 ${c.totalSeats} 席 · ${all.length} 個選區</p>
      <h3 class="sec">2026 縣市長候選人</h3>
      ${mayorList(c.mayor)}
      ${lastMayor(c.mayorHistory)}
      <h3 class="sec">議員${seatLabel(c)}</h3>
      <div class="seatstrip" aria-label="${seatSummary(sf)}">${seatDots.map((k) => k ? `<i style="background:${party(k).color}"></i>` : `<i class="empty"></i>`).join("")}</div>
      <p class="muted">${seatSummary(sf) || "尚未預測"}</p>
      <label class="toggle"><input type="checkbox" id="fill-dots" ${state.fillDots ? "checked" : ""}> 地圖圓點依${forecastMode() ? "席次預測" : "席次基準"}填入政黨顏色</label>
      ${legendHtml()}
      <h3 class="sec">議員選區</h3>
      <ul class="rows">${all.map((d) => `
        <li><button type="button" class="row" data-row="${esc(d.id)}">
          <span class="row-name">${esc(d.name)}<small>${esc(d.hasGeometry ? placeText(d) : (d.scope || "全縣市") + "（無地理範圍）")}</small></span>
          <span class="row-who">${partyDot(d.forecast.leader)}${party(d.forecast.leader).short}</span>
          <span class="num row-margin">${d.seats} 席</span>
        </button></li>`).join("")}</ul>`;
    panel.querySelector("#back").addEventListener("click", closeCounty);
    panel.querySelector("#fill-dots").addEventListener("change", (e) => setFillDots(e.target.checked));
    panel.querySelectorAll("[data-row]").forEach((b) => {
      const d = all.find((x) => x.id === b.dataset.row);
      b.addEventListener("mouseenter", () => { setMapHover(".district", (s) => s.d.id === d.id, true); liftDots(d.id, true); });
      b.addEventListener("mouseleave", () => { setMapHover(".district", () => true, false); liftDots(d.id, false); });
      b.addEventListener("click", (e) => {
        const r = b.getBoundingClientRect();
        showTip(districtTip(d, c), { clientX: r.left - 10 - 340, clientY: r.top }, isTouch());
        if (!isTouch()) {
          tip.style.left = `${Math.max(14, r.left - tip.offsetWidth - 12)}px`;
          pinTip(d.id);
        }
      });
    });
  }

  function setMapHover(sel, match, on) {
    svg.selectAll(sel).each(function (d) {
      if (on && match(d)) d3.select(this).raise().classed("is-hover", true);
      else if (!on) d3.select(this).classed("is-hover", false);
    });
  }
  function highlightRow(id, on) {
    const el = panel.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (el) el.classList.toggle("is-hover", on);
  }

  function setCrumb(c) {
    crumb.innerHTML = c
      ? `<a href="#" id="crumb-home">全臺</a><span aria-hidden="true">›</span><strong>${esc(c.name)}</strong><span class="crumb-note">議員選區</span>`
      : `<strong>全臺</strong><span class="crumb-note">點選縣市查看議員選區</span>`;
    const home = document.getElementById("crumb-home");
    if (home) home.addEventListener("click", (e) => { e.preventDefault(); closeCounty(); });
  }

  init().catch((err) => {
    panel.innerHTML = `<p class="error">地圖載入失敗：${esc(err.message)}。請重新整理頁面。</p>`;
    console.error(err);
  });
})();
