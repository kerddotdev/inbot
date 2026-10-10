import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthorizationRequest } from "@inbot/contracts/src/oauth.js";
import type { Grant } from "@inbot/contracts/src/api-keys.js";
import { api } from "../api";
import { consentRedirect, readAuthorizationRequest } from "../oauth";
import { inboxesQuery } from "../queries";
import { ErrorNotice, LoadError } from "../feedback";
import { GrantFields, defaultGrant, policyDisplay } from "../components/GrantFields";
import { Button, ListMessage, Page, SkeletonRows, Status } from "../components/ui";

export function OAuthGrants() {
  const client = useQueryClient();
  const [revoking, setRevoking] = useState<string>();
  const query = useQuery({
    queryKey: ["oauth"],
    queryFn: ({ signal }) => api.oauthClients(signal),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeOAuthGrant(id),
    onSuccess: () => {
      setRevoking(undefined);
      void client.invalidateQueries({ queryKey: ["oauth"] });
    },
  });
  const purge = useMutation({
    mutationFn: () => api.purgeOAuthClients(),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["oauth"] });
    },
  });
  return (
    <section className="mt-10" aria-labelledby="oauth-clients-title">
      <h2 id="oauth-clients-title" className="mb-2 text-xl font-semibold">
        Authorized OAuth clients
      </h2>
      <p className="mb-5 text-ink2">
        Revoke a grant to stop this client's access, including every refresh token.
      </p>
      <div className="mb-5">
        <Button variant="quiet" disabled={purge.isPending} onClick={() => purge.mutate()}>
          {purge.isPending ? "Purging..." : "Purge unused registrations"}
        </Button>
        {purge.data ? (
          <p className="mt-2 text-ink2" role="status">
            Removed {purge.data.deleted_clients} unused registrations.
          </p>
        ) : null}
      </div>
      <ErrorNotice error={purge.error} />
      <ErrorNotice error={revoke.error} />
      {query.isPending ? (
        <SkeletonRows />
      ) : query.error ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : query.data.grants.length === 0 ? (
        <ListMessage icon="key" title="No authorized OAuth clients">
          Clients supporting OAuth request access through your browser.
        </ListMessage>
      ) : (
        <ul>
          {query.data.grants.map((grant) => {
            const policy = policyDisplay[grant.send_policy];
            return (
              <li
                key={grant.grant_id}
                className="flex flex-wrap items-start justify-between gap-4 border-b border-line py-4"
              >
                <div className="min-w-0 flex-1">
                  <h3 className="break-all font-semibold">
                    <bdi>{grant.client_name}</bdi>
                  </h3>
                  <p className="mt-1 break-all text-ink2">
                    Redirect: <bdi>{grant.redirect_host}</bdi>
                  </p>
                  <p className="mt-1 break-all text-ink2">Resource: {grant.resource}</p>
                  <p className="mt-1 break-all">
                    {grant.inbox_id ??
                      grant.inbox_ids?.join(", ") ??
                      "All current and future inboxes"}
                  </p>
                  <p className="mt-1 text-xs text-ink2">
                    {Object.entries(grant.permissions)
                      .filter(([, enabled]) => enabled)
                      .map(([permission]) => permission.replaceAll("_", " "))
                      .join(", ") || "No permissions"}
                  </p>
                  <Status tone={policy.tone} icon={policy.icon}>
                    {policy.label}
                  </Status>
                </div>
                {revoking === grant.grant_id ? (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="quiet"
                      disabled={revoke.isPending}
                      onClick={() => setRevoking(undefined)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(grant.grant_id)}
                    >
                      {revoke.isPending ? "Revoking..." : "Revoke access"}
                    </Button>
                  </div>
                ) : (
                  <Button variant="quiet" onClick={() => setRevoking(grant.grant_id)}>
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Consent({ input }: { input: typeof AuthorizationRequest.Type }) {
  const [grant, setGrant] = useState<Grant>(defaultGrant);
  const inboxes = useQuery(inboxesQuery);
  const details = useQuery({
    queryKey: ["oauth-consent", input],
    queryFn: ({ signal }) => api.oauthDetails(input, signal),
    staleTime: Infinity,
  });
  const consent = useMutation({
    mutationFn: (approved: boolean) =>
      api.oauthConsent({ ...input, approved, ...(approved ? { grant } : {}) }),
    onSuccess: (result) => {
      const target = consentRedirect(result.redirect_uri, input.redirect_uri);
      window.location.assign(target.href);
    },
  });
  return (
    <Page
      barTitle="Authorize client"
      title="Allow access to Inbot?"
      lead="Only approve a client you intended to connect. Client names and redirect hosts are supplied by the client and are not verified."
    >
      {details.isPending ? (
        <SkeletonRows />
      ) : details.error ? (
        <LoadError error={details.error} retry={() => void details.refetch()} />
      ) : (
        <>
          <dl className="mb-7 grid gap-2">
            <dt className="font-semibold">Client name (unverified)</dt>
            <dd className="break-all">
              <bdi>{details.data.client_name}</bdi>
            </dd>
            <dt className="mt-2 font-semibold">Redirect host or native scheme (unverified)</dt>
            <dd className="break-all">
              <bdi>{details.data.redirect_host}</bdi>
            </dd>
            <dt className="mt-2 font-semibold">Resource</dt>
            <dd className="break-all">{details.data.resource}</dd>
          </dl>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!consent.isPending) consent.mutate(true);
            }}
          >
            <fieldset disabled={consent.isPending} className="max-w-[580px]">
              <GrantFields
                value={grant}
                onChange={setGrant}
                inboxIds={inboxes.data?.map((inbox) => inbox.inbox_id) ?? []}
                inboxError={inboxes.error}
                loadingInboxes={inboxes.isPending}
                retryInboxes={() => void inboxes.refetch()}
              />
              <div className="mt-6 flex gap-3">
                <Button
                  variant="quiet"
                  disabled={consent.isPending}
                  onClick={() => consent.mutate(false)}
                >
                  Deny
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    consent.isPending ||
                    (grant.inbox_ids !== undefined && grant.inbox_ids.length === 0)
                  }
                >
                  {consent.isPending ? "Saving..." : "Allow access"}
                </Button>
              </div>
              <ErrorNotice error={consent.error} />
            </fieldset>
          </form>
        </>
      )}
    </Page>
  );
}

export function OAuthConsent() {
  let input: typeof AuthorizationRequest.Type;
  try {
    input = readAuthorizationRequest(window.location.search);
  } catch {
    return (
      <ListMessage icon="lock" title="Invalid authorization request">
        Return to your client and start a new connection.
      </ListMessage>
    );
  }
  return <Consent input={input} />;
}
