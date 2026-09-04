import { describe, expect, it } from "vitest";
import { directoryCacheKeySuffix, parseDirectoryQuery } from "../src/service";

const parse = (query: string) => parseDirectoryQuery(new URLSearchParams(query));

describe("公開議題列表的查詢參數", () => {
  it("空查詢給安全的預設值", () => {
    expect(parse("")).toEqual({ status: "all", query: "", limit: 24, cursor: undefined });
  });

  it("接受 status、q、limit 與 cursor", () => {
    expect(parse("status=open&q=%E4%BA%A4%E9%80%9A&limit=10&cursor=48")).toEqual({
      status: "open",
      query: "交通",
      limit: 10,
      cursor: "48",
    });
  });

  it("壞參數退回預設，而不是回報錯誤", () => {
    // 這個端點會被人手貼網址，一個 typo 不該讓整頁掛掉
    expect(parse("status=deleted").status).toBe("all");
    expect(parse("limit=0").limit).toBe(24);
    expect(parse("limit=-5").limit).toBe(24);
    expect(parse("limit=abc").limit).toBe(24);
    expect(parse("cursor=%27%20OR%201%3D1").cursor).toBeUndefined();
    expect(parse("cursor=-1").cursor).toBeUndefined();
  });

  it("limit 有上限，避免一次拉走整份 registry", () => {
    expect(parse("limit=500").limit).toBe(50);
  });

  it("查詢字串截斷在 120 字元", () => {
    expect(parse(`q=${"a".repeat(200)}`).query).toHaveLength(120);
  });
});

describe("議題列表的邊緣快取鍵值", () => {
  it("不同查詢條件不共用快取", () => {
    expect(directoryCacheKeySuffix(parse("status=open"))).not.toBe(
      directoryCacheKeySuffix(parse("status=closed")),
    );
    expect(directoryCacheKeySuffix(parse("cursor=24"))).not.toBe(
      directoryCacheKeySuffix(parse("")),
    );
  });

  it("參數順序與雜訊參數不會讓快取分裂", () => {
    expect(directoryCacheKeySuffix(parse("limit=10&status=open"))).toBe(
      directoryCacheKeySuffix(parse("status=open&utm_source=x&limit=10")),
    );
  });

  it("空白查詢與沒有查詢視為同一份快取", () => {
    expect(directoryCacheKeySuffix(parse("q=%20%20"))).toBe(directoryCacheKeySuffix(parse("")));
  });
});
