import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { Button, Status } from "../components/ui";
import { ErrorNotice, LoadError } from "../feedback";
import { quarantineQuery } from "../queries";

function sentence(code: string) {
  const text = code.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function Quarantine() {
  const client = useQueryClient();
  const [pageToken, setPageToken] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState<string>();
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
        Inbound mail that could not be processed stays here, still encrypted in the buffer. Fix the
        cause, then retry it, or delete it permanently.
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
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {query.data.items.map((item) => {
            const details = [
              item.source_kind === "buffer_object" ? "Encrypted buffer object" : "Queue message",
              item.size !== null ? formatBytes(item.size) : null,
              item.attempts !== null
                ? `${item.attempts} ${item.attempts === 1 ? "attempt" : "attempts"}`
                : null,
            ].filter((value) => value !== null);
            const start = () => {
              retry.reset();
              remove.reset();
              setNotice("");
            };
            return (
              <li key={item.quarantine_id} className="py-4">
                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                  <div className="min-w-0">
                    <Status tone="warn" icon="alert" className="text-[13px]">
                      {sentence(item.reason_code)}
                    </Status>
                    <p className="mt-1 text-xs text-ink2">
                      {details.join(" · ")} ·{" "}
                      <time dateTime={item.first_seen}>
                        {new Date(item.first_seen).toLocaleString()}
                      </time>
                    </p>
                    {item.status !== "quarantined" ? (
                      <p role="status" className="mt-1 text-xs text-ink2">
                        {item.status === "delete_pending"
                          ? "Deleted locally. Waiting for buffer cleanup."
                          : "Processed. Waiting for buffer cleanup."}
                      </p>
                    ) : item.source_kind === "queue_message" ? (
                      <p className="mt-1 text-xs text-ink2">
                        Only metadata remains. Retry its buffer object if one is listed.
                      </p>
                    ) : null}
                  </div>
                  {confirming === item.quarantine_id ? null : (
                    <div className="flex gap-2">
                      {item.source_kind === "buffer_object" && item.status !== "delete_pending" ? (
                        <Button
                          disabled={busy}
                          aria-label={`Retry ${sentence(item.reason_code).toLowerCase()} item`}
                          onClick={() => {
                            start();
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
                        onClick={() => {
                          start();
                          setConfirming(item.quarantine_id);
                        }}
                      >
                        {remove.isPending && remove.variables === item.quarantine_id
                          ? "Deleting..."
                          : "Delete"}
                      </Button>
                    </div>
                  )}
                </div>
                {confirming === item.quarantine_id ? (
                  <div role="group" aria-label="Confirm deletion" className="mt-3">
                    <p className="mb-3 text-sm text-ink2">
                      {item.source_kind === "buffer_object"
                        ? "This permanently deletes the encrypted message from the buffer. It cannot be recovered."
                        : "This deletes the remaining metadata."}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => {
                          setConfirming(undefined);
                          remove.mutate(item.quarantine_id);
                        }}
                      >
                        Delete permanently
                      </Button>
                      <Button disabled={busy} onClick={() => setConfirming(undefined)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
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
