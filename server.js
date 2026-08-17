#!/usr/bin/env node
/**
 * 小小积分银行 — 账号云同步后端（零依赖 Node.js）
 * - 静态托管 kids-points.html（前后端同源）
 * - 账号注册 / 登录（scrypt 密码哈希 + Bearer Token，支持多设备同时在线）
 * - 每个账号独立存储整份应用状态 S（/api/sync 上传、/api/profile 拉取）
 * - 兼容旧版「家庭同步码」/api/state（文件模式，供 Cloudflare/静态部署使用）
 * 数据默认存 ./data；在 Railway/Render 挂了持久磁盘时，把 DATA_DIR 指到挂载点（如 /data）即可永久保存
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "accounts.json");

/* ---------- 账号持久化 ---------- */
function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (s && s.users) {
      for (const acc in s.users) {
        const u = s.users[acc];
        if (u && typeof u.token === "string") { u.tokens = [u.token]; delete u.token; }
        if (!Array.isArray(u.tokens)) u.tokens = [];
        if (typeof u.state === "undefined") u.state = null;
        if (typeof u.rev !== "number") u.rev = 0;
        if (typeof u.updatedAt !== "number") u.updatedAt = 0;
      }
    }
    return s;
  } catch {
    return { users: {} }; // users[account] = { account, salt, hash, tokens:[], nickname, state, rev, updatedAt }
  }
}
let store = loadStore();
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
    } catch (e) {
      console.error("保存失败", e);
    }
  }, 200);
}

/* ---------- 工具 ---------- */
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function newToken() {
  return crypto.randomBytes(24).toString("hex");
}
function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e7) req.destroy(); // 10MB 上限
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
function getUserByToken(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  for (const acc in store.users) {
    const u = store.users[acc];
    if (Array.isArray(u.tokens) && u.tokens.includes(token)) return u;
  }
  return null;
}

/* ---------- 旧版「家庭同步码」(文件模式，兼容) ---------- */
function sanitizeCode(c) {
  return String(c || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}
function fileFor(code) { return path.join(DATA_DIR, "state_" + code + ".json"); }
async function readState(code) {
  const f = fileFor(code);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; }
}
async function writeState(code, data) {
  let cur = { rev: 0, updatedAt: 0, data: null };
  const f = fileFor(code);
  if (fs.existsSync(f)) { try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {} }
  const next = { rev: (cur.rev || 0) + 1, updatedAt: Date.now(), data };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(next));
  return { rev: next.rev, updatedAt: next.updatedAt };
}

/* ---------- 静态文件 ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};
function serveStatic(req, res, urlPath) {
  let filePath = decodeURIComponent(urlPath);
  if (filePath === "/" || filePath === "") filePath = "/kids-points.html";
  const full = path.normalize(path.join(ROOT, filePath));
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(full, (err, buf) => {
    if (err) {
      // 回退到首页（单页应用）
      fs.readFile(path.join(ROOT, "kids-points.html"), (e2, idx) => {
        if (e2) { res.writeHead(404); res.end("Not found"); }
        else { res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(idx); }
      });
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(buf);
  });
}

/* ---------- API ---------- */
async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  // 注册
  if (p === "/api/register" && method === "POST") {
    const b = await readBody(req);
    if (!b.account || !b.password) return send(res, 400, { error: "账号和密码不能为空" });
    if (store.users[b.account]) return send(res, 409, { error: "该账号已存在" });
    const { salt, hash } = hashPassword(b.password);
    const token = newToken();
    store.users[b.account] = {
      account: b.account,
      salt, hash,
      tokens: [token],
      nickname: b.nickname || b.account,
      state: null, rev: 0, updatedAt: 0
    };
    saveStore();
    return send(res, 200, { token, account: b.account, nickname: store.users[b.account].nickname });
  }

  // 登录
  if (p === "/api/login" && method === "POST") {
    const b = await readBody(req);
    const u = store.users[b.account];
    if (!u) return send(res, 401, { error: "账号不存在" });
    const { hash } = hashPassword(b.password, u.salt);
    if (hash !== u.hash) return send(res, 401, { error: "密码错误" });
    // 追加新 token，不覆盖旧设备会话（多设备同时在线同步）
    u.tokens = Array.isArray(u.tokens) ? u.tokens : [];
    const token = newToken();
    u.tokens.push(token);
    if (u.tokens.length > 10) u.tokens = u.tokens.slice(-10); // 保留最近 10 台设备的会话
    saveStore();
    return send(res, 200, { token, account: u.account, nickname: u.nickname });
  }

  // 以下接口需要登录
  const user = getUserByToken(req);
  if (!user) return send(res, 401, { error: "未登录或登录已过期" });

  // 当前用户信息
  if (p === "/api/me" && method === "GET") {
    return send(res, 200, { account: user.account, nickname: user.nickname });
  }
  if (p === "/api/me" && method === "PUT") {
    const b = await readBody(req);
    if (b.nickname) user.nickname = b.nickname;
    saveStore();
    return send(res, 200, { account: user.account, nickname: user.nickname });
  }

  // 拉取整份状态（多端同步）
  if (p === "/api/profile" && method === "GET") {
    return send(res, 200, { rev: user.rev || 0, updatedAt: user.updatedAt || 0, state: user.state || null });
  }

  // 上传整份状态（整页 last-write-wins，多端以最近一次上传为准）
  if (p === "/api/sync" && method === "POST") {
    const b = await readBody(req);
    if (!b || typeof b.state !== "object" || b.state === null) return send(res, 400, { error: "缺少 state" });
    user.state = b.state;
    user.rev = (user.rev || 0) + 1;
    user.updatedAt = Date.now();
    saveStore();
    return send(res, 200, { rev: user.rev, updatedAt: user.updatedAt, state: user.state });
  }

  // 导出（完整备份）
  if (p === "/api/export" && method === "GET") {
    return send(res, 200, {
      app: "KidsPoints",
      version: 1,
      account: user.account,
      nickname: user.nickname,
      exportedAt: new Date().toISOString(),
      state: user.state || null
    });
  }

  // 导入（用备份覆盖云端状态）
  if (p === "/api/import" && method === "POST") {
    const b = await readBody(req);
    if (typeof b.state !== "object" || b.state === null) return send(res, 400, { error: "缺少 state" });
    user.state = b.state;
    user.rev = (user.rev || 0) + 1;
    user.updatedAt = Date.now();
    saveStore();
    return send(res, 200, { ok: true });
  }

  // 旧版「家庭同步码」(文件模式，兼容)
  if (p === "/api/state" && method === "GET") {
    const code = sanitizeCode(url.searchParams.get("code"));
    if (!code) return send(res, 400, { error: "missing code" });
    try {
      const st = await readState(code);
      if (!st) return send(res, 404, { error: "no data" });
      return send(res, 200, { rev: st.rev || 0, updatedAt: st.updatedAt || 0, data: st.data || null });
    } catch (e) { return send(res, 500, { error: "read fail" }); }
  }
  if (p === "/api/state" && method === "POST") {
    const b = await readBody(req);
    const cd = sanitizeCode(b.code);
    if (!cd) return send(res, 400, { error: "missing code" });
    if (!b.data || typeof b.data !== "object") return send(res, 400, { error: "missing data" });
    try {
      const r = await writeState(cd, b.data);
      return send(res, 200, { rev: r.rev, updatedAt: r.updatedAt });
    } catch (e) { return send(res, 500, { error: "write fail" }); }
  }

  return send(res, 404, { error: "接口不存在" });
}

/* ---------- 服务器 ---------- */
const server = http.createServer((req, res) => {
  // 允许跨域（便于本地开发）；生产环境同源部署，这些头无害
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/health") return send(res, 200, { ok: true });
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((e) => {
      console.error(e);
      send(res, 500, { error: "服务器错误" });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🪙 小小积分银行（账号云同步）已启动: http://0.0.0.0:${PORT}`);
});
