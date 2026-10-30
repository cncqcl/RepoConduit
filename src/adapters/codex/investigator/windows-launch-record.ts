export const WINDOWS_HISTORICAL_APP_SERVER_PROTOCOL_TARGET =
  'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1' as const;
export const WINDOWS_PREVIOUS_APP_SERVER_PROTOCOL_TARGET =
  'windows-desktop-26.930.3930.0-codex-0.160.0' as const;
export const WINDOWS_PRIOR_APP_SERVER_PROTOCOL_TARGET =
  'windows-desktop-26.930.4958.0-codex-0.160.0' as const;
export const WINDOWS_LAST_HISTORICAL_APP_SERVER_PROTOCOL_TARGET =
  'windows-desktop-26.930.7945.0-codex-0.160.1' as const;
export const WINDOWS_REPLACED_APP_SERVER_PROTOCOL_TARGET =
  'windows-desktop-26.1002.7124.0-codex-0.162.0-alpha.2' as const;
export const WINDOWS_LAST_APP_SERVER_PROTOCOL_TARGET =
  'windows-desktop-26.1007.2314.0-codex-0.162.0-alpha.17.2' as const;
export const WINDOWS_PREVIOUS_0163_APP_SERVER_PROTOCOL_TARGET =
  'windows-desktop-26.1013.3656.0-codex-0.163.0-alpha.10.2' as const;
export const WINDOWS_LAST_0163_APP_SERVER_PROTOCOL_TARGET =
  'windows-desktop-26.1013.4894.0-codex-0.163.0-alpha.10.2' as const;
export const WINDOWS_APP_SERVER_PROTOCOL_TARGET =
  'windows-desktop-codex-0.163.0-alpha.11' as const;
export const WINDOWS_APP_SERVER_RECIPE = 'windows_app_server_readonly_v1' as const;

export interface LegacyWindowsAppServerLaunchBinding {
  collaborationId: string;
  sourceDigest: string;
  profileRevision: string;
  permissionEpoch: number;
  protocolTarget: typeof WINDOWS_HISTORICAL_APP_SERVER_PROTOCOL_TARGET;
  recipe: typeof WINDOWS_APP_SERVER_RECIPE;
  hostScopeId: string;
  executionInstanceId: string;
  runtimeId?: never;
  configSha256?: never;
}

export interface CurrentWindowsAppServerLaunchBinding extends
  Omit<LegacyWindowsAppServerLaunchBinding,'runtimeId'|'configSha256'|'protocolTarget'> {
  protocolTarget: typeof WINDOWS_HISTORICAL_APP_SERVER_PROTOCOL_TARGET |
    typeof WINDOWS_PREVIOUS_APP_SERVER_PROTOCOL_TARGET |
    typeof WINDOWS_PRIOR_APP_SERVER_PROTOCOL_TARGET |
    typeof WINDOWS_LAST_HISTORICAL_APP_SERVER_PROTOCOL_TARGET |
    typeof WINDOWS_REPLACED_APP_SERVER_PROTOCOL_TARGET |
    typeof WINDOWS_LAST_APP_SERVER_PROTOCOL_TARGET |
    typeof WINDOWS_PREVIOUS_0163_APP_SERVER_PROTOCOL_TARGET |
    typeof WINDOWS_LAST_0163_APP_SERVER_PROTOCOL_TARGET |
    typeof WINDOWS_APP_SERVER_PROTOCOL_TARGET;
  runtimeId: string;
  configSha256: string;
}

export interface ActiveWindowsAppServerLaunchBinding extends CurrentWindowsAppServerLaunchBinding {
  protocolTarget: typeof WINDOWS_APP_SERVER_PROTOCOL_TARGET;
}

export type WindowsAppServerLaunchBinding =
  LegacyWindowsAppServerLaunchBinding | CurrentWindowsAppServerLaunchBinding;

export interface WindowsAppServerProcessIdentity {
  pid: number;
  creationFiletime: string;
  hostScopeId: string;
  executionInstanceId: string;
}

export interface WindowsAppServerLaunchRecord {
  launchId: string;
  requestId: string;
  attemptId: string;
  workspaceId: string;
  collaborationId: string;
  launchWorkerId: string;
  launchEpoch: number;
  binding: WindowsAppServerLaunchBinding;
  state: 'intent' | 'observed' | 'recovery_required';
  identity: WindowsAppServerProcessIdentity | null;
  intentAt: string;
  observedAt: string | null;
  recoveryRequiredAt: string | null;
}

export type CurrentWindowsAppServerLaunchRecord =
  Omit<WindowsAppServerLaunchRecord,'binding'> & {binding:CurrentWindowsAppServerLaunchBinding};

export type ActiveWindowsAppServerLaunchRecord =
  Omit<CurrentWindowsAppServerLaunchRecord,'binding'> & {binding:ActiveWindowsAppServerLaunchBinding};

/** A launch's sole durable start opportunity. Consumption precedes any external send. */
export interface WindowsLaunchStartIntent {
  kind: 'windows_app_server_start_intent_v1';
  launchId: string;
  reservedAt: string;
  consumedAt: string | null;
}

export function validWindowsLaunchStartIntent(value: unknown): value is WindowsLaunchStartIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const iso = (date: unknown): date is string => typeof date === 'string' &&
    Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === date;
  return Object.keys(item).sort().join(',') === 'consumedAt,kind,launchId,reservedAt' &&
    item.kind === 'windows_app_server_start_intent_v1' &&
    typeof item.launchId === 'string' && uuid.test(item.launchId) && iso(item.reservedAt) &&
    (item.consumedAt === null || iso(item.consumedAt));
}

/** Aggregate of an owned helper transcript, never a lone job_closed JSONL frame. */
export interface WindowsAppServerClosureObservation {
  readonly protocol: 'windows_job_stdio_v1';
  readonly helperVersion: '3';
  readonly kind: 'job_closed';
  readonly recipe: typeof WINDOWS_APP_SERVER_RECIPE;
  readonly launchId: string;
  readonly hostScopeId: string;
  readonly executionInstanceId: string;
  readonly root: { readonly pid: number; readonly creationFiletime: string };
  readonly rootExited: true;
  readonly stdoutEof: true;
  readonly stderrEof: true;
  readonly members: { readonly complete: true; readonly assigned: 0; readonly listed: 0;
    readonly pids: readonly [] };
  readonly helperExitCode: 0;
  readonly sequence: number;
}

export interface WindowsAppServerClosureRecord {
  readonly launchId: string;
  readonly observation: WindowsAppServerClosureObservation;
  readonly recordedAt: string;
}

/** Sanitized aggregate from one owned prepare/stop helper. It contains no writer capability. */
export interface WindowsAppServerNotStartedObservation {
  readonly kind: 'windows_app_server_not_started_v1';
  readonly protocol: 'windows_job_stdio_v1';
  readonly helperVersion: '3';
  readonly recipe: typeof WINDOWS_APP_SERVER_RECIPE;
  readonly launchId: string;
  readonly hostScopeId: string;
  readonly executionInstanceId: string;
  readonly helper: {readonly pid:number;readonly creationFiletime:string};
  readonly prepared: {readonly kind:'prepared';readonly sequence:1;readonly childPresent:false};
  readonly preparedClosed: {readonly kind:'prepared_closed';readonly sequence:2;
    readonly childPresent:false;readonly members:{readonly complete:true;readonly assigned:0;
      readonly listed:0;readonly pids:readonly []}};
  readonly helperExitCode: 0;
}

export interface WindowsAppServerNotStartedRecord {
  readonly launchId: string;
  readonly observation: WindowsAppServerNotStartedObservation;
  readonly recordedAt: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validWindowsAppServerLaunchBase(item: Record<string,unknown>): boolean {
  return typeof item.collaborationId==='string' && item.collaborationId.length>0 && item.collaborationId.length<=128 &&
    typeof item.sourceDigest==='string' && /^[0-9a-f]{64}$/.test(item.sourceDigest) &&
    typeof item.profileRevision==='string' && item.profileRevision.length>0 && item.profileRevision.length<=128 &&
    Number.isSafeInteger(item.permissionEpoch) && (item.permissionEpoch as number)>=0 &&
    (item.protocolTarget===WINDOWS_HISTORICAL_APP_SERVER_PROTOCOL_TARGET ||
      item.protocolTarget===WINDOWS_PREVIOUS_APP_SERVER_PROTOCOL_TARGET ||
      item.protocolTarget===WINDOWS_PRIOR_APP_SERVER_PROTOCOL_TARGET ||
      item.protocolTarget===WINDOWS_LAST_HISTORICAL_APP_SERVER_PROTOCOL_TARGET ||
      item.protocolTarget===WINDOWS_REPLACED_APP_SERVER_PROTOCOL_TARGET ||
      item.protocolTarget===WINDOWS_LAST_APP_SERVER_PROTOCOL_TARGET ||
      item.protocolTarget===WINDOWS_PREVIOUS_0163_APP_SERVER_PROTOCOL_TARGET ||
      item.protocolTarget===WINDOWS_LAST_0163_APP_SERVER_PROTOCOL_TARGET ||
      item.protocolTarget===WINDOWS_APP_SERVER_PROTOCOL_TARGET) && item.recipe===WINDOWS_APP_SERVER_RECIPE &&
    typeof item.hostScopeId==='string' && uuid.test(item.hostScopeId) &&
    typeof item.executionInstanceId==='string' && uuid.test(item.executionInstanceId);
}

export function validCurrentWindowsAppServerLaunchBinding(value: unknown):
  value is CurrentWindowsAppServerLaunchBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item=value as Record<string,unknown>;
  return Object.keys(item).sort().join(',')===
    'collaborationId,configSha256,executionInstanceId,hostScopeId,permissionEpoch,profileRevision,protocolTarget,recipe,runtimeId,sourceDigest' &&
    validWindowsAppServerLaunchBase(item) &&
    typeof item.runtimeId==='string' && uuid.test(item.runtimeId) &&
    typeof item.configSha256==='string' && /^[0-9a-f]{64}$/.test(item.configSha256);
}

export function validActiveWindowsAppServerLaunchBinding(value: unknown):
  value is ActiveWindowsAppServerLaunchBinding {
  return validCurrentWindowsAppServerLaunchBinding(value) &&
    value.protocolTarget===WINDOWS_APP_SERVER_PROTOCOL_TARGET;
}

export function validWindowsAppServerLaunchBinding(value: unknown): value is WindowsAppServerLaunchBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item=value as Record<string,unknown>;
  return validCurrentWindowsAppServerLaunchBinding(item) ||
    (Object.keys(item).sort().join(',')===
      'collaborationId,executionInstanceId,hostScopeId,permissionEpoch,profileRevision,protocolTarget,recipe,sourceDigest' &&
      validWindowsAppServerLaunchBase(item) &&
      item.protocolTarget===WINDOWS_HISTORICAL_APP_SERVER_PROTOCOL_TARGET);
}

export function validWindowsAppServerProcessIdentity(value: unknown,
  binding: WindowsAppServerLaunchBinding): value is WindowsAppServerProcessIdentity {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const item=value as Record<string,unknown>;
  if (Object.keys(item).sort().join(',')!==
    'creationFiletime,executionInstanceId,hostScopeId,pid' ||
    !Number.isSafeInteger(item.pid) || (item.pid as number)<1 || (item.pid as number)>0xffff_ffff ||
    typeof item.creationFiletime!=='string' ||
    !/^[1-9][0-9]{0,19}$/.test(item.creationFiletime) ||
    item.hostScopeId!==binding.hostScopeId || item.executionInstanceId!==binding.executionInstanceId)
    return false;
  return BigInt(item.creationFiletime)<=0xffff_ffff_ffff_ffffn;
}

export function validWindowsAppServerLaunchRecord(value: unknown): value is WindowsAppServerLaunchRecord {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const item=value as Record<string,unknown>;
  if (Object.keys(item).sort().join(',')!==
    'attemptId,binding,collaborationId,identity,intentAt,launchEpoch,launchId,launchWorkerId,observedAt,recoveryRequiredAt,requestId,state,workspaceId' ||
    typeof item.launchId!=='string' || !uuid.test(item.launchId) ||
    typeof item.requestId!=='string' || !item.requestId ||
    typeof item.attemptId!=='string' || !item.attemptId ||
    typeof item.workspaceId!=='string' || !item.workspaceId ||
    typeof item.collaborationId!=='string' || !item.collaborationId ||
    typeof item.launchWorkerId!=='string' || !item.launchWorkerId ||
    !Number.isSafeInteger(item.launchEpoch) || (item.launchEpoch as number)<1 ||
    !validWindowsAppServerLaunchBinding(item.binding) ||
    item.collaborationId!==item.binding.collaborationId ||
    !['intent','observed','recovery_required'].includes(item.state as string) ||
    typeof item.intentAt!=='string' || !Number.isFinite(Date.parse(item.intentAt)) ||
    (item.observedAt!==null &&
      (typeof item.observedAt!=='string' || !Number.isFinite(Date.parse(item.observedAt)))) ||
    (item.recoveryRequiredAt!==null &&
      (typeof item.recoveryRequiredAt!=='string' || !Number.isFinite(Date.parse(item.recoveryRequiredAt)))))
    return false;
  if ((item.state==='recovery_required') !== (item.recoveryRequiredAt!==null)) return false;
  if (item.identity===null) return item.observedAt===null && item.state!=='observed';
  return validWindowsAppServerProcessIdentity(item.identity,item.binding) && item.observedAt!==null &&
    item.state!=='intent';
}

/** Only the immutable launch origin is an authority binding; later state cannot rewrite it. */
export function sameWindowsAppServerLaunchOrigin(a: WindowsAppServerLaunchRecord,
  b: WindowsAppServerLaunchRecord): boolean {
  return a.launchId===b.launchId && a.requestId===b.requestId &&
    a.attemptId===b.attemptId && a.workspaceId===b.workspaceId &&
    a.collaborationId===b.collaborationId && a.launchWorkerId===b.launchWorkerId &&
    a.launchEpoch===b.launchEpoch && a.intentAt===b.intentAt &&
    JSON.stringify(a.binding)===JSON.stringify(b.binding);
}

export function validWindowsAppServerClosureObservation(value: unknown):
  value is WindowsAppServerClosureObservation {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const item=value as Record<string,unknown>;
  if (Object.keys(item).sort().join(',')!==
    'executionInstanceId,helperExitCode,helperVersion,hostScopeId,kind,launchId,members,protocol,recipe,root,rootExited,sequence,stderrEof,stdoutEof' ||
    item.protocol!=='windows_job_stdio_v1' || item.helperVersion!=='3' ||
    item.kind!=='job_closed' || item.recipe!==WINDOWS_APP_SERVER_RECIPE ||
    typeof item.launchId!=='string' || !uuid.test(item.launchId) ||
    typeof item.hostScopeId!=='string' || !uuid.test(item.hostScopeId) ||
    typeof item.executionInstanceId!=='string' || !uuid.test(item.executionInstanceId) ||
    item.rootExited!==true || item.stdoutEof!==true || item.stderrEof!==true ||
    item.helperExitCode!==0 || !Number.isSafeInteger(item.sequence) || (item.sequence as number)<5 ||
    !item.root || typeof item.root!=='object' || Array.isArray(item.root) ||
    !item.members || typeof item.members!=='object' || Array.isArray(item.members)) return false;
  const root=item.root as Record<string,unknown>;
  const members=item.members as Record<string,unknown>;
  return Object.keys(root).sort().join(',')==='creationFiletime,pid' &&
    Number.isSafeInteger(root.pid) && (root.pid as number)>0 &&
    (root.pid as number)<=0xffff_ffff &&
    typeof root.creationFiletime==='string' &&
    /^[1-9][0-9]{0,19}$/.test(root.creationFiletime) &&
    BigInt(root.creationFiletime)<=0xffff_ffff_ffff_ffffn &&
    Object.keys(members).sort().join(',')==='assigned,complete,listed,pids' &&
    members.complete===true && members.assigned===0 && members.listed===0 &&
    Array.isArray(members.pids) && members.pids.length===0;
}

export function validWindowsAppServerClosureRecord(value: unknown):
  value is WindowsAppServerClosureRecord {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const item=value as Record<string,unknown>;
  return Object.keys(item).sort().join(',')==='launchId,observation,recordedAt' &&
    validWindowsAppServerClosureObservation(item.observation) &&
    item.launchId===(item.observation as WindowsAppServerClosureObservation).launchId &&
    typeof item.recordedAt==='string' && Number.isFinite(Date.parse(item.recordedAt));
}

export function validWindowsAppServerNotStartedObservation(value:unknown):
  value is WindowsAppServerNotStartedObservation {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const item=value as Record<string,unknown>;
  if(Object.keys(item).sort().join(',')!==
    'executionInstanceId,helper,helperExitCode,helperVersion,hostScopeId,kind,launchId,prepared,preparedClosed,protocol,recipe' ||
    item.kind!=='windows_app_server_not_started_v1'||item.protocol!=='windows_job_stdio_v1'||
    item.helperVersion!=='3'||item.recipe!==WINDOWS_APP_SERVER_RECIPE||item.helperExitCode!==0||
    typeof item.launchId!=='string'||!uuid.test(item.launchId)||
    typeof item.hostScopeId!=='string'||!uuid.test(item.hostScopeId)||
    typeof item.executionInstanceId!=='string'||!uuid.test(item.executionInstanceId)||
    !item.helper||typeof item.helper!=='object'||Array.isArray(item.helper)||
    !item.prepared||typeof item.prepared!=='object'||Array.isArray(item.prepared)||
    !item.preparedClosed||typeof item.preparedClosed!=='object'||Array.isArray(item.preparedClosed))return false;
  const helper=item.helper as Record<string,unknown>;
  const prepared=item.prepared as Record<string,unknown>;
  const closed=item.preparedClosed as Record<string,unknown>;
  if(Object.keys(helper).sort().join(',')!=='creationFiletime,pid'||
    !Number.isSafeInteger(helper.pid)||(helper.pid as number)<1||(helper.pid as number)>0xffff_ffff||
    typeof helper.creationFiletime!=='string'||
    !/^[1-9][0-9]{0,19}$/.test(helper.creationFiletime)||
    BigInt(helper.creationFiletime)>0xffff_ffff_ffff_ffffn||
    Object.keys(prepared).sort().join(',')!=='childPresent,kind,sequence'||
    prepared.kind!=='prepared'||prepared.sequence!==1||prepared.childPresent!==false||
    Object.keys(closed).sort().join(',')!=='childPresent,kind,members,sequence'||
    closed.kind!=='prepared_closed'||closed.sequence!==2||closed.childPresent!==false||
    !closed.members||typeof closed.members!=='object'||Array.isArray(closed.members))return false;
  const members=closed.members as Record<string,unknown>;
  return Object.keys(members).sort().join(',')==='assigned,complete,listed,pids'&&
    members.complete===true&&members.assigned===0&&members.listed===0&&
    Array.isArray(members.pids)&&members.pids.length===0;
}

export function validWindowsAppServerNotStartedRecord(value:unknown):
  value is WindowsAppServerNotStartedRecord {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const item=value as Record<string,unknown>;
  return Object.keys(item).sort().join(',')==='launchId,observation,recordedAt'&&
    validWindowsAppServerNotStartedObservation(item.observation)&&
    item.launchId===(item.observation as WindowsAppServerNotStartedObservation).launchId&&
    typeof item.recordedAt==='string'&&Number.isFinite(Date.parse(item.recordedAt))&&
    new Date(item.recordedAt).toISOString()===item.recordedAt;
}
