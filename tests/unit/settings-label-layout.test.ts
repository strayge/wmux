// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('lets settings descriptions shrink and wrap while reserving the checkbox width', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync(join(__dirname, '../../src/renderer/styles/settings.css'), 'utf8');
  document.head.append(style);
  const row = document.createElement('div');
  row.className = 'settings-row';
  row.innerHTML = '<label class="settings-label">Agent instructions<span class="settings-hint">~/.config/opencode/AGENTS.md</span></label><input type="checkbox" class="settings-toggle">';
  document.body.append(row);

  try {
    const label = getComputedStyle(row.querySelector('.settings-label')!);
    expect(label.flexShrink).not.toBe('0');
    expect(label.overflowWrap).toBe('anywhere');
    const checkbox = getComputedStyle(row.querySelector('.settings-toggle')!);
    expect(checkbox.flexShrink).toBe('0');
    expect(checkbox.width).toBe('36px');
  } finally {
    row.remove();
    style.remove();
  }
});
