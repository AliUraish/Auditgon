"use client";

import { useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Box, ChevronDown, CloudUpload, FileText, Layers2, Link2, MapPin, Play, Plus, ScanLine, ShieldCheck, X } from "lucide-react";
import type { BlueprintModel, InspectionSnapshot, UploadRecord } from "@/lib/contracts";
import { RESOURCE_LIMITS } from "@/lib/contracts";
import { request, runAction } from "@/lib/client";
import { prepareEvidenceImage } from "@/lib/evidence-image";
import { BusyIcon, PanelHeader, Pill } from "./UI";

type Material = { id: string; file: File; kind: "blueprint" | "reference" | "scan" };
interface Props {
  snapshot: InspectionSnapshot;
  onSnapshot: (value: InspectionSnapshot) => void;
  onError: (value: string) => void;
  onNotice: (value: string) => void;
  onReset: () => void;
  onOpenWorkspace: () => void;
}

export default function ProjectInputs({ snapshot, onSnapshot, onError, onNotice, onReset, onOpenWorkspace }: Props) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [sceneUrl, setSceneUrl] = useState(() => /^https?:\/\//i.test(snapshot.scan.sourceUrl) ? snapshot.scan.sourceUrl : /^https?:\/\//i.test(snapshot.scan.assetUrl || "") ? snapshot.scan.assetUrl! : "");
  const [projectName, setProjectName] = useState(snapshot.scan.configured ? snapshot.name : "");
  const [scale, setScale] = useState(String(snapshot.scan.scale || 1));
  const [calibrated, setCalibrated] = useState(snapshot.scan.calibrated);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hasSource = snapshot.scan.configured ?? Boolean(snapshot.scan.sourceUrl || snapshot.scan.assetUrl);
  const hasRooms = snapshot.blueprint.rooms.length > 0;
  const hasQueuedScan = materials.some(item => item.kind === "scan");

  async function selectFiles(files: File[]) {
    if (files.filter(file => /\.(sog|ply)$/i.test(file.name)).length + materials.filter(item => item.kind === "scan").length > 1) { onError("Attach one compact 3D scan per project. Use the link field for larger remote scenes."); return; }
    if (files.length + materials.length > 12) { onError("Add up to 12 project materials at a time."); return; }
    setBusy("preparing");
    try {
      const next: Material[] = [];
      for (const original of files) {
        if (!/\.(pdf|png|jpe?g|webp|json|txt|md|csv|sog|ply)$/i.test(original.name)) throw new Error("Choose a plan, image, document, or a .sog / .ply scan.");
        const scanFile = /\.(sog|ply)$/i.test(original.name);
        const byteLimit = scanFile ? RESOURCE_LIMITS.maxUploadBytes : RESOURCE_LIMITS.maxBlueprintBytes;
        if (original.size > byteLimit) throw new Error(scanFile ? "Scan uploads must be 32 MB or smaller. Use a remote scan link for a larger scene." : `${original.name} is larger than 10 MB. Choose a smaller file or a focused drawing sheet.`);
        const file = scanFile ? new File([original], original.name, { type: "application/octet-stream" }) : /\.(txt|md|csv)$/i.test(original.name) ? new File([original], original.name, { type: "text/plain" }) : /\.json$/i.test(original.name) ? new File([original], original.name, { type: "application/json" }) : /\.pdf$/i.test(original.name) ? new File([original], original.name, { type: "application/pdf" }) : /\.(png|jpe?g|webp)$/i.test(original.name) ? await prepareEvidenceImage(original) : original;
        let kind: Material["kind"] = scanFile ? "scan" : /\.pdf$/i.test(original.name) ? "blueprint" : "reference";
        if (/\.json$/i.test(original.name) && file.size <= 1024 * 1024) {
          try { const parsed = JSON.parse(await file.text()); const model = parsed?.blueprint || parsed; if (Array.isArray(model?.rooms) && Array.isArray(model?.features)) kind = "blueprint"; }
          catch { /* A note attachment stays available as a reference even when it is not a drawing model. */ }
        }
        next.push({ id: crypto.randomUUID(), file, kind });
      }
      setMaterials(previous => [...previous, ...next]);
    } catch (cause) { onError(cause instanceof Error ? cause.message : "The materials could not be prepared."); }
    finally { setBusy(null); }
  }

  async function prepareProject(startAudit: boolean) {
    if (busy) return;
    let source: URL | null = null;
    try { if (sceneUrl.trim()) { source = new URL(sceneUrl.trim()); if (!["https:", "http:"].includes(source.protocol)) throw new Error(); } else if (!hasQueuedScan && !hasSource) throw new Error(); }
    catch { onError("Paste a valid 3D scan link or attach a supported scan file to open your space."); return; }
    setBusy(startAudit ? "audit" : "open");
    try {
      const numericScale = Number(scale);
      if (!Number.isFinite(numericScale) || numericScale <= 0) throw new Error("The optional scale must be a positive number.");
      let next = snapshot;
      if (!hasQueuedScan) {
        const savedSource = snapshot.scan.sourceUrl || snapshot.scan.assetUrl || "";
        const normalizedSavedSource = /^https?:\/\//i.test(savedSource) ? new URL(savedSource).href : savedSource;
        const sourceChanged = source && source.href !== normalizedSavedSource;
        next = await request<InspectionSnapshot>("/api/scene", { method: "PATCH", body: JSON.stringify({ ...(source && sourceChanged ? { sourceUrl: source.href } : {}), ...(projectName.trim() ? { name: projectName.trim() } : {}), scale: numericScale, calibrated }) });
        onSnapshot(next);
      }
      const orderedMaterials = [...materials.filter(item => item.kind === "scan"), ...materials.filter(item => item.kind !== "scan")];
      for (const material of orderedMaterials) {
        setBusy(`Uploading ${material.file.name}`);
        const body = new FormData(); body.set("kind", material.kind); body.set("file", material.file);
        const uploaded = await request<UploadRecord>("/api/uploads", { method: "POST", body });
        if (material.kind === "scan") { next = await request<InspectionSnapshot>("/api/scene", { method: "PATCH", body: JSON.stringify({ assetUrl: uploaded.url, ...(projectName.trim() ? { name: projectName.trim() } : {}), scale: numericScale, calibrated }) }); onSnapshot(next); }
        if (material.kind === "blueprint" && /\.json$/i.test(material.file.name)) {
          const parsed = JSON.parse(await material.file.text());
          const blueprint = { ...(parsed.blueprint || parsed), sourceUploadId: uploaded.id } as BlueprintModel;
          next = await request<InspectionSnapshot>("/api/blueprint", { method: "POST", body: JSON.stringify({ blueprint }) });
        }
        setMaterials(previous => previous.filter(item => item.id !== material.id));
      }
      next = await request<InspectionSnapshot>("/api/inspection");
      onSnapshot(next);
      if (startAudit) {
        setBusy("Starting audit");
        const started = await runAction("start", "managed");
        onSnapshot(started); onNotice("Audit started. Auditgon is examining your scan and materials.");
      } else onNotice("Your scan is ready in the workspace. Start the audit whenever you’re ready.");
      onOpenWorkspace();
    } catch (cause) { onError(cause instanceof Error ? cause.message : "The project could not be opened."); }
    finally { setBusy(null); }
  }

  return <div className="inputs-layout audit-inputs-layout">
    <div className="input-main">
      <section className="panel input-section scan-input-section">
        <div className="input-intro"><span className="input-hero-icon"><ScanLine size={27} strokeWidth={1.3} /></span><span className="eyebrow">YOUR SPACE, UNDERSTOOD</span><h2>Drop in a scan.<br />We’ll look closer.</h2><p>A 3D scan link is all you need to begin. Add plans, photos, documents, or a compact scan file for a more informed audit.</p></div>
        <form onSubmit={event => { event.preventDefault(); void prepareProject(false); }} className="audit-source-form">
          <label htmlFor="project-name">Project name <span>Optional</span></label><input id="project-name" value={projectName} onChange={event => setProjectName(event.target.value)} maxLength={160} placeholder="Give this space a name" />
          <label htmlFor="scene-url">3D scan link</label><div className="scan-url-field"><Link2 size={17} /><input id="scene-url" value={sceneUrl} type="url" onChange={event => setSceneUrl(event.target.value)} placeholder="https://superspl.at/scene/…" required={!hasQueuedScan && !hasSource} /></div><p className="field-hint">The scan opens here in Auditgon. Its source stays remote.</p>
          <details className="advanced-source"><summary>Advanced measurement settings<ChevronDown size={13} /></summary><div className="form-two-cols"><div><label htmlFor="scene-scale">Meters per scene unit</label><input id="scene-scale" type="number" min="0.000001" step="any" value={scale} onChange={event => setScale(event.target.value)} /></div><div><label>Coordinate frame</label><div className="static-input">{snapshot.scan.version}</div></div></div><label className="checkbox-label"><input type="checkbox" checked={calibrated} onChange={event => setCalibrated(event.target.checked)} /><span>Scale was calibrated against independent physical measurements.</span></label><p className="field-hint">Generated geometry remains unmeasured until independent calibration establishes metric accuracy.</p></details>
          <div className="audit-input-actions"><button className="button button-outline" type="submit" disabled={!!busy || (!sceneUrl.trim() && !hasQueuedScan && !hasSource)}><BusyIcon busy={busy === "open"}><Box size={15} /></BusyIcon>Open scan here</button><button className="button button-dark" type="button" disabled={!!busy || (!sceneUrl.trim() && !hasQueuedScan && !hasSource)} onClick={() => void prepareProject(true)}><BusyIcon busy={busy === "audit" || (busy !== null && busy !== "open" && busy !== "preparing")}><Play size={14} fill="currentColor" /></BusyIcon>{busy && busy !== "preparing" ? busy.startsWith("Uploading") ? "Saving materials…" : "Preparing audit…" : "Start audit"}<ArrowRight size={14} /></button></div>
        </form>
      </section>
      <section className="panel input-section"><PanelHeader eyebrow="OPTIONAL CONTEXT" title="Add your materials" action={<Pill>{materials.length + snapshot.uploads.length} files</Pill>} /><p className="section-description">Blueprints describe the intended design. Photos and documents add the detail a scan may not capture. You can also audit with the scan alone.</p>
        <input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.json,.txt,.md,.csv,.sog,.ply" multiple className="visually-hidden" aria-label="Add plans photos or documents" onChange={event => { void selectFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
        <button className={`upload-zone ${dragging ? "is-dragging" : ""}`} type="button" disabled={!!busy} onClick={() => input.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) void selectFiles(Array.from(event.dataTransfer.files)); }}><span className="upload-icon"><BusyIcon busy={busy === "preparing"}><CloudUpload size={23} strokeWidth={1.4} /></BusyIcon></span><strong>{busy === "preparing" ? "Preparing your materials…" : "Drop plans, photos, or documents"}</strong><span>or click to choose files</span><small>PLANS, IMAGES & DOCS UP TO 10 MB · SOG / PLY SCANS UP TO 32 MB</small></button>
        {materials.length ? <div className="queued-materials">{materials.map(material => <div key={material.id}><FileText size={16} /><div><strong>{material.file.name}</strong><span>{(material.file.size / 1024 / 1024).toFixed(2)} MB · Ready to upload</span></div><select aria-label={`Material type for ${material.file.name}`} value={material.kind} onChange={event => setMaterials(previous => previous.map(item => item.id === material.id ? { ...item, kind: event.target.value as Material['kind'] } : item))} disabled={!!busy || material.kind === "scan"}><option value="blueprint">Blueprint</option><option value="reference">Reference</option>{material.kind === "scan" ? <option value="scan">3D scan</option> : null}</select><button className="icon-button" type="button" aria-label={`Remove ${material.file.name}`} onClick={() => setMaterials(previous => previous.filter(item => item.id !== material.id))} disabled={!!busy}><X size={14} /></button></div>)}</div> : null}
        {snapshot.uploads.length ? <div className="uploaded-files"><h3>Project materials</h3>{snapshot.uploads.slice(-20).reverse().map(upload => <a href={upload.url} target="_blank" rel="noreferrer" key={upload.id}><FileText size={14} /><span>{upload.filename}</span><Pill>{upload.kind}</Pill><small>{(upload.size / 1024).toFixed(0)} KB</small><ArrowUpRight size={13} /></a>)}</div> : null}
        {materials.length ? <p className="field-hint">Your queued files are saved when you open the scan or start the audit.</p> : null}
      </section>
    </div>
    <aside className="input-side">
      <section className="audit-deliverables"><span className="eyebrow">WHAT YOU GET</span><h3>From scan to<br />clear next steps.</h3><div><MapPin size={18} /><span><strong>Room by room understanding</strong><small>A spatial model built from the available evidence.</small></span></div><div><Layers2 size={18} /><span><strong>3D blueprint</strong><small>See the space and the areas needing attention.</small></span></div><div><ScanLine size={18} /><span><strong>Findings in the scan</strong><small>Marked locations with the reason, evidence, and next action.</small></span></div><div><FileText size={18} /><span><strong>A useful audit report</strong><small>Your findings, organized and ready to share.</small></span></div></section>
      {hasSource ? <section className="panel input-section"><PanelHeader title="Current project" /><div className="current-project-source"><Link2 size={16} /><a href={snapshot.scan.sourceUrl || snapshot.scan.assetUrl || "#"} target="_blank" rel="noreferrer">{snapshot.scan.name || snapshot.name}<ArrowUpRight size={12} /></a></div><p className="field-hint">{hasRooms ? `${snapshot.blueprint.rooms.length} rooms · ${snapshot.blueprint.features.length} features` : "Rooms and geometry will be generated during the audit."}</p><button type="button" className="button button-outline full-width" onClick={onOpenWorkspace}><Box size={14} />Open workspace<ArrowUpRight size={13} /></button></section> : null}
      <section className="memory-card"><div><ShieldCheck size={18} /><h3>Light on your device</h3></div><p>The scan streams from its source. Materials upload one at a time, and images are resized before they are stored.</p><ul><li>One live 3D viewer at a time</li><li>No scene binary added to your project</li><li>Saved findings and evidence stay linked</li></ul></section>
      {hasSource ? <section className="reset-section"><h3>Another space to audit?</h3><p>Create an empty project for a new scan and its materials. Export this report first if you need a copy.</p><button type="button" className="text-button" onClick={onReset}><Plus size={12} />New audit project<ArrowUpRight size={12} /></button></section> : null}
    </aside>
  </div>;
}
