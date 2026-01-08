import p5 from 'p5'
import '../../../dist/p5.tree.esm.js'

let font

new p5(p => {
  p.setup = async function () {
    font = await p.loadFont('/fonts/noto_sans.ttf')
    p.createCanvas(600, 400, p.WEBGL)
    p.textFont(font)
    p.textSize(14)
    console.log(p5.Tree.VERSION)
    console.log('eye position in world space: ', p.transformPosition())
    console.log('eye view direction in world space', p.transformDirection())
  }

  p.draw = function () {
    p.background(20)

    p.axes({ size: 300 })
    p.push()
    p.stroke('white')
    p.grid({ size: 300, style: p5.Tree.SOLID })
    p.pop()

    p.orbitControl()
    p.ambientLight(120)
    p.directionalLight(255, 255, 255, 0.25, 0.3, -1)

    p.push()
    p.normalMaterial()
    p.rotateY(p.frameCount * 0.01)
    p.rotateX(p.frameCount * 0.008)
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
    p.box(140)
    p.pop()

    // HUD working here
    p.beginHUD()
    p.push()
    p.translate(-p.width / 2, -p.height / 2)
    p.noStroke()
    p.fill(0, 160)
    p.rect(10, 10, 220, 56, 6)
    p.fill(255)
    p.text('HUD OK\norbitControl OK', 20, 30)
    p.pop()
    p.endHUD()
  }

  p.keyPressed = function () {
    if (p.key === 'd') {
      console.log('eye view direction in world space', p.transformDirection())
    }
    if (p.key === 'l') {
      console.log('eye position in world space: ', p.transformPosition())
    }
    if (p.key === 'a') {
      p.addPath()
    }
    if (p.key === 'p') {
      p.playPath()
    }
    if (p.key === 'r') {
      p.resetPath()
    }
  }
}, document.getElementById('sketch'))
