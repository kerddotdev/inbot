import { expect, test } from "vitest";
import { authRedirect } from "./auth-route";
import { links, parseRoute } from "./router";

test("requires a verified session before visiting owner screens", () => {
  const status = { setup_required: false, authenticated: false, locked: false };
  for (const hash of ["#/keys", "#/approvals", "#/inbox/agent%40example.test", "#/settings"]) {
    expect(authRedirect(status, parseRoute(hash))).toBe(links.login);
    expect(authRedirect({ ...status, setup_required: true }, parseRoute(hash))).toBe(links.setup);
    expect(authRedirect({ ...status, authenticated: true, locked: true }, parseRoute(hash))).toBe(
      links.locked,
    );
    expect(authRedirect({ ...status, authenticated: true }, parseRoute(hash))).toBeUndefined();
  }
  expect(authRedirect(status, parseRoute(links.login))).toBeUndefined();
  expect(authRedirect({ ...status, authenticated: true }, parseRoute(links.login))).toBe(
    links.inbox(),
  );
});

test("routes round-trip inbox and message identifiers without treating them as URL syntax", () => {
  const route = parseRoute(links.inbox("agent+test@example.test", "<thread/a>?x#y"));
  expect(route).toMatchObject({
    name: "inbox",
    inboxId: "agent+test@example.test",
    threadId: "<thread/a>?x#y",
  });
  expect(parseRoute("#/inbox/%invalid")).toBeUndefined();
  expect(parseRoute(links.inbox())).toMatchObject({ name: "inbox", inboxId: undefined });
});
