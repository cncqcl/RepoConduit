import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createWindowsOriginalOwnerFactory} from
  '../../src/adapters/codex/investigator/windows-original-owner.js';

test('an unissued not-started DTO cannot qualify a launch, even with matching IDs', () => {
  const owner=createWindowsOriginalOwnerFactory();
  const launch={launchId:'11111111-1111-4111-8111-111111111111'};
  const observation={kind:'windows_app_server_not_started_v1',launchId:launch.launchId};
  assert.equal(owner.verifyNotStarted(launch as never,observation as never),false);
  assert.equal(createWindowsOriginalOwnerFactory().verifyNotStarted(launch as never,
    observation as never),false);
});

test('prepare rejects caller supplied authority and channels before native spawn', async () => {
  const factory=createWindowsOriginalOwnerFactory();
  await assert.rejects(factory.prepare({runtimeRoot:'C:\\missing',sourcePath:'C:\\missing',
    claim:{} as never,binding:{} as never,maxWallSeconds:5,
    start:()=>true} as never),{message:'WINDOWS_ORIGINAL_OWNER_UNAVAILABLE'});
});
