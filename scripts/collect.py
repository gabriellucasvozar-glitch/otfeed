#!/usr/bin/env python3
"""OT Feed collector.

Pulls public RSS feeds and Google News searches, keeps only stories relevant
to Polish/Baltic ports, shipping, rail and inland logistics, regulation,
M&A, geopolitics and commodities, scores them for a manager's priority and
writes data/news.json for the static site.

Summaries:
  * If ANTHROPIC_API_KEY is set, each new story is summarised (<=300 words)
    by Claude, which also writes a one-line "why it matters" and may adjust
    the priority.
  * Otherwise an extractive summary is built from the article text (or the
    feed description when the article can't be fetched).

Run:  python scripts/collect.py            (writes data/news.json)
      python scripts/collect.py --dry-run  (prints what would be added)
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote_plus, urlparse

import feedparser
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "scripts" / "config.json").read_text(encoding="utf-8"))
OUT = ROOT / "data" / "news.json"
UA = "Mozilla/5.0 (compatible; OTFeedBot/1.0; +https://github.com/)"
NOW = datetime.now(timezone.utc)
MAX_WORDS = 300


# --------------------------------------------------------------------------- text helpers
def fold(text: str) -> str:
    """Lower-case and strip diacritics so 'Świnoujście' == 'swinoujscie'."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.replace("ł", "l").replace("Ł", "l").lower()


def clean_html(raw: str) -> str:
    text = BeautifulSoup(raw or "", "html.parser").get_text(" ", strip=True)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def truncate_words(text: str, limit: int = MAX_WORDS) -> str:
    words = text.split()
    if len(words) <= limit:
        return text
    cut = " ".join(words[:limit])
    last = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return cut[: last + 1] if last > len(cut) * 0.6 else cut + "…"


_PATTERNS: dict[str, re.Pattern] = {}


def term_pattern(term: str) -> re.Pattern:
    term = fold(term.strip())
    if term not in _PATTERNS:
        esc = re.escape(term)
        # long terms / stems match as prefixes ("sanction" -> sanctions, sanctioned)
        tail = r"\w*" if len(term) >= 6 and term[-1].isalpha() else r"(?:s|es)?\b"
        _PATTERNS[term] = re.compile(r"(?<!\w)" + esc + tail)
    return _PATTERNS[term]


def hits(text: str, terms) -> list[str]:
    return [t for t in terms if term_pattern(t).search(text)]


# --------------------------------------------------------------------------- scoring
def score_item(title: str, body: str, source: str, hint: str | None = None) -> dict | None:
    text = fold(f"{title} {title} {body}")  # title counted twice
    if hits(text, CONFIG["exclude_terms"]) and not hits(text, ["port", "shipping", "freight", "cargo"]):
        return None

    cat_scores, matched = {}, set()
    for key, cat in CONFIG["categories"].items():
        found = hits(text, cat["terms"].keys())
        if found:
            cat_scores[key] = sum(sorted((cat["terms"][t] for t in found), reverse=True)[:4])
            matched.update(found)
    if hint in cat_scores:
        cat_scores[hint] += 1

    sector = sum(cat_scores.get(k, 0) for k in ("ports", "shipping", "rail", "commodities", "supplychain", "equipment"))
    boost, regions, flags = 0, [], set()
    for key, b in CONFIG["boosts"].items():
        found = hits(text, b["terms"])
        if found:
            boost += b["weight"]
            flags.add(key)
            matched.update(found)
    # Regions: every world region the story mentions (stories can sit in several).
    regions = [name for name, terms in CONFIG["regions"].items() if hits(text, terms)]
    if "company" in flags and "Poland" not in regions:
        regions.insert(0, "Poland")
    if not regions:
        regions.append("Global")

    # Must touch the sector (or the company) to be kept at all.
    if sector == 0 and "company" not in flags:
        return None

    total = sum(sorted(cat_scores.values(), reverse=True)[:3]) + boost
    total *= CONFIG["source_weight"].get(source, 1) if total > 0 else 1
    if total < CONFIG["min_relevance"]:
        return None

    # Category = strongest topical signal, with regulation/M&A/geopolitics
    # winning ties because they are the "event type" managers filter on.
    order = ["mna", "regulation", "geopolitics", "equipment", "supplychain", "commodities", "ports", "rail", "shipping"]
    category = max(cat_scores, key=lambda k: (cat_scores[k] + (1 if k in order[:3] else 0), cat_scores[k], -order.index(k)))
    if "company" in flags:
        category = "company"

    pr = CONFIG["priority"]
    priority = "high" if total >= pr["high_score"] else "medium" if total >= pr["medium_score"] else "low"
    if "company" in flags or ("home_ports" in flags and category in ("ports", "regulation", "mna")):
        priority = "high"
    if category == "regulation" and flags & {"poland", "eu", "home_ports", "polish_ports"} and sector:
        priority = "high" if total >= pr["medium_score"] else "medium"

    return {
        "category": category,
        "categories": sorted(cat_scores, key=cat_scores.get, reverse=True),
        "priority": priority,
        "score": round(total, 1),
        "regions": regions,
        "tags": sorted({m for m in matched if len(m) > 2})[:8],
        "why": why_it_matters(category, flags, cat_scores),
    }


def why_it_matters(category: str, flags: set, cats: dict) -> str:
    if "company" in flags:
        return "Directly concerns OT Logistics or one of its group companies."
    if "home_ports" in flags:
        return "Affects the Szczecin–Świnoujście port complex, the group's home base."
    lines = {
        "regulation": "Rule change that may alter compliance costs or market access for Polish port and logistics operators.",
        "mna": "Consolidation move among ports, forwarders or rail operators that can shift competitive position.",
        "geopolitics": "Security or sanctions development that can reroute Baltic and Central European cargo flows.",
        "commodities": "Price or volume signal for bulk cargo (agri, coal, steel, fertilisers, biomass) handled in Polish ports.",
        "ports": "Competitor or partner port development on the Baltic.",
        "rail": "Hinterland rail, inland waterway or intermodal development affecting port connectivity.",
        "shipping": "Freight market or carrier development affecting vessel calls and rates.",
        "supplychain": "Shift in trade routes, sourcing or logistics demand that can change cargo volumes through Polish ports and corridors.",
        "equipment": "New handling, rail or terminal technology relevant to capex planning and terminal productivity.",
    }
    base = lines.get(category, "Relevant to the group's sector.")
    if "polish_ports" in flags and category != "ports":
        base += " Involves a Polish port."
    return base


# --------------------------------------------------------------------------- fetching
def parse_date(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        val = entry.get(key)
        if val:
            return datetime(*val[:6], tzinfo=timezone.utc)
    return None


def fetch_feed(url: str) -> list:
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=25)
        r.raise_for_status()
        return feedparser.parse(r.content).entries
    except Exception as exc:  # noqa: BLE001 - one bad feed must not stop the run
        print(f"  ! feed failed: {url[:90]} ({exc.__class__.__name__})", file=sys.stderr)
        return []


def gather_candidates() -> list[dict]:
    """Fetch feeds. Key queries run every time; the rest rotate across runs so a
    5-minute schedule doesn't hammer Google News (each query refreshes every ~15 min)."""
    out = []
    groups = max(1, CONFIG.get("rotation_groups", 1))
    slot = int(NOW.timestamp() // 300) % groups
    queries = [q for i, q in enumerate(CONFIG["queries"]) if q.get("always") or i % groups == slot]
    print(f"  rotation slot {slot + 1}/{groups}: {len(queries)} searches")
    for q in queries:
        url = CONFIG["google_news"][q["lang"]].format(q=quote_plus(q["q"]))
        for e in fetch_feed(url):
            src = (e.get("source") or {}).get("title") or "Google News"
            title = re.sub(r"\s+-\s+[^-]+$", "", e.get("title", "")).strip()  # drop " - Publisher"
            out.append({"title": title, "url": e.get("link"), "source": src,
                        "published": parse_date(e), "desc": clean_html(e.get("summary", "")),
                        "lang": q["lang"], "hint": q.get("hint")})
        time.sleep(1)
    for f in CONFIG["feeds"]:
        for e in fetch_feed(f["url"]):
            out.append({"title": clean_html(e.get("title", "")), "url": e.get("link"), "source": f["name"],
                        "published": parse_date(e), "desc": clean_html(e.get("summary", "")),
                        "lang": f.get("lang", "en"), "hint": None})
    return out


def article_text(url: str) -> str:
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=20, allow_redirects=True)
        if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
            return ""
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup(["script", "style", "nav", "header", "footer", "aside", "form"]):
            tag.decompose()
        root = soup.find("article") or soup.find("main") or soup.body or soup
        paras = [p.get_text(" ", strip=True) for p in root.find_all("p")]
        paras = [p for p in paras if len(p.split()) > 12 and "cookie" not in p.lower()]
        return re.sub(r"\s+", " ", " ".join(paras))[:20000]
    except Exception:  # noqa: BLE001
        return ""


# --------------------------------------------------------------------------- summarising
SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "summary": {"type": "string"},
        "why": {"type": "string"},
        "priority": {"type": "string", "enum": ["high", "medium", "low", "irrelevant"]},
    },
    "required": ["headline", "summary", "why", "priority"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = (
    "You brief senior managers of a Polish port and logistics group (bulk and general cargo terminals in "
    "Szczecin-Świnoujście and Gdynia, rail freight, inland waterways on the Odra, freight forwarding; "
    "key cargoes: grain and agri products, coal, steel, fertilisers, biomass). Given a news article, write in "
    "English: a clear headline; a neutral summary of at most 250 words using only facts in the article "
    "(figures, parties, dates, next steps); one sentence on why it matters to such a group; and a priority: "
    "high (needs a manager's attention this week), medium (useful context), low (background), or irrelevant "
    "(nothing to do with the sector)."
)


def ai_summarise(client, item: dict, text: str) -> dict | None:
    model = os.environ.get("OTFEED_MODEL", "claude-opus-5-5")
    content = (f"Source: {item['source']}\nPublished: {item.get('published')}\nTitle: {item['title']}\n\n"
               f"Article text:\n{text or item['desc']}")
    try:
        resp = client.beta.messages.create(
            model=model,
            max_tokens=4000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=SYSTEM_PROMPT,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": SUMMARY_SCHEMA}},
            messages=[{"role": "user", "content": content[:60000]}],
        )
    except Exception as exc:  # noqa: BLE001 - fall back to extractive summary
        print(f"  ! AI summary failed: {exc.__class__.__name__}: {str(exc)[:160]}", file=sys.stderr)
        return None
    if resp.stop_reason == "refusal":
        return None
    block = next((b for b in resp.content if b.type == "text"), None)
    try:
        return json.loads(block.text) if block else None
    except json.JSONDecodeError:
        return None


def extractive_summary(title: str, text: str, desc: str) -> str:
    source = text if len(text.split()) > 60 else desc
    if not source:
        return ""
    sentences = re.split(r"(?<=[.!?])\s+", source)
    key = set(fold(title).split())
    scored = []
    for i, s in enumerate(sentences[:60]):
        words = set(fold(s).split())
        num = 1 if re.search(r"\d", s) else 0
        scored.append((len(words & key) + num + (3 if i < 3 else 0), i, s))
    keep = sorted(sorted(scored, reverse=True)[:9], key=lambda x: x[1])
    return truncate_words(" ".join(s for _, _, s in keep), 220)


# --------------------------------------------------------------------------- main
def norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", fold(t))[:90]


def item_id(url: str, title: str) -> str:
    return hashlib.sha1(norm_title(title).encode()).hexdigest()[:12]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=80, help="max new items per run")
    args = ap.parse_args()

    existing = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"items": []}
    items = {i["id"]: i for i in existing.get("items", [])}
    seen_titles = {norm_title(i["title"]) for i in items.values()}

    client = None
    if os.environ.get("ANTHROPIC_API_KEY"):
        import anthropic
        client = anthropic.Anthropic()

    print("Fetching feeds…")
    cands = gather_candidates()
    print(f"  {len(cands)} raw entries")
    cutoff = NOW - timedelta(days=CONFIG["max_age_days_on_ingest"])
    fresh = []
    for c in cands:
        if not c["url"] or not c["title"]:
            continue
        nt = norm_title(c["title"])
        if nt in seen_titles or (c["published"] and c["published"] < cutoff):
            continue
        s = score_item(c["title"], c["desc"], c["source"], c["hint"])
        if not s:
            continue
        seen_titles.add(nt)
        fresh.append({**c, **s})
    fresh.sort(key=lambda x: x["score"], reverse=True)
    fresh = fresh[: args.limit]
    print(f"  {len(fresh)} relevant new stories")

    for c in fresh:
        text = article_text(c["url"])
        ai = ai_summarise(client, c, text) if client else None
        if ai and ai["priority"] == "irrelevant":
            continue
        summary = ai["summary"] if ai else extractive_summary(c["title"], text, c["desc"])
        rec = {
            "id": item_id(c["url"], c["title"]),
            "title": (ai or {}).get("headline") or c["title"],
            "original_title": c["title"],
            "url": c["url"],
            "source": c["source"],
            "published": (c["published"] or NOW).isoformat(timespec="minutes"),
            "added": NOW.isoformat(timespec="minutes"),
            "lang": "en" if ai else c["lang"],
            "category": c["category"],
            "categories": c["categories"],
            "priority": ai["priority"] if ai else c["priority"],
            "score": c["score"],
            "regions": c["regions"],
            "tags": c["tags"],
            "summary": truncate_words(summary or c["desc"] or c["title"]),
            "why": (ai or {}).get("why") or c["why"],
            "summary_method": "ai" if ai else ("extract" if text else "feed"),
        }
        items[rec["id"]] = rec
        if args.dry_run:
            print(f"  + [{rec['priority']:6}] {rec['category']:11} {rec['title'][:90]}")

    keep_after = NOW - timedelta(days=CONFIG["retention_days"])
    kept = [i for i in items.values()
            if i.get("pinned") or datetime.fromisoformat(i["published"]) >= keep_after]
    kept.sort(key=lambda i: i["published"], reverse=True)
    kept = kept[: CONFIG["max_items"]]

    payload = {"generated_at": NOW.isoformat(timespec="minutes"),
               "categories": {k: v["label"] for k, v in CONFIG["categories"].items()} | {"company": "Company Watch"},
               "items": kept}
    if args.dry_run:
        print(f"Dry run: {len(kept)} items would be written.")
        return
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Wrote {len(kept)} items to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
