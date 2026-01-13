import p5 from 'p5'
import 'p5.tree'

new p5(p => {
  let font
  let helpText
  let statusText = 'ready'

  p.setup = async function () {
    font = await p.loadFont('/fonts/noto_sans.ttf')
    p.createCanvas(600, 400, p.WEBGL)
    p.textFont(font)
    p.textSize(14)
    console.log('p5.tree version:', p5.Tree.VERSION)
    helpText = [
      `p5.tree ${p5.Tree.VERSION}`,
      '',
      'Mouse: orbitControl',
      'd: log view world direction',
      'l: log eye world location',
      'a: add current camera keyframe',
      'p: play path',
      'r: reset path'
    ].join('\n')
  }

  p.draw = function () {
    p.background(70)
    p.orbitControl()
    p.axes({ size: 300 })
    p.push()
    p.stroke('white')
    p.grid({ size: 500 })
    p.pop()
    p.ambientLight(120)
    p.directionalLight(255, 255, 255, 0.25, 0.3, -1)
    p.push()
    p.rotateY(p.frameCount * 0.01)
    p.rotateX(p.frameCount * 0.008)
    p.normalMaterial()
    p.box(140)
    p.pop()
    p.push()
    p.translate(250, 0, 0)
    p.normalMaterial()
    p.torus(70, 22)
    p.pop()
    p.push()
    p.translate(-250, 0, 0)
    p.normalMaterial()
    p.box(90)
    p.pop()
    // HUD
    p.beginHUD()
    p.noStroke()
    p.fill(0, 160)
    p.rect(10, 10, 260, 180, 8)
    p.fill(255)
    p.text(helpText, 20, 30)
    p.fill(180)
    p.text(`status: ${statusText}`, 20, 180)
    p.endHUD()
  }

  p.keyPressed = function () {
    p.key === 'd' && (
      console.log('view direction (EYE → WORLD):', p.mapDirection()),
      statusText = 'logged view direction'
    )
    p.key === 'l' && (
      console.log('eye location (EYE → WORLD):', p.mapLocation()),
      statusText = 'logged eye location'
    )
    p.key === 'a' && (
      p.addPath(),
      statusText = 'camera keyframe added'
    )
    p.key === 'p' && (
      p.playPath(),
      statusText = 'playing camera path'
    )
    p.key === 'r' && (
      p.resetPath(),
      statusText = 'camera path reset'
    )
  }
}, document.getElementById('sketch'))
