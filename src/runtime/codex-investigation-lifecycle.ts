import type { CodexJsonlTransport } from '../adapters/codex/protocol/stdio.js';
import type { InvestigationClaim, SqliteInvestigationStore } from '../adapters/storage/investigation-sqlite.js';

type JournalStore = Pick<SqliteInvestigationStore,
  'beginNativeThreadIntent' | 'observeNativeThread' | 'beginNativeTurnIntent' |
  'observeNativeTurn' | 'assertNativeTurnBinding' | 'acknowledgeNativeTurnInterrupt' |
  'observeNativeTurnTerminal'>;

/** A persisted intent precedes every native side effect; a lost response is never replayed. */
export async function startJournaledRestrictedThread(store: JournalStore, claim: InvestigationClaim,
  collaborationId: string, transport: CodexJsonlTransport,
  input: { cwd: string; profileId: string; model: string }, now: () => Date = () => new Date()): Promise<string> {
  store.beginNativeThreadIntent(claim, collaborationId, now());
  return transport.startRestrictedThread(input, id => store.observeNativeThread(claim, collaborationId, id));
}

/** The caller supplies a unique intent ID and must not reuse one after an ambiguous native call. */
export async function startJournaledRestrictedTurn(store: JournalStore, claim: InvestigationClaim,
  collaborationId: string, intentId: string, transport: CodexJsonlTransport,
  input: { threadId: string; profileId: string; text: string }, now: () => Date = () => new Date()): Promise<string> {
  store.beginNativeTurnIntent(claim, collaborationId, intentId, input.threadId, now());
  return transport.startRestrictedTurn(input, id => store.observeNativeTurn(claim, collaborationId, intentId, id, now()));
}

/** The acknowledgment is durable but does not prove the native turn or process has stopped. */
export async function interruptJournaledRestrictedTurn(store: JournalStore, claim: InvestigationClaim,
  collaborationId: string, intentId: string, transport: CodexJsonlTransport,
  threadId: string, turnId: string): Promise<void> {
  store.assertNativeTurnBinding(claim, collaborationId, intentId, threadId, turnId);
  await transport.interruptBoundTurn(threadId, turnId);
  store.acknowledgeNativeTurnInterrupt(claim, collaborationId, intentId, turnId);
}

/** Turn terminal is separate from process-tree termination and never releases an occupied slot. */
export function observeJournaledRestrictedTurnTerminal(store: JournalStore, claim: InvestigationClaim,
  collaborationId: string, intentId: string, transport: CodexJsonlTransport,
  threadId: string, turnId: string): boolean {
  store.assertNativeTurnBinding(claim, collaborationId, intentId, threadId, turnId);
  if (!transport.observedBoundTurnTerminal(threadId, turnId)) return false;
  store.observeNativeTurnTerminal(claim, collaborationId, intentId, turnId);
  return true;
}
