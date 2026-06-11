import axios, { AxiosInstance } from "axios";
import { BitbucketCredentials, RepoConfig, SpecKitData, SpecKitTask, AvailableRepo } from "./types";

const CLOUD_API = "https://api.bitbucket.org/2.0";

// ── URL parsing ──────────────────────────────────────────────────────────────

function stripGit(slug: string): string {
  return slug.replace(/\.git$/i, "");
}

// Encode a path while preserving "/" separators between segments.
function encodePath(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * Parse a Bitbucket repo URL into a RepoConfig. Supports both Bitbucket Cloud
 * (bitbucket.org) and self-hosted Bitbucket Server / Data Center on any domain.
 *
 * Accepted forms include:
 *   Cloud:   https://bitbucket.org/{workspace}/{repo}[.git]
 *            git@bitbucket.org:{workspace}/{repo}[.git]
 *   Server:  https://{host}[/context]/projects/{KEY}/repos/{repo}[/browse...]
 *            https://{host}[/context]/users/{user}/repos/{repo}[/browse...]
 *            https://{host}[/context]/scm/{KEY}/{repo}.git   (KEY may be ~user)
 *            ssh://git@{host}[:port]/{KEY}/{repo}.git
 *            git@{host}:{KEY}/{repo}.git
 */
export function parseRepoUrl(input: string): RepoConfig {
  const url = input.trim();

  // ── Bitbucket Cloud ──
  const cloudHttps = url.match(/^https?:\/\/bitbucket\.org\/([^/]+)\/([^/?#]+)/i);
  const cloudSsh = url.match(/^git@bitbucket\.org:([^/]+)\/([^/?#]+)/i);
  const cloud = cloudHttps || cloudSsh;
  if (cloud) {
    return {
      url,
      kind: "cloud",
      host: "bitbucket.org",
      apiBaseUrl: CLOUD_API,
      workspace: cloud[1],
      repoSlug: stripGit(cloud[2]),
    };
  }

  // ── Bitbucket Server / Data Center ──
  // Web "browse" URL: .../projects/{KEY}/repos/{SLUG}[/browse...]
  const srvProjects = url.match(
    /^(https?):\/\/([^/]+)((?:\/[^/]+)*?)\/projects\/([^/]+)\/repos\/([^/?#]+)/i
  );
  if (srvProjects) {
    return makeServerConfig(url, srvProjects[1], srvProjects[2], srvProjects[3], srvProjects[4], srvProjects[5]);
  }

  // Personal repo web URL: .../users/{USER}/repos/{SLUG}[/browse...]
  const srvUsers = url.match(
    /^(https?):\/\/([^/]+)((?:\/[^/]+)*?)\/users\/([^/]+)\/repos\/([^/?#]+)/i
  );
  if (srvUsers) {
    return makeServerConfig(url, srvUsers[1], srvUsers[2], srvUsers[3], `~${srvUsers[4]}`, srvUsers[5]);
  }

  // HTTP(S) clone URL: .../scm/{KEY}/{SLUG}.git   (KEY may be ~user)
  const srvScm = url.match(
    /^(https?):\/\/([^/]+)((?:\/[^/]+)*?)\/scm\/([^/]+)\/([^/?#]+)/i
  );
  if (srvScm) {
    return makeServerConfig(url, srvScm[1], srvScm[2], srvScm[3], srvScm[4], srvScm[5]);
  }

  // SSH clone: ssh://git@{host}[:port]/{KEY}/{SLUG}.git
  const srvSshUrl = url.match(/^ssh:\/\/git@([^/:]+)(?::\d+)?\/([^/]+)\/([^/?#]+)/i);
  if (srvSshUrl) {
    return makeServerConfig(url, "https", srvSshUrl[1], "", srvSshUrl[2], srvSshUrl[3]);
  }

  // SCP-style SSH: git@{host}:{KEY}/{SLUG}.git
  const srvScp = url.match(/^git@([^/:]+):([^/]+)\/([^/?#]+)/i);
  if (srvScp) {
    return makeServerConfig(url, "https", srvScp[1], "", srvScp[2], srvScp[3]);
  }

  throw new Error(`Cannot parse Bitbucket URL: ${input}`);
}

function makeServerConfig(
  url: string,
  scheme: string,
  host: string,
  context: string | undefined,
  projectKey: string,
  slug: string
): RepoConfig {
  // SSH hosts carry an SSH port (e.g. :7999); never put that on the HTTP API.
  const httpHost = host.replace(/:\d+$/, "");
  const ctx = context && context !== "/" ? context : "";
  return {
    url,
    kind: "server",
    host: httpHost,
    apiBaseUrl: `${scheme}://${httpHost}${ctx}/rest/api/1.0`,
    workspace: projectKey,
    repoSlug: stripGit(slug),
  };
}

// ── HTTP client ──────────────────────────────────────────────────────────────

function makeClient(creds: BitbucketCredentials, config: RepoConfig): AxiosInstance {
  const base = { baseURL: config.apiBaseUrl, timeout: 15000 };
  // A username means Basic auth (Cloud app passwords, or Server user+token).
  // No username means a Bearer token (Server HTTP access token).
  if (creds.username && creds.username.trim()) {
    return axios.create({
      ...base,
      auth: { username: creds.username, password: creds.secret },
    });
  }
  return axios.create({
    ...base,
    headers: { Authorization: `Bearer ${creds.secret}` },
  });
}

// ── Cloud fetchers (API v2.0) ─────────────────────────────────────────────────

// `ref` is a branch name, tag, or SHA. "HEAD" resolves to the default branch.
async function cloudFile(
  client: AxiosInstance,
  ws: string,
  slug: string,
  ref: string,
  path: string
): Promise<string | null> {
  try {
    const res = await client.get(
      `/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(slug)}/src/${encodeURIComponent(ref)}/${encodePath(path)}`
    );
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  } catch {
    return null;
  }
}

async function cloudDir(
  client: AxiosInstance,
  ws: string,
  slug: string,
  ref: string,
  path: string
): Promise<string[]> {
  try {
    const res = await client.get(
      `/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(slug)}/src/${encodeURIComponent(ref)}/${encodePath(path)}`,
      { params: { pagelen: 100 } }
    );
    if (res.data?.values) {
      return res.data.values
        .filter((v: { type: string }) => v.type === "commit_file")
        .map((v: { path: string }) => v.path as string);
    }
    return [];
  } catch {
    return [];
  }
}

// Subdirectory names (not paths) at a given path — used to discover the
// feature folders under `specs/`.
async function cloudSubdirs(
  client: AxiosInstance,
  ws: string,
  slug: string,
  ref: string,
  path: string
): Promise<string[]> {
  try {
    const res = await client.get(
      `/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(slug)}/src/${encodeURIComponent(ref)}/${encodePath(path)}`,
      { params: { pagelen: 100 } }
    );
    if (res.data?.values) {
      return res.data.values
        .filter((v: { type: string }) => v.type === "commit_directory")
        .map((v: { path: string }) => (v.path as string).split("/").pop() ?? "")
        .filter((name: string) => name.length > 0);
    }
    return [];
  } catch {
    return [];
  }
}

async function cloudLastCommit(
  client: AxiosInstance,
  ws: string,
  slug: string,
  ref: string
): Promise<{ date: string; message: string } | null> {
  try {
    // /commits/{ref} returns commits reachable from the ref. "HEAD" picks the
    // default branch — same behavior as the old plain /commits endpoint.
    const res = await client.get(
      `/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(slug)}/commits/${encodeURIComponent(ref)}`,
      { params: { pagelen: 1 } }
    );
    const commit = res.data?.values?.[0];
    if (!commit) return null;
    return {
      date: commit.date,
      message: (commit.message as string).split("\n")[0].trim(),
    };
  } catch {
    return null;
  }
}

// ── Server fetchers (REST API v1.0) ───────────────────────────────────────────

function serverRepoPath(config: RepoConfig): string {
  return `/projects/${encodeURIComponent(config.workspace)}/repos/${encodeURIComponent(config.repoSlug)}`;
}

interface BrowseLine {
  text: string;
}
interface BrowseResponse {
  lines?: BrowseLine[];
  isLastPage?: boolean;
  size?: number;
  start?: number;
  children?: {
    values?: Array<{ type: string; path: { name: string; toString?: string } }>;
    isLastPage?: boolean;
    nextPageStart?: number;
  };
}

// Server `at` parameter: branch name, tag, or commit. Passed as the full ref
// (refs/heads/{branch}) when a branch is specified — safer than a bare name
// when branches/tags can collide. Undefined means "default branch".
function atParam(branch: string | undefined): Record<string, string> {
  return branch ? { at: `refs/heads/${branch}` } : {};
}

async function serverFile(
  client: AxiosInstance,
  config: RepoConfig,
  branch: string | undefined,
  path: string
): Promise<string | null> {
  try {
    const lines: string[] = [];
    let start = 0;
    // The browse endpoint returns file content as paginated arrays of lines.
    for (;;) {
      const res = await client.get<BrowseResponse>(
        `${serverRepoPath(config)}/browse/${encodePath(path)}`,
        { params: { limit: 5000, start, ...atParam(branch) } }
      );
      const data = res.data;
      if (!data || !Array.isArray(data.lines)) {
        // Not a file (e.g. a directory) or empty response.
        return lines.length > 0 ? lines.join("\n") : null;
      }
      for (const l of data.lines) lines.push(l.text ?? "");
      if (data.isLastPage !== false) break;
      start += data.lines.length;
      if (data.lines.length === 0) break;
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

async function serverDir(
  client: AxiosInstance,
  config: RepoConfig,
  branch: string | undefined,
  path: string
): Promise<string[]> {
  try {
    const files: string[] = [];
    let start = 0;
    for (;;) {
      const res = await client.get<BrowseResponse>(
        `${serverRepoPath(config)}/browse/${encodePath(path)}`,
        { params: { limit: 1000, start, ...atParam(branch) } }
      );
      const children = res.data?.children;
      const values = children?.values;
      if (!values) break;
      for (const child of values) {
        if (child.type === "FILE" && child.path?.name) {
          files.push(`${path}/${child.path.name}`);
        }
      }
      if (children.isLastPage !== false || typeof children.nextPageStart !== "number") break;
      start = children.nextPageStart;
    }
    return files;
  } catch {
    return [];
  }
}

async function serverSubdirs(
  client: AxiosInstance,
  config: RepoConfig,
  branch: string | undefined,
  path: string
): Promise<string[]> {
  try {
    const dirs: string[] = [];
    let start = 0;
    for (;;) {
      const res = await client.get<BrowseResponse>(
        `${serverRepoPath(config)}/browse/${encodePath(path)}`,
        { params: { limit: 1000, start, ...atParam(branch) } }
      );
      const children = res.data?.children;
      const values = children?.values;
      if (!values) break;
      for (const child of values) {
        if (child.type === "DIRECTORY" && child.path?.name) {
          dirs.push(child.path.name);
        }
      }
      if (children.isLastPage !== false || typeof children.nextPageStart !== "number") break;
      start = children.nextPageStart;
    }
    return dirs;
  } catch {
    return [];
  }
}

async function serverLastCommit(
  client: AxiosInstance,
  config: RepoConfig,
  branch: string | undefined
): Promise<{ date: string; message: string } | null> {
  try {
    const res = await client.get(`${serverRepoPath(config)}/commits`, {
      params: { limit: 1, ...(branch ? { until: `refs/heads/${branch}` } : {}) },
    });
    const commit = res.data?.values?.[0];
    if (!commit) return null;
    // Server returns epoch milliseconds in authorTimestamp.
    const ts = commit.authorTimestamp ?? commit.committerTimestamp;
    const date = ts ? new Date(ts).toISOString() : new Date().toISOString();
    return {
      date,
      message: ((commit.message as string) ?? "").split("\n")[0].trim(),
    };
  } catch {
    return null;
  }
}

// ── Unified fetchers ───────────────────────────────────────────────────────────

// On Cloud the ref must be a string; "HEAD" resolves to the default branch.
// On Server, undefined means "default branch" (no `at` parameter).
function cloudRef(branch: string | undefined): string {
  return branch && branch.trim() ? branch.trim() : "HEAD";
}

function fetchFileContent(
  client: AxiosInstance,
  config: RepoConfig,
  path: string
): Promise<string | null> {
  return config.kind === "cloud"
    ? cloudFile(client, config.workspace, config.repoSlug, cloudRef(config.branch), path)
    : serverFile(client, config, config.branch, path);
}

function fetchDirectoryListing(
  client: AxiosInstance,
  config: RepoConfig,
  path: string
): Promise<string[]> {
  return config.kind === "cloud"
    ? cloudDir(client, config.workspace, config.repoSlug, cloudRef(config.branch), path)
    : serverDir(client, config, config.branch, path);
}

function fetchSubdirs(
  client: AxiosInstance,
  config: RepoConfig,
  path: string
): Promise<string[]> {
  return config.kind === "cloud"
    ? cloudSubdirs(client, config.workspace, config.repoSlug, cloudRef(config.branch), path)
    : serverSubdirs(client, config, config.branch, path);
}

function fetchLastCommit(
  client: AxiosInstance,
  config: RepoConfig
): Promise<{ date: string; message: string } | null> {
  return config.kind === "cloud"
    ? cloudLastCommit(client, config.workspace, config.repoSlug, cloudRef(config.branch))
    : serverLastCommit(client, config, config.branch);
}

// ── SpecKit parsing helpers ────────────────────────────────────────────────────

// SpecKit's tasks.md is a single markdown file of checklist items, often
// grouped under `## Phase X` headings. Each task line looks like:
//
//   - [ ] T001 Do the thing
//   - [x] T002 [P] Parallel-eligible task
//
// Parse each checklist line into a SpecKitTask. Section headings (## …) are
// carried into the title for context where present.
//
// Some tasks.md files document the task-line *format* as an example checkbox,
// e.g. "- [ ] [TaskID] [P?] [Story?] [repo:xxx|external:yyy|qtest|e2e]?
// Description". Those legend lines use literal placeholder tokens that never
// appear in real tasks, so we skip them (and anything under a Format/Legend
// heading) rather than counting them as work.
const TASK_TEMPLATE_RE = /\[TaskID\]|\[P\?\]|\[Story\?\]|\[Format\]|\[repo:[^\]]*\|/i;
const NON_TASK_SECTION_RE = /^(?:task\s*)?(?:format|legend|conventions?|key)\b/i;

function parseTasksMd(content: string | null): SpecKitTask[] {
  if (!content) return [];

  const tasks: SpecKitTask[] = [];
  let currentSection: string | undefined;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();

    const sectionMatch = line.match(/^##\s+(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    const checkMatch = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
    if (!checkMatch) continue;

    const checked = checkMatch[1].toLowerCase() === "x";
    const body = checkMatch[2].trim();

    // Skip format/legend template lines and items under a Format/Legend
    // section — they describe the task shape, they aren't real tasks.
    if (TASK_TEMPLATE_RE.test(body)) continue;
    if (currentSection && NON_TASK_SECTION_RE.test(currentSection)) continue;

    // Optional task ID prefix like "T001" or "T123:".
    const idMatch = body.match(/^(T\d+)[:\s]\s*(.+)$/);
    const id = idMatch?.[1];
    const title = idMatch?.[2].trim() ?? body;

    tasks.push({
      filename: id ?? `task-${tasks.length + 1}`,
      title: currentSection ? `[${currentSection}] ${title}` : title,
      status: checked ? "completed" : "pending",
    });
  }

  return tasks;
}

// Choose which specs/<feature> folder to monitor. SpecKit names feature
// folders like `001-some-feature`, matching the branch. Preference order:
//   1. Folder name that equals or starts with the branch name.
//   2. Highest-numbered folder (lexicographic on the leading number).
//   3. First folder in the list.
function pickActiveFeature(
  folders: string[],
  branch: string | undefined
): string | null {
  if (folders.length === 0) return null;

  if (branch) {
    const normBranch = branch.trim();
    const exact = folders.find((f) => f === normBranch);
    if (exact) return exact;
    const prefix = folders.find((f) => normBranch.startsWith(f) || f.startsWith(normBranch));
    if (prefix) return prefix;
  }

  const numbered = folders
    .map((f) => ({ name: f, num: parseInt(f.match(/^(\d+)/)?.[1] ?? "-1", 10) }))
    .filter((x) => x.num >= 0)
    .sort((a, b) => b.num - a.num);
  if (numbered.length > 0) return numbered[0].name;

  return folders[0];
}

export async function fetchSpecKitData(
  creds: BitbucketCredentials,
  config: RepoConfig
): Promise<SpecKitData> {
  const client = makeClient(creds, config);

  // The constitution and the specs/ feature folders are independent — fetch
  // them in parallel with the last-commit lookup.
  const [constitutionMd, featureFolders, lastCommit] = await Promise.all([
    fetchFileContent(client, config, ".specify/memory/constitution.md"),
    fetchSubdirs(client, config, "specs"),
    fetchLastCommit(client, config),
  ]);

  const active = pickActiveFeature(featureFolders, config.branch);

  // Two supported SpecKit layouts:
  //   1. Per-feature:  specs/<NNN-feature>/{spec,plan,tasks}.md
  //   2. Flat:         specs/{spec,plan,tasks}.md   (single-feature repos)
  // Try the picked feature folder first (when one exists), then fall back to
  // the flat layout directly under specs/. The first base that yields any of
  // the three files wins, so an empty feature folder won't mask flat files.
  const candidateBases: string[] = [];
  if (active) candidateBases.push(`specs/${active}`);
  candidateBases.push("specs");

  let specMd: string | null = null;
  let planMd: string | null = null;
  let tasksMd: string | null = null;
  let checklistsMd: string | null = null;

  for (const base of candidateBases) {
    const [s, p, t, c] = await Promise.all([
      fetchFileContent(client, config, `${base}/spec.md`),
      fetchFileContent(client, config, `${base}/plan.md`),
      fetchFileContent(client, config, `${base}/tasks.md`),
      fetchFileContent(client, config, `${base}/checklists.md`),
    ]);
    if (s || p || t) {
      specMd = s;
      planMd = p;
      tasksMd = t;
      checklistsMd = c;
      break;
    }
  }

  // Surface a clear, diagnostic error rather than silently producing a 0%
  // report. We treat "no spec/plan/tasks" as a failure EVEN when a constitution
  // exists — a constitution is committed on every branch and isn't enough to
  // monitor, so finding only it almost always means the feature files aren't
  // where we looked (wrong path, wrong branch, or a fetch that failed and was
  // swallowed). The message reports exactly what was and wasn't found.
  if (!specMd && !planMd && !tasksMd) {
    const branchLabel = config.branch ? `branch "${config.branch}"` : "the default branch";
    const triedPaths = candidateBases.map((b) => `${b}/{spec,plan,tasks}.md`).join("  or  ");
    const subdirNote = featureFolders.length
      ? `Subfolders detected under specs/: ${featureFolders.join(", ")}.`
      : `No subfolders detected under specs/.`;
    const constNote = constitutionMd
      ? `.specify/memory/constitution.md WAS found (so credentials and the branch are valid), but no feature spec files were located.`
      : `.specify/memory/constitution.md was also not found.`;
    throw new Error(
      `No spec.md / plan.md / tasks.md found on ${branchLabel}. Tried: ${triedPaths}. ${subdirNote} ${constNote} Verify the files are committed on this branch at that path.`
    );
  }

  const tasks = parseTasksMd(tasksMd);

  let daysSinceLastCommit: number | null = null;
  if (lastCommit) {
    const commitDate = new Date(lastCommit.date);
    const now = new Date();
    daysSinceLastCommit = Math.floor(
      (now.getTime() - commitDate.getTime()) / (1000 * 60 * 60 * 24)
    );
  }

  return {
    specMd,
    planMd,
    constitutionMd,
    checklistsMd,
    tasks,
    lastCommitDate: lastCommit?.date ?? null,
    lastCommitMessage: lastCommit?.message ?? null,
    daysSinceLastCommit,
  };
}

/**
 * Lightweight credential check against a known repo's host. `config` supplies
 * the host/kind/auth context; we hit a cheap authenticated endpoint and treat
 * any 2xx as success.
 */
export async function validateCredentials(
  creds: BitbucketCredentials,
  config: RepoConfig
): Promise<boolean> {
  const client = makeClient(creds, config);
  try {
    if (config.kind === "cloud") {
      await client.get("/user");
    } else {
      await client.get("/repos", { params: { limit: 1 } });
    }
    return true;
  } catch {
    return false;
  }
}

// List the repo's branch names. Used by the GUI branch picker. Returns an
// empty array on failure rather than throwing, so the picker can still offer
// the "default branch" choice.
export async function listBranches(
  creds: BitbucketCredentials,
  config: RepoConfig
): Promise<string[]> {
  const client = makeClient(creds, config);
  return config.kind === "cloud"
    ? cloudBranches(client, config)
    : serverBranches(client, config);
}

async function cloudBranches(
  client: AxiosInstance,
  config: RepoConfig
): Promise<string[]> {
  const names: string[] = [];
  // First page is a relative path; subsequent pages come back as absolute
  // `next` URLs which axios uses directly.
  let url: string =
    `/repositories/${encodeURIComponent(config.workspace)}/${encodeURIComponent(config.repoSlug)}` +
    `/refs/branches?pagelen=100&sort=name`;
  try {
    for (let guard = 0; guard < 20 && url; guard++) {
      const res = await client.get(url);
      for (const v of res.data?.values ?? []) {
        if (v?.name) names.push(v.name as string);
      }
      url = (res.data?.next as string) ?? "";
    }
  } catch {
    /* return whatever we managed to collect */
  }
  return names;
}

async function serverBranches(
  client: AxiosInstance,
  config: RepoConfig
): Promise<string[]> {
  const names: string[] = [];
  let start = 0;
  try {
    for (let guard = 0; guard < 50; guard++) {
      const res = await client.get(`${serverRepoPath(config)}/branches`, {
        params: { limit: 100, start },
      });
      for (const v of res.data?.values ?? []) {
        const n = (v?.displayId ?? v?.id) as string | undefined;
        if (n) names.push(n.replace(/^refs\/heads\//, ""));
      }
      if (res.data?.isLastPage !== false || typeof res.data?.nextPageStart !== "number") break;
      start = res.data.nextPageStart;
    }
  } catch {
    /* return whatever we managed to collect */
  }
  return names;
}

// ── Repository listing (for the Add-Repo browser) ─────────────────────────────

// Build a host-only RepoConfig (no specific repo) suitable for hitting the
// global listing endpoints. Accepts a bare host, a host URL, or a full repo URL.
export function baseConfigForHost(input: string): RepoConfig {
  const trimmed = (input ?? "").trim();
  // A full repo URL? Parse it so we keep any context path / exact API base.
  if (/\/(projects|repos|scm|users)\//i.test(trimmed) || /bitbucket\.org\/[^/]+\/[^/?#]+/i.test(trimmed)) {
    try {
      return parseRepoUrl(trimmed);
    } catch {
      /* fall through to host handling */
    }
  }
  let host = trimmed.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (!host) host = "bitbucket.org";
  if (/(^|\.)bitbucket\.org$/i.test(host)) {
    return { url: "https://bitbucket.org", kind: "cloud", host: "bitbucket.org", apiBaseUrl: CLOUD_API, workspace: "", repoSlug: "" };
  }
  return { url: `https://${host}`, kind: "server", host, apiBaseUrl: `https://${host}/rest/api/1.0`, workspace: "", repoSlug: "" };
}

// List repositories the credentials can see on the given host/instance. Used by
// the Add-Repo browser. `query` narrows server-side where supported.
export async function listRepositories(
  creds: BitbucketCredentials,
  config: RepoConfig,
  query?: string
): Promise<AvailableRepo[]> {
  const client = makeClient(creds, config);
  return config.kind === "cloud"
    ? cloudRepositories(client, query)
    : serverRepositories(client, config, query);
}

async function cloudRepositories(client: AxiosInstance, query?: string): Promise<AvailableRepo[]> {
  const out: AvailableRepo[] = [];
  let url: string = `/repositories?role=member&pagelen=100&sort=full_name`;
  if (query && query.trim()) {
    url += `&q=${encodeURIComponent(`name ~ "${query.trim()}"`)}`;
  }
  try {
    for (let guard = 0; guard < 8 && url; guard++) {
      const res = await client.get(url);
      for (const v of res.data?.values ?? []) {
        const full = (v?.full_name as string) ?? "";
        const ws = v?.workspace?.slug ?? full.split("/")[0] ?? "";
        const slug = v?.slug ?? full.split("/")[1] ?? "";
        if (!ws || !slug) continue;
        out.push({
          workspace: ws,
          slug,
          name: full || `${ws}/${slug}`,
          url: v?.links?.html?.href ?? `https://bitbucket.org/${ws}/${slug}`,
        });
      }
      url = (res.data?.next as string) ?? "";
    }
  } catch {
    /* return whatever we collected */
  }
  return out;
}

async function serverRepositories(
  client: AxiosInstance,
  config: RepoConfig,
  query?: string
): Promise<AvailableRepo[]> {
  const out: AvailableRepo[] = [];
  const browseBase = config.apiBaseUrl.replace(/\/rest\/api\/1\.0\/?$/i, "");
  let start = 0;
  try {
    for (let guard = 0; guard < 8; guard++) {
      const res = await client.get(`/repos`, {
        params: { limit: 100, start, ...(query && query.trim() ? { name: query.trim() } : {}) },
      });
      const data = res.data;
      for (const v of data?.values ?? []) {
        const key = v?.project?.key as string | undefined;
        const slug = v?.slug as string | undefined;
        if (!key || !slug) continue;
        const href = (v?.links?.self?.[0]?.href as string) ?? `${browseBase}/projects/${key}/repos/${slug}`;
        out.push({ workspace: key, slug, name: `${key}/${slug}`, url: href });
      }
      if (data?.isLastPage !== false || typeof data?.nextPageStart !== "number") break;
      start = data.nextPageStart;
    }
  } catch {
    /* return whatever we collected */
  }
  return out;
}
