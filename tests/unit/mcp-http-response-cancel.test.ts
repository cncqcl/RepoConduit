import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import type {ServerResponse} from 'node:http';
import * as transport from '../../src/adapters/mcp/http.js';

const send=()=>{
 const value=(transport as unknown as {sendResponse?:SendResponse}).sendResponse;
 assert.equal(typeof value,'function','HTTP response transport must expose its internal stream operation');
 return value!;
};
type SendResponse=(response:Response,output:ServerResponse,authorized:()=>Promise<boolean>,
 challenge:string,scopes?:readonly string[],signal?:AbortSignal)=>Promise<void>;
function output(){
 const writes:unknown[]=[];
 const stream=Object.assign(new EventEmitter(),{
  writeHead(status:number,headers:unknown){writes.push({status,headers});return this;},
  end(bytes?:unknown){writes.push(bytes);return this;},
 });
 return {stream:stream as unknown as ServerResponse,writes};
}
async function bounded<T>(work:Promise<T>):Promise<T>{
 let timer:NodeJS.Timeout|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>reject(Error('response cancellation did not settle')),1_000);
 })]);}finally{if(timer)clearTimeout(timer);}
}

test('HTTP response preserves finite bytes and checks authority before disclosure',async()=>{
 const target=output();let checks=0;
 await send()(new Response('synthetic payload'),target.stream,async()=>{checks++;return true;},'Bearer');
 assert.equal(checks,1);assert.equal(target.writes.length,2);
 assert.equal((target.writes[0] as {status:number}).status,200);
 assert.equal(Buffer.from(target.writes[1] as Uint8Array).toString(),'synthetic payload');
});

test('HTTP cancellation ends an unfinished response reader without disclosing bytes',async()=>{
 const target=output(),abort=new AbortController();let cancelled=0;
 const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('partial'));},
  cancel(){cancelled++;}});
 const response=new Response(body);
 const work=send()(response,target.stream,async()=>true,'Bearer',undefined,abort.signal);
 const rejected=assert.rejects(bounded(work),/MCP_HTTP_RESPONSE_ABORTED/);
 await Promise.resolve();abort.abort();await rejected;
 assert.equal(cancelled,1);assert.equal(response.body!.locked,false);assert.deepEqual(target.writes,[]);
});

test('HTTP cancellation does not hide a failed underlying stream cancellation',async()=>{
 const target=output(),abort=new AbortController();
 const response=new Response(new ReadableStream<Uint8Array>({cancel(){throw Error('synthetic cancel failure');}}));
 const work=send()(response,target.stream,async()=>true,'Bearer',undefined,abort.signal);
 const rejected=assert.rejects(bounded(work),/synthetic cancel failure/);
 abort.abort();await rejected;
 assert.equal(response.body!.locked,false);assert.deepEqual(target.writes,[]);
});

test('an already cancelled HTTP response cannot disclose a buffered body',async()=>{
 const target=output(),abort=new AbortController();abort.abort();
 const response=new Response('synthetic private response');
 await assert.rejects(send()(response,target.stream,async()=>true,'Bearer',undefined,abort.signal),
  /MCP_HTTP_RESPONSE_ABORTED/);
 assert.deepEqual(target.writes,[]);assert.equal(response.body!.locked,false);
});
