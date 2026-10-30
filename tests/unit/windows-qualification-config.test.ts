import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {protectNewDataDirectory,assertPrivateInstallationDirectory} from '../../src/runtime/local-security.js';

const script=new URL('../../tools/windows-qualification-config.mjs',import.meta.url).href;
const candidate=await import(script) as {
 qualificationFixtureParent:(fixtureRoot:string)=>string;
 renderWindowsQualificationConfig:(modelRef:string)=>string;
 renderWindowsQualificationMarker:(modelRef:string)=>{
  kind:string;protocolTarget:string;modelRef:string;configSha256:string;sourceSha256:string;
 };
 prepareWindowsQualificationConfig:(input:{fixtureRoot:string;modelRef:string})=>{
  fixtureRoot:string;runtimeRoot:string;sourcePath:string;home:string;
  configSha256:string;modelRef:string;environment:Record<string,string>;
 };
};
const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const fixtures=join(homedir(),'.repo-conduit-qualification');
function ensureFixtures(){
 if(!existsSync(fixtures)){mkdirSync(fixtures,{mode:0o700});protectNewDataDirectory(fixtures);}
 assertPrivateInstallationDirectory(fixtures);
}
const fresh=()=>join(fixtures,`unit-${randomUUID()}`);
const exactFixture=(root:string)=>root.startsWith(fixtures+sep)&&
 root.slice(fixtures.length+1).startsWith('unit-')&&
 !root.slice(fixtures.length+1).includes(sep)&&realpathSync.native(root)===root;

test('approved trial path is one fixed fresh child scope, not an arbitrary external root',()=>{
 const parent=join(homedir(),'.repo-conduit-qualification-trial');
 assert.equal(candidate.qualificationFixtureParent(join(parent,`candidate-${randomUUID()}`)),parent);
 for(const path of [parent,join(parent,'home'),join(parent,`unit-${randomUUID()}`),
  join(join(repo,'.local','qualification','unapproved'),`candidate-${randomUUID()}`),
  join(parent,'nested',`candidate-${randomUUID()}`)])assert.throws(()=>candidate.qualificationFixtureParent(path));
});

test('0.162 candidate narrows only the two newly observed image features and fixes its marker',()=>{
 const config=candidate.renderWindowsQualificationConfig('gpt-6-sol');
 assert.match(config,/^model = "gpt-6-sol"$/m);
 assert.match(config,/^approval_policy = "never"$/m);
 assert.match(config,/^cli_auth_credentials_store = "ephemeral"$/m);
 assert.match(config,/^default_permissions = "rcac_static"$/m);
 assert.match(config,/^":root" = "none"$/m);
 assert.match(config,/^":minimal" = "read"$/m);
 assert.match(config,/^sandbox = "elevated"$/m);
 for(const flag of ['shell_tool','multi_agent','multi_agent_v2','plugins','apps',
  'browser_use','browser_use_external','browser_use_full_cdp_access','computer_use',
  'hooks','code_mode_host','in_app_browser','in_app_local_automation','remote_plugin',
  'image_generation','view_image'])
  assert.match(config,new RegExp(`^${flag} = false$`,'m'));
 const previousConfig=config.replace('image_generation = false\n','').replace('view_image = false\n','');
 assert.equal(createHash('sha256').update(previousConfig).digest('hex'),
  '7e5396169437575a75c15103ea9de5ed701383b9e1595f415ea21fae3a27eec1');
 assert.match(config,/^skip_host_skill_discovery = true$/m);
 assert.doesNotMatch(config,/auth\.json|api_key|fallback|billing|model_provider/i);
 const marker=candidate.renderWindowsQualificationMarker('gpt-6-sol');
 assert.deepEqual(Object.keys(marker).sort(),
  ['kind','protocolTarget','modelRef','configSha256','sourceSha256'].sort());
 assert.equal(marker.protocolTarget,'windows-desktop-26.1002.7124.0-codex-0.162.0-alpha.2');
 assert.match(marker.configSha256,/^[a-f0-9]{64}$/);
 assert.throws(()=>candidate.renderWindowsQualificationConfig('gpt-6-sol"\n[features]\nshell_tool=true'));
 assert.throws(()=>candidate.renderWindowsQualificationMarker('gpt-6-astra'));
 assert.throws(()=>candidate.renderWindowsQualificationConfig('gpt-6-astra'));
});

test('create-only private candidate has distinct marker, synthetic source, and no inherited credentials',()=>{
 ensureFixtures();
 const root=fresh();let complete=false;
 const prior=process.env.OPENAI_API_KEY;
 process.env.OPENAI_API_KEY='test-inherited-secret';
 try{
  const prepared=candidate.prepareWindowsQualificationConfig({fixtureRoot:root,modelRef:'gpt-6-sol'});
  assert.equal(prepared.fixtureRoot,root);
  assert.equal(prepared.runtimeRoot,join(root,'runtime'));
  assert.equal(prepared.sourcePath,join(root,'source'));
  assert.equal(prepared.home,join(root,'runtime','home'));
  assert.equal(prepared.modelRef,'gpt-6-sol');
  assert.match(prepared.configSha256,/^[a-f0-9]{64}$/);
  assert.equal(readFileSync(join(root,'source','README.md'),'utf8'),
   '# RepoConduit synthetic qualification source\nNo repository data.\n');
  const marker=JSON.parse(readFileSync(join(root,'qualification.json'),'utf8')) as Record<string,unknown>;
  assert.equal(marker.kind,'windows_qualification_candidate_v1');
  assert.equal(marker.protocolTarget,'windows-desktop-26.1002.7124.0-codex-0.162.0-alpha.2');
  assert.equal(marker.configSha256,prepared.configSha256);
  assert.equal(marker.modelRef,'gpt-6-sol');
  assert.equal(marker.productionAvailable,undefined);
  assert.equal(existsSync(join(root,'runtime','runtime.json')),false);
  assert.equal(existsSync(join(root,'runtime','home','.codex','auth.json')),false);
  assert.equal(readFileSync(join(root,'runtime','home','.codex','config.toml'),'utf8'),
   candidate.renderWindowsQualificationConfig('gpt-6-sol'));
  assert.deepEqual(Object.keys(prepared.environment).sort(),
   ['SystemRoot','PATH','HOME','USERPROFILE','CODEX_HOME','APPDATA','LOCALAPPDATA','TEMP','TMP'].sort());
  assert.equal(JSON.stringify(prepared).includes('test-inherited-secret'),false);
  assert.equal(existsSync(join(root,'runtime','check','auth.json')),false);
  assert.throws(()=>candidate.prepareWindowsQualificationConfig({fixtureRoot:root,modelRef:'gpt-6-sol'}));
  complete=true;
 }finally{
  if(prior===undefined)delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY=prior;
  if(complete&&exactFixture(root))rmSync(root,{recursive:true,force:true});
 }
});

test('rejects existing old diagnostic, path escape, and unrecognized model before writes',()=>{
 ensureFixtures();
 const old=fresh();mkdirSync(old);
 try{
  writeFileSync(join(old,'runtime.json'),'{"kind":"windows_investigation_runtime_v1"}');
  assert.throws(()=>candidate.prepareWindowsQualificationConfig({fixtureRoot:old,modelRef:'gpt-6-sol'}));
  assert.equal(readFileSync(join(old,'runtime.json'),'utf8'),
   '{"kind":"windows_investigation_runtime_v1"}');
  const outside=join(repo,'.local','qualification','wrong-root-'+randomUUID());
  assert.throws(()=>candidate.prepareWindowsQualificationConfig({fixtureRoot:outside,modelRef:'gpt-6-sol'}));
  assert.equal(existsSync(outside),false);
  const invalid=fresh();
  assert.throws(()=>candidate.prepareWindowsQualificationConfig({fixtureRoot:invalid,
   modelRef:'gpt-6-sol\n[features]\nshell_tool=true'}));
  assert.equal(existsSync(invalid),false);
 }finally{if(exactFixture(old))rmSync(old,{recursive:true,force:true});}
});
