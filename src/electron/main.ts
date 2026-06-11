import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "path";
import { registerIpcHandlers } from "./ipc-handlers";

// ── Portable mode: redirect Electron's own userData next to the exe ────────
// Must happen before app.whenReady().
const portableDir =
  process.env.SPECKIT_DATA_DIR ??
  process.env.PORTABLE_EXECUTABLE_DIR ??
  null;

if (portableDir) {
  app.setPath("userData", path.join(portableDir, ".speckit-data"));
  app.setPath("logs",     path.join(portableDir, ".speckit-data", "logs"));
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "default",
    title: "SpecKit Monitor",
    backgroundColor: "#1a1d2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: undefined,
    show: false,
  });

  mainWindow.loadFile(
    path.join(__dirname, "..", "..", "renderer", "index.html")
  );

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function sendProgress(message: string): void {
  mainWindow?.webContents.send("progress", message);
}

app.whenReady().then(() => {
  registerIpcHandlers(ipcMain, sendProgress);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
