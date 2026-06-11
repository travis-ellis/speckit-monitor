import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // Repo management
  getRepos: () => ipcRenderer.invoke("get-repos"),
  addRepo: (url: string, alias?: string, branch?: string) =>
    ipcRenderer.invoke("add-repo", url, alias, branch),
  removeRepo: (id: string) =>
    ipcRenderer.invoke("remove-repo", id),
  setBranch: (id: string, branch?: string) =>
    ipcRenderer.invoke("set-branch", id, branch),
  listBranches: (id: string) =>
    ipcRenderer.invoke("list-branches", id),
  cloneRepo: (id: string) =>
    ipcRenderer.invoke("clone-repo", id),
  archiveRepo: (id: string, archived: boolean) =>
    ipcRenderer.invoke("archive-repo", id, archived),
  reorderRepos: (orderedIds: string[]) =>
    ipcRenderer.invoke("reorder-repos", orderedIds),

  // Browse repositories available to add
  listAvailableRepos: (host?: string, query?: string) =>
    ipcRenderer.invoke("list-available-repos", { host, query }),

  // Open an external URL in the system browser
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),

  // Export & digest
  exportFile: (content: string, defaultName: string, kind?: "md" | "txt") =>
    ipcRenderer.invoke("export-file", { content, defaultName, kind }),
  exportPdf: (html: string, defaultName: string) =>
    ipcRenderer.invoke("export-pdf", { html, defaultName }),
  copyText: (text: string) => ipcRenderer.invoke("copy-text", text),
  getWebhook: () => ipcRenderer.invoke("get-webhook"),
  saveWebhook: (url: string) => ipcRenderer.invoke("save-webhook", url),
  sendWebhook: (text: string, url?: string) =>
    ipcRenderer.invoke("send-webhook", { text, url }),

  // Analysis
  runReport: (urlOrAlias: string) =>
    ipcRenderer.invoke("run-report", urlOrAlias),
  runDiff: (urlOrAlias: string) =>
    ipcRenderer.invoke("run-diff", urlOrAlias),
  runAllReports: () => ipcRenderer.invoke("run-all-reports"),

  // Credentials — now includes githubToken as third arg
  hasCredentials: () => ipcRenderer.invoke("has-credentials"),
  hasGitHubToken: () => ipcRenderer.invoke("has-github-token"),
  saveCredentials: (username: string, secret: string, githubToken: string) =>
    ipcRenderer.invoke("save-credentials", username, secret, githubToken),
  validateCredentials: (username: string, secret: string) =>
    ipcRenderer.invoke("validate-credentials", username, secret),

  // Progress events from main process
  onProgress: (callback: (message: string) => void) => {
    ipcRenderer.on("progress", (_event, message: string) => callback(message));
  },
  offProgress: () => {
    ipcRenderer.removeAllListeners("progress");
  },
});
