import { useEffect, useState } from "react";

export type ProjectTab = "board" | "activity" | "decisions" | "agents" | "members";
const TABS: readonly ProjectTab[] = ["board", "activity", "decisions", "agents", "members"];

export type Route =
  | { name: "projects" }
  | { name: "project"; id: string; tab: ProjectTab; taskId?: string }
  | { name: "invite"; token: string }
  | { name: "devices" }
  | { name: "device-code"; code: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "projects" && parts[1]) {
    const tab = TABS.includes(parts[2] as ProjectTab) ? (parts[2] as ProjectTab) : "board";
    return parts[2] === "tasks" && parts[3]
      ? { name: "project", id: parts[1], tab: "board", taskId: parts[3] }
      : { name: "project", id: parts[1], tab };
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
