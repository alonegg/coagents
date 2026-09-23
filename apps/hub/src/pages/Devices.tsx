import type { DeviceView, SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, formatTime } from "../api.js";

export function DevicesPage({ session }: { session: SessionView }) {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ devices: DeviceView[] }>("GET", "/devices").then((r) => setDevices(r.devices), (e: ApiError) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function revoke(d: DeviceView) {
    try {
      await api("DELETE", `/devices/${d.id}`);
      if (d.current) location.reload();
      else load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <>
      <h1>我的设备</h1>
      <p className="muted">撤销设备会立即结束该设备上的登录；其他设备不受影响。</p>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>设备</th><th>类型</th><th>最近活动</th><th /></tr></thead>
        <tbody>
          {devices?.map((d) => (
            <tr key={d.id}>
              <td>{d.label}{d.current && <span className="badge">当前</span>}</td>
              <td>{d.kind === "browser" ? "浏览器" : "Connector"}</td>
              <td>{formatTime(d.last_seen_at, session.user.timezone)}</td>
              <td><button className="link danger" onClick={() => revoke(d)}>撤销</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
