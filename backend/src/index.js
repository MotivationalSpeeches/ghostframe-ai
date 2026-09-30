const RUNWAY_API = "https://api.dev.runwayml.com";
const RUNWAY_VERSION = "2024-11-06";
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
        provider: "runway",
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
      if (!env.RUNWAY_API_KEY) return json({ error: "Runway is not configured on the server" }, 503, cors);
      return generateVideo(request, env, cors);
    }

    const statusMatch = url.pathname.match(/^\/api\/videos\/([A-Za-z0-9-]{8,})\/status$/);
    if (request.method === "GET" && statusMatch) {
      if (!env.RUNWAY_API_KEY) return json({ error: "Runway is not configured on the server" }, 503, cors);
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

  const promptText = String(body.promptText || "").trim();
  const requestedDuration = Number(body.duration || 5);
  const duration = Math.min(10, Math.max(2, Math.round(requestedDuration)));
  if (promptText.length < 8 || promptText.length > 1000) {
    return json({ error: "Prompt must be between 8 and 1000 characters" }, 400, cors);
  }

  const response = await fetch(`${RUNWAY_API}/v1/text_to_video`, {
    method: "POST",
    headers: runwayHeaders(env.RUNWAY_API_KEY),
    body: JSON.stringify({ model: "gen4.5", promptText, ratio: "720:1280", duration })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return json({ error: readableRunwayError(data, response.status) }, response.status, cors);
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
    failureCode: data.failureCode || null,
    failure: data.failure || data.failureReason || null
  }, 200, cors);
}

function runwayHeaders(secret, includeJson = true) {
  const headers = { Authorization: `Bearer ${secret}`, "X-Runway-Version": RUNWAY_VERSION };
  if (includeJson) headers["Content-Type"] = "application/json";
  return headers;
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
