import { api, conversationIdFromPath, copyText, el, show } from "./common.js";
import { applyI18n, mountLangSwitch, t } from "./i18n.js";

applyI18n();
mountLangSwitch(document.getElementById("lang-switch"));

const convId = conversationIdFromPath();
const storageKey = `polis-serverless:admin:${convId}`;
const panel = document.getElementById("panel");
const tokenSection = document.getElementById("token-section");
const loadError = document.getElementById("load-error");

let token = null;

function fail(message) {
  loadError.textContent = message;
  show(loadError, true);
}

function extractToken(raw) {
  const match = String(raw).match(/[0-9a-f]{32}/);
  return match ? match[0] : null;
}

function loadToken() {
  const fromHash = extractToken(location.hash);
  if (fromHash) {
    try {
      sessionStorage.setItem(storageKey, fromHash);
    } catch {
      /* 無法保存則僅用於本次 */
    }
    // 把金鑰從網址列拿掉，避免截圖或分享時外洩
    history.replaceState(null, "", location.pathname);
    return fromHash;
  }
  try {
    return sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

const authHeaders = () => ({ Authorization: `Bearer ${token}` });

async function refresh() {
  const overview = await api(`/api/conversations/${convId}/admin`, { headers: authHeaders() });
  const { settings, statements } = overview;
  document.getElementById("conv-title").textContent = t("a.manage", { title: settings.title });
  document.title = `${t("a.manage", { title: settings.title })} — Pocket Polis`;

  const origin = location.origin;
  document.getElementById("participate-url").textContent = `${origin}/c/${convId}`;
  document.getElementById("report-url").textContent = `${origin}/r/${convId}`;
  document.getElementById("admin-url").textContent = `${origin}/a/${convId}#token=${token}`;
  document.getElementById("mcp-url").textContent = `${origin}/mcp`;

  document.getElementById("setting-status").checked = settings.status === "open";
  document.getElementById("setting-autoApprove").checked = settings.autoApprove;
  document.getElementById("setting-allowSubmissions").checked = settings.allowSubmissions;
  document.getElementById("setting-openData").checked = settings.openData;
  document.getElementById("setting-altUrl").value = settings.altUrl ?? "";

  const pending = statements.filter((s) => s.status === "pending");
  const pendingContainer = document.getElementById("pending-container");
  pendingContainer.replaceChildren();
  document.getElementById("pending-heading").textContent = t("a.pendingTitle", { n: pending.length });
  if (pending.length === 0) {
    pendingContainer.append(el("p", { class: "muted", text: t("a.pendingEmpty") }));
  }
  for (const s of pending) {
    const approve = el("button", { class: "primary", text: t("a.approve") });
    approve.addEventListener("click", () => moderate(s.sid, "approve"));
    const reject = el("button", { text: t("a.reject") });
    reject.addEventListener("click", () => moderate(s.sid, "reject"));
    pendingContainer.append(
      el("div", { class: "statement-row" }, [
        el("div", { class: "text", text: s.text }),
        el("div", { class: "actions" }, [approve, reject]),
      ]),
    );
  }

  const all = document.getElementById("all-statements");
  all.replaceChildren();
  const statusText = {
    approved: t("a.statusApproved"),
    pending: t("a.statusPending"),
    rejected: t("a.statusRejected"),
  };
  for (const s of statements) {
    const nodes = [
      el("span", { class: `tag ${s.status === "pending" ? "pending" : ""}`, text: statusText[s.status] || s.status }),
      " ",
      el("span", {
        class: "muted",
        text: t("a.countsSeed", { a: s.agrees, d: s.disagrees, p: s.passes, seed: s.isSeed ? t("a.seedMark") : "" }),
      }),
    ];
    const row = el("div", { class: "statement-row" }, [
      el("div", { class: "text" }, [s.text, el("div", {}, nodes)]),
    ]);
    if (s.status === "approved") {
      const rejectButton = el("button", { text: t("a.unpublish") });
      rejectButton.addEventListener("click", () => moderate(s.sid, "reject"));
      row.append(el("div", { class: "actions" }, [rejectButton]));
    } else if (s.status === "rejected") {
      const approveButton = el("button", { text: t("a.republish") });
      approveButton.addEventListener("click", () => moderate(s.sid, "approve"));
      row.append(el("div", { class: "actions" }, [approveButton]));
    }
    all.append(row);
  }

  document.getElementById("export-comments").href =
    `/api/conversations/${convId}/export/comments.csv?token=${token}`;
  document.getElementById("export-statements").href =
    `/api/conversations/${convId}/export/statements.csv?token=${token}`;
  document.getElementById("export-votes").href =
    `/api/conversations/${convId}/export/votes.csv?token=${token}`;
}

async function moderate(sid, action) {
  try {
    await api(`/api/conversations/${convId}/admin/statements/${sid}`, {
      method: "POST",
      headers: authHeaders(),
      body: { action },
    });
    await refresh();
  } catch (error) {
    fail(t("a.actionFail", { msg: error.message }));
  }
}

async function saveSettings() {
  const message = document.getElementById("settings-message");
  try {
    await api(`/api/conversations/${convId}/admin/settings`, {
      method: "POST",
      headers: authHeaders(),
      body: {
        status: document.getElementById("setting-status").checked ? "open" : "closed",
        autoApprove: document.getElementById("setting-autoApprove").checked,
        allowSubmissions: document.getElementById("setting-allowSubmissions").checked,
        openData: document.getElementById("setting-openData").checked,
        altUrl: document.getElementById("setting-altUrl").value,
      },
    });
    message.textContent = t("a.saved");
    show(message, true);
    setTimeout(() => show(message, false), 1500);
  } catch (error) {
    message.textContent = t("a.saveFail", { msg: error.message });
    show(message, true);
  }
}

for (const id of ["setting-status", "setting-autoApprove", "setting-allowSubmissions", "setting-openData"]) {
  document.getElementById(id).addEventListener("change", saveSettings);
}
document.getElementById("setting-altUrl").addEventListener("change", saveSettings);

document.getElementById("seed-add").addEventListener("click", async () => {
  const textarea = document.getElementById("seed-text");
  const text = textarea.value.trim();
  if (!text) return;
  try {
    await api(`/api/conversations/${convId}/admin/statements`, {
      method: "POST",
      headers: authHeaders(),
      body: { text },
    });
    textarea.value = "";
    await refresh();
  } catch (error) {
    fail(t("a.seedFail", { msg: error.message }));
  }
});

panel.addEventListener("click", (event) => {
  const target = event.target.closest("button[data-copy]");
  if (!target) return;
  copyText(document.getElementById(target.dataset.copy).textContent, target);
});

document.getElementById("token-save").addEventListener("click", async () => {
  const candidate = extractToken(document.getElementById("token-input").value);
  if (!candidate) return fail(t("a.badToken"));
  token = candidate;
  try {
    sessionStorage.setItem(storageKey, token);
  } catch {
    /* ignore */
  }
  await start();
});

async function start() {
  show(loadError, false);
  try {
    await refresh();
    show(tokenSection, false);
    show(panel, true);
  } catch (error) {
    show(panel, false);
    show(tokenSection, true);
    if (error.message !== "unauthorized") fail(error.message);
    else fail(t("a.invalidToken"));
  }
}

(async () => {
  if (!convId) return fail(t("app.badUrl"));
  token = loadToken();
  if (!token) {
    show(tokenSection, true);
    return;
  }
  await start();
})();
