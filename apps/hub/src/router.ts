import { useEffect, useState } from "react";

export type ProjectTab = "overview" | "board" | "milestones" | "artifacts" | "activity" | "decisions" | "agents" | "members" | "settings";
const TABS: readonly ProjectTab[] = ["overview", "board", "milestones", "artifacts", "activity", "decisions", "agents", "members", "settings"];

export type Route =
  | { name: "projects" }
  | { name: "project"; id: string; tab: ProjectTab; taskId?: string; artifactId?: string }
  | { name: "invite"; token: string }
  | { name: "devices" }
  | { name: "device-code"; code: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "projects" && parts[1]) {
    const tab = TABS.includes(parts[2] as ProjectTab) ? (parts[2] as ProjectTab) : "overview";
    if (parts[2] === "tasks" && parts[3]) return { name: "project", id: parts[1], tab: "board", taskId: parts[3] };
    if (parts[2] === "artifacts" && parts[3]) return { name: "project", id: parts[1], tab: "artifacts", artifactId: parts[3] };
    return { name: "project", id: parts[1], tab };
  }
  if (parts[0] === "invite" && parts[1]) return { name: "invite", token: parts[1] };
  if (parts[0] === "devices") return { name: "devices" };
  if (parts[0] === "device") return { name: "device-code", code: parts[1] ?? "" };
  return { name: "projects" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(path: string): void {
  location.hash = path;
}
