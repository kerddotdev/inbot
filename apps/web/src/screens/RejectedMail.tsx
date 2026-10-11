import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, Status } from "../components/ui";
import { ErrorNotice, LoadError } from "../feedback";
import { rejectionsQuery } from "../queries";

export function RejectedMail({ inboxId }: { inboxId?: string }) {
  const client = useQueryClient();
  const [pageToken, setPageToken] = useState<string | null>(null);
  const query = useQuery(rejectionsQuery(inboxId, pageToken));
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRejection(id),
    onSuccess: async () => {
      setPageToken(null);
      await client.invalidateQueries({ queryKey: ["rejections"] });
    },
  });
  return (
    <section aria-labelledby="rejected-mail-title" className="mt-8 border-t border-line pt-6">
      <h3 id="rejected-mail-title" className="font-semibold">
        Rejected mail
      </h3>
      <p className="mt-2 text-sm text-ink2">
        Receive-list rejections {inboxId ? "for this inbox" : "across all inboxes"}. No message body
        or subject is retained. Deleting a record does not accept the mail.
      </p>
      <Button
        icon="refresh"
        className="mt-3"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Refresh
      </Button>
      {query.isPending ? (
        <p role="status" className="mt-4 text-ink2">
          Loading rejections...
        </p>
      ) : query.error ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : query.data.rejections.length === 0 ? (
        <p className="mt-4 text-ink2">No rejected mail.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {query.data.rejections.map((item) => (
            <li key={item.rejection_id} className="flex items-start justify-between gap-4 py-4">
              <div className="min-w-0 space-y-2">
                <Status tone="warn" icon="shield-check">
                  {item.reason_code === "blocked_sender" ? "Blocked sender" : "Sender not allowed"}
                </Status>
                <p className="break-all font-mono text-sm">
                  {item.sender_address ?? "Sender not recorded"}
                </p>
                <p className="break-all text-sm text-ink2">To: {item.inbox_id}</p>
                <time className="block text-sm text-ink2" dateTime={item.received_at}>
                  {new Date(item.received_at).toLocaleString()}
                </time>
                {item.rules.length === 0 ? (
                  <p className="text-sm text-ink2">Rule details were not recorded.</p>
                ) : (
                  <ul className="space-y-1 text-sm text-ink2">
                    {item.rules.map((rule) => (
                      <li
                        key={`${rule.inbox_id}/${rule.list_type}/${rule.entry}`}
                        className="break-words"
                      >
                        {rule.inbox_id ? "Inbox" : "Global"} {rule.list_type}:{" "}
                        <span className="font-mono">{rule.entry}</span>
                        {item.reason_code === "sender_not_allowed"
                          ? " (did not allow the sender)"
                          : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Button
                variant="danger"
                disabled={remove.isPending}
                aria-label={`Delete rejection from ${item.sender_address ?? "unknown sender"} to ${item.inbox_id}`}
                onClick={() => remove.mutate(item.rejection_id)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNotice error={remove.error} />
      <div className="mt-3 flex gap-3">
        {pageToken ? <Button onClick={() => setPageToken(null)}>First page</Button> : null}
        {query.data?.next_page_token ? (
          <Button onClick={() => setPageToken(query.data.next_page_token ?? null)}>
            Next page
          </Button>
        ) : null}
      </div>
    </section>
  );
}
