import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { terminalNeedsTransparency } from '../../src/renderer/utils/terminal-theme';

const USE_TERMINAL = readFileSync(join(__dirname, '../../src/renderer/hooks/useTerminal.ts'), 'utf8');

describe('terminalNeedsTransparency', () => {
  it.each([
    undefined, '', '#123', '#123456', '#123f', '#123456ff', ' #ABCDEF ', '#ABCF', '#ABCDEFFF',
    'rgb(12, 12, 12)', 'rgba(12, 12, 12, 1)', 'rgba(12,12,12,1.0)',
  ])('keeps the opaque atlas for %s', (background) => {
    expect(terminalNeedsTransparency(background)).toBe(false);
  });

  it.each([
    '#1230', '#123e', '#12345600', '#123456fe',
    'rgba(12, 12, 12, 0)', 'rgba(12, 12, 12, 0.88)', 'rgba(12,12,12,.5)',
  ])('preserves alpha for %s', (background) => {
    expect(terminalNeedsTransparency(background)).toBe(true);
  });

  it.each([
    'transparent', 'rgb(12 12 12 / 50%)', 'hsl(0 0% 0% / .5)', 'var(--background)', 'rebeccapurple',
  ])('conservatively enables transparency for unrecognized CSS %s', (background) => {
    expect(terminalNeedsTransparency(background)).toBe(true);
  });
});

describe('useTerminal transparency wiring', () => {
  it('uses the effective initial colour instead of unconditional transparency', () => {
    expect(USE_TERMINAL).toContain("const initialBackground = withBgAlpha('#272822', bgAlpha)");
    expect(USE_TERMINAL).toContain('background: initialBackground');
    expect(USE_TERMINAL).toContain('allowTransparency: terminalNeedsTransparency(initialBackground)');
    expect(USE_TERMINAL).not.toMatch(/allowTransparency:\s*true/);
  });

  it('updates transparency before assigning the resolved theme', () => {
    expect(USE_TERMINAL).toContain('const theme = buildXtermTheme(base, userScheme, bgAlpha)');
    expect(USE_TERMINAL).toMatch(/term\.options\.allowTransparency = terminalNeedsTransparency\(theme\.background\);\s*term\.options\.theme = theme/);
    expect(USE_TERMINAL).toContain('cancelled || xtermRef.current !== term');
  });
});
