/** Source-only, one-turn synthetic Windows App Server transcript. Never a production investigator claim. */
import {createHash} from 'node:crypto';
import {REPO_READ_DYNAMIC_TOOL,parseCodexRepoReadArguments} from '../src/adapters/codex/protocol/repo-read-tool.js';
import type {ManagedLoginOwner} from './windows-qualification-login-protocol.js';

type Json=Record<string,unknown>;
type State='new'|'thread_start_sent'|'thread_bound'|'turn_start_sent'|'turn_bound'|'interrupt_sent'|'terminal'|'failed';
const record=(v:unknown):v is Json=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Json,expected:readonly string[])=>Object.keys(v).sort().join(',')===[...expected].sort().join(',');
const fixedError=()=>new Error('QUALIFICATION_TURN_PROTOCOL');
const opaqueId=(value:string)=>Buffer.byteLength(value,'utf8')>=1&&
 Buffer.byteLength(value,'utf8')<=128&&[...value].every(char=>{
  const code=char.codePointAt(0)!;return code>=32&&code!==127;
 });
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const sameOwner=(a:ManagedLoginOwner,b:ManagedLoginOwner)=>a.hostScopeId===b.hostScopeId&&
 a.executionInstanceId===b.executionInstanceId&&a.helperPid===b.helperPid&&
 a.helperCreationFiletime===b.helperCreationFiletime;
export const SYNTHETIC_TURN_PROMPT='Read only README.md through repo.read once. Return a short JSON finding about this synthetic source. Do not infer access to any other file.';
const OUTPUT_SCHEMA=Object.freeze({type:'object',additionalProperties:false,required:['finding'],
 properties:{finding:{type:'string',maxLength:2048}}});
export function qualificationModelReadinessAllowsLogin(readiness:unknown):boolean{return readiness==='ready';}

export interface QualificationToolCall {readonly serverId:string|number;readonly callId:string;
 readonly turnId:string;
 readonly arguments:ReturnType<typeof parseCodexRepoReadArguments>}

/** All input is untrusted App Server JSON except the fixed owner and local synthetic cwd. */
export class FixedQualificationTurn{
 private state:State='new';
 private readonly owner:ManagedLoginOwner;
 private readonly cwd:string;
 private threadId:string|null=null;
 private turnId:string|null=null;
 private observedThreadId:string|null=null;
 private observedTurnId:string|null=null;
 private readonly lifecycleSeen=new Set<string>();
 private readonly messageItems=new Map<string,{type:string;completed:boolean}>();
 private messageDeltaBytes=0;
 private readonly finalCandidates=new Map<string,string>();
 private terminalStatus:'completed'|'interrupted'|'failed'|null=null;
 private findingStatus:'missing'|'valid'|'invalid'='missing';
 private findingSha256:string|null=null;
 private findingBytes=0;
 private successfulReads=0;
 private readonly calls:QualificationToolCall[]=[];
 private readonly queued:QualificationToolCall[]=[];
 private readonly outstanding=new Set<string>();
 private readonly serverIds=new Set<string>();
 private readonly callIds=new Set<string>();
 private turnStartStatus:'inProgress'|'completed'|null=null;
 private interruptAckObserved=false;
 private interruptRequested=false;
 constructor(owner:ManagedLoginOwner,cwd:string){
  if(!record(owner)||typeof owner.hostScopeId!=='string'||!owner.hostScopeId||
   typeof owner.executionInstanceId!=='string'||!owner.executionInstanceId||
   !Number.isSafeInteger(owner.helperPid)||owner.helperPid<1||
   typeof owner.helperCreationFiletime!=='string'||!/^[1-9][0-9]{0,19}$/.test(owner.helperCreationFiletime)||
   typeof cwd!=='string'||!/^([A-Z]:\\)/.test(cwd)||cwd.includes('/')||cwd.includes('..')||cwd.length>512)
   throw fixedError();
  this.owner=Object.freeze({hostScopeId:owner.hostScopeId,executionInstanceId:owner.executionInstanceId,
   helperPid:owner.helperPid,helperCreationFiletime:owner.helperCreationFiletime});
  this.cwd=cwd;
 }
 private reject():never{this.state='failed';throw fixedError();}
 private owned(source:ManagedLoginOwner):void{if(!sameOwner(this.owner,source))this.reject();}
 threadStartRequest(){
  if(this.state!=='new')this.reject();this.state='thread_start_sent';
  return {id:6,method:'thread/start',params:{cwd:this.cwd,permissions:'rcac_static',
   model:'gpt-6-sol',allowProviderModelFallback:false,approvalPolicy:'never',
   dynamicTools:[REPO_READ_DYNAMIC_TOOL],environments:[],runtimeWorkspaceRoots:[this.cwd],
   ephemeral:true,serviceTier:'default'}} as const;
 }
 acceptThreadStart(reply:unknown,source:ManagedLoginOwner):void{
  this.owned(source);
  if(this.state!=='thread_start_sent'||!record(reply)||!keys(reply,['id','result'])||reply.id!==6||
   !record(reply.result)||!record(reply.result.thread)||typeof reply.result.thread.id!=='string'||
   !opaqueId(reply.result.thread.id)||reply.result.thread.cwd!==this.cwd||reply.result.cwd!==this.cwd||
   reply.result.model!=='gpt-6-sol'||typeof reply.result.modelProvider!=='string'||!reply.result.modelProvider||
   reply.result.approvalPolicy!=='never'||
   !['user','auto_review','guardian_subagent'].includes(String(reply.result.approvalsReviewer))||
   !record(reply.result.sandbox)||reply.result.sandbox.type!=='readOnly'||
   reply.result.sandbox.networkAccess===true||
   (reply.result.sandbox.networkAccess!==undefined&&reply.result.sandbox.networkAccess!==false)||
   !record(reply.result.activePermissionProfile)||reply.result.activePermissionProfile.id!=='rcac_static'||
   !Array.isArray(reply.result.runtimeWorkspaceRoots)||reply.result.runtimeWorkspaceRoots.length!==0)this.reject();
  if(this.observedThreadId&&this.observedThreadId!==reply.result.thread.id)this.reject();
  this.threadId=reply.result.thread.id;this.state='thread_bound';
 }
 turnStartRequest(){
  if(this.state!=='thread_bound'||!this.threadId)this.reject();this.state='turn_start_sent';
  return {id:7,method:'turn/start',params:{threadId:this.threadId,permissions:'rcac_static',
   approvalPolicy:'never',cwd:this.cwd,environments:[],runtimeWorkspaceRoots:[this.cwd],
   input:[{type:'text',text:SYNTHETIC_TURN_PROMPT,text_elements:[]}],
   outputSchema:OUTPUT_SCHEMA,effort:'medium',serviceTierForTurn:'default'}} as const;
 }
 acceptTurnStart(reply:unknown,source:ManagedLoginOwner):void{
  this.owned(source);
  if(this.state!=='turn_start_sent'||!record(reply)||!keys(reply,['id','result'])||reply.id!==7||
   !record(reply.result)||!record(reply.result.turn)||typeof reply.result.turn.id!=='string'||
   !opaqueId(reply.result.turn.id)||!['inProgress','completed'].includes(String(reply.result.turn.status))||
   !Array.isArray(reply.result.turn.items))this.reject();
  if(this.observedTurnId&&this.observedTurnId!==reply.result.turn.id)this.reject();
  this.turnId=reply.result.turn.id;
  this.turnStartStatus=reply.result.turn.status as 'inProgress'|'completed';
  if(this.calls.some(call=>call.turnId!==this.turnId)||
   (this.turnStartStatus==='completed'&&this.calls.length))this.reject();
  this.state='turn_bound';
 }
 observeLifecycle(notification:unknown,source:ManagedLoginOwner):void{
  this.owned(source);
  if(!record(notification)||!(keys(notification,['method','params'])||
   (keys(notification,['method','params','emittedAtMs'])&&Number.isSafeInteger(notification.emittedAtMs)))||
   !record(notification.params)||typeof notification.method!=='string'||
   this.lifecycleSeen.has(notification.method))this.reject();
  const params=notification.params;
  if(notification.method==='thread/started'){
   if(!['thread_start_sent','thread_bound'].includes(this.state)||!record(params.thread)||
    typeof params.thread.id!=='string'||!opaqueId(params.thread.id)||
    params.thread.cwd!==this.cwd||(this.threadId!==null&&params.thread.id!==this.threadId))this.reject();
   this.observedThreadId=params.thread.id;
  }else if(notification.method==='turn/started'){
   if(!['turn_start_sent','turn_bound'].includes(this.state)||params.threadId!==this.threadId||
    !record(params.turn)||typeof params.turn.id!=='string'||!opaqueId(params.turn.id)||
    (this.turnId!==null&&params.turn.id!==this.turnId))this.reject();
   this.observedTurnId=params.turn.id;
  }else this.reject();
  this.lifecycleSeen.add(notification.method);
 }
 observeStatus(notification:unknown,source:ManagedLoginOwner):void{
  this.owned(source);
  if(!['thread_start_sent','thread_bound','turn_start_sent','turn_bound','interrupt_sent','terminal'].includes(this.state)||
   !record(notification)||!(keys(notification,['method','params'])||
    (keys(notification,['method','params','emittedAtMs'])&&Number.isSafeInteger(notification.emittedAtMs)))||
   !record(notification.params)||notification.params.threadId!==(this.threadId??this.observedThreadId))this.reject();
  const p=notification.params;
  if(notification.method==='thread/status/changed'){
   if(!keys(p,['threadId','status'])||!record(p.status)||
    !['active','idle','notLoaded','systemError'].includes(String(p.status.type)))this.reject();
  }else if(notification.method==='thread/tokenUsage/updated'){
   if(!keys(p,['threadId','turnId','tokenUsage'])||typeof p.turnId!=='string'||
    p.turnId!==(this.turnId??this.observedTurnId)||!record(p.tokenUsage))this.reject();
  }else this.reject();
 }
 observeItem(notification:unknown,source:ManagedLoginOwner):void{
  this.owned(source);
  if(!['turn_start_sent','turn_bound','interrupt_sent'].includes(this.state)||
   !record(notification)||!(keys(notification,['method','params'])||
    (keys(notification,['method','params','emittedAtMs'])&&Number.isSafeInteger(notification.emittedAtMs)))||
   !record(notification.params)||notification.params.threadId!==this.threadId||
   typeof notification.params.turnId!=='string'||!opaqueId(notification.params.turnId)||
   (this.turnId!==null&&notification.params.turnId!==this.turnId)||
   (this.observedTurnId!==null&&notification.params.turnId!==this.observedTurnId))this.reject();
  const p=notification.params;
  if(this.turnId===null){
   if(this.observedTurnId!==null&&this.observedTurnId!==p.turnId)this.reject();
   this.observedTurnId=p.turnId as string;
  }
  if(['item/agentMessage/delta','item/reasoning/summaryTextDelta',
   'item/reasoning/summaryPartAdded','item/reasoning/textDelta'].includes(String(notification.method))){
   const reasoning=notification.method!=='item/agentMessage/delta';
   const expected=notification.method==='item/agentMessage/delta'?['threadId','turnId','itemId','delta']:
    notification.method==='item/reasoning/summaryPartAdded'?['threadId','turnId','itemId','summaryIndex']:
    notification.method==='item/reasoning/summaryTextDelta'?['threadId','turnId','itemId','summaryIndex','delta']:
    ['threadId','turnId','itemId','contentIndex','delta'];
   const index=notification.method==='item/reasoning/textDelta'?p.contentIndex:p.summaryIndex;
   if(!keys(p,expected)||typeof p.itemId!=='string'||
    (reasoning&&!Number.isSafeInteger(index))||
    (notification.method!=='item/reasoning/summaryPartAdded'&&typeof p.delta!=='string')||
    this.messageItems.get(p.itemId)?.type!==(reasoning?'reasoning':'agentMessage')||
    this.messageItems.get(p.itemId)?.completed)this.reject();
   if(typeof p.delta==='string')this.messageDeltaBytes+=Buffer.byteLength(p.delta,'utf8');
   if(this.messageDeltaBytes>8192)this.reject();
   return;
  }
  const started=notification.method==='item/started',completed=notification.method==='item/completed';
  if((!started&&!completed)||!keys(p,started?
   ['threadId','turnId','startedAtMs','item']:['threadId','turnId','completedAtMs','item'])||
   !Number.isSafeInteger(started?p.startedAtMs:p.completedAtMs)||!record(p.item)||
   typeof p.item.id!=='string'||!opaqueId(p.item.id)||
   !['agentMessage','reasoning','dynamicToolCall','userMessage'].includes(String(p.item.type)))this.reject();
  if(p.item.type==='userMessage'){
   if(!Array.isArray(p.item.content)||p.item.content.length!==1||
    !record(p.item.content[0])||
    !(keys(p.item.content[0],['type','text'])||
     (keys(p.item.content[0],['type','text','text_elements'])&&
      Array.isArray(p.item.content[0].text_elements)&&p.item.content[0].text_elements.length===0))||
    p.item.content[0].type!=='text'||p.item.content[0].text!==SYNTHETIC_TURN_PROMPT)this.reject();
  }
  if(p.item.type==='dynamicToolCall'){
   let parsed:ReturnType<typeof parseCodexRepoReadArguments>;
   try{parsed=parseCodexRepoReadArguments(p.item.arguments);}catch{this.reject();}
   if(p.item.namespace!=='repo'||p.item.tool!=='read'||parsed.path!=='README.md'||
    !['inProgress','completed','failed'].includes(String(p.item.status)))this.reject();
  }
  const itemId=p.item.id;
  if(started){
   if(this.messageItems.has(itemId)||this.messageItems.size>=16)this.reject();
   this.messageItems.set(itemId,{type:p.item.type as string,completed:false});
  }else{
   const existing=this.messageItems.get(itemId);
   if(!existing||existing.completed||existing.type!==p.item.type)this.reject();
   existing.completed=true;
   if(p.item.type==='agentMessage'&&(p.item.phase===undefined||p.item.phase===null||
    p.item.phase==='final_answer')){
    if(typeof p.item.text!=='string'||Buffer.byteLength(p.item.text,'utf8')>8192||
     this.finalCandidates.has(itemId))this.reject();
    this.finalCandidates.set(itemId,p.item.text);
   }
  }
 }
 acceptToolCall(request:unknown,source:ManagedLoginOwner):{queued:boolean;call:QualificationToolCall}{
  this.owned(source);
  if(!['turn_start_sent','turn_bound'].includes(this.state)||this.turnStartStatus==='completed'||
   !record(request)||!keys(request,['id','method','params'])||
   request.method!=='item/tool/call'||!record(request.params)||
   !keys(request.params,['threadId','turnId','callId','namespace','tool','arguments'])||
   request.params.threadId!==this.threadId||typeof request.params.turnId!=='string'||
   !opaqueId(request.params.turnId)||
   (this.turnId!==null&&request.params.turnId!==this.turnId)||
   request.params.namespace!=='repo'||request.params.tool!=='read'||
   typeof request.params.callId!=='string'||!opaqueId(request.params.callId)||
   !(typeof request.id==='string'?opaqueId(request.id):
    (typeof request.id==='number'&&Number.isSafeInteger(request.id)))||this.calls.length>=3||
   this.callIds.has(request.params.callId)||this.serverIds.has(String(request.id)))this.reject();
  let args:ReturnType<typeof parseCodexRepoReadArguments>;
  try{args=parseCodexRepoReadArguments(request.params.arguments);}catch{this.reject();}
  if(args.path!=='README.md')this.reject();
  const call=Object.freeze({serverId:request.id as string|number,callId:request.params.callId,
   turnId:request.params.turnId,arguments:args});
  this.calls.push(call);this.callIds.add(call.callId);this.serverIds.add(String(call.serverId));
  this.outstanding.add(call.callId);
  if(this.state==='turn_start_sent')this.queued.push(call);
  return {queued:this.state==='turn_start_sent',call};
 }
 queuedToolCalls():readonly QualificationToolCall[]{return this.state==='turn_bound'?this.queued.splice(0):[];}
 completeToolCall(call:QualificationToolCall,readResult:unknown):object{
  if(this.state!=='turn_bound'||!this.outstanding.has(call.callId)||
   !this.calls.some(item=>item===call)||!record(readResult))this.reject();
  const text=JSON.stringify(readResult);
  if(Buffer.byteLength(text,'utf8')>32*1024)this.reject();
  this.outstanding.delete(call.callId);
  this.successfulReads++;
  return {id:call.serverId,result:{success:true,contentItems:[{type:'inputText',text}]}};
 }
 failToolCall(call:QualificationToolCall):object{
  if(this.state!=='turn_bound'||!this.outstanding.has(call.callId)||
   !this.calls.some(item=>item===call))this.reject();
  this.outstanding.delete(call.callId);
  return {id:call.serverId,result:{success:false,contentItems:[{type:'inputText',text:'read denied'}]}};
 }
 interruptRequest(){
  if(this.state!=='turn_bound'||!this.threadId||!this.turnId)this.reject();
  this.state='interrupt_sent';
  this.interruptRequested=true;
  return {id:8,method:'turn/interrupt',params:{threadId:this.threadId,turnId:this.turnId}} as const;
 }
 acceptInterrupt(reply:unknown,source:ManagedLoginOwner):void{
  this.owned(source);
  if(!this.interruptRequested||this.interruptAckObserved||
   !['interrupt_sent','terminal'].includes(this.state)||!record(reply)||!keys(reply,['id','result'])||
   reply.id!==8||!record(reply.result)||Object.keys(reply.result).length!==0)this.reject();
  this.interruptAckObserved=true;
 }
 acceptTurnCompleted(notification:unknown,source:ManagedLoginOwner):void{
  this.owned(source);
  const envelope=record(notification)&&
   (keys(notification,['method','params'])||
    (keys(notification,['method','params','emittedAtMs'])&&
     Number.isSafeInteger(notification.emittedAtMs)));
  if(!['turn_bound','interrupt_sent'].includes(this.state)||
   !envelope||!record(notification)||
   notification.method!=='turn/completed'||!record(notification.params)||
   notification.params.threadId!==this.threadId||!record(notification.params.turn)||
   notification.params.turn.id!==this.turnId||
   !['completed','interrupted','failed'].includes(String(notification.params.turn.status))||
   !Array.isArray(notification.params.turn.items)||
   (notification.params.turn.status==='completed'&&this.outstanding.size>0))this.reject();
  this.terminalStatus=notification.params.turn.status as 'completed'|'interrupted'|'failed';
  if(this.terminalStatus==='completed'){
   const final=new Map(this.finalCandidates);
   for(const item of notification.params.turn.items as unknown[]){
    if(!record(item)||item.type!=='agentMessage'||
     !(item.phase===undefined||item.phase===null||item.phase==='final_answer'))continue;
    if(typeof item.id!=='string'||typeof item.text!=='string'||
     (final.has(item.id)&&final.get(item.id)!==item.text))this.reject();
    final.set(item.id,item.text);
   }
   if(final.size>0){
    this.findingStatus='invalid';
    if(final.size===1){
     const raw=[...final.values()][0]!;
     this.findingBytes=Buffer.byteLength(raw,'utf8');
     this.findingSha256=hash(raw);
     if(this.findingBytes<=8192){
      try{const parsed:unknown=JSON.parse(raw);
       if(record(parsed)&&keys(parsed,['finding'])&&typeof parsed.finding==='string'&&
        parsed.finding.length>0&&parsed.finding.length<=2048)this.findingStatus='valid';
      }catch{/* Invalid output remains diagnostic only. */}
     }
    }
   }
  }
  this.state='terminal';
 }
 summary(){return Object.freeze({status:this.state,threadIdSha256:this.threadId?hash(this.threadId):null,
  turnIdSha256:this.turnId?hash(this.turnId):null,toolCalls:this.calls.length,
  successfulReads:this.successfulReads,terminalStatus:this.terminalStatus,
  interruptAckObserved:this.interruptAckObserved,
  findingStatus:this.findingStatus,findingSha256:this.findingSha256,findingBytes:this.findingBytes});}
}

/** Zero-model diagnostic: one thread/start, no turn, tool, login or approval path. */
export class FixedQualificationThreadStartOnly{
 private readonly turn:FixedQualificationTurn;
 private readonly owner:ManagedLoginOwner;
 private status:'new'|'pending'|'accepted'|'rejected'|'unknown'='new';
 private observedStarted=false;
 private scopedThreadId:string|null=null;
 private readonly warnings:{sha256:string;bytes:number}[]=[];
 private warningBytes=0;
 private rejectionMessage:string|null=null;
 private failureReason:'wrong_owner'|'state'|'unexpected_method'|'replyid'|
  'error_envelope'|'lifecycle'|'result_projection'|'warning'|null=null;
 constructor(owner:ManagedLoginOwner,cwd:string){
  this.turn=new FixedQualificationTurn(owner,cwd);
  this.owner=Object.freeze({hostScopeId:owner.hostScopeId,
   executionInstanceId:owner.executionInstanceId,helperPid:owner.helperPid,
   helperCreationFiletime:owner.helperCreationFiletime});
 }
 private reject(reason:NonNullable<typeof this.failureReason>):never{
  this.status='unknown';this.failureReason??=reason;
  throw new Error('QUALIFICATION_THREAD_START_PROTOCOL');
 }
 start(){if(this.status!=='new')this.reject('state');this.status='pending';return this.turn.threadStartRequest();}
 markUnknown(){if(this.status!=='pending')this.reject('state');this.status='unknown';}
 accept(event:unknown,source:ManagedLoginOwner):'pending'|'accepted'|'rejected'{
  if(!sameOwner(this.owner,source))this.reject('wrong_owner');
  if(!['pending','accepted'].includes(this.status))this.reject('state');
  if(!record(event))this.reject('unexpected_method');
  let reason:NonNullable<typeof this.failureReason>='unexpected_method';
  try{
   if(event.method==='thread/started'){
    reason='lifecycle';if(this.observedStarted)this.reject(reason);
    this.turn.observeLifecycle(event,source);this.observedStarted=true;
    this.scopedThreadId=(event.params as {thread:{id:string}}).thread.id;
    return this.status as 'pending'|'accepted';
   }
   if(event.method==='warning'){
    reason='warning';
    if(!(keys(event,['method','params'])||
      (keys(event,['method','params','emittedAtMs'])&&
       Number.isSafeInteger(event.emittedAtMs)&&Number(event.emittedAtMs)>=0))||
     !record(event.params)||!keys(event.params,['message','threadId'])||
     this.scopedThreadId===null||event.params.threadId!==this.scopedThreadId||
     typeof event.params.message!=='string')this.reject(reason);
    const bytes=Buffer.byteLength(event.params.message,'utf8');
    if(bytes>4096||this.warnings.length>=4||this.warningBytes+bytes>8192)this.reject(reason);
    this.warningBytes+=bytes;
    this.warnings.push({sha256:hash(event.params.message),bytes});
    return this.status as 'pending'|'accepted';
   }
   if(event.method==='thread/status/changed'){
    reason='lifecycle';
    this.turn.observeStatus(event,source);return this.status as 'pending'|'accepted';
   }
   if(event.id===6&&'error'in event){
    reason='error_envelope';
    if(this.status!=='pending')this.reject('state');
    if(
    Object.keys(event).sort().join(',')==='error,id'&&record(event.error)&&
    (keys(event.error,['code','message'])||keys(event.error,['code','message','data']))&&
    Number.isSafeInteger(event.error.code)&&typeof event.error.message==='string'&&
    Buffer.byteLength(event.error.message,'utf8')<=4096&&
     !this.observedStarted){this.rejectionMessage=event.error.message;
      this.status='rejected';return 'rejected';}
    this.reject(reason);
   }
   if(event.id===6){
    if(this.status!=='pending')this.reject('state');
    reason='result_projection';
    this.turn.acceptThreadStart(event,source);
    this.scopedThreadId=(event.result as {thread:{id:string}}).thread.id;
    this.status='accepted';return 'accepted';
   }
   if('id'in event)reason='replyid';
  }catch{this.reject(reason);}
  this.reject(reason);
 }
 privateErrorMessage():string|null{return this.status==='rejected'?this.rejectionMessage:null;}
 summary(){const message=this.privateErrorMessage();return Object.freeze({status:this.status,
  threadIdSha256:this.turn.summary().threadIdSha256,observedStarted:this.observedStarted,
  rejectionMessageSha256:message===null?null:hash(message),
  rejectionMessageBytes:message===null?0:Buffer.byteLength(message,'utf8'),
  warningCount:this.warnings.length,warningBytes:this.warningBytes,
  warningSha256:Object.freeze(this.warnings.map(item=>item.sha256)),
  failureReason:this.failureReason});}
}
