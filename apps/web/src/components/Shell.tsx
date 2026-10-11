import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { links, type Route } from "../router";
import type { Inbox } from "@inbot/contracts/src/inboxes.js";
import { Button, IconButton, Status } from "./ui";

interface ShellProps {
  route: Route;
  inboxes: readonly Inbox[];
  approvalsCount: number | undefined;
  onLogout: () => void;
  loggingOut: boolean;
  inboxFeedback: ReactNode;
  onNewInbox: () => void;
  children: ReactNode;
}

const manage: { key: Route["name"]; icon: IconName; label: string; href: string }[] = [
  { key: "approvals", icon: "check-circle", label: "Approvals", href: links.approvals() },
  { key: "domains", icon: "globe", label: "Domains", href: links.domains },
  { key: "keys", icon: "key", label: "API keys", href: links.keys },
  { key: "remote", icon: "link", label: "Remote access", href: links.remote },
  { key: "settings", icon: "gear", label: "Settings", href: links.settings },
];

const itemClasses =
  "flex w-full items-center gap-[9px] rounded-[7px] px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-hover aria-[current=page]:bg-sel aria-[current=page]:font-semibold aria-[current=page]:[&_svg:first-child]:text-accent";

export function Shell({
  route,
  inboxes,
  approvalsCount,
  children,
  onLogout,
  loggingOut,
  inboxFeedback,
  onNewInbox,
}: ShellProps) {
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => setNavOpen(false), [route]);

  useEffect(() => {
    if (!navOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [navOpen]);

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr] bg-win lg:grid-cols-[232px_1fr] lg:grid-rows-1">
      <div className="flex h-[52px] items-center gap-2 border-b border-line bg-side px-3 lg:hidden">
        <IconButton
          icon="menu"
          label="Menu"
          aria-expanded={navOpen}
          aria-controls="sidebar"
          onClick={() => setNavOpen((value) => !value)}
        />
        <span className="font-semibold">Inbot</span>
      </div>
      {navOpen ? (
        <div
          className="fixed inset-0 z-20 animate-fade bg-scrim lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      <nav
        id="sidebar"
        aria-label="Sidebar"
        className={`fixed inset-y-0 left-0 z-30 flex w-[232px] flex-col border-r border-line bg-side px-2.5 pb-3 shadow-sheet transition-[transform,visibility] duration-200 lg:static lg:visible lg:translate-x-0 lg:shadow-none ${navOpen ? "visible translate-x-0" : "invisible -translate-x-full"}`}
      >
        <div className="flex h-[52px] items-center gap-2 px-2.5 font-semibold tracking-[-0.005em]">
          <Icon name="inbox" className="text-accent" />
          Inbot
        </div>
        <div className="mt-2.5">
          <h3 className="px-2.5 py-1 text-xs font-semibold text-ink2">Inboxes</h3>
          <Button
            variant="quiet"
            icon="plus"
            className="mb-1 w-full justify-start px-2.5"
            onClick={() => {
              setNavOpen(false);
              onNewInbox();
            }}
          >
            New inbox
          </Button>
          {inboxFeedback}
          {inboxes.map((inbox) => (
            <a
              key={inbox.inbox_id}
              href={links.inbox(inbox.inbox_id)}
              aria-current={
                route.name === "inbox" && route.inboxId === inbox.inbox_id ? "page" : undefined
              }
              className={itemClasses}
            >
              <Icon name="inbox" />
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate">{inbox.display_name || inbox.email}</span>
                {!inbox.display_name ? null : (
                  <small className="truncate text-[11px] text-ink2">{inbox.email}</small>
                )}
                {inbox.status === "paused" ? (
                  <Status tone="warn" icon="minus-circle" className="mt-1 text-[11px]">
                    Paused
                  </Status>
                ) : null}
              </span>
            </a>
          ))}
        </div>
        <div className="mt-2.5">
          <h3 className="px-2.5 py-1 text-xs font-semibold text-ink2">Manage</h3>
          {manage.map((item) => (
            <a
              key={item.key}
              href={item.href}
              aria-current={route.name === item.key ? "page" : undefined}
              className={itemClasses}
            >
              <Icon name={item.icon} />
              {item.label}
              {item.key === "approvals" && approvalsCount !== undefined && approvalsCount > 0 ? (
                <span className="ml-auto text-xs font-[650] text-accent tabular-nums">
                  {approvalsCount}
                  <span className="sr-only"> pending</span>
                </span>
              ) : null}
            </a>
          ))}
        </div>
        <div className="mt-auto flex items-center gap-2 border-t border-line py-1.5 pr-1 pl-2.5 text-[11.5px] text-ink2">
          <span className="flex-1 whitespace-nowrap">Unlocked - encrypted at rest</span>
          <button
            type="button"
            aria-label="Sign out"
            title="Sign out"
            className="grid size-7 place-items-center rounded-[7px] hover:bg-hover hover:text-ink"
            onClick={onLogout}
            disabled={loggingOut}
          >
            <Icon name="lock" />
          </button>
        </div>
      </nav>
      <main className="flex min-h-0 min-w-0 flex-col">{children}</main>
    </div>
  );
}
