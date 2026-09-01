# Project Context IPC

The floating window reads the same local project registry used by Codex
Desktop (`~/.codex/.codex-global-state.json`). Projects are never fabricated;
when the registry is unavailable the picker reports that no projects are
available.

To enable the project picker end to end, the main-process boundary needs these
additive operations. They are documented here only; this change intentionally
does not add IPC channels or change the app-server protocol.

```ts
interface ProjectSummary {
  id: string;             // Stable host/project identifier
  name: string;           // User-facing project name
  directory: string;      // Absolute working directory
  isGitRepository: boolean;
}

interface ProjectContext extends ProjectSummary {
  selectedAt: number;     // Unix milliseconds
}

// app:list-projects -> Promise<ProjectSummary[]>
// app:get-project-context -> Promise<ProjectContext | null>
// app:switch-project({ projectId: string }) -> Promise<ProjectContext>
```

`AppState` carries `project: ProjectContext | null`. `thread/start` receives
`cwd: project.directory` from the selected context. A successful switch clears
the active draft/thread selection, reconnects the app-server with the new
working directory, and broadcasts the updated state so a new conversation
cannot inherit the former project's directory.
