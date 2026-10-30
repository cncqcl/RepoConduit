import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { mock, test } from 'node:test';
import type { InvestigationClaim, RunningReadBinding, SqliteInvestigationStore } from
  '../../src/adapters/storage/investigation-sqlite.js';
import { createClaudeModelOuterTickets } from '../../src/runtime/claude-model-outer-tickets.js';
import { createClaudeModelRunningTickets } from '../../src/runtime/claude-model-running-tickets.js';
import { ClaudeModelOriginalOwnerError, runClaudeModelOriginalOwner } from
  '../../src/runtime/claude-model-original-owner.js';
import { syntheticCurrentOuterFact } from '../fixtures/claude-model-current-outer.js';
import { claudeModelCommandDigest } from
  '../../src/adapters/secondary-investigator/claude-model-supervisor.js';

const stem = 'tests/fixtures/legacy-runtime/outer-observer';
function fixture() {
  const meta = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
  const resource = {...meta.running.resource, invocationId: null, controlGroup: null};
  const claim: InvestigationClaim = {requestId: 'request', attemptId: meta.descriptor.attemptId,
    workspaceId: meta.descriptor.workspaceId, workerId: 'worker', workerEpoch: 1,
    phase: 'start_intent', nativeRef: null, launchProtocol: 'resource_reservation_v1', wslResource: resource};
  const binding: RunningReadBinding = {collaborationId: 'col', workingCopyId: 'wc', snapshotId: 'snap',
    paths: ['src/a.ts'], workerGrantId: 'worker-read', workerAudience: 'investigator', workerRecipient: 'local'};
  const events: string[] = [];
  let finish!: (value: unknown) => void;
  const handle = {ready: Promise.resolve(meta.startup), closed: new Promise(resolve => {finish = resolve;}),
    writePrompt: async () => {events.push('write');}, closeBridge: async () => {events.push('bridge-close'); return {
      bridgeExitCode: null, stdout: null, stderrBytes: 0, uncertain: true};}};
  const tickets = createClaudeModelOuterTickets();
  const runningTickets = createClaudeModelRunningTickets();
  const started = {...claim, phase: 'started' as const, nativeRef: 'native-owned',
    wslResource: meta.running.resource};
  const now = new Date();
  const store = {
    get: () => ({id: claim.requestId, workspaceId: claim.workspaceId, collaborationId: binding.collaborationId,
      workingCopyId: binding.workingCopyId, snapshotRef: binding.snapshotId,
      scope: {paths: ['src/a.ts'], relatedTests: []}, budget: {maxWallSeconds: 20, maxTurns: 3},
      attempts: [{id: claim.attemptId, startedAt: now.toISOString()}]}),
    listUnsettled: () => [started],
    preflightClaudeModelLaunch: () => {events.push('preflight');},
    assertRunningReadAuthority: () => {events.push('authority');},
    getModelRunningObservation: () => meta.running,
    recordModelOuterFact: (c: InvestigationClaim, b: RunningReadBinding, fact: unknown, receipt: string) => {
      assert.equal(tickets.verifyOuter(c, c.wslResource!, fact as never, receipt), true);
      assert.deepEqual(b, binding); events.push('fact');
    },
    recordModelPromptIntent: (c: InvestigationClaim, b: RunningReadBinding, l: unknown, hash: string,
      at: Date, receipt: string) => { assert.equal(tickets.verifyPromptWindow(c, meta.fact!, receipt, 'intent'), true);
      assert.ok(at instanceof Date); assert.ok(hash); assert.ok(l); assert.deepEqual(b, binding);
      events.push('intent'); },
    assertModelPromptSendAuthority: (c: InvestigationClaim, b: RunningReadBinding, l: unknown,
      hash: string, at: Date, receipt: string) => {
      assert.equal(tickets.verifyPromptWindow(c, meta.fact!, receipt, 'send'), true);
      assert.ok(at instanceof Date); assert.ok(hash); assert.ok(l); assert.deepEqual(b, binding);
      events.push('send-fence'); },
    markRecoveryRequired: () => {events.push('recovery'); return started;},
  };
  const ports = {
    prepare: async () => {events.push('fifo-prepare'); return {directory: meta.paths.privateFifoDirectory};},
    operation: async (op: string) => {events.push(op); return op === 'prepare' ? {...meta.running.journal,
      phase: 'prepared', invocationId: undefined, controlGroup: undefined,
      enterPid: undefined, enterStartTicks: undefined} : op === 'release' ?
      {...meta.startup.journal, phase: 'released'} : op === 'status' && !events.includes('release') ?
      meta.running.journal : meta.startup.journal;},
    start: () => {events.push('start'); return handle;},
    persist: async () => {events.push('persist'); return started;},
    attach: async () => {events.push('fifo-attach'); return {closed: new Promise<void>(() => {}),
      closeTransport: async () => {events.push('transport-close');}};},
    observe: async () => {events.push('observe'); return meta.fact!.observation;},
  };
  meta.fact = syntheticCurrentOuterFact({kind: 'model_outer_confined_v1', networkMode: 'host_shared_pre_srt', srtState: 'not_started',
    expectation: {descriptor: meta.descriptor, paths: meta.paths, profile: meta.profile,
      profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 }},
    observation: {kind: 'outer_journal_candidate', journalAfter: meta.startup.journal,
      candidate: {kind: 'outer_probe_candidate', running: meta.running, startup: meta.startup,
        probe: JSON.parse(readFileSync(`${stem}.raw.json`, 'utf8'))}}}, 3);
  meta.descriptor = meta.fact.expectation.descriptor;
  meta.running = meta.fact.observation.candidate.running;
  meta.startup = meta.fact.observation.candidate.startup;
  handle.ready = Promise.resolve(meta.startup);
  resource.gate.launch.commandDigest = meta.descriptor.commandDigest;
  started.wslResource = meta.running.resource;
  return {meta, claim, binding, events, handle, finish, tickets, runningTickets,
    started, store: store as unknown as SqliteInvestigationStore, ports};
}

test('synthetic original owner sequences pre-release steps and one-use fenced send', async () => {
  const f = fixture();
  const owner = await runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
    runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never);
  assert.deepEqual(f.events.filter(e => ['fifo-prepare','prepare','start','persist','fifo-attach','release','observe','fact'].includes(e)),
    ['fifo-prepare','prepare','start','persist','fifo-attach','release','observe','fact']);
  const bytes = Buffer.from('synthetic prompt');
  const hash = createHash('sha256').update(bytes).digest('hex');
  await owner.sendPrompt(bytes, hash);
  assert.deepEqual(f.events.slice(-3), ['intent','send-fence','write']);
  await assert.rejects(owner.sendPrompt(bytes, hash));
  await owner.close();
  assert.ok(f.events.includes('recovery'));
  assert.ok(f.events.includes('transport-close'));
  assert.ok(f.events.includes('bridge-close'));
});

test('original owner refuses a historical parent program as a fresh observation', async () => {
  const f=fixture();
  const frozen=JSON.parse(readFileSync(`${stem}.raw.json`,'utf8'));
  f.meta.fact.observation.candidate.probe.processes.parent.cmdline=
    frozen.processes.parent.cmdline;
  await assert.rejects(runClaudeModelOriginalOwner({claim:f.claim,store:f.store,
    binding:f.binding,descriptor:f.meta.descriptor,paths:f.meta.paths,profile:f.meta.profile,
    profileRevision:'fixture-revision',limits:{ maxWallSeconds: 20, maxTurns: 3 },
    runningTickets:f.runningTickets,outerTickets:f.tickets,
    dispatcher:{dispatch:async()=>{throw new Error('unused');}} as never},f.ports as never));
  assert.equal(f.events.includes('fact'),false);
  assert.equal(f.events.includes('recovery'),true);
});

test('authorization revoked during prepare prevents original native start', async () => {
  const f = fixture();
  let checked = 0;
  f.store.preflightClaudeModelLaunch = () => {
    f.events.push('preflight');
    if (++checked === 2) throw new Error('revoked');
  };
  await assert.rejects(runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
    runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never));
  assert.equal(checked, 2);
  assert.equal(f.events.includes('start'), false);
});

test('final send fence abort prevents original handle write', async () => {
  const f = fixture();
  const controller = new AbortController();
  const original = f.store.assertModelPromptSendAuthority.bind(f.store);
  f.store.assertModelPromptSendAuthority = (...args) => {original(...args); controller.abort();};
  const owner = await runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 }, signal: controller.signal,
    runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never);
  const bytes = Buffer.from('synthetic prompt');
  await assert.rejects(owner.sendPrompt(bytes, createHash('sha256').update(bytes).digest('hex')));
  assert.equal(f.events.includes('write'), false);
  assert.ok(f.events.includes('recovery'));
});

test('async prepare cannot replace fixed profile revision or dispatcher', async () => {
  const f = fixture();
  const dispatcher = {dispatch: async () => {throw new Error('original dispatcher');}} as never;
  const input = {claim: f.claim, store: f.store, binding: f.binding,
    descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
    runningTickets: f.runningTickets, outerTickets: f.tickets, dispatcher};
  f.ports.prepare = async () => {
    input.profileRevision = 'attacker-revision';
    input.dispatcher = {dispatch: async () => {throw new Error('replaced');}} as never;
    return {directory: f.meta.paths.privateFifoDirectory};
  };
  f.ports.persist = (async (actual: {profileRevision: string}) => {
    assert.equal(actual.profileRevision, 'fixture-revision'); return f.started;
  }) as never;
  f.ports.attach = (async (actual: {dispatcher: unknown}) => {
    assert.equal(actual.dispatcher, dispatcher);
    return {closed: new Promise<void>(() => {}), closeTransport: async () => {}};
  }) as never;
  const owner = await runClaudeModelOriginalOwner(input, f.ports as never);
  await owner.close();
});

test('expired owner window never invokes release', async () => {
  const f = fixture();
  const begin = f.tickets.beginOwner.bind(f.tickets);
  f.tickets.beginOwner = (...args) => {
    const owner = begin(...args);
    return {...owner, get deadline() {return performance.now() - 1;}};
  };
  await assert.rejects(runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
    runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never));
  assert.equal(f.events.includes('release'), false);
});

test('late release is aborted once and cannot publish a late outer fact', async () => {
  const f = fixture();
  const begin = f.tickets.beginOwner.bind(f.tickets);
  f.tickets.beginOwner = (...args) => {
    const owner = begin(...args);
    return {...owner, get deadline() {return performance.now() + 5;}};
  };
  const operation = f.ports.operation;
  let releaseSignal: AbortSignal | undefined;
  f.ports.operation = (async (op: string, ...args: unknown[]) => {
    if (op !== 'release') return operation(op);
    f.events.push('release');
    releaseSignal = args[3] as AbortSignal;
    return new Promise(() => {});
  }) as never;
  await assert.rejects(runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
    runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never));
  assert.equal(f.events.filter(event => event === 'release').length, 1);
  assert.equal(releaseSignal?.aborted, true);
  assert.equal(f.events.includes('observe'), false);
  assert.equal(f.events.includes('fact'), false);
  assert.ok(f.events.includes('recovery'));
});

test('release started synchronously across deadline is cancelled and late rejection is absorbed', async () => {
  const f = fixture();
  const begin = f.tickets.beginOwner.bind(f.tickets);
  let deadline = 0;
  f.tickets.beginOwner = (...args) => {
    const owner = begin(...args);
    deadline = performance.now() + 100;
    return {...owner, get deadline() {return deadline;}};
  };
  const operation = f.ports.operation;
  let releaseSignal: AbortSignal | undefined;
  let lateReject!: (reason: Error) => void;
  let clockMock: ReturnType<typeof mock.method> | undefined;
  f.ports.operation = (async (op: string, ...args: unknown[]) => {
    if (op !== 'release') return operation(op);
    f.events.push('release');
    releaseSignal = args[3] as AbortSignal;
    clockMock = mock.method(performance, 'now', () => deadline + 1);
    return new Promise((_, reject) => {lateReject = reject;});
  }) as never;
  try {
    await assert.rejects(runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
      binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
      profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
      runningTickets: f.runningTickets, outerTickets: f.tickets,
      dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never));
    assert.equal(releaseSignal?.aborted, true);
    assert.equal(f.events.filter(event => event === 'release').length, 1);
    assert.equal(f.events.includes('observe'), false);
    assert.equal(f.events.includes('fact'), false);
    lateReject(new Error('late native rejection'));
    await Promise.resolve();
  } finally {clockMock?.mock.restore();}
});

test('concurrent close waits for the same pending transport cleanup and marks recovery once', async () => {
  const f = fixture();
  let finishTransport!: () => void;
  f.ports.attach = async () => ({closed: new Promise<void>(() => {}),
    closeTransport: () => {f.events.push('transport-close'); return new Promise<void>(resolve => {
      finishTransport = resolve;
    });}});
  const owner = await runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
    runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never);
  const first = owner.close();
  const second = owner.close();
  assert.equal(first, second);
  let firstDone = false; let secondDone = false;
  void first.then(() => {firstDone = true;});
  void second.then(() => {secondDone = true;});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(firstDone, false);
  assert.equal(secondDone, false);
  assert.equal(f.events.filter(event => event === 'recovery').length, 1);
  finishTransport();
  await Promise.all([first, second]);
  assert.equal(firstDone, true);
  assert.equal(secondDone, true);
});

test('failed prompt write retains durable intent and recovery slot', async () => {
  const f = fixture();
  f.handle.writePrompt = async () => {f.events.push('write'); throw new Error('broken');};
  const owner = await runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
    runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never);
  const bytes = Buffer.from('synthetic prompt');
  await assert.rejects(owner.sendPrompt(bytes, createHash('sha256').update(bytes).digest('hex')));
  assert.equal(await owner.readNativeOutcomeCandidate(), null);
  assert.ok(f.events.includes('intent'));
  assert.ok(f.events.includes('recovery'));
  assert.ok(f.events.includes('transport-close'));
  assert.ok(f.events.includes('bridge-close'));
  await assert.rejects(owner.sendPrompt(bytes, createHash('sha256').update(bytes).digest('hex')));
});

test('wrong command commitment rejects before FIFO or native start', async () => {
  const f = fixture();
  await assert.rejects(runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: {...f.meta.descriptor, commandDigest: '0'.repeat(64)},
    paths: f.meta.paths, profile: f.meta.profile, profileRevision: 'fixture-revision',
    limits: { maxWallSeconds: 20, maxTurns: 3 }, runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never));
  assert.equal(f.events.includes('fifo-prepare'), false);
  assert.equal(f.events.includes('start'), false);
});

test('owner rejects missing, invalid, or budget-mismatched cap before preparation', async () => {
  for (const cap of [undefined, 0, 1, 2, 8, 9, 1.5]) {
    const f = fixture();
    await assert.rejects(runClaudeModelOriginalOwner({claim:f.claim,store:f.store,
      binding:f.binding,descriptor:f.meta.descriptor,paths:f.meta.paths,profile:f.meta.profile,
      profileRevision:'fixture-revision',limits:{maxWallSeconds:20,maxTurns:cap} as never,
      runningTickets:f.runningTickets,outerTickets:f.tickets,
      dispatcher:{dispatch:async()=>{throw new Error('unused');}} as never},f.ports as never));
    assert.equal(f.events.includes('fifo-prepare'),false);
    assert.equal(f.events.includes('start'),false);
  }
  const f=fixture();
  await assert.rejects(runClaudeModelOriginalOwner({claim:f.claim,store:f.store,
    binding:f.binding,descriptor:f.meta.descriptor,paths:f.meta.paths,profile:f.meta.profile,
    profileRevision:'fixture-revision',limits:{maxWallSeconds:20,maxTurns:3,extra:true} as never,
    runningTickets:f.runningTickets,outerTickets:f.tickets,
    dispatcher:{dispatch:async()=>{throw new Error('unused');}} as never},f.ports as never));
  assert.equal(f.events.includes('fifo-prepare'),false);
});

test('owner rejects a cap matching the launch digest but not the durable budget', async () => {
  const f=fixture();
  const commandDigest=claudeModelCommandDigest(f.meta.paths,f.meta.profile,2);
  f.claim.wslResource!.gate!.launch!.commandDigest=commandDigest;
  const descriptor={...f.meta.descriptor,commandDigest};
  await assert.rejects(runClaudeModelOriginalOwner({claim:f.claim,store:f.store,
    binding:f.binding,descriptor,paths:f.meta.paths,profile:f.meta.profile,
    profileRevision:'fixture-revision',limits:{maxWallSeconds:20,maxTurns:2},
    runningTickets:f.runningTickets,outerTickets:f.tickets,
    dispatcher:{dispatch:async()=>{throw new Error('unused');}} as never},f.ports as never));
  assert.equal(f.events.includes('fifo-prepare'),false);
  assert.equal(f.events.includes('start'),false);
});

test('failed FIFO attach never releases original unit and keeps recovery required', async () => {
  const f = fixture();
  f.ports.attach = async () => {f.events.push('fifo-attach'); throw new Error('private attach secret');};
  await assert.rejects(runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
    runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never),
  error => {assert.ok(error instanceof ClaudeModelOriginalOwnerError);
    assert.equal(error.stage, 'fifo_attach');
    assert.equal(error.message, 'MODEL_ORIGINAL_OWNER_UNAVAILABLE');
    assert.equal('cause' in error, false);
    assert.equal(JSON.stringify(error).includes('private attach secret'), false); return true;});
  assert.equal(f.events.includes('release'), false);
  assert.ok(f.events.includes('recovery'));
  assert.ok(f.events.includes('bridge-close'));
});

test('safe stage distinguishes failed release without exposing native error', async () => {
  const f = fixture();
  const operation = f.ports.operation;
  f.ports.operation = (async (op: string) => {
    if (op === 'release') throw new Error('private release secret');
    return operation(op);
  }) as never;
  await assert.rejects(runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
    runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never),
  error => {assert.ok(error instanceof ClaudeModelOriginalOwnerError);
    assert.equal(error.stage, 'release');
    assert.equal(error.message, 'MODEL_ORIGINAL_OWNER_UNAVAILABLE');
    assert.equal('cause' in error, false);
    assert.equal(JSON.stringify(error).includes('private release secret'), false); return true;});
});

test('safe stage distinguishes failed outer observation without exposing raw error', async () => {
  const f = fixture();
  f.ports.observe = async () => {throw new Error('private probe secret');};
  await assert.rejects(runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
    runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never),
  error => {assert.ok(error instanceof ClaudeModelOriginalOwnerError);
    assert.equal(error.stage, 'outer_observation');
    assert.equal(error.message, 'MODEL_ORIGINAL_OWNER_UNAVAILABLE');
    assert.equal('cause' in error, false);
    assert.equal(JSON.stringify(error).includes('private probe secret'), false); return true;});
});

test('invalid prompt consumes send entry and closes without native write', async () => {
  const f = fixture();
  const owner = await runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
    runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never}, f.ports as never);
  const bytes = Buffer.from('synthetic prompt');
  await assert.rejects(owner.sendPrompt(bytes, '0'.repeat(64)));
  await assert.rejects(owner.sendPrompt(bytes, createHash('sha256').update(bytes).digest('hex')));
  assert.equal(f.events.includes('write'), false);
  assert.ok(f.events.includes('recovery'));
});

function runFixture(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
  return runClaudeModelOriginalOwner({claim: f.claim, store: f.store,
    binding: f.binding, descriptor: f.meta.descriptor, paths: f.meta.paths, profile: f.meta.profile,
    profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20, maxTurns: 3 },
    runningTickets: f.runningTickets, outerTickets: f.tickets,
    dispatcher: {dispatch: async () => {throw new Error('unused');}} as never,
    ...(signal ? {signal} : {})}, f.ports as never);
}

const prompt = Buffer.from('synthetic prompt');
const promptHash = createHash('sha256').update(prompt).digest('hex');
const nativeSuccess = Buffer.from(JSON.stringify({type: 'result', subtype: 'success',
  is_error: false, num_turns: 2, result: 'Scoped finding', session_id: 'discard-me'}));

test('native candidate requires successful original send and binds only trusted owner fields', async () => {
  const f = fixture();
  const owner = await runFixture(f);
  assert.equal(await owner.readNativeOutcomeCandidate(), null);
  await owner.sendPrompt(prompt, promptHash);
  const pending = owner.readNativeOutcomeCandidate();
  const source = Buffer.from(nativeSuccess);
  f.finish({bridgeExitCode: 0, stdout: source, stderrBytes: 0, uncertain: false});
  const candidate = await pending;
  source.fill(0);
  assert.deepEqual(candidate, {kind: 'claude_model_original_owner_candidate_v1',
    requestId: f.claim.requestId, attemptId: f.claim.attemptId,
    workspaceId: f.claim.workspaceId, workerEpoch: f.claim.workerEpoch,
    nativeRef: f.started.nativeRef, promptHash,
    commandDigest: f.meta.descriptor.commandDigest,
    formatContract: 'claude_print_json_sdk_0_3_284',
    result: 'Scoped finding', numTurns: 2,
    rawBytesSha256: createHash('sha256').update(nativeSuccess).digest('hex')});
  assert.equal('resultState' in candidate!, false);
  assert.equal('toolReceipt' in candidate!, false);
  assert.equal(JSON.stringify(candidate).includes('discard-me'), false);
  assert.equal(await owner.readNativeOutcomeCandidate(), null);
  assert.equal(f.events.includes('recovery'), false);
  await owner.close();
});

test('native candidate rejects a changed durable turn cap after original launch', async () => {
  const f=fixture();const owner=await runFixture(f);
  await owner.sendPrompt(prompt,promptHash);
  const get=f.store.get.bind(f.store);
  f.store.get=(...args)=>{
    const record=get(...args)!;
    return {...record,budget:{...record.budget,maxTurns:2}};
  };
  const pending=owner.readNativeOutcomeCandidate();
  f.finish({bridgeExitCode:0,stdout:nativeSuccess,stderrBytes:0,uncertain:false});
  assert.equal(await pending,null);
  await owner.close();
});

test('native candidate remains readable after send window ends within original wall budget', async () => {
  const f = fixture(); const owner = await runFixture(f);
  await owner.sendPrompt(prompt, promptHash);
  const advanced = performance.now() + 6_000;
  const clock = mock.method(performance, 'now', () => advanced);
  try {
    const pending = owner.readNativeOutcomeCandidate();
    f.finish({bridgeExitCode: 0, stdout: nativeSuccess, stderrBytes: 0, uncertain: false});
    const candidate = await pending;
    assert.equal(candidate?.result, 'Scoped finding');
    assert.equal(candidate?.promptHash, promptHash);
  } finally {clock.mock.restore(); await owner.close();}
});

test('native candidate refuses uncertain, failed and malformed bridge outcomes', async () => {
  for (const outcome of [
    {bridgeExitCode: 1, stdout: nativeSuccess, stderrBytes: 0, uncertain: false},
    {bridgeExitCode: 0, stdout: nativeSuccess, stderrBytes: 0, uncertain: true},
    {bridgeExitCode: 0, stdout: Buffer.from('{'), stderrBytes: 0, uncertain: false},
  ]) {
    const f = fixture(); const owner = await runFixture(f);
    await owner.sendPrompt(prompt, promptHash);
    const pending = owner.readNativeOutcomeCandidate();
    f.finish(outcome);
    assert.equal(await pending, null);
    await owner.close();
  }
});

test('close and cancellation while waiting refuse a late native candidate', async () => {
  for (const cancel of [false, true]) {
    const f = fixture(); const controller = new AbortController();
    const owner = await runFixture(f, controller.signal);
    await owner.sendPrompt(prompt, promptHash);
    const pending = owner.readNativeOutcomeCandidate();
    if (cancel) controller.abort(); else await owner.close();
    f.finish({bridgeExitCode: 0, stdout: nativeSuccess, stderrBytes: 0, uncertain: false});
    assert.equal(await pending, null);
    await owner.close();
  }
});

test('revoked running authority refuses result before owner closes', async () => {
  const f = fixture(); const owner = await runFixture(f);
  await owner.sendPrompt(prompt, promptHash);
  f.store.assertRunningReadAuthority = () => {throw new Error('revoked');};
  const pending = owner.readNativeOutcomeCandidate();
  f.finish({bridgeExitCode: 0, stdout: nativeSuccess, stderrBytes: 0, uncertain: false});
  assert.equal(await pending, null);
  assert.equal(f.events.includes('recovery'), false);
  await owner.close();
});

test('persisted attempt wall budget bounds native outcome wait independently of owner window', async () => {
  const f = fixture(); const owner = await runFixture(f);
  await owner.sendPrompt(prompt, promptHash);
  const get = f.store.get.bind(f.store);
  f.store.get = (...args) => {
    const record = get(...args)!;
    return {...record, attempts: [{...record.attempts[0]!,
      startedAt: new Date(Date.now() - 20_001).toISOString()}]};
  };
  assert.equal(await owner.readNativeOutcomeCandidate(), null);
  assert.equal(f.events.includes('recovery'), false);
  await owner.close();
});

test('native outcome wait expires at persisted wall deadline even with no bridge close', async () => {
  const f = fixture(); const owner = await runFixture(f);
  await owner.sendPrompt(prompt, promptHash);
  const get = f.store.get.bind(f.store);
  f.store.get = (...args) => {
    const record = get(...args)!;
    return {...record, attempts: [{...record.attempts[0]!,
      startedAt: new Date(Date.now() - 19_900).toISOString()}]};
  };
  const before = performance.now();
  assert.equal(await owner.readNativeOutcomeCandidate(), null);
  assert.ok(performance.now() - before < 1000);
  await owner.close();
});

test('candidate is refused if final authority check crosses persisted wall deadline', async () => {
  const f = fixture(); const owner = await runFixture(f);
  await owner.sendPrompt(prompt, promptHash);
  const get = f.store.get.bind(f.store);
  f.store.get = (...args) => {
    const record = get(...args)!;
    return {...record, attempts: [{...record.attempts[0]!,
      startedAt: new Date(Date.now() - 19_850).toISOString()}]};
  };
  f.store.assertRunningReadAuthority = () => {
    const until = performance.now() + 200;
    while (performance.now() < until) { /* deterministic expired authority fence */ }
  };
  const pending = owner.readNativeOutcomeCandidate();
  f.finish({bridgeExitCode: 0, stdout: nativeSuccess, stderrBytes: 0, uncertain: false});
  assert.equal(await pending, null);
  await owner.close();
});
