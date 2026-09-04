import type { Conversation, ConversationSettings } from "./conversation";
import type { VoteValue } from "./math/types";
import { createMcpHandler } from "agents/mcp/server";
import { invalidateConversationPublicCache } from "./cache";
import { createPocketPolisMcpServer, isGlobalMcpAdmin } from "./mcp";
import {
  createConversationFromInput,
  directoryCacheKeySuffix,
  listPublicConversations,
  parseDirectoryQuery,
  randomId,
  sha256Hex,
} from "./service";

export { Conversation } from "./conversation";
export { NeuronCoordinator } from "./neuron-coordinator";

const CONVERSATION_ID_PATTERN = /^[a-z0-9]{10}$/;
const PID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 16 * 1024;

export interface SensemakingQueueMessage {
  conversationId: string;
  sourceRevision: number;
  jobId: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetchWithCache(request, env, ctx);
  },

  async queue(
    batch: MessageBatch<SensemakingQueueMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const { conversationId, sourceRevision, jobId } = msg.body;
        if (!conversationId || !jobId) {
          msg.ack();
          continue;
        }
        const stub = env.CONVERSATION.getByName(`conv:${conversationId}`);
        const result = await stub.processSensemakingJob(sourceRevision, jobId, Date.now());
        if (result.ok) {
          msg.ack();
        } else if (result.retryable) {
          msg.retry();
        } else {
          // 非 retryable（如模型失敗、配額上限）：已持久化當前 revision 之確定性 fallback 結果，直接 ack 避免無效消耗佇列與神經元
          msg.ack();
        }
      } catch (error) {
        console.error("queue worker error:", error);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, SensemakingQueueMessage>;

// ---- Workers Cache Wrapper ----

async function handleFetchWithCache(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const method = request.method;
  const isGet = method === "GET";
  const url = new URL(request.url);

  // 嚴格白名單與排除清單：
  // 1. 僅允許公開 GET 請求
  // 2. 排除含有 Authorization 標頭
  // 3. 排除含有 pid 個性化識別參數
  // 4. 僅允許明確定義之公開頁面與 GET API 端點
  const hasAuth = request.headers.has("Authorization");
  const hasPid = url.searchParams.has("pid");
  const reqCc = (request.headers.get("Cache-Control") || "").toLowerCase();
  const hasBypassHeader =
    reqCc.includes("no-cache") || reqCc.includes("no-store") || reqCc.includes("max-age=0");
  const cacheKeyUrl =
    isGet && !hasAuth && !hasPid && !hasBypassHeader ? publicCacheKeyUrl(url) : null;
  const isCacheableCandidate = cacheKeyUrl !== null;

  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;

  // 正則化快取鍵值：多數公開路徑不依賴 query 參數，直接丟掉查詢字串；
  // 議題列表依賴 status/q/limit/cursor，改用正規化後的白名單參數，防止邊緣快取分裂。
  const cacheKey = new Request(cacheKeyUrl ?? url.origin + url.pathname, { method: "GET" });

  if (isCacheableCandidate && cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return cached;
      }
    } catch {
      // 忽略快取讀取異常
    }
  }

  const response = await handleRequest(request, env, ctx, url);

  // 只快取 200 成功回應，且排除含 no-store、private、Set-Cookie 或 Vary:* 之回應
  if (isCacheableCandidate && cache && response.status === 200) {
    const cc = (response.headers.get("Cache-Control") || "").toLowerCase();
    const hasSetCookie = response.headers.has("Set-Cookie");
    const vary = (response.headers.get("Vary") || "").toLowerCase();

    if (
      !cc.includes("no-store") &&
      !cc.includes("private") &&
      !hasSetCookie &&
      vary !== "*"
    ) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
    }
  }

  return response;
}

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  try {
    if (url.pathname === "/mcp") {
      const globalAdmin = isGlobalMcpAdmin(request, env);
      return createMcpHandler(
        () => createPocketPolisMcpServer(env, { globalAdmin, origin: url.origin }),
        { route: "/mcp", legacy: "stateless" },
      )(request, env, ctx);
    }

    if (!url.pathname.startsWith("/api/")) {
      return servePage(request, env, url);
    }

    if (url.pathname === "/api/health") {
      return json(
        { ok: true, storage: "durable-object-sqlite", math: "in-worker", queue: "enabled" },
        200,
        { "Cache-Control": "public, max-age=10, s-maxage=10" },
      );
    }

    if (url.pathname === "/api/conversations") {
      if (request.method === "GET") return listConversationDirectory(url, env);
      if (request.method !== "POST") return jsonError("method not allowed", 405);
      return createConversation(request, env);
    }

    const match = url.pathname.match(/^\/api\/conversations\/([a-z0-9]{10})(\/.*)?$/);
    if (!match) return jsonError("not found", 404);
    const conversationId = match[1]!;
    const subPath = match[2] ?? "/";
    const stub = env.CONVERSATION.getByName(`conv:${conversationId}`);
    if (!(await stub.isConversation())) return jsonError("conversation not found", 404);
    return handleConversationApi(request, url, env, ctx, stub, subPath, conversationId);
  } catch (error) {
    console.error("unhandled", error instanceof Error ? error.stack : error);
    // 免費額度觸頂（每日 00:00 UTC 重置）：給人話，不要 internal error
    const message = error instanceof Error ? error.message : "";
    if (message.includes("Exceeded allowed") && message.includes("free tier")) {
      return jsonError(
        "這個站今天的免費額度用完了，台北時間早上 8 點會自動恢復。The site hit today's free-tier quota; it resets at 00:00 UTC.",
        503,
      );
    }
    return jsonError("internal error", 500);
  }
}

// ---- pages ----

// 注意：assets binding 預設 html_handling=auto-trailing-slash，
// 直接要 /participate.html 會被 307 轉址；用無副檔名路徑取資產。
const PAGE_REWRITES: [RegExp, string][] = [
  [/^\/c\/[a-z0-9]{10}$/, "/participate"],
  [/^\/r\/[a-z0-9]{10}$/, "/report"],
  [/^\/a\/[a-z0-9]{10}$/, "/admin"],
  [/^\/en$/, "/en"],
  [/^\/explore$/, "/explore"],
  [/^\/guide$/, "/guide"],
  [/^\/en\/guide$/, "/guide-en"],
];

async function servePage(request: Request, env: Env, url: URL): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response("method not allowed", { status: 405 });
  }
  let assetPath: string | null = null;
  if (url.pathname === "/") {
    assetPath = "/";
  } else {
    for (const [pattern, target] of PAGE_REWRITES) {
      if (pattern.test(url.pathname)) {
        assetPath = target;
        break;
      }
    }
  }
  if (!assetPath) return new Response("not found", { status: 404 });
  const assetUrl = new URL(assetPath, url.origin);
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
  return rewritePageMeta(withSecurityHeaders(response), env, url);
}

const setMetaContent = (value: string) => ({
  element(el: Element) {
    el.setAttribute("content", value);
  },
});

/**
 * 分享預覽：og:image / og:url 跟著部署網域走（自架站不會指到官方站）；
 * 討論頁（/c/、/r/）另外把該場討論的標題與說明寫進 <title> 與 og 標籤，
 * 讓分享出去的連結有正確的預覽文字。
 */
async function rewritePageMeta(response: Response, env: Env, url: URL): Promise<Response> {
  if (typeof HTMLRewriter === "undefined") {
    return response;
  }
  const rewriter = new HTMLRewriter()
    .on('meta[property="og:image"]', setMetaContent(`${url.origin}/og-image.png`))
    .on('meta[property="og:url"]', setMetaContent(url.origin + url.pathname));

  const conversationPage = url.pathname.match(/^\/(c|r)\/([a-z0-9]{10})$/);
  if (conversationPage) {
    try {
      const stub = env.CONVERSATION.getByName(`conv:${conversationPage[2]}`);
      const info = await stub.publicInfo();
      if (info) {
        const title = `${info.title} — Pocket Polis`;
        const description = (info.description || "").trim().slice(0, 160) || title;
        rewriter
          .on("title", {
            element(el) {
              el.setInnerContent(title);
            },
          })
          .on('meta[property="og:title"]', setMetaContent(title))
          .on('meta[property="og:description"]', setMetaContent(description))
          .on('meta[name="description"]', setMetaContent(description));
      }
    } catch {
      // 討論不存在或暫時讀不到：保留頁面的靜態預設
    }
  }
  return rewriter.transform(response);
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "public, max-age=10, s-maxage=10");
  return new Response(response.body, { status: response.status, headers });
}

// ---- conversation lifecycle ----

async function createConversation(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const result = await createConversationFromInput(env, body);
  return result.ok
    ? json(result.value, 201, { "Cache-Control": "no-store" })
    : jsonError(result.error, result.status);
}

/**
 * 公開議題列表。只有建立者勾選「公開資料」的討論會出現，依行為準則下架者一律排除。
 * 60 秒邊緣快取：內容本來就是每 5 分鐘才回寫一次的快照，不需要更即時。
 */
async function listConversationDirectory(url: URL, env: Env): Promise<Response> {
  const query = parseDirectoryQuery(url.searchParams);
  const page = await listPublicConversations(env, query);
  return json(page, 200, { "Cache-Control": "public, max-age=60, s-maxage=60" });
}

// ---- per-conversation API ----

async function handleConversationApi(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  stub: DurableObjectStub<Conversation>,
  subPath: string,
  conversationId: string,
): Promise<Response> {
  const now = Date.now();

  if (subPath === "/" && request.method === "GET") {
    return json(await stub.publicInfo(), 200, {
      "Cache-Control": "public, max-age=10, s-maxage=10",
    });
  }

  if (subPath === "/next" && request.method === "GET") {
    const pid = requirePid(url.searchParams.get("pid"));
    if (!pid) return jsonError("valid pid query param required", 400);
    return json(await stub.nextStatement(pid, now), 200, {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
  }

  if (subPath === "/votes" && request.method === "POST") {
    const body = await readJson(request);
    if (!isRecord(body)) return jsonError("invalid body", 400);
    const pid = requirePid(body.pid);
    if (!pid) return jsonError("valid pid required", 400);
    const sid = Number(body.sid);
    if (!Number.isInteger(sid) || sid <= 0) return jsonError("valid sid required", 400);
    if (body.value !== 1 && body.value !== -1 && body.value !== 0) {
      return jsonError("value must be 1 (agree), -1 (disagree) or 0 (pass)", 400);
    }
    const result = await stub.castVote(pid, sid, body.value as VoteValue, now);
    return result.ok
      ? json(result, 200, { "Cache-Control": "no-store" })
      : jsonError(result.error, 400);
  }

  if (subPath === "/statements" && request.method === "POST") {
    const body = await readJson(request);
    if (!isRecord(body)) return jsonError("invalid body", 400);
    const pid = requirePid(body.pid);
    if (!pid) return jsonError("valid pid required", 400);
    if (typeof body.text !== "string") return jsonError("text required", 400);
    const result = await stub.submitStatement(pid, body.text, now);
    return result.ok
      ? json(result, 200, { "Cache-Control": "no-store" })
      : jsonError(result.error, 400);
  }

  if (subPath === "/statements-public" && request.method === "GET") {
    return json(await stub.publicStatements(), 200, {
      "Cache-Control": "public, max-age=30, s-maxage=30",
    });
  }

  if (subPath === "/results" && request.method === "GET") {
    const pidParam = url.searchParams.get("pid");
    const pid = pidParam ? requirePid(pidParam) : null;
    const results = await stub.getResults(pid, now);
    if (!results) return jsonError("not found", 404);

    // 有 pid（個人化坐標）一律 no-store；匿名統計則給予 15s 快取
    const cacheControl = pid
      ? "no-store, no-cache, must-revalidate"
      : "public, max-age=15, s-maxage=15";
    return json(results, 200, { "Cache-Control": cacheControl });
  }

  if (subPath === "/synthesis" && request.method === "GET") {
    const checkResult = await stub.checkOrStartSynthesis(conversationId, now);

    // 若需要非同步生成且佇列已配置，await 確保傳輸成功，失敗則立即回復 pending 狀態
    if (checkResult.needsEnqueue) {
      if (!env.SENSEMAKING_QUEUE) {
        console.error("SENSEMAKING_QUEUE binding is not configured");
        await stub.markSensemakingEnqueueFailed(
          checkResult.needsEnqueue.jobId,
          now,
          "AI synthesis is temporarily unavailable.",
        );
        const fallback = await stub.checkOrStartSynthesis(conversationId, now);
        return json(fallback.response, 200, {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
      }
      try {
        await env.SENSEMAKING_QUEUE.send(checkResult.needsEnqueue);
      } catch (enqueueError) {
        console.error("Queue enqueue error:", enqueueError);
        await stub.markSensemakingEnqueueFailed(
          checkResult.needsEnqueue.jobId,
          now,
          "AI synthesis is temporarily unavailable.",
        );
        const fallback = await stub.checkOrStartSynthesis(conversationId, now);
        return json(fallback.response, 200, {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
      }
    }

    const response = checkResult.response;
    let cacheControl = "no-store, no-cache, must-revalidate";

    if (response.status === "ready") {
      const isRefreshing = "refreshPending" in response && response.refreshPending === true;
      cacheControl = isRefreshing
        ? "public, max-age=3, s-maxage=3"
        : "public, max-age=300, s-maxage=300";
    } else if (response.status === "pending") {
      cacheControl = "public, max-age=3, s-maxage=3";
    } else if (response.status === "insufficient") {
      cacheControl = "public, max-age=60, s-maxage=60";
    }

    return json(response, 200, { "Cache-Control": cacheControl });
  }

  // pol.is 相容的 comments.csv（Sensemaker 等工具可直接讀取）
  if (subPath === "/export/comments.csv" && request.method === "GET") {
    const csv = await stub.exportCommentsCsv(bearerToken(request, url));
    if (csv === null) return jsonError("unauthorized (data export is not public for this conversation)", 403);
    return csvResponse(csv, "comments.csv");
  }

  if (subPath === "/export/statements.csv" && request.method === "GET") {
    const csv = await stub.exportStatementsCsv(bearerToken(request, url));
    if (csv === null) return jsonError("unauthorized (data export is not public for this conversation)", 403);
    return csvResponse(csv, "statements.csv");
  }

  if (subPath === "/export/votes.csv" && request.method === "GET") {
    const csv = await stub.exportVotesCsv(bearerToken(request, url));
    if (csv === null) return jsonError("unauthorized (data export is not public for this conversation)", 403);
    return csvResponse(csv, "votes.csv");
  }

  // ---- admin ----

  if (subPath === "/admin" && request.method === "GET") {
    const token = bearerToken(request, url);
    if (!token) return jsonError("unauthorized", 401);
    const overview = await stub.adminOverview(token);
    if ("error" in overview) return jsonError(overview.error, 401);
    return json(overview, 200, { "Cache-Control": "no-store, no-cache, must-revalidate" });
  }

  const moderate = subPath.match(/^\/admin\/statements\/(\d+)$/);
  if (moderate && request.method === "POST") {
    const token = bearerToken(request, url);
    if (!token) return jsonError("unauthorized", 401);
    const body = await readJson(request);
    if (!isRecord(body) || (body.action !== "approve" && body.action !== "reject")) {
      return jsonError("action must be approve or reject", 400);
    }
    const result = await stub.moderateStatement(token, Number(moderate[1]), body.action);
    if (result.ok) {
      // 審核變更會使舊綜整引用已被撤銷的陈述；除了 DO 內已清除 synthesis 外，
      // 亦需清除 Workers Cache 中殘留的 /synthesis（300s）與關聯公開資料，避免 stale 持續公開
      await invalidateConversationPublicCache(url.origin, conversationId);
    }
    return result.ok
      ? json(result, 200, { "Cache-Control": "no-store" })
      : jsonError(result.error, result.error === "unauthorized" ? 401 : 400);
  }

  if (subPath === "/admin/statements" && request.method === "POST") {
    const token = bearerToken(request, url);
    if (!token) return jsonError("unauthorized", 401);
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.text !== "string") return jsonError("text required", 400);
    const result = await stub.addSeedStatement(token, body.text, now);
    if (result.ok) {
      await invalidateConversationPublicCache(url.origin, conversationId);
    }
    return result.ok
      ? json(result, 200, { "Cache-Control": "no-store" })
      : jsonError(result.error, result.error === "unauthorized" ? 401 : 400);
  }

  if (subPath === "/admin/settings" && request.method === "POST") {
    const token = bearerToken(request, url);
    if (!token) return jsonError("unauthorized", 401);
    const body = await readJson(request);
    if (!isRecord(body)) return jsonError("invalid body", 400);
    const result = await stub.updateSettings(token, body as Partial<ConversationSettings>);
    return result.ok
      ? json(result, 200, { "Cache-Control": "no-store" })
      : jsonError(result.error, result.error === "unauthorized" ? 401 : 400);
  }

  return jsonError("not found", 404);
}

// ---- helpers ----

function requirePid(value: unknown): string | null {
  return typeof value === "string" && PID_PATTERN.test(value) ? value : null;
}

function bearerToken(request: Request, url: URL): string | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || null;
  // CSV 下載連結無法帶 header，允許 query token（admin 頁自己的分頁內使用）
  const q = url.searchParams.get("token");
  return q && /^[0-9a-f]{32}$/.test(q) ? q : null;
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function jsonError(message: string, status: number): Response {
  return json({ error: message }, status, {
    "Cache-Control": "no-store, no-cache, must-revalidate",
  });
}

function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}


/** 可快取的公開請求回傳其正規化快取鍵值網址；不可快取則回傳 null。 */
function publicCacheKeyUrl(url: URL): string | null {
  const pathname = url.pathname;
  // 議題列表是唯一依賴 query 的可快取端點：只保留白名單參數，並固定順序
  if (pathname === "/api/conversations") {
    return `${url.origin}${pathname}?${directoryCacheKeySuffix(parseDirectoryQuery(url.searchParams))}`;
  }
  if (
    pathname === "/" ||
    pathname === "/en" ||
    pathname === "/explore" ||
    pathname === "/guide" ||
    pathname === "/en/guide"
  ) {
    return url.origin + pathname;
  }
  if (/^\/(c|r)\/[a-z0-9]{10}$/.test(pathname)) {
    return url.origin + pathname;
  }
  if (pathname === "/api/health") {
    return url.origin + pathname;
  }
  if (/^\/api\/conversations\/[a-z0-9]{10}(\/(statements-public|results|synthesis))?$/.test(pathname)) {
    return url.origin + pathname;
  }
  return null;
}
export const _internal = { randomId, sha256Hex };
