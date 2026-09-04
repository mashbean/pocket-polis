# Pocket Polis MCP

Pocket Polis exposes a remote MCP server at `/mcp` on the same Worker as the web UI and
REST API. It uses the current Cloudflare-recommended stateless Streamable HTTP handler,
serves MCP 2026-07-28, and retains stateless compatibility for published 2025 clients.

```text
https://polis.example.com/mcp
http://localhost:8787/mcp
```

The endpoint is not a web page. Connect with an MCP client or the MCP Inspector.

## Tools

| Tool | Purpose | Access |
|---|---|---|
| `list_conversations` | List indexed discussions with live counts; filter status/search and paginate | `public` scope lists openData; `all` needs global token |
| `list_active_conversations` | List discussions whose current status is `open` | Same as above |
| `get_conversation` | Metadata, approved statements, live groups, representative statements and consensus | Public by exact ID |
| `get_conversation_results` | Opinion map/results, optionally including one participant's location | Public by exact ID |
| `create_conversation` | Create a discussion and return participate/report/admin links | Public, site rate limit applies |
| `get_next_statement` | Get the next low-vote-priority statement for a participant UUID | Public participation |
| `cast_vote` | Agree (`1`), disagree (`-1`) or pass (`0`) | Public participation |
| `submit_statement` | Submit a statement under the discussion's moderation policy | Public participation |
| `export_conversation_data` | Export `comments.csv`, `statements.csv` or anonymous `votes.csv` | OpenData, per-discussion admin, or global token |
| `get_admin_overview` | Settings and all moderation states | Per-discussion admin or global token |
| `moderate_statement` | Approve or reject a submitted statement | Per-discussion admin or global token |
| `add_seed_statement` | Add an approved host statement | Per-discussion admin or global token |
| `update_conversation_settings` | Change title, moderation, openData, status and alternate URL | Per-discussion admin or global token |
| `register_conversation` | Add a known legacy 10-character conversation ID to enumeration | Global token |
| `set_conversation_listing` | Delist a conversation from the public directory under the Code of Conduct, or restore it | Global token |
| `backfill_conversation_registry` | Inspect Cloudflare Durable Object hash IDs and register conversations | Global token |

Tool results are returned as both readable text and `structuredContent` when appropriate.
Mutating tools carry MCP read-only/destructive/idempotent annotations.

## Resources and prompt

- `pocket-polis://indexes/active` — all ongoing public/openData discussions.
- `pocket-polis://conversations/{conversationId}` — complete public discussion detail.
- `analyze_deliberation` prompt — loads the live discussion and requests a neutral group,
  consensus, disagreement, and sample-limit synthesis in Traditional Chinese or English.

Dynamic resource enumeration deliberately contains only openData discussions. An exact
discussion resource mirrors information already available through its public report URL.

## Authorization and privacy boundary

MCP remains usable without authentication for the same public actions as the existing site.
It does **not** make private exports public:

- `scope=public` enumeration includes only discussions where `openData=true`.
- `scope=all`, global moderation, and registry backfill require the optional Worker secret
  `MCP_ADMIN_TOKEN` as an HTTP bearer token.
- A discussion's one-time admin token can authorize management and non-public exports for
  that discussion only.
- MCP resources never expose private exports or admin data.

Configure global MCP access without committing the secret:

```bash
npx wrangler secret put MCP_ADMIN_TOKEN
```

For local development only, put this in the gitignored `.dev.vars` file:

```dotenv
MCP_ADMIN_TOKEN=replace-with-a-long-random-local-secret
```

Then configure the MCP client to send:

```text
Authorization: Bearer replace-with-a-long-random-local-secret
```

This is an optional service-token boundary, not an OAuth authorization server. For a
multi-user deployment, place `/mcp` behind Cloudflare Access/OAuth and map user scopes before
granting global operations.

## Conversation registry and legacy data

Durable Object namespaces do not expose a name-based enumeration API inside a Worker, so
Pocket Polis maintains a SQLite `conversation_registry` in a singleton Durable Object.

- New discussions register during creation.
- A discussion created before this feature registers the first time its public ID is accessed.
- The two official demo IDs are probed and registered on the first list operation.
- A known old discussion can be added with `register_conversation`.
- Each discussion refreshes its registry snapshot at most once every 5 minutes while it is
  being used, and immediately whenever its settings change — so withdrawing `openData`
  removes it from the public directory right away.

### Code of Conduct takedowns

`set_conversation_listing` marks a registry row as delisted. Delisted rows disappear from the
public directory (`GET /api/conversations` and `/explore`) and from public MCP enumeration,
but the conversation, its links and its data are untouched — re-registration does not undo a
delisting. Global-token enumeration (`scope=all`) still returns delisted rows, flagged with
`delisted` and `delistedReason`. To stop participation as well, close the conversation with
`update_conversation_settings`.

To guarantee immediate enumeration of every pre-registry Durable Object, use Cloudflare's
Durable Objects Namespace Objects API to obtain its hash IDs, then pass batches of at most
100 IDs to `backfill_conversation_registry`. Non-conversation objects such as the creation
limiter are safely skipped. This one-time operation requires global MCP authorization.

The included migration CLI performs both steps without sending the Cloudflare API token to
the Worker:

```bash
CLOUDFLARE_API_TOKEN=... MCP_ADMIN_TOKEN=... npm run mcp:backfill -- \
  --base-url https://polis.example.com \
  --account-id YOUR_CLOUDFLARE_ACCOUNT_ID
```

If the account has multiple `Conversation` namespaces, add `--namespace-id`. The Cloudflare
token needs Workers Scripts Read permission; the script never prints either token.

## Local testing

```bash
# Terminal 1
npm run dev

# Terminal 2
npx @modelcontextprotocol/inspector@latest
```

In Inspector, connect with Streamable HTTP to `http://localhost:8787/mcp`, then verify Tools,
Resources, and Prompts. The repository's automated contract tests also check the complete tool
surface, registry migration, token comparison, and Worker route.
