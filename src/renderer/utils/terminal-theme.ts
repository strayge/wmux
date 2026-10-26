/**
 * Keep an opaque glyph atlas for opaque terminal backgrounds. A transparent
 * atlas forces grayscale text AA on Windows even in an otherwise opaque window.
 * Inspect the RESOLVED colour, not the window toggle: custom backgrounds and
 * per-pane theme alpha can need transparency independently of that toggle.
 *
 * Hex and comma-separated rgb(a) cover bundled themes and withBgAlpha's output.
 * Preserve the old transparent behaviour for other CSS spellings rather than
 * risk flattening a user colour whose alpha we do not understand.
 */
export function terminalNeedsTransparency(background: string | undefined): boolean {
  if (!background) return false; // xterm's default background is opaque.
  const value = background.trim();
  const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value)?.[1];
  if (hex) {
    if (hex.length === 4) return hex[3].toLowerCase() !== 'f';
    if (hex.length === 8) return hex.slice(6).toLowerCase() !== 'ff';
    return false;
  }
  const rgb = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i.exec(value);
  if (rgb) return Number(rgb[1] ?? 1) < 1;
  return true;
}
