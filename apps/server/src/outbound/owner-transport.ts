import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";
import {
  OwnerTransportRequest,
  type OwnerTransportStatus,
} from "../../../../packages/contracts/src/owner.js";
import { CloudflareApi } from "../provision/cloudflare-api.js";
import { ProvisionError, actionRequired } from "../provision/errors.js";
import { Provisioner } from "../provision/provisioner.js";
import { repository } from "../provision/repository.js";
import { remoteRepository } from "../remote/repository.js";
import { Store } from "../store.js";
import { TransportConfig } from "./transport-config.js";

function makeOwnerTransport(
  store: Store["Service"],
  transport: TransportConfig["Service"],
  provisioner: Provisioner["Service"],
  fetch?: typeof globalThis.fetch,
) {
  const repo = repository(store);
  const inspect = () =>
    Effect.map(transport.get(), (settings): OwnerTransportStatus => ({
      provider: "cloudflare",
      account_id: settings?.account_id ?? null,
      token_set: settings !== undefined,
      verification_status:
        settings === undefined
          ? "not_configured"
          : settings.verified_at === undefined
            ? "unverified"
            : "verified",
      verified_at: settings?.verified_at ?? null,
    }));
  return {
    inspect,
    configure: (input: OwnerTransportRequest) =>
      provisioner.withConfigurationLock(
        Effect.gen(function* () {
          const settings = yield* Schema.decodeUnknownEffect(OwnerTransportRequest)(input).pipe(
            Effect.mapError(
              () =>
                new ProvisionError({
                  code: "validation_error",
                  message: "A Cloudflare account ID and API token are required.",
                  fix: "Use the 32-character account ID and an API token without whitespace.",
                }),
            ),
          );
          const remote = yield* remoteRepository(store).get();
          if (remote !== undefined && remote.account_id !== settings.account_id)
            return yield* actionRequired(
              "Remote access belongs to a different Cloudflare account.",
              "Disable remote access before changing accounts.",
            );
          if ((yield* repo.all()).some((domain) => domain.account_id !== settings.account_id))
            return yield* actionRequired(
              "Registered domains belong to a different Cloudflare account.",
              "Teardown and delete the registered domains before changing accounts.",
            );
          const candidate = CloudflareApi.live(fetch === undefined ? {} : { fetch }).pipe(
            Layer.provide(
              Layer.succeed(TransportConfig, {
                ...transport,
                get: () =>
                  Effect.succeed({
                    account_id: settings.account_id,
                    api_token: Redacted.make(settings.api_token),
                  }),
              }),
            ),
          );
          yield* Effect.flatMap(CloudflareApi, (api) => api.verifyToken()).pipe(
            Effect.provide(candidate),
            Effect.mapError(
              (error) =>
                new ProvisionError({
                  code: error instanceof ProvisionError ? error.code : "service_unavailable",
                  message: "The Cloudflare token could not be verified.",
                  fix: "Check the account ID, active token, and Cloudflare availability, then verify and save again.",
                }),
            ),
          );
          const verifiedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          yield* transport.set(settings, verifiedAt);
          return yield* inspect();
        }),
      ),
    clear: () =>
      provisioner.withConfigurationLock(
        Effect.gen(function* () {
          if ((yield* remoteRepository(store).get()) !== undefined)
            return yield* actionRequired(
              "Remote access still needs the configured transport.",
              "Disable remote access before clearing the transport.",
            );
          for (const domain of yield* repo.all()) {
            if (
              domain.phase !== "registered" ||
              (yield* repo.resources(domain.domain_id)).length > 0
            )
              return yield* actionRequired(
                "The mail transport is still needed by a provisioned domain.",
                "Teardown the domain and its recorded resources before clearing the transport.",
              );
          }
          yield* transport.clear();
        }),
      ),
  };
}

export class OwnerTransport extends Context.Service<
  OwnerTransport,
  ReturnType<typeof makeOwnerTransport>
>()("inbot/OwnerTransport") {
  static live(options: { readonly fetch?: typeof globalThis.fetch } = {}) {
    return Layer.effect(
      OwnerTransport,
      Effect.gen(function* () {
        return makeOwnerTransport(
          yield* Store,
          yield* TransportConfig,
          yield* Provisioner,
          options.fetch,
        );
      }),
    );
  }
}
