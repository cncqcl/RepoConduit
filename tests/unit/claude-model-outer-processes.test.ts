import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateClaudeModelOuterProcesses } from
  '../../src/adapters/secondary-investigator/claude-model-outer-processes.js';
import type { ClaudeModelOuterProbeInput, ClaudeModelOuterRawProbe } from
  '../../src/adapters/secondary-investigator/claude-model-outer-probe.js';
import { validateClaudeModelOuterFact } from
  '../../src/adapters/secondary-investigator/claude-model-outer-fact.js';

const stem = 'tests/fixtures/legacy-runtime/outer-observer';
function fixture(): { input: ClaudeModelOuterProbeInput; probe: ClaudeModelOuterRawProbe } {
  const meta = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
  return { input: { running: meta.running, startup: meta.startup, descriptor: meta.descriptor,
    paths: meta.paths, profile: meta.profile }, probe: JSON.parse(readFileSync(`${stem}.raw.json`, 'utf8')) };
}

function deeperRootFixture() {
  const recorded = JSON.parse(readFileSync(
    'tests/fixtures/legacy-runtime/deeper-root.json', 'utf8'));
  const observation = recorded.unvalidatedObservation;
  const expectation = recorded.trustedExpected;
  return { observation, expectation, input: { ...expectation,
    running: observation.candidate.running, startup: observation.candidate.startup } as ClaudeModelOuterProbeInput,
  probe: observation.candidate.probe as ClaudeModelOuterRawProbe };
}

test('deidentified deeper-root snapshot permits the original root and lock FD allocation permutation', () => {
  const {input, probe, observation, expectation} = deeperRootFixture();
  assert.equal(probe.processes.parent.fds.find(fd => fd.fd === 3)!.target,
    `${input.running.resource.gate!.root}/${input.descriptor.attemptId}.model-supervisor.lock`);
  assert.equal(probe.processes.parent.fds.find(fd => fd.fd === 4)!.target,
    input.running.resource.gate!.root);
  assert.equal(validateClaudeModelOuterProcesses(input, probe, expectation.limits), true);
  assert.equal(validateClaudeModelOuterFact({kind: 'model_outer_confined_v1',
    networkMode: 'host_shared_pre_srt', srtState: 'not_started', expectation, observation}), true);
});

test('root/lock FD permutation never permits wrong paths, directions, duplicates or moved descriptors', () => {
  const changes: ((p: ClaudeModelOuterRawProbe) => void)[] = [
    p => {p.processes.parent.fds.find(fd => fd.fd === 4)!.target += '/other';},
    p => {p.processes.parent.fds.find(fd => fd.fd === 3)!.target += '.other';},
    p => {p.processes.parent.fds.find(fd => fd.fd === 4)!.direction = 'readwrite';},
    p => {p.processes.parent.fds.find(fd => fd.fd === 3)!.target =
      p.processes.parent.fds.find(fd => fd.fd === 4)!.target;},
    p => {p.processes.parent.fds.find(fd => fd.fd === 3)!.fd = 31;},
  ];
  for (const change of changes) {
    const {input, probe, expectation} = deeperRootFixture();
    change(probe);
    assert.equal(validateClaudeModelOuterProcesses(input, probe, expectation.limits), false);
  }
});
test('deidentified four-process identity and FD graph validate without authorizing dispatch', () => {
  const {input, probe} = fixture();
  assert.equal(validateClaudeModelOuterProcesses(input, probe, {maxWallSeconds:20}), true);
  assert.equal(validateClaudeModelOuterProcesses(input, probe, {maxWallSeconds:21}), false);
});

test('historical parent program allowlist binds exact bytes, argv position and trailing NUL', () => {
  const {input, probe}=fixture();
  assert.equal(validateClaudeModelOuterProcesses(input,probe,{maxWallSeconds:20}),true);
  const original=probe.processes.parent.cmdline;
  const fields=original.slice(0,-1).split('\0');
  assert.equal(fields[3],'-c');
  for (const [index,changed] of [
    [...fields.slice(0,4),fields[4]!.slice(0,100)+
      (fields[4]![100]==='x'?'y':'x')+fields[4]!.slice(101),...fields.slice(5)].join('\0')+'\0',
    [...fields.slice(0,4),fields[4]!.slice(1),...fields.slice(5)].join('\0')+'\0',
    [...fields.slice(0,4),...fields.slice(5)].join('\0')+'\0',
    [...fields.slice(0,4),'extra',...fields.slice(4)].join('\0')+'\0',
    [...fields.slice(0,5),fields[5]+'changed',...fields.slice(6)].join('\0')+'\0',
    original.slice(0,-1),
    original+'\0',
    original.replace('/usr/bin/python3\0','/tmp/python3\0'),
  ].entries()) {
    const candidate=structuredClone(probe);
    candidate.processes.parent.cmdline=changed;
    assert.equal(validateClaudeModelOuterProcesses(input,candidate,{maxWallSeconds:20}),false,
      `mutated argv case ${index}`);
  }
});
test('rejects forged raw identity, derived status, ending tuples and sandbox proc views', () => {
  const changes: ((p: ClaudeModelOuterRawProbe) => void)[] = [
    p => { p.processes.outer.ppid++; },
    p => { p.processes.bootstrap.statRaw = p.processes.bootstrap.statRaw.replace(' S ', ' Z '); },
    p => { p.processes.outer.selectedStatus.CapBnd = '0000000000000001'; },
    p => { p.processes.outer.statusRaw += 'CapEff:\t0000000000000000\n'; },
    p => { p.endingIdentities.outer.statRaw = p.endingIdentities.outer.statRaw.replace(' S ', ' Z '); },
    p => { p.sandboxPidView.outer.statRaw = p.sandboxPidView.outer.statRaw.replace(/^1 /, '9 '); },
    p => { p.processes.bootstrap.selectedStatus.NSpid = String(p.processes.bootstrap.pid); },
    p => { p.unitAfter.InvocationID = '0'.repeat(32); },
  ];
  for (const change of changes) { const {input,probe} = fixture(); change(probe);
    assert.equal(validateClaudeModelOuterProcesses(input, probe, {maxWallSeconds:20}), false); }
});
test('rejects wrong executables, command recipes, namespaces, session and uid maps', () => {
  const changes: ((p: ClaudeModelOuterRawProbe) => void)[] = [
    p => { p.processes.bootstrap.exe = '/tmp/python3'; },
    p => { p.processes.wrapper.cmdline += '--share-user\0'; },
    p => { p.processes.bootstrap.namespaces.net = 'net:[999]'; },
    p => { p.processes.outer.namespaces.mnt = p.observerNamespaces.mnt!; },
    p => { p.processes.bootstrap.uidMap = '0 0 4294967295\n'; },
    p => { const fields=p.processes.outer.statRaw.slice(p.processes.outer.statRaw.lastIndexOf(')')+2).trim().split(' ');
      fields[3]='99'; p.processes.outer.statRaw=p.processes.outer.statRaw.slice(0,p.processes.outer.statRaw.lastIndexOf(')')+2)+fields.join(' ')+'\n'; },
  ];
  for(const change of changes) {const {input,probe}=fixture();change(probe);
    assert.equal(validateClaudeModelOuterProcesses(input,probe,{maxWallSeconds:20}),false);}
});
test('rejects extra FDs, wrong pipe inverse, direction or unrelated eventfd', () => {
  const changes: ((p: ClaudeModelOuterRawProbe) => void)[] = [
    p => { p.processes.bootstrap.fds.push({...p.processes.bootstrap.fds[0]!,fd:3,target:'socket:[999]'}); },
    p => { p.processes.outer.fds[0]!.direction='write'; },
    p => { p.processes.parent.fds=p.processes.parent.fds.filter(f=>f.target!==p.processes.outer.fds[0]!.target); },
    p => { p.processes.outer.fds.find(f=>f.fd===4)!.fdinfo=p.processes.outer.fds.find(f=>f.fd===4)!.fdinfo.replace('eventfd-id: 9','eventfd-id: 99'); },
    p => { p.processes.bootstrap.fds[1]!.fdinfo=p.processes.bootstrap.fds[1]!.fdinfo.replace('flags:\t01','flags:\t00'); },
  ];
  for(const change of changes) {const {input,probe}=fixture();change(probe);
    assert.equal(validateClaudeModelOuterProcesses(input,probe,{maxWallSeconds:20}),false);}
});
