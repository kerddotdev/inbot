import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RemoteStatus } from "@inbot/contracts/src/remote.js";
import { api } from "../api";
import { remoteQuery } from "../queries";
import { ErrorNotice, LoadError } from "../feedback";
import {
  Button,
  CopyButton,
  inputClasses,
  Page,
  SkeletonRows,
  Status,
  type Tone,
} from "../components/ui";
import type { IconName } from "../icons";

const display: Record<RemoteStatus["state"], { tone: Tone; icon: IconName; label: string }> = {
  disabled: { tone: "mute", icon: "minus-circle", label: "Disabled" },
  provisioning: { tone: "warn", icon: "globe", label: "Provisioning" },
  connecting: { tone: "warn", icon: "link", label: "Connecting" },
  connected: { tone: "ok", icon: "check-circle", label: "Connected" },
  action_required: { tone: "bad", icon: "alert", label: "Action required" },
};

export function Remote() {
  const query = useQuery(remoteQuery);
  const client = useQueryClient();
  const [hostname, setHostname] = useState("");
  const [confirming, setConfirming] = useState(false);
  const change = useMutation({
    mutationFn: (action: { kind: "enable"; hostname: string } | { kind: "disable" }) =>
      action.kind === "enable" ? api.enableRemote(action.hostname) : api.disableRemote(),
    onSuccess: (status) => {
      client.setQueryData(remoteQuery.queryKey, status);
      setConfirming(false);
    },
    onSettled: () => client.invalidateQueries({ queryKey: remoteQuery.queryKey }),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if ((query.data?.hostname ?? hostname).trim() && !change.isPending) setConfirming(true);
  };
  const status = query.data;
  const shown = status ? display[status.state] : undefined;
  const url = status?.hostname ? `https://${status.hostname}` : undefined;
  return (
    <Page
      barTitle="Remote access"
      title="Reach Inbot from cloud agents"
      lead="A Cloudflare Tunnel gives cloud agents a public URL. Agents need a scoped API key. Manage transport, domains, keys and remote access locally."
    >
      {query.isPending ? (
        <SkeletonRows />
      ) : query.error ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : status && shown ? (
        <div className="max-w-[620px]">
          <div
            className="flex items-center justify-between gap-4 border-y border-line py-4"
            aria-live="polite"
          >
            <div>
              <p className="font-semibold">Remote access</p>
              <Status tone={shown.tone} icon={shown.icon}>
                {change.isPending ? "Updating remote access" : shown.label}
              </Status>
            </div>
            {status.state !== "disabled" ? (
              <Button
                disabled={change.isPending}
                onClick={() => change.mutate({ kind: "disable" })}
              >
                Disable
              </Button>
            ) : null}
          </div>
          {status.reason ? (
            <p role="alert" className="mt-4 text-bad">
              {status.reason}
            </p>
          ) : null}
          <ErrorNotice error={change.error} />
          {url ? (
            <dl className="grid grid-cols-[120px_minmax(0,1fr)]">
              <dt className="border-b border-line py-3.5 text-ink2">Tunnel URL</dt>
              <dd className="flex items-center gap-2 border-b border-line py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{url}</span>
                <CopyButton text={url} label="Copy tunnel URL" />
              </dd>
              <dt className="border-b border-line py-3.5 text-ink2">Connector</dt>
              <dd className="border-b border-line py-3.5">
                cloudflared {status.connector_version}
              </dd>
              <dt className="border-b border-line py-3.5 text-ink2">MCP endpoint</dt>
              <dd className="flex items-center gap-2 border-b border-line py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{url}/mcp</span>
                <CopyButton text={`${url}/mcp`} label="Copy MCP endpoint" />
              </dd>
            </dl>
          ) : null}
          {status.state === "disabled" || status.state === "action_required" ? (
            <form onSubmit={submit} className="mt-6 max-w-md">
              <fieldset disabled={change.isPending || confirming}>
                <label htmlFor="remote-hostname" className="mb-2 block font-semibold">
                  Public hostname
                </label>
                <input
                  id="remote-hostname"
                  className={inputClasses}
                  value={status.hostname ?? hostname}
                  onChange={(event) => setHostname(event.target.value)}
                  readOnly={status.hostname !== null}
                  required
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="inbot.example.com"
                />
                <p className="mt-2 text-xs text-ink2">
                  Use an unused subdomain in the configured Cloudflare account. The zone apex is
                  never allowed.
                </p>
                <Button type="submit" variant="primary" className="mt-4">
                  {status.state === "action_required" ? "Retry enable" : "Enable remote access"}
                </Button>
              </fieldset>
            </form>
          ) : null}
          {confirming ? (
            <div
              className="mt-5 border-t border-line pt-5"
              role="group"
              aria-labelledby="remote-confirm-title"
            >
              <p id="remote-confirm-title" className="font-semibold">
                Download connector and enable remote access?
              </p>
              <p className="mt-2 text-ink2">
                Inbot will download and verify cloudflared {status.connector_version}, create a
                named tunnel and a proxied DNS record for {status.hostname ?? hostname.trim()}, and
                start the connector. Cloudflare terminates HTTPS and forwards requests to this
                machine.
              </p>
              <div className="mt-4 flex gap-2">
                <Button
                  variant="primary"
                  disabled={change.isPending}
                  onClick={() =>
                    change.mutate({ kind: "enable", hostname: status.hostname ?? hostname.trim() })
                  }
                >
                  {change.isPending ? "Enabling..." : "Download and enable"}
                </Button>
                <Button disabled={change.isPending} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          <p className="mt-6 text-ink2">
            Reachable: /mcp, agent /v0 routes, and the web UI with owner sign-in. /oauth and
            /.well-known are reserved for future support. Local owner bearer tokens are rejected
            remotely.
          </p>
        </div>
      ) : null}
    </Page>
  );
}
