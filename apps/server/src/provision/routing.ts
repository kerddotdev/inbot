import { createHash } from "node:crypto";
import { Clock, Effect, Schema, type Semaphore } from "effect";
import type { StoreService } from "../store.js";
import type { CloudflareApiService, Rule } from "./cloudflare-api.js";
import { ProvisionError } from "./errors.js";
import { repository } from "./repository.js";

const Job = Schema.Struct({
  inbox_id: Schema.String,
  domain_id: Schema.String,
  rule_id: Schema.NullOr(Schema.String),
  desired: Schema.Int,
  attempts: Schema.Int,
  next_attempt_at: Schema.Int,
});
type Job = typeof Job.Type;
export function routingRuleName(domainId: string, address: string) {
  return `inbot-${domainId}-${createHash("sha256").update(address).digest("hex").slice(0, 16)}`;
}
export function isInboxRule(rule: Rule, address: string, worker: string, name: string) {
  return (
    rule.name === name &&
    rule.enabled &&
    rule.matchers.length === 1 &&
    rule.matchers[0]?.type === "literal" &&
    rule.matchers[0].field === "to" &&
    rule.matchers[0].value === address &&
    rule.actions.length === 1 &&
    rule.actions[0]?.type === "worker" &&
    rule.actions[0].value?.length === 1 &&
    rule.actions[0].value[0] === worker
  );
}
export function makeRoutingSync(
  store: StoreService,
  api: CloudflareApiService,
  gate: Semaphore.Semaphore,
) {
  const repo = repository(store);
  const enqueue = (id: string) =>
    store.use((db) => {
      db.prepare(
        "INSERT INTO inbox_routing_rules (inbox_id, domain_id, desired) SELECT i.inbox_id, d.domain_id, 1 FROM inboxes i JOIN domains d ON d.domain = substr(i.inbox_id, instr(i.inbox_id, '@') + 1) WHERE d.domain_id = ? AND d.phase IN ('ready', 'applying') ON CONFLICT(inbox_id) DO UPDATE SET desired = 1",
      ).run(id);
    });
  const jobs = (id?: string) =>
    store.use((db) =>
      Schema.decodeUnknownSync(Schema.Array(Job))(
        id === undefined
          ? db
              .prepare(
                "SELECT r.* FROM inbox_routing_rules r JOIN domains d USING(domain_id) WHERE d.phase = 'ready'",
              )
              .all()
          : db.prepare("SELECT * FROM inbox_routing_rules WHERE domain_id = ?").all(id),
      ),
    );
  const sync = (job: Job) =>
    Effect.gen(function* () {
      const domain = yield* repo.get(job.domain_id);
      if (domain === undefined) return;
      if ((yield* api.accountId()) !== domain.account_id)
        return yield* new ProvisionError({
          code: "action_required",
          message: "The routing account differs from the provisioned account.",
          fix: "Restore the recorded Cloudflare account configuration.",
        });
      const worker = (yield* repo.resources(job.domain_id)).find(
        (resource) => resource.kind === "worker",
      )?.cloudflare_id;
      if (worker === undefined || worker === null) return;
      const name = routingRuleName(job.domain_id, job.inbox_id);
      const rules = yield* api.rules(domain.zone_id);
      const matching = rules.find((rule) => isInboxRule(rule, job.inbox_id, worker, name));
      if (job.desired === 1) {
        const conflicting = rules.some(
          (rule) =>
            rule.enabled &&
            rule.matchers.some(
              (matcher) =>
                matcher.type === "literal" &&
                matcher.field === "to" &&
                matcher.value === job.inbox_id,
            ) &&
            rule.id !== matching?.id &&
            rule.id !== job.rule_id,
        );
        if (conflicting)
          return yield* new ProvisionError({
            code: "resource_taken",
            message: "An unrelated routing rule already uses this inbox address.",
            fix: "Review the conflicting rule before retrying inbox routing.",
          });
        if (matching === undefined && job.rule_id !== null)
          yield* api.deleteRule(domain.zone_id, job.rule_id);
        const rule =
          matching ??
          (yield* api.createRule(
            { id: domain.zone_id, name: domain.zone_name, account: { id: domain.account_id } },
            job.inbox_id,
            worker,
            name,
          ));
        yield* store.use((db) => {
          db.prepare(
            "UPDATE inbox_routing_rules SET rule_id = ?, attempts = 0, next_attempt_at = 0, last_error = NULL WHERE inbox_id = ?",
          ).run(rule.id, job.inbox_id);
        });
      } else {
        if (matching !== undefined && matching.id !== job.rule_id)
          yield* store.use((db) => {
            db.prepare("UPDATE inbox_routing_rules SET rule_id = ? WHERE inbox_id = ?").run(
              matching.id,
              job.inbox_id,
            );
          });
        if (job.rule_id !== null) yield* api.deleteRule(domain.zone_id, job.rule_id);
        if (matching !== undefined && matching.id !== job.rule_id)
          yield* api.deleteRule(domain.zone_id, matching.id);
        yield* store.use((db) => {
          db.prepare("DELETE FROM inbox_routing_rules WHERE inbox_id = ? AND desired = 0").run(
            job.inbox_id,
          );
        });
      }
    });
  return {
    enqueue,
    run: () =>
      gate.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          let retried = 0;
          let processed = 0;
          for (const job of yield* jobs()) {
            if (
              job.next_attempt_at > now ||
              (job.desired === 1 && job.rule_id !== null && job.attempts === 0)
            )
              continue;
            yield* sync(job).pipe(
              Effect.catchTag("ProvisionError", (error) =>
                Effect.gen(function* () {
                  retried++;
                  yield* store.use((db) => {
                    db.prepare(
                      "UPDATE inbox_routing_rules SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE inbox_id = ?",
                    ).run(
                      now + Math.min(3600_000, 5000 * 2 ** Math.min(job.attempts, 10)),
                      error.code,
                      job.inbox_id,
                    );
                  });
                }),
              ),
            );
            processed++;
          }
          return { processed, retried };
        }),
      ),
    reconcile: () =>
      gate.withPermit(
        Effect.gen(function* () {
          for (const domain of yield* repo.all()) {
            if (domain.phase !== "ready") continue;
            yield* enqueue(domain.domain_id);
            yield* store.use((db) => {
              db.prepare(
                "UPDATE inbox_routing_rules SET desired = 0 WHERE domain_id = ? AND inbox_id NOT IN (SELECT inbox_id FROM inboxes)",
              ).run(domain.domain_id);
            });
            const worker = (yield* repo.resources(domain.domain_id)).find(
              (resource) => resource.kind === "worker",
            )?.cloudflare_id;
            if (worker === undefined || worker === null) continue;
            const rules = yield* api.rules(domain.zone_id);
            for (const job of yield* jobs(domain.domain_id)) {
              if (
                job.desired === 1 &&
                !rules.some((rule) =>
                  isInboxRule(
                    rule,
                    job.inbox_id,
                    worker,
                    routingRuleName(domain.domain_id, job.inbox_id),
                  ),
                )
              ) {
                yield* store.use((db) => {
                  db.prepare(
                    "UPDATE inbox_routing_rules SET attempts = CASE WHEN attempts = 0 THEN 1 ELSE attempts END, next_attempt_at = 0 WHERE inbox_id = ? AND next_attempt_at = 0",
                  ).run(job.inbox_id);
                });
              }
            }
          }
        }),
      ),
    removeAll: (id: string) =>
      Effect.gen(function* () {
        for (const job of yield* jobs(id)) yield* sync({ ...job, desired: 0 });
      }),
  };
}
