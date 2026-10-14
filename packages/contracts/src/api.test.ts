import { Context, Schema } from "effect";
import { OpenApi } from "effect/http-api";
import { describe, expect, it } from "vitest";
import { OwnerApi } from "./api/owner.js";
import { InbotApi } from "./api.js";
import { ErrorStatus, WriteErrors } from "./errors.js";
import { SendHeaders } from "./common.js";
import { ListMessagesQuery } from "./messages.js";
import { BearerAuth, OwnerOnly, RequiredPermission } from "./security.js";

describe("HTTP API declarations", () => {
  it("generates an authenticated OpenAPI document with scoped and global routes", () => {
    const document = OpenApi.fromApi(InbotApi);
    expect(document.paths["/v0/inboxes"]?.get).toBeDefined();
    expect(document.paths["/v0/inboxes"]?.post).toBeDefined();
    expect(document.paths["/v0/inboxes/search"]?.get).toBeDefined();
    expect(document.paths["/v0/threads/{thread_id}"]?.patch).toBeDefined();
    expect(document.paths["/v0/inboxes/{inbox_id}/messages/batch-get"]?.post).toBeDefined();
    expect(
      document.paths["/v0/inboxes/{inbox_id}/messages/{message_id}/reply-all"]?.post,
    ).toBeDefined();
    expect(document.paths["/v0/drafts/{draft_id}/attachments/{attachment_id}"]?.get).toBeDefined();
    expect(
      document.paths["/v0/inboxes/{inbox_id}/webhooks/{webhook_id}/headers"]?.patch,
    ).toBeDefined();
    expect(document.paths["/v0/lists/{direction}/{type}/{entry}"]?.delete).toBeDefined();
    expect(document.paths["/v0/api-keys/{api_key_id}"]?.get).toBeDefined();
    expect(document.paths["/v0/domains/{domain_id}/verify"]?.post).toBeDefined();
    expect(document.paths["/v0/domains/{domain_id}/apply"]?.post).toBeDefined();
    expect(document.paths["/v0/domains/{domain_id}/teardown"]?.post).toBeDefined();
    expect(document.components.securitySchemes.Bearer).toMatchObject({
      type: "http",
      scheme: "Bearer",
    });
    for (const group of Object.values(InbotApi.groups)) {
      for (const endpoint of Object.values(group.endpoints)) {
        expect(endpoint.middlewares.has(BearerAuth)).toBe(true);
      }
    }
  });

  it("declares wire-correct success statuses and the zone file content type", () => {
    const document = OpenApi.fromApi(InbotApi);
    const zone = document.paths["/v0/domains/{domain_id}/zone-file"]?.get;
    expect(zone?.responses["200"]?.content?.["text/plain"]?.schema).toMatchObject({
      type: "string",
    });
    const deletion = document.paths["/v0/inboxes/{inbox_id}"]?.delete;
    expect(deletion?.responses["200"]).toBeDefined();
    expect(deletion?.responses["204"]).toBeUndefined();
    const verify = document.paths["/v0/domains/{domain_id}/verify"]?.post;
    expect(verify?.responses["200"]?.content).toBeUndefined();
    const headers = document.paths["/v0/webhooks/{webhook_id}/headers"]?.patch;
    expect(headers?.responses["204"]?.content).toBeUndefined();
  });

  it("decodes repeated query filters and converts numeric and boolean strings", () => {
    const codec = Schema.toCodecArrayFromSingle(Schema.toCodecStringTree(ListMessagesQuery));
    const query = Schema.decodeUnknownSync(codec)({
      limit: "25",
      page_token: "cursor",
      ascending: "false",
      include_spam: "true",
      labels: ["received", "unread"],
      from: ["alex", "example.com"],
      to: "assistant",
      subject: ["report"],
      before: "2026-10-10T09:12:34Z",
    });
    expect(query).toEqual({
      limit: 25,
      page_token: "cursor",
      ascending: false,
      include_spam: true,
      labels: ["received", "unread"],
      from: ["alex", "example.com"],
      to: ["assistant"],
      subject: ["report"],
      before: "2026-10-10T09:12:34Z",
    });
    expect(() => Schema.decodeUnknownSync(codec)({ limit: "not-a-number" })).toThrow();
  });

  it("validates the normalized idempotency header on every send operation", () => {
    const endpoints = [
      InbotApi.groups.messages.endpoints.inboxes_messages_send,
      InbotApi.groups.messages.endpoints.inboxes_messages_reply,
      InbotApi.groups.messages.endpoints.inboxes_messages_replyAll,
      InbotApi.groups.messages.endpoints.inboxes_messages_forward,
      InbotApi.groups.drafts.endpoints.inboxes_drafts_send,
    ];
    expect(Schema.decodeUnknownSync(SendHeaders)({ "idempotency-key": "request-1._~" })).toEqual({
      "idempotency-key": "request-1._~",
    });
    expect(Schema.decodeUnknownSync(SendHeaders)({})).toEqual({});
    expect(() =>
      Schema.decodeUnknownSync(SendHeaders)({ "idempotency-key": "invalid key" }),
    ).toThrow();
    const document = OpenApi.fromApi(InbotApi);
    for (const endpoint of endpoints) {
      const path = endpoint.path.replace(/:([^/]+)/g, "{$1}");
      const operation = document.paths[path]?.post;
      expect(operation?.parameters).toContainEqual(
        expect.objectContaining({
          in: "header",
          name: "idempotency-key",
          required: false,
        }),
      );
    }
  });

  it("keeps domains and API keys owner-only and annotates agent permissions", () => {
    for (const group of [InbotApi.groups.domains, InbotApi.groups["api-keys"]]) {
      for (const endpoint of Object.values(group.endpoints)) {
        expect(endpoint.middlewares.has(OwnerOnly)).toBe(true);
        expect([...endpoint.middlewares]).toEqual([OwnerOnly, BearerAuth]);
      }
    }
    expect(
      Context.get(
        InbotApi.groups.messages.endpoints.inboxes_messages_send.annotations,
        RequiredPermission,
      ),
    ).toBe("message_send");
    expect(
      Context.get(
        InbotApi.groups.messages.endpoints.inboxes_messages_reply.annotations,
        RequiredPermission,
      ),
    ).toBe("message_reply");
    expect(
      Context.get(InbotApi.groups.threads.endpoints.threads_get.annotations, RequiredPermission),
    ).toBe("message_read");
  });

  it("maps every wire error code to the status declared by its schema", () => {
    const seen = new Set<string>();
    for (const schema of WriteErrors) {
      const status = schema.ast.annotations?.httpApiStatus;
      for (const code of schema.fields.code.literals) {
        const body = { name: "ApiError", code, message: "Synthetic failure" };
        const decoded = Schema.decodeUnknownSync(schema)(body);
        expect(ErrorStatus[decoded.code]).toBe(status);
        expect(Schema.encodeSync(schema)(decoded)).toEqual(body);
        seen.add(code);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(ErrorStatus).sort());
  });
});

it("declares owner browser auth separately from mailbox routes with public and protected endpoints", () => {
  const document = OpenApi.fromApi(OwnerApi);
  expect(document.paths["/v0/owner/status"]?.get).toBeDefined();
  expect(document.paths["/v0/owner/setup"]?.post?.security ?? []).toEqual([]);
  expect(document.paths["/v0/owner/login-links/redeem"]?.post).toBeDefined();
  expect(document.paths["/v0/owner/sessions/{id}"]?.delete).toBeDefined();
  for (const name of [
    "owner_logout",
    "owner_sessions",
    "owner_revoke",
    "owner_password",
    "owner_loginLink",
  ] as const) {
    const endpoint = OwnerApi.groups.owner.endpoints[name];
    expect(endpoint.middlewares.has(OwnerOnly)).toBe(true);
    expect(endpoint.middlewares.has(BearerAuth)).toBe(true);
  }
  expect(Object.keys(InbotApi.groups)).not.toContain("owner");
});

it("declares vault permissions and keeps reveal owner-only inside the authenticated group", () => {
  const group = InbotApi.groups.credentials;
  for (const [name, endpoint] of Object.entries(group.endpoints)) {
    expect(endpoint.middlewares.has(BearerAuth)).toBe(true);
    if (name === "inboxes_credentials_reveal") {
      expect([...endpoint.middlewares]).toContain(OwnerOnly);
      expect(Context.get(endpoint.annotations, RequiredPermission)).toBeUndefined();
    } else {
      expect([...endpoint.middlewares]).not.toContain(OwnerOnly);
      expect(Context.get(endpoint.annotations, RequiredPermission)).toMatch(/^credential_/);
    }
  }
  expect(
    Context.get(group.endpoints.inboxes_credentials_totp.annotations, RequiredPermission),
  ).toBe("credential_totp");
  expect(
    Context.get(group.endpoints.inboxes_credentials_generate.annotations, RequiredPermission),
  ).toBe("credential_update");
});
