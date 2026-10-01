"""Bundle index.html + CSS + JS + data into one self-contained HTML file (for sharing a snapshot)."""
import json, re, sys
from pathlib import Path
root = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "dist" / "preview.html"
html = (root / "index.html").read_text(encoding="utf-8")
body = re.search(r"<!--APP-START-->(.*)<!--APP-END-->", html, re.S).group(1)
fonts = re.search(r'<link rel="stylesheet" href="(https://fonts[^"]+)">', html).group(1)
data = json.loads((root / "data" / "news.json").read_text(encoding="utf-8"))
data_js = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
css = (root / "assets" / "styles.css").read_text(encoding="utf-8")
js = (root / "assets" / "app.js").read_text(encoding="utf-8")
page = f"""<title>OT Logistics News Feed</title>
<link rel="stylesheet" href="{fonts}">
<style>
{css}
</style>
{body}
<script>window.OT_FEED_DATA = {data_js};</script>
<script>
{js}
</script>
"""
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(page, encoding="utf-8")
print("wrote", out, len(page), "bytes")
