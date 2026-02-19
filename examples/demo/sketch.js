'use strict'

let layer
let models
let focusVal = 0

let ui
let blurFilter, pixelFilter, noiseFilter

let font

// explicit scene camera (the one we animate)
let sceneCam

// reference cameras for quick import
let cam0, cam1, cam2

// toggles
let showAxes = true
let showGrid = true

// camera path UI state (we keep it ourselves; no _renderer access)
let pathLoop = true
let pathPlaying = false
let pathDuration = 45 // frames per segment
let pathRate = 1
let pathKeyframes = 0 // we update on add/reset; no introspection

// seek slider (DOM)
let sSeek

function blurCallback () {
  const depthTex = uniformTexture(() => layer.depth)
  const focus = uniformFloat(() => focusVal)
  const blurIntensity = uniformFloat(() => ui.blurIntensity.value())

  const getBlurriness = (d) => abs(d - focus) * 40 * blurIntensity
  const maxBlurDistance = (b) => b * 0.01

  getColor((inputs, canvasContent) => {
    let colour = getTexture(canvasContent, inputs.texCoord)
    let samples = 1

    const centerDepth = getTexture(depthTex, inputs.texCoord).r
    const blurriness = getBlurriness(centerDepth)

    for (let i = 0; i < 20; i++) {
      const angle = float(i) * TWO_PI / 20
      const blurDistance = float(i) / 20 * maxBlurDistance(blurriness)
      const offset = [cos(angle), sin(angle)] * blurDistance

      const sampleDepth = getTexture(depthTex, inputs.texCoord + offset).r
      const sampleBlurDist = maxBlurDistance(getBlurriness(sampleDepth))

      if (sampleDepth >= centerDepth || sampleBlurDist >= blurDistance) {
        colour += getTexture(canvasContent, inputs.texCoord + offset)
        samples++
      }
    }

    colour /= float(samples)
    return [colour.rgb, 1]
  })
}

function pixelCallback () {
  const level = uniformFloat(() => ui.level.value())

  getColor((inputs, canvasContent) => {
    let stepCoord = inputs.texCoord * level
    stepCoord = floor(stepCoord)
    stepCoord = stepCoord / level
    const colour = getTexture(canvasContent, stepCoord)
    return [colour.rgb, 1]
  })
}

function noiseCallback () {
  const frequency = uniformFloat(() => ui.frequency.value())
  const amplitude = uniformFloat(() => ui.amplitude.value())
  const speed = uniformFloat(() => ui.speed.value())
  const time = uniformFloat(() => millis() / 1000)

  const hash = (p) => fract(sin(dot(p, [127.1, 311.7, 74.7])) * 43758.5453123)
  const fade = (t) => t * t * (3 - 2 * t)

  const valueNoise3 = (p) => {
    const i = floor(p)
    const f = fract(p)
    const u = fade(f)

    const n000 = hash(i + [0, 0, 0])
    const n100 = hash(i + [1, 0, 0])
    const n010 = hash(i + [0, 1, 0])
    const n110 = hash(i + [1, 1, 0])
    const n001 = hash(i + [0, 0, 1])
    const n101 = hash(i + [1, 0, 1])
    const n011 = hash(i + [0, 1, 1])
    const n111 = hash(i + [1, 1, 1])

    const nx00 = mix(n000, n100, u.x)
    const nx10 = mix(n010, n110, u.x)
    const nx01 = mix(n001, n101, u.x)
    const nx11 = mix(n011, n111, u.x)

    const nxy0 = mix(nx00, nx10, u.y)
    const nxy1 = mix(nx01, nx11, u.y)

    return (mix(nxy0, nxy1, u.z) * 2) - 1
  }

  getColor((inputs, canvasContent) => {
    const t = speed * time
    const s = frequency * inputs.texCoord.x
    const v = frequency * inputs.texCoord.y

    const n1 = valueNoise3([s, v, t])
    const n2 = valueNoise3([s + 17, v, t])

    const texCoords = inputs.texCoord + [amplitude * n1, amplitude * n2]
    const colour = getTexture(canvasContent, texCoords)
    return [colour.rgb, 1]
  })
}

async function setup () {
  createCanvas(900, 500, WEBGL)

  font = await loadFont('/fonts/noto_sans.ttf')
  textFont(font)

  layer = createFramebuffer()

  // left panel: post FX
  ui = createUniformUI({
    // noise
    frequency: { min: 0, max: 10, value: 0, step: 0.1, label: 'frequency' },
    amplitude: { min: 0, max: 1, value: 0, step: 0.01, label: 'amplitude' },
    speed: { min: 0, max: 1, value: 0, step: 0.01, label: 'speed' },
    // pixel
    level: { min: 1, max: 900, value: 900, step: 1, label: 'level' },
    // blur
    blurIntensity: { min: 0, max: 4, value: 0, step: 0.1, label: 'blur' }
  }, {
    x: 10, y: 10, width: 170, labels: true, title: 'Post FX', color: 'white'
  })

  noiseFilter = baseFilterShader().modify(noiseCallback)
  pixelFilter = baseFilterShader().modify(pixelCallback)
  blurFilter = baseFilterShader().modify(blurCallback)

  // explicit scene camera (THIS is the one we animate)
  sceneCam = createCamera()
  sceneCam.camera(0, 0, 600, 0, 0, 0, 0, 1, 0)
  setCamera(sceneCam)

  // reference cameras for quick import (same projection)
  cam0 = createCamera()
  cam0.camera(0, 0, 600, 0, 0, 0, 0, 1, 0)

  cam1 = createCamera()
  cam1.camera(420, -200, 720, 0, 0, 0, 0, 1, 0)

  cam2 = createCamera()
  cam2.camera(-480, 250, 660, 0, 0, 0, 0, 1, 0)

  pathPlaying = false
  pathKeyframes = 0

  // seek slider (bottom-left)
  sSeek = createSlider(0, 1, 0, 0.001)
  sSeek.input(() => {
    sceneCam.stopPath()
    pathPlaying = false
    sceneCam.seekPath(sSeek.value())
  })
  sSeek.position(10, height - 25)
  sSeek.style('width', '280px')

  syncSeekUI()

  // keep key commands working even if UI inputs are focused
  window.addEventListener('keydown', (e) => {
    const el = document.activeElement
    const tag = el && el.tagName
    const isForm = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
    if (!isForm) return
    if (handleKey(e.key)) e.preventDefault()
  }, true)

  // scene models
  const trange = 200
  models = []
  for (let i = 0; i < 50; i++) {
    models.push({
      position: createVector(
        (random() * 2 - 1) * trange,
        (random() * 2 - 1) * trange,
        (random() * 2 - 1) * trange
      ),
      size: random() * 25 + 8,
      color: color(int(random(256)), int(random(256)), int(random(256))),
      type: i === 0 ? 'ball' : i < 25 ? 'torus' : 'box'
    })
  }

  console.log(p5.Tree.VERSION)
}

function draw () {
  background(10)

  // ensure the real scene camera is active every frame (robust across FBO passes)
  setCamera(sceneCam)

  // keep seek slider synced to playback cursor
  if (pathKeyframes >= 2 && pathPlaying) {
    sSeek.value(sceneCam.pathTime())
  }

  // render scene into layer (color + depth)
  layer.begin()

  // layer.begin may mess with the active camera, reassert it inside
  setCamera(sceneCam)

  background(0)

  if (!pathPlaying) orbitControl()

  stroke(180, 90)
  showGrid && grid({ size: 500, subdivisions: 20 })
  showAxes && axes({ size: 220 })

  noStroke()
  ambientLight(100)

  const direction = mapDirection(p5.Tree._k, { from: p5.Tree.EYE, to: p5.Tree.WORLD })
  directionalLight(255, 255, 255, direction.x, direction.y, direction.z)

  specularMaterial(255)
  shininess(150)

  models.forEach(model => {
    push()
    fill(model.color)
    translate(model.position)
    model.type === 'box'
      ? box(model.size)
      : model.type === 'torus'
        ? torus(model.size)
        : sphere(model.size)
    pop()
  })

  focusVal = mapLocation(models[0].position, { from: p5.Tree.WORLD, to: p5.Tree.SCREEN }).z

  layer.end()

  // display post FX
  pipe(layer, [noiseFilter, pixelFilter, blurFilter])

  // right panel HUD
  drawHud()
}

function drawHud () {
  const pad = 10
  const panelW = 320
  const x0 = width - panelW - pad
  const y0 = pad
  const lh = 16

  const lines = [
    'p5.tree: post FX + keyframes',
    '',
    'Hints',
    `  [G] grid: ${showGrid ? 'on' : 'off'}`,
    `  [X] axes: ${showAxes ? 'on' : 'off'}`,
    '',
    'Keyframes / Path',
    '  [A] add keyframe (addPath snapshot)',
    '  [I] import [cam0, cam1, cam2] (reset)',
    `  [P] play/stop   loop=${pathLoop ? 'on' : 'off'}   rate=${pathRate}`,
    '  [R] resetPath()',
    '  [L] toggle loop',
    '  [<] reverse rate',
    '  [>] forward rate',
    `  duration: ${pathDuration} f/seg`,
    `  keyframes: ${pathKeyframes}`,
    `  state: ${pathPlaying ? 'playing' : pathKeyframes === 1 ? 'single keyframe' : 'stopped'}`
  ]

  beginHUD()
  push()
  noStroke()
  fill(0, 180)
  rect(x0, y0, panelW, pad + lines.length * lh + pad, 8)
  fill(255)
  textSize(12)
  textAlign(LEFT, TOP)
  let y = y0 + pad
  for (let i = 0; i < lines.length; i++) {
    text(lines[i], x0 + pad, y)
    y += lh
  }
  pop()
  endHUD()
}

function syncSeekUI () {
  if (pathKeyframes < 2) {
    sSeek && sSeek.hide()
    return
  }
  sSeek && sSeek.show()
  sSeek.value(constrain(sSeek.value(), 0, 1))
}

function onPathChanged (opt = {}) {
  const { keepPose = true } = opt

  sceneCam.stopPath()
  pathPlaying = false

  if (!keepPose) {
    sSeek && sSeek.value(0)
    pathKeyframes >= 1 && sceneCam.seekPath(0)
  }

  syncSeekUI()
}

function handleKey (k) {
  if (k === 'g' || k === 'G') { showGrid = !showGrid; return true }
  if (k === 'x' || k === 'X') { showAxes = !showAxes; return true }

  if (k === 'a' || k === 'A') {
    sceneCam.addPath()
    pathKeyframes++
    if (pathKeyframes === 2) sSeek && sSeek.value(1)
    onPathChanged({ keepPose: true })
    return true
  }

  if (k === 'i' || k === 'I') {
    sceneCam.addPath([cam0, cam1, cam2], { reset: true })
    pathKeyframes = 3
    sSeek && sSeek.value(0)
    onPathChanged({ keepPose: false })
    return true
  }

  if (k === 'l' || k === 'L') {
    pathLoop = !pathLoop
    if (pathPlaying) {
      sceneCam.playPath({
        duration: pathDuration,
        loop: pathLoop,
        rate: pathRate,
        onEnd: () => { pathPlaying = false; sSeek.value(sceneCam.pathTime()) }
      })
    }
    return true
  }

  if (k === '>') {
    pathRate = 1
    if (pathPlaying) {
      sceneCam.playPath({
        duration: pathDuration,
        loop: pathLoop,
        rate: pathRate,
        onEnd: () => { pathPlaying = false; sSeek.value(sceneCam.pathTime()) }
      })
    }
    return true
  }

  if (k === '<') {
    pathRate = -1
    if (pathPlaying) {
      sceneCam.playPath({
        duration: pathDuration,
        loop: pathLoop,
        rate: pathRate,
        onEnd: () => { pathPlaying = false; sSeek.value(sceneCam.pathTime()) }
      })
    }
    return true
  }

  if (k === 'p' || k === 'P') {
    if (pathKeyframes === 0) return true

    if (pathKeyframes === 1) {
      sceneCam.stopPath()
      pathPlaying = false
      sceneCam.playPath({ duration: pathDuration, loop: false, rate: 1 })
      syncSeekUI()
      return true
    }

    if (!pathPlaying) {
      sceneCam.playPath({
        duration: pathDuration,
        loop: pathLoop,
        rate: pathRate,
        onEnd: () => { pathPlaying = false; sSeek.value(sceneCam.pathTime()) }
      })
      pathPlaying = true
    } else {
      sceneCam.stopPath()
      pathPlaying = false
    }
    return true
  }

  if (k === 'r' || k === 'R') {
    sceneCam.resetPath()
    pathKeyframes = 0
    sSeek && sSeek.value(0)
    onPathChanged({ keepPose: false })
    return true
  }

  return false
}

function keyPressed () {
  handleKey(key)
  return false
}

function mouseWheel () {
  return false
}
