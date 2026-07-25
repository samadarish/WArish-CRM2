import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const selectedSourcePath = 'design/logo-concepts/round-01/03-flow-salesforce-preview.png'
const checkOnly = process.argv.includes('--check')
const exportedSizes = [16, 32, 64, 128, 256, 512, 1024]
const appIcoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const trayIcoSizes = [16, 20, 24, 32]
const appIconMasterSize = 1024
const appIconMarkVisibleSize = 888
const appIconTileOuterSize = 960
const appIconTileCornerRadius = 211
const emittedFiles = []

const palettes = {
  light: { ribbon: '#0D9DDA', body: '#032D60', source: 'exact selected artwork' },
  dark: { ribbon: '#1B96FF', body: '#0B5CAB', source: 'selected artwork with brightness-only adaptation' },
  trayOnLight: '#032D60',
  trayOnDark: '#F3F9FF'
}

function rgbFromHex(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(value)
  if (!match) throw new Error('Invalid brand color: ' + value)
  const integer = Number.parseInt(match[1], 16)
  return [(integer >> 16) & 255, (integer >> 8) & 255, integer & 255]
}

async function validatePng(buffer, expectedSize, { minExtent = .58, maxExtent = .78 } = {}) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.width !== expectedSize || info.height !== expectedSize || info.channels !== 4) {
    throw new Error('Invalid PNG dimensions: expected ' + expectedSize + 'x' + expectedSize + ' RGBA')
  }
  const cornerOffsets = [
    3,
    (expectedSize - 1) * 4 + 3,
    (expectedSize - 1) * expectedSize * 4 + 3,
    (expectedSize * expectedSize - 1) * 4 + 3
  ]
  if (cornerOffsets.some((offset) => data[offset] !== 0)) {
    throw new Error('PNG ' + expectedSize + 'px has a non-transparent corner')
  }
  let minX = expectedSize
  let minY = expectedSize
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < expectedSize; y += 1) {
    for (let x = 0; x < expectedSize; x += 1) {
      if (data[(y * expectedSize + x) * 4 + 3] < 16) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  if (maxX < 0) throw new Error('PNG ' + expectedSize + 'px has no visible pixels')
  const extent = Math.max(maxX - minX + 1, maxY - minY + 1)
  if (extent < expectedSize * minExtent || extent > expectedSize * maxExtent) {
    throw new Error('PNG ' + expectedSize + 'px has unexpected visible extent ' + extent)
  }
}

async function removeResamplingFringe(buffer, alphaFloor) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] >= alphaFloor) continue
    data[offset] = 0
    data[offset + 1] = 0
    data[offset + 2] = 0
    data[offset + 3] = 0
  }
  return sharp(data, { raw: info }).png({ compressionLevel: 9 }).toBuffer()
}

async function renderMasterPng(master, size, extentRange, alphaFloor = 0) {
  if (size === 1024) {
    await validatePng(master, size, extentRange)
    return master
  }
  let buffer = await sharp(master)
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer()
  if (alphaFloor > 0) buffer = await removeResamplingFringe(buffer, alphaFloor)
  await validatePng(buffer, size, extentRange)
  return buffer
}

async function createDarkMaster(master) {
  const buffer = await sharp(master)
    .modulate({ brightness: 1.14, saturation: 1.08 })
    .png({ compressionLevel: 9 })
    .toBuffer()
  await validatePng(buffer, 1024)
  return buffer
}

async function createAppIconMaster(master) {
  const trimmed = await sharp(master)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
    .png({ compressionLevel: 9 })
    .toBuffer()
  const scaled = await sharp(trimmed)
    .resize(appIconMarkVisibleSize, appIconMarkVisibleSize, { fit: 'inside', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer()
  const metadata = await sharp(scaled).metadata()
  if (!metadata.width || !metadata.height) throw new Error('Could not size the Windows application icon')
  const tileInset = (appIconMasterSize - appIconTileOuterSize) / 2
  const tile = Buffer.from([
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
    '<rect x="' + tileInset + '" y="' + tileInset + '" width="' + appIconTileOuterSize + '" height="' + appIconTileOuterSize + '"',
    ' rx="' + appIconTileCornerRadius + '" fill="#EAF4FB"/>',
    '</svg>'
  ].join(''))
  const left = Math.floor((appIconMasterSize - metadata.width) / 2)
  const top = Math.floor((appIconMasterSize - metadata.height) / 2)
  const buffer = await sharp({
    create: {
      width: appIconMasterSize,
      height: appIconMasterSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: tile }, { input: scaled, left, top }])
    .png({ compressionLevel: 9 })
    .toBuffer()
  await validatePng(buffer, appIconMasterSize, { minExtent: .93, maxExtent: .95 })
  return buffer
}

async function renderMonochromePng(master, size, color) {
  const { data, info } = await sharp(master)
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const [red, green, blue] = rgbFromHex(color)
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = red
    data[offset + 1] = green
    data[offset + 2] = blue
  }
  const buffer = await sharp(data, { raw: info }).png({ compressionLevel: 9 }).toBuffer()
  await validatePng(buffer, size)
  return buffer
}

function embeddedPngSvg(png) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
    '<image width="1024" height="1024" href="data:image/png;base64,' + png.toString('base64') + '"/>',
    '</svg>'
  ].join('')
}

function icoSizes(buffer) {
  const count = buffer.readUInt16LE(4)
  const sizes = []
  for (let index = 0; index < count; index += 1) {
    const width = buffer.readUInt8(6 + index * 16)
    sizes.push(width === 0 ? 256 : width)
  }
  return sizes
}

function validateIco(buffer, expectedSizes, label) {
  const actual = icoSizes(buffer)
  if (actual.length !== expectedSizes.length || actual.some((size, index) => size !== expectedSizes[index])) {
    throw new Error(label + ' ICO frames ' + actual.join(',') + ' do not match ' + expectedSizes.join(','))
  }
}

async function emit(relativePath, value) {
  const path = join(root, relativePath)
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  emittedFiles.push(relativePath.replaceAll('\\', '/'))
  if (checkOnly) {
    let current
    try {
      current = await readFile(path)
    } catch {
      throw new Error('Missing generated brand asset: ' + relativePath)
    }
    if (!current.equals(buffer)) throw new Error('Generated brand asset is stale: ' + relativePath)
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, buffer)
}

const selectedMaster = await readFile(join(root, selectedSourcePath))
await validatePng(selectedMaster, 1024)
const darkMaster = await createDarkMaster(selectedMaster)
const appIconMaster = await createAppIconMaster(selectedMaster)
const lightCompact = await renderMasterPng(selectedMaster, 256)
const darkCompact = await renderMasterPng(darkMaster, 256)
const trayOnLightMaster = await renderMonochromePng(selectedMaster, 1024, palettes.trayOnLight)
const trayOnDarkMaster = await renderMonochromePng(selectedMaster, 1024, palettes.trayOnDark)

const svgOutputs = [
  ['design/brand/final/flow-light.svg', embeddedPngSvg(selectedMaster)],
  ['design/brand/final/flow-dark.svg', embeddedPngSvg(darkMaster)],
  ['design/brand/final/flow-light-compact.svg', embeddedPngSvg(lightCompact)],
  ['design/brand/final/flow-dark-compact.svg', embeddedPngSvg(darkCompact)],
  ['design/brand/final/flow-tray-on-light.svg', embeddedPngSvg(trayOnLightMaster)],
  ['design/brand/final/flow-tray-on-dark.svg', embeddedPngSvg(trayOnDarkMaster)],
  ['src/renderer/src/assets/brand/flow-light.svg', embeddedPngSvg(selectedMaster)],
  ['src/renderer/src/assets/brand/flow-dark.svg', embeddedPngSvg(darkMaster)],
  ['src/renderer/src/assets/brand/flow-light-compact.svg', embeddedPngSvg(lightCompact)],
  ['src/renderer/src/assets/brand/flow-dark-compact.svg', embeddedPngSvg(darkCompact)],
  ['build/brand.svg', embeddedPngSvg(selectedMaster)]
]
for (const [path, svg] of svgOutputs) await emit(path, svg + '\n')

await emit('src/renderer/src/assets/brand/flow-light.png', selectedMaster)
await emit('src/renderer/src/assets/brand/flow-dark.png', darkMaster)
await emit('src/renderer/src/assets/brand/flow-light-compact.png', lightCompact)
await emit('src/renderer/src/assets/brand/flow-dark-compact.png', darkCompact)

const themeMasters = { light: selectedMaster, dark: darkMaster }
const pngs = new Map()
for (const theme of ['light', 'dark']) {
  for (const size of exportedSizes) {
    const buffer = await renderMasterPng(themeMasters[theme], size)
    pngs.set(theme + ':' + size, buffer)
    await emit('design/brand/final/png/' + theme + '/flow-' + theme + '-' + size + '.png', buffer)
  }
}

const appFrameExtentRange = { minExtent: .80, maxExtent: 1.01 }
const appFrames = await Promise.all(appIcoSizes.map((size) => renderMasterPng(appIconMaster, size, appFrameExtentRange, 4)))
const appPngs = new Map(appIcoSizes.map((size, index) => [size, appFrames[index]]))
const appIco = await pngToIco(appFrames)
validateIco(appIco, appIcoSizes, 'Application')
await emit('build/icon.ico', appIco)
await emit('build/icon.png', selectedMaster)
await emit('build/runtime-icons/app-icon.ico', appIco)
await emit('build/runtime-icons/app-icon.png', await renderMasterPng(appIconMaster, 512, appFrameExtentRange, 4))

const trayOutputs = {}
for (const [name, color] of [['on-light', palettes.trayOnLight], ['on-dark', palettes.trayOnDark]]) {
  const frames = await Promise.all(trayIcoSizes.map((size) => renderMonochromePng(selectedMaster, size, color)))
  const ico = await pngToIco(frames)
  validateIco(ico, trayIcoSizes, 'Tray ' + name)
  trayOutputs[name] = frames
  await emit('build/runtime-icons/tray-' + name + '.ico', ico)
  await emit('design/brand/final/tray-' + name + '-16.png', frames[0])
  await emit('design/brand/final/tray-' + name + '-32.png', frames.at(-1))
}

const comparisonBase = Buffer.from([
  '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1120">',
  '<rect width="1800" height="1120" fill="#EEF2F5"/><rect width="1800" height="118" fill="#252B31"/>',
  '<text x="62" y="51" fill="#fff" font-family="Segoe UI,Arial" font-size="38" font-weight="600">WArish Flow - Exact Selected Artwork</text>',
  '<text x="62" y="84" fill="#CBD3DA" font-family="Segoe UI,Arial" font-size="18">Original approved pixels, theme adaptation, dimensional taskbar badge, and Windows tray contrast</text>',
  '<text x="450" y="170" text-anchor="middle" fill="#4B5660" font-family="Segoe UI,Arial" font-size="22" font-weight="600">LIGHT SURFACES</text>',
  '<text x="1350" y="170" text-anchor="middle" fill="#0B5CAB" font-family="Segoe UI,Arial" font-size="22" font-weight="600">DARK SURFACES</text>',
  '<rect x="70" y="650" width="1660" height="180" fill="#F3F3F3" stroke="#D4D4D4" stroke-width="2"/>',
  '<rect x="70" y="865" width="1660" height="180" fill="#1C1C1C" stroke="#3A3A3A" stroke-width="2"/>',
  '<text x="110" y="695" fill="#4B5660" font-family="Segoe UI,Arial" font-size="19" font-weight="600">LIGHT WINDOWS TASKBAR</text>',
  '<text x="110" y="910" fill="#D5DBE0" font-family="Segoe UI,Arial" font-size="19" font-weight="600">DARK WINDOWS TASKBAR</text>',
  '<text x="62" y="1092" fill="#68737D" font-family="Segoe UI,Arial" font-size="16">The Windows app icon preserves the exact selected dimensional Flow artwork; tray variants remain unchanged.</text>',
  '</svg>'
].join(''))
const comparison = await sharp(comparisonBase).composite([
  { input: pngs.get('light:512'), left: 194, top: 155 },
  { input: pngs.get('dark:512'), left: 1094, top: 155 },
  { input: appPngs.get(64), left: 390, top: 705 },
  { input: appPngs.get(32), left: 820, top: 721 },
  { input: trayOutputs['on-light'][0], left: 1280, top: 729 },
  { input: appPngs.get(64), left: 390, top: 920 },
  { input: appPngs.get(32), left: 820, top: 936 },
  { input: trayOutputs['on-dark'][0], left: 1280, top: 944 }
]).png({ compressionLevel: 9 }).toBuffer()
await emit('design/brand/final/theme-comparison.png', comparison)

const manifestPath = 'design/brand/final/brand-manifest.json'
const manifest = {
  identity: 'WArish Flow',
  selectedConcept: '03 Flow',
  masterType: 'exact selected raster artwork',
  sourceFile: selectedSourcePath,
  sourceSha256: createHash('sha256').update(selectedMaster).digest('hex'),
  palettes,
  exportedPngSizes: exportedSizes,
  applicationIcoSizes: appIcoSizes,
  applicationVisibleCanvasFraction: appIconTileOuterSize / appIconMasterSize,
  applicationMarkCanvasFraction: appIconMarkVisibleSize / appIconMasterSize,
  applicationTile: {
    fill: '#EAF4FB',
    cornerRadiusFraction: appIconTileCornerRadius / appIconTileOuterSize,
    border: null
  },
  applicationGlyph: { source: 'exact selected dimensional artwork' },
  trayIcoSizes,
  generatedFiles: [...emittedFiles, manifestPath].sort()
}
await emit(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

console.log((checkOnly ? 'Validated' : 'Generated') + ' ' + emittedFiles.length + ' exact WArish Flow brand assets.')
