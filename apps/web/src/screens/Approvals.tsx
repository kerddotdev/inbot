import { DOMAIN, type Draft } from "../mock";
import { links, type ViewState } from "../router";
import { Icon } from "../icons";
import { Button, focusSibling, ListMessage, PaneBar, SkeletonRows, Status } from "../components/ui";

interface ApprovalsProps {
  drafts: Draft[];
  selectedId: string | undefined;
  state: ViewState;
}

function DraftRow({ draft, selected }: { draft: Draft; selected: boolean }) {
  return (
    <a
      data-row
      href={links.approvals(draft.id)}
      aria-current={selected ? "true" : undefined}
      className="relative block border-b border-line py-[11px] pr-4 pl-7 transition-colors duration-150 hover:bg-hover aria-[current=true]:bg-sel"
    >
      <span
        aria-hidden="true"
        className="absolute top-[19px] left-3 size-2 rounded-full bg-accent"
      />
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-semibold">{draft.inbox}</span>
        <span className="text-xs text-ink2">{draft.ago}</span>
      </div>
      <div className="truncate font-medium">{draft.subject}</div>
      <div className="truncate text-[12.5px] text-ink2">To: {draft.to}</div>
    </a>
  );
}

function DraftView({ draft }: { draft: Draft }) {
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
            {draft.subject}
          </h1>
          <p className="mb-[26px] text-ink2">
            Draft from {draft.inbox}. Nothing is sent until you approve.
          </p>
          <dl className="mb-6 grid grid-cols-[64px_1fr] gap-y-1.5">
            <dt className="text-ink2">From</dt>
            <dd>
              {draft.inbox}@{DOMAIN}
            </dd>
            <dt className="text-ink2">To</dt>
            <dd>{draft.to}</dd>
            <dt className="text-ink2">Subject</dt>
            <dd>{draft.subject}</dd>
          </dl>
          <div className="font-serif text-[17px] leading-[1.6]">
            {draft.paragraphs.map((paragraph) => (
              <p key={paragraph} className="mb-[.7em] whitespace-pre-line last:mb-0">
                {paragraph}
              </p>
            ))}
          </div>
          <div className="mt-7 flex flex-wrap items-center gap-2.5">
            <Button variant="primary" icon="send">
              Approve and send
            </Button>
            <Button icon="pencil">Edit</Button>
            <Button variant="danger" icon="x-circle">
              Reject
            </Button>
          </div>
          <div className="mt-7 flex gap-2.5 border-t border-line pt-4 text-ink2">
            <Icon name="key" className="mt-0.5" />
            <p>
              Created by <b className="font-semibold text-ink">{draft.inbox}</b> with API key{" "}
              <span className="font-mono text-xs">{draft.keyName}</span> (ends {draft.keySuffix}) at{" "}
              {draft.createdAt}.
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}

export function Approvals({ drafts, selectedId, state }: ApprovalsProps) {
  const effective: ViewState = state === "ready" && drafts.length === 0 ? "empty" : state;
  const selected = drafts.find((draft) => draft.id === selectedId);
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,348px)_1fr]">
      <section
        aria-label="Pending drafts"
        className="flex min-h-0 min-w-0 flex-col border-r border-line bg-list"
      >
        <PaneBar>
          <h2 className="text-[15px] font-[650] tracking-[-0.005em]">Approvals</h2>
          <span className="flex-1" />
          {effective === "ready" ? (
            <span className="text-ink2">{drafts.length} pending</span>
          ) : null}
        </PaneBar>
        <div className="min-h-0 flex-1 overflow-y-auto" onKeyDown={focusSibling}>
          {effective === "loading" ? <SkeletonRows /> : null}
          {effective === "empty" ? (
            <ListMessage icon="check-circle" title="Nothing to approve">
              Drafts from agents with an approval send policy will wait here.
            </ListMessage>
          ) : null}
          {effective === "error" ? (
            <ListMessage
              icon="alert"
              tone="bad"
              title="Could not load drafts"
              action={
                <a
                  href={links.approvals()}
                  className="inline-flex items-center gap-[7px] rounded-[7px] border border-line bg-raise px-3 py-1.5 font-medium hover:bg-hover"
                >
                  <Icon name="refresh" />
                  Try again
                </a>
              }
            >
              The service did not respond. No draft was sent.
            </ListMessage>
          ) : null}
          {effective === "ready"
            ? drafts.map((draft) => (
                <DraftRow key={draft.id} draft={draft} selected={draft.id === selectedId} />
              ))
            : null}
        </div>
      </section>
      {effective === "ready" && selected ? (
        <DraftView draft={selected} />
      ) : (
        <article aria-label="Draft" className="flex min-h-0 min-w-0 flex-col bg-win">
          <PaneBar />
          <div className="grid flex-1 place-items-center text-ink2">
            Select a draft to review it.
          </div>
        </article>
      )}
    </div>
  );
}
