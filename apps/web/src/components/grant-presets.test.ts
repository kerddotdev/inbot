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
