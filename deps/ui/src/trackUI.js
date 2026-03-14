/**
 * @file DOM-based transport controls for PoseTrack (or any compatible target).
 * @module ui/trackUI
 * @license GPL-3.0-only
 *
 * Zero p5 dependencies.  Pure vanilla DOM.
 *
 * Transport model
 * ---------------
 *   The Play/Pause button is the **sole** control that starts or stops playback.
 *   The rate slider adjusts speed while playing but never starts or stops.
 *   rate === 0 is treated as "frozen" — playback state is unchanged.
 *   The seek slider scrubs position without affecting the playing flag.
 *   The mode select changes loop/pingPong/once without starting playback.
 *
 * Target contract (duck-typed)
 * ----------------------------
 *   target.play(opts?)   Start or update playback.
 *   target.stop()        Stop playback.
 *   target.seek(t)       Set normalised position [0, 1].
 *   target.time()        Returns normalised position [0, 1].
 *   target.playing       Boolean — true while playing.
 *   target.onPlay        Fires when playback starts (chained, not clobbered).
 *   target.onEnd         Fires on natural boundary — once mode (chained, not clobbered).
 *   target.onStop        Fires on explicit stop() / reset() (chained, not clobbered).
 *
 * Optional:
 *   target.add(d?)       Add keyframe at depth d [0..1] (near..far plane centre).
 *   target.reset()       Clear all keyframes and stop.
 *   target.info()        Returns { keyframes, segments, seg, f, time, ... }.
 *
 * Layout (top → bottom)
 * ---------------------
 *   Row 1  — controls:  [+]  [▶/⏸]  [↺]   (always visible)
 *   Row 1b — depth:     depth slider        (when target supports add)
 *   Row 2  — seek:      seek slider         (hidden when keyframes ≤ 1)
 *   Row 3  — rate:      rate label + slider (when showProps)
 *   Row 4  — mode:      mode label + select (when showProps, always last)
 *   Row 5  — info:      time / keyframe     (when showInfo)
 *
 * Returned API
 * ------------
 *   ui.el              HTMLElement container
 *   ui.visible         get/set boolean
 *   ui.parent(el)      Re-mount container into a new parent HTMLElement.
 *   ui.tick()          Sync seek slider, play button, and enabled state from target.
 *   ui.dispose()       Remove DOM, restore original hooks.
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
 * @param {number}  [opt.rate=1]          Initial rate.
 * @param {boolean} [opt.loop=false]      Initial loop mode.
 * @param {boolean} [opt.pingPong=false]  Initial pingPong mode (overrides loop).
 * @param {number}  [opt.depth=0.5]       Initial add-pose depth [0..1]: 0 = near plane, 1 = far plane.
 * @param {number}  [opt.x=0]            Container left (px).
 * @param {number}  [opt.y=0]            Container top (px).
 * @param {number}  [opt.width=220]      Slider width (px).
 * @param {number}  [opt.rateWidth]      Rate slider width (px). Defaults to opt.width.
 * @param {number}  [opt.depthWidth]     Depth slider width (px). Defaults to opt.width.
 * @param {string}  [opt.color]          Text color.
 * @param {boolean} [opt.hidden=false]   Start hidden.
 * @param {HTMLElement} [opt.parent]     Mount target (defaults to document.body).
 * @returns {Object} UI handle.
 */
export function createTrackUI(target, opt) {
  opt = opt || {};

  const showSeek  = opt.seek  !== false;
  const showProps = opt.props !== false;
  const showInfo  = opt.info  === true;
  const sliderW      = opt.width      ?? 120;
  const rateSliderW  = opt.rateWidth  ?? sliderW;
  const depthSliderW = opt.depthWidth ?? sliderW;

  // Mutable playback / capture parameters — only updated by UI controls
  let _rate  = opt.rate ?? 1;
  let _mode  = opt.pingPong ? 'pingPong' : opt.loop ? 'loop' : 'once';
  let _depth = (typeof opt.depth === 'number') ? opt.depth : 0.5;

  const container = createContainer('track-ui');
  container.style.left = `${opt.x ?? 0}px`;
  container.style.top  = `${opt.y ?? 0}px`;
  if (opt.color) container.style.color = opt.color;

  let _vis     = true;
  let _seeking = false;
  let _lastKf  = -1;   // keyframe count last seen — avoids DOM thrashing

  /** Assemble play() options from current UI state. */
  function _playOpts() {
    return {
      rate:     _rate,
      loop:     _mode === 'loop' || _mode === 'pingPong',
      pingPong: _mode === 'pingPong'
    };
  }

  /** Keyframe count from target.info(), or -1 if unavailable. */
  function _kfCount() {
    return (typeof target.info === 'function') ? target.info().keyframes : -1;
  }

  // ── Row 1 — controls: [+] [▶/⏸] [↺] ────────────────────────────────────

  const ctrlRow = document.createElement('div');
  ctrlRow.className = 'p5t-controls';
  ctrlRow.style.cssText = 'display:flex;gap:4px;margin-bottom:4px;align-items:center;';

  // + button (add keyframe) — only if target supports it
  const hasAdd = typeof target.add === 'function';
  if (hasAdd) {
    const btnAdd = createButton('\u002B', () => {
      target.add(_depth);
      // Force enabled-state refresh on the next tick
      _lastKf = -1;
    });
    btnAdd.title = 'Add keyframe';
    ctrlRow.appendChild(btnAdd);
  }

  // Play/Pause button — sole play/stop control
  const btnPlay = createButton('\u25B6', () => {
    if (target.playing) {
      target.stop();
    } else {
      target.play(_playOpts());
    }
    _syncPlayBtn();
  });
  btnPlay.title = 'Play / Pause';
  ctrlRow.appendChild(btnPlay);

  // ↺ reset button (clear keyframes) — only if target supports it
  // Declared in outer scope so _updateEnabledState can disable it.
  let btnReset = null;
  const hasReset = typeof target.reset === 'function';
  if (hasReset) {
    btnReset = createButton('\u21BA', () => {
      target.reset();
      _syncPlayBtn();
      _lastKf = -1;   // force enabled-state refresh
    });
    btnReset.title = 'Reset (clear keyframes)';
    ctrlRow.appendChild(btnReset);
  }

  container.appendChild(ctrlRow);

  // ── Row 1b — depth slider (when target supports add) ─────────────────────
  // Controls where along the frustum centre ray the new pose is placed.
  // 0 = near plane centre,  1 = far plane centre.

  if (hasAdd && opt.depth !== false) {
    const depthRow = document.createElement('div');
    depthRow.className = 'p5t-depth';
    depthRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px;font-size:11px;';

    const depthLabel = createLabel(`depth: ${_depth.toFixed(2)}`);
    depthLabel.style.minWidth = '72px';

    const depthSlider = createSlider(0, 1, _depth, 0.01, v => {
      _depth = v;
      depthLabel.textContent = `depth: ${v.toFixed(2)}`;
    });
    depthSlider.style.width = `${depthSliderW}px`;

    depthRow.appendChild(depthLabel);
    depthRow.appendChild(depthSlider);
    container.appendChild(depthRow);
  }

  // ── Row 2 — seek slider (conditional) ───────────────────────────────────

  let seekSlider, seekLabel, seekRow;
  if (showSeek) {
    seekRow = document.createElement('div');
    seekRow.className = 'p5t-seek';
    seekRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px;font-size:11px;';

    seekLabel = createLabel('seek: 0.000');
    seekLabel.style.minWidth = '72px';

    seekSlider = createSlider(0, 1, 0, 0.001, v => {
      _seeking = true;
      seekLabel.textContent = `seek: ${parseFloat(v).toFixed(3)}`;
      target.seek(v);
    });
    seekSlider.style.width  = `${sliderW}px`;
    seekSlider.addEventListener('change',    () => { _seeking = false; });
    seekSlider.addEventListener('pointerup', () => { _seeking = false; });
    seekSlider.addEventListener('touchend',  () => { _seeking = false; });

    seekRow.appendChild(seekLabel);
    seekRow.appendChild(seekSlider);
    container.appendChild(seekRow);
  }

  // ── Row 3 — rate slider ──────────────────────────────────────────────────
  // Rate changes the speed but never starts or stops playback.

  let rateSlider, rateLabel;
  if (showProps) {
    const rateRow = document.createElement('div');
    rateRow.className = 'p5t-rate';
    rateRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px;font-size:11px;';

    rateLabel = createLabel(`rate: ${_rate.toFixed(2)}`);
    rateLabel.style.minWidth = '72px';

    rateSlider = createSlider(-2, 2, _rate, 0.05, v => {
      _rate = v;
      rateLabel.textContent = `rate: ${v.toFixed(2)}`;
      // Only update rate mid-play; never start playback from here
      if (target.playing) {
        target.play({ rate: _rate });
      }
    });
    rateSlider.style.width = `${rateSliderW}px`;

    rateRow.appendChild(rateLabel);
    rateRow.appendChild(rateSlider);
    container.appendChild(rateRow);
  }

  // ── Row 4 — mode select (always last transport row) ──────────────────────

  let modeSelect;
  if (showProps) {
    const modeRow = document.createElement('div');
    modeRow.className = 'p5t-mode';
    modeRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;';

    const modeLabel = createLabel('mode:');
    modeLabel.style.minWidth = '72px';

    modeSelect = createSelect(
      [{ label: 'once',     value: 'once'     },
       { label: 'loop',     value: 'loop'     },
       { label: 'pingPong', value: 'pingPong' }],
      _mode,
      v => {
        _mode = v;
        // Update loop/pingPong if already playing
        if (target.playing) {
          target.play({
            loop:     _mode === 'loop' || _mode === 'pingPong',
            pingPong: _mode === 'pingPong'
          });
        }
      }
    );

    modeRow.appendChild(modeLabel);
    modeRow.appendChild(modeSelect);
    container.appendChild(modeRow);
  }

  // ── Row 5 — info label (optional) ────────────────────────────────────────

  let infoLabel;
  if (showInfo) {
    infoLabel = createLabel('');
    infoLabel.style.cssText = 'font-size:11px;opacity:0.8;margin-bottom:4px;';
    container.appendChild(infoLabel);
  }

  // ── Hook chaining ─────────────────────────────────────────────────────────
  // Chain onPlay/onEnd/onStop so the play button stays in sync with external
  // state changes (e.g. playback ending naturally in once mode, or an
  // explicit stop() called from outside the UI).

  const _prevOnPlay = target.onPlay;
  const _prevOnEnd  = target.onEnd;
  const _prevOnStop = target.onStop;

  target.onPlay = function () {
    _syncPlayBtn();
    if (typeof _prevOnPlay === 'function') {
      try { _prevOnPlay.apply(this, arguments); } catch (_) {}
    }
  };

  target.onEnd = function () {
    _syncPlayBtn();
    if (typeof _prevOnEnd === 'function') {
      try { _prevOnEnd.apply(this, arguments); } catch (_) {}
    }
  };

  // Keep play button in sync when playback is explicitly stopped or reset.
  target.onStop = function () {
    _syncPlayBtn();
    if (typeof _prevOnStop === 'function') {
      try { _prevOnStop.apply(this, arguments); } catch (_) {}
    }
  };

  // ── Internal helpers ──────────────────────────────────────────────────────

  function _syncPlayBtn() {
    if (!btnPlay) return;
    btnPlay.textContent = target.playing ? '\u23F8' : '\u25B6';
  }

  /**
   * Update enabled/visible state based on keyframe count.
   * Only writes to DOM when count has actually changed.
   */
  function _updateEnabledState() {
    const kf = _kfCount();
    if (kf === _lastKf) return;
    _lastKf = kf;
    // Play button: disabled with 0 keyframes
    btnPlay.disabled = kf === 0;
    // Reset button: nothing to reset when empty
    if (btnReset) btnReset.disabled = kf === 0;
    // Seek slider: only meaningful with 2+ keyframes, but stays visible
    if (seekSlider) seekSlider.disabled = kf < 2;
  }

  function _updateInfo() {
    if (!infoLabel) return;
    if (typeof target.info !== 'function') { infoLabel.textContent = ''; return; }
    const i   = target.info();
    const pct = (i.time * 100).toFixed(1);
    infoLabel.textContent = `${pct}%  seg ${i.seg}/${i.segments}  kf ${i.keyframes}`;
  }

  // ── Visibility ────────────────────────────────────────────────────────────

  function _setVis(show) {
    _vis = show !== false;
    container.style.display = _vis ? 'flex' : 'none';
  }

  // ── Public API ────────────────────────────────────────────────────────────

  const ui = {};
  ui.el = container;

  Object.defineProperty(ui, 'visible', {
    get() { return _vis; },
    set(v) { _setVis(v); }
  });

  /** Re-mount container into a new parent HTMLElement. */
  ui.parent = parentEl => mount(container, parentEl);

  /**
   * Call every frame.
   * Syncs seek slider position, play button text, and enabled/visible state.
   */
  ui.tick = () => {
    if (!_seeking && seekSlider) {
      const t = typeof target.time === 'function' ? target.time() : 0;
      seekSlider.value = t;
      if (seekLabel) seekLabel.textContent = `seek: ${t.toFixed(3)}`;
    }
    _syncPlayBtn();
    _updateEnabledState();
    if (showInfo) _updateInfo();
  };

  /** Remove DOM and restore original hook chain. */
  ui.dispose = () => {
    target.onPlay = _prevOnPlay;
    target.onEnd  = _prevOnEnd;
    target.onStop = _prevOnStop;
    container.parentNode && container.parentNode.removeChild(container);
  };

  // ── Mount & initial state ─────────────────────────────────────────────────

  mount(container, opt.parent);
  _setVis(!opt.hidden);
  _syncPlayBtn();
  _updateEnabledState();

  return ui;
}
