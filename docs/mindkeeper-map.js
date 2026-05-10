/*!
 * mindkeeper-map.js v1.0 — standalone interactive mindmap renderer
 *
 * Original work — no external dependencies, no copied code.
 *
 * Techniques used (all standard web platform APIs):
 *   • Slot-based post-order tree layout for even node spacing
 *   • Alternating SIDE (left/right) branch placement
 *   • Cubic-bezier SVG paths for mindmap links
 *   • Canvas 2D measureText() for accurate node sizing
 *   • SVG feDropShadow filter for depth
 *   • stopPropagation() per-node drag coexisting with canvas pan
 *   • Pinch-to-zoom via touch events
 *
 * MIT License — Copyright (c) 2025 icedsg
 * https://github.com/icedsg/mindkeeper-mcp
 *
 * Usage: new MindkeeperMap('#container').init({ topic: 'Root', children: [...] })
 *        instance.exportPNG('mindmap.png')
 *        instance.exportSVG('mindmap.svg')
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ── Palette ─────────────────────────────────────────────────────────────────

  var PALETTE = [
    { fill: '#B5EAD7', stroke: '#55B88A', text: '#14432c' },
    { fill: '#FFD1DC', stroke: '#D9607A', text: '#5c0f22' },
    { fill: '#C7CEEA', stroke: '#6A7AC8', text: '#151e62' },
    { fill: '#FFDAC1', stroke: '#D48040', text: '#5c2800' },
    { fill: '#E2F0CB', stroke: '#80B840', text: '#223800' },
    { fill: '#B5D5EA', stroke: '#4898C8', text: '#0a2c4a' },
    { fill: '#F9C9E8', stroke: '#C840A0', text: '#500040' },
    { fill: '#FAF0B5', stroke: '#B8A010', text: '#332800' },
  ];

  var ROOT_STYLE = { fill: '#AED6DC', stroke: '#2898B8', text: '#082830' };

  // ── SVG helpers ─────────────────────────────────────────────────────────────

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) {
          el.setAttribute(k, attrs[k]);
        }
      }
    }
    return el;
  }

  // ── Text measurement ─────────────────────────────────────────────────────────

  var _ctx2d = null;
  function measureText(text, fontSize, bold) {
    if (!_ctx2d) {
      _ctx2d = document.createElement('canvas').getContext('2d');
    }
    _ctx2d.font = (bold ? '700' : '400') + ' ' + fontSize + 'px system-ui,sans-serif';
    return _ctx2d.measureText(text).width;
  }

  // ── Slot-based tree layout ───────────────────────────────────────────────────
  // Assigns a _slot number to every node via post-order traversal.
  // Leaves get consecutive integer slots; parents centre on their children.

  function assignSlots(node) {
    var counter = { n: 0 };
    function walk(n) {
      var kids = n.children || [];
      if (!kids.length) { n._slot = counter.n++; return; }
      kids.forEach(walk);
      n._slot = (kids[0]._slot + kids[kids.length - 1]._slot) / 2;
    }
    walk(node);
    return counter.n;
  }

  // ── MindkeeperMap ────────────────────────────────────────────────────────────

  function MindkeeperMap(selector, opts) {
    var container = typeof selector === 'string'
      ? document.querySelector(selector)
      : selector;
    if (!container) throw new Error('MindkeeperMap: container not found — ' + selector);

    this._el    = container;
    this._opts  = Object.assign({
      levelWidth : 240,   // px between depth levels
      vSpacing   : 54,    // px between sibling rows
      linkStroke : 3,     // link line width
      nodeBorder : 2.5,   // node rect border width
      fontFamily : 'system-ui,-apple-system,"Segoe UI",Helvetica,sans-serif',
    }, opts || {});

    this._nodes  = [];
    this._links  = [];
    this._tx = 0; this._ty = 0; this._scale = 1;
    this._svg = null; this._mainG = null; this._linksG = null; this._nodesG = null;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  MindkeeperMap.prototype.init = function (data) {
    this._setup();
    var self = this;

    // Defer layout until the container has real dimensions
    function tryInit() {
      var W = self._el.clientWidth, H = self._el.clientHeight;
      if (!W || !H) { requestAnimationFrame(tryInit); return; }
      self._layout(data);
      self._draw();
      self._fit();
    }
    requestAnimationFrame(tryInit);
    return this;
  };

  // ── Setup ────────────────────────────────────────────────────────────────────

  MindkeeperMap.prototype._setup = function () {
    // Remove any previous instance in this container
    var prev = this._el.querySelector('svg.mkmap');
    if (prev) prev.parentNode.removeChild(prev);

    this._el.style.cssText += ';position:relative;overflow:hidden;';

    var svg = svgEl('svg', { 'class': 'mkmap', width: '100%', height: '100%' });
    svg.style.cssText = 'display:block;user-select:none;';

    // ── Defs: drop-shadow filter ───────────────────────────────────────────────
    var defs = svgEl('defs');

    var filt = svgEl('filter', {
      id: 'mkmap-sh', x: '-30%', y: '-30%', width: '160%', height: '160%'
    });
    var fds = svgEl('feDropShadow', {
      dx: '0', dy: '2', stdDeviation: '3', 'flood-opacity': '0.14'
    });
    filt.appendChild(fds);
    defs.appendChild(filt);

    // Hover filter (shadow + slight darken)
    var filtHov = svgEl('filter', {
      id: 'mkmap-sh-hov', x: '-30%', y: '-30%', width: '160%', height: '160%'
    });
    var fdsHov = svgEl('feDropShadow', {
      dx: '0', dy: '3', stdDeviation: '5', 'flood-opacity': '0.22'
    });
    filtHov.appendChild(fdsHov);
    defs.appendChild(filtHov);

    svg.appendChild(defs);

    // ── Background rect (captures pan events) ────────────────────────────────
    var bg = svgEl('rect', {
      'class': 'mkmap-bg',
      x: '0', y: '0', width: '100%', height: '100%',
      fill: 'transparent', 'pointer-events': 'all'
    });
    svg.appendChild(bg);

    // ── Layer groups ──────────────────────────────────────────────────────────
    var main = svgEl('g', { 'class': 'mkmap-main' });
    this._linksG = svgEl('g', { 'class': 'mkmap-links' });
    this._nodesG = svgEl('g', { 'class': 'mkmap-nodes' });
    main.appendChild(this._linksG);
    main.appendChild(this._nodesG);
    svg.appendChild(main);

    this._mainG = main;
    this._svg   = svg;
    this._el.appendChild(svg);
    this._bindSvgEvents();
  };

  // ── Layout ───────────────────────────────────────────────────────────────────

  MindkeeperMap.prototype._layout = function (data) {
    this._nodes = []; this._links = [];
    var opts = this._opts;
    var W = this._el.clientWidth  || 800;
    var H = this._el.clientHeight || 600;
    var cx = W / 2, cy = H / 2;
    var self = this;

    // ── Root node ─────────────────────────────────────────────────────────────
    var rootText  = this._trunc(String(data.topic || 'Root'), 32);
    var rootW     = Math.max(measureText(rootText, 15, true) + 44, 110);
    var rootH     = 42;
    var rootNode  = {
      id: data.id || '__root__', topic: rootText,
      cx: cx, cy: cy, w: rootW, h: rootH,
      depth: 0, isLeft: false, branchIdx: -1,
      style: ROOT_STYLE, parent: null, isRoot: true,
    };
    this._nodes.push(rootNode);

    var allKids   = data.children || [];
    var rightKids = allKids.filter(function (_, i) { return i % 2 === 0; });
    var leftKids  = allKids.filter(function (_, i) { return i % 2 !== 0; });

    function layoutSide(kids, isLeft) {
      if (!kids.length) return;
      var dir     = isLeft ? -1 : 1;
      var bOffset = isLeft ? rightKids.length : 0;

      // Slot assignment for this side's subtree
      var fakeRoot    = { children: kids };
      var totalSlots  = assignSlots(fakeRoot);
      var totalH      = Math.max(0, totalSlots - 1) * opts.vSpacing;
      var yBase       = cy - totalH / 2;

      function place(node, depth, parentNode, bIdx) {
        var bold  = depth <= 1;
        var fs    = depth <= 1 ? 13 : 12;
        var nh    = depth <= 1 ? 36 : 30;
        var label = self._trunc(String(node.topic || ''), 30);
        var nw    = Math.max(measureText(label, fs, bold) + (depth <= 1 ? 32 : 24), 72);
        var ncx   = cx + dir * depth * opts.levelWidth;
        var ncy   = yBase + node._slot * opts.vSpacing;

        var nd = {
          id: node.id || ('n' + Math.random().toString(36).slice(2, 8)),
          topic: label,
          cx: ncx, cy: ncy, w: nw, h: nh,
          depth: depth, isLeft: isLeft, branchIdx: bIdx,
          style: PALETTE[bIdx % PALETTE.length],
          parent: parentNode,
        };

        self._nodes.push(nd);
        if (parentNode) self._links.push({ source: parentNode, target: nd });
        (node.children || []).forEach(function (child) {
          place(child, depth + 1, nd, bIdx);
        });
      }

      kids.forEach(function (kid, i) { place(kid, 1, rootNode, bOffset + i); });
    }

    layoutSide(rightKids, false);
    layoutSide(leftKids, true);
  };

  MindkeeperMap.prototype._trunc = function (text, max) {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  };

  // ── Draw ─────────────────────────────────────────────────────────────────────

  MindkeeperMap.prototype._draw = function () {
    while (this._linksG.firstChild) this._linksG.removeChild(this._linksG.firstChild);
    while (this._nodesG.firstChild)  this._nodesG.removeChild(this._nodesG.firstChild);
    var self = this;
    this._links.forEach(function (lk) { self._drawLink(lk); });
    this._nodes.forEach(function (nd) { self._drawNode(nd); });
    this._applyTransform();
  };

  MindkeeperMap.prototype._drawLink = function (lk) {
    var s = lk.source, t = lk.target;
    var isLeft = t.isLeft;

    // Exit from the matching horizontal edge of source, enter the opposite edge of target
    var sx = isLeft ? s.cx - s.w / 2 : s.cx + s.w / 2;
    var sy = s.cy;
    var tx = isLeft ? t.cx + t.w / 2 : t.cx - t.w / 2;
    var ty = t.cy;
    var mx = (sx + tx) / 2;

    var path = svgEl('path', {
      d: 'M' + sx + ',' + sy
        + ' C' + mx + ',' + sy
        + ' ' + mx + ',' + ty
        + ' ' + tx + ',' + ty,
      fill: 'none',
      stroke: t.style.stroke,
      'stroke-width': this._opts.linkStroke,
      'stroke-linecap': 'round',
      opacity: '0.82',
    });

    lk._el = path;
    this._linksG.appendChild(path);
  };

  MindkeeperMap.prototype._drawNode = function (nd) {
    var self = this;
    var opts = this._opts;

    var g = svgEl('g', { 'class': 'mkmap-node' });
    g.style.cursor = 'grab';

    // Root gets a pill shape; others get rounded rectangles
    var rx = nd.isRoot ? nd.h / 2 : 8;

    var rect = svgEl('rect', {
      x: nd.cx - nd.w / 2, y: nd.cy - nd.h / 2,
      width: nd.w, height: nd.h,
      rx: rx, ry: rx,
      fill: nd.style.fill,
      stroke: nd.style.stroke,
      'stroke-width': opts.nodeBorder,
      filter: 'url(#mkmap-sh)',
    });
    nd._rect = rect;
    g.appendChild(rect);

    var fs = nd.isRoot ? 15 : nd.depth === 1 ? 13 : 12;
    var fw = nd.isRoot || nd.depth === 1 ? '700' : '400';

    var txt = svgEl('text', {
      x: nd.cx, y: nd.cy,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-family': opts.fontFamily,
      'font-size': fs,
      'font-weight': fw,
      fill: nd.style.text,
      'pointer-events': 'none',
    });
    txt.textContent = nd.topic;
    nd._txt = txt;
    g.appendChild(txt);

    // Hover highlight
    g.addEventListener('mouseenter', function () {
      rect.setAttribute('filter', 'url(#mkmap-sh-hov)');
      rect.setAttribute('stroke-width', opts.nodeBorder + 1.5);
    });
    g.addEventListener('mouseleave', function () {
      rect.setAttribute('filter', 'url(#mkmap-sh)');
      rect.setAttribute('stroke-width', opts.nodeBorder);
    });

    nd._el = g;
    this._nodesG.appendChild(g);
    this._bindDrag(nd);
  };

  // ── Live node + link update after drag ───────────────────────────────────────

  MindkeeperMap.prototype._moveNode = function (nd) {
    nd._rect.setAttribute('x', nd.cx - nd.w / 2);
    nd._rect.setAttribute('y', nd.cy - nd.h / 2);
    nd._txt.setAttribute('x', nd.cx);
    nd._txt.setAttribute('y', nd.cy);

    // Redraw all links that touch this node
    var self = this;
    this._links.forEach(function (lk) {
      if (lk.source !== nd && lk.target !== nd) return;
      if (lk._el && lk._el.parentNode) lk._el.parentNode.removeChild(lk._el);
      self._drawLink(lk);
    });
  };

  // ── Node drag ────────────────────────────────────────────────────────────────

  MindkeeperMap.prototype._bindDrag = function (nd) {
    var self = this;

    nd._el.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.stopPropagation();   // prevent canvas pan

      var sx = e.clientX, sy = e.clientY;
      var ocx = nd.cx, ocy = nd.cy;
      nd._el.style.cursor = 'grabbing';

      function onMove(e2) {
        nd.cx = ocx + (e2.clientX - sx) / self._scale;
        nd.cy = ocy + (e2.clientY - sy) / self._scale;
        self._moveNode(nd);
      }
      function onUp() {
        nd._el.style.cursor = 'grab';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',  onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',  onUp);
    });

    // Touch support
    nd._el.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      e.stopPropagation();
      e.preventDefault();

      var t0 = e.touches[0];
      var sx = t0.clientX, sy = t0.clientY;
      var ocx = nd.cx, ocy = nd.cy;

      function onTMove(e2) {
        var t = e2.touches[0];
        nd.cx = ocx + (t.clientX - sx) / self._scale;
        nd.cy = ocy + (t.clientY - sy) / self._scale;
        self._moveNode(nd);
      }
      function onTEnd() {
        nd._el.removeEventListener('touchmove', onTMove);
        nd._el.removeEventListener('touchend',  onTEnd);
      }
      nd._el.addEventListener('touchmove', onTMove, { passive: false });
      nd._el.addEventListener('touchend',  onTEnd);
    }, { passive: false });
  };

  // ── Canvas pan & zoom ────────────────────────────────────────────────────────

  MindkeeperMap.prototype._bindSvgEvents = function () {
    var self = this;
    var svg  = this._svg;
    var bg   = svg.querySelector('.mkmap-bg');

    // Mouse-wheel zoom centred on cursor
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r  = svg.getBoundingClientRect();
      var mx = e.clientX - r.left;
      var my = e.clientY - r.top;
      var factor = e.deltaY < 0 ? 1.13 : 1 / 1.13;
      var ns = Math.max(0.08, Math.min(6, self._scale * factor));
      var f  = ns / self._scale;
      self._tx    = mx * (1 - f) + self._tx * f;
      self._ty    = my * (1 - f) + self._ty * f;
      self._scale = ns;
      self._applyTransform();
    }, { passive: false });

    // Background drag to pan
    bg.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var sx = e.clientX - self._tx;
      var sy = e.clientY - self._ty;
      svg.style.cursor = 'move';

      function onMove(e2) {
        self._tx = e2.clientX - sx;
        self._ty = e2.clientY - sy;
        self._applyTransform();
      }
      function onUp() {
        svg.style.cursor = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',  onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',  onUp);
    });

    // Pinch-to-zoom on touch
    var lastDist = 0;
    svg.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) lastDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }, { passive: true });

    svg.addEventListener('touchmove', function (e) {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      var dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (!lastDist) { lastDist = dist; return; }
      var factor = dist / lastDist;
      lastDist = dist;
      var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      var my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      var r  = svg.getBoundingClientRect();
      mx -= r.left; my -= r.top;
      var ns = Math.max(0.08, Math.min(6, self._scale * factor));
      var f  = ns / self._scale;
      self._tx    = mx * (1 - f) + self._tx * f;
      self._ty    = my * (1 - f) + self._ty * f;
      self._scale = ns;
      self._applyTransform();
    }, { passive: false });
  };

  MindkeeperMap.prototype._applyTransform = function () {
    this._mainG.setAttribute('transform',
      'translate(' + this._tx + ',' + this._ty + ') scale(' + this._scale + ')');
  };

  // ── Fit to view ──────────────────────────────────────────────────────────────

  MindkeeperMap.prototype._fit = function () {
    var W = this._el.clientWidth  || 800;
    var H = this._el.clientHeight || 600;
    if (!this._nodes.length) return;

    var x0 =  Infinity, y0 =  Infinity;
    var x1 = -Infinity, y1 = -Infinity;
    this._nodes.forEach(function (nd) {
      x0 = Math.min(x0, nd.cx - nd.w / 2);
      y0 = Math.min(y0, nd.cy - nd.h / 2);
      x1 = Math.max(x1, nd.cx + nd.w / 2);
      y1 = Math.max(y1, nd.cy + nd.h / 2);
    });

    var pad = 52;
    var sc  = Math.min(1, (W - pad * 2) / (x1 - x0), (H - pad * 2) / (y1 - y0));
    var mx  = (x0 + x1) / 2, my = (y0 + y1) / 2;

    this._scale = sc;
    this._tx    = W / 2 - mx * sc;
    this._ty    = H / 2 - my * sc;
    this._applyTransform();
  };

  // ── Export helpers ───────────────────────────────────────────────────────────

  function _contentBounds(nodes, pad) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    nodes.forEach(function (nd) {
      x0 = Math.min(x0, nd.cx - nd.w / 2);
      y0 = Math.min(y0, nd.cy - nd.h / 2);
      x1 = Math.max(x1, nd.cx + nd.w / 2);
      y1 = Math.max(y1, nd.cy + nd.h / 2);
    });
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }

  function _cloneForExport(self, b) {
    var clone = self._svg.cloneNode(true);
    clone.setAttribute('width',   b.w);
    clone.setAttribute('height',  b.h);
    clone.setAttribute('viewBox', '0 0 ' + b.w + ' ' + b.h);
    clone.setAttribute('xmlns',   'http://www.w3.org/2000/svg');
    var cloneBg = clone.querySelector('.mkmap-bg');
    if (cloneBg) {
      cloneBg.setAttribute('fill',   '#f8f9fb');
      cloneBg.setAttribute('width',  b.w);
      cloneBg.setAttribute('height', b.h);
    }
    var cloneMain = clone.querySelector('.mkmap-main');
    if (cloneMain) {
      cloneMain.setAttribute('transform', 'translate(' + (-b.x) + ',' + (-b.y) + ')');
    }
    return clone;
  }

  MindkeeperMap.prototype.exportSVG = function (filename) {
    if (!this._nodes.length) return;
    var b   = _contentBounds(this._nodes, 44);
    var xml = new XMLSerializer().serializeToString(_cloneForExport(this, b));
    var url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    var a   = document.createElement('a');
    a.download = filename || 'mindmap.svg';
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  };

  MindkeeperMap.prototype.exportPNG = function (filename) {
    if (!this._nodes.length) return;
    var b   = _contentBounds(this._nodes, 44);
    var xml = new XMLSerializer().serializeToString(_cloneForExport(this, b));
    var url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var img = new Image();
    img.onload = function () {
      var canvas   = document.createElement('canvas');
      canvas.width  = Math.round(b.w * dpr);
      canvas.height = Math.round(b.h * dpr);
      var ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#f8f9fb';
      ctx.fillRect(0, 0, b.w, b.h);
      ctx.drawImage(img, 0, 0, b.w, b.h);
      URL.revokeObjectURL(url);
      var a = document.createElement('a');
      a.download = filename || 'mindmap.png';
      a.href = canvas.toDataURL('image/png');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };
    img.onerror = function () { URL.revokeObjectURL(url); };
    img.src = url;
  };

  // ── Expose ───────────────────────────────────────────────────────────────────

  global.MindkeeperMap = MindkeeperMap;

})(typeof window !== 'undefined' ? window : this);
