// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { sanitizeMailHtml } from "./mail-html";

const image = "data:image/png;base64,iVBORw0KGgo=";
const attachment = {
  attachment_id: "logo",
  content_id: "<logo@example.test>",
  content_type: "image/png",
  size: 8,
};

function body(html: string, options: Parameters<typeof sanitizeMailHtml>[1] = {}) {
  const result = sanitizeMailHtml(html, options);
  const document = new DOMParser().parseFromString(result.srcDoc, "text/html");
  return { ...result, document };
}

describe("mail HTML isolation", () => {
  test("removes executable elements, handlers, navigation and active embedded content", () => {
    const { document } = body(`
      <script>alert(1)</script><p onclick="alert(1)">Hello</p>
      <form action="https://tracker.test"><input name="secret"></form>
      <iframe src="https://tracker.test"></iframe><object data="https://tracker.test"></object>
      <embed src="https://tracker.test"><svg><script>alert(1)</script><a href="javascript:alert(1)">SVG</a></svg>
      <base href="https://tracker.test"><meta http-equiv="refresh" content="0;url=https://tracker.test">
      <link rel="stylesheet" href="https://tracker.test"><style>@import 'https://tracker.test';</style>
    `);
    expect(document.body.textContent).toContain("Hello");
    expect(
      document.body.querySelector("script,form,input,iframe,object,embed,svg,base,meta,link,style"),
    ).toBeNull();
    expect(document.body.querySelector("[onclick]")).toBeNull();
  });

  test("keeps only safe external links with an isolated new-tab target", () => {
    const { document } = body(`
      <a href="java&#x09;script:alert(1)" target="_top">Unsafe</a>
      <a href="data:text/html,attack">Data</a><a href="/v0/owner/status">Local</a>
      <a href="https://example.test/read" target="_self" rel="opener" ping="https://tracker.test">Read</a>
      <a href="mailto:person@example.test">Reply</a>
    `);
    const links = document.body.querySelectorAll("a");
    for (const link of Array.from(links).slice(0, 3)) expect(link.hasAttribute("href")).toBe(false);
    const safe = links[3];
    expect(safe?.getAttribute("href")).toBe("https://example.test/read");
    expect(safe?.getAttribute("target")).toBe("_blank");
    expect(safe?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(safe?.hasAttribute("ping")).toBe(false);
    expect(links[4]?.getAttribute("target")).toBe("_blank");
  });

  test("blocks remote images by default and restores only image URLs after explicit consent", () => {
    const html =
      '<img src="https://tracker.test/pixel"><img src="http://example.test/image"><img src="//example.test/protocol-relative">';
    const blocked = body(html);
    expect(blocked.remoteImages).toBe(3);
    expect(blocked.document.body.querySelector("[src]")).toBeNull();
    expect(
      blocked.document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content"),
    ).toContain("img-src data:;");
    const allowed = body(html, { loadRemoteImages: true });
    expect(Array.from(allowed.document.images, (image) => image.getAttribute("src"))).toEqual([
      "https://tracker.test/pixel",
      "http://example.test/image",
      "https://example.test/protocol-relative",
    ]);
    expect(allowed.document.images[0]?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(
      body('<img src="https://"><img src="https://user:secret@example.test">', {
        loadRemoteImages: true,
      }).document.body.querySelector("[src]"),
    ).toBeNull();
    expect(body(html).document.body.querySelector("[src]")).toBeNull();
  });

  test("resolves CID images only from this message's raster attachments", () => {
    const html =
      '<img src="cid:logo%40example.test"><img src="cid:other@example.test"><img src="cid:bad%ZZ">';
    const unresolved = body(html, { attachments: [attachment] });
    expect(unresolved.inlineAttachmentIds).toEqual(["logo"]);
    expect(unresolved.document.body.querySelector("[src]")).toBeNull();
    const resolved = body(html, {
      attachments: [attachment],
      inlineImages: new Map([["logo", image]]),
    });
    expect(resolved.document.images[0]?.getAttribute("src")).toBe(image);
    expect(resolved.document.images[1]?.hasAttribute("src")).toBe(false);
    expect(resolved.document.images[2]?.hasAttribute("src")).toBe(false);
    expect(resolved.remoteImages).toBe(0);
    expect(
      body(html, { inlineImages: new Map([["logo", image]]) }).document.body.querySelector("[src]"),
    ).toBeNull();
    expect(
      body(html, {
        attachments: [attachment],
        inlineImages: new Map([["logo", "https://tracker.test/image"]]),
      }).document.body.querySelector("[src]"),
    ).toBeNull();
    expect(
      body(html, {
        attachments: [{ ...attachment, content_type: "image/svg+xml" }],
        inlineImages: new Map([["logo", image]]),
      }).inlineAttachmentIds,
    ).toEqual([]);
  });

  test("allows raster data images but rejects SVG, HTML, blobs and script URLs", () => {
    const { document, remoteImages, blockedOtherContent } = body(`
      <img src="${image}" onerror="alert(1)">
      <img src="data:image/svg+xml;base64,PHN2Zz4=">
      <img src="data:text/html;base64,c2NyaXB0"><img src="blob:https://example.test/id">
      <img src="javascript:alert(1)">
    `);
    expect(document.body.querySelectorAll("img[src]")).toHaveLength(1);
    expect(document.images[0]?.getAttribute("src")).toBe(image);
    expect(document.images[0]?.hasAttribute("onerror")).toBe(false);
    expect(remoteImages).toBe(0);
    expect(blockedOtherContent).toBe(false);
  });

  test("strips resource-bearing CSS and image sets even after opting into images", () => {
    const html = `
      <div style="color:rgb(20,30,40);padding:12px;background-image:url(https://tracker.test/pixel);position:fixed">Hello</div>
      <p style="width:expression(alert(1));background:u\\72l(https://tracker.test/escaped)">Body</p>
      <img src="https://example.test/image" srcset="https://tracker.test/a 1x, https://tracker.test/b 2x">
      <table background="https://tracker.test/background"><tr><td>Table</td></tr></table>
    `;
    for (const loadRemoteImages of [false, true]) {
      const result = body(html, { loadRemoteImages });
      expect(result.blockedOtherContent).toBe(true);
      expect(result.document.body.querySelector("[srcset],[background]")).toBeNull();
      const style = result.document.body.querySelector("div")?.getAttribute("style");
      expect(style).toContain("padding:12px");
      expect(style).toContain("color:");
      expect(style).not.toMatch(/url|position|expression|tracker/);
      expect(result.document.body.querySelector("p")?.getAttribute("style")).not.toMatch(
        /url|expression|tracker/,
      );
    }
  });

  test("does not claim remote content was blocked in ordinary local HTML", () => {
    const result = body('<p style="color:#123456;padding:8px">Hello <strong>there</strong></p>');
    expect(result.remoteImages).toBe(0);
    expect(result.blockedOtherContent).toBe(false);
    expect(result.document.body.textContent).toBe("Hello there");
    expect(body("").document.body.textContent).toBe("");
    expect(body(`<p style="background-image:url(${image})">Local</p>`).blockedOtherContent).toBe(
      false,
    );
    expect(body(`<img srcset="${image} 1x">`).blockedOtherContent).toBe(false);
    expect(
      body(`<p style='background-image:image-set("${image}" 1x)'>Local</p>`).blockedOtherContent,
    ).toBe(false);
  });

  test("reports blocked external stylesheets and relative images", () => {
    expect(
      body("<style>p{background:url(https://tracker.test/pixel)}</style><p>Hello</p>")
        .blockedOtherContent,
    ).toBe(true);
    expect(body('<img src="/tracking-pixel">').blockedOtherContent).toBe(true);
    expect(
      body('<link rel="stylesheet" href="https://tracker.test/style">').blockedOtherContent,
    ).toBe(true);
  });
});
