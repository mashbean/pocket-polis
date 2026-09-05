import { describe, expect, it } from "vitest";
import {
  csvEscape,
  csvQuote,
  formatCommentsCsv,
  moderatedFlag,
  POLIS_COMMENTS_HEADER,
  polisDatetime,
  formatTttcCsv,
  TTTC_HEADER,
} from "../src/export";

describe("Talk to the City tttc.csv", () => {
  it("uses the tttc-light-js three-column contract and marks sources as host or pN", () => {
    expect(TTTC_HEADER).toBe("id,interview,comment");
    expect(formatTttcCsv([])).toBe("id,interview,comment\n");
    const csv = formatTttcCsv([
      { sid: 1, text: "種子意見", isSeed: true, authorId: 0 },
      { sid: 5, text: '他說 "好"，然後走了', isSeed: false, authorId: 3 },
    ]);
    expect(csv).toBe('id,interview,comment\nstatement-1,host,"種子意見"\nstatement-5,p3,"他說 ""好""，然後走了"\n');
  });
});

// pol.is 相容的 comments.csv（issue #1）。黃金樣本取自 issue 的偽資料，
// 但引號規則以 pol.is 報告頁實際匯出的檔案為準：datetime 不加引號、comment-body 一律加引號。
describe("polis comments.csv", () => {
  it("header 與 pol.is 報告頁匯出的完全一致", () => {
    expect(POLIS_COMMENTS_HEADER).toBe(
      "timestamp,datetime,comment-id,author-id,agrees,disagrees,moderated,comment-body",
    );
    expect(formatCommentsCsv([])).toBe(POLIS_COMMENTS_HEADER + "\n");
  });

  it("issue #1 的範例資料逐位元組相符（LF 換行、無 BOM、結尾換行）", () => {
    const csv = formatCommentsCsv([
      { sid: 0, text: "我認為公共政策應該提供更多讓民眾參與討論的機會。", status: "approved", authorId: 0, agrees: 12, disagrees: 3, createdAt: 1760000000000 },
      { sid: 1, text: "線上討論之外，也應保留實體參與的方式。", status: "approved", authorId: 4, agrees: 8, disagrees: 7, createdAt: 1760000060000 },
      { sid: 2, text: "如果能定期公開討論結果，會更容易建立參與者的信任。", status: "pending", authorId: 7, agrees: 15, disagrees: 2, createdAt: 1760000120000 },
    ]);
    expect(csv).toBe(
      "timestamp,datetime,comment-id,author-id,agrees,disagrees,moderated,comment-body\n" +
        '1760000000,Thu Oct 09 2025 08:53:20 GMT+0000 (Coordinated Universal Time),0,0,12,3,1,"我認為公共政策應該提供更多讓民眾參與討論的機會。"\n' +
        '1760000060,Thu Oct 09 2025 08:54:20 GMT+0000 (Coordinated Universal Time),1,4,8,7,1,"線上討論之外，也應保留實體參與的方式。"\n' +
        '1760000120,Thu Oct 09 2025 08:55:20 GMT+0000 (Coordinated Universal Time),2,7,15,2,0,"如果能定期公開討論結果，會更容易建立參與者的信任。"\n',
    );
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv).not.toContain("\r");
  });

  it("moderated：approved → 1、pending → 0、rejected → -1", () => {
    expect(moderatedFlag("approved")).toBe(1);
    expect(moderatedFlag("pending")).toBe(0);
    expect(moderatedFlag("rejected")).toBe(-1);
    const csv = formatCommentsCsv([
      { sid: 5, text: "x", status: "rejected", authorId: 3, agrees: 0, disagrees: 0, createdAt: 0 },
    ]);
    expect(csv).toContain(',5,3,0,0,-1,"x"\n');
  });

  it("comment-body 含逗號、雙引號、換行時正確跳脫", () => {
    const text = '他說："同意，\n但有條件"';
    expect(csvQuote(text)).toBe('"他說：""同意，\n但有條件"""');
    const csv = formatCommentsCsv([
      { sid: 9, text, status: "approved", authorId: 1, agrees: 1, disagrees: 0, createdAt: 1760000000000 },
    ]);
    expect(csv.endsWith(',9,1,1,0,1,"他說：""同意，\n但有條件"""\n')).toBe(true);
  });

  it("datetime 用 UTC、零補位、英文星期／月份；timestamp 是秒（無條件捨去）", () => {
    const ms = Date.UTC(2026, 0, 5, 3, 4, 5) + 999;
    expect(polisDatetime(ms)).toBe("Mon Jan 05 2026 03:04:05 GMT+0000 (Coordinated Universal Time)");
    const csv = formatCommentsCsv([
      { sid: 1, text: "t", status: "approved", authorId: 0, agrees: 0, disagrees: 0, createdAt: ms },
    ]);
    expect(csv.split("\n")[1]!.startsWith(`${Math.floor(ms / 1000)},Mon Jan 05 2026 03:04:05 GMT+0000`)).toBe(true);
  });

  it("csvEscape（既有 statements.csv 用）只在需要時加引號", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"');
  });
});
