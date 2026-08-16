import { existsSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PICKED_ATTACHMENT_BYTES,
  normalizedPickerLimit,
  stagePickedAttachments
} from '../src/main/attachment-picker'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, copyFile: vi.fn(actual.copyFile) }
})

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'warish-picker-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  vi.mocked(copyFile).mockClear()
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('attachment picker staging', () => {
  it('preserves picker order for an image batch', async () => {
    const directory = temporaryDirectory()
    const sources = ['third.webp', 'first.png', 'second.jpg'].map((name, index) => {
      const path = join(directory, name)
      writeFileSync(path, Buffer.alloc(index + 1, index + 1))
      return path
    })

    const picked = await stagePickedAttachments(join(directory, 'profile'), sources, 30)

    expect(picked.map((attachment) => attachment.name)).toEqual(['third.webp', 'first.png', 'second.jpg'])
    expect(picked.map((attachment) => attachment.mimeType)).toEqual(['image/webp', 'image/png', 'image/jpeg'])
    expect(readdirSync(join(directory, 'profile', 'drafts'))).toHaveLength(3)
  })

  it('rejects mixed multi-file batches without creating draft files', async () => {
    const directory = temporaryDirectory()
    const image = join(directory, 'photo.png')
    const document = join(directory, 'quote.pdf')
    writeFileSync(image, 'image')
    writeFileSync(document, 'document')

    await expect(stagePickedAttachments(join(directory, 'profile'), [image, document], 30))
      .rejects.toThrow('only images')
    expect(existsSync(join(directory, 'profile', 'drafts'))).toBe(false)
  })

  it('enforces the requested count and the global 30-image cap before staging', async () => {
    const directory = temporaryDirectory()
    await expect(stagePickedAttachments(directory, ['one.png', 'two.png'], 1)).rejects.toThrow('no more than 1 file')
    await expect(stagePickedAttachments(directory, Array.from({ length: 31 }, (_, index) => `${index}.png`), 100))
      .rejects.toThrow('no more than 30 files')
    expect(normalizedPickerLimit(100)).toBe(30)
  })

  it('rejects empty and oversized files before copying any member of the batch', async () => {
    const directory = temporaryDirectory()
    const valid = join(directory, 'valid.png')
    const empty = join(directory, 'empty.jpg')
    const oversized = join(directory, 'oversized.webp')
    writeFileSync(valid, 'valid')
    writeFileSync(empty, '')
    writeFileSync(oversized, '')
    truncateSync(oversized, MAX_PICKED_ATTACHMENT_BYTES + 1)

    await expect(stagePickedAttachments(join(directory, 'empty-profile'), [valid, empty], 30)).rejects.toThrow('not a valid file')
    await expect(stagePickedAttachments(join(directory, 'large-profile'), [valid, oversized], 30)).rejects.toThrow('2 GB each')
    expect(existsSync(join(directory, 'empty-profile', 'drafts'))).toBe(false)
    expect(existsSync(join(directory, 'large-profile', 'drafts'))).toBe(false)
  })

  it('removes every newly created draft when copying fails partway through a batch', async () => {
    const directory = temporaryDirectory()
    const first = join(directory, 'first.png')
    const second = join(directory, 'second.jpg')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    vi.mocked(copyFile)
      .mockImplementationOnce((_source, destination) => {
        writeFileSync(String(destination), 'copied')
        return Promise.resolve()
      })
      .mockRejectedValueOnce(new Error('simulated copy failure'))

    await expect(stagePickedAttachments(join(directory, 'profile'), [first, second], 30))
      .rejects.toThrow('simulated copy failure')

    expect(readdirSync(join(directory, 'profile', 'drafts'))).toEqual([])
  })
})
