import type { Writable } from 'node:stream';
import { appServerUnitSpec, type AppServerUnitInput } from './systemd-pipe.js';
import type { CodexControlSend, CodexSynchronousSend } from '../protocol/stdio.js';

export interface WslDiagnosticObservation {
  bootId: string;
  uid: number;
  unitName: string;
  invocationId: string;
  controlGroup: string;
  loadState: string;
  activeState: string;
  subState: string;
  mainPid: number;
  cgroupState: string;
}

export interface WslDiagnosticIdentity {
  bootId: string;
  uid: number;
  unitName: string;
  invocationId: string;
  controlGroup: string;
  mainPid: number;
}

/** A separate, short diagnostic unit; production launch semantics stay unchanged. */
export function diagnosticAppServerUnitSpec(input: AppServerUnitInput): ReturnType<typeof appServerUnitSpec> {
  if (!input || !Number.isInteger(input.maxWallSeconds) || input.maxWallSeconds < 1 ||
    input.maxWallSeconds > 60) throw new Error('INVALID_ARGUMENT');
  const spec = appServerUnitSpec(input);
  const args = [...spec.args];
  args.splice(args.indexOf('--pipe'), 0, '--remain-after-exit');
  return { ...spec, args };
}

function validIdentity(value: WslDiagnosticIdentity): boolean {
  return !!value && typeof value === 'object' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.bootId) &&
    Number.isSafeInteger(value.uid) && value.uid > 0 &&
    /^rcac-investigator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.service$/.test(value.unitName) &&
    /^[0-9a-f]{32}$/.test(value.invocationId) &&
    value.controlGroup === `/user.slice/user-${value.uid}.slice/user@${value.uid}.service/app.slice/${value.unitName}` &&
    Number.isSafeInteger(value.mainPid) && value.mainPid > 0;
}

/** Bind only an observed running service with its exact user systemd cgroup. */
export function bindDiagnosticRunning(input: AppServerUnitInput,
  observation: WslDiagnosticObservation): Readonly<WslDiagnosticIdentity> {
  try { diagnosticAppServerUnitSpec(input); }
  catch { throw new Error('INVALID_DIAGNOSTIC_RUNNING'); }
  if (!observation || !validIdentity(observation) || observation.unitName !== input.unitName ||
    observation.loadState !== 'loaded' || observation.activeState !== 'active' ||
    observation.subState !== 'running' || observation.cgroupState !== 'populated')
    throw new Error('INVALID_DIAGNOSTIC_RUNNING');
  return Object.freeze({ bootId: observation.bootId, uid: observation.uid,
    unitName: observation.unitName, invocationId: observation.invocationId,
    controlGroup: observation.controlGroup, mainPid: observation.mainPid });
}

/** Identity check for diagnostic cleanup re-observation; it does not confer CAS or isolation. */
export function diagnosticSameUnit(identity: WslDiagnosticIdentity,
  observation: WslDiagnosticObservation): boolean {
  return validIdentity(identity) && !!observation && typeof observation === 'object' &&
    observation.bootId === identity.bootId && observation.uid === identity.uid &&
    observation.unitName === identity.unitName && observation.invocationId === identity.invocationId &&
    observation.loadState === 'loaded' &&
    (observation.controlGroup === identity.controlGroup || observation.controlGroup === '') &&
    Number.isSafeInteger(observation.mainPid) && observation.mainPid >= 0 &&
    (observation.mainPid === 0 || observation.mainPid === identity.mainPid);
}

/** Proof scoped to this retained diagnostic unit, not production terminal authority. */
export function diagnosticAppServerExited(identity: WslDiagnosticIdentity,
  observation: WslDiagnosticObservation): boolean {
  return diagnosticSameUnit(identity, observation) && observation.activeState === 'active' &&
    observation.subState === 'exited' && observation.mainPid === 0 &&
    (observation.cgroupState === 'empty' || observation.cgroupState === 'absent');
}

/** Guards the transport's own fixed handshake control frames in a local diagnostic. */
export function createInitializeOnlyDiagnosticGuard(): (frame: CodexControlSend) => void {
  let stage = 0;
  return (frame: CodexControlSend): void => {
    if (stage === 0 && frame?.kind === 'rpc' && frame.method === 'initialize') {
      stage = 1;
      return;
    }
    if (stage === 1 && frame?.kind === 'initialized') {
      stage = 2;
      return;
    }
    throw new Error('DIAGNOSTIC_CONTROL_REJECTED');
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

/** Only boolean root-binding facts may be retained; this is not an effective-auth proof. */
export function checkDiagnosticPrivateBinding(value: unknown): void {
  const fields = ['homeMatched', 'codexHomeMatched', 'cwdMatched', 'commandMatched',
    'authFileAbsent', 'environmentMatched'];
  if (!object(value) || !keys(value, fields) || !fields.every(key => value[key] === true))
    throw new Error('PRIVATE_BINDING_UNVERIFIED');
}

/** Pure predicate shared by the fixed Linux audit and synthetic local tests. Never prints values. */
export const diagnosticPrivateEnvironmentCheck = String.raw`
def matches_private_environment(raw, home, codex, path):
 expected={b'HOME':home.encode(), b'CODEX_HOME':codex.encode(), b'PATH':path.encode()}
 if not raw.endswith(b'\0'): return False
 entries=raw.split(b'\0')[:-1]
 if len(entries)!=3: return False
 observed={}
 for entry in entries:
  if b'=' not in entry: return False
  key,value=entry.split(b'=',1)
  if key in observed or key not in expected: return False
  observed[key]=value
 return observed==expected
`;

function fixedInitialize(value: unknown): boolean {
  return object(value) && keys(value, ['clientInfo', 'capabilities']) &&
    object(value.clientInfo) && keys(value.clientInfo, ['name', 'version']) &&
    value.clientInfo.name === 'repo-conduit' && value.clientInfo.version === '0.1.0' &&
    object(value.capabilities) && keys(value.capabilities, ['experimentalApi']) &&
    value.capabilities.experimentalApi === false;
}

/** Check only the retained target schema fields consumed by this diagnostic. */
export function checkDiagnosticInitializeSchema(schema: unknown): void {
  const reject = () => { throw new Error('INITIALIZE_SCHEMA_UNVERIFIED'); };
  if (!object(schema) || schema.type !== 'object' || !object(schema.properties)) return reject();
  const defs = schema.definitions ?? schema.$defs;
  if (!object(defs)) return reject();
  const dereference = (value: unknown, depth = 0): Record<string, unknown> => {
    if (!object(value) || depth > 6) return reject();
    if (typeof value.$ref === 'string') {
      if (!/^#\/(definitions|\$defs)\/[A-Za-z0-9_]+$/.test(value.$ref)) return reject();
      return dereference(defs[value.$ref.split('/').at(-1)!], depth + 1);
    }
    if (Array.isArray(value.anyOf)) return dereference(value.anyOf.find(x => object(x) && x.type !== 'null'), depth + 1);
    return value;
  };
  const client = dereference(schema.properties.clientInfo).properties;
  const caps = dereference(schema.properties.capabilities).properties;
  if (!object(client) || !object(caps) || !object(client.name) || client.name.type !== 'string' ||
    !object(client.version) || client.version.type !== 'string' ||
    !object(caps.experimentalApi) || caps.experimentalApi.type !== 'boolean' ||
    !object(caps.explicitGatewayOauth) || caps.explicitGatewayOauth.type !== 'boolean') return reject();
}

/** Diagnostic-only explicit OAuth request; record the exact rewritten frame before bytes. */
export function createInitializeOnlyDiagnosticWriter(input: Writable,
  persistIntent: (line: string) => void): CodexSynchronousSend {
  const guard = createInitializeOnlyDiagnosticGuard();
  const usable = () => input.writable && !input.destroyed && !input.errored &&
    !input.writableEnded && !input.writableFinished && input.writableCorked === 0 &&
    input.writableLength === 0 && !input.writableNeedDrain;
  return (line, control) => {
    if (!control || !usable()) throw new Error('DIAGNOSTIC_CONTROL_REJECTED');
    if (Buffer.byteLength(line) > 16 * 1024 || !line.endsWith('\n') ||
      line.slice(0, -1).includes('\n') || line.includes('\r')) throw new Error('DIAGNOSTIC_CONTROL_REJECTED');
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { throw new Error('DIAGNOSTIC_CONTROL_REJECTED'); }
    if (!object(frame)) throw new Error('DIAGNOSTIC_CONTROL_REJECTED');
    let actual: string;
    if (control.kind === 'rpc' && control.method === 'initialize' &&
      keys(control, ['kind', 'method', 'params']) && fixedInitialize(control.params) &&
      keys(frame, ['id', 'method', 'params']) && Number.isSafeInteger(frame.id) &&
      (frame.id as number) > 0 && frame.method === 'initialize' && fixedInitialize(frame.params)) {
      actual = JSON.stringify({ id: frame.id, method: 'initialize', params: {
        clientInfo: { name: 'repo-conduit', version: '0.1.0' },
        capabilities: { experimentalApi: false, explicitGatewayOauth: true },
      } }) + '\n';
    } else if (control.kind === 'initialized' && keys(control, ['kind']) &&
      keys(frame, ['method']) && frame.method === 'initialized') actual = '{"method":"initialized"}\n';
    else throw new Error('DIAGNOSTIC_CONTROL_REJECTED');
    if (Buffer.byteLength(actual) > 16 * 1024) throw new Error('DIAGNOSTIC_CONTROL_REJECTED');
    guard(control);
    persistIntent(actual);
    if (!usable()) throw new Error('DIAGNOSTIC_CONTROL_REJECTED');
    return input.write(actual);
  };
}
