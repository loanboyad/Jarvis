// Fonction serverless Vercel : POST /api/chat
import { handleChat } from "../lib/jarvis.js";

export default async function handler(req, res) {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const result = await handleChat({ method: req.method, headers: req.headers, body });
  res.setHeader("Cache-Control", "no-store");
  res.status(result.status).json(result.body);
}
