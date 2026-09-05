import { bridgingRank } from "./bridging";
import { buildMatrix, inclusionThreshold } from "./matrix";
import { chooseGroups } from "./kmeans";
import { powerPCA, projectParticipants } from "./pca";
import { consensusStatements, representativeStatements } from "./repness";
import { hashSeed, mulberry32 } from "./rng";
import type {
  GroupResult,
  MathResult,
  OpinionPoint,
  PipelineOutput,
  StatementStat,
  VoteRow,
} from "./types";

const GROUP_LABELS = ["A", "B", "C", "D", "E"];

export interface PipelineInput {
  conversationId: string;
  /** 只包含已核准陳述上的投票 */
  votes: VoteRow[];
  /** 已核准陳述的 id */
  statementIds: number[];
  computedAt: number;
  /** 前一次結果的群數（k-smoothing：差距在 buffer 內時保留） */
  previousK?: number | null;
}

export function computeMath(input: PipelineInput): PipelineOutput {
  const { votes, statementIds } = input;
  const rng = mulberry32(hashSeed(`${input.conversationId}:${votes.length}:${statementIds.length}`));

  const statementStats = tallyStatements(votes, statementIds);
  const allPids = new Set(votes.map((v) => v.pid));

  const threshold = inclusionThreshold(statementIds.length);
  const matrix = buildMatrix(votes, statementIds, threshold);

  const base: MathResult = {
    computedAt: input.computedAt,
    nParticipantsTotal: allPids.size,
    nParticipantsClustered: matrix.pids.length,
    nVotes: votes.length,
    nStatements: statementIds.length,
    inclusionThreshold: threshold,
    k: 0,
    silhouette: null,
    points: [],
    groups: [],
    consensus: { agree: [], disagree: [] },
    statementStats,
    bridging: null,
  };

  if (matrix.pids.length === 0 || statementIds.length === 0) {
    return { publicResult: base, pidPoints: {} };
  }

  const comps = powerPCA(matrix.centered, statementIds.length, rng);
  const projected = projectParticipants(matrix, comps);
  const grouping = chooseGroups(projected, rng, input.previousK ?? null);

  // 依群大小重新編號（最大的是 A），視覺與敘事穩定
  const sizes = new Array<number>(grouping.k).fill(0);
  for (const a of grouping.assignments) sizes[a]!++;
  const order = [...sizes.keys()].sort((a, b) => sizes[b]! - sizes[a]!);
  const renumber = new Map(order.map((oldId, newId) => [oldId, newId]));

  const assignments = grouping.assignments.map((a) => renumber.get(a)!);
  const points: OpinionPoint[] = projected.map((p, i) => ({
    x: round(p.x),
    y: round(p.y),
    group: assignments[i]!,
  }));

  const pidToGroup = new Map<string, number>();
  matrix.pids.forEach((pid, i) => {
    pidToGroup.set(pid, assignments[i]!);
  });
  const groupStats = tallyGroupStatements(votes, statementIds, pidToGroup, grouping.k);

  const reps = representativeStatements(matrix, assignments, grouping.k);
  const groups: GroupResult[] = [];
  for (let g = 0; g < grouping.k; g++) {
    const members = points.filter((p) => p.group === g);
    const cx = members.reduce((s, p) => s + p.x, 0) / Math.max(members.length, 1);
    const cy = members.reduce((s, p) => s + p.y, 0) / Math.max(members.length, 1);
    groups.push({
      id: g,
      label: GROUP_LABELS[g] ?? `${g + 1}`,
      size: members.length,
      center: [round(cx), round(cy)],
      representative: reps[g] ?? [],
      statementStats: groupStats[g] ?? [],
    });
  }

  const consensus = consensusStatements(matrix, assignments, grouping.k);
  const bridging = bridgingRank(matrix, mulberry32(hashSeed(`${input.conversationId}:bridging:${votes.length}`)));

  const pidPoints: Record<string, OpinionPoint> = {};
  matrix.pids.forEach((pid, i) => {
    pidPoints[pid] = points[i]!;
  });

  return {
    publicResult: {
      ...base,
      k: grouping.k,
      silhouette: grouping.silhouette === null ? null : round(grouping.silhouette),
      points,
      groups,
      consensus,
      bridging,
    },
    pidPoints,
  };
}

/**
 * 公開每群逐陳述票數的最小群體人數（k-匿名下限）。
 * k-means 可能產出 1～2 人的群；其 agree/disagree/pass 逐陳述統計等同於揭露個人投票，
 * 即使關閉開放資料匯出也會外洩。低於此人數的群，statementStats 不進公開 /results、
 * 不進 AI 提示的群體對比、也不得作為張力證據。
 */
export const MIN_GROUP_STATS_SIZE = 3;

/**
 * 隱私安全版 MathResult（k = MIN_GROUP_STATS_SIZE）。公開 /results 與 AI／確定性綜整一律只看這個版本；
 * 完整版只存在 DO 的 mathCache 內。三層規則：
 *
 * 1. 群體下限：size < k 的群只保留 id / label / size / center（statementStats 與 representative 移除，
 *    標記 statsRedacted）。representativeStatements() 對每群至少退而取一句，單人群的代表性方向就是那個人的投票。
 * 2. 逐格下限：即使群 >= k，某陳述在該群的 seen 仍可能是 1～2，直接公佈 {agrees, disagrees, passes, seen}
 *    等於公佈那一兩個人的選擇。任一格 seen < k 即整列（該陳述所有群的格子）抑制。
 * 3. 互補差分：全體 statementStats 減去已公佈群格，餘數 = 未分群者 + 被抑制格。整列抑制讓被抑制格
 *    不會單獨成為餘數；再要求餘數的 seen 為 0 或 >= k，否則同樣整列抑制。於是每個可公佈或可推導的
 *    池子都 >= k。
 * 代表性陳述亦套用逐格下限（nSeen < k 者移除），因其自帶 nSuccess / nSeen。
 */
export function privacySafeMathResult(result: MathResult, k = MIN_GROUP_STATS_SIZE): MathResult {
  const totals = new Map(result.statementStats.map((s) => [s.sid, s]));
  const reportable = result.groups.filter((g) => g.size >= k && Array.isArray(g.statementStats));
  const cellOf = (g: GroupResult, sid: number) => g.statementStats?.find((s) => s.sid === sid);

  // 決定每個陳述是否可公佈群格（整列規則）
  const publishableSids = new Set<number>();
  for (const [sid, total] of totals) {
    if (reportable.length === 0) continue;
    let ok = true;
    let publishedSeen = 0;
    for (const g of reportable) {
      const cell = cellOf(g, sid);
      const seen = cell ? cell.seen : 0;
      if (seen < k) {
        ok = false;
        break;
      }
      publishedSeen += seen;
    }
    if (!ok) continue;
    const residual = total.seen - publishedSeen;
    if (residual !== 0 && residual < k) continue;
    publishableSids.add(sid);
  }

  return {
    ...result,
    groups: result.groups.map((g) => {
      if (g.size < k) {
        const { statementStats: _omit, ...rest } = g;
        return { ...rest, representative: [], statsRedacted: true };
      }
      return {
        ...g,
        representative: g.representative.filter((r) => r.nSeen >= k && publishableSids.has(r.sid)),
        statementStats: (g.statementStats ?? []).filter((s) => publishableSids.has(s.sid)),
      };
    }),
  };
}

/** @deprecated 舊名；請用 privacySafeMathResult */
export const redactSmallGroupStats = privacySafeMathResult;

function tallyStatements(votes: VoteRow[], statementIds: number[]): StatementStat[] {
  const stats = new Map<number, StatementStat>(
    statementIds.map((sid) => [sid, { sid, agrees: 0, disagrees: 0, passes: 0, seen: 0 }]),
  );
  for (const v of votes) {
    const s = stats.get(v.sid);
    if (!s) continue;
    s.seen++;
    if (v.value === 1) s.agrees++;
    else if (v.value === -1) s.disagrees++;
    else s.passes++;
  }
  return [...stats.values()];
}

function tallyGroupStatements(
  votes: VoteRow[],
  statementIds: number[],
  pidToGroup: Map<string, number>,
  k: number,
): StatementStat[][] {
  const stats: StatementStat[][] = Array.from({ length: k }, () =>
    statementIds.map((sid) => ({ sid, agrees: 0, disagrees: 0, passes: 0, seen: 0 })),
  );
  const maps = stats.map((list) => new Map<number, StatementStat>(list.map((s) => [s.sid, s])));
  for (const v of votes) {
    const g = pidToGroup.get(v.pid);
    if (g === undefined || g < 0 || g >= k) continue;
    const target = maps[g]!.get(v.sid);
    if (!target) continue;
    target.seen++;
    if (v.value === 1) target.agrees++;
    else if (v.value === -1) target.disagrees++;
    else target.passes++;
  }
  return stats;
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}
