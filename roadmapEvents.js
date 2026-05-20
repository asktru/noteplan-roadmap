// asktru.Roadmap — roadmapEvents.js
// Gantt rendering, drag/resize, dependency editing, persistence via plugin messages.
/* global sendMessageToPlugin, ROADMAP_DATA */
// IIFE wraps state but `onMessageFromPlugin` is hoisted to global so the comms bridge can find it.

var onMessageFromPlugin;

(function () {
  'use strict';

  // ============================================
  // STATE
  // ============================================

  var data = ROADMAP_DATA || { items: [], zoom: 'week', weekStart: 'Monday', scrollDate: '' };
  // `allItems` is the full tree (post DFS ordering with depth/hasChildren set).
  // `items` is the currently-visible subset after applying client-side collapse.
  // Collapse is a pure UI concern — toggling does not round-trip to the plugin.
  var allItems = data.items || [];
  var collapsedSet = {};
  (data.collapsedIds || []).forEach(function (id) { collapsedSet[id] = true; });
  var items = applyCollapse(allItems, collapsedSet);
  var zoom = data.zoom || 'week';
  var weekStart = data.weekStart || 'Monday';
  var rowH = 36;

  function applyCollapse(arr, cs) {
    if (!cs) return arr.slice();
    var any = false;
    for (var k in cs) { if (cs[k]) { any = true; break; } }
    if (!any) return arr.slice();
    var out = [];
    var hideUnderDepth = -1;
    var hideUnderId = null;
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (hideUnderId != null) {
        if (it.depth > hideUnderDepth) continue;
        hideUnderId = null;
        hideUnderDepth = -1;
      }
      out.push(it);
      if (cs[it.id] && it.hasChildren) {
        hideUnderId = it.id;
        hideUnderDepth = it.depth;
      }
    }
    return out;
  }

  // Layout config per zoom level: col width (px per day), header strategy
  var ZOOM_CONFIG = {
    day:     { dayPx: 60, minor: 'day',   major: 'month' },
    week:    { dayPx: 28, minor: 'day',   major: 'month' },
    month:   { dayPx: 10, minor: 'week',  major: 'month' },
    quarter: { dayPx: 4,  minor: 'month', major: 'quarter' },
  };

  // Computed timeline window
  var timelineStart = null; // {y,m,d}
  var timelineEnd = null;
  var totalDays = 0;
  var canvasWidth = 0;

  // Interaction state
  var drag = null;
  var depDraft = null;
  var tooltipEl = null;
  var toastTimer = null;

  // ============================================
  // DATE MATH (UTC noon to dodge DST)
  // ============================================

  function partsToDate(p) { return new Date(Date.UTC(p.y, p.m - 1, p.d, 12, 0, 0)); }
  function dateToParts(d) { return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; }
  function partsFromISO(s) {
    if (!s) return null;
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return { y: +m[1], m: +m[2], d: +m[3] };
  }
  function partsToISO(p) {
    if (!p) return '';
    return p.y + '-' + ('0' + p.m).slice(-2) + '-' + ('0' + p.d).slice(-2);
  }
  function addDaysParts(p, n) {
    var d = partsToDate(p);
    d.setUTCDate(d.getUTCDate() + n);
    return dateToParts(d);
  }
  function diffDays(a, b) {
    // days b - a
    var d1 = partsToDate(a), d2 = partsToDate(b);
    return Math.round((d2 - d1) / 86400000);
  }
  function comparePartsLT(a, b) {
    if (a.y !== b.y) return a.y < b.y;
    if (a.m !== b.m) return a.m < b.m;
    return a.d < b.d;
  }
  function partsEq(a, b) { return a && b && a.y === b.y && a.m === b.m && a.d === b.d; }
  function todayParts() {
    var d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  }
  function dayOfWeek(p) {
    return partsToDate(p).getUTCDay(); // 0 = Sun
  }
  function isWeekend(p) {
    var dow = dayOfWeek(p);
    return dow === 0 || dow === 6;
  }
  function startOfMonth(p) { return { y: p.y, m: p.m, d: 1 }; }
  function startOfQuarter(p) {
    var qm = Math.floor((p.m - 1) / 3) * 3 + 1;
    return { y: p.y, m: qm, d: 1 };
  }
  function startOfWeek(p) {
    var dow = dayOfWeek(p);
    var offset = (weekStart === 'Sunday') ? dow : ((dow + 6) % 7);
    return addDaysParts(p, -offset);
  }
  function monthName(m) {
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
  }
  function shortMonth(m) { return monthName(m); }
  function dayShort(p) { return ['S','M','T','W','T','F','S'][dayOfWeek(p)]; }

  // ============================================
  // ITEM HELPERS
  // ============================================

  function getItemRange(it) {
    // Returns { start, end } or null if neither is set
    var s = partsFromISO(it.start);
    var e = partsFromISO(it.end);
    if (!s && !e) return null;
    if (s && !e) e = s;
    if (e && !s) s = e;
    return { start: s, end: e };
  }

  function isOverdue(it) {
    if (!it.due) return false;
    var due = partsFromISO(it.due);
    if (!due) return false;
    var t = todayParts();
    var done = it.progress === 100;
    if (done) return false;
    return !comparePartsLT(t, due) && !partsEq(t, due) ? true : false;
    // simpler: today > due ⇒ overdue
  }

  function itemDue(it) { return partsFromISO(it.due); }
  function itemDefer(it) { return partsFromISO(it.defer); }

  // ============================================
  // COMPUTE TIMELINE WINDOW
  // ============================================

  function computeTimelineWindow() {
    var t = todayParts();
    var minP = null, maxP = null;
    function consider(p) {
      if (!p) return;
      if (!minP || comparePartsLT(p, minP)) minP = p;
      if (!maxP || comparePartsLT(maxP, p)) maxP = p;
    }
    for (var i = 0; i < items.length; i++) {
      consider(partsFromISO(items[i].start));
      consider(partsFromISO(items[i].end));
      consider(partsFromISO(items[i].due));
      consider(partsFromISO(items[i].defer));
    }
    if (!minP) { minP = addDaysParts(t, -7); maxP = addDaysParts(t, 30); }
    if (comparePartsLT(t, minP)) minP = t;
    if (comparePartsLT(maxP, t)) maxP = t;

    // Pad based on zoom
    var padBefore, padAfter;
    if (zoom === 'day')     { padBefore = 3;  padAfter = 7;  }
    else if (zoom === 'week')    { padBefore = 7;  padAfter = 14; }
    else if (zoom === 'month')   { padBefore = 14; padAfter = 28; }
    else { padBefore = 30; padAfter = 60; }

    timelineStart = addDaysParts(minP, -padBefore);
    timelineEnd = addDaysParts(maxP, padAfter);

    // Snap timelineStart to start-of-week (or month for low zooms)
    if (zoom === 'quarter') timelineStart = startOfMonth(timelineStart);
    else if (zoom === 'month') timelineStart = startOfWeek(timelineStart);
    else timelineStart = startOfWeek(timelineStart);

    totalDays = diffDays(timelineStart, timelineEnd) + 1;
    canvasWidth = totalDays * ZOOM_CONFIG[zoom].dayPx;
  }

  function dateToX(p) {
    if (!p) return 0;
    return diffDays(timelineStart, p) * ZOOM_CONFIG[zoom].dayPx;
  }
  function xToDate(x) {
    var n = Math.round(x / ZOOM_CONFIG[zoom].dayPx);
    return addDaysParts(timelineStart, n);
  }

  // ============================================
  // RENDER: HEADER & GRID
  // ============================================

  function renderHeader() {
    var headerEl = document.getElementById('rmHeader');
    if (!headerEl) return;
    headerEl.style.width = canvasWidth + 'px';

    var minor = ZOOM_CONFIG[zoom].minor;
    var major = ZOOM_CONFIG[zoom].major;
    var dayPx = ZOOM_CONFIG[zoom].dayPx;
    var t = todayParts();

    // Major row (top)
    var majorHTML = '<div class="rm-header-row major">';
    if (major === 'quarter') {
      var qStart = startOfQuarter(timelineStart);
      while (comparePartsLT(qStart, addDaysParts(timelineEnd, 1))) {
        var nextQ = (qStart.m + 3 > 12)
          ? { y: qStart.y + 1, m: qStart.m + 3 - 12, d: 1 }
          : { y: qStart.y, m: qStart.m + 3, d: 1 };
        var leftQ = Math.max(0, dateToX(qStart));
        var rightQ = Math.min(canvasWidth, dateToX(nextQ));
        var w = rightQ - leftQ;
        if (w > 0) {
          var qNum = Math.floor((qStart.m - 1) / 3) + 1;
          majorHTML += '<div class="rm-header-cell major" style="position:absolute;left:' + leftQ + 'px;width:' + w + 'px">Q' + qNum + ' ' + qStart.y + '</div>';
        }
        qStart = nextQ;
      }
    } else if (major === 'month') {
      var mStart = startOfMonth(timelineStart);
      while (comparePartsLT(mStart, addDaysParts(timelineEnd, 1))) {
        var nextM = (mStart.m === 12) ? { y: mStart.y + 1, m: 1, d: 1 } : { y: mStart.y, m: mStart.m + 1, d: 1 };
        var leftM = Math.max(0, dateToX(mStart));
        var rightM = Math.min(canvasWidth, dateToX(nextM));
        var wM = rightM - leftM;
        if (wM > 0) {
          var lbl = shortMonth(mStart.m) + ' ' + mStart.y;
          majorHTML += '<div class="rm-header-cell major" style="position:absolute;left:' + leftM + 'px;width:' + wM + 'px">' + lbl + '</div>';
        }
        mStart = nextM;
      }
    }
    majorHTML += '</div>';

    // Minor row (bottom)
    var minorHTML = '<div class="rm-header-row minor">';
    if (minor === 'day') {
      for (var i = 0; i < totalDays; i++) {
        var p = addDaysParts(timelineStart, i);
        var isW = isWeekend(p);
        var isT = partsEq(p, t);
        var cls = 'rm-header-cell' + (isW ? ' weekend' : '') + (isT ? ' today' : '');
        var lblTxt = dayPx >= 50 ? (dayShort(p) + ' ' + p.d) : String(p.d);
        minorHTML += '<div class="' + cls + '" style="position:absolute;left:' + (i * dayPx) + 'px;width:' + dayPx + 'px">' + lblTxt + '</div>';
      }
    } else if (minor === 'week') {
      var wStart = startOfWeek(timelineStart);
      while (comparePartsLT(wStart, addDaysParts(timelineEnd, 1))) {
        var nextW = addDaysParts(wStart, 7);
        var leftW = Math.max(0, dateToX(wStart));
        var rightW = Math.min(canvasWidth, dateToX(nextW));
        var wW = rightW - leftW;
        if (wW > 0) {
          minorHTML += '<div class="rm-header-cell" style="position:absolute;left:' + leftW + 'px;width:' + wW + 'px">' + wStart.d + ' ' + shortMonth(wStart.m) + '</div>';
        }
        wStart = nextW;
      }
    } else if (minor === 'month') {
      var mS2 = startOfMonth(timelineStart);
      while (comparePartsLT(mS2, addDaysParts(timelineEnd, 1))) {
        var nM2 = (mS2.m === 12) ? { y: mS2.y + 1, m: 1, d: 1 } : { y: mS2.y, m: mS2.m + 1, d: 1 };
        var l2 = Math.max(0, dateToX(mS2));
        var r2 = Math.min(canvasWidth, dateToX(nM2));
        var w2 = r2 - l2;
        if (w2 > 0) {
          minorHTML += '<div class="rm-header-cell" style="position:absolute;left:' + l2 + 'px;width:' + w2 + 'px">' + shortMonth(mS2.m) + '</div>';
        }
        mS2 = nM2;
      }
    }
    minorHTML += '</div>';

    headerEl.innerHTML = majorHTML + minorHTML;
  }

  function renderGrid(bodyHeight) {
    var gridEl = document.getElementById('rmGrid');
    if (!gridEl) return;
    // Body owns sizing; grid fills via inset:0. Set width here for safety.
    gridEl.style.width = canvasWidth + 'px';
    var dayPx = ZOOM_CONFIG[zoom].dayPx;
    var t = todayParts();
    var html = '';

    if (zoom === 'day' || zoom === 'week') {
      // Per-day columns
      for (var i = 0; i < totalDays; i++) {
        var p = addDaysParts(timelineStart, i);
        var isW = isWeekend(p);
        var isStartW = dayOfWeek(p) === ((weekStart === 'Sunday') ? 0 : 1);
        var cls = 'rm-grid-col' + (isW ? ' weekend' : '') + (isStartW ? ' major' : '');
        html += '<div class="' + cls + '" style="left:' + (i * dayPx) + 'px;width:' + dayPx + 'px"></div>';
      }
    } else {
      // Weekly/monthly columns to keep grid lighter
      var stride = (zoom === 'month') ? 7 : 30;
      var wStart = (zoom === 'month') ? startOfWeek(timelineStart) : startOfMonth(timelineStart);
      while (comparePartsLT(wStart, addDaysParts(timelineEnd, 1))) {
        var next = addDaysParts(wStart, stride);
        if (zoom === 'quarter') {
          next = (wStart.m === 12) ? { y: wStart.y + 1, m: 1, d: 1 } : { y: wStart.y, m: wStart.m + 1, d: 1 };
        }
        var x = Math.max(0, dateToX(wStart));
        html += '<div class="rm-grid-col major" style="left:' + x + 'px;width:' + (dateToX(next) - x) + 'px"></div>';
        wStart = next;
      }
    }

    // Today line
    var todayX = dateToX(t) + dayPx / 2;
    html += '<div class="rm-today-line" style="left:' + (todayX - 1) + 'px"></div>';

    gridEl.innerHTML = html;
  }

  // ============================================
  // RENDER: ROWS & BARS
  // ============================================

  function renderRows() {
    var rowsEl = document.getElementById('rmRows');
    if (!rowsEl) return;
    // Body owns sizing; rows fills via inset:0.
    rowsEl.style.width = canvasWidth + 'px';

    var dayPx = ZOOM_CONFIG[zoom].dayPx;
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var isTask = it.kind === 'task';
      var rowClass = 'rm-row' + (isTask ? ' task-row' : '');
      html += '<div class="' + rowClass + '" data-row-index="' + i + '" data-row-id="' + escAttr(it.id) + '" data-row-kind="' + (isTask ? 'task' : 'project') + '" style="top:' + (i * rowH) + 'px">';

      if (isTask) {
        if (it.scheduled) {
          var sp = partsFromISO(it.scheduled);
          if (sp) {
            var tx1 = dateToX(sp);
            var tw = Math.max(20, dayPx);
            var tcls = 'rm-bar task' + (it.isDone ? ' done' : '') + (it.isChecklist ? ' checklist' : '');
            var tbase = 'left:' + tx1 + 'px;width:' + tw + 'px';
            html += '<div class="' + tcls + '" data-id="' + escAttr(it.id) + '" data-task="1" data-filename="' + escAttr(it.filename) + '" data-line-index="' + (it.lineIndex || 0) + '" data-row="' + i + '"' + barStyleForColor(it.color, tbase) + '>';
            html += '<div class="rm-bar-label">' + escHTML(it.title) + '</div>';
            html += '</div>';
          }
        } else {
          html += '<div class="rm-row-ghost-label">Click a cell to schedule this task</div>';
        }
      } else {
        var range = getItemRange(it);
        if (range) {
          var x1 = dateToX(range.start);
          var x2 = dateToX(addDaysParts(range.end, 1)); // exclusive
          var w = Math.max(dayPx * 0.6, x2 - x1);
          var classes = 'rm-bar';
          if (it.ephemeral) {
            classes += ' ephemeral';
          } else if (!it.hasStart || !it.hasEnd) {
            classes += ' placeholder';
          }
          if (it.defer) {
            var defp = partsFromISO(it.defer);
            if (defp && comparePartsLT(todayParts(), defp)) classes += ' deferred';
          }
          if (it.progress === 100) classes += ' complete';
          if (isOverdue(it)) classes += ' overdue';

          var pbase = 'left:' + x1 + 'px;width:' + w + 'px';
          html += '<div class="' + classes + '" data-id="' + escAttr(it.id) + '" data-row="' + i + '"' + barStyleForColor(it.color, pbase) + '>';
          if (it.progress != null && it.progress > 0) {
            var pw = Math.max(0, Math.min(100, it.progress));
            html += '<div class="rm-bar-progress"' + progressStyleForColor(it.color, pw) + '></div>';
          }
          html += '<div class="rm-bar-handle left" data-handle="left"></div>';
          html += '<div class="rm-bar-handle right" data-handle="right"></div>';
          html += '<div class="rm-bar-label">' + escHTML(it.title) + '</div>';
          html += '<div class="rm-bar-link-dot" data-link-dot="1" title="Drag here (or Opt+drag the bar) to add a dependency"></div>';
          html += '</div>';
        } else {
          html += '<div class="rm-row-ghost-label">Drag to schedule</div>';
        }
      }

      // Due marker
      var due = itemDue(it);
      if (due) {
        var xd = dateToX(due) + dayPx / 2;
        html += '<div class="rm-marker due" style="left:' + (xd - 1) + 'px" data-marker="due" title="Due ' + escAttr(it.due) + '"></div>';
      }
      // Defer marker (only if outside the bar)
      var defp2 = itemDefer(it);
      if (defp2) {
        var rng = getItemRange(it);
        var inside = rng && !comparePartsLT(defp2, rng.start) && !comparePartsLT(rng.end, defp2);
        if (!inside) {
          var xdf = dateToX(defp2) + dayPx / 2;
          html += '<div class="rm-marker defer" style="left:' + (xdf - 1) + 'px" title="Defer ' + escAttr(it.defer) + '"></div>';
        }
      }

      html += '</div>';
    }
    rowsEl.innerHTML = html;
  }

  // ============================================
  // RENDER: DEPENDENCIES
  // ============================================

  function renderDeps() {
    var svg = document.getElementById('rmDepsSVG');
    if (!svg) return;
    svg.setAttribute('width', canvasWidth);
    svg.setAttribute('height', items.length * rowH);
    svg.style.width = canvasWidth + 'px';
    svg.style.height = (items.length * rowH) + 'px';

    var idToRow = {};
    var idToItem = {};
    for (var i = 0; i < items.length; i++) {
      idToRow[items[i].id] = i;
      idToItem[items[i].id] = items[i];
    }

    var t = todayParts();
    var paths = '';
    var dayPx = ZOOM_CONFIG[zoom].dayPx;

    // OmniPlan-style arrows: leave the source bar's right edge, turn vertically,
    // and enter the target bar from its TOP edge (or BOTTOM when source is below).
    // Bar geometry inside a row: project bar spans [row*rowH + 6, row*rowH + rowH - 6].
    var BAR_INSET_Y = 6;
    var STEP_OUT = 12;     // horizontal step out of the source before turning
    var ENTER_INSET_X = 10; // how far into the target bar to enter (from its left)
    var APPROACH_GAP = 10;  // vertical run just before the arrow tip
    var ARROW_HALF = 5;
    var ARROW_LEN = 7;

    for (var r = 0; r < items.length; r++) {
      var it = items[r];
      var preqs = it.prerequisites || [];
      if (!preqs.length) continue;
      var iRange = getItemRange(it);
      if (!iRange) continue;
      var targetX_start = dateToX(iRange.start);
      var targetTopY = r * rowH + BAR_INSET_Y;
      var targetBotY = (r + 1) * rowH - BAR_INSET_Y;

      for (var p = 0; p < preqs.length; p++) {
        var preqId = preqs[p];
        var preq = idToItem[preqId];
        if (!preq) continue;
        var preqRow = idToRow[preqId];
        var preqRange = getItemRange(preq);
        if (!preqRange) continue;

        var sourceX = dateToX(addDaysParts(preqRange.end, 1)); // right edge of source bar
        var sourceMidY = preqRow * rowH + rowH / 2;
        var sourceAbove = preqRow < r;
        if (preqRow === r) continue; // skip self-row (shouldn't happen)

        // X where the arrow enters the target bar
        var enterX = targetX_start + ENTER_INSET_X;
        // Out from source then descend/ascend; if target starts before source ends,
        // route around to avoid crossing through the source bar.
        var stepX = sourceX + STEP_OUT;
        if (enterX < stepX) enterX = stepX;

        // Arrow tip lands at the top (or bottom) edge of the target row's bar
        var tipY = sourceAbove ? targetTopY : targetBotY;
        var approachY = sourceAbove ? (tipY - APPROACH_GAP) : (tipY + APPROACH_GAP);

        // Detect a broken dep (prereq ends on or after target's start)
        var broken = comparePartsLT(iRange.start, addDaysParts(preqRange.end, 1));
        var cls = 'rm-dep-path' + (broken ? ' broken' : '');

        // L-shaped path: out → vertical to just-before-tip → over to enterX → final approach
        var d = 'M' + sourceX + ',' + sourceMidY +
          ' L' + stepX + ',' + sourceMidY +
          ' L' + stepX + ',' + approachY +
          ' L' + enterX + ',' + approachY +
          ' L' + enterX + ',' + tipY;

        // Arrow polygon (filled triangle pointing toward the bar edge)
        var arrowPoints;
        if (sourceAbove) {
          arrowPoints = enterX + ',' + tipY + ' ' +
            (enterX - ARROW_HALF) + ',' + (tipY - ARROW_LEN) + ' ' +
            (enterX + ARROW_HALF) + ',' + (tipY - ARROW_LEN);
        } else {
          arrowPoints = enterX + ',' + tipY + ' ' +
            (enterX - ARROW_HALF) + ',' + (tipY + ARROW_LEN) + ' ' +
            (enterX + ARROW_HALF) + ',' + (tipY + ARROW_LEN);
        }

        paths += '<g class="rm-dep-group" data-target="' + escAttr(it.id) + '" data-source="' + escAttr(preqId) + '">';
        paths += '<path class="' + cls + '" d="' + d + '"></path>';
        paths += '<polygon class="rm-dep-arrow" points="' + arrowPoints + '"></polygon>';
        paths += '</g>';
      }
    }

    // Drag draft line
    if (depDraft) {
      paths += '<path class="rm-drag-line" d="M' + depDraft.x1 + ',' + depDraft.y1 + ' L' + depDraft.x2 + ',' + depDraft.y2 + '"></path>';
    }

    svg.innerHTML = paths;
  }

  // ============================================
  // SIDEBAR DECORATION (warn/danger flags)
  // ============================================

  function decorateSidebar() {
    var rows = document.querySelectorAll('#rmSidebarRows .rm-sidebar-row');
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute('data-roadmap-id');
      var it = items[indexOfId(id)];
      if (!it) continue;
      rows[i].classList.remove('warn', 'danger');
      if (isOverdue(it)) rows[i].classList.add('danger');
      else if (it.due) {
        var due = partsFromISO(it.due);
        var t = todayParts();
        var soon = addDaysParts(t, 7);
        if (due && !comparePartsLT(soon, due) && !partsEq(t, due) && comparePartsLT(t, due)) rows[i].classList.add('warn');
      }
    }
  }

  function indexOfId(id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return i;
    return -1;
  }

  // ============================================
  // RENDER ALL
  // ============================================

  function renderAll() {
    if (items.length === 0) return;
    computeTimelineWindow();
    var bodyH = items.length * rowH;
    var canvasEl = document.getElementById('rmCanvas');
    if (canvasEl) canvasEl.style.width = canvasWidth + 'px';
    var bodyEl = document.getElementById('rmBody');
    if (bodyEl) { bodyEl.style.width = canvasWidth + 'px'; bodyEl.style.height = bodyH + 'px'; }
    renderHeader();
    renderGrid(bodyH);
    renderRows();
    renderDeps();
    decorateSidebar();
  }

  // ============================================
  // COLOR HELPERS (per-bar colors from `icon-color` frontmatter)
  // ============================================

  function hexToRgba(hex, alpha) {
    if (!hex) return '';
    var h = String(hex).replace('#', '');
    if (h.length === 3) {
      h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    }
    if (h.length > 6) h = h.substring(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return '';
    var n = parseInt(h, 16);
    var r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function barStyleForColor(color, base) {
    // base = inline 'left: Xpx; width: Ypx;'; returns the full style attribute string
    if (!color) return ' style="' + base + '"';
    var bg = hexToRgba(color, 0.22);
    var border = hexToRgba(color, 0.95);
    return ' style="' + base + ';background-color:' + bg + ';border-color:' + border + '"';
  }
  function progressStyleForColor(color, widthPct) {
    var fill = color ? hexToRgba(color, 0.55) : '';
    return ' style="width:' + widthPct + '%' + (fill ? ';background-color:' + fill : '') + '"';
  }

  // ============================================
  // ESCAPING
  // ============================================

  function escHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ============================================
  // TOOLTIP
  // ============================================

  function ensureTooltip() {
    if (!tooltipEl) tooltipEl = document.getElementById('rmTooltip');
    return tooltipEl;
  }

  function showTooltip(it, ev) {
    var t = ensureTooltip();
    if (!t) return;
    var rows = '';
    function row(k, v) { return '<div class="rm-tooltip-row"><span class="k">' + escHTML(k) + '</span><span class="v">' + escHTML(v) + '</span></div>'; }
    if (it.kind === 'task') {
      if (it.scheduled) rows += row('Scheduled', it.scheduled);
      else rows += row('Scheduled', '— (drag a cell to set)');
      if (it.isDone) rows += row('Status', 'Done');
    } else {
      if (it.start) rows += row('Start', it.start + (it.ephemeralStart ? ' (from tasks)' : ''));
      if (it.end) rows += row('End', it.end + (it.ephemeralEnd ? ' (from tasks)' : ''));
      if (it.due) rows += row('Due', it.due);
      if (it.defer) rows += row('Defer', it.defer);
      if (it.progress != null) rows += row('Progress', it.progress + '%' + (it.progressExplicit ? '' : ' (auto)'));
      if (it.prerequisites && it.prerequisites.length) rows += row('Prereqs', it.prerequisites.join(', '));
    }
    t.innerHTML = '<div class="rm-tooltip-title">' + escHTML(it.title) + '</div>' + rows;
    t.classList.add('show');
    positionTooltip(ev);
  }
  function positionTooltip(ev) {
    var t = ensureTooltip();
    if (!t) return;
    var x = ev.clientX + 12;
    var y = ev.clientY + 12;
    var rect = t.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 8) x = ev.clientX - rect.width - 12;
    if (y + rect.height > window.innerHeight - 8) y = ev.clientY - rect.height - 12;
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }
  function hideTooltip() {
    var t = ensureTooltip();
    if (t) t.classList.remove('show');
  }

  // ============================================
  // TOAST
  // ============================================

  function showToast(msg) {
    var el = document.getElementById('rmToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  // ============================================
  // DRAG & RESIZE
  // ============================================
  // Three mouse-down origins:
  //   1. The link dot on a project bar → start a dependency draft
  //   2. A bar (project or task) → move or resize it
  //   3. Empty area of a row → range-drag to schedule an unscheduled item

  var rangeDrag = null; // { rowIdx, startX, item, anchorDate, endDate, el }

  function onCanvasMouseDown(ev) {
    // Only react to the primary (left) button — right-click and ctrl-click
    // are handled by the contextmenu listener instead, and shouldn't kick off
    // a drag or be interpreted as a click-to-open-note.
    if (ev.button !== 0 || ev.ctrlKey) return;
    var dot = ev.target.closest('[data-link-dot]');
    if (dot) {
      var barFromDot = dot.closest('.rm-bar');
      if (!barFromDot) return;
      startDepDraft(ev, barFromDot);
      return;
    }
    var handle = ev.target.closest('.rm-bar-handle');
    var bar = ev.target.closest('.rm-bar');
    if (bar) {
      // Opt/Alt + drag on a project bar starts a dependency draft instead of
      // moving the bar. Dependencies only originate from project bars.
      if (ev.altKey && !bar.classList.contains('task')) {
        startDepDraft(ev, bar);
        return;
      }
      startBarDrag(ev, bar, handle);
      return;
    }
    // Empty area — range-drag if this row's item is currently unscheduled,
    // OR for any task row (lets you reschedule a task to a new cell).
    var row = ev.target.closest('.rm-row');
    if (!row) return;
    var rowId = row.getAttribute('data-row-id');
    var idx = indexOfId(rowId);
    if (idx < 0) return;
    var it = items[idx];
    // For tasks: ignore — task rescheduling happens by dragging the existing
    // bar, or by clicking a cell when the task has no bar yet.
    if (it.kind === 'task') {
      if (!it.scheduled) startTaskCellSchedule(ev, idx, row);
      return;
    }
    // Projects with no range → range-drag to schedule
    if (!getItemRange(it)) {
      startRangeDrag(ev, idx, row);
    }
  }

  function startBarDrag(ev, bar, handle) {
    ev.preventDefault();
    var id = bar.getAttribute('data-id');
    var idx = indexOfId(id);
    if (idx < 0) return;
    var it = items[idx];

    var isTask = it.kind === 'task';
    var dayPx = ZOOM_CONFIG[zoom].dayPx;

    if (isTask) {
      // Tasks are single-cell — only "move", no resize.
      if (!it.scheduled) return;
      var sp = partsFromISO(it.scheduled);
      drag = {
        kind: 'task',
        id: id,
        filename: it.filename,
        lineIndex: it.lineIndex,
        mode: 'move',
        startX: ev.clientX,
        origStart: sp,
        origEnd: sp,
        bar: bar,
        dayPx: dayPx,
        moved: false,
      };
    } else {
      var range = getItemRange(it);
      if (!range) return;
      drag = {
        kind: 'project',
        id: id,
        mode: handle ? (handle.getAttribute('data-handle') === 'left' ? 'resize-left' : 'resize-right') : 'move',
        startX: ev.clientX,
        origStart: range.start,
        origEnd: range.end,
        bar: bar,
        dayPx: dayPx,
        moved: false,
      };
    }
    bar.classList.add('dragging');
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    hideTooltip();
  }

  function onDragMove(ev) {
    if (!drag) return;
    var dx = ev.clientX - drag.startX;
    var dayDelta = Math.round(dx / drag.dayPx);
    if (dayDelta === 0 && !drag.moved) return;
    drag.moved = true;

    var newStart = drag.origStart, newEnd = drag.origEnd;
    if (drag.mode === 'move') {
      newStart = addDaysParts(drag.origStart, dayDelta);
      newEnd = addDaysParts(drag.origEnd, dayDelta);
    } else if (drag.mode === 'resize-left') {
      newStart = addDaysParts(drag.origStart, dayDelta);
      if (comparePartsLT(drag.origEnd, newStart)) newStart = drag.origEnd;
    } else if (drag.mode === 'resize-right') {
      newEnd = addDaysParts(drag.origEnd, dayDelta);
      if (comparePartsLT(newEnd, drag.origStart)) newEnd = drag.origStart;
    }

    var x1 = dateToX(newStart);
    var x2 = dateToX(addDaysParts(newEnd, 1));
    drag.bar.style.left = x1 + 'px';
    drag.bar.style.width = Math.max(drag.dayPx * 0.6, x2 - x1) + 'px';
    drag.pendingStart = newStart;
    drag.pendingEnd = newEnd;

    var idx = indexOfId(drag.id);
    if (idx >= 0) {
      if (drag.kind === 'task') {
        items[idx].scheduled = partsToISO(newStart);
      } else {
        items[idx].start = partsToISO(newStart);
        items[idx].end = partsToISO(newEnd);
      }
    }
    renderDeps();
  }

  function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    if (!drag) return;
    drag.bar.classList.remove('dragging');
    if (drag.moved && drag.pendingStart && drag.pendingEnd) {
      if (drag.kind === 'task') {
        sendMessageToPlugin('scheduleTask', JSON.stringify({
          filename: drag.filename,
          lineIndex: drag.lineIndex,
          date: partsToISO(drag.pendingStart),
        }));
        showToast('Rescheduled · ' + partsToISO(drag.pendingStart));
      } else {
        var patch = { id: drag.id };
        if (drag.mode === 'move' || drag.mode === 'resize-left') patch.start = partsToISO(drag.pendingStart);
        if (drag.mode === 'move' || drag.mode === 'resize-right') patch.end = partsToISO(drag.pendingEnd);
        sendMessageToPlugin('updateDates', JSON.stringify(patch));
        showToast('Updated dates · ' + partsToISO(drag.pendingStart) + ' → ' + partsToISO(drag.pendingEnd));
      }
    } else if (!drag.moved) {
      // Click: open underlying note
      var idx = indexOfId(drag.id);
      if (idx >= 0) sendMessageToPlugin('openNote', JSON.stringify({ filename: items[idx].filename, title: items[idx].title }));
    }
    drag = null;
  }

  // ============================================
  // RANGE-DRAG SCHEDULING (empty project row)
  // ============================================

  function startRangeDrag(ev, rowIdx, row) {
    ev.preventDefault();
    var pt = eventToCanvasPoint(ev);
    var dayPx = ZOOM_CONFIG[zoom].dayPx;
    var startDate = xToDate(pt.x);
    var el = document.createElement('div');
    el.className = 'rm-range-select';
    el.style.left = dateToX(startDate) + 'px';
    el.style.width = dayPx + 'px';
    row.appendChild(el);
    rangeDrag = {
      rowIdx: rowIdx,
      itemId: items[rowIdx].id,
      kind: 'project',
      startDate: startDate,
      endDate: startDate,
      el: el,
      moved: false,
    };
    document.addEventListener('mousemove', onRangeMove);
    document.addEventListener('mouseup', onRangeEnd);
  }

  function startTaskCellSchedule(ev, rowIdx, row) {
    ev.preventDefault();
    var pt = eventToCanvasPoint(ev);
    var dayPx = ZOOM_CONFIG[zoom].dayPx;
    var startDate = xToDate(pt.x);
    var el = document.createElement('div');
    el.className = 'rm-range-select';
    el.style.left = dateToX(startDate) + 'px';
    el.style.width = dayPx + 'px';
    row.appendChild(el);
    rangeDrag = {
      rowIdx: rowIdx,
      itemId: items[rowIdx].id,
      kind: 'task',
      startDate: startDate,
      endDate: startDate,
      el: el,
      moved: false,
    };
    document.addEventListener('mousemove', onRangeMove);
    document.addEventListener('mouseup', onRangeEnd);
  }

  function onRangeMove(ev) {
    if (!rangeDrag) return;
    var pt = eventToCanvasPoint(ev);
    var d = xToDate(pt.x);
    // For tasks, lock the range to a single day (the latest hovered cell)
    if (rangeDrag.kind === 'task') {
      rangeDrag.startDate = d;
      rangeDrag.endDate = d;
    } else {
      rangeDrag.endDate = d;
    }
    rangeDrag.moved = true;
    var s = rangeDrag.startDate, e = rangeDrag.endDate;
    if (comparePartsLT(e, s)) { var tmp = s; s = e; e = tmp; }
    var x1 = dateToX(s);
    var x2 = dateToX(addDaysParts(e, 1));
    rangeDrag.el.style.left = x1 + 'px';
    rangeDrag.el.style.width = Math.max(ZOOM_CONFIG[zoom].dayPx, x2 - x1) + 'px';
  }

  function onRangeEnd() {
    document.removeEventListener('mousemove', onRangeMove);
    document.removeEventListener('mouseup', onRangeEnd);
    if (!rangeDrag) return;
    var rd = rangeDrag;
    rangeDrag = null;
    if (rd.el && rd.el.parentNode) rd.el.parentNode.removeChild(rd.el);

    if (rd.kind === 'task') {
      var it = items[rd.rowIdx];
      sendMessageToPlugin('scheduleTask', JSON.stringify({
        filename: it.filename,
        lineIndex: it.lineIndex,
        date: partsToISO(rd.startDate),
      }));
      showToast('Scheduled · ' + partsToISO(rd.startDate));
    } else {
      var s = rd.startDate, e = rd.endDate;
      if (comparePartsLT(e, s)) { var tmp = s; s = e; e = tmp; }
      sendMessageToPlugin('updateDates', JSON.stringify({
        id: rd.itemId,
        start: partsToISO(s),
        end: partsToISO(e),
      }));
      showToast('Scheduled · ' + partsToISO(s) + ' → ' + partsToISO(e));
    }
  }

  // ============================================
  // DEPENDENCY DRAFTING
  // ============================================

  function startDepDraft(ev, bar) {
    ev.preventDefault();
    var sourceId = bar.getAttribute('data-id');
    var rowIdx = indexOfId(sourceId);
    if (rowIdx < 0) return;
    var range = getItemRange(items[rowIdx]);
    if (!range) return;
    var sourceX = dateToX(addDaysParts(range.end, 1));
    var sourceY = rowIdx * rowH + rowH / 2;
    depDraft = { sourceId: sourceId, x1: sourceX, y1: sourceY, x2: sourceX, y2: sourceY };
    document.addEventListener('mousemove', onDepDraftMove);
    document.addEventListener('mouseup', onDepDraftEnd);
    renderDeps();
  }

  function eventToCanvasPoint(ev) {
    var rowsEl = document.getElementById('rmRows');
    if (!rowsEl) return { x: ev.clientX, y: ev.clientY };
    var rect = rowsEl.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function onDepDraftMove(ev) {
    if (!depDraft) return;
    var pt = eventToCanvasPoint(ev);
    depDraft.x2 = pt.x;
    depDraft.y2 = pt.y;
    renderDeps();
  }

  function onDepDraftEnd(ev) {
    document.removeEventListener('mousemove', onDepDraftMove);
    document.removeEventListener('mouseup', onDepDraftEnd);
    if (!depDraft) return;
    var bar = ev.target.closest('.rm-bar');
    if (bar) {
      if (bar.classList.contains('task')) {
        showToast('Dependencies link projects, not tasks');
      } else {
        var targetId = bar.getAttribute('data-id');
        if (targetId && targetId !== depDraft.sourceId) {
          sendMessageToPlugin('addPrerequisite', JSON.stringify({ id: targetId, prerequisite: depDraft.sourceId }));
          showToast('Linked: ' + depDraft.sourceId + ' → ' + targetId);
        }
      }
    }
    depDraft = null;
    renderDeps();
  }

  function onDepClick(ev) {
    var grp = ev.target.closest('.rm-dep-group');
    if (!grp) return;
    var target = grp.getAttribute('data-target');
    var source = grp.getAttribute('data-source');
    if (!target || !source) return;
    if (confirm('Remove dependency "' + source + '" → "' + target + '"?')) {
      sendMessageToPlugin('removePrerequisite', JSON.stringify({ id: target, prerequisite: source }));
    }
  }

  // ============================================
  // BAR HOVER → TOOLTIP
  // ============================================

  function onCanvasMouseMove(ev) {
    if (drag || depDraft) return;
    var bar = ev.target.closest('.rm-bar');
    if (bar) {
      var id = bar.getAttribute('data-id');
      var idx = indexOfId(id);
      if (idx >= 0) {
        showTooltip(items[idx], ev);
        return;
      }
    }
    hideTooltip();
  }

  // ============================================
  // SIDEBAR CLICK → SCROLL TO BAR
  // ============================================

  // ============================================
  // SIDEBAR CONTEXT MENU (right-click on project rows)
  // ============================================

  // ctx = { kind: 'sidebar' | 'bar-project' | 'bar-task', id, filename,
  //         lineIndex? (for tasks), item }
  function showContextMenu(x, y, ctx) {
    var menu = document.getElementById('rmContextMenu');
    if (!menu) return;
    menu.dataset.targetId = ctx.id || '';
    menu.dataset.targetFilename = ctx.filename || '';
    menu.dataset.targetLineIndex = (ctx.lineIndex != null) ? String(ctx.lineIndex) : '';

    // First pass: hide/show items by their declared contexts
    var elements = menu.querySelectorAll('[data-ctx]');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var ctxList = el.getAttribute('data-ctx').split(/\s+/);
      el.style.display = (ctxList.indexOf(ctx.kind) >= 0) ? '' : 'none';
    }

    // Second pass: hide items whose `data-needs` precondition isn't met
    var flags = {};
    if (ctx.item) {
      flags['start'] = !!ctx.item.start && !ctx.item.ephemeralStart;
      flags['end'] = !!ctx.item.end && !ctx.item.ephemeralEnd;
      flags['due'] = !!ctx.item.due;
      flags['defer'] = !!ctx.item.defer;
      flags['any-date'] = flags['start'] || flags['end'] || flags['due'] || flags['defer'];
      flags['scheduled'] = !!ctx.item.scheduled;
    }
    var needsEls = menu.querySelectorAll('[data-needs]');
    for (var j = 0; j < needsEls.length; j++) {
      var ne = needsEls[j];
      if (ne.style.display === 'none') continue; // already hidden by ctx mismatch
      if (!flags[ne.getAttribute('data-needs')]) ne.style.display = 'none';
    }

    // Highlight the active color swatch (only relevant for sidebar / bar-project)
    var swatches = menu.querySelectorAll('.rm-color-swatch');
    for (var s = 0; s < swatches.length; s++) swatches[s].classList.remove('selected');
    var current = ctx.item ? (ctx.item.colorName || '') : '';
    for (var s2 = 0; s2 < swatches.length; s2++) {
      if (swatches[s2].getAttribute('data-color') === current) {
        swatches[s2].classList.add('selected');
        break;
      }
    }

    menu.classList.add('open');
    // Position; clamp to viewport
    var rect = menu.getBoundingClientRect();
    var maxX = window.innerWidth - rect.width - 6;
    var maxY = window.innerHeight - rect.height - 6;
    menu.style.left = Math.min(x, maxX) + 'px';
    menu.style.top = Math.min(y, maxY) + 'px';
  }

  function hideContextMenu() {
    var menu = document.getElementById('rmContextMenu');
    if (menu) menu.classList.remove('open');
  }

  function onSidebarContextMenu(ev) {
    var row = ev.target.closest('.rm-sidebar-row');
    if (!row) return;
    ev.preventDefault();
    hideTooltip();
    var id = row.getAttribute('data-roadmap-id');
    var item = lookupItemById(id);
    if (!item) return;
    var lineIndex = row.getAttribute('data-line-index');
    showContextMenu(ev.clientX, ev.clientY, {
      kind: item.kind,
      id: id,
      filename: row.getAttribute('data-filename'),
      lineIndex: lineIndex ? parseInt(lineIndex, 10) : item.lineIndex,
      item: item,
    });
  }

  function onCanvasContextMenu(ev) {
    var bar = ev.target.closest('.rm-bar');
    if (!bar) return;
    ev.preventDefault();
    var id = bar.getAttribute('data-id');
    var item = lookupItemById(id);
    if (!item) return;
    hideTooltip();
    showContextMenu(ev.clientX, ev.clientY, {
      kind: item.kind,
      id: id,
      filename: item.filename,
      lineIndex: item.lineIndex,
      item: item,
    });
  }

  function lookupItemById(id) {
    if (!id) return null;
    for (var i = 0; i < allItems.length; i++) {
      if (allItems[i].id === id) return allItems[i];
    }
    return null;
  }

  function onContextMenuClick(ev) {
    var menu = document.getElementById('rmContextMenu');
    if (!menu) return;
    var targetId = menu.dataset.targetId;
    var targetFilename = menu.dataset.targetFilename;

    // Color swatch click
    var swatch = ev.target.closest('.rm-color-swatch');
    if (swatch) {
      var color = swatch.getAttribute('data-color') || '';
      hideContextMenu();
      sendMessageToPlugin('setColor', JSON.stringify({
        id: targetId, filename: targetFilename, color: color,
      }));
      return;
    }

    var btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    hideContextMenu();
    var payload = { id: targetId, filename: targetFilename };
    var li = menu.dataset.targetLineIndex;
    if (li !== '') payload.lineIndex = li;
    sendMessageToPlugin(action, JSON.stringify(payload));
  }

  function onSidebarMouseMove(ev) {
    if (sidebarDrag) return;
    var row = ev.target.closest('.rm-sidebar-row');
    if (!row) { hideTooltip(); return; }
    // Skip if hover is over the chevron — keep the click hint
    if (ev.target.closest('.rm-chev')) { hideTooltip(); return; }
    var id = row.getAttribute('data-roadmap-id');
    var idx = indexOfId(id);
    if (idx < 0) { hideTooltip(); return; }
    showTooltip(items[idx], ev);
  }

  function onSidebarClick(ev) {
    // Chevron expand/collapse — pure client-side toggle, no server roundtrip.
    var chev = ev.target.closest('.rm-chev');
    if (chev) {
      ev.stopPropagation();
      var cid = chev.getAttribute('data-chev-id');
      if (collapsedSet[cid]) delete collapsedSet[cid];
      else collapsedSet[cid] = true;
      items = applyCollapse(allItems, collapsedSet);
      reflowSidebar();
      renderAll();
      // Persist for next session (does not block the UI; no refresh follows).
      var arr = Object.keys(collapsedSet);
      sendMessageToPlugin('savePrefs', JSON.stringify({ collapsedIds: JSON.stringify(arr) }));
      return;
    }
    var row = ev.target.closest('.rm-sidebar-row');
    if (!row) return;
    var id = row.getAttribute('data-roadmap-id');
    var filename = row.getAttribute('data-filename');
    var kind = row.getAttribute('data-kind');
    if (ev.metaKey || ev.ctrlKey || ev.altKey) {
      // For tasks, the underlying file is the same; opening still works.
      sendMessageToPlugin('openNote', JSON.stringify({ filename: filename }));
      return;
    }
    var idx = indexOfId(id);
    if (idx < 0) return;
    var it = items[idx];
    var wrap = document.getElementById('rmCanvasWrap');
    if (!wrap) return;
    var targetX;
    if (kind === 'task' && it.scheduled) {
      var sp = partsFromISO(it.scheduled);
      targetX = Math.max(0, dateToX(sp) - 60);
    } else {
      var range = getItemRange(it);
      if (range) targetX = Math.max(0, dateToX(range.start) - 60);
      else targetX = Math.max(0, dateToX(todayParts()) - 60);
    }
    wrap.scrollTo({ left: targetX, top: idx * rowH, behavior: 'smooth' });
    document.querySelectorAll('.rm-sidebar-row.highlight').forEach(function (n) { n.classList.remove('highlight'); });
    row.classList.add('highlight');
    setTimeout(function () { row.classList.remove('highlight'); }, 1500);
  }

  // ============================================
  // SIDEBAR DRAG-AND-DROP (reparent / reorder)
  // ============================================
  // Uses HTML5 native DnD. Project rows are draggable; tasks are not (they
  // live alongside their note's tasks via paragraph order). Drop semantics:
  //   - top-third of a row → insert before (same parent as target)
  //   - bottom-third       → insert after (same parent as target)
  //   - middle-third       → reparent into the target (becomes its child)

  var sidebarDrag = null;

  function onSidebarDragStart(ev) {
    var row = ev.target.closest('.rm-sidebar-row');
    if (!row || row.getAttribute('data-kind') !== 'project') { ev.preventDefault(); return; }
    sidebarDrag = {
      id: row.getAttribute('data-roadmap-id'),
      parentId: row.getAttribute('data-parent-id') || '',
    };
    row.classList.add('dragging');
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/plain', sidebarDrag.id); } catch (e) { }
    }
  }

  function clearDropIndicators() {
    document.querySelectorAll('.rm-sidebar-row.drop-into, .rm-sidebar-row.drop-before, .rm-sidebar-row.drop-after')
      .forEach(function (n) { n.classList.remove('drop-into', 'drop-before', 'drop-after'); });
  }

  function dropZoneFor(row, ev) {
    var rect = row.getBoundingClientRect();
    var rel = (ev.clientY - rect.top) / rect.height;
    if (rel < 0.33) return 'before';
    if (rel > 0.67) return 'after';
    return 'into';
  }

  function isDescendantOf(itemId, ancestorId) {
    // True iff itemId is a descendant of ancestorId in the current ordered tree
    if (!ancestorId || itemId === ancestorId) return itemId === ancestorId;
    var byId = {};
    for (var i = 0; i < items.length; i++) byId[items[i].id] = items[i];
    var cur = byId[itemId];
    while (cur && cur.parentId) {
      if (cur.parentId === ancestorId) return true;
      cur = byId[cur.parentId];
    }
    return false;
  }

  function onSidebarDragOver(ev) {
    if (!sidebarDrag) return;
    var row = ev.target.closest('.rm-sidebar-row');
    if (!row) return;
    if (row.getAttribute('data-kind') === 'task') return; // can't drop on tasks
    var targetId = row.getAttribute('data-roadmap-id');
    if (targetId === sidebarDrag.id) return; // self
    if (isDescendantOf(targetId, sidebarDrag.id)) return; // would orphan
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    clearDropIndicators();
    row.classList.add('drop-' + dropZoneFor(row, ev));
  }

  function onSidebarDragLeave(ev) {
    var row = ev.target.closest('.rm-sidebar-row');
    if (row) row.classList.remove('drop-into', 'drop-before', 'drop-after');
  }

  function onSidebarDrop(ev) {
    if (!sidebarDrag) return;
    var row = ev.target.closest('.rm-sidebar-row');
    if (!row) { clearDropIndicators(); sidebarDrag = null; return; }
    if (row.getAttribute('data-kind') === 'task') { clearDropIndicators(); sidebarDrag = null; return; }
    var targetId = row.getAttribute('data-roadmap-id');
    if (targetId === sidebarDrag.id || isDescendantOf(targetId, sidebarDrag.id)) {
      clearDropIndicators(); sidebarDrag = null; return;
    }
    ev.preventDefault();
    var zone = dropZoneFor(row, ev);
    clearDropIndicators();

    var newParentId = '';
    if (zone === 'into') {
      newParentId = targetId;
    } else {
      newParentId = row.getAttribute('data-parent-id') || '';
    }

    // Build the new ordered list of *project* siblings under newParentId
    var byId = {};
    for (var i = 0; i < items.length; i++) byId[items[i].id] = items[i];
    var siblings = [];
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      if (it.kind !== 'project') continue;
      if ((it.parentId || '') !== newParentId) continue;
      if (it.id === sidebarDrag.id) continue;
      siblings.push(it.id);
    }
    // Find insert index
    var draggedId = sidebarDrag.id;
    if (zone === 'into') {
      siblings.push(draggedId); // append as last child
    } else {
      var refIdx = siblings.indexOf(targetId);
      if (refIdx < 0) refIdx = siblings.length;
      if (zone === 'after') refIdx += 1;
      siblings.splice(refIdx, 0, draggedId);
    }

    sendMessageToPlugin('reorderItems', JSON.stringify({
      parentId: newParentId,
      orderedIds: siblings,
    }));
    showToast('Moved · ' + draggedId);
    sidebarDrag = null;
  }

  function onSidebarDragEnd() {
    document.querySelectorAll('.rm-sidebar-row.dragging').forEach(function (n) { n.classList.remove('dragging'); });
    clearDropIndicators();
    sidebarDrag = null;
  }

  // ============================================
  // TOOLBAR
  // ============================================

  function onZoomClick(ev) {
    var btn = ev.target.closest('.rm-zoom-btn');
    if (!btn) return;
    var newZoom = btn.getAttribute('data-zoom');
    if (!newZoom || newZoom === zoom) return;
    zoom = newZoom;
    document.querySelectorAll('.rm-zoom-btn').forEach(function (n) { n.classList.remove('active'); });
    btn.classList.add('active');
    sendMessageToPlugin('savePrefs', JSON.stringify({ lastZoom: zoom }));
    renderAll();
    scrollToToday();
  }

  function scrollToToday() {
    var wrap = document.getElementById('rmCanvasWrap');
    if (!wrap) return;
    var t = todayParts();
    var x = Math.max(0, dateToX(t) - wrap.clientWidth / 2);
    wrap.scrollTo({ left: x, top: wrap.scrollTop, behavior: 'smooth' });
  }

  // ============================================
  // PLUGIN MESSAGE HANDLER
  // ============================================

  onMessageFromPlugin = function (type, payload) {
    if (type === 'ROADMAP_DATA' && payload && payload.data) {
      data = payload.data;
      allItems = data.items || [];
      // Keep the local collapsedSet as-is so an in-flight save/refresh from
      // another action doesn't visually expand things the user just collapsed.
      items = applyCollapse(allItems, collapsedSet);
      reflowSidebar();
      renderAll();
      scrollPreserved();
    } else if (type === 'FULL_REFRESH') {
      window.location.reload();
    } else if (type === 'SHOW_TOAST') {
      showToast(payload.message || '');
    }
  };

  function renderSidebarRow(it, isCollapsed) {
    var depth = (it.depth || 0) + (it.indents || 0);
    var indent = depth * 14;
    var isTask = it.kind === 'task';
    var pTxt = '';
    if (!isTask) pTxt = (it.progress == null) ? '—' : (it.progress + '%');
    var chev;
    if (it.hasChildren) {
      chev = '<button class="rm-chev' + (isCollapsed ? ' collapsed' : '') + '" data-chev-id="' + escAttr(it.id) + '" title="Collapse/expand"><i class="fa-solid ' + (isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down') + '"></i></button>';
    } else {
      chev = '<span class="rm-chev-spacer"></span>';
    }
    var iconStyle = it.color ? (' style="color:' + it.color + '"') : '';
    var icon = isTask
      ? '<i class="rm-row-icon fa-regular ' + (it.isDone ? 'fa-square-check' : (it.isChecklist ? 'fa-square' : 'fa-circle')) + '"' + iconStyle + '></i>'
      : '<i class="rm-row-icon fa-solid fa-file-lines"' + iconStyle + '></i>';
    var dragAttr = !isTask ? ' draggable="true"' : '';
    var classes = 'rm-sidebar-row' + (isTask ? ' task' : ' project') + (it.isDone ? ' done' : '');
    var data = ' data-roadmap-id="' + escAttr(it.id) + '"' +
      ' data-kind="' + (isTask ? 'task' : 'project') + '"' +
      ' data-filename="' + escAttr(it.filename) + '"' +
      (isTask ? ' data-line-index="' + (it.lineIndex || 0) + '"' : '') +
      ' data-parent-id="' + escAttr(it.parentId || '') + '"';
    var html = '<div class="' + classes + '"' + data + dragAttr + ' style="padding-left:' + (8 + indent) + 'px" title="' + escAttr(it.title) + '">';
    html += chev + icon;
    html += '<div class="rm-sidebar-row-title">' + escHTML(it.title) + '</div>';
    if (pTxt) html += '<div class="rm-sidebar-row-progress">' + escHTML(pTxt) + '</div>';
    html += '</div>';
    return html;
  }

  function reflowSidebar() {
    var holder = document.getElementById('rmSidebarRows');
    if (!holder) return;
    if (items.length === 0) {
      holder.innerHTML = '<div class="rm-sidebar-empty">No roadmap items yet.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < items.length; i++) {
      html += renderSidebarRow(items[i], collapsedSet[items[i].id]);
    }
    holder.innerHTML = html;
  }

  var savedScroll = null;
  function scrollPreserved() {
    if (savedScroll) {
      var wrap = document.getElementById('rmCanvasWrap');
      if (wrap) wrap.scrollTo({ left: savedScroll.left, top: savedScroll.top });
      savedScroll = null;
    }
  }

  // ============================================
  // INIT
  // ============================================

  document.addEventListener('DOMContentLoaded', function () {
    // Initial render
    renderAll();
    // Center on today for first display
    if (data.scrollDate) {
      var p = partsFromISO(data.scrollDate);
      if (p) {
        var wrap = document.getElementById('rmCanvasWrap');
        if (wrap) wrap.scrollLeft = Math.max(0, dateToX(p) - 80);
      }
    } else {
      scrollToToday();
    }

    var canvasWrap = document.getElementById('rmCanvasWrap');
    var rowsEl = document.getElementById('rmRows');
    var depsEl = document.getElementById('rmDepsSVG');

    if (rowsEl) {
      rowsEl.addEventListener('mousedown', onCanvasMouseDown);
      rowsEl.addEventListener('mousemove', onCanvasMouseMove);
      rowsEl.addEventListener('mouseleave', hideTooltip);
      rowsEl.addEventListener('contextmenu', onCanvasContextMenu);
    }
    if (depsEl) {
      depsEl.addEventListener('click', onDepClick);
    }

    var sidebar = document.getElementById('rmSidebarRows');
    if (sidebar) {
      sidebar.addEventListener('click', onSidebarClick);
      sidebar.addEventListener('mousemove', onSidebarMouseMove);
      sidebar.addEventListener('mouseleave', hideTooltip);
      sidebar.addEventListener('contextmenu', onSidebarContextMenu);
      // HTML5 DnD for sidebar reparent/reorder
      sidebar.addEventListener('dragstart', onSidebarDragStart);
      sidebar.addEventListener('dragover', onSidebarDragOver);
      sidebar.addEventListener('dragleave', onSidebarDragLeave);
      sidebar.addEventListener('drop', onSidebarDrop);
      sidebar.addEventListener('dragend', onSidebarDragEnd);
    }

    // Context menu wiring (one global click dismisses, one on the menu acts)
    var ctxMenu = document.getElementById('rmContextMenu');
    if (ctxMenu) ctxMenu.addEventListener('click', onContextMenuClick);
    document.addEventListener('mousedown', function (ev) {
      var inside = ev.target.closest('#rmContextMenu');
      if (!inside) hideContextMenu();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') hideContextMenu();
    });
    var canvasWrapForCtx = document.getElementById('rmCanvasWrap');
    if (canvasWrapForCtx) canvasWrapForCtx.addEventListener('scroll', hideContextMenu);

    // Sidebar resize
    var sidebarEl = document.getElementById('rmSidebar');
    var resizeEl = document.getElementById('rmSidebarResize');
    if (sidebarEl && resizeEl) {
      var rs = null;
      resizeEl.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        rs = {
          startX: ev.clientX,
          startW: sidebarEl.getBoundingClientRect().width,
        };
        resizeEl.classList.add('dragging');
        document.body.classList.add('rm-resizing');
        document.addEventListener('mousemove', moveR);
        document.addEventListener('mouseup', endR);
      });
      function moveR(ev) {
        if (!rs) return;
        var w = rs.startW + (ev.clientX - rs.startX);
        if (w < 140) w = 140;
        if (w > 800) w = 800;
        sidebarEl.style.width = w + 'px';
      }
      function endR() {
        if (!rs) return;
        var finalW = Math.round(sidebarEl.getBoundingClientRect().width);
        rs = null;
        resizeEl.classList.remove('dragging');
        document.body.classList.remove('rm-resizing');
        document.removeEventListener('mousemove', moveR);
        document.removeEventListener('mouseup', endR);
        sendMessageToPlugin('savePrefs', JSON.stringify({ sidebarWidth: finalW }));
      }
    }

    var zoomBtns = document.getElementById('rmZoomBtns');
    if (zoomBtns) zoomBtns.addEventListener('click', onZoomClick);

    var todayBtn = document.getElementById('rmTodayBtn');
    if (todayBtn) todayBtn.addEventListener('click', scrollToToday);

    var showDoneBtn = document.getElementById('rmShowDoneBtn');
    if (showDoneBtn) showDoneBtn.addEventListener('click', function () {
      var newVal = !showDoneBtn.classList.contains('active');
      showDoneBtn.classList.toggle('active', newVal);
      sendMessageToPlugin('toggleShowCompletedTasks', JSON.stringify({ value: newVal }));
    });


    // Save scroll position on scroll (debounced)
    var saveT = null;
    if (canvasWrap) {
      canvasWrap.addEventListener('scroll', function () {
        if (saveT) clearTimeout(saveT);
        saveT = setTimeout(function () {
          var midX = canvasWrap.scrollLeft + canvasWrap.clientWidth / 2;
          var midDate = xToDate(midX);
          sendMessageToPlugin('savePrefs', JSON.stringify({ lastScrollDate: partsToISO(midDate) }));
        }, 600);
      });
    }
  });

  // onMessageFromPlugin is already exposed via the module-level var above.
})();
