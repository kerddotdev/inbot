import { Clock, Effect } from "effect";
import { Provisioner } from "./provisioner.js";

export function startProvisionLoop() {
  return Effect.gen(function* () {
    const provisioner = yield* Provisioner;
    let nextReconcile = 0;
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      if (now >= nextReconcile) {
        yield* provisioner.routing
          .reconcile()
          .pipe(Effect.catchTag("ProvisionError", () => Effect.void));
        nextReconcile = now + 5 * 60 * 1000;
      }
      yield* provisioner.routing.run();
      yield* provisioner.verifyPending();
      yield* Effect.sleep("10 seconds");
    }
  }).pipe(Effect.forkScoped);
}
