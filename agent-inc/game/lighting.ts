export const DAY_LENGTH_SECONDS = 240;

export type Daylight = {
  time: number;
  hour: number;
  label: string;
  sun: number;
  moon: number;
  ambient: number;
  lamp: number;
  warmth: number;
  sunColor: number;
  skyColor: number;
  bounceColor: number;
  sunX: number;
  sunY: number;
};

type Keyframe = { time: number; sun: number; ambient: number; lamp: number; warmth: number; sunColor: number; skyColor: number; bounceColor: number };

const keys: Keyframe[] = [
  { time: 0, sun: 0, ambient: 0.54, lamp: 1.5, warmth: 0.35, sunColor: 0x9ba5d4, skyColor: 0x423053, bounceColor: 0xa0788d },
  { time: 0.19, sun: 0.08, ambient: 0.82, lamp: 1.2, warmth: 0.7, sunColor: 0xff8665, skyColor: 0xdc7895, bounceColor: 0xe5a18b },
  { time: 0.32, sun: 2.75, ambient: 1.08, lamp: 0.55, warmth: 0.95, sunColor: 0xffae68, skyColor: 0x83d2cb, bounceColor: 0xe6b891 },
  { time: 0.5, sun: 3.25, ambient: 1.18, lamp: 0.32, warmth: 0.76, sunColor: 0xffd08a, skyColor: 0x89d9d0, bounceColor: 0xebc5a0 },
  { time: 0.67, sun: 2.65, ambient: 1.02, lamp: 0.72, warmth: 1, sunColor: 0xff9366, skyColor: 0xe19ba2, bounceColor: 0xedaa8e },
  { time: 0.79, sun: 0.09, ambient: 0.8, lamp: 1.4, warmth: 0.8, sunColor: 0xf47b83, skyColor: 0x664167, bounceColor: 0xa47888 },
  { time: 1, sun: 0, ambient: 0.54, lamp: 1.5, warmth: 0.35, sunColor: 0x9ba5d4, skyColor: 0x423053, bounceColor: 0xa0788d },
];

function blendColor(a: number, b: number, mix: number): number {
  const channel = (shift: number) => Math.round((((a >> shift) & 255) * (1 - mix)) + (((b >> shift) & 255) * mix));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

export function sampleDaylight(simulationSeconds: number, previewOffset = 0): Daylight {
  const time = (((simulationSeconds / DAY_LENGTH_SECONDS + 0.35 + previewOffset) % 1) + 1) % 1;
  const index = Math.max(0, keys.findIndex((key) => key.time >= time));
  const end = keys[Math.max(index, 1)];
  const start = keys[Math.max(index - 1, 0)];
  const part = (time - start.time) / (end.time - start.time || 1);
  const smooth = part * part * (3 - 2 * part);
  const lerp = (key: "sun" | "ambient" | "lamp" | "warmth") => start[key] + (end[key] - start[key]) * smooth;
  const minutes = Math.floor(time * 1440 + 1e-7);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const night = Math.max(
    Math.min(1, Math.max(0, (0.19 - time) / 0.12)),
    Math.min(1, Math.max(0, (time - 0.79) / 0.12)),
  );
  return {
    time, hour,
    label: `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`,
    sun: lerp("sun"), moon: night * 0.45, ambient: lerp("ambient"), lamp: lerp("lamp"), warmth: lerp("warmth"),
    sunColor: blendColor(start.sunColor, end.sunColor, smooth),
    skyColor: blendColor(start.skyColor, end.skyColor, smooth),
    bounceColor: blendColor(start.bounceColor, end.bounceColor, smooth),
    sunX: Math.cos((time - 0.47) * Math.PI * 2) * 6,
    sunY: 4.2 + Math.max(0, Math.sin((time - 0.19) / 0.6 * Math.PI)) * 5.2,
  };
}
