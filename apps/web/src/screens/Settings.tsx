import { UpdatesSettings } from "./UpdatesSettings";
import { Quarantine } from "./Quarantine";
import { WebhooksSettings } from "./WebhooksSettings";
import {
  cloudflareTokenPermissions,
  cloudflareTokenUrl,
} from "@inbot/contracts/src/cloudflare-permissions.js";
import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { Button, Disclosure, inputClasses, Page, Segmented, Status } from "../components/ui";
import { ErrorNotice, LoadError } from "../feedback";
import { transportQuery } from "../queries";
import { readTheme, writeTheme, type ThemeChoice } from "../theme";
import { ListManagement } from "./ListManagement";
import { RemoteBrowserHosts, TrustedBrowsers } from "./vault/BrowserSettings";

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
      const selectedAccount = (accountId ?? query.data?.account_id ?? "").trim();
      return api.configureTransport({
        ...(selectedAccount ? { account_id: selectedAccount } : {}),
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
          <div className="mt-5 space-y-3">
            <Button
              onClick={() => window.open(cloudflareTokenUrl, "_blank", "noopener,noreferrer")}
            >
              Create API token
            </Button>
            <p className="text-sm text-ink2">
              On the Cloudflare page, narrow Account Resources to your account and Zone Resources to
              your mail zone before creating the token. The link preselects all required
              permissions, including remote access.
            </p>
            <Disclosure label="Required permissions">
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-line">
                    <tr>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        Permission
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        Why it is needed
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {cloudflareTokenPermissions.map((permission) => (
                      <tr key={permission.name}>
                        <td className="py-3 pr-4 align-top">
                          {permission.scope} / {permission.name}:{" "}
                          {permission.level === "read" ? "Read" : "Edit"}
                        </td>
                        <td className="py-3 align-top text-ink2">{permission.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Disclosure>
          </div>
          <form onSubmit={submit} className="mt-5 space-y-4">
            <fieldset disabled={busy} className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block font-medium">Account ID (optional)</span>
                <input
                  className={`${inputClasses} font-mono`}
                  value={accountId ?? data.account_id ?? ""}
                  onChange={(event) => {
                    setAccountId(event.target.value);
                    configure.reset();
                    clear.reset();
                  }}
                  pattern="[a-fA-F0-9]{32}"
                  maxLength={32}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <p className="text-sm text-ink2">
                Leave the account ID blank to detect it from your token. If several accounts are
                available, enter one of the IDs returned below and submit the token again.
              </p>
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
                Tokens are never displayed again. Verification checks that the token is active;
                permissions are checked when used.
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
      <UpdatesSettings />
      <MailTransport />
      <ListManagement />
      <TrustedBrowsers />
      <RemoteBrowserHosts />
      <Quarantine />
      <WebhooksSettings />
    </Page>
  );
}
