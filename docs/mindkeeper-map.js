/*!
 * mindkeeper-map.js v1.2 — standalone interactive mindmap / org-chart renderer
 *
 * MIT License — Copyright (c) 2025 icedsg
 * https://github.com/icedsg/mindkeeper-js
 *
 * Usage:
 *   const map = new MindkeeperMap('#container').init({ topic: 'Root', children: [...] })
 *   map.addNode('parent-id', { topic: 'New Node' })
 *   map.exportPNG('mindmap.png')
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ── Palette ──────────────────────────────────────────────────────────────────

  var PALETTE = [
    { fill: '#B5EAD7', stroke: '#55B88A', text: '#14432c' },
    { fill: '#FFD1DC', stroke: '#D9607A', text: '#5c0f22' },
    { fill: '#C7CEEA', stroke: '#6A7AC8', text: '#151e62' },
    { fill: '#FFDAC1', stroke: '#D48040', text: '#5c2800' },
    { fill: '#E2F0CB', stroke: '#80B840', text: '#223800' },
    { fill: '#B5D5EA', stroke: '#4898C8', text: '#0a2c4a' },
    { fill: '#F9C9E8', stroke: '#C840A0', text: '#500040' },
    { fill: '#FAF0B5', stroke: '#B8A010', text: '#332800' }
  ];

  var ROOT_STYLE = { fill: '#AED6DC', stroke: '#2898B8', text: '#082830' };

  // Typed nodes: optional `kind` picks the card colour and badge glyph.
  // People show their initials (or `meta.avatar`) instead of a glyph.
  var KINDS = {
    person  : { fill: '#DCEBFB', stroke: '#3B82C4', text: '#0b2a4a', glyph: null },
    company : { fill: '#E3E6EC', stroke: '#5A6475', text: '#1c2230', glyph: 'C' },
    team    : { fill: '#D7F2E3', stroke: '#3A9E6A', text: '#0f3b24', glyph: 'T' },
    role    : { fill: '#FCE9C8', stroke: '#C98A1A', text: '#4a3000', glyph: 'R' },
    project : { fill: '#E8DDFA', stroke: '#7B4FC9', text: '#2a1050', glyph: 'P' },
    idea    : { fill: '#FBF3BF', stroke: '#B59B12', text: '#3a3000', glyph: 'i' }
  };

  var META_KEYS = ['title', 'email', 'url', 'avatar', 'start', 'end', 'status'];
  var INACTIVE  = { inactive: 1, left: 1, ended: 1, closed: 1, archived: 1 };

  function initials(text) {
    var parts = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    var a = parts[0].charAt(0), b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (a + b).toUpperCase();
  }

  // Shallow copy of meta without empty values; null when nothing is left
  function cleanMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    var out = {}, any = false;
    Object.keys(meta).forEach(function (k) {
      var v = meta[k];
      if (v === null || v === undefined || v === '') return;
      out[k] = v; any = true;
    });
    return any ? out : null;
  }

  // Plain-object tree (what toJSON returns); kind/meta only when set
  function serialize(node) {
    var n = { id: node.id, topic: node.topic };
    if (node.kind) n.kind = node.kind;
    var m = cleanMeta(node.meta);
    if (m) n.meta = m;
    if (node.collapsed) n.collapsed = true;
    if (node.children && node.children.length) n.children = node.children.map(serialize);
    return n;
  }

  // Children that are drawn: none while a node is collapsed
  function visibleKids(node) {
    return node.collapsed ? [] : (node.children || []);
  }

  // Cross-links between any two nodes (projects, dotted-line managers): {from, to, type?, label?}
  function cleanLinks(links) {
    if (!Array.isArray(links)) return [];
    return links.filter(function (l) { return l && l.from && l.to; }).map(function (l) {
      var o = { from: String(l.from), to: String(l.to) };
      if (l.type) o.type = String(l.type);
      if (l.label) o.label = String(l.label);
      return o;
    });
  }
  function linkKey(l) { return l.from + '>' + l.to + ':' + (l.type || ''); }

  // Diff colours: added green, removed red, moved / changed amber (moved draws a dashed ring)
  var DIFF = {
    added  : { stroke: '#1F9D55', label: 'added' },
    removed: { stroke: '#D64545', label: 'removed' },
    moved  : { stroke: '#D99A12', label: 'moved' },
    changed: { stroke: '#D99A12', label: 'changed' }
  };

  // Flat index of a tree: id -> { node, parentId }
  function indexTree(root) {
    var out = {};
    (function walk(n, parentId) {
      if (!n) return;
      if (n.id) out[n.id] = { node: n, parentId: parentId };
      (n.children || []).forEach(function (c) { walk(c, n.id || null); });
    })(root, null);
    return out;
  }

  // What changed between two trees (matched by id): added / removed / moved (new parent) / changed (topic, kind, meta)
  function diffTrees(oldData, newData) {
    var a = indexTree(oldData), b = indexTree(newData);
    var res = { added: [], removed: [], moved: [], changed: [], links: { added: [], removed: [] }, info: {} };
    Object.keys(b).forEach(function (id) {
      var nb = b[id].node;
      if (!a[id]) { res.added.push(id); res.info[id] = { topic: nb.topic }; return; }
      var na = a[id].node, info = { topic: nb.topic };
      if (a[id].parentId !== b[id].parentId) {
        res.moved.push(id); info.from = a[id].parentId; info.to = b[id].parentId;
      }
      var fields = [];
      if (String(na.topic) !== String(nb.topic)) fields.push('topic');
      if ((na.kind || null) !== (nb.kind || null)) fields.push('kind');
      if (JSON.stringify(cleanMeta(na.meta)) !== JSON.stringify(cleanMeta(nb.meta))) fields.push('meta');
      if (fields.length) { res.changed.push(id); info.fields = fields; }
      if (info.from !== undefined || info.fields) res.info[id] = info;
    });
    Object.keys(a).forEach(function (id) {
      if (!b[id]) { res.removed.push(id); res.info[id] = { topic: a[id].node.topic }; }
    });
    var la = {}, lb = {};
    cleanLinks(oldData && oldData.links).forEach(function (l) { la[linkKey(l)] = l; });
    cleanLinks(newData && newData.links).forEach(function (l) { lb[linkKey(l)] = l; });
    Object.keys(lb).forEach(function (k) { if (!la[k]) res.links.added.push(lb[k]); });
    Object.keys(la).forEach(function (k) { if (!lb[k]) res.links.removed.push(la[k]); });
    return res;
  }

  function countDescendants(node) {
    return (node.children || []).reduce(function (sum, c) { return sum + 1 + countDescendants(c); }, 0);
  }

  // ── SVG helpers ──────────────────────────────────────────────────────────────

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        el.setAttribute(k, attrs[k]);
      });
    }
    return el;
  }

  // ── Text measurement ─────────────────────────────────────────────────────────

  var _ctx2d = null;
  function measureText(text, fontSize, bold) {
    // No DOM (node tests, SSR): rough average glyph width
    if (typeof document === 'undefined') return text.length * fontSize * (bold ? 0.6 : 0.55);
    if (!_ctx2d) { _ctx2d = document.createElement('canvas').getContext('2d'); }
    _ctx2d.font = (bold ? '700' : '400') + ' ' + fontSize + 'px system-ui,sans-serif';
    return _ctx2d.measureText(text).width;
  }

  // ── Slot-based tree layout ───────────────────────────────────────────────────

  function assignSlots(node) {
    var counter = { n: 0 };
    function walk(n) {
      var kids = visibleKids(n);
      if (!kids.length) { n.slot = counter.n; counter.n += 1; return; }
      kids.forEach(walk);
      n.slot = (kids[0].slot + kids[kids.length - 1].slot) / 2;
    }
    walk(node);
    return counter.n;
  }

  function genId() {
    return 'n' + Math.random().toString(36).slice(2, 9);
  }

  // ── MindkeeperMap ────────────────────────────────────────────────────────────

  function MindkeeperMap(selector, opts) {
    var container = typeof selector === 'string'
      ? document.querySelector(selector)
      : selector;
    if (!container) throw new Error('MindkeeperMap: container not found — ' + selector);

    this._el   = container;
    this._opts = Object.assign({
      layout     : 'mindmap',   // 'mindmap' (left/right of the root) or 'orgchart' (top-down)
      levelWidth : 240,
      levelHeight: 110,         // orgchart: distance between levels
      hSpacing   : 24,          // orgchart: gap between sibling subtrees
      stackLeaves: 4,           // orgchart: a manager with this many reports, all leaves, lists them in a column (0 = never)
      vSpacing   : 54,
      linkStroke : 3,
      nodeBorder : 2.5,
      fontFamily : 'system-ui,-apple-system,"Segoe UI",Helvetica,sans-serif',
    }, opts || {});

    this._nodes      = [];
    this._links      = [];
    this._xlinks     = [];
    this._diff       = null;
    this._data       = null;
    this._handlers   = {};
    this._selectedId = null;
    this._tx = 0; this._ty = 0; this._scale = 1;
    this._svg = null; this._mainG = null; this._linksG = null; this._xlinksG = null; this._nodesG = null;
    this._legend = null;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  MindkeeperMap.prototype.init = function (data) {
    this._data = this._ensureIds(JSON.parse(JSON.stringify(data)));
    this._data.links = cleanLinks(this._data.links);
    this._selectedId = null;
    this._diff = null;
    this._setup();
    var self = this;
    function tryInit() {
      var W = self._el.clientWidth, H = self._el.clientHeight;
      if (!W || !H) { requestAnimationFrame(tryInit); return; }
      self._layout(self._data);
      self._draw();
      self._fit();
    }
    requestAnimationFrame(tryInit);
    return this;
  };

  // Re-initialise with new tree data
  MindkeeperMap.prototype.fromJSON = function (data) {
    return this.init(data);
  };

  // Export current tree as a plain JS object
  MindkeeperMap.prototype.toJSON = function () {
    if (!this._data) return null;
    var out = serialize(this._data);
    if (this._data.links && this._data.links.length) out.links = cleanLinks(this._data.links);
    return out;
  };

  // Cross-links: dashed labelled curves between any two nodes, outside the tree (e.g. person -> project)
  MindkeeperMap.prototype.getLinks = function () {
    return cleanLinks(this._data && this._data.links);
  };

  MindkeeperMap.prototype.addLink = function (from, to, type, label) {
    if (!this._findInTree(from)) throw new Error('addLink: node not found — ' + from);
    if (!this._findInTree(to)) throw new Error('addLink: node not found — ' + to);
    var link = cleanLinks([{ from: from, to: to, type: type, label: label }])[0];
    var links = this._data.links || (this._data.links = []);
    if (links.some(function (l) { return linkKey(l) === linkKey(link); })) return this;
    links.push(link);
    this._refresh();
    this._emit('linkAdd', { link: link });
    return this;
  };

  // Removes from -> to links (only those of `type` when given)
  MindkeeperMap.prototype.removeLink = function (from, to, type) {
    var links = (this._data && this._data.links) || [];
    var keep = links.filter(function (l) {
      return !(l.from === from && l.to === to && (type === undefined || (l.type || '') === (type || '')));
    });
    if (keep.length === links.length) return this;
    this._data.links = keep;
    this._refresh();
    this._emit('linkRemove', { from: from, to: to, type: type });
    return this;
  };

  // Mark the result of MindkeeperMap.diff() on the cards (green added, red removed, amber moved/changed) with a legend
  MindkeeperMap.prototype.highlightDiff = function (diff) {
    this._diff = diff || null;
    this._refresh();
    return this;
  };

  MindkeeperMap.prototype.clearDiff = function () { return this.highlightDiff(null); };

  // Return lightweight info for a single node
  MindkeeperMap.prototype.getNode = function (id) {
    var found = this._findInTree(id);
    if (!found) return null;
    var n = found.node;
    var info = {
      id: n.id,
      topic: n.topic,
      children: (n.children || []).map(function (c) { return c.id; }),
    };
    if (n.kind) info.kind = n.kind;
    var m = cleanMeta(n.meta);
    if (m) info.meta = m;
    return info;
  };

  // Add a child node to parentId; returns new node's ID
  MindkeeperMap.prototype.addNode = function (parentId, data) {
    var found = this._findInTree(parentId);
    if (!found) throw new Error('addNode: parent not found — ' + parentId);
    var newNode = {
      id: (data && data.id) || genId(),
      topic: (data && data.topic) || 'New Node',
      children: [],
    };
    this._applyTyped(newNode, data);
    if (!found.node.children) found.node.children = [];
    found.node.children.push(newNode);
    this._refresh();
    this._emit('nodeAdd', { node: this.getNode(newNode.id), parentId: parentId });
    return newNode.id;
  };

  // Update a node's topic or other fields
  MindkeeperMap.prototype.updateNode = function (id, data) {
    var found = this._findInTree(id);
    if (!found) throw new Error('updateNode: node not found — ' + id);
    if (data.topic !== undefined) found.node.topic = String(data.topic);
    this._applyTyped(found.node, data);
    this._refresh();
    this._emit('nodeUpdate', { id: id, data: data });
    return this;
  };

  // Delete a node and all its descendants
  MindkeeperMap.prototype.deleteNode = function (id) {
    if (this._data && this._data.id === id) throw new Error('deleteNode: cannot delete root node');
    var found = this._findInTree(id);
    if (!found) throw new Error('deleteNode: node not found — ' + id);
    found.parent.children = (found.parent.children || []).filter(function (c) { return c.id !== id; });
    if (this._selectedId === id) this._selectedId = null;
    this._refresh();
    this._emit('nodeDelete', { id: id });
    return this;
  };

  // Insert a new node between parentId and childId
  MindkeeperMap.prototype.insertBetween = function (parentId, childId, data) {
    var foundParent = this._findInTree(parentId);
    if (!foundParent) throw new Error('insertBetween: parent not found — ' + parentId);
    var parent = foundParent.node;
    var children = parent.children || [];
    var idx = -1;
    for (var i = 0; i < children.length; i++) {
      if (children[i].id === childId) { idx = i; break; }
    }
    if (idx === -1) throw new Error('insertBetween: child ' + childId + ' not found under parent ' + parentId);
    var existing = children[idx];
    var newNode = {
      id: (data && data.id) || genId(),
      topic: (data && data.topic) || 'New Node',
      children: [existing],
    };
    this._applyTyped(newNode, data);
    parent.children[idx] = newNode;
    this._refresh();
    this._emit('nodeAdd', { node: this.getNode(newNode.id), parentId: parentId });
    return newNode.id;
  };

  // Switch between 'mindmap' and 'orgchart' and refit
  MindkeeperMap.prototype.setLayout = function (name) {
    if (name !== 'mindmap' && name !== 'orgchart') throw new Error('setLayout: unknown layout — ' + name);
    this._opts.layout = name;
    this._refresh();
    if (this._svg) this._fit();
    return this;
  };

  // Hide / show a node's descendants (kept as `collapsed: true` in toJSON)
  MindkeeperMap.prototype.collapse = function (id) { return this._setCollapsed(id, true); };
  MindkeeperMap.prototype.expand   = function (id) { return this._setCollapsed(id, false); };
  MindkeeperMap.prototype.toggle   = function (id) {
    var found = this._findInTree(id);
    if (!found) throw new Error('toggle: node not found — ' + id);
    return this._setCollapsed(id, !found.node.collapsed);
  };

  // Open every branch, or close every branch below the root
  MindkeeperMap.prototype.expandAll   = function () { return this._setAll(false); };
  MindkeeperMap.prototype.collapseAll = function () { return this._setAll(true); };

  // Fit the mindmap to the container
  MindkeeperMap.prototype.fit = function () {
    this._fit();
    return this;
  };

  // ── Event system ─────────────────────────────────────────────────────────────

  MindkeeperMap.prototype.on = function (event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
    return this;
  };

  MindkeeperMap.prototype.off = function (event, handler) {
    if (!this._handlers[event]) return this;
    this._handlers[event] = this._handlers[event].filter(function (h) { return h !== handler; });
    return this;
  };

  MindkeeperMap.prototype._emit = function (event, data) {
    (this._handlers[event] || []).forEach(function (h) { h(data); });
  };

  // ── Internal helpers ─────────────────────────────────────────────────────────

  MindkeeperMap.prototype._ensureIds = function (node) {
    if (!node.id) node.id = genId();
    if (node.children) node.children.forEach(this._ensureIds.bind(this));
    return node;
  };

  // After a layout: diff marks on the cards, and cross-links between drawn cards.
  // A link end hidden in a collapsed branch attaches to its nearest visible ancestor.
  MindkeeperMap.prototype._decorate = function (data) {
    var byId = {}, diff = this._diff, self = this;
    this._nodes.forEach(function (nd) { byId[nd.id] = nd; });
    if (diff) {
      ['changed', 'moved', 'removed', 'added'].forEach(function (k) {
        (diff[k] || []).forEach(function (id) { if (byId[id]) byId[id].diff = k; });
      });
    }
    var shown = {};
    (function walk(n, vis) {
      var here = byId[n.id] ? byId[n.id] : vis;
      shown[n.id] = here;
      (n.children || []).forEach(function (c) { walk(c, here); });
    })(data, null);
    this._xlinks = [];
    cleanLinks(data.links).forEach(function (l) {
      var s = shown[l.from], t = shown[l.to];
      if (!s || !t || s === t) return;
      var xl = { source: s, target: t, type: l.type || null, label: l.label || l.type || null };
      if (diff && diff.links) {
        if ((diff.links.added || []).some(function (d) { return linkKey(d) === linkKey(l); })) xl.diff = 'added';
        else if ((diff.links.removed || []).some(function (d) { return linkKey(d) === linkKey(l); })) xl.diff = 'removed';
      }
      self._xlinks.push(xl);
    });
  };

  MindkeeperMap.prototype._setCollapsed = function (id, on) {
    var found = this._findInTree(id);
    if (!found) throw new Error('collapse: node not found — ' + id);
    if (!!found.node.collapsed === on) return this;
    if (on) found.node.collapsed = true; else delete found.node.collapsed;
    this._refresh();
    this._emit('nodeToggle', { id: id, collapsed: on });
    return this;
  };

  MindkeeperMap.prototype._setAll = function (on) {
    var root = this._data;
    if (!root) return this;
    (function walk(n) {
      if (on && n !== root && n.children && n.children.length) n.collapsed = true;
      else delete n.collapsed;
      (n.children || []).forEach(walk);
    })(root);
    this._refresh();
    if (this._svg) this._fit();
    return this;
  };

  // kind: a string sets it, null/'' removes it. meta: keys merge in, null/'' removes a key, meta: null clears it.
  MindkeeperMap.prototype._applyTyped = function (node, data) {
    if (!data) return;
    if (data.kind !== undefined) {
      if (data.kind) node.kind = String(data.kind); else delete node.kind;
    }
    if (data.meta !== undefined) {
      var m = data.meta === null ? null : cleanMeta(Object.assign({}, node.meta || {}, data.meta));
      if (m) node.meta = m; else delete node.meta;
    }
  };

  MindkeeperMap.prototype._findInTree = function (id, node, parent) {
    if (node === undefined) node = this._data;
    if (!node) return null;
    if (node.id === id) return { node: node, parent: parent || null };
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      var hit = this._findInTree(id, kids[i], node);
      if (hit) return hit;
    }
    return null;
  };

  MindkeeperMap.prototype._refresh = function () {
    this._layout(this._data);
    if (this._svg) this._draw();
  };

  // ── Setup ────────────────────────────────────────────────────────────────────

  MindkeeperMap.prototype._setup = function () {
    var prev = this._el.querySelector('svg.mkmap');
    if (prev) prev.parentNode.removeChild(prev);
    var prevLegend = this._el.querySelector('.mkmap-legend');
    if (prevLegend) prevLegend.parentNode.removeChild(prevLegend);
    this._legend = null;

    this._el.style.cssText += ';position:relative;overflow:hidden;';

    var svg = svgEl('svg', { 'class': 'mkmap', width: '100%', height: '100%' });
    svg.style.cssText = 'display:block;user-select:none;';

    var defs = svgEl('defs');
    var filt = svgEl('filter', { id: 'mkmap-sh', x: '-30%', y: '-30%', width: '160%', height: '160%' });
    filt.appendChild(svgEl('feDropShadow', { dx: '0', dy: '2', stdDeviation: '3', 'flood-opacity': '0.14' }));
    defs.appendChild(filt);

    var filtHov = svgEl('filter', { id: 'mkmap-sh-hov', x: '-30%', y: '-30%', width: '160%', height: '160%' });
    filtHov.appendChild(svgEl('feDropShadow', { dx: '0', dy: '3', stdDeviation: '5', 'flood-opacity': '0.22' }));
    defs.appendChild(filtHov);

    svg.appendChild(defs);

    var bg = svgEl('rect', {
      'class': 'mkmap-bg', x: '0', y: '0', width: '100%', height: '100%',
      fill: 'transparent', 'pointer-events': 'all',
    });
    svg.appendChild(bg);

    var main = svgEl('g', { 'class': 'mkmap-main' });
    this._linksG  = svgEl('g', { 'class': 'mkmap-links' });
    this._xlinksG = svgEl('g', { 'class': 'mkmap-xlinks' });
    this._nodesG  = svgEl('g', { 'class': 'mkmap-nodes' });
    main.appendChild(this._linksG);
    main.appendChild(this._xlinksG);
    main.appendChild(this._nodesG);
    svg.appendChild(main);

    this._mainG = main;
    this._svg   = svg;
    this._el.appendChild(svg);
    this._bindSvgEvents();
  };

  // ── Layout ───────────────────────────────────────────────────────────────────

  MindkeeperMap.prototype._layout = function (data) {
    if (this._opts.layout === 'orgchart') this._layoutOrg(data);
    else this._layoutMind(data);
    this._decorate(data);
  };

  MindkeeperMap.prototype._layoutMind = function (data) {
    this._nodes = []; this._links = [];
    var opts = this._opts;
    var W  = this._el.clientWidth  || 800;
    var H  = this._el.clientHeight || 600;
    var cx = W / 2, cy = H / 2;
    var self = this;

    var rootText = this._trunc(String(data.topic || 'Root'), 32);
    var rootW    = Math.max(measureText(rootText, 15, true) + 44, 110);
    var rootH    = 42;
    var rootNode = {
      id: data.id, topic: rootText,
      cx: cx, cy: cy, w: rootW, h: rootH,
      depth: 0, isLeft: false, branchIdx: -1,
      style: ROOT_STYLE, parent: null, isRoot: true,
    };
    this._typeCard(rootNode, data, 15, true);
    this._markToggle(rootNode, data);
    this._nodes.push(rootNode);

    var allKids   = visibleKids(data);
    var rightKids = allKids.filter(function (_, i) { return i % 2 === 0; });
    var leftKids  = allKids.filter(function (_, i) { return i % 2 !== 0; });

    function layoutSide(kids, isLeft) {
      if (!kids.length) return;
      var dir   = isLeft ? -1 : 1;
      var bOff  = isLeft ? rightKids.length : 0;
      var fakeR = { children: kids };
      var total = assignSlots(fakeR);
      var totalH = Math.max(0, total - 1) * opts.vSpacing;
      var yBase  = cy - totalH / 2;

      function place(node, depth, parentNode, bIdx) {
        var bold  = depth <= 1;
        var fs    = depth <= 1 ? 13 : 12;
        var nh    = depth <= 1 ? 36 : 30;
        var label = self._trunc(String(node.topic || ''), 30);
        var nw    = Math.max(measureText(label, fs, bold) + (depth <= 1 ? 32 : 24), 72);
        var ncx   = cx + dir * depth * opts.levelWidth;
        var ncy   = yBase + node.slot * opts.vSpacing;

        var nd = {
          id: node.id, topic: label,
          cx: ncx, cy: ncy, w: nw, h: nh,
          depth: depth, isLeft: isLeft, branchIdx: bIdx,
          style: PALETTE[bIdx % PALETTE.length],
          parent: parentNode,
        };
        self._typeCard(nd, node, fs, bold);
        self._markToggle(nd, node);
        self._nodes.push(nd);
        if (parentNode) self._links.push({ source: parentNode, target: nd });
        visibleKids(node).forEach(function (child) { place(child, depth + 1, nd, bIdx); });
      }

      kids.forEach(function (kid, i) { place(kid, 1, rootNode, bOff + i); });
    }

    layoutSide(rightKids, false);
    layoutSide(leftKids, true);
  };

  // Org chart: top-down tidy tree. Each subtree is as wide as its widest row and a manager sits centred over
  // their reports; a manager whose reports are all leaves (at least stackLeaves of them) lists them in a column.
  MindkeeperMap.prototype._layoutOrg = function (data) {
    this._nodes = []; this._links = [];
    var opts = this._opts;
    var W = this._el.clientWidth || 800;
    var self = this;
    var gap = opts.hSpacing, indent = 22, stackGap = 12;

    // Pass 1: card sizes and subtree widths
    function measure(node, depth, bIdx) {
      var isRoot = depth === 0;
      var bold = depth <= 1, fs = isRoot ? 15 : depth === 1 ? 13 : 12;
      var label = self._trunc(String(node.topic || (isRoot ? 'Root' : '')), isRoot ? 32 : 30);
      var nd = {
        id: node.id, topic: label, cx: 0, cy: 0,
        w: isRoot ? Math.max(measureText(label, fs, true) + 44, 110)
                  : Math.max(measureText(label, fs, bold) + (depth <= 1 ? 32 : 24), 72),
        h: isRoot ? 42 : depth <= 1 ? 36 : 30,
        depth: depth, isLeft: false, branchIdx: bIdx,
        style: isRoot ? ROOT_STYLE : PALETTE[bIdx % PALETTE.length],
        parent: null,
      };
      if (isRoot) nd.isRoot = true;
      self._typeCard(nd, node, fs, bold);
      self._markToggle(nd, node);
      nd.kids = visibleKids(node).map(function (c, i) { return measure(c, depth + 1, isRoot ? i : bIdx); });
      nd.kids.forEach(function (k) { k.parent = nd; });
      nd.stacked = opts.stackLeaves > 0 && !isRoot && nd.kids.length >= opts.stackLeaves &&
        nd.kids.every(function (k) { return !k.hasToggle; });
      if (nd.stacked) {
        nd.colW = Math.max.apply(null, nd.kids.map(function (k) { return k.w; }));
        nd.span = Math.max(nd.w, nd.colW + indent * 2);
      } else if (nd.kids.length) {
        nd.row = nd.kids.reduce(function (s, k) { return s + k.span; }, 0) + gap * (nd.kids.length - 1);
        nd.span = Math.max(nd.w, nd.row);
      } else {
        nd.span = nd.w;
      }
      return nd;
    }

    // Pass 2: positions; every level starts levelHeight below the one above
    function place(nd, left, top) {
      nd.cx = left + nd.span / 2;
      nd.cy = top + nd.h / 2;
      self._nodes.push(nd);
      if (nd.stacked) {
        var colLeft = nd.cx - nd.colW / 2 + indent / 2;
        var y = top + nd.h + (nd.hasToggle ? 30 : 16);
        nd.kids.forEach(function (k) {
          k.cx = colLeft + k.w / 2; k.cy = y + k.h / 2; y += k.h + stackGap;
          self._nodes.push(k);
          self._links.push({ source: nd, target: k, kind: 'stack', spineX: colLeft - indent / 2 - 4 });
        });
      } else if (nd.kids.length) {
        var x = nd.cx - nd.row / 2;
        nd.kids.forEach(function (k) {
          place(k, x, top + opts.levelHeight);
          self._links.push({ source: nd, target: k, kind: 'elbow' });
          x += k.span + gap;
        });
        // Centre over the first and last report rather than the whole row, staying inside the subtree
        var mid = (nd.kids[0].cx + nd.kids[nd.kids.length - 1].cx) / 2;
        nd.cx = Math.min(Math.max(mid, left + nd.w / 2), left + nd.span - nd.w / 2);
      }
      delete nd.kids; delete nd.row; delete nd.colW;
    }

    var root = measure(data, 0, -1);
    place(root, W / 2 - root.span / 2, 40);
  };

  // A node with children gets a +/- toggle; a collapsed one shows how many are hidden
  MindkeeperMap.prototype._markToggle = function (nd, node) {
    if (!node.children || !node.children.length) return;
    nd.hasToggle = true;
    nd.collapsed = !!node.collapsed;
    if (nd.collapsed) nd.hidden = countDescendants(node);
  };

  // Typed / titled nodes: kind colours, badge room and a second line for meta.title.
  // Untyped nodes without a title keep the exact mind-map size and palette.
  MindkeeperMap.prototype._typeCard = function (nd, node, fs, bold) {
    var kind = node.kind && KINDS[node.kind] ? node.kind : null;
    var meta = cleanMeta(node.meta) || {};
    if (node.kind) nd.kind = node.kind;
    if (node.meta) nd.meta = meta;
    if (!kind && !meta.title) return;

    if (kind) nd.style = KINDS[kind];
    nd.badge = kind ? (KINDS[kind].glyph || initials(node.topic)) : null;
    nd.avatar = kind === 'person' && meta.avatar ? String(meta.avatar) : null;
    nd.inactive = !!(meta.status && INACTIVE[String(meta.status).toLowerCase()]);
    nd.sub = meta.title ? this._trunc(String(meta.title), 34) : null;

    var badgeW = nd.badge ? 28 : 0;
    var textW  = measureText(nd.topic, fs, bold);
    if (nd.sub) textW = Math.max(textW, measureText(nd.sub, 11, false));
    nd.w = Math.max(textW + (nd.isRoot ? 44 : 28) + badgeW, nd.isRoot ? 110 : 96);
    if (nd.sub) nd.h = Math.max(nd.h, nd.isRoot ? 50 : 44);
    else if (nd.badge) nd.h = Math.max(nd.h, 32);
  };

  MindkeeperMap.prototype._trunc = function (text, max) {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  };

  // ── Draw ─────────────────────────────────────────────────────────────────────

  MindkeeperMap.prototype._draw = function () {
    var opts  = this._opts;
    var selId = this._selectedId;

    while (this._linksG.firstChild)  this._linksG.removeChild(this._linksG.firstChild);
    while (this._xlinksG.firstChild) this._xlinksG.removeChild(this._xlinksG.firstChild);
    while (this._nodesG.firstChild)  this._nodesG.removeChild(this._nodesG.firstChild);

    var self = this;
    this._links.forEach(function (lk) { self._drawLink(lk); });
    this._xlinks.forEach(function (xl) { self._drawXLink(xl); });
    this._nodes.forEach(function (nd) { self._drawNode(nd); });
    this._drawLegend();

    if (selId) {
      this._nodes.forEach(function (nd) {
        if (nd.id === selId && nd._rect) {
          nd._rect.setAttribute('stroke-width', opts.nodeBorder + 2);
        }
      });
    }

    this._applyTransform();
  };

  MindkeeperMap.prototype._drawLink = function (lk) {
    if (lk.kind) return this._drawOrgLink(lk);
    var s = lk.source, t = lk.target;
    var isLeft = t.isLeft;
    var sx = isLeft ? s.cx - s.w / 2 : s.cx + s.w / 2;
    var sy = s.cy;
    var tx = isLeft ? t.cx + t.w / 2 : t.cx - t.w / 2;
    var ty = t.cy;
    var mx = (sx + tx) / 2;

    var path = svgEl('path', {
      d: 'M' + sx + ',' + sy + ' C' + mx + ',' + sy + ' ' + mx + ',' + ty + ' ' + tx + ',' + ty,
      fill: 'none',
      stroke: t.style.stroke,
      'stroke-width': this._opts.linkStroke,
      'stroke-linecap': 'round',
      opacity: '0.82',
    });
    lk._el = path;
    this._linksG.appendChild(path);
  };

  // Org chart links: elbow from the manager's bottom edge to the report's top edge, or a spine for stacked reports
  MindkeeperMap.prototype._drawOrgLink = function (lk) {
    var s = lk.source, t = lk.target, d;
    var sy = s.cy + s.h / 2 + (s.hasToggle ? 18 : 0);
    if (lk.kind === 'stack') {
      d = 'M' + s.cx + ',' + sy + ' V' + (sy + 4) + ' H' + lk.spineX + ' V' + t.cy + ' H' + (t.cx - t.w / 2);
    } else {
      var ty = t.cy - t.h / 2, my = (sy + ty) / 2;
      d = 'M' + s.cx + ',' + sy + ' V' + my + ' H' + t.cx + ' V' + ty;
    }
    var path = svgEl('path', {
      d: d, fill: 'none',
      stroke: t.style.stroke,
      'stroke-width': Math.max(1.5, this._opts.linkStroke - 1),
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      opacity: '0.7',
    });
    lk._el = path;
    this._linksG.appendChild(path);
  };

  // Cross-link: dashed curve bowing away from the straight line, edge to edge, label at the middle
  MindkeeperMap.prototype._drawXLink = function (xl) {
    var s = xl.source, t = xl.target;
    var dx = t.cx - s.cx, dy = t.cy - s.cy, len = Math.hypot(dx, dy) || 1;
    // Leave each card at the point where the centre-to-centre line crosses its edge
    function edge(n, sx, sy) {
      var k = Math.min(n.w / 2 / (Math.abs(sx) || 1e-9), n.h / 2 / (Math.abs(sy) || 1e-9));
      return { x: n.cx + sx * k, y: n.cy + sy * k };
    }
    var a = edge(s, dx / len, dy / len), b = edge(t, -dx / len, -dy / len);
    var bow = Math.min(60, len * 0.18);
    var qx = (a.x + b.x) / 2 - (dy / len) * bow, qy = (a.y + b.y) / 2 + (dx / len) * bow;
    var colour = xl.diff ? DIFF[xl.diff].stroke : '#6B7280';
    var g = svgEl('g', { 'class': 'mkmap-xlink' + (xl.type ? ' mkmap-xlink-' + String(xl.type).replace(/[^A-Za-z0-9_-]/g, '_') : '') });
    g.appendChild(svgEl('path', {
      d: 'M' + a.x + ',' + a.y + ' Q' + qx + ',' + qy + ' ' + b.x + ',' + b.y,
      fill: 'none', stroke: colour, 'stroke-width': 1.6,
      'stroke-dasharray': '6 5', 'stroke-linecap': 'round', opacity: '0.85',
    }));
    // Arrow head at the target end
    var ex = b.x - qx, ey = b.y - qy, el = Math.hypot(ex, ey) || 1;
    ex /= el; ey /= el;
    g.appendChild(svgEl('path', {
      d: 'M' + b.x + ',' + b.y + ' L' + (b.x - ex * 8 - ey * 4) + ',' + (b.y - ey * 8 + ex * 4) +
         ' L' + (b.x - ex * 8 + ey * 4) + ',' + (b.y - ey * 8 - ex * 4) + ' Z',
      fill: colour, opacity: '0.85',
    }));
    if (xl.label) {
      // The curve's midpoint (t = 0.5 on the quadratic)
      var mx = (a.x + 2 * qx + b.x) / 4, my = (a.y + 2 * qy + b.y) / 4;
      var w = measureText(xl.label, 10, false) + 10;
      g.appendChild(svgEl('rect', {
        x: mx - w / 2, y: my - 8, width: w, height: 16, rx: 8, ry: 8,
        fill: '#ffffff', stroke: colour, 'stroke-width': 1, opacity: '0.95',
      }));
      var txt = svgEl('text', {
        x: mx, y: my, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-family': this._opts.fontFamily, 'font-size': 10, fill: '#374151', 'pointer-events': 'none',
      });
      txt.textContent = xl.label;
      g.appendChild(txt);
    }
    xl._el = g;
    this._xlinksG.appendChild(g);
  };

  // Legend for highlightDiff: counts per kind, removed names listed (they are not on the map)
  MindkeeperMap.prototype._drawLegend = function () {
    var diff = this._diff;
    if (!diff) {
      if (this._legend && this._legend.parentNode) this._legend.parentNode.removeChild(this._legend);
      this._legend = null;
      return;
    }
    if (!this._legend) {
      this._legend = document.createElement('div');
      this._legend.className = 'mkmap-legend';
      this._legend.style.cssText = 'position:absolute;left:12px;bottom:12px;background:rgba(255,255,255,.94);' +
        'border:1px solid #d6d9e0;border-radius:8px;padding:8px 10px;font:12px/1.5 ' + this._opts.fontFamily +
        ';color:#1f2430;box-shadow:0 2px 6px rgba(0,0,0,.08);max-width:280px;pointer-events:none;';
      this._el.appendChild(this._legend);
    }
    var legend = this._legend, info = diff.info || {};
    while (legend.firstChild) legend.removeChild(legend.firstChild);
    ['added', 'removed', 'moved', 'changed'].forEach(function (k) {
      var ids = diff[k] || [];
      var row = document.createElement('div');
      var sw = document.createElement('span');
      sw.style.cssText = 'display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;' +
        'vertical-align:-2px;border:2px ' + (k === 'moved' ? 'dashed ' : 'solid ') + DIFF[k].stroke + ';';
      row.appendChild(sw);
      var text = ids.length + ' ' + DIFF[k].label;
      if (k === 'removed' && ids.length) {
        var names = ids.slice(0, 6).map(function (id) { return (info[id] && info[id].topic) || id; });
        text += ': ' + names.join(', ') + (ids.length > 6 ? ' +' + (ids.length - 6) : '');
      }
      row.appendChild(document.createTextNode(text));
      legend.appendChild(row);
    });
  };

  MindkeeperMap.prototype._drawNode = function (nd) {
    var self = this;
    var opts = this._opts;

    var g = svgEl('g', { 'class': 'mkmap-node' + (nd.diff ? ' mkmap-diff-' + nd.diff : '') });
    g.style.cursor = 'grab';

    if (nd.diff) {
      var ring = svgEl('rect', {
        x: nd.cx - nd.w / 2 - 5, y: nd.cy - nd.h / 2 - 5,
        width: nd.w + 10, height: nd.h + 10,
        rx: (nd.isRoot ? nd.h / 2 : 8) + 5, ry: (nd.isRoot ? nd.h / 2 : 8) + 5,
        fill: 'none', stroke: DIFF[nd.diff].stroke, 'stroke-width': 3,
        'pointer-events': 'none',
      });
      if (nd.diff === 'moved') ring.setAttribute('stroke-dasharray', '7 4');
      g.appendChild(ring);
      // _parts starts below; the ring is re-added to it once that array exists
      nd._ring = ring;
    }

    var rx   = nd.isRoot ? nd.h / 2 : 8;
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
    nd._parts = [];
    if (nd._ring) nd._parts.push({ el: nd._ring, dx: -nd.w / 2 - 5, dy: -nd.h / 2 - 5 });
    if (nd.inactive) {
      rect.setAttribute('stroke-dasharray', '5 4');
      g.setAttribute('opacity', '0.62');
    }

    // Offsets from the card centre for the label (badge pushes it right, title line pushes it up)
    var tdx = nd.badge ? 14 : 0;
    var tdy = nd.sub ? -8 : 0;
    if (nd.badge) this._drawBadge(nd, g);

    var fs = nd.isRoot ? 15 : nd.depth === 1 ? 13 : 12;
    var fw = nd.isRoot || nd.depth === 1 ? '700' : '400';
    var txt = svgEl('text', {
      x: nd.cx + tdx, y: nd.cy + tdy,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-family': opts.fontFamily,
      'font-size': fs, 'font-weight': fw,
      fill: nd.style.text,
      'pointer-events': 'none',
    });
    txt.textContent = nd.topic;
    nd._txt = txt;
    nd._tdx = tdx; nd._tdy = tdy;
    g.appendChild(txt);

    if (nd.sub) {
      var sub = svgEl('text', {
        x: nd.cx + tdx, y: nd.cy + 9,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-family': opts.fontFamily,
        'font-size': 11, 'font-weight': '400',
        fill: nd.style.text, opacity: '0.78',
        'pointer-events': 'none',
      });
      sub.textContent = nd.sub;
      g.appendChild(sub);
      nd._parts.push({ el: sub, dx: tdx, dy: 9 });
    }

    // Org charts show every branch toggle; the mind map only marks collapsed nodes
    if (nd.hasToggle && (opts.layout === 'orgchart' || nd.collapsed)) this._drawToggle(nd, g);

    g.addEventListener('mouseenter', function () {
      rect.setAttribute('filter', 'url(#mkmap-sh-hov)');
      rect.setAttribute('stroke-width', opts.nodeBorder + 1.5);
    });
    g.addEventListener('mouseleave', function () {
      rect.setAttribute('filter', 'url(#mkmap-sh)');
      rect.setAttribute('stroke-width', self._selectedId === nd.id ? opts.nodeBorder + 2 : opts.nodeBorder);
    });

    g.addEventListener('click', function (e) {
      e.stopPropagation();
      self._setSelected(nd.id);
      self._emit('nodeClick', { id: nd.id, topic: nd.topic });
    });

    nd._el = g;
    this._nodesG.appendChild(g);
    this._bindDrag(nd);
  };

  // +/- button on the card edge (below it in org charts, outer side in the mind map); collapsed shows +N
  MindkeeperMap.prototype._drawToggle = function (nd, g) {
    var self = this, opts = this._opts;
    var org = opts.layout === 'orgchart';
    var label = nd.collapsed ? '+' + nd.hidden : '\u2212';
    var r = label.length > 2 ? 11 : 9;
    var dx = org ? 0 : (nd.isLeft ? -nd.w / 2 - r - 3 : nd.w / 2 + r + 3);
    var dy = org ? nd.h / 2 + r : 0;
    var tg = svgEl('g', { 'class': 'mkmap-toggle' });
    tg.style.cursor = 'pointer';
    var c = svgEl('circle', {
      cx: nd.cx + dx, cy: nd.cy + dy, r: r,
      fill: '#ffffff', stroke: nd.style.stroke, 'stroke-width': 1.5,
    });
    var t = svgEl('text', {
      x: nd.cx + dx, y: nd.cy + dy,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      'font-family': opts.fontFamily, 'font-size': label.length > 2 ? 9 : 11, 'font-weight': '700',
      fill: nd.style.text, 'pointer-events': 'none',
    });
    t.textContent = label;
    tg.appendChild(c); tg.appendChild(t);
    nd._parts.push({ el: c, dx: dx, dy: dy, xAttr: 'cx', yAttr: 'cy' });
    nd._parts.push({ el: t, dx: dx, dy: dy });
    tg.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    tg.addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true });
    tg.addEventListener('click', function (e) {
      e.stopPropagation();
      self.toggle(nd.id);
    });
    g.appendChild(tg);
  };

  // Kind badge on the left of the card: a glyph / initials circle, or the avatar image
  MindkeeperMap.prototype._drawBadge = function (nd, g) {
    var opts = this._opts;
    var bdx = -nd.w / 2 + 17;
    var circle = svgEl('circle', {
      cx: nd.cx + bdx, cy: nd.cy, r: 11,
      fill: nd.style.stroke, 'pointer-events': 'none',
    });
    g.appendChild(circle);
    nd._parts.push({ el: circle, dx: bdx, dy: 0, xAttr: 'cx', yAttr: 'cy' });

    if (nd.avatar) {
      var clipId = 'mkmap-av-' + String(nd.id).replace(/[^A-Za-z0-9_-]/g, '_');
      var clip = svgEl('clipPath', { id: clipId });
      var cc = svgEl('circle', { cx: nd.cx + bdx, cy: nd.cy, r: 10 });
      clip.appendChild(cc);
      g.appendChild(clip);
      nd._parts.push({ el: cc, dx: bdx, dy: 0, xAttr: 'cx', yAttr: 'cy' });
      var img = svgEl('image', {
        x: nd.cx + bdx - 10, y: nd.cy - 10, width: 20, height: 20,
        href: nd.avatar, 'clip-path': 'url(#' + clipId + ')',
        preserveAspectRatio: 'xMidYMid slice', 'pointer-events': 'none',
      });
      g.appendChild(img);
      nd._parts.push({ el: img, dx: bdx - 10, dy: -10 });
      return;
    }

    var glyph = svgEl('text', {
      x: nd.cx + bdx, y: nd.cy,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-family': opts.fontFamily,
      'font-size': nd.badge.length > 1 ? 9 : 11, 'font-weight': '700',
      fill: '#ffffff', 'pointer-events': 'none',
    });
    glyph.textContent = nd.badge;
    g.appendChild(glyph);
    nd._parts.push({ el: glyph, dx: bdx, dy: 0 });
  };

  MindkeeperMap.prototype._setSelected = function (id) {
    var opts = this._opts;
    var prev = this._selectedId;
    this._selectedId = id;
    this._nodes.forEach(function (nd) {
      if (!nd._rect) return;
      if (nd.id === id)   nd._rect.setAttribute('stroke-width', opts.nodeBorder + 2);
      if (nd.id === prev) nd._rect.setAttribute('stroke-width', opts.nodeBorder);
    });
  };

  // ── Live node update after drag ───────────────────────────────────────────────

  MindkeeperMap.prototype._moveNode = function (nd) {
    nd._rect.setAttribute('x', nd.cx - nd.w / 2);
    nd._rect.setAttribute('y', nd.cy - nd.h / 2);
    nd._txt.setAttribute('x', nd.cx + (nd._tdx || 0));
    nd._txt.setAttribute('y', nd.cy + (nd._tdy || 0));
    (nd._parts || []).forEach(function (p) {
      p.el.setAttribute(p.xAttr || 'x', nd.cx + p.dx);
      p.el.setAttribute(p.yAttr || 'y', nd.cy + p.dy);
    });

    var self = this;
    this._links.forEach(function (lk) {
      if (lk.source !== nd && lk.target !== nd) return;
      if (lk._el && lk._el.parentNode) lk._el.parentNode.removeChild(lk._el);
      self._drawLink(lk);
    });
    this._xlinks.forEach(function (xl) {
      if (xl.source !== nd && xl.target !== nd) return;
      if (xl._el && xl._el.parentNode) xl._el.parentNode.removeChild(xl._el);
      self._drawXLink(xl);
    });
  };

  // ── Node drag ────────────────────────────────────────────────────────────────

  MindkeeperMap.prototype._bindDrag = function (nd) {
    var self = this;

    nd._el.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.stopPropagation();
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
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

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
        nd._el.removeEventListener('touchend', onTEnd);
      }
      nd._el.addEventListener('touchmove', onTMove, { passive: false });
      nd._el.addEventListener('touchend', onTEnd);
    }, { passive: false });
  };

  // ── Canvas pan & zoom ────────────────────────────────────────────────────────

  MindkeeperMap.prototype._bindSvgEvents = function () {
    var self = this;
    var svg  = this._svg;
    var bg   = svg.querySelector('.mkmap-bg');

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
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    bg.addEventListener('click', function () {
      if (self._selectedId) {
        self._setSelected(null);
        self._emit('nodeDeselect', {});
      }
    });

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

    var x0 =  Infinity, y0 =  Infinity, x1 = -Infinity, y1 = -Infinity;
    this._nodes.forEach(function (nd) {
      x0 = Math.min(x0, nd.cx - nd.w / 2); y0 = Math.min(y0, nd.cy - nd.h / 2);
      x1 = Math.max(x1, nd.cx + nd.w / 2); y1 = Math.max(y1, nd.cy + nd.h / 2);
    });

    var pad = 52;
    var sc  = Math.min(1, (W - pad * 2) / (x1 - x0), (H - pad * 2) / (y1 - y0));
    var mx  = (x0 + x1) / 2, my = (y0 + y1) / 2;
    this._scale = sc;
    this._tx    = W / 2 - mx * sc;
    this._ty    = H / 2 - my * sc;
    this._applyTransform();
  };

  // ── Export ───────────────────────────────────────────────────────────────────

  function _contentBounds(nodes, pad) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    nodes.forEach(function (nd) {
      x0 = Math.min(x0, nd.cx - nd.w / 2); y0 = Math.min(y0, nd.cy - nd.h / 2);
      x1 = Math.max(x1, nd.cx + nd.w / 2); y1 = Math.max(y1, nd.cy + nd.h / 2);
    });
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }

  function _cloneForExport(self, b) {
    var clone = self._svg.cloneNode(true);
    clone.setAttribute('width',   b.w);
    clone.setAttribute('height',  b.h);
    clone.setAttribute('viewBox', '0 0 ' + b.w + ' ' + b.h);
    clone.setAttribute('xmlns',   'http://www.w3.org/2000/svg');
    var cloneBg   = clone.querySelector('.mkmap-bg');
    if (cloneBg) {
      cloneBg.setAttribute('fill',   '#f8f9fb');
      cloneBg.setAttribute('width',  b.w);
      cloneBg.setAttribute('height', b.h);
    }
    var cloneMain = clone.querySelector('.mkmap-main');
    if (cloneMain) cloneMain.setAttribute('transform', 'translate(' + (-b.x) + ',' + (-b.y) + ')');
    return clone;
  }

  MindkeeperMap.prototype.exportSVG = function (filename) {
    if (!this._nodes.length) return;
    var b   = _contentBounds(this._nodes, 44);
    var xml = new XMLSerializer().serializeToString(_cloneForExport(this, b));
    var url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    var a   = document.createElement('a');
    a.download = filename || 'mindmap.svg'; a.href = url;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
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
      var canvas = document.createElement('canvas');
      canvas.width  = Math.round(b.w * dpr);
      canvas.height = Math.round(b.h * dpr);
      var ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#f8f9fb';
      ctx.fillRect(0, 0, b.w, b.h);
      ctx.drawImage(img, 0, 0, b.w, b.h);
      URL.revokeObjectURL(url);
      var a = document.createElement('a');
      a.download = filename || 'mindmap.png'; a.href = canvas.toDataURL('image/png');
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    };
    img.onerror = function () { URL.revokeObjectURL(url); };
    img.src = url;
  };

  // ── Static helpers (pure, no DOM) ────────────────────────────────────────────

  MindkeeperMap.KINDS = KINDS;
  MindkeeperMap.META_KEYS = META_KEYS;
  MindkeeperMap.serialize = serialize;
  MindkeeperMap.LAYOUTS = ['mindmap', 'orgchart'];
  MindkeeperMap.DIFF = DIFF;
  MindkeeperMap.diff = diffTrees;

  // ── Expose ───────────────────────────────────────────────────────────────────

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MindkeeperMap;
  } else {
    global.MindkeeperMap = MindkeeperMap;
  }

})(typeof window !== 'undefined' ? window : this);
