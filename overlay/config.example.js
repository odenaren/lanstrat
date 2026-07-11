// Behovs bara om du satter upp config.js for hand. Enklare satt: ladda ner en
// ifylld config.js direkt fran /pool-sidan (knappen "Ladda ner min overlay-config").
// Kopiera denna fil till config.js (gitignorad) om du fyller i manuellt.
// Committa ALDRIG config.js med ifyllt losenord.
window.OVERLAY_CONFIG = {
  baseUrl: 'https://dhs27.up.railway.app/api/overlay',
  alias: '', // ditt spelaralias, exakt som det star i spelarlistan (t.ex. "Elsa")
  password: '', // samma varde som SITE_PASSWORD i Railway
  pollMs: 2000,
  showMs: 12000
};
