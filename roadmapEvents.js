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
  var items = data.items || [];
  var zoom = data.zoom || 'week';
  var weekStart = data.weekStart || 'Monday';
  var rowH = 36;

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
      html += '<div class="rm-row" data-row-index="' + i + '" style="top:' + (i * rowH) + 'px">';

      var range = getItemRange(it);
      if (range) {
        var x1 = dateToX(range.start);
        var x2 = dateToX(addDaysParts(range.end, 1)); // exclusive
        var w = Math.max(dayPx * 0.6, x2 - x1);
        var classes = 'rm-bar';
        if (!it.hasStart || !it.hasEnd) classes += ' placeholder';
        if (it.defer) {
          var defp = partsFromISO(it.defer);
          if (defp && comparePartsLT(todayParts(), defp)) classes += ' deferred';
        }
        if (it.progress === 100) classes += ' complete';
        if (isOverdue(it)) classes += ' overdue';

        html += '<div class="' + classes + '" data-id="' + escAttr(it.id) + '" data-row="' + i + '" style="left:' + x1 + 'px;width:' + w + 'px">';
        if (it.progress != null && it.progress > 0) {
          var pw = Math.max(0, Math.min(100, it.progress));
          html += '<div class="rm-bar-progress" style="width:' + pw + '%"></div>';
        }
        html += '<div class="rm-bar-handle left" data-handle="left"></div>';
        html += '<div class="rm-bar-handle right" data-handle="right"></div>';
        html += '<div class="rm-bar-label">' + escHTML(it.title) + (it.progress != null ? ' · ' + it.progress + '%' : '') + '</div>';
        html += '<div class="rm-bar-link-dot" data-link-dot="1" title="Drag to a row to add a dependency"></div>';
        html += '</div>';
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

    for (var r = 0; r < items.length; r++) {
      var it = items[r];
      var preqs = it.prerequisites || [];
      if (!preqs.length) continue;
      var iRange = getItemRange(it);
      if (!iRange) continue;
      var targetX = dateToX(iRange.start);
      var targetY = r * rowH + rowH / 2;

      for (var p = 0; p < preqs.length; p++) {
        var preqId = preqs[p];
        var preq = idToItem[preqId];
        if (!preq) {
          // Unknown prereq → draw a small badge later? For now, skip drawing arrow.
          continue;
        }
        var preqRow = idToRow[preqId];
        var preqRange = getItemRange(preq);
        if (!preqRange) continue;
        var sourceX = dateToX(addDaysParts(preqRange.end, 1));
        var sourceY = preqRow * rowH + rowH / 2;

        // Path: from source out to right, down/up, then in to target's left
        var dx = Math.max(12, (targetX - sourceX) / 2);
        var midX1 = sourceX + Math.max(8, Math.min(40, dx));
        var midX2 = targetX - Math.max(8, Math.min(40, dx));
        // Detect broken dep: prereq.end > target.start (timeline conflict)
        var broken = comparePartsLT(iRange.start, addDaysParts(preqRange.end, 1));
        var cls = 'rm-dep-path' + (broken ? ' broken' : '');

        var d = 'M' + sourceX + ',' + sourceY +
          ' L' + midX1 + ',' + sourceY +
          ' L' + midX1 + ',' + targetY +
          ' L' + (targetX - 6) + ',' + targetY;

        paths += '<g class="rm-dep-group" data-target="' + escAttr(it.id) + '" data-source="' + escAttr(preqId) + '">';
        paths += '<path class="' + cls + '" d="' + d + '"></path>';
        paths += '<polygon class="rm-dep-arrow" points="' + targetX + ',' + targetY + ' ' + (targetX - 8) + ',' + (targetY - 4) + ' ' + (targetX - 8) + ',' + (targetY + 4) + '"></polygon>';
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
    if (it.start) rows += row('Start', it.start);
    if (it.end) rows += row('End', it.end);
    if (it.due) rows += row('Due', it.due);
    if (it.defer) rows += row('Defer', it.defer);
    if (it.progress != null) rows += row('Progress', it.progress + '%' + (it.progressExplicit ? '' : ' (auto)'));
    if (it.prerequisites && it.prerequisites.length) rows += row('Prereqs', it.prerequisites.join(', '));
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

  function onCanvasMouseDown(ev) {
    var dot = ev.target.closest('[data-link-dot]');
    if (dot) {
      var barFromDot = dot.closest('.rm-bar');
      if (!barFromDot) return;
      startDepDraft(ev, barFromDot);
      return;
    }
    var handle = ev.target.closest('.rm-bar-handle');
    var bar = ev.target.closest('.rm-bar');
    if (!bar) return;

    ev.preventDefault();
    var id = bar.getAttribute('data-id');
    var it = items[indexOfId(id)];
    if (!it) return;
    var range = getItemRange(it);
    if (!range) return;

    var dayPx = ZOOM_CONFIG[zoom].dayPx;
    drag = {
      id: id,
      mode: handle ? (handle.getAttribute('data-handle') === 'left' ? 'resize-left' : 'resize-right') : 'move',
      startX: ev.clientX,
      origStart: range.start,
      origEnd: range.end,
      bar: bar,
      dayPx: dayPx,
      moved: false,
    };
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

    // Optimistic visual update
    var x1 = dateToX(newStart);
    var x2 = dateToX(addDaysParts(newEnd, 1));
    drag.bar.style.left = x1 + 'px';
    drag.bar.style.width = Math.max(drag.dayPx * 0.6, x2 - x1) + 'px';
    drag.pendingStart = newStart;
    drag.pendingEnd = newEnd;

    // Update local items array for live dep recompute
    var idx = indexOfId(drag.id);
    if (idx >= 0) {
      items[idx].start = partsToISO(newStart);
      items[idx].end = partsToISO(newEnd);
    }
    renderDeps();
  }

  function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    if (!drag) return;
    drag.bar.classList.remove('dragging');
    if (drag.moved && drag.pendingStart && drag.pendingEnd) {
      var patch = { id: drag.id };
      if (drag.mode === 'move' || drag.mode === 'resize-left') patch.start = partsToISO(drag.pendingStart);
      if (drag.mode === 'move' || drag.mode === 'resize-right') patch.end = partsToISO(drag.pendingEnd);
      sendMessageToPlugin('updateDates', JSON.stringify(patch));
      showToast('Updated dates · ' + partsToISO(drag.pendingStart) + ' → ' + partsToISO(drag.pendingEnd));
    } else if (!drag.moved) {
      // Treat as click: open note
      var idx = indexOfId(drag.id);
      if (idx >= 0) sendMessageToPlugin('openNote', JSON.stringify({ filename: items[idx].filename, title: items[idx].title }));
    }
    drag = null;
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
      var targetId = bar.getAttribute('data-id');
      if (targetId && targetId !== depDraft.sourceId) {
        sendMessageToPlugin('addPrerequisite', JSON.stringify({ id: targetId, prerequisite: depDraft.sourceId }));
        showToast('Linked: ' + depDraft.sourceId + ' → ' + targetId);
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

  function onSidebarClick(ev) {
    var row = ev.target.closest('.rm-sidebar-row');
    if (!row) return;
    var id = row.getAttribute('data-roadmap-id');
    var filename = row.getAttribute('data-filename');
    if (ev.metaKey || ev.ctrlKey || ev.altKey) {
      sendMessageToPlugin('openNote', JSON.stringify({ filename: filename }));
      return;
    }
    var idx = indexOfId(id);
    if (idx < 0) return;
    var range = getItemRange(items[idx]);
    var wrap = document.getElementById('rmCanvasWrap');
    if (!wrap) return;
    var targetX;
    if (range) {
      targetX = Math.max(0, dateToX(range.start) - 60);
    } else {
      targetX = Math.max(0, dateToX(todayParts()) - 60);
    }
    wrap.scrollTo({ left: targetX, top: idx * rowH, behavior: 'smooth' });
    // highlight briefly
    document.querySelectorAll('.rm-sidebar-row.highlight').forEach(function (n) { n.classList.remove('highlight'); });
    row.classList.add('highlight');
    setTimeout(function () { row.classList.remove('highlight'); }, 1500);
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
      items = data.items || [];
      reflowSidebar();
      renderAll();
      scrollPreserved();
    } else if (type === 'FULL_REFRESH') {
      window.location.reload();
    } else if (type === 'SHOW_TOAST') {
      showToast(payload.message || '');
    }
  };

  function reflowSidebar() {
    var holder = document.getElementById('rmSidebarRows');
    if (!holder) return;
    if (items.length === 0) {
      holder.innerHTML = '<div class="rm-sidebar-empty">No roadmap items yet.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var pTxt = (it.progress == null) ? '—' : (it.progress + '%');
      html += '<div class="rm-sidebar-row" data-roadmap-id="' + escAttr(it.id) + '" data-filename="' + escAttr(it.filename) + '" title="' + escAttr(it.title) + '">';
      html += '<div class="rm-sidebar-row-title">' + escHTML(it.title) + '</div>';
      html += '<div class="rm-sidebar-row-progress">' + escHTML(pTxt) + '</div>';
      html += '</div>';
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
    }
    if (depsEl) {
      depsEl.addEventListener('click', onDepClick);
    }

    var sidebar = document.getElementById('rmSidebarRows');
    if (sidebar) sidebar.addEventListener('click', onSidebarClick);

    var zoomBtns = document.getElementById('rmZoomBtns');
    if (zoomBtns) zoomBtns.addEventListener('click', onZoomClick);

    var todayBtn = document.getElementById('rmTodayBtn');
    if (todayBtn) todayBtn.addEventListener('click', scrollToToday);

    var refreshBtn = document.getElementById('rmRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () {
      var wrap = document.getElementById('rmCanvasWrap');
      if (wrap) savedScroll = { left: wrap.scrollLeft, top: wrap.scrollTop };
      sendMessageToPlugin('requestRefresh', JSON.stringify({}));
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
