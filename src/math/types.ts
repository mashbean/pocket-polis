// 投票值採 agree=1 / disagree=-1 / pass=0（與 red-dwarf 相同；
// 注意官方 polis 資料庫的原始編碼相反，agree 是 -1）。
export type VoteValue = -1 | 0 | 1;

export interface VoteRow {
  pid: string;
  sid: number;
  value: VoteValue;
}

export interface StatementStat {
  sid: number;
  agrees: number;
  disagrees: number;
  passes: number;
  seen: number;
}

export interface RepresentativeStatement {
  sid: number;
  direction: "agree" | "disagree";
  /** 該群對此陳述投出此方向的估計機率（含 pseudocount） */
  prob: number;
  probTest: number;
  /** 群內機率 / 群外機率 */
  repness: number;
  repnessTest: number;
  metric: number;
  nSuccess: number;
  nSeen: number;
}

export interface GroupResult {
  id: number;
  label: string;
  size: number;
  center: [number, number];
  representative: RepresentativeStatement[];
  /**
   * 該群在各陳述上的投票統計（納入分群之參與者）。
   * 公開版只含通過 k-匿名規則的格子（群 >= k、格 seen >= k、餘數 0 或 >= k），見 pipeline.privacySafeMathResult。
   */
  statementStats?: StatementStat[];
  /** 公開版：此群人數低於 k-匿名下限，statementStats 與 representative 已遮蔽 */
  statsRedacted?: boolean;
}

export interface ConsensusStatement {
  sid: number;
  direction: "agree" | "disagree";
  /** 全體（納入分群者）投出此方向的估計機率 */
  prob: number;
  probTest: number;
  /** 各群機率的乘積（group-aware consensus metric） */
  metric: number;
}

export interface OpinionPoint {
  x: number;
  y: number;
  group: number;
}

export interface BridgingStatement {
  sid: number;
  /** 扣掉立場軸之後的同意程度；越高越像跨立場都能接受的橋 */
  score: number;
  /** 極化度 0..1：這句話有多依賴立場軸 */
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

export interface MathResult {
  computedAt: number;
  nParticipantsTotal: number;
  nParticipantsClustered: number;
  nVotes: number;
  nStatements: number;
  inclusionThreshold: number;
  k: number;
  silhouette: number | null;
  points: OpinionPoint[];
  groups: GroupResult[];
  consensus: { agree: ConsensusStatement[]; disagree: ConsensusStatement[] };
  statementStats: StatementStat[];
  /** 橋接排序（Community Notes／Agora 式），只有陳述層級的彙整；納入分群者不足 4 人時為 null */
  bridging?: BridgingResult | null;
}

export interface PipelineOutput {
  publicResult: MathResult;
  /** pid → 該參與者在意見地圖上的座標與群。只留在 DO 內，不進公開快取。 */
  pidPoints: Record<string, OpinionPoint>;
}
