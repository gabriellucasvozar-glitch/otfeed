# OT Logistics News Feed

A static news tracker for a Polish port and logistics group. It collects sector news (ports and terminals, shipping, rail and inland waterways, regulation, M&A, geopolitics, commodities, supply chain shifts, equipment and technology) from every world region, keeps only relevant stories, ranks them High / Medium / Low for managers, and shows each one with a summary of up to 300 words, a "why it matters" line and a link to the original article. Daily and weekly briefs, recommended reads and saved stories are built in.

## How it works

| Part | File |
| --- | --- |
| Website (no build step) | `index.html`, `assets/styles.css`, `assets/app.js` |
| News data the site reads | `data/news.json` |
| Collector: fetches feeds, filters, scores, summarises | `scripts/collect.py` |
| Sources, keywords, weights, thresholds | `scripts/config.json` |
| Scheduled refresh (every 5 minutes; key searches every run, the rest rotate so each refreshes every ~15 min) | `.github/workflows/update-news.yml` |
| Hand-curated starter stories | `scripts/seed_items.json` → `python scripts/build_seed.py` |
| One-file snapshot for sharing | `python scripts/build_preview.py` |

**Relevance and priority.** Each story is matched against keyword sets per section and boosted when it mentions the group itself, the Szczecin–Świnoujście complex, other Polish ports, Poland, the Baltic or the EU. Each story is also tagged with every world region it mentions (Poland, Baltic & Nordics, Western Europe, Central & Eastern Europe, Ukraine & Black Sea, Russia & Belarus, EU institutions, Middle East, Asia, North America, Latin America, Africa, Oceania). Stories with no link to the sector are dropped. Anything naming the group, or home-port news about ports, regulation or M&A, is always High. Tune everything in `scripts/config.json`.

**Summaries.** Without an API key the collector builds an extractive summary from the article text (or the feed snippet if the page blocks bots). Add an `ANTHROPIC_API_KEY` repository secret and each new story is summarised by Claude in English (Polish sources included), with a "why it matters" line and a priority check that can also discard irrelevant items.

## Feed size and archive

The main feed (`data/news.json`) holds at most 600 stories from the last 60 days (`max_items`, `retention_days` in `scripts/config.json`). When new stories push older ones out, they move to monthly files in `data/archive/` and appear under the site's **Archive** tab. Archived stories are deleted after 365 days (`archive_days`).

## Keeping it private, then going live

The repository is private. The scheduled workflow still runs there and keeps `data/news.json` current, but nothing is visible on the web yet.

When you are ready to publish:

1. Settings → Actions → General → Workflow permissions → Read and write (needed now, so the scheduled updates can commit).
2. Optional: Settings → Secrets and variables → Actions → add `ANTHROPIC_API_KEY` for AI-written summaries.
3. Settings → Pages → Deploy from a branch → `main` / root. On a free account Pages only works for public repositories; GitHub Pro allows Pages from a private repository, but the published site itself is then public to anyone with the link.

## Run locally

```bash
pip install -r requirements.txt
python scripts/collect.py --dry-run   # preview what would be added
python scripts/collect.py             # update data/news.json
python -m http.server 8000            # open http://localhost:8000
```
