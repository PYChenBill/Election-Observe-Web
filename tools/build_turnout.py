"""整理 2014、2018、2022 各縣市長與各 2026 議員選區的投票率。

輸出 data/turnout_history.json 與 data/turnout_history.csv。

- 縣市長：全縣市及各 2026 議員選區範圍內的縣市長選舉投票率，直接取自 data/real/elections.json
  （同網站提示框，2022 嘉義市為 12/18 重行選舉）。
- 議員：當年區域議員選舉，依 2026 選區範圍的鄉鎮／村里加總投票數與選舉人數；
  原住民選區用當年平地／山地原住民議員選舉，依 2026 選區範圍（全縣市或所列鄉鎮）加總。
  該縣市當年沒有同類原住民選區者為空。
- 投票率＝投票數／選舉人數（中選會定義，投票數含無效票）。

資料來源：中選會選舉資料庫開票檔（github.com/kiang/db.cec.gov.tw 鏡像）。
用法：python3 tools/build_turnout.py <db.cec.gov.tw repo 路徑>
"""
import collections
import csv
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from turnout_lib import Prof, town_base  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path(sys.argv[1])
VD = SRC / "voteData"
YEARS = (2014, 2018, 2022)


def council_dirs(year):
    if year == 2022:
        y = VD / "2022-111年地方公職人員選舉"
        return {"區域": [y / "T1/prv", y / "T1/city"], "平地": [y / "T2/prv", y / "T2/city"], "山地": [y / "T3/prv", y / "T3/city"]}
    y = VD / {2014: "2014-103年地方公職人員選舉", 2018: "2018-107年地方公職人員選舉"}[year]
    return {k: [y / f"直轄市{f}議員", y / f"縣市{f}議員"] for k, f in (("區域", "區域"), ("平地", "平原"), ("山地", "山原"))}


def rate(v):
    voted, electors = v
    return {"voted": voted, "electors": electors, "turnout": round(voted / electors * 100, 2)} if electors else None


def main():
    zones = list(csv.DictReader(open(SRC / "data/council/2026/zones.csv", encoding="utf-8")))
    cunli = list(csv.DictReader(open(SRC / "data/council/2026/cunli.csv", encoding="utf-8")))
    seats = json.load(open(ROOT / "tools/seats_2026.json", encoding="utf-8"))
    real = json.load(open(ROOT / "data/real/elections.json", encoding="utf-8"))["counties"]
    council = {y: {k: Prof(*ds) for k, ds in council_dirs(y).items()} for y in YEARS}

    zone_villages = collections.defaultdict(list)
    town_zones = collections.defaultdict(set)
    for r in cunli:
        zone_villages[r["zone"]].append((r["area"], r["village"]))
        town_zones[(r["zone"][:5], r["area"])].add(r["zone"])
    by_county = collections.defaultdict(list)
    for z in zones:
        by_county[z["code"][:5]].append(z)
    report = []

    def zone_sum(prof, code, z, label):
        towns = prof.towns(code)
        acc = [0, 0]
        for t in z["areas"].split("/"):
            parts = []
            if len(town_zones[(code, t)]) == 1:
                if town_base(t) not in towns:
                    report.append(f"{label} {z['zone']} 找不到鄉鎮 {t}")
                parts.append(towns.get(town_base(t), [0, 0]))
            else:
                miss = []
                for full, v in zone_villages[z["code"]]:
                    if full != t:
                        continue
                    key = (code, town_base(full), v)
                    if key in prof.village:
                        parts.append(prof.village[key])
                    else:
                        miss.append(v)
                if miss:
                    report.append(f"{label} {z['zone']} {t} 村里對不到（未計入）：{'、'.join(miss)}")
            for p in parts:
                acc[0] += p[0]
                acc[1] += p[1]
        return acc

    def scope_towns(scope):
        if not scope:
            return None
        return {town_base(s if s[-1] in "區鄉鎮市" else s + "區") for s in re.split("[、及]", scope) if s}

    out = {}
    for code, zs in by_county.items():
        rc = real[code]
        mayor = {str(h["year"]): rate((h["voted"], h["electors"])) if h.get("electors") else None for h in rc["mayorHistory"]}
        districts = []
        for z, rd in zip(zs, rc["districts"]):
            n = int(z["code"][-2:])
            assert rd["no"] == n
            mh = {h["year"]: h for h in rd["mayorHistory"]}
            districts.append({
                "no": n, "name": f"第{n}選區", "towns": z["areas"].split("/"),
                "mayor": {str(y): rate((mh[y]["voted"], mh[y]["electors"])) if y in mh and mh[y].get("electors") else None for y in YEARS},
                "council": {str(y): rate(zone_sum(council[y]["區域"], code, z, f"{y}區域議員")) for y in YEARS},
            })
        indig = []
        for n, label, s, scope in seats[code]["indigenous"]:
            st = scope_towns(scope)
            res = {}
            for y in YEARS:
                towns = council[y][label[:2]].towns(code)
                acc = [0, 0]
                for t, v in towns.items():
                    if st is None or t in st:
                        acc[0] += v[0]
                        acc[1] += v[1]
                res[str(y)] = rate(acc)
            indig.append({"no": n, "name": f"第{n}選區（{label}）", "scope": scope or "全縣市", "council": res})
        out[code] = {"code": code, "name": rc["name"], "mayor": mayor, "districts": districts, "indigenous": indig}

    nat = {}
    for y in YEARS:
        acc = [0, 0]
        for c in out.values():
            m = c["mayor"].get(str(y))
            if m:
                acc[0] += m["voted"]
                acc[1] += m["electors"]
        nat[str(y)] = rate(acc)
    result = {
        "_note": "投票率＝投票數／選舉人數（%）。縣市長：全縣市與各 2026 議員選區範圍內的縣市長選舉；議員：當年議員選舉依 2026 選區範圍重新加總。"
                 "2014、2018 年選區範圍與 2026 不同者，以 2026 範圍內的鄉鎮／村里加總。原住民選區當年無同類選區者為 null。",
        "source": "中選會選舉資料庫開票檔（github.com/kiang/db.cec.gov.tw 鏡像）",
        "nationalMayor": nat,
        "counties": out,
    }
    (ROOT / "data/turnout_history.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")

    with open(ROOT / "data/turnout_history.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["縣市代碼", "縣市", "類別", "選區", "範圍"] +
                   [f"{y}縣市長投票率" for y in YEARS] + [f"{y}議員投票率" for y in YEARS] +
                   [f"{y}議員選舉人數" for y in YEARS])
        t = lambda r: r["turnout"] if r else ""
        e = lambda r: r["electors"] if r else ""
        for c in out.values():
            w.writerow([c["code"], c["name"], "縣市長", "全縣市", ""] + [t(c["mayor"].get(str(y))) for y in YEARS] + [""] * 6)
            for d in c["districts"]:
                w.writerow([c["code"], c["name"], "區域議員", d["name"], "、".join(d["towns"])] +
                           [t(d["mayor"][str(y)]) for y in YEARS] + [t(d["council"][str(y)]) for y in YEARS] +
                           [e(d["council"][str(y)]) for y in YEARS])
            for d in c["indigenous"]:
                w.writerow([c["code"], c["name"], "原住民議員", d["name"], d["scope"]] + [""] * 3 +
                           [t(d["council"][str(y)]) for y in YEARS] + [e(d["council"][str(y)]) for y in YEARS])
    print(json.dumps(nat, ensure_ascii=False))
    print("\n".join(sorted(set(report))) or "全部對應成功")


main()
