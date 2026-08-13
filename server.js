/* =========================================================
   小小积分银行 — 云同步后端（零依赖，纯 Node 内置模块）
   功能：
     - 托管 kids-points.html（同一网址即可访问网页）
     - GET  /api/state?code=XXX   拉取某家庭码数据
     - POST /api/state            推送某家庭码数据（last-write-wins）
   数据按家庭码存到 ./data/<code>.json，rev 单调递增防乱序
   ========================================================= */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
// 数据目录可外部挂载：平台挂持久盘时设 DATA_DIR=/data，否则存到程序目录下的 data/
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

function sanitizeCode(c) {
  return String(c || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}
function fileFor(code) { return path.join(DATA_DIR, code + ".json"); }
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  // 允许跨域（同源时无害；若将来用独立域名/反代也更稳）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  let url;
  try { url = new URL(req.url, "http://localhost"); } catch (e) { return sendJson(res, 400, { error: "bad url" }); }
  const p = url.pathname;

  // 健康检查
  if (p === "/api/health") return sendJson(res, 200, { ok: true });

  // 状态接口
  if (p === "/api/state") {
    if (req.method === "GET") {
      const code = sanitizeCode(url.searchParams.get("code"));
      if (!code) return sendJson(res, 400, { error: "missing code" });
      const f = fileFor(code);
      if (!fs.existsSync(f)) return sendJson(res, 404, { error: "no data" });
      try {
        const obj = JSON.parse(fs.readFileSync(f, "utf8"));
        return sendJson(res, 200, { rev: obj.rev || 0, updatedAt: obj.updatedAt || 0, data: obj.data || null });
      } catch (e) { return sendJson(res, 500, { error: "corrupt" }); }
    }

    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 5e6) req.destroy(); });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: "bad json" }); }
        const cd = sanitizeCode(parsed.code);
        if (!cd) return sendJson(res, 400, { error: "missing code" });
        if (!parsed.data || typeof parsed.data !== "object") return sendJson(res, 400, { error: "missing data" });
        const f = fileFor(cd);
        let cur = { rev: 0, updatedAt: 0, data: null };
        if (fs.existsSync(f)) { try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {} }
        const next = { rev: (cur.rev || 0) + 1, updatedAt: Date.now(), data: parsed.data };
        try { fs.writeFileSync(f, JSON.stringify(next)); } catch (e) { return sendJson(res, 500, { error: "write fail" }); }
        return sendJson(res, 200, { rev: next.rev, updatedAt: next.updatedAt });
      });
      return;
    }
    return sendJson(res, 405, { error: "method not allowed" });
  }

  // 静态托管：把 kids-points.html 作为首页
  if (req.method === "GET") {
    const htmlPath = path.join(__dirname, "kids-points.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(htmlPath).pipe(res);
    }
    return sendJson(res, 404, { error: "not found" });
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log("🪙 小小积分银行（云同步）已启动: http://localhost:" + PORT);
});
