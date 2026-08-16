import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { MAX_ALBUM_IMAGES, type PickedAttachment } from '../shared/contracts'
import { mimeTypeForPath } from '../shared/media-types'

export const MAX_PICKED_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024

export function normalizedPickerLimit(maxFiles?: number): number {
  if (maxFiles === undefined) return 1
  if (!Number.isFinite(maxFiles)) throw new Error('Invalid attachment selection limit')
  return Math.min(MAX_ALBUM_IMAGES, Math.max(1, Math.floor(maxFiles)))
}

export async function stagePickedAttachments(
  userDataPath: string,
  sources: readonly string[],
  maxFiles = 1
): Promise<PickedAttachment[]> {
  const limit = normalizedPickerLimit(maxFiles)
  if (sources.length > limit) throw new Error(`Select no more than ${limit} ${limit === 1 ? 'file' : 'files'} at a time.`)
  if (!sources.length) return []

  const files = await Promise.all(sources.map(async (source) => {
    const sourceStat = await stat(source)
    if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error(`${basename(source)} is not a valid file.`)
    if (sourceStat.size > MAX_PICKED_ATTACHMENT_BYTES) throw new Error('Attachments are limited to 2 GB each.')
    return { source, name: basename(source), size: sourceStat.size, mimeType: mimeTypeForPath(source) }
  }))
  if (files.length > 1 && files.some((file) => !file.mimeType.startsWith('image/'))) {
    throw new Error('Select only images when choosing multiple files.')
  }

  const draftsDirectory = join(userDataPath, 'drafts')
  await mkdir(draftsDirectory, { recursive: true })
  const staged: Array<PickedAttachment & { path: string }> = []
  const createdPaths: string[] = []
  try {
    for (const file of files) {
      const token = `${randomUUID()}${extname(file.source).toLowerCase()}`
      const path = safeDraftPath(draftsDirectory, token)
      createdPaths.push(path)
      await copyFile(file.source, path)
      staged.push({ token, path, name: file.name, size: file.size, mimeType: file.mimeType,
        previewUrl: `warish-media://drafts/${encodeURIComponent(token)}` })
    }
  } catch (error) {
    await Promise.all(createdPaths.map((path) => rm(path, { force: true }).catch(() => undefined)))
    throw error
  }
  return staged.map((file) => ({
    token: file.token,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    previewUrl: file.previewUrl
  }))
}

function safeDraftPath(directory: string, token: string): string {
  if (basename(token) !== token) throw new Error('Invalid media token')
  const root = resolve(directory)
  const path = resolve(root, token)
  if (!path.startsWith(`${root}${sep}`) && path !== root) throw new Error('Invalid media path')
  return path
}
