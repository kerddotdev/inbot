import { useState } from "react";
import type { RemoteAccess } from "../mock";
import { CopyButton, Page, Status } from "../components/ui";

export function Remote({ initial }: { initial: RemoteAccess }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const mcpEndpoint = `${initial.tunnelUrl}/mcp`;
  return (
    <Page
      barTitle="Remote access"
      title="Reach Inbot from cloud agents"
      lead="A Cloudflare Tunnel exposes only the routes listed below. Agents still need a key, and owner settings are never reachable remotely."
    >
      <div className="flex max-w-[620px] items-center justify-between gap-4 border-y border-line py-4">
        <div>
          <p id="remote-label" className="font-semibold">
            Remote access
          </p>
          <p className="text-ink2">
            {enabled ? "Cloud agents can connect." : "Only this machine can connect."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="remote-label"
          onClick={() => setEnabled((value) => !value)}
          className={`relative h-[22px] w-[38px] flex-none rounded-full border border-line transition-colors duration-150 ${enabled ? "bg-accent" : "bg-raise"}`}
        >
          <span
            className={`absolute top-[2px] left-[2px] size-4 rounded-full transition-transform duration-150 ${enabled ? "translate-x-4 bg-accent-ink" : "bg-ink2"}`}
          />
        </button>
      </div>
      {enabled ? (
        <dl className="mt-1 grid max-w-[620px] grid-cols-[120px_minmax(0,1fr)] gap-y-0">
          <dt className="border-b border-line py-3.5 text-ink2">Tunnel URL</dt>
          <dd className="flex items-center gap-2 border-b border-line py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{initial.tunnelUrl}</span>
            <CopyButton text={initial.tunnelUrl} label="Copy tunnel URL" />
          </dd>
          <dt className="border-b border-line py-3.5 text-ink2">Connector</dt>
          <dd className="flex flex-wrap items-center gap-x-3 border-b border-line py-3">
            <Status tone="ok" icon="check-circle" small={false}>
              Connected
            </Status>
            <span className="text-ink2">
              {initial.connector.version} since {initial.connector.since}
            </span>
          </dd>
          <dt className="border-b border-line py-3.5 text-ink2">MCP endpoint</dt>
          <dd className="flex items-center gap-2 border-b border-line py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{mcpEndpoint}</span>
            <CopyButton text={mcpEndpoint} label="Copy MCP endpoint" />
          </dd>
          <dt className="border-b border-line py-3.5 text-ink2">Reachable routes</dt>
          <dd className="border-b border-line py-3.5 font-mono text-xs">
            {initial.routes.join("  ")}
          </dd>
        </dl>
      ) : (
        <p className="mt-4 max-w-[620px] text-ink2">
          The tunnel is off. Turn it on to give cloud-hosted agents a URL with scoped credentials.
        </p>
      )}
    </Page>
  );
}
