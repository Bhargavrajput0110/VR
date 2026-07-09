const THREE = require('three');

function simulate() {
  console.log("=== THREE.JS MATRIX ROTATION SIMULATION ===");

  // 1. Create a mockup of the MediaPipe matrix when looking straight at the camera.
  // OpenCV Camera: +X right, +Y down, +Z forward.
  // Face: +X left-cheek-to-right-cheek (so pointing to camera's left), +Y top-to-chin (down), +Z back-to-nose (pointing to camera's -Z).
  // So Face X = -Camera X, Face Y = Camera Y, Face Z = -Camera Z.
  // This is a 180-degree rotation around Y.
  const faceMat = new THREE.Matrix4().makeRotationY(Math.PI);
  console.log("Resting Face Matrix:\n", faceMat.elements);

  // 2. Extract rotation just like app.js
  const position = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  faceMat.decompose(position, quat, scale);

  // 3. Create the 3D Glasses object. 
  // Modeled with WebGL standards: +X right, +Y up, +Z backward.
  // Nose is at -Z (Wait! Usually +Z is backward, meaning into the screen? No, +Z is OUT of the screen towards user).
  // The procedural glasses:
  // Center is 0,0,0. Nose bridge is Z=0. Arms go into -Z direction.
  // So glasses nose is facing +Z. Top is +Y. Right arm is -X (wait, if +X is right, right arm is +X).
  // Let's create a proxy object to represent the glasses.
  const glasses = new THREE.Object3D();
  
  // App.js applies negative scale: target.scale.set(-sf, sf, sf)
  glasses.scale.set(-1, 1, 1);
  glasses.quaternion.copy(quat);
  glasses.updateMatrixWorld(true);

  // 4. Test where the axes point in WORLD SPACE!
  // WebGL World Space: +X right, +Y up, +Z out-of-screen (towards user).
  const localUp = new THREE.Vector3(0, 1, 0);       // Top of glasses
  const localFront = new THREE.Vector3(0, 0, 1);    // Front of glasses (nose)
  const localLeftEar = new THREE.Vector3(1, 0, 0);  // Left arm of glasses (assuming +X is right? No, if +X is right, then left arm is -X. Let's assume +X is right arm).

  const worldUp = localUp.clone().applyMatrix4(glasses.matrixWorld);
  const worldFront = localFront.clone().applyMatrix4(glasses.matrixWorld);
  const worldLeftEar = localLeftEar.clone().applyMatrix4(glasses.matrixWorld);

  console.log("\n--- RESULT (Resting Face) ---");
  console.log("Glasses UP points to: ", worldUp);
  console.log("Glasses FRONT points to: ", worldFront);
  
  if (worldUp.y < 0) console.log("=> ERROR: GLASSES ARE UPSIDE DOWN!");
  if (worldFront.z < 0) console.log("=> ERROR: GLASSES ARE FACING BACKWARD (into head)!");
}

simulate();
