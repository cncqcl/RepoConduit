import {lstatSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const CLAUDE_GLM_ENVIRONMENT_NAMES = [
 'ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL',
 'ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL',
 'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const;

/** Select the existing user's model connection, not their tool/hook policy. */
export function pickExistingClaudeGlmEnvironment(settings:unknown,required=false):Readonly<NodeJS.ProcessEnv>{
 const invalid=()=>new Error('CLAUDE_EXISTING_MODEL_CONFIGURATION_INVALID');
 const object=(value:unknown):value is Record<string,unknown>=>
  !!value&&typeof value==='object'&&!Array.isArray(value);
 if(!object(settings))throw invalid();
 if(!Object.hasOwn(settings,'env')){
  if(required)throw invalid();
  return Object.freeze({});
 }
 if(!object(settings.env))throw invalid();
 const env=settings.env,selected:NodeJS.ProcessEnv={};
 for(const name of CLAUDE_GLM_ENVIRONMENT_NAMES){
  if(!Object.hasOwn(env,name))continue;
  const value=env[name],limit=name==='ANTHROPIC_AUTH_TOKEN'?4096:
   name==='ANTHROPIC_BASE_URL'?256:160;
  if(typeof value!=='string'||value.trim().length===0||value.length>limit||/[\0\r\n]/u.test(value))throw invalid();
  selected[name]=value;
 }
 if(Object.keys(selected).length===0){
  if(required)throw invalid();
  return Object.freeze(selected);
 }
 if(!selected.ANTHROPIC_AUTH_TOKEN||!selected.ANTHROPIC_BASE_URL||
  !/^https:\/\/open\.bigmodel\.cn\/api\/anthropic\/?$/u.test(selected.ANTHROPIC_BASE_URL))throw invalid();
 return Object.freeze(selected);
}

/** Fixed trusted user configuration. No caller path, environment fallback or secret file is produced. */
export function loadExistingClaudeGlmEnvironment():Readonly<NodeJS.ProcessEnv>{
 try{
  const path=join(homedir(),'.claude','settings.json');
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if(!stat||!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024)throw new Error();
  return pickExistingClaudeGlmEnvironment(JSON.parse(readFileSync(path,'utf8')),true);
 }catch{throw new Error('CLAUDE_EXISTING_MODEL_CONFIGURATION_INVALID');}
}
