import { useState, type FormEvent } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Domain, RecordStatus, VerificationStatus } from "@inbot/contracts/src/domains.js";
import { api, ApiError } from "../api";
import { domainQuery, domainsQuery } from "../queries";
import { ErrorNotice, LoadError } from "../feedback";
import type { IconName } from "../icons";
import {
  Button,
  CopyButton,
  Disclosure,
  inputClasses,
  ListMessage,
  Page,
  SkeletonRows,
  Status,
  type Tone,
} from "../components/ui";

type StatusDisplay = { tone: Tone; icon: IconName; label: string };
const recordDisplay: Record<RecordStatus, StatusDisplay> = {
  UNKNOWN: { tone: "mute", icon: "minus-circle", label: "Unverified" },
  VALID: { tone: "ok", icon: "check-circle", label: "Valid" },
  MISSING: { tone: "warn", icon: "minus-circle", label: "Missing" },
  INVALID: { tone: "bad", icon: "x-circle", label: "Invalid" },
};
const domainDisplay: Record<VerificationStatus, StatusDisplay> = {
  NOT_STARTED: { tone: "mute", icon: "minus-circle", label: "Not started" },
  PENDING: { tone: "warn", icon: "minus-circle", label: "Pending" },
  VERIFYING: { tone: "warn", icon: "shield-check", label: "Verifying" },
  VERIFIED: { tone: "ok", icon: "check-circle", label: "Verified" },
  INVALID: { tone: "bad", icon: "x-circle", label: "Invalid" },
  FAILED: { tone: "bad", icon: "x-circle", label: "Failed" },
};
const pendingRecord: StatusDisplay = { tone: "mute", icon: "minus-circle", label: "Pending" };

export function Domains() {
  const query = useQuery(domainsQuery);
  const client = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createDomain({ domain: name.trim() }),
    onSuccess: async (domain) => {
      client.setQueryData(domainQuery(domain.domain_id).queryKey, domain);
      setName("");
      await client.invalidateQueries({ queryKey: domainsQuery.queryKey });
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!create.isPending && name.trim()) create.mutate();
  };
  if (query.isPending)
    return (
      <Page barTitle="Domains" title="Domains">
        <SkeletonRows />
      </Page>
    );
  if (query.error)
    return (
      <Page barTitle="Domains" title="Domains">
        <LoadError error={query.error} retry={() => void query.refetch()} />
      </Page>
    );
  const domain = query.data[0];
  if (domain) return <RegisteredDomain key={domain.domain_id} id={domain.domain_id} />;
  return (
    <Page
      barTitle="Domains"
      title="Register a mail subdomain"
      lead="Use one literal subdomain on your configured Cloudflare account. Registration previews DNS requirements without changing cloud resources."
    >
      <form onSubmit={submit} className="max-w-md" aria-busy={create.isPending}>
        <fieldset disabled={create.isPending}>
          <label htmlFor="domain-name" className="mb-2 block font-semibold">
            Mail subdomain
          </label>
          <input
            id="domain-name"
            className={inputClasses}
            value={name}
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="agents.example.com"
            onChange={(event) => setName(event.target.value)}
          />
          <p className="mt-2 text-xs text-ink2">
            Configure transport in Settings first. Apex domains and wildcards are unsupported.
          </p>
          <Button className="mt-4" variant="primary" icon="plus" type="submit">
            {create.isPending ? "Registering..." : "Register domain"}
          </Button>
        </fieldset>
        <ErrorNotice error={create.error} />
      </form>
    </Page>
  );
}

function RegisteredDomain({ id }: { id: string }) {
  const busy = useIsMutating({ mutationKey: ["domain-operation", id] }) > 0;
  const query = useQuery({
    ...domainQuery(id),
    enabled: !busy,
    refetchInterval: (query) =>
      query.state.data?.status === "VERIFYING" || query.state.data?.status === "PENDING"
        ? 5000
        : false,
  });
  if (!query.data)
    return (
      <Page barTitle="Domains" title="Domains">
        {query.error ? (
          <LoadError error={query.error} retry={() => void query.refetch()} />
        ) : (
          <SkeletonRows />
        )}
      </Page>
    );
  return (
    <DomainView domain={query.data} loadError={query.error} retry={() => void query.refetch()} />
  );
}

type DomainAction = "apply" | "verify" | "teardown" | "delete" | "update" | "download";
const progress: Record<DomainAction, string> = {
  apply: "Applying Cloudflare resources. Waiting for the service...",
  verify: "Checking DNS and the encrypted self-test. Waiting for the service...",
  teardown: "Removing owned Cloudflare resources. Waiting for the service...",
  delete: "Deleting domain registration...",
  update: "Updating domain features...",
  download: "Downloading zone file...",
};

function DomainView({
  domain,
  loadError,
  retry,
}: {
  domain: Domain;
  loadError: unknown;
  retry: () => void;
}) {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState<"teardown" | "delete">();
  const id = domain.domain_id;
  const plan = useMutation({
    mutationKey: ["domain-operation", id],
    mutationFn: () => api.domainPlan(id),
  });
  const operation = useMutation({
    mutationKey: ["domain-operation", id],
    mutationFn: async (action: DomainAction) => {
      switch (action) {
        case "apply":
          return api.applyDomain(id);
        case "verify":
          return api.verifyDomain(id);
        case "teardown":
          return api.teardownDomain(id);
        case "delete":
          await api.deleteDomain(id);
          return;
        case "update":
          return api.updateDomain(id, {
            inbound_enabled: true,
            feedback_enabled: false,
            tracking_enabled: false,
            subdomains_enabled: false,
          });
        case "download": {
          const blob = await api.domainZoneFile(id);
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `${domain.domain}.zone`;
          document.body.append(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          return;
        }
      }
    },
    onMutate: async () => {
      plan.reset();
      await client.cancelQueries({ queryKey: domainQuery(id).queryKey });
    },
    onSuccess: (result, action) => {
      if (result) client.setQueryData(domainQuery(id).queryKey, result);
      if (action === "delete") client.removeQueries({ queryKey: domainQuery(id).queryKey });
      setConfirm(undefined);
    },
    onSettled: async (_result, _error, action) => {
      if (action !== "download")
        await client.invalidateQueries({ queryKey: domainsQuery.queryKey });
    },
  });
  const busy = useIsMutating({ mutationKey: ["domain-operation", id] }) > 0;
  const status = domainDisplay[domain.status];
  const applied = domain.status === "VERIFYING" || domain.status === "VERIFIED";
  const lead =
    domain.status === "VERIFIED"
      ? "DNS records and encrypted mail delivery are verified."
      : domain.status === "VERIFYING"
        ? "DNS records were applied automatically via Cloudflare. Verification is in progress."
        : "Apply these records via Cloudflare so agents can receive and send mail.";
  const actionRequired =
    operation.error instanceof ApiError && operation.error.code === "action_required";
  const records = plan.data?.records ?? domain.records;
  const validCount = records.filter((record) => record.value && record.status === "VALID").length;
  return (
    <Page
      barTitle="Domains"
      title={domain.domain}
      lead={`${lead} ${validCount} of ${records.length} are valid.`}
    >
      <div className="mb-4" role="status" aria-live="polite">
        <Status tone={status.tone} icon={status.icon} small={false}>
          {status.label}
        </Status>
        {domain.reason ? <p className="mt-2 text-ink2">{domain.reason}</p> : null}
        {busy ? (
          <p className="mt-2 text-ink2">
            {plan.isPending
              ? "Loading provisioning plan..."
              : operation.variables
                ? progress[operation.variables]
                : "Waiting for the ongoing domain operation..."}
          </p>
        ) : null}
      </div>
      <ErrorNotice error={loadError} />
      {loadError ? (
        <Button icon="refresh" disabled={busy} onClick={retry}>
          Reload domain
        </Button>
      ) : null}
      {actionRequired ? (
        <Status tone="bad" icon="alert">
          Action required
        </Status>
      ) : null}
      <ErrorNotice error={operation.error} />
      <ErrorNotice error={plan.error} />
      <div className="flex flex-wrap items-center gap-2.5" aria-busy={busy}>
        <Button icon="eye" disabled={busy || !!confirm} onClick={() => plan.mutate()}>
          Preview plan
        </Button>
        <Button
          variant={applied ? "default" : "primary"}
          icon="cloud"
          disabled={busy || !!confirm}
          onClick={() => operation.mutate("apply")}
        >
          Apply automatically via Cloudflare
        </Button>
        <Button
          icon="download"
          disabled={busy || !!confirm}
          onClick={() => operation.mutate("download")}
        >
          Download zone file
        </Button>
        <span className="flex-1" />
        <Button
          icon="refresh"
          disabled={busy || !!confirm}
          onClick={() => operation.mutate("verify")}
        >
          Verify now
        </Button>
      </div>
      {plan.data ? (
        <div className="mt-5">
          <h2 className="font-semibold">Provisioning preview</h2>
          <ul className="mt-2 space-y-2">
            {plan.data.warnings
              .filter((warning) => warning !== domain.reason)
              .map((warning, index) => (
                <li key={index}>
                  <Status tone="warn" icon="alert">
                    Warning
                  </Status>
                  <p className="mt-1 text-ink2">{warning}</p>
                </li>
              ))}
          </ul>
          <Disclosure label="Provisioning steps">
            <ol className="mt-2 list-inside list-decimal space-y-1 text-ink2">
              {plan.data.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </Disclosure>
          <p className="mt-3 text-xs text-ink2">
            DNS records below are a preview. Loading a plan does not change cloud resources.
          </p>
        </div>
      ) : null}
      <ul className="mt-5 border-b border-line">
        {records.map((record, index) => {
          const status = record.value ? recordDisplay[record.status] : pendingRecord;
          const value = record.value
            ? `${record.priority === undefined ? "" : `${record.priority} `}${record.value}`
            : "Assigned during apply";
          return (
            <li
              key={`${record.type}-${record.name}-${index}`}
              className="grid grid-cols-[96px_44px_minmax(0,1fr)_36px] items-start gap-3.5 border-t border-line py-[11px]"
            >
              <Status tone={status.tone} icon={status.icon} small={false}>
                {status.label}
              </Status>
              <span className="pt-px font-semibold">{record.type}</span>
              <div className="min-w-0">
                <div className="truncate font-mono text-xs font-semibold" title={record.name}>
                  {record.name}
                </div>
                <div className="mt-px break-all font-mono text-xs text-ink2">{value}</div>
                {record.reason ? (
                  <div
                    className={`mt-0.5 text-xs ${record.value && record.status !== "VALID" ? "text-bad" : "text-ink2"}`}
                  >
                    {record.reason}
                  </div>
                ) : null}
              </div>
              {record.value ? (
                <CopyButton text={record.value} label={`Copy ${record.type} record value`} />
              ) : null}
            </li>
          );
        })}
      </ul>
      {records.length === 0 ? (
        <ListMessage icon="globe" title="No DNS records returned">
          Reload the domain or request a provisioning plan.
        </ListMessage>
      ) : null}
      <Disclosure label="Domain features">
        <p className="mt-2 text-ink2">
          Inbound: {domain.inbound_enabled ? "Enabled" : "Disabled"}. Feedback:{" "}
          {domain.feedback_enabled ? "Enabled" : "Disabled"}. Tracking:{" "}
          {domain.tracking_enabled ? "Enabled" : "Disabled"}. Wildcard subdomains:{" "}
          {domain.subdomains_enabled ? "Enabled" : "Disabled"}.
        </p>
        <p className="mt-2 text-xs text-ink2">
          The service supports inbound mail on one literal subdomain with feedback, tracking, and
          wildcard subdomains disabled.
        </p>
        <Button
          className="mt-2"
          disabled={busy || !!confirm}
          onClick={() => operation.mutate("update")}
        >
          Confirm supported features
        </Button>
      </Disclosure>
      <div className="mt-8 border-t border-line pt-4">
        {confirm ? (
          <div
            role="group"
            aria-label={
              confirm === "teardown" ? "Confirm teardown" : "Confirm registration deletion"
            }
          >
            <p className="mb-3 text-ink2">
              {confirm === "teardown"
                ? "Teardown deletes Cloudflare resources Inbot created and stops inbox routing. Adopted resources and local mail are preserved. Apex records are never touched. Pending or quarantined buffered mail must be drained first."
                : "Delete removes the local domain registration only after teardown has removed all resources Inbot created. It does not delete Cloudflare resources itself. Apex records are never touched and local mail is preserved."}
            </p>
            <div className="flex gap-2.5">
              <Button variant="danger" disabled={busy} onClick={() => operation.mutate(confirm)}>
                {confirm === "teardown" ? "Confirm teardown" : "Confirm delete registration"}
              </Button>
              <Button disabled={busy} onClick={() => setConfirm(undefined)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2.5">
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                operation.reset();
                setConfirm("teardown");
              }}
            >
              Teardown resources
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                operation.reset();
                setConfirm("delete");
              }}
            >
              Delete registration
            </Button>
          </div>
        )}
      </div>
    </Page>
  );
}
