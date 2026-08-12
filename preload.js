const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fogAPI", {
  getData: () => ipcRenderer.invoke("data:get"),
  saveSettings: settings => ipcRenderer.invoke("data:save-settings", settings),
  deleteMatch: id => ipcRenderer.invoke("data:delete-match", id),
  openStatsSync: () => ipcRenderer.invoke("stats:open-sync"),
  getPerkDetails: (perk, kind) => ipcRenderer.invoke("perk:get-details", perk, kind),
  openExternal: url => ipcRenderer.invoke("shell:open-external", url),
  getGameStatus: () => ipcRenderer.invoke("game:status"),
  getUpdateStatus: () => ipcRenderer.invoke("update:get-status"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  capturePoint: kind => ipcRenderer.invoke("calibration:capture", kind),
  selectKiller: payload => ipcRenderer.invoke("game:select", payload),
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
  hideOverlay: () => ipcRenderer.send("overlay:hide"),
  onSyncStatus: callback => ipcRenderer.on("sync:status", (_event, value) => callback(value)),
  onGameStatus: callback => ipcRenderer.on("game:selection-status", (_event, value) => callback(value)),
  onUpdateStatus: callback => ipcRenderer.on("update:status", (_event, value) => callback(value)),
  onWindowShown: callback => ipcRenderer.on("window:shown", callback),
  onOverlayShown: callback => ipcRenderer.on("overlay:shown", (_event, value) => callback(value))
});
