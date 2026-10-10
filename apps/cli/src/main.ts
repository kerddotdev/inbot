#!/usr/bin/env node

import { packagedArguments } from "./packaged.js";

process.argv = [
  ...process.argv.slice(0, 2),
  ...packagedArguments(process.argv.slice(2), import.meta.url),
];

if (process.argv[2] === "serve") {
  await import("../../server/src/main.js");
} else {
  const { runCli } = await import("./cli.js");
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  });
}
