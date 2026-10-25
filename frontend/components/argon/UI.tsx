"use client";

import { useEffect, useId, useRef } from "react";
import { Activity, ArrowUpRight, Check, CheckCheck, Circle, CircleAlert, Code2, Compass, LoaderCircle, MapPin, Ruler, ScanLine, X } from "lucide-react";
import type { CheckStatus, InspectionEvent, InspectionSnapshot } from "@/lib/contracts";
import { elapsedLabel, inspectionStats, shortTime } from "@/lib/client";

export const checkLabels: Record<CheckStatus, string> = { pending: "Not inspected", observing: "Inspecting", pass: "Verified", finding: "Flagged", blocked: "Needs evidence" };

export function StatusIcon({ status }: { status: CheckStatus }) {
  const Icon = status === "pass" ? Check : status === "finding" ? CircleAlert : status === "blocked" ? CircleAlert : status === "observing" ? ScanLine : Circle;
  return <Icon size={15} className={`status-icon status-${status}`} aria-hidden="true" />;
}

export function Pill({ children, tone = "neutral", className = "" }: { children: React.ReactNode; tone?: string; className?: string }) {
  return <span className={`pill pill-${tone} ${className}`}>{children}</span>;
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><ScanLine size={24} strokeWidth={1.3} /></div><h3>{title}</h3>{children ? <p>{children}</p> : null}{action}</div>;
}

export function PanelHeader({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: React.ReactNode }) {
  return <div className="panel-heading"><div>{eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}<h2>{title}</h2></div>{action}</div>;
}

export function Metrics({ snapshot }: { snapshot: InspectionSnapshot }) {
  const stats = inspectionStats(snapshot);
  return <div className="metrics-strip">
    <div className="metric coverage-metric"><span className="metric-label">Verified coverage</span><div><strong>{stats.percent}<em>%</em></strong><span className="coverage-track"><span style={{ width: `${stats.percent}%` }} /></span></div><span className="metric-caption">{stats.verified} of {stats.total} checks verified</span></div>
    <div className="metric"><span className="metric-label"><CheckCheck size={13} /> Accounted for</span><strong>{stats.accounted}<em> / {stats.total}</em></strong><span className="metric-caption">Includes blocked checks</span></div>
    <div className="metric"><span className="metric-label"><MapPin size={13} /> Findings</span><strong className={stats.openFindings.length ? "text-rust" : ""}>{stats.openFindings.length.toString().padStart(2, "0")}</strong><span className="metric-caption">Open & awaiting review</span></div>
    <div className="metric"><span className="metric-label"><CircleAlert size={13} /> Needs evidence</span><strong>{stats.blocked.toString().padStart(2, "0")}</strong><span className="metric-caption">Additional capture required</span></div>
    <div className="metric"><span className="metric-label"><Activity size={13} /> Inspection time</span><strong className="tabular">{elapsedLabel(snapshot.elapsedSeconds)}</strong><span className="metric-caption">{snapshot.corrections} recorded correction{snapshot.corrections === 1 ? "" : "s"}</span></div>
  </div>;
}

const eventIcons = { plan: Compass, navigate: MapPin, measure: Ruler, finding: CircleAlert, verify: CheckCheck, code: Code2, system: Activity };

export function EventList({ events, compact = false }: { events: InspectionEvent[]; compact?: boolean }) {
  if (!events.length) return <EmptyState title="Ready for the first step">Auditgon’s decisions and supporting evidence will appear here.</EmptyState>;
  return <div className={`event-list ${compact ? "event-list-compact" : ""}`}>
    {events.slice().reverse().slice(0, compact ? 5 : 30).map(event => {
      const Icon = eventIcons[event.kind];
      return <div className="event-row" key={event.id}><span className={`event-symbol event-${event.kind}`}><Icon size={14} /></span><div className="event-copy"><div><h3>{event.title}</h3><time>{shortTime(event.at)}</time></div><p>{event.detail}</p>{event.code ? <details className="code-details"><summary><Code2 size={12} /> View {event.isSample ? "sample " : "generated "}script <ArrowUpRight size={12} /></summary><pre><code>{event.code}</code></pre>{event.output ? <div className="code-output">{event.output}</div> : null}</details> : null}</div></div>;
    })}
  </div>;
}

export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => { dialog?.close(); }; }, []);
  return <dialog ref={ref} className={`argon-modal ${wide ? "modal-wide" : ""}`} aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === ref.current) onClose(); }}><div className="modal-shell"><header><div><h2 id={id}>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div><button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></header>{children}</div></dialog>;
}

export function BusyIcon({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return busy ? <LoaderCircle size={15} className="spin" /> : children;
}
