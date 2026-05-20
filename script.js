// asktru.Roadmap — script.js
// Frontmatter-driven Gantt chart for NotePlan project notes.

var PLUGIN_ID = 'asktru.Roadmap';
var WINDOW_ID = 'asktru.Roadmap.dashboard';

// ============================================
// SETTINGS
// ============================================

function getSettings() {
  var s = DataStore.settings || {};
  var excl = (s.foldersToExclude || '@Archive, @Trash, @Templates')
    .split(',').map(function (f) { return f.trim(); }).filter(Boolean);
  return {
    foldersToExclude: excl,
    weekStart: (s.weekStart === 'Sunday') ? 'Sunday' : 'Monday',
    lastZoom: s.lastZoom || 'week',
    lastScrollDate: s.lastScrollDate || '',
  };
}

function savePrefs(patch) {
  var s = DataStore.settings || {};
  var keys = Object.keys(patch || {});
  for (var i = 0; i < keys.length; i++) s[keys[i]] = String(patch[keys[i]]);
  DataStore.settings = s;
}

// ============================================
// UTILITIES
// ============================================

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function npColor(c) {
  if (!c) return null;
  // NotePlan theme colors come as #AARRGGBB — convert to #RRGGBBAA for CSS
  if (typeof c === 'string' && c.match(/^#[0-9A-Fa-f]{8}$/)) return '#' + c.slice(3, 9) + c.slice(1, 3);
  return c;
}

function isLightTheme() {
  try {
    var theme = Editor.currentTheme;
    if (!theme) return false;
    if (theme.mode === 'light') return true;
    if (theme.mode === 'dark') return false;
  } catch (e) { }
  return false;
}

function getThemeCSS() {
  try {
    var theme = Editor.currentTheme;
    if (!theme) return '';
    var vals = theme.values || {};
    var ed = vals.editor || {};
    var parts = [];
    var bg = npColor(ed.backgroundColor);
    var altBg = npColor(ed.altBackgroundColor);
    var text = npColor(ed.textColor);
    var tint = npColor(ed.tintColor);
    if (bg) parts.push('--bg-main-color: ' + bg);
    if (altBg) parts.push('--bg-alt-color: ' + altBg);
    if (text) parts.push('--fg-main-color: ' + text);
    if (tint) parts.push('--tint-color: ' + tint);
    if (parts.length) return ':root { ' + parts.join('; ') + '; }';
  } catch (e) { }
  return '';
}

// ============================================
// DATE HELPERS
// ============================================
// All dates handled as ISO YYYY-MM-DD strings on the wire.
// Internal calculations use UTC noon to avoid DST drift.

function parseDateStr(s) {
  if (!s) return null;
  s = String(s).trim();
  var m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) {
    return { y: +m[1], m: +m[2], d: +m[3] };
  }
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) {
    return { y: +m[1], m: +m[2], d: +m[3] };
  }
  return null;
}

function toISO(p) {
  if (!p) return '';
  var mm = ('0' + p.m).slice(-2);
  var dd = ('0' + p.d).slice(-2);
  return p.y + '-' + mm + '-' + dd;
}

// ============================================
// FRONTMATTER ACCESS
// ============================================
// Prefer native API; fall back to regex parsing for resilience.

function readFrontmatter(note) {
  if (!note) return {};
  try {
    var fm = note.frontmatterAttributes;
    if (fm && typeof fm === 'object') {
      var keys = Object.keys(fm);
      if (keys.length > 0) {
        var out = {};
        for (var i = 0; i < keys.length; i++) out[keys[i]] = fm[keys[i]];
        return out;
      }
    }
  } catch (e) { }
  return parseFrontmatterFromContent(note.content || '');
}

function parseFrontmatterFromContent(content) {
  if (!content) return {};
  var lines = content.split('\n');
  if (lines[0].trim() !== '---') return {};
  var endIdx = -1;
  for (var i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { endIdx = i; break; }
  }
  if (endIdx < 0) return {};
  var fm = {};
  for (var j = 1; j < endIdx; j++) {
    var colonIdx = lines[j].indexOf(':');
    if (colonIdx < 0) continue;
    var key = lines[j].substring(0, colonIdx).trim();
    var val = lines[j].substring(colonIdx + 1).trim();
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.substring(1, val.length - 1);
    }
    fm[key] = val;
  }
  return fm;
}

function writeFrontmatterPatch(note, patch) {
  if (!note) return false;
  var entries = [];
  var deletions = [];
  var keys = Object.keys(patch || {});
  for (var i = 0; i < keys.length; i++) {
    var v = patch[keys[i]];
    if (v == null || v === '') {
      deletions.push(keys[i]);
    } else {
      entries.push({ key: keys[i], value: String(v) });
    }
  }

  // Try native batched update first (v3.18.1+)
  try {
    if (entries.length > 0 && typeof note.updateFrontmatterAttributes === 'function') {
      note.updateFrontmatterAttributes(entries);
    }
  } catch (e) {
    console.log('Roadmap: updateFrontmatterAttributes threw: ' + e);
  }

  // For deletions and as a fallback for older NotePlan, edit content directly
  if (deletions.length > 0) {
    var content = note.content || '';
    for (var d = 0; d < deletions.length; d++) {
      content = removeFrontmatterKey(content, deletions[d]);
    }
    note.content = content;
  }

  // Re-verify via fallback if entries didn't stick (older NotePlan)
  try {
    var fm = readFrontmatter(note);
    var needsFallback = false;
    for (var k = 0; k < entries.length; k++) {
      if (String(fm[entries[k].key]) !== String(entries[k].value)) {
        needsFallback = true; break;
      }
    }
    if (needsFallback) {
      var c2 = note.content || '';
      for (var e2 = 0; e2 < entries.length; e2++) {
        c2 = setFrontmatterKeyInContent(c2, entries[e2].key, entries[e2].value);
      }
      note.content = c2;
    }
  } catch (e) { }

  try { DataStore.updateCache(note, true); } catch (e) { }
  return true;
}

function setFrontmatterKeyInContent(content, key, value) {
  var lines = (content || '').split('\n');
  if (lines[0] && lines[0].trim() === '---') {
    var endIdx = -1;
    for (var i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { endIdx = i; break; }
    }
    if (endIdx > 0) {
      var rx = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:');
      var found = false;
      for (var j = 1; j < endIdx; j++) {
        if (rx.test(lines[j])) { lines[j] = key + ': ' + value; found = true; break; }
      }
      if (!found) lines.splice(endIdx, 0, key + ': ' + value);
      return lines.join('\n');
    }
  }
  lines.unshift('---', key + ': ' + value, '---');
  return lines.join('\n');
}

function removeFrontmatterKey(content, key) {
  var lines = (content || '').split('\n');
  if (!lines[0] || lines[0].trim() !== '---') return content;
  var endIdx = -1;
  for (var i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { endIdx = i; break; }
  }
  if (endIdx < 0) return content;
  var rx = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:');
  for (var j = 1; j < endIdx; j++) {
    if (rx.test(lines[j])) { lines.splice(j, 1); endIdx--; break; }
  }
  // Strip an empty frontmatter block
  var has = false;
  for (var k = 1; k < endIdx; k++) {
    if (lines[k].trim() !== '') { has = true; break; }
  }
  if (!has) {
    lines.splice(0, endIdx + 1);
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  }
  return lines.join('\n');
}

// ============================================
// PROGRESS CALCULATION
// ============================================
// Explicit `progress:` wins. Otherwise count done / (done + open + scheduled),
// ignoring cancelled. Checklist items count the same as tasks.

function computeProgress(note, fm) {
  if (fm.progress != null && fm.progress !== '') {
    var p = parseFloat(String(fm.progress).replace('%', ''));
    if (!isNaN(p)) return Math.max(0, Math.min(100, p));
  }
  try {
    var ps = note.paragraphs || [];
    var done = 0, active = 0;
    for (var i = 0; i < ps.length; i++) {
      var t = ps[i].type;
      if (t === 'done' || t === 'checklistDone') done++;
      else if (t === 'open' || t === 'scheduled' || t === 'checklist' || t === 'checklistScheduled') active++;
      // cancelled / checklistCancelled: ignored
    }
    var total = done + active;
    if (total === 0) return null;
    return Math.round((done / total) * 100);
  } catch (e) { }
  return null;
}

// ============================================
// ROADMAP DATA COLLECTION
// ============================================

function isExcluded(filename, excluded) {
  if (!filename) return false;
  for (var i = 0; i < excluded.length; i++) {
    if (filename.indexOf(excluded[i] + '/') === 0) return true;
  }
  return false;
}

function collectRoadmapItems() {
  var cfg = getSettings();
  var notes = DataStore.projectNotes || [];
  var items = [];
  var idToItem = {};

  for (var i = 0; i < notes.length; i++) {
    var note = notes[i];
    var content = note.content || '';
    // Cheap pre-filter to avoid parsing every note's frontmatter
    if (content.indexOf('roadmap:') < 0 && content.indexOf('roadmap ') < 0) continue;
    if (isExcluded(note.filename, cfg.foldersToExclude)) continue;

    var fm = readFrontmatter(note);
    var idRaw = fm.roadmap;
    if (idRaw == null || idRaw === '' || idRaw === 'false') continue;

    // Allow `roadmap: true` to auto-derive identifier from title
    var id = String(idRaw).trim();
    if (id === 'true') id = (note.title || note.filename.replace(/\.[^.]+$/, '')).trim();
    if (!id) continue;

    var title = note.title || id;
    var start = toISO(parseDateStr(fm.start));
    var end = toISO(parseDateStr(fm.end));
    var due = toISO(parseDateStr(fm.due));
    var defer = toISO(parseDateStr(fm.defer));
    var prereqs = String(fm.prerequisites || '')
      .split(',').map(function (s) { return s.trim(); }).filter(Boolean);

    var progress = computeProgress(note, fm);

    var item = {
      id: id,
      filename: note.filename,
      title: title,
      start: start || '',
      end: end || '',
      due: due || '',
      defer: defer || '',
      progress: progress, // number 0-100 or null
      progressExplicit: fm.progress != null && fm.progress !== '',
      prerequisites: prereqs,
      hasStart: !!start, hasEnd: !!end, hasDue: !!due, hasDefer: !!defer,
    };

    // Resolve conflicts: if a duplicate id already exists, keep the first and warn
    if (idToItem[id]) {
      item.duplicate = true;
    } else {
      idToItem[id] = item;
    }
    items.push(item);
  }

  // Sort: by earliest available date (start, defer, end, due), then by title
  items.sort(function (a, b) {
    var ad = a.start || a.defer || a.end || a.due || '￿';
    var bd = b.start || b.defer || b.end || b.due || '￿';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return (a.title || '').localeCompare(b.title || '');
  });

  return { items: items, weekStart: cfg.weekStart, zoom: cfg.lastZoom, scrollDate: cfg.lastScrollDate };
}

function findNoteByRoadmapId(id) {
  var notes = DataStore.projectNotes || [];
  for (var i = 0; i < notes.length; i++) {
    var content = notes[i].content || '';
    if (content.indexOf('roadmap:') < 0) continue;
    var fm = readFrontmatter(notes[i]);
    var raw = fm.roadmap;
    if (raw == null) continue;
    var got = String(raw).trim();
    if (got === 'true') got = (notes[i].title || '').trim();
    if (got === id) return notes[i];
  }
  return null;
}

function findNoteByFilename(filename) {
  var notes = DataStore.projectNotes || [];
  for (var i = 0; i < notes.length; i++) {
    if (notes[i].filename === filename) return notes[i];
  }
  return null;
}

// ============================================
// CSS
// ============================================

function getInlineCSS() {
  return '\n' +
    ':root, [data-theme="dark"] {\n' +
    '  --rm-bg: var(--bg-main-color, #0f172a);\n' +
    '  --rm-bg-card: var(--bg-alt-color, #1e293b);\n' +
    '  --rm-bg-elevated: color-mix(in srgb, var(--rm-bg-card) 80%, white 20%);\n' +
    '  --rm-text: var(--fg-main-color, #e2e8f0);\n' +
    '  --rm-text-muted: color-mix(in srgb, var(--rm-text) 60%, transparent);\n' +
    '  --rm-text-faint: color-mix(in srgb, var(--rm-text) 38%, transparent);\n' +
    '  --rm-accent: var(--tint-color, #0EA5E9);\n' +
    '  --rm-accent-soft: color-mix(in srgb, var(--rm-accent) 18%, transparent);\n' +
    '  --rm-border: color-mix(in srgb, var(--rm-text) 12%, transparent);\n' +
    '  --rm-border-strong: color-mix(in srgb, var(--rm-text) 22%, transparent);\n' +
    '  --rm-bar-fill: color-mix(in srgb, var(--rm-accent) 35%, var(--rm-bg-card));\n' +
    '  --rm-bar-stroke: var(--rm-accent);\n' +
    '  --rm-bar-progress: var(--rm-accent);\n' +
    '  --rm-weekend: color-mix(in srgb, var(--rm-text) 5%, transparent);\n' +
    '  --rm-today: color-mix(in srgb, var(--rm-accent) 35%, transparent);\n' +
    '  --rm-danger: #EF4444;\n' +
    '  --rm-warn: #F59E0B;\n' +
    '  --rm-ok: #10B981;\n' +
    '  --rm-row-h: 36px;\n' +
    '  --rm-sidebar-w: 240px;\n' +
    '}\n' +
    '[data-theme="light"] {\n' +
    '  --rm-bg-elevated: color-mix(in srgb, var(--rm-bg-card) 92%, black 8%);\n' +
    '  --rm-text-muted: color-mix(in srgb, var(--rm-text) 60%, transparent);\n' +
    '  --rm-weekend: color-mix(in srgb, black 5%, transparent);\n' +
    '}\n' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }\n' +
    'body { font-family: -apple-system, system-ui, sans-serif; background: var(--rm-bg); color: var(--rm-text); font-size: 13px; height: 100vh; overflow: hidden; }\n' +
    '.rm-app { display: flex; flex-direction: column; height: 100vh; }\n' +

    /* TOOLBAR */
    '.rm-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--rm-border); flex-shrink: 0; }\n' +
    '.rm-toolbar-title { font-weight: 700; font-size: 13px; color: var(--rm-text); margin-right: auto; display: flex; align-items: center; gap: 8px; }\n' +
    '.rm-toolbar-title i { color: var(--rm-accent); }\n' +
    '.rm-zoom-btns { display: inline-flex; background: var(--rm-bg-card); border-radius: 100px; padding: 2px; }\n' +
    '.rm-zoom-btn { padding: 4px 12px; font-size: 11px; font-weight: 600; border: none; background: transparent; color: var(--rm-text-muted); cursor: pointer; border-radius: 100px; }\n' +
    '.rm-zoom-btn:hover { color: var(--rm-text); }\n' +
    '.rm-zoom-btn.active { background: var(--rm-accent); color: white; }\n' +
    '.rm-icon-btn { width: 30px; height: 30px; border-radius: 6px; border: 1px solid var(--rm-border); background: transparent; color: var(--rm-text-muted); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; }\n' +
    '.rm-icon-btn:hover { background: var(--rm-bg-card); color: var(--rm-text); }\n' +
    '.rm-text-btn { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--rm-border); background: transparent; color: var(--rm-text-muted); cursor: pointer; font-size: 12px; font-weight: 500; }\n' +
    '.rm-text-btn:hover { background: var(--rm-bg-card); color: var(--rm-text); }\n' +

    /* MAIN LAYOUT */
    '.rm-main { flex: 1; display: flex; overflow: hidden; min-height: 0; }\n' +
    '.rm-sidebar { width: var(--rm-sidebar-w); flex-shrink: 0; background: var(--rm-bg-card); border-right: 1px solid var(--rm-border); display: flex; flex-direction: column; overflow: hidden; }\n' +
    '.rm-sidebar-header { padding: 0; border-bottom: 1px solid var(--rm-border); flex-shrink: 0; display: flex; align-items: center; height: 56px; padding: 0 12px; }\n' +
    '.rm-sidebar-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--rm-text-faint); }\n' +
    '.rm-sidebar-rows { flex: 1; overflow-y: auto; overflow-x: hidden; }\n' +
    '.rm-sidebar-row { display: flex; align-items: center; gap: 8px; height: var(--rm-row-h); padding: 0 12px; border-bottom: 1px solid var(--rm-border); cursor: pointer; }\n' +
    '.rm-sidebar-row:hover { background: var(--rm-bg-elevated); }\n' +
    '.rm-sidebar-row.highlight { background: var(--rm-accent-soft); }\n' +
    '.rm-sidebar-row-title { flex: 1; font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
    '.rm-sidebar-row-progress { font-size: 10px; color: var(--rm-text-faint); font-variant-numeric: tabular-nums; }\n' +
    '.rm-sidebar-row.warn .rm-sidebar-row-title { color: var(--rm-warn); }\n' +
    '.rm-sidebar-row.danger .rm-sidebar-row-title { color: var(--rm-danger); }\n' +
    '.rm-sidebar-empty { padding: 24px 16px; text-align: center; color: var(--rm-text-faint); font-size: 12px; line-height: 1.6; }\n' +
    '.rm-sidebar-empty code { background: var(--rm-bg-elevated); padding: 2px 5px; border-radius: 3px; font-size: 11px; }\n' +

    /* CANVAS */
    '.rm-canvas-wrap { flex: 1; overflow: auto; position: relative; }\n' +
    '.rm-canvas { position: relative; min-width: 100%; }\n' +
    '.rm-header { position: sticky; top: 0; z-index: 5; background: var(--rm-bg); border-bottom: 1px solid var(--rm-border); height: 56px; }\n' +
    '.rm-header-row { position: absolute; left: 0; right: 0; height: 28px; display: flex; }\n' +
    '.rm-header-row.major { top: 0; }\n' +
    '.rm-header-row.minor { top: 28px; }\n' +
    '.rm-header-cell { border-right: 1px solid var(--rm-border); display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--rm-text-muted); font-weight: 500; overflow: hidden; white-space: nowrap; }\n' +
    '.rm-header-cell.major { font-weight: 700; color: var(--rm-text); font-size: 12px; }\n' +
    '.rm-header-cell.weekend { color: var(--rm-text-faint); background: var(--rm-weekend); }\n' +
    '.rm-header-cell.today { color: var(--rm-accent); font-weight: 700; }\n' +

    /* BODY (shared coordinate space below header) */
    '.rm-body { position: relative; }\n' +
    /* GRID */
    '.rm-grid { position: absolute; inset: 0; pointer-events: none; }\n' +
    '.rm-grid-col { position: absolute; top: 0; bottom: 0; border-right: 1px solid var(--rm-border); }\n' +
    '.rm-grid-col.weekend { background: var(--rm-weekend); }\n' +
    '.rm-grid-col.major { border-right: 1px solid var(--rm-border-strong); }\n' +
    '.rm-today-line { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--rm-today); z-index: 2; pointer-events: none; }\n' +

    /* ROWS + BARS */
    '.rm-rows { position: absolute; inset: 0; }\n' +
    '.rm-row { position: absolute; left: 0; right: 0; height: var(--rm-row-h); border-bottom: 1px solid var(--rm-border); }\n' +
    '.rm-row:hover { background: color-mix(in srgb, var(--rm-text) 3%, transparent); }\n' +
    '.rm-bar { position: absolute; top: 6px; height: calc(var(--rm-row-h) - 12px); border-radius: 5px; cursor: grab; user-select: none; background: var(--rm-bar-fill); border: 1.5px solid var(--rm-bar-stroke); overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.15); }\n' +
    '.rm-bar.dragging { cursor: grabbing; opacity: 0.85; box-shadow: 0 4px 10px rgba(0,0,0,0.3); }\n' +
    '.rm-bar.deferred { border-style: dashed; opacity: 0.7; }\n' +
    '.rm-bar.overdue { border-color: var(--rm-danger); }\n' +
    '.rm-bar.complete { background: color-mix(in srgb, var(--rm-ok) 30%, var(--rm-bg-card)); border-color: var(--rm-ok); }\n' +
    '.rm-bar.placeholder { border-style: dotted; background: transparent; opacity: 0.55; }\n' +
    '.rm-bar-progress { position: absolute; left: 0; top: 0; bottom: 0; background: var(--rm-bar-progress); opacity: 0.55; pointer-events: none; }\n' +
    '.rm-bar-label { position: absolute; left: 6px; right: 22px; top: 0; bottom: 0; display: flex; align-items: center; font-size: 11px; font-weight: 600; color: var(--rm-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; mix-blend-mode: normal; text-shadow: 0 1px 0 rgba(0,0,0,0.25); }\n' +
    '[data-theme="light"] .rm-bar-label { text-shadow: 0 1px 0 rgba(255,255,255,0.5); }\n' +
    '.rm-bar-handle { position: absolute; top: 0; bottom: 0; width: 6px; cursor: ew-resize; }\n' +
    '.rm-bar-handle.left { left: 0; border-radius: 5px 0 0 5px; }\n' +
    '.rm-bar-handle.right { right: 0; border-radius: 0 5px 5px 0; }\n' +
    '.rm-bar:hover .rm-bar-handle { background: color-mix(in srgb, var(--rm-bar-stroke) 60%, transparent); }\n' +
    '.rm-bar-link-dot { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 10px; height: 10px; border-radius: 50%; background: var(--rm-bar-stroke); cursor: crosshair; opacity: 0; transition: opacity 0.15s; border: 1.5px solid var(--rm-bg-card); }\n' +
    '.rm-bar:hover .rm-bar-link-dot { opacity: 1; }\n' +
    '.rm-bar-link-dot:hover { transform: translateY(-50%) scale(1.4); }\n' +

    /* MARKERS */
    '.rm-marker { position: absolute; top: 4px; height: calc(var(--rm-row-h) - 8px); pointer-events: none; z-index: 3; }\n' +
    '.rm-marker.due { width: 2px; background: var(--rm-danger); }\n' +
    '.rm-marker.due::before { content: ""; position: absolute; top: -2px; left: -4px; width: 10px; height: 10px; background: var(--rm-danger); clip-path: polygon(50% 0, 100% 100%, 0 100%); }\n' +
    '.rm-marker.defer { width: 2px; background: var(--rm-warn); opacity: 0.7; border-left: 2px dashed var(--rm-warn); background: transparent; }\n' +

    /* DEPENDENCY ARROWS */
    '.rm-deps-svg { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: 4; overflow: visible; }\n' +
    '.rm-dep-path { fill: none; stroke: var(--rm-text-muted); stroke-width: 1.5; pointer-events: stroke; cursor: pointer; }\n' +
    '.rm-dep-path:hover { stroke: var(--rm-danger); stroke-width: 2; }\n' +
    '.rm-dep-path.broken { stroke: var(--rm-danger); stroke-dasharray: 4 3; }\n' +
    '.rm-dep-arrow { fill: var(--rm-text-muted); }\n' +
    '.rm-dep-path:hover + .rm-dep-arrow { fill: var(--rm-danger); }\n' +
    '.rm-deps-svg .rm-dep-group { pointer-events: auto; }\n' +
    '.rm-drag-line { stroke: var(--rm-accent); stroke-width: 2; stroke-dasharray: 5 4; fill: none; pointer-events: none; }\n' +

    /* TOOLTIP */
    '.rm-tooltip { position: fixed; pointer-events: none; background: var(--rm-bg-elevated); color: var(--rm-text); border: 1px solid var(--rm-border-strong); border-radius: 6px; padding: 8px 10px; font-size: 11px; line-height: 1.5; z-index: 100; box-shadow: 0 6px 18px rgba(0,0,0,0.35); opacity: 0; transition: opacity 0.12s; max-width: 280px; }\n' +
    '.rm-tooltip.show { opacity: 1; }\n' +
    '.rm-tooltip-title { font-weight: 700; margin-bottom: 4px; }\n' +
    '.rm-tooltip-row { display: flex; gap: 8px; }\n' +
    '.rm-tooltip-row .k { color: var(--rm-text-faint); min-width: 60px; }\n' +
    '.rm-tooltip-row .v { color: var(--rm-text); font-variant-numeric: tabular-nums; }\n' +

    /* TOAST */
    '.rm-toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(60px); padding: 10px 18px; border-radius: 8px; background: var(--rm-bg-elevated); color: var(--rm-text); border: 1px solid var(--rm-border-strong); font-size: 12px; opacity: 0; transition: all 0.25s; z-index: 200; pointer-events: none; box-shadow: 0 6px 18px rgba(0,0,0,0.35); }\n' +
    '.rm-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }\n' +

    /* EMPTY STATE */
    '.rm-empty-canvas { padding: 40px; text-align: center; color: var(--rm-text-muted); font-size: 13px; line-height: 1.7; }\n' +
    '.rm-empty-canvas h2 { font-size: 16px; margin-bottom: 12px; color: var(--rm-text); }\n' +
    '.rm-empty-canvas code { background: var(--rm-bg-card); padding: 2px 6px; border-radius: 4px; font-size: 12px; color: var(--rm-accent); }\n' +
    '.rm-empty-canvas pre { background: var(--rm-bg-card); padding: 12px; border-radius: 8px; text-align: left; margin: 12px auto; max-width: 360px; font-size: 11px; line-height: 1.55; overflow: auto; }\n' +

    /* MOBILE */
    '@media (max-width: 700px) { .rm-sidebar { width: 180px; } }\n';
}

// ============================================
// HTML BUILDERS
// ============================================

function buildToolbar(zoom) {
  var html = '<div class="rm-toolbar">';
  html += '<div class="rm-toolbar-title"><i class="fa-solid fa-chart-gantt"></i><span>Roadmap</span></div>';
  html += '<div class="rm-zoom-btns" id="rmZoomBtns">';
  var zooms = [
    { k: 'day', label: 'Day' },
    { k: 'week', label: 'Week' },
    { k: 'month', label: 'Month' },
    { k: 'quarter', label: 'Quarter' },
  ];
  for (var i = 0; i < zooms.length; i++) {
    var active = zooms[i].k === zoom ? ' active' : '';
    html += '<button class="rm-zoom-btn' + active + '" data-zoom="' + zooms[i].k + '">' + zooms[i].label + '</button>';
  }
  html += '</div>';
  html += '<button class="rm-text-btn" id="rmTodayBtn"><i class="fa-solid fa-crosshairs"></i> Today</button>';
  html += '<button class="rm-icon-btn" id="rmRefreshBtn" title="Refresh"><i class="fa-solid fa-arrows-rotate"></i></button>';
  html += '</div>';
  return html;
}

function buildSidebar(items) {
  var html = '<aside class="rm-sidebar">';
  html += '<div class="rm-sidebar-header"><span class="rm-sidebar-title">Project</span></div>';
  html += '<div class="rm-sidebar-rows" id="rmSidebarRows">';
  if (items.length === 0) {
    html += '<div class="rm-sidebar-empty">No roadmap items yet.<br><br>Add <code>roadmap: my-id</code> to a note\'s frontmatter, plus optional <code>start</code>, <code>end</code>, <code>due</code>, <code>defer</code>, <code>progress</code>, <code>prerequisites</code>.</div>';
  } else {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var pTxt = (it.progress == null) ? '—' : (it.progress + '%');
      html += '<div class="rm-sidebar-row" data-roadmap-id="' + esc(it.id) + '" data-filename="' + esc(it.filename) + '" title="' + esc(it.title) + '">';
      html += '<div class="rm-sidebar-row-title">' + esc(it.title) + '</div>';
      html += '<div class="rm-sidebar-row-progress">' + esc(pTxt) + '</div>';
      html += '</div>';
    }
  }
  html += '</div></aside>';
  return html;
}

function buildCanvas(items) {
  var html = '<div class="rm-canvas-wrap" id="rmCanvasWrap">';
  if (items.length === 0) {
    html += '<div class="rm-empty-canvas">';
    html += '<h2>No roadmap items found</h2>';
    html += '<p>Add the following frontmatter to any project note:</p>';
    html += '<pre>---\n' +
      'title: Migration to Postgres\n' +
      'roadmap: pg-migration\n' +
      'start: 2026-06-01\n' +
      'end: 2026-08-15\n' +
      'due: 2026-08-31\n' +
      'defer: 2026-05-25\n' +
      'progress: 25\n' +
      'prerequisites: schema-design, infra-prep\n' +
      '---</pre>';
    html += '<p>Or run the <code>/Add or remove note from roadmap</code> command.</p>';
    html += '</div>';
  } else {
    html += '<div class="rm-canvas" id="rmCanvas">';
    html += '<div class="rm-header" id="rmHeader"></div>';
    html += '<div class="rm-body" id="rmBody">';
    html += '<div class="rm-grid" id="rmGrid"></div>';
    html += '<div class="rm-rows" id="rmRows"></div>';
    html += '<svg class="rm-deps-svg" id="rmDepsSVG"></svg>';
    html += '</div>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function buildFullHTML(toolbarHTML, sidebarHTML, canvasHTML, dataJSON) {
  var themeCSS = getThemeCSS();
  var pluginCSS = getInlineCSS();
  var themeAttr = isLightTheme() ? 'light' : 'dark';
  var faLinks = '\n    <link href="../np.Shared/fontawesome.css" rel="stylesheet">\n' +
    '    <link href="../np.Shared/regular.min.flat4NP.css" rel="stylesheet">\n' +
    '    <link href="../np.Shared/solid.min.flat4NP.css" rel="stylesheet">\n';

  return '<!DOCTYPE html>\n<html data-theme="' + themeAttr + '">\n<head>\n' +
    '  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '  <title>Roadmap</title>\n' + faLinks +
    '  <style>' + themeCSS + '\n' + pluginCSS + '</style>\n' +
    '</head>\n<body>\n' +
    '  <div class="rm-app">\n' + toolbarHTML +
    '    <div class="rm-main">' + sidebarHTML + canvasHTML + '</div>\n' +
    '  </div>\n' +
    '  <div class="rm-tooltip" id="rmTooltip"></div>\n' +
    '  <div class="rm-toast" id="rmToast"></div>\n' +
    '  <script>var receivingPluginID="asktru.Roadmap";\nvar ROADMAP_DATA=' + dataJSON + ';\n<\/script>\n' +
    '  <script type="text/javascript" src="roadmapEvents.js"><\/script>\n' +
    '  <script type="text/javascript" src="../np.Shared/pluginToHTMLCommsBridge.js"><\/script>\n' +
    '</body>\n</html>';
}

// ============================================
// MAIN ENTRY
// ============================================

async function showRoadmap() {
  try {
    CommandBar.showLoading(true, 'Building roadmap…');
    await CommandBar.onAsyncThread();

    var data = collectRoadmapItems();
    var dataJSON = JSON.stringify(data);

    var toolbar = buildToolbar(data.zoom);
    var sidebar = buildSidebar(data.items);
    var canvas = buildCanvas(data.items);
    var fullHTML = buildFullHTML(toolbar, sidebar, canvas, dataJSON);

    await CommandBar.onMainThread();
    CommandBar.showLoading(false);

    var winOptions = {
      customId: WINDOW_ID,
      id: WINDOW_ID,
      savedFilename: '../../asktru.Roadmap/roadmap.html',
      shouldFocus: true,
      reuseUsersWindowRect: true,
      headerBGColor: 'transparent',
      autoTopPadding: true,
      showReloadButton: true,
      reloadPluginID: PLUGIN_ID,
      reloadCommandName: 'Roadmap',
      icon: 'fa-chart-gantt',
      iconColor: '#0EA5E9',
    };

    var result = null;
    try {
      result = await HTMLView.showInMainWindow(fullHTML, 'Roadmap', winOptions);
    } catch (e) {
      console.log('Roadmap: showInMainWindow threw: ' + e);
    }
    if (!result || !result.success) {
      try { await HTMLView.showWindowWithOptions(fullHTML, 'Roadmap', winOptions); }
      catch (e2) { console.log('Roadmap: showWindowWithOptions threw: ' + e2); }
    }
  } catch (err) {
    CommandBar.showLoading(false);
    console.log('Roadmap error: ' + String(err));
  }
}

async function refreshRoadmap() { await showRoadmap(); }

// ============================================
// HTML → PLUGIN MESSAGES
// ============================================

async function sendToHTMLWindow(windowId, type, data) {
  try {
    if (typeof HTMLView === 'undefined' || typeof HTMLView.runJavaScript !== 'function') return;
    var payload = {};
    var keys = Object.keys(data || {});
    for (var k = 0; k < keys.length; k++) payload[keys[k]] = data[keys[k]];
    payload.NPWindowID = windowId;
    var s = JSON.stringify(payload);
    var ds = JSON.stringify(s);
    await HTMLView.runJavaScript(
      '(function(){try{var p=JSON.parse(' + ds + ');window.postMessage({type:"' + type + '",payload:p},"*")}catch(e){}})();',
      windowId);
  } catch (err) { }
}

async function pushRefresh() {
  var data = collectRoadmapItems();
  await sendToHTMLWindow(WINDOW_ID, 'ROADMAP_DATA', { data: data });
}

async function onMessageFromHTMLView(actionType, data) {
  try {
    var msg = (typeof data === 'string') ? JSON.parse(data) : (data || {});

    switch (actionType) {
      case 'openNote':
        if (msg.filename || msg.title) {
          await CommandBar.onMainThread();
          if (msg.filename) {
            NotePlan.openURL('noteplan://x-callback-url/openNote?filename=' + encodeURIComponent(msg.filename) + '&splitView=yes&reuseSplitView=yes');
          } else {
            NotePlan.openURL('noteplan://x-callback-url/openNote?noteTitle=' + encodeURIComponent(msg.title) + '&splitView=yes&reuseSplitView=yes');
          }
        }
        break;

      case 'updateDates': {
        // msg: { id, start?, end?, due?, defer? }  empty string = clear
        var note = findNoteByRoadmapId(msg.id);
        if (!note) break;
        var patch = {};
        if (msg.start !== undefined) patch.start = msg.start;
        if (msg.end !== undefined) patch.end = msg.end;
        if (msg.due !== undefined) patch.due = msg.due;
        if (msg.defer !== undefined) patch.defer = msg.defer;
        writeFrontmatterPatch(note, patch);
        await pushRefresh();
        break;
      }

      case 'updateProgress': {
        var note2 = findNoteByRoadmapId(msg.id);
        if (!note2) break;
        var v = msg.progress;
        if (v === '' || v == null) writeFrontmatterPatch(note2, { progress: '' });
        else {
          var n = parseInt(v, 10);
          if (!isNaN(n)) writeFrontmatterPatch(note2, { progress: String(Math.max(0, Math.min(100, n))) });
        }
        await pushRefresh();
        break;
      }

      case 'addPrerequisite': {
        // msg: { id, prerequisite }
        var noteA = findNoteByRoadmapId(msg.id);
        if (!noteA) break;
        var fmA = readFrontmatter(noteA);
        var list = String(fmA.prerequisites || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        if (list.indexOf(msg.prerequisite) < 0 && msg.prerequisite !== msg.id) {
          list.push(msg.prerequisite);
          writeFrontmatterPatch(noteA, { prerequisites: list.join(', ') });
        }
        await pushRefresh();
        break;
      }

      case 'removePrerequisite': {
        var noteR = findNoteByRoadmapId(msg.id);
        if (!noteR) break;
        var fmR = readFrontmatter(noteR);
        var listR = String(fmR.prerequisites || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        var newR = [];
        for (var i = 0; i < listR.length; i++) if (listR[i] !== msg.prerequisite) newR.push(listR[i]);
        writeFrontmatterPatch(noteR, { prerequisites: newR.length ? newR.join(', ') : '' });
        await pushRefresh();
        break;
      }

      case 'savePrefs':
        savePrefs(msg);
        break;

      case 'requestRefresh':
        await pushRefresh();
        break;

      default:
        console.log('Roadmap: unknown action: ' + actionType);
    }
  } catch (err) {
    console.log('Roadmap onMessage error: ' + String(err));
  }
}

// ============================================
// SLASH COMMANDS
// ============================================

async function toggleRoadmapCommand() {
  var note = Editor.note;
  if (!note) { await CommandBar.prompt('No note open', 'Open a project note first.'); return; }
  var fm = readFrontmatter(note);
  if (fm.roadmap != null && fm.roadmap !== '' && fm.roadmap !== 'false') {
    // Remove
    note.content = removeFrontmatterKey(note.content || '', 'roadmap');
    try { DataStore.updateCache(note, true); } catch (e) { }
    await CommandBar.prompt('Removed from Roadmap', 'The `roadmap:` key has been removed from this note.');
    return;
  }
  // Add — derive an id from title; lower-case, slug-like
  var title = note.title || (note.filename || '').replace(/\.[^.]+$/, '');
  var slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) slug = 'roadmap-item-' + Date.now();
  // Ensure unique
  var existing = collectRoadmapItems().items;
  var taken = {};
  for (var i = 0; i < existing.length; i++) taken[existing[i].id] = true;
  var unique = slug, n = 2;
  while (taken[unique]) { unique = slug + '-' + n; n++; }

  writeFrontmatterPatch(note, { roadmap: unique });
  await showRoadmap();
}

// ============================================
// EXPORTS
// ============================================

globalThis.showRoadmap = showRoadmap;
globalThis.refreshRoadmap = refreshRoadmap;
globalThis.onMessageFromHTMLView = onMessageFromHTMLView;
globalThis.toggleRoadmapCommand = toggleRoadmapCommand;
