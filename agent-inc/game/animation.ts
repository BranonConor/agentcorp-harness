import type { Point } from "./simulation";

export function interpolatePosition(previous: Point | undefined, current: Point, alpha: number): Point {
  if (!previous) return current;
  const blend = Math.max(0, Math.min(1, alpha));
  return {
    x: previous.x + (current.x - previous.x) * blend,
    z: previous.z + (current.z - previous.z) * blend,
  };
}
