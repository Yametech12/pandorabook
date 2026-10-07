/**
 * PandoraBook — PWA SPA Logic
 * ============================
 * Vanilla JS single-page application for the Pandora's Box dataset.
 *
 * Features:
 *  1. Hash-based router: #/home, #/agents, #/agent/:code, #/framework,
 *     #/sitemap, #/compare, #/glossary, #/search, #/audit, #/changelog,
 *     #/saved (all routes stable; only the navigation presentation changed).
 *     Task-oriented IA: Discover (Home dashboard), Explore (Agent profiles),
 *     Compare (side-by-side tool), Learn (Framework + Glossary combined entry),
 *     Saved (bookmarks). Search lives in the header; Audit, Site Map and
 *     Changelog live in a "More" overflow menu.
 *  2. Home view: hero, dimensional axes cards, agent overview, quick stats
 *  3. Agents list view: cards for TDI / TJI / NDI with status badges
 *  4. Agent detail view: tabbed interface
 *     (Identity | States | Communication | Escalation | Triggers |
 *      Emotions | Resistance | Maintenance)
 *  5. Compare view: side-by-side agent comparison with selectors
 *  6. Glossary view: searchable, alphabetical
 *  7. Search view: full-text search with keyword highlighting
 *  8. Audit view: audit summary + findings table
 *  9. Offline support: redesigned fallback page with cached-section list + SW cache probe
 * 10. Exploration progress: visited-section tracking via localStorage
 * 11. Share: Web Share API on agent profiles with clipboard fallback + toast
 * 12. "What's New" changelog view and full sitemap
 * 13. Engagement-aware install banner (benefits, dismissal memory)
 * 14. Interactive tools: bookmarks ("Saved" view), scroll progress bar,
 *     per-section copy-link, collapsible long tables, print view,
 *     and text-size settings (S/M/L) — all persisted in localStorage
 *
 * Data contract (data/content.json):
 *  {
 *    meta:        { title, version, auditDate, auditDepth, ... },
 *    preface:     { purpose, scope, methodology, howToUse, disclaimer, ... },
 *    dimensions: [ { dimension, code, poles, function } ],
 *    typeCodes:  [ { code, name, t, d, r, status } ],
 *    agents: [
 *      { code, name, archetype, status,
 *        identity:           [ { parameter, value, weight, manifestation } ],
 *        states:             [ { name, trigger, behaviors[], internal[], exits[] } ],
 *        communication:      [ { channel, optimization, example, avoid } ],
 *        escalationLadder:   [ { level, name, behaviors, timing, resistance } ],
 *        triggers:           [ { trigger, response, intensity, recovery, resolution } ],
 *        emotionalSequence:  [ { order, emotion, condition, threshold, manifestation } ],
 *        resistance:         [ { type, trigger, manifestation, strategy, time } ],
 *        maintenance:        [ { requirement, frequency, indicator, failure } ] }
 *    ],
 *    glossary:    [ { term, definition } ],
 *    comparison:  { pairs: [ { pair, risk, distinguisher } ], notes },
 *    auditSummary:{ totals: { critical, moderate, minor }, domains: [...], fixed: [...], remaining: [...] }
 *  }
 *
 * All fields are optional-defensive: every renderer guards against missing data
 * so a partially-built content.json never crashes the app.
 */

'use strict';

/* ------------------------------------------------------------------ *
 *  Constants
 * ------------------------------------------------------------------ */

var CONTENT_URL   = 'data/content.json';
var LS_PROGRESS   = 'pandorabook.progress.v1';   // progress-tracking store
var LS_COMPARE    = 'pandorabook.compare.v1';     // compare-view selections
var LS_SAVED      = 'pandorabook.saved.v1';       // bookmarked sections [{key,title,hash}]
var LS_FONT       = 'pandorabook.fontsize.v1';    // text size: 's' | 'm' | 'l'
var APP_ROOT_ID   = 'app';
var NAV_ID        = 'nav';

/** Route table: hash prefix -> view renderer. Order matters (longest first). */
var ROUTES = [
  { prefix: '#/agent/',  view: 'agentDetail' },
  { prefix: '#/home',    view: 'home'       },
  { prefix: '#/agents',  view: 'agents'     },
  { prefix: '#/framework', view: 'framework' },
  { prefix: '#/sitemap',  view: 'sitemap'  },
  { prefix: '#/compare', view: 'compare'    },
  { prefix: '#/glossary',view: 'glossary'   },
  { prefix: '#/search',  view: 'search'     },
  { prefix: '#/audit',   view: 'audit'      },
  { prefix: '#/changelog', view: 'changelog' },
  { prefix: '#/saved',    view: 'saved'      },
];

/** Tab definitions for the agent-detail view. */
var AGENT_TABS = [
  { id: 'identity',      label: 'Identity'      },
  { id: 'states',        label: 'States'        },
  { id: 'communication', label: 'Communication' },
  { id: 'escalation',    label: 'Escalation'    },
  { id: 'triggers',      label: 'Triggers'      },
  { id: 'emotions',      label: 'Emotions'      },
  { id: 'resistance',    label: 'Resistance'    },
  { id: 'maintenance',   label: 'Maintenance'   },
];

/* ------------------------------------------------------------------ *
 *  Tiny DOM helpers
 * ------------------------------------------------------------------ */

/** Escape HTML special chars to prevent markup injection from data. */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Get element by id. */
function $(id) { return document.getElementById(id); }

/**
 * Highlight occurrences of each query term inside `text` with <mark>.
 * The text is HTML-escaped first; each term is escaped the same way so
 * queries containing & < > " ' still match their escaped forms.
 * Longest terms match first to avoid nested/partial overlaps.
 */
function highlight(text, query) {
  var safe = esc(text);
  if (!query || !query.trim()) return safe;
  var terms = query.trim().split(/\s+/)
    .map(function (t) { return regexEsc(esc(t)); })
    .filter(function (t) { return t.length > 0; });
  if (!terms.length) return safe;
  // Dedupe + longest first.
  var seen = {};
  terms = terms.filter(function (t) {
    if (seen[t]) return false;
    seen[t] = 1;
    return true;
  }).sort(function (a, b) { return b.length - a.length; });
  try {
    return safe.replace(new RegExp('(' + terms.join('|') + ')', 'gi'), '<mark>$1</mark>');
  } catch (e) {
    return safe;
  }
}

/* ------------------------------------------------------------------ *
 *  State: data, progress, UI
 * ------------------------------------------------------------------ */

var App = {
  data: null,          // parsed content.json (null until loaded)
  dataError: null,     // error message when load fails (offline mode)
  loading: true,
  progress: {},        // { routeKey: true } persisted to localStorage
  compareSel: null,    // { left, right } agent codes for compare view
  activeTab: {},       // { agentCode: tabId } remembers last tab per agent
};

/* ------------------------------------------------------------------ *
 *  Progress tracking (localStorage)
 * ------------------------------------------------------------------ */

function loadProgress() {
  try {
    var raw = localStorage.getItem(LS_PROGRESS);
    App.progress = raw ? JSON.parse(raw) : {};
  } catch (e) {
    App.progress = {};
  }
}

function saveProgress() {
  try {
    localStorage.setItem(LS_PROGRESS, JSON.stringify(App.progress));
  } catch (e) { /* storage full / private mode — non-fatal */ }
}

/** Mark a route as visited. Returns the visit count (for stats). */
function markVisited(routeKey) {
  if (!App.progress[routeKey]) {
    App.progress[routeKey] = { first: Date.now(), visits: 0 };
  }
  App.progress[routeKey].visits += 1;
  App.progress[routeKey].last = Date.now();
  saveProgress();
}

/** How many distinct routes have been visited? */
function visitedCount() {
  return Object.keys(App.progress).length;
}

/* ------------------------------------------------------------------ *
 *  Bookmarks ("Saved") — localStorage
 * ------------------------------------------------------------------ */

function loadSaved() {
  try {
    var raw = localStorage.getItem(LS_SAVED);
    var list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function persistSaved(list) {
  try {
    localStorage.setItem(LS_SAVED, JSON.stringify(list));
  } catch (e) { /* non-fatal */ }
}

function isBookmarked(key) {
  var list = loadSaved();
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === key) return true;
  }
  return false;
}

/** Toggle a bookmark. Returns true if now saved, false if removed. */
function toggleBookmark(key, title, hash) {
  var list = loadSaved();
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === key) {
      list.splice(i, 1);
      persistSaved(list);
      return false;
    }
  }
  list.unshift({ key: key, title: title, hash: hash, savedAt: Date.now() });
  persistSaved(list);
  return true;
}

function removeBookmark(key) {
  var list = loadSaved();
  var next = list.filter(function (b) { return b.key !== key; });
  persistSaved(next);
}

function savedCount() {
  return loadSaved().length;
}

/* ------------------------------------------------------------------ *
 *  Font-size preference — localStorage
 * ------------------------------------------------------------------ */

var FONT_SIZES = ['s', 'm', 'l']; // small / medium / large

function loadFontSize() {
  try {
    var v = localStorage.getItem(LS_FONT);
    return FONT_SIZES.indexOf(v) !== -1 ? v : 'm';
  } catch (e) {
    return 'm';
  }
}

function applyFontSize(size) {
  if (FONT_SIZES.indexOf(size) === -1) size = 'm';
  var html = document.documentElement;
  html.classList.remove('fs-s', 'fs-m', 'fs-l');
  html.classList.add('fs-' + size);
  try { localStorage.setItem(LS_FONT, size); } catch (e) { /* non-fatal */ }
  // Sync the toolbar buttons' pressed state.
  var btns = document.querySelectorAll('.fs-btn');
  for (var i = 0; i < btns.length; i++) {
    var active = btns[i].getAttribute('data-fs') === size;
    btns[i].setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  return size;
}

/* ------------------------------------------------------------------ *
 *  Data loading (with offline fallback)
 * ------------------------------------------------------------------ */

function loadData() {
  App.loading = true;
  renderShell(); // show loading state immediately

  fetch(CONTENT_URL, { cache: 'no-cache' })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (json) {
      App.data = json;
      App.dataError = null;
      App.loading = false;
      onDataReady();
    })
    .catch(function (err) {
      // Offline / missing file: enter graceful degraded mode.
      App.data = null;
      App.dataError = (err && err.message) || 'Unable to load content.';
      App.loading = false;
      onDataReady();
    });
}

function onDataReady() {
  // Restore compare selections if previously saved.
  try {
    var raw = localStorage.getItem(LS_COMPARE);
    if (raw) App.compareSel = JSON.parse(raw);
  } catch (e) { App.compareSel = null; }

  // C1 FIX: Reveal app shell, hide loader
  var loader = document.getElementById('loader');
  var shell = document.getElementById('shell');
  if (loader) loader.hidden = true;
  if (shell) shell.hidden = false;

  route(); // initial render now that data state is known
}

/** Safe decodeURIComponent wrapper (M1 JS audit fix). */
function safeDecode(s) {
  try { return decodeURIComponent(s); }
  catch (e) { return s; }
}

/* ------------------------------------------------------------------ *
 *  Router
 * ------------------------------------------------------------------ */

/** Parse location.hash into { view, param }. */
function parseHash() {
  var hash = location.hash || '#/home';
  for (var i = 0; i < ROUTES.length; i++) {
    if (hash.indexOf(ROUTES[i].prefix) === 0) {
      var param = hash.slice(ROUTES[i].prefix.length);
      // Strip any query string: #/agent/TDI?tab=states
      var qIndex = param.indexOf('?');
      var query = {};
      if (qIndex !== -1) {
        var qs = param.slice(qIndex + 1);
        param = param.slice(0, qIndex);
        qs.split('&').forEach(function (pair) {
          var kv = pair.split('=');
          var k = safeDecode(kv[0]), v = safeDecode(kv[1] || '');
          if (k) query[k] = v;
        });
      }
      return { view: ROUTES[i].prefix, name: ROUTES[i].view, param: param, query: query };
    }
  }
  return { view: '#/home', name: 'home', param: '', query: {} };
}

/** Navigate programmatically. */
function go(hash) {
  if (location.hash === hash) {
    route();
  } else {
    location.hash = hash;
  }
}

/** Signature of the last painted view. The view-enter transition replays
 *  only when this changes — keystroke re-renders (search/glossary) keep
 *  the same signature, so typing never replays the transition. */
var lastViewSig = null;

/** Restart the fade+slide view-enter animation on #app (W0 motion).
 *  Removing + re-adding the class with a forced reflow replays keyframes. */
function playViewEnter(root) {
  if (!root) return;
  root.classList.remove('view-enter');
  void root.offsetWidth; /* reflow so the animation restarts */
  root.classList.add('view-enter');
}

/** Count [data-count] integers up to their final value (W6 motion).
 *  Progressive enhancement: the markup already holds the final value,
 *  so no-JS and reduced-motion users see it instantly. */
function animateCounters() {
  var els = document.querySelectorAll('#app [data-count]');
  if (!els.length) return;
  var reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (var i = 0; i < els.length; i++) {
    (function (el) {
      var target = parseInt(el.getAttribute('data-count'), 10);
      if (!isFinite(target)) return;
      if (reduce) { el.textContent = String(target); return; }
      var dur = 850, t0 = -1;
      function frame(ts) {
        if (t0 < 0) t0 = ts;
        var p = Math.min(1, (ts - t0) / dur);
        var eased = 1 - Math.pow(1 - p, 3); /* easeOutCubic */
        el.textContent = String(Math.round(target * eased));
        if (p < 1) requestAnimationFrame(frame);
        else el.textContent = String(target);
      }
      requestAnimationFrame(frame);
    })(els[i]);
  }
}

/** Emit data-count="N" for finite numeric stats (drives animateCounters).
 *  Non-numeric values ("2 / 3", "—") render plainly with no animation. */
function countAttr(n) {
  return (typeof n === 'number' && isFinite(n)) ? ' data-count="' + n + '"' : '';
}

function route() {
  var r = parseHash();
  markVisited(r.name + (r.param ? '/' + r.param : ''));
  renderNav(r.name);
  var root = $(APP_ROOT_ID);
  if (!root) return;

  // View-transition gating (W0): replay the entrance only on a real
  // view change, not on same-view re-renders (keystrokes, toggles).
  var sig = r.view + '|' + r.param;
  var viewChanged = (sig !== lastViewSig);
  lastViewSig = sig;

  if (App.loading) {
    root.innerHTML = loadingView();
    if (viewChanged) playViewEnter(root);
    return;
  }
  if (App.dataError || !App.data) {
    root.innerHTML = offlineView(App.dataError);
    probeCacheStatus();
    if (viewChanged) playViewEnter(root);
    window.scrollTo(0, 0);
    return;
  }

  switch (r.name) {
    case 'home':       root.innerHTML = utilBar(r) + viewHome(); break;
    case 'agents':     root.innerHTML = utilBar(r) + viewAgents(); break;
    case 'framework':  root.innerHTML = utilBar(r) + viewFramework(); break;
    case 'agentDetail':root.innerHTML = utilBar(r) + viewAgentDetail(r.param, r.query.tab); break;
    case 'sitemap':    root.innerHTML = utilBar(r) + viewSitemap(); break;
    case 'compare':    root.innerHTML = utilBar(r) + viewCompare(); break;
    case 'glossary':   root.innerHTML = utilBar(r) + viewGlossary(r.query.q); break;
    case 'search':     root.innerHTML = utilBar(r) + viewSearch(r.query.q, r.query.filter); break;
    case 'audit':      root.innerHTML = utilBar(r) + viewAudit(); break;
    case 'changelog':  root.innerHTML = utilBar(r) + viewChangelog(); break;
    case 'saved':      root.innerHTML = utilBar(r) + viewSaved(); break;
    default:           root.innerHTML = utilBar(r) + viewHome();
  }

  afterRender(r);
  resetReadProgress();
  if (viewChanged) { playViewEnter(root); animateCounters(); }
  window.scrollTo(0, 0);
}

/**
 * Autocomplete dropdown behavior for the search input:
 * ArrowUp/ArrowDown to move, Enter to pick, Escape to dismiss,
 * hide on blur (delayed so suggestion clicks still register).
 */
function wireSearchSuggest(input) {
  var box = $('search-suggest');
  if (!box) return;

  function items() {
    return box.querySelectorAll('.search-suggest-item');
  }
  function activeIdx() {
    var list = items();
    for (var i = 0; i < list.length; i++) {
      if (list[i].classList.contains('active')) return i;
    }
    return -1;
  }
  function setActive(i) {
    var list = items();
    for (var j = 0; j < list.length; j++) {
      list[j].classList.toggle('active', j === i);
    }
    input.setAttribute('aria-expanded', i >= 0 ? 'true' : 'false');
  }

  input.addEventListener('keydown', function (e) {
    var list = items();
    if (!list.length) return;
    var idx = activeIdx();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(idx >= list.length - 1 ? 0 : idx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(idx <= 0 ? list.length - 1 : idx - 1);
    } else if (e.key === 'Enter' && idx >= 0) {
      e.preventDefault();
      var href = list[idx].getAttribute('href');
      if (href) go(href);
    } else if (e.key === 'Escape') {
      box.style.display = 'none';
      input.setAttribute('aria-expanded', 'false');
    }
  });

  input.addEventListener('blur', function () {
    // Delay so a mousedown on a suggestion still fires its click.
    setTimeout(function () {
      box.style.display = 'none';
      input.setAttribute('aria-expanded', 'false');
    }, 180);
  });

  input.addEventListener('focus', function () {
    if (items().length) {
      box.style.display = '';
      input.setAttribute('aria-expanded', 'true');
    }
  });
}

/** Wire up events that need JS after innerHTML render. */
function afterRender(r) {
  // Glossary + search inputs: re-render on input (debounced).
  var gq = $('glossary-q');
  if (gq) {
    var deb;
    gq.addEventListener('input', function () {
      clearTimeout(deb);
      deb = setTimeout(function () {
        go('#/glossary?q=' + encodeURIComponent(gq.value));
      }, 250);
    });
  }
  var sq = $('search-q');
  if (sq) {
    var deb2;
    sq.addEventListener('input', function () {
      clearTimeout(deb2);
      deb2 = setTimeout(function () {
        // Preserve the active filter chip while typing.
        var chip = document.querySelector('.chip[data-filter].active');
        var flt = chip ? chip.getAttribute('data-filter') : 'all';
        go('#/search?q=' + encodeURIComponent(sq.value) +
           (flt && flt !== 'all' ? '&filter=' + encodeURIComponent(flt) : ''));
      }, 300);
    });
    // Enter key on the button-less input still triggers via hash change.

    // Re-rendering replaces the input on every keystroke: restore focus so
    // typing is never interrupted (caret to end, no scroll jump).
    try {
      sq.focus({ preventScroll: true });
      var v = sq.value;
      sq.value = '';
      sq.value = v;
    } catch (e) { /* older browsers: focus() without options */ try { sq.focus(); } catch (e2) {} }

    wireSearchSuggest(sq);
  }
  // In-page jumps (glossary A–Z bar, related-term links): smooth scroll without
  // touching location.hash (hash changes would hit the router).
  var jumps = document.querySelectorAll('[data-jump]');
  for (var j = 0; j < jumps.length; j++) {
    (function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        var target = document.getElementById(el.getAttribute('data-jump'));
        if (target && target.scrollIntoView) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    })(jumps[j]);
  }
  // Agent explorer toolbar (live client-side filter/sort).
  wireAgentsExplorer();
}

/* ------------------------------------------------------------------ *
 *  App shell: header nav + root container + footer
 * ------------------------------------------------------------------ */

function renderShell() {
  var nav = $(NAV_ID);
  if (nav) renderNav('home');
  var root = $(APP_ROOT_ID);
  if (root && App.loading) root.innerHTML = loadingView();
}

/** Legacy nav-link set (kept for a dynamic #nav container if one is ever
 *  added back). Mirrors the task-oriented primary nav: 5 intent items. */
var NAV_LINKS = [
  { hash: '#/home',     label: 'Home',    icon: '⌂' },
  { hash: '#/agents',   label: 'Agents',  icon: '◈' },
  { hash: '#/compare',  label: 'Compare', icon: '⇄' },
  { hash: '#/framework', label: 'Learn',  icon: '⬡' },
  { hash: '#/saved',    label: 'Saved',   icon: '★' },
];

/**
 * Task-oriented information architecture.
 * Every view maps to one navigation *intent* (not necessarily its own link):
 *  - home            -> Discover (Home)
 *  - agents/agentDetail -> Explore (Agents)
 *  - compare         -> Compare
 *  - framework/glossary -> Learn (Framework + Glossary combined entry;
 *                         the Learn tab links to #/framework)
 *  - saved           -> Saved (bookmarks)
 *  - search          -> header search control
 *  - audit/sitemap/changelog -> "More" overflow menu
 * No routes were removed or renamed — this only changes how the nav
 * presents them, so every existing deep link keeps working.
 */
var VIEW_INTENT = {
  home: 'home', agents: 'agents', agentDetail: 'agents',
  framework: 'learn', glossary: 'learn',
  compare: 'compare', saved: 'saved', search: 'search',
  audit: 'more', sitemap: 'more', changelog: 'more'
};
/** Which views live inside the "More" overflow menu. */
var MORE_VIEW_HASHES = { audit: '#/audit', sitemap: '#/sitemap', changelog: '#/changelog' };

function renderNav(activeName) {
  // Update active states on the static shell navs (top-nav + bottom-nav +
  // header search + More button/menu). Intent-based: e.g. an agent detail
  // page highlights "Agents"; the glossary highlights "Learn".
  var intent = VIEW_INTENT[activeName] || 'home';
  var links = document.querySelectorAll('.top-link, .bottom-link, .header-link');
  for (var i = 0; i < links.length; i++) {
    var linkIntent = links[i].getAttribute('data-intent');
    if (linkIntent === intent) {
      links[i].classList.add('active');
      links[i].setAttribute('aria-current', 'page');
    } else {
      links[i].classList.remove('active');
      links[i].removeAttribute('aria-current');
    }
  }
  // Header search control.
  var searchCtl = document.querySelector('.header-search');
  if (searchCtl) {
    var searchActive = (intent === 'search');
    searchCtl.classList.toggle('active', searchActive);
    if (searchActive) searchCtl.setAttribute('aria-current', 'page');
    else searchCtl.removeAttribute('aria-current');
  }
  // "More" overflow: highlight the button when the active view is inside it,
  // and aria-current the matching menu item.
  var moreBtn = $('moreBtn');
  var moreActive = (intent === 'more');
  if (moreBtn) {
    moreBtn.classList.toggle('active', moreActive);
    if (moreActive) moreBtn.setAttribute('aria-current', 'page');
    else moreBtn.removeAttribute('aria-current');
  }
  var activeMoreHash = MORE_VIEW_HASHES[activeName];
  var moreLinks = document.querySelectorAll('.more-link');
  for (var j = 0; j < moreLinks.length; j++) {
    var match = activeMoreHash && moreLinks[j].getAttribute('data-hash') === activeMoreHash;
    moreLinks[j].classList.toggle('active', !!match);
    if (match) moreLinks[j].setAttribute('aria-current', 'page');
    else moreLinks[j].removeAttribute('aria-current');
  }
  // Legacy: also support a dynamic #nav container if present.
  var nav = $(NAV_ID);
  if (nav && typeof NAV_LINKS !== 'undefined') {
    var activeHashMap = {
      home: '#/home', agents: '#/agents', compare: '#/compare',
      learn: '#/framework', saved: '#/saved', search: '#/search'
    };
    var target = activeHashMap[intent] || '#/home';
    var html = NAV_LINKS.map(function (l) {
      var isActive = (l.hash === target);
      return '<a href="' + l.hash + '" class="nav-link' + (isActive ? ' active' : '') + '">' +
        '<span class="nav-icon">' + l.icon + '</span><span class="nav-label">' + l.label + '</span></a>';
    }).join('');
    nav.innerHTML = '<div class="nav-inner">' + html + '</div>';
  }
}

/** Wire the header "More" overflow menu: toggle, outside-click + Escape close. */
function wireMoreMenu() {
  var btn = $('moreBtn');
  var menu = $('moreMenu');
  if (!btn || !menu) return;
  function setOpen(open) {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    setOpen(menu.hidden);
  });
  // Choosing an item navigates away (hashchange re-renders); just close.
  menu.addEventListener('click', function () { setOpen(false); });
  document.addEventListener('click', function (e) {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      setOpen(false);
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !menu.hidden) {
      setOpen(false);
      btn.focus();
    }
  });
}

function loadingView() {
  // Skeleton shimmer (W4): the data-loading state feels like the app
  // launching, not a dead spinner. role=status keeps it announced.
  var cards = '';
  for (var i = 0; i < 3; i++) {
    cards += '<div class="skeleton-card">' +
      '<div class="skeleton skeleton-line" style="width:34%"></div>' +
      '<div class="skeleton skeleton-line" style="width:92%"></div>' +
      '<div class="skeleton skeleton-line" style="width:78%"></div>' +
      '<div class="skeleton skeleton-line" style="width:64%"></div></div>';
  }
  return '<div class="page-skeleton" role="status" aria-label="Loading PandoraBook content">' +
    '<div class="skeleton skeleton-hero"></div>' +
    '<div class="skeleton-grid">' + cards + '</div>' +
    '<p class="muted small">Loading PandoraBook content…</p>' +
  '</div>';
}

function offlineView(errMsg) {
  var sections = [
    { hash: '#/home', icon: '⌂', label: 'Home' },
    { hash: '#/agents', icon: '◈', label: 'Agents' },
    { hash: '#/compare', icon: '⇄', label: 'Compare' },
    { hash: '#/framework', icon: '⬡', label: 'Learn' },
    { hash: '#/glossary', icon: '≡', label: 'Glossary' },
    { hash: '#/saved', icon: '★', label: 'Saved' },
    { hash: '#/search', icon: '⚲', label: 'Search' },
    { hash: '#/audit', icon: '✓', label: 'Audit' },
    { hash: '#/changelog', icon: '✦', label: "What's New" },
  ];
  var grid = sections.map(function (s) {
    return '<a class="offline-card" href="' + s.hash + '">' +
      '<span class="offline-card-icon" aria-hidden="true">' + s.icon + '</span>' +
      '<span>' + s.label + '</span></a>';
  }).join('');
  return '<div class="offline-wrap">' +
    '<div class="offline-hero"><div class="offline-icon" aria-hidden="true">◈</div>' +
    '<h1>You\'re offline</h1>' +
    '<p class="muted">PandoraBook couldn\'t load <code>data/content.json</code>' +
    (errMsg ? ' <span class="small">(' + esc(errMsg) + ')</span>' : '') + '.</p>' +
    '<button class="btn btn-primary" type="button" onclick="location.reload()">↻ Retry connection</button></div>' +
    '<h2 class="section-title">Available offline</h2>' +
    '<p class="muted small">Once the library has loaded at least once, every section below works without a connection.</p>' +
    '<div class="offline-grid">' + grid + '</div>' +
    '<p class="muted small">Your progress is saved on this device and will resume when the content loads.</p>' +
    '<p class="muted small" id="cache-status" aria-live="polite">Checking cached content…</p>' +
    '</div>';
}

/** Ask the service worker what app assets are cached; show it on the offline page. */
function probeCacheStatus() {
  var el = document.getElementById('cache-status');
  function done(text) { if (el) el.textContent = text; }
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
    done('Tip: install the app once while online and the whole library works offline.');
    return;
  }
  try {
    var mc = new MessageChannel();
    mc.port1.onmessage = function (e) {
      var s = (e.data && e.data.status) || {};
      if (s.data) {
        done('Good news: the full library is cached — reconnect once to unlock every section offline.');
      } else if (s.shell) {
        done('App shell is cached. Reconnect once to download the library for offline use.');
      } else {
        done('Nothing cached yet. Reconnect to download the library.');
      }
    };
    navigator.serviceWorker.controller.postMessage({ type: 'CACHE_STATUS' }, [mc.port2]);
    setTimeout(function () { if (el && /Checking/.test(el.textContent)) done('Cache check timed out — try the retry button.'); }, 4000);
  } catch (err) {
    done('');
  }
}

/* ------------------------------------------------------------------ *
 *  Shared components
 * ------------------------------------------------------------------ */

/** Status badge for agent completeness. */
function statusBadge(status) {
  var s = (status || 'unknown').toLowerCase();
  var cls = 'badge-unknown', label = esc(status || 'Unknown');
  if (s.indexOf('complete') !== -1)      { cls = 'badge-ok';      label = 'Complete'; }
  else if (s.indexOf('partial') !== -1)  { cls = 'badge-warn';    label = 'Partial'; }
  else if (s.indexOf('missing') !== -1 || s.indexOf('not') !== -1) { cls = 'badge-bad'; label = 'Missing'; }
  return '<span class="badge ' + cls + '">' + label + '</span>';
}

/** Generic table renderer. cols: [{key, label}]. rows: array of objects.
 *  opts: { empty, collapse (default true when rows > 5), collapseAt }
 *  Long tables render the first N rows with a "Show all" toggle. */
var tableSeq = 0;
var TABLE_COLLAPSE_AT = 5;
var TABLE_COLLAPSE_AT_MOBILE = 4; // tighter default on phones: less wall-of-text

/** Default rows-before-collapse: fewer on mobile so long tables stay scannable. */
function defaultCollapseAt() {
  try {
    if (window.matchMedia && window.matchMedia('(max-width: 767.98px)').matches) {
      return TABLE_COLLAPSE_AT_MOBILE;
    }
  } catch (e) {}
  return TABLE_COLLAPSE_AT;
}

function tableRowHtml(cols, row, i) {
  return '<tr class="' + (i % 2 ? 'row-alt' : '') + '">' + cols.map(function (c) {
    var v = row[c.key];
    if (Array.isArray(v)) v = v.join('; ');
    return '<td>' + esc(v) + '</td>';
  }).join('') + '</tr>';
}

function table(cols, rows, opts) {
  opts = opts || {};
  if (!rows || !rows.length) {
    return '<p class="muted empty-note">' + esc(opts.empty || 'No data available for this section.') + '</p>';
  }
  var thead = '<thead><tr>' + cols.map(function (c) {
    return '<th scope="col">' + esc(c.label) + '</th>';
  }).join('') + '</tr></thead>';
  var caption = '<caption class="table-caption">' + rows.length +
    (rows.length === 1 ? ' row' : ' rows') + ' documented</caption>';

  var collapseAt = (opts.collapse === false) ? rows.length : (opts.collapseAt || defaultCollapseAt());
  var headRows = rows.slice(0, collapseAt);
  var tailRows = rows.slice(collapseAt);

  var tbody = '<tbody>' + headRows.map(function (row, i) {
    return tableRowHtml(cols, row, i);
  }).join('') + '</tbody>';

  var toggle = '';
  if (tailRows.length) {
    tableSeq++;
    var tid = 'more-rows-' + tableSeq;
    tbody += '<tbody class="more-rows" id="' + tid + '" hidden>' +
      tailRows.map(function (row, j) {
        return tableRowHtml(cols, row, collapseAt + j);
      }).join('') + '</tbody>';
    toggle = '<button type="button" class="btn btn-sm collapse-toggle" ' +
      'data-collapse-target="' + tid + '" data-total="' + rows.length + '" ' +
      'aria-expanded="false" aria-controls="' + tid + '">' +
      'Show all ' + rows.length + ' rows &#x25BE;</button>';
  }

  return '<div class="table-wrap"><table class="data-table">' + caption + thead + tbody +
    '</table></div>' + toggle;
}

/** Section wrapper with anchor id + heading. */
function section(id, title, inner) {
  return '<section class="doc-section" id="sec-' + esc(id) + '">' +
    '<h2 class="section-title">' + esc(title) + '</h2>' + inner + '</section>';
}

/* ------------------------------------------------------------------ *
 *  Interactive features: bookmarks, font size, progress, share, print
 * ------------------------------------------------------------------ */

/** Inject the small stylesheet these interactive features need (kept in JS
 *  so js/app.js stays self-contained). Runs once at boot. */
function injectDynamicStyles() {
  if (document.getElementById('pb-dynamic-styles')) return;
  var css =
    'html.fs-s{font-size:14px}html.fs-m{font-size:16px}html.fs-l{font-size:19px}' +
    '#read-progress{position:fixed;top:0;left:0;right:0;height:3px;z-index:9998;' +
      'opacity:0;transition:opacity .3s;pointer-events:none;background:transparent}' +
    '.read-progress-fill{height:100%;width:0%;' +
      'background:linear-gradient(90deg,var(--color-gold-400,#f5c542),var(--color-gold-300,#ffd97a))}' +
    '.util-bar{display:flex;align-items:center;justify-content:space-between;gap:.6rem;' +
      'flex-wrap:wrap;padding:.45rem .8rem;margin-bottom:1rem;font-size:.85rem;' +
      'background:rgba(255,255,255,.03);border:1px solid var(--color-border-soft,rgba(255,255,255,.09));' +
      'border-radius:10px}' +
    '.util-link{color:var(--color-text-2,#e8e4d8);text-decoration:none;font-weight:600;white-space:nowrap}' +
    '.util-link:hover{color:var(--color-gold-400,#f5c542)}' +
    '.util-count{display:inline-block;min-width:1.4em;text-align:center;padding:0 .3em;' +
      'border-radius:999px;background:var(--color-gold-400,#f5c542);color:#1a1405;font-size:.78em;font-weight:700}' +
    '.fs-group{display:flex;gap:.25rem;align-items:center}' +
    '.fs-btn{min-width:2rem;padding:.25rem .45rem;border:1px solid var(--color-border-soft,rgba(255,255,255,.14));' +
      'background:transparent;color:var(--color-text-2,#e8e4d8);border-radius:8px;cursor:pointer;font-weight:700}' +
    '.fs-btn[aria-pressed="true"]{background:var(--color-gold-400,#f5c542);color:#1a1405;border-color:var(--color-gold-400,#f5c542)}' +
    '.bookmark-btn{background:transparent;border:1px solid var(--color-border-soft,rgba(255,255,255,.14));' +
      'color:var(--color-text-2,#e8e4d8);border-radius:8px;padding:.3rem .55rem;cursor:pointer;font-size:.9rem;line-height:1}' +
    '.bookmark-btn.saved{color:var(--color-gold-400,#f5c542);border-color:var(--color-gold-400,#f5c542)}' +
    '.detail-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.8rem;align-items:center}' +
    '.btn-sm{padding:.35rem .7rem;font-size:.82rem}' +
    '.saved-item{display:flex;align-items:center;justify-content:space-between;gap:.8rem;' +
      'padding:.65rem .9rem;margin-bottom:.5rem;border:1px solid var(--color-border-soft,rgba(255,255,255,.09));' +
      'border-radius:10px;background:rgba(255,255,255,.02)}' +
    '.saved-item a{color:var(--color-text-1,#f5f2e9);font-weight:600;text-decoration:none}' +
    '.saved-item a:hover{color:var(--color-gold-400,#f5c542)}' +
    '.saved-when{display:block;font-size:.78rem;color:var(--color-text-3,#a89f8d);font-weight:400}' +
    '.collapse-toggle{margin:.55rem 0 1.1rem}' +
    'tbody.more-rows[hidden]{display:none}' +
    '@media print{' +
      '.read-progress,.util-bar,.detail-actions,.bookmark-btn,.collapse-toggle,.fs-group{display:none!important}' +
      'tbody.more-rows[hidden]{display:table-row-group}' +
    '}';
  var el = document.createElement('style');
  el.id = 'pb-dynamic-styles';
  el.textContent = css;
  document.head.appendChild(el);
}

/** Small utility toolbar rendered above every view: Saved link + text size. */
function utilBar(r) {
  var fs = loadFontSize();
  function fsBtn(size, glyph, label) {
    var active = fs === size;
    return '<button type="button" class="fs-btn" data-fs="' + size + '" ' +
      'aria-pressed="' + (active ? 'true' : 'false') + '" aria-label="' + label + ' text size">' +
      glyph + '</button>';
  }
  return '<div class="util-bar" role="toolbar" aria-label="Page tools">' +
    '<a class="util-link" href="#/saved">&#9733; Saved <span class="util-count">' +
      savedCount() + '</span></a>' +
    '<div class="fs-group" role="group" aria-label="Text size">' +
      fsBtn('s', 'A&minus;', 'Small') + fsBtn('m', 'A', 'Medium') + fsBtn('l', 'A+', 'Large') +
    '</div>' +
  '</div>';
}

/** Star toggle for bookmarking a section/page. */
function bookmarkBtn(key, title, hash) {
  var saved = isBookmarked(key);
  return '<button type="button" class="bookmark-btn' + (saved ? ' saved' : '') + '" ' +
    'data-bookmark-key="' + esc(key) + '" ' +
    'data-bookmark-title="' + esc(title) + '" ' +
    'data-bookmark-hash="' + esc(hash) + '" ' +
    'aria-pressed="' + (saved ? 'true' : 'false') + '" ' +
    'aria-label="' + (saved ? 'Remove bookmark: ' : 'Bookmark this section: ') + esc(title) + '">' +
    (saved ? '&#9733;' : '&#9734;') + '</button>';
}

/** Copy-link button. Copies the absolute URL of the given hash. */
function copyLinkBtn(hash, label) {
  return '<button type="button" class="btn btn-sm" data-copy-link ' +
    'data-url="' + esc(absoluteHashUrl(hash)) + '" aria-label="Copy link: ' + esc(label || hash) + '">' +
    '&#10697; Copy link</button>';
}

/** Turn a "#/..." hash into an absolute shareable URL. */
function absoluteHashUrl(hash) {
  var base = String(location.href).split('#')[0];
  return base + (hash || location.hash || '#/home');
}

function copyTextToClipboard(text, onOk, onFail) {
  function fallback() {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) onOk(); else onFail();
    } catch (e) { onFail(); }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onOk, fallback);
  } else {
    fallback();
  }
}

/* ---------------- Scroll progress bar ---------------- */

var progressTicking = false;

function ensureProgressBar() {
  if (document.getElementById('read-progress')) return;
  var bar = document.createElement('div');
  bar.id = 'read-progress';
  bar.setAttribute('aria-hidden', 'true');
  bar.innerHTML = '<div class="read-progress-fill" id="read-progress-fill"></div>';
  document.body.appendChild(bar);
}

function updateReadProgress() {
  var doc = document.documentElement;
  var max = doc.scrollHeight - doc.clientHeight;
  var scrolled = doc.scrollTop || document.body.scrollTop || 0;
  var pct = max > 0 ? Math.min(100, Math.max(0, (scrolled / max) * 100)) : 0;
  var fill = document.getElementById('read-progress-fill');
  var bar = document.getElementById('read-progress');
  if (fill) fill.style.width = pct + '%';
  // Only show the bar on long pages (worth tracking).
  if (bar) bar.style.opacity = (max > doc.clientHeight * 0.6) ? '1' : '0';
}

function resetReadProgress() {
  var fill = document.getElementById('read-progress-fill');
  if (fill) fill.style.width = '0%';
  updateReadProgress();
}

function wireProgressScroll() {
  window.addEventListener('scroll', function () {
    if (progressTicking) return;
    progressTicking = true;
    (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () {
      updateReadProgress();
      progressTicking = false;
    });
  }, { passive: true });
}

/* ---------------- Saved view ---------------- */

function viewSaved() {
  var list = loadSaved();
  var items;
  if (!list.length) {
    items = '<p class="muted empty-note">No bookmarks yet. Tap the &#9734; star on any agent ' +
      'profile section to save it here for quick access.</p>';
  } else {
    items = '<div class="saved-list">' + list.map(function (b) {
      var when = '';
      try {
        when = '<span class="saved-when">Saved ' +
          esc(new Date(b.savedAt).toLocaleDateString()) + '</span>';
      } catch (e) {}
      return '<div class="saved-item"><div><a href="' + esc(b.hash) + '">' +
        esc(b.title) + '</a>' + when + '</div>' +
        '<button type="button" class="btn btn-sm" data-unsave="' + esc(b.key) + '">' +
        'Remove</button></div>';
    }).join('') + '</div>';
  }
  return '<header class="page-head"><h1>&#9733; Saved</h1>' +
    '<p class="muted">' + list.length + ' bookmarked section' +
    (list.length === 1 ? '' : 's') + ' &mdash; stored on this device.</p></header>' + items;
}

/** Action row for the agent-detail header: bookmark, copy link, print. */
function detailActions(agent, tab, tabLabel) {
  var key = 'agent:' + agent.code + ':' + tab;
  var title = agent.code + ' \u2014 ' + tabLabel;
  var hash = '#/agent/' + agent.code + '?tab=' + tab;
  return '<div class="detail-actions">' +
    bookmarkBtn(key, title, hash) +
    copyLinkBtn(hash, title) +
    '<button type="button" class="btn btn-sm" data-print>&#128438; Print</button>' +
  '</div>';
}

/** Agent card used on home + agents list. */
function agentCard(agent) {
  var code = esc(agent.code || '?');
  return '<a class="card agent-card" href="#/agent/' + code + '">' +
    '<div class="agent-card-top"><span class="agent-code">' + code + '</span>' +
    statusBadge(agent.status) + '</div>' +
    '<h3>' + esc(agent.name || code) + '</h3>' +
    '<p class="muted">' + esc(agent.archetype || '') + '</p>' +
    '<span class="card-link">Open profile →</span></a>';
}

/* ------------------------------------------------------------------ *
 *  VIEW: Home
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  VIEW: Home (redesigned for fast discovery)
 * ------------------------------------------------------------------ */

/** Global handler for the home-page search bar (inline onsubmit). */
function homeSearchGo(e) {
  if (e && e.preventDefault) e.preventDefault();
  var input = document.getElementById('homeSearchInput');
  var q = input ? input.value : '';
  location.hash = '#/search?q=' + encodeURIComponent(q || '');
  return false;
}

/** Global handler for the app-bar search field (inline onsubmit).
 *  Routes to the existing search view, preserving its query param contract. */
function headerSearchGo(e) {
  if (e && e.preventDefault) e.preventDefault();
  var input = document.getElementById('headerSearchInput');
  var q = input ? input.value : '';
  go('#/search?q=' + encodeURIComponent(q || ''));
  return false;
}

/** Prominent search bar rendered at the top of the home page. */
function homeSearchBar() {
  return '<form class="home-search" role="search" onsubmit="return homeSearchGo(event)">' +
    '<span class="search-icon" aria-hidden="true">&#8981;</span>' +
    '<input class="home-search-input" id="homeSearchInput" type="search" ' +
      'placeholder="Search traits, states, terms&hellip; e.g. &ldquo;core desire&rdquo;, &ldquo;savior mode&rdquo;" ' +
      'aria-label="Search the library" autocomplete="off">' +
    '<button class="btn btn-primary" type="submit">Search</button></form>';
}

/** "Getting Started" checklist card for new users. Done states are driven by
 *  the user's own progress (App.progress) so it doubles as a guide. */
function homeStartHere() {
  return section('start', 'Getting Started', homeStartHereInner());
}

/** Inner markup of the Getting Started card (no section wrapper), so the
 *  dashboard can compose it inside a widget. */
function homeStartHereInner() {
  var steps = [
    { route: 'framework', href: '#/framework', title: 'Learn the framework',
      blurb: 'Three binary axes \u2014 temporal focus, coping architecture, relational worldview \u2014 generate all eight type codes.' },
    { route: 'agents', href: '#/agents', title: 'Meet the three profiles',
      blurb: 'TDI \u00b7 TJI \u00b7 NDI \u2014 complete profiles with states, triggers, and communication playbooks.' },
    { route: 'compare', href: '#/compare', title: 'Compare side by side',
      blurb: 'Confusion risks and key distinctions \u2014 learn to tell the types apart fast.' },
  ];
  var items = steps.map(function (s, i) {
    var done = !!(App.progress && App.progress[s.route]);
    return '<li class="start-step' + (done ? ' done' : '') + '">' +
      '<span class="start-num" aria-hidden="true">' + (done ? '&#10003;' : (i + 1)) + '</span>' +
      '<div><a href="' + s.href + '"><strong>' + esc(s.title) + '</strong></a>' +
      '<p class="muted small">' + esc(s.blurb) + '</p></div></li>';
  }).join('');
  return '<p class="muted">A three-step path that takes you from the framework to a full agent profile.</p>' +
    '<ol class="start-steps checklist snap-x">' + items + '</ol>';
}

/** Visual diagram of the three dimensional axes (poles on a track).
 *  Keeps its original signature for compatibility. */
function homeFrameworkDiagram(dims) {
  return section('dimensions', 'Dimensional Framework', homeFrameworkInner(dims));
}

/** Inner markup of the framework card (no section wrapper), presented as an
 *  interactive widget: the whole diagram links to the full taxonomy. */
function homeFrameworkInner(dims) {
  if (!dims.length) return '';
  var diagram = '<div class="framework-diagram snap-x">' + dims.map(function (dim) {
    var poles = dim.poles || [];
    return '<div class="axis">' +
      '<span class="axis-code">' + esc(dim.code || '') + '</span>' +
      '<div class="axis-track">' +
        '<span class="axis-pole">' + esc(poles[0] || '') + '</span>' +
        '<span class="axis-mid" aria-hidden="true">&#10231;</span>' +
        '<span class="axis-pole">' + esc(poles[1] || '') + '</span>' +
      '</div>' +
      '<p class="axis-name">' + esc(dim.dimension || dim.name || '') + '</p>' +
      '<p class="muted small axis-fn">' + esc(dim.function || dim.description || '') + '</p></div>';
  }).join('') + '</div>';
  return '<a class="framework-widget" href="#/framework" aria-label="Open the full dimensional framework">' +
    diagram +
    '<p class="muted small">Each axis is a binary pole &mdash; combining all three gives the eight type codes. ' +
    'This edition profiles the three Idealist-branch types.</p>' +
    '<span class="framework-cta">Open the interactive taxonomy &rarr;</span></a>';
}

/** Richer agent card for the home page: key traits + state count + theming.
 *  Dashboard presentation: header row, trait list, and a footer with the
 *  user's own exploration count for this profile. */
function homeAgentCard(agent) {
  var code = esc(agent.code || '?');
  var ident = {};
  (agent.identity || []).forEach(function (row) { ident[row.parameter] = row.value; });
  var traits = [
    { label: 'Core desire',     value: ident['Core Desire'] },
    { label: 'Primary defense', value: ident['Primary Defense'] },
    { label: 'Core fear',       value: ident['Core Fear'] },
  ];
  var traitHtml = traits.map(function (t) {
    return t.value
      ? '<div class="trait"><span class="trait-label">' + esc(t.label) + '</span>' +
        '<span class="trait-value">' + esc(String(t.value)) + '</span></div>'
      : '';
  }).join('');
  var stateCount = (agent.states || []).length;
  var visits = (App.progress && App.progress['agentDetail/' + String(agent.code || '')])
    ? App.progress['agentDetail/' + String(agent.code || '')].visits : 0;
  return '<a class="card agent-card home-agent-card dash-agent-card" data-agent="' + String(agent.code || '').toLowerCase() +
    '" href="#/agent/' + code + '">' +
    '<div class="agent-card-top"><span class="agent-code">' + code + '</span>' +
    statusBadge(agent.status) + '</div>' +
    '<h3>' + esc(agent.name || code) + '</h3>' +
    '<p class="muted small">' + esc(agent.archetype || '') + '</p>' +
    '<div class="agent-traits">' + traitHtml + '</div>' +
    '<div class="dash-agent-foot">' +
      '<span class="muted small">' + stateCount + ' behavioral states' +
        (visits > 0 ? ' &middot; explored ' + visits + '&times;' : '') + '</span>' +
      '<span class="card-link">Open profile &rarr;</span>' +
    '</div></a>';
}

/** "Trending Topics" quick-link chips that jump straight into search. */
function homePopularTopics(glossaryCount) {
  return section('topics', 'Trending Topics', homeTopicsInner(glossaryCount));
}

/** Inner markup of the topics card (no section wrapper) for dashboard composition. */
function homeTopicsInner(glossaryCount) {
  var topics = [
    'Core desire', 'Primary defense', 'Savior mode',
    'Social dispersion', 'Emotional invisibility', 'Confusion risks'
  ];
  var chips = topics.map(function (t) {
    return '<a class="topic-chip" href="#/search?q=' + encodeURIComponent(t) + '">' + esc(t) + '</a>';
  }).join('');
  return '<div class="popular-topics snap-x">' + chips + '</div>' +
    '<p class="muted small">Or browse the <a href="#/glossary">full glossary</a> (' + glossaryCount +
    ' terms) and the <a href="#/compare">confusion-risk table</a>.</p>';
}

/* ------------------------------------------------------------------ *
 *  Home dashboard helpers
 * ------------------------------------------------------------------ */

/** Friendly title + hash for a visited route key like "agentDetail/TDI". */
function recentRouteMeta(key) {
  var slash = key.indexOf('/');
  var name = slash === -1 ? key : key.slice(0, slash);
  var param = slash === -1 ? '' : key.slice(slash + 1);
  var titles = {
    home: 'Home', agents: 'Agent Profiles', framework: 'Dimensional Framework',
    sitemap: 'Sitemap', compare: 'Compare Types', glossary: 'Glossary',
    search: 'Search', audit: 'Audit Report', changelog: 'Changelog', saved: 'Saved'
  };
  var hashes = {
    home: '#/home', agents: '#/agents', framework: '#/framework',
    sitemap: '#/sitemap', compare: '#/compare', glossary: '#/glossary',
    search: '#/search', audit: '#/audit', changelog: '#/changelog', saved: '#/saved'
  };
  if (name === 'agentDetail') {
    var agents = (App.data && App.data.agents) || [];
    var found = null;
    for (var i = 0; i < agents.length; i++) {
      if (String(agents[i].code) === param) { found = agents[i]; break; }
    }
    return {
      title: found ? String(found.name || param) : 'Agent ' + param,
      sub: found ? 'Agent profile \u00b7 ' + String(param) : 'Agent profile',
      hash: '#/agent/' + param
    };
  }
  return {
    title: titles[name] || String(name),
    sub: 'Library section',
    hash: hashes[name] || '#/home'
  };
}

/** Visited route keys, newest first (excludes the home page itself).
 *  markVisited() always runs before viewHome, so 'home' is always present. */
function recentKeys() {
  var p = App.progress || {};
  var keys = Object.keys(p).filter(function (k) { return k !== 'home'; });
  keys.sort(function (a, b) {
    return ((p[b] && p[b].last) || 0) - ((p[a] && p[a].last) || 0);
  });
  return keys;
}

/** Quick stats as dashboard metric cards (same data as the old "At a Glance"). */
function homeMetrics(agents, glossaryCount) {
  var stateTotal = agents.reduce(function (n, a) { return n + ((a.states || []).length); }, 0);
  var completeCount = agents.filter(function (a) {
    return String(a.status || '').toLowerCase() === 'complete';
  }).length;
  var items = [
    { n: agents.length, count: agents.length, label: 'Agent profiles', icon: '\u25C8', href: '#/agents' },
    { n: stateTotal, count: stateTotal, label: 'Behavioral states', icon: '\u2B21', href: '#/agents' },
    { n: glossaryCount, count: glossaryCount, label: 'Glossary terms', icon: '\u270E', href: '#/glossary' },
    { n: completeCount + ' / ' + agents.length, count: null, label: 'Complete profiles', icon: '\u2714', href: '#/agents' },
  ];
  var cards = items.map(function (s) {
    return '<a class="metric-card" href="' + s.href + '">' +
      '<span class="metric-icon" aria-hidden="true">' + s.icon + '</span>' +
      '<span class="metric-value"' + countAttr(s.count) + '>' + esc(s.n) + '</span>' +
      '<span class="metric-label">' + esc(s.label) + '</span></a>';
  }).join('');
  return '<div class="metrics-grid">' + cards + '</div>';
}

/** "Continue exploring" — the reader's most recent sections as cards. */
function homeContinueExploring() {
  var keys = recentKeys();
  if (!keys.length) return '';
  var cards = keys.slice(0, 4).map(function (k) {
    var m = recentRouteMeta(k);
    var v = App.progress[k] || {};
    var visits = v.visits || 1;
    return '<a class="card continue-card" href="' + esc(m.hash) + '">' +
      '<p class="continue-sub">' + esc(m.sub) + '</p>' +
      '<h3>' + esc(m.title) + '</h3>' +
      '<p class="muted small">' +
        (visits === 1 ? 'Visited once' : 'Visited ' + visits + ' times') +
        ' \u00b7 pick up where you left off</p>' +
      '<span class="card-link">Continue &rarr;</span></a>';
  }).join('');
  return section('continue', 'Continue Exploring', '<div class="grid continue-grid">' + cards + '</div>');
}

/** "Recently viewed" — compact horizontal strip of the full visit history. */
function homeRecentlyViewed() {
  var keys = recentKeys();
  if (!keys.length) return '';
  var chips = keys.map(function (k) {
    var m = recentRouteMeta(k);
    return '<a class="recent-chip" href="' + esc(m.hash) + '">' + esc(m.title) + '</a>';
  }).join('');
  return section('recent', 'Recently Viewed', '<div class="recent-strip">' + chips + '</div>');
}

/** Library meta widget: version / audit pills + primary actions + progress. */
function homeArchiveWidget(meta) {
  var pills = '<div class="archive-pills">' +
    '<span class="pill">v' + esc(meta.version || '1.0') + '</span>' +
    '<span class="pill">' + esc(meta.auditDepth || '50,000x') + ' audited</span>' +
    (meta.auditDate ? '<span class="pill">' + esc(meta.auditDate) + '</span>' : '') +
    '</div>';
  return '<div class="dash-widget archive-widget">' +
    '<h2 class="dash-widget-title">Library</h2>' +
    '<p class="muted small">' + esc(meta.kicker || 'AI Agent Modeling Dataset') + '</p>' +
    pills +
    '<div class="archive-actions">' +
      '<a class="btn btn-primary" href="#/agents">Explore agents</a>' +
      '<a class="btn" href="#/compare">Compare types</a>' +
    '</div>' +
    '<p class="muted small archive-progress">' + visitedCount() +
    ' sections visited &middot; ' + savedCount() + ' saved</p>' +
    '<p class="muted small"><a href="#/sitemap">Sitemap</a> &middot; ' +
    '<a href="#/changelog">Changelog</a> &middot; <a href="#/audit">Audit report</a></p>' +
    '</div>';
}

/** Dashboard widget wrapper: title + body. */
function dashWidget(title, body, extraClass) {
  return '<div class="dash-widget' + (extraClass ? ' ' + extraClass : '') + '">' +
    '<h2 class="dash-widget-title">' + esc(title) + '</h2>' + body + '</div>';
}

function viewHome() {
  var d = App.data;
  var meta = d.meta || {};
  var dims = d.dimensions || [];
  var agents = d.agents || [];
  var glossaryCount = (d.glossary || []).length;

  // Compact welcome header: no giant book-title hero, search stays prominent.
  var header =
    '<header class="dash-header">' +
      '<p class="dash-kicker">' + esc(meta.kicker || 'AI Agent Modeling Dataset') + '</p>' +
      '<h1 class="dash-title">Explore behavioral models</h1>' +
      '<p class="dash-sub">' + esc(meta.subtitle || 'Advanced distinguishable data set for AI agent modeling.') + '</p>' +
      homeSearchBar() +
    '</header>';

  var agentCards = agents.length
    ? '<div class="grid grid-3 snap-x">' + agents.map(homeAgentCard).join('') + '</div>'
    : '<p class="muted">No agent profiles in this build.</p>';

  var hasHistory = recentKeys().length > 0;

  return '<div class="dash">' +
    header +
    homeMetrics(agents, glossaryCount) +
    (hasHistory ? homeContinueExploring() : '') +
    '<div class="dash-cols-2">' +
      dashWidget('Getting Started', homeStartHereInner()) +
      dashWidget('Dimensional Framework', homeFrameworkInner(dims), 'dash-widget-accent') +
    '</div>' +
    section('agents', 'Featured Agents', agentCards) +
    '<div class="dash-cols-2">' +
      dashWidget('Trending Topics', homeTopicsInner(glossaryCount)) +
      homeArchiveWidget(meta) +
    '</div>' +
    (hasHistory ? homeRecentlyViewed() : '') +
  '</div>';
}

/* ------------------------------------------------------------------ *
 *  VIEW: Agents list
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  VIEW: Agents list ("Agent Explorer")
 * ------------------------------------------------------------------ */

/** Normalize an agent status to one of: complete | partial | other. */
function agentStatusClass(agent) {
  var s = String(agent.status || '').toLowerCase();
  if (s.indexOf('complete') !== -1) return 'complete';
  if (s.indexOf('partial') !== -1) return 'partial';
  return 'other';
}

/** The 8 section datasets every agent profile tracks, in tab order.
 *  Returns [{ id, rows }]. */
function agentSectionRows(agent) {
  return [
    { id: 'identity',      rows: agent.identity },
    { id: 'states',        rows: agent.states },
    { id: 'communication', rows: agent.communication },
    { id: 'escalation',    rows: agent.escalationLadder },
    { id: 'triggers',      rows: agent.triggers },
    { id: 'emotions',      rows: agent.emotionalSequence },
    { id: 'resistance',    rows: agent.resistance },
    { id: 'maintenance',   rows: agent.maintenance },
  ];
}

/** Number of documented (non-empty) sections out of the 8 tabs. */
function agentSectionsDone(agent) {
  return agentSectionRows(agent).filter(function (s) {
    return (s.rows || []).length > 0;
  }).length;
}

/** Total data rows across all 8 sections. */
function agentTotalRows(agent) {
  return agentSectionRows(agent).reduce(function (n, s) {
    return n + ((s.rows || []).length);
  }, 0);
}

/** How many glossary terms reference this agent's code. Cached per code. */
var glossaryRefCache = {};
function glossaryRefCount(code) {
  var c = String(code || '').toUpperCase();
  if (glossaryRefCache[c] != null) return glossaryRefCache[c];
  var terms = (App.data && App.data.glossary) || [];
  var n = 0;
  for (var i = 0; i < terms.length; i++) {
    var t = terms[i];
    var hay = [t.term, t.definition, t.simpleDefinition,
      (t.relatedTerms || []).join(' ')].join(' ').toUpperCase();
    if (hay.indexOf(c) !== -1) n++;
  }
  glossaryRefCache[c] = n;
  return n;
}

/** Rich explorer card for the agents list: type color, quick stats,
 *  and a data-completion bar. data-* attrs power the client-side
 *  filter/sort wiring. */
function explorerAgentCard(agent) {
  var code = String(agent.code || '?');
  var states = (agent.states || []).length;
  var done = agentSectionsDone(agent);
  var total = 8;
  var rows = agentTotalRows(agent);
  var glossaryRefs = glossaryRefCount(code);
  var pct = Math.round((done / total) * 100);
  var searchHay = (code + ' ' + (agent.name || '') + ' ' + (agent.archetype || '')).toLowerCase();
  return '<a class="card explorer-card" data-agent="' + esc(code.toLowerCase()) + '"' +
    ' data-status="' + agentStatusClass(agent) + '"' +
    ' data-states="' + states + '"' +
    ' data-rows="' + rows + '"' +
    ' data-search="' + esc(searchHay) + '"' +
    ' href="#/agent/' + esc(code) + '">' +
    '<div class="explorer-card-top">' +
      '<span class="agent-avatar" aria-hidden="true">' + esc(code.slice(0, 1)) + '</span>' +
      '<span class="agent-code">' + esc(code) + '</span>' +
      statusBadge(agent.status) +
    '</div>' +
    '<h3 class="explorer-name">' + esc(agent.name || code) + '</h3>' +
    '<p class="muted small explorer-archetype">' + esc(agent.archetype || '') + '</p>' +
    '<div class="explorer-stats">' +
      '<div class="explorer-stat"><span class="explorer-stat-num">' + states + '</span>' +
        '<span class="explorer-stat-label">states</span></div>' +
      '<div class="explorer-stat"><span class="explorer-stat-num">' + done + '/' + total + '</span>' +
        '<span class="explorer-stat-label">sections</span></div>' +
      '<div class="explorer-stat"><span class="explorer-stat-num">' + rows + '</span>' +
        '<span class="explorer-stat-label">data rows</span></div>' +
      '<div class="explorer-stat"><span class="explorer-stat-num">' + glossaryRefs + '</span>' +
        '<span class="explorer-stat-label">glossary</span></div>' +
    '</div>' +
    '<div class="completion-bar" role="img" aria-label="Profile ' + pct + ' percent documented">' +
      '<span class="completion-fill" style="width:' + pct + '%"></span></div>' +
    '<span class="card-link">Open profile &rarr;</span></a>';
}

/** Explorer toolbar: live search + status filter chips + sort control. */
function agentsToolbar(agents) {
  var counts = { complete: 0, partial: 0, other: 0 };
  agents.forEach(function (a) {
    var c = agentStatusClass(a);
    if (counts[c] != null) counts[c]++;
  });
  function chip(value, label, n, active) {
    return '<button type="button" class="chip' + (active ? ' active' : '') +
      '" data-status-filter="' + value + '" aria-pressed="' +
      (active ? 'true' : 'false') + '">' + esc(label) +
      ' <span class="chip-count">' + n + '</span></button>';
  }
  return '<div class="explorer-toolbar">' +
    '<div class="explorer-search-wrap"><span class="search-icon" aria-hidden="true">&#8981;</span>' +
      '<input class="explorer-search" id="agents-q" type="search" autocomplete="off" ' +
        'placeholder="Search agents — name, code, archetype&hellip;" aria-label="Search agent profiles"></div>' +
    '<div class="explorer-chips" role="group" aria-label="Filter by status">' +
      chip('all', 'All', agents.length, true) +
      chip('complete', 'Complete', counts.complete, false) +
      chip('partial', 'Partial', counts.partial, false) +
    '</div>' +
    '<label class="explorer-sort">Sort <select id="agents-sort" aria-label="Sort agent profiles">' +
      '<option value="name-asc">Name A&ndash;Z</option>' +
      '<option value="name-desc">Name Z&ndash;A</option>' +
      '<option value="states-desc">Most states</option>' +
      '<option value="rows-desc">Most data</option>' +
    '</select></label>' +
    '<p class="explorer-count muted small" id="agents-count" aria-live="polite"></p>' +
  '</div>';
}

function viewAgents() {
  var agents = App.data.agents || [];
  var cards = agents.length
    ? '<div class="agents-grid snap-x" id="agents-grid">' + agents.map(explorerAgentCard).join('') + '</div>'
    : '<p class="muted">No agent profiles in this build.</p>';
  return '<header class="page-head"><h1>Agent Explorer</h1>' +
    '<p class="muted">Every modeled archetype, searchable and sortable. Select one for the full profile.</p></header>' +
    (agents.length ? agentsToolbar(agents) + cards : cards);
}

/** Wire the explorer toolbar: live client-side search/filter/sort.
 *  No re-render — cards are filtered and reordered in place. */
function wireAgentsExplorer() {
  var grid = $('agents-grid');
  var input = $('agents-q');
  var sortSel = $('agents-sort');
  if (!grid || !input) return;
  var status = 'all';
  var sort = 'name-asc';
  var chips = document.querySelectorAll('[data-status-filter]');

  function cardName(card) {
    var h = card.querySelector('.explorer-name');
    return h ? h.textContent : '';
  }

  function apply() {
    var q = (input.value || '').toLowerCase().trim();
    var cards = [];
    var all = grid.querySelectorAll('.explorer-card');
    for (var i = 0; i < all.length; i++) cards.push(all[i]);
    var visible = 0;
    for (var k = 0; k < cards.length; k++) {
      var card = cards[k];
      var okStatus = status === 'all' || card.getAttribute('data-status') === status;
      var hay = card.getAttribute('data-search') || '';
      var okSearch = !q || hay.indexOf(q) !== -1;
      var show = okStatus && okSearch;
      card.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    var vis = cards.filter(function (c) { return c.style.display !== 'none'; });
    vis.sort(function (a, b) {
      if (sort === 'name-desc') return cardName(b).localeCompare(cardName(a));
      if (sort === 'states-desc') {
        return parseInt(b.getAttribute('data-states'), 10) - parseInt(a.getAttribute('data-states'), 10);
      }
      if (sort === 'rows-desc') {
        return parseInt(b.getAttribute('data-rows'), 10) - parseInt(a.getAttribute('data-rows'), 10);
      }
      return cardName(a).localeCompare(cardName(b));
    });
    for (var j = 0; j < vis.length; j++) grid.appendChild(vis[j]);
    var count = $('agents-count');
    if (count) {
      count.textContent = visible === cards.length
        ? 'Showing all ' + cards.length + ' profiles'
        : 'Showing ' + visible + ' of ' + cards.length + ' profiles';
    }
  }

  input.addEventListener('input', apply);
  if (sortSel) {
    sortSel.addEventListener('change', function () {
      sort = sortSel.value || 'name-asc';
      apply();
    });
  }
  for (var i = 0; i < chips.length; i++) {
    chips[i].addEventListener('click', function () {
      var btn = this;
      status = btn.getAttribute('data-status-filter');
      for (var j = 0; j < chips.length; j++) {
        var on = chips[j] === btn;
        chips[j].classList.toggle('active', on);
        chips[j].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      apply();
    });
  }
  apply();
}

/* ------------------------------------------------------------------ *
 *  VIEW: Framework (dimensional axes + type codes)
 * ------------------------------------------------------------------ */

function viewFramework() {
  var d = App.data;
  var dims = d.dimensions || [];
  var codes = d.typeCodes || [];

  var dimCards = dims.map(function (dim) {
    return '<div class="card"><h3>' + esc(dim.name || dim.dimension) + '</h3>' +
      '<p><span class="badge">' + esc(dim.code) + '</span></p>' +
      '<p class="muted">' + esc(dim.function) + '</p>' +
      (dim.poles ? '<p><strong>Poles:</strong> ' + dim.poles.map(esc).join(' vs. ') + '</p>' : '') +
      '</div>';
  }).join('');

  var codeRows = codes.map(function (tc) {
    return '<tr><td><span class="badge">' + esc(tc.code) + '</span></td>' +
      '<td>' + esc(tc.name || '—') + '</td>' +
      '<td>' + esc(tc.status || '') + '</td></tr>';
  }).join('');

  return '<header class="page-head"><h1>Dimensional Framework</h1>' +
    '<p class="muted">Three binary axes define eight possible agent types. This edition profiles the Idealist branch.</p></header>' +
    '<aside class="card learn-hub" aria-label="Learning hub">' +
    '<p><strong>&#11042; Learning hub:</strong> this is the conceptual core of the library. ' +
    'Pair it with the <a href="#/glossary">glossary</a> for definitions of every term used below, ' +
    'or jump to <a href="#/agents">agent profiles</a> to see the model applied.</p></aside>' +
    '<h2>Core Axes</h2><div class="grid grid-3">' + dimCards + '</div>' +
    '<h2>Type Code Taxonomy</h2><div class="table-wrap"><table class="data-table">' +
    '<thead><tr><th>Code</th><th>Name</th><th>Status</th></tr></thead><tbody>' + codeRows + '</tbody></table></div>';
}

/* ------------------------------------------------------------------ *
 *  VIEW: Agent detail (tabbed)
 * ------------------------------------------------------------------ */

function findAgent(code) {
  var agents = (App.data && App.data.agents) || [];
  for (var i = 0; i < agents.length; i++) {
    if ((agents[i].code || '').toUpperCase() === String(code).toUpperCase()) return agents[i];
  }
  return null;
}

/** Breadcrumb trail: [{ label, hash }]. Last item is the current page. */
function breadcrumbs(items) {
  var crumbs = items.map(function (item, i) {
    var isLast = i === items.length - 1;
    var label = '<span' + (isLast ? ' aria-current="page"' : '') + '>' + esc(item.label) + '</span>';
    return '<li class="crumb">' + (isLast || !item.hash ? label
      : '<a href="' + esc(item.hash) + '">' + esc(item.label) + '</a>') + '</li>';
  }).join('<li class="crumb-sep" aria-hidden="true">›</li>');
  return '<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>' + crumbs + '</ol></nav>';
}

/** "Previous / Next agent" pager for the bottom of agent detail pages. */
function prevNextAgent(agent) {
  var agents = App.data.agents || [];
  var idx = -1;
  for (var i = 0; i < agents.length; i++) {
    if (String(agents[i].code).toUpperCase() === String(agent.code).toUpperCase()) { idx = i; break; }
  }
  if (idx === -1) return '';
  var prev = agents[(idx - 1 + agents.length) % agents.length];
  var next = agents[(idx + 1) % agents.length];
  function link(a, dir) {
    return '<a class="pager-card" data-agent="' + String(a.code || '').toLowerCase() +
      '" href="#/agent/' + esc(a.code) + '">' +
      '<span class="pager-dir">' + (dir === 'prev' ? '← Previous' : 'Next →') + '</span>' +
      '<span class="pager-code">' + esc(a.code) + '</span>' +
      '<span class="pager-name">' + esc(a.name || a.code) + '</span></a>';
  }
  return '<nav class="prev-next-agent" aria-label="More agent profiles">' +
    link(prev, 'prev') + link(next, 'next') + '</nav>';
}

/** Index of a tab id in AGENT_TABS (ES5-safe). */
function tabIndexOf(tabId) {
  for (var i = 0; i < AGENT_TABS.length; i++) {
    if (AGENT_TABS[i].id === tabId) return i;
  }
  return 0;
}

/** "At a Glance" highlight card: archetype, status, summary, key traits,
 *  data coverage. Rendered at the top of the agent profile. */
function glanceCard(agent) {
  var code = (agent.code || '').toLowerCase();
  var exp = agent.expandedContent || {};
  var summary = exp.simpleSummary
    ? '<p class="glance-summary">' + esc(exp.simpleSummary) + '</p>' : '';
  var traits = (agent.identity || []).slice(0, 3).map(function (row) {
    return '<div class="glance-trait">' +
      '<span class="glance-trait-param">' + esc(row.parameter || '') + '</span>' +
      '<span class="glance-trait-value">' + esc(row.value || '') + '</span></div>';
  }).join('');

  var coverage = [
    ['Identity', agent.identity], ['States', agent.states],
    ['Communication', agent.communication], ['Escalation', agent.escalationLadder],
    ['Triggers', agent.triggers], ['Emotions', agent.emotionalSequence],
    ['Resistance', agent.resistance], ['Maintenance', agent.maintenance]
  ].map(function (c) {
    var n = (c[1] || []).length;
    return '<span class="coverage-item' + (n ? '' : ' empty') + '" title="' + n + ' rows documented">' +
      '<span class="coverage-dot"></span>' + esc(c[0]) + ' <strong>' + n + '</strong></span>';
  }).join('');

  return '<section class="glance-card" data-agent="' + esc(code) + '" aria-label="At a glance">' +
    '<h2 class="glance-title">At a Glance</h2>' +
    summary +
    '<div class="glance-row">' +
      '<div class="glance-fact"><span class="glance-label">Archetype</span>' +
        '<span class="glance-value">' + esc(agent.archetype || '—') + '</span></div>' +
      '<div class="glance-fact"><span class="glance-label">Status</span>' +
        statusBadge(agent.status) + '</div>' +
    '</div>' +
    (traits ? '<h3 class="glance-sub">Key traits</h3><div class="glance-traits">' + traits + '</div>' : '') +
    '<h3 class="glance-sub">Data coverage</h3><div class="glance-coverage">' + coverage + '</div>' +
  '</section>';
}

/** Visual tab progress indicator: "Section 3 of 8" + segmented bar. */
function tabProgressHtml(agent, tab) {
  var idx = tabIndexOf(tab);
  var total = AGENT_TABS.length;
  var label = AGENT_TABS[idx].label;
  var segs = '';
  for (var i = 0; i < total; i++) {
    var cls = 'seg' + (i < idx ? ' done' : '') + (i === idx ? ' current' : '');
    segs += '<a href="#/agent/' + esc(agent.code) + '?tab=' + AGENT_TABS[i].id + '"' +
      ' class="' + cls + '" aria-label="Go to ' + esc(AGENT_TABS[i].label) + '"' +
      (i === idx ? ' aria-current="true"' : '') + '></a>';
  }
  return '<div class="tab-progress" role="navigation" aria-label="Profile sections progress">' +
    '<span class="tab-progress-label">Section <strong>' + (idx + 1) + '</strong> of ' + total +
    ' · ' + esc(label) + '</span>' +
    '<div class="seg-bar" aria-hidden="true">' + segs + '</div></div>';
}

/** Data-driven "Key Takeaways" box for each tab. No invented content. */
function renderTabTakeaways(agent, tab) {
  var items = [], title = 'Key takeaways';
  function names(arr, key) {
    return (arr || []).map(function (r) { return r[key]; })
      .filter(function (v) { return v; });
  }
  switch (tab) {
    case 'identity':
      items = names(agent.identity, 'parameter').slice(0, 3);
      title = 'Highest-weight identity parameters';
      break;
    case 'states':
      items = names(agent.states, 'name');
      title = 'Behavioral state sequence';
      break;
    case 'communication':
      items = names(agent.communication, 'channel');
      title = 'Communication channels covered';
      break;
    case 'escalation':
      items = names(agent.escalationLadder, 'name');
      title = 'Escalation levels';
      break;
    case 'triggers':
      items = names(agent.triggers, 'trigger');
      title = 'Documented triggers';
      break;
    case 'emotions':
      items = names(agent.emotionalSequence, 'emotion');
      title = 'Emotional sequence';
      break;
    case 'resistance':
      items = names(agent.resistance, 'type');
      title = 'Resistance patterns';
      break;
    case 'maintenance':
      items = names(agent.maintenance, 'requirement');
      title = 'Maintenance requirements';
      break;
  }
  if (!items.length) return '';
  var seq = (tab === 'states' || tab === 'emotions')
    ? esc(items.join(' → '))
    : '<ul>' + items.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
  return '<aside class="takeaways" aria-label="Key takeaways">' +
    '<h3 class="takeaways-title">✦ ' + esc(title) + '</h3>' +
    '<div class="takeaways-body">' + seq + '</div></aside>';
}

/* ------------------------------------------------------------------ *
 *  Agent detail: app-style profile components
 * ------------------------------------------------------------------ */

/** App-style breadcrumb: home + agents as pills, current agent as accent chip. */
function breadcrumbsApp(items) {
  var crumbs = items.map(function (item, i) {
    var isLast = i === items.length - 1;
    var cls = 'crumb-pill' + (isLast ? ' current' : '');
    return '<li class="crumb-item">' + (isLast || !item.hash
      ? '<span class="' + cls + '" aria-current="page">' + esc(item.label) + '</span>'
      : '<a class="' + cls + '" href="' + esc(item.hash) + '">' + esc(item.label) + '</a>') +
      '</li>';
  }).join('<li class="crumb-sep" aria-hidden="true">›</li>');
  return '<nav class="crumbs-app" aria-label="Breadcrumb"><ol>' + crumbs + '</ol></nav>';
}

/** Profile header card: avatar, name, codename, status badge, quick actions. */
function profileHero(agent, bmKey, bmTitle, bmHash) {
  var code = String(agent.code || '?');
  var pending = agent.pendingSections || [];
  return '<header class="profile-hero" data-agent="' + esc(code.toLowerCase()) + '">' +
    '<div class="profile-hero-main">' +
      '<span class="agent-avatar big" aria-hidden="true">' + esc(code.slice(0, 1)) + '</span>' +
      '<div class="profile-hero-id">' +
        '<div class="profile-code-row"><span class="agent-code big">' + esc(code) + '</span>' +
          statusBadge(agent.status) + '</div>' +
        '<h1 class="profile-name">' + esc(agent.name || code) + '</h1>' +
        '<p class="muted profile-archetype">' + esc(agent.archetype || '') + '</p>' +
        (pending.length
          ? '<p class="pending-note" title="Sections not yet documented">' +
            '&#9203; ' + pending.length + ' of 8 sections pending in this build</p>'
          : '') +
      '</div>' +
    '</div>' +
    '<div class="profile-actions">' +
      '<button class="btn btn-primary btn-sm" type="button" ' +
        'onclick="PandoraBook.shareAgent(\'' + esc(code) + '\')" aria-label="Share this agent profile">' +
        '&#10548; Share</button>' +
      bookmarkBtn(bmKey, bmTitle, bmHash) +
      copyLinkBtn(bmHash, bmTitle) +
      '<a class="btn btn-sm" href="#/compare">&#8646; Compare</a>' +
      '<button type="button" class="btn btn-sm" data-print>&#128438; Print</button>' +
    '</div>' +
  '</header>';
}

/** Key metrics row: tappable tiles with live counts from the data. */
function metricRow(agent) {
  var code = String(agent.code || '?');
  var done = agentSectionsDone(agent);
  var states = (agent.states || []).length;
  var identRows = (agent.identity || []).length;
  var glossaryRefs = glossaryRefCount(code);
  function m(num, label, hash) {
    var inner = '<span class="metric-num">' + num + '</span>' +
      '<span class="metric-label">' + esc(label) + '</span>';
    return hash
      ? '<a class="metric" href="' + esc(hash) + '">' + inner + '</a>'
      : '<div class="metric">' + inner + '</div>';
  }
  return '<div class="metric-row" role="list" aria-label="Profile metrics">' +
    m(states, 'behavioral states', '#/agent/' + encodeURIComponent(code) + '?tab=states') +
    m(done + ' / 8', 'sections documented', null) +
    m(identRows, 'identity parameters', '#/agent/' + encodeURIComponent(code) + '?tab=identity') +
    m(glossaryRefs, 'glossary terms', '#/glossary?q=' + encodeURIComponent(code)) +
  '</div>';
}

var TAB_ICONS = {
  identity: '&#9673;', communication: '&#9993;', escalation: '&#9650;',
  triggers: '&#9889;', emotions: '&#10084;', resistance: '&#128737;',
  maintenance: '&#128736;', states: '&#9881;',
};

var TAB_DESCRIPTIONS = {
  identity: 'Core parameters — what defines this type and how it shows up in behavior.',
  states: 'The behavioral state machine, from baseline through escalation.',
  communication: 'Channel-by-channel playbook: what works, what to say, what to avoid.',
  escalation: 'How intensity ramps level by level, and the resistance signs to watch for.',
  triggers: 'Documented trigger → response → recovery sequences.',
  emotions: 'The emotional trigger sequence, in order.',
  resistance: 'How this type pushes back — and the strategy that resolves it.',
  maintenance: 'Ongoing requirements for keeping the dynamic healthy.',
};

/** Rows documented in one tab's dataset (drives the panel count chip). */
function tabRowCount(agent, tab) {
  var map = {
    identity: agent.identity, states: agent.states,
    communication: agent.communication, escalation: agent.escalationLadder,
    triggers: agent.triggers, emotions: agent.emotionalSequence,
    resistance: agent.resistance, maintenance: agent.maintenance,
  };
  return (map[tab] || []).length;
}

/** One tab as a modern panel: numbered header, description, count chip,
 *  takeaways first (progressive disclosure), then the full content.
 *  Long tables already collapse behind a "Show all" toggle. */
function tabPanel(agent, tab, tabLabel, body, takeaways) {
  var idx = tabIndexOf(tab) + 1;
  var rows = tabRowCount(agent, tab);
  var icon = TAB_ICONS[tab] || '&#9642;';
  var desc = TAB_DESCRIPTIONS[tab] || '';
  return '<section class="tab-panel" aria-labelledby="tab-panel-title">' +
    '<div class="tab-panel-head">' +
      '<span class="tab-panel-num" aria-hidden="true">' + idx + '</span>' +
      '<div class="tab-panel-head-text">' +
        '<h2 id="tab-panel-title" class="tab-panel-title">' +
          '<span class="tab-icon" aria-hidden="true">' + icon + '</span> ' + esc(tabLabel) + '</h2>' +
        (desc ? '<p class="muted small tab-panel-desc">' + desc + '</p>' : '') +
      '</div>' +
      (rows
        ? '<span class="pill tab-panel-count">' + rows + ' documented</span>'
        : '<span class="pill tab-panel-count pending">pending</span>') +
    '</div>' +
    takeaways +
    '<div class="tab-panel-body">' + body + '</div>' +
  '</section>';
}

/** Related agents: open the other profiles or jump to a preselected
 *  side-by-side comparison (data-compare-pair is handled by wireInteractive). */
function relatedAgents(agent) {
  var agents = App.data.agents || [];
  var others = agents.filter(function (a) { return a.code !== agent.code; });
  if (!others.length) return '';
  var code = String(agent.code || '?');
  var cards = others.map(function (o) {
    var ocode = String(o.code || '?');
    return '<div class="rel-card" data-agent="' + esc(ocode.toLowerCase()) + '">' +
      '<div class="rel-card-top"><span class="agent-avatar sm" aria-hidden="true">' +
        esc(ocode.slice(0, 1)) + '</span>' +
        '<span class="agent-code">' + esc(ocode) + '</span>' + statusBadge(o.status) + '</div>' +
      '<p class="rel-name">' + esc(o.name || ocode) + '</p>' +
      '<div class="rel-actions">' +
        '<a class="btn btn-sm" href="#/agent/' + esc(ocode) + '">Open</a>' +
        '<button type="button" class="btn btn-sm" data-compare-pair="' +
          esc(code + '|' + ocode) + '">&#8646; Compare ' + esc(code) + ' vs ' + esc(ocode) + '</button>' +
      '</div></div>';
  }).join('');
  return '<section class="related-agents" aria-label="Related agent profiles">' +
    '<h2 class="section-title">Compare with</h2>' +
    '<p class="muted small">Open another profile — or jump straight into a side-by-side comparison.</p>' +
    '<div class="rel-grid">' + cards + '</div></section>';
}

function viewAgentDetail(code, tabFromQuery) {
  var agent = findAgent(code);
  if (!agent) {
    return '<header class="page-head"><h1>Agent not found</h1>' +
      '<p class="muted">No profile for code "' + esc(code) + '".</p>' +
      '<a class="btn" href="#/agents">Back to agents</a></header>';
  }

  var tab = tabFromQuery || App.activeTab[agent.code] || 'identity';
  if (!AGENT_TABS.some(function (t) { return t.id === tab; })) tab = 'identity';
  App.activeTab[agent.code] = tab;

  var agentCode = (agent.code || '').toLowerCase();
  var tabsHtml = '<div class="tabs" role="tablist" aria-label="Agent profile sections">' +
    AGENT_TABS.map(function (t) {
      var active = t.id === tab;
      return '<a role="tab" aria-selected="' + (active ? 'true' : 'false') + '"' +
        ' class="tab' + (active ? ' active' : '') + '" href="#/agent/' + esc(agent.code) +
        '?tab=' + t.id + '">' + esc(t.label) + '</a>';
    }).join('') + '</div>';

  var body = renderAgentTab(agent, tab);
  var takeaways = renderTabTakeaways(agent, tab);
  var tabLabel = (function () {
    for (var i = 0; i < AGENT_TABS.length; i++) {
      if (AGENT_TABS[i].id === tab) return AGENT_TABS[i].label;
    }
    return tab;
  })();
  var bmKey = 'agent:' + agent.code + ':' + tab;
  var bmTitle = agent.code + ' \u2014 ' + tabLabel;
  var bmHash = '#/agent/' + agent.code + '?tab=' + tab;

  return breadcrumbsApp([
      { label: '\u2302 Home', hash: '#/home' },
      { label: 'Agents', hash: '#/agents' },
      { label: agent.code + ' — ' + (agent.name || '') },
    ]) +
    '<div class="agent-detail" data-agent="' + esc(agentCode) + '">' +
    profileHero(agent, bmKey, bmTitle, bmHash) +
    glanceCard(agent) +
    metricRow(agent) +
    '<div class="tabs-wrap">' + tabProgressHtml(agent, tab) + tabsHtml + '</div>' +
    '<div class="tab-body">' + tabPanel(agent, tab, tabLabel, body, takeaways) + '</div>' +
    relatedAgents(agent) +
    prevNextAgent(agent) +
  '</div>';
}

function renderAgentTab(agent, tab) {
  switch (tab) {
    case 'identity':
      return table(
        [{ key: 'parameter', label: 'Parameter' },
         { key: 'value', label: 'Value' },
         { key: 'weight', label: 'Weight' },
         { key: 'manifestation', label: 'Behavioral Manifestation' }],
        agent.identity, { empty: 'Identity matrix not documented for this agent.' });

    case 'states':
      return renderStates(agent.states, agent.code);

    case 'communication':
      return table(
        [{ key: 'channel', label: 'Channel' },
         { key: 'optimization', label: 'Optimization' },
         { key: 'example', label: 'Example' },
         { key: 'avoid', label: 'Avoid' }],
        agent.communication, { empty: 'Communication protocol not documented for this agent.' });

    case 'escalation':
      return table(
        [{ key: 'level', label: 'Level' },
         { key: 'name', label: 'Name' },
         { key: 'behaviors', label: 'Behaviors' },
         { key: 'timing', label: 'Timing' },
         { key: 'resistance', label: 'Resistance Indicators' }],
        agent.escalationLadder, { empty: 'Escalation ladder not documented for this agent.' });

    case 'triggers':
      return table(
        [{ key: 'trigger', label: 'Trigger' },
         { key: 'response', label: 'Response' },
         { key: 'intensity', label: 'Intensity' },
         { key: 'recovery', label: 'Recovery' },
         { key: 'resolution', label: 'Resolution' }],
        agent.triggers, { empty: 'Trigger-response database not documented for this agent.' });

    case 'emotions':
      return table(
        [{ key: 'order', label: '#' },
         { key: 'emotion', label: 'Emotion' },
         { key: 'condition', label: 'Trigger Condition' },
         { key: 'threshold', label: 'Threshold' },
         { key: 'manifestation', label: 'Manifestation' }],
        agent.emotionalSequence, { empty: 'Emotional trigger sequence not documented for this agent.' });

    case 'resistance':
      return table(
        [{ key: 'type', label: 'Resistance Type' },
         { key: 'trigger', label: 'Trigger' },
         { key: 'manifestation', label: 'Manifestation' },
         { key: 'strategy', label: 'Resolution Strategy' },
         { key: 'time', label: 'Time to Resolve' }],
        agent.resistance, { empty: 'Resistance patterns not documented for this agent.' });

    case 'maintenance':
      return table(
        [{ key: 'requirement', label: 'Requirement' },
         { key: 'frequency', label: 'Frequency' },
         { key: 'indicator', label: 'Behavioral Indicator' },
         { key: 'failure', label: 'Failure Mode' }],
        agent.maintenance, { empty: 'Maintenance protocol not documented for this agent.' });

    default:
      return '<p class="muted">Unknown tab.</p>';
  }
}

/** Render behavioral state machine as cards (not a flat table — richer).
 *  Includes quick-jump chips (buttons, hash-safe) to each state card. */
function renderStates(states, agentCode) {
  if (!states || !states.length) {
    return '<p class="muted empty-note">State machine not documented for this agent.</p>';
  }
  var code = (agentCode || 'x').toLowerCase();
  var jump = '<nav class="jump-nav" aria-label="Jump to a state">' +
    '<span class="jump-label">Jump to:</span>' +
    states.map(function (s, i) {
      return '<button type="button" class="jump-chip" data-jump="state-' + code + '-' + i + '">' +
        esc(s.name || ('State ' + (i + 1))) + '</button>';
    }).join('') + '</nav>';
  return jump + '<div class="states-flow">' + states.map(function (s, i) {
    var behaviors = (s.behaviors || []).map(function (b) {
      return '<li>' + esc(b) + '</li>';
    }).join('');
    var internal = (s.internal || []).map(function (t) {
      return '<li class="thought">' + esc(t) + '</li>';
    }).join('');
    var exits = (s.exits || []).map(function (e) {
      return '<span class="exit-chip">' + esc(e) + '</span>';
    }).join('');
    return '<article class="state-card" id="state-' + code + '-' + i + '">' +
      '<div class="state-num">' + (i + 1) + '</div>' +
      '<h3 class="state-name">' + esc(s.name || ('State ' + (i + 1))) + '</h3>' +
      (s.trigger ? '<p class="state-trigger"><strong>Trigger:</strong> ' + esc(s.trigger) + '</p>' : '') +
      (behaviors ? '<h4>Behaviors</h4><ul>' + behaviors + '</ul>' : '') +
      (internal ? '<h4>Internal process</h4><ul>' + internal + '</ul>' : '') +
      (exits ? '<h4>Exits to</h4><div class="exit-row">' + exits + '</div>' : '') +
      '</article>';
  }).join('') + '</div>';
}

/* ------------------------------------------------------------------ *
 *  VIEW: Compare (side-by-side)
 * ------------------------------------------------------------------ */

function viewCompare() {
  var agents = App.data.agents || [];
  if (agents.length < 2) {
    return '<header class="page-head"><h1>Compare</h1>' +
      '<p class="muted">At least two agent profiles are needed for comparison.</p></header>';
  }

  // Default selection: first two agents; restore saved selection if valid.
  var codes = agents.map(function (a) { return a.code; });
  var sel = App.compareSel;
  if (!sel || codes.indexOf(sel.left) === -1 || codes.indexOf(sel.right) === -1) {
    sel = { left: codes[0], right: codes[1] };
  }
  if (sel.left === sel.right && codes.length > 1) {
    sel.right = codes[(codes.indexOf(sel.left) + 1) % codes.length];
  }
  App.compareSel = sel;
  try { localStorage.setItem(LS_COMPARE, JSON.stringify(sel)); } catch (e) {}

  var left = findAgent(sel.left), right = findAgent(sel.right);

  /* ---------- user-friendly selectors with descriptions ---------- */
  function selector(which, current) {
    var cur = findAgent(current);
    var desc = cur
      ? '<p class="muted small cmp-current">' + esc(cur.code) + ' · ' + esc(cur.name || '') +
        ' — ' + esc(shortArchetype(cur.archetype)) + '</p>'
      : '';
    return '<div class="compare-select-wrap"><label class="compare-select"><span>' +
      (which === 'left' ? 'Agent A' : 'Agent B') + '</span>' +
      '<select id="cmp-' + which + '">' +
      agents.map(function (a) {
        var selected = a.code === current ? ' selected' : '';
        return '<option value="' + esc(a.code) + '"' + selected + '>' +
          esc(a.code) + ' — ' + esc(a.name || '') + ' · ' + esc(shortArchetype(a.archetype)) + '</option>';
      }).join('') + '</select></label>' + desc + '</div>';
  }

  /* ---------- at-a-glance cards ---------- */
  var glanceHtml = '<div class="cmp-glance snap-x">' +
    cmpGlanceCard(left) + cmpGlanceCard(right) + '</div>';

  /* ---------- comparison rows + diff stats ---------- */
  var rows = compareRows(left, right);
  var diffRows = rows.filter(function (r) { return r.a !== r.b; });

  var banner = '<div class="diff-banner"><span class="pill">' + diffRows.length +
    ' of ' + rows.length + ' dimensions differ</span>' +
    '<span class="muted small">Rows marked ≠ highlight exactly where ' +
    esc(left.code) + ' and ' + esc(right.code) + ' diverge.</span></div>';

  var tableHtml = '<section class="doc-section">' +
    '<div class="compare-table-head"><h2 class="section-title">Full comparison</h2>' +
    '<label class="diff-toggle"><input type="checkbox" id="diff-toggle" /> ' +
    'Show differences only (' + diffRows.length + ')</label></div>' +
    '<div class="table-wrap"><table class="data-table compare-table" id="compare-table"><thead><tr>' +
    '<th>Dimension</th><th>' + esc(left.code) + '</th><th>' + esc(right.code) + '</th>' +
    '</tr></thead><tbody>' +
    rows.map(function (r, i) {
      var isDiff = r.a !== r.b;
      var cls = (isDiff ? 'diff-row' : 'same-row') + (i % 2 ? ' row-alt' : '');
      var mark = isDiff ? ' <span class="diff-mark" title="These values differ">≠</span>' : '';
      var cellCls = isDiff ? ' class="diff"' : '';
      return '<tr class="' + cls + '"><td><strong>' + esc(r.label) + '</strong>' + mark +
        '</td><td' + cellCls + '>' + esc(r.a) + '</td><td' + cellCls + '>' + esc(r.b) + '</td></tr>';
    }).join('') + '</tbody></table></div></section>';

  /* ---------- key differences summary ---------- */
  var keyDiffs = cmpKeyDifferences(diffRows, left, right);

  /* ---------- which-one guide ---------- */
  var whichOne = cmpWhichOne(left, right);

  /* ---------- confusion risks (existing data sections) ---------- */
  var confusion = '';
  var comp = App.data.comparison || {};
  var confRisks = comp.confusionRisks || comp.pairs || [];
  if (confRisks.length) {
    confusion = '<section class="doc-section"><h2 class="section-title">Confusion risks</h2>' + table(
      [{ key: 'pair', label: 'Pair' },
       { key: 'risk', label: 'Risk' },
       { key: 'distinguisher', label: 'Distinguisher' }],
      confRisks) + '</section>';
  }
  // Key distinctions (orphaned data fix)
  var distinctions = comp.distinctions || [];
  if (distinctions.length) {
    confusion += '<section class="doc-section"><h2 class="section-title">Key distinctions</h2>' + table(
      [{ key: 'pair', label: 'Pair' },
       { key: 'text', label: 'Distinction' }],
      distinctions) + '</section>';
  }

  // Wire selectors + diff toggle after render (delegated via afterRender hook below).
  setTimeout(wireCompareSelectors, 0);

  return '<header class="page-head"><h1>Compare Agents</h1>' +
      '<p class="muted">Pick any two types. The glance cards summarize each one — then explore exactly what sets them apart.</p></header>' +
    '<div class="compare-bar">' + selector('left', sel.left) + selector('right', sel.right) + '</div>' +
    glanceHtml + banner + keyDiffs + whichOne + tableHtml + confusion;
}

/** Short archetype for compact display: strip the " — ..." elaboration. */
function shortArchetype(s) {
  s = s || '';
  var i = s.indexOf(' — ');
  return i === -1 ? s : s.slice(0, i);
}

/** One identity value by parameter name (defensive against partial data). */
function identValue(agent, paramName) {
  var rows = (agent && agent.identity) || [];
  for (var i = 0; i < rows.length; i++) {
    if ((rows[i].parameter || '').toLowerCase() === String(paramName).toLowerCase()) {
      return rows[i].value || '—';
    }
  }
  return '—';
}

/** At-a-glance card for one agent in the compare view (agent-accent themed). */
function cmpGlanceCard(agent) {
  if (!agent) return '';
  var code = (agent.code || '?').toLowerCase();
  var fields = [
    ['Archetype', shortArchetype(agent.archetype)],
    ['Core fear', identValue(agent, 'Core Fear')],
    ['Core desire', identValue(agent, 'Core Desire')],
    ['Primary defense', identValue(agent, 'Primary Defense')],
    ['Attachment style', identValue(agent, 'Attachment Style')],
  ];
  var rowsHtml = fields.map(function (f) {
    return '<div class="glance-row"><span class="glance-label">' + esc(f[0]) +
      '</span><span class="glance-value">' + esc(f[1]) + '</span></div>';
  }).join('');
  return '<div class="glance-card" data-agent="' + esc(code) + '">' +
    '<div class="glance-head"><span class="agent-code">' + esc(agent.code || '?') + '</span>' +
    statusBadge(agent.status) + '</div>' +
    '<h3>' + esc(agent.name || agent.code || '') + '</h3>' +
    '<p class="muted small">' + esc(agent.archetype || '') + '</p>' +
    rowsHtml +
    '<a class="card-link" href="#/agent/' + esc(agent.code || '') + '">Full profile →</a></div>';
}

/** Auto-generated "Key differences" summary from the differing compare rows. */
function cmpKeyDifferences(diffRows, left, right) {
  var head = '<section class="doc-section"><h2 class="section-title">Key differences ' +
    '<span class="pill">' + diffRows.length + '</span></h2>';
  if (!diffRows.length) {
    return head + '<p class="muted">These two profiles match on every compared dimension.</p></section>';
  }
  var items = diffRows.map(function (r) {
    return '<div class="keydiff-item">' +
      '<p class="keydiff-label">' + esc(r.label) + '</p>' +
      '<div class="keydiff-cols">' +
        '<div class="keydiff-col" data-agent="' + esc((left.code || '').toLowerCase()) + '">' +
          '<span class="agent-code">' + esc(left.code) + '</span><p>' + esc(r.a) + '</p></div>' +
        '<div class="keydiff-vs" aria-hidden="true">≠</div>' +
        '<div class="keydiff-col" data-agent="' + esc((right.code || '').toLowerCase()) + '">' +
          '<span class="agent-code">' + esc(right.code) + '</span><p>' + esc(r.b) + '</p></div>' +
      '</div></div>';
  }).join('');
  return head + '<p class="muted">Where ' + esc(left.code) + ' and ' + esc(right.code) +
    ' diverge — side by side.</p><div class="keydiff-list">' + items + '</div></section>';
}

/** Curated "Which one...?" guide answers for every known pair (from identity data). */
var WHICH_ONE_GUIDE = {
  'TDI|TJI': [
    { q: 'Which one is more socially outgoing?', a: 'TJI', why: 'The Party Girl is the social center — high energy and flirtatious.' },
    { q: 'Which one hides their true feelings?', a: 'TDI', why: 'Her primary defense is emotional invisibility — 90% hidden beneath the surface.' },
    { q: 'Which one chases novelty and excitement?', a: 'TJI', why: 'She fears missing out on excitement and seeks novelty.' },
    { q: 'Which one secretly wants to be swept away?', a: 'TDI', why: 'Her core desire is to be swept away by a dominant romantic.' },
  ],
  'NDI|TDI': [
    { q: 'Which one is more idealistic about love?', a: 'NDI', why: 'Her primary defense is emotional idealism — the old-fashioned dreamer.' },
    { q: 'Which one guards against vulnerability?', a: 'TDI', why: 'She fears abandonment after vulnerability, so she hides instead of hoping.' },
    { q: 'Which one wants to be saved by love?', a: 'NDI', why: 'Her core desire is to save and be saved by love.' },
    { q: 'Which one invests more cautiously?', a: 'NDI', why: 'She practices cautious investment — her core fear is being used and abandoned.' },
  ],
  'NDI|TJI': [
    { q: 'Which one craves excitement?', a: 'TJI', why: 'She fears missing out on excitement and disperses herself socially.' },
    { q: 'Which one dreams of a perfect romance?', a: 'NDI', why: 'She daydreams of the perfect man — the old-fashioned dreamer.' },
    { q: 'Which one keeps emotional distance?', a: 'TJI', why: 'Dismissive-avoidant: she craves genuine connection yet deflects it.' },
    { q: 'Which one fears being used?', a: 'NDI', why: 'Her core fear is being used and abandoned.' },
  ],
};

/** "Which one...?" helper section for the current pair. */
function cmpWhichOne(left, right) {
  if (!left || !right) return '';
  var key = [left.code, right.code].sort().join('|');
  var items = WHICH_ONE_GUIDE[key];
  if (!items || !items.length) return '';
  var html = items.map(function (it) {
    var ans = it.a === left.code ? left : right;
    return '<div class="whichone-item">' +
      '<p class="whichone-q">' + esc(it.q) + '</p>' +
      '<p class="whichone-a" data-agent="' + esc((ans.code || '').toLowerCase()) + '">' +
      '<span class="agent-code">' + esc(ans.code) + '</span> — ' + esc(it.why) + '</p></div>';
  }).join('');
  return '<section class="doc-section"><h2 class="section-title">Which one…?</h2>' +
    '<p class="muted">A quick guide to telling ' + esc(left.code) + ' and ' + esc(right.code) + ' apart.</p>' +
    '<div class="whichone-list">' + html + '</div></section>';
}

/** Build comparable rows from two agents' identity matrices + meta. */
function compareRows(left, right) {
  function ident(agent, paramName) {
    var rows = agent.identity || [];
    for (var i = 0; i < rows.length; i++) {
      if ((rows[i].parameter || '').toLowerCase() === paramName.toLowerCase()) {
        return rows[i].value + (rows[i].weight != null ? ' (' + rows[i].weight + ')' : '');
      }
    }
    return '—';
  }
  function count(arr) { return (arr && arr.length) || 0; }

  var defs = [
    { label: 'Archetype',        a: left.archetype || '—',  b: right.archetype || '—' },
    { label: 'Status',           a: left.status || '—',     b: right.status || '—' },
    { label: 'Core Fear',        a: ident(left, 'Core Fear'),        b: ident(right, 'Core Fear') },
    { label: 'Core Desire',      a: ident(left, 'Core Desire'),      b: ident(right, 'Core Desire') },
    { label: 'Primary Defense',  a: ident(left, 'Primary Defense'),  b: ident(right, 'Primary Defense') },
    { label: 'Attachment Style', a: ident(left, 'Attachment Style'), b: ident(right, 'Attachment Style') },
    { label: 'Love Language',    a: ident(left, 'Love Language'),    b: ident(right, 'Love Language') },
    { label: 'States modeled',   a: String(count(left.states)),      b: String(count(right.states)) },
    { label: 'Escalation levels',a: String(count(left.escalationLadder)), b: String(count(right.escalationLadder)) },
    { label: 'Triggers tracked', a: String(count(left.triggers)),    b: String(count(right.triggers)) },
    { label: 'Comm channels',    a: String(count(left.communication)),b: String(count(right.communication)) },
  ];
  return defs;
}

function wireCompareSelectors() {
  ['left', 'right'].forEach(function (which) {
    var el = $('cmp-' + which);
    if (!el) return;
    el.addEventListener('change', function () {
      var sel = App.compareSel || {};
      sel[which] = el.value;
      App.compareSel = sel;
      try { localStorage.setItem(LS_COMPARE, JSON.stringify(sel)); } catch (e) {}
      route(); // re-render with new selection
    });
  });
  // "Show differences only" toggle for the full comparison table.
  var diffToggle = $('diff-toggle');
  if (diffToggle) {
    diffToggle.addEventListener('change', function () {
      var sameRows = document.querySelectorAll('#compare-table .same-row');
      for (var i = 0; i < sameRows.length; i++) {
        sameRows[i].style.display = diffToggle.checked ? 'none' : '';
      }
    });
  }
}

/* ------------------------------------------------------------------ *
 *  VIEW: Glossary (searchable, alphabetical, A–Z jump, related terms)
 * ------------------------------------------------------------------ */

/** URL-safe slug for in-page anchors (never written to location.hash). */
function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'term';
}

/** Find related glossary terms: other terms mentioned in this term's definition
 *  (whole-phrase, case-insensitive), topped up with alphabetical neighbours. */
function glossaryRelated(term, allTerms) {
  var def = String(term.definition || '');
  var self = String(term.term || '');
  var hits = [];
  var byTerm = {};
  allTerms.forEach(function (t) { byTerm[String(t.term || '')] = t; });
  // Explicit cross-references from the data come first.
  (term.relatedTerms || []).forEach(function (name) {
    var t = byTerm[String(name)];
    if (t && t.term !== self && hits.indexOf(t) === -1) hits.push(t);
  });
  allTerms.forEach(function (t) {
    var other = String(t.term || '');
    if (!other || other === self) return;
    var q = other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      if (new RegExp('(^|[^a-z0-9])' + q + '([^a-z0-9]|$)', 'i').test(def)) hits.push(t);
    } catch (e) {}
  });
  // Top up with alphabetical neighbours so every term shows context.
  var sorted = allTerms.slice().sort(function (a, b) {
    return String(a.term || '').localeCompare(String(b.term || ''));
  });
  var selfIdx = -1;
  sorted.forEach(function (t, i) { if (t.term === self) selfIdx = i; });
  var extra = [];
  if (selfIdx !== -1) {
    var order = [1, -1, 2, -2];
    order.forEach(function (off) {
      var t = sorted[selfIdx + off];
      if (t && hits.indexOf(t) === -1 && extra.indexOf(t) === -1) extra.push(t);
    });
  }
  return hits.concat(extra).slice(0, 4);
}

function viewGlossary(query) {
  var terms = (App.data.glossary || []).slice();
  var q = (query || '').trim().toLowerCase();

  terms.sort(function (a, b) {
    return String(a.term || '').localeCompare(String(b.term || ''));
  });

  // Slugs + related-term graph computed on the full list (stable anchors).
  var slugs = {};
  terms.forEach(function (t) { slugs[t.term] = 'gloss-' + slugify(t.term); });
  var related = {};
  terms.forEach(function (t) { related[t.term] = glossaryRelated(t, terms); });

  if (q) {
    terms = terms.filter(function (t) {
      return String(t.term || '').toLowerCase().indexOf(q) !== -1 ||
             String(t.definition || '').toLowerCase().indexOf(q) !== -1 ||
             String(t.simpleDefinition || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  // Group by first letter.
  var groups = {};
  terms.forEach(function (t) {
    var letter = String(t.term || '#').charAt(0).toUpperCase() || '#';
    (groups[letter] = groups[letter] || []).push(t);
  });
  var letters = Object.keys(groups).sort();

  // A–Z quick-jump (only meaningful when not filtering).
  var azHtml = '';
  if (!q) {
    var allLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    azHtml = '<nav class="az-bar" aria-label="Jump to letter">' +
      allLetters.map(function (L) {
        return groups[L]
          ? '<a class="az-letter" data-jump="glossgrp-' + L + '" href="#/glossary" aria-label="Terms starting with ' + L + '">' + L + '</a>'
          : '<span class="az-letter az-disabled" aria-hidden="true">' + L + '</span>';
      }).join('') + '</nav>';
  }

  var listHtml = letters.length
    ? letters.map(function (L) {
        return '<h2 class="gloss-letter" id="glossgrp-' + L + '">' + esc(L) + '</h2><dl class="gloss-list">' +
          groups[L].map(function (t) {
            // Prefer curated relatedTerms from data; fall back to computed.
            var curated = (t.relatedTerms || []).filter(function (name) { return slugs[name]; });
            var rel = curated.length
              ? curated.map(function (name) { return { term: name }; })
              : (related[t.term] || []);
            var relHtml = rel.length
              ? '<div class="related-terms"><span class="related-label">Related:</span> ' +
                rel.map(function (r) {
                  return '<a data-jump="' + slugs[r.term] + '" href="#/glossary">' + esc(r.term) + '</a>';
                }).join('<span class="related-sep">·</span> ') + '</div>'
              : '';
            return '<div class="gloss-item" id="' + slugs[t.term] + '"><dt>' + highlight(t.term, query) + '</dt>' +
              '<dd class="gloss-plain">' + highlight(t.simpleDefinition || '', query) + '</dd>' +
              '<dd>' + highlight(t.definition, query) + '</dd>' +
              (t.exampleUsage ? '<dd class="gloss-example"><span class="gloss-example-label">Example:</span> ' + highlight(t.exampleUsage, query) + '</dd>' : '') +
              relHtml + '</div>';
          }).join('') + '</dl>';
      }).join('')
    : '<p class="muted">No glossary terms match "' + esc(query || '') + '". ' +
      '<a href="#/glossary">Clear the filter</a> to browse all terms.</p>';

  return '<header class="page-head"><h1>Glossary</h1>' +
      '<p class="muted">' + terms.length + ' term' + (terms.length === 1 ? '' : 's') + ' defined.</p></header>' +
    '<div class="search-bar"><input id="glossary-q" type="search" placeholder="Filter terms…" ' +
      'value="' + esc(query || '') + '" autocomplete="off" aria-label="Filter glossary terms"></div>' +
    azHtml + listHtml;
}

/* ------------------------------------------------------------------ *
 *  VIEW: Search (full-text with highlighting)
 * ------------------------------------------------------------------ */

/** Build a flat search index from the dataset. Cached after first build. */
var searchIndex = null;

function buildSearchIndex() {
  if (searchIndex) return searchIndex;
  var d = App.data;
  var docs = [];

  function pushDoc(kind, title, text, link, agent, section) {
    if (!text) return;
    var t = String(text);
    docs.push({ kind: kind, title: title, text: t, link: link,
                agent: agent || null, section: section || kind,
                // Lowercased word list (len>=3) used by fuzzy typo-tolerant scoring.
                _words: t.toLowerCase().split(/[^a-z0-9']+/).filter(function (w) { return w.length >= 3; }) });
  }

  // Preface
  var preface = d.preface || {};
  Object.keys(preface).forEach(function (k) {
    pushDoc('Preface', 'Preface: ' + k, preface[k], '#/home', null, 'Preface');
  });

  // Dimensions
  (d.dimensions || []).forEach(function (dim) {
    pushDoc('Framework', 'Dimension: ' + (dim.dimension || dim.code),
      [dim.dimension, dim.code, dim.poles, dim.function, dim.description].join(' '),
      '#/home', null, 'Framework');
  });

  // Agents — every section becomes searchable docs
  (d.agents || []).forEach(function (a) {
    var base = '#/agent/' + a.code;
    pushDoc('Agent', a.code + ' ' + (a.name || ''), [a.code, a.name, a.archetype, a.status].join(' '),
      base, a.code, 'Overview');
    (a.identity || []).forEach(function (r) {
      pushDoc('Identity', a.code + ' identity: ' + r.parameter,
        [r.parameter, r.value, r.manifestation].join(' '), base + '?tab=identity',
        a.code, 'Identity');
    });
    (a.states || []).forEach(function (s) {
      pushDoc('State', a.code + ' state: ' + s.name,
        [s.name, s.trigger, (s.behaviors || []).join(' '), (s.internal || []).join(' '),
         (s.exits || []).join(' ')].join(' '), base + '?tab=states',
        a.code, 'States');
    });
    (a.communication || []).forEach(function (r) {
      pushDoc('Communication', a.code + ' channel: ' + r.channel,
        [r.channel, r.optimization, r.example, r.avoid].join(' '), base + '?tab=communication',
        a.code, 'Communication');
    });
    (a.escalationLadder || []).forEach(function (r) {
      pushDoc('Escalation', a.code + ' level ' + r.level + ': ' + r.name,
        [r.level, r.name, r.behaviors, r.timing, r.resistance].join(' '), base + '?tab=escalation',
        a.code, 'Escalation');
    });
    (a.triggers || []).forEach(function (r) {
      pushDoc('Trigger', a.code + ' trigger: ' + r.trigger,
        [r.trigger, r.response, r.resolution].join(' '), base + '?tab=triggers',
        a.code, 'Triggers');
    });
    (a.emotionalSequence || []).forEach(function (r) {
      pushDoc('Emotion', a.code + ' emotion: ' + r.emotion,
        [r.emotion, r.condition, r.manifestation].join(' '), base + '?tab=emotions',
        a.code, 'Emotions');
    });
    (a.resistance || []).forEach(function (r) {
      pushDoc('Resistance', a.code + ' resistance: ' + r.type,
        [r.type, r.trigger, r.manifestation, r.strategy].join(' '), base + '?tab=resistance',
        a.code, 'Resistance');
    });
    (a.maintenance || []).forEach(function (r) {
      pushDoc('Maintenance', a.code + ' maintenance: ' + r.requirement,
        [r.requirement, r.frequency, r.indicator, r.failure].join(' '), base + '?tab=maintenance',
        a.code, 'Maintenance');
    });
  });

  // Glossary
  (d.glossary || []).forEach(function (t) {
    pushDoc('Glossary', 'Term: ' + t.term, t.term + ' ' + t.definition + ' ' + (t.simpleDefinition || ''),
      '#/glossary', null, 'Glossary');
  });

  searchIndex = docs;
  return docs;
}

/* ------------------------------------------------------------------ *
 *  Search helpers: fuzzy matching, suggestions, "did you mean?"
 * ------------------------------------------------------------------ */

/**
 * Levenshtein edit distance with early exit past maxDist.
 * Returns maxDist + 1 when the distance exceeds the cap.
 */
function levenshtein(a, b, maxDist) {
  var al = a.length, bl = b.length;
  if (Math.abs(al - bl) > maxDist) return maxDist + 1;
  var prev = new Array(bl + 1), cur = new Array(bl + 1);
  var i, j;
  for (j = 0; j <= bl; j++) prev[j] = j;
  for (i = 1; i <= al; i++) {
    cur[0] = i;
    var rowMin = i;
    var ac = a.charCodeAt(i - 1);
    for (j = 1; j <= bl; j++) {
      var cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      var v = prev[j] + 1;
      var ins = cur[j - 1] + 1;
      if (ins < v) v = ins;
      var sub = prev[j - 1] + cost;
      if (sub < v) v = sub;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDist) return maxDist + 1;
    var tmp = prev; prev = cur; cur = tmp;
  }
  return prev[bl];
}

/**
 * Best fuzzy similarity (0..1) of `term` against a doc's word list.
 * Returns 0 when nothing is within the typo tolerance (1 edit for short
 * terms, 2 for longer ones).
 */
function fuzzyTermScore(term, words) {
  var maxDist = term.length <= 4 ? 1 : 2;
  var best = 0;
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (w === term) continue; // exact hits are scored elsewhere
    if (Math.abs(w.length - term.length) > maxDist) continue;
    var dist = levenshtein(term, w, maxDist);
    if (dist <= maxDist) {
      var sim = 1 - dist / Math.max(term.length, w.length);
      if (sim > best) best = sim;
    }
  }
  return best;
}

/** Escape a string for use inside a RegExp. */
function regexEsc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Score one doc against the query terms.
 * Returns { score, fuzzy } — fuzzy is true when a typo-tolerant match
 * contributed. Returns null when not all terms matched.
 */
function scoreDoc(doc, terms, phrase) {
  var title = doc.title.toLowerCase();
  var text = doc.text.toLowerCase();
  var score = 0, matched = 0, fuzzy = false;

  terms.forEach(function (t) {
    if (!t) return;
    var titleIdx = title.indexOf(t);
    var textIdx = text.indexOf(t);
    if (titleIdx !== -1 || textIdx !== -1) {
      matched++;
      if (titleIdx !== -1) {
        // Title wins: word-boundary hits outrank mid-word substrings.
        score += new RegExp('\\b' + regexEsc(t)).test(title) ? 4 : 2.5;
        score += Math.max(0, 1.5 - titleIdx / 300);
      }
      if (textIdx !== -1) {
        score += 1 + Math.max(0, 1 - textIdx / 500);
      }
    } else {
      // Typo-tolerant fallback: close word in the doc still counts.
      var sim = fuzzyTermScore(t, doc._words || []);
      if (sim > 0) {
        matched++;
        fuzzy = true;
        score += sim * 1.4;
      }
    }
  });

  if (matched !== terms.length) return null;

  // Exact-phrase bonuses: searching "core desire" should surface the
  // doc that contains that exact phrase first.
  if (phrase && terms.length > 1) {
    if (title.indexOf(phrase) !== -1) score += 6;
    else if (text.indexOf(phrase) !== -1) score += 3;
  }
  return { score: score, fuzzy: fuzzy };
}

/** Cached pool of suggestion strings: glossary terms, agents, states, triggers, dimensions. */
var suggestPool = null;

function searchSuggestPool() {
  if (suggestPool) return suggestPool;
  var d = App.data, pool = [], seen = {};
  function add(s, kind) {
    s = String(s == null ? '' : s).trim();
    if (!s) return;
    var key = s.toLowerCase();
    if (seen[key]) return;
    seen[key] = 1;
    pool.push({ text: s, kind: kind });
  }
  (d.agents || []).forEach(function (a) {
    add(a.code, 'Agent');
    add(a.name, 'Agent');
    if (a.archetype) add(a.archetype, 'Agent');
    (a.states || []).forEach(function (s) { add(s.name, 'State'); });
    (a.triggers || []).forEach(function (t) { add(t.trigger, 'Trigger'); });
  });
  (d.dimensions || []).forEach(function (x) { add(x.dimension || x.code, 'Framework'); });
  (d.glossary || []).forEach(function (g) { add(g.term, 'Glossary'); });
  suggestPool = pool;
  return pool;
}

/** Top-N autocomplete suggestions for the current query (prefix matches first). */
function searchSuggestions(q, limit) {
  var needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  var pool = searchSuggestPool();
  var starts = [], contains = [];
  for (var i = 0; i < pool.length; i++) {
    var t = pool[i].text.toLowerCase();
    if (t === needle) continue;
    if (t.indexOf(needle) === 0) starts.push(pool[i]);
    else if (t.indexOf(needle) !== -1) contains.push(pool[i]);
  }
  return starts.concat(contains).slice(0, limit || 8);
}

/**
 * "Did you mean?" — when a search has zero hits, find the closest
 * suggestion-pool word for each query term (edit distance <= 2).
 * Returns a corrected query string, or null when nothing is close.
 */
function didYouMean(q) {
  var terms = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  var pool = searchSuggestPool();
  var words = [], seen = {};
  pool.forEach(function (p) {
    p.text.toLowerCase().split(/[^a-z0-9']+/).forEach(function (w) {
      if (w.length >= 4 && !seen[w]) { seen[w] = 1; words.push(w); }
    });
  });
  var changed = false;
  var corrected = terms.map(function (term) {
    var maxDist = term.length <= 4 ? 1 : 2;
    var best = null, bestDist = 99;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w === term) return term;
      if (Math.abs(w.length - term.length) > maxDist) continue;
      var dist = levenshtein(term, w, maxDist);
      if (dist > 0 && dist <= maxDist && dist < bestDist) {
        bestDist = dist;
        best = w;
      }
    }
    if (best) { changed = true; return best; }
    return term;
  });
  return changed ? corrected.join(' ') : null;
}

/** Agent code -> display name, for search breadcrumbs. */
function agentName(code) {
  var agents = (App.data && App.data.agents) || [];
  for (var i = 0; i < agents.length; i++) {
    if (agents[i].code === code) return agents[i].name || code;
  }
  return code;
}

/** Breadcrumb: "TDI · The Playette · States" or "Glossary · Terms". */
function resultCrumb(doc) {
  if (doc.agent) return doc.agent + ' · ' + agentName(doc.agent) + ' · ' + doc.section;
  return doc.section;
}

var SEARCH_FILTERS = [
  { id: 'all',     label: 'All' },
  { id: 'TDI',     label: 'TDI' },
  { id: 'TJI',     label: 'TJI' },
  { id: 'NDI',     label: 'NDI' },
  { id: 'glossary',label: 'Glossary' },
];

/** Does a search doc belong to the active filter? */
function docInFilter(doc, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'glossary') return doc.kind === 'Glossary';
  return doc.agent === filter;
}

/** Filter chips row; preserves the current query in each chip link. */
function filterChips(query, active) {
  active = active || 'all';
  return '<div class="chips" role="group" aria-label="Filter results">' +
    SEARCH_FILTERS.map(function (f) {
      var href = '#/search?q=' + encodeURIComponent(query || '') +
                 (f.id !== 'all' ? '&filter=' + f.id : '');
      return '<a class="chip' + (f.id === active ? ' active' : '') + '" data-filter="' + f.id + '"' +
        ' href="' + href + '"' + (f.id === active ? ' aria-current="true"' : '') + '>' + f.label + '</a>';
    }).join('') + '</div>';
}

/** Render one result card with agent/section breadcrumb context. */
function resultCard(r, q) {
  var doc = r.doc;
  var agentAttr = doc.agent ? ' data-agent="' + esc(doc.agent.toLowerCase()) + '"' : '';
  var snippet = makeSnippet(doc.text, q);
  return '<a class="result-card"' + agentAttr + ' href="' + esc(doc.link) + '">' +
    '<span class="result-kind">' + esc(doc.kind) + '</span>' +
    '<span class="result-crumb">' + esc(resultCrumb(doc)) + '</span>' +
    '<h3>' + highlight(doc.title, q) + '</h3>' +
    '<p>' + snippet + '</p></a>';
}

/** "No results" panel with typo correction + actionable suggestions. */
function noResultsHtml(q) {
  var dym = didYouMean(q);
  var dymHtml = dym
    ? '<p class="did-you-mean">Did you mean ' +
      '<a href="#/search?q=' + encodeURIComponent(dym) + '">"' + esc(dym) + '"</a>?</p>'
    : '';
  var terms = (App.data.glossary || []).slice(0, 6);
  var termChips = terms.map(function (t) {
    return '<a class="chip" href="#/search?q=' + encodeURIComponent(t.term) + '">' + esc(t.term) + '</a>';
  }).join('');
  return '<div class="no-results">' +
    '<div class="no-results-icon" aria-hidden="true">⌕</div>' +
    '<h3>No results for "' + esc(q) + '"</h3>' +
    dymHtml +
    '<p class="muted">Try one of these, or check your spelling and use fewer keywords:</p>' +
    '<div class="chips">' + termChips + '</div>' +
    '<p class="suggest-links">Or browse: ' +
      '<a href="#/glossary">full glossary</a> · ' +
      '<a href="#/agents">agent profiles</a> · ' +
      '<a href="#/framework">framework</a></p>' +
    '</div>';
}

/** Autocomplete dropdown HTML for the current query (empty string when none). */
function searchSuggestHtml(q) {
  if (!q || !q.trim()) return '';
  var suggs = searchSuggestions(q, 8);
  if (!suggs.length) return '';
  return '<div class="search-suggest" id="search-suggest" role="listbox" aria-label="Search suggestions">' +
    suggs.map(function (s) {
      return '<a class="search-suggest-item" role="option" tabindex="-1" ' +
        'href="#/search?q=' + encodeURIComponent(s.text) + '">' +
        '<span class="suggest-text">' + highlight(s.text, q) + '</span>' +
        '<span class="suggest-kind">' + esc(s.kind) + '</span></a>';
    }).join('') + '</div>';
}

function viewSearch(query, filter) {
  var q = (query || '').trim();
  var f = filter || 'all';
  var docs = buildSearchIndex();
  var resultsHtml = '';

  if (!q) {
    // Browse mode: show filtered doc list (top 50) or the standard hint.
    var browsable = docs.filter(function (d) { return docInFilter(d, f); }).slice(0, 50);
    if (f === 'all') {
      resultsHtml = '<p class="muted">Type above to search every agent profile, state, trigger, ' +
        'communication channel, and glossary term. Results highlight your keywords.</p>';
    } else {
      var fLabel = f === 'glossary' ? 'Glossary' : f + ' · ' + agentName(f);
      resultsHtml = '<p class="muted">Browsing <strong>' + esc(fLabel) + '</strong> — ' +
        browsable.length + ' item' + (browsable.length === 1 ? '' : 's') + '.</p>' +
        '<div class="results">' + browsable.map(function (d) {
          return resultCard({ doc: d, score: 0 }, '');
        }).join('') + '</div>';
    }
  } else {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    var phrase = q.toLowerCase();
    var scored = [];
    var anyFuzzy = false;

    docs.forEach(function (doc) {
      if (!docInFilter(doc, f)) return;
      var r = scoreDoc(doc, terms, phrase);
      if (r) {
        if (r.fuzzy) anyFuzzy = true;
        scored.push({ doc: doc, score: r.score, fuzzy: r.fuzzy });
      }
    });

    scored.sort(function (x, y) { return y.score - x.score; });
    var top = scored.slice(0, 50);

    resultsHtml = top.length
      ? '<p class="muted">' + top.length + ' result' + (top.length === 1 ? '' : 's') +
        (scored.length > 50 ? ' (top 50 shown)' : '') + ' for "' + esc(q) + '"' +
        (f !== 'all' ? ' in <strong>' + esc(f) + '</strong>' : '') +
        (anyFuzzy ? ' <span class="fuzzy-note">(includes close matches)</span>' : '') + '.</p>' +
        '<div class="results">' + top.map(function (r) {
          return resultCard(r, q);
        }).join('') + '</div>'
      : noResultsHtml(q);
  }

  return '<header class="page-head"><h1>Search</h1>' +
      '<p class="muted">Full-text search across the entire dataset. ' +
      '<span class="kbd-hint">Press <kbd>/</kbd> anywhere to jump here.</span></p></header>' +
    '<div class="search-wrap"><div class="search-bar"><input id="search-q" type="search" ' +
      'placeholder="Search agents, states, triggers…  ( / )" ' +
      'value="' + esc(query || '') + '" autocomplete="off" aria-label="Search the dataset" ' +
      'aria-expanded="' + (q && searchSuggestions(q, 1).length ? 'true' : 'false') + '" ' +
      'aria-controls="search-suggest" role="combobox" aria-autocomplete="list"></div>' +
    searchSuggestHtml(q) + '</div>' +
    filterChips(q, f) +
    resultsHtml;
}

/** Extract a ~160-char snippet around the earliest query hit, with highlighting. */
function makeSnippet(text, query) {
  var plain = String(text || '');
  var lower = plain.toLowerCase();
  var trimmed = query.trim().toLowerCase();
  var terms = trimmed.split(/\s+/).filter(Boolean);
  var idx = -1;
  // Whole-phrase hit first (usually the most relevant context)...
  var pi = trimmed ? lower.indexOf(trimmed) : -1;
  if (pi !== -1) idx = pi;
  // ...otherwise the earliest individual term.
  terms.forEach(function (t) {
    var i = lower.indexOf(t);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  });
  var start = idx === -1 ? 0 : Math.max(0, idx - 60);
  var snippet = plain.slice(start, start + 170);
  if (start > 0) snippet = '…' + snippet;
  if (start + 170 < plain.length) snippet += '…';
  return highlight(snippet, query);
}

/* ------------------------------------------------------------------ *
 *  VIEW: Audit
 * ------------------------------------------------------------------ */

function viewAudit() {
  var d = App.data;
  var meta = d.meta || {};
  var audit = d.auditSummary || {};
  var totals = audit.totals || {};
  var domains = audit.domains || [];
  var fixed = audit.criticalFixed || audit.fixed || [];
  var remaining = audit.knownIssues || audit.remaining || [];

  var totalsHtml = '<div class="stats-row">' + [
    { n: totals.critical != null ? totals.critical : '—', label: 'Critical', cls: 'sev-critical' },
    { n: totals.moderate != null ? totals.moderate : '—', label: 'Moderate', cls: 'sev-moderate' },
    { n: totals.minor != null ? totals.minor : '—', label: 'Minor', cls: 'sev-minor' },
  ].map(function (s) {
    return '<div class="stat"><div class="stat-num ' + (s.cls || '') + '"' + countAttr(s.n) + '>' + esc(s.n) + '</div>' +
      '<div class="stat-label">' + esc(s.label) + '</div></div>';
  }).join('') + '</div>';

  var domainsHtml = domains.length
    ? table(
        [{ key: 'domain', label: 'Audit Domain' },
         { key: 'critical', label: 'Critical' },
         { key: 'moderate', label: 'Moderate' },
         { key: 'minor', label: 'Minor' },
         { key: 'status', label: 'Status' }],
        domains)
    : '';

  var fixedHtml = fixed.length
    ? '<ul class="check-list">' + fixed.map(function (f) {
        return '<li><span class="check">✓</span> ' + esc(typeof f === 'string' ? f : (f.text || f.title || '')) + '</li>';
      }).join('') + '</ul>'
    : '';

  var remainingHtml = remaining.length
    ? '<ul class="warn-list">' + remaining.map(function (r) {
        return '<li><span class="warn">!</span> ' + esc(typeof r === 'string' ? r : (r.text || r.title || '')) + '</li>';
      }).join('') + '</ul>'
    : '';

  return '<header class="page-head"><h1>Audit Report</h1>' +
      '<p class="muted">' + esc(meta.auditDepth || '') + ' audit · ' +
      esc(meta.auditDate || '') + ' · v' + esc(meta.version || '') + '</p></header>' +
    section('findings', 'Findings by Severity', totalsHtml) +
    (domainsHtml ? section('domains', 'Findings by Domain', domainsHtml) : '') +
    (fixedHtml ? section('fixed', 'Issues Fixed in This Edition', fixedHtml) : '') +
    (remainingHtml ? section('remaining', 'Known Remaining Issues', remainingHtml) : '');
}

/* ------------------------------------------------------------------ *
 *  VIEW: Sitemap (all routes in one place)
 * ------------------------------------------------------------------ */

function viewSitemap() {
  // Task-oriented IA groups: every route keeps working; this page just
  // presents them by user intent instead of fixed content order.
  var groups = [
    { intent: 'Discover', rows: [
      { hash: '#/home', label: 'Home', desc: 'Dashboard: hero, axes, agent overview, stats' },
    ] },
    { intent: 'Explore', rows: [
      { hash: '#/agents', label: 'Agent Profiles', desc: 'All three agent archetypes' },
    ] },
    { intent: 'Compare', rows: [
      { hash: '#/compare', label: 'Compare', desc: 'Side-by-side profile comparison' },
    ] },
    { intent: 'Learn', rows: [
      { hash: '#/framework', label: 'Dimensional Framework', desc: 'Core axes and type-code taxonomy' },
      { hash: '#/glossary', label: 'Glossary', desc: 'Searchable term definitions' },
    ] },
    { intent: 'Saved', rows: [
      { hash: '#/saved', label: 'Saved', desc: 'Your bookmarked sections' },
    ] },
    { intent: 'Tools', rows: [
      { hash: '#/search', label: 'Search', desc: 'Full-text search across the library' },
    ] },
    { intent: 'More', rows: [
      { hash: '#/audit', label: 'Audit Report', desc: 'Findings, fixes, and known issues' },
      { hash: '#/changelog', label: "What's New", desc: 'Version history and changelog' },
    ] },
  ];
  function linkRow(l) {
    return '<a class="sitemap-row" href="' + esc(l.hash) + '">' +
      '<span class="sitemap-label">' + esc(l.label) + '</span>' +
      '<span class="sitemap-desc muted">' + esc(l.desc) + '</span>' +
      '<span class="sitemap-go" aria-hidden="true">→</span></a>';
  }
  function groupBlock(g) {
    return '<h3 class="sitemap-intent">' + esc(g.intent) + '</h3>' +
      '<div class="sitemap-list">' + g.rows.map(linkRow).join('') + '</div>';
  }
  // Agent profiles with deep links into every tab of the profile.
  var agents = (App.data.agents || []).map(function (a) {
    var code = encodeURIComponent(a.code || '');
    var tabs = AGENT_TABS.map(function (t) {
      return '<a class="chip" href="#/agent/' + code + '?tab=' + t.id + '">' + esc(t.label) + '</a>';
    }).join(' ');
    return { hash: '#/agent/' + code, label: (a.code || '') + ' — ' + (a.name || ''), desc: a.archetype || '', tabs: tabs };
  });
  function agentRow(l) {
    return '<div class="sitemap-agent">' + linkRow(l) +
      '<div class="sitemap-tabs">' + l.tabs + '</div></div>';
  }
  // Glossary terms as direct search links.
  var glossaryRows = (App.data.glossary || []).map(function (g) {
    return { hash: '#/glossary?q=' + encodeURIComponent(g.term), label: g.term, desc: '' };
  });
  var shortcuts = [
    { hash: '#/search', keys: ['/'],      label: 'jump to search', desc: 'Focuses the search box from anywhere' },
    { hash: '#/agents', keys: ['←', '→'], label: 'switch tabs', desc: 'On an agent profile, arrow keys flip through the 8 tabs' },
    { hash: '#/search', keys: ['Esc'],    label: 'leave the search box', desc: 'Blurs the active input' },
  ];
  function shortcutRow(s) {
    return '<a class="sitemap-row" href="' + esc(s.hash) + '">' +
      '<span class="sitemap-label">' + s.keys.map(function (k) { return '<kbd>' + esc(k) + '</kbd>'; }).join(' ') +
      ' ' + esc(s.label) + '</span>' +
      '<span class="sitemap-desc muted">' + esc(s.desc) + '</span>' +
      '<span class="sitemap-go" aria-hidden="true">→</span></a>';
  }
  return breadcrumbs([
      { label: 'Home', hash: '#/home' },
      { label: 'Sitemap' },
    ]) +
    '<header class="page-head"><h1>Sitemap</h1>' +
    '<p class="muted">Every section of the library, one tap away — organized by what you want to do. All pages work offline once installed.</p></header>' +
    section('pages', 'Sections', groups.map(groupBlock).join('')) +
    (agents.length ? section('agents', 'Explore — agent profiles', '<div class="sitemap-list">' + agents.map(agentRow).join('') + '</div>') : '') +
    (glossaryRows.length ? section('glossary', 'Learn — glossary terms', '<div class="sitemap-list">' + glossaryRows.map(linkRow).join('') + '</div>') : '') +
    section('shortcuts', 'Keyboard shortcuts', '<div class="sitemap-list">' + shortcuts.map(shortcutRow).join('') + '</div>');
}

/* ------------------------------------------------------------------ *
 *  VIEW: Changelog ("What's New")
 * ------------------------------------------------------------------ */

var CHANGELOG = [
  {
    version: '1.1.0', date: '2026-10-08', tag: 'Latest',
    items: [
      'Share button on every agent profile (Web Share API with copy-link fallback).',
      'Redesigned offline page: shows every section available offline plus one-tap retry.',
      'App shortcuts: long-press the icon for Agents, Search, and Compare.',
      '"What\'s New" changelog view and full sitemap.',
      'Smarter install prompt: appears after you\'ve explored, with clear benefits.',
      'Faster loads: data preloading, lazy rendering hints for long sections.',
    ],
  },
  {
    version: '1.0.1', date: '2026-10-07', tag: 'Fixes',
    items: [
      'Fixed loader that could leave the app shell hidden.',
      'Added the missing Framework route and view.',
      'Restored hidden Compare and Audit content (data-key fixes).',
      'Wired the PWA install button to the real install prompt.',
      'Added 64 missing style definitions; agent color theming now renders.',
      'Hardened share URLs and search against malformed input.',
    ],
  },
  {
    version: '1.0.0', date: '2026-10-07', tag: 'Launch',
    items: [
      'Initial release: interactive PWA web app of the Pandora\'s Box dataset.',
      'Three agent archetypes (TDI, TJI, NDI) with eight-section profiles.',
      'Search, compare, glossary, framework, and audit views.',
      'Offline-first via service worker; installable on home screen.',
      '1,000x multi-agent audit before release.',
    ],
  },
];

function viewChangelog() {
  var entries = CHANGELOG.map(function (e) {
    return '<article class="changelog-entry">' +
      '<div class="changelog-head"><span class="pill">' + esc('v' + e.version) + '</span>' +
      '<span class="muted small">' + esc(e.date) + '</span>' +
      (e.tag ? '<span class="badge">' + esc(e.tag) + '</span>' : '') + '</div>' +
      '<ul class="check-list">' + e.items.map(function (it) {
        return '<li><span class="check">✓</span> ' + esc(it) + '</li>';
      }).join('') + '</ul></article>';
  }).join('');
  return '<header class="page-head"><h1>What\'s New</h1>' +
    '<p class="muted">Version history for PandoraBook. The app updates automatically when you\'re online.</p></header>' +
    '<div class="changelog-list">' + entries + '</div>';
}

/* ------------------------------------------------------------------ *
 *  Share (Web Share API with clipboard fallback)
 * ------------------------------------------------------------------ */

/** Toast notification helper. */
var toastTimer = null;
function showToast(msg) {
  var t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    t.classList.remove('show');
    t.hidden = true;
  }, 2600);
}

/** Share an agent profile: native sheet on mobile, copy-link fallback elsewhere. */
function shareAgent(code) {
  var agent = findAgent(code);
  if (!agent) return;
  var url = location.origin + location.pathname + '#/agent/' + encodeURIComponent(agent.code);
  var data = {
    title: "Pandora's Box — " + (agent.name || agent.code),
    text: (agent.code || '') + ': ' + (agent.archetype || 'AI agent behavioral profile') + ' — from the Pandora\'s Box library.',
    url: url,
  };
  function fallbackCopy() {
    function copied() { showToast('Link copied — paste it anywhere to share.'); }
    function failed() { showToast('Copy this link: ' + url); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(data.title + '\n' + url).then(copied, failed);
    } else {
      var ta = document.createElement('textarea');
      ta.value = data.title + '\n' + url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); copied(); } catch (e) { failed(); }
      document.body.removeChild(ta);
    }
  }
  if (navigator.share) {
    navigator.share(data).catch(function (err) {
      // User dismissed the sheet: stay silent. Real errors fall back to copy.
      if (err && err.name !== 'AbortError') fallbackCopy();
    });
  } else {
    fallbackCopy();
  }
}

/* ------------------------------------------------------------------ *
 *  Boot
 * ------------------------------------------------------------------ */

function init() {
  loadProgress();
  renderShell();
  window.addEventListener('hashchange', route);
  loadData();
  wireInstallButton();
  wireBackTop();
  wireHeaderChrome();
  wirePullTension();
  wireKeyboard();
  wireJumpChips();
  wireInteractive();
  wireMoreMenu();
  injectDynamicStyles();
  applyFontSize(loadFontSize());
  ensureProgressBar();
  wireProgressScroll();

  // Note: SW also registered in index.html (root-relative). This relative
  // registration is a no-op duplicate; kept as fallback for subpath mounts.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {
        /* offline shell is best-effort; app still works without it */
      });
    });
  }
}

/** Quick-jump chips: scroll to a section without touching location.hash
 *  (hash changes would be intercepted by the router). Delegated so it
 *  survives tab-body re-renders. */
function wireJumpChips() {
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document) {
      if (el.classList && el.classList.contains('jump-chip')) {
        var target = document.getElementById(el.getAttribute('data-jump'));
        if (target && target.scrollIntoView) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        e.preventDefault();
        return;
      }
      el = el.parentNode;
    }
  });
}

/** Delegated handler for all interactive-feature controls:
 *  bookmarks, font size, copy-link, table collapse, print, unsave.
 *  One listener survives every innerHTML re-render. */
function wireInteractive() {
  document.addEventListener('click', function (e) {
    // Haptic-like tap feedback on the tab bars (Android vibration, guarded).
    try {
      var haptic = e.target && e.target.closest
        ? e.target.closest('.bottom-link, .tab')
        : null;
      if (haptic && navigator.vibrate) navigator.vibrate(10);
    } catch (err) { /* vibration unsupported — visual press state still applies */ }
    var el = e.target;
    while (el && el !== document) {
      if (el.getAttribute) {
        // 1. Bookmark star toggle
        var bmKey = el.getAttribute('data-bookmark-key');
        if (bmKey) {
          var nowSaved = toggleBookmark(
            bmKey,
            el.getAttribute('data-bookmark-title') || bmKey,
            el.getAttribute('data-bookmark-hash') || '#/home'
          );
          el.classList.toggle('saved', nowSaved);
          el.setAttribute('aria-pressed', nowSaved ? 'true' : 'false');
          el.innerHTML = nowSaved ? '&#9733;' : '&#9734;';
          var label = (nowSaved ? 'Remove bookmark: ' : 'Bookmark this section: ') +
            (el.getAttribute('data-bookmark-title') || '');
          el.setAttribute('aria-label', label);
          syncSavedCount();
          e.preventDefault();
          return;
        }
        // 2. Font-size buttons
        var fs = el.getAttribute('data-fs');
        if (fs) {
          applyFontSize(fs);
          e.preventDefault();
          return;
        }
        // 2b. "Compare with" shortcut: preselect the pair, jump to compare.
        var pair = el.getAttribute('data-compare-pair');
        if (pair) {
          var parts = String(pair).split('|');
          if (parts.length === 2 && parts[0] && parts[1]) {
            App.compareSel = { left: parts[0], right: parts[1] };
            try { localStorage.setItem(LS_COMPARE, JSON.stringify(App.compareSel)); } catch (e2) {}
            go('#/compare');
          }
          e.preventDefault();
          return;
        }
        // 3. Copy-link buttons
        if (el.hasAttribute('data-copy-link')) {
          var url = el.getAttribute('data-url') || absoluteHashUrl();
          var btn = el;
          copyTextToClipboard(url,
            function () {
              var orig = btn.innerHTML;
              btn.innerHTML = '&#10003; Copied!';
              btn.classList.add('copy-ok'); /* W3: success glow, see CSS */
              setTimeout(function () { btn.innerHTML = orig; btn.classList.remove('copy-ok'); }, 1600);
            },
            function () {
              var orig2 = btn.innerHTML;
              btn.innerHTML = 'Copy failed';
              setTimeout(function () { btn.innerHTML = orig2; }, 1600);
            });
          e.preventDefault();
          return;
        }
        // 4. Table expand/collapse
        var cTarget = el.getAttribute('data-collapse-target');
        if (cTarget) {
          var body = document.getElementById(cTarget);
          if (body) {
            var hiddenNow = body.hasAttribute('hidden');
            if (hiddenNow) body.removeAttribute('hidden');
            else body.setAttribute('hidden', '');
            var total = el.getAttribute('data-total') || '';
            el.setAttribute('aria-expanded', hiddenNow ? 'true' : 'false');
            el.innerHTML = hiddenNow
              ? 'Show fewer rows &#x25B2;'
              : 'Show all ' + total + ' rows &#x25BE;';
          }
          e.preventDefault();
          return;
        }
        // 5. Print button
        if (el.hasAttribute('data-print')) {
          if (window.print) window.print();
          e.preventDefault();
          return;
        }
        // 6. Remove bookmark (Saved view)
        var unKey = el.getAttribute('data-unsave');
        if (unKey) {
          removeBookmark(unKey);
          syncSavedCount();
          route();
          e.preventDefault();
          return;
        }
      }
      el = el.parentNode;
    }
  });
}

/** Refresh the "Saved (N)" count badge in the utility toolbar. */
function syncSavedCount() {
  var badges = document.querySelectorAll('.util-count');
  for (var i = 0; i < badges.length; i++) {
    badges[i].textContent = String(savedCount());
  }
}

/** PWA install prompt wiring — engagement-aware, benefit-led. */
var deferredPrompt = null;
var LS_INSTALL_DISMISSED = 'pandorabook.install.dismissed.v1';
var LS_INSTALL_VIEWS = 'pandorabook.install.views.v1';

function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (window.navigator && window.navigator.standalone === true);
}

function installDismissed() {
  try { return localStorage.getItem(LS_INSTALL_DISMISSED) === '1'; } catch (e) { return true; }
}

function bumpInstallViews() {
  try {
    var n = parseInt(localStorage.getItem(LS_INSTALL_VIEWS) || '0', 10) || 0;
    localStorage.setItem(LS_INSTALL_VIEWS, String(n + 1));
    return n + 1;
  } catch (e) { return 99; }
}

/** Decide whether the moment is right to surface the install banner. */
function maybeShowInstallBanner() {
  if (!deferredPrompt || isStandalone() || installDismissed()) return;
  var banner = document.getElementById('installBanner');
  if (!banner || !banner.hidden === false) return;
  var views = bumpInstallViews();
  // Show after real engagement: 3+ section views, or 45s on site.
  var engaged = views >= 3;
  if (engaged) {
    banner.hidden = false;
  } else {
    setTimeout(function () {
      if (deferredPrompt && !isStandalone() && !installDismissed()) {
        var b = document.getElementById('installBanner');
        if (b && b.hidden) b.hidden = false;
      }
    }, 45000);
  }
}

function dismissInstallBanner() {
  var banner = document.getElementById('installBanner');
  if (banner) banner.hidden = true;
  try { localStorage.setItem(LS_INSTALL_DISMISSED, '1'); } catch (e) {}
}

function triggerInstall() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(function (choice) {
    if (choice && choice.outcome === 'accepted') {
      showToast('PandoraBook installed — find it on your home screen.');
    }
    deferredPrompt = null;
    dismissInstallBanner();
    var btn = document.getElementById('installBtn');
    if (btn) btn.hidden = true;
  }).catch(function () {
    deferredPrompt = null;
  });
}

function wireInstallButton() {
  var btn = document.getElementById('installBtn');
  var bannerBtn = document.getElementById('installBannerBtn');
  var bannerDismiss = document.getElementById('installBannerDismiss');

  if (bannerBtn) bannerBtn.addEventListener('click', triggerInstall);
  if (bannerDismiss) bannerDismiss.addEventListener('click', dismissInstallBanner);
  if (btn) btn.addEventListener('click', triggerInstall);

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    // Header button = quiet persistent entry point; banner = the persuasive one.
    if (btn && !isStandalone()) btn.hidden = false;
    maybeShowInstallBanner();
  });
  // Re-evaluate on every navigation: engagement may cross the threshold later.
  window.addEventListener('hashchange', maybeShowInstallBanner);
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    dismissInstallBanner();
    var b2 = document.getElementById('installBtn');
    if (b2) b2.hidden = true;
  });
}

/** Pull-down tension: resistive rubber-band on #app when the user drags
 *  down past the top of the page, snapping back on release.
 *  Native-app feel for the root scroll; no-ops on desktop (no touch),
 *  in reduced-motion mode, and while typing. */
function wirePullTension() {
  var app = document.getElementById('app');
  if (!app || !('ontouchstart' in window)) return;
  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}
  if (reduceMotion) return;

  var startY = 0, dy = 0, active = false;
  var MAX_PULL = 88, RESISTANCE = 0.4;

  function atTop() {
    return (window.scrollY || window.pageYOffset || 0) <= 0;
  }
  function isFormTarget(t) {
    return t && t.closest &&
      t.closest('input, textarea, select, [contenteditable="true"]');
  }

  window.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1 || !atTop() || isFormTarget(e.target)) return;
    startY = e.touches[0].clientY;
    dy = 0;
    active = true;
  }, { passive: true });

  window.addEventListener('touchmove', function (e) {
    if (!active || e.touches.length !== 1) return;
    var d = e.touches[0].clientY - startY;
    if (d > 0 && atTop()) {
      dy = Math.min(d * RESISTANCE, MAX_PULL);
      app.classList.add('pull-active');
      app.style.transform = 'translateY(' + dy + 'px)';
    } else if (d <= 0 && dy > 0) {
      dy = 0;
      app.classList.remove('pull-active');
      app.style.transform = '';
    }
  }, { passive: true });

  function endPull() {
    if (!active) return;
    active = false;
    if (dy > 0) {
      // Release: CSS transition on #app (see §V6) snaps it back.
      app.classList.remove('pull-active');
      app.style.transform = '';
    }
    dy = 0;
  }
  window.addEventListener('touchend', endPull, { passive: true });
  window.addEventListener('touchcancel', endPull, { passive: true });
  // A route change mid-pull must never leave the view offset.
  window.addEventListener('hashchange', function () {
    active = false; dy = 0;
    app.classList.remove('pull-active');
    app.style.transform = '';
  });
}

/** App-bar chrome: intensify the header glass once the user scrolls. */
function wireHeaderChrome() {
  var header = document.getElementById('appHeader');
  if (!header) return;
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var y = window.scrollY || window.pageYOffset || 0;
      header.classList.toggle('scrolled', y > 8);
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/** Floating "Back to top" button: appears after scrolling down. */
function wireBackTop() {  var btn = document.getElementById('backTop');
  if (!btn) return;
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var y = window.scrollY || window.pageYOffset || 0;
      btn.hidden = y < 600;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  btn.addEventListener('click', function () {
    var reduce = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    var main = document.getElementById('app');
    if (main) main.focus({ preventScroll: true });
  });
  // Reset on every route change (route() scrolls to top anyway).
  window.addEventListener('hashchange', function () { btn.hidden = true; });
}

/** True while the user is typing in a form control. */
function isTypingTarget(el) {
  if (!el) return false;
  var tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

/** Keyboard shortcuts: "/" = search, arrows = agent-detail tabs. */
function wireKeyboard() {
  document.addEventListener('keydown', function (e) {
    var typing = isTypingTarget(document.activeElement) || isTypingTarget(e.target);
    var mod = e.ctrlKey || e.metaKey || e.altKey;

    if (e.key === 'Escape') {
      if (typing && document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
      return;
    }
    if (mod || typing) return;

    // "/" jumps to search and focuses the input.
    if (e.key === '/') {
      e.preventDefault();
      focusSearchInput();
      return;
    }

    // Arrow keys flip through agent-detail tabs.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      var r = parseHash();
      if (r.name !== 'agentDetail') return;
      var agent = findAgent(r.param);
      if (!agent) return;
      var idx = tabIndexOf(r.query.tab || App.activeTab[agent.code] || 'identity');
      var next = idx + (e.key === 'ArrowRight' ? 1 : -1);
      next = (next + AGENT_TABS.length) % AGENT_TABS.length;
      e.preventDefault();
      go('#/agent/' + agent.code + '?tab=' + AGENT_TABS[next].id);
    }
  });
}

/** Go to search and focus the query input once rendered. */
function focusSearchInput() {
  var r = parseHash();
  function focus() {
    var input = document.getElementById('search-q');
    if (input) { input.focus(); input.select(); }
  }
  if (r.name === 'search') {
    focus();
  } else {
    go('#/search');
    setTimeout(focus, 60);
  }
}

// Expose minimal API for debugging / future extensions.
window.PandoraBook = {
  go: go,
  getData: function () { return App.data; },
  getProgress: function () { return App.progress; },
  shareAgent: shareAgent,
  showToast: showToast,
  version: '1.1.0',
};

document.addEventListener('DOMContentLoaded', init);
