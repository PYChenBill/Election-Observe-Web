/*
 * 資料存取層
 * ------------------------------------------------------------
 * 前端只透過 window.API 取資料。現在 mode = "mock" 使用 mock-api.js；
 * 後端資料庫完成後改成 mode = "http"，並把 baseUrl 指向後端即可，
 * 回傳格式請與 mock-api.js 相同（見 README.md 的 API 說明）。
 */
(function () {
  const config = { mode: "mock", baseUrl: "/api" };

  async function http(path) {
    const res = await fetch(config.baseUrl + path, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`讀取 ${path} 失敗（${res.status}）`);
    return res.json();
  }

  window.API = {
    config,
    getMeta: () => (config.mode === "mock" ? window.MockBackend.getMeta() : http("/meta")),
    getCounties: () => (config.mode === "mock" ? window.MockBackend.getCounties() : http("/counties")),
    getCounty: (id) => (config.mode === "mock" ? window.MockBackend.getCounty(id) : http(`/counties/${encodeURIComponent(id)}`))
  };
})();
