import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CredentialRef } from "../../api";
import { LoadError } from "../../feedback";
import { CopyButton } from "../../components/ui";
import { totpRefreshDelay, totpSecondsRemaining } from "./format";

function useDocumentVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function DrainBar({ expiresAt, period }: { expiresAt: string; period: number }) {
  const [remaining] = useState(() => Math.max(0, Date.parse(expiresAt) - Date.now()));
  return (
    <div
      aria-hidden="true"
      className="mt-2 h-0.5 overflow-hidden rounded-full bg-hover motion-reduce:hidden"
    >
      <div
        className="h-full origin-left bg-accent"
        style={{
          transform: `scaleX(${Math.min(1, remaining / (period * 1000))})`,
          animation: `drain ${remaining}ms linear forwards`,
        }}
      />
    </div>
  );
}

export function TotpCode({ credential }: { credential: CredentialRef }) {
  const visible = useDocumentVisible();
  const query = useQuery({
    queryKey: ["credentials", "totp", credential.inbox_id, credential.credential_id],
    queryFn: ({ signal }) => api.credentialTotp(credential, signal),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const now = useNow(visible && query.data !== undefined);
  const { data, refetch, dataUpdatedAt } = query;
  const expiresAt = data?.expires_at;

  useEffect(() => {
    if (!visible || expiresAt === undefined) return;
    const timer = window.setTimeout(() => void refetch(), totpRefreshDelay(expiresAt, Date.now()));
    return () => window.clearTimeout(timer);
  }, [visible, expiresAt, dataUpdatedAt, refetch]);

  if (query.isPending)
    return (
      <p role="status" className="text-ink2">
        Loading code...
      </p>
    );
  if (query.error && !data) return <LoadError error={query.error} retry={() => void refetch()} />;
  if (!data) return null;
  const seconds = totpSecondsRemaining(data.expires_at, now);
  return (
    <div>
      <div className="flex items-center gap-2">
        <code
          aria-label={`Current code ${data.code}`}
          className="font-mono text-[22px] tracking-[0.12em] tabular-nums"
        >
          {data.code.replace(/(\d{3})(?=\d)/, "$1 ")}
        </code>
        <CopyButton text={data.code} label="Copy code" />
        <span className="ml-auto text-ink2 tabular-nums">
          {visible ? `${seconds}s left` : "Paused"}
        </span>
      </div>
      {visible ? (
        <DrainBar key={data.expires_at} expiresAt={data.expires_at} period={data.period} />
      ) : null}
    </div>
  );
}
