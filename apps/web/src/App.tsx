import { useEffect } from "react";
import { Shell } from "./components/Shell";
import { apiKeys, dnsRecords, DOMAIN, drafts, inboxIds, remoteAccess, threads } from "./mock";
import { Approvals } from "./screens/Approvals";
import { ApiKeys } from "./screens/ApiKeys";
import { Locked, Login, Setup } from "./screens/Auth";
import { Domains } from "./screens/Domains";
import { Mail } from "./screens/Mail";
import { Remote } from "./screens/Remote";
import { Settings } from "./screens/Settings";
import { defaultRoute, links, navigate, useRoute, type Route } from "./router";

const sidebarInboxes = inboxIds.map((id) => ({
  id,
  unread: threads.filter((thread) => thread.inbox === id && thread.unread).length,
}));

function Screen({ route }: { route: Exclude<Route, { name: "setup" | "login" | "locked" }> }) {
  switch (route.name) {
    case "inbox": {
      const inboxThreads = threads.filter((thread) => thread.inbox === route.inboxId);
      return (
        <Mail
          inboxId={route.inboxId}
          threads={inboxThreads}
          selectedId={route.threadId}
          state={route.state ?? "ready"}
        />
      );
    }
    case "approvals":
      return (
        <Approvals
          drafts={drafts}
          selectedId={route.draftId ?? drafts[0]?.id}
          state={route.state ?? "ready"}
        />
      );
    case "domains":
      return <Domains domain={DOMAIN} records={dnsRecords} />;
    case "keys":
      return <ApiKeys keys={apiKeys} />;
    case "remote":
      return <Remote initial={remoteAccess} />;
    case "settings":
      return <Settings />;
  }
}

export function App() {
  const route = useRoute();

  useEffect(() => {
    if (!route) navigate(defaultRoute);
  }, [route]);

  if (!route) return null;

  switch (route.name) {
    case "setup":
      return <Setup onSubmit={() => navigate(links.login)} />;
    case "login":
      return <Login onSubmit={() => navigate(defaultRoute)} />;
    case "locked":
      return <Locked onSubmit={() => navigate(defaultRoute)} />;
    default:
      return (
        <Shell route={route} inboxes={sidebarInboxes} approvalsCount={drafts.length}>
          <Screen route={route} />
        </Shell>
      );
  }
}
