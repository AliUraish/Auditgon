"use client";

import { useEffect, useState } from "react";
import { GitCompareArrows, Minus, Plus, RotateCcw } from "lucide-react";
import type { InspectionSnapshot, RunDiff as RunDiffData } from "@/lib/contracts";
import { request } from "@/lib/client";
import { checkLabels, EmptyState, PanelHeader, Pill } from "./UI";

/** GitHub-style diff of the current run against the kept baseline. Re-fetched whenever the saved revision changes. */
export default function RunDiff({ snapshot, onSelectFinding, compact = false }: { snapshot: InspectionSnapshot; onSelectFinding?: (id: string) => void; compact?: boolean }) {
  const [diff, setDiff] = useState<RunDiffData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasBaseline = Boolean(snapshot.runHistory?.length);
  useEffect(() => {
    if (!hasBaseline) { setDiff(null); return; }
    let alive = true;
    request<RunDiffData>("/api/report?format=diff").then(value => { if (alive) { setDiff(value); setError(null); } }).catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : "The diff could not be loaded."); });
    return () => { alive = false; };
  }, [snapshot.revision, hasBaseline]);
  if (!hasBaseline) return compact ? null : <EmptyState title="No earlier run to compare">Finish an audit, then choose Re-audit. Argon re-verifies every check in place and only the changes show here.</EmptyState>;
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!diff?.available) return <EmptyState title="Comparing runs">{diff?.reason || "Loading the diff…"}</EmptyState>;
  const summary = diff.summary!;
  const rows = [...(diff.rooms || []).map(room => ({ key: "room-" + room.id, kind: room.kind, title: `${room.name} (room)`, meta: "", before: null as string | null, after: null as string | null, findingId: undefined as string | undefined })),
    ...(diff.checks || []).map(check => ({ key: "check-" + check.id, kind: check.kind, title: check.label, meta: check.room, before: check.before ? checkLabels[check.before] : null, after: check.after ? checkLabels[check.after] : null, findingId: check.findingId })),
    ...(diff.findings || []).map(finding => ({ key: "finding-" + finding.id, kind: finding.kind, title: `${finding.title} (${finding.severity} finding)`, meta: finding.room, before: finding.before, after: finding.after, findingId: finding.id }))];
  const shown = compact ? rows.slice(0, 6) : rows;
  return <div className="run-diff">
    <PanelHeader eyebrow={`RUN ${diff.baselineRun} → RUN ${diff.currentRun}`} title={rows.length ? `${rows.length} change${rows.length === 1 ? "" : "s"} since the last run` : "No changes since the last run"} action={<Pill tone={summary.stillPending ? "amber" : "green"}>{summary.stillPending ? `${summary.stillPending} still re-verifying` : "Re-verified"}</Pill>} />
    <div className="diff-summary"><span><Plus size={12} />{summary.checksAdded + summary.findingsAdded + summary.roomsAdded} added</span><span><Minus size={12} />{summary.checksRemoved + summary.findingsRemoved + summary.roomsRemoved} removed</span><span><GitCompareArrows size={12} />{summary.checksChanged + summary.findingsChanged} changed</span><span><RotateCcw size={12} />baseline {diff.baselineVerdict} → now {diff.currentVerdict}</span></div>
    {shown.length ? <div className="diff-rows">{shown.map(row => <div key={row.key} className={`diff-row diff-${row.kind}`}><span className="diff-sign">{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : "~"}</span><div><strong>{row.title}</strong>{row.meta ? <small>{row.meta}</small> : null}</div><span className="diff-states">{row.before ? <Pill>{row.before}</Pill> : null}{row.before && row.after ? <span>→</span> : null}{row.after ? <Pill tone={row.kind === "added" ? "green" : row.kind === "removed" ? "rust" : "neutral"}>{row.after}</Pill> : null}</span>{row.findingId && onSelectFinding ? <button className="text-button" onClick={() => onSelectFinding(row.findingId!)}>{row.findingId}</button> : null}</div>)}</div> : <p className="section-description">Everything re-verified so far matches the previous run.</p>}
    {compact && rows.length > shown.length ? <p className="section-description">{rows.length - shown.length} more in the report.</p> : null}
  </div>;
}
