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
