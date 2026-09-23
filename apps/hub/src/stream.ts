import { useEffect, useRef, useState } from "react";

export type LiveState = "connecting" | "live" | "reconnecting" | "revoked";

// Subscribes to a server-sent event stream. The browser resumes with Last-Event-ID after drops.
// On "revoked" the stream is closed for good and the caller shows why.
export function useEventStream(url: string | null, eventName: string, onMessage: (data: unknown) => void): LiveState {
  const [state, setState] = useState<LiveState>("connecting");
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    if (!url) return;
    setState("connecting");
    const es = new EventSource(url, { withCredentials: true });
    es.addEventListener("ready", () => setState("live"));
    es.addEventListener(eventName, (e) => handler.current(JSON.parse((e as MessageEvent<string>).data)));
    es.addEventListener("revoked", () => {
      setState("revoked");
      es.close();
    });
    es.onerror = () => setState((s) => (s === "revoked" ? s : "reconnecting"));
    return () => es.close();
  }, [url, eventName]);

  return state;
}

export const LIVE_LABEL: Record<LiveState, string> = {
  connecting: "连接中",
  live: "实时",
  reconnecting: "连接中断，正在重连（期间每 30 秒轮询）",
  revoked: "访问已被撤销，请刷新页面",
};
