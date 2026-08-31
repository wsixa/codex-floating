import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OPACITY_MAX, OPACITY_MIN, type AppConfig, type ConfigPatch, type Language, type TransportMode, type WindowBounds } from '../shared/types';

interface StoredConfig extends Partial<AppConfig> {
  apiKeyEncrypted?: string;
}

const DEFAULT_CONFIG: AppConfig = {
  // The transport is selected in the assistant UI and persisted in config.json.
  // Keep CCSwitch as the first-run default because it is the local, keyless
  // route used by this installation. Do not derive this from an environment
  // variable: that would make the UI selector appear to change without
  // actually changing the active transport.
  mode: 'api',
  language: process.env.CODEX_LANGUAGE === 'en-US' ? 'en-US' : 'zh-CN',
  codexUrl: 'https://chatgpt.com/codex',
  lastPageUrl: null,
  lastThreadId: null,
  apiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || 'http://127.0.0.1:15721/v1',
  apiModel: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-sol',
  apiKeyConfigured: false,
  window: { width: 430, height: 640 },
  opacity: 0.96,
  alwaysOnTop: true,
  miniMode: false,
  theme: 'system',
  launchAtLogin: false,
};

const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;
const MINI_MIN_WIDTH = 220;
const MINI_MIN_HEIGHT = 64;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function sanitizeBounds(value: unknown, fallback: WindowBounds, miniMode = false): WindowBounds {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const minWidth = miniMode ? MINI_MIN_WIDTH : MIN_WIDTH;
  const minHeight = miniMode ? MINI_MIN_HEIGHT : MIN_HEIGHT;
  const bounds: WindowBounds = {
    width: Math.round(clampNumber(raw.width, minWidth, 1600, fallback.width)),
    height: Math.round(clampNumber(raw.height, minHeight, 1200, fallback.height)),
  };
  if (typeof raw.x === 'number' && Number.isFinite(raw.x)) bounds.x = Math.round(raw.x);
  if (typeof raw.y === 'number' && Number.isFinite(raw.y)) bounds.y = Math.round(raw.y);
  return bounds;
}

export function defaultConfig(): AppConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export class ConfigService {
  private readonly filePath: string;
  private config: AppConfig;
  private apiKeyEncrypted: string | null = null;
  private readonly environmentApiKey = process.env.OPENAI_API_KEY?.trim() || null;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'config.json');
    this.config = defaultConfig();
  }

  get value(): AppConfig {
    return structuredClone(this.config);
  }

  async load(): Promise<AppConfig> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as StoredConfig;
      this.apiKeyEncrypted = typeof raw.apiKeyEncrypted === 'string' ? raw.apiKeyEncrypted : null;
      this.config = this.validate(raw);
      // Remove the retired global shortcut from existing installations as
      // soon as their configuration is loaded.
      if (Object.prototype.hasOwnProperty.call(raw, 'shortcut')) await this.persist();
    } catch {
      this.apiKeyEncrypted = null;
      this.config = defaultConfig();
      await this.persist();
    }
    return this.value;
  }

  async update(patch: ConfigPatch): Promise<AppConfig> {
    const merged: AppConfig = {
      ...this.config,
      ...patch,
      window: { ...this.config.window, ...(patch.window ?? {}) },
    };
    this.config = this.validate(merged);
    await this.persist();
    return this.value;
  }

  getApiKey(): string | null {
    if (this.apiKeyEncrypted) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(this.apiKeyEncrypted, 'base64'));
        }
      } catch {
        // Fall back to an environment key, if one was provided.
      }
    }
    return this.environmentApiKey;
  }

  async setApiKey(apiKey: string): Promise<AppConfig> {
    const value = apiKey.trim();
    if (!value) return this.clearApiKey();
    if (value.length > 4096 || /[\r\n]/.test(value)) throw new Error('API key format is invalid.');
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows secure storage is unavailable. Set OPENAI_API_KEY for this session instead.');
    }
    this.apiKeyEncrypted = safeStorage.encryptString(value).toString('base64');
    this.config = this.validate(this.config);
    await this.persist();
    return this.value;
  }

  async clearApiKey(): Promise<AppConfig> {
    this.apiKeyEncrypted = null;
    this.config = this.validate(this.config);
    await this.persist();
    return this.value;
  }

  async persist(): Promise<void> {
    const snapshot = JSON.stringify({ ...this.config, apiKeyEncrypted: this.apiKeyEncrypted }, null, 2);
    this.persistQueue = this.persistQueue.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await fs.writeFile(temporaryPath, snapshot, 'utf8');
      await fs.rename(temporaryPath, this.filePath);
    });
    await this.persistQueue;
  }

  private validate(input: unknown): AppConfig {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const defaults = defaultConfig();
    // Transport switching is an in-app operation. Ignore the legacy
    // CODEX_TRANSPORT variable so a shell command cannot override a saved UI
    // choice or make switching back appear ineffective.
    const mode: TransportMode = raw.mode === 'api' ? 'api' : raw.mode === 'playwright' ? 'playwright' : defaults.mode;
    const language: Language = raw.language === 'en-US' || raw.language === 'zh-CN' ? raw.language : defaults.language;
    const codexUrl = typeof raw.codexUrl === 'string' && /^https?:\/\//i.test(raw.codexUrl)
      ? raw.codexUrl.slice(0, 2048)
      : defaults.codexUrl;
    const apiBaseUrl = sanitizeApiBaseUrl(raw.apiBaseUrl, defaults.apiBaseUrl);
    const apiModelValue = typeof raw.apiModel === 'string' ? raw.apiModel.trim() : '';
    const apiModel = apiModelValue.length > 0 && apiModelValue.length <= 256 && !/[\u0000-\u001f\u007f]/.test(apiModelValue)
      ? apiModelValue
      : defaults.apiModel;
    const lastPageUrl = sanitizePageUrl(raw.lastPageUrl, codexUrl);
    const lastThreadId = typeof raw.lastThreadId === 'string' && raw.lastThreadId.length > 0 && raw.lastThreadId.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(raw.lastThreadId)
      ? raw.lastThreadId
      : null;
    const miniMode = typeof raw.miniMode === 'boolean' ? raw.miniMode : defaults.miniMode;
    return {
      mode,
      language,
      codexUrl,
      lastPageUrl,
      lastThreadId,
      apiBaseUrl,
      apiModel,
      apiKeyConfigured: Boolean(this.apiKeyEncrypted || this.environmentApiKey),
      window: sanitizeBounds(raw.window, defaults.window, miniMode),
      // Normalize legacy values below the practical UI floor when loading.
      opacity: clampNumber(raw.opacity, OPACITY_MIN, OPACITY_MAX, defaults.opacity),
      alwaysOnTop: typeof raw.alwaysOnTop === 'boolean' ? raw.alwaysOnTop : defaults.alwaysOnTop,
      miniMode,
      theme: raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system' ? raw.theme : defaults.theme,
      launchAtLogin: typeof raw.launchAtLogin === 'boolean' ? raw.launchAtLogin : defaults.launchAtLogin,
    };
  }
}

function sanitizeApiBaseUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return fallback;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '').slice(0, 2048);
  } catch {
    return fallback;
  }
}

function sanitizePageUrl(value: unknown, fallback: string): string | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    const base = new URL(fallback);
    if (url.origin !== base.origin) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|secret|password|passwd|auth|session|code|key)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString().slice(0, 2048);
  } catch {
    return null;
  }
}
