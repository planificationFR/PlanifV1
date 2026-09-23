        /* ════════════════════════════════════════════════════════════════
         * app-core.js — démarrage, sauvegarde, export/import, diagnostic.
         * La mécanique de stockage est dans js/core/storage.js et js/core/sync.js.
         * ════════════════════════════════════════════════════════════════ */

        // ═══════════════════════════════════════════════════════════════
        // RÉTENTION (RGPD) — v52 : purge pilotée par la date d'IMPORT
        // (7 jours par défaut, réglable). Ne touche jamais aux livreurs,
        // réglages, grille ni à l'historique EPOD (base des salaires).
        // Voir purgerDonneesPerissables() dans historique.js.
        // ═══════════════════════════════════════════════════════════════
        function purgeOldData() {
            try {
                const s = purgerDonneesPerissables();
                if (s.length) {
                    AppStorage.writeLocal(JSON.stringify(data));
                    if (typeof cloudScheduleSave === 'function') cloudScheduleSave();
                }
                localStorage.setItem('__last_purge__', new Date().toISOString().split('T')[0]);
            } catch (e) { reportError(null, e, null, { silent: true }); }
        }

        // N'exécute la purge qu'une fois par jour au maximum
        function maybePurge() {
            try {
                const today = new Date().toISOString().split('T')[0];
                if (localStorage.getItem('__last_purge__') === today) return;
                purgeOldData();
            } catch (e) { /* ignore */ }
        }

        /**
         * Démarrage commun (une seule fois par page) : écouteurs, sauvegardes
         * périodiques, instantané quotidien, persistance du stockage.
         *
         * Stratégie de sauvegarde (la sauvegarde asynchrone dans beforeunload
         * n'est PAS garantie par les navigateurs, elle n'est qu'un complément) :
         *   1. chaque action métier → saveLocal() : écriture localStorage
         *      SYNCHRONE immédiate + miroir IndexedDB + synchro cloud différée ;
         *   2. toutes les 10 s : sauvegarde si des modifications sont en attente ;
         *   3. passage en arrière-plan (visibilitychange/pagehide) : sauvegarde
         *      locale synchrone + envoi cloud immédiat ;
         *   4. toutes les 60 s : tentative de synchro cloud (filet de sécurité) ;
         *   5. beforeunload : dernière sauvegarde locale synchrone.
         */
        function demarrerApplication() {
            if (_appDemarree) return;
            _appDemarree = true;

            setTimeout(() => { try { snapshotAuto(); } catch (e) { /* ignore */ } }, 4000);
            AppStorage.initTabSync();

            const sauvegardeUrgente = () => {
                try {
                    if (hasUnsavedChanges) saveLocal({ silencieux: true });
                    idbSaveAll(true);
                    if (currentCloudUser) cloudFlushNow();
                } catch (e) { reportError(null, e, null, { silent: true }); }
            };
            window.addEventListener('beforeunload', () => { try { if (hasUnsavedChanges) saveLocal({ silencieux: true }); } catch (e) { /* ignore */ } });
            window.addEventListener('pagehide', sauvegardeUrgente);
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') sauvegardeUrgente();
                else if (currentCloudUser) Sync.checkRemote();
            });

            setInterval(() => {
                if (hasUnsavedChanges) saveLocal({ silencieux: true });
                else idbSaveAll();   // n'écrit que si le contenu a changé
            }, CONFIG.autoSaveIntervalMs);
            setInterval(() => { const m = SyncMeta.read(); if (currentCloudUser && m && m.dirty) Sync.push(); }, CONFIG.cloudSafetyIntervalMs);
            setInterval(() => { if (currentCloudUser && document.visibilityState === 'visible') Sync.checkRemote(); }, CONFIG.remoteCheckIntervalMs);
            setInterval(updateSaveAgeIndicator, 15000);

            document.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                    e.preventDefault();
                    saveLocal();
                }
            });
            const importResults = document.getElementById('importResults');
            if (importResults) importResults.style.display = 'none';
            document.getElementById('newLivreurTaux')?.addEventListener('input', updateCostPreview);

            idbSaveAll();
            try {
                if (navigator.storage && navigator.storage.persist) {
                    navigator.storage.persisted().then(already => { if (!already) navigator.storage.persist(); }).catch(() => {});
                }
            } catch (e) { /* ignore */ }
            SyncStatus.render();
        }

        /** Compat : ancien point d'entrée (mode local). */
        async function init() {
            await AppStorage.load();
            maybePurge();
            applyOngletsVisibility();
            updateUI();
            demarrerApplication();
        }

        /** Rafraîchit l'indicateur d'état de sauvegarde / synchronisation. */
        function updateSaveAgeIndicator() { SyncStatus.render(); }

        async function showStorageDiagnostic() {
            const overlay = document.getElementById('storageDiagOverlay');
            const content = document.getElementById('storageDiagContent');
            overlay.classList.add('active');
            if (typeof Accessibilite !== 'undefined') Accessibilite.ouvrir(overlay);
            content.innerHTML = '<div style="text-align:center;padding:2rem;color:#64748b"><i class="fas fa-spinner fa-spin"></i> Analyse en cours...</div>';

            // Mesures
            const lsData = localStorage.getItem(STORAGE_KEY) || '';
            const lsSize = new Blob([lsData]).size;
            let lsTotalSize = 0;
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                lsTotalSize += new Blob([localStorage.getItem(k) || '']).size;
            }

            // IndexedDB dispo ?
            let idbOk = false, idbSize = 0, idbLastSave = null;
            try {
                const idbData = await idbGet(STORAGE_KEY);
                idbOk = !!idbData;
                if (idbData) idbSize = new Blob([idbData]).size;
                idbLastSave = await idbGet('__last_save__');
            } catch(e){}

            // Estimation quota navigateur
            let quotaInfo = null;
            try {
                if (navigator.storage && navigator.storage.estimate) {
                    const est = await navigator.storage.estimate();
                    quotaInfo = { usage: est.usage, quota: est.quota };
                }
            } catch(e){}

            // Persistance accordée ?
            let persisted = null;
            try {
                if (navigator.storage && navigator.storage.persisted) {
                    persisted = await navigator.storage.persisted();
                }
            } catch(e){}

            const fmt = (b) => b < 1024 ? b + ' o' : b < 1048576 ? (b/1024).toFixed(1) + ' Ko' : (b/1048576).toFixed(2) + ' Mo';
            const nbLivreurs = (data.livreurs || []).length;
            const nbHisto = Object.keys(data.historiqueEPOD || {}).length;
            const nbTerrainKeys = (() => { let n=0; for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(k&&k.startsWith('terrain_'))n++;} return n; })();

            let html = '';
            html += diagRow('fa-hdd', 'Données principales (localStorage)', fmt(lsSize), lsSize > 0 ? 'ok' : 'err');
            html += diagRow('fa-layer-group', 'Toutes les clés locales', fmt(lsTotalSize), 'ok');
            html += diagRow('fa-database', 'Copie de sécurité IndexedDB', idbOk ? 'Active — ' + fmt(idbSize) : 'Absente', idbOk ? 'ok' : 'warn');
            html += diagRow('fa-clock', 'Dernière sauvegarde IDB', idbLastSave ? new Date(idbLastSave).toLocaleString('fr-FR') : 'Jamais', idbLastSave ? 'ok' : 'warn');
            html += diagRow('fa-users', 'Livreurs enregistrés', nbLivreurs, 'ok');
            html += diagRow('fa-calendar', 'Jours d\'historique EPOD', nbHisto, 'ok');
            html += diagRow('fa-route', 'Clés Optimisation Terrain', nbTerrainKeys, nbTerrainKeys ? 'ok' : 'warn');
            html += diagRow('fa-shield-alt', 'Stockage persistant accordé', persisted === true ? 'Oui (protégé)' : persisted === false ? 'Non (peut être vidé)' : 'Inconnu', persisted === true ? 'ok' : 'warn');

            // Ligne état cloud + synchronisation
            if (CLOUD_ENABLED) {
                if (currentCloudUser) {
                    html += diagRow('fa-cloud', 'Compte cloud connecté', currentCloudUser.email || '(hors ligne)', 'ok');
                    const st = SyncStatus.get();
                    const meta = SyncMeta.read() || {};
                    const etat = { local: 'Sauvegardé localement', syncing: 'Synchronisation…', synced: 'Synchronisé', offline: 'Hors ligne', conflict: 'Conflit détecté', error: 'Erreur de synchronisation' }[st.status] || st.status;
                    html += diagRow('fa-arrows-rotate', 'État de synchronisation', etat + (st.message ? ' — ' + st.message : ''), st.status === 'synced' ? 'ok' : (st.status === 'error' || st.status === 'conflict') ? 'err' : 'warn');
                    html += diagRow('fa-clock', 'Dernière synchronisation cloud', st.lastCloudSyncAt ? new Date(st.lastCloudSyncAt).toLocaleString('fr-FR') : 'Jamais', st.lastCloudSyncAt ? 'ok' : 'warn');
                    html += diagRow('fa-code-branch', 'Révision cloud connue', meta.revision !== undefined && meta.revision !== null ? '#' + meta.revision : (meta.updatedAt ? meta.updatedAt : '—') + (meta.dirty ? ' (modifications en attente d\'envoi)' : ''), meta.dirty ? 'warn' : 'ok');
                    html += diagRow('fa-database', 'Détection de conflit', _modeRevision === false ? 'Mode dégradé (updated_at) — exécutez supabase-migration.sql' : 'Active (numéro de révision)', _modeRevision === false ? 'warn' : 'ok');
                } else {
                    html += diagRow('fa-cloud', 'Mode cloud', 'Activé (non connecté)', 'warn');
                }
            } else {
                html += diagRow('fa-cloud', 'Mode cloud', 'Non configuré (local seulement)', 'warn');
            }
            html += diagRow('fa-layer-group', 'Version du schéma de données', 'v' + (data.schemaVersion || 0), 'ok');

            if (quotaInfo) {
                const pct = quotaInfo.quota ? (quotaInfo.usage / quotaInfo.quota * 100) : 0;
                html += diagRow('fa-chart-pie', 'Espace utilisé / disponible', `${fmt(quotaInfo.usage)} / ${fmt(quotaInfo.quota)}`, 'ok');
                html += `<div class="storage-diag-bar"><div class="storage-diag-bar-fill" style="width:${Math.min(pct,100)}%"></div></div>`;
            }

            // Conseils
            html += '<div style="margin-top:1rem;padding:0.8rem;background:#f0f9ff;border-radius:8px;font-size:0.82rem;color:#0c4a6e;line-height:1.5">';
            html += '<b><i class="fas fa-lightbulb"></i> Conseils :</b><br>';
            if (persisted !== true) {
                html += '• Cliquez sur "Demander la persistance" ci-dessous pour empêcher le navigateur de vider vos données.<br>';
            }
            html += '• Exportez régulièrement une sauvegarde JSON (bouton ci-dessous) — c\'est votre filet de sécurité ultime.<br>';
            html += '• Vos données sont maintenant copiées dans 2 endroits (localStorage + IndexedDB) pour plus de fiabilité.';
            html += '</div>';

            // v52 — rétention et purge manuelle
            try {
                const m = mesurerStockage();
                const top = m.parts.slice(0, 6).map(([k, n]) => `${k} ${(n / 1048576).toFixed(2)} Mo`).join(' · ');
                html += '<div style="margin-top:0.8rem;padding:0.8rem;background:#fff7ed;border-radius:8px;font-size:0.82rem;color:#7c2d12;line-height:1.5">';
                html += `<b><i class="fas fa-broom"></i> Rétention : ${getRetentionJours()} jours après import</b> — données de l'application ${(m.total / 1048576).toFixed(2)} Mo, terrain ${(m.terrain / 1048576).toFixed(2)} Mo<br>`;
                html += `<span style="font-size:0.76rem;">${escapeHtml(top)}</span><br>`;
                html += 'Conservés sans limite : livreurs, secteurs, historique des salaires, transferts, journal, clôtures.';
                html += '<div style="display:flex;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap;">';
                html += '<button style="background:#ea580c;color:white;padding:0.5rem 0.8rem;border:none;border-radius:8px;font-weight:600;cursor:pointer" onclick="purgerMaintenant()"><i class="fas fa-broom"></i> Purger maintenant</button>';
                html += '<button style="background:#f1f5f9;color:#334155;padding:0.5rem 0.8rem;border:1px solid #cbd5e1;border-radius:8px;font-weight:600;cursor:pointer" onclick="changerRetention()"><i class="fas fa-sliders"></i> Modifier la durée</button>';
                html += '</div></div>';
            } catch (e) {}

            // Bouton demande de persistance
            if (persisted !== true) {
                html += '<div style="margin-top:0.8rem"><button style="width:100%;background:#16a34a;color:white;padding:0.7rem;border:none;border-radius:8px;font-weight:600;cursor:pointer" onclick="requestPersistentStorage()"><i class="fas fa-lock"></i> Demander la persistance (recommandé)</button></div>';
            }

            content.innerHTML = html;

            // Afficher le bouton de migration si un client cloud est connecté
            const migBtn = document.getElementById('diagMigrateBtn');
            if (migBtn) migBtn.style.display = currentCloudUser ? 'block' : 'none';
        }

        function diagRow(icon, label, value, status) {
            return `<div class="storage-diag-row">
                <div class="storage-diag-label"><i class="fas ${icon}" aria-hidden="true"></i> ${escapeHtml(label)}</div>
                <div class="storage-diag-value ${status||''}">${escapeHtml(value)}</div>
            </div>`;
        }

        async function requestPersistentStorage() {
            try {
                if (navigator.storage && navigator.storage.persist) {
                    const granted = await navigator.storage.persist();
                    showToast(granted ? 'Persistance accordée — vos données sont protégées' : 'Le navigateur a refusé la persistance', granted ? 'success' : 'error');
                    showStorageDiagnostic(); // rafraîchir
                } else {
                    showToast('API de persistance non supportée par ce navigateur', 'error');
                }
            } catch(e) { showToast('Erreur : ' + e.message, 'error'); }
        }



        /** Charge les données depuis localStorage (après restauration IDB éventuelle). */
        function loadFromLocalStorage() {
            const saved = AppStorage.readLocalRaw();
            if (saved) {
                try {
                    data = JSON.parse(saved);
                    AppStorage.markLoaded(saved);
                } catch (e) {
                    // JSON corrompu : on NE réinitialise PAS le stockage (pas d'écrasement),
                    // l'application démarre sur une structure vide en mémoire et le
                    // miroir IndexedDB / les instantanés restent disponibles.
                    reportError(ErrorType.LOCAL_STORAGE, e, 'Données locales illisibles : restaurez un instantané (Synchronisation › Instantanés) ou reconnectez-vous au cloud.');
                    if (!data || !data.livreurs) initDefaultDataSansSauvegarde();
                }
            } else {
                initDefaultData();
            }
            normalizeDataAfterLoad();
            selectionnerMoisHistoriqueParDefaut();
        }

        /** Structure vide en mémoire, sans écrire dans le stockage. */
        function initDefaultDataSansSauvegarde() {
            data = {
                livreurs: JSON.parse(JSON.stringify(LIVREURS_INITIAUX)),
                previsions: {}, distributions: {},
                paramètres: { min_colis: 80, max_colis: 160, cible_colis: 110, limite_exceptionnelle: 160 },
                saveHistory: [], historiqueEPOD: {},
                downloadStats: { count: 0, lastDownload: null },
                schemaVersion: CONFIG.schemaVersion
            };
            normalizeDataAfterLoad();
        }

        function initDefaultData() {
            initDefaultDataSansSauvegarde();
            saveLocal({ silencieux: true });
        }

        // ============== SAVE/LOAD ==============
        /**
         * Sauvegarde : localStorage (synchrone) → miroir IndexedDB → cloud (différé).
         * @param {{silencieux?: boolean}} [opts] silencieux : pas de toast (sauvegardes automatiques)
         */
        function saveLocal(opts) {
            try { purgerDonneesPerissables(); } catch (e) { reportError(null, e, null, { silent: true }); }
            data.lastSaved = new Date().toISOString();
            // Les paramètres de planification sont lus depuis le formulaire (comportement historique),
            // uniquement si le formulaire est présent.
            const lire = (id, def) => { const el = document.getElementById(id); return el ? (parseInt(el.value, 10) || def) : undefined; };
            const p = data.paramètres || {};
            data.paramètres = {
                min_colis: lire('minColis', 80) ?? p.min_colis ?? 80,
                max_colis: lire('maxColis', 160) ?? p.max_colis ?? 160,
                cible_colis: lire('cibleColis', 110) ?? p.cible_colis ?? 110,
                limite_exceptionnelle: lire('limiteColis', 160) ?? p.limite_exceptionnelle ?? 160
            };
            if (!Array.isArray(data.saveHistory)) data.saveHistory = [];
            data.saveHistory.unshift({ date: data.lastSaved, type: 'local', livreurs: (data.livreurs || []).length });
            data.saveHistory = data.saveHistory.slice(0, 20);

            const res = AppStorage.writeLocal(JSON.stringify(data));
            if (res.ok) {
                // Alerte préventive à 80 % du quota courant (≈ 5 Mo sur la plupart des navigateurs)
                try {
                    const octets = res.json.length * 2;
                    const quota = (data.quotaLocalStorageOctets || 5 * 1024 * 1024);
                    if (octets > quota * 0.8 && !window._alerteQuotaFaite) {
                        window._alerteQuotaFaite = true;
                        showToast(`Stockage local à ${Math.round(octets / quota * 100)} % (${(octets / 1048576).toFixed(1)} Mo) : purgez des mois anciens`, 'warning');
                    }
                } catch (e) { /* ignore */ }
                idbSaveAll();
            } else {
                // Échec localStorage (quota) : on écrit au moins le miroir IndexedDB directement.
                idbSet(STORAGE_KEY, res.json).catch(() => {});
            }
            if (currentCloudUser) cloudScheduleSave();
            hasUnsavedChanges = false;
            updateSaveStatus();
            updateSaveHistory();
            if (res.merged) { try { updateUI(); } catch (e) { reportError(null, e, null, { silent: true }); } }
            if (!(opts && opts.silencieux) && res.ok) showToast('Sauvegardé', 'success');
        }

        function markUnsaved() {
            hasUnsavedChanges = true;
            updateSaveStatus();
        }

        function updateSaveStatus() {
            const status = document.getElementById('saveStatus');
            if (!status) return;
            if (hasUnsavedChanges) {
                status.className = 'save-status unsaved';
                status.innerHTML = '<i class="fas fa-exclamation-circle" aria-hidden="true"></i><span>Non sauvegardé</span>';
            } else {
                status.className = 'save-status';
                status.innerHTML = '<i class="fas fa-check-circle" aria-hidden="true"></i><span>Sauvegardé</span>';
            }
        }

        // ============== EXPORT/IMPORT ==============
        function exportJSON() {
            // Récupérer toutes les clés "terrain_*" du localStorage
            const terrainData = {};
            try {
                for(let i = 0; i < localStorage.length; i++){
                    const key = localStorage.key(i);
                    if(key && key.startsWith('terrain_')){
                        terrainData[key] = localStorage.getItem(key);
                    }
                }
            } catch(e){ console.warn('[Export] lecture terrain_* échouée', e); }

            const exportData = {
                ...data,
                _terrain: terrainData,         // état de l'onglet Optimisation Terrain (tournées, points, dépôt, étapes, livrés)
                exportDate: new Date().toISOString(),
                version: '4.1'
            };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `planification_livraisons_${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);

            // Statistique : nombre d'éléments sauvegardés
            const stats = [];
            if(data.livreurs)        stats.push(`${data.livreurs.length} livreur(s)`);
            if(data.historiqueEPOD)  stats.push(`${Object.keys(data.historiqueEPOD).length} jour(s) d'historique`);
            const nTerrainKeys = Object.keys(terrainData).length;
            if(nTerrainKeys)         stats.push(`données Terrain (${nTerrainKeys} clé(s))`);
            const blobSizeKB = Math.round(blob.size / 1024);
            showToast(`Sauvegarde exportée (${blobSizeKB} Ko) — ${stats.join(', ')}`, 'success');
        }


        function importJSON(event) {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onerror = () => reportError(ErrorType.IMPORT, reader.error, 'Lecture du fichier impossible.');
            reader.onload = async (e) => {
                let imported;
                try {
                    imported = JSON.parse(e.target.result);
                    if (!imported || typeof imported !== 'object' || Array.isArray(imported)) throw new Error('Structure inattendue');
                } catch (err) {
                    reportError(ErrorType.IMPORT, err, 'Fichier JSON invalide : ' + (err.message || err));
                    return;
                }
                try {
                    // Instantané de l'état actuel AVANT toute modification (annulable).
                    await snapshotCreer('avant import JSON');

                    // 1) Données de planification
                    if (imported.livreurs)          data.livreurs          = imported.livreurs;
                    if (imported.previsions)        data.previsions        = imported.previsions;
                    if (imported.distributions)     data.distributions     = imported.distributions;
                    if (imported.paramètres)        data.paramètres        = imported.paramètres;
                    if (imported.historiqueEPOD)    data.historiqueEPOD    = imported.historiqueEPOD;
                    if (imported.fraisLivreurs)     data.fraisLivreurs     = imported.fraisLivreurs;
                    if (imported.paiementsLivreurs) data.paiementsLivreurs = imported.paiementsLivreurs;
                    if (imported.controlEPOD)       data.controlEPOD       = imported.controlEPOD;
                    if (imported.inventaire)        data.inventaire        = imported.inventaire;
                    // Champs supplémentaires éventuels (configuration grille, secteurs, exceptions...)
                    ['grilleRemuneration', 'comptesTechniques', 'bonusAeVehicule', 'seuilPudoPct',
                     'transfertsColis', 'anomaliesTournees', 'pointsDetection',
                     'seuilAlerteSousCharge', 'tarifPudoPenalite', 'cpExceptions', 'ongletsVisibles',
                     'preferences', 'schemaVersion'].forEach(k => {
                        if (k in imported) data[k] = imported[k];
                    });
                    // Les anciennes sauvegardes (sans schemaVersion) repassent par les migrations.
                    if (!('schemaVersion' in imported)) delete data.schemaVersion;
                    normalizeDataAfterLoad();

                    // 2) Données de l'onglet Optimisation Terrain
                    let nTerrain = 0;
                    if (imported._terrain && typeof imported._terrain === 'object') {
                        const t = {};
                        for (const [k, v] of Object.entries(imported._terrain)) {
                            if (typeof v === 'string' && k.startsWith('terrain_')) { t[k] = v; nTerrain++; }
                        }
                        ecrireClesTerrain(t, { remplacer: true });
                        try { if (typeof window.terrainReloadFromStorage === 'function') window.terrainReloadFromStorage(); } catch (e2) { /* ignore */ }
                    }

                    saveLocal({ silencieux: true });
                    updateUI();

                    const stats = [];
                    if (imported.livreurs)       stats.push(`${imported.livreurs.length} livreur(s)`);
                    if (imported.historiqueEPOD) stats.push(`${Object.keys(imported.historiqueEPOD).length} mois d'historique`);
                    if (nTerrain)                stats.push('données Terrain');
                    showToast(`Import réussi — ${stats.join(', ')}. L'état précédent est conservé dans les instantanés.`, 'success');
                } catch (err) {
                    reportError(ErrorType.IMPORT, err, 'Import interrompu : ' + (err.message || err) + '. Restaurez l\'instantané « avant import JSON » si nécessaire.');
                }
            };
            reader.readAsText(file);
            event.target.value = '';
        }

        async function resetData() {
            if (!confirm('Êtes-vous sûr de vouloir réinitialiser toutes les données ?\n\nCela effacera aussi vos tournées de l\'onglet Optimisation Terrain. Un instantané de sécurité sera créé avant (Synchronisation › Instantanés).')) return;
            await snapshotCreer('avant réinitialisation complète');
            try {
                const toRemove = Object.keys(lireClesTerrain());
                toRemove.forEach(k => localStorage.removeItem(k));
            } catch (e) { /* ignore */ }
            initDefaultData();
            try { if (typeof window.terrainReloadFromStorage === 'function') window.terrainReloadFromStorage(); } catch (e) { /* ignore */ }
            updateUI();
            showToast('Données réinitialisées (un instantané de sécurité a été créé)', 'info');
        }

        function selectionnerMoisHistoriqueParDefaut() {
            try {
                const histo = data.historiqueEPOD || {};
                const moisAvecData = Object.keys(histo)
                    .filter(m => histo[m] && Object.keys(histo[m]).length > 0)
                    .sort();
                const moisCourant = new Date().toISOString().slice(0, 7);
                if (data.dernierMoisHistorique && histo[data.dernierMoisHistorique]
                        && Object.keys(histo[data.dernierMoisHistorique]).length > 0) {
                    selectedHistoriqueMonth = data.dernierMoisHistorique;
                } else if ((!histo[moisCourant] || Object.keys(histo[moisCourant]).length === 0)
                        && moisAvecData.length > 0) {
                    selectedHistoriqueMonth = moisAvecData[moisAvecData.length - 1];
                }
            } catch (e) { /* ignore */ }
        }

