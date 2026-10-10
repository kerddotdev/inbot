import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";

export interface HomeOptions {
  readonly flag?: string;
  readonly env?: string;
  readonly flavor: "production" | "development";
}

export function resolveHome({ flag, env = process.env.INBOT_HOME, flavor }: HomeOptions): string {
  return resolve(flag ?? env ?? join(homedir(), flavor === "production" ? ".inbot" : ".inbot-dev"));
}

export class HomeError extends Schema.TaggedError<HomeError>()("HomeError", {}) {
  readonly code = "home_unavailable";
  readonly fix = "Choose a writable home directory owned by the current user.";
}

export class Home extends Context.Service<Home, { readonly path: string }>()("inbot/Home") {
  static layer(options: HomeOptions) {
    return Layer.effect(
      Home,
      Effect.tryPromise({
        try: async () => {
          const path = resolveHome(options);
          await mkdir(path, { recursive: true, mode: 0o700 });
          if (process.platform === "win32") {
            await chmod(path, 0o700).catch(() => {});
          } else {
            await chmod(path, 0o700);
          }
          return { path };
        },
        catch: () => new HomeError({}),
      }),
    );
  }
}
