// Local dev server: serves /public, /privacy and the /api/ai function.
// With GEMINI_API_KEY set it runs api/ai.js locally; without it, /api/ai is forwarded to the
// deployed function (FF_AI_UPSTREAM, default https://fixflow-steel.vercel.app) so no key is needed locally.
// Run: NODE_USE_ENV_PROXY=1 node dev-server.js   (port 3000)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import handler from "./api/ai.js";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json" };
const PORT = process.env.PORT || 3000;
const UPSTREAM = process.env.FF_AI_UPSTREAM || "https://fixflow-steel.vercel.app";

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/ai") {
    let body = "";
    for await (const c of req) body += c;
    if (!process.env.GEMINI_API_KEY) {
      try {
        const r = await fetch(UPSTREAM + "/api/ai", { method: req.method, headers: { "Content-Type": "application/json" }, body: req.method === "POST" ? body : undefined });
        res.statusCode = r.status; res.setHeader("Content-Type", "application/json");
        return res.end(await r.text());
      } catch (e) { res.statusCode = 503; return res.end(JSON.stringify({ error: "AI upstream unreachable", fallback: true })); }
    }
    const shim = {
      status(code) { res.statusCode = code; return shim; },
      json(obj) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); },
    };
    req.body = body;
    return handler(req, shim);
  }
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (!extname(path)) path += ".html"; // mirrors vercel.json cleanUrls (/privacy -> privacy.html)
  const p = normalize(join("public", path));
  if (!p.startsWith("public")) { res.statusCode = 403; return res.end(); }
  try {
    const data = await readFile(p);
    res.setHeader("Content-Type", TYPES[extname(p)] || "application/octet-stream");
    res.end(data);
  } catch { res.statusCode = 404; res.setHeader("Content-Type", "text/plain"); res.end("Not found"); }
}).listen(PORT, () => console.log(`FixFlow on http://localhost:${PORT}`));
