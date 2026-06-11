/* global electronAPI */
"use strict";

// ── State ─────────────────────────────────────────────────────────────────
let repos = [];
let selectedRepo = null;  // { url, workspace, repoSlug, alias, hasSnapshot }
let currentReport = null; // AnalysisResult
let isRunning = false;
let availableRepos = [];   // repos returned by the Add-Repo browser

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const repoList      = $("repo-list");
const repoEmpty     = $("repo-empty");
const welcome       = $("welcome");
const dashboard     = $("dashboard");
const reportPanel   = $("report-panel");
const reportContent = $("report-content");
const reportError   = $("report-error");
const progressBar   = $("progress-bar");
const progressInner = $("progress-inner");
const progressLabel = $("progress-label");

// ── Init ───────────────────────────────────────────────────────────────────
(async function init() {
  // Register progress listener
  electronAPI.onProgress((msg) => setProgress(msg));

  await refreshRepoList();
  showHome();
})();

// ── Repo list ──────────────────────────────────────────────────────────────
async function refreshRepoList() {
  repos = await electronAPI.getRepos();
  renderRepoList();
  renderDashboard();
}

function renderRepoList() {
  // Clear existing items (keep the empty-state div)
  Array.from(repoList.querySelectorAll(".repo-item")).forEach((el) => el.remove());

  const active = repos.filter((r) => !r.archived);
  const archived = repos.filter((r) => r.archived);

  repoEmpty.classList.toggle("hidden", active.length > 0);

  active.forEach((repo) => repoList.appendChild(buildRepoItem(repo)));
  renderArchivedGroup(archived);
}

function buildRepoItem(repo) {
  const item = document.createElement("div");
  item.className = "repo-item";
  item.dataset.id = repo.id;
  item.draggable = true;

  const snap = repo.lastSnapshot;
  const pct  = snap ? snap.analysis.completionPercentage : null;
  const stalled = snap ? snap.analysis.isStalled : false;

  const dotClass = !snap ? "" : stalled ? "stalled-dot" : "active-dot";
  const label = repo.alias ?? `${repo.workspace}/${repo.repoSlug}`;
  const meta  = snap ? `Last run: ${fmtDate(snap.timestamp)}` : "Never run";

  item.innerHTML = `
    <div class="repo-dot ${dotClass}"></div>
    <div class="repo-item-info">
      <div class="repo-name">${esc(label)}</div>
      <div class="repo-meta">${esc(meta)}</div>
    </div>
    ${pct !== null ? `<div class="repo-pct">${pct}%</div>` : ""}
  `;

  if (selectedRepo && repo.id === selectedRepo.id) item.classList.add("active");

  item.addEventListener("click", () => selectRepo(repo));
  item.addEventListener("dragstart", (e) => {
    item.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", repo.id);
  });
  item.addEventListener("dragend", () => {
    item.classList.remove("dragging");
    persistRepoOrder();
  });
  return item;
}

function renderArchivedGroup(archived) {
  const group = $("archived-group");
  const list = $("archived-list");
  list.innerHTML = "";
  if (archived.length === 0) {
    group.classList.add("hidden");
    return;
  }
  group.classList.remove("hidden");
  $("archived-count").textContent = `(${archived.length})`;

  archived.forEach((repo) => {
    const item = document.createElement("div");
    item.className = "repo-item archived";
    item.dataset.id = repo.id;
    const label = repo.alias ?? `${repo.workspace}/${repo.repoSlug}`;
    item.innerHTML = `
      <div class="repo-item-info">
        <div class="repo-name">${esc(label)}</div>
        <div class="repo-meta">Archived</div>
      </div>
      <button class="repo-unarchive" title="Unarchive">⤴</button>
    `;
    item.querySelector(".repo-item-info").addEventListener("click", () => selectRepo(repo));
    item.querySelector(".repo-unarchive").addEventListener("click", async (e) => {
      e.stopPropagation();
      await electronAPI.archiveRepo(repo.id, false);
      await refreshRepoList();
    });
    list.appendChild(item);
  });
}

// Live-reorder the dragged sidebar item; order is persisted on dragend.
repoList.addEventListener("dragover", (e) => {
  e.preventDefault();
  const dragging = repoList.querySelector(".repo-item.dragging");
  if (!dragging) return;
  const after = getDragAfterElement(repoList, e.clientY);
  if (after == null) repoList.appendChild(dragging);
  else repoList.insertBefore(dragging, after);
});

function getDragAfterElement(container, y) {
  const els = Array.from(container.querySelectorAll(".repo-item:not(.dragging)"));
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  }
  return closest.element;
}

async function persistRepoOrder() {
  const ids = Array.from(repoList.querySelectorAll(".repo-item")).map((el) => el.dataset.id);
  await electronAPI.reorderRepos(ids);
  await refreshRepoList();
}

function repoKey(r) {
  // Stable per-entry id. Using the id (not alias/slug) lets clones of the same
  // repo be selected, run, reordered, and archived independently.
  return r.id;
}

function selectRepo(repo) {
  selectedRepo = repo;
  highlightSidebarItem(repoKey(repo));
  showReportPanel(repo);
}

function highlightSidebarItem(key) {
  repoList.querySelectorAll(".repo-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === key);
  });
}

// ── Panel switching ────────────────────────────────────────────────────────
// The default landing view: a dashboard of watched projects, or the welcome
// splash when nothing is being watched yet.
function showHome() {
  if (repos.length === 0) showWelcome();
  else showDashboard();
}

function showWelcome() {
  welcome.classList.remove("hidden");
  dashboard.classList.add("hidden");
  reportPanel.classList.add("hidden");
}

function showDashboard() {
  welcome.classList.add("hidden");
  dashboard.classList.remove("hidden");
  reportPanel.classList.add("hidden");
  renderDashboard();
}

// Return to the home view and clear the current selection.
function goHome() {
  selectedRepo = null;
  currentReport = null;
  highlightSidebarItem(null);
  showHome();
}

function renderDashboard() {
  const grid = $("dashboard-grid");
  if (!grid) return;
  grid.innerHTML = "";

  repos.filter((r) => !r.archived).forEach((repo) => {
    const snap = repo.lastSnapshot;
    const a = snap ? snap.analysis : null;
    const label = repo.alias ?? `${repo.workspace}/${repo.repoSlug}`;

    const card = document.createElement("div");
    card.className = "dash-card";
    card.dataset.id = repoKey(repo);

    const branchHtml = repo.branch
      ? `<div class="dash-branch">⑂ ${esc(repo.branch)}</div>`
      : "";

    let statusHtml;
    let bodyHtml;
    if (a) {
      const stalled = a.isStalled;
      statusHtml = `<span class="badge ${stalled ? "stalled" : "active"}">${stalled ? "Stalled" : "Active"}</span>`;
      const pct = a.completionPercentage;
      const color = pct >= 75 ? "var(--green)" : pct >= 40 ? "var(--yellow)" : "var(--red)";
      const bd = a.completionBreakdown;
      const openQ = bd.openQuestionsTotal - bd.openQuestionsResolved;
      const hist = repo.history ?? [];
      const sparkHtml = hist.length >= 2
        ? `<div class="dash-spark" title="Completion over time">${sparkline(hist.map((h) => h.completionPercentage), color, 0, 100, 280, 36, 3)}</div>`
        : "";
      bodyHtml = `
        <div class="dash-completion">
          <div class="completion-bar-bg"><div class="completion-bar-fill" style="width:${pct}%;background:${color}"></div></div>
          <span class="dash-pct" style="color:${color}">${pct}%</span>
        </div>
        ${sparkHtml}
        <div class="dash-stats">
          <div class="dash-stat"><span class="dash-stat-label">Tasks</span><span class="dash-stat-val">${bd.tasksCompleted}/${bd.tasksTotal}</span></div>
          <div class="dash-stat"><span class="dash-stat-label">Open Questions</span><span class="dash-stat-val" style="color:${openQ > 0 ? "var(--yellow)" : "var(--green)"}">${openQ > 0 ? openQ : "None"}</span></div>
        </div>
        <div class="dash-meta">Last run: ${fmtDate(snap.timestamp)}</div>`;
    } else {
      statusHtml = `<span class="badge none">Never run</span>`;
      bodyHtml = `<div class="dash-meta">No report yet — open to run one.</div>`;
    }

    card.innerHTML = `
      <div class="dash-card-head">
        <span class="dash-name">${esc(label)}</span>
        ${statusHtml}
      </div>
      ${branchHtml}
      ${bodyHtml}`;

    card.addEventListener("click", () => selectRepo(repo));
    grid.appendChild(card);
  });
}

function showReportPanel(repo) {
  welcome.classList.add("hidden");
  dashboard.classList.add("hidden");
  reportPanel.classList.remove("hidden");
  reportContent.classList.add("hidden");
  reportError.classList.add("hidden");
  hideProgress();

  // Populate toolbar
  const label = repo.alias ?? `${repo.workspace}/${repo.repoSlug}`;
  $("rt-name").textContent = label;

  const urlEl = $("rt-url");
  urlEl.textContent = repo.url;
  urlEl.onclick = (e) => {
    e.preventDefault();
    electronAPI.openExternal(repo.url);
  };
  $("rt-branch").textContent = repo.branch ? `  ·  branch: ${repo.branch}` : "";

  // If there's a cached snapshot, show it immediately
  if (repo.lastSnapshot) {
    renderReport(repo.lastSnapshot.analysis, null);
  }
}

// ── Progress ───────────────────────────────────────────────────────────────
let progressStep = 0;
function setProgress(msg) {
  progressBar.classList.remove("hidden");
  progressLabel.textContent = msg;
  progressStep = Math.min(progressStep + 30, 90);
  progressInner.style.width = progressStep + "%";
}

function finishProgress() {
  progressInner.style.width = "100%";
  setTimeout(hideProgress, 600);
}

function hideProgress() {
  progressBar.classList.add("hidden");
  progressStep = 0;
  progressInner.style.width = "0%";
}

// ── Run report ─────────────────────────────────────────────────────────────
async function runReport(isDiff) {
  if (isRunning || !selectedRepo) return;
  isRunning = true;
  progressStep = 10;
  setProgress("Starting…");
  reportContent.classList.add("hidden");
  reportError.classList.add("hidden");
  setButtonsDisabled(true);

  const key = repoKey(selectedRepo);
  markRepoLoading(key, true);

  try {
    const hasCreds = await electronAPI.hasCredentials();
    if (!hasCreds) {
      openAuthModal();
      return;
    }

    let res;
    if (isDiff) {
      res = await electronAPI.runDiff(key);
    } else {
      res = await electronAPI.runReport(key);
    }

    if (!res.ok) {
      showError(res.error ?? "Unknown error");
      return;
    }

    const analysis = isDiff ? res.result.current : res.result;
    const diff     = isDiff ? res.result : null;

    currentReport = analysis;
    await refreshRepoList();
    finishProgress();
    renderReport(analysis, diff);
  } catch (e) {
    showError(e.message ?? String(e));
  } finally {
    isRunning = false;
    markRepoLoading(key, false);
    setButtonsDisabled(false);
  }
}

function markRepoLoading(key, loading) {
  const item = repoList.querySelector(`[data-id="${key}"]`);
  if (item) item.classList.toggle("loading", loading);
}

function setButtonsDisabled(disabled) {
  $("btn-run-report").disabled = disabled;
  $("btn-run-diff").disabled   = disabled;
  $("btn-run-all").disabled    = disabled;
}

// ── Render report ──────────────────────────────────────────────────────────
function renderReport(analysis, diff) {
  reportError.classList.add("hidden");
  reportContent.classList.remove("hidden");
  currentReport = analysis;

  // Badge
  const badge = $("status-badge");
  if (analysis.isStalled) {
    badge.textContent = "Stalled";
    badge.className = "badge stalled";
  } else {
    badge.textContent = "Active";
    badge.className = "badge active";
  }

  // Completion bar
  const pct = analysis.completionPercentage;
  $("completion-fill").style.width = pct + "%";
  $("completion-fill").style.background = pct >= 75 ? "var(--green)" : pct >= 40 ? "var(--yellow)" : "var(--red)";
  $("completion-pct").textContent = pct + "%";
  $("completion-pct").style.color = pct >= 75 ? "var(--green)" : pct >= 40 ? "var(--yellow)" : "var(--red)";

  // Tasks / questions
  const bd = analysis.completionBreakdown;
  $("tasks-fraction").textContent     = `${bd.tasksCompleted} / ${bd.tasksTotal}`;

  // Tasks breakdown panel (collapsed by default on each render)
  renderTasksDetail(analysis.tasks ?? []);
  $("tasks-section").classList.add("hidden");
  $("tasks-caret").classList.remove("open");
  $("questions-fraction").textContent = bd.openQuestionsTotal > 0
    ? `${bd.openQuestionsTotal - bd.openQuestionsResolved} open`
    : "None";
  $("questions-fraction").style.color = bd.openQuestionsTotal - bd.openQuestionsResolved > 0
    ? "var(--yellow)" : "var(--green)";

  // Summary & activity
  $("summary-text").textContent  = analysis.summary;
  $("activity-text").textContent = analysis.recentActivity;

  // Trends — pulled from the watched repo's history (fresh copy from `repos`).
  const histRepo = (selectedRepo && repos.find((r) => r.id === selectedRepo.id)) || selectedRepo;
  renderTrends(histRepo && histRepo.history ? histRepo.history : []);

  // Milestones
  const ml = $("milestones-list");
  ml.innerHTML = "";
  if (analysis.keyMilestones.length === 0) {
    ml.innerHTML = `<li style="color:var(--text-3)">No milestones identified yet.</li>`;
  } else {
    analysis.keyMilestones.forEach((m) => {
      const li = document.createElement("li");
      li.textContent = m;
      ml.appendChild(li);
    });
  }

  // Open questions
  const ql = $("questions-list");
  ql.innerHTML = "";
  const unresolved = analysis.openQuestions.filter((q) => !q.resolved);
  if (unresolved.length === 0) {
    ql.innerHTML = `<div class="no-questions">✓ No unresolved questions</div>`;
  } else {
    // Group by category
    const groups = {};
    unresolved.forEach((q) => {
      const cat = q.category ?? "";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(q);
    });

    Object.entries(groups).forEach(([cat, qs]) => {
      const div = document.createElement("div");
      div.className = "q-group";
      if (cat) {
        const catEl = document.createElement("div");
        catEl.className = "q-category";
        catEl.textContent = cat;
        div.appendChild(catEl);
      }
      const ul = document.createElement("ul");
      ul.className = "q-list";
      qs.forEach((q) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="qi">?</span><span>${esc(q.text)}</span>`;
        ul.appendChild(li);
      });
      div.appendChild(ul);
      ql.appendChild(div);
    });
  }

  // Project Artifacts — canonical SpecKit sections other than questions.
  // `?? []` keeps this safe for snapshots cached before this field existed.
  const artifacts = analysis.projectArtifacts ?? [];
  const al = $("artifacts-list");
  const aSummary = $("artifacts-summary");
  al.innerHTML = "";
  if (artifacts.length === 0) {
    aSummary.textContent = "";
    al.innerHTML = `<div class="no-questions" style="color:var(--text-3)">No project artifacts detected in spec.md.</div>`;
  } else {
    const totalItems = artifacts.reduce((n, a) => n + a.items.length, 0);
    aSummary.textContent = `(${totalItems} items across ${artifacts.length} sections)`;
    artifacts.forEach((a) => {
      const div = document.createElement("div");
      div.className = "q-group";
      const head = document.createElement("div");
      head.className = "q-category";
      head.textContent = `${a.kind}  (${a.items.length})`;
      div.appendChild(head);
      const ul = document.createElement("ul");
      ul.className = "q-list";
      a.items.forEach((item) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="qi" style="color:var(--text-3)">•</span><span>${esc(item)}</span>`;
        ul.appendChild(li);
      });
      div.appendChild(ul);
      al.appendChild(div);
    });
  }

  // Consistency / traceability checks
  const consistency = analysis.consistency ?? [];
  const cSection = $("consistency-section");
  const cList = $("consistency-list");
  cList.innerHTML = "";
  if (consistency.length === 0) {
    cSection.classList.add("hidden");
  } else {
    cSection.classList.remove("hidden");
    $("consistency-summary").textContent = `(${consistency.length})`;
    consistency.forEach((f) => {
      const div = document.createElement("div");
      div.className = "finding " + (f.severity === "warn" ? "finding-warn" : "finding-info");
      let inner = `<div class="finding-msg"><span class="finding-icon">${f.severity === "warn" ? "⚠" : "ℹ"}</span><span><strong>${esc(f.kind)}:</strong> ${esc(f.message)}</span></div>`;
      if (f.items && f.items.length) {
        inner += `<ul class="finding-items">${f.items.map((it) => `<li>${esc(it)}</li>`).join("")}</ul>`;
      }
      div.innerHTML = inner;
      cList.appendChild(div);
    });
  }

  // Constitution — principles + AI-flagged concerns
  const principles = analysis.constitution ?? [];
  const concerns = analysis.constitutionConcerns ?? [];
  const constSection = $("constitution-section");
  const constList = $("constitution-list");
  const constConcerns = $("constitution-concerns");
  constList.innerHTML = "";
  constConcerns.innerHTML = "";
  if (principles.length === 0 && concerns.length === 0) {
    constSection.classList.add("hidden");
  } else {
    constSection.classList.remove("hidden");
    $("constitution-summary").textContent = principles.length ? `(${principles.length} principles)` : "";
    if (concerns.length) {
      const box = document.createElement("div");
      box.className = "concern-box";
      box.innerHTML =
        `<div class="concern-head">⚠ Possible concerns vs. constitution</div>` +
        `<ul class="finding-items">${concerns.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`;
      constConcerns.appendChild(box);
    }
    principles.forEach((p) => {
      const div = document.createElement("div");
      div.className = "principle";
      div.innerHTML =
        `<div class="principle-title">§ ${esc(p.title)}</div>` +
        (p.summary ? `<div class="principle-sum">${esc(p.summary)}</div>` : "");
      constList.appendChild(div);
    });
  }

  // Validation checklists
  const checklist = analysis.checklist ?? [];
  const clSection = $("checklist-section");
  const clList = $("checklist-list");
  clList.innerHTML = "";
  if (checklist.length === 0) {
    clSection.classList.add("hidden");
  } else {
    clSection.classList.remove("hidden");
    const total = checklist.reduce((n, g) => n + g.items.length, 0);
    const done = checklist.reduce((n, g) => n + g.items.filter((i) => i.checked).length, 0);
    $("checklist-summary").textContent = `(${done}/${total} passed)`;
    checklist.forEach((g) => {
      const grp = document.createElement("div");
      grp.className = "q-group";
      const head = document.createElement("div");
      head.className = "q-category";
      const gd = g.items.filter((i) => i.checked).length;
      head.textContent = `${g.title}  (${gd}/${g.items.length})`;
      grp.appendChild(head);
      const ul = document.createElement("ul");
      ul.className = "checklist-ul";
      g.items.forEach((it) => {
        const li = document.createElement("li");
        li.className = "checklist-item" + (it.checked ? " done" : "");
        li.innerHTML = `<span class="check-mark">${it.checked ? "✓" : "✗"}</span><span>${esc(it.text)}</span>`;
        ul.appendChild(li);
      });
      grp.appendChild(ul);
      clList.appendChild(grp);
    });
  }

  // Diff section
  const diffSection = $("diff-section");
  if (diff) {
    diffSection.classList.remove("hidden");
    $("diff-timestamp").textContent = `Compared to snapshot from ${fmtDate(diff.previous.timestamp)}`;

    const dl = $("diff-list");
    dl.innerHTML = "";
    if (diff.changes.length === 0) {
      dl.innerHTML = `<li><span class="ci ci-info">●</span><span>No significant changes detected.</span></li>`;
    } else {
      diff.changes.forEach((c) => {
        const icon = c.includes("stalled") ? "ci-warn" :
                     c.includes("resumed") ? "ci-up" :
                     c.includes("increased") ? "ci-up" :
                     c.includes("decreased") ? "ci-down" : "ci-info";
        const symbol = c.includes("increased") || c.includes("resumed") ? "▲" :
                       c.includes("decreased") || c.includes("stalled") ? "▼" : "●";
        const li = document.createElement("li");
        li.innerHTML = `<span class="ci ${icon}">${symbol}</span><span>${esc(c)}</span>`;
        dl.appendChild(li);
      });
    }

    // New open questions
    const nqDiv = $("diff-new-q");
    if (diff.newOpenQuestions.length > 0) {
      nqDiv.classList.remove("hidden");
      const nql = $("diff-new-q-list");
      nql.innerHTML = "";
      diff.newOpenQuestions.forEach((q) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="qi">?</span><span>${esc(q.text)}</span>`;
        nql.appendChild(li);
      });
    } else {
      nqDiv.classList.add("hidden");
    }

    // Resolved questions
    const rqDiv = $("diff-resolved-q");
    if (diff.resolvedQuestions.length > 0) {
      rqDiv.classList.remove("hidden");
      const rql = $("diff-resolved-q-list");
      rql.innerHTML = "";
      diff.resolvedQuestions.forEach((q) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="qi">✓</span><span>${esc(q.text)}</span>`;
        rql.appendChild(li);
      });
    } else {
      rqDiv.classList.add("hidden");
    }
  } else {
    diffSection.classList.add("hidden");
  }

  // Meta
  $("report-meta").textContent = `Generated ${fmtDate(analysis.generatedAt)}`;
}

function showError(msg) {
  reportContent.classList.add("hidden");
  reportError.classList.remove("hidden");
  $("report-error-msg").textContent = msg;
  hideProgress();
}

// ── Tasks breakdown ──────────────────────────────────────────────────────────
function renderTasksDetail(tasks) {
  const wrap = $("tasks-detail");
  const summary = $("tasks-section-summary");
  wrap.innerHTML = "";

  const completed  = tasks.filter((t) => t.status === "completed");
  const incomplete = tasks.filter((t) => t.status !== "completed");
  summary.textContent = `(${completed.length} completed · ${incomplete.length} incomplete)`;

  wrap.appendChild(taskGroup("Incomplete", incomplete, false));
  wrap.appendChild(taskGroup("Completed", completed, true));
}

function taskGroup(title, items, done) {
  const group = document.createElement("div");
  group.className = "q-group";

  const head = document.createElement("div");
  head.className = "task-group-head";
  head.textContent = `${title} (${items.length})`;
  group.appendChild(head);

  const ul = document.createElement("ul");
  ul.className = "task-list";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "task-empty";
    li.textContent = done ? "Nothing completed yet." : "No incomplete tasks.";
    ul.appendChild(li);
  } else {
    items.forEach((t) => {
      const li = document.createElement("li");
      li.className = "task-item" + (done ? " done" : "");
      li.innerHTML = `<span class="task-check">${done ? "✓" : "○"}</span><span>${esc(t.title)}</span>`;
      ul.appendChild(li);
    });
  }
  group.appendChild(ul);
  return group;
}

// Toggle the tasks breakdown from the Tasks hero card.
$("card-tasks").addEventListener("click", () => {
  const sec = $("tasks-section");
  const nowHidden = sec.classList.toggle("hidden");
  $("tasks-caret").classList.toggle("open", !nowHidden);
  if (!nowHidden) sec.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// ── Auth modal ─────────────────────────────────────────────────────────────
function openAuthModal(fromWelcome = false) {
  $("auth-error").classList.add("hidden");
  $("auth-username").value = "";
  $("auth-password").value = "";
  $("auth-github-token").value = "";
  $("auth-modal").classList.remove("hidden");
  $("auth-username").focus();
  $("auth-cancel").classList.toggle("hidden", fromWelcome);
}

$("btn-auth").addEventListener("click", () => openAuthModal(false));

$("auth-cancel").addEventListener("click", () => {
  $("auth-modal").classList.add("hidden");
  isRunning = false;
  setButtonsDisabled(false);
  hideProgress();
});

$("auth-save").addEventListener("click", async () => {
  const username = $("auth-username").value.trim();
  const password = $("auth-password").value.trim();
  const githubToken = $("auth-github-token").value.trim();
  if (!password) {
    showModalError("auth-error", "An app password or access token is required.");
    return;
  }
  if (!githubToken) {
    showModalError("auth-error", "GitHub token is required for Copilot analysis.");
    return;
  }
  $("auth-save").disabled = true;
  $("auth-save").textContent = "Validating…";

  const res = await electronAPI.saveCredentials(username, password, githubToken);
  $("auth-save").disabled = false;
  $("auth-save").textContent = "Save & Validate";

  if (!res.ok) {
    showModalError("auth-error", res.error ?? "Invalid credentials.");
    return;
  }
  $("auth-modal").classList.add("hidden");
  isRunning = false;
  setButtonsDisabled(false);
  hideProgress();
});

// ── Add repo modal ─────────────────────────────────────────────────────────
function openAddModal() {
  $("add-error").classList.add("hidden");
  $("add-url").value    = "";
  $("add-alias").value  = "";
  $("add-branch").value = "";

  // Reset the browse section
  $("add-browse").classList.add("hidden");
  $("browse-list").innerHTML = "";
  $("browse-search").value = "";
  $("browse-status").textContent = "";
  availableRepos = [];
  const hosts = populateBrowseHosts();
  $("browse-host").value = hosts[0] ?? "bitbucket.org";

  $("add-modal").classList.remove("hidden");
  $("add-url").focus();
}

// ── Add-Repo browser ─────────────────────────────────────────────────────────
function populateBrowseHosts() {
  const hosts = [...new Set(repos.map((r) => r.host).filter(Boolean))];
  if (!hosts.includes("bitbucket.org")) hosts.push("bitbucket.org");
  $("browse-hosts").innerHTML = hosts.map((h) => `<option value="${esc(h)}"></option>`).join("");
  return hosts;
}

$("add-browse-btn").addEventListener("click", async () => {
  const panel = $("add-browse");
  const willShow = panel.classList.contains("hidden");
  panel.classList.toggle("hidden");
  if (willShow && availableRepos.length === 0) await loadBrowse();
});

$("browse-load").addEventListener("click", loadBrowse);
$("browse-host").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); loadBrowse(); }
});
$("browse-search").addEventListener("input", renderBrowseList);
$("browse-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); loadBrowse(); }
});

async function loadBrowse() {
  const host = $("browse-host").value.trim();
  const query = $("browse-search").value.trim();
  $("browse-status").textContent = "Loading…";
  $("browse-list").innerHTML = "";
  const res = await electronAPI.listAvailableRepos(host || undefined, query || undefined);
  if (!res.ok) {
    availableRepos = [];
    $("browse-status").textContent = res.error ?? "Could not load repositories.";
    return;
  }
  availableRepos = res.repos ?? [];
  $("browse-status").textContent = availableRepos.length
    ? `${availableRepos.length} repositor${availableRepos.length === 1 ? "y" : "ies"}${availableRepos.length >= 500 ? "+ (refine with the filter)" : ""}.`
    : "No repositories found.";
  renderBrowseList();
}

function renderBrowseList() {
  const term = $("browse-search").value.trim().toLowerCase();
  const list = $("browse-list");
  list.innerHTML = "";
  const filtered = term
    ? availableRepos.filter(
        (r) =>
          r.name.toLowerCase().includes(term) ||
          r.slug.toLowerCase().includes(term) ||
          r.workspace.toLowerCase().includes(term)
      )
    : availableRepos;

  if (filtered.length === 0) {
    list.innerHTML = `<div class="browse-empty">No matches.</div>`;
    return;
  }
  filtered.slice(0, 300).forEach((r) => {
    const row = document.createElement("div");
    row.className = "browse-row";
    row.innerHTML = `<span class="browse-name">${esc(r.name)}</span><span class="browse-pick">Select</span>`;
    row.addEventListener("click", () => {
      $("add-url").value = r.url;
      if (!$("add-alias").value.trim()) $("add-alias").value = r.slug;
      list.querySelectorAll(".browse-row").forEach((el) => el.classList.remove("selected"));
      row.classList.add("selected");
    });
    list.appendChild(row);
  });
}

$("btn-add-repo").addEventListener("click", openAddModal);
$("welcome-add").addEventListener("click", openAddModal);

$("add-cancel").addEventListener("click", () => {
  $("add-modal").classList.add("hidden");
});

$("add-confirm").addEventListener("click", async () => {
  const url    = $("add-url").value.trim();
  const alias  = $("add-alias").value.trim() || undefined;
  const branch = $("add-branch").value.trim() || undefined;
  if (!url) {
    showModalError("add-error", "Please enter a Bitbucket URL.");
    return;
  }
  const res = await electronAPI.addRepo(url, alias, branch);
  if (!res.ok) {
    showModalError("add-error", res.error ?? "Invalid URL.");
    return;
  }
  $("add-modal").classList.add("hidden");
  await refreshRepoList();

  // Select the newly added repo
  const added = repos.find((r) => r.url === url || r.alias === alias);
  if (added) selectRepo(added);
});

// Enter key in modals
["add-url", "add-alias", "add-branch"].forEach((id) => {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("add-confirm").click();
  });
});
["auth-username", "auth-password", "auth-github-token"].forEach((id) => {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("auth-save").click();
  });
});

// ── Remove repo modal ──────────────────────────────────────────────────────
$("btn-remove-repo").addEventListener("click", () => {
  if (!selectedRepo) return;
  const label = selectedRepo.alias ?? `${selectedRepo.workspace}/${selectedRepo.repoSlug}`;
  $("remove-msg").textContent = `Remove "${label}" from your watch list?`;
  $("remove-modal").classList.remove("hidden");
});

$("remove-cancel").addEventListener("click", () => {
  $("remove-modal").classList.add("hidden");
});

$("remove-confirm").addEventListener("click", async () => {
  if (!selectedRepo) return;
  const key = repoKey(selectedRepo);
  await electronAPI.removeRepo(key);
  $("remove-modal").classList.add("hidden");
  selectedRepo = null;
  currentReport = null;
  await refreshRepoList();
  showHome();
});

// ── Change branch modal ──────────────────────────────────────────────────────
let branchTarget = null;

$("btn-edit-branch").addEventListener("click", openBranchModal);

async function openBranchModal() {
  if (!selectedRepo) return;
  branchTarget = repoKey(selectedRepo);

  const sel = $("branch-select");
  sel.innerHTML = `<option value="">(default branch)</option>`;
  sel.disabled = true;
  $("branch-error").classList.add("hidden");
  $("branch-loading").classList.remove("hidden");
  $("branch-save").disabled = true;
  $("branch-modal").classList.remove("hidden");

  const hasCreds = await electronAPI.hasCredentials();
  if (!hasCreds) {
    $("branch-loading").classList.add("hidden");
    showModalError("branch-error", "Set Bitbucket credentials first (🔑 Credentials).");
    return;
  }

  const res = await electronAPI.listBranches(branchTarget);
  $("branch-loading").classList.add("hidden");

  if (!res.ok) {
    showModalError("branch-error", res.error ?? "Could not load branches.");
  } else {
    const branches = res.branches ?? [];
    branches.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = b;
      sel.appendChild(opt);
    });
    const cur = selectedRepo.branch ?? "";
    // Make sure the currently-tracked branch is selectable even if the list
    // didn't include it (e.g. it was deleted remotely or paging missed it).
    if (cur && !branches.includes(cur)) {
      const opt = document.createElement("option");
      opt.value = cur;
      opt.textContent = `${cur} (current)`;
      sel.appendChild(opt);
    }
    sel.value = cur;
  }
  sel.disabled = false;
  $("branch-save").disabled = false;
}

$("branch-cancel").addEventListener("click", () => {
  $("branch-modal").classList.add("hidden");
});

$("branch-save").addEventListener("click", async () => {
  if (!branchTarget) return;
  const branch = $("branch-select").value || undefined;
  await electronAPI.setBranch(branchTarget, branch);
  $("branch-modal").classList.add("hidden");
  await refreshRepoList();

  // Re-bind to the updated repo, then auto-run a fresh report against the new
  // branch so the view reflects the change immediately.
  const updated = repos.find((r) => repoKey(r) === branchTarget);
  if (updated) {
    selectRepo(updated);
    runReport(false);
  }
});

// ── Clone repo ───────────────────────────────────────────────────────────────
$("btn-clone-repo").addEventListener("click", async () => {
  if (!selectedRepo) return;
  const res = await electronAPI.cloneRepo(selectedRepo.id);
  if (!res.ok) return;
  await refreshRepoList();
  const clone = repos.find((r) => r.id === res.id);
  if (clone) {
    selectRepo(clone);
    // A clone usually exists to track a different branch — open the picker.
    openBranchModal();
  }
});

// ── Archive repo ─────────────────────────────────────────────────────────────
$("btn-archive-repo").addEventListener("click", async () => {
  if (!selectedRepo) return;
  await electronAPI.archiveRepo(selectedRepo.id, true);
  await refreshRepoList();
  goHome();
});

// Collapsible archived group in the sidebar.
$("archived-header").addEventListener("click", () => {
  const list = $("archived-list");
  const hidden = list.classList.toggle("hidden");
  $("archived-caret").textContent = hidden ? "▸" : "▾";
});

// ── Home navigation ──────────────────────────────────────────────────────────
$("dash-add").addEventListener("click", openAddModal);
$("sidebar-header").addEventListener("click", goHome);

// ── Report / diff buttons ──────────────────────────────────────────────────
$("btn-run-report").addEventListener("click", () => runReport(false));
$("btn-run-diff").addEventListener("click",   () => runReport(true));

$("btn-run-all").addEventListener("click", async () => {
  if (isRunning) return;
  isRunning = true;
  progressStep = 5;
  setProgress("Running all repos…");
  setButtonsDisabled(true);

  try {
    const hasCreds = await electronAPI.hasCredentials();
    if (!hasCreds) { openAuthModal(false); return; }
    const res = await electronAPI.runAllReports();
    await refreshRepoList();
    finishProgress();

    // Refresh selected repo display if it was in the batch
    if (selectedRepo) {
      const updated = repos.find((r) => repoKey(r) === repoKey(selectedRepo));
      if (updated?.lastSnapshot) {
        renderReport(updated.lastSnapshot.analysis, null);
      }
    }
  } finally {
    isRunning = false;
    setButtonsDisabled(false);
  }
});

// ── Trends ───────────────────────────────────────────────────────────────────
function renderTrends(history) {
  const section = $("trends-section");
  const body = $("trends-body");
  const summ = $("trends-summary");
  body.innerHTML = "";

  const pts = history ?? [];
  if (pts.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");

  if (pts.length < 2) {
    summ.textContent = "";
    body.innerHTML = `<div class="trend-empty">Not enough history yet — trends appear after the second run.</div>`;
    return;
  }
  summ.textContent = `(${pts.length} runs)`;

  const completion = pts.map((p) => p.completionPercentage);
  const tasksDone  = pts.map((p) => p.tasksCompleted);
  const openQ      = pts.map((p) => Math.max(0, p.openQuestionsTotal - p.openQuestionsResolved));
  const tasksMax   = Math.max(1, ...pts.map((p) => p.tasksTotal), ...tasksDone);
  const qMax       = Math.max(1, ...openQ);

  const first = fmtDate(pts[0].timestamp);
  const last  = fmtDate(pts[pts.length - 1].timestamp);
  const lp = pts[pts.length - 1];

  body.appendChild(trendCard("Completion", `${lp.completionPercentage}%`, completion, 0, 100, "var(--green)", first, last));
  body.appendChild(trendCard("Tasks completed", `${lp.tasksCompleted}/${lp.tasksTotal}`, tasksDone, 0, tasksMax, "var(--accent)", first, last));
  body.appendChild(trendCard("Open questions", `${openQ[openQ.length - 1]}`, openQ, 0, qMax, "var(--yellow)", first, last));
}

function trendCard(title, nowText, values, yMin, yMax, color, firstDate, lastDate) {
  const card = document.createElement("div");
  card.className = "trend-card";
  card.innerHTML =
    `<div class="trend-head"><span class="trend-title">${esc(title)}</span><span class="trend-now">${esc(nowText)}</span></div>` +
    `<div class="trend-chart">${sparkline(values, color, yMin, yMax)}</div>` +
    `<div class="trend-axis"><span>${esc(firstDate)}</span><span>${esc(lastDate)}</span></div>`;
  return card;
}

// Build a responsive SVG line chart (area + line + last-point dot).
function sparkline(values, color, yMin, yMax, w = 560, h = 120, pad = 8) {
  const n = values.length;
  if (n < 2) return "";
  const range = (yMax - yMin) || 1;
  const x = (i) => pad + (i / (n - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - yMin) / range) * (h - pad * 2);
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${pad},${(h - pad).toFixed(1)} ${line} ${(w - pad).toFixed(1)},${(h - pad).toFixed(1)}`;
  const lx = x(n - 1).toFixed(1);
  const ly = y(values[n - 1]).toFixed(1);
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" preserveAspectRatio="none">
    <polygon points="${area}" fill="${color}" fill-opacity="0.12" />
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" />
    <circle cx="${lx}" cy="${ly}" r="3.5" fill="${color}" />
  </svg>`;
}

// ── Report / digest serialization ────────────────────────────────────────────
function fileSlug(repo) {
  const base = (repo && (repo.alias ?? `${repo.workspace}-${repo.repoSlug}`)) || "speckit";
  return base.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "report";
}

function displayedReport() {
  const a = currentReport;
  const repo = (selectedRepo && repos.find((r) => r.id === selectedRepo.id)) || selectedRepo;
  return { a, repo };
}

function reportToMarkdown(a, repo, level = "detailed") {
  const L = [];
  const title = (repo && repo.alias) ? repo.alias : a.repoUrl;
  const bd = a.completionBreakdown;
  L.push(`# SpecKit Report — ${title}`, "");
  L.push(`- **Repo:** ${a.repoUrl}`);
  if (repo && repo.branch) L.push(`- **Branch:** ${repo.branch}`);
  L.push(`- **Generated:** ${fmtDate(a.generatedAt)}`);
  L.push(`- **Status:** ${a.isStalled ? "Stalled" : "Active"}${a.isStalled && a.stalledReason ? ` (${a.stalledReason})` : ""}`);
  L.push(`- **Completion:** ${a.completionPercentage}%`);
  L.push(`- **Tasks:** ${bd.tasksCompleted}/${bd.tasksTotal} completed`);
  L.push(`- **Open questions:** ${bd.openQuestionsTotal - bd.openQuestionsResolved} open of ${bd.openQuestionsTotal}`, "");
  L.push(`## Summary`, a.summary || "—", "");
  L.push(`## Recent Activity`, a.recentActivity || "—", "");
  if ((a.keyMilestones || []).length) {
    L.push(`## Key Milestones & Next Steps`);
    a.keyMilestones.forEach((m) => L.push(`- ${m}`));
    L.push("");
  }
  const cons = a.consistency ?? [];
  if (cons.length) {
    L.push(`## Consistency Checks`);
    cons.forEach((f) => {
      L.push(`- **${f.kind}:** ${f.message}`);
      (f.items || []).slice(0, 10).forEach((it) => L.push(`  - ${it}`));
    });
    L.push("");
  }
  const open = (a.openQuestions || []).filter((q) => !q.resolved);
  L.push(`## Open Questions`);
  if (!open.length) L.push("_None unresolved._");
  else open.forEach((q) => L.push(`- ${q.category ? `[${q.category}] ` : ""}${q.text}`));
  L.push("");
  const arts = a.projectArtifacts ?? [];
  if (level !== "simple" && arts.length) {
    L.push(`## Project Artifacts`);
    arts.forEach((g) => { L.push(`### ${g.kind}`); g.items.forEach((it) => L.push(`- ${it}`)); });
    L.push("");
  }
  const princ = a.constitution ?? [];
  const concerns = a.constitutionConcerns ?? [];
  if (princ.length || concerns.length) {
    L.push(`## Constitution`);
    if (concerns.length) { L.push(`**Possible concerns:**`); concerns.forEach((c) => L.push(`- ⚠ ${c}`)); }
    princ.forEach((p) => L.push(`- **${p.title}**${p.summary ? ` — ${p.summary}` : ""}`));
    L.push("");
  }
  const cl = a.checklist ?? [];
  if (cl.length) {
    const total = cl.reduce((n, g) => n + g.items.length, 0);
    const done = cl.reduce((n, g) => n + g.items.filter((i) => i.checked).length, 0);
    L.push(`## Validation Checklists (${done}/${total} passed)`);
    cl.forEach((g) => { L.push(`### ${g.title}`); g.items.forEach((it) => L.push(`- [${it.checked ? "x" : " "}] ${it.text}`)); });
    L.push("");
  }
  const tasks = a.tasks ?? [];
  if (tasks.length) {
    L.push(`## Tasks`);
    tasks.forEach((t) => L.push(`- [${t.status === "completed" ? "x" : " "}] ${t.title}`));
    L.push("");
  }
  return L.join("\n");
}

function reportToHtml(a, repo, level = "detailed") {
  const title = (repo && repo.alias) ? repo.alias : a.repoUrl;
  const bd = a.completionBreakdown;
  const open = (a.openQuestions || []).filter((q) => !q.resolved);
  const sec = [];
  sec.push(`<h2>Summary</h2><p>${esc(a.summary || "—")}</p>`);
  sec.push(`<h2>Recent Activity</h2><p>${esc(a.recentActivity || "—")}</p>`);
  if ((a.keyMilestones || []).length)
    sec.push(`<h2>Key Milestones &amp; Next Steps</h2><ul>${a.keyMilestones.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`);
  const cons = a.consistency ?? [];
  if (cons.length)
    sec.push(`<h2>Consistency Checks</h2>${cons.map((f) => `<p><b>${esc(f.kind)}:</b> ${esc(f.message)}</p>${(f.items || []).length ? `<ul>${f.items.slice(0, 10).map((it) => `<li>${esc(it)}</li>`).join("")}</ul>` : ""}`).join("")}`);
  sec.push(`<h2>Open Questions</h2>${open.length ? `<ul>${open.map((q) => `<li>${q.category ? `[${esc(q.category)}] ` : ""}${esc(q.text)}</li>`).join("")}</ul>` : `<p><i>None unresolved.</i></p>`}`);
  const arts = a.projectArtifacts ?? [];
  if (level !== "simple" && arts.length)
    sec.push(`<h2>Project Artifacts</h2>${arts.map((g) => `<h3>${esc(g.kind)}</h3><ul>${g.items.map((it) => `<li>${esc(it)}</li>`).join("")}</ul>`).join("")}`);
  const princ = a.constitution ?? [];
  const concerns = a.constitutionConcerns ?? [];
  if (princ.length || concerns.length) {
    let h = `<h2>Constitution</h2>`;
    if (concerns.length) h += `<p><b>Possible concerns:</b></p><ul>${concerns.map((c) => `<li>⚠ ${esc(c)}</li>`).join("")}</ul>`;
    if (princ.length) h += `<ul>${princ.map((p) => `<li><b>${esc(p.title)}</b>${p.summary ? ` — ${esc(p.summary)}` : ""}</li>`).join("")}</ul>`;
    sec.push(h);
  }
  const cl = a.checklist ?? [];
  if (cl.length) {
    const total = cl.reduce((n, g) => n + g.items.length, 0);
    const done = cl.reduce((n, g) => n + g.items.filter((i) => i.checked).length, 0);
    sec.push(`<h2>Validation Checklists (${done}/${total} passed)</h2>${cl.map((g) => `<h3>${esc(g.title)}</h3><ul>${g.items.map((it) => `<li>${it.checked ? "☑" : "☐"} ${esc(it.text)}</li>`).join("")}</ul>`).join("")}`);
  }
  const tasks = a.tasks ?? [];
  if (tasks.length)
    sec.push(`<h2>Tasks</h2><ul>${tasks.map((t) => `<li>${t.status === "completed" ? "☑" : "☐"} ${esc(t.title)}</li>`).join("")}</ul>`);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{font-family:-apple-system,"Segoe UI",system-ui,sans-serif;color:#1a1a1a;margin:32px;line-height:1.5;font-size:13px;}
  h1{font-size:22px;margin:0 0 4px;}
  h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px;color:#16325c;}
  h3{font-size:13px;margin:12px 0 4px;color:#444;}
  ul{margin:4px 0 4px 18px;padding:0;} li{margin:2px 0;}
  p{margin:4px 0;}
  .meta{color:#555;font-size:12px;margin-bottom:12px;} .meta b{color:#222;}
</style></head><body>
<h1>SpecKit Report — ${esc(title)}</h1>
<div class="meta">
  <div><b>Repo:</b> ${esc(a.repoUrl)}</div>
  ${repo && repo.branch ? `<div><b>Branch:</b> ${esc(repo.branch)}</div>` : ""}
  <div><b>Generated:</b> ${esc(fmtDate(a.generatedAt))}</div>
  <div><b>Status:</b> ${a.isStalled ? "Stalled" : "Active"} &nbsp; <b>Completion:</b> ${a.completionPercentage}% &nbsp; <b>Tasks:</b> ${bd.tasksCompleted}/${bd.tasksTotal} &nbsp; <b>Open Q:</b> ${bd.openQuestionsTotal - bd.openQuestionsResolved}</div>
</div>
${sec.join("\n")}
</body></html>`;
}

function digestToMarkdown(list) {
  const L = [`# SpecKit Digest — ${fmtDate(new Date().toISOString())}`, ""];
  if (!list.length) { L.push("_No active repos._"); return L.join("\n"); }
  list.forEach((repo) => {
    const a = repo.lastSnapshot && repo.lastSnapshot.analysis;
    const label = repo.alias ?? `${repo.workspace}/${repo.repoSlug}`;
    if (!a) { L.push(`## ${label}`, "- _Never run_", ""); return; }
    const bd = a.completionBreakdown;
    const openQ = bd.openQuestionsTotal - bd.openQuestionsResolved;
    L.push(`## ${label}${repo.branch ? ` (\`${repo.branch}\`)` : ""}`);
    L.push(`- **Status:** ${a.isStalled ? "⚠ Stalled" : "✅ Active"} · **Completion:** ${a.completionPercentage}% · **Tasks:** ${bd.tasksCompleted}/${bd.tasksTotal} · **Open Q:** ${openQ}`);
    if (a.summary) L.push(`- ${a.summary}`);
    L.push(`- _Last run: ${fmtDate(repo.lastSnapshot.timestamp)}_`, "");
  });
  return L.join("\n");
}

// ── Export modal ─────────────────────────────────────────────────────────────
let exportLevel = "detailed"; // "simple" omits Project Artifacts

$("btn-export").addEventListener("click", () => {
  if (!currentReport) return;
  $("export-modal").classList.remove("hidden");
});
$("export-cancel").addEventListener("click", () => $("export-modal").classList.add("hidden"));

// Simple / Detailed segmented toggle
$("export-level").querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    exportLevel = btn.dataset.level;
    $("export-level").querySelectorAll(".seg-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.level === exportLevel)
    );
  });
});

$("export-md").addEventListener("click", async () => {
  const { a, repo } = displayedReport();
  if (!a) return;
  await electronAPI.exportFile(reportToMarkdown(a, repo, exportLevel), `${fileSlug(repo)}-report-${exportLevel}.md`, "md");
  $("export-modal").classList.add("hidden");
});
$("export-pdf").addEventListener("click", async () => {
  const { a, repo } = displayedReport();
  if (!a) return;
  await electronAPI.exportPdf(reportToHtml(a, repo, exportLevel), `${fileSlug(repo)}-report-${exportLevel}.pdf`);
  $("export-modal").classList.add("hidden");
});
$("export-copy").addEventListener("click", async () => {
  const { a, repo } = displayedReport();
  if (!a) return;
  await electronAPI.copyText(reportToMarkdown(a, repo, exportLevel));
  $("export-modal").classList.add("hidden");
});

// ── Digest modal ─────────────────────────────────────────────────────────────
$("dash-digest").addEventListener("click", openDigestModal);

async function openDigestModal() {
  const active = repos.filter((r) => !r.archived);
  $("digest-preview").value = digestToMarkdown(active);
  $("digest-status").textContent = "";
  const wh = await electronAPI.getWebhook();
  $("digest-webhook").value = (wh && wh.url) || "";
  $("digest-modal").classList.remove("hidden");
}
$("digest-close").addEventListener("click", () => $("digest-modal").classList.add("hidden"));
$("digest-copy").addEventListener("click", async () => {
  await electronAPI.copyText($("digest-preview").value);
  $("digest-status").textContent = "Copied to clipboard.";
});
$("digest-save").addEventListener("click", async () => {
  const res = await electronAPI.exportFile($("digest-preview").value, "speckit-digest.md", "md");
  if (res.ok) $("digest-status").textContent = "Saved.";
});
$("digest-send").addEventListener("click", async () => {
  const url = $("digest-webhook").value.trim();
  await electronAPI.saveWebhook(url);
  if (!url) { $("digest-status").textContent = "Enter a webhook URL first."; return; }
  $("digest-status").textContent = "Sending…";
  const res = await electronAPI.sendWebhook($("digest-preview").value, url);
  $("digest-status").textContent = res.ok ? "Sent to webhook ✓" : `Send failed: ${res.error ?? "unknown error"}`;
});

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function showModalError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove("hidden");
}
