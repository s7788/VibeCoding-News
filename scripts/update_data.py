"""
全球市場日報 — 自動更新腳本
排程：台灣時間 08:00 / 16:00 / 21:00
數據來源：Yahoo Finance v8 API + RSS 財經新聞 + GitHub Trending
AI 摘要：OpenAI GPT-5.4-nano
儲存：Firestore briefings/latest
"""

import html
import json
import os
import re
import time
import traceback
import urllib.parse
from datetime import datetime, timezone

import feedparser
import firebase_admin
import requests
from firebase_admin import credentials, firestore

# ── 初始化 ────────────────────────────────────────────────────────────────────
OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
OPENAI_MODEL = "gpt-5.4-nano"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"

cred = credentials.Certificate(json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"]))
firebase_admin.initialize_app(cred)
db = firestore.client()

COMMON_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

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

AI_NEWS_QUERIES = {
    "claude": "Anthropic OR Claude AI when:14d",
    "openai": "OpenAI OR ChatGPT OR GPT-5 when:14d",
    "google": "Google Gemini OR DeepMind when:14d",
    "copilot": "Microsoft Copilot OR GitHub Copilot when:14d",
    "codex": "OpenAI Codex OR AI coding agent OR Cursor OR Windsurf when:14d",
}

TRUMP_QUERY = "Trump tariffs OR Trump trade OR Trump policy OR Trump Truth Social when:30d"


def fetch_json(url, params=None, headers=None, timeout=20):
    merged_headers = {**COMMON_HEADERS, **(headers or {})}
    response = requests.get(url, params=params, headers=merged_headers, timeout=timeout)
    response.raise_for_status()
    return response.json()


def strip_html(raw_text):
    if not raw_text:
        return ""
    text = re.sub(r"<[^>]+>", " ", raw_text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def compact_number(num_str):
    if not num_str:
        return None
    value = int(num_str.replace(",", ""))
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}k"
    return str(value)


def yf_history(symbol, range_="7d", interval="1d"):
    """Yahoo Finance v8 API 直接呼叫，繞過 yfinance cookie 限制"""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    params = {"interval": interval, "range": range_, "includeAdjustedClose": True}
    for attempt in range(3):
        try:
            data = fetch_json(url, params=params, timeout=15)
            result = data["chart"]["result"][0]
            closes = (
                result["indicators"].get("adjclose", [{}])[0].get("adjclose")
                or result["indicators"]["quote"][0]["close"]
            )
            closes = [c for c in closes if c is not None]
            return closes
        except Exception as exc:
            print(f"    retry {attempt + 1}/3 {symbol}: {exc}")
            time.sleep(2)
    return []


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
            indices.append(
                {
                    "name": name,
                    "value": fmt_price(curr, prefix),
                    "change": f"{'+' if change >= 0 else ''}{change:,.0f}",
                    "pct": f"{'+' if pct >= 0 else ''}{pct:.1f}%",
                    "prev": fmt_price(prev, prefix),
                    "weekly": f"{'+' if weekly >= 0 else ''}{weekly:.1f}%",
                    "color": "#166534" if pct >= 0 else "#b91c1c",
                }
            )
            print(f"  ✓ {name}: {fmt_price(curr, prefix)} ({pct:+.1f}%)")
        except Exception as exc:
            print(f"  ✗ {name}: {exc}")

    extra = []
    for name, (symbol, prefix, is_rate) in EXTRA_TICKERS.items():
        try:
            closes = yf_history(symbol, range_="5d")
            if len(closes) < 2:
                continue
            curr, prev = closes[-1], closes[-2]
            pct = ((curr - prev) / prev) * 100
            extra.append(
                {
                    "name": name,
                    "value": fmt_price(curr, prefix, is_rate),
                    "pct": f"{'+' if pct >= 0 else ''}{pct:.1f}%",
                }
            )
            print(f"  ✓ {name}: {fmt_price(curr, prefix, is_rate)} ({pct:+.1f}%)")
        except Exception as exc:
            print(f"  ✗ {name}: {exc}")

    return {"indices": indices, "extra": extra}


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
    except Exception as exc:
        print(f"  ✗ 台股：{exc}")

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


# ── 新聞來源 ──────────────────────────────────────────────────────────────────
RSS_FEEDS = [
    ("Reuters Business", "https://feeds.reuters.com/reuters/businessNews"),
    ("Reuters Tech", "https://feeds.reuters.com/reuters/technologyNews"),
    ("CNBC Finance", "https://www.cnbc.com/id/10001147/device/rss/rss.html"),
    ("MarketWatch", "https://feeds.marketwatch.com/marketwatch/topstories"),
    ("Yahoo Finance", "https://finance.yahoo.com/news/rssindex"),
    ("Seeking Alpha", "https://seekingalpha.com/market_currents.xml"),
]


def normalize_feed_entry(source, entry):
    return {
        "source": source,
        "title": entry.get("title", "").strip(),
        "summary": strip_html(entry.get("summary", ""))[:320],
        "link": entry.get("link", ""),
        "published": entry.get("published", ""),
    }


def fetch_news():
    headlines = []
    for source, url in RSS_FEEDS:
        try:
            feed = feedparser.parse(url)
            entries = [normalize_feed_entry(source, entry) for entry in feed.entries[:6] if entry.get("title")]
            headlines.extend(entries)
            print(f"  ✓ {source}: {len(entries)} 篇")
        except Exception as exc:
            print(f"  ✗ {source}: {exc}")
    return headlines[:30]


def fetch_google_news(query, max_items=12):
    encoded = urllib.parse.quote_plus(query)
    url = f"https://news.google.com/rss/search?q={encoded}&hl=en-US&gl=US&ceid=US:en"
    feed = feedparser.parse(url)
    items = []
    for entry in feed.entries[:max_items]:
        if not entry.get("title"):
            continue
        items.append(
            {
                "source": entry.get("source", {}).get("title", "Google News"),
                "title": entry.get("title", "").strip(),
                "summary": strip_html(entry.get("summary", ""))[:320],
                "link": entry.get("link", ""),
                "published": entry.get("published", ""),
            }
        )
    return items


def fetch_ai_company_news():
    result = {}
    for key, query in AI_NEWS_QUERIES.items():
        try:
            items = fetch_google_news(query, max_items=6)
            result[key] = items
            print(f"  ✓ AI news {key}: {len(items)} 篇")
        except Exception as exc:
            print(f"  ✗ AI news {key}: {exc}")
            result[key] = []
    return result


def fetch_trump_news():
    try:
        items = fetch_google_news(TRUMP_QUERY, max_items=16)
        print(f"  ✓ Trump news: {len(items)} 篇")
        return items
    except Exception as exc:
        print(f"  ✗ Trump news: {exc}")
        return []


def fetch_github_trending(limit=10):
    response = requests.get("https://github.com/trending", headers=COMMON_HEADERS, timeout=20)
    response.raise_for_status()
    html_text = response.text
    articles = re.findall(r'<article class="Box-row">(.*?)</article>', html_text, re.S)
    repos = []

    for rank, block in enumerate(articles[:limit], start=1):
        name_match = re.search(
            r'<h2 class="h3 lh-condensed">.*?<a[^>]*href="/([^"/]+/[^"/]+)"',
            block,
            re.S,
        )
        if not name_match:
            continue

        name = html.unescape(name_match.group(1).strip())
        desc_match = re.search(
            r'<p class="col-9 color-fg-muted my-1 (?:pr-4|tmp-pr-4)">(.*?)</p>',
            block,
            re.S,
        )
        lang_match = re.search(r'itemprop="programmingLanguage">\s*([^<]+)\s*</span>', block, re.S)
        stars_match = re.search(rf'href="/{re.escape(name)}/stargazers"[^>]*>\s*.*?</svg>\s*([\d,]+)\s*</a>', block, re.S)
        forks_match = re.search(rf'href="/{re.escape(name)}/forks"[^>]*>\s*.*?</svg>\s*([\d,]+)\s*</a>', block, re.S)
        stars_today_match = re.search(r'([\d,]+)\s+stars today', block, re.S)

        repos.append(
            {
                "rank": rank,
                "name": name,
                "url": f"https://github.com/{name}",
                "lang": lang_match.group(1).strip() if lang_match else None,
                "stars": compact_number(stars_match.group(1)) if stars_match else None,
                "forks": compact_number(forks_match.group(1)) if forks_match else None,
                "starsToday": compact_number(stars_today_match.group(1)) if stars_today_match else None,
                "desc": strip_html(desc_match.group(1)) if desc_match else "",
            }
        )

    print(f"  ✓ GitHub Trending: {len(repos)} 個 repo")
    return repos


def safe_fetch_github_trending(limit=10):
    try:
        return fetch_github_trending(limit=limit)
    except Exception as exc:
        print(f"  ✗ GitHub Trending 取得失敗，改以空陣列繼續：{exc}")
        return []


def merge_github_repos(base_repos, ai_repos):
    annotations_by_name = {
        item.get("name"): item
        for item in (ai_repos or [])
        if item.get("name")
    }

    merged = []
    for repo in base_repos:
        annotation = annotations_by_name.get(repo["name"], {})
        merged.append(
            {
                "rank": repo["rank"],
                "name": repo["name"],
                "url": repo["url"],
                "lang": repo.get("lang"),
                "stars": repo.get("stars"),
                "forks": repo.get("forks"),
                "starsToday": repo.get("starsToday"),
                "desc": annotation.get("desc") or repo.get("desc", ""),
                "tags": annotation.get("tags") or [],
                "isNew": annotation.get("isNew", False),
                "hot": annotation.get("hot", repo["rank"] <= 3),
            }
        )
    return merged


def sanitize_branch_name(branch_name):
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", branch_name).strip("-").lower() or "unknown"


# ── OpenAI 生成摘要 ───────────────────────────────────────────────────────────
def openai_chat_json(system_prompt, user_prompt):
    payload = {
        "model": OPENAI_MODEL,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.3,
    }

    response = requests.post(
        OPENAI_URL,
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=90,
    )
    response.raise_for_status()
    text = response.json()["choices"][0]["message"]["content"]
    return json.loads(text)


def generate_with_openai(market_data, tw_data, headlines, trump_news, ai_news, github_repos):
    now_utc = datetime.now(timezone.utc)
    tw_hour = (now_utc.hour + 8) % 24
    session_label = "早盤" if tw_hour < 12 else ("午盤" if tw_hour < 17 else "盤後")
    date_str = now_utc.strftime("%Y/%m/%d")

    system_prompt = (
        "你是一位頂尖的華爾街財經分析師與科技新聞編輯，專門為台灣投資人產出結構化日報。"
        "你必須只根據提供的資料輸出有效 JSON，不要輸出 markdown。"
    )

    user_prompt = f"""今天是 {date_str}，台灣時間 {session_label}。

【美股實時數據】
{json.dumps(market_data, ensure_ascii=False)}

【台股數據】
{json.dumps(tw_data, ensure_ascii=False)}

【今日重要財經新聞】
{json.dumps(headlines, ensure_ascii=False)}

【川普近 30 天相關新聞】
{json.dumps(trump_news, ensure_ascii=False)}

【AI 公司近 14 天新聞】
{json.dumps(ai_news, ensure_ascii=False)}

【GitHub Trending】
{json.dumps(github_repos, ensure_ascii=False)}

請輸出一個 JSON 物件，欄位如下：
{{
  "marketSummary": "200字以內繁體中文市場總結",
  "techNews": [
    {{
      "ticker": "股票代碼",
      "title": "15-20字繁中標題",
      "detail": "100字內繁中說明",
      "tags": ["標籤1", "標籤2", "標籤3"],
      "sentiment": "bullish 或 bearish"
    }}
  ],
  "trumpStatements": [
    {{
      "date": "M/D",
      "platform": "消息來源平台或媒體",
      "type": "類型",
      "color": "#166534 或 #b91c1c 或 #1d4ed8 或 #7c3aed",
      "quote": "英文原文短句或繁中摘要",
      "impact": "市場影響"
    }}
  ],
  "aiUpdates": {{
    "claude": "50字內摘要",
    "openai": "50字內摘要",
    "google": "50字內摘要",
    "copilot": "50字內摘要",
    "codex": "50字內摘要"
  }},
  "aiCompanyUpdates": [
    {{
      "key": "claude/openai/google/copilot/codex",
      "company": "公司名稱",
      "model": "模型或產品名",
      "updates": [
        {{
          "date": "M/D",
          "type": "模型更新/產品更新/研究發布/企業動態/開發工具",
          "title": "繁中標題",
          "desc": "80字內繁中說明"
        }}
      ]
    }}
  ],
  "aiArticles": [
    {{
      "title": "繁中標題",
      "source": "來源",
      "summary": "80字內繁中摘要"
    }}
  ],
  "githubRepos": [
    {{
      "rank": 1,
      "name": "owner/repo",
      "url": "https://github.com/owner/repo",
      "lang": "語言或 null",
      "stars": "原樣保留輸入格式",
      "forks": "原樣保留輸入格式",
      "starsToday": "原樣保留輸入格式",
      "desc": "繁中描述",
      "tags": ["2個以內短標籤"],
      "isNew": true,
      "hot": true
    }}
  ],
  "githubTrendSummary": ["3-4條繁中趨勢觀察"],
  "marketInsight": "100字內繁中市場洞察",
  "twStockFocus": "100字內繁中台股重點",
  "topRisk": "30字內繁中尾部風險"
}}

規則：
1. 全部使用繁體中文，英文股票代碼、repo 名稱、產品名可以保留英文。
2. trumpStatements 只保留近 30 天內資訊，按時間新到舊排列，輸出 5-10 筆。
3. aiCompanyUpdates 要依照輸入新聞生成，不要寫死舊消息；若某家公司近 14 天沒有可靠更新，updates 可為空陣列，aiUpdates 對應欄位寫「近 14 天無明確重大更新」。
4. githubRepos 必須以輸入的 Trending repo 為準，不能杜撰 repo；desc 與 tags 可重新整理成繁中。
5. techNews 只挑今天資料中真的出現的股票，輸出 3-4 筆。
6. 若某欄缺資料，請輸出空陣列或中性描述，不要捏造具體數值。
7. 直接輸出 JSON。"""

    return openai_chat_json(system_prompt, user_prompt)


# ── 寫入 Firestore ────────────────────────────────────────────────────────────
def save_to_firestore(payload, branch_name=None):
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

    if branch_name and branch_name not in {"master", "main"}:
        preview_id = sanitize_branch_name(branch_name)
        doc["sourceBranch"] = branch_name
        db.collection("briefings_preview").document(preview_id).set(doc)
        print(f"  ✓ 寫入 briefings_preview/{preview_id}")
        return

    db.collection("briefings").document("latest").set(doc)
    print("  ✓ 寫入 briefings/latest")

    history_id = f"{date_str}-{session}"
    db.collection("briefings").document(history_id).set(doc)
    print(f"  ✓ 寫入 briefings/{history_id}")


# ── 主流程 ────────────────────────────────────────────────────────────────────
def main():
    now_tw = datetime.now(timezone.utc).hour + 8
    branch_name = os.environ.get("GITHUB_REF_NAME") or os.environ.get("GITHUB_HEAD_REF") or ""
    print(f"\n{'=' * 50}")
    print("🚀 全球市場日報更新開始")
    print(f"   台灣時間：{now_tw % 24:02d}:00")
    print(f"   AI 模型：{OPENAI_MODEL}")
    if branch_name:
        print(f"   分支：{branch_name}")
    print(f"{'=' * 50}\n")

    print("📊 [1/6] 抓取美股數據...")
    market_data = fetch_market_data()

    print("\n🇹🇼 [2/6] 抓取台股數據...")
    tw_data = fetch_tw_market()

    print("\n📰 [3/6] 抓取財經新聞...")
    headlines = fetch_news()
    print(f"   共 {len(headlines)} 篇新聞")

    print("\n🗞️ [4/6] 抓取川普 / AI 主題新聞...")
    trump_news = fetch_trump_news()
    ai_news = fetch_ai_company_news()

    print("\n📈 [5/6] 抓取 GitHub Trending...")
    github_repos = safe_fetch_github_trending(limit=10)

    print("\n🤖 [6/6] OpenAI 生成摘要...")
    ai_content = generate_with_openai(
        market_data=market_data,
        tw_data=tw_data,
        headlines=headlines,
        trump_news=trump_news,
        ai_news=ai_news,
        github_repos=github_repos,
    )
    print("  ✓ AI 摘要生成完成")

    combined = {
        "marketData": market_data,
        "twData": tw_data,
        **ai_content,
    }
    combined["githubRepos"] = merge_github_repos(github_repos, ai_content.get("githubRepos"))

    print("\n💾 寫入 Firestore...")
    save_to_firestore(combined, branch_name=branch_name)

    print("\n✅ 更新完成！")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        raise
