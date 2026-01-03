/**
 * @file Adds Tree rendering functions to the p5 prototype.
 * @version 0.0.1
 * @author JP Charalambos
 * @license GPL-3.0-only
 *
 * @description
 * A p5.js WEBGL addon for shader development and space transformations.
 * 
 * Camera path recording/playback section.
 *
 * Requires WEBGL (p5.Camera).
 *
 * Camera API (kept as requested):
 *   camera.path : p5.Camera[]
 *   camera.addPath(...)
 *   camera.playPath(...)
 *   camera.stopPath(...)
 *   camera.resetPath(...)
 *   camera.seekPath(...)
 *
 * p5 wrappers (same names) forward to current active camera.
 *
 * Uses p5 lifecicle predraw hook to tick playback automatically.
 *
 * Projection safety:
 *   p5.Camera.slerp requires that all cameras use the same projection.
 *   We enforce this by comparing projMatrix.mat4 signatures.
 */

'use strict';

import p5 from 'p5';

p5.registerAddon((p5, fn, lifecycles) => {
  // --- namespace (module shelf) ---
  p5.Tree ||= {};

  Object.defineProperty(p5.Tree, 'VERSION', {
    value: '0.0.1',
    writable: false,
    enumerable: true,
    configurable: false
  });

  // --- private keys (shared internal state across protos) ---
  const STATE_KEY = Symbol.for('tree.camera.path.state');
  const PLAYERS_KEY = Symbol.for('tree.camera.path.players');

  const clamp01 = function (x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  };

  const isFiniteNumber = function (x) {
    return typeof x === 'number' && Number.isFinite(x);
  };

  // Keyframe equality helper (used to avoid consecutive identical snapshots).
  // Prefer matrix comparisons (cameraMatrix / projMatrix). Fallback to scalar camera params if needed.
  const sameKeyframe = function (a, b) {
    if (!a || !b) return false;
    const aCM = a.cameraMatrix && a.cameraMatrix.mat4;
    const bCM = b.cameraMatrix && b.cameraMatrix.mat4;
    if (aCM && bCM) {
      for (let i = 0; i < 16; i++) if (aCM[i] !== bCM[i]) return false;
    } else {
      if (a.eyeX !== b.eyeX || a.eyeY !== b.eyeY || a.eyeZ !== b.eyeZ) return false;
      if (a.centerX !== b.centerX || a.centerY !== b.centerY || a.centerZ !== b.centerZ) return false;
      if (a.upX !== b.upX || a.upY !== b.upY || a.upZ !== b.upZ) return false;
    }
    const aPM = a.projMatrix && a.projMatrix.mat4;
    const bPM = b.projMatrix && b.projMatrix.mat4;
    if (aPM && bPM) {
      for (let i = 0; i < 16; i++) if (aPM[i] !== bPM[i]) return false;
    }
    return true;
  };

  const warn = function (msg) {
    console.warn('[tree.camera.path] ' + msg);
  };

  const ensurePath = function (cam) {
    cam.path || (cam.path = []);
    return cam.path;
  };

  const segmentCount = function (path) {
    return Math.max(0, path.length - 1);
  };

  const getState = function (cam) {
    cam[STATE_KEY] || (cam[STATE_KEY] = {
      playing: false,
      loop: false,
      pingPong: false,
      onEnd: undefined,
      rate: 1,
      duration: 30, // frames per segment
      seg: 0,
      f: 0,
      projSig: undefined
    });
    return cam[STATE_KEY];
  };

  const getPlayers = function (pInst) {
    pInst[PLAYERS_KEY] || (pInst[PLAYERS_KEY] = new Set());
    return pInst[PLAYERS_KEY];
  };

  const getActiveCamera = function (pInst) {
    const r = pInst && pInst._renderer;
    return (r && (r._curCamera || r.curCamera || r.camera)) || undefined;
  };

  /**
   * Build a stable projection signature from camera.projMatrix.mat4.
   * Returns undefined if unavailable (in which case we warn and do not reject).
   */
  const projSig = function (cam) {
    const pm = cam && cam.projMatrix;
    const m = pm && pm.mat4;
    if (!m || m.length !== 16) return undefined;
    let s = '';
    for (let i = 0; i < 16; i++) {
      const v = Math.round(m[i] * 1e6) / 1e6;
      s += (i ? ',' : '') + v;
    }
    return s;
  };

  /**
   * Interpolate camera pose at normalized global t in [0..1] along the whole path.
   * Also updates internal seg/f so playPath resumes from that location.
   */
  const seekGlobal = function (cam, t) {
    const path = ensurePath(cam);
    const nSeg = segmentCount(path);
    if (nSeg === 0) return;
    const st = getState(cam);
    const tt = clamp01(t);
    const x = tt * nSeg;
    const seg = Math.min(nSeg - 1, Math.floor(x));
    const amt = x - seg;
    cam.slerp(path[seg], path[seg + 1], amt);
    st.seg = seg;
    st.f = Math.round(amt * Math.max(1, st.duration | 0));
  };

  /**
   * Interpolate camera pose at amt in [0..1] within a specific segment index.
   */
  const seekSegment = function (cam, amt, segIndex) {
    const path = ensurePath(cam);
    const nSeg = segmentCount(path);
    if (nSeg === 0) return;
    const st = getState(cam);
    const seg = Math.max(0, Math.min(segIndex | 0, nSeg - 1));
    const a = clamp01(amt);
    cam.slerp(path[seg], path[seg + 1], a);
    st.seg = seg;
    st.f = Math.round(a * Math.max(1, st.duration | 0));
  };

  /**
   * Playback tick.
   *
   * Playback runs in "frames per segment" (`duration`), and `rate` is interpreted
   * as a speed multiplier applied per frame.
   *
   * Rate semantics:
   * - rate > 0 : forward playback
   * - rate < 0 : reverse playback
   * - rate === 0 : stopped
   *
   * The absolute value of `rate` is used as a per-frame advance amount.
   * Fractional rates are supported (e.g. 0.5 plays at half speed).
   *
   * Segment boundaries are handled according to playback mode:
   * - pingPong: bounce at the ends and reverse direction
   * - loop: wrap around to the opposite end
   * - otherwise: stop at the end and optionally invoke `onEnd`
   */
  const tick = function (cam) {
    const st = getState(cam);
    if (!st.playing) return;
    const path = ensurePath(cam);
    const nSeg = segmentCount(path);
    if (nSeg === 0) {
      st.playing = false;
      return;
    }
    const dur = Math.max(1, st.duration | 0);
    const speed = Math.abs(st.rate);
    if (speed === 0) {
      st.playing = false;
      return;
    }
    let dir = st.rate >= 0 ? 1 : -1;
    st.f += speed;
    while (st.f >= dur) {
      st.f -= dur;
      st.seg += dir;
      if (st.seg >= nSeg || st.seg < 0) {
        if (st.pingPong) {
          // Bounce at endpoints and flip direction.
          if (dir > 0) {
            st.seg = nSeg - 1;
            st.f = 0;
            st.rate = -speed;
          } else {
            st.seg = 0;
            st.f = 0;
            st.rate = speed;
          }
          dir = st.rate >= 0 ? 1 : -1;
        } else if (st.loop) {
          st.seg = dir > 0 ? 0 : (nSeg - 1);
        } else {
          st.playing = false;
          seekGlobal(cam, dir > 0 ? 1 : 0);
          const cb = st.onEnd;
          if (typeof cb === 'function') {
            try { cb(cam); } catch (e) { /* ignore user callback errors */ }
          }
          return;
        }
      }
    }
    const local = st.f / dur;
    const amt = dir > 0 ? local : (1 - local);
    cam.slerp(path[st.seg], path[st.seg + 1], amt);
  };

  // -----------------------
  // v2 addon lifecycle hook
  // -----------------------

  lifecycles.predraw = function () {
    const players = getPlayers(this);
    players.forEach(cam => {
      tick(cam);
      getState(cam).playing || players.delete(cam);
    });
  };

  lifecycles.remove = function () {
    const players = this[PLAYERS_KEY];
    players && players.clear();
  };

  // ----------
  // Camera API
  // ----------

  /**
   * addPath overloads:
   *   camera.addPath()                               // snapshot this camera
   *   camera.addPath(otherCamera)                    // snapshot otherCamera
   *   camera.addPath([camA, camB, ...], { clear })   // bulk add
   *
   * Notes:
   * - We store snapshots via camera.copy() so keyframes are stable.
   * - We enforce same projection for all keyframes by comparing projMatrix.mat4 signature.
   * - If projection signature is unavailable, we warn and accept (best effort).
   */
  p5.Camera.prototype.addPath = function (camOrArray, opts) {
    const st = getState(this);
    const path = ensurePath(this);
    const o = opts || {};
    if (o.clear) {
      path.length = 0;
      st.seg = 0;
      st.f = 0;
      st.projSig = undefined;
    }
    // addPath() -> snapshot this
    if (arguments.length === 0) {
      const sig = projSig(this);
      st.projSig || (st.projSig = sig);
      const last = path.length ? path[path.length - 1] : undefined;
      last && sameKeyframe(last, this) || path.push(this.copy());
      return this;
    }
    const cams = Array.isArray(camOrArray) ? camOrArray : [camOrArray];
    // Initialize baseline projection signature from first keyframe if possible.
    // If we can’t detect it, we won’t reject, but we will warn once we see a mismatch attempt.
    st.projSig || (st.projSig = projSig(cams[0] instanceof p5.Camera ? cams[0] : this));
    for (let i = 0; i < cams.length; i++) {
      const c = cams[i];
      if (!(c instanceof p5.Camera)) {
        warn('addPath: ignored non-camera value.');
        continue;
      }
      const sig = projSig(c);
      if (st.projSig && sig && sig !== st.projSig) {
        warn('addPath rejected: camera has different projection; Camera.slerp requires same projection.');
        continue;
      }
      if (!st.projSig && sig) {
        st.projSig = sig;
      } else if (!st.projSig && !sig) {
        warn('addPath: unable to verify projection compatibility (projMatrix.mat4 unavailable).');
      }
      const last = path.length ? path[path.length - 1] : undefined;
      last && sameKeyframe(last, c) || path.push(c.copy());
    }
    return this;
  };

  /**
   * playPath overloads:
   *   camera.playPath(rate)
   *   camera.playPath({ duration, loop, pingPong, onEnd, rate })
   *
   * duration: frames per segment (default 30).
   * loop: wraps at ends (default false).
   * pingPong: bounces at ends (default false).
   * onEnd: called when playback naturally ends (non-looping, non-pingpong).
   * rate: speed multiplier (fractional supported); negative plays reverse; rate=0 stops.
   *
   * If both pingPong and loop are true, pingPong takes precedence.
   */
  p5.Camera.prototype.playPath = function (rateOrOpts) {
    const st = getState(this);
    const path = ensurePath(this);
    const nSeg = segmentCount(path);
    if (nSeg === 0) {
      warn('playPath ignored: need at least 2 keyframes in camera.path.');
      st.playing = false;
      return this;
    }
    if (isFiniteNumber(rateOrOpts)) {
      st.rate = rateOrOpts;
    } else {
      const o = rateOrOpts || {};
      st.duration = isFiniteNumber(o.duration) ? o.duration : st.duration;
      st.loop = !!o.loop;
      st.pingPong = !!o.pingPong;
      st.onEnd = typeof o.onEnd === 'function' ? o.onEnd : st.onEnd;
      st.rate = isFiniteNumber(o.rate) ? o.rate : st.rate;
    }
    if (st.rate === 0) {
      st.playing = false;
      return this;
    }
    // If starting from stopped state, default to an endpoint depending on direction
    if (!st.playing) {
      const forward = st.rate >= 0;
      st.seg = forward ? 0 : (nSeg - 1);
      st.f = 0;
      seekGlobal(this, forward ? 0 : 1);
    }
    st.playing = true;
    const pInst = this._renderer && this._renderer._pInst;
    pInst && getPlayers(pInst).add(this);
    return this;
  };

  /**
   * stopPath({ reset=false })
   * - Stops playback.
   * - If reset:true, seeks to start (forward) or end (reverse).
   */
  p5.Camera.prototype.stopPath = function (opts) {
    const st = getState(this);
    const o = opts || {};
    st.playing = false;
    const pInst = this._renderer && this._renderer._pInst;
    pInst && getPlayers(pInst).delete(this);
    if (o.reset) {
      const forward = st.rate >= 0;
      seekGlobal(this, forward ? 0 : 1);
      st.seg = forward ? 0 : Math.max(0, segmentCount(ensurePath(this)) - 1);
      st.f = 0;
    }
    return this;
  };

  /**
   * resetPath(n?)
   * - resetPath() clears all keyframes and stops.
   * - resetPath(n) keeps first n keyframes (truncate) and stops.
   */
  p5.Camera.prototype.resetPath = function (n) {
    const st = getState(this);
    const path = ensurePath(this);
    st.playing = false;
    st.seg = 0;
    st.f = 0;
    const pInst = this._renderer && this._renderer._pInst;
    pInst && getPlayers(pInst).delete(this);
    if (!isFiniteNumber(n)) {
      path.length = 0;
      st.projSig = undefined;
      return this;
    }
    const nInt = n | 0;
    const keep = Math.max(0, Math.abs(nInt));
    if (keep === 0) {
      path.length = 0;
      st.projSig = undefined;
      return this;
    }
    if (nInt >= 0) {
      path.length = Math.min(path.length, keep);
    } else if (path.length > keep) {
      path.splice(0, path.length - keep);
    }
    if (segmentCount(path) === 0) {
      st.projSig = undefined;
    }
    return this;
  };

  /**
   * seekPath overloads:
   *   camera.seekPath(t)              // global t in [0..1]
   *   camera.seekPath(amt, segIndex)  // segment-local
   *
   * Seeking always stops playback.
   */
  p5.Camera.prototype.seekPath = function (t, segIndex) {
    const st = getState(this);
    st.playing = false;
    const pInst = this._renderer && this._renderer._pInst;
    pInst && getPlayers(pInst).delete(this);
    if (isFiniteNumber(segIndex)) {
      seekSegment(this, t, segIndex);
      return this;
    }
    seekGlobal(this, t);
    return this;
  };

  // ------------------------------------------------------------
  // p5 wrappers (same names, forward to active camera)
  // ------------------------------------------------------------

  fn.addPath = function (camOrArray, opts) {
    const cam = getActiveCamera(this);
    cam && cam.addPath(camOrArray, opts);
    return this;
  };

  fn.playPath = function (rateOrOpts) {
    const cam = getActiveCamera(this);
    cam && cam.playPath(rateOrOpts);
    return this;
  };

  fn.stopPath = function (opts) {
    const cam = getActiveCamera(this);
    cam && cam.stopPath(opts);
    return this;
  };

  fn.resetPath = function (n) {
    const cam = getActiveCamera(this);
    cam && cam.resetPath(n);
    return this;
  };

  fn.seekPath = function (t, segIndex) {
    const cam = getActiveCamera(this);
    cam && cam.seekPath(t, segIndex);
    return this;
  };
  
  // HUD

  fn.beginHUD = function () {
    const cam = getActiveCamera(this);
    cam && this._renderer instanceof p5.RendererGL && this._renderer.beginHUD();
    return this;
  };
  
  fn.endHUD = function () {
    const cam = getActiveCamera(this);
    cam && this._renderer instanceof p5.RendererGL && this._renderer.endHUD();
    return this;
  };
    
  p5.RendererGL.prototype.beginHUD = function () {
    if (this._hudActive === true) return;
    const p = this._pInst;
    const gl = this.drawingContext;
    const states = this.states;
    if (p === undefined || gl === undefined || states === undefined) return;
    p.push(); // calls: this._rendererState = this.push();
    // --- HUD setup ---
    this._hudPrevCam = states.curCamera;
    this._hudDepthWasEnabled = gl.isEnabled(gl.DEPTH_TEST);
    gl.flush();
    gl.disable(gl.DEPTH_TEST);
    if (this._hudCam === undefined) this._hudCam = p.createCamera();
    const z = 1e6;
    this._hudCam.ortho(-p.width / 2, p.width / 2, -p.height / 2, p.height / 2, -z, z);
    this._hudCam.camera(0, 0, 1, 0, 0, 0, 0, 1, 0);
    p.setCamera(this._hudCam);
    p.resetShader();
    this._hudActive = true;
  };
  
  p5.RendererGL.prototype.endHUD = function () {
    if (this._hudActive !== true) return;
    const p = this._pInst;
    const gl = this.drawingContext;
    const states = this.states;
    if (p === undefined || gl === undefined || states === undefined) return;
    gl.flush();
    this._hudDepthWasEnabled ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST);
    p.pop(); // calls: this.pop(this._rendererState);
    this._hudPrevCam !== undefined && p.setCamera(this._hudPrevCam);
    this._hudPrevCam = undefined;
    this._hudDepthWasEnabled = undefined;
    this._hudActive = false;
  };
});
