import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = process.env["INBOT_DEV_SERVER_PORT"];
const target = serverPort ? `http://127.0.0.1:${serverPort}` : undefined;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: target ? { proxy: { "/v0": target, "/mcp": target } } : {},
});
