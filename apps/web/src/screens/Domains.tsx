import { type DnsRecord, type RecordStatus } from "../mock";
import type { IconName } from "../icons";
import { Button, CopyButton, Page, Status, type Tone } from "../components/ui";

const statusDisplay: Record<RecordStatus, { tone: Tone; icon: IconName; label: string }> = {
  valid: { tone: "ok", icon: "check-circle", label: "Valid" },
  missing: { tone: "warn", icon: "minus-circle", label: "Missing" },
  invalid: { tone: "bad", icon: "x-circle", label: "Invalid" },
};

export function Domains({ domain, records }: { domain: string; records: DnsRecord[] }) {
  const validCount = records.filter((record) => record.status === "valid").length;
  return (
    <Page
      barTitle="Domains"
      title={domain}
      lead={`Add these records at your DNS provider so agents can receive and send mail. ${validCount} of ${records.length} are valid.`}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="primary" icon="cloud">
          Apply automatically via Cloudflare
        </Button>
        <Button icon="download">Download zone file</Button>
        <span className="flex-1" />
        <Button icon="refresh">Verify now</Button>
      </div>
      <ul className="mt-5 border-b border-line">
        {records.map((record) => {
          const status = statusDisplay[record.status];
          return (
            <li
              key={record.id}
              className="grid grid-cols-[96px_44px_minmax(0,1fr)_36px] items-start gap-3.5 border-t border-line py-[11px]"
            >
              <Status tone={status.tone} icon={status.icon} small={false}>
                {status.label}
              </Status>
              <span className="pt-px font-semibold">{record.type}</span>
              <div className="min-w-0">
                <div className="truncate font-mono text-xs font-semibold">{record.name}</div>
                <div className="mt-px truncate font-mono text-xs text-ink2" title={record.value}>
                  {record.value}
                </div>
                {record.note ? <div className="mt-0.5 text-xs text-bad">{record.note}</div> : null}
              </div>
              <CopyButton text={record.value} label={`Copy ${record.type} record value`} />
            </li>
          );
        })}
      </ul>
    </Page>
  );
}
