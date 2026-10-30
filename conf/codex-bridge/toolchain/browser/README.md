# Native browser scripting

This is tool documentation, not a skill installation or permission grant. Use
only for the current authorized task and its authorized network origins.

Run ordinary Node.js scripts from `/workspace`. The browser, SDK and fonts are
shared read-only files; do not install dependencies or download another browser.

```js
import { withBrowser } from '/usr/lib/cyf-browser/browser-session.mjs';
await withBrowser(async ({ page, context }) => {
  // Replace with the origin authorized for this task, not an arbitrary site.
  await page.goto('https://authorized.example/');
  console.log((await page.title()).slice(0, 200));
  await page.screenshot({ path: '/outputs/page.png', fullPage: true });
});
```

`withBrowser` closes its browser even if the callback throws. Each call starts
an anonymous context. Keep dependent steps in one callback. Do not connect to a
host browser, reuse another task's cookies, disable the browser sandbox, bypass
the configured proxy or ignore certificate errors. Missing tools or denied
network access must be reported, not bypassed.

- Read page content with Playwright locators; save large content to workspace
  files rather than printing whole HTML or base64 images.
- Fill/click only within the user's authorization. A timeout after a submitting
  click does not prove failure: inspect the result, never blindly resubmit.
- Upload original inputs from `/inputs` only when the task authorizes transfer.
- Start `page.waitForEvent('download')` before the initiating click, then use
  `download.saveAs('/outputs/filename')` before the callback returns.
- Write deliverables to `/outputs`; inspect actual content before using the
  existing `artifact_stage` and `result_propose` tools. A screenshot or a
  successful script alone is not proof of a remote business transaction.
- Do not print credentials, tokens, cookies or full login-page responses. Do not
  invent login, MFA or payment authorization.
