import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const PLANE = 600;
const TIME_H = 420;

const OUTCOME_COLOR = {
  merged: new THREE.Color(0x00ffff),
  closed: new THREE.Color(0xff66cc),
  deleted: new THREE.Color(0xffaa33),
  open: new THREE.Color(0x88ff66),
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
  controls.target.set(0, TIME_H * 0.45, 0);

  const axesGroup = new THREE.Group();
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

  const monthTicks = new THREE.Group();
  axesGroup.add(monthTicks);
  const labZ = makeSpriteLabel("PROCESS MDS2 (Z)", "#4444ff");
  labZ.position.set(0, 12, 450);
  labZ.scale.set(140, 28, 1);
  axesGroup.add(labZ);

  const root = new THREE.Group();
  scene.add(root);

  const state = {
    result: null,
    world: [],
    now: null,
    colorMode: "created",
    lineMesh: null,
    pointMesh: null,
    playing: false,
    playStartReal: 0,
    playStartNow: 0,
    durationSec: 24,
    selectedId: null,
    pointerDown: null,
    hideEnded: false,
    minFreq: 1,
    showAxes: true,
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
      label.position.set(-430, y, 0);
      label.scale.set(80, 20, 1);
      monthTicks.add(label);
      const mark = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-20, y, 0),
          new THREE.Vector3(20, y, 0),
        ]),
        new THREE.LineBasicMaterial({ color: 0x226633 })
      );
      monthTicks.add(mark);
    }
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
    updatePlayhead(state.now);
  }

  function isShown(pr, now) {
    if (now < pr.startTs) return false;
    if (state.hideEnded && pr.outcome !== "open" && now >= pr.endTs) return false;
    if (!state.hideEnded && (pr.freq || 1) < state.minFreq) return false;
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

    state.world.forEach((pr, i) => {
      const selected = state.selectedId != null && String(pr.id) === String(state.selectedId);
      const c = selected ? { r: 1, g: 1, b: 1 } : pr.color;
      pointCol[i * 3] = c.r;
      pointCol[i * 3 + 1] = c.g;
      pointCol[i * 3 + 2] = c.b;
      if (!isShown(pr, now)) {
        linePos[i * 6] = linePos[i * 6 + 3] = pr.wx;
        linePos[i * 6 + 1] = linePos[i * 6 + 4] = -9999;
        linePos[i * 6 + 2] = linePos[i * 6 + 5] = pr.wz;
        pointPos[i * 3] = pr.wx;
        pointPos[i * 3 + 1] = -9999;
        pointPos[i * 3 + 2] = pr.wz;
        pointSize[i] = 0;
        return;
      }
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
    });
    state.pointMesh.geometry.attributes.color.needsUpdate = true;

    state.lineMesh.geometry.attributes.position.needsUpdate = true;
    state.pointMesh.geometry.attributes.position.needsUpdate = true;
    state.pointMesh.geometry.attributes.size.needsUpdate = true;
  }

  function render(result, options = {}) {
    state.colorMode = options.colorMode || state.colorMode;
    state.durationSec = options.durationSec || state.durationSec;
    if (options.hideEnded != null) state.hideEnded = options.hideEnded;
    if (options.minFreq != null) state.minFreq = options.minFreq;
    if (options.showAxes != null) {
      state.showAxes = options.showAxes;
      axesGroup.visible = options.showAxes;
    }
    state.result = result;
    state.playing = false;
    if (!result || !result.traces.length) {
      state.world = [];
      clearRoot();
      rebuildMonthLabels(null);
      return;
    }
    state.world = toWorld(result);
    state.now = result.tMax;
    state.selectedId = null;
    if (onSelect) onSelect(null);
    rebuildMonthLabels(result);
    buildMeshes();
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
    startFrom(state.result.tMin);
  }

  function resume() {
    if (!state.result) return;
    const now = state.now;
    if (now == null || now < state.result.tMin || now >= state.result.tMax) {
      startFrom(state.result.tMin);
      return;
    }
    startFrom(now);
  }

  function stop() {
    state.playing = false;
  }

  function reset() {
    state.playing = false;
    if (state.result) updatePlayhead(state.result.tMin - 1);
  }

  function tick() {
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
    isPlaying: () => state.playing,
    getNow: () => state.now,
    clearSelection() {
      selectPr(null);
    },
    setOptions(options) {
      if (options.durationSec) state.durationSec = options.durationSec;
      if (options.hideEnded != null) state.hideEnded = options.hideEnded;
      if (options.minFreq != null) state.minFreq = options.minFreq;
      if (options.showAxes != null) {
        state.showAxes = options.showAxes;
        axesGroup.visible = options.showAxes;
      }
      if ((options.hideEnded != null || options.minFreq != null) && state.result) {
        updatePlayhead(state.now);
      }
      if (options.colorMode && options.colorMode !== state.colorMode && state.result) {
        state.colorMode = options.colorMode;
        const keep = state.now;
        const playing = state.playing;
        state.world = toWorld(state.result);
        buildMeshes();
        updatePlayhead(keep);
        state.playing = playing;
      }
    },
  };
}
