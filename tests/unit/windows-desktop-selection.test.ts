import assert from 'node:assert/strict';
import {test} from 'node:test';
import {desktopVersionMatches,selectWindowsDesktopTarget,WINDOWS_DESKTOP_VERSION} from '../../src/adapters/codex/investigator/windows-desktop-target.js';

const root='C:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin';
const a=`${root}\\0123456789abcdef\\codex.exe`,b=`${root}\\fedcba9876543210\\codex.exe`;
const version=`codex-cli ${WINDOWS_DESKTOP_VERSION}\n`;
const runtime=(entries=['0123456789abcdef'],supported=[a])=>({root,
 directories:()=>entries,valid:(path:string)=>path===a||path===b,
 version:(path:string)=>({status:0,stdout:supported.includes(path)?version:'codex-cli 0.163.0-alpha.10.2\n'})});

test('Desktop selection accepts the reviewed 0.165 alpha.1.2 executable exactly',()=>{
 const patched='codex-cli 0.165.0-alpha.1.2\n';
 assert.equal(desktopVersionMatches(patched),true);
 assert.equal(selectWindowsDesktopTarget({...runtime(),version:()=>({status:0,stdout:patched})}),a);
 assert.equal(selectWindowsDesktopTarget({...runtime(['0123456789abcdef','fedcba9876543210']),
  version:(path:string)=>({status:0,stdout:path===b?patched:'codex-cli 0.163.0-alpha.11.1\n'})}),b);
 for(const text of ['codex-cli 0.163.0-alpha.11.1\n','codex-cli 0.164.0-alpha.11.1\n',
  'codex-cli 0.165.0-alpha.1.20\n',patched+'extra','codex-cli 0.165.0-alpha.2\n'])
  assert.equal(desktopVersionMatches(text),false);
});

test('Desktop selection chooses the unique supported CLI, independent of directory order',()=>{
 assert.equal(selectWindowsDesktopTarget(runtime(['fedcba9876543210','0123456789abcdef'])),a);
 assert.equal(selectWindowsDesktopTarget(runtime(['0123456789abcdef','fedcba9876543210'],[b])),b);
});
test('Desktop selection refuses ambiguity, overflow, unsupported versions and uncertain probes',()=>{
 for(const supplied of [runtime(['0123456789abcdef','fedcba9876543210'],[a,b]),
  runtime(Array(9).fill('0123456789abcdef')),runtime(['0123456789abcdef'],[]),
  {...runtime(),version:()=>({status:null,stdout:version,error:new Error('timeout')})},
  {...runtime(),version:()=>({status:0,stdout:version+'extra'})},
  {...runtime(),valid:()=>false},
  {...runtime(),directories:()=>['..\\npm']},
 ])assert.throws(()=>selectWindowsDesktopTarget(supplied),/NOT_AVAILABLE/);
});
test('Desktop selection does not silently skip an uncertain candidate',()=>{
 assert.throws(()=>selectWindowsDesktopTarget({...runtime(['0123456789abcdef','fedcba9876543210']),
  version:(path:string)=>path===a?{status:0,stdout:version}:{status:null,stdout:'',error:new Error('timeout')}}),/NOT_AVAILABLE/);
});
