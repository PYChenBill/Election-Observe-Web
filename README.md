# 地方選舉預測地圖（前端原型）

純靜態網頁（D3 + TopoJSON）。歷史資料為中選會實際開票結果，2026 參選人為實際登記名冊；預測由你填在 `data/predictions.json`，沒填的地方以 2022 實際得票當基準。

## 檔案
- `index.html`：頁面與樣式
- `js/app.js`：互動地圖（全臺縣市 → 議員選區、席次圓點、對話框、側欄）
- `js/api.js`：資料存取層，`API.config.mode` 改為 `"http"` 即改接後端
- `js/mock-api.js`：暫時後端。讀 `data/real/elections.json` 與 `data/predictions.json` 組出 API 回應；回傳格式即為正式 API 規格
- `data/candidates_2026/<縣市代碼>.txt`：2026 登記參選人（選區|姓名|政黨，縣市長以「市長」為選區），取自島民觀察室 formosaobservatory.com（中選會登記名冊，截至 2026-10-08），再扣除中選會 2026-10-16 資格審定未通過的 10 名議員參選人（見 `data/candidates_2026/REMOVED.md`）。目前議員 1,492 人、縣市長 81 人，與中選會審定通過人數相符
- `data/predictions.json`：你的預測（見下方格式）
- `data/real/elections.json`：由中選會開票檔整理（2014/2018/2022 縣市長，含各選區彙整；2022 議員當選人；2026 選區與應選名額）
- `data/districts.topo.json`：2026 議員選區邊界，由內政部村里界圖（taiwan-atlas）依選區所屬村里合併
- `tools/seats_2026.json`：中選會 2026-08-20 公告（中選務字第1153150253號）各選區應選名額
- `tools/build_real_data.py`、`tools/build_districts_topo.js`：重新產生上面兩個資料檔（需先 clone github.com/kiang/db.cec.gov.tw，該 repo 鏡像中選會選舉資料庫開票檔）
- `tools/build_preview.py`：打包成單一檔 `dist/preview.html`（Artifact 預覽用）

本機執行：在此資料夾 `python3 -m http.server`，開 http://localhost:8000 。

## API 規格（後端需提供）
- `GET /api/meta` → `{ election, voteDate, updatedAt, parties: { KMT: {name, short, color}, ... }, isMock }`
- `GET /api/counties` → `[{ id, name, totalSeats, seatForecast: {KMT: n,...}, seatPredicted: {KMT: n,...}（只計有預測的選區）, mayor: { candidates:[{name, party, share, incumbent}], leader, margin } }]`
- `GET /api/counties/:id` → 上述欄位，再加
  - `districts: [{ id, no, name, towns:[鄉鎮市區], seats, hasGeometry, incumbents:[{name, party, votes, share}], result2022:[{name, party, votes, share, elected}]（2022 當選人＋落選前 2 名）, party2022:{KMT: %}, party2022Votes:{KMT: 票數}, candidates:[{name, party, incumbent, share, elected}], mayorHistory:[{year, turnout, voted, electors, results:[{name, party, share, votes}]}], forecast:{ leader, margin, partyShares:{KMT: %,...} } }]`
  - `indigenous`: 同 districts 格式，`hasGeometry: false`

`id` 目前用邊界檔的縣市名稱（例如 `台北市`），`towns` 需與邊界檔的 `TOWNNAME` 相同。

## 預測檔格式（data/predictions.json）
```json
{
  "63000": {
    "mayor": { "蔣萬安": 52.0, "沈伯洋": 45.0 },
    "mayorByDistrict": { "1": { "蔣萬安": 48.0, "沈伯洋": 49.5 } },
    "districts": { "1": { "林延鳳": 9.5, "黃瀞瑩": 9.0 } }
  }
}
```
`mayorByDistrict` 是各議員選區的縣市長預測得票率，預測地圖的選區底色依它的領先者與幅度上色（沒填的選區為白色）；`districts` 是議員預測。鍵為縣市代碼與選區編號，值為候選人預測得票率（%），姓名須與登記名冊相同。有填的選區依得票率排序標出當選，沒填的選區以 2022 政黨得票當基準。

## 已知限制
- 2026 候選人已依 10/16 資格審定更新；號次 10/23 抽籤，11/12、11/17 中選會公告候選人名單後應再核對一次。
- 參選人的「現任」標記是與 2022 當選人比對姓名而得。
- 現任議員 = 2022 年當選人，未反映之後的補選、出缺或退黨。新竹縣 2026 年把竹北市拆成兩區，兩區都列出 2022 竹北選區的議員。
- 各選區歷次縣市長結果是把鄉鎮（以村里切分的選區則用村里）開票數加總而得；2014 竹北市中崙里當時尚未設立，對不上屬正常。
- 2022 嘉義市長採 12/18 重行選舉結果。
- 地圖分兩頁，用標題旁的開關切換：「預測地圖」（預設）只有在 data/predictions.json 填了預測的縣市／選區才依預測領先陣營與幅度上色，其餘白色；「歷史紀錄」以該區 2022 縣市長得票領先者上色。深淺代表領先幅度（0–20 個百分點）。

## 網站發布（GitHub Pages）
網址：https://pychenbill.github.io/Election-Observe-Web/ ，由 `main` 分支根目錄直接發布（`.nojekyll` 讓 GitHub 不做 Jekyll 處理）。

更新預測：把模型結果寫成上方格式後，在 repo 根目錄執行
```
tools/publish_predictions.sh 你的預測檔.json
```
腳本會檢查 JSON、複製成 `data/predictions.json`、commit 並 push，約 1–3 分鐘後網站更新。若已直接改好 `data/predictions.json`，不帶參數執行即可。Windows 請在 Git Bash 執行。
