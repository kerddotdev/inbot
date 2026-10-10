export function createInboundKey(): string {
  const random = crypto.randomUUID();
  const timestamp = Date.now().toString(16).padStart(12, "0");
  return `inbound/${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(15)}.age`;
}
