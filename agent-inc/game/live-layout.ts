import type { Point } from "./simulation";

export const LIVE_ROOM = { halfWidth: 9.4, back: -6.4, front: 7.2, windowY: 1.72 };
export const LIVE_COFFEE_Z = -4.75;
export const LIVE_COFFEE_COUNTER = { width: 3.12, height: 1.82, y: 0.92 };
export const LIVE_DIVIDER_X = 3.45;
export const LIVE_DIVIDER_START_Z = 0.25;
export const LIVE_DIVIDER_END_Z = 5.15;
export const LIVE_AISLE_Z = -1.05;
export const LIVE_DIVIDER_PLANTS = [
  { x: -3, z: 5.55, size: 1.1 }, { x: 3, z: 5.55, size: 1.1 },
] as const;

export const EXTRA_DESKS: readonly Point[] = [
  { x: -4.7, z: -0.35 }, { x: 4.7, z: -0.35 },
  { x: -6.8, z: -0.35 }, { x: 6.8, z: -0.35 },
  { x: -4.7, z: 1.65 }, { x: 4.7, z: 1.65 },
  { x: -6.8, z: 1.65 }, { x: 6.8, z: 1.65 },
  { x: -4.7, z: 3.65 }, { x: 4.7, z: 3.65 },
  { x: -6.8, z: 3.65 }, { x: 6.8, z: 3.65 },
];

export const MIN_LIVE_DESKS = 4;
export const MIN_VISIBLE_LIVE_DESKS = MIN_LIVE_DESKS + 4;
export const MAX_LIVE_DESKS = MIN_LIVE_DESKS + EXTRA_DESKS.length;
export const LIVE_RUG_X = 6.1;
export const LIVE_LOUNGE_Z = 5.65;
export const LIVE_LOUNGE_SOFA_X = LIVE_RUG_X;
export const LIVE_LOUNGE_SEATS_PER_WING = 3;
const loungePositions: readonly Point[] = [
  { x: LIVE_LOUNGE_SOFA_X + 0.92, z: LIVE_LOUNGE_Z },
  { x: LIVE_LOUNGE_SOFA_X, z: LIVE_LOUNGE_Z },
  { x: LIVE_LOUNGE_SOFA_X - 0.92, z: LIVE_LOUNGE_Z },
  { x: 8.8, z: 5.95 },
  { x: 4.18, z: 6.2 },
  { x: 8.7, z: 4.1 },
];
export const LOUNGE_SPOTS: readonly Point[] = loungePositions.flatMap(({ x, z }) =>
  [{ x: -x, z }, { x, z }]);

export function assignLoungeSpots(idle: readonly boolean[]): (Point | null)[] {
  const occupied = [0, 0];
  return idle.map((isIdle, index) => {
    if (!isIdle) return null;
    const side = index % 2;
    const spot = LOUNGE_SPOTS[occupied[side]++ * 2 + side];
    if (!spot) throw new RangeError(`No lounge spot for wing worker ${index}`);
    return spot;
  });
}

export function isLoungeSeat(point: Point): boolean {
  return LOUNGE_SPOTS.some((seat, index) =>
    index < LIVE_LOUNGE_SEATS_PER_WING * 2 && seat.x === point.x && seat.z === point.z);
}

const DESK_PROPS = ["plant", "mug", "lamp", "books", "notes", "headphones"] as const;
export type DeskProp = typeof DESK_PROPS[number];

export function deskPropsFor(index: number): readonly [DeskProp, DeskProp] {
  const seed = (Math.imul(index + 19, 0x9e3779b1) ^ Math.imul(index + 7, 0x85ebca6b)) >>> 0;
  const first = seed % DESK_PROPS.length;
  const second = (first + 1 + ((seed >>> 8) % (DESK_PROPS.length - 1))) % DESK_PROPS.length;
  return [DESK_PROPS[first], DESK_PROPS[second]];
}

export function liveDeskCount(workers: number): number {
  return Math.max(MIN_VISIBLE_LIVE_DESKS, Math.min(MAX_LIVE_DESKS, workers));
}

// Cross between desk sections through the open aisle, not through a divider.
export function routeAroundDividers(from: Point, to: Point): Point[] {
  const section = (x: number) => x < -LIVE_DIVIDER_X ? -1 : x > LIVE_DIVIDER_X ? 1 : 0;
  if (section(from.x) === section(to.x)) return [];
  return [
    { x: from.x, z: LIVE_AISLE_Z },
    { x: to.x, z: LIVE_AISLE_Z },
  ];
}
