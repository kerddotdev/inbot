import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Inbox, InboxStatus } from "@inbot/contracts/src/inboxes.js";
import { api } from "../api";
import { Select } from "../components/Select";
import { Button, inputClasses, Page, Segmented } from "../components/ui";
import { ErrorNotice } from "../feedback";
import { inboxesQuery, verifiedDomainsQuery } from "../queries";
import { links } from "../router";

export function CreateInbox({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (inbox: Inbox) => void;
}) {
  const client = useQueryClient();
  const domains = useQuery(verifiedDomainsQuery);
  const [username, setUsername] = useState("");
  const [domain, setDomain] = useState("");
  const [displayName, setDisplayName] = useState("");
  const verified = domains.data ?? [];
  const selectedDomain =
    verified.length && !domains.error
      ? (verified.find((item) => item.domain === domain)?.domain ?? verified[0]?.domain ?? "")
      : domain;
  const create = useMutation({
    mutationFn: () =>
      api.createInbox({
        username: username.trim(),
        domain: selectedDomain.trim(),
        ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
      }),
    onSuccess: async (inbox) => {
      await client.cancelQueries({ queryKey: inboxesQuery.queryKey });
      client.setQueryData(inboxesQuery.queryKey, (current) => [
        inbox,
        ...(current ?? []).filter((item) => item.inbox_id !== inbox.inbox_id),
      ]);
      await client.invalidateQueries({ queryKey: inboxesQuery.queryKey });
      onCreated(inbox);
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!create.isPending && !domains.isPending && username.trim() && selectedDomain.trim())
      create.mutate();
  };
  return (
    <Page
      barTitle="New inbox"
      title="Create an inbox"
      lead="Give your agent its own email address."
    >
      <form onSubmit={submit} className="max-w-md" aria-busy={create.isPending}>
        <fieldset disabled={create.isPending} className="space-y-5">
          <label className="grid gap-1.5 font-semibold">
            Username
            <input
              autoFocus
              required
              maxLength={64}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              className={inputClasses}
              value={username}
              placeholder="agent"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          {domains.isPending ? (
            <p role="status" className="text-ink2">
              Loading verified domains...
            </p>
          ) : verified.length && !domains.error ? (
            <Select
              label="Domain"
              labelClassName="font-semibold"
              value={selectedDomain}
              onChange={setDomain}
              options={verified.map((item) => ({ value: item.domain, label: item.domain }))}
            />
          ) : (
            <label className="grid gap-1.5 font-semibold">
              Domain
              <input
                required
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                className={inputClasses}
                value={domain}
                placeholder="agents.example.com"
                onChange={(event) => setDomain(event.target.value)}
              />
            </label>
          )}
          {domains.error ? (
            <div>
              <ErrorNotice error={domains.error} />
              <Button icon="refresh" onClick={() => void domains.refetch()}>
                Retry domains
              </Button>
            </div>
          ) : null}
          {!domains.isPending && (domains.error || verified.length === 0) ? (
            <p className="text-sm text-ink2">
              {domains.error
                ? "Domain verification could not be checked."
                : "No verified domains are available."}{" "}
              You can enter a domain manually. Receiving mail requires a configured, verified
              domain.{" "}
              <a href={links.domains} className="text-accent underline">
                Manage domains
              </a>
            </p>
          ) : null}
          <label className="grid gap-1.5 font-semibold">
            Display name (optional)
            <input
              className={inputClasses}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <ErrorNotice error={create.error} />
          <div className="flex gap-2.5">
            <Button
              variant="primary"
              type="submit"
              disabled={domains.isPending || !username.trim() || !selectedDomain.trim()}
            >
              {create.isPending ? "Creating..." : "Create inbox"}
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </fieldset>
      </form>
    </Page>
  );
}

export function EditInbox({
  inbox,
  onClose,
  onDeleted,
}: {
  inbox: Inbox;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const [displayName, setDisplayName] = useState(inbox.display_name ?? "");
  const [status, setStatus] = useState<InboxStatus>(inbox.status ?? "active");
  const [confirming, setConfirming] = useState(false);
  const update = useMutation({
    mutationFn: () => api.updateInbox(inbox.inbox_id, { display_name: displayName.trim(), status }),
    onSuccess: async (updated) => {
      await client.cancelQueries({ queryKey: inboxesQuery.queryKey });
      client.setQueryData(inboxesQuery.queryKey, (current) =>
        current?.map((item) => (item.inbox_id === updated.inbox_id ? updated : item)),
      );
      await client.invalidateQueries({ queryKey: inboxesQuery.queryKey });
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteInbox(inbox.inbox_id),
    onSuccess: async () => {
      await client.cancelQueries({ queryKey: inboxesQuery.queryKey });
      await client.cancelQueries({ queryKey: ["threads", inbox.inbox_id] });
      await client.cancelQueries({ queryKey: ["thread", inbox.inbox_id] });
      client.removeQueries({ queryKey: ["threads", inbox.inbox_id] });
      client.removeQueries({ queryKey: ["thread", inbox.inbox_id] });
      client.setQueryData(inboxesQuery.queryKey, (current) =>
        current?.filter((item) => item.inbox_id !== inbox.inbox_id),
      );
      await Promise.all(
        ["inboxes", "approvals", "draft", "drafts", "lists", "rejections"].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      );
      onDeleted();
    },
  });
  const busy = update.isPending || remove.isPending;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy && !confirming) update.mutate();
  };
  return (
    <Page barTitle="Manage inbox" title="Inbox settings" lead={inbox.email}>
      <form onSubmit={submit} className="max-w-md" aria-busy={busy}>
        <fieldset disabled={busy || confirming} className="space-y-5">
          <label className="grid gap-1.5 font-semibold">
            Display name
            <input
              autoFocus
              className={inputClasses}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <div>
            <p className="mb-2 font-semibold">Status</p>
            <Segmented
              name="Inbox status"
              value={status}
              onChange={setStatus}
              options={[
                { value: "active", label: "Active" },
                { value: "paused", label: "Paused" },
              ]}
            />
            <p className="mt-3 text-sm text-ink2">
              Pausing stops sending and inbound processing. Existing mail stays available.
            </p>
          </div>
          <ErrorNotice error={update.error} />
          <div className="flex gap-2.5">
            <Button type="submit" variant="primary">
              {update.isPending ? "Saving..." : "Save changes"}
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </fieldset>
      </form>
      <section
        aria-labelledby="delete-inbox-title"
        className="mt-9 max-w-md border-t border-line pt-6"
      >
        <h2 id="delete-inbox-title" className="font-semibold">
          Delete inbox
        </h2>
        <p className="mt-2 text-ink2">
          Deleting this inbox permanently deletes all its mail. This cannot be undone.
        </p>
        <ErrorNotice error={remove.error} />
        {confirming ? (
          <div className="mt-4 space-y-3" role="alert">
            <p>Delete {inbox.email}? All mail in this inbox will be permanently deleted.</p>
            <div className="flex flex-wrap gap-2.5">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  if (!busy) remove.mutate();
                }}
              >
                {remove.isPending ? "Deleting..." : "Permanently delete inbox"}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  remove.reset();
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            className="mt-4"
            variant="danger"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Delete inbox
          </Button>
        )}
      </section>
    </Page>
  );
}
