/* ════════════════════════════════════════════════════════════════════
 * sync.js — SYNCHRONISATION SUPABASE FIABLE + ÉTAT DE SYNCHRONISATION.
 *
 * Un document par utilisateur dans la table `user_data` (colonne `data`,
 * compressée LZString : { __v: 2, c: "…" } — format inchangé).
 *
 * DÉTECTION DE CONFLIT (fin du « dernier qui écrit gagne ») :
 *   - au chargement, on mémorise la révision cloud reçue (colonne
 *     `revision`, ajoutée par supabase-migration.sql ; à défaut, `updated_at`) ;
 *   - chaque écriture est CONDITIONNELLE : UPDATE … WHERE revision = <connue>.
 *     Si un autre appareil a écrit entre-temps, 0 ligne n'est modifiée :
 *     → on relit la version cloud, on FUSIONNE (merge.js) avec la version
 *       locale et la dernière version commune (« base »), puis on réécrit ;
 *     → la version cloud d'avant fusion est sauvegardée dans un instantané
 *       IndexedDB : aucune perte silencieuse possible.
 *
 * État local de synchro (localStorage CONFIG.syncMetaKey) :
 *   { userId, revision, updatedAt, mode, dirty, lastSyncAt }
 * Base commune (IndexedDB '__cloud_base__') : JSON de la dernière version
 * synchronisée, pour la fusion à 3 voies.
 * ════════════════════════════════════════════════════════════════════ */

let supabaseClient = null;
let currentCloudUser = null;     // { id, email } — identité issue de Supabase Auth
let cloudSyncTimer = null;
let isAdminSession = false;      // compat : = currentUserIsAdmin
let currentUserIsAdmin = false;  // lu depuis la table profils (affichage uniquement ;
                                 // les droits réels sont appliqués par les policies RLS)
let _lastSavedSig = null;

function initSupabase() {
    if (!CLOUD_ENABLED) { console.info('[Cloud] Mode local (clés Supabase non configurées).'); return false; }
    if (supabaseClient) return true;
    try {
        if (!window.supabase || typeof window.supabase.createClient !== 'function') throw new Error('Bibliothèque Supabase non chargée');
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
        });
        // Session expirée / déconnexion dans un autre onglet → état cohérent.
        supabaseClient.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_OUT' && currentCloudUser) {
                SyncStatus.set('error', 'Session terminée — reconnectez-vous pour synchroniser');
            }
            if (event === 'TOKEN_REFRESHED' && SyncStatus.get().status === 'error') Sync.push();
        });
        return true;
    } catch (e) {
        reportError(ErrorType.LIBRARY, e, 'Connexion au cloud impossible (bibliothèque non chargée). Vos données locales restent disponibles.');
        return false;
    }
}

async function cloudSignUp(email, password) {
    if (!initSupabase()) throw new Error('Cloud non configuré');
    const { data: res, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) throw error;
    return res;
}
async function cloudSignIn(email, password) {
    if (!initSupabase()) throw new Error('Cloud non configuré');
    const { data: res, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return res;
}
async function cloudSignOut() {
    if (supabaseClient) { try { await supabaseClient.auth.signOut(); } catch (e) { /* hors ligne */ } }
    currentCloudUser = null;
}
async function cloudGetSession() {
    if (!initSupabase()) return null;
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    return session;
}

async function cloudGetAbonnement() {
    if (!supabaseClient || !currentCloudUser) return null;
    const { data: row, error } = await supabaseClient.from(CONFIG.tables.abonnements)
        .select('*').eq('user_id', currentCloudUser.id).maybeSingle();
    if (error) { reportError(ErrorType.SUPABASE, error, null, { silent: true }); return null; }
    return row;
}

/**
 * Statut administrateur lu côté serveur. La policy RLS de `profils` n'autorise
 * que la lecture de SA ligne, et un trigger interdit toute modification de
 * is_admin depuis l'application (voir supabase-migration.sql).
 * Ce statut ne sert qu'à l'AFFICHAGE : masquer un bouton n'est pas une sécurité.
 */
async function cloudGetProfil() {
    if (!supabaseClient || !currentCloudUser) return null;
    const { data: row, error } = await supabaseClient.from(CONFIG.tables.profils)
        .select('is_admin, email').eq('user_id', currentCloudUser.id).maybeSingle();
    if (error) { reportError(ErrorType.SUPABASE, error, null, { silent: true }); return null; }
    return row;
}

// ───────────────────── État de synchronisation (UI) ─────────────────────
const SyncStatus = (() => {
    const st = {
        status: 'local',          // local | syncing | synced | offline | conflict | error | disabled
        message: '',
        lastLocalSaveAt: null,
        lastCloudSyncAt: null,
        conflicts: []
    };
    try {
        const m = JSON.parse(localStorage.getItem(CONFIG.syncMetaKey) || 'null');
        if (m && m.lastSyncAt) st.lastCloudSyncAt = m.lastSyncAt;
    } catch (e) { /* ignore */ }

    const LIBELLES = {
        local:    { icon: 'fa-check-circle', cls: 'st-local',    txt: 'Sauvegardé localement' },
        syncing:  { icon: 'fa-arrows-rotate fa-spin', cls: 'st-syncing', txt: 'Synchronisation…' },
        synced:   { icon: 'fa-cloud', cls: 'st-synced',          txt: 'Synchronisé avec le cloud' },
        offline:  { icon: 'fa-wifi', cls: 'st-offline',          txt: 'Hors ligne — données sauvegardées localement' },
        conflict: { icon: 'fa-triangle-exclamation', cls: 'st-conflict', txt: 'Conflit détecté' },
        error:    { icon: 'fa-circle-xmark', cls: 'st-error',    txt: 'Erreur de synchronisation' },
        disabled: { icon: 'fa-hard-drive', cls: 'st-local',      txt: 'Sauvegardé localement (cloud non connecté)' }
    };

    function render() {
        const box = document.getElementById('saveIndicator');
        if (!box) return;
        const l = LIBELLES[st.status] || LIBELLES.local;
        const icon = document.getElementById('syncStatusIcon');
        const label = document.getElementById('syncStatusLabel');
        const time = document.getElementById('saveIndicatorTime');
        box.classList.remove('st-local', 'st-syncing', 'st-synced', 'st-offline', 'st-conflict', 'st-error');
        box.classList.add(l.cls);
        if (icon) icon.className = 'fas ' + l.icon;
        if (label) label.textContent = st.message && (st.status === 'error' || st.status === 'conflict') ? st.message : l.txt;
        if (time) {
            time.textContent = st.lastCloudSyncAt
                ? 'Dernière synchronisation cloud : ' + formatHeure(st.lastCloudSyncAt)
                : (st.lastLocalSaveAt ? 'Sauvegarde locale : ' + formatHeure(st.lastLocalSaveAt) : '');
        }
        box.setAttribute('aria-label', (label ? label.textContent : l.txt) + (time && time.textContent ? '. ' + time.textContent : '') + '. Ouvrir le diagnostic de sauvegarde');
        const btn = document.getElementById('syncConflictBtn');
        if (btn) btn.style.display = st.status === 'conflict' ? '' : 'none';
    }

    return {
        get() { return { ...st, conflicts: st.conflicts.slice() }; },
        set(status, message) {
            // Un conflit reste affiché jusqu'à ce que l'utilisateur l'ait consulté.
            if (st.status === 'conflict' && (status === 'syncing' || status === 'synced' || status === 'local')) { render(); return; }
            st.status = status; st.message = message || ''; render();
        },
        localSaved() {
            st.lastLocalSaveAt = Date.now();
            if (!currentCloudUser) { st.status = CLOUD_ENABLED ? 'local' : 'disabled'; }
            else if (st.status === 'synced' || st.status === 'local') { st.status = 'local'; }
            render();
        },
        localError(quota) {
            st.status = 'error';
            st.message = quota ? 'Stockage local saturé — sauvegarde locale impossible' : 'Échec de la sauvegarde locale';
            render();
            reportError(quota ? ErrorType.QUOTA : ErrorType.LOCAL_STORAGE, null,
                quota ? 'Stockage local saturé : la sauvegarde locale a échoué. Les données restent en mémoire, dans IndexedDB et dans le cloud. Purgez des mois anciens (Diagnostic de sauvegarde).' : null);
        },
        cloudSynced(ts) { st.lastCloudSyncAt = ts || Date.now(); if (st.status !== 'conflict') { st.status = 'synced'; st.message = ''; } render(); },
        setConflict(conflicts, origine) {
            st.conflicts = (conflicts || []).slice(0, 200);
            st.status = 'conflict';
            st.message = `Conflit détecté (${st.conflicts.length} élément${st.conflicts.length > 1 ? 's' : ''}) — cliquez pour les détails`;
            render();
            reportError(ErrorType.CONFLICT, { origine, conflicts: st.conflicts },
                origine === 'onglet'
                    ? 'Conflit avec un autre onglet : les deux versions ont été fusionnées. Détails dans le diagnostic de sauvegarde.'
                    : 'Conflit avec un autre appareil : les deux versions ont été fusionnées, la version cloud précédente est conservée dans les instantanés.');
        },
        clearConflict() { st.conflicts = []; if (st.status === 'conflict') { st.status = currentCloudUser ? 'synced' : 'local'; st.message = ''; } render(); },
        info(msg) { if (typeof showToast === 'function') showToast(msg, 'info'); },
        render
    };
})();

// ───────────────────── Méta de synchronisation ─────────────────────
const SyncMeta = {
    read() {
        try { return JSON.parse(localStorage.getItem(CONFIG.syncMetaKey) || 'null'); } catch (e) { return null; }
    },
    write(m) {
        try { localStorage.setItem(CONFIG.syncMetaKey, JSON.stringify(m)); } catch (e) { reportError(null, e, null, { silent: true }); }
    },
    update(patch) { const m = { ...(SyncMeta.read() || {}), ...patch }; SyncMeta.write(m); return m; },
    markDirty() {
        if (!currentCloudUser) return;
        const m = SyncMeta.read();
        if (m && m.userId === currentCloudUser.id && m.dirty) return;
        SyncMeta.update({ userId: currentCloudUser.id, dirty: true });
    }
};

async function _baseLire(userId) {
    const b = await idbGet('__cloud_base__');
    if (b && b.userId === userId && typeof b.json === 'string') return b;
    return null;
}
async function _baseEcrire(userId, revision, json) {
    await idbSet('__cloud_base__', { userId, revision, json, t: new Date().toISOString() });
}

// ───────────────────── Codec du document cloud ─────────────────────
function construireDocumentCloudJson() {
    return JSON.stringify({ ...data, __terrain__: lireClesTerrain() });
}

function decoderDocumentCloud(stored) {
    if (!stored) return null;
    if (stored.__v === 2 && typeof stored.c === 'string') {
        const json = LZString.decompressFromBase64(stored.c);
        if (!json) throw new Error('Décompression du document cloud impossible');
        return { obj: JSON.parse(json), json };
    }
    return { obj: stored, json: JSON.stringify(stored) };
}

function encoderDocumentCloud(json) {
    try {
        const compressed = LZString.compressToBase64(json);
        if (compressed && LZString.decompressFromBase64(compressed) === json) return { __v: 2, c: compressed };
    } catch (e) { /* repli en clair */ }
    return JSON.parse(json);
}

/** Sépare les données applicatives et les clés terrain d'un document cloud. */
function separerTerrain(obj) {
    const doc = { ...obj };
    const terrain = (doc.__terrain__ && typeof doc.__terrain__ === 'object') ? doc.__terrain__ : null;
    delete doc.__terrain__;
    return { doc, terrain };
}

// ───────────────────── Accès à la table user_data ─────────────────────
let _modeRevision = null; // true : colonne revision présente ; false : repli updated_at

function _estColonneAbsente(error) {
    if (!error) return false;
    if (error.code === '42703' || error.code === 'PGRST204') return true;
    const m = String(error.message || '');
    return /revision/i.test(m) && /does not exist|schema cache|not found/i.test(m);
}

async function lireLigneCloud(avecDonnees) {
    const cols = (avecDonnees ? 'data, ' : '') + 'updated_at';
    if (_modeRevision !== false) {
        const { data: row, error } = await supabaseClient.from(CONFIG.tables.userData)
            .select(cols + ', revision').eq('user_id', currentCloudUser.id).maybeSingle();
        if (!error) { _modeRevision = true; return row; }
        if (!_estColonneAbsente(error)) throw error;
        _modeRevision = false;
        console.warn('[Cloud] colonne revision absente : exécutez supabase-migration.sql. Repli sur updated_at.');
    }
    const { data: row, error } = await supabaseClient.from(CONFIG.tables.userData)
        .select(cols).eq('user_id', currentCloudUser.id).maybeSingle();
    if (error) throw error;
    return row;
}

/** Lecture complète : { existe, obj, json, revision, updatedAt }. */
async function lireDocumentCloud() {
    const row = await lireLigneCloud(true);
    if (!row) return { existe: false };
    const dec = row.data ? decoderDocumentCloud(row.data) : null;
    return {
        existe: true,
        obj: dec ? dec.obj : null,
        json: dec ? dec.json : null,
        revision: row.revision !== undefined ? row.revision : null,
        updatedAt: row.updated_at || null
    };
}

/** Écriture conditionnelle. Renvoie { ok, conflit, revision, updatedAt }. */
async function ecrireDocumentCloud(json, attendu) {
    const table = supabaseClient.from(CONFIG.tables.userData);
    const payload = encoderDocumentCloud(json);
    const nowIso = new Date().toISOString();

    if (!attendu || (!attendu.existe)) {
        const { data: rows, error } = await table
            .insert({ user_id: currentCloudUser.id, data: payload, updated_at: nowIso })
            .select(_modeRevision ? 'revision, updated_at' : 'updated_at');
        if (error) {
            if (error.code === '23505') return { ok: false, conflit: true }; // ligne créée entre-temps
            throw error;
        }
        const r = rows && rows[0];
        return { ok: true, revision: r && r.revision !== undefined ? r.revision : null, updatedAt: r ? r.updated_at : nowIso };
    }

    let q = supabaseClient.from(CONFIG.tables.userData)
        .update({ data: payload, updated_at: nowIso })
        .eq('user_id', currentCloudUser.id);
    if (_modeRevision && attendu.revision !== null && attendu.revision !== undefined) q = q.eq('revision', attendu.revision);
    else if (attendu.updatedAt) q = q.eq('updated_at', attendu.updatedAt);
    const { data: rows, error } = await q.select(_modeRevision ? 'revision, updated_at' : 'updated_at');
    if (error) throw error;
    if (!rows || rows.length === 0) return { ok: false, conflit: true };
    const r = rows[0];
    return { ok: true, revision: r.revision !== undefined ? r.revision : null, updatedAt: r.updated_at };
}

// ───────────────────── Moteur de synchronisation ─────────────────────
const Sync = {
    _enCours: null,
    _relancer: false,

    isOnline() { return typeof navigator === 'undefined' || navigator.onLine !== false; },

    /**
     * Envoie les données locales vers le cloud (avec détection de conflit).
     * Sérialisé : un seul envoi à la fois par navigateur (Web Locks si dispo).
     */
    async push(opts) {
        if (!currentCloudUser || !supabaseClient) return false;
        if (Sync._enCours) { Sync._relancer = true; return Sync._enCours; }
        const run = async () => {
            try { return await Sync._pushVerrouille(opts || {}); }
            finally {
                Sync._enCours = null;
                if (Sync._relancer) { Sync._relancer = false; setTimeout(() => Sync.push(), 200); }
            }
        };
        Sync._enCours = (navigator.locks && navigator.locks.request)
            ? navigator.locks.request('planif-cloud-sync', run)
            : run();
        return Sync._enCours;
    },

    async _pushVerrouille(opts) {
        if (!Sync.isOnline()) { SyncMeta.markDirty(); SyncStatus.set('offline'); return false; }
        const userId = currentCloudUser.id;
        let meta = SyncMeta.read();
        if (!meta || meta.userId !== userId) meta = { userId, revision: null, updatedAt: null, dirty: true };

        let json = construireDocumentCloudJson();
        const sig = _quickHash(json);
        if (!opts.force && sig === _lastSavedSig && !meta.dirty) {
            SyncStatus.cloudSynced(meta.lastSyncAt ? new Date(meta.lastSyncAt).getTime() : Date.now());
            return true;
        }

        SyncStatus.set('syncing');
        try {
            if (_modeRevision === null) await lireLigneCloud(false); // détecte la présence de la colonne revision
            let attendu = { existe: meta.revision !== null || !!meta.updatedAt, revision: meta.revision, updatedAt: meta.updatedAt };
            if (opts.force) {
                // Écrasement volontaire (bouton « Migrer mes données vers le cloud ») :
                // on relit la version actuelle pour écrire par-dessus en connaissance
                // de cause, après l'avoir sauvegardée dans un instantané.
                const distant = await lireDocumentCloud();
                if (distant.existe && distant.json) await snapshotCreer('version cloud remplacée (migration manuelle)', distant.json);
                attendu = { existe: distant.existe, revision: distant.revision, updatedAt: distant.updatedAt };
            }
            for (let tentative = 0; tentative < 3; tentative++) {
                const res = await ecrireDocumentCloud(json, attendu);
                if (res.ok) {
                    _lastSavedSig = sig;
                    const now = Date.now();
                    SyncMeta.write({ userId, revision: res.revision, updatedAt: res.updatedAt, dirty: false, lastSyncAt: now, mode: _modeRevision ? 'revision' : 'updated_at' });
                    await _baseEcrire(userId, res.revision, json);
                    SyncStatus.cloudSynced(now);
                    lastSaveTimestamp = now;
                    return true;
                }
                // CONFLIT : quelqu'un a écrit entre-temps → relire, fusionner, réessayer.
                const distant = await lireDocumentCloud();
                const fusion = await Sync._fusionnerAvecDistant(distant, json);
                json = fusion.json;
                attendu = { existe: distant.existe, revision: distant.revision, updatedAt: distant.updatedAt };
            }
            throw Object.assign(new Error('Conflits répétés lors de la synchronisation'), { code: 'CONFLICT_LOOP' });
        } catch (e) {
            SyncMeta.update({ userId, dirty: true });
            const t = classifyError(e);
            if (t === ErrorType.NETWORK) SyncStatus.set('offline');
            else if (t === ErrorType.AUTH) SyncStatus.set('error', 'Session expirée — reconnectez-vous pour synchroniser');
            else SyncStatus.set('error', 'Erreur de synchronisation — nouvel essai automatique');
            reportError(t, e, null, { silent: true });
            return false;
        }
    },

    /**
     * Fusionne la version distante avec la version locale courante.
     * Met à jour `data` + clés terrain + localStorage. Renvoie le JSON fusionné.
     */
    async _fusionnerAvecDistant(distant, jsonLocal) {
        if (!distant.existe || !distant.obj) return { json: jsonLocal, conflicts: [] };
        const base = await _baseLire(currentCloudUser.id);
        const baseObj = base ? JSON.parse(base.json) : {};
        const localObj = JSON.parse(jsonLocal);
        // Instantané de la version cloud AVANT fusion : rien ne peut être perdu.
        await snapshotCreer('version cloud avant fusion (autre appareil)', JSON.stringify(separerTerrain(distant.obj).doc));
        const { doc, conflicts } = mergeDocuments(baseObj, localObj, distant.obj);
        Sync._appliquerDocument(doc);
        try { if (document.getElementById('appContent')?.style.display !== 'none') updateUI(); } catch (e) { reportError(null, e, null, { silent: true }); }
        if (conflicts.length) SyncStatus.setConflict(conflicts, 'appareil');
        else if (typeof showToast === 'function') showToast('Modifications d\'un autre appareil fusionnées', 'info');
        return { json: construireDocumentCloudJson(), conflicts };
    },

    /** Remplace les données courantes par un document (cloud ou fusionné). */
    _appliquerDocument(obj) {
        const { doc, terrain } = separerTerrain(obj);
        data = doc;
        normalizeDataAfterLoad();
        if (terrain) ecrireClesTerrain(terrain, { remplacer: true });
        const json = JSON.stringify(data);
        const r = AppStorage.writeLocal(json);
        if (r.ok) idbSaveAll();
        try { if (typeof window.terrainReloadFromStorage === 'function') window.terrainReloadFromStorage(); } catch (e) { /* ignore */ }
    },

    /**
     * Vérifie si un autre appareil a publié une nouvelle version.
     * Sans modification locale en attente : on l'applique directement.
     * Avec modifications locales : on pousse (la fusion se fait dans push()).
     */
    async checkRemote() {
        if (!currentCloudUser || !supabaseClient || !Sync.isOnline() || Sync._enCours) return;
        const meta = SyncMeta.read();
        if (!meta || meta.userId !== currentCloudUser.id) return;
        if (meta.dirty || hasUnsavedChanges) { cloudScheduleSave(); return; }
        try {
            const row = await lireLigneCloud(false);
            if (!row) return;
            const change = _modeRevision ? (row.revision !== meta.revision) : (row.updated_at !== meta.updatedAt);
            if (!change) { SyncStatus.cloudSynced(meta.lastSyncAt); return; }
            const distant = await lireDocumentCloud();
            if (!distant.obj) return;
            // Re-vérifie qu'aucune modification locale n'est apparue pendant la lecture.
            const m2 = SyncMeta.read();
            if ((m2 && m2.dirty) || hasUnsavedChanges) { cloudScheduleSave(); return; }
            Sync._appliquerDocument(distant.obj);
            _lastSavedSig = _quickHash(distant.json);
            const now = Date.now();
            SyncMeta.write({ userId: currentCloudUser.id, revision: distant.revision, updatedAt: distant.updatedAt, dirty: false, lastSyncAt: now, mode: _modeRevision ? 'revision' : 'updated_at' });
            await _baseEcrire(currentCloudUser.id, distant.revision, distant.json);
            try { updateUI(); } catch (e) { reportError(null, e, null, { silent: true }); }
            SyncStatus.cloudSynced(now);
            if (typeof showToast === 'function') showToast('Données mises à jour depuis un autre appareil', 'info');
        } catch (e) {
            const t = classifyError(e);
            if (t === ErrorType.NETWORK) SyncStatus.set('offline');
            reportError(t, e, null, { silent: true });
        }
    },

    /**
     * Chargement à la connexion. Décide entre : version cloud, version locale,
     * ou fusion des deux — sans jamais écraser silencieusement un travail local.
     */
    async chargerAuDemarrage(isNewAccount) {
        const userId = currentCloudUser.id;
        const meta = SyncMeta.read();
        const rawLocal = AppStorage.readLocalRaw();
        let localObj = null;
        try { localObj = rawLocal ? JSON.parse(rawLocal) : null; } catch (e) { localObj = null; }
        const localJson = localObj ? JSON.stringify({ ...localObj, __terrain__: lireClesTerrain() }) : null;

        // À qui appartiennent les données locales ?
        let proprietaire = 'inconnu';
        if (meta && meta.userId) proprietaire = meta.userId === userId ? 'moi' : 'autre';
        else {
            try {
                const marq = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
                if (marq && marq.cloud && marq.email && currentCloudUser.email) {
                    proprietaire = marq.email.toLowerCase() === currentCloudUser.email.toLowerCase() ? 'moi' : 'autre';
                }
            } catch (e) { /* ignore */ }
        }
        if (proprietaire === 'autre' && localObj && (!meta || meta.dirty)) {
            // Données d'un AUTRE compte sur ce navigateur, dont une partie n'a pas pu
            // être envoyée au cloud : on ne les mélange jamais, mais on les conserve
            // dans un instantané plutôt que de les perdre. (Si tout était synchronisé,
            // elles sont en sécurité dans le cloud de ce compte : rien n'est copié.)
            await snapshotCreer('données locales d\'un autre compte (non synchronisées)', rawLocal);
        }

        let distant;
        try { distant = await lireDocumentCloud(); }
        catch (e) {
            // Cloud injoignable : on travaille en local (données de CE compte uniquement).
            const t = reportError(null, e, null, { silent: true });
            SyncStatus.set(t === ErrorType.NETWORK ? 'offline' : 'error', t === ErrorType.NETWORK ? '' : 'Cloud injoignable — travail en local');
            if (proprietaire === 'autre' || !localObj) { initDefaultDataSansSauvegarde(); }
            else { loadFromLocalStorage(); }
            SyncMeta.update({ userId, dirty: true });
            return { source: 'local-hors-ligne' };
        }

        if (distant.existe && distant.obj && (distant.obj.livreurs || Object.keys(distant.obj).length > 2)) {
            const baseSync = meta && meta.userId === userId;
            if (localObj && proprietaire === 'moi' && baseSync && meta.dirty) {
                // Modifications locales non envoyées : cloud inchangé → on garde le local ;
                // cloud modifié ailleurs → fusion à 3 voies.
                const inchangé = _modeRevision ? distant.revision === meta.revision : distant.updatedAt === meta.updatedAt;
                if (inchangé) {
                    data = localObj; normalizeDataAfterLoad();
                    AppStorage.markLoaded(rawLocal);
                    cloudScheduleSave();
                    return { source: 'local-en-avance' };
                }
                await Sync._fusionnerAvecDistant(distant, localJson);
                SyncMeta.update({ userId, revision: distant.revision, updatedAt: distant.updatedAt, dirty: true });
                cloudScheduleSave();
                return { source: 'fusion' };
            }
            if (localObj && proprietaire !== 'autre' && !baseSync) {
                // Première ouverture avec cette version : pas de base commune connue.
                // Comportement historique conservé : version cloud, complétée par
                // les mois présents uniquement en local (protection anti-perte).
                await snapshotCreer('données locales avant chargement cloud', rawLocal);
                Sync._appliquerDocument(distant.obj);
                const localAvant = localObj;
                let complete = false;
                if (localAvant.inventaire && !data.inventaire) { data.inventaire = localAvant.inventaire; complete = true; }
                ['historiqueEPOD', 'fraisLivreurs', 'paiementsLivreurs', 'controlEPOD'].forEach(section => {
                    if (!localAvant[section] || typeof localAvant[section] !== 'object') return;
                    if (!data[section] || typeof data[section] !== 'object') data[section] = {};
                    Object.keys(localAvant[section]).forEach(moisKey => {
                        const v = data[section][moisKey];
                        if (!v || (typeof v === 'object' && Object.keys(v).length === 0)) { data[section][moisKey] = localAvant[section][moisKey]; complete = true; }
                    });
                });
                await _baseEcrire(userId, distant.revision, distant.json);
                SyncMeta.write({ userId, revision: distant.revision, updatedAt: distant.updatedAt, dirty: complete, lastSyncAt: Date.now() });
                if (complete) { AppStorage.writeLocal(JSON.stringify(data)); cloudScheduleSave(); }
                _lastSavedSig = complete ? null : _quickHash(distant.json);
                return { source: 'cloud+complement-local' };
            }
            // Cas normal : la version cloud fait foi.
            Sync._appliquerDocument(distant.obj);
            await _baseEcrire(userId, distant.revision, distant.json);
            SyncMeta.write({ userId, revision: distant.revision, updatedAt: distant.updatedAt, dirty: false, lastSyncAt: Date.now() });
            _lastSavedSig = _quickHash(distant.json);
            SyncStatus.cloudSynced();
            return { source: 'cloud' };
        }

        // Aucune donnée dans le cloud pour ce compte.
        if (isNewAccount || proprietaire === 'autre' || !localObj) {
            initDefaultDataSansSauvegarde();
        } else {
            loadFromLocalStorage();
        }
        AppStorage.writeLocal(JSON.stringify(data));
        SyncMeta.write({ userId, revision: distant.existe ? distant.revision : null, updatedAt: distant.existe ? distant.updatedAt : null, dirty: true });
        await Sync.push({ immediate: true });
        return { source: 'initialisation-cloud' };
    }
};

/** Enregistre le document dans le cloud (compat : appelée par l'ancien code). */
async function cloudSaveData(_payload, opts) {
    if (!currentCloudUser) return false;
    return Sync.push(opts || {});
}

/** Charge le document cloud de l'utilisateur (compat). */
async function cloudLoadData() {
    if (!supabaseClient || !currentCloudUser) return null;
    try { const d = await lireDocumentCloud(); return d.obj || null; }
    catch (e) { reportError(null, e, null, { silent: true }); return null; }
}

/** Synchronisation cloud différée (appelée après chaque modification). */
function cloudScheduleSave() {
    if (!currentCloudUser) return;
    SyncMeta.markDirty();
    if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(() => { cloudSyncTimer = null; Sync.push(); }, CONFIG.cloudSyncDebounceMs);
}

/** Envoi immédiat (utilisé quand la page passe en arrière-plan). */
function cloudFlushNow() {
    if (!currentCloudUser) return;
    if (cloudSyncTimer) { clearTimeout(cloudSyncTimer); cloudSyncTimer = null; }
    Sync.push();
}

/** Boîte de dialogue « Conflit détecté » : liste + actions. */
function afficherDetailsConflit() {
    const st = SyncStatus.get();
    const liste = st.conflicts.length
        ? st.conflicts.slice(0, 60).map(c => `<li>${escapeHtml(libelleConflit(c))}</li>`).join('')
        : '<li>Aucun conflit en attente.</li>';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'conflitTitre');
    overlay.innerHTML = `
        <div class="modal" style="max-width:560px;">
            <div class="modal-header"><h3 id="conflitTitre"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> Conflit de synchronisation</h3>
                <button class="modal-close" aria-label="Fermer" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times" aria-hidden="true"></i></button></div>
            <div class="modal-body">
                <p>Les mêmes éléments ont été modifiés différemment sur deux appareils (ou onglets). Les deux versions ont été <strong>fusionnées</strong> ;
                pour les éléments ci-dessous, <strong>la version de cet appareil a été conservée</strong>.</p>
                <p>La version de l'autre appareil n'est pas perdue : elle a été enregistrée dans un <strong>instantané</strong>
                (Synchronisation › Instantanés › « version cloud avant fusion »). Vous pouvez la restaurer à tout moment.</p>
                <ul style="max-height:220px;overflow:auto;font-size:0.85rem;">${liste}</ul>
            </div>
            <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;flex-wrap:wrap;">
                <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove(); switchTab('sync'); setTimeout(renderSnapshots, 100);">Voir les instantanés</button>
                <button class="btn btn-primary" onclick="SyncStatus.clearConflict(); this.closest('.modal-overlay').remove();">J'ai compris</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    if (typeof Accessibilite !== 'undefined') Accessibilite.ouvrir(overlay);
}

// Réseau : retour en ligne → synchroniser ; perte → état hors ligne.
window.addEventListener('online', () => { if (currentCloudUser) { Sync.push(); setTimeout(() => Sync.checkRemote(), 1500); } });
window.addEventListener('offline', () => { if (currentCloudUser) SyncStatus.set('offline'); });
