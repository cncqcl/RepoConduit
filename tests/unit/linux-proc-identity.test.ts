import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLinuxProcessStat } from '../../src/adapters/secondary-investigator/linux-proc-identity.js';

function row(pid = 123, comm = 'bootstrap (waiting)') {
  const fields = ['S', '120', ...Array<string>(17).fill('0'), '456', ...Array<string>(30).fill('0')];
  return `${pid} (${comm}) ${fields.join(' ')}\n`;
}

test('proc identity parses comm parentheses without shifting PPid and start time', () => {
  assert.deepEqual(parseLinuxProcessStat(row(), 123),
    { pid: 123, parentPid: 120, state: 'S', startTicks: 456 });
  assert.deepEqual(parseLinuxProcessStat(row(123, 'x) S 1 (nested)'), 123),
    { pid: 123, parentPid: 120, state: 'S', startTicks: 456 });
});

test('proc identity rejects wrong PID, dead process, incomplete and excessive input', () => {
  for (const raw of [row(124), row().replace(') S ', ') Z '), row().replace(') S ', ') X '),
    '123 (bootstrap) S 120\n', row().trimEnd(), `${row()}extra`,
    row(123, 'x'.repeat(4096)), row().replace(' 456 ', ' 9007199254740992 '),
    row().replace(' 456 ', ' 0 '), row().replace(') S 120 ', ') S -1 ')]) {
    assert.throws(() => parseLinuxProcessStat(raw, 123));
  }
  for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseLinuxProcessStat(row(), pid));
  }
});

test('proc comm may contain newline and closes at the last right parenthesis', () => {
  assert.equal(parseLinuxProcessStat(row(123, 'line\nname'), 123).startTicks, 456);
});
