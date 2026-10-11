import { useState } from "react";
import { Schema } from "effect";
import { Permissions, type Grant, type SendPolicy } from "@inbot/contracts/src/api-keys.js";
import type { IconName } from "../icons";
import { Disclosure, Segmented, type Tone } from "./ui";
import { LoadError } from "../feedback";
import { permissionPreset, presetPermissions, type PermissionPreset } from "./grant-presets";

const presetHint: Record<PermissionPreset, string> = {
  read: "Can read threads. Cannot create drafts or send.",
  "read-draft": "Can read threads and create drafts. Cannot send or manage inboxes.",
  full: "Can read, draft, and send. Sending follows the policy below.",
};

export const policyDisplay: Record<
  SendPolicy,
  { tone: Tone; icon: IconName; label: string; hint: string }
> = {
  direct: {
    tone: "ok",
    icon: "send",
    label: "Direct",
    hint: "Messages are queued for sending without owner approval.",
  },
  approval: {
    tone: "warn",
    icon: "shield-check",
    label: "Approval",
    hint: "Every send waits in Approvals until the owner approves it.",
  },
  read_only: { tone: "mute", icon: "eye", label: "Read-only", hint: "This grant can never send." },
};

const presets: { value: PermissionPreset; label: string }[] = [
  { value: "read", label: "Read only" },
  { value: "read-draft", label: "Read and draft" },
  { value: "full", label: "Full access" },
];

export function GrantFields({
  value,
  onChange,
  inboxIds,
  inboxError,
  loadingInboxes,
  retryInboxes,
  showInboxScope = true,
}: {
  value: Grant;
  onChange: (grant: Grant) => void;
  inboxIds: readonly string[];
  inboxError: unknown;
  loadingInboxes: boolean;
  retryInboxes: () => void;
  showInboxScope?: boolean;
}) {
  const preset = permissionPreset(value.permissions);
  const customized = preset === "custom";
  const [selectedInboxes, setSelectedInboxes] = useState(value.inbox_ids ?? []);
  const allInboxes = value.inbox_ids === undefined;
  const scope = new Set(value.inbox_ids ?? selectedInboxes);
  const permissions = value.permissions;
  const policy = value.send_policy;
  const setPermissions = (permissions: Permissions) => onChange({ ...value, permissions });
  const setPolicy = (send_policy: SendPolicy) => onChange({ ...value, send_policy });
  const setAllInboxes = (all: boolean) => {
    const { inbox_ids: _ids, ...rest } = value;
    if (all) setSelectedInboxes(value.inbox_ids ?? selectedInboxes);
    onChange(all ? rest : { ...rest, inbox_ids: selectedInboxes });
  };
  const choosePreset = (next: PermissionPreset) => {
    onChange({
      ...value,
      permissions: presetPermissions[next],
      send_policy: next === "read" ? "read_only" : policy === "read_only" ? "approval" : policy,
    });
  };
  const toggleInbox = (inbox: string) => {
    if (!scope.delete(inbox)) scope.add(inbox);
    setSelectedInboxes([...scope]);
    onChange({ ...value, inbox_ids: [...scope] });
  };
  return (
    <>
      {showInboxScope ? (
        <fieldset className="mb-4 min-w-0">
          <legend className="mb-[7px] p-0 font-semibold">Inbox scope</legend>
          <label className="mb-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={allInboxes}
              onChange={(event) => setAllInboxes(event.target.checked)}
            />
            All current and future inboxes
          </label>
          {loadingInboxes ? (
            <p role="status">Loading inboxes...</p>
          ) : inboxError ? (
            <LoadError error={inboxError} retry={retryInboxes} />
          ) : inboxIds.length === 0 ? (
            <p className="text-ink2">No inboxes exist yet.</p>
          ) : null}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {inboxIds.map((inbox) => (
              <label key={inbox} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-[15px]"
                  checked={scope.has(inbox)}
                  disabled={allInboxes}
                  onChange={() => toggleInbox(inbox)}
                />
                {inbox}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <fieldset className="mb-4 min-w-0">
        <legend className="mb-[7px] p-0 font-semibold">Permissions</legend>
        <Segmented<PermissionPreset | "custom">
          name="preset"
          options={presets}
          value={preset}
          onChange={(next) => {
            if (next !== "custom") choosePreset(next);
          }}
        />
        <p className="mt-1.5 text-xs text-ink2">
          {customized ? "Only the checked permissions are granted." : presetHint[preset]}
        </p>
        <Disclosure label="Choose individual permissions">
          <div className="mt-2 grid gap-1.5">
            {Object.keys(Permissions.fields).map((permission) => (
              <label key={permission} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={Object.entries(permissions).some(
                    ([key, enabled]) => key === permission && enabled,
                  )}
                  onChange={(event) => {
                    setPermissions(
                      Schema.decodeUnknownSync(Permissions)({
                        ...permissions,
                        [permission]: event.target.checked,
                      }),
                    );
                  }}
                />
                {permission.replaceAll("_", " ")}
              </label>
            ))}
          </div>
        </Disclosure>
      </fieldset>
      <fieldset className="mb-4 min-w-0">
        <legend className="mb-[7px] p-0 font-semibold">Send policy</legend>
        <div className="grid gap-2">
          {(["direct", "approval", "read_only"] satisfies SendPolicy[]).map((value) => (
            <label
              key={value}
              className={`flex items-start gap-2 ${!customized && preset === "read" && value !== "read_only" ? "opacity-50" : ""}`}
            >
              <input
                type="radio"
                name="policy"
                className="mt-0.5 size-[15px]"
                checked={policy === value}
                disabled={!customized && preset === "read" && value !== "read_only"}
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
    </>
  );
}
