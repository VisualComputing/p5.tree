1. Decouple bounce from loop opts in pose tracks, eg bounce once would then be possible. It has to do with unifying camera and object tracks (see: `/camUI_explicit/`).

2. Should `resolution()` be renamed as `canvasSize()` (actually `screenSize` might be best here) as in p5-v2 (see  `readme#utilities`). Does it conflict with p5-v2.

3. Reconcile (simplify) `capturePose` and `cameraParams` (they both seem to do quite the same thing):
  ```js
  const camPose = {
    eye:    new Float32Array(3),
    center: new Float32Array(3),
    up:     new Float32Array(3)
  }
  
  const camOut = { 
    pos: new Float32Array(3),
    center: new Float32Array(3),
    up: new Float32Array(3)
  }
  
  function keyPressed() {
    if (key === 'p') track.playing ? track.stop() : track.play({ bounce: true })
      
    if (key === 'c') {
      getCamera().capturePose(camPose)
      console.log(camPose)
      cameraParams(camOut)
      console.log(camOut)
    }
  }
  ```
