import { IpcMain, shell, dialog, clipboard, BrowserWindow } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import axios from "axios";
import {
  parseRepoUrl,
  fetchSpecKitData,
  validateCredentials,
  listBranches,
  listRepositories,
  baseConfigForHost,
} from "../bitbucket";
import { analyzeRepo, analyzeRepoDiff } from "../analyzer";
import {
  getCredentials,
  saveCredentials,
  getGitHubToken,
  saveGitHubToken,
  getDigestWebhook,
  saveDigestWebhook,
  listRepos,
  addRepo,
  removeRepoById,
  setRepoBranchById,
  cloneRepo,
  archiveRepo,
  reorderRepos,
  saveSnapshotById,
  getLastSnapshotById,
} from "../state";
import { WatchedRepo, AnalysisResult, DiffResult, RepoConfig } from "../types";

// Render a standalone HTML document to a PDF buffer using an offscreen window.
async function htmlToPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false },
  });
  const tmp = path.join(os.tmpdir(), `speckit-report-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, "utf-8");
  try {
    await win.loadFile(tmp);
    return await win.webContents.printToPDF({ printBackground: true, pageSize: "Letter" });
  } finally {
    win.destroy();
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

type ProgressFn = (message: string) => void;

interface RepoSummary extends WatchedRepo {
  hasSnapshot: boolean;
  host: string;
}

// Build a full RepoConfig (kind/host/apiBaseUrl) from a stored repo or a raw
// URL by re-parsing the URL, carrying over the alias and branch.
function toConfig(repo: { url: string; alias?: string; branch?: string }): RepoConfig {
  return { ...parseRepoUrl(repo.url), alias: repo.alias, branch: repo.branch };
}

// Resolve a watched repo by its stable id first, falling back to alias / url /
// workspace-slug for older callers (and the CLI-style keys).
function findWatched(idOrKey: string): WatchedRepo | undefined {
  const repos = listRepos();
  return (
    repos.find((r) => r.id === idOrKey) ??
    repos.find(
      (r) => r.alias === idOrKey || r.url === idOrKey || `${r.workspace}/${r.repoSlug}` === idOrKey
    )
  );
}

// A repo config to validate credentials against (credentials are global, so
// any watched repo's host works). Returns null if nothing is being watched.
function firstRepoConfig(): RepoConfig | null {
  for (const r of listRepos()) {
    try {
      return toConfig(r);
    } catch {
      /* skip unparseable URLs */
    }
  }
  return null;
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
  sendProgress: ProgressFn
): void {
  // ── Repo list ─────────────────────────────────────────────────────────────
  ipcMain.handle("get-repos", (): RepoSummary[] => {
    return listRepos().map((r) => {
      let host = "";
      try {
        host = parseRepoUrl(r.url).host;
      } catch {
        /* leave host blank for unparseable URLs */
      }
      return { ...r, hasSnapshot: !!r.lastSnapshot, host };
    });
  });

  // ── List available repositories (Add-Repo browser) ───────────────────────────
  ipcMain.handle(
    "list-available-repos",
    async (
      _event,
      args: { host?: string; query?: string }
    ): Promise<{ ok: boolean; repos?: import("../types").AvailableRepo[]; error?: string }> => {
      const creds = getCredentials();
      if (!creds) return { ok: false, error: "No Bitbucket credentials configured." };

      // Resolve the instance to query: an explicit host, else a watched repo on
      // that host (for an exact API base), else the first watched repo.
      let config: RepoConfig | null = null;
      const host = (args.host ?? "").trim();
      if (host) {
        const match = listRepos().find((r) => {
          try {
            return parseRepoUrl(r.url).host === host;
          } catch {
            return false;
          }
        });
        try {
          config = match ? toConfig(match) : baseConfigForHost(host);
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      } else {
        config = firstRepoConfig();
      }

      if (!config) {
        return { ok: false, error: "Enter a Bitbucket host (e.g. bitbucket.org) to browse." };
      }

      try {
        const repos = await listRepositories(creds, config, args.query);
        return { ok: true, repos };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  );

  // ── Add repo ───────────────────────────────────────────────────────────────
  ipcMain.handle(
    "add-repo",
    (
      _event,
      url: string,
      alias?: string,
      branch?: string
    ): { ok: boolean; error?: string } => {
      try {
        const config = parseRepoUrl(url);
        if (alias) config.alias = alias;
        if (branch) config.branch = branch;
        addRepo(config);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  );

  // ── Remove repo ────────────────────────────────────────────────────────────
  ipcMain.handle(
    "remove-repo",
    (_event, id: string): { ok: boolean } => {
      const repo = findWatched(id);
      return { ok: repo ? removeRepoById(repo.id) : false };
    }
  );

  // ── Set branch ─────────────────────────────────────────────────────────────
  ipcMain.handle(
    "set-branch",
    (_event, id: string, branch?: string): { ok: boolean } => {
      const repo = findWatched(id);
      return { ok: repo ? setRepoBranchById(repo.id, branch) : false };
    }
  );

  // ── Clone repo (duplicate the watch entry) ───────────────────────────────────
  ipcMain.handle(
    "clone-repo",
    (_event, id: string): { ok: boolean; id?: string } => {
      const repo = findWatched(id);
      const copy = repo ? cloneRepo(repo.id) : null;
      return copy ? { ok: true, id: copy.id } : { ok: false };
    }
  );

  // ── Archive / unarchive repo ─────────────────────────────────────────────────
  ipcMain.handle(
    "archive-repo",
    (_event, id: string, archived: boolean): { ok: boolean } => {
      const repo = findWatched(id);
      return { ok: repo ? archiveRepo(repo.id, !!archived) : false };
    }
  );

  // ── Reorder repos ────────────────────────────────────────────────────────────
  ipcMain.handle(
    "reorder-repos",
    (_event, orderedIds: string[]): { ok: boolean } => {
      reorderRepos(Array.isArray(orderedIds) ? orderedIds : []);
      return { ok: true };
    }
  );

  // ── List branches (for the branch picker) ───────────────────────────────────
  ipcMain.handle(
    "list-branches",
    async (
      _event,
      id: string
    ): Promise<{ ok: boolean; branches?: string[]; error?: string }> => {
      const creds = getCredentials();
      if (!creds) return { ok: false, error: "No Bitbucket credentials configured." };
      const repo = findWatched(id);
      if (!repo) return { ok: false, error: `Repo not found: ${id}` };
      let config: RepoConfig;
      try {
        config = toConfig(repo);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      try {
        const branches = await listBranches(creds, config);
        return { ok: true, branches };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  );

  // ── Open a URL in the system browser ─────────────────────────────────────────
  ipcMain.handle("open-external", (_event, url: string): void => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });

  // ── Export: save a text/markdown file ────────────────────────────────────────
  ipcMain.handle(
    "export-file",
    async (
      _event,
      args: { content: string; defaultName: string; kind?: "md" | "txt" }
    ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> => {
      try {
        const parent = BrowserWindow.getFocusedWindow();
        const filters =
          args.kind === "md"
            ? [{ name: "Markdown", extensions: ["md"] }]
            : [{ name: "Text", extensions: ["txt"] }];
        const res = await dialog.showSaveDialog(parent ?? undefined!, {
          defaultPath: args.defaultName,
          filters,
        });
        if (res.canceled || !res.filePath) return { ok: false, canceled: true };
        fs.writeFileSync(res.filePath, args.content, "utf-8");
        return { ok: true, path: res.filePath };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  );

  // ── Export: render HTML to a PDF file ────────────────────────────────────────
  ipcMain.handle(
    "export-pdf",
    async (
      _event,
      args: { html: string; defaultName: string }
    ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> => {
      try {
        const parent = BrowserWindow.getFocusedWindow();
        const res = await dialog.showSaveDialog(parent ?? undefined!, {
          defaultPath: args.defaultName,
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (res.canceled || !res.filePath) return { ok: false, canceled: true };
        const pdf = await htmlToPdf(args.html);
        fs.writeFileSync(res.filePath, pdf);
        return { ok: true, path: res.filePath };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  );

  // ── Copy text to the clipboard ───────────────────────────────────────────────
  ipcMain.handle("copy-text", (_event, text: string): { ok: boolean } => {
    clipboard.writeText(typeof text === "string" ? text : String(text));
    return { ok: true };
  });

  // ── Digest webhook config + delivery ─────────────────────────────────────────
  ipcMain.handle("get-webhook", (): { url: string } => ({ url: getDigestWebhook() ?? "" }));

  ipcMain.handle("save-webhook", (_event, url: string): { ok: boolean } => {
    saveDigestWebhook(url ?? "");
    return { ok: true };
  });

  ipcMain.handle(
    "send-webhook",
    async (
      _event,
      args: { url?: string; text: string }
    ): Promise<{ ok: boolean; error?: string }> => {
      const url = (args.url && args.url.trim()) || getDigestWebhook();
      if (!url) return { ok: false, error: "No webhook URL configured." };
      try {
        await axios.post(
          url,
          { text: args.text },
          { timeout: 10000, headers: { "Content-Type": "application/json" } }
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  );

  // ── Credentials ────────────────────────────────────────────────────────────
  ipcMain.handle("has-credentials", (): boolean => {
    return !!getCredentials() && !!getGitHubToken();
  });

  ipcMain.handle("has-github-token", (): boolean => {
    return !!getGitHubToken();
  });

  ipcMain.handle(
    "validate-credentials",
    async (
      _event,
      username: string,
      secret: string
    ): Promise<{ ok: boolean }> => {
      const cfg = firstRepoConfig();
      // Without a watched repo there's no host to validate against; assume ok.
      if (!cfg) return { ok: true };
      const valid = await validateCredentials({ username, secret }, cfg);
      return { ok: valid };
    }
  );

  ipcMain.handle(
    "save-credentials",
    async (
      _event,
      username: string,
      secret: string,
      githubToken: string
    ): Promise<{ ok: boolean; error?: string }> => {
      const cfg = firstRepoConfig();
      // Validate against a watched repo's host when one exists; otherwise save
      // as-is (credentials will be exercised on the first report).
      if (cfg) {
        const valid = await validateCredentials({ username, secret }, cfg);
        if (!valid) {
          return {
            ok: false,
            error: `Invalid credentials for ${cfg.host}. Check your username/token (leave username blank to use a Bearer token).`,
          };
        }
      }
      saveCredentials(username, secret);
      if (githubToken) saveGitHubToken(githubToken);
      return { ok: true };
    }
  );

  // ── Run full report ────────────────────────────────────────────────────────
  ipcMain.handle(
    "run-report",
    async (
      _event,
      urlOrAlias: string
    ): Promise<{ ok: boolean; result?: AnalysisResult; error?: string }> => {
      const creds = getCredentials();
      if (!creds) {
        return { ok: false, error: "No Bitbucket credentials configured. Please set up credentials first." };
      }
      if (!getGitHubToken()) {
        return { ok: false, error: "No GitHub token configured. Add your GitHub PAT in Credentials." };
      }

      // Resolve to a watched entry by id; if an unwatched URL was passed,
      // create an entry for it so the snapshot has somewhere to live.
      let repo = findWatched(urlOrAlias);
      if (!repo) {
        try {
          repo = addRepo(parseRepoUrl(urlOrAlias));
        } catch {
          return { ok: false, error: `Repo not found: ${urlOrAlias}` };
        }
      }

      let config: RepoConfig;
      try {
        config = toConfig(repo);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }

      try {
        sendProgress("Fetching data from Bitbucket…");
        const data = await fetchSpecKitData(creds, config);

        sendProgress("Analyzing…");
        const analysis = await analyzeRepo(data, config);

        saveSnapshotById(repo.id, analysis, data);
        sendProgress("Done.");
        return { ok: true, result: analysis };
      } catch (e: unknown) {
        const msg = (e as Error).message ?? String(e);
        if (msg.includes("401") || msg.includes("403")) {
          return { ok: false, error: "Authentication failed. Update your credentials." };
        }
        if (msg.includes("404")) {
          return { ok: false, error: `Repo or .specify/ not found: ${config.url}` };
        }
        return { ok: false, error: msg };
      }
    }
  );

  // ── Run diff ───────────────────────────────────────────────────────────────
  ipcMain.handle(
    "run-diff",
    async (
      _event,
      urlOrAlias: string
    ): Promise<{ ok: boolean; result?: DiffResult; error?: string }> => {
      const creds = getCredentials();
      if (!creds) {
        return { ok: false, error: "No Bitbucket credentials configured." };
      }
      if (!getGitHubToken()) {
        return { ok: false, error: "No GitHub token configured. Add your GitHub PAT in Credentials." };
      }

      const repo = findWatched(urlOrAlias);
      if (!repo) {
        return { ok: false, error: `Repo not found: ${urlOrAlias}` };
      }

      let config: RepoConfig;
      try {
        config = toConfig(repo);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }

      const lastSnapshot = getLastSnapshotById(repo.id);

      try {
        sendProgress("Fetching data from Bitbucket…");
        const data = await fetchSpecKitData(creds, config);

        if (!lastSnapshot) {
          sendProgress("No previous snapshot — running full report as baseline…");
          const analysis = await analyzeRepo(data, config);
          saveSnapshotById(repo.id, analysis, data);
          sendProgress("Done.");
          // Return a synthetic diff with no changes
          return {
            ok: true,
            result: {
              current: analysis,
              previous: {
                timestamp: analysis.generatedAt,
                analysis,
                specMd: data.specMd,
                planMd: data.planMd,
                taskSummaries: data.tasks.map((t) => `[${t.status}] ${t.title}`),
              },
              changes: ["First run — no previous snapshot to compare against."],
              newOpenQuestions: [],
              resolvedQuestions: [],
              completionDelta: 0,
              stalledChanged: false,
            },
          };
        }

        sendProgress("Analyzing changes…");
        const diff = await analyzeRepoDiff(data, config, lastSnapshot);
        saveSnapshotById(repo.id, diff.current, data);
        sendProgress("Done.");
        return { ok: true, result: diff };
      } catch (e: unknown) {
        return { ok: false, error: (e as Error).message ?? String(e) };
      }
    }
  );

  // ── Run all repos ──────────────────────────────────────────────────────────
  ipcMain.handle(
    "run-all-reports",
    async (): Promise<{ results: Array<{ urlOrAlias: string; ok: boolean; result?: AnalysisResult; error?: string }> }> => {
      // Archived repos are skipped by Refresh All.
      const repos = listRepos().filter((r) => !r.archived);
      const results = [];
      for (const r of repos) {
        const key = r.id;
        sendProgress(`Running report for ${r.alias ?? `${r.workspace}/${r.repoSlug}`}…`);
        const creds = getCredentials();
        if (!creds || !getGitHubToken()) {
          results.push({ urlOrAlias: key, ok: false, error: "Credentials not configured." });
          continue;
        }
        try {
          const config = toConfig(r);
          const data = await fetchSpecKitData(creds, config);
          const analysis = await analyzeRepo(data, config);
          saveSnapshotById(r.id, analysis, data);
          results.push({ urlOrAlias: key, ok: true, result: analysis });
        } catch (e) {
          results.push({ urlOrAlias: key, ok: false, error: (e as Error).message });
        }
      }
      sendProgress("All done.");
      return { results };
    }
  );
}
