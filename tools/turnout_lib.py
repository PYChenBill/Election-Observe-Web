"""讀中選會開票檔 elprof.csv 的投票數與選舉人數（縣市、選舉區、村里三個層級）。"""
import collections
import csv


def rows(path):
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.reader(f):
            yield [c.strip().strip("'") for c in r]


def town_base(name):
    # 員林鎮／員林市、桃園市／桃園區 等改制前後名稱視為同一行政區
    name = name.replace("台", "臺")
    return name[:-1] if len(name) > 2 else name


class Prof:
    """village[(縣市代碼, 鄉鎮, 村里)]、area[(縣市代碼, 選舉區)]、county[縣市代碼] -> [投票數, 選舉人數]。

    2022 起的檔案有村里彙總列；2014、2018 只有投開票所列，村里以投開票所加總。"""

    def __init__(self, *dirs):
        new = lambda: [0, 0]
        self.village = collections.defaultdict(new)
        self.area = collections.defaultdict(new)
        self.county = collections.defaultdict(new)
        self.area_names = {}
        station = collections.defaultdict(new)
        agg = set()
        for d in dirs:
            names = {}
            for p, c, a, dept, li, name in (r[:6] for r in rows(d / "elbase.csv")):
                names[(p, c, dept, li)] = name
                if dept == "000" and li == "0000" and a != "00":
                    self.area_names[(p + c, a)] = name
            for r in rows(d / "elprof.csv"):
                p, c, a, dept, li, tbox = r[:6]
                vals = (int(r[8]), int(r[9]))
                is_agg = tbox.strip("0") == ""
                if dept == "000" and li == "0000":
                    if not is_agg or p == "00":
                        continue
                    tgt = self.county[p + c] if a == "00" else self.area[(p + c, a)]
                elif dept != "000" and li != "0000":
                    key = (p + c, town_base(names[(p, c, dept, "0000")]), names[(p, c, dept, li)])
                    if is_agg:
                        agg.add(key)
                        tgt = self.village[key]
                    else:
                        tgt = station[key]
                else:
                    continue
                tgt[0] += vals[0]
                tgt[1] += vals[1]
        for key, v in station.items():
            if key not in agg:
                self.village[key] = v

    def towns(self, county):
        out = collections.defaultdict(lambda: [0, 0])
        for (cc, t, _), (v, e) in self.village.items():
            if cc == county:
                out[t][0] += v
                out[t][1] += e
        return out
