/* LeadScout dashboard — vanilla JS, no build step, no dependencies beyond Leaflet (CDN). */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  // Business names / addresses / server strings are untrusted — escape before innerHTML.
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  // Mirrors the server-side slug algorithm (markdown module):
  // lowercase, non-alphanumerics -> '-', collapse dashes, trim dashes.
  const slugify = (name) =>
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const basename = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const fmtRadius = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

  const KIND_LABEL = {
    'no-website': 'no website',
    'broken-website': 'broken site',
    'needs-improvement': 'needs work',
  };
  const KIND_COLOR = {
    'no-website': '#f87171',
    'broken-website': '#fb923c',
    'needs-improvement': '#facc15',
  };

  // Signature score visualization: a luminous SVG ring, color-graded by score.
  // The number is still rendered (and announced) for accessibility.
  const RING_R = 15.5;
  const RING_C = 2 * Math.PI * RING_R; // circumference
  function scoreChipHtml(score) {
    const s = clamp(Math.round(Number(score) || 0), 0, 100);
    const grade = s >= 70 ? 'high' : s >= 40 ? 'mid' : 'low';
    const offset = (RING_C * (1 - s / 100)).toFixed(2);
    return (
      `<span class="score-ring grade-${grade}" role="img" aria-label="Lead score ${s} of 100">` +
      `<svg viewBox="0 0 40 40" aria-hidden="true">` +
      `<circle class="ring-track" cx="20" cy="20" r="${RING_R}"></circle>` +
      `<circle class="ring-fill" cx="20" cy="20" r="${RING_R}" ` +
      `stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${offset}"></circle>` +
      `</svg><span class="score-num">${s}</span></span>`
    );
  }

  const kindBadgeHtml = (kind) =>
    `<span class="badge badge-${esc(kind)}">${esc(KIND_LABEL[kind] || kind)}</span>`;

  function telHtml(phone) {
    if (!phone) return '';
    return `<a href="tel:${esc(String(phone).replace(/[^+\d]/g, ''))}">${esc(phone)}</a>`;
  }

  function ratingText(b) {
    if (b.rating == null) return '';
    return `${Number(b.rating).toFixed(1)}★ (${b.ratingCount ?? 0})`;
  }

  // ---------------------------------------------------------------- state
  const state = {
    center: null, // { lat, lng } | null
    radius: 2000,
    running: false,
    result: null, // last ScanResult
    uid: '', // authenticated user id (leads live under /leads/<uid>/)
    me: null, // last /api/auth/me summary
    subdir: '', // basename of result.outDir
    sortDesc: true,
    sortBy: 'score', // score | name | reviews | value | winnability
    searchQuery: '',
    filterKinds: new Set(), // empty => all kinds
    minScore: 0,
    abort: null, // AbortController for the running scan
  };

  const WINNABILITY_RANK = { easy: 0, medium: 1, hard: 2 };

  // ---------------------------------------------------------------- theme
  const THEME_KEY = 'lf-theme';
  const TILE_URL = {
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  };
  const currentTheme = () => document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

  // ---------------------------------------------------------------- map
  const FALLBACK_CENTER = { lat: 12.9758, lng: 77.6045 };
  const map = L.map('map', { zoomControl: false }).setView(
    [FALLBACK_CENTER.lat, FALLBACK_CENTER.lng],
    13,
  );
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  const tileLayer = L.tileLayer(TILE_URL[currentTheme()], {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);

  const leadLayer = L.layerGroup().addTo(map);
  let centerMarker = null;
  let radiusCircle = null;

  const centerIcon = L.divIcon({
    className: 'center-pin-wrap',
    html: '<div class="center-pin"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });

  function setCenter(lat, lng, pan) {
    state.center = { lat, lng };
    const ll = [lat, lng];
    if (!centerMarker) {
      radiusCircle = L.circle(ll, {
        radius: state.radius,
        color: '#2dd4bf',
        weight: 1.5,
        opacity: 0.7,
        fillColor: '#2dd4bf',
        fillOpacity: 0.07,
        interactive: false,
      }).addTo(map);
      centerMarker = L.marker(ll, { draggable: true, icon: centerIcon }).addTo(map);
      centerMarker.on('drag', () => {
        const p = centerMarker.getLatLng();
        state.center = { lat: p.lat, lng: p.lng };
        radiusCircle.setLatLng(p);
      });
    } else {
      centerMarker.setLatLng(ll);
      radiusCircle.setLatLng(ll);
    }
    if (pan) map.panTo(ll);
    updateScanButton();
  }

  map.on('click', (e) => setCenter(e.latlng.lat, e.latlng.lng, false));

  function leadPopupHtml(lead) {
    const b = lead.business;
    let html = `<strong>${esc(b.name)}</strong><br>Lead score ${clamp(Math.round(lead.leadScore), 0, 100)}`;
    if (b.phone) html += `<br>${telHtml(b.phone)}`;
    return html;
  }

  function addLeadMarker(lead) {
    const b = lead.business;
    if (!b || !b.location) return;
    L.circleMarker([b.location.lat, b.location.lng], {
      radius: 7,
      color: '#0d1117',
      weight: 1.5,
      fillColor: KIND_COLOR[lead.kind] || '#2dd4bf',
      fillOpacity: 0.9,
    })
      .bindPopup(leadPopupHtml(lead))
      .addTo(leadLayer);
  }

  function rebuildMarkers(leads) {
    leadLayer.clearLayers();
    leads.forEach(addLeadMarker);
  }

  // ---------------------------------------------------------------- config
  fetch('/api/config')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((cfg) => {
      if (cfg && cfg.demoMode) {
        $('demo-banner').hidden = false;
      } else if (cfg && cfg.source === 'osm') {
        const banner = $('demo-banner');
        banner.textContent =
          'Free mode — data from OpenStreetMap (no ratings, thinner coverage). Add a Google key in .env for full data.';
        banner.hidden = false;
      }
      const c = cfg && cfg.defaultCenter;
      if (c && typeof c.lat === 'number' && typeof c.lng === 'number') {
        map.setView([c.lat, c.lng], 13);
      }
    })
    .catch(() => {
      /* keep hardcoded fallback view */
    });

  // ---------------------------------------------------------------- radius
  const radiusSlider = $('radius-slider');
  const radiusLabel = $('radius-label');
  radiusSlider.addEventListener('input', () => {
    state.radius = Number(radiusSlider.value);
    radiusLabel.textContent = fmtRadius(state.radius);
    if (radiusCircle) radiusCircle.setRadius(state.radius);
  });

  // ---------------------------------------------------------------- categories
  const categoriesEl = $('categories');

  function setAllCategories(checked) {
    categoriesEl
      .querySelectorAll('input[type="checkbox"]')
      .forEach((cb) => (cb.checked = checked));
  }

  function loadCategories() {
    categoriesEl.innerHTML = '<span class="hint">Loading categories…</span>';
    fetch('/api/categories')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((groups) => {
        categoriesEl.innerHTML = '';
        groups.forEach((g) => {
          const row = document.createElement('label');
          row.className = 'cat';
          row.innerHTML =
            `<input type="checkbox" value="${esc(g.key)}" checked>` +
            `<span class="cat-label">${esc(g.label)}</span>` +
            `<span class="cat-count">${Number(g.types?.length) || 0}</span>`;
          categoriesEl.appendChild(row);
        });
      })
      .catch(() => {
        categoriesEl.innerHTML =
          '<span class="hint">Couldn’t load categories. </span>';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'linklike';
        retry.textContent = 'retry';
        retry.addEventListener('click', loadCategories);
        categoriesEl.appendChild(retry);
      });
  }
  loadCategories();

  $('cat-all').addEventListener('click', () => setAllCategories(true));
  $('cat-none').addEventListener('click', () => setAllCategories(false));

  const selectedCategoryKeys = () =>
    [...categoriesEl.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);

  // ---------------------------------------------------------------- place search
  const placeInput = $('place-input');
  const placeBtn = $('place-btn');
  const placeResults = $('place-results');
  let searchTimer = 0;
  let searchAbort = null;

  function hidePlaceResults() {
    placeResults.hidden = true;
    placeResults.innerHTML = '';
  }

  function showPlaceMessage(text) {
    placeResults.hidden = false;
    placeResults.innerHTML = `<li class="muted">${esc(text)}</li>`;
  }

  async function searchPlace() {
    const q = placeInput.value.trim();
    if (!q) {
      hidePlaceResults();
      return;
    }
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    const timeout = setTimeout(() => searchAbort.abort(), 10_000);
    placeBtn.disabled = true;
    try {
      // Nominatim is intentionally cross-origin — it allows CORS.
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`;
      const res = await fetch(url, { signal: searchAbort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = await res.json();
      if (!Array.isArray(items) || items.length === 0) {
        showPlaceMessage('No places found.');
        return;
      }
      placeResults.hidden = false;
      placeResults.innerHTML = '';
      items.forEach((item) => {
        const li = document.createElement('li');
        li.tabIndex = 0;
        li.textContent = item.display_name || `${item.lat}, ${item.lon}`;
        const pick = () => {
          const lat = Number(item.lat);
          const lng = Number(item.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
          setCenter(lat, lng, false);
          map.setView([lat, lng], Math.max(map.getZoom(), 14));
          hidePlaceResults();
        };
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') pick();
        });
        placeResults.appendChild(li);
      });
    } catch (err) {
      if (err.name !== 'AbortError') showPlaceMessage('Search failed — try again.');
    } finally {
      clearTimeout(timeout);
      placeBtn.disabled = false;
    }
  }

  placeBtn.addEventListener('click', () => {
    clearTimeout(searchTimer);
    searchPlace();
  });
  placeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      searchPlace();
    }
  });
  placeInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    if (placeInput.value.trim().length < 3) {
      hidePlaceResults();
      return;
    }
    searchTimer = setTimeout(searchPlace, 450);
  });

  // ---------------------------------------------------------------- status + progress
  const statusEl = $('status');
  const progressEl = $('progress');
  const progressFill = $('progress-fill');

  function setStatus(text, kind) {
    statusEl.hidden = false;
    statusEl.textContent = text; // textContent — never HTML
    statusEl.className = `status${kind ? ` ${kind}` : ''}`;
  }

  /** pct: 0..100, 'indeterminate', or null to hide. */
  function setProgress(pct) {
    if (pct == null) {
      progressEl.hidden = true;
      return;
    }
    progressEl.hidden = false;
    if (pct === 'indeterminate') {
      progressEl.classList.add('indeterminate');
      progressFill.style.transform = '';
    } else {
      progressEl.classList.remove('indeterminate');
      progressFill.style.transform = `scaleX(${clamp(pct, 0, 100) / 100})`;
    }
  }

  // ---------------------------------------------------------------- scan button
  const scanBtn = $('scan-btn');

  const cancelBtn = $('cancel-btn');

  function updateScanButton() {
    scanBtn.disabled = state.running || !state.center;
    // Route the label through the shader handle when enhanced, else set text
    // directly — otherwise textContent would wipe the shader spans.
    const scanTxt = state.running ? 'Scanning…' : 'Scan';
    if (scanBtn._lfLiquid) scanBtn._lfLiquid.setLabel(scanTxt);
    else scanBtn.textContent = scanTxt;
    scanBtn.classList.toggle('running', state.running);
    cancelBtn.hidden = !state.running;
    $('scan-hint').hidden = !!state.center || state.running;
  }

  cancelBtn.addEventListener('click', () => {
    if (state.abort) state.abort.abort();
    setStatus('Cancelling…');
  });

  // ---------------------------------------------------------------- live feed
  const liveFeed = $('live-feed');
  const MAX_FEED_CARDS = 60;

  function pushLiveLead(lead) {
    liveFeed.hidden = false;
    const card = document.createElement('div');
    card.className = 'lead-card';
    card.innerHTML =
      scoreChipHtml(lead.leadScore) +
      `<span class="lead-card-name">${esc(lead.business?.name)}</span>` +
      kindBadgeHtml(lead.kind);
    liveFeed.prepend(card);
    while (liveFeed.children.length > MAX_FEED_CARDS) liveFeed.lastChild.remove();
  }

  // ---------------------------------------------------------------- results
  const finalResults = $('final-results');
  const sortBtn = $('sort-btn');

  const leadsPrefix = () => `/leads/${encodeURIComponent(state.uid)}`;

  function leadAsset(name, ext) {
    return `${leadsPrefix()}/${encodeURIComponent(state.subdir)}/${encodeURIComponent(slugify(name))}${ext}`;
  }
  const leadFileHref = (name) => leadAsset(name, '.md');

  function statusSelectHtml(lead) {
    const id = lead.business?.id || '';
    const cur = lead.status || 'new';
    const opts = ['new', 'contacted', 'interested', 'won', 'dead']
      .map((s) => `<option value="${s}"${s === cur ? ' selected' : ''}>${s}</option>`)
      .join('');
    return `<select class="status-select" data-id="${esc(id)}" title="pipeline status">${opts}</select>`;
  }

  async function postStatus(id, status) {
    try {
      await fetch(`/api/leads/${encodeURIComponent(id)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } catch {
      /* best-effort; UI already reflects the choice */
    }
  }

  async function copyPrompt(name, btn) {
    try {
      const res = await fetch(leadAsset(name, '.prompt.md'));
      if (!res.ok) throw new Error();
      await navigator.clipboard.writeText(await res.text());
      const prev = btn.textContent;
      btn.textContent = 'copied ✓';
      setTimeout(() => (btn.textContent = prev), 1500);
    } catch {
      btn.textContent = 'copy failed';
    }
  }

  function leadMatchesSearch(lead, q) {
    if (!q) return true;
    const b = lead.business || {};
    const hay = `${b.name || ''} ${b.phone || ''} ${b.address || ''} ${b.primaryType || ''}`.toLowerCase();
    return hay.includes(q);
  }

  // Comparator returning a value for the active sort field; name sorts by
  // string, everything else by number. Direction applied by the caller.
  function sortValue(lead) {
    const b = lead.business || {};
    switch (state.sortBy) {
      case 'name':
        return (b.name || '').toLowerCase();
      case 'reviews':
        return b.ratingCount || 0;
      case 'value':
        return lead.estValue?.high || 0;
      case 'winnability':
        return WINNABILITY_RANK[lead.winnability] ?? 1;
      default:
        return lead.leadScore || 0;
    }
  }

  function filteredLeads() {
    const q = state.searchQuery.trim().toLowerCase();
    const dir = state.sortDesc ? 1 : -1;
    return [...(state.result?.leads || [])]
      .filter((l) => state.filterKinds.size === 0 || state.filterKinds.has(l.kind))
      .filter((l) => (l.leadScore || 0) >= state.minScore)
      .filter((l) => leadMatchesSearch(l, q))
      .sort((a, b) => {
        const va = sortValue(a);
        const vb = sortValue(b);
        if (typeof va === 'string') return dir * va.localeCompare(vb);
        return dir * (vb - va); // desc by default for numbers (higher first)
      });
  }

  function renderLeadList() {
    const leads = filteredLeads();
    sortBtn.textContent = state.sortDesc ? '↓' : '↑';
    const total = state.result?.leads?.length || 0;
    const countEl = $('lead-count');
    if (countEl) countEl.textContent = leads.length === total ? `${total}` : `${leads.length}/${total}`;
    const listEl = $('lead-list');
    if (leads.length === 0) {
      listEl.innerHTML = '<li class="lead-empty">No leads match these filters.</li>';
      return;
    }
    listEl.innerHTML = leads
      .map((lead) => {
        const b = lead.business || {};
        const metaBits = [
          ratingText(b) && esc(ratingText(b)),
          b.phone && telHtml(b.phone),
          lead.estValue?.label && `<span class="est">${esc(lead.estValue.label)}</span>`,
          lead.winnability && `<span class="win win-${esc(lead.winnability)}">${esc(lead.winnability)}</span>`,
          lead.isNew && '<span class="new-badge">new</span>',
        ].filter(Boolean);
        const need = lead.needs?.[0];
        return (
          `<li class="lead-row">${scoreChipHtml(lead.leadScore)}` +
          `<div class="lead-main">` +
          `<div class="lead-top"><span class="lead-name" title="${esc(b.name)}">${esc(b.name)}</span>${kindBadgeHtml(lead.kind)}</div>` +
          (metaBits.length ? `<div class="lead-meta">${metaBits.join(' · ')}</div>` : '') +
          (need ? `<div class="lead-need">${esc(need)}</div>` : '') +
          `<div class="lead-links">` +
          (b.googleMapsUri
            ? `<a href="${esc(b.googleMapsUri)}" target="_blank" rel="noopener noreferrer">listing ↗</a>`
            : '') +
          `<a href="${leadAsset(b.name, '.preview.html')}" target="_blank" rel="noopener">preview</a>` +
          `<a href="${leadAsset(b.name, '.audit.html')}" target="_blank" rel="noopener">audit</a>` +
          `<a href="${leadFileHref(b.name)}" target="_blank" rel="noopener">brief</a>` +
          `<button type="button" class="copy-prompt" data-name="${esc(b.name)}">copy prompt</button>` +
          statusSelectHtml(lead) +
          `</div>` +
          `</div></li>`
        );
      })
      .join('');
  }

  // Sync the map's center pin + radius circle (and the slider) to a scan's
  // area — needed when results arrive without the user having placed the pin
  // this session (history load, post-refresh) and when the server clamped the
  // requested radius to the plan's max.
  function applyScanArea(area) {
    const c = area?.center;
    if (!c || typeof c.lat !== 'number' || typeof c.lng !== 'number') return;
    setCenter(c.lat, c.lng, false);
    const r = Number(area.radiusMeters);
    if (Number.isFinite(r) && r > 0) {
      state.radius = clamp(r, Number(radiusSlider.min), Number(radiusSlider.max));
      radiusSlider.value = state.radius;
      radiusLabel.textContent = fmtRadius(state.radius);
      radiusCircle.setRadius(state.radius);
    }
  }

  // `subdirHint` covers results loaded from a saved leads.json, which is
  // written before outDir exists on the result — the caller (history browser)
  // already knows which scan dir it fetched from.
  function renderResults(result, subdirHint) {
    state.result = result;
    state.subdir = result.outDir ? basename(result.outDir) : subdirHint || state.subdir;
    state.sortDesc = true;
    applyScanArea(result.area);

    liveFeed.hidden = true;
    liveFeed.innerHTML = '';
    $('empty-state').hidden = true;
    finalResults.hidden = false;

    const byKind = { 'no-website': 0, 'broken-website': 0, 'needs-improvement': 0 };
    (result.leads || []).forEach((l) => {
      byKind[l.kind] = (byKind[l.kind] || 0) + 1;
    });

    $('stats').innerHTML =
      `<div class="stat"><b>${Number(result.totalFound) || 0}</b><span>found</span></div>` +
      `<div class="stat teal"><b>${result.leads?.length || 0}</b><span>leads</span></div>` +
      `<div class="stat"><b>${Number(result.skipped) || 0}</b><span>healthy</span></div>` +
      `<div class="stat red"><b>${byKind['no-website']}</b><span>no site</span></div>` +
      `<div class="stat orange"><b>${byKind['broken-website']}</b><span>broken</span></div>` +
      `<div class="stat yellow"><b>${byKind['needs-improvement']}</b><span>needs work</span></div>`;

    const sub = `${leadsPrefix()}/${encodeURIComponent(state.subdir)}`;
    $('files').innerHTML =
      `<a href="${sub}/summary.html" target="_blank" rel="noopener">Gallery</a>` +
      `<a href="${sub}/SUMMARY.md" target="_blank" rel="noopener">SUMMARY.md</a>` +
      `<a href="${sub}/leads.json" download>leads.json</a>` +
      `<a href="/api/export.csv" download>Pipeline CSV</a>`;

    buildKindFilters(result.leads || []);

    const outdirNote = document.createElement('p');
    outdirNote.className = 'outdir';
    outdirNote.innerHTML = `Saved to <code>${esc(result.outDir || state.subdir)}</code>`;
    $('files').after(outdirNote);
    // Keep only the newest note if re-scanning.
    let sib = outdirNote.nextElementSibling;
    while (sib && sib.classList.contains('outdir')) {
      const gone = sib;
      sib = sib.nextElementSibling;
      gone.remove();
    }

    renderLeadList();
    rebuildMarkers(result.leads || []);
  }

  sortBtn.addEventListener('click', () => {
    state.sortDesc = !state.sortDesc;
    renderLeadList();
  });

  // ---------------------------------------------------------------- filters
  function buildKindFilters(leads) {
    const counts = { 'no-website': 0, 'broken-website': 0, 'needs-improvement': 0 };
    leads.forEach((l) => (counts[l.kind] = (counts[l.kind] || 0) + 1));
    const el = $('kind-filters');
    el.innerHTML = Object.keys(counts)
      .filter((k) => counts[k] > 0)
      .map((k) => {
        const on = state.filterKinds.has(k);
        return `<button type="button" class="chip${on ? ' on' : ''}" data-kind="${esc(k)}">${esc(KIND_LABEL[k] || k)} ${counts[k]}</button>`;
      })
      .join('');
  }

  $('kind-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const k = btn.dataset.kind;
    if (state.filterKinds.has(k)) state.filterKinds.delete(k);
    else state.filterKinds.add(k);
    btn.classList.toggle('on');
    renderLeadList();
  });

  const minScoreEl = $('min-score');
  minScoreEl.addEventListener('input', () => {
    state.minScore = Number(minScoreEl.value);
    $('min-score-val').textContent = state.minScore;
    renderLeadList();
  });

  const searchEl = $('lead-search');
  searchEl.addEventListener('input', () => {
    state.searchQuery = searchEl.value;
    renderLeadList();
  });

  const sortByEl = $('sort-by');
  sortByEl.addEventListener('change', () => {
    state.sortBy = sortByEl.value;
    // Name defaults to A→Z (ascending); other fields default to highest-first.
    state.sortDesc = state.sortBy !== 'name';
    renderLeadList();
  });

  // ---------------------------------------------------------------- lead-row actions
  $('lead-list').addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy-prompt');
    if (copyBtn) copyPrompt(copyBtn.dataset.name, copyBtn);
  });
  $('lead-list').addEventListener('change', (e) => {
    const sel = e.target.closest('.status-select');
    if (sel && sel.dataset.id) postStatus(sel.dataset.id, sel.value);
  });

  // ---------------------------------------------------------------- event stream
  function handleEvent(ev) {
    switch (ev.type) {
      case 'phase':
        setStatus(ev.message);
        if (ev.phase === 'search') setProgress('indeterminate');
        else if (ev.phase === 'audit') setProgress(0);
        else if (ev.phase === 'write') setProgress(100);
        break;
      case 'search':
        setStatus(`Searching… cell ${ev.cell}/${ev.cells} · ${ev.found} found`);
        setProgress('indeterminate');
        break;
      case 'verify':
        setStatus(`Live-verifying ${ev.done}/${ev.total} · ${ev.current}`);
        setProgress(ev.total > 0 ? (ev.done / ev.total) * 100 : 0);
        break;
      case 'audit':
        setStatus(`Auditing ${ev.done}/${ev.total} · ${ev.current}`);
        setProgress(ev.total > 0 ? (ev.done / ev.total) * 100 : 0);
        break;
      case 'lead':
        pushLiveLead(ev.lead);
        addLeadMarker(ev.lead);
        break;
      case 'error':
        setStatus(ev.message, 'error');
        break;
      case 'done':
        renderResults(ev.result);
        setProgress(null);
        setStatus(
          `Done — ${ev.result.leads?.length || 0} leads from ${ev.result.totalFound} businesses`,
          'ok',
        );
        break;
      default:
        break; // forward-compatible: ignore unknown event types
    }
  }

  function processChunk(chunkText) {
    for (const block of chunkText.split('\n\n')) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          handleEvent(JSON.parse(line.slice(6)));
        } catch {
          /* skip malformed event */
        }
      }
    }
  }

  async function startScan() {
    if (state.running || !state.center) return;

    const maxRaw = parseInt($('max-input').value, 10);
    const body = {
      area: { center: state.center, radiusMeters: state.radius },
      categories: selectedCategoryKeys(),
      maxBusinesses: clamp(Number.isFinite(maxRaw) ? maxRaw : 300, 1, 2000),
      psi: $('psi-toggle').checked,
      liveVerify: $('live-verify-toggle').checked,
    };

    state.running = true;
    state.abort = new AbortController();
    updateScanButton();
    $('empty-state').hidden = true;
    finalResults.hidden = true;
    liveFeed.hidden = true;
    liveFeed.innerHTML = '';
    leadLayer.clearLayers();
    setStatus('Starting scan…');
    setProgress('indeterminate');

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: state.abort.signal,
      });

      if (res.status === 401) {
        location.href = '/login.html';
        return;
      }
      if (res.status === 409) {
        setStatus('A scan is already running — let it finish first.', 'error');
        return;
      }
      if (res.status === 402) {
        const data = await res.json().catch(() => ({}));
        setStatus(data.error || 'Scan quota reached for this plan.', 'error');
        openBillingModal(data.error);
        return;
      }
      if (!res.ok || !res.body) {
        setStatus(`Scan failed (HTTP ${res.status}).`, 'error');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Complete SSE frames end with a blank line; keep the tail buffered.
        const cut = buf.lastIndexOf('\n\n');
        if (cut === -1) continue;
        processChunk(buf.slice(0, cut));
        buf = buf.slice(cut + 2);
      }
      buf += decoder.decode();
      if (buf.trim()) processChunk(buf);
    } catch (err) {
      if (err.name === 'AbortError') setStatus('Scan cancelled.', 'error');
      else setStatus(`Network error — ${err.message || err}`, 'error');
    } finally {
      state.running = false;
      state.abort = null;
      updateScanButton();
      setProgress(null);
      loadHistory();
      refreshMe(); // scan consumed quota — update the header
      if (!state.result && !statusEl.classList.contains('error')) {
        $('empty-state').hidden = false;
      }
    }
  }

  scanBtn.addEventListener('click', startScan);
  updateScanButton();

  // ---------------------------------------------------------------- history browser
  // History retention is plan-gated. Prefer the server's historyDays when the
  // backend surfaces it; otherwise derive from tier (free 0 / starter 2 / pro+ full).
  function historyDaysFor(plan) {
    if (!plan) return 0;
    if (typeof plan.historyDays === 'number') return plan.historyDays;
    const tier = Number(plan.tier) || 0;
    return tier === 0 ? 0 : tier === 1 ? 2 : 3650; // pro/lifetime → effectively full
  }

  function retentionLabel(days) {
    if (days <= 0) return 'Not available on the free plan';
    if (days >= 365) return 'Full history retained';
    return days === 1 ? 'Last 24 hours' : `Last ${days} days`;
  }

  function renderHistoryLocked() {
    const body = $('history-body');
    body.innerHTML =
      `<div class="history-locked">` +
      `<div class="lock-badge" aria-hidden="true">🔒</div>` +
      `<h4>Keep every scan</h4>` +
      `<p>Scan history is a paid feature. Upgrade to save your leads and revisit past scans anytime.</p>` +
      `<button type="button" class="upgrade-cta" id="history-upgrade">Upgrade to unlock</button>` +
      `</div>`;
    const up = $('history-upgrade');
    if (up) up.addEventListener('click', () => openBillingModal());
  }

  function loadHistory() {
    const section = $('history-section');
    const retentionEl = $('history-retention');
    const body = $('history-body');
    // Wait until we know the plan; boot() calls loadHistory after refreshMe.
    const days = historyDaysFor(state.me?.plan);
    section.hidden = false;
    retentionEl.textContent = retentionLabel(days);

    if (days <= 0) {
      renderHistoryLocked();
      return;
    }

    fetch('/api/leads')
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        // API returns { scans, historyDays, retentionLocked }; tolerate a bare
        // array from older builds.
        const scans = Array.isArray(data) ? data : data.scans || [];
        if (data && data.retentionLocked) {
          renderHistoryLocked();
          return;
        }
        if (typeof data?.historyDays === 'number') {
          retentionEl.textContent = retentionLabel(data.historyDays);
        }
        if (!Array.isArray(scans) || scans.length === 0) {
          body.innerHTML = `<p class="history-empty">No scans yet — run your first scan above.</p>`;
          return;
        }
        body.innerHTML =
          `<ul id="history-list" class="history-list">` +
          scans
            .slice(0, 20)
            .map((s) => {
              const count = typeof s.leadCount === 'number' ? `${s.leadCount} leads` : `${(s.files || []).length} files`;
              return `<li><button type="button" class="history-item" data-dir="${esc(s.dir)}">${esc(s.dir)}</button><span class="history-count">${esc(count)}</span></li>`;
            })
            .join('') +
          `</ul>`;
      })
      .catch(() => {
        body.innerHTML = `<p class="history-empty">Could not load history.</p>`;
      });
  }

  $('history-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.history-item');
    if (!btn) return;
    const dir = btn.dataset.dir;
    fetch(`${leadsPrefix()}/${encodeURIComponent(dir)}/leads.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .then((result) => {
        renderResults(result, dir);
        setStatus(`Loaded ${result.leads?.length || 0} leads from ${dir}`, 'ok');
        const c = result.area?.center;
        if (c) map.setView([c.lat, c.lng], 13);
      })
      .catch(() => setStatus('Could not load that scan.', 'error'));
  });

  $('history-refresh').addEventListener('click', loadHistory);

  // ---------------------------------------------------------------- account + billing
  const accountBar = $('account-bar');
  const modalRoot = $('modal-root');

  const CYCLE_LABEL = { monthly: 'Monthly', yearly: 'Yearly', lifetime: 'Lifetime' };

  function renderAccountBar(me) {
    const plan = me.plan || {};
    const sub = me.subscription || {};
    const used = sub.scansUsed ?? 0;
    const quota = plan.scansPerPeriod ?? 0;
    const isLifetime = sub.cycle === 'lifetime' || (sub.unlimited && plan.tier >= 3);
    // Quota chip: lifetime → ∞, unlimited → ∞, otherwise used/quota.
    const quotaHtml = sub.unlimited
      ? `<span class="acct-quota">∞ scans</span>`
      : `<span class="acct-quota">${esc(used)}/${esc(quota)} scans</span>`;
    const cycleTag =
      sub.cycle && sub.cycle !== 'lifetime' ? `<span class="acct-cycle">${esc(CYCLE_LABEL[sub.cycle] || sub.cycle)}</span>` : '';
    const priorityTag = plan.prioritySupport ? `<span class="acct-priority">Priority support</span>` : '';
    // Free the GL context from the previous Upgrade button before innerHTML
    // blows the node away (renderAccountBar re-runs on refreshMe).
    if (window.LFLiquid) accountBar.querySelector('.acct-upgrade')?._lfLiquid?.destroy();
    accountBar.hidden = false;
    accountBar.innerHTML =
      `<span class="acct-email" title="${esc(me.email)}">${esc(me.email)}</span>` +
      `<span class="acct-plan${isLifetime ? ' lifetime' : ''}">${esc(isLifetime ? 'Lifetime' : plan.name || 'Free')}</span>` +
      cycleTag +
      quotaHtml +
      priorityTag +
      `<span class="acct-spacer"></span>` +
      (me.role === 'admin' ? `<a class="acct-admin" href="/admin.html">admin</a>` : '') +
      (isLifetime ? '' : `<button type="button" class="acct-upgrade">Upgrade</button>`) +
      `<button type="button" class="acct-logout">Log out</button>`;
    const up = accountBar.querySelector('.acct-upgrade');
    if (up) {
      up.addEventListener('click', () => openBillingModal());
      if (window.LFLiquid) LFLiquid.enhanceButton(up, { variant: 'indigo' });
    }
    accountBar.querySelector('.acct-logout').addEventListener('click', logout);
  }

  async function refreshMe() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.status === 401) {
        location.href = '/login.html';
        return null;
      }
      if (!res.ok) return null;
      const me = await res.json();
      state.me = me;
      state.uid = me.id;
      renderAccountBar(me);
      return me;
    } catch {
      return null;
    }
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* best effort */
    }
    location.href = '/login.html';
  }

  function closeModal() {
    // Free any live shader contexts from plan-buy buttons before discarding.
    if (window.LFLiquid) modalRoot.querySelectorAll('.plan-buy').forEach((b) => b._lfLiquid?.destroy());
    modalRoot.innerHTML = '';
  }

  const AI_LABEL = { none: 'No AI drafting', basic: 'AI drafting (basic)', full: 'AI drafting (full)' };
  const fmtINR = (n) => Number(n).toLocaleString('en-IN');
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const kmLabel = (m) => `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km radius`;
  const pctOff = (mrp, price) => (mrp > 0 && mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0);

  // Which cycle a given plan is billed on for the current toggle position.
  // Lifetime plans always bill on 'lifetime' regardless of the toggle.
  function cycleFor(plan, mode) {
    if (plan.pricing?.lifetime && !plan.pricing.monthly && !plan.pricing.yearly) return 'lifetime';
    return mode;
  }

  function planFeatures(p) {
    const scans =
      p.scansPerPeriod >= 100000
        ? 'Unlimited scans'
        : p.tier === 0
          ? `${p.scansPerPeriod} free scans (one-time)`
          : `${p.scansPerPeriod} scans / period`;
    const hDays = historyDaysFor(p);
    const historyText =
      hDays <= 0
        ? 'No scan history'
        : hDays >= 365
          ? 'Full scan history'
          : hDays === 1
            ? '24 hour history'
            : `${hDays}-day scan history`;
    return [
      { on: true, text: scans },
      { on: true, text: kmLabel(p.maxRadiusMeters) },
      { on: true, text: `${fmtINR(p.maxBusinesses)} businesses / scan` },
      { on: hDays > 0, text: historyText },
      { on: p.psiAllowed, text: p.psiAllowed ? 'PageSpeed audits' : 'No PageSpeed audits' },
      { on: p.aiFeatures !== 'none', text: AI_LABEL[p.aiFeatures] || 'No AI drafting' },
      { on: p.prioritySupport, text: p.prioritySupport ? 'Priority support' : 'Standard support' },
    ];
  }

  function planCardHtml(p, mode, current, billingEnabled) {
    const currentId = current?.plan?.id;
    const currentTier = current?.plan?.tier ?? 0;
    const currentCycle = current?.subscription?.cycle;
    const creditINR = current?.creditINR || 0;
    const isCurrent = p.id === currentId;
    const cycle = cycleFor(p, mode);
    const pricing = p.pricing?.[cycle];
    const isFree = p.tier === 0 || !pricing;
    const ribbon =
      p.badge === 'popular'
        ? `<span class="plan-ribbon popular">MOST POPULAR</span>`
        : p.badge === 'best-value'
          ? `<span class="plan-ribbon best">LIFETIME</span>`
          : '';

    // Price block
    let priceBlock;
    if (isFree) {
      priceBlock = `<div class="plan-price"><span class="plan-amount">Free</span></div>` +
        `<div class="plan-suffix">2 free scans</div>`;
    } else {
      const off = pctOff(pricing.mrp, pricing.price);
      const suffix = cycle === 'lifetime' ? 'one-time' : cycle === 'yearly' ? '/yr' : '/mo';
      priceBlock =
        (pricing.mrp > pricing.price ? `<div class="plan-mrp">₹${fmtINR(pricing.mrp)}</div>` : '') +
        `<div class="plan-price"><span class="plan-amount">₹${fmtINR(pricing.price)}</span>` +
        `<span class="plan-suffix-inline"> ${esc(suffix)}</span>` +
        (off > 0 ? `<span class="plan-off">${off}% OFF</span>` : '') +
        `</div>` +
        (cycle === 'yearly' ? `<div class="plan-suffix">billed yearly · 2 months free</div>` : '');
    }

    const feats = planFeatures(p)
      .map((f) => `<li class="${f.on ? 'yes' : 'no'}">${esc(f.text)}</li>`)
      .join('');

    // CTA. Credit for unused time (from the server) discounts an in-cycle
    // switch/upgrade; payable is what the user actually pays after that credit.
    let action;
    if (isFree) {
      // Free-tier card is unchanged: current → disabled, otherwise a plain badge.
      action = isCurrent ? `<button disabled>Current plan</button>` : `<span class="plan-badge">Free tier</span>`;
    } else if (!billingEnabled) {
      action = `<button disabled title="Payments not configured">Unavailable</button>`;
    } else if (isCurrent && cycle === currentCycle) {
      // On this exact plan+cycle → manage it (no purchase). Lifetime can't be cancelled.
      const sub = current?.subscription;
      const until = sub?.expiresAt
        ? `<div class="plan-active-until">Active until ${esc(fmtDate(sub.expiresAt))} · does not auto-renew</div>`
        : '';
      const cancel = cycle === 'lifetime'
        ? ''
        : `<button class="plan-cancel" data-name="${esc(p.name)}">Cancel plan</button>`;
      action = `<button disabled>Current plan</button>` + until + cancel;
    } else {
      const payable = Math.max(0, pricing.price - creditINR);
      const credited = creditINR > 0 && payable < pricing.price;
      const cycleLabel = cycle === 'yearly' ? 'Yearly' : cycle === 'monthly' ? 'Monthly' : 'Lifetime';
      let label;
      if (isCurrent) {
        // Same plan, different cycle (both paid).
        label = payable === 0
          ? `Switch to ${cycleLabel} — free (credit covers it)`
          : `Switch to ${cycleLabel} — ₹${fmtINR(payable)}`;
      } else if (cycle === 'lifetime') {
        label = `Get Lifetime — ₹${fmtINR(payable)}`;
      } else if (p.tier > currentTier) {
        label = `Upgrade — ₹${fmtINR(payable)}`;
      } else {
        label = `Downgrade — ₹${fmtINR(payable)}`;
      }
      const note = credited
        ? `<div class="plan-credit-note">₹${fmtINR(creditINR)} credit for unused time applied</div>`
        : '';
      action = `<button class="plan-buy" data-id="${esc(p.id)}" data-cycle="${esc(cycle)}" data-tier="${esc(p.tier)}" data-name="${esc(p.name)}">${label}</button>` + note;
    }

    const cls =
      `plan-card glass-specular` +
      (isCurrent ? ' current' : '') +
      (p.badge === 'popular' ? ' popular' : '') +
      (p.badge === 'best-value' ? ' best' : '');
    return (
      `<div class="${cls}">` +
      ribbon +
      `<h3>${esc(p.name)}</h3>` +
      priceBlock +
      `<ul class="plan-feats">${feats}</ul>` +
      action +
      `</div>`
    );
  }

  function renderPlanGrid(grid, data, mode) {
    // The cycle toggle re-renders this grid — free the previous buttons' GL
    // contexts before innerHTML discards them (never leak on toggle).
    if (window.LFLiquid) grid.querySelectorAll('.plan-buy').forEach((b) => b._lfLiquid?.destroy());
    grid.innerHTML = (data.plans || [])
      .map((p) => planCardHtml(p, mode, data.current, data.billingEnabled))
      .join('');
    grid.querySelectorAll('.plan-buy').forEach((btn) => {
      btn.addEventListener('click', () => checkout(btn.dataset.id, btn.dataset.cycle, btn));
      if (window.LFLiquid) {
        const tier = Number(btn.dataset.tier);
        // lifetime → gold, pro (tier 2) → indigo, starter/other → teal
        const variant = btn.dataset.cycle === 'lifetime' || tier >= 3 ? 'gold' : tier === 2 ? 'indigo' : 'teal';
        LFLiquid.enhanceButton(btn, { variant });
      }
    });
    grid.querySelectorAll('.plan-cancel').forEach((btn) => {
      btn.addEventListener('click', () => confirmCancel(btn.dataset.name));
    });
  }

  async function openBillingModal(promptMsg) {
    let cycleMode = 'monthly';
    modalRoot.innerHTML =
      `<div class="modal-backdrop"><div class="modal-card glass glass-specular glass-refract"><span class="refract-edge"></span>` +
      `<div class="modal-head"><h2>Choose your plan</h2><button type="button" class="modal-close" aria-label="close">×</button></div>` +
      (promptMsg
        ? `<p class="modal-sub">${esc(promptMsg)}</p>`
        : `<p class="modal-sub">Raise your scan quota, widen the radius, and unlock PageSpeed audits + AI drafting.</p>`) +
      `<div class="cycle-toggle" id="cycle-toggle" role="tablist">` +
      `<button type="button" class="cycle-opt on" data-mode="monthly" role="tab">Monthly</button>` +
      `<button type="button" class="cycle-opt" data-mode="yearly" role="tab">Yearly <span class="cycle-save">2 months free</span></button>` +
      `</div>` +
      `<div class="plan-grid" id="plan-grid"><span class="hint">Loading plans…</span></div>` +
      `</div></div>`;
    const backdrop = modalRoot.querySelector('.modal-backdrop');
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    modalRoot.querySelector('.modal-close').addEventListener('click', closeModal);

    let data;
    try {
      const res = await fetch('/api/billing/plans');
      if (res.status === 401) { location.href = '/login.html'; return; }
      data = await res.json();
    } catch {
      $('plan-grid').innerHTML = '<span class="hint">Could not load plans.</span>';
      return;
    }
    const grid = $('plan-grid');
    const toggle = $('cycle-toggle');
    renderPlanGrid(grid, data, cycleMode);
    toggle.addEventListener('click', (e) => {
      const opt = e.target.closest('.cycle-opt');
      if (!opt || opt.dataset.mode === cycleMode) return;
      cycleMode = opt.dataset.mode;
      toggle.querySelectorAll('.cycle-opt').forEach((b) => b.classList.toggle('on', b.dataset.mode === cycleMode));
      renderPlanGrid(grid, data, cycleMode);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Swap the body of the (already-open) billing modal card for one of the
  // post-payment states. Guarded — a no-op if the user closed the modal.
  function setCardBody(html) {
    const card = modalRoot.querySelector('.modal-card');
    if (!card) return null;
    // Swapping the card body removes the plan grid — free its shader contexts.
    if (window.LFLiquid) card.querySelectorAll('.plan-buy').forEach((b) => b._lfLiquid?.destroy());
    card.innerHTML = html;
    return card;
  }

  // Render + autoplay one of the inline Lottie animations into `container`.
  // Falls back to a plain glyph if lottie-web or the JSON didn't load.
  function playLottie(container, data) {
    if (!container) return;
    const lot = window.lottie;
    if (typeof lot === 'undefined' || !data) {
      container.textContent = data === window.LOTTIE_FAIL ? '✕' : '✓';
      container.classList.add('lottie-fallback');
      return;
    }
    try {
      lot.loadAnimation({ container, renderer: 'svg', loop: false, autoplay: true, animationData: data });
    } catch {
      container.textContent = data === window.LOTTIE_FAIL ? '✕' : '✓';
      container.classList.add('lottie-fallback');
    }
  }

  function showConfirming() {
    setCardBody(
      `<div class="lottie-result">` +
        `<div class="pay-spinner" role="status" aria-label="Confirming payment"></div>` +
        `<h2 class="lottie-title">Confirming payment…</h2>` +
        `<p class="lottie-sub">Hang tight — we're verifying your payment.</p>` +
        `</div>`,
    );
  }

  // kind: 'success' | 'failure'. opts: { planName, reason }
  function showResult(kind, opts) {
    const success = kind === 'success';
    const heading = success ? 'Payment successful' : 'Payment not completed';
    const sub = success
      ? `You're on the ${esc(opts.planName || 'new')} plan.`
      : esc(opts.reason || 'Your payment did not go through.');
    const actions = success
      ? `<button type="button" class="lottie-btn primary" id="lottie-done">Done</button>`
      : `<button type="button" class="lottie-btn primary" id="lottie-retry">Try again</button>` +
        `<button type="button" class="lottie-btn" id="lottie-close">Close</button>`;
    const card = setCardBody(
      `<div class="lottie-result">` +
        `<div class="lottie-anim ${success ? 'ok' : 'bad'}" id="lottie-anim"></div>` +
        `<h2 class="lottie-title ${success ? 'ok' : 'bad'}">${esc(heading)}</h2>` +
        `<p class="lottie-sub">${sub}</p>` +
        `<div class="lottie-actions">${actions}</div>` +
        `</div>`,
    );
    if (!card) return;
    playLottie($('lottie-anim'), success ? window.LOTTIE_SUCCESS : window.LOTTIE_FAIL);
    if (success) {
      $('lottie-done').addEventListener('click', closeModal);
    } else {
      $('lottie-retry').addEventListener('click', () => openBillingModal());
      $('lottie-close').addEventListener('click', closeModal);
    }
  }

  // In-modal cancel confirmation (no window.confirm). Swaps the plan grid for a
  // heading + policy copy + Keep / Cancel actions, then downgrades to free.
  function confirmCancel(planName) {
    const card = setCardBody(
      `<div class="lottie-result">` +
        `<h2 class="lottie-title">Cancel ${esc(planName || 'your plan')}?</h2>` +
        `<p class="lottie-sub">Your plan deactivates immediately. Remaining time is forfeited and no refund is issued. You'll be moved to the Free plan.</p>` +
        `<div class="lottie-actions">` +
          `<button type="button" class="lottie-btn primary" id="cancel-keep">Keep plan</button>` +
          `<button type="button" class="lottie-btn danger" id="cancel-confirm">Cancel plan</button>` +
        `</div>` +
        `</div>`,
    );
    if (!card) return;
    $('cancel-keep').addEventListener('click', () => openBillingModal());
    $('cancel-confirm').addEventListener('click', async () => {
      const btn = $('cancel-confirm');
      btn.disabled = true; btn.textContent = 'Cancelling…';
      try {
        const res = await fetch('/api/billing/cancel', { method: 'POST' });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || `Cancel failed (HTTP ${res.status}).`);
        await refreshMe();
        // refreshMe must complete first so state.me.plan is fresh before history re-renders
        loadHistory();
        openBillingModal(); // fresh fetch shows Free as the current plan
      } catch (err) {
        alert(err.message || 'Could not cancel your plan.');
        btn.disabled = false; btn.textContent = 'Cancel plan';
      }
    });
  }

  // Poll the server (webhook may lag) until it reports the order paid/activated.
  // Resolves to the paid order object, or null if it never confirms.
  async function pollOrder(orderId, attempts) {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`/api/billing/order/${encodeURIComponent(orderId)}`);
        if (res.ok) {
          const d = await res.json();
          if (d.activated === true || d.status === 'PAID') return d;
        }
      } catch {
        /* transient — keep polling */
      }
      if (i < attempts - 1) await sleep(1500);
    }
    return null;
  }

  async function checkout(planId, cycle, btn) {
    const planName = btn ? btn.dataset.name : '';
    const buyCycle = cycle || (btn ? btn.dataset.cycle : '') || 'monthly';
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }

    let data;
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, cycle: buyCycle }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Checkout failed (HTTP ${res.status}).`);
      // Prorated credit fully covered the plan — the server activated it directly,
      // there is no Cashfree order to pay. Skip the payment modal + polling.
      if (data.activated === true && !data.payment_session_id) {
        await refreshMe();
        // refreshMe must complete first so state.me.plan is fresh before history re-renders
        loadHistory();
        showResult('success', { planName });
        return;
      }
      if (typeof Cashfree !== 'function') throw new Error('Payment SDK failed to load.');
    } catch (err) {
      alert(err.message || 'Could not start checkout.');
      if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
      return;
    }

    // In-page Cashfree modal. v3 `_modal` returns a Promise resolving to
    // { error, redirect, paymentDetails } once the modal closes.
    let cfResult;
    try {
      const cf = Cashfree({ mode: data.mode === 'production' ? 'production' : 'sandbox' });
      cfResult = await cf.checkout({
        paymentSessionId: data.payment_session_id,
        redirectTarget: '_modal',
      });
    } catch (err) {
      cfResult = { error: err };
    }

    // Cashfree modal closed — never trust its result alone; verify server-side.
    showConfirming();
    const cfError = cfResult && cfResult.error;
    const order = await pollOrder(data.order_id, cfError ? 3 : 6);

    if (order && (order.activated === true || order.status === 'PAID')) {
      await refreshMe();
      // refreshMe must complete first so state.me.plan is fresh before history re-renders
      loadHistory();
      showResult('success', { planName });
    } else if (cfError) {
      showResult('failure', {
        reason: 'The payment was cancelled or could not be completed. You have not been charged.',
      });
    } else {
      showResult('failure', {
        reason: "We couldn't confirm your payment yet. If money was debited it will reflect shortly — otherwise try again.",
      });
    }
  }

  // ---------------------------------------------------------------- theme toggle
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
    tileLayer.setUrl(TILE_URL[theme]);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#e8eef4' : '#04070c');
  }
  const themeToggle = $('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
    });
  }

  // ---------------------------------------------------------------- pointer-reactive specular
  // A radial highlight tracks the cursor across primary glass surfaces. Throttled
  // via rAF; fully disabled under prefers-reduced-motion.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  // Pointer-reactive specular that FOLLOWS the cursor with a trailing lerp — the
  // highlight eases toward the pointer (factor 0.18) rather than snapping, so glass
  // feels alive. Global delegation covers dynamically-added surfaces (modal, plan
  // cards). Fully disabled under prefers-reduced-motion.
  function initSpecular() {
    if (reduceMotion.matches) return;
    let target = null; // current lit surface
    let tx = 0, ty = 0; // target highlight pos (px, surface-local)
    let cx = 0, cy = 0; // current (lerped) pos
    let raf = 0;
    const LERP = 0.18;
    const loop = () => {
      cx += (tx - cx) * LERP;
      cy += (ty - cy) * LERP;
      if (target) {
        target.style.setProperty('--mx', `${cx}px`);
        target.style.setProperty('--my', `${cy}px`);
      }
      if (Math.abs(tx - cx) > 0.4 || Math.abs(ty - cy) > 0.4) {
        raf = requestAnimationFrame(loop);
      } else {
        raf = 0;
      }
    };
    document.addEventListener(
      'pointermove',
      (e) => {
        const el = e.target && e.target.closest && e.target.closest('.glass-specular');
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (el !== target) {
          // Re-home the lerp origin on the new surface so it doesn't streak across.
          if (target) target.classList.remove('lit');
          target = el;
          cx = e.clientX - r.left;
          cy = e.clientY - r.top;
          el.classList.add('lit');
        }
        tx = e.clientX - r.left;
        ty = e.clientY - r.top;
        if (!raf) raf = requestAnimationFrame(loop);
      },
      { passive: true }
    );
  }

  // ---------------------------------------------------------------- mobile bottom sheet
  const sheetHandle = $('sheet-handle');
  if (sheetHandle) {
    sheetHandle.addEventListener('click', () => {
      $('rail').classList.toggle('collapsed');
    });
  }

  // ---------------------------------------------------------------- boot / auth gate
  // Liquid-metal shader chrome (progressive enhancement; every call no-ops
  // gracefully without WebGL2). The boot-loader background is torn down once the
  // app is revealed so it never holds a live GL context behind the map.
  let bootBg = null;
  if (window.LFLiquid) {
    const bgHost = $('boot-shader-bg');
    if (bgHost) {
      bootBg = LFLiquid.mountBackground(bgHost, {
        colors: ['#062f2b', '#0c3350', '#141b52', '#04070c'], speed: 0.32,
      });
    }
    LFLiquid.enhanceButton(scanBtn, { variant: 'teal' });
  }

  function revealApp() {
    const loader = $('boot-loader');
    const shell = $('app-shell');
    shell.classList.add('ready');
    shell.setAttribute('aria-hidden', 'false');
    if (loader) {
      loader.classList.add('hide');
      setTimeout(() => {
        loader.hidden = true;
        // Free the boot-loader shader GL context now the loader is gone.
        if (bootBg) { bootBg.destroy(); bootBg = null; }
      }, 650);
    }
    // Map was created behind the (opaque) loader — resize now it's visible.
    requestAnimationFrame(() => map.invalidateSize());
  }

  async function bootAuth() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.status === 401) {
        // Not signed in — go straight to login with NO flash of the app UI.
        location.href = '/login.html';
        return;
      }
      if (res.ok) {
        const me = await res.json();
        state.me = me;
        state.uid = me.id;
        renderAccountBar(me);
      }
    } catch {
      /* network hiccup — still reveal so the user can retry */
    }
    revealApp();
    loadHistory();
  }

  initSpecular();
  bootAuth();
})();
