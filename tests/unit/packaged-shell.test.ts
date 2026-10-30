import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('packaged POSIX preparation helper retains LF newlines on Windows checkouts', () => {
  const bytes = readFileSync('tools/prepare-wsl-private-home.sh');
  assert.equal(bytes.subarray(0, 20).toString(), '#!/usr/bin/env bash\n');
  assert.equal(bytes.includes(13), false, 'CRLF changes shell options and breaks POSIX execution');
});
