import createDOMPurify from "dompurify";
import type { Attachment } from "@inbot/contracts/src/attachments.js";

const rasterType = /^image\/(?:png|jpeg|gif|webp|avif)$/i;
const rasterData = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/]+={0,2}$/i;
const remoteUrl = /^https?:\/\//i;
const styleProperties = new Set([
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "text-align",
  "text-decoration",
  "vertical-align",
  "white-space",
  "border",
  "border-color",
  "border-width",
  "border-style",
  "border-collapse",
  "border-spacing",
  "border-radius",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "width",
  "max-width",
  "height",
  "max-height",
]);

function contentId(value: string) {
  return value.trim().replace(/^<|>$/g, "");
}

function imageUrl(value: string) {
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return remoteUrl.test(url.href) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function hasExternalCss(value: string) {
  const sources = Array.from(value.matchAll(/url\s*\(\s*([^)]*)\)/gi), (match) =>
    (match[1] ?? "").replace(/^["']|["']$/g, "").trim(),
  );
  if (/@import|image-set\s*\(/i.test(value))
    sources.push(...Array.from(value.matchAll(/["']([^"']+)["']/g), (match) => match[1] ?? ""));
  return sources.some((source) => source !== "" && !/^(?:data:|cid:)/i.test(source));
}

export function inlineImageAttachments(attachments: readonly Attachment[]) {
  return attachments.filter(
    (attachment) => attachment.content_id && rasterType.test(attachment.content_type ?? ""),
  );
}

function safeStyle(value: string, document: Document) {
  const style = document.createElement("span").style;
  style.cssText = value;
  const declarations: string[] = [];
  for (const property of style) {
    const value = style.getPropertyValue(property);
    const plain = value.replace(/(?:rgb|rgba|hsl|hsla)\([\d\s.,%/+-]+\)/gi, "");
    if (styleProperties.has(property) && /^[a-z\d\s#%,.+-]*$/i.test(plain))
      declarations.push(`${property}:${value}`);
  }
  return declarations.join(";");
}

export function sanitizeMailHtml(
  html: string,
  options: {
    attachments?: readonly Attachment[];
    inlineImages?: ReadonlyMap<string, string>;
    loadRemoteImages?: boolean;
  } = {},
) {
  const purifier = createDOMPurify(window);
  const attachments = new Map(
    inlineImageAttachments(options.attachments ?? []).map((attachment) => [
      contentId(attachment.content_id ?? ""),
      attachment,
    ]),
  );
  const inlineAttachmentIds = new Set<string>();
  let remoteImages = 0;
  let blockedOtherContent = false;
  purifier.addHook("uponSanitizeElement", (node) => {
    if (node.nodeName === "STYLE" && hasExternalCss(node.textContent ?? ""))
      blockedOtherContent = true;
    if (node instanceof Element && node.nodeName === "LINK") {
      const href = node.getAttribute("href");
      if (href && !/^(?:data:|cid:)/i.test(href)) blockedOtherContent = true;
    }
  });
  purifier.addHook("uponSanitizeAttribute", (node, attribute) => {
    const value = attribute.attrValue.trim();
    if (attribute.attrName === "style") {
      if (hasExternalCss(value)) blockedOtherContent = true;
      attribute.attrValue = safeStyle(value, node.ownerDocument);
    }
    if (attribute.attrName === "background" || attribute.attrName === "srcset") {
      if (value && (!/^(?:data:|cid:)/i.test(value) || /(?:^|[\s,])(?:https?:)?\/\//i.test(value)))
        blockedOtherContent = true;
      attribute.keepAttr = false;
    }
    if (attribute.attrName === "src" && node.nodeName === "IMG") {
      let source: string | undefined;
      if (/^cid:/i.test(value)) {
        let id = value.slice(4);
        try {
          id = decodeURIComponent(id);
        } catch {
          attribute.keepAttr = false;
          return;
        }
        const attachment = attachments.get(contentId(id));
        if (attachment) {
          inlineAttachmentIds.add(attachment.attachment_id);
          const inline = options.inlineImages?.get(attachment.attachment_id);
          if (inline && rasterData.test(inline)) source = inline;
        }
      } else if (remoteUrl.test(value) || value.startsWith("//")) {
        remoteImages += 1;
        if (options.loadRemoteImages) source = imageUrl(value);
      } else if (rasterData.test(value)) {
        source = value;
      } else if (value && !/^(?:data:|javascript:|blob:)/i.test(value)) {
        blockedOtherContent = true;
      }
      if (source && (rasterData.test(source) || remoteUrl.test(source)))
        attribute.attrValue = source;
      else attribute.keepAttr = false;
    }
    if (attribute.attrName === "href" && !/^(?:https?:\/\/|mailto:)/i.test(value))
      attribute.keepAttr = false;
  });
  purifier.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (node.nodeName === "IMG") node.setAttribute("referrerpolicy", "no-referrer");
  });
  const clean = purifier.sanitize(html, {
    ALLOWED_TAGS: [
      "a",
      "abbr",
      "b",
      "blockquote",
      "br",
      "caption",
      "code",
      "col",
      "colgroup",
      "dd",
      "del",
      "div",
      "dl",
      "dt",
      "em",
      "font",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "i",
      "img",
      "li",
      "ol",
      "p",
      "pre",
      "s",
      "small",
      "span",
      "strong",
      "sub",
      "sup",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tfoot",
      "tr",
      "u",
      "ul",
    ],
    ALLOWED_ATTR: [
      "alt",
      "title",
      "href",
      "src",
      "style",
      "width",
      "height",
      "align",
      "valign",
      "colspan",
      "rowspan",
      "cellpadding",
      "cellspacing",
      "border",
      "color",
      "face",
      "size",
      "dir",
      "lang",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORCE_BODY: true,
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:|data:image\/(?:png|jpeg|gif|webp|avif);base64,)/i,
    RETURN_DOM_FRAGMENT: true,
  });
  const container = document.createElement("div");
  container.append(clean);
  // srcdoc inherits the host CSP; only explicit consent allows network image protocols here.
  const imagePolicy = options.loadRemoteImages ? "data: https: http:" : "data:";
  const csp = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${imagePolicy}; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'`;
  return {
    inlineAttachmentIds: Array.from(inlineAttachmentIds),
    remoteImages,
    blockedOtherContent,
    srcDoc: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>
html { color-scheme: light; background: #faf9f6; color: #1f2024; }
body { margin: 16px; font: 16px/1.6 Georgia, serif; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; } table { max-width: 100%; }
pre { white-space: pre-wrap; } a { color: #0b6f78; }
a:focus-visible { outline: 2px solid #0b6f78; outline-offset: 3px; }
</style></head><body>${container.innerHTML}</body></html>`,
  };
}
