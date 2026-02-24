'use strict'

let layer
let models
let focusVal = 0

let ui
let dofFilter, pixelatorFilter, noiseFilter

let font

// explicit scene camera (the one we animate) — MUST belong to the framebuffer renderer
let sceneCam

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

// post FX toggles + order
let fx
let fxOrder = 1 // 1..3 (preset orders)
let cNoise, cPixel, cBlur

function dofCallback () {
  const depthTex = uniformTexture(() => layer.depth)
  const focus = uniformFloat(() => focusVal)
  const dofIntensity = uniformFloat(() => ui.DOF.intensity.value())

  const getBlurriness = (d) => abs(d - focus) * 40 * dofIntensity
  const maxBlurDistance = (b) => b * 0.01

  getColor((inputs, canvasContent) => {
    let colour = getTexture(canvasContent, inputs.texCoord)
    let samples = 1
    const centerDepth = getTexture(depthTex, inputs.texCoord).r
    const dofriness = getBlurriness(centerDepth)

    for (let i = 0; i < 20; i++) {
      const angle = float(i) * TWO_PI / 20
      const dofDistance = float(i) / 20 * maxBlurDistance(dofriness)
      const offset = [cos(angle), sin(angle)] * dofDistance
      const sampleDepth = getTexture(depthTex, inputs.texCoord + offset).r
      const sampleBlurDist = maxBlurDistance(getBlurriness(sampleDepth))
      if (sampleDepth >= centerDepth || sampleBlurDist >= dofDistance) {
        colour += getTexture(canvasContent, inputs.texCoord + offset)
        samples++
      }
    }

    colour /= float(samples)
    return [colour.rgb, 1]
  })
}

function pixelatorCallback () {
  const level = uniformFloat(() => ui.Pixelator.level.value())
  getColor((inputs, canvasContent) => {
    let stepCoord = inputs.texCoord * level
    stepCoord = floor(stepCoord)
    stepCoord = stepCoord / level
    const colour = getTexture(canvasContent, stepCoord)
    return [colour.rgb, 1]
  })
}

function noiseCallback () {
  const frequency = uniformFloat(() => ui.Noise.frequency.value())
  const amplitude = uniformFloat(() => ui.Noise.amplitude.value())
  const speed = uniformFloat(() => ui.Noise.speed.value())

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
    const t = speed * (millis() / 1000)
    const s = frequency * inputs.texCoord.x
    const v = frequency * inputs.texCoord.y
    const n1 = valueNoise3([s, v, t])
    const n2 = valueNoise3([s + 17, v, t])
    const texCoords = inputs.texCoord + [amplitude * n1, amplitude * n2]
    const colour = getTexture(canvasContent, texCoords)
    return [colour.rgb, 1]
  })
}

function fxList () {
  const enabled = (name) => fx[name] && fx[name].enabled()
  const pick = (name) => (enabled(name) ? fx[name].shader : null)
  const presets = {
    1: ['noise', 'pixelator', 'dof'],
    2: ['pixelator', 'dof', 'noise'],
    3: ['dof', 'noise', 'pixelator']
  }
  const ord = presets[fxOrder] || presets[1]
  return ord.map(pick).filter(Boolean)
}

function fxOrderLabel () {
  if (fxOrder === 1) return '1: noise -> pixelator -> dof'
  if (fxOrder === 2) return '2: pixelator -> dof -> noise'
  if (fxOrder === 3) return '3: dof -> noise -> pixelator'
  return ''
}

function syncFxUI () {
  const noiseOn = cNoise.checked()
  const pixelOn = cPixel.checked()
  const dofOn = cBlur.checked()

  // group-level visibility (neat + minimal): each effect owns its uniforms
  ui.visible('Noise', noiseOn)
  ui.visible('Pixelator', pixelOn)
  ui.visible('DOF', dofOn)
}

async function setup () {
  createCanvas(600, 420, WEBGL)
  font = await loadFont('/fonts/noto_sans.ttf')
  textFont(font)

  layer = createFramebuffer()
  layer.begin()
  sceneCam = layer.createCamera()
  layer.end()

  // GROUPED uniforms (nested by effect)
  ui = createUniformUI({
    Noise: {
      frequency: { min: 0, max: 10, value: 3, step: 0.1, label: 'frequency' },
      amplitude: { min: 0, max: 1, value: 0.3, step: 0.01, label: 'amplitude' },
      speed: { min: 0, max: 1, value: 0.3, step: 0.01, label: 'speed' }
    },
    Pixelator: {
      level: { min: 2, max: 900, value: 300, step: 1, label: 'level' }
    },
    DOF: {
      intensity: { min: 0, max: 4, value: 1.5, step: 0.1, label: 'intensity' }
    }
  }, {
    x: 10,
    y: 10,
    width: 170,
    labels: true,
    title: 'Post FX',
    color: 'white',
    groups: {
      // maximize groups UX: give the UI hints per group
      Noise: { collapsed: false },
      Pixelator: { collapsed: false },
      DOF: { collapsed: false }
    }
  })

  noiseFilter = baseFilterShader().modify(noiseCallback)
  pixelatorFilter = baseFilterShader().modify(pixelatorCallback)
  dofFilter = baseFilterShader().modify(dofCallback)

  // FX toggles (checkboxes)
  cNoise = createCheckbox('noise', false)
  cPixel = createCheckbox('pixelator', false)
  cBlur = createCheckbox('dof', true)
  ;[cNoise, cPixel, cBlur].forEach((c, i) => {
    c.position(10, 10 + 260 + 12 + i * 20)
    c.style('color', 'white')
  })
  cNoise.changed(syncFxUI)
  cPixel.changed(syncFxUI)
  cBlur.changed(syncFxUI)

  fx = {
    noise: { shader: noiseFilter, enabled: () => cNoise.checked() },
    pixelator: { shader: pixelatorFilter, enabled: () => cPixel.checked() },
    dof: { shader: dofFilter, enabled: () => cBlur.checked() }
  }

  syncFxUI()

  pathPlaying = false
  pathKeyframes = 0

  sSeek = createSlider(0, 1, 0, 0.001)
  sSeek.input(() => {
    sceneCam.stopPath()
    pathPlaying = false
    sceneCam.seekPath(sSeek.value())
  })
  sSeek.position(width / 2 + 50, height - 50)
  sSeek.style('width', '220px')

  syncSeekUI()

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

  if (pathKeyframes >= 2 && pathPlaying) {
    sSeek.value(sceneCam.pathTime())
  }

  layer.begin()
  setCamera(sceneCam)
  background(0)
  orbitControl()

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

  pipe(layer, fxList())
  drawHud()
}

function drawHud () {
  const pad = 10
  const panelW = 240
  const x0 = width - panelW - pad
  const y0 = pad
  const lh = 16
  const lines = [
    'p5.tree: post FX + keyframes',
    '',
    'Post FX',
    `  [1/2/3] order: ${fxOrderLabel()}`,
    `  toggles: noise=${fx.noise.enabled() ? 'on' : 'off'}  pixelator=${fx.pixelator.enabled() ? 'on' : 'off'}  dof=${fx.dof.enabled() ? 'on' : 'off'}`,
    '',
    'Hints',
    `  [G] grid: ${showGrid ? 'on' : 'off'}`,
    `  [X] axes: ${showAxes ? 'on' : 'off'}`,
    '',
    'Keyframes / Path',
    '  [A] add keyframe (addPath snapshot)',
    '  [N] pathInfo()',
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

function keyPressed () {
  if (key === 'g' || key === 'G') { showGrid = !showGrid; return true }
  if (key === 'x' || key === 'X') { showAxes = !showAxes; return true }

  if (key === '1' || key === '2' || key === '3') { fxOrder = int(key); return true }

  if (key === 'a' || key === 'A') {
    sceneCam.addPath()
    pathKeyframes++
    if (pathKeyframes === 2) sSeek && sSeek.value(1)
    onPathChanged({ keepPose: true })
    return true
  }

  if (key === 'n' || key === 'N') {
    sceneCam.pathInfo()
    return true
  }

  if (key === 'l' || key === 'L') {
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

  if (key === '>') {
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

  if (key === '<') {
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

  if (key === 'p' || key === 'P') {
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

  if (key === 'r' || key === 'R') {
    sceneCam.resetPath()
    pathKeyframes = 0
    sSeek && sSeek.value(0)
    onPathChanged({ keepPose: false })
    return true
  }

  return false
}

function mouseWheel () {
  return false
}
