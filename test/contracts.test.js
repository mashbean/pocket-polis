// 部署契約測試（沿用 call-in / delib 的慣例）：
// 把 wrangler.jsonc、package.json 與 README 的關鍵承諾寫成斷言，防止漂移。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accessibleTextColor, el, statementRowAttrs } from "../public/js/common.js";
import { resolveQueueName } from "../scripts/ensure-queue.mjs";
import { STRINGS } from "../public/js/i18n.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const stripJsonc = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

const wrangler = JSON.parse(stripJsonc(read("wrangler.jsonc")));
const pkg = JSON.parse(read("package.json"));
const readme = read("README.md");

describe("wrangler.jsonc", () => {
  it("worker 名稱與進入點", () => {
    expect(wrangler.name).toBe("polis-serverless");
    expect(wrangler.env.production.name).toBe(wrangler.name);
    expect(wrangler.main).toBe("src/index.ts");
  });

  it("靜態資產 binding 與 run_worker_first 路徑", () => {
    expect(wrangler.assets.directory).toBe("./public");
    expect(wrangler.assets.binding).toBe("ASSETS");
    for (const path of ["/", "/api/*", "/mcp", "/c/*", "/r/*", "/a/*", "/en", "/en/*", "/guide"]) {
      expect(wrangler.assets.run_worker_first).toContain(path);
    }
  });

  it("Durable Object 是唯一資料層，SQLite migration 存在", () => {
    expect(wrangler.durable_objects.bindings).toEqual([
      { name: "CONVERSATION", class_name: "Conversation" },
      { name: "NEURON_COORDINATOR", class_name: "NeuronCoordinator" },
    ]);
    expect(wrangler.env.production.durable_objects.bindings).toEqual([
      { name: "CONVERSATION", class_name: "Conversation" },
      { name: "NEURON_COORDINATOR", class_name: "NeuronCoordinator" },
    ]);
    expect(wrangler.migrations[0].new_sqlite_classes).toContain("Conversation");
    expect(wrangler.migrations[1].new_sqlite_classes).toContain("NeuronCoordinator");
    expect(wrangler.kv_namespaces).toBeUndefined();
    expect(wrangler.d1_databases).toBeUndefined();
    expect(wrangler.r2_buckets).toBeUndefined();
    const conversation = read("src/conversation.ts");
    expect(conversation).toContain("CREATE TABLE conversation_registry");
    expect(conversation).toContain("registryVersion");
  });

  it("Workers AI 與 Queues binding 頂層與 production 均存在且相容日為 2026-09-01", () => {
    expect(wrangler.compatibility_date).toBe("2026-09-01");
    expect(wrangler.ai).toEqual({ binding: "AI" });
    expect(wrangler.env.production.ai).toEqual({ binding: "AI" });
    expect(wrangler.queues.producers[0].binding).toBe("SENSEMAKING_QUEUE");
    expect(wrangler.queues.consumers[0].queue).toBe("pocket-polis-sensemaking");
    expect(wrangler.queues.consumers[0].max_retries).toBe(1);
    expect(wrangler.env.production.queues.producers[0].binding).toBe("SENSEMAKING_QUEUE");
    // 自訂網域部署必須沿用同一個 Worker/Queue，否則會切到空白 Durable Object namespace。
    expect(wrangler.env.production.queues.producers[0].queue).toBe("pocket-polis-sensemaking");
    expect(wrangler.env.production.queues.consumers[0].queue).toBe(wrangler.queues.consumers[0].queue);
    expect(wrangler.env.production.queues.consumers[0].max_retries).toBe(1);
    expect(wrangler.env.production.routes).toEqual([
      { pattern: "polis.mashbean.net", custom_domain: true },
    ]);
  });
});

describe("package.json", () => {
  it("MCP runtime 依賴使用官方 server v2 與 Cloudflare handler", () => {
    expect(pkg.dependencies).toMatchObject({
      "@modelcontextprotocol/server": expect.any(String),
      agents: expect.any(String),
      zod: expect.any(String),
    });
  });

  it("CLI bin 指向 install-skill 腳本", () => {
    expect(pkg.bin["pocket-polis"]).toBe("./scripts/cli.mjs");
  });

  it("check 腳本涵蓋 typecheck、測試與 dry-run 部署", () => {
    expect(pkg.scripts.deploy).toContain("wrangler deploy");
    expect(pkg.scripts.deploy).toContain("ensure-queue.mjs");
    expect(pkg.scripts["deploy:production"]).toContain("ensure-queue.mjs production");
    expect(pkg.scripts.check).toContain("typecheck");
    expect(pkg.scripts.check).toContain("test");
    expect(pkg.scripts.check).toContain("deploy:dry");
    expect(pkg.scripts["mcp:backfill"]).toContain("backfill-mcp-registry.mjs");
  });
});

describe("MCP", () => {
  it("使用 stateless Streamable HTTP handler，並完整註冊討論操作工具", () => {
    const source = read("src/mcp.ts");
    expect(read("src/index.ts")).toContain('from "agents/mcp/server"');
    expect(source).toContain('new ResourceTemplate("pocket-polis://conversations/{conversationId}"');
    expect(source).toContain('"analyze_deliberation"');
    for (const tool of [
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
      "backfill_conversation_registry",
    ]) {
      expect(source).toContain(`"${tool}"`);
    }
  });
});

describe("README", () => {
  it("Deploy Button 指向本 repo", () => {
    expect(readme).toContain(
      "https://deploy.workers.cloudflare.com/?url=https://github.com/mashbean/pocket-polis",
    );
  });

  it("聲明非官方 pol.is", () => {
    expect(readme).toMatch(/不是官方|非官方|not affiliated/i);
  });

  it("指向線上展示站與 AGENT.md", () => {
    expect(readme).toContain("https://polis.mashbean.net");
    expect(readme).toContain("AGENT.md");
  });

  it("宣告 pol.is 相容的 comments.csv 匯出（issue #1）", () => {
    expect(readme).toContain("comments.csv");
    expect(read("AGENT.md")).toContain("export/{comments,votes,statements}.csv");
    expect(read("public/report.html")).toContain('id="export-comments"');
  });

  it("文件化神經元硬上限與 Queue 分計", () => {
    expect(readme).toContain("9,000");
    expect(readme).toContain("UTF-8");
    expect(readme).toMatch(/not JS `string\.length`/);
    expect(readme).not.toMatch(/160k char/);
    expect(readme).toContain("4 Queue operations");
    expect(readme).toMatch(/not neuron savings/);
    expect(readme).toMatch(/deployment-wide|app-wide/);
    expect(readme).toContain("rolling 24h");
    expect(readme).not.toMatch(/account-global|entire Cloudflare account/);
  });
});

describe("品牌與公開版要求", () => {
  it("landing 有一鍵發起與署名，且不再有 Deploy Button", () => {
    const zh = read("public/index.html");
    expect(zh).toContain("一鍵發起");
    expect(zh).toContain("Created and maintained by");
    expect(zh).not.toContain("deploy.workers.cloudflare.com/button");
  });

  it("行為準則存在且含下架規範", () => {
    const coc = read("CODE_OF_CONDUCT.md");
    expect(coc).toContain("mashbean");
    expect(coc).toMatch(/下架|take down/);
  });

  it("品牌名稱中英並列（中文頁）", () => {
    const zh = read("public/index.html");
    expect(zh).toContain("Pocket Polis");
    expect(zh).toContain("口袋審議");
    expect(zh).toContain("A pocket tool for deliberation, anytime");
  });

  it("發起頁以一句話揭露預設，進階審核與資料設定按需展開", () => {
    for (const page of ["public/index.html", "public/en.html"]) {
      const html = read(page);
      expect(html).toContain('class="plain-box form-advanced"');
      expect(html).toContain('id="auto-approve" checked');
      expect(html).toContain('id="allow-submissions" checked');
      expect(html).toContain('id="open-data"');
    }
    expect(read("public/index.html")).toContain("預設：參與者可新增意見並立即公開；匿名資料不開放下載。");
    expect(read("public/en.html")).toContain("Default: participants can add statements and publish them immediately; anonymized data stays private.");
  });
});

describe("漸進揭露資訊架構", () => {
  it("結果頁先呈現摘要與地圖，再按需展開深入分析、完整意見與資料工具", () => {
    const html = read("public/report.html");
    const positions = ["ai-section", "map-section", "deep-analysis", "all-statements-section", "export-section"]
      .map((id) => html.indexOf(`id="${id}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toMatch(/<details class="report-disclosure" id="deep-analysis">/);
    expect(html).toMatch(/<details class="report-disclosure hidden" id="export-section">/);
    expect(html).toContain('class="theme-filter-panel hidden" id="themes-section"');
  });

  it("管理頁把日常狀態與審核留在主流程，進階設定、完整清單與整合收合", () => {
    const html = read("public/admin.html");
    expect(html.indexOf('id="setting-status"')).toBeLessThan(html.indexOf('id="advanced-settings"'));
    expect(html.indexOf('id="pending-heading"')).toBeLessThan(html.indexOf('id="data-integrations"'));
    expect(html).toContain('id="mcp-url"');
    expect(html).toContain("docs/mcp.md");
  });

  it("參與頁維持單一投票任務，不帶分析、匯出或 MCP 控制", () => {
    const html = read("public/participate.html");
    expect(html).not.toContain("deep-analysis");
    expect(html).not.toContain("export-section");
    expect(html).not.toContain("mcp-url");
  });
});

describe("雙語頁面", () => {
  it("中英 landing 與指南頁存在且互相連結", () => {
    const zh = read("public/index.html");
    const en = read("public/en.html");
    expect(zh).toContain('href="/en"');
    expect(zh).toContain('href="/guide"');
    expect(en).toContain('href="/"');
    expect(en).toContain('href="/en/guide"');
    expect(read("public/guide.html")).toContain('href="/en/guide"');
    expect(read("public/guide-en.html")).toContain('href="/guide"');
  });
  it("結果頁方法說明連結中英文分別對應公開路由且錨點均存在", () => {
    const reportHtml = read("public/report.html");
    const reportJs = read("public/js/report.js");
    const guideZh = read("public/guide.html");
    const guideEn = read("public/guide-en.html");
    const indexTs = read("src/index.ts");

    // 中文預設 href 為 /guide#how-it-works
    expect(reportHtml).toContain('href="/guide#how-it-works" id="method-link"');
    // 英文切換設置 href 為 /en/guide#how-it-works（非內部靜態檔名 /guide-en）
    expect(reportJs).toContain('methodLink.href = "/en/guide#how-it-works"');
    expect(reportJs).not.toContain('methodLink.href = "/guide-en#how-it-works"');

    // 路由對照與兩側錨點存在性
    expect(indexTs).toContain('[/^\\/en\\/guide$/, "/guide-en"]');
    expect(guideZh).toContain('id="how-it-works"');
    expect(guideEn).toContain('id="how-it-works"');
  });

  it("應用頁掛上 i18n 與回官網的品牌導覽", () => {
    for (const page of ["participate", "report", "admin"]) {
      const html = read(`public/${page}.html`);
      expect(html).toContain("data-i18n");
      expect(html).toContain('id="home-link"');
    }
    expect(read("public/js/i18n.js")).toContain("STRINGS");
  });
  it("statementRowAttrs 確保只有 canonical 行擁有 id=stmt-<sid> 與 tabindex=-1，摘要行不帶 ID", () => {
    const summaryRow = statementRowAttrs(42, { canonical: false });
    const defaultRow = statementRowAttrs(42);
    const canonicalRow = statementRowAttrs(42, { canonical: true });

    // 摘要行與預設調用：僅含 CSS class，絕不發射 id 或 tabindex
    expect(summaryRow).toEqual({ class: "statement-row" });
    expect(defaultRow).toEqual({ class: "statement-row" });

    // canonical 全陳述列表行：唯一持有 id="stmt-<sid>" 與 tabindex="-1"
    expect(canonicalRow).toEqual({
      class: "statement-row",
      id: "stmt-42",
      tabindex: "-1",
    });

    // 同一 sid 出現在共識卡、分群代表卡與全陳述列表時，全局僅有 1 個可導覽目標 ID
    const renderedRows = [
      statementRowAttrs(7, { canonical: false }), // 共識摘要列表
      statementRowAttrs(7, { canonical: false }), // 群體 0 代表意見
      statementRowAttrs(7, { canonical: false }), // 群體 1 代表意見
      statementRowAttrs(7, { canonical: true }),  // 全陳述列表（唯一的導覽目標）
    ];
    const rowsWithId = renderedRows.filter((r) => typeof r.id === "string");
    expect(rowsWithId).toHaveLength(1);
    expect(rowsWithId[0].id).toBe("stmt-7");
    expect(rowsWithId[0].tabindex).toBe("-1");
  });
});
describe("結果頁無障礙、樣式與 CSP 合約", () => {
  function extractGroupTokens(css) {
    const rootBlock = css.match(/:root\s*\{([^}]+)\}/)?.[1] || "";
    const darkBlock = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/)?.[1] || "";

    const extract = (block) => {
      const map = {};
      for (let i = 0; i < 5; i++) {
        const match = block.match(new RegExp(`--group-${i}:\\s*(#[0-9a-fA-F]{3,6})`));
        if (match) map[`group-${i}`] = match[1];
      }
      return map;
    };

    return {
      light: extract(rootBlock),
      dark: extract(darkBlock),
    };
  }

  function testLocalWcagContrast(hex1, hex2) {
    const toLinear = (c8) => {
      const v = c8 / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const lum = (hex) => {
      const clean = hex.replace("#", "");
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    };
    const l1 = lum(hex1);
    const l2 = lum(hex2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  it("WCAG AA 對比度：從 style.css 解析之 5 組淺色與 5 組深色群體色票，accessibleTextColor 選擇之前景均達到 >= 4.5:1 對比度", () => {
    const css = read("public/style.css");
    const { light, dark } = extractGroupTokens(css);

    expect(Object.keys(light)).toHaveLength(5);
    expect(Object.keys(dark)).toHaveLength(5);

    const expectedForegrounds = {
      light: {
        "group-0": "#ffffff",
        "group-1": "#000000",
        "group-2": "#000000",
        "group-3": "#ffffff",
        "group-4": "#ffffff",
      },
      dark: {
        "group-0": "#000000",
        "group-1": "#000000",
        "group-2": "#000000",
        "group-3": "#000000",
        "group-4": "#000000",
      },
    };

    for (const [key, bgHex] of Object.entries(light)) {
      const fg = accessibleTextColor(bgHex);
      expect(fg).toBe(expectedForegrounds.light[key]);
      const cr = testLocalWcagContrast(bgHex, fg);
      expect(cr, `Light mode ${key} (${bgHex}) with ${fg} must satisfy WCAG AA`).toBeGreaterThanOrEqual(4.5);
    }

    for (const [key, bgHex] of Object.entries(dark)) {
      const fg = accessibleTextColor(bgHex);
      expect(fg).toBe(expectedForegrounds.dark[key]);
      const cr = testLocalWcagContrast(bgHex, fg);
      expect(cr, `Dark mode ${key} (${bgHex}) with ${fg} must satisfy WCAG AA`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("r.backToAll 定義於 STRINGS 且中英文均非空", () => {
    expect(STRINGS["r.backToAll"]).toBeDefined();
    expect(STRINGS["r.backToAll"][0]).toBe("顯示全部意見");
    expect(STRINGS["r.backToAll"][1]).toBe("Show all statements");
    expect(read("public/report.html")).toContain('data-i18n="r.backToAll"');
  });

  it("列印樣式保留 .sid-chip 引用按鈕可見性", () => {
    const css = read("public/style.css");
    expect(css).toContain("button:not(.sid-chip)");
    expect(css).toMatch(/\.sid-chip\s*\{[^}]*display:\s*inline-flex\s*!important/);
  });

  it("CSP style-src self 相容性：靜態佈局類別定義於 CSS 且 report.js 絕不使用 el() style 屬性", () => {
    const css = read("public/style.css");
    const js = read("public/js/report.js");

    expect(css).toContain(".cg-point-header");
    expect(css).toContain(".tension-stat-compare");
    expect(css).toContain(".tension-citation-item");
    expect(css).toContain(".tension-citations-list");

    // report.js 中不應出現 el(..., { ... style: ... }) 傳入 style 屬性（因為會被 setAttribute 擋下）
    const styleAttrInEl = /el\(\s*["'][a-z0-9]+["']\s*,\s*\{[^}]*\bstyle\s*:/i.test(js);
    expect(styleAttrInEl).toBe(false);
  });

  it("prefers-reduced-motion 覆寫必須位於所有 animation 宣告之後且加 !important，才能贏得同特異性層疊", () => {
    const css = read("public/style.css");
    const rmIdx = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(rmIdx).toBeGreaterThan(0);
    const block = css.slice(rmIdx);
    expect(block).toMatch(/\.highlight-target[^{]*\{[^}]*animation:\s*none\s*!important/);
    expect(block).toMatch(/\.badge\.pulse[^{]*\{[^}]*animation:\s*none\s*!important/);
    // 媒體區塊之後不得再有任何 animation: 宣告（否則後者覆蓋）
    const after = css.slice(rmIdx).replace(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/, "");
    expect(after).not.toMatch(/animation:\s*(?!none)/);
    // 所有帶 animation 的規則都在覆寫區塊之前
    for (const sel of [".highlight-target", ".badge.pulse", ".map-svg circle.dot"]) {
      const declIdx = css.search(new RegExp(sel.replace(/[.]/g, "\\.") + "\\s*\\{[^}]*animation:\\s*[a-z-]+\\s"));
      expect(declIdx).toBeGreaterThan(-1);
      expect(declIdx).toBeLessThan(rmIdx);
    }
  });

  it("模型歸屬徽章：初始 HTML 隱藏且無文字，只在 ready（或帶快取的 pending）時由 setModelBadge 顯示", () => {
    const html = read("public/report.html");
    const js = read("public/js/report.js");
    expect(html).toMatch(/<span class="badge ai-model-badge hidden" id="ai-model-badge"><\/span>/);
    expect(html).not.toContain(">Gemma 4 26B<");
    // 唯一寫入點
    expect(js.match(/getElementById\("ai-model-badge"\)/g)).toHaveLength(1);
    expect(js).not.toContain('querySelector(".ai-model-badge")');
    // unavailable / insufficient / 無快取 pending 三條分支皆呼叫 setModelBadge(null)
    expect(js.match(/setModelBadge\(null\)/g)).toHaveLength(3);
    const unavailable = js.slice(js.indexOf('synthesis.status === "unavailable"'), js.indexOf('synthesis.status === "insufficient"'));
    expect(unavailable).toContain("setModelBadge(null)");
    const insufficient = js.slice(js.indexOf('synthesis.status === "insufficient"'), js.indexOf('synthesis.status === "pending"'));
    expect(insufficient).toContain("setModelBadge(null)");
    // setModelBadge 無 overview 時清空並隱藏
    const fn = js.slice(js.indexOf("function setModelBadge"), js.indexOf("function clearSynthesisDom"));
    expect(fn).toMatch(/if \(!synthesis \|\| !synthesis\.overview\)[\s\S]*?textContent = ""[\s\S]*?show\(modelBadge, false\)/);
    expect(fn).toMatch(/r\.aiModelDeterministic[\s\S]*?r\.aiModelTag[\s\S]*?show\(modelBadge, true\)/);
  });
});

describe("結果頁主題篩選與綜整一致性", () => {
  it("輪詢與重新整理都經由 applySynthesis：先對齊主題篩選再渲染陳述列表，卡片與列表不會出自不同綜整", () => {
    const js = read("public/js/report.js");
    const fn = js.slice(js.indexOf("function applySynthesis"), js.indexOf("function schedulePendingPoll"));
    expect(fn).toMatch(/currentSynthesis = res;[\s\S]*activeThemeFilter = null;[\s\S]*renderAiOverview\(res, mathResult\);[\s\S]*renderStatements\(mathResult\);/);
    // 輪詢路徑
    const poll = js.slice(js.indexOf("function schedulePendingPoll"), js.indexOf("function setModelBadge"));
    expect(poll).toContain("applySynthesis(res, currentMathResult)");
    expect(poll).not.toContain("currentSynthesis = res");
    // 重新整理路徑：不得在套用新綜整前先用舊綜整渲染列表
    const refresh = js.slice(js.indexOf("async function refresh("), js.indexOf('document.getElementById("clear-theme-filter")?.addEventListener'));
    expect(refresh).toContain("applySynthesis(synthesisRes.value, result)");
    expect(refresh).toContain('applySynthesis({ status: "unavailable" }, result)');
    expect(refresh).not.toMatch(/renderStatements\(result\)/);
    expect(refresh).not.toContain("currentSynthesis =");
  });

  it("小群遮蔽：結果頁依 statsRedacted 顯示匿名保護說明，字串中英俱備", () => {
    const js = read("public/js/report.js");
    expect(js).toContain("g.statsRedacted");
    expect(js).toContain('t("r.groupTooSmall")');
    expect(STRINGS["r.groupTooSmall"]).toHaveLength(2);
    expect(STRINGS["r.groupTooSmall"][0].length).toBeGreaterThan(0);
    expect(STRINGS["r.groupTooSmall"][1].length).toBeGreaterThan(0);
  });
});

describe("el() 選填子節點", () => {
  it("null / undefined / false 子節點被略過，不會渲染成字面 \"null\"", () => {
    const makeNode = (tag) => ({
      tag,
      children: [],
      textContent: "",
      className: "",
      attrs: {},
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      append(child) {
        this.children.push(typeof child === "string" ? child : child && child.tag ? child : String(child));
      },
    });
    globalThis.document = { createElement: makeNode };
    try {
      const node = el("div", { class: "x" }, [
        null,
        el("span", { text: "a" }),
        undefined,
        false,
        "b",
      ]);
      expect(node.children.map((c) => (typeof c === "string" ? c : c.tag))).toEqual(["span", "b"]);
      expect(node.children).not.toContain("null");
      expect(node.children).not.toContain("undefined");
    } finally {
      delete globalThis.document;
    }
  });
});

describe("ensure-queue 環境隔離", () => {
  it("resolveQueueName 依環境從 wrangler.jsonc 取各自的 consumer Queue，找不到即拋錯", () => {
    expect(resolveQueueName("")).toBe("pocket-polis-sensemaking");
    expect(resolveQueueName("production")).toBe("pocket-polis-sensemaking");
    expect(() => resolveQueueName("staging")).toThrow(/staging/);
  });
});

describe("agent 引導檔案", () => {
  it("AGENT.md 與 skill 存在且包含部署流程", () => {
    const agent = read("AGENT.md");
    expect(agent).toContain("wrangler login");
    expect(agent).toContain("/api/conversations");
    const skill = read("skills/pocket-polis/SKILL.md");
    expect(skill).toMatch(/^---\nname: pocket-polis/);
  });
});
