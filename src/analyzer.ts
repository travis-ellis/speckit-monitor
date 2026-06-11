import OpenAI from "openai";
import {
  SpecKitData,
  AnalysisResult,
  RepoConfig,
  DiffResult,
  StoredSnapshot,
  OpenQuestion,
} from "./types";
import {
  extractOpenQuestions,
  extractProjectArtifacts,
  extractConstitution,
  parseChecklists,
  computeConsistency,
  computeCompletionBreakdown,
  estimateCompletionPercentage,
  detectStall,
  buildContextSummary,
} from "./parser";
import { getGitHubToken } from "./state";

const GITHUB_MODELS_BASE_URL = "https://models.inference.ai.azure.com";
const MODEL = "gpt-4o";

function makeClient(): OpenAI {
  const token = getGitHubToken();
  if (!token) {
    throw new Error(
      "No GitHub token found. Set GITHUB_TOKEN env var or run `speckit-monitor auth`."
    );
  }
  return new OpenAI({
    baseURL: GITHUB_MODELS_BASE_URL,
    apiKey: token,
  });
}

const SYSTEM_PROMPT = `You are a product management assistant analyzing SpecKit-driven feature development repositories.
SpecKit is a spec-driven development framework that uses .specify/ directory with spec.md, plan.md, and tasks/.
Your job is to give product managers a clear, honest, and concise picture of where a feature stands.
Respond only with valid JSON matching the schema you are given. No markdown fences, no extra text.`;

interface AIAnalysis {
  summary: string;
  recentActivity: string;
  keyMilestones: string[];
  constitutionConcerns: string[];
}

async function getAIInsights(
  context: string,
  repoUrl: string,
  hasConstitution: boolean
): Promise<AIAnalysis> {
  const client = makeClient();

  const constitutionInstruction = hasConstitution
    ? `A "=== constitution.md ===" section is included. Compare the plan/spec against its governing principles.`
    : `No constitution was provided; return an empty array for "constitutionConcerns".`;

  const prompt = `Analyze this SpecKit repository for a product manager. Repo: ${repoUrl}

The context below may be truncated for length (per-section caps + an overall hard cap). Do not infer that omitted material is missing — focus on what is present. ${constitutionInstruction}

${context}

Return JSON with exactly these fields:
{
  "summary": "2-4 sentence plain-English summary of what the feature is, where development stands, and the overall health of the project",
  "recentActivity": "1-2 sentences describing what work has happened recently based on commits and task statuses",
  "keyMilestones": ["array of 3-6 key milestones or decisions that have been made or are coming up next"],
  "constitutionConcerns": ["array of 0-5 short, specific concerns where the plan or spec appear to conflict with, or fail to address, a governing principle from the constitution. Empty array if none or no constitution."]
}`;

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  });

  const text = response.choices[0].message.content ?? "{}";

  try {
    const parsed = JSON.parse(text) as Partial<AIAnalysis>;
    return {
      summary: parsed.summary ?? "",
      recentActivity: parsed.recentActivity ?? "",
      keyMilestones: Array.isArray(parsed.keyMilestones) ? parsed.keyMilestones : [],
      constitutionConcerns: Array.isArray(parsed.constitutionConcerns)
        ? parsed.constitutionConcerns
        : [],
    };
  } catch {
    return {
      summary: text.slice(0, 500),
      recentActivity: "Unable to parse recent activity.",
      keyMilestones: [],
      constitutionConcerns: [],
    };
  }
}

export async function analyzeRepo(
  data: SpecKitData,
  config: RepoConfig
): Promise<AnalysisResult> {
  const context = buildContextSummary(data);
  const openQuestions = extractOpenQuestions(data.specMd);
  const projectArtifacts = extractProjectArtifacts(data.specMd);
  const constitution = extractConstitution(data.constitutionMd);
  const checklist = parseChecklists(data.checklistsMd);
  const consistency = computeConsistency(data);
  const breakdown = computeCompletionBreakdown(data);
  const completionPercentage = estimateCompletionPercentage(breakdown);
  const stallCheck = detectStall(data);

  const insights = await getAIInsights(context, config.url, !!data.constitutionMd);

  return {
    repoUrl: config.url,
    alias: config.alias,
    generatedAt: new Date().toISOString(),
    summary: insights.summary,
    openQuestions,
    projectArtifacts,
    isStalled: stallCheck.stalled,
    stalledReason: stallCheck.reason,
    completionPercentage,
    completionBreakdown: breakdown,
    recentActivity: insights.recentActivity,
    keyMilestones: insights.keyMilestones,
    tasks: data.tasks,
    constitution,
    constitutionConcerns: insights.constitutionConcerns,
    checklist,
    consistency,
  };
}

export async function analyzeRepoDiff(
  data: SpecKitData,
  config: RepoConfig,
  previous: StoredSnapshot
): Promise<DiffResult> {
  const current = await analyzeRepo(data, config);

  const prevQuestions = previous.analysis.openQuestions;
  const currQuestions = current.openQuestions;

  const newOpenQuestions = currQuestions.filter(
    (q) =>
      !q.resolved &&
      !prevQuestions.some((p) => p.text.trim() === q.text.trim())
  );

  const resolvedQuestions: OpenQuestion[] = prevQuestions.filter(
    (p) =>
      !p.resolved &&
      currQuestions.some((q) => q.text.trim() === p.text.trim() && q.resolved)
  );

  const completionDelta =
    current.completionPercentage - previous.analysis.completionPercentage;

  const stalledChanged = current.isStalled !== previous.analysis.isStalled;

  const changes = buildChangeList({
    current,
    previous,
    newOpenQuestions,
    resolvedQuestions,
    completionDelta,
    stalledChanged,
  });

  return {
    current,
    previous,
    changes,
    newOpenQuestions,
    resolvedQuestions,
    completionDelta,
    stalledChanged,
  };
}

function buildChangeList(params: {
  current: AnalysisResult;
  previous: StoredSnapshot;
  newOpenQuestions: OpenQuestion[];
  resolvedQuestions: OpenQuestion[];
  completionDelta: number;
  stalledChanged: boolean;
}): string[] {
  const { current, previous, newOpenQuestions, resolvedQuestions, completionDelta, stalledChanged } = params;
  const changes: string[] = [];

  if (Math.abs(completionDelta) >= 1) {
    const direction = completionDelta > 0 ? "increased" : "decreased";
    changes.push(
      `Completion ${direction} by ${Math.abs(completionDelta)}% (${previous.analysis.completionPercentage}% → ${current.completionPercentage}%)`
    );
  }

  const prevTasksDone = previous.analysis.completionBreakdown.tasksCompleted;
  const currTasksDone = current.completionBreakdown.tasksCompleted;
  if (currTasksDone !== prevTasksDone) {
    changes.push(
      `Tasks completed: ${prevTasksDone} → ${currTasksDone} of ${current.completionBreakdown.tasksTotal}`
    );
  }

  if (newOpenQuestions.length > 0) {
    changes.push(`${newOpenQuestions.length} new open question(s) identified`);
  }

  if (resolvedQuestions.length > 0) {
    changes.push(`${resolvedQuestions.length} question(s) resolved`);
  }

  if (stalledChanged) {
    if (current.isStalled) {
      changes.push(`Project appears stalled: ${current.stalledReason}`);
    } else {
      changes.push("Project resumed activity (was previously stalled)");
    }
  }

  if (
    !previous.analysis.completionBreakdown.specDefined &&
    current.completionBreakdown.specDefined
  ) {
    changes.push("spec.md was added or filled in");
  }

  if (
    !previous.analysis.completionBreakdown.planDefined &&
    current.completionBreakdown.planDefined
  ) {
    changes.push("plan.md was added or filled in");
  }

  const prevTotal = previous.analysis.completionBreakdown.tasksTotal;
  const currTotal = current.completionBreakdown.tasksTotal;
  if (currTotal !== prevTotal) {
    changes.push(`Task count changed: ${prevTotal} → ${currTotal}`);
  }

  return changes;
}
