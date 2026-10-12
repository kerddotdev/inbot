import { RejectedMail } from "./RejectedMail";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Direction, ListType } from "@inbot/contracts/src/lists.js";
import { api, type ListSelection } from "../api";
import { Select } from "../components/Select";
import { Button, inputClasses, Status } from "../components/ui";
import { ErrorNotice, LoadError } from "../feedback";
import { inboxesQuery, listEntriesQuery } from "../queries";

function EntryList({ selection }: { selection: ListSelection }) {
  const client = useQueryClient();
  const [pageToken, setPageToken] = useState<string | null>(null);
  const [entry, setEntry] = useState("");
  const [reason, setReason] = useState("");
  const query = useQuery(listEntriesQuery(selection, pageToken));
  const refresh = async () => {
    setPageToken(null);
    await client.invalidateQueries({ queryKey: ["lists"] });
  };
  const create = useMutation({
    mutationFn: (input: { entry: string; reason?: string }) =>
      api.createListEntry(selection, input),
    onSuccess: async () => {
      setEntry("");
      setReason("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (value: string) => api.deleteListEntry(selection, value),
    onSuccess: refresh,
  });
  const busy = create.isPending || remove.isPending;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    remove.reset();
    create.mutate({ entry: entry.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) });
  };
  return (
    <>
      {query.isPending ? (
        <p role="status" className="mt-4 text-ink2">
          Loading entries...
        </p>
      ) : query.error ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <div role="status" className="mt-5">
            <Status tone={selection.type === "block" ? "warn" : "ok"} icon="shield-check">
              {selection.type === "block" ? "Block list" : "Allow list"}
            </Status>
          </div>
          {query.data?.entries.length === 0 ? (
            <p className="mt-3 text-ink2">
              No entries in this list. Global and inbox rules still apply together.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {query.data?.entries.map((item) => (
                <li key={item.entry} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="break-all font-mono text-sm">{item.entry}</p>
                    {item.reason ? (
                      <p className="mt-1 break-words text-sm text-ink2">{item.reason}</p>
                    ) : null}
                  </div>
                  <Button
                    icon="minus-circle"
                    variant="danger"
                    disabled={busy}
                    aria-label={`Remove ${item.entry}`}
                    onClick={() => {
                      create.reset();
                      remove.mutate(item.entry);
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {pageToken !== null || query.data?.next_page_token ? (
            <div className="mt-3 flex gap-3">
              {pageToken !== null ? (
                <Button disabled={busy} onClick={() => setPageToken(null)}>
                  First page
                </Button>
              ) : null}
              {query.data?.next_page_token ? (
                <Button
                  disabled={busy}
                  onClick={() => setPageToken(query.data?.next_page_token ?? null)}
                >
                  Next page
                </Button>
              ) : null}
            </div>
          ) : null}
          <form onSubmit={submit} className="mt-5">
            <fieldset disabled={busy} className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block font-medium">Address or domain</span>
                <input
                  className={`${inputClasses} font-mono`}
                  value={entry}
                  onChange={(event) => setEntry(event.target.value)}
                  placeholder="person@example.com or example.com"
                  required
                  maxLength={320}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block font-medium">Reason (optional)</span>
                <input
                  className={inputClasses}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={2048}
                />
              </label>
              <Button type="submit" variant="primary" icon="plus" disabled={busy}>
                {create.isPending ? "Adding..." : "Add entry"}
              </Button>
            </fieldset>
          </form>
        </>
      )}
      <ErrorNotice error={create.error ?? remove.error} />
    </>
  );
}

export function ListManagement() {
  const inboxes = useQuery(inboxesQuery);
  const [inboxId, setInboxId] = useState("");
  const [direction, setDirection] = useState<Direction>("receive");
  const [type, setType] = useState<ListType>("block");
  const selection = { direction, type, ...(inboxId ? { inboxId } : {}) };
  return (
    <section aria-labelledby="mail-lists-title" className="mt-9 max-w-xl border-t border-line pt-6">
      <h2 id="mail-lists-title" className="font-semibold">
        Allow and block lists
      </h2>
      <p className="mt-2 text-ink2">
        Global and inbox entries apply together. Blocks always win. When allow entries exist for a
        direction, only matching addresses or domains are permitted. Reply rules apply in addition
        to send rules.
      </p>
      <p className="mt-2 text-sm text-ink2">
        Domains match exactly, without subdomains. Addresses match case-insensitively. Removing the
        last allow entry lifts the allow restriction. Blocked inbound mail leaves a durable local
        rejection record.
      </p>
      {inboxes.error ? (
        <LoadError error={inboxes.error} retry={() => void inboxes.refetch()} />
      ) : null}
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <Select
          label="Scope"
          value={inboxId}
          onChange={setInboxId}
          options={[
            { value: "", label: "Global" },
            ...(inboxes.data ?? []).map((inbox) => ({
              value: inbox.inbox_id,
              label: inbox.inbox_id,
            })),
          ]}
        />
        <Select
          label="Direction"
          value={direction}
          onChange={setDirection}
          options={[
            { value: "receive", label: "Receive" },
            { value: "send", label: "Send" },
            { value: "reply", label: "Reply" },
          ]}
        />
        <Select
          label="List"
          value={type}
          onChange={setType}
          options={[
            { value: "block", label: "Block" },
            { value: "allow", label: "Allow" },
          ]}
        />
      </div>
      <EntryList key={`${inboxId}/${direction}/${type}`} selection={selection} />
      <RejectedMail key={inboxId} {...(inboxId ? { inboxId } : {})} />
    </section>
  );
}
