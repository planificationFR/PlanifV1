        // ============== FACTURE ==============
        // ============== FACTURE ==============
        function switchFactureSection(section) {
            const isPreview = section === 'preview';
            document.getElementById('factureSectionEdit').style.display = isPreview ? 'none' : 'block';
            document.getElementById('factureSectionPreview').style.display = isPreview ? 'block' : 'none';
            document.getElementById('btnSectionEdit').classList.toggle('active', !isPreview);
            document.getElementById('btnSectionPreview').classList.toggle('active', isPreview);
            document.getElementById('btnRetourEdit').style.display = isPreview ? 'inline-flex' : 'none';
            document.getElementById('btnExportPDF').style.display = isPreview ? 'inline-flex' : 'none';
            document.getElementById('btnPrintFacture').style.display = isPreview ? 'inline-flex' : 'none';
        }

        function recalculerNetFacture() {
            const brut = parseFloat(document.getElementById('fe_montant').value) || 0;
            const gasoil = parseFloat(document.getElementById('fe_gasoil').value) || 0;
            const penalites = parseFloat(document.getElementById('fe_penalites').value) || 0;
            const fraisDivers = parseFloat(document.getElementById('fe_fraisDivers')?.value) || 0;
            const fraisAvancesT = (getFraisLivreur(selectedHistoriqueMonth, window._currentFactureLivreur || '') || [])
                .reduce((s, f) => s + (parseFloat(f.montant) || 0), 0);
            const tvaTaux = parseFloat(document.getElementById('fe_tvaTaux')?.value) || 0;
            // Net = brut − gasoil − pénalités + frais divers + frais avancés
            const net = brut - gasoil - penalites + fraisDivers + fraisAvancesT;
            const totalTTC = net * (1 + tvaTaux / 100);
            document.getElementById('fe_netAPayer').value = net.toFixed(2);
            const ttcEl = document.getElementById('fe_totalTTC');
            if (ttcEl) ttcEl.value = totalTTC.toFixed(2);
        }

        function générérFacture(livreurName) {
            // v44 — facture établie sur les colis rémunérables (transferts inclus)
            const _moisFacture = appliquerTransfertsMois(
                data.historiqueEPOD?.[selectedHistoriqueMonth] || {}, selectedHistoriqueMonth);
            const monthData = _moisFacture[livreurName];
            if (!monthData) { showToast('Aucune donnée pour ce livreur', 'error'); return; }
            // Mémoriser le livreur courant pour intégrer ses frais avancés dans la facture
            window._currentFactureLivreur = livreurName;

            const livreurConfig = (typeof matchLivreur === 'function' && matchLivreur(livreurName))
                || { contrat: 'auto-entrepreneur', taux: 1.4, nom: livreurName };

            // Utilise calculerSalaireMensuel pour respecter la règle PUDO 3%
            const calc = calculerSalaireMensuel(monthData, livreurConfig);
            const salaire = calc.salaire;

            const [year, month] = selectedHistoriqueMonth.split('-');
            const monthNames = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
            const monthName = monthNames[parseInt(month) - 1];

            // Récupérer le dernier numéro utilisé
            const lastNum = parseInt(localStorage.getItem('planif_last_facture_num') || '0') + 1;

            // Pré-remplir le formulaire
            document.getElementById('fe_emetteurNom').value = localStorage.getItem('planif_fe_emetteurNom') || '';
            document.getElementById('fe_emetteurAdresse').value = localStorage.getItem('planif_fe_emetteurAdresse') || '';
            document.getElementById('fe_emetteurVille').value = localStorage.getItem('planif_fe_emetteurVille') || '';
            document.getElementById('fe_emetteurPays').value = localStorage.getItem('planif_fe_emetteurPays') || 'FR';
            document.getElementById('fe_siren').value = localStorage.getItem('planif_fe_siren') || '';
            document.getElementById('fe_tva').value = localStorage.getItem('planif_fe_tva') || '';
            document.getElementById('fe_iban').value = localStorage.getItem('planif_fe_iban') || '';
            document.getElementById('fe_destNom').value = localStorage.getItem('planif_fe_destNom') || '';
            document.getElementById('fe_destAdresse').value = localStorage.getItem('planif_fe_destAdresse') || '';
            document.getElementById('fe_destVille').value = localStorage.getItem('planif_fe_destVille') || '';
            document.getElementById('fe_destPays').value = localStorage.getItem('planif_fe_destPays') || 'France';
            document.getElementById('fe_numero').value = `N°${String(lastNum).padStart(2,'0')}`;
            document.getElementById('fe_dateEmission').value = new Date().toISOString().split('T')[0];
            document.getElementById('fe_designation').value = `Livraison Petits Colis – ${monthName} ${year}`;
            document.getElementById('fe_montant').value = salaire.toFixed(2);

            // Pré-remplissage gasoil + pénalités depuis localStorage (par livreur+mois)
            const deducKey = `planif_deduc_${livreurName.replace(/\s+/g, '_')}_${selectedHistoriqueMonth}`;
            const lastDeduc = JSON.parse(localStorage.getItem(deducKey) || '{}');
            document.getElementById('fe_gasoil').value = lastDeduc.gasoil || 0;
            document.getElementById('fe_penalites').value = lastDeduc.penalites || 0;
            const fraisDiversEl = document.getElementById('fe_fraisDivers');
            if (fraisDiversEl) fraisDiversEl.value = lastDeduc.fraisDivers || 0;

            // Taux TVA : sauvegardé globalement (pas par livreur)
            const tvaTauxEl = document.getElementById('fe_tvaTaux');
            if (tvaTauxEl) {
                tvaTauxEl.value = localStorage.getItem('planif_fe_tvaTaux') || '0';
            }

            recalculerNetFacture();  // initialise le net affiché

            // Stocker la clé pour la sauvegarde au moment du rendu
            window._currentDeducKey = deducKey;

            document.getElementById('fe_reglement').value = 'À réception';
            document.getElementById('fe_type').value = 'facture';
            document.getElementById('fe_filigrane').value = '';

            switchFactureSection('edit');
            openModal('facture');
        }

        function renderFactureFromForm() {
            // Sauvegarder les infos émetteur/destinataire pour la prochaine fois
            ['emetteurNom','emetteurAdresse','emetteurVille','emetteurPays','siren','tva','iban','destNom','destAdresse','destVille','destPays'].forEach(k => {
                localStorage.setItem(`planif_fe_${k}`, document.getElementById(`fe_${k}`).value);
            });
            // Sauvegarder le taux TVA séparément (réutilisé pour toutes les factures)
            const tvaTauxEl = document.getElementById('fe_tvaTaux');
            if (tvaTauxEl) localStorage.setItem('planif_fe_tvaTaux', tvaTauxEl.value);

            const type = document.getElementById('fe_type').value;
            const isAvoir = type === 'avoir';
            const brutRaw = parseFloat(document.getElementById('fe_montant').value) || 0;
            const gasoilRaw = parseFloat(document.getElementById('fe_gasoil').value) || 0;
            const penalitesRaw = parseFloat(document.getElementById('fe_penalites').value) || 0;
            const fraisDiversRaw = parseFloat(document.getElementById('fe_fraisDivers')?.value) || 0;
            // Frais avancés par le livreur (gasoil, adblue, huile, pneu…) → ajoutés au total, détaillés
            const fraisAvances = getFraisLivreur(selectedHistoriqueMonth, window._currentFactureLivreur || '');
            const fraisAvancesTotal = Math.round(fraisAvances.reduce((s, f) => s + (parseFloat(f.montant) || 0), 0) * 100) / 100;
            const tvaTaux = parseFloat(tvaTauxEl?.value) || 0;
            const totalRemise = gasoilRaw + penalitesRaw;  // somme des déductions = REMISE
            const totalHT = brutRaw - totalRemise + fraisDiversRaw + fraisAvancesTotal;  // net avant TVA (frais inclus)
            const tvaMontant = totalHT * tvaTaux / 100;
            const totalTTC = totalHT + tvaMontant;

            const sign = isAvoir ? -1 : 1;
            const fmt = v => (sign * v).toLocaleString('fr-FR', {minimumFractionDigits: 2, maximumFractionDigits: 2});
            const brutStr = brutRaw.toLocaleString('fr-FR', {minimumFractionDigits: 2, maximumFractionDigits: 2});
            const remiseStr = totalRemise > 0 ? totalRemise.toLocaleString('fr-FR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '-';
            const fraisDiversStr = fraisDiversRaw.toLocaleString('fr-FR', {minimumFractionDigits: 2, maximumFractionDigits: 2});
            const totalHTStr = fmt(totalHT);
            const tvaStr = fmt(tvaMontant);
            const totalTTCStr = fmt(totalTTC);
            const filigrane = document.getElementById('fe_filigrane').value;

            // Sauvegarder gasoil/pénalités/frais divers pour pré-remplissage la prochaine fois
            if (window._currentDeducKey) {
                localStorage.setItem(window._currentDeducKey, JSON.stringify({
                    gasoil: gasoilRaw,
                    penalites: penalitesRaw,
                    fraisDivers: fraisDiversRaw
                }));
            }

            const emetteurNom = document.getElementById('fe_emetteurNom').value;
            const emetteurAdresse = document.getElementById('fe_emetteurAdresse').value;
            const emetteurVille = document.getElementById('fe_emetteurVille').value;
            const emetteurPays = document.getElementById('fe_emetteurPays').value;
            const siren = document.getElementById('fe_siren').value;
            const tvaNum = document.getElementById('fe_tva').value;
            const iban = document.getElementById('fe_iban').value;
            const destNom = document.getElementById('fe_destNom').value;
            const destAdresse = document.getElementById('fe_destAdresse').value;
            const destVille = document.getElementById('fe_destVille').value;
            const destPays = document.getElementById('fe_destPays').value;
            const numero = document.getElementById('fe_numero').value;
            const dateRaw = document.getElementById('fe_dateEmission').value;
            const dateObj = dateRaw ? new Date(dateRaw) : new Date();
            const dateEmission = dateObj.toLocaleDateString('fr-FR');
            // Échéance = date émission + 30 jours par défaut
            const dateEcheance = new Date(dateObj.getTime() + 30 * 86400000).toLocaleDateString('fr-FR');
            const reglement = document.getElementById('fe_reglement').value;
            const designation = document.getElementById('fe_designation').value;

            // Incrémenter le compteur
            const numMatch = numero.match(/\d+/);
            if (numMatch) localStorage.setItem('planif_last_facture_num', String(parseInt(numMatch[0])));

            const titreDoc = isAvoir ? 'AVOIR' : 'FACTURE';
            // Initiales pour le logo (2 premiers caractères du nom émetteur)
            const initiales = emetteurNom.split(/\s+/)
                .map(w => w.replace(/[^A-Za-zÀ-ÿ]/g, '')[0])
                .filter(Boolean)
                .slice(0, 2)
                .join('')
                .toUpperCase() || 'EI';

            const html = `
            <div class="facture-container fnew" id="factureDocument" style="position:relative;background:#fff;padding:0;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;width:100%;max-width:780px;margin:0 auto;box-shadow:0 4px 16px rgba(0,0,0,0.08);overflow:hidden;">

                ${filigrane ? `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:140px;color:rgba(0,0,0,0.05);font-weight:900;letter-spacing:0.1em;pointer-events:none;z-index:1;white-space:nowrap;">${escapeHtml(filigrane)}</div>` : ''}

                <!-- Vague noire en haut -->
                <svg viewBox="0 0 780 130" preserveAspectRatio="none" style="display:block;width:100%;height:130px;">
                    <path d="M0,0 L780,0 L780,90 Q585,140 390,90 Q195,40 0,90 Z" fill="#1a1a1a"/>
                </svg>

                <!-- Logo (initiales) -->
                <div style="position:absolute;top:30px;left:48px;width:54px;height:54px;background:#1a1a1a;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px;letter-spacing:1px;font-style:italic;box-shadow:0 2px 6px rgba(0,0,0,0.3);">${escapeHtml(initiales)}</div>

                <div style="padding:20px 48px 48px 48px;position:relative;z-index:2;">

                    <!-- Titre + dates -->
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;">
                        <h1 style="font-size:78px;font-weight:900;letter-spacing:-2px;line-height:0.95;margin:0;color:#1a1a1a;">${titreDoc}</h1>
                        <div style="text-align:right;font-size:13px;line-height:1.7;font-weight:700;color:#1a1a1a;margin-top:18px;">
                            <div>DATE : ${dateEmission.replace(/\//g, ' / ')}</div>
                            <div>ÉCHÉANCE : ${dateEcheance.replace(/\//g, ' / ')}</div>
                            <div style="margin-top:18px;font-size:15px;">${titreDoc} N° : ${escapeHtml(numero.replace(/^N°/i, '').trim())}</div>
                        </div>
                    </div>

                    <hr style="border:none;border-top:1px solid #1a1a1a;margin:0 0 22px 0;">

                    <!-- Émetteur / Destinataire -->
                    <div style="display:flex;justify-content:space-between;margin-bottom:48px;font-size:13px;line-height:1.6;">
                        <div>
                            <div style="font-weight:700;margin-bottom:10px;">ÉMETTEUR :</div>
                            <div style="font-weight:700;">${escapeHtml(emetteurNom)}</div>
                            <div>${escapeHtml(emetteurAdresse)}</div>
                            <div>${escapeHtml(emetteurVille)}</div>
                            <div>${escapeHtml(emetteurPays)}</div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-weight:700;margin-bottom:10px;">DESTINATAIRE :</div>
                            <div style="font-weight:700;">${escapeHtml(destNom)}</div>
                            <div>${escapeHtml(destAdresse)}</div>
                            <div>${escapeHtml(destVille)}&nbsp;&nbsp;&nbsp;${escapeHtml(destPays.toUpperCase())}</div>
                            <div>${escapeHtml(destPays)}</div>
                        </div>
                    </div>

                    <!-- Tableau prestations -->
                    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px;">
                        <thead>
                            <tr style="border-bottom:1px solid #1a1a1a;">
                                <th style="text-align:left;padding:12px 8px;font-weight:700;width:78%;">Description :</th>
                                <th style="text-align:right;padding:12px 8px;font-weight:700;width:22%;">Total :</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr style="border-bottom:1px solid #d9d9d9;">
                                <td style="padding:14px 8px;">${escapeHtml(designation)}</td>
                                <td style="text-align:right;padding:14px 8px;">${brutStr}€</td>
                            </tr>
                            ${gasoilRaw > 0 ? `
                            <tr style="border-bottom:1px solid #d9d9d9;color:#666;">
                                <td style="padding:14px 8px;">— Gasoil consommé (déduction)</td>
                                <td style="text-align:right;padding:14px 8px;color:#c73838;">−${gasoilRaw.toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})}€</td>
                            </tr>` : ''}
                            ${penalitesRaw > 0 ? `
                            <tr style="border-bottom:1px solid #d9d9d9;color:#666;">
                                <td style="padding:14px 8px;">— Pénalités (déduction)</td>
                                <td style="text-align:right;padding:14px 8px;color:#c73838;">−${penalitesRaw.toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})}€</td>
                            </tr>` : ''}
                            ${fraisDiversRaw > 0 ? `
                            <tr style="border-bottom:1px solid #d9d9d9;">
                                <td style="padding:14px 8px;">+ Frais divers</td>
                                <td style="text-align:right;padding:14px 8px;">+${fraisDiversStr}€</td>
                            </tr>` : ''}
                            ${fraisAvances.map(f => `
                            <tr style="border-bottom:1px solid #d9d9d9;">
                                <td style="padding:14px 8px;">+ Frais avancé — ${escapeHtml(f.categorie)}${f.note ? ' (' + escapeHtml(f.note) + ')' : ''}</td>
                                <td style="text-align:right;padding:14px 8px;">+${(parseFloat(f.montant) || 0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})}€</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>

                    <!-- Bloc règlement (gauche) + Totaux (droite) -->
                    <div style="display:flex;justify-content:space-between;gap:32px;margin-top:40px;">
                        <div style="flex:1;font-size:13px;line-height:1.7;">
                            <div style="font-size:18px;font-weight:700;margin-bottom:10px;">RÈGLEMENT :</div>
                            ${iban && iban.trim() ? `
                                <div style="font-weight:700;margin-bottom:6px;">Par virement bancaire :</div>
                                <div>IBAN : ${escapeHtml(iban)}</div>
                            ` : `
                                <div>${escapeHtml(reglement)}</div>
                            `}
                        </div>
                        <div style="min-width:280px;font-size:14px;">
                            <div style="display:flex;justify-content:space-between;padding:8px 0;font-weight:700;font-size:16px;">
                                <span>TOTAL HT :</span>
                                <span>${totalHTStr}€</span>
                            </div>
                            <div style="display:flex;justify-content:space-between;padding:8px 0;font-weight:700;font-size:16px;">
                                <span>TVA ${tvaTaux > 0 ? tvaTaux.toFixed(tvaTaux % 1 === 0 ? 0 : 1) + '%' : '0%'} :</span>
                                <span>${tvaStr}€</span>
                            </div>
                            <div style="display:flex;justify-content:space-between;padding:8px 0;font-weight:700;font-size:16px;">
                                <span>REMISE :</span>
                                <span>${totalRemise > 0 ? '-' + remiseStr + '€' : '-'}</span>
                            </div>
                            <div style="display:flex;justify-content:space-between;padding:14px 0 8px 0;border-top:1px solid #1a1a1a;margin-top:8px;font-weight:900;font-size:20px;">
                                <span>TOTAL TTC :</span>
                                <span>${totalTTCStr}€</span>
                            </div>
                        </div>
                    </div>

                    <!-- Mentions légales -->
                    <div style="margin-top:48px;font-size:11px;color:#666;line-height:1.5;">
                        En cas de retard de paiement, et conformément au code de commerce, une indemnité calculée à trois fois le taux d'intérêt légal ainsi qu'un frais de recouvrement de 40 euros sont exigibles.
                        ${tvaTaux === 0 ? '<br><br>TVA non applicable, art. 293 B du CGI' : ''}
                        <br><br>SIREN : ${escapeHtml(siren)}${tvaNum ? ' · TVA intracommunautaire : ' + escapeHtml(tvaNum) : ''}
                    </div>
                </div>

                <!-- Vague basse en bleu pâle -->
                <div style="background:#cbd9d3;height:60px;position:relative;margin-top:20px;">
                    <svg viewBox="0 0 780 60" preserveAspectRatio="none" style="position:absolute;top:-1px;left:0;width:100%;height:30px;">
                        <path d="M0,30 Q195,0 390,15 Q585,30 780,5 L780,30 L0,30 Z" fill="#cbd9d3"/>
                    </svg>
                </div>
            </div>`;

            document.getElementById('factureContent').innerHTML = html;
        }

        function printFacture() {
            window.print();
        }

        async function exportFacturePDF() {
            await ensureJsPDF();
            if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') {
                showToast('jsPDF non chargé - utilisez Imprimer', 'warning');
                return;
            }
            const { jsPDF } = window.jspdf || { jsPDF: window.jsPDF };
            const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

            // === Récupération des données ===
            const get = id => document.getElementById(id)?.value || '';
            const isAvoir = get('fe_type') === 'avoir';
            const brutRaw = parseFloat(get('fe_montant')) || 0;
            const gasoilRaw = parseFloat(get('fe_gasoil')) || 0;
            const penalitesRaw = parseFloat(get('fe_penalites')) || 0;
            const fraisDiversRaw = parseFloat(get('fe_fraisDivers')) || 0;
            const fraisAvances = getFraisLivreur(selectedHistoriqueMonth, window._currentFactureLivreur || '');
            const fraisAvancesTotal = Math.round(fraisAvances.reduce((s, f) => s + (parseFloat(f.montant) || 0), 0) * 100) / 100;
            const tvaTaux = parseFloat(get('fe_tvaTaux')) || 0;
            const totalRemise = gasoilRaw + penalitesRaw;
            const totalHT = brutRaw - totalRemise + fraisDiversRaw + fraisAvancesTotal;
            const tvaMontant = totalHT * tvaTaux / 100;
            const totalTTC = totalHT + tvaMontant;
            const sign = isAvoir ? -1 : 1;

            const numero = get('fe_numero');
            const numeroClean = numero.replace(/^N°/i, '').trim() || '001';
            const dateRaw = get('fe_dateEmission');
            const dateObj = dateRaw ? new Date(dateRaw) : new Date();
            const dateEmission = dateObj.toLocaleDateString('fr-FR').replace(/\//g, ' / ');
            const dateEcheance = new Date(dateObj.getTime() + 30 * 86400000).toLocaleDateString('fr-FR').replace(/\//g, ' / ');
            const reglement = get('fe_reglement');
            const designation = get('fe_designation');
            const emetteurNom = get('fe_emetteurNom');
            const emetteurAdresse = get('fe_emetteurAdresse');
            const emetteurVille = get('fe_emetteurVille');
            const emetteurPays = get('fe_emetteurPays');
            const siren = get('fe_siren');
            const tvaNum = get('fe_tva');
            const iban = get('fe_iban');
            const destNom = get('fe_destNom');
            const destAdresse = get('fe_destAdresse');
            const destVille = get('fe_destVille');
            const destPays = get('fe_destPays');
            const filigrane = get('fe_filigrane');

            // Initiales pour le logo
            const initiales = emetteurNom.split(/\s+/)
                .map(w => (w.replace(/[^A-Za-zÀ-ÿ]/g, '')[0] || ''))
                .filter(Boolean)
                .slice(0, 2)
                .join('')
                .toUpperCase() || 'EI';

            // Helpers : on n'utilise PAS toLocaleString('fr-FR') car elle introduit
            // un espace insécable étroit (U+202F) que la police Helvetica de jsPDF
            // ne sait pas afficher (rendu en "/" ou caractère bizarre).
            // À la place : séparateur de milliers = espace simple, décimale = virgule.
            const formatMontant = (v) => {
                const n = Number(v) || 0;
                const neg = n < 0;
                const abs = Math.abs(n);
                const fixed = abs.toFixed(2);             // "1234.56"
                const [intPart, decPart] = fixed.split('.');
                // Espacer les milliers par un espace ASCII simple (U+0020), compatible Helvetica
                const intWithSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
                return (neg ? '-' : '') + intWithSep + ',' + decPart;
            };
            const fmt = v => formatMontant(sign * v);
            const fmtPos = v => formatMontant(v);

            // Dimensions A4
            const pageW = 210;
            const pageH = 297;
            const marginX = 15;

            // === FILIGRANE diagonal ===
            if (filigrane) {
                doc.setFontSize(72);
                doc.setTextColor(245, 245, 245);
                doc.setFont('helvetica', 'bold');
                doc.text(filigrane, pageW / 2, pageH / 2, { align: 'center', angle: 30 });
            }

            // === VAGUE NOIRE EN HAUT ===
            // Rectangle noir + courbes pour simuler la vague (jsPDF a triangle/lines/curves)
            doc.setFillColor(26, 26, 26);
            doc.rect(0, 0, pageW, 18, 'F');
            // Vague descendante : 2 courbes Bézier successives
            // Approximation simple via une série de petits triangles
            doc.lines([
                [pageW * 0.5, 12, pageW * 0.5, 0, pageW, -8],  // courbe Bézier
            ], 0, 18, [1, 1], 'F', false);
            // Plus simple : remplir un trapèze sous le rectangle
            doc.setFillColor(26, 26, 26);
            // Triangle gauche (vague descendante)
            doc.triangle(0, 18, pageW / 2, 18, pageW / 2, 26, 'F');
            // Triangle droit (vague remontante)
            doc.triangle(pageW / 2, 26, pageW, 18, pageW / 2, 18, 'F');

            // === LOGO (cercle noir avec initiales) ===
            const logoX = marginX + 8;
            const logoY = 36;
            doc.setFillColor(26, 26, 26);
            doc.circle(logoX, logoY, 7, 'F');
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(11);
            doc.setTextColor(255, 255, 255);
            doc.text(initiales, logoX, logoY + 1.5, { align: 'center' });

            // === TITRE FACTURE en gros ===
            const titreDoc = isAvoir ? 'AVOIR' : 'FACTURE';
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(48);
            doc.setTextColor(26, 26, 26);
            doc.text(titreDoc, marginX, 70);

            // === BLOC DATES (à droite) ===
            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(26, 26, 26);
            doc.text(`DATE : ${dateEmission}`, pageW - marginX, 50, { align: 'right' });
            doc.text(`ÉCHÉANCE : ${dateEcheance}`, pageW - marginX, 55, { align: 'right' });
            doc.setFontSize(11);
            doc.text(`${titreDoc} N° : ${numeroClean}`, pageW - marginX, 65, { align: 'right' });

            // Ligne séparatrice horizontale
            doc.setDrawColor(26, 26, 26);
            doc.setLineWidth(0.4);
            doc.line(marginX, 78, pageW - marginX, 78);

            // === ÉMETTEUR / DESTINATAIRE ===
            let y = 86;
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.setTextColor(26, 26, 26);
            doc.text('ÉMETTEUR :', marginX, y);
            doc.text('DESTINATAIRE :', pageW - marginX, y, { align: 'right' });

            y += 6;
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.text(emetteurNom, marginX, y);
            doc.text(destNom, pageW - marginX, y, { align: 'right' });

            y += 5;
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9);
            doc.setTextColor(60, 60, 60);
            doc.text(emetteurAdresse, marginX, y);
            doc.text(destAdresse, pageW - marginX, y, { align: 'right' });

            y += 5;
            doc.text(emetteurVille, marginX, y);
            doc.text(`${destVille}    ${(destPays || '').toUpperCase()}`, pageW - marginX, y, { align: 'right' });

            y += 5;
            doc.text(emetteurPays, marginX, y);
            doc.text(destPays, pageW - marginX, y, { align: 'right' });

            // === TABLEAU PRESTATIONS ===
            y = 130;
            // Header
            doc.setDrawColor(26, 26, 26);
            doc.setLineWidth(0.4);
            doc.line(marginX, y + 5, pageW - marginX, y + 5);

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.setTextColor(26, 26, 26);
            doc.text('Description :', marginX, y);
            doc.text('Total :', pageW - marginX, y, { align: 'right' });

            y += 13;

            // Ligne désignation principale (sans Prix Unitaire ni Quantité)
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(10);
            doc.setTextColor(26, 26, 26);
            doc.text(designation, marginX, y);
            doc.setFont('helvetica', 'bold');
            doc.text(`${fmtPos(brutRaw)}€`, pageW - marginX, y, { align: 'right' });

            // Trait fin sous chaque ligne
            doc.setDrawColor(217, 217, 217);
            doc.setLineWidth(0.2);
            doc.line(marginX, y + 4, pageW - marginX, y + 4);
            y += 11;

            // Lignes déductions
            if (gasoilRaw > 0) {
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(9.5);
                doc.setTextColor(110, 110, 110);
                doc.text('— Gasoil consommé (déduction)', marginX, y);
                doc.setTextColor(199, 56, 56);
                doc.setFont('helvetica', 'bold');
                doc.text(`-${fmtPos(gasoilRaw)}€`, pageW - marginX, y, { align: 'right' });
                doc.setDrawColor(217, 217, 217);
                doc.line(marginX, y + 4, pageW - marginX, y + 4);
                y += 10;
            }
            if (penalitesRaw > 0) {
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(9.5);
                doc.setTextColor(110, 110, 110);
                doc.text('— Pénalités (déduction)', marginX, y);
                doc.setTextColor(199, 56, 56);
                doc.setFont('helvetica', 'bold');
                doc.text(`-${fmtPos(penalitesRaw)}€`, pageW - marginX, y, { align: 'right' });
                doc.setDrawColor(217, 217, 217);
                doc.line(marginX, y + 4, pageW - marginX, y + 4);
                y += 10;
            }
            if (fraisDiversRaw > 0) {
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(9.5);
                doc.setTextColor(60, 60, 60);
                doc.text('+ Frais divers', marginX, y);
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(26, 26, 26);
                doc.text(`+${fmtPos(fraisDiversRaw)}€`, pageW - marginX, y, { align: 'right' });
                doc.setDrawColor(217, 217, 217);
                doc.line(marginX, y + 4, pageW - marginX, y + 4);
                y += 10;
            }
            // Lignes détaillées des frais avancés par le livreur
            fraisAvances.forEach(f => {
                const montant = parseFloat(f.montant) || 0;
                let label = `+ Frais avancé - ${f.categorie}`;
                if (f.note) label += ` (${f.note})`;
                label = doc.splitTextToSize(label, pageW - 2 * marginX - 30)[0];
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(9.5);
                doc.setTextColor(60, 60, 60);
                doc.text(label, marginX, y);
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(26, 26, 26);
                doc.text(`+${fmtPos(montant)}€`, pageW - marginX, y, { align: 'right' });
                doc.setDrawColor(217, 217, 217);
                doc.line(marginX, y + 4, pageW - marginX, y + 4);
                y += 10;
            });

            // === BLOC RÈGLEMENT (gauche) + TOTAUX (droite) ===
            y = 200;

            // RÈGLEMENT
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(13);
            doc.setTextColor(26, 26, 26);
            doc.text('RÈGLEMENT :', marginX, y);

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.text('Par virement bancaire :', marginX, y + 8);

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9);
            doc.setTextColor(60, 60, 60);
            if (iban && iban.trim()) {
                doc.text(`IBAN : ${iban}`, marginX, y + 14);
            } else {
                doc.text(reglement || 'À réception', marginX, y + 14);
            }

            // TOTAUX (à droite)
            const totRightX = pageW - marginX;
            const totLabelX = pageW - marginX - 70;
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(12);
            doc.setTextColor(26, 26, 26);

            doc.text('TOTAL HT :', totLabelX, y, { align: 'left' });
            doc.text(`${fmt(totalHT)}€`, totRightX, y, { align: 'right' });

            doc.text(`TVA ${tvaTaux % 1 === 0 ? tvaTaux.toFixed(0) : tvaTaux.toFixed(1)}% :`, totLabelX, y + 8, { align: 'left' });
            doc.text(`${fmt(tvaMontant)}€`, totRightX, y + 8, { align: 'right' });

            doc.text('REMISE :', totLabelX, y + 16, { align: 'left' });
            doc.text(totalRemise > 0 ? `-${fmtPos(totalRemise)}€` : '-', totRightX, y + 16, { align: 'right' });

            // Trait avant total TTC
            doc.setDrawColor(26, 26, 26);
            doc.setLineWidth(0.4);
            doc.line(totLabelX - 5, y + 21, totRightX, y + 21);

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(15);
            doc.text('TOTAL TTC :', totLabelX, y + 28, { align: 'left' });
            doc.text(`${fmt(totalTTC)}€`, totRightX, y + 28, { align: 'right' });

            // === MENTIONS LÉGALES ===
            y = 245;
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(110, 110, 110);
            const mentionLegale = "En cas de retard de paiement, et conformément au code de commerce, une indemnité calculée à trois fois le taux d'intérêt légal ainsi qu'un frais de recouvrement de 40 euros sont exigibles.";
            const mentionLines = doc.splitTextToSize(mentionLegale, pageW - 2 * marginX);
            doc.text(mentionLines, marginX, y);

            y += mentionLines.length * 3.5 + 4;
            if (tvaTaux === 0) {
                doc.text("TVA non applicable, art. 293 B du CGI", marginX, y);
                y += 4;
            }

            y += 2;
            doc.setFontSize(7.5);
            doc.text(`SIREN : ${siren}${tvaNum ? '  ·  TVA intracommunautaire : ' + tvaNum : ''}`, marginX, y);

            // === BANDEAU BAS BLEU PÂLE ===
            doc.setFillColor(203, 217, 211);
            doc.rect(0, pageH - 18, pageW, 18, 'F');
            // Petite vague en haut du bandeau
            doc.setFillColor(203, 217, 211);
            doc.triangle(0, pageH - 18, pageW / 2, pageH - 18, pageW / 2, pageH - 23, 'F');
            doc.triangle(pageW / 2, pageH - 23, pageW, pageH - 18, pageW / 2, pageH - 18, 'F');

            // === EXPORT ===
            const filename = `${isAvoir ? 'Avoir' : 'Facture'}_${numeroClean.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;
            doc.save(filename);
            showToast('PDF exporté avec succès', 'success');
        }

