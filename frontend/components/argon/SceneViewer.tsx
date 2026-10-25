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

function settingsFor(annotations: Finding[], position?: Vec3, target?: Vec3) {
  return {
    version: 2 as const, tonemapping: "linear" as const, highPrecisionRendering: false,
    background: { color: [0.045, 0.06, 0.06] as Vec3 },
    postEffectSettings: {
      sharpness: { enabled: false, amount: 0 }, bloom: { enabled: false, intensity: 0, blurLevel: 0 },
      grading: { enabled: false, brightness: 1, contrast: 1, saturation: 1, tint: [1, 1, 1] as Vec3 },
      vignette: { enabled: false, intensity: 0, inner: 0, outer: 1, curvature: 1 },
      fringing: { enabled: false, intensity: 0 }
    }, animTracks: [], cameras: position && target ? [{ initial: { position, target, fov: 75 } }] : [],
    annotations: annotations.map(f => ({ position: f.anchor, title: f.title, text: `${f.reason}\nExpected: ${f.expected}\nObserved: ${f.observed}`, extras: { findingId: f.id }, camera: { initial: { position: f.cameraPosition, target: f.cameraTarget, fov: 65 } } })),
    startMode: "default" as const
  };
}

export default function SceneViewer({ snapshot, selectedFindingId, onSelectFinding, selectedRoomId, viewMode = "perspective", showMarkers = true, showPath = true, heatmap = false, onAddMarker, className = "", referenceOnly = false }: SceneViewerProps) {
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
  const viewerRef = useRef<ViewerHandle | null>(null);
  const generation = useRef(0);
  const userSelected = useRef<string | null>(null);
  const selected = snapshot.findings.find(f => f.id === selectedFindingId);
  const realAnnotations = useMemo(() => snapshot.findings.filter(f => !f.isSample && f.status !== "dismissed" && (f.annotationSource === "scan" || snapshot.scan.calibrated)), [snapshot.findings, snapshot.scan.calibrated]);
  const annotationKey = realAnnotations.map(f => `${f.id}:${f.anchor.join(",")}`).join("|");
  const initialCamera = useRef<{ position: Vec3; target: Vec3 } | null>(snapshot.scan.initialCameraPosition && snapshot.scan.initialCameraTarget ? { position: snapshot.scan.initialCameraPosition, target: snapshot.scan.initialCameraTarget } : null);
  const focusWaiter = useRef<{ resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [cameraRevision, setCameraRevision] = useState(0);
  const isReference = referenceOnly || mode === "reference";

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
    if (selectedFindingId && userSelected.current !== selectedFindingId) {
      userSelected.current = selectedFindingId;
      if (selected?.isSample || (!snapshot.scan.calibrated && selected?.annotationSource !== "scan")) { unload(); setMode("reference"); }
      else if (!referenceOnly) {
        setMode("source");
        if (configured && snapshot.scan.assetUrl) setLoadRequested(true);
        const index = realAnnotations.findIndex(f => f.id === selectedFindingId);
        if (viewerRef.current?.state.loaded && index >= 0) viewerRef.current.selectAnnotation(index);
      }
    }
  }, [selectedFindingId, selected?.isSample, selected?.annotationSource, snapshot.scan.calibrated, realAnnotations, unload, configured, snapshot.scan.assetUrl, referenceOnly]);

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
          noanim: true, nofx: true, budget: RESOURCE_LIMITS.maxSplats / 1_000_000,
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
          if (viewer.state.loaded && selectedFindingId && !camera) {
            const index = realAnnotations.findIndex(f => f.id === selectedFindingId);
            if (index >= 0) viewer.selectAnnotation(index);
          }
        });
        viewer.events.on("selectedAnnotation:changed", (index: number | null) => {
          if (index !== null && realAnnotations[index]) onSelectFinding(realAnnotations[index].id);
        });
        unregister = registerViewer({
          capture: async () => {
            if (!viewer.state.loaded) throw new Error("Open the embedded scan and wait for its first frame.");
            const result = await viewer.captureFrame({ width: 1280, height: 720, supersample: 1 });
            const source = result.data.startsWith("data:") ? result.data : `data:image/png;base64,${result.data}`;
            const bitmap = await createImageBitmap(await (await fetch(source)).blob());
            const canvas = document.createElement("canvas");
            const factor = Math.min(1, RESOURCE_LIMITS.maxImageEdge / Math.max(bitmap.width, bitmap.height));
            canvas.width = Math.round(bitmap.width * factor); canvas.height = Math.round(bitmap.height * factor);
            const context = canvas.getContext("2d");
            if (!context) { bitmap.close(); throw new Error("Could not prepare a bounded inspection image."); }
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
            const data = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
            const width = canvas.width, height = canvas.height; canvas.width = 0; canvas.height = 0;
            return { data, width, height, mimeType: "image/jpeg" };
          },
          focus: async (position, target) => {
            if (focusWaiter.current) throw new Error("A camera move is already in progress.");
            initialCamera.current = { position, target };
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
  }, [loadRequested, isReference, snapshot.scan.assetUrl, snapshot.scan.calibrated, snapshot.scan.scale, snapshot.scan.sourceUrl, annotationKey, cameraRevision]);

  useEffect(() => { if (viewerRef.current) viewerRef.current.state.showAnnotations = showMarkers; }, [showMarkers]);
  useEffect(() => () => { if (focusWaiter.current) { clearTimeout(focusWaiter.current.timer); focusWaiter.current.reject(new Error("The viewer was closed during navigation.")); focusWaiter.current = null; } }, []);
  useEffect(() => {
    if (viewerRef.current?.state.loaded && viewMode === "walk") {
      viewerRef.current.state.cameraMode = viewerRef.current.state.walkAllowed ? "walk" : "fly";
    }
  }, [viewMode, loaded]);
  useEffect(() => {
    let offscreenTimer: ReturnType<typeof setTimeout> | null = null;
    const pause = () => {
      if (document.hidden && viewerRef.current) { unload(); setPausedForMemory(true); }
    };
    document.addEventListener("visibilitychange", pause);
    const observer = new IntersectionObserver(entries => {
      if (offscreenTimer) { clearTimeout(offscreenTimer); offscreenTimer = null; }
      if (!entries[0]?.isIntersecting) offscreenTimer = setTimeout(() => { if (viewerRef.current) { unload(); setPausedForMemory(true); } }, 15_000);
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
        <BlueprintScene snapshot={snapshot} selectedFindingId={selectedFindingId} onSelectFinding={onSelectFinding} selectedRoomId={selectedRoomId} viewMode={viewMode} showMarkers={showMarkers} showPath={showPath} heatmap={heatmap} zoom={zoom} rotation={rotation}/>
        <div className="as-reference-notice"><Box size={12}/>{snapshot.blueprint.rooms.length ? snapshot.blueprint.generatedFrom === "scan" ? "Scan-derived draft · approximate room geometry" : snapshot.blueprint.metricStatus === "unmeasured" || snapshot.blueprint.units === "scene" ? "Generated draft · dimensions unverified" : "Blueprint draft · review against source materials" : "Awaiting spatial model"}</div>
        <div className="as-reference-controls"><button type="button" aria-label="Zoom out 3D blueprint" onClick={()=>setZoom(v=>Math.max(0.5,v-0.15))}>−</button><span>{Math.round(zoom*100)}%</span><button type="button" aria-label="Zoom in 3D blueprint" onClick={()=>setZoom(v=>Math.min(3,v+0.15))}>+</button><button type="button" aria-label="Rotate 3D blueprint" onClick={()=>setRotation(v=>v+0.4)}><RotateCcw size={13}/></button></div>
        {onAddMarker && snapshot.blueprint.rooms.length > 0 && <button type="button" className="as-add-marker" onClick={()=>{const room=snapshot.blueprint.rooms.find(r=>r.id===selectedRoomId)||snapshot.blueprint.rooms[0];if(room)onAddMarker(room.center,{source:snapshot.blueprint.coordinateFrame === "scan" ? "scan" : "reference"});}}><MousePointer2 size={12}/> Mark selected room</button>}
      </> : <>
        {!loadRequested && <div className="as-poster" style={{backgroundImage:snapshot.scan.posterUrl ? `linear-gradient(180deg,rgba(14,22,18,.1),rgba(14,22,18,.5)),url(${JSON.stringify(snapshot.scan.posterUrl)})` : "radial-gradient(ellipse at 40% 40%,#30412b,#151c19 70%)"}}>
          <div className="as-load-card"><div className="as-load-icon"><ScanLine size={24}/></div><h3>{configured ? "Your space. A closer look." : "Start with your 3D scan."}</h3><p>{pausedForMemory ? "The scan was unloaded while away to release GPU memory." : configured ? "Explore your scan and every finding in one place." : "Add a scan link in Scan & materials. Auditgon will open it here and build the room map as it audits."}</p>{configured && <button type="button" onClick={()=>{setError(null);setPausedForMemory(false);setLoadRequested(true);}}><ScanLine size={14}/> Open embedded scan</button>}<span><ShieldCheck size={11}/> Progressive streaming · 750k active splat budget</span></div>
        </div>}
        <div className="as-canvas" ref={canvasHost} style={{display:loadRequested?"block":"none"}} />
        {loadRequested && !loaded && <div className="as-loading"><LoaderCircle size={17} className="as-spin"/><span>Streaming the scan{progress>0?` · ${progress}%`:"…"}</span><button type="button" onClick={unload}>Cancel</button></div>}
        {loadRequested && <button type="button" className="as-unload" onClick={unload}><Power size={12}/> Unload scan</button>}
        {loaded && onAddMarker && <button type="button" className="as-add-marker" onClick={()=>setMarkingPoint(v=>!v)}><MousePointer2 size={12}/>{markingPoint?"Cancel placement":"Mark a point"}</button>}
        {markingPoint && loaded && <div className="as-pick-overlay" role="button" tabIndex={0} aria-label="Click a visible surface to place an inspection marker" onClick={event=>void pickMarker(event)} onKeyDown={event=>{if(event.key==="Escape")setMarkingPoint(false);}}><span>{pickingPoint?"Finding surface depth…":"Click a visible surface · Escape to cancel"}</span></div>}
        {loaded && !snapshot.scan.calibrated && <div className="as-calibration-note"><Focus size={12}/> Visual audit · dimensions need independent calibration.</div>}
      </>}
      {error && <div className="as-error" role="alert"><p>{error}</p>{snapshot.scan.sourceUrl && <a href={snapshot.scan.sourceUrl} target="_blank" rel="noreferrer">Open source viewer <ExternalLink size={12}/></a>}<button type="button" onClick={()=>setError(null)}>Dismiss</button></div>}
      <div className="as-bottom"><span><i/>{isReference?"3D BLUEPRINT":loaded?"LIVE SCENE":"SCAN VIEW"}</span><span>{isReference?"Drag to orbit · cutaway walls":snapshot.scan.name || "Your scan appears here"}</span><div>{snapshot.scan.sourceUrl && <a href={snapshot.scan.sourceUrl} target="_blank" rel="noreferrer" aria-label="Open original scan"><ExternalLink size={13}/></a>}<button type="button" aria-label="Expand scene viewer" onClick={()=>void fullscreen()}><Maximize2 size={13}/></button></div></div>
    </div>
  );
}
