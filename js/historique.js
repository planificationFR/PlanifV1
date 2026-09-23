        // ============== HISTORIQUE EPOD ==============
        function handleEPODDragOver(event) {
            event.preventDefault();
            document.getElementById('uploadZoneEPOD').classList.add('drag-over');
        }

        function handleEPODDragLeave(event) {
            document.getElementById('uploadZoneEPOD').classList.remove('drag-over');
        }

        function handleEPODDrop(event) {
            event.preventDefault();
            document.getElementById('uploadZoneEPOD').classList.remove('drag-over');
            const file = event.dataTransfer.files[0];
            if (file) processEPODFile(file);
        }

        function handleEPODUpload(event) {
            const file = event.target.files[0];
            if (file) processEPODFile(file);
            event.target.value = '';
        }

        /**
         * PIPELINE D'INGESTION UNIQUE (v46).
         * ──────────────────────────────────────────────────────────────────
         * L'Historique propose deux boutons d'import : la zone « Importer un
         * fichier EPOD » et « Analyser EPOD mensuel complet ». Le second ne
         * faisait qu'afficher un rapport : il n'alimentait pas l'historique,
         * ne lançait pas la détection de tournées simultanées et n'appliquait
         * aucune réaffectation. Selon le bouton utilisé, le résultat n'était
         * donc pas le même.
         *
         * Les deux passent désormais par cette fonction : mêmes données,
         * mêmes détections, mêmes salaires.
         *
         * @param {Array} jsonData  lignes brutes du fichier
         * @returns {object|null} résultat du parse, ou null si rien d'exploitable
         */
        function ingererEPOD(jsonData) {
            if (!Array.isArray(jsonData) || jsonData.length === 0) {
                showToast('Le fichier est vide', 'error');
                return null;
            }
            const result = parseEPODData(jsonData);
            if (!result || result.count <= 0) {
                showToast('Aucune donnée de livraison trouvée', 'error');
                return null;
            }
            // v51 — un mois clôturé n'est jamais écrasé par un réimport
            const moisClos = Object.keys(result.data || {}).filter(m => moisEstCloture(m));
            if (moisClos.length) {
                moisClos.forEach(m => { delete result.data[m]; });
                result.anomaliesTournees = (result.anomaliesTournees || []).filter(a => !moisClos.includes(a.date.slice(0, 7)));
                result._sousSeuil = (result._sousSeuil || []).filter(a => !moisClos.includes(a.date.slice(0, 7)));
                result._points = (result._points || []).filter(p => !moisClos.includes(String(p.d).slice(0, 7)));
                showToast(`${moisClos.map(formatMonthName).join(', ')} : mois clôturé, données ignorées`, 'warning');
                if (!Object.keys(result.data).length) return null;
            }
            mergeEPODData(result.data);

            // L'ancien registre epodTransferts n'a aucun effet sur la paie.
            delete data.epodTransferts;

            // Détections de tournées simultanées : on conserve les décisions
            // déjà prises pour ne pas les redemander à chaque réimport.
            if (!data.anomaliesTournees) data.anomaliesTournees = {};
            const parMois = {};
            [...(result.anomaliesTournees || []), ...(result._sousSeuil || [])].forEach(a => {
                const m0 = a.date.slice(0, 7);
                (parMois[m0] = parMois[m0] || []).push(a);
            });
            if (!data.renfortsQualite) data.renfortsQualite = {};
            Object.keys(parMois).forEach(m0 => { data.renfortsQualite[m0] = result._qualite || null; marquerImport('anomalies:' + m0); });
            [...new Set((result._points || []).map(p => String(p.d).slice(0, 7)))].forEach(m0 => marquerImport('points:' + m0));
            Object.keys(parMois).forEach(m0 => {
                // Seuls les refus explicites sont mémorisés : une réaffectation
                // doit pouvoir être recalculée à chaque import.
                const decisions = {};
                (data.anomaliesTournees[m0] || []).forEach(a => {
                    if (a.statut === 'ignore') decisions[a.id] = 'ignore';
                });
                data.anomaliesTournees[m0] = parMois[m0].map(a =>
                    decisions[a.id] ? { ...a, statut: decisions[a.id] } : a);
            });

            // Les détections sont complètes : on repart propre.
            delete data._detectionARefaire;
            Object.keys(result.data || {}).forEach(m0 => {
                if (Array.isArray(data.transfertsColis?.[m0])) {
                    data.transfertsColis[m0] = data.transfertsColis[m0].filter(t => t.mode !== 'auto');
                }
            });

            // RÈGLE GÉNÉRALE : quand le livreur réel est identifié sans
            // ambiguïté, les colis lui sont recomptés immédiatement.
            let autoAffect = { n: 0, colis: 0, details: [] };
            try { autoAffect = appliquerAnomaliesCertaines(true); }
            catch (e) { console.warn('[Transferts] auto', e); }
            result._autoAffect = autoAffect;

            // v47 — On mémorise les points de détection (livreur, date, heure,
            // position) sous forme compressée. Sans cela, relancer la détection
            // exigeait de retrouver le fichier Excel d'origine : les coordonnées
            // n'existent nulle part ailleurs. Désormais la détection peut être
            // rejouée à tout moment, sur n'importe quel appareil.
            try { memoriserPointsDetection(result._points || []); }
            catch (e) { console.warn('[Détection] mémorisation', e); }

            // Contrôle EPOD alimenté par le même import
            try { ccIngestRows(jsonData, { silencieux: true }); }
            catch (e) { console.warn('[CC] ingestion', e); }

            // Se placer sur le mois qui contient le plus de nouvelles données
            let bestMonth = null, bestCount = 0;
            Object.entries(result.data).forEach(([m0, livs]) => {
                const total = Object.values(livs).reduce((a, l) => a + (l.totalLivres || 0), 0);
                if (total > bestCount) { bestCount = total; bestMonth = m0; }
            });
            if (bestMonth) {
                selectedHistoriqueMonth = bestMonth;
                data.dernierMoisHistorique = bestMonth;
            }
            result._bestMonth = bestMonth;

            saveLocal();
            refreshHistorique();
            return result;
        }

        // ═══════════════════════════════════════════════════════════════════
        // v52 — CLASSIFICATION DES FICHIERS ET GARDE D'IMPORT
        // ───────────────────────────────────────────────────────────────────
        // Deux exports au même schéma (84 colonnes) circulent :
        //   · « réalisé »  : statuts terminés, livreur et heure de livraison
        //                    renseignés → salaires, contrôle colis, renforts ;
        //   · « prévision »: 100 % « Créé », aucun livreur, aucune heure, date
        //                    future → planification, analyse d'adresses.
        // S'y ajoute le fichier « agrégé » (CP + nombre de colis).
        // Chaque point d'entrée déclare ce qu'il accepte ; un fichier de la
        // mauvaise classe déclenche une modale bloquante avec redirection.
        // ═══════════════════════════════════════════════════════════════════

        const _fcNorm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

        /** Tableau « header:1 » → tableau d'objets (sans copier si déjà des objets). */
        function fichierEnObjets(rows) {
            if (!Array.isArray(rows) || !rows.length) return [];
            if (!Array.isArray(rows[0])) return rows;
            const header = rows[0].map(h => String(h ?? '').trim());
            const out = [];
            for (let i = 1; i < rows.length; i++) {
                const r = rows[i]; if (!r || !r.length) continue;
                const o = {}; let vide = true;
                header.forEach((h, j) => { if (!h) return; const v = r[j]; if (v !== undefined && v !== null && v !== '') { o[h] = v; vide = false; } });
                if (!vide) out.push(o);
            }
            return out;
        }

        /**
         * Classe un fichier importé.
         * @returns {{classe:'realise'|'partiel'|'prevision'|'agrege'|'inconnu', libelle:string, detail:string, resume:Object}}
         */
        function classifierFichierEPOD(rowsIn) {
            const rows = fichierEnObjets(rowsIn);
            const n = rows.length;
            const cles = new Set(); rows.slice(0, 200).forEach(r => Object.keys(r).forEach(k => cles.add(_fcNorm(k))));
            const trouve = (...cands) => [...cles].find(k => cands.some(c => k === _fcNorm(c)));
            const nbCol = cles.size;
            const colStatut = trouve('Statut', 'Task Status', 'Status');
            const colLivreur = trouve('Petit nom de membre', 'Chauffeur', 'Courier Name', 'Livreur', 'Driver Name', 'Driver');
            const colHeure = trouve('Délai de livraison', 'Sign Time', 'Delivery Time');
            const colHeureEchec = trouve("Délai d'échec de livraison", 'Delivery Fail Time', 'Delivery Failure Time');
            const colDate = trouve('Date de la tâche', 'Task Date', 'Date');
            const colCP = trouve('Code postal', 'Code postal de destination', 'Zip Code', 'Postal Code', 'CP', 'Secteur');
            const resume = { lignes: n, colonnes: nbCol, statuts: {}, livreurs: 0, heures: 0, dates: [], termines: 0, crees: 0 };
            if (!n) return { classe: 'inconnu', libelle: 'fichier vide', detail: '', resume };

            // Agrégé : peu de colonnes, une colonne CP, une colonne quantité numérique
            if (nbCol <= 6 && colCP && !colStatut && !colLivreur) {
                return { classe: 'agrege', libelle: 'fichier agrégé (code postal + nombre de colis)', detail: `${n} lignes, ${nbCol} colonnes`, resume };
            }
            const rk = r => { const o = {}; Object.keys(r).forEach(k => o[_fcNorm(k)] = r[k]); return o; };
            const livreurs = new Set(), dates = new Set();
            rows.forEach(r => {
                const o = rk(r);
                const st = _fcNorm(colStatut ? o[colStatut] : '');
                if (st) resume.statuts[st] = (resume.statuts[st] || 0) + 1;
                if (st.includes('reussi') || st.includes('success') || st.includes('echou') || st.includes('echec') || st.includes('fail') || st.includes('delivered')) resume.termines++;
                else if (st.includes('cree') || st.includes('create')) resume.crees++;
                const l = colLivreur ? o[colLivreur] : ''; if (l !== undefined && l !== null && String(l).trim()) livreurs.add(String(l).trim());
                const h = colHeure ? o[colHeure] : ''; const he = colHeureEchec ? o[colHeureEchec] : '';
                if ((h !== undefined && h !== null && String(h).trim()) || (he !== undefined && he !== null && String(he).trim())) resume.heures++;
                const d = colDate ? o[colDate] : ''; if (d) { const ds = (d instanceof Date) ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) dates.add(ds); }
            });
            resume.livreurs = livreurs.size;
            resume.dates = [...dates].sort();
            const pctTermines = resume.termines / n, pctCrees = resume.crees / n;
            const aujourdhui = new Date().toISOString().slice(0, 10);
            const futur = resume.dates.length > 0 && resume.dates[0] >= aujourdhui;
            const plage = resume.dates.length ? (resume.dates.length === 1 ? resume.dates[0] : `${resume.dates[0]} → ${resume.dates[resume.dates.length - 1]}`) : 'date inconnue';

            if (!colStatut && !colLivreur && !colHeure) return { classe: 'inconnu', libelle: 'format non reconnu', detail: `${n} lignes, ${nbCol} colonnes, aucune colonne statut/livreur/heure`, resume };
            // v53 — debrief du soir : échecs avec Action DSP ; tournée du matin : « En livraison » avec livreur
            const colDsp = trouve('Action DSP', 'DSP Action', 'dspAction');
            let echecs = 0, dsp = 0, enCours = 0;
            rows.forEach(r => { const o = rk(r); const st = _fcNorm(colStatut ? o[colStatut] : ''); if (st.includes('echou') || st.includes('echec') || st.includes('fail')) echecs++; if (st.includes('en livraison') || st.includes('in delivery') || st.includes('delivering') || st.includes('expedi') || st.includes('shipped') || st.includes('en cours')) enCours++; if (colDsp && o[colDsp] !== undefined && o[colDsp] !== null && String(o[colDsp]).trim()) dsp++; });
            if (echecs >= n * 0.9 && dsp >= n * 0.5)
                return { classe: 'debrief', libelle: 'DEBRIEF du soir (échecs avec action DSP)', detail: `${n} colis en échec, ${dsp} avec action DSP, ${plage}`, resume };
            if (enCours >= n * 0.9 && resume.livreurs > 0)
                return { classe: 'tournee', libelle: 'TOURNÉE du jour (colis en livraison)', detail: `${n} colis « En livraison », ${resume.livreurs} livreurs, ${plage}`, resume };
            if (pctCrees >= 0.95 && resume.livreurs === 0 && resume.heures === 0)
                return { classe: 'prevision', libelle: 'export de PRÉVISIONS', detail: `${n} tâches « Créé », ${plage}${futur ? ' (à venir)' : ''}, aucun livreur, aucune heure de livraison`, resume };
            if (pctTermines >= 0.5 && resume.livreurs > 0 && resume.heures > 0)
                return { classe: 'realise', libelle: 'export RÉALISÉ', detail: `${n} tâches dont ${resume.termines} terminées, ${resume.livreurs} livreurs, ${plage}`, resume };
            if (resume.termines > 0 && (pctCrees > 0.2 || resume.heures < resume.termines * 0.5))
                return { classe: 'partiel', libelle: 'export PARTIEL (journée en cours ?)', detail: `${n} tâches : ${resume.termines} terminées, ${resume.crees} encore « Créé », ${plage}`, resume };
            return { classe: 'inconnu', libelle: 'format ambigu', detail: `${n} tâches, ${resume.termines} terminées, ${resume.crees} créées, ${resume.livreurs} livreurs, ${plage}`, resume };
        }

        const FC_LIBELLES_ONGLET = {
            epod: 'Historique EPOD (salaires)',
            recap: 'Récapitulatif mensuel',
            import: 'Prévisions (onglet Import)',
            cc: 'Contrôle EPOD',
            terrain: 'Terrain — analyse d\'adresses'
        };
        /** Redirections proposées quand un fichier arrive au mauvais endroit. */
        function _fcRedirection(classe) {
            if (classe === 'prevision' || classe === 'agrege') return { cible: 'import', action: rows => { switchTab('previsions'); const res = processImportedData(rows); if (res.success) { showImportResults(res); markUnsaved(); updateUI(); } } };
            if (classe === 'realise') return { cible: 'epod', action: rows => { switchTab('historique'); const r = ingererEPOD(fichierEnObjets(rows)); if (r) showEPODImportResults(r); } };
            if (classe === 'debrief' || classe === 'tournee') return { cible: 'cc', action: rows => { switchTab('controle'); const res = ccIngestRows(fichierEnObjets(rows)); showToast(res.months.length ? `Journée(s) importée(s) dans Contrôle EPOD` : 'Aucune ligne datée reconnue', res.months.length ? 'success' : 'error'); } };
            return null;
        }

        /**
         * Garde d'import. Résout `true` si l'import peut continuer ici.
         * @param rows       lignes lues (objets ou header:1)
         * @param onglet     clé de FC_LIBELLES_ONGLET
         * @param acceptees  classes acceptées sans question
         * @param tolerees   classes acceptées avec avertissement (non bloquant)
         */
        function verifierClasseFichier(rows, onglet, acceptees, tolerees) {
            const c = classifierFichierEPOD(rows);
            if (acceptees.includes(c.classe)) return Promise.resolve(true);
            if ((tolerees || []).includes(c.classe)) { showToast(`Attention : ${c.libelle} — ${c.detail}`, 'warning'); return Promise.resolve(true); }
            const redir = _fcRedirection(c.classe);
            const redirDifferent = redir && redir.cible !== onglet;
            return new Promise(resolve => {
                const overlay = document.createElement('div');
                overlay.className = 'modal-overlay active modal-dynamique';
                overlay.style.zIndex = '100001';
                overlay.innerHTML = `
                  <div class="modal" style="max-width:560px;">
                    <div class="modal-header">
                      <h3 style="margin:0;color:var(--danger);"><i class="fas fa-triangle-exclamation"></i> Mauvais fichier ?</h3>
                    </div>
                    <div class="modal-body" style="padding:1rem 1.25rem 1.25rem;font-size:0.9rem;">
                      <p>Ce fichier ressemble à un <strong>${escapeHtml(c.libelle)}</strong> :<br><span style="color:var(--text-secondary);">${escapeHtml(c.detail)}</span></p>
                      <p><strong>${escapeHtml(FC_LIBELLES_ONGLET[onglet] || onglet)}</strong> attend : ${acceptees.map(k => ({ realise: 'un export réalisé (livraisons terminées)', prevision: 'un export de prévisions (tâches « Créé »)', agrege: 'un fichier agrégé CP + colis', partiel: 'un export partiel', debrief: 'un debrief du soir', tournee: 'la tournée du jour' }[k] || k)).join(' ou ')}.</p>
                      ${c.classe === 'prevision' && onglet === 'epod' ? '<p style="color:var(--danger);">Importé ici, ce fichier ne contient aucune livraison : rien ne serait payé et une fausse journée pourrait apparaître.</p>' : ''}
                      ${(c.classe === 'debrief' || c.classe === 'tournee') && onglet === 'epod' ? '<p style="color:var(--danger);">Importé ici, ce fichier <strong>remplacerait les colis livrés de la journée par 0</strong> pour ces livreurs. Il va dans Contrôle EPOD.</p>' : ''}
                      ${c.classe === 'realise' && onglet === 'import' ? '<p style="color:var(--danger);">Importé ici, les colis déjà livrés seraient replanifiés comme prévisions.</p>' : ''}
                      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;justify-content:flex-end;margin-top:1rem;">
                        <button class="btn btn-sm" id="fcAnnuler" style="background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);"><i class="fas fa-times"></i> Annuler</button>
                        <button class="btn btn-sm" id="fcForcer" style="background:rgba(231,76,60,0.12);color:var(--danger);border:1px solid rgba(231,76,60,0.4);"><i class="fas fa-exclamation"></i> Importer quand même</button>
                        ${redirDifferent ? `<button class="btn btn-sm btn-primary" id="fcRediriger"><i class="fas fa-arrow-right"></i> Importer dans ${escapeHtml(FC_LIBELLES_ONGLET[redir.cible])}</button>` : ''}
                      </div>
                    </div>
                  </div>`;
                document.body.appendChild(overlay);
                overlay.querySelector('#fcAnnuler').onclick = () => { overlay.remove(); showToast('Import annulé', 'info'); resolve(false); };
                overlay.querySelector('#fcForcer').onclick = () => { overlay.remove(); journaliserImportForce(onglet, c); resolve(true); };
                const rb = overlay.querySelector('#fcRediriger');
                if (rb) rb.onclick = () => { overlay.remove(); resolve(false); try { redir.action(rows); } catch (e) { console.error('[Redirection import]', e); showToast('Redirection impossible', 'error'); } };
            });
        }
        function journaliserImportForce(onglet, c) {
            try {
                if (!Array.isArray(data.importsForces)) data.importsForces = [];
                data.importsForces.push({ ts: new Date().toISOString(), onglet, classe: c.classe, detail: c.detail, par: _acteurCourant() });
                if (data.importsForces.length > 100) data.importsForces.splice(0, data.importsForces.length - 100);
            } catch (e) {}
        }

        // ═══════════════════════════════════════════════════════════════════
        // v52 — RÉTENTION : 7 jours à partir de la date d'import
        // ───────────────────────────────────────────────────────────────────
        // Conservé sans limite : livreurs et configuration, secteurs, historique
        // EPOD (colis / jour / livreur — base des salaires), transferts, journal,
        // clôtures, décisions de renfort, paramètres.
        // Purgé `retentionJours` jours après leur import : points de détection,
        // détail Contrôle colis, listes de colis des anomalies, prévisions et
        // distributions, données Terrain et Scan.
        // ═══════════════════════════════════════════════════════════════════
        const RETENTION_JOURS_DEFAUT = 7;
        function getRetentionJours() { const n = parseInt(data.retentionJours, 10); return (isFinite(n) && n > 0) ? n : RETENTION_JOURS_DEFAUT; }

        /** Horodate un import : cle = « points:2026-08 », « cc:2026-08 », « previsions:2026-09-15 », « terrain »… */
        function marquerImport(cle) {
            if (!data.datesImport) data.datesImport = {};
            data.datesImport[cle] = new Date().toISOString();
        }

        /** Purge les données périssables importées il y a plus de `retentionJours` jours. */
        function purgerDonneesPerissables(options) {
            const force = !!(options && options.force);
            const jours = getRetentionJours();
            const limite = Date.now() - jours * 86400000;
            if (!data.datesImport) data.datesImport = {};
            const di = data.datesImport;
            // Données antérieures à la v52 (sans date d'import connue) : on les
            // horodate maintenant plutôt que de les effacer d'un coup.
            const perime = cle => { if (force) return true; if (!di[cle]) { di[cle] = new Date().toISOString(); return false; } return new Date(di[cle]).getTime() < limite; };
            const supprimes = [];
            const del = (cle, libelle) => { supprimes.push(libelle); delete di[cle]; };

            Object.keys(data.pointsDetection || {}).forEach(m => { if (perime('points:' + m)) { delete data.pointsDetection[m]; del('points:' + m, `points de détection ${m}`); } });
            Object.keys(data.controlEPOD || {}).forEach(m => { if (perime('cc:' + m)) { delete data.controlEPOD[m]; del('cc:' + m, `contrôle colis ${m}`); } });
            Object.keys(data.anomaliesTournees || {}).forEach(m => {
                if (!perime('anomalies:' + m)) return;
                let n = 0;
                (data.anomaliesTournees[m] || []).forEach(a => { if (a.colis || a.sequence) { delete a.colis; delete a.sequence; a.detailPurge = true; n++; } });
                if (n) del('anomalies:' + m, `détail des colis de ${n} détection(s) ${m}`); else delete di['anomalies:' + m];
            });
            Object.keys(data.ccJour || {}).forEach(d => { if (perime('ccjour:' + d)) { delete data.ccJour[d]; del('ccjour:' + d, `listes du jour ${d}`); } });
            Object.keys(data.previsions || {}).forEach(d => { if (perime('previsions:' + d)) { delete data.previsions[d]; if (data.distributions) delete data.distributions[d]; del('previsions:' + d, `prévisions ${d}`); } });
            if (data.renfortsQualite) Object.keys(data.renfortsQualite).forEach(m => { if (!data.pointsDetection || !data.pointsDetection[m]) { if (data.renfortsQualite[m] && data.renfortsQualite[m].journees) delete data.renfortsQualite[m].journees; if (data.renfortsQualite[m] && data.renfortsQualite[m].doublesLivraisons) data.renfortsQualite[m].doublesLivraisons = data.renfortsQualite[m].doublesLivraisons.slice(0, 20); } });
            try {
                const savedAt = parseInt(localStorage.getItem('terrain_points_savedAt') || '0', 10);
                if (force || (savedAt && savedAt < limite)) {
                    let n = 0;
                    for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('terrain_') && !k.startsWith('terrain_depot')) { localStorage.removeItem(k); n++; } }
                    if (n) supprimes.push('données Terrain');
                }
            } catch (e) {}
            if (supprimes.length) console.log('[Rétention] purgé :', supprimes.join(', '));
            return supprimes;
        }

        /** Taille approximative des données locales, par section. */
        function mesurerStockage() {
            const parts = {};
            let total = 0;
            Object.entries(data).forEach(([k, v]) => { try { const n = JSON.stringify(v).length * 2; parts[k] = n; total += n; } catch (e) {} });
            let terrain = 0;
            try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('terrain_')) terrain += (localStorage.getItem(k) || '').length * 2; } } catch (e) {}
            return { total, terrain, parts: Object.entries(parts).sort((a, b) => b[1] - a[1]) };
        }

        function purgerMaintenant() {
            const m = mesurerStockage();
            const jours = getRetentionJours();
            const msg = `Effacer maintenant toutes les données périssables (points de détection, contrôle colis, détail des colis des renforts, prévisions, terrain, scan) ?\n\nSont conservés : livreurs, secteurs, historique des salaires, transferts, journal, clôtures.\n\nTaille actuelle : ${(m.total / 1048576).toFixed(2)} Mo (+ ${(m.terrain / 1048576).toFixed(2)} Mo terrain). Rétention automatique : ${jours} jours après import.`;
            if (!confirm(msg)) return;
            const s = purgerDonneesPerissables({ force: true });
            markUnsaved(); saveLocal();
            const m2 = mesurerStockage();
            showToast(`${s.length} élément(s) effacé(s) — ${(m2.total / 1048576).toFixed(2)} Mo restants`, 'success');
            try { refreshHistorique(); } catch (e) {}
            try { if (typeof showStorageDiagnostic === 'function' && document.getElementById('storageDiagOverlay')?.classList.contains('active')) showStorageDiagnostic(); } catch (e) {}
        }

        function changerRetention() {
            const v = prompt('Nombre de jours de conservation des données périssables après leur import :', String(getRetentionJours()));
            if (v === null) return;
            const n = parseInt(v, 10);
            if (!isFinite(n) || n < 1) { showToast('Valeur invalide', 'error'); return; }
            data.retentionJours = n; markUnsaved(); saveLocal();
            showToast(`Rétention : ${n} jours`, 'success');
        }

        /**
         * v51 — Lecture du classeur dans un Web Worker : SheetJS sur un export de
         * 7 Mo bloque l'interface 2 à 4 s sur le thread principal. Le Worker
         * (js/workers/xlsx-worker.js) charge SheetJS depuis vendor/. En cas d'échec (CSP, navigateur ancien), repli
         * transparent sur la lecture classique.
         */
        function lireClasseurEnWorker(file) {
            return new Promise((resolve, reject) => {
                if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || !file.arrayBuffer) return reject(new Error('Worker indisponible'));
                let w = null;
                try { w = new Worker('js/workers/xlsx-worker.js'); }
                catch (e) { return reject(e); }
                const fin = () => { try { w.terminate(); } catch (e) {} };
                w.onmessage = ev => { fin(); if (ev.data && ev.data.ok) resolve(ev.data.rows); else reject(new Error(ev.data && ev.data.err || 'Lecture impossible')); };
                w.onerror = ev => { fin(); reject(new Error(ev.message || 'Erreur Worker')); };
                file.arrayBuffer().then(buf => w.postMessage(buf, [buf])).catch(e => { fin(); reject(e); });
            });
        }

        async function processEPODFile(file) {
            showToast('Lecture du fichier…', 'info');
            let jsonData = null;
            try { jsonData = await lireClasseurEnWorker(file); }
            catch (e) { console.warn('[EPOD] Worker indisponible, lecture sur le thread principal :', e && e.message); }
            if (jsonData) {
                try {
                    if (jsonData.length === 0) { showToast('Le fichier est vide', 'error'); return; }
                    if (!(await verifierClasseFichier(jsonData, 'epod', ['realise'], ['partiel']))) return;
                    const result = ingererEPOD(jsonData);
                    if (result) {
                        showEPODImportResults(result);
                        const a = result._autoAffect || { n: 0, colis: 0 };
                        showToast(`${result.count} enregistrements importés (${result._bestMonth ? formatMonthName(result._bestMonth) : ''})`
                            + (a.n ? ` · ${a.colis} colis réaffectés au bon livreur` : ''), 'success');
                    } else {
                        showToast('Aucune donnée de livraison trouvée', 'error');
                    }
                } catch (error) {
                    console.error('Erreur import EPOD:', error);
                    showToast('Erreur lors de l\'import du fichier', 'error');
                }
                return;
            }
            await loadXLSXLib();
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const workbook = XLSX.read(e.target.result, { type: 'binary' });
                    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                    const jsonData = XLSX.utils.sheet_to_json(firstSheet);
                    if (jsonData.length === 0) {
                        showToast('Le fichier est vide', 'error');
                        return;
                    }
                    if (!(await verifierClasseFichier(jsonData, 'epod', ['realise'], ['partiel']))) return;
                    const result = ingererEPOD(jsonData);
                    if (result) {
                        showEPODImportResults(result);
                        const a = result._autoAffect || { n: 0, colis: 0 };
                        showToast(`${result.count} enregistrements importés (${result._bestMonth ? formatMonthName(result._bestMonth) : ''})`
                            + (a.n ? ` · ${a.colis} colis réaffectés au bon livreur` : ''), 'success');
                    } else {
                        showToast('Aucune donnée de livraison trouvée', 'error');
                    }
                } catch (error) {
                    console.error('Erreur import EPOD:', error);
                    showToast('Erreur lors de l\'import du fichier', 'error');
                }
            };
            reader.readAsBinaryString(file);
        }

        function parseEPODData(jsonData) {
            // Helper: lookup d'une colonne en ignorant casse, accents et espaces
            // (mémoïsé : 84 colonnes × 18 000 lignes = 1,5 M d'appels sinon)
            const _normCache = new Map();
            const norm = s => { const k = String(s); let v = _normCache.get(k); if (v === undefined) { v = k.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim(); _normCache.set(k, v); } return v; };
            const getField = (row, keys, rowKeysNorm) => {
                for (const k of keys) {
                    const n = norm(k);
                    if (rowKeysNorm[n] !== undefined && rowKeysNorm[n] !== null && rowKeysNorm[n] !== '') return rowKeysNorm[n];
                }
                return undefined;
            };

            // Détecter le format en regardant la première ligne
            // Format LIGNE-PAR-LIGNE (1 ligne = 1 colis) :
            //   - EN : Task Date, Courier Name, Task Status, PUDO address
            //   - FR : Date de la tâche, Petit nom de membre, Statut, PUDO address
            // Format AGRÉGÉ (1 ligne = 1 livreur/jour) : route plan date, driver name, delivery complete qty
            const firstRow = jsonData[0] || {};
            const firstRowKeysNorm = {};
            Object.keys(firstRow).forEach(k => { firstRowKeysNorm[norm(k)] = firstRow[k]; });

            // Détection bilingue : on cherche des marqueurs caractéristiques du format ligne-par-ligne
            const hasTaskDateEN = firstRowKeysNorm['task date'] !== undefined;
            const hasTaskDateFR = firstRowKeysNorm['date de la tache'] !== undefined;
            const hasCourierEN = firstRowKeysNorm['courier name'] !== undefined;
            const hasCourierFR = firstRowKeysNorm['petit nom de membre'] !== undefined;
            // v52 — deux traductions FR coexistent (« Chauffeur ») et la première
            // ligne peut avoir un livreur vide (tâche « Créé ») : on regarde les
            // EN-TÊTES des 50 premières lignes, pas les valeurs de la première.
            const enTetes = new Set(); jsonData.slice(0, 50).forEach(r => Object.keys(r || {}).forEach(k => enTetes.add(norm(k))));
            const aDate = enTetes.has('task date') || enTetes.has('date de la tache');
            const aLivreur = ['courier name', 'petit nom de membre', 'chauffeur', 'livreur', 'driver name', 'driver'].some(k => enTetes.has(k));

            const isLineByLineFormat = ((hasTaskDateEN || hasTaskDateFR) && (hasCourierEN || hasCourierFR)) || (aDate && aLivreur);

            if (isLineByLineFormat) {
                return parseEPODLineByLine(jsonData, getField, norm);
            } else {
                return parseEPODAggregate(jsonData, getField, norm);
            }
        }

        /**
         * Horodatage tolérant : Date, nombre Excel, « YYYY-MM-DD HH:MM[:SS] »,
         * « DD/MM/YYYY HH:MM[:SS] », ou « HH:MM[:SS] » seul (complété par la date
         * de la tâche). Renvoie null si rien n'est interprétable.
         */
        function parseHorodatageEPOD(raw, dateISO) {
            if (raw === undefined || raw === null || raw === '') return null;
            if (raw instanceof Date) return isNaN(raw) ? null : raw.getTime();
            if (typeof raw === 'number') {
                if (raw < 1 && dateISO) { const [y, m, d] = dateISO.split('-').map(Number); return new Date(y, m - 1, d).getTime() + Math.round(raw * 86400000); }
                return new Date(1899, 11, 30).getTime() + Math.round(raw * 86400000);
            }
            const s = String(raw).trim();
            let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
            if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
            m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
            if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
            m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
            if (m && dateISO) { const [y, mo, d] = dateISO.split('-').map(Number); return new Date(y, mo - 1, d, +m[1], +m[2], +(m[3] || 0)).getTime(); }
            const d = new Date(s.replace(' ', 'T'));
            return isNaN(d) ? null : d.getTime();
        }

        // ========== FORMAT LIGNE-PAR-LIGNE (nouveau EPOD ligne par ligne) ==========
        function parseEPODLineByLine(jsonData, getField, norm) {
            // ── PASSE 0 : schéma — repli par contenu pour les coordonnées ──
            // Si aucune colonne GPS n'est reconnue par son nom, on cherche une
            // paire (lat, lon) par le contenu (décimales, bornes, variabilité).
            // Une ambiguïté (plusieurs paires plausibles) est signalée, jamais
            // tranchée en silence.
            const _qualite = { lignes: jsonData.length, heuresNonParsees: 0, avertissements: [] };
            const _gpsFallback = (() => {
                const sample = jsonData.slice(0, 300);
                const nomsConnus = new Set(['dimension', 'dimension_1', 'dimension.1', 'latitude', 'longitude', 'longitude_1', 'longitude.1', 'receiver to latitude', 'receiver to longitude', 'actual delivery latitude', 'actual delivery longitude']);
                const parNom = sample.some(r => Object.keys(r).some(k => nomsConnus.has(norm(k))));
                if (parNom) return null;
                const keys = Object.keys(sample[0] || {});
                const stats = (k) => {
                    let ok = 0, dec = 0, min = Infinity, max = -Infinity, tot = 0; const vals = [];
                    sample.forEach(r => { const v = r[k]; if (v === undefined || v === null || v === '') return; tot++; const n = parseFloat(String(v).replace(',', '.')); if (!isFinite(n) || Math.abs(n) > 180) return; ok++; if (Math.abs(n % 1) > 1e-6) dec++; min = Math.min(min, n); max = Math.max(max, n); vals.push(n); });
                    if (!(tot >= 3 && ok >= tot * 0.8 && dec >= ok * 0.8 && (max - min) > 1e-4)) return null;
                    vals.sort((a, b) => a - b);
                    return { med: vals[Math.floor(vals.length / 2)], absMax: Math.max(Math.abs(min), Math.abs(max)) };
                };
                const coords = keys.map(k => ({ k, s: stats(k) })).filter(x => x.s);
                // Latitude = la colonne dont la médiane tient dans [-90, 90] et, si les
                // deux le peuvent, celle dont la médiane tombe dans la plage des
                // latitudes européennes [35, 60] ; sinon la première (usage des exports).
                const ordonner = (a, b) => {
                    const latA = a.s.absMax <= 90, latB = b.s.absMax <= 90;
                    if (latA && !latB) return { lat: a.k, lon: b.k };
                    if (latB && !latA) return { lat: b.k, lon: a.k };
                    const euA = a.s.med >= 35 && a.s.med <= 60, euB = b.s.med >= 35 && b.s.med <= 60;
                    if (euB && !euA) return { lat: b.k, lon: a.k };
                    return { lat: a.k, lon: b.k };
                };
                const paires = [];
                for (let i = 0; i + 1 < coords.length; i++) if (keys.indexOf(coords[i + 1].k) - keys.indexOf(coords[i].k) === 1) paires.push(ordonner(coords[i], coords[i + 1]));
                if (!paires.length && coords.length >= 2) paires.push(ordonner(coords[0], coords[1]));
                if (!paires.length) { _qualite.avertissements.push('Aucune colonne de coordonnées GPS reconnue : la détection des renforts sera impossible.'); return null; }
                if (paires.length > 1) _qualite.avertissements.push(`Colonnes GPS ambiguës (${paires.map(p => p.lat + '/' + p.lon).join(', ')}) : la première paire adjacente a été retenue, vérifiez le fichier.`);
                _qualite.avertissements.push(`Coordonnées lues par analyse du contenu : « ${paires[0].lat} » / « ${paires[0].lon} ».`);
                return paires[0];
            })();

            // ── PASSE 1 : normaliser chaque ligne (date, livreur, statut, n° de colis) ──
            const recs = [];
            jsonData.forEach((row, idx) => {
                const rowKeysNorm = {};
                Object.keys(row).forEach(k => { rowKeysNorm[norm(k)] = row[k]; });

                let date = getField(row, ['Task Date', 'Date de la tâche', 'task date', 'date de la tache', 'originalPlanTaskDate', 'originalplantaskdate', 'Date'], rowKeysNorm);
                // v52 — deux traductions FR de l'export coexistent (« Petit nom de membre » / « Chauffeur », etc.)
                let livreurName = getField(row, ['Courier Name', 'Petit nom de membre', 'Chauffeur', 'courier name', 'petit nom de membre', 'chauffeur', 'Livreur', 'livreur', 'Driver Name', 'driver name', 'Driver', 'driver', 'Courier', 'courier'], rowKeysNorm);
                const taskStatus = getField(row, ['Task Status', 'Statut', 'task status', 'statut', 'Status', 'status'], rowKeysNorm);
                const pudoAddress = getField(row, ['PUDO address', 'pudo address'], rowKeysNorm);
                const sopRaw = getField(row, ['Type de SOP', 'type de sop', 'SOP Type', 'sop type'], rowKeysNorm);
                const routeId = getField(row, ['Plan de dispatchingcode', 'Dispatching Plancode', 'plan de dispatchingcode', 'dispatching plancode', 'Numéro de route', 'numero de route', 'Route Number'], rowKeysNorm);
                const codePostal = getField(row, ['Code postal', 'Zip Code', 'code postal', 'zip code', 'Code postal de destination', 'code postal de destination', 'Destination Zip Code', "Receiver's Zip Code"], rowKeysNorm);
                // v44 — coordonnées et heure de livraison : indispensables au détecteur
                // de tournées simultanées. NB : dans l'export FR, la colonne traduite
                // « Dimension » contient la LATITUDE (« Dimension.1 » = point réel).
                // Deux paires coexistent dans l'export : la position réelle de
                // livraison (suffixée _1 par le lecteur XLSX) et la position
                // théorique. Il faut prendre les DEUX membres d'une même paire :
                // mélanger la latitude de l'une et la longitude de l'autre
                // déplace le point de plusieurs centaines de mètres et fragmente
                // les tournées à tort.
                const _coordPaire = (sufLat, sufLon) => {
                    const la = getField(row, sufLat, rowKeysNorm);
                    const lo = getField(row, sufLon, rowKeysNorm);
                    const a = parseFloat(String(la).replace(',', '.'));
                    const b = parseFloat(String(lo).replace(',', '.'));
                    if (!isFinite(a) || !isFinite(b)) return null;
                    if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
                    if (a === 0 && b === 0) return null;
                    return { lat: a, lon: b };
                };
                const _coord = _coordPaire(['Dimension_1', 'dimension_1', 'Dimension.1', 'dimension.1', 'Actual delivery Latitude', 'Actual Delivery Latitude'],
                                           ['Longitude_1', 'longitude_1', 'Longitude.1', 'longitude.1', 'Actual delivery Longitude', 'Actual Delivery Longitude'])
                            || _coordPaire(['Dimension', 'dimension', 'Latitude', 'latitude', 'Receiver to Latitude', 'Receiver Latitude'],
                                           ['Longitude', 'longitude', 'Receiver to Longitude', 'Receiver Longitude']);
                let latRaw, lonRaw;
                const heureLivRaw = getField(row, ['Délai de livraison', 'delai de livraison', 'Sign Time', 'sign time', 'Delivery Time', 'delivery time'], rowKeysNorm);
                // Numéro de colis : indispensable pour attribuer chaque colis UNE seule fois
                const waybillRaw = getField(row, ['Numéro de la lettre', 'numero de la lettre', 'Waybill Number', 'waybill number', 'Waybill', 'waybill', 'Tracking Number', 'tracking number', 'Numéro de colis', 'N° colis'], rowKeysNorm);
                // v50 — champs exploités par le détecteur de renforts
                //  · dépôt : « Actual Site » (dépôt réel) avant « Planned Site »
                //  · ordre planifié du colis dans la tournée
                //  · heure de départ de la tournée
                //  · position théorique (géocodage) : sert à corriger les pics GPS
                //  · commune, tentatives d'upload (qualité)
                const depotRaw = getField(row, ['Actual Site', 'actual site', 'Station physique', 'station physique', 'Physical Station', 'Site réel', 'Planned Site', 'planned site', 'Station planifiée', 'station planifiee', 'Plan Station', 'Site prévu', 'Depot', 'Dépôt', 'depot', 'XPT', 'EXPT', 'Site', 'Station', 'Hub'], rowKeysNorm);
                const ordreRaw = getField(row, ['Ordre du groupe de travail', 'ordre du groupe de travail', "Numéro d'arrêt", "numero d'arret", 'Stop Number', 'Work Group Order', 'work group order', 'Sequence', 'Séquence', 'Ordre', 'Delivery Sequence'], rowKeysNorm);
                const debutRaw = getField(row, ['Délai de livraison de début', 'delai de livraison de debut', 'Delivery Start Time', 'delivery start time', 'Start Delivery Time', 'Start Time', 'Heure de début'], rowKeysNorm);
                const villeRaw = getField(row, ['La ville de destination', 'la ville de destination', 'Ville de destination', 'ville de destination', 'Destination City', 'Ville', 'City', 'Commune'], rowKeysNorm);
                const uploadRaw = getField(row, ['Upload Failure Times', 'upload failure times'], rowKeysNorm);
                // v51 — indicateurs opérationnels (jamais utilisés par la paie)
                const motifEchecRaw = getField(row, ["Type d'anormalie", "type d'anormalie", 'Type d anormalie', "Raison d'échec de la tâche", "raison d'echec de la tache", 'Task Fail Reason', 'Task Failure Reason', 'Abnormal Type', 'Failure Type', 'Exception Type', "Motif d'échec"], rowKeysNorm);
                const signTypeRaw = getField(row, ['Sign Type', 'sign type', 'Type de signature', 'type de signature'], rowKeysNorm);
                const podResultRaw = getField(row, ['Pod Result', 'pod result', 'Résultat POD'], rowKeysNorm);
                const podReasonRaw = getField(row, ['Pod Reason', 'pod reason', 'Raison de POD invalide', 'raison de pod invalide', 'POD invalid reason', 'Motif POD'], rowKeysNorm);
                const poidsRaw = getField(row, ['Poids', 'poids', 'Weight', 'weight', 'Weight (g)', 'Poids (g)'], rowKeysNorm);
                const _theo = _coordPaire(['Dimension', 'dimension', 'Latitude', 'latitude', 'Planned Latitude', 'Receiver to Latitude', 'Receiver Latitude'], ['Longitude', 'longitude', 'Planned Longitude', 'Receiver to Longitude', 'Receiver Longitude']);
                // Repli par contenu : aucune coordonnée reconnue par son nom
                let _coordFinal = _coord;
                if (!_coordFinal && _gpsFallback) {
                    const a = parseFloat(String(row[_gpsFallback.lat]).replace(',', '.')), b = parseFloat(String(row[_gpsFallback.lon]).replace(',', '.'));
                    if (isFinite(a) && isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0)) _coordFinal = { lat: a, lon: b };
                }

                if (!date || !livreurName) return;

                // Statuts (EN et FR) :
                //   Sign Success / Livraison client réussie  → livré normalement
                //   Drop Off Success / Dépose réussie        → livré en PUDO (point relais)
                //   Livraison client échouée / Sign Failed   → échec (stats, pas payé)
                const taskStatusStr = String(taskStatus || '').trim();
                const _ts = taskStatusStr.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const isLivreSuccess = _ts.includes('sign success') || (_ts.includes('livraison') && _ts.includes('reussi'))
                                    || _ts === 'delivered' || _ts.includes('delivery success') || _ts.includes('delivered successfully');
                const isEchec = _ts.includes('echec') || _ts.includes('failed') || _ts.includes('sign fail')
                             || (_ts.includes('livraison') && _ts.includes('echou'));
                const isLivrePudo = !isEchec && (
                                    _ts.includes('drop off success')
                                 || _ts.includes('depose reussie')
                                 || (pudoAddress && String(pudoAddress).trim() !== '')
                                 || (isLivreSuccess && String(sopRaw || '').trim().toUpperCase() === 'PUDO'));
                // Annulée, Expédié, Créé, En livraison, Pickup… → ni livré ni échec (exclu)
                if (!isLivreSuccess && !isLivrePudo && !isEchec) return;
                latRaw = _coordFinal ? _coordFinal.lat : undefined;
                lonRaw = _coordFinal ? _coordFinal.lon : undefined;

                // Date + horodatage complet (l'heure départage les doublons d'un même colis)
                let ts = idx;
                if (typeof date === 'number') {
                    const ms = new Date(1899, 11, 30).getTime() + date * 86400000;
                    ts = ms;
                    date = new Date(ms).toISOString().split('T')[0];
                } else if (date instanceof Date) {
                    ts = date.getTime();
                    date = date.toISOString().split('T')[0];
                } else {
                    const dateStr = String(date).trim();
                    let m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
                    if (m) {
                        date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
                        ts = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
                    } else {
                        m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
                        if (m) {
                            date = `${m[1]}-${m[2]}-${m[3]}`;
                            ts = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
                        } else {
                            date = dateStr.split('T')[0].split(' ')[0];
                        }
                    }
                }

                livreurName = normalizeNomLivreur(livreurName);
                if (!livreurName) return;

                // Horodatage de la livraison effective (≠ date de la tâche)
                const tsLivraison = parseHorodatageEPOD(heureLivRaw, date);
                if ((heureLivRaw !== undefined && heureLivRaw !== null && heureLivRaw !== '') && tsLivraison === null) _qualite.heuresNonParsees++;
                const tsDebut = parseHorodatageEPOD(debutRaw, date);
                const _num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : NaN; };
                const ordre = (ordreRaw !== undefined && ordreRaw !== null && ordreRaw !== '') ? parseInt(ordreRaw, 10) : NaN;

                recs.push({
                    idx, ts, tsLivraison,
                    lat: _num(latRaw), lon: _num(lonRaw),
                    waybill: String(waybillRaw ?? '').trim(),
                    date, courier: livreurName,
                    routeId: (routeId && String(routeId).trim() !== '') ? String(routeId).trim() : '',
                    cp: (codePostal !== undefined && codePostal !== null && String(codePostal).trim() !== '') ? String(codePostal).trim() : '',
                    echec: isEchec,
                    pudo: !isEchec && isLivrePudo,
                    depot: (depotRaw !== undefined && depotRaw !== null && String(depotRaw).trim() !== '') ? String(depotRaw).trim() : '',
                    ordre: isFinite(ordre) ? ordre : NaN,
                    tsDebut,
                    latTheo: _theo ? _theo.lat : NaN, lonTheo: _theo ? _theo.lon : NaN,
                    ville: (villeRaw !== undefined && villeRaw !== null) ? String(villeRaw).trim().toUpperCase() : '',
                    upload: parseInt(uploadRaw, 10) || 0,
                    motifEchec: isEchec ? String(motifEchecRaw || 'NON_RENSEIGNE').trim().toUpperCase() : '',
                    signType: (() => { const t = String(signTypeRaw || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); return !t || t === '.' ? '' : (t.includes('boite') || t.includes('mailbox') ? 'bal' : (t.includes('main propre') || t.includes('hand') || t.includes('pin') || t.includes('firma') ? 'main' : 'autre')); })(),
                    podResult: (podResultRaw === undefined || podResultRaw === null || podResultRaw === '') ? null : String(podResultRaw).trim(),
                    podReason: String(podReasonRaw || '').trim().toUpperCase(),
                    poidsG: (() => { const n = parseFloat(String(poidsRaw ?? '').replace(',', '.')); return isFinite(n) && n > 0 ? n : 0; })(),
                    statutBrut: taskStatusStr
                });
            });

            // ── PASSE 2 : DÉDUPLICATION PAR (NUMÉRO DE COLIS, DATE) ──
            // Règle métier : un colis livré n'est payé qu'UNE seule fois, au livreur qui
            // l'a réellement livré. Quand un colis est transféré à un renfort, l'export
            // peut le lister sous les DEUX comptes → on ne garde que le DERNIER scan
            // livré (le compte du livreur final), et on trace le transfert détecté.
            //
            // v43 — La clé inclut la DATE. Un colis en échec puis relivré un autre jour
            // est une seconde journée de travail réellement effectuée : la dédupliquer
            // sur le seul numéro de colis ferait disparaître une journée payable.
            const bestByWaybill = new Map();
            let doublonsIgnores = 0;
            const transfertsMap = new Map(); // date|de|vers -> {date, de, vers, nb, routes:Set}
            const cleColisJour = (r) => r.waybill + '|' + r.date;

            recs.filter(r => !r.echec).forEach(r => {
                if (!r.waybill) return; // pas de n° : traité tel quel plus bas
                const cle = cleColisJour(r);
                const prev = bestByWaybill.get(cle);
                if (!prev) { bestByWaybill.set(cle, r); return; }
                const rWins = (r.ts > prev.ts) || (r.ts === prev.ts && r.idx > prev.idx);
                const keep = rWins ? r : prev;
                const drop = rWins ? prev : r;
                bestByWaybill.set(cle, keep);
                doublonsIgnores++;
                if (drop.courier !== keep.courier) {
                    const k = keep.date + '|' + drop.courier + '|' + keep.courier;
                    if (!transfertsMap.has(k)) transfertsMap.set(k, { date: keep.date, de: drop.courier, vers: keep.courier, nb: 0, routes: new Set() });
                    const t = transfertsMap.get(k);
                    t.nb++;
                    if (drop.routeId) t.routes.add(drop.routeId);
                    if (keep.routeId) t.routes.add(keep.routeId);
                }
            });

            const finalRecs = [];
            recs.filter(r => !r.echec && !r.waybill).forEach(r => finalRecs.push(r));
            bestByWaybill.forEach(r => finalRecs.push(r));
            // v51 — un même colis livré avec succès à DEUX dates différentes est
            // payé deux fois (règle v43 : la date fait partie de la clé). Ce n'est
            // pas forcément une erreur (nouvelle livraison après retour), mais
            // l'utilisateur doit le voir.
            const parWaybill = new Map();
            finalRecs.forEach(r => { if (r.waybill) (parWaybill.get(r.waybill) || parWaybill.set(r.waybill, []).get(r.waybill)).push(r); });
            _qualite.doublesLivraisons = [];
            parWaybill.forEach((list, w) => {
                if (list.length > 1) _qualite.doublesLivraisons.push({ waybill: w, dates: list.map(r => r.date).sort(), livreurs: [...new Set(list.map(r => r.courier))] });
            });
            if (_qualite.doublesLivraisons.length) _qualite.avertissements.push(`${_qualite.doublesLivraisons.length} colis livrés avec succès à deux dates différentes : chaque livraison est payée (voir le diagnostic).`);

            // Échecs : conservés pour les statistiques, mais un échec strictement
            // identique en double (même colis, même livreur, même jour) ne compte qu'une fois.
            const echecSeen = new Set();
            recs.filter(r => r.echec).forEach(r => {
                if (r.waybill) {
                    const k = r.waybill + '|' + r.courier + '|' + r.date;
                    if (echecSeen.has(k)) { doublonsIgnores++; return; }
                    echecSeen.add(k);
                }
                finalRecs.push(r);
            });

            // ── PASSE 3 : agrégation par livreur / jour ──
            const parsed = {};
            let count = 0, totalLivres = 0, totalPrevus = 0, totalPudo = 0;
            const dateSet = new Set(), livreurSet = new Set();

            let colisComptesTechniques = 0;
            finalRecs.forEach(r => {
                // v43 — Comptes techniques (ex. « Renfort-Colmar ») : colis conservés
                // dans le fichier source et traçables, mais exclus de toute rémunération.
                if (estCompteTechnique(r.courier)) { colisComptesTechniques++; return; }
                const monthKey = r.date.slice(0, 7);
                if (!parsed[monthKey]) parsed[monthKey] = {};
                if (!parsed[monthKey][r.courier]) parsed[monthKey][r.courier] = { jours: {}, totalLivres: 0, totalPrevus: 0, totalPudo: 0, totalEchecs: 0 };
                const livObj = parsed[monthKey][r.courier];
                if (!livObj.jours[r.date]) livObj.jours[r.date] = { livres: 0, prevus: 0, pudo: 0, echecs: 0, routes: [], codesPostaux: [], routeColis: {} };
                const jourRef = livObj.jours[r.date];
                if (r.routeId && !jourRef.routes.includes(r.routeId)) jourRef.routes.push(r.routeId);
                if (r.cp && !jourRef.codesPostaux.includes(r.cp)) jourRef.codesPostaux.push(r.cp);
                // v51 — indicateurs (n'entrent dans aucun calcul de salaire)
                const ind = (livObj.indicateurs = livObj.indicateurs || { echecsMotifs: {}, signBal: 0, signMain: 0, signAutre: 0, podControles: 0, podRejets: {}, poidsG: 0, colisPeses: 0, kmReel: 0, joursKm: 0, ordreOk: 0, ordrePaires: 0 });
                if (r.echec) { ind.echecsMotifs[r.motifEchec || 'NON_RENSEIGNE'] = (ind.echecsMotifs[r.motifEchec || 'NON_RENSEIGNE'] || 0) + 1; }
                else {
                    if (r.signType === 'bal') ind.signBal++; else if (r.signType === 'main') ind.signMain++; else if (r.signType) ind.signAutre++;
                    if (r.podResult !== null) { ind.podControles++; if (r.podResult === '0') ind.podRejets[r.podReason || 'NON_PRECISE'] = (ind.podRejets[r.podReason || 'NON_PRECISE'] || 0) + 1; }
                    if (r.poidsG > 0) { ind.poidsG += r.poidsG; ind.colisPeses++; jourRef.poidsG = (jourRef.poidsG || 0) + r.poidsG; }
                }

                if (r.echec) {
                    jourRef.echecs += 1;
                    livObj.totalEchecs = (livObj.totalEchecs || 0) + 1;
                } else {
                    jourRef.livres += 1;
                    if (r.routeId) jourRef.routeColis[r.routeId] = (jourRef.routeColis[r.routeId] || 0) + 1;
                    if (r.pudo) { jourRef.pudo += 1; livObj.totalPudo += 1; totalPudo += 1; }
                    livObj.totalLivres += 1;
                    totalLivres++;
                }
                jourRef.prevus = jourRef.livres + jourRef.echecs;
                livObj.totalPrevus = (livObj.totalPrevus || 0) + 1;
                count++;
                totalPrevus++;
                dateSet.add(r.date);
                livreurSet.add(r.courier);
            });

            // ── PASSE 3b : kilométrage réel et respect de l'ordre planifié ──
            // Distance = somme des déplacements entre arrêts successifs sur la
            // séquence nettoyée (pics GPS écartés). Respect de l'ordre = part des
            // livraisons consécutives qui suivent l'ordre planifié croissant.
            try {
                const parLivJour = {};
                finalRecs.forEach(r => { if (!r.echec && r.tsLivraison && !estCompteTechnique(r.courier)) (parLivJour[r.courier + '|' + r.date] = parLivJour[r.courier + '|' + r.date] || []).push(r); });
                Object.entries(parLivJour).forEach(([k, list]) => {
                    const [courier, date] = k.split('|');
                    const m = date.slice(0, 7);
                    const livObj = parsed[m] && parsed[m][courier]; if (!livObj || !livObj.jours[date]) return;
                    const jourRef = livObj.jours[date]; const ind = livObj.indicateurs;
                    const { pts } = nettoyerSequence(list);
                    const segs = analyserDeplacements(pts, 999);
                    // Une journée à deux séquences entrelacées (renfort sous le compte)
                    // fait « rebondir » le compte entre deux zones : le kilométrage du
                    // compte n'est plus celui d'une personne. On l'estime alors sans
                    // les grands sauts et on le marque approximatif.
                    const grandsSauts = segs.filter(sgm => sgm.km > RENFORT_PARAMS.sautKm).length;
                    const douteux = grandsSauts >= RENFORT_PARAMS.sautsMin;
                    const km = segs.reduce((a, sgm) => a + ((sgm.km < 60 && !(douteux && sgm.km > RENFORT_PARAMS.sautKm)) ? sgm.km : 0), 0);
                    if (pts.filter(p => p.geo).length >= 2) { jourRef.km = Math.round(km * 10) / 10; if (douteux) jourRef.kmApprox = true; ind.kmReel += km; ind.joursKm++; }
                    const ordres = list.slice().sort((a, b) => a.tsLivraison - b.tsLivraison).map(r => r.ordre).filter(o => isFinite(o) && o >= 0);
                    if (ordres.length >= 5) {
                        let ok = 0; for (let i = 1; i < ordres.length; i++) if (ordres[i] > ordres[i - 1]) ok++;
                        jourRef.respectOrdre = Math.round(ok / (ordres.length - 1) * 100);
                        ind.ordreOk += ok; ind.ordrePaires += ordres.length - 1;
                    }
                });
            } catch (e) { console.warn('[indicateurs] km / ordre', e); }

            // ── PASSE 3c : export tronqué / journée partielle ──
            // Une date avec des tâches mais aucune livraison ni échec = export
            // tiré avant la fin de journée. On avertit plutôt que de payer 0.
            try {
                const parDate = {};
                jsonData.forEach(row => {
                    const rk = {}; Object.keys(row).forEach(k => { rk[norm(k)] = row[k]; });
                    let d = getField(row, ['Task Date', 'Date de la tâche', 'Date'], rk); if (!d) return;
                    d = String(d).slice(0, 10);
                    const st = String(getField(row, ['Task Status', 'Statut', 'Status'], rk) || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                    const p = (parDate[d] = parDate[d] || { total: 0, termines: 0, enCours: 0 });
                    p.total++;
                    if (st.includes('reussi') || st.includes('success') || st.includes('echou') || st.includes('echec') || st.includes('fail')) p.termines++;
                    else if (st.includes('cree') || st.includes('created') || st.includes('en livraison') || st.includes('delivering') || st.includes('expedi') || st.includes('shipped')) p.enCours++;
                });
                const dates = Object.keys(parDate).sort();
                const volumes = dates.map(d => parDate[d].termines).filter(v => v > 0).sort((a, b) => a - b);
                const mediane = volumes.length ? volumes[Math.floor(volumes.length / 2)] : 0;
                dates.forEach(d => {
                    const p = parDate[d];
                    if (p.total >= 20 && p.termines === 0) _qualite.avertissements.push(`${d} : ${p.total} tâches, aucune livraison ni échec enregistré — export tiré trop tôt ? Ne payez pas cette journée sur ce fichier.`);
                    else if (mediane && p.enCours > p.termines && p.termines < mediane * 0.5) _qualite.avertissements.push(`${d} : ${p.enCours} colis encore « en cours » pour ${p.termines} terminés — journée partielle probable.`);
                });
                _qualite.journees = parDate;
            } catch (e) { console.warn('[qualité] export tronqué', e); }

            // ── PASSE 4 : DÉTECTION DES TOURNÉES SIMULTANÉES ──
            // Repère les journées où plusieurs personnes ont livré sous un même
            // compte (transfert non enregistré dans l'outil de dispatch).
            let anomaliesTournees = [];
            try {
                anomaliesTournees = detecterTourneesSimultanees(finalRecs);
            } catch (errDetect) {
                console.warn('[détecteur] analyse impossible', errDetect);
            }

            const transferts = [...transfertsMap.values()]
                .map(t => ({ date: t.date, de: t.de, vers: t.vers, nb: t.nb, routes: [...t.routes], mode: 'import' }))
                .sort((a, b) => b.date.localeCompare(a.date) || b.nb - a.nb);

            // Points nécessaires au détecteur, conservés pour pouvoir relancer
            // l'analyse plus tard sans redemander le fichier.
            // v50 — on conserve aussi les colis sans GPS (ils comptent dans la
            // qualité et dans l'activité horaire), le waybill, la route, l'ordre
            // planifié, le dépôt, la commune et la position théorique.
            // Compacité : la position théorique n'est conservée que si elle
            // s'écarte de plus de 100 m de la position réelle (sinon inutile).
            const _r5 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1e5) / 1e5 : undefined;
            const _points = finalRecs
                .filter(r => !r.echec && r.tsLivraison)
                .map(r => {
                    const p = { d: r.date, c: r.courier, t: r.tsLivraison, y: _r5(r.lat), x: _r5(r.lon), p: r.cp || '',
                                w: r.waybill || '', r: r.routeId || '', o: isFinite(r.ordre) ? r.ordre : undefined,
                                s: r.depot || '', v: r.ville || '' };
                    if (_fin(r.latTheo) && (!_fin(r.lat) || _distanceKm(r.lat, r.lon, r.latTheo, r.lonTheo) > 0.1)) { p.ty = _r5(r.latTheo); p.tx = _r5(r.lonTheo); }
                    if (r.tsDebut) p.b = r.tsDebut;
                    if (r.upload) p.u = r.upload;
                    return p;
                });
            _qualite.detection = anomaliesTournees._qualite || null;
            _qualite.depots = [...new Set(finalRecs.map(r => r.depot).filter(Boolean))];
            if (!_qualite.depots.length) _qualite.avertissements.push('Aucune colonne dépôt reconnue (Actual Site / Planned Site / Dépôt) : tous les livreurs sont considérés comme appartenant au même dépôt.');

            return { data: parsed, count, totalLivres, totalPrevus, totalPudo, joursCount: dateSet.size, livreursCount: livreurSet.size, format: 'line-by-line', doublonsIgnores, transferts, colisComptesTechniques, anomaliesTournees, _points, _qualite,
                     _sousSeuil: anomaliesTournees._sousSeuil || [] };
        }

        // ========== FORMAT AGRÉGÉ (ancien EPOD_ROUTE_LIST) ==========
        function parseEPODAggregate(jsonData, getField, norm) {
            const parsed = {};
            let count = 0, totalLivres = 0, totalPrevus = 0;
            const dateSet = new Set(), livreurSet = new Set();

            jsonData.forEach(row => {
                const rowKeysNorm = {};
                Object.keys(row).forEach(k => { rowKeysNorm[norm(k)] = row[k]; });

                let date = getField(row, [
                    'planDate', 'route plan date', 'date', 'Date',
                    "Date du plan d'itinéraire", "Date du plan d itineraire", "Date du plan ditineraire"
                ], rowKeysNorm);
                let livreurName = getField(row, [
                    'driver name', 'name', 'Name', 'livreur',
                    'Nom du conducteur', 'Conducteur'
                ], rowKeysNorm);
                let colisLivres = getField(row, [
                    'delivery complete qty', 'Delivery Complete Qty', 'colis_livres',
                    'Livraison complète qté', 'Livraison complete qte', 'Livraison complète qte'
                ], rowKeysNorm) || 0;
                let colisPrevus = getField(row, [
                    'delivery planning qty', 'Delivery Planning Qty', 'colis_prevus',
                    'Qté planification de la livraison', 'Qte planification de la livraison'
                ], rowKeysNorm) || 0;

                if (!date || !livreurName) return;

                if (typeof date === 'number') {
                    const excelEpoch = new Date(1899, 11, 30);
                    date = new Date(excelEpoch.getTime() + date * 86400000).toISOString().split('T')[0];
                } else if (date instanceof Date) {
                    date = date.toISOString().split('T')[0];
                } else {
                    date = String(date).split('T')[0];
                }

                livreurName = normalizeNomLivreur(livreurName);
                if (!livreurName) return;

                colisLivres = parseInt(colisLivres) || 0;
                colisPrevus = parseInt(colisPrevus) || 0;

                if (colisLivres > 0) {
                    const monthKey = date.slice(0, 7);
                    if (!parsed[monthKey]) parsed[monthKey] = {};
                    if (!parsed[monthKey][livreurName]) parsed[monthKey][livreurName] = { jours: {}, totalLivres: 0, totalPrevus: 0, totalPudo: 0 };
                    if (!parsed[monthKey][livreurName].jours[date]) parsed[monthKey][livreurName].jours[date] = { livres: 0, prevus: 0, pudo: 0 };

                    parsed[monthKey][livreurName].jours[date].livres += colisLivres;
                    parsed[monthKey][livreurName].jours[date].prevus += colisPrevus;
                    parsed[monthKey][livreurName].totalLivres += colisLivres;
                    parsed[monthKey][livreurName].totalPrevus += colisPrevus;

                    count++;
                    totalLivres += colisLivres;
                    totalPrevus += colisPrevus;
                    dateSet.add(date);
                    livreurSet.add(livreurName);
                }
            });

            return { data: parsed, count, totalLivres, totalPrevus, totalPudo: 0, joursCount: dateSet.size, livreursCount: livreurSet.size, format: 'aggregate' };
        }

        function normalizeNomLivreur(name) {
            if (!name) return null;
            name = String(name).trim();
            if (name.startsWith('[') && name.includes(',')) {
                const parts = name.replace(/[\[\]]/g, '').split(',');
                if (parts.length >= 2) name = parts[1].trim() + ' ' + parts[0].trim();
            }
            return name.toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
        }

        function mergeEPODData(newData) {
            if (!data.historiqueEPOD) data.historiqueEPOD = {};
            Object.keys(newData).forEach(monthKey => {
                if (!data.historiqueEPOD[monthKey]) data.historiqueEPOD[monthKey] = {};
                Object.keys(newData[monthKey]).forEach(livreurName => {
                    if (!data.historiqueEPOD[monthKey][livreurName]) {
                        data.historiqueEPOD[monthKey][livreurName] = { jours: {}, totalLivres: 0, totalPrevus: 0, totalPudo: 0 };
                    }
                    const existant = data.historiqueEPOD[monthKey][livreurName];
                    const nouveau = newData[monthKey][livreurName];

                    Object.keys(nouveau.jours).forEach(date => {
                        if (!existant.jours[date]) existant.jours[date] = { livres: 0, prevus: 0, pudo: 0, echecs: 0, routes: [], codesPostaux: [], routeColis: {} };
                        existant.jours[date].livres = nouveau.jours[date].livres;
                        existant.jours[date].prevus = nouveau.jours[date].prevus;
                        existant.jours[date].pudo = nouveau.jours[date].pudo || 0;
                        existant.jours[date].echecs = nouveau.jours[date].echecs || 0;
                        // Routes et CP : on prend le set du nouveau (qui contient la liste complète après parser)
                        existant.jours[date].routes = nouveau.jours[date].routes || [];
                        existant.jours[date].codesPostaux = nouveau.jours[date].codesPostaux || [];
                        existant.jours[date].routeColis = nouveau.jours[date].routeColis || {};
                        // v51 — indicateurs journée (km réel, poids, respect de l'ordre)
                        ['km', 'kmApprox', 'poidsG', 'respectOrdre'].forEach(f => { if (nouveau.jours[date][f] !== undefined) existant.jours[date][f] = nouveau.jours[date][f]; else delete existant.jours[date][f]; });
                    });
                    if (nouveau.indicateurs) existant.indicateurs = nouveau.indicateurs;

                    existant.totalLivres = Object.values(existant.jours).reduce((sum, j) => sum + (j.livres || 0), 0);
                    existant.totalPrevus = Object.values(existant.jours).reduce((sum, j) => sum + (j.prevus || 0), 0);
                    existant.totalPudo = Object.values(existant.jours).reduce((sum, j) => sum + (j.pudo || 0), 0);
                    existant.totalEchecs = Object.values(existant.jours).reduce((sum, j) => sum + (j.echecs || 0), 0);
                });
            });
            markUnsaved();
        }

        function showEPODImportResults(result) {
            document.getElementById('epodImportResults').style.display = 'block';
            document.getElementById('epodImportSummary').innerHTML = `
                <div class="import-stat"><div class="value">${result.count}</div><div class="label">Enregistrements</div></div>
                <div class="import-stat"><div class="value">${result.totalLivres}</div><div class="label">Colis livrés</div></div>
                <div class="import-stat"><div class="value">${result.livreursCount}</div><div class="label">Livreurs</div></div>
                <div class="import-stat"><div class="value">${result.joursCount}</div><div class="label">Jours</div></div>
                ${result.doublonsIgnores ? `<div class="import-stat"><div class="value">${result.doublonsIgnores}</div><div class="label">Doublons ignorés</div></div>` : ''}
                ${(result.transferts && result.transferts.length) ? `<div class="import-stat"><div class="value">${result.transferts.reduce((s, t) => s + t.nb, 0)}</div><div class="label">Colis transférés détectés</div></div>` : ''}
                ${(result.anomaliesTournees && result.anomaliesTournees.length) ? `<div class="import-stat"><div class="value">${result.anomaliesTournees.filter(a => a.statut !== 'info').length}</div><div class="label">Renforts probables</div></div>` : ''}
                ${(result._sousSeuil && result._sousSeuil.length) ? `<div class="import-stat"><div class="value">${result._sousSeuil.length}</div><div class="label">Cas &lt; 5 colis</div></div>` : ''}
            ` + ((result._qualite && result._qualite.avertissements && result._qualite.avertissements.length)
                ? `<div style="margin-top:0.6rem;font-size:0.82rem;color:var(--warning);">${result._qualite.avertissements.map(w => `<div><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(w)}</div>`).join('')}</div>` : '');
        }

        function clearHistoriqueEPOD() {
            if (confirm('Êtes-vous sûr de vouloir effacer tout l\'historique EPOD ?')) {
                try { snapshotCreer('avant effacement historique'); } catch (e) {}
                data.historiqueEPOD = {};
                saveLocal();
                document.getElementById('epodImportResults').style.display = 'none';
                refreshHistorique();
                showToast('Historique EPOD effacé', 'success');
            }
        }

        function changeHistoriqueMois(delta) {
            const [year, month] = selectedHistoriqueMonth.split('-').map(Number);
            const newDate = new Date(year, month - 1 + delta, 1);
            selectedHistoriqueMonth = newDate.toISOString().slice(0, 7);
            data.dernierMoisHistorique = selectedHistoriqueMonth;
            markUnsaved();
            refreshHistorique();
        }

        function selectHistoriqueMois() {
            const select = document.getElementById('historiqueMonthSelect');
            if (select.value) {
                selectedHistoriqueMonth = select.value;
                data.dernierMoisHistorique = selectedHistoriqueMonth;
                markUnsaved();
                refreshHistorique();
            }
        }

        function formatMonthName(monthKey) {
            const [year, month] = monthKey.split('-');
            const monthNames = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
            return `${monthNames[parseInt(month) - 1]} ${year}`;
        }

        function refreshHistorique() {
            document.getElementById('historiqueMonth').textContent = formatMonthName(selectedHistoriqueMonth);
            
            // Update month select
            const select = document.getElementById('historiqueMonthSelect');
            const months = Object.keys(data.historiqueEPOD || {}).sort().reverse();
            select.innerHTML = '<option value="">-- Sélectionner --</option>';
            months.forEach(m => {
                const option = document.createElement('option');
                option.value = m;
                option.textContent = formatMonthName(m);
                if (m === selectedHistoriqueMonth) option.selected = true;
                select.appendChild(option);
            });

            // Update stats
            // v44 — les transferts sont appliqués ici : les données brutes de
            // data.historiqueEPOD ne sont jamais modifiées, seul l'affichage et
            // le calcul du salaire tiennent compte des colis cédés/reçus.
            const monthDataBrut = data.historiqueEPOD?.[selectedHistoriqueMonth] || {};
            const monthData = appliquerTransfertsMois(monthDataBrut, selectedHistoriqueMonth);
            let totalLivres = 0, totalPrevus = 0, livreursActifs = 0;
            const joursSet = new Set();

            Object.values(monthData).forEach(liv => {
                // v46 — on compte les colis PAYÉS : la somme reste égale au total
                // livré du mois, mais elle est ventilée sur le bon livreur.
                const rem = (liv.totalRemunerables !== undefined) ? liv.totalRemunerables : (liv.totalLivres || 0);
                totalLivres += rem;
                totalPrevus += liv.totalPrevus || 0;
                Object.keys(liv.jours || {}).forEach(d => joursSet.add(d));
                if (rem > 0) livreursActifs++;
            });

            const tauxReussite = totalPrevus > 0 ? Math.round((totalLivres / totalPrevus) * 100) : 0;
            const moyenne = livreursActifs > 0 ? Math.round(totalLivres / livreursActifs) : 0;

            document.getElementById('histStatTotalColis').textContent = totalLivres;
            document.getElementById('histStatLivreurs').textContent = livreursActifs;
            document.getElementById('histStatMoyenne').textContent = moyenne;
            document.getElementById('histStatJours').textContent = joursSet.size;
            document.getElementById('histStatTauxReussite').textContent = tauxReussite + '%';

            // Anomalies détectées + transferts enregistrés
            renderAnomaliesTournees();
            renderTransfertsMois();

            // Render livreurs list
            renderHistoriqueLivreurs(monthData);

            // Détection des routes partagées entre livreurs
            detectAndRenderRoutesPartagees(monthData);
        }

