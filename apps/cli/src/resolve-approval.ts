import { setTimeout } from "node:timers/promises";
import { Schema } from "effect";
import { CredentialsApi } from "../../../packages/contracts/src/api/vault.js";
import {
  ResolveCredentialsResponse,
  type ResolveCredentialsRequest,
} from "../../../packages/contracts/src/vault.js";
import type { CliIO } from "./cli.js";
import { request } from "./client.js";
import { CliError } from "./errors.js";

export async function resolveWithApproval(
  auth: { url: string; token: string },
  body: ResolveCredentialsRequest,
  idempotencyKey: string,
  timeoutSeconds: number,
  io: CliIO,
) {
  const controller = new AbortController();
  let cancelled = 143;
  const interrupt = () => {
    cancelled = 130;
    controller.abort();
  };
  const terminate = () => {
    cancelled = 143;
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  io.signal?.addEventListener("abort", terminate, { once: true });
  if (io.signal?.aborted) terminate();
  let deadline: AbortSignal | undefined;
  let signal = controller.signal;
  let pending: CliError | undefined;
  const endpoint = CredentialsApi.endpoints.credentials_resolve;
  try {
    while (true) {
      if (controller.signal.aborted) return cancelled;
      if (deadline?.aborted && pending !== undefined) throw pending;
      try {
        return Schema.decodeUnknownSync(ResolveCredentialsResponse)(
          await request(auth, endpoint, endpoint.path, body, idempotencyKey, undefined, signal),
        );
      } catch (error) {
        if (controller.signal.aborted) return cancelled;
        if (deadline?.aborted && pending !== undefined) throw pending;
        if (!(error instanceof CliError) || error.detail.code !== "approval_required") throw error;
        if (pending === undefined) io.stderr(`Idempotency-Key: ${idempotencyKey}\n`);
        if (timeoutSeconds === 0 || !error.detail.fix?.includes("same idempotency key"))
          throw error;
        if (pending === undefined) {
          deadline = AbortSignal.timeout(Math.ceil(timeoutSeconds * 1000));
          signal = AbortSignal.any([controller.signal, deadline]);
          const id = /request ([0-9a-f]{32})/.exec(error.detail.message)?.[1];
          if (id === undefined) throw error;
          io.stderr(`Waiting for owner approval (request ${id})...\n`);
        }
        pending = error;
      }
      try {
        await setTimeout(2000, undefined, { signal });
      } catch {
        if (controller.signal.aborted) return cancelled;
        throw pending;
      }
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    io.signal?.removeEventListener("abort", terminate);
  }
}
