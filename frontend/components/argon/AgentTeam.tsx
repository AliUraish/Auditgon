"use client";

import { Bot, CheckCheck, CircleAlert, LoaderCircle } from "lucide-react";
import type { InspectionSnapshot } from "@/lib/contracts";
import { shortTime } from "@/lib/client";
import { EmptyState, PanelHeader, Pill } from "./UI";

const roleLabels = { "finish-surveyor": "Finish surveyor", "sketch-verifier": "Sketch verifier", measurer: "Measurer", "room-inspector": "Room inspector" } as const;

/** Sub-agents Argon deployed during this run, with their objective, progress, and report. */
export default function AgentTeam({ snapshot, compact = false }: { snapshot: InspectionSnapshot; compact?: boolean }) {
  const agents = (snapshot.agents || []).slice().reverse();
  const running = agents.filter(agent => agent.status === "running").length;
  return <section className="panel agent-team-panel">
    <PanelHeader eyebrow="ARGON'S TEAM" title={agents.length ? `${agents.length} sub-agent${agents.length === 1 ? "" : "s"} deployed` : "Sub-agents"} action={<Pill tone={running ? "green" : "neutral"}>{running ? `${running} working` : agents.length ? "All reported" : "None yet"}</Pill>} />
    {agents.length ? <div className="agent-team-list">{(compact ? agents.slice(0, 4) : agents).map(agent => <article key={agent.id} className={`agent-card agent-${agent.status}`}>
      <span className="agent-card-icon">{agent.status === "running" ? <LoaderCircle size={15} className="spin" /> : agent.status === "done" ? <CheckCheck size={15} /> : agent.status === "failed" ? <CircleAlert size={15} /> : <Bot size={15} />}</span>
      <div>
        <div className="agent-card-head"><strong>{roleLabels[agent.role] || agent.role}</strong><Pill tone={agent.status === "running" ? "green" : agent.status === "failed" ? "rust" : "neutral"}>{agent.status}</Pill><small>{agent.turns} turn{agent.turns === 1 ? "" : "s"} · {shortTime(agent.startedAt)}{agent.endedAt ? ` → ${shortTime(agent.endedAt)}` : ""}</small></div>
        <p className="agent-card-objective">{agent.objective}</p>
        {agent.roomId ? <small>Room: {snapshot.blueprint.rooms.find(room => room.id === agent.roomId)?.name || agent.roomId}</small> : null}
        {agent.summary ? <details className="agent-card-summary"><summary>Report</summary><p>{agent.summary}</p></details> : null}
        {agent.error ? <p className="form-error">{agent.error}</p> : null}
      </div>
    </article>)}</div> : <EmptyState title="Argon works alone until there is evidence to delegate">Once a few views are captured, Argon deploys finish surveyors, a sketch verifier, a measurer, and room inspectors that work in parallel on the saved captures.</EmptyState>}
  </section>;
}
