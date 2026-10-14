import { readFile, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import { UpdateError } from "./errors.js";
import { parseVersion } from "./version.js";

export const Build = Schema.Struct({ version: Schema.String, target: Schema.String });
export const Installation = Schema.Struct({ shim: Schema.String });
export interface InstalledLayout {
  readonly root: string;
  readonly bundle: string;
  readonly current: string;
  readonly target: string;
  readonly shim: string;
  readonly windows: boolean;
}

export function bundlePaths(bundle: string, windows: boolean) {
  return {
    executable: join(bundle, "runtime", ...(windows ? ["node.exe"] : ["bin", "node"])),
    cli: join(bundle, "application", "dist", "apps", "cli", "src", "main.js"),
  };
}

export function renderShim(bundle: string, windows: boolean): string {
  if (windows) {
    if (/[\r\n%"!]/.test(bundle)) throw new UpdateError("Unsupported installation path.");
    const { executable, cli } = bundlePaths(bundle, true);
    // cmd.exe must parse the exit before Node can replace this file. CALL expands
    // the exit code after Node returns without enabling expansion of ! in arguments.
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nfor /f "tokens=2 delims=:" %%C in ('chcp') do set "INBOT_PREVIOUS_CODEPAGE=%%C"\r\nchcp 65001 >nul\r\n"${executable}" "${cli}" %* & call set "INBOT_EXIT_CODE=%%errorlevel%%" & chcp %INBOT_PREVIOUS_CODEPAGE% >nul & call exit /b %%INBOT_EXIT_CODE%%\r\n`;
  }
  if (/[\r\n"`$\\]/.test(bundle)) throw new UpdateError("Unsupported installation path.");
  return `#!/bin/sh\nexec "${join(bundle, "inbot")}" "$@"\n`;
}

export async function activeBundle(layout: Pick<InstalledLayout, "root" | "shim" | "windows">) {
  const text = await readFile(layout.shim, "utf8");
  const destination = layout.windows
    ? text.match(/^"(.+)\\runtime\\node.exe" ".+" %\* & call set .+\r?$/m)?.[1]
    : text.match(/^exec "(.+)\/inbot" "\$@"$/m)?.[1];
  if (
    !destination ||
    text.replaceAll("\r\n", "\n").trimEnd() !==
      renderShim(destination, layout.windows).replaceAll("\r\n", "\n").trimEnd()
  )
    throw new UpdateError(
      "The launcher is not an Inbot installer shim.",
      "Restore the launcher with the official installer, then retry.",
    );
  const canonical = await realpath(destination);
  if (dirname(canonical) !== join(layout.root, "app"))
    throw new UpdateError("The launcher points outside this installation.");
  parseVersion(basename(canonical));
  return canonical;
}

export async function detectLayout(input: {
  executable: string;
  cli: string;
  platform: string;
  arch: string;
  path?: string;
  userHome: string;
  localAppData?: string;
}): Promise<InstalledLayout> {
  try {
    const windows = input.platform === "win32";
    const executable = await realpath(input.executable);
    const bundle = dirname(dirname(windows ? executable : dirname(executable)));
    const paths = bundlePaths(bundle, windows);
    if (
      executable !== paths.executable ||
      (await realpath(input.cli)) !== paths.cli ||
      basename(dirname(bundle)) !== "app"
    )
      throw new Error("layout");
    const build = Schema.decodeUnknownSync(Build)(
      JSON.parse(await readFile(join(bundle, "BUILD.json"), "utf8")),
    );
    parseVersion(build.version);
    if (
      basename(bundle) !== build.version ||
      build.target !== `${input.platform}-${input.arch}` ||
      !/^(darwin|linux|win32)-(arm64|x64)$/.test(build.target) ||
      !/^[a-f0-9]{64}\s*$/.test(await readFile(join(bundle, ".archive-sha256"), "utf8"))
    )
      throw new Error("metadata");
    const root = dirname(dirname(bundle));
    let recorded: string | undefined;
    try {
      recorded = Schema.decodeUnknownSync(Installation)(
        JSON.parse(await readFile(join(root, "installation.json"), "utf8")),
      ).shim;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const candidates = recorded
      ? [recorded]
      : [
          ...(input.path ?? "")
            .split(delimiter)
            .filter(Boolean)
            .map((entry) => join(entry, windows ? "inbot.cmd" : "inbot")),
          windows
            ? join(
                input.localAppData ?? join(input.userHome, "AppData", "Local"),
                "Programs",
                "inbot",
                "bin",
                "inbot.cmd",
              )
            : join(input.userHome, ".local", "bin", "inbot"),
        ];
    for (const candidate of new Set(candidates)) {
      const shim = resolve(candidate);
      const layout = { root, bundle, current: build.version, target: build.target, shim, windows };
      try {
        await activeBundle(layout);
        return layout;
      } catch {
        /* Try only shims belonging to this installation. */
      }
    }
    throw new Error("shim");
  } catch {
    throw new UpdateError(
      "Updates require a recognized installer-managed release.",
      "Install with install.sh or install.ps1 and run that installed inbot. Put its bin directory on PATH. Source checkouts and manually extracted archives cannot update themselves.",
    );
  }
}
