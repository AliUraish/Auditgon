"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Box, Check, ChevronDown, ChevronRight, CircleAlert, ClipboardCheck, Command, Compass, FileText, Flag, Focus, HelpCircle, Layers2, ListFilter, Map, MapPin, Maximize2, Menu, Navigation, Pause, Play, Plus, RotateCcw, Route, ScanLine, Search, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import type { FindingStatus, InspectionSnapshot, MarkerContext, UploadRecord, Vec3, ViewMode } from "@/lib/contracts";
import { elapsedLabel, inspectionStats, request, runAction } from "@/lib/client";
import { getViewerController } from "@/lib/viewer-bridge";
import { prepareEvidenceImage } from "@/lib/evidence-image";
import SceneViewer from "./SceneViewer";
import FloorPlan from "./FloorPlan";
import FindingDetail from "./FindingDetail";
import ProjectInputs from "./ProjectInputs";
import ReportPanel from "./ReportPanel";
import { BusyIcon, checkLabels, EmptyState, EventList, Metrics, Modal, PanelHeader, Pill, StatusIcon } from "./UI";

type Section = "workspace" | "checklist" | "blueprint" | "findings" | "report" | "inputs" | "activity";
const sections: { id: Section; label: string; icon: typeof ScanLine }[] = [
  { id: "workspace", label: "Audit workspace", icon: ScanLine },
  { id: "checklist", label: "Checklist", icon: ClipboardCheck },
  { id: "blueprint", label: "3D blueprint", icon: Layers2 },
  { id: "findings", label: "Findings", icon: Flag },
  { id: "report", label: "Report", icon: FileText },
];
const sectionTitles: Record<Section, [string, string]> = {
  workspace: ["Audit workspace", "Your space, examined. The evidence, connected."],
  checklist: ["Inspection checklist", "Every requirement, with a clear outcome and evidence."],
  blueprint: ["3D blueprint", "A spatial understanding of your rooms, features, and findings."],
  findings: ["Findings & observations", "Understand what was flagged, where it is, and why it matters."],
  report: ["Inspection report", "An evidence-backed record, ready for the next step."],
  inputs: ["Your space. A closer look.", "Add a 3D scan link and the materials you want Auditgon to audit."],
  activity: ["Audit activity", "The decisions, measurements, and revisits behind the inspection."],
};

export default function Dashboard() {
  const [snapshot, setSnapshot] = useState<InspectionSnapshot | null>(null);
  const [section, setSection] = useState<Section>("workspace");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("perspective");
  const [showMarkers, setShowMarkers] = useState(true);
  const [showPath, setShowPath] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<"search" | "help" | "reset" | "marker" | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [roomFilter, setRoomFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [manualAnchor, setManualAnchor] = useState<Vec3>([0, 1, 0]);
  const [manualCamera, setManualCamera] = useState<{position:Vec3;target:Vec3}|null>(null);
  const [manualSource, setManualSource] = useState<"scan" | "reference">("reference");
  const [toolBusy, setToolBusy] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolAttempt, setToolAttempt] = useState(0);
  const [pollFailures, setPollFailures] = useState(0);
  const pollErrorRef = useRef<string | null>(null);
  const pendingDelivery = useRef<{ id: string; result: Record<string, unknown>; attempts: number } | null>(null);
  const servicedToolIds = useRef(new Set<string>());
  const busyRef = useRef(false);
  const alive = useRef(true);
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (section === "workspace" && selectedFindingId) {
      viewerRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
    } else {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [section, selectedFindingId]);

  const acceptSnapshot = useCallback((next: InspectionSnapshot) => { setSnapshot(next); setPollFailures(0); pollErrorRef.current = null; }, []);
  const notify = useCallback((message: string) => { setNotice(message); }, []);
  const fail = useCallback((message: string) => { setError(message); }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await request<InspectionSnapshot>("/api/inspection");
      if (alive.current) {
        setSnapshot(result);
        const findingId = new URLSearchParams(window.location.search).get("finding");
        if (findingId && result.findings.some(finding => finding.id === findingId)) { setSelectedFindingId(findingId); setSelectedRoomId(result.findings.find(finding => finding.id === findingId)!.roomId); setSection("workspace"); }
      }
    }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "The workspace could not be loaded."); }
    finally { if (alive.current) setLoading(false); }
  }, []);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    request<InspectionSnapshot>("/api/inspection", { signal: controller.signal }).then(result => {
      if (!alive.current) return;
      setSnapshot(result);
      if (!(result.scan.configured ?? Boolean(result.scan.sourceUrl || result.scan.assetUrl))) setSection("inputs");
      const findingId = new URLSearchParams(window.location.search).get("finding");
      const finding = result.findings.find(item => item.id === findingId);
      if (finding) { setSelectedFindingId(finding.id); setSelectedRoomId(finding.roomId); setSection("workspace"); }
    }).catch(cause => {
      if (alive.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The workspace could not be loaded.");
    }).finally(() => { if (alive.current && !controller.signal.aborted) setLoading(false); });
    return () => { alive.current = false; controller.abort(); };
  }, []);
  useEffect(() => {
    if (!snapshot || snapshot.status !== "running" || pollFailures >= 5) return;
    let cancelled = false;
    const baseDelay = snapshot.mode === "demo" ? 2300 : 6000;
    const retryDelay = Math.min(30_000, baseDelay * 2 ** pollFailures);
    const timer = window.setTimeout(async () => {
      if (document.hidden || busyRef.current) { if (!cancelled) setSnapshot(previous => previous ? { ...previous } : previous); return; }
      busyRef.current = true;
      try {
        const next = await runAction("advance", snapshot.mode);
        if (!cancelled && alive.current) {
          setSnapshot(next); setPollFailures(0);
          const previousPollError = pollErrorRef.current;
          if (previousPollError) setError(previous => previous === previousPollError ? null : previous);
          pollErrorRef.current = null;
        }
      } catch (cause) {
        if (!cancelled && alive.current) {
          const failures = pollFailures + 1;
          const nextDelay = Math.min(30_000, baseDelay * 2 ** failures);
          const detail = cause instanceof Error ? cause.message : "The audit update could not be received.";
          const message = failures < 5 ? `${detail} Retrying audit updates in ${Math.ceil(nextDelay / 1000)} seconds (${failures}/5).` : `${detail} Automatic updates stopped after 5 attempts. Retry updates to reconnect to the saved audit.`;
          pollErrorRef.current = message; setError(message); setPollFailures(failures);
        }
      } finally { busyRef.current = false; }
    }, retryDelay);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [snapshot, pollFailures]);

  useEffect(() => {
    const id = snapshot?.agent?.pendingTool?.id;
    if (pendingDelivery.current?.id !== id) pendingDelivery.current = null;
  }, [snapshot?.agent?.pendingTool?.id]);

  useEffect(() => {
    const pending = snapshot?.agent?.pendingTool;
    if (!pending || snapshot?.status !== "running" || busyRef.current || servicedToolIds.current.has(pending.id)) return;
    const cached = pendingDelivery.current?.id === pending.id ? pendingDelivery.current : null;
    if (cached && cached.attempts >= 3) return;
    const viewer = getViewerController();
    if (!cached && (section !== "workspace" || document.hidden || !viewer?.describe().loaded)) return;
    const retryDelay = cached ? Math.min(4000, 1000 * 2 ** cached.attempts) : 0;
    const taskTimer = window.setTimeout(() => {
      if (busyRef.current || servicedToolIds.current.has(pending.id)) return;
      servicedToolIds.current.add(pending.id);
      if (servicedToolIds.current.size > 80) servicedToolIds.current.delete(servicedToolIds.current.values().next().value!);
      busyRef.current = true; setBusy(true); setToolBusy(true); setToolError(null);
      void (async () => {
        let delivery = pendingDelivery.current?.id === pending.id ? pendingDelivery.current : null;
        if (!delivery) {
          let result: Record<string, unknown>;
          try {
            if (!viewer) throw new Error("Open the live scan viewer to complete this request.");
            if (pending.name === "inspect_view") {
              const capture = await viewer.capture(); const pose = viewer.describe();
              if (capture.data.length > 2_000_000) throw new Error("The bounded scan capture exceeded the evidence upload limit.");
              result = { imageData: capture.data, mimeType: capture.mimeType, cameraPosition: pose.cameraPosition, cameraTarget: pose.cameraTarget };
            } else if (pending.name === "sample_geometry") result = { geometry: await viewer.sample(pending.args.points || []) };
            else if (pending.args.position && pending.args.target) { await viewer.focus(pending.args.position, pending.args.target); result = { cameraPosition: pending.args.position, cameraTarget: pending.args.target }; }
            else result = { error: "The requested camera move did not include both position and target." };
          } catch (cause) { result = { error: cause instanceof Error ? cause.message.slice(0, 1000) : "The visible renderer could not complete this tool." }; }
          delivery = { id: pending.id, result, attempts: 0 }; pendingDelivery.current = delivery;
        }
        delivery.attempts += 1;
        try {
          const next = await request<InspectionSnapshot>(`/api/agent-tools/${encodeURIComponent(pending.id)}`, { method: "POST", body: JSON.stringify(delivery.result) });
          if (pendingDelivery.current?.id === pending.id) pendingDelivery.current = null;
          if (alive.current) { setToolError(null); setSnapshot(next); }
        } catch (cause) {
          servicedToolIds.current.delete(pending.id);
          if (alive.current) {
            const detail = cause instanceof Error ? cause.message : "The viewer response could not be delivered.";
            setToolError(delivery.attempts < 3 ? `${detail} Retrying the saved viewer response (${delivery.attempts + 1}/3).` : `${detail} Delivery stopped after 3 attempts. The saved viewer response can be retried.`);
            if (delivery.attempts < 3) setToolAttempt(value => value + 1);
          }
        } finally { busyRef.current = false; if (alive.current) { setBusy(false); setToolBusy(false); } }
      })();
    }, retryDelay);
    return () => window.clearTimeout(taskTimer);
  }, [snapshot, section, toolAttempt]);

  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 5500); return () => window.clearTimeout(timer); }, [notice]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setModal(value => value === "search" ? null : "search"); }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, []);

  const mutate = useCallback(async (operation: () => Promise<InspectionSnapshot>, success?: string) => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError(null);
    try { const next = await operation(); if (alive.current) { setSnapshot(next); setPollFailures(0); pollErrorRef.current = null; if (success) setNotice(success); } return true; }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "This change could not be saved."); return false; }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }, []);

  const navigate = (value: Section) => { setSection(value); setQuery(""); setFilter("all"); setRoomFilter("all"); setPage(0); setMobileNav(false); setSelectedFindingId(null); };
  const selectFinding = (id: string) => { setSelectedFindingId(id); };
  const showIn3D = (id: string) => { setSelectedFindingId(id); setSelectedRoomId(snapshot?.findings.find(finding => finding.id === id)?.roomId || null); setSection("workspace"); setShowMarkers(true); setMobileNav(false); };
  const updateFinding = async (id: string, patch: { status?: FindingStatus; note?: string }) => { await mutate(() => request<InspectionSnapshot>(`/api/findings/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }), "Finding review saved. The report and markers are up to date."); };
  const openMarker = (anchor?: Vec3, context?: MarkerContext) => { if (!snapshot?.blueprint.rooms.length && context?.source !== "scan") { notify("Start the audit to generate rooms before adding a reference observation."); return; } const room = snapshot?.blueprint.rooms.find(item => item.id === selectedRoomId) || snapshot?.blueprint.rooms.find(item => item.id === snapshot.currentRoomId) || snapshot?.blueprint.rooms[0]; setManualAnchor(anchor || room?.center || [0, 1, 0]); setManualSource(context?.source || "reference"); setManualCamera(context?.cameraPosition && context?.cameraTarget ? {position:context.cameraPosition,target:context.cameraTarget} : null); setModal("marker"); };

  const searchResults = useMemo(() => {
    if (!snapshot || !query.trim()) return [];
    const q = query.toLowerCase();
    return [
      ...snapshot.findings.filter(item => `${item.title} ${item.reason} ${item.id}`.toLowerCase().includes(q)).map(item => ({ id: item.id, type: "finding" as const, title: item.title, subtitle: `${item.id} · ${item.severity}` })),
      ...snapshot.checklist.filter(item => `${item.label} ${item.id}`.toLowerCase().includes(q)).map(item => ({ id: item.id, type: "check" as const, title: item.label, subtitle: `${item.id} · ${checkLabels[item.status]}` })),
    ].slice(0, 12);
  }, [snapshot, query]);

  const selectedFinding = snapshot?.findings.find(item => item.id === selectedFindingId);
  const stats = snapshot ? inspectionStats(snapshot) : null;
  const currentRoom = snapshot?.blueprint.rooms.find(room => room.id === snapshot.currentRoomId);
  const currentItem = snapshot?.checklist.find(item => item.id === snapshot.currentItemId);
  const activeRoom = selectedRoomId || snapshot?.currentRoomId;
  const title = sectionTitles[section];
  const isRunning = snapshot?.status === "running";
  const hasSource = snapshot ? (snapshot.scan.configured ?? Boolean(snapshot.scan.sourceUrl || snapshot.scan.assetUrl)) : false;
  const hasRooms = Boolean(snapshot?.blueprint.rooms.length);
  const projectLabel = hasSource ? snapshot?.name || snapshot?.scan.name || "Audit project" : "New audit project";
  const filteredChecks = snapshot?.checklist.filter(item => (filter === "all" || item.status === filter) && (roomFilter === "all" || item.roomId === roomFilter) && `${item.label} ${item.category} ${item.id}`.toLowerCase().includes(query.toLowerCase())) || [];
  const filteredFindings = snapshot?.findings.filter(item => (filter === "all" || item.status === filter || item.severity === filter) && (roomFilter === "all" || item.roomId === roomFilter) && `${item.title} ${item.reason} ${item.id}`.toLowerCase().includes(query.toLowerCase())) || [];

  return <div className="argon-app">
    {mobileNav ? <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} /> : null}
    <aside className={`app-sidebar ${mobileNav ? "mobile-open" : ""}`}><a href="#" className="brand" aria-label="Auditgon inspection home" onClick={event => { event.preventDefault(); navigate("workspace"); }}><svg width="25" height="28" viewBox="0 0 25 28" fill="none" aria-hidden="true"><path d="M12.5 1L24 7.6V20.5L12.5 27L1 20.5V7.6L12.5 1Z" stroke="currentColor" strokeWidth="1.4" /><path d="M1.5 7.8L12.5 14L23.5 7.8M12.5 14V26M7 4.5L18.5 11M6.5 11L18.5 4.5M6.5 11V23.7M18.5 11V23.7" stroke="currentColor" strokeWidth="1.1" /></svg><span>auditgon<span className="brand-period">.</span></span></a>
      <button className="workspace-switch" onClick={() => navigate("inputs")}><span className="workspace-icon"><Box size={17} /></span><span><strong>{projectLabel}</strong><small>{hasSource ? "Audit project" : "Add your scan to begin"}</small></span><ChevronDown size={13} /></button>
      <span className="nav-label">WORKSPACE</span><nav aria-label="Main navigation">{sections.map(item => <button key={item.id} className={`nav-item ${section === item.id ? "active" : ""}`} onClick={() => navigate(item.id)} aria-current={section === item.id ? "page" : undefined}><item.icon size={17} strokeWidth={1.6} /><span>{item.label}</span>{item.id === "findings" && stats?.openFindings.length ? <span className="nav-count">{stats.openFindings.length}</span> : null}{section === item.id ? <span className="nav-active-dot" /> : null}</button>)}</nav>
      <span className="nav-label second-label">PROJECT</span><nav aria-label="Project navigation"><button className={`nav-item ${section === "inputs" ? "active" : ""}`} onClick={() => navigate("inputs")} aria-current={section === "inputs" ? "page" : undefined}><SlidersHorizontal size={17} strokeWidth={1.6} /><span>Scan & materials</span></button><button className={`nav-item ${section === "activity" ? "active" : ""}`} onClick={() => navigate("activity")} aria-current={section === "activity" ? "page" : undefined}><Activity size={17} strokeWidth={1.6} /><span>Audit activity</span></button></nav>
      
    </aside>
    <div className="app-shell"><header className="app-topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={20} /></button><span className="breadcrumb-project"><Box size={14} /> {projectLabel}</span><ChevronRight size={13} /><strong>{sections.find(item => item.id === section)?.label || (section === "inputs" ? "Scan & materials" : "Audit activity")}</strong></div><div className="topbar-actions"><button className="search-trigger" onClick={() => { setQuery(""); setModal("search"); }}><Search size={14} /><span>Search workspace</span><kbd>⌘ K</kbd></button><button className="icon-button" aria-label="Inspection help" onClick={() => setModal("help")}><HelpCircle size={17} /></button><span className="topbar-divider" /><span className="top-avatar" aria-label="Your workspace">A</span></div></header>
      <main className="main-content"><div className="page-heading"><div><div className="page-eyebrow"><span className="tiny-square" /> SPATIAL INTELLIGENCE <span>/</span> {snapshot?.id ? `PROJECT ${snapshot.id.slice(-6).toUpperCase()}` : "AUDITGON"}</div><h1>{title[0]}</h1><p>{title[1]}</p></div><div className="page-actions">{snapshot && section !== "inputs" ? <><button className="button button-outline" onClick={() => navigate("report")}><ArrowDownToLine size={14} /><span>Export report</span></button><button className={`button ${isRunning ? "button-outline" : "button-dark"}`} disabled={busy} onClick={() => isRunning ? void mutate(() => runAction("pause"), "Audit paused. Your progress is saved.") : snapshot.status === "paused" ? void mutate(() => runAction("resume"), "Audit resumed.") : !hasSource ? navigate("inputs") : (setSection("workspace"), setSelectedFindingId(null), void mutate(() => runAction("start", "managed"), "Audit started. Auditgon is examining your materials."))}><BusyIcon busy={busy}>{isRunning ? <Pause size={14} /> : <Play size={14} fill="currentColor" />}</BusyIcon>{isRunning ? "Pause audit" : snapshot.status === "paused" ? "Resume audit" : "Start audit"}</button></> : null}</div></div>
        {error ? <div className="error-banner" role="alert"><CircleAlert size={16} /><span>{error}</span>{!snapshot ? <button className="text-button" onClick={() => { setLoading(true); setError(null); void refresh(); }}>Try again<RotateCcw size={12} /></button> : pollFailures >= 5 && snapshot.status === "running" ? <button className="text-button" onClick={() => { setPollFailures(0); pollErrorRef.current = null; setError(null); }}>Retry audit updates<RotateCcw size={12} /></button> : null}<button className="icon-button" onClick={() => setError(null)} aria-label="Dismiss error"><X size={14} /></button></div> : null}
        {loading && !snapshot ? <div className="loading-workspace" aria-live="polite"><div className="loading-orbit"><ScanLine size={30} strokeWidth={1} /></div><h2>Opening your workspace</h2><p>Loading the reference, findings, and saved inspection.</p><div className="loading-line" /></div> : null}
        {snapshot && stats ? <>

          {snapshot.agent?.pendingTool ? <div className="viewer-request-banner"><ScanLine size={16} /><div><strong>{toolBusy ? "Auditgon is collecting live scan evidence" : toolError ? "Viewer response needs attention" : "Auditgon needs the live scan viewer"}</strong><p>{toolError || (toolBusy ? "The visible renderer is completing the requested tool. Keep this tab open." : `${snapshot.agent.pendingTool.args.label || "A camera action or scan capture is waiting."} Open the inspection view and load the scan to continue.`)}</p></div>{toolError ? <button className="button button-outline button-small" onClick={() => { servicedToolIds.current.delete(snapshot.agent!.pendingTool!.id); if (pendingDelivery.current?.id === snapshot.agent!.pendingTool!.id) pendingDelivery.current.attempts = 0; setToolError(null); setToolAttempt(value => value + 1); }}>Retry viewer task</button> : !toolBusy ? <button className="button button-outline button-small" onClick={() => { setSection("workspace"); setSelectedFindingId(null); setToolAttempt(value => value + 1); }}>Open live viewer<ArrowUpRight size={12} /></button> : null}</div> : null}
          {section === "workspace" && hasSource ? <>
            <Metrics snapshot={snapshot} />
            <div className={`workspace-grid ${selectedFinding ? "has-selected-finding" : ""}`}>
              <div className="viewer-column"><section className="viewer-panel panel" ref={viewerRef}><div className="viewer-heading"><div><span className="viewer-heading-icon"><ScanLine size={15} /></span><h2>Spatial inspection</h2><Pill tone={isRunning ? "green" : "neutral"}><span className={`tiny-dot ${isRunning ? "is-live" : ""}`} />{snapshot.status === "ready" ? "Ready" : snapshot.status === "running" ? "Auditing" : snapshot.status}</Pill></div><button className="icon-button" title="Expand viewer" aria-label="Expand viewer" onClick={async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await viewerRef.current?.requestFullscreen(); } catch { notify("Use your browser’s full-screen command to expand this view."); } }}><Maximize2 size={15} /></button></div><div className="viewer-stage"><SceneViewer snapshot={snapshot} selectedFindingId={selectedFindingId} onSelectFinding={selectFinding} selectedRoomId={activeRoom} viewMode={viewMode} showMarkers={showMarkers} showPath={showPath} onAddMarker={openMarker} className="main-scene-viewer" /></div><div className="viewer-toolbar"><div className="segmented-control" aria-label="Reference camera view">{([{ id: "perspective", label: "Perspective", icon: Box }, { id: "top", label: "Top view", icon: Layers2 }, { id: "walk", label: "Walk", icon: Navigation }] as const).map(view => <button key={view.id} className={viewMode === view.id ? "selected" : ""} onClick={() => setViewMode(view.id)} aria-pressed={viewMode === view.id}><view.icon size={13} /><span>{view.label}</span></button>)}</div><div className="viewer-layer-controls"><button className={showMarkers ? "selected" : ""} onClick={() => setShowMarkers(value => !value)} aria-pressed={showMarkers} title="Show finding markers"><MapPin size={14} /><span>Markers</span></button><button className={showPath ? "selected" : ""} onClick={() => setShowPath(value => !value)} aria-pressed={showPath} title="Show inspection path"><Route size={14} /><span>Path</span></button><button className="icon-button" onClick={() => openMarker()} disabled={!hasRooms} title={hasRooms ? "Add an observation" : "Generate rooms to add a reference observation"} aria-label="Add an observation"><Plus size={15} /></button></div></div></section>
                <section className="current-inspection"><span className="current-agent-icon"><Compass size={19} strokeWidth={1.4} /></span><div><div className="current-inspection-label"><span className="eyebrow">{isRunning ? "AUDITGON IS WORKING" : "CURRENT AUDIT"}</span><span>{currentRoom?.name || "Preparing agenda"}</span></div><h3>{currentItem?.label || (snapshot.status === "complete" ? "Audit complete. Your report is ready." : hasRooms ? "Ready to examine the space, one detail at a time." : "Ready to discover the rooms in your scan.")}</h3><p>{currentItem?.expected || (hasRooms ? "Start the audit to examine each room and record the evidence." : "Auditgon will generate a spatial model from the scan and any supplied materials.")}</p></div><button className="icon-button" aria-label="Open inspection checklist" onClick={() => navigate("checklist")}><ArrowUpRight size={17} /></button></section>
              </div>
              <div className="workspace-right">{selectedFinding ? <FindingDetail key={selectedFinding.id} finding={selectedFinding} snapshot={snapshot} onClose={() => setSelectedFindingId(null)} onShowIn3D={() => showIn3D(selectedFinding.id)} onUpdate={updateFinding} busy={busy} /> : <>
                <section className="panel floorplan-panel"><div className="mini-panel-heading"><h2>Reference map</h2><button className="icon-button" aria-label="Open blueprint" onClick={() => navigate("blueprint")}><ArrowUpRight size={15} /></button></div><FloorPlan snapshot={snapshot} selectedRoomId={activeRoom} selectedFindingId={selectedFindingId} onSelectRoom={setSelectedRoomId} onSelectFinding={selectFinding} showPath={showPath} /><div className="map-footer"><span><span className="tiny-dot" />{currentRoom?.name || "Reference frame"}</span></div></section>
                <section className="panel room-progress-panel"><div className="mini-panel-heading"><h2>Room coverage</h2><span>{snapshot.blueprint.rooms.length} rooms</span></div><div className="room-progress-list">{snapshot.blueprint.rooms.slice(0, 8).map(room => { const checks = snapshot.checklist.filter(item => item.roomId === room.id); const verified = checks.filter(item => item.status === "pass" || item.status === "finding").length; const active = room.id === activeRoom; const count = snapshot.findings.filter(item => item.roomId === room.id && item.status === "open").length; return <button key={room.id} className={`room-progress-row ${active ? "is-current" : ""}`} onClick={() => setSelectedRoomId(room.id)}><span className={`room-state-dot ${verified === checks.length && checks.length ? "is-done" : active ? "is-active" : ""}`} /> <span>{room.name}</span>{count ? <span className="room-issue-count">{count}</span> : null}<span className="room-check-count">{verified}<small>/{checks.length}</small></span><ChevronRight size={12} /></button>; })}</div><button className="all-checks-button" onClick={() => navigate("checklist")}>View full checklist<ArrowRight size={13} /></button></section>
              </>}</div>
            </div>
            <div className="workspace-bottom-grid"><section className="panel activity-panel"><PanelHeader eyebrow="THE INSPECTION, IN MOTION" title="Recent activity" action={<button className="text-button" onClick={() => navigate("activity")}>View all<ArrowUpRight size={12} /></button>} /><EventList events={snapshot.events} compact /></section><section className="panel recent-findings-panel"><PanelHeader eyebrow="EVIDENCE FIRST" title="Latest findings" action={<Pill tone="rust">{stats.openFindings.length} open</Pill>} />{snapshot.findings.length ? <div className="recent-finding-list">{snapshot.findings.slice(-4).reverse().map((finding, index) => <button key={finding.id} onClick={() => selectFinding(finding.id)}><span className={`finding-pin-number severity-${finding.severity}`}>{String(snapshot.findings.length - index).padStart(2, "0")}</span><span><strong>{finding.title}</strong><small>{snapshot.blueprint.rooms.find(room => room.id === finding.roomId)?.name} · {finding.isSample ? "Sample observation" : finding.category}</small></span><ArrowUpRight size={14} /></button>)}<button className="all-findings-button" onClick={() => navigate("findings")}>Review all findings<ArrowRight size={13} /></button></div> : <EmptyState title="A clean slate">Findings appear here with their location, evidence, and next step.</EmptyState>}</section></div>
          </> : null}
          {section === "workspace" && !hasSource ? <section className="panel"><EmptyState title="Your next audit starts with a scan" action={<button className="button button-dark" onClick={() => navigate("inputs")}><Plus size={14} />Add your scan link</button>}>Open your space here, add any useful materials, and let Auditgon look closer.</EmptyState></section> : null}
          {section === "checklist" ? <section className="panel data-panel"><PanelHeader eyebrow="THE FULL INSPECTION AGENDA" title={`${stats.total} checks. Every one traceable.`} action={<Pill tone="green">{stats.percent}% verified</Pill>} /><div className="data-toolbar"><div className="filter-tabs">{[{ id: "all", label: "All checks", count: stats.total }, { id: "pass", label: "Verified", count: stats.passed }, { id: "finding", label: "Flagged", count: stats.flagged }, { id: "blocked", label: "Needs evidence", count: stats.blocked }].map(tab => <button key={tab.id} className={filter === tab.id ? "active" : ""} onClick={() => { setFilter(tab.id); setPage(0); }}>{tab.label}<span>{tab.count}</span></button>)}</div><div className="table-controls"><label className="table-search"><Search size={14} /><input aria-label="Search checklist" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Search checks…" /></label><label className="room-filter"><ListFilter size={14} /><select value={roomFilter} onChange={event => { setRoomFilter(event.target.value); setPage(0); }} aria-label="Filter checklist by room"><option value="all">All rooms</option>{snapshot.blueprint.rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label></div></div><div className="table-scroll"><table className="inspection-table"><thead><tr><th>Inspection check</th><th>Room</th><th>Reference / expected</th><th>Status</th><th aria-label="Open check" /></tr></thead><tbody>{filteredChecks.slice(page * 25, (page + 1) * 25).map(item => <tr key={item.id}><td><div className="table-check-title"><StatusIcon status={item.status} /><span><strong>{item.label}</strong><small>{item.id} · {item.category}</small></span></div></td><td>{snapshot.blueprint.rooms.find(room => room.id === item.roomId)?.name}</td><td><span className="table-expected">{item.expected || "Visual observation"}</span>{item.observed ? <small className="table-observed">{item.observed}</small> : null}{item.reason ? <small className="table-observed">{item.reason}</small> : null}</td><td><Pill tone={item.status === "pass" ? "green" : item.status === "finding" ? "rust" : item.status === "blocked" ? "amber" : "neutral"}>{checkLabels[item.status]}</Pill></td><td>{item.findingId ? <button className="icon-button" aria-label={`View finding for ${item.label}`} onClick={() => { setSelectedFindingId(item.findingId || null); setSection("findings"); }}><ArrowUpRight size={15} /></button> : null}</td></tr>)}</tbody></table></div>{!filteredChecks.length ? <EmptyState title="No checks match these filters">Try another room or search term.</EmptyState> : null}<div className="table-pagination"><span>{filteredChecks.length ? page * 25 + 1 : 0}–{Math.min((page + 1) * 25, filteredChecks.length)} of {filteredChecks.length} checks</span><div><button className="icon-button" aria-label="Previous page" disabled={page === 0} onClick={() => setPage(value => value - 1)}><ArrowLeft size={14} /></button><button className="icon-button" aria-label="Next page" disabled={(page + 1) * 25 >= filteredChecks.length} onClick={() => setPage(value => value + 1)}><ArrowRight size={14} /></button></div></div></section> : null}
          {section === "blueprint" ? <div className="blueprint-layout"><div className="blueprint-main-column"><section className="panel blueprint-main"><PanelHeader eyebrow="SPATIAL UNDERSTANDING" title="3D blueprint" action={<Pill>{hasRooms ? `${snapshot.blueprint.rooms.length} rooms` : "Building understanding"}</Pill>} /><div className="blueprint-3d-stage"><SceneViewer referenceOnly snapshot={snapshot} selectedFindingId={selectedFindingId} onSelectFinding={selectFinding} selectedRoomId={activeRoom} viewMode="perspective" showMarkers={showMarkers} showPath={showPath} onAddMarker={hasRooms ? openMarker : undefined} className="blueprint-scene-viewer" /></div><div className="blueprint-toolbar blueprint-view-controls"><span><Layers2 size={14} />{snapshot.blueprint.generatedFrom === "scan" ? "Generated from scan evidence" : snapshot.blueprint.generatedFrom === "materials" ? "Generated from project materials" : "Spatial model"}</span></div><div className="blueprint-disclaimer">{snapshot.blueprint.isSample ? "Illustrative reference geometry." : (snapshot.blueprint.metricStatus === "design-dimensions" && snapshot.blueprint.units === "m") ? "Design dimensions come from your supplied materials. The scan remains an independent observation." : "The model represents the visible spatial layout. Physical dimensions remain unmeasured until independently calibrated."}</div></section><section className="panel blueprint-plan-panel"><PanelHeader title="Room map & coverage" action={<Pill>{snapshot.blueprint.features.length} features</Pill>} /><FloorPlan snapshot={snapshot} expanded selectedRoomId={activeRoom} selectedFindingId={selectedFindingId} onSelectRoom={setSelectedRoomId} onSelectFinding={id => { selectFinding(id); setSection("findings"); }} showPath={showPath} /></section></div><aside><section className="panel input-section"><PanelHeader title={snapshot.blueprint.rooms.find(room => room.id === activeRoom)?.name || "Room understanding"} />{hasRooms ? <><div className="blueprint-room-facts"><div><span>Floor area</span><strong>{(snapshot.blueprint.metricStatus === "unmeasured" || snapshot.blueprint.units === "scene") ? "Unmeasured" : snapshot.blueprint.rooms.find(room => room.id === activeRoom)?.area || "—"}{(snapshot.blueprint.metricStatus !== "unmeasured" && snapshot.blueprint.units !== "scene") ? <small> m²</small> : null}</strong></div><div><span>Model source</span><strong>{snapshot.blueprint.generatedFrom === "scan" ? "Scan" : "Materials"}</strong></div></div><h3 className="small-section-title">ROOM FEATURES</h3><div className="feature-list">{snapshot.blueprint.features.filter(feature => feature.roomId === activeRoom).map(feature => <div key={feature.id}><span><RulerIcon kind={feature.kind} /></span><div><strong>{feature.label}</strong><small>{feature.expected !== undefined ? `${feature.expected} ${feature.unit || (snapshot.blueprint.units === "scene" ? "scene units" : "m")}` : feature.source || "Observed feature"}</small></div></div>)}</div></> : <p className="section-description">Start an audit to generate rooms, connected spaces, and observable features from your scan and materials.</p>}<button className="button button-outline full-width" onClick={() => navigate("inputs")}><Plus size={14} />Add more materials</button></section><div className="memory-card"><div><Map size={18} /><h3>The picture builds as it audits</h3></div><p>The model, 3D markers, and report all update from the same recorded evidence.</p>{hasRooms ? <div className="draft-model-exports"><a className="text-button" href="/api/report?format=obj" download>Export 3D model · OBJ<ArrowDownToLine size={13} /></a><a className="text-button" href="/api/report?format=blueprint" download>Blueprint data · JSON<ArrowDownToLine size={13} /></a><a className="text-button" href="/api/report?format=svg" download>Floor drawing · SVG<ArrowDownToLine size={13} /></a></div> : null}</div></aside></div> : null}
          {section === "findings" ? <div className={`findings-layout ${selectedFinding ? "with-detail" : ""}`}><section className="panel findings-main"><PanelHeader eyebrow="EXPLAINABLE BY DESIGN" title="Findings register" action={<button className="button button-outline button-small" disabled={!hasRooms} onClick={() => openMarker()}><Plus size={13} />Add observation</button>} /><div className="data-toolbar"><div className="filter-tabs">{[{ id: "all", label: "All findings" }, { id: "open", label: "Open" }, { id: "review", label: "In review" }, { id: "resolved", label: "Resolved" }].map(tab => <button key={tab.id} className={filter === tab.id ? "active" : ""} onClick={() => setFilter(tab.id)}>{tab.label}</button>)}</div><div className="table-controls"><label className="table-search"><Search size={14} /><input value={query} aria-label="Search findings" onChange={event => setQuery(event.target.value)} placeholder="Search findings…" /></label><label className="room-filter"><ListFilter size={14} /><select aria-label="Filter findings by room" value={roomFilter} onChange={event => setRoomFilter(event.target.value)}><option value="all">All rooms</option>{snapshot.blueprint.rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label></div></div><div className="findings-register">{filteredFindings.slice(0, 50).map((finding, index) => <button key={finding.id} className={`finding-register-row ${selectedFindingId === finding.id ? "selected" : ""}`} onClick={() => selectFinding(finding.id)}><span className={`finding-pin-number severity-${finding.severity}`}>{String(index + 1).padStart(2, "0")}</span><div><div className="finding-row-title"><strong>{finding.title}</strong><Pill tone={finding.severity}>{finding.severity}</Pill></div><p>{finding.reason}</p><span className="finding-row-meta"><span><MapPin size={12} />{snapshot.blueprint.rooms.find(room => room.id === finding.roomId)?.name}</span><span>{finding.id}</span><span>{finding.status}</span>{finding.isSample ? <span>Sample</span> : null}</span></div><ChevronRight size={16} /></button>)}</div>{!filteredFindings.length ? <EmptyState title="No findings in this view">{hasRooms ? "Try another filter, or add an observation to the spatial model." : "Start the audit to examine your scan and record evidence-backed observations."}</EmptyState> : null}<div className="register-footer"><span>{filteredFindings.length} findings · linked to the report and reference model</span><span>REVISION {snapshot.revision}</span></div></section>{selectedFinding ? <FindingDetail key={selectedFinding.id} finding={selectedFinding} snapshot={snapshot} onClose={() => setSelectedFindingId(null)} onShowIn3D={() => showIn3D(selectedFinding.id)} onUpdate={updateFinding} busy={busy} /> : <aside className="findings-intro"><div className="outline-cube"><MapPin size={30} strokeWidth={1} /></div><span className="eyebrow">THE WHOLE PICTURE</span><h2>Every flag has<br />a reason.</h2><p>Select a finding to see the expected condition, the observation, supporting evidence, and the next action.</p><div><ScanLine size={15} /><span>Jump directly to its saved location.</span></div><div><FileText size={15} /><span>Keep your report and scan in sync.</span></div></aside>}</div> : null}
          {section === "report" ? <ReportPanel snapshot={snapshot} onSelectFinding={id => { setSelectedFindingId(id); setSection("findings"); }} onShowIn3D={showIn3D} /> : null}
          {section === "inputs" ? <ProjectInputs key={snapshot.id} snapshot={snapshot} onSnapshot={acceptSnapshot} onError={fail} onNotice={notify} onReset={() => setModal("reset")} onOpenWorkspace={() => { setSection("workspace"); setSelectedFindingId(null); }} /> : null}
          {section === "activity" ? <div className="activity-layout"><section className="panel full-activity-panel"><PanelHeader eyebrow="PERSISTED INSPECTION HISTORY" title="Auditgon’s working record" action={<Pill tone={isRunning ? "green" : "neutral"}>{snapshot.status}</Pill>} /><EventList events={snapshot.events} /></section><aside><div className="agent-status-card"><span className="agent-status-icon"><Compass size={28} strokeWidth={1.2} /></span><Pill tone={isRunning ? "green" : "neutral"}>{"Auditgon"}</Pill><h2>{isRunning ? "Following the evidence." : "Ready when you are."}</h2><p>{currentItem?.label || "Each action is tied to an inspection requirement and a saved outcome."}</p><div><span>Elapsed inspection</span><strong>{elapsedLabel(snapshot.elapsedSeconds)}</strong></div><div><span>Current room</span><strong>{currentRoom?.name || "—"}</strong></div><div><span>Corrections recorded</span><strong>{snapshot.corrections}</strong></div><button className="button button-dark full-width" onClick={() => navigate("workspace")}><ScanLine size={14} />Open workspace<ArrowUpRight size={14} /></button></div><div className="inline-note">The working history connects each observation with its evidence and keeps unresolved checks visible.</div></aside></div> : null}
          <footer className="app-footer"><span><ShieldCheck size={12} />{snapshot.capabilities.persistence ? "Changes saved" : "Local workspace"}<span>·</span>Revision {snapshot.revision}</span><span>Built to look closer.<span className="footer-dot" />AUDITGON</span></footer>
        </> : null}
      </main>
    </div>
    {notice ? <div className="toast" role="status"><span><Check size={15} /></span><p>{notice}</p><button aria-label="Dismiss notification" className="icon-button" onClick={() => setNotice(null)}><X size={14} /></button></div> : null}
    {modal === "search" ? <Modal title="Search your workspace" onClose={() => { setModal(null); setQuery(""); }}><label className="global-search-input"><Search size={18} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a check, room feature, or finding…" aria-label="Search workspace" /></label><div className="global-search-results">{query.trim() ? searchResults.length ? searchResults.map(item => <button key={`${item.type}-${item.id}`} onClick={() => { setModal(null); if (item.type === "finding") { setSection("findings"); setSelectedFindingId(item.id); setQuery(""); } else { setSection("checklist"); setQuery(item.title); setFilter("all"); setRoomFilter("all"); setPage(0); } }}><span>{item.type === "finding" ? <Flag size={16} /> : <ClipboardCheck size={16} />}</span><div><strong>{item.title}</strong><small>{item.subtitle}</small></div><ArrowUpRight size={14} /></button>) : <EmptyState title="No matching records">Try a room name, feature, or finding ID.</EmptyState> : <div className="search-hint"><Command size={19} /><p>Your checks and findings, one search away.</p><span>Type to search this inspection.</span></div>}</div></Modal> : null}
    {modal === "help" ? <Modal title="Your space, understood." subtitle="Auditgon brings your scan, materials, and findings into one place." onClose={() => setModal(null)}><div className="help-steps">{[{ title: "Add your scan link", text: "Paste a 3D scan URL. Your space opens here while the original scan stays at its source.", icon: ScanLine }, { title: "Bring the context", text: "Add blueprints, photographs, and documents, or start with the scan alone.", icon: FileText }, { title: "Start the audit", text: "Auditgon examines the views and materials, generates a room model, and records evidence for its observations.", icon: Compass }, { title: "Explore the result", text: "Review the 3D blueprint, marked findings, and report. Every flag explains why it matters.", icon: MapPin }].map((step, index) => <div key={step.title}><span><step.icon size={20} strokeWidth={1.4} /></span><div><small>0{index + 1}</small><h3>{step.title}</h3><p>{step.text}</p></div></div>)}</div><div className="inline-note">Generated geometry shows what the available evidence supports. Independent measurements establish metric accuracy.</div><div className="modal-actions"><button className="button button-dark" onClick={() => { setModal(null); navigate("inputs"); }}>Add scan & materials<ArrowUpRight size={14} /></button></div></Modal> : null}
    {modal === "reset" ? <Modal title="Start a new audit project?" subtitle="Open an empty workspace for another scan and its materials." onClose={() => setModal(null)}><div className="inline-note">Export the current report if you need a copy. The new project starts without rooms, findings, or uploaded materials.</div><div className="modal-actions"><button className="button button-outline" onClick={() => setModal(null)}>Keep current project</button><button className="button button-dark" onClick={() => { setModal(null); setSelectedFindingId(null); setSelectedRoomId(null); void mutate(() => request<InspectionSnapshot>("/api/project", { method: "POST", body: JSON.stringify({}) }), "Your new project is ready.").then(saved => { if (saved) navigate("inputs"); }); }}>New project<Plus size={14} /></button></div></Modal> : null}
    {modal === "marker" && snapshot ? <ManualFindingModal snapshot={snapshot} anchor={manualAnchor} camera={manualCamera} annotationSource={manualSource} roomId={activeRoom || snapshot.blueprint.rooms[0]?.id} onClose={() => setModal(null)} onSubmit={async data => { const saved = await mutate(() => request<InspectionSnapshot>("/api/findings", { method: "POST", body: JSON.stringify(data) }), "Observation saved with its marker and report entry."); if (saved) setModal(null); return saved; }} /> : null}
  </div>;
}

function RulerIcon({ kind }: { kind: string }) { return kind === "door" || kind === "window" ? <Box size={15} /> : kind === "ceiling" ? <Layers2 size={15} /> : <Focus size={15} />; }

function ManualFindingModal({ snapshot, anchor, camera, annotationSource, roomId, onClose, onSubmit }: { snapshot: InspectionSnapshot; anchor: Vec3; camera?: {position:Vec3;target:Vec3}|null; annotationSource: "scan" | "reference"; roomId?: string; onClose: () => void; onSubmit: (value: Record<string, unknown>) => Promise<boolean> }) {
  const [selectedRoom, setSelectedRoom] = useState(roomId || "unassigned");
  const [coordinates, setCoordinates] = useState(anchor.map(String));
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [preparingImages, setPreparingImages] = useState(false);
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const evidenceInput = useRef<HTMLInputElement>(null);
  return <Modal title="Add an observation" subtitle="Save what you noticed, why it matters, and where to find it." onClose={onClose}><form className="manual-finding-form" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); const point = coordinates.map(Number); if (point.some(value => !Number.isFinite(value))) { setFormError("Enter finite numeric coordinates for the reference anchor."); return; } setFormError(""); setSaving(true); void (async () => {
      try {
        const evidenceIds: string[] = [];
        for (const file of evidenceFiles) { const body = new FormData(); body.set("kind", "reference"); body.set("file", file); const uploaded = await request<UploadRecord>("/api/uploads", { method: "POST", body }); evidenceIds.push(uploaded.id); }
        const saved = await onSubmit({ annotationSource, title: values.get("title"), roomId: selectedRoom, category: "Owner observation", severity: values.get("severity"), reason: values.get("reason"), expected: values.get("expected") || "Not specified; owner observation", observed: values.get("observed"), nextAction: values.get("nextAction") || "Review this observation and attach supporting evidence.", anchor: point, cameraPosition: camera?.position || [point[0] + 3, point[1] + 2, point[2] + 3], cameraTarget: camera?.target || point, evidenceIds, evidence: [] });
        if (!saved) setFormError("The observation could not be saved. Check the field values and connection, then try again.");
      } catch (cause) { setFormError(cause instanceof Error ? cause.message : "Evidence could not be uploaded."); }
      finally { setSaving(false); }
    })(); }}><label htmlFor="manual-title">What did you notice?</label><input id="manual-title" name="title" required maxLength={160} placeholder="e.g. Door hardware needs a closer look" /><div className="form-two-cols"><div><label htmlFor="manual-room">Room</label><select id="manual-room" value={selectedRoom} onChange={event => { setSelectedRoom(event.target.value); const center = snapshot.blueprint.rooms.find(room => room.id === event.target.value)?.center; if (center && annotationSource === "reference") setCoordinates(center.map(String)); }} required>{!snapshot.blueprint.rooms.length ? <option value="unassigned">Unassigned location</option> : null}{snapshot.blueprint.rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></div><div><label htmlFor="manual-severity">Severity</label><select id="manual-severity" name="severity"><option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option></select></div></div><label htmlFor="manual-observed">Observed condition</label><textarea id="manual-observed" name="observed" required rows={2} maxLength={1000} placeholder="Describe what is visible." /><label htmlFor="manual-reason">Why should this be flagged?</label><textarea id="manual-reason" name="reason" required rows={2} maxLength={2000} placeholder="Explain the concern and the evidence needed." /><div className="form-two-cols"><div><label htmlFor="manual-expected">Expected condition <span>Optional</span></label><input id="manual-expected" name="expected" maxLength={500} placeholder="Source requirement or intended condition" /></div><div><label htmlFor="manual-next">Next action <span>Optional</span></label><input id="manual-next" name="nextAction" maxLength={500} placeholder="What should happen next?" /></div></div><label>Supporting photos <span>Optional · up to 4</span></label><input ref={evidenceInput} type="file" accept=".jpg,.jpeg,.png,.webp" multiple className="visually-hidden" aria-label="Attach supporting photos" onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length + evidenceFiles.length > 4) { setFormError("Attach up to 4 supporting photos."); return; } setPreparingImages(true); setFormError(""); void (async () => { try { const prepared: File[] = []; for (const file of files) prepared.push(await prepareEvidenceImage(file)); setEvidenceFiles(previous => [...previous, ...prepared].slice(0, 4)); } catch (cause) { setFormError(cause instanceof Error ? cause.message : "The image could not be prepared."); } finally { setPreparingImages(false); } })(); }} /><div className="manual-evidence"><button type="button" className="button button-outline button-small" onClick={() => evidenceInput.current?.click()} disabled={saving || preparingImages || evidenceFiles.length >= 4}><BusyIcon busy={preparingImages}><Plus size={13} /></BusyIcon>{preparingImages ? "Preparing photos…" : "Attach photos"}</button><span>Resized to 1280 px before upload.</span>{evidenceFiles.map((file, index) => <div key={`${file.name}-${index}`}><FileText size={12} /><span>{file.name}</span><small>{Math.round(file.size / 1024)} KB</small><button type="button" className="icon-button" aria-label={`Remove ${file.name}`} onClick={() => setEvidenceFiles(values => values.filter((_, i) => i !== index))} disabled={saving}><X size={12} /></button></div>)}</div><label>{annotationSource === "scan" ? "Scan anchor · scene units" : snapshot.blueprint.units === "scene" ? "Reference anchor · scene units" : "Reference anchor · meters"}</label><div className="coordinate-inputs">{["X", "Y", "Z"].map((axis, index) => <label key={axis}><span>{axis}</span><input type="number" step="any" value={coordinates[index]} onChange={event => setCoordinates(values => values.map((value, i) => i === index ? event.target.value : value))} aria-label={`${axis} reference coordinate`} required /></label>)}</div><div className="inline-note">{annotationSource === "scan" ? "This location was picked from the visible scan. Its metric scale and assignment to a blueprint room may still need independent verification." : `This location belongs to the ${snapshot.blueprint.isSample ? "sample " : ""}reference frame. Registration is required to place it accurately in the remote residence scan.`}</div>{formError ? <p className="form-error" role="alert">{formError}</p> : null}<div className="modal-actions"><button className="button button-outline" type="button" onClick={onClose}>Cancel</button><button className="button button-dark" type="submit" disabled={saving || preparingImages}><BusyIcon busy={saving}><MapPin size={14} /></BusyIcon>{saving ? "Saving…" : "Save observation"}</button></div></form></Modal>;
}
