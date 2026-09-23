import { useEffect, useState } from "react";

// A tab opened before a deploy keeps running the old Hub. Compare our build with the server's and
// offer a reload instead of silently mixing versions.
export function VersionBanner() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const ours = import.meta.env.VITE_COAGENTS_BUILD as string | undefined;
    if (!ours) return;
    const check = () =>
      fetch("/v1/health", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ build?: string }>)
        .then((h) => setStale(Boolean(h.build) && h.build !== ours), () => undefined);
    void check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, []);
  if (!stale) return null;
  return (
    <p className="notice" role="status">
      CoAgents Hub 已更新。<button className="link" onClick={() => location.reload()}>刷新页面</button>以使用新版本（未提交的输入请先复制保存）。
    </p>
  );
}
