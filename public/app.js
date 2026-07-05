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

  function scoreChipHtml(score) {
    const s = clamp(Math.round(Number(score) || 0), 0, 100);
    const bg = `hsla(172, 75%, 45%, ${(0.07 + (s / 100) * 0.3).toFixed(3)})`;
    const fg = `hsl(172, 80%, ${Math.round(45 + (s / 100) * 30)}%)`;
    return `<span class="score-chip" style="background:${bg};color:${fg}">${s}</span>`;
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

  // ---------------------------------------------------------------- map
  const FALLBACK_CENTER = { lat: 12.9758, lng: 77.6045 };
  const map = L.map('map').setView([FALLBACK_CENTER.lat, FALLBACK_CENTER.lng], 13);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
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
    scanBtn.textContent = state.running ? 'Scanning…' : 'Scan';
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

  function renderResults(result) {
    state.result = result;
    state.subdir = basename(result.outDir);
    state.sortDesc = true;

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
    outdirNote.innerHTML = `Saved to <code>${esc(result.outDir)}</code>`;
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
  function loadHistory() {
    fetch('/api/leads')
      .then((r) => (r.ok ? r.json() : []))
      .then((scans) => {
        const list = $('history-list');
        const section = $('history-section');
        if (!Array.isArray(scans) || scans.length === 0) {
          section.hidden = true;
          return;
        }
        section.hidden = false;
        list.innerHTML = scans
          .slice(0, 20)
          .map((s) => {
            const count = typeof s.leadCount === 'number' ? `${s.leadCount} leads` : `${s.files.length} files`;
            return `<li><button type="button" class="history-item" data-dir="${esc(s.dir)}">${esc(s.dir)}</button><span class="history-count">${esc(count)}</span></li>`;
          })
          .join('');
      })
      .catch(() => {
        /* history is optional */
      });
  }

  $('history-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.history-item');
    if (!btn) return;
    const dir = btn.dataset.dir;
    fetch(`${leadsPrefix()}/${encodeURIComponent(dir)}/leads.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .then((result) => {
        renderResults(result);
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

  function renderAccountBar(me) {
    const plan = me.plan || {};
    const sub = me.subscription || {};
    const used = sub.scansUsed ?? 0;
    const quota = plan.scansPerPeriod ?? 0;
    accountBar.hidden = false;
    accountBar.innerHTML =
      `<span class="acct-email" title="${esc(me.email)}">${esc(me.email)}</span>` +
      `<span class="acct-plan">${esc(plan.name || 'Free')}</span>` +
      `<span class="acct-quota">${esc(used)}/${esc(quota)} scans</span>` +
      `<span class="acct-spacer"></span>` +
      (me.role === 'admin' ? `<a class="acct-admin" href="/admin.html">admin</a>` : '') +
      `<button type="button" class="acct-upgrade">Upgrade</button>` +
      `<button type="button" class="acct-logout">Log out</button>`;
    accountBar.querySelector('.acct-upgrade').addEventListener('click', () => openBillingModal());
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
    modalRoot.innerHTML = '';
  }

  async function openBillingModal(promptMsg) {
    modalRoot.innerHTML =
      `<div class="modal-backdrop"><div class="modal-card">` +
      `<div class="modal-head"><h2>Plans</h2><button type="button" class="modal-close" aria-label="close">×</button></div>` +
      (promptMsg ? `<p class="modal-sub">${esc(promptMsg)}</p>` : `<p class="modal-sub">Upgrade to raise your scan quota, radius, and unlock PageSpeed audits.</p>`) +
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
    const currentId = data.current?.plan?.id;
    const grid = $('plan-grid');
    grid.innerHTML = (data.plans || [])
      .map((p) => {
        const isCurrent = p.id === currentId;
        const feats = [
          `${p.scansPerPeriod} scans / ${p.periodDays} days`,
          `${(p.maxRadiusMeters / 1000).toFixed(p.maxRadiusMeters % 1000 ? 1 : 0)} km radius`,
          `${p.maxBusinesses} businesses / scan`,
          p.psiAllowed ? 'PageSpeed audits' : 'no PageSpeed',
        ];
        let action;
        if (isCurrent) action = `<button disabled>Current plan</button>`;
        else if (p.priceINR <= 0) action = `<span class="plan-badge">free tier</span>`;
        else if (!data.billingEnabled) action = `<button disabled title="Payments not configured">Unavailable</button>`;
        else action = `<button class="plan-buy" data-id="${esc(p.id)}">Upgrade — ₹${esc(p.priceINR)}</button>`;
        return (
          `<div class="plan-card${isCurrent ? ' current' : ''}">` +
          `<h3>${esc(p.name)}</h3>` +
          `<div class="plan-price">₹${esc(p.priceINR)}<small> / ${esc(p.periodDays)}d</small></div>` +
          `<ul class="plan-feats">${feats.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` +
          action +
          `</div>`
        );
      })
      .join('');

    grid.querySelectorAll('.plan-buy').forEach((btn) => {
      btn.addEventListener('click', () => checkout(btn.dataset.id, btn));
    });
  }

  async function checkout(planId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Checkout failed (HTTP ${res.status}).`);
      if (typeof Cashfree !== 'function') throw new Error('Payment SDK failed to load.');
      const cf = Cashfree({ mode: data.mode === 'production' ? 'production' : 'sandbox' });
      cf.checkout({ paymentSessionId: data.payment_session_id, redirectTarget: '_self' });
    } catch (err) {
      alert(err.message || 'Could not start checkout.');
      if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
    }
  }

  // ---------------------------------------------------------------- boot
  refreshMe();
  loadHistory();
})();
