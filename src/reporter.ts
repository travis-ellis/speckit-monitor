import chalk from "chalk";
import { AnalysisResult, DiffResult, WatchedRepo } from "./types";

const HR = chalk.gray("─".repeat(60));
const HR_THIN = chalk.gray("·".repeat(60));

function completionBar(pct: number): string {
  const filled = Math.round(pct / 5);
  const empty = 20 - filled;
  const bar = chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(empty));
  const color = pct >= 75 ? chalk.green : pct >= 40 ? chalk.yellow : chalk.red;
  return `${bar} ${color(`${pct}%`)}`;
}

function stallBadge(isStalled: boolean): string {
  return isStalled
    ? chalk.bgRed.white(" STALLED ")
    : chalk.bgGreen.black(" ACTIVE ");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function printReport(result: AnalysisResult): void {
  const header = result.alias
    ? `${result.alias} (${result.repoUrl})`
    : result.repoUrl;

  console.log("\n" + HR);
  console.log(chalk.bold.cyan(`  SpecKit Monitor Report`));
  console.log(chalk.gray(`  ${header}`));
  console.log(chalk.gray(`  Generated: ${formatDate(result.generatedAt)}`));
  console.log(HR);

  // Status line
  console.log(
    `\n  Status: ${stallBadge(result.isStalled)}   Completion: ${completionBar(result.completionPercentage)}\n`
  );

  if (result.isStalled && result.stalledReason) {
    console.log(chalk.red(`  ⚠  ${result.stalledReason}\n`));
  }

  // Summary
  console.log(chalk.bold("  Summary"));
  console.log(HR_THIN);
  console.log(wrapText(result.summary, 2));

  // Recent activity
  console.log("\n" + chalk.bold("  Recent Activity"));
  console.log(HR_THIN);
  console.log(wrapText(result.recentActivity, 2));

  // Completion breakdown
  console.log("\n" + chalk.bold("  Completion Breakdown"));
  console.log(HR_THIN);
  const bd = result.completionBreakdown;
  console.log(`  ${checkmark(bd.specDefined)} spec.md defined`);
  console.log(`  ${checkmark(bd.planDefined)} plan.md defined`);
  console.log(
    `  ${checkmark(bd.tasksCompleted === bd.tasksTotal && bd.tasksTotal > 0)} Tasks: ${bd.tasksCompleted} / ${bd.tasksTotal} completed`
  );
  if (bd.openQuestionsTotal > 0) {
    console.log(
      `  ${checkmark(bd.openQuestionsResolved === bd.openQuestionsTotal)} Open questions: ${bd.openQuestionsResolved} / ${bd.openQuestionsTotal} resolved`
    );
  }

  // Key milestones
  if (result.keyMilestones.length > 0) {
    console.log("\n" + chalk.bold("  Key Milestones & Next Steps"));
    console.log(HR_THIN);
    result.keyMilestones.forEach((m) => {
      console.log(`  ${chalk.cyan("◆")} ${m}`);
    });
  }

  // Open questions
  const unresolvedQ = result.openQuestions.filter((q) => !q.resolved);
  if (unresolvedQ.length > 0) {
    console.log("\n" + chalk.bold(`  Open Questions  ${chalk.red(`(${unresolvedQ.length} unresolved)`)}`));
    console.log(HR_THIN);
    let lastCategory: string | undefined;
    for (const q of unresolvedQ) {
      if (q.category && q.category !== lastCategory) {
        console.log(`\n  ${chalk.yellow(q.category)}`);
        lastCategory = q.category;
      }
      console.log(`  ${chalk.red("?")} ${q.text}`);
    }
  } else {
    console.log("\n" + chalk.bold("  Open Questions"));
    console.log(HR_THIN);
    console.log(chalk.green("  ✓ No unresolved questions"));
  }

  // Project artifacts — canonical SpecKit sections other than Open Questions.
  // `?? []` keeps this safe when reading an analysis snapshot stored before
  // projectArtifacts existed on the type.
  const artifacts = result.projectArtifacts ?? [];
  if (artifacts.length > 0) {
    const totalItems = artifacts.reduce((n, a) => n + a.items.length, 0);
    console.log("\n" + chalk.bold(`  Project Artifacts  ${chalk.gray(`(${totalItems} items across ${artifacts.length} sections)`)}`));
    console.log(HR_THIN);
    for (const a of artifacts) {
      console.log(`\n  ${chalk.cyan(a.kind)}  ${chalk.gray(`(${a.items.length})`)}`);
      for (const item of a.items) {
        console.log(`  ${chalk.gray("•")} ${item}`);
      }
    }
  }

  // Consistency / traceability checks
  const consistency = result.consistency ?? [];
  if (consistency.length > 0) {
    console.log("\n" + chalk.bold("  Consistency Checks"));
    console.log(HR_THIN);
    for (const f of consistency) {
      const icon = f.severity === "warn" ? chalk.yellow("⚠") : chalk.cyan("ℹ");
      console.log(`  ${icon} ${f.message}`);
      for (const item of (f.items ?? []).slice(0, 10)) {
        console.log(`      ${chalk.gray("·")} ${item}`);
      }
    }
  }

  // Constitution: governing principles + AI-flagged concerns
  const principles = result.constitution ?? [];
  const concerns = result.constitutionConcerns ?? [];
  if (principles.length > 0 || concerns.length > 0) {
    console.log("\n" + chalk.bold("  Constitution"));
    console.log(HR_THIN);
    for (const p of principles) {
      const sum = p.summary ? chalk.gray(` — ${p.summary}`) : "";
      console.log(`  ${chalk.cyan("§")} ${chalk.bold(p.title)}${sum}`);
    }
    if (concerns.length > 0) {
      console.log("\n  " + chalk.yellow("Possible concerns:"));
      for (const c of concerns) console.log(`  ${chalk.yellow("⚠")} ${c}`);
    }
  }

  // Validation checklists
  const checklist = result.checklist ?? [];
  if (checklist.length > 0) {
    const total = checklist.reduce((n, g) => n + g.items.length, 0);
    const passed = checklist.reduce((n, g) => n + g.items.filter((i) => i.checked).length, 0);
    console.log("\n" + chalk.bold(`  Validation Checklists  ${chalk.gray(`(${passed}/${total} passed)`)}`));
    console.log(HR_THIN);
    for (const g of checklist) {
      console.log(`\n  ${chalk.cyan(g.title)}`);
      for (const item of g.items) {
        console.log(`  ${item.checked ? chalk.green("✓") : chalk.red("✗")} ${item.text}`);
      }
    }
  }

  console.log("\n" + HR + "\n");
}

export function printDiffReport(diff: DiffResult): void {
  printReport(diff.current);

  const prevDate = formatDate(diff.previous.timestamp);
  console.log(chalk.bold.magenta(`  Changes Since ${prevDate}`));
  console.log(HR_THIN);

  if (diff.changes.length === 0) {
    console.log(chalk.gray("  No significant changes detected."));
  } else {
    diff.changes.forEach((c) => {
      const icon =
        c.includes("stalled") ? chalk.red("▼") :
        c.includes("resumed") ? chalk.green("▲") :
        c.includes("increased") ? chalk.green("▲") :
        c.includes("decreased") ? chalk.red("▼") :
        chalk.yellow("●");
      console.log(`  ${icon} ${c}`);
    });
  }

  if (diff.newOpenQuestions.length > 0) {
    console.log(`\n  ${chalk.red("New open questions:")}`);
    diff.newOpenQuestions.forEach((q) => {
      console.log(`    ${chalk.red("?")} ${q.text}`);
    });
  }

  if (diff.resolvedQuestions.length > 0) {
    console.log(`\n  ${chalk.green("Newly resolved questions:")}`);
    diff.resolvedQuestions.forEach((q) => {
      console.log(`    ${chalk.green("✓")} ${q.text}`);
    });
  }

  console.log("\n" + HR + "\n");
}

export function printRepoList(repos: WatchedRepo[]): void {
  if (repos.length === 0) {
    console.log(chalk.gray("\n  No repos being watched. Use `add <url>` to start.\n"));
    return;
  }
  console.log("\n" + HR);
  console.log(chalk.bold.cyan("  Watched Repos"));
  console.log(HR);
  repos.forEach((r, i) => {
    const label = r.alias ? chalk.bold(r.alias) : `${r.workspace}/${r.repoSlug}`;
    const last = r.lastSnapshot
      ? chalk.gray(`Last run: ${formatDate(r.lastSnapshot.timestamp)}`)
      : chalk.gray("Never run");
    const pct = r.lastSnapshot
      ? ` — ${completionBar(r.lastSnapshot.analysis.completionPercentage)}`
      : "";
    console.log(`  ${chalk.cyan(`${i + 1}.`)} ${label}${pct}`);
    console.log(`     ${chalk.gray(r.url)}   ${last}`);
  });
  console.log(HR + "\n");
}

export function printError(msg: string): void {
  console.error(chalk.red(`\n  ✗ ${msg}\n`));
}

export function printSuccess(msg: string): void {
  console.log(chalk.green(`\n  ✓ ${msg}\n`));
}

export function printInfo(msg: string): void {
  console.log(chalk.cyan(`\n  ℹ ${msg}\n`));
}

function checkmark(ok: boolean): string {
  return ok ? chalk.green("✓") : chalk.red("✗");
}

function wrapText(text: string, indent: number): string {
  const prefix = " ".repeat(indent);
  const width = 76 - indent;
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      if (current) lines.push(prefix + current.trim());
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(prefix + current.trim());
  return lines.join("\n");
}
