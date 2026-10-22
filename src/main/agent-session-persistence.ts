import { getAgentState, wasAgentReleased, isSessionMissing } from './agent-state';
import { mapSurfaces, stampClaudeSessionIds } from './claude-resume';
import { stampCodexSessionIds } from './codex-resume';
import { stampOpencodeSessionIds } from './opencode-resume';
import { stampAgySessionIds } from './agy-resume';
import { stampQwenSessionIds } from './qwen-resume';
import type { AgentSessionProvider } from './agent-state';
import { stampOmpSessionIds } from './omp-resume';
import { stampPiSessionIds } from './pi-resume';
import type { SurfaceId } from '../shared/types';

/**
 * The handle a provider keeps on save. Its own report wins; another provider's
 * report, or a deliberate exit, clears it; and silence keeps it — a restored
 * agent has not reported yet, and that is its recovery handle.
 */
function providerLookup(provider: AgentSessionProvider) {
  return (id: SurfaceId): string | null | undefined => {
    const agent = getAgentState(id);
    // An absent provider is Claude: that is what every report before #261 meant.
    if (agent?.sessionId && (agent.sessionProvider ?? 'claude') === provider) return agent.sessionId;
    // A nullable pi report means an explicit empty/ephemeral session, not
    // awaiting-report silence. It must clear the conversation just left.
    if (agent?.sessionId || agent?.sessionProvider === 'pi' || wasAgentReleased(id)) return null;
    return undefined;
  };
}

/**
 * Drop a saved Codex id that Codex said it cannot open. Silence keeps a
 * restored handle (above), so this is the one way such an id leaves — and only
 * when the id on disk is exactly the one Codex refused.
 */
function dropMissingCodexIds<T>(tree: T): T {
  return mapSurfaces(tree, surface => {
    const id = surface.codexSessionId;
    if (typeof id !== 'string' || !isSessionMissing(surface.id as SurfaceId, 'codex', id)) return surface;
    const rest = { ...surface };
    delete rest.codexSessionId;
    return rest;
  });
}

export function stampAgentSessionIds<T>(tree: T): T {
  const claude = stampClaudeSessionIds(tree, providerLookup('claude'));
  const codex = dropMissingCodexIds(stampCodexSessionIds(claude, providerLookup('codex')));
  const opencode = stampOpencodeSessionIds(codex, providerLookup('opencode'));
  const agy = stampAgySessionIds(opencode, providerLookup('agy'));
  const qwen = stampQwenSessionIds(agy, providerLookup('qwen'));
  const omp = stampOmpSessionIds(qwen, providerLookup('omp'));
  return stampPiSessionIds(omp, id => {
    // Read the pair from ONE snapshot. A declared different provider owns the
    // pane even if it currently has no persisted session of its own.
    const agent = getAgentState(id);
    if (agent?.sessionProvider === 'pi') {
      return agent.sessionId ? { sessionId: agent.sessionId, cwd: agent.piSessionCwd } : null;
    }
    if (agent?.sessionId || agent?.sessionProvider || wasAgentReleased(id)) return null;
    return undefined;
  });
}
