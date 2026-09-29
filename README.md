# GhostFrame

A polished, GitHub Pages-ready dashboard for creating and scheduling AI faceless videos for TikTok and YouTube Shorts.

## What works now

- Responsive creator studio with topic, niche, tone, length, visual style, voice, and caption controls
- Animated vertical-video preview
- Local demo generation plus a secure Runway Gen-4.5 integration
- Persistent publishing queue with Runway task tracking
- TikTok and YouTube connection screens
- GitHub Pages deployment workflow
- WebMCP tool for creating drafts from supported AI agents

The site runs in **demo mode** until `config.js` points to the included backend. It intentionally does not place API secrets or social-media refresh tokens in browser code.

## Publish on GitHub Pages

1. Create a new GitHub repository and upload this folder.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **GitHub Actions**.
4. Push to the `main` branch. The included workflow publishes the site.

## Turn on Runway video generation

The included `backend/` folder is a Cloudflare Worker that starts portrait Gen-4.5 text-to-video tasks and safely polls their status.

```bash
cd backend
npm install
npx wrangler secret put RUNWAYML_API_SECRET
npm run deploy
```

Before deploying, replace `YOUR_GITHUB_USERNAME` in `backend/wrangler.toml`. Then copy the deployed Worker URL into `config.js` as `apiBaseUrl`.

Never paste the key into `config.js`, `app.js`, `wrangler.toml`, or any committed file. Runway's official environment-variable name is:

```text
RUNWAYML_API_SECRET
```

## Turn on TikTok and YouTube posting

Runway generation works independently. Direct social posting still requires a private OAuth integration with these routes:

```text
GET  /auth/tiktok
GET  /auth/youtube
POST /api/videos/publish
```

Those integrations require separate credentials stored only on the backend:

```text
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
TOKEN_ENCRYPTION_KEY
```

For production, use TikTok's Content Posting API and YouTube Data API `videos.insert`. Both platforms require OAuth authorization, and public posting can require app review or API-project verification. The included backend returns a clear setup message until these credentials and routes are added.

## Local preview

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`.

## Important

- Never commit `.env` files, API keys, OAuth secrets, or refresh tokens.
- Require a final human confirmation before publishing a generated video.
- Follow TikTok and YouTube disclosure rules for synthetic media.
- Use only media, music, voices, and footage you have rights to publish.

## License

MIT
