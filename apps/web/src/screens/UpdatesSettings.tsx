import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateStatus } from "@inbot/contracts/src/updates.js";
import { api } from "../api";
import { ErrorNotice, LoadError } from "../feedback";
import { updatesQuery } from "../queries";
import { Status } from "../components/ui";

const results: Record<UpdateStatus["last_result"], string> = {
  never_checked: "Not checked yet",
  checking: "Checking for updates",
  up_to_date: "Up to date",
  available: "Update available",
  ready: "Update verified - stopping safely",
  restarting: "Restart requested",
  updated: "Updated",
  failed: "Update failed",
};

export function UpdatesSettings() {
  const client = useQueryClient();
  const query = useQuery(updatesQuery);
  const change = useMutation({
    mutationFn: (enabled: boolean) => api.configureUpdates(enabled),
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey: updatesQuery.queryKey });
      client.setQueryData(updatesQuery.queryKey, data);
    },
  });
  const data = query.data;
  return (
    <section aria-labelledby="updates-title" className="mt-9 max-w-xl border-t border-line pt-6">
      <h2 id="updates-title" className="font-semibold">
        Updates
      </h2>
      {query.isPending ? (
        <p role="status" className="mt-4 text-ink2">
          Loading update settings...
        </p>
      ) : query.error ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : data ? (
        <>
          <label className="mt-4 flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              role="switch"
              checked={data.enabled}
              disabled={change.isPending}
              onChange={(event) => change.mutate(event.target.checked)}
              aria-describedby="updates-help"
              className="h-4 w-4 accent-accent focus-visible:outline-2 focus-visible:outline-offset-4"
            />
            <span>Automatic updates</span>
          </label>
          <p id="updates-help" className="mt-2 text-sm text-ink2">
            {data.eligible
              ? "The background service checks within four hours and restarts after stopping mail processing safely."
              : "This preference applies when Inbot runs as an installed background service. Automatic updates are inactive in this session."}
          </p>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-ink2">Current version</dt>
            <dd>{data.current}</dd>
            <dt className="text-ink2">Latest known release</dt>
            <dd>{data.latest ?? "Not checked"}</dd>
            <dt className="text-ink2">Last check</dt>
            <dd>
              {data.last_check ? (
                <time dateTime={data.last_check}>{new Date(data.last_check).toLocaleString()}</time>
              ) : (
                "Never"
              )}
            </dd>
          </dl>
          <div role="status" className="mt-4">
            <Status
              tone={data.last_result === "failed" ? "bad" : "mute"}
              icon={data.last_result === "failed" ? "alert" : "refresh"}
            >
              {results[data.last_result]}
            </Status>
          </div>
          {data.error ? (
            <p role="alert" className="mt-2 text-sm text-ink2">
              {data.error.message} {data.error.fix}
            </p>
          ) : null}
          <ErrorNotice error={change.error} />
        </>
      ) : null}
    </section>
  );
}
