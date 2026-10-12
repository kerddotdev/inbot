import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { Button, Status } from "../components/ui";
import { ErrorNotice, LoadError } from "../feedback";
import { quarantineQuery } from "../queries";

export function Quarantine() {
  const client = useQueryClient();
  const [pageToken, setPageToken] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const query = useQuery(quarantineQuery(pageToken));
  const refresh = async () => {
    setPageToken(null);
    await client.invalidateQueries({ queryKey: ["quarantine"] });
  };
  const retry = useMutation({
    mutationFn: (id: string) => api.retryQuarantine(id),
    onSuccess: async (result) => {
      setNotice(
        result.status === "released"
          ? "The item was processed and its ciphertext removed."
          : `The item is still quarantined: ${result.item?.reason_code ?? "unknown"}.`,
      );
      await refresh();
    },
    onError: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteQuarantine(id),
    onSuccess: async () => {
      setNotice("The quarantine item was deleted.");
      await refresh();
    },
    onError: () => void refresh(),
  });
  const busy = retry.isPending || remove.isPending;
  return (
    <section aria-labelledby="quarantine-title" className="mt-8 max-w-xl border-t border-line pt-6">
      <h2 id="quarantine-title" className="font-semibold">
        Quarantine
      </h2>
      <p className="mt-2 max-w-xl text-sm text-ink2">
        Inbound items that could not be processed. Mail stays encrypted in the buffer. Retry buffer
        objects after fixing the cause, or permanently delete them. Invalid Queue messages retain
        metadata only.
      </p>
      <Button
        icon="refresh"
        className="mt-3"
        disabled={busy || query.isFetching}
        onClick={() => void query.refetch()}
      >
        Refresh
      </Button>
      {query.isPending ? (
        <p role="status" className="mt-4 text-ink2">
          Loading quarantine...
        </p>
      ) : query.error instanceof ApiError && query.error.code === "locked" ? (
        <p role="status" className="mt-4 text-ink2">
          Unlock the local service to view quarantine.
        </p>
      ) : query.error ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <p className="mt-4 text-ink2">No quarantined items.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {query.data.items.map((item) => (
            <li
              key={item.quarantine_id}
              className="flex flex-wrap items-start justify-between gap-4 py-4"
            >
              <div className="min-w-0 space-y-2">
                <Status tone="warn" icon="alert">
                  {item.reason_code.replaceAll("_", " ")}
                </Status>
                <p className="text-sm text-ink2">
                  {item.source_kind === "buffer_object"
                    ? "Buffer object"
                    : "Queue message metadata"}
                </p>
                <time className="block text-sm text-ink2" dateTime={item.first_seen}>
                  {new Date(item.first_seen).toLocaleString()}
                </time>
                {item.size !== null ? (
                  <p className="text-sm text-ink2">{item.size.toLocaleString()} bytes</p>
                ) : null}
                {item.attempts !== null ? (
                  <p className="text-sm text-ink2">Processing attempts: {item.attempts}</p>
                ) : null}
                {item.status !== "quarantined" ? (
                  <p role="status" className="text-sm text-ink2">
                    {item.status === "delete_pending"
                      ? "Deletion awaiting buffer cleanup."
                      : "Processed; buffer cleanup pending."}
                  </p>
                ) : null}
                {item.source_kind === "queue_message" ? (
                  <p className="text-sm text-ink2">
                    Already acknowledged. Retry its buffer object if one is listed.
                  </p>
                ) : null}
              </div>
              <div className="flex gap-2">
                {item.source_kind === "buffer_object" && item.status !== "delete_pending" ? (
                  <Button
                    disabled={busy}
                    aria-label={`Retry quarantine item ${item.quarantine_id}`}
                    onClick={() => {
                      remove.reset();
                      retry.reset();
                      setNotice("");
                      retry.mutate(item.quarantine_id);
                    }}
                  >
                    {retry.isPending && retry.variables === item.quarantine_id
                      ? "Retrying..."
                      : item.status === "release_pending"
                        ? "Finish cleanup"
                        : "Retry"}
                  </Button>
                ) : null}
                <Button
                  variant="danger"
                  disabled={busy}
                  aria-label={`Delete quarantine item ${item.quarantine_id}`}
                  onClick={() => {
                    if (
                      window.confirm(
                        item.source_kind === "buffer_object"
                          ? "Permanently delete this encrypted buffer object and its quarantine record? This cannot be undone."
                          : "Delete this invalid Queue message metadata?",
                      )
                    ) {
                      retry.reset();
                      remove.reset();
                      setNotice("");
                      remove.mutate(item.quarantine_id);
                    }
                  }}
                >
                  {remove.isPending && remove.variables === item.quarantine_id
                    ? "Deleting..."
                    : "Delete"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {notice ? (
        <p role="status" className="mt-3 text-sm text-ink2">
          {notice}
        </p>
      ) : null}
      <ErrorNotice error={retry.error ?? remove.error} />
      <div className="mt-3 flex gap-3">
        {pageToken ? (
          <Button disabled={busy} onClick={() => setPageToken(null)}>
            First page
          </Button>
        ) : null}
        {query.data?.next_page_token ? (
          <Button disabled={busy} onClick={() => setPageToken(query.data.next_page_token ?? null)}>
            Next page
          </Button>
        ) : null}
      </div>
    </section>
  );
}
