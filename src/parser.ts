import {
  OpenQuestion,
  SpecKitData,
  CompletionBreakdown,
  ProjectArtifact,
  ConstitutionPrinciple,
  ChecklistGroup,
  ConsistencyFinding,
} from "./types";

// A continuation line under a list item that starts with an answer marker —
// `A:`, `Answer:`, `Resolution:` (optionally bulleted and/or bolded). When we
// see this beneath a question bullet, the question is answered.
const ANSWER_LINE_RE =
  /^\s*[-*]?\s*(?:\*\*)?(?:A|Answer|Resolution|Resolved)(?:\*\*)?:\s*\S/i;

// Same-line inline Q&A: `- Q: ... A: ...` on a single bullet.
const INLINE_QA_RE = /^(?:\*\*)?Q(?:\*\*)?:.*\bA(?:nswer)?:\s+\S/i;

// Headings (case-insensitive) that mean "this is a list of open questions",
// not artifacts. Anything not in this list is treated as a non-questions
// section so that User Stories, Functional Requirements, etc. no longer leak
// into Open Questions.
const OPEN_QUESTIONS_HEADING_RE =
  /^#{1,6}\s*(?:open\s*questions|outstanding\s*questions|clarifications?\s*(?:needed)?|questions)\s*$/i;

// Inline SpecKit marker for unresolved spec items — `[NEEDS CLARIFICATION: …]`.
// These can appear anywhere in spec.md, not just under an Open Questions heading.
const NEEDS_CLARIFICATION_RE = /\[NEEDS CLARIFICATION:\s*([^\]]+)\]/gi;

export function extractOpenQuestions(specMd: string | null): OpenQuestion[] {
  if (!specMd) return [];

  const questions: OpenQuestion[] = [];

  // 1. Inline [NEEDS CLARIFICATION: ...] markers, anywhere in the spec.
  let m: RegExpExecArray | null;
  const seenInline = new Set<string>();
  const re = new RegExp(NEEDS_CLARIFICATION_RE.source, NEEDS_CLARIFICATION_RE.flags);
  while ((m = re.exec(specMd)) !== null) {
    const text = m[1].trim();
    if (text.length > 0 && !seenInline.has(text)) {
      seenInline.add(text);
      questions.push({
        text,
        category: "Inline clarification",
        resolved: false,
      });
    }
  }

  // 2. Bullets under an explicit Open Questions section. If no such heading
  //    exists, return only the inline markers — do NOT fall back to scanning
  //    the whole spec (that was the source of the false positives).
  const lines = specMd.split("\n");
  const sectionStart = lines.findIndex((l) => OPEN_QUESTIONS_HEADING_RE.test(l));
  if (sectionStart === -1) return questions;

  const headingLevel = (lines[sectionStart].match(/^#+/)?.[0].length) ?? 2;
  // End at the next heading of equal or higher level, or at a horizontal rule.
  const sectionEnd = (() => {
    for (let k = sectionStart + 1; k < lines.length; k++) {
      const hm = lines[k].match(/^(#+)\s+/);
      if (hm && hm[1].length <= headingLevel) return k;
      if (/^---\s*$/.test(lines[k])) return k;
    }
    return lines.length;
  })();

  let currentCategory: string | undefined;

  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const line = lines[i];

    // Sub-headings inside the Open Questions section act as categories.
    const categoryMatch = line.match(/^#{3,6}\s+(.+)/);
    if (categoryMatch) {
      currentCategory = categoryMatch[1].trim();
      continue;
    }

    const listMatch = line.match(/^[-*]\s+(.+)/);
    const numberedMatch = line.match(/^\d+\.\s+(.+)/);
    const itemText = listMatch?.[1] ?? numberedMatch?.[1];
    if (!itemText) continue;

    // Group indented continuation lines so an answer on a sub-bullet resolves
    // its parent question. Stops at the next top-level item, heading, blank
    // line, or any non-indented line.
    const continuationLines: string[] = [];
    let j = i + 1;
    while (j < sectionEnd) {
      const next = lines[j];
      if (
        /^[-*]\s+/.test(next) ||
        /^\d+\.\s+/.test(next) ||
        /^#+\s+/.test(next) ||
        /^\s*$/.test(next) ||
        !/^\s/.test(next)
      ) {
        break;
      }
      continuationLines.push(next);
      j++;
    }
    i = j - 1;

    if (itemText.trim().length <= 10) continue;

    const explicitResolvedRe = [/~~.+~~/, /\[resolved\]/i, /✅/, /^-?\s*RESOLVED:/i];
    const hasInlineAnswer = INLINE_QA_RE.test(itemText);
    const hasAnswerSubBullet = continuationLines.some((l) => ANSWER_LINE_RE.test(l));
    const isResolved =
      explicitResolvedRe.some((p) => p.test(line)) || hasInlineAnswer || hasAnswerSubBullet;

    const cleaned = itemText
      .replace(/^(?:\*\*)?Q(?:\*\*)?:\s*/i, "")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/\[resolved\]/gi, "")
      .replace(/✅/g, "")
      .replace(/^RESOLVED:\s*/i, "")
      .trim();

    questions.push({
      text: cleaned,
      category: currentCategory,
      resolved: isResolved,
    });
  }

  return questions;
}

// ── Project artifacts ────────────────────────────────────────────────────────

// Canonical SpecKit-shaped sections to surface as Project Artifacts. The
// patterns are deliberately permissive about naming variants ("User Stories"
// vs "User Story", "Non-Functional Requirements" vs "NFRs", etc.).
const ARTIFACT_SECTIONS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "User Stories",              pattern: /^user\s*stor(?:y|ies)\b/i },
  { kind: "Functional Requirements",   pattern: /^functional\s*requirements?\b/i },
  { kind: "Non-Functional Requirements", pattern: /^(?:non-?functional\s*requirements?|nfrs?)\b/i },
  { kind: "Key Entities",              pattern: /^(?:key\s*entities|entities|data\s*model)\b/i },
  { kind: "Measurable Outcomes",       pattern: /^(?:measurable\s*outcomes|success\s*criteria|outcomes|kpis?)\b/i },
  { kind: "Deferred",                  pattern: /^deferred(?:\s*items?)?\b/i },
  { kind: "Out of Scope",              pattern: /^(?:out\s*of\s*scope|non[-\s]?goals)\b/i },
  { kind: "Edge Cases",                pattern: /^edge\s*cases\b/i },
  { kind: "Dependencies",              pattern: /^dependencies\b/i },
  { kind: "Risks",                     pattern: /^risks?\b/i },
  { kind: "Assumptions",               pattern: /^assumptions\b/i },
];

function matchArtifactKind(headingText: string): string | null {
  const trimmed = headingText.trim();
  for (const { kind, pattern } of ARTIFACT_SECTIONS) {
    if (pattern.test(trimmed)) return kind;
  }
  return null;
}

// Pull canonical SpecKit sections out of spec.md as structured artifacts so
// they can be surfaced separately from Open Questions. Within an artifact
// section, sub-headings (### …) become an inline `[Subheading]` prefix on
// each item, the same convention used for tasks.
export function extractProjectArtifacts(specMd: string | null): ProjectArtifact[] {
  if (!specMd) return [];

  const lines = specMd.split("\n");
  // Preserve insertion order so the report mirrors the spec's section order.
  const ordered: ProjectArtifact[] = [];
  const byKind = new Map<string, ProjectArtifact>();

  let current: ProjectArtifact | null = null;
  let currentLevel = 0;
  let subheading: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const hm = line.match(/^(#+)\s+(.+?)\s*$/);
    if (hm) {
      const level = hm[1].length;
      const text = hm[2];

      // Treat ###+ headings inside an active artifact as sub-section labels.
      if (current && level > currentLevel) {
        subheading = text.trim();
        continue;
      }

      // A heading at the same or higher level ends the current artifact.
      current = null;
      subheading = undefined;

      // Open Questions is handled separately; never absorb it as an artifact.
      if (OPEN_QUESTIONS_HEADING_RE.test(line)) continue;

      const kind = matchArtifactKind(text);
      if (!kind) continue;

      // Merge sections that share a canonical kind (e.g. two "## User Stories"
      // blocks) so each kind shows up once in the output.
      let artifact = byKind.get(kind);
      if (!artifact) {
        artifact = { kind, items: [] };
        byKind.set(kind, artifact);
        ordered.push(artifact);
      }
      current = artifact;
      currentLevel = level;
      continue;
    }

    if (!current) continue;

    const listMatch = line.match(/^\s*[-*]\s+(.+)$/);
    const numberedMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    const itemText = (listMatch?.[1] ?? numberedMatch?.[1])?.trim();
    if (!itemText) continue;

    // Strip simple markdown emphasis around leading IDs (e.g. **FR-001**) so
    // the displayed item reads naturally.
    const cleaned = itemText
      .replace(/^\*\*(.+?)\*\*/, "$1")
      .replace(/^__(.+?)__/, "$1")
      .trim();

    current.items.push(subheading ? `[${subheading}] ${cleaned}` : cleaned);
  }

  return ordered.filter((a) => a.items.length > 0);
}

// ── Constitution ─────────────────────────────────────────────────────────────

// Extract governing principles from .specify/memory/constitution.md. SpecKit
// constitutions list each principle as a heading (usually "### I. Title")
// followed by a short body. We surface the heading as the principle title and
// the first body line as a one-line summary. Boilerplate sections (Governance,
// Amendments, versioning) are skipped.
const CONSTITUTION_SKIP_RE =
  /^(governance|amendment|amendments|version|versioning|ratif|table\s*of\s*contents|compliance|enforcement)\b/i;

export function extractConstitution(constitutionMd: string | null): ConstitutionPrinciple[] {
  if (!constitutionMd) return [];

  const lines = constitutionMd.split("\n");
  // Prefer ### (typical per-principle level); fall back to ## if there are none.
  const hasH3 = lines.some((l) => /^###\s+\S/.test(l));
  const headingRe = hasH3 ? /^###\s+(.+?)\s*$/ : /^##\s+(.+?)\s*$/;

  const principles: ConstitutionPrinciple[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (!m) continue;
    const title = m[1].replace(/\*\*/g, "").replace(/`/g, "").trim();
    if (!title || CONSTITUTION_SKIP_RE.test(title)) continue;

    let summary: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{1,6}\s+/.test(lines[j])) break;
      const t = lines[j].trim().replace(/^[-*]\s+/, "").replace(/\*\*/g, "");
      if (t) {
        summary = t.length > 240 ? t.slice(0, 237) + "…" : t;
        break;
      }
    }
    principles.push({ title, summary });
  }
  return principles;
}

// ── Checklists ───────────────────────────────────────────────────────────────

// Parse checklists.md into grouped pass/fail items. Same checkbox shape as
// tasks.md (`- [ ]` / `- [x]`), grouped under ## / ### headings.
export function parseChecklists(checklistsMd: string | null): ChecklistGroup[] {
  if (!checklistsMd) return [];

  const groups: ChecklistGroup[] = [];
  let current: ChecklistGroup | null = null;

  for (const raw of checklistsMd.split("\n")) {
    const line = raw.trimEnd();

    const h = line.match(/^#{2,3}\s+(.+)/);
    if (h) {
      current = { title: h[1].replace(/\*\*/g, "").trim(), items: [] };
      groups.push(current);
      continue;
    }

    const c = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
    if (!c) continue;
    if (!current) {
      current = { title: "Checklist", items: [] };
      groups.push(current);
    }
    current.items.push({
      text: c[2].replace(/\*\*/g, "").trim(),
      checked: c[1].toLowerCase() === "x",
    });
  }

  return groups.filter((g) => g.items.length > 0);
}

// ── Consistency / traceability ───────────────────────────────────────────────

// Requirement-style identifiers used for lightweight traceability: functional
// requirements, non-functional requirements, and user stories.
const REQ_ID_RE = /\b((?:FR|NFR|US)-?\d{1,4})\b/gi;

// Collect requirement ids from text as a map of normalized-id → display form.
// Normalizing (uppercase, drop hyphen) lets "FR-001" in the spec match "FR001"
// written in a task.
function collectReqIds(text: string | null): Map<string, string> {
  const ids = new Map<string, string>();
  if (!text) return ids;
  const re = new RegExp(REQ_ID_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const display = m[1].toUpperCase();
    const norm = display.replace(/-/g, "");
    if (!ids.has(norm)) ids.set(norm, display);
  }
  return ids;
}

// Deterministic consistency checks across spec/tasks/clarifications.
export function computeConsistency(data: SpecKitData): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const specIds = collectReqIds(data.specMd);
  const tasks = data.tasks;

  if (specIds.size > 0 && tasks.length > 0) {
    const referencedByTasks = new Set<string>();
    let tasksWithRef = 0;
    const unlinkedTasks: string[] = [];

    for (const t of tasks) {
      const refs = collectReqIds(t.title);
      if (refs.size > 0) {
        tasksWithRef++;
        for (const k of refs.keys()) referencedByTasks.add(k);
      } else {
        unlinkedTasks.push(t.title);
      }
    }

    // Requirements defined in the spec that no task references.
    const uncovered: string[] = [];
    for (const [norm, display] of specIds) {
      if (!referencedByTasks.has(norm)) uncovered.push(display);
    }
    if (uncovered.length > 0) {
      findings.push({
        kind: "Requirements without tasks",
        severity: "warn",
        message: `${uncovered.length} requirement(s) in spec.md are not referenced by any task.`,
        items: uncovered.sort(),
      });
    }

    // Tasks with no requirement link — only flagged when the project clearly
    // uses linkage (i.e. some tasks DO reference ids), to avoid noise in repos
    // that don't track requirement ids on tasks.
    if (tasksWithRef > 0 && unlinkedTasks.length > 0) {
      findings.push({
        kind: "Tasks without a linked requirement",
        severity: "info",
        message: `${unlinkedTasks.length} task(s) don't reference any requirement id (FR/NFR/US).`,
        items: unlinkedTasks.slice(0, 15),
      });
    }
  }

  // Unresolved clarifications/questions while work remains — may block a phase.
  const openUnresolved = extractOpenQuestions(data.specMd).filter((q) => !q.resolved);
  const incomplete = tasks.filter((t) => t.status !== "completed").length;
  if (openUnresolved.length > 0 && incomplete > 0) {
    findings.push({
      kind: "Unresolved clarifications",
      severity: "warn",
      message: `${openUnresolved.length} unresolved question(s)/clarification(s) remain while ${incomplete} task(s) are still incomplete — these may block delivery.`,
      items: openUnresolved.slice(0, 8).map((q) => q.text),
    });
  }

  return findings;
}

export function computeCompletionBreakdown(data: SpecKitData): CompletionBreakdown {
  const openQuestions = extractOpenQuestions(data.specMd);

  return {
    specDefined: data.specMd !== null && data.specMd.trim().length > 50,
    planDefined: data.planMd !== null && data.planMd.trim().length > 50,
    tasksTotal: data.tasks.length,
    tasksCompleted: data.tasks.filter((t) => t.status === "completed").length,
    openQuestionsTotal: openQuestions.length,
    openQuestionsResolved: openQuestions.filter((q) => q.resolved).length,
  };
}

export function estimateCompletionPercentage(breakdown: CompletionBreakdown): number {
  let score = 0;
  let weight = 0;

  // Spec defined (15%)
  weight += 15;
  if (breakdown.specDefined) score += 15;

  // Plan defined (15%)
  weight += 15;
  if (breakdown.planDefined) score += 15;

  // Tasks completed (50%)
  weight += 50;
  if (breakdown.tasksTotal > 0) {
    score += (breakdown.tasksCompleted / breakdown.tasksTotal) * 50;
  }

  // Open questions resolved (20%)
  weight += 20;
  if (breakdown.openQuestionsTotal > 0) {
    score += (breakdown.openQuestionsResolved / breakdown.openQuestionsTotal) * 20;
  } else if (breakdown.specDefined) {
    // No open questions in a defined spec = good sign
    score += 20;
  }

  return Math.round((score / weight) * 100);
}

export function detectStall(data: SpecKitData): { stalled: boolean; reason?: string } {
  const STALL_DAYS = 14;

  if (data.daysSinceLastCommit === null) {
    return { stalled: false };
  }

  if (data.daysSinceLastCommit >= STALL_DAYS) {
    return {
      stalled: true,
      reason: `No commits in ${data.daysSinceLastCommit} days (last: "${data.lastCommitMessage ?? "unknown"}")`,
    };
  }

  return { stalled: false };
}

// GitHub Models free-tier gpt-4o caps requests at 8000 tokens. We also need
// room for the system prompt, framing text, and a 1024-token response, so
// budget the assembled context at ~6000 tokens (~24k chars at ~4 chars/token).
const TASK_LINE_CAP = 50;
const FINAL_CONTEXT_CAP_CHARS = 24000;

export function buildContextSummary(data: SpecKitData): string {
  const parts: string[] = [];

  if (data.specMd) {
    parts.push(`=== spec.md ===\n${data.specMd.slice(0, 3000)}`);
  } else {
    parts.push("=== spec.md ===\n[not found]");
  }

  if (data.planMd) {
    parts.push(`=== plan.md ===\n${data.planMd.slice(0, 2000)}`);
  } else {
    parts.push("=== plan.md ===\n[not found]");
  }

  if (data.constitutionMd) {
    parts.push(`=== constitution.md ===\n${data.constitutionMd.slice(0, 2500)}`);
  }

  if (data.tasks.length > 0) {
    const shown = data.tasks.slice(0, TASK_LINE_CAP);
    const taskList = shown.map((t) => `- [${t.status}] ${t.title}`).join("\n");
    const remainder = data.tasks.length - shown.length;
    const tail = remainder > 0 ? `\n… (+${remainder} more tasks omitted for length)` : "";
    parts.push(`=== tasks.md (${data.tasks.length} total) ===\n${taskList}${tail}`);
  } else {
    parts.push("=== tasks.md ===\n[none found]");
  }

  if (data.lastCommitDate) {
    parts.push(
      `=== recent activity ===\nLast commit: ${data.lastCommitDate}\nMessage: ${data.lastCommitMessage}`
    );
  }

  // Belt and braces: hard cap the total to keep requests under the model's
  // input-token limit even if the per-section caps above are loosened later.
  const assembled = parts.join("\n\n");
  if (assembled.length <= FINAL_CONTEXT_CAP_CHARS) return assembled;
  return assembled.slice(0, FINAL_CONTEXT_CAP_CHARS) + "\n\n[context truncated for length]";
}
