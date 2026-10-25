"use client";

import { useId } from "react";
import type { InspectionSnapshot } from "@/lib/contracts";

interface Props {
  snapshot: InspectionSnapshot;
  selectedRoomId?: string | null;
  selectedFindingId?: string | null;
  onSelectRoom?: (id: string) => void;
  onSelectFinding?: (id: string) => void;
  showPath?: boolean;
  expanded?: boolean;
}

export default function FloorPlan({ snapshot, selectedRoomId, selectedFindingId, onSelectRoom, onSelectFinding, showPath = true, expanded = false }: Props) {
  const patternId = useId().replaceAll(":", "");
  if (!snapshot.blueprint.rooms.length) return <div className="plan-generation-empty"><MapIcon /><h3>{snapshot.status === "running" ? "Discovering the space" : "Your room map starts here"}</h3><p>{snapshot.status === "running" ? "Rooms and coverage appear as Auditgon examines the scan." : "Start the audit to generate rooms, connected spaces, and a coverage map."}</p></div>;
  const points = snapshot.blueprint.rooms.flatMap(room => room.polygon);
  const minX = Math.min(0, ...points.map(point => point[0]));
  const maxX = Math.max(10, ...points.map(point => point[0]));
  const minZ = Math.min(0, ...points.map(point => point[1]));
  const maxZ = Math.max(8, ...points.map(point => point[1]));
  const scale = 32, pad = 34;
  const width = (maxX - minX) * scale + pad * 2, height = (maxZ - minZ) * scale + pad * 2;
  const x = (value: number) => pad + (value - minX) * scale;
  const z = (value: number) => pad + (value - minZ) * scale;
  const activate = (event: React.KeyboardEvent, action: () => void) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); action(); }
  };
  return (
    <div className={`floorplan ${expanded ? "floorplan-expanded" : ""}`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${snapshot.blueprint.isSample ? "Illustrative sample" : "Reference"} floor plan. Select a room or finding.`}>
        <defs><pattern id={patternId} width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".6" fill="#3e3e3e" /></pattern></defs>
        <rect width={width} height={height} fill={`url(#${patternId})`} />
        {snapshot.blueprint.rooms.map(room => {
          const fill = room.id === selectedRoomId ? "#3b3b3b" : "#222222";
          const xs = room.polygon.map(point => point[0]), zs = room.polygon.map(point => point[1]);
          const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
          return <g key={room.id} role="button" tabIndex={0} aria-label={`Select ${room.name}`} onClick={() => onSelectRoom?.(room.id)} onKeyDown={event => activate(event, () => onSelectRoom?.(room.id))} className="plan-room">
            <polygon points={room.polygon.map(point => `${x(point[0])},${z(point[1])}`).join(" ")} fill={fill} stroke={room.id === selectedRoomId ? "#b6b6b6" : "#5f5f5f"} strokeWidth={room.id === selectedRoomId ? 2 : 1.5} strokeLinejoin="round" />
            <text x={x(cx)} y={z(cz) - 4} textAnchor="middle" fill="#d9d9d9" fontSize={expanded ? "11" : "12"} fontWeight="500">{room.name}</text>
            <text x={x(cx)} y={z(cz) + 10} textAnchor="middle" fill="#9b9b9b" fontSize="9">{(snapshot.blueprint.metricStatus === "unmeasured" || snapshot.blueprint.units === "scene") ? "Unmeasured" : room.area ? `${room.area} m²` : room.level}</text>
          </g>;
        })}
        {snapshot.blueprint.features.map(feature => feature.kind === "island" ? <rect key={feature.id} x={x(feature.position[0]) - (feature.dimensions?.[0] || 1.2) * scale / 2} y={z(feature.position[2]) - (feature.dimensions?.[2] || .7) * scale / 2} width={(feature.dimensions?.[0] || 1.2) * scale} height={(feature.dimensions?.[2] || .7) * scale} rx="2" fill="#3d3d3d" stroke="#828282" strokeWidth="1" /> : feature.kind === "window" ? <line key={feature.id} x1={x(feature.position[0]) - 8} y1={z(feature.position[2])} x2={x(feature.position[0]) + 8} y2={z(feature.position[2])} stroke="#8b8b8b" strokeWidth="3" /> : null)}
        {showPath && snapshot.path.length > 1 ? <polyline points={snapshot.path.map(point => `${x(point[0])},${z(point[2])}`).join(" ")} fill="none" stroke="#bebebe" strokeWidth="1.5" strokeDasharray="4 4" opacity=".8" /> : null}
        {showPath && snapshot.blueprint.coordinateFrame === "scan" && (snapshot.trail || []).length > 1 ? <polyline points={(snapshot.trail || []).map(point => `${x(point[0])},${z(point[2])}`).join(" ")} fill="none" stroke="#8a8a8a" strokeWidth="1" strokeDasharray="2 3" /> : null}
        {snapshot.findings.filter(finding => finding.status !== "dismissed").map((finding, index) => <g key={finding.id} role="button" tabIndex={0} aria-label={`Finding ${index + 1}: ${finding.title}`} onClick={event => { event.stopPropagation(); onSelectFinding?.(finding.id); }} onKeyDown={event => activate(event, () => onSelectFinding?.(finding.id))} className="plan-finding">
          {finding.region ? <polygon points={finding.region.map(point => `${x(point[0])},${z(point[2])}`).join(" ")} fill="#ffffff22" stroke="#d0d0d0" strokeWidth="1.5" /> : null}
          {finding.endAnchor ? <line x1={x(finding.anchor[0])} y1={z(finding.anchor[2])} x2={x(finding.endAnchor[0])} y2={z(finding.endAnchor[2])} stroke="#ffffff" strokeWidth="2" /> : null}
          {finding.endAnchor && finding.measurement ? <text x={(x(finding.anchor[0]) + x(finding.endAnchor[0])) / 2} y={(z(finding.anchor[2]) + z(finding.endAnchor[2])) / 2 - 6} textAnchor="middle" fill="#ffffff" fontSize="8">≈ {finding.measurement.value} {finding.measurement.units === "m" ? "m" : "su"}</text> : null}
          <circle cx={x(finding.anchor[0])} cy={z(finding.anchor[2])} r={selectedFindingId === finding.id ? 10 : 8} fill={finding.status === "resolved" ? "#5e5e5e" : finding.severity === "critical" ? "#ffffff" : "#a8a8a8"} stroke="#0a0a0a" strokeWidth="2" />
          <text x={x(finding.anchor[0])} y={z(finding.anchor[2]) + 3} textAnchor="middle" fill={finding.severity === "critical" && finding.status !== "resolved" ? "#0a0a0a" : "#ffffff"} fontSize="8" fontWeight="600">{index + 1}</text>
        </g>)}
        {snapshot.path.length ? <g><circle cx={x(snapshot.path[snapshot.path.length - 1][0])} cy={z(snapshot.path[snapshot.path.length - 1][2])} r="7" fill="#dcdcdc" opacity=".35" /><circle cx={x(snapshot.path[snapshot.path.length - 1][0])} cy={z(snapshot.path[snapshot.path.length - 1][2])} r="3" fill="#dadada" /></g> : null}
        <g transform={`translate(${width - 19},17)`}><path d="M0 16V0m-3 4L0 0l3 4" fill="none" stroke="#9f9f9f" strokeWidth="1" /><text y="26" textAnchor="middle" fontSize="8" fill="#9f9f9f">N</text></g>
      </svg>
      <div className="plan-caption"><span>{snapshot.blueprint.isSample ? "ILLUSTRATIVE REFERENCE" : snapshot.blueprint.generatedFrom === "scan" ? "SCAN UNDERSTANDING" : snapshot.blueprint.revision}</span><span>{(snapshot.blueprint.metricStatus === "unmeasured" || snapshot.blueprint.units === "scene") ? "UNMEASURED GEOMETRY" : "DESIGN DIMENSIONS · M"}</span></div>
    </div>
  );
}

function MapIcon() { return <svg className="plan-generation-icon" width="33" height="33" viewBox="0 0 33 33" fill="none" aria-hidden="true"><path d="M4 7.5L12 4l9 4 8-3v22l-8 3-9-4-8 3V7.5Z" stroke="currentColor" strokeWidth="1.2"/><path d="M12 4v22M21 8v22" stroke="currentColor" strokeWidth="1.2"/><circle cx="16.5" cy="15.5" r="3" stroke="currentColor" strokeWidth="1.2"/></svg>; }
