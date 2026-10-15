import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { Button, IconButton, inputClasses, Status } from "../../components/ui";
import { ErrorNotice, LoadError } from "../../feedback";
import { vaultSettingsQuery } from "../../queries";

export const normalizeHosts = (hosts: readonly string[]) => [
  ...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean)),
];

export function RemoteBrowserHosts() {
  const client = useQueryClient();
  const query = useQuery(vaultSettingsQuery);
  const [draft, setDraft] = useState<readonly string[]>();
  const hosts = draft ?? query.data?.remote_cdp_hosts ?? [];
  const save = useMutation({
    mutationFn: () => api.setVaultSettings({ remote_cdp_hosts: normalizeHosts(hosts) }),
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey: vaultSettingsQuery.queryKey });
      client.setQueryData(vaultSettingsQuery.queryKey, data);
      setDraft(undefined);
    },
  });
  const edit = (next: readonly string[]) => {
    save.reset();
    setDraft(next);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!save.isPending) save.mutate();
  };
  return (
    <section
      aria-labelledby="remote-browser-title"
      className="mt-9 max-w-xl border-t border-line pt-6"
    >
      <h2 id="remote-browser-title" className="font-semibold">
        Remote browser hosts
      </h2>
      <p className="mt-2 text-ink2">
        Remote agents can only have Inbot fill passwords into browsers on these hosts. An empty list
        disables remote fill. Use a hostname or a wildcard such as *.example.com.
      </p>
      {query.isPending ? (
        <p role="status" className="mt-4 text-ink2">
          Loading hosts...
        </p>
      ) : query.error ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <form onSubmit={submit} className="mt-4" aria-busy={save.isPending}>
          <fieldset disabled={save.isPending} className="grid gap-2">
            <legend className="sr-only">Allowed hosts</legend>
            {hosts.length === 0 ? <p className="text-ink2">No remote hosts are allowed.</p> : null}
            {hosts.map((host, index) => (
              <div key={index} className="flex items-center gap-1">
                <input
                  aria-label={`Host ${index + 1}`}
                  className={`${inputClasses} font-mono`}
                  value={host}
                  placeholder="browser.example.com"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    edit(hosts.map((item, i) => (i === index ? event.target.value : item)))
                  }
                />
                <IconButton
                  icon="x-circle"
                  label={`Remove host ${index + 1}`}
                  onClick={() => edit(hosts.filter((_, i) => i !== index))}
                />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="quiet" icon="plus" onClick={() => edit([...hosts, ""])}>
                Add host
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={save.isPending || draft === undefined}
              >
                {save.isPending ? "Saving..." : "Save hosts"}
              </Button>
              {save.isSuccess ? (
                <span role="status">
                  <Status tone="ok" icon="check-circle">
                    Saved
                  </Status>
                </span>
              ) : null}
            </div>
            <ErrorNotice error={save.error} />
          </fieldset>
        </form>
      )}
    </section>
  );
}
