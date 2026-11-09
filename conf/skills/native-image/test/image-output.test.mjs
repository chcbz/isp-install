import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ImageMagick, MagickColors, MagickColor, MagickFormat, MagickGeometry, Gravity } from '../vendor/magick.mjs'
import { parseImageOutputOptions, resizeImageOutput } from '../scripts/image-input.mjs'
import { run } from '../scripts/image.mjs'

const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'native-image-output-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
const image = (color, width, height) => ImageMagick.read(color, width, height,
  i => i.write(MagickFormat.Png, data => Buffer.from(data)))
const inspect = (bytes, callback) => ImageMagick.read(bytes, i => i.getPixels(p => callback(i, p)))
const rgba = color => [color.r, color.g, color.b, color.a]
const dimensions = { width: 6, height: 6 }
const red = image(MagickColors.Red, 6, 2)
const transparent = image(MagickColors.Transparent, 6, 2)

for (const [background, expected] of [
  ['white', [255, 255, 255, 255]], ['black', [0, 0, 0, 255]],
  ['#123abc', [18, 58, 188, 255]], ['transparent', [0, 0, 0, 0]]
]) test(`contain uses explicit ${background} padding without recoloring opaque content`, () => {
  const result = resizeImageOutput(red, dimensions, parseImageOutputOptions('6x6', 'contain', background))
  inspect(result, (i, p) => {
    assert.equal(i.width, 6); assert.equal(i.height, 6)
    assert.deepEqual(rgba(p.getColor(0, 0)), expected)
    assert.deepEqual(rgba(p.getColor(3, 3)), [255, 0, 0, 255])
  })
})

for (const fit of ['contain', 'cover', 'stretch']) test(`${fit} solid background also composites existing transparency`, () => {
  const result = resizeImageOutput(transparent, dimensions, parseImageOutputOptions('6x6', fit, 'white'))
  inspect(result, (i, p) => {
    assert.equal(i.width, 6); assert.equal(i.height, 6)
    for (let y = 0; y < i.height; y++) for (let x = 0; x < i.width; x++)
      assert.deepEqual(rgba(p.getColor(x, y)), [255, 255, 255, 255])
  })
})

test('solid background composites partial alpha rather than only dropping alpha', () => {
  const source = image(new MagickColor('#ff000080'), 2, 2)
  inspect(resizeImageOutput(source, { width: 2, height: 2 }, { background: '#ffffff' }), (i, p) => {
    const c = p.getColor(0, 0)
    assert.equal(c.r, 255); assert.equal(c.a, 255)
    assert.ok(c.g >= 126 && c.g <= 128); assert.equal(c.b, c.g)
  })
})

test('cover crops centrally while stretch retains the full source with changed aspect ratio', () => {
  const source = ImageMagick.read(MagickColors.Red, 6, 2, i => {
    i.getPixels(p => { for (const x of [2, 3]) for (const y of [0, 1]) p.setPixel(x, y, [0, 0, 255]) })
    return i.write(MagickFormat.Png, data => Buffer.from(data))
  })
  const target = { width: 2, height: 2 }
  inspect(resizeImageOutput(source, target, { fit: 'cover' }), (i, p) => {
    assert.equal(i.width, 2); assert.equal(i.height, 2)
    for (const x of [0, 1]) for (const y of [0, 1]) assert.deepEqual(rgba(p.getColor(x, y)), [0, 0, 255, 255])
  })
  inspect(resizeImageOutput(source, target, { fit: 'stretch' }), (i, p) => {
    assert.equal(i.width, 2); assert.equal(i.height, 2)
    assert.ok(p.getColor(0, 0).r > 0); assert.equal(p.getColor(0, 0).a, 255)
  })
})

test('old invocation preserves contain/transparent and unsized original bytes', () => {
  assert.deepEqual(parseImageOutputOptions('6x6'), { fit: 'contain', background: 'transparent' })
  assert.deepEqual(resizeImageOutput(red, dimensions), resizeImageOutput(red, dimensions, parseImageOutputOptions('6x6')))
  assert.equal(resizeImageOutput(red, null), red)
  const legacyPixels = ImageMagick.read(red, i => {
    i.autoOrient(); i.resize(dimensions.width, dimensions.height)
    i.extent(new MagickGeometry(dimensions.width, dimensions.height), Gravity.Center, MagickColors.Transparent)
    return i.getPixels(p => p.toByteArray(0, 0, i.width, i.height, 'RGBA'))
  })
  inspect(resizeImageOutput(red, dimensions), (i, p) => {
    assert.equal(p.getColor(0, 0).a, 0)
    assert.deepEqual(p.toByteArray(0, 0, i.width, i.height, 'RGBA'), legacyPixels)
  })
})

test('invalid options fail before provider use or creation of output/paid-call markers', async t => {
  const root = fixture(t), output = resolve(root, 'out.png')
  for (const flags of [
    ['--size', '6x6', '--fit', 'guess'], ['--size', '6x6', '--background', 'red'],
    ['--size', '6x6', '--background', '#ffffff80'], ['--size', '6x6', '--background', '#ffffff\n'],
    ['--size', '6x6', '--fit', 'cover', '--fit', 'contain'],
    ['--fit', 'contain'], ['--background', 'white'], ['--size', '0x6']
  ]) {
    let calls = 0
    await assert.rejects(run(['generate', '--prompt', 'white background', '--output', output, ...flags], {
      env: {}, fetchFn: () => { calls++; throw Error('must not call provider') }
    }), e => ['IMAGE_ARGUMENT_INVALID', 'SKILL_IMAGE_SIZE_INVALID', 'SKILL_IMAGE_FIT_INVALID', 'SKILL_IMAGE_BACKGROUND_INVALID'].includes(e.code))
    assert.equal(calls, 0); assert.equal(existsSync(output), false)
    assert.equal(existsSync(output + '.request-started'), false)
  }
})

for (const mode of ['generate', 'edit']) test(`${mode} applies explicit local options, preserves original, and never forwards options to provider`, async t => {
  const root = fixture(t), output = resolve(root, 'out.png'), input = resolve(root, 'input.png')
  writeFileSync(input, red)
  let calls = 0
  const args = [mode, '--prompt', 'white background', '--output', output, '--size', '6x6', '--fit', 'contain', '--background', 'white',
    ...(mode === 'edit' ? ['--input', input] : [])]
  const result = await run(args, {
    env: { IMAGE_API_ENDPOINT: 'https://fixture.test', IMAGE_API_MODEL: 'fixture', IMAGE_API_KEY: 'fixture' },
    fetchFn: async (url, init) => {
      calls++; const body = JSON.parse(init.body)
      for (const key of ['size', 'fit', 'background']) assert.equal(Object.hasOwn(body, key), false)
      return { status: 200, redirected: false, url: url.href, headers: { get: () => 'application/json' },
        json: async () => ({ data: [{ b64_json: red.toString('base64') }] }) }
    }
  })
  assert.equal(calls, 1); assert.deepEqual(readFileSync(result.providerImagePath), red)
  inspect(readFileSync(output), (i, p) => assert.deepEqual(rgba(p.getColor(0, 0)), [255, 255, 255, 255]))
  assert.deepEqual(readFileSync(input), red)
})

test('real CLI can repair an existing image offline with exact size and solid background', t => {
  const root = fixture(t), input = resolve(root, 'original.png'), output = resolve(root, 'fixed.png')
  writeFileSync(input, red)
  const script = fileURLToPath(new URL('../scripts/image.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, 'resize', '--input', input, '--output', output,
    '--size', '7x5', '--fit', 'contain', '--background', '#ffffff'], { encoding: 'utf8', env: { PATH: process.env.PATH } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).path, output)
  inspect(readFileSync(output), (i, p) => {
    assert.equal(i.width, 7); assert.equal(i.height, 5)
    assert.deepEqual(rgba(p.getColor(0, 0)), [255, 255, 255, 255])
  })
  assert.deepEqual(readFileSync(input), red)
  assert.equal(existsSync(output + '.request-started'), false)
})

for (const [width, height, fit] of [[2, 6, 'contain'], [2, 6, 'cover'], [6, 2, 'contain'], [6, 2, 'cover']])
  test(`portrait/landscape ${width}x${height} ${fit} keeps exact odd target and solid alpha`, () => {
    const source = image(MagickColors.Red, width, height)
    inspect(resizeImageOutput(source, { width: 7, height: 5 }, { fit, background: '#ffffff' }), (i, p) => {
      assert.equal(i.width, 7); assert.equal(i.height, 5)
      for (let y = 0; y < i.height; y++) for (let x = 0; x < i.width; x++) assert.equal(p.getColor(x, y).a, 255)
      assert.deepEqual(rgba(p.getColor(3, 2)), [255, 0, 0, 255])
    })
  })
