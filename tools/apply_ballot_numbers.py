"""把 data/candidates_2026/*.txt 的號次與政黨套進 data/real/elections.json，不必重跑 build_real_data.py。

txt 格式：選區|姓名|政黨|號次（縣市長的選區寫「市長」；號次未知時留空或省略）
用法：python3 tools/apply_ballot_numbers.py [來源說明]
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PARTY_KEY = {"中國國民黨": "KMT", "民主進步黨": "DPP", "台灣民眾黨": "TPP", "時代力量": "NPP"}


def han(nm):
    return "".join(ch for ch in nm if "一" <= ch <= "鿿")


def main():
    path = ROOT / "data/real/elections.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    problems, total, numbered = [], 0, 0
    for code, c in data["counties"].items():
        rows = {}
        for line in (ROOT / f"data/candidates_2026/{code}.txt").read_text(encoding="utf-8").splitlines():
            if line.strip():
                k, name, pname, *rest = line.split("|")
                no = int(rest[0]) if rest and rest[0].strip() else None
                rows[(k, han(name) or name)] = (name, pname, no)
        groups = [("市長", c["mayorCandidates"])] + [(str(d["no"]), d["candidates"]) for d in c["districts"] + c["indigenous"]]
        seen = set()
        for k, cands in groups:
            for x in cands:
                key = (k, han(x["name"]) or x["name"])
                if key not in rows:
                    problems.append(f"{c['name']} {k}：{x['name']} 不在 txt 名單")
                    continue
                seen.add(key)
                name, pname, no = rows[key]
                x["partyName"], x["party"] = pname, PARTY_KEY.get(pname, "IND")
                x.pop("number", None)
                if no is not None:
                    x["number"] = no
                    numbered += 1
                total += 1
        for key in rows.keys() - seen:
            problems.append(f"{c['name']} {key[0]}：{rows[key][0]} 只在 txt（elections.json 沒有）")
    if len(sys.argv) > 1:
        data["source"]["candidates"] = sys.argv[1]
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{numbered}/{total} 位候選人有號次")
    print("\n".join(problems) or "全部對應成功")


main()
