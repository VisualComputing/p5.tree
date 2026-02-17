# p5.tree

[![npm version](https://img.shields.io/npm/v/p5.tree?color=1f6feb)](https://www.npmjs.com/package/p5.tree)

Shader development, camera keyframe interpolation, space transformations, and uniform UI controls for 3D rendering in [p5.js v2](https://beta.p5js.org/) ([WEBGL](https://beta.p5js.org/reference/p5/constants/webgl/) / [WEBGL2](https://beta.p5js.org/reference/p5/constants/webgl2/) / [WebGPU](https://beta.p5js.org/reference/p5/constants/webgpu/)).

![A non-Euclidean geometry cube with faces showcasing teapot, bunny, and Buddha models.](p5.tree.png)

* [Keyframes interpolation](#keyframes-interpolation)
  * [Recording keyframes](#recording-keyframes)
  * [Playback](#playback)
  * [Seek, stop, reset](#seek-stop-reset)
* [Space transformations](#space-transformations)
  * [Matrix operations](#matrix-operations)
  * [Matrix queries](#matrix-queries)
  * [Frustum queries](#frustum-queries)
  * [Coordinate space conversions](#coordinate-space-conversions)
  * [Heads Up Display](#heads-up-display)
* [Uniform UI](#uniform-ui)
  * [Creating a UI](#creating-a-ui)
  * [Accessing values](#accessing-values)
  * [Applying to shaders](#applying-to-shaders)
  * [Default panel](#default-panel)
* [Post-processing](#post-processing)
  * [pipe](#pipe)
  * [releasePipe](#releasepipe)
* [Utilities](#utilities)
* [Drawing stuff](#drawing-stuff)
* [Releases](#releases)
* [Usage](#usage)
  * [CDN](#cdn)
  * [npm (ESM)](#npm-esm)

---

In `p5.tree`, matrix queries are **immutable** and cache-friendly: they never modify their arguments and always return new `p5.Matrix` instances.

```js
let matrix = createMatrix(4)
let i = iMatrix(matrix)
// i !== matrix
```

Most functions are available both as **p5 helpers** (global-style) and as **renderer methods** (`p5.RendererGL`).
Camera path methods live on `p5.Camera` and are also exposed as `p5` helpers that forward to the active camera.

Parameters may be provided in any order unless specified otherwise.
When a function accepts a configuration/options object, it is always the **last** parameter.

---

# Keyframes interpolation

A minimal camera-path API built on `p5.Camera.copy()` snapshots and `p5.Camera.slerp()` interpolation.

The path lives in user space as `camera.path` (an array of `p5.Camera` snapshots). You record keyframes, then play the path with a chosen speed and duration.

## Recording keyframes

`camera.addPath(...)` appends a keyframe (camera snapshot) to `camera.path`.

**Overloads**

1. `camera.addPath(eye, center, up, [opts])`
2. `camera.addPath(view, [opts])`
3. `camera.addPath([camera0, camera1, ...], [opts])`
4. `camera.addPath([view0, view1, ...], [opts])`
5. `camera.addPath([opts])`

**Notes**

* In **(1)**, `up` is **mandatory** (no default assumed).
* In **(2)**, `view` is a `p5.Matrix(4)` or raw `mat4[16]` representing a world → camera transform.
* **(3)** appends copies of existing camera snapshots.
* **(4)** appends copies of existing view matrices.
* **(5)** records the current camera state at call time.

Where:

* `eye`, `center`, `up` → `p5.Vector` or `[x, y, z]`
* `view` → `p5.Matrix(4)` or raw `mat4[16]`
* `opts.reset` (default `false`) clears the path before appending

**Example**

```js
let cam

function setup() {
  createCanvas(600, 400, WEBGL)
  cam = createCamera()

  cam.addPath([400, 0, 0], [0, 0, 0], [0, 1, 0])
  cam.addPath(cam)
  cam.addPath(cam.cameraMatrix)
}
```

**p5 wrappers**

`addPath(...)` is also available as a `p5` helper:

```js
function setup() {
  createCanvas(600, 400, WEBGL)

  addPath([400, 0, 0], [0, 0, 0], [0, 1, 0])
}
```

## Playback

Start or update playback with:

```js
camera.playPath(rate)
camera.playPath({ duration, loop, pingPong, onEnd, rate })
```

Options:

* `duration` → frames per segment (default `30`)
* `loop` → wrap at ends (default `false`)
* `pingPong` → bounce at ends (default `false`)
* `rate` → speed multiplier (default `1`)
* `onEnd` → callback when playback finishes (non-looping)

If both `loop` and `pingPong` are `true`, `pingPong` takes precedence.

```js
function setup() {
  createCanvas(600, 400, WEBGL)

  addPath([400, 0, 0], [0, 0, 0], [0, 1, 0], { reset: true })
  playPath({ duration: 45, loop: true })
}
```

> Projection safety: `p5.Camera.slerp()` requires identical projection matrices across keyframes.
> `p5.tree` checks compatibility while recording.

## Seek, stop, reset

```js
camera.seekPath(t)   // t ∈ [0, 1]
camera.stopPath()
camera.resetPath()
```

Global helpers (`seekPath`, `stopPath`, `resetPath`) forward to the active camera.

---

# Space transformations

Matrix operations, matrix/frustum queries, and coordinate conversions.

## Matrix operations

1. `createMatrix(...args)`: Explicit wrapper around `new p5.Matrix(...args)` (identity creation).
2. `tMatrix(matrix)`: Returns the transpose of `matrix`.
3. `iMatrix(matrix)`: Returns the inverse of `matrix`.
4. `axbMatrix(a, b)`: Returns the product of the `a` and `b` matrices.

**Observation:** all returned matrices are `p5.Matrix` instances.

## Matrix queries

1. `pMatrix()`: Returns the current projection matrix.
2. `mvMatrix([{ [vMatrix], [mMatrix] }])`: Returns the modelview matrix.
3. `mMatrix()`: Returns the model matrix (local → world), defined by `translate/rotate/scale` and the current `push/pop` stack.
4. `eMatrix()`: Returns the current eye matrix (inverse of `vMatrix()`). Also available on `p5.Camera`.
5. `vMatrix()`: Returns the view matrix (inverse of `eMatrix()`). Also available on `p5.Camera`.
6. `pvMatrix([{ [pMatrix], [vMatrix] }])`: Returns projection × view.
7. `ipvMatrix([{ [pMatrix], [vMatrix], [pvMatrix] }])`: Returns `(pvMatrix)⁻¹`.
8. `lMatrix([{ [from = createMatrix(4)], [to = this.eMatrix()], [matrix] }])`: Returns the 4×4 matrix that transforms **locations** (points) from `from` to `to`.
9. `dMatrix([{ [from = createMatrix(4)], [to = this.eMatrix()], [matrix] }])`: Returns the 3×3 matrix that transforms **directions** (vectors) from `from` to `to` (rotational part only).
10. `nMatrix([{ [vMatrix], [mMatrix], [mvMatrix] }])`: Returns the normal matrix.

**Observations**

1. All returned matrices are `p5.Matrix` instances.
2. Default values (`pMatrix`, `vMatrix`, `pvMatrix`, `eMatrix`, `mMatrix`, `mvMatrix`) are those defined by the renderer at the moment the query is issued.

## Frustum queries

1. `lPlane()`, `rPlane()`, `bPlane()`, `tPlane()`
2. `nPlane()`, `fPlane()`
3. `fov()`: vertical field-of-view (radians).
4. `hfov()`: horizontal field-of-view (radians).
5. `isOrtho()`: `true` for orthographic, `false` for perspective.

## Coordinate space conversions

1. `mapLocation(point = p5.Tree.ORIGIN, [{ [from = p5.Tree.EYE], [to = p5.Tree.WORLD], [pMatrix], [vMatrix], [eMatrix], [pvMatrix], [ipvMatrix] }])`
2. `mapDirection(vector = p5.Tree._k, [{ [from = p5.Tree.EYE], [to = p5.Tree.WORLD], [vMatrix], [eMatrix], [pMatrix] }])`

Pass matrix parameters when you have **cached** those matrices (see [Matrix queries](#matrix-queries)) to speed up repeated conversions:

```js
let cachedPVI

function draw() {
  cachedPVI = ipvMatrix() // compute once per frame

  // many fast conversions using the cached matrix
  const a = mapLocation([0, 0, 0], { from: p5.Tree.WORLD, to: p5.Tree.SCREEN, ipvMatrix: cachedPVI })
  const b = mapLocation([100, 0, 0], { from: p5.Tree.WORLD, to: p5.Tree.SCREEN, ipvMatrix: cachedPVI })
  // ...
}
```

You can also convert between **local spaces** by passing a `p5.Matrix` as `from` / `to`:

```js
let modelMatrix

function draw() {
  background(0)

  push()
  translate(80, 0, 0)
  rotateY(frameCount * 0.01)
  modelMatrix = mMatrix()
  box(40)
  pop()

  // screen projection of the model origin
  const s = mapLocation(p5.Tree.ORIGIN, { from: modelMatrix, to: p5.Tree.SCREEN })
  beginHUD()
  bullsEye({ x: s.x, y: s.y, size: 30 })
  endHUD()
}
```

**Observations**

1. Returned vectors are `p5.Vector` instances.
2. `from` and `to` may be matrices or any of: `p5.Tree.WORLD`, `p5.Tree.EYE`, `p5.Tree.SCREEN`, `p5.Tree.NDC`, `p5.Tree.MODEL`.
3. When no matrix params are passed, current renderer values are used.
4. The default `mapLocation()` call (i.e. eye → world at origin) returns the camera world position.
5. The default `mapDirection()` call returns the normalized camera viewing direction.
6. Useful vector constants: `p5.Tree.ORIGIN`, `p5.Tree._k`, `p5.Tree.i`, `p5.Tree.j`, `p5.Tree.k`, `p5.Tree._i`, `p5.Tree._j`.

## Heads Up Display

Draw directly in **screen space**, independent of the current camera and 3D transforms.

* `beginHUD()` — enter HUD mode.
* `endHUD()` — restore normal 3D rendering.

In HUD mode, coordinates follow standard 2D conventions:
`(x, y) ∈ [0, width] × [0, height]`, with origin at the **top-left corner** and y increasing **downward**. Rendering behavior matches `image()` and other 2D drawing functions.

Typical use cases include overlays, labels, debug markers, and screen-aligned UI elements.

```js
beginHUD()
text('FPS: ' + frameRate().toFixed(1), 10, 20)
endHUD()
```

---

# Uniform UI

A lightweight, renderer-agnostic system for managing shader uniforms and optional UI controls.

Separates:

* Core uniform logic (`createUniformUI`)
* Optional panel rendering (`ui.show()`)

Compatible with:

* `createFilterShader` (GLSL)
* WebGPU shaders
* `p5.strands`

## Creating a UI

```js
const ui = createUniformUI({
  blurIntensity: { min: 0, max: 4, value: 2, step: 0.1 },
  useLighting:   { value: true },
  tintColor:     { value: '#ff8844' }
})
```

Type inference:

* number → float slider
* boolean → checkbox
* color string → color picker
* array length 2/3/4 → vec2/3/4
* `options` → select
* `onClick` → button

Explicit override:

```js
{ type: 'int', min: 0, max: 10 }
```

## Accessing values

```js
ui.blurIntensity.value()
ui.blurIntensity.set(3)
ui.blurIntensity.reset()

const values = ui.values()
```

## Applying to shaders

```js
ui.applyTo(shader)
```

Optional remapping:

```js
ui.applyTo(shader, {
  blurIntensity: 'uBlur',
  tintColor: {
    uniform: 'uColor',
    value: v => v.slice(0, 3)
  }
})
```

For `p5.strands`, bind explicitly inside `.modify()`:

```js
const blurIntensity = uniformFloat(() => ui.blurIntensity.value())
```

No automatic `applyTo()` exists for strands.

## Default panel

```js
ui.show({ x: 10, y: 10, width: 140 })
ui.hide()
ui.remove()
ui.config({ x: 20, y: 20, width: 160, offset: 8 })
```

You can mount the UI into a specific container (useful for Vue / Slidev / component setups):

```js
const ui = createUniformUI(schema, {
  parent: document.getElementById('sketch'),
  x: 10,
  y: 10
})
```

When `parent` is provided, `createUniformUI` ensures the container has a proper positioning context so `x/y` anchoring behaves predictably.

Labels:

* omitted → uniform key
* `label: false` → no label
* `label: 'Custom'` → custom text

---

# Post-processing

A lightweight multi-pass post-processing pipeline for `p5.Framebuffer`, `p5.strands`, and standard WebGL rendering.

`pipe()` lets you chain one or more filter shaders (or strand-based filters), optionally display the result, and reuse internal ping/pong framebuffers efficiently.

Framebuffers are **lazily allocated and cached**, and automatically released when the sketch is removed.

## `pipe`

```js
pipe(source, passes, options)
```

### Parameters

* `source` → `p5.Framebuffer`, texture, image, or graphics.
* `passes` → an array of filters or a single filter instance (e.g. `baseFilterShader().modify(...)`).
* `options` (optional):

| Option           | Default               | Description                                                     |
| ---------------- | --------------------- | --------------------------------------------------------------- |
| `display`        | `true`                | Draw final result to the main canvas.                           |
| `allocate`       | `true`                | Allocate internal ping/pong framebuffers when missing.          |
| `key`            | `'default'`           | Cache key for internal ping/pong (advanced multi-pipeline use). |
| `ping`, `pong`   | —                     | User-provided framebuffers (advanced override).                 |
| `clear`          | `true`                | Clear ping/pong passes before drawing into them.                |
| `clearDisplay`   | `true`                | Clear canvas before final display.                              |
| `clearFn`        | `() => background(0)` | Clear strategy for passes.                                      |
| `clearDisplayFn` | `clearFn`             | Clear strategy for display stage.                               |
| `draw`           | full-canvas blit      | Custom draw strategy per pass.                                  |

### Basic example

```js
pipe(layer, [noiseFilter, pixelFilter, blurFilter])
```

Equivalent to:

```js
pipe(layer, [noiseFilter, pixelFilter, blurFilter], {
  display: true
})
```

### Using multiple independent pipelines

```js
pipe(sceneFbo, scenePasses, { key: 'scene' })
pipe(minimapFbo, miniPasses, { key: 'mini', display: false })
```

Each `key` maintains its own cached ping/pong pair.

### Transparent canvas display

Opaque passes + transparent final composite:

```js
pipe(layer, passes, {
  clearFn: () => background(0),
  clearDisplayFn: () => clear()
})
```

### Custom draw strategy

```js
pipe(layer, passes, {
  draw: tex => {
    image(tex, -200, -150, 400, 300)
  }
})
```

### Behavior notes

* Internal ping/pong buffers are **lazily resized** to match the source.
* If only one pass is provided and no ping/pong are available, it falls back to `filter()`.
* When `display: false`, `pipe()` returns the final framebuffer.
* User-provided `ping/pong` are never stored internally.

## `releasePipe`

Release internally allocated ping/pong framebuffers.

```js
releasePipe()
releasePipe('mini')
releasePipe(true)
```

| Call                 | Effect                              |
| -------------------- | ----------------------------------- |
| `releasePipe()`      | Releases the default pipeline.      |
| `releasePipe('key')` | Releases a specific keyed pipeline. |
| `releasePipe(true)`  | Releases **all** cached pipelines.  |

Internal resources are automatically released when the sketch is removed.

---

# Utilities

A small collection of helpers commonly needed in interactive 3D sketches:

1. `texOffset(image)`: `[1 / image.width, 1 / image.height]`
2. `mousePosition([flip = true])`: pixel-density-aware mouse position (optionally flips Y).
3. `pointerPosition(pointerX, pointerY, [flip = true])`: pixel-density-aware pointer position (optionally flips Y).
4. `resolution()`: pixel-density-aware canvas resolution `[pd * width, pd * height]`
5. `pixelRatio(location)`: world-to-pixel ratio at a world location.
6. `mousePicking([{ ... }])` and `pointerPicking(pointerX, pointerY, [{ ... }])`: hit-test a screen-space circle/square tied to a model matrix.
7. `bounds([{ [eMatrix], [vMatrix] }])`: frustum planes in general form `ax + by + cz + d = 0`.
8. `visibility({ ... })`: returns `p5.Tree.VISIBLE`, `p5.Tree.INVISIBLE`, or `p5.Tree.SEMIVISIBLE`.

---

# Drawing stuff

Primitives for visualizing common 3D concepts:

1. `axes({ size, colors, bits })`
2. `grid({ size, subdivisions })`
3. `cross({ mMatrix, x, y, size, ... })`
4. `bullsEye({ mMatrix, x, y, size, shape, ... })`
5. `viewFrustum({ pg, bits, viewer, eMatrix, pMatrix, vMatrix })`

---

# Releases

Latest:

* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js)
* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.min.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.min.js)
* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.esm.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.esm.js)
* [https://www.npmjs.com/package/p5.tree](https://www.npmjs.com/package/p5.tree)

Tagged example:

* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.8/dist/p5.tree.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.8/dist/p5.tree.js)
* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.8/dist/p5.tree.min.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.8/dist/p5.tree.min.js)
* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.8/dist/p5.tree.esm.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.8/dist/p5.tree.esm.js)

---

# Usage

## CDN

```html
<script src="https://cdn.jsdelivr.net/npm/p5/lib/p5.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js"></script>

<script>
  function setup() {
    createCanvas(600, 400, WEBGL)
    axes(100)
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
    p.axes(100)
  }

  p.draw = () => {
    p.background(0.15)
    p.orbitControl()
  }
}

new p5(sketch)
```

Modern, modular, instance-mode workflow.
