import {normalizeCodexFailureCode} from '../runtime/codex-model-investigation.js';
import type {PersonalCodexDiagnostic} from '../runtime/codex-owned-investigation.js';

const requestIdPattern=/^inv_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const stages=new Set(['prepare','native_open','native_start',
 'protocol','settle','native_stop','initialize','thread_start','turn_start','wait_turn',
 'result_parse','evidence_validate','cleanup','admission']);
const helperStages=new Set(('ARGUMENTS ATTRIBUTE_HANDLES ATTRIBUTE_INIT ATTRIBUTE_JOB ATTRIBUTE_SIZE '+
 'CHILD_START CONFIG_FILE CONFIG_HASH CONFIG_PATH CONTROL_EOF CONTROL_INVALID CONTROL_LIMIT '+
 'CONTROL_ORDER CONTROL_TIMEOUT FIXTURE_FRAME HELPER_IDENTITY INPUT_TIMEOUT JOB_ACCOUNTING '+
 'JOB_CREATE JOB_LIMIT JOB_LIST_BOUNDS JOB_LIST_DUPLICATE JOB_LIST_INCOMPLETE JOB_LIST_PID '+
 'JOB_LIST_TRUNCATED JOB_NOT_EMPTY JOB_TERMINATE PIPE_CONNECT PIPE_CREATE PIPE_DACL '+
 'PIPE_INHERIT PIPE_LIMIT PRE_RESUME_MEMBERSHIP PREPARED_DEADLINE PROCESS_CREATE '+
 'PROCESS_IDENTITY PROCESS_RESUME ROOT_WAIT STDIN_WRITE TREE_NOT_STABLE WRITER_DEADLINE '+
 'WRITER_FRAME_LIMIT WRITER_FRAME WRITER_HANDLE WRITER_IMAGE WRITER_ORIGIN '+
 'WRITER_PIPE_MODE WRITER_PIPE_SERVER WRITER_PIPE_TYPE WRITER_PROCESS WRITER_UNKNOWN '+
 'HOST_UNKNOWN STDIO_UNKNOWN CHILD_UNKNOWN unknown').split(' '));
const spawnErrors=new Set(['EPERM','EACCES','ENOENT','EINVAL','EAGAIN','ENOMEM','unknown']);
const signals=new Set(['SIGTERM','SIGKILL','SIGINT','SIGHUP','SIGBREAK','SIGABRT']);
const safeStage=(value:unknown)=>typeof value==='string'&&stages.has(value)?value:'unknown';
const safeCode=(value:unknown)=>typeof value==='string'?normalizeCodexFailureCode(new Error(value)):'INTERNAL_ERROR';
const safeBoolean=(value:unknown)=>value===true;

/** CLI-only, best-effort sink. Never serialize the source diagnostic or an Error object. */
export function createCliCodexDiagnosticSink(write:(line:string)=>unknown=(line)=>process.stderr.write(line)):
 (diagnostic:PersonalCodexDiagnostic)=>void {
 return diagnostic=>{
  try{
   if(!requestIdPattern.test(diagnostic.requestId)&&diagnostic.requestId!=='managed_queue')return;
   const failure=diagnostic.failure;
   const cleanupFailure=diagnostic.cleanupFailure;
   const prepared=diagnostic.preparedFailure;
   const fact={kind:'codex_managed_diagnostic',requestId:diagnostic.requestId,
    ...(failure?{failure:{stage:safeStage(failure.stage),code:safeCode(failure.code)}}:{}),
    ...(cleanupFailure?{cleanupFailure:{stage:safeStage(cleanupFailure.stage),code:safeCode(cleanupFailure.code)}}:{}),
    ...(prepared?{preparedFailure:{
     helperStage:helperStages.has(prepared.helperStage)?prepared.helperStage:'unknown',
     helperCloseObserved:safeBoolean(prepared.helperCloseObserved),
     exitCode:Number.isSafeInteger(prepared.exitCode)&&prepared.exitCode!==null&&
      prepared.exitCode>=0&&prepared.exitCode<=0xffffffff?prepared.exitCode:null,
     signal:prepared.signal!==null&&signals.has(prepared.signal)?prepared.signal:null,
     forcedKill:safeBoolean(prepared.forcedKill),
     startWriteAttempted:safeBoolean(prepared.startWriteAttempted),
     protocolFault:safeBoolean(prepared.protocolFault),
     spawnError:prepared.spawnError!==null&&spawnErrors.has(prepared.spawnError)?prepared.spawnError:null}}:{})};
   void Promise.resolve(write(`${JSON.stringify(fact)}\n`)).catch(()=>undefined);
  }catch{/* Diagnostics cannot alter settlement or the external result. */}
 };
}
