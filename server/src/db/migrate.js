#!/usr/bin/env node
'use strict';

/**
 * Raw-SQL migration runner. Applies migrations/*.sql files in lexical order.
 * Uses schema_migrations to track which versions have been applied.
 *
 * Usage:
 *   node src/db/migrate.js up        # apply pending migrations
 *   node src/db/migrate.js status    # show applied / pending
 */

const fs   = require('fs');
const path = require('path');
const { pool, close } = require('./client');
const logger = require('../config/logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function listFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

function versionOf(filename) {
  // '0001_init.sql' -> '0001_init'
  return filename.replace(/\.sql$/, '');
}

async function ensureTrackingTable() {
  // schema_migrations may not exist on a brand-new database. We try to read it;
  // if it errors, we run the first migration (which creates it). Subsequent
  // migrations require the table.
  try {
    await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
  } catch (_) {
    // table doesn't exist yet - that's fine, 0001_init.sql will create it
  }
}

async function appliedVersions() {
  try {
    const r = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    return r.rows.map((row) => row.version);
  } catch (_) {
    return [];
  }
}

async function applyMigration(filename) {
  const fullPath = path.join(MIGRATIONS_DIR, filename);
  const sql      = fs.readFileSync(fullPath, 'utf8');
  const version  = versionOf(filename);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING',
      [version]
    );
    await client.query('COMMIT');
    logger.info({ version }, '[migrate] applied');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, version }, '[migrate] failed');
    throw err;
  } finally {
    client.release();
  }
}

async function up() {
  await ensureTrackingTable();
  const files   = listFiles();
  const already = new Set(await appliedVersions());
  let count = 0;
  for (const f of files) {
    if (already.has(versionOf(f))) continue;
    await applyMigration(f);
    count++;
  }
  logger.info({ applied: count, total: files.length }, '[migrate] up complete');
}

async function status() {
  const files   = listFiles();
  const already = new Set(await appliedVersions());
  const rows = files.map((f) => ({ version: versionOf(f), applied: already.has(versionOf(f)) }));
  // eslint-disable-next-line no-console
  console.table(rows);
}

async function main() {
  const cmd = process.argv[2] || 'up';
  try {
    if      (cmd === 'up')     await up();
    else if (cmd === 'status') await status();
    else {
      // eslint-disable-next-line no-console
      console.error('usage: node src/db/migrate.js [up|status]');
      process.exit(1);
    }
  } catch (err) {
    logger.error({ err }, '[migrate] error');
    process.exitCode = 1;
  } finally {
    await close();
  }
}

if (require.main === module) main();
