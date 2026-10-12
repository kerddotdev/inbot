import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Quarantine } from "../inbound/quarantine.js";
import { ServerApi } from "./api.js";
import { respond } from "./errors.js";

export const QuarantineHandlers = HttpApiBuilder.group(ServerApi, "quarantine", (handlers) =>
  Effect.gen(function* () {
    const quarantine = yield* Quarantine;
    return handlers
      .handle("quarantine_list", ({ query }) => respond(quarantine.list(query)))
      .handle("quarantine_retry", ({ params }) => respond(quarantine.retry(params.quarantine_id)))
      .handle("quarantine_delete", ({ params }) =>
        respond(quarantine.delete(params.quarantine_id)),
      );
  }),
);
