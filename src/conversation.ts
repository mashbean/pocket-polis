import { DurableObject } from "cloudflare:workers";
import { computeMath, privacySafeMathResult } from "./math/pipeline";
import { csvEscape, formatCommentsCsv } from "./export";
import type { MathResult, OpinionPoint, VoteRow, VoteValue } from "./math/types";
import {
  AI_ATTEMPT_WINDOW_MS,
  SYNTHESIS_AI_CLAIM_KEY,
} from "./ai-budget";
import { NEURON_COORDINATOR_INSTANCE } from "./neuron-coordinator";
import {
  dropUnreportableGroups,
  generateDeterministicSensemaking,
  generateSensemaking,
  inferSourceLanguage,
  isSynthesisPrivacyCurrent,
  type SensemakingResponse,
  type SensemakingSynthesis,
} from "./sensemaking";
export interface ConversationSettings {
  title: string;
  description: string;
  autoApprove: boolean;
  allowSubmissions: boolean;
  openData: boolean;
  status: "open" | "closed";
  /** 另一語言版本的連結（選填；顯示在參與與結果頁的切換橫幅） */
  altUrl?: string;
}

export interface PublicInfo {
  id: string;
  title: string;
  description: string;
  status: "open" | "closed";
  allowSubmissions: boolean;
  autoApprove: boolean;
  openData: boolean;
  altUrl: string;
  counts: { statements: number; participants: number; votes: number };
  createdAt: number;
}

export interface ConversationRegistryEntry extends PublicInfo {
  indexedAt: number;
  updatedAt: number;
  /** 依行為準則自公開列表下架；下架後仍可用原網址參與，只是不再被列舉。 */
  delisted: boolean;
  delistedReason: string;
}

export interface ConversationRegistryPage {
  conversations: ConversationRegistryEntry[];
  total: number;
  nextCursor: string | null;
}

export interface StatementView {
  sid: number;
  text: string;
  status: string;
  isSeed: boolean;
  agrees: number;
  disagrees: number;
  passes: number;
  createdAt: number;
}

export interface NextStatement {
  statement: { sid: number; text: string } | null;
  progress: { voted: number; total: number };
}

const MAX_STATEMENTS = 800;
const MAX_STATEMENT_LENGTH = 280;

// ---- 免費額度友善的節流參數 ----
// （Cloudflare 免費方案：每天 10 萬請求、SQLite 讀 500 萬列／寫 10 萬列。
//   投票表的統計一律走 statements 上的反正規化計數欄，不掃 votes 表。）
// 數學重算的最小間隔：隨票數放大（1 萬票 → 12 秒），上限 15 秒
const mathMinIntervalMs = (nVotes: number) => Math.min(15000, Math.max(2000, 2000 + nVotes));
// 快取超過這個年紀就做一次便宜的新鮮度探測（比對計數欄總和）
const MATH_PROBE_AGE_MS = 30000;
// revision 至多每 5 秒落盤一次（DO 存活期間靠記憶體 dirty 旗標）
const REVISION_PERSIST_INTERVAL_MS = 5000;
// 參與者 last_seen 至多每 5 分鐘寫一次
const PARTICIPANT_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const CREATE_PER_HOUR = 10;
const CREATE_PER_DAY = 50;
const REGISTRY_OBJECT_NAME = "conversation-registry";
const REGISTRY_VERSION = "1";
// registry 快照的重新整理間隔：公開列表要顯示參與人數與票數，登錄一次就凍結會失真。
const REGISTRY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;


export interface CheckSynthesisResult {
  response: SensemakingResponse;
  needsEnqueue?: {
    conversationId: string;
    sourceRevision: number;
    jobId: string;
  };
}

export interface ProcessSensemakingResult {
  ok: boolean;
  retryable?: boolean;
}

/** claim 記錄持有它的 jobId：同一任務的重複投遞（Queue at-least-once）才能被辨識為 no-op */
function parseAiClaim(raw: string | null): { claimedAt: number; jobId: string | null } | "absent" | "malformed" {
  if (!raw) return "absent";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "malformed";
    const rec = parsed as Record<string, unknown>;
    const claimedAt = rec.claimedAt;
    if (typeof claimedAt !== "number" || !Number.isFinite(claimedAt) || claimedAt <= 0) {
      return "malformed";
    }
    return { claimedAt, jobId: typeof rec.jobId === "string" ? rec.jobId : null };
  } catch {
    return "malformed";
  }
}

function aiClaimBlocksAttempt(raw: string | null, now: number): boolean {
  const claim = parseAiClaim(raw);
  if (claim === "malformed") return true;
  if (claim === "absent") return false;
  return now - claim.claimedAt < AI_ATTEMPT_WINDOW_MS;
}
/** 已為此 revision 送過 Queue 訊息（送件失敗時清除）。防止逾時任務被同一 revision 重複送件。 */
const SYNTHESIS_ENQUEUED_REVISION_KEY = "synthesis_enqueued_revision";
const MATH_CACHE_SCHEMA_VERSION = 2;

interface MathCache {
  schemaVersion: number;
  revision: number;
  publicResult: MathResult;
  pidPoints: Record<string, OpinionPoint>;
}

export class Conversation extends DurableObject<Env> {
  private migrated = false;
  /** DO 存活期間的髒旗標（有投票/審核變動、尚未重算） */
  private dirty = false;
  private lastRevisionPersistAt = 0;
  /** pid → 上次 touch 時間（省去重複的 participants 讀寫） */
  private touchCache = new Map<string, number>();

  private sql() {
    this.migrate();
    return this.ctx.storage.sql;
  }

  private migrate(): void {
    if (this.migrated) return;
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS _sql_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
    );
    const applied = new Set(
      sql
        .exec(`SELECT version FROM _sql_schema_migrations`)
        .toArray()
        .map((r) => r.version as number),
    );
    const migrations: string[][] = [
      [
        `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        `CREATE TABLE statements (
           sid INTEGER PRIMARY KEY AUTOINCREMENT,
           text TEXT NOT NULL,
           submitter_pid TEXT,
           status TEXT NOT NULL DEFAULT 'pending',
           is_seed INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL
         )`,
        `CREATE TABLE votes (
           pid TEXT NOT NULL,
           sid INTEGER NOT NULL,
           value INTEGER NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (pid, sid)
         )`,
        `CREATE TABLE participants (
           pid TEXT PRIMARY KEY,
           seq INTEGER NOT NULL,
           created_at INTEGER NOT NULL,
           last_seen INTEGER NOT NULL
         )`,
        `CREATE INDEX idx_votes_sid ON votes(sid)`,
        `CREATE INDEX idx_statements_status ON statements(status)`,
        `CREATE TABLE creation_log (ts INTEGER NOT NULL)`,
      ],
      // v2：statements 反正規化計數欄 + participantCount 計數器（省 rows read）
      [
        `ALTER TABLE statements ADD COLUMN agrees INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE statements ADD COLUMN disagrees INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE statements ADD COLUMN passes INTEGER NOT NULL DEFAULT 0`,
        `UPDATE statements SET
           agrees = (SELECT COUNT(*) FROM votes v WHERE v.sid = statements.sid AND v.value = 1),
           disagrees = (SELECT COUNT(*) FROM votes v WHERE v.sid = statements.sid AND v.value = -1),
           passes = (SELECT COUNT(*) FROM votes v WHERE v.sid = statements.sid AND v.value = 0)`,
        // SELECT 後帶 WHERE 是 SQLite 對 INSERT…SELECT…ON CONFLICT 的解析要求
        `INSERT INTO meta (key, value)
           SELECT 'participantCount', CAST(COUNT(*) AS TEXT) FROM participants WHERE 1
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ],
      // v3：全站討論索引。表存在於每個 DO，但只由 conversation-registry singleton 使用。
      [
        `CREATE TABLE conversation_registry (
           id TEXT PRIMARY KEY,
           title TEXT NOT NULL,
           description TEXT NOT NULL,
           status TEXT NOT NULL,
           allow_submissions INTEGER NOT NULL,
           auto_approve INTEGER NOT NULL,
           open_data INTEGER NOT NULL,
           alt_url TEXT NOT NULL,
           statement_count INTEGER NOT NULL,
           participant_count INTEGER NOT NULL,
           vote_count INTEGER NOT NULL,
           created_at INTEGER NOT NULL,
           indexed_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         )`,
        `CREATE INDEX idx_conversation_registry_status_created
           ON conversation_registry(status, created_at DESC, id)`,
        `CREATE INDEX idx_conversation_registry_open_data_created
           ON conversation_registry(open_data, created_at DESC, id)`,
      ],
      // v4：行為準則下架旗標。下架只影響列舉，不刪除討論本身。
      [
        `ALTER TABLE conversation_registry ADD COLUMN delisted INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE conversation_registry ADD COLUMN delisted_reason TEXT NOT NULL DEFAULT ''`,
        `ALTER TABLE conversation_registry ADD COLUMN delisted_at INTEGER NOT NULL DEFAULT 0`,
      ],
    ];
    for (let v = 1; v <= migrations.length; v++) {
      if (applied.has(v)) continue;
      // 整個版本包成一筆交易：任何一句失敗就整包回滾，不會留下半套 schema
      this.ctx.storage.transactionSync(() => {
        for (const stmt of migrations[v - 1]!) sql.exec(stmt);
        sql.exec(`INSERT INTO _sql_schema_migrations (version, applied_at) VALUES (?, ?)`, v, Date.now());
      });
    }
    this.migrated = true;
  }

  // ---- meta helpers ----

  private getMeta(key: string): string | null {
    const rows = this.sql().exec(`SELECT value FROM meta WHERE key = ?`, key).toArray();
    return rows.length > 0 ? (rows[0]!.value as string) : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql().exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private settings(): ConversationSettings | null {
    const raw = this.getMeta("settings");
    return raw ? (JSON.parse(raw) as ConversationSettings) : null;
  }

  private revision(): number {
    return Number(this.getMeta("revision") ?? "0");
  }

  /** 記憶體 dirty 旗標 + 節流的 revision 落盤（DO 重啟後靠它補救） */
  private markDirty(now: number): void {
    this.dirty = true;
    if (now - this.lastRevisionPersistAt > REVISION_PERSIST_INTERVAL_MS) {
      this.setMeta("revision", String(this.revision() + 1));
      this.lastRevisionPersistAt = now;
    }
  }

  // ---- lifecycle ----

  async initConversation(
    id: string,
    settings: ConversationSettings,
    seedStatements: string[],
    adminTokenHash: string,
    now: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.getMeta("id") !== null) return { ok: false, error: "already initialized" };
    this.setMeta("id", id);
    this.setMeta("settings", JSON.stringify(settings));
    this.setMeta("adminTokenHash", adminTokenHash);
    this.setMeta("createdAt", String(now));
    this.setMeta("revision", "0");
    this.setMeta("participantCount", "0");
    for (const text of seedStatements) {
      const trimmed = text.trim().slice(0, MAX_STATEMENT_LENGTH);
      if (!trimmed) continue;
      this.sql().exec(
        `INSERT INTO statements (text, submitter_pid, status, is_seed, created_at) VALUES (?, NULL, 'approved', 1, ?)`,
        trimmed,
        now,
      );
    }
    this.markDirty(now);
    await this.syncRegistry(true);
    return { ok: true };
  }

  async isConversation(): Promise<boolean> {
    const exists = this.getMeta("id") !== null;
    if (exists) await this.syncRegistry(false);
    return exists;
  }

  /**
   * 新討論建立時立即登錄；舊討論第一次被存取時補登。registry marker 留在各場
   * DO，避免每一票都再打一次 registry RPC。
   */
  private async syncRegistry(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force) {
      if (this.getMeta("registryVersion") !== REGISTRY_VERSION) {
        // 尚未登錄過：補登
      } else if (now - Number(this.getMeta("registrySyncedAt") ?? "0") < REGISTRY_REFRESH_INTERVAL_MS) {
        return;
      }
    }
    // 先寫時間戳再送 RPC：登錄失敗時也不會讓每個請求都重試一次跨 DO 呼叫
    this.setMeta("registrySyncedAt", String(now));
    const info = await this.publicInfo();
    if (!info) return;
    const registry = this.env.CONVERSATION.getByName(REGISTRY_OBJECT_NAME);
    await registry.registerConversation(info, now);
    this.setMeta("registryVersion", REGISTRY_VERSION);
  }

  async publicInfo(): Promise<PublicInfo | null> {
    const id = this.getMeta("id");
    const settings = this.settings();
    if (!id || !settings) return null;
    const counts = this.sql()
      .exec(
        `SELECT COUNT(*) AS n, COALESCE(SUM(agrees + disagrees + passes), 0) AS v
         FROM statements WHERE status = 'approved'`,
      )
      .one();
    return {
      id,
      title: settings.title,
      description: settings.description,
      status: settings.status,
      allowSubmissions: settings.allowSubmissions,
      autoApprove: settings.autoApprove,
      openData: settings.openData,
      altUrl: settings.altUrl ?? "",
      counts: {
        statements: Number(counts.n),
        participants: Number(this.getMeta("participantCount") ?? "0"),
        votes: Number(counts.v),
      },
      createdAt: Number(this.getMeta("createdAt") ?? "0"),
    };
  }

  private touchParticipant(pid: string, now: number): void {
    const cached = this.touchCache.get(pid);
    if (cached !== undefined && now - cached < PARTICIPANT_TOUCH_INTERVAL_MS) return;
    const rows = this.sql().exec(`SELECT last_seen FROM participants WHERE pid = ?`, pid).toArray();
    if (rows.length === 0) {
      const seq = Number(this.getMeta("participantCount") ?? "0") + 1;
      this.sql().exec(
        `INSERT INTO participants (pid, seq, created_at, last_seen) VALUES (?, ?, ?, ?)`,
        pid,
        seq,
        now,
        now,
      );
      this.setMeta("participantCount", String(seq));
    } else if (now - Number(rows[0]!.last_seen) > PARTICIPANT_TOUCH_INTERVAL_MS) {
      this.sql().exec(`UPDATE participants SET last_seen = ? WHERE pid = ?`, now, pid);
    }
    this.touchCache.set(pid, now);
  }

  // ---- participation ----

  async nextStatement(pid: string, now: number): Promise<NextStatement> {
    this.touchParticipant(pid, now);
    return this.pickNext(pid);
  }

  /** 抽下一句：只讀 statements（含反正規化票數）與該參與者自己的投票 */
  private pickNext(pid: string): NextStatement {
    const rows = this.sql()
      .exec(
        `SELECT sid, text, (agrees + disagrees + passes) AS vc
         FROM statements
         WHERE status = 'approved'
           AND sid NOT IN (SELECT sid FROM votes WHERE pid = ?)`,
        pid,
      )
      .toArray();
    const progress = this.progress(pid);
    if (rows.length === 0) return { statement: null, progress };
    // 票數較少的意見優先被抽到（加速冷啟動的資料蒐集），加權隨機
    const weights = rows.map((r) => 1 / (1 + Number(r.vc)));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = Math.random() * total;
    let picked = rows[0]!;
    for (let i = 0; i < rows.length; i++) {
      t -= weights[i]!;
      if (t <= 0) {
        picked = rows[i]!;
        break;
      }
    }
    return {
      statement: { sid: Number(picked.sid), text: String(picked.text) },
      progress,
    };
  }

  private progress(pid: string): { voted: number; total: number } {
    const row = this.sql()
      .exec(
        `SELECT
           (SELECT COUNT(*) FROM votes v JOIN statements s ON s.sid = v.sid
             WHERE v.pid = ? AND s.status = 'approved') AS voted,
           (SELECT COUNT(*) FROM statements WHERE status = 'approved') AS total`,
        pid,
      )
      .one();
    return { voted: Number(row.voted), total: Number(row.total) };
  }

  async castVote(
    pid: string,
    sid: number,
    value: VoteValue,
    now: number,
  ): Promise<
    | { ok: true; progress: { voted: number; total: number }; next: NextStatement["statement"] }
    | { ok: false; error: string }
  > {
    const settings = this.settings();
    if (!settings) return { ok: false, error: "not found" };
    if (settings.status !== "open") return { ok: false, error: "conversation closed" };
    const stmt = this.sql().exec(`SELECT status FROM statements WHERE sid = ?`, sid).toArray();
    if (stmt.length === 0 || stmt[0]!.status !== "approved") {
      return { ok: false, error: "statement not available" };
    }
    this.touchParticipant(pid, now);

    const prevRows = this.sql().exec(`SELECT value FROM votes WHERE pid = ? AND sid = ?`, pid, sid).toArray();
    const prev = prevRows.length > 0 ? (Number(prevRows[0]!.value) as VoteValue) : null;

    if (prev !== value) {
      this.sql().exec(
        `INSERT INTO votes (pid, sid, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pid, sid) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        pid,
        sid,
        value,
        now,
        now,
      );
      // 反正規化計數欄：新票 +1；改票則舊方向 -1、新方向 +1
      const delta = { agrees: 0, disagrees: 0, passes: 0 };
      const col = (v: VoteValue) => (v === 1 ? "agrees" : v === -1 ? "disagrees" : "passes");
      delta[col(value)] += 1;
      if (prev !== null) delta[col(prev)] -= 1;
      this.sql().exec(
        `UPDATE statements SET agrees = agrees + ?, disagrees = disagrees + ?, passes = passes + ? WHERE sid = ?`,
        delta.agrees,
        delta.disagrees,
        delta.passes,
        sid,
      );
      this.markDirty(now);
    }

    // 一併回傳下一句，參與流程從「抽題+投票」兩個請求減為一個
    const next = this.pickNext(pid);
    return { ok: true, progress: next.progress, next: next.statement };
  }

  async submitStatement(
    pid: string,
    text: string,
    now: number,
  ): Promise<{ ok: true; status: "approved" | "pending" } | { ok: false; error: string }> {
    const settings = this.settings();
    if (!settings) return { ok: false, error: "not found" };
    if (settings.status !== "open") return { ok: false, error: "conversation closed" };
    if (!settings.allowSubmissions) return { ok: false, error: "submissions disabled" };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "empty statement" };
    if (trimmed.length > MAX_STATEMENT_LENGTH) {
      return { ok: false, error: `statement too long (max ${MAX_STATEMENT_LENGTH})` };
    }
    const count = Number(this.sql().exec(`SELECT COUNT(*) AS n FROM statements`).one().n);
    if (count >= MAX_STATEMENTS) return { ok: false, error: "statement limit reached" };
    this.touchParticipant(pid, now);
    const status = settings.autoApprove ? "approved" : "pending";
    this.sql().exec(
      `INSERT INTO statements (text, submitter_pid, status, is_seed, created_at) VALUES (?, ?, ?, 0, ?)`,
      trimmed,
      pid,
      status,
    now,
    );
    if (status === "approved") this.markDirty(now);
    return { ok: true, status };
  }

  // ---- results ----

  /**
   * 公開 /results 與所有綜整輸入：一律為隱私安全版（k-匿名：群下限、逐格下限、互補差分），
   * 見 privacySafeMathResult。完整版只留在 mathCache。
   */
  async getResults(
    pid: string | null,
    now: number,
  ): Promise<{ result: MathResult; you: OpinionPoint | null } | null> {
    const full = this.computeResults(pid, now);
    if (!full) return null;
    return { result: privacySafeMathResult(full.result), you: full.you };
  }

  /** DO 內部完整結果，僅供 getResults 套用隱私規則；不得直接回傳客戶端或送入綜整。 */
  private computeResults(
    pid: string | null,
    now: number,
  ): { result: MathResult; you: OpinionPoint | null } | null {
    const id = this.getMeta("id");
    if (!id) return null;
    const cache = this.readMathCache();
    let fresh = cache;
    let stale = !cache || this.dirty || cache.revision !== this.revision();

    // DO 重啟後 dirty 旗標會歸零：老快取用計數欄總和做一次便宜的新鮮度探測
    if (!stale && cache && now - cache.publicResult.computedAt > MATH_PROBE_AGE_MS) {
      const liveVotes = Number(
        this.sql()
          .exec(
            `SELECT COALESCE(SUM(agrees + disagrees + passes), 0) AS v FROM statements WHERE status = 'approved'`,
          )
          .one().v,
      );
      if (liveVotes !== cache.publicResult.nVotes) stale = true;
    }

    if (stale) {
      const lastAt = Number(this.getMeta("mathComputedAt") ?? "0");
      const minInterval = mathMinIntervalMs(cache?.publicResult.nVotes ?? 0);
      if (cache && now - lastAt < minInterval) {
        fresh = cache; // 剛算過：先回稍舊的結果，避免重算風暴
      } else {
        fresh = this.recompute(id, now);
      }
    }
    return {
      result: fresh!.publicResult,
      you: pid ? (fresh!.pidPoints[pid] ?? null) : null,
    };
  }

  private readMathCache(): MathCache | null {
    const raw = this.getMeta("mathCache");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as MathCache;
      if (
        !parsed ||
        parsed.schemaVersion !== MATH_CACHE_SCHEMA_VERSION ||
        typeof parsed.revision !== "number" ||
        !parsed.publicResult ||
        !Array.isArray(parsed.publicResult.groups) ||
        parsed.publicResult.groups.some((g) => !Array.isArray(g.statementStats))
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private recompute(id: string, now: number): MathCache {
    const previousK = this.readMathCache()?.publicResult.k ?? null;
    const statementIds = this.sql()
      .exec(`SELECT sid FROM statements WHERE status = 'approved' ORDER BY sid`)
      .toArray()
      .map((r) => Number(r.sid));
    const votes: VoteRow[] = this.sql()
      .exec(
        `SELECT v.pid, v.sid, v.value FROM votes v JOIN statements s ON s.sid = v.sid
         WHERE s.status = 'approved'`,
      )
      .toArray()
      .map((r) => ({ pid: String(r.pid), sid: Number(r.sid), value: Number(r.value) as VoteValue }));
    const { publicResult, pidPoints } = computeMath({
      conversationId: id,
      votes,
      statementIds,
      computedAt: now,
      previousK: previousK && previousK >= 2 ? previousK : null,
    });
    const cache: MathCache = {
      schemaVersion: MATH_CACHE_SCHEMA_VERSION,
      revision: this.revision(),
      publicResult,
      pidPoints,
    };
    this.setMeta("mathCache", JSON.stringify(cache));
    this.setMeta("mathComputedAt", String(now));
    this.dirty = false;
    return cache;
  }

  // ---- AI Sensemaking ----

  private readReadySynthesis(): SensemakingSynthesis | null {
    const rawCache = this.getMeta("synthesis_data");
    if (!rawCache) return null;
    try {
      const cached = JSON.parse(rawCache) as SensemakingSynthesis;
      return cached.status === "ready" ? cached : null;
    } catch {
      return null;
    }
  }

  private persistDeterministicReady(
    lang: "zh" | "en",
    title: string,
    mathResult: MathResult,
    statements: { sid: number; text: string }[],
    mathRevision: number,
    now: number,
  ): SensemakingSynthesis {
    const existing = this.readReadySynthesis();
    if (existing && existing.mathRevision === mathRevision && isSynthesisPrivacyCurrent(existing)) {
      this.setMeta("synthesis_pending", "");
      return existing;
    }
    const det = generateDeterministicSensemaking({
      lang,
      title,
      mathResult,
      statements,
      mathRevision,
      now,
    });
    this.setMeta("synthesis_data", JSON.stringify(det));
    this.setMeta("synthesis_pending", "");
    this.setMeta("synthesis_failure", "");
    return det;
  }

  async checkOrStartSynthesis(conversationId: string, now: number): Promise<CheckSynthesisResult> {
    const settings = this.settings();
    if (!settings) {
      return { response: { status: "unavailable", reason: "Conversation not found" } };
    }

    const math = await this.getResults(null, now);
    if (!math) {
      return { response: { status: "unavailable", reason: "Results not available" } };
    }

    const statements = (await this.publicStatements()).statements;
    const nParticipants = math.result.nParticipantsClustered;
    const nGroups = math.result.groups.length;
    const nStatements = statements.length;

    if (nParticipants < 4 || nGroups < 2 || nStatements < 3) {
      return {
        response: {
          status: "insufficient",
          reason:
            inferSourceLanguage(settings.title, settings.description, statements) === "en"
              ? "Need at least 4 clustered participants across 2+ opinion groups to generate a multi-perspective synthesis."
              : "需要至少 4 位完成足夠投票的參與者形成 2 個以上意見群體，才能生成多方審議綜整。",
          counts: {
            participants: math.result.nParticipantsTotal,
            clustered: nParticipants,
            statements: nStatements,
            votes: math.result.nVotes,
          },
        },
      };
    }

    const currentRevision = math.result.computedAt;
    const rawCache = this.getMeta("synthesis_data");
    let cached: SensemakingSynthesis | null = null;
    if (rawCache) {
      try {
        cached = JSON.parse(rawCache) as SensemakingSynthesis;
        if (cached && cached.status === "ready") {
          // 舊版快取（含 overview/commonGround/任意主題描述等小群衍生 prose）若 mathRevision 仍匹配會無限期留存：
          // 以 isSynthesisPrivacyCurrent 判定，非當前版本直接以當前隱私安全版結果的確定性摘要取代
          if (!isSynthesisPrivacyCurrent(cached)) {
            const lang = inferSourceLanguage(settings.title, settings.description, statements);
            const det = this.persistDeterministicReady(
              lang,
              settings.title,
              math.result,
              statements,
              currentRevision,
              now,
            );
            return { response: det };
          }
          // 當前版本仍需深層隱私再驗證（keyStance、張力引用、Distinctive 主題）
          cached = dropUnreportableGroups(cached, math.result);
        }
      } catch {
        cached = null;
      }
    }

    // 1. 若已有快取
    if (cached && cached.status === "ready") {
      // 資料完全未變更：快取永遠有效且為最新 (isStale = false)
      if (cached.mathRevision === currentRevision) {
        return { response: { ...cached, isStale: false } };
      }

      // 資料有變動：未滿 24 小時前，正常走 stale，但若舊綜整引用已被審核撤銷的陳述，
      // 不應繼續公開該 prose / citations（且 citation 按鈕已無法定位），直接跳過 stale 並讓後續邏輯重建
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      if (now - cached.generatedAt < ONE_DAY_MS) {
        const currentSids = new Set(statements.map((s) => s.sid));
        const citesRejected = (() => {
          const allCited: number[] = [];
          if (Array.isArray(cached.overview?.citedStatementIds)) allCited.push(...cached.overview.citedStatementIds);
          if (Array.isArray(cached.themes)) {
            for (const th of cached.themes as { statementIds?: number[]; primaryStatementIds?: number[]; secondaryStatementIds?: number[] }[]) {
              if (Array.isArray(th.statementIds)) allCited.push(...th.statementIds);
              if (Array.isArray(th.primaryStatementIds)) allCited.push(...th.primaryStatementIds);
              if (Array.isArray(th.secondaryStatementIds)) allCited.push(...th.secondaryStatementIds);
            }
          }
          if (Array.isArray(cached.commonGround?.keyPoints)) {
            for (const kp of cached.commonGround.keyPoints as { citedStatementIds?: number[] }[]) {
              if (Array.isArray(kp.citedStatementIds)) allCited.push(...kp.citedStatementIds);
            }
          }
          if (Array.isArray(cached.groupPortraits)) {
            for (const gp of cached.groupPortraits as { citedStatementIds?: number[]; keyStances?: { sid: number }[] }[]) {
              if (Array.isArray(gp.citedStatementIds)) allCited.push(...gp.citedStatementIds);
              if (Array.isArray(gp.keyStances)) allCited.push(...gp.keyStances.map((k) => k.sid));
            }
          }
          if (Array.isArray(cached.tensions)) {
            for (const t of cached.tensions as { citedStatementIds?: number[] }[]) {
              if (Array.isArray(t.citedStatementIds)) allCited.push(...t.citedStatementIds);
            }
          }
          return allCited.some((sid) => !currentSids.has(sid));
        })();
        if (!citesRejected) {
          return { response: { ...cached, isStale: true } };
        }
        // 引用已被撤銷的內容：不回傳 stale，下方將依當前公開結果重建（不再走 24 小時寬限）
      }

      // 已滿 24 小時：可進行一次每日刷新
    }

    // 2. 檢查失敗退避（若先前失敗且未過 retryAfter，回傳 unavailable 或舊快取）
    const rawFailure = this.getMeta("synthesis_failure");
    if (rawFailure) {
      try {
        const failure = JSON.parse(rawFailure) as { failedAt: number; retryAfter: number; reason: string };
        if (now < failure.retryAfter) {
          if (cached) {
            return { response: { ...cached, isStale: true } };
          }
          return {
            response: {
              status: "unavailable",
              reason: failure.reason || "AI synthesis is temporarily unavailable.",
              retryAfter: failure.retryAfter,
            },
          };
        }
      } catch {
        this.setMeta("synthesis_failure", "");
      }
    }

    // 3. 檢查進行中任務（Pending 狀態持久化於 SQLite 防止重啟雪崩）
    const rawPending = this.getMeta("synthesis_pending");
    if (rawPending) {
      try {
        const pending = JSON.parse(rawPending) as { jobId: string; sourceRevision: number; startedAt: number };
        const PENDING_TIMEOUT_MS = 15 * 60 * 1000;
        if (now - pending.startedAt < PENDING_TIMEOUT_MS) {
          if (cached) {
            return { response: { ...cached, isStale: true, refreshPending: true } };
          }
          return {
            response: {
              status: "pending",
              jobId: pending.jobId,
              startedAt: pending.startedAt,
              retryAfterMs: 3000,
            },
          };
        }
      } catch {
        // Corrupted pending entry
      }
      this.setMeta("synthesis_pending", "");
    }

    const claimRaw = this.getMeta(SYNTHESIS_AI_CLAIM_KEY);
    if (parseAiClaim(claimRaw) === "malformed") {
      this.setMeta(SYNTHESIS_AI_CLAIM_KEY, JSON.stringify({ claimedAt: now }));
    }
    if (aiClaimBlocksAttempt(this.getMeta(SYNTHESIS_AI_CLAIM_KEY), now)) {
      if (cached && cached.status === "ready") {
        return { response: { ...cached, isStale: cached.mathRevision !== currentRevision } };
      }
      const lang = inferSourceLanguage(settings.title, settings.description, statements);
      const det = this.persistDeterministicReady(
        lang,
        settings.title,
        math.result,
        statements,
        currentRevision,
        now,
      );
      return { response: det };
    }

    // 4. 發起新生成任務——每個 revision 最多送件一次（文件承諾的 4 次 Queue 操作上限）。
    // 已送件但 15 分鐘逾時的任務（consumer 延遲、重試耗盡）不再重送：直接以確定性摘要結案。
    if (this.getMeta(SYNTHESIS_ENQUEUED_REVISION_KEY) === String(currentRevision)) {
      if (cached && cached.status === "ready" && cached.mathRevision === currentRevision) {
        return { response: cached };
      }
      const lang = inferSourceLanguage(settings.title, settings.description, statements);
      const det = this.persistDeterministicReady(
        lang,
        settings.title,
        math.result,
        statements,
        currentRevision,
        now,
      );
      return { response: det };
    }
    const jobId = crypto.randomUUID();
    this.setMeta(
      "synthesis_pending",
      JSON.stringify({ jobId, sourceRevision: currentRevision, startedAt: now }),
    );
    this.setMeta(SYNTHESIS_ENQUEUED_REVISION_KEY, String(currentRevision));

    const needsEnqueue = {
      conversationId,
      sourceRevision: currentRevision,
      jobId,
    };
    if (cached) {
      return {
        response: { ...cached, isStale: true, refreshPending: true },
        needsEnqueue,
      };
    }

    return {
      response: {
        status: "pending",
        jobId,
        startedAt: now,
        retryAfterMs: 3000,
      },
      needsEnqueue,
    };
  }

  async markSensemakingEnqueueFailed(jobId: string, now: number, reason: string): Promise<void> {
    // 送件失敗沒有消耗成功路徑的 Queue 操作：解除該 revision 的送件標記，退避後允許再送一次
    const rawPending = this.getMeta("synthesis_pending");
    if (!rawPending) return;
    try {
      const pending = JSON.parse(rawPending) as { jobId: string };
      if (pending.jobId === jobId) {
        this.setMeta(SYNTHESIS_ENQUEUED_REVISION_KEY, "");
        this.setMeta("synthesis_pending", "");
        // 短暫佇列傳輸失敗退避 30 秒（非 AI 額度鎖定）
        this.setMeta(
          "synthesis_failure",
          JSON.stringify({
            failedAt: now,
            retryAfter: now + 30000,
            reason: reason || "AI synthesis is temporarily unavailable.",
          }),
        );
      }
    } catch {
      this.setMeta("synthesis_pending", "");
    }
  }

  async processSensemakingJob(
    sourceRevision: number,
    jobId: string,
    now: number,
  ): Promise<ProcessSensemakingResult> {
    const rawPending = this.getMeta("synthesis_pending");
    if (!rawPending) {
      return { ok: true };
    }
    let pending: { jobId: string; sourceRevision: number; startedAt: number } | null = null;
    try {
      pending = JSON.parse(rawPending);
    } catch {
      this.setMeta("synthesis_pending", "");
      return { ok: true };
    }

    // 嚴格驗證 jobId 與 sourceRevision，過期或被覆蓋的任務冪等 no-op
    if (!pending || pending.jobId !== jobId || pending.sourceRevision !== sourceRevision) {
      return { ok: true };
    }

    const settings = this.settings();
    if (!settings) {
      this.setMeta("synthesis_pending", "");
      return { ok: true };
    }

    // 綜整證據與公開結果用同一份隱私安全版：模型與確定性摘要看不到任何 < k 的格子
    const math = await this.getResults(null, now);
    if (!math) {
      this.setMeta("synthesis_pending", "");
      return { ok: true };
    }

    const statements = (await this.publicStatements()).statements;
    if (
      math.result.nParticipantsClustered < 4 ||
      math.result.groups.length < 2 ||
      statements.length < 3
    ) {
      this.setMeta("synthesis_pending", "");
      return { ok: true };
    }

    const inferredLang = inferSourceLanguage(settings.title, settings.description, statements);
    const currentRev = math.result.computedAt;
    // 長時間 await 期間 updateSettings / 新 enqueue 可能清除或覆蓋 synthesis_pending：
    // 每一條持久化路徑前都重讀比對 jobId 與 sourceRevision，被取代的任務一律丟棄、不寫任何狀態。
    const stillCurrentJob = (): boolean => {
      const raw = this.getMeta("synthesis_pending");
      if (!raw) return false;
      try {
        const cur = JSON.parse(raw) as { jobId?: unknown; sourceRevision?: unknown };
        return cur.jobId === jobId && cur.sourceRevision === sourceRevision;
      } catch {
        return false;
      }
    };
    const finishDeterministic = (): ProcessSensemakingResult => {
      if (!stillCurrentJob()) return { ok: true };
      this.persistDeterministicReady(
        inferredLang,
        settings.title,
        math.result,
        statements,
        currentRev,
        now,
      );
      return { ok: true };
    };

    const claimRaw = this.getMeta(SYNTHESIS_AI_CLAIM_KEY);
    const claim = parseAiClaim(claimRaw);
    if (claim === "malformed") {
      this.setMeta(SYNTHESIS_AI_CLAIM_KEY, JSON.stringify({ claimedAt: now, jobId }));
      return finishDeterministic();
    }
    if (aiClaimBlocksAttempt(claimRaw, now)) {
      // Queue 是 at-least-once：同一 jobId 的重複投遞在第一個呼叫仍 await 模型時進來，
      // claim 就是它自己寫的。此時什麼都不做（不寫 fallback、不清 pending），讓原呼叫完成。
      if (claim !== "absent" && claim.jobId === jobId) {
        return { ok: true };
      }
      return finishDeterministic();
    }

    const coordinatorNs = this.env.NEURON_COORDINATOR;
    if (!this.env.AI || !coordinatorNs) {
      return finishDeterministic();
    }

    this.setMeta(SYNTHESIS_AI_CLAIM_KEY, JSON.stringify({ claimedAt: now, jobId }));

    try {
      const response = await generateSensemaking({
        ai: this.env.AI,
        reserveGlobal: async (neurons: number) => {
          try {
            return await coordinatorNs.getByName(NEURON_COORDINATOR_INSTANCE).reserve(neurons);
          } catch {
            return false;
          }
        },
        lang: inferredLang,

        title: settings.title,
        description: settings.description,
        mathResult: math.result,
        statements,
        mathRevision: currentRev,
        now,
      });

      if (!stillCurrentJob()) {
        // 任務已被取代（設定變更或新 revision）：捨棄結果，交由目前的 pending 任務處理
        return { ok: true };
      }

      if (response.status === "ready") {
        this.setMeta("synthesis_data", JSON.stringify(response));
        this.setMeta("synthesis_pending", "");
        this.setMeta("synthesis_failure", "");
        return { ok: true };
      }

      if (response.status === "insufficient") {
        this.setMeta("synthesis_pending", "");
        return { ok: true };
      }
      console.error("AI synthesis unavailable:", response.status === "unavailable" ? response.reason : response);
      return finishDeterministic();
    } catch (error) {
      console.error("AI synthesis job error:", error);
      return finishDeterministic();
    }
  }

  // ---- admin ----

  private async verifyAdmin(token: string): Promise<boolean> {
    const expected = this.getMeta("adminTokenHash");
    if (!expected || !token) return false;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  }

  /** 只讀 statements（計數欄反正規化，不掃 votes） */
  private listStatements(includeAll: boolean): StatementView[] {
    const where = includeAll ? "" : `WHERE status = 'approved'`;
    return this.sql()
      .exec(
        `SELECT sid, text, status, is_seed, created_at, agrees, disagrees, passes
         FROM statements ${where} ORDER BY sid`,
      )
      .toArray()
      .map((r) => ({
        sid: Number(r.sid),
        text: String(r.text),
        status: String(r.status),
        isSeed: Number(r.is_seed) === 1,
        agrees: Number(r.agrees),
        disagrees: Number(r.disagrees),
        passes: Number(r.passes),
        createdAt: Number(r.created_at),
      }));
  }

  /** 結果頁用：已核准意見的文字（不含統計，統計在 math result 裡） */
  async publicStatements(): Promise<{ statements: { sid: number; text: string }[] }> {
    const rows = this.sql()
      .exec(`SELECT sid, text FROM statements WHERE status = 'approved' ORDER BY sid`)
      .toArray();
    return { statements: rows.map((r) => ({ sid: Number(r.sid), text: String(r.text) })) };
  }

  async adminOverview(
    token: string,
    trusted = false,
  ): Promise<{ settings: ConversationSettings; statements: StatementView[] } | { error: string }> {
    if (!trusted && !(await this.verifyAdmin(token))) return { error: "unauthorized" };
    return { settings: this.settings()!, statements: this.listStatements(true) };
  }

  async moderateStatement(
    token: string,
    sid: number,
    action: "approve" | "reject",
    trusted = false,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!trusted && !(await this.verifyAdmin(token))) return { ok: false, error: "unauthorized" };
    const rows = this.sql().exec(`SELECT status FROM statements WHERE sid = ?`, sid).toArray();
    if (rows.length === 0) return { ok: false, error: "not found" };
    const prevStatus = (rows[0] as { status: string }).status;
    const status = action === "approve" ? "approved" : "rejected";
    if (prevStatus === status) return { ok: true };
    this.sql().exec(`UPDATE statements SET status = ? WHERE sid = ?`, status, sid);
    this.markDirty(Date.now());
    // 審核狀態變更會立即影響 publicStatements()，但舊綜整的 prose / citations 仍可能引用已撤銷內容：
    // 不應走 24 小時 stale 快取，直接失效並讓下次 GET 依當前公開結果重建（確定性或重送）。
    const now = Date.now();
    void now; // 僅為語意，實際失效不依賴 now
    this.setMeta("synthesis_data", "");
    this.setMeta("synthesis_pending", "");
    this.setMeta("synthesis_failure", "");
    this.setMeta(SYNTHESIS_ENQUEUED_REVISION_KEY, "");
    return { ok: true };
  }

  async addSeedStatement(
    token: string,
    text: string,
    now: number,
    trusted = false,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!trusted && !(await this.verifyAdmin(token))) return { ok: false, error: "unauthorized" };
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_STATEMENT_LENGTH) {
      return { ok: false, error: "invalid statement" };
    }
    this.sql().exec(
      `INSERT INTO statements (text, submitter_pid, status, is_seed, created_at) VALUES (?, NULL, 'approved', 1, ?)`,
      trimmed,
      now,
    );
    this.markDirty(now);
    // 新增公開陳述同樣影響 synthesis citations / 主題，應立即失效而非走 24 小時 stale
    this.setMeta("synthesis_data", "");
    this.setMeta("synthesis_pending", "");
    this.setMeta("synthesis_failure", "");
    this.setMeta(SYNTHESIS_ENQUEUED_REVISION_KEY, "");
    return { ok: true };
  }

  async updateSettings(
    token: string,
    patch: Partial<ConversationSettings>,
    trusted = false,
  ): Promise<{ ok: true; settings: ConversationSettings } | { ok: false; error: string }> {
    if (!trusted && !(await this.verifyAdmin(token))) return { ok: false, error: "unauthorized" };
    const current = this.settings()!;
    const next: ConversationSettings = {
      title: typeof patch.title === "string" && patch.title.trim() ? patch.title.trim().slice(0, 120) : current.title,
      description:
        typeof patch.description === "string" ? patch.description.trim().slice(0, 2000) : current.description,
      autoApprove: typeof patch.autoApprove === "boolean" ? patch.autoApprove : current.autoApprove,
      allowSubmissions:
        typeof patch.allowSubmissions === "boolean" ? patch.allowSubmissions : current.allowSubmissions,
      openData: typeof patch.openData === "boolean" ? patch.openData : current.openData,
      status: patch.status === "open" || patch.status === "closed" ? patch.status : current.status,
      altUrl: typeof patch.altUrl === "string" ? sanitizeAltUrl(patch.altUrl) : current.altUrl,
    };
    this.setMeta("settings", JSON.stringify(next));
    // 只有影響綜整內容的欄位（標題、說明）實際變更才失效綜整；
    // openData / status / allowSubmissions 等營運開關不得清掉有效報告（24h claim 仍在，清掉只會換成統計摘要）
    if (next.title !== current.title || next.description !== current.description) {
      this.setMeta("synthesis_failure", "");
      this.setMeta("synthesis_data", "");
      this.setMeta("synthesis_pending", "");
      // 讓新修訂的快照可被重新送件（否則舊的 enqueued_revision 會使下一次 GET 直接以確定性摘要結案）
      this.setMeta(SYNTHESIS_ENQUEUED_REVISION_KEY, "");
    }
    await this.syncRegistry(true);
    return { ok: true, settings: next };
  }
  // ---- data export ----

  private async canExport(token: string | null, trusted = false): Promise<boolean> {
    if (trusted) return true;
    const settings = this.settings();
    if (!settings) return false;
    if (settings.openData) return true;
    return token !== null && (await this.verifyAdmin(token));
  }

  async exportStatementsCsv(token: string | null, trusted = false): Promise<string | null> {
    if (!(await this.canExport(token, trusted))) return null;
    const rows = this.listStatements(true);
    const header = "statement_id,text,status,is_seed,agrees,disagrees,passes,created_at";
    const lines = rows.map((r) =>
      [r.sid, csvEscape(r.text), r.status, r.isSeed ? 1 : 0, r.agrees, r.disagrees, r.passes, new Date(r.createdAt).toISOString()].join(","),
    );
    return [header, ...lines].join("\n") + "\n";
  }

  /**
   * pol.is 相容的 comments.csv（issue #1，供 Sensemaker 等工具直接讀取）。
   * author-id 用參與者加入順序流水號（同 votes.csv 的 p1、p2⋯ 去掉前綴），種子意見（主持人建立）為 0；
   * 含全部審核狀態，以 moderated 欄區分（1 / 0 / -1），與 statements.csv 一致。
   */
  async exportCommentsCsv(token: string | null, trusted = false): Promise<string | null> {
    if (!(await this.canExport(token, trusted))) return null;
    const rows = this.sql()
      .exec(
        `SELECT s.sid, s.text, s.status, s.created_at, s.agrees, s.disagrees, COALESCE(p.seq, 0) AS author
         FROM statements s LEFT JOIN participants p ON p.pid = s.submitter_pid
         ORDER BY s.sid`,
      )
      .toArray()
      .map((r) => ({
        sid: Number(r.sid),
        text: String(r.text),
        status: String(r.status),
        authorId: Number(r.author),
        agrees: Number(r.agrees),
        disagrees: Number(r.disagrees),
        createdAt: Number(r.created_at),
      }));
    return formatCommentsCsv(rows);
  }

  /** 長格式投票匯出。參與者以加入順序匿名化為 p1、p2⋯，不輸出 pid。 */
  async exportVotesCsv(token: string | null, trusted = false): Promise<string | null> {
    if (!(await this.canExport(token, trusted))) return null;
    const rows = this.sql()
      .exec(
        `SELECT p.seq, v.sid, v.value, v.updated_at FROM votes v
         JOIN participants p ON p.pid = v.pid
         ORDER BY p.seq, v.sid`,
      )
      .toArray();
    const header = "participant,statement_id,vote,updated_at";
    const lines = rows.map((r) =>
      [`p${Number(r.seq)}`, Number(r.sid), Number(r.value), new Date(Number(r.updated_at)).toISOString()].join(","),
    );
    return [header, ...lines].join("\n") + "\n";
  }

  // ---- 全站建立頻率限制（singleton DO，getByName("creation-limiter")） ----

  async reserveCreation(now: number): Promise<{ ok: boolean; error?: string }> {
    const hourAgo = now - 60 * 60 * 1000;
    const dayAgo = now - 24 * 60 * 60 * 1000;
    this.sql().exec(`DELETE FROM creation_log WHERE ts < ?`, dayAgo);
    const lastHour = Number(
      this.sql().exec(`SELECT COUNT(*) AS n FROM creation_log WHERE ts >= ?`, hourAgo).one().n,
    );
    const lastDay = Number(this.sql().exec(`SELECT COUNT(*) AS n FROM creation_log`).one().n);
    if (lastHour >= CREATE_PER_HOUR || lastDay >= CREATE_PER_DAY) {
      return { ok: false, error: "creation rate limit reached, try again later" };
    }
    this.sql().exec(`INSERT INTO creation_log (ts) VALUES (?)`, now);
    return { ok: true };
  }

  // ---- 全站討論 registry（只在 getByName("conversation-registry") 上使用） ----

  async registerConversation(info: PublicInfo, now: number): Promise<void> {
    this.sql().exec(
      `INSERT INTO conversation_registry (
         id, title, description, status, allow_submissions, auto_approve, open_data, alt_url,
         statement_count, participant_count, vote_count, created_at, indexed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         status = excluded.status,
         allow_submissions = excluded.allow_submissions,
         auto_approve = excluded.auto_approve,
         open_data = excluded.open_data,
         alt_url = excluded.alt_url,
         statement_count = excluded.statement_count,
         participant_count = excluded.participant_count,
         vote_count = excluded.vote_count,
         updated_at = excluded.updated_at`,
      info.id,
      info.title,
      info.description,
      info.status,
      info.allowSubmissions ? 1 : 0,
      info.autoApprove ? 1 : 0,
      info.openData ? 1 : 0,
      info.altUrl,
      info.counts.statements,
      info.counts.participants,
      info.counts.votes,
      info.createdAt,
      now,
      now,
    );
  }

  async listRegisteredConversations(options: {
    status?: "open" | "closed";
    includePrivate: boolean;
    /** 只有全域管理者會看到已下架的討論；公開列表一律排除。 */
    includeDelisted?: boolean;
    query?: string;
    limit: number;
    cursor?: string;
  }): Promise<ConversationRegistryPage> {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
    const offset = parseRegistryCursor(options.cursor);
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (!options.includePrivate) conditions.push("open_data = 1");
    if (!options.includeDelisted) conditions.push("delisted = 0");
    const query = options.query?.trim().slice(0, 120);
    if (query) {
      conditions.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(query)}%`;
      params.push(pattern, pattern);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = Number(
      this.sql()
        .exec(`SELECT COUNT(*) AS n FROM conversation_registry ${where}`, ...params)
        .one().n,
    );
    const rows = this.sql()
      .exec(
        `SELECT * FROM conversation_registry ${where}
         ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      )
      .toArray();
    const conversations = rows.map(registryRowToEntry);
    const nextOffset = offset + conversations.length;
    return {
      conversations,
      total,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * 行為準則下架：把討論移出公開列表。討論本身與原網址不受影響——刪資料是另一件事，
   * 這裡只撤回「站方替它公開曝光」。之後的 registerConversation 不會把它重新掛回去。
   */
  async setConversationListing(
    id: string,
    delisted: boolean,
    reason: string,
    now: number,
  ): Promise<{ ok: true; delisted: boolean } | { ok: false; error: string }> {
    const rows = this.sql().exec(`SELECT id FROM conversation_registry WHERE id = ?`, id).toArray();
    if (rows.length === 0) return { ok: false, error: "conversation is not in the registry" };
    this.sql().exec(
      `UPDATE conversation_registry
         SET delisted = ?, delisted_reason = ?, delisted_at = ?, updated_at = ?
       WHERE id = ?`,
      delisted ? 1 : 0,
      delisted ? reason.trim().slice(0, 300) : "",
      delisted ? now : 0,
      now,
      id,
    );
    return { ok: true, delisted };
  }

  /** 已知官方 demo 在第一次列舉時補進 registry；不存在時安靜略過。 */
  async bootstrapKnownConversations(ids: string[]): Promise<void> {
    if (this.getMeta("knownRegistryBootstrap") === REGISTRY_VERSION) return;
    for (const id of ids) {
      const info = await this.env.CONVERSATION.getByName(`conv:${id}`).publicInfo();
      if (info) await this.registerConversation(info, Date.now());
    }
    this.setMeta("knownRegistryBootstrap", REGISTRY_VERSION);
  }
}

/** 只接受 https:// 或站內相對路徑，其餘視為清空 */
function sanitizeAltUrl(raw: string): string {
  const trimmed = raw.trim().slice(0, 300);
  if (/^https:\/\/\S+$/.test(trimmed) || /^\/\S*$/.test(trimmed)) return trimmed;
  return "";
}

function parseRegistryCursor(cursor: string | undefined): number {
  if (!cursor || !/^\d+$/.test(cursor)) return 0;
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function registryRowToEntry(row: Record<string, SqlStorageValue>): ConversationRegistryEntry {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    status: String(row.status) as "open" | "closed",
    allowSubmissions: Number(row.allow_submissions) === 1,
    autoApprove: Number(row.auto_approve) === 1,
    openData: Number(row.open_data) === 1,
    altUrl: String(row.alt_url),
    counts: {
      statements: Number(row.statement_count),
      participants: Number(row.participant_count),
      votes: Number(row.vote_count),
    },
    createdAt: Number(row.created_at),
    indexedAt: Number(row.indexed_at),
    updatedAt: Number(row.updated_at),
    delisted: Number(row.delisted ?? 0) === 1,
    delistedReason: String(row.delisted_reason ?? ""),
  };
}
