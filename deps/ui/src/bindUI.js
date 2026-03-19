/**
 * @file Schema-driven parameter panel — binds named controls to a target.
 * @module ui/bindUI
 * @license AGPL-3.0-only
 *
 * Zero p5 dependencies.  Pure vanilla DOM.
 *
 * ---------------------------------------------------------------------------
 * Core concept — binding
 * ---------------------------------------------------------------------------
 * A schema maps parameter names to control definitions.  Each entry produces
 * a DOM control whose value is *bound* to that name in two directions:
 *
 *   user interaction  →  control value changes  →  dirty flag set
 *   tick()            →  dirty controls pushed  →  target(name, value)
 *
 * The target is any receiver that accepts (name, value) pairs:
 *   target(name, value)          plain function
 *   target.set(name, value)      object with set method
 *
 * When target is omitted, bindings are read-only: values are accessible via
 * ui[name].value() but never pushed anywhere automatically.
 *
 * The term "binding" is intentional — this is the same concept used in shader
 * systems (uniform bindings), game-engine inspectors (property bindings), and
 * data-binding frameworks.  The schema key is the binding name; the control is
 * the binding's UI representation; the target is the binding's sink.
 *
 * ---------------------------------------------------------------------------
 * Tick model
 * ---------------------------------------------------------------------------
 * Designed for rendering pipelines where a host clock calls tick() once per
 * frame — the same clock that drives PoseTrack playback.
 *
 * Values are pushed to the target at most once per control per frame and only
 * when the control has changed since the last push (_dirty flag).  The first
 * tick always pushes all values to initialise target state.
 *
 * Multiple user interactions within a single frame (rapid slider drag,
 * programmatic set() calls) collapse to one push at tick() time.  This is the
 * correct behaviour for rendering sinks (shaders, scene params).  It is not
 * suitable for sinks that require every intermediate delta.
 *
 * ---------------------------------------------------------------------------
 * Supported control types (explicit or inferred from schema value)
 * ---------------------------------------------------------------------------
 * 'float'  : slider          'int'    : slider (integer step)
 * 'bool'   : checkbox        'color'  : color picker (→ normalised RGBA vec4)
 * 'vec2'   : 2 sliders       'vec3'   : 3 sliders      'vec4' : 4 sliders
 * 'select' : dropdown        'button' : action button (no value push)
 *
 * Type inference (when cfg.type is omitted):
 *   cfg.options        → 'select'
 *   cfg.onClick fn     → 'button'
 *   boolean value      → 'bool'
 *   array [2..4]       → 'vec2'/'vec3'/'vec4'
 *   string value       → 'color'
 *   number / default   → 'float'
 *
 * ---------------------------------------------------------------------------
 * Returned API
 * ---------------------------------------------------------------------------
 *   ui.el                       HTMLElement (container)
 *   ui.visible        get/set   boolean — whole panel visibility
 *   ui.collapsed      get/set   boolean — body visibility (requires collapsible+title)
 *   ui[name].visible  get/set   boolean — per-binding visibility
 *   ui[name].value()            current bound value
 *   ui[name].set(v)             set programmatically (marks dirty → pushed on next tick)
 *   ui[name].reset()            restore initial value (marks dirty)
 *   ui.each(fn)                 iterate bindings in schema order
 *   ui.elts()                   flat array of all bound DOM elements
 *   ui.reset()                  reset all bindings
 *   ui.parent(el)               re-mount container into a new parent HTMLElement
 *   ui.tick()                   push dirty bindings to target — call once per frame
 *   ui.dispose()                remove DOM, detach listeners
 */

'use strict';

import {
  createContainer, createSlider, createButton,
  createCheckbox, createSelect, createColorPicker,
  createLabel, hexToVec4, vec4ToHex, setVisible, mount
} from './dom.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const isBool  = v => typeof v === 'boolean';
const isArr   = Array.isArray;
const isVec   = v => isArr(v) && v.length >= 2 && v.length <= 4;
const isStr   = v => typeof v === 'string';
const toFloat = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

function inferType(cfg) {
  if (cfg.type) return cfg.type;
  if (cfg.options) return 'select';
  if (typeof cfg.onClick === 'function') return 'button';
  const v = cfg.value;
  if (isBool(v)) return 'bool';
  if (isVec(v)) return ['', 'vec2', 'vec3', 'vec4'][v.length] || 'vec4';
  if (isStr(v)) return 'color';
  return 'float';
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a parameter panel with named bindings.
 *
 * @param {Object<string,Object>} schema  Binding definitions keyed by name.
 * @param {Object} [opt]   Layout options.
 * @param {Function|Object} [opt.target]
 *   If a function `(name, value) => ...`, called for every binding on tick.
 *   If an object with `.set(name, value)`, that method is called instead.
 *   If omitted, read values manually via `ui[name].value()`.
 * @param {number}  [opt.x=0]            Container left (px).
 * @param {number}  [opt.y=0]            Container top (px).
 * @param {number}  [opt.width=120]      Default slider/select width (px).
 * @param {number}  [opt.offset=6]       Vertical gap between rows (px).
 * @param {string}  [opt.color]          Container text color.
 * @param {boolean} [opt.hidden=false]   Start hidden.
 * @param {boolean} [opt.labels=false]   Show per-binding labels.
 * @param {string}  [opt.title]          Bold title row.
 * @param {boolean} [opt.collapsible]    Make title row a collapse toggle (requires title).
 * @param {boolean} [opt.collapsed]      Start collapsed (requires collapsible + title).
 * @param {HTMLElement} [opt.parent]     Mount target (defaults to document.body).
 * @returns {Object} Panel handle — see "Returned API" above.
 */
export function createUI(schema, opt) {
  schema = schema || {};
  opt    = opt    || {};
  const _target = opt.target || null;

  const _order      = Object.keys(schema);
  const _defaults   = {};
  const _labels     = {};
  const _w          = opt.width  ?? 120;
  const _off        = opt.offset ?? 6;
  const _showLabels = !!opt.labels;

  const ui        = {};
  const container = createContainer('param-ui');
  container.style.left = `${opt.x ?? 0}px`;
  container.style.top  = `${opt.y ?? 0}px`;
  if (opt.color) container.style.color = opt.color;

  let _vis = true;

  // ── Collapsible setup ─────────────────────────────────────────────────────
  // body is the content wrapper — everything below the title goes here.
  // When not collapsible it's transparent: same layout, no extra click target.

  const canCollapse = !!(opt.title && (opt.collapsible || 'collapsed' in opt));
  let _collapsed    = canCollapse && !!opt.collapsed;

  const body = document.createElement('div');
  body.className = 'p5t-body';
  body.style.cssText = 'display:flex;flex-direction:column;gap:0px;';

  // ── Title ─────────────────────────────────────────────────────────────────

  let chevron = null;
  if (opt.title) {
    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    titleRow.style.marginBottom = `${_off}px`;

    const titleLabel = createLabel(opt.title);
    titleLabel.style.fontWeight = 'bold';
    titleRow.appendChild(titleLabel);

    if (canCollapse) {
      chevron = createLabel(_collapsed ? '\u25B6' : '\u25BC');
      chevron.style.cssText = 'cursor:pointer;user-select:none;margin-left:6px;';
      titleRow.style.cursor = 'pointer';
      titleRow.appendChild(chevron);
      titleRow.addEventListener('click', () => {
        _collapsed = !_collapsed;
        _applyCollapse();
      });
    }

    container.appendChild(titleRow);
  }

  // ── Per-binding builder ───────────────────────────────────────────────────

  function _setGap(el) { el.style.marginBottom = `${_off}px`; }

  function addLabel(name, cfg) {
    if (!_showLabels) return;
    const l = createLabel(cfg.label || name);
    l.style.marginBottom = `${_off}px`;
    body.appendChild(l);
    _labels[name] = l;
  }

  function wrap(name, type, el, value, set, reset) {
    const c = { type, el, value, _dirty: true, _vis: true };
    // set/reset mark dirty so the bound value is pushed on the next tick.
    c.set   = v  => { set(v);  c._dirty = true; };
    c.reset = () => { reset(); c._dirty = true; };
    Object.defineProperty(c, 'visible', {
      get() { return c._vis; },
      set(v) {
        c._vis = v !== false;
        applyControlVis(name);
      }
    });
    return c;
  }

  function applyControlVis(name) {
    const c = ui[name];
    if (!c) return;
    const show = _vis && c._vis;
    const els  = isArr(c.el) ? c.el : [c.el];
    els.forEach(e => setVisible(e, show));
    _labels[name] && setVisible(_labels[name], show);
  }

  function buildControl(name, cfg) {
    cfg = cfg || {};
    const type = inferType(cfg);
    const w    = cfg.width ?? _w;

    addLabel(name, cfg);

    // ── bool ──
    if (type === 'bool') {
      const el  = createCheckbox('', cfg.value ?? false);
      _setGap(el);
      body.appendChild(el);
      const inp = el.firstChild;
      const c = wrap(name, 'bool', el,
        () => inp.checked,
        v  => { inp.checked = !!v; },
        () => { inp.checked = !!_defaults[name]; }
      );
      inp.addEventListener('change', () => { c._dirty = true; });
      return c;
    }

    // ── button ──
    if (type === 'button') {
      const el = createButton(cfg.label || name,
        typeof cfg.onClick === 'function' ? cfg.onClick : null);
      el.style.width = `${w}px`;
      _setGap(el);
      body.appendChild(el);
      return wrap(name, 'button', el, () => null, () => {}, () => {});
    }

    // ── select ──
    if (type === 'select') {
      const el = createSelect(cfg.options, cfg.value);
      el.style.width = `${w}px`;
      _setGap(el);
      body.appendChild(el);
      const c = wrap(name, 'select', el,
        () => el.value,
        v  => { el.value = v; },
        () => { el.value = _defaults[name]; }
      );
      el.addEventListener('change', () => { c._dirty = true; });
      return c;
    }

    // ── color ──
    if (type === 'color') {
      const el = createColorPicker(cfg.value);
      el.style.width = `${w}px`;
      _setGap(el);
      body.appendChild(el);
      const c = wrap(name, 'color', el,
        () => hexToVec4(el.value),
        v  => { el.value = isStr(v) ? v : isArr(v) ? vec4ToHex(v) : v; },
        () => { el.value = _defaults[name] || '#ffffff'; }
      );
      el.addEventListener('input', () => { c._dirty = true; });
      return c;
    }

    // ── vec2 / vec3 / vec4 ──
    if (type === 'vec2' || type === 'vec3' || type === 'vec4') {
      const n    = type === 'vec2' ? 2 : type === 'vec3' ? 3 : 4;
      const vals = isArr(cfg.value) ? cfg.value : new Array(n).fill(0);
      const min  = cfg.min  ?? 0;
      const max  = cfg.max  ?? 1;
      const step = cfg.step ?? (cfg.type === 'int' ? 1 : 0.01);
      const els  = [];
      for (let i = 0; i < n; i++) {
        const s = createSlider(min, max, toFloat(vals[i] ?? 0), step);
        s.style.width = `${w}px`;
        _setGap(s);
        body.appendChild(s);
        els.push(s);
      }
      const c = wrap(name, type, els,
        ()    => els.map(s => toFloat(s.value)),
        arr   => { isArr(arr) && els.forEach((s, i) => { s.value = toFloat(arr[i] ?? 0); }); },
        ()    => { const d = _defaults[name]; isArr(d) && els.forEach((s, i) => { s.value = toFloat(d[i] ?? 0); }); }
      );
      els.forEach(s => s.addEventListener('input', () => { c._dirty = true; }));
      return c;
    }

    // ── float / int (default) ──
    const val  = toFloat(cfg.value ?? 0);
    const min  = cfg.min  ?? 0;
    const max  = cfg.max  ?? 1;
    const step = cfg.step ?? (cfg.type === 'int' ? 1 : 0.01);
    const el   = createSlider(min, max, val, step);
    el.style.width = `${w}px`;
    _setGap(el);
    body.appendChild(el);
    const c = wrap(name, cfg.type === 'int' ? 'int' : 'float', el,
      () => toFloat(el.value),
      v  => { el.value = toFloat(v); },
      () => { el.value = toFloat(_defaults[name]); }
    );
    el.addEventListener('input', () => { c._dirty = true; });
    return c;
  }

  // ── Build all bindings ─────────────────────────────────────────────────

  _order.forEach(name => {
    _defaults[name] = schema[name] ? schema[name].value : null;
    ui[name] = buildControl(name, schema[name]);
  });

  container.appendChild(body);

  // ── Collapse helper ────────────────────────────────────────────────────

  function _applyCollapse() {
    body.style.display = _collapsed ? 'none' : 'flex';
    if (chevron) chevron.textContent = _collapsed ? '\u25B6' : '\u25BC';
  }

  // ── Container visibility ───────────────────────────────────────────────

  function setContainerVis(show) {
    _vis = show !== false;
    if (_vis) {
      container.style.display       = 'flex';
      container.style.visibility    = 'visible';
      container.style.pointerEvents = 'auto';
    } else {
      container.style.display       = 'none';
      container.style.visibility    = 'hidden';
      container.style.pointerEvents = 'none';
    }
    _order.forEach(applyControlVis);
  }

  Object.defineProperty(ui, 'visible', {
    get() { return _vis; },
    set(v) { setContainerVis(v); }
  });

  Object.defineProperty(ui, 'collapsed', {
    get() { return _collapsed; },
    set(v) {
      if (!canCollapse) return;
      _collapsed = !!v;
      _applyCollapse();
    }
  });

  // ── Public API ─────────────────────────────────────────────────────────

  ui.el = container;

  ui.each = fn => {
    if (typeof fn !== 'function') return;
    _order.forEach(name => fn(name, ui[name]));
  };

  ui.elts = () => {
    const out = [];
    ui.each((_, c) => {
      if (!c || !c.el) return;
      isArr(c.el) ? c.el.forEach(e => e && out.push(e)) : out.push(c.el);
    });
    return out;
  };

  ui.reset = () => {
    _order.forEach(name => { const c = ui[name]; c && c.reset(); });
  };

  /**
   * Re-mount container into a new parent HTMLElement.
   * Accepts a raw HTMLElement (p5.Element unwrapping is the bridge's job).
   * @param {HTMLElement} el
   */
  ui.parent = el => mount(container, el);

  /**
   * Push dirty bindings to target. Call once per frame.
   *
   * Invariant: the target is called at most once per binding per frame,
   * and only if the bound value changed since the last push.
   * The first tick always pushes all bindings to initialise target state.
   */
  ui.tick = () => {
    if (!_target) return;
    const push = typeof _target === 'function'
      ? _target
      : typeof _target.set === 'function'
        ? (name, value) => _target.set(name, value)
        : null;
    if (!push) return;
    _order.forEach(name => {
      const c = ui[name];
      if (!c || c.type === 'button' || !c._dirty) return;
      c._dirty = false;
      push(name, c.value());
    });
  };

  /** Remove container from DOM. */
  ui.dispose = () => {
    container.parentNode && container.parentNode.removeChild(container);
  };

  // ── Mount & initial state ──────────────────────────────────────────────

  mount(container, opt.parent);
  setContainerVis(!opt.hidden);
  _applyCollapse();

  return ui;
}
