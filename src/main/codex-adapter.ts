import type { Dialog, Locator, Page } from 'playwright';
import { isPlaceholderConversationTitle, NEW_CONVERSATION_TITLE, type AttachmentPayload, type CapturePayload, type ConversationSummary, type PageState } from '../shared/types';

const ACTION_TIMEOUT = 8_000;

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
const PROBE_TIMEOUT = 700;
const RESPONSE_TIMEOUT = 120_000;
const RESPONSE_POLLING = 250;

interface DesktopAssistantSnapshot {
  id: string;
  turnKey: string;
  text: string;
  final: boolean;
}

export class CodexAdapter {
  private trackedConversationUrl: string | null = null;
  private trackedConversationDraft = false;

  constructor(private readonly page: Page) {}

  async readPageState(): Promise<PageState> {
    const url = this.page.url();
    const title = await this.page.title().catch(() => '');
    const bodyText = await this.page.locator('body').innerText({ timeout: PROBE_TIMEOUT }).catch(() => '');
    const inputAvailable = await this.hasVisibleComposer();
    // The Desktop client contains account/settings copy such as "Sign in"
    // even while an authenticated composer is available. Only web pages use
    // the body-text login heuristic.
    const hasLoginPrompt = !this.isDesktopClientPage() && /(^|\b)(log in|sign in|create account)(\b|$)/i.test(bodyText);
    const loggedIn = inputAvailable && !hasLoginPrompt;
    const theme = await this.detectTheme();
    return {
      url,
      title: title.slice(0, 200),
      loggedIn,
      inputAvailable,
      sendAvailable: await this.findSendButton(false) !== null,
      theme,
    };
  }

  async sendText(text: string): Promise<string | void> {
    return this.sendMessage(text, []);
  }

  /** Read the model choices exposed by the official Desktop composer menu. */
  async listModels(): Promise<string[]> {
    if (!this.isDesktopClientPage()) return [];
    const trigger = await this.findVisible([
      this.page.locator('[data-codex-intelligence-trigger="true"]').first(),
      this.page.locator('[data-codex-intelligence-trigger]').first(),
    ]);
    if (!trigger) return [];
    const wasOpen = (await trigger.getAttribute('aria-expanded').catch(() => null)) === 'true';
    if (!wasOpen) await trigger.click({ timeout: ACTION_TIMEOUT });
    try {
      const modelItem = await this.findVisible([
        this.page.getByRole('menuitem', { name: /^模型\b|^model\b/i }).last(),
        this.page.getByText(/^模型\b|^model\b/i).last(),
      ]);
      if (!modelItem) return [];
      if ((await modelItem.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
        await modelItem.click({ timeout: ACTION_TIMEOUT });
      }
      await this.page.waitForTimeout(50);
      const entries = this.page.locator('[role="menuitem"]');
      const models: string[] = [];
      const seen = new Set<string>();
      const count = await entries.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const entry = entries.nth(index);
        if (!(await entry.isVisible({ timeout: PROBE_TIMEOUT }).catch(() => false))) continue;
        const text = (await entry.innerText({ timeout: PROBE_TIMEOUT }).catch(() => '')).trim();
        const id = modelMenuLabel(text);
        if (id && !seen.has(id)) { seen.add(id); models.push(id); }
      }
      return models;
    } finally {
      await this.page.keyboard.press('Escape').catch(() => undefined);
      if (!wasOpen) await this.page.keyboard.press('Escape').catch(() => undefined);
    }
  }

  async selectModel(id: string): Promise<void> {
    if (!this.isDesktopClientPage()) return;
    const target = normalizeModelLabel(id);
    if (!target) throw new Error('Model name cannot be empty.');
    const trigger = await this.findVisible([
      this.page.locator('[data-codex-intelligence-trigger="true"]').first(),
      this.page.locator('[data-codex-intelligence-trigger]').first(),
    ]);
    if (!trigger) throw new Error('Codex Desktop model selector was not found.');
    const wasOpen = (await trigger.getAttribute('aria-expanded').catch(() => null)) === 'true';
    if (!wasOpen) await trigger.click({ timeout: ACTION_TIMEOUT });
    try {
      const modelItem = await this.findVisible([
        this.page.getByRole('menuitem', { name: /^模型\b|^model\b/i }).last(),
        this.page.getByText(/^模型\b|^model\b/i).last(),
      ]);
      if (!modelItem) throw new Error('Codex Desktop model menu was not found.');
      if ((await modelItem.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
        await modelItem.click({ timeout: ACTION_TIMEOUT });
      }
      const entries = this.page.locator('[role="menuitem"]');
      const count = await entries.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const entry = entries.nth(index);
        if (!(await entry.isVisible({ timeout: PROBE_TIMEOUT }).catch(() => false))) continue;
        const text = (await entry.innerText({ timeout: PROBE_TIMEOUT }).catch(() => '')).trim();
        if (!text || text.includes('\n')) continue;
        if (normalizeModelLabel(text) === target || normalizeModelLabel(text).includes(target) || target.includes(normalizeModelLabel(text))) {
          try {
            // Electron's CDP compositor can report the page root as the hit
            // target for a portalled menu item. Prefer a real click, then use
            // Playwright's DOM event dispatch as a deterministic fallback.
            await entry.click({ timeout: 1_200 });
          } catch {
            await entry.dispatchEvent('click', { timeout: ACTION_TIMEOUT });
          }
          return;
        }
      }
      throw new Error(`Codex Desktop does not expose model "${id}".`);
    } finally {
      await this.page.keyboard.press('Escape').catch(() => undefined);
      if (!wasOpen) await this.page.keyboard.press('Escape').catch(() => undefined);
    }
  }

  /** Select the official Desktop reasoning effort from its intelligence menu. */
  async selectReasoningEffort(effort: import('../shared/types').ReasoningEffort): Promise<void> {
    if (!this.isDesktopClientPage()) return;
    const labels: Record<string, RegExp> = {
      auto: /自动|auto/i,
      minimal: /最低|minimal/i,
      low: /低(?:级)?|low/i,
      medium: /中(?:等)?|medium/i,
      high: /高(?:级)?|high/i,
      xhigh: /极高|xhigh/i,
      max: /最高|max/i,
    };
    const trigger = await this.findVisible([
      this.page.locator('[data-codex-intelligence-trigger="true"]').first(),
      this.page.locator('[data-codex-intelligence-trigger]').first(),
    ]);
    if (!trigger) throw new Error('Codex Desktop intelligence menu was not found.');
    if ((await trigger.getAttribute('aria-expanded').catch(() => null)) !== 'true') await trigger.click({ timeout: ACTION_TIMEOUT });
    try {
      const reasoning = await this.findVisible([
        this.page.locator('[role="menuitem"][aria-label*="推理强度"]').last(),
        this.page.locator('[role="menuitem"][aria-label*="Reasoning"]').last(),
        this.page.getByRole('menuitem', { name: /推理强度|reasoning/i }).last(),
      ]);
      if (!reasoning) throw new Error('Codex Desktop reasoning control was not found.');
      await reasoning.click({ timeout: ACTION_TIMEOUT });
      const option = await this.findVisible([
        this.page.getByRole('menuitem', { name: labels[effort] }).last(),
        this.page.getByRole('option', { name: labels[effort] }).last(),
        this.page.getByText(labels[effort]).last(),
      ]);
      if (!option) throw new Error(`Codex Desktop reasoning effort "${effort}" was not found.`);
      await option.click({ timeout: ACTION_TIMEOUT }).catch(() => option.dispatchEvent('click', { timeout: ACTION_TIMEOUT }));
    } finally {
      await this.page.keyboard.press('Escape').catch(() => undefined);
      await this.page.keyboard.press('Escape').catch(() => undefined);
    }
  }

  async openSettings(): Promise<void> {
    const control = await this.findVisible([
      this.page.getByRole('button', { name: /设置|settings|preferences/i }).first(),
      this.page.getByLabel(/设置|settings|preferences/i).first(),
      this.page.locator('[data-app-action="settings"]').first(),
    ]);
    if (!control) throw new Error('Codex settings control was not found.');
    await control.click({ timeout: ACTION_TIMEOUT });
  }

  async openModelMenu(): Promise<void> {
    const trigger = await this.findVisible([
      this.page.locator('[data-codex-intelligence-trigger="true"]').first(),
      this.page.locator('[data-codex-intelligence-trigger]').first(),
      this.page.getByRole('button', { name: /模型|model|intelligence/i }).first(),
    ]);
    if (!trigger) throw new Error('Codex model control was not found.');
    await trigger.click({ timeout: ACTION_TIMEOUT });
  }

  async uploadAndSend(capture: CapturePayload, text?: string): Promise<string | void> {
    const data = new Uint8Array(capture.buffer);
    return this.sendMessage(text ?? '', [{
      id: `capture-${capture.capturedAt}`,
      name: `codex-capture-${capture.capturedAt}.${capture.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
      mimeType: capture.mimeType,
      size: data.byteLength,
      data,
      width: capture.width,
      height: capture.height,
    }]);
  }

  async sendMessage(text: string, attachments: AttachmentPayload[]): Promise<string | void> {
    const value = text.trim();
    if (!value && attachments.length === 0) throw new Error('Message cannot be empty.');
    if (value.length > 30_000) throw new Error('Message is too long (30,000 characters maximum).');

    const assistantBefore = this.isDesktopClientPage()
      ? await this.snapshotDesktopAssistantMessages()
      : [];

    if (attachments.length > 0) {
      const payloads = attachments.map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        buffer: Buffer.from(attachment.data),
      }));
      const fileInput = await this.findFileInput();
      if (fileInput) {
        try {
          await fileInput.setInputFiles(payloads, { timeout: ACTION_TIMEOUT });
        } catch (error) {
          if (payloads.length !== 1) throw error;
          await fileInput.setInputFiles(payloads[0], { timeout: ACTION_TIMEOUT });
        }
      } else {
        if (this.isDesktopClientPage()) {
          await this.uploadDesktopFiles(payloads);
        } else {
          const attach = await this.findVisible([
            this.page.getByRole('button', { name: /attach|upload|file|image/i }).first(),
            this.page.getByLabel(/attach|upload|file|image/i).first(),
          ]);
          if (!attach) throw new Error('No attachment control was found on the Codex page.');
          const chooser = this.page.waitForEvent('filechooser', { timeout: ACTION_TIMEOUT });
          await attach.click({ timeout: ACTION_TIMEOUT });
          const fileChooser = await chooser;
          await fileChooser.setFiles(payloads);
        }
      }
    }

    // File chooser events can cause Codex to re-render the composer. Locate it
    // after uploads so a text prompt is never written into a stale element.
    const desktopDraft = this.isDesktopClientPage() && this.trackedConversationDraft;
    const composer = value
      ? await this.findComposer(true, desktopDraft)
      : await this.findComposer(false, desktopDraft);
    if (value && composer) await composer.fill(value, { timeout: ACTION_TIMEOUT });

    if (this.isDesktopClientPage() && composer) {
      // The Desktop shell can briefly keep the previous thread's submit
      // button mounted while a new draft is opening. Submit through the exact
      // composer we filled, then verify Codex consumed its contents.
      await composer.press('Enter', { timeout: ACTION_TIMEOUT });
      if (value && await this.composerStillContains(composer, value)) {
        // Only use a submit control inside the composer that was filled. A
        // global send-button lookup can resolve to a stale thread during the
        // Desktop route transition.
        const send = await this.findComposerSendButton(composer);
        if (send) await send.click({ timeout: ACTION_TIMEOUT });
      }
      if (value && await this.composerStillContains(composer, value)) {
        throw new Error('Codex did not accept the message in the new conversation. Please retry.');
      }
    } else {
      const send = await this.findSendButton(true);
      if (send) {
        await send.click({ timeout: ACTION_TIMEOUT });
      } else if (composer) {
        await composer.press('Enter', { timeout: ACTION_TIMEOUT });
      } else {
        throw new Error('Codex send control was not found.');
      }
    }
    if (this.trackedConversationUrl) {
      this.trackedConversationUrl = this.page.url();
      this.trackedConversationDraft = false;
    }

    if (!this.isDesktopClientPage()) return undefined;
    return this.waitForDesktopAssistantResponse(assistantBefore, value);
  }

  async startNewConversation(): Promise<void> {
    const previousDesktopThreadId = this.isDesktopClientPage()
      ? await this.selectedDesktopThreadId()
      : null;
    const button = await this.findVisible([
      // The official Desktop sidebar has other nested "new conversation"
      // controls (for scheduled/project folders). The top-level sidebar item
      // is the only control that actually opens the global new-thread page.
      this.page.locator('button.sidebar-item').filter({ hasText: /^(?:新对话|新会话|new\s+(?:chat|conversation|task|thread))$/i }).first(),
      this.page.getByRole('button', { name: /new\s+(chat|conversation|task|thread)|新建(?:聊天|会话|对话)|新对话|新会话/i }).first(),
      this.page.getByRole('link', { name: /new\s+(chat|conversation|task|thread)|新建(?:聊天|会话|对话)|新对话|新会话/i }).first(),
      this.page.getByLabel(/new\s+(chat|conversation|task|thread)|新建(?:聊天|会话|对话)|新对话|新会话/i).first(),
    ]);
    if (!button) throw new Error('New conversation control was not found.');
    await button.click({ timeout: ACTION_TIMEOUT });
    await this.page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined);
    if (this.isDesktopClientPage()) {
      await this.page.waitForFunction((previousId) => {
        const selected = document.querySelector('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-selected="true"]');
        const selectedId = selected?.getAttribute('data-app-action-sidebar-thread-id')?.trim() || null;
        const homeComposer = document.querySelector('[data-composer-placement="home"] [data-codex-composer="true"], [data-composer-placement="home"] [data-codex-composer]');
        const rect = homeComposer?.getBoundingClientRect();
        const homeVisible = Boolean(rect && rect.width > 0 && rect.height > 0);
        // A new Desktop conversation is represented by the home composer and
        // no selected history row. If we were already on the home page, the
        // click is idempotent and the previous ID may also be null.
        return homeVisible && (selectedId === null || previousId === null);
      }, previousDesktopThreadId, { timeout: ACTION_TIMEOUT });
      await this.page.locator('[data-composer-placement="home"] [data-codex-composer="true"], [data-composer-placement="home"] [data-codex-composer]')
        .last()
        .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
    }
    this.trackedConversationUrl = this.page.url();
    this.trackedConversationDraft = true;
  }

  /** Ensure a pending Desktop draft has the official home composer active. */
  async ensureDesktopDraftConversation(): Promise<void> {
    if (!this.isDesktopClientPage() || await this.isDesktopHomeConversation()) return;
    await this.startNewConversation();
  }

  /** True only while the official Desktop page is showing its empty home view. */
  async isDesktopHomeConversation(): Promise<boolean> {
    if (!this.isDesktopClientPage()) return false;
    const composer = await this.findComposer(false, true);
    return Boolean(composer);
  }

  async currentDesktopConversationId(): Promise<string | null> {
    return this.isDesktopClientPage() ? this.selectedDesktopThreadId() : null;
  }

  async switchProject(projectId: string): Promise<void> {
    if (!this.isDesktopClientPage()) throw new Error('Project switching is only available in Codex Desktop.');
    const project = this.page.locator(`[data-app-action-sidebar-project-row][data-app-action-sidebar-project-id="${cssAttributeValue(projectId)}"]`).first();
    if (await project.count().catch(() => 0) === 0) throw new Error('The Codex project is not visible in the Desktop sidebar.');
    await project.click({ timeout: ACTION_TIMEOUT });
  }

  async listConversations(): Promise<ConversationSummary[]> {
    if (this.isDesktopClientPage()) return this.listDesktopConversations();
    const candidates = this.page.locator('a[href*="/c/"], a[href*="/conversation"], [data-conversation-id]');
    const count = await candidates.count().catch(() => 0);
    const results: ConversationSummary[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < Math.min(count, 100); index += 1) {
      const item = candidates.nth(index);
      const id = (await item.getAttribute('data-conversation-id').catch(() => null)) ??
        (await item.getAttribute('href').catch(() => null)) ?? '';
      const title = (await item.innerText({ timeout: PROBE_TIMEOUT }).catch(() => '')).trim();
      if (!id || seen.has(id) || !title) continue;
      seen.add(id);
      const url = await item.getAttribute('href').catch(() => undefined) ?? undefined;
      results.push({ id, title: title.slice(0, 160), url });
    }

    // A newly created web conversation can exist in the current page before
    // Codex adds it to the history sidebar. Surface it immediately so the
    // assistant can show the localized draft name and keep it selectable.
    const current = this.page.url();
    const currentTitle = (await this.page.title().catch(() => '')).trim();
    const currentUrl = safeUrl(current);
    const currentId = currentUrl?.pathname ?? '';
    const alreadyListed = results.some((item) => item.id === currentId || item.id === current || (item.url && sameUrl(item.url, current)));
    const trackedCurrent = Boolean(this.trackedConversationUrl && sameUrl(this.trackedConversationUrl, current));
    const shouldSurfaceCurrent = trackedCurrent || isNewConversationPath(currentUrl?.pathname ?? '') || isPlaceholderConversationTitle(currentTitle);
    if (currentUrl && currentId && !alreadyListed && shouldSurfaceCurrent) {
      const isDraft = trackedCurrent ? this.trackedConversationDraft : true;
      results.unshift({
        id: currentId,
        title: isDraft || !currentTitle ? NEW_CONVERSATION_TITLE : currentTitle.slice(0, 160),
        url: currentUrl.toString(),
      });
    }
    return results;
  }

  async switchConversation(id: string, knownUrl?: string): Promise<void> {
    this.trackedConversationUrl = null;
    this.trackedConversationDraft = false;
    if (this.isDesktopClientPage()) {
      const direct = this.page.locator('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id]');
      const count = await direct.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = direct.nth(index);
        if ((await candidate.getAttribute('data-app-action-sidebar-thread-id').catch(() => null)) === id) {
          await candidate.click({ timeout: ACTION_TIMEOUT });
          await this.page.waitForFunction((targetId) => {
            const selected = document.querySelector('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-selected="true"]');
            return selected?.getAttribute('data-app-action-sidebar-thread-id') === targetId;
          }, id, { timeout: ACTION_TIMEOUT }).catch(() => undefined);
          return;
        }
      }
      throw new Error('Conversation is no longer available in the Codex Desktop history.');
    }
    const candidates = this.page.locator('[data-conversation-id]');
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if ((await candidate.getAttribute('data-conversation-id').catch(() => null)) === id) {
        await candidate.click({ timeout: ACTION_TIMEOUT });
        return;
      }
    }
    const href = knownUrl ?? (id.startsWith('/') || /^https?:\/\//i.test(id) ? id : '');
    if (!href) throw new Error('Conversation is no longer available in the current history.');
    const target = new URL(href, this.page.url());
    const current = new URL(this.page.url());
    if (target.origin !== current.origin) throw new Error('Conversation URL origin is not trusted.');
    await this.page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT });
  }

  /** Delete a Codex history item through the page UI and wait for the sidebar to settle. */
  async deleteConversation(id: string, knownUrl?: string): Promise<void> {
    const beforeUrl = this.page.url();
    const target = await this.findConversationEntry(id, knownUrl);
    const rawTargetUrl = target
      ? (await target.getAttribute('href').catch(() => null)) ?? knownUrl ?? null
      : knownUrl ?? null;
    const targetUrl = rawTargetUrl ? normalizeConversationUrl(rawTargetUrl, beforeUrl) : null;
    const wasCurrent = Boolean(
      (targetUrl && sameUrl(targetUrl, beforeUrl)) ||
      id === beforeUrl ||
      sameUrl(id, beforeUrl),
    );

    if (target) await target.hover({ timeout: ACTION_TIMEOUT }).catch(() => undefined);
    let menuButton = target ? await this.findMenuButton(target) : null;
    if (!menuButton && target) {
      // Some Codex builds expose the item menu only from the context menu.
      await target.click({ button: 'right', timeout: ACTION_TIMEOUT });
    }
    if (!menuButton && !target) {
      const currentTarget = knownUrl && sameUrl(knownUrl, beforeUrl);
      if (!currentTarget) throw new Error('Conversation was not found in the Codex history.');
      menuButton = await this.findVisible([
        this.page.getByRole('button', { name: /conversation.*(?:more|options|menu)|more options|会话.*(?:更多|选项|菜单)|更多选项/i }).last(),
        this.page.getByLabel(/conversation.*(?:more|options|menu)|more options|会话.*(?:更多|选项|菜单)|更多选项/i).last(),
        this.page.locator('button[aria-haspopup="menu"]').last(),
      ]);
    }
    if (menuButton) await menuButton.click({ timeout: ACTION_TIMEOUT });

    const deleteControl = await this.findVisible([
      this.page.getByRole('menuitem', { name: /^(?:delete|remove|删除|移除)(?: conversation| chat| task|会话|对话|聊天)?$/i }).last(),
      this.page.getByRole('button', { name: /^(?:delete|remove|删除|移除)(?: conversation| chat| task|会话|对话|聊天)?$/i }).last(),
      this.page.getByText(/^(?:delete|remove|删除|移除)(?: conversation| chat| task|会话|对话|聊天)?$/i).last(),
    ]);
    if (!deleteControl) throw new Error('Codex delete control was not found. The page layout may have changed.');
    await this.clickAndAcceptNativeDialog(deleteControl);

    const dialog = this.page.getByRole('dialog').last();
    if (await dialog.count().catch(() => 0) > 0 && await dialog.isVisible({ timeout: PROBE_TIMEOUT }).catch(() => false)) {
      const confirmation = await this.findVisible([
        dialog.getByRole('button', { name: /^(?:confirm|delete|remove|确认|删除|移除)(?: conversation| chat| task|会话|对话|聊天)?$/i }).last(),
        dialog.getByRole('menuitem', { name: /^(?:confirm|delete|remove|确认|删除|移除)(?: conversation| chat| task|会话|对话|聊天)?$/i }).last(),
        dialog.getByText(/^(?:confirm|delete|remove|确认|删除|移除)(?: conversation| chat| task|会话|对话|聊天)?$/i).last(),
      ]);
      if (confirmation) await this.clickAndAcceptNativeDialog(confirmation);
    }

    await this.waitForConversationRemoval(id, targetUrl);
    if (wasCurrent && sameUrl(this.page.url(), beforeUrl)) {
      const remaining = (await this.listConversations()).filter((item) => !conversationIdentityMatches(item, id, targetUrl));
      const next = remaining[0];
      if (next) {
        await this.switchConversation(next.id, next.url);
      } else {
        try {
          await this.startNewConversation();
        } catch {
          const fallback = new URL('/c/new', beforeUrl);
          await this.page.goto(fallback.toString(), { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT });
          this.trackedConversationUrl = this.page.url();
          this.trackedConversationDraft = true;
        }
      }
    }
  }

  private async hasVisibleComposer(): Promise<boolean> {
    return (await this.findComposer(false)) !== null;
  }

  private async detectTheme(): Promise<'light' | 'dark' | undefined> {
    try {
      return await this.page.evaluate(() => {
        const root = document.documentElement;
        const value = `${root.getAttribute('data-theme') ?? ''} ${root.className}`.toLowerCase();
        if (value.includes('dark')) return 'dark';
        if (value.includes('light')) return 'light';
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      });
    } catch {
      return undefined;
    }
  }

  private async findComposer(required: boolean, desktopHomeOnly = false): Promise<Locator | null> {
    const candidates = desktopHomeOnly
      ? [
        this.page.locator('[data-composer-placement="home"] [data-codex-composer="true"]').last(),
        this.page.locator('[data-composer-placement="home"] [data-codex-composer]').last(),
      ]
      : [
      this.page.locator('[data-codex-composer="true"]').first(),
      this.page.locator('[data-codex-composer]').first(),
      this.page.getByRole('textbox', { name: /随心输入|message|prompt|ask|chat/i }).first(),
      this.page.getByRole('textbox', { name: /message|prompt|ask|chat/i }).first(),
      this.page.getByPlaceholder(/message|prompt|ask|chat/i).first(),
      this.page.locator('textarea').first(),
      this.page.locator('[contenteditable="true"]').first(),
      ];
    const locator = await this.findVisible(candidates);
    if (!locator && required) throw new Error('Codex message input was not found. Are you logged in?');
    return locator;
  }

  private async findComposerSendButton(composer: Locator): Promise<Locator | null> {
    const root = composer.locator('xpath=ancestor::*[@data-codex-composer-root][1]');
    return this.findVisible([
      root.getByRole('button', { name: /发送|send|submit|run/i }).last(),
      root.locator('button[type="submit"]').last(),
      composer.locator('xpath=following::button[1]'),
    ]);
  }

  private async findSendButton(required: boolean): Promise<Locator | null> {
    const button = await this.findVisible([
      this.page.getByRole('button', { name: /发送|send|submit|run/i }).first(),
      this.page.getByRole('button', { name: /send|submit|run/i }).first(),
      this.page.locator('button[type="submit"]').first(),
    ]);
    if (!button && required) return null;
    return button;
  }

  private async selectedDesktopThreadId(): Promise<string | null> {
    const selected = this.page.locator('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-selected="true"]').first();
    // The selected row is frequently detached while Desktop switches between
    // the thread and home views. Never let that transient state consume the
    // default Playwright timeout and hold the global IPC operation open.
    return (await selected.getAttribute('data-app-action-sidebar-thread-id', { timeout: PROBE_TIMEOUT }).catch(() => null))?.trim() || null;
  }

  private async composerStillContains(composer: Locator, value: string): Promise<boolean> {
    await this.page.waitForTimeout(120);
    return composer.evaluate((element, expected) => {
      const current = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : element.textContent ?? '';
      return current.trim() === expected;
    }, value, { timeout: PROBE_TIMEOUT }).catch(() => false);
  }

  /**
   * Capture the assistant nodes currently rendered by the official Desktop.
   * The response annotation ID is stable for a message and lets us distinguish
   * a new reply from the last reply already visible in the conversation.
   */
  private async snapshotDesktopAssistantMessages(): Promise<DesktopAssistantSnapshot[]> {
    return this.page.locator('[data-markdown-text-style="assistant-message"]').evaluateAll((nodes) => nodes.map((node, index) => ({
      id: node.parentElement?.getAttribute('data-response-annotation-target')?.trim() || `index:${index}`,
      turnKey: node.closest('[data-turn-key]')?.getAttribute('data-turn-key')?.trim() || `turn:${index}`,
      text: (node.textContent ?? '').trim(),
      final: Boolean(node.closest('[data-local-conversation-final-assistant="true"]')),
    }))).catch(() => []);
  }

  /** Wait for the final assistant node created by the just-submitted turn. */
  private async waitForDesktopAssistantResponse(before: DesktopAssistantSnapshot[], userText: string): Promise<string | undefined> {
    const beforeIds = before.map((item) => item.id);
    const beforeTurns = before.map((item) => item.turnKey);
    try {
      const result = await this.page.waitForFunction(({ ids, turns, expectedText }) => {
        const turnNodes = Array.from(document.querySelectorAll('[data-turn-key]'));
        for (let turnIndex = turnNodes.length - 1; turnIndex >= 0; turnIndex -= 1) {
          const turn = turnNodes[turnIndex];
          const turnKey = turn.getAttribute('data-turn-key')?.trim() || '';
          if (!turnKey || turns.includes(turnKey)) continue;
          const user = turn.querySelector('[data-user-message-bubble="true"]');
          if (expectedText) {
            const actualText = (user?.textContent ?? '').trim().replace(/\s+/gu, ' ');
            const normalizedExpected = expectedText.trim().replace(/\s+/gu, ' ');
            if (!user || actualText !== normalizedExpected) continue;
          } else if (!user) {
            continue;
          }
          const nodes = Array.from(turn.querySelectorAll('[data-markdown-text-style="assistant-message"]'));
          for (let index = nodes.length - 1; index >= 0; index -= 1) {
            const node = nodes[index];
            const id = node.parentElement?.getAttribute('data-response-annotation-target')?.trim() || `${turnKey}:assistant:${index}`;
            const text = (node.textContent ?? '').trim();
            const isFinal = Boolean(node.closest('[data-local-conversation-final-assistant="true"]'));
            if (text && isFinal && !ids.includes(id)) return text;
          }
        }
        return false;
      }, { ids: beforeIds, turns: beforeTurns, expectedText: userText }, { timeout: RESPONSE_TIMEOUT, polling: RESPONSE_POLLING });
      const value = await result.jsonValue() as unknown;
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    } catch {
      // The message was already accepted by Desktop. A slow/offline model
      // must not leave the floating assistant's send operation locked forever.
      return undefined;
    }
  }

  private async findFileInput(): Promise<Locator | null> {
    const input = this.page.locator('input[type="file"]').first();
    return await input.count().catch(() => 0) ? input : null;
  }

  private isDesktopClientPage(): boolean {
    return this.page.url().startsWith('app://');
  }

  private async listDesktopConversations(): Promise<ConversationSummary[]> {
    const candidates = this.page.locator('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id]');
    return candidates.evaluateAll((nodes) => {
      const results: Array<{ id: string; title: string }> = [];
      const seen = new Set<string>();
      for (const node of nodes.slice(0, 200)) {
        const id = node.getAttribute('data-app-action-sidebar-thread-id')?.trim() ?? '';
        if (!id || seen.has(id)) continue;
        const titleAttribute = node.getAttribute('data-app-action-sidebar-thread-title')?.trim() ?? '';
        const title = titleAttribute || (node.textContent ?? '').trim();
        if (!title) continue;
        seen.add(id);
        results.push({ id, title: title.replace(/\s+/gu, ' ').slice(0, 160) });
      }
      return results;
    }).catch(() => []);
  }

  /** Upload through the same menu/file chooser used by the official client. */
  private async uploadDesktopFiles(payloads: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
    const addContext = await this.findVisible([
      this.page.locator('[data-composer-navigation-target="add-context"]').first(),
      this.page.getByRole('button', { name: /添加文件等内容|add files|add context/i }).first(),
    ]);
    if (!addContext) throw new Error('No attachment control was found on the Codex Desktop composer.');
    await addContext.click({ timeout: ACTION_TIMEOUT });
    const fileItem = await this.findVisible([
      this.page.locator('[data-list-navigation-item="true"]').filter({ hasText: /^文件和文件夹\b/i }).first(),
      this.page.getByRole('menuitem', { name: /文件和文件夹|files and folders/i }).first(),
      this.page.getByText(/^文件和文件夹\b|^files and folders\b/i).first(),
    ]);
    if (!fileItem) throw new Error('Codex Desktop attachment menu did not expose a file picker.');
    const chooser = this.page.waitForEvent('filechooser', { timeout: ACTION_TIMEOUT });
    await fileItem.click({ timeout: ACTION_TIMEOUT });
    const fileChooser = await chooser;
    await fileChooser.setFiles(payloads);
  }

  private async findConversationEntry(id: string, knownUrl?: string): Promise<Locator | null> {
    if (this.isDesktopClientPage()) {
      const candidates = this.page.locator('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id]');
      const count = await candidates.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if ((await candidate.getAttribute('data-app-action-sidebar-thread-id').catch(() => null)) === id) return candidate;
      }
      return null;
    }
    const candidates = this.page.locator('a[href*="/c/"], a[href*="/conversation"], [data-conversation-id]');
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 100); index += 1) {
      const candidate = candidates.nth(index);
      const dataId = await candidate.getAttribute('data-conversation-id').catch(() => null);
      const href = await candidate.getAttribute('href').catch(() => null);
      if (dataId === id || href === id || (knownUrl && href && sameUrl(href, knownUrl)) || (href && sameUrl(href, id))) return candidate;
    }
    return null;
  }

  private async findMenuButton(scope: Locator): Promise<Locator | null> {
    if (this.isDesktopClientPage()) {
      const desktopButton = await this.findVisible([
        scope.getByRole('button', { name: /更多操作|more options|more actions|options/i }).last(),
        scope.getByLabel(/更多操作|more options|more actions|options/i).last(),
      ]);
      if (desktopButton) return desktopButton;
    }
    const parent = scope.locator('..');
    const grandparent = parent.locator('..');
    const greatGrandparent = grandparent.locator('..');
    const scopes = [scope, parent, grandparent, greatGrandparent, greatGrandparent.locator('..')];
    for (const candidateScope of scopes) {
      const button = await this.findVisible([
        candidateScope.getByRole('button', { name: /more|options|actions|menu|更多|选项|操作|菜单/i }).last(),
        candidateScope.getByLabel(/more|options|actions|menu|更多|选项|操作|菜单/i).last(),
        candidateScope.locator('button[aria-haspopup="menu"]').last(),
        candidateScope.locator('[aria-haspopup="menu"]').last(),
      ]);
      if (button) return button;
    }
    return null;
  }

  private async clickAndAcceptNativeDialog(locator: Locator): Promise<void> {
    const handler = (dialog: Dialog) => { void dialog.accept().catch(() => undefined); };
    this.page.on('dialog', handler);
    try {
      await locator.click({ timeout: ACTION_TIMEOUT });
    } finally {
      this.page.removeListener('dialog', handler);
    }
  }

  private async waitForConversationRemoval(id: string, knownUrl: string | null): Promise<void> {
    await this.page.waitForFunction(({ targetId, targetUrl }) => {
      const nodes = Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id], a[href*="/c/"], a[href*="/conversation"], [data-conversation-id]'));
      return !nodes.some((node) => {
        const dataId = node.getAttribute('data-conversation-id');
        const desktopId = node.getAttribute('data-app-action-sidebar-thread-id');
        const href = node.getAttribute('href');
        let sameTarget = false;
        if (targetUrl && href) {
          try {
            const left = new URL(href, targetUrl);
            const right = new URL(targetUrl);
            sameTarget = left.origin === right.origin && left.pathname === right.pathname;
          } catch {
            sameTarget = false;
          }
        }
        return dataId === targetId || desktopId === targetId || href === targetId ||
          sameTarget;
      });
    }, { targetId: id, targetUrl: knownUrl }, { timeout: ACTION_TIMEOUT });
  }

  private async findVisible(candidates: Locator[]): Promise<Locator | null> {
    for (const candidate of candidates) {
      try {
        if (await candidate.count() > 0 && await candidate.isVisible({ timeout: PROBE_TIMEOUT })) return candidate;
      } catch {
        // A selector can disappear during navigation; continue with the next semantic fallback.
      }
    }
    return null;
  }
}

function safeUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

function sameUrl(value: string, current: string): boolean {
  try {
    const target = new URL(value, current);
    const base = new URL(current);
    return target.origin === base.origin && target.pathname === base.pathname;
  } catch {
    return false;
  }
}

function normalizeConversationUrl(value: string, base: string): string | null {
  try {
    const target = new URL(value, base);
    const current = new URL(base);
    if (target.origin !== current.origin) return null;
    return target.toString();
  } catch {
    return null;
  }
}

function conversationIdentityMatches(item: ConversationSummary, id: string, knownUrl: string | null): boolean {
  return item.id === id ||
    Boolean(knownUrl && ((item.url && sameUrl(item.url, knownUrl)) || sameUrl(item.id, knownUrl)));
}

function isNewConversationPath(pathname: string): boolean {
  return /\/(?:c|conversation)\/new\/?$/i.test(pathname);
}

function normalizeModelLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/^gpt[-_]?/u, '')
    .replace(/[-_]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Reject non-model entries that share the Desktop model/reasoning menu. */
export function modelMenuLabel(value: string): string | null {
  const label = value.replace(/\s+/gu, ' ').trim().slice(0, 256);
  if (!label || value.includes('\n')) return null;
  if (/^(?:文件|编辑|视图|帮助|模型|推理强度|重置为默认设置|最低|低级|低|中等|中|高级|高|极高|最高|自动|默认|file|edit|view|help|model|reasoning(?:\s+effort)?|minimal|low|medium|high|xhigh|max|auto|default)$/iu.test(label)) {
    return null;
  }
  return label;
}
