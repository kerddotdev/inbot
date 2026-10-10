import { encrypt } from "../../../packages/envelope/src/crypto.js";
import { frameInbound, maxMessageSize } from "../../../packages/envelope/src/frame.js";
import { createInboundKey } from "../../../packages/envelope/src/key.js";
import type { InboundPointer } from "../../../packages/envelope/src/pointer.js";

export interface Env {
  readonly INBOUND_BUCKET: Pick<R2Bucket, "put">;
  readonly INBOUND_QUEUE: Pick<Queue<InboundPointer>, "send">;
  readonly RECIPIENT: string;
}

export default {
  async email(
    message: Pick<ForwardableEmailMessage, "from" | "to" | "raw" | "rawSize" | "setReject">,
    env: Env,
  ): Promise<void> {
    if (message.rawSize > maxMessageSize) {
      message.setReject("Message exceeds 25 MiB.");
      return;
    }
    const received_at = new Date().toISOString();
    const key = createInboundKey();
    const framed = frameInbound({ mail_from: message.from, rcpt_to: [message.to] }, message.raw);
    const ciphertext = await encrypt(env.RECIPIENT, framed.stream);
    const size = ciphertext.size(framed.length(message.rawSize));
    const body = ciphertext.pipeThrough(new FixedLengthStream(size));
    try {
      await env.INBOUND_BUCKET.put(key, body);
    } catch (error) {
      await body.cancel().catch(() => {});
      throw error;
    }
    await env.INBOUND_QUEUE.send({ version: 1, key, size, received_at }, { contentType: "json" });
  },
} satisfies ExportedHandler<Env>;
