# 演算法說明與已知偏差

本文件記錄 `src/math/` 的計算管線，以及與官方 polismath（Clojure）之間的已知偏差。實作依據為公開文獻：[compdemocracy.org/algorithms](https://compdemocracy.org/algorithms/) 與 Small et al. 2021《Polis: Scaling Deliberation by Mapping High Dimensional Opinion Spaces》。未閱讀、未取用官方 AGPL 程式碼。

## 管線

### 1. 投票矩陣（`matrix.ts`）

- 列＝參與者、欄＝已核准陳述；同意 = **+1**、不同意 = **−1**、略過 = **0**、未投 = 缺值。
  （注意：官方資料庫的原始編碼相反，agree 為 −1；red-dwarf 與本實作同用 agree=+1。匯出 CSV 時以本表示法為準。）
- **納入門檻**：參與者至少投 `min(7, 陳述數)` 票才進入分群（官方的 in-conversation 規則）。
- **插補**：缺值以該陳述的平均票值填補；再逐欄置中（置中後插補格為 0）。

### 2. 降維（`pca.ts`）

- Power iteration 求前兩主成分（官方同樣以 power method 逼近 PCA），收斂容忍 1e-10、上限 300 迭代，第二主成分以 Gram–Schmidt 對第一主成分正交化。
- **Sparsity-aware projection**（官方作法）：參與者座標只用實際投過的欄位計算，再乘 `sqrt(全部陳述數 / 該參與者投票數)`，避免投票少的人被插補值拉往原點。
- 決定性：PRNG（mulberry32）以 conversation id ＋資料規模為種子，同輸入必得同輸出（有測試）。

### 3. 分群（`kmeans.ts`）

- 參與者 >100 時先做 k=100 的 base clustering，再對 base centers（以群大小加權）分群；≤100 直接分。
- 群數 k 從 2 到 5 逐一嘗試，以 **silhouette 係數**最高者為準（官方相同）。
- k-means：k-means++ 初始化、加權 Lloyd 迭代、空群修補、4 次重啟取 inertia 最低。
- 參與者不足 4 人或所有點重合時不分群（k=1），只出地圖不出群報告。

### 4. 代表性陳述（`repness.ts`）

對每（群 g、陳述 s、方向 d ∈ {agree, disagree}）：

- `prob = (succ_in + 1) / (seen_in + 2)`（pseudocount 平滑）
- `probTest`：單比例 z 近似 `2·√n·(p − 0.5)`，檢定群內是否顯著傾向 d
- `repness = prob / prob_out`（群內機率 ÷ 群外機率，各含 pseudocount）
- `repnessTest`：雙比例 z 檢定（pooled 比例、+1 pseudocount）
- 入選門檻：`probTest > 1.2816`（90% 信賴，官方同值）且 `repnessTest > 1.2816` 且 `repness > 1`
- 排序 metric：`prob × probTest × repness × repnessTest`，每群取前 5；同一陳述兩方向皆入選時取 metric 高者；全滅時退取 metric 最高的一句（每群至少一句）。

### 5. 跨群共識（`repness.ts`）

- Group-aware consensus：對每陳述、每方向，metric ＝ **各群** `(succ_g+1)/(seen_g+2)` 的**乘積**——任何一群不買單，分數就垮。
- 另要求全體單比例檢定 `probTest > 1.2816`。同意與不同意各取前 5。

### 6. 陳述路由（`conversation.ts`）

下一句抽選：在參與者未投過的已核准陳述中，以 `1/(1+已得票數)` 加權隨機——票少的新陳述優先曝光。

## 與官方的已知偏差

| 項目 | 官方 | 本實作 | 理由 |
|---|---|---|---|
| base clustering 的 silhouette | 對 base centers 的加權細節未見於公開文獻 | 未加權 silhouette | 實測（[validation-opendata.md](validation-opendata.md)）：未加權在 3/4 開放資料集選中官方的 k；加權版反而誤選 |
| k 的選擇 | 線上 k-smoothing（k 只在 silhouette 明顯改善時改變，路徑依賴） | 已實作同款 k-smoothing（buffer 0.02，`selectK`）：線上重算時保留前一次的 k，除非新 k 明顯更好；批次（無歷史）仍取最高分 | 批次驗證在稀疏資料上仍可能比官方細分（見 football-concussions 案例，purity 0.835 顯示是再細分而非亂分） |
| comment routing | 帶 extremity 等因子的 priority 公式 | `1/(1+票數)` 加權隨機 | 簡化；效果同向（新句優先） |
| PCA 增量更新 | EMPCA 增量演算法（票進來就更新） | 每次全量重算＋快取（變動後最快 2 秒一次） | 規模目標內全量重算 <1s，簡單勝出 |
| moderation 分級 | strict/moderate 多段 | approve/reject 兩段 | 夠用 |
| 群數上限 | k ≤ 5 | 同 | — |

## 交叉驗證

管理頁匯出的 `votes.csv`（長格式、參與者匿名化為 p1、p2⋯）可轉成官方 participants-votes 格式後餵給 [red-dwarf](https://github.com/polis-community/red-dwarf)（宣稱完整重現官方管線）比對分群結果。歡迎把比對結果開 issue。

## AI 審議綜整管線（Sensemaking Pipeline）

除上述純數學管線外，Pocket Polis 亦提供原生的多方審議綜整（Sensemaking）功能。本設計概念參考了 [g0v/sensemaker-frontend](https://github.com/g0v/sensemaker-frontend/tree/6303d8)（鎖定參照 commit `6303d8`）、[bestian/sensemaker-backend](https://github.com/bestian/sensemaker-backend/tree/164a71)（鎖定參照 commit `164a71`）以及 [bestian/sensemaking-tools](https://github.com/bestian/sensemaking-tools/tree/b5fb897b13c3f25aaffb8fb0d453b4defde1962a)（鎖定參照 commit `b5fb897b13c3f25aaffb8fb0d453b4defde1962a`），並針對 Serverless 與 Cloudflare 免費額度進行了完整的重構與強化：

### 1. 四階段結構化綜整

1. **主題發現（Topic Discovery）**：
   - 以確定性穩定順序輸入陳述。Prompt 以 UTF-8 位元組封頂（`DISCOVERY_PROMPT_MAX_BYTES = 240_000`），所有陳述 ID 都會保留，正文在 UTF-8 邊界截斷。模型歸納 3–7 個語意互斥主題（保留 `other` ID 避免衝突）。`max_tokens: 2048`。
2. **陳述歸類（Categorization）**：
   - 以 50 筆為一批次進行有限並行分類（並行上限 3），`max_tokens: 1536`。每批 Prompt ≤ 32,000 UTF-8 bytes。
   - 支援主要主題與選填次要主題，去重後之聯集計入 `theme.statementIds`。未歸類成功者在額度仍夠時重試 1 次，仍遺漏者確定性指派至 `other`。
3. **群體感知證據池（Evidence Buckets）**：
   - **共識候選集**：交集數學管線方向與 Jigsaw `SummaryStats.minCommonGroundProb = 0.60` 規範（每群偽機率 $(succ+1)/(seen+2) \ge 0.60$；零觀測值為 0.5 自動 fail closed）。送入 Prompt 前依跨群 min-p 排序，上限 24 筆。
   - **分歧張力集**：納入各群代表性陳述與跨群同意率極差 $\ge 35\%$ 之陳述；依跨群同意率極大差距排序，代表性/SID tie-break，上限 24 筆。
   - **隱私安全版結果（`privacySafeMathResult`，k = 3）**：公開 `/results` 與 AI／確定性綜整的輸入一律是同一份隱私安全版，完整版只留在 DO 的 `mathCache`。三層規則：(1) 群下限——見下；(2) 逐格下限——群 ≥ k 時某陳述在該群的 `seen` 仍可能是 1～2，任一群格 `seen < k` 即整列（該陳述所有群的格子）抑制；(3) 互補差分——全體 `statementStats` 減去已公佈群格的餘數（未分群者＋被抑制格）必須為 0 或 ≥ k，否則整列抑制。於是每個可公佈或可推導的池子都 ≥ k。代表性陳述自帶 `nSeen`，`nSeen < k` 者亦移除。
   - **小群 k-匿名（可報告群）**：人數低於 `MIN_GROUP_STATS_SIZE = 3` 的群體（k-means 可能產出 1～2 人群）不可報告：公開 `/results` 以 `redactSmallGroupStats` 移除其 `statementStats` 與 `representative`（代表性陳述對每群至少退而取一句，單人群的代表性方向就是那個人的投票）並標記 `statsRedacted`；證據池、共識排序、Prompt 的群體對比與群體畫像、AI 與確定性群體畫像、張力可指名的群體，一律只含可報告群。小群只以位置與人數出現在意見地圖上。規則生效前已快取的綜整於回傳時以 `dropUnreportableGroups` 依目前分群移除小群畫像與指名小群的張力，不重新生成。
   - **張力配對證據**：引用的陳述必須真的區分被指名的「這一對」群體——兩群皆有觀測且同意率極差 $\ge 35\%$；或恰好只有兩個可報告群時，為其中一群的代表性陳述（out-group 即另一群）。三群以上時 A 的代表性陳述可能只是 A 與 C 不同、A/B 其實一致，因此不足以指名 A/B。確定性 fallback 不預設最大兩群，而是對每一對可報告群取符合上述規則的證據（依極差排序、最多 4 筆），選證據最多的一對；無證據則不產生張力。
4. **嚴格引用審議綜整（Cited Synthesis）**：
   - `max_tokens: 4096`，system+user ≤ 48,000 UTF-8 bytes。
   - `overview`：引用必須屬於最終 Prompt 中實際展示的證據聯集（若引用缺失或無效，則中立化為確定性結構句並給予空引用，不保留模型文本）；參與者與投票脈絡採確定性字串。
   - `commonGround`：摘要採確定性統計描述；keyPoints 引用必須全部有效且具有一致的確定性方向（agree 或 disagree，混合方向整條捨棄）。
   - `tensions`：必須指名真實相比較的兩群體 ID (`groupAId` 與 `groupBId`)，引用必須在該兩群均有真實觀測紀錄 (`seen > 0`)。
   - `groupPortraits`：僅在模型於 fallback 介入前具有經檢定之合法代表立場時採納模型標題與摘要描述，否則退回確定性中立標籤。
   - 入場失敗或階段放不進 9,000 神經元帳本時，回傳 `generationMode: "deterministic"` 的統計摘要（`model: "deterministic"`），可快取為 ready，不標 Gemma。

### 2. Pocket Polis 免費額度與架構特色

- **神經元硬契約（不是平均值）**：`@cf/google/gemma-4-26b-a4b-it` 官方費率 `輸入上限 token × 9091 / 1e6 + max_tokens × 27273 / 1e6`。輸入上限 = `utf8_bytes(system)+utf8_bytes(user)+256`，不是字元數，也不是精確 token。每次 `ai.run` 前同時做本地 `tryReserve` 與部署級 UTC 日協調器原子預留；本應用日上限 **9,000**（低於每日 10,000 免費額 1,000）。同一 Cloudflare 帳號的其他 Worker 不在此協調器內。對話 DO 在第一次模型呼叫前寫入滾動 24h AI 聲明，Queue 重試不能雙花。最終綜整額度先在本地扣留，實際呼叫前仍向協調器預留。
- **Queue ≠ 神經元節省**：Cloudflare Queues（`pocket-polis-sensemaking`；預設與 production 設定刻意指向同一個資料承載 Worker 與 Queue，避免自訂網域部署切換 Durable Object namespace；`max_batch_size: 1`, `max_retries: 1`）只做耐久與延遲隔離。一則 <64KB 訊息最多 **4 次 Queue 操作**（1 寫 + 2 讀 + 1 刪）。成功路徑 3 次。與神經元分屬不同免費額度。每個資料 revision 最多送件一次（`synthesis_enqueued_revision`；送件失敗才解除）：已送件但 15 分鐘逾時的任務不重送，直接以確定性摘要結案，因此上限不會因 consumer 延遲或重試耗盡而被突破。
- **24 小時新鮮度週期**：成功生成後，同 revision 之 ready 快取永久有效（`isStale: false`）；資料變更產生新 revision 時，未滿 24 小時先回傳舊快取並標記 `isStale: true`；滿 24 小時後方允許背景刷新（`refreshPending: true`）並排程重新生成。確定性 fallback 亦持久化為當前 revision 之 `status: "ready"`（`generationMode: "deterministic"`），同 revision 永久有效不重複 enqueue；僅在資料產生新 revision 且超過滾動 24 小時 AI 嘗試窗口後方可再次嘗試 AI 生成。
- **邊緣快取白名單**：透過 Workers Cache API 提供 3s–300s TTL 之邊緣快取，採用嚴格公開白名單（`/`, `/en`, `/guide`, `/en/guide`, `/c/:id`, `/r/:id`, `/api/health`, `/api/conversations/:id` 及 public statements/anonymous results/synthesis），正則化移除所有查詢字串，排除個人化（`?pid=`）、授權標頭、管理端，並支援 `Cache-Control: no-cache` 強制重新整理直通 DO。
- **零付費依賴**：完全運行在 Cloudflare 免費額度內（10,000 神經元/日、10,000 佇列操作/日）。
