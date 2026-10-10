# Ludo with Friends — Vercel version

## Deploy
1. Push this folder to a GitHub repo (or run `npx vercel` inside it).
2. On vercel.com: **Add New → Project → import the repo → Deploy**.
3. Add storage (required — rooms are kept here): in your Vercel project open **Storage → Marketplace → Upstash Redis** (free plan) → create & connect it to the project.
   Vercel then adds the env vars automatically (KV_REST_API_URL / KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — both are supported).
4. **Redeploy** once so the env vars take effect.
5. Open your site, enter a 4-digit room code (1000–9999) and share it.

## Local test
`npx vercel dev` (works without Redis using in-memory storage).

Rooms expire after 6 hours. The game updates by polling once per second.

## Flow
The first person to enter a code becomes host and picks 2–6 players; the game auto-starts when that many have joined. When a game ends everyone returns to the home screen after a few seconds and the code can be reused immediately.
