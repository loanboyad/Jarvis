// Serveur Node autonome (sans dépendance web) : sert la PWA et le proxy /api/chat.
// Utile en local (`npm start`) ou sur un hébergeur Node (Render, Railway, Fly.io...).
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleChat } from "./lib/jarvis.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 200_000;

// Charge un éventuel fichier .env (format CLE=valeur) sans dépendance.
try {
  const env = await readFile(path.join(here, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && match[2] && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch {}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, "Interdit", "text/plain");
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    const data = await readFile(file);
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": file.endsWith("sw.js") ? "no-cache" : "public, max-age=300",
    });
    res.end(data);
  } catch {
    send(res, 404, "Introuvable", "text/plain");
  }
}

http
  .createServer(async (req, res) => {
    if (req.url.startsWith("/api/chat")) {
      const body = req.method === "POST" ? await readJson(req) : null;
      const result = await handleChat({ method: req.method, headers: req.headers, body });
      return send(res, result.status, result.body);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Méthode non autorisée", "text/plain");
    return serveStatic(req, res);
  })
  .listen(PORT, () => console.log(`Jarvis en ligne sur http://localhost:${PORT}`));
