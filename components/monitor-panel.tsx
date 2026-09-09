"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live monitor of every outbound API call that can reach Real's servers.
 * Toggled from the footer ("on" word). Entries are pushed via logMonitor()
 * from the call sites (dashboard lookup, deals/OTD scans).
 *
 * Classification per entry:
 *   - ok=false + blocked (sentToReal=false): our own route refused the
 *     request (e.g. invalid season) — nothing was sent to Real.
 *   - sentToReal=true: the request did reach Real's servers (2xx = fine,
 *     anything else = Real/server error surfaced).
 *   - ok=null: request in flight.
 */

export interface MonitorEntry {
  id: number;
  t: string;
  tag: string; // "deals" | "dashboard"
  label: string; // sport/season or user summary
  status: number | null; // HTTP status, null = network failure
  sentToReal: boolean;
  ok: boolean | null; // null = pending
  msg?: string;
}

let seq = 0;
const EVT = "ra-monitor";

export function logMonitor(e: Omit<MonitorEntry, "id" | "t">) {
  try {
    window.dispatchEvent(
      new CustomEvent(EVT, {
        detail: {
          ...e,
          id: ++seq,
          t: new Date().toLocaleTimeString([], { hour12: false }),
        },
      })
    );
  } catch {
    /* SSR / pre-hydration — ignore */
  }
}

export default function MonitorPanel() {
  const [entries, setEntries] = useState<MonitorEntry[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const on = (ev: Event) => {
      const e = (ev as CustomEvent<MonitorEntry>).detail;
      setEntries((cur) => [...cur.slice(-199), e]);
    };
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const errors = entries.filter((e) => e.ok === false).length;

  return (
    <aside className="monitor">
      <div className="monitor-head">
        <span className="monitor-title">
          monitor
          <span
            className={`monitor-dot ${
              entries.length === 0 ? "" : errors > 0 ? "bad" : "good"
            }`}
          />
        </span>
        <button
          type="button"
          className="monitor-clear"
          onClick={() => setEntries([])}
          aria-label="clear monitor"
        >
          clear
        </button>
      </div>
      <div className="monitor-body" ref={bodyRef}>
        {entries.length === 0 && (
          <p className="monitor-empty">
            no requests yet — run a shop scan or look up a user
          </p>
        )}
        {entries.map((e) => (
          <div
            key={e.id}
            className={`m-entry ${e.ok === false ? "err" : ""} ${
              e.sentToReal ? "real" : "local"
            }`}
          >
            <div className="m-line1">
              <span className="m-time">{e.t}</span>
              <span className="m-tag">{e.tag}</span>
              <span className="m-label">{e.label}</span>
            </div>
            <div className="m-line2">
              {e.status != null ? (
                <span className={`m-status ${e.ok === false ? "err" : ""}`}>{e.status}</span>
              ) : (
                <span className="m-status net">NET</span>
              )}
              <span className="m-verdict">
                {e.ok === null
                  ? "sending…"
                  : e.sentToReal
                    ? e.ok
                      ? "→ Real ok"
                      : "→ Real error"
                    : e.ok
                      ? "local"
                      : "blocked locally"}
              </span>
              {e.msg && <span className="m-msg">{e.msg}</span>}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
