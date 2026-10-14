import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test } from "vitest";
import { UpdateStatus } from "../../../../packages/contracts/src/updates.js";
import { OwnerSessionResponse } from "../../../../packages/contracts/src/owner.js";
import { runCli } from "../../../cli/src/cli.js";
import { Connection } from "../auth/owner.js";
import { fixture } from "./test-fixture.js";
import { tunnelRoute } from "./tunnel-policy.js";

const path = "/v0/owner/updates";

test("update preferences require a local owner, reject agents and require session CSRF", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbot-update-http-"));
  const api = await fixture(home);
  try {
    const key = await api.run(
      api.keys.create({ permissions: { inbox_read: true }, send_policy: "direct" }),
    );
    for (const method of ["GET", "PUT"]) {
      const options = { method, ...(method === "PUT" ? { body: { enabled: false } } : {}) };
      expect((await api.request(path, { ...options, token: key.api_key })).status).toBe(403);
      expect((await api.request(path, { ...options, token: null })).status).toBe(401);
    }
    expect(tunnelRoute(path)).toBe("blocked");
    const status = Schema.decodeUnknownSync(UpdateStatus)(await (await api.request(path)).json());
    expect(status).toMatchObject({ enabled: true, eligible: false, last_check: null });
    const login = await api.request("/v0/owner/setup", {
      token: null,
      method: "POST",
      body: { password: "synthetic owner password", code: api.setupCode },
    });
    const session = Schema.decodeUnknownSync(OwnerSessionResponse)(await login.json());
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(
      (
        await api.request(path, {
          token: null,
          method: "PUT",
          body: { enabled: false },
          headers: { cookie },
        })
      ).status,
    ).toBe(403);
    const changed = await api.request(path, {
      token: null,
      method: "PUT",
      body: { enabled: false },
      headers: { cookie, "x-inbot-csrf": session.csrf_token },
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ enabled: false });
    const restarted = await api.restart();
    try {
      const connection = Schema.decodeUnknownSync(Schema.fromJsonString(Connection))(
        await readFile(join(home, "connection.json"), "utf8"),
      );
      const response = await fetch(`${restarted.url}${path}`, {
        headers: { authorization: `Bearer ${connection.token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ enabled: false });
      let output = "";
      expect(
        await runCli(["update", "--auto", "on", "--home", home, "--json"], {
          env: {},
          stdout: (value) => {
            output += value;
          },
          stderr: () => {},
        }),
      ).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ enabled: true, eligible: false });
    } finally {
      await restarted.close();
    }
  } finally {
    await api.close();
    await rm(home, { recursive: true, force: true });
  }
});
