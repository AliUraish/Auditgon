import type { Vec3 } from "./contracts";

export interface ViewerController {
  capture: () => Promise<{ data: string; width: number; height: number; mimeType: "image/jpeg" }>;
  focus: (position: Vec3, target: Vec3) => Promise<void>;
  describe: () => { loaded: boolean; calibrated: boolean; source: string; note: string; cameraPosition?: Vec3; cameraTarget?: Vec3 };
  sample: (pixels: [number, number][]) => Promise<GeometrySample>;
}
export interface GeometrySample {
  points: { pixel: [number, number]; position: Vec3 | null }[];
  calibrated: boolean; scale: number; units: "scene"; source: "rendered-depth"; note: string;
}
let activeController: ViewerController | null = null;
export function registerViewer(controller: ViewerController) {
  activeController = controller;
  return () => { if (activeController === controller) activeController = null; };
}
export function getViewerController() { return activeController; }

export interface RelativeMove { turn?: number; tilt?: number; forward?: number; strafe?: number; rise?: number }
/** Walk relative to the current pose: turn/tilt in degrees, steps in scene units; forward and strafe stay horizontal. */
export function relativeMove(position: Vec3, target: Vec3, move: RelativeMove): { position: Vec3; target: Vec3 } {
  const dx = target[0] - position[0], dy = target[1] - position[1], dz = target[2] - position[2];
  const length = Math.hypot(dx, dy, dz) || 1;
  const yaw = Math.atan2(dx / length, dz / length) - (move.turn || 0) * Math.PI / 180;
  const pitch = Math.max(-1.48, Math.min(1.48, Math.asin(Math.max(-1, Math.min(1, dy / length))) + (move.tilt || 0) * Math.PI / 180));
  const forward: Vec3 = [Math.sin(yaw), 0, Math.cos(yaw)];
  const right: Vec3 = [-Math.cos(yaw), 0, Math.sin(yaw)];
  const step = move.forward || 0, side = move.strafe || 0, rise = move.rise || 0;
  const next: Vec3 = [position[0] + forward[0] * step + right[0] * side, position[1] + rise, position[2] + forward[2] * step + right[2] * side];
  const look: Vec3 = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  return { position: next, target: [next[0] + look[0] * 3, next[1] + look[1] * 3, next[2] + look[2] * 3] };
}
