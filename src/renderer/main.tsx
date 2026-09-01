import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Camera,
  Check,
  Crosshair,
  Ellipsis,
  ExternalLink,
  FileText,
  FolderOpen,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Send,
  Search,
  Settings2,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import type { ApiModelOption, AppConfig, AppState, AttachmentPayload, Language, ProjectSummary, ReasoningEffort } from '../shared/types';
import { getUiText, localizeRuntimeMessage } from './i18n';
import './styles.css';

const MODEL_NAMES: Record<string, string> = {
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.2': 'GPT-5.2',
};

function modelName(id: string): string {
  return MODEL_NAMES[id] ?? id;
}

type LocalMessage = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  attachmentNames?: string[];
};

type ProjectInfo = ProjectSummary;

/** The renderer is a shell; history and message rendering stay in Codex. */
export function App() {
  const [appState, setAppState] = useState<AppState | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectConfirmOpen, setProjectConfirmOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectSearch, setProjectSearch] = useState('');
  const [currentProject, setCurrentProject] = useState<ProjectInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelRefreshing, setModelRefreshing] = useState(false);
  const [modelRefreshed, setModelRefreshed] = useState(false);
  const [visibleError, setVisibleError] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const messageRef = useRef('');
  const messageIdRef = useRef(0);
  const messageListRef = useRef<HTMLDivElement>(null);
  const overlaySyncRef = useRef<Promise<void>>(Promise.resolve());

  const appendMessage = (message: Omit<LocalMessage, 'id'>) => {
    const next = { ...message, id: ++messageIdRef.current };
    setMessages((current) => [...current, next]);
  };

  const syncOfficialPageOverlay = (open: boolean) => {
    overlaySyncRef.current = overlaySyncRef.current
      .catch(() => undefined)
      .then(() => window.codexAssistant.setOfficialPageOverlayOpen(open))
      .catch(() => undefined);
  };

  useEffect(() => {
    const bridge = window.codexAssistant;
    if (!bridge) { setStartupError('Electron IPC bridge is unavailable.'); return undefined; }
    void bridge.getState().then((next) => { setAppState(next); setCurrentProject(next.project); }).catch((error: unknown) => setStartupError(error instanceof Error ? error.message : String(error)));
    return bridge.onState((next) => { setStartupError(null); setAppState(next); setCurrentProject(next.project); });
  }, []);

  useEffect(() => {
    const error = appState?.lastError ?? null;
    setVisibleError(error);
    if (!error) return undefined;
    const timer = window.setTimeout(() => setVisibleError(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [appState?.lastError]);

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('.menu-anchor, .settings-popover, .project-popover, .project-confirm')) {
        setActionMenuOpen(false);
        setAttachmentMenuOpen(false);
      }
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActionMenuOpen(false);
        setAttachmentMenuOpen(false);
        setSettingsOpen(false);
        setProjectPickerOpen(false);
        setProjectConfirmOpen(false);
      }
    };
    window.addEventListener('pointerdown', closeMenus);
    window.addEventListener('keydown', closeWithEscape);
    return () => {
      window.removeEventListener('pointerdown', closeMenus);
      window.removeEventListener('keydown', closeWithEscape);
    };
  }, []);

  const officialOverlayOpen = appState?.config.mode === 'playwright' &&
    (actionMenuOpen || settingsOpen || projectPickerOpen || projectConfirmOpen || Boolean(visibleError));
  useEffect(() => {
    syncOfficialPageOverlay(Boolean(officialOverlayOpen));
  }, [officialOverlayOpen]);

  useEffect(() => () => {
    syncOfficialPageOverlay(false);
  }, []);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, busy]);

  if (startupError) return <div className="shell-error" role="alert"><X size={16} /> {startupError}</div>;
  if (!appState) return <div className="shell-loading"><LoaderCircle size={16} className="spin" /> Loading Codex...</div>;

  const text = getUiText(appState.config.language);
  const official = appState.config.mode === 'playwright';
  const connectionTone = appState.connection === 'connected' ? 'ok' : appState.connection === 'connecting' ? 'pending' : 'warn';
  const canSend = Boolean(message.trim() || attachments.length) && !busy && appState.connection === 'connected';
  const themeClass = `theme-${appState.config.theme}`;

  const send = async () => {
    if (!canSend) return;
    const draft = { text: message.trim(), attachments };
    const attachmentNames = draft.attachments.map((attachment) => attachment.name);
    appendMessage({
      role: 'user',
      text: draft.text || attachmentNames.join(', '),
      attachmentNames: attachmentNames.length > 0 ? attachmentNames : undefined,
    });
    messageRef.current = ''; setMessage(''); setAttachments([]); setBusy(true);
    try {
      const next = await window.codexAssistant.sendMessage(draft);
      if (next.lastResponse) appendMessage({ role: 'assistant', text: next.lastResponse });
    } catch {
      if (!messageRef.current) { messageRef.current = draft.text; setMessage(draft.text); setAttachments(draft.attachments); }
    } finally { setBusy(false); }
  };
  const capture = async (selectRegion: boolean, sendImmediately = true) => {
    setAttachmentMenuOpen(false); setActionMenuOpen(false); setBusy(true);
    try {
      if (sendImmediately) {
        const next = await window.codexAssistant.captureAndSend({ selectRegion });
        appendMessage({ role: 'user', text: selectRegion ? text.attachRegion : text.attachFullScreen });
        if (next.lastResponse) appendMessage({ role: 'assistant', text: next.lastResponse });
      }
      else { const attachment = await window.codexAssistant.captureAttachment({ selectRegion }); setAttachments((current) => [...current, attachment].slice(0, 8)); }
    } catch { /* state carries the error */ }
    finally { setBusy(false); }
  };
  const pickFiles = async () => {
    setAttachmentMenuOpen(false); setBusy(true);
    try { const picked = await window.codexAssistant.pickFiles(); setAttachments((current) => [...current, ...picked].slice(0, 8)); }
    catch { /* state carries the error */ }
    finally { setBusy(false); }
  };
  const refreshModels = async () => {
    if (modelRefreshing) return;
    setModelRefreshing(true); setModelRefreshed(false);
    try {
      await window.codexAssistant.openModelMenu();
      setModelRefreshed(true);
      window.setTimeout(() => setModelRefreshed(false), 1_600);
    } catch { /* state carries the error */ }
    finally { setModelRefreshing(false); }
  };
  const openSettings = () => {
    setActionMenuOpen(false);
    if (official) void window.codexAssistant.openSettings();
    setSettingsOpen((value) => !value);
  };
  const newConversation = async () => {
    setMessages([]);
    await window.codexAssistant.newConversation();
  };
  const openProjectPicker = async () => {
    setActionMenuOpen(false);
    setProjectSearch('');
    setProjectPickerOpen(true);
    try { setProjects(await window.codexAssistant.listProjects()); } catch { setProjects([]); }
  };
  const selectProject = async (project: ProjectInfo) => {
    try {
      const next = await window.codexAssistant.switchProject(project.id);
      setCurrentProject(next.project);
      setCurrentProject(project);
      setProjectPickerOpen(false);
    } catch { /* state carries the error when the host supports this contract */ }
  };

  return <main className={`floating-shell ${official ? 'official-shell' : 'api-shell'} ${themeClass}`}>
    <header className="floating-toolbar" data-testid="main-toolbar">
      <div className="brand" title="Codex"><span className="brand-mark"><Sparkles size={13} /></span><strong>Codex</strong><span className="brand-sub">{official ? 'OFFICIAL' : 'API'}</span></div>
      <div className="toolbar-status" title={text.status[appState.connection]}><span className={`status-dot ${connectionTone}`} /><span className="status-label">{text.status[appState.connection]}</span></div>
      {!official ? <ModelControl
        language={appState.config.language}
        currentModel={appState.config.apiModel}
        models={appState.availableModels}
        refreshing={modelRefreshing}
        refreshed={modelRefreshed}
        onChange={(apiModel) => void window.codexAssistant.updateConfig({ apiModel })}
        onRefresh={() => void refreshModels()}
      /> : <div className="toolbar-drag-space" />}
      {!official && <ReasoningControl language={appState.config.language} value={appState.config.reasoningEffort} onChange={(reasoningEffort) => void window.codexAssistant.updateConfig({ reasoningEffort })} />}
      <div className="toolbar-actions no-drag">
        <div className="menu-anchor toolbar-menu-wrap">
          <button className="toolbar-menu-trigger" title={text.moreActions} aria-label={text.moreActions} aria-expanded={actionMenuOpen} onClick={() => { setActionMenuOpen((value) => !value); setAttachmentMenuOpen(false); }}><Ellipsis size={16} /></button>
          {actionMenuOpen && <div className="command-menu menu-surface" role="menu">
            <div className="project-menu-summary" role="status">
              <div className="project-menu-label"><FolderOpen size={14} /><span>{text.currentProject}</span></div>
              <strong>{currentProject?.name ?? text.noProjectSelected}</strong>
              <span className="project-directory">{currentProject?.directory ?? text.projectDirectory + ': ' + text.noProjectSelected}</span>
            </div>
            <button role="menuitem" onClick={() => void openProjectPicker()}><FolderOpen size={15} /><span>{text.switchProject}</span></button>
            <button role="menuitem" onClick={() => { setActionMenuOpen(false); setProjectConfirmOpen(true); }}><Plus size={15} /><span>{text.newConversation}</span></button>
            {official && <button role="menuitem" onClick={() => { setActionMenuOpen(false); void window.codexAssistant.openModelMenu(); }}><Sparkles size={15} /><span>{text.model}</span></button>}
            <button role="menuitem" disabled={busy} onClick={() => void capture(false)}><Camera size={15} /><span>{text.attachFullScreen}</span></button>
            <button role="menuitem" disabled={busy} onClick={() => void capture(true)}><Crosshair size={15} /><span>{text.attachRegion}</span></button>
            <button role="menuitem" onClick={() => { setActionMenuOpen(false); void window.codexAssistant.reconnect(); }}><RefreshCw size={15} className={appState.connection === 'connecting' ? 'spin' : ''} /><span>{text.reconnect}</span></button>
            <button role="menuitem" onClick={() => { setActionMenuOpen(false); void window.codexAssistant.openCodex(); }}><ExternalLink size={15} /><span>{text.openCodex}</span></button>
            <button role="menuitem" onClick={openSettings}><Settings2 size={15} /><span>{text.settings}</span></button>
          </div>}
        </div>
        <button title={text.minimizeWindow} aria-label={text.minimizeWindow} onClick={() => void window.codexAssistant.minimizeWindow()}><Minus size={16} /></button>
        <button className="close" title={text.quitAssistant} aria-label={text.quitAssistant} onClick={() => void window.codexAssistant.quit()}><X size={16} /></button>
      </div>
    </header>
    {official ? <div className="embedded-page-label" data-testid="official-page-shell">{appState.page?.title || text.codexPage}</div> : <section className="api-workbench" aria-label={text.messageLabel}>
      <div className="api-message-list" ref={messageListRef} aria-live="polite">
        {messages.length === 0 && <div className="api-empty"><Sparkles size={20} /><span>{text.ready}</span></div>}
        {messages.map((item) => <div className={`api-message api-message-${item.role}`} key={item.id}>
          <div className="api-message-label">{item.role === 'user' ? text.user : 'Codex'}</div>
          <div className="api-message-bubble">{item.text}</div>
          {item.attachmentNames && <div className="api-message-attachments">{item.attachmentNames.join(', ')}</div>}
        </div>)}
        {busy && <div className="api-message api-message-assistant api-message-pending"><div className="api-message-label">Codex</div><div className="api-message-bubble"><LoaderCircle size={14} className="spin" /></div></div>}
      </div>
      {attachments.length > 0 && <div className="attachment-drafts">{attachments.map((item) => <div className="attachment-draft" data-testid="attachment-draft" key={item.id}><span>{item.previewDataUrl ? <img src={item.previewDataUrl} alt={item.name} /> : <FileText size={16} />}</span><b className="attachment-name" title={item.name}>{item.name}</b><button title={text.removeAttachment} aria-label={`${text.removeAttachment}: ${item.name}`} onClick={() => setAttachments((current) => current.filter((value) => value.id !== item.id))}><X size={13} /></button></div>)}</div>}
      <textarea value={message} onChange={(event) => { messageRef.current = event.target.value; setMessage(event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void send(); }} placeholder={attachments.length ? text.messageAttachmentPlaceholder : text.messagePlaceholder} aria-label={text.messageAria} rows={4} />
      <div className="composer-row no-drag"><div className="attachment-wrap menu-anchor"><button className="attachment-trigger" title={text.addAttachment} aria-label={text.addAttachment} aria-expanded={attachmentMenuOpen} onClick={() => { setAttachmentMenuOpen((value) => !value); setActionMenuOpen(false); }} disabled={busy}><Plus size={18} /></button>{attachmentMenuOpen && <div className="attachment-menu menu-surface" role="menu"><button role="menuitem" onClick={() => void capture(false, false)}><Camera size={14} /> {text.attachFullScreen}</button><button role="menuitem" onClick={() => void capture(true, false)}><Crosshair size={14} /> {text.attachRegion}</button><button role="menuitem" onClick={() => void pickFiles()}><Upload size={14} /> {text.attachFiles}</button></div>}</div><span className="send-hint">{busy ? text.sending : text.sendHint}</span><button className="send" title={text.sendMessage} aria-label={text.sendMessage} onClick={() => void send()} disabled={!canSend}>{busy ? <LoaderCircle size={17} className="spin" /> : <Send size={17} />}</button></div>
    </section>}
    {visibleError && <div className="error-strip" role="alert"><span>{localizeRuntimeMessage(visibleError, appState.config.language)}</span><button title={text.dismissError} aria-label={text.dismissError} onClick={() => setVisibleError(null)}><X size={13} /></button></div>}
    {settingsOpen && <Settings config={appState.config} onChange={(patch) => void window.codexAssistant.updateConfig(patch)} onClose={() => setSettingsOpen(false)} />}
    {projectPickerOpen && <ProjectPicker language={appState.config.language} projects={projects} search={projectSearch} currentProject={currentProject} onSearch={setProjectSearch} onSelect={(project) => void selectProject(project)} onClose={() => setProjectPickerOpen(false)} />}
    {projectConfirmOpen && <ProjectConfirm language={appState.config.language} project={currentProject} onCancel={() => setProjectConfirmOpen(false)} onConfirm={() => { setProjectConfirmOpen(false); void newConversation(); }} />}
  </main>;
}

function ModelControl({ language, currentModel, models, refreshing, refreshed, onChange, onRefresh }: { language: Language; currentModel: string; models: ApiModelOption[]; refreshing: boolean; refreshed: boolean; onChange: (model: string) => void; onRefresh: () => void }) {
  const uniqueModels = models.filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index);
  const options = uniqueModels.some((model) => model.id === currentModel) ? uniqueModels : [{ id: currentModel }, ...uniqueModels];
  const text = getUiText(language);
  return <div className={`model-control no-drag ${refreshing ? 'is-refreshing' : ''}`} title={`${text.currentModel}: ${modelName(currentModel)}`}>
    <label htmlFor="toolbar-model">{text.modelShort}</label>
    <select id="toolbar-model" className="toolbar-model" aria-label={text.model} value={currentModel} onChange={(event) => onChange(event.target.value)} disabled={refreshing || options.length === 0}>
      {options.map((model) => <option key={model.id} value={model.id}>{modelName(model.id)}</option>)}
    </select>
    <button className={refreshed ? 'model-refreshed' : ''} title={refreshing ? text.modelsLoading : refreshed ? text.modelsRefreshed : text.refreshModels} aria-label={refreshing ? text.modelsLoading : text.refreshModels} onClick={onRefresh} disabled={refreshing}>{refreshed ? <Check size={13} /> : <RefreshCw size={13} className={refreshing ? 'spin' : ''} />}</button>
  </div>;
}

function ReasoningControl({ language, value, onChange }: { language: Language; value: ReasoningEffort; onChange: (value: ReasoningEffort) => void }) {
  const text = getUiText(language);
  const options: Array<[ReasoningEffort, string, string]> = [
    ['auto', text.reasoningAuto, 'Auto'],
    ['minimal', text.reasoningMinimal, 'Minimal'],
    ['low', text.reasoningLow, 'Low'],
    ['medium', text.reasoningMedium, 'Medium'],
    ['high', text.reasoningHigh, 'High'],
    ['xhigh', text.reasoningXhigh, 'Xhigh'],
    ['max', text.reasoningMax, 'Max'],
  ];
  return <div className="reasoning-control no-drag" title={text.reasoningEffort}>
    <label htmlFor="toolbar-reasoning">{text.reasoningShort}</label>
    <select id="toolbar-reasoning" value={value} aria-label={text.reasoningEffort} onChange={(event) => onChange(event.target.value as ReasoningEffort)}>
      {options.map(([id, label, english]) => <option key={id} value={id}>{label} · {english}</option>)}
    </select>
  </div>;
}

function Settings({ config, onChange, onClose }: { config: AppConfig; onChange: (patch: Partial<AppConfig>) => void; onClose: () => void }) {
  const text = getUiText(config.language);
  return <section className="settings-popover menu-surface no-drag" aria-label={text.preferences}><div className="settings-heading"><strong>{text.preferences}</strong><button title={text.closePanel} aria-label={text.closePanel} onClick={onClose}><X size={14} /></button></div><label>{text.language}<select value={config.language} onChange={(event) => onChange({ language: event.target.value as AppConfig['language'] })}><option value="zh-CN">{text.languageZh}</option><option value="en-US">{text.languageEn}</option></select></label><label>{text.transportMode}<select value={config.mode} onChange={(event) => onChange({ mode: event.target.value as AppConfig['mode'] })}><option value="playwright">{text.officialMode}</option><option value="api">{text.ccswitchMode}</option></select></label><label>{text.theme}<select value={config.theme} onChange={(event) => onChange({ theme: event.target.value as AppConfig['theme'] })}><option value="system">{text.systemTheme}</option><option value="dark">{text.darkTheme}</option><option value="light">{text.lightTheme}</option></select></label><label>{text.opacity}<span className="range-row"><input type="range" min="72" max="100" step="1" value={Math.round(config.opacity * 100)} onChange={(event) => onChange({ opacity: Number(event.target.value) / 100 })} /><output>{Math.round(config.opacity * 100)}%</output></span></label><label className="toggle-row"><input type="checkbox" checked={config.alwaysOnTop} onChange={(event) => onChange({ alwaysOnTop: event.target.checked })} /><span>{text.alwaysOnTop}</span></label><label className="toggle-row"><input type="checkbox" checked={config.launchAtLogin} onChange={(event) => onChange({ launchAtLogin: event.target.checked })} /><span>{text.launchAtLogin}</span></label></section>;
}

function ProjectPicker({ language, projects, search, currentProject, onSearch, onSelect, onClose }: { language: Language; projects: ProjectInfo[]; search: string; currentProject: ProjectInfo | null; onSearch: (value: string) => void; onSelect: (project: ProjectInfo) => void; onClose: () => void }) {
  const text = getUiText(language);
  const normalized = search.trim().toLowerCase();
  const filtered = projects.filter((project) => !normalized || `${project.name} ${project.directory}`.toLowerCase().includes(normalized));
  return <section className="project-popover menu-surface no-drag" aria-label={text.switchProject}>
    <div className="settings-heading"><strong>{text.switchProject}</strong><button title={text.closePanel} aria-label={text.closePanel} onClick={onClose}><X size={14} /></button></div>
    <label className="project-search"><Search size={14} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder={text.projectSearchPlaceholder} aria-label={text.projectSearch} /></label>
    <div className="project-list" role="listbox" aria-label={text.switchProject}>
      {filtered.map((project) => <button className={`project-option ${currentProject?.id === project.id ? 'is-selected' : ''}`} key={project.id} role="option" aria-selected={currentProject?.id === project.id} onClick={() => onSelect(project)}><FolderOpen size={15} /><span><b>{project.name}</b><small>{project.directory}</small></span>{currentProject?.id === project.id && <Check size={14} />}</button>)}
      {filtered.length === 0 && <p className="project-empty">{projects.length === 0 ? text.projectsUnavailable : text.noProjectSelected}</p>}
    </div>
  </section>;
}

function ProjectConfirm({ language, project, onCancel, onConfirm }: { language: Language; project: ProjectInfo | null; onCancel: () => void; onConfirm: () => void }) {
  const text = getUiText(language);
  return <div className="project-confirm-backdrop no-drag" role="presentation"><section className="project-confirm menu-surface" role="dialog" aria-modal="true" aria-label={text.createConversation}>
    <div className="settings-heading"><strong>{text.createConversation}</strong><button title={text.closePanel} aria-label={text.closePanel} onClick={onCancel}><X size={14} /></button></div>
    <p>{text.targetProject}: <b>{project?.name ?? text.noProjectSelected}</b></p>
    <small>{project?.directory ?? text.projectDirectory + ': ' + text.noProjectSelected}</small>
    <div className="project-confirm-actions"><button className="secondary-action" onClick={onCancel}>{text.cancel}</button><button className="primary-action" onClick={onConfirm}><Plus size={14} />{text.createConversation}</button></div>
  </section></div>;
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Renderer root element is missing.');
const root = window.__codexAssistantRoot ?? createRoot(rootElement);
window.__codexAssistantRoot = root;
root.render(<App />);

export default App;
