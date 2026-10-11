import { defineConfig } from "blume";

export default defineConfig({
  title: "Inbot",
  description: "Self-hosted, privacy-first email for AI agents.",
  logo: "/icon.svg",
  content: { root: "docs" },
  feedback: false,
  github: { owner: "kerddotdev", repo: "inbot", branch: "main", dir: "apps/docs" },
  theme: {
    mode: "system",
    radius: "md",
    accent: { light: "#0b6f78", dark: "#5cc8d0" },
  },
  markdown: {
    code: { theme: { light: "github-light", dark: "github-dark" } },
  },
  navigation: {
    sidebar: [
      { label: "Overview", root: "index" },
      {
        label: "Get started",
        items: [
          { label: "Install Inbot", root: "get-started/install" },
          { label: "Quickstart", root: "get-started/quickstart" },
          { label: "Concepts", root: "get-started/concepts" },
        ],
      },
      {
        label: "Owner guides",
        items: [
          { label: "The owner app", root: "guides/owner-app" },
          { label: "Mail transport", root: "guides/transport" },
          { label: "Domains", root: "guides/domains" },
          { label: "Inboxes and API keys", root: "guides/inboxes-and-keys" },
          { label: "Drafts and approvals", root: "guides/approvals" },
          { label: "Allow and block lists", root: "guides/lists" },
          { label: "Webhooks and events", root: "guides/webhooks" },
          { label: "Remote access", root: "guides/remote-access" },
        ],
      },
      {
        label: "Agents",
        items: [
          { label: "Connect an agent", root: "agents/connect" },
          { label: "Reading and sending mail", root: "agents/mail" },
          { label: "OAuth for MCP clients", root: "agents/oauth" },
        ],
      },
      {
        label: "How it works",
        items: [
          { label: "Architecture", root: "concepts/architecture" },
          { label: "Security model", root: "concepts/security" },
          { label: "Message states", root: "concepts/message-states" },
        ],
      },
      {
        label: "Operations",
        items: [
          { label: "Running the service", root: "operations/service" },
          { label: "Configuration", root: "operations/configuration" },
          { label: "Troubleshooting", root: "operations/troubleshooting" },
        ],
      },
      {
        label: "Reference",
        items: [
          { label: "REST API", root: "reference/rest" },
          { label: "MCP tools", root: "reference/mcp" },
          { label: "CLI", root: "reference/cli" },
          { label: "Events", root: "reference/events" },
          { label: "Permissions", root: "reference/permissions" },
          { label: "Errors and exit codes", root: "reference/errors" },
        ],
      },
      {
        label: "Development",
        items: [
          { label: "Build from source", root: "development/build" },
          { label: "Packaging and releases", root: "development/packaging" },
        ],
      },
    ],
  },
  agents: {
    mcp: { enabled: false },
    webmcp: false,
  },
});
