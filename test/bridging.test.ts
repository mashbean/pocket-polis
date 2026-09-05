import { describe, expect, it } from "vitest";
import { bridgingRank } from "../src/math/bridging";
import { buildMatrix } from "../src/math/matrix";
import { computeMath } from "../src/math/pipeline";
import { hashSeed, mulberry32 } from "../src/math/rng";
import type { VoteRow, VoteValue } from "../src/math/types";

/**
 * 60 人、兩個陣營（40／20）。
 * sid 1「極化」：陣營一全同意、陣營二全不同意 → 40 同意。
 * sid 2「橋」：陣營一 25/40、陣營二 13/20 同意，其餘不同意 → 38 同意（原始同意數比 sid 1 少）。
 * sid 3、4：定義立場軸的兩句（互為鏡像）。
 */
function synthetic(): VoteRow[] {
  const votes: VoteRow[] = [];
  const vote = (pid: string, sid: number, value: VoteValue) => votes.push({ pid, sid, value });
  for (let i = 0; i < 60; i++) {
    const pid = `p${i}`;
    const groupOne = i < 40;
    vote(pid, 1, groupOne ? 1 : -1);
    const bridgeAgree = groupOne ? i < 25 : i < 53;
    vote(pid, 2, bridgeAgree ? 1 : -1);
    vote(pid, 3, groupOne ? 1 : -1);
    vote(pid, 4, groupOne ? -1 : 1);
    vote(pid, 5, i % 3 === 0 ? 0 : groupOne ? 1 : -1);
  }
  return votes;
}

describe("bridging rank", () => {
  it("scores a statement agreed across camps above one carried by a single camp, even with fewer raw agrees", () => {
    const votes = synthetic();
    const matrix = buildMatrix(votes, [1, 2, 3, 4, 5], 1);
    const result = bridgingRank(matrix, mulberry32(hashSeed("bridging-test")));
    expect(result).not.toBeNull();
    const by = new Map(result!.statements.map((s) => [s.sid, s]));
    expect(by.get(1)?.agrees).toBe(40);
    expect(by.get(2)?.agrees).toBe(38);
    expect(by.get(2)!.score).toBeGreaterThan(by.get(1)!.score);
    expect(by.get(1)!.polarity).toBeGreaterThan(by.get(2)!.polarity);
    expect(by.get(1)!.polarity).toBeGreaterThan(0.5);
    expect(result!.statements[0]?.sid).toBe(2);
    expect(result!.minSeen).toBe(6);
    expect(JSON.stringify(result)).not.toContain("p0");
  });

  it("is deterministic for the same seed and absent below four clustered participants", () => {
    const votes = synthetic();
    const matrix = buildMatrix(votes, [1, 2, 3, 4, 5], 1);
    const first = bridgingRank(matrix, mulberry32(7));
    const second = bridgingRank(matrix, mulberry32(7));
    expect(first).toEqual(second);
    const tiny = buildMatrix(votes.filter((v) => ["p0", "p1", "p2"].includes(v.pid)), [1, 2, 3, 4, 5], 1);
    expect(bridgingRank(tiny, mulberry32(7))).toBeNull();
  });

  it("is carried by computeMath as statement-level aggregates only", () => {
    const out = computeMath({ conversationId: "c", votes: synthetic(), statementIds: [1, 2, 3, 4, 5], computedAt: 1 });
    expect(out.publicResult.bridging?.statements.length).toBe(5);
    expect(out.publicResult.bridging?.statements[0]?.sid).toBe(2);
    const serialized = JSON.stringify(out.publicResult.bridging);
    for (let i = 0; i < 60; i++) expect(serialized).not.toContain(`"p${i}"`);
  });
});
