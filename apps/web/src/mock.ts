export const DOMAIN = "agents.kerd.dev";

export type InboxId = "kerd-bot" | "research" | "billing-bot" | "scheduler";

export const inboxIds: readonly InboxId[] = ["kerd-bot", "research", "billing-bot", "scheduler"];

export interface Person {
  name: string;
  address: string;
}

export type DeliveryState = "queued" | "sent" | "delivered" | "bounced" | "failed";

export interface ThreadMessage {
  id: string;
  direction: "received" | "sent";
  from: Person;
  time: string;
  paragraphs: string[];
  quoted?: string;
  attachments: { name: string; size: string }[];
  delivery?: { state: DeliveryState; time: string };
  approvedByOwner?: boolean;
}

export type Authentication = { result: "pass" } | { result: "fail"; detail: string };

export interface Thread {
  id: string;
  inbox: InboxId;
  subject: string;
  correspondent: string;
  time: string;
  unread: boolean;
  authentication: Authentication;
  messages: ThreadMessage[];
}

const northwind: Person = { name: "Northwind Supply", address: "accounts@northwind.example" };
const billingBot: Person = { name: "billing-bot", address: `billing-bot@${DOMAIN}` };

export const threads: Thread[] = [
  {
    id: "northwind-invoice",
    inbox: "billing-bot",
    subject: "Invoice NW-2291 - payment confirmation",
    correspondent: "Northwind Supply",
    time: "10:42",
    unread: true,
    authentication: { result: "pass" },
    messages: [
      {
        id: "m1",
        direction: "received",
        from: northwind,
        time: "Mon 16:20",
        paragraphs: [
          "Hello, invoice NW-2291 for 1,840.00 EUR is due on Friday. Could you confirm the payment date?",
        ],
        attachments: [],
      },
      {
        id: "m2",
        direction: "sent",
        from: billingBot,
        time: "Mon 16:31",
        paragraphs: [
          "The transfer for NW-2291 is scheduled for Thursday and will reference the invoice number.",
        ],
        quoted:
          "On Mon 16:20, Northwind Supply wrote: Hello, invoice NW-2291 for 1,840.00 EUR is due on Friday. Could you confirm the payment date?",
        attachments: [],
        delivery: { state: "delivered", time: "16:31" },
        approvedByOwner: true,
      },
      {
        id: "m3",
        direction: "received",
        from: northwind,
        time: "10:42",
        paragraphs: [
          "Thanks, that works. Please include the PO number on the remittance advice so we can match it on our side.",
        ],
        quoted:
          "On Mon 16:31, billing-bot wrote: The transfer for NW-2291 is scheduled for Thursday and will reference the invoice number.",
        attachments: [{ name: "PO-77-0192.pdf", size: "84 KB" }],
      },
    ],
  },
  {
    id: "hollis-quote",
    inbox: "billing-bot",
    subject: "Re: Quote for 500 brochures",
    correspondent: "To: Hollis Print Co.",
    time: "09:12",
    unread: false,
    authentication: { result: "pass" },
    messages: [
      {
        id: "m1",
        direction: "sent",
        from: billingBot,
        time: "09:12",
        paragraphs: ["Please find our confirmed quantities. Could you send the revised timeline?"],
        quoted:
          "On Fri 15:02, Hollis Print Co. wrote: We can print 500 brochures in two weeks at the quoted price.",
        attachments: [],
        delivery: { state: "delivered", time: "09:12" },
        approvedByOwner: true,
      },
    ],
  },
  {
    id: "brightlane-bounce",
    inbox: "billing-bot",
    subject: "Undelivered: pricing@brightlane.example",
    correspondent: "Mail delivery system",
    time: "Yesterday",
    unread: false,
    authentication: { result: "pass" },
    messages: [
      {
        id: "m1",
        direction: "sent",
        from: billingBot,
        time: "Yesterday 14:05",
        paragraphs: ["Could you share the current price list for the annual plan?"],
        attachments: [],
        delivery: { state: "bounced", time: "14:05" },
        approvedByOwner: true,
      },
      {
        id: "m2",
        direction: "received",
        from: { name: "Mail delivery system", address: "mailer-daemon@example" },
        time: "Yesterday 14:06",
        paragraphs: ["550 5.1.1 The recipient address does not exist on this server."],
        attachments: [],
      },
    ],
  },
  {
    id: "secure-pay-phish",
    inbox: "billing-bot",
    subject: "Action needed: verify your account",
    correspondent: "accounts@secure-pay.example",
    time: "Tue",
    unread: false,
    authentication: { result: "fail", detail: "SPF fail, DKIM none, DMARC fail" },
    messages: [
      {
        id: "m1",
        direction: "received",
        from: { name: "accounts@secure-pay.example", address: "accounts@secure-pay.example" },
        time: "Tue 03:14",
        paragraphs: [
          "Your account will be suspended unless you confirm your details.",
          "Use the link below within 24 hours to keep access.",
        ],
        attachments: [],
      },
    ],
  },
  {
    id: "mira-interview",
    inbox: "kerd-bot",
    subject: "Interview slots for next week",
    correspondent: "Mira Okafor",
    time: "09:58",
    unread: true,
    authentication: { result: "pass" },
    messages: [
      {
        id: "m1",
        direction: "received",
        from: { name: "Mira Okafor", address: "mira.okafor@example.com" },
        time: "09:58",
        paragraphs: ["Tuesday 14:00 or Thursday 10:30 both work on my side."],
        attachments: [],
      },
    ],
  },
  {
    id: "priya-travel",
    inbox: "kerd-bot",
    subject: "Re: Conference travel notes",
    correspondent: "Priya Nair",
    time: "Mon",
    unread: false,
    authentication: { result: "pass" },
    messages: [
      {
        id: "m1",
        direction: "received",
        from: { name: "Priya Nair", address: "priya.nair@example.com" },
        time: "Mon 11:20",
        paragraphs: ["Great, I will forward the itinerary once the options are summarized."],
        attachments: [],
      },
    ],
  },
  {
    id: "tomas-benchmark",
    inbox: "research",
    subject: "Q3 supplier benchmark",
    correspondent: "Tomas Brandt",
    time: "Yesterday",
    unread: true,
    authentication: { result: "pass" },
    messages: [
      {
        id: "m1",
        direction: "received",
        from: { name: "Tomas Brandt", address: "tomas.brandt@example.com" },
        time: "Yesterday 17:40",
        paragraphs: ["Attached is the benchmark we discussed. Section 4 covers lead times."],
        attachments: [{ name: "supplier-benchmark-q3.pdf", size: "1.2 MB" }],
      },
    ],
  },
];

export interface Draft {
  id: string;
  inbox: InboxId;
  to: string;
  subject: string;
  ago: string;
  createdAt: string;
  keyName: string;
  keySuffix: string;
  paragraphs: string[];
}

export const drafts: Draft[] = [
  {
    id: "pricing-followup",
    inbox: "research",
    to: "sales@brightlane.example",
    subject: "Follow-up: pricing for annual plan",
    ago: "4 min",
    createdAt: "10:38",
    keyName: "research-prod",
    keySuffix: "a41f",
    paragraphs: [
      "Hello,",
      "Thank you for the overview last week. Could you share the annual plan pricing for 10 seats, including any discount for upfront payment?",
      "We would also like to know whether data export is included in the base tier.",
      "Best regards,\nResearch assistant for Dani Kerekes",
    ],
  },
  {
    id: "invoice-reminder",
    inbox: "billing-bot",
    to: "ap@fernhill.example",
    subject: "Payment reminder - invoice 4417",
    ago: "22 min",
    createdAt: "10:20",
    keyName: "billing-bot",
    keySuffix: "91d7",
    paragraphs: [
      "Hello,",
      "Invoice 4417 for 620.00 EUR was due last Friday and is still open on our side. Could you let us know when we can expect the payment?",
      "Best regards,\nBilling assistant for Dani Kerekes",
    ],
  },
  {
    id: "meeting-notes",
    inbox: "kerd-bot",
    to: "mira.okafor@example.com",
    subject: "Re: Meeting notes and next steps",
    ago: "1 h",
    createdAt: "09:41",
    keyName: "kerd-bot-main",
    keySuffix: "c20e",
    paragraphs: [
      "Hi Mira,",
      "Thanks for the notes. I will send the updated proposal by Wednesday, and we can use Thursday 10:30 for the interview.",
      "Best regards,\nDani",
    ],
  },
];

export type RecordStatus = "valid" | "missing" | "invalid";

export interface DnsRecord {
  id: string;
  status: RecordStatus;
  type: "MX" | "TXT";
  name: string;
  value: string;
  note?: string;
}

export const dnsRecords: DnsRecord[] = [
  { id: "mx1", status: "valid", type: "MX", name: DOMAIN, value: "10 route1.mx.cloudflare.net" },
  { id: "mx2", status: "valid", type: "MX", name: DOMAIN, value: "20 route2.mx.cloudflare.net" },
  { id: "mx3", status: "missing", type: "MX", name: DOMAIN, value: "30 route3.mx.cloudflare.net" },
  {
    id: "spf",
    status: "valid",
    type: "TXT",
    name: DOMAIN,
    value: "v=spf1 include:_spf.mx.cloudflare.net ~all",
  },
  {
    id: "dkim",
    status: "invalid",
    type: "TXT",
    name: `cf2024-1._domainkey.${DOMAIN}`,
    value: "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...",
    note: "Published value does not match the expected key.",
  },
  {
    id: "bounce-mx",
    status: "valid",
    type: "MX",
    name: `cf-bounce.${DOMAIN}`,
    value: "10 route1.mx.cloudflare.net",
  },
  {
    id: "bounce-spf",
    status: "valid",
    type: "TXT",
    name: `cf-bounce.${DOMAIN}`,
    value: "v=spf1 include:_spf.mx.cloudflare.net ~all",
  },
  {
    id: "dmarc",
    status: "missing",
    type: "TXT",
    name: `_dmarc.${DOMAIN}`,
    value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}`,
  },
];

export type SendPolicy = "direct" | "approval" | "read-only";
export type PermissionPreset = "read" | "read-draft" | "full";

export interface ApiKey {
  id: string;
  name: string;
  suffix: string;
  inboxes: InboxId[];
  preset: PermissionPreset;
  sendPolicy: SendPolicy;
  lastUsed: string;
}

export const apiKeys: ApiKey[] = [
  {
    id: "k1",
    name: "kerd-bot-main",
    suffix: "c20e",
    inboxes: ["kerd-bot"],
    preset: "full",
    sendPolicy: "direct",
    lastUsed: "2 min ago",
  },
  {
    id: "k2",
    name: "research-prod",
    suffix: "a41f",
    inboxes: ["research"],
    preset: "read-draft",
    sendPolicy: "approval",
    lastUsed: "4 min ago",
  },
  {
    id: "k3",
    name: "billing-bot",
    suffix: "91d7",
    inboxes: ["billing-bot"],
    preset: "full",
    sendPolicy: "approval",
    lastUsed: "22 min ago",
  },
  {
    id: "k4",
    name: "dashboard-readonly",
    suffix: "03bb",
    inboxes: [...inboxIds],
    preset: "read",
    sendPolicy: "read-only",
    lastUsed: "Yesterday",
  },
  {
    id: "k5",
    name: "scheduler-test",
    suffix: "f8a2",
    inboxes: ["scheduler"],
    preset: "read-draft",
    sendPolicy: "approval",
    lastUsed: "Never",
  },
];

export interface RemoteAccess {
  enabled: boolean;
  tunnelUrl: string;
  connector: { state: "connected"; version: string; since: string };
  routes: string[];
}

export const remoteAccess: RemoteAccess = {
  enabled: true,
  tunnelUrl: "https://mail.kerd.dev",
  connector: { state: "connected", version: "cloudflared 2026.9.1", since: "08:12" },
  routes: ["/v0", "/mcp"],
};
