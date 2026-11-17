"""整理 2026 各縣市與各議員選區的選舉人數（中選會正式數字公布前的估計）。

輸出 data/electors_2026.json 與 data/electors_2026.csv。

資料來源（皆為中選會選舉資料庫開票檔，經 github.com/kiang/db.cec.gov.tw 鏡像取得）
- 2022 實際：111 年地方公職人員選舉，縣市長（C1）與議員區域（T1）、平地原住民（T2）、山地原住民（T3）
- 2024 實際：113 年總統（各村里選舉人數）、平地／山地原住民立委（各村里原住民選舉人數）
- 2026 選區範圍：同一 repo 的 data/council/2026/zones.csv、cunli.csv；應選名額：tools/seats_2026.json

2026 估計方法
1. 以 2024 總統選舉各村里選舉人數為底，依 2026 選區範圍加總（以村里切分的鄉鎮按村里加總）。
   區域議員選舉人＝總統選舉人－有原住民選區涵蓋之鄉鎮的平地／山地原住民選舉人。
2. 全部選區按同一比例放大，使全國總數等於中選會 2026-08-20 公布的估計值 1,965 萬人（約 +0.5%）。
   不用各縣市 2022→2024 變化率外推：2022 年選舉人數受疫情期間出國者戶籍遷出影響偏低（如臺北市 2018→2022 −6.4%、
   2022→2024 +3.1%），外推會放大這個落差。

用法：python3 tools/build_electors.py <db.cec.gov.tw repo 路徑>
"""
import collections
import csv
import datetime
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path(sys.argv[1])
VD = SRC / "voteData"
Y22 = VD / "2022-111年地方公職人員選舉"
Y24 = VD / "2024總統立委"
CEC_ESTIMATE_2026 = 19_650_000  # 中選會 2026-08-20 新聞稿「估選舉人 1,965 萬人」


def rows(path):
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.reader(f):
            yield [c.strip().strip("'") for c in r]


def town_base(name):
    name = name.replace("台", "臺")
    return name[:-1] if len(name) > 2 else name


class Prof:
    """一組開票檔的選舉人數：村里、選舉區（area）層級。"""

    def __init__(self, *dirs):
        self.village = collections.Counter()   # (county, town_base, 村里名) -> 選舉人數
        self.area = collections.Counter()      # (county, area) -> 選舉人數
        self.county = collections.Counter()    # county -> 選舉人數
        self.area_names = {}
        for d in dirs:
            names = {}
            for p, c, a, dept, li, name in (r[:6] for r in rows(d / "elbase.csv")):
                names[(p, c, dept, li)] = name
                if dept == "000" and li == "0000" and a != "00":
                    self.area_names[(p + c, a)] = name
            for r in rows(d / "elprof.csv"):
                p, c, a, dept, li, tbox = r[:6]
                if tbox.strip("0"):
                    continue
                n = int(r[9])
                if dept == "000" and li == "0000":
                    if a == "00":
                        self.county[p + c] += n
                    else:
                        self.area[(p + c, a)] += n
                elif dept != "000" and li != "0000":
                    t = town_base(names[(p, c, dept, "0000")])
                    self.village[(p + c, t, names[(p, c, dept, li)])] += n

    def towns(self, county):
        out = collections.Counter()
        for (cc, t, _), n in self.village.items():
            if cc == county:
                out[t] += n
        return out


def main():
    zones = list(csv.DictReader(open(SRC / "data/council/2026/zones.csv", encoding="utf-8")))
    cunli = list(csv.DictReader(open(SRC / "data/council/2026/cunli.csv", encoding="utf-8")))
    seats = json.load(open(ROOT / "tools/seats_2026.json", encoding="utf-8"))

    mayor22 = Prof(Y22 / "C1/prv", Y22 / "C1/city")
    reg22 = Prof(Y22 / "T1/prv", Y22 / "T1/city")
    ind22p = Prof(Y22 / "T2/prv", Y22 / "T2/city")
    ind22m = Prof(Y22 / "T3/prv", Y22 / "T3/city")
    ind22 = Prof(Y22 / "T2/prv", Y22 / "T2/city", Y22 / "T3/prv", Y22 / "T3/city")
    pres24 = Prof(Y24 / "總統")
    plain24 = Prof(Y24 / "平地立委")
    mtn24 = Prof(Y24 / "山地立委")
    # 2022 嘉義市長延至 12/18 重行選舉，C1 無資料；以同日議員選舉人數（區域＋原住民）代替
    for code in ("10020",):
        if not mayor22.county[code]:
            mayor22.county[code] = sum(n for (cc, _), n in reg22.area.items() if cc == code) + \
                sum(n for (cc, _), n in ind22.area.items() if cc == code)

    zone_villages = collections.defaultdict(list)
    town_zones = collections.defaultdict(set)
    for r in cunli:
        zone_villages[r["zone"]].append((r["area"], r["village"]))
        town_zones[(r["zone"][:5], r["area"])].add(r["zone"])

    report = []

    def zone_sum(prof, code, z, label, only=None):
        """依 2026 選區範圍加總某次選舉的村里選舉人數；only 指定時只算這些鄉鎮。"""
        towns = prof.towns(code)
        if only is not None:
            towns = {t: v for t, v in towns.items() if t in only}
        total = 0
        for t in z["areas"].split("/"):
            if len(town_zones[(code, t)]) == 1:
                if only is None and town_base(t) not in towns:
                    report.append(f"{label} {z['zone']} 找不到鄉鎮 {t}")
                total += towns.get(town_base(t), 0)
            else:
                for full, v in zone_villages[z["code"]]:
                    if full != t:
                        continue
                    key = (code, town_base(full), v)
                    if only is not None and town_base(full) not in only:
                        continue
                    if key not in prof.village:
                        report.append(f"{label} {z['zone']} 村里對不到：{full}{v}")
                    total += prof.village.get(key, 0)
        return total

    def scope_towns(code, scope):
        if not scope:
            return None
        names = [s for s in re.split("[、及]", scope) if s]
        return {town_base(s if s[-1] in "區鄉鎮市" else s + "區") for s in names}

    by_county = collections.defaultdict(list)
    for z in zones:
        by_county[z["code"][:5]].append(z)

    out = {}
    for code, zs in by_county.items():
        name = zs[0]["city"]
        seat = seats[code]
        districts, indig = [], []
        # 該縣市有原住民選區涵蓋的鄉鎮，原住民才在原住民選區投票；沒有涵蓋的仍在區域選區投票
        all_towns = set(pres24.towns(code))
        covered = {"平地": set(), "山地": set()}
        for n, label, s, scope in seat["indigenous"]:
            covered[label[:2]] |= scope_towns(code, scope) or all_towns
        for i, z in enumerate(zs):
            n = int(z["code"][-2:])
            e24 = zone_sum(pres24, code, z, "2024總統") - zone_sum(plain24, code, z, "2024平原", covered["平地"]) \
                - zone_sum(mtn24, code, z, "2024山原", covered["山地"])
            districts.append({"no": n, "name": f"第{n}選區", "seats": seat["regional"][i], "towns": z["areas"].split("/"),
                              "electors2022": zone_sum(reg22, code, z, "2022議員"), "electors2024": e24})
        for n, label, s, scope in seat["indigenous"]:
            prof = plain24 if label.startswith("平地") else mtn24
            st = scope_towns(code, scope)
            e24 = sum(v for t, v in prof.towns(code).items() if st is None or t in st)
            if st:
                missing = st - set(prof.towns(code))
                if missing:
                    report.append(f"{name} 第{n}選區 範圍找不到鄉鎮：{missing}")
            a22 = f"{(n - 1 if code == '10004' else n):02d}"  # 2026 新竹縣竹北市拆兩區，原住民選區編號 +1
            # 2022 同編號選區須為同類（平地／山地）；2026 新設或拆分的選區，2022 無可比數字
            same = (code, a22) in (ind22p.area if label.startswith("平地") else ind22m.area)
            indig.append({"no": n, "name": f"第{n}選區（{label}）", "seats": s, "scope": scope or "全縣市",
                          "electors2022": ind22.area[(code, a22)] if same else None, "electors2024": e24})
        out[code] = {"code": code, "name": name,
                     "mayor": {"electors2022": mayor22.county[code], "electors2024": pres24.county[code]},
                     "districts": districts, "indigenous": indig}

    # 2026 估計：2024 選舉人數按全國同一比例放大到中選會估計總數（各縣市 2022→2024 變化受疫情期間戶籍遷出後回流影響，不宜外推）
    for c in out.values():
        for grp in ("districts", "indigenous"):
            for d in c[grp]:
                d["_raw"] = d["electors2024"]
    raw_total = sum(d["_raw"] for c in out.values() for g in ("districts", "indigenous") for d in c[g])
    k = CEC_ESTIMATE_2026 / raw_total
    for c in out.values():
        for g in ("districts", "indigenous"):
            for d in c[g]:
                d["estimate2026"] = round(d.pop("_raw") * k)
        c["mayor"]["estimate2026"] = sum(d["estimate2026"] for g in ("districts", "indigenous") for d in c[g])
        c["mayor"]["official2026"] = None
        for g in ("districts", "indigenous"):
            for d in c[g]:
                d["official2026"] = None

    tot = lambda key: sum(c["mayor"][key] for c in out.values())
    result = {
        "_note": "2026 選舉人數：中選會依法於投票日前 3 日（2026-11-25）公告，公告前 official2026 為 null。"
                 "estimate2026 為估計值，方法見 tools/build_electors.py。electors2022 為 2022 地方選舉實際選舉人數（依 2026 選區範圍重新加總），"
                 "electors2024 為 2024 總統／原住民立委選舉實際選舉人數（依 2026 選區範圍加總；區域選區已扣除原住民選舉人）。",
        "source": "中選會選舉資料庫開票檔（github.com/kiang/db.cec.gov.tw 鏡像）；全國估計 1,965 萬人：中選會 2026-08-20 新聞稿",
        "updatedAt": datetime.date.today().isoformat(),
        "totals": {"electors2022": tot("electors2022"), "electors2024": tot("electors2024"), "estimate2026": tot("estimate2026"),
                   "cecEstimate2026": CEC_ESTIMATE_2026},
        "counties": out,
    }
    (ROOT / "data/electors_2026.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    with open(ROOT / "data/electors_2026.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["縣市代碼", "縣市", "類別", "選區", "應選名額", "範圍", "2022實際選舉人數", "2024實際選舉人數", "2026估計選舉人數", "2026中選會公告"])
        for c in out.values():
            m = c["mayor"]
            w.writerow([c["code"], c["name"], "縣市長", "全縣市", 1, "", m["electors2022"], m["electors2024"], m["estimate2026"], ""])
            for d in c["districts"]:
                w.writerow([c["code"], c["name"], "區域議員", d["name"], d["seats"], "、".join(d["towns"]), d["electors2022"], d["electors2024"], d["estimate2026"], ""])
            for d in c["indigenous"]:
                w.writerow([c["code"], c["name"], "原住民議員", d["name"], d["seats"], d["scope"], d["electors2022"], d["electors2024"], d["estimate2026"], ""])
    print(json.dumps(result["totals"], ensure_ascii=False))
    print("\n".join(sorted(set(report))) or "全部對應成功")


main()
