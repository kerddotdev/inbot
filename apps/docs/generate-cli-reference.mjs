// Builds docs/reference/cli.md from the compiled CLI's own help, so the
// reference cannot drift from the commands that exist. Run `pnpm build` first.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const cli = fileURLToPath(new URL("../../dist/apps/cli/src/main.js", import.meta.url));
const directory = new URL("docs/reference/", import.meta.url);

const help = async (...args) => {
  const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args, "--help"]);
  return stdout.trimEnd();
};

const overview = await help();
const commands = [
  "version",
  ...overview
    .split("\n")
    .filter((line) => line.startsWith("  "))
    .map((line) => {
      const [group, action] = line.trim().split(/\s+/);
      return /^[a-z][a-z-]*$/.test(action) ? `${group} ${action}` : group;
    }),
];

// Groups follow a reader's path through the CLI; groups added later still appear, at the end.
const order = [
  "version",
  "serve",
  "open",
  "inboxes",
  "threads",
  "messages",
  "drafts",
  "api-keys",
  "lists",
  "webhooks",
  "events",
  "oauth",
  "remote",
];
const groups = new Map(order.map((group) => [group, []]));
for (const command of commands) {
  const group = command.split(" ")[0];
  groups.set(group, [...(groups.get(group) ?? []), command]);
}

const globalFlags = new Set(["--home <value>", "--flavor <value>", "--json", "--help"]);
const withoutGlobalFlags = (text) =>
  text
    .split("\n")
    .filter((line) => !globalFlags.has(line.trim()))
    .join("\n");

const sections = [];
for (const [group, members] of groups) {
  if (members.length === 0) continue;
  const blocks = await Promise.all(
    members.map(async (command) => {
      const text =
        command === "version"
          ? "Usage: inbot --version | inbot version\n\nPrint the package version without connecting to a server."
          : withoutGlobalFlags(await help(...command.split(" ")));
      return ["### `inbot " + command + "`", "```text\n" + text + "\n```"].join("\n\n");
    }),
  );
  sections.push([`## ${group}`, ...blocks].join("\n\n"));
}

const intro = [
  "This page is generated from `inbot --help` when the documentation is built.",
  "For connection setup, output modes and idempotency, see [Connect an agent](/agents/connect#cli);",
  "for exit codes, see [Errors and exit codes](/reference/errors).",
  "Resource commands accept the global options `--home`, `--flavor`, `--json` and `--help`.",
].join(" ");

await mkdir(directory, { recursive: true });
await writeFile(
  new URL("cli.md", directory),
  [
    "---",
    "title: CLI reference",
    "description: Every inbot command, argument and option, generated from the CLI's own help output each time the documentation is built.",
    "---",
    "",
    intro,
    "",
    "```text\n" + overview + "\n```",
    "",
    sections.join("\n\n"),
    "",
  ].join("\n"),
);
