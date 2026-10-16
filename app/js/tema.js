/*
 * Sett tema (lys/mørk) før siden tegnes, så den ikke blinker hvitt i mørket.
 * Lastes som vanlig <script> i <head> i index.html, før stilarkene er tatt i bruk.
 * Ligger i egen fil fordi Content-Security-Policy i index.html ikke tillater script
 * skrevet rett inn i HTML-en. Resten av temaet styres av app.js (brukTema).
 */
try {
  const t = JSON.parse(localStorage.getItem('hummerkart.innstillinger') || '{}').tema || 'auto';
  document.documentElement.dataset.tema = t !== 'auto' ? t
    : (matchMedia('(prefers-color-scheme: dark)').matches ? 'mork' : 'lys');
} catch {
  document.documentElement.dataset.tema = 'lys';
}
