#!/usr/bin/env bash
# 更新預測並發布到 GitHub Pages。
#
# 用法（在 repo 根目錄執行）：
#   tools/publish_predictions.sh                 # 直接發布已改好的 data/predictions.json
#   tools/publish_predictions.sh 模型輸出.json   # 先把指定檔案複製成 data/predictions.json 再發布
#
# 會先檢查 JSON 格式，沒有變動就不提交；push 後約 1–3 分鐘網站更新。
set -euo pipefail

cd "$(dirname "$0")/.."
target="data/predictions.json"

if [ $# -ge 1 ]; then
  cp "$1" "$target"
fi

PY=$(command -v python3 || command -v python || true)
if [ -n "$PY" ]; then
  "$PY" -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$target" \
    || { echo "錯誤：$target 不是合法的 JSON，未發布。" >&2; exit 1; }
fi

git add "$target"
if git diff --cached --quiet -- "$target"; then
  echo "預測沒有變動，不需要發布。"
  exit 0
fi

git commit -m "更新預測 $(date '+%Y-%m-%d %H:%M')" -- "$target"
git pull --rebase
git push
echo "已發布，約 1–3 分鐘後網站會更新。"
