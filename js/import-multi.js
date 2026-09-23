        // ============== IMPORT MULTI-MÉTHODES ==============
        function switchImportMethod(method) {
            document.querySelectorAll('.import-tab-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.importTab === method);
            });
            document.querySelectorAll('.import-method').forEach(div => {
                div.style.display = (div.id === `importMethod-${method}`) ? 'block' : 'none';
            });
        }

        // Parser format FR_EXP_xxx
        function parserFormatTournees(texte) {
            if (!texte || !texte.trim()) return [];
            const lignes = texte.split(/\r?\n/);
            const tournees = [];
            let courante = null;
            // En-tête avec total (ex: FR_EXP_PARIS049  752) OU sans total (ex: FR_EXP_PARIS049)
            const reEnteteAvecTotal = /^[\s+\-]*([A-Z][A-Z0-9_\-]{3,})\s+(\d{1,6})\s*$/i;
            const reEnteteSansTotal = /^[\s+\-]*([A-Z][A-Z0-9_\-]{3,})\s*$/i;
            const reLigneCP = /^\s*(\d{5})\s+(\d{1,5})\s*$/;
            // Ligne "Grand Total xxx" ou "Total xxx" à ignorer
            const reGrandTotal = /^(grand\s*total|total\s*g[eé]n[eé]ral|total)\s*(\d*)\s*$/i;
            for (const raw of lignes) {
                const ligne = raw.replace(/\t+/g, ' ').trim();
                if (!ligne) continue;
                // Ignorer les lignes Grand Total / Total
                if (reGrandTotal.test(ligne)) continue;
                const mEnteteAvec = ligne.match(reEnteteAvecTotal);
                if (mEnteteAvec && !/^\d{5}\b/.test(ligne)) {
                    if (courante && courante.lignes.length > 0) tournees.push(courante);
                    courante = {
                        tournee: mEnteteAvec[1],
                        totalAnnonce: parseInt(mEnteteAvec[2], 10),
                        lignes: []
                    };
                    continue;
                }
                const mEnteteSans = ligne.match(reEnteteSansTotal);
                if (mEnteteSans && !/^\d{5}\b/.test(ligne)) {
                    if (courante && courante.lignes.length > 0) tournees.push(courante);
                    courante = {
                        tournee: mEnteteSans[1],
                        totalAnnonce: null,
                        lignes: []
                    };
                    continue;
                }
                const mCP = ligne.match(reLigneCP);
                if (mCP) {
                    if (!courante) {
                        courante = { tournee: '(sans nom)', totalAnnonce: null, lignes: [] };
                    }
                    courante.lignes.push({ cp: mCP[1], colis: parseInt(mCP[2], 10) });
                }
            }
            if (courante && courante.lignes.length > 0) tournees.push(courante);
            tournees.forEach(t => {
                t.totalCalcule = t.lignes.reduce((s, l) => s + l.colis, 0);
                t.coherente = (t.totalAnnonce === null) || (t.totalAnnonce === t.totalCalcule);
            });
            return tournees;
        }

        function parseTexteImport() {
            const texte = document.getElementById('importPasteArea').value;
            if (!texte.trim()) {
                showToast('Collez d\'abord du texte dans la zone', 'warning');
                return;
            }
            const tournees = parserFormatTournees(texte);
            if (tournees.length === 0) {
                showToast('Aucune tournée détectée. Vérifiez le format.', 'error');
                return;
            }
            ouvrirModaleSelectionTournees(tournees);
        }

        function ouvrirModaleSelectionTournees(tournees) {
            const modal = document.getElementById('selectionTourneesModal');
            const container = document.getElementById('selectionTourneesList');
            window._tourneesEnAttente = tournees;
            // Construire la liste des livreurs actifs pour le dropdown
            const livreursActifs = (data.livreurs || []).filter(l => l.actif);

            container.innerHTML = tournees.map((t, idx) => {
                const apercu = t.lignes.slice(0, 8).map(l => l.cp).join(', ') + (t.lignes.length > 8 ? '…' : '');
                const totalText = t.totalAnnonce !== null
                    ? (t.coherente
                        ? `<strong>${t.totalCalcule}</strong> colis ✓`
                        : `<strong>${t.totalCalcule}</strong> colis <span class="tournee-coherence-warn">(annoncé : ${t.totalAnnonce})</span>`)
                    : `<strong>${t.totalCalcule}</strong> colis`;

                // Tenter d'auto-suggérer un livreur si le nom de tournée contient une partie du nom
                let suggestedLivreurId = '';
                const tourneeBas = t.tournee.toLowerCase();
                for (const l of livreursActifs) {
                    const nomBas = (l.nom + (l.prenom ? l.prenom : '')).toLowerCase();
                    if (nomBas.length >= 3 && tourneeBas.includes(nomBas.substring(0, Math.min(5, nomBas.length)))) {
                        suggestedLivreurId = l.id;
                        break;
                    }
                }

                const livreurOptions = livreursActifs.length > 0
                    ? `
                        <option value="">— Aucun livreur (juste prévisions) —</option>
                        ${livreursActifs.map(l => `<option value="${escapeHtml(l.id)}" ${l.id === suggestedLivreurId ? 'selected' : ''}>${escapeHtml(l.nom)}${l.prenom ? ' ' + escapeHtml(l.prenom) : ''}</option>`).join('')}
                    `
                    : '<option value="">Aucun livreur disponible (créez-en d\'abord)</option>';

                return `
                    <div class="tournee-card">
                        <input type="checkbox" class="tournee-checkbox" data-idx="${idx}" checked>
                        <div style="flex: 1;">
                            <div class="tournee-card-name"><i class="fas fa-truck-fast"></i>${escapeHtml(t.tournee)}</div>
                            <div class="tournee-card-meta">${t.lignes.length} code(s) postal(aux) · ${totalText}</div>
                            <div class="tournee-card-cps">${escapeHtml(apercu)}</div>
                            <div style="margin-top: 0.65rem; display: flex; gap: 0.5rem; align-items: center;">
                                <label style="font-size: 0.82rem; font-weight: 600; color: var(--text-secondary); white-space: nowrap;">
                                    <i class="fas fa-user"></i> Attribuer à :
                                </label>
                                <select class="tournee-livreur-select form-select" data-idx="${idx}" style="flex: 1; padding: 0.4rem 0.6rem; font-size: 0.85rem;">
                                    ${livreurOptions}
                                </select>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
            const totalGlobal = tournees.reduce((s, t) => s + t.totalCalcule, 0);
            document.getElementById('selectionTourneesTotal').textContent =
                `${tournees.length} tournée(s) détectée(s) · ${totalGlobal} colis au total`;
            const dateEl = document.getElementById('selectionTourneesDate');
            if (dateEl) {
                dateEl.textContent = (typeof formatDateLong === 'function')
                    ? formatDateLong(selectedDate) : selectedDate;
            }
            modal.classList.add('active');
        }

        function fermerModaleSelectionTournees() {
            document.getElementById('selectionTourneesModal').classList.remove('active');
        }

        function toutCocherTournees(state) {
            document.querySelectorAll('.tournee-checkbox').forEach(cb => cb.checked = state);
        }

        function validerImportTournees() {
            const tournees = window._tourneesEnAttente || [];
            const indices = [];
            document.querySelectorAll('.tournee-checkbox').forEach(cb => {
                if (cb.checked) indices.push(parseInt(cb.dataset.idx, 10));
            });
            if (indices.length === 0) {
                showToast('Sélectionnez au moins une tournée', 'warning');
                return;
            }
            const agregat = {};
            const tourneesNoms = [];
            const attributions = [];  // [{livreurId, cps:[]}, ...]

            indices.forEach(i => {
                const t = tournees[i];
                tourneesNoms.push(t.tournee);
                // Récupérer le livreur sélectionné pour cette tournée
                const select = document.querySelector(`.tournee-livreur-select[data-idx="${i}"]`);
                const livreurId = select ? select.value : '';

                const cpsTournee = [];
                t.lignes.forEach(l => {
                    agregat[l.cp] = (agregat[l.cp] || 0) + l.colis;
                    cpsTournee.push(l.cp);
                });
                if (livreurId) {
                    attributions.push({ livreurId, cps: cpsTournee, tourneeNom: t.tournee });
                }
            });
            const nouvellesPrevisions = Object.entries(agregat).map(([cp, colis], idx) => ({
                id: 'p_' + Date.now() + '_' + idx,
                code_postal: cp,
                colis: colis
            }));
            const existantes = data.previsions[selectedDate] || [];
            let strategie = 'replace';
            if (existantes.length > 0) {
                strategie = confirm(
                    `${existantes.length} prévision(s) existent déjà pour le ${selectedDate}.\n\n` +
                    `OK = REMPLACER toutes les prévisions par les nouvelles\n` +
                    `Annuler = FUSIONNER (additionner les colis pour les CP communs)`
                ) ? 'replace' : 'merge';
            }
            if (strategie === 'replace') {
                data.previsions[selectedDate] = nouvellesPrevisions;
            } else {
                const merged = { ...agregat };
                existantes.forEach(p => {
                    merged[p.code_postal] = (merged[p.code_postal] || 0) + p.colis;
                });
                data.previsions[selectedDate] = Object.entries(merged).map(([cp, colis], idx) => ({
                    id: 'p_' + Date.now() + '_' + idx,
                    code_postal: cp,
                    colis: colis
                }));
            }

            // === Appliquer les attributions livreur ↔ tournée ===
            let nbAttributions = 0;
            attributions.forEach(({ livreurId, cps, tourneeNom }) => {
                const livreur = data.livreurs.find(l => l.id === livreurId);
                if (!livreur) return;
                cps.forEach(cp => {
                    // Retirer ce CP de tous les autres livreurs (1 CP = 1 livreur)
                    data.livreurs.forEach(other => {
                        if (other.id !== livreurId) {
                            const idx = other.secteurs_prioritaires.indexOf(cp);
                            if (idx !== -1) other.secteurs_prioritaires.splice(idx, 1);
                        }
                    });
                    if (!livreur.secteurs_prioritaires.includes(cp)) {
                        livreur.secteurs_prioritaires.push(cp);
                        nbAttributions++;
                    }
                });
            });

            saveLocal();
            updateUI();
            fermerModaleSelectionTournees();
            const totalImporte = nouvellesPrevisions.reduce((a, p) => a + p.colis, 0);
            const attributionsMsg = nbAttributions > 0
                ? ` · ${nbAttributions} CP attribués à ${attributions.length} livreur(s)`
                : '';
            showToast(
                `Import : ${tourneesNoms.length} tournée(s), ${nouvellesPrevisions.length} CP, ${totalImporte} colis${attributionsMsg}`,
                'success'
            );
            const txt = document.getElementById('importPasteArea');
            if (txt) txt.value = '';
        }

        function handleImageOcrUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            const status = document.getElementById('ocrStatus');
            status.style.display = 'block';
            status.style.padding = '1rem';
            status.style.background = 'rgba(255, 138, 101, 0.12)';
            status.style.border = '1px solid var(--warning)';
            status.style.borderRadius = 'var(--radius-sm)';
            status.style.color = 'var(--text)';
            status.innerHTML = `
                <strong style="color: var(--warning);"><i class="fas fa-info-circle"></i> OCR pas encore activé.</strong>
                <p style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--text-secondary);">
                    L'OCR (Tesseract.js) ajoute ~5 Mo. Sera activé prochainement.<br>
                    En attendant, utilisez l'onglet <strong>Coller texte</strong> ou <strong>Excel/CSV</strong>.
                </p>
            `;
            event.target.value = '';
        }



