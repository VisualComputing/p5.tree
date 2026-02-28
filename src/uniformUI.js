/**
 * @file DOM-based uniform/parameter UI builder (createUniformUI).
 * @module uniformUI
 * @license GPL-3.0-only
 *
 * Contains the `fn.createUniformUI` function.
 */

'use strict';

/**
 * Install createUniformUI on fn.
 * @param {p5} p5  The p5 constructor.
 * @param {Object} fn  p5 prototype.
 */
export function installUniformUI(p5, fn) {
  /**
   * Creates renderer-agnostic UI controls for shader parameters (GLSL / WebGPU / p5.strands).
   * Core-only helper with an optional default vertical layout (show / hide / config).
   * No panel, no background, no drag, no grouping — styling remains user-owned.
   *
   * ---------------------------------------------------------------------------
   * Supported control types (explicit or inferred)
   * ---------------------------------------------------------------------------
   * - 'float'  : slider (createSlider)
   * - 'int'    : slider semantics (createSlider; integer step usually 1)
   * - 'bool'   : checkbox (createCheckbox)
   * - 'color'  : color picker (createColorPicker), value() returns normalized RGBA vec4
   * - 'vec2'   : 2 sliders (x, y)
   * - 'vec3'   : 3 sliders (x, y, z)
   * - 'vec4'   : 4 sliders (x, y, z, w)
   * - 'select' : dropdown (createSelect)
   * - 'button' : action button (createButton)
   *
   * ---------------------------------------------------------------------------
   * Type inference (when cfg.type is omitted)
   * ---------------------------------------------------------------------------
   * - If cfg.options exists                -> 'select'
   * - Else if cfg.onClick is a function    -> 'button'
   * - Else infer from cfg.value:
   *   - boolean                            -> 'bool'
   *   - array length 2 / 3 / 4             -> 'vec2' / 'vec3' / 'vec4'
   *   - string                             -> 'color' (CSS color / hex)
   *   - number (or no value provided)      -> 'float'
   *
   * ---------------------------------------------------------------------------
   * Schema entry keys (per control)
   * ---------------------------------------------------------------------------
   * Common:
   * - value   : initial value (type-dependent)
   * - label   : label text (defaults to key name)
   * - type    : force a specific control type
   * - width   : per-control width override
   *
   * Slider-based (float / int / vec2 / vec3 / vec4):
   * - min, max, step
   *
   * Select:
   * - options : array of values OR array of { label, value }
   *
   * Button:
   * - onClick : function invoked on press
   *
   * ---------------------------------------------------------------------------
   * Layout
   * ---------------------------------------------------------------------------
   * - Default layout is vertical: [label] then [control], repeated.
   * - If opt.labels is true, labels are rendered above each control.
   * - If opt.title is provided, a bold title row is rendered at the top.
   * - The container is absolutely positioned at (opt.x, opt.y).
   * - If opt.parent is provided (HTMLElement or p5.Element), the container
   *   is mounted into it. If omitted, it is appended to document.body.
   * - When mounting into a parent, this helper ensures the parent has a
   *   non-static CSS position (sets position: relative if needed), allowing
   *   predictable positioning inside frameworks (Vue / Slidev / etc.).
   *
   * ---------------------------------------------------------------------------
   * Visibility model
   * ---------------------------------------------------------------------------
   * - ui.visible toggles the entire container (default true unless opt.hidden = true).
   * - ui[name].visible toggles a single control (and its label if labels=true).
   *
   * Implementation note (iOS / Safari):
   * - Visibility uses DOM-level display / visibility / pointer-events toggles
   *   (not only p5.Element.hide()/show()) to avoid Safari desync and
   *   hit-testing issues with <input type="range"> elements.
   *
   * ---------------------------------------------------------------------------
   * Returned API
   * ---------------------------------------------------------------------------
   * ui.visible                : boolean (whole UI visibility)
   * ui[name].visible          : boolean (per-control visibility)
   *
   * ui.container()            : returns container p5.Element
   * ui.parent(parent)         : re-parent container (HTMLElement or p5.Element)
   * ui.each(fn)               : iterate controls in schema order
   * ui.elts()                 : flat array of underlying p5.Elements
   * ui.reset()                : reset all controls to initial values
   *
   * Each control wrapper (ui[name]) provides:
   * - elt                     : p5.Element (or array for vec*)
   * - value()                 : getter
   * - set(v)                  : setter
   * - reset()                 : restore initial value
   * - visible                 : boolean property
   *
   * ---------------------------------------------------------------------------
   * @method createUniformUI
   * @memberof p5
   * @param {Object<string, Object>} [schema={}] Control schema keyed by uniform/action name.
   * @param {Object} [opt={}] Layout/options.
   * @param {number} [opt.x=0] Container x position.
   * @param {number} [opt.y=0] Container y position.
   * @param {number} [opt.width=120] Width for sliders/selects/buttons.
   * @param {number} [opt.offset=6] Vertical spacing between rows.
   * @param {string} [opt.color] Text color applied to container (inherited by labels).
   * @param {boolean} [opt.hidden=false] If true, UI starts hidden.
   * @param {boolean} [opt.labels=false] If true, render per-control labels.
   * @param {string} [opt.title] Optional container title.
   * @param {(HTMLElement|p5.Element)} [opt.parent] Optional parent container.
   * @returns {p5.UniformUI} UniformUI object holding controls and helpers.
   *
   * ---------------------------------------------------------------------------
   * @example
   * // GLSL/WebGPU (setUniform path): float + bool + color (inferred types)
   * const ui = createUniformUI({
   *   frequency: { min: 0, max: 10, value: 3, step: 0.1, label: 'frequency' },
   *   enabled:   { value: true, label: 'enabled' },
   *   tint:      { value: '#ff00ff', label: 'tint' }
   * }, { x: 10, y: 10, width: 160, labels: true, title: 'Post FX', color: 'white' });
   *
   * // Toggle a single control
   * ui.frequency.visible = false;
   *
   * @example
   * // p5.strands (graph-build callback): read via closures
   * function blurCallback () {
   *   const blurIntensity = uniformFloat(() => ui.blurIntensity.value());
   *   const enabled = uniformBool(() => ui.enabled.value());
   * }
   *
   * @example
   * // Toggle entire UI
   * ui.visible = false;
   */
  fn.createUniformUI = function (schema = {}, opt = {}) {
    const p = this;
    const _schema = schema || {};
    const ui = {};
    const _defaults = {};
    const _order = Object.keys(_schema);
    const _layout = { x: opt.x ?? 0, y: opt.y ?? 0, width: opt.width ?? 120, offset: opt.offset ?? 6, color: opt.color, hidden: !!opt.hidden, labels: !!opt.labels, title: opt.title };
    let _parent = opt.parent;
    let _parentElt = _parent && (_parent.elt || _parent);
    let _container = p.createDiv();
    let _titleElt = null;
    const _labelElts = {};
    const isBool = v => typeof v === 'boolean';
    const isArr = Array.isArray;
    const isVec = v => isArr(v) && (v.length === 2 || v.length === 3 || v.length === 4);
    const isStr = v => typeof v === 'string';
    const isNum = v => typeof v === 'number' && Number.isFinite(v);
    const toFloat = v => { if (isNum(v)) return v;const n = typeof v === 'string' ? parseFloat(v) : Number(v);return Number.isFinite(n) ? n : 0; };
    const inferType = (cfg = {}) => { if (cfg.type) return cfg.type;if (cfg.options) return 'select';if (typeof cfg.onClick === 'function') return 'button';const v = cfg.value;if (isBool(v)) return 'bool';if (isVec(v)) return v.length === 2 ? 'vec2' : v.length === 3 ? 'vec3' : 'vec4';if (isStr(v)) return 'color';return 'float'; };
    const wrap = (type, elt, value, set, reset) => ({ type, elt, value, set, reset });
    /**
     * Robust DOM-level display toggling.
     * NOTE: iOS Safari can leave <input type="range"> in hit-testing
     * when using p5.Element.hide(). We bypass that here.
     */
    const _setDisplay = (elt, show) => {
      if (!elt) return;
      const dom = elt.elt || elt;
      if (!dom || !dom.style) return;
      if (show) {
        const prev = dom.dataset ? dom.dataset._treeDisplay : null;
        if (prev != null) dom.style.display = prev;
        else dom.style.display = '';
        dom.dataset && delete dom.dataset._treeDisplay;
      } else {
        dom.dataset && (dom.dataset._treeDisplay ??= dom.style.display || '');
        dom.style.display = 'none';
      }
    };
    const _setMarginBottom = (elt, px) => {
      if (!elt) return;
      const dom = elt.elt || elt;
      if (!dom || !dom.style) return;
      dom.style.marginBottom = `${px}px`;
    };
    const _containerVisible = () => !!(_container && _container._visible !== false);
    const _setContainerVisible = (show) => {
      if (!_container || !_container.elt) return;
      const next = show !== false;
      if (((_container._visible !== false) === next)) return;
      _container._visible = next;
      const dom = _container.elt;
      if (next) {
        const prev = dom.dataset ? dom.dataset._treeDisplay : null;
        dom.style.display = prev != null ? prev : 'flex';
        dom.dataset && delete dom.dataset._treeDisplay;
        dom.style.visibility = 'visible';
        dom.style.pointerEvents = 'auto';
      } else {
        dom.dataset && (dom.dataset._treeDisplay ??= dom.style.display || 'flex');
        dom.style.display = 'none';
        dom.style.visibility = 'hidden';
        dom.style.pointerEvents = 'none';
      }
    };
    const _applyControlVisibility = (name) => {
      const c = ui[name];
      if (!c) return;
      const show = _containerVisible() && (c._visible !== false);
      const elts = Array.isArray(c.elt) ? c.elt : [c.elt];
      elts.forEach(e => _setDisplay(e, show));
      const lab = _labelElts[name];
      _layout.labels && _setDisplay(lab, show);
    };
    const _applyAllControlVisibility = () => { _order.forEach(name => _applyControlVisibility(name)); };
    const _defineVisibleProp = (name, c) => {
      c._visible = true;
      Object.defineProperty(c, 'visible', {
        get () { return c._visible !== false; },
        set (v) { const next = v !== false;if ((c._visible !== false) === next) return;c._visible = next;_applyControlVisibility(name); }
      });
    };
    const _defineUIVisibleProp = () => {
      Object.defineProperty(ui, 'visible', {
        get () { return _containerVisible(); },
        set (v) { _setContainerVisible(v !== false);_applyAllControlVisibility(); }
      });
    };
    const build = (name, cfg = {}) => {
      const type = inferType(cfg);
      const label = cfg.label || name;
      const w = cfg.width ?? _layout.width;
      const addLabel = () => {
        if (!_layout.labels) return null;
        const l = p.createSpan(label);
        l.parent(_container);
        _labelElts[name] = l;
        return l;
      };
      const base = () => {
        const l = addLabel();
        l && _setMarginBottom(l, _layout.offset);
      };
      const setWidth = (elt) => { elt && elt.style && elt.style('width', `${w}px`); };
      const setRowGap = (elt) => { elt && elt.style && elt.style('margin-bottom', `${_layout.offset}px`); };
      const makeSlider = (v, min, max, step) => {
        const s = p.createSlider(min, max, v, step);
        setWidth(s);
        setRowGap(s);
        s.parent(_container);
        return s;
      };
      const makeSelect = (v, options) => {
        const s = p.createSelect();
        (options || []).forEach(o => { const val = (o && typeof o === 'object') ? o.value : o;const lab = (o && typeof o === 'object') ? (o.label ?? `${o.value}`) : `${o}`;s.option(lab, val); });
        s.value(v);
        setWidth(s);
        setRowGap(s);
        s.parent(_container);
        return s;
      };
      const makeCheckbox = (v) => {
        const c = p.createCheckbox('', !!v);
        setRowGap(c);
        c.parent(_container);
        return c;
      };
      const makeButton = (txt) => {
        const b = p.createButton(txt);
        setWidth(b);
        setRowGap(b);
        b.parent(_container);
        return b;
      };
      const makeColor = (v) => {
        const c = p.createColorPicker(v || '#ffffff');
        setWidth(c);
        setRowGap(c);
        c.parent(_container);
        return c;
      };
      if (type === 'bool') {
        base();
        const elt = makeCheckbox(cfg.value ?? false);
        const api = wrap('bool', elt, () => elt.checked(), (v) => { elt.checked(!!v); }, () => { elt.checked(!!(_defaults[name])); });
        _defineVisibleProp(name, api);
        return api;
      }
      if (type === 'button') {
        base();
        const elt = makeButton(label);
        typeof cfg.onClick === 'function' && elt.mousePressed(() => cfg.onClick());
        const api = wrap('button', elt, () => null, () => null, () => null);
        _defineVisibleProp(name, api);
        return api;
      }
      if (type === 'select') {
        base();
        const elt = makeSelect(cfg.value, cfg.options);
        const api = wrap('select', elt, () => elt.value(), (v) => { elt.value(v); }, () => { elt.value(_defaults[name]); });
        _defineVisibleProp(name, api);
        return api;
      }
      if (type === 'color') {
        base();
        const elt = makeColor(cfg.value);
        const api = wrap('color', elt, () => {
          const c = elt.color ? elt.color() : elt.value();
          const cc = (typeof c === 'string') ? p.color(c) : c;
          return [cc.levels[0] / 255, cc.levels[1] / 255, cc.levels[2] / 255, (cc.levels[3] ?? 255) / 255];
        }, (v) => {
          if (typeof v === 'string') { elt.value(v); return; }
          if (Array.isArray(v)) {
            const r = Math.round((v[0] ?? 0) * 255);
            const g = Math.round((v[1] ?? 0) * 255);
            const b = Math.round((v[2] ?? 0) * 255);
            elt.value(p.color(r, g, b).toString('#rrggbb'));
          }
        }, () => { elt.value(_defaults[name] || '#ffffff'); });
        _defineVisibleProp(name, api);
        return api;
      }
      if (type === 'vec2' || type === 'vec3' || type === 'vec4') {
        base();
        const n = type === 'vec2' ? 2 : type === 'vec3' ? 3 : 4;
        const v = Array.isArray(cfg.value) ? cfg.value : new Array(n).fill(0);
        const min = cfg.min ?? 0;
        const max = cfg.max ?? 1;
        const step = cfg.step ?? ((cfg.type === 'int') ? 1 : 0.01);
        const elts = [];
        for (let i = 0; i < n; i++) elts.push(makeSlider(toFloat(v[i] ?? 0), min, max, step));
        const api = wrap(type, elts, () => elts.map(s => toFloat(s.value())), (arr) => { Array.isArray(arr) && elts.forEach((s, i) => s.value(toFloat(arr[i] ?? 0))); }, () => { const d = _defaults[name];Array.isArray(d) && elts.forEach((s, i) => s.value(toFloat(d[i] ?? 0))); });
        _defineVisibleProp(name, api);
        return api;
      }
      base();
      const val = toFloat(cfg.value ?? 0);
      const min = cfg.min ?? 0;
      const max = cfg.max ?? 1;
      const step = cfg.step ?? ((cfg.type === 'int') ? 1 : 0.01);
      const elt = makeSlider(val, min, max, step);
      const api = wrap((cfg.type === 'int') ? 'int' : 'float', elt, () => toFloat(elt.value()), (v) => { elt.value(toFloat(v)); }, () => { elt.value(toFloat(_defaults[name])); });
      _defineVisibleProp(name, api);
      return api;
    };
    const container = () => _container;
    const each = (fn) => { if (typeof fn !== 'function') return;_order.forEach(name => fn(name, ui[name])); };
    const elts = () => { const out = [];each((_, c) => { if (!c || !c.elt) return;Array.isArray(c.elt) ? c.elt.forEach(e => e && out.push(e)) : out.push(c.elt); });return out; };
    const reset = () => { _order.forEach(name => { const c = ui[name];c && typeof c.reset === 'function' && c.reset(); }); };
    const setParent = (parent) => {
      _parent = parent;
      _parentElt = _parent && (_parent.elt || _parent);
      if (_parentElt && _parentElt.style && getComputedStyle(_parentElt).position === 'static') {
        _parentElt.style.position = 'relative';
      }
      _container.parent(_parentElt || null);
    };
    _container.style('position', 'absolute');
    _container.style('display', 'flex');
    _container.style('flex-direction', 'column');
    _container.style('gap', '0px');
    _container.style('left', `${_layout.x}px`);
    _container.style('top', `${_layout.y}px`);
    _layout.color && _container.style('color', _layout.color);
    if (_layout.title) {
      _titleElt = p.createDiv(_layout.title);
      _titleElt.parent(_container);
      _titleElt.style('margin-bottom', `${_layout.offset}px`);
      _titleElt.style('font-weight', 'bold');
    }
    _order.forEach(name => { _defaults[name] = _schema[name] ? _schema[name].value : null;ui[name] = build(name, _schema[name] || {}); });
    ui.container = container;
    ui.each = each;
    ui.elts = elts;
    ui.reset = reset;
    ui.parent = setParent;
    _defineUIVisibleProp();
    setParent(_parentElt || document.body);
    _setContainerVisible(!_layout.hidden);
    _applyAllControlVisibility();
    return ui;
  };
}
