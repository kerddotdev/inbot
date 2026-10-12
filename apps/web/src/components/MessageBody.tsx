import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Message } from "@inbot/contracts/src/messages.js";
import { api, ApiError } from "../api";
import { ErrorNotice } from "../feedback";
import { inlineImageAttachments, sanitizeMailHtml } from "../mail-html";
import { hasQuotedText } from "../mail-text";
import { Disclosure, Segmented, Status } from "./ui";

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

function useFrameHeight() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const root = element.contentDocument?.documentElement;
      if (!root) return;
      setHeight(Math.ceil(root.scrollHeight));
      observer?.disconnect();
      observer = new ResizeObserver(() => setHeight(Math.ceil(root.scrollHeight)));
      observer.observe(root);
    };
    element.addEventListener("load", measure);
    measure();
    return () => {
      element.removeEventListener("load", measure);
      observer?.disconnect();
    };
  }, []);
  return { frame, height };
}

function HtmlBody({ message, html }: { message: Message; html: string }) {
  const client = useQueryClient();
  const { frame, height } = useFrameHeight();
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
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink2">
          <Status tone="mute" icon={consent.data ? "eye" : "shield-check"}>
            {consent.data ? "Remote images loaded" : "Remote images blocked"}
          </Status>
          <button
            type="button"
            className="font-medium text-accent hover:underline"
            onClick={() => client.setQueryData(consentKey, !consent.data)}
          >
            {consent.data ? "Block again" : "Load remote images"}
          </button>
        </div>
      ) : null}
      {sanitized.blockedOtherContent ? (
        <p className="mb-3 text-xs text-ink2">External styles and image sources are blocked.</p>
      ) : null}
      {/* allow-same-origin only lets the host measure the height. Scripts stay disabled by both
          the sandbox and the frame CSP, so the sanitized document can never run code. */}
      <iframe
        ref={frame}
        title={`HTML message: ${message.subject || "(No subject)"}`}
        srcDoc={rendered.srcDoc}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        style={height === undefined ? undefined : { height }}
        className="block min-h-24 w-full rounded-[10px] bg-[#faf9f6] shadow-[0_0_0_1px_var(--line)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
        <div className="mb-4 text-xs">
          <Segmented
            name={`format-${message.message_id}`}
            value={plain ? "text" : "html"}
            onChange={(value) => setPlain(value === "text")}
            options={[
              { value: "html", label: "HTML" },
              { value: "text", label: "Plain text" },
            ]}
          />
        </div>
      ) : null}
      {hasHtml && !plain ? (
        <>
          <HtmlBody message={message} html={fullHtml ? (message.html ?? html) : html} />
          {message.html !== undefined && message.html !== html ? (
            <button
              type="button"
              className="mt-3 text-xs font-medium text-accent hover:underline"
              aria-pressed={fullHtml}
              onClick={() => setFullHtml((value) => !value)}
            >
              {fullHtml ? "Hide quoted content" : "Show quoted content"}
            </button>
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
