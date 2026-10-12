import { QuarantineApi } from "../../../packages/contracts/src/api/quarantine.js";
import type { Command } from "./commands.js";

export const quarantineCommands: readonly Command[] = [
  {
    name: "quarantine list",
    description: "List inbound quarantine metadata as owner.",
    endpoint: QuarantineApi.endpoints.quarantine_list,
    query: { limit: "number", page_token: "string" },
  },
  {
    name: "quarantine retry",
    description: "Retry a quarantined buffer object as owner; Queue metadata cannot be retried.",
    endpoint: QuarantineApi.endpoints.quarantine_retry,
    params: ["quarantine_id"],
  },
  {
    name: "quarantine delete",
    description: "Delete quarantined ciphertext and metadata as owner. This is permanent.",
    endpoint: QuarantineApi.endpoints.quarantine_delete,
    params: ["quarantine_id"],
  },
];
