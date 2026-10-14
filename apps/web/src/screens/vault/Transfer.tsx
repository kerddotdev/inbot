import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { BITWARDEN_MAX_BYTES, BitwardenImport } from "@inbot/contracts/src/bitwarden.js";
import { api } from "../../api";
import { Dialog } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { Button, Segmented, Status } from "../../components/ui";
import { ErrorNotice } from "../../feedback";
import { inboxesQuery } from "../../queries";
import { exportFilename } from "./format";

const parseImport = Schema.decodeUnknownSync(Schema.fromJsonString(BitwardenImport));

function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ExportCredentials({
  defaultInbox,
  onClose,
}: {
  defaultInbox: string;
  onClose: () => void;
}) {
  const inboxes = useQuery(inboxesQuery);
  const [inbox, setInbox] = useState(defaultInbox);
  const run = useMutation({
    mutationFn: async () => {
      const data = await api.exportCredentials(inbox || undefined);
      download(exportFilename(new Date()), JSON.stringify(data, null, 2));
      return data.items.length;
    },
  });
  return (
    <Dialog title="Export Bitwarden JSON" onClose={onClose} busy={run.isPending}>
      <p className="mb-3">
        <Status tone="warn" icon="alert" small={false}>
          The file contains every password and TOTP seed in plain text.
        </Status>
      </p>
      <p className="mb-4 text-ink2">
        Store it somewhere safe and delete it when you are done. Inbot cannot protect the file once
        it leaves the encrypted database.
      </p>
      <Select
        label="Inbox"
        labelClassName="font-semibold"
        value={inbox}
        onChange={setInbox}
        options={[
          { value: "", label: "All inboxes" },
          ...(inboxes.data ?? []).map((item) => ({ value: item.inbox_id, label: item.inbox_id })),
        ]}
      />
      <ErrorNotice error={run.error} />
      {run.isSuccess ? (
        <p role="status" className="mt-4">
          <Status tone="ok" icon="check-circle">
            Exported {run.data} {run.data === 1 ? "credential" : "credentials"}
          </Status>
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2.5">
        <Button variant="quiet" disabled={run.isPending} onClick={onClose}>
          {run.isSuccess ? "Done" : "Cancel"}
        </Button>
        <Button
          variant="primary"
          icon="download"
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending ? "Exporting..." : "Export file"}
        </Button>
      </div>
    </Dialog>
  );
}

export function ImportCredentials({
  defaultInbox,
  onClose,
}: {
  defaultInbox: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const inboxes = useQuery(inboxesQuery);
  const [inbox, setInbox] = useState(defaultInbox);
  const [duplicates, setDuplicates] = useState<"skip" | "create">("skip");
  const file = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string>();
  const target = inbox || inboxes.data?.[0]?.inbox_id || "";
  const run = useMutation({
    mutationFn: (body: typeof BitwardenImport.Type) =>
      api.importCredentials(target, duplicates, body),
    onSuccess: () => client.invalidateQueries({ queryKey: ["credentials"] }),
  });
  const submit = async () => {
    const selected = file.current?.files?.[0];
    if (!selected || run.isPending || !target) return;
    if (selected.size > BITWARDEN_MAX_BYTES) {
      setFileError("The file is larger than 5 MiB.");
      return;
    }
    try {
      run.mutate(parseImport(await selected.text()));
    } catch {
      setFileError("The file is not valid Bitwarden JSON.");
    }
  };
  const result = run.data;
  return (
    <Dialog title="Import Bitwarden JSON" onClose={onClose} busy={run.isPending}>
      {result ? (
        <div role="status">
          <p className="mb-2">
            <Status tone="ok" icon="check-circle" small={false}>
              Imported {result.imported}, skipped {result.skipped}
            </Status>
          </p>
          {Object.keys(result.reasons).length > 0 ? (
            <ul className="mb-2 text-ink2">
              {Object.entries(result.reasons).map(([reason, count]) => (
                <li key={reason}>
                  {reason.replaceAll("_", " ")}: {count}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-5 flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          aria-busy={run.isPending}
        >
          <fieldset disabled={run.isPending} className="grid gap-4">
            {inboxes.data && inboxes.data.length > 0 ? (
              <Select
                label="Import into inbox"
                labelClassName="font-semibold"
                value={target}
                onChange={setInbox}
                options={inboxes.data.map((item) => ({
                  value: item.inbox_id,
                  label: item.inbox_id,
                }))}
              />
            ) : (
              <p role="status" className="text-ink2">
                {inboxes.isPending ? "Loading inboxes..." : "Create an inbox first."}
              </p>
            )}
            <label>
              <span className="mb-[7px] block font-semibold">Unencrypted Bitwarden JSON file</span>
              <input
                ref={file}
                type="file"
                accept="application/json,.json"
                required
                onChange={() => setFileError(undefined)}
              />
            </label>
            <fieldset className="min-w-0">
              <legend className="mb-[7px] font-semibold">Duplicates</legend>
              <Segmented<"skip" | "create">
                name="import-duplicates"
                value={duplicates}
                onChange={setDuplicates}
                options={[
                  { value: "skip", label: "Skip" },
                  { value: "create", label: "Create anyway" },
                ]}
              />
              <p className="mt-1.5 text-xs text-ink2">
                Duplicates share an inbox, name and username. Only login items are imported.
              </p>
            </fieldset>
            {fileError ? (
              <p role="alert" className="text-bad">
                {fileError}
              </p>
            ) : null}
            <ErrorNotice error={run.error} />
          </fieldset>
          <div className="mt-5 flex justify-end gap-2.5">
            <Button variant="quiet" disabled={run.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={run.isPending || !target}>
              {run.isPending ? "Importing..." : "Import"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
