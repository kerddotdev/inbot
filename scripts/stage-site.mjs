import { cp, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const site = join(root, "apps/site/site");
const docs = join(site, "docs");

await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });
await cp(join(root, "apps/site/dist"), site, { recursive: true });
await cp(join(root, "apps/docs/dist"), docs, { recursive: true });
await copyFile(join(root, "install.sh"), join(site, "install.sh"));
await copyFile(join(root, "install.ps1"), join(site, "install.ps1"));

const security = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000
`;
await writeFile(
  join(site, "_headers"),
  security + (await readFile(join(docs, "_headers"), "utf8")),
);
await rm(join(docs, "_headers"));
for (const file of ["404.html", "404.md", "404.json"]) await rm(join(docs, file), { force: true });
