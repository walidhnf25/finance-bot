/**
 * Split a message that lists several items ("beli ayam 8rb, beli es teh 5rb") into
 * its parts. Separators are commas, semicolons and line breaks. A comma between two
 * digits is a decimal comma ("1,5jt") and never splits.
 */
export function splitSegments(text: string): string[] {
  return text
    .split(/[\n;]|(?<!\d),|,(?!\d)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}
