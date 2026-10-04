'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTaskId, validateTaskTitle } = require('../src/validation');

test('accepts and trims a non-empty task title', () => {
  assert.deepEqual(validateTaskTitle('  Ship the app  '), { title: 'Ship the app' });
});

test('rejects empty, non-string, and oversized task titles', () => {
  assert.equal(validateTaskTitle('   ').error, 'title must not be empty');
  assert.equal(validateTaskTitle(42).error, 'title must be a string');
  assert.match(validateTaskTitle('x'.repeat(201)).error, /at most 200/);
});

test('accepts only positive safe integer task IDs', () => {
  assert.equal(parseTaskId('12'), 12);
  assert.equal(parseTaskId('0'), null);
  assert.equal(parseTaskId('-1'), null);
  assert.equal(parseTaskId('1.5'), null);
  assert.equal(parseTaskId('9007199254740992'), null);
});
