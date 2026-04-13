import { useState, useEffect, useCallback, useRef } from "react";

// ─── Firestore 設定 ───────────────────────────────────────────────────────────
const FIRESTORE_PROJECT = "coreaee-65e7f";
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/briefings/latest`;
const GITHUB_OWNER = "s7788";
const GITHUB_REPO = "VibeCoding-News";
const GITHUB_WORKFLOW = "update-news.yml";
const GITHUB_REF = "master";
const DEV_TRIGGER_TOKEN_KEY = "news-briefing-dev-update-token";

async function fetchBriefingFromFirestore() {
  const res = await fetch(FIRESTORE_URL);
  if (!res.ok) throw new Error(`Firestore HTTP ${res.status}`);
  const doc = await res.json();
  // doc.fields.payload は JSON 文字列として保存
  const raw = doc?.fields?.payload?.stringValue;
  if (!raw) throw new Error("payload field missing");
  const data = JSON.parse(raw);
  const updatedAt = doc?.fields?.updatedAt?.stringValue || null;
  return { ...data, _updatedAt: updatedAt, _fromFirestore: true };
}

function isDevTriggerEnabled() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return window.location.hostname === "localhost" || params.get("devUpdate") === "1";
}

async function dispatchUpdateWorkflow(token, reason) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: GITHUB_REF,
        inputs: {
          reason,
        },
      }),
    }
  );

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const payload = await res.json();
      if (payload?.message) detail = payload.message;
    } catch {
      // Keep the HTTP status text if the body is not JSON.
    }
    throw new Error(`GitHub API ${res.status}: ${detail}`);
  }
}

// ─── 分頁定義 ─────────────────────────────────────────────────────────────────
const SECTIONS = [
  "市場總覽",
  "美台股因素",
  "科技股焦點",
  "美伊戰爭",
  "川普動態",
  "AI 前沿",
  "GitHub 熱門",
];

// ─── 市場數據 ─────────────────────────────────────────────────────────────────
const marketData = {
  indices: [
    { name: "道瓊工業", value: "待同步", change: "", pct: "--", prev: "-", weekly: "-", color: "#87867f" },
    { name: "納斯達克", value: "待同步", change: "", pct: "--", prev: "-", weekly: "-", color: "#87867f" },
    { name: "S&P 500", value: "待同步", change: "", pct: "--", prev: "-", weekly: "-", color: "#87867f" },
    { name: "比特幣", value: "待同步", change: "", pct: "--", prev: "-", weekly: "-", color: "#87867f" },
  ],
  extra: [
    { name: "WTI 原油", value: "待同步", pct: "--" },
    { name: "布蘭特原油", value: "待同步", pct: "--" },
    { name: "黃金", value: "待同步", pct: "--" },
    { name: "10Y 殖利率", value: "待同步", pct: "--" },
  ],
};

function findMetric(metrics = [], name) {
  return metrics.find((item) => item.name === name) || null;
}

function buildUsFactors(liveMarket) {
  const extra = liveMarket?.extra || [];
  const wti = findMetric(extra, "WTI 原油");
  const gold = findMetric(extra, "黃金");
  const treasury = findMetric(extra, "10Y 殖利率");

  return [
    {
      category: "總經 / Fed",
      icon: "🏦",
      color: "#1d4ed8",
      items: [
        { label: "Fed 利率決策", value: "按兵不動（機率 98%）", impact: "neutral", note: "接下來仍以 CPI、PCE 與就業數據作為利率路徑觀察重點" },
        { label: "10Y 殖利率", value: treasury?.value || "待更新", impact: "neutral", note: "長天期殖利率反映市場對成長、通膨與降息時程的再定價" },
        { label: "Q4 GDP / PCE", value: "本週總經數據密集", impact: "neutral", note: "若通膨高於預期，科技股與高估值資產波動可能放大" },
      ],
    },
    {
      category: "地緣政治",
      icon: "🌍",
      color: "#b91c1c",
      items: [
        { label: "中東局勢", value: "持續影響油價與避險資產", impact: "bearish", note: "若衝突升級，能源、航運與股市風險偏好會同步受衝擊" },
        { label: "中美貿易政策", value: "關稅與談判訊號反覆", impact: "bearish", note: "半導體、電動車與出口鏈最容易受到政策 headline 影響" },
        { label: "全球風險偏好", value: "依能源與利率方向擺動", impact: "neutral", note: "市場情緒通常與油價、殖利率、美元強弱連動" },
      ],
    },
    {
      category: "能源 / 商品",
      icon: "⛽",
      color: "#166534",
      items: [
        { label: "WTI 原油", value: wti ? `${wti.value}（${wti.pct}）` : "待更新", impact: "neutral", note: "油價會直接影響航空、運輸、化工與通膨預期" },
        { label: "黃金", value: gold ? `${gold.value}（${gold.pct}）` : "待更新", impact: "neutral", note: "黃金常反映避險需求與美元、實質利率變化" },
        { label: "商品價格", value: "觀察油金與殖利率聯動", impact: "neutral", note: "商品波動會影響風險資產輪動與資金配置節奏" },
      ],
    },
    {
      category: "企業財報",
      icon: "📊",
      color: "#7c3aed",
      items: [
        { label: "財報季", value: "進入高密度公告期", impact: "neutral", note: "市場更在意指引、資本支出與 AI 需求是否延續" },
        { label: "Mag 7 評價", value: "仍主導指數方向", impact: "neutral", note: "大型科技股只要財報或展望偏離預期，就會擴大大盤波動" },
        { label: "景氣敏感股", value: "受油價與總經數據牽動", impact: "neutral", note: "航空、金融、工業與半導體容易同步反映市場風向" },
      ],
    },
  ];
}

function buildTwFactors(liveTw) {
  const taiexValue = liveTw?.taiex ? `${liveTw.taiex}（${liveTw.taiex_pct || "待更新"}）` : "待更新";
  const usdTwdValue = liveTw?.usd_twd || "待更新";
  const tsmAdrValue = liveTw?.tsm ? `${liveTw.tsm}（${liveTw.tsm_pct || "待更新"}）` : "待更新";

  return [
    {
      category: "台股核心動能",
      icon: "🇹🇼",
      color: "#0f766e",
      items: [
        { label: "台股加權指數", value: taiexValue, impact: "neutral", note: "以當日即時資料為準，觀察權值股與金融股是否同步表態" },
        { label: "TSM ADR", value: tsmAdrValue, impact: "bullish", note: "美股 ADR 走勢常是隔日台積電與半導體族群的重要先行指標" },
        { label: "美元兌台幣", value: usdTwdValue, impact: "neutral", note: "匯率會影響外資流向，也會牽動出口股的獲利預期" },
        { label: "外資動向", value: "觀察期現貨同步方向", impact: "neutral", note: "指數是否站穩通常仍取決於外資在權值股上的態度" },
      ],
    },
    {
      category: "供應鏈 / 出口",
      icon: "🏭",
      color: "#c2410c",
      items: [
        { label: "AI 伺服器鏈", value: "台積電 / 廣達 / 緯穎", impact: "bullish", note: "若北美 CSP 資本支出續強，AI 供應鏈仍是台股主軸" },
        { label: "傳產 / 航運", value: "受油價與景氣預期影響", impact: "neutral", note: "能源與運價變化會直接影響航運、塑化與航空表現" },
        { label: "出口需求", value: "觀察匯率與接單動能", impact: "neutral", note: "出口鏈需要同時觀察美元、終端需求與庫存調整節奏" },
      ],
    },
    {
      category: "利率 / 資金",
      icon: "💰",
      color: "#1d4ed8",
      items: [
        { label: "國際利率", value: "美債殖利率仍是主導變數", impact: "neutral", note: "美債走高通常壓抑評價，走低則有利成長股擴張估值" },
        { label: "台股資金面", value: "留意成交量與融資變化", impact: "neutral", note: "若量能無法放大，指數容易在高檔震盪而非單邊上攻" },
        { label: "三大法人", value: "外資 / 投信 / 自營商", impact: "neutral", note: "籌碼是否同向，往往決定短線盤勢延續力" },
      ],
    },
    {
      category: "重點族群觀察",
      icon: "🔍",
      color: "#7c3aed",
      items: [
        { label: "半導體", value: "AI 與先進製程仍是主線", impact: "bullish", note: "先進製程、CoWoS、HBM 相關概念股最受市場關注" },
        { label: "ODM / 伺服器", value: "跟隨北美 AI 資本支出", impact: "bullish", note: "伺服器供應鏈受雲端資本支出與交貨節奏影響最大" },
        { label: "電動車 / 傳產", value: "受全球景氣與政策波動", impact: "bearish", note: "若需求降溫或關稅升高，相關族群獲利預期會先被下修" },
      ],
    },
  ];
}

// ─── 科技股 ─────────────────────────────────────────────────────────────────
const techNews = [
  {
    ticker: "NVDA",
    title: "輝達停火後飆漲，Goldman 稱科技股估值已低於大盤",
    detail: "停火消息後 NVDA 盤前漲逾 6%。Goldman Sachs 指出科技超大市值股相對預期成長的估值已跌破大盤水位，稱「長線佈局機會浮現」。Mag 7 今年表現持續跑輸 S&P 500。",
    tags: ["停火反彈", "估值機會", "Goldman 看好"],
    sentiment: "bullish",
  },
  {
    ticker: "TSLA",
    title: "特斯拉反彈但 JPMorgan 警告恐再跌 60%",
    detail: "停火帶動 TSLA 盤前漲 4-10%。但 JPMorgan 發布報告稱以目前估值，特斯拉仍有大幅下修風險。Q1 交付 358K 輛不及預期，庫存堆積 5 萬輛。4/22 將公布 Q1 財報。",
    tags: ["停火反彈", "JPM 警告", "4/22 財報"],
    sentiment: "bearish",
  },
  {
    ticker: "DAL",
    title: "達美航空財報超預期，航空股全面飆漲",
    detail: "達美 Q1 營收與獲利均超越華爾街預期。停火後油價暴跌 17% 至 $93，航空與郵輪股全面噴出——United、Southwest 漲逾雙位數，嘉年華與皇家加勒比同步大漲。",
    tags: ["財報超預期", "油價暴跌", "航空復甦"],
    sentiment: "bullish",
  },
  {
    ticker: "AAPL",
    title: "Apple 折疊 iPhone 工程測試出問題，恐延後出貨",
    detail: "Nikkei 報導蘋果首款折疊 iPhone 在工程測試階段遇到超出預期的問題，最壞情況下量產與出貨可能延遲數月。",
    tags: ["折疊手機", "延遲風險"],
    sentiment: "bearish",
  },
];

// ─── 美伊戰爭 ────────────────────────────────────────────────────────────────
const iranWar = [
  { date: "4/8", event: "🕊️ 川普宣布與伊朗達成「雙邊停火」兩週，暫停所有攻擊行動" },
  { date: "4/8", event: "伊朗同意兩週內開放荷莫茲海峽，需與伊朗武裝部隊協調通行" },
  { date: "4/8", event: "以色列同意遵守停火，但表示將繼續在黎巴嫩的軍事行動" },
  { date: "4/7", event: "巴基斯坦總理請求川普延長截止日兩週，伊朗同步開放海峽作為善意" },
  { date: "4/7", event: "川普發文威脅「週二將是電廠日和橋樑日」，油價盤中飆至 $117" },
  { date: "4/6", event: "美以聯軍轟炸伊朗哈格島（戰略石油設施），VP Vance 稱非策略變更" },
  { date: "4/5", event: "被擊落 F-15 飛行員歷經 24 小時躲藏後成功獲救" },
];

// ─── 川普發言時序 ────────────────────────────────────────────────────────────
const trumpStatements = [
  {
    date: "4/8 凌晨",
    platform: "Truth Social",
    type: "停火宣告",
    color: "#166534",
    quote: "IRAN has agreed to a 2-WEEK CEASEFIRE, starting immediately. They will open the Strait of Hormuz. This is a GREAT DEAL for the World!",
    impact: "油價暴跌 17%，全球股市大反彈",
  },
  {
    date: "4/8 上午",
    platform: "Truth Social",
    type: "威嚇降溫",
    color: "#b45309",
    quote: "Iran better not violate this ceasefire. We know where every General is. VP Vance is watching carefully.",
    impact: "市場維持偏多，黃金小幅回落",
  },
  {
    date: "4/7 晚",
    platform: "Truth Social",
    type: "軍事威脅",
    color: "#b91c1c",
    quote: "TUESDAY WILL BE POWER PLANT DAY AND BRIDGE DAY unless Iran opens the Strait NOW.",
    impact: "油價盤中飆至 $117，股市急跌",
  },
  {
    date: "4/7 下午",
    platform: "白宮記者會",
    type: "關稅警告",
    color: "#b91c1c",
    quote: "If China doesn't come to the table, tariffs go to 104% next week. They need us more than we need them.",
    impact: "美元走強，A股承壓，台股電子股短線回落",
  },
  {
    date: "4/6",
    platform: "Truth Social",
    type: "制裁宣告",
    color: "#7c3aed",
    quote: "Any country purchasing Iranian oil will face SECONDARY SANCTIONS. No exceptions. The world must choose.",
    impact: "布蘭特原油漲至 $109，亞洲買家陷入兩難",
  },
  {
    date: "4/5",
    platform: "Truth Social",
    type: "關稅週年",
    color: "#1d4ed8",
    quote: "One year ago, Liberation Day changed the world. American manufacturing is BACK. We will keep winning.",
    impact: "市場反應冷淡，分析師指出製造業就業實際減少 89K",
  },
  {
    date: "4/4",
    platform: "Fox News 專訪",
    type: "藥品關稅",
    color: "#7c3aed",
    quote: "Big Pharma will pay 100% tariffs if they don't make their drugs in America. It's very simple.",
    impact: "藥廠股盤前下跌，多數大廠因豁免條款實際影響有限",
  },
];

const trumpPolicy = [
  { icon: "🕊️", title: "宣布美伊雙邊停火兩週", desc: "川普稱已收到伊朗 10 點方案，認為是「可行的談判基礎」。停火條件：伊朗完全、立即、安全開放荷莫茲海峽。油價暴跌 17%。" },
  { icon: "💊", title: "藥品關稅 100%（大量豁免）", desc: "「解放日」一週年，簽署新行政命令。多數大型藥企因已增加美國製造而實際稅率為 0%。" },
  { icon: "🔩", title: "鋼鋁銅關稅調整計算方式", desc: "稅率維持 50% 但改以美國現貨價計算，實際進口商繳稅額將增加。含金屬低於 15% 產品可豁免。" },
  { icon: "⚖️", title: "Section 301 調查啟動", desc: "針對多國展開新一輪貿易調查，中國同步反調查。5 月川習峰會在即，為新一波關稅戰做準備。" },
];

// ─── AI 各家更新 ─────────────────────────────────────────────────────────────
const aiCompanyUpdates = [
  {
    company: "Anthropic / Claude",
    logo: "🟠",
    color: "#c96442",
    bgColor: "#fef3ec",
    model: "Claude Sonnet 4.6",
    updates: [
      { date: "4/8", type: "模型更新", title: "Claude Sonnet 4.6 正式上線", desc: "推理能力大幅提升，coding benchmark 達 87.2%，支援 200K context window。Claude Code 工具整合深度加強。" },
      { date: "4/7", type: "功能更新", title: "MCP 突破 9,700 萬安裝", desc: "Model Context Protocol 成為 AI Agent 連接外部工具的產業標準，Linux 基金會接手開放治理。" },
      { date: "4/5", type: "研究發布", title: "Constitutional AI 2.0 論文", desc: "新一代 AI 對齊框架，支援自監督倫理訓練，已整合進 Claude 4.x 全系列。" },
    ],
  },
  {
    company: "OpenAI",
    logo: "⚫",
    color: "#141413",
    bgColor: "#f5f4ed",
    model: "GPT-5 / o3",
    updates: [
      { date: "4/8", type: "模型更新", title: "GPT-5 API 全面開放", desc: "GPT-5 正式向所有 API 用戶開放，多模態能力包含影片理解。推理速度比 GPT-4o 快 2.3 倍。" },
      { date: "4/6", type: "產品更新", title: "ChatGPT Memory 全球推出", desc: "長期記憶功能向所有付費用戶開放，可記住對話偏好、工作習慣與個人資訊。" },
      { date: "4/4", type: "工具發布", title: "Codex CLI 開源版釋出", desc: "OpenAI Codex 命令列工具正式開源，支援本地執行、代碼審查與自動測試生成。" },
    ],
  },
  {
    company: "Google / DeepMind",
    logo: "🔵",
    color: "#1a73e8",
    bgColor: "#f0f4ff",
    model: "Gemini 2.5 Pro",
    updates: [
      { date: "4/9", type: "模型更新", title: "Gemini 2.5 Pro 推出「深度思考」模式", desc: "新增多步驟推理模式，數學與科學 benchmark 達業界最高。Google AI Studio 免費試用。" },
      { date: "4/7", type: "功能更新", title: "NotebookLM 整合 Gemini 2.5", desc: "研究筆記助手升級，可分析 100+ 份文件，自動生成摘要播客與互動式問答。" },
      { date: "4/5", type: "產品更新", title: "Google Workspace AI 全面升級", desc: "Docs、Sheets、Gmail 全面整合 Gemini 2.5，自動起草、資料分析、郵件摘要同步上線。" },
    ],
  },
  {
    company: "Microsoft / Copilot",
    logo: "🟦",
    color: "#0078d4",
    bgColor: "#eff6ff",
    model: "Copilot + GPT-5",
    updates: [
      { date: "4/8", type: "產品更新", title: "GitHub Copilot 月 PR 量突破 4,300 萬", desc: "2025 年 GitHub 年度 commit 破 10 億次。Copilot Workspace 全面支援多文件重構與測試生成。" },
      { date: "4/7", type: "功能更新", title: "Windows Copilot+ PC AI 功能擴充", desc: "Recall 功能在歐洲市場上線，Timeline AI 搜尋歷史操作記錄。支援本地 Phi-4 模型執行。" },
      { date: "4/5", type: "企業更新", title: "Microsoft 365 Copilot 企業版升價", desc: "月費從 $30 調至 $35，新增 AI 代理建立器、會議即時翻譯與簡報自動生成功能。" },
    ],
  },
  {
    company: "OpenAI Codex",
    logo: "💻",
    color: "#7c3aed",
    bgColor: "#f5f3ff",
    model: "Codex CLI / o3",
    updates: [
      { date: "4/4", type: "工具發布", title: "Codex CLI 正式開源（MIT License）", desc: "支援本地終端執行、Git 整合、自動測試生成。可在無網路環境使用，適合企業內網部署。" },
      { date: "4/3", type: "模型更新", title: "o3 程式碼生成 benchmark 新紀錄", desc: "SWE-bench Verified 達 71.7%，超越所有開源模型。HumanEval 100% 通過率（首次達成）。" },
      { date: "4/1", type: "整合更新", title: "Codex 整合 VS Code、JetBrains", desc: "原生插件支援即時代碼補全、整個函數生成與 bug 自動修復，支援 40+ 程式語言。" },
    ],
  },
];

const aiArticles = [
  { title: "AI 寫程式碼已成主流", source: "MIT Technology Review", summary: "AI 現在寫了微軟 30% 和 Google 25% 以上的程式碼。GitHub Copilot、Cursor、Replit 等工具讓零程式基礎的人也能開發應用。" },
  { title: "GitHub 月併 4,300 萬 PR", source: "Microsoft / GitHub", summary: "2025 年 GitHub 活動量爆發，年度 commit 破 10 億次。2026 年重點：「倉庫智慧」——AI 理解程式碼的歷史脈絡與關聯。" },
  { title: "NASA 火星車首次 AI 自主駕駛", source: "ScienceDaily", summary: "NASA 毅力號火星車完成首次由 AI 而非人類規劃路線的行駛，具備視覺 AI 分析地形能力。" },
];

// ─── GitHub 熱門 ─────────────────────────────────────────────────────────────
const githubRepos = [
  { rank: 1, name: "VoltAgent/awesome-design-md", lang: "HTML", stars: "4.8k", forks: "628", desc: "收集熱門網站的 DESIGN.md 設計系統文件。放入專案中讓 AI Coding Agent 直接建構匹配的 UI。", tags: ["AI coding", "設計系統"], isNew: true, hot: true },
  { rank: 2, name: "ultraworkers/claw-code", lang: "Rust", stars: "166.8k", forks: "101.5k", desc: "史上最快突破 10 萬星的 Repo！以 Rust 編寫的 AI Agent，使用 oh-my-codex 框架。", tags: ["AI Agent", "Rust"], isNew: true, hot: true },
  { rank: 3, name: "msitarzewski/agency-agents", lang: "Shell", stars: "69.6k", forks: "10.6k", desc: "一站式 AI 代理機構——從前端工程師到 Reddit 社群經營，每個 Agent 都是有個性的專家。", tags: ["AI Agent", "多代理"], hot: true },
  { rank: 4, name: "anthropics/claude-code", lang: "Shell", stars: "107.3k", forks: "17.4k", desc: "Anthropic 的 Claude Code——終端內的 AI 程式開發工具，理解你的整個程式碼庫，透過自然語言指令加速開發。", tags: ["AI Agent", "AI coding"], hot: true },
  { rank: 5, name: "obra/superpowers", lang: "Shell", stars: "133.2k", forks: "11.1k", desc: "Agent 技能框架與軟體開發方法論。讓你的 AI 助手具備可擴充的能力和實用技能。", tags: ["AI Agent", "AI Skills"], hot: true },
  { rank: 6, name: "block/goose", lang: "Rust", stars: "34.2k", forks: "3.2k", desc: "開源可擴展 AI Agent——不只是寫程式建議，還能安裝、執行、編輯、測試，支援任何 LLM。", tags: ["AI Agent", "開源"] },
  { rank: 7, name: "koala73/worldmonitor", lang: "TypeScript", stars: "46.2k", forks: "7.4k", desc: "即時全球情報儀表板——AI 驅動的新聞聚合、地緣政治監控與基礎設施追蹤。", tags: ["AI infrastructure", "監控"], isNew: true },
  { rank: 8, name: "NVIDIA/personaplex", lang: "Python", stars: "6k", forks: "920", desc: "NVIDIA 的 PersonaPlex——支援 600+ 種語言的高品質語音克隆 TTS 技術。", tags: ["AI Voice", "NVIDIA"], isNew: true },
  { rank: 9, name: "NousResearch/hermes-agent", lang: "Python", stars: "23.9k", forks: "3.1k", desc: "與你一起成長的 AI Agent。NousResearch 的可進化、可學習代理系統。", tags: ["AI Agent", "AI Skills"], isNew: true },
  { rank: 10, name: "tirth8205/code-review-graph", lang: "Python", stars: "4.1k", forks: "364", desc: "為 Claude Code 建構本地知識圖譜。讓 Claude 只讀取關鍵程式碼——Code Review token 用量減少 6.8 倍。", tags: ["MCP", "AI coding"], isNew: true },
];

const langColors = { Rust: "#dea584", Python: "#3572A5", TypeScript: "#3178c6", JavaScript: "#f1e05a", Shell: "#89e051", HTML: "#e34c26" };

// ─── 更新時間排程（台灣時間）────────────────────────────────────────────────
const UPDATE_HOURS = [8, 16, 21];

function formatTwTime(date) {
  const twOffset = 8 * 60;
  const localOffset = date.getTimezoneOffset();
  const tw = new Date(date.getTime() + (twOffset + localOffset) * 60000);
  return `${tw.getHours().toString().padStart(2, "0")}:${tw.getMinutes().toString().padStart(2, "0")}`;
}

// ─── 共用 UI 元件 ─────────────────────────────────────────────────────────────
function Badge({ children, color = "#c96442" }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 20,
      fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
      background: color + "18", color, marginRight: 4, marginBottom: 2,
      fontFamily: "'Source Sans 3', sans-serif",
    }}>{children}</span>
  );
}

function Card({ children, style = {} }) {
  return (
    <div style={{
      background: "#fff", border: "1px solid #e8e6dc",
      borderRadius: 12, padding: 20, marginBottom: 16,
      boxShadow: "0 1px 3px rgba(20,20,19,0.04)",
      ...style,
    }}>{children}</div>
  );
}

function ImpactDot({ impact }) {
  const colors = { bullish: "#166534", bearish: "#b91c1c", neutral: "#87867f" };
  const labels = { bullish: "▲ 利多", bearish: "▼ 利空", neutral: "◆ 中性" };
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
      background: colors[impact] + "18", color: colors[impact],
      fontFamily: "'Source Sans 3', sans-serif", whiteSpace: "nowrap",
    }}>{labels[impact]}</span>
  );
}

// ─── 主組件 ──────────────────────────────────────────────────────────────────
export default function MorningBriefing() {
  const [active, setActive] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDispatchingUpdate, setIsDispatchingUpdate] = useState(false);
  const [firestoreData, setFirestoreData] = useState(null);
  const [firestoreError, setFirestoreError] = useState(null);
  const [dispatchMessage, setDispatchMessage] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const fetchedRef = useRef(false);
  const devTriggerEnabled = isDevTriggerEnabled();

  // Firestore 資料拉取
  const loadFirestore = useCallback(async () => {
    setIsRefreshing(true);
    setFirestoreError(null);
    try {
      const data = await fetchBriefingFromFirestore();
      setFirestoreData(data);
      setLastUpdated(data._updatedAt ? new Date(data._updatedAt) : new Date());
    } catch (err) {
      console.warn("Firestore 讀取失敗，使用內建示範數據:", err.message);
      setFirestoreError(err.message);
      setLastUpdated(new Date());
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // 初次載入
  useEffect(() => {
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      loadFirestore();
    }
  }, [loadFirestore]);

  const triggerImmediateUpdate = useCallback(async () => {
    if (!devTriggerEnabled || typeof window === "undefined") return;

    const cachedToken = window.sessionStorage.getItem(DEV_TRIGGER_TOKEN_KEY) || "";
    const token = window.prompt("輸入 GitHub Personal Access Token 以觸發更新 workflow", cachedToken)?.trim();
    if (!token) return;

    const defaultReason = `前端開發測試觸發 ${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" })}`;
    const reason = window.prompt("本次 workflow_dispatch 的原因", defaultReason);
    if (reason === null) return;

    window.sessionStorage.setItem(DEV_TRIGGER_TOKEN_KEY, token);
    setDispatchMessage(null);
    setIsDispatchingUpdate(true);

    try {
      await dispatchUpdateWorkflow(token, reason.trim() || defaultReason);
      setDispatchMessage("已送出背景更新，等待 GitHub Actions 完成後再按一次手動更新即可讀到最新資料。");
    } catch (err) {
      setDispatchMessage(`觸發失敗：${err.message}`);
    } finally {
      setIsDispatchingUpdate(false);
    }
  }, [devTriggerEnabled]);

  // 定時自動觸發（整點時重新拉取）
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      const twOffset = 8 * 60;
      const localOffset = now.getTimezoneOffset();
      const twNow = new Date(now.getTime() + (twOffset + localOffset) * 60000);
      if (UPDATE_HOURS.includes(twNow.getHours()) && twNow.getMinutes() === 0) {
        loadFirestore();
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [loadFirestore]);

  // live data 優先，fallback 到 module-level 常數
  const live = firestoreData || {};
  const liveMarket = live.marketData || marketData;
  const liveTechNews = live.techNews || techNews;
  const liveTrumpStatements = live.trumpStatements || trumpStatements;
  const liveAiUpdates = live.aiUpdates || null;

  const renderSection = () => {
    switch (active) {
      case 0: return <MarketOverview market={liveMarket} summary={live.marketSummary} insight={live.marketInsight} risk={live.topRisk} hasLiveData={Boolean(firestoreData)} />;
      case 1: return <MarketFactors twFocus={live.twStockFocus} twData={live.twData} market={liveMarket} />;
      case 2: return <TechStocks news={liveTechNews} />;
      case 3: return <IranWar market={liveMarket} />;
      case 4: return <TrumpWatch statements={liveTrumpStatements} />;
      case 5: return <AIFrontier liveUpdates={liveAiUpdates} />;
      case 6: return <GitHubTrending />;
      default: return null;
    }
  };

  // 顯示用日期
  const displayDate = lastUpdated
    ? lastUpdated.toLocaleDateString("zh-TW", { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Taipei" })
    : "載入中...";

  return (
    <div style={{ minHeight: "100vh", background: "#f5f4ed", color: "#141413", fontFamily: "'Georgia', 'Noto Serif TC', serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;500;700&family=Source+Sans+3:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={{ padding: "24px 20px 14px", borderBottom: "1px solid #e8e6dc", background: "linear-gradient(180deg, #ece9de 0%, #f5f4ed 100%)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#c96442", letterSpacing: 2, textTransform: "uppercase", marginBottom: 4, fontFamily: "'Source Sans 3', sans-serif" }}>
              ☀️ 每日晨報
            </div>
            <h1 style={{ fontSize: 26, fontWeight: 500, margin: 0, lineHeight: 1.15, color: "#141413", letterSpacing: -0.5 }}>
              全球市場日報
            </h1>
          </div>
          <div style={{ textAlign: "right", fontFamily: "'Source Sans 3', sans-serif" }}>
            <div style={{ fontSize: 13, color: "#5e5d59" }}>{displayDate}</div>
            {/* 數據來源標示 */}
            <div style={{ fontSize: 10, marginBottom: 6, color: firestoreError ? "#b91c1c" : "#166534" }}>
              {isRefreshing ? "⟳ 載入中..." : firestoreError ? "⚠ 使用示範數據" : "✓ 即時數據"}
            </div>
            {/* 更新按鈕 */}
            <button
              onClick={loadFirestore}
              disabled={isRefreshing}
              style={{
                display: "flex", alignItems: "center", gap: 5, marginLeft: "auto",
                padding: "5px 12px", borderRadius: 8, border: "1px solid #c96442",
                background: isRefreshing ? "#f5e6df" : "#fff",
                color: "#c96442", fontSize: 12, fontWeight: 600,
                cursor: isRefreshing ? "not-allowed" : "pointer",
                fontFamily: "'Source Sans 3', sans-serif", transition: "all 0.2s",
              }}
            >
              <span style={{ display: "inline-block", animation: isRefreshing ? "spin 0.8s linear infinite" : "none" }}>⟳</span>
              {isRefreshing ? "更新中..." : "手動更新"}
            </button>
            {devTriggerEnabled && (
              <button
                onClick={triggerImmediateUpdate}
                disabled={isDispatchingUpdate}
                style={{
                  display: "flex", alignItems: "center", gap: 5, marginLeft: "auto", marginTop: 6,
                  padding: "5px 12px", borderRadius: 8, border: "1px solid #1f2937",
                  background: isDispatchingUpdate ? "#eceff3" : "#fff",
                  color: "#1f2937", fontSize: 12, fontWeight: 600,
                  cursor: isDispatchingUpdate ? "not-allowed" : "pointer",
                  fontFamily: "'Source Sans 3', sans-serif", transition: "all 0.2s",
                }}
              >
                <span style={{ display: "inline-block", animation: isDispatchingUpdate ? "spin 0.8s linear infinite" : "none" }}>↗</span>
                {isDispatchingUpdate ? "送出中..." : "開發測試：立即更新"}
              </button>
            )}
            {lastUpdated && (
              <div style={{ fontSize: 10, color: "#87867f", marginTop: 4 }}>
                更新：{formatTwTime(lastUpdated)} TST
              </div>
            )}
            <div style={{ fontSize: 10, color: "#c96442", marginTop: 2 }}>
              自動更新：{UPDATE_HOURS.join(" / ")} 時整
            </div>
            {devTriggerEnabled && (
              <div style={{ fontSize: 10, color: dispatchMessage?.startsWith("觸發失敗") ? "#b91c1c" : "#1f2937", marginTop: 4, maxWidth: 280 }}>
                {dispatchMessage || "開發模式下可用：會觸發 GitHub Actions 的 workflow_dispatch，而不是只重抓 Firestore。"}
              </div>
            )}
          </div>
        </div>

        {/* Quick Ticker - 使用 live 數據 */}
        <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4, scrollbarWidth: "none" }}>
          {isRefreshing && !firestoreData ? (
            // Skeleton loading
            [1,2,3,4].map(i => (
              <div key={i} style={{ flex: "0 0 auto", padding: "8px 14px", borderRadius: 10, background: "#fff", border: "1px solid #e8e6dc", minWidth: 130, height: 66, opacity: 0.5 }} />
            ))
          ) : (
            liveMarket.indices.map((m, i) => (
              <div key={i} style={{
                flex: "0 0 auto", padding: "8px 14px", borderRadius: 10,
                background: "#fff", border: "1px solid #e8e6dc",
                minWidth: 130, boxShadow: "0 1px 3px rgba(20,20,19,0.04)",
              }}>
                <div style={{ fontSize: 11, color: "#87867f", marginBottom: 2, fontFamily: "'Source Sans 3', sans-serif" }}>{m.name}</div>
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#141413" }}>{m.value}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: m.pct.includes("-") ? "#b91c1c" : "#166534", fontFamily: "'JetBrains Mono', monospace" }}>
                  {m.pct} {m.change}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Tab Navigation */}
      <div style={{
        display: "flex", gap: 4, padding: "12px 16px",
        overflowX: "auto", scrollbarWidth: "none",
        borderBottom: "1px solid #e8e6dc",
        position: "sticky", top: 0, zIndex: 10, background: "#f5f4ed",
      }}>
        {SECTIONS.map((s, i) => (
          <button key={i} onClick={() => setActive(i)} style={{
            flex: "0 0 auto", padding: "8px 16px", borderRadius: 24,
            border: active === i ? "1px solid #c96442" : "1px solid #e8e6dc",
            cursor: "pointer", fontSize: 13, fontWeight: 600,
            fontFamily: "'Source Sans 3', 'Noto Serif TC', sans-serif",
            background: active === i ? "#c96442" : "#fff",
            color: active === i ? "#fff" : "#5e5d59",
            transition: "all 0.2s",
            boxShadow: active === i ? "0 2px 8px rgba(201,100,66,0.25)" : "none",
          }}>{s}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: "16px 16px 40px", fontFamily: "'Source Sans 3', 'Noto Serif TC', sans-serif" }}>
        {renderSection()}
      </div>
    </div>
  );
}

// ─── 市場總覽 ─────────────────────────────────────────────────────────────────
function MarketOverview({ market, summary, insight, risk, hasLiveData }) {
  const indices = market?.indices || marketData.indices;
  const extra = market?.extra || marketData.extra;

  return (
    <div>
      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#c96442", marginBottom: 12 }}>📊 今日市場總結</div>
        <p style={{ fontSize: 14, lineHeight: 1.8, color: "#4d4c48", margin: 0 }}>
          {summary || (hasLiveData ? "最新摘要載入中。" : "目前無法取得即時摘要，以下區塊可能顯示示範內容，請以重新同步後的資料為準。")}
        </p>
      </Card>

      {indices.map((m, i) => (
        <Card key={i}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{m.name}</div>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{m.value}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: m.color, fontFamily: "'JetBrains Mono', monospace" }}>{m.pct}</div>
              <div style={{ fontSize: 11, color: "#87867f", marginTop: 2 }}>前日 {m.prev}</div>
              <div style={{ fontSize: 12, color: "#c96442", marginTop: 2 }}>本週 {m.weekly}</div>
            </div>
          </div>
        </Card>
      ))}

      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#c96442", marginBottom: 12 }}>📈 其他關鍵指標</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {extra.map((e, i) => (
            <div key={i} style={{ padding: "10px 12px", borderRadius: 10, background: "#fdfcf8" }}>
              <div style={{ fontSize: 11, color: "#87867f" }}>{e.name}</div>
              <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{e.value}</div>
              <div style={{ fontSize: 12, color: e.pct.includes("+") ? "#22c55e" : e.pct.includes("-") ? "#ef4444" : "#9ca3af" }}>{e.pct}</div>
            </div>
          ))}
        </div>
      </Card>

      {insight && (
        <Card style={{ background: "#f0f7f4", borderColor: "#c6ddd2" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#2d6a4f", marginBottom: 8 }}>💡 今日操作洞察</div>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: "#4d4c48", margin: 0 }}>{insight}</p>
        </Card>
      )}
      {risk && (
        <Card style={{ background: "#fef2f2", borderColor: "#fecaca" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#b91c1c", marginBottom: 6 }}>⚠️ 今日最大風險</div>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: "#4d4c48", margin: 0 }}>{risk}</p>
        </Card>
      )}
    </div>
  );
}

// ─── 美台股影響因素 ─────────────────────────────────────────────────────────
function MarketFactors({ twFocus, twData: liveTw, market: liveMarket }) {
  const [tab, setTab] = useState("us");
  const factors = tab === "us" ? buildUsFactors(liveMarket) : buildTwFactors(liveTw);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[["us", "🇺🇸 美股因素"], ["tw", "🇹🇼 台股因素"]].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            padding: "8px 20px", borderRadius: 20,
            border: tab === key ? "1px solid #1d4ed8" : "1px solid #e8e6dc",
            background: tab === key ? "#1d4ed8" : "#fff",
            color: tab === key ? "#fff" : "#5e5d59",
            fontSize: 13, fontWeight: 600, cursor: "pointer",
            fontFamily: "'Source Sans 3', sans-serif", transition: "all 0.2s",
          }}>{label}</button>
        ))}
      </div>

      {tab === "us" && (
        <Card style={{ background: "#eff6ff", borderColor: "#bfdbfe" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#1d4ed8", marginBottom: 8 }}>📌 今日美股核心驅動</div>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: "#4d4c48", margin: 0 }}>
            美股方向仍主要由利率、能源價格、財報指引與地緣政治 headline 驅動。具體價位請以上方即時資料區塊為準。
          </p>
        </Card>
      )}
      {tab === "tw" && (
        <Card style={{ background: "#f0fdfa", borderColor: "#99f6e4" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#0f766e", marginBottom: 8 }}>📌 今日台股核心驅動</div>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: "#4d4c48", margin: 0 }}>
            台股仍以半導體、AI 供應鏈、匯率與外資籌碼為主軸。指數與匯率請以即時資料區塊顯示的最新數值為準。
          </p>
        </Card>
      )}

      {factors.map((group, gi) => (
        <Card key={gi}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 18 }}>{group.icon}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: group.color }}>{group.category}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {group.items.map((item, ii) => (
              <div key={ii} style={{
                padding: "10px 12px", borderRadius: 10,
                background: group.color + "08",
                borderLeft: `3px solid ${group.color}40`,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4, gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#141413" }}>{item.label}</span>
                  <ImpactDot impact={item.impact} />
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: group.color, fontFamily: "'JetBrains Mono', monospace", marginBottom: 3 }}>
                  {item.value}
                </div>
                <div style={{ fontSize: 11, color: "#87867f", lineHeight: 1.5 }}>{item.note}</div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─── 科技股 ─────────────────────────────────────────────────────────────────
function TechStocks({ news }) {
  const items = news || techNews;
  return (
    <div>
      {items.map((t, i) => (
        <Card key={i}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{
              fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 6,
              background: t.sentiment === "bullish" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
              color: t.sentiment === "bullish" ? "#22c55e" : "#ef4444", letterSpacing: 1,
            }}>{t.ticker}</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: t.sentiment === "bullish" ? "#22c55e" : "#ef4444" }}>
              {t.sentiment === "bullish" ? "▲ 看多" : "▼ 看空"}
            </div>
          </div>
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 8px", color: "#141413" }}>{t.title}</h3>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: "#5e5d59", margin: "0 0 10px" }}>{t.detail}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {t.tags.map((tag, j) => <Badge key={j} color={t.sentiment === "bullish" ? "#22c55e" : "#ef4444"}>{tag}</Badge>)}
          </div>
        </Card>
      ))}
      <Card style={{ background: "#faf8f2", borderColor: "#e0d9c8" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#c96442", marginBottom: 8 }}>🔍 其他值得關注</div>
        <div style={{ fontSize: 13, color: "#4d4c48", lineHeight: 1.8 }}>
          • <strong>Globalstar</strong> 傳亞馬遜考慮收購，股價飆漲 13%<br />
          • <strong>Blue Owl Capital</strong> 私人信貸基金贖回壓力加劇（OTIC 贖回率達 40.7%）<br />
          • 航空股（聯合、西南）因油價下跌全面大漲<br />
          • 國防部長 Hegseth 突然解除三名高級將領職務
        </div>
      </Card>
    </div>
  );
}

// ─── 美伊戰爭 ────────────────────────────────────────────────────────────────
function IranWar({ market }) {
  const extra = market?.extra || marketData.extra;
  const wti = findMetric(extra, "WTI 原油");
  const brent = findMetric(extra, "布蘭特原油");
  const gold = findMetric(extra, "黃金");

  return (
    <div>
      <Card style={{ background: "#fef2f2", borderColor: "#e8c4bc" }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>🌍 中東局勢觀察</div>
        <p style={{ fontSize: 13, lineHeight: 1.7, color: "#4d4c48", margin: 0 }}>
          本區塊用來整理中東情勢對油價、航運、黃金與風險偏好的影響。若上方即時商品價格已更新，請以 live market 區塊為準，不採用固定歷史價位。
        </p>
      </Card>

      <div style={{ position: "relative", paddingLeft: 20 }}>
        <div style={{ position: "absolute", left: 8, top: 0, bottom: 0, width: 2, background: "linear-gradient(to bottom, #b91c1c, #e8e6dc)" }} />
        {iranWar.map((e, i) => (
          <div key={i} style={{ position: "relative", marginBottom: 16, paddingLeft: 16 }}>
            <div style={{ position: "absolute", left: -16, top: 4, width: 10, height: 10, borderRadius: "50%", background: i === 0 ? "#b91c1c" : "#c4c0b5", border: "2px solid #fff" }} />
            <div style={{ fontSize: 11, fontWeight: 600, color: "#b91c1c", marginBottom: 2 }}>{e.date}</div>
            <div style={{ fontSize: 13, color: "#4d4c48", lineHeight: 1.6 }}>{e.event}</div>
          </div>
        ))}
      </div>

      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#c96442", marginBottom: 8 }}>⛽ 能源市場劇變</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {[
            { label: "WTI 原油", val: wti?.value || "待同步", chg: wti?.pct || "--" },
            { label: "布蘭特原油", val: brent?.value || "待同步", chg: brent?.pct || "--" },
          ].map((o, i) => (
            <div key={i} style={{ padding: 12, borderRadius: 10, background: "#fef3ec" }}>
              <div style={{ fontSize: 11, color: "#87867f" }}>{o.label}</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#141413" }}>{o.val}</div>
              <div style={{ fontSize: 12, color: o.chg.includes("+") ? "#166534" : o.chg.includes("-") ? "#b91c1c" : "#87867f" }}>{o.chg}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#c96442", marginBottom: 8 }}>🕊️ 停火進展與風險</div>
        <p style={{ fontSize: 13, lineHeight: 1.7, color: "#5e5d59", margin: 0 }}>
          地緣政治 headline 往往先反映在能源與避險資產。{gold ? `目前黃金為 ${gold.value}（${gold.pct}）` : "黃金與油價待同步"}，可用來觀察避險需求是否升溫。
        </p>
      </Card>
    </div>
  );
}

// ─── 川普動態 ─────────────────────────────────────────────────────────────────
function TrumpWatch({ statements }) {
  const [showTimeline, setShowTimeline] = useState(true);
  const liveStatements = statements || trumpStatements;

  return (
    <div>
      <Card style={{ background: "#faf8f2", borderColor: "#e0d9c8" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#c96442", marginBottom: 8 }}>📌「解放日」一週年回顧</div>
        <p style={{ fontSize: 13, lineHeight: 1.7, color: "#4d4c48", margin: 0 }}>
          2025/4/2 的「解放日」關稅已過一年。關稅政策經歷超過 50 次變更。最高法院已否決 IEEPA 關稅權限。目前有效關稅率從 2% 升至約 13.7%，每戶家庭平均增加 $1,500 稅負。製造業就業反而減少 89,000 個工作。
        </p>
      </Card>

      {/* 發言時序 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#141413" }}>🗣️ 川普近期發言時序</div>
        <button
          onClick={() => setShowTimeline(!showTimeline)}
          style={{
            padding: "5px 12px", borderRadius: 8, border: "1px solid #e8e6dc",
            background: "#fff", color: "#5e5d59", fontSize: 12, fontWeight: 600,
            cursor: "pointer", fontFamily: "'Source Sans 3', sans-serif",
          }}
        >{showTimeline ? "收起" : "展開"}</button>
      </div>

      {showTimeline && (
        <div style={{ position: "relative", paddingLeft: 20, marginBottom: 16 }}>
          <div style={{ position: "absolute", left: 8, top: 0, bottom: 0, width: 2, background: "linear-gradient(to bottom, #c96442, #e8e6dc)" }} />
          {liveStatements.map((s, i) => (
            <div key={i} style={{ position: "relative", marginBottom: 20, paddingLeft: 16 }}>
              <div style={{
                position: "absolute", left: -16, top: 6,
                width: 10, height: 10, borderRadius: "50%",
                background: i === 0 ? "#c96442" : "#c4c0b5",
                border: "2px solid #fff",
              }} />
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 5, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#c96442" }}>{s.date}</span>
                <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "#f5f4ed", color: "#87867f", fontWeight: 600 }}>{s.platform}</span>
                <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: s.color + "18", color: s.color, fontWeight: 700 }}>{s.type}</span>
              </div>
              <blockquote style={{
                margin: "0 0 6px", padding: "8px 12px",
                borderLeft: `3px solid ${s.color}60`,
                background: s.color + "08", borderRadius: "0 8px 8px 0",
                fontSize: 12, fontStyle: "italic", color: "#4d4c48", lineHeight: 1.6,
                fontFamily: "'Georgia', serif",
              }}>"{s.quote}"</blockquote>
              <div style={{ fontSize: 11, color: "#87867f" }}>
                <strong style={{ color: "#5e5d59" }}>市場反應：</strong>{s.impact}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 14, fontWeight: 700, color: "#141413", marginBottom: 12 }}>📋 本週政策動態</div>
      {trumpPolicy.map((p, i) => (
        <Card key={i}>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ fontSize: 28, lineHeight: 1 }}>{p.icon}</div>
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 6px", color: "#141413" }}>{p.title}</h3>
              <p style={{ fontSize: 13, lineHeight: 1.6, color: "#5e5d59", margin: 0 }}>{p.desc}</p>
            </div>
          </div>
        </Card>
      ))}

      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#c96442", marginBottom: 8 }}>🔮 未來焦點</div>
        <div style={{ fontSize: 13, color: "#4d4c48", lineHeight: 1.8 }}>
          • 美中貿易：Section 301 調查啟動，5 月川習峰會在即<br />
          • USMCA 聯合審查：美加墨貿易協定 2026 年重新談判<br />
          • 關稅退款：$1,660 億退款機制預計 4 月中公布細節<br />
          • Section 122 臨時關稅 7/24 到期，後續政策走向不明
        </div>
      </Card>
    </div>
  );
}

// ─── AI 前沿 ─────────────────────────────────────────────────────────────────
// key → aiCompanyUpdates 中對應的 company 欄位
const AI_COMPANY_KEY_MAP = {
  claude: "Anthropic / Claude",
  openai: "OpenAI",
  google: "Google / DeepMind",
  copilot: "Microsoft / Copilot",
  codex: "OpenAI Codex",
};

function AIFrontier({ liveUpdates }) {
  const [selectedCompany, setSelectedCompany] = useState(null);

  return (
    <div>
      <Card style={{ background: "#f0f7f4", borderColor: "#c6ddd2" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#2d6a4f", marginBottom: 8 }}>🤖 2026 AI 程式開發革命</div>
        <p style={{ fontSize: 13, lineHeight: 1.7, color: "#4d4c48", margin: 0 }}>
          AI 已從「輔助工具」轉變為「核心開發夥伴」。微軟 30% 的程式碼由 AI 撰寫，Google 超過 25%。78% 財富 500 大企業已在生產環境使用 AI 輔助開發。
        </p>
      </Card>

      <div style={{ fontSize: 14, fontWeight: 700, color: "#141413", marginBottom: 12 }}>📡 各家 AI 最新動態</div>

      {aiCompanyUpdates.map((company, ci) => {
        // 找出此公司對應的 liveUpdates key
        const liveKey = Object.entries(AI_COMPANY_KEY_MAP).find(([, v]) => v === company.company)?.[0];
        const liveText = liveUpdates?.[liveKey];
        return (
          <Card key={ci} style={{ background: company.bgColor, borderColor: company.color + "30" }}>
            <div
              onClick={() => setSelectedCompany(selectedCompany === ci ? null : ci)}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 22 }}>{company.logo}</span>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: company.color }}>{company.company}</div>
                  <div style={{ fontSize: 11, color: "#87867f", fontFamily: "'JetBrains Mono', monospace" }}>{company.model}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {liveText && <Badge color={company.color}>🔴 即時</Badge>}
                <Badge color={company.color}>{company.updates.length} 則更新</Badge>
                <span style={{ fontSize: 14, color: "#87867f" }}>{selectedCompany === ci ? "▲" : "▼"}</span>
              </div>
            </div>

            {/* Gemini 生成的即時摘要 */}
            {liveText && (
              <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, background: company.color + "10", borderLeft: `3px solid ${company.color}` }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: company.color, marginBottom: 3 }}>🤖 今日 AI 摘要</div>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: "#4d4c48" }}>{liveText}</div>
              </div>
            )}

            {selectedCompany === ci && (
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                {company.updates.map((update, ui) => (
                  <div key={ui} style={{ padding: "10px 14px", borderRadius: 10, background: "#fff", borderLeft: `3px solid ${company.color}` }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 5, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#87867f" }}>{update.date}</span>
                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: company.color + "18", color: company.color, fontWeight: 700 }}>{update.type}</span>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#141413", marginBottom: 4 }}>{update.title}</div>
                    <div style={{ fontSize: 12, lineHeight: 1.6, color: "#5e5d59" }}>{update.desc}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })}

      <div style={{ fontSize: 14, fontWeight: 700, color: "#141413", marginTop: 20, marginBottom: 12 }}>📰 延伸閱讀</div>
      {aiArticles.map((a, i) => (
        <Card key={i}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 6px", color: "#141413" }}>{a.title}</h3>
          <Badge color="#10b981">{a.source}</Badge>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: "#5e5d59", margin: "8px 0 0" }}>{a.summary}</p>
        </Card>
      ))}

      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#c96442", marginBottom: 8 }}>💡 開發者必讀趨勢</div>
        <div style={{ fontSize: 13, color: "#4d4c48", lineHeight: 1.8 }}>
          • <strong>Vibe Coding</strong>：讓 AI 主導撰寫程式碼，人類只需審核與指導<br />
          • <strong>Repository Intelligence</strong>：AI 理解整個程式碼庫的歷史脈絡<br />
          • <strong>MCP 開放治理</strong>：Linux 基金會接手，成為 AI Agent 工具連接標準<br />
          • <strong>量子 + AI 融合</strong>：IBM 預計 2026 年量子電腦首次超越傳統電腦<br />
          • <strong>自然語言程式設計</strong>：Replit、v0、Bolt.new 讓非技術人員也能開發
        </div>
      </Card>
    </div>
  );
}

// ─── GitHub 熱門 ─────────────────────────────────────────────────────────────
function GitHubTrending() {
  return (
    <div>
      <Card style={{ background: "#faf8f2", borderColor: "#e0d9c8" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <svg width="20" height="20" viewBox="0 0 16 16" fill="#141413">
            <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          <span style={{ fontSize: 15, fontWeight: 700, color: "#141413" }}>GitHub Trending Top 10</span>
        </div>
        <p style={{ fontSize: 13, lineHeight: 1.6, color: "#87867f", margin: 0 }}>
          來源：Trendshift.io（2026/4/5）。本週 AI Agent 類專案持續強勢霸榜，Rust 語言專案表現亮眼。
        </p>
      </Card>

      {githubRepos.map((repo, i) => (
        <Card key={i}>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
              background: i < 3 ? "linear-gradient(135deg, #6e54cc, #8b5cf6)" : "rgba(0,0,0,0.05)",
              color: i < 3 ? "#fff" : "#9ca3af",
            }}>{repo.rank}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#c96442", wordBreak: "break-all" }}>{repo.name}</span>
                {repo.isNew && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: "#ecfdf5", color: "#166534" }}>NEW</span>}
                {repo.hot && <span style={{ fontSize: 12 }}>🔥</span>}
              </div>
              <p style={{ fontSize: 12, lineHeight: 1.6, color: "#87867f", margin: "0 0 8px" }}>{repo.desc}</p>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#87867f" }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: langColors[repo.lang] || "#8b949e", display: "inline-block" }} />
                  {repo.lang}
                </span>
                <span style={{ fontSize: 11, color: "#87867f" }}>⭐ {repo.stars}</span>
                <span style={{ fontSize: 11, color: "#87867f" }}>🍴 {repo.forks}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                {repo.tags.map((tag, j) => <Badge key={j} color="#6e54cc">{tag}</Badge>)}
              </div>
            </div>
          </div>
        </Card>
      ))}

      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#c96442", marginBottom: 8 }}>📊 本週趨勢觀察</div>
        <div style={{ fontSize: 13, color: "#4d4c48", lineHeight: 1.8 }}>
          • <strong>AI Agent 全面主導</strong>：Top 10 中有 7 個專案與 AI Agent 相關<br />
          • <strong>Rust 語言崛起</strong>：claw-code（166.8k⭐）與 goose 均用 Rust 打造<br />
          • <strong>DESIGN.md 概念爆紅</strong>：讓 AI 自動匹配 UI 設計的新範式<br />
          • <strong>Claude Code 持續火熱</strong>：Anthropic 官方工具突破 107k 星<br />
          • <strong>知識圖譜 + MCP</strong>：code-review-graph 大幅減少 AI 的 token 消耗
        </div>
      </Card>
    </div>
  );
}
