// 由村里界線合併出 2026 議員選區邊界，輸出 data/districts.topo.json
// 用法：node tools/build_districts_topo.js <villages-mercator-10t.json> <db.cec.gov.tw repo 路徑>
//   villages-mercator-10t.json 來自 npm 套件 taiwan-atlas（內政部村里界圖，已投影）
const fs = require("fs");
const path = require("path");
const topojson = require("../vendor/node/topojson-client.js");
const server = require("../vendor/node/topojson-server.js");

const [villagesPath, repo] = process.argv.slice(2);
const topo = JSON.parse(fs.readFileSync(villagesPath, "utf8"));
const lines = fs.readFileSync(path.join(repo, "data/council/2026/cunli.csv"), "utf8").trim().split(/\r?\n/).slice(1);

const tw = (s) => s.replace(/^台/, "臺");
const zoneOfCode = {};
const zonesOfTown = {};
for (const l of lines) {
  const [zone, city, area, , code] = l.split(",");
  zoneOfCode[code] = zone;
  const k = `${tw(city)}|${area}`;
  (zonesOfTown[k] ||= new Set()).add(zone);
}

const groups = {};
const missing = [];
for (const g of topo.objects.villages.geometries) {
  const p = g.properties;
  let zone = zoneOfCode[p.VILLCODE];
  if (!zone) {
    // 村里代碼對不到時，若整個鄉鎮只屬於一個選區就直接歸入
    const zs = zonesOfTown[`${tw(p.COUNTYNAME)}|${p.TOWNNAME}`];
    if (zs && zs.size === 1) zone = [...zs][0];
    else { missing.push(`${p.COUNTYNAME}${p.TOWNNAME}${p.VILLNAME}`); continue; }
  }
  (groups[zone] ||= []).push(g);
}

const features = Object.entries(groups).map(([zone, geoms]) => ({
  type: "Feature", properties: { id: zone, county: zone.slice(0, 5) }, geometry: topojson.merge(topo, geoms)
}));
const counties = topojson.feature(topo, topo.objects.counties);
const comp = topojson.feature(topo, topo.objects.compBorders);

const out = server.topology({ districts: { type: "FeatureCollection", features }, counties, compBorders: comp }, 1e5);
const dest = path.join(__dirname, "..", "data", "districts.topo.json");
fs.writeFileSync(dest, JSON.stringify(out));
console.log(dest, fs.statSync(dest).size, "districts:", features.length, "unassigned villages:", missing.length, missing.slice(0, 20).join(" "));
