// Copies an application's old SQLite database (App.db) into its PostgreSQL database.
//
//   node import.mjs <safeguard|gameout> [--force]
//
// The PostgreSQL tables must already exist: start the application's backend once, it applies its
// migrations. Rows keep their ids, so relations, users and password hashes stay valid.
// Connection: PGHOST, PGPORT, PGUSER, PGPASSWORD (a superuser, to load tables in any order).
// SQLITE_FILE overrides the default /import/<app>/App.db.
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const apps = ['safeguard', 'gameout'];
const [app] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const force = process.argv.includes('--force');

if (!apps.includes(app)) {
  console.error(`Usage: import.mjs <${apps.join('|')}> [--force]`);
  process.exit(2);
}

const source = process.env.SQLITE_FILE ?? `/import/${app}/App.db`;
const database = process.env.PGDATABASE_TARGET ?? app;

/**
 * Opens a copy: the original may be on a read-only mount, and its -wal file can hold rows that
 * were never checkpointed into App.db. Opening the copy read-write lets SQLite replay them.
 */
function openCopy(file) {
  if (!existsSync(file)) throw new Error(`${file} not found`);
  const folder = mkdtempSync(join(tmpdir(), 'sqlite-import-'));
  const copy = join(folder, basename(file));
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix);
  }
  return new DatabaseSync(copy);
}

const quote = (name) => `"${name.replace(/"/g, '""')}"`;

/** SQLite value -> value for a PostgreSQL column of the given data_type. */
function convert(value, type) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'boolean':
      return typeof value === 'string' ? ['1', 'true'].includes(value.toLowerCase()) : Number(value) !== 0;
    case 'bytea':
      return value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
    case 'smallint':
    case 'integer':
    case 'bigint':
    case 'numeric':
    case 'real':
    case 'double precision':
      return String(value);
    default:
      // text, character varying, uuid, timestamps (EF Core stored DateTime as ISO text in SQLite).
      return typeof value === 'bigint' ? value.toString() : value;
  }
}

async function main() {
  const sqlite = openCopy(source);
  const client = new pg.Client({ database });
  await client.connect();

  const sqliteTables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__EFMigrationsHistory' ORDER BY name")
    .all()
    .map((row) => row.name);

  const { rows: columnRows } = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  const pgTables = new Map();
  for (const row of columnRows) {
    if (!pgTables.has(row.table_name)) pgTables.set(row.table_name, []);
    pgTables.get(row.table_name).push(row);
  }

  if (!pgTables.has('__EFMigrationsHistory')) {
    throw new Error(`Database "${database}" has no tables yet: start the ${app} backend once (it applies the migrations), then run this again.`);
  }

  // Plan: matching tables and the columns both sides have.
  const plan = [];
  for (const table of sqliteTables) {
    const target = pgTables.get(table);
    if (!target) {
      console.warn(`! ${table}: not in PostgreSQL, skipped`);
      continue;
    }
    const sourceColumns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all().map((column) => column.name);
    const columns = target.filter((column) => sourceColumns.includes(column.column_name));
    for (const name of sourceColumns.filter((name) => !target.some((column) => column.column_name === name))) {
      console.warn(`! ${table}.${name}: not in PostgreSQL, values dropped`);
    }
    for (const column of target.filter((column) => !sourceColumns.includes(column.column_name))) {
      const filled = column.column_default !== null || column.is_nullable === 'YES';
      console.warn(`! ${table}.${column.column_name}: not in SQLite, ${filled ? 'left to its default' : 'REQUIRED and missing'}`);
    }
    plan.push({ table, columns });
  }

  // Never mix with data that is already there, unless asked to replace it.
  const filled = [];
  for (const { table } of plan) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS count FROM ${quote(table)}`);
    if (rows[0].count > 0) filled.push(`${table} (${rows[0].count})`);
  }
  if (filled.length && !force) {
    throw new Error(`Database "${database}" already has data in ${filled.join(', ')}. Use --force to replace it.`);
  }

  await client.query('BEGIN');
  try {
    // Superuser only: skip foreign key triggers so tables can be loaded in any order.
    await client.query('SET LOCAL session_replication_role = replica');
    if (filled.length) {
      await client.query(`TRUNCATE ${plan.map(({ table }) => quote(table)).join(', ')} RESTART IDENTITY CASCADE`);
    }

    for (const { table, columns } of plan) {
      const rows = sqlite.prepare(`SELECT ${columns.map((column) => quote(column.column_name)).join(', ')} FROM ${quote(table)}`).all();
      const batch = 200;
      for (let start = 0; start < rows.length; start += batch) {
        const slice = rows.slice(start, start + batch);
        const params = [];
        const tuples = slice.map((row) => {
          const placeholders = columns.map((column) => {
            params.push(convert(row[column.column_name], column.data_type));
            return `$${params.length}`;
          });
          return `(${placeholders.join(', ')})`;
        });
        await client.query(
          `INSERT INTO ${quote(table)} (${columns.map((column) => quote(column.column_name)).join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`,
          params,
        );
      }
    }

    // Identity columns must continue after the copied ids.
    for (const { table, columns } of plan) {
      for (const column of columns.filter((item) => item.is_identity === 'YES' || /^nextval\(/.test(item.column_default ?? ''))) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${quote(column.column_name)}) FROM ${quote(table)}), 0) + 1, false)`,
          [quote(table), column.column_name],
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  // Report and verify.
  let mismatches = 0;
  console.log(`\n${app}: ${source} -> ${database}`);
  for (const { table } of plan) {
    const expected = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get().count;
    const { rows } = await client.query(`SELECT COUNT(*)::int AS count FROM ${quote(table)}`);
    const ok = Number(expected) === rows[0].count;
    if (!ok) mismatches++;
    console.log(`  ${ok ? 'ok' : 'DIFF'}  ${table.padEnd(28)} ${String(rows[0].count).padStart(6)}`);
  }
  await client.end();
  if (mismatches) throw new Error(`${mismatches} table(s) with a different row count`);
  console.log('\nDone.');
}

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
});
