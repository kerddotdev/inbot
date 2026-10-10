import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { Home } from "../home.js";
import { hashToken } from "./api-keys.js";

export const Connection = Schema.Struct({ url: Schema.String, token: Schema.String });

export class ConnectionError extends Schema.TaggedError<ConnectionError>()("ConnectionError", {}) {
  readonly code = "service_unavailable";
  readonly fix = "Check the home directory permissions and available disk space.";
}

export class OwnerAuth extends Context.Service<
  OwnerAuth,
  {
    readonly authenticate: (bearer: string) => boolean;
  }
>()("inbot/OwnerAuth") {
  static layer(url: string) {
    return Layer.effect(
      OwnerAuth,
      Effect.gen(function* () {
        const home = yield* Home;
        const digest = yield* Effect.tryPromise({
          try: async () => {
            const token = randomBytes(32).toString("base64url");
            const path = join(home.path, "connection.json");
            const temporary = `${path}.${randomUUID()}.tmp`;
            try {
              const handle = await open(temporary, "wx", 0o600);
              try {
                await handle.writeFile(`${JSON.stringify({ url, token })}\n`, "utf8");
                await handle.sync();
              } finally {
                await handle.close();
              }
              await rename(temporary, path);
            } finally {
              await rm(temporary, { force: true });
            }
            return hashToken(token);
          },
          catch: () => new ConnectionError({}),
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => digest.fill(0)));
        return { authenticate: (bearer: string) => timingSafeEqual(hashToken(bearer), digest) };
      }),
    );
  }
}
