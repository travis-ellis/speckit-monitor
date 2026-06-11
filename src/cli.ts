import { Command } from "commander";
import * as readline from "readline";
import { parseRepoUrl, fetchSpecKitData, validateCredentials } from "./bitbucket";
import { RepoConfig, BitbucketCredentials } from "./types";
import { analyzeRepo, analyzeRepoDiff } from "./analyzer";
import {
  getCredentials,
  saveCredentials,
  getGitHubToken,
  saveGitHubToken,
  listRepos,
  addRepo,
  removeRepo,
  getRepo,
  saveSnapshot,
  getLastSnapshot,
} from "./state";
import {
  printReport,
  printDiffReport,
  printRepoList,
  printError,
  printSuccess,
  printInfo,
} from "./reporter";
import chalk from "chalk";

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  if (hidden && process.stdin.isTTY) {
    (process.stdout as NodeJS.WriteStream).write(question);
    process.stdin.setRawMode(true);
    let result = "";
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    await new Promise<void>((resolve) => {
      process.stdin.on("data", (char: string) => {
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n");
          resolve();
        } else if (char === "") {
          process.exit();
        } else if (char === "") {
          result = result.slice(0, -1);
        } else {
          result += char;
        }
      });
    });
    rl.close();
    return result;
  }

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function ensureBitbucketCredentials(
  config: RepoConfig
): Promise<BitbucketCredentials> {
  const creds = getCredentials();
  if (creds) return creds;

  printInfo(`No Bitbucket credentials found. Let's set them up for ${config.host}.`);
  if (config.kind === "cloud") {
    console.log(chalk.gray("  Create an App Password at: https://bitbucket.org/account/settings/app-passwords/"));
    console.log(chalk.gray("  Required scope: Repositories (Read)\n"));
  } else {
    console.log(chalk.gray(`  Create an HTTP access token in ${config.host} → Manage account → HTTP access tokens (Repository Read).`));
    console.log(chalk.gray("  Leave the username blank to authenticate with the token as a Bearer token,"));
    console.log(chalk.gray("  or enter your username to use Basic auth.\n"));
  }

  const username = await prompt("  Username (blank for token / Bearer auth): ");
  const secret = await prompt("  App password / access token: ", true);

  const valid = await validateCredentials({ username, secret }, config);
  if (!valid) {
    printError(`Invalid credentials for ${config.host}. Please check your username/token.`);
    process.exit(1);
  }

  saveCredentials(username, secret);
  printSuccess("Bitbucket credentials saved.");
  return { username, secret };
}

async function ensureGitHubToken(): Promise<void> {
  if (getGitHubToken()) return;

  printInfo("No GitHub token found. This is needed for Copilot (GitHub Models) analysis.");
  console.log(chalk.gray("  Create a token at: https://github.com/settings/tokens"));
  console.log(chalk.gray("  Required scope: No specific scope needed for GitHub Models (public access)"));
  console.log(chalk.gray("  Or set the GITHUB_TOKEN environment variable to skip this prompt.\n"));

  const token = await prompt("  GitHub Personal Access Token: ", true);
  if (!token) {
    printError("GitHub token is required for AI analysis.");
    process.exit(1);
  }

  saveGitHubToken(token);
  printSuccess("GitHub token saved.");
}

async function runReport(urlOrAlias: string, isDiff: boolean): Promise<void> {
  const existing = getRepo(urlOrAlias);
  let config: RepoConfig;
  try {
    config = parseRepoUrl(existing?.url ?? urlOrAlias);
    config.alias = existing?.alias;
    // Use the branch stored on the watched repo (set via `add --branch`).
    config.branch = existing?.branch;
  } catch {
    printError(`Cannot find or parse repo: ${urlOrAlias}`);
    process.exit(1);
  }
  if (!existing) addRepo(config);

  const creds = await ensureBitbucketCredentials(config);
  await ensureGitHubToken();

  console.log(chalk.gray(`\n  Fetching data from Bitbucket...`));
  let data;
  try {
    data = await fetchSpecKitData(creds, config);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("401") || msg.includes("403")) {
      printError("Authentication failed. Run `speckit-monitor auth` to update credentials.");
    } else if (msg.includes("404")) {
      printError(`Repository not found or .specify/ directory missing: ${config.url}`);
    } else {
      printError(`Failed to fetch repo data: ${msg}`);
    }
    process.exit(1);
  }

  if (isDiff) {
    const lastSnapshot = getLastSnapshot(config);
    if (!lastSnapshot) {
      printInfo("No previous snapshot found. Running full report and saving as baseline.");
      console.log(chalk.gray("  Analyzing with GitHub Copilot (gpt-4o)..."));
      const analysis = await analyzeRepo(data, config);
      saveSnapshot(config, analysis, data);
      printReport(analysis);
      return;
    }
    console.log(chalk.gray("  Analyzing changes with GitHub Copilot (gpt-4o)..."));
    const diff = await analyzeRepoDiff(data, config, lastSnapshot);
    saveSnapshot(config, diff.current, data);
    printDiffReport(diff);
  } else {
    console.log(chalk.gray("  Analyzing with GitHub Copilot (gpt-4o)..."));
    const analysis = await analyzeRepo(data, config);
    saveSnapshot(config, analysis, data);
    printReport(analysis);
  }
}

export function buildCLI(): Command {
  const program = new Command();

  program
    .name("speckit-monitor")
    .description("Monitor SpecKit-driven Bitbucket repos for product managers")
    .version("1.0.0");

  program
    .command("report [repo]")
    .description("Run a full report for a repo (or all watched repos if none specified)")
    .option("-a, --alias <name>", "Alias to identify the repo")
    .option("-b, --branch <name>", "Branch to read SpecKit content from (persists on the watched repo)")
    .action(async (repo: string | undefined, opts: { alias?: string; branch?: string }) => {
      if (repo) {
        if (opts.alias || opts.branch) {
          const cfg = parseRepoUrl(getRepo(repo)?.url ?? repo);
          if (opts.alias) cfg.alias = opts.alias;
          if (opts.branch) cfg.branch = opts.branch;
          addRepo(cfg);
        }
        await runReport(repo, false);
      } else {
        const repos = listRepos();
        if (repos.length === 0) {
          printInfo("No repos being watched. Use `add <url>` or `report <url>` to get started.");
          return;
        }
        for (const r of repos) {
          await runReport(r.alias ?? r.url, false);
        }
      }
    });

  program
    .command("diff [repo]")
    .description("Run a diff report showing what changed since the last run")
    .action(async (repo: string | undefined) => {
      if (repo) {
        await runReport(repo, true);
      } else {
        const repos = listRepos();
        if (repos.length === 0) {
          printInfo("No repos being watched. Use `add <url>` first.");
          return;
        }
        for (const r of repos) {
          await runReport(r.alias ?? r.url, true);
        }
      }
    });

  program
    .command("add <url>")
    .description("Add a Bitbucket repo to the watch list")
    .option("-a, --alias <name>", "Human-friendly alias for this repo")
    .option("-b, --branch <name>", "Branch to monitor (e.g. 001-some-feature). Defaults to the repo's default branch.")
    .action(async (url: string, opts: { alias?: string; branch?: string }) => {
      try {
        const config = parseRepoUrl(url);
        if (opts.alias) config.alias = opts.alias;
        if (opts.branch) config.branch = opts.branch;
        addRepo(config);
        const label = opts.alias ?? `${config.workspace}/${config.repoSlug}`;
        const branchSuffix = opts.branch ? ` (branch: ${opts.branch})` : "";
        printSuccess(`Added ${label}${branchSuffix} to watch list.`);
      } catch (e) {
        printError(`Invalid URL: ${url}`);
      }
    });

  program
    .command("remove <urlOrAlias>")
    .description("Remove a repo from the watch list")
    .action((urlOrAlias: string) => {
      const removed = removeRepo(urlOrAlias);
      if (removed) {
        printSuccess(`Removed "${urlOrAlias}" from watch list.`);
      } else {
        printError(`Repo not found: "${urlOrAlias}"`);
      }
    });

  program
    .command("list")
    .description("List all watched repos and their last-run status")
    .action(() => {
      const repos = listRepos();
      printRepoList(repos);
    });

  program
    .command("auth")
    .description("Set or update Bitbucket and GitHub credentials")
    .action(async () => {
      // Bitbucket — validate against the host of the first watched repo, if any.
      const watched = listRepos();
      let validateConfig: RepoConfig | null = null;
      for (const r of watched) {
        try {
          validateConfig = parseRepoUrl(r.url);
          break;
        } catch {
          /* skip */
        }
      }

      console.log(chalk.bold.cyan("\n  Bitbucket credentials"));
      if (!validateConfig || validateConfig.kind === "cloud") {
        console.log(chalk.gray("  Cloud: create an App Password at https://bitbucket.org/account/settings/app-passwords/ (Repositories: Read)."));
      }
      if (!validateConfig || validateConfig.kind === "server") {
        console.log(chalk.gray("  Server: create an HTTP access token (Repository Read). Leave username blank to use it as a Bearer token."));
      }
      const username = await prompt("  Username (blank for token / Bearer auth): ");
      const secret = await prompt("  App password / access token: ", true);
      if (validateConfig) {
        const valid = await validateCredentials({ username, secret }, validateConfig);
        if (!valid) {
          printError(`Invalid Bitbucket credentials for ${validateConfig.host}.`);
          process.exit(1);
        }
      }
      saveCredentials(username, secret);
      printSuccess("Bitbucket credentials updated.");

      // GitHub
      console.log(chalk.bold.cyan("\n  GitHub Personal Access Token (for Copilot / GitHub Models)"));
      console.log(chalk.gray("  https://github.com/settings/tokens"));
      console.log(chalk.gray("  No specific scopes required for GitHub Models public access.\n"));
      const token = await prompt("  GitHub token: ", true);
      if (token) {
        saveGitHubToken(token);
        printSuccess("GitHub token updated.");
      } else {
        printInfo("GitHub token skipped (set GITHUB_TOKEN env var when running).");
      }
    });

  return program;
}
