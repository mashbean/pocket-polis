# Pocket Polis

**A pocket tool for deliberation, anytime — a lightweight [Polis](https://compdemocracy.org/polis/), designed and built by AI agents, running a complete wikisurvey round on a single Cloudflare Worker. No server to maintain.**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mashbean/pocket-polis)

Live site: **<https://polis.mashbean.net/en>** · Demo: [a simulated defense-budget referendum](https://polis.mashbean.net/r/qx7fc5m3ql?lang=en) with 113 fictional legislators ([how it was made](docs/demo-legislature-sim.md))

正體中文說明：[README.zh-TW.md](README.zh-TW.md) ·（Pocket Polis 的中文名稱是「口袋審議」——讓你可以隨時發起審議的口袋工具）

## What it does

- **Start a conversation**: set a topic and seed statements, get three links (participate / live report / host controls)
- **Participate**: anonymous voting (agree / disagree / pass), submit new statements, low-vote statements get shown first
- **Moderate**: approve or reject statements, open/close the conversation
- **Math, live**: mean imputation → PCA (power iteration, sparsity-aware projection) → k-means (silhouette picks 2–5 groups, with k-smoothing so groups stay stable between refreshes) → representative statements per group (repness + proportion tests) → group-aware consensus — computed inside the Worker
- **Report & AI Sensemaking**: live opinion map with group outlines, "you are here", thematic issue directory, cross-group common ground & deliberation tension insights with citations, a Community Notes-style bridging rank (statements still agreed with after the opinion axis is factored out) (via native Workers AI `@cf/google/gemma-4-26b-a4b-it`), per-group representative statements, consensus list, anonymized CSV export (including a pol.is-compatible `comments.csv` that drops straight into [Sensemaker](https://make.vtaiwan.tw/))
- **Bilingual**: full zh-Hant / English UI (`?lang=`, auto-detected)

## Architecture

```text
Browser (vanilla ES modules — no framework, no build step)
   │
Cloudflare Worker (routing, validation, security headers, Workers Cache, static assets)
   │
Durable Object "Conversation" (one per conversation)
   ├─ built-in SQLite: statements / votes / participants / synthesis cache
   ├─ math pipeline (src/math/*): recomputed on change, cached
   └─ AI queue consumer: Workers AI (@cf/google/gemma-4-26b-a4b-it) via Cloudflare Queues
```

Self-hosted single-conversation deployments run entirely within Cloudflare Workers Free allocations: 100k requests/day, 10k Workers AI neurons/day, 10k Queues operations/day, and 5 GB storage. Durable Object SQLite is the only database; the MCP packages are bundled into the Worker, with no additional service or paid external dependency to operate. Deliberation synthesis is budgeted for 1 complete AI generation per active conversation per rolling 24h window (with unchanged data cached indefinitely; non-retryable model/quota failures persist a deterministic fallback report for the current revision and allow a new AI attempt once data changes after the rolling 24h attempt window). Public responses are cached at the edge via an explicit Workers Cache API allowlist.

What "serverless" means here, and the alternatives considered: [docs/is-this-serverless.md](docs/is-this-serverless.md) (zh).

**Free-tier neuron contract (hard ceiling):** `@cf/google/gemma-4-26b-a4b-it` is billed `neurons = input_tokens × 9091 / 1e6 + output_tokens × 27273 / 1e6` ([Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)). Input tokens are a conservative **upper bound** `utf8_bytes(system)+utf8_bytes(user)+256` chat-template overhead — not JS `string.length`, and not an exact tokenizer count. Output uses each call's enforced `max_tokens` (discovery 2048, categorize batch 1536, synthesis 4096). Before every `ai.run` the worker obtains **both** a local per-generation ledger reservation **and** an atomic reservation on a deployment-wide UTC-day coordinator Durable Object, capped at **9,000** neurons for this Pocket Polis app (1,000 headroom below the 10,000 free neurons/day). Other Workers in the same Cloudflare account are outside this coordinator. A persisted per-conversation rolling-24h claim is written in the conversation Durable Object before the first model call, so Queue retries and settings edits cannot double-spend. Single-conversation self-hosted deployments stay within one conversation's 9,000/24h plus the app-wide UTC-day cap. A synthesis-phase hold is taken first so optional categorize retries cannot starve the final phase. Prompts are UTF-8 byte-capped (discovery 240,000, categorize batch 32,000, synthesis 48,000); every statement ID is kept. Consensus and tension evidence are ranked then capped at 24 each. If a generation cannot enter or complete inside the ledger, the worker returns a cacheable deterministic statistical summary (`generationMode: "deterministic"`, `model: "deterministic"`) and never labels it Gemma. **Queues are durability and latency isolation, not neuron savings.** One `<64KB` message with `max_retries: 1` is at most **4 Queue operations** (1 write + 2 reads + 1 delete; success path 3), metered separately from neurons.
## Quick start

```bash
npm install
npm run dev        # local dev (wrangler dev)
npm run check      # tsc + vitest + wrangler deploy --dry-run
npm run deploy     # deploy to your Cloudflare account
```

Or click **Deploy to Cloudflare** above. For a custom domain, edit `env.production.routes` in `wrangler.jsonc` and run `npm run deploy:production`.

## MCP

Every deployment exposes a stateless Streamable HTTP MCP endpoint at `https://your-host/mcp`.
It can list all indexed or currently active conversations, read complete public results,
create and participate in conversations, export data, and perform host operations. It also
provides conversation resources and a neutral-analysis prompt.

Public enumeration includes only `openData=true` conversations. Private enumeration and
global administration require `MCP_ADMIN_TOKEN`; per-conversation admin tokens continue to
work for that conversation. See [docs/mcp.md](docs/mcp.md) for all tools, authorization,
legacy registry backfill, and MCP Inspector testing.

### Let an AI agent deploy it for you

Paste this to Claude Code / Cursor / any coding agent (you only complete the `wrangler login` browser step yourself):

> Follow https://github.com/mashbean/pocket-polis/blob/main/AGENT.md to deploy Pocket Polis to my Cloudflare account (I will complete the wrangler login step myself), then create my first conversation via the API.

The full agent manual is [AGENT.md](AGENT.md). Claude Code users can install the skill:

```bash
npx --yes github:mashbean/pocket-polis install-skill
```

## Algorithm fidelity

The mathematical Polis pipeline (PCA, k-means clustering, consensus detection, and representativeness) is a clean-room reimplementation from the published Polis literature ([compdemocracy.org/algorithms](https://compdemocracy.org/algorithms/), Small et al. 2021); no code from the AGPL upstream is used. The native sensemaking pipeline draws design concepts from [g0v/sensemaker-frontend](https://github.com/g0v/sensemaker-frontend/tree/6303d8), [bestian/sensemaker-backend](https://github.com/bestian/sensemaker-backend/tree/164a71), and [bestian/sensemaking-tools](https://github.com/bestian/sensemaking-tools/tree/b5fb897b13c3f25aaffb8fb0d453b4defde1962a), re-architected for serverless execution. Validated against the official Polis open datasets (CC BY 4.0) — see [docs/validation-opendata.md](docs/validation-opendata.md): on vTaiwan UberX, Brexit, and Bowling Green the group count matches the official runs exactly, with Adjusted Rand Index 0.78–0.86 and purity 0.94–0.96; the largest dataset (225k votes, 607 statements, 2,010 participants) computes in 236 ms. Known deviations: [docs/algorithm.md](docs/algorithm.md).

## License and naming

- **Code: MIT** ([LICENSE](LICENSE)). The official polis codebase is AGPL-3.0; this project uses none of it — the algorithms were reimplemented from published papers and documentation, which copyright does not restrict. AGPL obligations attach to code, not to ideas, so MIT here is compatible with the upstream's rules.
- **"Polis"** in the name describes the methodology (as in polislite, LitePolis, PolisOrbis, Polis Japan). Pocket Polis is **not affiliated** with The Computational Democracy Project or pol.is.

## Community

- [Code of Conduct](CODE_OF_CONDUCT.md) — including the demo site's takedown rules
- Issues and PRs welcome: <https://github.com/mashbean/pocket-polis/issues>

## Honest limitations

- **Weak sybil resistance**: participant identity is a random UUID in localStorage. Fine for communities, classrooms, and workshops with basic trust; not for adversarial public consultations — use official pol.is there.
- **Scale**: math recomputes synchronously inside a single Durable Object; designed for hundreds to low thousands of participants and hundreds of statements.

Created and maintained by [mashbean](https://github.com/mashbean).
