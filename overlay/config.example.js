// Behovs bara om du satter upp config.js for hand. Enklare satt: ladda ner en
// ifylld config.js direkt fran Hero Pool Manager (hemsidan i Playbook),
// lanken "Ladda ner overlay-config" — samma fil funkar for alla spelare.
// Kopiera denna fil till config.js (gitignorad) om du fyller i manuellt.
// Committa ALDRIG config.js med ifyllt losenord.
window.OVERLAY_CONFIG = {
  baseUrl: 'https://dhs27.up.railway.app/api/overlay',
  alias: '', // fallback om Steam inte kunde identifieras — widgeten kanner normalt av detta sjalv
  password: '', // samma varde som SITE_PASSWORD i Railway
  pollMs: 2000,
  showMs: 12000
};
