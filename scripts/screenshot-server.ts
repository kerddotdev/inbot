import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Clock, Effect, Schema } from "effect";
import type { SendAttachment } from "../packages/contracts/src/attachments.js";
import { Draft } from "../packages/contracts/src/drafts.js";
import { SendMessageResponse } from "../packages/contracts/src/messages.js";
import * as OAuth from "../packages/contracts/src/oauth.js";
import { OwnerLoginLink, OwnerSessionResponse } from "../packages/contracts/src/owner.js";
import type { CreateWebhookRequest } from "../packages/contracts/src/webhooks.js";
import { presetPermissions } from "../apps/web/src/components/grant-presets.js";
import { fixture } from "../apps/server/src/http/test-fixture.js";
import { ingestInbound } from "../apps/server/src/inbound/ingest.js";
import { Mailbox } from "../apps/server/src/mailbox/mailbox.js";
import { observeSelfTest } from "../apps/server/src/provision/selftest.js";

const domain = "agents.example.com";
const research = `research@${domain}`;
const support = `support@${domain}`;
const ops = `ops@${domain}`;
const billing = `billing@${domain}`;
const password = "inbot-screenshot-demo";
const hour = 60 * 60 * 1000;
type Demo = Awaited<ReturnType<typeof fixture>>;
type Mail = {
  id: string;
  inbox: string;
  name: string;
  sender: string;
  subject: string;
  text: string;
  timestamp: number;
  parent?: string;
  attachment?: SendAttachment;
};

async function requireOk(response: Response, expectedStatus = 200) {
  if (response.status !== expectedStatus)
    throw new Error(`Seeding failed (${response.status}): ${await response.text()}`);
  return response;
}

function mime(mail: Mail) {
  const boundary = `inbot-demo-${mail.id}`;
  const senderDomain = mail.sender.split("@")[1];
  const headers = [
    `Message-ID: <${mail.id}@example.org>`,
    `Date: ${new Date(mail.timestamp).toUTCString()}`,
    `From: ${mail.name} <${mail.sender}>`,
    `To: ${mail.inbox}`,
    `Subject: ${mail.subject}`,
    `Authentication-Results: mx.example.com; dkim=pass header.d=${senderDomain}`,
    "MIME-Version: 1.0",
    ...(mail.parent
      ? [`In-Reply-To: ${mail.parent}`, `References: <vendor-quote@example.org> ${mail.parent}`]
      : []),
  ];
  const attachment = mail.attachment;
  return Buffer.from(
    [
      ...headers,
      ...(attachment
        ? [
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            mail.text,
            `--${boundary}`,
            `Content-Type: ${attachment.content_type}`,
            `Content-Disposition: attachment; filename="${attachment.filename}"`,
            "Content-Transfer-Encoding: base64",
            "",
            attachment.content,
            `--${boundary}--`,
          ]
        : ["Content-Type: text/plain; charset=utf-8", "", mail.text]),
      "",
    ].join("\r\n"),
  );
}

async function ingest(demo: Demo, mail: Mail) {
  const results = await demo.run(
    ingestInbound(
      {
        raw: mime(mail),
        mail_from: mail.sender,
        rcpt_to: [mail.inbox],
        received_at: new Date(mail.timestamp).toISOString(),
      },
      { trusted_authserv_ids: ["mx.example.com"] },
    ).pipe(Effect.provideService(Mailbox, demo.mailbox)),
  );
  const result = results[0];
  if (!result) throw new Error("Missing synthetic inbound result");
  return result;
}

function invoice() {
  const content = [
    "BT /F1 24 Tf 50 750 Td (Northstar Research) Tj",
    "0 -42 Td /F1 14 Tf (Invoice INV-1042) Tj",
    "0 -32 Td (Research workspace - monthly subscription) Tj",
    "0 -26 Td (Amount due: USD 240.00) Tj",
    "0 -26 Td (Payment terms: Net 30) Tj ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return {
    filename: "invoice-1042.pdf",
    content_type: "application/pdf",
    content: Buffer.from(pdf).toString("base64"),
  };
}

async function seed(demo: Demo) {
  const now = Date.now();
  demo.advance(now - 24 * hour - (await demo.run(Clock.currentTimeMillis)));
  for (const inbox of ["agent@example.test", "other@example.test"])
    await demo.run(demo.mailbox.deleteInbox(inbox));
  demo.cloud.account.id = "a".repeat(32);
  await requireOk(
    await demo.request("/v0/owner/transport", {
      method: "PUT",
      body: { account_id: demo.cloud.account.id, api_token: "synthetic-screenshot-token" },
    }),
  );
  demo.cloud.state.onSelfTest = async (name, token) => {
    const address = `inbot-selftest@${name}`;
    const observed = await demo.run(
      observeSelfTest(
        demo.store,
        { mail_from: `bounces@cf-bounce.${name}`, rcpt_to: [address] },
        Buffer.from(
          `From: ${address}\r\nTo: ${address}\r\nX-Inbot-Selftest: ${token}\r\n\r\nSynthetic verification probe.`,
        ),
        new Date(now - 24 * hour).toISOString(),
      ),
    );
    if (!observed) throw new Error("The fake domain self-test was not observed");
  };
  const created = await demo.run(demo.provisioner.create({ domain }));
  await demo.run(demo.provisioner.apply(created.domain_id));
  const verified = await demo.run(demo.provisioner.verify(created.domain_id));
  if (verified.status !== "VERIFIED") throw new Error("The synthetic domain was not verified");
  for (const [username, display_name] of [
    ["research", "Research agent"],
    ["support", "Support agent"],
    ["ops", "Operations agent"],
    ["billing", "Billing agent"],
  ])
    await requireOk(
      await demo.request("/v0/inboxes", {
        method: "POST",
        body: { username, display_name, domain },
      }),
    );

  const quoteKey = await demo.run(
    demo.keys.create({
      name: "Research agent",
      inbox_ids: [research],
      permissions: presetPermissions.full,
      send_policy: "direct",
    }),
  );
  const approvalKey = await demo.run(
    demo.keys.create({
      name: "Support triage",
      inbox_ids: [support, billing],
      permissions: presetPermissions.full,
      send_policy: "approval",
    }),
  );
  await demo.run(
    demo.keys.create({
      name: "Read-only reporter",
      inbox_ids: [research, support, ops, billing],
      permissions: presetPermissions.read,
      send_policy: "read_only",
    }),
  );
  await demo.run(
    demo.keys.create({
      name: "Operations assistant",
      inbox_ids: [ops],
      permissions: presetPermissions["read-draft"],
      send_policy: "approval",
    }),
  );

  const screenshot: SendAttachment = {
    filename: "export-error.png",
    content_type: "image/png",
    content: (await readFile(resolve("scripts/fixtures/customer-screenshot.png"))).toString(
      "base64",
    ),
  };
  const pdf = invoice();
  const messages = [
    {
      id: "vendor-quote",
      inbox: research,
      name: "Maya Chen",
      sender: "maya@example.org",
      subject: "Quote for the customer research study",
      text: "Hi team,\n\nWe can recruit twelve participants for the onboarding study next week. The quote is $1,800, including interview recordings and a short findings report.\n\nCould you confirm whether you want a mix of new and returning customers? We can hold the interview slots until Thursday.\n\nBest,\nMaya",
    },
    {
      id: "research-notes",
      inbox: research,
      name: "Daniel Brooks",
      sender: "daniel@example.net",
      subject: "Three patterns from the onboarding interviews",
      text: "Hi Research,\n\nI reviewed the first six interviews. Customers found the setup instructions clear, but three people missed the confirmation email because it landed in Promotions.\n\nThe strongest request was a single place to check what has finished and what still needs attention. I have grouped the notes by task so we can compare them with the next round.\n\nDaniel",
    },
    {
      id: "invoice",
      inbox: billing,
      name: "Nora Patel",
      sender: "accounts@example.org",
      subject: "Invoice INV-1042 for your research workspace",
      text: "Hello,\n\nYour monthly workspace invoice is attached. The total is $240.00 and payment is due within 30 days. Your plan and seat count have not changed.\n\nPlease include INV-1042 in the payment reference. If your billing contact has changed, reply here and I will update our records.\n\nThanks,\nNora",
      attachment: pdf,
    },
    {
      id: "deployment",
      inbox: ops,
      name: "Alex Rivera",
      sender: "alex@example.net",
      subject: "Release window confirmed for Thursday",
      text: "Hi Ops,\n\nThe maintenance window is confirmed for Thursday from 09:00 to 09:30 UTC. We have completed the staging checks and the rollback archive is ready.\n\nPlease keep the support queue open during the rollout. I will send a short update once the health checks and background jobs have caught up.\n\nAlex",
    },
    {
      id: "newsletter",
      inbox: research,
      name: "Product Weekly",
      sender: "newsletter@example.net",
      subject: "Product Weekly: measuring the first useful moment",
      text: "This week we are looking at the moment a new customer first gets something useful from a product.\n\nOne team reduced setup abandonment by replacing a long checklist with a working example. Another found that a helpful confirmation email mattered more than an extra tooltip.\n\nTry comparing time to first result with your usual activation metric. The gap often reveals a step that is clear to the team but confusing to a new customer.\n\nThe Product Weekly team",
    },
    {
      id: "export-bug",
      inbox: support,
      name: "Elena Rossi",
      sender: "elena@example.org",
      subject: "CSV export stops when I filter by date",
      text: "Hi Support,\n\nI am trying to export last month's activity, but the export stops after I select a date range. Exporting without a filter works. I have attached a screenshot of the error.\n\nI can reproduce it in Safari and Chrome with the same workspace. Could you check whether the date filter is being passed to the export job correctly?\n\nThanks,\nElena",
      attachment: screenshot,
    },
    {
      id: "meeting",
      inbox: research,
      name: "Sam Wilson",
      sender: "sam@example.net",
      subject: "Can we move the research review to 14:30?",
      text: "Hi team,\n\nCould we move tomorrow's research review from 13:00 to 14:30? The customer call before it is likely to run over, and I would like to bring those notes into the discussion.\n\nThe agenda can stay the same: review the interview themes, choose two follow-up questions, and agree on the recruitment brief.\n\nSam",
    },
    {
      id: "receipt",
      inbox: billing,
      name: "Nora Patel",
      sender: "accounts@example.org",
      subject: "Payment received - thank you",
      text: "Hello,\n\nWe have received the $120 payment for last month's additional participant sessions. Your account is up to date.\n\nThe receipt is available in your billing portal. The upcoming subscription invoice will be sent separately to this address.\n\nThanks,\nNora",
    },
    {
      id: "backup",
      inbox: ops,
      name: "Jordan Lee",
      sender: "jordan@example.org",
      subject: "Backup restore drill completed",
      text: "Hi Ops,\n\nToday's restore drill completed successfully in the isolated test environment. All sampled records matched the source snapshot and the application passed its health check.\n\nThe restore took eight minutes, comfortably inside our target. I have recorded the timings and the one manual step we should remove before the next drill.\n\nJordan",
    },
    {
      id: "support-question",
      inbox: support,
      name: "Priya Shah",
      sender: "priya@example.net",
      subject: "Adding a second workspace contact",
      text: "Hi Support,\n\nWe would like our project coordinator to receive status updates alongside me. Is there a way to add a second contact without giving them billing access?\n\nThey only need the weekly summary and notifications when an export is ready. I can share their address once you confirm the right setup.\n\nThanks,\nPriya",
    },
  ] satisfies Omit<Mail, "timestamp">[];
  for (const [index, message] of messages.entries()) {
    const result = await ingest(demo, { ...message, timestamp: now - (72 - index * 5) * hour });
    if (result.status !== "stored") throw new Error(`Synthetic mail ${message.id} was not stored`);
    await demo.run(
      demo.mailbox.updateMessage(message.inbox, result.message_id, {
        add_labels: [
          message.inbox === billing
            ? "finance"
            : message.inbox === ops
              ? "operations"
              : message.id === "newsletter"
                ? "reading"
                : "follow-up",
        ],
        ...(index % 3 === 0 ? {} : { remove_labels: ["unread"] }),
      }),
    );
  }
  const reply = Schema.decodeUnknownSync(SendMessageResponse)(
    await (
      await requireOk(
        await demo.request(
          `/v0/inboxes/${research}/messages/${encodeURIComponent("<vendor-quote@example.org>")}/reply`,
          {
            method: "POST",
            token: quoteKey.api_key,
            headers: { "idempotency-key": "screenshot-vendor-reply" },
            body: {
              text: "Hi Maya,\n\nThanks for the quote. Please recruit six new customers and six returning customers, with a mix of small and larger teams. The proposed budget works for us.\n\nI will send the final discussion guide tomorrow. Please hold the Thursday slots while we confirm the participant list.\n\nResearch agent",
            },
          },
        ),
      )
    ).json(),
  );
  await demo.run(demo.outbox.processDue());
  const entry = await demo.run(demo.outbox.get(research, reply.message_id));
  if (entry.state !== "sent" || !entry.provider_message_id)
    throw new Error("The fake provider did not accept the reply");
  if (
    !(await demo.run(
      demo.outbox.applyDeliveryEvent({
        event_id: "screenshot-delivered",
        provider_message_id: entry.provider_message_id,
        status: "delivered",
        recipient: "maya@example.org",
        timestamp: new Date(now - 23 * hour).toISOString(),
      }),
    ))
  )
    throw new Error("The fake delivery event did not match the reply");
  const followup = await ingest(demo, {
    id: "vendor-confirmation",
    inbox: research,
    name: "Maya Chen",
    sender: "maya@example.org",
    subject: "Re: Quote for the customer research study",
    parent: reply.message_id,
    timestamp: now - 20 * hour,
    text: "Hi Research,\n\nThat mix works well. I have reserved the Thursday slots and started outreach to the first group of participants.\n\nSend the discussion guide when it is ready. I will share the confirmed schedule by tomorrow afternoon.\n\nMaya",
  });
  if (followup.status !== "stored" || followup.thread_id !== reply.thread_id)
    throw new Error("The vendor replies did not stay in one thread");

  demo.advance(24 * hour);
  for (const input of [
    {
      inbox: support,
      to: ["elena@example.org"],
      subject: "Re: CSV export stops when I filter by date",
      text: "Hi Elena,\n\nWe reproduced the issue and found that the end date was being sent in the wrong format. The fix is ready and we will include it in Thursday's release.\n\nYou can export without the date filter in the meantime. I will follow up as soon as the update is available.\n\nSupport agent",
    },
    {
      inbox: billing,
      to: ["accounts@example.org"],
      subject: "Invoice INV-1042 approved for payment",
      text: "Hi Nora,\n\nI have checked INV-1042 against our workspace plan and the total is correct. The invoice is attached for our finance team's records.\n\nPlease keep billing messages addressed to this inbox. We will send a payment confirmation once the transfer has completed.\n\nBilling agent",
      attachments: [pdf],
    },
  ]) {
    const { inbox, ...body } = input;
    const draft = Schema.decodeUnknownSync(Draft)(
      await (
        await requireOk(
          await demo.request(`/v0/inboxes/${inbox}/drafts`, {
            method: "POST",
            token: approvalKey.api_key,
            body,
          }),
        )
      ).json(),
    );
    const pending = await demo.request(`/v0/inboxes/${inbox}/drafts/${draft.draft_id}/send`, {
      method: "POST",
      token: approvalKey.api_key,
      body: {},
    });
    await requireOk(pending, 403);
    if (!(await demo.run(demo.drafts.get(inbox, draft.draft_id))).pending_approval)
      throw new Error("Expected a pending approval draft");
  }

  for (const [path, entry] of [
    ["/v0/lists/receive/allow", "example.org"],
    ["/v0/lists/receive/allow", "example.net"],
    ["/v0/lists/receive/block", "offers@blocked.example.net"],
    ["/v0/lists/send/block", "blocked.example.org"],
    [`/v0/inboxes/${research}/lists/receive/allow`, "maya@example.org"],
    [`/v0/inboxes/${support}/lists/receive/block`, "spam@blocked.example.org"],
  ])
    await requireOk(await demo.request(path ?? "", { method: "POST", body: { entry } }));
  for (const [index, sender] of [
    "offers@blocked.example.net",
    "spam@blocked.example.org",
  ].entries()) {
    const rejected = await ingest(demo, {
      id: `blocked-${index}`,
      inbox: support,
      name: "Unsolicited sender",
      sender,
      subject: "Unsolicited partner promotion",
      timestamp: now - (index + 1) * hour,
      text: "Hello,\n\nWe would like to send your team a promotional offer. Please reply if you would like to receive more details.\n\nPromotions team",
    });
    if (rejected.status !== "skipped_blocked")
      throw new Error("The blocked sender was not rejected");
  }
  for (const body of [
    {
      url: "https://hooks.example.net/inbot",
      event_types: ["message.received", "message.delivered"],
    },
    {
      url: "https://automation.example.org/mail",
      event_types: ["message.received", "draft.approval_required"],
      inbox_ids: [support, billing],
    },
  ] satisfies CreateWebhookRequest[])
    await requireOk(await demo.request("/v0/webhooks", { method: "POST", body }));
  demo.connector.ready = true;
  await demo.run(demo.remote.enable({ hostname: "inbot.example.com" }));
  await demo.run(demo.remote.tick());
  if ((await demo.run(demo.remote.status())).state !== "connected")
    throw new Error("The fake connector was not ready");

  const setup = await requireOk(
    await demo.request("/v0/owner/setup", {
      token: null,
      method: "POST",
      body: { code: demo.setupCode, password },
    }),
  );
  const session = Schema.decodeUnknownSync(OwnerSessionResponse)(await setup.json());
  const headers = {
    cookie: setup.headers.get("set-cookie")?.split(";")[0] ?? "",
    "x-inbot-csrf": session.csrf_token,
    origin: demo.url,
  };
  const client = Schema.decodeUnknownSync(OAuth.RegisteredClient)(
    await (
      await requireOk(
        await demo.request("/oauth/register", {
          token: null,
          method: "POST",
          body: { client_name: "Claude", redirect_uris: ["http://127.0.0.1:4567/callback"] },
        }),
        201,
      )
    ).json(),
  );
  const verifier = randomBytes(32).toString("base64url");
  const authorization: OAuth.AuthorizationRequest = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0] ?? "",
    resource: `${demo.url}/mcp`,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
  const consent = Schema.decodeUnknownSync(OAuth.ConsentResponse)(
    await (
      await requireOk(
        await demo.request("/oauth/authorize", {
          token: null,
          method: "POST",
          headers,
          body: {
            ...authorization,
            approved: true,
            grant: {
              inbox_ids: [research],
              permissions: presetPermissions.read,
              send_policy: "read_only",
            },
          },
        }),
      )
    ).json(),
  );
  await requireOk(
    await demo.request("/oauth/token", {
      token: null,
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: new URL(consent.redirect_uri).searchParams.get("code"),
        redirect_uri: authorization.redirect_uri,
        code_verifier: verifier,
        resource: authorization.resource,
      },
    }),
  );
}

async function main() {
  const webRoot = resolve("apps/web/dist");
  try {
    await access(join(webRoot, "index.html"));
  } catch {
    throw new Error(
      "The owner UI build is missing. Run pnpm web:build, then pnpm screenshots:serve.",
    );
  }
  const home = await mkdtemp(join(tmpdir(), "inbot-screenshots-"));
  let demo: Demo | undefined;
  let stop = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    demo = await fixture(home, {
      webRoot,
      zoneName: "example.com",
      dns: {
        check: (records) =>
          Effect.succeed(records.map((record) => ({ ...record, status: "VALID" }))),
      },
    });
    await seed(demo);
    const login = Schema.decodeUnknownSync(OwnerLoginLink)(
      await (
        await requireOk(await demo.request("/v0/owner/login-links", { method: "POST" }))
      ).json(),
    );
    console.log(
      `Screenshot server ready (synthetic data and fake providers only)\nPID: ${process.pid}\nHome: ${home}\nBase URL: ${demo.url}\nOwner login link (single use): ${login.url}\nDemo password: ${password}\nPress Ctrl+C to stop and remove the temporary home.`,
    );
    await stopped;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      await demo?.close();
    } finally {
      await rm(home, { recursive: true, force: true });
      console.log(`Removed temporary home: ${home}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The screenshot server failed.");
  process.exitCode = 1;
});
