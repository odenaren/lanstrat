// Exponerar en enda funktion till overlay-sidan: ta en screenshot av skarmens
// topp-remsa (Dota 2:s topbar) och returnera den som base64-PNG. Anvands av
// capture-request-flodet — servern laser av fiendehjaltarna ur bilden eftersom
// GSI aldrig exponerar dem i All Pick.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dhsOverlay', {
  captureTopStrip: () => ipcRenderer.invoke('dhs-capture-top-strip')
});
