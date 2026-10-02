# GhostFrame

A polished, GitHub Pages-ready dashboard for creating and scheduling AI faceless videos for TikTok and YouTube Shorts.

## What works now

- Responsive creator studio with topic, niche, tone, length, visual style, voice, and caption controls
- Animated vertical-video preview
- CompactifAI script, hook, and scene generation through a secure Cloudflare Worker
- JSON2Video vertical MP4 rendering with voice-over and automatic subtitles
- Persistent publishing queue with render progress tracking
- Playable video review on the Publishing page before posting
- TikTok and YouTube connection screens
- GitHub Pages deployment workflow
- WebMCP tool for creating drafts from supported AI agents

The site runs in **demo mode** until `config.js` points to the included backend. It intentionally does not place API secrets or social-media refresh tokens in browser code.

## Publish on GitHub Pages

1. Create a new GitHub repository and upload this folder.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **GitHub Actions**.
4. Push to the `main` branch. The included workflow publishes the site.

## Turn on AI video generation

The included `backend/` folder uses CompactifAI to write the script and JSON2Video to render a 1080 × 1920 MP4 with scene text, narration, and captions. Provider keys stay in Cloudflare.

```bash
cd backend
npm install
npx wrangler secret put COMPACTIFAI_API_KEY
npx wrangler secret put JSON2VIDEO_API_KEY
npm run deploy
```

Before deploying, replace `YOUR_GITHUB_USERNAME` in `backend/wrangler.toml`. Then copy the deployed Worker URL into `config.js` as `apiBaseUrl`.

Never paste either key into `config.js`, `app.js`, `wrangler.toml`, or any committed file. The required Cloudflare secret names are:

```text
COMPACTIFAI_API_KEY
JSON2VIDEO_API_KEY
```

## Turn on TikTok and YouTube posting

The Worker includes secure OAuth authorization routes for both platforms. Authorization tokens are encrypted and stored in a per-workspace Cloudflare Durable Object.

```text
POST /api/oauth/tiktok/start
GET  /auth/tiktok/callback
POST /api/oauth/youtube/start
GET  /auth/youtube/callback
GET  /api/oauth/status
```

Add these values as encrypted Cloudflare Worker secrets, never as GitHub files:

```text
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
TOKEN_ENCRYPTION_KEY
```

Register these exact callback URLs in the developer consoles:

```text
https://ghostframe-ai.nonamedemonade12.workers.dev/auth/tiktok/callback
https://ghostframe-ai.nonamedemonade12.workers.dev/auth/youtube/callback
```

TikTok needs Login Kit and Content Posting API with the `video.publish` scope. YouTube needs the YouTube Data API and the `youtube.upload` OAuth scope. TikTok direct posting requires an audit for public visibility, and Google may require OAuth-app verification before external users can authorize uploads.

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
