import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

function browserPath(): string | undefined {
  const candidates = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
  return candidates.find((candidate) => existsSync(candidate));
}

async function main(): Promise<void> {
  await mkdir('output/playwright', { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: browserPath() });
  try {
    const miniMode = process.env.RENDERER_MINI === '1';
    const defaultWidth = miniMode ? 340 : 440;
    const defaultHeight = miniMode ? 72 : 760;
    const viewportWidth = Number.parseInt(process.env.RENDERER_WIDTH ?? String(defaultWidth), 10);
    const viewportHeight = Number.parseInt(process.env.RENDERER_HEIGHT ?? String(defaultHeight), 10);
    const page = await browser.newPage({ viewport: { width: Number.isFinite(viewportWidth) ? viewportWidth : defaultWidth, height: Number.isFinite(viewportHeight) ? viewportHeight : defaultHeight }, deviceScaleFactor: 1 });
    const responsePreview = process.env.RENDERER_RESPONSE === '1'
      ? 'I reviewed the request and prepared a concise response.\n\nThe result is shown in a focused reading area so longer answers remain easy to scan.'
      : null;
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript({ content: `(() => {
      window.addEventListener('error', (event) => console.error('window-error', event.message));
      window.addEventListener('unhandledrejection', (event) => console.error('unhandled', String(event.reason)));
      const state = {
        config: { mode: '${process.env.RENDERER_MODE === 'api' ? 'api' : 'playwright'}', language: '${process.env.RENDERER_LANGUAGE === 'en-US' ? 'en-US' : 'zh-CN'}', codexUrl: 'https://chatgpt.com/codex', lastPageUrl: null, lastThreadId: null, apiBaseUrl: 'http://127.0.0.1:15721/v1', apiModel: 'gpt-5.6-sol', apiKeyConfigured: false, window: { width: 430, height: 640 }, opacity: .96, alwaysOnTop: true, miniMode: ${miniMode ? 'true' : 'false'}, theme: '${process.env.RENDERER_THEME === 'light' ? 'light' : 'dark'}', launchAtLogin: false },
        connection: 'connected', connectionMessage: 'Connected to Codex', page: { url: 'https://chatgpt.com/codex/c/demo', title: 'Demo conversation', loggedIn: true, inputAvailable: true, sendAvailable: true }, conversations: [{ id: 'demo', title: 'Review screenshot upload', url: '/c/demo' }, { id: 'ideas', title: 'Ideas for the next release', url: '/c/ideas' }], activeConversationId: 'demo', availableModels: [{ id: 'gpt-5.6-sol', ownedBy: 'mock-upstream' }, { id: 'gpt-5.5', ownedBy: 'mock-upstream' }], isCapturing: false, isSending: false, isDeleting: false, lastError: null, lastResponse: ${JSON.stringify(responsePreview)}, startedAt: Date.now()
      };
      const listeners = new Set();
      const emit = () => { const snapshot = { ...state, config: { ...state.config } }; listeners.forEach((listener) => listener(snapshot)); };
      const windowActions = { minimize: 0, quit: 0 };
      const sentMessages = [];
      const api = { getState: async () => state, updateConfig: async (patch) => { Object.assign(state.config, patch); emit(); return state; }, setApiKey: async () => state, clearApiKey: async () => state, sendMessage: async ({ text, attachments = [] } = {}) => { sentMessages.push({ text, attachmentCount: attachments.length }); const active = state.conversations.find((conversation) => conversation.id === state.activeConversationId); if (active && typeof text === 'string' && active.title === 'New conversation') active.title = text.trim().slice(0, 80); emit(); return state; }, captureAndSend: async () => state, captureAttachment: async () => { state.isCapturing = true; emit(); await new Promise((resolve) => setTimeout(resolve, 120)); state.isCapturing = false; emit(); return { id: 'mock-capture', name: 'screen.jpg', mimeType: 'image/jpeg', size: 3, data: new Uint8Array([1, 2, 3]), previewDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }; }, pickFiles: async () => [{ id: 'mock-file', name: 'notes.txt', mimeType: 'text/plain', size: 2, data: new Uint8Array([104, 105]) }], newConversation: async () => { const id = 'draft-' + Date.now(); state.conversations.unshift({ id, title: 'New conversation' }); state.activeConversationId = id; emit(); return state; }, listConversations: async () => state.conversations, switchConversation: async (id) => { state.activeConversationId = id; emit(); return state; }, deleteConversation: async (id) => { state.conversations = state.conversations.filter((conversation) => conversation.id !== id); if (state.activeConversationId === id) state.activeConversationId = state.conversations[0]?.id ?? null; emit(); return state; }, listModels: async () => state.availableModels, reconnect: async () => state, minimizeWindow: async () => { windowActions.minimize += 1; }, quit: async () => { windowActions.quit += 1; }, toggleMiniMode: async () => { state.config = { ...state.config, miniMode: !state.config.miniMode }; emit(); return state; }, toggleVisibility: async () => true, openCodex: async () => undefined, onState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
      api.openSettings = async () => undefined;
      api.openModelMenu = async () => undefined;
      Object.defineProperty(window, 'codexAssistant', { value: api });
      Object.defineProperty(window, '__windowActions', { value: windowActions });
      Object.defineProperty(window, '__sentMessages', { value: sentMessages });
    })()` });
    await page.goto(process.env.RENDERER_URL ?? 'http://127.0.0.1:4173/');
    await page.waitForTimeout(1_000);
    if (pageErrors.length > 0) throw new Error(`Renderer errors: ${pageErrors.join('; ')}`);
    const screenshotPath = miniMode ? 'output/playwright/renderer-mini.png' : 'output/playwright/renderer.png';
    let miniCheck: { layout: { viewportWidth: number; viewportHeight: number; documentWidth: number; documentHeight: number }; text: string } | null = null;
    await page.screenshot({ path: screenshotPath, fullPage: !miniMode });
    if (miniMode) {
      const layout = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
      }));
      if (layout.documentWidth > layout.viewportWidth || layout.documentHeight > layout.viewportHeight) {
        throw new Error(`Mini layout overflowed the native viewport: ${JSON.stringify(layout)}`);
      }
      const miniText = await page.locator('body').innerText();
      if (!miniText.includes('MINI') && !miniText.includes('迷你')) throw new Error('Mini mode indicator is missing.');
      miniCheck = { layout, text: miniText.slice(0, 180) };
      const expandButton = page.getByRole('button', { name: /退出迷你模式|Exit mini mode/i });
      if (await expandButton.count() !== 1) throw new Error('Mini mode expand control is missing.');
      if (await page.getByRole('button', { name: /最小化窗口|Minimize window/i }).count() !== 1 ||
        await page.getByRole('button', { name: /退出助手|Quit assistant/i }).count() !== 1) {
        throw new Error('Mini mode minimize/quit controls are missing.');
      }
      await expandButton.click();
      await page.waitForTimeout(100);
      if (await page.locator('[data-testid="mini-shell"]').count() !== 0) throw new Error('Mini mode did not expand after clicking the control.');
    }
    const minimizeButton = page.getByRole('button', { name: /最小化窗口|Minimize window/i }).first();
    const quitButton = page.getByRole('button', { name: /退出助手|Quit assistant/i }).first();
    if (await minimizeButton.count() !== 1 || await quitButton.count() !== 1) throw new Error('Native minimize/quit controls are missing.');
    await minimizeButton.click();
    await quitButton.click();
    const windowActions = await page.evaluate(() => (window as Window & { __windowActions?: { minimize: number; quit: number } }).__windowActions);
    if (!windowActions || windowActions.minimize !== 1 || windowActions.quit !== 1) throw new Error('Native minimize/quit controls did not invoke their IPC actions.');
    const ensureSettingsOpen = async () => {
      if (await page.locator('.settings-popover').count() === 0) {
        await page.getByRole('button', { name: /设置|settings/i }).click();
      }
    };
    if (process.env.RENDERER_SETTINGS === '1') {
      await ensureSettingsOpen();
      await page.screenshot({ path: 'output/playwright/renderer-settings.png', fullPage: true });
    }
    if (process.env.RENDERER_SWITCH_LANGUAGE === '1') {
      await ensureSettingsOpen();
      await page.getByLabel(/语言|Language/i).selectOption('en-US');
      await page.waitForTimeout(150);
      await page.screenshot({ path: 'output/playwright/renderer-language-switch.png', fullPage: true });
      const switchedText = await page.locator('body').innerText();
      if (!switchedText.includes('PREFERENCES') || !switchedText.includes('Language')) throw new Error('Language switch did not update the renderer.');
    }
    if (process.env.RENDERER_SWITCH_MODEL === '1') {
      await ensureSettingsOpen();
      const modelSelect = page.getByLabel(/上游模型|Upstream model/i);
      await modelSelect.selectOption('gpt-5.5');
      await page.waitForTimeout(100);
      if (await modelSelect.inputValue() !== 'gpt-5.5') throw new Error('Model selection did not update the renderer.');
    }
    if (process.env.RENDERER_ATTACHMENTS === '1') {
      const addButton = page.getByRole('button', { name: /添加附件|Add attachment/i });
      await addButton.click();
      await page.getByRole('menuitem', { name: /截取全屏|Capture full screen/i }).click();
      const composer = page.getByLabel(/发送给 Codex 的消息|Message to Codex/i);
      await page.waitForTimeout(20);
      await composer.fill('请分析这张截图中的问题');
      if (await composer.isDisabled()) throw new Error('Composer became disabled while a screenshot was being captured.');
      await page.waitForTimeout(100);
      if (await page.locator('[data-testid="attachment-draft"]').count() !== 1 || await page.locator('[data-testid="attachment-draft"] img').count() !== 1) {
        throw new Error('Screenshot attachment preview is missing.');
      }
      await addButton.click();
      await page.getByRole('menuitem', { name: /上传文件|Upload files/i }).click();
      await page.waitForTimeout(100);
      if (await page.locator('[data-testid="attachment-draft"]').count() !== 2 || !(await page.locator('.attachment-name').allTextContents()).includes('notes.txt')) {
        throw new Error('File attachment draft is missing.');
      }
      await page.screenshot({ path: 'output/playwright/renderer-attachments.png', fullPage: true });
      await page.getByRole('button', { name: /发送消息|Send message/i }).click();
      await page.waitForTimeout(100);
      const sentMessages = await page.evaluate(() => (window as Window & { __sentMessages?: Array<{ text: string; attachmentCount: number }> }).__sentMessages ?? []);
      if (sentMessages.length !== 1 || sentMessages[0]?.text !== '请分析这张截图中的问题' || sentMessages[0]?.attachmentCount !== 2) {
        throw new Error(`Screenshot text and attachments were not sent together: ${JSON.stringify(sentMessages)}`);
      }
      await page.screenshot({ path: 'output/playwright/renderer-attachments-sent.png', fullPage: true });
    }
    const bodyText = await page.locator('body').innerText();
    if (!bodyText.includes('Codex')) throw new Error('Renderer produced a blank page.');
    if (process.env.RENDERER_MODE === 'api' && /(API base URL|API 地址|API key|API 密钥|OPENAI_BASE_URL|OPENAI_API_KEY|127\.0\.0\.1:15721|PROXY_MANAGED)/i.test(bodyText)) {
      throw new Error('CCSwitch internal endpoint or credential fields leaked into the renderer.');
    }
    console.log(JSON.stringify({ screenshot: screenshotPath, title: await page.title(), bodyHeight: await page.locator('body').evaluate((element) => element.scrollHeight), miniCheck, text: bodyText.slice(0, 500) }, null, 2));
  } finally {
    await browser.close();
  }
}

void main();
