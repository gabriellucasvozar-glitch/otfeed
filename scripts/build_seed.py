"""Turn the hand-curated seed_items.json into data/news.json entries (keeps any collected items)."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from collect import score_item, item_id, OUT, CONFIG, NOW

seed = json.loads((Path(__file__).parent / "seed_items.json").read_text(encoding="utf-8"))
data = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"items": []}
items = {i["id"]: i for i in data["items"]}
for s in seed:
    sc = score_item(s["title"], s["summary"], s["source"]) or {}
    rec = {"id": item_id(s["url"], s["title"]), "title": s["title"], "original_title": s["title"],
           "url": s["url"], "source": s["source"], "published": s["published"] + "+00:00",
           "added": NOW.isoformat(timespec="minutes"), "lang": "en",
           "category": s["category"], "categories": sc.get("categories", [s["category"]]),
           "priority": s["priority"], "score": sc.get("score", 0), "regions": sc.get("regions", ["Global"]),
           "tags": sc.get("tags", []), "summary": s["summary"], "why": s["why"],
           "summary_method": "curated", "source_lang": s.get("lang", "en")}
    items[rec["id"]] = rec
out = sorted(items.values(), key=lambda i: i["published"], reverse=True)
payload = {"generated_at": NOW.isoformat(timespec="minutes"),
           "categories": {k: v["label"] for k, v in CONFIG["categories"].items()} | {"company": "Company Watch"},
           "items": out}
OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
print(len(out), "items")
for i in out: print(f"{i['priority']:6} {i['category']:11} {i['score']:5} {','.join(i['regions']):18} {i['title'][:60]}")
