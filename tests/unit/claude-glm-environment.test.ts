import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pickExistingClaudeGlmEnvironment,CLAUDE_GLM_ENVIRONMENT_NAMES} from
 '../../src/adapters/secondary-investigator/claude-windows-model-environment.js';
import {buildClaudeWindowsLaunchSpec} from
 '../../src/adapters/secondary-investigator/claude-windows-protocol.js';

const selected={ANTHROPIC_AUTH_TOKEN:'synthetic-user-token',
 ANTHROPIC_BASE_URL:'https://open.bigmodel.cn/api/anthropic',
 ANTHROPIC_MODEL:'glm-5.1[1m]',ANTHROPIC_DEFAULT_HAIKU_MODEL:'glm-5.1',
 ANTHROPIC_DEFAULT_SONNET_MODEL:'glm-5.1[1m]',ANTHROPIC_DEFAULT_OPUS_MODEL:'glm-5.1'};

test('existing GLM connection is selected as one source without hooks or tool policy',()=>{
 const result=pickExistingClaudeGlmEnvironment({env:{...selected,
  NODE_OPTIONS:'--import unsafe',CLAUDE_CODE_USE_POWERSHELL_TOOL:'1',
  ANTHROPIC_API_KEY:'other-credential'},hooks:{SessionStart:'unsafe'},
  permissions:{allow:['Bash(*)']},mcpServers:{other:{command:'unsafe'}}});
 assert.deepEqual(result,selected);
 assert.ok(Object.isFrozen(result));
 assert.deepEqual(Object.keys(result).sort(),[...CLAUDE_GLM_ENVIRONMENT_NAMES].sort());
});

test('partial or invalid GLM connection fails without a first-party or ambient fallback',()=>{
 for(const env of [{ANTHROPIC_AUTH_TOKEN:'one'},{ANTHROPIC_BASE_URL:selected.ANTHROPIC_BASE_URL},
  {...selected,ANTHROPIC_AUTH_TOKEN:''},{...selected,ANTHROPIC_AUTH_TOKEN:'   '},
  {...selected,ANTHROPIC_AUTH_TOKEN:'a\nb'},
  {...selected,ANTHROPIC_AUTH_TOKEN:'a'.repeat(4097)},
  {...selected,ANTHROPIC_MODEL:'x\0y'},{...selected,ANTHROPIC_MODEL:'   '},
  {...selected,ANTHROPIC_MODEL:'m'.repeat(161)},
  ...['http://open.bigmodel.cn/api/anthropic','https://other.invalid/api/anthropic',
   'https://open.bigmodel.cn:443/api/anthropic',
   'https://open.bigmodel.cn/api/anthropic?token=synthetic-secret',
   'https://user:synthetic-secret@open.bigmodel.cn/api/anthropic',
   'https://open.bigmodel.cn/api/anthropic#fragment'].map(ANTHROPIC_BASE_URL=>({...selected,ANTHROPIC_BASE_URL}))]){
  assert.throws(()=>pickExistingClaudeGlmEnvironment({env}),
   error=>error instanceof Error&&error.message==='CLAUDE_EXISTING_MODEL_CONFIGURATION_INVALID');
 }
});

test('model aliases may be absent, but cannot be completed from an inherited route',()=>{
 assert.deepEqual(pickExistingClaudeGlmEnvironment({env:{
  ANTHROPIC_AUTH_TOKEN:selected.ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL:selected.ANTHROPIC_BASE_URL}}),
  {ANTHROPIC_AUTH_TOKEN:selected.ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL:selected.ANTHROPIC_BASE_URL});
 assert.deepEqual(pickExistingClaudeGlmEnvironment({env:{NODE_OPTIONS:'ignored'}}),{});
 assert.deepEqual(pickExistingClaudeGlmEnvironment({}),{});
});

test('native GLM selection cannot silently fall back when its fixed user configuration is absent',()=>{
 for(const settings of [{},{env:{}},{env:{NODE_OPTIONS:'ignored'}}])
  assert.throws(()=>pickExistingClaudeGlmEnvironment(settings,true),
   error=>error instanceof Error&&error.message==='CLAUDE_EXISTING_MODEL_CONFIGURATION_INVALID');
});

test('selected trusted GLM environment replaces ambient host routing only in memory',()=>{
 const inherited={USERPROFILE:'C:\\Users\\user',ANTHROPIC_AUTH_TOKEN:'ambient-token',
  ANTHROPIC_BASE_URL:'http://localhost:8082',ANTHROPIC_API_KEY:'ambient-api-key',
  CLAUDE_CODE_USE_POWERSHELL_TOOL:'1'};
 const before=JSON.stringify(inherited);
 const input={executablePath:'C:\\Users\\user\\.local\\bin\\claude.exe',root:'C:\\private\\attempt',
  maxTurns:2,mcpEndpoint:'http://127.0.0.1:52796/mcp',bearerToken:'x'.repeat(48),
  inheritedEnv:inherited,modelEnvironment:pickExistingClaudeGlmEnvironment({env:selected})};
 const spec=buildClaudeWindowsLaunchSpec(input);
 for(const [key,value] of Object.entries(selected))assert.equal(spec.env[key],value);
 assert.equal(spec.env.ANTHROPIC_API_KEY,undefined);
 assert.equal(spec.env.CLAUDE_CODE_USE_POWERSHELL_TOOL,undefined);
 assert.equal(JSON.stringify(spec.argv).includes(selected.ANTHROPIC_AUTH_TOKEN),false);
 assert.equal(spec.mcpConfigBytes.includes(selected.ANTHROPIC_AUTH_TOKEN),false);
 assert.equal(JSON.stringify(inherited),before);
 assert.ok(spec.argv.includes('--restricted'));
 assert.equal(spec.argv[spec.argv.indexOf('--setting-sources')+1],'');
 assert.equal(spec.argv[spec.argv.indexOf('--settings')+1],'{"disableAllHooks":true}');
 assert.equal(spec.argv[spec.argv.indexOf('--tools')+1],'');
});
