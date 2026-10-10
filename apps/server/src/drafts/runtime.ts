import { Effect } from "effect";
import { Drafts } from "./drafts.js";

export function startDraftLoop() {
  return Effect.gen(function* () {
    const drafts = yield* Drafts;
    return yield* Effect.gen(function* () {
      while (true) {
        const processed = yield* drafts.processDue();
        yield* Effect.sleep(processed === 0 ? "30 seconds" : "2 seconds");
      }
    }).pipe(Effect.forkScoped);
  });
}
