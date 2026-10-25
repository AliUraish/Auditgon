"use client";

/* Evidence is already bounded by the capture service; direct images preserve private API URLs and SVG diagrams without an optimizer proxy. */

import { useState } from "react";
import { ArrowUpRight, CheckCheck, ChevronDown, Clock3, ExternalLink, FileImage, MapPin, MessageSquare, Ruler, ScanLine, X } from "lucide-react";
import type { Finding, FindingStatus, InspectionSnapshot } from "@/lib/contracts";
import { shortTime } from "@/lib/client";
import { BusyIcon, Pill } from "./UI";

interface Props {
  finding: Finding;
  snapshot: InspectionSnapshot;
  onClose?: () => void;
  onShowIn3D: () => void;
  onUpdate: (id: string, patch: { status?: FindingStatus; note?: string }) => Promise<void>;
  busy: boolean;
}

export default function FindingDetail({ finding, snapshot, onClose, onShowIn3D, onUpdate, busy }: Props) {
  const [note, setNote] = useState(finding.note || "");
  const [status, setStatus] = useState<FindingStatus>(finding.status);
  const room = snapshot.blueprint.rooms.find(item => item.id === finding.roomId);
  return <aside className="finding-detail">
    <header className="finding-detail-header"><span className="eyebrow">FINDING / {finding.id}</span>{onClose ? <button className="icon-button" aria-label="Close finding" onClick={onClose}><X size={16} /></button> : null}</header>
    <div className="finding-detail-body">
      <div className="finding-badges"><Pill tone={finding.severity}>{finding.severity}</Pill><Pill tone={finding.status === "resolved" ? "green" : "neutral"}>{finding.status}</Pill>{finding.isSample ? <Pill tone="sample">Sample</Pill> : null}</div>
      <h2>{finding.title}</h2><div className="finding-location"><MapPin size={13} /> {room?.name || (finding.roomId === "unassigned" ? "Unassigned location" : finding.roomId)} <span>·</span> {finding.category}</div>
      <button className="button button-dark full-width" onClick={onShowIn3D}><ScanLine size={15} /> Show in 3D <ArrowUpRight size={14} /></button>
      {finding.isSample ? <div className="inline-note">This illustrative finding belongs to the sample reference model. It is not a verified defect in the linked residence.</div> : null}
      <section className="detail-section"><h3>Why Auditgon flagged this</h3><p>{finding.reason}</p></section>
      <div className="comparison"><div><span>EXPECTED</span><p>{finding.expected}</p></div><div><span>OBSERVED</span><p>{finding.observed}</p></div></div>
      {finding.uncertainty ? <p className="uncertainty"><Ruler size={14} />{finding.uncertainty}</p> : null}
      {finding.rule ? <section className="detail-section rule-section"><h3>Source requirement</h3>{finding.rule.url ? <a href={finding.rule.url} target="_blank" rel="noreferrer">{finding.rule.label}<ExternalLink size={12} /></a> : <strong>{finding.rule.label}</strong>}<p>{finding.rule.applicability}</p></section> : null}
      <section className="detail-section"><h3>Supporting evidence <span>{finding.evidence.length}</span></h3>{finding.evidence.length ? <div className="evidence-list">{finding.evidence.map(evidence => <div className="evidence-item" key={evidence.id}>{evidence.imageUrl ? <a href={evidence.imageUrl} target="_blank" rel="noreferrer" className="evidence-image-link"><img src={evidence.imageUrl} alt={evidence.label} loading="lazy" decoding="async" /></a> : <span className="evidence-icon">{evidence.kind === "measurement" ? <Ruler size={18} /> : <FileImage size={18} />}</span>}<div><span className="eyebrow">{evidence.kind}</span><h4>{evidence.label}</h4><p>{evidence.description}</p></div></div>)}</div> : <p className="muted">No captured evidence attached. Review this observation before confirming it.</p>}</section>
      <section className="detail-section next-action"><h3><CheckCheck size={14} /> Recommended next step</h3><p>{finding.nextAction}</p></section>
      <form className="finding-review-form" onSubmit={async event => { event.preventDefault(); await onUpdate(finding.id, { status, note }); }}><label htmlFor="finding-status">Review status</label><div className="select-wrap"><select id="finding-status" value={status} onChange={event => setStatus(event.target.value as FindingStatus)}><option value="open">Open</option><option value="review">In review</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select><ChevronDown size={14} /></div><label htmlFor="finding-note"><MessageSquare size={13} /> Review note</label><textarea id="finding-note" value={note} onChange={event => setNote(event.target.value)} rows={3} placeholder="Add context, a repair update, or the reason for this decision…" maxLength={2000} /><button className="button button-outline full-width" type="submit" disabled={busy || (note === (finding.note || "") && status === finding.status)}><BusyIcon busy={busy}><CheckCheck size={14} /></BusyIcon>Save review</button></form>
      <details className="history-details"><summary><Clock3 size={13} /> Decision history <span>{finding.history.length}</span></summary>{finding.history.slice().reverse().map((entry, index) => <div key={`${entry.at}-${index}`} className="history-row"><div><strong>{entry.status}</strong><time>{shortTime(entry.at)}</time></div><p>{entry.note || "Status recorded."}</p></div>)}</details>
      <div className="coordinate-caption">{finding.annotationSource === "scan" ? "Saved scan" : finding.isSample ? "Sample reference" : "Reference"} anchor · {finding.anchor.map(value => value.toFixed(2)).join(", ")} {finding.annotationSource === "scan" || snapshot.blueprint.units === "scene" ? "scene units" : "m"}<br />Scan {snapshot.scan.version} · Report revision {snapshot.revision}</div>
    </div>
  </aside>;
}
