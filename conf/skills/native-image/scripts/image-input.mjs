/** One decoder for authorized image bytes. Never interprets filenames, URLs or
 * document formats. Original bytes remain the authority; PNG is a derivative. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ImageMagick, MagickFormat, MagickGeometry, MagickColors, Gravity, initializeImageMagick } from '../vendor/magick.mjs'

await initializeImageMagick(readFileSync(new URL('../vendor/magick.wasm', import.meta.url)))
export const IMAGE_INPUT_EXTENSIONS = Object.freeze({
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif'
})
export const IMAGE_INPUT_MIMES = Object.freeze(Object.keys(IMAGE_INPUT_EXTENSIONS))
export const IMAGE_TRANSFORM_ID = 'magick-wasm-0.0.45-auto-orient-png-v1'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const starts = (bytes, signature) => bytes.subarray(0, signature.length).equals(Buffer.from(signature))
export function detectImageInput(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('IMAGE_INPUT_INVALID', '图片文件数据无效')
  if (starts(bytes, [137,80,78,71,13,10,26,10])) return { mime: 'image/png', format: MagickFormat.Png }
  if (starts(bytes, [255,216,255])) return { mime: 'image/jpeg', format: MagickFormat.Jpeg }
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii'))) return { mime: 'image/gif', format: MagickFormat.Gif }
  if (bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP') return { mime: 'image/webp', format: MagickFormat.WebP }
  if (starts(bytes, [66,77])) return { mime: 'image/bmp', format: MagickFormat.Bmp }
  if ([[73,73,42,0],[77,77,0,42],[73,73,43,0],[77,77,0,43]].some(sig => starts(bytes, sig))) return { mime: 'image/tiff', format: MagickFormat.Tiff }
  if (bytes.length >= 16 && bytes.subarray(4,8).toString('ascii') === 'ftyp') {
    const size = bytes.readUInt32BE(0)
    if (size < 16 || size > bytes.length || size % 4) fail('IMAGE_INPUT_INVALID', '图片容器损坏')
    const brands = [bytes.subarray(8,12).toString('ascii')]
    for (let i = 16; i < size; i += 4) brands.push(bytes.subarray(i,i+4).toString('ascii'))
    if (brands.some(x => ['avif','avis'].includes(x))) return { mime: 'image/avif', format: MagickFormat.Avif }
    if (brands.some(x => ['heic','heix','hevc','hevx'].includes(x))) return { mime: 'image/heic', format: MagickFormat.Heic }
    if (brands.some(x => ['mif1','msf1'].includes(x))) return { mime: 'image/heif', format: MagickFormat.Heif }
  }
  fail('IMAGE_FORMAT_UNSUPPORTED', '无法识别图片格式，请提供有效的 JPG、PNG、WebP、GIF、BMP、TIFF、HEIC/HEIF 或 AVIF 图片')
}
// libpng may expose APNG as only its fallback frame. Detect the animation control
// before decoding, so that a successful fallback cannot silently lose frames.
function assertStaticPng(bytes) {
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    if (length > bytes.length - offset - 12) fail('IMAGE_INPUT_INVALID', 'PNG 图片损坏')
    const type = bytes.subarray(offset+4, offset+8).toString('ascii')
    if (type === 'acTL') fail('IMAGE_MULTIFRAME_REQUIRES_SELECTION', '此图片包含动画帧，请先选择需要处理的静态帧')
    offset += length + 12
  }
}
export function normalizeImageInput(bytes, declaredMime) {
  const detected = detectImageInput(bytes)
  const heif = mime => ['image/heic', 'image/heif'].includes(mime)
  if (declaredMime && detected.mime !== declaredMime && !(heif(declaredMime) && heif(detected.mime)))
    fail('IMAGE_MIME_MISMATCH', '图片实际格式与资料声明不一致，请重新上传原文件')
  if (detected.mime === 'image/png') assertStaticPng(bytes)
  try {
    return ImageMagick.readCollection(bytes, detected.format, images => {
      if (images.length !== 1) fail('IMAGE_MULTIFRAME_REQUIRES_SELECTION', '此图片包含多帧或多页，请先选择需要处理的静态帧或页面')
      const image = images[0]
      image.autoOrient()
      // Derived identities must survive retries/restarts; retain colour profiles
      // but exclude wall-clock metadata produced by the codec itself.
      for (const name of ['date:create', 'date:modify', 'date:timestamp']) image.removeAttribute(name)
      image.settings.setDefine(MagickFormat.Png, 'exclude-chunks', 'date,time')
      const width = image.width, height = image.height
      const output = image.write(MagickFormat.Png, data => Buffer.from(data))
      return { bytes: output, mimeType: 'image/png', width, height,
        provenance: { transform: IMAGE_TRANSFORM_ID, sourceSha256: hash(bytes), sourceMimeType: detected.mime,
          sha256: hash(output), byteLength: String(output.length), mimeType: 'image/png' } }
    })
  } catch (error) {
    if (error.code?.startsWith('IMAGE_')) throw error
    fail('IMAGE_DECODE_FAILED', '已收到图片，但文件损坏或当前解码器无法读取，请转换为 PNG 或 JPG 后重试')
  }
}

// Output-only normalization: preserve the source/effect PNG and input identities.
export const IMAGE_OUTPUT_TRANSFORM_ID = 'magick-wasm-0.0.45-contain-transparent-png-v1'
export function parseImageOutputSize(size) {
  if (size === undefined) return null
  if (typeof size !== 'string' || !/^[1-9][0-9]*x[1-9][0-9]*(?![\s\S])/.test(size))
    fail('SKILL_IMAGE_SIZE_INVALID', '图片尺寸须为正整数宽x高，例如800x600')
  const [width, height] = size.split('x').map(Number)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height))
    fail('SKILL_IMAGE_SIZE_INVALID', '图片尺寸超出可准确表示的整数范围')
  return { width, height }
}
export function resizeImageOutput(bytes, size) {
  if (!size) return bytes
  try {
    return ImageMagick.read(bytes, MagickFormat.Png, image => {
      image.autoOrient()
      image.resize(size.width, size.height)
      image.extent(new MagickGeometry(size.width, size.height), Gravity.Center, MagickColors.Transparent)
      for (const name of ['date:create', 'date:modify', 'date:timestamp']) image.removeAttribute(name)
      image.settings.setDefine(MagickFormat.Png, 'exclude-chunks', 'date,time')
      return image.write(MagickFormat.Png, data => Buffer.from(data))
    })
  } catch (cause) {
    throw Object.assign(new Error('图片已生成，但指定尺寸处理失败；保留原始生成结果，不重新调用服务商'),
      { code: 'SKILL_IMAGE_OUTPUT_RESIZE_FAILED', cause })
  }
}
