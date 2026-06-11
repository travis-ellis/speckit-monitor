// Render mockup/mockup.html to a PNG using Electron's offscreen capture.
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

const W = 1440;
const H = 900;
const OUT = path.join(__dirname, "..", "mockup", "speckit-monitor.png");

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false, offscreen: false },
  });

  await win.loadFile(path.join(__dirname, "..", "mockup", "mockup.html"));
  // Give fonts/layout a moment to settle before capturing.
  await new Promise((r) => setTimeout(r, 800));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUT, image.toPNG());
  const size = image.getSize();
  console.log(`WROTE ${OUT} (${size.width}x${size.height})`);

  win.destroy();
  app.quit();
});
