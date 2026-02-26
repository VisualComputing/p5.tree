'use strict'

let layer
let models
let focusVal = 0

let uiNoise, uiPixel, uiDof
let dofFilter, pixelatorFilter, noiseFilter

let font
let sceneCam

let showAxes = true
let showGrid = true

let pathLoop = true
let pathPlaying = false
let pathDuration = 45
let pathRate = 1
let pathKeyframes = 0

let sSeek

let fx
let fxOrder = 1

// HUD toggle (DOM)
let cHud
let showHud = true

// HUD buttons
let hudBtns = []
let hudHover = false

function dofCallback () {
  const depthTex = uniformTexture(() => layer.depth)
  const focus = uniformFloat(() => focusVal)
  const dofIntensity = uniformFloat(() => uiDof.dofIntensity.value())
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
  const level = uniformFloat(() => uiPixel.level.value())
  getColor((inputs, canvasContent) => {
    let stepCoord = inputs.texCoord * level
    stepCoord = floor(stepCoord)
    stepCoord = stepCoord / level
    const colour = getTexture(canvasContent, stepCoord)
    return [colour.rgb, 1]
  })
}

function noiseCallback () {
  const frequency = uniformFloat(() => uiNoise.frequency.value())
  const amplitude = uniformFloat(() => uiNoise.amplitude.value())
  const speed = uniformFloat(() => uiNoise.speed.value())
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
  const presets = { 1: ['noise', 'pixelator', 'dof'], 2: ['pixelator', 'dof', 'noise'], 3: ['dof', 'noise', 'pixelator'] }
  const ord = presets[fxOrder] || presets[1]
  return ord.map(pick).filter(Boolean)
}

function fxOrderLabel () {
  if (fxOrder === 1) return 'noise -> pixelator -> dof'
  if (fxOrder === 2) return 'pixelator -> dof -> noise'
  if (fxOrder === 3) return 'dof -> noise -> pixelator'
  return ''
}

function syncFxUI () {
  uiNoise.visible = fx.noise.enabled() ? true : false
  uiPixel.visible = fx.pixelator.enabled() ? true : false
  uiDof.visible = fx.dof.enabled() ? true : false
}

function syncSeekUI () {
  if (pathKeyframes < 2) { sSeek && sSeek.hide(); return }
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

function restartPlaybackIfPlaying () {
  if (!pathPlaying) return
  sceneCam.playPath({
    duration: pathDuration,
    loop: pathLoop,
    rate: pathRate,
    onEnd: () => { pathPlaying = false; sSeek && sSeek.value(sceneCam.pathTime()) }
  })
}

function actToggleGrid () { showGrid = !showGrid }
function actToggleAxes () { showAxes = !showAxes }
function actSetOrder (n) { fxOrder = n }

function actToggleNoise () { fx.noise._on = !fx.noise._on; syncFxUI() }
function actTogglePixel () { fx.pixelator._on = !fx.pixelator._on; syncFxUI() }
function actToggleDof () { fx.dof._on = !fx.dof._on; syncFxUI() }

function actAddKeyframe () {
  sceneCam.addPath()
  pathKeyframes++
  if (pathKeyframes === 2) sSeek && sSeek.value(1)
  onPathChanged({ keepPose: true })
}
function actToggleLoop () { pathLoop = !pathLoop; restartPlaybackIfPlaying() }
function actToggleRate () { pathRate = -pathRate; restartPlaybackIfPlaying() }

function actPlayStop () {
  if (pathKeyframes === 0) return
  if (pathKeyframes === 1) {
    sceneCam.stopPath()
    pathPlaying = false
    sceneCam.playPath({ duration: pathDuration, loop: false, rate: 1 })
    syncSeekUI()
    return
  }
  if (!pathPlaying) {
    sceneCam.playPath({
      duration: pathDuration,
      loop: pathLoop,
      rate: pathRate,
      onEnd: () => { pathPlaying = false; sSeek && sSeek.value(sceneCam.pathTime()) }
    })
    pathPlaying = true
  } else {
    sceneCam.stopPath()
    pathPlaying = false
  }
}

function actResetPath () {
  sceneCam.resetPath()
  pathKeyframes = 0
  sSeek && sSeek.value(0)
  onPathChanged({ keepPose: false })
}

function hudHit (x, y, b) {
  return x >= b.x && x <= (b.x + b.w) && y >= b.y && y <= (b.y + b.h)
}

function hudPointerOver () {
  if (!showHud) return false
  const mx = mouseX
  const my = mouseY
  for (let i = 0; i < hudBtns.length; i++) {
    if (hudHit(mx, my, hudBtns[i])) return true
  }
  return false
}

// Toggle-style HUD button:
// - if opt.on, stays filled (grey-ish)
// - hover still highlights
function drawHudButton (label, x, y, onClick, opt = {}) {
  const { on = false, disabled = false } = opt
  const padX = 6
  const padY = 2
  const tw = textWidth(label)
  const th = textAscent() + textDescent()
  const w = tw + padX * 2
  const h = th + padY * 2
  const b = { label, x, y, w, h, onClick: disabled ? null : onClick }
  const over = !disabled && hudHit(mouseX, mouseY, b)

  noFill()
  stroke(255, disabled ? 40 : 120)
  rect(x, y, w, h, 4)

  if (on || over) {
    noStroke()
    if (disabled) fill(120, 40)
    else if (over) fill(200, 140)
    else fill(180, 90)
    rect(x, y, w, h, 4)
  }

  noStroke()
  fill(255, disabled ? 90 : 255)
  textAlign(LEFT, TOP)
  text(label, x + padX, y + padY)

  hudBtns.push(b)
  return w
}

async function setup () {
  createCanvas(600, 420, WEBGL)
  font = await loadFont('/fonts/noto_sans.ttf')
  textFont(font)

  layer = createFramebuffer()
  layer.begin()
  sceneCam = layer.createCamera()
  layer.end()

  // swap: UI panels now on the RIGHT
  const uiPad = 10
  const uiW = 170
  const uiX = width - uiW - uiPad

  uiNoise = createUniformUI({
    frequency: { min: 0, max: 10, value: 3, step: 0.1, label: 'frequency' },
    amplitude: { min: 0, max: 1, value: 0.3, step: 0.01, label: 'amplitude' },
    speed: { min: 0, max: 1, value: 0.3, step: 0.01, label: 'speed' }
  }, { x: uiX, y: 10, width: uiW, labels: true, title: 'Noise', color: 'white', offset: 0 })

  uiPixel = createUniformUI({
    level: { min: 2, max: 900, value: 300, step: 1, label: 'level' }
  }, { x: uiX, y: 190, width: uiW, labels: true, title: 'Pixelator', color: 'white', offset: 0 })

  uiDof = createUniformUI({
    dofIntensity: { min: 0, max: 4, value: 1.5, step: 0.1, label: 'intensity' }
  }, { x: uiX, y: 280, width: uiW, labels: true, title: 'DOF', color: 'white', offset: 0 })

  noiseFilter = baseFilterShader().modify(noiseCallback)
  pixelatorFilter = baseFilterShader().modify(pixelatorCallback)
  dofFilter = baseFilterShader().modify(dofCallback)

  fx = {
    noise: { shader: noiseFilter, _on: false, enabled: function () { return this._on } },
    pixelator: { shader: pixelatorFilter, _on: false, enabled: function () { return this._on } },
    dof: { shader: dofFilter, _on: true, enabled: function () { return this._on } }
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
  sSeek.position(10, height - 70)
  sSeek.style('width', '220px')
  syncSeekUI()

  // HUD toggle checkbox (below on the LEFT)
  cHud = createCheckbox('HUD', true)
  cHud.changed(() => { showHud = cHud.checked() })
  cHud.position(10, height - 25)
  cHud.style('color', 'white')

  const trange = 200
  models = []
  for (let i = 0; i < 50; i++) {
    models.push({
      position: createVector((random() * 2 - 1) * trange, (random() * 2 - 1) * trange, (random() * 2 - 1) * trange),
      size: random() * 25 + 8,
      color: color(int(random(256)), int(random(256)), int(random(256))),
      type: i === 0 ? 'ball' : i < 25 ? 'torus' : 'box'
    })
  }

  console.log(p5.Tree.VERSION)
}

function draw () {
  background(10)
  if (pathKeyframes >= 2 && pathPlaying) { sSeek.value(sceneCam.pathTime()) }

  layer.begin()
  setCamera(sceneCam)
  background(0)

  if (!hudHover && !hudPointerOver()) orbitControl()

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
    model.type === 'box' ? box(model.size) : model.type === 'torus' ? torus(model.size) : sphere(model.size)
    pop()
  })

  focusVal = mapLocation(models[0].position, { from: p5.Tree.WORLD, to: p5.Tree.SCREEN }).z
  layer.end()

  pipe(layer, fxList())
  drawHud()
  hudHover = hudPointerOver()
}

function drawHud () {
  if (!showHud) return

  const pad = 10
  const panelW = 220
  const x0 = pad // swap: HUD now on the LEFT
  const y0 = pad

  beginHUD()
  push()

  const ts = 14
  textSize(ts)
  textAlign(LEFT, TOP)

  const btnH = (textAscent() + textDescent()) + 2 * 2
  const rowH = btnH + 6

  hudBtns = []
  noStroke()
  fill(0, 180)
  rect(x0, y0, panelW, 330, 8)

  fill(255)

  let y = y0 + pad

  text('p5.tree: post FX + keyframes', x0 + pad, y); y += rowH
  y += rowH * 0.25

  text('Post FX', x0 + pad, y); y += rowH

  // order row (hint moved to its own line)
  let bx = x0 + pad + 18
  text('order:', x0 + pad, y)
  bx += 52
  bx += drawHudButton('1', bx, y - 2, () => actSetOrder(1), { on: fxOrder === 1 }) + 6
  bx += drawHudButton('2', bx, y - 2, () => actSetOrder(2), { on: fxOrder === 2 }) + 6
  drawHudButton('3', bx, y - 2, () => actSetOrder(3), { on: fxOrder === 3 })
  y += rowH

  fill(255)
  text(`(${fxOrderLabel()})`, x0 + pad + 18, y)
  y += rowH

  // fx toggles
  bx = x0 + pad + 18
  text('fx:', x0 + pad, y)
  bx += 32
  bx += drawHudButton('noise', bx, y - 2, actToggleNoise, { on: fx.noise.enabled() }) + 8
  bx += drawHudButton('pixel', bx, y - 2, actTogglePixel, { on: fx.pixelator.enabled() }) + 8
  drawHudButton('dof', bx, y - 2, actToggleDof, { on: fx.dof.enabled() })
  y += rowH

  y += rowH * 0.25
  text('Hints', x0 + pad, y); y += rowH

  bx = x0 + pad + 18
  text('view:', x0 + pad, y)
  bx += 44
  bx += drawHudButton('grid', bx, y - 2, actToggleGrid, { on: showGrid }) + 8
  drawHudButton('axes', bx, y - 2, actToggleAxes, { on: showAxes })
  y += rowH

  y += rowH * 0.25
  text('Keyframes / Path', x0 + pad, y); y += rowH

  // rearranged to avoid tight stacking + smaller rowH
  bx = x0 + pad
  bx += drawHudButton(`add keyframe (${pathKeyframes})`, bx, y - 2, actAddKeyframe) + 8
  drawHudButton(pathPlaying ? 'stop' : 'play', bx, y - 2, actPlayStop, { on: pathPlaying, disabled: pathKeyframes === 0 })
  y += rowH

  bx = x0 + pad
  bx += drawHudButton('resetPath()', bx, y - 2, actResetPath) + 8
  bx += drawHudButton('loop', bx, y - 2, actToggleLoop, { on: pathLoop }) + 8
  drawHudButton(`rate ${pathRate >= 0 ? '>' : '<'}`, bx, y - 2, actToggleRate, { on: pathRate < 0 })

  pop()
  endHUD()
}

function mousePressed () {
  if (!showHud) return true
  const mx = mouseX
  const my = mouseY
  for (let i = 0; i < hudBtns.length; i++) {
    const b = hudBtns[i]
    if (hudHit(mx, my, b)) { b.onClick && b.onClick(); return false }
  }
  return true
}

// touch-friendly (iOS)
const touchStarted = () => mousePressed()
const keyPressed = () => false
const mouseWheel = () => false
