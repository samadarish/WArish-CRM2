export function clipboardImageFiles(data: DataTransfer): File[] {
  const itemFiles = Array.from(data.items)
    .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
  if (itemFiles.length) return itemFiles
  return Array.from(data.files).filter((file) => file.type.toLowerCase().startsWith('image/'))
}
