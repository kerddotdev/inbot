import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Credential } from "@inbot/contracts/src/vault.js";
import { ApiError } from "../../api";
import { Button, CopyButton, ListMessage, PaneBar } from "../../components/ui";
import { ErrorNotice, LoadError } from "../../feedback";
import { credentialQuery } from "../../queries";
import { links, navigate } from "../../router";
import { DeleteCredential, EditCredential, GeneratePassword } from "./CredentialDialogs";
import { relativeTime } from "./format";
import { useReveal } from "./Reveal";
import { TotpCode } from "./Totp";

function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {relativeTime(iso, Date.now())}
    </time>
  );
}

function Meta({ credential }: { credential: Credential }) {
  return (
    <dl className="mb-7 grid grid-cols-[104px_1fr] gap-y-2">
      <dt className="text-ink2">Inbox</dt>
      <dd className="break-all">{credential.inbox_id}</dd>
      {credential.url ? (
        <>
          <dt className="text-ink2">URL</dt>
          <dd className="break-all">
            <a
              href={credential.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent underline"
            >
              {credential.url}
            </a>
          </dd>
        </>
      ) : null}
      <dt className="text-ink2">Allowed origins</dt>
      <dd>
        {credential.origins.length === 0 ? (
          <span className="text-ink2">None. Browser fill needs a URL or origin.</span>
        ) : (
          <ul>
            {credential.origins.map((origin) => (
              <li key={origin} className="break-all">
                {origin}
              </li>
            ))}
          </ul>
        )}
      </dd>
      {credential.username ? (
        <>
          <dt className="text-ink2">Username</dt>
          <dd className="-my-1 flex items-center gap-1">
            <span className="break-all">{credential.username}</span>
            <CopyButton text={credential.username} label="Copy username" />
          </dd>
        </>
      ) : null}
      <dt className="text-ink2">Created</dt>
      <dd>
        <Time iso={credential.created_at} />
      </dd>
      <dt className="text-ink2">Updated</dt>
      <dd>
        <Time iso={credential.updated_at} />
      </dd>
      <dt className="text-ink2">Last used</dt>
      <dd>{credential.last_used_at ? <Time iso={credential.last_used_at} /> : "Never"}</dd>
    </dl>
  );
}

function Fields({
  credential,
  revealer: { state, reveal, hide },
}: {
  credential: Credential;
  revealer: ReturnType<typeof useReveal>;
}) {
  const values = state.status === "shown" ? state.fields : undefined;
  return (
    <section aria-labelledby="fields-title" className="mb-7">
      <div className="mb-1 flex items-center gap-2">
        <h2 id="fields-title" className="font-semibold">
          Fields
        </h2>
        <span className="flex-1" />
        {values ? (
          <Button variant="quiet" icon="eye-off" onClick={hide}>
            Hide
          </Button>
        ) : (
          <Button
            variant="quiet"
            icon="eye"
            disabled={state.status === "loading" || credential.fields.length === 0}
            onClick={reveal}
          >
            {state.status === "loading" ? "Revealing..." : "Reveal"}
          </Button>
        )}
      </div>
      <p className="mb-2 text-xs text-ink2">
        Agents use the refs below. They never receive the stored values.
        {values ? " Values hide again after a minute." : ""}
      </p>
      {state.status === "failed" ? <ErrorNotice error={state.error} /> : null}
      {credential.fields.length === 0 ? (
        <p className="text-ink2">No fields are stored.</p>
      ) : (
        <ul className="border-t border-line">
          {credential.fields.map((field) => {
            const value = values?.[field];
            const ref = credential.refs[field];
            return (
              <li key={field} className="border-b border-line py-2.5">
                <div className="flex items-center gap-2">
                  <span className="w-[136px] flex-none truncate font-mono" title={field}>
                    {field}
                  </span>
                  {value !== undefined ? (
                    <code className="min-w-0 flex-1 font-mono break-all">{value}</code>
                  ) : (
                    <span className="flex-1 text-ink2">
                      <span aria-hidden="true">{"•".repeat(10)}</span>
                      <span className="sr-only">Hidden</span>
                    </span>
                  )}
                  {value !== undefined ? <CopyButton text={value} label={`Copy ${field}`} /> : null}
                </div>
                {ref ? (
                  <div className="mt-1 flex items-center gap-1 pl-[144px] text-ink2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs" title={ref}>
                      {ref}
                    </code>
                    <CopyButton text={ref} label={`Copy ref for ${field}`} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DetailView({ credential }: { credential: Credential }) {
  const [dialog, setDialog] = useState<"edit" | "generate" | "delete">();
  const ref = useMemo(
    () => ({ inbox_id: credential.inbox_id, credential_id: credential.credential_id }),
    [credential.inbox_id, credential.credential_id],
  );
  const revealer = useReveal(ref, credential.updated_at);
  return (
    <article aria-label="Credential" className="flex min-h-0 min-w-0 flex-col bg-win">
      <PaneBar>
        <span className="flex-1" />
        <Button variant="quiet" icon="square-pen" onClick={() => setDialog("edit")}>
          Edit
        </Button>
        <Button variant="quiet" icon="refresh" onClick={() => setDialog("generate")}>
          Generate password
        </Button>
        <Button variant="danger" onClick={() => setDialog("delete")}>
          Delete
        </Button>
      </PaneBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[604px] px-8 pt-[30px] pb-16">
          <h1 className="mb-[22px] font-serif text-[30px] leading-[1.18] font-medium tracking-[-0.012em] text-balance break-words">
            {credential.name}
          </h1>
          <Meta credential={credential} />
          <Fields credential={credential} revealer={revealer} />
          {credential.fields.includes("totp") ? (
            <section aria-labelledby="totp-title">
              <h2 id="totp-title" className="mb-2 font-semibold">
                One-time code
              </h2>
              <TotpCode credential={ref} />
            </section>
          ) : null}
        </div>
      </div>
      {dialog === "edit" ? (
        <EditCredential credential={credential} onClose={() => setDialog(undefined)} />
      ) : dialog === "generate" ? (
        <GeneratePassword
          credential={credential}
          onClose={() => setDialog(undefined)}
          onReveal={revealer.reveal}
        />
      ) : dialog === "delete" ? (
        <DeleteCredential
          credential={credential}
          onClose={() => setDialog(undefined)}
          onDeleted={() => navigate(links.vault())}
        />
      ) : null}
    </article>
  );
}

export function CredentialDetail({
  inboxId,
  credentialId,
}: {
  inboxId: string;
  credentialId: string;
}) {
  const query = useQuery(credentialQuery({ inbox_id: inboxId, credential_id: credentialId }));
  if (query.isPending) return <ListMessage icon="vault" title="Loading credential" />;
  if (query.error instanceof ApiError && query.error.code === "not_found")
    return (
      <ListMessage icon="vault" title="Credential not found">
        It may have been deleted.
      </ListMessage>
    );
  if (query.error) return <LoadError error={query.error} retry={() => void query.refetch()} />;
  return <DetailView key={credentialId} credential={query.data} />;
}
