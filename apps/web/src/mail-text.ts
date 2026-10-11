export function hasQuotedText(text: string | undefined, extractedText: string | undefined) {
  if (text === undefined || extractedText === undefined) return false;
  const full = text.replace(/\s+/g, " ").trim();
  const extracted = extractedText.replace(/\s+/g, " ").trim();
  return full.length > extracted.length;
}
