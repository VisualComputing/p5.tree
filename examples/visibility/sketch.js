`use strict`;

let fbo;
let models;
let animate, cull;
let persp, cameraZ, aspect;
let nearPlane, farPlane, leftPlane, rightPlane, bottomPlane, topPlane;
let fieldOfView;
let e, p;

const position = [-350, -279, 181]
const center = [12.9, 6.4, 48.3]
const up = [-0.53, 0.78, 0.23]

function setup() {
  createCanvas(600, 400, WEBGL);
  frameRate(100);
  colorMode(RGB, 1);
  fbo = createFramebuffer({ format: FLOAT });
  // scene
  colorMode(RGB, 1);
  const range = 100;
  models = [];
  for (let i = 0; i < 50; i++) {
    let objectModel = {
      type: random() < 0.5 ? 'box' : 'sphere',
      visibility: p5.Tree.VISIBLE,
      color: color(random(), random(), random()),
      position: p5.Vector.random3D().mult(range),
      velocity: createVector((random() * 2 - 1), (random() * 2 - 1), (random() * 2 - 1)).mult(0.5),
      rotation: createVector(random(), random(), random()).normalize().mult(0.01),
      animate() {
        // Update position with velocity
        this.position.add(this.velocity);
        // Check boundaries and reflect if out of range
        ['x', 'y', 'z'].forEach(axis => {
          if (abs(this.position[axis]) > range) {
            this.velocity[axis] *= -1;
            this.position[axis] = constrain(this.position[axis], -range, range);
          }
        });
      }
    };
    if (objectModel.type === 'box') {
      objectModel.width = random() * 12 + 8;
      objectModel.height = random() * 12 + 8;
      objectModel.depth = random() * 12 + 8;
      objectModel.cull = () => {
        objectModel.visibility = visibility({
          corner1: p5.Vector.sub(objectModel.position, createVector(objectModel.width / 2, objectModel.height / 2, objectModel.depth / 2)),
          corner2: p5.Vector.add(objectModel.position, createVector(objectModel.width / 2, objectModel.height / 2, objectModel.depth / 2))
        });
      }
    }
    else {
      objectModel.radius = random() * 12 + 8;
      objectModel.cull = () => {
        objectModel.visibility = visibility({
          center: objectModel.position,
          radius: objectModel.radius
        });
      }
    }
    models.push(objectModel);
  }
  // ui
  animate = createCheckbox('animate', true);
  animate.style('color', 'indigo');
  animate.position(width - 200, 10);
  cull = createCheckbox('cull', true);
  cull.style('color', 'indigo');
  cull.position(width - 200, 35);
  persp = createCheckbox('perspective', true);
  persp.style('color', 'yellow');
  persp.position(width - 110, 10);
  aspect = createCheckbox('aspect ratio', true);
  aspect.style('color', 'yellow');
  aspect.position(width - 110, 35);
  cameraZ = createSlider(-150, 200, 115, 1);
  cameraZ.style('width', '100px');
  cameraZ.position(width - 110, 60);
  fieldOfView = createSlider(0.1, 1.4, 0.6, 0.01);
  fieldOfView.style('width', '100px');
  fieldOfView.position(width - 110, 85);
  nearPlane = createSlider(20, 100, 30, 1);
  nearPlane.style('width', '100px');
  nearPlane.position(width - 110, 110);
  farPlane = createSlider(110, 330, 230, 1);
  farPlane.style('width', '100px');
  farPlane.position(width - 110, 135);
  topPlane = createSlider(10, height / 3, height / 12, 1);
  topPlane.style('width', '100px');
  topPlane.position(width - 110, 160);
  rightPlane = createSlider(10, width / 3, width / 12, 1);
  rightPlane.style('width', '100px');
  rightPlane.position(width - 110, 185);
  bottomPlane = createSlider(-height / 3, -10, -height / 12, 1);
  bottomPlane.style('width', '100px');
  bottomPlane.position(width - 110, 210);
  leftPlane = createSlider(-width / 3, -10, -width / 12, 1);
  leftPlane.style('width', '100px');
  leftPlane.position(width - 110, 235);
  camera(...position, ...center, ...up);
  ortho(-width / 3, width / 3, -height / 3, height / 3, 1, 10000);
}

function update() {
  camera(0, 0, cameraZ.value(), 0, 0, cameraZ.value() > 0 ? -300 : 300, 0, 1, 0);
  e = eMatrix();
  if (persp.checked()) {
    aspect.checked()
      ? (() => {
        const near = nearPlane.value();
        const top = near * Math.tan(fieldOfView.value() / 2);
        const bottom = -top;
        const right = top * (width / height);
        const left = -right;
        frustum(left, right, top, bottom, near, farPlane.value());
      })()
      : frustum(leftPlane.value(), rightPlane.value(), topPlane.value(), bottomPlane.value(), nearPlane.value(), farPlane.value());
    aspect.checked() ? fieldOfView.show() : fieldOfView.hide();
    aspect.checked() ? leftPlane.hide() : leftPlane.show();
    aspect.checked() ? rightPlane.hide() : rightPlane.show();
    aspect.checked() ? topPlane.hide() : topPlane.show();
    aspect.checked() ? bottomPlane.hide() : bottomPlane.show();
  }
  else {
    fieldOfView.hide();
    topPlane.show();
    if (aspect.checked()) {
      rightPlane.value(topPlane.value() * (width / height));
      ortho(-rightPlane.value(), rightPlane.value(), topPlane.value(), -topPlane.value(), nearPlane.value(), farPlane.value());
    }
    else {
      ortho(leftPlane.value(), rightPlane.value(), topPlane.value(), bottomPlane.value(), nearPlane.value(), farPlane.value());
    }
    aspect.checked() ? rightPlane.hide() : rightPlane.show();
    aspect.checked() ? leftPlane.hide() : leftPlane.show();
    aspect.checked() ? bottomPlane.hide() : bottomPlane.show();
  }
  p = pMatrix();
}

function draw() {
  (mouseX <= width - 120 || mouseY >= 265) && orbitControl();
  // scene1
  background('#879319');
  push();
  rotateX(HALF_PI);
  strokeWeight(0.5);
  stroke('blue');
  grid({ subdivisions: 20, size: 300, style: p5.Tree.SOLID });
  pop();
  models.forEach(model => {
    push();
    translate(model.position);
    strokeWeight(model.visibility === p5.Tree.INVISIBLE ? 1 : 1.2);
    model.visibility === p5.Tree.VISIBLE
      ? (fill(model.color), noStroke())
      : (noFill(), strokeWeight(1), model.visibility === p5.Tree.SEMIVISIBLE ? stroke(model.color) : stroke('black'));
    const detail = model.visibility === p5.Tree.VISIBLE ? 20 : 6;
    model.type === 'box' ? box(model.width, model.height, model.depth) : sphere(model.radius, detail, detail);
    pop();
  }
  );
  push();
  strokeWeight(3);
  stroke('magenta');
  fill(color(1, 0, 1, 0.3));
  viewFrustum({
    eMatrix: e ?? createMatrix(4), pMatrix: p ?? createMatrix(4), bits: p5.Tree.NEAR | p5.Tree.FAR,
    viewer: () => axes({
      size: 50, bits: p5.Tree.X | p5.Tree._Y | p5.Tree._Z
    })
  });
  pop();
  // main scene
  fbo.begin();
  clear();
  background(0.7, 0.4, 0.3);
  update();
  models.forEach(model => {
    animate.checked() && model.animate();
    cull.checked() ? model.cull() : model.visibility = p5.Tree.VISIBLE;
    if (model.visibility === p5.Tree.VISIBLE || model.visibility === p5.Tree.SEMIVISIBLE) {
      push();
      translate(model.position);
      noStroke();
      fill(model.color);
      model.type === 'box' ? box(model.width, model.height, model.depth) : sphere(model.radius);
      pop();
    }
  }
  );
  fbo.end();
  beginHUD();
  translate(width - width / 3, height);
  scale(1, -1);
  image(fbo, 0, 0, width / 3, height / 3);
  endHUD();
}

const mouseWheel = () => false;
