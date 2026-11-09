/** Standard Playwright scripting inside the existing execution namespace.
 * No host profile, remote CDP endpoint, business workflow, or action retries. */
export function nativeBrowserLaunchOptions(proxy = process.env.HTTPS_PROXY) {
  if (proxy) {
    const url = new URL(proxy)
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('NATIVE_BROWSER_PROXY_INVALID')
  }
  return {
    executablePath: '/usr/lib/cyf-browser/chromium/chrome-headless-shell',
    headless: true,
    env: { ...process.env, FONTCONFIG_FILE: '/usr/lib/cyf-browser/browser-fonts.conf' },
    chromiumSandbox: true,
    ...(proxy ? { proxy: { server: proxy, bypass: '<-loopback>' } } : {}),
    // No debugging TCP listener or host profile is exposed. Playwright uses pipes.
    args: ['--disable-quic', '--disable-background-networking']
  }
}

export async function withBrowser(work) {
  const { chromium } = await import(new URL('./playwright/index.mjs', import.meta.url))
  const browser = await chromium.launch(nativeBrowserLaunchOptions())
  try {
    // Never reuse login state from another execution, account or the host.
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' })
    return await work({ context, page: await context.newPage() })
  } finally { await browser.close() }
}
