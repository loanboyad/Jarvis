// Logique partagée du proxy : utilisée par la fonction serverless (api/chat.js)
// et par le serveur Node autonome (server.js). La clé API ne quitte jamais le serveur.
import Anthropic from "@anthropic-ai/sdk";
import { timingSafeEqual } from "node:crypto";

const MODEL = process.env.JARVIS_MODEL || "claude-opus-5-5";
// "low" : réponses rapides, idéal pour un assistant vocal.
const EFFORT = process.env.JARVIS_EFFORT || "low";

const MAX_TURNS = 30; // messages conservés dans l'historique envoyé à Claude
const MAX_CHARS = 4000; // longueur max d'un message

let client;
function getClient() {
  // Lit ANTHROPIC_API_KEY dans l'environnement.
  if (!client) client = new Anthropic();
  return client;
}

function systemPrompt() {
  const now = new Date().toLocaleString("fr-FR", {
    timeZone: process.env.JARVIS_TIMEZONE || "Europe/Paris",
    dateStyle: "full",
    timeStyle: "short",
  });
  return `Tu es J.A.R.V.I.S., l'assistant personnel inspiré de celui de Tony Stark.

Personnalité :
- Toujours poli et posé, avec un flegme britannique et un humour pince-sans-rire discret.
- Tu appelles ton interlocuteur « Monsieur ».
- Tu es loyal, compétent et légèrement ironique, jamais servile ni moqueur.

Format — tes réponses sont lues à voix haute par une synthèse vocale :
- Réponds en français, de façon concise : une à trois phrases, sauf demande explicite de détails.
- Aucun Markdown, aucune liste à puces, aucun emoji, aucun bloc de code. Uniquement des phrases naturelles.
- Écris les nombres, unités et symboles de façon à ce qu'ils soient prononçables.
- Si la demande est ambiguë ou mal transcrite, demande brièvement une précision.
- Tu n'as pas accès à Internet ni aux appareils de Monsieur ; si on te demande une action que tu ne peux pas faire, dis-le avec élégance.

Réponse sensible à la latence : commence ta réponse visible immédiatement.

Date et heure actuelles : ${now}.`;
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function checkAccess(headers) {
  const expected = process.env.JARVIS_ACCESS_TOKEN;
  if (!expected) return;
  const given = String(headers["x-jarvis-token"] || "");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, "unauthorized", "Code d'accès invalide.");
  }
}

function validateMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, "bad_request", "Historique de conversation manquant.");
  }
  const messages = raw.slice(-MAX_TURNS).map((m) => {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      throw new HttpError(400, "bad_request", "Message invalide.");
    }
    return { role: m.role, content: m.content.slice(0, MAX_CHARS) };
  });
  // L'API attend un premier message « user ».
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    throw new HttpError(400, "bad_request", "Le dernier message doit venir de l'utilisateur.");
  }
  return messages;
}

async function askClaude(messages) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new HttpError(500, "config", "ANTHROPIC_API_KEY n'est pas configurée sur le serveur.");
  }
  let response;
  try {
    response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // Si le modèle décline une requête, l'API la relance automatiquement
      // sur le modèle de repli recommandé.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: EFFORT },
      system: systemPrompt(),
      messages,
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new HttpError(500, "config", "Clé API Anthropic invalide.");
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new HttpError(429, "rate_limited", "Trop de requêtes, réessayez dans un instant.");
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new HttpError(502, "upstream_unreachable", "Impossible de joindre l'API Claude.");
    }
    if (err instanceof Anthropic.APIError) {
      console.error("Erreur API Claude :", err.status, err.message);
      throw new HttpError(502, "upstream_error", "L'API Claude a renvoyé une erreur.");
    }
    throw err;
  }

  if (response.stop_reason === "refusal") {
    return "Je crains de ne pas pouvoir vous aider sur ce point, Monsieur.";
  }
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
  return text || "Pardonnez-moi, Monsieur, je n'ai rien de pertinent à ajouter.";
}

// Point d'entrée commun : renvoie { status, body }.
export async function handleChat({ method, headers, body }) {
  try {
    if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Méthode non autorisée.");
    checkAccess(headers);
    const messages = validateMessages(body?.messages);
    const reply = await askClaude(messages);
    return { status: 200, body: { reply } };
  } catch (err) {
    if (err instanceof HttpError) {
      return { status: err.status, body: { error: err.message, code: err.code } };
    }
    console.error(err);
    return { status: 500, body: { error: "Erreur interne du serveur.", code: "internal" } };
  }
}
