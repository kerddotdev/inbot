import { useMutation } from "@tanstack/react-query";
import type { Attachment } from "@inbot/contracts/src/attachments.js";
import { ErrorNotice } from "../feedback";
import { Button } from "./ui";

const displayName = (filename: string | undefined) =>
  filename?.replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, "") || "attachment";

export function AttachmentDownload({
  attachment,
  download,
}: {
  attachment: Attachment;
  download: () => Promise<Blob>;
}) {
  const mutation = useMutation({
    mutationFn: async () => {
      const blob = await download();
      const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = displayName(attachment.filename);
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  return (
    <div className="mt-3">
      <Button
        variant="quiet"
        icon="download"
        className="max-w-full cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait"
        aria-label={`Download ${displayName(attachment.filename)}`}
        aria-busy={mutation.isPending}
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        <span className="min-w-0 break-words">
          {displayName(attachment.filename)}{" "}
          <small className="text-ink2">{Math.ceil(attachment.size / 1024)} KB</small>
          {mutation.isPending ? " - Downloading..." : null}
        </span>
      </Button>
      <ErrorNotice error={mutation.error} />
    </div>
  );
}
