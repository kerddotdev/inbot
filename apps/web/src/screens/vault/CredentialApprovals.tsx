import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CredentialUseRequest } from "@inbot/contracts/src/credential-use.js";
import type { CredentialRequest } from "@inbot/contracts/src/credential-requests.js";
import { api } from "../../api";
import { SecretInput } from "../../components/SecretInput";
import { Button, inputClasses, PaneBar, Status } from "../../components/ui";
import { ErrorNotice } from "../../feedback";
import { keysQuery } from "../../queries";
import { links, navigate } from "../../router";
import { relativeTime } from "./format";

const kindLabel: Record<CredentialUseRequest["kind"], string> = {
  fill: "Browser fill",
  run: "Local command",
};

function KeyName({ id, name }: { id: string | undefined; name?: string | undefined }) {
  const keys = useQuery({ ...keysQuery, enabled: name === undefined && id !== undefined });
  const known = name ?? keys.data?.find((key) => key.api_key_id === id)?.name;
  if (known !== undefined) return <span className="font-medium">{known}</span>;
  return <span className="font-mono text-xs">{id ?? "an unknown key"}</span>;
}

function Row({
  href,
  selected,
  title,
  lines,
}: {
  href: string;
  selected: boolean;
  title: string;
  lines: readonly string[];
}) {
  return (
    <a
      data-row
      href={href}
      aria-current={selected ? "true" : undefined}
      className="relative block border-b border-line py-[11px] pr-4 pl-7 transition-colors duration-150 hover:bg-hover aria-[current=true]:bg-sel"
    >
      <span
        aria-hidden="true"
        className="absolute top-[19px] left-3 size-2 rounded-full bg-accent"
      />
      <div className="truncate font-semibold">{title}</div>
      {lines.map((line) => (
        <div key={line} className="truncate text-[12.5px] text-ink2">
          {line}
        </div>
      ))}
    </a>
  );
}

export function CredentialUseRow({
  request,
  selected,
}: {
  request: CredentialUseRequest;
  selected: boolean;
}) {
  return (
    <Row
      href={links.credentialUse(request.request_id)}
      selected={selected}
      title={`${kindLabel[request.kind]} by ${request.api_key_name ?? "an agent key"}`}
      lines={[
        request.credentials.map((credential) => credential.name).join(", "),
        request.inbox_id,
      ]}
    />
  );
}

export function CredentialRequestRow({
  request,
  selected,
}: {
  request: CredentialRequest;
  selected: boolean;
}) {
  return (
    <Row
      href={links.credentialRequest(request.request_id)}
      selected={selected}
      title={request.name}
      lines={[`Needs ${request.fields.join(", ")}`, request.inbox_id]}
    />
  );
}

function Detail({
  status,
  title,
  facts,
  children,
}: {
  status: ReactNode;
  title: string;
  facts: readonly (readonly [string, ReactNode])[];
  children: ReactNode;
}) {
  return (
    <article aria-label={title} className="flex min-h-0 min-w-0 flex-col bg-win">
      <PaneBar>{status}</PaneBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[604px] px-8 pt-[30px] pb-16">
          <h1 className="mb-[22px] font-serif text-[30px] leading-[1.18] font-medium tracking-[-0.012em] text-balance break-words">
            {title}
          </h1>
          <dl className="mb-6 grid grid-cols-[128px_1fr] gap-y-2">
            {facts.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink2">{label}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </div>
            ))}
          </dl>
          {children}
        </div>
      </div>
    </article>
  );
}

const when = (iso: string) => (
  <time dateTime={iso} title={new Date(iso).toLocaleString()}>
    {relativeTime(iso, Date.now())}
  </time>
);

export function CredentialUseView({
  request,
  onDecision,
}: {
  request: CredentialUseRequest;
  onDecision: (message: ReactNode) => void;
}) {
  const client = useQueryClient();
  const expired = Date.parse(request.expires_at) <= Date.now();
  const decision = useMutation({
    mutationFn: (kind: "approve" | "reject") => api.decideCredentialUse(request.request_id, kind),
    onSuccess: (_result, kind) => {
      void client.invalidateQueries({ queryKey: ["approvals"] });
      onDecision(kind === "approve" ? "Credential use approved" : "Credential use rejected");
      navigate(links.approvals());
    },
  });
  return (
    <Detail
      title={`${kindLabel[request.kind]} request`}
      status={
        expired ? (
          <Status tone="mute" icon="minus-circle" small={false}>
            Expired
          </Status>
        ) : (
          <Status tone="warn" icon="minus-circle" small={false}>
            Awaiting approval
          </Status>
        )
      }
      facts={[
        ["Key", <KeyName key="key" id={request.api_key_id} name={request.api_key_name} />],
        ["Inbox", request.inbox_id],
        ["Use", kindLabel[request.kind]],
        [
          "Credentials",
          <ul key="credentials">
            {request.credentials.map((credential) => (
              <li key={credential.credential_id}>
                <a
                  href={links.vault(request.inbox_id, credential.credential_id)}
                  className="text-accent underline"
                >
                  {credential.name}
                </a>
                <span className="text-ink2"> - {credential.fields.join(", ")}</span>
              </li>
            ))}
          </ul>,
        ],
        ...(request.url_hint
          ? ([["Agent-provided URL (unverified)", request.url_hint]] as const)
          : []),
        ["Requested", when(request.created_at)],
        ["Expires", when(request.expires_at)],
      ]}
    >
      <p className="mb-5 text-ink2">
        Approving permits this one use for 15 minutes. The agent never receives the values.
      </p>
      <ErrorNotice error={decision.error} />
      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          variant="primary"
          icon="shield-check"
          disabled={decision.isPending || expired}
          onClick={() => decision.mutate("approve")}
        >
          {decision.isPending ? "Saving decision..." : "Approve"}
        </Button>
        <Button
          variant="danger"
          icon="x-circle"
          disabled={decision.isPending || expired}
          onClick={() => decision.mutate("reject")}
        >
          Reject
        </Button>
      </div>
    </Detail>
  );
}

export function CredentialRequestView({
  request,
  onDecision,
}: {
  request: CredentialRequest;
  onDecision: (message: ReactNode) => void;
}) {
  const client = useQueryClient();
  const [entering, setEntering] = useState(false);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [username, setUsername] = useState(request.username ?? "");
  const expired = Date.parse(request.expires_at) <= Date.now();
  const finish = (message: ReactNode) => {
    void client.invalidateQueries({ queryKey: ["approvals"] });
    void client.invalidateQueries({ queryKey: ["credentials"] });
    onDecision(message);
    navigate(links.approvals());
  };
  const fulfill = useMutation({
    mutationFn: () =>
      api.fulfillCredentialRequest(request.request_id, {
        fields: Object.fromEntries(request.fields.map((field) => [field, values[field] ?? ""])),
        ...(username.trim() ? { username: username.trim() } : {}),
      }),
    onSuccess: (result) =>
      finish(
        <>
          Credential created.{" "}
          {result.credential ? (
            <a
              href={links.vault(result.credential.inbox_id, result.credential.credential_id)}
              className="text-accent underline"
            >
              Open in Vault
            </a>
          ) : null}
        </>,
      ),
  });
  const decline = useMutation({
    mutationFn: () => api.declineCredentialRequest(request.request_id),
    onSuccess: () => finish("Credential request declined"),
  });
  const busy = fulfill.isPending || decline.isPending;
  const complete = request.fields.every((field) => (values[field] ?? "") !== "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && complete) fulfill.mutate();
  };
  return (
    <Detail
      title={request.name}
      status={
        expired ? (
          <Status tone="mute" icon="minus-circle" small={false}>
            Expired
          </Status>
        ) : (
          <Status tone="warn" icon="minus-circle" small={false}>
            Waiting for your values
          </Status>
        )
      }
      facts={[
        ["Inbox", request.inbox_id],
        ["Requested by", <KeyName key="key" id={request.requested_by} />],
        ...(request.url ? ([["URL (unverified)", request.url]] as const) : []),
        ...(request.username ? ([["Username", request.username]] as const) : []),
        [
          "Fields",
          <span key="fields" className="font-mono">
            {request.fields.join(", ")}
          </span>,
        ],
        ["Requested", when(request.created_at)],
        ["Expires", when(request.expires_at)],
      ]}
    >
      <div className="mb-6 border-t border-line pt-4">
        <p className="mb-1 text-xs font-semibold text-ink2">Reason from the agent</p>
        <p className="whitespace-pre-wrap break-words">{request.reason}</p>
      </div>
      <ErrorNotice error={fulfill.error ?? decline.error} />
      {entering ? (
        <form onSubmit={submit} aria-busy={fulfill.isPending}>
          <fieldset disabled={busy} className="grid gap-4">
            <label>
              <span className="mb-[7px] block font-semibold">Username (optional)</span>
              <input
                className={inputClasses}
                value={username}
                maxLength={320}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            {request.fields.map((field) => (
              <label key={field}>
                <span className="mb-[7px] block font-semibold">
                  <span className="font-mono">{field}</span>
                </span>
                <SecretInput
                  aria-label={field}
                  value={values[field] ?? ""}
                  placeholder={field === "totp" ? "Setup key or otpauth URI" : undefined}
                  onChange={(event) => setValues({ ...values, [field]: event.target.value })}
                />
              </label>
            ))}
            <p className="text-xs text-ink2">
              The values are stored encrypted. The agent receives refs only.
            </p>
            <div className="flex gap-2.5">
              <Button type="submit" variant="primary" disabled={busy || !complete}>
                {fulfill.isPending ? "Saving..." : "Fulfill"}
              </Button>
              <Button variant="quiet" disabled={busy} onClick={() => setEntering(false)}>
                Cancel
              </Button>
            </div>
          </fieldset>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            variant="primary"
            icon="key"
            disabled={busy || expired}
            onClick={() => setEntering(true)}
          >
            Enter values
          </Button>
          <Button
            variant="danger"
            icon="x-circle"
            disabled={busy || expired}
            onClick={() => decline.mutate()}
          >
            {decline.isPending ? "Declining..." : "Decline"}
          </Button>
        </div>
      )}
    </Detail>
  );
}
