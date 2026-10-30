import {createHash} from 'node:crypto';
import {constants,existsSync,lstatSync,mkdirSync,openSync,realpathSync,readdirSync,writeFileSync,
  fsyncSync,closeSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {assertPrivateInstallationDirectory,protectNewDataDirectory} from
  '../dist/src/runtime/local-security.js';

// Source-only synthetic candidate. This does not qualify a production investigator.
const fixtureParent=join(homedir(),'.repo-conduit-qualification');
const approvedTrialParent=join(homedir(),'.repo-conduit-qualification-trial');
const target='windows-desktop-26.1002.7124.0-codex-0.162.0-alpha.2';
const readme='# RepoConduit synthetic qualification source\nNo repository data.\n';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable=()=>new Error('WINDOWS_QUALIFICATION_CANDIDATE_UNAVAILABLE');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const equalPath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;

/** Fixed synthetic path scope shared by preparation and zero-model preflight. */
export function qualificationFixtureParent(fixtureRoot){
 if(typeof fixtureRoot!=='string'||resolve(fixtureRoot)!==fixtureRoot)throw unavailable();
 const parent=dirname(fixtureRoot),name=basename(fixtureRoot);
 const prefix=parent===approvedTrialParent?'candidate-':parent===fixtureParent?
  (/^unit-/.test(name)?'unit-':'candidate-'):null;
 if(prefix===null||!name.startsWith(prefix)||!uuid.test(name.slice(prefix.length)))throw unavailable();
 return parent;
}

function checkModel(modelRef){
 if(modelRef!=='gpt-6-sol')throw unavailable();
}

/** Intentional restrictions for the observed Desktop 0.162 feature catalog. */
export function renderWindowsQualificationConfig(modelRef){
 checkModel(modelRef);
 return `model = "${modelRef}"\napproval_policy = "never"\n`+
  'cli_auth_credentials_store = "ephemeral"\n'+
  'default_permissions = "rcac_static"\nweb_search = "disabled"\n'+
  'check_for_update_on_startup = false\nproject_doc_max_bytes = 0\n\n'+
  '[windows]\nsandbox = "elevated"\n\n'+
  '[permissions.rcac_static.filesystem]\n":root" = "none"\n":minimal" = "read"\n'+
  '[permissions.rcac_static.network]\nenabled = false\n\n'+
  '[features]\n'+
  'shell_tool = false\nmulti_agent = false\nmulti_agent_v2 = false\n'+
  'plugins = false\napps = false\nremote_plugin = false\n'+
  'browser_use = false\nbrowser_use_external = false\n'+
  'browser_use_full_cdp_access = false\nin_app_browser = false\n'+
  'in_app_local_automation = false\ncomputer_use = false\n'+
  'hooks = false\ncode_mode_host = false\n'+
  'image_generation = false\nview_image = false\n'+
  'skip_host_skill_discovery = true\n';
}

export function renderWindowsQualificationMarker(modelRef){
 const configSha256=sha(renderWindowsQualificationConfig(modelRef));
 return Object.freeze({kind:'windows_qualification_candidate_v1',protocolTarget:target,
  modelRef,configSha256,sourceSha256:sha(readme)});
}

function safeExistingDirectory(path){
 const info=lstatSync(path);
 if(!info.isDirectory()||info.isSymbolicLink()||
  !equalPath(realpathSync.native(path),resolve(path)))throw unavailable();
}

function newPrivateDirectory(path){
 if(existsSync(path))throw unavailable();
 mkdirSync(path,{mode:0o700});
 safeExistingDirectory(path);
 const initial=lstatSync(path);
 if(readdirSync(path).length!==0)throw unavailable();
 protectNewDataDirectory(path);
 safeExistingDirectory(path);
 assertPrivateInstallationDirectory(path);
 const protectedInfo=lstatSync(path);
 if(protectedInfo.ino!==initial.ino||protectedInfo.dev!==initial.dev||readdirSync(path).length!==0)throw unavailable();
}

function exclusiveFile(path,bytes){
 const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
 try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
}

function validateInput(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||
  Object.keys(input).sort().join(',')!=='fixtureRoot,modelRef'||
  typeof input.fixtureRoot!=='string'||resolve(input.fixtureRoot)!==input.fixtureRoot)
  throw unavailable();
 checkModel(input.modelRef);
 const parent=qualificationFixtureParent(input.fixtureRoot);
 safeExistingDirectory(parent);
 if(existsSync(input.fixtureRoot))throw unavailable();
}

/** Create-only synthetic fixture. Protect/verify the EMPTY new child before writing data.
 * Parent is checked by the unchanged private verifier as an ancestor, not a private data root.
 * No existing ACL changes, login, helper, app-server, model, or network call. */
export function prepareWindowsQualificationConfig(input){
 validateInput(input);
 const fixtureRoot=input.fixtureRoot;
 const parent=qualificationFixtureParent(fixtureRoot);
 if(!existsSync(parent))newPrivateDirectory(parent);
 else {safeExistingDirectory(parent);assertPrivateInstallationDirectory(parent);}
 const runtimeRoot=join(fixtureRoot,'runtime');
 const sourcePath=join(fixtureRoot,'source');
 const home=join(runtimeRoot,'home');
 const codexHome=join(home,'.codex');
 newPrivateDirectory(fixtureRoot);
 for(const path of [runtimeRoot,home,codexHome,join(runtimeRoot,'AppDataLocal'),
  join(runtimeRoot,'AppDataRoaming'),join(runtimeRoot,'temp'),join(runtimeRoot,'check'),
  sourcePath])newPrivateDirectory(path);
 const config=renderWindowsQualificationConfig(input.modelRef);
 const marker=renderWindowsQualificationMarker(input.modelRef);
 const configSha256=marker.configSha256;
 exclusiveFile(join(codexHome,'config.toml'),config);
 exclusiveFile(join(sourcePath,'README.md'),readme);
 exclusiveFile(join(fixtureRoot,'qualification.json'),JSON.stringify(marker)+'\n');
 assertPrivateInstallationDirectory(codexHome,join(codexHome,'config.toml'));
 assertPrivateInstallationDirectory(sourcePath,join(sourcePath,'README.md'));
 assertPrivateInstallationDirectory(fixtureRoot,join(fixtureRoot,'qualification.json'));
 const environment={SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows',
  HOME:home,USERPROFILE:home,CODEX_HOME:codexHome,
  APPDATA:join(runtimeRoot,'AppDataRoaming'),LOCALAPPDATA:join(runtimeRoot,'AppDataLocal'),
  TEMP:join(runtimeRoot,'temp'),TMP:join(runtimeRoot,'temp')};
 return Object.freeze({fixtureRoot,runtimeRoot,sourcePath,home,configSha256,
  modelRef:input.modelRef,environment:Object.freeze(environment)});
}
