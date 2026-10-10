import { useEffect, useRef, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { OwnerStatus } from "@inbot/contracts/src/owner.js";
import { useLiveEvents } from "./events";
import { api, ApiError, errorText } from "./api";
import { authRedirect } from "./auth-route";
import { Shell } from "./components/Shell";
import { Button, ListMessage, Status } from "./components/ui";
import { LoadError, ErrorNotice } from "./feedback";
import { approvalsQuery, inboxesQuery } from "./queries";
import { Approvals } from "./screens/Approvals";
import { ApiKeys } from "./screens/ApiKeys";
import { Locked, Login, Setup } from "./screens/Auth";
import { Domains } from "./screens/Domains";
import { Mail } from "./screens/Mail";
import { Remote } from "./screens/Remote";
import { Settings } from "./screens/Settings";
import { links, navigate, useRoute, type Route } from "./router";

type OwnerRoute = Exclude<Route, { name: "setup" | "login" | "locked" }>;

function Screen({ route }: { route: OwnerRoute }) {
  switch (route.name) {
    case "inbox":
      return <Mail key={route.inboxId} inboxId={route.inboxId} selectedId={route.threadId} />;
    case "approvals":
      return <Approvals selectedId={route.draftId} />;
    case "domains":
      return <Domains />;
    case "keys":
      return <ApiKeys />;
    case "remote":
      return <Remote />;
    case "settings":
      return <Settings />;
  }
}

function OwnerApp({ route }: { route: OwnerRoute }) {
  useLiveEvents();
  const inboxes = useQuery(inboxesQuery);
  const approvals = useQuery(approvalsQuery);
  const client = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: async () => {
      await client.cancelQueries();
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== "owner" });
      client.setQueryData<typeof OwnerStatus.Type>(["owner"], {
        setup_required: false,
        authenticated: false,
        locked: false,
      });
    },
  });

  useEffect(() => {
    if (route.name === "inbox" && !route.inboxId && inboxes.data?.[0])
      navigate(links.inbox(inboxes.data[0].inbox_id));
  }, [route, inboxes.data]);

  return (
    <Shell
      route={route}
      inboxes={inboxes.data ?? []}
      approvalsCount={approvals.data?.length}
      onLogout={() => logout.mutate()}
      loggingOut={logout.isPending}
      inboxFeedback={
        inboxes.isPending ? (
          <div className="px-2.5 py-1">
            <Status tone="mute" icon="inbox">
              Loading inboxes
            </Status>
          </div>
        ) : inboxes.error ? (
          <div className="px-2.5">
            <ErrorNotice error={inboxes.error} />
            <Button icon="refresh" onClick={() => void inboxes.refetch()}>
              Try again
            </Button>
          </div>
        ) : inboxes.data.length === 0 ? (
          <div className="px-2.5 py-1">
            <Status tone="mute" icon="inbox">
              No inboxes yet
            </Status>
          </div>
        ) : null
      }
    >
      <ErrorNotice error={logout.error} />
      {route.name === "inbox" && !route.inboxId ? (
        inboxes.isPending ? (
          <ListMessage icon="inbox" title="Loading inboxes" />
        ) : inboxes.error ? (
          <LoadError error={inboxes.error} retry={() => void inboxes.refetch()} />
        ) : (
          <ListMessage icon="inbox" title="No inboxes yet">
            Create an inbox through the local API to start receiving mail.
          </ListMessage>
        )
      ) : (
        <Screen route={route} />
      )}
    </Shell>
  );
}

function SessionApp({ loginToken }: { loginToken: string | null }) {
  const route = useRoute();
  const client = useQueryClient();
  const [redeeming, setRedeeming] = useState(loginToken !== null);
  const redemptionStarted = useRef(false);
  const [formError, setFormError] = useState<string>();
  const status = useQuery({
    queryKey: ["owner"],
    queryFn: ({ signal }) => api.status(signal),
    enabled: !redeeming,
    staleTime: 0,
  });
  const authenticate = useMutation({
    mutationFn: (request: { password: string; code?: string }) => api.authenticate(request),
    onSuccess: async () => {
      await client.cancelQueries({ queryKey: ["owner"] });
      client.setQueryData<typeof OwnerStatus.Type>(["owner"], {
        setup_required: false,
        authenticated: true,
        locked: false,
      });
      void client.invalidateQueries({ queryKey: ["owner"] });
    },
  });

  useEffect(
    () =>
      api.subscribeSession((code) => {
        void client.cancelQueries();
        client.setQueryData<typeof OwnerStatus.Type>(["owner"], {
          setup_required: false,
          authenticated: false,
          locked: code === "locked",
        });
        client.removeQueries({ predicate: (query) => query.queryKey[0] !== "owner" });
      }),
    [client],
  );

  useEffect(() => {
    if (loginToken === null || redemptionStarted.current) return;
    redemptionStarted.current = true;
    void api
      .redeem(loginToken)
      .catch((error: unknown) => setFormError(errorText(error)))
      .finally(() => setRedeeming(false));
  }, [loginToken]);

  const redirect = status.data ? authRedirect(status.data, route) : undefined;
  useEffect(() => {
    if (redirect) navigate(redirect);
  }, [redirect]);

  useEffect(() => {
    if (status.data && (!status.data.authenticated || status.data.locked)) {
      void client.cancelQueries({ predicate: (query) => query.queryKey[0] !== "owner" });
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== "owner" });
    }
  }, [client, status.data]);

  useEffect(() => {
    authenticate.reset();
  }, [route?.name]);

  if (redeeming || status.isPending) return <ListMessage icon="lock" title="Checking session" />;
  if (status.error instanceof ApiError && status.error.code === "locked")
    return <Locked onRetry={() => void status.refetch()} />;
  if (status.error) return <LoadError error={status.error} retry={() => void status.refetch()} />;
  if (status.data.locked) return <Locked onRetry={() => void status.refetch()} />;
  if (!status.data.authenticated) {
    const submit = (form: FormData) => {
      const password = form.get("password");
      const code = form.get("code");
      if (typeof password !== "string" || authenticate.isPending) return;
      setFormError(undefined);
      if (status.data.setup_required) {
        if (password !== form.get("confirm")) {
          setFormError("Passwords do not match.");
          return;
        }
        if (password.length < 12) {
          setFormError("Choose a password with at least 12 characters.");
          return;
        }
        if (typeof code !== "string") return;
        authenticate.mutate({ password, code });
      } else authenticate.mutate({ password });
    };
    const props = {
      onSubmit: submit,
      busy: authenticate.isPending,
      error: formError ?? (authenticate.error ? errorText(authenticate.error) : undefined),
    };
    return status.data.setup_required ? <Setup {...props} /> : <Login {...props} />;
  }
  if (!route || route.name === "setup" || route.name === "login" || route.name === "locked")
    return <ListMessage icon="inbox" title="Loading mail" />;
  return <OwnerApp route={route} />;
}

export function App({ loginToken = null }: { loginToken?: string | null }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: 15_000, gcTime: 0 },
          mutations: { retry: false, gcTime: 0 },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <SessionApp loginToken={loginToken} />
    </QueryClientProvider>
  );
}
