// Cloudflare Pages Function · /api/health
export async function onRequest() {
  return new Response(JSON.stringify({ ok: true, t: Date.now() }), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
