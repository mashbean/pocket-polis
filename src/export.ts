// pol.is 相容的 comments.csv（issue #1）：讓 vTaiwan Sensemaker 等吃 pol.is 匯出檔的工具不必轉檔就能讀。
// 格式以 pol.is 報告頁實際匯出的檔案為準（非 issue 內的偽範例）：
//   - header：timestamp,datetime,comment-id,author-id,agrees,disagrees,moderated,comment-body
//   - datetime 不加引號；comment-body 一律加引號（內部雙引號寫成 ""）
//   - UTF-8、LF 換行、無 BOM（BOM 會讓嚴格比對 header 的工具認不出第一欄）

export interface CommentRow {
  sid: number;
  text: string;
  /** 'approved' | 'pending' | 'rejected' */
  status: string;
  /** 參與者加入順序流水號；種子意見（主持人建立）為 0 */
  authorId: number;
  agrees: number;
  disagrees: number;
  /** 毫秒 */
  createdAt: number;
}

export const POLIS_COMMENTS_HEADER =
  "timestamp,datetime,comment-id,author-id,agrees,disagrees,moderated,comment-body";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * 與 Node 在 TZ=UTC 下的 Date#toString() 同形（pol.is 就是這樣產生的），
 * 但自己拼字串：執行環境的時區名稱會本地化（例如「世界標準時間」），不能直接用 toString()。
 */
export function polisDatetime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ` +
    "GMT+0000 (Coordinated Universal Time)"
  );
}

/** pol.is 的 moderated 欄：1 = 已核准、0 = 未審、-1 = 已拒絕 */
export function moderatedFlag(status: string): 1 | 0 | -1 {
  if (status === "approved") return 1;
  if (status === "rejected") return -1;
  return 0;
}

export function formatCommentsCsv(rows: CommentRow[]): string {
  const lines = rows.map((r) =>
    [
      Math.floor(r.createdAt / 1000),
      polisDatetime(r.createdAt),
      r.sid,
      r.authorId,
      r.agrees,
      r.disagrees,
      moderatedFlag(r.status),
      csvQuote(r.text),
    ].join(","),
  );
  return [POLIS_COMMENTS_HEADER, ...lines].join("\n") + "\n";
}

export const TTTC_HEADER = "id,interview,comment";

export type TttcRow = { sid: number; text: string; isSeed: boolean; authorId: number };

/**
 * Talk to the City（tttc-light-js）的匯入格式：id,interview,comment。
 * 只含已核准意見；interview 用來標記來源：種子意見為 host，參與者投稿沿用 votes.csv 的 pN 匿名代號，
 * 讓 TTTC 的歸因與投票資料對得起來。comment 一律加引號。
 */
export function formatTttcCsv(rows: TttcRow[]): string {
  const lines = rows.map((r) =>
    [`statement-${r.sid}`, r.isSeed || r.authorId === 0 ? "host" : `p${r.authorId}`, csvQuote(r.text)].join(","),
  );
  return [TTTC_HEADER, ...lines].join("\n") + "\n";
}

/** 一律加引號（pol.is comment-body 的寫法） */
export function csvQuote(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/** 有需要才加引號（既有 statements.csv 的寫法） */
export function csvEscape(text: string): string {
  if (/[",\n\r]/.test(text)) return csvQuote(text);
  return text;
}
