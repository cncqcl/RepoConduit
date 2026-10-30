import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {test} from 'node:test';

const source=resolve('native/windows/WindowsJobHost.cs');
const compiler='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const selected=[
 'ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL',
 'ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL',
 'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const;

test('native Claude recipe forwards only selected model route through the child environment',()=>{
 const native=readFileSync(source,'utf8');
 assert.match(native,/environmentText\s*\+=\s*BuildClaudeModelEnvironment\(\)/u);
 const body=native.match(/private static string BuildClaudeModelEnvironment\(\)\s*\{([\s\S]*?)\n {4}\}/u)?.[1];
 assert.ok(body,'the native child environment must be composed from a named allowlist');
 for(const name of selected) assert.ok(body.includes(`"${name}"`),`${name} must be included`);
 for(const name of ['ANTHROPIC_API_KEY','ANTHROPIC_CUSTOM_HEADERS','CLAUDE_CODE_USE_POWERSHELL_TOOL',
  'CLAUDE_CONFIG_DIR','NODE_OPTIONS']) assert.equal(body.includes(`"${name}"`),false);
 assert.match(native,/--tools \\"\\"/u);
 assert.match(native,/--strict-mcp-config/u);
 assert.match(native,/--permission-mode dontAsk/u);
});

test('native Claude environment composition selects one bounded route without launching the CLI',
 {skip:process.platform!=='win32',timeout:30_000},()=>{
  const dir=mkdtempSync(join(tmpdir(),'rcac-glm-native-'));
  try{
   const exe=join(dir,'ModelProbe.exe');
   const probe=join(dir,'ModelProbe.cs');
   writeFileSync(probe,`using System;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
internal static class ModelProbe {
 public static int Main() {
  try {
   var method=typeof(WindowsJobHost).GetMethod("BuildClaudeModelEnvironment",BindingFlags.NonPublic|BindingFlags.Static);
   if(method==null){Console.Error.WriteLine("METHOD_MISSING");return 1;}
   var block=(string)method.Invoke(null,null);
   using(var sha=SHA256.Create()) Console.WriteLine(BitConverter.ToString(sha.ComputeHash(Encoding.Unicode.GetBytes(block))).Replace("-", "").ToLowerInvariant());
   return 0;
  } catch(TargetInvocationException error) {
   var field=error.InnerException.GetType().GetField("Code",BindingFlags.Public|BindingFlags.Instance);
   Console.Error.WriteLine(field==null?"UNEXPECTED":field.GetValue(error.InnerException));
   return 1;
  }
 }
}`);
   const built=spawnSync(compiler,['/nologo','/target:exe','/platform:x64',`/out:${exe}`,
    '/main:ModelProbe',source,probe],
    {encoding:'utf8',timeout:30_000,windowsHide:true});
   assert.equal(built.status,0,`${built.stdout} ${built.stderr}`);
   for(const modelEnv of [
    {},
    {ANTHROPIC_AUTH_TOKEN:'synthetic-secret'},
    {ANTHROPIC_BASE_URL:'https://open.bigmodel.cn/api/anthropic'},
    {ANTHROPIC_AUTH_TOKEN:' ',ANTHROPIC_BASE_URL:'https://open.bigmodel.cn/api/anthropic'},
    {ANTHROPIC_AUTH_TOKEN:'synthetic-secret',ANTHROPIC_BASE_URL:'https://open.bigmodel.cn/api/anthropic',ANTHROPIC_MODEL:'  '},
    {ANTHROPIC_AUTH_TOKEN:'synthetic-secret',ANTHROPIC_BASE_URL:'http://localhost:8082'},
    {ANTHROPIC_AUTH_TOKEN:'synthetic-secret',ANTHROPIC_BASE_URL:'https://open.bigmodel.cn/api/anthropic?leak=1'},
    {ANTHROPIC_AUTH_TOKEN:'synthetic-secret',ANTHROPIC_BASE_URL:'https://open.bigmodel.cn/api/anthropic',ANTHROPIC_MODEL:'invalid\nvalue'},
   ]){
    const env={...process.env};for(const key of selected) delete env[key];
    Object.assign(env,modelEnv);
    const actual=spawnSync(exe,[],{encoding:'utf8',timeout:7000,windowsHide:true,env});
    assert.notEqual(actual.status,0,'invalid route must not launch Claude');
    assert.match(actual.stderr,/MODEL_CONFIG/u);
    assert.equal(actual.stderr.includes('synthetic-secret'),false);
    assert.equal(actual.stdout,'');
   }
   const valid={ANTHROPIC_AUTH_TOKEN:'synthetic-secret',
    ANTHROPIC_BASE_URL:'https://open.bigmodel.cn/api/anthropic/',ANTHROPIC_MODEL:'glm-test',
    ANTHROPIC_DEFAULT_HAIKU_MODEL:'glm-test-haiku',ANTHROPIC_DEFAULT_SONNET_MODEL:'glm-test-sonnet',
    ANTHROPIC_DEFAULT_OPUS_MODEL:'glm-test-opus'};
   const env={...process.env};for(const key of selected) delete env[key];
   Object.assign(env,valid,{NODE_OPTIONS:'--require bad.js',ANTHROPIC_API_KEY:'not-selected'});
   const actual=spawnSync(exe,[],{encoding:'utf8',timeout:7000,windowsHide:true,env});
   assert.equal(actual.status,0,actual.stderr);
   const expected=selected.map(name=>`${name}=${valid[name]}\0`).join('');
   assert.equal(actual.stdout.trim(),createHash('sha256').update(expected,'utf16le').digest('hex'));
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
 });
