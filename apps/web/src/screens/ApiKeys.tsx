import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Grant } from "@inbot/contracts/src/api-keys.js";
import { GrantFields, defaultGrant, policyDisplay } from "../components/GrantFields";
import { api } from "../api";
import { inboxesQuery, keysQuery } from "../queries";
import { OAuthGrants } from "./OAuth";
import { ErrorNotice, LoadError } from "../feedback";

import {
  Button,
  CopyButton,
  Disclosure,
  inputClasses,
  ListMessage,
  Page,
  SkeletonRows,
  Status,
} from "../components/ui";

export function ApiKeys() {
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string>();
  const client = useQueryClient();
  const query = useQuery(keysQuery);
  const inboxes = useQuery(inboxesQuery);
  const keys = query.data ?? [];
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeKey(id),
    onSuccess: () => {
      setRevoking(undefined);
      void client.invalidateQueries({ queryKey: ["keys"] });
    },
  });
  return (
    <>
      <Page
        barTitle="API keys"
        barAction={
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            Create key
          </Button>
        }
        title="Keys for agents"
        lead="Each key is limited to the inboxes and actions you choose. Secrets are shown once, at creation."
      >
        <ErrorNotice error={revoke.error} />
        {query.isPending ? (
          <SkeletonRows />
        ) : query.error ? (
          <LoadError error={query.error} retry={() => void query.refetch()} />
        ) : keys.length === 0 ? (
          <ListMessage icon="key" title="No API keys yet">
            Create a key to give an agent access to selected inboxes.
          </ListMessage>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr>
                  {["Name", "Inbox", "Permissions", "Send policy", "Last used", "Actions"].map(
                    (heading) => (
                      <th
                        key={heading}
                        scope="col"
                        className="border-b border-line py-2 pr-3 text-left text-xs font-semibold text-ink2"
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => {
                  const policy = policyDisplay[key.send_policy];
                  return (
                    <tr key={key.api_key_id}>
                      <td className="border-b border-line py-[13px] pr-3">
                        <b className="font-semibold">{key.name}</b>
                        <br />
                        <small className="font-mono text-xs text-ink2">{key.prefix}...</small>
                      </td>
                      <td className="border-b border-line py-[13px] pr-3">
                        {key.inbox_id
                          ? key.inbox_ids && !key.inbox_ids.includes(key.inbox_id)
                            ? "No inboxes"
                            : key.inbox_id
                          : key.inbox_ids
                            ? key.inbox_ids.join(", ") || "No inboxes"
                            : "All inboxes"}
                      </td>
                      <td className="border-b border-line py-[13px] pr-3">
                        <Disclosure
                          label={`${Object.values(key.permissions).filter(Boolean).length} permissions`}
                        >
                          <p className="mt-2 text-xs text-ink2">
                            {Object.entries(key.permissions)
                              .filter(([, enabled]) => enabled)
                              .map(([permission]) => permission.replaceAll("_", " "))
                              .join(", ") || "None"}
                          </p>
                        </Disclosure>
                      </td>
                      <td className="border-b border-line py-[13px] pr-3">
                        <Status tone={policy.tone} icon={policy.icon} small={false}>
                          {policy.label}
                        </Status>
                      </td>
                      <td className="border-b border-line py-[13px] pr-3 text-ink2">
                        {key.used_at ? new Date(key.used_at).toLocaleString() : "Never"}
                      </td>
                      <td className="border-b border-line py-[13px]">
                        {revoking === key.api_key_id ? (
                          <div className="flex gap-2">
                            <Button
                              variant="danger"
                              disabled={revoke.isPending}
                              onClick={() => revoke.mutate(key.api_key_id)}
                            >
                              Confirm revoke
                            </Button>
                            <Button
                              disabled={revoke.isPending}
                              onClick={() => setRevoking(undefined)}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="danger"
                            disabled={revoke.isPending}
                            onClick={() => {
                              revoke.reset();
                              setRevoking(key.api_key_id);
                            }}
                          >
                            Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <OAuthGrants />
      </Page>
      {creating ? (
        <CreateKeyDialog
          inboxIds={inboxes.data?.map((inbox) => inbox.inbox_id) ?? []}
          inboxError={inboxes.error}
          loadingInboxes={inboxes.isPending}
          retryInboxes={() => void inboxes.refetch()}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}

function CreateKeyDialog({
  onClose,
  inboxIds,
  inboxError,
  loadingInboxes,
  retryInboxes,
}: {
  onClose: () => void;
  inboxIds: readonly string[];
  inboxError: unknown;
  loadingInboxes: boolean;
  retryInboxes: () => void;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [secret, setSecret] = useState<string>();
  const [grant, setGrant] = useState<Grant>(defaultGrant);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameId = useId();
  const [name, setName] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || secret) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.createKey({
        name: name.trim(),
        ...grant,
      });
      setSecret(result.api_key);
      void client.invalidateQueries({ queryKey: ["keys"] });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={`${nameId}-title`}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) event.currentTarget.close();
      }}
      className="mx-auto mt-11 max-h-[calc(100dvh-88px)] w-[500px] max-w-[calc(100vw-32px)] animate-rise overflow-y-auto rounded-[14px] bg-win p-0 text-ink shadow-sheet backdrop:animate-fade backdrop:bg-scrim"
    >
      {secret ? (
        <div className="px-7 py-[26px]">
          <h2
            id={`${nameId}-title`}
            className="mb-[18px] text-[22px] font-semibold tracking-[-0.015em]"
          >
            API key created
          </h2>
          <p className="mb-4 text-ink2">Copy this secret now. It will not be shown again.</p>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{secret}</code>
            <CopyButton text={secret} label="Copy API key" />
          </div>
          <Button className="mt-5" variant="primary" onClick={() => dialogRef.current?.close()}>
            Done
          </Button>
        </div>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="px-7 py-[26px]" aria-busy={busy}>
          <fieldset disabled={busy}>
            <h2
              id={`${nameId}-title`}
              className="mb-[18px] text-[22px] font-semibold tracking-[-0.015em]"
            >
              Create API key
            </h2>
            <div className="mb-4">
              <label htmlFor={nameId} className="mb-[7px] block font-semibold">
                Name
              </label>
              <input
                id={nameId}
                className={inputClasses}
                value={name}
                placeholder="research-weekly"
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <GrantFields
              value={grant}
              onChange={setGrant}
              inboxIds={inboxIds}
              inboxError={inboxError}
              loadingInboxes={loadingInboxes}
              retryInboxes={retryInboxes}
            />
            <div className="mt-1.5 flex items-center justify-end gap-2.5">
              <Button variant="quiet" disabled={busy} onClick={() => dialogRef.current?.close()}>
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={
                  busy ||
                  name.trim() === "" ||
                  (grant.inbox_ids !== undefined && grant.inbox_ids.length === 0)
                }
              >
                {busy ? "Creating..." : "Create key"}
              </Button>
            </div>
            <ErrorNotice error={error} />
          </fieldset>
        </form>
      )}
    </dialog>
  );
}
