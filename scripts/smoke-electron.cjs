const { chromium } = require('playwright');

const cdpPort = Number.parseInt(process.env.ELECTRON_CDP_PORT ?? '9230', 10);
const cdpUrl = `http://127.0.0.1:${cdpPort}`;

async function waitForDevTools(timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`);
      if (response.ok) return;
    } catch {
      // Electron may need a moment to open its DevTools endpoint.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Electron DevTools endpoint did not open on port ${cdpPort}.`);
}

async function waitForDevToolsClosed(timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(`${cdpUrl}/json/version`);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function main() {
  await waitForDevTools();
  const browser = await chromium.connectOverCDP(cdpUrl);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().includes('127.0.0.1:4177')) ?? pages[0];
  if (!page) throw new Error('Electron renderer page was not found through CDP.');
  await page.getByRole('button', { name: /最小化窗口|Minimize window/i }).click();
  await page.waitForTimeout(150);
  if (!(await page.locator('body').innerText()).includes('Codex')) throw new Error('Renderer stopped after native minimize.');

  const disconnected = new Promise((resolve) => browser.once('disconnected', resolve));
  await page.getByRole('button', { name: /退出助手|Quit assistant/i }).click();
  await Promise.race([disconnected, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (!(await waitForDevToolsClosed())) throw new Error('Electron did not fully exit after clicking quit.');
  console.log(JSON.stringify({ ok: true, minimized: true, quit: true, cdpPortClosed: true }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
