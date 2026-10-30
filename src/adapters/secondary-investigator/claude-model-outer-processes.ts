import { isDeepStrictEqual } from 'node:util';
import type { ClaudeModelOuterProbeInput, ClaudeModelOuterRawProbe,
  ClaudeModelOuterProcessSnapshot } from './claude-model-outer-probe.js';
import { buildClaudeModelSealedLaunch } from './claude-model-sealed-launch.js';
import { claudeModelSupervisorSpec, type ClaudeModelLaunchLimits } from './claude-model-supervisor.js';
import { claudeModelRunningSpec } from './claude-model-running-observer.js';
import { parseClaudeModelStartup } from './claude-model-startup.js';
import { parseHistoricalClaudeModelStartup } from './claude-model-startup.js';
import { historicalClaudeModelParentArgv, historicalClaudeModelRecipe } from './claude-model-historical.js';
import { parseLinuxProcessStat } from './linux-proc-identity.js';

const roles = ['parent','wrapper','outer','bootstrap'] as const;
const namespaces = ['pid','mnt','net','user','ipc','uts','cgroup'] as const;
const selected = ['PPid','Uid','Gid','NSpid','CapInh','CapPrm','CapEff','CapBnd','CapAmb','NoNewPrivs'];
const caps = ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'];
const exact = (value: object, keys: readonly string[]) => Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value,key));
function require(condition: unknown): asserts condition {
  if (!condition) throw new Error('INVALID_MODEL_OUTER_PROCESS_GRAPH');
}
function expectedParentArgv(input: ClaudeModelOuterProbeInput,
  limits: ClaudeModelLaunchLimits): readonly string[] {
  const spec = claudeModelSupervisorSpec('enter_wait_exec',input.descriptor,
    input.running.resource.gate!.root,input.paths,undefined,limits,input.profile);
  return spec.args.slice(spec.args.indexOf('/usr/bin/python3'));
}
export function currentClaudeModelParentCmdline(input: ClaudeModelOuterProbeInput,
  limits: ClaudeModelLaunchLimits): string {
  return expectedParentArgv(input,limits).join('\0')+'\0';
}
function decimal(value: string): number {
  require(/^(0|[1-9][0-9]*)$/.test(value)); const parsed=Number(value);
  require(Number.isSafeInteger(parsed)); return parsed;
}
function numbers(value: string): number[] {
  return value.trim().split(/[ \t]+/).map(decimal);
}
function status(raw: string): Record<string,string> {
  require(typeof raw==='string' && Buffer.byteLength(raw)<=8192 && raw.endsWith('\n') &&
    !raw.includes('\0') && !raw.includes('\r'));
  const fields: Record<string,string> = {};
  for(const line of raw.trimEnd().split('\n')) {
    const colon=line.indexOf(':'); require(colon>0);
    const key=line.slice(0,colon);
    if(selected.includes(key)) {require(!Object.hasOwn(fields,key));fields[key]=line.slice(colon+1).trim();}
  }
  require(exact(fields,selected)); return fields;
}
type Fd = ClaudeModelOuterProcessSnapshot['fds'][number];
function fdFields(fd: Fd): Record<string,string> {
  require(Number.isSafeInteger(fd.fd) && fd.fd>=0 && typeof fd.target==='string' &&
    typeof fd.fdinfo==='string' && Buffer.byteLength(fd.fdinfo)<=4096 && fd.fdinfo.endsWith('\n'));
  const fields: Record<string,string>={};
  for(const row of fd.fdinfo.trimEnd().split('\n')) {
    const colon=row.indexOf(':');require(colon>0);
    const key=row.slice(0,colon);require(!Object.hasOwn(fields,key));fields[key]=row.slice(colon+1).trim();
  }
  require(['pos','flags','mnt_id','ino'].every(k=>Object.hasOwn(fields,k)));
  for(const k of ['pos','mnt_id','ino']) decimal(fields[k]!);
  require(/^[0-7]{1,12}$/.test(fields.flags!));const flags=BigInt(`0o${fields.flags!}`);
  require(flags<=0xffffffffn);
  require(fd.direction===['read','write','readwrite','invalid'][Number(flags&3n)] && fd.direction!=='invalid');
  return fields;
}
function pipe(fd: Fd, direction: string): string {
  const fields=fdFields(fd);const match=/^pipe:\[([1-9][0-9]*)\]$/.exec(fd.target);
  require(match && fd.direction===direction && fields.ino===match[1] &&
    exact(fields,['pos','flags','mnt_id','ino']));return fd.target;
}
function anonymous(fd: Fd, type: 'eventfd'|'signalfd'): Record<string,string> {
  const fields=fdFields(fd);require(fd.target===`anon_inode:[${type}]` && fd.direction==='readwrite' &&
    BigInt(`0o${fields.flags!}`)===0o2004002n);
  if(type==='eventfd') {
    require(exact(fields,['pos','flags','mnt_id','ino','eventfd-count','eventfd-id','eventfd-semaphore']) &&
      /^[0-9a-f]+$/.test(fields['eventfd-count']!) && BigInt(`0x${fields['eventfd-count']!}`)===0n &&
      decimal(fields['eventfd-id']!)>0 && fields['eventfd-semaphore']==='0');
  } else require(exact(fields,['pos','flags','mnt_id','ino','sigmask']) &&
    /^[0-9a-f]{16}$/.test(fields.sigmask!) && BigInt(`0x${fields.sigmask!}`)===0x10000n);
  return fields;
}
function fdGraph(probe: ClaudeModelOuterRawProbe, input: ClaudeModelOuterProbeInput): void {
  const {parent,wrapper,outer,bootstrap}=probe.processes;
  for(const role of roles) {
    const fds=probe.processes[role].fds;require(Array.isArray(fds) && fds.length<=32 &&
      new Set(fds.map(f=>f.fd)).size===fds.length);fds.forEach(fdFields);
  }
  for(const [subject,wanted] of [[wrapper,[0,1,2,3,4]],[outer,[0,1,2,4]],[bootstrap,[0,1,2]]] as const)
    require(isDeepStrictEqual(subject.fds.map(f=>f.fd).sort((a,b)=>a-b),wanted));
  const get=(subject:ClaudeModelOuterProcessSnapshot,fd:number)=>subject.fds.find(f=>f.fd===fd)!;
  const pipes=[0,1,2].map(fd=>pipe(get(outer,fd),fd===0?'read':'write'));
  require(new Set(pipes).size===3);
  const inverse: number[]=[];
  for(const fd of [0,1,2]) {
    for(const subject of [wrapper,bootstrap]) require(pipe(get(subject,fd),fd===0?'read':'write')===pipes[fd]);
    const matches=parent.fds.filter(f=>f.target===pipes[fd]);require(matches.length===1);
    pipe(matches[0]!,fd===0?'write':'read');inverse.push(matches[0]!.fd);
  }
  const eventOuter=anonymous(get(outer,4),'eventfd');const eventWrapper=anonymous(get(wrapper,4),'eventfd');
  require(isDeepStrictEqual(eventOuter,eventWrapper));anonymous(get(wrapper,3),'signalfd');
  for(const fd of [0,1,2]) pipe(get(parent,fd),fd===0?'read':'write');
  const root=input.running.resource.gate!.root;
  // open_root alternates 3/4 as it opens each next directory before closing the prior one.
  const owned=[get(parent,3),get(parent,4)];
  require(owned.filter(fd=>fd.target===root && fd.direction==='read').length===1 &&
    owned.filter(fd=>fd.target===`${root}/${input.descriptor.attemptId}.model-supervisor.lock` &&
      fd.direction==='readwrite').length===1);
  const other=parent.fds.filter(f=>![0,1,2,3,4,...inverse].includes(f.fd));
  const config=other.filter(f=>f.target==='/memfd:rcac-config (deleted)');
  require(config.length===3 && config.every(f=>f.fd>=32 && f.direction==='readwrite') &&
    new Set(config.map(f=>fdFields(f).ino)).size===3);
  const info=other.filter(f=>!config.includes(f));require(info.length===1 && info[0]!.fd>=32);
  const infoPipe=pipe(info[0]!,'read');require(!pipes.includes(infoPipe));
}

/** Pure validation of captured process samples. It grants no current OS or dispatch authority. */
export function validateClaudeModelOuterProcesses(input: ClaudeModelOuterProbeInput,
  probe: ClaudeModelOuterRawProbe,
  limits: ClaudeModelLaunchLimits | {maxWallSeconds:number}): boolean {
  try {
    const saved=structuredClone({input,probe,limits}); input=saved.input;probe=saved.probe;limits=saved.limits;
    const historical=exact(limits,['maxWallSeconds']);
    require(historical || exact(limits,['maxWallSeconds','maxTurns']));
    claudeModelRunningSpec(input.running.resource,input.running.journal,input.descriptor);
    const parsedStartup=(historical ? parseHistoricalClaudeModelStartup : parseClaudeModelStartup)(
      JSON.stringify(input.startup)+'\n',input.descriptor);
    require(isDeepStrictEqual(parsedStartup,input.startup) &&
      isDeepStrictEqual(input.startup.journal,{...input.running.journal,phase:'consumed'}));
    const launch=historical ? historicalClaudeModelRecipe(input.paths,input.profile) :
      buildClaudeModelSealedLaunch(input.paths,input.profile,(limits as ClaudeModelLaunchLimits).maxTurns);
    require(launch.commandDigest===input.descriptor.commandDigest);
    const capturedParent=probe.processes.parent.cmdline;
    require(capturedParent.endsWith('\0'));
    const capturedFields=capturedParent.slice(0,-1).split('\0');
    const parentArgv=historical ? historicalClaudeModelParentArgv(input.descriptor,
      input.running.resource.gate!.root,input.paths,input.profile,limits.maxWallSeconds,
      capturedFields[4]!,capturedFields[20]!) : expectedParentArgv(input,limits as ClaudeModelLaunchLimits);
    require(parentArgv!==null);
    const {parent,wrapper,outer,bootstrap}=probe.processes;
    const uid=input.descriptor.uid;require(uid>0 && probe.uid===uid && probe.bootId===input.descriptor.bootId);
    const expectedUnit={Id:input.descriptor.unitName,LoadState:'loaded',ActiveState:'active',SubState:'running',
      MainPID:String(input.running.journal.enterPid),InvocationID:input.running.resource.invocationId,
      ControlGroup:input.running.resource.controlGroup};
    require(isDeepStrictEqual(probe.unitBefore,expectedUnit) && isDeepStrictEqual(probe.unitAfter,expectedUnit));
    require(new Set(roles.map(role=>probe.processes[role].pid)).size===4 &&
      parent.pid===input.running.journal.enterPid && parent.startTicks===input.running.journal.enterStartTicks &&
      wrapper.ppid===parent.pid && outer.ppid===wrapper.pid && bootstrap.ppid===outer.pid &&
      outer.pid===input.startup.outerCandidate.hostPid && outer.startTicks===input.startup.outerCandidate.startTicks &&
      bootstrap.startTicks===input.startup.bootstrapReady.startTicks);
    require(exact(probe.observerNamespaces,namespaces));
    for(const key of namespaces) require(new RegExp(`^${key}:\\[[1-9][0-9]{0,15}\\]$`).test(probe.observerNamespaces[key]!));
    for(const role of roles) {
      const process=probe.processes[role], end=probe.endingIdentities[role];
      const raw=parseLinuxProcessStat(process.statRaw,process.pid),last=parseLinuxProcessStat(end.statRaw,end.pid);
      require(raw.parentPid===process.ppid && raw.startTicks===process.startTicks && raw.state===process.state &&
        last.parentPid===end.ppid && last.startTicks===end.startTicks && last.state===end.state &&
        end.pid===process.pid && end.ppid===process.ppid && end.startTicks===process.startTicks &&
        isDeepStrictEqual(end.namespaces,process.namespaces));
      require(exact(process.namespaces,namespaces));
      const parsed=status(process.statusRaw);require(isDeepStrictEqual(parsed,process.selectedStatus));
      require(decimal(parsed.PPid!)===process.ppid &&
        isDeepStrictEqual(numbers(parsed.Uid!),[uid,uid,uid,uid]) &&
        isDeepStrictEqual(numbers(parsed.Gid!),[uid,uid,uid,uid]));
      const sandbox=role==='outer'||role==='bootstrap';
      require(isDeepStrictEqual(numbers(parsed.NSpid!),sandbox?[process.pid,role==='outer'?1:2]:[process.pid]));
      for(const cap of caps) {require(/^[0-9a-f]{16}$/.test(parsed[cap]!));
        if(sandbox||cap!=='CapBnd') require(BigInt(`0x${parsed[cap]!}`)===0n);}
      require(sandbox||role==='wrapper'?parsed.NoNewPrivs==='1':['0','1'].includes(parsed.NoNewPrivs!));
      const wantedMap=sandbox?[uid,uid,1]:[0,0,4294967295];
      require(isDeepStrictEqual(numbers(process.uidMap),wantedMap) && isDeepStrictEqual(numbers(process.gidMap),wantedMap));
      require(process.cgroup===`0::${input.running.resource.controlGroup}\n`);
      if(sandbox) {
        require(isDeepStrictEqual(process.namespaces,input.startup.bootstrapReady.namespaces));
        const fields=process.statRaw.slice(process.statRaw.lastIndexOf(')')+2).trim().split(' ');
        require(decimal(fields[2]!)===outer.pid && decimal(fields[3]!)===outer.pid && fields[4]==='0');
        require(process.root==='/' && process.cwd==='/work');
        const view=probe.sandboxPidView[role];const local=role==='outer'?1:2;
        const localRaw=parseLinuxProcessStat(view.statRaw,local);
        require(view.localPid===local && view.startTicks===process.startTicks && localRaw.startTicks===view.startTicks &&
          localRaw.parentPid===(role==='outer'?0:1) && view.pidNamespace===process.namespaces.pid);
      } else require(isDeepStrictEqual(process.namespaces,probe.observerNamespaces));
    }
    for(const key of namespaces) require(key==='net'?
      outer.namespaces[key]===probe.observerNamespaces[key]:outer.namespaces[key]!==probe.observerNamespaces[key]);
    require(parent.cmdline===parentArgv.join('\0')+'\0' &&
      wrapper.cmdline===[launch.recipe.file,...launch.recipe.argv].join('\0')+'\0' &&
      outer.cmdline===wrapper.cmdline && bootstrap.cmdline===
        ['/usr/bin/python3','-I','-S','/opt/rcac-bootstrap.py',
          ...(historical ? [] : [String((limits as ClaudeModelLaunchLimits).maxTurns)])].join('\0')+'\0');
    require(/^\/usr\/bin\/python3(?:\.[0-9]+)?$/.test(parent.exe) && bootstrap.exe===parent.exe &&
      wrapper.exe==='/usr/bin/bwrap' && outer.exe===wrapper.exe);
    const paths=probe.sandboxPaths;require(paths.workEmpty===true &&
      isDeepStrictEqual(paths.outer.root,paths.bootstrap.root) &&
      isDeepStrictEqual(paths.outer.cwd,paths.work) && isDeepStrictEqual(paths.bootstrap.cwd,paths.work));
    for(const item of [paths.outer.root,paths.bootstrap.root,paths.outer.cwd,paths.bootstrap.cwd,paths.work])
      require(exact(item,['dev','ino','mode','uid','gid']) && item.mode===0o40755 && item.uid===uid && item.gid===uid &&
        Number.isSafeInteger(item.dev) && item.dev>=0 && Number.isSafeInteger(item.ino) && item.ino>0);
    require(paths.work.dev!==paths.outer.root.dev);
    fdGraph(probe,input);return true;
  } catch {return false;}
}
