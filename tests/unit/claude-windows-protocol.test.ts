import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  buildClaudeWindowsLaunchSpec, buildClaudeWindowsUserFrame,
  parseClaudeWindowsStreamOutcome,
} from '../../src/adapters/secondary-investigator/claude-windows-protocol.js';

const root = 'C:\\private\\attempt-1';
const launchInput = () => ({
  executablePath: 'C:\\Users\\user\\.local\\bin\\claude.exe', root,
  maxTurns: 2,
  mcpEndpoint: 'http://127.0.0.1:52796/mcp',
  bearerToken: 'a'.repeat(48),
  inheritedEnv: {
    USERPROFILE: 'C:\\Users\\user', APPDATA: 'C:\\Users\\user\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local', SystemRoot: 'C:\\Windows',
    Path: 'C:\\Windows\\System32', HTTPS_PROXY: 'http://127.0.0.1:33210',
    ANTHROPIC_API_KEY: 'must-not-inherit', ANTHROPIC_AUTH_TOKEN: 'must-not-inherit',
    ANTHROPIC_BASE_URL: 'https://untrusted.invalid', OTHER_SECRET: 'must-not-inherit',
  },
});

test('current Windows CLI launch is fixed, uses private MCP file, and never places bearer in argv', () => {
  const spec = buildClaudeWindowsLaunchSpec(launchInput());
  assert.equal(spec.file, launchInput().executablePath);
  assert.equal(spec.cwd, `${root}\\work`);
  assert.equal(spec.mcpConfigPath, `${root}\\mcp.json`);
  assert.equal(spec.formatContract, 'claude_windows_stream_json_2_1_287');
  assert.deepEqual(spec.argv, [
    '--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--no-session-persistence', '--tools', '', '--restricted', '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', `${root}\\mcp.json`,
    '--disable-slash-commands', '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none', '--settings', '{"disableAllHooks":true}',
    '--max-turns', '2', '--allowedTools',
    'mcp__repo-conduit__repo.read,mcp__repo-conduit__repo_read',
  ]);
  const parsed = JSON.parse(spec.mcpConfigBytes.toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(parsed, {mcpServers: {'repo-conduit': {type: 'http',
    url: 'http://127.0.0.1:52796/mcp',
    headers: {Authorization: `Bearer ${'a'.repeat(48)}`}}}});
  assert.equal(spec.mcpConfigSha256,
    createHash('sha256').update(spec.mcpConfigBytes).digest('hex'));
  assert.equal(JSON.stringify(spec.argv).includes('a'.repeat(48)), false);
  assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(spec.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(spec.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(spec.env.OTHER_SECRET, undefined);
  assert.equal(spec.env.PATH, 'C:\\Windows\\System32');
  assert.equal(spec.env.HTTPS_PROXY, 'http://127.0.0.1:33210');
  assert.equal(spec.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
});

test('launch rejects remote MCP endpoints, path escapes, arbitrary bearer and inherited provider overrides', () => {
  for (const endpoint of [
    'https://example.com/mcp', 'http://localhost:52796/mcp',
    'http://127.0.0.1:52796/other', 'http://127.0.0.1:52796/mcp?x=1',
    'http://name:pass@127.0.0.1:52796/mcp',
  ]) assert.throws(() => buildClaudeWindowsLaunchSpec({...launchInput(), mcpEndpoint: endpoint}));
  for (const bad of [
    {...launchInput(), root: 'C:\\private\\..\\escape'},
    {...launchInput(), executablePath: 'claude.exe'},
    {...launchInput(), bearerToken: 'bad\r\nheader'},
    {...launchInput(), maxTurns: 0},
    {...launchInput(), maxTurns: 9},
    {...launchInput(), maxTurns: 1.5},
  ]) assert.throws(() => buildClaudeWindowsLaunchSpec(bad));
});

test('one stream-json input frame has a fixed user envelope without extra commands', () => {
  assert.deepEqual(buildClaudeWindowsUserFrame('Read the scoped file.'), {
    type: 'user', message: {role: 'user', content: 'Read the scoped file.'},
    parent_tool_use_id: null, session_id: '',
  });
  assert.throws(() => buildClaudeWindowsUserFrame(''));
  assert.throws(() => buildClaudeWindowsUserFrame('unsafe\0frame'));
});

const toolName = 'mcp__repo-conduit__repo_read'; // Synthetic until observed in native init.
const event = (value: unknown) => JSON.stringify(value);
const init = {type: 'system', subtype: 'init', tools: [toolName], session_id: 'discard'};
const use = {type: 'assistant', message: {content: [{type: 'tool_use', id: 'tool-1',
  name: toolName, input: {path: 'src/state.py'}}]}};
const resultTool = {type: 'user', message: {content: [{type: 'tool_result',
  tool_use_id: 'tool-1', content: 'synthetic read result', is_error: false}]}};
const finish = {type: 'result', subtype: 'success', is_error: false, num_turns: 1,
  result: 'The state transition is guarded.', session_id: 'discard'};
const raw = (...events: unknown[]) => Buffer.from(events.map(event).join('\n') + '\n');
const limits = {expectedToolName: toolName, maxTurns: 1, maxToolCalls: 3,
  elapsedMs: 1_000, maxElapsedMs: 60_000};
const nativeUuid = '11b02233-4455-4677-8899-aabbccddeeff';
const uiInvalidate = {type:'system',subtype:'ui_invalidate',event:'ui.render',
  uuid:nativeUuid,session_id:'discard'};
const thinkingProgress = {type:'system',subtype:'thinking_tokens',estimated_tokens:23,
  estimated_tokens_delta:5,session_id:'discard',uuid:nativeUuid};
const thinkingAssistant = {type:'assistant',message:{content:[
  {type:'thinking',thinking:'Synthetic internal text only.',signature:'synthetic-signature'},
]}};

test('bounded ordered stream gives a current-version outcome candidate, not a tool receipt', () => {
  const bytes = raw(init, use, resultTool, finish);
  assert.deepEqual(parseClaudeWindowsStreamOutcome(bytes, limits), {
    kind: 'claude_model_outcome_candidate_v1',
    formatContract: 'claude_windows_stream_json_2_1_287',
    result: finish.result, sessionId: 'discard', numTurns: 1, observedToolCalls: 1,
    rawBytesSha256: createHash('sha256').update(bytes).digest('hex'),
  });
});

test('one complete JSON fence unwraps only the model result and preserves original stream identity', () => {
  const json = '{"synthetic":"result"}';
  for (const newline of ['\n', '\r\n']) {
    const bytes = raw(init, use, resultTool, {...finish, result: `\`\`\`json${newline}${json}${newline}\`\`\``});
    const candidate = parseClaudeWindowsStreamOutcome(bytes, limits);
    assert.equal(candidate?.result, json);
    assert.equal(candidate?.rawBytesSha256, createHash('sha256').update(bytes).digest('hex'));
  }
});

test('JSON fence handling cannot extract an answer from prose, partial or competing fences', () => {
  for (const value of [
    'prefix\n```json\n{}\n```', '```json\n{}\n```\nsuffix',
    '```javascript\n{}\n```', '```JSON\n{}\n```', '```json\n{}',
    '```json\n{}\n```\n```json\n{}\n```',
    '```json\n```json\n{}\n```\n```',
  ]) {
    const candidate = parseClaudeWindowsStreamOutcome(raw(init, use, resultTool, {...finish, result: value}), limits);
    // Unsupported wrappers stay opaque and cannot bypass the downstream strict JSON parser.
    assert.equal(candidate?.result, value);
  }
});

test('observed Windows notification and thinking frames preserve the same bounded result candidate', () => {
  const bytes=raw(uiInvalidate,init,thinkingProgress,thinkingAssistant,use,
    thinkingProgress,resultTool,thinkingProgress,finish);
  const candidate=parseClaudeWindowsStreamOutcome(bytes,limits);
  assert.equal(candidate?.result,finish.result);
  assert.equal(candidate?.sessionId,'discard');
  assert.equal(candidate?.observedToolCalls,1);
  assert.equal(candidate?.rawBytesSha256,createHash('sha256').update(bytes).digest('hex'));
  assert.doesNotMatch(JSON.stringify(candidate),/Synthetic internal text|synthetic-signature/);
  assert.equal(parseClaudeWindowsStreamOutcome(raw(uiInvalidate,init,thinkingProgress,
    thinkingAssistant,finish),limits),null,'notifications cannot replace a successful read');
  assert.equal(parseClaudeWindowsStreamOutcome(raw(uiInvalidate,init,thinkingProgress,
    thinkingAssistant,use,resultTool),limits),null,'notifications cannot replace the final result');
});

test('notification families reject changed sessions, malformed counters and unknown frames', () => {
  const bad=[
    raw({...uiInvalidate,session_id:'other'},init,use,resultTool,finish),
    raw(uiInvalidate,{...init,session_id:'other'},use,resultTool,{...finish,session_id:'other'}),
    raw(init,{...thinkingProgress,session_id:'other'},use,resultTool,finish),
    raw(init,{...uiInvalidate,session_id:'other'},use,resultTool,finish),
    raw(init,{...thinkingProgress,estimated_tokens:-1},use,resultTool,finish),
    raw(init,{...thinkingProgress,estimated_tokens_delta:1.5},use,resultTool,finish),
    raw(init,{...thinkingProgress,estimated_tokens_delta:-1},use,resultTool,finish),
    raw(init,{...thinkingProgress,estimated_tokens:'23'},use,resultTool,finish),
    raw(init,{...thinkingProgress,estimated_tokens:Number.MAX_SAFE_INTEGER+1},use,resultTool,finish),
    raw(init,{...thinkingProgress,uuid:''},use,resultTool,finish),
    raw(init,{...uiInvalidate,event:'ui.other'},use,resultTool,finish),
    raw(init,{...uiInvalidate,unexpected:true},use,resultTool,finish),
    raw(init,{...uiInvalidate,uuid:'not-a-uuid'},use,resultTool,finish),
    raw(init,{type:'system',subtype:'unobserved',session_id:'discard'},use,resultTool,finish),
    raw(init,{...thinkingAssistant,message:{content:[
      {type:'thinking',thinking:'synthetic',signature:9},
    ]}},use,resultTool,finish),
    raw(init,{...thinkingAssistant,message:{content:[
      {type:'thinking',thinking:'synthetic',signature:'sig',other:true},
    ]}},use,resultTool,finish),
    raw(init,{...thinkingAssistant,message:{content:[
      {type:'thinking',thinking:'synthetic\0invalid',signature:'sig'},
    ]}},use,resultTool,finish),
    raw(init,use,resultTool,finish,thinkingProgress),
  ];
  for(const bytes of bad)assert.equal(parseClaudeWindowsStreamOutcome(bytes,limits),null);
});

test('observed long notification run stays within the original byte and line budgets', () => {
  const notifications=Array.from({length:1013},(_,index)=>({...thinkingProgress,
    estimated_tokens:index+1,estimated_tokens_delta:1}));
  const accepted=raw(uiInvalidate,init,...notifications,use,resultTool,finish);
  assert.ok(accepted.length<256*1024);
  assert.equal(parseClaudeWindowsStreamOutcome(accepted,limits)?.observedToolCalls,1);
  assert.equal(parseClaudeWindowsStreamOutcome(raw(uiInvalidate,init,
    ...notifications,...Array.from({length:8},()=>thinkingProgress),
    use,resultTool,finish),limits),null,'the existing 1024-line cap still applies');
});

test('either known exact MCP spelling can be observed, but one invocation cannot switch names', () => {
  const dotted='mcp__repo-conduit__repo.read';
  const useDot={...use,message:{content:[{type:'tool_use',id:'tool-1',name:dotted,
   input:{path:'src/state.py'}}]}};
  assert.equal(parseClaudeWindowsStreamOutcome(raw({...init,tools:[dotted]},
   useDot,resultTool,finish),{...limits,expectedToolName:dotted})?.observedToolCalls,1);
  assert.equal(parseClaudeWindowsStreamOutcome(raw({...init,tools:[dotted]},
   use,resultTool,finish),{...limits,expectedToolName:dotted}),null);
  assert.equal(parseClaudeWindowsStreamOutcome(raw({...init,tools:['mcp__other__read']},
   use,resultTool,finish),{...limits,expectedToolName:'mcp__other__read'}),null);
});

test('stream rejects unsupported tools, missing/duplicate results, errors and budget excess', () => {
  const invalid = [
    raw({...init, tools: [toolName, 'Bash']}, use, resultTool, finish),
    raw(init, use, finish), raw(init, resultTool, use, finish),
    raw(init, use, resultTool, finish, finish),
    raw(init, {...use, message: {content: [{type: 'tool_use', id: 'tool-1',
      name: 'Bash', input: {command: 'echo no'}}]}}, resultTool, finish),
    raw(init, use, {...resultTool, message: {content: [{type: 'tool_result',
      tool_use_id: 'tool-1', content: 'denied', is_error: true}]}}, finish),
    raw(init, use, resultTool, {...finish, subtype: 'error_during_execution'}),
    raw(init, use, resultTool, {...finish, num_turns: 2}),
    raw(init, use, resultTool, {...finish, session_id: 'other'}),
    raw(init, use, resultTool, use, resultTool, finish),
    raw(use, resultTool, finish), raw(init, use, resultTool),
    Buffer.from([0xff]), Buffer.alloc(256 * 1024 + 1),
  ];
  for (const bytes of invalid) assert.equal(parseClaudeWindowsStreamOutcome(bytes, limits), null);
  assert.equal(parseClaudeWindowsStreamOutcome(raw(init, use, resultTool, finish),
    {...limits, maxToolCalls: 0}), null);
  assert.equal(parseClaudeWindowsStreamOutcome(raw(init, use, resultTool, finish),
    {...limits, elapsedMs: 60_001}), null);
});

test('a denied scoped read can precede a successful scoped read but cannot alone prove investigation', () => {
  const denied = {type: 'user', message: {content: [{type: 'tool_result',
    tool_use_id: 'tool-1', content: 'denied', is_error: true}]}};
  const secondUse = {type: 'assistant', message: {content: [{type: 'tool_use', id: 'tool-2',
    name: toolName, input: {path: 'src/cancel.py'}}]}};
  const secondResult = {type: 'user', message: {content: [{type: 'tool_result',
    tool_use_id: 'tool-2', content: 'synthetic read result', is_error: false}]}};
  assert.equal(parseClaudeWindowsStreamOutcome(raw(init, use, denied, finish),
    {...limits, maxToolCalls: 2}), null);
  const candidate = parseClaudeWindowsStreamOutcome(raw(init, use, denied,
    secondUse, secondResult, finish), {...limits, maxToolCalls: 2});
  assert.equal(candidate?.observedToolCalls, 2);
  assert.equal(candidate?.result, finish.result);
});

test('duplicate JSON envelope keys and post-result traffic are rejected', () => {
  const duplicate = Buffer.from(`${event(init)}\n` +
    '{"type":"assistant","type":"assistant","message":{"content":[]}}\n' +
    `${event(use)}\n${event(resultTool)}\n${event(finish)}\n`);
  assert.equal(parseClaudeWindowsStreamOutcome(duplicate, limits), null);
  assert.equal(parseClaudeWindowsStreamOutcome(raw(init, use, resultTool, finish,
    {type: 'assistant', message: {content: []}}), limits), null);
});
