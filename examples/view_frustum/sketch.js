'use strict';

let fbo;
let models;
let persp;
let cameraZ;
let aspect;
let nearPlane, farPlane, leftPlane, rightPlane, bottomPlane, topPlane;
let fieldOfView;
let e, p;
const position = [-383.11, -215.95, 192]
const center = [-382.28, -215.52, 191.62]
const up = [-0.4, 0.9, 0.17]

function setup() {
  createCanvas(600, 400, WEBGL);
  fbo = createFramebuffer({ format: FLOAT });
  /*
  // TODO fbo camera!?
  cam = fbo.createCamera();
  cam.camera(0, 0, 158,
    0, 0, 157,
    0, 1, 0);
  // */
  colorMode(RGB, 1);
  document.oncontextmenu = () => false
  // scene
  const trange = 100;
  models = [];
  for (let i = 0; i < 50; i++) {
    let object = {
      type: random() < 0.5 ? 'box' : 'sphere',
      position: createVector((random() * 2 - 1) * trange, (random() * 2 - 1) * trange, (random() * 2 - 1) * trange),
      color: color(random(), random(), random()),
      visibility: p5.Tree.VISIBLE
    };
    if (object.type === 'box') {
      object.width = random() * 12 + 8;
      object.height = random() * 12 + 8;
      object.depth = random() * 12 + 8;
    }
    else {
      object.radius = random() * 12 + 8;
    }
    models.push(object);
  }
  persp = createCheckbox('perspective', true);
  persp.style('color', 'yellow');
  persp.position(width - 110, 10);
  aspect = createCheckbox('aspect ratio', true);
  aspect.style('color', 'yellow');
  aspect.position(width - 110, 35);
  cameraZ = createSlider(-150, 200, 115, 1);
  cameraZ.style('width', '100px');
  cameraZ.position(width - 110, 60);
  fieldOfView = createSlider(0.3, 1, 0.6, 0.01);
  fieldOfView.style('width', '100px');
  fieldOfView.position(width - 110, 85);
  nearPlane = createSlider(20, 100, 40, 1);
  nearPlane.style('width', '100px');
  nearPlane.position(width - 110, 110);
  farPlane = createSlider(110, 300, 230, 1);
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
  camera(...position, ...center, ...up)
  ortho(-width / 3, width / 3, -height / 3, height / 3, 1, 10000);
}

function update() {
  camera(0, 0, cameraZ.value(), 0, 0, cameraZ.value() > 0 ? -300 : 300, 0, 1, 0);
  e = eMatrix();
  if (persp.checked()) {
    aspect.checked()
      ? perspective(fieldOfView.value(), width / height, nearPlane.value(), farPlane.value())
      : frustum(leftPlane.value(), rightPlane.value(), bottomPlane.value(), topPlane.value(), nearPlane.value(), farPlane.value());
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
      ortho(-rightPlane.value(), rightPlane.value(), -topPlane.value(), topPlane.value(), nearPlane.value(), farPlane.value());
    }
    else {
      // TODO p5 bug natural eqn swap the image in y dir(!)
      //fbo2.frustum(lPlane.value(), rPlane.value(), bPlane.value(), tPlane.value(), nPlane.value(), fPlane.value());
      //tree: l(-), r, b(-), t, n, f -50 30 33 -59 72 230
      //ui:   l(-), r, b(-), t, n, f -50 50 -59 33 72 230
      // also image inv!
      //fbo2.frustum(lPlane.value(), rPlane.value(), -tPlane.value(), -bPlane.value(), nPlane.value(), fPlane.value());
      // tree: l(-), r, b(-), t, n, f -50 50 62 -33 68 230
      // ui:   l(-), r, b(-), t, n, f -50 50 -62 33 68 230
      // possible solutions are:
      //fbo2.frustum(lPlane.value(), rPlane.value(), -bPlane.value(), -tPlane.value(), nPlane.value(), fPlane.value());
      //tree: l(-), r, b(-), t, n, f -50 50 -33 48 93 230
      //ui:   l(-), r, b(-), t, n, f -50 50 -48 33 93 230
      // ***
      //pg2.frustum(lPlane.value(), rPlane.value(), tPlane.value(), bPlane.value(), nPlane.value(), fPlane.value());
      //tree: l(-), r, b(-), t, n, f -50 50 -42 33 57 230
      //ui:   l(-), r, b(-), t, n, f -50 50 -42 33 57 230
      // ***
      // other option is
      ortho(leftPlane.value(), rightPlane.value(), bottomPlane.value(), topPlane.value(), nearPlane.value(), farPlane.value());
    }
    aspect.checked() ? rightPlane.hide() : rightPlane.show();
    aspect.checked() ? leftPlane.hide() : leftPlane.show();
    aspect.checked() ? bottomPlane.hide() : bottomPlane.show();
  }
  p = pMatrix();
}

function draw() {
  (mouseX <= width - 120 || mouseY >= 265) && orbitControl();
  background('#879319');
  push();
  stroke('#CC8E0C')
  strokeWeight(0.6)
  rotateX(HALF_PI);
  grid({ subdivisions: 25, size: 400 })
  pop();
  scene();
  push();
  stroke('magenta');
  fill(color(1, 0, 1, 0.3));
  viewFrustum({
    eMatrix: e ?? createMatrix(4), pMatrix: p ?? createMatrix(4), bits: p5.Tree.NEAR /*| p5.Tree.FAR*/,
    viewer: () => axes({
      size: 50, bits: p5.Tree.X | p5.Tree._Y | p5.Tree._Z
    })
  });
  pop();
  fbo.begin();
  //clear();
  background(0.6, 0.5, 0.4);
  camera(0, 0, 158,
    0, 0, 157,
    0, 1, 0);
  //e = eMatrix();
  update();
  //p = pMatrix();
  scene();
  fbo.end();
  beginHUD();
  image(fbo, width - width / 3, height - height / 3, width / 3, height / 3);
  endHUD();
}

function scene() {
  models.forEach(model => {
    push();
    translate(model.position);
    fill(model.color);
    noStroke();
    model.type === 'box' ? box(model.width, model.height, model.depth) : sphere(model.radius);
    pop();
  });
}

const mouseWheel = () => false;
