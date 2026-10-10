import { WebhooksSettings } from "./WebhooksSettings";
import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { Button, inputClasses, Page, Segmented, Status } from "../components/ui";
import { ErrorNotice, LoadError } from "../feedback";
import { transportQuery } from "../queries";
import { readTheme, writeTheme, type ThemeChoice } from "../theme";
import { ListManagement } from "./ListManagement";

const choices: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function MailTransport() {
  const client = useQueryClient();
  const query = useQuery(transportQuery);
  const [accountId, setAccountId] = useState<string>();
  const tokenInput = useRef<HTMLInputElement>(null);
  const configure = useMutation({
    mutationFn: () => {
      const api_token = tokenInput.current?.value ?? "";
      if (tokenInput.current) tokenInput.current.value = "";
      return api.configureTransport({
        account_id: (accountId ?? query.data?.account_id ?? "").trim(),
        api_token,
      });
    },
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey: transportQuery.queryKey });
      client.setQueryData(transportQuery.queryKey, data);
      setAccountId(undefined);
    },
  });
  const clear = useMutation({
    mutationFn: () => api.clearTransport(),
    onSuccess: async () => {
      setAccountId("");
      if (tokenInput.current) tokenInput.current.value = "";
      configure.reset();
      await client.invalidateQueries({ queryKey: transportQuery.queryKey });
    },
  });
  const busy = configure.isPending || clear.isPending;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clear.reset();
    configure.mutate();
  };
  const data = query.data;
  return (
    <section
      aria-labelledby="mail-transport-title"
      className="mt-9 max-w-xl border-t border-line pt-6"
    >
      <h2 id="mail-transport-title" className="font-semibold">
        Mail transport
      </h2>
      <p className="mt-2 text-ink2">
        Connect Cloudflare to send mail and provision your mail subdomain. The token stays in your
        encrypted local database.
      </p>
      {query.isPending ? (
        <p role="status" className="mt-4 text-ink2">
          Loading transport...
        </p>
      ) : query.error ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : data ? (
        <>
          <div role="status" className="mt-4">
            {data.token_set ? (
              <Status
                tone={data.verification_status === "verified" ? "ok" : "warn"}
                icon={data.verification_status === "verified" ? "check-circle" : "alert"}
              >
                {data.verification_status === "verified"
                  ? "Configured"
                  : "Configured - not verified"}
              </Status>
            ) : (
              <Status tone="mute" icon="globe">
                Not configured
              </Status>
            )}
          </div>
          {data.verified_at ? (
            <p className="mt-2 text-sm text-ink2">
              Token last verified:{" "}
              <time dateTime={data.verified_at}>{new Date(data.verified_at).toLocaleString()}</time>
              . Permissions are checked when used.
            </p>
          ) : null}
          {configure.error ? (
            <div role="status" className="mt-4">
              <Status tone="bad" icon="alert">
                {configure.error instanceof ApiError &&
                configure.error.message === "The Cloudflare token could not be verified."
                  ? "Verification failed"
                  : "Configuration failed"}
              </Status>
              <p className="mt-2 text-ink2">
                Reload the status to check the saved configuration before retrying.
              </p>
              <Button icon="refresh" className="mt-2" onClick={() => void query.refetch()}>
                Reload status
              </Button>
            </div>
          ) : null}
          <ErrorNotice error={configure.error ?? clear.error} />
          <form onSubmit={submit} className="mt-5 space-y-4">
            <fieldset disabled={busy} className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block font-medium">Account ID</span>
                <input
                  className={`${inputClasses} font-mono`}
                  value={accountId ?? data.account_id ?? ""}
                  onChange={(event) => {
                    setAccountId(event.target.value);
                    configure.reset();
                    clear.reset();
                  }}
                  required
                  pattern="[a-fA-F0-9]{32}"
                  maxLength={32}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block font-medium">API token</span>
                <input
                  ref={tokenInput}
                  type="password"
                  className={inputClasses}
                  required
                  maxLength={1024}
                  autoComplete="new-password"
                  spellCheck={false}
                  onChange={() => {
                    configure.reset();
                    clear.reset();
                  }}
                  aria-describedby="transport-token-help"
                />
              </label>
              <p id="transport-token-help" className="text-sm text-ink2">
                {data.token_set ? "Enter a token to verify and replace the saved one. " : ""}
                Tokens are never displayed again. Include Zone Read, DNS Write, Zone Settings Write,
                Email Routing Rules Write, Email Sending: Edit, Workers Scripts Write, Workers R2
                Storage Write, and Queues Write.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" variant="primary" icon="shield-check" disabled={busy}>
                  {configure.isPending ? "Verifying..." : "Verify and save"}
                </Button>
                {data.token_set ? (
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      configure.reset();
                      clear.mutate();
                    }}
                  >
                    {clear.isPending ? "Clearing..." : "Clear transport"}
                  </Button>
                ) : null}
              </div>
            </fieldset>
          </form>
        </>
      ) : null}
    </section>
  );
}

export function Settings() {
  const [theme, setTheme] = useState(readTheme);
  return (
    <Page barTitle="Settings" title="Settings">
      <fieldset className="min-w-0">
        <legend className="mb-[7px] p-0 font-semibold">Appearance</legend>
        <Segmented
          name="theme"
          options={choices}
          value={theme}
          onChange={(choice) => {
            setTheme(choice);
            writeTheme(choice);
          }}
        />
      </fieldset>
      <MailTransport />
      <ListManagement />
      <WebhooksSettings />
    </Page>
  );
}
