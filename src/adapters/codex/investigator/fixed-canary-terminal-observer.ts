import type { WslResource } from '../../storage/investigation-sqlite.js';
import { runWslTerminalProbe, wslTerminalObservationSpec,
  type WslTerminalRunner } from './terminal-observer.js';

/** This proof applies only to the fixed, no-child-process canary payload. */
export type FixedCanaryTerminalObservation =
  | { kind: 'fixed_canary_terminal'; resource: WslResource }
  | { kind: 'unconfirmed' };

export async function observeFixedCanaryTerminal(resource: WslResource,
  runner: WslTerminalRunner = runWslTerminalProbe): Promise<FixedCanaryTerminalObservation> {
  if (resource?.gate?.protocol !== 'attempt_gate_v1' ||
    resource.gate.payloadKind !== 'canary_v1' || !resource.invocationId ||
    !resource.controlGroup) return { kind: 'unconfirmed' };
  let spec: ReturnType<typeof wslTerminalObservationSpec>;
  try { spec = wslTerminalObservationSpec(resource, resource.gate.linuxUser); }
  catch { return { kind: 'unconfirmed' }; }
  let output: Awaited<ReturnType<WslTerminalRunner>>;
  try { output = await runner(spec); }
  catch { return { kind: 'unconfirmed' }; }
  if (!output || output.exitCode !== 0 || typeof output.stdout !== 'string' ||
    typeof output.stderr !== 'string' || Buffer.byteLength(output.stdout) > 4096 ||
    Buffer.byteLength(output.stderr) > 4096 || !output.stdout.endsWith('\n'))
    return { kind: 'unconfirmed' };
  let parsed: unknown;
  try { parsed = JSON.parse(output.stdout); }
  catch { return { kind: 'unconfirmed' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unconfirmed' };
  const state = parsed as Record<string, unknown>;
  const keys = ['bootId', 'uid', 'unitName', 'invocationId', 'controlGroup', 'loadState',
    'activeState', 'subState', 'mainPid', 'cgroupState'];
  if (Object.keys(state).length !== keys.length || keys.some(key => !(key in state)) ||
    state.bootId !== resource.bootId || state.uid !== resource.uid ||
    state.unitName !== resource.unitName || state.invocationId !== resource.invocationId ||
    // RemainAfterExit may clear ControlGroup after exit. The helper separately
    // checked the saved, exact cgroup path against a verified cgroup v2 mount.
    (state.controlGroup !== resource.controlGroup && state.controlGroup !== '') ||
    state.loadState !== 'loaded' || state.mainPid !== 0 ||
    (state.cgroupState !== 'absent' && state.cgroupState !== 'empty'))
    return { kind: 'unconfirmed' };
  const exited = state.activeState === 'active' && state.subState === 'exited';
  const failed = state.activeState === 'failed' && state.subState === 'failed';
  const inactive = state.activeState === 'inactive' && state.subState === 'dead';
  if (!exited && !failed && !inactive) return { kind: 'unconfirmed' };
  return { kind: 'fixed_canary_terminal', resource: { ...resource } };
}
