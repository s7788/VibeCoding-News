"""
全球市場日報 — 自動更新腳本
排程：台灣時間 08:00 / 16:00 / 21:00
數據來源：Yahoo Finance v8 API + RSS 財經新聞
AI 摘要：Gemini 2.5 Flash
儲存：Firestore briefings/latest
"""

import os
import json
import time
import traceback
import feedparser
import requests
import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime, timezone

# ── 初始化 ────────────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"

def get_best_gemini_model():
    """動態查詢 API key 可用的最佳 Flash 模型"""
    try:
        r = requests.get(f"{GEMINI_BASE}/models?key={GEMINI_API_KEY}", timeout=15)
        r.raise_for_status()
        models = r.json().get("models", [])
        # 篩選支援 generateContent 的 flash 模型
        EXCLUDE = ("tts", "image", "thinking", "audio", "vision")
        flash = [
            m["name"].replace("models/", "")
            for m in models
            if "flash" in m.get("name", "").lower()
            and "generateContent" in m.get("supportedGenerationMethods", [])
            and not any(kw in m.get("name", "").lower() for kw in EXCLUDE)
        ]
        print(f"  可用 Flash 模型：{flash}")
        # 優先順序：3.x > 2.5 > 2.0 > 其他（不帶 preview/lite 優先）
        for prefix in ["gemini-3-flash", "gemini-3.1-flash", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash"]:
            # 非 preview/lite 版優先
            stable = [m for m in flash if m.startswith(prefix) and "preview" not in m and "lite" not in m]
            if stable:
                return sorted(stable, reverse=True)[0]
            # 再找 preview 版
            previews = [m for m in flash if m.startswith(prefix)]
            if previews:
                return sorted(previews, reverse=True)[0]
        return flash[0] if flash else "gemini-2.0-flash"
    except Exception as e:
        print(f"  模型查詢失敗，使用預設：{e}")
        return "gemini-1.5-flash"

GEMINI_MODEL = get_best_gemini_model()
print(f"  使用模型：{GEMINI_MODEL}")
GEMINI_URL = f"{GEMINI_BASE}/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"

# Yahoo Finance 直接 HTTP（yfinance 在 CI 環境有 cookie 問題）
YF_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
}

def yf_history(symbol, range_="7d", interval="1d"):
    """Yahoo Finance v8 API 直接呼叫，繞過 yfinance cookie 限制"""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    params = {"interval": interval, "range": range_, "includeAdjustedClose": True}
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, headers=YF_HEADERS, timeout=15)
            data = r.json()
            result = data["chart"]["result"][0]
            closes = (
                result["indicators"].get("adjclose", [{}])[0].get("adjclose")
                or result["indicators"]["quote"][0]["close"]
            )
            closes = [c for c in closes if c is not None]
            return closes
        except Exception as e:
            print(f"    retry {attempt+1}/3 {symbol}: {e}")
            time.sleep(2)
    return []

cred = credentials.Certificate(json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"]))
firebase_admin.initialize_app(cred)
db = firestore.client()

# ── 美股市場數據 ──────────────────────────────────────────────────────────────
US_TICKERS = {
    "道瓊工業": "^DJI",
    "納斯達克": "^IXIC",
    "S&P 500": "^GSPC",
    "比特幣": "BTC-USD",
}

EXTRA_TICKERS = {
    "WTI 原油": ("CL=F", "$", False),
    "布蘭特原油": ("BZ=F", "$", False),
    "黃金": ("GC=F", "$", False),
    "10Y 殖利率": ("^TNX", "", True),
}

def fmt_price(val, prefix="$", is_rate=False):
    if is_rate:
        return f"{val:.2f}%"
    if val >= 10000:
        return f"{prefix}{val:,.0f}"
    if val >= 100:
        return f"{prefix}{val:,.2f}"
    return f"{prefix}{val:.2f}"

def fetch_market_data():
    indices = []
    for name, symbol in US_TICKERS.items():
        try:
            closes = yf_history(symbol, range_="7d")
            if len(closes) < 2:
                print(f"  ✗ {name}: 不足數據點 ({len(closes)})")
                continue
            curr, prev, week_start = closes[-1], closes[-2], closes[0]
            change = curr - prev
            pct = (change / prev) * 100
            weekly = ((curr - week_start) / week_start) * 100
            prefix = "$" if "BTC" in symbol else ""
            indices.append({
                "name": name,
                "value": fmt_price(curr, prefix),
                "change": f"{'+' if change >= 0 else ''}{change:,.0f}",
                "pct": f"{'+' if pct >= 0 else ''}{pct:.1f}%",
                "prev": fmt_price(prev, prefix),
                "weekly": f"{'+' if weekly >= 0 else ''}{weekly:.1f}%",
                "color": "#166534" if pct >= 0 else "#b91c1c",
            })
            print(f"  ✓ {name}: {fmt_price(curr, prefix)} ({pct:+.1f}%)")
        except Exception as e:
            print(f"  ✗ {name}: {e}")

    extra = []
    for name, (symbol, prefix, is_rate) in EXTRA_TICKERS.items():
        try:
            closes = yf_history(symbol, range_="5d")
            if len(closes) < 2:
                continue
            curr, prev = closes[-1], closes[-2]
            pct = ((curr - prev) / prev) * 100
            extra.append({
                "name": name,
                "value": fmt_price(curr, prefix, is_rate),
                "pct": f"{'+' if pct >= 0 else ''}{pct:.1f}%",
            })
            print(f"  ✓ {name}: {fmt_price(curr, prefix, is_rate)} ({pct:+.1f}%)")
        except Exception as e:
            print(f"  ✗ {name}: {e}")

    return {"indices": indices, "extra": extra}

# ── 台股數據 ──────────────────────────────────────────────────────────────────
def fetch_tw_market():
    result = {}
    try:
        closes = yf_history("^TWII", range_="5d")
        if len(closes) >= 2:
            curr, prev = closes[-1], closes[-2]
            pct = ((curr - prev) / prev) * 100
            result["taiex"] = f"{curr:,.0f}"
            result["taiex_pct"] = f"{'+' if pct >= 0 else ''}{pct:.1f}%"
            result["taiex_color"] = "#166534" if pct >= 0 else "#b91c1c"
            print(f"  ✓ 台股加權：{curr:,.0f} ({pct:+.1f}%)")
    except Exception as e:
        print(f"  ✗ 台股：{e}")

    try:
        closes = yf_history("TWD=X", range_="5d")
        if closes:
            result["usd_twd"] = f"{closes[-1]:.2f}"
    except Exception:
        pass

    try:
        closes = yf_history("TSM", range_="5d")
        if len(closes) >= 2:
            curr, prev = closes[-1], closes[-2]
            pct = ((curr - prev) / prev) * 100
            result["tsm"] = f"${curr:.2f}"
            result["tsm_pct"] = f"{'+' if pct >= 0 else ''}{pct:.1f}%"
            print(f"  ✓ TSM ADR: ${curr:.2f} ({pct:+.1f}%)")
    except Exception:
        pass

    return result

# ── RSS 財經新聞 ──────────────────────────────────────────────────────────────
RSS_FEEDS = [
    ("Reuters Business", "https://feeds.reuters.com/reuters/businessNews"),
    ("Reuters Tech", "https://feeds.reuters.com/reuters/technologyNews"),
    ("CNBC Finance", "https://www.cnbc.com/id/10001147/device/rss/rss.html"),
    ("MarketWatch", "https://feeds.marketwatch.com/marketwatch/topstories"),
    ("Yahoo Finance", "https://finance.yahoo.com/news/rssindex"),
    ("Seeking Alpha", "https://seekingalpha.com/market_currents.xml"),
]

def fetch_news():
    headlines = []
    for source, url in RSS_FEEDS:
        try:
            feed = feedparser.parse(url)
            for entry in feed.entries[:6]:
                title = entry.get("title", "").strip()
                summary = entry.get("summary", "").strip()[:300]
                if title:
                    headlines.append({
                        "source": source,
                        "title": title,
                        "summary": summary,
                        "published": entry.get("published", ""),
                    })
            print(f"  ✓ {source}: {len(feed.entries[:6])} 篇")
        except Exception as e:
            print(f"  ✗ {source}: {e}")
    return headlines[:30]

# ── Gemini AI 生成摘要 ────────────────────────────────────────────────────────
def generate_with_gemini(market_data, tw_data, headlines):
    now_utc = datetime.now(timezone.utc)
    tw_hour = (now_utc.hour + 8) % 24
    session_label = "早盤" if tw_hour < 12 else ("午盤" if tw_hour < 17 else "盤後")
    date_str = now_utc.strftime("%Y/%m/%d")

    headlines_text = "\n".join(
        f"- [{h['source']}] {h['title']}"
        for h in headlines
    )

    market_json = json.dumps(market_data, ensure_ascii=False)
    tw_json = json.dumps(tw_data, ensure_ascii=False)

    prompt = f"""你是一位頂尖的華爾街財經分析師，專門為台灣投資人撰寫市場報告。
今天是 {date_str}，台灣時間 {session_label}。

【美股實時數據】
{market_json}

【台股數據】
{tw_json}

【今日重要新聞標題（英文原文）】
{headlines_text}

請根據以上數據生成完整的市場日報，以純 JSON 格式回傳（不要有 markdown 格式）：

{{
  "marketSummary": "200字以內的今日市場總結，使用繁體中文，包含最重要的市場動態與驅動因素",
  "techNews": [
    {{
      "ticker": "股票代碼（NVDA/TSLA/AAPL/MSFT/GOOGL/AMZN/META 擇一）",
      "title": "繁體中文新聞標題，約15-20字",
      "detail": "100字繁體中文詳細說明，包含具體數字與分析",
      "tags": ["標籤1", "標籤2", "標籤3"],
      "sentiment": "bullish 或 bearish"
    }}
  ],
  "trumpStatements": [
    {{
      "date": "日期（如 4/8）",
      "platform": "Truth Social 或 白宮記者會 或 Fox News",
      "type": "類型（如：停火宣告/關稅警告/制裁宣告/政策發布）",
      "color": "#166534（利多）或 #b91c1c（警告/威脅）或 #1d4ed8（政策）或 #7c3aed（其他）",
      "quote": "英文原文引述或中文摘要（約30字）",
      "impact": "對市場或特定資產的影響描述"
    }}
  ],
  "aiUpdates": {{
    "claude": "Anthropic Claude 最新動態，約50字繁體中文",
    "openai": "OpenAI 最新動態，約50字繁體中文",
    "google": "Google Gemini/DeepMind 最新動態，約50字繁體中文",
    "copilot": "Microsoft Copilot/GitHub 最新動態，約50字繁體中文",
    "codex": "OpenAI Codex 或程式碼 AI 工具最新動態，約50字繁體中文"
  }},
  "marketInsight": "100字市場洞察，包含今日操作建議與風險提示，使用繁體中文",
  "twStockFocus": "台股今日重點：包含加權指數走勢、外資動向、重點族群（半導體/AI/航運等），約100字繁體中文",
  "topRisk": "今日最大尾部風險，約30字繁體中文"
}}

規則：
1. 全部使用繁體中文（英文股票代碼、人名、機構名保留英文）
2. techNews 生成 3-4 筆，只包含今日新聞中有提及的股票
3. trumpStatements 生成 2-4 筆，如新聞中無川普相關消息則返回空陣列
4. aiUpdates 若新聞中無特定公司消息，填入「暫無最新消息，維持現有服務」
5. 所有數字需具體，不要使用模糊描述
6. 直接回傳 JSON，絕對不要包在 ```json ``` 中"""

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 4096},
    }
    r = requests.post(GEMINI_URL, json=payload, timeout=90)
    r.raise_for_status()
    text = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()

    # 清理可能的 markdown 包裝
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1] == "```" else lines[1:])

    return json.loads(text)

# ── 寫入 Firestore ────────────────────────────────────────────────────────────
def save_to_firestore(payload: dict):
    now = datetime.now(timezone.utc)
    tw_hour = (now.hour + 8) % 24
    session = "morning" if tw_hour < 12 else ("afternoon" if tw_hour < 17 else "evening")
    date_str = now.strftime("%Y-%m-%d")

    doc = {
        "payload": json.dumps(payload, ensure_ascii=False),
        "updatedAt": now.isoformat(),
        "session": session,
        "date": date_str,
    }

    # 最新快照（前端讀取此文件）
    db.collection("briefings").document("latest").set(doc)
    print(f"  ✓ 寫入 briefings/latest")

    # 歷史存檔
    history_id = f"{date_str}-{session}"
    db.collection("briefings").document(history_id).set(doc)
    print(f"  ✓ 寫入 briefings/{history_id}")

# ── 主流程 ────────────────────────────────────────────────────────────────────
def main():
    now_tw = datetime.now(timezone.utc).hour + 8
    print(f"\n{'='*50}")
    print(f"🚀 全球市場日報更新開始")
    print(f"   台灣時間：{now_tw % 24:02d}:00")
    print(f"{'='*50}\n")

    print("📊 [1/4] 抓取美股數據...")
    market_data = fetch_market_data()

    print("\n🇹🇼 [2/4] 抓取台股數據...")
    tw_data = fetch_tw_market()

    print("\n📰 [3/4] 抓取財經新聞...")
    headlines = fetch_news()
    print(f"   共 {len(headlines)} 篇新聞")

    print("\n🤖 [4/4] Gemini 生成摘要...")
    ai_content = generate_with_gemini(market_data, tw_data, headlines)
    print("  ✓ AI 摘要生成完成")

    combined = {
        "marketData": market_data,
        "twData": tw_data,
        **ai_content,
    }

    print("\n💾 寫入 Firestore...")
    save_to_firestore(combined)

    print(f"\n✅ 更新完成！")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        raise
