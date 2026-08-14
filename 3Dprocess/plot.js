import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildAiLandscapesForTraces } from "./pipeline.js";

const PLANE = 600;
const TIME_H = 420;

const OUTCOME_COLOR = {
  merged: new THREE.Color(0x00ffff),
  closed: new THREE.Color(0xff66cc),
  deleted: new THREE.Color(0xffaa33),
  open: new THREE.Color(0x88ff66),
};

const PR_TYPE_COLOR = {
  pull_request: new THREE.Color(0x00ffff),
  issue: new THREE.Color(0xff88aa),
};

function makeSpriteLabel(text, color = "#c8fff8") {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = 512;
  canvas.height = 128;
  ctx.font = "Bold 36px Courier New";
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 64);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  }));
  sprite.scale.set(90, 22, 1);
  return sprite;
}

function colorFor(trace, result, mode) {
  if (mode === "outcome") {
    return (OUTCOME_COLOR[trace.outcome] || OUTCOME_COLOR.open).clone();
  }
  if (mode === "pull_request") {
    return (trace.isPullRequest ? PR_TYPE_COLOR.pull_request : PR_TYPE_COLOR.issue).clone();
  }
  const t = result.tMax === result.tMin
    ? 0.5
    : (trace.startTs - result.tMin) / (result.tMax - result.tMin);
  const color = new THREE.Color();
  color.setHSL(0.55 - t * 0.45, 1, 0.58);
  return color;
}

export function createPrPlot(container, onHover, onSelect) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 8000);
  camera.position.set(520, 420, 720);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;
  controls.target.set(0, TIME_H * 0.45, 0);

  const axesGroup = new THREE.Group();
  axesGroup.visible = false;
  scene.add(axesGroup);
  axesGroup.add(new THREE.GridHelper(1200, 40, 0x111111, 0x080808));
  axesGroup.add(new THREE.AxesHelper(400));

  const axisLine = (end, color) => {
    const geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), end]);
    axesGroup.add(new THREE.Line(geom, new THREE.LineBasicMaterial({ color })));
  };
  axisLine(new THREE.Vector3(-400, 0, 0), 0x441111);
  axisLine(new THREE.Vector3(0, TIME_H, 0), 0x114411);
  axisLine(new THREE.Vector3(0, 0, -400), 0x111144);

  const labX = makeSpriteLabel("PROCESS MDS1 (X)", "#ff4444");
  labX.position.set(450, 12, 0);
  labX.scale.set(140, 28, 1);
  axesGroup.add(labX);
  const labY = makeSpriteLabel("TIME BY MONTH (Y)", "#44ff44");
  labY.position.set(0, TIME_H + 36, 0);
  labY.scale.set(150, 28, 1);
  axesGroup.add(labY);

  const labZ = makeSpriteLabel("PROCESS MDS2 (Z)", "#4444ff");
  labZ.position.set(0, 12, 450);
  labZ.scale.set(140, 28, 1);
  axesGroup.add(labZ);

  const timeGroup = new THREE.Group();
  timeGroup.visible = true;
  scene.add(timeGroup);
  const monthTicks = new THREE.Group();
  timeGroup.add(monthTicks);
  const timeAxisHint = makeSpriteLabel("TIME BY MONTH", "#66ff88");
  timeAxisHint.position.set(55, TIME_H + 28, 0);
  timeAxisHint.scale.set(120, 24, 1);
  timeGroup.add(timeAxisHint);

  const TIME_SIDE = 480;
  const _camRight = new THREE.Vector3();

  const root = new THREE.Group();
  scene.add(root);
  const landscapeGroup = new THREE.Group();
  landscapeGroup.visible = false;
  // ~1cm screen shift right (world +X).
  landscapeGroup.position.x = 15;
  scene.add(landscapeGroup);

  // Mid-frame with clearance for title (top) and footer (bottom).
  const LAND_TOP_Y = 535;
  const LAND_BOT_Y = 270;
  const LAND_DEPTH = 140;
  const LAND_RES = 52;
  const LAND_DROP = 70;

  const state = {
    result: null,
    world: [],
    now: null,
    colorMode: "outcome",
    lineMesh: null,
    pointMesh: null,
    aiMesh: null,
    playing: false,
    playStartReal: 0,
    playStartNow: 0,
    durationSec: 24,
    selectedId: null,
    pointerDown: null,
    hideEnded: false,
    minFreq: 1,
    entityType: "both",
    aiFilter: "all",
    showAxes: false,
    showTime: true,
    showAiMarks: true,
    autoRotate: true,
    viewMode: "traces",
    landscapeShow: "both",
    landscapeWorld: [],
    landscapeDeform: null,
    activeLandscapes: null,
  };

  const raycaster = new THREE.Raycaster();
  raycaster.params.Points = { threshold: 18 };
  const pointer = new THREE.Vector2();

  function timeToY(ts, result) {
    const span = Math.max(result.tMax - result.tMin, 1);
    return ((ts - result.tMin) / span) * TIME_H;
  }

  function formatMonth(ts) {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function monthStartUtc(ts) {
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }

  function nextMonthUtc(ts) {
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }

  function monthTickTimes(tMin, tMax, maxTicks = 12) {
    const starts = [];
    let t = monthStartUtc(tMin);
    const last = monthStartUtc(tMax);
    while (t <= last) {
      starts.push(t);
      t = nextMonthUtc(t);
    }
    if (!starts.length) return [monthStartUtc(tMin)];
    if (starts.length <= maxTicks) return starts;
    const step = Math.ceil(starts.length / maxTicks);
    return starts.filter((_, i) => i % step === 0 || i === starts.length - 1);
  }

  function rebuildMonthLabels(result) {
    while (monthTicks.children.length) {
      const obj = monthTicks.children.pop();
      obj.traverse((child) => {
        if (child.material) {
          if (child.material.map) child.material.map.dispose();
          child.material.dispose();
        }
        if (child.geometry) child.geometry.dispose();
      });
    }
    if (!result) return;
    const ticks = monthTickTimes(result.tMin, result.tMax, 12);
    for (const ts of ticks) {
      const y = timeToY(ts, result);
      const label = makeSpriteLabel(formatMonth(ts), "#66ff88");
      label.position.set(50, y, 0);
      label.scale.set(80, 20, 1);
      monthTicks.add(label);
      const mark = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, y, 0),
          new THREE.Vector3(-28, y, 0),
        ]),
        new THREE.LineBasicMaterial({ color: 0x226633 })
      );
      monthTicks.add(mark);
    }
  }

  function updateTimeGuidePose() {
    if (!state.showTime) return;
    _camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    _camRight.y = 0;
    if (_camRight.lengthSq() < 1e-8) _camRight.set(1, 0, 0);
    else _camRight.normalize();
    const tx = controls.target.x;
    const tz = controls.target.z;
    timeGroup.position.set(
      tx + _camRight.x * TIME_SIDE,
      0,
      tz + _camRight.z * TIME_SIDE
    );
    // Local +X points outward along camera-right (screen-right).
    timeGroup.rotation.y = Math.atan2(-_camRight.z, _camRight.x);
  }

  function toWorld(result) {
    const xs = result.traces.map((t) => t.x);
    const zs = result.traces.map((t) => t.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const scale = PLANE / Math.max(maxX - minX, maxZ - minZ, 1e-6);
    return result.traces.map((trace) => {
      const color = colorFor(trace, result, state.colorMode);
      return {
        ...trace,
        wx: (trace.x - cx) * scale,
        wz: (trace.y - cz) * scale,
        y0: timeToY(trace.startTs, result),
        y1: timeToY(trace.endTs, result),
        color,
      };
    });
  }

  function clearRoot() {
    while (root.children.length) {
      const obj = root.children.pop();
      obj.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
          else child.material.dispose();
        }
      });
    }
    state.lineMesh = null;
    state.pointMesh = null;
    state.aiMesh = null;
  }

  function buildMeshes() {
    clearRoot();
    const n = state.world.length;
    if (!n) return;

    const linePos = new Float32Array(n * 6);
    const lineCol = new Float32Array(n * 6);
    const pointPos = new Float32Array(n * 3);
    const pointCol = new Float32Array(n * 3);
    const pointSize = new Float32Array(n);

    state.world.forEach((pr, i) => {
      const c = pr.color;
      lineCol.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
      pointCol.set([c.r, c.g, c.b], i * 3);
    });

    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    lineGeom.setAttribute("color", new THREE.BufferAttribute(lineCol, 3));
    state.lineMesh = new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }));
    root.add(state.lineMesh);

    const pointGeom = new THREE.BufferGeometry();
    pointGeom.setAttribute("position", new THREE.BufferAttribute(pointPos, 3));
    pointGeom.setAttribute("color", new THREE.BufferAttribute(pointCol, 3));
    pointGeom.setAttribute("size", new THREE.BufferAttribute(pointSize, 1));
    state.pointMesh = new THREE.Points(pointGeom, new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(4.0, size * (280.0 / max(1.0, -mvPosition.z)));
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          if (length(gl_PointCoord - vec2(0.5, 0.5)) > 0.475) discard;
          gl_FragColor = vec4(vColor, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
    }));
    root.add(state.pointMesh);

    const aiCount = state.world.filter((pr) => pr.aiAppearTs != null).length;
    if (aiCount) {
      // Soft lilac “AI spark” orbs — light on the dark canvas, no harsh arrows.
      const spark = { r: 0.78, g: 0.72, b: 1.0 };
      const aiPos = new Float32Array(aiCount * 3);
      const aiCol = new Float32Array(aiCount * 3);
      const aiSize = new Float32Array(aiCount);
      let j = 0;
      state.world.forEach((pr) => {
        if (pr.aiAppearTs == null) return;
        const y = timeToY(pr.aiAppearTs, state.result);
        pr.aiY = y;
        pr.aiSlot = j;
        aiPos[j * 3] = pr.wx;
        aiPos[j * 3 + 1] = y;
        aiPos[j * 3 + 2] = pr.wz;
        aiCol[j * 3] = spark.r;
        aiCol[j * 3 + 1] = spark.g;
        aiCol[j * 3 + 2] = spark.b;
        aiSize[j] = 22;
        j += 1;
      });
      const aiGeom = new THREE.BufferGeometry();
      aiGeom.setAttribute("position", new THREE.BufferAttribute(aiPos, 3));
      aiGeom.setAttribute("color", new THREE.BufferAttribute(aiCol, 3));
      aiGeom.setAttribute("size", new THREE.BufferAttribute(aiSize, 1));
      state.aiMesh = new THREE.Points(aiGeom, new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: `
          attribute float size;
          attribute vec3 color;
          varying vec3 vColor;
          void main() {
            vColor = color;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = max(8.0, size * (380.0 / max(1.0, -mvPosition.z)));
            gl_Position = projectionMatrix * mvPosition;
          }
        `,
        fragmentShader: `
          varying vec3 vColor;
          void main() {
            vec2 c = gl_PointCoord - vec2(0.5);
            float d = length(c);
            if (d > 0.5) discard;
            float halo = smoothstep(0.5, 0.12, d);
            float core = smoothstep(0.18, 0.0, d);
            vec3 col = mix(vColor, vec3(1.0), core * 0.65);
            float alpha = halo * 0.9;
            gl_FragColor = vec4(col, alpha);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      state.aiMesh.visible = state.showAiMarks;
      root.add(state.aiMesh);
    }

    updatePlayhead(state.now);
  }

  function isShown(pr, now) {
    if (now < pr.startTs) return false;
    if (state.hideEnded && pr.outcome !== "open" && now >= pr.endTs) return false;
    if (!state.hideEnded && (pr.freq || 1) < state.minFreq) return false;
    if (state.entityType === "pull_request" && !pr.isPullRequest) return false;
    if (state.entityType === "issue" && pr.isPullRequest) return false;
    const hasAi = pr.aiAppearTs != null;
    if (state.aiFilter === "ai" && !hasAi) return false;
    if (state.aiFilter === "no_ai" && hasAi) return false;
    return true;
  }

  function updatePlayhead(nowMs) {
    if (!state.result || !state.lineMesh || !state.pointMesh) return;
    const now = nowMs == null ? state.result.tMin - 1 : nowMs;
    state.now = now;
    const linePos = state.lineMesh.geometry.attributes.position.array;
    const pointPos = state.pointMesh.geometry.attributes.position.array;
    const pointSize = state.pointMesh.geometry.attributes.size.array;
    const pointCol = state.pointMesh.geometry.attributes.color.array;
    const aiPos = state.aiMesh ? state.aiMesh.geometry.attributes.position.array : null;

    state.world.forEach((pr, i) => {
      const selected = state.selectedId != null && String(pr.id) === String(state.selectedId);
      const c = selected ? { r: 1, g: 1, b: 1 } : pr.color;
      pointCol[i * 3] = c.r;
      pointCol[i * 3 + 1] = c.g;
      pointCol[i * 3 + 2] = c.b;
      const shown = isShown(pr, now);
      if (!shown) {
        linePos[i * 6] = linePos[i * 6 + 3] = pr.wx;
        linePos[i * 6 + 1] = linePos[i * 6 + 4] = -9999;
        linePos[i * 6 + 2] = linePos[i * 6 + 5] = pr.wz;
        pointPos[i * 3] = pr.wx;
        pointPos[i * 3 + 1] = -9999;
        pointPos[i * 3 + 2] = pr.wz;
        pointSize[i] = 0;
      } else {
        const tipTs = Math.min(now, pr.endTs);
        const y0 = pr.y0;
        let yTip = timeToY(tipTs, state.result);
        if (yTip - y0 < 10) yTip = y0 + 10;
        linePos[i * 6] = pr.wx;
        linePos[i * 6 + 1] = y0;
        linePos[i * 6 + 2] = pr.wz;
        linePos[i * 6 + 3] = pr.wx;
        linePos[i * 6 + 4] = yTip;
        linePos[i * 6 + 5] = pr.wz;
        pointPos[i * 3] = pr.wx;
        pointPos[i * 3 + 1] = yTip;
        pointPos[i * 3 + 2] = pr.wz;
        pointSize[i] = selected ? 18 : (now >= pr.endTs ? 7 : 11);
      }

      if (aiPos && pr.aiAppearTs != null && pr.aiSlot != null) {
        const showAi = state.showAiMarks && shown && now >= pr.aiAppearTs;
        const y = showAi ? pr.aiY : -9999;
        const s = showAi ? 22 : 0;
        aiPos[pr.aiSlot * 3] = pr.wx;
        aiPos[pr.aiSlot * 3 + 1] = y;
        aiPos[pr.aiSlot * 3 + 2] = pr.wz;
        if (state.aiMesh.geometry.attributes.size) {
          state.aiMesh.geometry.attributes.size.array[pr.aiSlot] = s;
        }
      }
    });
    state.pointMesh.geometry.attributes.color.needsUpdate = true;

    state.lineMesh.geometry.attributes.position.needsUpdate = true;
    state.pointMesh.geometry.attributes.position.needsUpdate = true;
    state.pointMesh.geometry.attributes.size.needsUpdate = true;
    if (state.aiMesh) {
      state.aiMesh.visible = state.showAiMarks && state.viewMode === "traces";
      state.aiMesh.geometry.attributes.position.needsUpdate = true;
      if (state.aiMesh.geometry.attributes.size) {
        state.aiMesh.geometry.attributes.size.needsUpdate = true;
      }
    }
  }

  function clearLandscapes() {
    state.landscapeDeform = null;
    while (landscapeGroup.children.length) {
      const obj = landscapeGroup.children.pop();
      obj.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (child.material.map) child.material.map.dispose();
          if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
          else child.material.dispose();
        }
      });
    }
  }

  function easeOutCubic(t) {
    const u = 1 - t;
    return 1 - u * u * u;
  }

  function makeDeformLandscape(points, baseY, result, labelText, hue) {
    const n = points.length;
    if (!n) return null;

    const xs = points.map((p) => p.x);
    const zs = points.map((p) => p.y);
    let minX = Math.min(...xs);
    let maxX = Math.max(...xs);
    let minZ = Math.min(...zs);
    let maxZ = Math.max(...zs);
    const padX = Math.max((maxX - minX) * 0.22, 1e-3);
    const padZ = Math.max((maxZ - minZ) * 0.22, 1e-3);
    minX -= padX;
    maxX += padX;
    minZ -= padZ;
    maxZ += padZ;
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanZ = Math.max(maxZ - minZ, 1e-6);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const scale = PLANE / Math.max(spanX, spanZ);
    const sigma = 0.11 * Math.sqrt(spanX * spanX + spanZ * spanZ);
    const invTwoSig = 1 / (2 * sigma * sigma);
    const push = LAND_DEPTH / Math.max(n * 0.35, 8);

    const res = LAND_RES;
    const influences = [];
    const worldPts = [];
    const order = points
      .map((p, i) => ({ i, t: p.startTs || 0, id: String(p.id) }))
      .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));

    for (let pi = 0; pi < n; pi++) {
      const p = points[pi];
      const hash = String(p.id).split("").reduce((s, ch) => s + ch.charCodeAt(0), 0);
      const jx = ((hash % 7) - 3) * 1.8;
      const jz = (((hash / 7) | 0) % 7 - 3) * 1.8;
      const wx = (p.x - cx) * scale + jx;
      const wz = (p.y - cz) * scale + jz;
      const field = new Float32Array(res * res);
      for (let iz = 0; iz < res; iz++) {
        const z = minZ + (iz / (res - 1)) * spanZ;
        for (let ix = 0; ix < res; ix++) {
          const x = minX + (ix / (res - 1)) * spanX;
          const dx = x - p.x;
          const dz = z - p.y;
          field[iz * res + ix] = push * Math.exp(-(dx * dx + dz * dz) * invTwoSig);
        }
      }
      influences.push(field);
      const color = colorFor(p, result, state.colorMode);
      worldPts.push({
        ...p,
        wx,
        wz,
        color,
        phase: baseY === LAND_TOP_Y ? "before" : "after",
        steps: String(p.sequence || "").split(" → ").filter(Boolean),
        nEvents: String(p.sequence || "").split(" → ").filter(Boolean).length,
        influence: pi,
      });
    }

    const surfPos = new Float32Array(res * res * 3);
    const surfCol = new Float32Array(res * res * 3);
    const gridSize = new Float32Array(res * res);
    const color = new THREE.Color();
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const i = iz * res + ix;
        const x = minX + (ix / (res - 1)) * spanX;
        const z = minZ + (iz / (res - 1)) * spanZ;
        surfPos[i * 3] = (x - cx) * scale;
        surfPos[i * 3 + 1] = baseY;
        surfPos[i * 3 + 2] = (z - cz) * scale;
        color.setHSL(hue, 0.65, 0.62);
        surfCol[i * 3] = color.r;
        surfCol[i * 3 + 1] = color.g;
        surfCol[i * 3 + 2] = color.b;
        gridSize[i] = 3.2;
      }
    }

    // Grid lines: row + column edges through the height field.
    const lineIdx = [];
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res - 1; ix++) {
        const a = iz * res + ix;
        lineIdx.push(a, a + 1);
      }
    }
    for (let ix = 0; ix < res; ix++) {
      for (let iz = 0; iz < res - 1; iz++) {
        const a = iz * res + ix;
        lineIdx.push(a, a + res);
      }
    }
    const linePos = new Float32Array(lineIdx.length * 3);
    const lineCol = new Float32Array(lineIdx.length * 3);
    for (let i = 0; i < lineIdx.length; i++) {
      const v = lineIdx[i];
      linePos[i * 3] = surfPos[v * 3];
      linePos[i * 3 + 1] = surfPos[v * 3 + 1];
      linePos[i * 3 + 2] = surfPos[v * 3 + 2];
      lineCol[i * 3] = surfCol[v * 3];
      lineCol[i * 3 + 1] = surfCol[v * 3 + 1];
      lineCol[i * 3 + 2] = surfCol[v * 3 + 2];
    }

    const gridPointGeom = new THREE.BufferGeometry();
    gridPointGeom.setAttribute("position", new THREE.BufferAttribute(surfPos, 3));
    gridPointGeom.setAttribute("color", new THREE.BufferAttribute(surfCol, 3));
    gridPointGeom.setAttribute("size", new THREE.BufferAttribute(gridSize, 1));
    const gridPoints = new THREE.Points(gridPointGeom, new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = 0.45;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(2.0, size * (220.0 / max(1.0, -mvPosition.z)));
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          if (length(gl_PointCoord - vec2(0.5, 0.5)) > 0.475) discard;
          gl_FragColor = vec4(vColor, vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
    }));

    const gridLineGeom = new THREE.BufferGeometry();
    gridLineGeom.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    gridLineGeom.setAttribute("color", new THREE.BufferAttribute(lineCol, 3));
    const gridLines = new THREE.LineSegments(gridLineGeom, new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    }));

    const pointPos = new Float32Array(n * 3);
    const pointCol = new Float32Array(n * 3);
    const pointSize = new Float32Array(n);
    worldPts.forEach((p, i) => {
      pointPos[i * 3] = p.wx;
      pointPos[i * 3 + 1] = baseY + LAND_DROP;
      pointPos[i * 3 + 2] = p.wz;
      pointCol[i * 3] = p.color.r;
      pointCol[i * 3 + 1] = p.color.g;
      pointCol[i * 3 + 2] = p.color.b;
      pointSize[i] = 10;
    });
    const pointGeom = new THREE.BufferGeometry();
    pointGeom.setAttribute("position", new THREE.BufferAttribute(pointPos, 3));
    pointGeom.setAttribute("color", new THREE.BufferAttribute(pointCol, 3));
    pointGeom.setAttribute("size", new THREE.BufferAttribute(pointSize, 1));
    const pointMesh = new THREE.Points(pointGeom, new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(5.0, size * (280.0 / max(1.0, -mvPosition.z)));
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          if (length(gl_PointCoord - vec2(0.5, 0.5)) > 0.475) discard;
          gl_FragColor = vec4(vColor, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
    }));

    const lab = makeSpriteLabel(labelText, hue < 0.3 ? "#ffcc66" : "#66ffcc");
    lab.visible = false;
    lab.position.set(0, baseY + LAND_DROP + 28, 0);
    lab.scale.set(140, 28, 1);

    const group = new THREE.Group();
    group.add(gridLines);
    group.add(gridPoints);
    group.add(pointMesh);
    group.add(lab);
    group.userData = {
      world: worldPts,
      pointMesh,
      gridPoints,
      gridLines,
      surfPos,
      surfCol,
      linePos,
      lineCol,
      lineIdx,
      pointPos,
      baseY,
      hue,
      res,
      influences,
      order,
      landed: new Array(n).fill(0),
      minX,
      maxX,
      minZ,
      maxZ,
      cx,
      cz,
      scale,
    };
    return group;
  }

  function surfaceYAt(layer, wx, wz) {
    const ud = layer.userData;
    const spanX = ud.maxX - ud.minX;
    const spanZ = ud.maxZ - ud.minZ;
    const fx = ((wx / ud.scale) + ud.cx - ud.minX) / spanX;
    const fz = ((wz / ud.scale) + ud.cz - ud.minZ) / spanZ;
    const x = Math.max(0, Math.min(ud.res - 1.0001, fx * (ud.res - 1)));
    const z = Math.max(0, Math.min(ud.res - 1.0001, fz * (ud.res - 1)));
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const x1 = Math.min(ud.res - 1, x0 + 1);
    const z1 = Math.min(ud.res - 1, z0 + 1);
    const tx = x - x0;
    const tz = z - z0;
    const y00 = ud.surfPos[(z0 * ud.res + x0) * 3 + 1];
    const y10 = ud.surfPos[(z0 * ud.res + x1) * 3 + 1];
    const y01 = ud.surfPos[(z1 * ud.res + x0) * 3 + 1];
    const y11 = ud.surfPos[(z1 * ud.res + x1) * 3 + 1];
    const y0 = y00 * (1 - tx) + y10 * tx;
    const y1 = y01 * (1 - tx) + y11 * tx;
    return y0 * (1 - tz) + y1 * tz;
  }

  function applyLandscapeDeform(progress) {
    if (!state.landscapeDeform) return;
    const color = new THREE.Color();
    for (const layer of state.landscapeDeform.layers) {
      if (!layer.visible) continue;
      const ud = layer.userData;
      const n = ud.world.length;
      const res = ud.res;
      const heights = new Float32Array(res * res);
      const landCount = Math.floor(progress * n + 1e-6);
      const frac = progress * n - landCount;

      for (let k = 0; k < n; k++) {
        const idx = ud.order[k].i;
        let land = 0;
        if (k < landCount) land = 1;
        else if (k === landCount) land = easeOutCubic(Math.max(0, Math.min(1, frac)));
        ud.landed[idx] = land;
        if (land <= 0) continue;
        const field = ud.influences[idx];
        for (let g = 0; g < field.length; g++) heights[g] += field[g] * land;
      }

      let maxH = 0;
      for (let g = 0; g < heights.length; g++) if (heights[g] > maxH) maxH = heights[g];
      const norm = maxH > LAND_DEPTH ? LAND_DEPTH / maxH : 1;

      for (let i = 0; i < res * res; i++) {
        const depth = heights[i] * norm;
        ud.surfPos[i * 3 + 1] = ud.baseY - depth;
        const t = Math.min(1, depth / Math.max(LAND_DEPTH * 0.85, 1));
        color.setHSL(ud.hue, 0.75, 0.58 - t * 0.38);
        ud.surfCol[i * 3] = color.r;
        ud.surfCol[i * 3 + 1] = color.g;
        ud.surfCol[i * 3 + 2] = color.b;
      }
      ud.gridPoints.geometry.attributes.position.needsUpdate = true;
      ud.gridPoints.geometry.attributes.color.needsUpdate = true;
      for (let i = 0; i < ud.lineIdx.length; i++) {
        const v = ud.lineIdx[i];
        ud.linePos[i * 3] = ud.surfPos[v * 3];
        ud.linePos[i * 3 + 1] = ud.surfPos[v * 3 + 1];
        ud.linePos[i * 3 + 2] = ud.surfPos[v * 3 + 2];
        ud.lineCol[i * 3] = ud.surfCol[v * 3];
        ud.lineCol[i * 3 + 1] = ud.surfCol[v * 3 + 1];
        ud.lineCol[i * 3 + 2] = ud.surfCol[v * 3 + 2];
      }
      ud.gridLines.geometry.attributes.position.needsUpdate = true;
      ud.gridLines.geometry.attributes.color.needsUpdate = true;

      for (let i = 0; i < n; i++) {
        const land = ud.landed[i];
        const p = ud.world[i];
        const surfaceY = surfaceYAt(layer, p.wx, p.wz);
        const y = land <= 0
          ? ud.baseY + LAND_DROP
          : (ud.baseY + LAND_DROP) * (1 - land) + surfaceY * land;
        ud.pointPos[i * 3 + 1] = y;
        p.wy = y;
      }
      ud.pointMesh.geometry.attributes.position.needsUpdate = true;
    }
    state.landscapeWorld = [];
    for (const layer of state.landscapeDeform.layers) {
      if (layer.visible) state.landscapeWorld.push(...layer.userData.world);
    }
  }

  function startLandscapeDeform() {
    if (!state.landscapeDeform || !state.landscapeDeform.layers.length) return;
    state.landscapeDeform.playing = true;
    state.landscapeDeform.t0 = performance.now();
    state.playing = false;
    applyLandscapeDeform(0);
  }

  function buildLandscapes() {
    clearLandscapes();
    state.landscapeWorld = [];
    if (!state.result || !state.result.traces) return;

    // Rebuild manifolds from the same filtered traces as the Show control.
    const lands = buildAiLandscapesForTraces(state.result.traces, {
      distanceMode: state.result.distanceMode || "both",
      directed: state.result.directed !== false,
      entityType: state.entityType || "both",
    });
    state.activeLandscapes = lands;
    const layers = [];

    if (lands.before && lands.before.points && lands.before.points.length) {
      const before = makeDeformLandscape(
        lands.before.points,
        LAND_TOP_Y,
        state.result,
        "BEFORE AI",
        0.52
      );
      if (before) {
        before.name = "before";
        landscapeGroup.add(before);
        layers.push(before);
      }
    }
    if (lands.after && lands.after.points && lands.after.points.length) {
      const after = makeDeformLandscape(
        lands.after.points,
        LAND_BOT_Y,
        state.result,
        "AFTER AI",
        0.1
      );
      if (after) {
        after.name = "after";
        landscapeGroup.add(after);
        layers.push(after);
      }
    }
    state.landscapeDeform = {
      playing: false,
      t0: 0,
      durationSec: Math.max(8, Number(state.durationSec) || 24),
      layers,
    };
    syncLandscapeVisibility();
    applyLandscapeDeform(0);
    if (state.viewMode === "ai_landscape") startLandscapeDeform();
  }

  function frameForViewMode(prevMode) {
    if (state.viewMode === prevMode) return;
    if (state.viewMode === "ai_landscape") {
      const mid = (LAND_TOP_Y + LAND_BOT_Y) * 0.5;
      controls.target.set(0, mid - 30, 0);
      camera.position.set(540, mid + 200, 780);
    } else {
      controls.target.set(0, TIME_H * 0.45, 0);
      camera.position.set(520, 420, 720);
    }
    controls.update();
  }

  function syncLandscapeVisibility() {
    const on = state.viewMode === "ai_landscape";
    landscapeGroup.visible = on;
    root.visible = !on;
    for (const child of landscapeGroup.children) {
      if (child.name === "before") {
        child.visible = state.landscapeShow === "both" || state.landscapeShow === "before";
      }
      if (child.name === "after") {
        child.visible = state.landscapeShow === "both" || state.landscapeShow === "after";
      }
    }
    // Time axis is for traces mode.
    timeGroup.visible = state.showTime && !on;
  }

  function syncGuideVisibility() {
    axesGroup.visible = state.showAxes && state.viewMode !== "ai_landscape";
    syncLandscapeVisibility();
    timeAxisHint.visible = state.showTime && !state.showAxes && state.viewMode !== "ai_landscape";
  }

  function render(result, options = {}) {
    state.colorMode = options.colorMode || state.colorMode;
    state.durationSec = options.durationSec || state.durationSec;
    if (options.hideEnded != null) state.hideEnded = options.hideEnded;
    if (options.minFreq != null) state.minFreq = options.minFreq;
    if (options.entityType != null) state.entityType = options.entityType;
    if (options.aiFilter != null) state.aiFilter = options.aiFilter;
    if (options.showAxes != null) state.showAxes = options.showAxes;
    if (options.showTime != null) state.showTime = options.showTime;
    if (options.showAiMarks != null) state.showAiMarks = options.showAiMarks;
    const prevMode = state.viewMode;
    if (options.viewMode != null) state.viewMode = options.viewMode;
    if (options.landscapeShow != null) state.landscapeShow = options.landscapeShow;
    if (options.autoRotate != null) {
      state.autoRotate = options.autoRotate;
      controls.autoRotate = options.autoRotate;
    }
    frameForViewMode(prevMode);
    syncGuideVisibility();
    if (state.aiMesh) state.aiMesh.visible = state.showAiMarks && state.viewMode === "traces";
    state.result = result;
    state.playing = false;
    if (!result || !result.traces.length) {
      state.world = [];
      clearRoot();
      clearLandscapes();
      rebuildMonthLabels(null);
      return;
    }
    state.world = toWorld(result);
    state.now = result.tMax;
    state.selectedId = null;
    if (onSelect) onSelect(null);
    rebuildMonthLabels(result);
    buildMeshes();
    buildLandscapes();
    syncGuideVisibility();
  }

  function setTime(nowMs) {
    updatePlayhead(nowMs);
  }

  function startFrom(startNow) {
    if (!state.result) return;
    state.now = startNow;
    updatePlayhead(state.now);
    state.playing = true;
    state.playStartReal = performance.now();
    state.playStartNow = startNow;
  }

  function play() {
    if (!state.result) return;
    if (state.viewMode === "ai_landscape") {
      if (state.landscapeDeform) {
        state.landscapeDeform.durationSec = Math.max(6, Number(state.durationSec) || 24);
      }
      startLandscapeDeform();
      return;
    }
    startFrom(state.result.tMin);
  }

  function resume() {
    if (!state.result) return;
    if (state.viewMode === "ai_landscape") {
      play();
      return;
    }
    const now = state.now;
    if (now == null || now < state.result.tMin || now >= state.result.tMax) {
      startFrom(state.result.tMin);
      return;
    }
    startFrom(now);
  }

  function stop() {
    state.playing = false;
    if (state.landscapeDeform) state.landscapeDeform.playing = false;
  }

  function reset() {
    state.playing = false;
    if (state.viewMode === "ai_landscape") {
      if (state.landscapeDeform) state.landscapeDeform.playing = false;
      applyLandscapeDeform(0);
      return;
    }
    if (state.result) updatePlayhead(state.result.tMin - 1);
  }

  function tick() {
    if (state.viewMode === "ai_landscape" && state.landscapeDeform && state.landscapeDeform.playing) {
      const dur = Math.max(6, state.landscapeDeform.durationSec || state.durationSec || 24);
      const elapsed = (performance.now() - state.landscapeDeform.t0) / 1000;
      const p = Math.min(1, elapsed / dur);
      applyLandscapeDeform(p);
      if (p >= 1) state.landscapeDeform.playing = false;
      return;
    }
    if (state.playing && state.result) {
      const elapsed = (performance.now() - state.playStartReal) / 1000;
      const span = Math.max(state.result.tMax - state.result.tMin, 1);
      const next = state.playStartNow + (elapsed / state.durationSec) * span;
      if (next >= state.result.tMax) {
        updatePlayhead(state.result.tMax);
        state.playing = false;
      } else {
        updatePlayhead(next);
      }
    }
  }

  function resize() {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function pick(event) {
    if (state.viewMode === "ai_landscape") {
      const meshes = [];
      for (const child of landscapeGroup.children) {
        if (!child.visible) continue;
        if (child.userData.pointMesh) meshes.push(child.userData.pointMesh);
      }
      if (!meshes.length) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(meshes, false);
      if (!hits.length) return null;
      const mesh = hits[0].object;
      const idx = hits[0].index;
      const parent = mesh.parent;
      const world = parent && parent.userData.world;
      return world && world[idx] ? world[idx] : null;
    }
    if (!state.pointMesh) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(state.pointMesh, false);
    if (!hits.length) return null;
    const idx = hits[0].index;
    const pr = state.world[idx];
    if (!pr || !isShown(pr, state.now)) return null;
    return pr;
  }

  function loop() {
    tick();
    controls.update();
    updateTimeGuidePose();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }

  function selectPr(pr) {
    state.selectedId = pr ? pr.id : null;
    updatePlayhead(state.now);
    if (onSelect) onSelect(pr);
  }

  renderer.domElement.addEventListener("pointerdown", (event) => {
    state.pointerDown = { x: event.clientX, y: event.clientY };
  });
  renderer.domElement.addEventListener("pointerup", (event) => {
    const start = state.pointerDown;
    state.pointerDown = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (dx * dx + dy * dy > 16) return;
    selectPr(pick(event));
  });
  let hoverAt = 0;
  renderer.domElement.addEventListener("pointermove", (event) => {
    const t = performance.now();
    if (t - hoverAt < 40) return;
    hoverAt = t;
    const pr = pick(event);
    renderer.domElement.style.cursor = pr ? "pointer" : "grab";
    if (onHover) onHover(pr);
  });
  renderer.domElement.addEventListener("pointerleave", () => {
    if (onHover) onHover(null);
  });
  window.addEventListener("resize", resize);
  resize();
  loop();

  return {
    render,
    setTime,
    play,
    resume,
    stop,
    reset,
    isPlaying: () => state.playing || !!(state.landscapeDeform && state.landscapeDeform.playing),
    getNow: () => state.now,
    getActiveLandscapes: () => state.activeLandscapes || (state.result && state.result.landscapes) || null,
    clearSelection() {
      selectPr(null);
    },
    setOptions(options) {
      if (options.durationSec) state.durationSec = options.durationSec;
      if (options.hideEnded != null) state.hideEnded = options.hideEnded;
      if (options.minFreq != null) state.minFreq = options.minFreq;
      if (options.entityType != null) state.entityType = options.entityType;
      if (options.aiFilter != null) state.aiFilter = options.aiFilter;
      if (options.showAxes != null) state.showAxes = options.showAxes;
      if (options.showTime != null) state.showTime = options.showTime;
      if (options.showAiMarks != null) {
        state.showAiMarks = options.showAiMarks;
        if (state.aiMesh) state.aiMesh.visible = options.showAiMarks && state.viewMode === "traces";
        if (state.result) updatePlayhead(state.now);
      }
      const prevMode = state.viewMode;
      if (options.viewMode != null) state.viewMode = options.viewMode;
      if (options.landscapeShow != null) state.landscapeShow = options.landscapeShow;
      if (options.viewMode != null || options.landscapeShow != null) {
        frameForViewMode(prevMode);
        syncGuideVisibility();
        if (options.viewMode === "ai_landscape") startLandscapeDeform();
      }
      if (options.showAxes != null || options.showTime != null) syncGuideVisibility();
      if (options.autoRotate != null) {
        state.autoRotate = options.autoRotate;
        controls.autoRotate = options.autoRotate;
      }
      if ((options.hideEnded != null || options.minFreq != null || options.entityType != null || options.aiFilter != null) && state.result) {
        updatePlayhead(state.now);
        if (options.entityType != null) {
          buildLandscapes();
          syncGuideVisibility();
        }
      }
      if (options.colorMode && options.colorMode !== state.colorMode && state.result) {
        state.colorMode = options.colorMode;
        const keep = state.now;
        const playing = state.playing;
        state.world = toWorld(state.result);
        buildMeshes();
        buildLandscapes();
        updatePlayhead(keep);
        state.playing = playing;
        syncGuideVisibility();
      }
    },
  };
}
