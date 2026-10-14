import { parseVersion } from "../../server/src/update/version.js";
import { OwnerApiGroup } from "../../../packages/contracts/src/api/owner.js";
import { connection, request } from "./client.js";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveHome } from "../../server/src/home.js";
import { UpdateError } from "../../server/src/update/errors.js";
import { bundlePaths, detectLayout } from "../../server/src/update/layout.js";
import { prepareUpdate } from "../../server/src/update/install.js";
import { checkRelease } from "../../server/src/update/release.js";
import type { CliIO } from "./cli.js";
import { CliError, usage } from "./errors.js";
import { humanOutput } from "./output.js";
import { localServiceRuntime, makeService } from "./service.js";

export const updateHelp =
  "  update               Check for or install a verified release (local owner only).\n";

export async function runUpdateCommand(args: readonly string[], io: CliIO) {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      home: { type: "string" },
      flavor: { type: "string" },
      json: { type: "boolean" },
      auto: { type: "string" },
      check: { type: "boolean" },
      version: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    io.stdout(
      "Usage: inbot update [--check] [--version <x.y.z>] [--auto on|off] [--json] [--home <directory>] [--flavor development|production]\n\nLocal owner only. Checks GitHub releases, verifies SHA-256 and the macOS signing Team ID, then atomically switches the installed launcher. Retains previous versions; downgrades are refused. An installed service is restarted using its existing port. --check only reports current, latest, and update_available. Prereleases require --version. --auto changes the persisted preference through the local owner service; it cannot be combined with --check or --version.\n",
    );
    return;
  }
  if (positionals.length) usage("Update does not accept positional arguments.");
  if (io.env.INBOT_API_KEY !== undefined || io.env.INBOT_URL !== undefined)
    throw new CliError(
      {
        code: "missing_permission",
        message: "Updates are a local owner operation.",
        fix: "Unset INBOT_URL and INBOT_API_KEY and run locally as the owner.",
      },
      4,
    );
  const flavor = values.flavor ?? "development";
  if (flavor !== "production" && flavor !== "development")
    usage("--flavor must be production or development.");
  if (values.auto !== undefined) {
    if ((values.auto !== "on" && values.auto !== "off") || values.check || values.version)
      usage("Use --auto on|off by itself.");
    const auth = await connection(
      { flavor, ...(values.home === undefined ? {} : { home: values.home }) },
      io.env,
    );
    const result = await request(
      auth,
      OwnerApiGroup.endpoints.owner_setUpdates,
      "/v0/owner/updates",
      { enabled: values.auto === "on" },
    );
    io.stdout(values.json ? `${JSON.stringify(result)}\n` : humanOutput(result));
    return;
  }
  if (values.version !== undefined) {
    try {
      parseVersion(values.version);
    } catch {
      usage("--version requires a semantic version such as 0.2.0 or 0.2.0-beta.1.");
    }
  }
  try {
    const runtime = io.serviceRuntime ?? (await localServiceRuntime());
    const layout = await detectLayout({
      ...runtime,
      arch: process.arch,
      ...(io.env.PATH === undefined ? {} : { path: io.env.PATH }),
    });
    const checked = await checkRelease(layout.current, values.version, io.updateFetch);
    const print = (result: unknown) =>
      io.stdout(values.json ? `${JSON.stringify(result)}\n` : humanOutput(result));
    if (values.check || !checked.update_available) {
      if (values.version && !values.check && checked.latest !== checked.current)
        throw new UpdateError("Updates never downgrade.");
      print(checked);
      return;
    }
    const home = resolveHome({
      flavor,
      ...(values.home === undefined ? {} : { flag: values.home }),
      env:
        io.env.INBOT_HOME ??
        join(runtime.userHome, flavor === "production" ? ".inbot" : ".inbot-dev"),
    });
    const service = makeService(runtime, home);
    const state = await service.status();
    if (state.registered === null || (state.installed && state.port === null))
      throw new UpdateError(
        "Cannot determine how to restart the installed service.",
        "Run inbot service status with the same --home and repair the service before updating.",
      );
    const prepared = await prepareUpdate(layout, checked.latest, runtime.run, io.updateFetch);
    try {
      await prepared.activate();
      const restarted =
        state.installed && state.port !== null
          ? await makeService(
              { ...runtime, ...bundlePaths(prepared.destination, layout.windows) },
              home,
            ).install(state.port)
          : undefined;
      print({
        ...checked,
        installed: checked.latest,
        previous: checked.current,
        ...(restarted === undefined ? {} : { service: restarted }),
      });
    } catch (error) {
      throw new UpdateError(
        `The update did not complete: ${error instanceof Error ? error.message : "unknown error"}`,
        "The launcher may already select the new version. Run inbot --version and inbot service status with the same --home; retry inbot service install if restart failed. Do not roll back after a database migration.",
      );
    } finally {
      await prepared.close();
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    const failure =
      error instanceof UpdateError ? error : new UpdateError("The release update failed.");
    throw new CliError({ code: failure.code, message: failure.message, fix: failure.fix }, 6);
  }
}
