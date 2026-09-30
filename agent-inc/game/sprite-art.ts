import * as THREE from "three";
import type { DeskProp } from "./live-layout";

type Pose = "idle" | "stepA" | "stepB" | "working" | "coffee" | "sitting";
export type Facing = "left" | "right" | "away";
export type AgentArt = Record<Pose, Record<Facing, THREE.CanvasTexture>>;

const workers = [
  { coat: "#79bda5", shade: "#568b8d", deep: "#426a7e", hair: "#49445e", hairLight: "#756480", skin: "#e7af8f", skinLight: "#ffd2a6", accent: "#f5e2a2" },
  { coat: "#b29acb", shade: "#80759f", deep: "#60577f", hair: "#65516a", hairLight: "#9e7887", skin: "#c99074", skinLight: "#eab997", accent: "#f5c39b" },
  { coat: "#d99683", shade: "#ab727d", deep: "#755d78", hair: "#34374f", hairLight: "#65647b", skin: "#aa745b", skinLight: "#d4a27d", accent: "#d5efbc" },
  { coat: "#d9bc78", shade: "#a78673", deep: "#786b78", hair: "#a87962", hairLight: "#d2a477", skin: "#ddab85", skinLight: "#f7caa3", accent: "#a7ddd1" },
  { coat: "#86a9cf", shade: "#617fa9", deep: "#40577e", hair: "#36394d", hairLight: "#656a82", skin: "#b98069", skinLight: "#d9a089", accent: "#e7bf84" },
  { coat: "#e1a7bd", shade: "#b3779c", deep: "#865a7e", hair: "#5b3c40", hairLight: "#996166", skin: "#e4b998", skinLight: "#f6d2af", accent: "#93d7ba" },
  { coat: "#85c5ad", shade: "#568e81", deep: "#426b72", hair: "#252e42", hairLight: "#546378", skin: "#9f654e", skinLight: "#cc9070", accent: "#f4c899" },
  { coat: "#d7ae70", shade: "#ab795f", deep: "#794d56", hair: "#594256", hairLight: "#96728d", skin: "#c99278", skinLight: "#e6b696", accent: "#b9e2e7" },
  { coat: "#9e98d9", shade: "#7778a9", deep: "#565b86", hair: "#6c4738", hairLight: "#aa7857", skin: "#dda98a", skinLight: "#f2c9a6", accent: "#f5db82" },
  { coat: "#cb8d7b", shade: "#a16868", deep: "#765867", hair: "#2c3037", hairLight: "#636975", skin: "#8f604c", skinLight: "#bb866a", accent: "#a9d3ea" },
  { coat: "#9cbd83", shade: "#6f946d", deep: "#506f61", hair: "#936854", hairLight: "#c5916a", skin: "#ebbd9a", skinLight: "#f8d6ac", accent: "#d8a7db" },
  { coat: "#bd90bb", shade: "#956d9e", deep: "#685677", hair: "#3e3943", hairLight: "#746978", skin: "#bd8665", skinLight: "#e1a582", accent: "#8be0d1" },
  { coat: "#88c4cb", shade: "#5b93a7", deep: "#44677d", hair: "#574652", hairLight: "#967083", skin: "#d99d80", skinLight: "#f1c4a0", accent: "#f2c47d" },
  { coat: "#d7a18d", shade: "#ac7c80", deep: "#785f7f", hair: "#42343d", hairLight: "#77606c", skin: "#9a6a51", skinLight: "#c99172", accent: "#b9df89" },
  { coat: "#aec581", shade: "#829b65", deep: "#5a765a", hair: "#7a5650", hairLight: "#b08575", skin: "#e1ab87", skinLight: "#f4c9a5", accent: "#e3b2d8" },
  { coat: "#818ec4", shade: "#616ba0", deep: "#434e7a", hair: "#493b31", hairLight: "#897057", skin: "#c58d6b", skinLight: "#e7b08b", accent: "#eda7a8" },
];
const outline = "#2d3049";

function pixel(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, width: number, height: number) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
}

function oval(ctx: CanvasRenderingContext2D, color: string, cx: number, cy: number, rx: number, ry: number) {
  for (let dy = -ry; dy <= ry; dy++) {
    const span = Math.floor(rx * Math.sqrt(1 - (dy * dy) / ((ry + 0.5) * (ry + 0.5))));
    pixel(ctx, color, cx - span, cy + dy, span * 2 + 1, 1);
  }
}

function speckle(ctx: CanvasRenderingContext2D, color: string, points: readonly [number, number][]) {
  for (const [x, y] of points) pixel(ctx, color, x, y, 1, 1);
}

function texture(width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is required to draw the office sprites.");
  paint(ctx);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.NearestFilter;
  map.minFilter = THREE.NearestFilter;
  map.generateMipmaps = false;
  return map;
}

export const AGENTCORP_MARK = [
  { color: "#74e7cc", rects: [[5, 0, 6, 1], [3, 1, 10, 1], [2, 2, 12, 1], [1, 3, 14, 2], [0, 5, 16, 6], [1, 11, 14, 2], [2, 13, 12, 1], [4, 14, 8, 1]] },
  { color: "#263247", rects: [[5, 1, 6, 1], [3, 2, 10, 1], [2, 3, 12, 2], [1, 5, 14, 6], [2, 11, 12, 2], [3, 13, 10, 1]] },
  { color: "#ddf7d8", rects: [[5, 3, 6, 1], [3, 4, 10, 8], [4, 12, 8, 1]] },
  { color: "#f4ffe9", rects: [[5, 4, 6, 1], [4, 5, 2, 4]] },
  { color: "#314058", rects: [[5, 6, 2, 2], [9, 6, 2, 2], [4, 9, 1, 2], [5, 11, 2, 1], [7, 12, 2, 1], [9, 11, 2, 1], [11, 9, 1, 2]] },
  { color: "#eaa99c", rects: [[3, 9, 1, 1], [12, 9, 1, 1]] },
] as const;

function drawAgentCorpMark(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  for (const { color, rects } of AGENTCORP_MARK) {
    for (const [left, top, width, height] of rects) {
      pixel(ctx, color, x + left * scale, y + top * scale, width * scale, height * scale);
    }
  }
}

function drawAgent(ctx: CanvasRenderingContext2D, id: number, pose: Pose, facing: Facing) {
  const { coat, shade, deep, hair, hairLight, skin, skinLight, accent } = workers[id % workers.length];
  const step = pose === "stepA" ? -2 : pose === "stepB" ? 2 : 0;
  const working = pose === "working";
  const left = facing === "left";
  const armY = working ? 22 : pose === "sitting" ? 21 : 24;

  if (pose === "sitting") {
    for (const x of [8, 19]) {
      pixel(ctx, outline, x, 30, 8, 5);
      pixel(ctx, deep, x + 1, 31, 6, 3);
      pixel(ctx, outline, x + (left ? -2 : 1), 34, 8, 3);
      pixel(ctx, shade, x + (left ? -1 : 2), 34, 5, 1);
    }
  } else {
    for (const [legX, footX] of [[11 + step, 8 + step], [19 - step, 18 - step]]) {
      pixel(ctx, outline, legX, 30, 4, 7);
      pixel(ctx, deep, legX + 1, 31, 2, 5);
      pixel(ctx, outline, footX, 36, 7, 3);
      pixel(ctx, shade, footX + 1, 36, 4, 1);
    }
  }
  for (const x of [6, 23]) {
    pixel(ctx, outline, x, armY, 4, 7);
    pixel(ctx, shade, x + 1, armY + 1, 2, 5);
    pixel(ctx, coat, x + 1, armY + 1, 2, 3);
    pixel(ctx, skin, x + 1, armY + 6, 3, 2);
  }
  oval(ctx, outline, 16, 25, 9, 7);
  oval(ctx, deep, 18, 26, 6, 5);
  oval(ctx, coat, 14, 24, 6, 5);
  pixel(ctx, accent, 12, 20, 7, 2);
  pixel(ctx, skinLight, 15, 22, 2, 2);
  pixel(ctx, shade, 11, 28, 3, 2);
  pixel(ctx, outline, 16, 24, 1, 7);

  if (facing === "away") {
    oval(ctx, coat, 16, 25, 7, 6);
    pixel(ctx, shade, 10, 24, 3, 6);
    pixel(ctx, accent, 15, 24, 2, 5);
    oval(ctx, outline, 16, 13, 10, 10);
    oval(ctx, hair, 16, 12, 9, 8);
    oval(ctx, hairLight, 13, 9, 5, 3);
    pixel(ctx, skin, 6, 16, 2, 3);
    pixel(ctx, skin, 24, 16, 2, 3);
    if (id % 4 === 1) {
      pixel(ctx, hair, 7, 16, 4, 7);
      pixel(ctx, hair, 22, 16, 4, 7);
    } else if (id % 4 === 2) {
      pixel(ctx, hair, 7, 16, 5, 4);
      pixel(ctx, hairLight, 19, 8, 5, 2);
    } else if (id % 4 === 3) {
      pixel(ctx, accent, 10, 8, 14, 3);
      pixel(ctx, hair, 7, 11, 18, 3);
    } else {
      pixel(ctx, hairLight, 10, 5, 6, 2);
      pixel(ctx, hair, 8, 12, 5, 5);
    }
    if (pose === "coffee") {
      pixel(ctx, outline, 23, 24, 6, 7);
      pixel(ctx, "#fff2d3", 24, 25, 4, 5);
      pixel(ctx, shade, 25, 26, 2, 2);
    }
    if (working) pixel(ctx, accent, 12, 29, 8, 1);
    return;
  }

  oval(ctx, outline, 16, 13, 10, 10);
  oval(ctx, hair, 16, 11, 9, 8);
  oval(ctx, skin, 16, 16, 7, 6);
  oval(ctx, skinLight, left ? 13 : 15, 14, 4, 3);
  pixel(ctx, skin, left ? 25 : 6, 15, 2, 3);

  switch (id % 4) {
    case 0:
      oval(ctx, hair, 14, 7, 8, 4);
      pixel(ctx, hairLight, 10, 5, 6, 2);
      pixel(ctx, hair, left ? 6 : 19, 10, 7, 5);
      break;
    case 1:
      oval(ctx, hair, 16, 7, 9, 5);
      pixel(ctx, hairLight, 12, 5, 6, 2);
      pixel(ctx, hair, 6, 12, 4, 8);
      pixel(ctx, hair, 23, 11, 3, 8);
      pixel(ctx, accent, 12, 22, 8, 2);
      break;
    case 2:
      oval(ctx, hair, 16, 9, 10, 7);
      pixel(ctx, hairLight, 10, 5, 6, 2);
      pixel(ctx, hair, left ? 6 : 22, 12, 4, 6);
      pixel(ctx, outline, 10, 14, 5, 3);
      pixel(ctx, outline, 18, 14, 5, 3);
      pixel(ctx, outline, 15, 15, 3, 1);
      pixel(ctx, skinLight, 11, 15, 3, 1);
      pixel(ctx, skinLight, 19, 15, 3, 1);
      break;
    default:
      oval(ctx, hair, 16, 9, 9, 6);
      pixel(ctx, outline, 7, 9, 18, 3);
      pixel(ctx, accent, 9, 9, 14, 2);
      pixel(ctx, hair, 11, 12, 5, 2);
      pixel(ctx, accent, 20, 24, 3, 2);
      break;
  }

  pixel(ctx, outline, left ? 12 : 19, 16, 2, working ? 1 : 2);
  pixel(ctx, outline, left ? 19 : 12, 16, 1, working ? 1 : 2);
  pixel(ctx, shade, left ? 11 : 21, 18, 1, 1);
  pixel(ctx, "#bd7979", left ? 14 : 16, 20, 3, 1);
  if (pose === "coffee") {
    pixel(ctx, outline, left ? 1 : 25, 23, 6, 7);
    pixel(ctx, "#fff2d3", left ? 2 : 26, 24, 4, 5);
    pixel(ctx, shade, left ? 3 : 27, 26, 3, 1);
  }
  if (working) {
    pixel(ctx, accent, 12, 29, 8, 1);
  }
}

export function agentArt(id: number): AgentArt {
  const draw = (pose: Pose): Record<Facing, THREE.CanvasTexture> => ({
    left: texture(32, 40, (ctx) => drawAgent(ctx, id, pose, "left")),
    right: texture(32, 40, (ctx) => drawAgent(ctx, id, pose, "right")),
    away: texture(32, 40, (ctx) => drawAgent(ctx, id, pose, "away")),
  });
  return {
    idle: draw("idle"),
    stepA: draw("stepA"),
    stepB: draw("stepB"),
    working: draw("working"),
    coffee: draw("coffee"),
    sitting: draw("sitting"),
  };
}

const portraits = new Map<number, string>();
export function agentPortrait(id: number): string {
  const cached = portraits.get(id);
  if (cached) return cached;
  const source = document.createElement("canvas");
  source.width = 32; source.height = 40;
  const sourceContext = source.getContext("2d");
  if (!sourceContext) throw new Error("Canvas 2D is required for agent portraits.");
  drawAgent(sourceContext, id, "idle", "right");
  const portrait = document.createElement("canvas");
  portrait.width = portrait.height = 48;
  const context = portrait.getContext("2d");
  if (!context) throw new Error("Canvas 2D is required for agent portraits.");
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 4, 1, 24, 24, 0, 0, 48, 48);
  const image = portrait.toDataURL("image/png");
  portraits.set(id, image);
  return image;
}

export function coffeeCounterArt(variant: "game" | "live" = "game"): THREE.CanvasTexture {
  return texture(96, 56, (ctx) => {
    pixel(ctx, outline, 6, 22, 84, 31);
    pixel(ctx, "#775d70", 8, 27, 80, 23);
    pixel(ctx, "#a17b80", 10, 30, 75, 13);
    pixel(ctx, "#d9ac8e", 12, 30, 70, 3);
    pixel(ctx, "#3c384e", 30, 34, 36, 9);
    pixel(ctx, "#5aa59a", 33, 36, 30, 3);
    pixel(ctx, "#e4c391", 36, 39, 24, 2);
    pixel(ctx, "#f0d3ae", 9, 20, 79, 9);
    pixel(ctx, "#fff0d1", 13, 21, 69, 2);
    if (variant === "live") {
      pixel(ctx, outline, 30, 1, 38, 22);
      pixel(ctx, "#849399", 32, 3, 34, 18);
      pixel(ctx, "#e3e7df", 34, 5, 30, 4);
      pixel(ctx, "#707d84", 35, 8, 28, 2);
      for (const x of [38, 51]) {
        pixel(ctx, outline, x, 11, 10, 3);
        pixel(ctx, "#d5ddda", x + 1, 12, 8, 2);
        pixel(ctx, outline, x + 3, 14, 4, 4);
        pixel(ctx, "#f6f1e4", x + 2, 18, 7, 4);
        pixel(ctx, "#9a6d55", x + 3, 18, 5, 1);
        pixel(ctx, outline, x + 8, 19, 2, 2);
      }
      pixel(ctx, outline, 33, 22, 33, 3);
      pixel(ctx, "#c2cccb", 35, 22, 28, 1);
      pixel(ctx, "#bcc8c5", 65, 11, 2, 9);
      pixel(ctx, outline, 67, 18, 4, 2);
      pixel(ctx, outline, 76, 0, 10, 5);
      pixel(ctx, "#79564a", 77, 1, 8, 3);
      pixel(ctx, outline, 78, 5, 6, 8);
      pixel(ctx, "#b8c5c4", 78, 13, 7, 9);
      pixel(ctx, "#708087", 79, 15, 5, 3);
      pixel(ctx, "#68514d", 80, 19, 3, 2);
    } else {
      pixel(ctx, outline, 35, 3, 27, 18);
      pixel(ctx, "#777087", 38, 5, 21, 14);
      pixel(ctx, "#b9a2aa", 39, 5, 14, 3);
      pixel(ctx, "#3b5260", 42, 9, 13, 8);
      pixel(ctx, "#8be0bd", 44, 11, 9, 3);
      pixel(ctx, outline, 41, 18, 16, 3);
    }
    for (const x of variant === "live" ? [16] : [17, 70]) {
      pixel(ctx, outline, x, 14, 9, 8);
      pixel(ctx, "#f8e6cd", x + 1, 15, 6, 5);
      pixel(ctx, "#82bbad", x + 2, 16, 3, 2);
      if (variant === "game") pixel(ctx, "#f4d5af", x + 2, 11, 2, 3);
    }
    pixel(ctx, outline, 10, 50, 14, 4);
    pixel(ctx, outline, 73, 50, 14, 4);
  });
}

export function chatRoomTitleArt(text = "CHAT ROOM"): THREE.CanvasTexture {
  return texture(256, 64, (ctx) => {
    pixel(ctx, "#3b344d", 5, 8, 246, 49);
    pixel(ctx, "#d5a989", 8, 11, 240, 43);
    pixel(ctx, "#51445c", 13, 15, 230, 35);
    pixel(ctx, "#bce7cd", 18, 20, 6, 25);
    pixel(ctx, "#bce7cd", 232, 20, 6, 25);
    ctx.fillStyle = "#fff0ce";
    ctx.font = "bold 31px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 34);
  });
}

export const AGENTCORP_WORDMARK = "AGENTCORP";
export const AGENTCORP_LETTERS: Record<string, readonly string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  N: ["10001", "11001", "10101", "10101", "10011", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
};

export function agentCorpNeonArt(): THREE.CanvasTexture {
  return texture(256, 80, (ctx) => {
    pixel(ctx, "#111b2a", 2, 6, 252, 68);
    pixel(ctx, "#42616c", 5, 9, 246, 62);
    pixel(ctx, "#172637", 8, 12, 240, 56);
    pixel(ctx, "#74e7cc", 9, 13, 2, 13);
    pixel(ctx, "#74e7cc", 9, 55, 2, 12);
    pixel(ctx, "#b6a1d7", 245, 13, 2, 13);
    pixel(ctx, "#b6a1d7", 245, 55, 2, 12);
    pixel(ctx, "#506577", 16, 62, 222, 1);
    drawAgentCorpMark(ctx, 20, 24, 2);
    pixel(ctx, "#4edec7", 61, 20, 2, 40);
    let x = 73;
    for (const [index, letter] of [...AGENTCORP_WORDMARK].entries()) {
      const rows = AGENTCORP_LETTERS[letter];
      for (const [row, bits] of rows.entries()) {
        for (const [column, bit] of [...bits].entries()) {
          if (bit === "0") continue;
          pixel(ctx, "#34435d", x + column * 3 + 1, 28 + row * 3 + 2, 3, 3);
          pixel(ctx, index < 5 ? "#a7ffe6" : "#e3caf7",
            x + column * 3, 28 + row * 3, 3, 3);
        }
      }
      x += 18;
    }
    pixel(ctx, "#e6b48a", 201, 62, 29, 2);
    pixel(ctx, "#a7ffe6", 20, 62, 30, 2);
  });
}

export function stationNoticeArt(status: "queued" | "assigned" | "working" | "complete" | "failed", progressStep = 0): THREE.CanvasTexture {
  return texture(48, 48, (ctx) => {
    pixel(ctx, "#31334c", 5, 5, 38, 38);
    pixel(ctx, "#f7e9cc", 8, 8, 32, 32);
    pixel(ctx, status === "failed" ? "#d2828c" : "#8bbda9", 10, 10, 28, 3);
    pixel(ctx, "#4a465d", 14, 18, 21, 13);
    pixel(ctx, "#fff2d7", 17, 20, 15, 8);
    pixel(ctx, status === "failed" ? "#d2828c" : "#72b4a5", 20, 22, 9, 2);
    pixel(ctx, "#4a465d", 18, 30, 5, 4);
    pixel(ctx, "#fff0d1", 25, 31, 5, 2);
    const filled = status === "working" ? progressStep : status === "complete" || status === "failed" ? 16 : 0;
    for (let i = 0; i < 16; i++) {
      const side = Math.floor(i / 4);
      const offset = i % 4;
      const x = side === 0 ? 6 + offset * 9 : side === 1 ? 41 : side === 2 ? 33 - offset * 9 : 4;
      const y = side === 0 ? 3 : side === 1 ? 6 + offset * 9 : side === 2 ? 41 : 33 - offset * 9;
      pixel(ctx, i < filled ? status === "failed" ? "#f2a3a3" : "#95f2cc" : "#74617d",
        x, y, side % 2 === 0 ? 8 : 3, side % 2 === 0 ? 3 : 8);
    }
    if (status === "queued" || status === "assigned") {
      pixel(ctx, "#f5b978", 22, 15, 4, 5);
      pixel(ctx, "#f5b978", 22, 33, 4, 3);
    }
  });
}

export type LiveNoticeActivity =
  "thinking" | "terminal" | "checks" | "research" | "editing" | "delegating" | "working" | "blocked";

export function liveNoticeArt(activity: LiveNoticeActivity): THREE.CanvasTexture {
  const accents: Record<LiveNoticeActivity, string> = {
    thinking: "#deb77f", terminal: "#8bbde0", checks: "#79bc9d", research: "#a6c993",
    editing: "#e4a182", delegating: "#b6a0d4", working: "#79c8ba", blocked: "#d9858b",
  };
  return texture(48, 48, (ctx) => {
    const accent = accents[activity];
    pixel(ctx, outline, 4, 4, 40, 40);
    pixel(ctx, "#fff8e9", 7, 7, 34, 34);
    pixel(ctx, accent, 9, 9, 30, 4);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = outline;
    ctx.fillStyle = outline;
    switch (activity) {
      case "thinking":
        ctx.beginPath();
        ctx.moveTo(15, 18);
        ctx.lineTo(33, 18);
        ctx.lineTo(33, 30);
        ctx.lineTo(21, 30);
        ctx.lineTo(17, 34);
        ctx.lineTo(17, 30);
        ctx.lineTo(15, 30);
        ctx.closePath();
        ctx.stroke();
        for (const x of [19, 24, 29]) pixel(ctx, outline, x, 23, 3, 3);
        break;
      case "terminal":
        pixel(ctx, outline, 13, 17, 22, 18);
        pixel(ctx, "#344b61", 16, 20, 16, 12);
        ctx.strokeStyle = "#fff8e9";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(19, 23);
        ctx.lineTo(23, 26);
        ctx.lineTo(19, 29);
        ctx.moveTo(25, 30);
        ctx.lineTo(30, 30);
        ctx.stroke();
        break;
      case "checks":
        ctx.beginPath();
        ctx.arc(24, 26, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(18, 26);
        ctx.lineTo(22, 30);
        ctx.lineTo(30, 22);
        ctx.stroke();
        break;
      case "research":
        ctx.beginPath();
        ctx.arc(21, 23, 7, 0, Math.PI * 2);
        ctx.moveTo(26, 28);
        ctx.lineTo(34, 36);
        ctx.stroke();
        break;
      case "editing":
        ctx.beginPath();
        ctx.moveTo(15, 33);
        ctx.lineTo(18, 26);
        ctx.lineTo(29, 16);
        ctx.lineTo(34, 21);
        ctx.lineTo(23, 32);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(18, 27);
        ctx.lineTo(23, 32);
        ctx.moveTo(29, 17);
        ctx.lineTo(33, 22);
        ctx.stroke();
        break;
      case "delegating":
        for (const x of [18, 30]) {
          ctx.beginPath();
          ctx.arc(x, 21, 3, 0, Math.PI * 2);
          ctx.moveTo(x - 6, 34);
          ctx.arc(x, 34, 6, Math.PI, 0);
          ctx.stroke();
        }
        break;
      case "working":
        ctx.save();
        ctx.translate(24, 26);
        for (let i = 0; i < 8; i++) {
          ctx.rotate(Math.PI / 4);
          pixel(ctx, outline, -2, -12, 4, 6);
        }
        ctx.beginPath();
        ctx.arc(0, 0, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff8e9";
        ctx.beginPath();
        ctx.arc(0, 0, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        break;
      case "blocked":
        ctx.beginPath();
        ctx.moveTo(24, 16);
        ctx.lineTo(35, 35);
        ctx.lineTo(13, 35);
        ctx.closePath();
        ctx.stroke();
        pixel(ctx, outline, 22, 22, 4, 7);
        pixel(ctx, outline, 22, 31, 4, 3);
        break;
      default: {
        const unknown: never = activity;
        throw new Error(`Unknown live notice activity: ${unknown}`);
      }
    }
  });
}

function liveMonitorScreen(ctx: CanvasRenderingContext2D, index: number) {
  const violet = index % 2 === 1;
  pixel(ctx, violet ? "#392c63" : "#15505c", 12, 9, 17, 14);
  pixel(ctx, violet ? "#7954af" : "#278a93", 13, 10, 15, 2);
  pixel(ctx, violet ? "#f0caff" : "#b7ffe7", 14, 13, 10, 2);
  pixel(ctx, violet ? "#be8eee" : "#57e5d2", 14, 17, 12, 2);
  pixel(ctx, violet ? "#8966b7" : "#46a8ad", 14, 21, 7, 1);
  pixel(ctx, "#f4d5a4", 25, 21, 2, 2);
}

export function monitorArt(index: number, powered = true, variant: "game" | "live" = "game"): THREE.CanvasTexture {
  return texture(40, 40, (ctx) => {
    const glow = index % 2 ? "#d4b5ee" : "#9ce4ce";
    pixel(ctx, outline, 7, 3, 25, 28);
    pixel(ctx, outline, 5, 6, 30, 21);
    pixel(ctx, "#806d91", 8, 5, 24, 23);
    pixel(ctx, "#c0a6bb", 9, 5, 18, 2);
    pixel(ctx, "#39394e", 11, 8, 20, 17);
    pixel(ctx, powered ? "#30485c" : "#292c3f", 12, 9, 17, 14);
    if (powered) {
      if (variant === "live") {
        liveMonitorScreen(ctx, index);
      } else {
        pixel(ctx, "#568f9c", 13, 10, 11, 1);
        pixel(ctx, glow, 14, 12, 10, 2);
        pixel(ctx, "#ffdfaa", 14, 16, 7, 1);
        pixel(ctx, glow, 14, 19, 12, 2);
        pixel(ctx, "#6f9eaa", 14, 22, 5, 1);
      }
    } else {
      pixel(ctx, "#454358", 13, 10, 12, 1);
      pixel(ctx, "#383749", 14, 13, 10, 7);
    }
    pixel(ctx, "#f6d7aa", 14, 27, 11, 2);
    pixel(ctx, outline, 18, 31, 5, 5);
    pixel(ctx, "#aa8da5", 19, 31, 2, 4);
    pixel(ctx, outline, 12, 36, 17, 3);
    pixel(ctx, "#ffedcc", 14, 36, 12, 1);
    if (variant === "game") speckle(ctx, "#e9e1db", [[10, 8], [10, 9], [31, 26], [30, 27]]);
  });
}

export function monitorEmissionArt(index: number): THREE.CanvasTexture {
  return texture(40, 40, (ctx) => liveMonitorScreen(ctx, index));
}

export function terminalArt(): THREE.CanvasTexture {
  return texture(42, 50, (ctx) => {
    pixel(ctx, outline, 6, 5, 30, 35);
    pixel(ctx, outline, 8, 3, 26, 39);
    pixel(ctx, "#855f84", 9, 6, 25, 34);
    pixel(ctx, "#c39aaf", 9, 6, 20, 5);
    pixel(ctx, "#fae7cd", 11, 9, 21, 27);
    pixel(ctx, "#fff4db", 12, 10, 18, 3);
    pixel(ctx, "#2d4455", 13, 13, 17, 20);
    pixel(ctx, "#466f77", 14, 14, 13, 3);
    pixel(ctx, "#b1f0d6", 16, 19, 12, 2);
    pixel(ctx, "#81b3aa", 16, 24, 9, 2);
    pixel(ctx, "#f4c898", 16, 28, 11, 1);
    pixel(ctx, "#edf7d9", 20, 31, 3, 2);
    pixel(ctx, outline, 16, 40, 11, 6);
    pixel(ctx, "#9f8296", 18, 41, 7, 3);
    pixel(ctx, outline, 9, 46, 25, 3);
    pixel(ctx, "#f8e8c9", 12, 46, 18, 1);
    speckle(ctx, "#fff9e5", [[12, 7], [13, 7], [11, 13], [12, 13]]);
  });
}

function monsteraLeaf(
  ctx: CanvasRenderingContext2D, x: number, y: number,
  width: number, height: number, angle: number, color: string, highlight: string,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  oval(ctx, "#204a46", 0, 0, width + 1, height + 1);
  oval(ctx, color, 0, 0, width, height);
  speckle(ctx, highlight, [
    [-Math.floor(width * 0.6), -3], [-Math.floor(width * 0.4), -6],
    [-Math.floor(width * 0.3), 4], [Math.floor(width * 0.4), -5],
    [Math.floor(width * 0.6), 2],
  ]);
  for (const side of [-1, 1]) {
    for (let step = 2; step < width * 0.55; step += 2) {
      pixel(ctx, highlight, side * step, -Math.floor(step * 0.35), 2, 1);
      pixel(ctx, "#256a58", side * step, Math.floor(step * 0.4), 2, 1);
    }
  }
  for (const side of [-1, 1]) {
    for (const [row, depth] of [
      [-Math.floor(height * 0.52), Math.max(3, Math.floor(width * 0.28))],
      [Math.floor(height * 0.18), Math.max(4, Math.floor(width * 0.4))],
    ]) {
      for (let step = 0; step < 4; step++) {
        const bite = Math.round(depth - Math.abs(step - 1.5) * 0.65);
        ctx.clearRect(side < 0 ? -width - 1 : width + 1 - bite, row + step, bite, 1);
      }
    }
    const holeX = side < 0 ? -Math.floor(width * 0.36) : Math.floor(width * 0.36) - 3;
    ctx.clearRect(holeX, -2, 3, 5);
  }
  ctx.clearRect(-2, -height - 1, 4, Math.max(4, Math.floor(height * 0.48)));
  pixel(ctx, "#b9d89b", -1, -height + 5, 2, height * 2 - 9);
  ctx.restore();
}

export function monsteraArt(): THREE.CanvasTexture {
  return texture(80, 96, (ctx) => {
    ctx.lineCap = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#244d4d";
    ctx.beginPath();
    ctx.moveTo(40, 74);
    ctx.lineTo(39, 28);
    ctx.moveTo(40, 71);
    ctx.lineTo(20, 44);
    ctx.moveTo(40, 68);
    ctx.lineTo(58, 45);
    ctx.moveTo(40, 73);
    ctx.lineTo(28, 59);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#8bc194";
    ctx.stroke();

    monsteraLeaf(ctx, 28, 57, 9, 7, -0.25, "#4aab77", "#a7d99e");
    monsteraLeaf(ctx, 20, 40, 14, 12, -0.32, "#287e5a", "#79c988");
    monsteraLeaf(ctx, 58, 41, 14, 12, 0.27, "#3b9c68", "#a1d993");
    monsteraLeaf(ctx, 39, 19, 19, 15, 0.07, "#2d9062", "#82ce8c");

    pixel(ctx, "#244d4d", 25, 69, 30, 5);
    pixel(ctx, "#a27655", 27, 70, 26, 2);
    for (let y = 74; y < 88; y++) {
      const inset = Math.floor((y - 74) / 5);
      pixel(ctx, "#334c50", 28 + inset, y, 24 - inset * 2, 1);
      pixel(ctx, "#efe9d7", 30 + inset, y, 20 - inset * 2, 1);
      pixel(ctx, "#fff8e7", 31 + inset, y, 6, 1);
      pixel(ctx, "#bbd1c7", 46 - inset, y, 3, 1);
    }
    pixel(ctx, "#334c50", 31, 88, 18, 2);
    for (const x of [26, 52]) {
      pixel(ctx, "#4a4b49", x, 84, 5, 10);
      pixel(ctx, "#b9855a", x + 1, 84, 3, 8);
    }
    pixel(ctx, "#4a4b49", 26, 91, 31, 3);
    pixel(ctx, "#bd8960", 28, 91, 27, 1);
  });
}

export function bookcaseArt(index: number): THREE.CanvasTexture {
  return texture(64, 96, (ctx) => {
    const spines = ["#89c2a3", "#dfae83", "#b79bd3", "#d78e85", "#a1bad1", "#ead09b"];
    pixel(ctx, outline, 5, 3, 54, 91);
    pixel(ctx, "#866475", 8, 6, 48, 85);
    pixel(ctx, "#b58a7e", 9, 7, 46, 4);
    pixel(ctx, "#39394d", 12, 12, 40, 68);
    for (let shelf = 0; shelf < 3; shelf++) {
      const bottom = 33 + shelf * 22;
      for (let book = 0; book < 7; book++) {
        const height = 12 + (book * 3 + shelf * 5 + index * 2) % 7;
        const x = 13 + book * 6;
        pixel(ctx, outline, x, bottom - height, 5, height);
        pixel(ctx, spines[(book + shelf + index) % spines.length], x + 1, bottom - height + 1, 3, height - 2);
        pixel(ctx, "#f9e4be", x + 2, bottom - height + 4, 1, 2);
      }
      pixel(ctx, "#c39a82", 10, bottom, 44, 4);
      pixel(ctx, "#f1d0a1", 12, bottom, 37, 1);
    }
    pixel(ctx, "#6b576b", 12, 81, 40, 8);
    pixel(ctx, "#d6aa88", 15, 82, 34, 2);
    pixel(ctx, outline, 9, 91, 46, 3);
  });
}

export function workflowKitArt(): THREE.CanvasTexture {
  return texture(28, 24, (ctx) => {
    pixel(ctx, outline, 3, 10, 23, 11);
    pixel(ctx, "#72617c", 4, 11, 20, 8);
    pixel(ctx, "#9c83a1", 5, 11, 15, 3);
    pixel(ctx, "#d1a58c", 7, 6, 13, 6);
    pixel(ctx, "#f2d5a1", 8, 7, 10, 3);
    pixel(ctx, "#eff5d3", 11, 3, 11, 7);
    pixel(ctx, "#77b9a4", 12, 4, 7, 2);
    pixel(ctx, "#f7deaa", 13, 7, 6, 1);
    pixel(ctx, "#aad4b0", 6, 16, 14, 2);
    pixel(ctx, outline, 4, 21, 21, 2);
  });
}

export function deskArt(index: number): THREE.CanvasTexture {
  return texture(80, 70, (ctx) => {
    const top = index % 2 ? "#ead4bb" : "#f3ddba";
    pixel(ctx, outline, 13, 21, 57, 20);
    pixel(ctx, outline, 9, 25, 58, 17);
    pixel(ctx, "#785e78", 11, 30, 57, 16);
    pixel(ctx, "#a97e7f", 10, 26, 56, 15);
    pixel(ctx, "#f8e8c7", 17, 19, 49, 8);
    pixel(ctx, top, 13, 24, 52, 10);
    pixel(ctx, "#fff4d6", 20, 19, 39, 2);
    pixel(ctx, "#d4af9b", 13, 32, 52, 3);
    pixel(ctx, "#9a6d79", 14, 37, 52, 4);
    pixel(ctx, "#efbda2", 19, 32, 26, 2);
    pixel(ctx, "#564664", 14, 42, 10, 22);
    pixel(ctx, "#8c687e", 15, 43, 6, 18);
    pixel(ctx, "#d8a69c", 16, 45, 2, 5);
    pixel(ctx, "#564664", 58, 41, 10, 22);
    pixel(ctx, "#8c687e", 60, 42, 6, 17);
    pixel(ctx, "#d8a69c", 60, 45, 2, 5);
    pixel(ctx, outline, 12, 62, 13, 5);
    pixel(ctx, outline, 56, 61, 14, 5);
    pixel(ctx, "#382d4b", 28, 37, 4, 2);
    pixel(ctx, "#382d4b", 46, 37, 4, 2);
    speckle(ctx, "#fff7de", [[21, 22], [23, 22], [59, 23], [61, 23]]);
  });
}

export function deskDetailArt(kind: DeskProp, index: number): THREE.CanvasTexture {
  return texture(32, 32, (ctx) => {
    const accent = ["#e3b38f", "#acd9c4", "#c4acdd", "#efd09d"][index % 4];
    switch (kind) {
      case "plant":
        pixel(ctx, "#477767", 13, 7, 5, 18);
        pixel(ctx, "#6db093", 5, 10, 11, 5);
        pixel(ctx, "#417e73", 19, 7, 9, 6);
        pixel(ctx, "#a1c68e", 10, 5, 8, 5);
        pixel(ctx, outline, 10, 22, 14, 9);
        pixel(ctx, "#a67979", 12, 23, 10, 6);
        pixel(ctx, accent, 13, 24, 8, 2);
        break;
      case "mug":
        pixel(ctx, outline, 8, 16, 18, 15);
        pixel(ctx, accent, 10, 17, 14, 12);
        pixel(ctx, "#fff3db", 11, 17, 10, 3);
        pixel(ctx, outline, 25, 19, 5, 8);
        pixel(ctx, accent, 26, 21, 3, 4);
        break;
      case "lamp":
        pixel(ctx, "#e6c997", 15, 18, 3, 10);
        pixel(ctx, outline, 8, 11, 20, 9);
        pixel(ctx, accent, 10, 12, 16, 6);
        pixel(ctx, "#fff1bb", 13, 18, 10, 3);
        pixel(ctx, outline, 10, 27, 15, 3);
        pixel(ctx, "#e6c997", 13, 28, 9, 1);
        break;
      case "books":
        pixel(ctx, outline, 4, 23, 26, 8);
        pixel(ctx, "#8db2a2", 6, 24, 21, 2);
        pixel(ctx, accent, 8, 27, 20, 2);
        pixel(ctx, outline, 10, 13, 15, 11);
        pixel(ctx, "#a792bd", 12, 14, 11, 9);
        pixel(ctx, "#f4e1bc", 13, 15, 2, 6);
        break;
      case "notes":
        pixel(ctx, outline, 7, 9, 19, 22);
        pixel(ctx, "#f1d89a", 9, 11, 15, 17);
        pixel(ctx, accent, 13, 9, 7, 3);
        pixel(ctx, "#a28285", 11, 17, 11, 2);
        pixel(ctx, "#a28285", 11, 21, 7, 2);
        pixel(ctx, "#fff1c0", 20, 25, 4, 3);
        break;
      case "headphones":
        pixel(ctx, outline, 8, 10, 16, 4);
        pixel(ctx, outline, 6, 14, 5, 15);
        pixel(ctx, outline, 21, 14, 5, 15);
        pixel(ctx, accent, 9, 11, 14, 2);
        pixel(ctx, "#ac8eac", 8, 18, 3, 8);
        pixel(ctx, "#ac8eac", 21, 18, 3, 8);
        pixel(ctx, outline, 8, 28, 17, 2);
        break;
    }
  });
}

export function chairArt(): THREE.CanvasTexture {
  return texture(40, 54, (ctx) => {
    pixel(ctx, outline, 8, 6, 26, 30);
    pixel(ctx, outline, 6, 9, 30, 24);
    pixel(ctx, "#6c608a", 9, 8, 24, 25);
    pixel(ctx, "#9b83ab", 11, 8, 20, 19);
    pixel(ctx, "#c9aecc", 14, 10, 14, 13);
    pixel(ctx, "#f1d9d0", 15, 10, 9, 2);
    pixel(ctx, outline, 7, 33, 28, 8);
    pixel(ctx, "#8b77a1", 10, 33, 23, 5);
    pixel(ctx, "#c7acc3", 12, 33, 14, 2);
    pixel(ctx, outline, 19, 41, 5, 8);
    pixel(ctx, "#6a5f80", 20, 41, 2, 6);
    pixel(ctx, outline, 10, 48, 24, 4);
    pixel(ctx, "#b2a2b8", 14, 48, 14, 1);
    speckle(ctx, "#f8e4d7", [[14, 15], [17, 14], [28, 23]]);
  });
}

export function loungeSofaArt(side: "left" | "right"): THREE.CanvasTexture {
  return texture(112, 64, (ctx) => {
    const fabric = side === "left" ? "#598c82" : "#82708f";
    const highlight = side === "left" ? "#a7c5ae" : "#c4aec0";
    const shade = side === "left" ? "#355f61" : "#645773";
    pixel(ctx, outline, 8, 16, 96, 40);
    pixel(ctx, fabric, 11, 18, 90, 34);
    pixel(ctx, highlight, 13, 19, 86, 5);
    for (let i = 0; i < 3; i++) {
      const x = 14 + i * 29;
      pixel(ctx, outline, x, 25, 27, 17);
      pixel(ctx, fabric, x + 2, 26, 23, 13);
      pixel(ctx, highlight, x + 3, 27, 19, 3);
      pixel(ctx, shade, x + 3, 39, 21, 2);
      pixel(ctx, outline, x, 42, 27, 11);
      pixel(ctx, highlight, x + 2, 43, 23, 4);
      pixel(ctx, fabric, x + 2, 47, 23, 4);
    }
    pixel(ctx, outline, 4, 35, 13, 21);
    pixel(ctx, outline, 95, 35, 13, 21);
    pixel(ctx, fabric, 6, 37, 9, 15);
    pixel(ctx, fabric, 97, 37, 9, 15);
    pixel(ctx, highlight, 7, 38, 7, 3);
    pixel(ctx, highlight, 98, 38, 7, 3);
    pixel(ctx, shade, 16, 54, 80, 3);
    pixel(ctx, outline, 18, 56, 10, 6);
    pixel(ctx, outline, 84, 56, 10, 6);
    pixel(ctx, "#bd997b", 20, 56, 6, 4);
    pixel(ctx, "#bd997b", 86, 56, 6, 4);
    const pillowX = side === "left" ? 17 : 76;
    pixel(ctx, outline, pillowX, 30, 17, 13);
    pixel(ctx, side === "left" ? "#e6c49e" : "#b5d7c1", pillowX + 2, 31, 13, 10);
    pixel(ctx, "#fff0d3", pillowX + 4, 32, 8, 2);
  });
}

export function loungeFrontArt(side: "left" | "right"): THREE.CanvasTexture {
  return texture(112, 28, (ctx) => {
    const fabric = side === "left" ? "#598c82" : "#82708f";
    const highlight = side === "left" ? "#b2d4bc" : "#d0bbcf";
    const shade = side === "left" ? "#355f61" : "#645773";
    pixel(ctx, outline, 7, 3, 98, 21);
    pixel(ctx, fabric, 9, 5, 94, 16);
    pixel(ctx, highlight, 10, 6, 92, 3);
    pixel(ctx, shade, 9, 19, 94, 3);
    for (const x of [38, 74]) pixel(ctx, shade, x, 10, 2, 11);
    pixel(ctx, outline, 3, 2, 10, 23);
    pixel(ctx, outline, 99, 2, 10, 23);
    pixel(ctx, highlight, 5, 4, 6, 3);
    pixel(ctx, highlight, 101, 4, 6, 3);
  });
}

export function coreBodyArt(): THREE.CanvasTexture {
  return texture(48, 64, (ctx) => {
    pixel(ctx, outline, 7, 46, 36, 14);
    pixel(ctx, "#765b68", 9, 47, 31, 11);
    pixel(ctx, "#b18683", 10, 48, 24, 5);
    pixel(ctx, "#e2b698", 11, 48, 19, 2);
    pixel(ctx, "#533f53", 11, 55, 28, 2);
    pixel(ctx, "#e6c4a4", 13, 55, 6, 1);
    pixel(ctx, "#e6c4a4", 28, 55, 6, 1);
    pixel(ctx, outline, 10, 59, 8, 3);
    pixel(ctx, outline, 32, 59, 8, 3);

    pixel(ctx, outline, 9, 11, 32, 36);
    pixel(ctx, "#775c73", 11, 13, 27, 32);
    pixel(ctx, "#a8838d", 12, 14, 22, 3);
    pixel(ctx, "#d9b49f", 12, 18, 2, 23);
    pixel(ctx, "#4c465d", 15, 18, 20, 23);
    pixel(ctx, "#356a74", 17, 20, 16, 17);
    pixel(ctx, "#579e96", 18, 21, 13, 11);
    pixel(ctx, "#9bd4ae", 19, 22, 9, 6);
    pixel(ctx, "#e8e6af", 21, 24, 4, 4);
    pixel(ctx, "#fff1ba", 22, 24, 2, 2);
    pixel(ctx, "#377778", 20, 30, 10, 2);
    pixel(ctx, "#f7d9a5", 19, 39, 3, 2);
    pixel(ctx, "#8dd2aa", 24, 39, 3, 2);
    pixel(ctx, "#f7d9a5", 29, 39, 3, 2);

    pixel(ctx, outline, 7, 8, 36, 5);
    pixel(ctx, "#9c7882", 9, 8, 32, 3);
    pixel(ctx, "#f2c9a5", 11, 8, 24, 1);
    pixel(ctx, "#533f53", 6, 42, 36, 5);
    pixel(ctx, "#d4a48e", 9, 42, 27, 2);
    pixel(ctx, "#f8e3b9", 10, 43, 15, 1);
    speckle(ctx, "#fce6bd", [[12, 15], [36, 15], [12, 48], [39, 48]]);
  });
}

export function contextConsoleArt(): THREE.CanvasTexture {
  return texture(64, 63, (ctx) => {
    pixel(ctx, outline, 13, 8, 41, 36);
    pixel(ctx, "#706493", 16, 6, 34, 35);
    pixel(ctx, "#ad9cc6", 18, 7, 26, 30);
    pixel(ctx, "#eddaee", 20, 9, 23, 25);
    pixel(ctx, "#34485c", 22, 13, 20, 19);
    pixel(ctx, "#517883", 23, 14, 15, 3);
    pixel(ctx, "#a5f0cc", 25, 19, 13, 2);
    pixel(ctx, "#b9d5e2", 25, 24, 8, 2);
    pixel(ctx, "#f8e4aa", 25, 29, 12, 1);
    pixel(ctx, outline, 7, 39, 50, 17);
    pixel(ctx, "#866f9c", 9, 40, 46, 13);
    pixel(ctx, "#c6b3d0", 12, 40, 38, 8);
    pixel(ctx, "#f9ebd8", 14, 41, 31, 2);
    pixel(ctx, outline, 10, 51, 10, 11);
    pixel(ctx, "#706184", 12, 52, 7, 8);
    pixel(ctx, outline, 44, 51, 10, 11);
    pixel(ctx, "#706184", 46, 52, 6, 8);
    speckle(ctx, "#fff9e5", [[19, 11], [20, 11], [50, 43], [51, 43]]);
  });
}

export function stackArt(index: number): THREE.CanvasTexture {
  return texture(40, 52, (ctx) => {
    pixel(ctx, outline, 6, 36, 29, 11);
    pixel(ctx, "#ab829e", 9, 36, 23, 8);
    pixel(ctx, "#f7e7c7", 11, 36, 17, 2);
    pixel(ctx, outline, 9, 25, 25, 10);
    pixel(ctx, index % 2 ? "#91ceb0" : "#e3b695", 12, 26, 19, 5);
    pixel(ctx, "#fff0d1", 13, 26, 10, 1);
    pixel(ctx, outline, 4, 15, 25, 9);
    pixel(ctx, "#9d90bb", 7, 16, 19, 5);
    pixel(ctx, "#e6d5ef", 8, 16, 9, 1);
    pixel(ctx, outline, 14, 6, 22, 9);
    pixel(ctx, "#e5bd91", 17, 7, 16, 6);
    pixel(ctx, "#f9e8b7", 18, 7, 11, 1);
    pixel(ctx, outline, 12, 47, 22, 3);
    speckle(ctx, "#ebdcce", [[8, 19], [10, 20], [20, 29], [14, 40]]);
  });
}

export function posterArt(index: number): THREE.CanvasTexture {
  return texture(36, 44, (ctx) => {
    pixel(ctx, outline, 2, 3, 32, 38);
    pixel(ctx, "#ab8ea7", 4, 4, 28, 35);
    pixel(ctx, "#eedadd", 6, 6, 24, 32);
    pixel(ctx, index % 2 ? "#d99b97" : "#83b9ae", 8, 8, 20, 27);
    oval(ctx, "#fff2d4", index % 2 ? 20 : 16, 19, 5, 7);
    pixel(ctx, "#474964", 15, 22, 11, 3);
    pixel(ctx, "#f4ddac", 10, 29, 12, 2);
    speckle(ctx, "#fff9e5", [[8, 7], [9, 7], [27, 34]]);
  });
}

export function statusLightArt(): THREE.CanvasTexture {
  return texture(20, 26, (ctx) => {
    pixel(ctx, "#302d4a", 3, 4, 14, 19);
    pixel(ctx, "#726b92", 5, 5, 10, 14);
    pixel(ctx, "#a0f3d2", 6, 7, 8, 8);
    pixel(ctx, "#fff4d4", 8, 8, 3, 3);
    pixel(ctx, "#302d4a", 6, 22, 9, 3);
  });
}
