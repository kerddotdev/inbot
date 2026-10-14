import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import {
  UpdatePreference,
  UpdateRecord,
  type UpdateStatus,
} from "../../../../packages/contracts/src/updates.js";
import { atomicWrite } from "./files.js";

const empty: UpdateRecord = {
  last_check: null,
  latest: null,
  last_result: "never_checked",
  error: null,
};
async function readOptional(file: string) {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function updateState(home: string, current: string, eligible: boolean) {
  const preferencePath = join(home, "updates.json");
  const recordPath = join(home, "update-status.json");
  const preference = async () => {
    const value = await readOptional(preferencePath);
    return value === undefined
      ? { enabled: true }
      : Schema.decodeUnknownSync(UpdatePreference)(value);
  };
  return {
    async read(): Promise<UpdateStatus> {
      const value = await readOptional(recordPath);
      const record = value === undefined ? empty : Schema.decodeUnknownSync(UpdateRecord)(value);
      return { ...(await preference()), ...record, current, eligible };
    },
    async configure(input: UpdatePreference) {
      const decoded = Schema.decodeUnknownSync(UpdatePreference)(input);
      await mkdir(home, { recursive: true, mode: 0o700 });
      await atomicWrite(preferencePath, `${JSON.stringify(decoded)}\n`);
      return this.read();
    },
    async record(input: UpdateRecord) {
      await atomicWrite(
        recordPath,
        `${JSON.stringify(Schema.decodeUnknownSync(UpdateRecord)(input))}\n`,
      );
    },
  };
}
export type UpdateState = ReturnType<typeof updateState>;
