const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false,
    webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, 'icon.html'));
  await new Promise(r => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(process.argv[2] || '/tmp/prime-icon-new.png', img.toPNG());
  console.log('ICON WRITTEN');
  app.quit();
});