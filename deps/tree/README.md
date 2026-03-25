# `@nakednous/tree`

Pure numeric core for animation, coordinate-space mapping, and visibility — **zero dependencies**, runs anywhere.

---

## Installation

```bash
npm install @nakednous/tree
```

```js
import * as tree from '@nakednous/tree'
```

---

## Architecture

`@nakednous/tree` is the bottom layer of a three-package stack. It knows nothing about renderers, the DOM, or p5 — it operates on plain arrays and `Float32Array` buffers throughout.

```
  application
      │
      ▼
  p5.tree.js        ← bridge: wires tree + ui into p5.js v2
      │
      ├── @nakednous/ui    ← DOM param panels, transport controls
      │
      └── @nakednous/tree  ← this package: math, spaces, animation, visibility
```

The dependency direction is strict: `@nakednous/tree` never imports from the bridge or the DOM layer. This is what lets the same `PoseTrack` that drives a camera path also animate any object — headless, server-side, or in a future renderer.

---

## What it does

### PoseTrack — TRS keyframe animation

A renderer-agnostic state machine for `{ pos, rot, scl }` keyframe sequences. Rotation is stored as `[x,y,z,w]` quaternions (w-last, glTF layout).

```js
import { PoseTrack } from '@nakednous/tree'

const track = new PoseTrack()
track.add({ pos: [0, 0, 0],    rot: [0,0,0,1], scl: [1,1,1] })
track.add({ pos: [100, 50, 0], rot: [0,0,0,1], scl: [2,1,1] })
track.play({ duration: 60, loop: true })

// per-frame — zero allocation
const out = { pos: [0,0,0], rot: [0,0,0,1], scl: [1,1,1] }
track.tick()
track.eval(out)   // writes interpolated TRS into out
```

Interpolation modes:

```js
track.posInterp = 'hermite'  // default — cubic Hermite; auto-computes centripetal
                             //           Catmull-Rom tangents when none are stored
track.posInterp = 'linear'
track.posInterp = 'step'     // snap to k0; useful for discrete state changes

track.rotInterp = 'slerp'    // default — constant angular velocity
track.rotInterp = 'nlerp'    // normalised lerp; cheaper, slightly non-constant speed
track.rotInterp = 'step'     // snap to k0 quaternion
```

Playback features: signed `rate` (negative reverses), `loop`, `pingPong`, `seek(t)` scrubbing, and lifecycle hooks (`onPlay`, `onEnd`, `onStop`). `_onActivate` / `_onDeactivate` are lib-space hooks for the host layer's draw-loop registry — not for user code.

`add()` accepts flexible specs. Top-level forms:

```js
track.add({ pos, rot, scl })                      // explicit TRS — rot accepts any form below
track.add({ pos, rot, scl, tanIn, tanOut })        // with Hermite tangents (vec3, optional)
track.add({ mMatrix: mat4 })                       // decompose a column-major model matrix into TRS
track.add([ spec, spec, ... ])                     // bulk
```

`tanIn` is the incoming position tangent at this keyframe; `tanOut` is the outgoing tangent. When only one is given, the other mirrors it. When neither is given, centripetal Catmull-Rom tangents are auto-computed from neighboring keyframes — identical to prior default behavior.

```js
track.add({ pos:[0,0,0] })                                      // auto tangents
track.add({ pos:[100,0,0], tanOut:[0,50,0] })                   // leave heading +Y
track.add({ pos:[200,0,0], tanIn:[0,50,0], tanOut:[-30,0,0] })  // arrive from +Y, leave heading -X
track.add({ pos:[300,0,0] })                                    // auto tangents
```

`rot` sub-forms — all normalised internally:

```js
rot: [x,y,z,w]                                   // raw quaternion
rot: { axis:[x,y,z], angle }                      // axis-angle
rot: { dir:[x,y,z], up?:[x,y,z] }                // look direction (−Z forward)
rot: { euler:[rx,ry,rz], order?:'YXZ' }           // intrinsic Euler angles (radians)
                                                   // orders: YXZ (default), XYZ, ZYX,
                                                   //         ZXY, XZY, YZX
                                                   // extrinsic ABC = intrinsic CBA
rot: { from:[x,y,z], to:[x,y,z] }                // shortest-arc between directions
rot: { mat3: Float32Array|Array }                 // column-major 3×3 rotation matrix
rot: { eMatrix: mat4 }                            // rotation block of an eye matrix
```

---

### CameraTrack — lookat keyframe animation

A renderer-agnostic state machine for `{ eye, center, up, fov?, halfHeight? }` lookat keyframes. Each field is independently interpolated — eye and center along their own paths, up nlerped on the unit sphere.

```js
import { CameraTrack } from '@nakednous/tree'

const track = new CameraTrack()
track.add({ eye:[0,0,500], center:[0,0,0] })
track.add({ eye:[300,-150,0], center:[0,0,0] })
track.play({ loop: true, duration: 90 })

// per-frame — zero allocation
const out = { eye:[0,0,0], center:[0,0,0], up:[0,1,0], fov:null, halfHeight:null }
track.tick()
track.eval(out)
// apply: cam.camera(out.eye[0],out.eye[1],out.eye[2],
//                   out.center[0],out.center[1],out.center[2],
//                   out.up[0],out.up[1],out.up[2])
```

Interpolation modes:

```js
track.eyeInterp    = 'hermite'  // default — auto-CR tangents when none stored
track.eyeInterp    = 'linear'
track.eyeInterp    = 'step'

track.centerInterp = 'linear'   // default — suits fixed lookat targets
track.centerInterp = 'hermite'  // smoother when center is also moving freely
track.centerInterp = 'step'
```

`add()` accepts:

```js
track.add({ eye, center?, up?, fov?, halfHeight?,
            eyeTanIn?, eyeTanOut?, centerTanIn?, centerTanOut? })
                                   // fov — vertical fov (radians) for perspective
                                   // halfHeight — world-unit half-height for ortho
                                   // both nullable; omit to leave projection unchanged
                                   // eyeTanIn/Out — Hermite tangents for eye path
                                   // centerTanIn/Out — Hermite tangents for center path
track.add({ vMatrix: mat4 })       // view matrix (world→eye); eye reconstructed
track.add({ eMatrix: mat4 })       // eye matrix (eye→world); eye read from col3
track.add([ spec, spec, ... ])     // bulk
```

Note: both matrix forms default `up` to `[0,1,0]`. The matrix col1 (up_ortho) is intentionally not used — it differs from the hint for upright cameras and would shift orbitControl's orbit reference. Use `capturePose()` (p5.tree bridge) when the real up hint is needed.

`fov` and `halfHeight` are lerped between keyframes only when both adjacent keyframes carry a non-null value for that field. Mixed or null entries pass `null` through — the bridge leaves the projection unchanged.

---

### Shared Track transport

Both `PoseTrack` and `CameraTrack` extend `Track`, which holds all transport machinery:

```js
track.play({ duration, loop, pingPong, rate, onPlay, onEnd, onStop })
track.stop([rewind])   // rewind=true seeks to origin on stop
track.reset()          // clear all keyframes and stop
track.seek(t)          // normalised position [0, 1]
track.time()           // → number ∈ [0, 1]
track.info()           // → { keyframes, segments, seg, f, playing, loop, ... }
track.tick()           // advance cursor by rate — returns playing state
track.add(spec)        // append keyframe(s)
track.set(i, spec)     // replace keyframe at index
track.remove(i)        // remove keyframe at index

track.playing          // boolean
track.loop             // boolean
track.pingPong         // boolean
track.rate             // get/set — never starts/stops playback
track.duration         // frames per segment
track.keyframes        // raw array
```

Hook firing order:
```
play()  → onPlay → _onActivate
tick()  → onEnd  → _onDeactivate   (once mode, at boundary)
stop()  → onStop → _onDeactivate
reset() → onStop → _onDeactivate
```

One-keyframe behaviour: `play()` with exactly one keyframe snaps `eval()` to that keyframe without setting `playing = true` and without firing hooks.

---

### Coordinate-space mapping

`mapLocation` and `mapDirection` convert points and vectors between any pair of named spaces. All work is done in flat scalar arithmetic — no objects created per call.

**Spaces:** `WORLD`, `EYE`, `SCREEN`, `NDC`, `MODEL`, `MATRIX` (custom frame).

**NDC convention:** `WEBGL = -1` (z ∈ [−1,1]), `WEBGPU = 0` (z ∈ [0,1]).

```js
import { mapLocation, mapDirection, WORLD, SCREEN, WEBGL } from '@nakednous/tree'

const out = new Float32Array(3)
const m = {
  pMatrix:   /* Float32Array(16) — projection */,
  vMatrix:   /* Float32Array(16) — view (world→eye) */,
  pvMatrix:  /* pMatrix × vMatrix — optional, computed if absent */,
  ipvMatrix: /* inv(pvMatrix)    — optional, computed if absent */,
}
const vp = [0, height, width, -height]

mapLocation(out, worldX, worldY, worldZ, WORLD, SCREEN, m, vp, WEBGL)
```

The matrices bag `m` is assembled by the host (p5.tree reads live renderer state into it). All pairs are supported: WORLD↔EYE, WORLD↔SCREEN, WORLD↔NDC, EYE↔SCREEN, SCREEN↔NDC, WORLD↔MATRIX, and their reverses.

---

### Visibility testing

[Frustum culling](https://learnopengl.com/Guest-Articles/2021/Scene/Frustum-Culling) against six planes. All functions take scalar inputs and a pre-filled `Float64Array(24)` planes buffer — zero allocations per test.

```js
import { frustumPlanes, pointVisibility, sphereVisibility, boxVisibility,
         VISIBLE, SEMIVISIBLE, INVISIBLE } from '@nakednous/tree'

const planes = new Float64Array(24)
frustumPlanes(planes, posX, posY, posZ, vdX, vdY, vdZ,
              upX, upY, upZ, rtX, rtY, rtZ,
              ortho, near, far, left, right, top, bottom)

sphereVisibility(planes, cx, cy, cz, radius)  // → VISIBLE | SEMIVISIBLE | INVISIBLE
boxVisibility(planes, x0,y0,z0, x1,y1,z1)
pointVisibility(planes, px, py, pz)
```

Three-state result: `VISIBLE` (fully inside), `SEMIVISIBLE` (intersecting), `INVISIBLE` (fully outside).

---

### Quaternion and matrix math

Exported individually for use in hot paths.

**Quaternions** — `[x,y,z,w]` w-last:

```
qSet  qCopy  qDot  qNormalize  qNegate  qMul
qSlerp  qNlerp
qFromAxisAngle  qFromLookDir  qFromRotMat3x3  qFromMat4  qToMat4
quatToAxisAngle
```

**Spline / vector:** `hermiteVec3`, `lerpVec3`

**Mat4:**
```
mat4Mul  mat4Invert  mat4Transpose  mat4MulPoint
mat3NormalFromMat4  mat4Location  mat3Direction
```

**TRS ↔ mat4:** `transformToMat4`, `mat4ToTransform`

**Projection queries** (read from a projection mat4 — no renderer needed):
```
projIsOrtho  projNear  projFar  projFov  projHfov
projLeft  projRight  projTop  projBottom
```

**Pixel ratio:** `pixelRatio(proj, vpH, eyeZ, ndcZMin)` — world-units-per-pixel at a given depth, handles both perspective and orthographic.

**Pick matrix:** `applyPickMatrix(proj, px, py, W, H)` — mutates a projection mat4 in-place so that pixel `(px, py)` maps to the full NDC square. Used by the p5.tree GPU color-ID picking implementation. Convention-independent (perspective and orthographic).

---

### Constants

```js
// Coordinate spaces
WORLD, EYE, NDC, SCREEN, MODEL, MATRIX

// NDC Z convention
WEBGL   // −1  (z ∈ [−1, 1])
WEBGPU  //  0  (z ∈ [0, 1])

// Visibility results
INVISIBLE, VISIBLE, SEMIVISIBLE

// Basis vectors (frozen)
ORIGIN, i, j, k, _i, _j, _k
```

---

## Performance contract

All hot-path functions follow an **out-first, zero-allocation** contract:

- `out` is the first parameter — the caller owns the buffer
- the function writes into `out` and returns it
- `null` is returned on degeneracy (singular matrix, etc.)
- no heap allocations per call

```js
// allocate once
const out      = new Float32Array(3)
const pvMatrix = new Float32Array(16)
const ipvMatrix= new Float32Array(16)

// per frame — zero allocation
mat4Mul(pvMatrix, proj, view)
mat4Invert(ipvMatrix, pvMatrix)
mapLocation(out, px, py, pz, WORLD, SCREEN,
  { pMatrix: proj, vMatrix: view, pvMatrix, ipvMatrix }, vp, WEBGL)
```

---

## Relationship to `p5.tree`

[p5.tree](https://github.com/VisualComputing/p5.tree) is the bridge layer. It reads live renderer state (camera matrices, viewport dimensions, NDC convention) and passes it to `@nakednous/tree` functions. It wires `PoseTrack` and `CameraTrack` to the p5 draw loop, exposes `createPoseTrack` / `createCameraTrack` / `getCamera`, and provides `createPanel` for transport and parameter UIs.

`@nakednous/tree` provides the algorithms. The bridge provides the wiring.

---

## License

AGPL-3.0-only  
© JP Charalambos
