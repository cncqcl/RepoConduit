import test from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greet.mjs';

test('greets a normal name', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});

test('trims surrounding spaces', () => {
  assert.equal(greet('  Lin  '), 'Hello, Lin!');
});
