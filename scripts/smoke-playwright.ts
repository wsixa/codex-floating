import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
  if (!address || typeof address === 'string') throw new Error('Unable to start smoke server');
  const url = `http://127.0.0.1:${address.port}/`;
  const browser = await chromium.launch({ headless: true, executablePath: browserPath() });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const adapter = new CodexAdapter(page);
    const initial = await adapter.readPageState();
    if (!initial.inputAvailable) throw new Error('Composer was not detected');
    await adapter.sendText('hello from smoke test');
    if (!(await page.locator('#messages').innerText()).includes('hello from smoke test')) throw new Error('Text message was not sent.');
    const capture = { buffer: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' as const, width: 1, height: 1, capturedAt: Date.now() };
    await adapter.uploadAndSend(capture, 'analyze this');
    if (!(await page.locator('#messages').innerText()).includes('analyze this')) throw new Error('Image upload message was not sent.');
    const documentData = new Uint8Array([0x68, 0x69]);
    await adapter.sendMessage('', [{ id: 'document-1', name: 'notes.txt', mimeType: 'text/plain', size: documentData.byteLength, data: documentData }]);
    if (!(await page.locator('#messages').innerText()).includes('uploaded:notes.txt')) throw new Error('Generic file upload message was not sent.');
    const sessions = await adapter.listConversations();
    if (sessions.length !== 2) throw new Error(`Expected 2 sessions, got ${sessions.length}`);
    await adapter.deleteConversation('beta', '/c/beta');
    if ((await adapter.listConversations()).some((session) => session.id === 'beta')) throw new Error('Inactive conversation was not deleted.');
    await adapter.switchConversation('alpha', '/c/alpha');
    await adapter.deleteConversation('alpha', '/c/alpha');
    if ((await adapter.listConversations()).some((session) => session.id === 'alpha')) throw new Error('Active conversation was not deleted.');
    if (!page.url().endsWith('/c/new')) throw new Error('Deleting the active conversation did not leave a new conversation page.');
    await adapter.startNewConversation();
    if (!page.url().endsWith('/c/new')) throw new Error('New conversation did not navigate.');
    const draftSessions = await adapter.listConversations();
    const draft = draftSessions.find((session) => session.id === '/c/new');
    if (!draft || draft.title !== 'New conversation') throw new Error('Blank conversation draft was not surfaced with its placeholder title.');
    console.log(JSON.stringify({ ok: true, initial, sessions: sessions.map((session) => session.id), deleted: ['alpha', 'beta'], url: page.url() }, null, 2));
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main();
