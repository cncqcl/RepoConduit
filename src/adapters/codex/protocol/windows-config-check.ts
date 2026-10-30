/** A narrow projection of the generated Desktop 0.160.0 v1/v2 schemas. */
import type {ReadinessConnection} from './windows-readiness.js';
const record=(v:unknown):v is Record<string,unknown>=>
 !!v&&typeof v==='object'&&!Array.isArray(v);
const pathKey=(v:string)=>v.replaceAll('/','\\').toLowerCase();
const samePath=(a:unknown,b:string)=>typeof a==='string'&&pathKey(a)===pathKey(b);

/** v1 InitializeResponse: codexHome and both platform fields are mandatory. */
export function parseWindowsConfigInitialize(value:unknown,codexHome:string):boolean{
 return record(value)&&typeof value.userAgent==='string'&&value.userAgent.length>0&&
  samePath(value.codexHome,codexHome)&&value.platformFamily==='windows'&&
  value.platformOs==='windows';
}

/** v2 ConfigReadResponse: projected values and their user-file origins only. */
export function parseWindowsConfigRead(value:unknown,expected:{codexHome:string;
 configPath:string;modelRef:string}):boolean{
 if(!record(value)||!record(value.config)||!record(value.origins)||
  (value.layers!==undefined&&value.layers!==null&&
   (!Array.isArray(value.layers)||value.layers.length!==0))) return false;
 const config=value.config;
 if(config.model!==expected.modelRef||config.approval_policy!=='never'||
  config.web_search!=='disabled') return false;
 for(const key of ['model','approval_policy','web_search']){
  const origin=value.origins[key];
  if(!record(origin)||!record(origin.name)||origin.name.type!=='user'||
   !samePath(origin.name.file,expected.configPath)||
   (origin.name.profile!==undefined&&origin.name.profile!==null)||
   typeof origin.version!=='string'||!origin.version) return false;
 }
 return true;
}

/** Three fixed zero-model requests; each native write completes before the next is sent. */
export function runWindowsConfigProtocol(connection:ReadinessConnection,expected:{codexHome:string;
 configPath:string;modelRef:string;checkCwd:string},timeoutMs=10_000):Promise<boolean>{
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>20_000)
  throw new Error('INVALID_ARGUMENT');
 return new Promise((resolve,reject)=>{
  let partial=Buffer.alloc(0),total=0,phase=0,settled=false,verified:boolean|undefined;
  const stop=()=>{try{connection.terminate();}catch{/* Closure remains unconfirmed. */}};
  const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);stop();reject(new Error('WINDOWS_CONFIG_CHECK_FAILED'));};
  const timer=setTimeout(fail,timeoutMs);
  const send=(value:object)=>new Promise<void>((done,failed)=>{
   if(settled)return failed(new Error('WINDOWS_CONFIG_CHECK_FAILED'));
   try{
    const accepted=connection.input.write(JSON.stringify(value)+'\n',error=>{
     if(error)failed(error);else done();
    });
    if(!accepted)failed(new Error('WINDOWS_CONFIG_CHECK_BUSY'));
   }catch(error){failed(error);}
  });
  connection.input.on('error',fail);
  connection.output.on('error',fail);
  connection.errors.on('error',fail);
  connection.exited.on('error',fail);
  connection.exited.on('close',()=>{
   if(settled)return;
   if(verified===undefined||partial.length) return fail();
   settled=true;clearTimeout(timer);resolve(verified);
  });
  connection.errors.on('data',(chunk:Buffer)=>{total+=chunk.length;if(total>128*1024)fail();});
  connection.output.on('data',(chunk:Buffer)=>{
   if(settled||verified!==undefined)return fail();
   total+=chunk.length;
   if(total>128*1024||partial.length+chunk.length>128*1024)return fail();
   partial=Buffer.concat([partial,chunk]);
   let newline:number;
   while(!settled&&(newline=partial.indexOf(10))>=0){
    let value:unknown;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(partial.subarray(0,newline)));}
    catch{return fail();}
    partial=partial.subarray(newline+1);
    if(!record(value))return fail();
    if(value.method==='remoteControl/status/changed'&&!('id'in value)&&record(value.params))continue;
    if('error'in value||'method'in value||!record(value.result))return fail();
    if(phase===0&&value.id===1){
     if(!parseWindowsConfigInitialize(value.result,expected.codexHome))return fail();
     phase=1;
     void (async()=>{
      await send({method:'initialized'});
      if(settled)return;
      phase=2;
      await send({id:2,method:'config/read',params:{cwd:expected.checkCwd,includeLayers:false}});
     })().catch(fail);
    }else if(phase===2&&value.id===2){
     if(partial.length)return fail();
     verified=parseWindowsConfigRead(value.result,expected);
     stop();
    }else return fail();
   }
  });
  void send({id:1,method:'initialize',params:{clientInfo:{name:'repo-conduit-config-check',
   version:'0.1.0'},capabilities:{experimentalApi:true,requestAttestation:false}}}).catch(fail);
 });
}
