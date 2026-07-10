/**
 * VISAGE — Virtual Try-On  |  app.js
 * Production-grade ES Module
 *
 * Core Stack:
 *  - MediaPipe Tasks Vision (FaceLandmarker) — WASM SIMD, 468-point 3D landmarks
 *  - Three.js 0.160 — WebGL renderer, OrthographicCamera
 *  - DracoLoader / GLTFLoader — compressed GLB asset pipeline
 *  - GLTFExporter + IndexedDB — runtime GLB bake & cache (zero repeat-load cost)
 *  - BufferGeometryUtils.mergeGeometries — single draw-call frame meshes
 */

import * as THREE from 'three';
import { GLTFLoader }           from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }          from 'three/addons/loaders/DRACOLoader.js';
import { GLTFExporter }         from 'three/addons/exporters/GLTFExporter.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment }      from 'three/addons/environments/RoomEnvironment.js';
import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const GLASSES_Z_OFFSET = 0.05;  // push forward in ortho space
const LERP_POS         = 0.55;  // position smoothing
const LERP_ROT         = 0.50;  // rotation smoothing
const LERP_SCALE       = 0.50;  // scale smoothing
const FACE_LOST_MS     = 2000;  // ms before hiding glasses after face lost
const DEBUG_KEY        = 'd';
const IDB_DB_NAME      = 'visage_glb_cache';
const IDB_STORE_NAME   = 'glbs';
const IDB_VERSION      = 3;     // bump to invalidate old cache

// Landmark indices (MediaPipe 468-point canonical face mesh)
const LM = {
  // 6-point solvePnP set
  NOSE_TIP:       4,
  CHIN:           152,
  L_EYE_INNER:    133,
  R_EYE_INNER:    362,
  L_MOUTH:        61,
  R_MOUTH:        291,

  // Used for scale / placement
  L_EYE_OUTER:    33,
  R_EYE_OUTER:    263,
  L_TEMPLE:       234,
  R_TEMPLE:       454,
  NOSE_BRIDGE:    168,
};

// Canonical 3D face model points (metric, Z forward) for 6-point pose solve
const FACE_MODEL_3D = [
  new THREE.Vector3(0,      0,      0    ), // NOSE_TIP
  new THREE.Vector3(0,     -0.33,  -0.03 ), // CHIN
  new THREE.Vector3(-0.145,-0.17,  -0.12 ), // L_EYE_INNER
  new THREE.Vector3( 0.145,-0.17,  -0.12 ), // R_EYE_INNER
  new THREE.Vector3(-0.08, -0.54,  -0.04 ), // L_MOUTH
  new THREE.Vector3( 0.08, -0.54,  -0.04 ), // R_MOUTH
];

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  cameraStream:     null,
  faceLandmarker:   null,
  rafHandle:        null,
  isRunning:        false,
  faceDetected:     false,
  faceLostTimer:    null,
  currentGlassesId: 'wayfarer',
  debugMode:        false,
  fps:              0,
  frameCount:       0,
  fpsTimer:         0,
  lastFrameMs:      0,
};

// Smoothed transform targets
const target = {
  position: new THREE.Vector3(),
  // Start scale near-zero so glasses don't flash at world-origin size
  // before the first face detection sets a real value.
  scale:    new THREE.Vector3(0.001, 0.001, 0.001),
  quat:     new THREE.Quaternion(),
};

// GLB model cache (id → THREE.Group clone-source)
const modelCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// GLASSES CATALOG
// ─────────────────────────────────────────────────────────────────────────────
const GLASSES_CATALOG = [
  {
    id:    'wayfarer',
    name:  'Classic Wayfarer',
    emoji: '🕶️',
    color: 0x111111,      // matte black acetate
    style: 'wayfarer',
  },
  {
    id:    'clubmaster',
    name:  'Browline',
    emoji: '👓',
    color: 0x3b2219,      // dark tortoiseshell
    style: 'clubmaster',
  },
  {
    id:    'aviator',
    name:  'Gold Aviator',
    emoji: '✈️',
    color: 0xd4af37,      // brushed gold
    style: 'aviator',
  },
  {
    id:    'round',
    name:  'Round Silver',
    emoji: '⭕',
    color: 0xb0b0b0,      // polished silver
    style: 'round',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// DOM REFERENCES
// ─────────────────────────────────────────────────────────────────────────────
const el = {
  viewport:      document.getElementById('viewport'),
  webcam:        document.getElementById('webcam'),
  debugCanvas:   document.getElementById('debugCanvas'),
  threeCanvas:   document.getElementById('threeCanvas'),
  noFaceBorder:  document.getElementById('noFaceBorder'),
  loadingScreen: document.getElementById('loadingScreen'),
  loadingText:   document.getElementById('loadingText'),
  startScreen:   document.getElementById('startScreen'),
  errorScreen:   document.getElementById('errorScreen'),
  appHeader:     document.getElementById('appHeader'),
  noFaceLabel:   document.getElementById('noFaceLabel'),
  glassesPanel:  document.getElementById('glassesPanel'),
  glassesRow:    document.getElementById('glassesRow'),
  actionButtons: document.getElementById('actionButtons'),
  shutterFlash:  document.getElementById('shutterFlash'),
  debugStats:    document.getElementById('debugStats'),
  debugBadge:    document.getElementById('debugBadge'),
  fpsDisplay:    document.getElementById('fpsDisplay'),
  triCount:      document.getElementById('triCount'),
  objCount:      document.getElementById('objCount'),
  startBtn:      document.getElementById('startBtn'),
  retryBtn:      document.getElementById('retryBtn'),
  captureBtn:    document.getElementById('captureBtn'),
  resetBtn:      document.getElementById('resetBtn'),
  stopBtn:       document.getElementById('stopBtn'),
  // Error screen dynamic elements
  errorIcon:     document.getElementById('errorIcon'),
  errorTitle:    document.getElementById('errorTitle'),
  errorSub:      document.getElementById('errorSub'),
  errorSteps:    document.getElementById('errorSteps'),
};

// ─────────────────────────────────────────────────────────────────────────────
// THREE.JS SETUP
// ─────────────────────────────────────────────────────────────────────────────
let renderer, scene, orthoCamera, glassesGroup, envMap;
const clock = new THREE.Clock();

function makeOrthoCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  const halfH  = 1.0;
  const cam    = new THREE.OrthographicCamera(
    -halfH * aspect, halfH * aspect,
     halfH,         -halfH,
     0.01, 100
  );
  cam.position.z = 5;
  return cam;
}

function initThree() {
  const isMobile = window.innerWidth <= 768;

  renderer = new THREE.WebGLRenderer({
    canvas:          el.threeCanvas,
    alpha:           true,
    antialias:       !isMobile,      // disable on mobile for perf
    powerPreference: 'high-performance',
  });
  // Adaptive pixel ratio: 1.5 cap on mobile, 2 on desktop
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping        = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace   = THREE.SRGBColorSpace;

  scene = new THREE.Scene();

  orthoCamera = makeOrthoCamera();

  // Environment map for PBR reflections on metal/glass materials
  const pmrem = new THREE.PMREMGenerator(renderer);
  envMap = pmrem.fromScene(new RoomEnvironment()).texture;
  pmrem.dispose();
  scene.environment = envMap;

  // Lighting
  const ambient  = new THREE.AmbientLight(0xffffff, 0.5);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(2, 4, 5);
  const rimLight = new THREE.PointLight(0xc9a84c, 0.6, 20);
  rimLight.position.set(-2, 2, 3);
  scene.add(ambient, dirLight, rimLight);

  glassesGroup = new THREE.Group();
  glassesGroup.visible = false;
  scene.add(glassesGroup);

  window.addEventListener('resize', onResize);
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);

  const aspect      = w / h;
  const halfH       = 1.0;
  orthoCamera.left  = -halfH * aspect;
  orthoCamera.right =  halfH * aspect;
  orthoCamera.top   =  halfH;
  orthoCamera.bottom = -halfH;
  orthoCamera.updateProjectionMatrix();

  el.debugCanvas.width  = w;
  el.debugCanvas.height = h;
}

// ─────────────────────────────────────────────────────────────────────────────
// COORDINATE MAPPING  (object-fit:cover aware)
// ─────────────────────────────────────────────────────────────────────────────
function landmarkToWorld(lm) {
  const w  = window.innerWidth;
  const h  = window.innerHeight;
  const vw = el.webcam.videoWidth  || w;
  const vh = el.webcam.videoHeight || h;

  const windowAspect = w / h;
  const videoAspect  = vw / vh;
  const scale        = windowAspect > videoAspect ? w / vw : h / vh;

  const rvw  = vw * scale;
  const rvh  = vh * scale;
  const offX = (w - rvw) / 2;
  const offY = (h - rvh) / 2;

  // Mirror X (front camera is mirrored in CSS with scaleX(-1))
  const px = offX + (1.0 - lm.x) * rvw;
  const py = offY + lm.y * rvh;

  const halfH  = 1.0;
  const halfW  = halfH * windowAspect;
  const worldX =  (px / w) * (2 * halfW) - halfW;
  const worldY = -((py / h) * (2 * halfH) - halfH);

  return new THREE.Vector3(worldX, worldY, GLASSES_Z_OFFSET);
}

// ─────────────────────────────────────────────────────────────────────────────
// HEAD POSE — Extracted directly from Google's optimized facial transform matrix
// ─────────────────────────────────────────────────────────────────────────────
function extractRotationFromMatrix(matrixArray) {
  // MediaPipe provides a 4x4 column-major matrix
  const mat = new THREE.Matrix4().fromArray(matrixArray);
  
  // Extract the raw rotation (which assumes an unmirrored camera)
  // We must decompose the matrix because MediaPipe includes scaling and translation in it
  const position = new THREE.Vector3();
  const rawQuat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  mat.decompose(position, rawQuat, scale);
  
  // Convert to Euler angles to fix the mirroring
  const euler = new THREE.Euler().setFromQuaternion(rawQuat, 'XYZ');
  
  // Because our webcam video is mirrored horizontally via CSS/coords,
  // we must invert Yaw (Y axis) and Roll (Z axis).
  // Pitch (X axis) remains correct because looking up/down is unaffected by horizontal mirroring.
  const mirroredEuler = new THREE.Euler(
    euler.x,     // Pitch (keep)
    -euler.y,    // Yaw (invert)
    -euler.z,    // Roll (invert)
    'XYZ'
  );
  
  return new THREE.Quaternion().setFromEuler(mirroredEuler);
}

// ─────────────────────────────────────────────────────────────────────────────
// FACE RESULT HANDLER
// ─────────────────────────────────────────────────────────────────────────────
function onFaceResults(lmArray, transformMatrix) {
  // 1. Dynamic Scale: Calculate true face width using the temples
  const lt = landmarkToWorld(lmArray[LM.L_TEMPLE]);
  const rt = landmarkToWorld(lmArray[LM.R_TEMPLE]);
  const faceWidth = lt.distanceTo(rt);
  
  // Since all 3D models are normalized to exactly 1.0 width, 
  // setting scale to (faceWidth * 1.05) makes the glasses perfectly wrap the face.
  const sf = Math.max(faceWidth * 1.05, 0.01);
  target.scale.setScalar(sf);

  // 2. Precise Positioning using Local Coordinate Offsets
  // Glasses rest primarily on the bridge of the nose.
  const nb = landmarkToWorld(lmArray[LM.NOSE_BRIDGE]);
  
  // We extract the head's rotation so we can apply offsets in "Head Space" 
  // (e.g. pushing the glasses "back" into the head regardless of how the head is turned).
  if (transformMatrix) {
    target.quat.copy(extractRotationFromMatrix(transformMatrix));
  }

  // Z-offset: Bounding box center of 3D glasses is often halfway between the front lenses 
  // and the back ear-tips. We push it back by ~35% of the face width so the lenses rest on the nose.
  const zOffset = faceWidth * 0.35; 
  
  // Y-offset: Glasses usually rest slightly lower than the absolute bridge landmark.
  const yOffset = faceWidth * 0.08; 
  
  const anchor = nb.clone();
  
  // Create a local offset vector (0, down, back)
  const localOffset = new THREE.Vector3(0, -yOffset, -zOffset);
  // Rotate the offset so it points correctly relative to the user's tilted head
  localOffset.applyQuaternion(target.quat);
  
  // Add the rotated offset to the nose bridge position
  anchor.add(localOffset);
  
  target.position.copy(anchor);
}

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG LANDMARKS
// ─────────────────────────────────────────────────────────────────────────────
function drawDebugLandmarks(lmArray) {
  const ctx = el.debugCanvas.getContext('2d');
  const w   = el.debugCanvas.width;
  const h   = el.debugCanvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(201,168,76,0.7)';

  const vw = el.webcam.videoWidth  || w;
  const vh = el.webcam.videoHeight || h;
  const s  = (w / h > vw / vh) ? w / vw : h / vh;
  const rvw = vw * s, rvh = vh * s;
  const ox  = (w - rvw) / 2, oy = (h - rvh) / 2;

  for (const lm of lmArray) {
    const x = ox + (1 - lm.x) * rvw;
    const y = oy + lm.y * rvh;
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATION LOOP
// ─────────────────────────────────────────────────────────────────────────────
function animate(nowMs) {
  // nowMs is supplied by requestAnimationFrame as a DOMHighResTimeStamp
  state.rafHandle = requestAnimationFrame(animate);

  const delta = clock.getDelta();

  // FPS counter
  state.frameCount++;
  state.fpsTimer += delta;
  if (state.fpsTimer >= 0.5) {
    state.fps = Math.round(state.frameCount / state.fpsTimer);
    el.fpsDisplay.textContent = state.fps;
    state.frameCount = 0;
    state.fpsTimer   = 0;
  }

  // MediaPipe Tasks — detectForVideo requires a strictly increasing timestamp
  // The rAF DOMHighResTimeStamp (nowMs) is perfect for this.
  if (state.isRunning && state.faceLandmarker && el.webcam.readyState >= 2 && nowMs > 0) {
    let results;
    try {
      results = state.faceLandmarker.detectForVideo(el.webcam, nowMs);
    } catch (_) { /* ignore mid-init errors */ }

    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
      const lmArray = results.faceLandmarks[0];

      if (state.debugMode) drawDebugLandmarks(lmArray);

      if (!state.faceDetected) {
        state.faceDetected = true;
        clearTimeout(state.faceLostTimer);
        showNoFaceUI(false);
        glassesGroup.visible = true;
      }

      // Pass both landmarks and transformation matrix for rock-solid stability
      const matrix = results.facialTransformationMatrixes?.[0]?.data || null;
      onFaceResults(lmArray, matrix);

    } else {
      if (state.faceDetected) {
        state.faceDetected = false;
        state.faceLostTimer = setTimeout(() => {
          showNoFaceUI(true);
          glassesGroup.visible = false;
        }, FACE_LOST_MS);
      }
      if (state.debugMode) {
        el.debugCanvas.getContext('2d').clearRect(
          0, 0, el.debugCanvas.width, el.debugCanvas.height
        );
      }
    }
  }

  // Smooth lerp / slerp
  glassesGroup.position.lerp(target.position, LERP_POS);
  glassesGroup.scale.lerp(target.scale, LERP_SCALE);
  glassesGroup.quaternion.slerp(target.quat, LERP_ROT);

  if (state.debugMode) {
    const info = renderer.info;
    el.triCount.textContent = info.render.triangles;
    el.objCount.textContent = info.render.calls;
  }

  renderer.render(scene, orthoCamera);
}

// ─────────────────────────────────────────────────────────────────────────────
// MEDIAPIPE — Tasks Vision FaceLandmarker
// ─────────────────────────────────────────────────────────────────────────────
async function initMediaPipe() {
  if (!FaceLandmarker || !FilesetResolver) {
    throw new Error('[VISAGE] MediaPipe tasks-vision modules failed to import.');
  }

  setLoadingText('Loading face tracking model…');

  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );

  state.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU',  // auto-falls back to CPU
    },
    runningMode:                        'VIDEO',
    numFaces:                           1,
    minFaceDetectionConfidence:         0.5,
    minFacePresenceConfidence:          0.5,
    minTrackingConfidence:              0.5,
    outputFaceBlendshapes:              false,
    outputFacialTransformationMatrixes: true,
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// CAMERA
// ─────────────────────────────────────────────────────────────────────────────
async function startCamera() {
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Check that mediaDevices API is available (requires HTTPS or localhost)
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('MediaDevices API unavailable — page must be served over HTTP/HTTPS, not file://');
    err.name  = 'NotSupportedError';
    return err;
  }

  // Pre-check permission state (Chrome/Edge only — won't prompt)
  try {
    const perm = await navigator.permissions.query({ name: 'camera' });
    console.log(`[VISAGE] Camera permission state: ${perm.state}`);
    if (perm.state === 'denied') {
      const err = new Error('Camera permission is denied in browser settings');
      err.name  = 'NotAllowedError';
      return err;
    }
  } catch (_) { /* permissions API not supported — continue anyway */ }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width:      { ideal: isMobile ? 720  : 1280 },
        height:     { ideal: isMobile ? 1280 : 720  },
        aspectRatio: { ideal: window.innerWidth / window.innerHeight },
      },
      audio: false,
    });
    state.cameraStream  = stream;
    el.webcam.srcObject = stream;
    await new Promise(res => { el.webcam.onloadedmetadata = res; });
    await el.webcam.play();

    el.debugCanvas.width  = el.webcam.videoWidth  || window.innerWidth;
    el.debugCanvas.height = el.webcam.videoHeight || window.innerHeight;
    return null;  // null = success
  } catch (err) {
    console.error('[VISAGE] Camera error:', err.name, err.message);
    return err;   // return the real DOMException
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INDEXEDDB GLB CACHE
// ─────────────────────────────────────────────────────────────────────────────
function openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function readFromIDB(db, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readonly');
    const req = tx.objectStore(IDB_STORE_NAME).get(key);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function writeToIDB(db, key, value) {
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    const req = tx.objectStore(IDB_STORE_NAME).put(value, key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

// Export a Three.js Group to a GLB ArrayBuffer
function exportToGLB(group) {
  return new Promise((res, rej) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      group,
      (glb) => res(glb),
      (err) => rej(err),
      { binary: true }
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GLB LOADER (DracoLoader + runtime bake cache)
// ─────────────────────────────────────────────────────────────────────────────
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
dracoLoader.preload();

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

let idb = null;

async function getIDB() {
  if (!idb) idb = await openIDB().catch(() => null);
  return idb;
}

async function loadGlassesModel(entry) {
  const cacheKey = `glb_v${IDB_VERSION}_${entry.id}`;

  // 1. In-memory cache (fastest)
  if (modelCache.has(entry.id)) return modelCache.get(entry.id).clone(true);

  // 2. Try loading a real external GLTF/GLB file first (if client provided one)
  try {
    const gltf = await gltfLoader.loadAsync(`${entry.id}.gltf`);
    const normalized = normalizeLoadedModel(gltf.scene);
    modelCache.set(entry.id, normalized);
    return normalized.clone(true);
  } catch (err) {
    try {
      const gltf2 = await gltfLoader.loadAsync(`${entry.id}.glb`);
      const normalized = normalizeLoadedModel(gltf2.scene);
      modelCache.set(entry.id, normalized);
      return normalized.clone(true);
    } catch (err2) {
      console.warn(`[VISAGE] No external ${entry.id}.gltf/.glb found, falling back to procedural cache.`);
    }
  }

  // 3. IndexedDB GLB cache (fast — avoids re-building geometry)
  const db = await getIDB();
  if (db) {
    const cached = await readFromIDB(db, cacheKey);
    if (cached) {
      const model = await parseGLB(cached);
      modelCache.set(entry.id, model);
      return model.clone(true);
    }
  }

  // 3. Build procedural geometry, bake to GLB, store in IDB
  setLoadingText(`Building ${entry.name} frame…`);
  const group = buildProceduralFrame(entry);
  
  // Normalize the procedural model to exactly 1.0 width as well!
  const normalizedGroup = normalizeLoadedModel(group);

  // Bake & cache async (don't block render)
  if (db) {
    exportToGLB(normalizedGroup).then(glb => {
      writeToIDB(db, cacheKey, glb).catch(() => {});
    }).catch(() => {});
  }

  modelCache.set(entry.id, normalizedGroup);
  return normalizedGroup.clone(true);
}

function parseGLB(arrayBuffer) {
  return new Promise((res, rej) => {
    gltfLoader.parse(arrayBuffer, '', gltf => res(gltf.scene), rej);
  });
}

function normalizeLoadedModel(scene) {
  // Compute bounding box
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  
  // Create a wrapper group
  const wrapper = new THREE.Group();
  
  // Center the model around the origin BEFORE scaling
  // By placing it in a wrapper, the translation will also be scaled down properly.
  scene.position.x = -center.x;
  scene.position.y = -center.y;
  scene.position.z = -center.z;
  
  wrapper.add(scene);
  
  // Scale the entire wrapper to exactly 1.0 width
  const targetWidth = 1.0; 
  if (size.x > 0) {
    const scale = targetWidth / size.x;
    wrapper.scale.setScalar(scale);
  }

  return wrapper;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCEDURAL FRAME BUILDER
// High-fidelity, real-world frame profiles using ExtrudeGeometry + TubeGeometry
// ─────────────────────────────────────────────────────────────────────────────
function buildProceduralFrame(entry) {
  const { color, style } = entry;
  const group = new THREE.Group();

  const metalMat = new THREE.MeshStandardMaterial({
    color:     (style === 'clubmaster' || style === 'aviator') ? 0xd4af37 : color,
    metalness: 1.0,
    roughness: 0.1,
    envMapIntensity: 1.5,
  });

  const plasticMat = new THREE.MeshPhysicalMaterial({
    color:     color,
    metalness: 0.05,
    roughness: 0.2,
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
    envMapIntensity: 1.2,
  });

  const hardwareMat = new THREE.MeshStandardMaterial({
    color: 0xeeeeee,
    metalness: 1.0,
    roughness: 0.2,
    envMapIntensity: 1.5,
  });

  const metalGeos   = [];
  const plasticGeos = [];

  function pushGeo(target, geo, matrix) {
    if (matrix) geo.applyMatrix4(matrix);
    target.push(geo.index ? geo.toNonIndexed() : geo);
  }

  // ── Rounded rectangle rim shape (Wayfarer / Wayfarer-half)
  function makeRimShape(w, h, r, half = false) {
    const shape = new THREE.Shape();
    shape.moveTo(-w/2 + r, h/2);
    shape.lineTo( w/2 - r, h/2);
    shape.quadraticCurveTo(w/2, h/2, w/2, h/2 - r);
    if (half) {
      shape.lineTo(w/2, 0);
      shape.lineTo(-w/2, 0);
    } else {
      shape.lineTo(w/2, -h/2 + r);
      shape.quadraticCurveTo(w/2, -h/2, w/2 - r, -h/2);
      shape.lineTo(-w/2 + r, -h/2);
      shape.quadraticCurveTo(-w/2, -h/2, -w/2, -h/2 + r);
    }
    shape.lineTo(-w/2, h/2 - r);
    shape.quadraticCurveTo(-w/2, h/2, -w/2 + r, h/2);

    const inset = 0.022;
    const hw = w - inset, hh = (half ? h * 0.5 : h) - inset, hr = Math.max(r - 0.006, 0.004);
    const hole = new THREE.Path();
    hole.moveTo(-hw/2 + hr, half ? hh : hh/2);
    hole.lineTo( hw/2 - hr, half ? hh : hh/2);
    hole.quadraticCurveTo(hw/2, half ? hh : hh/2, hw/2, (half ? hh : hh/2) - hr);
    if (half) {
      hole.lineTo(hw/2, 0);
      hole.lineTo(-hw/2, 0);
    } else {
      hole.lineTo(hw/2, -hh/2 + hr);
      hole.quadraticCurveTo(hw/2, -hh/2, hw/2 - hr, -hh/2);
      hole.lineTo(-hw/2 + hr, -hh/2);
      hole.quadraticCurveTo(-hw/2, -hh/2, -hw/2, -hh/2 + hr);
    }
    hole.lineTo(-hw/2, (half ? hh : hh/2) - hr);
    hole.quadraticCurveTo(-hw/2, half ? hh : hh/2, -hw/2 + hr, half ? hh : hh/2);
    shape.holes.push(hole);
    return shape;
  }

  function extrudeRim(shape, depth = 0.005, bevel = 0.002) {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: true, bevelSegments: 4,
      steps: 1, bevelSize: bevel, bevelThickness: bevel * 1.5,
    });
    geo.translate(0, 0, -depth / 2);
    return geo;
  }

  // ── Arm curve (both sides)
  function makeArm(side, radius) {
    const sx = side * 0.27;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sx,         0.02,  0.00),
      new THREE.Vector3(sx * 1.04,  0.02, -0.06),
      new THREE.Vector3(sx * 1.04,  0.02, -0.22),
      new THREE.Vector3(sx * 1.00, -0.04, -0.32),
    ]);
    return new THREE.TubeGeometry(curve, 24, radius, 8, false);
  }

  // ── Bridge
  function makeBridge(radius) {
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(-0.088, 0.013, 0),
      new THREE.Vector3(0,      0.038, 0.015),
      new THREE.Vector3( 0.088, 0.013, 0)
    );
    return new THREE.TubeGeometry(curve, 12, radius, 8, false);
  }

  // ── Build by style
  if (style === 'wayfarer') {
    const shape = makeRimShape(0.185, 0.13, 0.022);
    const rimL  = extrudeRim(shape, 0.014, 0.004);
    pushGeo(plasticGeos, rimL, new THREE.Matrix4().makeTranslation(-0.175, 0, 0));
    pushGeo(plasticGeos, rimL.clone(), new THREE.Matrix4().makeTranslation(0.175, 0, 0));
    pushGeo(plasticGeos, makeBridge(0.009), null);
    pushGeo(plasticGeos, makeArm(-1, 0.011), null);
    pushGeo(plasticGeos, makeArm( 1, 0.011), null);

  } else if (style === 'clubmaster') {
    // Top plastic brow
    const topShape  = makeRimShape(0.185, 0.13, 0.022, true);
    const topRimL   = extrudeRim(topShape, 0.014, 0.004);
    topRimL.translate(0, -0.065, 0);  // shift so flat edge aligns with center
    pushGeo(plasticGeos, topRimL, new THREE.Matrix4().makeTranslation(-0.175, 0.065, 0));
    pushGeo(plasticGeos, topRimL.clone(), new THREE.Matrix4().makeTranslation(0.175, 0.065, 0));

    // Bottom metal wire rim (half torus)
    const wireL = new THREE.TorusGeometry(0.072, 0.005, 12, 32, Math.PI);
    wireL.rotateZ(Math.PI);
    wireL.scale(1.2, 0.9, 1);
    wireL.translate(0, 0.005, 0);
    pushGeo(metalGeos, wireL, new THREE.Matrix4().makeTranslation(-0.175, 0, 0));
    pushGeo(metalGeos, wireL.clone(), new THREE.Matrix4().makeTranslation(0.175, 0, 0));

    pushGeo(metalGeos, makeBridge(0.005), null);
    pushGeo(plasticGeos, makeArm(-1, 0.01), null);
    pushGeo(plasticGeos, makeArm( 1, 0.01), null);

  } else if (style === 'aviator') {
    // Double-wire teardrop torus
    const outer = new THREE.TorusGeometry(0.094, 0.005, 16, 48);
    outer.scale(0.85, 1.18, 1);
    const inner = new THREE.TorusGeometry(0.083, 0.003, 12, 40);
    inner.scale(0.85, 1.18, 1);
    pushGeo(metalGeos, outer, new THREE.Matrix4().makeTranslation(-0.175, 0, 0));
    pushGeo(metalGeos, outer.clone(), new THREE.Matrix4().makeTranslation(0.175, 0, 0));
    pushGeo(metalGeos, inner, new THREE.Matrix4().makeTranslation(-0.175, 0, 0));
    pushGeo(metalGeos, inner.clone(), new THREE.Matrix4().makeTranslation(0.175, 0, 0));

    // Nose pads
    const padGeo = new THREE.SphereGeometry(0.009, 8, 6);
    const padCurve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(-0.045, -0.01, 0.01),
      new THREE.Vector3(0,       0.03,  0.04),
      new THREE.Vector3( 0.045, -0.01, 0.01)
    );
    const padBridge = new THREE.TubeGeometry(padCurve, 10, 0.003, 6, false);
    pushGeo(metalGeos, padBridge, null);
    pushGeo(metalGeos, padGeo, new THREE.Matrix4().makeTranslation(-0.052, -0.02, 0.01));
    pushGeo(metalGeos, padGeo.clone(), new THREE.Matrix4().makeTranslation( 0.052, -0.02, 0.01));
    pushGeo(metalGeos, makeArm(-1, 0.005), null);
    pushGeo(metalGeos, makeArm( 1, 0.005), null);

  } else { // round
    const rim = new THREE.TorusGeometry(0.082, 0.007, 16, 48);
    pushGeo(metalGeos, rim, new THREE.Matrix4().makeTranslation(-0.175, 0, 0));
    pushGeo(metalGeos, rim.clone(), new THREE.Matrix4().makeTranslation(0.175, 0, 0));
    pushGeo(metalGeos, makeBridge(0.005), null);
    pushGeo(metalGeos, makeArm(-1, 0.005), null);
    pushGeo(metalGeos, makeArm( 1, 0.005), null);
  }

  // Merge & add frame meshes
  function addMerged(geos, mat) {
    if (!geos.length) return;
    try {
      const merged = BufferGeometryUtils.mergeGeometries(geos, false);
      group.add(new THREE.Mesh(merged, mat));
    } catch (_) {
      geos.forEach(g => group.add(new THREE.Mesh(g, mat)));
    }
  }
  addMerged(metalGeos,   metalMat);
  addMerged(plasticGeos, plasticMat);

  // ── Lens fills (MeshPhysicalMaterial — real glass)
  const lensMat = new THREE.MeshPhysicalMaterial({
    color:        0xffffff, // completely clear
    transmission: 0.98,     // max transmission for glass
    opacity:      1,
    transparent:  true,
    roughness:    0.02,     // extremely smooth
    ior:          1.52,     // index of refraction of glass
    thickness:    0.015,    // 15mm apparent thickness for refraction
    clearcoat:    1.0,      // extra sharp reflections
    side:         THREE.DoubleSide,
    envMapIntensity: 1.5,
  });

  let fillGeo;
  if (style === 'round') {
    fillGeo = new THREE.CircleGeometry(0.079, 40);
  } else if (style === 'aviator') {
    fillGeo = new THREE.CircleGeometry(0.088, 40);
    fillGeo.scale(0.85, 1.18, 1);
  } else if (style === 'clubmaster') {
    const shape = makeRimShape(0.185, 0.13, 0.022, false);
    fillGeo = new THREE.ShapeGeometry(shape);
    fillGeo.scale(0.96, 0.96, 1);
  } else { // wayfarer
    const shape = makeRimShape(0.185, 0.13, 0.022, false);
    fillGeo = new THREE.ShapeGeometry(shape);
    fillGeo.scale(0.96, 0.96, 1);
  }

  // ── Decorative Rivets (Hinges)
  if (style === 'wayfarer' || style === 'clubmaster') {
    const rivet = new THREE.CylinderGeometry(0.003, 0.003, 0.002, 16);
    rivet.rotateX(Math.PI / 2);
    
    // Left rivets
    pushGeo(metalGeos, rivet, new THREE.Matrix4().makeTranslation(-0.25, 0.04, 0.003));
    pushGeo(metalGeos, rivet.clone(), new THREE.Matrix4().makeTranslation(-0.24, 0.04, 0.003));
    
    // Right rivets
    pushGeo(metalGeos, rivet.clone(), new THREE.Matrix4().makeTranslation(0.25, 0.04, 0.003));
    pushGeo(metalGeos, rivet.clone(), new THREE.Matrix4().makeTranslation(0.24, 0.04, 0.003));
  }

  const lFill = new THREE.Mesh(fillGeo, lensMat);
  const rFill = new THREE.Mesh(fillGeo.clone(), lensMat);
  lFill.position.set(-0.175, 0, 0);
  rFill.position.set( 0.175, 0, 0);
  group.add(lFill, rFill);

  return group;
}

// ─────────────────────────────────────────────────────────────────────────────
// GLASSES MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
async function setActiveGlasses(id) {
  const entry = GLASSES_CATALOG.find(g => g.id === id);
  if (!entry) return;
  state.currentGlassesId = id;

  document.querySelectorAll('.glasses-card').forEach(c => {
    c.classList.toggle('active', c.dataset.id === id);
  });

  clearGlassesGroup();
  showLoading(true);

  const model = await loadGlassesModel(entry);
  glassesGroup.add(model);

  showLoading(false);
}

function clearGlassesGroup() {
  // Remove without disposing (cache owns the geometry)
  while (glassesGroup.children.length) {
    glassesGroup.remove(glassesGroup.children[0]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Maps a DOMException from getUserMedia to a user-friendly error screen
function showCameraError(err) {
  const name = err?.name || 'UnknownError';
  const url  = window.location.href;
  const isHTTP = url.startsWith('http://') || url.startsWith('https://');

  const configs = {
    NotAllowedError: {
      icon:  '🛋️',
      title: 'Camera Permission Denied',
      sub:   'You blocked camera access. Grant permission and try again.',
      steps: [
        'Chrome/Edge: Click the 🔒 lock icon in the address bar → Camera → Allow',
        'Firefox: Click the camera icon in the address bar → Allow',
        'Safari: Settings → Safari → Camera → Allow for this site',
      ],
    },
    NotFoundError: {
      icon:  '📷',
      title: 'No Camera Found',
      sub:   'No camera device was detected on this device.',
      steps: [
        'Make sure a camera is connected or enabled',
        'Check Device Manager / System Preferences for camera drivers',
        'Try a different browser',
      ],
    },
    NotReadableError: {
      icon:  '🔄',
      title: 'Camera In Use',
      sub:   'Another app is already using your camera.',
      steps: [
        'Close other tabs or apps using the camera (Zoom, Teams, Meet, etc.)',
        'Reload this page and try again',
      ],
    },
    OverconstrainedError: {
      icon:  '⚠️',
      title: 'Camera Unavailable',
      sub:   'Could not access a suitable camera with the required settings.',
      steps: [
        'Try a different browser',
        'Update your camera drivers',
      ],
    },
    NotSupportedError: {
      icon:  '🔒',
      title: 'Secure Context Required',
      sub:   !isHTTP
        ? 'Camera requires a secure connection (HTTPS or localhost).'
        : 'Your browser does not support the camera API.',
      steps: !isHTTP
        ? [
            'Open the app via http://localhost (not file://)',
            'Or deploy to an HTTPS host',
          ]
        : ['Try Chrome, Edge, or Firefox'],
    },
  };

  const cfg = configs[name] || {
    icon:  '⚠️',
    title: 'Camera Error',
    sub:   `${name}: ${err?.message || 'Unknown error'}`,
    steps: ['Reload the page and try again', 'Try a different browser'],
  };

  el.errorIcon.textContent  = cfg.icon;
  el.errorTitle.textContent = cfg.title;
  el.errorSub.textContent   = cfg.sub;
  el.errorSteps.innerHTML   = cfg.steps
    .map(s => `<p class="error-step">‣ ${s}</p>`)
    .join('');

  showOverlay('errorScreen', true);
}
function setLoadingText(txt) {
  if (el.loadingText) el.loadingText.textContent = txt;
}

function showOverlay(id, visible) {
  const elem = document.getElementById(id);
  if (!elem) return;
  if (visible) {
    elem.classList.remove('hidden');
    void elem.offsetWidth;
    elem.classList.add('active');
  } else {
    elem.classList.remove('active');
    setTimeout(() => elem.classList.add('hidden'), 550);
  }
}

function showLoading(visible) {
  if (visible) {
    el.loadingScreen.classList.remove('hidden');
    void el.loadingScreen.offsetWidth;
    el.loadingScreen.classList.add('active');
  } else {
    el.loadingScreen.classList.remove('active');
    setTimeout(() => el.loadingScreen.classList.add('hidden'), 550);
  }
}

function showAppUI(visible) {
  [el.appHeader, el.glassesPanel, el.actionButtons].forEach(e => {
    e?.classList.toggle('hidden', !visible);
  });
}

function showNoFaceUI(visible) {
  el.noFaceLabel?.classList.toggle('hidden', !visible);
  el.noFaceBorder?.classList.toggle('hidden', !visible);
}

function buildGlassesSelector() {
  el.glassesRow.innerHTML = '';
  GLASSES_CATALOG.forEach(entry => {
    const card       = document.createElement('button');
    card.className   = 'glasses-card' + (entry.id === state.currentGlassesId ? ' active' : '');
    card.dataset.id  = entry.id;
    card.innerHTML   = `
      <span class="card-thumb">${entry.emoji}</span>
      <span class="card-name">${entry.name}</span>
    `;
    card.addEventListener('click', () => setActiveGlasses(entry.id));
    el.glassesRow.appendChild(card);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHOTO CAPTURE
// ─────────────────────────────────────────────────────────────────────────────
function capturePhoto() {
  const w = el.webcam.videoWidth  || window.innerWidth;
  const h = el.webcam.videoHeight || window.innerHeight;

  const canvas = document.createElement('canvas');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');

  // Mirrored video
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);

  // Letterbox-aware draw (match object-fit:cover)
  const wAsp = canvas.width / canvas.height;
  const vAsp = w / h;
  const sc   = wAsp > vAsp ? canvas.width / w : canvas.height / h;
  const dx   = (canvas.width  - w * sc) / 2;
  const dy   = (canvas.height - h * sc) / 2;
  ctx.drawImage(el.webcam, dx, dy, w * sc, h * sc);
  ctx.restore();

  // Three.js overlay
  ctx.drawImage(el.threeCanvas, 0, 0);

  canvas.toBlob(blob => {
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href     = url;
    link.download = 'visage-try-on.png';
    link.click();
    URL.revokeObjectURL(url);
  }, 'image/png');

  // Shutter flash
  el.shutterFlash.classList.remove('hidden');
  el.shutterFlash.classList.add('flashing');
  setTimeout(() => {
    el.shutterFlash.classList.remove('flashing');
    el.shutterFlash.classList.add('hidden');
  }, 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// STOP / RESET
// ─────────────────────────────────────────────────────────────────────────────
function stopCamera() {
  state.isRunning    = false;
  state.faceDetected = false;
  clearTimeout(state.faceLostTimer);

  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(t => t.stop());
    state.cameraStream = null;
  }
  el.webcam.srcObject = null;

  glassesGroup.visible = false;
  // Reset scale target so there's no pop when next session starts
  target.scale.set(0.001, 0.001, 0.001);

  showNoFaceUI(false);
  showAppUI(false);
  showOverlay('startScreen', true);
  // Do NOT restart the rAF loop — it never stopped (animate() runs continuously)
}

function resetGlasses() {
  glassesGroup.position.set(0, 0, 0);
  glassesGroup.scale.setScalar(1);
  glassesGroup.quaternion.identity();
  setActiveGlasses(state.currentGlassesId);
}

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG
// ─────────────────────────────────────────────────────────────────────────────
function toggleDebug() {
  state.debugMode = !state.debugMode;
  el.debugCanvas.style.display = state.debugMode ? 'block' : 'none';
  el.debugStats.classList.toggle('hidden', !state.debugMode);
  el.debugBadge.classList.toggle('hidden', !state.debugMode);
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
function bindUIHandlers() {
  el.startBtn.addEventListener('click', onStartClick);
  el.retryBtn.addEventListener('click', onStartClick);
  el.captureBtn.addEventListener('click', capturePhoto);
  el.resetBtn.addEventListener('click', resetGlasses);
  el.stopBtn.addEventListener('click', stopCamera);
  document.addEventListener('keydown', e => {
    if (e.key.toLowerCase() === DEBUG_KEY) toggleDebug();
  });
}

async function onStartClick() {
  showOverlay('startScreen', false);
  showOverlay('errorScreen', false);
  showLoading(true);

  const cameraErr = await startCamera();
  if (cameraErr) {
    showLoading(false);
    showCameraError(cameraErr);
    return;
  }

  if (!state.faceLandmarker) {
    try {
      await initMediaPipe();
    } catch (err) {
      console.error('[VISAGE] MediaPipe init failed:', err);
      showLoading(false);
      
      // Update the error screen to show it's a MediaPipe error, not a camera error
      el.errorIcon.textContent  = '🛑';
      el.errorTitle.textContent = 'AI Model Failed to Load';
      el.errorSub.textContent   = err.message;
      el.errorSteps.innerHTML   = '<p class="error-step">‣ Check your internet connection</p><p class="error-step">‣ Try a different browser</p>';
      
      showOverlay('errorScreen', true);
      return;
    }
  }

  buildGlassesSelector();
  await setActiveGlasses(state.currentGlassesId);

  state.isRunning = true;
  showLoading(false);
  showAppUI(true);
  showNoFaceUI(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
function init() {
  initThree();
  bindUIHandlers();

  el.debugCanvas.style.display = 'none';

  // Startup diagnostics — confirm new code is loaded
  console.group('[VISAGE] v4 — Startup Diagnostics');
  console.log('URL:', window.location.href);
  console.log('mediaDevices:', !!navigator.mediaDevices);
  console.log('getUserMedia:', !!(navigator.mediaDevices?.getUserMedia));
  console.log('isSecureContext:', window.isSecureContext);
  navigator.permissions?.query({ name: 'camera' })
    .then(p => console.log('Camera permission:', p.state))
    .catch(() => console.log('Camera permission: query not supported'));
  console.groupEnd();

  // Idle render loop (shows start screen, no tracking)
  animate();

  // Expose for debugging
  window.VISAGE = { state, target, modelCache, scene, renderer, camera: orthoCamera, glassesGroup, toggleDebug, setActiveGlasses, GLASSES_CATALOG };
  console.log('[VISAGE] Ready — MediaPipe Tasks Vision + Three.js DracoLoader stack. Press "D" for debug.');
}

init();
