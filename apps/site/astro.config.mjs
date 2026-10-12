import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  site: "https://inbot.kerd.dev",
  trailingSlash: "never",
  build: { format: "directory", inlineStylesheets: "always" },
  integrations: [sitemap()],
  vite: { plugins: [tailwind()] },
});
