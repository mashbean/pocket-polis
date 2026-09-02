import { accessibleTextColor, api, conversationIdFromPath, el, groupColor, show, statementRowAttrs } from "./common.js";
import { applyI18n, lang, mountLangSwitch, t } from "./i18n.js";

applyI18n();
mountLangSwitch(document.getElementById("lang-switch"));

if (lang === "en") {
  const methodLink = document.getElementById("method-link");
  if (methodLink) methodLink.href = "/en/guide#how-it-works";
}

const convId = conversationIdFromPath();
const SVG_NS = "http://www.w3.org/2000/svg";

let statementIndex = new Map();
let currentMathResult = null;
let currentSynthesis = null;
let activeThemeFilter = null;
let infoLoaded = false;

function fail(message) {
  const box = document.getElementById("load-error");
  box.textContent = message;
  show(box, true);
  show(document.getElementById("stats-row"), false);
  show(document.getElementById("map-container"), false);
}

function pidForReadOnly() {
  try {
    return localStorage.getItem(`polis-serverless:pid:${convId}`);
  } catch {
    return null;
  }
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function renderStats(result) {
  const row = document.getElementById("stats-row");
  row.replaceChildren();
  const items = [
    { label: t("r.participants"), value: result.nParticipantsTotal },
    { label: t("r.votes"), value: result.nVotes },
    { label: t("r.statements"), value: result.nStatements },
    { label: t("r.groups"), value: result.k },
  ];
  for (const item of items) {
    row.append(
      el("div", { class: "stat" }, [
        el("div", { class: "value", text: String(item.value) }),
        el("div", { class: "label", text: item.label }),
      ]),
    );
  }
}

/** Andrew monotone chain 凸包 */
function convexHull(points) {
  if (points.length <= 2) return points.slice();
  const sorted = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 凸包外擴 + 中點平滑，畫成柔軟的群體輪廓 */
function hullPath(points, padding) {
  if (points.length < 3) return null;
  const hull = convexHull(points);
  if (hull.length < 3) return null;

  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;

  const expanded = hull.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / d) * padding, y: p.y + (dy / d) * padding };
  });

  const n = expanded.length;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let d = "";
  for (let i = 0; i < n; i++) {
    const cur = expanded[i];
    const next = expanded[(i + 1) % n];
    const m = mid(cur, next);
    if (i === 0) {
      const prev = expanded[n - 1];
      const m0 = mid(prev, cur);
      d += `M ${m0.x.toFixed(1)} ${m0.y.toFixed(1)} `;
    }
    d += `Q ${cur.x.toFixed(1)} ${cur.y.toFixed(1)}, ${m.x.toFixed(1)} ${m.y.toFixed(1)} `;
  }
  d += "Z";
  return d;
}

function renderMap(result, you) {
  const container = document.getElementById("map-container");
  container.replaceChildren();
  const legend = document.getElementById("legend");
  legend.replaceChildren();

  if (result.points.length === 0) {
    container.append(el("p", { class: "muted card", text: t("r.mapEmpty") }));
    show(document.getElementById("you-note"), false);
    return;
  }

  const xs = result.points.map((p) => p.x);
  const ys = result.points.map((p) => p.y);
  if (you) {
    xs.push(you.x);
    ys.push(you.y);
  }

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const spanX = Math.max(maxX - minX, 0.5);
  const spanY = Math.max(maxY - minY, 0.5);
  const padX = spanX * 0.18;
  const padY = spanY * 0.18;

  const w = 520;
  const h = 340;
  const scaleX = (w - 40) / (spanX + padX * 2);
  const scaleY = (h - 40) / (spanY + padY * 2);
  const scale = Math.min(scaleX, scaleY);

  const cxWorld = (minX + maxX) / 2;
  const cyWorld = (minY + maxY) / 2;
  const toScreen = (p) => ({
    x: w / 2 + (p.x - cxWorld) * scale,
    y: h / 2 - (p.y - cyWorld) * scale,
  });

  const svg = svgEl("svg", {
    viewBox: `0 0 ${w} ${h}`,
    class: "map-svg",
    role: "img",
    "aria-label": t("r.mapTitle"),
  });

  const defs = svgEl("defs", {});
  svg.append(defs);

  // 1. 群體柔和底色輪廓
  if (result.k >= 2) {
    for (let g = 0; g < result.k; g++) {
      const gPoints = result.points.filter((p) => p.group === g).map(toScreen);
      const color = groupColor(g);
      const d = hullPath(gPoints, 18);
      if (d) {
        svg.append(
          svgEl("path", {
            d,
            fill: color,
            "fill-opacity": "0.14",
            stroke: color,
            "stroke-opacity": "0.4",
            "stroke-width": "1.2",
            "stroke-linejoin": "round",
          }),
        );
      }
    }
  }

  // 2. 參與者圓點
  const pts = result.points.map((p, idx) => ({ ...toScreen(p), group: p.group, idx }));
  for (const pt of pts) {
    const color = groupColor(pt.group);
    const circle = svgEl("circle", {
      cx: pt.x.toFixed(1),
      cy: pt.y.toFixed(1),
      r: "4.8",
      fill: color,
      "fill-opacity": "0.88",
      stroke: "var(--surface)",
      "stroke-width": "1.2",
      class: "dot",
    });
    circle.style.animationDelay = `${Math.min(pt.idx * 12, 400)}ms`;
    svg.append(circle);
  }

  // 3. 群體標籤
  for (const g of result.groups) {
    const center = toScreen({ x: g.center[0], y: g.center[1] });
    const color = groupColor(g.id);
    const labelCircle = svgEl("circle", {
      cx: center.x.toFixed(1),
      cy: center.y.toFixed(1),
      r: "13",
      fill: color,
      stroke: "var(--surface)",
      "stroke-width": "2",
    });
    const textColor = accessibleTextColor(color);
    const labelText = svgEl("text", {
      x: center.x.toFixed(1),
      y: (center.y + 4.5).toFixed(1),
      "text-anchor": "middle",
      fill: textColor,
      "font-size": "11",
      "font-weight": "700",
    });
    labelText.textContent = g.label;
    svg.append(labelCircle);
    svg.append(labelText);
  }

  // 4. 「你」的位置標記
  if (you) {
    const youScreen = toScreen(you);
    const pulse = svgEl("circle", {
      cx: youScreen.x.toFixed(1),
      cy: youScreen.y.toFixed(1),
      r: "12",
      fill: "none",
      stroke: "var(--text)",
      "stroke-width": "1.5",
      "stroke-dasharray": "2 2",
      opacity: "0.7",
    });
    const dot = svgEl("circle", {
      cx: youScreen.x.toFixed(1),
      cy: youScreen.y.toFixed(1),
      r: "6",
      fill: "var(--text)",
      stroke: "var(--surface)",
      "stroke-width": "2",
    });
    const text = svgEl("text", {
      x: youScreen.x.toFixed(1),
      y: (youScreen.y - 10).toFixed(1),
      "text-anchor": "middle",
      fill: "var(--text)",
      "font-size": "10",
      "font-weight": "700",
    });
    text.textContent = t("r.you");
    svg.append(pulse);
    svg.append(dot);
    svg.append(text);
    show(document.getElementById("you-note"), true);
  } else {
    show(document.getElementById("you-note"), false);
  }

  container.append(svg);

  for (const g of result.groups) {
    const dot = el("span", { class: "dot" });
    dot.style.backgroundColor = groupColor(g.id);
    legend.append(el("span", {}, [dot, t("r.groupLabel", { label: g.label, size: g.size })]));
  }
}

function smoothOrAutoScroll(target, options = { block: "center" }) {
  if (!target) return;
  const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  target.scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth", ...options });
}

function citationButton(sid) {
  const btn = el("button", {
    type: "button",
    class: "sid-chip",
    text: `#${sid}`,
    "aria-label": `${t("r.evidenceQuote")} #${sid}`,
  });
  btn.addEventListener("click", () => {
    if (activeThemeFilter !== null) {
      activeThemeFilter = null;
      renderThemes(currentSynthesis?.themes || []);
      renderStatements(currentMathResult);
    }
    const target = document.getElementById(`stmt-${sid}`);
    if (target) {
      smoothOrAutoScroll(target, { block: "center" });
      target.classList.add("highlight-target");
      target.focus();
      setTimeout(() => target.classList.remove("highlight-target"), 2400);
    }
  });
  return btn;
}

function percent(x) {
  return `${Math.round(x * 100)}%`;
}

// ---- AI 審議綜整渲染 ----
let pendingPollTimer = null;
let pollIntervalMs = 2000;

function isPendingOrRefreshing(res) {
  return Boolean(res && (res.status === "pending" || res.refreshPending === true));
}

/**
 * 套用新的綜整結果：先把主題篩選對齊新主題集（主題若已不存在就清除），
 * 再渲染綜整區與陳述列表，讓主題卡片與篩選後的列表永遠出自同一份綜整。
 */
function applySynthesis(res, mathResult) {
  currentSynthesis = res;
  const themes = res && Array.isArray(res.themes) ? res.themes : null;
  if (activeThemeFilter !== null && !(themes && themes.some((th) => th.id === activeThemeFilter))) {
    activeThemeFilter = null;
  }
  renderAiOverview(res, mathResult);
  renderStatements(mathResult);
}

function schedulePendingPoll() {
  if (pendingPollTimer) return;
  pendingPollTimer = setTimeout(async () => {
    pendingPollTimer = null;
    if (document.hidden) return;
    try {
      const res = await api(`/api/conversations/${convId}/synthesis?lang=${lang}`);
      if (res) {
        // 輪詢可能取回不同 mathRevision 的已完成綜整（例如投票／陳述在佇列任務期間變更）：
        // 若為非 stale 的 ready 且 revision 與當前結果不一致，直接重整結果與陳述，避免用舊列表渲染新引用
        if (res.status === "ready" && !res.isStale && res.mathRevision !== currentMathResult?.computedAt) {
          try {
            await refresh({ force: true });
          } catch {
            // refresh 失敗時仍嘗試以現有狀態排程下一次輪詢
          }
          if (isPendingOrRefreshing(currentSynthesis)) {
            pollIntervalMs = Math.min(15000, Math.round(pollIntervalMs * 1.5));
            schedulePendingPoll();
          } else {
            pollIntervalMs = 2000;
          }
          return;
        }
        applySynthesis(res, currentMathResult);
        if (isPendingOrRefreshing(res)) {
          pollIntervalMs = Math.min(15000, Math.round(pollIntervalMs * 1.5));
          schedulePendingPoll();
        } else {
          pollIntervalMs = 2000;
        }
      }
    } catch {
      // Handle transient errors by rescheduling with the bound
      pollIntervalMs = Math.min(15000, Math.round(pollIntervalMs * 1.5));
      schedulePendingPoll();
    }
  }, pollIntervalMs);
}
function setModelBadge(synthesis) {
  const modelBadge = document.getElementById("ai-model-badge");
  if (!modelBadge) return;
  // 只有真正渲染了 ready 結果（模型或統計摘要）才顯示歸屬；其餘狀態一律隱藏，避免誤標 Gemma
  if (!synthesis || !synthesis.overview) {
    modelBadge.textContent = "";
    show(modelBadge, false);
    return;
  }
  modelBadge.textContent =
    synthesis.generationMode === "deterministic" || synthesis.model === "deterministic"
      ? t("r.aiModelDeterministic")
      : t("r.aiModelTag");
  show(modelBadge, true);
}

function clearSynthesisDom() {
  document.getElementById("themes-container")?.replaceChildren();
  const themeDescription = document.getElementById("theme-filter-description");
  if (themeDescription) {
    themeDescription.textContent = "";
    show(themeDescription, false);
  }
  show(document.getElementById("themes-section"), false);
  document.getElementById("common-ground-container")?.replaceChildren();
  document.getElementById("tensions-container")?.replaceChildren();
  document.getElementById("group-portraits-container")?.replaceChildren();
  if (activeThemeFilter !== null) {
    activeThemeFilter = null;
    if (currentMathResult) {
      renderStatements(currentMathResult);
    }
  }
}

function renderAiOverview(synthesis, mathResult) {
  const container = document.getElementById("ai-overview-container");
  const statusBadge = document.getElementById("ai-status-badge");
  container.replaceChildren();

  if (!synthesis || synthesis.status === "unavailable") {
    clearSynthesisDom();
    setModelBadge(null);
    if (pendingPollTimer) {
      clearTimeout(pendingPollTimer);
      pendingPollTimer = null;
    }
    statusBadge.textContent = t("r.aiUnavailable");
    statusBadge.className = "badge ai-status-badge warning";
    show(statusBadge, true);
    container.append(
      el("div", { class: "card notice" }, [
        el("p", { class: "muted", text: synthesis?.reason || t("r.aiUnavailable") }),
      ]),
    );
    return;
  }

  if (synthesis.status === "insufficient") {
    clearSynthesisDom();
    setModelBadge(null);
    if (pendingPollTimer) {
      clearTimeout(pendingPollTimer);
      pendingPollTimer = null;
    }
    statusBadge.textContent = t("r.aiInsufficient");
    statusBadge.className = "badge ai-status-badge info";
    show(statusBadge, true);
    container.append(
      el("div", { class: "card notice" }, [
        el("p", { class: "muted", text: synthesis.reason || t("r.aiInsufficient") }),
      ]),
    );
    return;
  }


  if (synthesis.status === "pending") {
    statusBadge.textContent = t("r.aiPending");
    statusBadge.className = "badge ai-status-badge info pulse";
    show(statusBadge, true);

    // 若先前已有快取內容，展示快取並加上更新中標記
    if (synthesis.overview && synthesis.themes) {
      setModelBadge(synthesis);
      const staleNotice = el("div", { class: "notice stale-banner" }, [
        el("p", { class: "muted", text: t("r.aiPending") }),
      ]);
      const overviewChildren = [
        el("p", { class: "lead-text", text: synthesis.overview.summary }),
      ];
      if (synthesis.overview.citedStatementIds && synthesis.overview.citedStatementIds.length > 0) {
        overviewChildren.push(
          el("div", { class: "citations-row" }, [
            el("span", { class: "muted label", text: t("r.evidenceQuote") + ":" }),
            ...synthesis.overview.citedStatementIds.map((sid) => citationButton(sid)),
          ]),
        );
      }

      const card = el("div", { class: "card ai-overview-card" }, [
        staleNotice,
        el("div", { class: "ai-overview-summary" }, overviewChildren),
        synthesis.overview.participantContext
          ? el("p", { class: "muted", text: synthesis.overview.participantContext })
          : null,
      ]);
      container.append(card);
      renderThemes(synthesis.themes);
      renderCommonGroundSynthesis(synthesis.commonGround);
      renderTensions(synthesis.tensions);
      renderGroupPortraits(synthesis.groupPortraits);
    } else {
      clearSynthesisDom();
      setModelBadge(null);
      container.append(
        el("div", { class: "card notice" }, [
          el("p", { class: "lead-text", text: t("r.aiPending") }),
        ]),
      );
    }

    schedulePendingPoll();
    return;
  }

  // 狀態：ready
  if (synthesis.refreshPending) {
    statusBadge.textContent = t("r.aiPending");
    statusBadge.className = "badge ai-status-badge info pulse";
    schedulePendingPoll();
  } else if (synthesis.isStale) {
    if (pendingPollTimer) {
      clearTimeout(pendingPollTimer);
      pendingPollTimer = null;
    }
    statusBadge.textContent = t("r.aiStale");
    statusBadge.className = "badge ai-status-badge warning";
  } else {
    if (pendingPollTimer) {
      clearTimeout(pendingPollTimer);
      pendingPollTimer = null;
    }
    statusBadge.textContent = t("r.aiGeneratedAt", {
      time: new Date(synthesis.generatedAt).toLocaleTimeString(lang === "en" ? "en-US" : "zh-TW", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
    statusBadge.className = "badge ai-status-badge ready";
  }
  show(statusBadge, true);

  setModelBadge(synthesis);

  const cardChildren = [];
  if (synthesis.isStale) {
    cardChildren.push(
      el("div", { class: "notice stale-banner" }, [
        el("p", { class: "muted", text: t("r.aiStaleNotice") }),
      ]),
    );
  }

  const overviewSummaryChildren = [
    el("p", { class: "lead-text", text: synthesis.overview.summary }),
  ];
  if (synthesis.overview.citedStatementIds && synthesis.overview.citedStatementIds.length > 0) {
    overviewSummaryChildren.push(
      el("div", { class: "citations-row" }, [
        el("span", { class: "muted label", text: t("r.evidenceQuote") + ":" }),
        ...synthesis.overview.citedStatementIds.map((sid) => citationButton(sid)),
      ]),
    );
  }

  cardChildren.push(el("div", { class: "ai-overview-summary" }, overviewSummaryChildren));

  if (synthesis.overview.participantContext) {
    cardChildren.push(el("p", { class: "muted", text: synthesis.overview.participantContext }));
  }

  if (synthesis.provenance) {
    cardChildren.push(
      el("p", {
        class: "muted provenance-line",
        text: t("r.provenance", {
          s: synthesis.provenance.statementCount,
          v: synthesis.provenance.voteCount,
          p: synthesis.provenance.participantCount,
        }),
      }),
    );
  }

  const card = el("div", { class: "card ai-overview-card" }, cardChildren);
  container.append(card);

  renderThemes(synthesis.themes);
  renderCommonGroundSynthesis(synthesis.commonGround);
  renderTensions(synthesis.tensions);
  renderGroupPortraits(synthesis.groupPortraits);
}

function renderThemes(themes) {
  const section = document.getElementById("themes-section");
  const container = document.getElementById("themes-container");
  const description = document.getElementById("theme-filter-description");
  container.replaceChildren();
  description.textContent = "";
  show(description, false);

  if (!themes || themes.length === 0) {
    show(section, false);
    return;
  }
  show(section, true);

  const filters = el("div", { class: "theme-filter-list", role: "group", "aria-label": t("r.themesTitle") });
  const allButton = el("button", {
    type: "button",
    class: `theme-filter-chip ${activeThemeFilter === null ? "active" : ""}`,
    text: t("r.allThemes"),
    "aria-pressed": activeThemeFilter === null ? "true" : "false",
  });
  allButton.addEventListener("click", () => {
    activeThemeFilter = null;
    renderThemes(themes);
    renderStatements(currentMathResult);
  });
  filters.append(allButton);

  for (const th of themes) {
    const isSelected = activeThemeFilter === th.id;
    // 依 de-duplicated union 計算總數；詳細內容留在清單，不讓主題目錄搶走地圖主流程。
    const unionSids = th.statementIds && th.statementIds.length > 0
      ? th.statementIds
      : [...new Set([...th.primaryStatementIds, ...(th.secondaryStatementIds || [])])];

    const totalCount = unionSids.length;
    const filterBtn = el("button", {
      type: "button",
      class: `theme-filter-chip ${isSelected ? "active" : ""}`,
      "aria-pressed": isSelected ? "true" : "false",
      title: th.description,
    }, [
      el("span", { text: th.title }),
      el("span", { class: "badge count-badge", text: t("r.themeStatements", { n: totalCount }) }),
    ]);

    filterBtn.addEventListener("click", () => {
      activeThemeFilter = activeThemeFilter === th.id ? null : th.id;
      renderThemes(themes);
      renderStatements(currentMathResult);
      if (activeThemeFilter !== null) {
        smoothOrAutoScroll(document.getElementById("all-statements-section"));
      }
    });
    filters.append(filterBtn);

    if (isSelected && th.description) {
      description.textContent = th.description;
      show(description, true);
    }
  }

  container.append(filters);
}

function renderCommonGroundSynthesis(cg) {
  const container = document.getElementById("common-ground-container");
  container.replaceChildren();
  if (!cg) return;

  const card = el("div", { class: "card common-ground-card" });
  if (cg.summary) {
    card.append(el("p", { class: "cg-summary lead-text", text: cg.summary }));
  }

  if (cg.keyPoints && cg.keyPoints.length > 0) {
    const list = el("div", { class: "cg-points-list" });
    for (const kp of cg.keyPoints) {
      const dir = kp.direction || "agree";
      const tagText = dir === "disagree" ? t("r.mostlyDisagree") : t("r.mostlyAgree");
      const dirTag = el("span", { class: `tag ${dir}`, text: tagText });
      const header = el("div", { class: "cg-point-header" }, [
        el("h4", { text: kp.title }),
        dirTag,
      ]);
      const item = el("div", { class: "cg-point-item" }, [
        header,
        el("p", { text: kp.description }),
        kp.citedStatementIds && kp.citedStatementIds.length > 0
          ? el("div", { class: "citations-row" }, [
              el("span", { class: "muted label", text: t("r.evidenceQuote") + ":" }),
              ...kp.citedStatementIds.map((sid) => citationButton(sid)),
            ])
          : null,
      ]);
      list.append(item);
    }
    card.append(list);
  }

  container.append(card);
}

function perspectiveLabel(label, color) {
  const node = el("strong", { text: t("r.groupPerspective", { label }) });
  node.style.color = color;
  return node;
}

function renderTensions(tensions) {
  const container = document.getElementById("tensions-container");
  container.replaceChildren();

  if (!tensions || tensions.length === 0) {
    container.append(el("p", { class: "muted card", text: t("r.tensionsEmpty") }));
    return;
  }
  for (const tn of tensions) {
    const colorA = groupColor(tn.groupAId);
    const colorB = groupColor(tn.groupBId);

    const card = el("div", { class: "card tension-card" }, [
      el("h4", { class: "tension-topic", text: tn.topic }),
      tn.groupAPerspective || tn.groupBPerspective
        ? el("div", { class: "tension-perspectives" }, [
            tn.groupAPerspective
              ? el("div", { class: "perspective-box group-a" }, [
                  perspectiveLabel(tn.groupALabel, colorA),
                  el("span", { text: tn.groupAPerspective }),
                ])
              : null,
            tn.groupBPerspective
              ? el("div", { class: "perspective-box group-b" }, [
                  perspectiveLabel(tn.groupBLabel, colorB),
                  el("span", { text: tn.groupBPerspective }),
                ])
              : null,
          ])
        : null,
      tn.tensions ? el("p", { class: "tension-explanation", text: tn.tensions }) : null,
      tn.bridgingQuestion
        ? el("div", { class: "bridging-question-box" }, [
            el("span", { class: "bq-badge", text: "✦" }),
            el("div", { class: "bq-content" }, [
              el("strong", { text: t("r.bridgingQuestionLabel") }),
              el("span", { text: tn.bridgingQuestion }),
            ]),
          ])
        : null,
      renderTensionCitations(tn),
    ]);
    container.append(card);
  }
}

function renderTensionCitations(tn) {
  if (!tn.citedStatementIds || tn.citedStatementIds.length === 0) return null;
  const groupA = currentMathResult?.groups.find((g) => g.id === tn.groupAId);
  const groupB = currentMathResult?.groups.find((g) => g.id === tn.groupBId);
  const colorA = groupColor(tn.groupAId);
  const colorB = groupColor(tn.groupBId);

  const rows = [];
  for (const sid of tn.citedStatementIds) {
    const statA = groupA?.statementStats?.find((s) => s.sid === sid);
    const statB = groupB?.statementStats?.find((s) => s.sid === sid);

    const chip = citationButton(sid);
    const nodes = [chip];

    if (statA && statA.seen > 0 && statB && statB.seen > 0) {
      const aPct = Math.round((statA.agrees / statA.seen) * 100);
      const bPct = Math.round((statB.agrees / statB.seen) * 100);
      const labelA = tn.groupALabel;
      const labelB = tn.groupBLabel;

      const pillA = el("span", {
        class: "group-stat-pill",
        text: `${labelA}: ${aPct}% ${t("r.agreeWord")}`,
      });
      pillA.style.color = colorA;

      const pillB = el("span", {
        class: "group-stat-pill",
        text: `${labelB}: ${bPct}% ${t("r.agreeWord")}`,
      });
      pillB.style.color = colorB;

      const comp = el("span", { class: "tension-stat-compare muted" }, [
        pillA,
        el("span", { class: "vs-divider", text: " · " }),
        pillB,
      ]);
      nodes.push(comp);
    }

    rows.push(el("div", { class: "tension-citation-item" }, nodes));
  }

  return el("div", { class: "tension-citations-list citations-row" }, [
    el("span", { class: "muted label", text: t("r.evidenceQuote") + ":" }),
    ...rows,
  ]);
}

function renderGroupPortraits(portraits) {
  const container = document.getElementById("group-portraits-container");
  container.replaceChildren();

  if (!portraits || portraits.length === 0) return;

  const grid = el("div", { class: "portraits-grid" });
  for (const p of portraits) {
    const color = groupColor(p.groupId);
    const card = el("div", { class: "card portrait-card" });
    card.style.borderTop = `4px solid ${color}`;

    const title = el("h4", { text: `${t("r.groupLabel", { label: p.groupLabel, size: p.size })} · ${p.title}` });
    title.style.color = color;
    card.append(title);

    if (p.summary) {
      card.append(el("p", { class: "portrait-summary", text: p.summary }));
    }

    if (p.keyStances && p.keyStances.length > 0) {
      const stancesList = el("div", { class: "portrait-stances" });
      for (const st of p.keyStances) {
        const row = el("div", { class: "stance-item" }, [
          citationButton(st.sid),
          el("span", {
            class: `tag ${st.stance}`,
            text: st.stance === "agree" ? t("r.agreeWord") : t("r.disagreeWord"),
          }),
          st.summary ? el("span", { class: "stance-desc", text: st.summary }) : null,
        ]);
        stancesList.append(row);
      }
      card.append(stancesList);
    }
    grid.append(card);
  }
  container.append(grid);
}

function renderConsensus(result) {
  const container = document.getElementById("consensus-container");
  container.replaceChildren();
  const entries = [
    ...result.consensus.agree.map((c) => ({ ...c, tag: t("r.mostlyAgree"), cls: "agree" })),
    ...result.consensus.disagree.map((c) => ({ ...c, tag: t("r.mostlyDisagree"), cls: "disagree" })),
  ];
  if (entries.length === 0) {
    container.append(el("p", { class: "muted", text: t("r.consensusEmpty") }));
    return;
  }
  for (const c of entries) {
    const line = statementLine(c.sid, [
      el("span", { class: `tag ${c.cls}`, text: `${c.tag} ${percent(c.prob)}` }),
    ]);
    if (line) container.append(line);
  }
}

function renderGroups(result) {
  const container = document.getElementById("groups-container");
  container.replaceChildren();
  if (result.k < 2) {
    container.append(el("p", { class: "muted card", text: t("r.groupsEmpty") }));
    return;
  }
  for (const g of result.groups) {
    const card = el("div", { class: "card" });
    const heading = el("h3", { text: t("r.groupLabel", { label: g.label, size: g.size }) });
    heading.style.marginTop = "0";
    heading.style.color = groupColor(g.id);
    card.append(heading);
    if (g.statsRedacted) {
      card.append(el("p", { class: "muted", text: t("r.groupTooSmall") }));
    } else if (g.representative.length === 0) {
      card.append(el("p", { class: "muted", text: t("r.groupNone") }));
    }
    for (const r of g.representative) {
      const dirText = r.direction === "agree" ? t("r.agreeWord") : t("r.disagreeWord");
      const line = statementLine(r.sid, [
        el("span", {
          class: `tag ${r.direction}`,
          text: t("r.repLine", { p: Math.round(r.prob * 100), dir: dirText, x: r.repness.toFixed(1) }),
        }),
      ]);
      if (line) card.append(line);
    }
    container.append(card);
  }
}

function statementLine(sid, extraNodes) {
  const stat = statementIndex.get(sid);
  if (!stat) return null;
  return el("div", statementRowAttrs(sid, { canonical: false }), [
    citationButton(sid),
    el("div", { class: "text" }, [stat.text, el("div", {}, extraNodes)]),
  ]);
}

function renderStatements(result) {
  if (!result) return;
  const container = document.getElementById("statements-container");
  const clearBtn = document.getElementById("clear-theme-filter");
  container.replaceChildren();

  let stats = [...result.statementStats].sort((a, b) => b.agrees - a.agrees);

  if (activeThemeFilter !== null && currentSynthesis && currentSynthesis.themes) {
    const activeTheme = currentSynthesis.themes.find((t) => t.id === activeThemeFilter);
    if (activeTheme) {
      const unionSids = activeTheme.statementIds && activeTheme.statementIds.length > 0
        ? activeTheme.statementIds
        : [...new Set([...activeTheme.primaryStatementIds, ...(activeTheme.secondaryStatementIds || [])])];
      const sids = new Set(unionSids);
      stats = stats.filter((s) => sids.has(s.sid));
      show(clearBtn, true);
    } else {
      show(clearBtn, false);
    }
  } else {
    show(clearBtn, false);
  }

  if (stats.length === 0) {
    container.append(el("p", { class: "muted", text: t("r.allEmpty") }));
    return;
  }

  for (const s of stats) {
    const total = Math.max(s.seen, 1);
    const bar = el("div", { class: "vote-bar" });
    for (const [cls, n] of [
      ["agree", s.agrees],
      ["disagree", s.disagrees],
      ["pass", s.passes],
    ]) {
      const seg = el("div", { class: cls });
      seg.style.width = `${(n / total) * 100}%`;
      bar.append(seg);
    }
    const stat = statementIndex.get(s.sid);
    container.append(
      el("div", statementRowAttrs(s.sid, { canonical: true }), [
        citationButton(s.sid),
        el("div", { class: "text" }, [
          el("div", { class: "statement-body", text: stat ? stat.text : `#${s.sid}` }),
          bar,
          el("div", {
            class: "muted counts-line",
            text: t("r.counts", {
              a: s.agrees,
              d: s.disagrees,
              p: s.passes,
              ap: Math.round((s.agrees / total) * 100),
              dp: Math.round((s.disagrees / total) * 100),
            }),
          }),
        ]),
      ]),
    );
  }
}

async function loadStatementTexts(fetchOptions = {}) {
  const data = await api(`/api/conversations/${convId}/statements-public`, fetchOptions);
  statementIndex = new Map(data.statements.map((s) => [s.sid, s]));
}

async function refresh(options = {}) {
  const fetchOptions = options.force
    ? { cache: "no-store", headers: { "Cache-Control": "no-cache" } }
    : {};

  if (!infoLoaded) {
    const info = await api(`/api/conversations/${convId}`, fetchOptions);
    document.getElementById("conv-title").textContent = info.title;
    document.getElementById("conv-description").textContent = info.description;
    document.title = `${info.title} · ${t("r.title")} — Pocket Polis`;
    document.getElementById("participate-link").href = `/c/${convId}`;
    if (info.altUrl) {
      document.getElementById("alt-link").href = info.altUrl;
      show(document.getElementById("alt-banner"), true);
    }
    // 主持人開啟「公開資料下載」時才出現 comments.csv 入口（伺服器端另有把關）
    if (info.openData) {
      document.getElementById("export-comments").href = `/api/conversations/${convId}/export/comments.csv`;
      show(document.getElementById("export-section"), true);
    }
    infoLoaded = true;
  }

  const pid = pidForReadOnly();
  const query = pid ? `?pid=${pid}` : "";

  const [resultsRes, synthesisRes] = await Promise.allSettled([
    api(`/api/conversations/${convId}/results${query}`, fetchOptions),
    api(`/api/conversations/${convId}/synthesis?lang=${lang}`, fetchOptions),
  ]);

  if (resultsRes.status === "rejected") {
    throw resultsRes.reason;
  }

  const { result, you } = resultsRes.value;
  currentMathResult = result;

  if (result.statementStats.some((s) => !statementIndex.has(s.sid))) {
    await loadStatementTexts(fetchOptions);
  }

  renderStats(result);
  renderMap(result, you);
  renderConsensus(result);
  renderGroups(result);

  // applySynthesis 會在對齊主題篩選後渲染陳述列表；不在此先渲染，避免列表用舊綜整、卡片用新綜整
  if (synthesisRes.status === "fulfilled" && synthesisRes.value) {
    applySynthesis(synthesisRes.value, result);
  } else {
    applySynthesis({ status: "unavailable" }, result);
  }

  document.getElementById("computed-at").textContent = t("r.computedAt", {
    time: new Date(result.computedAt).toLocaleString(lang === "en" ? "en-US" : "zh-TW"),
    n: result.nParticipantsClustered,
    m: result.inclusionThreshold,
  });
}

document.getElementById("clear-theme-filter")?.addEventListener("click", () => {
  activeThemeFilter = null;
  renderThemes(currentSynthesis?.themes || []);
  renderStatements(currentMathResult);
});

document.getElementById("refresh").addEventListener("click", () => refresh({ force: true }).catch((e) => fail(e.message)));

(async () => {
  if (!convId) return fail(t("app.badUrl"));
  try {
    await refresh();
    setInterval(() => {
      if (!document.hidden) refresh().catch(() => {});
    }, 30000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh().catch(() => {});
    });
  } catch (error) {
    fail(error.message);
  }
})();
