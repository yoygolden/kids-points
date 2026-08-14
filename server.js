/* =========================================================
   小小积分银行 — 云同步后端（双模式）
   - 设了 DATABASE_URL（如 Neon 免费 Postgres）→ 用数据库存，数据持久、免费
   - 没设 → 用本地文件 ./data/<code>.json（本地开发 / 单机 / 挂盘场景）
   功能：托管 kids-points.html + GET/POST /api/state + /api/health
   ========================================================= */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const USE_DB = !!process.env.DATABASE_URL;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");

let db = null;
if (USE_DB) {
  try {
    const { Pool } = require("pg");
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
    });
    db.query(
      "CREATE TABLE IF NOT EXISTS states (code TEXT PRIMARY KEY, rev INT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL DEFAULT 0, data JSONB)"
    ).catch((e) => console.error("DB 初始化失败:", e.message));
  } catch (e) {
    console.error("加载 pg 失败，将回退到本地文件模式:", e.message);
    db = null;
  }
} else {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

function sanitizeCode(c) {
  return String(c || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}
function fileFor(code) { return path.join(DATA_DIR, code + ".json"); }

async function readState(code) {
  if (db) {
    const r = await db.query("SELECT rev, updated_at, data FROM states WHERE code=$1", [code]);
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return { rev: row.rev || 0, updatedAt: row.updated_at || 0, data: row.data || null };
  }
  const f = fileFor(code);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; }
}

async function writeState(code, data) {
  if (db) {
    const cur = await readState(code);
    const rev = (cur ? cur.rev : 0) + 1;
    const upd = Date.now();
    await db.query(
      `INSERT INTO states(code, rev, updated_at, data) VALUES($1,$2,$3,$4)
       ON CONFLICT(code) DO UPDATE SET rev=$2, updated_at=$3, data=$4`,
      [code, rev, upd, data]
    );
    return { rev, updatedAt: upd };
  }
  let cur = { rev: 0, updatedAt: 0, data: null };
  const f = fileFor(code);
  if (fs.existsSync(f)) { try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {} }
  const next = { rev: (cur.rev || 0) + 1, updatedAt: Date.now(), data };
  fs.writeFileSync(f, JSON.stringify(next));
  return { rev: next.rev, updatedAt: next.updatedAt };
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  let url;
  try { url = new URL(req.url, "http://localhost"); } catch (e) { return sendJson(res, 400, { error: "bad url" }); }
  const p = url.pathname;

  if (p === "/api/health") return sendJson(res, 200, { ok: true, mode: USE_DB ? "db" : "file" });

  if (p === "/api/state") {
    if (req.method === "GET") {
      const code = sanitizeCode(url.searchParams.get("code"));
      if (!code) return sendJson(res, 400, { error: "missing code" });
      try {
        const st = await readState(code);
        if (!st) return sendJson(res, 404, { error: "no data" });
        return sendJson(res, 200, { rev: st.rev || 0, updatedAt: st.updatedAt || 0, data: st.data || null });
      } catch (e) { console.error("读状态失败:", e.message); return sendJson(res, 500, { error: "read fail" }); }
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 5e6) req.destroy(); });
      req.on("end", async () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: "bad json" }); }
        const cd = sanitizeCode(parsed.code);
        if (!cd) return sendJson(res, 400, { error: "missing code" });
        if (!parsed.data || typeof parsed.data !== "object") return sendJson(res, 400, { error: "missing data" });
        try {
          const r = await writeState(cd, parsed.data);
          return sendJson(res, 200, { rev: r.rev, updatedAt: r.updatedAt });
        } catch (e) { console.error("写状态失败:", e.message); return sendJson(res, 500, { error: "write fail" }); }
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
  console.log("🪙 小小积分银行（云同步）已启动: http://localhost:" + PORT + " | 模式:" + (USE_DB ? "数据库(Neon)" : "本地文件"));
});
