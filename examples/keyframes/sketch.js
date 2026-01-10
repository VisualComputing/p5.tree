'use strict';

let font;

let cam0, cam1, cam2;

let btnImport, btnAddCurrent, btnPlay, btnRev, btnStop, btnResetAll;
let sSeek;

async function setup() {
  font = await loadFont('/fonts/noto_sans.ttf');

  createCanvas(700, 450, WEBGL);
  textFont(font);

  // Three reference cameras (same projection)
  cam0 = createCamera();
  cam0.camera(0, 0, 600, 0, 0, 0, 0, 1, 0);

  cam1 = createCamera();
  cam1.camera(420, -200, 720, 0, 0, 0, 0, 1, 0);

  cam2 = createCamera();
  cam2.camera(-480, 250, 660, 0, 0, 0, 0, 1, 0);

  // --- UI ----------------------------------------------------

  btnImport = createButton('addPath([cam0, cam1, cam2], clear)');
  btnImport.mousePressed(() => {
    addPath([cam0, cam1, cam2], { clear: true });
    seekPath(0);
    sSeek.value(0);
  });

  btnAddCurrent = createButton('addPath() (snapshot)');
  btnAddCurrent.mousePressed(() => {
    addPath();
  });

  btnPlay = createButton('playPath(loop)');
  btnPlay.mousePressed(() => {
    playPath({ duration: 45, loop: true, rate: 1 });
  });

  btnRev = createButton('playPath(reverse)');
  btnRev.mousePressed(() => {
    playPath({ duration: 45, loop: true, rate: -1 });
  });

  btnStop = createButton('stopPath()');
  btnStop.mousePressed(() => {
    stopPath();
  });

  btnResetAll = createButton('resetPath()');
  btnResetAll.mousePressed(() => {
    resetPath();
    seekPath(0);
    sSeek.value(0);
  });

  sSeek = createSlider(0, 1, 0, 0.001);
  sSeek.input(() => {
    seekPath(sSeek.value());
  });

  // Layout
  btnImport.position(10, 10);
  btnAddCurrent.position(10, 40);
  btnPlay.position(10, 70);
  btnRev.position(10, 100);
  btnStop.position(10, 130);
  btnResetAll.position(10, 160);
  sSeek.position(10, 200);
  sSeek.style('width', '260px');

  console.log('p5.Tree.VERSION =', p5.Tree.VERSION);
  console.log('p5.Tree.EYE =', p5.Tree.EYE);
  console.log(transformDirection());
}

function draw() {
  background(75);

  // Optional manual inspection (disable if it fights playback)
  orbitControl();

  // --- Scene -------------------------------------------------

  ambientLight(120);
  directionalLight(255, 255, 255, 0.25, 0.3, -1);

  push();
  normalMaterial();
  rotateY(frameCount * 0.01);
  rotateX(frameCount * 0.008);
  box(140);
  pop();

  push();
  translate(250, 0, 0);
  normalMaterial();
  sphere(70);
  pop();

  push();
  translate(-250, 0, 0);
  normalMaterial();
  box(140);
  //torus(70, 22);
  pop();

  // --- HUD ---------------------------------------------------

  // TODO fix hud with text() (but we do this afterwards)
  beginHUD();

  noStroke();
  fill(0, 160);
  rect(10, height - 90, 320, 70, 6);

  fill(255);
  textSize(12);
  text(
    'Camera Path / KeyFrames demo\n' +
    '• addPath(): snapshot current camera\n' +
    '• play / reverse / scrub\n' +
    '• HUD uses beginHUD / endHUD',
    20,
    height - 75
  );

  endHUD();
}

let viewBulk = []

function keyPressed() {
  if (key === 'a') {
    const v = vMatrix();
    addPath(v);
  }
  if (key === 'p') {
    console.log(transformPosition({ from: p5.Tree.EYE, to: p5.Tree.WORLD }), p5.Tree.ORIGIN)
    console.log(transformPosition())
    console.log(transformPosition(p5.Tree.ORIGIN, { from: p5.Tree.EYE, to: p5.Tree.WORLD }))
  }
  if (key === 'v') {
    viewBulk.push(vMatrix());
  }
  if (key === 'b') {
    addPath(viewBulk);
  }
  if (key === 'c') {
    viewBulk = [];
    resetPath();
  }
}
