import { DeliveryStatus } from "../../../../packages/contracts/src/outbound.js";

export const systemMessageLabels = new Set<string>([
  "received",
  "queued",
  "sent",
  "send_unknown",
  ...DeliveryStatus.literals,
]);
