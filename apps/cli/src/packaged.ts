import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function packagedArguments(args: readonly string[], entry: string): string[] {
  const webRoot = fileURLToPath(new URL("../../../../web/", entry));
  if (!existsSync(new URL("../../../../../BUILD.json", entry))) return [...args];
  const result = [...args];
  if (!args.some((arg) => arg === "--flavor" || arg.startsWith("--flavor=")))
    result.push("--flavor", "production");
  if (
    args[0] === "serve" &&
    !args.some((arg) => arg === "--web-root" || arg.startsWith("--web-root="))
  )
    result.push("--web-root", webRoot);
  return result;
}
