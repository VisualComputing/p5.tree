# p5.tree
[![npm version](https://img.shields.io/npm/v/p5.tree)](https://www.npmjs.com/package/p5.tree)

Shader development, camera keyframe interpolation, and space transformations for 3D rendering in [p5.js v2](https://beta.p5js.org/) ([WEBGL](https://beta.p5js.org/reference/p5/constants/webgl/) / [WEBGL2](https://beta.p5js.org/reference/p5/constants/webgl2/) / [WebGPU](https://beta.p5js.org/reference/p5/constants/webgpu/)).

![A non-Euclidean geometry cube with faces showcasing teapot, bunny, and Buddha models.](p5.tree.png)

- [Keyframes interpolation](#keyframes-interpolation)
  - [Recording keyframes](#recording-keyframes)
  - [Playback](#playback)
  - [Seek, stop, reset](#seek-stop-reset)
- [Space transformations](#space-transformations)
  - [Matrix operations](#matrix-operations)
  - [Matrix queries](#matrix-queries)
  - [Frustum queries](#frustum-queries)
  - [Coordinate space conversions](#coordinate-space-conversions)
  - [Heads Up Display](#heads-up-display)
- [Utilities](#utilities)
- [Drawing stuff](#drawing-stuff)
- [Installation](#installation)
- [vs-code \& vs-codium \& gitpod hacking instructions](#vs-code--vs-codium--gitpod-hacking-instructions)

In `p5.tree`, matrix queries are **immutable** and cache-friendly: they never modify their parameters and always return new `p5.Matrix` instances. For example, `iMatrix` (inverse) does not modify its matrix argument:

```js
let matrix = createMatrix(4)
// iMatrix doesn't modify its matrix param, it gives a new value
let i = iMatrix(matrix)
// i !== matrix
````

Most functions are available both as **p5 helpers** (global-style) and as **renderer methods** (`p5.RendererGL`). Camera path methods are available on `p5.Camera`, and also as `p5` helpers that forward to the current active camera.

Parameters for `p5.tree` functions can be provided in any order, unless specified otherwise. When a function takes an options/config object, it is always the **last** parameter.

# Keyframes interpolation

`p5.tree` provides a small camera-path API built on top of `p5.Camera.copy()` snapshots and `p5.Camera.slerp()` interpolation.

The path lives in user-space as `camera.path` (an array of `p5.Camera` snapshots). You add keyframes, then play the path at a chosen speed and duration.

## Recording keyframes

`camera.addPath(...)` appends a keyframe (camera snapshot) to `camera.path`.

**Overloads**

1. `camera.addPath(eye, center, up, [opts])`  
2. `camera.addPath(view, [opts])`  
3. `camera.addPath([camera0, camera1, ...], [opts])`  
4. `camera.addPath([view0, view1, ...], [opts])`  
5. `camera.addPath([opts])`  

**Notes**

- In **(1)**, `up` is **mandatory** (no default is assumed).
- In **(2)**, `view` is a `p5.Matrix(4)` or a raw `mat4[16]` representing a world→camera transform.
- **(3)** appends copies of existing camera snapshots.
- **(4)** appends copies of existing camera view matrices.
- **(5)** records a snapshot of the current camera at call time.

Where:

* `eye`, `center`, `up` are `p5.Vector` or `[x, y, z]`.
* `view` is a `p5.Matrix` (4x4) or a raw `mat4[16]` representing a **world → camera** transform (like `camera.cameraMatrix`).
* `opts.reset` (boolean, default `false`) clears the path before appending.

**Example: record 3 keyframes**

```js
let cam

function setup() {
  createCanvas(600, 400, WEBGL)
  cam = createCamera()

  cam.addPath([400, 0, 0], [0, 0, 0], [0, 1, 0])
  cam.addPath(other_cam)
  cam.addPath(viewMatrix)
}
```

**p5 wrappers**

`addPath(...)` is also available as a `p5` helper; it forwards to the current active camera (the one used for rendering).

```js
function setup() {
  createCanvas(600, 400, WEBGL)

  addPath([400, 0, 0], [0, 0, 0], [0, 1, 0])
  addPath(cam)
  addPath(viewMatrix)
}
```

## Playback

`camera.playPath(rateOrOpts)` starts (or updates) playback.

* `camera.playPath(rate)` where `rate` is a speed multiplier:

  * `rate > 0` plays forward
  * `rate < 0` plays reverse
  * `rate === 0` stops ticking (equivalent to stopping)

* `camera.playPath({ duration, loop, pingPong, onEnd, rate })`

Options:

* `duration`: **frames per segment** (default `30`)
* `loop`: wraps at ends (default `false`)
* `pingPong`: bounces at ends (default `false`)
* `onEnd`: callback when playback naturally ends (non-looping, non-pingPong)
* `rate`: speed multiplier (default `1`)

If both `pingPong` and `loop` are `true`, `pingPong` takes precedence.

**Example: loop the path**

```js
function setup() {
  createCanvas(600, 400, WEBGL)
  addPath([400, 0, 0], [0, 0, 0], [0, 1, 0], { reset: true })
  addPath(cam)
  addPath(viewMatrix)

  // 45 frames per segment, loop forever
  playPath({ duration: 45, loop: true })
}

function draw() {
  background(220)
  box(80)
}
```

> Projection safety: `p5.Camera.slerp()` requires all keyframes to use the same projection.
> `p5.tree` enforces this by checking projection matrix compatibility while recording.

## Seek, stop, reset

* `camera.seekPath(t)` jumps to a normalized time `t` in `[0, 1]` along the whole path.
* `camera.stopPath()` stops playback (keeps current camera pose).
* `camera.resetPath()` clears playback state (keeps keyframes unless you clear them).

The same methods exist as `p5` helpers (`seekPath`, `stopPath`, `resetPath`) forwarding to the active camera.

---

# Space transformations

This section covers matrix operations, matrix/frustum queries, and coordinate space conversions for 3D rendering.

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
let model

function draw() {
  background(0)

  push()
  translate(80, 0, 0)
  rotateY(frameCount * 0.01)
  model = mMatrix()
  box(40)
  pop()

  // screen projection of the model origin
  const s = mapLocation(p5.Tree.ORIGIN, { from: model, to: p5.Tree.SCREEN })
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

1. `beginHUD()`: begins HUD mode, so geometry specified between `beginHUD()` and `endHUD()` is in window space.
2. `endHUD()`: ends HUD mode.

In HUD space: `(x, y) ∈ [0, width] × [0, height]` (origin at the top-left, y down), matching `image()` / 2D drawing coordinates.

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

# Drawing stuff

Debug / teaching primitives for visualizing common 3D concepts:

1. `axes({ size, colors, bits })`
2. `grid({ size, subdivisions })`
3. `cross({ mMatrix, x, y, size, ... })`
4. `bullsEye({ mMatrix, x, y, size, shape, ... })`
5. `viewFrustum({ pg, bits, viewer, eMatrix, pMatrix, vMatrix })`

---

# Releases

- **Latest (v0.05):**  
  These links always point to the latest published version on npm.
  - [p5.tree.js (unminified, IIFE)](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js)
  - [p5.tree.min.js (minified, IIFE)](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.min.js)
  - [p5.tree.esm.js (ES module)](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.esm.js)
  - [npm package](https://www.npmjs.com/package/p5.tree)

- **Current tagged version (v0.05):**  
  Use these if you want to lock to a specific version.
  - [p5.tree@0.05.js (unminified, IIFE)](https://cdn.jsdelivr.net/npm/p5.tree@0.05/dist/p5.tree.js)
  - [p5.tree@0.05.min.js (minified, IIFE)](https://cdn.jsdelivr.net/npm/p5.tree@0.05/dist/p5.tree.min.js)
  - [p5.tree@0.05.esm.js (ES module)](https://cdn.jsdelivr.net/npm/p5.tree@0.05/dist/p5.tree.esm.js)
  - [npm package (v0.05)](https://www.npmjs.com/package/p5.tree/v/0.05)

---

# Usage

The library works in two setups:

- **[CDN](#cdn)**: Use the [IIFE](https://developer.mozilla.org/en-US/docs/Glossary/IIFE) (Immediately Invoked Function Expression) format with `<script>` tags directly in the browser, along with [p5.js](https://beta.p5js.org/).
- **[npm](#npm-esm)**: Use the [ES module](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules) version in modern projects with [Vite](https://vitejs.dev/) or another bundler.

## CDN

Include both libraries using `<script>` tags, which run in both [global](https://github.com/processing/p5.js/wiki/Global-and-instance-mode) and [instance mode](https://github.com/processing/p5.js/wiki/Global-and-instance-mode).

```html
<!-- index.html -->
<!-- Load p5.js first (required by p5.tree) -->
<script src="https://cdn.jsdelivr.net/npm/p5/lib/p5.min.js"></script>

<!-- Load p5.tree (latest stable version) -->
<script src="https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js"></script>

<script>
  function setup() {
    createCanvas(600, 400, WEBGL)

    // Example: draw world axes
    axes(100)
  }

  function draw() {
    background(0.15)
    orbitControl()
  }
</script>
````

You can run the example, which uses global mode, by opening the `index.html` file in a browser, or by using [VSCodium](https://vscodium.com/) (recommended) or [Visual Studio Code](https://code.visualstudio.com/) with the [Live Server extension](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer).

## npm (ESM)

Install both [`p5`](https://www.npmjs.com/package/p5) and [`p5.tree`](https://www.npmjs.com/package/p5.tree) as dependencies:

```bash
npm i p5 p5.tree
```

Then import them in your project’s entry file (e.g. `main.js`) using a modern bundler like [Vite](https://vitejs.dev/), which runs in [instance mode](https://github.com/processing/p5.js/wiki/Global-and-instance-mode) only:

```js
// main.js
import p5 from 'p5'
import 'p5.tree'

const sketch = p => {
  p.setup = () => {
    p.createCanvas(600, 400, p.WEBGL)

    // Example: draw world axes
    p.axes(100)
  }

  p.draw = () => {
    p.background(0.15)
    p.orbitControl()
  }
}

new p5(sketch)
```

This approach provides full modularity, clean instance isolation, and compatibility with modern JavaScript tooling.
