import { Icon, type IconName } from "../icons";
import { DOMAIN, type DeliveryState, type Thread, type ThreadMessage } from "../mock";
import { links, type ViewState } from "../router";
import {
  Disclosure,
  focusSibling,
  IconButton,
  ListMessage,
  PaneBar,
  SkeletonRows,
  Status,
  type Tone,
} from "../components/ui";

interface MailProps {
  inboxId: string;
  threads: Thread[];
  selectedId: string | undefined;
  state: ViewState;
}

const deliveryDisplay: Record<DeliveryState, { tone: Tone; icon: IconName; label: string }> = {
  queued: { tone: "mute", icon: "minus-circle", label: "Queued" },
  sent: { tone: "mute", icon: "send", label: "Sent" },
  delivered: { tone: "ok", icon: "check-circle", label: "Delivered" },
  bounced: { tone: "bad", icon: "alert", label: "Bounced" },
  failed: { tone: "bad", icon: "x-circle", label: "Failed" },
};

function threadTag(thread: Thread): { tone: Tone; icon: IconName; label: string } | undefined {
  if (thread.authentication.result === "fail") {
    return { tone: "warn", icon: "shield-alert", label: "Unauthenticated" };
  }
  const delivery = thread.messages.findLast((message) => message.delivery)?.delivery;
  if (delivery && delivery.state !== "sent") {
    return deliveryDisplay[delivery.state];
  }
  const attachments = thread.messages.reduce((sum, message) => sum + message.attachments.length, 0);
  if (attachments > 0) {
    return {
      tone: "mute",
      icon: "clip",
      label: `${attachments} ${attachments === 1 ? "attachment" : "attachments"}`,
    };
  }
  return undefined;
}

function ThreadRow({ thread, selected }: { thread: Thread; selected: boolean }) {
  const tag = threadTag(thread);
  const preview = thread.messages.at(-1)?.paragraphs[0] ?? "";
  return (
    <a
      data-row
      href={links.inbox(thread.inbox, thread.id)}
      aria-current={selected ? "true" : undefined}
      className="relative block border-b border-line py-[11px] pr-4 pl-7 transition-colors duration-150 hover:bg-hover aria-[current=true]:bg-sel"
    >
      {thread.unread ? (
        <span
          aria-hidden="true"
          className="absolute top-[19px] left-3 size-2 rounded-full bg-accent"
        />
      ) : null}
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-semibold">
          {thread.unread ? <span className="sr-only">Unread: </span> : null}
          {thread.correspondent}
        </span>
        <span className="text-xs text-ink2">{thread.time}</span>
      </div>
      <div className="truncate font-medium">{thread.subject}</div>
      <div className="line-clamp-2 text-[12.5px] text-ink2">{preview}</div>
      {tag ? (
        <Status tone={tag.tone} icon={tag.icon} className="mt-1 text-xs">
          {tag.label}
        </Status>
      ) : null}
    </a>
  );
}

function ThreadList({ inboxId, threads, selectedId, state }: MailProps) {
  const effective: ViewState = state === "ready" && threads.length === 0 ? "empty" : state;
  return (
    <section
      aria-label="Threads"
      className="flex min-h-0 min-w-0 flex-col border-r border-line bg-list"
    >
      <PaneBar>
        <h2 className="text-[15px] font-[650] tracking-[-0.005em]">{inboxId}</h2>
        <span className="flex-1" />
        <a
          href={links.inbox(inboxId)}
          aria-label="Refresh"
          title="Refresh"
          className="grid size-[30px] place-items-center rounded-[7px] text-ink2 hover:bg-hover hover:text-ink"
        >
          <Icon name="refresh" />
        </a>
      </PaneBar>
      <div className="min-h-0 flex-1 overflow-y-auto" onKeyDown={focusSibling}>
        {effective === "loading" ? <SkeletonRows /> : null}
        {effective === "empty" ? (
          <ListMessage icon="inbox" title="No mail yet">
            Messages sent to {inboxId}@{DOMAIN} will appear here.
          </ListMessage>
        ) : null}
        {effective === "error" ? (
          <ListMessage
            icon="alert"
            tone="bad"
            title="Could not load threads"
            action={
              <a
                href={links.inbox(inboxId)}
                className="inline-flex items-center gap-[7px] rounded-[7px] border border-line bg-raise px-3 py-1.5 font-medium hover:bg-hover"
              >
                <Icon name="refresh" />
                Try again
              </a>
            }
          >
            The service did not respond. Nothing was changed.
          </ListMessage>
        ) : null}
        {effective === "ready"
          ? threads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} selected={thread.id === selectedId} />
            ))
          : null}
      </div>
    </section>
  );
}

function MessageView({ message }: { message: ThreadMessage }) {
  const delivery = message.delivery ? deliveryDisplay[message.delivery.state] : undefined;
  const senderLabel = message.direction === "sent" ? "Agent" : message.from.address;
  return (
    <article className="border-t border-line py-5 first:border-t-0 first:pt-0">
      <header className="mb-2 flex items-baseline gap-2">
        <span className="font-semibold">{message.from.name}</span>
        <span className="text-xs text-ink2">{senderLabel}</span>
        <time className="ml-auto text-xs whitespace-nowrap text-ink2">{message.time}</time>
      </header>
      <div className="font-serif text-[17px] leading-[1.6]">
        {message.paragraphs.map((paragraph) => (
          <p key={paragraph} className="mb-[.7em] whitespace-pre-line last:mb-0">
            {paragraph}
          </p>
        ))}
      </div>
      {message.attachments.map((attachment) => (
        <div key={attachment.name} className="mt-3 flex items-center gap-2.5 py-1.5">
          <Icon name="file" />
          <span>
            {attachment.name} <small className="text-ink2">{attachment.size}</small>
          </span>
        </div>
      ))}
      {delivery && message.delivery ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-[18px] text-[12.5px]">
          <Status tone={delivery.tone} icon={delivery.icon}>
            {delivery.label} {message.delivery.time}
          </Status>
          {message.approvedByOwner ? (
            <Status tone="mute" icon="check-circle">
              Approved by you
            </Status>
          ) : null}
        </div>
      ) : null}
      {message.quoted ? (
        <Disclosure label="Show quoted text">
          <blockquote className="mt-2 border-l border-line pl-3.5 font-serif text-[15px] leading-[1.55] text-ink2">
            {message.quoted}
          </blockquote>
        </Disclosure>
      ) : null}
    </article>
  );
}

function Reader({ thread }: { thread: Thread | undefined }) {
  if (!thread) {
    return (
      <article aria-label="Thread" className="flex min-h-0 min-w-0 flex-col bg-win">
        <PaneBar />
        <div className="grid flex-1 place-items-center text-ink2">Select a thread to read it.</div>
      </article>
    );
  }
  const auth = thread.authentication;
  const count = thread.messages.length;
  const counterpart = thread.correspondent.replace(/^To: /, "");
  return (
    <article aria-label="Thread" className="flex min-h-0 min-w-0 flex-col bg-win">
      <PaneBar>
        <IconButton icon="reply" label="Reply" />
        <IconButton icon="clip" label="Attachments" />
        <span className="flex-1" />
        {auth.result === "pass" ? (
          <Status tone="ok" icon="shield-check">
            SPF, DKIM, DMARC pass
          </Status>
        ) : (
          <Status tone="warn" icon="shield-alert">
            Not authenticated: {auth.detail}
          </Status>
        )}
      </PaneBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[604px] px-8 pt-[30px] pb-16">
          <h1 className="mb-2 font-serif text-[30px] leading-[1.18] font-medium tracking-[-0.012em] text-balance">
            {thread.subject}
          </h1>
          <p className="mb-[26px] text-ink2">
            <b className="font-semibold text-ink">{thread.inbox}</b>@{DOMAIN} with {counterpart} -{" "}
            {count} {count === 1 ? "message" : "messages"}
          </p>
          {thread.messages.map((message) => (
            <MessageView key={message.id} message={message} />
          ))}
        </div>
      </div>
    </article>
  );
}

export function Mail(props: MailProps) {
  const selected = props.threads.find((thread) => thread.id === props.selectedId);
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,348px)_1fr]">
      <ThreadList {...props} />
      <Reader thread={props.state === "ready" ? selected : undefined} />
    </div>
  );
}
