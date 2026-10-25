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
  floorElevation?: number; height?: number; designRoomId?: string;
  floorFinish?: Finish; wallFinish?: Finish; floorColor?: string; wallColor?: string;
}
export type Finish = "wood" | "tile" | "carpet" | "concrete" | "stone" | "paint" | "plaster" | "brick" | "glass" | "other";
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
  region?: Vec3[]; imageRegions?: { evidenceId: string; box: [number, number, number, number]; label?: string }[];
  measurement?: { value: number; units: "scene" | "m"; method: string; uncertainty: string };
}
export interface ChecklistItem {
  id: string; roomId: string; label: string; category: string; status: CheckStatus;
  expected?: string; observed?: string; findingId?: string; reason?: string; anchor: Vec3; designRoomId?: string;
  previousStatus?: CheckStatus; changed?: { from: CheckStatus; to: CheckStatus; run: number };
}
export interface InspectionEvent {
  id: string; at: string; kind: "plan" | "navigate" | "measure" | "finding" | "verify" | "code" | "system";
  title: string; detail: string; roomId?: string; itemId?: string; agentId?: string;
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
  path: Vec3[]; trail?: Vec3[]; corrections: number; revision: number;
  agents?: { id: string; role: "finish-surveyor" | "sketch-verifier" | "measurer" | "room-inspector"; objective: string; roomId?: string | null; evidenceIds: string[]; status: "running" | "done" | "failed" | "cancelled"; startedAt: string; endedAt?: string; turns: number; summary?: string | null; error?: string }[];
  run?: number; runHistory?: { number: number; endedAt: string; verdict: string; checks: number; findings: number; rooms: number }[];
  verdict: "Pass" | "Pass with notes" | "Fail" | "Incomplete";
  scan: { sourceUrl: string; assetUrl: string | null; name: string; calibrated: boolean; scale: number; version: string;
    configured?: boolean; posterUrl?: string | null; initialCameraPosition?: Vec3; initialCameraTarget?: Vec3 };
  capabilities: { managedAgent: boolean; uploads: boolean; persistence: boolean; providerMessage: string };
  agent?: {
    interactionId?: string; status?: string; error?: string;
    pendingTool?: {
      id: string; name: "inspect_view" | "focus_location" | "move_camera" | "sample_geometry";
      args: { position?: Vec3; target?: Vec3; label?: string; points?: [number, number][]; turn?: number; tilt?: number; forward?: number; strafe?: number; rise?: number }; requestedAt: string;
    };
  };
}
export type ViewOwner = "ai" | "human";
export interface LiveStatus { running: boolean; action: string; detail: string; captureUrl?: string; captureLabel?: string; agentName?: string }
export interface SceneViewerProps {
  snapshot: InspectionSnapshot; selectedFindingId: string | null;
  viewOwner?: ViewOwner; onViewOwnerChange?: (owner: ViewOwner) => void; live?: LiveStatus;
  servesAgent?: boolean; splatBudget?: number; title?: string;
  onSelectFinding: (id: string) => void; selectedRoomId?: string | null;
  viewMode?: ViewMode; showMarkers?: boolean; showPath?: boolean;
  onAddMarker?: (anchor: Vec3, context?: MarkerContext) => void; className?: string; referenceOnly?: boolean;
}
export interface ApiError { error: string; code?: string }
export interface RunDiff {
  available: boolean; reason?: string; baselineRun?: number; currentRun?: number; baselineEndedAt?: string; baselineVerdict?: string; currentVerdict?: string;
  summary?: { checksChanged: number; checksAdded: number; checksRemoved: number; findingsAdded: number; findingsRemoved: number; findingsChanged: number; roomsAdded: number; roomsRemoved: number; stillPending: number };
  checks?: { id: string; label: string; room: string; kind: "changed" | "added" | "removed" | "note"; before: CheckStatus | null; after: CheckStatus | null; observedBefore?: string; observedAfter?: string; findingId?: string }[];
  findings?: { id: string; title: string; room: string; severity: Severity; kind: "changed" | "added" | "removed"; before: FindingStatus | null; after: FindingStatus | null }[];
  rooms?: { id: string; name: string; kind: "added" | "removed" }[];
}
export const RESOURCE_LIMITS = {
  maxUploadBytes: 32 * 1024 * 1024,
  maxBlueprintBytes: 10 * 1024 * 1024,
  maxSceneBytes: 64 * 1024 * 1024,
  maxSplats: 750_000,
  maxEvents: 160,
  maxPixelRatio: 1.25,
  maxImageEdge: 1024,
} as const;
