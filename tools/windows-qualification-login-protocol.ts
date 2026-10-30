/** Source-only, synthetic managed browser login transcript. This is not investigator admission. */
import {createHash} from 'node:crypto';

type Json = Record<string,unknown>;
export interface ManagedLoginOwner {
 readonly hostScopeId:string;
 readonly executionInstanceId:string;
 readonly helperPid:number;
 readonly helperCreationFiletime:string;
}
type State='new'|'ready'|'start_sent'|'pending'|'cancel_requested'|'cancel_ack'|
 'success'|'failed'|'canceled';
type Stage='config'|'start'|'handoff'|'completion'|'cancel';
type Reason='owner'|'state'|'envelope'|'login_id_missing'|'login_id_null'|
 'login_id_type'|'login_id_mismatch'|'success_type'|'error_type'|'error_on_success'|
 'url'|'start_variant'|'config'|'handoff_failed';
type Violation=Readonly<{stage:Stage;stateBefore:State;reason:Reason}>;
type CompletionShape=Readonly<{hasEmittedAtMs:boolean;emittedAtMsValid:boolean;
 unexpectedKeyCount:number;paramsIsObject:boolean;hasId:boolean}>;
const record=(value:unknown):value is Json=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fixedError=()=>new Error('QUALIFICATION_LOGIN_PROTOCOL');
const hasControl=(value:string)=>{
 for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);if(code<32||code===127)return true;}
 return false;
};
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const samePath=(actual:unknown,expected:string)=>typeof actual==='string'&&
 actual.replaceAll('/','\\').toLowerCase()===expected.replaceAll('/','\\').toLowerCase();
const exactKeys=(value:Json,keys:string[])=>Object.keys(value).sort().join(',')===keys.sort().join(',');
const sameOwner=(a:ManagedLoginOwner,b:ManagedLoginOwner)=>a.hostScopeId===b.hostScopeId&&
 a.executionInstanceId===b.executionInstanceId&&a.helperPid===b.helperPid&&
 a.helperCreationFiletime===b.helperCreationFiletime;

/** ConfigReadResponse.Config permits extra keys. Absence is refusal, not inferred from config.toml. */
export function parseEffectiveEphemeralConfig(value:unknown,privateConfigPath:string):boolean{
 if(typeof privateConfigPath!=='string'||!privateConfigPath||!record(value)||
   !record(value.config)||!record(value.origins)||
   value.config.cli_auth_credentials_store!=='ephemeral')return false;
 const origin=value.origins.cli_auth_credentials_store;
 if(!record(origin)||!record(origin.name)||origin.name.type!=='user'||
   !samePath(origin.name.file,privateConfigPath)||
   (origin.name.profile!==undefined&&origin.name.profile!==null)||
   typeof origin.version!=='string'||!origin.version)return false;
 return value.layers===undefined||value.layers===null||
   (Array.isArray(value.layers)&&value.layers.length===0);
}

export function managedLoginStartRequest(){
 return {id:4,method:'account/login/start',params:{type:'chatgpt'}} as const;
}

function officialBrowserUrl(input:unknown):input is string{
 if(typeof input!=='string'||input.length===0||Buffer.byteLength(input)>4096||
   input.trim()!==input||/[\\\s]/.test(input)||hasControl(input))return false;
 try{
  const value=new URL(input);
  return value.protocol==='https:'&&
    (value.origin==='https://chatgpt.com'||value.origin==='https://auth.openai.com')&&
    value.username===''&&value.password===''&&value.port==='';
 }catch{return false;}
}

/** A single owner-bound exchange. Only the actual owned child stream may feed these methods. */
export class ManagedChatgptLoginProtocol{
 private state:State='new';
 private loginId:string|null=null;
 private urlSha256:string|null=null;
 private urlBytes=0;
 private effective=false;
 private violation:Violation|null=null;
 private handoffStatus:'not_attempted'|'returned'|'failed'='not_attempted';
 private completionOutcome:'not_seen'|'success'|'reported_failure'='not_seen';
 private completionShape:CompletionShape|null=null;
 private readonly owner:ManagedLoginOwner;
 constructor(owner:ManagedLoginOwner){
  if(!record(owner)||typeof owner.hostScopeId!=='string'||!owner.hostScopeId||
   typeof owner.executionInstanceId!=='string'||!owner.executionInstanceId||
   !Number.isSafeInteger(owner.helperPid)||owner.helperPid<1||
   typeof owner.helperCreationFiletime!=='string'||
   !/^[1-9][0-9]{0,19}$/.test(owner.helperCreationFiletime))throw fixedError();
  this.owner=Object.freeze({hostScopeId:owner.hostScopeId,
   executionInstanceId:owner.executionInstanceId,helperPid:owner.helperPid,
   helperCreationFiletime:owner.helperCreationFiletime});
 }
 private reject(stage:Stage,reason:Reason):never{
  this.violation??=Object.freeze({stage,stateBefore:this.state,reason});
  this.state='failed';throw fixedError();
 }
 private owned(source:ManagedLoginOwner,stage:Stage):void{
  if(!sameOwner(this.owner,source))this.reject(stage,'owner');
 }
 confirmEphemeral(configRead:unknown,privateConfigPath:string):void{
  if(this.state!=='new')this.reject('config','state');
  if(!parseEffectiveEphemeralConfig(configRead,privateConfigPath))this.reject('config','config');
  this.effective=true;this.state='ready';
 }
 startRequest(){
  if(this.state!=='ready'||!this.effective)this.reject('start','state');
  this.state='start_sent';return managedLoginStartRequest();
 }
 /** Raw authUrl leaves this object only through this dedicated human handoff. */
 acceptStart(reply:unknown,source:ManagedLoginOwner,presentAuthUrl:(url:string)=>void):void{
  this.owned(source,'start');
  if(this.state!=='start_sent')this.reject('start','state');
  if(typeof presentAuthUrl!=='function'||!record(reply)||
    !exactKeys(reply,['id','result'])||reply.id!==4||!record(reply.result)||
    !exactKeys(reply.result,['authUrl','loginId','type']))this.reject('start','envelope');
  if(reply.result.type!=='chatgpt')this.reject('start','start_variant');
  if(reply.result.loginId===null)this.reject('start','login_id_null');
  if(typeof reply.result.loginId!=='string'||reply.result.loginId.length===0||
    reply.result.loginId.length>128||hasControl(reply.result.loginId))this.reject('start','login_id_type');
  if(!officialBrowserUrl(reply.result.authUrl))this.reject('start','url');
  const loginId=reply.result.loginId as string,authUrl=reply.result.authUrl as string;
  this.loginId=loginId;this.urlSha256=sha(authUrl);this.urlBytes=Buffer.byteLength(authUrl);
  this.state='pending';
  try{presentAuthUrl(authUrl);this.handoffStatus='returned';}
  catch{this.handoffStatus='failed';this.reject('handoff','handoff_failed');}
 }
 acceptCompletion(notification:unknown,source:ManagedLoginOwner):void{
  this.owned(source,'completion');
  if(!['pending','cancel_ack'].includes(this.state))this.reject('completion','state');
  if(record(notification)){
   const hasEmittedAtMs=Object.hasOwn(notification,'emittedAtMs');
   this.completionShape??=Object.freeze({hasEmittedAtMs,
    emittedAtMsValid:hasEmittedAtMs&&Number.isSafeInteger(notification.emittedAtMs),
    unexpectedKeyCount:Object.keys(notification).filter(key=>
     !['method','params','emittedAtMs'].includes(key)).length,
    paramsIsObject:record(notification.params),hasId:Object.hasOwn(notification,'id')});
  }
  if(!record(notification)||
    !(exactKeys(notification,['method','params'])||
     (exactKeys(notification,['method','params','emittedAtMs'])&&
      Number.isSafeInteger(notification.emittedAtMs)))||
    notification.method!=='account/login/completed'||!record(notification.params))this.reject('completion','envelope');
  const params=notification.params;
  if(!Object.hasOwn(params,'loginId'))this.reject('completion','login_id_missing');
  if(params.loginId===null)this.reject('completion','login_id_null');
  if(typeof params.loginId!=='string')this.reject('completion','login_id_type');
  if(params.loginId!==this.loginId)this.reject('completion','login_id_mismatch');
  if(typeof params.success!=='boolean')this.reject('completion','success_type');
  if(params.success===true){
   if(this.state!=='pending')this.reject('completion','state');
   if(params.error!==null&&params.error!==undefined)this.reject('completion','error_on_success');
   this.completionOutcome='success';this.state='success';return;
  }
  if(params.error!==null&&params.error!==undefined&&typeof params.error!=='string')this.reject('completion','error_type');
  this.completionOutcome='reported_failure';
  this.state=this.state==='cancel_ack'?'canceled':'failed';
 }
 cancelRequest(){
  if(this.state!=='pending'||this.loginId===null)this.reject('cancel','state');
  this.state='cancel_requested';
  return {id:5,method:'account/login/cancel',params:{loginId:this.loginId}} as const;
 }
 acceptCancel(reply:unknown,source:ManagedLoginOwner):void{
  this.owned(source,'cancel');
  if(this.state!=='cancel_requested')this.reject('cancel','state');
  if(!record(reply)||!exactKeys(reply,['id','result'])||
    reply.id!==5||!record(reply.result)||!exactKeys(reply.result,['status'])||
    reply.result.status!=='canceled')this.reject('cancel','envelope');
  this.state='cancel_ack';
 }
 summary(){
  return Object.freeze({status:this.state,ephemeralConfigVerified:this.effective,
   loginIdSha256:this.loginId===null?null:sha(this.loginId),
   authUrlSha256:this.urlSha256,authUrlBytes:this.urlBytes,
   violation:this.violation,handoffStatus:this.handoffStatus,completionOutcome:this.completionOutcome,
   completionShape:this.completionShape});
 }
}
