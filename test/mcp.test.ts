import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateConversationPublicCache } from "../src/cache";
import { isGlobalMcpAdmin, MCP_TOOL_NAMES } from "../src/mcp";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP authorization and surface", () => {
  it("recognizes only an exact configured bearer service token", () => {
    const env = { MCP_ADMIN_TOKEN: "local-secret" } as Env;
    expect(isGlobalMcpAdmin(new Request("https://example.test/mcp"), env)).toBe(false);
    expect(
      isGlobalMcpAdmin(
        new Request("https://example.test/mcp", { headers: { Authorization: "Bearer wrong" } }),
        env,
      ),
    ).toBe(false);
    expect(
      isGlobalMcpAdmin(
        new Request("https://example.test/mcp", { headers: { Authorization: "Bearer local-secret" } }),
        env,
      ),
    ).toBe(true);
  });

  it("does not grant global access when MCP_ADMIN_TOKEN is unset", () => {
    expect(
      isGlobalMcpAdmin(
        new Request("https://example.test/mcp", { headers: { Authorization: "Bearer anything" } }),
        {} as Env,
      ),
    ).toBe(false);
  });

  it("exposes the complete discussion lifecycle tool set", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(16);
    expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOL_NAMES.length);
  });

  it("invalidates synthesis-related public cache entries after MCP moderation", async () => {
    const deleteEntry = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", { default: { delete: deleteEntry } });

    await invalidateConversationPublicCache("https://example.test", "conv123456");

    expect(deleteEntry).toHaveBeenCalledTimes(3);
    expect(deleteEntry.mock.calls.map(([request]) => (request as Request).url)).toEqual([
      "https://example.test/api/conversations/conv123456/synthesis",
      "https://example.test/api/conversations/conv123456/results",
      "https://example.test/api/conversations/conv123456/statements-public",
    ]);
  });
});
