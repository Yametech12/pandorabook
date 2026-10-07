/**
 * PandoraBook — PWA SPA Logic
 * ============================
 * Vanilla JS single-page application for the Pandora's Box dataset.
 *
 * Features:
 *  1. Hash-based router: #/home, #/agents, #/agent/:code, #/compare,
 *     #/glossary, #/search, #/audit
 *  2. Home view: hero, dimensional axes cards, agent overview, quick stats
 *  3. Agents list view: cards for TDI / TJI / NDI with status badges
 *  4. Agent detail view: tabbed interface
 *     (Identity | States | Communication | Escalation | Triggers |
 *      Emotions | Resistance | Maintenance)
 *  5. Compare view: side-by-side agent comparison with selectors
 *  6. Glossary view: searchable, alphabetical
 *  7. Search view: full-text search with keyword highlighting
 *  8. Audit view: audit summary + findings table
 *  9. Offline support: graceful fallback when content.json is unavailable
 * 10. Reading progress: visited-section tracking via localStorage
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
var LS_PROGRESS   = 'pandorabook.progress.v1';   // reading-progress store
var LS_COMPARE    = 'pandorabook.compare.v1';     // compare-view selections
var APP_ROOT_ID   = 'app';
var NAV_ID        = 'nav';

/** Route table: hash prefix -> view renderer. Order matters (longest first). */
var ROUTES = [
  { prefix: '#/agent/',  view: 'agentDetail' },
  { prefix: '#/home',    view: 'home'       },
  { prefix: '#/agents',  view: 'agents'     },
  { prefix: '#/framework', view: 'framework' },
  { prefix: '#/compare', view: 'compare'    },
  { prefix: '#/glossary',view: 'glossary'   },
  { prefix: '#/search',  view: 'search'     },
  { prefix: '#/audit',   view: 'audit'      },
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
 * Highlight occurrences of `query` inside `text` with <mark>.
 * Both inputs are escaped first; matching is case-insensitive.
 */
function highlight(text, query) {
  var safe = esc(text);
  if (!query || !query.trim()) return safe;
  var q = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return safe.replace(new RegExp('(' + q + ')', 'gi'), '<mark>$1</mark>');
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
 *  Reading progress (localStorage)
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

function route() {
  var r = parseHash();
  markVisited(r.name + (r.param ? '/' + r.param : ''));
  renderNav(r.name);
  var root = $(APP_ROOT_ID);
  if (!root) return;

  if (App.loading) {
    root.innerHTML = loadingView();
    return;
  }
  if (App.dataError || !App.data) {
    root.innerHTML = offlineView(App.dataError);
    return;
  }

  switch (r.name) {
    case 'home':       root.innerHTML = viewHome(); break;
    case 'agents':     root.innerHTML = viewAgents(); break;
    case 'framework':  root.innerHTML = viewFramework(); break;
    case 'agentDetail':root.innerHTML = viewAgentDetail(r.param, r.query.tab); break;
    case 'compare':    root.innerHTML = viewCompare(); break;
    case 'glossary':   root.innerHTML = viewGlossary(r.query.q); break;
    case 'search':     root.innerHTML = viewSearch(r.query.q); break;
    case 'audit':      root.innerHTML = viewAudit(); break;
    default:           root.innerHTML = viewHome();
  }

  afterRender(r);
  window.scrollTo(0, 0);
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
        go('#/search?q=' + encodeURIComponent(sq.value));
      }, 300);
    });
    // Enter key on the button-less input still triggers via hash change.
  }
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

var NAV_LINKS = [
  { hash: '#/home',     label: 'Home',     icon: '⌂' },
  { hash: '#/agents',   label: 'Agents',    icon: '◈' },
  { hash: '#/compare',  label: 'Compare',   icon: '⇄' },
  { hash: '#/glossary', label: 'Glossary',  icon: '≣' },
  { hash: '#/search',   label: 'Search',    icon: '⌕' },
  { hash: '#/audit',    label: 'Audit',     icon: '✓' },
];

function renderNav(activeName) {
  // Update active states on the static shell navs (top-nav + bottom-nav).
  // Maps view names to their hash routes.
  var viewToHash = {
    home: '#/home', agents: '#/agents', agentDetail: '#/agents',
    framework: '#/framework', compare: '#/compare',
    glossary: '#/glossary', search: '#/search', audit: '#/audit'
  };
  var activeHash = viewToHash[activeName] || '#/home';
  var links = document.querySelectorAll('.top-link, .bottom-link');
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href');
    if (href === activeHash) {
      links[i].classList.add('active');
      links[i].setAttribute('aria-current', 'page');
    } else {
      links[i].classList.remove('active');
      links[i].removeAttribute('aria-current');
    }
  }
  // Legacy: also support a dynamic #nav container if present.
  var nav = $(NAV_ID);
  if (nav && typeof NAV_LINKS !== 'undefined') {
    var html = NAV_LINKS.map(function (l) {
      var isActive = (l.hash === activeHash);
      return '<a href="' + l.hash + '" class="nav-link' + (isActive ? ' active' : '') + '">' +
        '<span class="nav-icon">' + l.icon + '</span><span class="nav-label">' + l.label + '</span></a>';
    }).join('');
    nav.innerHTML = '<div class="nav-inner">' + html + '</div>';
  }
}

function loadingView() {
  return '<div class="center-wrap"><div class="spinner"></div>' +
    '<p class="muted">Loading PandoraBook content…</p></div>';
}

function offlineView(errMsg) {
  return '<div class="center-wrap">' +
    '<div class="offline-icon">⚠</div>' +
    '<h2>Content unavailable offline</h2>' +
    '<p class="muted">PandoraBook could not load <code>data/content.json</code>.</p>' +
    '<p class="muted small">Reason: ' + esc(errMsg || 'unknown') + '</p>' +
    '<p>Check your connection, then <button class="btn" onclick="location.reload()">retry</button>.</p>' +
    '<p class="muted small">Your reading progress is saved on this device and will resume when content loads.</p>' +
    '</div>';
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

/** Generic table renderer. cols: [{key, label}]. rows: array of objects. */
function table(cols, rows, opts) {
  opts = opts || {};
  if (!rows || !rows.length) {
    return '<p class="muted empty-note">' + esc(opts.empty || 'No data available for this section.') + '</p>';
  }
  var thead = '<thead><tr>' + cols.map(function (c) {
    return '<th>' + esc(c.label) + '</th>';
  }).join('') + '</tr></thead>';
  var tbody = '<tbody>' + rows.map(function (row, i) {
    return '<tr class="' + (i % 2 ? 'row-alt' : '') + '">' + cols.map(function (c) {
      var v = row[c.key];
      if (Array.isArray(v)) v = v.join('; ');
      return '<td>' + esc(v) + '</td>';
    }).join('') + '</tr>';
  }).join('') + '</tbody>';
  return '<div class="table-wrap"><table class="data-table">' + thead + tbody + '</table></div>';
}

/** Section wrapper with anchor id + heading. */
function section(id, title, inner) {
  return '<section class="doc-section" id="sec-' + esc(id) + '">' +
    '<h2 class="section-title">' + esc(title) + '</h2>' + inner + '</section>';
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

function viewHome() {
  var d = App.data;
  var meta = d.meta || {};
  var dims = d.dimensions || [];
  var agents = d.agents || [];
  var audit = d.auditSummary || {};
  var totals = audit.totals || {};

  var hero =
    '<header class="hero">' +
      '<p class="hero-kicker">' + esc(meta.kicker || 'AI Agent Modeling Dataset') + '</p>' +
      '<h1>' + esc(meta.title || "Pandora's Box") + '</h1>' +
      '<p class="hero-sub">' + esc(meta.subtitle || 'Advanced distinguishable data set for AI agent modeling.') + '</p>' +
      '<div class="hero-meta">' +
        '<span class="pill">v' + esc(meta.version || '1.0') + '</span>' +
        '<span class="pill">' + esc(meta.auditDepth || '50,000x') + ' audited</span>' +
        '<span class="pill">' + esc(meta.auditDate || '') + '</span>' +
      '</div>' +
      '<div class="hero-actions">' +
        '<a class="btn btn-primary" href="#/agents">Explore agents</a>' +
        '<a class="btn" href="#/compare">Compare types</a>' +
      '</div>' +
    '</header>';

  var dimCards = dims.length
    ? '<div class="grid grid-3">' + dims.map(function (dim) {
        return '<div class="card">' +
          '<div class="dim-code">' + esc(dim.code || '') + '</div>' +
          '<h3>' + esc(dim.dimension || dim.name || '') + '</h3>' +
          '<p class="muted small">' + esc(dim.poles || '') + '</p>' +
          '<p>' + esc(dim.function || dim.description || '') + '</p></div>';
      }).join('') + '</div>'
    : '';

  var agentCards = agents.length
    ? '<div class="grid grid-3">' + agents.map(agentCard).join('') + '</div>'
    : '<p class="muted">No agent profiles in this build.</p>';

  var statItems = [
    { n: agents.length, label: 'Agent profiles' },
    { n: (d.glossary || []).length, label: 'Glossary terms' },
    { n: totals.critical != null ? totals.critical : '—', label: 'Critical findings fixed' },
    { n: visitedCount(), label: 'Sections you visited' },
  ];
  var stats = '<div class="stats-row">' + statItems.map(function (s) {
    return '<div class="stat"><div class="stat-num">' + esc(s.n) + '</div>' +
      '<div class="stat-label">' + esc(s.label) + '</div></div>';
  }).join('') + '</div>';

  return hero +
    section('dimensions', 'Dimensional Framework', dimCards) +
    section('agents', 'Agent Profiles', agentCards) +
    section('stats', 'At a Glance', stats);
}

/* ------------------------------------------------------------------ *
 *  VIEW: Agents list
 * ------------------------------------------------------------------ */

function viewAgents() {
  var agents = App.data.agents || [];
  var cards = agents.length
    ? '<div class="grid grid-3">' + agents.map(agentCard).join('') + '</div>'
    : '<p class="muted">No agent profiles in this build.</p>';
  return '<header class="page-head"><h1>Agent Profiles</h1>' +
    '<p class="muted">Three modeled archetypes from the Idealist branch. Select one for the full dossier.</p></header>' +
    cards;
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
    '<h2>Core Axes</h2><div class="grid grid-3">' + dimCards + '</div>' +
    '<h2>Type Code Taxonomy</h2><div class="table-wrap"><table class="data-table">' +
    '<thead><tr><th>Code</th><th>Name</th><th>Status</th></tr></thead><tbody>' + codeRows + '</tbody></table></div>';
}

/* ------------------------------------------------------------------ *
 *  VIEW: Agent detail (tabbed)
 * ------------------------------------------------------------------ */

function findAgent(code) {
  var agents = App.data.agents || [];
  for (var i = 0; i < agents.length; i++) {
    if ((agents[i].code || '').toUpperCase() === String(code).toUpperCase()) return agents[i];
  }
  return null;
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

  var tabsHtml = '<div class="tabs" role="tablist">' + AGENT_TABS.map(function (t) {
    var active = t.id === tab ? ' active' : '';
    return '<a role="tab" class="tab' + active + '" href="#/agent/' + esc(agent.code) +
      '?tab=' + t.id + '">' + esc(t.label) + '</a>';
  }).join('') + '</div>';

  var body = renderAgentTab(agent, tab);

  return '<header class="page-head agent-head">' +
      '<a class="back-link" href="#/agents">← All agents</a>' +
      '<div class="agent-head-row"><span class="agent-code big">' + esc(agent.code) + '</span>' +
      statusBadge(agent.status) + '</div>' +
      '<h1>' + esc(agent.name || agent.code) + '</h1>' +
      '<p class="muted">' + esc(agent.archetype || '') + '</p>' +
    '</header>' +
    tabsHtml +
    '<div class="tab-body">' + body + '</div>';
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
      return renderStates(agent.states);

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

/** Render behavioral state machine as cards (not a flat table — richer). */
function renderStates(states) {
  if (!states || !states.length) {
    return '<p class="muted empty-note">State machine not documented for this agent.</p>';
  }
  return '<div class="states-flow">' + states.map(function (s, i) {
    var behaviors = (s.behaviors || []).map(function (b) {
      return '<li>' + esc(b) + '</li>';
    }).join('');
    var internal = (s.internal || []).map(function (t) {
      return '<li class="thought">' + esc(t) + '</li>';
    }).join('');
    var exits = (s.exits || []).map(function (e) {
      return '<span class="exit-chip">' + esc(e) + '</span>';
    }).join('');
    return '<article class="state-card">' +
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

  function selector(which, current) {
    return '<label class="compare-select"><span>' + (which === 'left' ? 'Agent A' : 'Agent B') + '</span>' +
      '<select id="cmp-' + which + '">' +
      agents.map(function (a) {
        var selected = a.code === current ? ' selected' : '';
        return '<option value="' + esc(a.code) + '"' + selected + '>' +
          esc(a.code) + ' — ' + esc(a.name || '') + '</option>';
      }).join('') + '</select></label>';
  }

  var rows = compareRows(left, right);
  var tableHtml = '<div class="table-wrap"><table class="data-table compare-table"><thead><tr>' +
    '<th>Dimension</th><th>' + esc(left.code) + '</th><th>' + esc(right.code) + '</th>' +
    '</tr></thead><tbody>' +
    rows.map(function (r, i) {
      var diff = r.a !== r.b ? ' class="diff"' : '';
      return '<tr' + (i % 2 ? ' class="row-alt"' : '') + '><td><strong>' + esc(r.label) +
        '</strong></td><td' + diff + '>' + esc(r.a) + '</td><td' + diff + '>' + esc(r.b) + '</td></tr>';
    }).join('') + '</tbody></table></div>';

  var confusion = '';
  var comp = App.data.comparison || {};
  var confRisks = comp.confusionRisks || comp.pairs || [];
  if (confRisks.length) {
    confusion = '<h2>Confusion risks</h2>' + table(
      [{ key: 'pair', label: 'Pair' },
       { key: 'risk', label: 'Risk' },
       { key: 'distinguisher', label: 'Distinguisher' }],
      confRisks);
  }
  // Key distinctions (orphaned data fix)
  var distinctions = comp.distinctions || [];
  if (distinctions.length) {
    confusion += '<h2>Key distinctions</h2>' + table(
      [{ key: 'pair', label: 'Pair' },
       { key: 'text', label: 'Distinction' }],
      distinctions);
  }

  // Wire selectors after render (delegated via afterRender hook below).
  setTimeout(wireCompareSelectors, 0);

  return '<header class="page-head"><h1>Compare Agents</h1>' +
      '<p class="muted">Side-by-side dossier. Highlighted cells differ between the two types.</p></header>' +
    '<div class="compare-bar">' + selector('left', sel.left) + selector('right', sel.right) + '</div>' +
    '<div class="compare-heads">' +
      '<div class="compare-head">' + agentCard(left) + '</div>' +
      '<div class="compare-head">' + agentCard(right) + '</div>' +
    '</div>' +
    tableHtml + confusion;
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
}

/* ------------------------------------------------------------------ *
 *  VIEW: Glossary (searchable, alphabetical)
 * ------------------------------------------------------------------ */

function viewGlossary(query) {
  var terms = (App.data.glossary || []).slice();
  var q = (query || '').trim().toLowerCase();

  terms.sort(function (a, b) {
    return String(a.term || '').localeCompare(String(b.term || ''));
  });

  if (q) {
    terms = terms.filter(function (t) {
      return String(t.term || '').toLowerCase().indexOf(q) !== -1 ||
             String(t.definition || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  // Group by first letter.
  var groups = {};
  terms.forEach(function (t) {
    var letter = String(t.term || '#').charAt(0).toUpperCase() || '#';
    (groups[letter] = groups[letter] || []).push(t);
  });
  var letters = Object.keys(groups).sort();

  var listHtml = letters.length
    ? letters.map(function (L) {
        return '<h2 class="gloss-letter">' + esc(L) + '</h2><dl class="gloss-list">' +
          groups[L].map(function (t) {
            return '<div class="gloss-item"><dt>' + highlight(t.term, query) + '</dt>' +
              '<dd>' + highlight(t.definition, query) + '</dd></div>';
          }).join('') + '</dl>';
      }).join('')
    : '<p class="muted">No glossary terms match.</p>';

  return '<header class="page-head"><h1>Glossary</h1>' +
      '<p class="muted">' + terms.length + ' term' + (terms.length === 1 ? '' : 's') + ' defined.</p></header>' +
    '<div class="search-bar"><input id="glossary-q" type="search" placeholder="Filter terms…" ' +
      'value="' + esc(query || '') + '" autocomplete="off" aria-label="Filter glossary terms"></div>' +
    listHtml;
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

  function pushDoc(kind, title, text, link) {
    if (!text) return;
    docs.push({ kind: kind, title: title, text: String(text), link: link });
  }

  // Preface
  var preface = d.preface || {};
  Object.keys(preface).forEach(function (k) {
    pushDoc('Preface', 'Preface: ' + k, preface[k], '#/home');
  });

  // Dimensions
  (d.dimensions || []).forEach(function (dim) {
    pushDoc('Framework', 'Dimension: ' + (dim.dimension || dim.code),
      [dim.dimension, dim.code, dim.poles, dim.function, dim.description].join(' '), '#/home');
  });

  // Agents — every section becomes searchable docs
  (d.agents || []).forEach(function (a) {
    var base = '#/agent/' + a.code;
    pushDoc('Agent', a.code + ' ' + (a.name || ''), [a.code, a.name, a.archetype, a.status].join(' '), base);
    (a.identity || []).forEach(function (r) {
      pushDoc('Identity', a.code + ' identity: ' + r.parameter,
        [r.parameter, r.value, r.manifestation].join(' '), base + '?tab=identity');
    });
    (a.states || []).forEach(function (s) {
      pushDoc('State', a.code + ' state: ' + s.name,
        [s.name, s.trigger, (s.behaviors || []).join(' '), (s.internal || []).join(' '),
         (s.exits || []).join(' ')].join(' '), base + '?tab=states');
    });
    (a.communication || []).forEach(function (r) {
      pushDoc('Communication', a.code + ' channel: ' + r.channel,
        [r.channel, r.optimization, r.example, r.avoid].join(' '), base + '?tab=communication');
    });
    (a.escalationLadder || []).forEach(function (r) {
      pushDoc('Escalation', a.code + ' level ' + r.level + ': ' + r.name,
        [r.level, r.name, r.behaviors, r.timing, r.resistance].join(' '), base + '?tab=escalation');
    });
    (a.triggers || []).forEach(function (r) {
      pushDoc('Trigger', a.code + ' trigger: ' + r.trigger,
        [r.trigger, r.response, r.resolution].join(' '), base + '?tab=triggers');
    });
    (a.emotionalSequence || []).forEach(function (r) {
      pushDoc('Emotion', a.code + ' emotion: ' + r.emotion,
        [r.emotion, r.condition, r.manifestation].join(' '), base + '?tab=emotions');
    });
    (a.resistance || []).forEach(function (r) {
      pushDoc('Resistance', a.code + ' resistance: ' + r.type,
        [r.type, r.trigger, r.manifestation, r.strategy].join(' '), base + '?tab=resistance');
    });
    (a.maintenance || []).forEach(function (r) {
      pushDoc('Maintenance', a.code + ' maintenance: ' + r.requirement,
        [r.requirement, r.frequency, r.indicator, r.failure].join(' '), base + '?tab=maintenance');
    });
  });

  // Glossary
  (d.glossary || []).forEach(function (t) {
    pushDoc('Glossary', 'Term: ' + t.term, t.term + ' ' + t.definition, '#/glossary');
  });

  searchIndex = docs;
  return docs;
}

function viewSearch(query) {
  var q = (query || '').trim();
  var resultsHtml = '';

  if (!q) {
    resultsHtml = '<p class="muted">Type above to search every agent profile, state, trigger, ' +
      'communication channel, and glossary term. Results highlight your keywords.</p>';
  } else {
    var docs = buildSearchIndex();
    var terms = q.toLowerCase().split(/\s+/);
    var scored = [];

    docs.forEach(function (doc) {
      var hay = (doc.title + ' ' + doc.text).toLowerCase();
      var score = 0, matched = 0;
      terms.forEach(function (t) {
        if (!t) return;
        var idx = hay.indexOf(t);
        if (idx !== -1) {
          matched++;
          // Title matches weigh more; earlier matches weigh more.
          score += (doc.title.toLowerCase().indexOf(t) !== -1 ? 3 : 1) +
                   Math.max(0, 2 - idx / 200);
        }
      });
      if (matched === terms.length) scored.push({ doc: doc, score: score });
    });

    scored.sort(function (x, y) { return y.score - x.score; });
    var top = scored.slice(0, 50);

    resultsHtml = top.length
      ? '<p class="muted">' + top.length + ' result' + (top.length === 1 ? '' : 's') +
        (scored.length > 50 ? ' (top 50 shown)' : '') + ' for "' + esc(q) + '".</p>' +
        '<div class="results">' + top.map(function (r) {
          var snippet = makeSnippet(r.doc.text, q);
          return '<a class="result-card" href="' + esc(r.doc.link) + '">' +
            '<span class="result-kind">' + esc(r.doc.kind) + '</span>' +
            '<h3>' + highlight(r.doc.title, q) + '</h3>' +
            '<p>' + snippet + '</p></a>';
        }).join('') + '</div>'
      : '<p class="muted">No results for "' + esc(q) + '". Try fewer or different keywords.</p>';
  }

  return '<header class="page-head"><h1>Search</h1>' +
      '<p class="muted">Full-text search across the entire dataset.</p></header>' +
    '<div class="search-bar"><input id="search-q" type="search" placeholder="Search agents, states, triggers…" ' +
      'value="' + esc(query || '') + '" autocomplete="off" aria-label="Search the dataset"></div>' +
    resultsHtml;
}

/** Extract a ~160-char snippet around the first query hit, with highlighting. */
function makeSnippet(text, query) {
  var plain = String(text || '');
  var lower = plain.toLowerCase();
  var q = query.trim().toLowerCase().split(/\s+/)[0] || '';
  var idx = q ? lower.indexOf(q) : -1;
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
    return '<div class="stat"><div class="stat-num ' + (s.cls || '') + '">' + esc(s.n) + '</div>' +
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
 *  Boot
 * ------------------------------------------------------------------ */

function init() {
  loadProgress();
  renderShell();
  window.addEventListener('hashchange', route);
  loadData();
  wireInstallButton();

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

/** PWA install prompt wiring (M2 fix). */
var deferredPrompt = null;
function wireInstallButton() {
  var btn = document.getElementById('installBtn');
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (btn) btn.hidden = false;
  });
  if (btn) {
    btn.addEventListener('click', function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function () { deferredPrompt = null; btn.hidden = true; });
      }
    });
  }
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    if (btn) btn.hidden = true;
  });
}

// Expose minimal API for debugging / future extensions.
window.PandoraBook = {
  go: go,
  getData: function () { return App.data; },
  getProgress: function () { return App.progress; },
  version: '1.0.0',
};

document.addEventListener('DOMContentLoaded', init);
