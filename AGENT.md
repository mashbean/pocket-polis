# AGENT.md — operating manual for AI agents

You are a coding agent. The user wants "their own Polis". This document lets you do everything for them while the user does exactly **one** thing: log into their own Cloudflare account in the browser.

polis-serverless runs a complete Polis-style wikisurvey round (statement submission → agree/disagree/pass voting → PCA + k-means opinion clustering → representative statements & cross-group consensus) on a single Cloudflare Worker with Durable Object SQLite and Cloudflare Queues for asynchronous Workers AI sensemaking (@cf/google/gemma-4-26b-a4b-it). It operates entirely within the Cloudflare free tier (100k requests/day, 10k AI neurons/day, 10k queue operations/day, 5 GB storage). Queues isolate durability/latency; they do not save neurons. Each synthesis generation synchronously reserves worst-case Gemma-4 neurons (UTF-8 byte input upper bound + enforced max_tokens) on a 9,000-neuron ledger. There are no servers or external paid databases to maintain.
（中文使用者：人類讀的說明在 [README.md](README.md)；本檔案是給 agent 的，你的 agent 讀英文即可。）

## Deployment (the user only logs in)

```bash
git clone https://github.com/mashbean/pocket-polis.git
cd polis-serverless
npm install
npx wrangler login   # ← the ONE user step: a browser opens for Cloudflare OAuth
npm run check        # tsc + tests + dry-run; deploy only when green
npm run deploy       # prints https://polis-serverless.<subdomain>.workers.dev
```

- `npx wrangler login` opens a browser for OAuth. **The user themselves** completes the login and authorization; you only run commands and wait. Never ask the user for API tokens or passwords. In a headless environment, ask the user to create an API Token (Edit Workers permission) in the Cloudflare dashboard and export `CLOUDFLARE_API_TOKEN` themselves.
- No Cloudflare account? Send the user to <https://dash.cloudflare.com/sign-up> (free plan is enough). You cannot register on their behalf.
- Success criteria: `npm run deploy` prints a workers.dev URL and `GET <url>/api/health` returns `{"ok":true,...}`.

### Custom domain (optional)

The user's domain must already be on their Cloudflare account. Edit `env.production.routes` in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "polis.example.com", "custom_domain": true }]
```

Then `npm run deploy:production`. Cloudflare creates DNS and certificates automatically.

## Running a full round via the API

`BASE` is the deployment URL.

```bash
# 1. Create a conversation (returns a one-time adminToken — hand it to the user
#    privately; do not print it into shared logs)
curl -X POST $BASE/api/conversations -H 'Content-Type: application/json' -d '{
  "title": "…", "description": "…",
  "seedStatements": ["…", "…"],
  "autoApprove": true, "allowSubmissions": true, "openData": false
}'
# → {conversationId, adminToken, urls:{participate, report, admin}}
```

| Endpoint | Purpose |
|---|---|
| `GET /api/conversations?status=&q=&limit=&cursor=` | public directory: conversations whose creator set `openData`, minus any delisted under the Code of Conduct |
| `GET /api/conversations/:id` | public info & counts |
| `GET /api/conversations/:id/next?pid=<uuid>` | next statement for a participant to vote on |
| `POST /api/conversations/:id/votes` `{pid,sid,value:1\|-1\|0}` | cast a vote (1 = agree) |
| `POST /api/conversations/:id/statements` `{pid,text}` | submit a statement (≤280 chars) |
| `GET /api/conversations/:id/results` | clustering, representative statements, consensus (JSON) |
| `GET /api/conversations/:id/synthesis` | async AI deliberation synthesis, themes, common ground, tensions (JSON) |
| `GET /api/conversations/:id/export/{comments,votes,statements}.csv` | anonymized export (`?token=`, or public when openData). `comments.csv` has the same header as a pol.is report export, so tools like [Sensemaker](https://make.vtaiwan.tw/) read it as-is |
| `GET/POST /api/conversations/:id/admin*` | moderation & settings (`Authorization: Bearer <adminToken>`) |

- `pid` is a participant-generated UUID (the web UI stores it in localStorage). When driving multiple simulated participants, use one fixed UUID per participant.
- Share links: participate `/c/:id`, report `/r/:id`, admin `/a/:id#token=…` (the token lives in the URL fragment and never reaches server logs).
- Clustering appears once 4+ participants have each voted on min(7, statement count) statements.

## MCP

The deployment also exposes a stateless Streamable HTTP MCP server at `/mcp`, supporting
the MCP 2026-07-28 protocol and stateless 2025 clients. Prefer MCP when the host supports
remote MCP; the REST API remains the fallback and browser-facing interface.

- Public enumeration includes only `openData=true` conversations.
- Exact public conversation details remain readable by ID, matching the web report.
- Per-conversation admin tools accept that conversation's admin token.
- Private enumeration, global admin, and registry backfill require a bearer token matching
  the Worker secret `MCP_ADMIN_TOKEN`. Never print or commit it.
- Full tool/resource/prompt and registry migration instructions: [docs/mcp.md](docs/mcp.md).

## Safety and etiquette

- **Admin tokens**: hand the adminToken only to the user (or their designated secret store). Never print it into shareable output, never commit it. It cannot be recovered — only a new conversation can be created.
- **Never flood someone else's deployment**: only create conversations or seed simulated votes on the user's own deployment (or one they explicitly authorized). The public demo site polis.mashbean.net rate-limits creation (10/hour, 50/day).
- **Label simulations**: simulated samples (see `scripts/seed-demo-legislature.mjs` as a template) must state "simulated/fictional" in the title and description, and use pseudonyms only.
- Do not make the user's fork public and do not touch DNS unless explicitly asked.
- Upgrade path: `git pull && npm install && npm run check && npm run deploy` (Durable Object data lives on Cloudflare and survives redeploys).

## For humans instead

Users who don't want an agent can click the **Deploy to Cloudflare** button in the README (Cloudflare forks the repo and builds it automatically), or run the six commands above by hand.
