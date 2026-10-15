import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Credential } from "@inbot/contracts/src/vault.js";
import { Select } from "../../components/Select";
import {
  Button,
  focusSibling,
  inputClasses,
  ListMessage,
  PaneBar,
  SkeletonRows,
} from "../../components/ui";
import { LoadError } from "../../feedback";
import { credentialsQuery, inboxesQuery } from "../../queries";
import { links, navigate } from "../../router";
import { CredentialDetail } from "./CredentialDetail";
import { CreateCredential } from "./CredentialDialogs";
import { urlHost } from "./format";
import { ExportCredentials, ImportCredentials } from "./Transfer";

function useDebounced(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function CredentialRow({ credential, selected }: { credential: Credential; selected: boolean }) {
  const secondary = [urlHost(credential.url), credential.username]
    .filter((part) => part && part !== credential.inbox_id)
    .join(" · ");
  return (
    <a
      data-row
      href={links.vault(credential.inbox_id, credential.credential_id)}
      aria-current={selected ? "true" : undefined}
      className="block border-b border-line px-4 py-[11px] transition-colors duration-150 hover:bg-hover aria-[current=true]:bg-sel"
    >
      <div className="truncate font-semibold">{credential.name}</div>
      {secondary ? <div className="truncate text-[12.5px] text-ink2">{secondary}</div> : null}
      <div className="truncate text-xs text-ink2">{credential.inbox_id}</div>
    </a>
  );
}

export function Vault({
  inboxId,
  credentialId,
}: {
  inboxId: string | undefined;
  credentialId: string | undefined;
}) {
  const inboxes = useQuery(inboxesQuery);
  const [search, setSearch] = useState("");
  const [inboxFilter, setInboxFilter] = useState("");
  const [dialog, setDialog] = useState<"create" | "import" | "export">();
  const q = useDebounced(search.trim(), 250);
  const filter = { ...(inboxFilter ? { inboxId: inboxFilter } : {}), ...(q ? { q } : {}) };
  const query = useQuery({ ...credentialsQuery(filter), placeholderData: keepPreviousData });
  const credentials = query.data ?? [];
  const filtered = inboxFilter !== "" || q !== "";
  const defaultInbox = inboxFilter || inboxId || inboxes.data?.[0]?.inbox_id || "";
  return (
    <>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,348px)_1fr]">
        <section
          aria-label="Credentials"
          className="flex min-h-0 min-w-0 flex-col border-r border-line bg-list"
        >
          <PaneBar>
            <h2 className="text-[15px] font-[650] tracking-[-0.005em]">Vault</h2>
            <span className="flex-1" />
            <Button variant="primary" icon="plus" onClick={() => setDialog("create")}>
              New credential
            </Button>
          </PaneBar>
          <div className="grid gap-2 border-b border-line px-4 py-3">
            <input
              type="search"
              aria-label="Search credentials"
              placeholder="Search name, URL or username"
              className={inputClasses}
              value={search}
              autoComplete="off"
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select
              label="Inbox"
              labelClassName="sr-only"
              value={inboxFilter}
              onChange={setInboxFilter}
              options={[
                { value: "", label: "All inboxes" },
                ...(inboxes.data ?? []).map((inbox) => ({
                  value: inbox.inbox_id,
                  label: inbox.inbox_id,
                })),
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" onKeyDown={focusSibling}>
            {query.isPending ? (
              <SkeletonRows />
            ) : query.error && !query.data ? (
              <LoadError error={query.error} retry={() => void query.refetch()} />
            ) : credentials.length === 0 ? (
              filtered ? (
                <ListMessage icon="vault" title="No matching credentials">
                  Try a different search or inbox.
                </ListMessage>
              ) : (
                <ListMessage icon="vault" title="No credentials yet">
                  Agents create credentials through MCP or the CLI. You can also add one yourself.
                </ListMessage>
              )
            ) : (
              credentials.map((credential) => (
                <CredentialRow
                  key={`${credential.inbox_id}/${credential.credential_id}`}
                  credential={credential}
                  selected={
                    credential.credential_id === credentialId && credential.inbox_id === inboxId
                  }
                />
              ))
            )}
          </div>
          <div className="flex flex-none items-center gap-1 border-t border-line px-3 py-2">
            <Button
              variant="quiet"
              icon="download"
              className="[&_svg]:rotate-180"
              onClick={() => setDialog("import")}
            >
              Import
            </Button>
            <Button variant="quiet" icon="download" onClick={() => setDialog("export")}>
              Export
            </Button>
          </div>
        </section>
        {inboxId && credentialId ? (
          <CredentialDetail
            key={`${inboxId}/${credentialId}`}
            inboxId={inboxId}
            credentialId={credentialId}
          />
        ) : (
          <article aria-label="Credential" className="flex min-h-0 min-w-0 flex-col bg-win">
            <PaneBar />
            <div className="grid flex-1 place-items-center text-ink2">
              Select a credential to see its details.
            </div>
          </article>
        )}
      </div>
      {dialog === "create" ? (
        <CreateCredential
          defaultInbox={defaultInbox}
          onClose={() => setDialog(undefined)}
          onCreated={(credential) => {
            setDialog(undefined);
            navigate(links.vault(credential.inbox_id, credential.credential_id));
          }}
        />
      ) : dialog === "import" ? (
        <ImportCredentials defaultInbox={defaultInbox} onClose={() => setDialog(undefined)} />
      ) : dialog === "export" ? (
        <ExportCredentials defaultInbox={inboxFilter} onClose={() => setDialog(undefined)} />
      ) : null}
    </>
  );
}
