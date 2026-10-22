import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Exercise the shipped command bodies without opening a real pipe or exporting
// implementation details from the CLI. Transpile, don't paraphrase, its TS.
const cli = fs.readFileSync(path.resolve(__dirname, '../../src/cli/wmux.ts'), 'utf8');
function command(name: string, send: (...args: any[]) => any) {
  const start = cli.indexOf(`'${name}': async (args: string[]) => {`);
  expect(start).toBeGreaterThan(-1);
  const body = cli.slice(start, cli.indexOf('\n  },', start) + 4);
  const source = ts.transpileModule(`const handler = ({${body}})['${name}'];`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const getFlag = (args: string[], flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  return new Function('sendV2', 'print', 'reportingSurface', 'getFlag', 'seqFlag', `${source}\nreturn handler;`)(
    send, () => {}, (args: string[]) => getFlag(args, '--surface'), getFlag, () => undefined,
  ) as (args: string[]) => Promise<void>;
}

describe('pi CLI session forwarding', () => {
  it.each(['session-A', ''])('reports %j as pi, including the explicit empty-session clear', async id => {
    const send = vi.fn(async () => ({ accepted: true }));
    await command('report-session', send)(['report-session', id, '--provider', 'pi', '--surface', 'surf-pi']);
    expect(send).toHaveBeenCalledWith('pane.report_agent_session', {
      surfaceId: 'surf-pi', seq: undefined, sessionId: id, provider: 'pi',
    });
  });

  it('forwards pi cwd as metadata, not shell text', async () => {
    const send = vi.fn(async () => ({ accepted: true }));
    const cwd = 'C:/worktrees/R&D $literal';
    await command('report-session', send)(['report-session', 'session-B', '--provider', 'pi', '--cwd', cwd, '--surface', 'surf-pi']);
    expect(send).toHaveBeenCalledExactlyOnceWith('pane.report_agent_session', {
      surfaceId: 'surf-pi', seq: undefined, sessionId: 'session-B', provider: 'pi', cwd,
    });
    expect(cli).toContain("value: ['--session', '--provider', '--cwd', '--seq', '--surface']");
  });

  it.each(['session-A', '', undefined])('releases only pi, forwarding exact optional session %j', async id => {
    const send = vi.fn(async () => ({ released: true }));
    const args = ['release-agent', '--provider', 'pi', '--surface', 'surf-pi'];
    if (id !== undefined) args.push('--session', id);
    await command('release-agent', send)(args);
    expect(send).toHaveBeenCalledExactlyOnceWith('pane.release_pi_session', {
      surfaceId: 'surf-pi', sessionId: id ?? null,
    });
  });
});
