/**
 * @file DOM-based uniform/parameter UI builder.
 * @module ui/uniformUI
 * @license GPL-3.0-only
 *
 * Zero p5 dependencies.  Pure vanilla DOM.
 * The only contract with the host is:
 *   target.setUniform(name, value)
 *
 * Can be mounted into any container (Vue, React, plain HTML, canvas parent).
 * All styling lives in user space — this module applies only structural CSS
 * (position, display, flex-direction, gap) via inline styles and `p5t-*`
 * class names that users can override.
 *
 * ---------------------------------------------------------------------------
 * Supported control types (explicit or inferred)
 * ---------------------------------------------------------------------------
 * 'float'  : slider          'int'    : slider (integer step)
 * 'bool'   : checkbox         'color'  : color picker (-> normalised RGBA vec4)
 * 'vec2'   : 2 sliders        'vec3'   : 3 sliders      'vec4' : 4 sliders
 * 'select' : dropdown         'button' : action button (no uniform)
 *
 * Type inference (when cfg.type is omitted):
 *   cfg.options       -> 'select'
 *   cfg.onClick fn    -> 'button'
 *   boolean value     -> 'bool'
 *   array [2..4]      -> 'vec2'/'vec3'/'vec4'
 *   string value      -> 'color'
 *   number / default  -> 'float'
 *
 * ---------------------------------------------------------------------------
 * Returned API
 * ---------------------------------------------------------------------------
 *   ui.el                       HTMLElement (container)
 *   ui.visible        get/set   boolean — whole UI visibility
 *   ui[name].visible  get/set   boolean — per-control visibility
 *   ui[name].value()            getter
 *   ui[name].set(v)             setter
 *   ui[name].reset()            restore initial value
 *   ui.each(fn)                 iterate controls in schema order
 *   ui.elts()                   flat array of DOM elements
 *   ui.reset()                  reset all controls
 *   ui.parent(el)               re-parent container
 *   ui.tick()                   sync all values to target.setUniform
 *   ui.dispose()                remove DOM, detach listeners
 */

'use strict';

import {
  createContainer, createSlider, createButton,
  createCheckbox, createSelect, createColorPicker,
  createLabel, hexToVec4, vec4ToHex, setVisible, mount
} from './dom.js';

// ── Helpers ─────────────────────────────────────────────────────────────

const isBool  = v => typeof v === 'boolean';
const isArr   = Array.isArray;
const isVec   = v => isArr(v) && v.length >= 2 && v.length <= 4;
const isStr   = v => typeof v === 'string';
const isNum   = v => typeof v === 'number' && Number.isFinite(v);
const toFloat = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

function inferType(cfg) {
  if (cfg.type) return cfg.type;
  if (cfg.options) return 'select';
  if (typeof cfg.onClick === 'function') return 'button';
  const v = cfg.value;
  if (isBool(v)) return 'bool';
  if (isVec(v)) return ['','vec2','vec3','vec4'][v.length] || 'vec4';
  if (isStr(v)) return 'color';
  return 'float';
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Build a uniform UI.
 *
 * @param {Object<string,Object>} schema  Control definitions keyed by name.
 * @param {Object} [opt]   Layout options.
 * @param {Object}  [opt.target]     Anything with `.setUniform(name, value)`.
 *   If provided, `tick()` auto-applies values. Otherwise values are read
 *   manually via `ui[name].value()` (e.g. for p5.strands closures).
 * @param {number}  [opt.x=0]       Container left.
 * @param {number}  [opt.y=0]       Container top.
 * @param {number}  [opt.width=120] Default slider/select width (px).
 * @param {number}  [opt.offset=6]  Vertical gap between rows (px).
 * @param {string}  [opt.color]     Container text color.
 * @param {boolean} [opt.hidden]    Start hidden.
 * @param {boolean} [opt.labels]    Show per-control labels.
 * @param {string}  [opt.title]     Bold title row.
 * @param {HTMLElement} [opt.parent] Mount target (default: document.body).
 * @returns {Object} UI handle — see "Returned API" above.
 */
export function createUniformUI(schema, opt) {
  schema = schema || {};
  opt = opt || {};
  const _target = opt.target || null;

  const _order = Object.keys(schema);
  const _defaults = {};
  const _labels = {};
  const _w = opt.width ?? 120;
  const _off = opt.offset ?? 6;
  const _showLabels = !!opt.labels;

  const ui = {};
  const container = createContainer('uniform-ui');
  container.style.left = `${opt.x ?? 0}px`;
  container.style.top = `${opt.y ?? 0}px`;
  if (opt.color) container.style.color = opt.color;

  let _vis = true;

  // ── Title ──────────────────────────────────────────────────────────
  if (opt.title) {
    const t = createLabel(opt.title);
    t.style.fontWeight = 'bold';
    t.style.marginBottom = `${_off}px`;
    container.appendChild(t);
  }

  // ── Per-control builder ────────────────────────────────────────────

  function _setWidth(el) { el.style.width = `${_w}px`; }
  function _setGap(el) { el.style.marginBottom = `${_off}px`; }

  function addLabel(name, cfg) {
    if (!_showLabels) return;
    const l = createLabel(cfg.label || name);
    l.style.marginBottom = `${_off}px`;
    container.appendChild(l);
    _labels[name] = l;
  }

  function wrap(name, type, el, value, set, reset) {
    const c = { type, el, value, set, reset, _vis: true };
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
    const els = isArr(c.el) ? c.el : [c.el];
    els.forEach(e => setVisible(e, show));
    _labels[name] && setVisible(_labels[name], show);
  }

  function buildControl(name, cfg) {
    cfg = cfg || {};
    const type = inferType(cfg);
    const w = cfg.width ?? _w;

    addLabel(name, cfg);

    // ── bool ──
    if (type === 'bool') {
      const el = createCheckbox('', cfg.value ?? false);
      _setGap(el);
      container.appendChild(el);
      const inp = el.firstChild;
      return wrap(name, 'bool', el,
        () => inp.checked,
        v => { inp.checked = !!v; },
        () => { inp.checked = !!_defaults[name]; }
      );
    }

    // ── button ──
    if (type === 'button') {
      const el = createButton(cfg.label || name, typeof cfg.onClick === 'function' ? cfg.onClick : null);
      el.style.width = `${w}px`;
      _setGap(el);
      container.appendChild(el);
      return wrap(name, 'button', el, () => null, () => {}, () => {});
    }

    // ── select ──
    if (type === 'select') {
      const el = createSelect(cfg.options, cfg.value);
      el.style.width = `${w}px`;
      _setGap(el);
      container.appendChild(el);
      return wrap(name, 'select', el,
        () => el.value,
        v => { el.value = v; },
        () => { el.value = _defaults[name]; }
      );
    }

    // ── color ──
    if (type === 'color') {
      const el = createColorPicker(cfg.value);
      el.style.width = `${w}px`;
      _setGap(el);
      container.appendChild(el);
      return wrap(name, 'color', el,
        () => hexToVec4(el.value),
        v => { el.value = isStr(v) ? v : isArr(v) ? vec4ToHex(v) : v; },
        () => { el.value = _defaults[name] || '#ffffff'; }
      );
    }

    // ── vec2 / vec3 / vec4 ──
    if (type === 'vec2' || type === 'vec3' || type === 'vec4') {
      const n = type === 'vec2' ? 2 : type === 'vec3' ? 3 : 4;
      const vals = isArr(cfg.value) ? cfg.value : new Array(n).fill(0);
      const min = cfg.min ?? 0, max = cfg.max ?? 1;
      const step = cfg.step ?? (cfg.type === 'int' ? 1 : 0.01);
      const els = [];
      for (let i = 0; i < n; i++) {
        const s = createSlider(min, max, toFloat(vals[i] ?? 0), step);
        s.style.width = `${w}px`;
        _setGap(s);
        container.appendChild(s);
        els.push(s);
      }
      return wrap(name, type, els,
        () => els.map(s => toFloat(s.value)),
        arr => { isArr(arr) && els.forEach((s, i) => { s.value = toFloat(arr[i] ?? 0); }); },
        () => { const d = _defaults[name]; isArr(d) && els.forEach((s, i) => { s.value = toFloat(d[i] ?? 0); }); }
      );
    }

    // ── float / int (default) ──
    const val = toFloat(cfg.value ?? 0);
    const min = cfg.min ?? 0, max = cfg.max ?? 1;
    const step = cfg.step ?? (cfg.type === 'int' ? 1 : 0.01);
    const el = createSlider(min, max, val, step);
    el.style.width = `${w}px`;
    _setGap(el);
    container.appendChild(el);
    return wrap(name, cfg.type === 'int' ? 'int' : 'float', el,
      () => toFloat(el.value),
      v => { el.value = toFloat(v); },
      () => { el.value = toFloat(_defaults[name]); }
    );
  }

  // ── Build all controls ─────────────────────────────────────────────

  _order.forEach(name => {
    _defaults[name] = schema[name] ? schema[name].value : null;
    ui[name] = buildControl(name, schema[name]);
  });

  // ── Container visibility ───────────────────────────────────────────

  function setContainerVis(show) {
    _vis = show !== false;
    if (_vis) {
      container.style.display = 'flex';
      container.style.visibility = 'visible';
      container.style.pointerEvents = 'auto';
    } else {
      container.style.display = 'none';
      container.style.visibility = 'hidden';
      container.style.pointerEvents = 'none';
    }
    _order.forEach(applyControlVis);
  }

  Object.defineProperty(ui, 'visible', {
    get() { return _vis; },
    set(v) { setContainerVis(v); }
  });

  // ── Public API ─────────────────────────────────────────────────────

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

  ui.parent = p => {
    const parentEl = (p && p.elt) ? p.elt : p;
    mount(container, parentEl);
  };

  /** Sync all current values to opt.target.setUniform() if target was provided. */
  ui.tick = () => {
    if (!_target || typeof _target.setUniform !== 'function') return;
    _order.forEach(name => {
      const c = ui[name];
      if (!c || c.type === 'button') return;
      _target.setUniform(name, c.value());
    });
  };

  /** Remove container from DOM. */
  ui.dispose = () => {
    container.parentNode && container.parentNode.removeChild(container);
  };

  // ── Mount & initial visibility ─────────────────────────────────────

  mount(container, opt.parent);
  setContainerVis(!opt.hidden);

  return ui;
}
