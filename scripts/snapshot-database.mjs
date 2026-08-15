import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants, copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

const [sourceInput, keyInput, destinationRootInput] = process.argv.slice(2)
if (!sourceInput || !keyInput || !destinationRootInput) {
  throw new Error('Usage: node scripts/snapshot-database.mjs <warish.sqlite> <master-key.bin> <destination-root>')
}

const source = resolve(sourceInput)
const key = resolve(keyInput)
const destinationRoot = resolve(destinationRootInput)
if (basename(source) !== 'warish.sqlite') throw new Error('The source must be the WArish database named warish.sqlite')
if (basename(key) !== 'master-key.bin') throw new Error('The key must be named master-key.bin')

await Promise.all([stat(source), stat(key)])
await mkdir(destinationRoot, { recursive: true, mode: 0o700 })
const timestamp = new Date().toISOString().replaceAll(':', '-').replace('.', '-')
const snapshotDirectory = join(destinationRoot, `upgrade-${timestamp}`)
await mkdir(snapshotDirectory, { recursive: false, mode: 0o700 })

const databaseTarget = join(snapshotDirectory, 'warish.sqlite')
const keyTarget = join(snapshotDirectory, 'master-key.bin')
const sourceDatabase = new DatabaseSync(source, { readOnly: true })
let sourceSchemaVersion
try {
  assertIntegrity(sourceDatabase, 'source')
  sourceSchemaVersion = schemaVersion(sourceDatabase)
  await backup(sourceDatabase, databaseTarget)
} finally {
  sourceDatabase.close()
}

await copyFile(key, keyTarget, constants.COPYFILE_EXCL)
const backupDatabase = new DatabaseSync(databaseTarget, { readOnly: true })
let backupSchemaVersion
let rowCounts
try {
  assertIntegrity(backupDatabase, 'backup')
  backupSchemaVersion = schemaVersion(backupDatabase)
  rowCounts = countRows(backupDatabase)
} finally {
  backupDatabase.close()
}
if (backupSchemaVersion !== sourceSchemaVersion) throw new Error('Backup schema version does not match the source')

const [databaseStat, keyStat, databaseSha256, keySha256] = await Promise.all([
  stat(databaseTarget),
  stat(keyTarget),
  sha256(databaseTarget),
  sha256(keyTarget)
])
const manifest = {
  format: 1,
  createdAt: new Date().toISOString(),
  source,
  schemaVersion: backupSchemaVersion,
  rowCounts,
  files: {
    'warish.sqlite': { bytes: databaseStat.size, sha256: databaseSha256 },
    'master-key.bin': { bytes: keyStat.size, sha256: keySha256 }
  }
}
await writeFile(join(snapshotDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ snapshotDirectory, schemaVersion: backupSchemaVersion, rowCounts,
  databaseBytes: databaseStat.size, integrity: 'ok' }))

function assertIntegrity(database, label) {
  const rows = database.prepare('PRAGMA integrity_check').all()
  if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') throw new Error(`${label} database integrity check failed`)
}

function schemaVersion(database) {
  const row = database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get()
  return Number(row?.version ?? 0)
}

function countRows(database) {
  const tables = ['chats', 'messages', 'contacts', 'crm_contacts', 'crm_orders', 'crm_tasks']
  const available = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)))
  return Object.fromEntries(tables.filter((table) => available.has(table)).map((table) => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
    return [table, Number(row?.count ?? 0)]
  }))
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
