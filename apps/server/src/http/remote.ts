import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { RemoteAccess } from "../remote/remote.js";
import { ServerApi } from "./api.js";
import { respond } from "./errors.js";

export const RemoteHandlers = HttpApiBuilder.group(ServerApi, "remote", (handlers) =>
  Effect.gen(function* () {
    const remote = yield* RemoteAccess;
    return handlers
      .handle("remote_status", () => respond(remote.status()))
      .handle("remote_enable", ({ payload }) => respond(remote.enable(payload)))
      .handle("remote_disable", () => respond(remote.disable()));
  }),
);
