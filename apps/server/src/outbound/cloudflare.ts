import { Clock, Context, Effect, Layer, Schema } from "effect";
import { OutboundError, invalid, tooLarge } from "./errors.js";

const Address = Schema.Union([
  Schema.String,
  Schema.Struct({ address: Schema.String, name: Schema.String }),
]);
export const ProviderAttachment = Schema.Struct({
  content: Schema.String,
  filename: Schema.String,
  type: Schema.String,
  disposition: Schema.Literals(["inline", "attachment"]),
  content_id: Schema.optionalKey(Schema.String),
});
export const ProviderMessage = Schema.Struct({
  from: Address,
  to: Schema.Array(Address),
  cc: Schema.Array(Address),
  bcc: Schema.Array(Address),
  reply_to: Schema.optionalKey(Address),
  subject: Schema.String,
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  attachments: Schema.Array(ProviderAttachment),
  headers: Schema.Record(Schema.String, Schema.String),
});
export type ProviderMessage = typeof ProviderMessage.Type;

export function cloudflareRequest(message: ProviderMessage) {
  const { to, cc, bcc, attachments, headers, ...fields } = message;
  return {
    ...fields,
    ...(to.length ? { to } : {}),
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(attachments.length
      ? {
          attachments: attachments.map(({ content_id, ...attachment }) => ({
            ...attachment,
            ...(attachment.disposition === "inline" && content_id !== undefined
              ? { content_id }
              : {}),
          })),
        }
      : {}),
  };
}

export interface OutboundProviderService {
  readonly send: (
    message: ProviderMessage,
  ) => Effect.Effect<{ readonly provider_message_id: string }, OutboundError>;
}

const ApiResponse = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ code: Schema.Union([Schema.Int, Schema.String]), message: Schema.String }),
    ),
  ),
  result: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ message_id: Schema.optionalKey(Schema.String) })),
  ),
});

function failure(
  code: OutboundError["code"],
  retryable: boolean,
  extra: { retry_after_ms?: number; outcome_unknown?: boolean } = {},
) {
  return new OutboundError({
    code,
    retryable,
    ...extra,
    message: "The outbound provider did not confirm acceptance.",
    fix: extra.outcome_unknown
      ? "Reconcile provider logs before deciding whether to send again."
      : retryable
        ? "Wait for the scheduled retry or check the provider quota."
        : "Check sender onboarding, token permissions, and request limits.",
  });
}

function mapFailure(
  status: number,
  errors: readonly { code: number | string; message: string }[],
  retryAfter: number | undefined,
) {
  const values = errors.flatMap((error) => [String(error.code), error.message]);
  if (
    values.some((value) =>
      /E_SENDER_NOT_VERIFIED|sender_not_verified|domain_not_verified/.test(value),
    )
  )
    return failure("domain_not_verified", false);
  if (values.some((value) => value.startsWith("E_HEADER")))
    return invalid("The provider rejected the request headers.");
  if (
    status === 429 ||
    values.some((value) => /quota|throttled|E_RATE_LIMIT|E_DAILY_LIMIT/i.test(value))
  )
    return failure(
      "rate_limit_exceeded",
      true,
      retryAfter === undefined ? {} : { retry_after_ms: retryAfter },
    );
  if (status >= 500)
    return failure(
      "service_unavailable",
      true,
      retryAfter === undefined ? {} : { retry_after_ms: retryAfter },
    );
  if (status === 413 || values.includes("10200")) return tooLarge();
  if (status === 401) return failure("unauthorized", false);
  if (status === 403) return failure("missing_permission", false);
  return invalid("The provider rejected the request or its headers.");
}

export interface CloudflareConfig {
  readonly account_id: string;
  readonly api_token: string;
  readonly timeout_ms?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class OutboundProvider extends Context.Service<OutboundProvider, OutboundProviderService>()(
  "inbot/OutboundProvider",
) {
  static live(config: CloudflareConfig) {
    const request = config.fetch ?? globalThis.fetch;
    return Layer.succeed(
      OutboundProvider,
      OutboundProvider.of({
        send: (message) =>
          Effect.gen(function* () {
            const timeout = config.timeout_ms ?? 30_000;
            if (
              !config.account_id ||
              !config.api_token ||
              !Number.isFinite(timeout) ||
              timeout <= 0 ||
              timeout > 60_000
            )
              return yield* invalid(
                "Provider configuration requires an account, token, and timeout of at most 60 seconds.",
              );
            const now = yield* Clock.currentTimeMillis;
            return yield* Effect.tryPromise({
              try: async (signal) => {
                const response = await request(
                  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.account_id)}/email/sending/send`,
                  {
                    method: "POST",
                    redirect: "error",
                    signal,
                    headers: {
                      Authorization: `Bearer ${config.api_token}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(cloudflareRequest(message)),
                  },
                );
                const retryHeader = response.headers.get("Retry-After");
                const seconds = retryHeader === null ? NaN : Number(retryHeader);
                const retryAfter =
                  retryHeader === null
                    ? undefined
                    : Number.isFinite(seconds)
                      ? Math.max(0, seconds * 1000)
                      : Number.isFinite(Date.parse(retryHeader))
                        ? Math.max(0, Date.parse(retryHeader) - now)
                        : undefined;
                let decoded: typeof ApiResponse.Type;
                try {
                  decoded = Schema.decodeUnknownSync(ApiResponse)(await response.json());
                } catch {
                  if (!response.ok) throw mapFailure(response.status, [], retryAfter);
                  throw failure("service_unavailable", false, { outcome_unknown: true });
                }
                if (!response.ok || !decoded.success)
                  throw mapFailure(response.status, decoded.errors ?? [], retryAfter);
                const id = decoded.result?.message_id;
                if (!id || !/^<[^\s<>@]+@[^\s<>@]+>$/.test(id))
                  throw failure("service_unavailable", false, { outcome_unknown: true });
                return { provider_message_id: id };
              },
              catch: (error) =>
                error instanceof OutboundError
                  ? error
                  : failure("service_unavailable", true, { outcome_unknown: true }),
            }).pipe(
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () =>
                  Effect.fail(failure("service_unavailable", true, { outcome_unknown: true })),
              }),
            );
          }),
      }),
    );
  }

  static fake(send: OutboundProviderService["send"]) {
    return Layer.succeed(OutboundProvider, OutboundProvider.of({ send }));
  }
}
