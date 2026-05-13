#!/usr/bin/env python3
"""
Reddit 트렌드 분석기 — H영역 (CODEX_BLOG_NEURAL_QUALITY_BOOST_V2)
매일 06:00 KST 자동 실행. 한국 블로그 토픽 후보 10-20개 생성.

의존성: pip install praw
시크릿: HUB secrets-store.json → REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET
LLM: HUB_BASE_URL, HUB_AUTH_TOKEN을 통해 Hub 표준 LLM Gateway 호출
"""

import os
import sys
import json
import re
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime

# 의존성 지연 임포트 (설치 확인용)
try:
    import praw
except ImportError:
    print("[reddit_trend] praw 미설치. 실행: pip install praw", file=sys.stderr)
    sys.exit(1)

# ── 설정 ──────────────────────────────────────────────────────────────────────

SUBREDDITS = [
    ("popular", 30),           # 전체 트렌드
    ("technology", 25),        # IT 기술
    ("programming", 20),       # 프로그래밍
    ("personalfinance", 20),   # 재테크
    ("Entrepreneur", 15),      # 창업/비즈니스
    ("books", 20),             # 도서
    ("Korea", 15),             # 한국
]

STOP_WORDS = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "its", "our", "their", "this", "that", "these", "those",
    "and", "or", "but", "so", "yet", "for", "nor", "at", "by", "from",
    "in", "into", "of", "off", "on", "onto", "out", "to", "up", "with",
    "how", "what", "why", "when", "where", "who", "which", "if", "as",
    "new", "just", "more", "also", "now", "then", "not", "no", "any", "all",
    "like", "about", "after", "before", "over", "than", "too", "very",
    "today", "day", "week", "month", "year", "time", "ago", "old",
}

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "output")


def hub_llm_call(prompt):
    base_url = os.environ.get("HUB_BASE_URL", "http://127.0.0.1:7788").rstrip("/")
    auth_token = os.environ.get("HUB_AUTH_TOKEN", "").strip()
    if not auth_token:
        raise RuntimeError("HUB_AUTH_TOKEN 환경변수 미설정")

    payload = {
        "callerTeam": "blog",
        "agent": "blo",
        "selectorKey": "blog._default",
        "taskType": "reddit_trend_cluster",
        "abstractModel": "anthropic_haiku",
        "prompt": prompt,
        "maxTokens": 2000,
        "temperature": 0.2,
        "timeoutMs": 90000,
        "maxBudgetUsd": 0.05,
        "priority": "normal",
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/hub/llm/call",
        data=body,
        headers={
            "Authorization": f"Bearer {auth_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=95) as response:
            decoded = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"Hub LLM HTTP {e.code}: {detail}") from e

    if decoded.get("ok") is False:
        raise RuntimeError(f"Hub LLM 실패: {decoded.get('error') or decoded.get('reason')}")

    text = str(decoded.get("result") or decoded.get("text") or "").strip()
    if not text:
        raise RuntimeError("Hub LLM 빈 응답")
    return text


# ── Reddit 수집 ──────────────────────────────────────────────────────────────

def get_reddit_client():
    client_id = os.environ.get("REDDIT_CLIENT_ID")
    client_secret = os.environ.get("REDDIT_CLIENT_SECRET")
    if not client_id or not client_secret:
        print("[reddit_trend] REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET 환경변수 미설정", file=sys.stderr)
        sys.exit(1)

    return praw.Reddit(
        client_id=client_id,
        client_secret=client_secret,
        user_agent="blog-trend-analyzer/1.0",
        read_only=True,
    )


def collect_posts(reddit):
    posts = []
    for subreddit_name, limit in SUBREDDITS:
        try:
            sub = reddit.subreddit(subreddit_name)
            for post in sub.hot(limit=limit):
                if post.score < 100:
                    continue
                posts.append({
                    "title": post.title,
                    "score": post.score,
                    "num_comments": post.num_comments,
                    "subreddit": subreddit_name,
                    "url": post.url,
                    "created_utc": post.created_utc,
                })
        except Exception as e:
            print(f"[reddit_trend] {subreddit_name} 수집 실패 (무시): {e}", file=sys.stderr)

    print(f"[reddit_trend] 수집 완료: {len(posts)}개 포스트")
    return posts


# ── 키워드 추출 ──────────────────────────────────────────────────────────────

def extract_keywords(posts):
    keyword_counter = Counter()
    cross_sub_tracker = {}  # keyword → {subreddit set}

    for post in posts:
        words = re.findall(r'\b[A-Za-z]{3,}\b', post["title"].lower())
        unique_words = set(w for w in words if w not in STOP_WORDS)

        for word in unique_words:
            keyword_counter[word] += 1
            if word not in cross_sub_tracker:
                cross_sub_tracker[word] = set()
            cross_sub_tracker[word].add(post["subreddit"])

    # 빈도 3+ 또는 2개+ 서브레딧 크로스
    candidates = []
    for word, count in keyword_counter.most_common(100):
        cross_count = len(cross_sub_tracker.get(word, set()))
        if count >= 3 or cross_count >= 2:
            candidates.append({
                "keyword": word,
                "count": count,
                "cross_subreddits": cross_count,
                "score": count + cross_count * 3,  # 크로스 서브레딧 가중치
            })

    candidates.sort(key=lambda x: x["score"], reverse=True)
    return candidates[:50]


# ── LLM 클러스터링 (Hub LLM Gateway) ─────────────────────────────────────────

def cluster_with_llm(posts, keywords):
    top_posts_text = "\n".join(
        f"- [{p['subreddit']}] {p['title']} (score:{p['score']})"
        for p in sorted(posts, key=lambda x: x["score"], reverse=True)[:50]
    )
    top_keywords_text = ", ".join(k["keyword"] for k in keywords[:30])

    prompt = f"""당신은 한국 네이버 블로그 토픽 큐레이터입니다.

오늘 Reddit 트렌드 데이터:
=== TOP POSTS ===
{top_posts_text}

=== 주요 키워드 ===
{top_keywords_text}

위 데이터를 분석하여 한국 블로그에 적합한 토픽 후보 10-15개를 생성하세요.

결과를 JSON 배열로 반환하세요:
[
  {{
    "topic_ko": "한국어 블로그 토픽 제목",
    "category": "카테고리 (IT/재테크/자기계발/도서/라이프스타일 중 하나)",
    "keywords": ["관련 키워드1", "키워드2"],
    "reddit_source": "r/subreddit 출처",
    "trend_score": 0-100,
    "korea_relevance": 0-100,
    "is_book_topic": true/false,
    "reason": "선정 이유 (1-2줄)"
  }},
  ...
]

주의사항:
- 한국 독자에게 실용적이고 흥미로운 주제
- 최신 트렌드 반영 (투기성/논란성 제외)
- 도서 리뷰 가능한 주제는 is_book_topic=true
- trend_score와 korea_relevance 가중 평균으로 우선순위 결정
- JSON만 반환 (다른 텍스트 없이)"""

    try:
        text = hub_llm_call(prompt)
        # JSON 블록 추출
        if "```json" in text:
            text = text.split("```json")[1].split("```")[0].strip()
        elif "```" in text:
            text = text.split("```")[1].split("```")[0].strip()
        return json.loads(text)
    except Exception as e:
        print(f"[reddit_trend] LLM 파싱 실패: {e}", file=sys.stderr)
        return []


# ── 결과 저장 ─────────────────────────────────────────────────────────────────

def save_results(topics, posts, keywords):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")

    result = {
        "date": today,
        "generated_at": datetime.now().isoformat(),
        "source": "reddit",
        "raw_posts_count": len(posts),
        "keyword_count": len(keywords),
        "topics": topics,
    }

    filepath = os.path.join(OUTPUT_DIR, f"reddit-trends-{today}.json")
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    # latest 심볼릭 파일 (topic-selector가 읽을 수 있도록)
    latest_path = os.path.join(OUTPUT_DIR, "reddit-trends-latest.json")
    with open(latest_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"[reddit_trend] 저장 완료: {filepath}")
    print(f"[reddit_trend] 토픽 후보 {len(topics)}개:")
    for i, t in enumerate(topics[:10], 1):
        print(f"  {i}. [{t.get('category')}] {t.get('topic_ko')} (트렌드:{t.get('trend_score')} 한국:{t.get('korea_relevance')})")

    return result


# ── 메인 ─────────────────────────────────────────────────────────────────────

def main():
    print(f"[reddit_trend] 시작: {datetime.now().strftime('%Y-%m-%d %H:%M:%S KST')}")

    reddit = get_reddit_client()
    posts = collect_posts(reddit)

    if not posts:
        print("[reddit_trend] 수집된 포스트 없음. 종료.", file=sys.stderr)
        sys.exit(1)

    keywords = extract_keywords(posts)
    print(f"[reddit_trend] 키워드 추출: {len(keywords)}개")

    topics = cluster_with_llm(posts, keywords)
    if not topics:
        print("[reddit_trend] LLM 클러스터링 결과 없음. 종료.", file=sys.stderr)
        sys.exit(1)

    save_results(topics, posts, keywords)
    print("[reddit_trend] 완료!")


if __name__ == "__main__":
    main()
