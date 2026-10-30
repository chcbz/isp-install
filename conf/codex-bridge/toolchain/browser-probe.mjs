import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { withBrowser } from './browser-session.mjs'
await withBrowser(async ({ context, page }) => {
  await page.setContent('<meta charset="utf-8"><title>Browser probe</title><input id="name"><button id="go" onclick="document.querySelector(\'output\').textContent=document.querySelector(\'#name\').value">Apply</button><output></output><input id="file" type="file"><a id="download" download="result.txt">Download</a>')
  await page.locator('#name').fill('浏览器核验')
  await page.locator('#go').click()
  assert.equal(await page.locator('output').innerText(), '浏览器核验')
  // Verify the actual renderer selected the packaged Chinese font, not merely
  // that Unicode survived DOM operations while screenshots contain tofu boxes.
  await page.locator('output').evaluate(node => { node.style.fontFamily = '"Noto Sans CJK SC"' })
  const cdp = await context.newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument')
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'output' })
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
  assert.ok(fonts.some(font => font.familyName === 'Noto Sans CJK SC' && font.glyphCount >= 5), 'packaged Chinese font was not rendered')
  await cdp.detach()
  await page.locator('#file').setInputFiles('/inputs/probe.txt')
  assert.equal(await page.locator('#file').evaluate(async node => node.files[0].text()), await readFile('/inputs/probe.txt', 'utf8'))
  await page.locator('#download').evaluate(node => { node.href = URL.createObjectURL(new Blob(['native-browser-download'], { type: 'text/plain' })) })
  const downloading = page.waitForEvent('download')
  await page.locator('#download').click()
  await (await downloading).saveAs('/outputs/browser-probe.txt')
  assert.equal(await readFile('/outputs/browser-probe.txt', 'utf8'), 'native-browser-download')
  await page.screenshot({ path: '/outputs/browser-probe.png' })
  assert.equal((await readFile('/outputs/browser-probe.png')).subarray(0,8).toString('hex'), '89504e470d0a1a0a')
  await context.addCookies([{ name: 'isolated', value: 'probe', url: 'https://example.invalid' }])
})
await withBrowser(async ({ context }) => { assert.deepEqual(await context.cookies(), []) })
console.log('native-browser-ready')
