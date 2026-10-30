import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';

test('snapshot, working-copy and collaboration binding survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-snapshot-'));
  const path = join(dir, 'state.sqlite');
  let db = new SqliteStore(path);
  const ws = 'ws_a', col = 'col_a', other = 'col_b', wc = 'wc_a';
  try {
    db.insertWorkspace({ id: ws, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    db.insertCollaboration({ id: col, workspaceId: ws, openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    db.insertCollaboration({ id: other, workspaceId: ws, openedBy: 'owner', purpose: 'review 2', hostThreadId: null, state: 'open' });
    db.insertWorkingCopy({ id: wc, workspaceId: ws, canonicalRoot: dir });
    const snapshot = createSnapshotFromFiles(wc, 'fixture', { 'src/a.ts': Buffer.from('export const a = 1;') }).toPersisted();
    await db.saveSnapshot({ workspaceId: ws, collaborationId: col, workingCopyId: wc, snapshot }, { workspaceId: ws, collaborationId: col, workingCopyId: wc, commitRef: 'fixture' }, 'capture-1', 'owner', 'cli');
    const repeated = createSnapshotFromFiles(wc, 'fixture', { 'src/a.ts': Buffer.from('export const a = 1;') }).toPersisted();
    assert.equal(repeated.id, snapshot.id);
    assert.notEqual(repeated.cursorKey, snapshot.cursorKey);
    await db.saveSnapshot({ workspaceId: ws, collaborationId: col, workingCopyId: wc, snapshot: repeated }, { workspaceId: ws, collaborationId: col, workingCopyId: wc, commitRef: 'fixture' }, 'capture-1b', 'owner', 'cli');
    await db.saveSnapshot({ workspaceId: ws, collaborationId: other, workingCopyId: wc, snapshot }, { workspaceId: ws, collaborationId: other, workingCopyId: wc, commitRef: 'fixture' }, 'capture-2', 'owner', 'cli');
    db.close();
    db = new SqliteStore(path);
    assert.equal((await db.getSnapshot(snapshot.id, ws, col))?.snapshot.id, snapshot.id);
    assert.equal((await db.getSnapshot(snapshot.id, ws, other))?.snapshot.id, snapshot.id);
    assert.equal((await db.getSnapshot(snapshot.id, ws, col))?.snapshot.files['src/a.ts'], snapshot.files['src/a.ts']);
    assert.equal(await db.getSnapshot(snapshot.id, 'ws_b', col), null);
    assert.equal((await db.getWorkingCopy(ws, wc))?.canonicalRoot, dir);
    assert.equal(await db.collaborationBelongsToWorkspace(ws, col), true);
    assert.equal(await db.collaborationBelongsToWorkspace('ws_b', col), false);
  } finally {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-snapshot-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});
