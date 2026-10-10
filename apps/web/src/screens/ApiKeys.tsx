import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  inboxIds,
  type ApiKey,
  type InboxId,
  type PermissionPreset,
  type SendPolicy,
} from "../mock";
import type { IconName } from "../icons";
import { Button, inputClasses, Page, Segmented, Status, type Tone } from "../components/ui";

const presetLabel: Record<PermissionPreset, string> = {
  read: "Read",
  "read-draft": "Read, draft",
  full: "Read, draft, send",
};

const presetHint: Record<PermissionPreset, string> = {
  read: "Can read threads. Cannot create drafts or send.",
  "read-draft": "Can read threads and create drafts. Cannot send or manage inboxes.",
  full: "Can read, draft, and send. Sending follows the policy below.",
};

const policyDisplay: Record<
  SendPolicy,
  { tone: Tone; icon: IconName; label: string; hint: string }
> = {
  direct: { tone: "ok", icon: "send", label: "Direct", hint: "Messages are sent immediately." },
  approval: {
    tone: "warn",
    icon: "shield-check",
    label: "Approval",
    hint: "Drafts wait in Approvals until you accept them.",
  },
  "read-only": { tone: "mute", icon: "eye", label: "Read-only", hint: "The key can never send." },
};

const presets: { value: PermissionPreset; label: string }[] = [
  { value: "read", label: "Read only" },
  { value: "read-draft", label: "Read and draft" },
  { value: "full", label: "Full access" },
];

export function ApiKeys({ keys }: { keys: ApiKey[] }) {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Page
        barTitle="API keys"
        barAction={
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            Create key
          </Button>
        }
        title="Keys for agents"
        lead="Each key is limited to the inboxes and actions you choose. Secrets are shown once, at creation."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr>
                {["Name", "Inbox", "Permissions", "Send policy", "Last used"].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="border-b border-line py-2 pr-3 text-left text-xs font-semibold text-ink2"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const policy = policyDisplay[key.sendPolicy];
                return (
                  <tr key={key.id}>
                    <td className="border-b border-line py-[13px] pr-3">
                      <b className="font-semibold">{key.name}</b>
                      <br />
                      <small className="font-mono text-xs text-ink2">ik_...{key.suffix}</small>
                    </td>
                    <td className="border-b border-line py-[13px] pr-3">
                      {key.inboxes.length === inboxIds.length
                        ? `All inboxes (${key.inboxes.length})`
                        : key.inboxes.join(", ")}
                    </td>
                    <td className="border-b border-line py-[13px] pr-3">
                      {presetLabel[key.preset]}
                    </td>
                    <td className="border-b border-line py-[13px] pr-3">
                      <Status tone={policy.tone} icon={policy.icon} small={false}>
                        {policy.label}
                      </Status>
                    </td>
                    <td className="border-b border-line py-[13px] pr-3 text-ink2">
                      {key.lastUsed}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Page>
      {creating ? <CreateKeyDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function CreateKeyDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameId = useId();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ReadonlySet<InboxId>>(new Set());
  const [preset, setPreset] = useState<PermissionPreset>("read-draft");
  const [policy, setPolicy] = useState<SendPolicy>("approval");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const choosePreset = (next: PermissionPreset) => {
    setPreset(next);
    if (next === "read") setPolicy("read-only");
    else if (policy === "read-only") setPolicy("approval");
  };

  const toggleInbox = (inbox: InboxId) => {
    const next = new Set(scope);
    if (!next.delete(inbox)) next.add(inbox);
    setScope(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={`${nameId}-title`}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      className="mx-auto mt-11 max-h-[calc(100dvh-88px)] w-[500px] max-w-[calc(100vw-32px)] animate-rise overflow-y-auto rounded-[14px] bg-win p-0 text-ink shadow-sheet backdrop:animate-fade backdrop:bg-scrim"
    >
      <form onSubmit={submit} className="px-7 py-[26px]">
        <h2
          id={`${nameId}-title`}
          className="mb-[18px] text-[22px] font-semibold tracking-[-0.015em]"
        >
          Create API key
        </h2>
        <div className="mb-4">
          <label htmlFor={nameId} className="mb-[7px] block font-semibold">
            Name
          </label>
          <input
            id={nameId}
            className={inputClasses}
            value={name}
            placeholder="research-weekly"
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <fieldset className="mb-4 min-w-0">
          <legend className="mb-[7px] p-0 font-semibold">Inbox scope</legend>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {inboxIds.map((inbox) => (
              <label key={inbox} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-[15px]"
                  checked={scope.has(inbox)}
                  onChange={() => toggleInbox(inbox)}
                />
                {inbox}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="mb-4 min-w-0">
          <legend className="mb-[7px] p-0 font-semibold">Permissions</legend>
          <Segmented name="preset" options={presets} value={preset} onChange={choosePreset} />
          <p className="mt-1.5 text-xs text-ink2">{presetHint[preset]}</p>
        </fieldset>
        <fieldset className="mb-4 min-w-0">
          <legend className="mb-[7px] p-0 font-semibold">Send policy</legend>
          <div className="grid gap-2">
            {(Object.keys(policyDisplay) as SendPolicy[]).map((value) => (
              <label
                key={value}
                className={`flex items-start gap-2 ${preset === "read" && value !== "read-only" ? "opacity-50" : ""}`}
              >
                <input
                  type="radio"
                  name="policy"
                  className="mt-0.5 size-[15px]"
                  checked={policy === value}
                  disabled={preset === "read" && value !== "read-only"}
                  onChange={() => setPolicy(value)}
                />
                <span>
                  {policyDisplay[value].label}
                  <small className="block text-ink2">{policyDisplay[value].hint}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-1.5 flex items-center justify-end gap-2.5">
          <Button variant="quiet" onClick={() => dialogRef.current?.close()}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={name.trim() === "" || scope.size === 0}>
            Create key
          </Button>
        </div>
      </form>
    </dialog>
  );
}
