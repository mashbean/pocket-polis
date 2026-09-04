import { api, el, show } from "./common.js";
import { applyI18n, lang, mountLangSwitch, t } from "./i18n.js";

const listNode = document.getElementById("directory-list");
const countNode = document.getElementById("result-count");
const errorNode = document.getElementById("load-error");
const moreButton = document.getElementById("load-more");
const form = document.getElementById("filter-form");
const searchInput = document.getElementById("search-input");
const statusSelect = document.getElementById("status-select");

// 英文介面時，所有站內連結都帶上 ?lang=en，參與者點進去不會掉回中文
const langQuery = lang === "en" ? "?lang=en" : "";

const state = { q: "", status: "all", cursor: null, total: 0, loading: false };

applyI18n();
// 這頁沒有動態標題可用，分頁名稱得自己跟著語言走
document.title = `${t("x.title")} — Pocket Polis`;
mountLangSwitch(document.getElementById("lang-switch"));
document.getElementById("create-link").href = lang === "en" ? "/en#create" : "/#create";

/** 網址是列表狀態的唯一真相：搜尋條件可以分享，上一頁也回得去。 */
function readStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const status = params.get("status");
  state.q = (params.get("q") || "").slice(0, 120);
  state.status = status === "open" || status === "closed" ? status : "all";
  searchInput.value = state.q;
  statusSelect.value = state.status;
}

function writeStateToUrl() {
  const params = new URLSearchParams(location.search);
  if (state.q) params.set("q", state.q);
  else params.delete("q");
  if (state.status !== "all") params.set("status", state.status);
  else params.delete("status");
  const query = params.toString();
  history.replaceState(null, "", query ? `${location.pathname}?${query}` : location.pathname);
}

function formatDate(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(lang === "en" ? "en-US" : "zh-TW", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** 列表用的計數：一行帶過就好，數字放大成統計磚會蓋過題目本身。 */
function metaItem(value, labelKey) {
  return el("span", { class: "directory-meta-item" }, [
    el("strong", { text: String(value ?? 0) }),
    " ",
    t(labelKey),
  ]);
}

function conversationCard(item) {
  const isOpen = item.status === "open";
  const description = (item.description || "").trim();

  const header = el("div", { class: "directory-card-header" }, [
    el("h3", {}, [
      el("a", { href: `/r/${item.id}${langQuery}`, text: item.title || item.id }),
    ]),
    el("span", {
      class: `badge directory-status ${isOpen ? "open" : "closed"}`,
      text: t(isOpen ? "x.statusOpen" : "x.statusClosed"),
    }),
  ]);

  const body = el("p", {
    class: description ? "directory-description" : "directory-description muted",
    text: description || t("x.noDescription"),
  });

  const meta = el("p", { class: "muted directory-meta" }, [
    metaItem(item.counts?.participants, "r.participants"),
    metaItem(item.counts?.votes, "r.votes"),
    metaItem(item.counts?.statements, "r.statements"),
    el("span", {
      class: "directory-meta-item",
      text: t("x.created", { date: formatDate(item.createdAt) }),
    }),
  ]);

  const actions = el("div", { class: "actions directory-actions" }, [
    // 已結束的討論不再需要「加入投票」這個主要動作，只留結果頁
    isOpen &&
      el("a", { class: "button primary", href: `/c/${item.id}${langQuery}`, text: t("x.join") }),
    el("a", { class: "button", href: `/r/${item.id}${langQuery}`, text: t("x.report") }),
  ]);

  return el("article", { class: "card directory-card" }, [header, body, meta, actions]);
}

function renderCount() {
  countNode.textContent = state.q
    ? t("x.totalFiltered", { n: state.total, q: state.q })
    : t("x.total", { n: state.total });
}

function renderEmpty() {
  listNode.append(
    el("div", { class: "card directory-empty" }, [
      el("p", { text: t("x.empty") }),
      el("p", { class: "muted", text: t("x.emptyHint") }),
    ]),
  );
}

async function load({ append }) {
  if (state.loading) return;
  state.loading = true;
  moreButton.disabled = true;
  show(errorNode, false);
  try {
    const params = new URLSearchParams({ status: state.status });
    if (state.q) params.set("q", state.q);
    if (append && state.cursor) params.set("cursor", state.cursor);
    const page = await api(`/api/conversations?${params.toString()}`);

    if (!append) listNode.replaceChildren();
    state.total = page.total ?? 0;
    state.cursor = page.nextCursor ?? null;
    for (const item of page.conversations ?? []) listNode.append(conversationCard(item));
    if (!append && (page.conversations ?? []).length === 0) renderEmpty();
    renderCount();
    show(moreButton, state.cursor !== null);
  } catch (error) {
    errorNode.textContent = `${t("x.loadFail")}：${error.message}`;
    show(errorNode, true);
    show(moreButton, false);
  } finally {
    state.loading = false;
    moreButton.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  state.q = searchInput.value.trim().slice(0, 120);
  state.status = statusSelect.value;
  state.cursor = null;
  writeStateToUrl();
  load({ append: false });
});

statusSelect.addEventListener("change", () => {
  form.requestSubmit();
});

moreButton.addEventListener("click", () => load({ append: true }));

readStateFromUrl();
load({ append: false });
