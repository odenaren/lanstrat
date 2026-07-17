// Exponerar tva funktioner till overlay-sidan: dels en screenshot av skarmens
// topp-remsa (Dota 2:s topbar, for fiendehjalte-avlasning i capture-request-
// flodet), dels en screenshot av ban-logg-panelen (for OCR-baserad
// ban-avlasning i capture-ban-request-flodet). GSI exponerar varken
// fiendehjaltar eller bans i All Pick, darfor lases bada av via skarmen.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dhsOverlay', {
  captureTopStrip: () => ipcRenderer.invoke('dhs-capture-top-strip'),
  captureBanLog: () => ipcRenderer.invoke('dhs-capture-ban-log')
});
