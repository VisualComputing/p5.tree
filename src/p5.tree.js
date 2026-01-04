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
    return (
      (r && r.states && r.states.curCamera) || // p5-v2 canonical
      (r && (r._curCamera || r.curCamera || r._camera)) || // fallbacks
      undefined
    );
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
   * addPath overloads (opts, if present, must be last; opts is the only allowed plain object):
   *
   *   camera.addPath();                                // snapshot this camera
   *   camera.addPath(opts);                            // snapshot this camera (with opts)
   *
   *   camera.addPath(otherCam, opts);                  // snapshot otherCam
   *   camera.addPath([camA, camB, ...], opts);         // bulk add
   *
   *   camera.addPath(eye, center, up, opts);           // eye/center/up: p5.Vector or [x, y, z]
   *
   *   camera.addPath(view, opts);                      // view: p5.Matrix (4x4) or mat4[16]
   *                                                   // (world -> camera), like p5.Camera.cameraMatrix
   *
   * Options:
   *   - clear: boolean (default false) Clears the current path before adding.
   *
   * Notes:
   * - Keyframes are stored as camera snapshots (p5.Camera.copy()) so Camera.slerp() works.
   * - Projection compatibility is enforced (Camera.slerp requires same projection).
   */
  p5.Camera.prototype.addPath = function (...args) {
    const st = getState(this);
    const path = ensurePath(this);
    const isPlainObject = v => {
      if (!v || typeof v !== 'object') return false;
      if (Array.isArray(v)) return false;
      if (ArrayBuffer.isView(v)) return false;
      const proto = Object.getPrototypeOf(v);
      return proto === Object.prototype || proto === null;
    };
    const isVec3 = v =>
      v instanceof p5.Vector ||
      (Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n)));
    const toVec3 = v => v instanceof p5.Vector ? [v.x, v.y, v.z] : [v[0], v[1], v[2]];
    const addSnapshot = c => {
      const last = path.length ? path[path.length - 1] : undefined;
      last && sameKeyframe(last, c) || path.push(c.copy());
    };
    const initProjBaseline = () => {
      const sig = projSig(this);
      st.projSig || (st.projSig = sig);
    };
    const checkProjCompat = c => {
      const sig = projSig(c);
      if (st.projSig && sig && sig !== st.projSig) {
        warn('addPath rejected: camera has different projection; Camera.slerp requires same projection.');
        return false;
      }
      if (!st.projSig && sig) {
        st.projSig = sig;
      } else if (!st.projSig && !sig) {
        warn('addPath: unable to verify projection compatibility (projMatrix.mat4 unavailable).');
      }
      return true;
    };
    const isMat4Array = v =>
      (Array.isArray(v) || ArrayBuffer.isView(v)) &&
      v.length === 16 &&
      Array.prototype.every.call(v, n => typeof n === 'number' && Number.isFinite(n));
    const isView = v => v instanceof p5.Matrix || isMat4Array(v);
    const toMat4 = v => v instanceof p5.Matrix ? v.mat4 : v;
    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const len3 = v => Math.sqrt(dot3(v, v));
    const norm3 = v => {
      const l = len3(v) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    const importViewToCamera = view => {
      // view is a column-major mat4, world -> camera (p5.Camera.cameraMatrix).
      const m = toMat4(view);
      // Rows of rotation part (world->camera):
      const right = norm3([m[0], m[4], m[8]]);
      const up = norm3([m[1], m[5], m[9]]);
      const negFwd = norm3([m[2], m[6], m[10]]);
      const fwd = [-negFwd[0], -negFwd[1], -negFwd[2]];
      // Translation column: t = -R^T * eye
      const t = [m[12], m[13], m[14]];
      // eye = -(t0*right + t1*up) + t2*forward
      const eye = [
        -(t[0] * right[0] + t[1] * up[0]) + t[2] * fwd[0],
        -(t[0] * right[1] + t[1] * up[1]) + t[2] * fwd[1],
        -(t[0] * right[2] + t[1] * up[2]) + t[2] * fwd[2]
      ];
      // Enforce center using this camera’s current focus distance.
      const dist = Math.sqrt(
        (this.centerX - this.eyeX) * (this.centerX - this.eyeX) +
        (this.centerY - this.eyeY) * (this.centerY - this.eyeY) +
        (this.centerZ - this.eyeZ) * (this.centerZ - this.eyeZ)
      ) || 1;
      const center = [
        eye[0] + fwd[0] * dist,
        eye[1] + fwd[1] * dist,
        eye[2] + fwd[2] * dist
      ];
      // Important: use camera(...) so cameraMatrix stays consistent with eye/center/up.
      const c = this.copy();
      c.camera(
        eye[0], eye[1], eye[2],
        center[0], center[1], center[2],
        up[0], up[1], up[2]
      );
      return c;
    };
    // --- opts extraction (opts always last; only plain object is opts) ---
    const o = args.length && isPlainObject(args[args.length - 1]) ? args.pop() : {};
    if (o.clear) {
      path.length = 0;
      st.seg = 0;
      st.f = 0;
      st.projSig = undefined;
    }
    initProjBaseline();
    // addPath() -> snapshot this
    if (args.length === 0) {
      const last = path.length ? path[path.length - 1] : undefined;
      last && sameKeyframe(last, this) || path.push(this.copy());
      return this;
    }
    // addPath(view) OR addPath(camera) OR addPath([cameras])
    if (args.length === 1) {
      const override = args[0];
      if (isView(override)) {
        const c = importViewToCamera(override);
        checkProjCompat(c) && addSnapshot(c);
        return this;
      }
      const cams = Array.isArray(override) ? override : [override];
      for (let i = 0; i < cams.length; i++) {
        const c = cams[i];
        if (!(c instanceof p5.Camera)) {
          warn('addPath: ignored non-camera value.');
          continue;
        }
        checkProjCompat(c) && addSnapshot(c);
      }
      return this;
    }
    // addPath(eye, center, up)
    if (args.length === 3 && isVec3(args[0]) && isVec3(args[1]) && isVec3(args[2])) {
      const eye = toVec3(args[0]);
      const center = toVec3(args[1]);
      const up = norm3(toVec3(args[2]));
      // Important: use camera(...) so cameraMatrix stays consistent with eye/center/up.
      const c = this.copy();
      c.camera(
        eye[0], eye[1], eye[2],
        center[0], center[1], center[2],
        up[0], up[1], up[2]
      );
      checkProjCompat(c) && addSnapshot(c);
      return this;
    }
    warn('addPath: ignored unsupported arguments.');
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
    // If starting from stopped state, default to an endpoint depending on direction.
    // Important: do NOT use seekGlobal(cam, 1) for reverse start, because seekGlobal sets st.f = dur
    // and the next tick will immediately underflow the segment and stop (snap).
    if (!st.playing) {
      const forward = st.rate >= 0;
      st.seg = forward ? 0 : (nSeg - 1);
      st.f = 0;
      // Snap pose to the start/end of the current segment, but keep st.f = 0.
      this.slerp(path[st.seg], path[st.seg + 1], forward ? 0 : 1);
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

  fn.addPath = function (...args) {
    const cam = getActiveCamera(this);
    cam && cam.addPath(...args);
    return this;
  };

  fn.playPath = function (...args) {
    const cam = getActiveCamera(this);
    cam && cam.playPath(...args);
    return this;
  };
  
  fn.seekPath = function (...args) {
    const cam = getActiveCamera(this);
    cam && cam.seekPath(...args);
    return this;
  };
  
  fn.resetPath = function (...args) {
    const cam = getActiveCamera(this);
    cam && cam.resetPath(...args);
    return this;
  };
  
  fn.stopPath = function (...args) {
    const cam = getActiveCamera(this);
    cam && cam.stopPath(...args);
    return this;
  };
  
  // HUD

  fn.beginHUD = function (...args) {
    this._renderer?.beginHUD?.(...args);
    return this;
  }
  
  fn.endHUD = function (...args) {
    this._renderer?.endHUD?.(...args);
    return this;
  }
    
  p5.RendererGL.prototype.beginHUD = function () {
    if (this._hudActive === true) return;
    const p = this._pInst;
    const gl = this.drawingContext;
    const states = this.states;
    if (p === undefined || gl === undefined || states === undefined) return;
    p.push(); // calls: this._rendererState = this.push();
    p.resetShader();
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
