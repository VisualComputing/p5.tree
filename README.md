# p5.tree

[![npm version](https://img.shields.io/npm/v/p5.tree?color=1f6feb)](https://www.npmjs.com/package/p5.tree)

Render pipeline for [p5.js v2](https://beta.p5js.org/) — [pose and camera interpolation](https://en.wikipedia.org/wiki/Key_frame), [space transforms](https://wikis.khronos.org/opengl/Rendering_Pipeline_Overview), [frustum visibility](https://en.wikipedia.org/wiki/Hidden-surface_determination), [HUD](https://en.wikipedia.org/wiki/Head-up_display), [post-processing pipe](https://en.wikipedia.org/wiki/Video_post-processing#Uses_in_3D_rendering), [picking](https://webglfundamentals.org/webgl/lessons/webgl-picking.html), [interactive 3D handles](https://en.wikipedia.org/wiki/3D_user_interaction), [6-DOF helms](https://en.wikipedia.org/wiki/Six_degrees_of_freedom), and [declarative control panels](https://github.com/dataarts/dat.gui).

![A non-Euclidean geometry cube with faces showcasing teapot, bunny, and Buddha models.](p5.tree.png)

-   [Tracks](#tracks)
    -   [PoseTrack --- object animation](#posetrack--object-animation)
    -   [CameraTrack --- camera keyframe paths](#cameratrack--camera-keyframe-paths)
    -   [Playback options](#playback-options)
    -   [Camera helpers](#camera-helpers)
    -   [Keyframe handles --- track.handles](#keyframe-handles--trackhandles)
-   [Space transformations](#space-transformations)
    -   [Matrix operations](#matrix-operations)
    -   [Frustum queries](#frustum-queries)
    -   [Coordinate space conversions](#coordinate-space-conversions)
    -   [Heads Up Display](#heads-up-display)
-   [Panels](#panels)
    -   [Parameter panel](#parameter-panel)
    -   [Track transport panel](#track-transport-panel)
    -   [Helm panel](#helm-panel)
    -   [Collapsible panels](#collapsible-panels)
-   [Post-processing](#post-processing)
    -   [pipe](#pipe)
    -   [releasePipe](#releasepipe)
-   [Picking](#picking)
    -   [GPU color-ID picking](#gpu-color-id-picking)
    -   [CPU proximity picking](#cpu-proximity-picking)
-   [Utilities](#utilities)
    -   [Shader helpers](#shader-helpers)
    -   [Visibility testing](#visibility-testing)
-   [Gizmos](#gizmos)
    -   [axes](#axes)
    -   [pane](#pane)
    -   [viewFrustum](#viewfrustum)
    -   [hermite](#hermite)
    -   [trackPath](#trackpath)
-   [Handles](#handles)
    -   [Constraints](#constraints)
    -   [Core math on p5.Tree](#core-math-on-p5tree)
    -   [createHandle](#createhandle)
    -   [Lifecycle](#lifecycle)
    -   [value](#value)
    -   [bind](#bind)
    -   [Rotation — DIAL](#rotation--dial)
    -   [Constraint frame — from](#constraint-frame--from)
    -   [Snap / hover / cancel](#snap--hover--cancel)
    -   [Overlapping handles — createPointerRouter](#overlapping-handles--createpointerrouter)
    -   [Draw](#draw)
    -   [Diagnostics](#diagnostics)
-   [Helm](#helm)
    -   [createCameraHelm / createPoseHelm](#createcamerahelm--createposehelm)
    -   [Transport --- feed](#transport--feed)
    -   [Bind a target](#bind-a-target)
    -   [helmRig](#helmrig)
-   [Releases](#releases)
-   [Usage](#usage)
    -   [CDN](#cdn)
    -   [npm (ESM)](#npm-esm)

---

# Tracks

A unified factory creates either a **PoseTrack** (object animation) or a **CameraTrack** (camera keyframe path).

```js
const track = createPoseTrack()       // PoseTrack — animates any object
const track = createCameraTrack()     // CameraTrack — binds to the current camera
const track = createCameraTrack(cam)  // CameraTrack — binds to a specific camera

const track = createPoseTrack({ handles: true })         // + draggable keyframes
const track = createCameraTrack(cam, { handles: true })  // see Keyframe handles below
```

## PoseTrack — object animation

Stores `{ pos, rot, scl }` keyframes. Interpolates position with cubic Hermite (auto-computed centripetal Catmull-Rom tangents by default), rotation with slerp or nlerp, scale with linear.

```js
const track = createPoseTrack()
const out   = { pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] }

track.add({ pos:[-150, 0, 0], rot:[0,0,0,1], scl:[1,1,1] })
track.add({ pos:[ 150, 0, 0], rot:[0,0,0,1], scl:[1,1,1] })
track.play({ loop: true, duration: 60 })

function draw() {
  background(20)
  if (track.playing) {
    push()
    applyPose(track.eval(out))
    box(60)
    pop()
  }
}
```

`add()` accepts flexible specs. Top-level forms:

```js
track.add({ pos, rot, scl })                 // explicit TRS — rot accepts any form below
track.add({ pos, rot, scl, tanIn, tanOut })  // with Hermite tangents (vec3, optional)
track.add({ mat4Model: mat4 })               // decompose a column-major model matrix into TRS
track.add([ spec, spec, ... ])               // bulk
```

`tanIn` is the incoming position tangent at this keyframe; `tanOut` is the outgoing tangent. When only one is given, the other mirrors it. When neither is given, centripetal Catmull-Rom tangents are auto-computed — identical to the default smooth behavior.

```js
track.add({ pos:[0,0,0] })                                      // auto tangents
track.add({ pos:[100,0,0], tanOut:[0,50,0] })                   // leave heading +Y
track.add({ pos:[200,0,0], tanIn:[0,50,0], tanOut:[-30,0,0] })  // arrive from +Y, leave heading -X
track.add({ pos:[300,0,0] })                                    // auto tangents
```

`rot` sub-forms — all normalised internally, no pre-processing needed:

```js
track.add({ pos:[0,0,0], rot: [x,y,z,w] })                          // raw quaternion
track.add({ pos:[0,0,0], rot: { axis:[0,1,0], angle: PI/4 } })      // axis-angle
track.add({ pos:[0,0,0], rot: { dir:[1,0,0] } })                    // look direction
track.add({ pos:[0,0,0], rot: { euler:[rx,ry,rz] } })               // intrinsic YXZ (default)
track.add({ pos:[0,0,0], rot: { euler:[rx,ry,rz], order:'XYZ' } })  // explicit order
track.add({ pos:[0,0,0], rot: { from:[0,0,1], to:[1,0,0] } })       // shortest arc
track.add({ pos:[0,0,0], rot: { mat3: rotationMatrix } })           // 3×3 col-major
track.add({ pos:[0,0,0], rot: { mat4Eye: eyeMat } })                // from eye matrix
```

Supported Euler orders: `YXZ` (default, matches p5 Y-up), `XYZ`, `ZYX`, `ZXY`, `XZY`, `YZX`. All are intrinsic — extrinsic `ABC` equals intrinsic `CBA` with the same angles.

Interpolation modes:

```js
track.posInterp = 'hermite'  // default — Hermite; auto-CR tangents when none stored
track.posInterp = 'linear'
track.posInterp = 'step'     // snap to k0; useful for discrete state changes

track.rotInterp = 'slerp'    // default — constant angular velocity
track.rotInterp = 'nlerp'    // faster, slightly non-constant speed
track.rotInterp = 'step'     // snap to k0 quaternion
```

`eval(out)` writes into a pre-allocated buffer — zero heap allocation per frame. Use `mat4Model(outMat4)` to evaluate directly into a column-major mat4.

## CameraTrack — camera keyframe paths

Stores `{ eye, center, up }` lookat keyframes. Playback applies automatically each frame via `cam.camera()` — no draw-loop guard needed.

```js
let track

function setup() {
  createCanvas(600, 400, WEBGL)
  track = createCameraTrack()  // binds to the default camera

  track.add({ eye:[0,0,500], center:[0,0,0] })
  track.add({ eye:[300,-150,0], center:[0,0,0] })
  track.add({ eye:[-200,100,-300], center:[0,0,0] })
  track.play({ loop: true, duration: 90 })
}

function draw() {
  background(20)
  orbitControl()  // works freely when track is stopped
  axes(); grid()
}
```

`add()` accepts explicit lookat specs or a bulk array:

```js
track.add({ eye, center?, up?, fov?, halfHeight?, near?, far?,
            eyeTanIn?, eyeTanOut?, centerTanIn?, centerTanOut? })
                               // explicit lookat; center defaults to [0,0,0], up to [0,1,0]
                               // near / far default to 0.1 / 1000 when omitted
                               // eyeTanIn/Out — Hermite tangents for eye path
                               // centerTanIn/Out — Hermite tangents for center path
track.add(cam.capturePose())   // capture live camera state (zero-alloc with pre-allocated out)
track.add()                    // shortcut — captures track's bound camera
track.add([ spec, spec, ... ]) // bulk
```

For matrix-based capture use `track.add({ mat4Model: mat4Eye })` on a `PoseTrack` for full-fidelity TRS including roll, or `cam.capturePose()` for lookat-style capture.

`fov` (radians) animates perspective field of view.
`halfHeight` (world units) animates the vertical extent of an ortho frustum —
width is derived from aspect ratio at apply time, preserving image proportions.
`near` / `far` (world units, default `0.1` / `1000`) animate the clip distances
and always carry real values — unlike `fov` / `halfHeight`, they are not
mutually exclusive and do not pass through `null`. All four are captured
automatically by `track.add()` and `cam.capturePose()`.

Interpolation modes:

```js
track.eyeInterp    = 'hermite'  // default — auto-CR tangents when none stored
track.eyeInterp    = 'linear'
track.eyeInterp    = 'step'

track.centerInterp = 'linear'   // default — suits fixed lookat targets
track.centerInterp = 'hermite'  // smoother when center is also flying
track.centerInterp = 'step'
```

## Playback options

All tracks share the same transport API:

```js
track.play({ duration, loop, bounce, rate, onPlay, onEnd, onStop })
track.stop([rewind])  // rewind=true seeks to origin
track.reset()         // clear all keyframes and stop
track.seek(t)         // t ∈ [0, 1]
track.time()          // → number ∈ [0, 1]
track.info()          // → { keyframes, segments, playing, loop, ... }
track.add(spec)       // append keyframe(s)
track.set(i, spec)    // replace keyframe at index
track.remove(i)       // remove keyframe at index
```

| Option     | Default | Description                                   |
|------------|---------|-----------------------------------------------|
| `duration` | `30`    | Frames per segment.                           |
| `loop`     | `false` | Repeat — wrap back to start at end.           |
| `bounce`   | `false` | Bounce at boundaries (independent of `loop`). |
| `rate`     | `1`     | Playback speed (negative reverses direction). |
| `onPlay`   | —       | Fires when playback starts.                   |
| `onEnd`    | —       | Fires at natural end (once mode only).        |
| `onStop`   | —       | Fires on explicit `stop()` or `reset()`.      |

**Loop modes** — `loop` and `bounce` are fully independent flags:

| `loop` | `bounce` | behaviour |
|--------|----------|-----------|
| false  | false    | play once — stop at end (fires `onEnd`) |
| true   | false    | repeat — wrap back to start |
| true   | true     | bounce forever — reverse direction at each boundary |
| false  | true     | bounce once — flip at far boundary, stop at origin |

The internal `_dir` field (±1) tracks bounce travel direction — `rate` is never mutated at boundaries.

Hook firing order:
```
play()  → onPlay → _onActivate
tick()  → onEnd  → _onDeactivate   (once mode, at boundary)
stop()  → onStop → _onDeactivate
reset() → onStop → _onDeactivate
```

`track.playing`, `track.loop`, `track.bounce`, `track.rate`, `track.duration`, `track.keyframes` — readable at any time.

## Camera helpers

```js
getCamera()             // current p5.Camera (curCamera)
cam.capturePose([out])  // → { eye, center, up, fov, halfHeight, near, far }
cam.applyPose(pose)     // write pose back to camera
cam.mat4View(out)       // camera's view matrix (world→eye)
cam.mat4Eye(out)        // camera's eye matrix (eye→world)
cam.mat4Proj(out)       // camera's projection matrix (eye→clip)
```

These camera-level matrix readers are distinct from the renderer-level
queries in the Matrix operations section below. Renderer-level
`mat4Proj(out)` reads the *current* projection installed on the renderer;
`cam.mat4Proj(out)` reads the projection of a *specific* camera regardless
of whether it's currently active. Same distinction applies to
`mat4View` / `mat4Eye`.

## Keyframe handles — track.handles

Grab a track's keyframes in the scene. The `handles` factory opt decorates the track with a `track.handles` controller — one screen-parallel drag dot per keyframe field (a [`VIEW`](#constraints) handle: the point follows the pointer at its own depth), all routed through one shared [pointer router](#overlapping-handles--createpointerrouter). Keyframes are written **in place**, and the core samplers read them live — so the path, the auto-CR tangents, `eval()`, and any `viewFrustum({ camera: track })` reflow on the very next call, mid-playback included.

```js
const track = createPoseTrack({ handles: true })
const track = createPoseTrack({ handles: { rot: [0, 1, 0] } })   // + a rotation ring per keyframe
const track = createCameraTrack(cam, { handles: true })          // eye + center dots
const track = createCameraTrack({ handles: true })               // opts-only call works too
```

| Track | Field | Handle | Default |
|---|---|---|---|
| `PoseTrack`   | `kf.pos`    | `VIEW` drag dot | always |
| `PoseTrack`   | `kf.rot`    | one `DIAL` about a declared axis | opt-in `rot: axis` |
| `CameraTrack` | `kf.eye`    | `VIEW` drag dot | always |
| `CameraTrack` | `kf.center` | `VIEW` drag dot | `center: true` |

A camera keyframe's orientation **is** its center — lookat derives the frame from eye→center+up — so the center dot is the camera **orientation editor**: dragging it re-aims the gaze ray and the keyframe marker. (`rot` is rejected on a `CameraTrack`, `center` on a `PoseTrack`.) When every keyframe targets the same center (the common authoring style) the center dots start coincident — the first grab picks one arbitrarily; drag it and they separate.

Drive the controller host-side and gate the orbit — the standard [handle lifecycle](#lifecycle), against the **observer** camera in a two-camera sketch:

```js
function draw() {
  setCamera(viewCam)
  if (!track.handles.update()) orbitControl()   // a grab wins over orbit
  // ... scene ...
  stroke('white');  trackPath(track, { bits: p5.Tree.PATH, marker: null })
  fill('#ffd166');  trackPath(track, { bits: p5.Tree.HANDLES })   // markers + dots
}
```

Drawing is the [`HANDLES` trackPath bit](#trackpath): a constant-px dot per draggable field, the ring + spoke for a rot `DIAL`, hovered/grabbed dots growing ×1.4 (colour stays ambient — `fill()` the dots, `stroke()` the ring). The bit no-ops on a track without handles, and obeys `marker: null` like every per-keyframe layer. `track.handles.draw()` is the same render standalone.

Opts (`handles: true` = all defaults):

| Option | Default | Description |
|---|---|---|
| `center` | `true` | `CameraTrack` only — center dots (the orientation editor). |
| `rot` | — | `PoseTrack` only — a `DIAL` per keyframe about this world axis. |
| `rotRadius` | `40` | `DIAL` ring radius (world units). |
| `rotSnap` | `null` | Angular snap step (radians) for the `DIAL`. |
| `grabPx` | `12` | Pick-proxy + dot radius (px). |
| `snap` | `null` | World-grid snap for the position dots. |
| `hover` | `true` | Router shared hover. |

Controller surface:

```js
track.handles.update()      // rebuild-if-needed, sync, route — returns grabbed (the orbit gate)
track.handles.enabled       // get/set — suspend grab/solve/draw without disposing
track.handles.grabbed()     // true while any keyframe handle is held
track.handles.hovered()     // keyframe index under the pointer, or null
track.handles.selected      // last-grabbed keyframe index, or null
track.handles.sync()        // re-seed idle handles (update() already does this each frame)
track.handles.draw(opts)    // what the HANDLES bit calls — { size, emphasis }
track.handles.dispose()     // release members + router; detaches from the track

track.handles.onGrab    = (index, field, h) => { }   // field: 'pos'|'eye'|'center'|'rot'
track.handles.onChange  = (value, index, field, h) => { }
track.handles.onRelease = (index, field, h) => { }
track.handles.onCancel  = (index, field, h) => { }   // Esc / pointercancel reverts the keyframe
```

The member handles are internal — hooks arrive with keyframe coordinates instead. Keyframe count changes rebuild the member set automatically, so the [transport panel](#track-transport-panel)'s `+` button and `track.remove(i)` just work; external edits (`track.set(i, spec)`, another handle) are picked up by the per-frame idle sync. The `PoseTrack` rot `DIAL` edits the **twist** about the declared axis and *replaces* `kf.rot` with an axis-angle rotation — exact for keyframes authored about that axis, a projection otherwise. Full spec: `track-handles-design.md` in the [core repo](https://github.com/nakednous/tree).

---

# Space transformations

## Matrix operations

All matrix queries share the same contract:
- `out` is the **first** parameter — the caller owns the buffer
- returns `out` (or `null` on a singular matrix)
- no allocations — pass the same buffer every frame

Accepted types for `out` and override params: `Float32Array` | `ArrayLike` | `p5.Matrix`

**Simple queries** — read from live renderer state:

```js
mat4Model(out)                               // model matrix — local→world
mat4View(out)                                // view matrix — world→eye
mat4View(out, ex,ey,ez, cx,cy,cz, ux,uy,uz)  // standalone lookat view — no camera state
mat4Eye(out)                                 // eye matrix (inverse view) — eye→world
mat4Eye(out, ex,ey,ez, cx,cy,cz, ux,uy,uz)   // standalone lookat eye — no camera state
mat4Proj(out)                                // projection matrix (live state — persp or ortho)
mat4Persp(out, l,r,b,t, near,far)            // standalone perspective (general frustum)
mat4Ortho(out, l,r,b,t, near,far)            // standalone orthographic
```

**Composite queries** — `out` first, optional overrides in an opts object:

```js
mat4PV(out,    [{ mat4Proj, mat4View }])
mat4PVInv(out, [{ mat4Proj, mat4View, mat4PV }])
mat4MV(out,    [{ mat4Model, mat4View }])
mat4PMV(out,   [{ mat4Proj, mat4Model, mat4View }])
mat3Normal(out,[{ mat4Model, mat4View, mat4MV }])  // 9-element out
mat4Location(out, from, to)   // location transform: inv(to) · from
mat3Direction(out, from, to)  // direction transform: to₃ · inv(from₃), 9-element out
```

**Raw matrix math** — forwarded from `@nakednous/tree`, same out-first contract:

```js
mat4Mul(out, A, B)            // out = A · B  (column-major)
mat4Invert(out, src)          // out = inv(src), null if singular
mat4MulPoint(out, m, point)   // out = m · [x,y,z,1] perspective-divided
                              // point: Float32Array | ArrayLike | p5.Vector
mat4MulDir(out, m, dx,dy,dz)  // out = 3×3 block of m applied to direction
                              // no translation, no perspective divide
```

**Decomposition** — extract components from an existing mat4:

```js
mat4ToTranslation(out3, m)  // extract translation (col 3)
                            // out3: Float32Array | number[] | p5.Vector
mat4ToScale(out3, m)        // extract scale (column lengths) — assumes no shear
                            // out3: Float32Array | number[] | p5.Vector
mat4ToRotation(out4, m)     // extract rotation as unit quaternion [x,y,z,w]
                            // out4: Float32Array | number[]
```

**Zero-allocation draw-loop pattern:**

```js
// setup — allocate once
const e   = new Float32Array(16)
const pm  = new Float32Array(16)
const pv  = new Float32Array(16)
const wlm = new Float32Array(16)  // e.g. bias · lightPV for shadow mapping
const pt  = new Float32Array(3)

// draw — zero allocations
mat4Eye(e)
mat4Proj(pm)
mat4PV(pv)
mat4Mul(wlm, biasMatrix, pv)
mat4MulPoint(pt, wlm, lightPosition)
viewFrustum({ mat4Eye: e, mat4Proj: pm })
mouseHit({ mat4PV: pv, mat4Eye: e })
```

## Frustum queries

Scalars read directly from the projection matrix — no buffer needed:

```js
projLeft()   projRight()   projBottom()   projTop()   // side planes
projNear()   projFar()                                // near / far
projFov()    projHfov()                               // field of view (radians)
projIsOrtho()                                         // true for orthographic

pixelRatio([worldPos], [{ mat4Proj, mat4View }])
// world-units-per-pixel at worldPos (defaults to camera position)
```

## Coordinate space conversions

`out` is opt-in. When provided via `opts.out` the result is written into it (zero-alloc hot path). When omitted a fresh `p5.Vector` is allocated and returned. Return type matches `opts.out`.

```js
mapLocation([point], [opts])  // map a point between spaces
mapLocation([opts])           // input defaults to p5.Tree.ORIGIN
mapLocation()                 // ORIGIN, EYE → WORLD → p5.Vector

mapDirection([dir], [opts])   // map a direction between spaces
mapDirection([opts])          // input defaults to p5.Tree._k
mapDirection()                // _k, EYE → WORLD → p5.Vector
```

`point` / `dir` accept `Float32Array` | `ArrayLike` | `p5.Vector`.

| Option       | Default           | Description                                     |
|--------------|-------------------|-------------------------------------------------|
| `out`        | new p5.Vector()   | Destination buffer — omit to allocate p5.Vector.|
| `from`       | `p5.Tree.EYE`     | Source space (constant or matrix).              |
| `to`         | `p5.Tree.WORLD`   | Target space (constant or matrix).              |
| `mat4Eye`    | current eye       | Pre-computed eye matrix.                        |
| `mat4Proj`   | current proj      | Override projection matrix.                     |
| `mat4View`   | current view      | Override view matrix.                           |
| `mat4PV`     | P·V               | Pre-computed PV — skips multiply.               |
| `mat4PVInv`  | inv(PV)           | Pre-computed IPV — skips inversion.             |

`from` / `to` accept: `p5.Tree.WORLD`, `EYE`, `SCREEN`, `NDC`, `MODEL`, or a mat4 for a custom local frame.

```js
// ergonomic — allocates p5.Vector
const eye = mapLocation()                                      // camera world position
const fwd = mapDirection()                                     // camera look direction
const scr = mapLocation([100,0,0], { from: p5.Tree.WORLD,
                                     to:   p5.Tree.SCREEN })

// hot path — zero allocation
const loc = new Float32Array(3)
const pv  = new Float32Array(16)
mat4PV(pv)
mapLocation([100,0,0], { from: p5.Tree.WORLD, to: p5.Tree.SCREEN,
                         out: loc, mat4PV: pv })
```

Constants: `p5.Tree.ORIGIN`, `p5.Tree.i`, `p5.Tree.j`, `p5.Tree.k`, `p5.Tree._i`, `p5.Tree._j`, `p5.Tree._k`.

## Heads Up Display

Draw directly in screen space — independent of the current camera and 3D transforms.

```js
beginHUD()
text('FPS: ' + frameRate().toFixed(1), 10, 20)
endHUD()
```

Coordinates: `(x, y) ∈ [0, width] × [0, height]`, origin top-left, y increasing downward.

---

# Panels

A unified `createPanel` factory covers parameter bindings and track transport controls. The first argument determines the panel type.

## Parameter panel

Binds named schema keys to DOM sliders, checkboxes, color pickers, dropdowns, and buttons. Target receives `(name, value)` on each dirty tick.

```js
const panel = createPanel({
  speed:     { min: 0, max: 0.05, value: 0.012, step: 0.001 },
  shininess: { min: 1, max: 200,  value: 80,    step: 1,    type: 'int' },
  showGrid:  { value: true },
  tint:      { value: '#ff8844' },
  fxOrder:   { type: 'select', options: [
                 { label: 'noise → dof', value: '1' },
                 { label: 'dof → noise', value: '2' }
               ], value: '1' }
}, { x: 10, y: 10, width: 160, labels: true, title: 'Scene', color: 'white',
     target: (name, value) => shader.setUniform(name, value) })

// call every frame
panel.tick()
```

| Option     | Default         | Description                                             |
|------------|-----------------|---------------------------------------------------------|
| `target`   | —               | `fn(name, value)` or object with `.set(name, value)`.   |
| `x` / `y`  | `0`             | Position (px).                                          |
| `width`    | `120`           | Slider width (px).                                      |
| `labels`   | `false`         | Show parameter name labels.                             |
| `title`    | —               | Optional title row.                                     |
| `collapsible` | `false`      | Title row becomes a collapse toggle.                    |
| `collapsed`   | `false`      | Start collapsed (implies collapsible).                  |
| `color`    | —               | Container text color.                                   |
| `hidden`   | `false`         | Start hidden.                                           |
| `parent`   | `document.body` | Mount target (`HTMLElement`).                           |

## Track transport panel

Controls playback of any `PoseTrack` or `CameraTrack`.

```js
const ui = createPanel(track, {
  x: 10, y: 10, width: 170,
  loop: false, rate: 1,
  seek: true, props: true, info: true,
  color: 'white'
})

// Suppress + button
createPanel(track, { camera: null, x: 10, y: 10 })

// Suppress reset button (e.g. when keyframes are hardcoded and cannot be re-added)
createPanel(track, { reset: false, x: 10, y: 10 })

// Suppress play/stop button — seek slider still works
createPanel(track, { play: false, x: 10, y: 10 })

// call every frame
ui.tick()
```

| Option      | Default        | Description                                        |
|-------------|----------------|----------------------------------------------------|
| `seek`      | `true`         | Show seek slider.                                  |
| `props`     | `true`         | Show rate slider + loop controls.                  |
| `info`      | `false`        | Show time/keyframe readout.                        |
| `rate`      | track.rate     | Initial rate.                                      |
| `loop`      | track.loop     | Initial loop state.                                |
| `bounce`    | track.bounce   | Initial bounce state.                              |
| `depth`     | `0.5`          | Initial + button depth [0..1].                     |
| `camera`    | track.camera (CameraTrack), curCamera (PoseTrack) | Camera for + button. `null` suppresses it. |
| `reset`     | `true`         | Show reset button. `false` suppresses it.          |
| `play`      | `true`         | Show play/stop button. `false` suppresses it.      |

Lifecycle hooks can be passed directly in opt:

```js
createPanel(track, {
  onPlay: t => console.log('playing'),
  onEnd:  t => console.log('done'),
  onStop: t => console.log('stopped'),
  x: 10, y: 10
})
```

**Returned handle** (both panel types):

```js
panel.el          // HTMLElement container
panel.visible     // get/set boolean
panel.collapsed   // get/set boolean (requires collapsible + title)
panel.parent(el)  // re-mount into a different HTMLElement
panel.tick()      // called automatically — no need to call manually
panel.dispose()   // remove from DOM
```

## Helm panel

Edits a `PoseHelm`'s 6-DOF profile (`createCameraHelm` / `createPoseHelm`) and reflects its live activity — signed per-DOF sliders, lane cycle-buttons, per-DOF activity meters, and a global deadzone. The profile is driven by reference, so edits land on the live helm immediately.

```js
const helm = createPoseHelm()
helm.bind(obj)

const ui = createPanel(helm, {
  frame:    true,                 // pose helms only — EYE / WORLD / SELF selector
  inline:   true,                 // flow in document order instead of an absolute float
  onChange: () => syncOut(),      // fired after any user edit
  x: 10, y: 10, color: 'white'
})

// tick is automatic via the draw-loop player — no manual call needed
```

Each DOF is one **signed slider** spanning `−max … +max`: distance from centre is `sens`, the side is `sign`, and dragging through 0 mutes the DOF and disables its **lane** button. When `helm.filter` is set, the panel additionally grows `minCutoff` and `beta` sliders beside the deadzone — the 1€ conditioning surface. `{ frame: true }` adds an `EYE` / `WORLD` / `SELF` selector writing `helm.from` (pose helms only — a camera helm is always body-fly, so omit it). `onChange()` fires after any edit so a sketch can react without polling each frame; a device calibration sweep that writes the profile directly bypasses the panel, so call `onChange` yourself there. `inline: true` flows the panel in document order for mounting inside an existing sidebar via `parent`.

| Option     | Default       | Description                                                  |
|------------|---------------|--------------------------------------------------------------|
| `frame`    | `false`       | Show the `EYE` / `WORLD` / `SELF` selector (pose helms only). |
| `onChange` | —             | Called after any user edit of the profile.                  |
| `inline`   | `false`       | Flow in document order instead of an absolute float (ignores `x` / `y`). |
| `x` / `y`  | `0`           | Container position (px).                                    |
| `width`    | `130`         | Signed-slider width (px).                                   |
| `color`    | —             | Container text color (meters inherit it).                   |
| `parent`   | canvas parent | Mount target (`HTMLElement` or `p5.Element`).               |

The `helmRig` gizmo is the spatial counterpart — see [Helm](#helm).

## Collapsible panels

Any panel with a `title` can be made collapsible. Clicking the title row toggles the content.

```js
createPanel(schema, { title: 'Noise', collapsible: true, collapsed: true })
createPanel(track,  { title: 'Camera path', collapsible: true })
```

Programmatic control:

```js
panel.collapsed = true
panel.collapsed = false
```

---

# Post-processing

A lightweight multi-pass pipeline for `p5.Framebuffer`, `p5.strands`, and standard WebGL rendering. `pipe()` chains filter shaders, reuses internal ping/pong framebuffers, and optionally displays the result. Framebuffers are lazily allocated and released on sketch removal.

## pipe

```js
pipe(source, passes, options)
```

| Parameter | Description                                          |
|-----------|------------------------------------------------------|
| `source`  | `p5.Framebuffer`, texture, image, or graphics.       |
| `passes`  | Array of filters, or a single filter instance.       |
| `options` | See table below.                                     |

| Option           | Default         | Description                                         |
|------------------|-----------------|-----------------------------------------------------|
| `display`        | `true`          | Draw final output to the main canvas.               |
| `allocate`       | `true`          | Auto-allocate and cache internal ping/pong.         |
| `key`            | `'default'`     | Cache key for multiple independent pipelines.       |
| `ping` / `pong`  | —               | User-provided framebuffers (advanced override).     |
| `clear`          | `true`          | Clear each pass target before drawing.              |
| `clearDisplay`   | `true`          | Clear main canvas before final blit.                |
| `clearFn`        | `background(0)` | Custom clear strategy for passes.                   |
| `clearDisplayFn` | `clearFn`       | Custom clear strategy for display stage.            |
| `draw`           | full blit       | Custom draw strategy for placing texture on target. |

## releasePipe

```js
releasePipe()         // release default pipeline
releasePipe(true)     // release all pipelines
releasePipe('key')    // release a named pipeline
```

---

# Picking

Two complementary strategies — GPU color-ID for whole-scene picking, CPU proximity for per-object hit testing.

## GPU color-ID picking

Renders the scene into a cached 1×1 framebuffer with a pick-matrix projection aligned to the query pixel, reads back one RGBA pixel, and decodes a 24-bit integer id. Supports up to 16 777 215 unique ids. id `0` is reserved for background / miss.

```js
// tag(id) encodes an integer as a CSS hex string — works with fill() regardless of colorMode()
fill(tag(1)); box(60)
fill(tag(2)); sphere(40)
```

```js
// colorPick — explicit coordinates
const hit = colorPick(mouseX, mouseY, () => {
  push(); fill(tag(1)); box(60);    pop()
  push(); fill(tag(2)); sphere(40); pop()
})
if (hit === 1) console.log('box!')
if (hit === 2) console.log('sphere!')

// mousePick — shorthand for colorPick(mouseX, mouseY, fn)
const hit = mousePick(() => {
  push(); fill(tag(1)); box(60);    pop()
  push(); fill(tag(2)); sphere(40); pop()
})
```

Before `drawFn` is called, the library unconditionally sets `noLights()`, `noStroke()`, `resetShader()`.
Stroke is excluded from the pick buffer by default — call `stroke(tag(id))` inside `drawFn` to include it,
skipping the stroke render passes when precision or performance warrants it.
When stroke is included, both `fill` and `stroke` must carry the same `tag(id)`.
The FBO is lazily allocated on first use and released on sketch removal.

## CPU proximity picking

Tests whether a pointer position falls within a radius of the current model's projected screen-space origin. Zero GPU round-trip — call inside `push()`/`pop()` for each pickable object.

```js
// mouseHit — test against mouseX/mouseY
push()
translate(x, y, z)
if (mouseHit()) { fill('red') } else { fill('white') }
box(60)
pop()

// pointerHit — explicit coordinates (base form)
push()
translate(x, y, z)
if (pointerHit(touchX, touchY)) { fill('red') } else { fill('white') }
box(60)
pop()
```

Both accept the same options object:

| Option      | Default          | Description                                    |
|-------------|------------------|------------------------------------------------|
| `mat4Model` | current model    | Override model matrix.                         |
| `size`      | `50`             | Hit radius (world units, auto-scaled by depth).|
| `shape`     | `p5.Tree.CIRCLE` | `CIRCLE` or `SQUARE`.                          |
| `mat4Eye`   | current eye      | Pre-computed eye matrix.                       |
| `mat4Proj`  | current proj     | Override projection.                           |
| `mat4View`  | current view     | Override view.                                 |
| `mat4PV`    | P·V              | Pre-computed PV.                               |

---

# Utilities

```js
p5.Tree.VERSION   // '0.0.51'
```

## Shader helpers

```js
screenSize()
// Returns physical canvas size in pixels:
// [pixelDensity * width, pixelDensity * height].
// Use as `u_resolution` when working with gl_FragCoord.xy.
// Not required for createFilterShader() — filter shaders receive `canvasSize` automatically.

shader.setUniform('u_resolution', screenSize())
```

```js
texelSize(img)
// Returns texel size: [1 / width, 1 / height].
// Accepts p5.Image, p5.Framebuffer, p5.Graphics,
// or any object with { width, height }.

shader.setUniform('texOffset', texelSize(myFbo))
```

## Visibility testing

Frustum culling with two orthogonal axes — **where bounds are defined** (world vs local space)
and **which frustum to test against** (current camera vs any camera). All four combinations
are valid and compose freely.

```js
// world-space bounds, current camera
visibility({ corner1, corner2 })             // axis-aligned box
visibility({ center, radius })               // sphere
visibility({ center })                       // point

// local-space bounds, current camera — mat4Model transforms bounds before test
visibility({ corner1, corner2, mat4Model })
visibility({ center, radius,   mat4Model })

// world-space bounds, arbitrary camera — pre-compute frustum from any eye matrix
const b = bounds({ mat4Eye: lightEyeMatrix })
visibility({ corner1, corner2, bounds: b })
visibility({ center, radius,   bounds: b })

// local-space bounds, arbitrary camera — full composition
visibility({ corner1, corner2, mat4Model, bounds: b })
visibility({ center, radius,   mat4Model, bounds: b })
```

`mat4Model` accepts `Float32Array(16)` | `ArrayLike` | `p5.Matrix`.
AABB: all 8 corners transformed, result is a conservative world-space AABB.
Sphere: center transformed, radius scaled by max column length.

`bounds({ mat4Eye })` pre-computes the six frustum planes from any camera's eye matrix.
Typical uses: shadow map culling (light's frustum), portal rendering, dual-camera scenes.
Omit `mat4Eye` to use the current camera.

Returns `p5.Tree.VISIBLE` | `p5.Tree.SEMIVISIBLE` | `p5.Tree.INVISIBLE`.

---

# Gizmos

Scene-space diagnostic helpers — drawn to understand the scene, not to build it.

```js
axes([{ size, bits, semantic }])
grid([{ size, subdivisions }])
cross([{ size }])
bullsEye([{ size, shape }])
pane(p0, p1, p2, p3, [{ texture, uvs }])
viewFrustum({ camera, mat4Eye, mat4Proj, mat4View, bits, viewer, nearTexture, farTexture })
hermite(p0, m0, p1, m1, [{ samples }])
trackPath(track, [{ bits, samples, target, marker }])
```

Matrix params accept `Float32Array(16)` | `ArrayLike` | `p5.Matrix` throughout.

## axes

`axes` colours X/Y/Z red/lime/blue by default. Pass `semantic: false` to have every axis and label use the ambient stroke instead — compose per-axis colouring by splitting into single-bit calls with your own `stroke()`:

```js
stroke('red');   axes({ bits: p5.Tree.X, semantic: false })
stroke('lime');  axes({ bits: p5.Tree.Y, semantic: false })
stroke('cyan');  axes({ bits: p5.Tree.Z, semantic: false })
```

Bits: `p5.Tree.X`, `p5.Tree._X`, `p5.Tree.Y`, `p5.Tree._Y`, `p5.Tree.Z`, `p5.Tree._Z`, `p5.Tree.LABELS`.

## pane

An atomic textured quad primitive — four 3D corner points in CCW order,
optional texture, optional UVs. `pane` (as in window pane) is
deliberately distinct from p5's native `plane(w, h)` to avoid shadowing a
core primitive. It's the low-level building block `viewFrustum` uses for
its `NEAR` / `FAR` / `BODY` quads, and that the default `CameraTrack`
marker uses for the per-keyframe near plane.

```js
pane(topLeft, topRight, bottomRight, bottomLeft)
pane(p0, p1, p2, p3, { texture: myFbo.color })
pane(p0, p1, p2, p3, { texture: myImg, uvs: [[0,0],[1,0],[1,1],[0,1]] })
```

Corners are passed in CCW order. `texture` accepts `p5.Image`,
`p5.Graphics`, `p5.Texture`, or a `p5.Framebuffer`'s color attachment
(`myFbo.color`). When `texture` is omitted the quad is drawn with the
ambient `fill()` / `stroke()` state.

### UVs and orientation

When `uvs` is omitted, the default sampling depends on the texture type:

| Texture type         | Default UV layout | Rationale |
|---------------------|-------------------|-----------|
| `p5.Image` / `p5.Graphics` / `p5.Texture` | `(0,0)→(1,1)` top-to-bottom | Matches `image()` orientation. |
| `p5.FramebufferTexture` (`fbo.color`)     | V-flipped `(0,1)→(1,0)` | FBO contents are stored bottom-up (WebGL convention); flipping V makes the pane display right-side-up, matching `image(fbo)` and the geometry drawn into the FBO. |

Pass explicit `uvs` to override this selection. `pane` calls
`textureMode(NORMAL)` internally, so these UVs and any custom UVs you
pass are interpreted as normalized 0..1 coordinates regardless of the
ambient `textureMode`. The original ambient mode is restored after
the call.

### Alpha

Use p5's `tint(255, α)` before `pane(...)` to modulate the texture's
alpha — standard p5 state, scoped by `pane`'s push/pop:

```js
tint(255, 180)                                // 70% opaque near plane
pane(p0, p1, p2, p3, { texture: fbo.color })
noTint()                                      // (or rely on caller's state)
```

## viewFrustum

Draws the view frustum of a secondary camera into the current renderer.
`camera` accepts three forms:

| Input          | Source of pose + projection                                                  |
|----------------|------------------------------------------------------------------------------|
| `p5.Camera`    | `cam.mat4Eye()` + `cam.mat4Proj()` — direct reads from the camera itself.    |
| `CameraTrack`  | `track.eval()` + `track.mat4Eye()` — sampled at the cursor; animates with playback. |
| pose spec      | `{ eye, center?, up?, fov?, halfHeight?, near?, far? }` — same shape `capturePose()` returns and `CameraTrack.add()` accepts. |

```js
viewFrustum({ camera: sceneCam })                            // p5.Camera — static frustum
viewFrustum({ camera: cameraTrack })                         // CameraTrack — animated, follows the cursor
viewFrustum({ camera: { eye:[100,0,0], fov: PI/3 } })        // pose spec — one-off frustum
viewFrustum({ camera, bits: NEAR | FAR | BODY | APEX })      // bits selection
viewFrustum({ camera, nearTexture: fbo.color, farTexture: img })  // textured planes
viewFrustum({ mat4Eye, mat4Proj })                           // explicit matrices
```

Pose-spec defaults: `center=[0,0,0]`, `up=[0,1,0]`, `near=0.1`, `far=1000`,
`fov=PI/3` if neither `fov` nor `halfHeight` is supplied. Aspect for the
projection comes from the renderer's current `width / height`.

Detection is duck-typed: a CameraTrack is anything with `.eval(out)`,
`.mat4Eye(out)`, and a `keyframes` array. Third-party objects implementing
that contract animate correctly without further changes.

All forms internally fill the same scratch buffers — zero allocation per
frame. Pass `mat4Eye` / `mat4Proj` explicitly if you've already built the
matrices or want to override.

Bits:

| Bit               | Effect                                                                 |
|-------------------|------------------------------------------------------------------------|
| `p5.Tree.NEAR`    | Near plane (filled quad if `nearTexture` is set, outlined otherwise).  |
| `p5.Tree.FAR`     | Far plane (filled quad if `farTexture` is set, outlined otherwise).   |
| `p5.Tree.BODY`    | The four side walls joining near to far (or apex → far in APEX mode). |
| `p5.Tree.APEX`    | Perspective only — collapse the near-plane body start to the eye point. |

Default bits: `NEAR | FAR | BODY`.

### viewer

`opts.viewer` is a callback drawn at the frustum's eye (in the secondary
camera's own space). It defaults to a forward-looking triad —
`X | Y | _Z`, size 50 — matching the convention that the camera looks
down `−Z`. Pass a custom callback for a richer marker (apex gizmo, logo,
etc.) or `() => {}` to suppress it.

### nearTexture / farTexture

`nearTexture` and `farTexture` map a texture onto the corresponding
plane via the `pane()` helper. Accepts `p5.Image`, `p5.Graphics`,
`p5.Texture`, or a `p5.Framebuffer`'s color attachment (`myFbo.color`).
FBO textures are V-flipped automatically to display right-side-up
(see the `pane` section for details).

Modulate alpha with p5's `tint()` — translucent near planes are useful
for "ghosted window" effects where the scene behind the frustum reads
through the texture:

```js
tint(255, 180)                                                  // 70% opaque
viewFrustum({ camera, nearTexture: fbo.color, bits: NEAR | BODY })
noTint()
```

Typical use: the scene as rendered from the secondary camera, mapped
onto its own near plane — so the viewFrustum is literally a window
showing what that camera sees:

```js
// setup — a secondary camera + framebuffer
let sceneCam, sceneFbo

function setup() {
  createCanvas(600, 400, WEBGL)
  sceneCam = createCamera()
  sceneCam.camera(200, -100, 300, 0, 0, 0, 0, 1, 0)
  sceneCam.perspective(PI / 3.5, width / height, 50, 500)
  sceneFbo = createFramebuffer({ width: 320, height: 200 })
}

function draw() {
  // render "what the secondary camera sees" into sceneFbo — both
  // setCamera and resetMatrix are required for the view to update
  sceneFbo.begin()
  setCamera(sceneCam)
  resetMatrix()
  background(0)
  box(80)
  sceneFbo.end()

  // draw the main view
  background(20); orbitControl(); axes(); box(80)

  // and the frustum — near plane textured with the FBO's color attachment
  viewFrustum({
    camera:      sceneCam,
    nearTexture: sceneFbo.color,
    bits:        p5.Tree.NEAR | p5.Tree.FAR | p5.Tree.BODY
  })
}
```

Textured planes draw last (far before near) so alpha compositing stays
correct when both are enabled.

**p5 v2 plumbing notes.**

* `p5.Framebuffer` exposes its color attachment via `fbo.color` — that's
  what textures sample from. Pass `fbo.color` (not the fbo itself) to
  `nearTexture` / `farTexture`.
* Inside `fbo.begin()`, both `setCamera(cam)` and `resetMatrix()` are
  required for the view to update correctly — `setCamera` alone only
  updates projection.

## hermite

A single cubic Hermite segment between `p0` and `p1` with explicit outgoing tangent `m0` at `p0` and incoming tangent `m1` at `p1`. Sampled at `samples` points (default 32) and stroked as a polyline.

```js
hermite([-150, 0, 0], [0, 200, 0], [150, 0, 0], [0, -200, 0])
hermite(p0, m0, p1, m1, { samples: 64 })
```

## trackPath

Visualises a `PoseTrack` or `CameraTrack`: sampled path polyline, control polygon, tangent arrows, per-keyframe marker, and — on `CameraTrack` only — gaze rays from each eye keyframe to its center.

Bits:

| Bit                    | Effect                                                                    |
|------------------------|---------------------------------------------------------------------------|
| `p5.Tree.PATH`         | Sampled polyline along the target path.                                   |
| `p5.Tree.CONTROLS`     | Straight control polygon along the target path.                           |
| `p5.Tree.TANGENTS_IN`  | Incoming tangent arrow at each keyframe of the target path.               |
| `p5.Tree.TANGENTS_OUT` | Outgoing tangent arrow at each keyframe of the target path.               |
| `p5.Tree.TANGENTS`     | Convenience alias — `TANGENTS_IN \| TANGENTS_OUT`.                        |
| `p5.Tree.CENTER`       | `CameraTrack` only. Gaze line from `kf.eye` to `kf.center` at each keyframe, with a `point()` at `kf.center`. Target-independent. |
| `p5.Tree.HANDLES`      | Keyframe manipulator dots when the track carries [`track.handles`](#keyframe-handles--trackhandles) — delegates to the controller's `draw()`; no-op otherwise. |

Default bits: `PATH`.

`HANDLES` renders only when the track was created with the [`handles`](#keyframe-handles--trackhandles) factory opt — dots take the ambient `fill()`, the rot ring the ambient `stroke()`, and hovered/grabbed dots grow ×1.4. Picking is host-driven (`track.handles.update()`); the bit is the drawing half only.

`opts.target` — `'eye'` (default) or `'center'`. `CameraTrack` only: redirects `PATH` / `CONTROLS` / `TANGENTS_IN` / `TANGENTS_OUT` to the center path instead of the eye path. `PoseTrack` ignores `target` (there is only one path). `CENTER` is target-independent — it is inherently an eye→center relationship. Call `trackPath` twice (once per target) to decorate both paths with distinct `stroke()`s.

All strokes come from the ambient `stroke(...)` state — multi-colour effects compose by splitting the call, matching the `axes` / `viewFrustum` pattern:

```js
const { PATH, CONTROLS, TANGENTS_IN, TANGENTS_OUT, CENTER } = p5.Tree

// eye path (default target)
stroke('white');   trackPath(track, { bits: PATH })
stroke('gray');    trackPath(track, { bits: CONTROLS,     marker: null })
stroke('cyan');    trackPath(track, { bits: TANGENTS_IN,  marker: null })
stroke('magenta'); trackPath(track, { bits: TANGENTS_OUT, marker: null })

// center path (CameraTrack) — same bits, redirected via target
stroke('orange');  trackPath(track, { bits: PATH | CONTROLS, target: 'center', marker: null })

// gaze rays from each eye keyframe to its center
stroke('lime');    trackPath(track, { bits: CENTER, marker: null })
```

### marker

`trackPath` calls `marker(kf, index, track, ctx)` once per keyframe, where

* `kf`     — the keyframe object (`{pos, rot, scl, ...}` for `PoseTrack`, `{eye, center, up, fov?, halfHeight?, ...}` for `CameraTrack`)
* `index`  — keyframe index
* `track`  — the track being drawn
* `ctx`    — `{ near, far, aspect, ndcZMin }`, read from the current renderer projection

The gizmo does **not** pre-translate or rotate before calling `marker` — markers are responsible for positioning themselves. This keeps the signature uniform across track types and avoids hidden matrix-stack ceremony. Markers that need matrices at path points reach into the track samplers directly (`track.mat4Model`, `track.mat4Eye`). Projection matrices are built from each keyframe's raw scalars (`kf.fov` or `kf.halfHeight`) via the free `mat4Persp` / `mat4Ortho` constructors.

Defaults (when `marker` is not supplied):

* `PoseTrack` — six axes (length 30) oriented by each keyframe's pose.
* `CameraTrack`, `target: 'eye'` (default) — a "mini camera" at each keyframe: a forward-looking triad (`X | Y | _Z`, size = `kf.near`) oriented by the lookat basis, apex lines from the eye to the four near-plane corners, and the near plane itself (extents from `kf.fov` or `kf.halfHeight` at the ambient aspect). Everything is drawn at the keyframe's real dimensions — no scaling heuristics. The marker is scoped to camera-local geometry; the eye→center gaze line is drawn by the `CENTER` bit rather than by the marker itself, so it remains a separate toggle in a distinct `stroke()`.
* `CameraTrack`, `target: 'center'` — a `point()` at each keyframe's center.

Pass `marker: null` to suppress per-keyframe markers (useful when layering strokes across multiple `trackPath` calls). The default marker is deliberately minimal — callers who want a full viewFrustum per keyframe supply a custom `marker`:

```js
// PoseTrack — draw a small box oriented by each keyframe's pose
trackPath(poseTrack, {
  marker: (kf) => {
    push()
    translate(kf.pos[0], kf.pos[1], kf.pos[2])
    rotateQuat(kf.rot)
    noFill()
    box(25)
    pop()
  }
})

// CameraTrack — frustum with a short visualization far plane, independent
// of the viewing camera's own far.
const kfEye = new Float32Array(16)
const kfPrj = new Float32Array(16)
trackPath(camTrack, {
  marker: (kf, i, track, ctx) => {
    track.mat4Eye(kfEye, i, 0)
    let prj = null
    if (kf.fov != null) {
      const hh = ctx.near * Math.tan(kf.fov * 0.5), hw = hh * ctx.aspect
      prj = mat4Persp(kfPrj, -hw, hw, -hh, hh, ctx.near, 250, ctx.ndcZMin)
    } else if (kf.halfHeight != null) {
      const hh = kf.halfHeight, hw = hh * ctx.aspect
      prj = mat4Ortho(kfPrj, -hw, hw, -hh, hh, ctx.near, 250, ctx.ndcZMin)
    }
    if (!prj) return
    viewFrustum({
      mat4Eye:  kfEye,
      mat4Proj: kfPrj,
      bits:     p5.Tree.NEAR | p5.Tree.FAR,
      viewer:   () => {},
    })
  },
})
```

### samplers

`trackPath` reads the track's path through the zero-alloc samplers exposed by `@nakednous/tree`. The continuous family (`samplePos`, `sampleEye`, `sampleCenter`, `mat4Model`, `mat4Eye`) accepts both cursor and explicit `(seg, t)` forms; tangent samplers (`tangents`, `eyeTangents`, `centerTangents`) are keyframe-indexed. Projection matrices are not a track method — each `CameraTrack` keyframe stores `fov` or `halfHeight` directly on `track.keyframes[i]`, and callers build projections from those scalars with `mat4Persp` / `mat4Ortho`. See the [core README](https://github.com/nakednous/tree#path-sampling).

---

# Handles

A **handle** is a draggable 3D manipulator that reports a value. It is a stateful controller (like a track), created once and driven from `draw()`. Each handle is defined by a **constraint** — how the pointer ray maps to a value — plus an optional **binding** (what the value drives).

```js
let h

function setup() {
  createCanvas(720, 480, WEBGL)
  h = createHandle({ constraint: p5.Tree.PLANE, normal: [0, 0, 1] })
}

function draw() {
  background(10)
  if (!h.update()) orbitControl()   // update() returns grabbed; a grab wins over orbit
  stroke('cyan')
  fill('cyan')
  h.draw()
  const p = h.value()               // current value — fresh p5.Vector, world space
}
```

## Constraints

| `constraint` | DOF | Reports |
|---|---|---|
| `p5.Tree.SPHERE` | 2 | `DIRECTION` (unit) or `POINT` (`dir·radius`) |
| `p5.Tree.PLANE`  | 2 | `POINT` on a fixed plane |
| `p5.Tree.AXIS`   | 1 | scalar `t` + `POINT` on a line |
| `p5.Tree.DIAL`   | 1 | accumulated angle `θ` + `POINT` on a circle or `DIRECTION` (radial unit) |
| `p5.Tree.VIEW`   | 2 | `POINT` on a camera-facing plane |

`SPHERE` is a heading on a sphere — a direction, optionally scaled to a point at `radius`. It solves and reports in world; an eye-relative heading (a headlight, fixed as you orbit) is a read-time conversion — `value({ to: EYE })` — not a separate mode. `PLANE` and `AXIS` are world translate handles — `AXIS` clamps to `extent` and also reports a signed `scalar()`. `DIAL` is the **rotation handle** — see [Rotation](#rotation--dial). `VIEW` is a bridge constraint: a `PLANE` whose normal is re-aimed at the camera each frame, so the point free-translates parallel to the screen at constant depth (three's `DragControls` / a Blender grab); it reports a world position and binds like a `PLANE`.

A fixed `PLANE` is well-conditioned only while it faces the camera — edge-on, a screen pixel maps to a huge step on the plane. `VIEW` sidesteps that by re-aiming every frame; `DIAL` solves it with a tangent fallback.

A **custom** constraint — any object with the core contract (`kind`, `solve`, `value`, `seed`, optional `scalar`/`azEl`) — passes straight in as `constraint:`; supply `drawLocus(h, opts)` (and optionally `pickProxy(h, pos, rad)`) so it has a surface and a grab shape. The controller drives everything else — lifecycle, ray, spaces, bind, hooks, pick, router membership.

## Core math on p5.Tree

The bridge surfaces a slice of the core's math directly on the `p5.Tree` namespace — flat, out-first, zero-alloc functions, never wrapper classes. The criterion: a core symbol is surfaced when **p5 has no adequate native equivalent and a sketch-level consumer exists**; where p5 *has* an adequate type, the bridge maps at seams instead (vec3 → `p5.Vector` via `value()`/`mapLocation`; matrices via the matrix seams).

**Quaternions** — flat `[x, y, z, w]` (w-last, glTF layout): `qSet` `qCopy` `qDot` `qNormalize` `qNegate` `qConjugate` `qMul` `qRotateVec3` `qSlerp` `qNlerp` `qFromUnitVectors` `qFromAxisAngle` `qFromLookDir` `qFromRotMat3x3` `qFromMat4` `qToMat4` `qToAxisAngle`. The explicit form is deliberate — `qMul(out, a, b)` reads as the algebra it implements, and `qToMat4` feeds `applyMatrix(...)` directly. (p5's own `p5.Quat` is `@private` upstream and not a usable surface.)

**Ray primitives + angular utilities** — what a custom constraint's `solve()` is made of: `raySphere` `rayPlane` `rayClosestPointOnAxis` `dirFromAzEl` `azElFromDir`.

**Input conditioning** — the rate-stream helpers a helm feeds on (see the [core README](https://github.com/nakednous/tree#input-conditioning--oneeuro--posedelta)): `oneEuro` (the 1€ filter — assign to `helm.filter`) and `poseDelta` (absolute→rate differencing with the quaternion double-cover guard).

```js
const { qMul, qFromAxisAngle, qToMat4 } = p5.Tree
const q = [0, 0, 0, 1], dq = [0, 0, 0, 1], m = new Array(16)
qFromAxisAngle(dq, 0, 1, 0, 0.02)
qMul(q, dq, q)                 // accumulate — alias-safe, zero-alloc
applyMatrix(...qToMat4(m, q))
```

## createHandle

```js
const h = createHandle({ constraint: p5.Tree.SPHERE, report: p5.Tree.DIRECTION })
```

Returns a stateful controller (like `createCameraTrack`), not a draw call. Create it after `createCanvas` — it attaches pointer listeners to the canvas.

| Option | Default | Description |
|---|---|---|
| `constraint` | — | `SPHERE` \| `PLANE` \| `AXIS` \| `DIAL` \| `VIEW`, or a contract object (required). |
| `report` | per constraint | `POINT` \| `DIRECTION`. |
| `anchor` | `[0,0,0]` | Constraint origin. `p5.Vector` or `[x,y,z]`. |
| `radius` | `1` | `SPHERE` / `DIAL` radius. |
| `axis` | `[1,0,0]` / `[0,1,0]` | `AXIS` direction / `DIAL` plane normal. |
| `normal` | `[0,1,0]` | `PLANE` normal. |
| `zero` | derived | `DIAL` θ=0 reference direction (projected onto the plane). |
| `from` | `WORLD` | Space the symbolic `axis` / `normal` / `zero` resolve from — `WORLD` \| `EYE` \| a mat4 frame. See [Constraint frame — from](#constraint-frame--from). |
| `extent` | — / unbounded | `AXIS` clamp `[min, max]`; `DIAL` θ clamp in radians. |
| `grabPx` | `12` | Pick-proxy radius in pixels (the grab hit area; the `DIAL` torus tube). |
| `snap` | `null` | Quantize step — see [Snap / hover / cancel](#snap--hover--cancel). Settable live. |
| `hover` | `false` | Lone-handle pick-on-move; the router provides hover shared. |
| `enabled` | `true` | Gate grab/solve without disposing. |
| `bind` | — | A `p5.Vector` or `{ get, set }` (a camera needs the chained form — see [bind](#bind)). |
| `drawLocus` / `pickProxy` | — | Custom-kind seams: locus draw / tagged grab geometry. |
| `onGrab` / `onChange` / `onRelease` / `onCancel` | — | Interaction hooks. |

`enabled` and the hooks are also settable on the controller after construction.

## Lifecycle

Call `update()` **first** in `draw()`. It resolves the grab and re-solves from the pointer, and returns whether the handle is grabbed — so a press that lands on the handle wins, and one that misses falls through to `orbitControl()`:

```js
function draw() {
  background(10)
  if (!h.update()) orbitControl()
  // ... scene ...
  h.draw()
}
```

A press color-ID picks a proxy at the handle's screen position (via `mousePick`), so only a hit grabs — the dot for most kinds, a torus along the ring for a `DIAL`. `onGrab` fires on the grab, `onChange` on each solve while held (post-snap), `onRelease` on release — and `onCancel` *instead of* `onRelease` when the drag is reverted (firing order mirrors `Track`: your hook, then the lib-space `_on*`). `h.dispose()` removes the listeners; it runs automatically on sketch teardown.

```js
h.grabbed()          // true between grab and release
h.hovered()          // true while the pointer rests on the proxy (opt-in / router-fed)
h.cancel()           // revert the drag in flight (Esc and pointercancel do this too)
h.enabled = false    // suspend without disposing
h.anchor([x, y, z])  // move the reference point (chainable)
```

## value

Pull the current value. Mirrors `mapLocation`: `out` is opt-in (a fresh `p5.Vector` when omitted, zero-alloc when supplied), and the default `to` is `WORLD` — so `h.value()` reads clean; pass `to: EYE` (or any space) to convert at read time.

```js
h.value()                                   // world (the default)
h.value({ to: p5.Tree.EYE })                // any space: WORLD, EYE, SCREEN, NDC, MODEL
h.value({ to: objectMat4 })                 // a model matrix → that object's local coordinates
h.value({ report: p5.Tree.POINT })          // override POINT / DIRECTION for this read
h.value({ out: buf })                       // zero-alloc into a Float32Array | p5.Vector
```

`DIRECTION` routes through `mapDirection`, `POINT` through `mapLocation`, so `to` accepts everything those do — the space constants or a raw mat4 for a custom frame (see [Coordinate space conversions](#coordinate-space-conversions)) — plus the same `mat4Eye` / `mat4Proj` / `mat4View` / `mat4PV` overrides, to resolve against a supplied camera instead of live state.

```js
h.scalar()       // AXIS — current signed t · DIAL — accumulated θ in radians (multi-turn)
h.azEl(out2?)    // SPHERE — [az, el] for readouts / the dial
```

## bind

A handle can drive a target while dragging. `bind` is polymorphic, with an accessor floor:

```js
h.bind(vec)                  // p5.Vector — mutated in place
h.bind(cam, 'eye')           // p5.Camera lookat field: 'eye' | 'center' | 'up'
h.bind({ get, set })         // accessor floor — get() → value, set(value) writes
```

`get()` seeds the constraint on bind (the handle starts at the target), each solve while held calls `set(value)` and fires `onChange`, and `sync()` re-seeds after the target changes externally. Values cross in `WORLD` (the `value()` default). An unrecognised target logs and leaves the handle pull-only.

```js
h.onChange = (value, h) => { /* reactive readout */ }
h.sync()                     // re-read the target after an external change
```

When binding a `p5.Camera` field, drive a camera you are **not** looking through — binding a field of the active camera feeds the view back into the handle that derives from it (true for `eye` and `center` alike). Driving a secondary camera (shown as a `viewFrustum`) is the stable pattern.

## Rotation — DIAL

```js
const h = createHandle({
  constraint: p5.Tree.DIAL,
  axis:   [0, 1, 0],          // dial-plane normal; θ winds right-handed about it
  zero:   [1, 0, 0],          // where θ = 0 points (derived from the axis if omitted)
  radius: 150,
})
// draw(): rotateY(h.scalar())   — the accumulated angle, in radians
```

A `DIAL` is a 1-DOF angle on a circle — the rotate-gizmo ring. Grab **anywhere on the ring** (the pick proxy is a torus along it, tube = `grabPx`), drag around it, and `scalar()` reports the **accumulated** θ: keep going past a full turn and it counts 360°, 720°, … (clamp with `extent`, in radians — unbounded by default). `value()` is the point on the circle (`POINT`, the default — so binding a vector tracks the ring point, handy for aim targets) or the radial unit (`DIRECTION`).

Viewed edge-on — the ring seen as a line, where naive rotate gizmos teleport — the solve switches to the circle's tangent line, so the drag stays bounded and monotone at any incidence.

An arcball is deliberately **not** a kind — it composes from `SPHERE` deltas in a dozen sketch lines, using the `qFromUnitVectors` / `qMul` accumulate idiom from [Core math on p5.Tree](#core-math-on-p5tree).

## Constraint frame — from

The basis opts are symbolic — `axis: [0, 1, 0]` means "Y, but whose Y?". `from`
names the space they resolve from (it is `mapDirection`'s `from`, deferred):
`p5.Tree.WORLD` (the default — a from-less handle, today's behaviour),
`p5.Tree.EYE` (the camera's basis), or any mat4 frame (another object's basis).

```js
createHandle({ constraint: p5.Tree.DIAL, radius: 80, from: p5.Tree.EYE })          // screen-space rotation ring
createHandle({ constraint: p5.Tree.AXIS, axis: [1, 0, 0], from: p5.Tree.EYE })     // screen-horizontal rail
createHandle({ constraint: p5.Tree.DIAL, axis: [0, 1, 0], from: frameM })          // hinge on another object's axis
```

One authoring caveat: an `AXIS` nearly parallel to the view ray (`axis:
[0, 0, 1], from: EYE` — a "dolly") is foreshortened to a single screen point
and the drag solve degenerates — a draggable rail should live roughly in the
screen plane; depth input belongs to the wheel.

Resolution happens at the **press**: one `mapDirection` per vector, then the
drag solves against that frozen world basis — well-posed even while the camera
moves. While idle the basis refreshes every frame, so the locus and the grab
proxy track a turning frame live. Directions only — the anchor stays a world
location (move it with `anchor()` when the frame carries the origin too).

`from` applies to `PLANE` / `AXIS` / `DIAL`, and to custom kinds exposing the
optional `aim()` contract member. `SPHERE` has no basis and rejects it. `VIEW`
is *deliberately* not `PLANE` + `from: EYE`: `VIEW` re-aims its plane
continuously mid-drag (the standard screen-parallel translate), while
`from: EYE` freezes the plane at the press — two distinct, both useful,
semantics.

## Snap / hover / cancel

**Snap** quantizes at the solve seam — the binding and `onChange` only ever see snapped values, and the state IS the snapped state (no release drift). `snap` is a step: angular (radians) for `SPHERE` az/el and `DIAL` θ; a world grid (`number` uniform or `[x,y,z]`) for `PLANE` / `AXIS` / `VIEW` (`PLANE` re-projects, so an off-plane grid lands on the nearest on-plane point). It's settable live — the Blender Ctrl convention is two lines:

```js
h.snap = keyIsDown(CONTROL) ? 25 : null          // grid, world units
dial.snap = keyIsDown(CONTROL) ? PI / 12 : null  // 15°
```

**Hover** is a state, not a style: `hovered()` reads true while the pointer rests on the proxy, and the sketch styles it (set `stroke()` before `draw()` — same philosophy as `grabbed()`). Routed handles get it free from the router's shared pick; a lone handle opts in with `hover: true` (one 1×1 readback per frame with pointer motion).

**Cancel** reverts the drag in flight to its grab-time value — exact θ winding included — restores the binding, and fires `onCancel` (`onRelease` does **not** fire). Esc and `pointercancel` trigger it; `h.cancel()` does it programmatically. The commit-on-release undo pattern composes cleanly: capture in `onGrab`, push in `onRelease`, drop in `onCancel`.

## Overlapping handles — createPointerRouter

Independent, separated handles need no coordination — a plain loop runs them, one finger each. **Overlapping** handles (a clustered TRS gizmo: axes + a dial + a `VIEW` stacked at one origin) break per-handle picking — two proxies under one press each see only themselves and both grab. The router replaces N self-picks with **one depth-resolved pick** across all member proxies: every proxy renders with its own id, the nearest wins, exactly one handle grabs.

```js
const r = createPointerRouter(hx, hy, hz, dial, view)   // hover on by default

function draw() {
  background(10)
  if (!r.update()) orbitControl()    // in place of the members' own updates
  // style the hovered member, draw all
}
```

`r.update()` resolves every queued press (several same-frame presses on different members all land), refreshes shared hover (one extra pick per moved frame; `{ hover: false }` opts out), then delegates to each member's `update()`, returning whether any is grabbed. `r.hovered()` is the member under the pointer; `add(h)` / `remove(h)` re-route live; `dispose()` releases everything (and runs on sketch teardown). Unclaimed pointers fall through to the camera gesture — on a touch surface each member still tracks its own finger, so two fingers drive two cluster members concurrently while a third orbits. The library's own routed cluster is a track's [keyframe handles](#keyframe-handles--trackhandles) — one member per draggable keyframe field.

## Draw

```js
h.draw()                                       // default HANDLE | AIM | LOCUS
h.draw({ bits: p5.Tree.HANDLE })               // dot only
h.draw({ bits: p5.Tree.HANDLE | p5.Tree.RING, size: 10 })
h.draw({ marker: null })                       // suppress entirely (parity with trackPath)
```

| Bit | Effect |
|---|---|
| `p5.Tree.HANDLE` | The draggable dot at the handle's point (constant screen size). |
| `p5.Tree.AIM` | A line from the anchor to the point (a `DIAL`'s radial spoke). |
| `p5.Tree.LOCUS` | The constraint surface: `SPHERE` wire / `PLANE` quad / `AXIS` segment / `DIAL` ring / `VIEW` square — or a custom kind's `drawLocus`. |
| `p5.Tree.RING` | `SPHERE` view-facing limb / `PLANE` border. |

Draws at the ambient p5 state, like every gizmo: `stroke()` colours the stroked parts (AIM / LOCUS / RING), `fill()` the dot (HANDLE) — set both for a one-colour handle, or split the call to colour parts independently (the `axes` / `trackPath` idiom). The dot draws at a constant screen size via `pixelRatio`; `size` (dot radius) and `grabPx` are pixels. Default bits: `HANDLE | AIM | LOCUS`.

## Diagnostics

Runtime issues log via `console.error('[p5.tree] …')` and degrade gracefully:

- An invalid `constraint` → `createHandle` returns `null`.
- An unrecognised `bind` target → left pull-only.
- A custom kind without `drawLocus` → dot + aim only, one warning.

---

# Helm

A **helm** drives a camera or an object from a live 6-DOF rate stream — a SpaceNavigator, a tracked hand, an agent policy. It is the rate-stream sibling of the Track family: a stateful controller (created once, driven from `draw()`) that integrates the stream into a `{ pos, rot }` pose and applies it via `applyPose`. The core integrator is `@nakednous/tree`'s `PoseHelm`; this bridge adds the transport seam, the camera basis, the draw-loop player, the `helmRig` gizmo, and the `createPanel(helm)` profile editor.

```js
const helm = createCameraHelm()   // fly the current camera (body-relative)
const helm = createPoseHelm()     // produce a pose; bind() a target to drive it
```

## createCameraHelm / createPoseHelm

**`createCameraHelm([cam])`** flies a camera from the stream. It is always **body-relative** — a forward push flies forward — because the helm integrates in the driven camera's own frame; there is no `from` to choose. The camera is seeded from its current lookat (frame 0 is continuous) and re-driven every frame.

```js
let helm

function setup() {
  createCanvas(720, 480, WEBGL)
  helm = createCameraHelm()              // or createCameraHelm(getCamera())
}

function draw() {
  background(10)
  helm.feed(translation, rotation)       // a transport feeds raw device rates
  grid(); axes()
  helmRig(helm, { x: width - 136, y: 16, size: 120 })   // optional corner readout
}
```

**`createPoseHelm({ from })`** produces a pose and drives a bound target. `from` sets what manipulation is relative to:

| `from`          | manipulation is relative to                              |
|-----------------|----------------------------------------------------------|
| `p5.Tree.EYE`   | the **viewing** camera — screen-relative (the default)   |
| `p5.Tree.WORLD` | fixed world axes                                         |
| `p5.Tree.SELF`  | the target's own evolving pose — body-relative           |
| a `mat4`        | an explicit fixed frame (e.g. `cam.mat4Eye(buf)`)        |

`SELF` is the object analogue of camera body-fly — a push follows where the object currently points. A camera helm has no `from`; for screen- or world-relative *camera* motion, bind a camera to a `createPoseHelm` instead.

```js
const obj = { pos: [0, 0, 0], rot: [0, 0, 0, 1] }
let helm

function setup() {
  createCanvas(720, 480, WEBGL)
  helm = createPoseHelm({ from: p5.Tree.EYE }).bind(obj)
}

function draw() {
  background(10)
  helm.feed(translation, rotation)
  push(); applyPose(obj); box(80); pop()
}
```

Both factories expose the core surface (`feed`, `profile`, `deadzone`, `filter`, `fullScale`, `from`, `home`, `eval`, `activity` — see the [core README](https://github.com/nakednous/tree#posehelm--6-dof-rate-driven-pose)) plus `dispose()` (unregisters the player; runs on sketch teardown). The pose factory adds `bind`. Tune the profile live with [`createPanel(helm)`](#helm-panel).

For a noisy or absolute source, set `helm.filter = oneEuro(...)` — an input conditioner applied before the deadzone (filter → deadzone) — and `helm.fullScale` to the transport's raw full-deflection so the rig and panel meters read honestly. `poseDelta` turns an absolute pose stream into the rate `feed` wants. Both `oneEuro` and `poseDelta` live on `p5.Tree` (see [Core math on p5.Tree](#core-math-on-p5tree)).

## Transport — feed

The transport is the seam that makes a helm source-agnostic: anything that calls `helm.feed(translation, rotation)` drives it. The two halves may arrive on separate frames (a device reports them separately) and persist until the next feed — so a transport feeds zeros when motion should stop.

```js
// WebHID SpaceNavigator (sketch-level — device drivers ship as examples)
helm.feed([tx, ty, tz], [rx, ry, rz])   // raw lane rates; the profile's sens scales them

// a tracked hand differenced frame-to-frame is a 6-DOF rate — the SAME helm:
const h = handTracker.read()
if (h.present) helm.feed(h.linVel, h.angVel)
else           helm.feed([0, 0, 0], [0, 0, 0])
```

The library wiring is identical across transports — only the source of the rates differs.

## Bind a target

`createPoseHelm` drives a bound target while running. `bind` is polymorphic (dispatch by shape), seeding the integrated pose from the target where one is readable so frame 0 doesn't jump:

```js
helm.bind(cam)             // p5.Camera — seeded from its lookat, driven via applyPose
helm.bind({ get, set })    // accessor floor — get() seeds, set(pose) writes
helm.bind({ applyPose })   // any pose sink — applyPose(pose) each frame (nothing to seed from)
helm.bind({ pos, rot })    // plain pose object — seeded from, mutated in place
```

Chainable: `createPoseHelm().bind(obj)`. `opts.bind` binds at construction. An unrecognised target logs and leaves the helm unbound.

## helmRig

Visualise a helm's DOF profile and live activity as a control rig — three translation arrows (Tx / Ty / Tz) and three rotation rings (pitch / yaw / roll). Each channel draws a **dim baseline** whose geometry is the profile readout (arrow direction = `sign`, length / radius = `sens`), and the channel driven this frame overlays a **bright signed** element growing in the live push/pull direction, in its semantic axis colour (X red, Y lime, Z blue). Push a physical axis and watch which DOF moves and which way — the lane→DOF mapping read by doing.

```js
helmRig(helm, { size, bits, identify })   // in-scene rig
helmRig(helm, { x, y, size, tilt })       // FBO-backed HUD overload (camera fly)
```

**In-scene** — drawn at the current model transform, oriented to the helm's resolved `from` so the arrows point where pushes go. The caller supplies position (`translate` to the driven object); the rig owns the rotation, so do **not** `applyPose` the object before it. Colours are intrinsic (they carry the active-DOF signal), so ambient `stroke()` does not tint it.

| Option     | Default               | Description                                                     |
|------------|-----------------------|-----------------------------------------------------------------|
| `size`     | `120`                 | Rig extent (world units in-scene; pixels in the HUD overload).  |
| `bits`     | `TRANSLATE \| ROTATE` | Clusters to draw — `p5.Tree.TRANSLATE`, `p5.Tree.ROTATE`.       |
| `identify` | `false`               | Label each arrow / ring with its input lane (`L0` …). Needs a font. |

**HUD overload** — when `x` and `y` are given, the rig renders into a small framebuffer through its own camera and composites as a screen quad at `(x, y)` of `size` pixels. Because it lands as a texture, ambient `tint()` modulates it (handy to fade the HUD until a device connects). Intended for camera fly — the body DOFs in a corner.

`tilt` aims the HUD camera: its **elevation** above the rig's horizontal, in the sketch's `angleMode` unit (radians by default in p5 v2; `30` under `angleMode(DEGREES)`). Azimuth is fixed at the isometric 45° so one number controls the look — X and Z stay symmetric and all three axes read. The default is true isometric (≈35.26°); `tilt: 0` is level / head-on (the Z arrow and roll ring go edge-on), `tilt: [az, el]` sets both. Placement (`x, y`) and angle (`tilt`) are independent — sliding the corner never changes the foreshortening. The framebuffer is cached on the helm and rebuilt only when `size` changes; `tilt` only re-aims.

```js
helmRig(helm, { x: width - 136, y: 16, size: 120 })            // corner HUD, iso
helmRig(helm, { x: width - 136, y: 16, size: 120, tilt: 0 })   // head-on
helmRig(helm, { size: 120 })                                   // in-scene at the model transform
```

---

# Releases

Latest:

* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js)
* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.min.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.min.js)
* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.esm.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.esm.js)
* [https://www.npmjs.com/package/p5.tree](https://www.npmjs.com/package/p5.tree)

Tagged:

* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.51/dist/p5.tree.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.51/dist/p5.tree.js)
* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.51/dist/p5.tree.min.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.51/dist/p5.tree.min.js)
* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.51/dist/p5.tree.esm.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.51/dist/p5.tree.esm.js)

---

# Usage

## CDN

```html
<script src="https://cdn.jsdelivr.net/npm/p5/lib/p5.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js"></script>

<script>
  function setup() {
    createCanvas(600, 400, WEBGL)
    axes()
  }

  function draw() {
    background(0.15)
    orbitControl()
  }
</script>
```

Works in global and instance mode.

## npm (ESM)

```bash
npm i p5 p5.tree
```

```js
import p5 from 'p5'
import 'p5.tree'

const sketch = p => {
  p.setup = () => {
    p.createCanvas(600, 400, p.WEBGL)
    p.axes()
  }

  p.draw = () => {
    p.background(0.15)
    p.orbitControl()
  }
}

new p5(sketch)
```
