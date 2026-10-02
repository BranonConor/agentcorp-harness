import * as THREE from "three";
import { DESKS } from "./simulation";
import type { Agent, RequestStatus, Simulation } from "./simulation";
import {
  EXTRA_DESKS, LIVE_COFFEE_COUNTER, LIVE_COFFEE_Z, LIVE_DIVIDER_END_Z, LIVE_DIVIDER_START_Z,
  LIVE_DIVIDER_PLANTS, LIVE_DIVIDER_X,
  LIVE_LOUNGE_SOFA_X, LIVE_LOUNGE_Z, LIVE_ROOM, LIVE_RUG_X,
  deskPropsFor, isLoungeSeat,
} from "./live-layout";
import { sampleDaylight } from "./lighting";
import { interpolatePosition } from "./animation";
import {
  agentArt, happyMachinesNeonArt, bookcaseArt, chairArt, chatRoomTitleArt,
  coffeeCounterArt, contextConsoleArt, coreBodyArt, deskArt, deskDetailArt,
  liveNoticeArt, loungeFrontArt, loungeSofaArt, monitorArt, monitorEmissionArt,
  monsteraArt, posterArt, stackArt, stationNoticeArt, statusLightArt, workflowKitArt,
} from "./sprite-art";
import type { AgentArt, Facing, LiveNoticeActivity } from "./sprite-art";

const palette = {
  edge: 0x5e5263,
  wall: 0x917880,
  wallTop: 0xf2c595,
  cream: 0xffe2ad,
  lavender: 0xbba6eb,
};
const gameRoom = { halfWidth: 7.7, back: -5.2, front: 5.8, windowY: 1.72 };
const gameWindowXs = [-4.8, 0, 4.8];
const cutoutYaw = 0;
const gameCameraBase = new THREE.Vector3(0, 15, 20);
const coreDisplay = { x: -3.8, z: -2.2 };
const deskPropOffsets = [-0.56, 0.55] as const;
const moonColor = new THREE.Color(0xa9c9ff);
const moonAmbient = new THREE.Color(0xb8cbea);
const moonBounce = new THREE.Color(0xb4ccf4);
const warmAmbient = new THREE.Color(0xffdac1);
const nightFoliage = new THREE.Color(0x728baa);

function material(color: number, emissive = 0, intensity = 0) {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.88, flatShading: true, emissive, emissiveIntensity: intensity,
  });
}

function woodFloorTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 768;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is required for the office floor.");
  ctx.fillStyle = "#785a51";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const colors = ["#d8af83", "#cba076", "#dfb78c", "#d2a77b", "#c59a72", "#dbb287"];
  const hash = (x: number, y: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
  for (let row = 0; row < 12; row++) {
    const y = row * 64;
    let x = row % 2 ? -116 : -20;
    let board = 0;
    while (x < canvas.width) {
      const seed = hash(board, row);
      const width = 188 + (seed % 53);
      ctx.fillStyle = colors[seed % colors.length];
      ctx.fillRect(x + 2, y + 2, width - 3, 61);
      ctx.fillStyle = "#fff0cb20";
      ctx.fillRect(x + 5, y + 4, width - 9, 2);
      ctx.fillStyle = "#573e4a18";
      ctx.fillRect(x + 3, y + 58, width - 5, 3);
      for (let grain = 0; grain < 7; grain++) {
        const grainY = y + 9 + (hash(board * 7 + grain, row) % 46);
        ctx.fillStyle = grain % 2 ? "#633f3920" : "#ffe2ac32";
        ctx.fillRect(x + 12 + (grain % 3) * 8, grainY, width - 36 - (grain % 3) * 15, 1);
      }
      x += width;
      board++;
    }
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  return map;
}

function wovenRugTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 192;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is required for the office rugs.");
  ctx.fillStyle = "#615968";
  ctx.fillRect(0, 0, 128, 192);
  ctx.fillStyle = "#e1c39c";
  ctx.fillRect(5, 5, 118, 182);
  ctx.fillStyle = "#899d91";
  ctx.fillRect(12, 12, 104, 168);
  for (let y = 18; y < 176; y += 10) {
    for (let x = 18; x < 112; x += 10) {
      ctx.fillStyle = (x + y) % 20 < 10 ? "#acc0a5" : "#708a86";
      ctx.fillRect(x, y, 4, 4);
    }
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.NearestFilter;
  return map;
}

function screenHaloTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is required for monitor light.");
  const glow = ctx.createRadialGradient(32, 32, 6, 32, 32, 32);
  glow.addColorStop(0, "#ffffffca");
  glow.addColorStop(0.36, "#ffffff85");
  glow.addColorStop(1, "#ffffff00");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 64, 64);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.LinearFilter;
  return map;
}

function steamTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is required for coffee steam.");
  const fade = ctx.createLinearGradient(0, 0, 0, 96);
  fade.addColorStop(0, "#f3faf000");
  fade.addColorStop(0.23, "#e8f4ef82");
  fade.addColorStop(0.55, "#f5f8eebb");
  fade.addColorStop(0.82, "#edf4efa0");
  fade.addColorStop(1, "#f3faf000");
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = fade;
  for (const [x, bend] of [[23, -1], [39, 1]]) {
    ctx.beginPath();
    ctx.moveTo(x, 92);
    ctx.bezierCurveTo(x + bend * 5, 72, x - bend * 8, 59, x + bend * 2, 43);
    ctx.bezierCurveTo(x + bend * 12, 26, x - bend * 6, 15, x, 4);
    ctx.lineWidth = 12;
    ctx.shadowColor = "#f3f8ef99";
    ctx.shadowBlur = 8;
    ctx.filter = "blur(3px)";
    ctx.globalAlpha = 0.78;
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.shadowBlur = 0;
    ctx.filter = "none";
    ctx.globalAlpha = 0.16;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = map.minFilter = THREE.LinearFilter;
  map.generateMipmaps = false;
  return map;
}

function sconceWashTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is required for the wall lights.");
  const glow = ctx.createRadialGradient(48, 41, 3, 48, 62, 64);
  glow.addColorStop(0, "#fff2d7e8");
  glow.addColorStop(0.28, "#ffd6a5ad");
  glow.addColorStop(0.65, "#eeb78548");
  glow.addColorStop(1, "#eeb78500");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.LinearFilter;
  return map;
}

function windowFoliageTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is required for the window garden.");
  for (const [color, y, radius] of [
    ["#426e6b", 83, 23], ["#5c8971", 89, 21], ["#83a77a", 96, 17],
  ] as const) {
    ctx.fillStyle = color;
    for (let x = -15; x < 150; x += 21) {
      ctx.beginPath();
      ctx.ellipse(x + (x % 3) * 3, y - (x % 4) * 4, radius, 18, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (let i = 0; i < 42; i++) {
    const x = (Math.imul(i + 11, 47) % 128 + 128) % 128;
    const y = 67 + (Math.imul(i + 3, 31) % 29);
    ctx.fillStyle = i % 3 ? "#b6c490" : "#365e63";
    ctx.fillRect(x, y, 2 + (i % 3), 1);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  return map;
}

function block(
  parent: THREE.Object3D, x: number, y: number, z: number,
  width: number, height: number, depth: number, color: number,
  emissive = 0, intensity = 0,
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material(color, emissive, intensity));
  mesh.position.set(x, y, z);
  mesh.castShadow = height > 0.17;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cutout(
  parent: THREE.Object3D, map: THREE.Texture, x: number, y: number, z: number,
  width: number, height: number, castsShadow = false,
) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshStandardMaterial({
      map, alphaTest: 0.38, side: THREE.DoubleSide, roughness: 1,
      emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.24,
    }),
  );
  mesh.position.set(x, y, z);
  mesh.rotation.y = cutoutYaw;
  mesh.castShadow = castsShadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function createSteamEmitter(parent: THREE.Object3D, map: THREE.Texture,
  x: number, y: number, z: number, width: number, height: number) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  const wisps = Array.from({ length: 2 }, () => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        map, transparent: true, opacity: 0, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false,
      }),
    );
    group.add(mesh);
    return mesh;
  });
  parent.add(group);
  return { group, wisps, width, height };
}

function label(text: string, color = "#4e4762") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is required for office signs.");
  ctx.fillStyle = "#574c5a";
  ctx.fillRect(4, 4, 248, 56);
  ctx.strokeStyle = "#d4a986";
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, 248, 56);
  ctx.fillStyle = color === "#4e4762" ? "#f9e5bb" : color;
  ctx.font = "bold 25px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(1.65, 0.42, 1);
  return sprite;
}

function desk(scene: THREE.Object3D, x: number, z: number, index: number,
  track: (art: THREE.CanvasTexture) => THREE.CanvasTexture, variant: "game" | "live") {
  cutout(scene, track(deskArt(index)), x, 0.58, z - 0.56, 1.55, 1.23, true);
  const monitor = cutout(scene, track(monitorArt(index, true, variant)), x - 0.1, 1.08, z - 0.67, 0.77, 0.77);
  cutout(scene, track(chairArt()), x + 0.35, 0.49, z + 0.37, 0.66, 0.94, true);
  if (variant === "live") {
    for (const [slot, kind] of deskPropsFor(index).entries()) {
      cutout(scene, track(deskDetailArt(kind, index)),
        x + deskPropOffsets[slot], 0.96, z - 0.45, 0.4, 0.43);
    }
  }
  return monitor;
}

function createAgent(id: number, shadowTexture: THREE.Texture, frames: AgentArt) {
  const group = new THREE.Group();
  const backing = cutout(group, frames.idle.away, 0.035, 0.68, -0.065, 0.99, 1.35);
  (backing.material as THREE.MeshStandardMaterial).color.setHex(0x766577);
  (backing.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
  backing.castShadow = false;
  backing.receiveShadow = false;
  const figure = cutout(group, frames.idle.away, 0, 0.67, 0, 0.95, 1.32);
  (figure.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.44;
  figure.castShadow = true;
  backing.rotation.y = 0;
  figure.rotation.y = 0;
  group.rotation.y = cutoutYaw;
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.6, 0.38),
    new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, opacity: 0.55, toneMapped: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = 3;
  return { group, backing, figure, frames, facing: "away" as Facing, shadow, idleBlend: 0 };
}

export type World = {
  capturePositions: () => void;
  setUpgrades: (ids: readonly string[]) => void;
  render: (elapsed: number, previewOffset: number, alpha: number, advanced: boolean) => void;
  focusAgent: (index: number | null) => void;
  setAgentPersona: (index: number, persona: number) => void;
  projectDesk: (index: number) => { x: number; y: number } | null;
  projectAgent: (index: number) => { x: number; y: number } | null;
  dispose: () => void;
};

export type WorldInteraction = {
  onAgentHover: (index: number | null, clientX: number, clientY: number) => void;
  onAgentSelect: (index: number) => void;
  onEmptySelect?: (clientX: number, clientY: number) => void;
  onFocusCleared?: () => void;
  noticeActivityForStation?: (index: number) => LiveNoticeActivity | null;
};

export function createWorld(host: HTMLElement, simulation: Simulation, variant: "game" | "live" = "game",
  interaction?: WorldInteraction): World {
  const isLive = variant === "live";
  if (isLive && !interaction?.noticeActivityForStation) {
    throw new Error("Live office needs a notice activity source.");
  }
  const room = isLive ? LIVE_ROOM : gameRoom;
  const windowXs = isLive ? [-6.4, -2.05, 2.05, 6.4] : gameWindowXs;
  const cameraBase = isLive ? new THREE.Vector3(0, 18, 26) : gameCameraBase;
  const coffeeZ = isLive ? LIVE_COFFEE_Z : 3.55;
  const stationPositions = isLive ? [...DESKS, ...EXTRA_DESKS] : DESKS;
  const scene = new THREE.Scene();
  const artTextures: THREE.Texture[] = [];
  const track = <T extends THREE.Texture>(art: T): T => {
    artTextures.push(art);
    return art;
  };
  const steamMap = isLive ? track(steamTexture()) : null;
  const steamEmitters: ReturnType<typeof createSteamEmitter>[] = [];
  const addSteam = (parent: THREE.Object3D, x: number, y: number, z: number,
    width: number, height: number) => {
    if (!steamMap) throw new Error("Coffee steam is only available in the live office.");
    const emitter = createSteamEmitter(parent, steamMap, x, y, z, width, height);
    steamEmitters.push(emitter);
    return emitter.group;
  };
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.copy(cameraBase);
  camera.lookAt(0, 0.4, 0);
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.domElement.className = "world-canvas";
  renderer.domElement.setAttribute("aria-label", "Perspective view of the little AI office");
  renderer.domElement.setAttribute("role", "img");
  host.appendChild(renderer.domElement);
  let contextLost = false;
  const onContextLost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
    host.classList.add("context-lost");
  };
  const onContextRestored = () => {
    contextLost = false;
    renderer.shadowMap.needsUpdate = true;
    host.classList.remove("context-lost");
  };
  renderer.domElement.addEventListener("webglcontextlost", onContextLost);
  renderer.domElement.addEventListener("webglcontextrestored", onContextRestored);
  const skyMaterial = new THREE.ShaderMaterial({
    depthWrite: false,
    side: THREE.BackSide,
    toneMapped: false,
    uniforms: {
      uDay: { value: 0.7 },
      uWarm: { value: 0.8 },
      uTime: { value: 0 },
      uSun: { value: new THREE.Vector3(1, 1, -1) },
      uSkyTint: { value: new THREE.Color(0x89d9d0) },
    },
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vDirection;
      uniform float uDay;
      uniform float uWarm;
      uniform float uTime;
      uniform vec3 uSun;
      uniform vec3 uSkyTint;
      float hash(vec3 p) {
        return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
      }
      void main() {
        vec3 direction = normalize(vDirection);
        float horizon = smoothstep(-0.48, 0.65, direction.y);
        vec3 upper = mix(vec3(0.08, 0.055, 0.16), vec3(0.14, 0.64, 0.64), uDay);
        upper = mix(upper, uSkyTint, 0.2 * uDay);
        vec3 lower = mix(vec3(0.21, 0.09, 0.22), vec3(0.89, 0.48, 0.37), uDay);
        vec3 color = mix(lower, upper, horizon);
        color += vec3(0.06, 0.015, 0.0) * uWarm * uDay * (1.0 - horizon);
        float corona = pow(max(dot(direction, normalize(uSun)), 0.0), 16.0);
        color += corona * mix(vec3(0.12, 0.15, 0.22), vec3(0.65, 0.41, 0.24), uDay) * (0.5 + uWarm * 0.5);
        vec3 cell = floor(direction * 180.0);
        float star = step(0.999, hash(cell)) * pow(1.0 - uDay, 3.0) * 0.2;
        color += vec3(star);
        float dust = (hash(floor(direction * 380.0 + uTime * 0.14)) - 0.5) * 0.018;
        gl_FragColor = vec4(clamp(color + dust, 0.0, 1.0), 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(45, 24, 14), skyMaterial);
  sky.renderOrder = -1;
  sky.visible = !isLive;
  scene.add(sky);
  const ambient = new THREE.AmbientLight(0xe7d5dc, 0.75);
  const skyBounce = new THREE.HemisphereLight(0xb6c9ce, 0x966c80, 0.9);
  scene.add(ambient, skyBounce);
  const sunlight = new THREE.DirectionalLight(0xffd9a2, 2.4);
  sunlight.position.set(2, 9, -24);
  sunlight.castShadow = true;
  const shadowSize = host.clientWidth < 980 || matchMedia("(pointer: coarse)").matches ? 1024 : 1536;
  sunlight.shadow.mapSize.set(shadowSize, shadowSize);
  sunlight.shadow.radius = 1.5;
  const shadowExtent = isLive ? 14 : 11;
  sunlight.shadow.camera.left = -shadowExtent;
  sunlight.shadow.camera.right = shadowExtent;
  sunlight.shadow.camera.top = shadowExtent;
  sunlight.shadow.camera.bottom = -shadowExtent;
  sunlight.shadow.bias = -0.0005;
  sunlight.shadow.normalBias = 0.012;
  scene.add(sunlight);
  const coreGlow = new THREE.PointLight(0x8af6d8, 1.5, 5, 2);
  coreGlow.position.set(coreDisplay.x, 1.55, coreDisplay.z);
  const coffeeGlow = new THREE.PointLight(0xffae7b, 0.9, 4, 2);
  coffeeGlow.position.set(0, 1.35, coffeeZ + 0.1);
  const deskGlow = new THREE.PointLight(0xffb577, 1.1, 8, 2);
  deskGlow.position.set(0.3, 2.4, 0.55);
  scene.add(coffeeGlow, deskGlow);
  if (!isLive) scene.add(coreGlow);

  block(scene, 0, -0.3, 0, room.halfWidth * 2, 0.55, room.front - room.back, palette.edge);
  const floorMap = track(woodFloorTexture());
  floorMap.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  if (isLive) {
    floorMap.wrapS = floorMap.wrapT = THREE.RepeatWrapping;
    floorMap.repeat.set(room.halfWidth * 2 / (gameRoom.halfWidth * 2), (room.front - room.back) / (gameRoom.front - gameRoom.back));
  }
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(room.halfWidth * 2 - 0.18, room.front - room.back - 0.18),
    new THREE.MeshStandardMaterial({ map: floorMap, roughness: 0.86 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.028;
  floor.receiveShadow = true;
  scene.add(floor);
  const floorShade = new THREE.Mesh(
    new THREE.PlaneGeometry(room.halfWidth * 2 - 0.18, room.front - room.back - 0.18),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uSunSide: { value: 0 }, uNight: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform float uSunSide;
        uniform float uNight;
        void main() {
          float nearEdge = smoothstep(0.15, 0.98, 1.0 - vUv.y);
          float corners = smoothstep(0.15, 1.0, abs(vUv.x - 0.5) * 2.0);
          float awayFromSun = max(0.0, -uSunSide * (vUv.x - 0.5) * 2.0);
          float shade = nearEdge * (0.11 + 0.12 * corners + 0.12 * awayFromSun + 0.06 * uNight);
          gl_FragColor = vec4(0.10, 0.065, 0.13, shade);
        }
      `,
    }),
  );
  floorShade.rotation.x = -Math.PI / 2;
  floorShade.position.y = 0.047;
  scene.add(floorShade);
  if (isLive) {
    const rugMap = track(wovenRugTexture());
    for (const x of [-LIVE_RUG_X, LIVE_RUG_X]) {
      const rug = new THREE.Mesh(
        new THREE.PlaneGeometry(4.65, 7.3),
        new THREE.MeshStandardMaterial({ map: rugMap, roughness: 1 }),
      );
      rug.rotation.x = -Math.PI / 2;
      rug.position.set(x, 0.053, 1.7);
      rug.receiveShadow = true;
      scene.add(rug);
    }
  }
  // The live room shows the host-colored canvas through its real window openings.
  // Three's sun and shadow map decide where the interior receives direct light.
  const wall = isLive ? 0x303944 : palette.wall;
  const trim = isLive ? 0xbcc9cc : palette.cream;
  const wallBlock = (x: number, y: number, width: number, height: number) => {
    const section = block(scene, x, y, room.back, width, height, 0.2, wall);
    if (isLive) {
      section.material.emissive.setHex(0x586d7e);
      section.material.emissiveIntensity = 0.16;
    }
  };
  wallBlock(0, 0.575, room.halfWidth * 2, 1.15);
  wallBlock(0, 2.52, room.halfWidth * 2, 0.46);
  let wallStart = -room.halfWidth;
  for (const x of windowXs) {
    const openingStart = x - 0.9;
    wallBlock((wallStart + openingStart) / 2, room.windowY,
      openingStart - wallStart, 1.14);
    wallStart = x + 0.9;
  }
  wallBlock((wallStart + room.halfWidth) / 2, room.windowY,
    room.halfWidth - wallStart, 1.14);
  block(scene, 0, 2.75, room.back, room.halfWidth * 2, 0.17, 0.3,
    isLive ? 0x657582 : palette.wallTop);
  if (isLive) {
    for (const x of [-5.2, -3.2, -0.95, 0.95, 3.2, 5.2]) {
      block(scene, x, 1.68, room.back + 0.12, 0.035, 2.05, 0.03, 0x52616c);
    }
  }
  const lampHaloMap = isLive ? track(screenHaloTexture()) : null;
  if (isLive) {
    block(scene, 0, 3.24, room.back + 0.01, 4.36, 1.08, 0.17, 0x202d3a);
    block(scene, 0, 3.79, room.back + 0.08, 4.5, 0.09, 0.19, 0x516c76);
    block(scene, 0, 2.7, room.back + 0.08, 4.5, 0.09, 0.19, 0x516c76);
  }
  const neonHalo = lampHaloMap ? new THREE.Mesh(
    new THREE.PlaneGeometry(5.15, 1.7),
    new THREE.MeshBasicMaterial({
      map: lampHaloMap, color: 0x70e9cf, transparent: true, opacity: 0.45,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }),
  ) : null;
  if (neonHalo) {
    neonHalo.position.set(0, 3.24, room.back + 0.18);
    scene.add(neonHalo);
  }
  const neonLight = isLive ? new THREE.PointLight(0x80e9d7, 0, 3.5, 2) : null;
  if (neonLight) {
    neonLight.position.set(0, 3.18, room.back + 0.55);
    scene.add(neonLight);
  }
  const titleMap = track(isLive ? happyMachinesNeonArt() : chatRoomTitleArt());
  const title = new THREE.Mesh(
    new THREE.PlaneGeometry(isLive ? 4.16 : 3.35, isLive ? 1.03 : 0.82),
    new THREE.MeshBasicMaterial({
      map: titleMap, transparent: true, alphaTest: 0.2, side: THREE.DoubleSide, toneMapped: !isLive,
    }),
  );
  title.position.set(0, 3.24, room.back + (isLive ? 0.27 : 0.2));
  scene.add(title);
  block(scene, 0, 0.38, room.back + 0.12, room.halfWidth * 2 - 0.2, 0.55, 0.06,
    isLive ? 0x3d4955 : 0x775d66);
  block(scene, 0, 0.74, room.back + 0.16, room.halfWidth * 2 - 0.1, 0.08, 0.1,
    isLive ? 0x8d9c9e : 0xd2a07c);
  const foliageMaterial = new THREE.MeshBasicMaterial({
    map: track(windowFoliageTexture()), transparent: true, alphaTest: 0.03,
    side: THREE.DoubleSide, depthWrite: false,
  });
  for (const x of windowXs) {
    const foliage = new THREE.Mesh(new THREE.PlaneGeometry(1.72, 1.08), foliageMaterial);
    foliage.position.set(x, room.windowY, room.back - 0.14);
    scene.add(foliage);
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(1.65, 1.08),
      new THREE.MeshBasicMaterial({
        color: isLive ? 0xd4e9ed : 0xf6c99b,
        transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    glass.position.set(x, room.windowY, room.back + 0.02);
    scene.add(glass);
    block(scene, x, 1.14, room.back + 0.2, 1.98, 0.11, 0.36, trim);
    block(scene, x, 2.3, room.back + 0.12, 1.92, 0.11, 0.22, trim);
    for (const offset of [-0.88, 0, 0.88]) {
      block(scene, x + offset, room.windowY, room.back + 0.12, 0.09, 1.13, 0.15, trim);
    }
  }
  for (const [i, x] of (isLive ? [0] : [-6.4, -2.5, 2.5]).entries()) {
    cutout(scene, track(posterArt(i)), x, 1.65, room.back + 0.17, 0.66, 0.81);
  }
  const wallWashMap = isLive ? track(sconceWashTexture()) : null;
  const sconces = (isLive ? [-4.2, 4.2] : [-2.4, 2.4]).map((x) => {
    const wash = wallWashMap ? new THREE.Mesh(
      new THREE.PlaneGeometry(2.35, 2.5),
      new THREE.MeshBasicMaterial({
        map: wallWashMap, transparent: true, depthWrite: false, toneMapped: false,
        blending: THREE.AdditiveBlending, opacity: 0,
      }),
    ) : null;
    if (wash) {
      wash.position.set(x, 1.73, room.back + 0.112);
      scene.add(wash);
    }
    block(scene, x, 2.22, room.back + 0.3, 0.31, 0.15, 0.2, 0x6e5360);
    const bulb = block(scene, x, 2.13, room.back + 0.42, 0.15, 0.12, 0.14, 0xffd5a0, 0xffc58a, 0.5);
    const glow = new THREE.PointLight(0xffb77b, 0, 4.5, 2);
    glow.position.set(x, 2.08, room.back + (isLive ? 0.38 : 0.6));
    scene.add(glow);
    return { bulb, glow, wash };
  });
  const floorLamps = lampHaloMap ? [-LIVE_DIVIDER_X, LIVE_DIVIDER_X].map((x) => {
    const z = LIVE_DIVIDER_START_Z - 0.25;
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(2.9, 2),
      new THREE.MeshBasicMaterial({
        map: lampHaloMap, color: 0xffbc7a, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0,
      }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(x, 0.073, z + 0.2);
    scene.add(pool);
    block(scene, x, 0.07, z, 0.55, 0.14, 0.55, 0x6a5969);
    block(scene, x, 0.98, z, 0.1, 1.74, 0.1, 0xb88670);
    const shade = block(scene, x, 2, z, 0.65, 0.48, 0.58, 0xf6c78e, 0xffad73, 0.25);
    block(scene, x, 2.27, z, 0.69, 0.07, 0.62, 0x624e60);
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(1.95, 1.75),
      new THREE.MeshBasicMaterial({
        map: lampHaloMap, color: 0xffad68, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0,
      }),
    );
    halo.position.set(x, 2.02, z + 0.38);
    scene.add(halo);
    const glow = new THREE.PointLight(0xffb986, 0, 4.5, 2);
    glow.position.set(x, 2.02, z + 0.16);
    scene.add(glow);
    return { shade, glow, halo, pool };
  }) : [];
  if (isLive) {
    const length = LIVE_DIVIDER_END_Z - LIVE_DIVIDER_START_Z;
    const middle = (LIVE_DIVIDER_START_Z + LIVE_DIVIDER_END_Z) / 2;
    for (const x of [-LIVE_DIVIDER_X, LIVE_DIVIDER_X]) {
      block(scene, x, 0.43, middle, 0.22, 0.86, length, 0x876e73);
      block(scene, x, 0.89, middle, 0.3, 0.12, length, 0xd9ae88);
      const glass = new THREE.Mesh(
        new THREE.PlaneGeometry(length - 0.24, 0.56),
        new THREE.MeshBasicMaterial({
          color: 0xb5d6c8, transparent: true, opacity: 0.32,
          depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      glass.rotation.y = Math.PI / 2;
      glass.position.set(x, 1.23, middle);
      scene.add(glass);
      block(scene, x, 1.55, middle, 0.22, 0.1, length, 0x745d6b);
      for (const z of [LIVE_DIVIDER_START_Z, middle, LIVE_DIVIDER_END_Z]) {
        block(scene, x, 1.24, z, 0.26, 0.76, 0.17, palette.cream);
      }
    }
    for (const [index, x] of [-8.3, 8.3].entries()) {
      block(scene, x, 1.12, room.back + 0.32, 1.38, 2.24, 0.3, 0x614e60);
      cutout(scene, track(bookcaseArt(index)), x, 1.13, room.back + 0.49, 1.27, 2.12);
    }
  }

  let core: THREE.Mesh | undefined;
  if (!isLive) {
    const rug = new THREE.Mesh(
      new THREE.CylinderGeometry(0.92, 0.92, 0.04, 12), material(0xae8e86),
    );
    rug.position.set(coreDisplay.x, 0.05, coreDisplay.z);
    rug.receiveShadow = true;
    scene.add(rug);
    const coreArt = track(coreBodyArt());
    const coreBack = cutout(scene, coreArt, coreDisplay.x + 0.1, 0.96, coreDisplay.z - 0.14, 1.39, 1.9);
    (coreBack.material as THREE.MeshStandardMaterial).color.setHex(0x79788e);
    (coreBack.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
    coreBack.castShadow = false;
    core = cutout(scene, coreArt, coreDisplay.x, 0.95, coreDisplay.z, 1.35, 1.86);
    const coreLabel = label("AI CORE");
    coreLabel.position.set(coreDisplay.x, 2.38, coreDisplay.z);
    scene.add(coreLabel);
  }

  const counter = isLive ? LIVE_COFFEE_COUNTER : { width: 4.6, height: 1.25, y: 0.68 };
  cutout(scene, track(coffeeCounterArt(variant)),
    0, counter.y, coffeeZ, counter.width, counter.height, true);
  if (isLive) {
    for (const [cupX, cupY, width, height] of [
      [20, 14, 0.25, 0.52], [42, 18, 0.22, 0.48], [55, 18, 0.22, 0.48],
    ]) {
      addSteam(scene, (cupX / 96 - 0.5) * counter.width,
        counter.y + (0.5 - cupY / 56) * counter.height, coffeeZ + 0.12, width, height);
    }
  }
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = 64;
  shadowCanvas.height = 64;
  const shadowContext = shadowCanvas.getContext("2d");
  if (!shadowContext) throw new Error("Canvas 2D is required for contact shadows.");
  const shadowGradient = shadowContext.createRadialGradient(32, 32, 3, 32, 32, 31);
  shadowGradient.addColorStop(0, "#302838a8");
  shadowGradient.addColorStop(0.25, "#3028388a");
  shadowGradient.addColorStop(0.65, "#30283832");
  shadowGradient.addColorStop(1, "#29233500");
  shadowContext.fillStyle = shadowGradient;
  shadowContext.fillRect(0, 0, 64, 64);
  const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
  shadowTexture.magFilter = THREE.LinearFilter;
  const contacts: { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; opacity: number }[] = [];
  const contact = (parent: THREE.Object3D, x: number, z: number, width: number, depth: number, y = 0.065, opacity = 0.54) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, opacity, toneMapped: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.renderOrder = 3;
    parent.add(mesh);
    contacts.push({ mesh, opacity });
  };
  if (!isLive) contact(scene, coreDisplay.x, coreDisplay.z, 1.05, 0.85, 0.076);
  contact(scene, 0, coffeeZ, isLive ? 2.65 : 3.85, 0.62);
  if (isLive) {
    for (const side of [-1, 1] as const) {
      const style = side < 0 ? "left" : "right";
      const sofaX = side * LIVE_LOUNGE_SOFA_X;
      cutout(scene, track(loungeSofaArt(style)), sofaX, 0.56, LIVE_LOUNGE_Z - 0.23, 3.08, 1.12, true);
      cutout(scene, track(loungeFrontArt(style)),
        sofaX, 0.3, LIVE_LOUNGE_Z + 0.17, 3.08, 0.42);
      contact(scene, sofaX, LIVE_LOUNGE_Z - 0.08, 2.9, 0.72, 0.065, 0.6);
    }
  }
  const makeAgentModel = (id: number) => {
    const frames = agentArt(id);
    Object.values(frames).flatMap((directions) => Object.values(directions)).forEach(track);
    const model = createAgent(id, shadowTexture, frames);
    const mugSteam = steamMap ? addSteam(model.group, 0.35, 0.62, 0.12, 0.24, 0.38) : null;
    if (mugSteam) mugSteam.visible = false;
    const halo = isLive ? new THREE.Mesh(
      new THREE.RingGeometry(0.37, 0.49, 48),
      new THREE.MeshBasicMaterial({ color: 0xffcf89, transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    ) : null;
    if (halo) {
      halo.rotation.x = -Math.PI / 2;
      halo.renderOrder = 4;
      halo.visible = false;
      scene.add(halo);
    }
    scene.add(model.group, model.shadow);
    return { ...model, mugSteam, halo };
  };
  const agentMeshes = simulation.agents.map((agent) => makeAgentModel(agent.id));
  const personas = agentMeshes.map((_, index) => index);
  const setAgentPersona = (index: number, persona: number) => {
    while (agentMeshes.length <= index) {
      agentMeshes.push(makeAgentModel(agentMeshes.length));
      personas.push(agentMeshes.length - 1);
    }
    const model = agentMeshes[index];
    if (!model || personas[index] === persona) return;
    const frames = agentArt(persona);
    Object.values(frames).flatMap(directions => Object.values(directions)).forEach(track);
    model.frames = frames;
    personas[index] = persona;
  };
  let previousPositions = simulation.agents.map(({ x, z }) => ({ x, z }));
  const contextRoom = new THREE.Group();
  contextRoom.visible = !isLive && simulation.progress.context;
  const lockedContext = new THREE.Group();
  lockedContext.visible = !isLive && !simulation.progress.context;
  if (!isLive) {
    block(contextRoom, 3, 0.08, -1.8, 3.05, 0.12, 2.85, palette.lavender);
    cutout(contextRoom, track(contextConsoleArt()), 3, 0.76, -2.5, 1.45, 1.42);
    contact(contextRoom, 3, -2.5, 1.25, 0.65, 0.153);
    for (let i = 0; i < 3; i++) {
      cutout(contextRoom, track(stackArt(i)), 2.1 + i * 0.78, 0.48, -1.18, 0.66, 0.87);
      contact(contextRoom, 2.1 + i * 0.78, -1.18, 0.54, 0.42, 0.153, 0.55);
    }
    const contextLabel = label("CONTEXT");
    contextLabel.position.set(3, 2.28, -2.1);
    contextRoom.add(contextLabel);
    scene.add(contextRoom);
    const ghostLabel = label("CONTEXT  ?");
    ghostLabel.position.set(3, 1.34, -1.8);
    lockedContext.add(ghostLabel);
    scene.add(lockedContext);
  }
  const stations = stationPositions.map(() => {
    const station = new THREE.Group();
    scene.add(station);
    return station;
  });
  const monitors = stationPositions.map(({ x, z }, index) => {
    const station = stations[index];
    const monitor = desk(station, x, z, index, track, variant);
    contact(station, x, z - 0.56, 1.24, 0.52);
    contact(station, x + 0.35, z + 0.37, 0.48, 0.32, 0.065, 0.42);
    return monitor;
  });
  if (isLive) {
    stationPositions.forEach(({ x, z }, index) => {
      deskPropsFor(index).forEach((kind, slot) => {
        if (kind === "mug") {
          addSteam(stations[index], x + deskPropOffsets[slot], 1.01, z - 0.39, 0.22, 0.35);
        }
      });
    });
  }
  const onMonitorFrames = monitors.map((monitor) => (monitor.material as THREE.MeshStandardMaterial).map);
  const offMonitorFrames = isLive ?
    stationPositions.map((_, index) => track(monitorArt(index, false, "live"))) : [];
  const monitorEmissionFrames = isLive ?
    stationPositions.map((_, index) => track(monitorEmissionArt(index))) : [];
  if (isLive) {
    monitors.forEach((monitor, index) => {
      (monitor.material as THREE.MeshStandardMaterial).emissiveMap = monitorEmissionFrames[index];
    });
  }
  const haloMap = lampHaloMap;
  const monitorHalos = haloMap ? stationPositions.map(({ x, z }, index) => {
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(1.47, 1.33),
      new THREE.MeshBasicMaterial({
        map: haloMap, color: index % 2 ? 0xb892e8 : 0x72e7d3,
        transparent: true, opacity: 0.38, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false,
      }),
    );
    halo.position.set(x - 0.1, 1.08, z - 0.72);
    stations[index].add(halo);
    return halo;
  }) : [];
  const screenGlows = stationPositions.map(({ x, z }, index) => {
    const glow = new THREE.PointLight(index % 2 ? 0xc2a0ed : 0x75e3cd, 0, 3.1, 2);
    glow.position.set(x, 1.35, z - 0.54);
    if (index < DESKS.length) stations[index].add(glow);
    return glow;
  });
  const stationLights = stationPositions.map(({ x, z }, index) => {
    const mesh = cutout(stations[index], track(statusLightArt()), x + 0.43, 0.82, z - 0.55, 0.18, 0.27);
    return mesh;
  });
  const workflowKits = (isLive ? [] : stationPositions).map(({ x, z }, index) =>
    cutout(stations[index], track(workflowKitArt()), x - 0.58, 0.79, z - 0.49, 0.36, 0.34),
  );
  const noticeFrames: Record<RequestStatus, THREE.CanvasTexture[]> = {
    queued: [track(stationNoticeArt("queued"))],
    assigned: [track(stationNoticeArt("assigned"))],
    working: Array.from({ length: 17 }, (_, step) => track(stationNoticeArt("working", step))),
    complete: [track(stationNoticeArt("complete"))],
    failed: [track(stationNoticeArt("failed"))],
  };
  const liveNoticeFrames: Record<LiveNoticeActivity, THREE.CanvasTexture> | null = isLive ? {
    idle: track(liveNoticeArt("idle")),
    thinking: track(liveNoticeArt("thinking")),
    terminal: track(liveNoticeArt("terminal")),
    checks: track(liveNoticeArt("checks")),
    research: track(liveNoticeArt("research")),
    editing: track(liveNoticeArt("editing")),
    delegating: track(liveNoticeArt("delegating")),
    working: track(liveNoticeArt("working")),
    blocked: track(liveNoticeArt("blocked")),
  } : null;
  const notices = stationPositions.map(({ x, z }, index) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(isLive ? 0.7 : 0.58, isLive ? 0.7 : 0.58),
      new THREE.MeshBasicMaterial({
        map: liveNoticeFrames?.thinking ?? noticeFrames.queued[0], transparent: true, alphaTest: 0.25,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    mesh.position.set(x, 2.06, z - 0.57);
    stations[index].add(mesh);
    return mesh;
  });
  for (let i = 0; i < 2; i++) {
    const x = (isLive ? -6.9 : -4.6) + i * 0.35;
    const z = isLive ? -3.5 : 2.2;
    cutout(scene, track(stackArt(i)), x, 0.43, z, 0.65, 0.81);
    contact(scene, x, z, 0.55, 0.4, 0.065, 0.52);
  }
  const leaves = track(monsteraArt());
  const plants = isLive ? [
    { x: -6.6, z: room.back + 1.04, size: 1 }, { x: -4.4, z: room.back + 1.08, size: 0.84 },
    { x: 4.4, z: room.back + 1.08, size: 0.84 }, { x: 6.6, z: room.back + 1.04, size: 1 },
    ...LIVE_DIVIDER_PLANTS,
    { x: -8.2, z: 4.95, size: 0.92 }, { x: 8.2, z: 4.95, size: 0.92 },
  ] : [
    { x: -4.37, z: 2.99, size: 0.92 }, { x: 5.8, z: 3.35, size: 0.78 },
  ];
  plants.forEach(({ x, z, size }, index) => {
    const plant = cutout(scene, leaves, x, 0.76 * size, z, 1.2 * size, 1.44 * size, true);
    if (index % 2) plant.scale.x = -1;
    contact(scene, x, z, 0.62 * size, 0.42 * size, 0.065, 0.4);
  });
  const upgrades = new Map<string, THREE.Object3D>();
  if (isLive) {
    const garden = new THREE.Group();
    for (const x of [-5.4, 5.4]) {
      const plant = cutout(garden, leaves, x, 0.79, room.back + 0.82, 1.2, 1.5, true);
      plant.scale.x = x < 0 ? -1 : 1;
    }
    scene.add(garden);
    upgrades.set("garden", garden);
    const loungeRug = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 0.02, 24),
      material(0x936f9c));
    loungeRug.position.set(0, 0.07, 4.6);
    scene.add(loungeRug);
    upgrades.set("rug", loungeRug);
    const lanterns = new THREE.Group();
    for (const x of [-7.1, 7.1]) {
      block(lanterns, x, 1.0, room.back + 0.65, 0.21, 0.3, 0.21, 0xf8bb77, 0xf8bb77, 1);
    }
    scene.add(lanterns);
    upgrades.set("lamp", lanterns);
    for (const object of upgrades.values()) object.visible = false;
  }
  const specks: THREE.Mesh[] = [];
  for (let i = 0; i < (isLive ? 0 : 9); i++) {
    const speck = block(scene, coreDisplay.x - 0.32 + (i % 3) * 0.32, 2.2 + (i % 2) * 0.2,
      coreDisplay.z - 0.33 + Math.floor(i / 3) * 0.31,
      0.08, 0.08, 0.08, palette.cream, palette.cream, 0.8);
    specks.push(speck);
  }
  const beamTextureCanvas = document.createElement("canvas");
  beamTextureCanvas.width = 128;
  beamTextureCanvas.height = 128;
  const context = beamTextureCanvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is required for sunlight pools.");
  const image = context.createImageData(128, 128);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const across = Math.max(0, 1 - Math.abs((x + 0.5) / 64 - 1));
      const along = (y + 0.5) / 128;
      const fade = Math.min(1, along * 9, (1 - along) * 5);
      const index = (y * 128 + x) * 4;
      image.data[index] = image.data[index + 1] = image.data[index + 2] = 255;
      image.data[index + 3] = Math.round(220 * across ** 1.4 * fade);
    }
  }
  context.putImageData(image, 0, 0);
  const beamTexture = new THREE.CanvasTexture(beamTextureCanvas);
  beamTexture.minFilter = THREE.LinearFilter;
  const poolCanvas = document.createElement("canvas");
  poolCanvas.width = poolCanvas.height = 64;
  const poolContext = poolCanvas.getContext("2d");
  if (!poolContext) throw new Error("Canvas 2D is required for sunlight pools.");
  const poolGradient = poolContext.createRadialGradient(32, 32, 3, 32, 32, 32);
  poolGradient.addColorStop(0, "#ffffffcc");
  poolGradient.addColorStop(0.65, "#ffffff80");
  poolGradient.addColorStop(1, "#ffffff00");
  poolContext.fillStyle = poolGradient;
  poolContext.fillRect(0, 0, 64, 64);
  const poolTexture = new THREE.CanvasTexture(poolCanvas);
  poolTexture.minFilter = THREE.LinearFilter;
  const beams = windowXs.map((x) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([
      0, 1, 1, 1, 0, 0, 1, 0,
    ]), 2));
    geometry.setIndex([0, 1, 2, 1, 3, 2]);
    const material = new THREE.MeshBasicMaterial({
      map: beamTexture, color: 0xffc990, transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    const shaft = new THREE.Mesh(geometry, material);
    shaft.renderOrder = 2;
    scene.add(shaft);
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(2.05, 2.2),
      new THREE.MeshBasicMaterial({
        map: poolTexture, transparent: true, opacity: 0, depthWrite: false,
        color: 0xffd6ad, blending: THREE.AdditiveBlending,
      }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.renderOrder = 2;
    scene.add(pool);
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(36), 3));
    const dust = new THREE.Points(dustGeometry, new THREE.PointsMaterial({
      map: poolTexture, color: 0xffd6ad, size: 3, sizeAttenuation: false,
      transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    dust.renderOrder = 2;
    scene.add(dust);
    return { x, shaft, pool, dust };
  });

  let zoom = 1;
  let panX = 0;
  let panZ = 0;
  let dragging = false;
  let previousX = 0;
  let previousY = 0;
  let pointerTravel = 0;
  let selectedAgent: number | null = null;
  let focusIndex: number | null = null;
  let focusedZoom = isLive ? 1.45 : 1.3;
  type CameraView = { panX: number; panZ: number; zoom: number };
  let viewBeforeFocus: CameraView | null = null;
  let returningView: CameraView | null = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pickAgent = (event: PointerEvent): number | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const figures = agentMeshes.slice(0, simulation.progress.capacity).map((model) => model.figure);
    for (const hit of raycaster.intersectObjects(figures)) {
      const index = agentMeshes.findIndex((model) => model.figure === hit.object);
      const map = (hit.object as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>).material.map;
      if (index < 0 || !hit.uv || !map || !(map.image instanceof HTMLCanvasElement)) continue;
      const image = map.image;
      const x = Math.min(image.width - 1, Math.floor(hit.uv.x * image.width));
      const y = Math.min(image.height - 1, Math.floor((1 - hit.uv.y) * image.height));
      if ((image.getContext("2d")?.getImageData(x, y, 1, 1).data[3] ?? 0) > 48) return index;
    }
    return null;
  };
  const clearFocusForCameraInteraction = () => {
    focusIndex = null;
    returningView = null;
    viewBeforeFocus = null;
    if (selectedAgent !== null) {
      selectedAgent = null;
      interaction?.onFocusCleared?.();
    }
  };
  const onDown = (event: PointerEvent) => {
    dragging = true;
    pointerTravel = 0;
    previousX = event.clientX;
    previousY = event.clientY;
    renderer.domElement.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent) => {
    if (interaction && !dragging) {
      const index = pickAgent(event);
      renderer.domElement.style.cursor = index === null ? "grab" : "pointer";
      interaction.onAgentHover(index, event.clientX, event.clientY);
    }
    if (!dragging) return;
    const dx = event.clientX - previousX;
    const dy = event.clientY - previousY;
    pointerTravel += Math.hypot(dx, dy);
    if (interaction && pointerTravel <= 5) return;
    clearFocusForCameraInteraction();
    interaction?.onAgentHover(null, event.clientX, event.clientY);
    panX = THREE.MathUtils.clamp(panX - dx * 0.012 / zoom, isLive ? -7.8 : -2.5, isLive ? 7.8 : 2.5);
    panZ = THREE.MathUtils.clamp(panZ - dy * 0.014 / zoom, isLive ? -4.8 : -2, isLive ? 4.8 : 2);
    previousX = event.clientX;
    previousY = event.clientY;
  };
  const onUp = (event: PointerEvent) => {
    if (interaction && dragging && pointerTravel <= 5 && event.type === "pointerup") {
      const index = pickAgent(event);
      if (index !== null) interaction.onAgentSelect(index);
      else interaction.onEmptySelect?.(event.clientX, event.clientY);
    }
    dragging = false;
  };
  const onLeave = () => interaction?.onAgentHover(null, 0, 0);
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const current = focusIndex !== null ? focusedZoom : zoom;
    const next = THREE.MathUtils.clamp(current * (event.deltaY > 0 ? 0.9 : 1.1), 0.74, isLive ? 1.95 : 1.65);
    if (focusIndex !== null) focusedZoom = next;
    else zoom = next;
  };
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  if (interaction) canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  const resize = () => {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, width < 700 ? 1.25 : 1.5));
    renderer.setSize(width, height, false);
    const aspect = width / height;
    const minimumHalfWidth = isLive ?
      THREE.MathUtils.lerp(7.3, room.halfWidth + 2.6, THREE.MathUtils.smoothstep(width, 390, 900)) : 4.7;
    const cameraDistance = cameraBase.distanceTo(new THREE.Vector3(0, 0.4, 0));
    camera.aspect = aspect;
    camera.fov = THREE.MathUtils.radToDeg(
      2 * Math.atan(Math.max(Math.tan(THREE.MathUtils.degToRad(28 / 2)), minimumHalfWidth / (cameraDistance * aspect))),
    );
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let lastRenderTime = performance.now() / 1000;
  let lastPreviewOffset = 0;
  let lastRoomKey = "";
  let lastVisibleDesks = -1;
  const projected = new THREE.Vector3();
  const projectPoint = (x: number, y: number, z: number) => {
    projected.set(x, y, z).project(camera);
    if (projected.z < -1 || projected.z > 1) return null;
    return { x: (projected.x + 1) * host.clientWidth / 2, y: (1 - projected.y) * host.clientHeight / 2 };
  };

  return {
    setAgentPersona,
    setUpgrades(ids: readonly string[]) {
      for (const [id, object] of upgrades) object.visible = ids.includes(id);
    },
    capturePositions() {
      previousPositions = simulation.agents.map(({ x, z }) => ({ x, z }));
    },
    focusAgent(index) {
      const next = index !== null && index >= 0 && index < simulation.progress.capacity ? index : null;
      if (next !== null && selectedAgent === null) {
        viewBeforeFocus = { panX, panZ, zoom };
      } else if (next === null && selectedAgent !== null) {
        returningView = isLive ? viewBeforeFocus : null;
        viewBeforeFocus = null;
      }
      if (next !== null) returningView = null;
      if (next !== null && next !== selectedAgent) focusedZoom = isLive ? 1.45 : 1.3;
      selectedAgent = next;
      focusIndex = selectedAgent;
    },
    projectDesk(index) {
      const desk = stationPositions[index];
      return desk ?
        projectPoint(desk.x, 1.4, desk.z) : null;
    },
    projectAgent(index) {
      const agent = simulation.agents[index];
      return agent && index < simulation.progress.capacity && agent.x < 50 ?
        projectPoint(agent.x, 1.15, agent.z) : null;
    },
    render(elapsed: number, previewOffset: number, alpha: number, advanced: boolean) {
      const now = performance.now() / 1000;
      const frameDelta = Math.max(0, Math.min(0.05, now - lastRenderTime));
      lastRenderTime = now;
      const animationTime = elapsed;
      const roomKey = `${simulation.progress.capacity}/${simulation.progress.context}/${simulation.progress.workflow}`;
      if (advanced || previewOffset !== lastPreviewOffset || roomKey !== lastRoomKey) {
        renderer.shadowMap.needsUpdate = true;
      }
      lastPreviewOffset = previewOffset;
      lastRoomKey = roomKey;
      const light = sampleDaylight(simulation.time, previewOffset);
      const direct = light.sun + light.moon;
      const moonShare = direct > 0 ? light.moon / direct : 0;
      const moonStrength = light.moon / 0.45;
      const night = THREE.MathUtils.clamp(1 - light.sun / 2, 0, 1);
      foliageMaterial.color.setHex(0xffffff).lerp(nightFoliage, moonStrength * 0.7);
      sunlight.color.setHex(light.sunColor).lerp(moonColor, moonShare);
      sunlight.intensity = direct;
      sunlight.position.set(
        THREE.MathUtils.lerp(light.sunX, -3.4, moonShare),
        THREE.MathUtils.lerp(light.sunY, 6.6, moonShare), -24,
      );
      ambient.color.setHex(light.skyColor)
        .lerp(moonAmbient, moonStrength * 0.32)
        .lerp(warmAmbient, light.lamp * (0.28 - moonStrength * 0.1));
      ambient.intensity = light.ambient;
      skyBounce.color.setHex(light.bounceColor).lerp(moonBounce, moonStrength * 0.32);
      skyBounce.groundColor.setHex(0xb47976);
      skyBounce.intensity = light.ambient * 0.95;
      const daylightShadow = Math.min(1, light.sun / 3.2);
      const shadeMaterial = floorShade.material as THREE.ShaderMaterial;
      shadeMaterial.uniforms.uSunSide.value = THREE.MathUtils.clamp(light.sunX / 6, -1, 1) * daylightShadow;
      shadeMaterial.uniforms.uNight.value = night;
      contacts.forEach(({ mesh, opacity }) => {
        mesh.material.opacity = opacity * (0.72 + daylightShadow * 0.28);
      });
      coreGlow.intensity = 0.9 + night * 1.35 + light.lamp * 0.35;
      coffeeGlow.intensity = 0.25 + night * 1.4;
      deskGlow.intensity = 0.25 + light.lamp * 1.1;
      sconces.forEach(({ bulb, glow, wash }) => {
        (bulb.material as THREE.MeshStandardMaterial).emissiveIntensity = light.lamp * (isLive ? 1 : 0.75);
        glow.intensity = light.lamp * (isLive ? 2.2 : 1.25);
        if (wash) (wash.material as THREE.MeshBasicMaterial).opacity = Math.min(0.75, 0.16 + light.lamp * 0.35);
      });
      floorLamps.forEach(({ shade, glow, halo, pool }) => {
        (shade.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.2 + light.lamp * 0.58;
        glow.intensity = 0.3 + light.lamp * 1.6;
        (halo.material as THREE.MeshBasicMaterial).opacity = Math.min(0.9, 0.18 + light.lamp * 0.45);
        (pool.material as THREE.MeshBasicMaterial).opacity = Math.min(0.58, 0.09 + light.lamp * 0.25);
      });
      steamEmitters.forEach(({ wisps, width, height }, emitterIndex) => {
        wisps.forEach((wisp, layer) => {
          const phase = reducedMotion ? (layer ? 0.66 : 0.3) :
            (animationTime * 0.32 + emitterIndex * 0.17 + layer * 0.5) % 1;
          const sway = reducedMotion ? 0 : Math.sin(animationTime * 1.1 + emitterIndex + layer * 1.7) *
            width * 0.16 * phase;
          wisp.position.set(sway, height * (0.42 + phase * 0.56), 0.012 + layer * 0.02);
          wisp.scale.set(1 + phase * 0.35, 1 + phase * 0.18, 1);
          wisp.material.opacity = 0.62 * Math.sin(Math.PI * phase);
        });
      });
      if (neonHalo) {
        (neonHalo.material as THREE.MeshBasicMaterial).opacity =
          0.43 + night * 0.18 + (reducedMotion ? 0 : Math.sin(animationTime * 1.1) * 0.02);
      }
      if (neonLight) neonLight.intensity = 0.45 + night * 0.6;
      renderer.toneMappingExposure = 1.34 - night * 0.16;
      skyMaterial.uniforms.uDay.value = Math.min(1, light.sun / 3.2);
      skyMaterial.uniforms.uWarm.value = light.warmth;
      (skyMaterial.uniforms.uSkyTint.value as THREE.Color).setHex(light.skyColor);
      skyMaterial.uniforms.uTime.value = reducedMotion ? 0 : simulation.time;
      (skyMaterial.uniforms.uSun.value as THREE.Vector3).copy(sunlight.position).normalize();
      for (const { x, shaft, pool, dust } of beams) {
        const fall = (room.windowY - 0.08) / (sunlight.position.y - room.windowY);
        const endX = x + (x - sunlight.position.x) * fall;
        const endZ = room.back + (room.back - sunlight.position.z) * fall;
        const insideRoom = THREE.MathUtils.clamp((room.halfWidth - 0.9 - Math.abs(endX)) / 0.7, 0, 1);
        const vertices = (shaft.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
        vertices.set([
          x - 0.82, room.windowY + 0.06, room.back + 0.2, x + 0.82, room.windowY + 0.06, room.back + 0.2,
          endX - 1.15, 0.08, endZ, endX + 1.15, 0.08, endZ,
        ]);
        shaft.geometry.attributes.position.needsUpdate = true;
        shaft.geometry.computeBoundingSphere();
        (shaft.material as THREE.MeshBasicMaterial).color.copy(sunlight.color);
        (shaft.material as THREE.MeshBasicMaterial).opacity = (daylightShadow * 0.4 + moonStrength * 0.04) * insideRoom;
        (pool.material as THREE.MeshBasicMaterial).color.copy(sunlight.color);
        (pool.material as THREE.MeshBasicMaterial).opacity = (light.sun / 3.2 * 0.22 + moonStrength * 0.12) * insideRoom;
        pool.position.set(endX, 0.067, endZ);
        const dustPositions = (dust.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
        for (let i = 0; i < 12; i++) {
          const depth = 0.14 + ((i * 0.31 + x * 0.13 + 1) % 1) * 0.7;
          const drift = reducedMotion ? 0 : Math.sin(animationTime * 0.38 + i * 2.3 + x);
          const along = depth + drift * 0.025;
          const across = Math.sin(i * 15.73 + x * 7.19) * 0.68;
          dustPositions[i * 3] = THREE.MathUtils.lerp(x, endX, along) + across * (0.6 + along * 0.3);
          dustPositions[i * 3 + 1] = THREE.MathUtils.lerp(room.windowY, 0.12, along);
          dustPositions[i * 3 + 2] = THREE.MathUtils.lerp(room.back + 0.22, endZ, along);
        }
        dust.geometry.attributes.position.needsUpdate = true;
        dust.geometry.computeBoundingSphere();
        (dust.material as THREE.PointsMaterial).color.copy(sunlight.color);
        (dust.material as THREE.PointsMaterial).opacity = (daylightShadow * 0.42 + moonStrength * 0.09) * insideRoom;
      }
      while (agentMeshes.length < simulation.agents.length) {
        agentMeshes.push(makeAgentModel(agentMeshes.length));
        personas.push(agentMeshes.length - 1);
      }
      const busy = simulation.agents.some((a) => a.taskId !== undefined);
      if (core) {
        (core.material as THREE.MeshStandardMaterial).emissiveIntensity = (busy ? 0.65 : 0.37) + (reducedMotion ? 0 : Math.sin(animationTime * 2.2) * 0.1);
        core.position.y = 0.95 + (reducedMotion ? 0 : Math.sin(animationTime * 1.9) * 0.035);
      }
      contextRoom.visible = !isLive && simulation.progress.context;
      lockedContext.visible = !isLive && !simulation.progress.context;
      if (isLive) {
        const count = stationPositions.length;
        if (count !== lastVisibleDesks) {
          stations.forEach((station, index) => { station.visible = index < count; });
          host.dataset.visibleDesks = String(count);
          lastVisibleDesks = count;
        }
      }
      stationLights.forEach((light, i) => {
        const active = simulation.agents[i]?.state === "working";
        (light.material as THREE.MeshStandardMaterial).emissiveIntensity = i < simulation.progress.capacity ? active ? 1.1 : 0.45 : 0;
        (light.material as THREE.MeshStandardMaterial).color.setHex(i < simulation.progress.capacity ? active ? 0xffffff : 0xa6c9be : palette.edge);
      });
      monitors.forEach((monitor, i) => {
        const material = monitor.material as THREE.MeshStandardMaterial;
        const powered = !isLive || i < simulation.progress.capacity;
        const active = simulation.agents[i]?.state === "working";
        if (isLive) {
          const frame = powered ? onMonitorFrames[i] : offMonitorFrames[i];
          if (!frame) throw new Error(`Missing monitor art for station ${i}`);
          if (material.map !== frame) {
            material.map = frame;
          }
          const halo = monitorHalos[i];
          halo.visible = powered;
          halo.material.opacity = 0.38 + night * 0.12 + (active ? 0.06 : 0);
        }
        material.emissiveIntensity = powered ?
          isLive ? 0.52 + night * 0.3 + (active ? 0.12 : 0) :
            0.24 + night * 0.58 : 0;
        screenGlows[i].intensity = i < simulation.progress.capacity ?
          isLive ? 0.25 + night * 0.5 + (active ? 0.12 : 0) :
            0.12 + night * 1.45 + (active ? 0.3 : 0) : 0;
      });
      workflowKits.forEach((kit, i) => {
        kit.visible = i < simulation.progress.capacity && simulation.progress.workflow > 0;
        (kit.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.18 + simulation.progress.workflow * 0.1;
      });
      notices.forEach((notice, i) => {
        const request = simulation.requests.find((r) => r.stationId === i &&
          (r.status === "queued" || r.status === "assigned" || r.status === "working" ||
            (isLive && r.status === "failed"))) ??
          simulation.requests.find((r) => r.stationId === i && r.resolvedAt !== undefined &&
            simulation.time - r.resolvedAt < 2.5);
        const deskIdle = isLive && simulation.agents[i]?.deskIdle &&
          simulation.agents[i]?.state === "idle";
        notice.visible = (!!request || !!deskIdle) && i < simulation.progress.capacity;
        if (!request && !deskIdle) return;
        if (liveNoticeFrames) {
          const activity = deskIdle ? "idle" : interaction?.noticeActivityForStation?.(i);
          if (!activity) throw new Error(`Missing live notice activity for station ${i}`);
          (notice.material as THREE.MeshBasicMaterial).map = liveNoticeFrames[activity];
          notice.scale.setScalar(deskIdle ? 0.65 : 1);
          (notice.material as THREE.MeshBasicMaterial).opacity = deskIdle ? 0.7 : 1;
        } else {
          if (!request) throw new Error(`Missing request for station ${i}`);
          const step = request.status === "working" ? Math.min(16, Math.floor(request.progress * 16)) : 0;
          (notice.material as THREE.MeshBasicMaterial).map = noticeFrames[request.status][step];
        }
        notice.position.y = 2.06 + (reducedMotion ? 0 : Math.sin(animationTime * 1.45 + i * 0.9) * 0.09);
        notice.rotation.z = reducedMotion ? 0 : Math.sin(animationTime * 0.95 + i) * 0.025;
      });
      agentMeshes.forEach((model, index) => {
        const agent: Agent = simulation.agents[index];
        model.group.visible = model.shadow.visible = !!agent;
        if (!agent) return;
        const position = interpolatePosition(previousPositions[index], agent, alpha);
        const atDesk = isLive && agent.target.x === stationPositions[index]?.x &&
          agent.target.z === stationPositions[index]?.z;
        const seated = isLive && agent.state === "idle" &&
          (atDesk || index >= DESKS.length && isLoungeSeat(agent.target));
        model.idleBlend = THREE.MathUtils.damp(model.idleBlend, agent.state === "idle" ? 1 : 0, 5, frameDelta);
        model.group.position.set(position.x,
          (seated ? 0.14 : 0) + (reducedMotion ? 0 : Math.sin(animationTime * 1.6 + index) *
            (seated ? 0.01 : isLive ? 0.04 : 0.085) * model.idleBlend),
          position.z);
        model.group.rotation.z = reducedMotion ? 0 : Math.sin(animationTime * 1.05 + index) *
          (seated ? 0.007 : 0.014) * model.idleBlend;
        model.shadow.position.set(position.x, 0.095, position.z);
        model.shadow.scale.setScalar(index === selectedAgent && isLive ? 1.22 : 1);
        (model.shadow.material as THREE.MeshBasicMaterial).opacity =
          (index === selectedAgent && isLive ? 0.7 : 0.54) * (0.72 + daylightShadow * 0.28);
        if (model.halo) {
          model.halo.visible = index === selectedAgent && agent.x < 50;
          if (model.halo.visible) {
            model.halo.position.set(position.x, 0.105, position.z);
            model.halo.scale.setScalar(reducedMotion ? 1 : 1 + Math.sin(animationTime * 2.4) * 0.045);
            (model.halo.material as THREE.MeshBasicMaterial).opacity =
              reducedMotion ? 0.4 : 0.35 + Math.sin(animationTime * 2.4) * 0.11;
          }
        }
        if (agent.state === "idle") {
          model.facing = atDesk ? "away" : index < DESKS.length ? index < 2 ? "right" : "left" :
            (index - DESKS.length) % 2 === 0 ? "right" : "left";
        } else if (agent.state === "working") {
          model.facing = "away";
        } else {
          const dx = agent.target.x - agent.x;
          const dz = agent.target.z - agent.z;
          if (dz < -Math.abs(dx) * 0.85 && Math.abs(dz) > 0.2) model.facing = "away";
          else if (Math.abs(dx) > 0.2) model.facing = dx < 0 ? "left" : "right";
          else if (dz > 0.2) model.facing = "left";
        }
        if (model.mugSteam) {
          model.mugSteam.visible = index < simulation.progress.capacity && agent.state === "idle" && !seated;
          model.mugSteam.position.x = model.facing === "left" ? -0.35 : 0.35;
        }
        const pose: keyof AgentArt = agent.state === "working" ? "working" :
          agent.state === "idle" ? seated ? "sitting" : "coffee" :
          !reducedMotion && Math.sin(animationTime * 8 + index) > 0 ? "stepA" : "stepB";
        const frame = model.frames[pose][model.facing];
        if (frame !== (model.figure.material as THREE.MeshStandardMaterial).map) {
          (model.figure.material as THREE.MeshStandardMaterial).map = frame;
          (model.figure.material as THREE.MeshStandardMaterial).emissiveMap = frame;
          (model.backing.material as THREE.MeshStandardMaterial).map = frame;
          (model.backing.material as THREE.MeshStandardMaterial).emissiveMap = frame;
        }
      });
      specks.forEach((speck, i) => {
        speck.position.y = 2.2 + (reducedMotion ? 0 : Math.sin(animationTime * 1.2 + i * 2.1) * 0.15);
        speck.visible = busy || i % 3 === 0;
      });
      if (focusIndex !== null && focusIndex < simulation.progress.capacity) {
        const agent = simulation.agents[focusIndex];
        const easing = reducedMotion ? 1 : 1 - Math.exp(-frameDelta * 7);
        panX = THREE.MathUtils.lerp(panX, THREE.MathUtils.clamp(agent.x + 1.15, isLive ? -7.8 : -5.5, isLive ? 7.8 : 5.5), easing);
        panZ = THREE.MathUtils.lerp(panZ, THREE.MathUtils.clamp(agent.z, isLive ? -4.8 : -3.5, isLive ? 4.8 : 3.5), easing);
        zoom = THREE.MathUtils.lerp(zoom, focusedZoom, easing);
      } else if (returningView) {
        const easing = reducedMotion ? 1 : 1 - Math.exp(-frameDelta * 7);
        panX = THREE.MathUtils.lerp(panX, returningView.panX, easing);
        panZ = THREE.MathUtils.lerp(panZ, returningView.panZ, easing);
        zoom = THREE.MathUtils.lerp(zoom, returningView.zoom, easing);
        if (Math.abs(panX - returningView.panX) < 0.005 &&
          Math.abs(panZ - returningView.panZ) < 0.005 &&
          Math.abs(zoom - returningView.zoom) < 0.005) {
          panX = returningView.panX;
          panZ = returningView.panZ;
          zoom = returningView.zoom;
          returningView = null;
        }
      }
      camera.zoom = zoom;
      camera.position.set(cameraBase.x + panX, cameraBase.y, cameraBase.z + panZ);
      camera.lookAt(panX, 0.4, panZ);
      camera.updateProjectionMatrix();
      sky.position.copy(camera.position);
      if (!contextLost) renderer.render(scene, camera);
    },
    dispose() {
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      if (interaction) canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      host.classList.remove("context-lost");
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          if (object.material instanceof THREE.MeshBasicMaterial && object.material.map === beamTexture) {
            object.material.map = null;
          }
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((item) => item.dispose());
        }
        if (object instanceof THREE.Sprite) {
          object.material.map?.dispose();
          object.material.dispose();
        }
        if (object instanceof THREE.Points) {
          object.geometry.dispose();
          object.material.dispose();
        }
      });
      beamTexture.dispose();
      poolTexture.dispose();
      shadowTexture.dispose();
      artTextures.forEach((art) => art.dispose());
      renderer.dispose();
      if (isLive) delete host.dataset.visibleDesks;
      canvas.remove();
    },
  };
}
