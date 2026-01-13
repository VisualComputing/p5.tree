'use strict'

let font

async function setup() {
  font = await loadFont('/fonts/noto_sans.ttf')
  createCanvas(600, 400, WEBGL)
  textFont(font)
  textSize(14)
  console.log(p5.Tree.VERSION)
}

function draw() {
  background(20)
  axes( { size: 300 } )
  push()
  stroke('white')
  grid({ size: 300 })
  pop()
  orbitControl()
  ambientLight(120)
  directionalLight(255, 255, 255, 0.25, 0.3, -1)
  
  push()
  normalMaterial()
  rotateY(frameCount * 0.01)
  rotateX(frameCount * 0.008)
  box(140)
  pop()

  push()
  translate(250, 0, 0)
  normalMaterial()
  torus(70, 22)
  pop()

  push()
  translate(-250, 0, 0)
  normalMaterial()
  box(140)
  // TODO: breaks text() within HUD
  //torus(70, 22)
  pop()
  
  // HUD working here
  beginHUD()
  push()
  noStroke()
  fill(0, 160)
  rect(10, 10, 220, 56, 6)
  fill(255)
  text('Press "a" to add current camera to path\nPress "p" to play it\nPress "r" to reset it', 20, 30)
  pop()
  endHUD()
}

function keyPressed() {
  key === 'd' && console.log('eye view direction in world space', mapDirection())
  key === 'l' && console.log('eye location in world space: ', mapLocation())
  key === 'a' && addPath()
  key === 'p' && playPath()
  key === 'r' && resetPath()
  if (key === 'c') {
    const x = width /2, y = height /2, z = 0.5
    console.log(screenToWorld(x, y, z))
    console.log(mapLocation([x, y, z], { from: p5.Tree.SCREEN, to: p5.Tree.WORLD }))
  }
}
