'use strict';

const { Pool } = require('pg');
const { createClient } = require('redis');
const { createApp } = require('./app');

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function integer(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const port = integer('PORT', '8081');
const cacheTtlSeconds = integer('CACHE_TTL_SECONDS', '15');
const pool = new Pool({
  host: required('DB_HOST'),
  port: integer('DB_PORT', '5432'),
  database: required('DB_NAME'),
  user: required('DB_USER'),
  password: required('DB_PASSWORD'),
  max: 10,
  connectionTimeoutMillis: 3000
});
const cache = createClient({
  socket: {
    host: required('REDIS_HOST'),
    port: integer('REDIS_PORT', '6379'),
    reconnectStrategy: (retries) => Math.min(retries * 250, 3000)
  },
  password: required('REDIS_PASSWORD')
});

let databaseReady = false;
pool.on('error', (error) => console.error('Unexpected PostgreSQL client error:', error));
cache.on('error', (error) => console.error('Redis client error:', error));

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id BIGSERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    databaseReady = true;
    console.info('Database schema is ready');
  } catch (error) {
    databaseReady = false;
    console.error('Database initialization failed; retrying in 3 seconds:', error.message);
    const retry = setTimeout(initializeDatabase, 3000);
    retry.unref();
  }
}

const app = createApp({
  pool: {
    query: async (...args) => {
      if (!databaseReady) {
        const error = new Error('database is not ready');
        error.statusCode = 503;
        throw error;
      }
      return pool.query(...args);
    }
  },
  cache,
  cacheTtlSeconds
});

app.listen(port, '0.0.0.0', () => {
  console.info(`Techway API listening on port ${port}`);
  initializeDatabase();
  cache.connect().catch((error) => {
    console.error('Redis connection failed; the client will retry:', error.message);
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.info(`${signal} received; shutting down`);
  app.close(async (error) => {
    if (error) {
      console.error('HTTP server shutdown failed:', error);
      process.exitCode = 1;
    }
    try {
      await pool.end();
      if (cache.isOpen) {
        await cache.quit();
      }
    } catch (shutdownError) {
      console.error('Dependency shutdown failed:', shutdownError);
      process.exitCode = 1;
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
