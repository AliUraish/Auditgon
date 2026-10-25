export type Vec3 = [number, number, number];
export type CheckStatus = "pending" | "observing" | "pass" | "finding" | "blocked";
export type FindingStatus = "open" | "review" | "resolved" | "dismissed";
export type Severity = "critical" | "major" | "minor";
export type RunStatus = "ready" | "running" | "paused" | "complete" | "incomplete" | "error";
export type InspectionMode = "demo" | "managed";
export type ViewMode = "perspective" | "top" | "walk";
export interface MarkerContext { source: "scan" | "reference"; cameraPosition?: Vec3; cameraTarget?: Vec3 }

export interface Room {
  id: string; name: string; level: string; area: number;
  polygon: [number, number][]; center: Vec3; adjacentRoomIds: string[];
  floorElevation?: number; height?: number;
}
export interface BlueprintFeature {
  id: string; roomId: string; kind: "wall" | "door" | "window" | "island" | "stair" | "ceiling" | "furniture";
  label: string; position: Vec3; dimensions?: Vec3; expected?: number; unit?: string; source?: string;
  objectType?: "bed" | "sofa" | "table" | "chair" | "cabinet" | "sink" | "toilet" | "tub" | "wardrobe" | "lamp" | "plant" | "other";
  rotation?: number;
}
export interface BlueprintModel {
  id: string; name: string; revision: string; units: "m" | "scene"; isSample: boolean;
  rooms: Room[]; features: BlueprintFeature[]; sourceUploadId?: string;
  generatedFrom?: "materials" | "scan";
  coordinateFrame?: "reference" | "scan";
  metricStatus?: "unmeasured" | "design-dimensions";
}
export interface Evidence {
  id: string; label: string; kind: "measurement" | "image" | "drawing" | "script";
  imageUrl?: string; description: string; cameraPosition?: Vec3; cameraTarget?: Vec3;
}
export interface Finding {
  id: string; itemId: string; roomId: string; title: string; category: string;
  severity: Severity; status: FindingStatus; reason: string; expected: string; observed: string;
  uncertainty?: string; rule?: { label: string; url?: string; applicability: string };
  nextAction: string; anchor: Vec3; endAnchor?: Vec3; cameraPosition: Vec3; cameraTarget: Vec3;
  evidence: Evidence[]; isSample: boolean; createdAt: string; updatedAt: string;
  history: { at: string; status: FindingStatus; note: string }[]; note?: string;
  annotationSource?: "scan" | "reference";
}
export interface ChecklistItem {
  id: string; roomId: string; label: string; category: string; status: CheckStatus;
  expected?: string; observed?: string; findingId?: string; reason?: string; anchor: Vec3;
}
export interface InspectionEvent {
  id: string; at: string; kind: "plan" | "navigate" | "measure" | "finding" | "verify" | "code" | "system";
  title: string; detail: string; roomId?: string; itemId?: string;
  code?: string; output?: string; isSample: boolean;
}
export interface UploadRecord {
  id: string; kind: "blueprint" | "scan" | "reference"; filename: string; contentType: string;
  size: number; url: string; createdAt: string;
}
export interface InspectionSnapshot {
  id: string; name: string; address: string; mode: InspectionMode; status: RunStatus;
  createdAt: string; startedAt: string | null; updatedAt: string; elapsedSeconds: number;
  currentRoomId: string; currentItemId: string | null; blueprint: BlueprintModel;
  checklist: ChecklistItem[]; findings: Finding[]; events: InspectionEvent[]; uploads: UploadRecord[];
  path: Vec3[]; corrections: number; revision: number;
  verdict: "Pass" | "Pass with notes" | "Fail" | "Incomplete";
  scan: { sourceUrl: string; assetUrl: string | null; name: string; calibrated: boolean; scale: number; version: string;
    configured?: boolean; posterUrl?: string | null; initialCameraPosition?: Vec3; initialCameraTarget?: Vec3 };
  capabilities: { managedAgent: boolean; uploads: boolean; persistence: boolean; providerMessage: string };
  agent?: {
    interactionId?: string; status?: string; error?: string;
    pendingTool?: {
      id: string; name: "inspect_view" | "focus_location" | "sample_geometry";
      args: { position?: Vec3; target?: Vec3; label?: string; points?: [number, number][] }; requestedAt: string;
    };
  };
}
export interface SceneViewerProps {
  snapshot: InspectionSnapshot; selectedFindingId: string | null;
  onSelectFinding: (id: string) => void; selectedRoomId?: string | null;
  viewMode?: ViewMode; showMarkers?: boolean; showPath?: boolean;
  onAddMarker?: (anchor: Vec3, context?: MarkerContext) => void; className?: string; referenceOnly?: boolean;
}
export interface ApiError { error: string; code?: string }
export const RESOURCE_LIMITS = {
  maxUploadBytes: 32 * 1024 * 1024,
  maxBlueprintBytes: 10 * 1024 * 1024,
  maxSceneBytes: 64 * 1024 * 1024,
  maxSplats: 750_000,
  maxEvents: 160,
  maxPixelRatio: 1.25,
  maxImageEdge: 1280,
} as const;
