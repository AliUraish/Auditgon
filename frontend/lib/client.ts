import type { ApiError, InspectionSnapshot } from "./contracts";

export class RequestError extends Error {
  constructor(message: string, public code?: string, public status?: number) {
    super(message);
    this.name = "RequestError";
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const details = result && typeof result === "object" ? result as Partial<ApiError> : {};
    throw new RequestError(details.error || `The request could not be completed (${response.status}).`, details.code, response.status);
  }
  return result as T;
}

export function runAction(action: "start" | "pause" | "resume" | "reset" | "advance" | "finalize", mode?: "demo" | "managed") {
  return request<InspectionSnapshot>("/api/inspection", { method: "POST", body: JSON.stringify({ action, mode }) });
}

export function elapsedLabel(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function shortTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function inspectionStats(snapshot: InspectionSnapshot) {
  const total = snapshot.checklist.length;
  const passed = snapshot.checklist.filter(item => item.status === "pass").length;
  const flagged = snapshot.checklist.filter(item => item.status === "finding").length;
  const blocked = snapshot.checklist.filter(item => item.status === "blocked").length;
  const verified = passed + flagged;
  const accounted = verified + blocked;
  const openFindings = snapshot.findings.filter(finding => finding.status !== "resolved" && finding.status !== "dismissed");
  return { total, passed, flagged, blocked, verified, accounted, openFindings, percent: total ? Math.round(100 * verified / total) : 0 };
}
