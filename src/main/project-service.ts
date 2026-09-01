import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ProjectContext, ProjectSummary } from '../shared/types';

type CodexProjectRecord = {
  id?: unknown;
  name?: unknown;
  rootPaths?: unknown;
};

/** Reads the same local-project registry used by Codex Desktop. */
export class ProjectService {
  private selectedProjectId: string | null = null;
  private selectedAt = 0;

  async listProjects(): Promise<ProjectSummary[]> {
    const state = await this.readGlobalState();
    const records = state?.['local-projects'];
    if (!records || typeof records !== 'object') return [];
    const order = Array.isArray(state?.['project-order']) ? state['project-order'].filter((id): id is string => typeof id === 'string') : [];
    const ids = [...order, ...Object.keys(records as Record<string, unknown>)];
    const seen = new Set<string>();
    const projects: ProjectSummary[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const raw = (records as Record<string, CodexProjectRecord>)[id];
      const directory = Array.isArray(raw?.rootPaths) ? raw.rootPaths.find((value): value is string => typeof value === 'string' && path.isAbsolute(value)) : null;
      const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
      if (!directory || !name || typeof raw?.id !== 'string' || raw.id !== id) continue;
      projects.push({ id, name: name.slice(0, 160), directory: path.normalize(directory), isGitRepository: await this.isGitRepository(directory) });
    }
    return projects;
  }

  async getContext(configuredId: string | null): Promise<ProjectContext | null> {
    const state = await this.readGlobalState();
    const selected = this.selectedProjectId ?? configuredId ?? this.readDesktopSelection(state);
    const project = (await this.listProjects()).find((item) => item.id === selected) ?? null;
    if (!project) return null;
    if (this.selectedProjectId !== project.id) this.selectedAt = Date.now();
    this.selectedProjectId = project.id;
    return { ...project, selectedAt: this.selectedAt || Date.now() };
  }

  async select(projectId: string): Promise<ProjectContext> {
    const project = (await this.listProjects()).find((item) => item.id === projectId);
    if (!project) throw new Error('The selected Codex project is no longer available.');
    this.selectedProjectId = project.id;
    this.selectedAt = Date.now();
    return { ...project, selectedAt: this.selectedAt };
  }

  private async readGlobalState(): Promise<Record<string, unknown> | null> {
    const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
    try {
      return JSON.parse(await fs.readFile(path.join(home, '.codex-global-state.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private readDesktopSelection(state: Record<string, unknown> | null): string | null {
    const value = state?.['selected-project'];
    if (!value || typeof value !== 'object') return null;
    const id = (value as Record<string, unknown>).projectId;
    return typeof id === 'string' ? id : null;
  }

  private async isGitRepository(directory: string): Promise<boolean> {
    try { await fs.access(path.join(directory, '.git')); return true; } catch { return false; }
  }
}
