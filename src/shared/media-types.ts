const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip'
}

const EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(MIME_TYPE_BY_EXTENSION).map(([extension, mimeType]) => [mimeType, extension])),
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'image/jpeg': '.jpg'
}

export function mimeTypeForPath(path: string): string {
  return MIME_TYPE_BY_EXTENSION[fileExtension(path) ?? ''] ?? 'application/octet-stream'
}

export function extensionForMedia(mimeType?: string, fileName?: string): string {
  const normalizedMimeType = mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  return EXTENSION_BY_MIME_TYPE[normalizedMimeType ?? ''] ?? fileExtension(fileName) ?? '.bin'
}

function fileExtension(path?: string): string | undefined {
  const name = path?.split(/[\\/]/).at(-1)
  const match = name?.match(/(\.[a-z0-9]{1,10})$/i)
  return match?.[1]?.toLowerCase()
}
