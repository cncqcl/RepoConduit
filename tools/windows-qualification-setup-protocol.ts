/** One local, elevated setup exchange. It grants no account or model operation. */
import {createHash} from 'node:crypto';
import {win32} from 'node:path';
import type {ManagedLoginOwner} from './windows-qualification-login-protocol.js';

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).sort().join(',')===[...expected].sort().join(',');
type Status='new'|'pending'|'not_started'|'reported_failure'|'readiness_requested'|'ready'|'readiness_pending'|'invalid';
export class FixedSandboxSetup{
 private status:Status='new';
 private ack:boolean|null=null;
 private completion:boolean|null=null;
 private error:Readonly<{bytes:number;sha256:string}>|null=null;
 private readiness:string|null=null;
 private readonly owner:ManagedLoginOwner;
 constructor(owner:ManagedLoginOwner,private readonly cwd:string){
  if(!owner.hostScopeId||!owner.executionInstanceId||!Number.isSafeInteger(owner.helperPid)||owner.helperPid<1||
   !/^[1-9][0-9]{0,19}$/.test(owner.helperCreationFiletime)||!win32.isAbsolute(cwd)||
   [...cwd].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))throw new Error('QUALIFICATION_SETUP_PROTOCOL');
  this.owner=Object.freeze({...owner});
 }
 private reject():never{this.status='invalid';throw new Error('QUALIFICATION_SETUP_PROTOCOL');}
 private owned(source:ManagedLoginOwner){
  if(source.hostScopeId!==this.owner.hostScopeId||source.executionInstanceId!==this.owner.executionInstanceId||
   source.helperPid!==this.owner.helperPid||source.helperCreationFiletime!==this.owner.helperCreationFiletime)this.reject();
 }
 startRequest(){
  if(this.status!=='new')this.reject();this.status='pending';
  return {id:4,method:'windowsSandbox/setupStart',params:{mode:'elevated',cwd:this.cwd}} as const;
 }
 acceptStart(reply:unknown,source:ManagedLoginOwner){
  this.owned(source);
  if(this.status!=='pending'||this.ack!==null||!record(reply)||!keys(reply,['id','result'])||reply.id!==4||
   !record(reply.result)||!keys(reply.result,['started'])||typeof reply.result.started!=='boolean')this.reject();
  this.ack=reply.result.started;
  if(!this.ack)this.status='not_started';
 }
 /** Raw failure text leaves only through the local caller's private-file capture; never summary(). */
 acceptCompletion(reply:unknown,source:ManagedLoginOwner):string|null{
  this.owned(source);
  if(this.status!=='pending'||this.completion!==null||!record(reply)||
   !(keys(reply,['method','params'])||(keys(reply,['method','params','emittedAtMs'])&&Number.isSafeInteger(reply.emittedAtMs)))||
   reply.method!=='windowsSandbox/setupCompleted'||!record(reply.params))this.reject();
  const p=reply.params;
  if(!(keys(p,['mode','success'])||keys(p,['mode','success','error']))||p.mode!=='elevated'||typeof p.success!=='boolean'||
   (p.error!==undefined&&p.error!==null&&typeof p.error!=='string')||(p.success&&p.error!=null)||
   (typeof p.error==='string'&&Buffer.byteLength(p.error)>4096))this.reject();
  this.completion=p.success;
  if(typeof p.error==='string')this.error=Object.freeze({bytes:Buffer.byteLength(p.error),sha256:createHash('sha256').update(p.error).digest('hex')});
  // A failed completion may arrive before its ACK. Preserve failure while draining that ACK.
  return typeof p.error==='string'?p.error:null;
 }
 canReadiness(){return this.status==='pending'&&this.ack===true&&this.completion===true;}
 failed(){return this.status==='not_started'||this.status==='invalid'||this.completion===false;}
 readinessRequest(){
  if(!this.canReadiness())this.reject();this.status='readiness_requested';
  return {id:5,method:'windowsSandbox/readiness',params:null} as const;
 }
 acceptReadiness(reply:unknown,source:ManagedLoginOwner){
  this.owned(source);
  if(this.status!=='readiness_requested'||!record(reply)||!keys(reply,['id','result'])||reply.id!==5||
   !record(reply.result)||!keys(reply.result,['status'])||!['ready','notConfigured','updateRequired'].includes(String(reply.result.status)))this.reject();
  this.readiness=String(reply.result.status);this.status=this.readiness==='ready'?'ready':'readiness_pending';
 }
 summary(){return Object.freeze({status:this.completion===false&&this.status==='pending'?'reported_failure':this.status,
  started:this.ack,completionSuccess:this.completion,readiness:this.readiness,error:this.error});}
}
