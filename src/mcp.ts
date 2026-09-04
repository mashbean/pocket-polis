import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { invalidateConversationPublicCache } from "./cache";
import type { Conversation, ConversationRegistryEntry, PublicInfo } from "./conversation";
import type { VoteValue } from "./math/types";
import {
  KNOWN_CONVERSATION_IDS,
  createConversationFromInput,
  getConversation,
  registryStub,
} from "./service";

const MCP_SERVER_NAME = "pocket-polis";
const MCP_SERVER_VERSION = "0.1.0";

const conversationIdSchema = z
  .string()
  .regex(/^[a-z0-9]{10}$/, "conversationId must be 10 lowercase letters or digits");
const participantIdSchema = z.string().uuid("pid must be a UUID retained by the participant");
const adminTokenSchema = z.string().min(1).optional().describe("Per-conversation admin token, when required");
const listSchema = z.object({
  scope: z
    .enum(["public", "all"])
    .default("public")
    .describe("public lists openData conversations; all requires the global MCP bearer token"),
  status: z.enum(["all", "open", "closed"]).default("all"),
  query: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().regex(/^\d+$/).optional(),
});

export interface PocketPolisMcpAccess {
  globalAdmin: boolean;
  origin?: string;
}

export function createPocketPolisMcpServer(env: Env, access: PocketPolisMcpAccess): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        "Pocket Polis MCP exposes public deliberation data and participation tools. " +
        "Use list_active_conversations for ongoing openData discussions. Exact conversation URLs remain public. " +
        "Private enumeration and global administration require the configured MCP bearer token; " +
        "per-conversation admin actions can use that conversation's admin token.",
    },
  );

  server.registerTool(
    "list_conversations",
    {
      title: "List Pocket Polis conversations",
      description:
        "List indexed conversations with live counts. By default only openData conversations are enumerable. " +
        "Use scope=all only with the global MCP bearer token.",
      inputSchema: listSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => toolResult(await listConversations(env, access, args)),
  );

  server.registerTool(
    "list_active_conversations",
    {
      title: "List ongoing conversations",
      description: "List currently open Pocket Polis conversations, including current statement, participant, and vote counts.",
      inputSchema: listSchema.omit({ status: true }),
      annotations: readOnlyAnnotations,
    },
    async (args) => toolResult(await listConversations(env, access, { ...args, status: "open" })),
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Get conversation details",
      description:
        "Get one conversation's public metadata, approved statements, clustering, representative statements, " +
        "consensus, and live counts. This mirrors the public conversation and report pages.",
      inputSchema: z.object({
        conversationId: conversationIdSchema,
        includeStatements: z.boolean().default(true),
        includeResults: z.boolean().default(true),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ conversationId, includeStatements, includeResults }) => {
      const details = await conversationDetails(env, conversationId, includeStatements, includeResults);
      return details ? toolResult(details) : toolError("conversation not found");
    },
  );

  server.registerTool(
    "get_conversation_results",
    {
      title: "Get live deliberation results",
      description: "Get opinion-map points, groups, representative statements, consensus, and statement statistics.",
      inputSchema: z.object({ conversationId: conversationIdSchema, pid: participantIdSchema.optional() }),
      annotations: readOnlyAnnotations,
    },
    async ({ conversationId, pid }) => {
      const stub = await getConversation(env, conversationId);
      if (!stub) return toolError("conversation not found");
      return toolResult(await stub.getResults(pid ?? null, Date.now()));
    },
  );

  server.registerTool(
    "create_conversation",
    {
      title: "Create a conversation",
      description:
        "Create a new Pocket Polis discussion and return participate, report, and one-time admin links. " +
        "Creation uses the same site-wide rate limit as the web API.",
      inputSchema: z.object({
        title: z.string().min(1).max(120),
        description: z.string().max(2000).default(""),
        seedStatements: z.array(z.string().min(1).max(280)).max(50).default([]),
        autoApprove: z.boolean().default(true),
        allowSubmissions: z.boolean().default(true),
        openData: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const result = await createConversationFromInput(env, args);
      return result.ok ? toolResult(result.value) : toolError(result.error);
    },
  );

  server.registerTool(
    "get_next_statement",
    {
      title: "Get next statement to vote on",
      description:
        "Return a low-vote-priority statement not yet voted on by this participant, plus progress. " +
        "The first call registers the participant in the conversation.",
      inputSchema: z.object({ conversationId: conversationIdSchema, pid: participantIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ conversationId, pid }) => {
      const stub = await getConversation(env, conversationId);
      return stub ? toolResult(await stub.nextStatement(pid, Date.now())) : toolError("conversation not found");
    },
  );

  server.registerTool(
    "cast_vote",
    {
      title: "Cast or change a vote",
      description: "Cast agree (1), disagree (-1), or pass (0) for a participant and statement.",
      inputSchema: z.object({
        conversationId: conversationIdSchema,
        pid: participantIdSchema,
        statementId: z.number().int().positive(),
        value: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ conversationId, pid, statementId, value }) => {
      const stub = await getConversation(env, conversationId);
      if (!stub) return toolError("conversation not found");
      const result = await stub.castVote(pid, statementId, value as VoteValue, Date.now());
      return result.ok ? toolResult(result) : toolError(result.error);
    },
  );

  server.registerTool(
    "submit_statement",
    {
      title: "Submit a statement",
      description: "Submit a single votable statement to an open conversation; moderation behavior follows its settings.",
      inputSchema: z.object({
        conversationId: conversationIdSchema,
        pid: participantIdSchema,
        text: z.string().min(1).max(280),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ conversationId, pid, text }) => {
      const stub = await getConversation(env, conversationId);
      if (!stub) return toolError("conversation not found");
      const result = await stub.submitStatement(pid, text, Date.now());
      return result.ok ? toolResult(result) : toolError(result.error);
    },
  );

  server.registerTool(
    "export_conversation_data",
    {
      title: "Export conversation data",
      description:
        "Export comments.csv, statements.csv, or anonymized votes.csv. OpenData conversations are public; " +
        "otherwise supply the conversation admin token or global MCP bearer token.",
      inputSchema: z.object({
        conversationId: conversationIdSchema,
        format: z.enum(["comments", "statements", "votes"]),
        adminToken: adminTokenSchema,
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ conversationId, format, adminToken }) => {
      const stub = await getConversation(env, conversationId);
      if (!stub) return toolError("conversation not found");
      const csv = await exportData(stub, format, adminToken ?? null, access.globalAdmin);
      if (csv === null) return toolError("unauthorized: data export is not public for this conversation");
      return { content: [{ type: "text", text: csv }] };
    },
  );

  server.registerTool(
    "get_admin_overview",
    {
      title: "Get admin overview",
      description: "Get settings and all statement moderation states using a conversation admin token or global MCP access.",
      inputSchema: z.object({ conversationId: conversationIdSchema, adminToken: adminTokenSchema }),
      annotations: readOnlyAnnotations,
    },
    async ({ conversationId, adminToken }) => {
      const stub = await getConversation(env, conversationId);
      if (!stub) return toolError("conversation not found");
      const result = await stub.adminOverview(adminToken ?? "", access.globalAdmin);
      return "error" in result ? toolError(result.error) : toolResult(result);
    },
  );

  server.registerTool(
    "moderate_statement",
    {
      title: "Approve or reject a statement",
      description: "Moderate a submitted statement using a conversation admin token or global MCP access.",
      inputSchema: z.object({
        conversationId: conversationIdSchema,
        statementId: z.number().int().positive(),
        action: z.enum(["approve", "reject"]),
        adminToken: adminTokenSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ conversationId, statementId, action, adminToken }) => {
      const stub = await getConversation(env, conversationId);
      if (!stub) return toolError("conversation not found");
      const result = await stub.moderateStatement(adminToken ?? "", statementId, action, access.globalAdmin);
      if (result.ok && access.origin) {
        await invalidateConversationPublicCache(access.origin, conversationId);
      }
      return result.ok ? toolResult(result) : toolError(result.error);
    },
  );

  server.registerTool(
    "add_seed_statement",
    {
      title: "Add an approved host statement",
      description: "Add a host-authored approved statement using a conversation admin token or global MCP access.",
      inputSchema: z.object({
        conversationId: conversationIdSchema,
        text: z.string().min(1).max(280),
        adminToken: adminTokenSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ conversationId, text, adminToken }) => {
      const stub = await getConversation(env, conversationId);
      if (!stub) return toolError("conversation not found");
      const result = await stub.addSeedStatement(adminToken ?? "", text, Date.now(), access.globalAdmin);
      if (result.ok && access.origin) {
        await invalidateConversationPublicCache(access.origin, conversationId);
      }
      return result.ok ? toolResult(result) : toolError(result.error);
    },
  );

  server.registerTool(
    "update_conversation_settings",
    {
      title: "Update conversation settings",
      description:
        "Update title, description, moderation, submissions, openData, open/closed status, or alternate-language URL.",
      inputSchema: z.object({
        conversationId: conversationIdSchema,
        adminToken: adminTokenSchema,
        title: z.string().min(1).max(120).optional(),
        description: z.string().max(2000).optional(),
        autoApprove: z.boolean().optional(),
        allowSubmissions: z.boolean().optional(),
        openData: z.boolean().optional(),
        status: z.enum(["open", "closed"]).optional(),
        altUrl: z.string().max(300).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ conversationId, adminToken, ...settings }) => {
      const stub = await getConversation(env, conversationId);
      if (!stub) return toolError("conversation not found");
      const result = await stub.updateSettings(adminToken ?? "", settings, access.globalAdmin);
      return result.ok ? toolResult(result) : toolError(result.error);
    },
  );

  server.registerTool(
    "register_conversation",
    {
      title: "Register a legacy conversation",
      description:
        "Add an existing pre-registry conversation to global enumeration by its public 10-character ID. " +
        "Requires global MCP access.",
      inputSchema: z.object({ conversationId: conversationIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ conversationId }) => {
      if (!access.globalAdmin) return toolError("global MCP authorization required");
      const stub = await getConversation(env, conversationId);
      if (!stub) return toolError("conversation not found");
      const info = await stub.publicInfo();
      if (!info) return toolError("conversation not found");
      await registry(env).registerConversation(info, Date.now());
      return toolResult({ registered: [conversationId] });
    },
  );

  server.registerTool(
    "set_conversation_listing",
    {
      title: "Delist or relist a conversation",
      description:
        "Take a conversation down from the public directory under the Code of Conduct, or restore it. " +
        "This only withdraws the site's listing: the conversation, its links, and its data are untouched. " +
        "To stop participation as well, close it with update_conversation_settings. Requires global MCP access.",
      inputSchema: z.object({
        conversationId: conversationIdSchema,
        delisted: z.boolean().describe("true takes the conversation off the public directory"),
        reason: z
          .string()
          .max(300)
          .default("")
          .describe("Which Code of Conduct rule applies; kept for the takedown record"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ conversationId, delisted, reason }) => {
      if (!access.globalAdmin) return toolError("global MCP authorization required");
      const result = await registry(env).setConversationListing(
        conversationId,
        delisted,
        reason,
        Date.now(),
      );
      return result.ok ? toolResult(result) : toolError(result.error);
    },
  );

  server.registerTool(
    "backfill_conversation_registry",
    {
      title: "Backfill legacy Durable Objects",
      description:
        "Inspect up to 100 Durable Object hash IDs returned by Cloudflare's namespace Objects API and register " +
        "those that contain Pocket Polis conversations. Requires global MCP access.",
      inputSchema: z.object({ objectIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(100) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ objectIds }) => {
      if (!access.globalAdmin) return toolError("global MCP authorization required");
      const registered: string[] = [];
      const skipped: string[] = [];
      for (const objectId of objectIds) {
        const stub = env.CONVERSATION.get(env.CONVERSATION.idFromString(objectId));
        const info = await stub.publicInfo();
        if (info) {
          await registry(env).registerConversation(info, Date.now());
          registered.push(info.id);
        } else {
          skipped.push(objectId);
        }
      }
      return toolResult({ registered, skipped });
    },
  );

  server.registerResource(
    "active-conversations",
    "pocket-polis://indexes/active",
    {
      title: "Ongoing public Pocket Polis conversations",
      description: "Live index of openData conversations whose status is open.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [jsonResource(uri.href, await listConversations(env, { globalAdmin: false }, {
        scope: "public",
        status: "open",
        limit: 100,
      }))],
    }),
  );

  server.registerResource(
    "conversation",
    new ResourceTemplate("pocket-polis://conversations/{conversationId}", {
      list: async () => {
        const page = await listConversations(env, { globalAdmin: false }, { scope: "public", status: "all", limit: 100 });
        return {
          resources: page.conversations.map((item) => ({
            uri: `pocket-polis://conversations/${item.id}`,
            name: item.title,
            description: `${item.status}; ${item.counts.participants} participants; ${item.counts.votes} votes`,
            mimeType: "application/json",
          })),
        };
      },
      complete: {
        conversationId: async (value) => {
          const page = await listConversations(env, { globalAdmin: false }, {
            scope: "public",
            status: "all",
            query: value,
            limit: 20,
          });
          return page.conversations.map((item) => item.id);
        },
      },
    }),
    {
      title: "Pocket Polis conversation detail",
      description: "Public metadata, statements, live groups, representative statements, and consensus.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const conversationId = String(variables.conversationId ?? "");
      const details = await conversationDetails(env, conversationId, true, true);
      if (!details) throw new Error("conversation not found");
      return { contents: [jsonResource(uri.href, details)] };
    },
  );

  server.registerPrompt(
    "analyze_deliberation",
    {
      title: "Analyze a Pocket Polis deliberation",
      description:
        "Load one conversation and ask for a neutral synthesis of groups, representative positions, consensus, and limitations.",
      argsSchema: z.object({
        conversationId: conversationIdSchema,
        language: z.enum(["zh-Hant", "en"]).default("zh-Hant"),
      }),
    },
    async ({ conversationId, language }) => {
      const details = await conversationDetails(env, conversationId, true, true);
      if (!details) throw new Error("conversation not found");
      const instruction =
        language === "zh-Hant"
          ? "請中立分析這場審議：逐群說明代表立場、指出跨群共識與主要分歧，清楚區分資料觀察與推論，並提醒匿名自選樣本及目前樣本數的限制。"
          : "Analyze this deliberation neutrally: explain each group's representative positions, identify cross-group consensus and major disagreements, distinguish observations from inference, and note the limits of an anonymous self-selected sample.";
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: `${instruction}\n\n${JSON.stringify(details, null, 2)}` },
          },
        ],
      };
    },
  );

  return server;
}

export function isGlobalMcpAdmin(request: Request, env: Env): boolean {
  const expected = env.MCP_ADMIN_TOKEN?.trim();
  if (!expected) return false;
  const header = request.headers.get("Authorization");
  const actual = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return constantTimeEqual(actual, expected);
}

async function listConversations(
  env: Env,
  access: PocketPolisMcpAccess,
  options: {
    scope?: "public" | "all";
    status?: "all" | "open" | "closed";
    query?: string;
    limit?: number;
    cursor?: string;
  },
) {
  const includePrivate = options.scope === "all";
  if (includePrivate && !access.globalAdmin) throw new Error("global MCP authorization required for scope=all");
  const registryStub = registry(env);
  await registryStub.bootstrapKnownConversations(KNOWN_CONVERSATION_IDS);
  const page = await registryStub.listRegisteredConversations({
    status: options.status && options.status !== "all" ? options.status : undefined,
    includePrivate,
    // 依行為準則下架的討論只對全域管理者可見，公開列舉一律排除
    includeDelisted: access.globalAdmin,
    query: options.query,
    limit: options.limit ?? 25,
    cursor: options.cursor,
  });

  const live = await Promise.all(
    page.conversations.map(async (entry) => {
      const info = await env.CONVERSATION.getByName(`conv:${entry.id}`).publicInfo();
      return info
        ? {
            ...info,
            indexedAt: entry.indexedAt,
            updatedAt: entry.updatedAt,
            delisted: entry.delisted,
            delistedReason: entry.delistedReason,
          }
        : null;
    }),
  );
  return { conversations: live.filter((item): item is ConversationRegistryEntry => item !== null), total: page.total, nextCursor: page.nextCursor };
}

async function conversationDetails(env: Env, conversationId: string, includeStatements: boolean, includeResults: boolean) {
  const stub = await getConversation(env, conversationId);
  if (!stub) return null;
  const [info, statements, results] = await Promise.all([
    stub.publicInfo(),
    includeStatements ? stub.publicStatements() : Promise.resolve(undefined),
    includeResults ? stub.getResults(null, Date.now()) : Promise.resolve(undefined),
  ]);
  return { info, ...(statements ? { statements: statements.statements } : {}), ...(results ? { results } : {}) };
}

function registry(env: Env): DurableObjectStub<Conversation> {
  return registryStub(env);
}

function exportData(
  stub: DurableObjectStub<Conversation>,
  format: "comments" | "statements" | "votes",
  token: string | null,
  trusted: boolean,
): Promise<string | null> {
  if (format === "comments") return stub.exportCommentsCsv(token, trusted);
  if (format === "statements") return stub.exportStatementsCsv(token, trusted);
  return stub.exportVotesCsv(token, trusted);
}

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { data },
  };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function jsonResource(uri: string, data: unknown) {
  return { uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) };
}

function constantTimeEqual(actual: string, expected: string): boolean {
  let diff = actual.length ^ expected.length;
  const length = Math.max(actual.length, expected.length);
  for (let i = 0; i < length; i++) {
    diff |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const MCP_TOOL_NAMES = [
  "list_conversations",
  "list_active_conversations",
  "get_conversation",
  "get_conversation_results",
  "create_conversation",
  "get_next_statement",
  "cast_vote",
  "submit_statement",
  "export_conversation_data",
  "get_admin_overview",
  "moderate_statement",
  "add_seed_statement",
  "update_conversation_settings",
  "register_conversation",
  "set_conversation_listing",
  "backfill_conversation_registry",
] as const;
