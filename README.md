# p5.tree

[![npm version](https://img.shields.io/npm/v/p5.tree?color=1f6feb)](https://www.npmjs.com/package/p5.tree)

Render pipeline for [p5.js v2](https://beta.p5js.org/) — [pose and camera interpolation](https://en.wikipedia.org/wiki/Key_frame), [space transforms](https://wikis.khronos.org/opengl/Rendering_Pipeline_Overview), [frustum visibility](https://en.wikipedia.org/wiki/Hidden-surface_determination), [HUD](https://en.wikipedia.org/wiki/Head-up_display), [post-processing pipe](https://en.wikipedia.org/wiki/Video_post-processing#Uses_in_3D_rendering), [picking](https://webglfundamentals.org/webgl/lessons/webgl-picking.html), and [declarative control panels](https://github.com/dataarts/dat.gui).

![A non-Euclidean geometry cube with faces showcasing teapot, bunny, and Buddha models.](p5.tree.png)

-   [Tracks](#tracks)
    -   [PoseTrack --- object animation](#posetrack--object-animation)
    -   [CameraTrack --- camera keyframe paths](#cameratrack--camera-keyframe-paths)
    -   [Playback options](#playback-options)
    -   [Camera helpers](#camera-helpers)
-   [Space transformations](#space-transformations)
    -   [Matrix operations](#matrix-operations)
    -   [Frustum queries](#frustum-queries)
    -   [Coordinate space conversions](#coordinate-space-conversions)
    -   [Heads Up Display](#heads-up-display)
-   [Panels](#panels)
    -   [Parameter panel](#parameter-panel)
    -   [Track transport panel](#track-transport-panel)
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
    -   [createHandle](#createhandle)
    -   [Lifecycle](#lifecycle)
    -   [value](#value)
    -   [bind](#bind)
    -   [Draw](#draw)
    -   [Diagnostics](#diagnostics)
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
p5.Tree.VERSION   // '0.0.45'
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

Default bits: `PATH`.

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

Runnable examples covering every constraint, world/eye readout via `value({ to })`, the draw bits, and all three `bind` forms live in [`handle-examples/`](handle-examples/); the HCI probes that gate the design (dial vs arcball, edge-on, cluster arbitration, multitouch, snap) live in [`handle-experiments/`](handle-experiments/).

## Constraints

| `constraint` | DOF | Reports |
|---|---|---|
| `p5.Tree.SPHERE` | 2 | `DIRECTION` (unit) or `POINT` (`dir·radius`) |
| `p5.Tree.PLANE`  | 2 | `POINT` on a fixed plane |
| `p5.Tree.AXIS`   | 1 | scalar `t` + `POINT` on a line |
| `p5.Tree.DIAL`   | 1 | accumulated angle `θ` + `POINT` on a circle or `DIRECTION` (radial unit) |
| `p5.Tree.VIEW`   | 2 | `POINT` on a camera-facing plane |

`SPHERE` is a heading on a sphere — a direction, optionally scaled to a point at `radius`. It solves and reports in world; an eye-relative heading (a headlight, fixed as you orbit) is a read-time conversion — `value({ to: EYE })` — not a separate mode (see example 08). `PLANE` and `AXIS` are world translate handles — `AXIS` clamps to `extent` and also reports a signed `scalar()`. `DIAL` is the **rotation handle** — see [Rotation](#rotation--dial). `VIEW` is a bridge constraint: a `PLANE` whose normal is re-aimed at the camera each frame, so the point free-translates parallel to the screen at constant depth (three's `DragControls` / a Blender grab); it reports a world position and binds like a `PLANE`.

A fixed `PLANE` is well-conditioned only while it faces the camera — edge-on, a screen pixel maps to a huge step on the plane. `VIEW` sidesteps that by re-aiming every frame; `DIAL` solves it with a tangent fallback.

A **custom** constraint — any object with the core contract (`kind`, `solve`, `value`, `seed`, optional `scalar`/`azEl`) — passes straight in as `constraint:`; supply `drawLocus(h, opts)` (and optionally `pickProxy(h, pos, rad)`) so it has a surface and a grab shape. The controller drives everything else — lifecycle, ray, spaces, bind, hooks, pick, router membership. Example [`10-custom-helix`](handle-examples/10-custom-helix.html) is the contract end to end: a screw constraint in ~70 lines plus a 12-line coil.

## Core math on p5.Tree

The bridge surfaces a slice of the core's math directly on the `p5.Tree` namespace — flat, out-first, zero-alloc functions, never wrapper classes. The criterion: a core symbol is surfaced when **p5 has no adequate native equivalent and a sketch-level consumer exists**; where p5 *has* an adequate type, the bridge maps at seams instead (vec3 → `p5.Vector` via `value()`/`mapLocation`; matrices via the matrix seams).

**Quaternions** — flat `[x, y, z, w]` (w-last, glTF layout): `qSet` `qCopy` `qDot` `qNormalize` `qNegate` `qConjugate` `qMul` `qRotateVec3` `qSlerp` `qNlerp` `qFromUnitVectors` `qFromAxisAngle` `qFromLookDir` `qFromRotMat3x3` `qFromMat4` `qToMat4` `qToAxisAngle`. The explicit form is deliberate — `qMul(out, a, b)` reads as the algebra a notebook chapter states above it, and `qToMat4` feeds `applyMatrix(...)` directly. (p5's own `p5.Quat` is `@private` upstream and not a usable surface.)

**Ray primitives + angular utilities** — what a custom constraint's `solve()` is made of: `raySphere` `rayPlane` `rayClosestPointOnAxis` `dirFromAzEl` `azElFromDir`.

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

Viewed edge-on — the ring seen as a line, where naive rotate gizmos teleport — the solve switches to the circle's tangent line, so the drag stays bounded and monotone at any incidence. Example [`09-dial-angle`](handle-examples/09-dial-angle.html) is the anatomy; [`handle-experiments/e2`](handle-experiments/e2-edge-on-dial.html) is the torture test.

An arcball is deliberately **not** a kind — it composes from `SPHERE` deltas in a dozen sketch lines ([`handle-experiments/e1`](handle-experiments/e1-dial-vs-arcball.html)).

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

`r.update()` resolves every queued press (several same-frame presses on different members all land), refreshes shared hover (one extra pick per moved frame; `{ hover: false }` opts out), then delegates to each member's `update()`, returning whether any is grabbed. `r.hovered()` is the member under the pointer; `add(h)` / `remove(h)` re-route live; `dispose()` releases everything (and runs on sketch teardown). Unclaimed pointers fall through to the camera gesture — on a touch surface each member still tracks its own finger, so two fingers drive two cluster members concurrently while a third orbits ([`handle-experiments/e4`](handle-experiments/e4-tabletop-multitouch.html)).

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

# Releases

Latest:

* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js)
* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.min.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.min.js)
* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.esm.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.esm.js)
* [https://www.npmjs.com/package/p5.tree](https://www.npmjs.com/package/p5.tree)

Tagged:

* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.45/dist/p5.tree.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.45/dist/p5.tree.js)
* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.45/dist/p5.tree.min.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.45/dist/p5.tree.min.js)
* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.45/dist/p5.tree.esm.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.45/dist/p5.tree.esm.js)

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
