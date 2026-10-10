import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EventType } from "@inbot/contracts/src/event-types.js";
import type { Webhook } from "@inbot/contracts/src/webhooks.js";
import { api } from "../api";
import { Button, inputClasses, Status } from "../components/ui";
import { ErrorNotice, LoadError } from "../feedback";
import { webhooksQuery, inboxesQuery } from "../queries";

function WebhookRow({ hook }: { hook: Webhook }) {
  const client = useQueryClient();
  const update = useMutation({
    mutationFn: () => api.updateWebhook(hook.webhook_id, { enabled: !hook.enabled }),
    onSuccess: () => client.invalidateQueries({ queryKey: webhooksQuery.queryKey }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteWebhook(hook.webhook_id),
    onSuccess: () => client.invalidateQueries({ queryKey: webhooksQuery.queryKey }),
  });
  const busy = update.isPending || remove.isPending;
  return (
    <li className="border-b border-line py-4 last:border-b-0">
      <p className="break-all font-medium">{hook.url}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Status tone={hook.enabled ? "ok" : "warn"} icon={hook.enabled ? "check-circle" : "alert"}>
          {hook.enabled
            ? "Enabled"
            : hook.disabled_reason === "sustained_failure"
              ? "Disabled after repeated failures"
              : hook.disabled_reason === "credential_revoked"
                ? "Disabled - credential revoked"
                : "Disabled"}
        </Status>
        <span className="text-sm text-ink2">{hook.failure_count ?? 0} consecutive failures</span>
      </div>
      <p className="mt-2 text-sm text-ink2 break-words">
        {hook.event_types?.join(", ") || "No events selected"}
      </p>
      <p className="mt-1 text-sm text-ink2">
        {hook.inbox_ids === undefined
          ? "All inboxes"
          : hook.inbox_ids.join(", ") || "No inboxes selected"}
      </p>
      {hook.last_error_code ? (
        <p className="mt-1 text-sm text-bad">Last error: {hook.last_error_code}</p>
      ) : null}
      <ErrorNotice error={update.error ?? remove.error} />
      <div className="mt-3 flex gap-3">
        <Button disabled={busy} onClick={() => update.mutate()}>
          {hook.enabled ? "Disable" : "Enable and retry"}
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => remove.mutate()}>
          Delete
        </Button>
      </div>
    </li>
  );
}

export function WebhooksSettings() {
  const client = useQueryClient();
  const hooks = useQuery({ ...webhooksQuery, refetchInterval: 30_000 });
  const inboxes = useQuery(inboxesQuery);
  const [url, setUrl] = useState("");
  const [types, setTypes] = useState<readonly EventType[]>(["message.received"]);
  const [inboxId, setInboxId] = useState("");
  const [secret, setSecret] = useState<string>();
  const create = useMutation({
    mutationFn: () =>
      api.createWebhook({
        url: url.trim(),
        event_types: types,
        ...(inboxId ? { inbox_ids: [inboxId] } : {}),
      }),
    onSuccess: async (hook) => {
      setSecret(hook.secret);
      setUrl("");
      create.reset();
      await client.invalidateQueries({ queryKey: webhooksQuery.queryKey });
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!create.isPending) create.mutate();
  };
  return (
    <section aria-labelledby="webhooks-title" className="mt-9 max-w-xl border-t border-line pt-6">
      <h2 id="webhooks-title" className="font-semibold">
        Webhooks
      </h2>
      <p className="mt-2 text-ink2">
        Send signed events to your HTTPS endpoint. Delivery may repeat; deduplicate by event ID.
      </p>
      {hooks.isPending ? (
        <p role="status" className="mt-4 text-ink2">
          Loading webhooks...
        </p>
      ) : hooks.error ? (
        <LoadError error={hooks.error} retry={() => void hooks.refetch()} />
      ) : hooks.data.length ? (
        <ul className="mt-3">
          {hooks.data.map((hook) => (
            <WebhookRow key={hook.webhook_id} hook={hook} />
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-ink2">No webhooks configured.</p>
      )}
      {secret ? (
        <div role="status" className="mt-5 space-y-3">
          <p className="font-medium">Save this signing secret. It is shown only once.</p>
          <input
            aria-label="Webhook signing secret"
            className={`${inputClasses} font-mono`}
            readOnly
            value={secret}
            autoComplete="off"
          />
          <Button onClick={() => setSecret(undefined)}>I saved the secret</Button>
        </div>
      ) : null}
      <ErrorNotice error={create.error} />
      <form onSubmit={submit} className="mt-5">
        <fieldset disabled={create.isPending || secret !== undefined} className="space-y-4">
          <legend className="mb-3 font-medium">Add webhook</legend>
          <label className="block">
            <span className="mb-1.5 block">Endpoint URL</span>
            <input
              className={inputClasses}
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://your-server.example/events"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block">Inbox scope</span>
            <select
              className={inputClasses}
              value={inboxId}
              onChange={(event) => setInboxId(event.target.value)}
            >
              <option value="">All inboxes and owner domain events</option>
              {inboxes.data?.map((inbox) => (
                <option key={inbox.inbox_id} value={inbox.inbox_id}>
                  {inbox.inbox_id}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend className="mb-2">Events</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {EventType.literals.map((type) => (
                <label key={type} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={types.includes(type)}
                    onChange={(event) =>
                      setTypes((current) =>
                        event.target.checked
                          ? [...current, type]
                          : current.filter((value) => value !== type),
                      )
                    }
                  />
                  {type}
                </label>
              ))}
            </div>
          </fieldset>
          <Button type="submit" variant="primary" disabled={create.isPending || types.length === 0}>
            {create.isPending ? "Creating..." : "Create webhook"}
          </Button>
        </fieldset>
      </form>
    </section>
  );
}
