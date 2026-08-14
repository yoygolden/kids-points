// Cloudflare Pages Function · /api/state
// 契约与 Node 版 server.js 的 /api/state 完全一致，前端无需改动。
//   GET  /api/state?code=XXXX  -> { rev, updatedAt, data }  | 不存在返回 404
//   POST /api/state  body { code, data } -> { rev, updatedAt }
// 数据存于 D1 表 states（按家庭码隔离，last-write-wins）。

const TABLE = "states";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// 首次访问自动建表（幂等，之后变 no-op）
async function ensureTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       code TEXT PRIMARY KEY,
       data TEXT NOT NULL,
       rev INTEGER NOT NULL DEFAULT 0,
       updated_at INTEGER NOT NULL DEFAULT 0
     )`
  ).run();
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return json({ error: "invalid code" }, 400);
  try {
    await ensureTable(env);
    const row = await env.DB.prepare(
      `SELECT code, data, rev, updated_at FROM ${TABLE} WHERE code=?`
    ).bind(code).first();
    if (!row) return json({ empty: true }, 404);
    let data = {};
    try { data = JSON.parse(row.data || "{}"); } catch (e) { data = {}; }
    return json({ rev: row.rev, updatedAt: row.updated_at, data });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const code = String(body.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return json({ error: "invalid code" }, 400);
  const data = body.data !== undefined ? body.data : {};
  const now = Date.now();
  try {
    await ensureTable(env);
    const row = await env.DB.prepare(`SELECT rev FROM ${TABLE} WHERE code=?`).bind(code).first();
    if (row) {
      const rev = (row.rev || 0) + 1;
      await env.DB.prepare(
        `UPDATE ${TABLE} SET data=?, rev=?, updated_at=? WHERE code=?`
      ).bind(JSON.stringify(data), rev, now, code).run();
      return json({ rev, updatedAt: now });
    }
    await env.DB.prepare(
      `INSERT INTO ${TABLE} (code, data, rev, updated_at) VALUES (?, ?, 1, ?)`
    ).bind(code, JSON.stringify(data), now).run();
    return json({ rev: 1, updatedAt: now });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
