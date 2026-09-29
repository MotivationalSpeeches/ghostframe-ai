const RUNWAY_API = "https://api.dev.runwayml.com";
const RUNWAY_VERSION = "2024-11-06";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      if (!cors) return json({ error: "Origin not allowed" }, 403);
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, provider: "runway" }, 200, cors);

    if (!cors) return json({ error: "Origin not allowed" }, 403);
    if (!env.RUNWAY_API_KEY) return json({ error: "Runway is not configured on the server" }, 503, cors);

    if (request.method === "POST" && url.pathname === "/api/videos/generate") {
      return generateVideo(request, env, cors);
    }

    const statusMatch = url.pathname.match(/^\/api\/videos\/([A-Za-z0-9-]{8,})\/status$/);
    if (request.method === "GET" && statusMatch) {
      return getTask(statusMatch[1], env, cors);
    }

    if (request.method === "POST" && url.pathname === "/api/videos/publish") {
      return json({ error: "Add TikTok or YouTube OAuth credentials before publishing" }, 501, cors);
    }

    return json({ error: "Not found" }, 404, cors);
  }
};

async function generateVideo(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON" }, 400, cors);
  }

  const promptText = String(body.promptText || "").trim();
  const requestedDuration = Number(body.duration || 5);
  const duration = Math.min(10, Math.max(2, Math.round(requestedDuration)));
  if (promptText.length < 8 || promptText.length > 1000) {
    return json({ error: "Prompt must be between 8 and 1000 characters" }, 400, cors);
  }

  const response = await fetch(`${RUNWAY_API}/v1/text_to_video`, {
    method: "POST",
    headers: runwayHeaders(env.RUNWAY_API_KEY),
    body: JSON.stringify({
      model: "gen4.5",
      promptText,
      ratio: "720:1280",
      duration
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return json({ error: readableRunwayError(data, response.status) }, response.status, cors);
  }
  return json({ taskId: data.id, status: data.status || "PENDING" }, 202, cors);
}

async function getTask(taskId, env, cors) {
  const response = await fetch(`${RUNWAY_API}/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: runwayHeaders(env.RUNWAY_API_KEY, false)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return json({ error: readableRunwayError(data, response.status) }, response.status, cors);
  return json({
    id: data.id,
    status: data.status,
    progress: data.progress ?? null,
    output: Array.isArray(data.output) ? data.output : [],
    failureCode: data.failureCode || null
  }, 200, cors);
}

function runwayHeaders(secret, includeJson = true) {
  const headers = {
    Authorization: `Bearer ${secret}`,
    "X-Runway-Version": RUNWAY_VERSION
  };
  if (includeJson) headers["Content-Type"] = "application/json";
  return headers;
}

function corsHeaders(origin, allowedOrigin) {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!origin || (!local && origin !== allowedOrigin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function readableRunwayError(data, status) {
  if (status === 401) return "Runway rejected the API key";
  if (status === 429) return "Runway is busy or the project limit was reached";
  return data?.error || data?.message || `Runway request failed (${status})`;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}
