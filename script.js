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
  var collapsed = [];
  try { collapsed = JSON.parse(s.collapsedIds || '[]') || []; } catch (e) { collapsed = []; }
  var sidebarW = parseInt(s.sidebarWidth, 10);
  if (isNaN(sidebarW) || sidebarW < 140 || sidebarW > 800) sidebarW = 240;
  return {
    foldersToExclude: excl,
    weekStart: (s.weekStart === 'Sunday') ? 'Sunday' : 'Monday',
    lastZoom: s.lastZoom || 'week',
    lastScrollDate: s.lastScrollDate || '',
    collapsedIds: collapsed,
    showCompletedTasks: s.showCompletedTasks === 'true',
    sidebarWidth: sidebarW,
  };
}

function savePrefs(patch) {
  try {
    if (typeof DataStore === 'undefined') { console.log('Roadmap: savePrefs skipped — DataStore undefined'); return; }
    var s = DataStore.settings || {};
    var keys = Object.keys(patch || {});
    for (var i = 0; i < keys.length; i++) s[keys[i]] = String(patch[keys[i]]);
    DataStore.settings = s;
  } catch (e) {
    console.log('Roadmap: savePrefs error: ' + e + ' patch=' + JSON.stringify(patch || {}));
  }
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
  // Always merge by editing content directly. The native
  // `note.updateFrontmatterAttributes` was observed to REPLACE the entire
  // frontmatter block (wiping unrelated keys like `roadmap`), so we avoid it.
  if (!note) return false;
  var content = note.content || '';
  var keys = Object.keys(patch || {});
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = patch[k];
    if (v == null || v === '') {
      content = removeFrontmatterKey(content, k);
    } else {
      content = setFrontmatterKeyInContent(content, k, String(v));
    }
  }
  if (content !== note.content) note.content = content;
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

// ============================================
// COLOR RESOLUTION (Tailwind palette + hex)
// ============================================
// Users can set `icon-color: amber-500` or `icon-color: "#fbbf24"` on a note.
// We accept either Tailwind v3 names (color-shade) or arbitrary hex.

var TW_SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
var TW_ROWS = [
  ['red', 'fef2f2,fee2e2,fecaca,fca5a5,f87171,ef4444,dc2626,b91c1c,991b1b,7f1d1d,450a0a'],
  ['orange', 'fff7ed,ffedd5,fed7aa,fdba74,fb923c,f97316,ea580c,c2410c,9a3412,7c2d12,431407'],
  ['amber', 'fffbeb,fef3c7,fde68a,fcd34d,fbbf24,f59e0b,d97706,b45309,92400e,78350f,451a03'],
  ['yellow', 'fefce8,fef9c3,fef08a,fde047,facc15,eab308,ca8a04,a16207,854d0e,713f12,422006'],
  ['lime', 'f7fee7,ecfccb,d9f99d,bef264,a3e635,84cc16,65a30d,4d7c0f,3f6212,365314,1a2e05'],
  ['green', 'f0fdf4,dcfce7,bbf7d0,86efac,4ade80,22c55e,16a34a,15803d,166534,14532d,052e16'],
  ['emerald', 'ecfdf5,d1fae5,a7f3d0,6ee7b7,34d399,10b981,059669,047857,065f46,064e3b,022c22'],
  ['teal', 'f0fdfa,ccfbf1,99f6e4,5eead4,2dd4bf,14b8a6,0d9488,0f766e,115e59,134e4a,042f2e'],
  ['cyan', 'ecfeff,cffafe,a5f3fc,67e8f9,22d3ee,06b6d4,0891b2,0e7490,155e75,164e63,083344'],
  ['sky', 'f0f9ff,e0f2fe,bae6fd,7dd3fc,38bdf8,0ea5e9,0284c7,0369a1,075985,0c4a6e,082f49'],
  ['blue', 'eff6ff,dbeafe,bfdbfe,93c5fd,60a5fa,3b82f6,2563eb,1d4ed8,1e40af,1e3a8a,172554'],
  ['indigo', 'eef2ff,e0e7ff,c7d2fe,a5b4fc,818cf8,6366f1,4f46e5,4338ca,3730a3,312e81,1e1b4b'],
  ['violet', 'f5f3ff,ede9fe,ddd6fe,c4b5fd,a78bfa,8b5cf6,7c3aed,6d28d9,5b21b6,4c1d95,2e1065'],
  ['purple', 'faf5ff,f3e8ff,e9d5ff,d8b4fe,c084fc,a855f7,9333ea,7e22ce,6b21a8,581c87,3b0764'],
  ['fuchsia', 'fdf4ff,fae8ff,f5d0fe,f0abfc,e879f9,d946ef,c026d3,a21caf,86198f,701a75,4a044e'],
  ['pink', 'fdf2f8,fce7f3,fbcfe8,f9a8d4,f472b6,ec4899,db2777,be185d,9d174d,831843,500724'],
  ['rose', 'fff1f2,ffe4e6,fecdd3,fda4af,fb7185,f43f5e,e11d48,be123c,9f1239,881337,4c0519'],
  ['slate', 'f8fafc,f1f5f9,e2e8f0,cbd5e1,94a3b8,64748b,475569,334155,1e293b,0f172a,020617'],
  ['gray', 'f9fafb,f3f4f6,e5e7eb,d1d5db,9ca3af,6b7280,4b5563,374151,1f2937,111827,030712'],
  ['zinc', 'fafafa,f4f4f5,e4e4e7,d4d4d8,a1a1aa,71717a,52525b,3f3f46,27272a,18181b,09090b'],
  ['neutral', 'fafafa,f5f5f5,e5e5e5,d4d4d4,a3a3a3,737373,525252,404040,262626,171717,0a0a0a'],
  ['stone', 'fafaf9,f5f5f4,e7e5e4,d6d3d1,a8a29e,78716c,57534e,44403c,292524,1c1917,0c0a09'],
];
var TW_PALETTE = (function () {
  var out = {};
  for (var i = 0; i < TW_ROWS.length; i++) {
    var name = TW_ROWS[i][0];
    var parts = TW_ROWS[i][1].split(',');
    for (var j = 0; j < TW_SHADES.length; j++) {
      out[name + '-' + TW_SHADES[j]] = '#' + parts[j];
    }
    out[name] = '#' + parts[5]; // bare name → 500 shade
  }
  return out;
})();

// Curated swatch list for the color picker — 22 Tailwind hues at shade 500.
// Order roughly follows the color wheel (warm → cool → neutral).
var PICKER_SWATCHES = [
  'red-500', 'orange-500', 'amber-500', 'yellow-500', 'lime-500', 'green-500',
  'emerald-500', 'teal-500', 'cyan-500', 'sky-500', 'blue-500', 'indigo-500',
  'violet-500', 'purple-500', 'fuchsia-500', 'pink-500', 'rose-500',
  'slate-500', 'gray-500', 'zinc-500', 'neutral-500', 'stone-500',
];

function buildPickerSwatchesHTML() {
  var html = '';
  for (var i = 0; i < PICKER_SWATCHES.length; i++) {
    var name = PICKER_SWATCHES[i];
    var hex = TW_PALETTE[name] || '#888';
    html += '<button class="rm-color-swatch" data-color="' + name + '" title="' + name + '" style="background:' + hex + '"></button>';
  }
  return html;
}

function resolveColor(value) {
  if (!value) return '';
  var s = String(value).trim().toLowerCase();
  if (!s) return '';
  // Allow optional quotes
  if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
    s = s.substring(1, s.length - 1).trim();
  }
  if (s.charAt(0) === '#') {
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) return s;
    return '';
  }
  return TW_PALETTE[s] || '';
}

// Regex for the NotePlan scheduled-date marker inside a task line.
// Matches `>2026-06-15` (preferred) or NotePlan's `@YYYY-MM-DD` variant.
var SCHEDULED_RX = />(\d{4}-\d{2}-\d{2})\b/;

// `@after(<blockId>)` encodes a task-to-task dependency. The id inside is the
// prerequisite task's NotePlan blockID (the `^XXXX` minus the caret). Multiple
// markers on the same task = multiple prerequisites.
var AFTER_RX = /@after\(([^)]+)\)/g;
// Standalone block-ID tokens that NotePlan appends at the end of a task line.
var BLOCK_ID_TOKEN_RX = /\s*\^[A-Za-z0-9]+/g;

function extractScheduledFromContent(content) {
  if (!content) return '';
  var m = String(content).match(SCHEDULED_RX);
  return m ? m[1] : '';
}

function extractAfterRefs(content) {
  var refs = [];
  if (!content) return refs;
  var s = String(content);
  var rx = new RegExp(AFTER_RX.source, 'g');
  var m;
  while ((m = rx.exec(s)) !== null) {
    var id = (m[1] || '').trim();
    if (id.charAt(0) === '^') id = id.substring(1);
    if (id) refs.push(id);
  }
  return refs;
}

function normalizeBlockId(raw) {
  if (!raw) return '';
  var s = String(raw).trim();
  if (s.charAt(0) === '^') s = s.substring(1);
  return s;
}

function stripTaskMarkers(content) {
  return String(content || '')
    .replace(/>(\d{4}-\d{2}-\d{2})\b/g, '')
    .replace(/@done\([^)]*\)/g, '')
    .replace(/@after\([^)]*\)/g, '')
    .replace(BLOCK_ID_TOKEN_RX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildProjectItem(note, fm) {
  var idRaw = fm.roadmap;
  if (idRaw == null || idRaw === '' || idRaw === 'false') return null;
  var id = String(idRaw).trim();
  if (id === 'true') id = (note.title || note.filename.replace(/\.[^.]+$/, '')).trim();
  if (!id) return null;

  var parent = fm.roadmap_parent ? String(fm.roadmap_parent).trim() : '';
  if (parent === '' || parent === 'false') parent = '';
  var idxRaw = fm.roadmap_index;
  var index = (idxRaw != null && idxRaw !== '') ? parseInt(idxRaw, 10) : null;
  if (index != null && isNaN(index)) index = null;

  var start = toISO(parseDateStr(fm.start));
  var end = toISO(parseDateStr(fm.end));
  var due = toISO(parseDateStr(fm.due));
  var defer = toISO(parseDateStr(fm.defer));
  var prereqs = String(fm.prerequisites || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  var progress = computeProgress(note, fm);
  // NotePlan's built-in `icon-color` (Tailwind name or hex). We keep both the
  // raw key (so the picker can highlight the active swatch) and the resolved
  // hex (so the renderer can paint the bar without re-resolving).
  var rawColor = String(fm['icon-color'] || fm['icon_color'] || fm.color || '').trim().toLowerCase();
  if ((rawColor.charAt(0) === '"' && rawColor.charAt(rawColor.length - 1) === '"') ||
    (rawColor.charAt(0) === "'" && rawColor.charAt(rawColor.length - 1) === "'")) {
    rawColor = rawColor.substring(1, rawColor.length - 1).trim();
  }
  var color = resolveColor(rawColor);

  return {
    kind: 'project',
    id: id,
    filename: note.filename,
    title: note.title || id,
    parentId: parent,
    index: index,
    start: start || '',
    end: end || '',
    due: due || '',
    defer: defer || '',
    progress: progress,
    progressExplicit: fm.progress != null && fm.progress !== '',
    prerequisites: prereqs,
    color: color,
    colorName: rawColor,
    hasStart: !!start, hasEnd: !!end, hasDue: !!due, hasDefer: !!defer,
  };
}

function buildTaskItemsForNote(note, projectId, showCompleted, projectColor) {
  var out = [];
  var ps = [];
  try { ps = note.paragraphs || []; } catch (e) { ps = []; }
  // One-time histogram of paragraph types per note, for diagnostics
  var typeCounts = {};
  for (var i = 0; i < ps.length; i++) {
    var p = ps[i];
    var t = p.type || '(undefined)';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
    var isTaskLike = (t === 'open' || t === 'scheduled' || t === 'done'
      || t === 'checklist' || t === 'checklistScheduled' || t === 'checklistDone');
    if (!isTaskLike) continue;
    var done = (t === 'done' || t === 'checklistDone');
    if (done && !showCompleted) continue;
    var raw = String(p.content == null ? '' : p.content);
    var scheduled = extractScheduledFromContent(raw);
    var afterRefs = extractAfterRefs(raw);
    var blockId = '';
    try { blockId = normalizeBlockId(p.blockId); } catch (e) { blockId = ''; }
    var title = stripTaskMarkers(raw);
    if (!title) continue;
    out.push({
      kind: 'task',
      id: 'task:' + note.filename + '#' + p.lineIndex,
      filename: note.filename,
      lineIndex: p.lineIndex,
      indents: (typeof p.indents === 'number' ? p.indents : 0),
      title: title,
      parentId: projectId,
      index: null,
      scheduled: scheduled,
      isDone: done,
      isChecklist: (t === 'checklist' || t === 'checklistScheduled' || t === 'checklistDone'),
      color: projectColor || '',
      blockId: blockId,
      afterRefs: afterRefs, // raw block IDs from @after(...) markers
    });
  }
  var typeStr = '';
  var tkeys = Object.keys(typeCounts);
  for (var k = 0; k < tkeys.length; k++) typeStr += (k ? ', ' : '') + tkeys[k] + '=' + typeCounts[tkeys[k]];
  console.log('Roadmap: ' + note.filename + ' (' + ps.length + ' paragraphs) types: ' + typeStr + ' → ' + out.length + ' tasks');
  return out;
}

// Resolve `@after(blockId)` references on tasks into actual task ids by
// building a `blockId → taskId` map across all tasks. The result is the same
// `prerequisites` field projects use, so the existing arrow renderer just
// works for tasks too. A side map `prereqBlockIds` is kept so the UI can
// later locate and strip the matching marker on removal.
function resolveTaskDependencies(rawItems) {
  var blockIdToTaskId = {};
  for (var i = 0; i < rawItems.length; i++) {
    var it = rawItems[i];
    if (it.kind === 'task' && it.blockId) {
      blockIdToTaskId[it.blockId] = it.id;
    }
  }
  for (var j = 0; j < rawItems.length; j++) {
    var t = rawItems[j];
    if (t.kind !== 'task') continue;
    var refs = t.afterRefs || [];
    if (!refs.length) continue;
    var prereqs = [];
    var blockMap = {};
    for (var r = 0; r < refs.length; r++) {
      var ref = refs[r];
      var matchedId = blockIdToTaskId[ref];
      if (matchedId && matchedId !== t.id) {
        prereqs.push(matchedId);
        blockMap[matchedId] = ref;
      }
    }
    if (prereqs.length) {
      t.prerequisites = prereqs;
      t.prereqBlockIds = blockMap;
    }
  }
}

// For projects without explicit `start` and/or `end`, derive the missing
// bound(s) from the entire subtree: scheduled tasks of this project plus the
// resolved ranges of nested sub-projects (recursively). The bar is then
// flagged `ephemeral` so the renderer can distinguish it from an explicit
// range. Dragging an ephemeral bar persists the derived dates, promoting it
// to an explicit bar.
//
// Implemented as a single post-order DFS: by the time we compute a parent's
// range, every child project has already had its start/end filled in if
// possible, so the parent simply unions over its direct children. O(N).
function applyEphemeralRanges(rawItems) {
  var byId = {};
  var children = {};
  for (var i = 0; i < rawItems.length; i++) {
    byId[rawItems[i].id] = rawItems[i];
    var pid = rawItems[i].parentId || '';
    if (!children[pid]) children[pid] = [];
    children[pid].push(rawItems[i]);
  }

  var visited = {}; // guard against malformed cycles

  function resolve(id) {
    if (visited[id]) return;
    visited[id] = true;
    var it = byId[id];
    if (!it || it.kind !== 'project') return;

    // Resolve all child projects first (post-order)
    var kids = children[id] || [];
    for (var k = 0; k < kids.length; k++) {
      if (kids[k].kind === 'project') resolve(kids[k].id);
    }

    if (it.start && it.end) return; // explicit range; nothing to derive

    // Union descendants' contributions
    var min = '', max = '';
    for (var k2 = 0; k2 < kids.length; k2++) {
      var c = kids[k2];
      var cMin = '', cMax = '';
      if (c.kind === 'task') {
        cMin = cMax = c.scheduled || '';
      } else {
        // Child project — by now start/end are filled if any descendant had dates
        cMin = c.start || '';
        cMax = c.end || '';
      }
      if (cMin && (!min || cMin < min)) min = cMin;
      if (cMax && (!max || cMax > max)) max = cMax;
    }
    if (!min && !max) return;

    if (!it.start && !it.end) {
      it.start = min || max;
      it.end = max || min;
      it.ephemeralStart = true; it.ephemeralEnd = true;
    } else if (!it.start) {
      it.start = (min && min < it.end) ? min : it.end;
      it.ephemeralStart = true;
    } else if (!it.end) {
      it.end = (max && max > it.start) ? max : it.start;
      it.ephemeralEnd = true;
    }
    it.ephemeral = true;
  }

  for (var ii = 0; ii < rawItems.length; ii++) {
    if (rawItems[ii].kind === 'project') resolve(rawItems[ii].id);
  }
}

function orderByTree(rawItems) {
  // Group children by parentId; preserve only items whose parents (if specified) resolve.
  var byId = {};
  for (var i = 0; i < rawItems.length; i++) byId[rawItems[i].id] = rawItems[i];

  var children = {};
  for (var i2 = 0; i2 < rawItems.length; i2++) {
    var it = rawItems[i2];
    var p = it.parentId || '';
    if (p && !byId[p]) p = ''; // dangling parent → promote to root
    if (!children[p]) children[p] = [];
    children[p].push(it);
  }

  function sortKey(a, b) {
    // Projects always above tasks at the same level
    if (a.kind !== b.kind) return a.kind === 'project' ? -1 : 1;
    // Tasks: preserve their file order so sub-task hierarchy reads naturally
    if (a.kind === 'task') return (a.lineIndex || 0) - (b.lineIndex || 0);
    // Projects: explicit roadmap_index first, then earliest date, then title
    var ai = (a.index != null) ? a.index : 1e9;
    var bi = (b.index != null) ? b.index : 1e9;
    if (ai !== bi) return ai - bi;
    var ad = a.start || a.defer || a.end || a.due || '￿';
    var bd = b.start || b.defer || b.end || b.due || '￿';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return (a.title || '').localeCompare(b.title || '');
  }

  var ordered = [];
  function dfs(parentId, depth) {
    var kids = children[parentId] || [];
    kids.sort(sortKey);
    for (var k = 0; k < kids.length; k++) {
      kids[k].depth = depth;
      kids[k].hasChildren = !!(children[kids[k].id] && children[kids[k].id].length);
      ordered.push(kids[k]);
      dfs(kids[k].id, depth + 1);
    }
  }
  dfs('', 0);
  // Append any orphans that weren't reached (shouldn't happen, but defensive)
  if (ordered.length < rawItems.length) {
    var seen = {};
    for (var s = 0; s < ordered.length; s++) seen[ordered[s].id] = true;
    for (var r = 0; r < rawItems.length; r++) {
      if (!seen[rawItems[r].id]) {
        rawItems[r].depth = 0;
        rawItems[r].hasChildren = false;
        ordered.push(rawItems[r]);
      }
    }
  }
  return ordered;
}

function applyCollapse(ordered, collapsedIds) {
  if (!collapsedIds || !collapsedIds.length) return ordered;
  var hideUnderDepth = -1;
  var hideUnderId = null;
  var out = [];
  for (var i = 0; i < ordered.length; i++) {
    var it = ordered[i];
    if (hideUnderId != null) {
      if (it.depth > hideUnderDepth) continue;
      hideUnderId = null;
      hideUnderDepth = -1;
    }
    out.push(it);
    if (collapsedIds.indexOf(it.id) >= 0 && it.hasChildren) {
      hideUnderId = it.id;
      hideUnderDepth = it.depth;
    }
  }
  return out;
}

function collectRoadmapItems() {
  var cfg = getSettings();
  var notes = DataStore.projectNotes || [];
  var raw = [];
  var idToProject = {};

  for (var i = 0; i < notes.length; i++) {
    var note = notes[i];
    var content = note.content || '';
    // Cheap pre-filter to avoid parsing every note's frontmatter
    if (content.indexOf('roadmap:') < 0 && content.indexOf('roadmap ') < 0) continue;
    if (isExcluded(note.filename, cfg.foldersToExclude)) continue;

    var fm = readFrontmatter(note);
    var project = buildProjectItem(note, fm);
    if (!project) continue;

    console.log('Roadmap: project ' + project.id +
      ' parent=' + JSON.stringify(fm.roadmap_parent || '') +
      ' index=' + JSON.stringify(fm.roadmap_index || '') +
      ' fm keys=' + Object.keys(fm).join(','));

    if (idToProject[project.id]) {
      project.duplicate = true;
    } else {
      idToProject[project.id] = project;
    }
    raw.push(project);

    // Collect tasks belonging to this note (inheriting the project's color)
    var tasks = buildTaskItemsForNote(note, project.id, cfg.showCompletedTasks, project.color);
    for (var t = 0; t < tasks.length; t++) raw.push(tasks[t]);
  }

  resolveTaskDependencies(raw);
  applyEphemeralRanges(raw);
  var ordered = orderByTree(raw);
  // Collapse is now handled entirely client-side — the server always ships
  // the full tree so that chevron toggles never need a roundtrip.

  // Diagnostic counts — visible in NotePlan's plugin console.
  var nProj = 0, nTask = 0, nChild = 0, nScheduled = 0;
  for (var ci = 0; ci < raw.length; ci++) {
    if (raw[ci].kind === 'task') { nTask++; if (raw[ci].scheduled) nScheduled++; }
    else { nProj++; if (raw[ci].parentId) nChild++; }
  }
  console.log('Roadmap: collected ' + nProj + ' projects (' + nChild + ' with parent), ' + nTask + ' tasks (' + nScheduled + ' scheduled).');

  return {
    items: ordered,
    collapsedIds: cfg.collapsedIds,
    showCompletedTasks: cfg.showCompletedTasks,
    weekStart: cfg.weekStart,
    zoom: cfg.lastZoom,
    scrollDate: cfg.lastScrollDate,
    sidebarWidth: cfg.sidebarWidth,
  };
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

// Walk the roadmap tree starting from `rootId` and return all descendant
// project ids (excluding the root itself). Used to propagate properties like
// `icon-color` down a subtree in one user action.
function collectDescendantProjectIds(rootId) {
  if (!rootId) return [];
  // Build parent → children id map once from the current data
  var data = collectRoadmapItems();
  var items = data.items || [];
  var childrenOf = {};
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.kind !== 'project') continue;
    var pid = it.parentId || '';
    if (!childrenOf[pid]) childrenOf[pid] = [];
    childrenOf[pid].push(it.id);
  }
  var out = [];
  var stack = (childrenOf[rootId] || []).slice();
  var seen = {};
  while (stack.length) {
    var id = stack.shift();
    if (seen[id]) continue; // guard against malformed cycles
    seen[id] = true;
    out.push(id);
    var kids = childrenOf[id] || [];
    for (var k = 0; k < kids.length; k++) stack.push(kids[k]);
  }
  return out;
}

function findNoteByFilename(filename) {
  var notes = DataStore.projectNotes || [];
  for (var i = 0; i < notes.length; i++) {
    if (notes[i].filename === filename) return notes[i];
  }
  return null;
}

// ============================================
// TASK UPDATES
// ============================================
// Tasks are identified by `task:<filename>#<lineIndex>` — recomputed every
// refresh. Setting a scheduled date adds/replaces `>YYYY-MM-DD` in the content
// and lets NotePlan auto-promote the paragraph type to `scheduled`.

function rescheduleTask(filename, lineIndex, dateISO) {
  var note = findNoteByFilename(filename);
  if (!note) return false;
  var ps = note.paragraphs || [];
  if (lineIndex == null || lineIndex < 0 || lineIndex >= ps.length) return false;
  var p = ps[lineIndex];
  if (!p) return false;

  var c = String(p.content == null ? '' : p.content);
  var newC;
  if (dateISO) {
    if (SCHEDULED_RX.test(c)) {
      newC = c.replace(/>(\d{4}-\d{2}-\d{2})\b/g, '>' + dateISO);
    } else {
      newC = c.replace(/\s+$/, '') + ' >' + dateISO;
    }
  } else {
    // Clear scheduling
    newC = c.replace(/\s*>(\d{4}-\d{2}-\d{2})\b/g, '').replace(/\s{2,}/g, ' ').trim();
  }
  if (newC === c) return true;
  p.content = newC;
  try { note.updateParagraph(p); } catch (e) { console.log('Roadmap: updateParagraph: ' + e); }
  try { DataStore.updateCache(note, true); } catch (e) { }
  return true;
}

// ============================================
// HIERARCHY UPDATES
// ============================================
// Reparent / reorder rewrite `roadmap_parent` and `roadmap_index` on affected
// notes. Indices are reissued in increments of 10 for the new sibling set.

function reorderSiblings(parentId, orderedIds) {
  // orderedIds is an array of project IDs (tasks are ignored here)
  var changed = 0;
  for (var i = 0; i < orderedIds.length; i++) {
    var n = findNoteByRoadmapId(orderedIds[i]);
    if (!n) continue;
    var fm = readFrontmatter(n);
    var newIdx = (i + 1) * 10;
    var patch = {};
    if (String(fm.roadmap_index || '') !== String(newIdx)) patch.roadmap_index = String(newIdx);
    if (String(fm.roadmap_parent || '') !== String(parentId || '')) {
      patch.roadmap_parent = parentId ? String(parentId) : '';
    }
    if (Object.keys(patch).length) {
      writeFrontmatterPatch(n, patch);
      changed++;
    }
  }
  return changed;
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
    '.rm-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--rm-border); flex-shrink: 0; justify-content: flex-end; }\n' +
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
    '.rm-sidebar { position: relative; width: var(--rm-sidebar-w); min-width: 140px; max-width: 800px; flex-shrink: 0; background: var(--rm-bg-card); border-right: 1px solid var(--rm-border); display: flex; flex-direction: column; overflow: hidden; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }\n' +
    '.rm-sidebar-resize { flex: 0 0 6px; margin-left: -3px; margin-right: -3px; cursor: col-resize; z-index: 6; align-self: stretch; }\n' +
    '.rm-sidebar-resize:hover, .rm-sidebar-resize.dragging { background: var(--rm-accent); opacity: 0.55; }\n' +
    'body.rm-resizing, body.rm-resizing * { cursor: col-resize !important; user-select: none !important; }\n' +
    '.rm-sidebar-header { padding: 0; border-bottom: 1px solid var(--rm-border); flex-shrink: 0; display: flex; align-items: center; height: 56px; padding: 0 12px; }\n' +
    '.rm-sidebar-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--rm-text-faint); }\n' +
    '.rm-sidebar-rows { flex: 1; overflow-y: auto; overflow-x: hidden; }\n' +
    '.rm-sidebar-row { position: relative; display: flex; align-items: center; gap: 6px; height: var(--rm-row-h); padding: 0 8px; border-bottom: 1px solid var(--rm-border); cursor: pointer; user-select: none; }\n' +
    '.rm-sidebar-row:hover { background: var(--rm-bg-elevated); }\n' +
    '.rm-sidebar-row.highlight { background: var(--rm-accent-soft); }\n' +
    '.rm-sidebar-row.dragging { opacity: 0.5; }\n' +
    '.rm-sidebar-row.drop-into { background: var(--rm-accent-soft); box-shadow: inset 0 0 0 2px var(--rm-accent); }\n' +
    '.rm-sidebar-row.drop-before::before { content: ""; position: absolute; left: 4px; right: 4px; top: -1px; height: 2px; background: var(--rm-accent); border-radius: 1px; z-index: 5; }\n' +
    '.rm-sidebar-row.drop-after::after { content: ""; position: absolute; left: 4px; right: 4px; bottom: -1px; height: 2px; background: var(--rm-accent); border-radius: 1px; z-index: 5; }\n' +
    '.rm-sidebar-row.task .rm-sidebar-row-title { font-weight: 400; color: var(--rm-text-muted); }\n' +
    '.rm-sidebar-row.task.done .rm-sidebar-row-title { text-decoration: line-through; color: var(--rm-text-faint); }\n' +
    '.rm-sidebar-row-title { flex: 1; font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
    '.rm-sidebar-row-progress { font-size: 10px; color: var(--rm-text-faint); font-variant-numeric: tabular-nums; }\n' +
    '.rm-sidebar-row.warn .rm-sidebar-row-title { color: var(--rm-warn); }\n' +
    '.rm-sidebar-row.danger .rm-sidebar-row-title { color: var(--rm-danger); }\n' +
    '.rm-chev { width: 16px; height: 16px; flex-shrink: 0; padding: 0; border: none; background: transparent; color: var(--rm-text-faint); cursor: pointer; font-size: 9px; display: inline-flex; align-items: center; justify-content: center; border-radius: 3px; }\n' +
    '.rm-chev:hover { color: var(--rm-text); background: var(--rm-border); }\n' +
    '.rm-chev-spacer { width: 16px; flex-shrink: 0; }\n' +
    '.rm-row-icon { color: var(--rm-text-faint); font-size: 11px; width: 12px; flex-shrink: 0; text-align: center; }\n' +
    '.rm-sidebar-row.project .rm-row-icon { color: var(--rm-accent); }\n' +
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
    '.rm-bar.ephemeral { border-style: dashed; background: transparent; }\n' +
    '.rm-bar.ephemeral .rm-bar-label { font-style: italic; color: var(--rm-text-muted); }\n' +
    '.rm-bar.task { top: 8px; height: calc(var(--rm-row-h) - 16px); border-radius: 50px; background: var(--rm-bg-card); border: 1.5px solid var(--rm-accent); }\n' +
    '.rm-bar.task.done { border-style: dashed; opacity: 0.55; background: transparent; }\n' +
    '.rm-bar.task.checklist { border-radius: 4px; }\n' +
    '.rm-bar.task .rm-bar-label { left: 4px; right: 4px; font-size: 10px; font-weight: 500; }\n' +
    '.rm-bar.task .rm-bar-handle { display: none; }\n' +
    '.rm-bar.task .rm-bar-link-dot { display: none; }\n' +
    '.rm-row-ghost-label { position: absolute; left: 8px; top: 0; bottom: 0; display: flex; align-items: center; font-size: 10px; color: var(--rm-text-faint); font-style: italic; pointer-events: none; opacity: 0; transition: opacity 0.15s; }\n' +
    '.rm-row:hover .rm-row-ghost-label { opacity: 1; }\n' +
    '.rm-row.task-row .rm-row-ghost-label { left: auto; right: 8px; }\n' +
    '.rm-range-select { position: absolute; top: 4px; height: calc(var(--rm-row-h) - 8px); background: var(--rm-accent-soft); border: 1.5px dashed var(--rm-accent); border-radius: 5px; pointer-events: none; z-index: 6; }\n' +
    '.rm-icon-btn.active { background: var(--rm-accent-soft); color: var(--rm-accent); border-color: var(--rm-accent); }\n' +
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

    /* CONTEXT MENU */
    '.rm-context-menu { position: fixed; min-width: 200px; padding: 4px; background: var(--rm-bg-elevated); border: 1px solid var(--rm-border-strong); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); display: none; z-index: 500; }\n' +
    '.rm-context-menu.open { display: block; }\n' +
    '.rm-context-menu button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; border: none; background: transparent; color: var(--rm-text); cursor: pointer; font-size: 12px; text-align: left; border-radius: 4px; font-family: inherit; }\n' +
    '.rm-context-menu button:hover { background: var(--rm-accent-soft); color: var(--rm-accent); }\n' +
    '.rm-context-menu button i { width: 14px; text-align: center; opacity: 0.7; }\n' +
    '.rm-context-menu hr { border: none; border-top: 1px solid var(--rm-border); margin: 4px 2px; }\n' +
    '.rm-color-header { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--rm-text-faint); padding: 4px 10px 2px; }\n' +
    '.rm-color-grid { display: grid; grid-template-columns: repeat(8, 20px); gap: 4px; padding: 4px 8px 6px; }\n' +
    '.rm-color-swatch { width: 20px; height: 20px; border-radius: 4px; border: 1.5px solid transparent; cursor: pointer; padding: 0; font-size: 9px; display: flex; align-items: center; justify-content: center; }\n' +
    '.rm-color-swatch:hover { transform: scale(1.18); }\n' +
    '.rm-color-swatch.clear { background: transparent; border-color: var(--rm-text-faint); position: relative; overflow: hidden; }\n' +
    '.rm-color-swatch.clear::after { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 1.5px; background: var(--rm-danger); transform: rotate(-45deg); transform-origin: center; pointer-events: none; }\n' +
    '.rm-color-swatch.clear:hover { border-color: var(--rm-text); }\n' +
    '.rm-color-swatch.selected { box-shadow: 0 0 0 2px var(--rm-bg-elevated), 0 0 0 4px var(--rm-text); }\n' +

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

function buildToolbar(zoom, showCompletedTasks) {
  // NotePlan's window chrome already shows the plugin icon, title, and a
  // reload button, so we keep this toolbar minimal: just zoom + view toggles.
  var html = '<div class="rm-toolbar">';
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
  html += '<button class="rm-icon-btn' + (showCompletedTasks ? ' active' : '') + '" id="rmShowDoneBtn" title="Show completed tasks"><i class="fa-solid fa-check-double"></i></button>';
  html += '<button class="rm-text-btn" id="rmTodayBtn"><i class="fa-solid fa-crosshairs"></i> Today</button>';
  html += '</div>';
  return html;
}

function buildSidebar(items, collapsedIds, sidebarWidth) {
  var collapsedSet = {};
  for (var c = 0; c < (collapsedIds || []).length; c++) collapsedSet[collapsedIds[c]] = true;
  var widthStyle = sidebarWidth ? (' style="width:' + sidebarWidth + 'px"') : '';
  var html = '<aside class="rm-sidebar" id="rmSidebar"' + widthStyle + '>';
  html += '<div class="rm-sidebar-header"><span class="rm-sidebar-title">Project</span></div>';
  html += '<div class="rm-sidebar-rows" id="rmSidebarRows">';
  if (items.length === 0) {
    html += '<div class="rm-sidebar-empty">No roadmap items yet.<br><br>Add <code>roadmap: my-id</code> to a note\'s frontmatter, plus optional <code>start</code>, <code>end</code>, <code>due</code>, <code>defer</code>, <code>progress</code>, <code>prerequisites</code>, <code>roadmap_parent</code>, <code>roadmap_index</code>.</div>';
  } else {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      html += renderSidebarRowHTML(it, collapsedSet[it.id]);
    }
  }
  html += '</div>';
  html += '</aside>';
  // Resize splitter sits in .rm-main as a sibling so it isn't clipped by
  // the sidebar's overflow:hidden.
  html += '<div class="rm-sidebar-resize" id="rmSidebarResize" title="Drag to resize"></div>';
  return html;
}

function renderSidebarRowHTML(it, isCollapsed) {
  var depth = (it.depth || 0) + (it.indents || 0);
  var indent = depth * 14;
  var isTask = it.kind === 'task';
  var pTxt = '';
  if (!isTask) pTxt = (it.progress == null) ? '—' : (it.progress + '%');
  var chev = '';
  if (it.hasChildren) {
    chev = '<button class="rm-chev' + (isCollapsed ? ' collapsed' : '') + '" data-chev-id="' + esc(it.id) + '" title="Collapse/expand"><i class="fa-solid ' + (isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down') + '"></i></button>';
  } else {
    chev = '<span class="rm-chev-spacer"></span>';
  }
  var iconStyle = it.color ? (' style="color:' + it.color + '"') : '';
  var icon = isTask
    ? '<i class="rm-row-icon fa-regular ' + (it.isDone ? 'fa-square-check' : (it.isChecklist ? 'fa-square' : 'fa-circle')) + '"' + iconStyle + '></i>'
    : '<i class="rm-row-icon fa-solid fa-file-lines"' + iconStyle + '></i>';
  var dragAttr = !isTask ? ' draggable="true"' : '';
  var classes = 'rm-sidebar-row' + (isTask ? ' task' : ' project') + (it.isDone ? ' done' : '');
  var data = ' data-roadmap-id="' + esc(it.id) + '"' +
    ' data-kind="' + (isTask ? 'task' : 'project') + '"' +
    ' data-filename="' + esc(it.filename) + '"' +
    (isTask ? ' data-line-index="' + (it.lineIndex || 0) + '"' : '') +
    ' data-parent-id="' + esc(it.parentId || '') + '"';
  var html = '<div class="' + classes + '"' + data + dragAttr + ' style="padding-left:' + (8 + indent) + 'px" title="' + esc(it.title) + '">';
  html += chev + icon;
  html += '<div class="rm-sidebar-row-title">' + esc(it.title) + '</div>';
  if (pTxt) html += '<div class="rm-sidebar-row-progress">' + esc(pTxt) + '</div>';
  html += '</div>';
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
    '  <div class="rm-context-menu" id="rmContextMenu" role="menu">\n' +
    /* Open the underlying note — applies to both projects and tasks */
    '    <button data-action="openNote" data-ctx="project task"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open note</button>\n' +
    '    <hr data-ctx="project task">\n' +
    /* Project: create tasks / subprojects */
    '    <button data-action="appendTask" data-ctx="project"><i class="fa-solid fa-plus"></i> Add task at bottom</button>\n' +
    '    <button data-action="prependTask" data-ctx="project"><i class="fa-solid fa-arrow-turn-up"></i> Add task at top</button>\n' +
    '    <hr data-ctx="project">\n' +
    '    <button data-action="addSubproject" data-ctx="project"><i class="fa-solid fa-file-circle-plus"></i> Add subproject</button>\n' +
    /* Project: reset individual dates (only shown when set) and clear-all */
    '    <hr data-ctx="project" data-needs="any-date">\n' +
    '    <button data-action="resetStart" data-ctx="project" data-needs="start"><i class="fa-regular fa-circle-xmark"></i> Reset start</button>\n' +
    '    <button data-action="resetEnd" data-ctx="project" data-needs="end"><i class="fa-regular fa-circle-xmark"></i> Reset end</button>\n' +
    '    <button data-action="resetDue" data-ctx="project" data-needs="due"><i class="fa-regular fa-circle-xmark"></i> Reset due</button>\n' +
    '    <button data-action="resetDefer" data-ctx="project" data-needs="defer"><i class="fa-regular fa-circle-xmark"></i> Reset defer</button>\n' +
    '    <button data-action="resetAllDates" data-ctx="project" data-needs="any-date"><i class="fa-solid fa-eraser"></i> Clear all dates</button>\n' +
    /* Task: unschedule */
    '    <button data-action="unscheduleTask" data-ctx="task" data-needs="scheduled"><i class="fa-solid fa-eraser"></i> Unschedule</button>\n' +
    /* Color picker — projects only */
    '    <hr data-ctx="project">\n' +
    '    <div class="rm-color-header" data-ctx="project">Color</div>\n' +
    '    <div class="rm-color-grid" id="rmColorGrid" data-ctx="project">\n' +
    '      <button class="rm-color-swatch clear" data-color="" title="No color"></button>\n' +
         buildPickerSwatchesHTML() +
    '    </div>\n' +
    '  </div>\n' +
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

    var toolbar = buildToolbar(data.zoom, data.showCompletedTasks);
    // Initial DOM should already reflect the persisted collapse state.
    var initialVisible = applyCollapse(data.items, data.collapsedIds);
    var sidebar = buildSidebar(initialVisible, data.collapsedIds, data.sidebarWidth);
    var canvas = buildCanvas(initialVisible);
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

      case 'scheduleTask': {
        // msg: { filename, lineIndex, date } — empty date clears scheduling
        rescheduleTask(msg.filename, msg.lineIndex, msg.date || '');
        await pushRefresh();
        break;
      }

      case 'reorderItems': {
        // msg: { parentId, orderedIds }
        reorderSiblings(msg.parentId || '', msg.orderedIds || []);
        await pushRefresh();
        break;
      }

      case 'resetStart':
      case 'resetEnd':
      case 'resetDue':
      case 'resetDefer':
      case 'resetAllDates': {
        var nR = findNoteByRoadmapId(msg.id) || findNoteByFilename(msg.filename);
        if (!nR) break;
        var resetPatch = {};
        if (actionType === 'resetAllDates') {
          resetPatch.start = ''; resetPatch.end = '';
          resetPatch.due = ''; resetPatch.defer = '';
        } else if (actionType === 'resetStart') resetPatch.start = '';
        else if (actionType === 'resetEnd') resetPatch.end = '';
        else if (actionType === 'resetDue') resetPatch.due = '';
        else if (actionType === 'resetDefer') resetPatch.defer = '';
        writeFrontmatterPatch(nR, resetPatch);
        await pushRefresh();
        break;
      }

      case 'unscheduleTask': {
        if (msg.filename && msg.lineIndex != null) {
          rescheduleTask(msg.filename, parseInt(msg.lineIndex, 10), '');
        }
        await pushRefresh();
        break;
      }

      case 'setColor': {
        var nC = findNoteByRoadmapId(msg.id) || findNoteByFilename(msg.filename);
        if (!nC) break;
        var newColor = msg.color || '';
        // Apply to the target note plus every descendant project so a parent
        // colors its whole subtree in one action.
        var targets = [nC];
        var descIds = collectDescendantProjectIds(msg.id);
        for (var di = 0; di < descIds.length; di++) {
          var dNote = findNoteByRoadmapId(descIds[di]);
          if (dNote) targets.push(dNote);
        }
        for (var ti = 0; ti < targets.length; ti++) {
          writeFrontmatterPatch(targets[ti], { 'icon-color': newColor });
        }
        await pushRefresh();
        break;
      }

      case 'appendTask':
      case 'prependTask': {
        var note = findNoteByRoadmapId(msg.id) || findNoteByFilename(msg.filename);
        if (!note) break;
        await CommandBar.onMainThread();
        var title = await CommandBar.showInput('Task title', "Add '%@'");
        if (title && String(title).trim()) {
          var content = String(title).trim();
          if (actionType === 'appendTask') note.appendParagraph(content, 'open');
          else note.prependParagraph(content, 'open');
          try { DataStore.updateCache(note, true); } catch (e) { }
        }
        await pushRefresh();
        break;
      }

      case 'addSubproject': {
        var parentNote = findNoteByRoadmapId(msg.id) || findNoteByFilename(msg.filename);
        if (!parentNote) break;
        var parentFm = readFrontmatter(parentNote);
        var parentId = String(parentFm.roadmap || '').trim();
        if (parentId === 'true') parentId = (parentNote.title || '').trim();
        if (!parentId) parentId = msg.id || '';

        await CommandBar.onMainThread();
        var subTitle = await CommandBar.showInput('Subproject title', "Create '%@'");
        if (!subTitle || !String(subTitle).trim()) { await pushRefresh(); break; }
        subTitle = String(subTitle).trim();

        // Derive a unique roadmap id from the title (slug)
        var slug = subTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if (!slug) slug = 'subproject-' + Date.now();
        var existing = collectRoadmapItems().items;
        var taken = {};
        for (var i = 0; i < existing.length; i++) taken[existing[i].id] = true;
        var unique = slug, n = 2;
        while (taken[unique]) { unique = slug + '-' + n; n++; }

        // Place the new note in the parent's folder ("/" for root)
        var pf = String(parentNote.filename || '');
        var folder = pf.indexOf('/') >= 0 ? pf.replace(/\/[^/]+$/, '') : '/';
        if (!folder) folder = '/';

        // Inherit the parent's icon-color if it was set, so the subproject
        // reads as part of the same visual cluster
        var inheritColor = parentFm['icon-color'] || parentFm['icon_color'] || '';
        var fmLines = ['title: ' + subTitle, 'roadmap: ' + unique, 'roadmap_parent: ' + parentId];
        if (inheritColor) fmLines.push('icon-color: ' + inheritColor);
        var noteContent = '---\n' + fmLines.join('\n') + '\n---\n\n# ' + subTitle + '\n';

        var newFilename = null;
        try {
          newFilename = DataStore.newNoteWithContent(noteContent, folder, subTitle + '.md');
        } catch (e) {
          console.log('Roadmap: newNoteWithContent failed: ' + e);
        }
        if (newFilename) {
          try { DataStore.updateCache(findNoteByFilename(newFilename), true); } catch (e) { }
        }
        await pushRefresh();
        break;
      }

      case 'toggleShowCompletedTasks': {
        try {
          var s2 = DataStore.settings || {};
          s2.showCompletedTasks = String(!!msg.value);
          DataStore.settings = s2;
        } catch (e) { console.log('Roadmap: toggleShowCompletedTasks error: ' + e); }
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

      case 'addTaskDependency': {
        // msg: { sourceFilename, sourceLineIndex, targetFilename, targetLineIndex }
        var srcNote = findNoteByFilename(msg.sourceFilename);
        var tgtNote = findNoteByFilename(msg.targetFilename);
        if (!srcNote || !tgtNote) break;
        var srcLine = parseInt(msg.sourceLineIndex, 10);
        var tgtLine = parseInt(msg.targetLineIndex, 10);
        var srcParas = srcNote.paragraphs || [];
        var tgtParas = tgtNote.paragraphs || [];
        if (isNaN(srcLine) || isNaN(tgtLine) || srcLine < 0 || tgtLine < 0
            || srcLine >= srcParas.length || tgtLine >= tgtParas.length) break;
        var srcPara = srcParas[srcLine];
        var tgtPara = tgtParas[tgtLine];
        if (!srcPara || !tgtPara) break;
        if (srcNote.filename === tgtNote.filename && srcLine === tgtLine) break;

        // Ensure the source paragraph has a blockID we can reference
        var srcBlock = normalizeBlockId(srcPara.blockId);
        if (!srcBlock) {
          try {
            srcNote.addBlockID(srcPara);
            srcNote.updateParagraph(srcPara);
            // Re-read since blockId is now appended to the content
            srcParas = srcNote.paragraphs || [];
            srcPara = srcParas[srcLine] || srcPara;
            srcBlock = normalizeBlockId(srcPara.blockId);
          } catch (e) {
            console.log('Roadmap: addBlockID failed: ' + e);
          }
        }
        if (!srcBlock) break;

        // Append @after(srcBlock) to the target paragraph (if not already there)
        var tgtContent = String(tgtPara.content == null ? '' : tgtPara.content);
        if (tgtContent.indexOf('@after(' + srcBlock + ')') < 0) {
          tgtPara.content = tgtContent.replace(/\s+$/, '') + ' @after(' + srcBlock + ')';
          try { tgtNote.updateParagraph(tgtPara); } catch (e) { console.log('Roadmap: updateParagraph (target) failed: ' + e); }
        }
        try { DataStore.updateCache(srcNote, true); } catch (e) { }
        try { DataStore.updateCache(tgtNote, true); } catch (e) { }
        await pushRefresh();
        break;
      }

      case 'removeTaskDependency': {
        // msg: { filename, lineIndex, blockId }
        var rNote = findNoteByFilename(msg.filename);
        if (!rNote) break;
        var rLine = parseInt(msg.lineIndex, 10);
        var rParas = rNote.paragraphs || [];
        if (isNaN(rLine) || rLine < 0 || rLine >= rParas.length) break;
        var rPara = rParas[rLine];
        if (!rPara) break;
        var bid = String(msg.blockId || '').trim();
        if (!bid) break;
        // Strip the exact `@after(<bid>)` substring plus any surrounding whitespace
        var rContent = String(rPara.content == null ? '' : rPara.content);
        var rxRemove = new RegExp('\\s*@after\\(\\^?' + bid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)', 'g');
        var newContent = rContent.replace(rxRemove, '').replace(/\s{2,}/g, ' ').replace(/\s+$/, '');
        if (newContent !== rContent) {
          rPara.content = newContent;
          try { rNote.updateParagraph(rPara); } catch (e) { console.log('Roadmap: remove dep updateParagraph failed: ' + e); }
          try { DataStore.updateCache(rNote, true); } catch (e) { }
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
// DEPENDENCY BOOTSTRAP
// NotePlan doesn't auto-install plugin dependencies for side-loaded plugins,
// so we install them ourselves. REQUIRED_PLUGINS is the single source of truth.
// np.Shared provides FontAwesome (icons) + pluginToHTMLCommsBridge.js (HTML↔plugin comms).
// NotePlan calls onUpdateOrInstall automatically after install/update.
// ============================================

var REQUIRED_PLUGINS = ['np.Shared'];

async function ensureSharedResources() {
  var installed = DataStore.installedPlugins() || [];
  var have = {};
  for (var i = 0; i < installed.length; i++) if (installed[i]) have[installed[i].id] = true;

  var missing = REQUIRED_PLUGINS.filter(function (id) { return !have[id]; });
  if (!missing.length) return;

  var released = (await DataStore.listPlugins(false, true, false)) || [];
  for (var m = 0; m < missing.length; m++) {
    var match = released.find(function (p) { return p && p.id === missing[m]; });
    if (match) await DataStore.installPlugin(match, false);
    else await CommandBar.prompt('Plugin dependency needed',
      'This plugin needs "' + missing[m] + '". Please install it from NotePlan’s plugin list.');
  }
}

async function onUpdateOrInstall() {
  try { await ensureSharedResources(); }
  catch (e) { console.log('Roadmap onUpdateOrInstall failed: ' + (e && e.message ? e.message : String(e))); }
}

// ============================================
// EXPORTS
// ============================================

globalThis.showRoadmap = showRoadmap;
globalThis.refreshRoadmap = refreshRoadmap;
globalThis.onMessageFromHTMLView = onMessageFromHTMLView;
globalThis.toggleRoadmapCommand = toggleRoadmapCommand;
globalThis.onUpdateOrInstall = onUpdateOrInstall;
// NotePlan invokes this after every DataStore.settings write; stub so we don't log spurious errors.
globalThis.onSettingsUpdated = function () { };
