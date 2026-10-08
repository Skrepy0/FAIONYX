// Run with: node_modules/.bin/electron scripts/desktop-smoke.cjs [--force-device-scale-factor=1.5]
// Isolated app settings; registered game roots are scanned read-only. No account secrets are copied.
const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const qaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'faionyx-ui-068-'));
const existing = path.join(app.getPath('appData'), 'faionyx', 'settings.json');
const settings = fs.existsSync(existing) ? JSON.parse(fs.readFileSync(existing, 'utf8')) : {};
app.setPath('userData', qaRoot);
if (process.argv.includes('--qa-slow-init') || process.argv.includes('--qa-mod-fixture')) {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) =>
    handle(channel, async (...args) => {
      if (channel === 'settings:get' && process.argv.includes('--qa-slow-init')) await new Promise((resolve) => setTimeout(resolve, 10000));
      if (channel === 'app:selectFile' && process.argv.includes('--qa-mod-fixture')) return qaMod;
      return listener(...args);
    });
}
fs.writeFileSync(
  path.join(qaRoot, 'settings.json'),
  JSON.stringify({
    theme: 'transparent',
    folders: settings.folders,
    gameDir: settings.gameDir,
    activeFolder: settings.activeFolder,
    memoryMB: settings.memoryMB,
    javaAuto: true,
    closeAfterLaunch: false,
  })
);
console.log('QA_USER_DATA=' + qaRoot);
const AdmZip = require('adm-zip');
const mod = new AdmZip();
mod.addFile(
  'META-INF/neoforge.mods.toml',
  Buffer.from(
    '[[mods]]\nmodId="faionyx_compatibility_fixture"\ndisplayName="兼容识别验收样本（仅元数据，不可用于游戏）"\nversion="1.0"\n[[dependencies.faionyx_compatibility_fixture]]\nmodId="minecraft"\nversionRange="[26.2]"\n[[dependencies.faionyx_compatibility_fixture]]\nmodId="neoforge"\nversionRange="[26.2.0.57,26.3)"'
  )
);
const qaMod = path.join(qaRoot, 'compatibility-fixture.jar');
mod.writeZip(qaMod);
console.log('QA_MOD_FIXTURE=' + qaMod);
app.on('browser-window-created', (_event, window) => {
  if (window.getTitle().includes('正在启动')) return;
  if (process.argv.includes('--qa-small')) window.setSize(960, 620);
  window.on('show', () => {
    window.setTitle('FAIONYX 0.6.8 · UI 验收');
    // Read-only layout diagnostics; UI interactions are performed through the native window.
    window.webContents
      .executeJavaScript(
        `JSON.stringify({ dpr: devicePixelRatio, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, text: document.querySelector('.hero-metadata')?.textContent?.trim(), instances: [...document.querySelectorAll('.instance-copy strong')].map(e=>({text:e.textContent,title:e.title,width:e.getBoundingClientRect().width})) })`
      )
      .then((value) => console.log('QA_LAYOUT=' + value));
  });
});
require('../out/main/index.js');
