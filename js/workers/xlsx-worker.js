/* Lecture d'un classeur Excel hors du thread principal (évite de figer l'interface
   2 à 4 s sur un gros export EPOD). Chargé par lireClasseurEnWorker() (historique.js). */
let pret = false;
try { importScripts('../../vendor/xlsx-0.18.5.full.min.js'); pret = true; }
catch (e) {
    try { importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'); pret = true; }
    catch (e2) { pret = false; }
}
self.onmessage = function (ev) {
    if (!pret) { self.postMessage({ ok: false, err: 'SheetJS inaccessible' }); return; }
    try {
        const wb = XLSX.read(ev.data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        self.postMessage({ ok: true, rows: XLSX.utils.sheet_to_json(ws) });
    } catch (e) { self.postMessage({ ok: false, err: String(e && e.message || e) }); }
};
