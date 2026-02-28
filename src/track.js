/**
 * @file Camera path recording/playback (current slerp-based implementation).
 * @module track
 * @license GPL-3.0-only
 *
 * Extracted verbatim from the monolithic p5.tree.js.
 * Uses p5.Camera.slerp() for interpolation.
 *
 * Exports:
 *   installTrack(p5, fn) — installs Camera.prototype methods + fn.* forwarders
 *   tickPlayers(pInst)   — called from predraw lifecycle
 *   clearPlayers(pInst)  — called from remove lifecycle
 */

'use strict';

// --- private storage (WeakMap avoids mutating p5/p5.Camera instances) ---
const PATH_STATE = new WeakMap();
const PATH_PLAYERS = new WeakMap();

const clamp01 = function (x) {
  return x < 0 ? 0 : (x > 1 ? 1 : x);
};

const isFiniteNumber = function (x) {
  return typeof x === 'number' && Number.isFinite(x);
};

const warn = function (msg) {
  console.warn('[tree.camera.path] ' + msg);
};

const ensurePath = function (cam) {
  cam.path || (cam.path = []);
  return cam.path;
};

const EMPTY_PATH = [];

const peekPath = function (cam) {
  return cam.path || EMPTY_PATH;
};

const segmentCount = function (path) {
  return Math.max(0, path.length - 1);
};

const getState = function (cam) {
  let st = PATH_STATE.get(cam);
  if (!st) {
    st = {
      playing: false,
      loop: false,
      pingPong: false,
      onEnd: undefined,
      rate: 1,
      duration: 30, // frames per segment
      seg: 0,
      f: 0,
      pathIsOrtho: undefined
    };
    PATH_STATE.set(cam, st);
  }
  return st;
};

const getPlayers = function (pInst) {
  let players = PATH_PLAYERS.get(pInst);
  if (!players) {
    players = new Set();
    PATH_PLAYERS.set(pInst, players);
  }
  return players;
};

/**
 * Interpolate camera pose at normalized global t in [0..1] along the whole path.
 * Also updates internal seg/f so playPath resumes from that position.
 */
const seekGlobal = function (cam, t) {
  const path = ensurePath(cam);
  const nSeg = segmentCount(path);
  if (nSeg === 0) return;
  const st = getState(cam);
  const tt = clamp01(t);
  const dur = Math.max(1, st.duration | 0);
  if (tt === 1) {
    const seg = nSeg - 1;
    cam.slerp(path[seg], path[seg + 1], 1);
    st.seg !== seg && (st.seg = seg);
    st.f !== dur && (st.f = dur);
    return;
  }
  const x = tt * nSeg;
  const seg = Math.min(nSeg - 1, Math.floor(x));
  const amt = x - seg;
  cam.slerp(path[seg], path[seg + 1], amt);
  st.seg !== seg && (st.seg = seg);
  const f = Math.round(amt * dur);
  st.f !== f && (st.f = f);
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
 */
const tick = function (cam) {
  const st = getState(cam);
  if (!st.playing) return;
  const path = ensurePath(cam);
  const nSeg = segmentCount(path);
  if (nSeg === 0) {
    cam.stopPath(false);
    return;
  }
  const dur = Math.max(1, st.duration | 0);
  const speed = Math.abs(st.rate);
  if (speed === 0) {
    cam.stopPath(false);
    return;
  }
  // Clamp cursor if path size/duration changed.
  if (st.seg < 0) st.seg = 0;
  else if (st.seg >= nSeg) st.seg = nSeg - 1;
  if (st.f < 0) st.f = 0;
  else if (st.f > dur) st.f = dur;
  let dir = st.rate >= 0 ? 1 : -1;
  st.f += speed;
  while (st.f >= dur) {
    st.f -= dur;
    st.seg += dir;
    if (st.seg >= nSeg || st.seg < 0) {
      if (st.pingPong) {
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
        // Snap to endpoint for this direction, then stop WITHOUT resetting.
        seekGlobal(cam, dir > 0 ? 1 : 0);
        cam.stopPath(false);
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

// ---------------------------------------------------------------------------
// Exported lifecycle helpers
// ---------------------------------------------------------------------------

export function tickPlayers(pInst) {
  const players = getPlayers(pInst);
  players.forEach(cam => {
    tick(cam);
    getState(cam).playing || players.delete(cam);
  });
}

export function clearPlayers(pInst) {
  const players = PATH_PLAYERS.get(pInst);
  players && players.clear();
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export function installTrack(p5, fn) {

  // ----------
  // Camera API
  // ----------

  /**
   * addPath overloads (opts, if present, must be last; opts is the only allowed plain object):
   *
   *   camera.addPath();                                // snapshot this camera
   *   camera.addPath(opts);                            // snapshot this camera (with opts)
   *   camera.addPath(otherCam, opts);                  // snapshot otherCam
   *   camera.addPath([camA, camB, ...], opts);         // bulk add (cameras)
   *   camera.addPath(eye, center, up, opts);           // eye/center/up: p5.Vector or [x, y, z]
   *   camera.addPath(view, opts);                      // view: p5.Matrix (4x4) or mat4[16]
   *   camera.addPath([viewA, viewB, ...], opts);       // bulk add (views)
   *
   * Options:
   *   - reset: boolean (default false) Clears the current path before adding.
   */
  p5.Camera.prototype.addPath = function (...args) {
    const st = getState(this);
    const path = ensurePath(this);
    const isPlainObject = v => {
      if (!v || typeof v !== 'object') return false;
      if (Array.isArray(v)) return false;
      if (ArrayBuffer.isView(v)) return false;
      return Object.getPrototypeOf(v) === Object.prototype;
    };
    const isVec3 = v =>
      v instanceof p5.Vector ||
      (Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n)));
    const toVec3 = v => v instanceof p5.Vector ? [v.x, v.y, v.z] : [v[0], v[1], v[2]];
    const sameKeyframe = function (a, b) {
      if (!a || !b) return false;
      const aCM = a.cameraMatrix && a.cameraMatrix.mat4;
      const bCM = b.cameraMatrix && b.cameraMatrix.mat4;
      if (!aCM || !bCM) return false;
      for (let i = 0; i < 16; i++) if (aCM[i] !== bCM[i]) return false;
      return true;
    };
    const addSnapshot = c => {
      const last = path.length ? path[path.length - 1] : undefined;
      last && sameKeyframe(last, c) || path.push(c.copy());
    };
    const isOrthoCam = c => {
      const m = c && c.projMatrix && c.projMatrix.mat4;
      return m && m.length === 16 ? (m[15] !== 0) : undefined;
    };
    const initProjBaseline = c => {
      if (st.pathIsOrtho !== undefined) return;
      const v = isOrthoCam(c);
      st.pathIsOrtho = v;
      v === undefined && warn('addPath: unable to verify projection type (projMatrix.mat4 unavailable).');
    };
    const checkProjCompat = c => {
      initProjBaseline(c);
      const v = isOrthoCam(c);
      if (st.pathIsOrtho === undefined || v === undefined) {
        v === undefined && warn('addPath: unable to verify projection type (projMatrix.mat4 unavailable).');
        return true;
      }
      if (v !== st.pathIsOrtho) {
        warn('addPath rejected: keyframe has different projection type (ortho vs perspective).');
        return false;
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
      const m = toMat4(view);
      const right = norm3([m[0], m[4], m[8]]);
      const up = norm3([m[1], m[5], m[9]]);
      const negFwd = norm3([m[2], m[6], m[10]]);
      const fwd = [-negFwd[0], -negFwd[1], -negFwd[2]];
      const t = [m[12], m[13], m[14]];
      const eye = [
        -(t[0] * right[0] + t[1] * up[0]) + t[2] * fwd[0],
        -(t[0] * right[1] + t[1] * up[1]) + t[2] * fwd[1],
        -(t[0] * right[2] + t[1] * up[2]) + t[2] * fwd[2]
      ];
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
    if (o.reset) {
      path.length = 0;
      st.seg = 0;
      st.f = 0;
      st.pathIsOrtho = undefined;
    }
    initProjBaseline(this);
    // addPath() -> snapshot this
    if (args.length === 0) {
      addSnapshot(this);
      return this;
    }
    // addPath(view) OR addPath(camera) OR addPath([cameras]) OR addPath([views])
    if (args.length === 1) {
      const override = args[0];
      if (isView(override)) {
        const c = importViewToCamera(override);
        checkProjCompat(c) && addSnapshot(c);
        return this;
      }
      if (Array.isArray(override)) {
        const list = override;
        if (list.length && list.every(isView)) {
          for (let i = 0; i < list.length; i++) {
            const c = importViewToCamera(list[i]);
            checkProjCompat(c) && addSnapshot(c);
          }
          return this;
        }
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (!(c instanceof p5.Camera)) {
            warn('addPath: ignored non-camera value.');
            continue;
          }
          checkProjCompat(c) && addSnapshot(c);
        }
        return this;
      }
      if (override instanceof p5.Camera) {
        checkProjCompat(override) && addSnapshot(override);
        return this;
      }
      warn('addPath: ignored unsupported arguments.');
      return this;
    }
    // addPath(eye, center, up, opts)
    if (args.length === 3 && args.every(isVec3)) {
      const eye = toVec3(args[0]);
      const center = toVec3(args[1]);
      const up = norm3(toVec3(args[2]));
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
   */
  p5.Camera.prototype.playPath = function (rateOrOpts) {
    const st = getState(this);
    const prevRate = st.rate;
    const prevDir = prevRate >= 0 ? 1 : -1;
    const path = ensurePath(this);
    const pInst = this._renderer && this._renderer._pInst;
    const unregister = () => pInst && getPlayers(pInst).delete(this);
    const register = () => pInst && getPlayers(pInst).add(this);
    if (path.length === 0) {
      warn('playPath ignored: need at least 1 keyframe in camera.path.');
      st.playing && (st.playing = false);
      unregister();
      return this;
    }
    if (path.length === 1) {
      const kf = path[0];
      st.playing && (st.playing = false);
      unregister();
      return this.camera(
        kf.eyeX, kf.eyeY, kf.eyeZ,
        kf.centerX, kf.centerY, kf.centerZ,
        kf.upX, kf.upY, kf.upZ
      );
    }
    const nSeg = segmentCount(path);
    if (nSeg === 0) {
      warn('playPath ignored: need at least 2 keyframes in camera.path.');
      st.playing && (st.playing = false);
      unregister();
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
      st.playing && (st.playing = false);
      unregister();
      return this;
    }
    const dur = Math.max(1, st.duration | 0);
    if (st.seg < 0) st.seg = 0;
    else if (st.seg >= nSeg) st.seg = nSeg - 1;
    if (st.f < 0) st.f = 0;
    else if (st.f > dur) st.f = dur;
    const dir = st.rate >= 0 ? 1 : -1;
    if (dir !== prevDir) {
      const f = dur - st.f;
      st.f !== f && (st.f = f);
    }
    st.playing || (st.playing = true);
    register();
    return this;
  };

  /**
   * stopPath(reset=false)
   */
  p5.Camera.prototype.stopPath = function (reset = false) {
    const st = getState(this);
    st.playing && (st.playing = false);
    const pInst = this._renderer && this._renderer._pInst;
    pInst && getPlayers(pInst).delete(this);
    if (!reset) return this;
    const path = ensurePath(this);
    if (path.length === 1) {
      const kf = path[0];
      return this.camera(
        kf.eyeX, kf.eyeY, kf.eyeZ,
        kf.centerX, kf.centerY, kf.centerZ,
        kf.upX, kf.upY, kf.upZ
      );
    }
    seekGlobal(this, st.rate < 0 ? 1 : 0);
    return this;
  };

  /**
   * resetPath() — clears all keyframes and stops.
   */
  p5.Camera.prototype.resetPath = function () {
    const st = getState(this);
    const path = ensurePath(this);
    st.playing && (st.playing = false);
    const pInst = this._renderer && this._renderer._pInst;
    pInst && getPlayers(pInst).delete(this);
    const kf0 = path.length ? path[0] : null;
    path.length = 0;
    st.pathIsOrtho = undefined;
    st.seg !== 0 && (st.seg = 0);
    st.f !== 0 && (st.f = 0);
    if (!kf0) return this;
    return this.camera(
      kf0.eyeX, kf0.eyeY, kf0.eyeZ,
      kf0.centerX, kf0.centerY, kf0.centerZ,
      kf0.upX, kf0.upY, kf0.upZ
    );
  };

  /**
   * seekPath overloads:
   *   camera.seekPath(t)              // global t in [0..1]
   *   camera.seekPath(amt, segIndex)  // segment-local
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

  /**
   * Returns the normalized playback time of the current path cursor.
   * @returns {number}
   */
  p5.Camera.prototype.pathTime = function () {
    const path = peekPath(this);
    const nSeg = segmentCount(path);
    if (nSeg === 0) return 0;
    const st = getState(this);
    const dur = Math.max(1, st.duration | 0);
    const dir = (st.playing && st.rate < 0) ? -1 : 1;
    const local = (st.f / dur);
    const amt = dir > 0 ? local : (1 - local);
    return clamp01((st.seg + amt) / nSeg);
  };

  /**
   * Returns a snapshot of the current path playback state.
   * @returns {Object}
   */
  p5.Camera.prototype.pathInfo = function () {
    const path = peekPath(this);
    const st = getState(this);
    const keyframes = path.length;
    const segments = keyframes > 0 ? keyframes - 1 : 0;
    return {
      keyframes,
      segments,
      playing: st.playing,
      loop: st.loop,
      pingPong: st.pingPong,
      rate: st.rate,
      duration: st.duration,
      time: segments > 0 ? this.pathTime() : 0
    };
  };

  // ------------------------------------------------------------
  // p5 wrappers (same names, forward to active camera)
  // ------------------------------------------------------------

  fn.addPath = function (...args) {
    const cam = this._renderer.states.curCamera;
    cam && cam.addPath(...args);
    return this;
  };

  fn.playPath = function (...args) {
    const cam = this._renderer.states.curCamera;
    cam && cam.playPath(...args);
    return this;
  };

  fn.seekPath = function (...args) {
    const cam = this._renderer.states.curCamera;
    cam && cam.seekPath(...args);
    return this;
  };

  fn.resetPath = function (...args) {
    const cam = this._renderer.states.curCamera;
    cam && cam.resetPath(...args);
    return this;
  };

  fn.stopPath = function (...args) {
    const cam = this._renderer.states.curCamera;
    cam && cam.stopPath(...args);
    return this;
  };

  fn.pathTime = function () {
    const cam = this._renderer.states.curCamera;
    return cam && cam.pathTime();
  };

  fn.pathInfo = function () {
    const cam = this._renderer.states.curCamera;
    return cam && cam.pathInfo();
  };
}
