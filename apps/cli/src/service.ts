import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { OwnerStatus } from "../../../packages/contracts/src/owner.js";
import { KeysJson } from "../../server/src/key-format.js";
import { CliError } from "./errors.js";
import {
  renderService,
  serviceIdentity,
  servicePlatform,
  type ServiceDefinition,
} from "./service-definition.js";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export type CommandRunner = (program: string, args: readonly string[]) => Promise<CommandResult>;
export interface ServiceRuntime {
  readonly platform: string;
  readonly userHome: string;
  readonly uid: number;
  readonly username: string;
  readonly executable: string;
  readonly cli: string;
  readonly packaged: boolean;
  readonly run: CommandRunner;
  readonly health: (port: number) => Promise<boolean>;
}

const unavailable = (message: string) =>
  new CliError(
    {
      code: "service_unavailable",
      message,
      fix: "Check the user service manager and file permissions, then inspect <home>/logs/service.err.log. Use inbot serve in the foreground to diagnose startup.",
    },
    10,
  );

export const runCommand: CommandRunner = (program, args) =>
  new Promise((done, reject) => {
    const child = spawn(program, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => {
      stdout += value;
    });
    child.stderr.setEncoding("utf8").on("data", (value: string) => {
      stderr += value;
    });
    child.once("error", () => reject(unavailable("Cannot launch the user service manager.")));
    child.once("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });

export async function probeHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v0/owner/status`, {
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    Schema.decodeUnknownSync(OwnerStatus)(await response.json());
    return true;
  } catch {
    return false;
  }
}

export async function localServiceRuntime(): Promise<ServiceRuntime> {
  const cli = fileURLToPath(new URL("./main.js", import.meta.url));
  const info = userInfo();
  const packaged =
    (await readOptional(fileURLToPath(new URL("../../../../../BUILD.json", import.meta.url)))) !==
    undefined;
  const username =
    process.platform === "win32" && process.env.USERDOMAIN
      ? `${process.env.USERDOMAIN}\\${info.username}`
      : info.username;
  return {
    platform: process.platform,
    userHome: homedir(),
    uid: info.uid,
    username,
    executable: process.execPath,
    cli,
    packaged,
    run: runCommand,
    health: probeHealth,
  };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw unavailable("Cannot read the service definition or initialization file.");
  }
}

export function parseServiceState(platform: ServiceDefinition["platform"], result: CommandResult) {
  if (platform === "darwin") {
    if (result.code === 113 || result.code === 3) return { registered: false, running: false };
    if (result.code !== 0) return { registered: null, running: null };
    if (!/^\s*state = \S+\s*$/m.test(result.stdout)) return { registered: null, running: null };
    return {
      registered: true,
      running:
        /^\s*state = running\s*$/m.test(result.stdout) &&
        /^\s*pid = [1-9]\d*\s*$/m.test(result.stdout),
    };
  }
  if (platform === "linux") {
    if (/^LoadState=not-found$/m.test(result.stdout)) return { registered: false, running: false };
    if (
      result.code !== 0 ||
      !/^LoadState=loaded$/m.test(result.stdout) ||
      !/^ActiveState=\S+$/m.test(result.stdout) ||
      !/^SubState=\S+$/m.test(result.stdout)
    )
      return { registered: null, running: null };
    return {
      registered: true,
      running:
        /^ActiveState=active$/m.test(result.stdout) && /^SubState=running$/m.test(result.stdout),
    };
  }
  if (result.code === 0 && result.stdout.trim() === "missing")
    return { registered: false, running: false };
  if (result.code !== 0 || !/^[0-4]$/.test(result.stdout.trim()))
    return { registered: null, running: null };
  return {
    registered: true,
    running: result.stdout.trim() === "0" ? null : result.stdout.trim() === "4",
  };
}

const windowsStateScript = `$ErrorActionPreference = 'Stop'
$name = $args[0]
$task = Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq $name }
if ($null -eq $task) { Write-Output 'missing' } else { Write-Output ([int]$task.State) }
`;

export function makeService(runtime: ServiceRuntime, home: string) {
  const platform = servicePlatform(runtime.platform);
  const input = { platform, home: resolve(home), userHome: runtime.userHome };
  const { name, unitPath } = serviceIdentity(input);
  const scriptPath = `${unitPath}.ps1`;
  const target = `gui/${runtime.uid}/${name}`;
  const inspect = async () => {
    const result =
      platform === "darwin"
        ? await runtime.run("launchctl", ["print", target])
        : platform === "linux"
          ? await runtime.run("systemctl", [
              "--user",
              "show",
              name,
              "--property=LoadState,ActiveState,SubState",
            ])
          : await runtime.run("powershell.exe", [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              scriptPath,
              name,
            ]);
    return parseServiceState(platform, result);
  };
  const command = async (program: string, args: string[]) => {
    if ((await runtime.run(program, args)).code !== 0)
      throw unavailable("The user service manager rejected the operation.");
  };
  const stop = async () => {
    const state = await inspect();
    if (state.registered === null)
      throw unavailable("Cannot observe the registered service. No definition was removed.");
    if (!state.registered) return;
    if (platform === "darwin") await command("launchctl", ["bootout", target]);
    else if (platform === "linux") await command("systemctl", ["--user", "disable", "--now", name]);
    else {
      if (state.running) await command("schtasks.exe", ["/End", "/TN", name]);
      await command("schtasks.exe", ["/Delete", "/TN", name, "/F"]);
    }
  };
  const status = async () => {
    const definition = await readOptional(unitPath);
    const state =
      platform === "win32" && definition === undefined
        ? { registered: false, running: false }
        : await inspect();
    const match = definition?.match(/InbotPort: (\d+)/)?.[1];
    const parsedPort = match === undefined ? null : Number(match);
    const port = parsedPort !== null && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : null;
    return {
      name,
      home: input.home,
      installed: definition !== undefined || state.registered === true,
      registered: state.registered,
      running: state.running,
      state: state.running === null ? "unknown" : state.running ? "running" : "stopped",
      unit_path: unitPath,
      port,
      http_healthy: port === null ? false : await runtime.health(port),
      stdout_log: join(input.home, "logs", "service.log"),
      stderr_log: join(input.home, "logs", "service.err.log"),
    };
  };
  return {
    status,
    async install(port: number) {
      const definition = renderService({
        ...input,
        port,
        executable: runtime.executable,
        cli: runtime.cli,
        username: runtime.username,
      });
      if (!runtime.packaged)
        throw new CliError(
          {
            code: "not_supported",
            message: "Service installation requires the installed release package.",
            fix: "Install a release archive, then run its inbot service install command.",
          },
          9,
        );
      const json = await readOptional(join(input.home, "keys.json"));
      let keychain = false;
      try {
        keychain =
          json !== undefined && Schema.decodeUnknownSync(KeysJson)(json).keychain !== undefined;
      } catch {
        /* Report initialization recovery without exposing key material. */
      }
      if (!keychain)
        throw new CliError(
          {
            code: "action_required",
            message: "The service requires an initialized home with keychain unlock enabled.",
            fix: "Run inbot serve --init --port 8025 with the same --home, complete owner setup, and stop it before installing the service.",
          },
          6,
        );
      await mkdir(join(input.home, "logs"), { recursive: true, mode: 0o700 });
      await chmod(join(input.home, "logs"), 0o700);
      for (const file of ["service.log", "service.err.log"]) {
        const handle = await open(join(input.home, "logs", file), "a", 0o600);
        await handle.close();
        await chmod(join(input.home, "logs", file), 0o600);
      }
      await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
      if (platform === "win32") await writeDefinition(scriptPath, windowsStateScript);
      await stop();
      await writeDefinition(unitPath, definition);
      if (platform === "darwin") {
        await command("launchctl", ["enable", target]);
        await command("launchctl", ["bootstrap", `gui/${runtime.uid}`, unitPath]);
      } else if (platform === "linux") {
        await command("systemctl", ["--user", "daemon-reload"]);
        await command("systemctl", ["--user", "enable", "--now", name]);
      } else {
        await command("schtasks.exe", ["/Create", "/TN", name, "/XML", unitPath, "/F"]);
        await command("schtasks.exe", ["/Run", "/TN", name]);
      }
      return status();
    },
    async uninstall() {
      const definition = await readOptional(unitPath);
      if (platform !== "win32" || definition !== undefined) await stop();
      await rm(unitPath, { force: true });
      if (platform === "win32") await rm(scriptPath, { force: true });
      if (platform === "linux") await command("systemctl", ["--user", "daemon-reload"]);
      return status();
    },
  };
}

async function writeDefinition(path: string, content: string) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
