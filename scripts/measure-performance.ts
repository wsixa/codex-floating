import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { CodexAdapter } from '../src/main/codex-adapter';
import { existsSync } from 'node:fs';

function browserPath(): string | undefined {
  const candidates = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
  return candidates.find((candidate) => existsSync(candidate));
}

async function main(): Promise<void> {
  const html = await readFile(new URL('./mock-codex.html', import.meta.url), 'utf8');
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to start performance server');
  const startupStarted = performance.now();
  const browser = await chromium.launch({ headless: true, executablePath: browserPath() });
  const startupMs = Math.round(performance.now() - startupStarted);
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const adapter = new CodexAdapter(page);
    const idleBefore = process.cpuUsage();
    const idleStarted = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const idleElapsedUs = (performance.now() - idleStarted) * 1_000;
    const idleCpu = process.cpuUsage(idleBefore);
    const idleCpuPercent = Math.round(((idleCpu.user + idleCpu.system) / idleElapsedUs) * 1000) / 10;
    const idleRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
    const capture = { buffer: new Uint8Array(256 * 1024), mimeType: 'image/png' as const, width: 1280, height: 720, capturedAt: Date.now() };
    const uploadSamples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      await adapter.uploadAndSend(capture, `perf message ${index}`);
      uploadSamples.push(performance.now() - started);
    }
    const sorted = [...uploadSamples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)];
    const report = { timestamp: new Date().toISOString(), machine: `${process.platform} ${process.arch}`, mode: 'Chromium headless mock Codex', startupMs, idleRssMb, idleCpuPercent, messagesSent: uploadSamples.length, failures: 0, p95UploadMs: Math.round(p95), meanUploadMs: Math.round(uploadSamples.reduce((a, b) => a + b, 0) / uploadSamples.length), note: 'Startup, RSS, and CPU are measured for this Node/Playwright harness. Electron renderer, desktop capture, and real Codex network latency are not included.' };
    await mkdir('output/performance', { recursive: true });
    await writeFile('output/performance/report.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main();
