/**
 * Code points that repository-controlled text (file names, variable names, paths) must not carry
 * into terminal output, JSON or generated files: they can rewrite the terminal, hide text, or
 * visually reorder it (Trojan Source). Written as numbers so no invisible characters live here.
 */
export function isUnsafeCodePoint(code: number, options: { allowNewline?: boolean } = {}): boolean {
  if (code === 0x0a) return options.allowNewline !== true;
  return (
    code <= 0x1f || // C0 controls (including tab, CR, ESC)
    (code >= 0x7f && code <= 0x9f) || // DEL and C1 controls (including NEL and CSI)
    code === 0x00ad || // soft hyphen
    code === 0x061c || // Arabic letter mark (bidi)
    code === 0x180e || // Mongolian vowel separator
    (code >= 0x200b && code <= 0x200f) || // zero-width space/joiners, LRM, RLM
    (code >= 0x2028 && code <= 0x202e) || // line/paragraph separators, bidi embeddings and overrides
    (code >= 0x2060 && code <= 0x2064) || // word joiner and invisible operators
    (code >= 0x2066 && code <= 0x2069) || // bidi isolates
    code === 0xfeff || // zero-width no-break space / byte-order mark
    (code >= 0xfff9 && code <= 0xfffb) || // interlinear annotation controls
    (code >= 0xd800 && code <= 0xdfff) || // lone surrogates (paired ones arrive as one code point)
    (code >= 0xe0000 && code <= 0xe007f) // tag characters
  );
}
