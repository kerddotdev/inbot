import { Effect } from "effect";
import { Drafts } from "./drafts.js";

export function startDraftLoop() {
  return Effect.gen(function* () {
    const drafts = yield* Drafts;
    return yield* Effect.gen(function* () {
      while (true) {
        const processed = yield* drafts.processDue();
        yield* drafts.waitForDue(processed === 0 ? 30_000 : 2000);
      }
    }).pipe(Effect.forkScoped);
  });
}
