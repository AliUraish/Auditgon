"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, ExternalLink, Focus, Layers3, LoaderCircle, Maximize2, MousePointer2, Power, RotateCcw, ScanLine, ShieldCheck } from "lucide-react";
import type { SceneViewerProps, Vec3, Finding, InspectionSnapshot } from "@/lib/contracts";
import type { CameraComponent, Picker as DepthPicker } from "playcanvas";
import { RESOURCE_LIMITS } from "@/lib/contracts";
import { getViewerController, registerViewer } from "@/lib/viewer-bridge";
import BlueprintScene from "./BlueprintScene";
import "./scene-viewer.css";

type ViewerHandle = Awaited<ReturnType<typeof import("@playcanvas/supersplat-viewer/viewer").createViewer>>;
type NativeScenePicker = { pick: (x: number, y: number) => Promise<{ x: number; y: number; z: number } | null> };
type Mode = "source" | "reference";
async function checkAssetBudget(snapshot: InspectionSnapshot, signal: AbortSignal) {
  const asset = snapshot.scan.assetUrl;
  if (!asset) throw new Error("Add a scan link in Scan & materials first.");
  const url = new URL(asset, window.location.origin);
  // Progressive LOD metadata keeps large published scenes on their source CDN.
  if (/\/lod-meta\.json$/i.test(url.pathname)) return;
  const owned = snapshot.uploads.find(upload => upload.url === asset && upload.kind === "scan");
  if (owned && owned.size <= RESOURCE_LIMITS.maxUploadBytes) return;
  const response = await fetch(url, { method: "HEAD", signal, cache: "no-store" });
  const length = Number(response.headers.get("content-length"));
  if (!response.ok || !Number.isSafeInteger(length) || length <= 0) throw new Error("This scan's size could not be verified. Use a published SuperSplat link or a progressive lod-meta.json URL to keep memory bounded.");
  if (length > RESOURCE_LIMITS.maxSceneBytes) throw new Error("This full scan exceeds the 64 MB viewer limit. Publish it as a progressive SuperSplat scene and paste its link instead.");
}
function cameraPose(viewer: ViewerHandle) {
  const camera = viewer.app.root.findComponents("camera").find(c => c.enabled) as CameraComponent | undefined;
  if (!camera) return {};
  const position = camera.entity.getPosition(), forward = camera.entity.forward;
  return { cameraPosition: [position.x,position.y,position.z] as Vec3, cameraTarget: [position.x+forward.x*3,position.y+forward.y*3,position.z+forward.z*3] as Vec3 };
}

function settingsFor(_annotations: Finding[], position?: Vec3, target?: Vec3) {
  return {
    version: 2 as const, tonemapping: "linear" as const, highPrecisionRendering: false,
    background: { color: [0.045, 0.06, 0.06] as Vec3 },
    postEffectSettings: {
      sharpness: { enabled: false, amount: 0 }, bloom: { enabled: false, intensity: 0, blurLevel: 0 },
      grading: { enabled: false, brightness: 1, contrast: 1, saturation: 1, tint: [1, 1, 1] as Vec3 },
      vignette: { enabled: false, intensity: 0, inner: 0, outer: 1, curvature: 1 },
      fringing: { enabled: false, intensity: 0 }
    }, animTracks: [], cameras: position && target ? [{ initial: { position, target, fov: 75 } }] : [],
    annotations: [] as { position: Vec3; title: string; text: string; extras?: unknown; camera: { initial: { position: Vec3; target: Vec3; fov: number } } }[],
    startMode: "default" as const
  };
}

export default function SceneViewer({ snapshot, selectedFindingId, onSelectFinding, selectedRoomId, viewMode = "perspective", showMarkers = true, showPath = true, onAddMarker, className = "", referenceOnly = false, viewOwner = "human", onViewOwnerChange, live, servesAgent = true, splatBudget = RESOURCE_LIMITS.maxSplats, title, followSelection = true }: SceneViewerProps) {
  const configured = snapshot.scan.configured ?? Boolean(snapshot.scan.assetUrl);
  const [mode, setMode] = useState<Mode>(referenceOnly ? "reference" : "source");
  const [loadRequested, setLoadRequested] = useState(Boolean(configured && snapshot.scan.assetUrl && !referenceOnly));
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rotation, setRotation] = useState(-0.62);
  const [zoom, setZoom] = useState(1);
  const [pausedForMemory, setPausedForMemory] = useState(false);
  const [markingPoint, setMarkingPoint] = useState(false);
  const [pickingPoint, setPickingPoint] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const pinRefs = useRef(new Map<string, HTMLButtonElement>());
  const viewerRef = useRef<ViewerHandle | null>(null);
  const generation = useRef(0);
  const userSelected = useRef<string | null>(null);
  const selected = snapshot.findings.find(f => f.id === selectedFindingId);
  const scanFrameFindings = snapshot.blueprint.coordinateFrame === "scan";
  const realAnnotations = useMemo(() => snapshot.findings.filter(f => !f.isSample && f.status !== "dismissed" && (f.annotationSource === "scan" || snapshot.scan.calibrated || scanFrameFindings)), [snapshot.findings, snapshot.scan.calibrated, scanFrameFindings]);
  const initialCamera = useRef<{ position: Vec3; target: Vec3 } | null>(snapshot.scan.initialCameraPosition && snapshot.scan.initialCameraTarget ? { position: snapshot.scan.initialCameraPosition, target: snapshot.scan.initialCameraTarget } : null);
  const focusWaiter = useRef<{ resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [cameraRevision, setCameraRevision] = useState(0);
  const isReference = referenceOnly || mode === "reference";
  const runningRef = useRef(snapshot.status === "running");
  useEffect(() => { runningRef.current = snapshot.status === "running"; }, [snapshot.status]);
  // A pending Argon tool reloads an unloaded scan automatically so the run never waits on a click.
  useEffect(() => {
    if (servesAgent && snapshot.agent?.pendingTool && snapshot.status === "running" && configured && snapshot.scan.assetUrl && !referenceOnly && !loadRequested && !document.hidden) { setError(null); setPausedForMemory(false); setMode("source"); setLoadRequested(true); }
  }, [snapshot.agent?.pendingTool?.id, snapshot.status, configured, snapshot.scan.assetUrl, referenceOnly, loadRequested]);

  const unload = useCallback(() => {
    generation.current++;
    const viewer = viewerRef.current;
    viewerRef.current = null;
    viewer?.destroy();
    setLoaded(false); setProgress(0); setLoadRequested(false);
  }, []);
  const sceneVersion = useRef(snapshot.scan.version);
  useEffect(() => {
    if (sceneVersion.current === snapshot.scan.version) return;
    sceneVersion.current = snapshot.scan.version;
    unload();
    initialCamera.current = snapshot.scan.initialCameraPosition && snapshot.scan.initialCameraTarget ? { position: snapshot.scan.initialCameraPosition, target: snapshot.scan.initialCameraTarget } : null;
    setMarkingPoint(false); setPausedForMemory(false); setError(null);
    if (configured && snapshot.scan.assetUrl && !referenceOnly) { setMode("source"); setLoadRequested(true); }
  }, [snapshot.scan.version, snapshot.scan.assetUrl, snapshot.scan.initialCameraPosition, snapshot.scan.initialCameraTarget, configured, referenceOnly, unload]);
  useEffect(() => { if (viewMode === "top") { unload(); setMode("reference"); } }, [viewMode, unload]);

  useEffect(() => {
    if (!followSelection) { userSelected.current = null; return; }
    if (selectedFindingId && userSelected.current !== selectedFindingId) {
      userSelected.current = selectedFindingId;
      if (selected?.isSample || (!snapshot.scan.calibrated && selected?.annotationSource !== "scan" && !scanFrameFindings)) { unload(); setMode("reference"); }
      else if (!referenceOnly) {
        setMode("source");
        if (configured && snapshot.scan.assetUrl) setLoadRequested(true);
        const target = realAnnotations.find(f => f.id === selectedFindingId);
        if (viewerRef.current?.state.loaded && target) {
          const viewer = viewerRef.current;
          const pose = { position: target.cameraTarget, title: "Argon camera", text: "", camera: { initial: { position: target.cameraPosition, target: target.cameraTarget, fov: 65 } } };
          const list = viewer.annotations as unknown as (typeof pose)[];
          if (list.length) list[list.length - 1] = pose; else list.push(pose);
          try { viewer.selectAnnotation(list.length - 1); } catch { /* the viewer may still be loading */ }
        }
      }
    }
  }, [selectedFindingId, selected?.isSample, selected?.annotationSource, snapshot.scan.calibrated, realAnnotations, unload, configured, snapshot.scan.assetUrl, referenceOnly, followSelection, scanFrameFindings]);

  useEffect(() => {
    const contentUrl = snapshot.scan.assetUrl;
    if (!loadRequested || isReference || !contentUrl || !canvasHost.current) return;
    let cancelled = false;
    const ownGeneration = ++generation.current;
    let ownViewer: ViewerHandle | null = null;
    let depthPicker: DepthPicker | null = null;
    let nativePicker: NativeScenePicker | null = null;
    let unregister: (() => void) | undefined;
    const budgetCheck = new AbortController();
    const budgetTimer = setTimeout(() => budgetCheck.abort(), 10_000);
    setError(null); setLoaded(false); setProgress(0);
    const start = async () => {
      try {
        await checkAssetBudget(snapshot, budgetCheck.signal);
        clearTimeout(budgetTimer);
        if (cancelled || ownGeneration !== generation.current) return;
        const { createViewer } = await import("@playcanvas/supersplat-viewer/viewer");
        await import("@playcanvas/supersplat-viewer/viewer.css");
        if (cancelled || ownGeneration !== generation.current || !canvasHost.current) return;
        const camera = initialCamera.current;
        const viewer = await createViewer({
          container: canvasHost.current,
          contentUrl,
          contentFilename: snapshot.uploads.find(upload => upload.kind === "scan" && upload.url === contentUrl)?.filename,
          settings: settingsFor(realAnnotations, camera?.position, camera?.target),
          posterUrl: snapshot.scan.posterUrl || undefined,
          noanim: true, nofx: true, budget: splatBudget / 1_000_000,
          ui: true, exposeGlobals: false,
        });
        ownViewer = viewer;
        if (cancelled || ownGeneration !== generation.current) { viewer.destroy(); return; }
        viewerRef.current = viewer;
        // The pinned official viewer exposes its depth picker when the streamed
        // scene is ready. Reuse that buffer instead of rendering another scene.
        viewer.events.on("picker:ready", (picker: NativeScenePicker) => { nativePicker = picker; });
        viewer.state.performanceMode = true;
        viewer.state.animationPaused = true;
        viewer.state.showAnnotations = showMarkers;
        viewer.app.graphicsDevice.maxPixelRatio = RESOURCE_LIMITS.maxPixelRatio;
        const sample = async (pixels: [number, number][]) => {
          if (!viewer.state.loaded) throw new Error("Wait for the scan to finish loading before sampling its depth.");
          if (!pixels.length || pixels.length > 64 || pixels.some(p => p.some(v => !Number.isFinite(v) || v < 0 || v > 1))) throw new Error("Choose 1–64 normalized image positions between 0 and 1.");
          if (nativePicker) {
            const samples: { pixel: [number,number]; position: Vec3 | null }[] = [];
            for (const pixel of pixels) {
              const point = await nativePicker.pick(pixel[0], pixel[1]);
              samples.push({ pixel, position: point ? [point.x,point.y,point.z] : null });
            }
            return { points:samples, calibrated:snapshot.scan.calibrated, scale:snapshot.scan.scale, units:"scene" as const, source:"rendered-depth" as const,
              note:"Approximate reconstructed surface depth from the official viewer. Reflective, translucent, occluded or poorly captured surfaces require independent verification. Metric conclusions require validated scale and uncertainty." };
          }
          const { Picker } = await import("playcanvas");
          const width = Math.min(960, viewer.app.graphicsDevice.width);
          const height = Math.max(1, Math.round(width * viewer.app.graphicsDevice.height / viewer.app.graphicsDevice.width));
          depthPicker ??= new Picker(viewer.app, width, height, true);
          depthPicker.resize(width, height);
          const camera = viewer.app.root.findComponents("camera").find(c => c.enabled) as CameraComponent | undefined;
          if (!camera) throw new Error("The scan camera is unavailable.");
          depthPicker.prepare(camera, viewer.app.scene);
          const samples: { pixel: [number,number]; position: Vec3 | null }[] = [];
          for (const pixel of pixels) {
            const point = await depthPicker.getWorldPointAsync(Math.min(width-1, pixel[0]*width), Math.min(height-1,pixel[1]*height));
            samples.push({ pixel, position: point ? [point.x,point.y,point.z] : null });
          }
          return { points:samples, calibrated:snapshot.scan.calibrated, scale:snapshot.scan.scale, units:"scene" as const, source:"rendered-depth" as const,
            note:"Approximate depth from the reconstructed splat at the current view. Glass, reflections, missing coverage and reconstruction artifacts can affect it. Not surveyed geometry; metric conclusions require validated calibration and uncertainty." };
        };
        viewer.events.on("progress:changed", (value: number) => { if (!cancelled) setProgress(Math.round(value)); });
        viewer.events.on("loaded:changed", () => {
          if (cancelled) return;
          setLoaded(viewer.state.loaded);
          if (viewer.state.loaded && focusWaiter.current) {
            clearTimeout(focusWaiter.current.timer); focusWaiter.current.resolve(); focusWaiter.current = null;
          }

        });
        if (servesAgent) unregister = registerViewer({
          capture: async () => {
            if (!viewer.state.loaded) throw new Error("Open the embedded scan and wait for its first frame.");
            const result = await viewer.captureFrame({ width: 1280, height: 720, supersample: 1 });
            // The viewer returns raw RGBA pixels as base64 (width × height × 4 bytes), not an encoded image.
            const raw = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
            if (raw.length < result.width * result.height * 4) throw new Error("The capture buffer was incomplete. Request another view.");
            const source = document.createElement("canvas");
            source.width = result.width; source.height = result.height;
            const sourceContext = source.getContext("2d");
            if (!sourceContext) throw new Error("Could not prepare a bounded inspection image.");
            sourceContext.putImageData(new ImageData(new Uint8ClampedArray(raw.buffer, raw.byteOffset, result.width * result.height * 4), result.width, result.height), 0, 0);
            const canvas = document.createElement("canvas");
            const factor = Math.min(1, RESOURCE_LIMITS.maxImageEdge / Math.max(result.width, result.height));
            canvas.width = Math.round(result.width * factor); canvas.height = Math.round(result.height * factor);
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Could not prepare a bounded inspection image.");
            context.fillStyle = "#000"; context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(source, 0, 0, canvas.width, canvas.height);
            source.width = 0; source.height = 0;
            const data = canvas.toDataURL("image/jpeg", 0.65).split(",")[1];
            const width = canvas.width, height = canvas.height; canvas.width = 0; canvas.height = 0;
            return { data, width, height, mimeType: "image/jpeg" };
          },
          focus: async (position, target) => {
            if (focusWaiter.current) throw new Error("A camera move is already in progress.");
            initialCamera.current = { position, target };
            if (viewer.state.loaded) {
              // Move the live camera through the viewer's own annotation transition instead of
              // reloading the scene: one reusable pose slot sits after the real finding annotations.
              const pose = { position, title: "Argon camera", text: "", camera: { initial: { position, target, fov: 65 } } };
              const list = viewer.annotations as unknown as (typeof pose)[]; // the handle types the list read-only; the viewer reads it on each selection
              if (list.length) list[list.length - 1] = pose; else list.push(pose);
              viewer.selectAnnotation(list.length - 1);
              await new Promise(resolve => setTimeout(resolve, 1400));
              return;
            }
            return new Promise<void>((resolve,reject) => {
              const timer = setTimeout(() => { focusWaiter.current = null; reject(new Error("The camera move did not finish loading in time.")); }, 30_000);
              focusWaiter.current = { resolve, reject, timer };
              setCameraRevision(v => v + 1);
            });
          },
          describe: () => ({ loaded: viewer.state.loaded, calibrated: snapshot.scan.calibrated, source: snapshot.scan.assetUrl || snapshot.scan.sourceUrl, note: "Embedded streamed capture. Visual evidence is not a surveyed measurement; calibration status is explicit.", ...cameraPose(viewer) }),
          sample
        });
        if (viewer.state.loaded) {
          setLoaded(true);
          if (focusWaiter.current) { clearTimeout(focusWaiter.current.timer); focusWaiter.current.resolve(); focusWaiter.current=null; }
        }
      } catch (e) {
        clearTimeout(budgetTimer);
        if (focusWaiter.current) { clearTimeout(focusWaiter.current.timer); focusWaiter.current.reject(e instanceof Error ? e : new Error("Camera load failed.")); focusWaiter.current = null; }
        if (!cancelled) { setError(e instanceof Error ? e.message : "The embedded viewer could not start."); setLoadRequested(false); }
      }
    };
    void start();
    return () => {
      cancelled = true; clearTimeout(budgetTimer); budgetCheck.abort(); unregister?.();
      depthPicker?.destroy();
      if (ownViewer) { if (viewerRef.current === ownViewer) viewerRef.current = null; ownViewer.destroy(); }
    };
    // A persisted metadata update must not recreate the GPU context on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadRequested, isReference, snapshot.scan.assetUrl, snapshot.scan.calibrated, snapshot.scan.scale, snapshot.scan.sourceUrl, cameraRevision]);

  useEffect(() => { if (viewerRef.current) viewerRef.current.state.showAnnotations = showMarkers; }, [showMarkers]);
  // AI view hands the camera to Argon: pointer and keyboard input is gated while it works.
  useEffect(() => { if (viewerRef.current?.state.loaded) viewerRef.current.state.inputEnabled = !(viewOwner === "ai" && live?.running); }, [viewOwner, loaded, live?.running]);
  // Draw Argon's lines, outlines, and walking trail over the live scan by projecting saved scene points each frame.
  const drawnFindings = snapshot.findings.filter(f => !f.isSample && f.status !== "dismissed" && (f.annotationSource === "scan" || scanFrameFindings) && (f.endAnchor || f.region));
  const scanFrameModel = snapshot.blueprint.coordinateFrame === "scan";
  const pinFindings = snapshot.findings.filter(f => !f.isSample && f.status !== "dismissed" && (f.annotationSource === "scan" || snapshot.scan.calibrated || scanFrameFindings));
  const drawKey = pinFindings.map(f => f.id + f.anchor.join(",")).join("|") + "#" + drawnFindings.map(f => `${f.id}:${f.endAnchor?.join(",")}:${f.region?.length}`).join("|") + "#" + (snapshot.trail?.length || 0) + "#" + (scanFrameModel ? snapshot.blueprint.features.map(f => f.id + f.position.join(",") + (f.dimensions || []).join(",")).join("|") + snapshot.blueprint.rooms.map(r => r.id + r.center.join(",")).join("|") : "");
  useEffect(() => {
    const viewer = viewerRef.current, canvas = overlayRef.current;
    if (!loaded || !viewer || !canvas || isReference) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const originalParent = canvas.parentElement;
    const sceneLayer = canvasHost.current?.querySelector(".sse-sceneLayer");
    if (sceneLayer && canvas.parentElement !== sceneLayer) sceneLayer.prepend(canvas);
    const trail = showPath ? (snapshot.trail || []).slice(-200) : [];
    const shapes = showMarkers ? drawnFindings : [];
    // Only elements whose position is a real depth sample are drawn on the scan; estimates stay on the blueprint.
    const elements = showMarkers && scanFrameModel ? snapshot.blueprint.features.filter(f => /^Sampled position/.test(f.source || "")).slice(0, 80) : [];
    const rooms = showMarkers && scanFrameModel ? snapshot.blueprint.rooms : [];
    let disposed = false, handler: (() => void) | null = null;
    void import("playcanvas").then(({ Vec3: PcVec3 }) => {
      if (disposed) return;
      const point = new PcVec3();
      const draw = () => {
        const host = canvasHost.current;
        if (!host || disposed) return;
        const width = host.clientWidth, height = host.clientHeight;
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        context.clearRect(0, 0, width, height);
        const camera = viewer.app.root.findComponents("camera").find(c => c.enabled) as CameraComponent | undefined;
        if (!camera) return;
        const factor = viewer.app.graphicsDevice.width / Math.max(1, width);
        const project = (p: Vec3): [number, number] | null => { const s = camera.worldToScreen(point.set(p[0], p[1], p[2])); return s.z > 0 ? [s.x / factor, s.y / factor] : null; };
        context.lineJoin = "round"; context.lineCap = "round";
        const hostRect = host.getBoundingClientRect();
        for (const [id, button] of pinRefs.current) {
          const finding = pinFindings.find(f => f.id === id);
          const s = finding ? project(finding.anchor) : null;
          if (!s || s[0] < -20 || s[0] > width + 20 || s[1] < -20 || s[1] > height + 20) { button.style.visibility = "hidden"; continue; }
          button.style.visibility = showMarkers ? "visible" : "hidden";
          button.style.transform = `translate(-50%,-50%) translate(${s[0]}px,${s[1]}px)`;
        }
        void hostRect;
        if (trail.length > 1) {
          context.setLineDash([4, 5]); context.strokeStyle = "rgba(255,255,255,0.55)"; context.lineWidth = 1.5; context.beginPath();
          let pen = false;
          for (const p of trail) { const s = project(p); if (!s) { pen = false; continue; } if (pen) context.lineTo(s[0], s[1]); else context.moveTo(s[0], s[1]); pen = true; }
          context.stroke(); context.setLineDash([]);
          const last = project(trail[trail.length - 1]);
          if (last) { context.fillStyle = "#fff"; context.beginPath(); context.arc(last[0], last[1], 4, 0, Math.PI * 2); context.fill(); }
        }
        // Elements Argon identified: tags with collision avoidance and leader lines, boxes only at a sane projected size.
        const placed: { x: number; y: number; w: number; h: number }[] = [];
        const project3 = (p: Vec3): [number, number, number] | null => { const s = camera.worldToScreen(point.set(p[0], p[1], p[2])); return s.z > 0 ? [s.x / factor, s.y / factor, s.z] : null; };
        type Tag = { x: number; y: number; depth: number; text: string; kind: "room" | "element" };
        const tags: Tag[] = [];
        for (const room of rooms) { const s = project3(room.center); if (s && s[0] > -40 && s[0] < width + 40 && s[1] > -20 && s[1] < height + 20) tags.push({ x: s[0], y: s[1], depth: s[2], text: room.name.toUpperCase(), kind: "room" }); }
        for (const element of elements) {
          const s = project3(element.position);
          if (!s || s[0] < -40 || s[0] > width + 40 || s[1] < -20 || s[1] > height + 20) continue;
          if (element.dimensions && (element.kind === "furniture" || element.kind === "island" || element.kind === "stair")) {
            const [w, h, d] = element.dimensions.map(v => v / 2), yaw = ((element.rotation || 0) * Math.PI) / 180, c = Math.cos(yaw), si = Math.sin(yaw);
            const corners: Vec3[] = ([[-w,-h,-d],[w,-h,-d],[w,h,-d],[-w,h,-d],[-w,-h,d],[w,-h,d],[w,h,d],[-w,h,d]] as Vec3[]).map(([x, y, z]) => [element.position[0] + x * c + z * si, element.position[1] + y, element.position[2] - x * si + z * c]);
            const pts = corners.map(project3);
            if (pts.every(Boolean)) {
              const xs = pts.map(q => q![0]), ys = pts.map(q => q![1]);
              const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
              if (bw > 6 && bh > 6 && bw < width * 0.4 && bh < height * 0.4) {
                context.strokeStyle = "rgba(255,255,255,0.5)"; context.lineWidth = 1; context.beginPath();
                for (const [a, b] of [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]) { const pa = pts[a]!, pb = pts[b]!; context.moveTo(pa[0], pa[1]); context.lineTo(pb[0], pb[1]); }
                context.stroke();
              }
            }
          }
          tags.push({ x: s[0], y: s[1], depth: s[2], text: `${element.kind === "furniture" ? (element.objectType || "item") : element.kind} · ${element.label}`.slice(0, 30), kind: "element" });
        }
        tags.sort((a, b) => a.depth - b.depth);
        const roomTags = tags.filter(tag => tag.kind === "room").slice(0, 3), elementTags = tags.filter(tag => tag.kind === "element").slice(0, 14);
        for (const tag of [...roomTags, ...elementTags]) {
          const near = Math.max(0, Math.min(1, 1 - tag.depth / 14));
          const size = tag.kind === "room" ? 10 : 8 + near * 2;
          context.font = `${tag.kind === "room" ? 700 : 600} ${size}px ${tag.kind === "room" ? "SFMono-Regular, Menlo, monospace" : "Helvetica, Arial, sans-serif"}`;
          const w = context.measureText(tag.text).width + 10, h = size + 6;
          let lx = tag.x + 9, ly = tag.y - h / 2, tries = 0;
          const hit = () => placed.some(r => lx < r.x + r.w + 4 && lx + w > r.x - 4 && ly < r.y + r.h + 3 && ly + h > r.y - 3);
          while (hit() && tries < 10) { ly += h + 3; tries++; }
          if (hit()) continue;
          if (lx + w > width - 4) lx = Math.max(4, tag.x - w - 9);
          placed.push({ x: lx, y: ly, w, h });
          const alpha = 0.55 + near * 0.45;
          context.fillStyle = "#fff"; context.strokeStyle = "rgba(0,0,0,0.8)"; context.lineWidth = 1.5; context.globalAlpha = alpha;
          context.beginPath(); context.moveTo(tag.x, tag.y - 4); context.lineTo(tag.x + 4, tag.y); context.lineTo(tag.x, tag.y + 4); context.lineTo(tag.x - 4, tag.y); context.closePath(); context.fill(); context.stroke();
          if (tries > 0) { context.strokeStyle = "rgba(255,255,255,0.6)"; context.lineWidth = 1; context.beginPath(); context.moveTo(tag.x, tag.y); context.lineTo(lx, ly + h / 2); context.stroke(); }
          context.fillStyle = tag.kind === "room" ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.62)"; context.fillRect(lx, ly, w, h);
          context.fillStyle = "#fff"; context.textAlign = "left"; context.fillText(tag.text, lx + 5, ly + h - 5);
          context.globalAlpha = 1;
        }
        const focus = pinFindings.find(f => f.id === selectedFindingId);
        if (focus) {
          const s = project(focus.anchor);
          if (s) {
            const pulse = (Math.sin(Date.now() / 260) + 1) / 2;
            context.strokeStyle = "rgba(0,0,0,0.75)"; context.lineWidth = 6; context.beginPath(); context.arc(s[0], s[1], 16 + pulse * 10, 0, Math.PI * 2); context.stroke();
            context.strokeStyle = "#ffffff"; context.lineWidth = 2.5; context.beginPath(); context.arc(s[0], s[1], 16 + pulse * 10, 0, Math.PI * 2); context.stroke();
            context.strokeStyle = "rgba(255,255,255,0.85)"; context.lineWidth = 1.5; context.beginPath();
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { context.moveTo(s[0] + dx * 22, s[1] + dy * 22); context.lineTo(s[0] + dx * 40, s[1] + dy * 40); }
            context.stroke();
            if (focus.region) { const pts = focus.region.map(project); if (pts.every(Boolean)) { context.fillStyle = "rgba(255,255,255,0.22)"; context.beginPath(); pts.forEach((q, i) => i ? context.lineTo(q![0], q![1]) : context.moveTo(q![0], q![1])); context.closePath(); context.fill(); } }
            viewer.app.renderNextFrame = true; // keep the pulse animating while a finding is selected
          }
        }
        for (const f of shapes) {
          const halo = (fn: () => void) => { context.strokeStyle = "rgba(0,0,0,0.7)"; context.lineWidth = 5; fn(); context.strokeStyle = "#fff"; context.lineWidth = 2; fn(); };
          if (f.region) {
            const pts = f.region.map(project);
            if (pts.every(Boolean)) {
              const path = () => { context.beginPath(); pts.forEach((s, i) => i ? context.lineTo(s![0], s![1]) : context.moveTo(s![0], s![1])); context.closePath(); context.stroke(); };
              halo(path); context.fillStyle = "rgba(255,255,255,0.14)"; context.fill();
            }
          }
          if (f.endAnchor) {
            const a = project(f.anchor), b = project(f.endAnchor);
            if (a && b) {
              halo(() => { context.beginPath(); context.moveTo(a[0], a[1]); context.lineTo(b[0], b[1]); context.stroke(); });
              [a, b].forEach(s => { context.fillStyle = "#fff"; context.beginPath(); context.arc(s[0], s[1], 3.5, 0, Math.PI * 2); context.fill(); });
              context.font = "600 10px Helvetica, Arial, sans-serif"; context.fillStyle = "#fff"; context.strokeStyle = "rgba(0,0,0,0.8)"; context.lineWidth = 3;
              const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 8];
              const label = f.measurement ? `${f.id} · ≈ ${f.measurement.value} ${f.measurement.units === 'm' ? 'm' : 'scene units'}` : f.id;
              context.textAlign = "center"; context.strokeText(label, mid[0], mid[1]); context.fillText(label, mid[0], mid[1]);
            }
          }
        }
      };
      handler = draw;
      viewer.app.on("frameend", draw);
      draw();
    });
    return () => { disposed = true; if (handler) viewer.app.off("frameend", handler); context.clearRect(0, 0, canvas.width, canvas.height); if (originalParent && canvas.parentElement !== originalParent && originalParent.isConnected) originalParent.appendChild(canvas); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, isReference, drawKey, showMarkers, showPath, pinFindings.length, selectedFindingId]);
  useEffect(() => () => { if (focusWaiter.current) { clearTimeout(focusWaiter.current.timer); focusWaiter.current.reject(new Error("The viewer was closed during navigation.")); focusWaiter.current = null; } }, []);
  useEffect(() => {
    if (viewerRef.current?.state.loaded && viewMode === "walk") {
      viewerRef.current.state.cameraMode = viewerRef.current.state.walkAllowed ? "walk" : "fly";
    }
  }, [viewMode, loaded]);
  useEffect(() => {
    let offscreenTimer: ReturnType<typeof setTimeout> | null = null;
    const pause = () => {
      // While Argon is auditing, the viewer must stay resident so camera, capture, and depth tools keep working.
      if (document.hidden && viewerRef.current && !runningRef.current) { unload(); setPausedForMemory(true); }
    };
    document.addEventListener("visibilitychange", pause);
    const observer = new IntersectionObserver(entries => {
      if (offscreenTimer) { clearTimeout(offscreenTimer); offscreenTimer = null; }
      if (!entries[0]?.isIntersecting) offscreenTimer = setTimeout(() => { if (viewerRef.current && !runningRef.current) { unload(); setPausedForMemory(true); } }, 15_000);
    }, { threshold: 0.01 });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => { document.removeEventListener("visibilitychange", pause); observer.disconnect(); if (offscreenTimer) clearTimeout(offscreenTimer); };
  }, [unload]);

  const fullscreen = async () => { try { await containerRef.current?.requestFullscreen(); } catch { setError("Fullscreen is unavailable in this browser. You can open the source scene in a new tab."); } };
  const pickMarker = async (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onAddMarker || pickingPoint) return;
    const rect = canvasHost.current?.getBoundingClientRect() || event.currentTarget.getBoundingClientRect();
    const pixel:[number,number]=[(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height];
    setPickingPoint(true);
    try {
      const result = await getViewerController()?.sample([pixel]);
      const position = result?.points[0]?.position;
      if (!position) throw new Error("No reconstructed surface was found here. Choose a clearly visible solid surface.");
      setMarkingPoint(false); onAddMarker(position, { source: "scan", ...(viewerRef.current ? cameraPose(viewerRef.current) : {}) });
    } catch(e) { setError(e instanceof Error?e.message:"Could not place a spatial marker."); }
    finally { setPickingPoint(false); }
  };
  return (
    <div className={`scene-viewer argon-scene ${className}`} ref={containerRef}>
      <div className="as-mode-switch" aria-label="Scene representation">
        {!referenceOnly && <button type="button" className={!isReference ? "active" : ""} onClick={() => setMode("source")}><ScanLine size={13} /> Source scan</button>}
        <button type="button" className={isReference ? "active" : ""} onClick={() => { unload(); setMode("reference"); }}><Layers3 size={13} /> 3D blueprint</button>
      </div>
      {isReference ? <>
        <BlueprintScene snapshot={snapshot} selectedFindingId={selectedFindingId} onSelectFinding={onSelectFinding} selectedRoomId={selectedRoomId} viewMode={viewMode} showMarkers={showMarkers} showPath={showPath} zoom={zoom} rotation={rotation}/>
        <div className="as-reference-notice"><Box size={12}/>{snapshot.blueprint.rooms.length ? snapshot.blueprint.generatedFrom === "scan" ? "Scan-derived draft · approximate room geometry" : snapshot.blueprint.metricStatus === "unmeasured" || snapshot.blueprint.units === "scene" ? "Generated draft · dimensions unverified" : "Blueprint draft · review against source materials" : "Awaiting spatial model"}</div>
        <div className="as-reference-controls"><button type="button" aria-label="Zoom out 3D blueprint" onClick={()=>setZoom(v=>Math.max(0.5,v-0.15))}>−</button><span>{Math.round(zoom*100)}%</span><button type="button" aria-label="Zoom in 3D blueprint" onClick={()=>setZoom(v=>Math.min(3,v+0.15))}>+</button><button type="button" aria-label="Rotate 3D blueprint" onClick={()=>setRotation(v=>v+0.4)}><RotateCcw size={13}/></button></div>
        {onAddMarker && snapshot.blueprint.rooms.length > 0 && <button type="button" className="as-add-marker" onClick={()=>{const room=snapshot.blueprint.rooms.find(r=>r.id===selectedRoomId)||snapshot.blueprint.rooms[0];if(room)onAddMarker(room.center,{source:snapshot.blueprint.coordinateFrame === "scan" ? "scan" : "reference"});}}><MousePointer2 size={12}/> Mark selected room</button>}
      </> : <>
        {!loadRequested && <div className="as-poster" style={{backgroundImage:snapshot.scan.posterUrl ? `linear-gradient(180deg,rgba(10,10,10,.1),rgba(10,10,10,.55)),url(${JSON.stringify(snapshot.scan.posterUrl)})` : "radial-gradient(ellipse at 40% 40%,#3a3a3a,#0f0f0f 70%)"}}>
          <div className="as-load-card"><div className="as-load-icon"><ScanLine size={24}/></div><h3>{configured ? "Your space. A closer look." : "Start with your 3D scan."}</h3><p>{pausedForMemory ? "The scan was unloaded while away to release GPU memory." : configured ? "Explore your scan and every finding in one place." : "Add a scan link in Scan & materials. Auditgon will open it here and build the room map as it audits."}</p>{configured && <button type="button" onClick={()=>{setError(null);setPausedForMemory(false);setLoadRequested(true);}}><ScanLine size={14}/> Open embedded scan</button>}<span><ShieldCheck size={11}/> Progressive streaming · 750k active splat budget</span></div>
        </div>}
        <div className="as-canvas" ref={canvasHost} style={{display:loadRequested?"block":"none"}} />
        <canvas ref={overlayRef} className="as-draw-overlay" aria-hidden="true" style={{display:loadRequested && loaded ? "block" : "none"}} />
        {loadRequested && loaded && <div className={`as-pin-layer ${selectedFindingId ? "has-selection" : ""}`}>{pinFindings.map((finding, index) => <button type="button" key={finding.id} className={`as-pin severity-${finding.severity} ${selectedFindingId === finding.id ? "selected" : ""}`} title={finding.title} aria-label={finding.title} ref={node => { if (node) pinRefs.current.set(finding.id, node); else pinRefs.current.delete(finding.id); }} onClick={() => onSelectFinding(finding.id)}>{index + 1}</button>)}</div>}
        {loadRequested && !loaded && <div className="as-loading"><LoaderCircle size={17} className="as-spin"/><span>Streaming the scan{progress>0?` · ${progress}%`:"…"}</span><button type="button" onClick={unload}>Cancel</button></div>}
        {loadRequested && <button type="button" className="as-unload" onClick={unload}><Power size={12}/> Unload scan</button>}
        {loaded && onAddMarker && <button type="button" className="as-add-marker" onClick={()=>setMarkingPoint(v=>!v)}><MousePointer2 size={12}/>{markingPoint?"Cancel placement":"Mark a point"}</button>}
        {markingPoint && loaded && <div className="as-pick-overlay" role="button" tabIndex={0} aria-label="Click a visible surface to place an inspection marker" onClick={event=>void pickMarker(event)} onKeyDown={event=>{if(event.key==="Escape")setMarkingPoint(false);}}><span>{pickingPoint?"Finding surface depth…":"Click a visible surface · Escape to cancel"}</span></div>}
        {loaded && !snapshot.scan.calibrated && <div className="as-calibration-note"><Focus size={12}/> Visual audit · dimensions need independent calibration.</div>}
        {!referenceOnly && title && <div className="as-owner-switch" aria-label="Viewer owner"><span className={viewOwner === "ai" ? "active" : ""}>{viewOwner === "ai" ? <span className={`as-live-dot ${live?.running ? "is-live" : ""}`} /> : null}{title}</span></div>}
        {!referenceOnly && viewOwner === "ai" && live && !selectedFindingId && <div className="as-live-hud" role="status" aria-live="polite">
          <div className="as-live-head"><span className={`as-live-dot ${live.running ? "is-live" : ""}`} />{live.running ? `${live.agentName || "Argon"} live` : "Argon idle"}</div>
          <strong>{live.action}</strong>
          <p>{live.detail}</p>
          {live.captureUrl && <a href={live.captureUrl} target="_blank" rel="noreferrer" className="as-live-capture"><img src={live.captureUrl} alt={live.captureLabel || "Latest capture"} /><span>{live.captureLabel || "Latest capture"}</span></a>}
          <small>Camera follows Argon. Use the Human viewer beside it to explore on your own.</small>
        </div>}
      </>}
      {error && <div className="as-error" role="alert"><p>{error}</p>{snapshot.scan.sourceUrl && <a href={snapshot.scan.sourceUrl} target="_blank" rel="noreferrer">Open source viewer <ExternalLink size={12}/></a>}<button type="button" onClick={()=>setError(null)}>Dismiss</button></div>}
      <div className="as-bottom"><span><i/>{isReference?"3D BLUEPRINT":loaded?"LIVE SCENE":"SCAN VIEW"}</span><span>{isReference?"Drag to orbit · cutaway walls":snapshot.scan.name || "Your scan appears here"}</span><div>{snapshot.scan.sourceUrl && <a href={snapshot.scan.sourceUrl} target="_blank" rel="noreferrer" aria-label="Open original scan"><ExternalLink size={13}/></a>}<button type="button" aria-label="Expand scene viewer" onClick={()=>void fullscreen()}><Maximize2 size={13}/></button></div></div>
    </div>
  );
}
