import type { Grant, Permissions } from "@inbot/contracts/src/api-keys.js";

export type PermissionPreset = "read" | "read-draft" | "full";
const readPermissions = {
  inbox_read: true,
  message_read: true,
  draft_read: true,
  credential_read: true,
};
const draftPermissions = {
  ...readPermissions,
  draft_create: true,
  draft_update: true,
  draft_delete: true,
};
export const presetPermissions = {
  read: readPermissions,
  "read-draft": draftPermissions,
  full: {
    ...draftPermissions,
    message_update: true,
    message_reply: true,
    message_send: true,
    draft_send: true,
    credential_create: true,
    credential_update: true,
    credential_delete: true,
    credential_totp: true,
  },
} satisfies Record<PermissionPreset, Permissions>;

export const defaultGrant: Grant = {
  inbox_ids: [],
  permissions: presetPermissions.full,
  send_policy: "approval",
};

export function permissionPreset(permissions: Permissions): PermissionPreset | "custom" {
  const enabled = new Set(
    Object.entries(permissions)
      .filter(([, allowed]) => allowed)
      .map(([permission]) => permission),
  );
  return (
    (["read", "read-draft", "full"] satisfies PermissionPreset[]).find((preset) => {
      const expected = Object.entries(presetPermissions[preset]).filter(([, allowed]) => allowed);
      return (
        enabled.size === expected.length &&
        expected.every(([permission]) => enabled.has(permission))
      );
    }) ?? "custom"
  );
}
