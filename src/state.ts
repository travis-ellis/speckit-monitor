import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  StateFile,
  WatchedRepo,
  RepoConfig,
  AnalysisResult,
  StoredSnapshot,
  SpecKitData,
  BitbucketCredentials,
  HistoryPoint,
} from "./types";
import { encryptSecret, decryptSecret } from "./secret-store";

// In portable mode (packaged app), store data next to the exe.
// PORTABLE_EXECUTABLE_DIR is set by electron-builder's portable target.
// SPECKIT_DATA_DIR can also be set manually for testing.
const STATE_DIR = process.env.SPECKIT_DATA_DIR
  ?? (process.env.PORTABLE_EXECUTABLE_DIR
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, ".speckit-monitor")
    : path.join(os.homedir(), ".speckit-monitor"));
const STATE_FILE = path.join(STATE_DIR, "state.json");

function ensureDir(): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function readState(): StateFile {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) {
    return { repos: [] };
  }
  let state: StateFile;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as StateFile;
  } catch {
    return { repos: [] };
  }
  return migrateRepoIds(migrateSecrets(state));
}

// Unique id for a watched repo. Random suffix guards against collisions when
// several clones are created within the same millisecond.
function genId(): string {
  return "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Back-fill ids for repos written by versions before `id` existed.
function migrateRepoIds(state: StateFile): StateFile {
  let dirty = false;
  for (const r of state.repos) {
    if (!r.id) {
      r.id = genId();
      dirty = true;
    }
  }
  if (dirty) writeState(state);
  return state;
}

function writeState(state: StateFile): void {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// One-time, transparent upgrade of any plaintext secrets written by older
// versions: encrypt them with DPAPI and strip the cleartext from disk.
function migrateSecrets(state: StateFile): StateFile {
  let dirty = false;
  if (state.credentials && !state.credentialsEnc) {
    try {
      state.credentialsEnc = encryptSecret(JSON.stringify(normalizeCreds(state.credentials)));
      delete state.credentials;
      dirty = true;
    } catch {
      // Encryption unavailable — leave as-is rather than lose credentials.
    }
  }
  if (state.githubToken && !state.githubTokenEnc) {
    try {
      state.githubTokenEnc = encryptSecret(state.githubToken);
      delete state.githubToken;
      dirty = true;
    } catch {
      // Encryption unavailable — leave as-is.
    }
  }
  if (dirty) writeState(state);
  return state;
}

// Decrypted-secret memo, keyed by ciphertext so a re-save invalidates it.
// Avoids spawning a PowerShell/DPAPI call on every credential read.
let credCache: { enc: string; value: BitbucketCredentials } | null = null;
let tokenCache: { enc: string; value: string } | null = null;

// Accept both the current { username, secret } shape and the legacy
// { username, appPassword } shape written by older versions.
function normalizeCreds(raw: {
  username?: string;
  secret?: string;
  appPassword?: string;
}): BitbucketCredentials {
  return {
    username: raw.username ?? "",
    secret: raw.secret ?? raw.appPassword ?? "",
  };
}

export function getCredentials(): BitbucketCredentials | undefined {
  const { credentialsEnc } = readState();
  if (!credentialsEnc) return undefined;
  if (credCache && credCache.enc === credentialsEnc) return credCache.value;
  try {
    const value = normalizeCreds(JSON.parse(decryptSecret(credentialsEnc)));
    credCache = { enc: credentialsEnc, value };
    return value;
  } catch {
    return undefined;
  }
}

export function saveCredentials(username: string, secret: string): void {
  const state = readState();
  state.credentialsEnc = encryptSecret(JSON.stringify({ username, secret }));
  delete state.credentials;
  credCache = null;
  writeState(state);
}

export function getGitHubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const { githubTokenEnc } = readState();
  if (!githubTokenEnc) return undefined;
  if (tokenCache && tokenCache.enc === githubTokenEnc) return tokenCache.value;
  try {
    const value = decryptSecret(githubTokenEnc);
    tokenCache = { enc: githubTokenEnc, value };
    return value;
  } catch {
    return undefined;
  }
}

export function saveGitHubToken(token: string): void {
  const state = readState();
  state.githubTokenEnc = encryptSecret(token);
  delete state.githubToken;
  tokenCache = null;
  writeState(state);
}

// ── Digest webhook (Slack/Teams incoming webhook URL) ────────────────────────
export function getDigestWebhook(): string | undefined {
  const { digestWebhookEnc } = readState();
  if (!digestWebhookEnc) return undefined;
  try {
    return decryptSecret(digestWebhookEnc);
  } catch {
    return undefined;
  }
}

export function saveDigestWebhook(url: string): void {
  const state = readState();
  if (url && url.trim()) {
    state.digestWebhookEnc = encryptSecret(url.trim());
  } else {
    delete state.digestWebhookEnc;
  }
  writeState(state);
}

// ── Run history (for trend charts) ───────────────────────────────────────────
const HISTORY_CAP = 500;

// Append a lightweight history point derived from an analysis result, capping
// the series length. Mutates the repo in place; caller persists.
function appendHistory(repo: WatchedRepo, analysis: AnalysisResult): void {
  const bd = analysis.completionBreakdown;
  const point: HistoryPoint = {
    timestamp: new Date().toISOString(),
    completionPercentage: analysis.completionPercentage,
    tasksCompleted: bd.tasksCompleted,
    tasksTotal: bd.tasksTotal,
    openQuestionsTotal: bd.openQuestionsTotal,
    openQuestionsResolved: bd.openQuestionsResolved,
  };
  if (!repo.history) repo.history = [];
  repo.history.push(point);
  if (repo.history.length > HISTORY_CAP) {
    repo.history = repo.history.slice(repo.history.length - HISTORY_CAP);
  }
}

export function listRepos(): WatchedRepo[] {
  return readState().repos;
}

export function addRepo(config: RepoConfig): WatchedRepo {
  const state = readState();
  const existing = state.repos.find(
    (r) => r.workspace === config.workspace && r.repoSlug === config.repoSlug
  );
  if (existing) {
    if (config.alias) existing.alias = config.alias;
    // Re-adding the same repo with a branch updates the tracked branch
    // (so users can switch features without removing + re-adding).
    if (config.branch !== undefined) existing.branch = config.branch || undefined;
    writeState(state);
    return existing;
  }
  const repo: WatchedRepo = {
    id: genId(),
    url: config.url,
    workspace: config.workspace,
    repoSlug: config.repoSlug,
    alias: config.alias,
    branch: config.branch || undefined,
  };
  state.repos.push(repo);
  writeState(state);
  return repo;
}

// Duplicate a watched repo into a new, independent entry (its own id, no
// snapshot). Used by the GUI "Clone" action so the same repo can be tracked on
// another branch. The copy is inserted right after its source.
export function cloneRepo(id: string): WatchedRepo | null {
  const state = readState();
  const idx = state.repos.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const src = state.repos[idx];
  const baseAlias = src.alias ?? `${src.workspace}/${src.repoSlug}`;
  const copy: WatchedRepo = {
    id: genId(),
    url: src.url,
    workspace: src.workspace,
    repoSlug: src.repoSlug,
    alias: `${baseAlias} (copy)`,
    branch: src.branch,
  };
  state.repos.splice(idx + 1, 0, copy);
  writeState(state);
  return copy;
}

export function removeRepoById(id: string): boolean {
  const state = readState();
  const before = state.repos.length;
  state.repos = state.repos.filter((r) => r.id !== id);
  if (state.repos.length === before) return false;
  writeState(state);
  return true;
}

export function setRepoBranchById(id: string, branch: string | undefined): boolean {
  const state = readState();
  const repo = state.repos.find((r) => r.id === id);
  if (!repo) return false;
  repo.branch = branch && branch.trim() ? branch.trim() : undefined;
  writeState(state);
  return true;
}

export function archiveRepo(id: string, archived: boolean): boolean {
  const state = readState();
  const repo = state.repos.find((r) => r.id === id);
  if (!repo) return false;
  repo.archived = archived ? true : undefined;
  writeState(state);
  return true;
}

// Reorder repos to match the given id order. Any repos not present in the list
// (e.g. archived ones, which aren't shown in the draggable list) are kept and
// appended in their existing relative order.
export function reorderRepos(orderedIds: string[]): void {
  const state = readState();
  const byId = new Map(state.repos.map((r) => [r.id, r]));
  const next: WatchedRepo[] = [];
  for (const oid of orderedIds) {
    const r = byId.get(oid);
    if (r) {
      next.push(r);
      byId.delete(oid);
    }
  }
  for (const r of byId.values()) next.push(r);
  state.repos = next;
  writeState(state);
}

export function getRepoById(id: string): WatchedRepo | undefined {
  return readState().repos.find((r) => r.id === id);
}

export function saveSnapshotById(
  id: string,
  analysis: AnalysisResult,
  data: SpecKitData
): void {
  const state = readState();
  const repo = state.repos.find((r) => r.id === id);
  if (!repo) return;
  repo.lastSnapshot = {
    timestamp: new Date().toISOString(),
    analysis,
    specMd: data.specMd,
    planMd: data.planMd,
    taskSummaries: data.tasks.map((t) => `[${t.status}] ${t.title}`),
  };
  appendHistory(repo, analysis);
  writeState(state);
}

export function getLastSnapshotById(id: string): StoredSnapshot | undefined {
  return readState().repos.find((r) => r.id === id)?.lastSnapshot;
}

export function removeRepo(urlOrAlias: string): boolean {
  const state = readState();
  const before = state.repos.length;
  state.repos = state.repos.filter(
    (r) =>
      r.url !== urlOrAlias &&
      r.alias !== urlOrAlias &&
      `${r.workspace}/${r.repoSlug}` !== urlOrAlias
  );
  if (state.repos.length === before) return false;
  writeState(state);
  return true;
}

export function getRepo(urlOrAlias: string): WatchedRepo | undefined {
  const state = readState();
  return state.repos.find(
    (r) =>
      r.url === urlOrAlias ||
      r.alias === urlOrAlias ||
      `${r.workspace}/${r.repoSlug}` === urlOrAlias
  );
}

export function saveSnapshot(
  config: RepoConfig,
  analysis: AnalysisResult,
  data: SpecKitData
): void {
  const state = readState();
  const repo = state.repos.find(
    (r) => r.workspace === config.workspace && r.repoSlug === config.repoSlug
  );
  if (!repo) return;

  const snapshot: StoredSnapshot = {
    timestamp: new Date().toISOString(),
    analysis,
    specMd: data.specMd,
    planMd: data.planMd,
    taskSummaries: data.tasks.map((t) => `[${t.status}] ${t.title}`),
  };
  repo.lastSnapshot = snapshot;
  appendHistory(repo, analysis);
  writeState(state);
}

export function getLastSnapshot(config: RepoConfig): StoredSnapshot | undefined {
  const state = readState();
  const repo = state.repos.find(
    (r) => r.workspace === config.workspace && r.repoSlug === config.repoSlug
  );
  return repo?.lastSnapshot;
}
