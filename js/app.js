(function () {
  "use strict";

  const state = {
    constituencies: [],       // registry from data/constituencies.json, each gets .hasData after load attempts
    constituencyById: new Map(),
    roadIndex: [],             // merged across constituencies, each row tagged with constituencyId/constituencyName
    partByKey: new Map(),      // key: `${constituencyId}#${partNumber}`
    geocache: {},               // geocache[constituencyId][road] = {lat, lon, ...}
    fuse: null,
    map: null,
    mapInitialized: false,
  };

  const el = (id) => document.getElementById(id);

  function statusBadgeClass(status) {
    if (!status) return "status-verified";
    const s = status.toLowerCase();
    if (s.includes("excluded")) return "status-excluded";
    if (s.includes("review") || s.includes("historical")) return "status-review";
    return "status-verified";
  }

  const PDF_MIRROR_BASE = "https://bbmp-sir-2002.s3.us-east-1.amazonaws.com";

  function officialPdfUrl(partNumber, constituencyId) {
    const code = constituencyId + String(partNumber).padStart(4, "0");
    return `${PDF_MIRROR_BASE}/${constituencyId}-PDFs/${code}.pdf`;
  }

  function localImageUrl(partNumber, constituencyId) {
    const code = constituencyId + String(partNumber).padStart(4, "0");
    return `images/${code}.png`;
  }

  function parseRoadKey(key) {
    const idx = key.indexOf("#");
    return { constituencyId: key.slice(0, idx), road: key.slice(idx + 1) };
  }

  // ---------- Constituency selects ----------

  function constituencyOptionsHtml(selectedId) {
    return state.constituencies
      .map((c) => {
        const label = c.hasData ? `${c.name} (${c.id})` : `${c.name} (${c.id}) — coming soon`;
        const selected = c.id === selectedId ? "selected" : "";
        return `<option value="${c.id}" ${selected}>${label}</option>`;
      })
      .join("");
  }

  function defaultConstituencyId() {
    const withData = state.constituencies.find((c) => c.hasData);
    return (withData || state.constituencies[0]).id;
  }

  // ---------- Data loading ----------

  async function fetchJson(path) {
    const resp = await fetch(path, { cache: "no-store" });
    if (!resp.ok) throw new Error(`${path}: ${resp.status}`);
    return resp.json();
  }

  async function loadConstituencyData(c) {
    try {
      const [roadIndex, partSummary] = await Promise.all([
        fetchJson(`data/${c.id}/road_index.json`),
        fetchJson(`data/${c.id}/part_summary.json`),
      ]);
      let geocache = {};
      try {
        geocache = await fetchJson(`data/${c.id}/geocache.json`);
      } catch (e) {
        geocache = {};
      }
      return { roadIndex, partSummary, geocache };
    } catch (e) {
      return null;
    }
  }

  async function loadData() {
    state.constituencies = await fetchJson("data/constituencies.json");
    state.constituencies.forEach((c) => state.constituencyById.set(c.id, c));

    const results = await Promise.all(state.constituencies.map(loadConstituencyData));

    results.forEach((result, i) => {
      const c = state.constituencies[i];
      if (!result) {
        c.hasData = false;
        return;
      }
      c.hasData = true;
      result.roadIndex.forEach((road) => {
        state.roadIndex.push({ ...road, constituencyId: c.id, constituencyName: c.name });
      });
      result.partSummary.forEach((part) => {
        const tagged = { ...part, constituencyId: c.id, constituencyName: c.name };
        state.partByKey.set(`${c.id}#${part.partNumber}`, tagged);
      });
      state.geocache[c.id] = result.geocache;
    });

    state.fuse = new Fuse(state.roadIndex, {
      keys: [
        { name: "road", weight: 0.7 },
        { name: "numberedRoadDetails", weight: 0.3 },
      ],
      threshold: 0.38,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });

    populateConstituencySelects();
  }

  function populateConstituencySelects() {
    const defaultId = defaultConstituencyId();

    const searchFilter = el("search-constituency-filter");
    searchFilter.innerHTML = `<option value="">All constituencies</option>${constituencyOptionsHtml(null)}`;

    const partSelect = el("part-constituency-select");
    partSelect.innerHTML = constituencyOptionsHtml(defaultId);
    updatePartInputRange(defaultId);

    const browseSelect = el("browse-constituency-select");
    browseSelect.innerHTML = constituencyOptionsHtml(defaultId);
  }

  // ---------- Tabs ----------

  function activateTab(tabName, opts = {}) {
    const target = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (!target) return;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    target.classList.add("active");
    target.setAttribute("aria-selected", "true");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    el("tab-" + tabName).classList.add("active");
    if (tabName === "map") {
      initMapIfNeeded();
    }
    if (tabName === "browse" && state.constituencyById.size) {
      renderBrowseAll(el("browse-constituency-select").value);
    }
    if (!opts.fromHashChange) {
      const url = tabName === "search" ? location.pathname + location.search : "#" + tabName;
      history.replaceState(null, "", url);
    }
  }

  function setupTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        // Middle-click / ctrl / cmd click: let the browser open it in a new tab as normal.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        activateTab(btn.dataset.tab);
      });
    });
    window.addEventListener("hashchange", () => {
      activateTab(location.hash.slice(1) || "search", { fromHashChange: true });
    });
  }

  // ---------- Search tab ----------

  function partPillsHtml(road) {
    return road.parts
      .map((n) => {
        const part = state.partByKey.get(`${road.constituencyId}#${n}`);
        const code = part ? part.partCode : road.constituencyId + String(n).padStart(4, "0");
        return `
        <div class="part-pill">
          <span class="num">Part ${n}</span>
          <a class="thumb-btn" href="${localImageUrl(n, road.constituencyId)}" target="_blank" rel="noopener" data-preview="${localImageUrl(n, road.constituencyId)}">Preview</a>
          <a href="${officialPdfUrl(n, road.constituencyId)}" target="_blank" rel="noopener">Official PDF ↗</a>
        </div>`;
      })
      .join("");
  }

  function roadCardHtml(road) {
    const constituencyBadge = `<span class="badge constituency">${road.constituencyName} (${road.constituencyId})</span>`;
    const confBadge =
      road.minConfidence != null
        ? `<span class="badge confidence">Confidence ${road.minConfidence}%</span>`
        : "";
    const statusBadge = road.status
      ? `<span class="badge ${statusBadgeClass(road.status)}">${road.status}</span>`
      : "";
    const numbered = road.numberedRoadDetails
      ? `<p class="detail-line"><strong>Numbered roads:</strong> ${road.numberedRoadDetails}</p>`
      : "";
    const mapCheck = road.mapAreaCheck
      ? `<p class="detail-line">${road.mapAreaCheck}</p>`
      : "";
    const clusterZone = road.clusterZone
      ? `<p class="detail-line"><strong>Cluster zone:</strong> ${road.clusterZone}</p>`
      : "";
    const links = `
      <div class="card-links">
        ${road.googleMapsSearch ? `<a href="${road.googleMapsSearch}" target="_blank" rel="noopener">Search on Google Maps ↗</a>` : ""}
        ${road.evidenceUrl ? `<a href="${road.evidenceUrl}" target="_blank" rel="noopener">Verification source ↗</a>` : ""}
      </div>`;
    return `
      <div class="card" data-road-key="${encodeURIComponent(road.constituencyId + "#" + road.road)}">
        <h3>${road.road}</h3>
        <div class="badge-row">${constituencyBadge}${statusBadge}${confBadge}</div>
        ${numbered}
        ${mapCheck}
        ${clusterZone}
        <div class="part-pill-row">${partPillsHtml(road)}</div>
        ${links}
      </div>`;
  }

  function renderSearchResults(matches) {
    const container = el("search-results");
    if (!matches.length) {
      container.innerHTML = `<p class="no-results">No matches yet. Try a shorter or different fragment of the name — e.g. just "Cross" or "Colony" or a landmark.</p>`;
      return;
    }
    container.innerHTML = matches.map(roadCardHtml).join("");
  }

  function renderSuggestions(results) {
    const box = el("search-suggestions");
    if (!results.length) {
      box.classList.remove("open");
      box.innerHTML = "";
      return;
    }
    box.innerHTML = results
      .slice(0, 8)
      .map((r) => {
        const road = r.item;
        return `<div class="suggestion-item" data-road-key="${encodeURIComponent(road.constituencyId + "#" + road.road)}">
          ${road.road}
          <div class="parts-mini">${road.constituencyName} (${road.constituencyId}) · Part${road.parts.length > 1 ? "s" : ""} ${road.parts.join(", ")}</div>
        </div>`;
      })
      .join("");
    box.classList.add("open");
  }

  function setupSearch() {
    const input = el("search-input");
    const box = el("search-suggestions");
    const filterSelect = el("search-constituency-filter");
    let lastQuery = "";

    const runSearch = () => {
      const q = lastQuery;
      if (!q) {
        renderSuggestions([]);
        renderSearchResults([]);
        return;
      }
      let results = state.fuse.search(q, { limit: 50 });
      const filterValue = filterSelect.value;
      if (filterValue) {
        results = results.filter((r) => r.item.constituencyId === filterValue);
      }
      renderSuggestions(results);
      renderSearchResults(results.map((r) => r.item));
    };

    input.addEventListener("input", () => {
      lastQuery = input.value.trim();
      runSearch();
    });

    filterSelect.addEventListener("change", runSearch);

    box.addEventListener("click", (e) => {
      const item = e.target.closest(".suggestion-item");
      if (!item) return;
      const { constituencyId, road: roadName } = parseRoadKey(decodeURIComponent(item.dataset.roadKey));
      input.value = roadName;
      lastQuery = roadName;
      renderSuggestions([]);
      const road = state.roadIndex.find((r) => r.constituencyId === constituencyId && r.road === roadName);
      renderSearchResults(road ? [road] : []);
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-box")) {
        box.classList.remove("open");
      }
    });
  }

  // ---------- Part number lookup tab ----------

  function partCardHtml(part, constituency) {
    if (!constituency.hasData) {
      return `<p class="no-results">Data for ${constituency.name} (${constituency.id}) isn't available yet — check back soon.</p>`;
    }
    if (!part) {
      return `<p class="no-results">No part with that number (valid range: 1–${constituency.partCount}).</p>`;
    }
    const roadsList = part.roads
      ? part.roads.split("|").map((s) => s.trim()).join(", ")
      : "—";
    return `
      <div class="card">
        <h3>Part ${part.partNumber} <span class="detail-line" style="display:inline">(${part.partCode})</span></h3>
        <p class="detail-line"><strong>Roads / localities in this part:</strong> ${roadsList}</p>
        ${part.numberedRoadDetails ? `<p class="detail-line"><strong>Numbered roads:</strong> ${part.numberedRoadDetails}</p>` : ""}
        ${part.clusterZone ? `<p class="detail-line"><strong>Cluster zone:</strong> ${part.clusterZone}</p>` : ""}
        <p class="detail-line">Accepted entries: ${part.acceptedEntries} · Historical-only: ${part.historicalOnlyEntries} · Needs review: ${part.needsReview}</p>
        <div class="part-pill-row">
          <div class="part-pill">
            <a class="thumb-btn" href="${localImageUrl(part.partNumber, constituency.id)}" target="_blank" rel="noopener" data-preview="${localImageUrl(part.partNumber, constituency.id)}">Preview page</a>
            <a href="${part.officialPdfUrl}" target="_blank" rel="noopener">Download official PDF ↗</a>
          </div>
        </div>
      </div>`;
  }

  function updatePartInputRange(constituencyId) {
    const c = state.constituencyById.get(constituencyId);
    const input = el("part-input");
    input.max = c.partCount;
    input.placeholder = `Enter a part number (1–${c.partCount})`;
  }

  function setupPartLookup() {
    const input = el("part-input");
    const btn = el("part-go");
    const select = el("part-constituency-select");
    const run = () => {
      const constituency = state.constituencyById.get(select.value);
      const n = parseInt(input.value, 10);
      const part = constituency.hasData ? state.partByKey.get(`${constituency.id}#${n}`) : null;
      el("part-result").innerHTML = partCardHtml(part, constituency);
    };
    btn.addEventListener("click", run);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
    select.addEventListener("change", () => {
      updatePartInputRange(select.value);
      if (input.value) run();
    });
  }

  // ---------- Browse all tab ----------

  function renderBrowseAll(constituencyId) {
    const container = el("browse-list");
    const c = state.constituencyById.get(constituencyId);
    if (!c.hasData) {
      container.innerHTML = `<p class="no-results">Data for ${c.name} (${c.id}) isn't available yet — check back soon.</p>`;
      return;
    }
    const parts = [...state.partByKey.values()].filter((p) => p.constituencyId === constituencyId);
    container.innerHTML = parts
      .map((part) => {
        const roadsList = part.roads
          ? part.roads.split("|").map((s) => s.trim()).join(", ")
          : "—";
        return `
        <div class="card">
          <h3>Part ${part.partNumber}</h3>
          <p class="roads-list">${roadsList}</p>
          <div class="part-pill-row">
            <div class="part-pill">
              <a class="thumb-btn" href="${localImageUrl(part.partNumber, constituencyId)}" target="_blank" rel="noopener" data-preview="${localImageUrl(part.partNumber, constituencyId)}">Preview</a>
              <a href="${part.officialPdfUrl}" target="_blank" rel="noopener">PDF ↗</a>
            </div>
          </div>
        </div>`;
      })
      .join("");
  }

  function setupBrowseAll() {
    const select = el("browse-constituency-select");
    select.addEventListener("change", () => renderBrowseAll(select.value));
  }

  // ---------- Map tab ----------

  function initMapIfNeeded() {
    if (state.mapInitialized) {
      state.map.invalidateSize();
      return;
    }
    state.mapInitialized = true;

    const map = L.map("map").setView([12.9716, 77.5946], 11);
    state.map = map;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    const bounds = [];
    let unresolved = 0;

    state.roadIndex.forEach((road) => {
      const g = state.geocache[road.constituencyId]?.[road.road];
      if (!g) return;
      if (!g.resolved) {
        unresolved++;
        return;
      }
      const marker = L.marker([g.lat, g.lon]).addTo(map);
      const partsHtml = road.parts
        .map(
          (n) =>
            `Part ${n} — <a href="${officialPdfUrl(n, road.constituencyId)}" target="_blank" rel="noopener">PDF</a>`
        )
        .join("<br>");
      marker.bindPopup(`<strong>${road.road}</strong> <span class="badge constituency">${road.constituencyName}</span><br>${partsHtml}`);
      bounds.push([g.lat, g.lon]);
    });

    if (bounds.length) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
    }

    if (unresolved > 0) {
      const note = document.querySelector("#tab-map .hint");
      if (note) {
        note.insertAdjacentHTML(
          "beforeend",
          ` (${unresolved} location${unresolved === 1 ? "" : "s"} could not be placed on the map automatically — use search or browse-all instead.)`
        );
      }
    }
  }

  // ---------- Lightbox ----------

  function setupLightbox() {
    const lightbox = el("lightbox");
    const img = el("lightbox-img");
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".thumb-btn, .img-thumb-link");
      if (!btn) return;
      // Let ctrl/cmd/shift/middle-click fall through to the real href
      // (open in new tab / background tab) instead of hijacking it.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      img.src = btn.dataset.preview;
      lightbox.hidden = false;
    });
    el("lightbox-close").addEventListener("click", () => {
      lightbox.hidden = true;
      img.src = "";
    });
    lightbox.addEventListener("click", (e) => {
      if (e.target === lightbox) {
        lightbox.hidden = true;
        img.src = "";
      }
    });
  }

  // ---------- Feedback form ----------

  const FEEDBACK_ENDPOINT = "https://formsubmit.co/ajax/4b95fd3d9fb62ab4a5daeaa88caacfea";

  function setupFeedbackForm() {
    const form = el("feedback-form");
    const status = el("feedback-status");
    const submitBtn = el("feedback-submit");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = el("feedback-name").value.trim();
      const email = el("feedback-email").value.trim();
      const message = el("feedback-message").value.trim();
      if (!message) return;

      submitBtn.disabled = true;
      status.textContent = "Sending…";
      status.className = "small-note";

      try {
        const resp = await fetch(FEEDBACK_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            name: name || "(not provided)",
            email: email || "(not provided)",
            message,
            _subject: "BBMP SIR 2002 Electoral Roll Finder — feedback",
            page: location.href,
          }),
        });
        if (!resp.ok) throw new Error("Request failed");
        status.textContent = "Thanks — your feedback was sent!";
        status.className = "small-note success";
        form.reset();
      } catch (err) {
        console.error(err);
        status.innerHTML = `Couldn't send that automatically. Please <a href="mailto:rohit@trellisys.net?subject=${encodeURIComponent(
          "BBMP SIR 2002 Electoral Roll Finder — feedback"
        )}&body=${encodeURIComponent(message)}" class="subtle-link">email it instead</a>.`;
        status.className = "small-note error";
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // ---------- Init ----------

  async function init() {
    setupTabs();
    setupSearch();
    setupPartLookup();
    setupBrowseAll();
    setupLightbox();
    setupFeedbackForm();
    try {
      await loadData();
    } catch (err) {
      el("search-results").innerHTML = `<p class="no-results">Could not load data files. If you're running this locally, serve the folder with a local web server (e.g. <code>python3 -m http.server</code>) rather than opening index.html directly.</p>`;
      console.error(err);
    }
    const initialTab = location.hash.slice(1);
    if (initialTab && document.querySelector(`.tab-btn[data-tab="${initialTab}"]`)) {
      activateTab(initialTab, { fromHashChange: true });
    }
  }

  init();
})();
