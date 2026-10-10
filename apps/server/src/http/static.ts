import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { errorResponse, wireError } from "./errors.js";

export const webSecurityHeaders = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
};
const invalidPath = () =>
  errorResponse(
    wireError(
      "validation_error",
      "The request path is invalid.",
      "Use a path inside the web bundle.",
    ),
  );
export function decodeWebPath(url: string) {
  const raw = url.split("?")[0] ?? "";
  const path = decodeURIComponent(raw);
  if (
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /%[a-f0-9]{2}/i.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Invalid web path");
  return path;
}
const reserved = (path: string) =>
  ["/v0", "/mcp", "/oauth", "/.well-known"].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
const inside = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix);
};
export function staticWeb(root: string | undefined) {
  return Effect.tryPromise({
    try: async () => {
      if (root === undefined) return undefined;
      const canonical = await realpath(resolve(root));
      if (!(await stat(canonical)).isDirectory()) throw new Error("Expected a web directory");
      const index = await realpath(resolve(canonical, "index.html"));
      if (!inside(canonical, index) || !(await stat(index)).isFile())
        throw new Error("Expected a web bundle index");
      return (url: string, method: string) =>
        Effect.tryPromise({
          try: async () => {
            let path: string;
            try {
              path = decodeWebPath(url);
            } catch {
              return invalidPath();
            }
            if (method !== "GET" || reserved(path)) return undefined;
            const target = resolve(canonical, `.${path}`);
            if (!inside(canonical, target)) return invalidPath();
            const file = async (candidate: string) => {
              const resolved = await realpath(candidate);
              if (!inside(canonical, resolved)) return invalidPath();
              if (!(await stat(resolved)).isFile()) return undefined;
              const bytes = await readFile(resolved);
              return HttpServerResponse.uint8Array(bytes, {
                headers: {
                  ...webSecurityHeaders,
                  "content-type": contentTypes[extname(resolved)] ?? "application/octet-stream",
                  "cache-control":
                    /[.-][a-zA-Z0-9_-]{8,}\.[a-z0-9]+$/.test(resolved) &&
                    extname(resolved) !== ".html"
                      ? "public, max-age=31536000, immutable"
                      : "no-cache",
                },
              });
            };
            try {
              const response = await file(target);
              if (response !== undefined) return response;
            } catch (error) {
              if (
                !(
                  error instanceof Error &&
                  "code" in error &&
                  (error.code === "ENOENT" || error.code === "ENOTDIR")
                )
              )
                throw error;
            }
            return await file(resolve(canonical, "index.html"));
          },
          catch: () =>
            wireError(
              "service_unavailable",
              "The web bundle could not be read.",
              "Check the web root and file permissions.",
            ),
        });
    },
    catch: () =>
      wireError(
        "service_unavailable",
        "The web root is unavailable.",
        "Pass an existing web bundle directory with --web-root.",
      ),
  });
}
