/**
 * @file Shared vanilla DOM element factories.
 * @module ui/dom
 * @license AGPL-3.0-only
 *
 * Zero dependencies — no p5, no framework.
 * Each function creates and returns a raw HTMLElement.
 * CSS class names use prefix 'p5t-' for easy user overrides.
 */

'use strict';

const CLS = 'p5t';

function _el(tag, cls, attrs) {
  const e = document.createElement(tag);
  if (cls) e.className = `${CLS}-${cls}`;
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

/** Flex-column container, absolute positioned. */
export function createContainer(cls) {
  const c = _el('div', cls || 'ui');
  c.style.cssText = 'position:absolute;display:flex;flex-direction:column;gap:0px;';
  return c;
}

/** Range slider. onChange receives parsed float. */
export function createSlider(min, max, value, step, onChange) {
  const s = _el('input', 'slider', { type: 'range', min, max, step });
  s.value = value;
  if (onChange) s.addEventListener('input', () => onChange(parseFloat(s.value)));
  return s;
}

/** Push button. */
export function createButton(label, onClick) {
  const b = _el('button', 'btn');
  b.textContent = label;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/**
 * Checkbox with label text.
 * Returns the <label> element. Access the <input> via `.firstChild`.
 */
export function createCheckbox(label, checked, onChange) {
  const lab = _el('label', 'check');
  const inp = _el('input', null, { type: 'checkbox' });
  inp.checked = !!checked;
  lab.appendChild(inp);
  lab.appendChild(document.createTextNode(' ' + label));
  if (onChange) inp.addEventListener('change', () => onChange(inp.checked));
  return lab;
}

/** Dropdown select. Options: array of values or { label, value } objects. */
export function createSelect(options, value, onChange) {
  const s = _el('select', 'select');
  (options || []).forEach(o => {
    const opt = document.createElement('option');
    if (o && typeof o === 'object') {
      opt.value = o.value;
      opt.textContent = o.label ?? `${o.value}`;
    } else {
      opt.value = o;
      opt.textContent = `${o}`;
    }
    s.appendChild(opt);
  });
  if (value != null) s.value = value;
  if (onChange) s.addEventListener('change', () => onChange(s.value));
  return s;
}

/** Color picker. onChange receives hex string. */
export function createColorPicker(value, onChange) {
  const c = _el('input', 'color', { type: 'color' });
  c.value = value || '#ffffff';
  if (onChange) c.addEventListener('input', () => onChange(c.value));
  return c;
}

/** Text label (span). */
export function createLabel(text) {
  const l = _el('span', 'label');
  l.textContent = text;
  return l;
}

// ── Color helpers (no p5 dependency) ────────────────────────────────────────

/** '#rrggbb' -> [r, g, b, a] normalised 0-1 */
export function hexToVec4(hex) {
  const h = (hex || '#000000').replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
    1.0
  ];
}

/** [r, g, b (, a)] normalised 0-1 -> '#rrggbb' */
export function vec4ToHex(v) {
  const c = n => Math.round(Math.max(0, Math.min(1, n ?? 0)) * 255)
                    .toString(16).padStart(2, '0');
  return `#${c(v[0])}${c(v[1])}${c(v[2])}`;
}

// ── Visibility helpers (Safari-safe) ────────────────────────────────────────

/**
 * Show/hide a DOM element robustly.
 * Uses a data attribute to remember the previous display value so that
 * Safari input[range] workarounds are preserved on re-show.
 * @param {HTMLElement} el
 * @param {boolean} show
 */
export function setVisible(el, show) {
  if (!el || !el.style) return;
  if (show) {
    const prev = el.dataset?._uiDisplay;
    el.style.display = prev != null ? prev : '';
    if (el.dataset) delete el.dataset._uiDisplay;
  } else {
    if (el.dataset) el.dataset._uiDisplay ??= el.style.display || '';
    el.style.display = 'none';
  }
}

/**
 * Append `child` to `parent`, ensuring parent has non-static positioning
 * so absolute children are anchored correctly.
 * Falls back to `document.body` when parent is null/undefined.
 * @param {HTMLElement} child
 * @param {HTMLElement|null} [parent]
 */
export function mount(child, parent) {
  const p = parent || document.body;
  if (p.style && getComputedStyle(p).position === 'static') {
    p.style.position = 'relative';
  }
  p.appendChild(child);
}
