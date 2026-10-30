import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {test} from 'node:test';

const compiler='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const source=resolve('native/windows/WindowsJobHost.cs');
const version='codex-cli 0.165.0-alpha.1.2\n';

test('native Desktop target check rejects arbitrary executables and wrong argument shapes before launch',
 {skip:process.platform!=='win32',timeout:45_000},()=>{
  const directory=mkdtempSync(join(tmpdir(),'rcac-desktop-target-'));
  const executable=join(directory,'WindowsJobHost.exe');
  try{
    const built=spawnSync(compiler,['/nologo','/target:exe',`/out:${executable}`,source],
      {encoding:'utf8',timeout:30_000,maxBuffer:8192,windowsHide:true});
    assert.equal(built.status,0,`native compiler: ${built.stdout} ${built.stderr}`);
    for(const args of [
      ['desktop_target_check_v1'],
      ['desktop_target_check_v1','C:\\Windows\\System32\\cmd.exe','--version'],
      ['desktop_target_check_v1','relative\\codex.exe'],
      ['desktop_target_check_v1','C:\\Windows\\System32\\cmd.exe'],
      ['desktop_target_check_v1','\\\\server\\share\\codex.exe'],
      ['desktop_target_check_v1','C:\\Users\\Public\\codex.exe'],
      ['desktop_target_check_v1',join(directory,'codex.exe')],
      ['desktop_target_check_v1',join(homedir(),'AppData','Local','OpenAI','Codex','bin',
        'ABCDEF0123456789','codex.exe')],
      ['desktop_readiness_v1',randomUUID(),randomUUID()],
      ['desktop_readiness_v1',randomUUID(),randomUUID(),'C:\\Windows\\System32\\cmd.exe'],
      ['desktop_config_check_v1',randomUUID(),randomUUID(),'C:\\fixture','0'.repeat(64)],
      ['desktop_config_check_v1',randomUUID(),randomUUID(),'C:\\fixture','0'.repeat(64),
        'C:\\Windows\\System32\\cmd.exe'],
      ['windows_app_server_readonly_v1',randomUUID(),randomUUID(),'C:\\fixture',
        '0'.repeat(64),'C:\\fixture','60'],
    ]){
      const result=spawnSync(executable,args,{encoding:'utf8',timeout:5_000,
        maxBuffer:1024,windowsHide:true});
      assert.equal(result.status,1,`${args[0]} accepted ${args.slice(1).join(' ')}`);
      assert.equal(result.stdout,'');
      assert.match(result.stderr,/^(ARGUMENTS|DESKTOP_TARGET)\r?\n$/);
    }
    const root=join(homedir(),'AppData','Local','OpenAI','Codex','bin');
    if(existsSync(root)){
      const children=readdirSync(root);
      assert.ok(children.length<=8,'bounded official Desktop candidate set');
      const accepted:string[]=[];
      for(const child of children.filter(name=>/^[0-9a-f]{16}$/.test(name))){
        const candidate=join(root,child,'codex.exe');
        if(!existsSync(candidate)||!lstatSync(candidate).isFile())continue;
        const result=spawnSync(executable,['desktop_target_check_v1',candidate],
          {encoding:'utf8',timeout:6_000,maxBuffer:1024,windowsHide:true});
        if(result.status===0){
          assert.equal(result.stdout.replace(/\r\n/g,'\n'),version);
          assert.equal(result.stderr,'');
          accepted.push(candidate);
        }
      }
      assert.equal(accepted.length,1,'one installed supported official Desktop target');
    }
  }finally{
    assert.equal(resolve(dirname(directory)),resolve(tmpdir()));
    assert.match(basename(directory),/^rcac-desktop-target-[A-Za-z0-9]+$/);
    assert.equal(lstatSync(directory).isSymbolicLink(),false);
    rmSync(directory,{recursive:true,force:true});
  }
});
