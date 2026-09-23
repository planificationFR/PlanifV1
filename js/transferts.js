        // ============== TRANSFERT D'UNE JOURNÉE ENTRE LIVREURS (correction manuelle) ==============
        function ouvrirTransfertJournee(sourceName, date) {
            const month = selectedHistoriqueMonth;
            const monthData = data.historiqueEPOD?.[month] || {};
            const src = monthData[sourceName];
            if (!src || !src.jours[date]) { showToast('Journée introuvable', 'error'); return; }
            const j = src.jours[date];
            const cibles = new Set();
            Object.keys(monthData).forEach(n => { if (n !== sourceName) cibles.add(n); });
            (data.livreurs || []).forEach(l => { if (l.nom && l.nom !== sourceName) cibles.add(l.nom); });
            const opts = [...cibles].sort((a, b) => a.localeCompare(b))
                .map(n => `<option value="${escAttr(n)}">${escapeHtml(n)}</option>`).join('');

            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay active modal-dynamique';
            overlay.style.zIndex = '99999';
            overlay.innerHTML = `
              <div class="modal" style="max-width:440px;">
                <div class="modal-header">
                  <h3 style="margin:0;"><i class="fas fa-exchange-alt"></i> Transférer une journée</h3>
                  <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body" style="padding:1rem 1.25rem 1.25rem;">
                  <p style="margin-bottom:0.85rem;font-size:0.92rem;">
                    Déplacer la journée du <strong>${escapeHtml(date)}</strong>
                    (<strong>${escapeHtml(j.livres || 0)}</strong> colis livrés${(j.echecs ? `, ${escapeHtml(j.echecs)} échec(s)` : '')})
                    de <strong>${escapeHtml(sourceName)}</strong> vers :
                  </p>
                  <select id="transfertCibleSelect" class="form-input" style="width:100%;margin-bottom:1rem;">
                    ${opts || '<option value="">(aucun autre livreur disponible)</option>'}
                  </select>
                  <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:1rem;">
                    Les colis, le salaire ET les analyses Contrôle EPOD (taux d'appel, anomalies, Next Day)
                    de cette journée seront transférés vers le compte destinataire.
                    Utile quand un livreur travaille avec deux comptes le même jour.
                  </div>
                  <div style="display:flex;gap:0.5rem;justify-content:flex-end;">
                    <button class="btn btn-secondary btn-sm" onclick="this.closest('.modal-overlay').remove()">Annuler</button>
                    <button class="btn btn-primary btn-sm" onclick="var t=document.getElementById('transfertCibleSelect').value; if(t){this.closest('.modal-overlay').remove(); transfererJourneeVers('${escJsAttr(sourceName)}','${escJsAttr(date)}',t);}">
                      <i class="fas fa-check"></i> Transférer
                    </button>
                  </div>
                </div>
              </div>`;
            document.body.appendChild(overlay);
        }

        // v46 — Cette fonction déplaçait physiquement la journée dans
        // data.historiqueEPOD. Deux mécanismes concurrents modifiaient donc les
        // mêmes chiffres : celui-ci en écrasant les données brutes de l'export,
        // et les transferts de colis en les ajustant. Résultat : des totaux qui
        // ne correspondaient plus au fichier source et des réaffectations qui
        // pointaient sur des journées disparues.
        //
        // Elle passe désormais par le mécanisme unique : un transfert portant
        // sur la totalité des colis livrés ce jour-là. Les données importées
        // restent intactes et l'action reste annulable.
        function transfererJourneeVers(sourceName, date, targetName) {
            const month = selectedHistoriqueMonth;
            const monthData = data.historiqueEPOD?.[month];
            if (!monthData || !monthData[sourceName] || !monthData[sourceName].jours[date]) {
                showToast('Journée introuvable', 'error'); return;
            }
            const j = monthData[sourceName].jours[date];
            const nb = j.livres || 0;
            if (nb <= 0) { showToast('Aucun colis livré ce jour-là', 'warning'); return; }

            const t = enregistrerTransfert({
                mois: month, date, de: sourceName, vers: targetName, nb,
                mode: 'manuel', note: 'Journée entière réaffectée',
                routes: (j.routes || []).slice()
            });
            if (!t) return;

            // Transfert aussi côté Contrôle EPOD (taux d'appel, anomalies, Next Day, contacts)
            let ccMsg = '';
            try {
                const rcc = ccTransfererJour(date, sourceName, targetName);
                if (rcc.ok) ccMsg = ' — salaire + Contrôle EPOD ✓';
                else if (rcc.raison && rcc.raison.includes('réimportez')) ccMsg = ' — ⚠ Contrôle EPOD non transféré : ' + rcc.raison;
            } catch (e) { console.warn('[CC] transfert jour', e); }

            markUnsaved(); saveLocal();
            refreshHistorique();
            showToast(`Journée du ${date} transférée de ${sourceName} à ${targetName}${ccMsg}`, 'success');
        }

        function renderHistoriqueLivreurs(monthData) {
            const container = document.getElementById('historiqueListLivreurs');
            const _rem = (l) => (l.totalRemunerables !== undefined ? l.totalRemunerables : l.totalLivres) || 0;
            const livreurs = Object.entries(monthData).sort((a, b) => _rem(b[1]) - _rem(a[1]));

            if (livreurs.length === 0) {
                container.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><h4>Aucune donnée</h4><p>Importez un fichier EPOD pour voir l\'historique</p></div>';
                return;
            }

            // Pré-calcul : pour chaque livreur, à quelles dates a-t-il partagé une route ? Avec qui ?
            const detections = detectRoutesPartagees(monthData);
            // { 'Sofiane': { '2026-04-15': [{nom:'Pierre', routeId:'ROUTECP...'}, ...] } }
            const partagesParLivreur = {};
            detections.forEach(d => {
                d.drivers.forEach(drv => {
                    if (!partagesParLivreur[drv.nom]) partagesParLivreur[drv.nom] = {};
                    if (!partagesParLivreur[drv.nom][d.date]) partagesParLivreur[drv.nom][d.date] = [];
                    // Les autres livreurs de la même route ce jour-là
                    d.drivers.forEach(autre => {
                        if (autre.nom !== drv.nom) {
                            partagesParLivreur[drv.nom][d.date].push(autre.nom);
                        }
                    });
                });
            });

            container.innerHTML = livreurs.map(([livreurName, liv]) => {
                const tauxReussite = liv.totalPrevus > 0 ? Math.round((liv.totalLivres / liv.totalPrevus) * 100) : 0;
                const joursCount = Object.keys(liv.jours).length;

                // Find livreur config for salary calculation (matching robuste)
                // v49 — Un compte présent dans l'export mais absent de la fiche
                // livreurs recevait silencieusement un contrat par défaut à
                // 1,40 €/colis. Un salaire était donc calculé sur un taux inventé,
                // sans que rien ne le signale. On le rend visible et corrigeable.
                const livreurTrouve = (typeof matchLivreur === 'function') ? matchLivreur(livreurName) : null;
                const livreurConfig = livreurTrouve || { contrat: 'auto-entrepreneur', taux: 1.4 };
                const nonConfigure = !livreurTrouve;

                // Calcul du salaire mensuel avec règle PUDO
                const calc = calculerSalaireMensuel(liv, livreurConfig);
                const salaire = calc.salaire.toFixed(2);

                // Frais avancés par le livreur (gasoil, adblue, huile, pneu…) — ajoutés au salaire
                const fraisList = getFraisLivreur(selectedHistoriqueMonth, livreurName);
                const fraisTotal = totalFraisLivreur(selectedHistoriqueMonth, livreurName);
                const totalAvecFrais = (calc.salaire + fraisTotal).toFixed(2);
                const cid = cssId(livreurName);

                // Suivi des paiements : combien déjà réglé, combien reste
                const paiement = getPaiement(selectedHistoriqueMonth, livreurName);
                let montantPayeSalaire = 0;
                Object.entries(calc.salaireParJour).forEach(([dt, s]) => { if (paiement.jours && paiement.jours[dt]) montantPayeSalaire += s; });
                const fraisPaye = !!paiement.fraisPaye;
                const montantTotalNum = calc.salaire + fraisTotal;
                const montantPaye = Math.round((montantPayeSalaire + (fraisPaye ? fraisTotal : 0)) * 100) / 100;
                const reste = Math.round((montantTotalNum - montantPaye) * 100) / 100;
                const nbJoursPayes = Object.keys(liv.jours).filter(dt => paiement.jours && paiement.jours[dt]).length;
                const toutPaye = montantTotalNum > 0 && reste <= 0.005;
                const paiementBadge = toutPaye
                    ? `<span title="Entièrement réglé" style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:0.75rem;font-weight:700;background:rgba(45,212,163,0.18);color:var(--success);margin-left:0.4rem;"><i class="fas fa-check-circle"></i> Payé</span>`
                    : (montantPaye > 0
                        ? `<span title="Partiellement réglé" style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:0.75rem;font-weight:700;background:rgba(255,138,101,0.15);color:#FF8A65;margin-left:0.4rem;"><i class="fas fa-hourglass-half"></i> Reste ${reste.toFixed(2)} €</span>`
                        : `<span title="Non réglé" style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:0.75rem;font-weight:700;background:rgba(231,76,60,0.12);color:var(--danger);margin-left:0.4rem;"><i class="fas fa-circle"></i> À régler</span>`);

                // Calcul taux échec (indicatif, n'influence pas le salaire)
                const totalEchecs = liv.totalEchecs || 0;
                const totalTente = liv.totalLivres + totalEchecs;
                const pctEchec = totalTente > 0 ? (totalEchecs / totalTente * 100) : 0;
                const echecDepasse = pctEchec > SEUIL_ECHEC_PCT;

                // Lignes des jours
                const partagesLivreur = partagesParLivreur[livreurName] || {};
                const jours = Object.entries(liv.jours).sort((a, b) => a[0].localeCompare(b[0]));
                const joursHtml = jours.map(([date, j]) => {
                    const d = new Date(date);
                    const jourSemaine = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'][d.getDay()];
                    const dateStr = `${jourSemaine} ${d.getDate().toString().padStart(2, '0')}/${(d.getMonth()+1).toString().padStart(2, '0')}/${d.getFullYear()}`;
                    const tauxJour = j.prevus > 0 ? Math.round((j.livres / j.prevus) * 100) : 0;
                    const pudoJour = j.pudo || 0;
                    const salaireJour = (calc.salaireParJour[date] || 0).toFixed(2);
                    // v44 — la colonne « colis » affiche le nombre RÉMUNÉRÉ.
                    // Quand un transfert s'applique, on montre le calcul en clair
                    // pour que l'écart avec le fichier source soit toujours explicable.
                    const cedesJour = j.cedes || 0, recusJour = j.recus || 0;
                    const remJour = colisRemunerablesJour(j);
                    const colisCell = (cedesJour || recusJour)
                        ? `<td><strong>${remJour}</strong>
                             <span title="${escapeHtml(j.livres)} livrés sous ce compte${cedesJour ? ` − ${cedesJour} cédés` : ''}${recusJour ? ` + ${recusJour} reçus` : ''}"
                                   style="display:inline-block;margin-left:0.3rem;padding:1px 6px;border-radius:8px;font-size:0.68rem;font-weight:700;cursor:help;
                                          background:${cedesJour ? 'rgba(232,89,12,0.14)' : 'rgba(43,110,143,0.14)'};
                                          color:${cedesJour ? 'var(--secondary)' : 'var(--primary)'};">
                               <i class="fas fa-exchange-alt" style="font-size:0.62rem;"></i>
                               ${cedesJour ? `−${cedesJour}` : ''}${cedesJour && recusJour ? ' ' : ''}${recusJour ? `+${recusJour}` : ''}
                             </span></td>`
                        : `<td>${escapeHtml(j.livres)}</td>`;
                    const pudoCell = pudoJour > 0
                        ? `<td style="text-align:center;color:${calc.depassement ? 'var(--danger)' : 'var(--text-secondary)'};font-weight:600;">${pudoJour}</td>`
                        : `<td style="text-align:center;color:var(--text-secondary);">0</td>`;
                    // Badge "route partagée" si applicable (noms dédupliqués)
                    const partages = partagesLivreur[date] ? [...new Set(partagesLivreur[date])] : null;
                    const partageBadge = partages && partages.length > 0
                        ? ` <span title="Route partagée avec ${partages.map(escapeHtml).join(', ')}" style="display:inline-block;padding:1px 6px;background:rgba(15,184,154,0.15);color:var(--primary);border-radius:8px;font-size:0.7rem;font-weight:700;margin-left:0.3rem;cursor:help;"><i class="fas fa-handshake" style="font-size:0.65rem;"></i> ${partages.map(escapeHtml).join(', ')}</span>`
                        : '';
                    const transfertBtn = `<button class="btn btn-sm" title="Transférer cette journée à un autre livreur" style="padding:2px 7px;background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);" onclick="event.stopPropagation();ouvrirTransfertJournee('${escJsAttr(livreurName)}','${escJsAttr(date)}')"><i class="fas fa-exchange-alt"></i></button>`;
                    const jPaye = estJourPaye(selectedHistoriqueMonth, livreurName, date);
                    const payeBtn = `<button class="btn btn-sm" title="${jPaye ? 'Marquer comme non payé' : 'Marquer cette journée comme payée'}" style="padding:2px 7px;background:${jPaye ? 'rgba(45,212,163,0.18)' : 'var(--background-light)'};color:${jPaye ? 'var(--success)' : 'var(--text-secondary)'};border:1px solid ${jPaye ? 'rgba(45,212,163,0.45)' : 'var(--border-light)'};" onclick="event.stopPropagation();toggleJourPaye('${escJsAttr(livreurName)}','${escJsAttr(date)}')"><i class="fas ${jPaye ? 'fa-check-circle' : 'fa-circle'}"></i></button>`;
                    const rowStyle = jPaye ? ' style="background:rgba(45,212,163,0.06);"' : '';
                    const payeTag = jPaye ? ' <span style="color:var(--success);font-size:0.68rem;font-weight:700;">✓ payé</span>' : '';
                    const kmTag = (j.km !== undefined) ? ` <span title="Kilométrage GPS réel${j.kmApprox ? ' — approximatif : deux séquences entrelacées ce jour-là (renfort sous ce compte), grands sauts exclus' : ''}${j.respectOrdre !== undefined ? ` · ordre planifié respecté à ${escapeHtml(j.respectOrdre)} %` : ''}" style="color:var(--text-secondary);font-size:0.68rem;cursor:help;">${j.kmApprox ? '≈' : ''}${escapeHtml(j.km)} km</span>` : '';
                    return `<tr${rowStyle}><td>${dateStr}${partageBadge}${payeTag}${kmTag}</td>${colisCell}${pudoCell}<td>${escapeHtml(j.prevus)}</td><td>${tauxJour}%</td><td class="salaire-cell">${salaireJour} €</td><td style="text-align:center;white-space:nowrap;">${payeBtn} ${transfertBtn}</td></tr>`;
                }).join('');

                // Bandeau PUDO (toujours visible si totalPudo > 0)
                let pudoBandeau = '';
                // Pas de bandeau échec : juste la pastille dans le header (cf user req)
                const echecBandeau = '';

                if (liv.totalPudo > 0) {
                    if (calc.depassement) {
                        pudoBandeau = `
                            <div style="margin-top: 0.5rem; padding: 0.75rem; background: rgba(231, 76, 60, 0.12); border-left: 3px solid var(--danger); border-radius: var(--radius-sm); font-size: 0.88rem;">
                                <strong style="color: var(--danger);"><i class="fas fa-exclamation-triangle"></i> Dépassement seuil PUDO</strong><br>
                                ${escapeHtml(liv.totalPudo)} colis PUDO sur ${escapeHtml(liv.totalLivres)} livrés = <strong>${calc.pctPudo.toFixed(2)}%</strong> (seuil 3%)<br>
                                Tous les colis PUDO sont facturés à <strong>0,80 €</strong>.
                            </div>
                        `;
                    } else {
                        pudoBandeau = `
                            <div style="margin-top: 0.5rem; padding: 0.6rem 0.75rem; background: rgba(45, 212, 163, 0.08); border-left: 3px solid var(--success); border-radius: var(--radius-sm); font-size: 0.85rem; color: var(--text-secondary);">
                                <i class="fas fa-check-circle" style="color: var(--success);"></i>
                                ${escapeHtml(liv.totalPudo)} PUDO sur ${escapeHtml(liv.totalLivres)} livrés = <strong>${calc.pctPudo.toFixed(2)}%</strong> (≤ 3%, tarif normal)
                            </div>
                        `;
                    }
                }

                // Info grille pour salariés et AE-véhicule
                const useGrilleAffich = (livreurConfig.contrat === 'salarie' || livreurConfig.contrat === 'autoentrepreneur-vehicule');
                const bonus10 = livreurConfig.contrat === 'autoentrepreneur-vehicule' ? ' +10€' : '';
                const titreGrille = livreurConfig.contrat === 'autoentrepreneur-vehicule' ? 'Grille AE véhicule entreprise (+10€/palier)' : 'Grille salarié';
                const grilleHtml = useGrilleAffich ? `
                    <div style="margin-top: 0.5rem; padding: 0.75rem; background: var(--info-light); border-radius: var(--radius-sm); font-size: 0.85rem;">
                        <strong><i class="fas fa-calculator"></i> ${titreGrille}:</strong>
                        &lt;65 → prorata (colis × 0,72${bonus10}) | 65-107 → ${livreurConfig.contrat === 'autoentrepreneur-vehicule' ? '90' : '80'}€ | 108-117 → ${livreurConfig.contrat === 'autoentrepreneur-vehicule' ? '95' : '85'}€ | 118-125 → ${livreurConfig.contrat === 'autoentrepreneur-vehicule' ? '100' : '90'}€ | 126-150 → prorata | &gt;150 → ${livreurConfig.contrat === 'autoentrepreneur-vehicule' ? '118' : '108'}€ + (surplus × 0,80€)
                    </div>
                ` : '';

                // Pastille PUDO dans le header de la card
                const pudoPastille = liv.totalPudo > 0
                    ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.75rem;font-weight:700;background:${calc.depassement ? 'rgba(231,76,60,0.15)' : 'rgba(45,212,163,0.12)'};color:${calc.depassement ? 'var(--danger)' : 'var(--success)'};margin-left:0.5rem;">${calc.pctPudo.toFixed(1)}% PUDO</span>`
                    : '';

                // Pastille ÉCHEC dans le header (indicatif)
                const ventil = ventilerEchecs(liv.indicateurs);
                const echecPastille = totalEchecs > 0
                    ? `<span title="Taux d'échec indicatif (n'affecte pas le salaire)${liv.indicateurs ? ` — ${ventil.imputables} imputables, ${ventil.nonImputables} non imputables (adresse, BAL, Vigik…)` : ''}" style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.75rem;font-weight:700;background:${echecDepasse ? 'rgba(231,76,60,0.15)' : 'rgba(255,138,101,0.12)'};color:${echecDepasse ? 'var(--danger)' : '#FF8A65'};margin-left:0.4rem;">${pctEchec.toFixed(2)}% échec${echecDepasse ? ' ⚠' : ''}${liv.indicateurs && totalEchecs ? ` <span style="font-weight:400;opacity:0.85;">(${ventil.imputables} imput.)</span>` : ''}</span>`
                    : '';

                return `
                    <div class="historique-livreur-card" onclick="toggleHistoriqueCard(this)">
                        <div class="historique-livreur-header">
                            <div>
                                <h4 style="margin:0;display:flex;align-items:center;flex-wrap:wrap;">${escapeHtml(livreurName)}${pudoPastille}${echecPastille}${paiementBadge}</h4>
                                ${nonConfigure ? `
                                <div style="margin:0.3rem 0 0.45rem;padding:0.45rem 0.7rem;border-radius:8px;font-size:0.8rem;
                                            background:rgba(232,89,12,0.1);border-left:3px solid var(--secondary);">
                                    <strong style="color:var(--secondary);"><i class="fas fa-user-plus"></i> Livreur non configuré</strong>
                                    <span style="color:var(--text-secondary);"> — salaire estimé au tarif par défaut (1,40 €/colis).</span>
                                    <button class="btn btn-primary btn-sm" style="margin-left:0.4rem;padding:2px 10px;font-size:0.75rem;"
                                            onclick="ouvrirAjoutLivreurRapide('${escJsAttr(livreurName)}')">
                                        <i class="fas fa-plus"></i> Ajouter ce livreur
                                    </button>
                                </div>` : ''}
                                <p style="margin:0;color:var(--text-secondary);font-size:0.88rem;">${(() => {
                                    // v45 — on affiche le nombre de colis RÉMUNÉRÉS, celui qui
                                    // correspond au salaire. Quand il diffère du brut de l'export
                                    // à cause d'un transfert, l'écart est explicité au survol.
                                    const rem = (liv.totalRemunerables !== undefined) ? liv.totalRemunerables : liv.totalLivres;
                                    const ced = liv.totalCedes || 0, rec = liv.totalRecus || 0;
                                    if (!ced && !rec) return `${escapeHtml(liv.totalLivres)} colis`;
                                    const detail = `${escapeHtml(liv.totalLivres)} livrés sous son compte${ced ? ` − ${ced} cédés` : ''}${rec ? ` + ${rec} repris à un collègue` : ''}`;
                                    return `<strong style="color:var(--text);">${escapeHtml(rem)} colis payés</strong>
                                        <span title="${detail}" style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:0.7rem;font-weight:700;cursor:help;
                                              background:${rec ? 'rgba(43,110,143,0.14)' : 'rgba(232,89,12,0.14)'};
                                              color:${rec ? 'var(--primary)' : 'var(--secondary)'};">
                                            <i class="fas fa-exchange-alt" style="font-size:0.62rem;"></i>
                                            ${ced ? `−${ced}` : ''}${ced && rec ? ' ' : ''}${rec ? `+${rec}` : ''}
                                        </span>`;
                                })()} · ${joursCount} jour(s) · ${tauxReussite}% réussite</p>
                            </div>
                            <div style="text-align:right;">
                                <div style="font-size:1.4rem;font-weight:700;color:var(--success);">${totalAvecFrais} €</div>
                                <div style="font-size:0.75rem;color:var(--text-secondary);">${fraisTotal > 0 ? `salaire ${salaire} € + frais ${fraisTotal.toFixed(2)} €` : 'salaire mensuel'}</div>
                                <div style="font-size:0.75rem;font-weight:700;margin-top:2px;color:${toutPaye ? 'var(--success)' : (montantPaye > 0 ? '#FF8A65' : 'var(--danger)')};">${toutPaye ? '✓ réglé' : `reste ${reste.toFixed(2)} €`}</div>
                            </div>
                            <i class="fas fa-chevron-down historique-livreur-toggle"></i>
                        </div>
                        <div class="historique-livreur-details">
                            <div style="margin-bottom: 1rem; padding: 1rem; background: var(--background-light); border-radius: var(--radius-sm);">
                                <strong>Type:</strong> ${livreurConfig.contrat === 'salarie' ? 'Salarié (grille obligatoire)' : (livreurConfig.contrat === 'autoentrepreneur-vehicule' ? 'AE véhicule entreprise (grille +10€)' : 'Auto-entrepreneur')} ${livreurConfig.contrat === 'auto-entrepreneur' ? '(' + escapeHtml(livreurConfig.taux) + ' €/colis)' : ''}
                                <br><strong>Calcul:</strong> ${calc.detailCalcul}
                                <br><strong>Total${fraisTotal > 0 ? ' (salaire + frais)' : ''}:</strong> <span style="font-size:1.05rem;color:var(--success);font-weight:700;">${totalAvecFrais} €</span>${fraisTotal > 0 ? ` <span style="color:var(--text-secondary);font-size:0.85rem;">(${salaire} € salaire + ${fraisTotal.toFixed(2)} € frais)</span>` : ''}
                                ${pudoBandeau}
                                ${grilleHtml}
                                ${_htmlIndicateursLivreur(liv, joursCount)}
                            </div>
                            <table class="historique-day-table">
                                <thead>
                                    <tr>
                                        <th>Date</th>
                                        <th>Colis Livrés</th>
                                        <th style="color:var(--text-secondary);">PUDO</th>
                                        <th>Prévus</th>
                                        <th>Taux</th>
                                        <th style="color: var(--danger);">Salaire</th>
                                        <th style="text-align:center;">Payé / ⇄</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${joursHtml}
                                    <tr class="historique-total-row">
                                        <td><strong>TOTAL</strong></td>
                                        <td><strong>${escapeHtml(liv.totalRemunerables !== undefined ? liv.totalRemunerables : liv.totalLivres)}</strong>${
                                            (liv.totalCedes || liv.totalRecus)
                                                ? `<span title="${escapeHtml(liv.totalLivres)} livrés sous ce compte${liv.totalCedes ? ` − ${liv.totalCedes} cédés` : ''}${liv.totalRecus ? ` + ${liv.totalRecus} repris` : ''}" style="display:inline-block;margin-left:0.3rem;padding:1px 6px;border-radius:8px;font-size:0.68rem;font-weight:700;cursor:help;background:${liv.totalRecus ? 'rgba(43,110,143,0.14)' : 'rgba(232,89,12,0.14)'};color:${liv.totalRecus ? 'var(--primary)' : 'var(--secondary)'};">${liv.totalCedes ? `−${liv.totalCedes}` : ''}${liv.totalCedes && liv.totalRecus ? ' ' : ''}${liv.totalRecus ? `+${liv.totalRecus}` : ''}</span>`
                                                : ''}</td>
                                        <td style="text-align:center;"><strong>${escapeHtml(liv.totalPudo || 0)}</strong></td>
                                        <td><strong>${escapeHtml(liv.totalPrevus)}</strong></td>
                                        <td><strong>${tauxReussite}%</strong></td>
                                        <td class="salaire-cell"><strong>${salaire} €</strong></td>
                                        <td></td>
                                    </tr>
                                </tbody>
                            </table>
                            <div style="margin-top:1rem;padding:0.85rem 1rem;background:var(--background-light);border-radius:var(--radius-sm);" onclick="event.stopPropagation();">
                                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.6rem;">
                                    <strong><i class="fas fa-gas-pump" style="color:var(--secondary);"></i> Frais avancés (ajoutés au salaire)</strong>
                                    <span style="display:flex;align-items:center;gap:0.5rem;">
                                        ${fraisTotal > 0 ? `<button class="btn btn-sm" onclick="event.stopPropagation();toggleFraisPaye('${escJsAttr(livreurName)}')" style="padding:2px 8px;background:${fraisPaye ? 'rgba(45,212,163,0.18)' : 'var(--background-light)'};color:${fraisPaye ? 'var(--success)' : 'var(--text-secondary)'};border:1px solid ${fraisPaye ? 'rgba(45,212,163,0.45)' : 'var(--border-light)'};font-size:0.72rem;font-weight:700;"><i class="fas ${fraisPaye ? 'fa-check-circle' : 'fa-circle'}"></i> ${fraisPaye ? 'Frais payés' : 'Frais à régler'}</button>` : ''}
                                        <span style="font-weight:700;color:var(--success);">${fraisTotal.toFixed(2)} €</span>
                                    </span>
                                </div>
                                ${fraisList.length ? fraisList.map(f => `
                                    <div style="display:flex;justify-content:space-between;align-items:center;padding:0.35rem 0.5rem;background:white;border:1px solid var(--border-light);border-radius:6px;margin-bottom:0.3rem;font-size:0.85rem;">
                                        <span><strong>${escapeHtml(f.categorie)}</strong>${f.note ? ' — ' + escapeHtml(f.note) : ''} <span style="color:var(--text-secondary);font-size:0.78rem;">(${escapeHtml(f.date)})</span></span>
                                        <span style="display:flex;align-items:center;gap:0.5rem;"><strong>${(parseFloat(f.montant) || 0).toFixed(2)} €</strong>
                                        <button class="btn btn-sm btn-danger" style="padding:1px 6px;" onclick="event.stopPropagation();supprimerFrais('${escJsAttr(livreurName)}','${escJsAttr(f.id)}')"><i class="fas fa-trash"></i></button></span>
                                    </div>`).join('') : '<div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:0.5rem;">Aucun frais ce mois-ci.</div>'}
                                <div style="display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center;margin-top:0.5rem;">
                                    <select id="fraisCat_${cid}" class="form-input" style="flex:0 0 auto;width:auto;padding:0.35rem 0.5rem;">
                                        <option>Gasoil</option><option>AdBlue</option><option>Huile</option><option>Pneu</option><option>Péage</option><option>Autre</option>
                                    </select>
                                    <input id="fraisMontant_${cid}" type="number" step="0.01" min="0" placeholder="Montant €" class="form-input" style="flex:0 0 110px;width:110px;padding:0.35rem 0.5rem;">
                                    <input id="fraisNote_${cid}" type="text" placeholder="Note (optionnel)" class="form-input" style="flex:1 1 130px;min-width:120px;padding:0.35rem 0.5rem;">
                                    <button class="btn btn-sm btn-primary" onclick="event.stopPropagation();ajouterFrais('${escJsAttr(livreurName)}')"><i class="fas fa-plus"></i> Ajouter</button>
                                </div>
                            </div>
                            <div class="historique-actions" style="display:flex;gap:0.5rem;flex-wrap:wrap;">
                                <button class="btn btn-sm ${toutPaye ? 'btn-secondary' : 'btn-success'}" onclick="event.stopPropagation();marquerToutPaye('${escJsAttr(livreurName)}')">
                                    <i class="fas fa-money-bill-wave"></i> ${toutPaye ? 'Marquer non payé' : 'Marquer tout payé'}
                                </button>
                                <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();exportLivreurExcel('${escJsAttr(livreurName)}')">
                                    <i class="fas fa-file-excel"></i> Export Excel
                                </button>
                                <button class="btn btn-sm btn-primary" onclick="event.stopPropagation();générérFacture('${escJsAttr(livreurName)}')">
                                    <i class="fas fa-file-invoice"></i> Générer facture
                                </button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            // === Bannière récapitulative du mois : total / payé / reste ===
            let sumTotal = 0, sumPaye = 0;
            livreurs.forEach(([nm, lv]) => {
                const cfg = (typeof matchLivreur === 'function' && matchLivreur(nm)) || { contrat: 'auto-entrepreneur', taux: 1.4 };
                const c = calculerSalaireMensuel(lv, cfg);
                const fr = totalFraisLivreur(selectedHistoriqueMonth, nm);
                const pay = getPaiement(selectedHistoriqueMonth, nm);
                let ps = 0;
                Object.entries(c.salaireParJour).forEach(([dt, s]) => { if (pay.jours && pay.jours[dt]) ps += s; });
                sumTotal += c.salaire + fr;
                sumPaye += ps + (pay.fraisPaye ? fr : 0);
            });
            sumTotal = Math.round(sumTotal * 100) / 100;
            sumPaye = Math.round(sumPaye * 100) / 100;
            const sumReste = Math.round((sumTotal - sumPaye) * 100) / 100;
            const pctPaye = sumTotal > 0 ? Math.round(sumPaye / sumTotal * 100) : 0;
            const banniere = `
                <div style="margin-bottom:1rem;padding:1rem 1.2rem;background:linear-gradient(135deg, rgba(15,184,154,0.10), rgba(45,212,163,0.04));border:1px solid rgba(15,184,154,0.25);border-radius:10px;">
                    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:1rem;align-items:center;">
                        <div><div style="font-size:0.78rem;color:var(--text-secondary);font-weight:600;">TOTAL À PAYER (${escapeHtml(formatMonthName(selectedHistoriqueMonth))})</div>
                            <div style="font-size:1.5rem;font-weight:800;color:var(--text);">${sumTotal.toFixed(2)} €</div></div>
                        <div><div style="font-size:0.78rem;color:var(--text-secondary);font-weight:600;">DÉJÀ PAYÉ</div>
                            <div style="font-size:1.5rem;font-weight:800;color:var(--success);">${sumPaye.toFixed(2)} €</div></div>
                        <div><div style="font-size:0.78rem;color:var(--text-secondary);font-weight:600;">RESTE À RÉGLER</div>
                            <div style="font-size:1.5rem;font-weight:800;color:${sumReste <= 0.005 ? 'var(--success)' : '#FF8A65'};">${sumReste.toFixed(2)} €</div></div>
                    </div>
                    <div style="margin-top:0.7rem;height:8px;background:rgba(0,0,0,0.06);border-radius:4px;overflow:hidden;">
                        <div style="height:100%;width:${pctPaye}%;background:var(--success);border-radius:4px;transition:width 0.3s;"></div>
                    </div>
                    <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:0.3rem;">${pctPaye}% réglé</div>
                </div>`;
            container.innerHTML = banniere + container.innerHTML;
        }

        function toggleHistoriqueCard(card) {
            card.classList.toggle('expanded');
        }

        async function exportLivreurExcel(livreurName) {
            // v46 — l'export doit refléter ce qui est payé : les transferts sont
            // appliqués, et le détail cédés/reçus figure dans le fichier.
            const _mois = appliquerTransfertsMois(
                data.historiqueEPOD?.[selectedHistoriqueMonth] || {}, selectedHistoriqueMonth);
            const monthData = _mois[livreurName];
            if (!monthData) return;
            await loadXLSXLib();

            const rows = [['Date', 'Colis Livrés', 'Cédés', 'Reçus', 'Colis Payés', 'Colis Prévus', 'Taux Réussite']];
            let totRem = 0;
            Object.entries(monthData.jours).forEach(([date, j]) => {
                const taux = j.prevus > 0 ? Math.round((j.livres / j.prevus) * 100) : 0;
                const rem = colisRemunerablesJour(j);
                totRem += rem;
                rows.push([date, j.livres, j.cedes || 0, j.recus || 0, rem, j.prevus, taux + '%']);
            });
            rows.push(['TOTAL', monthData.totalLivres, monthData.totalCedes || 0,
                       monthData.totalRecus || 0, totRem, monthData.totalPrevus, '']);

            const ws = XLSX.utils.aoa_to_sheet(rows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Historique');
            XLSX.writeFile(wb, `${livreurName.replace(/\s+/g, '_')}_${selectedHistoriqueMonth}.xlsx`);
            showToast('Excel exporté', 'success');
        }

