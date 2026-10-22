import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VaultSettings } from "@inbot/contracts/src/vault.js";
import { api } from "../../api";
import { Button, IconButton, inputClasses, Status } from "../../components/ui";
import { ErrorNotice, LoadError } from "../../feedback";
import { vaultSettingsQuery } from "../../queries";

const unique = (values: readonly string[]) => [...new Set(values.filter(Boolean))];

export const normalizeHosts = (hosts: readonly string[]) =>
  unique(hosts.map((host) => host.trim().toLowerCase()));

export const normalizeEndpoints = (endpoints: readonly string[]) =>
  unique(
    endpoints.map((endpoint) => {
      const value = endpoint.trim();
      try {
        const url = new URL(value);
        return url.username || url.password ? value : url.origin;
      } catch {
        return value;
      }
    }),
  );

function BrowserList({
  id,
  setting,
  title,
  description,
  noun,
  empty,
  placeholder,
  normalize,
}: {
  id: string;
  setting: keyof VaultSettings;
  title: string;
  description: string;
  noun: string;
  empty: string;
  placeholder: string;
  normalize: (values: readonly string[]) => string[];
}) {
  const client = useQueryClient();
  const query = useQuery(vaultSettingsQuery);
  const [draft, setDraft] = useState<readonly string[]>();
  const values = draft ?? query.data?.[setting] ?? [];
  const save = useMutation({
    mutationFn: () => {
      const next = normalize(values);
      return api.setVaultSettings(
        setting === "cdp_endpoints" ? { cdp_endpoints: next } : { remote_cdp_hosts: next },
      );
    },
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
  const label = noun.charAt(0).toUpperCase() + noun.slice(1);
  return (
    <section aria-labelledby={id} className="mt-9 max-w-xl border-t border-line pt-6">
      <h2 id={id} className="font-semibold">
        {title}
      </h2>
      <p className="mt-2 text-ink2">{description}</p>
      {query.isPending ? (
        <p role="status" className="mt-4 text-ink2">
          Loading {noun}s...
        </p>
      ) : query.error ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <form onSubmit={submit} className="mt-4" aria-busy={save.isPending}>
          <fieldset disabled={save.isPending} className="grid gap-2">
            <legend className="sr-only">{title}</legend>
            {values.length === 0 ? <p className="text-ink2">{empty}</p> : null}
            {values.map((value, index) => (
              <div key={index} className="flex items-center gap-1">
                <input
                  aria-label={`${label} ${index + 1}`}
                  className={`${inputClasses} font-mono`}
                  value={value}
                  placeholder={placeholder}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    edit(values.map((item, i) => (i === index ? event.target.value : item)))
                  }
                />
                <IconButton
                  icon="x-circle"
                  label={`Remove ${noun} ${index + 1}`}
                  onClick={() => edit(values.filter((_, i) => i !== index))}
                />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="quiet" icon="plus" onClick={() => edit([...values, ""])}>
                Add {noun}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={save.isPending || draft === undefined}
              >
                {save.isPending ? "Saving..." : `Save ${noun}s`}
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

export function TrustedBrowsers() {
  return (
    <BrowserList
      id="trusted-browsers-title"
      setting="cdp_endpoints"
      title="Trusted browsers"
      description="Inbot fills and captures passwords only in browsers you list here or on the remote hosts below. Add the debugging address of a browser you run, such as http://127.0.0.1:9222. Anything that can listen on that address while the browser is closed can receive passwords, so keep it running while agents use it."
      noun="browser"
      empty="No browsers are trusted."
      placeholder="http://127.0.0.1:9222"
      normalize={normalizeEndpoints}
    />
  );
}

export function RemoteBrowserHosts() {
  return (
    <BrowserList
      id="remote-browser-title"
      setting="remote_cdp_hosts"
      title="Remote browser hosts"
      description="Inbot can fill passwords into HTTPS browsers on these hosts. Remote agents can only use these. An empty list disables remote fill. Use a hostname or a wildcard such as *.example.com."
      noun="host"
      empty="No remote hosts are allowed."
      placeholder="browser.example.com"
      normalize={normalizeHosts}
    />
  );
}
