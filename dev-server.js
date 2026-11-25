// Local dev server: serves /public and the /api/ai function. Run: GEMINI_API_KEY=... npm run dev
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import handler from "./api/ai.js";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml" };
const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/ai") {
    let body = "";
    for await (const c of req) body += c;
    const shim = {
      status(code) { res.statusCode = code; return shim; },
      json(obj) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); },
    };
    req.body = body;
    return handler(req, shim);
  }
  const p = normalize(join("public", url.pathname === "/" ? "index.html" : url.pathname));
  if (!p.startsWith("public")) { res.statusCode = 403; return res.end(); }
  try {
    const data = await readFile(p);
    res.setHeader("Content-Type", TYPES[extname(p)] || "application/octet-stream");
    res.end(data);
  } catch { res.statusCode = 404; res.end("Not found"); }
}).listen(PORT, () => console.log(`FixFlow on http://localhost:${PORT}`));
