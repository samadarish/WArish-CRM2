import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '..')

if (process.platform === 'win32') {
  const electronDirectory = join(root, 'node_modules', 'electron', 'dist')
  const target = join(electronDirectory, 'electron.exe')
  const editor = join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe')
  const icon = join(root, 'build', 'icon.ico')

  let prepared = false
  try {
    await promisify(execFile)(editor, [
      target,
      '--set-icon', icon,
      '--set-version-string', 'ProductName', 'WArish',
      '--set-version-string', 'FileDescription', 'WArish',
      '--set-version-string', 'InternalName', 'WArish',
      '--set-version-string', 'OriginalFilename', 'electron.exe'
    ], { windowsHide: true })
    prepared = true
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
    if (!stderr.includes('Unable to commit changes')) throw error
    console.warn('Skipped refreshing the development icon because Electron is already running. Close all WArish development windows to apply a new icon.')
  }

  if (prepared) {
    const iconCacheRefresh = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'ie4uinit.exe')
    try {
      await promisify(execFile)(iconCacheRefresh, ['-show'], { windowsHide: true })
    } catch (error) {
      console.warn('Windows icon cache refresh was unavailable:', error.message)
    }
    console.log('Prepared branded Electron development executable.')
  }
}
