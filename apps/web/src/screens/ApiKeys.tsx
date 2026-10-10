import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Schema } from "effect";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Permissions, type SendPolicy } from "@inbot/contracts/src/api-keys.js";
import { api } from "../api";
import { inboxesQuery, keysQuery } from "../queries";
import { ErrorNotice, LoadError } from "../feedback";

import type { IconName } from "../icons";
import {
  Button,
  CopyButton,
  Disclosure,
  inputClasses,
  ListMessage,
  Page,
  Segmented,
  SkeletonRows,
  Status,
  type Tone,
} from "../components/ui";

type PermissionPreset = "read" | "read-draft" | "full";
const readPermissions = { inbox_read: true, message_read: true, draft_read: true };
const draftPermissions = {
  ...readPermissions,
  draft_create: true,
  draft_update: true,
  draft_delete: true,
};
const presetPermissions = {
  read: readPermissions,
  "read-draft": draftPermissions,
  full: {
    ...draftPermissions,
    message_update: true,
    message_reply: true,
    message_send: true,
    draft_send: true,
  },
} satisfies Record<PermissionPreset, Permissions>;
const presetHint: Record<PermissionPreset, string> = {
  read: "Can read threads. Cannot create drafts or send.",
  "read-draft": "Can read threads and create drafts. Cannot send or manage inboxes.",
  full: "Can read, draft, and send. Sending follows the policy below.",
};

const policyDisplay: Record<
  SendPolicy,
  { tone: Tone; icon: IconName; label: string; hint: string }
> = {
  direct: {
    tone: "ok",
    icon: "send",
    label: "Direct",
    hint: "Messages are queued for sending without owner approval.",
  },
  approval: {
    tone: "warn",
    icon: "shield-check",
    label: "Approval",
    hint: "Drafts wait in Approvals until you accept them.",
  },
  read_only: { tone: "mute", icon: "eye", label: "Read-only", hint: "The key can never send." },
};

const presets: { value: PermissionPreset; label: string }[] = [
  { value: "read", label: "Read only" },
  { value: "read-draft", label: "Read and draft" },
  { value: "full", label: "Full access" },
];

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
  const [allInboxes, setAllInboxes] = useState(false);
  const [permissions, setPermissions] = useState<Permissions>(presetPermissions["read-draft"]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameId = useId();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ReadonlySet<string>>(new Set());
  const [customized, setCustomized] = useState(false);
  const [preset, setPreset] = useState<PermissionPreset>("read-draft");
  const [policy, setPolicy] = useState<SendPolicy>("approval");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const choosePreset = (next: PermissionPreset) => {
    setPreset(next);
    setCustomized(false);
    setPermissions(presetPermissions[next]);
    if (next === "read") setPolicy("read_only");
    else if (policy === "read_only") setPolicy("approval");
  };

  const toggleInbox = (inbox: string) => {
    const next = new Set(scope);
    if (!next.delete(inbox)) next.add(inbox);
    setScope(next);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || secret) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.createKey({
        name: name.trim(),
        ...(allInboxes ? {} : { inbox_ids: [...scope] }),
        permissions,
        send_policy: policy,
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
            <fieldset className="mb-4 min-w-0">
              <legend className="mb-[7px] p-0 font-semibold">Inbox scope</legend>
              <label className="mb-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allInboxes}
                  onChange={(event) => setAllInboxes(event.target.checked)}
                />
                All current and future inboxes
              </label>
              {loadingInboxes ? (
                <p role="status">Loading inboxes...</p>
              ) : inboxError ? (
                <LoadError error={inboxError} retry={retryInboxes} />
              ) : inboxIds.length === 0 ? (
                <p className="text-ink2">No inboxes exist yet.</p>
              ) : null}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {inboxIds.map((inbox) => (
                  <label key={inbox} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-[15px]"
                      checked={scope.has(inbox)}
                      disabled={allInboxes}
                      onChange={() => toggleInbox(inbox)}
                    />
                    {inbox}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="mb-4 min-w-0">
              <legend className="mb-[7px] p-0 font-semibold">Permissions</legend>
              <Segmented name="preset" options={presets} value={preset} onChange={choosePreset} />
              <p className="mt-1.5 text-xs text-ink2">
                {customized ? "Only the checked permissions are granted." : presetHint[preset]}
              </p>
              <Disclosure label="Choose individual permissions">
                <div className="mt-2 grid gap-1.5">
                  {Object.keys(Permissions.fields).map((permission) => (
                    <label key={permission} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={Object.entries(permissions).some(
                          ([key, enabled]) => key === permission && enabled,
                        )}
                        onChange={(event) => {
                          setCustomized(true);
                          setPermissions(
                            Schema.decodeUnknownSync(Permissions)({
                              ...permissions,
                              [permission]: event.target.checked,
                            }),
                          );
                        }}
                      />
                      {permission.replaceAll("_", " ")}
                    </label>
                  ))}
                </div>
              </Disclosure>
            </fieldset>
            <fieldset className="mb-4 min-w-0">
              <legend className="mb-[7px] p-0 font-semibold">Send policy</legend>
              <div className="grid gap-2">
                {(["direct", "approval", "read_only"] satisfies SendPolicy[]).map((value) => (
                  <label
                    key={value}
                    className={`flex items-start gap-2 ${!customized && preset === "read" && value !== "read_only" ? "opacity-50" : ""}`}
                  >
                    <input
                      type="radio"
                      name="policy"
                      className="mt-0.5 size-[15px]"
                      checked={policy === value}
                      disabled={!customized && preset === "read" && value !== "read_only"}
                      onChange={() => setPolicy(value)}
                    />
                    <span>
                      {policyDisplay[value].label}
                      <small className="block text-ink2">{policyDisplay[value].hint}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-1.5 flex items-center justify-end gap-2.5">
              <Button variant="quiet" disabled={busy} onClick={() => dialogRef.current?.close()}>
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={busy || name.trim() === "" || (!allInboxes && scope.size === 0)}
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
