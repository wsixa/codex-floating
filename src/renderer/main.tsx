import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Camera, Crosshair, ExternalLink, FileText, LoaderCircle, Maximize2, Minus, Plus, RefreshCw, Send, Settings2, Sparkles, Upload, X } from 'lucide-react';
import type { AppConfig, AppState, AttachmentPayload } from '../shared/types';
import { getUiText, localizeRuntimeMessage } from './i18n';
import './styles.css';

/** The renderer is a shell; history and message rendering stay in Codex. */
export function App() {
  const [appState, setAppState] = useState<AppState | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const messageRef = useRef('');

  useEffect(() => {
    const bridge = window.codexAssistant;
    if (!bridge) { setStartupError('Electron IPC bridge is unavailable.'); return undefined; }
    void bridge.getState().then(setAppState).catch((error: unknown) => setStartupError(error instanceof Error ? error.message : String(error)));
    return bridge.onState((next) => { setStartupError(null); setAppState(next); });
  }, []);

  if (startupError) return <div className="shell-error" role="alert"><X size={16} /> {startupError}</div>;
  if (!appState) return <div className="shell-loading"><LoaderCircle size={16} className="spin" /> Loading Codex…</div>;
  const text = getUiText(appState.config.language);
  const official = appState.config.mode === 'playwright';
  const connectionTone = appState.connection === 'connected' ? 'ok' : appState.connection === 'connecting' ? 'pending' : 'warn';
  const canSend = Boolean(message.trim() || attachments.length) && !busy && appState.connection === 'connected';

  const send = async () => {
    if (!canSend) return;
    const draft = { text: message.trim(), attachments };
    messageRef.current = ''; setMessage(''); setAttachments([]); setBusy(true);
    try { await window.codexAssistant.sendMessage(draft); } catch {
      if (!messageRef.current) { messageRef.current = draft.text; setMessage(draft.text); setAttachments(draft.attachments); }
    } finally { setBusy(false); }
  };
  const capture = async (selectRegion: boolean, sendImmediately = true) => {
    setMenuOpen(false); setBusy(true);
    try {
      if (sendImmediately) await window.codexAssistant.captureAndSend({ selectRegion });
      else { const attachment = await window.codexAssistant.captureAttachment({ selectRegion }); setAttachments((current) => [...current, attachment].slice(0, 8)); }
    } catch { /* state carries the error */ }
    finally { setBusy(false); }
  };
  const pickFiles = async () => {
    setMenuOpen(false); setBusy(true);
    try { const picked = await window.codexAssistant.pickFiles(); setAttachments((current) => [...current, ...picked].slice(0, 8)); }
    catch { /* state carries the error */ }
    finally { setBusy(false); }
  };

  return <main className={`floating-shell ${official ? 'official-shell' : 'api-shell'}`}>
    <header className="floating-toolbar">
      <div className="brand"><span className="brand-mark"><Sparkles size={13} /></span><strong>Codex</strong><span className="brand-sub">{official ? 'OFFICIAL' : 'API'}</span></div>
      <div className="toolbar-status"><span className={`status-dot ${connectionTone}`} /><span>{text.status[appState.connection]}</span></div>
      {!official && appState.availableModels.length > 0 && <select className="toolbar-model no-drag" aria-label={text.model} value={appState.config.apiModel} onChange={(event) => void window.codexAssistant.updateConfig({ apiModel: event.target.value })}>{appState.availableModels.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}</select>}
      <div className="toolbar-actions no-drag">
        <button title={text.newConversation} aria-label={text.newConversation} onClick={() => void window.codexAssistant.newConversation()}><Plus size={15} /></button>
        <button title={text.model} aria-label={text.model} onClick={() => void window.codexAssistant.openModelMenu()}><Sparkles size={14} /></button>
        <button title={text.attachFullScreen} aria-label={text.attachFullScreen} onClick={() => void capture(false)} disabled={busy}><Camera size={14} /></button>
        <button title={text.attachRegion} aria-label={text.attachRegion} onClick={() => void capture(true)} disabled={busy}><Crosshair size={14} /></button>
        <button title={text.reconnect} aria-label={text.reconnect} onClick={() => void window.codexAssistant.reconnect()}><RefreshCw size={14} className={appState.connection === 'connecting' ? 'spin' : ''} /></button>
        <button title={text.openCodex} aria-label={text.openCodex} onClick={() => void window.codexAssistant.openCodex()}><ExternalLink size={14} /></button>
        <button title={text.settings} aria-label={text.settings} onClick={() => { if (official) void window.codexAssistant.openSettings(); setSettingsOpen((value) => !value); }}><Settings2 size={14} /></button>
        <button title={text.minimizeWindow} aria-label={text.minimizeWindow} onClick={() => void window.codexAssistant.minimizeWindow()}><Minus size={15} /></button>
        <button className="close" title={text.quitAssistant} aria-label={text.quitAssistant} onClick={() => void window.codexAssistant.quit()}><X size={15} /></button>
      </div>
    </header>
    {official ? <div className="embedded-page-label" data-testid="official-page-shell">{appState.page?.title || text.codexPage}</div> : <section className="api-workbench" aria-label={text.messageLabel}>
      {appState.lastResponse && <div className="api-response">{appState.lastResponse}</div>}
      {attachments.length > 0 && <div className="attachment-drafts">{attachments.map((item) => <div className="attachment-draft" data-testid="attachment-draft" key={item.id}><span>{item.previewDataUrl ? <img src={item.previewDataUrl} alt={item.name} /> : <FileText size={16} />}</span><b className="attachment-name" title={item.name}>{item.name}</b><button title={text.removeAttachment} aria-label={`${text.removeAttachment}: ${item.name}`} onClick={() => setAttachments((current) => current.filter((value) => value.id !== item.id))}><X size={13} /></button></div>)}</div>}
      <textarea value={message} onChange={(event) => { messageRef.current = event.target.value; setMessage(event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void send(); }} placeholder={text.messagePlaceholder} aria-label={text.messageAria} rows={4} disabled={busy} />
      <div className="composer-row no-drag"><div className="attachment-wrap"><button title={text.addAttachment} aria-label={text.addAttachment} onClick={() => setMenuOpen((value) => !value)} disabled={busy}><Plus size={18} /></button>{menuOpen && <div className="attachment-menu" role="menu"><button role="menuitem" onClick={() => void capture(false, false)}><Camera size={14} /> {text.attachFullScreen}</button><button role="menuitem" onClick={() => void capture(true, false)}><Camera size={14} /> {text.attachRegion}</button><button role="menuitem" onClick={() => void pickFiles()}><Upload size={14} /> {text.attachFiles}</button></div>}</div><span className="send-hint">{text.sendHint}</span><button className="send" title={text.sendMessage} aria-label={text.sendMessage} onClick={() => void send()} disabled={!canSend}>{busy ? <LoaderCircle size={17} className="spin" /> : <Send size={17} />}</button></div>
    </section>}
    {appState.lastError && <div className="error-strip" role="alert">{localizeRuntimeMessage(appState.lastError, appState.config.language)}</div>}
    {settingsOpen && <Settings config={appState.config} onChange={(patch) => void window.codexAssistant.updateConfig(patch)} onClose={() => setSettingsOpen(false)} />}
    {appState.config.miniMode && <button className="mini-expand" title={text.exitMini} aria-label={text.exitMini} onClick={() => void window.codexAssistant.toggleMiniMode()}><Maximize2 size={15} /></button>}
  </main>;
}

function Settings({ config, onChange, onClose }: { config: AppConfig; onChange: (patch: Partial<AppConfig>) => void; onClose: () => void }) {
  const text = getUiText(config.language);
  return <section className="settings-popover"><div className="settings-heading"><strong>{text.preferences}</strong><button title="Close" aria-label="Close" onClick={onClose}><X size={14} /></button></div><label>{text.language}<select value={config.language} onChange={(event) => onChange({ language: event.target.value as AppConfig['language'] })}><option value="zh-CN">{text.languageZh}</option><option value="en-US">{text.languageEn}</option></select></label><label>{text.transportMode}<select value={config.mode} onChange={(event) => onChange({ mode: event.target.value as AppConfig['mode'] })}><option value="playwright">{text.officialMode}</option><option value="api">{text.ccswitchMode}</option></select></label><label>{text.theme}<select value={config.theme} onChange={(event) => onChange({ theme: event.target.value as AppConfig['theme'] })}><option value="system">{text.systemTheme}</option><option value="dark">{text.darkTheme}</option><option value="light">{text.lightTheme}</option></select></label></section>;
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Renderer root element is missing.');
createRoot(rootElement).render(<App />);

export default App;
