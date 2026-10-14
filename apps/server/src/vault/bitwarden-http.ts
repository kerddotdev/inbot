import { NodeHttpServerRequest, NodeStream } from "@effect/platform-node";
import { Effect, Stream } from "effect";
import type { HttpServerRequest } from "effect/http";
import { BITWARDEN_MAX_BYTES } from "../../../../packages/contracts/src/bitwarden.js";
import { validationError } from "../mailbox/errors.js";

export function readBitwardenBody(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const failure = () =>
      validationError(
        "The Bitwarden JSON body is invalid or exceeds 5 MB.",
        "Send a complete unencrypted JSON export of at most 5 MB.",
      );
    if (Number(request.headers["content-length"]) > BITWARDEN_MAX_BYTES)
      return yield* Effect.fail(failure());
    let size = 0;
    const chunks = yield* NodeStream.fromReadable({
      evaluate: () => NodeHttpServerRequest.toIncomingMessage(request),
      onError: failure,
      chunkSize: 64 * 1024,
      // Destroying the request here would close the socket before the validation response.
      closeOnDone: false,
    }).pipe(
      Stream.runFoldEffect(
        (): Uint8Array[] => [],
        (chunks, chunk) => {
          size += chunk.byteLength;
          if (size > BITWARDEN_MAX_BYTES) return Effect.fail(failure());
          chunks.push(chunk);
          return Effect.succeed(chunks);
        },
      ),
    );
    return yield* Effect.try({
      try: (): unknown => JSON.parse(Buffer.concat(chunks).toString("utf8")),
      catch: failure,
    });
  });
}
