# Security policy

Inbot handles mail and credentials on the owner's machine and connects to Cloudflare for mail transport and optional remote access. We take reports about these boundaries seriously.

## Reporting a vulnerability

Report vulnerabilities privately. Do not open a public issue, discussion, or pull request.

- Preferred: [open a private security advisory](https://github.com/kerddotdev/inbot/security/advisories/new) on GitHub.
- Alternative: email [security@kerd.dev](mailto:security@kerd.dev).

Include the affected Inbot version, your operating system, reproduction steps using synthetic mail and a temporary home, and the impact you observed. Never include real mail, credentials, keys, or signed download URLs. We acknowledge reports as soon as we can, keep you updated while we investigate, and credit you in the advisory unless you prefer otherwise. There is no guaranteed response or fix deadline.

## Supported versions

The latest 0.1.x release receives security fixes. Older patches and unreleased development snapshots are not supported; reproduce on the latest patch where possible.

## Security model

Inbound mail is age-encrypted to the owner's public key before it waits in the Cloudflare R2 buffer. On the host, mail is stored in an encrypted SQLite database. Inbot is zero-knowledge at rest, not end-to-end encrypted: the mail provider sees plaintext in transit, outbound mail passes through it, and Cloudflare terminates public TLS for remote access. Provider-generated delivery events can contain plaintext subjects in their Queue until acknowledged.

Email content is untrusted data. It cannot grant permissions or widen an agent's scope. Inbox scope, permission whitelists, hidden labels, and `direct`, `approval`, or `read_only` send policies are enforced by the service. Owner management operations are unavailable to agent credentials and are not exposed as MCP tools.

## Scope

In scope:

- Plaintext mail, keys, or credentials leaking through Inbot storage, cloud buffering, logs, or diagnostics
- Bypassing authentication, browser Origin or CSRF checks, OAuth audience binding, or credential revocation
- Agents accessing inboxes, hidden messages, attachments, or operations outside their grants, or bypassing send policies
- Untrusted email content executing scripts in the owner UI or causing Inbot to treat message content as authorization
- Bypassing the tunnel path allowlist, reaching excluded owner management routes, or using a local owner bearer token through the tunnel
- Encryption, key handling, signed download, or webhook authorization flaws in Inbot

Out of scope:

- Attacks that require an already compromised host account or access to the owner's unlocked credential store
- Provider access to plaintext in transit and the delivery-event metadata described above
- Actions the owner intentionally authorizes, such as sending mail or granting an agent access to an inbox
- An external agent following malicious email instructions within permissions it already has, without an Inbot authorization bypass
- Denial of service through traffic volume alone, or vulnerabilities in third-party services without an Inbot-specific impact

Only test against machines, accounts, domains, and inboxes you own. Use synthetic mail and isolated homes; do not test against another owner's instance or mail infrastructure.
