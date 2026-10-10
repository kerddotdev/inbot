import { randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import { Clock, Context, Effect, Layer, Redacted } from "effect";
import type { RemoteStatus } from "../../../../packages/contracts/src/remote.js";
import { Home } from "../home.js";
import {
  assertSubdomain,
  CloudflareApi,
  type Zone,
  type Tunnel,
} from "../provision/cloudflare-api.js";
import { actionRequired, invalid, ProvisionError } from "../provision/errors.js";
import { Provisioner } from "../provision/provisioner.js";
import { Store } from "../store.js";
import { cloudflaredVersion, makeBinary } from "./binary.js";
import { spawnConnector, type ConnectorProcess, type ProcessSpawner } from "./process.js";
import { remoteRepository, type RemoteRow } from "./repository.js";

function normalize(value: string) {
  if (/[\s\\/?#:@%]/.test(value)) throw invalid("A literal hostname is required.");
  const hostname = domainToASCII(value).toLowerCase();
  if (
    !hostname ||
    hostname.length > 253 ||
    !hostname
      .split(".")
      .every((part) => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))
  )
    throw invalid(
      "A valid literal remote hostname is required.",
      "Use a subdomain in the configured Cloudflare account.",
    );
  return hostname;
}

const remotelyManaged = (tunnel: Tunnel) =>
  tunnel.config_src === "cloudflare" ||
  (tunnel.config_src === undefined && tunnel.remote_config === true);

export function makeRemote(options: {
  readonly store: Store["Service"];
  readonly api: CloudflareApi["Service"];
  readonly provisioner: Pick<Provisioner["Service"], "withConfigurationLock">;
  readonly binary: ReturnType<typeof makeBinary>;
  readonly spawn?: ProcessSpawner;
}) {
  const { store, api, binary } = options;
  const repo = remoteRepository(store);
  const lock = options.provisioner.withConfigurationLock;
  let origin: string | undefined;
  let process: ConnectorProcess | undefined;
  let connection: RemoteStatus["state"] = "connecting";
  let attempts = 0;
  let nextAttempt = 0;
  let configured = false;
  const stop = () =>
    Effect.tryPromise({
      try: async () => {
        if (process !== undefined) {
          await process.stop();
          process = undefined;
        }
      },
      catch: () =>
        actionRequired(
          "The connector could not be stopped.",
          "Retry disable before removing its resources.",
        ),
    }).pipe(Effect.uninterruptible);
  const bound = (row: RemoteRow) =>
    Effect.gen(function* () {
      if ((yield* api.accountId()) !== row.account_id)
        return yield* actionRequired(
          "The remote tunnel belongs to a different Cloudflare account.",
          "Restore the recorded account and token, then disable remote access before changing accounts.",
        );
    });
  const zoneOf = (row: RemoteRow): Zone => ({
    id: row.zone_id,
    name: row.zone_name,
    account: { id: row.account_id },
  });
  const marker = (row: RemoteRow) => `inbot:${row.tunnel_name}`;
  const dnsMatches = (
    row: RemoteRow,
    record: { name: string; type: string; content: string; proxied?: boolean; comment?: string },
  ) =>
    record.name === row.hostname &&
    record.type === "CNAME" &&
    record.content === `${row.tunnel_id}.cfargotunnel.com` &&
    record.proxied === true &&
    record.comment === marker(row);
  const status = () =>
    Effect.map(repo.get(), (row): RemoteStatus => ({
      state:
        row === undefined
          ? "disabled"
          : row.reason !== null
            ? "action_required"
            : row.desired === "disabling" ||
                row.tunnel_id === null ||
                row.dns_id === null ||
                row.token === null
              ? "provisioning"
              : process === undefined || process.exited()
                ? "connecting"
                : connection,
      hostname: row?.hostname ?? null,
      reason: row?.reason ?? null,
      connector_version: cloudflaredVersion,
    }));
  const saveFailure = (error: ProvisionError | { readonly code: string }) =>
    Effect.gen(function* () {
      const row = yield* repo.get();
      if (row !== undefined)
        yield* repo.save({
          ...row,
          reason:
            error instanceof ProvisionError
              ? `${error.message} ${error.fix}`
              : "The encrypted remote state could not be updated. Retry locally.",
        });
    });
  const reconcile = (initial: RemoteRow) =>
    Effect.gen(function* () {
      let row = initial;
      yield* bound(row);
      const tunnels = yield* api.tunnels();
      if (row.tunnel_id === null) {
        const existing = tunnels.filter((item) => item.name === row.tunnel_name);
        if (existing.length > 1 || (existing.length > 0 && row.tunnel_intent === 0))
          return yield* actionRequired(
            "The tunnel name conflicts with an unowned resource.",
            "Resolve the conflict before retrying remote access.",
          );
        if (existing[0] !== undefined) {
          if (!remotelyManaged(existing[0]))
            return yield* actionRequired(
              "The recorded tunnel is not remotely managed.",
              "Restore the Inbot tunnel before retrying.",
            );
          row = { ...row, tunnel_id: existing[0].id };
        } else {
          row = { ...row, tunnel_intent: 1 };
          yield* repo.save(row);
          row = { ...row, tunnel_id: (yield* api.createTunnel(row.tunnel_name)).id };
        }
        yield* repo.save(row);
      } else if (
        !tunnels.some(
          (item) =>
            item.id === row.tunnel_id && item.name === row.tunnel_name && remotelyManaged(item),
        )
      ) {
        return yield* actionRequired(
          "The recorded tunnel is missing or changed.",
          "Disable remote access to reconcile its resources, then enable again.",
        );
      }
      if (row.tunnel_id === null) return yield* actionRequired("The tunnel ID was not recorded.");
      if (origin === undefined)
        return yield* actionRequired(
          "The dedicated tunnel listener is unavailable.",
          "Restart the local service before enabling remote access.",
        );
      const tunnelId = row.tunnel_id;
      yield* api.configureTunnel(tunnelId, row.hostname, origin);
      const records = (yield* api.dns(row.zone_id)).filter(
        (record) => record.name === row.hostname,
      );
      const owned = records.find(
        (record) => dnsMatches(row, record) && (row.dns_id === null || record.id === row.dns_id),
      );
      if (
        records.some((record) => !dnsMatches(row, record)) ||
        records.length > 1 ||
        (owned !== undefined && row.dns_intent === 0)
      )
        return yield* actionRequired(
          "The remote hostname has conflicting DNS records.",
          "Choose an unused subdomain. Inbot never overwrites existing DNS records.",
        );
      if (row.dns_id !== null && owned === undefined)
        return yield* actionRequired(
          "The recorded remote DNS record is missing or changed.",
          "Disable remote access and review DNS before enabling again.",
        );
      if (row.dns_id === null) {
        if (owned?.id !== undefined) row = { ...row, dns_id: owned.id };
        else {
          row = { ...row, dns_intent: 1 };
          yield* repo.save(row);
          const record = yield* api.createTunnelDns(
            zoneOf(row),
            row.hostname,
            tunnelId,
            marker(row),
          );
          if (record.id === undefined || !dnsMatches(row, record))
            return yield* actionRequired(
              "Cloudflare did not confirm the expected tunnel DNS record.",
              "Retry to reconcile the recorded DNS intent.",
            );
          row = { ...row, dns_id: record.id };
        }
        yield* repo.save(row);
      }
      const token = yield* api.tunnelToken(tunnelId);
      row = { ...row, token: Redacted.value(token), reason: null };
      yield* repo.save(row);
      configured = true;
      return row;
    });
  const cleanup = (initial: RemoteRow) =>
    Effect.gen(function* () {
      yield* stop();
      let row = initial;
      yield* bound(row);
      const tunnels = yield* api.tunnels();
      const tunnel =
        row.tunnel_id === null
          ? row.tunnel_intent === 1
            ? tunnels.find((item) => item.name === row.tunnel_name)
            : undefined
          : tunnels.find((item) => item.id === row.tunnel_id);
      if (tunnel !== undefined && (tunnel.name !== row.tunnel_name || !remotelyManaged(tunnel)))
        return yield* actionRequired(
          "The tunnel ownership no longer matches the ledger.",
          "Review the changed tunnel before retrying disable.",
        );
      if (row.tunnel_id === null && tunnel !== undefined) {
        row = { ...row, tunnel_id: tunnel.id };
        yield* repo.save(row);
      }
      const records = yield* api.dns(row.zone_id);
      const record =
        row.dns_id === null
          ? row.dns_intent === 1
            ? records.find((record) => dnsMatches(row, record))
            : undefined
          : records.find((record) => record.id === row.dns_id);
      if (record !== undefined) {
        if (!dnsMatches(row, record) || record.id === undefined)
          return yield* actionRequired(
            "The recorded DNS record has changed. It was retained.",
            "Review the changed DNS record before retrying disable.",
          );
        yield* api.deleteDns(row.zone_id, record.id);
      }
      // Keep IDs until the entire teardown is confirmed so a retry can verify ownership.
      if (tunnel !== undefined) yield* api.deleteTunnel(tunnel.id);
      yield* repo.clear();
      configured = false;
      connection = "connecting";
      attempts = 0;
      nextAttempt = 0;
    });
  const launch = (row: RemoteRow, allowDownload: boolean) =>
    Effect.gen(function* () {
      if (process !== undefined && !process.exited()) return;
      if (row.token === null)
        return yield* actionRequired(
          "The tunnel token is unavailable.",
          "Enable remote access locally to reconcile the tunnel.",
        );
      const executable = yield* binary.ensure(allowDownload);
      process = yield* Effect.tryPromise({
        try: () => (options.spawn ?? spawnConnector)(executable, row.token ?? ""),
        catch: () =>
          actionRequired(
            "cloudflared could not start.",
            "Check the verified binary and local execution permissions, then retry enable.",
          ),
      });
      connection = "connecting";
    }).pipe(Effect.uninterruptible);
  return {
    status,
    publicOrigin: () =>
      Effect.map(repo.get(), (row) =>
        row?.desired === "enabled" &&
        row.reason === null &&
        row.tunnel_id !== null &&
        row.dns_id !== null
          ? `https://${row.hostname}`
          : undefined,
      ),
    attach: (url: string) =>
      Effect.sync(() => {
        origin = url;
        configured = false;
      }),
    enable: (input: { readonly hostname: string }) =>
      lock(
        Effect.gen(function* () {
          const hostname = yield* Effect.try({
            try: () => normalize(input.hostname),
            catch: () =>
              invalid(
                "A literal subdomain is required.",
                "Use a subdomain in the configured Cloudflare account.",
              ),
          });
          if (origin === undefined)
            return yield* actionRequired(
              "The tunnel listener is unavailable.",
              "Restart the local service.",
            );
          let row = yield* repo.get();
          if (row !== undefined && (row.hostname !== hostname || row.desired === "disabling"))
            return yield* actionRequired(
              "Remote access already has a recorded configuration.",
              "Finish disabling the existing tunnel before changing its hostname.",
            );
          if (row === undefined) {
            const accountId = yield* api.accountId();
            let zone: Zone | undefined;
            const parts = hostname.split(".");
            for (let index = 0; index < parts.length - 1 && zone === undefined; index++) {
              const name = parts.slice(index).join(".");
              zone = (yield* api.zones(name)).find(
                (value) => value.name === name && value.account.id === accountId,
              );
            }
            if (zone === undefined)
              return yield* invalid(
                "The hostname is outside the configured account's zones.",
                "Use a subdomain of a zone owned by the configured account.",
              );
            yield* Effect.try({
              try: () => assertSubdomain(zone, hostname),
              catch: () => invalid("Remote access requires a subdomain, never the zone apex."),
            });
            if ((yield* api.dns(zone.id)).some((record) => record.name === hostname))
              return yield* actionRequired(
                "The remote hostname already has DNS records.",
                "Choose an unused subdomain.",
              );
            yield* api.tunnels();
            row = {
              desired: "enabled",
              hostname,
              account_id: accountId,
              zone_id: zone.id,
              zone_name: zone.name,
              tunnel_name: `inbot-remote-${randomUUID()}`,
              tunnel_intent: 0,
              tunnel_id: null,
              dns_intent: 0,
              dns_id: null,
              token: null,
              reason: null,
            };
            yield* repo.save(row);
          }
          const recorded = row;
          return yield* Effect.gen(function* () {
            yield* stop();
            attempts = 0;
            nextAttempt = 0;
            yield* binary.ensure(true);
            const configuredRow = yield* reconcile({ ...recorded, reason: null });
            yield* launch(configuredRow, false);
            return yield* status();
          }).pipe(Effect.tapError(saveFailure));
        }),
      ),
    disable: () =>
      lock(
        Effect.gen(function* () {
          const row = yield* repo.get();
          if (row !== undefined) {
            const disabling = { ...row, desired: "disabling" as const, reason: null };
            yield* repo.save(disabling);
            yield* cleanup(disabling);
          } else yield* stop();
          return yield* status();
        }).pipe(Effect.tapError(saveFailure)),
      ),
    tick: () =>
      lock(
        Effect.gen(function* () {
          let row = yield* repo.get();
          if (row === undefined) {
            yield* stop();
            return;
          }
          if (row.desired === "disabling") {
            if (row.reason === null) yield* cleanup(row);
            return;
          }
          if (row.reason !== null) {
            yield* stop();
            return;
          }
          yield* bound(row);
          if (!configured) row = yield* reconcile(row);
          const now = yield* Clock.currentTimeMillis;
          if (process?.exited()) {
            process = undefined;
            connection = "connecting";
            nextAttempt = now + Math.min(60_000, 1000 * 2 ** Math.min(attempts++, 6));
          }
          if (process === undefined && now >= nextAttempt) yield* launch(row, false);
          if (process !== undefined) {
            const ready = yield* Effect.tryPromise({
              try: () => process?.ready() ?? Promise.resolve(false),
              catch: () =>
                actionRequired(
                  "Connector readiness could not be checked.",
                  "Retry enable locally.",
                ),
            });
            connection = ready && !process.exited() ? "connected" : "connecting";
            if (connection === "connected") attempts = 0;
          }
        }).pipe(
          Effect.tapError(() => stop()),
          Effect.tapError(saveFailure),
          Effect.catchTag("ProvisionError", () => Effect.void),
        ),
      ),
    shutdown: () => lock(stop()),
  };
}

export class RemoteAccess extends Context.Service<RemoteAccess, ReturnType<typeof makeRemote>>()(
  "inbot/RemoteAccess",
) {
  static readonly Live = Layer.effect(
    RemoteAccess,
    Effect.gen(function* () {
      const remote = makeRemote({
        store: yield* Store,
        api: yield* CloudflareApi,
        provisioner: yield* Provisioner,
        binary: makeBinary((yield* Home).path),
      });
      yield* Effect.addFinalizer(() => remote.shutdown().pipe(Effect.orDie));
      return remote;
    }),
  );
}
