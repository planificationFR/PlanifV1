        // ============== CALCUL SALAIRE SALARIÉ (GRILLE OBLIGATOIRE) ==============
        function calculerSalaireJournalierSalarié(colis) {
            // Délègue entièrement au moteur de grille (voir GRILLE_REMUNERATION_DEFAUT).
            // Aucun seuil n'est codé en dur ici : tout vient de data.grilleRemuneration.
            return appliquerGrille(colis);
        }

        // Pour la catégorie "Auto-entrepreneur avec véhicule d'entreprise" :
        // même grille que salarié + 10 € à tous les paliers (et au prorata)
        function getBonusAeVehicule() {
            return (data && typeof data.bonusAeVehicule === 'number') ? data.bonusAeVehicule : 10;
        }

        // ÉTAGE 4 — ajustement lié au contrat, appliqué APRÈS la grille.
        // Le moteur de grille reste totalement ignorant de cette règle.
        function calculerSalaireJournalierAEvehicule(colis) {
            if (!colis || colis <= 0) return 0;
            return arrondiEuro(calculerSalaireJournalierSalarié(colis) + getBonusAeVehicule());
        }

        // ═══════════════════════════════════════════════════════════════
        // MODULE ANALYSE EPOD MENSUEL COMPLET
        // Importe un export mensuel (Courier Name, Dispatching Plancode,
        // Task Date, Task Status) → calcule les salaires par livreur selon
        // leur catégorie, détecte les routes partagées, génère un rapport.
        // ═══════════════════════════════════════════════════════════════
        let _recapAnalyse = null;       // résultat de la dernière analyse (pour export)
        let _xlsxLibPromise = null;

        /** SheetJS à la demande : copie locale (vendor/) puis CDN de secours. Résout true/false. */
        function loadXLSXLib() {
            if (typeof XLSX !== 'undefined') return Promise.resolve(true);
            if (_xlsxLibPromise) return _xlsxLibPromise;
            _xlsxLibPromise = loadScriptOnce(CONFIG.libs.xlsx, () => typeof XLSX !== 'undefined')
                .then(() => true)
                .catch(e => { _xlsxLibPromise = null; reportError(ErrorType.LIBRARY, e, 'La bibliothèque Excel n\'a pas pu être chargée. Vérifiez votre connexion puis réessayez.'); return false; });
            return _xlsxLibPromise;
        }

        // Chargeur à la demande pour jsPDF + autoTable (≈350 Ko, seulement pour les PDF)
        let _jspdfLibPromise = null;
        function ensureJsPDF() {
            if (typeof window.jspdf !== 'undefined' || typeof window.jsPDF !== 'undefined') {
                if (typeof (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable) === 'function') return Promise.resolve(true);
            }
            if (_jspdfLibPromise) return _jspdfLibPromise;
            _jspdfLibPromise = (async () => {
                await loadScriptOnce(CONFIG.libs.jspdf, () => typeof window.jspdf !== 'undefined' || typeof window.jsPDF !== 'undefined');
                await loadScriptOnce(CONFIG.libs.jspdfAutotable);
                return (typeof window.jspdf !== 'undefined' || typeof window.jsPDF !== 'undefined');
            })().catch(e => { _jspdfLibPromise = null; reportError(ErrorType.PDF, e, 'La bibliothèque PDF n\'a pas pu être chargée. Vérifiez votre connexion puis réessayez.', { silent: true }); throw e; });
            return _jspdfLibPromise;
        }

        // Normalise un nom pour le matching (retire suffixe -Colmar, accents, casse)
        function normalizeName(name) {
            if (!name) return '';
            return String(name)
                .replace(/[-\s]*colmar\s*$/i, '')   // retire "-Colmar", "-colmar", " Colmar"
                .replace(/[-\s]*comlar\s*$/i, '')    // faute de frappe courante
                .trim()
                .toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '');  // retire accents
        }

        // Trouve le livreur configuré correspondant à un nom du fichier
        function matchLivreur(courierName) {
            const norm = normalizeName(courierName);
            if (!norm) return null;
            // Recherche exacte d'abord
            for (const liv of data.livreurs) {
                const ln = normalizeName(liv.nom);
                const lp = normalizeName(liv.prenom);
                const full1 = normalizeName(`${liv.prenom} ${liv.nom}`);
                const full2 = normalizeName(`${liv.nom} ${liv.prenom}`);
                if (norm === ln || norm === lp || norm === full1 || norm === full2) return liv;
            }
            // Recherche partielle (le nom du fichier contient le prénom du livreur ou vice-versa)
            for (const liv of data.livreurs) {
                const lp = normalizeName(liv.prenom);
                const ln = normalizeName(liv.nom);
                if (lp && lp.length >= 3 && (norm.includes(lp) || lp.includes(norm))) return liv;
                if (ln && ln.length >= 3 && (norm.includes(ln) || ln.includes(norm))) return liv;
            }
            return null;
        }

        async function handleRecapMensuelUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            event.target.value = '';

            showToast('Chargement de la librairie d\'analyse...', 'info');
            const libOk = await loadXLSXLib();
            if (!libOk) {
                showToast('Impossible de charger la librairie d\'analyse (connexion ?)', 'error');
                return;
            }

            showToast('Lecture du fichier...', 'info');
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
                    const sheet = wb.Sheets[wb.SheetNames[0]];
                    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
                    if (!(await verifierClasseFichier(rows, 'recap', ['realise'], ['partiel']))) return;
                    // v46 — ce bouton fait désormais EXACTEMENT le même travail que
                    // la zone d'import : historique alimenté, tournées simultanées
                    // détectées, colis réaffectés au livreur réel. Le rapport de
                    // synthèse s'affiche par-dessus.
                    const res = ingererEPOD(rows);
                    if (res) {
                        const a = res._autoAffect || { n: 0, colis: 0 };
                        if (a.n) showToast(`${a.colis} colis réaffectés au livreur qui les a livrés`, 'success');
                    }
                    analyseRecapMensuel(rows);
                } catch (err) {
                    console.error(err);
                    showToast('Erreur de lecture : ' + err.message, 'error');
                }
            };
            reader.readAsArrayBuffer(file);
        }

        // Détecte les colonnes pertinentes (tolérant aux variantes de noms)
        function detectColumns(sample) {
            const keys = Object.keys(sample);
            const find = (patterns) => keys.find(k => patterns.some(p => k.toLowerCase().includes(p)));
            return {
                // Bilingue : ancien format (Courier Name) ET nouveau V2 (Petit nom de membre)
                courier: find(['courier name', 'petit nom de membre', 'driver name', 'livreur', 'chauffeur', 'courier']),
                plancode: find(['dispatching plancode', 'dispatchingcode', 'plancode', 'route', 'tournee', 'tournée']),
                date: find(['task date', 'date de la tache', 'date de la tâche', 'date']),
                status: find(['task status', 'statut', 'status']),
                waybill: find(['waybill', 'numero de la lettre', 'numéro de la lettre', 'tracking', 'suivi', 'colis'])
            };
        }

        function analyseRecapMensuel(rows) {
            if (!rows || rows.length === 0) {
                showToast('Fichier vide', 'error');
                return;
            }
            const cols = detectColumns(rows[0]);
            if (!cols.courier) {
                showToast('Colonne "Courier Name" introuvable dans le fichier', 'error');
                return;
            }

            // Normalisation accents/casse pour reconnaître FR et EN
            const normSt = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
            // LIVRÉ : "Livraison client réussie", "Sign Success", "Drop Off Success", "Delivered", "Dépose réussie"
            const isSuccess = (s) => {
                const t = normSt(s);
                if (!t) return false;
                return t.includes('sign success') || t.includes('drop off success') || t.includes('delivered')
                    || t.includes('depose reussie')
                    || (t.includes('livraison') && t.includes('reussi'));
            };
            // ÉCHEC : "Livraison client échouée", "Sign Failed", "Delivery Failed", "Échec"
            const isFail = (s) => {
                const t = normSt(s);
                if (!t) return false;
                return t.includes('echec') || t.includes('failed') || t.includes('sign fail')
                    || (t.includes('livraison') && t.includes('echou'));
            };
            // NB : tout autre statut (Annulée, Expédié, Créé, En livraison, Pickup…) n'est
            // ni livré ni échec → exclu du calcul (le livreur n'est payé que sur les livrés).

            // PUDO : dépose en point relais. Rémunérée comme une livraison normale,
            // mais comptée séparément pour la règle de pénalité (voir calculerSalaireMensuel).
            const isPudo = (row) => {
                const t = normSt(cols.status ? row[cols.status] : '');
                if (t.includes('drop off success') || t.includes('depose reussie')) return true;
                const addr = row['PUDO address'] ?? row['pudo address'];
                return !!(addr && String(addr).trim() !== '');
            };

            const dateDeLigne = (row) => {
                const dr = cols.date ? row[cols.date] : null;
                if (!dr) return '';
                const d = (dr instanceof Date) ? dr : new Date(dr);
                return isNaN(d) ? String(dr).split(' ')[0] : d.toISOString().split('T')[0];
            };

            // Déduplication par (numéro de colis, DATE) : un colis livré = payé UNE seule
            // fois, au dernier compte qui l'a scanné ce jour-là (le livreur réel après
            // transfert). v43 — la date fait partie de la clé : un colis en échec puis
            // relivré un autre jour représente deux journées de travail distinctes.
            let rowsAnalyse = rows, recapDoublons = 0;
            if (cols.waybill) {
                const best = new Map(); const autres = [];
                rows.forEach((row, idx) => {
                    const wb = String(row[cols.waybill] ?? '').trim();
                    const ok = isSuccess(cols.status ? row[cols.status] : 'Sign Success');
                    if (!ok || !wb) { autres.push(row); return; }
                    const dateStr = dateDeLigne(row);
                    const cle = wb + '|' + dateStr;
                    let ts = idx;
                    const dr = cols.date ? row[cols.date] : null;
                    if (dr) { const d = (dr instanceof Date) ? dr : new Date(dr); if (!isNaN(d)) ts = d.getTime() + idx / 1e6; }
                    const prev = best.get(cle);
                    if (!prev || ts >= prev.ts) { if (prev) recapDoublons++; best.set(cle, { row, ts }); }
                    else recapDoublons++;
                });
                rowsAnalyse = autres.concat([...best.values()].map(o => o.row));
            }

            // Agréger par livreur
            const livreurStats = {};   // courierName -> {jours:{date:nb}, total, echecs, routes:Set}
            const routeMap = {};       // "date|plancode" -> {plancode, date, livreurs:{courier:nb}}

            let recapComptesTechniques = 0;
            for (const row of rowsAnalyse) {
                const courier = String(row[cols.courier] || '').trim();
                if (!courier) continue;
                // v43 — comptes techniques : jamais rémunérés, jamais affichés en paie.
                if (estCompteTechnique(courier)) { recapComptesTechniques++; continue; }
                const status = cols.status ? row[cols.status] : 'Sign Success';
                const success = isSuccess(status);
                const dateStr = dateDeLigne(row);
                const plancode = cols.plancode ? String(row[cols.plancode] || '').trim() : '';

                if (!livreurStats[courier]) {
                    livreurStats[courier] = { jours: {}, joursPudo: {}, total: 0, livres: 0, pudo: 0, echecs: 0, routes: new Set() };
                }
                const st = livreurStats[courier];
                st.total++;
                if (success) {
                    st.livres++;
                    if (dateStr) st.jours[dateStr] = (st.jours[dateStr] || 0) + 1;
                    if (isPudo(row)) {
                        st.pudo++;
                        if (dateStr) st.joursPudo[dateStr] = (st.joursPudo[dateStr] || 0) + 1;
                    }
                    if (plancode) st.routes.add(plancode);
                }
                if (isFail(status)) st.echecs++;

                // Routes partagées (sur colis livrés)
                if (success && plancode && dateStr) {
                    const key = dateStr + '|' + plancode;
                    if (!routeMap[key]) routeMap[key] = { plancode, date: dateStr, livreurs: {} };
                    routeMap[key].livreurs[courier] = (routeMap[key].livreurs[courier] || 0) + 1;
                }
            }

            // Calculer salaires + matcher catégories
            // v43 — CHEMIN DE CALCUL UNIQUE : ce module et l'Historique passent tous deux
            // par calculerSalaireMensuel(), donc par la même grille ET la même règle PUDO.
            // Auparavant les deux imports pouvaient produire des salaires différents.
            const resultats = [];
            let recapColisRemuneres = 0;
            for (const [courier, st] of Object.entries(livreurStats)) {
                const liv = matchLivreur(courier);
                let categorie = null, salaire = null, detailJours = {}, pctPudo = 0, depassementPudo = false;
                if (liv) {
                    categorie = liv.contrat;
                    // Adapte les stats au format attendu par le moteur de paie.
                    // v46 — les réaffectations de colis sont appliquées ici aussi,
                    // sinon ce rapport afficherait des salaires différents de ceux
                    // de l'Historique pour les mêmes journées.
                    const livAgg = { totalLivres: st.livres, totalPudo: st.pudo, jours: {} };
                    Object.entries(st.jours).forEach(([date, nb]) => {
                        livAgg.jours[date] = { livres: nb, pudo: st.joursPudo[date] || 0 };
                    });
                    const _ajusts = {};
                    Object.keys(livAgg.jours).forEach(d => {
                        const a = calculerAjustementsTransferts(d.slice(0, 7))[courier + '|' + d];
                        if (a) { livAgg.jours[d].cedes = a.cedes; livAgg.jours[d].recus = a.recus; }
                    });
                    // Journées où ce livreur n'a que des colis reçus
                    Object.keys(data.transfertsColis || {}).forEach(m0 => {
                        (data.transfertsColis[m0] || []).forEach(t => {
                            if (t.vers === courier && !livAgg.jours[t.date]) {
                                livAgg.jours[t.date] = { livres: 0, pudo: 0, cedes: 0, recus: t.nb };
                            }
                        });
                    });
                    const calc = calculerSalaireMensuel(livAgg, liv);
                    salaire = arrondiEuro(calc.salaire);
                    detailJours = calc.salaireParJour;
                    pctPudo = calc.pctPudo;
                    depassementPudo = calc.depassement;
                    recapColisRemuneres += st.livres;
                }
                resultats.push({
                    courier, livreur: liv, categorie, salaire, detailJours,
                    jours: st.jours, nbJours: Object.keys(st.jours).length,
                    livres: st.livres, pudo: st.pudo, echecs: st.echecs, total: st.total,
                    pctPudo, depassementPudo,
                    nbRoutes: st.routes.size
                });
            }
            resultats.sort((a, b) => (b.salaire || 0) - (a.salaire || 0) || b.livres - a.livres);

            // Routes partagées (plus d'un livreur)
            const partages = Object.values(routeMap)
                .filter(r => Object.keys(r.livreurs).length > 1)
                .map(r => ({
                    ...r,
                    nbLivreurs: Object.keys(r.livreurs).length,
                    totalColis: Object.values(r.livreurs).reduce((a, b) => a + b, 0)
                }))
                .sort((a, b) => b.totalColis - a.totalColis);

            // ── CONTRÔLE D'INTÉGRITÉ (v43) ──
            // Vérifie qu'aucune livraison n'a été perdue ni comptée deux fois :
            // somme des colis rémunérés + colis non rattachés à un livreur connu
            // + colis des comptes techniques = total des colis livrés du fichier.
            const totalLivresFichier = resultats.reduce((a, r) => a + r.livres, 0) + recapComptesTechniques;
            const colisNonReconnus = resultats.filter(r => !r.livreur).reduce((a, r) => a + r.livres, 0);
            const integrite = {
                totalLivresFichier,
                colisRemuneres: recapColisRemuneres,
                colisNonReconnus,
                colisComptesTechniques: recapComptesTechniques,
                ecart: totalLivresFichier - recapColisRemuneres - colisNonReconnus - recapComptesTechniques
            };
            if (integrite.ecart !== 0) {
                console.error('[intégrité paie] écart détecté', integrite);
            }

            _recapAnalyse = { resultats, partages, cols, doublons: recapDoublons, integrite };
            afficherRecapAnalyse(_recapAnalyse);
        }

        function afficherRecapAnalyse(analyse) {
            const { resultats, partages } = analyse;
            const overlay = document.getElementById('recapModalOverlay');
            const content = document.getElementById('recapModalContent');
            const sub = document.getElementById('recapModalSub');

            const reconnus = resultats.filter(r => r.livreur);
            const inconnus = resultats.filter(r => !r.livreur);
            const totalSalaires = reconnus.reduce((a, r) => a + (r.salaire || 0), 0);
            const totalColis = resultats.reduce((a, r) => a + r.livres, 0);

            sub.innerHTML = `<b>${resultats.length}</b> livreurs détectés · <b>${reconnus.length}</b> reconnus · <b>${totalColis.toLocaleString()}</b> colis livrés · <b>${partages.length}</b> routes partagées${analyse.doublons ? ` · <b>${analyse.doublons}</b> doublon(s) de colis ignoré(s)` : ''}`;

            const catLabel = (c) => ({ 'salarie': 'Salarié', 'autoentrepreneur-vehicule': 'AE Véhicule', 'auto-entrepreneur': 'AE prix/colis' }[c] || '?');
            const fmtEur = (v) => v == null ? '—' : v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

            let html = '';

            // ── Bandeau de contrôle d'intégrité (v43) ──
            const ig = analyse.integrite;
            if (ig) {
                const ok = ig.ecart === 0;
                const details = [];
                if (ig.colisComptesTechniques) details.push(`${ig.colisComptesTechniques} colis sur compte technique (non rémunérés)`);
                if (ig.colisNonReconnus) details.push(`${ig.colisNonReconnus} colis sur un compte non reconnu`);
                html += `<div style="margin:0.5rem 0 1rem;padding:0.7rem 0.9rem;border-radius:8px;font-size:0.85rem;
                        background:${ok ? 'rgba(22,163,74,0.08)' : 'rgba(220,38,38,0.1)'};
                        border-left:3px solid ${ok ? '#16a34a' : '#dc2626'};">
                    <strong style="color:${ok ? '#16a34a' : '#dc2626'};">
                        <i class="fas fa-${ok ? 'check-circle' : 'exclamation-triangle'}"></i>
                        ${ok ? 'Contrôle d\'intégrité : aucune livraison perdue ni comptée deux fois'
                             : `Contrôle d'intégrité : écart de ${ig.ecart} colis`}
                    </strong><br>
                    <span style="color:#64748b;">
                        ${ig.totalLivresFichier.toLocaleString()} colis livrés dans le fichier ·
                        ${ig.colisRemuneres.toLocaleString()} rémunérés${details.length ? ' · ' + details.join(' · ') : ''}
                    </span>
                </div>`;
            }

            // Tableau de synthèse
            html += '<h3 style="font-size:1.05rem;margin:0.5rem 0;color:#1e293b"><i class="fas fa-table"></i> Synthèse des salaires</h3>';
            html += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.85rem">';
            html += '<tr style="background:#2563eb;color:white"><th style="padding:0.5rem;text-align:left">Livreur</th><th style="padding:0.5rem">Catégorie</th><th style="padding:0.5rem">Jours</th><th style="padding:0.5rem">Colis livrés</th><th style="padding:0.5rem">Échecs</th><th style="padding:0.5rem">Salaire</th></tr>';
            for (const r of reconnus) {
                html += `<tr style="border-bottom:1px solid #e2e8f0">
                    <td style="padding:0.5rem"><b>${escapeHtml(r.livreur.prenom || '')} ${escapeHtml(r.livreur.nom || '')}</b><br><small style="color:#94a3b8">${escapeHtml(r.courier)}</small></td>
                    <td style="padding:0.5rem;text-align:center">${catLabel(r.categorie)}</td>
                    <td style="padding:0.5rem;text-align:center">${r.nbJours}</td>
                    <td style="padding:0.5rem;text-align:center;font-weight:600">${r.livres.toLocaleString()}</td>
                    <td style="padding:0.5rem;text-align:center;color:${r.echecs?'#dc2626':'#94a3b8'}">${r.echecs}</td>
                    <td style="padding:0.5rem;text-align:right;font-weight:700;color:#16a34a">${fmtEur(r.salaire)}</td>
                </tr>`;
            }
            html += `<tr style="background:#f1f5f9;font-weight:700"><td style="padding:0.5rem" colspan="3">TOTAL (${reconnus.length} livreurs)</td><td style="padding:0.5rem;text-align:center">${reconnus.reduce((a,r)=>a+r.livres,0).toLocaleString()}</td><td></td><td style="padding:0.5rem;text-align:right;color:#16a34a">${fmtEur(totalSalaires)}</td></tr>`;
            html += '</table></div>';

            // Livreurs non reconnus
            if (inconnus.length) {
                html += `<div style="margin-top:1rem;padding:0.8rem;background:#fef3c7;border-radius:8px;font-size:0.83rem;color:#92400e">
                    <b><i class="fas fa-exclamation-triangle"></i> ${inconnus.length} livreur(s) non reconnu(s)</b> (pas dans votre liste de livreurs configurés) :<br>
                    ${inconnus.map(r => `${escapeHtml(r.courier)} (${r.livres} colis)`).join(', ')}
                    <br><small>Ajoutez-les dans l'onglet "Livreurs" avec leur catégorie pour calculer leur salaire, puis relancez l'analyse.</small>
                </div>`;
            }

            // Détail par livreur reconnu (accordéon simple)
            html += '<h3 style="font-size:1.05rem;margin:1.2rem 0 0.5rem;color:#1e293b"><i class="fas fa-list-ol"></i> Détail journalier</h3>';
            for (const r of reconnus) {
                const jours = Object.keys(r.jours).sort();
                html += `<details style="margin-bottom:0.5rem;border:1px solid #e2e8f0;border-radius:8px">
                    <summary style="padding:0.6rem 0.8rem;cursor:pointer;font-weight:600">${escapeHtml(r.livreur.prenom||'')} ${escapeHtml(r.livreur.nom||'')} — ${fmtEur(r.salaire)} (${r.livres} colis sur ${r.nbJours} j)</summary>
                    <div style="padding:0.5rem 0.8rem;overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.8rem">
                    <tr style="color:#64748b;border-bottom:1px solid #e2e8f0"><th style="text-align:left;padding:0.3rem">Date</th><th style="padding:0.3rem">Colis</th><th style="text-align:right;padding:0.3rem">Salaire jour</th></tr>`;
                for (const date of jours) {
                    html += `<tr><td style="padding:0.3rem">${escapeHtml(date)}</td><td style="text-align:center;padding:0.3rem">${r.jours[date]}</td><td style="text-align:right;padding:0.3rem">${fmtEur(r.detailJours[date])}</td></tr>`;
                }
                html += '</table></div></details>';
            }

            // Routes partagées
            if (partages.length) {
                html += `<h3 style="font-size:1.05rem;margin:1.2rem 0 0.5rem;color:#1e293b"><i class="fas fa-people-arrows"></i> Routes partagées (${partages.length})</h3>`;
                html += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.82rem">';
                html += '<tr style="background:#f1f5f9"><th style="padding:0.4rem;text-align:left">Date</th><th style="padding:0.4rem;text-align:left">Route</th><th style="padding:0.4rem;text-align:left">Répartition</th><th style="padding:0.4rem">Total</th></tr>';
                for (const p of partages.slice(0, 100)) {
                    const repart = Object.entries(p.livreurs).sort((a,b)=>b[1]-a[1]).map(([n,c]) => `${escapeHtml(n)} (${c})`).join(' · ');
                    html += `<tr style="border-bottom:1px solid #e2e8f0"><td style="padding:0.4rem">${escapeHtml(p.date)}</td><td style="padding:0.4rem"><b>${escapeHtml(p.plancode)}</b></td><td style="padding:0.4rem">${repart}</td><td style="padding:0.4rem;text-align:center;font-weight:600">${p.totalColis}</td></tr>`;
                }
                html += '</table></div>';
                if (partages.length > 100) html += `<small style="color:#94a3b8">… et ${partages.length - 100} autres routes partagées (toutes dans l'export Excel)</small>`;
            }

            content.innerHTML = html;
            overlay.classList.add('active');
        }

        // escapeHtml() : voir js/core/utils.js (fonction centrale)

        // Export du rapport d'analyse en Excel
        async function exportRecapAnalyse() {
            if (!_recapAnalyse) { showToast('Aucune analyse à exporter', 'error'); return; }
            const libOk = await loadXLSXLib();
            if (!libOk) { showToast('Librairie indisponible', 'error'); return; }

            const { resultats, partages } = _recapAnalyse;
            const reconnus = resultats.filter(r => r.livreur);
            const catLabel = (c) => ({ 'salarie': 'Salarié', 'autoentrepreneur-vehicule': 'AE Véhicule', 'auto-entrepreneur': 'AE prix/colis' }[c] || '?');

            const wb = XLSX.utils.book_new();

            // Feuille Synthèse
            const synthData = [['Livreur', 'Nom fichier', 'Catégorie', 'Jours', 'Colis livrés', 'Échecs', 'Salaire (€)']];
            for (const r of reconnus) {
                synthData.push([
                    `${r.livreur.prenom || ''} ${r.livreur.nom || ''}`.trim(),
                    r.courier, catLabel(r.categorie), r.nbJours, r.livres, r.echecs,
                    r.salaire
                ]);
            }
            synthData.push(['TOTAL', '', '', '', reconnus.reduce((a,r)=>a+r.livres,0), '', reconnus.reduce((a,r)=>a+(r.salaire||0),0)]);
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(synthData), 'Synthèse');

            // Feuille Détail journalier
            const detailData = [['Livreur', 'Date', 'Colis', 'Salaire jour (€)']];
            for (const r of reconnus) {
                for (const date of Object.keys(r.jours).sort()) {
                    detailData.push([`${r.livreur.prenom||''} ${r.livreur.nom||''}`.trim(), date, r.jours[date], r.detailJours[date]]);
                }
            }
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detailData), 'Détail journalier');

            // Feuille Routes partagées
            const routesData = [['Date', 'Route', 'Répartition (livreur:colis)', 'Total colis']];
            for (const p of partages) {
                const repart = Object.entries(p.livreurs).sort((a,b)=>b[1]-a[1]).map(([n,c]) => `${n}:${c}`).join(' | ');
                routesData.push([p.date, p.plancode, repart, p.totalColis]);
            }
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(routesData), 'Routes partagées');

            // Feuille Non reconnus
            const inconnus = resultats.filter(r => !r.livreur);
            if (inconnus.length) {
                const incData = [['Nom fichier', 'Jours', 'Colis livrés', 'Échecs']];
                for (const r of inconnus) incData.push([r.courier, r.nbJours, r.livres, r.echecs]);
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(incData), 'Non reconnus');
            }

            const moisStr = new Date().toISOString().split('T')[0];
            XLSX.writeFile(wb, `Analyse_Salaires_${moisStr}.xlsx`);
            showToast('Rapport Excel exporté', 'success');
        }


        // ============== CALCUL SALAIRE MENSUEL AVEC RÈGLE PUDO ==============
        // Règle métier (s'applique aux salariés ET aux auto-entrepreneurs) :
        // - Compter le total PUDO du mois
        // - Si % PUDO > 3% du total livré → TOUS les colis PUDO sont rémunérés à 0,80 €
        // - Sinon → tarif normal (grille pour salarié, taux × colis pour auto-ent)
        // Pour salariés en cas de dépassement :
        //   Salaire = Grille appliquée aux colis NON-PUDO (jour par jour) + (PUDO × 0,80 €)
        const SEUIL_PUDO_PCT = 3;        // valeur historique (fallback)
        function getSeuilPudoPct() {
            return (data && typeof data.seuilPudoPct === 'number') ? data.seuilPudoPct : SEUIL_PUDO_PCT;
        }
        // v41 : tarif PUDO pénalité dynamique (peut être surchargé via paramètres)
        function getTarifPudoPenalite() {
            return (data && typeof data.tarifPudoPenalite === 'number') ? data.tarifPudoPenalite : 0.80;
        }
        const TARIF_PUDO_PENALITE = 0.80;   // 0,80 € (valeur historique pour backward compat)
        const SEUIL_ECHEC_PCT = 1.4;        // 1.4% (taux d'échec maximal toléré, indicatif)

        function calculerSalaireMensuel(liv, livreurConfig) {
            // ÉTAGE 2 → ÉTAGE 3 : le salaire se calcule sur les colis RÉMUNÉRABLES
            // (livrés − cédés + reçus), pas sur les colis bruts de l'export.
            const totalRemunerable = Object.values(liv.jours || {})
                .reduce((a, j) => a + colisRemunerablesJour(j), 0);
            const totalLivres = totalRemunerable || 0;
            const totalPudo = liv.totalPudo || 0;
            const pctPudo = totalLivres > 0 ? (totalPudo / totalLivres * 100) : 0;
            const depassement = pctPudo > getSeuilPudoPct();

            let salaire = 0;
            let salaireParJour = {};   // pour affichage dans le tableau journalier
            let detailCalcul = '';

            // Fonction grille utilisée selon la catégorie de contrat
            // - salarie                       → grille standard
            // - autoentrepreneur-vehicule     → grille standard + 10 €
            // - auto-entrepreneur (autre)     → pas de grille (taux × colis)
            const useGrille = (livreurConfig.contrat === 'salarie' || livreurConfig.contrat === 'autoentrepreneur-vehicule');
            const grilleFn = (livreurConfig.contrat === 'autoentrepreneur-vehicule')
                ? calculerSalaireJournalierAEvehicule
                : calculerSalaireJournalierSalarié;
            const labelCategorie = livreurConfig.contrat === 'autoentrepreneur-vehicule'
                ? 'Grille +10€ (AE véhicule entreprise)'
                : 'Grille obligatoire (Salarié)';

            if (useGrille) {
                // === SALARIÉ ou AE-VÉHICULE : grille journalière ===
                if (!depassement) {
                    // Tarif normal : grille appliquée sur le total journalier (PUDO inclus)
                    Object.entries(liv.jours).forEach(([date, j]) => {
                        const sj = grilleFn(colisRemunerablesJour(j));
                        salaire += sj;
                        salaireParJour[date] = sj;
                    });
                    detailCalcul = `${labelCategorie} appliquée sur les colis livrés par jour (PUDO inclus, ${pctPudo.toFixed(2)}% ≤ 3%)`;
                } else {
                    // Dépassement : grille sur NON-PUDO + PUDO à 0,80€
                    Object.entries(liv.jours).forEach(([date, j]) => {
                        const nonPudo = Math.max(0, colisRemunerablesJour(j) - (j.pudo || 0));
                        const grilleSalary = grilleFn(nonPudo);
                        const pudoSalary = (j.pudo || 0) * getTarifPudoPenalite();
                        const sj = grilleSalary + pudoSalary;
                        salaire += sj;
                        salaireParJour[date] = sj;
                    });
                    detailCalcul = `<span style="color:var(--danger);font-weight:700;">⚠ % PUDO ${pctPudo.toFixed(2)}% > 3%</span> · ${labelCategorie} appliquée aux colis NON-PUDO + ${escapeHtml(totalPudo)} PUDO × 0,80 €`;
                }
            } else {
                // === AUTO-ENTREPRENEUR PRIX AU COLIS : taux × colis ===
                if (!depassement) {
                    salaire = totalLivres * livreurConfig.taux;
                    Object.entries(liv.jours).forEach(([date, j]) => {
                        salaireParJour[date] = colisRemunerablesJour(j) * livreurConfig.taux;
                    });
                    detailCalcul = `${totalLivres} colis × ${escapeHtml(livreurConfig.taux)} € (${pctPudo.toFixed(2)}% PUDO ≤ 3%)`;
                } else {
                    // Dépassement : non-PUDO × taux + PUDO × 0,80 €
                    const nonPudo = totalLivres - totalPudo;
                    salaire = (nonPudo * livreurConfig.taux) + (totalPudo * getTarifPudoPenalite());
                    Object.entries(liv.jours).forEach(([date, j]) => {
                        const nonPudoJ = Math.max(0, colisRemunerablesJour(j) - (j.pudo || 0));
                        salaireParJour[date] = (nonPudoJ * livreurConfig.taux) + ((j.pudo || 0) * getTarifPudoPenalite());
                    });
                    detailCalcul = `<span style="color:var(--danger);font-weight:700;">⚠ % PUDO ${pctPudo.toFixed(2)}% > 3%</span> · ${nonPudo} colis × ${escapeHtml(livreurConfig.taux)} € + ${escapeHtml(totalPudo)} PUDO × 0,80 €`;
                }
            }

            return {
                salaire,
                salaireParJour,
                detailCalcul,
                pctPudo,
                depassement,
                totalPudo,
                seuilPct: getSeuilPudoPct()
            };
        }

        function getGrilleInfo(colis) {
            // Dérivé de la grille configurable — aucun seuil codé en dur.
            return decrireRegleAppliquee(colis);
        }


