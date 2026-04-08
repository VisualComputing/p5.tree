/**
 * @file DOM-based transport controls for PoseTrack (or any compatible target).
 * @module ui/trackUI
 * @license AGPL-3.0-only
 *
 * Zero p5 dependencies.  Pure vanilla DOM.
 *
 * Transport model
 * ---------------
 *   The Play/Pause button is the **sole** control that starts or stops playback.
 *   The rate slider adjusts speed while playing but never starts or stops.
 *   rate === 0 is treated as "frozen" — playback state is unchanged.
 *   The seek slider scrubs position without affecting the playing flag.
 *   The loop checkbox and bounce checkbox change looping behaviour without
 *   starting playback.
 *
 * Loop modes
 * ----------
 *   loop:false, bounce:false  — play once, stop at end
 *   loop:true,  bounce:false  — repeat, wrap back to start
 *   loop:true,  bounce:true   — bounce forever at boundaries
 *   loop:false, bounce:true   — bounce once: flip at far boundary, stop at origin
 *
 *   bounce and loop are independent — no exclusivity enforced.
 *   Both checkboxes are always visible.
 *
 * Target contract (duck-typed)
 * ----------------------------
 *   target.play(opts?)   Start or update playback.
 *   target.stop()        Stop playback.
 *   target.seek(t)       Set normalised position [0, 1].
 *   target.time()        Returns normalised position [0, 1].
 *   target.playing       Boolean — true while playing.
 *   target._onPlay       Reserved lib-space slot — assigned by this panel.
 *   target._onEnd        Reserved lib-space slot — assigned by this panel.
 *   target._onStop       Reserved lib-space slot — assigned by this panel.
 *
 * Optional:
 *   target.add(d?)       Add keyframe at depth d [0..1] (near..far plane centre).
 *   target.reset()       Clear all keyframes and stop.
 *   target.info()        Returns { keyframes, segments, seg, f, time, ... }.
 *
 * State initialisation
 * --------------------
 *   _rate is seeded once at creation from the live track state (target.rate)
 *   with opt.rate as fallback.  After creation rate is fully UI-owned — the
 *   panel never reads rate back from the track.  This prevents spurious slider
 *   snaps when external play() calls omit rate (e.g. play({ bounce: true })).
 *
 *   _loop and _bounce are seeded the same way and additionally polled from
 *   the track every tick() while playing, so external play() calls that change
 *   loop/bounce mode are always reflected.
 *
 * Layout (top → bottom)
 * ---------------------
 *   Title row  — optional, becomes collapse toggle when collapsible=true
 *   Row 1  — controls:  [+]  [▶/⏸]  [↺]   (each independently optional)
 *   Row 1b — depth:     depth slider        (when target supports add)
 *   Row 2  — seek:      seek slider         (hidden when keyframes ≤ 1)
 *   Row 3  — rate:      rate label + slider (when showProps)
 *   Row 4  — loop + bounce: both checkboxes always visible, independent
 *   Row 5  — info:      time / keyframe     (when showInfo)
 *
 * Returned API
 * ------------
 *   ui.el              HTMLElement container
 *   ui.visible         get/set boolean
 *   ui.collapsed       get/set boolean (requires collapsible + title)
 *   ui.parent(el)      Re-mount container into a new parent HTMLElement.
 *   ui.tick()          Sync seek slider, play button, and enabled state from target.
 *   ui.dispose()       Remove DOM and clear lib-space hooks.
 */

'use strict';

import {
  createContainer, createSlider, createButton,
  createCheckbox, createLabel, mount
} from './dom.js';

/**
 * Build a track transport UI.
 *
 * @param {Object} target    PoseTrack (or duck-compatible object).
 * @param {Object} [opt]     Options.
 * @param {boolean} [opt.seek=true]       Show seek slider.
 * @param {boolean} [opt.props=true]      Show rate slider + loop controls.
 * @param {boolean} [opt.info=false]      Show time/keyframe readout.
 * @param {boolean} [opt.play=true]       Show play/pause button. false hides it —
 *                                        seek slider becomes the sole transport control.
 * @param {number}  [opt.rate=1]          Initial rate (overridden by target.rate if set).
 * @param {boolean} [opt.loop=false]      Initial loop state (overridden by target.loop).
 * @param {boolean} [opt.bounce=false]    Initial bounce state (overridden by target.bounce).
 * @param {number}  [opt.depth=0.5]       Initial add-pose depth [0..1]: 0 = near, 1 = far.
 * @param {number}  [opt.x=0]            Container left (px).
 * @param {number}  [opt.y=0]            Container top (px).
 * @param {number}  [opt.width=220]      Slider width (px).
 * @param {number}  [opt.rateWidth]      Rate slider width (px). Defaults to opt.width.
 * @param {number}  [opt.depthWidth]     Depth slider width (px). Defaults to opt.width.
 * @param {string}  [opt.color]          Text color.
 * @param {boolean} [opt.hidden=false]   Start hidden.
 * @param {string}  [opt.title]          Optional title row.
 * @param {boolean} [opt.collapsible]    Make title row a collapse toggle (requires title).
 * @param {boolean} [opt.collapsed]      Start collapsed (requires collapsible + title).
 * @param {HTMLElement} [opt.parent]     Mount target (defaults to document.body).
 * @returns {Object} UI handle.
 */
export function createTrackUI(target, opt) {
  opt = opt || {};

  const showSeek  = opt.seek  !== false;
  const showProps = opt.props !== false;
  const showInfo  = opt.info  === true;
  const showPlay  = opt.play  !== false;
  const sliderW      = opt.width      ?? 120;
  const rateSliderW  = opt.rateWidth  ?? sliderW;
  const depthSliderW = opt.depthWidth ?? sliderW;

  // ── Seed _rate, _loop, _bounce from live track state, fall back to opt ──

  let _rate   = (typeof target.rate === 'number') ? target.rate : (opt.rate ?? 1);
  let _loop   = !!(target.loop   || opt.loop);
  let _bounce = !!(target.bounce || opt.bounce);
  let _depth  = (typeof opt.depth === 'number') ? opt.depth : 0.5;

  const container = createContainer('track-ui');
  container.style.left = `${opt.x ?? 0}px`;
  container.style.top  = `${opt.y ?? 0}px`;
  if (opt.color) container.style.color = opt.color;

  let _vis     = true;
  let _seeking = false;
  let _lastKf  = -1;

  /** Assemble play() options from current UI state. */
  function _playOpts() {
    return { rate: _rate, loop: _loop, bounce: _bounce };
  }

  /** Keyframe count from target.info(), or -1 if unavailable. */
  function _kfCount() {
    return (typeof target.info === 'function') ? target.info().keyframes : -1;
  }

  // ── Collapsible setup ─────────────────────────────────────────────────────

  const canCollapse = !!(opt.title && (opt.collapsible || 'collapsed' in opt));
  let _collapsed    = canCollapse && !!opt.collapsed;
  let chevron       = null;

  const body = document.createElement('div');
  body.className = 'p5t-body';
  body.style.cssText = 'display:flex;flex-direction:column;gap:0px;';

  // ── Title row (optional) ──────────────────────────────────────────────────

  if (opt.title) {
    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;';

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

  // ── Row 1 — controls: [+] [▶/⏸] [↺] ─────────────────────────────────────
  //
  // Each button is independently optional:
  //   hasAdd   — target exposes add()          (+ button)
  //   showPlay — opt.play !== false            (play/pause button)
  //   hasReset — target exposes reset()        (reset button)
  //
  // The row is only appended when at least one button is present, so that
  // fully button-free panels produce no empty DOM row.

  const ctrlRow = document.createElement('div');
  ctrlRow.className = 'p5t-controls';
  ctrlRow.style.cssText = 'display:flex;gap:4px;margin-bottom:4px;align-items:center;';

  const hasAdd = typeof target.add === 'function';
  if (hasAdd) {
    const btnAdd = createButton('\u002B', () => {
      target.add(_depth);
      _lastKf = -1;
    });
    btnAdd.title = 'Add keyframe';
    ctrlRow.appendChild(btnAdd);
  }

  let btnPlay = null;
  if (showPlay) {
    btnPlay = createButton('\u25B6', () => {
      if (target.playing) {
        target.stop();
      } else {
        target.play(_playOpts());
      }
      _syncPlayBtn();
    });
    btnPlay.title = 'Play / Pause';
    ctrlRow.appendChild(btnPlay);
  }

  let btnReset = null;
  const hasReset = typeof target.reset === 'function';
  if (hasReset) {
    btnReset = createButton('\u21BA', () => {
      target.reset();
      _syncPlayBtn();
      _lastKf = -1;
    });
    btnReset.title = 'Reset (clear keyframes)';
    ctrlRow.appendChild(btnReset);
  }

  if (hasAdd || showPlay || hasReset) {
    body.appendChild(ctrlRow);
  }

  // ── Row 1b — depth slider ─────────────────────────────────────────────────

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
    body.appendChild(depthRow);
  }

  // ── Row 2 — seek slider ───────────────────────────────────────────────────

  let seekSlider, seekLabel;
  if (showSeek) {
    const seekRow = document.createElement('div');
    seekRow.className = 'p5t-seek';
    seekRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px;font-size:11px;';

    seekLabel = createLabel('seek: 0.000');
    seekLabel.style.minWidth = '72px';

    seekSlider = createSlider(0, 1, 0, 0.001, v => {
      _seeking = true;
      seekLabel.textContent = `seek: ${parseFloat(v).toFixed(3)}`;
      target.seek(v);
    });
    seekSlider.style.width = `${sliderW}px`;
    seekSlider.addEventListener('change',    () => { _seeking = false; });
    seekSlider.addEventListener('pointerup', () => { _seeking = false; });
    seekSlider.addEventListener('touchend',  () => { _seeking = false; });

    seekRow.appendChild(seekLabel);
    seekRow.appendChild(seekSlider);
    body.appendChild(seekRow);
  }

  // ── Row 3 — rate slider ───────────────────────────────────────────────────

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
      if (target.playing) target.play({ rate: _rate });
    });
    rateSlider.style.width = `${rateSliderW}px`;

    rateRow.appendChild(rateLabel);
    rateRow.appendChild(rateSlider);
    body.appendChild(rateRow);
  }

  // ── Row 4 — loop + bounce checkboxes ─────────────────────────────────────

  let loopInp, bounceInp;

  if (showProps) {
    const loopRow = document.createElement('div');
    loopRow.className = 'p5t-loop';
    loopRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;';

    const loopLabel = createLabel('loop:');
    loopLabel.style.minWidth = '40px';

    const loopCheck = createCheckbox('', _loop, v => {
      _loop = v;
      if (target.playing) target.play(_playOpts());
    });
    loopInp = loopCheck.firstChild;

    const bounceLabel = createLabel('bounce:');
    bounceLabel.style.marginLeft = '10px';

    const bounceCheck = createCheckbox('', _bounce, v => {
      _bounce = v;
      if (target.playing) target.play(_playOpts());
    });
    bounceInp = bounceCheck.firstChild;

    loopRow.appendChild(loopLabel);
    loopRow.appendChild(loopCheck);
    loopRow.appendChild(bounceLabel);
    loopRow.appendChild(bounceCheck);
    body.appendChild(loopRow);
  }

  // ── Row 5 — info label (optional) ────────────────────────────────────────

  let infoLabel;
  if (showInfo) {
    infoLabel = createLabel('');
    infoLabel.style.cssText = 'font-size:11px;opacity:0.8;margin-bottom:4px;';
    body.appendChild(infoLabel);
  }

  container.appendChild(body);

  // ── Lib-space hooks ───────────────────────────────────────────────────────

  target._onPlay = () => { _syncPlayBtn(); };
  target._onEnd  = () => { _syncPlayBtn(); };
  target._onStop = () => { _syncPlayBtn(); };

  // ── Internal helpers ──────────────────────────────────────────────────────

  function _syncPlayBtn() {
    if (!btnPlay) return;
    btnPlay.textContent = target.playing ? '\u23F8' : '\u25B6';
  }

  function _updateEnabledState() {
    const kf = _kfCount();
    if (kf === _lastKf) return;
    _lastKf = kf;
    if (btnPlay)    btnPlay.disabled    = kf === 0;
    if (btnReset)   btnReset.disabled   = kf === 0;
    if (seekSlider) seekSlider.disabled = kf < 2;
  }

  function _updateInfo() {
    if (!infoLabel) return;
    if (typeof target.info !== 'function') { infoLabel.textContent = ''; return; }
    const i   = target.info();
    const pct = (i.time * 100).toFixed(1);
    infoLabel.textContent = `${pct}%  seg ${i.seg}/${i.segments}  kf ${i.keyframes}`;
  }

  function _applyCollapse() {
    body.style.display = _collapsed ? 'none' : 'flex';
    if (chevron) chevron.textContent = _collapsed ? '\u25B6' : '\u25BC';
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

  Object.defineProperty(ui, 'collapsed', {
    get() { return _collapsed; },
    set(v) {
      if (!canCollapse) return;
      _collapsed = !!v;
      _applyCollapse();
    }
  });

  ui.parent = parentEl => mount(container, parentEl);

  ui.tick = () => {
    if (!_seeking && seekSlider) {
      const t = typeof target.time === 'function' ? target.time() : 0;
      seekSlider.value = t;
      if (seekLabel) seekLabel.textContent = `seek: ${t.toFixed(3)}`;
    }
    _syncPlayBtn();
    _updateEnabledState();
    if (showInfo) _updateInfo();

    // Poll loop/bounce from track — covers external play() calls.
    if (showProps && target.playing) {
      const liveLoop   = !!target.loop;
      const liveBounce = !!target.bounce;
      if (liveLoop !== _loop) {
        _loop = liveLoop;
        if (loopInp) loopInp.checked = _loop;
      }
      if (liveBounce !== _bounce) {
        _bounce = liveBounce;
        if (bounceInp) bounceInp.checked = _bounce;
      }
    }
  };

  ui.dispose = () => {
    target._onPlay = null;
    target._onEnd  = null;
    target._onStop = null;
    container.parentNode && container.parentNode.removeChild(container);
  };

  // ── Mount & initial state ─────────────────────────────────────────────────

  mount(container, opt.parent);
  _setVis(!opt.hidden);
  _applyCollapse();
  _syncPlayBtn();
  _updateEnabledState();

  return ui;
}
