import type {
  Conversation,
  ConversationRegistryEntry,
  ConversationRegistryPage,
  ConversationSettings,
} from "./conversation";

const MAX_SEED_STATEMENTS = 50;
export const REGISTRY_OBJECT_NAME = "conversation-registry";
/** 官方示範場次建站時早於 registry，第一次列舉時補登。 */
export const KNOWN_CONVERSATION_IDS = ["3ovoxq5c6o", "qx7fc5m3ql"];
const DIRECTORY_DEFAULT_LIMIT = 24;
const DIRECTORY_MAX_LIMIT = 50;

export interface CreatedConversation {
  conversationId: string;
  adminToken: string;
  urls: { participate: string; report: string; admin: string };
}

export type CreateConversationResult =
  | { ok: true; value: CreatedConversation }
  | { ok: false; error: string; status: number };

export async function createConversationFromInput(env: Env, input: unknown): Promise<CreateConversationResult> {
  if (!isRecord(input)) return { ok: false, error: "invalid body", status: 400 };
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
  if (!title) return { ok: false, error: "title is required", status: 400 };
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 2000) : "";
  const seedStatements = Array.isArray(input.seedStatements)
    ? input.seedStatements.filter((s): s is string => typeof s === "string").slice(0, MAX_SEED_STATEMENTS)
    : [];

  const settings: ConversationSettings = {
    title,
    description,
    autoApprove: input.autoApprove !== false,
    allowSubmissions: input.allowSubmissions !== false,
    openData: input.openData === true,
    status: "open",
  };

  const now = Date.now();
  const limiter = env.CONVERSATION.getByName("creation-limiter");
  const reservation = await limiter.reserveCreation(now);
  if (!reservation.ok) return { ok: false, error: reservation.error ?? "rate limited", status: 429 };

  const conversationId = randomId();
  const adminToken = randomToken();
  const adminTokenHash = await sha256Hex(adminToken);
  const stub = env.CONVERSATION.getByName(`conv:${conversationId}`);
  const result = await stub.initConversation(conversationId, settings, seedStatements, adminTokenHash, now);
  if (!result.ok) return { ok: false, error: result.error, status: 500 };

  return {
    ok: true,
    value: {
      conversationId,
      adminToken,
      urls: {
        participate: `/c/${conversationId}`,
        report: `/r/${conversationId}`,
        admin: `/a/${conversationId}#token=${adminToken}`,
      },
    },
  };
}

export function registryStub(env: Env): DurableObjectStub<Conversation> {
  return env.CONVERSATION.getByName(REGISTRY_OBJECT_NAME);
}

export interface DirectoryQuery {
  status: "all" | "open" | "closed";
  query: string;
  limit: number;
  cursor?: string;
}

/**
 * 公開議題列表的查詢參數。全部給預設值，壞參數一律退回預設而不是報錯——
 * 這個端點會被人手貼網址，不該因為一個 typo 就 400。
 */
export function parseDirectoryQuery(params: URLSearchParams): DirectoryQuery {
  const rawStatus = params.get("status");
  const status = rawStatus === "open" || rawStatus === "closed" ? rawStatus : "all";
  const query = (params.get("q") ?? "").trim().slice(0, 120);
  const rawLimit = Number(params.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1
    ? Math.min(DIRECTORY_MAX_LIMIT, Math.floor(rawLimit))
    : DIRECTORY_DEFAULT_LIMIT;
  const rawCursor = params.get("cursor") ?? "";
  const cursor = /^\d{1,9}$/.test(rawCursor) ? rawCursor : undefined;
  return { status, query, limit, cursor };
}

/** 正規化後的快取鍵值：同一組查詢條件共用一份邊緣快取，順序與雜訊參數不會讓快取分裂。 */
export function directoryCacheKeySuffix(query: DirectoryQuery): string {
  const params = new URLSearchParams();
  params.set("status", query.status);
  params.set("limit", String(query.limit));
  if (query.query) params.set("q", query.query);
  if (query.cursor) params.set("cursor", query.cursor);
  return params.toString();
}

/**
 * 公開議題列表：只列出建立者勾選「公開資料」的討論，且排除依行為準則下架者。
 * 直接讀 registry 快照（每場討論至多每 5 分鐘回寫一次），不對每一場再打一次 RPC——
 * 列表頁是任何人都打得到的端點，扇出查詢會把免費額度的讀取列數燒光。
 */
export async function listPublicConversations(
  env: Env,
  query: DirectoryQuery,
): Promise<ConversationRegistryPage> {
  const registry = registryStub(env);
  await registry.bootstrapKnownConversations(KNOWN_CONVERSATION_IDS);
  const page = await registry.listRegisteredConversations({
    status: query.status === "all" ? undefined : query.status,
    includePrivate: false,
    includeDelisted: false,
    query: query.query || undefined,
    limit: query.limit,
    cursor: query.cursor,
  });
  return { ...page, conversations: page.conversations.map(toDirectoryEntry) };
}

/** 列表只需要展示欄位；下架理由與管理旗標不外流。 */
function toDirectoryEntry(entry: ConversationRegistryEntry) {
  const { delisted, delistedReason, indexedAt, autoApprove, ...rest } = entry;
  return { ...rest, indexedAt } as ConversationRegistryEntry;
}

export async function getConversation(env: Env, conversationId: string): Promise<DurableObjectStub<Conversation> | null> {
  if (!/^[a-z0-9]{10}$/.test(conversationId)) return null;
  const stub = env.CONVERSATION.getByName(`conv:${conversationId}`);
  return (await stub.isConversation()) ? stub : null;
}

export function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(36).padStart(10, "0").slice(-10);
}

export function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
