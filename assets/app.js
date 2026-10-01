/* OT Feed front end: loads data/news.json (or inline window.OT_FEED_DATA), renders the feed,
   daily/weekly briefs, recommended reads and saved stories. No build step, no dependencies. */
(function () {
  "use strict";

  const CATS = [
    ["company", "Company Watch"],
    ["ports", "Ports & Terminals"],
    ["regulation", "Regulation & Policy"],
    ["mna", "M&A & Corporate"],
    ["geopolitics", "Geopolitics & Security"],
    ["commodities", "Commodities & Markets"],
    ["supplychain", "Supply Chain Shifts"],
    ["equipment", "Equipment & Technology"],
    ["rail", "Rail, Inland & Intermodal"],
    ["shipping", "Shipping & Freight"],
  ];
  const CAT_LABEL = Object.fromEntries(CATS);
  const PRIOS = [["high", "High"], ["medium", "Medium"], ["low", "Low"]];
  const PW = { high: 3, medium: 2, low: 1 };
  const REGIONS = ["Poland", "Baltic & Nordics", "Western Europe", "Central & Eastern Europe", "Ukraine & Black Sea", "Russia & Belarus", "EU institutions", "Middle East", "Asia", "North America", "Latin America", "Africa", "Oceania", "Global"];
  const RANGES = [["24h", "24 hours", 1], ["7d", "7 days", 7], ["30d", "30 days", 30], ["all", "All", 9999]];
  const DAY = 864e5;

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("otfeed:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("otfeed:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const state = Object.assign(
    { view: "feed", q: "", cat: "all", prios: ["high", "medium", "low"], region: "all", range: "all", sort: "priority" },
    store.get("state", {}),
    { q: "" }
  );
  if (state.region !== "all" && !REGIONS.includes(state.region)) state.region = "all";
  let saved = new Set(store.get("saved", []));
  let read = new Set(store.get("read", []));
  let DATA = { items: [] };
  let NOW = Date.now();
  let currentList = [];
  let openId = null;

  const persist = () => store.set("state", { view: state.view, cat: state.cat, prios: state.prios, region: state.region, range: state.range, sort: state.sort });
  const ageDays = (it) => (NOW - new Date(it.published).getTime()) / DAY;
  const fmtDate = (iso, withTime) => {
    const d = new Date(iso);
    const opts = withTime ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" };
    return d.toLocaleString("en-GB", opts);
  };
  const rel = (iso) => {
    const h = (NOW - new Date(iso).getTime()) / 36e5;
    if (h < 1) return "just now";
    if (h < 24) return Math.round(h) + "h ago";
    if (h < 48) return "yesterday";
    if (h < 24 * 14) return Math.round(h / 24) + " days ago";
    return fmtDate(iso);
  };
  const isoWeek = (d) => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / DAY + 1) / 7);
  };
  const catSw = (c) => `<span class="sw" style="background:var(--c-${c})"></span>`;
  const catTag = (c) => `<span class="cat" style="color:var(--c-${c})">${catSw(c)}${esc(CAT_LABEL[c] || c)}</span>`;
  const prioTag = (p) => `<span class="prio ${p}">${p === "medium" ? "Medium" : p === "high" ? "High" : "Low"}</span>`;
  const sortItems = (arr, how = state.sort) => arr.slice().sort((a, b) =>
    how === "newest" ? b.published.localeCompare(a.published)
      : (PW[b.priority] - PW[a.priority]) || b.published.localeCompare(a.published));

  // ------------------------------------------------------------------ filtering
  function matches(it, { ignoreCat = false, ignoreRange = false, ignoreRegion = false } = {}) {
    if (!ignoreCat && state.cat !== "all" && it.category !== state.cat) return false;
    if (!state.prios.includes(it.priority)) return false;
    if (!ignoreRegion && state.region !== "all" && !(it.regions || []).includes(state.region)) return false;
    if (!ignoreRange) {
      const r = RANGES.find((x) => x[0] === state.range);
      if (r && ageDays(it) > r[2]) return false;
    }
    if (state.q) {
      const hay = (it.title + " " + it.summary + " " + it.source + " " + (it.tags || []).join(" ")).toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l");
      const terms = state.q.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").split(/\s+/).filter(Boolean);
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ rail
  function renderRail() {
    const base = DATA.items.filter((it) => matches(it, { ignoreCat: true }));
    const counts = {}; base.forEach((it) => (counts[it.category] = (counts[it.category] || 0) + 1));
    $("#cats").innerHTML =
      `<button class="cat-btn" type="button" data-cat="all" aria-pressed="${state.cat === "all"}"><span class="sw" style="background:var(--muted)"></span>All sections<span class="n">${base.length}</span></button>` +
      CATS.map(([k, l]) => `<button class="cat-btn" type="button" data-cat="${k}" aria-pressed="${state.cat === k}">${catSw(k)}${esc(l)}<span class="n">${counts[k] || 0}</span></button>`).join("");
    $("#prios").innerHTML = PRIOS.map(([k, l]) =>
      `<button class="chip" type="button" data-prio="${k}" aria-pressed="${state.prios.includes(k)}"><span class="dot" style="background:var(--p-${k === "medium" ? "med" : k})"></span>${l}</button>`).join("");
    const rc = {}; DATA.items.filter((it) => matches(it, { ignoreRegion: true })).forEach((it) => (it.regions || []).forEach((r) => (rc[r] = (rc[r] || 0) + 1)));
    $("#regions").innerHTML = ["all", ...REGIONS].map((r) =>
      `<button class="chip" type="button" data-region="${esc(r)}" aria-pressed="${state.region === r}"${r !== "all" && !rc[r] && state.region !== r ? ' data-empty="true"' : ""}>${r === "all" ? "Any" : esc(r)}${r !== "all" ? ` <span class="chip-n">${rc[r] || 0}</span>` : ""}</button>`).join("");
    $("#ranges").innerHTML = RANGES.map(([k, l]) =>
      `<button class="chip" type="button" data-range="${k}" aria-pressed="${state.range === k}">${l}</button>`).join("");
  }

  // ------------------------------------------------------------------ cards
  function card(it, extra = "") {
    const isSaved = saved.has(it.id);
    return `<button class="card${read.has(it.id) ? " read" : ""}" type="button" data-open="${esc(it.id)}">
      <div class="card-meta">${prioTag(it.priority)}${catTag(it.category)}<span>·</span><span class="src">${esc(it.source)}</span><time datetime="${esc(it.published)}" title="${esc(fmtDate(it.published, true))}">${rel(it.published)}</time></div>
      ${extra}
      <h2 class="card-title">${esc(it.title)}</h2>
      <p class="card-why">${esc(it.why || "")}</p>
      <div class="card-foot">${(it.regions || []).slice(0, 3).map((r) => `<span class="tag">${esc(r)}</span>`).join("")}${isSaved ? '<span class="saved-mark">★ Saved</span>' : ""}</div>
    </button>`;
  }

  // ------------------------------------------------------------------ views
  function viewFeed() {
    const list = sortItems(DATA.items.filter((it) => matches(it)));
    currentList = list;
    const title = state.cat === "all" ? "All news" : CAT_LABEL[state.cat];
    const hi = list.filter((i) => i.priority === "high").length;
    return `<div class="view-head"><div><h1>${esc(title)}</h1><p>${list.length} ${list.length === 1 ? "story" : "stories"}${hi ? `, ${hi} high priority` : ""}${state.q ? ` matching “${esc(state.q)}”` : ""}</p></div>
      <label class="sort">Sort by <select id="sortSel"><option value="priority"${state.sort === "priority" ? " selected" : ""}>Priority</option><option value="newest"${state.sort === "newest" ? " selected" : ""}>Newest</option></select></label></div>
      ${list.length ? `<div class="list">${list.map((it) => card(it)).join("")}</div>` : emptyMsg()}`;
  }

  function emptyMsg() {
    return `<div class="empty"><p>No stories match these filters.</p><button class="btn" type="button" data-action="reset">Reset filters</button></div>`;
  }

  function briefWindow(days) {
    let note = "";
    let items = DATA.items.filter((it) => ageDays(it) <= days && matches(it, { ignoreCat: true, ignoreRange: true }));
    if (!items.length && DATA.items.length) {
      const latest = Math.min(...DATA.items.map(ageDays));
      const span = days === 1 ? 3 : 14;
      items = DATA.items.filter((it) => ageDays(it) <= latest + span && matches(it, { ignoreCat: true, ignoreRange: true }));
      note = `No new stories in the last ${days === 1 ? "24 hours" : "7 days"} for these filters, so this brief covers the most recent ${days === 1 ? "few days" : "two weeks"} instead.`;
    }
    return { items: sortItems(items, "priority"), note };
  }

  function viewBrief(kind) {
    const days = kind === "daily" ? 1 : 7;
    const { items, note } = briefWindow(days);
    currentList = items;
    const end = new Date(NOW), start = new Date(NOW - days * DAY);
    const period = kind === "daily" ? fmtDate(end.toISOString()) : `${start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${fmtDate(end.toISOString())}`;
    const top = items.filter((i) => i.priority === "high").slice(0, kind === "daily" ? 5 : 7);
    const topList = top.length ? top : items.slice(0, 3);
    const topList0 = top.length ? top : items.slice(0, 3);
    const inTop = new Set(topList0.map((i) => i.id));
    const byCat = CATS.map(([k, l]) => [k, l, items.filter((i) => i.category === k && !inTop.has(i.id))]).filter((x) => x[2].length);
    const sectionCount = new Set(items.map((i) => i.category)).size;
    const n = (p) => items.filter((i) => i.priority === p).length;
    const canPrint = (() => { try { return window.self === window.top; } catch { return false; } })();
    return `<div class="view-head"><div><h1>${kind === "daily" ? "Daily brief" : "Weekly brief"}</h1><p>What a manager needs to know, ranked by priority.</p></div></div>
    <section class="brief" id="brief">
      <div class="brief-head">
        <div>
          <div class="brief-kicker">${kind === "daily" ? "Daily" : "Week " + isoWeek(end)} · ${esc(period)}</div>
          <h2>${items.length} stories, ${n("high")} need attention</h2>
          <p>${n("high")} high, ${n("medium")} medium and ${n("low")} low priority across ${sectionCount} sections.${state.region !== "all" ? ` Region filter: ${esc(state.region)}.` : ""}</p>
        </div>
        <div class="brief-actions">
          <button class="btn primary" type="button" data-action="copy-brief" data-kind="${kind}">Copy as email text</button>
          ${canPrint ? '<button class="btn" type="button" data-action="print">Print / PDF</button>' : ""}
        </div>
      </div>
      ${note ? `<div class="brief-note">${esc(note)}</div>` : ""}
      ${items.length ? `
      <div>
        <h3>${top.length ? "Top priorities" : "Headlines"}</h3>
        <ol class="brief-top">${topList.map((it, i) => `<li><span class="num">${String(i + 1).padStart(2, "0")}</span><div>
          <button class="brief-item-title" type="button" data-open="${esc(it.id)}">${esc(it.title)}</button>
          <p class="brief-item-why">${catTag(it.category)} · ${esc(it.why || "")}</p></div></li>`).join("")}</ol>
      </div>
      ${byCat.length ? `<h3 style="margin-bottom:-12px">Also this period</h3>` : ""}<div class="brief-sections">${byCat.map(([k, l, arr]) => `<div class="brief-sec"><h3>${catSw(k)}${esc(l)}</h3><ul>${arr.map((it) =>
        `<li>${prioTag(it.priority)} <button type="button" data-open="${esc(it.id)}">${esc(it.title)}</button> <span class="s">${esc(it.source)}, ${rel(it.published)}</span></li>`).join("")}</ul></div>`).join("")}</div>` : emptyMsg()}
    </section>`;
  }

  function recoReason(it) {
    if (it.category === "company") return "About the group";
    if ((it.regions || []).includes("Poland") && it.priority === "high") return "High priority, Polish market";
    if (it.category === "regulation") return "Rule change to plan for";
    if (it.category === "mna") return "Competitive landscape";
    if (it.category === "geopolitics") return "Risk to cargo flows";
    if (it.category === "commodities") return "Cargo market signal";
    if (it.category === "supplychain") return "Shifting cargo flows";
    if (it.category === "equipment") return "Capex and technology";
    return it.priority === "high" ? "High priority" : "Useful context";
  }

  function viewReco() {
    const scored = DATA.items.filter((it) => !read.has(it.id) && matches(it, { ignoreCat: true, ignoreRange: true })).map((it) => {
      const s = PW[it.priority] * 10 + Math.max(0, 21 - ageDays(it)) + (it.category === "company" ? 6 : 0) +
        ((it.regions || []).includes("Poland") ? 3 : 0) + Math.min(10, (it.score || 0) / 3);
      return [s, it];
    }).sort((a, b) => b[0] - a[0]).slice(0, 8).map((x) => x[1]);
    currentList = scored;
    return `<div class="view-head"><div><h1>Recommended reads</h1><p>The stories most worth your time that you haven't opened yet, weighing priority, freshness and how close they sit to the group's business.</p></div></div>
      ${scored.length ? `<div class="reco">${scored.map((it) => card(it, `<div class="reco-reason">${esc(recoReason(it))}</div>`)).join("")}</div>`
        : `<div class="empty"><p>You've opened every recommended story. New ones appear as the feed updates.</p><button class="btn" type="button" data-action="clear-read">Mark all as unread</button></div>`}`;
  }

  function viewSaved() {
    const list = sortItems(DATA.items.filter((it) => saved.has(it.id)), "newest");
    currentList = list;
    return `<div class="view-head"><div><h1>Saved stories</h1><p>Stories you starred. They are kept in this browser only.</p></div></div>
      ${list.length ? `<div class="list">${list.map((it) => card(it)).join("")}</div>` : `<div class="empty"><p>Nothing saved yet. Open a story and choose <b>Save</b> to keep it here.</p></div>`}`;
  }

  function renderMain() {
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === state.view)));
    const v = state.view;
    $("#main").innerHTML = v === "daily" || v === "weekly" ? viewBrief(v) : v === "reco" ? viewReco() : v === "saved" ? viewSaved() : viewFeed();
    $("#savedCount").textContent = saved.size;
    const ss = $("#sortSel");
    if (ss) ss.addEventListener("change", () => { state.sort = ss.value; persist(); renderMain(); });
  }

  function renderPulse() {
    const wk = DATA.items.filter((i) => ageDays(i) <= 7);
    const day = DATA.items.filter((i) => ageDays(i) <= 1);
    const hi = wk.filter((i) => i.priority === "high");
    const reg = wk.filter((i) => i.category === "regulation");
    $("#pulse").innerHTML = `
      <div class="hot"><b>${hi.length}</b><span>High priority this week</span></div>
      <div><b>${day.length}</b><span>New in 24 hours</span></div>
      <div><b>${wk.length}</b><span>Stories this week</span></div>
      <div><b>${reg.length}</b><span>Regulatory this week</span></div>`;
  }

  function render() { renderRail(); renderMain(); }

  // ------------------------------------------------------------------ reader
  function openReader(id, push = true) {
    const it = DATA.items.find((x) => x.id === id);
    if (!it) return;
    openId = id;
    read.add(id); store.set("read", [...read]);
    const paras = String(it.summary || "").split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join("");
    const words = String(it.summary || "").split(/\s+/).filter(Boolean).length;
    const host = (() => { try { return new URL(it.url).hostname.replace(/^www\./, ""); } catch { return it.source; } })();
    $("#readerBody").innerHTML = `
      <div class="card-meta">${prioTag(it.priority)}${catTag(it.category)}<span>·</span><span class="src">${esc(it.source)}</span><time datetime="${esc(it.published)}">${esc(fmtDate(it.published, true))}</time></div>
      <h2 id="readerTitle">${esc(it.title)}</h2>
      ${it.why ? `<div class="why"><b>Why it matters</b>${esc(it.why)}</div>` : ""}
      <div class="summary">${paras}</div>
      <div class="wc">Summary · ${words} words${it.source_lang && it.source_lang !== "en" ? ` · translated from ${it.source_lang.toUpperCase()}` : ""}${it.summary_method === "feed" ? " · feed excerpt" : ""}</div>
      <div class="tags">${[...new Map([...(it.regions || []), ...(it.tags || []).slice(0, 6)].map((t) => [String(t).toLowerCase(), t])).values()].map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
      <div class="reader-cta">
        <a class="btn primary" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">Read full article on ${esc(host)} ↗</a>
        <button class="btn" type="button" data-action="save" data-id="${esc(it.id)}">${saved.has(it.id) ? "★ Saved" : "☆ Save"}</button>
        <button class="btn" type="button" data-action="copy-link" data-id="${esc(it.id)}">Copy link</button>
      </div>`;
    const reader = $("#reader"), scrim = $("#scrim");
    reader.hidden = false; scrim.hidden = false;
    requestAnimationFrame(() => { reader.classList.add("open"); scrim.classList.add("open"); });
    $("#readerBody").scrollTop = 0;
    const idx = currentList.findIndex((x) => x.id === id);
    $("#prevBtn").disabled = idx <= 0; $("#nextBtn").disabled = idx < 0 || idx >= currentList.length - 1;
    if (push) { try { history.replaceState(null, "", "#story-" + id); } catch { /* sandboxed */ } }
    $("#closeBtn").focus({ preventScroll: true });
  }
  function closeReader() {
    const reader = $("#reader"), scrim = $("#scrim");
    reader.classList.remove("open"); scrim.classList.remove("open");
    setTimeout(() => { reader.hidden = true; scrim.hidden = true; }, 220);
    try { history.replaceState(null, "", location.pathname + location.search); } catch { /* sandboxed */ }
    const back = openId && document.querySelector(`[data-open="${CSS.escape(openId)}"]`);
    openId = null;
    renderMain();
    if (back) { const again = document.querySelector(`[data-open="${CSS.escape(back.dataset.open)}"]`); again && again.focus({ preventScroll: true }); }
  }
  function step(dir) {
    const idx = currentList.findIndex((x) => x.id === openId);
    const nxt = currentList[idx + dir];
    if (nxt) openReader(nxt.id);
  }

  // ------------------------------------------------------------------ helpers
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200);
  }
  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); }
    catch {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast(okMsg); } catch { toast("Copy blocked. Select the text and copy it manually."); }
      ta.remove();
    }
  }
  function briefText(kind) {
    const { items } = briefWindow(kind === "daily" ? 1 : 7);
    const lines = [`OT Feed ${kind === "daily" ? "daily" : "weekly"} brief, ${fmtDate(new Date(NOW).toISOString())}`, ""];
    const top = items.filter((i) => i.priority === "high");
    if (top.length) {
      lines.push("TOP PRIORITIES");
      top.forEach((it, i) => lines.push(`${i + 1}. ${it.title}`, `   ${it.why || ""}`, `   ${it.url}`));
      lines.push("");
    }
    CATS.forEach(([k, l]) => {
      const arr = items.filter((i) => i.category === k && i.priority !== "high");
      if (!arr.length) return;
      lines.push(l.toUpperCase());
      arr.forEach((it) => lines.push(`- [${it.priority}] ${it.title} (${it.source})`, `  ${it.url}`));
      lines.push("");
    });
    return lines.join("\n");
  }

  // ------------------------------------------------------------------ theme
  const THEMES = ["system", "light", "dark"];
  function applyTheme(t) {
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    $("#themeLabel").textContent = t === "system" ? "Auto" : t === "light" ? "Light" : "Dark";
  }

  // ------------------------------------------------------------------ events
  function bind() {
    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-open],[data-cat],[data-prio],[data-region],[data-range],[data-view],[data-action]");
      if (!t) return;
      if (t.dataset.open) return openReader(t.dataset.open);
      if (t.dataset.view) { state.view = t.dataset.view; persist(); renderMain(); window.scrollTo({ top: 0 }); return; }
      if (t.dataset.cat) { state.cat = t.dataset.cat; if (state.view !== "feed") state.view = "feed"; }
      else if (t.dataset.prio) {
        const p = t.dataset.prio;
        state.prios = state.prios.includes(p) ? state.prios.filter((x) => x !== p) : [...state.prios, p];
        if (!state.prios.length) state.prios = [p];
      } else if (t.dataset.region) state.region = t.dataset.region;
      else if (t.dataset.range) state.range = t.dataset.range;
      else if (t.dataset.action) {
        const a = t.dataset.action;
        if (a === "reset") resetFilters();
        else if (a === "print") window.print();
        else if (a === "copy-brief") copy(briefText(t.dataset.kind), "Brief copied. Paste it into an email.");
        else if (a === "copy-link") { const it = DATA.items.find((x) => x.id === t.dataset.id); if (it) copy(it.url, "Article link copied"); }
        else if (a === "clear-read") { read = new Set(); store.set("read", []); }
        else if (a === "save") {
          const id = t.dataset.id;
          saved.has(id) ? saved.delete(id) : saved.add(id);
          store.set("saved", [...saved]);
          t.textContent = saved.has(id) ? "★ Saved" : "☆ Save";
          $("#savedCount").textContent = saved.size;
          toast(saved.has(id) ? "Saved" : "Removed from saved");
          return;
        }
        if (a !== "reset" && a !== "clear-read") return;
      }
      persist(); render();
    });
    let qt;
    $("#q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value.trim(); if (state.view !== "feed") state.view = "feed"; render(); }, 140); });
    $("#resetBtn").addEventListener("click", resetFilters);
    $("#filtersToggle").addEventListener("click", (e) => {
      const rail = $("#rail"); const c = rail.classList.toggle("collapsed");
      e.currentTarget.setAttribute("aria-expanded", String(!c)); e.currentTarget.textContent = c ? "Show filters" : "Hide filters";
    });
    $("#closeBtn").addEventListener("click", closeReader);
    $("#scrim").addEventListener("click", closeReader);
    $("#prevBtn").addEventListener("click", () => step(-1));
    $("#nextBtn").addEventListener("click", () => step(1));
    document.addEventListener("keydown", (e) => {
      if (!openId) return;
      if (e.key === "Escape") closeReader();
      else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); step(-1); }
    });
    $("#themeBtn").addEventListener("click", () => {
      const cur = store.get("theme", "system");
      const nxt = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      store.set("theme", nxt); applyTheme(nxt);
    });
  }
  function resetFilters() {
    Object.assign(state, { q: "", cat: "all", prios: ["high", "medium", "low"], region: "all", range: "all" });
    $("#q").value = ""; persist(); render();
  }

  // ------------------------------------------------------------------ boot
  async function load() {
    if (window.OT_FEED_DATA) return window.OT_FEED_DATA;
    const r = await fetch("data/news.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function boot() {
    applyTheme(store.get("theme", "system"));
    bind();
    try { DATA = await load(); }
    catch (err) {
      $("#main").innerHTML = `<div class="empty"><p>The news data could not be loaded (${esc(err.message)}). Refresh the page; if it persists, check that data/news.json was published.</p></div>`;
      return;
    }
    NOW = Date.now();
    const gen = DATA.generated_at ? new Date(DATA.generated_at) : null;
    $("#updated").textContent = gen ? "Updated " + fmtDate(gen.toISOString(), true) : "Updated";
    $("#weekLabel").textContent = "Week " + isoWeek(new Date(NOW)) + " · " + new Date(NOW).getFullYear();
    $("#foot").innerHTML = `${DATA.items.length} stories from public news sources. Summaries condense the original article; open the source before acting on any figure. Checked for new stories every 5 minutes.`;
    renderPulse(); render();
    const m = /^#story-([\w-]+)$/.exec(location.hash);
    if (m) openReader(m[1], false);
    if (!window.OT_FEED_DATA) setInterval(refresh, 5 * 60 * 1000);
  }

  // Pull fresh data every 5 minutes while the page is open; keep the reader undisturbed.
  async function refresh() {
    if (document.hidden) return;
    try {
      const next = await load();
      if (!next || next.generated_at === DATA.generated_at) return;
      const known = new Set(DATA.items.map((i) => i.id));
      const added = next.items.filter((i) => !known.has(i.id)).length;
      DATA = next; NOW = Date.now();
      $("#updated").textContent = "Updated " + fmtDate(new Date(DATA.generated_at).toISOString(), true);
      renderPulse();
      if (!openId) render(); else renderRail();
      if (added) toast(added === 1 ? "1 new story added" : added + " new stories added");
    } catch { /* offline or mid-deploy; try again next time */ }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !window.OT_FEED_DATA) refresh(); });
  boot();
})();
