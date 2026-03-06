# `@nakednous/tree`

Backend for **animations, scene-space queries, visibility tests, and shader-space transforms**.

The package is **renderer-agnostic**, has **no dependencies**, and can run in both browser and server environments.

---

## Installation

```bash
npm install @nakednous/tree
```

```javascript
import * as tree from '@nakednous/tree'
```

---

## Role

`@nakednous/tree` is intended to sit behind a host library or engine.

```text
application / renderer
        │
        ▼
 integration layer
   (e.g. p5.tree)
        │
        ▼
  @nakednous/tree
```

The host layer provides camera state, projection parameters, and scene data.
`@nakednous/tree` performs the underlying computations: animation interpolation, spatial mapping, and visibility testing.

---

## Capabilities

### Animation tracks

Keyframe animation with playback control.

Tracks support:

* interpolation between poses
* rate control
* seeking
* looping and ping-pong modes

Tracks are renderer-agnostic and can drive cameras, objects, or any transform-like structure.

---

### Scene-space queries

Utilities for converting between coordinate spaces.

Common queries include:

* mapping locations between spaces
* mapping directions between spaces
* deriving projection parameters

---

### Visibility tests

Frustum-based visibility checks for:

* points
* spheres
* axis-aligned boxes

These functions operate on numeric camera descriptions and do not depend on renderer classes.

---

### Shader-space helpers

Projection queries and coordinate transforms useful when developing GPU shaders and rendering pipelines.

---

## Philosophy

The backend follows a **query-oriented design**.

Instead of managing scene graphs or renderer state, it focuses on answering spatial and animation questions:

* mapping coordinates between spaces
* interpolating transforms over time
* determining whether objects are visible

This keeps the core portable and easy to integrate with different engines.

---

## Use cases

Typical uses include:

* animation backend for cameras or scene objects
* coordinate-space mapping utilities
* CPU-side frustum culling
* shader development tooling
* server-side scene analysis or preprocessing

---

## Relationship to `p5.tree`

`p5.tree` provides a p5.js integration layer built on top of this backend.

It handles renderer-specific tasks such as retrieving camera matrices and applying transforms to p5 objects, while `@nakednous/tree` provides the underlying algorithms.

---

## License

GPL-3.0-only
© JP Charalambos
