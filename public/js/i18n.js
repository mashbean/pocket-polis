// 極簡雙語系統：HTML 內是 zh-Hant 預設文字，en 由字典覆蓋。
// 語言優先序：?lang= → localStorage → 瀏覽器語言（zh* → zh，其餘 en）。
const STORAGE_KEY = "polis-serverless:lang";

// key: [zh, en]。{名稱} 為變數插槽。
export const STRINGS = {
  "app.loading": ["載入中⋯", "Loading…"],
  "app.sourceLink": ["原始碼", "Source"],
  "app.badUrl": ["網址不正確。", "This link is not valid."],
  "nav.zhName": ["口袋審議", ""],
  "app.altBanner": ["這場討論有另一個語言版本，點此前往", "This conversation is also available in another language. Open it"],

  // 參與頁
  "p.title": ["參與討論", "Join the conversation"],
  "p.loadFail": ["無法載入這場討論", "Couldn't load this conversation"],
  "p.agree": ["同意", "Agree"],
  "p.disagree": ["不同意", "Disagree"],
  "p.pass": ["略過／不確定", "Pass / Unsure"],
  "p.progress": ["已投 {voted} / {total} 句", "Voted on {voted} of {total}"],
  "p.progressNote": [
    "投過的意見不會再出現；每一票都會即時更新意見地圖。",
    "Statements you've voted on won't repeat; every vote updates the map instantly.",
  ],
  "p.doneTitle": ["目前的意見你都投完了。", "You've voted on everything for now."],
  "p.doneHint": ["有人提出新意見時，回到這頁就能繼續投。", "Come back any time — new statements may appear."],
  "p.seeReport": ["看意見地圖與結果", "See the opinion map"],
  "p.checkAgain": ["看看有沒有新意見", "Check for new statements"],
  "p.submitTitle": ["提出你自己的意見", "Add your own statement"],
  "p.submitHint": [
    "寫一句大家可以「同意」或「不同意」的完整想法（280 字內）。一次一個想法，避免問句。",
    "Write one complete idea others can agree or disagree with (280 characters max). One idea at a time; avoid questions.",
  ],
  "p.submitPlaceholder": [
    "例：比起新計畫，我們更該先把現有的事情做穩。",
    "e.g., Before starting new projects, we should stabilize what we already run.",
  ],
  "p.submitButton": ["送出意見", "Submit"],
  "p.submitApproved": ["已送出！大家現在就能對你的意見投票。", "Submitted! Everyone can now vote on your statement."],
  "p.submitPending": ["已送出，主持人核准後就會開放投票。", "Submitted — it will open for voting once the host approves it."],
  "p.submitFail": ["送出失敗：{msg}", "Couldn't submit: {msg}"],
  "p.voteFail": ["投票失敗：{msg}", "Vote failed: {msg}"],
  "p.closed": ["這場討論已結束，結果仍然可以看。", "This conversation has ended; the results remain viewable."],
  "p.footerAnon": [
    "參與是匿名的：你的瀏覽器只保存一個隨機代號，用來避免重複計票。",
    "Participation is anonymous: your browser keeps only a random code to prevent double counting.",
  ],
  "p.footerReport": ["結果頁", "Results"],

  // 結果頁
  "r.title": ["結果", "Results"],
  "r.loadFail": ["無法載入結果", "Couldn't load the results"],
  "r.participants": ["參與者", "Participants"],
  "r.votes": ["票", "Votes"],
  "r.statements": ["意見", "Statements"],
  "r.groups": ["意見群", "Opinion groups"],
  "r.aiTitle": ["目前看見什麼", "What we're seeing"],
  "r.aiLoading": ["AI 正在歸納審議共識與群體畫像⋯", "AI is analyzing deliberation consensus and group perspectives…"],
  "r.aiPending": ["AI 正在背景分析多方觀點與議題焦點，請稍候⋯", "AI is analyzing deliberation perspectives in the background…"],
  "r.aiUnavailable": ["AI 綜整暫時無法提供，量化意見地圖與投票數據不受影響。", "AI synthesis is temporarily unavailable. Quantitative map and voting data remain fully accessible."],
  "r.aiInsufficient": ["尚未形成足夠分群以進行 AI 跨群綜整（需 4 人以上且 2 群以上）。", "Not enough participant clustering yet for AI synthesis (requires 4+ participants and 2+ groups)."],
  "r.aiModelTag": ["AI 綜整 · Gemma 4 26B", "AI synthesis · Gemma 4 26B"],
  "r.aiModelDeterministic": ["統計摘要", "Statistical summary"],
  "r.aiGeneratedAt": ["生成於 {time}", "Generated at {time}"],
  "r.aiStale": ["先前分析快照（陳述已更新）", "Previous snapshot (statements updated)"],
  "r.aiStaleNotice": [
    "自上次分析產出後已有新投票或意見，下方展示先前產出時之完整分析（每 24 小時至多重新綜整一次）：",
    "New votes or statements have been added since last analysis. Showing prior snapshot (refreshes at most once every 24h):",
  ],
  "r.provenance": [
    "依據 {s} 則意見、{v} 票、{p} 位參與者之數據分析",
    "Based on {s} statements, {v} votes, {p} participants at generation time",
  ],
  "r.evidenceQuote": ["引用意見", "Cited statement"],
  "r.clearFilter": ["清除篩選", "Clear filter"],
  "r.backToAll": ["顯示全部意見", "Show all statements"],
  "r.filterByTheme": ["看此主題意見", "View statements"],
  "r.themesTitle": ["依主題篩選", "Filter by theme"],
  "r.themesHint": ["選一個主題，只查看相關意見與投票分布。", "Choose a theme to show only its statements and voting breakdowns."],
  "r.allThemes": ["全部主題", "All themes"],
  "r.themeStatements": ["{n} 則意見", "{n} statements"],
  "r.deepAnalysisTitle": ["深入理解這場討論", "Explore this conversation"],
  "r.deepAnalysisHint": ["查看主題、跨群共識、關鍵張力與推進問題", "See common ground, tensions, themes, and bridging questions"],
  "r.consensusTensionTitle": ["共識、張力與推進問題", "Common ground, tensions & next questions"],
  "r.commonGroundSubtitle": ["跨群共識與共同價值", "Cross-group common ground"],
  "r.tensionsSubtitle": ["群間分歧與推進對話提問", "Differences in perspective & bridging questions"],
  "r.tensionsHint": ["立場差異最顯著的張力所在，以及有助於促進共識的對話切入點。", "Where perspectives diverge most strongly, alongside constructive questions to bridge the divide."],
  "r.tensionsEmpty": ["目前各意見群體間尚未形成顯著的張力或對立焦點。", "No significant cross-group tensions identified yet."],
  "r.groupPerspective": ["第 {label} 群觀點：", "Group {label} perspective:"],
  "r.bridgingQuestionLabel": ["促進共識的提問：", "Bridging question: "],
  "r.groupPortraitsTitle": ["各群視角畫像", "Group Perspective Portraits"],
  "r.mapTitle": ["意見地圖", "Opinion map"],
  "r.mapHint": [
    "每個點是一位參與者：投票越相似的人靠得越近，顏色代表想法相近的群。投票數還不夠的參與者暫時不會出現。",
    "Each dot is one participant: the more similarly two people voted, the closer they sit, and colors mark groups of like-minded voters. Participants with too few votes yet don't appear.",
  ],
  "r.mapEmpty": ["投票的人夠多之後，這裡會長出意見地圖。", "The map appears once enough people have voted."],
  "r.youNote": ["標著「你」的深色圓點，就是你的位置。", "The dark dot labeled \"You\" is where you are."],
  "r.consensusTitle": ["跨群共識", "Common ground"],
  "r.consensusHint": [
    "每一群都傾向同一邊的意見，也就是立場不同的人仍然共享的看法。",
    "Statements every group leans the same way on — what people share despite their differences.",
  ],
  "r.consensusEmpty": ["還沒有跨群共識的意見（或投票數還不夠）。", "No common ground yet (or not enough votes)."],
  "r.bridgingSubtitle": ["橋接排序", "Bridging rank"],
  "r.bridgingHint": [
    "扣掉立場軸之後仍然被同意的陳述排在前面：同樣的同意率，被單一陣營撐起來的會往後掉。方法與 Community Notes、Agora 的 bridging-based ranking 同源。",
    "Statements still agreed with after the opinion axis is factored out rank first: at the same raw agreement, a statement carried by one camp drops. Same family of method as Community Notes and Agora bridging-based ranking.",
  ],
  "r.bridgingEmpty": ["納入分群的人還不夠（至少 4 人），還算不出橋接排序。", "Not enough clustered participants yet (at least 4) to compute a bridging rank."],
  "r.bridgingScore": ["橋接 {score}", "Bridging {score}"],
  "r.bridgingPolarity": ["極化 {polarity}%", "Polarized {polarity}%"],
  "r.mostlyAgree": ["多數同意", "Mostly agree"],
  "r.mostlyDisagree": ["多數不同意", "Mostly disagree"],
  "r.groupsTitle": ["各群在意什麼", "What each group cares about"],
  "r.groupsHint": [
    "這些意見最能區分這個群和其他群（差異經過統計檢定確認）。",
    "The statements that most distinguish each group from the others (statistically tested).",
  ],
  "r.groupsEmpty": ["夠多人投夠多票之後（4 人以上），會自動分出意見群。", "Groups appear automatically once 4+ people have voted enough."],
  "r.groupLabel": ["群 {label} · {size} 人", "Group {label} · {size} people"],
  "r.groupChip": ["{label} 群 · {size}", "Group {label} · {size}"],
  "r.you": ["你", "You"],
  "r.repLine": ["{p}% {dir}（其他群的 {x} 倍）", "{p}% {dir} ({x}× the other groups)"],
  "r.agreeWord": ["同意", "agree"],
  "r.disagreeWord": ["不同意", "disagree"],
  "r.groupNone": ["還沒有顯著的代表性意見。", "No distinctive statements yet."],
  "r.groupTooSmall": ["人數過少，為保護匿名不顯示這一群的投票統計與代表性意見。", "Too few people in this group; its vote statistics and distinctive statements are withheld to protect anonymity."],
  "r.allTitle": ["全部意見", "All statements"],
  "r.allHint": ["所有經審核通過的意見陳述及其全體投票分布。", "All approved statements and their overall voting distributions."],
  "r.allEmpty": ["還沒有意見。", "No statements yet."],
  "r.counts": [
    "{ap}% 同意（{a}）· {dp}% 不同意（{d}）· 略過 {p}",
    "{ap}% agree ({a}) · {dp}% disagree ({d}) · pass {p}",
  ],
  "r.participate": ["去投票", "Vote now"],
  "r.refresh": ["重新整理結果", "Refresh"],
  "r.computedAt": [
    "最後更新：{time}（已有 {n} 人投滿 {m} 句、進入地圖）",
    "Last updated {time} ({n} participants with {m}+ votes are on the map)",
  ],
  "r.methodNote": ["分群方法說明", "How the clustering works"],
  "r.exportTitle": ["資料與其他工具", "Data & other tools"],
  "r.exportSummary": ["下載匿名資料，或交給其他工具繼續分析", "Download anonymized data or continue in another tool"],
  "r.exportComments": ["下載 comments.csv", "Download comments.csv"],
  "r.exportTttc": ["下載 tttc.csv", "Download tttc.csv"],
  "r.exportStatements": ["下載 statements.csv", "Download statements.csv"],
  "r.exportVotes": ["下載 votes.csv", "Download votes.csv"],
  "r.exportTttcNote": [
    "tttc.csv 是 Talk to the City 的匯入格式（id,interview,comment），只含已核准意見，來源以 host 與 pN 匿名代號標記。",
    "tttc.csv is the Talk to the City import format (id,interview,comment): approved statements only, sources marked as host or the anonymized pN participant codes.",
  ],
  "r.exportTttcLink": ["Talk to the City →", "Talk to the City →"],
  "r.exportWorkbenchNote": [
    "statements.csv 與 votes.csv 是 delib 資料工作台的輸入，可在瀏覽器內驗證後轉成 TTTC 或 Agora 格式，或整理成公開成果收據。",
    "statements.csv and votes.csv feed the delib data workbench, which validates them in the browser and converts to TTTC or Agora formats or a public result receipt.",
  ],
  "r.exportWorkbench": ["delib 資料工作台 →", "delib data workbench →"],
  "r.exportNote": [
    "與 pol.is 報告頁匯出的 comments.csv 同格式，可直接上傳到 AI 意見綜整工具；作者欄以流水號匿名化。",
    "Same format as the comments.csv from a pol.is report, ready for AI sensemaking tools; authors are anonymized as sequence numbers.",
  ],
  "r.exportSensemaker": ["試試 vTaiwan Sensemaker →", "Try vTaiwan Sensemaker →"],
  // 管理頁
  "a.title": ["管理頁", "Host controls"],
  "a.manage": ["管理：{title}", "Hosting: {title}"],
  "a.needToken": [
    "需要管理金鑰。請貼上建立討論時取得的管理連結或 32 碼金鑰：",
    "A host key is required. Paste the admin link (or the 32-character key) you received when creating the conversation:",
  ],
  "a.tokenPlaceholder": ["管理連結或金鑰", "Admin link or key"],
  "a.enter": ["進入管理", "Enter"],
  "a.badToken": ["看不出金鑰格式（應為 32 碼十六進位）。", "That doesn't look like a key (expected 32 hex characters)."],
  "a.invalidToken": ["金鑰無效或已失效。", "This key is not valid."],
  "a.shareTitle": ["分享連結", "Share links"],
  "a.participateLink": ["參與連結", "Participation link"],
  "a.reportLink": ["結果頁", "Results page"],
  "a.adminLink": ["管理連結（含金鑰，只給共同主持人）", "Admin link (includes the key — co-hosts only)"],
  "a.copy": ["複製", "Copy"],
  "a.copied": ["已複製", "Copied"],
  "a.statusTitle": ["討論狀態", "Conversation status"],
  "a.settingsTitle": ["進階設定", "Advanced settings"],
  "a.settingsHint": ["調整投稿審核、資料公開與其他語言版本", "Adjust moderation, data access, and another-language links"],
  "a.settingOpen": ["開放投票中（取消勾選即結束討論）", "Voting open (untick to close the conversation)"],
  "a.settingAutoApprove": ["新意見直接公開（否則需你核准）", "New statements publish immediately (otherwise you approve each one)"],
  "a.settingAllowSubmissions": ["開放參與者提出意見", "Participants can add statements"],
  "a.settingAltUrl": [
    "另一語言版本的連結（選填，會顯示在參與與結果頁）",
    "Link to another-language version (optional; shown on the participate and results pages)",
  ],
  "a.settingOpenData": ["公開資料下載（任何人可下載匿名化 CSV）", "Public data export (anyone can download the anonymized CSV)"],
  "a.saved": ["已儲存。", "Saved."],
  "a.saveFail": ["儲存失敗：{msg}", "Couldn't save: {msg}"],
  "a.pendingTitle": ["待核准意見（{n}）", "Waiting for approval ({n})"],
  "a.pendingEmpty": ["沒有待核准的意見。", "Nothing waiting for approval."],
  "a.approve": ["核准", "Approve"],
  "a.reject": ["退回", "Reject"],
  "a.unpublish": ["下架", "Unpublish"],
  "a.republish": ["重新上架", "Republish"],
  "a.actionFail": ["操作失敗：{msg}", "Action failed: {msg}"],
  "a.seedTitle": ["新增種子意見", "Add a seed statement"],
  "a.seedPlaceholder": ["以主持人身分加入一句意見（直接公開）", "Add a statement as the host (publishes immediately)"],
  "a.seedAdd": ["加入", "Add"],
  "a.seedFail": ["新增失敗：{msg}", "Couldn't add: {msg}"],
  "a.allTitle": ["全部意見", "All statements"],
  "a.allSummary": ["查看已公開、待核准與已退回的完整清單", "Review the full published, pending, and rejected list"],
  "a.statusApproved": ["公開中", "Published"],
  "a.statusPending": ["待核准", "Pending"],
  "a.statusRejected": ["已退回", "Rejected"],
  "a.countsSeed": ["同意 {a} · 不同意 {d} · 略過 {p}{seed}", "Agree {a} · Disagree {d} · Pass {p}{seed}"],
  "a.seedMark": [" · 種子", " · seed"],
  "a.exportTitle": ["資料與整合", "Data & integrations"],
  "a.exportSummary": ["下載匿名資料，或連接分析工具與 AI 助手", "Download anonymized data or connect analysis tools and AI assistants"],
  "a.exportComments": ["下載 comments.csv（pol.is 格式）", "Download comments.csv (pol.is format)"],
  "a.exportStatements": ["下載意見清單 CSV", "Download statements.csv"],
  "a.exportVotes": ["下載投票紀錄 CSV（匿名化）", "Download votes.csv (anonymized)"],
  "a.exportNote": [
    "comments.csv 與 pol.is 報告頁匯出的同格式，可直接上傳 vTaiwan Sensemaker 做 AI 意見綜整（開啟「公開資料下載」後，結果頁也會出現下載鈕）；投票紀錄以 p1、p2⋯ 匿名化，可交給任何分析工具（例如 red-dwarf）交叉驗證。",
    "comments.csv matches the pol.is report export and can go straight into vTaiwan Sensemaker for AI-assisted synthesis (with public data export on, the report page shows the download too); votes are anonymized as p1, p2, … and work with external analysis tools (e.g. red-dwarf).",
  ],
  "a.mcpTitle": ["連接 AI 助手（MCP）", "Connect an AI assistant (MCP)"],
  "a.mcpHint": [
    "進階使用者可以讓支援 MCP 的 AI 助手讀取公開結果或協助主持；一般使用完全不需要設定。",
    "Advanced users can let an MCP-capable AI assistant read public results or help host; ordinary use requires no setup.",
  ],
  "a.mcpDocs": ["查看 MCP 設定與權限說明 →", "Read the MCP setup and permissions guide →"],
  "a.footerNote": [
    "管理金鑰只存在此分頁的 sessionStorage，關閉分頁即清除。",
    "The host key lives only in this tab's sessionStorage and is cleared when the tab closes.",
  ],

  // 公開議題列表
  "x.navLink": ["大家的議題", "Community topics"],
  "x.title": ["大家的議題", "Community topics"],
  "x.lede": [
    "這裡列出在這個公用站上、建立者選擇公開資料的討論。點進去就能投票，不用註冊。",
    "Conversations hosted here whose creators chose to make the data public. Open one and vote — no sign-up.",
  ],
  "x.disclaimerTitle": ["這些議題不是 mashbean（豆泥）建立的", "These topics were not created by mashbean"],
  "x.disclaimer": [
    "每一場討論都由使用這個公用站的人自己發起，題目、說明與意見都出自發起人與參與者，不代表站方的立場，也未經站方查證或背書。出現騷擾、仇恨言論、違法內容、洩露個資或灌票操弄時，站方會依行為準則直接下架，不另行通知。",
    "Every conversation here was started by whoever used this public site. The topics, descriptions, and statements come from those people, not from the site operator, and are neither vetted nor endorsed. Conversations involving harassment, hate speech, illegal content, exposure of personal data, or coordinated manipulation are taken down under the Code of Conduct without prior notice.",
  ],
  "x.cocLink": ["讀行為準則", "Read the Code of Conduct"],
  "x.reportLink": ["回報違規議題", "Report a violation"],
  "x.searchPlaceholder": ["搜尋題目或說明", "Search topics and descriptions"],
  "x.searchButton": ["搜尋", "Search"],
  "x.filterLabel": ["狀態", "Status"],
  "x.filterAll": ["全部", "All"],
  "x.filterOpen": ["進行中", "Open"],
  "x.filterClosed": ["已結束", "Closed"],
  "x.statusOpen": ["進行中", "Open"],
  "x.statusClosed": ["已結束", "Closed"],
  "x.total": ["共 {n} 場討論", "{n} conversations"],
  "x.totalFiltered": ["符合「{q}」的有 {n} 場", "{n} conversations match \u201c{q}\u201d"],
  "x.empty": ["目前沒有符合的議題。", "No conversations match yet."],
  "x.emptyHint": [
    "建立討論時展開「調整審核與資料設定」、勾選「公開資料下載」，討論就會出現在這份列表。",
    "To appear in this list, open \u201cAdjust moderation and data settings\u201d when creating a conversation and tick \u201cPublic data export\u201d.",
  ],
  "x.loadFail": ["無法載入議題列表", "Couldn\u2019t load the list"],
  "x.loadMore": ["看更多", "Load more"],
  "x.join": ["加入投票", "Join"],
  "x.report": ["看意見地圖", "See the map"],
  "x.created": ["{date} 建立", "Created {date}"],
  "x.noDescription": ["（發起人沒有寫說明）", "(no description given)"],
  "x.createTitle": ["你也可以開一場", "Start your own"],
  "x.createHint": [
    "寫一個題目、幾句種子意見，一分鐘就能開始收集大家的想法。",
    "Write a question and a few seed statements — you can be collecting views within a minute.",
  ],
  "x.createButton": ["一鍵發起", "Start in one step"],
};

export function currentLang() {
  const fromQuery = typeof location !== "undefined" ? new URLSearchParams(location.search).get("lang") : null;
  if (fromQuery === "en" || fromQuery === "zh") {
    try {
      localStorage.setItem(STORAGE_KEY, fromQuery);
    } catch {
      /* ignore */
    }
    return fromQuery;
  }
  try {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    /* ignore */
  }
  const navLang = typeof navigator !== "undefined" && typeof navigator.language === "string" ? navigator.language : "zh";
  return navLang.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let lang = currentLang();

export function t(key, vars = {}) {
  const entry = STRINGS[key];
  let text = entry ? entry[lang === "en" ? 1 : 0] : key;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

export function applyI18n(root = document) {
  document.documentElement.lang = lang === "en" ? "en" : "zh-Hant";
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder));
  }
  const home = document.getElementById("home-link");
  if (home) home.href = lang === "en" ? "/en" : "/";
}

/** 在指定節點掛上「中文｜EN」切換 */
export function mountLangSwitch(node) {
  if (!node) return;
  const other = lang === "en" ? "zh" : "en";
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = lang === "en" ? "中文" : "EN";
  link.setAttribute("aria-label", "Switch language");
  link.addEventListener("click", (event) => {
    event.preventDefault();
    try {
      localStorage.setItem(STORAGE_KEY, other);
    } catch {
      /* ignore */
    }
    const url = new URL(location.href);
    url.searchParams.delete("lang");
    location.href = url.toString();
  });
  node.append(link);
}

export { lang };
