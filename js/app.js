(function () {
  "use strict";

  const state = {
    roadIndex: [],
    partSummary: [],
    partByNumber: new Map(),
    geocache: {},
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

  function officialPdfUrl(partNumber) {
    const code = "A087" + String(partNumber).padStart(4, "0");
    return `https://ceo.karnataka.gov.in/uploads/BBMP/AC%2087/${code}.pdf`;
  }

  function localImageUrl(partNumber) {
    const code = "A087" + String(partNumber).padStart(4, "0");
    return `images/${code}.png`;
  }

  // ---------- Data loading ----------

  async function loadData() {
    const [roadIndex, partSummary, geocache] = await Promise.all([
      fetch("data/road_index.json").then((r) => r.json()),
      fetch("data/part_summary.json").then((r) => r.json()),
      fetch("data/geocache.json").then((r) => r.json()).catch(() => ({})),
    ]);
    state.roadIndex = roadIndex;
    state.partSummary = partSummary;
    state.geocache = geocache;
    partSummary.forEach((p) => state.partByNumber.set(p.partNumber, p));

    state.fuse = new Fuse(roadIndex, {
      keys: [
        { name: "road", weight: 0.7 },
        { name: "numberedRoadDetails", weight: 0.3 },
      ],
      threshold: 0.38,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });
  }

  // ---------- Tabs ----------

  function setupTabs() {
    const buttons = document.querySelectorAll(".tab-btn");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        buttons.forEach((b) => {
          b.classList.remove("active");
          b.setAttribute("aria-selected", "false");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-selected", "true");
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        el("tab-" + btn.dataset.tab).classList.add("active");
        if (btn.dataset.tab === "map") {
          initMapIfNeeded();
        }
        if (btn.dataset.tab === "browse" && !el("browse-list").dataset.rendered) {
          renderBrowseAll();
        }
      });
    });
  }

  // ---------- Search tab ----------

  function partPillsHtml(road) {
    return road.parts
      .map((n) => {
        const part = state.partByNumber.get(n);
        const code = part ? part.partCode : "A087" + String(n).padStart(4, "0");
        return `
        <div class="part-pill">
          <span class="num">Part ${n}</span>
          <button class="thumb-btn" data-preview="${localImageUrl(n)}">Preview</button>
          <a href="${officialPdfUrl(n)}" target="_blank" rel="noopener">Official PDF ↗</a>
        </div>`;
      })
      .join("");
  }

  function roadCardHtml(road) {
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
    const links = `
      <div class="card-links">
        ${road.googleMapsSearch ? `<a href="${road.googleMapsSearch}" target="_blank" rel="noopener">Search on Google Maps ↗</a>` : ""}
        ${road.evidenceUrl ? `<a href="${road.evidenceUrl}" target="_blank" rel="noopener">Verification source ↗</a>` : ""}
      </div>`;
    return `
      <div class="card" data-road="${encodeURIComponent(road.road)}">
        <h3>${road.road}</h3>
        <div class="badge-row">${statusBadge}${confBadge}</div>
        ${numbered}
        ${mapCheck}
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
        return `<div class="suggestion-item" data-road="${encodeURIComponent(road.road)}">
          ${road.road}
          <div class="parts-mini">Part${road.parts.length > 1 ? "s" : ""} ${road.parts.join(", ")}</div>
        </div>`;
      })
      .join("");
    box.classList.add("open");
  }

  function setupSearch() {
    const input = el("search-input");
    const box = el("search-suggestions");

    input.addEventListener("input", () => {
      const q = input.value.trim();
      if (!q) {
        renderSuggestions([]);
        renderSearchResults([]);
        return;
      }
      const results = state.fuse.search(q, { limit: 20 });
      renderSuggestions(results);
      renderSearchResults(results.map((r) => r.item));
    });

    box.addEventListener("click", (e) => {
      const item = e.target.closest(".suggestion-item");
      if (!item) return;
      const roadName = decodeURIComponent(item.dataset.road);
      input.value = roadName;
      renderSuggestions([]);
      const road = state.roadIndex.find((r) => r.road === roadName);
      renderSearchResults(road ? [road] : []);
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-box")) {
        box.classList.remove("open");
      }
    });
  }

  // ---------- Part number lookup tab ----------

  function partCardHtml(part) {
    if (!part) {
      return `<p class="no-results">No part with that number (valid range: 1–197).</p>`;
    }
    const roadsList = part.roads
      ? part.roads.split("|").map((s) => s.trim()).join(", ")
      : "—";
    return `
      <div class="card">
        <h3>Part ${part.partNumber} <span class="detail-line" style="display:inline">(${part.partCode})</span></h3>
        <p class="detail-line"><strong>Roads / localities in this part:</strong> ${roadsList}</p>
        ${part.numberedRoadDetails ? `<p class="detail-line"><strong>Numbered roads:</strong> ${part.numberedRoadDetails}</p>` : ""}
        <p class="detail-line">Accepted entries: ${part.acceptedEntries} · Historical-only: ${part.historicalOnlyEntries} · Needs review: ${part.needsReview}</p>
        <div class="part-pill-row">
          <div class="part-pill">
            <button class="thumb-btn" data-preview="${localImageUrl(part.partNumber)}">Preview page</button>
            <a href="${part.officialPdfUrl}" target="_blank" rel="noopener">Download official PDF ↗</a>
          </div>
        </div>
      </div>`;
  }

  function setupPartLookup() {
    const input = el("part-input");
    const btn = el("part-go");
    const run = () => {
      const n = parseInt(input.value, 10);
      const part = state.partByNumber.get(n);
      el("part-result").innerHTML = partCardHtml(part);
    };
    btn.addEventListener("click", run);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
  }

  // ---------- Browse all tab ----------

  function renderBrowseAll() {
    const container = el("browse-list");
    container.dataset.rendered = "1";
    container.innerHTML = state.partSummary
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
              <button class="thumb-btn" data-preview="${localImageUrl(part.partNumber)}">Preview</button>
              <a href="${part.officialPdfUrl}" target="_blank" rel="noopener">PDF ↗</a>
            </div>
          </div>
        </div>`;
      })
      .join("");
  }

  // ---------- Map tab ----------

  function initMapIfNeeded() {
    if (state.mapInitialized) {
      state.map.invalidateSize();
      return;
    }
    state.mapInitialized = true;

    const map = L.map("map").setView([12.9995, 77.5985], 14);
    state.map = map;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    const bounds = [];
    let unresolved = 0;

    state.roadIndex.forEach((road) => {
      const g = state.geocache[road.road];
      if (!g) return;
      if (!g.resolved) {
        unresolved++;
        return;
      }
      const marker = L.marker([g.lat, g.lon]).addTo(map);
      const partsHtml = road.parts
        .map(
          (n) =>
            `Part ${n} — <a href="${officialPdfUrl(n)}" target="_blank" rel="noopener">PDF</a>`
        )
        .join("<br>");
      marker.bindPopup(`<strong>${road.road}</strong><br>${partsHtml}`);
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
      const btn = e.target.closest(".thumb-btn");
      if (btn) {
        img.src = btn.dataset.preview;
        lightbox.hidden = false;
      }
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

  // ---------- Init ----------

  async function init() {
    setupTabs();
    setupSearch();
    setupPartLookup();
    setupLightbox();
    try {
      await loadData();
    } catch (err) {
      el("search-results").innerHTML = `<p class="no-results">Could not load data files. If you're running this locally, serve the folder with a local web server (e.g. <code>python3 -m http.server</code>) rather than opening index.html directly.</p>`;
      console.error(err);
    }
  }

  init();
})();
