import { createHash } from "node:crypto";

export function quarantineId(kind: "buffer_object" | "queue_message", ...parts: string[]) {
  return createHash("sha256")
    .update(JSON.stringify([kind, ...parts]))
    .digest("base64url");
}
