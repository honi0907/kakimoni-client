const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');

let launcherWin = null;
let mainWin     = null;
let displayWin  = null;
let currentServerUrl = '';

function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(v => parseInt(v, 10) || 0);
  const pb = String(b || '').split('.').map(v => parseInt(v, 10) || 0);
  const max = Math.max(pa.length, pb.length);
  for (let i = 0; i < max; i++) {
    const av = pa[i] || 0;
    const bv = pb[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function sha256OfFile(filePath) {
  const hash = crypto.createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return hash.digest('hex');
}

function fetchJson(urlStr) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const client = urlObj.protocol === 'https:' ? https : http;
    const req = client.get(urlObj, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, urlStr).toString();
        res.resume();
        return resolve(fetchJson(nextUrl));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
  });
}

function downloadFile(urlStr, targetPath) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const client = urlObj.protocol === 'https:' ? https : http;
    const req = client.get(urlObj, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, urlStr).toString();
        res.resume();
        return resolve(downloadFile(nextUrl, targetPath));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(targetPath);
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => resolve(targetPath));
      });
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

function createLauncher() {
  launcherWin = new BrowserWindow({
    width: 520,
    height: 640,
    minWidth: 420,
    minHeight: 560,
    resizable: true,
    title: 'KakiMoni 子機',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  launcherWin.setMenuBarVisibility(false);
  launcherWin.loadFile(path.join(__dirname, 'launcher.html'));
  launcherWin.on('closed', () => app.quit());
}

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.on('open-test', (event, { seatId }) => {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    title: `KakiMoni テストモード 席${seatId}`,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'test-canvas.html'), { query: { seat: seatId } });
});

ipcMain.on('open-main', (event, { serverUrl }) => {
  currentServerUrl = serverUrl;
  // preload付きの別ウィンドウでクライアント画面を開く
  mainWin = new BrowserWindow({
    width: 1200,
    height: 920,
    title: 'KakiMoni 子機',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadURL(`${serverUrl}/client?serverUrl=${encodeURIComponent(serverUrl)}`);
  mainWin.on('closed', () => {
    mainWin = null;
    app.quit();
  });
  launcherWin.hide();
});

// 設定画面からランチャーに戻る
ipcMain.on('go-to-launcher', () => {
  if (displayWin) {
    displayWin.removeAllListeners('closed');
    displayWin.destroy();
    displayWin = null;
  }
  if (mainWin) {
    mainWin.removeAllListeners('closed');
    mainWin.destroy();
    mainWin = null;
  }
  launcherWin.setSize(520, 640);
  launcherWin.center();
  launcherWin.show();
  launcherWin.loadFile(path.join(__dirname, 'launcher.html'));
});

ipcMain.handle('check-client-update', async (event, { serverUrl }) => {
  try {
    const base = String(serverUrl || '').trim().replace(/\/$/, '');
    if (!base) return { ok: false, error: 'サーバーURLが空です。' };
    const latest = await fetchJson(`${base}/api/update/client/latest`);
    if (!latest || !latest.ok) {
      return { ok: false, error: latest?.error || '更新情報がありません。' };
    }
    const currentVersion = app.getVersion();
    const latestVersion = String(latest.version || '0.0.0');
    const available = compareVersions(latestVersion, currentVersion) > 0;
    return {
      ok: true,
      available,
      currentVersion,
      latestVersion,
      fileName: latest.fileName,
      size: latest.size || 0,
      sha256: latest.sha256 || '',
      notes: latest.notes || '',
      downloadPath: latest.downloadPath,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('download-client-update', async (event, { serverUrl, fileName, downloadPath, sha256 }) => {
  try {
    const base = String(serverUrl || '').trim().replace(/\/$/, '');
    if (!base) return { ok: false, error: 'サーバーURLが空です。' };
    const safeName = path.basename(String(fileName || 'update.exe'));
    const relPath = downloadPath || `/api/update/client/file/${encodeURIComponent(safeName)}`;
    const url = new URL(relPath, `${base}/`).toString();

    const tempDir = app.getPath('temp');
    const targetPath = path.join(tempDir, `kakimoni-client-update-${Date.now()}.exe`);
    await downloadFile(url, targetPath);

    if (sha256) {
      const actual = sha256OfFile(targetPath);
      if (actual.toLowerCase() !== String(sha256).toLowerCase()) {
        try { fs.unlinkSync(targetPath); } catch {}
        return { ok: false, error: 'SHA256不一致のため更新を中止しました。' };
      }
    }

    return { ok: true, downloadedPath: targetPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('apply-client-update', async (event, { downloadedPath }) => {
  try {
    if (!app.isPackaged) {
      return { ok: false, error: '開発モードでは自己更新を実行できません。' };
    }
    if (!downloadedPath || !fs.existsSync(downloadedPath)) {
      return { ok: false, error: '更新ファイルが見つかりません。' };
    }

    const currentExePath = process.execPath;
    const backupExePath = `${currentExePath}.bak`;
    const scriptPath = path.join(app.getPath('temp'), `kakimoni-client-updater-${Date.now()}.cmd`);
    const script = [
      '@echo off',
      'setlocal',
      'timeout /t 2 /nobreak >nul',
      `copy /y "${currentExePath}" "${backupExePath}" >nul`,
      `copy /y "${downloadedPath}" "${currentExePath}" >nul`,
      'if errorlevel 1 (',
      `  copy /y "${backupExePath}" "${currentExePath}" >nul`,
      ')',
      `start "" "${currentExePath}"`,
      `del /f /q "${downloadedPath}" >nul 2>nul`,
      `del /f /q "${scriptPath}" >nul 2>nul`,
      'endlocal',
    ].join('\r\n');

    fs.writeFileSync(scriptPath, script, 'utf-8');
    spawn('cmd.exe', ['/c', scriptPath], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 100);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 「接続してスタート」時に拡張画面があれば自動でセカンドを開く
ipcMain.on('auto-open-display', (event, { seatId } = {}) => {
  if (displayWin) return;
  const displays = screen.getAllDisplays();
  const primary  = screen.getPrimaryDisplay();
  const secondary = displays.find(d => d.id !== primary.id);
  if (!secondary) return;

  displayWin = new BrowserWindow({
    x: secondary.bounds.x,
    y: secondary.bounds.y,
    width: secondary.bounds.width,
    height: secondary.bounds.height,
    frame: false,
    fullscreen: true,
    title: 'KakiMoni 子機セカンド',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  displayWin.setMenuBarVisibility(false);
  const seatParam = seatId ? `?seat=${seatId}` : '';
  displayWin.loadURL(`${currentServerUrl}/client-display${seatParam}`);
  displayWin.on('closed', () => {
    displayWin = null;
    if (launcherWin) launcherWin.webContents.send('display-status', false);
  });
  if (launcherWin) launcherWin.webContents.send('display-status', true);
});

// ランチャーからの手動トグル
ipcMain.on('toggle-display', (event, { serverUrl }) => {
  if (displayWin) {
    displayWin.close();
    return;
  }
  const displays = screen.getAllDisplays();
  const primary  = screen.getPrimaryDisplay();
  const target   = displays.find(d => d.id !== primary.id) || primary;

  displayWin = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    frame: false,
    fullscreen: true,
    title: 'KakiMoni 子機セカンド',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  displayWin.setMenuBarVisibility(false);
  displayWin.loadURL(`${serverUrl}/client-display`);
  displayWin.on('closed', () => {
    displayWin = null;
    if (launcherWin) launcherWin.webContents.send('display-status', false);
  });
  if (launcherWin) launcherWin.webContents.send('display-status', true);
});

app.whenReady().then(createLauncher);
app.on('window-all-closed', () => app.quit());
