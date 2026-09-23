/* ════════════════════════════════════════════════════════════════════
 * storage.js — COUCHE DE STOCKAGE LOCALE (local-first).
 *
 *   mémoire JS (variable globale `data`)
 *        ↓  saveLocal()  → AppStorage.writeLocal()
 *   localStorage  (clé CONFIG.storageKey — format inchangé depuis v4)
 *        ↓  miroir asynchrone
 *   IndexedDB     (copie de secours + instantanés)
 *        ↓  js/core/sync.js
 *   Supabase      (table user_data, avec détection de conflit)
 *
 * Les modules métier n'ont pas à connaître ces détails : ils modifient
 * `data`, puis appellent saveLocal() (ou mettent hasUnsavedChanges = true).
 *
 * Multi-onglets : chaque écriture incrémente un compteur partagé
 * (CONFIG.localRevKey). Si un autre onglet a écrit entre-temps, les deux
 * versions sont fusionnées (fusion à 3 voies, voir merge.js) au lieu de
 * s'écraser, et les autres onglets sont prévenus (BroadcastChannel).
 * ════════════════════════════════════════════════════════════════════ */

// ───────────────────────── IndexedDB ─────────────────────────
let _idbPromise = null;
let lastSaveTimestamp = null;
let _idbDisponible = true;

function idbOpen() {
    if (_idbPromise) return _idbPromise;
    _idbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { _idbDisponible = false; reject(new Error('IndexedDB indisponible')); return; }
        let req;
        try { req = indexedDB.open(IDB_NAME, 1); }
        catch (e) { _idbDisponible = false; reject(e); return; }
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => { _idbDisponible = false; reject(e.target.error || new Error('Erreur ouverture IndexedDB')); };
    });
    // Un échec d'ouverture ne doit pas bloquer les tentatives suivantes indéfiniment.
    _idbPromise.catch(() => { setTimeout(() => { _idbPromise = null; }, 30000); });
    return _idbPromise;
}

async function idbSet(key, value) {
    try {
        const db = await idbOpen();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } catch (e) { reportError(ErrorType.INDEXEDDB, e, null, { silent: true }); return false; }
}

async function idbGet(key) {
    try {
        const db = await idbOpen();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const r = tx.objectStore(IDB_STORE).get(key);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    } catch (e) { reportError(ErrorType.INDEXEDDB, e, null, { silent: true }); return undefined; }
}

async function idbDelete(key) {
    try {
        const db = await idbOpen();
        return await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch (e) { return false; }
}

async function idbKeys(prefix) {
    try {
        const db = await idbOpen();
        return await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const r = tx.objectStore(IDB_STORE).getAllKeys();
            r.onsuccess = () => resolve((r.result || []).filter(k => typeof k === 'string' && (!prefix || k.startsWith(prefix))).sort());
            r.onerror = () => resolve([]);
        });
    } catch (e) { return []; }
}

// ───────────────────── Clés « terrain_* » ─────────────────────
// Le module Optimisation Terrain stocke son état dans des clés séparées.
function lireClesTerrain() {
    const out = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('terrain_')) out[k] = localStorage.getItem(k);
        }
    } catch (e) { /* lecture impossible : on renvoie ce qu'on a */ }
    return out;
}

/**
 * Écrit un ensemble de clés terrain_*. Avec { remplacer: true }, les clés
 * locales absentes de `obj` sont supprimées (utilisé après une fusion, où
 * `obj` est l'état complet de référence).
 */
function ecrireClesTerrain(obj, options) {
    if (!obj || typeof obj !== 'object') return;
    try {
        if (options && options.remplacer) {
            Object.keys(lireClesTerrain()).forEach(k => { if (!(k in obj)) localStorage.removeItem(k); });
        }
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string' && k.startsWith('terrain_') && localStorage.getItem(k) !== v) localStorage.setItem(k, v);
        }
    } catch (e) { reportError(classifyError(e), e, null, { silent: true }); }
}

// ───────────────────── localStorage + multi-onglets ─────────────────────
const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
let _tabLocalRev = null;   // compteur d'écriture vu par cet onglet
let _tabBaseJson = null;   // dernier état écrit/lu par cet onglet (base de fusion)
let _bc = null;

function _lireLocalRev() {
    try { return parseInt(localStorage.getItem(CONFIG.localRevKey) || '0', 10) || 0; } catch (e) { return 0; }
}

const AppStorage = {
    /** JSON brut des données principales (ou null). */
    readLocalRaw() {
        try { return localStorage.getItem(STORAGE_KEY); }
        catch (e) { reportError(ErrorType.LOCAL_STORAGE, e, null, { silent: true }); return null; }
    },

    /** Mémorise l'état lu comme base de cet onglet (appelé après un chargement). */
    markLoaded(json) {
        _tabLocalRev = _lireLocalRev();
        _tabBaseJson = typeof json === 'string' ? json : null;
    },

    /**
     * Écrit les données dans localStorage.
     * Si un autre onglet a écrit depuis notre dernière lecture/écriture, fusionne
     * au lieu d'écraser : la variable globale `data` est alors mise à jour.
     * @returns {{ok:boolean, json:string, merged:boolean, quota:boolean}}
     */
    writeLocal(json) {
        let merged = false;
        try {
            const revStockee = _lireLocalRev();
            if (_tabLocalRev !== null && revStockee !== _tabLocalRev && _tabBaseJson) {
                const autre = localStorage.getItem(STORAGE_KEY);
                if (autre && autre !== _tabBaseJson && autre !== json) {
                    const res = mergeDocuments(JSON.parse(_tabBaseJson), JSON.parse(json), JSON.parse(autre));
                    data = res.doc;
                    json = JSON.stringify(data);
                    merged = true;
                    console.info('[Onglets] fusion avec les modifications d\'un autre onglet', res.conflicts);
                    if (res.conflicts.length) {
                        SyncStatus.setConflict(res.conflicts, 'onglet');
                    } else if (typeof showToast === 'function') {
                        showToast('Modifications d\'un autre onglet fusionnées', 'info');
                    }
                }
            }
            localStorage.setItem(STORAGE_KEY, json);
            const rev = revStockee + 1;
            localStorage.setItem(CONFIG.localRevKey, String(rev));
            _tabLocalRev = rev;
            _tabBaseJson = json;
            lastSaveTimestamp = Date.now();
            AppStorage._broadcast({ type: 'local-saved', rev });
            SyncStatus.localSaved();
            return { ok: true, json, merged, quota: false };
        } catch (e) {
            const t = reportError(null, e, null, { silent: true });
            SyncStatus.localError(t === ErrorType.QUOTA);
            return { ok: false, json, merged, quota: t === ErrorType.QUOTA };
        }
    },

    _broadcast(msg) {
        try { if (_bc) _bc.postMessage({ ...msg, tab: TAB_ID }); } catch (e) { /* ignore */ }
    },

    /** Écoute les autres onglets (BroadcastChannel, ou événement storage en secours). */
    initTabSync() {
        const onMessage = (msg) => {
            if (!msg || msg.tab === TAB_ID) return;
            if (msg.type === 'local-saved') AppStorage._autreOngletAEcrit();
            if (msg.type === 'logout') { try { location.reload(); } catch (e) { /* ignore */ } }
        };
        try {
            if ('BroadcastChannel' in window) {
                _bc = new BroadcastChannel(CONFIG.broadcastChannel);
                _bc.onmessage = (ev) => onMessage(ev.data);
            }
        } catch (e) { _bc = null; }
        // Secours (et complément) : l'événement storage est émis dans les AUTRES onglets.
        window.addEventListener('storage', (ev) => {
            if (ev.key === CONFIG.localRevKey && !_bc) AppStorage._autreOngletAEcrit();
        });
    },

    _autreOngletAEcrit() {
        if (typeof data === 'undefined' || !data) return;
        if (_lireLocalRev() === _tabLocalRev) return;
        if (hasUnsavedChanges) {
            // Des modifications sont en cours ici : elles seront FUSIONNÉES à la
            // prochaine sauvegarde (voir writeLocal). On prévient simplement.
            SyncStatus.info('Un autre onglet a modifié les données — fusion à la prochaine sauvegarde');
            return;
        }
        // Onglet sans modification en cours : on recharge silencieusement.
        const raw = AppStorage.readLocalRaw();
        if (!raw) return;
        try {
            data = JSON.parse(raw);
            normalizeDataAfterLoad();
            AppStorage.markLoaded(raw);
            try { if (typeof window.terrainReloadFromStorage === 'function') window.terrainReloadFromStorage(); } catch (e) { /* ignore */ }
            try { updateUI(); } catch (e) { reportError(null, e, null, { silent: true }); }
            if (typeof showToast === 'function') showToast('Données mises à jour depuis un autre onglet', 'info');
        } catch (e) { reportError(ErrorType.LOCAL_STORAGE, e, null, { silent: true }); }
    },

    /** Charge les données locales (localStorage, sinon IndexedDB). */
    async load() {
        try { await idbRestoreIfNeeded(); } catch (e) { reportError(ErrorType.INDEXEDDB, e, null, { silent: true }); }
        loadFromLocalStorage();
        return data;
    },

    /** Sauvegarde complète (locale + miroir IDB + synchro cloud différée). */
    save() { saveLocal(); },
    saveLocal() { saveLocal(); },
    syncCloud(opts) { return (typeof Sync !== 'undefined') ? Sync.push(opts) : Promise.resolve(false); },
    createSnapshot(motif) { return snapshotCreer(motif); },
    restoreSnapshot(key) { return snapshotRestaurer(key); },
    getSyncStatus() { return SyncStatus.get(); }
};

// ───────────────────── Miroir IndexedDB ─────────────────────
let _idbMirrorSig = null;

/** Recopie localStorage (+ clés terrain) dans IndexedDB ; instantané quotidien. */
async function idbSaveAll(force) {
    try {
        const raw = localStorage.getItem(STORAGE_KEY) || '';
        const terrainKeys = lireClesTerrain();
        const sig = _lireLocalRev() + '|' + raw.length + '|' + (terrainKeys.terrain_points_savedAt || '') + '|' + (terrainKeys.terrain_tours_v1 || '').length;
        if (!force && sig === _idbMirrorSig) return true; // rien de nouveau : on évite une écriture de plusieurs Mo
        const ok = await idbSet(STORAGE_KEY, raw);
        if (!ok) return false;
        await idbSet('__terrain_keys__', JSON.stringify(terrainKeys));
        await idbSet('__last_save__', new Date().toISOString());
        _idbMirrorSig = sig;
        // Instantané quotidien (rotation 7 jours) — mécanisme historique conservé.
        try {
            const today = new Date().toISOString().slice(0, 10);
            const snapKey = '__snapshot_' + today;
            if (!(await idbGet(snapKey))) {
                await idbSet(snapKey, JSON.stringify({ date: today, data: raw, terrain: terrainKeys }));
                const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
                for (const k of await idbKeys('__snapshot_')) {
                    if (k.slice(11) < cutoff) await idbDelete(k);
                }
            }
        } catch (e) { reportError(ErrorType.INDEXEDDB, e, null, { silent: true }); }
        return true;
    } catch (e) { reportError(ErrorType.INDEXEDDB, e, null, { silent: true }); return false; }
}

/** Si localStorage a été vidé mais qu'IndexedDB contient les données, on restaure. */
async function idbRestoreIfNeeded() {
    try {
        const lsData = localStorage.getItem(STORAGE_KEY);
        if (lsData && lsData.length > 20) return false;
        const idbData = await idbGet(STORAGE_KEY);
        if (idbData && idbData.length > 20) {
            localStorage.setItem(STORAGE_KEY, idbData);
            const terrainRaw = await idbGet('__terrain_keys__');
            if (terrainRaw) ecrireClesTerrain(JSON.parse(terrainRaw));
            console.info('[IDB] Données restaurées depuis IndexedDB (localStorage était vide)');
            return true;
        }
    } catch (e) { reportError(ErrorType.INDEXEDDB, e, null, { silent: true }); }
    return false;
}

function updateSaveIndicator() { SyncStatus.render(); }

// ───────────────────── Restauration d'un document ─────────────────────
/**
 * Remplace les données courantes par un document restauré (instantané,
 * sauvegarde JSON…) SANS rechargement brutal : un instantané de l'état
 * actuel est créé d'abord, puis la version restaurée est sauvegardée
 * localement et envoyée au cloud comme nouvelle révision.
 */
async function appliquerDocumentRestaure(doc, terrain, motif) {
    await snapshotCreer('avant ' + (motif || 'restauration'));
    data = doc;
    normalizeDataAfterLoad();
    if (terrain) ecrireClesTerrain(terrain);
    saveLocal();
    try { if (typeof window.terrainReloadFromStorage === 'function') window.terrainReloadFromStorage(); } catch (e) { /* ignore */ }
    try { updateUI(); } catch (e) { reportError(null, e, null, { silent: true }); }
    if (typeof Sync !== 'undefined') { try { await Sync.push({ immediate: true }); } catch (e) { /* statut déjà affiché */ } }
}

// Instantanés quotidiens historiques (clé __snapshot_AAAA-MM-JJ) — depuis la console :
//   listerSnapshots()  puis  restaurerSnapshot('2026-06-09')
window.listerSnapshots = async function () {
    const snaps = (await idbKeys('__snapshot_')).map(k => k.slice(11)).sort();
    console.table(snaps.map(d => ({ date: d })));
    return snaps;
};
window.restaurerSnapshot = async function (dateStr) {
    if (!confirm(`Restaurer le snapshot du ${dateStr} ? Les données actuelles seront d'abord sauvegardées dans un instantané, puis remplacées.`)) return;
    const raw = await idbGet('__snapshot_' + dateStr);
    if (!raw) { alert('Snapshot introuvable pour cette date.'); return; }
    try {
        const snap = JSON.parse(raw);
        await appliquerDocumentRestaure(JSON.parse(snap.data), snap.terrain, 'restauration snapshot ' + dateStr);
        showToast('Snapshot restauré', 'success');
    } catch (e) { reportError(ErrorType.LOCAL_STORAGE, e, 'Snapshot illisible : restauration annulée (aucune donnée modifiée).'); }
};

// ═══════════════════════════════════════════════════════════════
// INSTANTANÉS VERSIONNÉS (protection anti-erreur)
// Rotatifs dans IndexedDB (CONFIG.snapshotMax). Créés : 1×/jour au
// chargement, avant chaque opération risquée, avant une fusion de
// conflit, et à la demande.
// ═══════════════════════════════════════════════════════════════
const SNAP_PREFIX = 'backup:';
const SNAP_MAX = CONFIG.snapshotMax;

/**
 * Crée un instantané. `docJson` optionnel : JSON à sauvegarder (par défaut
 * l'état courant de `data`, figé immédiatement de façon synchrone).
 */
async function snapshotCreer(motif, docJson) {
    try {
        const json = docJson || JSON.stringify(data);
        if (!json || json.length < 20) return false;
        let stocke = json, comp = false;
        try {
            const c = LZString.compressToUTF16(json);
            if (c && LZString.decompressFromUTF16(c) === json) { stocke = c; comp = true; }
        } catch (e) { /* stockage en clair */ }
        const t = new Date().toISOString();
        const key = SNAP_PREFIX + t + ':' + Math.random().toString(36).slice(2, 6);
        const ok = await idbSet(key, { t, motif: motif || 'auto', taille: json.length, comp, d: stocke });
        if (!ok) return false;
        const keys = await idbKeys(SNAP_PREFIX);
        for (const k of keys.slice(0, Math.max(0, keys.length - SNAP_MAX))) await idbDelete(k);
        try { localStorage.setItem('planif_last_snapshot', String(Date.now())); } catch (e) { /* ignore */ }
        return true;
    } catch (e) { reportError(ErrorType.INDEXEDDB, e, null, { silent: true }); return false; }
}

function snapshotAuto() {
    try {
        const last = parseInt(localStorage.getItem('planif_last_snapshot') || '0', 10);
        if (Date.now() - last > 24 * 3600 * 1000) {
            snapshotCreer('quotidienne').then(ok => { if (ok) console.log('[SNAP] instantané quotidien créé'); });
        }
    } catch (e) { /* ignore */ }
}

async function renderSnapshots() {
    const box = document.getElementById('snapshotsList');
    if (!box) return;
    const keys = (await idbKeys(SNAP_PREFIX)).reverse();
    if (!keys.length) {
        box.innerHTML = '<p style="color:var(--text-secondary);">Aucun instantané pour le moment — le premier sera créé automatiquement, ou cliquez sur « Créer maintenant ».</p>';
        return;
    }
    const items = [];
    for (const k of keys) {
        const s = await idbGet(k);
        if (s) items.push({ k, t: s.t, motif: s.motif, taille: s.taille });
    }
    box.innerHTML = items.map(s => `
        <div style="display:flex;align-items:center;gap:0.7rem;flex-wrap:wrap;padding:0.5rem 0.7rem;border:1px solid var(--border-light);border-radius:8px;margin-bottom:0.4rem;background:var(--background-light);">
            <i class="fas fa-camera" style="color:var(--primary);" aria-hidden="true"></i>
            <span style="font-weight:700;">${escapeHtml(new Date(s.t).toLocaleString('fr-FR'))}</span>
            <span style="font-size:0.75rem;padding:1px 8px;border-radius:8px;background:rgba(15,184,154,0.1);color:var(--primary);font-weight:700;">${escapeHtml(s.motif)}</span>
            <span style="font-size:0.78rem;color:var(--text-secondary);">${(safeNum(s.taille) / 1024).toFixed(0)} Ko</span>
            <span style="margin-left:auto;display:flex;gap:0.35rem;">
                <button class="btn btn-sm btn-primary" onclick="snapshotRestaurer('${escJsAttr(s.k)}')" title="Revenir à cet état"><i class="fas fa-rotate-left" aria-hidden="true"></i> Restaurer</button>
                <button class="btn btn-sm btn-secondary" onclick="snapshotTelecharger('${escJsAttr(s.k)}')" title="Télécharger en JSON" aria-label="Télécharger en JSON"><i class="fas fa-download" aria-hidden="true"></i></button>
                <button class="btn btn-sm btn-danger" onclick="snapshotSupprimer('${escJsAttr(s.k)}')" title="Supprimer cet instantané" aria-label="Supprimer cet instantané"><i class="fas fa-trash" aria-hidden="true"></i></button>
            </span>
        </div>`).join('');
}

async function snapshotLire(key) {
    const s = await idbGet(key);
    if (!s || !s.d) return null;
    try {
        const json = s.comp ? LZString.decompressFromUTF16(s.d) : s.d;
        JSON.parse(json);
        return json;
    } catch (e) { return null; }
}

async function snapshotRestaurer(key) {
    const s = await idbGet(key);
    if (!s) { showToast('Instantané introuvable', 'error'); return; }
    if (!confirm(`Restaurer les données du ${new Date(s.t).toLocaleString('fr-FR')} ?\n\nVos données ACTUELLES seront d'abord sauvegardées dans un nouvel instantané, puis remplacées. La version restaurée sera ensuite synchronisée avec le cloud.`)) return;
    const json = await snapshotLire(key);
    if (!json) { showToast('Instantané illisible', 'error'); return; }
    try {
        await appliquerDocumentRestaure(JSON.parse(json), null, 'restauration');
        showToast('Données restaurées', 'success');
        renderSnapshots();
    } catch (e) { reportError(ErrorType.LOCAL_STORAGE, e, 'Échec de la restauration : ' + (e.message || e)); }
}

async function snapshotTelecharger(key) {
    const s = await idbGet(key);
    const json = await snapshotLire(key);
    if (!json) { showToast('Instantané illisible', 'error'); return; }
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sauvegarde_planif_${(s?.t || new Date().toISOString()).slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function snapshotSupprimer(key) {
    if (!confirm('Supprimer cet instantané ?')) return;
    await idbDelete(key);
    renderSnapshots();
}
