'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

test('tasks API supports listing, creation, validation, and deletion', async (t) => {
  const rows = [];
  let nextId = 1;
  const pool = {
    async query(sql, parameters = []) {
      if (sql.startsWith('SELECT id, title')) {
        return { rows: [...rows].reverse() };
      }
      if (sql.startsWith('INSERT INTO tasks')) {
        const task = { id: nextId++, title: parameters[0], created_at: '2026-10-03T00:00:00.000Z' };
        rows.push(task);
        return { rows: [task], rowCount: 1 };
      }
      if (sql.startsWith('DELETE FROM tasks')) {
        const index = rows.findIndex((task) => task.id === parameters[0]);
        if (index < 0) {
          return { rows: [], rowCount: 0 };
        }
        const [task] = rows.splice(index, 1);
        return { rows: [{ id: task.id }], rowCount: 1 };
      }
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }
  };
  const cache = { isReady: false };
  const server = createApp({ pool, cache, cacheTtlSeconds: 15 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const emptyList = await fetch(`${baseUrl}/api/tasks`);
  assert.equal(emptyList.status, 200);
  assert.deepEqual(await emptyList.json(), []);

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: ' Ship the app ' })
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).title, 'Ship the app');

  const invalid = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '  ' })
  });
  assert.equal(invalid.status, 400);

  const listed = await fetch(`${baseUrl}/api/tasks`);
  assert.equal((await listed.json())[0].title, 'Ship the app');

  const deleted = await fetch(`${baseUrl}/api/tasks/1`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);

  const missing = await fetch(`${baseUrl}/api/tasks/1`, { method: 'DELETE' });
  assert.equal(missing.status, 404);
});
