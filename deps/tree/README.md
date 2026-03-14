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

A renderer-agnostic state machine for `{ pos, rot, scl }` keyframe sequences. Rotation is stored as `[x,y,z,w]` quaternions (w-last, glTF layout); interpolation uses [slerp](https://en.wikipedia.org/wiki/Slerp) for rotation and [Catmull-Rom](https://en.wikipedia.org/wiki/Cubic_Hermite_spline#Catmull%E2%80%93Rom_spline) for position and scale.

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

Playback features: signed `rate` (negative reverses), `loop`, `pingPong`, `seek(t)` scrubbing, and lifecycle hooks (`onPlay`, `onEnd`, `onStop`). `_onActivate` / `_onDeactivate` are lib-space hooks for the host layer's draw-loop registry — not for user code.

Keyframe `rot` input is flexible — the parser normalises all forms:
- raw `[x,y,z,w]` quaternion
- `{ axis: [x,y,z], angle }` axis-angle
- `{ dir: [x,y,z], up? }` look-direction

---

### Coordinate-space mapping

`mapLocation` and `mapDirection` convert points and vectors between any pair of named spaces. All work is done in flat scalar arithmetic — no objects created per call.

**Spaces:** `WORLD`, `EYE`, `SCREEN`, `NDC`, `MODEL`, `MATRIX` (custom frame).

**NDC convention:** `WEBGL = -1` (z ∈ [−1,1]), `WEBGPU = 0` (z ∈ [0,1]).

```js
import { mapLocation, mapDirection, WORLD, SCREEN, WEBGL } from '@nakednous/tree'

const out = new Float32Array(3)
const m = {
  proj: /* Float32Array(16) */,
  view: /* Float32Array(16) */,
  pv:   /* proj × view */,
  ipv:  /* inv(pv) */,
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

Three-state result: `VISIBLE` (fully inside), `SEMIVISIBLE` (intersecting), `INVISIBLE` (fully outside) — lets the host decide between full draw, wireframe, and skip.

---

### Quaternion and matrix math

Exported individually for use in hot paths:

**Quaternions** — `[x,y,z,w]` w-last:
`qSet`, `qCopy`, `qDot`, `qNormalize`, `qNegate`, `qMul`, `qSlerp`,
`qFromAxisAngle`, `qFromLookDir`, `qFromRotMat3x3`, `qFromMat4`, `qToMat4`, `quatToAxisAngle`

**Spline / vector:** `catmullRomVec3`, `lerpVec3`

**Mat4:** `mat4Mul`, `mat4Invert`, `mat4Transpose`, `mat4MulPoint`, `mat3NormalFromMat4`, `mat4Location`, `mat3Direction`

**TRS ↔ mat4:** `transformToMat4`, `mat4ToTransform`

**Projection queries** (read from a projection mat4 — no renderer needed):
`projIsOrtho`, `projNear`, `projFar`, `projFov`, `projHfov`,
`projLeft`, `projRight`, `projTop`, `projBottom`

**Pixel ratio:** `pixelRatio(proj, vpH, eyeZ, ndcZMin)` — world-units-per-pixel at a given depth, handles both perspective and orthographic.

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
const out  = new Float32Array(3)
const pv   = new Float32Array(16)
const ipv  = new Float32Array(16)

// per frame — zero allocation
mat4Mul(pv, proj, view)
mat4Invert(ipv, pv)
mapLocation(out, px, py, pz, WORLD, SCREEN, { proj, view, pv, ipv }, vp, WEBGL)
```

---

## Relationship to `p5.tree`

[p5.tree](https://github.com/VisualComputing/p5.tree) is the bridge layer. It reads live renderer state (camera matrices, viewport dimensions, NDC convention) and passes it to `@nakednous/tree` functions. It also wraps `PoseTrack` for p5.Camera paths, registers players in the draw loop, and exposes everything in p5's global and instance modes.

`@nakednous/tree` provides the algorithms. The bridge provides the wiring.

---

## License

GPL-3.0-only  
© JP Charalambos
