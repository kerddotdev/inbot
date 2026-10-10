# Mailbox storage

`Mailbox.Live` requires `Store`. It stores parsed mail in the encrypted database
and returns the decoded contract types from `packages/contracts/src`. It does
not parse MIME, send mail, serve HTTP or MCP, enforce grants or send policies,
or emit events. Every operation observes a transactionally consistent snapshot;
writes use immediate transactions. Expected failures are `MailboxError` with
contract codes and actionable fixes. Storage failures remain `DatabaseError`.

## API

- Inboxes: `createInbox`, `getInbox`, `listInboxes`, `searchInboxes`, `updateInbox`,
  `deleteInbox`. Creation requires `domain`; absent usernames use 16 random hex
  characters. Local parts and domains are lowercase, domains are converted to
  ASCII, and `client_id` replays the original inbox. Metadata updates merge,
  null values remove keys, and `metadata: null` clears everything.
  Creation, listing, and search accept an optional inbox allowlist. Creation
  outside that list rolls back; list and search tokens bind the allowlist.
- Ingestion: `insertMessage` takes `InsertMessage` from `types.ts`, including
  explicit `inbox_id`, direction, parsed fields, timestamp, `raw` MIME bytes,
  optional attachments with `content` bytes, labels, and aliases. It returns
  `{ message_id, thread_id }`. Repeated `(inbox_id, message_id)` pairs return the
  original ids without changing stored content. Message ids include angle
  brackets. Aliases cannot shadow a different message or alias in the inbox.
- Messages: `getMessage`, `listMessages`, `searchMessages`, `updateMessage`,
  `batchGetMessages`, `batchUpdateMessages`, `deleteMessage`, `getRawMessage`,
  `getAttachment`. Every method takes `inbox_id` first. Batch methods accept
  contract request objects, preserve request order, and omit missing ids.
  Batch-get returns full messages as specified by Inbot's contracts. Batch
  updates require a label delta and apply atomically. Removal wins when a
  label is both added and removed.
- Threads: `listThreads(scope, query)`, `searchThreads(scope, q, cursor)`,
  `getThread(inbox_id, thread_id, cursor)`, `updateThread`, `deleteThread`,
  `getThreadAttachment`. The latter three also require `inbox_id` first.
  `scope` is `{ inbox_id?, inbox_ids? }`: omitted `inbox_ids` allows all inboxes,
  an empty array allows none, and both fields intersect. Callers must pass the
  grant's scope and enforce permissions. Inbox-scoped reads require an existing
  inbox. Direct resource reads can return hidden mail; caller permissions still
  apply.
  `resolveThreadInbox(thread_id, scope)` resolves organization routes inside
  their allowed scope without exposing other inboxes.

## Storage and threading

Migration 2 adds inboxes, threads, messages, raw MIME, labels, attachments,
aliases, search state, and FTS5 indexes. Foreign keys cascade permanent deletes.
Messages have a composite inbox/message primary key. Raw MIME and attachment
bytes are separate from list projections. Search text is duplicated only inside
the encrypted database. FTS triggers maintain it on message insertion, update,
and deletion, including cascading deletes.

Thread and generated attachment ids are local UUIDv7 values: a 48-bit
millisecond timestamp plus 74 random bits from `node:crypto`. They sort by
creation time; ids generated in the same millisecond have random tie order.
Threading first resolves `in_reply_to`, then scans `references` from newest to
oldest. Both canonical ids and aliases are resolved only within the inbox.
An unmatched message creates a thread; subjects never join threads. Late
parents do not retroactively merge existing threads.

Thread labels are the union of message labels. Thread metadata is recomputed
transactionally after insertions and deletions: the earliest message supplies
the normalized subject (reply/forward prefixes and excess whitespace removed),
and the newest supplies the timestamp, preview, and last message id. Direction
timestamps, senders, all recipients, size, count, and attachment metadata come
from surviving messages. An empty thread is removed. Preview uses the first
200 Unicode characters of whitespace-collapsed `extracted_text`, falling back
to `text` only when extracted text is absent.

## Queries and pagination

List pages default to newest first; `ascending` reverses both sort components.
The default page size is 20 and the maximum is 100. The reference OpenAPI does
not specify a default. All labels and all repeated substring filters must
match. Sender, recipient, and subject filters use Unicode lowercase substring
matching through a deterministic SQLite function, treating `%` and `_` literally. Recipient filters
include to/cc/bcc. Before/after bounds are strict. Timestamp wire values retain
their original offset and fractional precision; a separate UTC sort key
preserves even submillisecond ordering.

`spam`, `blocked`, `unauthenticated`, and `trash` are hidden unless each matching
`include_*` flag is true. Because thread labels form a union, a hidden label on
any member hides the thread. `getThread` returns the newest page of messages,
ordered oldest to newest within that page; its cursor continues toward older
messages. `count` describes the page and `message_count` the whole thread.

Page tokens are base64url JSON with version, SHA-256 filter fingerprint, sort
key, and id. The fingerprint binds resource, filters, order, and inbox scope.
Array filters are sorted and deduplicated. Page size can change between pages.
The next token appears only when an additional matching row exists. Invalid,
malformed, unsupported-version, or mismatched tokens all fail with
`page_token_stale`. Ordinary list tokens survive unrelated writes; they are
keyset continuations, not frozen snapshots, so messages inserted ahead of a
cursor require a fresh listing and mutable thread timestamps can move between
pages. Tokens are not credentials or authorization.

## Search

Search takes plain Unicode letter/number/underscore terms. Each term is quoted
and terms are joined with AND in a bound FTS5 MATCH parameter; punctuation and
operators cannot become FTS syntax. Punctuation-only queries return no matches.
Mail search covers subject, sender, to/cc/bcc, and extracted text (or text).
It excludes all hidden labels and returns BM25 relevance order with id ties.
Highlights use bounded snippets, wrapping matching terms in `**`. Thread
search returns each thread once, using its best matching message for rank and
highlights; its time filters apply to the thread's latest timestamp.

Inbox search uses address/display-name word prefixes, relevance ranking, and
the documented 2-256 character query length. Search cursors use the exact
floating-point relevance score plus id. A durable search revision is included
in the fingerprint: any inbox/message write makes previous search tokens stale,
including label changes. This prevents changed BM25 scores or visibility from
causing gaps or duplicates across search pages.

## Compatibility values

`Inbox.pod_id` is the fixed local value `local`; Inbot has no pods. Metadata,
headers, address arrays, labels, and attachment arrays default to empty values.
Absent optional bodies and timestamps remain absent. Message size defaults to
raw MIME byte length; attachment size is measured from content and an explicit
size must agree. Parsed `calendar_event_id` can be retained without implementing
calendar behavior. Raw reads return bytes and attachment reads return
`{ attachment, content }`; download URLs and expiry belong to future transports
and are not fabricated here.
