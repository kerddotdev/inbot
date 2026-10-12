import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Message } from "@inbot/contracts/src/messages.js";
import { api, ApiError } from "../api";
import { ErrorNotice } from "../feedback";
import { inlineImageAttachments, sanitizeMailHtml } from "../mail-html";
import { hasQuotedText } from "../mail-text";
import { Button, Disclosure } from "./ui";

function imageData(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const failed = () =>
      reject(
        new ApiError(
          "service_unavailable",
          "An inline image could not be read.",
          "Download the attachment instead.",
        ),
      );
    reader.onerror = failed;
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : failed());
    reader.readAsDataURL(blob);
  });
}

function HtmlBody({ message, html }: { message: Message; html: string }) {
  const client = useQueryClient();
  const consentKey = ["mail-remote-images", message.inbox_id, message.message_id];
  const consent = useQuery({
    queryKey: consentKey,
    queryFn: () => false,
    initialData: false,
    enabled: false,
    gcTime: Infinity,
  });
  const sanitized = useMemo(
    () =>
      sanitizeMailHtml(html, {
        attachments: message.attachments ?? [],
        loadRemoteImages: consent.data,
      }),
    [html, message.attachments, consent.data],
  );
  const inline = useQuery({
    queryKey: [
      "mail-inline-images",
      message.inbox_id,
      message.message_id,
      sanitized.inlineAttachmentIds,
    ],
    enabled: sanitized.inlineAttachmentIds.length > 0,
    queryFn: async () => {
      const attachments = inlineImageAttachments(message.attachments ?? []).filter((attachment) =>
        sanitized.inlineAttachmentIds.includes(attachment.attachment_id),
      );
      return Promise.all(
        attachments.map(async (attachment) => {
          const blob = await api.messageAttachment(message, attachment.attachment_id);
          if (
            blob.size > 10 * 1024 * 1024 ||
            blob.type.toLowerCase() !== attachment.content_type?.toLowerCase()
          )
            throw new ApiError(
              "validation_error",
              "An inline image cannot be displayed safely.",
              "Download the attachment instead.",
            );
          return [attachment.attachment_id, await imageData(blob)] as const;
        }),
      );
    },
  });
  const rendered = useMemo(
    () =>
      inline.data
        ? sanitizeMailHtml(html, {
            attachments: message.attachments ?? [],
            inlineImages: new Map(inline.data),
            loadRemoteImages: consent.data,
          })
        : sanitized,
    [html, message.attachments, consent.data, inline.data, sanitized],
  );
  return (
    <div>
      {sanitized.remoteImages > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink2">
          <span>
            {consent.data ? "Remote images allowed for this message." : "Remote images blocked."}
          </span>
          <Button variant="quiet" onClick={() => client.setQueryData(consentKey, !consent.data)}>
            {consent.data ? "Block remote images" : "Load remote images"}
          </Button>
        </div>
      ) : null}
      {sanitized.blockedOtherContent ? (
        <p className="mb-2 text-xs text-ink2">External image sources and styles are blocked.</p>
      ) : null}
      <iframe
        title={`HTML message: ${message.subject || "(No subject)"}`}
        srcDoc={rendered.srcDoc}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="block h-[min(60vh,32rem)] min-h-48 w-full rounded-[7px] border border-line bg-[#faf9f6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
      {inline.isFetching ? (
        <p className="mt-2 text-xs text-ink2" role="status">
          Loading inline images...
        </p>
      ) : null}
      <ErrorNotice error={inline.error} />
    </div>
  );
}

export function MessageBody({ message }: { message: Message }) {
  const [plain, setPlain] = useState(false);
  const [fullHtml, setFullHtml] = useState(false);
  const html = message.extracted_html ?? message.html;
  const text = message.extracted_text ?? message.text;
  const hasHtml = html !== undefined;
  return (
    <div>
      {hasHtml ? (
        <div className="my-2 flex gap-1" role="group" aria-label="Message format">
          <Button
            variant="quiet"
            className="aria-pressed:bg-hover aria-pressed:text-ink"
            aria-pressed={!plain}
            onClick={() => setPlain(false)}
          >
            HTML
          </Button>
          <Button
            variant="quiet"
            className="aria-pressed:bg-hover aria-pressed:text-ink"
            aria-pressed={plain}
            onClick={() => setPlain(true)}
          >
            Plain text
          </Button>
        </div>
      ) : null}
      {hasHtml && !plain ? (
        <>
          <HtmlBody message={message} html={fullHtml ? (message.html ?? html) : html} />
          {message.html !== undefined && message.html !== html ? (
            <Button
              variant="quiet"
              className="mt-2"
              aria-pressed={fullHtml}
              onClick={() => setFullHtml((value) => !value)}
            >
              {fullHtml ? "Show extracted HTML" : "Show full HTML message"}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <div className="font-serif text-[17px] leading-[1.6]">
            <p className="mb-[.7em] whitespace-pre-wrap last:mb-0">
              {text ?? "This message has no plain-text body."}
            </p>
          </div>
          {hasQuotedText(message.text, message.extracted_text) ? (
            <Disclosure label="Show quoted text">
              <blockquote className="mt-2 whitespace-pre-wrap border-l border-line pl-3.5 font-serif text-[15px] leading-[1.55] text-ink2">
                {message.text}
              </blockquote>
            </Disclosure>
          ) : null}
        </>
      )}
    </div>
  );
}
