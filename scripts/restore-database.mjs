import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const [snapshotInput, liveDirectoryInput, rollbackRootInput] = process.argv.slice(2)
if (!snapshotInput || !liveDirectoryInput || !rollbackRootInput) {
  throw new Error('Usage: node scripts/restore-database.mjs <snapshot-directory> <live-user-data-directory> <rollback-root>')
}

const snapshotDirectory = resolve(snapshotInput)
const liveDirectory = resolve(liveDirectoryInput)
const rollbackRoot = resolve(rollbackRootInput)
const snapshotDatabase = join(snapshotDirectory, 'warish.sqlite')
const snapshotKey = join(snapshotDirectory, 'master-key.bin')
const manifestPath = join(snapshotDirectory, 'manifest.json')
const liveDatabase = join(liveDirectory, 'warish.sqlite')
const liveKey = join(liveDirectory, 'master-key.bin')

if (basename(snapshotDatabase) !== 'warish.sqlite' || basename(snapshotKey) !== 'master-key.bin') {
  throw new Error('Unexpected WArish snapshot file names')
}
await Promise.all([stat(snapshotDatabase), stat(snapshotKey), stat(manifestPath), stat(liveDatabase), stat(liveKey)])

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest?.format !== 1 || typeof manifest.schemaVersion !== 'number' || !manifest.files || !manifest.rowCounts) {
  throw new Error('Unsupported or incomplete WArish backup manifest')
}
const [databaseStat, keyStat, databaseHash, keyHash] = await Promise.all([
  stat(snapshotDatabase), stat(snapshotKey), sha256(snapshotDatabase), sha256(snapshotKey)
])
if (databaseStat.size !== manifest.files['warish.sqlite']?.bytes || keyStat.size !== manifest.files['master-key.bin']?.bytes) {
  throw new Error('Snapshot size verification failed')
}
if (databaseHash !== manifest.files['warish.sqlite']?.sha256 || keyHash !== manifest.files['master-key.bin']?.sha256) {
  throw new Error('Snapshot hash verification failed')
}
verifyDatabase(snapshotDatabase, manifest)

await mkdir(rollbackRoot, { recursive: true, mode: 0o700 })
const timestamp = new Date().toISOString().replaceAll(':', '-').replace('.', '-')
const rollbackDirectory = join(rollbackRoot, `pre-restore-${timestamp}`)
await mkdir(rollbackDirectory, { recursive: false, mode: 0o700 })

const liveNames = ['warish.sqlite-wal', 'warish.sqlite-shm', 'warish.sqlite', 'master-key.bin']
const movedNames = []
const copiedNames = []
try {
  for (const name of liveNames) {
    const source = join(liveDirectory, name)
    if (!await exists(source)) continue
    await rename(source, join(rollbackDirectory, name))
    movedNames.push(name)
  }

  await copyFile(snapshotDatabase, liveDatabase, constants.COPYFILE_EXCL)
  copiedNames.push('warish.sqlite')
  await copyFile(snapshotKey, liveKey, constants.COPYFILE_EXCL)
  copiedNames.push('master-key.bin')
  const restored = verifyDatabase(liveDatabase, manifest)
  await writeFile(join(rollbackDirectory, 'restore.json'), `${JSON.stringify({
    format: 1,
    restoredAt: new Date().toISOString(),
    snapshotDirectory,
    liveDirectory,
    schemaVersion: restored.schemaVersion,
    rowCounts: restored.rowCounts,
    movedNames
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ liveDirectory, rollbackDirectory, schemaVersion: restored.schemaVersion,
    rowCounts: restored.rowCounts, integrity: 'ok' }))
} catch (error) {
  for (const name of [...copiedNames].reverse()) await removeIfPresent(join(liveDirectory, name))
  for (const name of [...movedNames].reverse()) {
    await rename(join(rollbackDirectory, name), join(liveDirectory, name))
  }
  throw error
}

function verifyDatabase(databasePath, expected) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const integrityRows = database.prepare('PRAGMA integrity_check').all()
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
      throw new Error(`Database integrity check failed for ${databasePath}`)
    }
    const schemaVersion = Number(database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get()?.version ?? 0)
    if (schemaVersion !== expected.schemaVersion) throw new Error('Restored schema version does not match the snapshot manifest')
    const rowCounts = countRows(database, Object.keys(expected.rowCounts))
    for (const [table, count] of Object.entries(expected.rowCounts)) {
      if (rowCounts[table] !== count) throw new Error(`Restored row count does not match for ${table}`)
    }
    return { schemaVersion, rowCounts }
  } finally {
    database.close()
  }
}

function countRows(database, tables) {
  const available = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)))
  return Object.fromEntries(tables.map((table) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid snapshot table name: ${table}`)
    if (!available.has(table)) throw new Error(`Snapshot table is missing: ${table}`)
    return [table, Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0)]
  }))
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function removeIfPresent(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
