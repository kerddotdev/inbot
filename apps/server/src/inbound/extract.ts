import {
  extractFromHtml,
  extractNewContent,
  isTrueDsn,
  stripNoise,
  stripNoiseHtml,
} from "agentextract/body";

const hungarianText = /^[^\r\n]{1,200}\bnapon\b[^\r\n]{1,200}\bezt [i\u00ed]rta:[ \t]*$/im;
const hungarianHtml = /[^<>\r\n]{1,200}\bnapon\b[^<>\r\n]{1,200}\bezt [i\u00ed]rta:[ \t]*(?=<|$)/i;

function withHungarianAttribution(
  body: string,
  pattern: RegExp,
  extract: (body: string) => string,
) {
  const attribution = body.match(pattern)?.[0];
  if (attribution === undefined) return extract(body);
  const signal = `On ${attribution} wrote:`;
  return extract(body.replace(attribution, signal)).replace(signal, attribution);
}

function cutTrailingQuote(text: string) {
  if (isTrueDsn(text)) return text;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimStart().startsWith(">"));
  if (
    start < 0 ||
    !lines.slice(start).every((line) => !line.trim() || line.trimStart().startsWith(">"))
  )
    return text;
  return lines.slice(0, start).join("\n").trim();
}

export function extractInbound(input: { readonly text?: string; readonly html?: string }) {
  const result: { extracted_text?: string; extracted_html?: string } = {};
  if (input.text !== undefined)
    result.extracted_text = cutTrailingQuote(
      stripNoise(withHungarianAttribution(input.text, hungarianText, extractNewContent)),
    );
  if (input.html !== undefined) {
    result.extracted_html = stripNoiseHtml(
      withHungarianAttribution(input.html, hungarianHtml, extractFromHtml),
    );
  }
  return result;
}
