"""把 index.html 打包成單一檔案（給 Artifact 預覽用）。

- vendor 函式庫改由 cdnjs 載入
- 自己的 JS、選區邊界 TopoJSON 與中選會整理資料直接內嵌
用法：python3 tools/build_preview.py  → 產生 dist/preview.html
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
html = (ROOT / "index.html").read_text(encoding="utf-8")

vendor = (
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>\n'
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js"></script>'
)
html = re.sub(r"<!-- build:vendor -->.*?<!-- /build:vendor -->", lambda m: vendor, html, flags=re.S)

topo = (ROOT / "data" / "districts.topo.json").read_text(encoding="utf-8")
real = (ROOT / "data" / "real" / "elections.json").read_text(encoding="utf-8")
pred = (ROOT / "data" / "predictions.json").read_text(encoding="utf-8")
app = ("<script>window.DISTRICTS_TOPO = " + topo + ";\nwindow.REAL_ELECTIONS = " + real
       + ";\nwindow.PREDICTIONS = " + pred + ";</script>\n")
for src in re.findall(r'<script src="(js/[^"]+)"></script>', html):
    app += "<script>\n" + (ROOT / src).read_text(encoding="utf-8") + "\n</script>\n"
html = re.sub(r"<!-- build:app -->.*?<!-- /build:app -->", lambda m: app, html, flags=re.S)

out = ROOT / "dist" / "preview.html"
out.parent.mkdir(exist_ok=True)
out.write_text(html, encoding="utf-8")
print(out, out.stat().st_size)
