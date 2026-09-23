        // ============== FRAIS LIVREURS (dépenses avancées : gasoil, adblue, huile, pneu…) ==============
        function cssId(name) { return String(name).replace(/[^a-zA-Z0-9]/g, '_'); }
        // escAttr() / escJsAttr() : voir js/core/utils.js (fonctions centrales)

        function getFraisLivreur(month, livreurName) {
            const m = (data.fraisLivreurs && data.fraisLivreurs[month]) || {};
            return m[livreurName] || [];
        }
        function totalFraisLivreur(month, livreurName) {
            return Math.round(getFraisLivreur(month, livreurName)
                .reduce((s, f) => s + (parseFloat(f.montant) || 0), 0) * 100) / 100;
        }
        function ajouterFrais(livreurName) {
            const month = selectedHistoriqueMonth;
            const cid = cssId(livreurName);
            const cat = document.getElementById(`fraisCat_${cid}`)?.value || 'Autre';
            const montantEl = document.getElementById(`fraisMontant_${cid}`);
            const noteEl = document.getElementById(`fraisNote_${cid}`);
            const montant = parseFloat(String(montantEl?.value || '').replace(',', '.'));
            if (!montant || montant <= 0) { showToast('Montant invalide', 'error'); return; }
            if (!data.fraisLivreurs[month]) data.fraisLivreurs[month] = {};
            if (!data.fraisLivreurs[month][livreurName]) data.fraisLivreurs[month][livreurName] = [];
            data.fraisLivreurs[month][livreurName].push({
                id: 'F' + Date.now() + Math.floor(Math.random() * 1000),
                categorie: cat,
                montant: Math.round(montant * 100) / 100,
                note: String(noteEl?.value || '').trim(),
                date: new Date().toISOString().slice(0, 10)
            });
            markUnsaved(); saveLocal();
            refreshHistorique();
        }
        function supprimerFrais(livreurName, fraisId) {
            const month = selectedHistoriqueMonth;
            const list = data.fraisLivreurs?.[month]?.[livreurName];
            if (!list) return;
            data.fraisLivreurs[month][livreurName] = list.filter(f => f.id !== fraisId);
            markUnsaved(); saveLocal();
            refreshHistorique();
        }

        // ============== SUIVI DES PAIEMENTS (journées / livreurs payés) ==============
        function getPaiement(month, livreurName) {
            const m = data.paiementsLivreurs?.[month] || {};
            return m[livreurName] || { jours: {}, fraisPaye: false };
        }
        function estJourPaye(month, livreurName, date) {
            return !!(data.paiementsLivreurs?.[month]?.[livreurName]?.jours?.[date]);
        }
        function _ensurePaiement(month, livreurName) {
            if (!data.paiementsLivreurs) data.paiementsLivreurs = {};
            if (!data.controlEPOD) data.controlEPOD = {};
            if (data.ccGapSeuil === undefined) data.ccGapSeuil = 500;
            if (data.inventaire === undefined) data.inventaire = null;
            if (!data.controlCenter) data.controlCenter = {};
            if (!data.paiementsLivreurs[month]) data.paiementsLivreurs[month] = {};
            if (!data.paiementsLivreurs[month][livreurName]) data.paiementsLivreurs[month][livreurName] = { jours: {}, fraisPaye: false };
            return data.paiementsLivreurs[month][livreurName];
        }
        function toggleJourPaye(livreurName, date) {
            const m = selectedHistoriqueMonth;
            const p = _ensurePaiement(m, livreurName);
            if (p.jours[date]) delete p.jours[date]; else p.jours[date] = true;
            markUnsaved(); saveLocal(); refreshHistorique();
        }
        function toggleFraisPaye(livreurName) {
            const m = selectedHistoriqueMonth;
            const p = _ensurePaiement(m, livreurName);
            p.fraisPaye = !p.fraisPaye;
            markUnsaved(); saveLocal(); refreshHistorique();
        }
        // Bascule TOUT payé / TOUT non payé (toutes les journées + frais) pour un livreur.
        function marquerToutPaye(livreurName) {
            const m = selectedHistoriqueMonth;
            const liv = data.historiqueEPOD?.[m]?.[livreurName];
            if (!liv) return;
            const p = _ensurePaiement(m, livreurName);
            const dates = Object.keys(liv.jours || {});
            const aFrais = totalFraisLivreur(m, livreurName) > 0;
            const toutPaye = dates.every(d => p.jours[d]) && (!aFrais || p.fraisPaye);
            if (toutPaye) { p.jours = {}; p.fraisPaye = false; }
            else { p.jours = {}; dates.forEach(d => p.jours[d] = true); p.fraisPaye = true; }
            markUnsaved(); saveLocal(); refreshHistorique();
        }

        // ═══════════════════════════════════════════════════════════════════
        // INTERFACE — ANOMALIES DÉTECTÉES ET TRANSFERTS (v44)
        // ═══════════════════════════════════════════════════════════════════

        // ═══════════════════════════════════════════════════════════════════
        // MÉMOIRE DES POINTS DE DÉTECTION (v47)
        // ───────────────────────────────────────────────────────────────────
        // L'historique agrégé ne conserve que des compteurs par journée. Le
        // détecteur, lui, a besoin de la position et de l'heure de chaque colis.
        // Ces points sont donc stockés à part, compressés, mois par mois.
        // ═══════════════════════════════════════════════════════════════════

        // v50 — encodage compact (dictionnaires + lignes en tableaux) : un mois
        // de 18 000 colis avec n° de colis, ordre, dépôt et commune tient dans
        // ≈ 0,4 Mo compressé. Format : { v:3, base, dict:{...}, rows:[[...]] }.
        // Les anciens points (v1, tableau d'objets) restent lisibles.
        function memoriserPointsDetection(points) {
            if (!Array.isArray(points) || !points.length) return;
            if (!data.pointsDetection) data.pointsDetection = {};
            const parMois = {};
            points.forEach(p => { const m = String(p.d).slice(0, 7); (parMois[m] = parMois[m] || []).push(p); });
            const enc = liste => {
                const dict = { d: [], c: [], r: [], s: [], v: [], p: [], w: [] };
                const maps = {}; Object.keys(dict).forEach(k => maps[k] = new Map());
                const idx = (k, val) => { const v = val || ''; let i = maps[k].get(v); if (i === undefined) { i = dict[k].length; dict[k].push(v); maps[k].set(v, i); } return i; };
                const iv = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1e5) : null;
                // Horodatages en secondes depuis le 1er du mois ; n° de colis
                // scindé en préfixe (dictionnaire) + suffixe.
                const t0 = liste.reduce((m, p) => Math.min(m, p.t), Infinity);
                const base = Math.floor(t0 / 1000);
                const rows = liste.map(p => {
                    const w = String(p.w || ''), pre = w.slice(0, 9), suf = w.slice(9);
                    return [idx('d', p.d), idx('c', p.c), Math.round(p.t / 1000) - base, iv(p.y), iv(p.x), idx('p', p.p), idx('w', pre), suf, idx('r', p.r),
                            isFinite(p.o) ? p.o : null, idx('s', p.s), idx('v', p.v), iv(p.ty), iv(p.tx), p.b ? Math.round(p.b / 1000) - base : 0, p.u || 0];
                });
                return { v: 3, base, dict, rows };
            };
            Object.entries(parMois).forEach(([m, liste]) => {
                try {
                    data.pointsDetection[m] = LZString.compressToBase64(JSON.stringify(enc(liste)));
                } catch (e) { console.warn('[Détection] compression', m, e); }
            });
            // On ne garde que les 4 derniers mois pour rester sous le quota localStorage.
            const mois = Object.keys(data.pointsDetection).sort();
            while (mois.length > 4) delete data.pointsDetection[mois.shift()];
        }

        function lirePointsDetection(mois) {
            const brut = data.pointsDetection?.[mois];
            if (!brut) return null;
            try {
                const obj = JSON.parse(LZString.decompressFromBase64(brut));
                const fv = v => (v === null || v === undefined) ? NaN : v / 1e5;
                if (obj && obj.v === 3) {
                    const D = obj.dict, base = obj.base;
                    return obj.rows.map(r => ({ date: D.d[r[0]], courier: D.c[r[1]], tsLivraison: (base + r[2]) * 1000,
                                                lat: fv(r[3]), lon: fv(r[4]), cp: D.p[r[5]] || '', echec: false,
                                                waybill: (D.w[r[6]] || '') + (r[7] || ''), routeId: D.r[r[8]] || '', ordre: (r[9] === null) ? NaN : r[9],
                                                depot: D.s[r[10]] || '', ville: D.v[r[11]] || '', latTheo: fv(r[12]), lonTheo: fv(r[13]),
                                                tsDebut: r[14] ? (base + r[14]) * 1000 : null, upload: r[15] || 0 }));
                }
                // Ancien format (v1)
                return obj.map(p => ({ date: p.d, courier: p.c, tsLivraison: p.t,
                                       lat: isFinite(p.y) ? p.y : NaN, lon: isFinite(p.x) ? p.x : NaN, cp: p.p || '', echec: false,
                                       waybill: p.w || '', routeId: p.r || '', ordre: isFinite(p.o) ? p.o : NaN,
                                       depot: p.s || '', ville: p.v || '', latTheo: isFinite(p.ty) ? p.ty : NaN, lonTheo: isFinite(p.tx) ? p.tx : NaN,
                                       tsDebut: p.b || null, upload: p.u || 0 }));
            } catch (e) { console.warn('[Détection] décompression', mois, e); return null; }
        }

        /**
         * Relance la détection à partir des points mémorisés, sans fichier.
         * @returns {boolean} true si la détection a pu être rejouée
         */
        function relancerDetectionDepuisMemoire(mois) {
            const recs = lirePointsDetection(mois);
            if (!recs || !recs.length) return false;
            const principales = detecterTourneesSimultanees(recs);
            const anomalies = [...principales, ...(principales._sousSeuil || [])];
            if (!data.renfortsQualite) data.renfortsQualite = {};
            data.renfortsQualite[mois] = principales._qualite || null;
            // On ne conserve que les refus explicites (« rien à corriger »).
            // Un statut « affecté » ne doit pas survivre à une relance : les
            // transferts automatiques viennent d'être effacés et doivent être
            // recréés, sinon la détection reste sans effet.
            const decisions = {};
            (data.anomaliesTournees?.[mois] || []).forEach(a => {
                if (a.statut === 'ignore') decisions[a.id] = 'ignore';
            });
            if (!data.anomaliesTournees) data.anomaliesTournees = {};
            data.anomaliesTournees[mois] = anomalies.map(a =>
                decisions[a.id] ? { ...a, statut: decisions[a.id] } : a);
            if (Array.isArray(data.transfertsColis?.[mois])) {
                data.transfertsColis[mois] = data.transfertsColis[mois].filter(t => t.mode !== 'auto');
            }
            delete data._detectionARefaire;
            appliquerAnomaliesCertaines(true);
            markUnsaved(); saveLocal();
            return true;
        }

        /**
         * Lance (ou relance) la détection des tournées simultanées.
         * La détection a besoin des coordonnées et de l'heure de CHAQUE colis :
         * ces informations ne sont pas conservées dans l'historique agrégé, il
         * faut donc relire le fichier EPOD du mois.
         */
        // APP_VERSION : voir js/core/config.js
        // La version est affichée dans l'en-tête : c'est le moyen le plus simple
        // de vérifier que le fichier servi est bien le dernier déployé. Un cache
        // navigateur ou CDN peut continuer à servir une version antérieure
        // pendant des heures sans aucun autre signe visible.
        document.addEventListener('DOMContentLoaded', () => {
            const b = document.getElementById('badgeVersionApp');
            if (b) b.textContent = APP_VERSION;
        });

        /** État complet du module de réaffectation, pour lever tout doute. */
        function ouvrirDiagnostic() {
            const mois = selectedHistoriqueMonth;
            const hist = data.historiqueEPOD?.[mois] || {};
            const anos = data.anomaliesTournees?.[mois] || [];
            const trs  = data.transfertsColis?.[mois] || [];
            const pts  = data.pointsDetection?.[mois];
            const md   = appliquerTransfertsMois(hist, mois);

            const l = (k, v, ok) => `<tr>
                <td style="padding:0.3rem 0.6rem;color:var(--text-secondary);">${k}</td>
                <td style="padding:0.3rem 0.6rem;font-family:monospace;font-weight:700;color:${ok === false ? 'var(--danger)' : ok === true ? 'var(--success)' : 'var(--text)'};">${escapeHtml(v)}</td></tr>`;

            const parLivreur = Object.entries(md)
                .filter(([, v]) => (v.totalCedes || v.totalRecus))
                .map(([n, v]) => `<tr><td style="padding:0.25rem 0.6rem;">${escapeHtml(n)}</td>
                    <td style="padding:0.25rem 0.6rem;font-family:monospace;">${v.totalLivres} livrés → <strong>${v.totalRemunerables} payés</strong>
                    ${v.totalCedes ? `<span style="color:var(--secondary);">−${v.totalCedes}</span>` : ''}
                    ${v.totalRecus ? `<span style="color:var(--primary);">+${v.totalRecus}</span>` : ''}</td></tr>`).join('')
                || '<tr><td colspan="2" style="padding:0.4rem 0.6rem;font-style:italic;color:var(--text-secondary);">aucune réaffectation en cours</td></tr>';

            const o = document.createElement('div');
            o.className = 'modal-overlay active modal-dynamique';
            o.style.zIndex = '99999';
            o.innerHTML = `
              <div class="modal" style="max-width:640px;">
                <div class="modal-header">
                  <h3 style="margin:0;"><i class="fas fa-stethoscope"></i> Diagnostic — ${escapeHtml(formatMonthName(mois))}</h3>
                  <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body" style="padding:1rem 1.25rem 1.25rem;max-height:70vh;overflow-y:auto;font-size:0.86rem;">
                  <table style="width:100%;border-collapse:collapse;margin-bottom:1rem;">
                    ${l('Version de l\'application', APP_VERSION, true)}
                    ${l('Livreurs dans l\'historique', Object.keys(hist).length, Object.keys(hist).length > 0)}
                    ${l('Points de détection mémorisés', pts ? `oui (${Math.round(pts.length / 1024)} Ko)` : 'non — réimport nécessaire', !!pts)}
                    ${l('Journées à plusieurs détectées', anos.length, anos.length > 0)}
                    ${l('Colis en livraison anormale', anos.reduce((a, x) => a + x.nbColis, 0))}
                    ${l('… dont livreur certain', anos.filter(a => a.confiance === 'certain').length)}
                    ${l('… déjà réaffectées', anos.filter(a => a.statut === 'affecte').length)}
                    ${l('… écartées manuellement', anos.filter(a => a.statut === 'ignore').length)}
                    ${l('… en attente de décision', anos.filter(a => a.statut === 'a_traiter').length)}
                    ${l('Transferts actifs', `${trs.length} (${trs.reduce((a, t) => a + t.nb, 0)} colis)`, trs.length > 0)}
                    ${l('Cohérence statuts / transferts',
                        anos.filter(a => a.statut === 'affecte' && !trs.some(t => t.date === a.date && t.de === a.compte)).length === 0
                            ? 'OK' : 'incohérence — cliquez sur Détecter les renforts',
                        anos.filter(a => a.statut === 'affecte' && !trs.some(t => t.date === a.date && t.de === a.compte)).length === 0)}
                    ${l('Règles de la grille', (getGrilleRemuneration() || []).length, (getGrilleRemuneration() || []).length > 0)}
                    ${l('Comptes techniques', (getComptesTechniques() || []).join(', ') || '—')}
                  </table>
                  <strong>Effet sur les livreurs</strong>
                  <table style="width:100%;border-collapse:collapse;margin-top:0.4rem;">${parLivreur}</table>
                  ${!pts ? `<div style="margin-top:1rem;padding:0.7rem 0.9rem;border-radius:8px;background:rgba(255,149,0,0.12);border-left:3px solid var(--warning);">
                      <strong style="color:var(--warning);">Action requise</strong><br>
                      Les positions des colis ne sont pas mémorisées pour ce mois. Cliquez sur
                      <strong>Détecter les renforts</strong> et sélectionnez le fichier EPOD :
                      elles seront conservées, et les prochaines détections se feront sans fichier.
                    </div>` : ''}
                </div>
              </div>`;
            document.body.appendChild(o);
        }

        /**
         * Ferme les fenêtres créées à la volée (diagnostic, transferts, ajout
         * rapide…), et UNIQUEMENT celles-là.
         *
         * Les modales de l'application — ajout et modification d'un livreur,
         * gestion des données, facture, paramètres — sont écrites en dur dans
         * le HTML et portent elles aussi la classe .modal-overlay. Les retirer
         * du DOM les détruit définitivement : les boutons correspondants
         * n'ouvrent plus rien jusqu'au rechargement de la page. D'où le
         * marqueur .modal-dynamique, posé à la création.
         */
        function fermerModalesDynamiques() {
            document.querySelectorAll('.modal-overlay.modal-dynamique').forEach(o => o.remove());
        }

        // ═══════════════════════════════════════════════════════════════════
        // AJOUT RAPIDE D'UN LIVREUR (v49)
        // ───────────────────────────────────────────────────────────────────
        // Depuis l'onglet salaires, sans changer d'écran ni perdre le contexte.
        // Le nom vient de l'export, le reste est pré-rempli avec des valeurs
        // raisonnables : l'objectif est trois clics, pas un formulaire complet.
        // La fiche reste modifiable ensuite dans l'onglet Livreurs.
        // ═══════════════════════════════════════════════════════════════════

        function ouvrirAjoutLivreurRapide(nomExport) {
            // Un nom d'export ressemble à « Prénom-Site » : on en tire un prénom
            // exploitable, tout en gardant le nom brut comme alias de rattachement.
            const brut = String(nomExport || '').trim();
            const prenom = brut.split(/[-_\s]/)[0] || brut;

            // Estimation du volume moyen, pour situer le contrat proposé
            const md = appliquerTransfertsMois(data.historiqueEPOD?.[selectedHistoriqueMonth] || {}, selectedHistoriqueMonth);
            const liv = md[brut];
            const jours = liv ? Object.keys(liv.jours || {}).length : 0;
            const colis = liv ? (liv.totalRemunerables ?? liv.totalLivres ?? 0) : 0;
            const moyenne = jours ? Math.round(colis / jours) : 0;

            const o = document.createElement('div');
            o.className = 'modal-overlay active modal-dynamique';
            o.style.zIndex = '99999';
            o.innerHTML = `
              <div class="modal" style="max-width:520px;">
                <div class="modal-header">
                  <h3 style="margin:0;"><i class="fas fa-user-plus"></i> Ajouter ${escapeHtml(brut)}</h3>
                  <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body" style="padding:1rem 1.25rem 1.25rem;">
                  ${jours ? `<div style="margin-bottom:0.9rem;padding:0.5rem 0.75rem;background:var(--background-light);border-radius:8px;font-size:0.82rem;color:var(--text-secondary);">
                      <strong style="color:var(--text);">${colis} colis</strong> sur ${jours} jour(s) ce mois-ci,
                      soit <strong style="color:var(--text);">${moyenne} colis/jour</strong> en moyenne.
                    </div>` : ''}
                  <div style="display:flex;gap:0.6rem;flex-wrap:wrap;">
                    <div class="form-group" style="flex:1;min-width:150px;margin-bottom:0.7rem;">
                      <label class="form-label" style="font-size:0.8rem;">Prénom</label>
                      <input type="text" class="form-input" id="qlPrenom" value="${escAttr(prenom)}">
                    </div>
                    <div class="form-group" style="flex:1;min-width:150px;margin-bottom:0.7rem;">
                      <label class="form-label" style="font-size:0.8rem;">Nom</label>
                      <input type="text" class="form-input" id="qlNom" placeholder="facultatif">
                    </div>
                  </div>
                  <div class="form-group" style="margin-bottom:0.7rem;">
                    <label class="form-label" style="font-size:0.8rem;">Type de contrat</label>
                    <select class="form-input" id="qlContrat" onchange="_qlMajContrat()">
                      <option value="salarie">Salarié — grille de rémunération</option>
                      <option value="autoentrepreneur-vehicule">Auto-entrepreneur, véhicule entreprise — grille + ${(data.bonusAeVehicule ?? 10).toFixed(2)} €/jour</option>
                      <option value="auto-entrepreneur" selected>Auto-entrepreneur — prix au colis</option>
                    </select>
                  </div>
                  <div class="form-group" style="margin-bottom:0.7rem;" id="qlGroupeTaux">
                    <label class="form-label" style="font-size:0.8rem;">Prix par colis (€)</label>
                    <input type="number" class="form-input" id="qlTaux" value="1.40" step="0.01" min="0" oninput="_qlApercu()">
                  </div>
                  <div style="margin-bottom:0.9rem;padding:0.55rem 0.75rem;border-radius:8px;font-size:0.82rem;
                              background:rgba(43,110,143,0.08);border-left:3px solid var(--primary);">
                    <strong>Salaire du mois avec ce contrat :</strong>
                    <span id="qlApercu" style="font-weight:800;color:var(--success);"></span>
                  </div>
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;">
                    <span style="font-size:0.75rem;color:var(--text-secondary);">
                      Rattaché au compte <code>${escapeHtml(brut)}</code>. Complétez la fiche dans l'onglet Livreurs.
                    </span>
                    <button class="btn btn-primary" onclick="validerAjoutLivreurRapide('${escJsAttr(brut)}')">
                      <i class="fas fa-check"></i> Ajouter
                    </button>
                  </div>
                </div>
              </div>`;
            document.body.appendChild(o);
            _qlMajContrat();
        }

        function _qlMajContrat() {
            const c = document.getElementById('qlContrat')?.value;
            const g = document.getElementById('qlGroupeTaux');
            if (g) g.style.display = (c === 'auto-entrepreneur') ? '' : 'none';
            _qlApercu();
        }

        /** Montre ce que le livreur toucherait ce mois-ci avec le contrat choisi. */
        function _qlApercu() {
            const out = document.getElementById('qlApercu');
            if (!out) return;
            const nom = document.querySelector('.modal-overlay:last-of-type .modal-header h3')?.textContent.replace(/^\s*Ajouter\s*/, '').trim();
            const md = appliquerTransfertsMois(data.historiqueEPOD?.[selectedHistoriqueMonth] || {}, selectedHistoriqueMonth);
            const liv = md[nom];
            if (!liv) { out.textContent = '—'; return; }
            const contrat = document.getElementById('qlContrat')?.value || 'auto-entrepreneur';
            const taux = parseFloat(document.getElementById('qlTaux')?.value) || 0;
            try {
                const calc = calculerSalaireMensuel(liv, { contrat, taux });
                out.textContent = calc.salaire.toFixed(2).replace('.', ',') + ' €';
            } catch (e) { out.textContent = '—'; }
        }

        function validerAjoutLivreurRapide(nomExport) {
            const prenom = document.getElementById('qlPrenom')?.value.trim() || '';
            const nom    = document.getElementById('qlNom')?.value.trim() || '';
            const contrat = document.getElementById('qlContrat')?.value || 'auto-entrepreneur';
            const taux = parseFloat(document.getElementById('qlTaux')?.value) || 1.4;
            if (!prenom && !nom) { showToast('Indiquez au moins un prénom', 'warning'); return; }

            const nouveau = {
                id: Date.now().toString(),
                nom: nom || nomExport, prenom,
                tel: '', email: '', contrat, taux,
                dateContrat: '', iban: '',
                minColis: 80, maxColis: 160,
                secteurs_prioritaires: [],
                disponibilites: ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam'],
                notes: `Créé depuis l'onglet salaires · compte export : ${nomExport}`,
                actif: true,
                modifications: [{ date: new Date().toISOString(), action: 'Création depuis les salaires' }]
            };
            data.livreurs.push(nouveau);

            // Vérifie que le rattachement fonctionne : sans cela le livreur
            // resterait « non configuré » malgré sa création.
            if (typeof matchLivreur === 'function' && !matchLivreur(nomExport)) {
                nouveau.prenom = nomExport;
                if (!matchLivreur(nomExport)) {
                    showToast(`${prenom || nom} ajouté, mais le rattachement au compte « ${nomExport} » a échoué — vérifiez le nom dans l'onglet Livreurs`, 'warning');
                }
            }

            markUnsaved(); saveLocal();
            fermerModalesDynamiques();
            refreshHistorique();
            // updateUI() rafraîchit toute l'application ; un écran non encore
            // rendu ne doit pas faire échouer la création du livreur.
            try { if (typeof updateUI === 'function') updateUI(); }
            catch (e) { console.warn('[Livreur] rafraîchissement partiel', e); }
            showToast(`${prenom || nom} ajouté et rattaché`, 'success');
        }

        function lancerDetectionRenforts() {
            const mois = selectedHistoriqueMonth;
            // Si les points de ce mois sont mémorisés, aucun fichier n'est nécessaire.
            if (data.pointsDetection?.[mois]) {
                if (relancerDetectionDepuisMemoire(mois)) {
                    refreshHistorique();
                    const n = (data.transfertsColis?.[mois] || []).filter(t => t.mode === 'auto')
                                .reduce((a, t) => a + t.nb, 0);
                    const nb = getAnomaliesMois(mois).filter(a => !a.sousSeuil && a.statut !== 'info').length;
                    showToast(n ? `${n} colis réaffectés au livreur qui les a livrés` : (nb ? `${nb} cas à examiner` : 'Aucun renfort détecté ce mois-ci'), n ? 'success' : 'info');
                    return;
                }
            }
            const deja = getAnomaliesMois(mois).length;
            const msg = deja
                ? `Relancer la détection pour ${formatMonthName(mois)} ?\n\nSélectionnez le fichier EPOD du mois. Les colis livrés par un renfort seront recomptés pour le bon livreur. Vos décisions manuelles sont conservées.`
                : `Détecter les renforts pour ${formatMonthName(mois)} ?\n\nSélectionnez le fichier EPOD du mois : l'application repère les journées livrées par plusieurs personnes sous un même compte et recompte les colis pour le livreur qui les a réellement livrés.`;
            if (!confirm(msg)) return;
            document.getElementById('epodInput').click();
        }

        function getAnomaliesMois(mois) {
            return (data.anomaliesTournees && data.anomaliesTournees[mois]) || [];
        }

        function renderAnomaliesTournees() {
            const c = document.getElementById('anomaliesTourneesBloc');
            if (!c) return;
            const mois = selectedHistoriqueMonth;
            const toutes = getAnomaliesMois(mois);
            // Liste principale = groupes ≥ 5 colis livrés sous le compte d'un autre.
            const principales = toutes.filter(a => !a.sousSeuil && a.statut !== 'info');
            const sousSeuil = toutes.filter(a => a.sousSeuil);
            const infos = toutes.filter(a => !a.sousSeuil && a.statut === 'info');
            const aTraiter = principales.filter(a => a.statut === 'a_traiter');

            // v46 — les données d'une version antérieure ne contiennent pas les
            // informations nécessaires à la réaffectation. Un réimport les régénère.
            let bandeau = '';
            if (data._detectionARefaire || (toutes.length && toutes.some(a => a.score === undefined))) {
                bandeau = `
                  <div style="margin-bottom:1rem;padding:0.85rem 1rem;border-radius:8px;
                              background:rgba(255,149,0,0.12);border-left:3px solid var(--warning);">
                    <div style="font-weight:700;color:var(--warning);margin-bottom:0.3rem;">
                        <i class="fas fa-rotate"></i> Relancez la détection
                    </div>
                    <div style="font-size:0.85rem;color:var(--text-secondary);">
                        Les détections enregistrées proviennent d'une version antérieure de l'algorithme.
                        ${data.pointsDetection?.[mois] ? 'Cliquez sur « Détecter les renforts » : aucun fichier n\'est nécessaire.' : 'Réimportez le fichier EPOD du mois.'}
                    </div>
                    <button class="btn btn-primary btn-sm" style="margin-top:0.5rem;" onclick="lancerDetectionRenforts()">
                        <i class="fas fa-user-friends"></i> Détecter les renforts
                    </button>
                  </div>`;
            }

            if (!toutes.length) {
                const aDesDonnees = Object.keys(data.historiqueEPOD?.[mois] || {}).length > 0;
                c.innerHTML = bandeau + (aDesDonnees ? `
                  <div style="margin-bottom:1rem;padding:0.75rem 1rem;border-radius:8px;
                              background:rgba(43,110,143,0.08);border-left:3px solid var(--primary);">
                    <div style="font-weight:700;color:var(--primary);margin-bottom:0.25rem;">
                        <i class="fas fa-user-friends"></i> Renforts non analysés pour ce mois
                    </div>
                    <div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:0.55rem;">
                        Quand un livreur en aide un autre sans que le transfert soit enregistré dans l'outil de
                        dispatch, ses colis restent comptés au titulaire du compte — et lui ne les touche pas.
                        Lancez la détection pour que chacun soit payé sur ce qu'il a réellement livré.
                    </div>
                    <button class="btn btn-primary btn-sm" onclick="lancerDetectionRenforts()">
                        <i class="fas fa-user-friends"></i> Détecter les renforts
                    </button>
                  </div>` : '');
                return;
            }

            bandeau += _htmlControleCoherence(mois);
            const total = aTraiter.reduce((a, x) => a + x.nbColis, 0);
            const certains = aTraiter.filter(a => a.confiance === 'certain');
            const colisCertains = certains.reduce((a, x) => a + x.nbColis, 0);
            const dejaFait = principales.filter(a => a.statut === 'affecte');
            const colisFaits = dejaFait.reduce((a, x) => a + x.nbColis, 0);
            const ignores = principales.filter(a => a.statut === 'ignore').length;

            const boutonsCommuns = `
                <button class="btn btn-sm" onclick="ouvrirDetailAnomalies()"
                        style="background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);">
                    <i class="fas fa-search"></i> Examiner${sousSeuil.length ? ` <span style="opacity:0.8;">(+${sousSeuil.length} cas &lt; 5 colis)</span>` : ''}
                </button>
                <button class="btn btn-sm" onclick="ouvrirTransfertManuel()"
                        style="background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);">
                    <i class="fas fa-exchange-alt"></i> Transfert manuel
                </button>
                <button class="btn btn-sm" onclick="lancerDetectionRenforts()" title="Relancer l'analyse à partir des points mémorisés"
                        style="background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);">
                    <i class="fas fa-rotate"></i> Relancer
                </button>`;

            const rappelAuto = dejaFait.length ? `
                <div style="margin-bottom:0.5rem;padding:0.5rem 0.8rem;border-radius:8px;font-size:0.82rem;
                            background:rgba(45,212,163,0.1);border-left:3px solid var(--success);">
                    <strong style="color:var(--success);"><i class="fas fa-check-circle"></i>
                    ${colisFaits} colis réaffectés</strong>
                    <span style="color:var(--text-secondary);"> sur ${dejaFait.length} cas (${dejaFait.filter(a => a.confiance === 'certain').length} automatiques, catégorie « Certain »).</span>
                </div>` : '';

            if (!aTraiter.length) {
                c.innerHTML = bandeau + `
                  <div style="margin-bottom:1rem;padding:0.65rem 0.9rem;border-radius:8px;font-size:0.85rem;
                              background:rgba(45,212,163,0.1);border-left:3px solid var(--success);">
                    <strong style="color:var(--success);"><i class="fas fa-check-circle"></i>
                    ${colisFaits} colis réaffectés au livreur réel</strong>
                    <span style="color:var(--text-secondary);"> — ${principales.length} cas traités${ignores ? ` (${ignores} écartés)` : ''}${sousSeuil.length ? ` · ${sousSeuil.length} cas &lt; 5 colis à vérifier manuellement` : ''}${infos.length ? ` · ${infos.length} transfert(s) déjà reflétés dans la paie` : ''}.</span>
                    <div style="margin-top:0.45rem;display:flex;gap:0.4rem;flex-wrap:wrap;">${boutonsCommuns}</div>
                  </div>`;
                return;
            }

            const boutonLot = certains.length ? `
                <button class="btn btn-primary btn-sm" onclick="appliquerAnomaliesCertaines()">
                    <i class="fas fa-magic"></i> Réaffecter les ${certains.length} cas certains (${colisCertains} colis)
                </button>` : '';
            const parCat = {};
            aTraiter.forEach(a => { const k = a.categorie || 'Non classé'; parCat[k] = (parCat[k] || 0) + 1; });
            c.innerHTML = bandeau + rappelAuto + `
              <div style="margin-bottom:1rem;padding:0.85rem 1rem;border-radius:8px;
                          background:rgba(255,149,0,0.1);border-left:3px solid var(--warning);">
                <div style="font-weight:700;color:var(--warning);margin-bottom:0.35rem;">
                    <i class="fas fa-triangle-exclamation"></i> ${aTraiter.length} renfort(s) probable(s) · ${total} colis à recompter
                </div>
                <div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:0.6rem;">
                    ${Object.entries(parCat).map(([k, n]) => `<span style="display:inline-block;margin-right:0.6rem;"><strong style="color:var(--text);">${n}</strong> ${escapeHtml(k)}</span>`).join('')}
                    <br>Ces colis ont été livrés sous un compte par une autre personne que son titulaire.
                    Les cas « Certain » sont réaffectés automatiquement ; les autres attendent votre décision après examen.
                    ${sousSeuil.length ? `<br><span style="color:var(--warning);">${sousSeuil.length} cas de moins de 5 colis</span> sont signalés à part et ne sont jamais réaffectés sans votre validation.` : ''}
                </div>
                <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">${boutonLot}${boutonsCommuns}</div>
              </div>`;
        }


        /**
         * RÈGLE GÉNÉRALE (v45) — un colis est payé au livreur qui l'a livré.
         * Quand la détection identifie ce livreur sans ambiguïté (même secteur,
         * disponible sur tout le créneau, aucun autre candidat proche), la
         * réaffectation est appliquée AUTOMATIQUEMENT, pour tous les livreurs,
         * sans intervention. Seuls les cas incertains sont soumis à décision.
         * @param {boolean} silencieux  true à l'import (pas de toast ni de rendu)
         */
        /**
         * Remet à « à traiter » toute détection marquée réaffectée dont le
         * transfert n'existe plus. Sans ce contrôle, une anomalie gardait un
         * statut « affecté » mensonger : la réaffectation était refusée au motif
         * qu'elle avait déjà eu lieu, alors qu'aucun colis n'avait changé de main.
         * C'est exactement ce qui se produisait après une remise à zéro, un
         * changement d'appareil ou une restauration cloud partielle.
         * @returns {number} nombre de détections remises en attente
         */
        function reconcilierAnomaliesEtTransferts() {
            let remises = 0;
            Object.entries(data.anomaliesTournees || {}).forEach(([mois, liste]) => {
                const trs = data.transfertsColis?.[mois] || [];
                (liste || []).forEach(a => {
                    if (a.statut !== 'affecte') return;
                    const existe = trs.some(t => t.date === a.date && t.de === a.compte);
                    if (!existe) { a.statut = 'a_traiter'; remises++; }
                });
            });
            return remises;
        }

        function appliquerAnomaliesCertaines(silencieux) {
            let n = 0, colis = 0;
            const details = [];
            // Les statuts sont réalignés sur la réalité avant toute décision.
            reconcilierAnomaliesEtTransferts();
            Object.entries(data.anomaliesTournees || {}).forEach(([mois, liste]) => {
                if (moisEstCloture(mois)) return;   // v51 — mois figé
                // v50 — réaffectation automatique UNIQUEMENT pour les colis livrés
                // sous le compte d'un autre (double séquence), en catégorie
                // « Certain », et au-dessus du seuil de 5 colis. Les cas
                // « vue zone » et « dispatch » sont déjà comptés au bon livreur.
                liste.filter(a => a.statut === 'a_traiter' && a.confiance === 'certain' && a.candidats[0]
                                && !a.sousSeuil && !a.directionInverse && (a.type === 'double_sequence' || !a.type))
                     .forEach(a => {
                    const t = enregistrerTransfert({
                        mois, date: a.date, de: a.compte, vers: a.candidats[0].nom, nb: a.nbColis,
                        mode: 'auto',
                        note: `Renfort ${a.categorie || 'certain'} ${a.score !== undefined ? a.score + '/100 ' : ''}${a.debut}–${a.fin} · ${a.zone || (a.candidats[0].cpsCommuns || []).join(', ')}`
                    });
                    if (t) {
                        a.statut = 'affecte';
                        n++; colis += a.nbColis;
                        details.push({ date: a.date, de: a.compte, vers: a.candidats[0].nom, nb: a.nbColis });
                    }
                });
            });
            if (n) { markUnsaved(); saveLocal(); }
            if (!silencieux) {
                refreshHistorique();
                showToast(n ? `${colis} colis réaffectés sur ${n} journée(s)` : 'Aucun cas certain à appliquer', n ? 'success' : 'info');
            }
            return { n, colis, details };
        }

        /** Couleur/icône/libellé par catégorie de confiance. */
        function _styleCategorie(cat) {
            return {
                'Certain':       ['rgba(45,212,163,0.15)', 'var(--success)', 'check-circle'],
                'Très probable': ['rgba(45,212,163,0.10)', 'var(--success)', 'check'],
                'Probable':      ['rgba(255,149,0,0.14)', 'var(--warning)', 'question-circle'],
                'Possible':      ['rgba(232,89,12,0.10)', 'var(--secondary)', 'exclamation-circle'],
                'Inconclusif':   ['rgba(120,120,120,0.10)', 'var(--text-secondary)', 'minus-circle']
            }[cat] || ['rgba(120,120,120,0.10)', 'var(--text-secondary)', 'minus-circle'];
        }

        function _ligneRenfort(a, options) {
            const o = options || {};
            const traite = a.statut !== 'a_traiter' && a.statut !== 'info';
            const info = a.statut === 'info';
            const c0 = a.candidats[0];
            const [bg, col, ico] = _styleCategorie(a.categorie);
            const cps = (a.codesPostaux || []).map(([cp, n]) => `${escapeHtml(cp)} (${escapeHtml(n)})`).join(' · ') || '—';
            const fleche = info
                ? `<strong>${escapeHtml(c0 ? c0.nom : '?')}</strong> <i class="fas fa-arrow-right" style="opacity:0.6;"></i> <strong>${escapeHtml(a.compte)}</strong>`
                : `<strong>${escapeHtml(a.compte)}</strong> <i class="fas fa-arrow-right" style="opacity:0.6;"></i> <strong>${escapeHtml(c0 ? c0.nom : '?')}</strong>`;
            const niveau = a.niveau ? { 1: 'preuve directe', 2: 'absence + détour', 3: 'inférence' }[a.niveau] : 'source non identifiée';
            const candidats = a.candidats.length
                ? a.candidats.map((cd, i) => `
                    <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;padding:0.35rem 0;${i ? 'opacity:0.75;' : ''}">
                        ${info ? `<strong>${escapeHtml(cd.nom)}</strong>` : `
                        <button class="btn btn-sm ${i === 0 ? 'btn-primary' : ''}"
                                style="${i === 0 ? '' : 'background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);'}"
                                onclick="confirmerAffectation('${escJsAttr(a.id)}','${escJsAttr(cd.nom)}')">
                            <i class="fas fa-arrow-right"></i> ${escapeHtml(cd.nom)}
                        </button>`}
                        <span style="font-size:0.78rem;color:var(--text-secondary);">
                            N${cd.niveau} · ${cd.score}/100
                            · absent ${escapeHtml(cd.absentDe)}–${escapeHtml(cd.absentA)} (${cd.recouvrementPct}&nbsp;% de la fenêtre${cd.colisDansFenetre ? `, ${cd.colisDansFenetre} colis livrés pendant` : ''})
                            ${cd.detourKm !== null ? `· détour ${cd.detourKm}&nbsp;km, ${cd.tempsDispoMin}&nbsp;min dispo, ${cd.vitesseNecessaire === null ? '—' : cd.vitesseNecessaire + '&nbsp;km/h'} nécessaire (${cd.faisable ? 'faisable' : 'difficile'})` : ''}
                            ${cd.colisRouteA ? `· <strong style="color:var(--success);">${cd.colisRouteA} colis de la route de ${escapeHtml(a.compte)} livrés sous son compte</strong>` : ''}
                            · connaît la zone ${cd.cpPct}&nbsp;%
                        </span>
                    </div>`).join('')
                : '<em style="color:var(--text-secondary);font-size:0.82rem;">aucun autre livreur actif ce jour-là dans ce dépôt</em>';

            return `
            <div style="padding:0.85rem;border:1px solid var(--border);border-radius:8px;margin-bottom:0.75rem;
                        background:${traite ? 'var(--background-light)' : 'var(--card)'};opacity:${traite ? 0.65 : 1};">
                <div style="display:flex;justify-content:space-between;align-items:start;gap:0.75rem;flex-wrap:wrap;">
                    <div style="flex:1;min-width:240px;">
                        <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
                            <span style="background:${bg};color:${col};padding:2px 9px;border-radius:8px;font-size:0.72rem;font-weight:800;">
                                <i class="fas fa-${ico}"></i> ${escapeHtml(a.categorie || a.confiance || '')} · ${a.score !== undefined ? a.score : '—'}/100
                            </span>
                            ${a.sousSeuil ? `<span style="background:rgba(255,149,0,0.14);color:var(--warning);padding:2px 8px;border-radius:8px;font-size:0.7rem;font-weight:700;">&lt; 5 colis · hors calcul</span>` : ''}
                            ${info ? `<span style="background:rgba(43,110,143,0.14);color:var(--primary);padding:2px 8px;border-radius:8px;font-size:0.7rem;font-weight:700;">déjà compté au bon livreur</span>` : ''}
                            ${traite ? `<span style="background:rgba(45,212,163,0.15);color:var(--success);padding:1px 8px;border-radius:8px;font-size:0.7rem;font-weight:700;">${a.statut === 'affecte' ? 'réaffecté' : 'écarté'}</span>` : ''}
                            ${a.recurrence >= 3 ? `<span title="Même paire détectée ${a.recurrence} fois ce mois" style="background:rgba(43,110,143,0.14);color:var(--primary);padding:1px 8px;border-radius:8px;font-size:0.7rem;font-weight:700;"><i class="fas fa-repeat"></i> récurrent ×${a.recurrence}</span>` : ''}
                            ${c0 && c0.histValide >= 2 ? `<span title="Vous avez déjà validé ${c0.histValide} fois ce renfort" style="background:rgba(45,212,163,0.10);color:var(--success);padding:1px 8px;border-radius:8px;font-size:0.7rem;font-weight:700;"><i class="fas fa-graduation-cap"></i> déjà validé ×${c0.histValide}</span>` : ''}
                        </div>
                        <div style="margin-top:0.4rem;font-size:0.95rem;">${fleche}
                            <span style="color:var(--text-secondary);font-size:0.85rem;"> — ${escapeHtml(a.date)}${a.depot ? ` · ${escapeHtml(a.depot)}` : ''}</span></div>
                        <div style="font-size:0.85rem;color:var(--text-secondary);margin-top:0.3rem;">
                            <strong style="color:var(--text);">${a.nbColis} colis</strong> · ${escapeHtml(a.debut)}–${escapeHtml(a.fin)} (${a.dureeMinutes} min)
                            · zone <strong style="color:var(--text);">${escapeHtml(a.zone || '')}</strong> · CP ${cps}
                            ${a.distanceKm !== null && a.distanceKm !== undefined ? `<br>Détour ${a.distanceKm} km · temps disponible ${a.tempsDispoMin} min · vitesse nécessaire ${a.vitesseNecessaire === null ? '—' : a.vitesseNecessaire + ' km/h'}` : ''}
                            · attribution : ${niveau}
                            <br><span style="color:var(--text);">${escapeHtml(a.explicationCourte || '')}</span>
                        </div>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:0.3rem;">
                        <button class="btn btn-sm" onclick="ouvrirDetailRenfort('${escJsAttr(a.id)}')"
                                style="background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);">
                            <i class="fas fa-list"></i> Détail &amp; colis
                        </button>
                        ${(a.colis && a.colis.length && typeof L !== 'undefined') ? `
                        <button class="btn btn-sm" onclick="ouvrirCarteRenfort('${escJsAttr(a.id)}')"
                                style="background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);">
                            <i class="fas fa-map"></i> Carte
                        </button>` : ''}
                    </div>
                </div>
                ${(traite || o.compact) ? '' : `
                <div style="margin-top:0.7rem;padding-top:0.6rem;border-top:1px dashed var(--border);">
                    <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.2rem;">
                        ${info ? 'Livreur source (colis déjà comptés pour ' + escapeHtml(a.compte) + ') :' : `Qui a réellement livré ces ${a.nbColis} colis ?`}
                    </div>
                    ${candidats}
                    ${info ? '' : `
                    <button class="btn btn-sm" style="margin:2px;background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);"
                            onclick="choisirAutreLivreur('${escJsAttr(a.id)}')">
                        <i class="fas fa-user"></i> Un autre livreur…
                    </button>
                    <button class="btn btn-sm" style="margin:2px;background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);"
                            onclick="ignorerAnomalie('${escJsAttr(a.id)}')">
                        <i class="fas fa-times"></i> Rien à corriger
                    </button>`}
                </div>`}
            </div>`;
        }

        function ouvrirDetailAnomalies() {
            const mois = selectedHistoriqueMonth;
            const toutes = getAnomaliesMois(mois);
            if (!toutes.length) { showToast('Aucune anomalie pour ce mois', 'info'); return; }
            const rang = a => (a.statut === 'a_traiter' ? 0 : 1);
            const tri = (x, y) => rang(x) - rang(y) || (y.score || 0) - (x.score || 0) || y.nbColis - x.nbColis || x.date.localeCompare(y.date);
            const principales = toutes.filter(a => !a.sousSeuil && a.statut !== 'info').sort(tri);
            const sousSeuil = toutes.filter(a => a.sousSeuil).sort(tri);
            const infos = toutes.filter(a => !a.sousSeuil && a.statut === 'info').sort(tri);
            const q = data.renfortsQualite?.[mois];
            const qd = q && q.detection;
            const pct = (n, d) => d ? Math.round(n / d * 100) + ' %' : '—';
            const qualiteHtml = qd ? `
                <details style="margin-bottom:0.85rem;font-size:0.8rem;color:var(--text-secondary);">
                    <summary style="cursor:pointer;font-weight:700;color:var(--text);"><i class="fas fa-stethoscope"></i> Qualité des données (${qd.livres} colis livrés${qd.dureeMs !== undefined ? `, analyse en ${qd.dureeMs} ms` : ''})</summary>
                    <div style="display:flex;gap:0.6rem;flex-wrap:wrap;margin-top:0.4rem;">
                        ${[['GPS', qd.gps], ['Heure', qd.heure], ['N° colis', qd.waybill], ['Dépôt', qd.depot], ['Ordre planifié', qd.ordre]].map(([l, v]) => `<span><strong>${l}</strong> ${pct(v, qd.livres)}</span>`).join('')}
                        <span><strong>Positions aberrantes</strong> ${qd.aberrants}</span>
                        <span><strong>Horodatages inversés</strong> ${qd.dtNegatifs}</span>
                        <span><strong>Dépôts</strong> ${Object.keys(qd.depots || {}).map(escapeHtml).join(', ') || '—'}</span>
                        ${q.heuresNonParsees ? `<span style="color:var(--warning);"><strong>Heures non lues</strong> ${q.heuresNonParsees}</span>` : ''}
                    </div>
                    ${(q.avertissements || []).map(w => `<div style="margin-top:0.3rem;color:var(--warning);"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(w)}</div>`).join('')}
                </details>` : '';

            const section = (titre, liste, intro, opts) => liste.length ? `
                <h4 style="margin:1rem 0 0.4rem;font-size:0.95rem;">${titre} <span style="color:var(--text-secondary);font-weight:400;">(${liste.length})</span></h4>
                ${intro ? `<p style="font-size:0.82rem;color:var(--text-secondary);margin:0 0 0.6rem;">${intro}</p>` : ''}
                ${liste.map(a => _ligneRenfort(a, opts)).join('')}` : '';

            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay active modal-dynamique';
            overlay.id = 'anomaliesOverlay';
            overlay.style.zIndex = '99998';
            overlay.innerHTML = `
              <div class="modal" style="max-width:860px;">
                <div class="modal-header">
                  <h3 style="margin:0;"><i class="fas fa-user-friends"></i> Renforts détectés — ${escapeHtml(formatMonthName(mois))}</h3>
                  <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body" style="padding:1rem 1.25rem 1.25rem;max-height:75vh;overflow-y:auto;">
                  <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.85rem;">
                    ${[['Colis à recompter', principales.filter(a => a.statut === 'a_traiter').reduce((a, x) => a + x.nbColis, 0), 'var(--warning)'],
                       ['Réaffectés', principales.filter(a => a.statut === 'affecte').reduce((a, x) => a + x.nbColis, 0), 'var(--success)'],
                       ['Écartés', principales.filter(a => a.statut === 'ignore').reduce((a, x) => a + x.nbColis, 0), 'var(--text-secondary)'],
                       ['Cas < 5 colis', sousSeuil.length, 'var(--secondary)'],
                       ['Déjà dans la paie', infos.reduce((a, x) => a + x.nbColis, 0), 'var(--primary)']
                      ].map(([lab, val, col]) => `
                        <div style="flex:1;min-width:110px;padding:0.5rem 0.7rem;background:var(--background-light);border-radius:8px;">
                          <div style="font-size:1.15rem;font-weight:800;color:${col};">${val}</div>
                          <div style="font-size:0.72rem;color:var(--text-secondary);font-weight:600;">${lab.toUpperCase()}</div>
                        </div>`).join('')}
                  </div>
                  ${qualiteHtml}
                  ${(() => { const h = historiqueDecisionsRenforts(); if (!h.total) return ''; const cats = Object.entries(h.categories); return `
                  <details style="margin-bottom:0.85rem;font-size:0.8rem;color:var(--text-secondary);">
                    <summary style="cursor:pointer;font-weight:700;color:var(--text);"><i class="fas fa-graduation-cap"></i> Vos décisions passées (${h.total})</summary>
                    <div style="margin-top:0.4rem;">Taux de validation par catégorie — sert à recalibrer les seuils : ${cats.map(([c, v]) => `<span style="margin-right:0.6rem;"><strong>${escapeHtml(c)}</strong> ${v.valide}/${v.valide + v.ecarte} validés</span>`).join('')}</div>
                    <div style="margin-top:0.3rem;">Paires validées ≥ 2 fois : ${Object.entries(h.paires).filter(([, v]) => v.valide >= 2).map(([k, v]) => `${escapeHtml(k.replace('|', ' → '))} (${v.valide})`).join(', ') || '—'}</div>
                  </details>`; })()}
                  ${(() => { const q2 = data.renfortsQualite?.[mois]; const dl = q2 && q2.doublesLivraisons; if (!dl || !dl.length) return ''; return `
                  <details style="margin-bottom:0.85rem;font-size:0.8rem;color:var(--warning);">
                    <summary style="cursor:pointer;font-weight:700;"><i class="fas fa-triangle-exclamation"></i> ${dl.length} colis livrés avec succès à deux dates (payés deux fois)</summary>
                    <div style="margin-top:0.4rem;color:var(--text-secondary);font-family:monospace;font-size:0.75rem;">${dl.slice(0, 50).map(d => `${escapeHtml(d.waybill)} · ${d.dates.map(escapeHtml).join(' / ')} · ${d.livreurs.map(escapeHtml).join(', ')}`).join('<br>')}${dl.length > 50 ? '<br>…' : ''}</div>
                  </details>`; })()}
                  <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:0.5rem;">
                    Le système détecte une situation logistique anormale et estime la probabilité d'un renfort ;
                    il distingue le fait observé, le calcul, l'inférence et la conclusion. Seuls les cas
                    « Certain » sont réaffectés sans vous. Les colis restent visibles dans les statistiques du
                    compte d'origine, seule la <strong>rémunération</strong> change de main.
                  </p>
                  ${section('Renforts probables (≥ 5 colis)', principales, null)}
                  ${section('Cas à vérifier manuellement — moins de 5 colis', sousSeuil,
                            'Inférieurs au seuil métier de 5 colis : jamais inclus dans les calculs de renfort ni réaffectés automatiquement. À vous de décider après examen. Les cas marqués « déjà compté au bon livreur » n\'appellent aucune action de paie.')}
                  ${section('Transferts déjà reflétés dans la paie', infos,
                            'Colis livrés par le receveur sous son propre compte (réaffectation enregistrée dans le dispatch, ou livraison dans la zone du jour d\'un collègue). Aucune action de paie nécessaire ; affiché pour information.', { compact: false })}
                  ${(!principales.length && !sousSeuil.length && !infos.length) ? '<em>Aucune détection.</em>' : ''}
                </div>
              </div>`;
            document.body.appendChild(overlay);
        }

        /** Détail complet d'une détection : explication, colis, séquence. */
        function ouvrirDetailRenfort(id) {
            const a = getAnomaliesMois(selectedHistoriqueMonth).find(x => x.id === id);
            if (!a) return;
            const colis = a.colis || [];
            const lignes = colis.map(c => `<tr><td>${escapeHtml(c.t)}</td><td style="font-family:monospace;font-size:0.78rem;">${escapeHtml(c.w || '—')}</td><td>${escapeHtml(c.v || '')}</td><td>${escapeHtml(c.cp || '')}</td><td>${c.o === null || c.o === undefined ? '—' : escapeHtml(c.o)}</td><td style="font-size:0.75rem;color:var(--text-secondary);">${isFinite(c.lat) ? c.lat.toFixed(5) + ', ' + c.lon.toFixed(5) : '—'}${c.ab ? ' <span title="position aberrante corrigée" style="color:var(--warning);">⚠</span>' : ''}</td></tr>`).join('');
            const fam = a.familles ? Object.entries(a.familles).map(([k, v]) => `<span style="margin-right:0.6rem;"><strong>${{ double: 'Double séquence', attribution: 'Attribution', masse: 'Masse', externe: 'Cohérence externe' }[k] || escapeHtml(k)}</strong> ${escapeHtml(v)}</span>`).join('') : '';
            const signaux = [];
            if (a.type === 'double_sequence') { signaux.push(['+', `${a.sauts} sauts > 4 km, ${a.alternances} changements de zone, séparation ${a.separationKm} km`]); if (a.monoOk) signaux.push(['+', 'ordre planifié cohérent dans chaque sous-séquence']); else signaux.push(['−', 'ordre planifié peu cohérent : partition incertaine']); if (a.ambiguTitulaire) signaux.push(['−', 'titulaire ambigu : le nombre de colis transférés peut être surestimé ou sous-estimé']); }
            const c0 = a.candidats[0];
            if (c0) {
                if (c0.niveau === 1) signaux.push(['+', `${c0.nom} a livré ${c0.colisRouteA} colis de la route de ${a.compte} sous son compte`]);
                if (c0.recouvrementPct >= 70) signaux.push(['+', `${c0.nom} absent de sa tournée sur ${c0.recouvrementPct} % de la fenêtre`]); else signaux.push(['−', `${c0.nom} n'est absent que ${c0.recouvrementPct} % de la fenêtre`]);
                if (c0.faisable === false) signaux.push(['−', `détour de ${c0.detourKm} km difficilement faisable en ${c0.tempsDispoMin} min`]);
                if (c0.colisDansFenetre > 1) signaux.push(['−', `${c0.nom} a livré ${c0.colisDansFenetre} colis sous son compte pendant la fenêtre`]);
                if (a.candidats[1] && c0.score - a.candidats[1].score < RENFORT_PARAMS.ecartCandidatsMin) signaux.push(['−', `candidat suivant proche : ${a.candidats[1].nom} (${a.candidats[1].score})`]);
            } else signaux.push(['−', 'aucun candidat']);
            if (a.qualite && (a.qualite.partAberrants > 0.2 || a.qualite.partSansGps > 0.2)) signaux.push(['−', 'qualité des données dégradée']);
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay active modal-dynamique';
            overlay.style.zIndex = '99999';
            overlay.innerHTML = `
              <div class="modal" style="max-width:820px;">
                <div class="modal-header">
                  <h3 style="margin:0;"><i class="fas fa-list"></i> ${escapeHtml(a.compte)} → ${escapeHtml(a.source || '?')} — ${escapeHtml(a.date)} — ${a.nbColis} colis</h3>
                  <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body" style="padding:1rem 1.25rem 1.25rem;max-height:75vh;overflow-y:auto;font-size:0.86rem;">
                  <div style="white-space:pre-line;padding:0.7rem 0.9rem;border-radius:8px;background:var(--background-light);margin-bottom:0.8rem;">${escapeHtml(a.explication || '')}</div>
                  <div style="margin-bottom:0.6rem;color:var(--text-secondary);"><strong style="color:var(--text);">Score ${a.score}/100 — ${escapeHtml(a.categorie || '')}</strong> · ${fam}${a.qualite ? ` · multiplicateur qualité ${a.familles ? '' : ''}` : ''}</div>
                  <div style="margin-bottom:0.8rem;">${signaux.map(([s, t]) => `<div style="color:${s === '+' ? 'var(--success)' : 'var(--warning)'};"><i class="fas fa-${s === '+' ? 'plus' : 'minus'}-circle"></i> ${escapeHtml(t)}</div>`).join('')}</div>
                  ${(a.colis && a.colis.length && typeof L !== 'undefined') ? `<button class="btn btn-sm btn-primary" style="margin-bottom:0.6rem;" onclick="ouvrirCarteRenfort('${escJsAttr(a.id)}')"><i class="fas fa-map"></i> Voir la séquence sur la carte</button>` : ''}
                  <table class="historique-day-table" style="width:100%;">
                    <thead><tr><th>Heure</th><th>N° colis</th><th>Commune</th><th>CP</th><th>Ordre</th><th>GPS</th></tr></thead>
                    <tbody>${lignes || `<tr><td colspan="6">${a.detailPurge ? 'Liste des colis effacée par la rétention (' + getRetentionJours() + ' jours après import). Réimportez le fichier EPOD pour la retrouver.' : 'Liste des colis non disponible (détection d\'une version antérieure : relancez la détection).'}</td></tr>`}</tbody>
                  </table>
                  ${a.sequence && a.sequence.length ? `<p style="margin-top:0.6rem;color:var(--text-secondary);">Séquence du titulaire pendant la fenêtre : ${a.sequence.map(s => escapeHtml(s.t + (s.o !== null && s.o !== undefined ? ` (#${s.o})` : ''))).join(' → ')}</p>` : ''}
                </div>
              </div>`;
            document.body.appendChild(overlay);
        }

        /** Carte Leaflet : colis transférés (orange) et séquence du titulaire (bleu). */
        function ouvrirCarteRenfort(id) {
            const a = getAnomaliesMois(selectedHistoriqueMonth).find(x => x.id === id);
            if (!a || typeof L === 'undefined') { showToast('Carte indisponible', 'warning'); return; }
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay active modal-dynamique';
            overlay.style.zIndex = '100000';
            overlay.innerHTML = `
              <div class="modal" style="max-width:900px;">
                <div class="modal-header">
                  <h3 style="margin:0;"><i class="fas fa-map"></i> ${escapeHtml(a.compte)} — ${escapeHtml(a.date)} — ${escapeHtml(a.debut)}–${escapeHtml(a.fin)}</h3>
                  <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body" style="padding:0.5rem;">
                  <div style="font-size:0.8rem;color:var(--text-secondary);margin:0 0.5rem 0.4rem;">
                    <span style="color:#e8590c;font-weight:700;">●</span> colis livrés par le renfort (${a.nbColis})
                    &nbsp; <span style="color:#2b6e8f;font-weight:700;">●</span> séquence du titulaire pendant la fenêtre (${(a.sequence || []).length})
                  </div>
                  <div id="carteRenfort" style="height:520px;border-radius:8px;"></div>
                </div>
              </div>`;
            document.body.appendChild(overlay);
            setTimeout(() => {
                const map = L.map('carteRenfort');
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
                const b = [];
                const trace = (pts, color, label) => {
                    const ll = pts.filter(p => isFinite(p.lat) && isFinite(p.lon)).map(p => [p.lat, p.lon]);
                    if (!ll.length) return;
                    L.polyline(ll, { color, weight: 2, opacity: 0.6, dashArray: color === '#2b6e8f' ? '4 4' : null }).addTo(map);
                    pts.forEach((p, i) => {
                        if (!isFinite(p.lat)) return;
                        L.circleMarker([p.lat, p.lon], { radius: 6, color, fillColor: color, fillOpacity: 0.85, weight: 1 })
                         .bindTooltip(escapeHtml(`${label} ${i + 1} · ${p.t}${p.w ? ' · ' + p.w : ''}${p.o !== null && p.o !== undefined ? ' · #' + p.o : ''}`)).addTo(map);
                        b.push([p.lat, p.lon]);
                    });
                };
                trace(a.sequence || [], '#2b6e8f', 'titulaire');
                trace(a.colis || [], '#e8590c', 'renfort');
                if (b.length) map.fitBounds(b, { padding: [20, 20] });
            }, 50);
        }

        function _majStatutAnomalie(id, statut) {
            const mois = selectedHistoriqueMonth;
            const a = getAnomaliesMois(mois).find(x => x.id === id);
            if (a) { a.statut = statut; markUnsaved(); saveLocal(); }
            return a;
        }

        function confirmerAffectation(id, versNom) {
            const mois = selectedHistoriqueMonth;
            const a = getAnomaliesMois(mois).find(x => x.id === id);
            if (!a) return;
            const t = enregistrerTransfert({
                mois, date: a.date, de: a.compte, vers: versNom, nb: a.nbColis,
                mode: 'auto',
                note: `Renfort validé manuellement ${a.debut}–${a.fin}${a.score !== undefined ? ` · ${a.score}/100` : ''}`
            });
            if (!t) return;
            _majStatutAnomalie(id, 'affecte');
            memoriserDecisionRenfort(a, 'valide', versNom);
            document.getElementById('anomaliesOverlay')?.remove();
            refreshHistorique();
            showToast(`${a.nbColis} colis réaffectés à ${versNom}`, 'success');
        }

        function ignorerAnomalie(id) {
            const a = _majStatutAnomalie(id, 'ignore');
            if (a) memoriserDecisionRenfort(a, 'ecarte', a.source);
            document.getElementById('anomaliesOverlay')?.remove();
            refreshHistorique();
            ouvrirDetailAnomalies();
        }

        function choisirAutreLivreur(id) {
            const mois = selectedHistoriqueMonth;
            const a = getAnomaliesMois(mois).find(x => x.id === id);
            if (!a) return;
            document.getElementById('anomaliesOverlay')?.remove();
            ouvrirTransfertManuel({ date: a.date, de: a.compte, nb: a.nbColis, anomalieId: id });
        }

        // ── Transfert manuel (toujours disponible, sans détection préalable) ──
        function ouvrirTransfertManuel(prefill) {
            const mois = selectedHistoriqueMonth;
            const monthData = data.historiqueEPOD?.[mois] || {};
            const p = prefill || {};
            const noms = new Set(Object.keys(monthData));
            (data.livreurs || []).forEach(l => { if (l.nom) noms.add(l.nom); });
            const liste = [...noms].filter(n => !estCompteTechnique(n)).sort((a, b) => a.localeCompare(b));
            const opt = (sel) => liste.map(n => `<option value="${escAttr(n)}"${n === sel ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');

            const dates = new Set();
            Object.values(monthData).forEach(l => Object.keys(l.jours || {}).forEach(d => dates.add(d)));
            const optDates = [...dates].sort().map(d => `<option value="${escapeHtml(d)}"${d === p.date ? ' selected' : ''}>${escapeHtml(d)}</option>`).join('');

            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay active modal-dynamique';
            overlay.style.zIndex = '99999';
            overlay.innerHTML = `
              <div class="modal" style="max-width:520px;">
                <div class="modal-header">
                  <h3 style="margin:0;"><i class="fas fa-exchange-alt"></i> Transférer des colis</h3>
                  <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body" style="padding:1rem 1.25rem 1.25rem;">
                  <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:1rem;">
                    Indiquez combien de colis enregistrés sous un compte ont en réalité été livrés
                    par quelqu'un d'autre. Les statistiques du compte d'origine ne changent pas ;
                    seule la rémunération suit le livreur réel.
                  </p>
                  <div class="form-group" style="margin-bottom:0.75rem;">
                    <label class="form-label" style="font-size:0.8rem;">Date</label>
                    <select id="trManuelDate" class="form-input">${optDates || '<option value="">(aucune donnée)</option>'}</select>
                  </div>
                  <div style="display:flex;gap:0.6rem;flex-wrap:wrap;">
                    <div class="form-group" style="flex:1;min-width:160px;">
                      <label class="form-label" style="font-size:0.8rem;">Colis enregistrés sous</label>
                      <select id="trManuelDe" class="form-input">${opt(p.de)}</select>
                    </div>
                    <div class="form-group" style="flex:1;min-width:160px;">
                      <label class="form-label" style="font-size:0.8rem;">Réellement livrés par</label>
                      <select id="trManuelVers" class="form-input">${opt(p.vers)}</select>
                    </div>
                    <div class="form-group" style="width:110px;">
                      <label class="form-label" style="font-size:0.8rem;">Nombre</label>
                      <input type="number" id="trManuelNb" class="form-input" min="1" value="${escapeHtml(p.nb || '')}" placeholder="35">
                    </div>
                  </div>
                  <div class="form-group" style="margin-bottom:1rem;">
                    <label class="form-label" style="font-size:0.8rem;">Note (facultatif)</label>
                    <input type="text" id="trManuelNote" class="form-input" placeholder="Ex : renfort sur secteur 67600" value="${escAttr(p.note || '')}">
                  </div>
                  <div id="trManuelApercu" style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:1rem;"></div>
                  <div style="display:flex;gap:0.5rem;justify-content:flex-end;">
                    <button class="btn btn-secondary btn-sm" onclick="this.closest('.modal-overlay').remove()">Annuler</button>
                    <button class="btn btn-primary btn-sm" onclick="validerTransfertManuel('${escJsAttr(p.anomalieId || '')}','${escJsAttr(p.remplaceId || '')}')">
                      <i class="fas fa-check"></i> ${p.remplaceId ? 'Enregistrer la correction' : 'Enregistrer le transfert'}
                    </button>
                  </div>
                </div>
              </div>`;
            document.body.appendChild(overlay);
            ['trManuelDate', 'trManuelDe', 'trManuelVers', 'trManuelNb'].forEach(id =>
                document.getElementById(id)?.addEventListener('input', apercuTransfertManuel));
            apercuTransfertManuel();
        }

        function apercuTransfertManuel() {
            const el = document.getElementById('trManuelApercu');
            if (!el) return;
            const date = document.getElementById('trManuelDate')?.value;
            const de   = document.getElementById('trManuelDe')?.value;
            const vers = document.getElementById('trManuelVers')?.value;
            const nb   = parseInt(document.getElementById('trManuelNb')?.value, 10);
            if (!date || !de || !vers || !nb || de === vers) { el.innerHTML = ''; return; }
            const mois = selectedHistoriqueMonth;
            const md = appliquerTransfertsMois(data.historiqueEPOD?.[mois] || {}, mois);
            const cfg = (n) => (typeof matchLivreur === 'function' && matchLivreur(n)) || { contrat: 'auto-entrepreneur', taux: 1.4 };
            const salJour = (compte, delta) => {
                const j = md[compte]?.jours?.[date];
                const base = j ? colisRemunerablesJour(j) : 0;
                const c = cfg(compte);
                const fn = c.contrat === 'autoentrepreneur-vehicule' ? calculerSalaireJournalierAEvehicule
                         : c.contrat === 'salarie' ? calculerSalaireJournalierSalarié
                         : (n) => n * (c.taux || 0);
                return [base, fn(base), fn(Math.max(0, base + delta))];
            };
            const [bDe, aDe, apDe]     = salJour(de, -nb);
            const [bVers, aVers, apVers] = salJour(vers, +nb);
            const f = (v) => v.toFixed(2).replace('.', ',') + ' €';
            el.innerHTML = `
                <strong>Effet sur le ${escapeHtml(date)} :</strong><br>
                ${escapeHtml(de)} : ${bDe} → ${Math.max(0, bDe - nb)} colis · ${f(aDe)} → <strong>${f(apDe)}</strong><br>
                ${escapeHtml(vers)} : ${bVers} → ${bVers + nb} colis · ${f(aVers)} → <strong>${f(apVers)}</strong>`;
        }

        function validerTransfertManuel(anomalieId, remplaceId) {
            const date = document.getElementById('trManuelDate')?.value;
            const de   = document.getElementById('trManuelDe')?.value;
            const vers = document.getElementById('trManuelVers')?.value;
            const nb   = parseInt(document.getElementById('trManuelNb')?.value, 10);
            const note = document.getElementById('trManuelNote')?.value || '';
            // Correction d'un transfert existant : on retire l'ancien d'abord,
            // sinon les deux se cumuleraient.
            if (remplaceId) {
                const l = getTransfertsMois(String(date).slice(0, 7));
                const i = l.findIndex(x => x.id === remplaceId);
                if (i >= 0) l.splice(i, 1);
                const l2 = getTransfertsMois(selectedHistoriqueMonth);
                const i2 = l2.findIndex(x => x.id === remplaceId);
                if (i2 >= 0) l2.splice(i2, 1);
            }
            const t = enregistrerTransfert({ mois: selectedHistoriqueMonth, date, de, vers, nb, mode: 'manuel', note });
            if (!t) return;
            if (anomalieId) _majStatutAnomalie(anomalieId, 'affecte');
            document.querySelectorAll('.modal-overlay').forEach(o => { if (o.querySelector('#trManuelDate')) o.remove(); });
            refreshHistorique();
            showToast(`${nb} colis transférés de ${de} à ${vers}`, 'success');
        }

        // ── Résumé compact des transferts (une seule ligne) ──
        // v45 : la liste détaillée occupait tout le haut de l'Historique et
        // repoussait les fiches de paie hors de l'écran. Elle passe en modale.
        // v45 — plus aucun encart dans le flux : seulement un compteur sur le
        // bouton « Transferts » de la barre de mois.
        function renderTransfertsMois() {
            const badge = document.getElementById('badgeTransferts');
            if (!badge) return;
            const n = getTransfertsMois(selectedHistoriqueMonth).length;
            badge.innerHTML = n
                ? `<span style="display:inline-block;min-width:18px;padding:0 6px;margin-left:0.25rem;border-radius:9px;
                                background:var(--primary);color:#fff;font-size:0.7rem;font-weight:700;">${n}</span>`
                : '';
        }

        // ── Détail des transferts, en modale ──
        // ═══════════════════════════════════════════════════════════════════
        // v51 — CLÔTURE DE MOIS, JOURNAL DES RÉAFFECTATIONS, CONTRÔLE DE PAIE
        // ───────────────────────────────────────────────────────────────────
        // · Un mois clôturé est figé : aucun réimport EPOD, aucun transfert
        //   (auto ou manuel), aucune réinitialisation, tant qu'il n'est pas
        //   explicitement déverrouillé.
        // · Chaque action touchant la paie est journalisée (qui, quand, quoi)
        //   et réversible unitairement depuis la modale « Transferts ».
        // · Le contrôle de cohérence vérifie Σ payés = Σ livrés (les transferts
        //   sont un jeu à somme nulle) et qu'aucune journée ne cède plus de
        //   colis qu'elle n'en a livrés.
        // ═══════════════════════════════════════════════════════════════════

        function _acteurCourant() {
            try { return (typeof currentCloudUser !== 'undefined' && currentCloudUser && (currentCloudUser.email || currentCloudUser.id)) || 'local'; }
            catch (e) { return 'local'; }
        }

        function moisEstCloture(mois) {
            return !!(mois && data.moisClotures && data.moisClotures[mois]);
        }

        function journaliser(mois, action, detail) {
            if (!mois) return;
            if (!data.journalTransferts) data.journalTransferts = {};
            const j = (data.journalTransferts[mois] = data.journalTransferts[mois] || []);
            j.push({ ts: new Date().toISOString(), par: _acteurCourant(), action, detail: detail || {} });
            if (j.length > 500) j.splice(0, j.length - 500);
        }

        /** Refuse une action si le mois est clôturé (toast + false). */
        function verifierMoisOuvert(mois, action) {
            if (!moisEstCloture(mois)) return true;
            const c = data.moisClotures[mois];
            showToast(`${formatMonthName(mois)} est clôturé (${new Date(c.date).toLocaleDateString('fr-FR')}) : ${action || 'action'} refusée. Déverrouillez le mois d'abord.`, 'warning');
            return false;
        }

        function cloturerMois(mois) {
            mois = mois || selectedHistoriqueMonth;
            if (moisEstCloture(mois)) { showToast('Mois déjà clôturé', 'info'); return; }
            const ctrl = controlerCoherencePaie(mois);
            const attente = getAnomaliesMois(mois).filter(a => a.statut === 'a_traiter' && !a.sousSeuil).length;
            let msg = `Clôturer ${formatMonthName(mois)} ?\n\nAprès clôture : aucun réimport EPOD, aucun transfert, aucune réaffectation automatique ne pourra modifier ce mois sans déverrouillage explicite.`;
            if (!ctrl.ok) msg += `\n\n⚠ Le contrôle de cohérence signale ${ctrl.problemes.length} problème(s) :\n- ${ctrl.problemes.slice(0, 4).join('\n- ')}`;
            if (attente) msg += `\n\n⚠ ${attente} renfort(s) probable(s) sont encore en attente de décision.`;
            if (!confirm(msg)) return;
            if (!data.moisClotures) data.moisClotures = {};
            data.moisClotures[mois] = { date: new Date().toISOString(), par: _acteurCourant(), livres: ctrl.totalLivres, payes: ctrl.totalPayes, transferts: getTransfertsMois(mois).length };
            journaliser(mois, 'cloture', { livres: ctrl.totalLivres, payes: ctrl.totalPayes });
            markUnsaved(); saveLocal(); fermerModalesDynamiques(); refreshHistorique();
            showToast(`${formatMonthName(mois)} clôturé`, 'success');
        }

        function deverrouillerMois(mois) {
            mois = mois || selectedHistoriqueMonth;
            if (!moisEstCloture(mois)) return;
            if (!confirm(`Déverrouiller ${formatMonthName(mois)} ?\n\nLes réimports et transferts redeviennent possibles. L'opération est journalisée.`)) return;
            delete data.moisClotures[mois];
            journaliser(mois, 'deverrouillage', {});
            markUnsaved(); saveLocal(); fermerModalesDynamiques(); refreshHistorique();
            showToast(`${formatMonthName(mois)} déverrouillé`, 'info');
        }

        /**
         * Contrôle de cohérence de la paie d'un mois.
         * @returns {{ok:boolean, totalLivres:number, totalPayes:number, problemes:string[]}}
         */
        function controlerCoherencePaie(mois) {
            const brut = data.historiqueEPOD?.[mois] || {};
            const problemes = [];
            let totalLivres = 0;
            Object.entries(brut).forEach(([nom, liv]) => { if (!estCompteTechnique(nom)) totalLivres += liv.totalLivres || 0; });
            const avec = appliquerTransfertsMois(brut, mois) || {};
            let totalPayes = 0;
            Object.entries(avec).forEach(([nom, liv]) => { if (!estCompteTechnique(nom)) totalPayes += liv.totalRemunerables || 0; });
            // Transferts vers/depuis un compte technique déséquilibrent la somme : signalés
            getTransfertsMois(mois).forEach(t => {
                const j = brut[t.de]?.jours?.[t.date];
                if (!j) problemes.push(`${t.date} : ${t.de} cède ${t.nb} colis alors qu'il n'a rien livré ce jour-là`);
                else if ((Number(t.nb) || 0) > (j.livres || 0)) problemes.push(`${t.date} : ${t.de} cède ${t.nb} colis pour ${j.livres} livrés (plafonné à ${j.livres} dans la paie)`);
                if (estCompteTechnique(t.de) || estCompteTechnique(t.vers)) problemes.push(`${t.date} : transfert impliquant un compte technique (${t.de} → ${t.vers})`);
            });
            // Cumul par (compte, jour) : plusieurs transferts peuvent dépasser à eux tous
            const cumul = {};
            getTransfertsMois(mois).forEach(t => { cumul[t.de + '|' + t.date] = (cumul[t.de + '|' + t.date] || 0) + (Number(t.nb) || 0); });
            Object.entries(cumul).forEach(([k, n]) => { const [de, date] = k.split('|'); const j = brut[de]?.jours?.[date]; if (j && n > (j.livres || 0) && !problemes.some(p => p.startsWith(date + ' : ' + de))) problemes.push(`${date} : ${de} cède ${n} colis au total pour ${j.livres} livrés`); });
            if (totalPayes !== totalLivres) problemes.push(`Σ payés (${totalPayes}) ≠ Σ livrés (${totalLivres}) : écart ${totalPayes - totalLivres} colis`);
            // Détections certaines non appliquées
            const certainsNonAppliques = getAnomaliesMois(mois).filter(a => a.statut === 'a_traiter' && a.confiance === 'certain' && !a.sousSeuil && !a.directionInverse).length;
            if (certainsNonAppliques) problemes.push(`${certainsNonAppliques} renfort(s) « Certain » non appliqués`);
            return { ok: problemes.length === 0, totalLivres, totalPayes, problemes };
        }

        function _htmlControleCoherence(mois) {
            const c = controlerCoherencePaie(mois);
            const clos = moisEstCloture(mois);
            const verrou = clos
                ? `<span style="background:rgba(45,212,163,0.15);color:var(--success);padding:2px 9px;border-radius:8px;font-size:0.72rem;font-weight:700;"><i class="fas fa-lock"></i> Mois clôturé le ${new Date(data.moisClotures[mois].date).toLocaleDateString('fr-FR')}</span>
                   <button class="btn btn-sm" onclick="deverrouillerMois('${escJsAttr(mois)}')" style="margin-left:0.4rem;padding:1px 9px;font-size:0.72rem;background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);"><i class="fas fa-lock-open"></i> Déverrouiller</button>`
                : `<button class="btn btn-sm" onclick="cloturerMois('${escJsAttr(mois)}')" style="padding:1px 9px;font-size:0.72rem;background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);"><i class="fas fa-lock"></i> Clôturer le mois</button>`;
            return `
              <div style="margin-bottom:0.6rem;padding:0.5rem 0.8rem;border-radius:8px;font-size:0.82rem;
                          background:${c.ok ? 'rgba(45,212,163,0.08)' : 'rgba(231,76,60,0.10)'};border-left:3px solid ${c.ok ? 'var(--success)' : 'var(--danger)'};">
                <strong style="color:${c.ok ? 'var(--success)' : 'var(--danger)'};"><i class="fas fa-${c.ok ? 'check-circle' : 'triangle-exclamation'}"></i>
                Contrôle paie : ${c.totalPayes} colis payés / ${c.totalLivres} livrés${c.ok ? ' ✓' : ''}</strong>
                <span style="margin-left:0.5rem;">${verrou}</span>
                ${c.problemes.length ? `<ul style="margin:0.3rem 0 0 1rem;padding:0;color:var(--text-secondary);">${c.problemes.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''}
              </div>`;
        }

        /** Annule un transfert depuis le journal (l'entrée « ajout » doit encore exister). */
        function annulerDepuisJournal(mois, transfertId) {
            if (!verifierMoisOuvert(mois, 'annulation')) return;
            supprimerTransfert(mois, transfertId);
            fermerModalesDynamiques(); ouvrirListeTransferts();
        }

        /** Rétablit un transfert supprimé, à partir de son enregistrement journalisé. */
        function retablirDepuisJournal(mois, index) {
            if (!verifierMoisOuvert(mois, 'rétablissement')) return;
            const e = (data.journalTransferts?.[mois] || [])[index];
            if (!e || !e.detail || !e.detail.date) { showToast('Entrée introuvable', 'error'); return; }
            const d = e.detail;
            const t = enregistrerTransfert({ mois, date: d.date, de: d.de, vers: d.vers, nb: d.nb, mode: d.mode || 'manuel', note: (d.note || '') + ' (rétabli depuis le journal)', routes: d.routes });
            if (t) { refreshHistorique(); fermerModalesDynamiques(); ouvrirListeTransferts(); }
        }

        function _htmlJournal(mois) {
            const j = (data.journalTransferts?.[mois] || []).slice().reverse();
            if (!j.length) return '';
            const existants = new Set(getTransfertsMois(mois).map(t => t.id));
            const lib = { ajout: 'Transfert ajouté', suppression: 'Transfert annulé', reset: 'Tous les transferts annulés', cloture: 'Mois clôturé', deverrouillage: 'Mois déverrouillé', decision_valide: 'Renfort validé', decision_ecarte: 'Renfort écarté', modification: 'Transfert modifié' };
            const lignes = j.slice(0, 60).map((e, k) => {
                const idx = j.length - 1 - k;   // index dans l'ordre chronologique
                const d = e.detail || {};
                const desc = d.date ? `${escapeHtml(d.date)} · ${escapeHtml(d.nb)} colis · ${escapeHtml(d.de || '')} → ${escapeHtml(d.vers || '')}${d.mode ? ` (${escapeHtml(d.mode)})` : ''}` : (d.n !== undefined ? `${d.n} transfert(s)` : (d.livres !== undefined ? `${d.payes} payés / ${d.livres} livrés` : ''));
                let action = '';
                if (e.action === 'ajout' && d.id && existants.has(d.id) && !moisEstCloture(mois)) action = `<button class="btn btn-sm" style="padding:1px 8px;font-size:0.7rem;background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);" onclick="annulerDepuisJournal('${escJsAttr(mois)}','${escJsAttr(d.id)}')"><i class="fas fa-undo"></i> annuler</button>`;
                if (e.action === 'suppression' && d.date && !moisEstCloture(mois)) action = `<button class="btn btn-sm" style="padding:1px 8px;font-size:0.7rem;background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);" onclick="retablirDepuisJournal('${escJsAttr(mois)}',${idx})"><i class="fas fa-redo"></i> rétablir</button>`;
                return `<div style="display:flex;justify-content:space-between;gap:0.5rem;padding:0.3rem 0;border-bottom:1px dashed var(--border);font-size:0.78rem;">
                          <div><span style="color:var(--text-secondary);">${new Date(e.ts).toLocaleString('fr-FR')} · ${escapeHtml(e.par || '')}</span>
                               <br><strong>${lib[e.action] || escapeHtml(e.action)}</strong> ${desc}${d.score !== undefined ? ` · ${escapeHtml(d.score)}/100 ${escapeHtml(d.categorie || '')}` : ''}</div>
                          <div>${action}</div></div>`;
            }).join('');
            return `<details style="margin-top:0.8rem;"><summary style="cursor:pointer;font-weight:700;font-size:0.85rem;"><i class="fas fa-clock-rotate-left"></i> Journal (${j.length} entrée(s))</summary>${lignes}${j.length > 60 ? `<div style="font-size:0.75rem;color:var(--text-secondary);">… ${j.length - 60} entrées plus anciennes</div>` : ''}</details>`;
        }

        // ═══════════════════════════════════════════════════════════════════
        // v51 — APPRENTISSAGE DES DÉCISIONS DE RENFORT
        // Chaque validation / rejet est mémorisé. Le moteur reçoit un résumé
        // (paires A→B validées, taux par catégorie) et l'utilise comme signal
        // faible ; l'écran montre le taux de validation observé par catégorie
        // pour recalibrer les seuils en connaissance de cause.
        // ═══════════════════════════════════════════════════════════════════
        function memoriserDecisionRenfort(a, decision, versNom) {
            if (!a) return;
            if (!Array.isArray(data.renfortsDecisions)) data.renfortsDecisions = [];
            data.renfortsDecisions.push({ ts: new Date().toISOString(), mois: a.date.slice(0, 7), date: a.date, compte: a.compte, source: versNom || a.source || null, score: a.score, categorie: a.categorie, type: a.type, nbColis: a.nbColis, decision, depot: a.depot || '' });
            if (data.renfortsDecisions.length > 2000) data.renfortsDecisions.splice(0, data.renfortsDecisions.length - 2000);
            journaliser(a.date.slice(0, 7), decision === 'valide' ? 'decision_valide' : 'decision_ecarte', { date: a.date, de: a.compte, vers: versNom || a.source, nb: a.nbColis, score: a.score, categorie: a.categorie });
        }

        function historiqueDecisionsRenforts() {
            const paires = {}, categories = {};
            (data.renfortsDecisions || []).forEach(d => {
                if (d.compte && d.source) { const k = d.compte + '|' + d.source; const p = (paires[k] = paires[k] || { valide: 0, ecarte: 0 }); p[d.decision === 'valide' ? 'valide' : 'ecarte']++; }
                if (d.categorie) { const c = (categories[d.categorie] = categories[d.categorie] || { valide: 0, ecarte: 0 }); c[d.decision === 'valide' ? 'valide' : 'ecarte']++; }
            });
            return { paires, categories, total: (data.renfortsDecisions || []).length };
        }

        // ═══════════════════════════════════════════════════════════════════
        // v51 — SECTEURS OBSERVÉS (à partir des livraisons réelles du mois)
        // ═══════════════════════════════════════════════════════════════════
        function secteursObservesEPOD(mois) {
            const recs = lirePointsDetection(mois) || [];
            const par = {};
            recs.forEach(r => {
                if (!r.cp || estCompteTechnique(r.courier)) return;
                const p = (par[r.courier] = par[r.courier] || { n: 0, cp: {}, km: 0 });
                p.n++; p.cp[r.cp] = (p.cp[r.cp] || 0) + 1;
            });
            return Object.entries(par).map(([nom, p]) => ({
                nom, n: p.n,
                cps: Object.entries(p.cp).map(([cp, n]) => ({ cp, n, pct: Math.round(n / p.n * 100) })).sort((a, b) => b.n - a.n)
            })).sort((a, b) => b.n - a.n);
        }

        function ouvrirSecteursObserves() {
            const mois = selectedHistoriqueMonth;
            const liste = secteursObservesEPOD(mois);
            if (!liste.length) { showToast('Aucun point mémorisé pour ce mois : importez ou relancez la détection.', 'info'); return; }
            const seuil = 5;
            const lignes = liste.map(l => {
                const conf = (typeof matchLivreur === 'function') ? matchLivreur(l.nom) : null;
                const principaux = l.cps.filter(c => c.pct >= seuil);
                const actuels = conf ? (conf.secteurs_prioritaires || []) : [];
                const nouveaux = principaux.map(c => c.cp).filter(cp => !actuels.includes(cp));
                const perdus = actuels.filter(cp => !principaux.some(c => c.cp === cp));
                return `
                  <div style="padding:0.6rem 0.75rem;border:1px solid var(--border);border-radius:8px;margin-bottom:0.6rem;">
                    <div style="display:flex;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;align-items:center;">
                      <div><strong>${escapeHtml(l.nom)}</strong> <span style="color:var(--text-secondary);font-size:0.8rem;">${l.n} colis · ${l.cps.length} CP · ${principaux.length} CP ≥ ${seuil} %</span>
                        ${conf ? '' : '<span style="color:var(--warning);font-size:0.75rem;margin-left:0.4rem;">livreur non configuré</span>'}</div>
                      ${conf ? `<button class="btn btn-sm btn-primary" onclick="appliquerSecteursObserves('${escJsAttr(mois)}','${escJsAttr(l.nom)}',${seuil})"><i class="fas fa-check"></i> Utiliser comme secteurs prioritaires</button>` : ''}
                    </div>
                    <div style="margin-top:0.4rem;display:flex;gap:0.3rem;flex-wrap:wrap;">
                      ${l.cps.slice(0, 14).map(c => `<span title="${c.n} colis" style="padding:2px 7px;border-radius:6px;font-size:0.75rem;font-weight:600;background:${c.pct >= seuil ? 'var(--primary)' : 'var(--background-light)'};color:${c.pct >= seuil ? '#fff' : 'var(--text-secondary)'};">${escapeHtml(c.cp)} ${c.pct}%</span>`).join('')}
                      ${l.cps.length > 14 ? `<span style="font-size:0.75rem;color:var(--text-secondary);">+${l.cps.length - 14}</span>` : ''}
                    </div>
                    ${conf && (nouveaux.length || perdus.length) ? `<div style="margin-top:0.35rem;font-size:0.76rem;color:var(--text-secondary);">Configuré : ${actuels.length} CP${nouveaux.length ? ` · <span style="color:var(--success);">+${nouveaux.map(escapeHtml).join(', ')}</span>` : ''}${perdus.length ? ` · <span style="color:var(--danger);">−${perdus.map(escapeHtml).join(', ')}</span>` : ''}</div>` : ''}
                  </div>`;
            }).join('');
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay active modal-dynamique';
            overlay.style.zIndex = '99998';
            overlay.innerHTML = `
              <div class="modal" style="max-width:820px;">
                <div class="modal-header">
                  <h3 style="margin:0;"><i class="fas fa-map-location-dot"></i> Secteurs observés — ${escapeHtml(formatMonthName(mois))}</h3>
                  <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body" style="padding:1rem 1.25rem 1.25rem;max-height:75vh;overflow-y:auto;">
                  <p style="font-size:0.85rem;color:var(--text-secondary);">Répartition réelle des livraisons par code postal, calculée sur le mois. Un livreur qui tourne sur plusieurs secteurs a une répartition étalée : n'appliquez que si elle correspond à l'organisation voulue. L'application remplace la liste configurée (les CP ≥ ${seuil} %) après confirmation.</p>
                  ${lignes}
                </div>
              </div>`;
            document.body.appendChild(overlay);
        }

        function appliquerSecteursObserves(mois, nomEPOD, seuil) {
            const l = secteursObservesEPOD(mois).find(x => x.nom === nomEPOD);
            const conf = l && (typeof matchLivreur === 'function') ? matchLivreur(nomEPOD) : null;
            if (!l || !conf) { showToast('Livreur introuvable', 'error'); return; }
            const cps = l.cps.filter(c => c.pct >= seuil).map(c => c.cp);
            if (!cps.length) { showToast('Aucun CP au-dessus du seuil', 'info'); return; }
            if (!confirm(`Remplacer les secteurs prioritaires de ${conf.nom} par :\n${cps.join(', ')}\n\n(${conf.secteurs_prioritaires.length} CP configurés actuellement)`)) return;
            conf.secteurs_prioritaires = cps;
            markUnsaved(); saveLocal();
            showToast(`${cps.length} secteurs appliqués à ${conf.nom}`, 'success');
            fermerModalesDynamiques();
        }

        // ═══════════════════════════════════════════════════════════════════
        // v51 — INDICATEURS OPÉRATIONNELS (affichage carte livreur)
        // ═══════════════════════════════════════════════════════════════════
        const MOTIFS_ECHEC_IMPUTABLES_DEFAUT = ['ZERO_DELIVERY_ATTEMPT', 'PARCEL_NOT_FOUND', 'OTHER', 'NON_RENSEIGNE'];
        function getMotifsImputables() {
            return Array.isArray(data.motifsEchecImputables) ? data.motifsEchecImputables : MOTIFS_ECHEC_IMPUTABLES_DEFAUT;
        }
        function editerMotifsImputables() {
            const v = prompt('Motifs d\'échec considérés comme imputables au livreur (séparés par des virgules).\nTous les autres motifs sont comptés « non imputables » (adresse fausse, BAL introuvable, Vigik…).', getMotifsImputables().join(', '));
            if (v === null) return;
            data.motifsEchecImputables = v.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
            markUnsaved(); saveLocal(); refreshHistorique();
        }
        /** Répartition des échecs d'un livreur entre imputables et non imputables. */
        function ventilerEchecs(ind) {
            const imp = getMotifsImputables();
            let imputables = 0, non = 0;
            Object.entries((ind && ind.echecsMotifs) || {}).forEach(([m, n]) => { if (imp.includes(m)) imputables += n; else non += n; });
            return { imputables, nonImputables: non };
        }
        function _htmlIndicateursLivreur(liv, joursCount) {
            const ind = liv.indicateurs;
            if (!ind) return '';
            const v = ventilerEchecs(ind);
            const motifs = Object.entries(ind.echecsMotifs || {}).sort((a, b) => b[1] - a[1]);
            const imp = getMotifsImputables();
            const km = ind.joursKm ? `${Math.round(ind.kmReel)} km (${Math.round(ind.kmReel / ind.joursKm)} km/jour sur ${ind.joursKm} j)` : '—';
            const poids = ind.colisPeses ? `${(ind.poidsG / 1000 / Math.max(1, joursCount)).toFixed(0)} kg/jour · ${(ind.poidsG / ind.colisPeses / 1000).toFixed(2)} kg/colis` : '—';
            const ordre = ind.ordrePaires ? `${Math.round(ind.ordreOk / ind.ordrePaires * 100)} %` : '—';
            const sign = (ind.signBal + ind.signMain + ind.signAutre) ? `${Math.round(ind.signBal / (ind.signBal + ind.signMain + ind.signAutre) * 100)} % BAL · ${Math.round(ind.signMain / (ind.signBal + ind.signMain + ind.signAutre) * 100)} % main propre` : '—';
            const rejets = Object.values(ind.podRejets || {}).reduce((a, b) => a + b, 0);
            const pod = ind.podControles ? `${ind.podControles} contrôlés, ${rejets} rejetés${rejets ? ` (${Object.entries(ind.podRejets).map(([k, n]) => `${escapeHtml(k)} ×${escapeHtml(n)}`).join(', ')})` : ''}` : '—';
            const stat = (l, val, t) => `<div title="${escAttr(t || '')}" style="min-width:150px;flex:1;"><div style="font-size:0.7rem;color:var(--text-secondary);font-weight:700;text-transform:uppercase;">${l}</div><div style="font-size:0.85rem;">${val}</div></div>`;
            return `
                <div style="margin-top:0.5rem;padding:0.75rem;background:var(--background-light);border-radius:var(--radius-sm);font-size:0.85rem;" onclick="event.stopPropagation();">
                    <strong><i class="fas fa-gauge-high"></i> Indicateurs opérationnels</strong> <span style="font-size:0.75rem;color:var(--text-secondary);">(informatifs, sans effet sur le salaire)</span>
                    <div style="display:flex;gap:0.8rem;flex-wrap:wrap;margin-top:0.45rem;">
                        ${stat('Kilométrage réel', km, 'Somme des déplacements GPS entre livraisons successives, pics GPS écartés')}
                        ${stat('Respect de l\'ordre planifié', ordre, 'Part des livraisons consécutives qui suivent l\'ordre de tournée prévu')}
                        ${stat('Poids', poids, 'Colonne Poids de l\'export')}
                        ${stat('Signatures', sign, '')}
                        ${stat('Contrôle photo POD', pod, 'Pod Result / Pod Reason de l\'export')}
                    </div>
                    ${motifs.length ? `<div style="margin-top:0.5rem;">
                        <span style="font-size:0.7rem;color:var(--text-secondary);font-weight:700;text-transform:uppercase;">Échecs par motif</span>
                        <span style="font-size:0.78rem;margin-left:0.4rem;"><strong style="color:var(--danger);">${v.imputables} imputables</strong> · ${v.nonImputables} non imputables</span>
                        <button class="btn btn-sm" style="margin-left:0.4rem;padding:0 7px;font-size:0.7rem;background:var(--card);color:var(--text-secondary);border:1px solid var(--border-light);" onclick="editerMotifsImputables()" title="Choisir les motifs imputables au livreur"><i class="fas fa-sliders"></i></button>
                        <div style="display:flex;gap:0.3rem;flex-wrap:wrap;margin-top:0.3rem;">
                            ${motifs.map(([m, n]) => `<span style="padding:1px 7px;border-radius:6px;font-size:0.72rem;background:${imp.includes(m) ? 'rgba(231,76,60,0.14)' : 'var(--card)'};color:${imp.includes(m) ? 'var(--danger)' : 'var(--text-secondary)'};border:1px solid var(--border-light);">${escapeHtml(m)} ×${n}</span>`).join('')}
                        </div></div>` : ''}
                </div>`;
        }

        function ouvrirListeTransferts() {
            const mois = selectedHistoriqueMonth;
            const liste = getTransfertsMois(mois);
            const bouton = `<button class="btn btn-sm btn-primary" onclick="ouvrirTransfertManuel()"><i class="fas fa-plus"></i> Transfert manuel</button>`;
            const lignes = [...liste].sort((a, b) => a.date.localeCompare(b.date)).map(t => `
                <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;
                            padding:0.5rem 0.6rem;border-bottom:1px solid var(--border);font-size:0.85rem;">
                    <div>
                        <strong>${escapeHtml(t.date)}</strong> ·
                        <strong style="color:var(--secondary);">${escapeHtml(t.nb)}</strong> colis ·
                        ${escapeHtml(t.de)} <i class="fas fa-arrow-right" style="color:var(--text-secondary);"></i> <strong>${escapeHtml(t.vers)}</strong>
                        <span style="background:${t.mode === 'auto' ? 'rgba(43,110,143,0.12)' : 'rgba(120,120,120,0.12)'};color:var(--text-secondary);
                                     padding:1px 7px;border-radius:8px;font-size:0.68rem;font-weight:700;margin-left:0.35rem;">
                            ${t.mode === 'auto' ? 'appliqué automatiquement' : 'saisi manuellement'}</span>
                        ${t.note ? `<div style="color:var(--text-secondary);font-size:0.78rem;">${escapeHtml(t.note)}</div>` : ''}
                    </div>
                    <div style="display:flex;gap:0.3rem;white-space:nowrap;${moisEstCloture(mois) ? 'display:none;' : ''}">
                        <button class="btn btn-sm" title="Modifier ce transfert"
                                style="background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);"
                                onclick="modifierTransfert('${escJsAttr(mois)}','${escJsAttr(t.id)}')">
                            <i class="fas fa-pen"></i>
                        </button>
                        <button class="btn btn-danger btn-sm" title="Annuler ce transfert — les colis reviennent au compte d'origine"
                                onclick="supprimerTransfert('${escJsAttr(mois)}','${escJsAttr(t.id)}'); this.closest('.modal-overlay').remove();">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>`).join('');
            const total = liste.reduce((a, t) => a + (Number(t.nb) || 0), 0);
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay active modal-dynamique';
            overlay.style.zIndex = '99998';
            overlay.innerHTML = `
              <div class="modal" style="max-width:640px;">
                <div class="modal-header">
                  <h3 style="margin:0;"><i class="fas fa-exchange-alt"></i> Transferts de colis — ${liste.length} · ${total} colis</h3>
                  <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body" style="padding:1rem 1.25rem 1.25rem;max-height:70vh;overflow-y:auto;">
                  ${_htmlControleCoherence(mois)}
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;gap:0.5rem;">
                    ${moisEstCloture(mois) ? '<span style="font-size:0.8rem;color:var(--text-secondary);"><i class="fas fa-lock"></i> Mois clôturé : transferts en lecture seule</span>' : `<button class="btn btn-sm" onclick="reinitialiserTransfertsMois()"
                            style="background:var(--background-light);color:var(--text-secondary);border:1px solid var(--border-light);">
                      <i class="fas fa-eraser"></i> Tout annuler pour ce mois
                    </button>`}
                    ${moisEstCloture(mois) ? '' : bouton}
                  </div>
                  ${lignes || '<p style="color:var(--text-secondary);font-style:italic;">Aucun transfert enregistré ce mois-ci.</p>'}
                  ${_htmlJournal(mois)}
                </div>
              </div>`;
            document.body.appendChild(overlay);
        }

