"""把中選會開票資料整理成前端用的 data/real/elections.json。

資料來源
- 中選會選舉資料庫開票檔（elbase/elcand/elctks/elpaty），取自 kiang/db.cec.gov.tw 的鏡像
  （https://github.com/kiang/db.cec.gov.tw ，voteData/ 目錄，與 db.cec.gov.tw 下載格式相同）
- 2026 議員選區範圍（含以村里切分者）：同一 repo 的 data/council/2026/zones.csv、cunli.csv
- 2026 各選區應選名額：tools/seats_2026.json（中選會 2026-08-20 公告）

用法：python3 tools/build_real_data.py <db.cec.gov.tw repo 路徑>
"""
import collections
import csv
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path(sys.argv[1])
VD = SRC / "voteData"

PARTY_KEY = {"中國國民黨": "KMT", "民主進步黨": "DPP", "台灣民眾黨": "TPP", "時代力量": "NPP"}


def rows(path):
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.reader(f):
            yield [c.strip().strip("'") for c in r]


def norm_county(name):
    return name.replace("台", "臺")


def town_base(name):
    # 員林鎮 / 員林市、桃園市 / 桃園區 等改制前後名稱視為同一行政區
    return name.replace("台", "臺")[:-1] if len(name) > 2 else name.replace("台", "臺")


class Election:
    """一組開票檔（elbase/elcand/elctks/elpaty）。"""

    def __init__(self, *dirs):
        self.names = {}       # (prv, city, dept, li) -> 名稱
        self.area_names = {}  # (prv, city, area) -> 選舉區名稱
        self.cands = {}       # (prv, city, area, candNo) -> dict
        self.ticks = []       # (prv, city, area, dept, li, candNo, votes)
        self.prof = {}        # (prv, city, dept, li) -> (投票數, 選舉人數)，只取彙總列
        for d in dirs:
            party = {r[0]: r[1] for r in rows(d / "elpaty.csv")}
            for p, c, a, dept, li, name in (r[:6] for r in rows(d / "elbase.csv")):
                self.names[(p, c, dept, li)] = name
                if dept == "000" and li == "0000" and a != "00":
                    self.area_names[(p, c, a)] = name
            for r in rows(d / "elcand.csv"):
                p, c, a, dept, li, no, name, pcode = r[:8]
                pname = party.get(pcode, "無黨籍")
                if pname in ("無", "無黨籍及未經政黨推薦", ""):
                    pname = "無黨籍"
                self.cands[(p, c, a, no)] = {
                    "name": name, "partyName": pname, "party": PARTY_KEY.get(pname, "IND"),
                    "incumbent": r[13] == "Y", "elected": r[14] == "*"}
            if (d / "elprof.csv").exists():
                for r in rows(d / "elprof.csv"):
                    if r[5].strip("0") == "":
                        self.prof[(r[0], r[1], r[3], r[4])] = (int(r[8]), int(r[9]))
            for r in rows(d / "elctks.csv"):
                p, c, a, dept, li, tbox, no, votes = r[:8]
                if tbox.strip("0") == "":  # 只取彙總列，不取投開票所列
                    self.ticks.append((p, c, a, dept, li, no, int(votes)))

    def county_code(self, p, c):
        return p + c

    def tally(self, county, level):
        """level='county' | 'town' | 'village'；回傳 {key: Counter(candNo -> votes)} 與候選人表。"""
        out = collections.defaultdict(collections.Counter)
        for p, c, a, dept, li, no, v in self.ticks:
            if p + c != county:
                continue
            if level == "county" and dept == "000" and li == "0000":
                out[a][no] += v
            elif level == "town" and dept != "000" and li == "0000":
                out[town_base(self.names.get((p, c, dept, "0000"), dept))][no] += v
            elif level == "village" and dept != "000" and li != "0000":
                t = town_base(self.names.get((p, c, dept, "0000"), dept))
                out[(t, self.names.get((p, c, dept, li), li))][no] += v
        return out


    def turnout(self, county, level):
        """與 tally 相同層級，回傳 {key: [投票數, 選舉人數]}。"""
        out = collections.defaultdict(lambda: [0, 0])
        for (p, c, dept, li), (voted, electors) in self.prof.items():
            if p + c != county:
                continue
            if level == "county" and dept == "000" and li == "0000":
                key = "all"
            elif level == "town" and dept != "000" and li == "0000":
                key = town_base(self.names.get((p, c, dept, "0000"), dept))
            elif level == "village" and dept != "000" and li != "0000":
                key = (town_base(self.names.get((p, c, dept, "0000"), dept)), self.names.get((p, c, dept, li), li))
            else:
                continue
            out[key][0] += voted
            out[key][1] += electors
        return out


def with_turnout(res, voted, electors):
    if electors:
        res.update(voted=voted, electors=electors, turnout=round(voted / electors * 100, 2))
    return res


def results_from(counter, cand_lookup, top=3):
    total = sum(counter.values())
    res = []
    for no, v in counter.most_common():
        c = cand_lookup(no)
        res.append({"name": c["name"], "party": c["party"], "partyName": c["partyName"],
                    "votes": v, "share": round(v / total * 100, 2)})
    if len(res) > top:
        rest = res[top:]
        res = res[:top] + [{"name": "其他候選人", "party": "IND", "partyName": "",
                            "votes": sum(x["votes"] for x in rest),
                            "share": round(sum(x["votes"] for x in rest) / total * 100, 2)}]
    return {"total": total, "results": res}


def main():
    zones = list(csv.DictReader(open(SRC / "data/council/2026/zones.csv", encoding="utf-8")))
    cunli = list(csv.DictReader(open(SRC / "data/council/2026/cunli.csv", encoding="utf-8")))
    seats = json.load(open(ROOT / "tools/seats_2026.json", encoding="utf-8"))

    # 2026 選區 → 鄉鎮 / 村里
    zone_villages = collections.defaultdict(list)
    for r in cunli:
        zone_villages[r["zone"]].append((town_base(r["area"]), r["village"], r["village_code"], r["area"]))
    town_zones = collections.defaultdict(set)
    for r in cunli:
        town_zones[(r["zone"][:5], r["area"])].add(r["zone"])

    mayors = {
        2014: Election(VD / "2014-103年地方公職人員選舉/直轄市市長", VD / "2014-103年地方公職人員選舉/縣市市長"),
        2018: Election(VD / "2018-107年地方公職人員選舉/直轄市市長", VD / "2018-107年地方公職人員選舉/縣市市長"),
        2022: Election(VD / "2022-111年地方公職人員選舉/C1/prv", VD / "2022-111年地方公職人員選舉/C1/city"),
    }
    y22 = VD / "2022-111年地方公職人員選舉"
    council22 = Election(y22 / "T1/prv", y22 / "T1/city", y22 / "T2/prv", y22 / "T2/city", y22 / "T3/prv", y22 / "T3/city")

    # 2022 嘉義市長（延期至 12/18 重行選舉，檔案格式不同）
    chiayi = VD / "2022年_嘉義市長重行選舉"
    cy_cands = [dict(r) for r in csv.DictReader(open(chiayi / "cand.csv", encoding="utf-8-sig"))]
    cy_town = collections.defaultdict(collections.Counter)
    cy_village = collections.defaultdict(collections.Counter)
    cy_tt = collections.defaultdict(lambda: [0, 0])
    cy_vt = collections.defaultdict(lambda: [0, 0])
    for r in csv.DictReader(open(chiayi / "prof.csv", encoding="utf-8-sig")):
        for c in cy_cands:
            v = int(r[f"號次{c['號次']}"].replace(",", "") or 0)
            cy_town[town_base(r["行政區別"])][c["號次"]] += v
            cy_village[(town_base(r["行政區別"]), r["村里別"])][c["號次"]] += v
        num = lambda k: int(next(v for kk, v in r.items() if kk.startswith(k)).replace(",", "") or 0)
        for acc_t, key in ((cy_tt, town_base(r["行政區別"])), (cy_vt, (town_base(r["行政區別"]), r["村里別"])), (cy_tt, "all")):
            acc_t[key][0] += num("投票數C")
            acc_t[key][1] += num("選舉人數")

    def cy_lookup(no):
        c = next(x for x in cy_cands if x["號次"] == no)
        pname = c["政黨名稱"] if c["政黨名稱"] not in ("", "無") else "無黨籍"
        return {"name": c["名字"], "party": PARTY_KEY.get(pname, "IND"), "partyName": pname}

    report = []
    counties = {}
    by_county = collections.defaultdict(list)
    for z in zones:
        by_county[z["code"][:5]].append(z)

    for code, zs in by_county.items():
        name = zs[0]["city"]
        p, c = code[:2], code[2:]
        seat = seats[code]
        assert len(seat["regional"]) == len(zs), (name, len(seat["regional"]), len(zs))

        # 縣市長：全縣市與各選區
        county_hist, zone_hist = [], collections.defaultdict(list)
        for year, el in mayors.items():
            if year == 2022 and code == "10020":
                town_t, vil_t, lookup = cy_town, cy_village, cy_lookup
                ctot = sum(cy_town.values(), collections.Counter())
                town_to, vil_to, cty_to = cy_tt, cy_vt, cy_tt["all"]
            else:
                ct = el.tally(code, "county")
                if not ct:
                    report.append(f"{year} {name} 無縣市長資料")
                    continue
                ctot = sum(ct.values(), collections.Counter())
                town_t, vil_t = el.tally(code, "town"), el.tally(code, "village")
                town_to, vil_to = el.turnout(code, "town"), el.turnout(code, "village")
                cty_to = el.turnout(code, "county").get("all", [0, 0])
                by_no = {k[3]: v for k, v in el.cands.items() if k[:2] == (p, c)}
                lookup = by_no.__getitem__
            county_hist.append(with_turnout({"year": year, **results_from(ctot, lookup)}, *cty_to))

            for z in zs:
                acc = collections.Counter()
                to = [0, 0]
                for t in z["areas"].split("/"):
                    if len(town_zones[(code, t)]) == 1:
                        if town_base(t) not in town_t:
                            report.append(f"{year} {name} 找不到鄉鎮 {t}")
                        acc += town_t.get(town_base(t), collections.Counter())
                        to = [x + y for x, y in zip(to, town_to.get(town_base(t), [0, 0]))]
                    else:  # 以村里切分的選區
                        miss = []
                        for tb, vname, _, full in zone_villages[z["code"]]:
                            if full != t:
                                continue
                            if (tb, vname) in vil_t:
                                acc += vil_t[(tb, vname)]
                                to = [x + y for x, y in zip(to, vil_to.get((tb, vname), [0, 0]))]
                            else:
                                miss.append(vname)
                        if miss:
                            report.append(f"{year} {z['zone']} 村里對不到：{'、'.join(miss)}（該村里票數未計入）")
                zone_hist[z["code"]].append(with_turnout({"year": year, **results_from(acc, lookup)}, *to))

        # 2022 議員當選人（以 2022 選區編號對應 2026 選區）
        def winners(area, losers=0):
            out = []
            area_tot = collections.Counter()
            for pp, cc, a, dept, li, no, v in council22.ticks:
                if pp == p and cc == c and a == area and dept == "000" and li == "0000":
                    area_tot[no] += v
            total = sum(area_tot.values())
            lost = []
            for (pp, cc, a, no), cand in council22.cands.items():
                if (pp, cc, a) == (p, c, area):
                    row = {"name": cand["name"], "party": cand["party"], "partyName": cand["partyName"],
                           "votes": area_tot[no], "share": round(area_tot[no] / total * 100, 2) if total else None,
                           "elected": cand["elected"]}
                    (out if cand["elected"] else lost).append(row)
            lost = sorted(lost, key=lambda x: -x["votes"])[:losers]
            return sorted(out + lost, key=lambda x: -x["votes"])

        def party2022(area):
            votes = collections.Counter()
            for pp, cc, a, dept, li, no, v in council22.ticks:
                if pp == p and cc == c and a == area and dept == "000" and li == "0000":
                    votes[council22.cands[(p, c, a, no)]["party"]] += v
            total = sum(votes.values())
            return ({k: round(v / total * 100, 2) for k, v in votes.most_common()} if total else {}), dict(votes.most_common())

        # 2026 登記參選人（data/candidates_2026/<縣市代碼>.txt，格式：選區|姓名|政黨，縣市長以「市長」為選區）
        reg = collections.defaultdict(list)
        for line in (ROOT / f"data/candidates_2026/{code}.txt").read_text(encoding="utf-8").splitlines():
            if line.strip():
                k, cname, pname = line.split("|")
                reg[k].append({"name": cname, "party": PARTY_KEY.get(pname, "IND"), "partyName": pname})

        def han(nm):
            return "".join(ch for ch in nm if "\u4e00" <= ch <= "\u9fff")

        def registrants(n, incumbents):
            inc = {han(x["name"]) for x in incumbents}
            out = [dict(x, incumbent=han(x["name"]) in inc) for x in reg.pop(str(n), [])]
            if not out:
                report.append(f"{name} 第{n}選區 沒有登記參選人資料")
            return out

        def area22(n26):
            # 2026 新竹縣竹北市拆成兩區，其餘選區編號與 2022 相同
            if code == "10004":
                return "01" if n26 <= 2 else f"{n26 - 1:02d}"
            return f"{n26:02d}"

        districts = []
        for i, z in enumerate(zs):
            n = int(z["code"][-2:])
            towns = z["areas"].split("/")
            split = [t for t in towns if len(town_zones[(code, t)]) > 1]
            districts.append({
                "id": z["code"], "no": n, "name": f"第{n}選區", "seats": seat["regional"][i],
                "towns": towns,
                "villages": [v for _, v, _, full in zone_villages[z["code"]] if full in split],
                "villageCodes": [vc for _, _, vc, full in zone_villages[z["code"]] if full in split],
                "incumbents": winners(area22(n)),
                "result2022": winners(area22(n), 2),
                "party2022": party2022(area22(n))[0],
                "party2022Votes": party2022(area22(n))[1],
                "incumbentsNote": "2022 年竹北市為單一選區，兩區列出相同的現任議員" if code == "10004" and n <= 2 else "",
                "mayorHistory": zone_hist[z["code"]],
            })
        indigenous = []
        for n, label, s, scope in seat["indigenous"]:
            indigenous.append({
                "id": f"{code}-{n:02d}", "no": n, "name": f"第{n}選區（{label}）", "seats": s,
                "scope": scope, "incumbents": winners(area22(n)), "result2022": winners(area22(n), 2),
                "party2022": party2022(area22(n))[0], "party2022Votes": party2022(area22(n))[1],
                "area2022": council22.area_names.get((p, c, area22(n)), ""),
            })
        for d in districts + indigenous:
            d["candidates"] = registrants(d["no"], d["incumbents"])
            if len(d["candidates"]) < d["seats"]:
                report.append(f"{name} {d['name']} 登記人數 {len(d['candidates'])} 少於應選 {d['seats']}")
        last = county_hist[-1]["results"][0]["name"] if county_hist else ""
        mayor = [dict(x, incumbent=han(x["name"]) == han(last)) for x in reg.pop("市長", [])]
        if reg:
            report.append(f"{name} 有對不到選區的登記資料：{list(reg)}")
        counties[code] = {"code": code, "mayorCandidates": mayor, "name": name, "totalSeats": sum(seat["regional"]) + sum(x[2] for x in seat["indigenous"]),
                          "mayorHistory": county_hist, "districts": districts, "indigenous": indigenous}

    out = {
        "source": {
            "votes": "中選會選舉資料庫開票檔（2014、2018、2022 直轄市長及縣市長；2022 直轄市及縣市議員），經 github.com/kiang/db.cec.gov.tw 鏡像取得",
            "districts": "2026 議員選舉區範圍：github.com/kiang/db.cec.gov.tw data/council/2026；應選名額：中選會 2026-08-20 公告（中選務字第1153150253號）",
            "repoCommit": sys.argv[2] if len(sys.argv) > 2 else "",
            "candidates": "2026 候選人：島民觀察室 formosaobservatory.com 整理之登記名冊（截至 2026-10-08），扣除中選會 2026-10-16 資格審定未通過之 10 名議員參選人；號次 10/23 抽籤，候選人名單 11/12（直轄市長）、11/17（其餘）公告",
        },
        "counties": counties,
    }
    dest = ROOT / "data/real/elections.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(dest, dest.stat().st_size)
    print("\n".join(sorted(set(report))) or "全部對應成功")


main()
