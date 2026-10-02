const COMPACTIFAI_API = "https://api.compactif.ai/v1";
const JSON2VIDEO_API = "https://api.json2video.com/v2";
const TIKTOK_AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      if (!cors) return json({ error: "Origin not allowed" }, 403);
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        provider: "compactifai+json2video",
        services: {
          compactifaiConfigured: Boolean(env.COMPACTIFAI_API_KEY),
          json2videoConfigured: Boolean(env.JSON2VIDEO_API_KEY)
        },
        oauth: {
          storageConfigured: Boolean(env.OAUTH_SESSIONS && env.TOKEN_ENCRYPTION_KEY),
          tiktokConfigured: oauthConfigured("tiktok", env),
          youtubeConfigured: oauthConfigured("youtube", env)
        }
      }, 200, cors || {});
    }

    const callbackMatch = url.pathname.match(/^\/auth\/(tiktok|youtube)\/callback$/);
    if (request.method === "GET" && callbackMatch) {
      return finishOAuth(callbackMatch[1], url, env);
    }

    if (!cors) return json({ error: "Origin not allowed" }, 403);

    const oauthStartMatch = url.pathname.match(/^\/api\/oauth\/(tiktok|youtube)\/start$/);
    if (request.method === "POST" && oauthStartMatch) {
      return startOAuth(oauthStartMatch[1], request, url, env, cors);
    }

    if (request.method === "GET" && url.pathname === "/api/oauth/status") {
      return oauthStatus(request, env, cors);
    }

    const disconnectMatch = url.pathname.match(/^\/api\/oauth\/(tiktok|youtube)\/disconnect$/);
    if (request.method === "POST" && disconnectMatch) {
      return disconnectOAuth(disconnectMatch[1], request, env, cors);
    }

    if (request.method === "POST" && url.pathname === "/api/videos/generate") {
      if (!env.COMPACTIFAI_API_KEY) return json({ error: "CompactifAI is not configured on the server" }, 503, cors);
      if (!env.JSON2VIDEO_API_KEY) return json({ error: "JSON2Video is not configured on the server" }, 503, cors);
      return generateVideo(request, env, cors);
    }

    const statusMatch = url.pathname.match(/^\/api\/videos\/([A-Za-z0-9_-]{8,})\/status$/);
    if (request.method === "GET" && statusMatch) {
      if (!env.JSON2VIDEO_API_KEY) return json({ error: "JSON2Video is not configured on the server" }, 503, cors);
      return getTask(statusMatch[1], env, cors);
    }

    if (request.method === "POST" && url.pathname === "/api/videos/publish") {
      return json({ error: "OAuth publishing is not active until platform credentials are configured and approved" }, 501, cors);
    }

    return json({ error: "Not found" }, 404, cors);
  }
};

export class OAuthSessionStore {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const provider = url.pathname.slice(1);
    if (!/^(tiktok|youtube)$/.test(provider)) return json({ error: "Unknown provider" }, 404);

    if (request.method === "GET") {
      const value = await this.storage.get(provider);
      return json({ connected: Boolean(value), metadata: value?.metadata || null });
    }

    if (request.method === "PUT") {
      const value = await request.json();
      await this.storage.put(provider, value);
      return json({ ok: true });
    }

    if (request.method === "DELETE") {
      await this.storage.delete(provider);
      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  }
}

async function startOAuth(provider, request, url, env, cors) {
  const workspace = getWorkspaceId(request);
  if (!workspace) return json({ error: "A valid workspace ID is required" }, 400, cors);
  if (!env.OAUTH_SESSIONS || !env.TOKEN_ENCRYPTION_KEY) {
    return json({ error: "OAuth token storage is not configured on Cloudflare" }, 503, cors);
  }
  if (!oauthConfigured(provider, env)) {
    return json({ error: `${providerName(provider)} OAuth credentials have not been added to Cloudflare yet` }, 503, cors);
  }

  const redirectUri = `${url.origin}/auth/${provider}/callback`;
  const state = await seal({
    provider,
    workspace,
    redirectUri,
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomToken(24)
  }, env.TOKEN_ENCRYPTION_KEY);

  const authorizationUrl = provider === "tiktok"
    ? tiktokAuthorizationUrl(env.TIKTOK_CLIENT_KEY, redirectUri, state)
    : youtubeAuthorizationUrl(env.YOUTUBE_CLIENT_ID, redirectUri, state);

  return json({ authorizationUrl }, 200, cors);
}

async function finishOAuth(provider, url, env) {
  const appUrl = configuredAppUrl(env);
  const oauthError = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");
  if (oauthError) return redirectToApp(appUrl, provider, "error", errorDescription || oauthError);

  const code = url.searchParams.get("code") || "";
  const stateToken = url.searchParams.get("state") || "";
  if (!code || !stateToken || !env.TOKEN_ENCRYPTION_KEY || !env.OAUTH_SESSIONS) {
    return redirectToApp(appUrl, provider, "error", "OAuth callback was incomplete");
  }

  let state;
  try {
    state = await unseal(stateToken, env.TOKEN_ENCRYPTION_KEY);
  } catch {
    return redirectToApp(appUrl, provider, "error", "OAuth security check failed");
  }
  if (state.provider !== provider || state.expiresAt < Date.now() || !validWorkspaceId(state.workspace)) {
    return redirectToApp(appUrl, provider, "error", "OAuth request expired or was invalid");
  }

  try {
    const tokenData = await exchangeOAuthCode(provider, code, state.redirectUri, env);
    if (!tokenData.access_token) throw new Error("The platform did not return an access token");

    const encrypted = await seal(tokenData, env.TOKEN_ENCRYPTION_KEY);
    const metadata = {
      connectedAt: new Date().toISOString(),
      expiresAt: tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString() : null,
      scope: tokenData.scope || tokenData.scopes || null
    };
    const stub = oauthStore(env, state.workspace);
    await stub.fetch(`https://oauth.internal/${provider}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encrypted, metadata })
    });
    return redirectToApp(appUrl, provider, "connected");
  } catch (error) {
    return redirectToApp(appUrl, provider, "error", error.message || "OAuth token exchange failed");
  }
}

async function oauthStatus(request, env, cors) {
  const workspace = getWorkspaceId(request);
  if (!workspace) return json({ error: "A valid workspace ID is required" }, 400, cors);

  const result = {
    storageConfigured: Boolean(env.OAUTH_SESSIONS && env.TOKEN_ENCRYPTION_KEY),
    providers: {
      tiktok: { configured: oauthConfigured("tiktok", env), connected: false },
      youtube: { configured: oauthConfigured("youtube", env), connected: false }
    }
  };
  if (!result.storageConfigured) return json(result, 200, cors);

  const stub = oauthStore(env, workspace);
  await Promise.all(["tiktok", "youtube"].map(async (provider) => {
    const response = await stub.fetch(`https://oauth.internal/${provider}`);
    const data = await response.json();
    result.providers[provider].connected = Boolean(data.connected);
    result.providers[provider].metadata = data.metadata || null;
  }));
  return json(result, 200, cors);
}

async function disconnectOAuth(provider, request, env, cors) {
  const workspace = getWorkspaceId(request);
  if (!workspace) return json({ error: "A valid workspace ID is required" }, 400, cors);
  if (!env.OAUTH_SESSIONS) return json({ error: "OAuth storage is not configured" }, 503, cors);
  await oauthStore(env, workspace).fetch(`https://oauth.internal/${provider}`, { method: "DELETE" });
  return json({ ok: true }, 200, cors);
}

function tiktokAuthorizationUrl(clientKey, redirectUri, state) {
  const url = new URL(TIKTOK_AUTH_URL);
  url.searchParams.set("client_key", clientKey);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "user.info.basic,video.publish");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

function youtubeAuthorizationUrl(clientId, redirectUri, state) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "https://www.googleapis.com/auth/youtube.upload");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function exchangeOAuthCode(provider, code, redirectUri, env) {
  const params = new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: redirectUri });
  let tokenUrl;
  if (provider === "tiktok") {
    tokenUrl = TIKTOK_TOKEN_URL;
    params.set("client_key", env.TIKTOK_CLIENT_KEY);
    params.set("client_secret", env.TIKTOK_CLIENT_SECRET);
  } else {
    tokenUrl = GOOGLE_TOKEN_URL;
    params.set("client_id", env.YOUTUBE_CLIENT_ID);
    params.set("client_secret", env.YOUTUBE_CLIENT_SECRET);
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const message = typeof data.error === "string"
      ? data.error_description || data.error
      : data.error?.message || "OAuth token exchange failed";
    throw new Error(message);
  }
  return data;
}

function oauthStore(env, workspace) {
  const id = env.OAUTH_SESSIONS.idFromName(workspace);
  return env.OAUTH_SESSIONS.get(id);
}

function oauthConfigured(provider, env) {
  if (!env.TOKEN_ENCRYPTION_KEY || !env.OAUTH_SESSIONS) return false;
  return provider === "tiktok"
    ? Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET)
    : Boolean(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET);
}

function configuredAppUrl(env) {
  return env.APP_URL || `${env.ALLOWED_ORIGIN}/ghostframe-ai/`;
}

function redirectToApp(appUrl, provider, status, message = "") {
  const destination = new URL(appUrl);
  destination.searchParams.set("oauth", provider);
  destination.searchParams.set("status", status);
  if (message) destination.searchParams.set("message", message.slice(0, 180));
  destination.hash = "connections";
  return Response.redirect(destination.toString(), 302);
}

function getWorkspaceId(request) {
  const value = request.headers.get("X-Workspace-Id") || "";
  return validWorkspaceId(value) ? value : null;
}

function validWorkspaceId(value) {
  return /^[A-Za-z0-9_-]{20,128}$/.test(String(value || ""));
}

function providerName(provider) {
  return provider === "tiktok" ? "TikTok" : "YouTube";
}

function randomToken(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return base64UrlEncode(bytes);
}

async function seal(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);
  return base64UrlEncode(combined);
}

async function unseal(value, secret) {
  const combined = base64UrlDecode(value);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const key = await encryptionKey(secret, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function encryptionKey(secret, usages) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, usages);
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function generateVideo(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON" }, 400, cors);
  }

  const promptText = String(body.promptText || body.topic || "").trim();
  const duration = Math.min(60, Math.max(15, Math.round(Number(body.duration || 30))));
  if (promptText.length < 8 || promptText.length > 1000) {
    return json({ error: "Prompt must be between 8 and 1000 characters" }, 400, cors);
  }

  try {
    const script = await createVideoScript(promptText, duration, body, env);
    const movie = buildMovie(script, duration, body);
    const response = await fetch(`${JSON2VIDEO_API}/movies`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.JSON2VIDEO_API_KEY },
      body: JSON.stringify(movie)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success || !data.project) {
      return json({ error: readableJson2VideoError(data, response.status) }, response.ok ? 502 : response.status, cors);
    }
    return json({
      taskId: data.project,
      status: "PENDING",
      title: script.title,
      hook: script.hook,
      sceneCount: script.scenes.length
    }, 202, cors);
  } catch (error) {
    return json({ error: error.message || "The video workflow could not start" }, 502, cors);
  }
}

async function getTask(taskId, env, cors) {
  const response = await fetch(`${JSON2VIDEO_API}/movies?project=${encodeURIComponent(taskId)}`, {
    headers: { "x-api-key": env.JSON2VIDEO_API_KEY }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    return json({ error: readableJson2VideoError(data, response.status) }, response.ok ? 502 : response.status, cors);
  }
  const movie = data.movie || {};
  const rawStatus = String(movie.status || "running").toLowerCase();
  const status = rawStatus === "done"
    ? "SUCCEEDED"
    : rawStatus === "error" || rawStatus === "timeout"
      ? "FAILED"
      : "RUNNING";
  const progress = Number(movie.progress);
  return json({
    id: movie.project || taskId,
    status,
    progress: Number.isFinite(progress) ? progress / 100 : null,
    output: movie.url ? [movie.url] : [],
    thumbnail: movie.thumbnail || null,
    failureCode: rawStatus === "timeout" ? "RENDER_TIMEOUT" : null,
    failure: status === "FAILED" ? movie.message || "JSON2Video could not render this video" : null
  }, 200, cors);
}

async function createVideoScript(topic, duration, options, env) {
  const sceneCount = Math.max(3, Math.min(8, Math.round(duration / 6)));
  const tone = String(options.tone || "dramatic").slice(0, 60);
  const niche = String(options.niche || "facts and curiosity").slice(0, 80);
  const response = await fetch(`${COMPACTIFAI_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.COMPACTIFAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.COMPACTIFAI_MODEL || "carina-60b",
      temperature: 0.75,
      max_tokens: 1400,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You write concise, truthful scripts for vertical faceless short videos. Return valid JSON only with keys title, hook, and scenes. scenes must be an array of objects with headline and narration. Avoid unverifiable claims, impersonation, copyrighted lyrics, and unsafe instructions."
        },
        {
          role: "user",
          content: `Create a ${duration}-second ${tone} video for the ${niche} niche about: ${topic}. Use exactly ${sceneCount} scenes. Each headline must be 2-7 words. Each narration must be no more than ${Math.max(10, Math.round((duration / sceneCount) * 2.1))} words. Start with a strong hook and end with a memorable takeaway.`
        }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.detail || `CompactifAI request failed (${response.status})`;
    throw new Error(message);
  }
  const content = data?.choices?.[0]?.message?.content;
  const parsed = parseModelJson(content);
  const scenes = Array.isArray(parsed.scenes)
    ? parsed.scenes.slice(0, sceneCount).map((scene, index) => ({
        headline: cleanText(scene?.headline || `Scene ${index + 1}`, 90),
        narration: cleanText(scene?.narration || scene?.text || "", 320)
      })).filter((scene) => scene.narration)
    : [];
  if (scenes.length < 2) throw new Error("CompactifAI did not return a usable video script");
  return {
    title: cleanText(parsed.title || topic, 120),
    hook: cleanText(parsed.hook || scenes[0].headline, 160),
    scenes
  };
}

function buildMovie(script, duration, options) {
  const palette = ["#12102b", "#19123d", "#0f2940", "#26113b", "#102f2f", "#2b1710"];
  const secondsPerScene = Math.max(3, Number((duration / script.scenes.length).toFixed(2)));
  const voice = voiceName(options.voice);
  return {
    width: 1080,
    height: 1920,
    quality: "high",
    comment: `GhostFrame: ${script.title}`,
    "client-data": { source: "ghostframe", title: script.title },
    scenes: script.scenes.map((scene, index) => ({
      duration: secondsPerScene,
      "background-color": palette[index % palette.length],
      elements: [
        {
          type: "text",
          text: String(index + 1).padStart(2, "0"),
          width: "80%",
          height: "12%",
          x: "center",
          y: "12%",
          duration: -2,
          "fade-in": 0.25,
          settings: {
            "font-family": "Poppins",
            "font-size": "42px",
            "font-weight": "700",
            color: "#d7ff38",
            "letter-spacing": "8px",
            "text-align": "left",
            "vertical-position": "center"
          }
        },
        {
          type: "text",
          text: scene.headline.toUpperCase(),
          width: "84%",
          height: "46%",
          x: "center",
          y: "25%",
          duration: -2,
          "fade-in": 0.35,
          "fade-out": 0.2,
          settings: {
            "font-family": "Poppins",
            "font-size": "104px",
            "font-weight": "800",
            color: "#ffffff",
            "line-height": "0.96",
            "text-align": "left",
            "vertical-position": "center"
          }
        },
        { type: "voice", text: scene.narration, model: "azure", voice }
      ]
    })),
    elements: [
      {
        type: "subtitles",
        language: "en",
        model: "whisper",
        settings: {
          style: "boxed-word",
          position: "mid-bottom-center",
          "font-family": "Poppins",
          "font-size": 76,
          "font-weight": "800",
          "all-caps": true,
          "max-words-per-line": 4,
          "word-color": "#111111",
          "line-color": "#ffffff",
          "box-color": "#d7ff38",
          "outline-color": "#000000",
          "outline-width": 2
        }
      }
    ]
  };
}

function voiceName(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("nova")) return "en-US-AvaMultilingualNeural";
  if (normalized.includes("vale")) return "en-US-AndrewMultilingualNeural";
  return "en-US-EmmaMultilingualNeural";
}

function parseModelJson(content) {
  if (typeof content === "object" && content) return content;
  const text = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("CompactifAI returned an unreadable script");
  }
}

function cleanText(value, limit) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function corsHeaders(origin, allowedOrigin) {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!origin || (!local && origin !== allowedOrigin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Workspace-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function readableJson2VideoError(data, status) {
  if (status === 400 && /api key/i.test(String(data?.message || ""))) return "JSON2Video rejected the API key";
  if (status === 401) return "JSON2Video credits or plan limits were reached";
  if (status === 429) return "JSON2Video is receiving too many requests";
  return data?.message || data?.error || `JSON2Video request failed (${status})`;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}
