import { Effect } from "effect";
import { RemoteAccess } from "./remote.js";

export function startRemoteLoop() {
  return Effect.gen(function* () {
    const remote = yield* RemoteAccess;
    while (true) {
      yield* remote.tick();
      yield* Effect.sleep("1 second");
    }
  }).pipe(Effect.forkScoped);
}
