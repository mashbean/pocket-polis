import type { VoteMatrix } from "./matrix";

/**
 * 橋接排序（bridging rank）：Community Notes／Agora 那一類「跨立場都能接受」的排序。
 *
 * 模型：r_ij ≈ μ + a_i + b_j + f_i·g_j
 *   r_ij  參與者 i 對陳述 j 的投票（agree=1、disagree=-1、pass=0；未投不計）
 *   a_i   參與者的整體寬鬆度；f_i 參與者在單一意見軸上的位置
 *   b_j   陳述的「橋接分數」：扣掉立場軸的影響後，大家還剩多少同意
 *   g_j   陳述的「極化度」：這句話有多依賴立場軸
 *
 * 用交替最小平方（ALS）加 L2 正則化求解；同樣的原始同意率，被單一陣營撐起來的陳述 b_j 會比較低、|g_j| 比較高。
 * 只輸出陳述層級的彙整（b、g、投票數），不輸出任何參與者的 a、f。
 */
export interface BridgingStatement {
  sid: number;
  /** 扣掉立場軸之後的同意程度（-1..1 附近；越高越像橋） */
  score: number;
  /** 極化度：|g_j| 以最大值正規化到 0..1 */
  polarity: number;
  seen: number;
  agrees: number;
  disagrees: number;
}

export interface BridgingResult {
  method: "matrix-factorization-1d";
  nParticipants: number;
  minSeen: number;
  iterations: number;
  statements: BridgingStatement[];
}

const LAMBDA_INTERCEPT = 0.03;
const LAMBDA_FACTOR = 0.15;
const ITERATIONS = 40;
export const MIN_BRIDGING_PARTICIPANTS = 4;

export function bridgingRank(matrix: VoteMatrix, rng: () => number): BridgingResult | null {
  const n = matrix.pids.length;
  const m = matrix.sids.length;
  if (n < MIN_BRIDGING_PARTICIPANTS || m < 2) return null;
  const raw = matrix.raw;

  // 觀測值清單（含 pass=0）
  let total = 0;
  let count = 0;
  const seen = new Array<number>(m).fill(0);
  const agrees = new Array<number>(m).fill(0);
  const disagrees = new Array<number>(m).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const v = raw[i]![j] ?? null;
      if (v === null) continue;
      total += v;
      count += 1;
      seen[j]! += 1;
      if (v === 1) agrees[j]! += 1;
      if (v === -1) disagrees[j]! += 1;
    }
  }
  if (count === 0) return null;

  let mu = total / count;
  const a = new Float64Array(n);
  const f = new Float64Array(n);
  const b = new Float64Array(m);
  const g = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    b[j] = seen[j]! > 0 ? (matrix.colMeans[j] ?? 0) - mu : 0;
    g[j] = (rng() - 0.5) * 0.1;
  }
  for (let i = 0; i < n; i++) f[i] = (rng() - 0.5) * 0.1;

  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    // 陳述側：對每個 j 解 (b_j, g_j) 的 2×2 正規方程
    for (let j = 0; j < m; j++) {
      let s11 = LAMBDA_INTERCEPT;
      let s12 = 0;
      let s22 = LAMBDA_FACTOR;
      let t1 = 0;
      let t2 = 0;
      for (let i = 0; i < n; i++) {
        const v = raw[i]![j] ?? null;
        if (v === null) continue;
        const y = v - mu - a[i]!;
        const x = f[i]!;
        s11 += 1;
        s12 += x;
        s22 += x * x;
        t1 += y;
        t2 += y * x;
      }
      const det = s11 * s22 - s12 * s12;
      if (Math.abs(det) < 1e-9) continue;
      b[j] = (t1 * s22 - t2 * s12) / det;
      g[j] = (s11 * t2 - s12 * t1) / det;
    }
    // 參與者側：對每個 i 解 (a_i, f_i)
    for (let i = 0; i < n; i++) {
      let s11 = LAMBDA_INTERCEPT;
      let s12 = 0;
      let s22 = LAMBDA_FACTOR;
      let t1 = 0;
      let t2 = 0;
      for (let j = 0; j < m; j++) {
        const v = raw[i]![j] ?? null;
        if (v === null) continue;
        const y = v - mu - b[j]!;
        const x = g[j]!;
        s11 += 1;
        s12 += x;
        s22 += x * x;
        t1 += y;
        t2 += y * x;
      }
      const det = s11 * s22 - s12 * s12;
      if (Math.abs(det) < 1e-9) continue;
      a[i] = (t1 * s22 - t2 * s12) / det;
      f[i] = (s11 * t2 - s12 * t1) / det;
    }
    // 全域平均
    let residual = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        const v = raw[i]![j] ?? null;
        if (v === null) continue;
        residual += v - a[i]! - b[j]! - f[i]! * g[j]!;
      }
    }
    mu = residual / count;
  }

  // 重新定錨：把立場軸的原點放在兩端陣營的中間（f 的 10／90 百分位中點），而不是人口平均。
  // 陣營人數不等時，人口平均會偏向多數陣營，讓「只有多數陣營同意」的陳述誤看成橋。
  // r ≈ μ + a + b + (f - c)·g + c·g，所以橋接分數 = μ + b_j + c·g_j。
  const sortedF = Array.from(f).sort((x, y) => x - y);
  const lo = sortedF[Math.floor((n - 1) * 0.1)]!;
  const hi = sortedF[Math.ceil((n - 1) * 0.9)]!;
  const center = (lo + hi) / 2;
  let maxG = 0;
  for (let j = 0; j < m; j++) maxG = Math.max(maxG, Math.abs(g[j]!));
  const minSeen = Math.max(3, Math.ceil(n * 0.1));
  const statements: BridgingStatement[] = [];
  for (let j = 0; j < m; j++) {
    if (seen[j]! < minSeen) continue;
    statements.push({
      sid: matrix.sids[j]!,
      score: round(mu + b[j]! + center * g[j]!),
      polarity: round(maxG > 0 ? Math.abs(g[j]!) / maxG : 0),
      seen: seen[j]!,
      agrees: agrees[j]!,
      disagrees: disagrees[j]!,
    });
  }
  statements.sort((left, right) => right.score - left.score || left.polarity - right.polarity || left.sid - right.sid);
  return { method: "matrix-factorization-1d", nParticipants: n, minSeen, iterations: ITERATIONS, statements };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
