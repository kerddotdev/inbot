import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveHome } from "../../server/src/home.js";
import type { CliIO } from "./cli.js";
import { CliError, usage } from "./errors.js";
import { humanOutput } from "./output.js";
import { localServiceRuntime, makeService } from "./service.js";

export const serviceHelp = `  service install      Install and restart the per-user background service.
  service uninstall    Stop and remove the service, retaining mail and keys.
  service status       Inspect the service manager and local HTTP health.
`;

export async function runServiceCommand(args: readonly string[], io: CliIO): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      home: { type: "string" },
      flavor: { type: "string" },
      port: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const action = positionals[0];
  if (
    positionals.length > 1 ||
    (action !== undefined && action !== "install" && action !== "uninstall" && action !== "status")
  )
    usage("Expected service install, uninstall, or status.");
  if (values.help || action === undefined) {
    io.stdout(
      action === undefined
        ? `Usage: inbot service <command> [options]\n\n${serviceHelp}\nLocal owner commands; no REST or MCP credentials are used.\n`
        : `Usage: inbot service ${action} [--home <directory>] [--flavor development|production] [--json]${action === "install" ? " [--port <1-65535>]" : ""}\n\n${action === "install" ? "Requires an installed release and an initialized keychain home. Port defaults to 8025. Complete setup with foreground serve --init and stop it first. Reinstall restarts the service. Setup codes, if still needed, go to <home>/logs/service.log; inbot open --browser provides a login link.\n" : action === "uninstall" ? "Stops and removes only the user service definition. Mail, logs, and keychain entries are retained.\n" : "Reports observed manager state, the installed port, and HTTP health. Unknown manager state is never reported as running.\n"}`,
    );
    return;
  }
  if (io.env.INBOT_API_KEY !== undefined || io.env.INBOT_URL !== undefined)
    throw new CliError(
      {
        code: "missing_permission",
        message: "Service management is a local owner operation.",
        fix: "Unset INBOT_URL and INBOT_API_KEY and run locally as the owner.",
      },
      4,
    );
  if (values.port !== undefined && action !== "install")
    usage("--port is supported only by service install; status reads the installed port.");
  const flavor = values.flavor ?? "development";
  if (flavor !== "production" && flavor !== "development")
    usage("--flavor must be development or production.");
  const portText = values.port ?? "8025";
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535)
    usage("--port must be an integer from 1 to 65535.");
  const runtime = io.serviceRuntime ?? (await localServiceRuntime());
  const home = resolveHome({
    flavor,
    ...(values.home === undefined ? {} : { flag: values.home }),
    env:
      io.env.INBOT_HOME ??
      join(runtime.userHome, flavor === "production" ? ".inbot" : ".inbot-dev"),
  });
  const service = makeService(runtime, home);
  const result =
    action === "install"
      ? await service.install(Number(portText))
      : action === "uninstall"
        ? await service.uninstall()
        : await service.status();
  io.stdout(values.json ? `${JSON.stringify(result)}\n` : humanOutput(result));
  if (action === "install")
    io.stderr(
      `Service start requested. Setup codes, if needed, are in ${result.stdout_log}. Use inbot open --browser with the same home after HTTP health answers.\n`,
    );
}
