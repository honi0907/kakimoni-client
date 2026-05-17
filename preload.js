const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 拡張画面があれば自動でセカンドを開く
  openDisplayIfAvailable: (seatId) => ipcRenderer.send('auto-open-display', { seatId }),
  // ランチャーに戻る
  goToLauncher: () => ipcRenderer.send('go-to-launcher'),
});
