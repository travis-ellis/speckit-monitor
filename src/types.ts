export interface BitbucketCredentials {
  // For Bitbucket Cloud this is your account username; for a self-hosted
  // server it can be left blank to authenticate with a Bearer token.
  username: string;
  // App password (Cloud) or HTTP access token / password (Server).
  secret: string;
}

// Which flavor of Bitbucket a repo lives on. Cloud = bitbucket.org (API v2.0);
// server = self-hosted Bitbucket Server / Data Center (REST API v1.0).
export type BitbucketKind = "cloud" | "server";

export interface RepoConfig {
  url: string;
  kind: BitbucketKind;
  // Bare host, used for display/credential context, e.g. "bitbucket.org" or
  // "bitbucket.cpanel.net".
  host: string;
  // Fully-qualified REST API base. Cloud: https://api.bitbucket.org/2.0.
  // Server: https://<host>[/context]/rest/api/1.0.
  apiBaseUrl: string;
  // Cloud workspace, or Server project key (may be "~username" for personal
  // repositories).
  workspace: string;
  repoSlug: string;
  alias?: string;
  // Branch to read spec/plan/tasks from. SpecKit work usually lives on a
  // per-feature branch (e.g. "001-some-feature") that isn't merged to main
  // yet. Omitted means "default branch".
  branch?: string;
}

export interface SpecKitTask {
  filename: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "unknown";
}

export interface OpenQuestion {
  text: string;
  category?: string;
  resolved: boolean;
}

// A canonical SpecKit section other than Open Questions — User Stories,
// Functional Requirements, Key Entities, Measurable Outcomes, Deferred,
// Out of Scope, Edge Cases, NFRs, etc. These used to leak into Open Questions
// when the parser fell back to scanning the whole spec.
export interface ProjectArtifact {
  kind: string;     // Canonical section name, e.g. "Functional Requirements".
  items: string[];  // Bulleted/numbered items, with `[Subheading]` prefix when present.
}

export interface SpecKitData {
  specMd: string | null;
  planMd: string | null;
  constitutionMd: string | null;
  checklistsMd: string | null;
  tasks: SpecKitTask[];
  lastCommitDate: string | null;
  lastCommitMessage: string | null;
  daysSinceLastCommit: number | null;
}

// A repository discovered via the Bitbucket listing API, offered in the
// Add-Repo browser before it's been added to the watch list.
export interface AvailableRepo {
  workspace: string; // Cloud workspace or Server project key.
  slug: string;
  name: string;      // Display name, e.g. "workspace/slug".
  url: string;       // A URL that parseRepoUrl can consume.
}

// A governing principle parsed from .specify/memory/constitution.md.
export interface ConstitutionPrinciple {
  title: string;
  summary?: string;
}

// A single validation item from checklists.md.
export interface ChecklistItem {
  text: string;
  checked: boolean;
}

// A section of checklists.md (heading + its checkbox items).
export interface ChecklistGroup {
  title: string;
  items: ChecklistItem[];
}

// A lightweight traceability / consistency finding computed deterministically
// from spec/plan/tasks (no AI).
export interface ConsistencyFinding {
  kind: string;
  severity: "warn" | "info";
  message: string;
  items?: string[];
}

export interface AnalysisResult {
  repoUrl: string;
  alias?: string;
  generatedAt: string;
  summary: string;
  openQuestions: OpenQuestion[];
  projectArtifacts: ProjectArtifact[];
  isStalled: boolean;
  stalledReason?: string;
  completionPercentage: number;
  completionBreakdown: CompletionBreakdown;
  recentActivity: string;
  keyMilestones: string[];
  // Full parsed task list, so the UI can show a completed/incomplete
  // breakdown without re-fetching. Optional at runtime for snapshots cached
  // before this field existed.
  tasks: SpecKitTask[];
  // Spec-intelligence outputs. All optional at runtime for older snapshots.
  constitution: ConstitutionPrinciple[];      // Parsed governing principles.
  constitutionConcerns: string[];             // AI-flagged possible violations.
  checklist: ChecklistGroup[];                // Parsed checklists.md.
  consistency: ConsistencyFinding[];          // Traceability / consistency checks.
}

export interface CompletionBreakdown {
  specDefined: boolean;
  planDefined: boolean;
  tasksTotal: number;
  tasksCompleted: number;
  openQuestionsTotal: number;
  openQuestionsResolved: number;
}

export interface StoredSnapshot {
  timestamp: string;
  analysis: AnalysisResult;
  specMd: string | null;
  planMd: string | null;
  taskSummaries: string[];
}

// A lightweight point in a repo's run history, kept for trend charts. Holds
// only the few numbers we plot — no spec text — so the time series stays small.
export interface HistoryPoint {
  timestamp: string;
  completionPercentage: number;
  tasksCompleted: number;
  tasksTotal: number;
  openQuestionsTotal: number;
  openQuestionsResolved: number;
}

export interface WatchedRepo {
  // Stable unique id. Lets the same repo be watched more than once (e.g. a
  // clone tracking a different branch), since workspace/repoSlug alone are no
  // longer unique. Assigned on add; back-filled for older state files.
  id: string;
  url: string;
  workspace: string;
  repoSlug: string;
  alias?: string;
  branch?: string;
  // Archived repos are hidden from the main list/dashboard and skipped by
  // "Refresh All", but their snapshots are retained.
  archived?: boolean;
  lastSnapshot?: StoredSnapshot;
  // Time series of past runs (capped), used for the Trends charts.
  history?: HistoryPoint[];
}

export interface StateFile {
  // Secrets encrypted at rest with Windows DPAPI (current-user scope).
  credentialsEnc?: string;
  githubTokenEnc?: string;
  // Optional Slack/Teams incoming-webhook URL for digest delivery (encrypted).
  digestWebhookEnc?: string;
  // Legacy plaintext fields — migrated to the *Enc fields on first read,
  // then removed from disk. Present only on state files written by older
  // versions; do not write these going forward.
  credentials?: BitbucketCredentials;
  githubToken?: string;
  repos: WatchedRepo[];
}

export interface DiffResult {
  current: AnalysisResult;
  previous: StoredSnapshot;
  changes: string[];
  newOpenQuestions: OpenQuestion[];
  resolvedQuestions: OpenQuestion[];
  completionDelta: number;
  stalledChanged: boolean;
}
