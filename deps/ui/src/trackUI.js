/**
 * @file DOM-based transport controls for PoseTrack (or any compatible target).
 * @module ui/trackUI
 * @license GPL-3.0-only
 *
 * Zero p5 dependencies.  Pure vanilla DOM.
 *
 * Transport model:
 *   The rate slider doubles as a jog control — the sole play/stop mechanism.
 *     rate !== 0  →  auto-play at that rate (negative = reverse)
 *     rate === 0  →  auto-stop
 *   The seek slider scrubs position (stops playback while dragging).
 *   The mode select sets once / loop / pingPong.
 *
 * Target contract (duck-typed):
 *   target.play(opts?)   Start playback.
 *   target.stop(reset?)  Stop; if truthy, reset cursor.
 *   target.seek(t)       Set normalised position 0-1.
 *   target.time()        Returns normalised position 0-1.
 *   target.playing       Boolean — true while playing.
 *   target.onPlay        Callback hook (chained, not clobbered).
 *   target.onEnd         Callback hook (chained, not clobbered).
 *
 * Optional:
 *   target.add()         Add keyframe (e.g. snapshot current camera).
 *   target.reset()       Clear all keyframes and stop.
 *   target.info()        Returns { keyframes, segments, seg, f, time, ... }.
 *
 * ---------------------------------------------------------------------------
 * Returned API
 * ---------------------------------------------------------------------------
 *   ui.el             HTMLElement container
 *   ui.visible        get/set boolean
 *   ui.tick()         Sync seek slider & info from target state
 *   ui.dispose()      Remove DOM, restore original hooks
 */

'use strict';

import {
  createContainer, createSlider, createButton,
  createSelect, createLabel, mount
} from './dom.js';

/**
 * Build a track transport UI.
 *
 * @param {Object} target    PoseTrack (or duck-compatible object).
 * @param {Object} [opt]     Options.
 * @param {boolean} [opt.seek=true]       Show seek slider.
 * @param {boolean} [opt.props=true]      Show rate slider + mode select.
 * @param {boolean} [opt.info=false]      Show time/keyframe readout.
 * @param {number}  [opt.rate=1]          Default rate (-2 to 2; 0 = stopped).
 * @param {boolean} [opt.loop=false]      Default loop flag (sets initial mode).
 * @param {boolean} [opt.pingPong=false]  Default pingPong flag (overrides loop).
 * @param {number}  [opt.x=0]            Container left.
 * @param {number}  [opt.y=0]            Container top.
 * @param {number}  [opt.width=220]      Seek slider width (px).
 * @param {string}  [opt.color]          Text color.
 * @param {boolean} [opt.hidden=false]   Start hidden.
 * @param {HTMLElement} [opt.parent]     Mount target.
 * @returns {Object} UI handle.
 */
export function createTrackUI(target, opt) {
  opt = opt || {};

  const showSeek  = opt.seek !== false;
  const showProps = opt.props !== false;
  const showInfo  = opt.info === true;
  const sliderW   = opt.width ?? 220;

  // Mutable playback parameters — UI controls update these
  let _rate = opt.rate ?? 1;
  let _mode = opt.pingPong ? 'pingPong' : opt.loop ? 'loop' : 'once';

  const container = createContainer('track-ui');
  container.style.left = `${opt.x ?? 0}px`;
  container.style.top  = `${opt.y ?? 0}px`;
  if (opt.color) container.style.color = opt.color;

  let _vis = true;
  let _seeking = false;

  /** Convert current mode + rate into play() options. */
  function _playOpts() {
    return {
      rate: _rate,
      loop:     _mode === 'loop' || _mode === 'pingPong',
      pingPong: _mode === 'pingPong'
    };
  }

  // ── Seek slider ───────────────────────────────────────────────────

  let seekSlider;
  if (showSeek) {
    seekSlider = createSlider(0, 1, 0, 0.001, v => {
      _seeking = true;
      if (target.playing) target.stop();
      target.seek(v);
    });
    seekSlider.style.width = `${sliderW}px`;
    seekSlider.style.marginBottom = '4px';
    seekSlider.addEventListener('change',    () => { _seeking = false; });
    seekSlider.addEventListener('pointerup', () => { _seeking = false; });
    seekSlider.addEventListener('touchend',  () => { _seeking = false; });
    container.appendChild(seekSlider);
  }

  // ── Action buttons (add / reset — shown if target supports them) ────

  const hasAdd   = typeof target.add === 'function';
  const hasReset = typeof target.reset === 'function';
  if (hasAdd || hasReset) {
    const actRow = document.createElement('div');
    actRow.className = 'p5t-actions';
    actRow.style.cssText = 'display:flex;gap:4px;margin-bottom:4px;';

    if (hasAdd) {
      const btnAdd = createButton('\u002B', () => {
        target.add();
        showInfo && updateInfo();
      });
      btnAdd.title = 'Add keyframe';
      actRow.appendChild(btnAdd);
    }

    if (hasReset) {
      const btnReset = createButton('\u21BA', () => {
        target.reset();
        // Snap rate to 0 since there's nothing to play
        if (rateSlider) {
          _rate = 0;
          rateSlider.value = 0;
          if (rateLabel) rateLabel.textContent = 'rate: 0.00';
        }
        showInfo && updateInfo();
      });
      btnReset.title = 'Reset (clear keyframes)';
      actRow.appendChild(btnReset);
    }

    container.appendChild(actRow);
  }

  // ── Rate slider (jog control — sole transport) + mode select ──────

  let rateSlider, rateLabel, modeSelect;
  if (showProps) {
    const propsRow = document.createElement('div');
    propsRow.className = 'p5t-props';
    propsRow.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-bottom:4px;font-size:11px;';

    // Rate slider [-2, 2]
    const rateRow = document.createElement('div');
    rateRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    rateLabel = createLabel(`rate: ${_rate.toFixed(2)}`);
    rateLabel.style.minWidth = '72px';
    rateSlider = createSlider(-2, 2, _rate, 0.05, v => {
      _rate = v;
      rateLabel.textContent = `rate: ${v.toFixed(2)}`;
      // Jog-control: rate away from 0 auto-plays, rate at 0 auto-stops
      if (v !== 0 && !target.playing) target.play(_playOpts());
      else if (v === 0 && target.playing) target.stop();
      else if (target.playing) target.play(_playOpts());
    });
    rateSlider.style.width = '120px';
    rateRow.appendChild(rateLabel);
    rateRow.appendChild(rateSlider);
    propsRow.appendChild(rateRow);

    // Mode select (once / loop / pingPong)
    const modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const modeLabel = createLabel('mode:');
    modeLabel.style.minWidth = '72px';
    modeSelect = createSelect(
      [{ label: 'once', value: 'once' },
       { label: 'loop', value: 'loop' },
       { label: 'pingPong', value: 'pingPong' }],
      _mode,
      v => {
        _mode = v;
        if (target.playing) target.play(_playOpts());
      }
    );
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(modeSelect);
    propsRow.appendChild(modeRow);

    container.appendChild(propsRow);
  }

  // ── Info label ────────────────────────────────────────────────────

  let infoLabel;
  if (showInfo) {
    infoLabel = createLabel('');
    infoLabel.style.fontSize = '11px';
    infoLabel.style.opacity = '0.8';
    infoLabel.style.marginBottom = '4px';
    container.appendChild(infoLabel);
  }

  // ── Hook chaining ─────────────────────────────────────────────────
  // When playback ends naturally (onEnd), snap rate slider to 0 so the
  // visual state stays consistent (stopped = 0).

  const _prevOnPlay = target.onPlay;
  const _prevOnEnd  = target.onEnd;

  target.onPlay = function () {
    if (typeof _prevOnPlay === 'function') {
      try { _prevOnPlay.apply(this, arguments); } catch (_) {}
    }
  };

  target.onEnd = function () {
    if (typeof _prevOnEnd === 'function') {
      try { _prevOnEnd.apply(this, arguments); } catch (_) {}
    }
    // Playback ended naturally — snap rate to 0 so UI reflects "stopped"
    if (rateSlider) {
      _rate = 0;
      rateSlider.value = 0;
      rateLabel.textContent = 'rate: 0.00';
    }
  };

  // ── Internal sync ─────────────────────────────────────────────────

  function updateInfo() {
    if (!infoLabel) return;
    if (typeof target.info !== 'function') { infoLabel.textContent = ''; return; }
    const i = target.info();
    const pct = (i.time * 100).toFixed(1);
    infoLabel.textContent = `${pct}%  seg ${i.seg}/${i.segments}  kf ${i.keyframes}`;
  }

  // ── Visibility ────────────────────────────────────────────────────

  function setVis(show) {
    _vis = show !== false;
    container.style.display = _vis ? 'flex' : 'none';
  }

  // ── Public API ────────────────────────────────────────────────────

  const ui = {};
  ui.el = container;

  Object.defineProperty(ui, 'visible', {
    get() { return _vis; },
    set(v) { setVis(v); }
  });

  /** Call every frame.  Syncs seek slider + info from target state. */
  ui.tick = () => {
    if (seekSlider && !_seeking) {
      const t = typeof target.time === 'function' ? target.time() : 0;
      seekSlider.value = t;
    }
    showInfo && updateInfo();
  };

  /** Remove DOM and restore original hooks. */
  ui.dispose = () => {
    target.onPlay = _prevOnPlay;
    target.onEnd  = _prevOnEnd;
    container.parentNode && container.parentNode.removeChild(container);
  };

  // ── Mount & initial state ─────────────────────────────────────────

  mount(container, opt.parent);
  setVis(!opt.hidden);

  return ui;
}
