import { useEffect, useState } from "react";

type Health = { status: string; version: string; schema_version: number };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/v1/health")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setHealth, (e: Error) => setError(e.message));
  }, []);

  return (
    <main>
      <h1>CoAgents Hub</h1>
      {error && <p>连接中断：{error}</p>}
      {health && (
        <p>
          服务 {health.version}，数据结构版本 {health.schema_version}
        </p>
      )}
      {!health && !error && <p>连接中…</p>}
    </main>
  );
}
