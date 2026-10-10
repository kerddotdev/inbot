import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Draft, DraftItem } from "@inbot/contracts/src/drafts.js";
import { api } from "../api";
import { approvalsQuery, keysQuery } from "../queries";
import { ErrorNotice, LoadError } from "../feedback";
import { links, navigate } from "../router";
import { Icon } from "../icons";
import {
  Button,
  Disclosure,
  focusSibling,
  inputClasses,
  ListMessage,
  PaneBar,
  SkeletonRows,
  Status,
} from "../components/ui";

function DraftRow({ draft, selected }: { draft: DraftItem; selected: boolean }) {
  return (
    <a
      data-row
      href={links.approvals(draft.draft_id)}
      aria-current={selected ? "true" : undefined}
      className="relative block border-b border-line py-[11px] pr-4 pl-7 transition-colors duration-150 hover:bg-hover aria-[current=true]:bg-sel"
    >
      <span
        aria-hidden="true"
        className="absolute top-[19px] left-3 size-2 rounded-full bg-accent"
      />
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-semibold">{draft.inbox_id}</span>
        <span className="text-xs text-ink2">{new Date(draft.updated_at).toLocaleString()}</span>
      </div>
      <div className="truncate font-medium">{draft.subject || "(No subject)"}</div>
      <div className="truncate text-[12.5px] text-ink2">
        To: {draft.to?.join(", ") || "(No recipients)"}
      </div>
    </a>
  );
}

function DraftView({ draft, onDecision }: { draft: Draft; onDecision: (message: string) => void }) {
  const client = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [approvalKey] = useState(() => crypto.randomUUID());
  const decision = useMutation({
    mutationFn: (kind: "approve" | "reject") =>
      kind === "approve" ? api.approve(draft, approvalKey) : api.reject(draft, reason),
    onSuccess: () => {
      client.setQueryData(approvalsQuery.queryKey, (items) =>
        items?.filter((item) => item.draft_id !== draft.draft_id),
      );
      void client.invalidateQueries({ queryKey: ["approvals"] });
      void client.invalidateQueries({ queryKey: ["threads"] });
    },
  });
  const decide = (kind: "approve" | "reject") =>
    decision.mutate(kind, {
      onSuccess: (result) => {
        onDecision(
          kind === "reject"
            ? "Draft rejected"
            : "draft_id" in result
              ? result.send_status === "scheduled"
                ? "Draft approved for scheduled sending"
                : "Draft approved"
              : "Message queued",
        );
        navigate(links.approvals());
      },
    });
  return (
    <article aria-label="Draft" className="flex min-h-0 min-w-0 flex-col bg-win">
      <PaneBar>
        <Status tone="warn" icon="minus-circle" small={false}>
          Awaiting approval
        </Status>
      </PaneBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[604px] px-8 pt-[30px] pb-16">
          <h1 className="mb-2 font-serif text-[30px] leading-[1.18] font-medium tracking-[-0.012em] text-balance">
            {draft.subject || "(No subject)"}
          </h1>
          <p className="mb-[26px] text-ink2">
            Draft from {draft.inbox_id}. Nothing is sent until you approve.
          </p>
          <dl className="mb-6 grid grid-cols-[64px_1fr] gap-y-1.5">
            <dt className="text-ink2">From</dt>
            <dd>{draft.inbox_id}</dd>
            <dt className="text-ink2">To</dt>
            <dd>{draft.to?.join(", ") || "(No recipients)"}</dd>
            <dt className="text-ink2">Subject</dt>
            <dd>{draft.subject || "(No subject)"}</dd>
          </dl>
          {draft.cc?.length ? <p className="mb-2 text-ink2">Cc: {draft.cc.join(", ")}</p> : null}
          {draft.bcc?.length ? <p className="mb-2 text-ink2">Bcc: {draft.bcc.join(", ")}</p> : null}
          {draft.send_at ? (
            <p className="mb-4 text-ink2">
              Scheduled for {new Date(draft.send_at).toLocaleString()}. Sending requires the service
              to be running.
            </p>
          ) : null}
          <div className="font-serif text-[17px] leading-[1.6]">
            <p className="mb-[.7em] whitespace-pre-wrap last:mb-0">
              {draft.text ?? "This draft has no plain-text body."}
            </p>
          </div>
          {draft.html ? (
            <Disclosure label="Show HTML source">
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{draft.html}</pre>
            </Disclosure>
          ) : null}
          {draft.attachments?.map((attachment) => (
            <p key={attachment.attachment_id} className="mt-3 flex items-center gap-2">
              <Icon name="file" />
              {attachment.filename ?? "Attachment"} ({Math.ceil(attachment.size / 1024)} KB)
            </p>
          ))}
          <ErrorNotice error={decision.error} />
          <div className="mt-7 flex flex-wrap items-center gap-2.5">
            <Button
              variant="primary"
              icon="send"
              disabled={decision.isPending}
              onClick={() => decide("approve")}
            >
              {decision.isPending
                ? "Saving decision..."
                : draft.send_at
                  ? "Approve scheduled send"
                  : "Approve and send"}
            </Button>
            <Button
              variant="danger"
              icon="x-circle"
              disabled={decision.isPending}
              onClick={() => setRejecting(true)}
            >
              Reject
            </Button>
          </div>
          {rejecting ? (
            <form
              className="mt-4 grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!decision.isPending) decide("reject");
              }}
            >
              <label className="grid gap-1.5">
                Reason (optional)
                <input
                  className={inputClasses}
                  disabled={decision.isPending}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <div className="flex gap-2">
                <Button type="submit" variant="danger" disabled={decision.isPending}>
                  Confirm rejection
                </Button>
                <Button disabled={decision.isPending} onClick={() => setRejecting(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}
          <div className="mt-7 flex gap-2.5 border-t border-line pt-4 text-ink2">
            <Icon name="key" className="mt-0.5" />
            <p>
              Created by <CreatorName id={draft.created_by} /> at{" "}
              {new Date(draft.created_at).toLocaleString()}.
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}

function DraftReader({ id, onDecision }: { id: string; onDecision: (message: string) => void }) {
  const query = useQuery({
    queryKey: ["draft", id],
    queryFn: ({ signal }) => api.draft(id, signal),
  });
  if (query.isPending) return <ListMessage icon="check-circle" title="Loading draft" />;
  if (query.error) return <LoadError error={query.error} retry={() => void query.refetch()} />;
  if (!query.data.pending_approval)
    return <ListMessage icon="check-circle" title="This draft no longer awaits approval" />;
  return <DraftView key={id} draft={query.data} onDecision={onDecision} />;
}

export function Approvals({ selectedId }: { selectedId: string | undefined }) {
  const query = useQuery(approvalsQuery);
  const [notice, setNotice] = useState("");
  const drafts = query.data ?? [];
  const id = selectedId ?? drafts[0]?.draft_id;
  return (
    <>
      {notice ? (
        <div role="status" className="border-b border-line px-4 py-2">
          <Status tone="mute" icon="check-circle">
            {notice}
          </Status>
          <Button variant="quiet" className="ml-2" onClick={() => setNotice("")}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,348px)_1fr]">
        <section
          aria-label="Pending drafts"
          className="flex min-h-0 min-w-0 flex-col border-r border-line bg-list"
        >
          <PaneBar>
            <h2 className="text-[15px] font-[650] tracking-[-0.005em]">Approvals</h2>
            <span className="flex-1" />
            {query.data ? <span className="text-ink2">{drafts.length} pending</span> : null}
            <Button
              variant="quiet"
              icon="refresh"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
          </PaneBar>
          <div className="min-h-0 flex-1 overflow-y-auto" onKeyDown={focusSibling}>
            {query.isPending ? (
              <SkeletonRows />
            ) : query.error ? (
              <LoadError error={query.error} retry={() => void query.refetch()} />
            ) : drafts.length === 0 ? (
              <ListMessage icon="check-circle" title="Nothing to approve">
                Drafts from agents with an approval send policy will wait here.
              </ListMessage>
            ) : (
              drafts.map((draft) => (
                <DraftRow key={draft.draft_id} draft={draft} selected={draft.draft_id === id} />
              ))
            )}
          </div>
        </section>
        {id ? (
          <DraftReader key={id} id={id} onDecision={setNotice} />
        ) : (
          <article aria-label="Draft" className="flex min-h-0 min-w-0 flex-col bg-win">
            <PaneBar />
            <div className="grid flex-1 place-items-center text-ink2">
              Select a draft to review it.
            </div>
          </article>
        )}
      </div>
    </>
  );
}

function CreatorName({ id }: { readonly id: string | undefined }) {
  const keys = useQuery(keysQuery);
  const name = keys.data?.find((key) => key.api_key_id === id)?.name;
  if (name !== undefined) return <span className="font-medium text-ink">{name}</span>;
  return <span className="font-mono text-xs">{id ?? "an unknown creator"}</span>;
}
