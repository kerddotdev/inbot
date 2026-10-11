import { hasQuotedText } from "../mail-text";
import { useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ThreadItem } from "@inbot/contracts/src/threads.js";
import type { Message } from "@inbot/contracts/src/messages.js";
import { type IconName } from "../icons";
import { AttachmentDownload } from "../components/AttachmentDownload";
import { api } from "../api";
import { links, navigate } from "../router";
import { ErrorNotice, LoadError } from "../feedback";
import {
  Button,
  Disclosure,
  focusSibling,
  IconButton,
  inputClasses,
  ListMessage,
  PaneBar,
  SkeletonRows,
  Status,
  type Tone,
} from "../components/ui";

const deliveryDisplay: { label: string; value: string; tone: Tone; icon: IconName }[] = [
  { value: "send_unknown", tone: "warn", icon: "alert", label: "Send outcome unknown" },
  { value: "bounced", tone: "bad", icon: "alert", label: "Bounced" },
  { value: "complained", tone: "warn", icon: "alert", label: "Complaint received" },
  { value: "rejected", tone: "bad", icon: "x-circle", label: "Rejected" },
  { value: "failed", tone: "bad", icon: "x-circle", label: "Failed" },
  { value: "delivered", tone: "ok", icon: "check-circle", label: "Delivered" },
  { value: "deferred", tone: "warn", icon: "minus-circle", label: "Deferred" },
  { value: "queued", tone: "mute", icon: "minus-circle", label: "Queued" },
  { value: "sent", tone: "mute", icon: "send", label: "Sent" },
];

function delivery(labels: readonly string[]) {
  return deliveryDisplay.find((status) => labels.includes(status.value));
}

function ThreadRow({ thread, selected }: { thread: ThreadItem; selected: boolean }) {
  const unread = thread.labels.includes("unread");
  const tag = thread.labels.includes("send_unknown")
    ? delivery(thread.labels)
    : thread.labels.includes("unauthenticated")
      ? ({ tone: "warn", icon: "shield-alert", label: "Unauthenticated" } satisfies {
          tone: Tone;
          icon: IconName;
          label: string;
        })
      : delivery(thread.labels);
  return (
    <a
      data-row
      href={links.inbox(thread.inbox_id, thread.thread_id)}
      aria-current={selected ? "true" : undefined}
      className="relative block border-b border-line py-[11px] pr-4 pl-7 transition-colors duration-150 hover:bg-hover aria-[current=true]:bg-sel"
    >
      {unread ? (
        <span
          aria-hidden="true"
          className="absolute top-[19px] left-3 size-2 rounded-full bg-accent"
        />
      ) : null}
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-semibold">
          {unread ? <span className="sr-only">Unread: </span> : null}
          {thread.senders.join(", ")}
        </span>
        <time dateTime={thread.timestamp} className="text-xs text-ink2">
          {new Date(thread.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
      <div className="truncate font-medium">{thread.subject || "(No subject)"}</div>
      <div className="line-clamp-2 text-[12.5px] text-ink2">{thread.preview}</div>
      {tag ? (
        <Status tone={tag.tone} icon={tag.icon} className="mt-1 text-xs">
          {tag.label}
        </Status>
      ) : null}
      {!tag && thread.attachments?.length ? (
        <Status tone="mute" icon="clip" className="mt-1 text-xs">
          {thread.attachments.length} attachments
        </Status>
      ) : null}
    </a>
  );
}

function MessageView({ message }: { message: Message }) {
  const observed = delivery(message.labels);
  const status =
    message.send_status === "sending"
      ? { tone: "mute" as const, icon: "send" as const, label: "Sending" }
      : message.send_status === "sent" && observed?.value === "failed"
        ? { ...observed, label: "Delivery failed" }
        : observed;
  const client = useQueryClient();
  const [resolving, setResolving] = useState(false);
  const resolve = useMutation({
    mutationFn: (decision: "sent" | "failed") =>
      api.resolveMessage(message.inbox_id, message.message_id, { decision }),
    onSuccess: () => {
      setResolving(false);
      for (const key of ["threads", "thread", "inboxes"])
        void client.invalidateQueries({ queryKey: [key] });
    },
  });
  const body = message.extracted_text ?? message.text;
  return (
    <article className="border-t border-line py-5 first:border-t-0 first:pt-0">
      <header className="mb-2 flex items-baseline gap-2">
        <span className="font-semibold">{message.from}</span>
        <span className="text-xs text-ink2">
          {message.labels.includes("received") ? "Received" : status ? "Outgoing" : ""}
        </span>
        <time dateTime={message.timestamp} className="ml-auto text-xs whitespace-nowrap text-ink2">
          {new Date(message.timestamp).toLocaleString()}
        </time>
      </header>
      <Disclosure label="Recipients">
        <p className="mt-2 text-ink2">
          To: {message.to.join(", ")}
          {message.cc?.length ? `; Cc: ${message.cc.join(", ")}` : ""}
          {message.bcc?.length ? `; Bcc: ${message.bcc.join(", ")}` : ""}
        </p>
      </Disclosure>
      <div className="font-serif text-[17px] leading-[1.6]">
        <p className="mb-[.7em] whitespace-pre-wrap last:mb-0">
          {body ?? "This message has no plain-text body."}
        </p>
      </div>
      {body === undefined && message.html ? (
        <Disclosure label="Show HTML source">
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{message.html}</pre>
        </Disclosure>
      ) : null}
      {message.attachments?.map((attachment) => (
        <AttachmentDownload
          key={attachment.attachment_id}
          attachment={attachment}
          download={() => api.messageAttachment(message, attachment.attachment_id)}
        />
      ))}
      {status ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-[18px] text-[12.5px]">
          <Status tone={status.tone} icon={status.icon}>
            {status.label}
          </Status>
        </div>
      ) : null}
      {message.send_status === "send_unknown" ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-ink2">
            The provider may have sent this message. Check delivery before deciding. Do not resend
            while the outcome is unknown.
          </p>
          {resolving ? (
            <div className="space-y-3">
              <p className="text-sm">
                Confirm the outcome. This only records your decision; it does not send mail. After
                confirming it was not sent, you can compose a new message deliberately.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button disabled={resolve.isPending} onClick={() => resolve.mutate("sent")}>
                  I confirmed it was sent
                </Button>
                <Button disabled={resolve.isPending} onClick={() => resolve.mutate("failed")}>
                  I confirmed it was not sent
                </Button>
                <Button
                  variant="quiet"
                  disabled={resolve.isPending}
                  onClick={() => {
                    setResolving(false);
                    resolve.reset();
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={() => setResolving(true)}>Resolve outcome</Button>
          )}
          {resolve.error ? <ErrorNotice error={resolve.error} /> : null}
        </div>
      ) : message.send_status === "failed" ? (
        <p className="mt-3 text-sm text-ink2">
          Not sent.{" "}
          {message.send_reason ? `Reason: ${message.send_reason}.` : "The send permanently failed."}
        </p>
      ) : null}
      {hasQuotedText(message.text, message.extracted_text) ? (
        <Disclosure label="Show quoted text">
          <blockquote className="mt-2 whitespace-pre-wrap border-l border-line pl-3.5 font-serif text-[15px] leading-[1.55] text-ink2">
            {message.text}
          </blockquote>
        </Disclosure>
      ) : null}
    </article>
  );
}

function Composer({
  inboxId,
  replyTo,
  onClose,
  onQueued,
}: {
  inboxId: string;
  replyTo?: Message;
  onClose: () => void;
  onQueued: (threadId: string) => void;
}) {
  const client = useQueryClient();
  const [to, setTo] = useState(replyTo?.reply_to?.join(", ") ?? replyTo?.from ?? "");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const attempt = useRef<{ payload: string; key: string }>(undefined);
  const send = useMutation({
    mutationFn: async () => {
      const body = replyTo ? { to, text } : { to, subject, text };
      const payload = JSON.stringify(body);
      if (attempt.current?.payload !== payload)
        attempt.current = { payload, key: crypto.randomUUID() };
      return replyTo
        ? api.reply(inboxId, replyTo.message_id, body, attempt.current.key)
        : api.send(inboxId, body, attempt.current.key);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["threads", inboxId] });
      void client.invalidateQueries({ queryKey: ["thread", inboxId] });
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!send.isPending)
      send.mutate(undefined, { onSuccess: (result) => onQueued(result.thread_id) });
  };
  return (
    <form
      onSubmit={submit}
      className="mt-7 border-t border-line pt-5"
      aria-label={replyTo ? "Reply" : "New message"}
      aria-busy={send.isPending}
    >
      <fieldset disabled={send.isPending} className="grid gap-3">
        <label className="grid gap-1.5 font-semibold">
          To
          <input
            autoFocus
            required
            className={inputClasses}
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        {!replyTo ? (
          <label className="grid gap-1.5 font-semibold">
            Subject
            <input
              className={inputClasses}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </label>
        ) : null}
        <label className="grid gap-1.5 font-semibold">
          Message
          <textarea
            required
            rows={7}
            className={`${inputClasses} font-serif text-[17px] font-normal`}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <ErrorNotice error={send.error} />
        <div className="flex gap-2.5">
          <Button variant="primary" icon="send" type="submit">
            {send.isPending ? "Queueing..." : "Send"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </fieldset>
    </form>
  );
}

function Reader({
  inboxId,
  threadId,
  onQueued,
}: {
  inboxId: string;
  threadId: string | undefined;
  onQueued: (threadId: string) => void;
}) {
  const client = useQueryClient();
  const [replying, setReplying] = useState(false);
  const [label, setLabel] = useState("");
  const query = useInfiniteQuery({
    queryKey: ["thread", inboxId, threadId],
    enabled: threadId !== undefined,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.thread(inboxId, threadId ?? "", pageParam, signal),
    getNextPageParam: (page) => page.next_page_token,
  });
  const thread = query.data?.pages[0];
  const messages = query.data?.pages.toReversed().flatMap((page) => page.messages) ?? [];
  const update = useMutation({
    mutationFn: (request: { add_labels?: string[]; remove_labels?: string[] }) =>
      api.updateThread(inboxId, threadId ?? "", request),
    onSuccess: () => {
      setLabel("");
      void client.invalidateQueries({ queryKey: ["thread", inboxId, threadId] });
      void client.invalidateQueries({ queryKey: ["threads", inboxId] });
    },
  });
  const latest =
    messages.findLast((message) => message.labels.includes("received")) ?? messages.at(-1);
  const unread = thread?.labels.includes("unread");
  const queued = (id: string) => {
    setReplying(false);
    onQueued(id);
  };
  return (
    <article aria-label="Thread" className="flex min-h-0 min-w-0 flex-col bg-win">
      <PaneBar>
        {thread ? (
          <>
            <IconButton
              icon="reply"
              label="Reply"
              onClick={() => setReplying(true)}
              disabled={!latest || replying}
            />
            <IconButton
              icon={unread ? "check-circle" : "inbox"}
              label={unread ? "Mark read" : "Mark unread"}
              disabled={update.isPending}
              onClick={() =>
                update.mutate(unread ? { remove_labels: ["unread"] } : { add_labels: ["unread"] })
              }
            />
            <span className="flex-1" />
            {thread.labels.includes("unauthenticated") ? (
              <Status tone="warn" icon="shield-alert">
                Unauthenticated
              </Status>
            ) : null}
          </>
        ) : null}
      </PaneBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!threadId ? (
          <div className="grid h-full place-items-center text-ink2">
            Select a thread to read it.
          </div>
        ) : query.isPending ? (
          <ListMessage icon="inbox" title="Loading thread" />
        ) : query.error && !thread ? (
          <LoadError error={query.error} retry={() => void query.refetch()} />
        ) : thread ? (
          <div className="mx-auto w-full max-w-[604px] px-8 pt-[30px] pb-16">
            <h1 className="mb-2 font-serif text-[30px] leading-[1.18] font-medium tracking-[-0.012em] text-balance">
              {thread.subject || "(No subject)"}
            </h1>
            <p className="mb-[26px] text-ink2">
              <b className="font-semibold text-ink">{thread.inbox_id}</b> with{" "}
              {thread.senders.join(", ")} - {thread.message_count}{" "}
              {thread.message_count === 1 ? "message" : "messages"}
            </p>
            {query.error ? (
              <LoadError error={query.error} retry={() => void query.refetch()} />
            ) : null}
            <ErrorNotice error={update.error} />
            <Disclosure label="Labels">
              <div className="mt-2 flex flex-wrap gap-2">
                {thread.labels.map((value) => (
                  <Button
                    key={value}
                    icon="x-circle"
                    disabled={update.isPending}
                    aria-label={`Remove label ${value}`}
                    onClick={() => update.mutate({ remove_labels: [value] })}
                  >
                    {value}
                  </Button>
                ))}
              </div>
              <form
                className="my-3 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (label.trim() && !update.isPending)
                    update.mutate({ add_labels: [label.trim()] });
                }}
              >
                <input
                  aria-label="New label"
                  className={inputClasses}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
                <Button type="submit" disabled={!label.trim() || update.isPending}>
                  Add label
                </Button>
              </form>
            </Disclosure>
            {query.hasNextPage ? (
              <Button
                icon="inbox"
                className="mb-5"
                disabled={query.isFetching}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? "Loading..." : "Load older messages"}
              </Button>
            ) : null}
            {messages.map((message) => (
              <MessageView key={message.message_id} message={message} />
            ))}
            {replying && latest ? (
              <Composer
                inboxId={inboxId}
                replyTo={latest}
                onClose={() => setReplying(false)}
                onQueued={queued}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function InboxMail({
  inboxId,
  selectedId,
  onManageInbox,
}: {
  inboxId: string;
  selectedId: string | undefined;
  onManageInbox: () => void;
}) {
  const [composing, setComposing] = useState(false);
  const [queued, setQueued] = useState(false);
  const threads = useInfiniteQuery({
    queryKey: ["threads", inboxId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.threads(inboxId, pageParam, signal),
    getNextPageParam: (page) => page.next_page_token,
  });
  const items = threads.data?.pages.flatMap((page) => page.threads) ?? [];
  return (
    <>
      {queued ? (
        <div role="status" className="border-b border-line px-4 py-2">
          <Status tone="mute" icon="minus-circle">
            Message queued
          </Status>
          <Button variant="quiet" className="ml-2" onClick={() => setQueued(false)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,348px)_1fr]">
        <section
          aria-label="Threads"
          className="flex min-h-0 min-w-0 flex-col border-r border-line bg-list"
        >
          <PaneBar>
            <h2
              className="min-w-0 truncate text-[15px] font-[650] tracking-[-0.005em]"
              title={inboxId}
            >
              {inboxId}
            </h2>
            <span className="flex-1" />
            <IconButton icon="gear" label="Manage inbox" onClick={onManageInbox} />
            <IconButton icon="pencil" label="New message" onClick={() => setComposing(true)} />
            <IconButton
              icon="refresh"
              label="Refresh"
              disabled={threads.isFetching}
              onClick={() => void threads.refetch()}
            />
          </PaneBar>
          <div className="min-h-0 flex-1 overflow-y-auto" onKeyDown={focusSibling}>
            {threads.isPending ? (
              <SkeletonRows />
            ) : threads.error && !threads.data ? (
              <LoadError error={threads.error} retry={() => void threads.refetch()} />
            ) : items.length === 0 ? (
              <ListMessage icon="inbox" title="No mail yet">
                Messages sent to {inboxId} will appear here.
              </ListMessage>
            ) : (
              items.map((thread) => (
                <ThreadRow
                  key={thread.thread_id}
                  thread={thread}
                  selected={thread.thread_id === selectedId}
                />
              ))
            )}
            {threads.data && threads.error ? (
              <LoadError error={threads.error} retry={() => void threads.refetch()} />
            ) : null}
            {threads.hasNextPage ? (
              <div className="p-4">
                <Button disabled={threads.isFetching} onClick={() => void threads.fetchNextPage()}>
                  {threads.isFetchingNextPage ? "Loading..." : "Load more threads"}
                </Button>
              </div>
            ) : null}
          </div>
        </section>
        {composing ? (
          <article aria-label="New message" className="flex min-h-0 min-w-0 flex-col bg-win">
            <PaneBar>
              <h2 className="font-semibold">New message</h2>
            </PaneBar>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-[604px] px-8 pt-[30px] pb-16">
                <Composer
                  inboxId={inboxId}
                  onClose={() => setComposing(false)}
                  onQueued={(id) => {
                    setComposing(false);
                    setQueued(true);
                    navigate(links.inbox(inboxId, id));
                  }}
                />
              </div>
            </div>
          </article>
        ) : (
          <Reader
            key={selectedId}
            inboxId={inboxId}
            threadId={selectedId}
            onQueued={(id) => {
              setQueued(true);
              navigate(links.inbox(inboxId, id));
            }}
          />
        )}
      </div>
    </>
  );
}

export function Mail({
  inboxId,
  selectedId,
  onManageInbox,
}: {
  inboxId: string | undefined;
  selectedId: string | undefined;
  onManageInbox: () => void;
}) {
  return inboxId ? (
    <InboxMail inboxId={inboxId} selectedId={selectedId} onManageInbox={onManageInbox} />
  ) : null;
}
