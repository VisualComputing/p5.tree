'use strict';

function setup() {
  createCanvas(400, 300, WEBGL);
  console.log('p5 version:', p5.prototype.VERSION || p5.VERSION);
  console.log('Press L to log matrix queries (wrappers-only).');
}

function draw() {
  background(20);

  // Keep interaction if you want, but it will change view matrix.
  orbitControl();

  // Deterministic model transform (affects mMatrix/nMatrix)
  push();
  translate(40, -20, 60);
  rotateX(0.3);
  rotateY(0.6);
  box(80);
  pop();
}

function keyPressed() {
  if (key === 'L') logMatrices();
}

function logMatrices() {
  console.log('--- MATRIX QUERY LOG START ---');

  // Core queries (wrappers)
  logQuery('mMatrix()', () => safeFn('mMatrix')());
  logQuery('vMatrix()', () => safeFn('vMatrix')());
  logQuery('pMatrix()', () => safeFn('pMatrix')());
  logQuery('pvMatrix()', () => safeFn('pvMatrix')());
  logQuery('eMatrix()', () => safeFn('eMatrix')());
  logQuery('nMatrix()', () => safeFn('nMatrix')());

  // Derived queries using wrapper outputs
  const vm = safeTry(() => safeFn('vMatrix')());
  if (vm) {
    logQuery('tMatrix(vMatrix())', () => safeFn('tMatrix')(vm));
    logQuery('iMatrix(vMatrix())', () => safeFn('iMatrix')(vm));

    // multiplyPoint sanity if present on returned matrix
    if (typeof vm.multiplyPoint === 'function') {
      const p = safeTry(() => vm.multiplyPoint({ x: 1, y: 2, z: 3 }));
      console.log('vMatrix().multiplyPoint({1,2,3}) →', p ? roundVec(p) : p);
    } else {
      console.log('vMatrix().multiplyPoint →', 'not available');
    }
  } else {
    console.log('vMatrix() →', vm, '(skipping tMatrix/iMatrix/multiplyPoint tests)');
  }

  console.log('--- MATRIX QUERY LOG END ---');
}

/* -------------------------------------------------- */
/* helpers                                             */
/* -------------------------------------------------- */

function safeFn(name) {
  // Never reference an undeclared identifier: always go through globalThis.
  const fn = globalThis[name];
  return typeof fn === 'function' ? fn : () => undefined;
}

function safeTry(thunk) {
  try {
    return thunk();
  } catch (e) {
    console.log('ERROR:', e && e.message ? e.message : e);
    return null;
  }
}

function logQuery(label, thunk) {
  const out = safeTry(thunk);

  // Expecting p5.Matrix-like objects with .mat4 in both v1/v2 ports
  if (out && out.mat4) {
    console.log(label, '→', roundArray(out.mat4));
    return;
  }

  // Otherwise print raw
  console.log(label, '→', out);
}

function roundArray(a) {
  return Array.from(a).map(v => +(+v).toFixed(4));
}

function roundVec(v) {
  return { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) };
}
