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
    const defaultWidth = miniMode ? 340 : 432;
    const defaultHeight = miniMode ? 72 : 643;
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
        connection: 'connected', connectionMessage: 'Connected to Codex', page: { url: 'https://chatgpt.com/codex/c/demo', title: 'Demo conversation', loggedIn: true, inputAvailable: true, sendAvailable: true }, conversations: [{ id: 'demo', title: 'Review screenshot upload', url: '/c/demo' }, { id: 'ideas', title: 'Ideas for the next release', url: '/c/ideas' }], activeConversationId: 'demo', availableModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.2'].map((id) => ({ id, ownedBy: 'mock-upstream' })), isCapturing: false, isSending: false, isDeleting: false, lastError: null, lastResponse: ${JSON.stringify(responsePreview)}, startedAt: Date.now()
      };
      const listeners = new Set();
      const emit = () => { const snapshot = { ...state, config: { ...state.config } }; listeners.forEach((listener) => listener(snapshot)); };
      const windowActions = { minimize: 0, quit: 0 };
      const sentMessages = [];
      const configPatches = [];
      const overlayCalls = [];
      let modelRefreshCount = 0;
      let rejectNextOverlay = ${process.env.RENDERER_OVERLAY_REJECT === '1' ? 'true' : 'false'};
      const api = { getState: async () => state, updateConfig: async (patch) => { configPatches.push({ ...patch }); Object.assign(state.config, patch); emit(); return state; }, setApiKey: async () => state, clearApiKey: async () => state, sendMessage: async ({ text, attachments = [] } = {}) => { sentMessages.push({ text, attachmentCount: attachments.length }); const active = state.conversations.find((conversation) => conversation.id === state.activeConversationId); if (active && typeof text === 'string' && active.title === 'New conversation') active.title = text.trim().slice(0, 80); emit(); return state; }, captureAndSend: async () => state, captureAttachment: async () => { state.isCapturing = true; emit(); await new Promise((resolve) => setTimeout(resolve, 120)); state.isCapturing = false; emit(); return { id: 'mock-capture', name: 'screen.jpg', mimeType: 'image/jpeg', size: 3, data: new Uint8Array([1, 2, 3]), previewDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }; }, pickFiles: async () => [{ id: 'mock-file', name: 'notes.txt', mimeType: 'text/plain', size: 2, data: new Uint8Array([104, 105]) }], newConversation: async () => { const id = 'draft-' + Date.now(); state.conversations.unshift({ id, title: 'New conversation' }); state.activeConversationId = id; emit(); return state; }, listConversations: async () => state.conversations, switchConversation: async (id) => { state.activeConversationId = id; emit(); return state; }, deleteConversation: async (id) => { state.conversations = state.conversations.filter((conversation) => conversation.id !== id); if (state.activeConversationId === id) state.activeConversationId = state.conversations[0]?.id ?? null; emit(); return state; }, listModels: async () => state.availableModels, reconnect: async () => state, minimizeWindow: async () => { windowActions.minimize += 1; }, quit: async () => { windowActions.quit += 1; }, toggleMiniMode: async () => { state.config = { ...state.config, miniMode: !state.config.miniMode }; emit(); return state; }, toggleVisibility: async () => true, openCodex: async () => undefined, onState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
      api.openSettings = async () => undefined;
      api.openModelMenu = async () => { modelRefreshCount += 1; await new Promise((resolve) => setTimeout(resolve, 250)); };
      api.setOfficialPageOverlayOpen = async (open) => { overlayCalls.push(open); if (rejectNextOverlay && open) { rejectNextOverlay = false; throw new Error('mock overlay rejection'); } await new Promise((resolve) => setTimeout(resolve, 20)); };
      Object.defineProperty(window, 'codexAssistant', { value: api });
      Object.defineProperty(window, '__windowActions', { value: windowActions });
      Object.defineProperty(window, '__sentMessages', { value: sentMessages });
      Object.defineProperty(window, '__configPatches', { value: configPatches });
      Object.defineProperty(window, '__modelRefreshCount', { get: () => modelRefreshCount });
      Object.defineProperty(window, '__overlayCalls', { value: overlayCalls });
    })()` });
    await page.goto(process.env.RENDERER_URL ?? 'http://127.0.0.1:4173/');
    await page.waitForTimeout(1_000);
    if (pageErrors.length > 0) throw new Error(`Renderer errors: ${pageErrors.join('; ')}`);
    const screenshotPath = miniMode ? 'output/playwright/renderer-mini-340x72.png' : `output/playwright/renderer-${viewportWidth}x${viewportHeight}.png`;
    let miniCheck: { layout: { viewportWidth: number; viewportHeight: number; documentWidth: number; documentHeight: number }; text: string } | null = null;
    await page.screenshot({ path: screenshotPath, fullPage: !miniMode });
    if (!miniMode) {
      const toolbarLayout = await page.locator('[data-testid="main-toolbar"]').evaluate((toolbar) => {
        const visibleButtons = [...toolbar.querySelectorAll('button')].filter((button) => {
          const style = getComputedStyle(button);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });
        return {
          clientWidth: toolbar.clientWidth,
          scrollWidth: toolbar.scrollWidth,
          groups: [...toolbar.children].map((element) => {
            const rect = element.getBoundingClientRect();
            return { className: element.className, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          }),
          buttons: visibleButtons.map((button) => {
            const rect = button.getBoundingClientRect();
            return { label: button.getAttribute('aria-label') ?? button.title, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          }),
        };
      });
      if (toolbarLayout.scrollWidth > toolbarLayout.clientWidth) throw new Error(`Toolbar overflowed: ${JSON.stringify(toolbarLayout)}`);
      for (let index = 1; index < toolbarLayout.groups.length; index += 1) {
        const previous = toolbarLayout.groups[index - 1];
        const current = toolbarLayout.groups[index];
        if (previous && current && previous.right > current.left + 0.5) throw new Error(`Toolbar groups overlap: ${JSON.stringify(toolbarLayout.groups)}`);
      }
      const outOfBounds = toolbarLayout.buttons.filter((button) => button.left < 0 || button.right > viewportWidth || button.top < 0 || button.bottom > viewportHeight);
      if (outOfBounds.length > 0) throw new Error(`Toolbar controls left the viewport: ${JSON.stringify(outOfBounds)}`);
      if (process.env.RENDERER_MODE === 'api') {
        const modelSelect = page.locator('select#toolbar-model');
        const modelBox = await modelSelect.boundingBox();
        if (!modelBox || modelBox.width < 70) throw new Error(`Model selector is unreadable: ${JSON.stringify(modelBox)}`);
        const optionValues = await modelSelect.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
        const expected = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.2'];
        if (expected.some((id) => !optionValues.includes(id))) throw new Error(`Model options are incomplete: ${JSON.stringify(optionValues)}`);
        const refreshButton = page.locator('.model-control button');
        await refreshButton.click();
        await page.waitForTimeout(30);
        if (!(await refreshButton.isDisabled())) throw new Error('Model refresh did not expose its busy state.');
        await page.waitForTimeout(260);
        const refreshCount = await page.evaluate(() => (window as Window & { __modelRefreshCount?: number }).__modelRefreshCount ?? 0);
        if (refreshCount !== 1 || await refreshButton.isDisabled()) throw new Error(`Model refresh did not settle cleanly: ${refreshCount}`);
      }
    }
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
        await page.getByRole('button', { name: /更多操作|More actions/i }).click();
        await page.getByRole('menuitem', { name: /设置|settings/i }).click();
      }
    };
    if (process.env.RENDERER_OVERLAY_SYNC === '1') {
      if (process.env.RENDERER_MODE === 'api') throw new Error('Overlay sync verification requires official mode.');
      const overlayCalls = async () => page.evaluate(() => (window as Window & { __overlayCalls?: boolean[] }).__overlayCalls ?? []);
      const expectOverlay = async (expected: boolean, context: string) => {
        await page.waitForTimeout(70);
        const calls = await overlayCalls();
        if (calls.at(-1) !== expected) throw new Error(`${context}: expected overlay ${expected}, received ${JSON.stringify(calls)}`);
      };
      const actionTrigger = page.getByRole('button', { name: /更多操作|More actions/i });
      await actionTrigger.click();
      await expectOverlay(true, 'Opening the action menu');
      await actionTrigger.click();
      await expectOverlay(false, 'Closing the action menu');
      await actionTrigger.click();
      await page.getByRole('menuitem', { name: /设置|settings/i }).click();
      await expectOverlay(true, 'Opening settings');
      await page.getByRole('button', { name: /关闭面板|Close panel/i }).click();
      await expectOverlay(false, 'Closing settings');
      await actionTrigger.click();
      await expectOverlay(true, 'Reopening the action menu');
      await page.evaluate(async () => window.codexAssistant.updateConfig({ mode: 'api' }));
      await expectOverlay(false, 'Switching out of official mode');
      await page.evaluate(async () => window.codexAssistant.updateConfig({ mode: 'playwright' }));
      await expectOverlay(true, 'Switching back with the menu open');
      await actionTrigger.click();
      await expectOverlay(false, 'Final action menu close');
      await actionTrigger.click();
      await actionTrigger.click();
      await expectOverlay(false, 'Rapid action menu toggle');
    }
    if (process.env.RENDERER_SETTINGS === '1') {
      await ensureSettingsOpen();
      await page.screenshot({ path: 'output/playwright/renderer-settings.png', fullPage: true });
    }
    if (process.env.RENDERER_ACTION_MENU === '1') {
      await page.getByRole('button', { name: /更多操作|More actions/i }).click();
      await page.screenshot({ path: 'output/playwright/renderer-actions.png', fullPage: true });
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
      const modelSelect = page.locator('select#toolbar-model');
      await modelSelect.selectOption('gpt-5.5');
      await page.waitForTimeout(100);
      if (await modelSelect.inputValue() !== 'gpt-5.5') throw new Error('Model selection did not update the renderer.');
      const configPatches = await page.evaluate(() => (window as Window & { __configPatches?: Array<Record<string, unknown>> }).__configPatches ?? []);
      if (!configPatches.some((patch) => patch.apiModel === 'gpt-5.5')) throw new Error(`Model selection did not submit the stable ID: ${JSON.stringify(configPatches)}`);
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
    const overlayCalls = await page.evaluate(() => (window as Window & { __overlayCalls?: boolean[] }).__overlayCalls ?? []);
    console.log(JSON.stringify({ screenshot: screenshotPath, title: await page.title(), bodyHeight: await page.locator('body').evaluate((element) => element.scrollHeight), miniCheck, overlayCalls, text: bodyText.slice(0, 500) }, null, 2));
  } finally {
    await browser.close();
  }
}

void main();
