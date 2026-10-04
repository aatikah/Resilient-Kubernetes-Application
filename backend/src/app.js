'use strict';

const http = require('node:http');
const { parseTaskId, validateTaskTitle } = require('./validation');

const CACHE_KEY = 'tasks:list';

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (tooLarge) {
        return;
      }
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) {
        tooLarge = true;
        body = '';
        const error = new Error('Request body exceeds 1 MiB');
        error.statusCode = 413;
        reject(error);
        request.resume();
        return;
      }
    });
    request.on('end', () => {
      if (tooLarge) {
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        const error = new Error('Request body must be valid JSON');
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function createApp({ pool, cache, cacheTtlSeconds }) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { status: 'ok' });
      }

      if (request.method === 'GET' && url.pathname === '/ready') {
        await pool.query('SELECT 1');
        return sendJson(response, 200, { status: 'ready' });
      }

      if (request.method === 'GET' && url.pathname === '/api/tasks') {
        if (cache.isReady) {
          try {
            const cached = await cache.get(CACHE_KEY);
            if (cached !== null) {
              return sendJson(response, 200, JSON.parse(cached));
            }
          } catch (error) {
            console.warn('Task cache read failed; serving from PostgreSQL:', error.message);
          }
        }

        const result = await pool.query(
          'SELECT id, title, created_at FROM tasks ORDER BY id DESC'
        );
        const tasks = result.rows;
        if (cache.isReady) {
          try {
            await cache.setEx(CACHE_KEY, cacheTtlSeconds, JSON.stringify(tasks));
          } catch (error) {
            console.warn('Task cache write failed:', error.message);
          }
        }
        return sendJson(response, 200, tasks);
      }

      if (request.method === 'POST' && url.pathname === '/api/tasks') {
        const body = await readJson(request);
        const result = validateTaskTitle(body && body.title);
        if (result.error) {
          return sendJson(response, 400, { error: result.error });
        }

        const inserted = await pool.query(
          'INSERT INTO tasks (title) VALUES ($1) RETURNING id, title, created_at',
          [result.title]
        );
        await invalidateTaskCache(cache);
        return sendJson(response, 201, inserted.rows[0]);
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (request.method === 'DELETE' && taskMatch) {
        const id = parseTaskId(taskMatch[1]);
        if (id === null) {
          return sendJson(response, 400, { error: 'task id must be a positive integer' });
        }

        const deleted = await pool.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [id]);
        if (deleted.rowCount === 0) {
          return sendJson(response, 404, { error: 'task not found' });
        }
        await invalidateTaskCache(cache);
        return sendJson(response, 200, { deleted: id });
      }

      return sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      if (error.statusCode) {
        return sendJson(response, error.statusCode, { error: error.message });
      }
      console.error('Request failed:', error);
      return sendJson(response, 500, { error: 'internal server error' });
    }
  });
}

async function invalidateTaskCache(cache) {
  if (!cache.isReady) {
    return;
  }

  try {
    await cache.del(CACHE_KEY);
  } catch (error) {
    console.warn('Task cache invalidation failed:', error.message);
  }
}

module.exports = { createApp };
