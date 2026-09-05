import { api, conversationIdFromPath, el, groupColor, show, statementRowAttrs } from "./common.js";
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

  const W = 860;
  const H = 520;
  const pad = 56;
  const plottedPoints = you ? [...result.points, you] : result.points;
  const xs = plottedPoints.map((p) => p.x);
  const ys = plottedPoints.map((p) => p.y);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const sx = (x) => (spanX > 0 ? pad + ((x - minX) / spanX) * (W - 2 * pad) : W / 2);
  const sy = (y) => (spanY > 0 ? H - pad - ((y - minY) / spanY) * (H - 2 * pad) : H / 2);

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "map-svg",
    role: "img",
    "aria-label": t("r.mapTitle"),
  });

  const title = svgEl("title", {});
  title.textContent = t("r.mapTitle");
  svg.append(title);

  // 恢復原版柔和色雲，讓分群是背景脈絡而不是硬框住的人群。
  const defs = svgEl("defs", {});
  const blur = svgEl("filter", { id: "hull-blur", x: "-30%", y: "-30%", width: "160%", height: "160%" });
  blur.append(svgEl("feGaussianBlur", { stdDeviation: 12 }));
  defs.append(blur);
  svg.append(defs);

  const axisColor = "color-mix(in srgb, currentColor 8%, transparent)";
  svg.append(svgEl("line", { x1: W / 2, y1: 16, x2: W / 2, y2: H - 16, stroke: axisColor, "stroke-width": 1 }));
  svg.append(svgEl("line", { x1: 16, y1: H / 2, x2: W - 16, y2: H / 2, stroke: axisColor, "stroke-width": 1 }));

  const screenPoints = result.points.map((p) => ({ x: sx(p.x), y: sy(p.y), group: p.group }));

  // 群體色雲：低彩度、無框線，不搶過參與者本身。
  if (result.k >= 2) {
    for (const group of result.groups) {
      const members = screenPoints.filter((p) => p.group === group.id);
      if (members.length < 3) continue;
      svg.append(
        svgEl("path", {
          d: hullPath(members, 26),
          fill: groupColor(group.id),
          "fill-opacity": 0.13,
          filter: "url(#hull-blur)",
        }),
      );
    }
  }

  screenPoints.forEach((point, index) => {
    const dot = svgEl("circle", {
      cx: point.x.toFixed(1),
      cy: point.y.toFixed(1),
      r: 5.5,
      fill: groupColor(point.group),
      "fill-opacity": 0.85,
      stroke: "var(--surface)",
      "stroke-width": 1.4,
      class: "dot",
    });
    dot.style.animationDelay = `${Math.min(index * 8, 600)}ms`;
    svg.append(dot);
  });

  // 群標籤回到原版的文字章，不用實心大圓遮住資料點。
  if (result.k >= 2) {
    for (const group of result.groups) {
      const members = screenPoints.filter((p) => p.group === group.id);
      if (members.length === 0) continue;
      const topY = Math.min(...members.map((p) => p.y));
      const centerX = members.reduce((sum, p) => sum + p.x, 0) / members.length;
      const label = t("r.groupChip", { label: group.label, size: group.size });
      const chipWidth = label.length * 8.2 + 26;
      const chipY = Math.max(topY - 46, 8);
      svg.append(
        svgEl("rect", {
          x: centerX - chipWidth / 2,
          y: chipY,
          width: chipWidth,
          height: 26,
          rx: 13,
          fill: groupColor(group.id),
          "fill-opacity": 0.12,
        }),
      );
      const labelText = svgEl("text", {
        x: centerX,
        y: chipY + 17.5,
        "text-anchor": "middle",
        "font-size": 12.5,
        "font-weight": 700,
        fill: groupColor(group.id),
      });
      labelText.textContent = label;
      svg.append(labelText);
    }
  }

  if (you) {
    const youX = sx(you.x);
    const youY = sy(you.y);
    svg.append(
      svgEl("circle", {
        cx: youX,
        cy: youY,
        r: 11,
        fill: "none",
        stroke: "currentColor",
        "stroke-opacity": 0.3,
        "stroke-width": 1.6,
      }),
    );
    svg.append(
      svgEl("circle", {
        cx: youX,
        cy: youY,
        r: 6,
        fill: "currentColor",
        stroke: "var(--surface)",
        "stroke-width": 2,
      }),
    );
    const label = t("r.you");
    const pillWidth = label.length * 9 + 18;
    const pillY = Math.max(youY - 38, 6);
    svg.append(
      svgEl("rect", {
        x: youX - pillWidth / 2,
        y: pillY,
        width: pillWidth,
        height: 21,
        rx: 10.5,
        fill: "currentColor",
      }),
    );
    const text = svgEl("text", {
      x: youX,
      y: pillY + 14.5,
      "text-anchor": "middle",
      "font-size": 11.5,
      "font-weight": 700,
      fill: "var(--surface)",
    });
    text.textContent = label;
    svg.append(text);
    show(document.getElementById("you-note"), true);
  } else {
    show(document.getElementById("you-note"), false);
  }

  container.append(svg);

  for (const g of result.groups) {
    if (result.k < 2) continue;
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

function renderBridging(result) {
  const container = document.getElementById("bridging-container");
  if (!container) return;
  container.replaceChildren();
  const bridging = result.bridging;
  if (!bridging || bridging.statements.length === 0) {
    container.append(el("p", { class: "muted", text: t("r.bridgingEmpty") }));
    return;
  }
  for (const s of bridging.statements.slice(0, 8)) {
    const score = (s.score >= 0 ? "+" : "") + s.score.toFixed(2);
    const line = statementLine(s.sid, [
      el("span", { class: `tag ${s.score >= 0 ? "agree" : "disagree"}`, text: t("r.bridgingScore", { score }) }),
      el("span", { class: "tag pending", text: t("r.bridgingPolarity", { polarity: Math.round(s.polarity * 100) }) }),
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
      document.getElementById("export-tttc").href = `/api/conversations/${convId}/export/tttc.csv`;
      document.getElementById("export-statements").href = `/api/conversations/${convId}/export/statements.csv`;
      document.getElementById("export-votes").href = `/api/conversations/${convId}/export/votes.csv`;
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
  renderBridging(result);
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
