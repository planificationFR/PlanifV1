        // ============== v41 : MODULE PARAMÈTRES (settings) ==================
        // ====================================================================

        /**
         * Renvoie la capacité maximale de colis pour un CP donné.
         * Si le CP a une exception définie, l'utilise ; sinon utilise la capacité standard.
         */
        function getCapaciteCP(cp) {
            const exceptions = data.cpExceptions || {};
            if (exceptions[cp] !== undefined) return exceptions[cp];
            return data.paramètres?.max_colis || 160;
        }

        // ============== Onglets paramètres ==============
        function switchSettingsTab(tabName) {
            document.querySelectorAll('[data-settings-tab]').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.settings-tab-content').forEach(c => c.style.display = 'none');
            const btn = document.querySelector(`[data-settings-tab="${tabName}"]`);
            if (btn) btn.classList.add('active');
            const map = {
                'general': 'settingsTabGeneral',
                'salaire': 'settingsTabSalaire',
                'onglets': 'settingsTabOnglets',
                'compte': 'settingsTabCompte',
                'suivi': 'settingsTabSuivi'
            };
            const target = document.getElementById(map[tabName]);
            if (target) target.style.display = 'block';
            // Si suivi, charger les données
            if (tabName === 'suivi') {
                const moisInput = document.getElementById('suiviMoisSelect');
                if (moisInput && !moisInput.value) {
                    const now = new Date();
                    moisInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                }
                afficherSuiviMensuel();
            }
        }

        // ============== Exceptions CP ==============
        function renderCPExceptionsList() {
            const container = document.getElementById('settingsCPExceptionsList');
            if (!container) return;
            const exceptions = data.cpExceptions || {};
            const keys = Object.keys(exceptions).sort();
            if (keys.length === 0) {
                container.innerHTML = '<p style="color: var(--text-secondary); font-style: italic; font-size: 0.85rem;">Aucune exception définie.</p>';
                return;
            }
            container.innerHTML = keys.map(cp => {
                const cpData = (typeof CP_FR_DATABASE !== 'undefined' && CP_FR_DATABASE[cp]) ? CP_FR_DATABASE[cp] : null;
                const commune = cpData ? cpData.commune : '';
                return `
                    <div style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; background: var(--background-light); border-radius: var(--radius-sm); margin-bottom: 0.25rem;">
                        <strong style="color: var(--primary); font-family: monospace;">${escapeHtml(cp)}</strong>
                        ${commune ? `<span style="color: var(--text-secondary); font-size: 0.85rem;">${escapeHtml(commune)}</span>` : ''}
                        <span style="margin-left: auto; font-weight: 600;">→ ${escapeHtml(exceptions[cp])} colis max</span>
                        <button class="btn btn-danger btn-sm" onclick="supprimerCPException('${escJsAttr(cp)}')" title="Supprimer">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                `;
            }).join('');
        }

        function ajouterCPException() {
            const cpInput = document.getElementById('newCPException');
            const capInput = document.getElementById('newCPCapacite');
            const cp = (cpInput?.value || '').trim();
            const cap = parseInt(capInput?.value, 10);
            if (!/^\d{5}$/.test(cp)) {
                showToast('Code postal invalide (5 chiffres requis)', 'warning');
                return;
            }
            if (!cap || cap < 1) {
                showToast('Capacité invalide', 'warning');
                return;
            }
            if (!data.cpExceptions) data.cpExceptions = {};
            data.cpExceptions[cp] = cap;
            cpInput.value = '';
            capInput.value = '';
            renderCPExceptionsList();
            hasUnsavedChanges = true;
            showToast(`Exception ajoutée : ${cp} → ${cap} colis max`, 'success');
        }

        function supprimerCPException(cp) {
            if (!data.cpExceptions) return;
            delete data.cpExceptions[cp];
            renderCPExceptionsList();
            hasUnsavedChanges = true;
            showToast(`Exception ${cp} supprimée`, 'info');
        }

        // ============== ÉDITEUR DE RÈGLES DE RÉMUNÉRATION (v43) ==============
        // Tableau de règles métier lisible sans connaître le code : de / à /
        // type / montant / prix par colis. Aucune variable technique exposée.

        function renderGrilleSalaireList() {
            const container = document.getElementById('grilleSalaireList');
            if (!container) return;
            const grille = getGrilleRemuneration();
            const tri = [...grille].sort((a, b) => (Number(a.min) || 0) - (Number(b.min) || 0));
            const check = validerGrille(tri);

            const alerte = check.ok ? '' : `
                <div style="margin-bottom:0.6rem;padding:0.6rem 0.75rem;background:rgba(231,76,60,0.1);border-left:3px solid var(--danger);border-radius:var(--radius-sm);font-size:0.8rem;">
                    <strong style="color:var(--danger);"><i class="fas fa-exclamation-triangle"></i> Grille incohérente</strong>
                    <ul style="margin:0.35rem 0 0 1rem;padding:0;">${check.erreurs.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
                </div>`;

            const lignes = tri.map((r) => {
                const idx = grille.indexOf(r);
                const maxTxt = (r.max === null || r.max === undefined || r.max === '') ? '∞' : r.max;
                let valeur;
                if (r.type === 'par_colis') {
                    valeur = `${Number(r.prixColis || 0).toFixed(2)} € / colis`;
                } else if (r.type === 'forfait') {
                    valeur = `${Number(r.montant || 0).toFixed(2)} €`;
                } else {
                    const inclus = (r.colisInclus ?? r.min);
                    valeur = `${Number(r.montant || 0).toFixed(2)} € + ${Number(r.prixColis || 0).toFixed(2)} € / colis au-delà de ${inclus}`;
                }
                return `
                <div style="display:grid;grid-template-columns:60px 60px 1fr 1.6fr auto;gap:0.5rem;padding:0.45rem 0.6rem;align-items:center;border-bottom:1px solid var(--border);font-size:0.85rem;">
                    <div style="font-family:monospace;font-weight:600;">${escapeHtml(r.min)}</div>
                    <div style="font-family:monospace;font-weight:600;">${escapeHtml(maxTxt)}</div>
                    <div style="color:var(--text-secondary);">${escapeHtml(TYPES_REGLE_LABELS[r.type] || r.type)}</div>
                    <div style="font-family:monospace;color:var(--success);font-weight:700;">${valeur}</div>
                    <button class="btn btn-danger btn-sm" onclick="supprimerPalierSalaire(${idx})" title="Supprimer cette règle">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>`;
            }).join('');

            container.innerHTML = `${alerte}
                <div style="display:grid;grid-template-columns:60px 60px 1fr 1.6fr auto;gap:0.5rem;padding:0.4rem 0.6rem;font-size:0.75rem;font-weight:700;color:var(--text-secondary);border-bottom:1px solid var(--border);">
                    <div>De</div><div>À</div><div>Type</div><div>Rémunération</div><div></div>
                </div>
                ${lignes}
                <div style="margin-top:0.6rem;padding:0.5rem 0.6rem;background:var(--background-light);border-radius:var(--radius-sm);font-size:0.78rem;color:var(--text-secondary);">
                    <strong>Simulation :</strong>
                    <input type="number" id="grilleSimuColis" value="150" min="0" style="width:70px;padding:2px 6px;margin:0 0.35rem;border:1px solid var(--border);border-radius:4px;" oninput="simulerGrille()"> colis
                    → <span id="grilleSimuResultat" style="font-weight:700;color:var(--success);"></span>
                </div>`;
            simulerGrille();
        }

        function simulerGrille() {
            const el = document.getElementById('grilleSimuColis');
            const out = document.getElementById('grilleSimuResultat');
            if (!el || !out) return;
            const nb = parseInt(el.value, 10);
            out.textContent = (isNaN(nb) || nb < 0) ? '—' : decrireRegleAppliquee(nb);
        }

        function onChangeTypeRegle() {
            const type = document.getElementById('newRegleType')?.value;
            const gMontant = document.getElementById('groupeRegleMontant');
            const gPrix    = document.getElementById('groupeReglePrixColis');
            const gInclus  = document.getElementById('groupeRegleColisInclus');
            if (gMontant) gMontant.style.display = (type === 'forfait' || type === 'forfait_plus_colis') ? '' : 'none';
            if (gPrix)    gPrix.style.display    = (type === 'par_colis' || type === 'forfait_plus_colis') ? '' : 'none';
            if (gInclus)  gInclus.style.display  = (type === 'forfait_plus_colis') ? '' : 'none';
        }

        function ajouterPalierSalaire() {
            const num = (id) => {
                const v = document.getElementById(id)?.value;
                return (v === '' || v === undefined || v === null) ? null : Number(v);
            };
            const min  = num('newRegleMin');
            const max  = num('newRegleMax');
            const type = document.getElementById('newRegleType')?.value;

            if (min === null || isNaN(min) || min < 0) { showToast('Minimum de colis invalide', 'warning'); return; }
            if (max !== null && (isNaN(max) || max < min)) { showToast('Maximum invalide (doit être ≥ minimum, ou vide pour ∞)', 'warning'); return; }
            if (!TYPES_REGLE_LABELS[type]) { showToast('Type de rémunération invalide', 'warning'); return; }

            const regle = { min, max, type };
            if (type === 'forfait' || type === 'forfait_plus_colis') {
                const m = num('newRegleMontant');
                if (m === null || isNaN(m) || m < 0) { showToast('Montant invalide', 'warning'); return; }
                regle.montant = m;
            }
            if (type === 'par_colis' || type === 'forfait_plus_colis') {
                const p = num('newReglePrixColis');
                if (p === null || isNaN(p) || p < 0) { showToast('Prix par colis invalide', 'warning'); return; }
                regle.prixColis = p;
            }
            if (type === 'forfait_plus_colis') {
                const c = num('newRegleColisInclus');
                regle.colisInclus = (c === null || isNaN(c)) ? min : c;
            }

            if (!Array.isArray(data.grilleRemuneration)) {
                data.grilleRemuneration = JSON.parse(JSON.stringify(GRILLE_REMUNERATION_DEFAUT));
            }
            // Remplace une règle existante qui commence au même minimum
            const existant = data.grilleRemuneration.findIndex(r => (Number(r.min) || 0) === min);
            if (existant >= 0) data.grilleRemuneration[existant] = regle;
            else data.grilleRemuneration.push(regle);
            data.grilleRemuneration.sort((a, b) => (Number(a.min) || 0) - (Number(b.min) || 0));

            ['newRegleMin', 'newRegleMax', 'newRegleMontant', 'newReglePrixColis', 'newRegleColisInclus']
                .forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });

            renderGrilleSalaireList();
            hasUnsavedChanges = true;
            showToast(`Règle ${min}–${max === null ? '∞' : max} enregistrée`, 'success');
        }

        function supprimerPalierSalaire(idx) {
            if (!Array.isArray(data.grilleRemuneration) || idx < 0 || idx >= data.grilleRemuneration.length) return;
            data.grilleRemuneration.splice(idx, 1);
            renderGrilleSalaireList();
            hasUnsavedChanges = true;
            showToast('Règle supprimée', 'info');
        }

        function reinitialiserGrille() {
            if (!confirm('Rétablir la grille par défaut ? Vos règles personnalisées seront perdues.')) return;
            data.grilleRemuneration = JSON.parse(JSON.stringify(GRILLE_REMUNERATION_DEFAUT));
            renderGrilleSalaireList();
            hasUnsavedChanges = true;
            showToast('Grille par défaut rétablie', 'success');
        }

        // ---- Comptes techniques (comptes de scan non rémunérés) ----
        function renderComptesTechniquesList() {
            const c = document.getElementById('comptesTechniquesList');
            if (!c) return;
            const liste = getComptesTechniques();
            if (!liste.length) {
                c.innerHTML = '<p style="color:var(--text-secondary);font-style:italic;font-size:0.82rem;">Aucun compte technique déclaré.</p>';
                return;
            }
            c.innerHTML = liste.map((nom, i) => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:0.35rem 0.6rem;border-bottom:1px solid var(--border);font-size:0.85rem;">
                    <span style="font-family:monospace;font-weight:600;">${escapeHtml(nom)}</span>
                    <button class="btn btn-danger btn-sm" onclick="supprimerCompteTechnique(${i})" title="Retirer">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>`).join('');
        }

        function ajouterCompteTechnique() {
            const el = document.getElementById('newCompteTechnique');
            const nom = (el?.value || '').trim();
            if (!nom) { showToast('Nom de compte vide', 'warning'); return; }
            if (!Array.isArray(data.comptesTechniques)) data.comptesTechniques = [...COMPTES_TECHNIQUES_DEFAUT];
            if (estCompteTechnique(nom)) { showToast('Ce compte est déjà déclaré', 'info'); return; }
            data.comptesTechniques.push(nom);
            el.value = '';
            renderComptesTechniquesList();
            hasUnsavedChanges = true;
            showToast(`« ${nom} » exclu du calcul des salaires`, 'success');
        }

        function supprimerCompteTechnique(i) {
            if (!Array.isArray(data.comptesTechniques) || i < 0 || i >= data.comptesTechniques.length) return;
            data.comptesTechniques.splice(i, 1);
            renderComptesTechniquesList();
            hasUnsavedChanges = true;
            showToast('Compte retiré de la liste', 'info');
        }

        // ============== Visibilité onglets ==============
        const ONGLETS_LABELS = {
            accueil: 'Accueil',
            livreurs: 'Livreurs',
            previsions: 'Prévisions',
            distribution: 'Distribution',
            rapport: 'Rapport',
            carte: 'Carte',
            historique: 'Historique',
            controle: 'Contrôle EPOD',
            inventaire: 'Inventaire',
            sync: 'Synchronisation',
            aide: 'Aide'
        };

        function renderOngletsVisibilityList() {
            const container = document.getElementById('ongletsVisibilityList');
            if (!container) return;
            if (!data.ongletsVisibles) {
                data.ongletsVisibles = {};
                Object.keys(ONGLETS_LABELS).forEach(k => data.ongletsVisibles[k] = true);
            }
            container.innerHTML = Object.keys(ONGLETS_LABELS).map(key => `
                <label style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; background: var(--background-light); border-radius: var(--radius-sm); cursor: pointer; transition: background 0.2s;">
                    <input type="checkbox" id="ongletVisible_${key}" ${data.ongletsVisibles[key] !== false ? 'checked' : ''}
                           ${key === 'accueil' ? 'disabled' : ''}
                           style="cursor: pointer; width: 18px; height: 18px;">
                    <span>${ONGLETS_LABELS[key]}</span>
                    ${key === 'accueil' ? '<small style="color: var(--text-secondary); margin-left: auto;">(toujours visible)</small>' : ''}
                </label>
            `).join('');
        }

        function applyOngletsVisibility() {
            if (!data.ongletsVisibles) return;
            Object.keys(ONGLETS_LABELS).forEach(key => {
                const navItem = document.querySelector(`.nav-item[data-tab="${key}"]`);
                if (navItem) {
                    if (data.ongletsVisibles[key] === false && key !== 'accueil') {
                        navItem.style.display = 'none';
                    } else {
                        navItem.style.display = '';
                    }
                }
            });
        }

        // ============== Compte / Identifiants ==============
        // updateCredentials() : voir js/auth.js (mot de passe du compte Supabase).

        // ============== Suivi mensuel ==============
        function recalculerSuiviMensuel() {
            if (!data.suiviMensuel) data.suiviMensuel = {};
            if (!data.distributions) return;
            const livreurNomMap = {};
            (data.livreurs || []).forEach(l => {
                livreurNomMap[l.id] = l.nom + (l.prenom ? ' ' + l.prenom : '');
            });
            const buf = {};
            Object.keys(data.distributions).forEach(date => {
                const dist = data.distributions[date];
                if (!dist || !dist.livreurs) return;
                const ym = date.substring(0, 7);
                if (!buf[ym]) buf[ym] = {};
                Object.keys(dist.livreurs).forEach(livId => {
                    const livData = dist.livreurs[livId];
                    let totalColis = 0;
                    if (typeof livData === 'object' && livData) {
                        if (Array.isArray(livData.secteurs)) {
                            totalColis = livData.secteurs.reduce((s, sec) => s + (sec.colis || 0), 0);
                        } else if (typeof livData.totalColis === 'number') {
                            totalColis = livData.totalColis;
                        } else if (typeof livData.total === 'number') {
                            totalColis = livData.total;
                        }
                    }
                    if (!buf[ym][livId]) {
                        buf[ym][livId] = {
                            nom: livreurNomMap[livId] || livId,
                            colisLivres: 0,
                            jours: 0
                        };
                    }
                    buf[ym][livId].colisLivres += totalColis;
                    if (totalColis > 0) buf[ym][livId].jours += 1;
                    if (livreurNomMap[livId]) buf[ym][livId].nom = livreurNomMap[livId];
                });
            });
            // EPOD complémentaire si pas de distribution pour cette date
            if (data.historiqueEPOD) {
                Object.keys(data.historiqueEPOD).forEach(date => {
                    if (data.distributions && data.distributions[date]) return;
                    const ep = data.historiqueEPOD[date];
                    if (!ep || !ep.livreurs) return;
                    const ym = date.substring(0, 7);
                    if (!buf[ym]) buf[ym] = {};
                    Object.keys(ep.livreurs).forEach(livId => {
                        const livRow = ep.livreurs[livId];
                        const livres = (livRow.livres || livRow.totalLivres || 0);
                        if (!buf[ym][livId]) {
                            buf[ym][livId] = {
                                nom: livreurNomMap[livId] || livId,
                                colisLivres: 0,
                                jours: 0
                            };
                        }
                        if (livres > 0) {
                            buf[ym][livId].colisLivres += livres;
                            buf[ym][livId].jours += 1;
                        }
                    });
                });
            }
            data.suiviMensuel = buf;
        }

        function afficherSuiviMensuel() {
            recalculerSuiviMensuel();
            const moisInput = document.getElementById('suiviMoisSelect');
            const tableContainer = document.getElementById('suiviMensuelTable');
            if (!moisInput || !tableContainer) return;
            let mois = moisInput.value;
            if (!mois) {
                const now = new Date();
                mois = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                moisInput.value = mois;
            }
            const rowsObj = (data.suiviMensuel || {})[mois] || {};
            const rows = Object.keys(rowsObj).map(id => ({ id, ...rowsObj[id] }));
            rows.sort((a, b) => b.colisLivres - a.colisLivres);
            const totalColis = rows.reduce((s, r) => s + r.colisLivres, 0);
            const totalJours = rows.reduce((s, r) => s + r.jours, 0);

            if (rows.length === 0) {
                tableContainer.innerHTML = `
                    <div style="text-align: center; padding: 2rem; color: var(--text-secondary); background: var(--background-light); border-radius: var(--radius-sm);">
                        <i class="fas fa-folder-open" style="font-size: 2rem; opacity: 0.4; margin-bottom: 0.5rem; display: block;"></i>
                        Aucune donnée pour le mois ${escapeHtml(mois)}.
                    </div>
                `;
                return;
            }

            tableContainer.innerHTML = `
                <div style="background: var(--card); border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border);">
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead style="background: var(--background-light);">
                            <tr>
                                <th style="text-align: left; padding: 0.6rem 0.8rem; font-size: 0.8rem; border-bottom: 2px solid var(--border);">#</th>
                                <th style="text-align: left; padding: 0.6rem 0.8rem; font-size: 0.8rem; border-bottom: 2px solid var(--border);">Livreur</th>
                                <th style="text-align: right; padding: 0.6rem 0.8rem; font-size: 0.8rem; border-bottom: 2px solid var(--border);">Colis livrés</th>
                                <th style="text-align: right; padding: 0.6rem 0.8rem; font-size: 0.8rem; border-bottom: 2px solid var(--border);">Jours</th>
                                <th style="text-align: right; padding: 0.6rem 0.8rem; font-size: 0.8rem; border-bottom: 2px solid var(--border);">Moy./jour</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map((r, idx) => `
                                <tr style="border-bottom: 1px solid var(--border);">
                                    <td style="padding: 0.55rem 0.8rem; color: var(--text-secondary); font-size: 0.85rem;">${idx + 1}</td>
                                    <td style="padding: 0.55rem 0.8rem; font-weight: 600;">${escapeHtmlSettings(r.nom)}</td>
                                    <td style="text-align: right; padding: 0.55rem 0.8rem; font-weight: 700; color: var(--primary); font-family: monospace;">${escapeHtml(r.colisLivres)}</td>
                                    <td style="text-align: right; padding: 0.55rem 0.8rem; font-family: monospace;">${escapeHtml(r.jours)}</td>
                                    <td style="text-align: right; padding: 0.55rem 0.8rem; font-family: monospace; color: var(--text-secondary);">${r.jours > 0 ? Math.round(r.colisLivres / r.jours) : 0}</td>
                                </tr>
                            `).join('')}
                            <tr style="background: var(--background-light); font-weight: 700;">
                                <td colspan="2" style="padding: 0.6rem 0.8rem;">Total</td>
                                <td style="text-align: right; padding: 0.6rem 0.8rem; color: var(--primary); font-family: monospace;">${escapeHtml(totalColis)}</td>
                                <td style="text-align: right; padding: 0.6rem 0.8rem; font-family: monospace;">${escapeHtml(totalJours)}</td>
                                <td style="text-align: right; padding: 0.6rem 0.8rem; font-family: monospace; color: var(--text-secondary);">${totalJours > 0 ? Math.round(totalColis / totalJours) : 0}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p style="margin-top: 0.75rem; color: var(--text-secondary); font-size: 0.8rem;">
                    <i class="fas fa-info-circle"></i> Données calculées automatiquement à partir des distributions enregistrées et de l'historique EPOD.
                </p>
            `;
        }

        // escapeHtmlSettings() : voir js/core/utils.js

        function exportSuiviCSV() {
            const moisInput = document.getElementById('suiviMoisSelect');
            const mois = moisInput?.value;
            if (!mois) { showToast('Sélectionnez un mois', 'warning'); return; }
            recalculerSuiviMensuel();
            const rowsObj = (data.suiviMensuel || {})[mois] || {};
            const rows = Object.keys(rowsObj).map(id => ({ id, ...rowsObj[id] }));
            if (rows.length === 0) { showToast('Aucune donnée à exporter', 'warning'); return; }
            rows.sort((a, b) => b.colisLivres - a.colisLivres);

            const lines = ['Rang;Livreur;Colis livres;Jours travailles;Moyenne/jour'];
            rows.forEach((r, idx) => {
                const moy = r.jours > 0 ? Math.round(r.colisLivres / r.jours) : 0;
                lines.push(`${idx + 1};"${(r.nom || '').replace(/"/g, '""')}";${r.colisLivres};${r.jours};${moy}`);
            });
            const total = rows.reduce((s, r) => s + r.colisLivres, 0);
            const totalJ = rows.reduce((s, r) => s + r.jours, 0);
            lines.push(`;TOTAL;${total};${totalJ};${totalJ > 0 ? Math.round(total / totalJ) : 0}`);

            const csv = '\ufeff' + lines.join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `suivi_mensuel_${mois}.csv`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            showToast(`Suivi ${mois} exporté en CSV`, 'success');
        }

        async function exportSuiviPDF() {
            const moisInput = document.getElementById('suiviMoisSelect');
            const mois = moisInput?.value;
            if (!mois) { showToast('Sélectionnez un mois', 'warning'); return; }
            recalculerSuiviMensuel();
            const rowsObj = (data.suiviMensuel || {})[mois] || {};
            const rows = Object.keys(rowsObj).map(id => ({ id, ...rowsObj[id] }));
            if (rows.length === 0) { showToast('Aucune donnée à exporter', 'warning'); return; }
            rows.sort((a, b) => b.colisLivres - a.colisLivres);

            try {
                await ensureJsPDF();
                const { jsPDF } = window.jspdf || { jsPDF: window.jsPDF };
                if (!jsPDF) { showToast('jsPDF indisponible', 'error'); return; }
                const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

                doc.setFontSize(16);
                doc.setFont(undefined, 'bold');
                doc.setTextColor(15, 184, 154);
                doc.text('Suivi mensuel des livreurs', 14, 18);

                doc.setFontSize(11);
                doc.setFont(undefined, 'normal');
                doc.setTextColor(80);
                const [an, m] = mois.split('-');
                const moisLabels = ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
                doc.text(`${moisLabels[parseInt(m, 10)] || m} ${an}`, 14, 25);

                const total = rows.reduce((s, r) => s + r.colisLivres, 0);
                const totalJ = rows.reduce((s, r) => s + r.jours, 0);
                doc.setFontSize(9);
                doc.setTextColor(120);
                doc.text(`${total} colis livrés sur ${totalJ} jour(s) - ${rows.length} livreur(s)`, 14, 31);

                const tableData = rows.map((r, idx) => {
                    const moy = r.jours > 0 ? Math.round(r.colisLivres / r.jours) : 0;
                    return [String(idx + 1), r.nom || '', String(r.colisLivres), String(r.jours), String(moy)];
                });
                tableData.push(['', 'TOTAL', String(total), String(totalJ), String(totalJ > 0 ? Math.round(total / totalJ) : 0)]);

                if (typeof doc.autoTable === 'function') {
                    doc.autoTable({
                        startY: 38,
                        head: [['#', 'Livreur', 'Colis livrés', 'Jours', 'Moy./jour']],
                        body: tableData,
                        theme: 'grid',
                        headStyles: { fillColor: [15, 184, 154], textColor: 255, fontSize: 10 },
                        styles: { fontSize: 9, cellPadding: 2 },
                        columnStyles: {
                            0: { halign: 'center', cellWidth: 12 },
                            2: { halign: 'right' },
                            3: { halign: 'right' },
                            4: { halign: 'right' }
                        },
                        didParseCell: function (hookData) {
                            if (hookData.section === 'body' && hookData.row.index === tableData.length - 1) {
                                hookData.cell.styles.fillColor = [240, 245, 244];
                                hookData.cell.styles.fontStyle = 'bold';
                            }
                        },
                        margin: { left: 14, right: 14 }
                    });
                } else {
                    let y = 42;
                    doc.setFontSize(9);
                    doc.setFont(undefined, 'bold');
                    doc.setFillColor(15, 184, 154);
                    doc.setTextColor(255);
                    doc.rect(14, y - 5, 182, 7, 'F');
                    doc.text('#', 16, y);
                    doc.text('Livreur', 26, y);
                    doc.text('Colis', 120, y, { align: 'right' });
                    doc.text('Jours', 150, y, { align: 'right' });
                    doc.text('Moy./j', 185, y, { align: 'right' });
                    y += 5;
                    doc.setTextColor(40);
                    doc.setFont(undefined, 'normal');
                    rows.forEach((r, idx) => {
                        if (y > 280) { doc.addPage(); y = 20; }
                        doc.text(String(idx + 1), 16, y);
                        doc.text(String(r.nom || '').substring(0, 38), 26, y);
                        doc.text(String(r.colisLivres), 120, y, { align: 'right' });
                        doc.text(String(r.jours), 150, y, { align: 'right' });
                        doc.text(String(r.jours > 0 ? Math.round(r.colisLivres / r.jours) : 0), 185, y, { align: 'right' });
                        y += 5;
                    });
                }

                const finalY = (doc.lastAutoTable?.finalY || 280) + 10;
                doc.setFontSize(8);
                doc.setFont(undefined, 'italic');
                doc.setTextColor(150);
                doc.text(`Généré le ${new Date().toLocaleDateString('fr-FR')}`, 14, Math.min(finalY, 285));

                doc.save(`suivi_mensuel_${mois}.pdf`);
                showToast(`Suivi ${mois} exporté en PDF`, 'success');
            } catch (e) {
                console.error(e);
                showToast('Erreur export PDF : ' + e.message, 'error');
            }
        }

        // ============== Enregistrement global des paramètres ==============
        function saveAllSettings() {
            const capStd = parseInt(document.getElementById('settingsCapaciteStandard')?.value, 10);
            const capMin = parseInt(document.getElementById('settingsCapaciteMin')?.value, 10);
            const capCible = parseInt(document.getElementById('settingsCapaciteCible')?.value, 10);
            if (!data.paramètres) data.paramètres = {};
            if (!isNaN(capStd) && capStd > 0) data.paramètres.max_colis = capStd;
            if (!isNaN(capMin) && capMin >= 0) data.paramètres.min_colis = capMin;
            if (!isNaN(capCible) && capCible > 0) data.paramètres.cible_colis = capCible;
            data.paramètres.limite_exceptionnelle = data.paramètres.max_colis;

            const tarifPudo = parseFloat(document.getElementById('settingsTarifPudoPenalite')?.value);
            if (!isNaN(tarifPudo) && tarifPudo >= 0) data.tarifPudoPenalite = tarifPudo;

            // v43 : règles complémentaires (appliquées après la grille)
            const bonusAe = parseFloat(document.getElementById('settingsBonusAeVehicule')?.value);
            if (!isNaN(bonusAe) && bonusAe >= 0) data.bonusAeVehicule = bonusAe;
            const seuilPudo = parseFloat(document.getElementById('settingsSeuilPudoPct')?.value);
            if (!isNaN(seuilPudo) && seuilPudo >= 0) data.seuilPudoPct = seuilPudo;
            const seuilAlerte = parseFloat(document.getElementById('settingsSeuilAlerteSousCharge')?.value);
            if (!isNaN(seuilAlerte) && seuilAlerte >= 0) data.seuilAlerteSousCharge = seuilAlerte;

            Object.keys(ONGLETS_LABELS).forEach(key => {
                const cb = document.getElementById(`ongletVisible_${key}`);
                if (cb) {
                    if (!data.ongletsVisibles) data.ongletsVisibles = {};
                    data.ongletsVisibles[key] = key === 'accueil' ? true : cb.checked;
                }
            });

            applyOngletsVisibility();
            saveLocal();
            showToast('Paramètres enregistrés', 'success');
            closeModal('settingsPanel');
        }

        // ============== Pré-remplissage de la modale paramètres ==============
        function preparerSettingsModal() {
            const stdEl = document.getElementById('settingsCapaciteStandard');
            const minEl = document.getElementById('settingsCapaciteMin');
            const cibleEl = document.getElementById('settingsCapaciteCible');
            if (stdEl) stdEl.value = data.paramètres?.max_colis ?? 160;
            if (minEl) minEl.value = data.paramètres?.min_colis ?? 80;
            if (cibleEl) cibleEl.value = data.paramètres?.cible_colis ?? 110;

            const tarifEl = document.getElementById('settingsTarifPudoPenalite');
            if (tarifEl) tarifEl.value = (data.tarifPudoPenalite ?? 0.80).toFixed(2);

            // v43 : règles complémentaires
            const bonusAeEl = document.getElementById('settingsBonusAeVehicule');
            if (bonusAeEl) bonusAeEl.value = (data.bonusAeVehicule ?? 10).toFixed(2);
            const seuilPudoEl = document.getElementById('settingsSeuilPudoPct');
            if (seuilPudoEl) seuilPudoEl.value = (data.seuilPudoPct ?? 3);
            const seuilAlerteEl = document.getElementById('settingsSeuilAlerteSousCharge');
            if (seuilAlerteEl) seuilAlerteEl.value = (data.seuilAlerteSousCharge ?? 70);
            const echo = document.getElementById('seuilAlerteEcho');
            if (echo) echo.textContent = (data.seuilAlerteSousCharge ?? 70);

            const curEl = document.getElementById('settingsCurrentUsername');
            if (curEl) curEl.value = (currentCloudUser && currentCloudUser.email) || '';

            switchSettingsTab('general');
            renderCPExceptionsList();
            renderGrilleSalaireList();
            renderComptesTechniquesList();
            onChangeTypeRegle();
            renderOngletsVisibilityList();
        }

