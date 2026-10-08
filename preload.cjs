// Gives the page one function, api(), that talks to the main process. The page
// gets no other access to Node or the computer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('roku', {
  platform: process.platform,
  api: (method, path, body) => ipcRenderer.invoke('api', method, path, body),
});
