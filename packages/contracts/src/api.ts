import { CredentialUseApi } from "./api/credential-use.js";
import { HttpApi } from "effect/http-api";
import { InboxesApi } from "./api/inboxes.js";
import { ThreadsApi } from "./api/threads.js";
import { MessagesApi } from "./api/messages.js";
import { DraftsApi } from "./api/drafts.js";
import { WebhooksApi } from "./api/webhooks.js";
import { DomainsApi } from "./api/domains.js";
import { ListsApi } from "./api/lists.js";
import { ApiKeysApi } from "./api/api-keys.js";
import { CredentialsApi } from "./api/vault.js";

export const InbotApi = HttpApi.make("inbot").add(
  InboxesApi,
  ThreadsApi,
  MessagesApi,
  DraftsApi,
  WebhooksApi,
  DomainsApi,
  ListsApi,
  ApiKeysApi,
  CredentialsApi,
  CredentialUseApi,
);
