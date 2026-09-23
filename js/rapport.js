        // ============== RAPPORT ==============
        function getSecteurColor(codePostal) {
            if (ZONES_COULEURS.rouge.includes(codePostal)) return 'rouge';
            if (ZONES_COULEURS.vert.includes(codePostal)) return 'vert';
            return 'bleu';
        }

        function generateRapport() {
            const prevs = data.previsions[selectedDate] || [];
            const prevsMap = {};
            prevs.forEach(p => prevsMap[p.code_postal] = p.colis);
            const livreursActifs = data.livreurs.filter(l => l.actif);
            updateRapportDate();

            let totalColis = 0, sous90 = 0, auDessus160 = 0;
            const rapportData = livreursActifs.map(livreur => {
                const secteurs = livreur.secteurs_prioritaires;
                const secteursAvecColis = secteurs.map(s => ({ code: s, colis: prevsMap[s] || 0 }));
                const total = secteursAvecColis.reduce((acc, s) => acc + s.colis, 0);
                totalColis += total;
                if (total > 0 && total < 90) sous90++;
                if (total > 160) auDessus160++;
                return {
                    id: livreur.id,
                    nom: livreur.nom,
                    prenom: livreur.prenom || '',
                    contrat: livreur.contrat,
                    taux: livreur.taux,
                    secteurs: secteursAvecColis,
                    totalColis: total
                };
            });

            const livreursAvecColis = rapportData.filter(l => l.totalColis > 0).length;
            const moyenne = livreursAvecColis > 0 ? Math.round(totalColis / livreursAvecColis) : 0;

            document.getElementById('statTotalColis').textContent = totalColis;
            document.getElementById('statLivreurs').textContent = livreursActifs.length;
            document.getElementById('statMoyenne').textContent = moyenne;
            document.getElementById('statSous90').textContent = sous90;
            document.getElementById('statAuDessus160').textContent = auDessus160;

            // Tri : ceux avec colis en premier, par nb de colis desc
            rapportData.sort((a, b) => b.totalColis - a.totalColis);

            const cible = data.paramètres?.cible_colis || 110;
            const max = data.paramètres?.max_colis || 160;

            document.getElementById('rapportCardsGrid').className = 'rapport-cards-grid';
            document.getElementById('rapportCardsGrid').innerHTML = rapportData.map((livreur, idx) => {
                const livreurColor = getLivreurColor(livreur.id);
                const total = livreur.totalColis;
                let statusClass = '';
                let chargeFillClass = '';
                if (total === 0) { statusClass = 'empty'; }
                else if (total > max) { statusClass = 'warning'; chargeFillClass = 'danger'; }
                else if (total >= cible) { statusClass = 'optimal'; }
                else if (total < 90) { statusClass = 'warning'; chargeFillClass = 'warning'; }

                const chargePercent = Math.min(100, Math.round((total / max) * 100));
                const initiale = (livreur.nom[0] || '?').toUpperCase();

                // Tri secteurs par colis desc
                const secteursTries = [...livreur.secteurs].sort((a, b) => b.colis - a.colis);

                const secteursHtml = secteursTries.length === 0
                    ? '<div style="grid-column: 1 / -1; text-align: center; color: var(--text-secondary); padding: 1rem; font-size: 0.85rem;">Aucun secteur assigné</div>'
                    : secteursTries.map(s => `
                        <div class="rapport-secteur-box ${s.colis === 0 ? 'empty' : ''}" style="border-left: 4px solid ${livreurColor};">
                            <div class="rapport-secteur-cp" style="color: ${livreurColor};">${escapeHtml(s.code)}</div>
                            <div class="rapport-secteur-colis">${escapeHtml(s.colis)} colis</div>
                        </div>
                    `).join('');

                const useGrilleEst = (livreur.contrat === 'salarie' || livreur.contrat === 'autoentrepreneur-vehicule');
                const tauxLabel = useGrilleEst ? '/h' : '/colis';
                const salaireEstime = useGrilleEst
                    ? null  // Salarié ou AE-véhicule : on ne calcule pas de salaire estimé sur les colis
                    : (total * livreur.taux).toFixed(2);

                return `
                    <div class="rapport-livreur-card ${statusClass}" style="animation-delay: ${idx * 0.05}s;">
                        <div class="rapport-card-top">
                            <div class="rapport-card-avatar" style="background: ${livreurColor};">${escapeHtml(initiale)}</div>
                            <div class="rapport-card-identity">
                                <div class="rapport-card-name">${escapeHtml(livreur.nom)}${livreur.prenom ? ' ' + escapeHtml(livreur.prenom) : ''}</div>
                                <div class="rapport-card-meta">${livreur.contrat === 'salarie' ? 'Salarié' : (livreur.contrat === 'autoentrepreneur-vehicule' ? 'AE véhicule entreprise' : 'Auto-entrepreneur')}</div>
                            </div>
                            <div class="rapport-card-total">
                                <div class="rapport-card-total-value" style="color: ${livreurColor};">${escapeHtml(total)}</div>
                                <div class="rapport-card-total-label">colis</div>
                            </div>
                        </div>

                        <div>
                            <div class="rapport-card-section-title">Secteurs assignés (${livreur.secteurs.length})</div>
                            <div class="rapport-secteurs-grid">${secteursHtml}</div>
                        </div>

                        <div class="rapport-card-footer">
                            <div class="rapport-charge-bar">
                                <div class="rapport-charge-fill ${chargeFillClass}" style="width: ${chargePercent}%;"></div>
                            </div>
                            <div class="rapport-card-stat"><strong>${chargePercent}%</strong> charge</div>
                            
                        </div>
                    </div>
                `;
            }).join('');

            showToast('Rapport généré', 'success');
        }

        async function exportRapportPDF() {
            try {
                await ensureJsPDF();
                if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') {
                    showToast('jsPDF non chargé - utilisez Ctrl+P', 'warning');
                    window.print();
                    return;
                }
                const { jsPDF } = window.jspdf || { jsPDF: window.jsPDF };

                const prevs = data.previsions[selectedDate] || [];
                const prevsMap = {};
                prevs.forEach(p => prevsMap[p.code_postal] = p.colis);
                const livreursActifs = data.livreurs.filter(l => l.actif && l.secteurs_prioritaires.length > 0);

                const rapportData = livreursActifs.map(l => {
                    const secteurs = l.secteurs_prioritaires.map(s => ({ code: s, colis: prevsMap[s] || 0 }));
                    const total = secteurs.reduce((a, s) => a + s.colis, 0);
                    return { ...l, secteurs, total };
                });
                rapportData.sort((a, b) => b.total - a.total);

                const N = rapportData.length;
                if (N === 0) {
                    showToast('Aucun livreur avec des secteurs assignés', 'warning');
                    return;
                }

                // ====================================================================
                // FICHE TRI v43 — STYLE ÉCRAN, PACKING SANS WHITESPACE
                // ====================================================================
                // Stratégie en 2 passes :
                // 1) Calculer une hauteur "minimale" pour chaque card (header + chips
                //    à taille standard). Distribuer en colonnes (masonry).
                // 2) Pour chaque card, AGRANDIR les chips pour remplir tout l'espace
                //    de sa card jusqu'à l'égalisation des hauteurs de colonnes
                //    (toutes les colonnes finissent à la même hauteur = pageHeight).
                // ====================================================================

                // Choix des colonnes selon nb de livreurs
                let orientation, cols;
                if (N <= 4)        { orientation = 'portrait';  cols = 2; }
                else if (N <= 9)   { orientation = 'portrait';  cols = 3; }
                else if (N <= 12)  { orientation = 'portrait';  cols = 3; }
                else if (N <= 16)  { orientation = 'landscape'; cols = 4; }
                else if (N <= 20)  { orientation = 'landscape'; cols = 5; }
                else               { orientation = 'landscape'; cols = 5; }

                const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4' });
                const pageWidth = orientation === 'portrait' ? 210 : 297;
                const pageHeight = orientation === 'portrait' ? 297 : 210;
                const margin = 6;
                const headerHeight = 18;
                const footerHeight = 5;
                const gapX = 4;
                const gapY = 4;

                const cardWidth = (pageWidth - 2 * margin - (cols - 1) * gapX) / cols;
                const totalAvailH = pageHeight - headerHeight - footerHeight - margin;

                // Constantes de mise en page interne d'une card
                const HEADER_CARD_H = 12;       // header (avatar+nom+total)
                const CHIP_H_BASE = 5;          // hauteur de chip "standard"
                const CHIP_GAP = 1;
                const CARD_INNER_PAD = 2.5;
                const CHIPS_PER_ROW = 2;

                // Hauteur "naturelle" d'une card avec chips à taille standard
                function naturalCardHeight(livreur) {
                    const nbChips = livreur.secteurs.length;
                    const nbRowsChips = Math.ceil(nbChips / CHIPS_PER_ROW);
                    const chipsH = nbRowsChips * CHIP_H_BASE + Math.max(0, nbRowsChips - 1) * CHIP_GAP;
                    return HEADER_CARD_H + chipsH + 2 * CARD_INNER_PAD;
                }

                const naturalHeights = rapportData.map(naturalCardHeight);

                // ----- Distribution masonry : empiler dans cols colonnes -----
                function distribueColonnes(items, heights, cols) {
                    const colonnes = Array.from({ length: cols }, () => ({ items: [] }));
                    const colHeights = new Array(cols).fill(0);
                    items.forEach((item, idx) => {
                        let minH = Infinity, minIdx = 0;
                        for (let c = 0; c < cols; c++) {
                            if (colHeights[c] < minH) { minH = colHeights[c]; minIdx = c; }
                        }
                        colonnes[minIdx].items.push({ idx, naturalH: heights[idx] });
                        colHeights[minIdx] += heights[idx] + (colonnes[minIdx].items.length > 1 ? gapY : 0);
                    });
                    return { colonnes, colHeights };
                }

                const items = rapportData.map((_, idx) => idx);
                const { colonnes, colHeights } = distribueColonnes(items, naturalHeights, cols);

                // ----- Pour chaque card, on garde la hauteur naturelle -----
                // Comme à l'écran : chaque card a juste la hauteur de son contenu.
                // Le blanc résiduel en bas des colonnes est acceptable car il
                // correspond au comportement visuel attendu (pas d'étirement bizarre).
                const finalCardHeights = naturalHeights.slice();

                // ============================================================
                // HEADER GLOBAL
                // ============================================================
                doc.setFillColor(15, 184, 154);
                doc.rect(0, 0, pageWidth, headerHeight, 'F');

                doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.setTextColor(255, 255, 255);
                doc.text('FICHE TRI', margin, 7.5);
                doc.setFontSize(9); doc.setFont(undefined, 'normal');
                doc.text(formatDateLong(selectedDate), margin, 13);

                const totalColisSum = rapportData.reduce((a, l) => a + l.total, 0);
                const moy = N ? Math.round(totalColisSum / N) : 0;
                doc.setFontSize(11); doc.setFont(undefined, 'bold');
                doc.text(`${totalColisSum} colis`, pageWidth - margin, 7.5, { align: 'right' });
                doc.setFontSize(8); doc.setFont(undefined, 'normal');
                doc.text(`${N} livreurs · moy. ${moy}/livreur`, pageWidth - margin, 13, { align: 'right' });

                // ============================================================
                // RENDU DES CARDS
                // ============================================================
                const startY = headerHeight + 2;

                colonnes.forEach((colonne, colIdx) => {
                    let cursorY = startY;
                    const x = margin + colIdx * (cardWidth + gapX);

                    colonne.items.forEach(item => {
                        const l = rapportData[item.idx];
                        const cardH = finalCardHeights[item.idx];
                        const y = cursorY;
                        const livreurRGB = hexToRgb(getLivreurColor(l.id));

                        // ====== CARD ======
                        doc.setFillColor(255, 255, 255);
                        doc.setDrawColor(225, 230, 228);
                        doc.setLineWidth(0.3);
                        doc.roundedRect(x, y, cardWidth, cardH, 2, 2, 'FD');

                        // ====== HEADER (taille fixe) ======
                        const innerPad = CARD_INNER_PAD;
                        const avatarRadius = 3.5;
                        const avatarCx = x + innerPad + avatarRadius;
                        const avatarCy = y + innerPad + avatarRadius;

                        doc.setFillColor(livreurRGB[0], livreurRGB[1], livreurRGB[2]);
                        doc.circle(avatarCx, avatarCy, avatarRadius, 'F');
                        const initiale = (l.prenom || l.nom || '?').charAt(0).toUpperCase();
                        doc.setFontSize(9); doc.setFont(undefined, 'bold');
                        doc.setTextColor(255, 255, 255);
                        doc.text(initiale, avatarCx, avatarCy + 1.5, { align: 'center' });

                        // Total à droite
                        const fontTotal = 16;
                        doc.setFontSize(fontTotal); doc.setFont(undefined, 'bold');
                        doc.setTextColor(livreurRGB[0], livreurRGB[1], livreurRGB[2]);
                        const totalText = String(l.total);
                        const totalX = x + cardWidth - innerPad;
                        doc.text(totalText, totalX, avatarCy + 1.8, { align: 'right' });

                        doc.setFontSize(5.5); doc.setFont(undefined, 'normal');
                        doc.setTextColor(140);
                        doc.text('colis', totalX, avatarCy + 4.5, { align: 'right' });

                        // Largeur prise par le total pour calcul espace nom
                        doc.setFontSize(fontTotal); doc.setFont(undefined, 'bold');
                        const totalWidth = doc.getTextWidth(totalText);

                        // Nom + sous-titre
                        const nomX = avatarCx + avatarRadius + 2;
                        const nomMaxWidth = (totalX - totalWidth - 2) - nomX;

                        doc.setFontSize(10); doc.setFont(undefined, 'bold');
                        doc.setTextColor(40, 40, 40);
                        const nomComplet = (l.prenom ? l.prenom + ' ' : '') + l.nom;
                        let nomAffiche = nomComplet;
                        while (doc.getTextWidth(nomAffiche) > nomMaxWidth && nomAffiche.length > 3) {
                            nomAffiche = nomAffiche.slice(0, -2);
                        }
                        if (nomAffiche !== nomComplet) nomAffiche = nomAffiche.slice(0, -1) + '…';
                        doc.text(nomAffiche, nomX, avatarCy);

                        doc.setFontSize(7); doc.setFont(undefined, 'normal');
                        doc.setTextColor(130);
                        doc.text(`${l.secteurs.length} secteur${l.secteurs.length > 1 ? 's' : ''}`,
                                 nomX, avatarCy + 3.2);

                        // ====== ZONE CHIPS (s'étire pour remplir la card) ======
                        const chipsZoneX = x + innerPad;
                        const chipsZoneY = y + HEADER_CARD_H;
                        const chipsZoneW = cardWidth - 2 * innerPad;
                        const chipsZoneH = (y + cardH) - chipsZoneY - innerPad;

                        if (chipsZoneH > 3 && l.secteurs.length > 0) {
                            const tries = [...l.secteurs].sort((a, b) => b.colis - a.colis);
                            const nbSecteurs = tries.length;

                            // Choix dynamique du nb de colonnes de chips :
                            // - Si très peu de secteurs ET beaucoup d'espace → 1 colonne (chips bien grosses)
                            // - Sinon : 2 colonnes (équilibre lisibilité/densité)
                            // - Si beaucoup de secteurs : 3 colonnes pour rentrer
                            let chipCols;
                            const espaceParChip2col = chipsZoneH / Math.ceil(nbSecteurs / 2);
                            if (nbSecteurs <= 3 && espaceParChip2col > 12) {
                                chipCols = 1;  // grosses chips pleine largeur
                            } else if (nbSecteurs > 18) {
                                chipCols = 3;
                            } else {
                                chipCols = CHIPS_PER_ROW;
                            }

                            const chipsRows = Math.ceil(nbSecteurs / chipCols);
                            const chipW = (chipsZoneW - (chipCols - 1) * CHIP_GAP) / chipCols;
                            // chipH s'adapte pour remplir la zone, plafonné à 12mm pour rester lisible
                            let chipH = (chipsZoneH - Math.max(0, chipsRows - 1) * CHIP_GAP) / chipsRows;
                            chipH = Math.max(4, Math.min(12, chipH));

                            const fontChipCP = Math.max(7, Math.min(11, chipH * 0.42));
                            const fontChipColis = Math.max(6, fontChipCP * 0.85);

                            tries.forEach((s, i) => {
                                const ccol = i % chipCols;
                                const crow = Math.floor(i / chipCols);
                                const cx = chipsZoneX + ccol * (chipW + CHIP_GAP);
                                const cy = chipsZoneY + crow * (chipH + CHIP_GAP);

                                doc.setFillColor(livreurRGB[0], livreurRGB[1], livreurRGB[2]);
                                doc.roundedRect(cx, cy, chipW, chipH, chipH * 0.3, chipH * 0.3, 'F');

                                // Badge colis blanc à droite (calculé EN PREMIER pour réserver l'espace)
                                const badgeText = String(s.colis);
                                doc.setFontSize(fontChipColis);
                                const badgeTextW = doc.getTextWidth(badgeText);
                                const badgePad = chipH * 0.22;
                                // Badge largeur proportionnelle au texte, plafonnée
                                const badgeMinW = chipH * 0.7;
                                const badgeMaxW = Math.min(chipW * 0.4, chipH * 1.6);
                                const badgeW = Math.max(badgeMinW, Math.min(badgeMaxW, badgeTextW + 2 * badgePad));
                                const badgeH = chipH * 0.65;
                                const badgeRightMargin = chipH * 0.18;
                                const badgeX = cx + chipW - badgeW - badgeRightMargin;
                                const badgeY = cy + (chipH - badgeH) / 2;

                                // CP en blanc à gauche - tronquer si nécessaire (on doit tenir avant le badge)
                                doc.setFontSize(fontChipCP); doc.setFont(undefined, 'bold');
                                doc.setTextColor(255, 255, 255);
                                const cpX = cx + chipH * 0.4;
                                const cpMaxW = badgeX - cpX - 1;
                                let cpAffiche = s.code;
                                while (doc.getTextWidth(cpAffiche) > cpMaxW && cpAffiche.length > 3) {
                                    cpAffiche = cpAffiche.slice(0, -1);
                                }
                                doc.text(cpAffiche, cpX, cy + chipH * 0.62);

                                // Maintenant le badge
                                doc.setFillColor(255, 255, 255);
                                doc.roundedRect(badgeX, badgeY, badgeW, badgeH, badgeH * 0.4, badgeH * 0.4, 'F');

                                doc.setFontSize(fontChipColis); doc.setFont(undefined, 'bold');
                                doc.setTextColor(livreurRGB[0], livreurRGB[1], livreurRGB[2]);
                                doc.text(badgeText, badgeX + badgeW / 2, badgeY + badgeH * 0.7, { align: 'center' });
                            });
                        }

                        cursorY += cardH + gapY;
                    });
                });

                // ============================================================
                // FOOTER
                // ============================================================
                doc.setFontSize(6.5); doc.setFont(undefined, 'normal');
                doc.setTextColor(150);
                doc.text(
                    `Généré le ${new Date().toLocaleString('fr-FR')} · Planification Livraisons`,
                    pageWidth / 2, pageHeight - 1.5, { align: 'center' }
                );

                doc.save(`fiche-tri_${selectedDate}.pdf`);
                showToast(`Fiche tri PDF exportée (${N} livreur(s) sur 1 page)`, 'success');
            } catch (e) {
                console.error(e);
                showToast('Erreur export PDF : ' + e.message, 'error');
            }
        }

