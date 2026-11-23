import { useCallback, useEffect, useRef, useState } from "react";
import { Connection, friendlyError } from "./es";
import { ClusterSnapshot, fetchSnapshot } from "./cluster";

export function useCluster(conn: Connection | null, autoRefreshMs = 0) {
  const [snap, setSnap] = useState<ClusterSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!conn) {
      setSnap(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const next = await fetchSnapshot(conn);
      setSnap(next);
      setError(next.error);
    } catch (e: any) {
      setError(friendlyError(e, conn));
    } finally {
      setLoading(false);
    }
  }, [conn]);

  useEffect(() => {
    if (!conn) {
      setSnap(null);
      setError(null);
      setLoading(false);
      return;
    }
    refresh();
    if (autoRefreshMs > 0) {
      timer.current = window.setInterval(refresh, autoRefreshMs);
      return () => {
        if (timer.current) window.clearInterval(timer.current);
      };
    }
  }, [refresh, autoRefreshMs]);

  return { snap, loading, error, refresh };
}
