import { expect, test } from "vitest";
import { permissionPreset, presetPermissions } from "./grant-presets";

test("matches existing grants by enabled permissions without hiding customized access", () => {
  expect(permissionPreset({ ...presetPermissions.full, inbox_delete: false })).toBe("full");
  expect(permissionPreset(presetPermissions.read)).toBe("read");
  expect(permissionPreset(presetPermissions["read-draft"])).toBe("read-draft");
  expect(permissionPreset({ ...presetPermissions.full, message_send: false })).toBe("custom");
  expect(permissionPreset({ ...presetPermissions.full, inbox_delete: true })).toBe("custom");
  expect(permissionPreset({})).toBe("custom");
});

test("read presets grant only vault metadata while full grants every vault permission", () => {
  for (const preset of ["read", "read-draft"] as const) {
    const permissions = presetPermissions[preset];
    expect(permissions.credential_read).toBe(true);
    expect(Object.entries(permissions).filter(([key]) => key.startsWith("credential_"))).toEqual([
      ["credential_read", true],
    ]);
  }
  expect(presetPermissions.full).toMatchObject({
    credential_read: true,
    credential_create: true,
    credential_update: true,
    credential_delete: true,
    credential_totp: true,
    credential_fill: true,
    credential_run: true,
  });
  expect(permissionPreset({ ...presetPermissions.read, credential_totp: true })).toBe("custom");
});
