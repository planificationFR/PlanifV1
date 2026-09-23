        // ============== DÉTECTION ROUTES PARTAGÉES ==============
        // Règle (métier confirmée) : une route est "partagée" quand PLUSIEURS livreurs
        // apparaissent sur LE MÊME identifiant de route (Plan de dispatchingcode, ex.
        // ROUTECP0337) LE MÊME JOUR. C'est le cas quand un livreur est allé aider un
        // collègue : il a transféré une partie des colis sur son propre compte, donc
        // les deux figurent sur la même route.
        //
        // IMPORTANT : le partage n'enlève AUCUN colis ni euro à personne. Chaque colis
        // reste payé au livreur qui l'a réellement scanné (« Petit nom de membre »).
        // Cette détection sert uniquement à TRACER, pour chaque route partagée :
        // QUAND (date), QUI (les livreurs) et COMBIEN de colis chacun a livré.

        function detectRoutesPartagees(monthData) {
            // Index : { date: { routeId: { livreurName: nbColisLivrés } } }
            const indexRoutes = {};
            Object.entries(monthData).forEach(([livreurName, info]) => {
                const jours = info.jours || {};
                Object.entries(jours).forEach(([date, j]) => {
                    const rc = j.routeColis || {};
                    Object.entries(rc).forEach(([routeId, nb]) => {
                        if (!nb || nb <= 0) return;
                        if (!indexRoutes[date]) indexRoutes[date] = {};
                        if (!indexRoutes[date][routeId]) indexRoutes[date][routeId] = {};
                        indexRoutes[date][routeId][livreurName] =
                            (indexRoutes[date][routeId][livreurName] || 0) + nb;
                    });
                });
            });

            // Ne garder que les routes avec ≥ 2 livreurs distincts
            const detections = [];
            Object.entries(indexRoutes).forEach(([date, routes]) => {
                Object.entries(routes).forEach(([routeId, parLivreur]) => {
                    const noms = Object.keys(parLivreur);
                    if (noms.length < 2) return;

                    // Livreurs triés par nombre de colis décroissant.
                    // Le 1er (le plus de colis) = titulaire ; les autres = renforts/aides.
                    const drivers = noms
                        .map(nom => ({ nom, colis: parLivreur[nom] }))
                        .sort((a, b) => b.colis - a.colis);
                    const totalColis = drivers.reduce((s, d) => s + d.colis, 0);

                    detections.push({
                        date,
                        routeId,
                        drivers,                         // [{nom, colis}, ...]
                        titulaire: drivers[0].nom,       // celui qui a le plus livré
                        renforts: drivers.slice(1),      // ceux venus aider
                        totalColis,
                        nbLivreurs: drivers.length
                    });
                });
            });

            // Tri : date décroissante, puis plus gros volume d'abord
            detections.sort((a, b) =>
                b.date.localeCompare(a.date) || b.totalColis - a.totalColis);
            return detections;
        }

        // Liste les noms de livreurs présents dans l'EPOD qui ne correspondent à
        // AUCUN livreur configuré dans l'application (matching robuste via matchLivreur).
        function detectLivreursNonReconnus(monthData) {
            const inconnus = [];
            Object.entries(monthData).forEach(([nomEPOD, info]) => {
                if (!info || (info.totalLivres || 0) <= 0) return;
                const match = (typeof matchLivreur === 'function') ? matchLivreur(nomEPOD) : null;
                if (!match) inconnus.push({ nom: nomEPOD, colis: info.totalLivres || 0 });
            });
            inconnus.sort((a, b) => b.colis - a.colis);
            return inconnus;
        }

        function detectAndRenderRoutesPartagees(monthData) {
            const detections = detectRoutesPartagees(monthData);
            const inconnus = detectLivreursNonReconnus(monthData);
            const transfertsMois = [];   // v46 — ancien registre supprimé
            const container = document.getElementById('historiqueAlertes');
            if (!container) return;

            if (detections.length === 0 && inconnus.length === 0 && transfertsMois.length === 0) {
                container.style.display = 'none';
                container.innerHTML = '';
                return;
            }

            const colorFor = name => (typeof getLivreurColor === 'function' && data.livreurs?.find(l => l.nom.toLowerCase() === name.toLowerCase()))
                ? getLivreurColor(data.livreurs.find(l => l.nom.toLowerCase() === name.toLowerCase()).id)
                : '#2B6E8F';

            // ─────────────────────────────────────────────────────────────
            // 1) ALERTE : noms de routes non reconnus (aucun livreur associé)
            // ─────────────────────────────────────────────────────────────
            let alerteInconnusHtml = '';
            if (inconnus.length > 0) {
                const lignes = inconnus.map(u => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:0.4rem 0.6rem;background:white;border:1px solid #fcd9b6;border-radius:6px;margin-bottom:0.3rem;font-size:0.85rem;">
                        <span><i class="fas fa-user-slash" style="color:var(--secondary);margin-right:0.4rem;"></i><strong>${escapeHtml(u.nom)}</strong></span>
                        <span style="color:var(--text-secondary);">${u.colis} colis non rattachés</span>
                    </div>`).join('');
                alerteInconnusHtml = `
                    <div style="margin-bottom:1.25rem;padding:1rem 1.1rem;background:rgba(232,89,12,0.08);border-left:4px solid var(--secondary);border-radius:8px;">
                        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.6rem;">
                            <i class="fas fa-exclamation-triangle" style="color:var(--secondary);font-size:1.1rem;"></i>
                            <strong style="color:var(--secondary);font-size:1rem;">Nom(s) de route non reconnu(s)</strong>
                            <span style="background:var(--secondary);color:white;padding:1px 8px;border-radius:10px;font-size:0.75rem;font-weight:700;margin-left:0.3rem;">${inconnus.length}</span>
                        </div>
                        <div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:0.75rem;">
                            Ces noms apparaissent sur les routes mais ne correspondent à aucun livreur de votre liste.
                            Leurs colis ne sont donc pas calculés. Corrigez le nom sur la route pour qu'il soit
                            <strong>identique</strong> à celui de l'application, ou ajoutez le livreur dans l'onglet « Livreurs ».
                        </div>
                        ${lignes}
                    </div>`;
            }

            // ─────────────────────────────────────────────────────────────
            // 2) ROUTES PARTAGÉES : qui, quand, combien de colis (par route)
            // ─────────────────────────────────────────────────────────────
            let routesHtml = '';
            if (detections.length > 0) {
                const totalRoutes = detections.length;
                const totalColisPartages = detections.reduce((s, d) => s + d.totalColis, 0);

                const cartes = detections.map(d => {
                    const dt = new Date(d.date);
                    const jourSemaine = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'][dt.getDay()];
                    const dateStr = `${jourSemaine} ${dt.getDate().toString().padStart(2,'0')}/${(dt.getMonth()+1).toString().padStart(2,'0')}/${dt.getFullYear()}`;

                    const lignesLivreurs = d.drivers.map((drv, idx) => {
                        const c = colorFor(drv.nom);
                        const reconnu = (typeof matchLivreur === 'function') ? matchLivreur(drv.nom) : true;
                        const badgeRole = idx === 0
                            ? `<span style="background:rgba(15,184,154,0.15);color:var(--primary);padding:1px 7px;border-radius:8px;font-size:0.68rem;font-weight:700;">titulaire</span>`
                            : `<span style="background:rgba(255,138,101,0.15);color:#FF8A65;padding:1px 7px;border-radius:8px;font-size:0.68rem;font-weight:700;">renfort</span>`;
                        const flagInconnu = reconnu ? '' : ` <span title="Nom non reconnu dans la liste des livreurs" style="color:var(--secondary);font-size:0.72rem;font-weight:700;">⚠ non reconnu</span>`;
                        return `
                            <div style="display:flex;justify-content:space-between;align-items:center;padding:0.35rem 0.55rem;background:white;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:0.25rem;font-size:0.85rem;">
                                <span><span style="color:${c};font-weight:700;">${escapeHtml(drv.nom)}</span> ${badgeRole}${flagInconnu}</span>
                                <span style="font-weight:700;">${drv.colis} colis</span>
                            </div>`;
                    }).join('');

                    // Marqueur explicite des transferts : chaque renfort a transféré ses colis
                    // depuis la route du titulaire vers son propre compte (déjà comptés dans son total).
                    const titulaire = d.drivers[0];
                    const transferts = d.drivers.slice(1).map(r => `
                            <div style="display:flex;align-items:center;gap:0.4rem;padding:0.3rem 0.55rem;font-size:0.82rem;color:var(--text-secondary);">
                                <i class="fas fa-arrow-right-arrow-left" style="color:var(--primary);font-size:0.75rem;"></i>
                                <span><strong style="color:var(--text);">${r.colis} colis</strong> transféré(s) de <strong>${escapeHtml(titulaire.nom)}</strong> (titulaire) à <strong>${escapeHtml(r.nom)}</strong> (renfort)
                                <span style="color:var(--primary);font-weight:700;">✓ comptés dans son salaire</span></span>
                            </div>`).join('');

                    return `
                        <div style="margin-bottom:0.85rem;padding:0.85rem;background:rgba(15,184,154,0.04);border:1px solid rgba(15,184,154,0.25);border-radius:8px;">
                            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.55rem;font-weight:700;font-size:0.92rem;flex-wrap:wrap;">
                                <i class="fas fa-route" style="color:var(--primary);"></i>
                                <span>${dateStr}</span>
                                <span style="color:var(--text-secondary);font-weight:600;">·</span>
                                <span style="font-family:monospace;background:var(--background-light);padding:1px 7px;border-radius:6px;">${escapeHtml(d.routeId)}</span>
                                <span style="margin-left:auto;font-size:0.78rem;color:var(--text-secondary);font-weight:600;">${d.nbLivreurs} livreurs · ${d.totalColis} colis</span>
                            </div>
                            ${lignesLivreurs}
                            ${transferts ? `<div style="margin-top:0.45rem;border-top:1px dashed rgba(15,184,154,0.3);padding-top:0.35rem;">${transferts}</div>` : ''}
                        </div>`;
                }).join('');

                routesHtml = `
                    <div style="margin-bottom:1.25rem;padding:1rem 1.1rem;background:rgba(15,184,154,0.08);border-left:4px solid var(--primary);border-radius:8px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;cursor:pointer;" onclick="toggleRoutesPartagees(this)">
                            <div style="display:flex;align-items:center;gap:0.5rem;">
                                <i class="fas fa-handshake" style="color:var(--primary);font-size:1.1rem;"></i>
                                <strong style="color:var(--primary);font-size:1rem;">Routes partagées détectées</strong>
                                <span style="background:var(--primary);color:white;padding:1px 8px;border-radius:10px;font-size:0.75rem;font-weight:700;margin-left:0.3rem;">${totalRoutes}</span>
                            </div>
                            <i class="fas fa-chevron-down route-toggle" style="color:var(--text-secondary);transition:transform 0.2s;"></i>
                        </div>
                        <div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:0.75rem;">
                            ${totalRoutes} route(s) partagée(s) ce mois-ci (${totalColisPartages} colis au total).
                            Chaque colis reste payé au livreur qui l'a réellement livré — le partage n'enlève rien à personne.
                        </div>
                        <div class="routes-partagees-detail" style="display:block;">
                            ${cartes}
                        </div>
                    </div>`;
            }

            // v46 — L'ancien encart « Transferts de colis » (data.epodTransferts) est
            // supprimé. Il n'était qu'informatif : il n'a jamais modifié le moindre
            // salaire, affichait des lignes en double et occupait tout l'écran.
            // Les vraies réaffectations vivent dans data.transfertsColis et se
            // consultent via le bouton « Transferts » de la barre de mois.
            const transfertsHtml = '';

            container.style.display = 'block';
            container.innerHTML = alerteInconnusHtml + transfertsHtml + routesHtml;
        }

        function toggleRoutesPartagees(headerEl) {
            const detail = headerEl.parentElement.querySelector('.routes-partagees-detail');
            const chevron = headerEl.querySelector('.route-toggle');
            if (detail.style.display === 'none') {
                detail.style.display = 'block';
                chevron.style.transform = 'rotate(0deg)';
            } else {
                detail.style.display = 'none';
                chevron.style.transform = 'rotate(-90deg)';
            }
        }

        // ═══════════════════════════════════════════════════════════════════
        // MOTEUR DE RÉMUNÉRATION (v43) — ÉTAGE 3
        // ───────────────────────────────────────────────────────────────────
        // Ce moteur ne connaît QU'UNE seule information : un nombre de colis
        // rémunérables. Il ignore totalement les scans, les échecs, les
        // transferts, le titulaire, le renfort et l'origine des colis.
        //
        // Toute la grille est une DONNÉE (data.grilleRemuneration), éditable
        // depuis Paramètres → Grille de salaire. Modifier un palier, un
        // montant ou un type de règle ne demande AUCUNE modification de code.
        //
        // Types de règles supportés :
        //   'par_colis'          → nbColis × prixColis
        //   'forfait'            → montant fixe
        //   'forfait_plus_colis' → montant + (nbColis − colisInclus) × prixColis
        // ═══════════════════════════════════════════════════════════════════

        const GRILLE_REMUNERATION_DEFAUT = [
            { min: 0,   max: 64,   type: 'par_colis',          prixColis: 0.72 },
            { min: 65,  max: 107,  type: 'forfait',            montant: 80 },
            { min: 108, max: 117,  type: 'forfait',            montant: 85 },
            { min: 118, max: 125,  type: 'forfait',            montant: 90 },
            { min: 126, max: 150,  type: 'par_colis',          prixColis: 0.72 },
            { min: 151, max: null, type: 'forfait_plus_colis', montant: 108, prixColis: 0.80, colisInclus: 150 }
        ];

        const TYPES_REGLE_LABELS = {
            par_colis:          'Par colis',
            forfait:            'Forfait',
            forfait_plus_colis: 'Forfait + supplément'
        };

        function arrondiEuro(x) { return Math.round(x * 100) / 100; }

        /** Renvoie la grille active (celle de l'utilisateur, sinon celle par défaut). */
        function getGrilleRemuneration() {
            const g = data && data.grilleRemuneration;
            return (Array.isArray(g) && g.length > 0) ? g : GRILLE_REMUNERATION_DEFAUT;
        }

        /**
         * ÉTAGE 3 — Applique la grille de rémunération à un nombre de colis.
         * @param {number} nbColisRemunerables  colis EFFECTIVEMENT LIVRÉS
         * @param {Array}  [grille]             grille de règles (défaut : grille active)
         * @returns {number} salaire en euros
         */
        function appliquerGrille(nbColisRemunerables, grille) {
            const nb = Number(nbColisRemunerables) || 0;
            if (nb <= 0) return 0;
            const regles = grille || getGrilleRemuneration();
            const regle = regles.find(r =>
                nb >= (Number(r.min) || 0) &&
                (r.max === null || r.max === undefined || r.max === '' || nb <= Number(r.max))
            );
            if (!regle) {
                console.warn('[grille] aucune règle ne couvre', nb, 'colis');
                return 0;
            }
            switch (regle.type) {
                case 'par_colis':
                    return arrondiEuro(nb * (Number(regle.prixColis) || 0));
                case 'forfait':
                    return arrondiEuro(Number(regle.montant) || 0);
                case 'forfait_plus_colis': {
                    const inclus = (regle.colisInclus !== undefined && regle.colisInclus !== null)
                        ? Number(regle.colisInclus)
                        : (Number(regle.min) || 0);
                    const sup = Math.max(0, nb - inclus);
                    return arrondiEuro((Number(regle.montant) || 0) + sup * (Number(regle.prixColis) || 0));
                }
                default:
                    console.warn('[grille] type de règle inconnu :', regle.type);
                    return 0;
            }
        }

        /**
         * Valide une grille : pas de trou, pas de chevauchement, types connus.
         * @returns {{ok:boolean, erreurs:string[]}}
         */
        function validerGrille(grille) {
            const erreurs = [];
            if (!Array.isArray(grille) || grille.length === 0) {
                return { ok: false, erreurs: ['La grille est vide.'] };
            }
            const tri = [...grille].sort((a, b) => (Number(a.min) || 0) - (Number(b.min) || 0));
            if ((Number(tri[0].min) || 0) !== 0) {
                erreurs.push(`La grille doit commencer à 0 colis (elle commence à ${tri[0].min}).`);
            }
            tri.forEach((r, i) => {
                if (!TYPES_REGLE_LABELS[r.type]) erreurs.push(`Ligne ${i + 1} : type de règle inconnu (« ${r.type} »).`);
                const min = Number(r.min) || 0;
                const max = (r.max === null || r.max === undefined || r.max === '') ? null : Number(r.max);
                if (max !== null && max < min) erreurs.push(`Ligne ${i + 1} : le maximum (${max}) est inférieur au minimum (${min}).`);
                if (i < tri.length - 1) {
                    const suivant = Number(tri[i + 1].min) || 0;
                    if (max === null) erreurs.push(`Ligne ${i + 1} : seule la dernière ligne peut être ouverte (∞).`);
                    else if (max + 1 < suivant) erreurs.push(`Trou dans la grille : aucune règle pour ${max + 1} à ${suivant - 1} colis.`);
                    else if (max + 1 > suivant) erreurs.push(`Chevauchement : la ligne ${i + 1} (…${max}) recouvre la suivante (${suivant}…).`);
                }
            });
            const dernier = tri[tri.length - 1];
            const maxDernier = (dernier.max === null || dernier.max === undefined || dernier.max === '') ? null : Number(dernier.max);
            if (maxDernier !== null) erreurs.push('La dernière ligne doit être ouverte (laisser le maximum vide pour « ∞ »).');
            return { ok: erreurs.length === 0, erreurs };
        }

        /** Décrit en clair la règle appliquée à un nombre de colis (affichage). */
        function decrireRegleAppliquee(nbColis) {
            const nb = Number(nbColis) || 0;
            const regles = getGrilleRemuneration();
            const regle = regles.find(r =>
                nb >= (Number(r.min) || 0) &&
                (r.max === null || r.max === undefined || r.max === '' || nb <= Number(r.max))
            );
            if (!regle) return `${nb} colis → aucune règle applicable`;
            const borne = (regle.max === null || regle.max === undefined || regle.max === '')
                ? `${regle.min}+`
                : `${regle.min}-${regle.max}`;
            const montant = appliquerGrille(nb, regles).toFixed(2);
            switch (regle.type) {
                case 'par_colis':
                    return `${nb} colis (${borne}) → ${nb} × ${Number(regle.prixColis).toFixed(2)} € = ${montant} €`;
                case 'forfait':
                    return `${nb} colis (${borne}) → forfait ${montant} €`;
                case 'forfait_plus_colis': {
                    const inclus = (regle.colisInclus ?? regle.min);
                    const sup = Math.max(0, nb - inclus);
                    return `${nb} colis (${borne}) → ${Number(regle.montant).toFixed(2)} € + ${sup} × ${Number(regle.prixColis).toFixed(2)} € = ${montant} €`;
                }
                default:
                    return `${nb} colis → ${montant} €`;
            }
        }

        // ═══════════════════════════════════════════════════════════════════
        // COMPTES TECHNIQUES — ÉTAGE 1
        // Comptes de scan qui ne correspondent à aucun livreur réel
        // (ex. « Renfort-Colmar » utilisé pour scanner les colis problématiques).
        // Leurs colis restent visibles dans les statistiques mais ne sont
        // JAMAIS rémunérés et n'apparaissent pas dans les fiches de paie.
        // ═══════════════════════════════════════════════════════════════════

        const COMPTES_TECHNIQUES_DEFAUT = ['Renfort-Colmar'];

        function getComptesTechniques() {
            const c = data && data.comptesTechniques;
            return (Array.isArray(c)) ? c : COMPTES_TECHNIQUES_DEFAUT;
        }

        function estCompteTechnique(nom) {
            if (!nom) return false;
            const n = String(nom).trim().toLowerCase();
            return getComptesTechniques().some(c => String(c).trim().toLowerCase() === n);
        }

        // ═══════════════════════════════════════════════════════════════════
        // ÉTAGE 2 — COLIS RÉMUNÉRABLES
        // Règle d'or : le scan sert au suivi, la LIVRAISON EFFECTIVE sert au
        // salaire. L'export EPOD reflète déjà le livreur final (transferts
        // inclus), donc les colis rémunérables d'un livreur pour une journée
        // sont exactement ses colis livrés ce jour-là.
        // ═══════════════════════════════════════════════════════════════════

        /**
         * @param {{livres:number, cedes?:number, recus?:number}} jour
         *        agrégat opérationnel d'une journée, éventuellement enrichi
         *        des transferts par appliquerTransfertsMois()
         */
        function colisRemunerablesJour(jour) {
            if (!jour) return 0;
            const livres = Number(jour.livres) || 0;
            const cedes  = Number(jour.cedes)  || 0;
            const recus  = Number(jour.recus)  || 0;
            return Math.max(0, livres - cedes + recus);
        }

        // ═══════════════════════════════════════════════════════════════════
        // TRANSFERTS DE COLIS (v44) — ÉTAGE 2
        // ───────────────────────────────────────────────────────────────────
        // Un transfert exprime : « le JJ/MM, N colis enregistrés sous le compte
        // de X ont en réalité été livrés par Y ». Il ne modifie JAMAIS les
        // données opérationnelles importées (scans, livraisons, échecs, PUDO
        // restent intacts et consultables) : il n'agit que sur le nombre de
        // colis rémunérables.
        //
        //     colis rémunérables = colis livrés − colis cédés + colis reçus
        //
        // Deux origines possibles :
        //   'auto'   → proposé par le détecteur de tournées simultanées,
        //              puis confirmé par l'utilisateur
        //   'manuel' → saisi directement par l'utilisateur
        // ═══════════════════════════════════════════════════════════════════

        function getTransfertsMois(mois) {
            return (data.transfertsColis && data.transfertsColis[mois]) || [];
        }

        function _ensureTransfertsMois(mois) {
            if (!data.transfertsColis) data.transfertsColis = {};
            if (!Array.isArray(data.transfertsColis[mois])) data.transfertsColis[mois] = [];
            return data.transfertsColis[mois];
        }

        /**
         * Agrège les transferts d'un mois par (compte, date).
         * @returns {{[cle:string]: {cedes:number, recus:number}}}  clé « compte|date »
         */
        function calculerAjustementsTransferts(mois) {
            const ajust = {};
            const add = (compte, date, champ, nb) => {
                const k = compte + '|' + date;
                if (!ajust[k]) ajust[k] = { cedes: 0, recus: 0 };
                ajust[k][champ] += nb;
            };
            getTransfertsMois(mois).forEach(t => {
                const nb = Number(t.nb) || 0;
                if (nb <= 0 || !t.date || !t.de || !t.vers) return;
                add(t.de, t.date, 'cedes', nb);
                add(t.vers, t.date, 'recus', nb);
            });
            return ajust;
        }

        /**
         * Renvoie une COPIE des données d'un mois enrichie des transferts.
         * Chaque journée reçoit .cedes / .recus ; les compteurs bruts (livres,
         * echecs, pudo…) ne sont pas touchés.
         */
        function appliquerTransfertsMois(monthData, mois) {
            if (!monthData) return monthData;
            const ajust = calculerAjustementsTransferts(mois);
            // v46 — même sans aucun transfert, on renvoie des objets porteurs de
            // totalRemunerables / totalCedes / totalRecus. Auparavant les données
            // étaient renvoyées telles quelles et ces champs manquaient, obligeant
            // chaque point d'affichage à gérer le cas « champ absent » — source
            // silencieuse d'incohérences entre les écrans.
            if (!Object.keys(ajust).length) {
                const tel = {};
                Object.entries(monthData).forEach(([compte, liv]) => {
                    tel[compte] = {
                        ...liv,
                        totalCedes: 0, totalRecus: 0,
                        totalRemunerables: Object.values(liv.jours || {})
                            .reduce((a, j) => a + colisRemunerablesJour(j), 0)
                    };
                });
                return tel;
            }
            const copie = {};
            Object.entries(monthData).forEach(([compte, liv]) => {
                const jours = {};
                let totalCedes = 0, totalRecus = 0;
                Object.entries(liv.jours || {}).forEach(([date, j]) => {
                    const a = ajust[compte + '|' + date];
                    if (a) {
                        // On ne peut pas céder plus de colis qu'on n'en a livrés
                        const cedes = Math.min(a.cedes, Number(j.livres) || 0);
                        jours[date] = { ...j, cedes, recus: a.recus };
                        totalCedes += cedes; totalRecus += a.recus;
                    } else {
                        jours[date] = j;
                    }
                });
                // Journées où le livreur n'a QUE des colis reçus (il n'apparaît pas
                // ce jour-là dans l'export mais a bien livré pour un collègue)
                Object.entries(ajust).forEach(([k, a]) => {
                    const [c, date] = k.split('|');
                    if (c === compte && !jours[date] && a.recus > 0) {
                        jours[date] = { livres: 0, prevus: 0, pudo: 0, echecs: 0, routes: [], codesPostaux: [], routeColis: {}, cedes: 0, recus: a.recus };
                        totalRecus += a.recus;
                    }
                });
                // totalLivres reste le chiffre BRUT de l'export (statistiques).
                // totalRemunerables est ce qui sert à la paie et à l'affichage.
                const totalRemunerables = Object.values(jours).reduce((a, j) => a + colisRemunerablesJour(j), 0);
                copie[compte] = { ...liv, jours, totalCedes, totalRecus, totalRemunerables };
            });
            // Comptes absents de l'export mais destinataires d'un transfert
            Object.entries(ajust).forEach(([k, a]) => {
                const [compte, date] = k.split('|');
                if (copie[compte] || a.recus <= 0) return;
                copie[compte] = {
                    jours: { [date]: { livres: 0, prevus: 0, pudo: 0, echecs: 0, routes: [], codesPostaux: [], routeColis: {}, cedes: 0, recus: a.recus } },
                    totalLivres: 0, totalPrevus: 0, totalPudo: 0, totalEchecs: 0,
                    totalCedes: 0, totalRecus: a.recus, totalRemunerables: a.recus
                };
            });
            return copie;
        }

        function enregistrerTransfert({ mois, date, de, vers, nb, mode, note, routes }) {
            const n = Number(nb) || 0;
            if (!date || !de || !vers || n <= 0) { showToast('Transfert incomplet', 'warning'); return null; }
            if (de === vers) { showToast('Source et destinataire identiques', 'warning'); return null; }
            if (!verifierMoisOuvert(String(date).slice(0, 7), 'transfert')) return null;
            // Le mois d'un transfert est toujours celui de sa date : s'appuyer sur
            // le mois affiché à l'écran rangerait le transfert au mauvais endroit
            // dès que l'utilisateur consulte un autre mois que celui des données.
            const liste = _ensureTransfertsMois(String(date).slice(0, 7));
            // Un réimport du même fichier ne doit pas empiler deux fois le même
            // transfert : on remplace celui qui porte déjà sur ce trio.
            const doublon = liste.findIndex(x => x.date === date && x.de === de && x.vers === vers && x.mode === (mode || 'manuel'));
            if (doublon >= 0) liste.splice(doublon, 1);
            const t = {
                id: 'tr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
                date, de, vers, nb: n,
                mode: mode || 'manuel',
                note: note || '',
                routes: routes || [],
                creeLe: new Date().toISOString()
            };
            liste.push(t);
            journaliser(String(date).slice(0, 7), 'ajout', { id: t.id, date, de, vers, nb: n, mode: t.mode, note: t.note, routes: t.routes });
            markUnsaved(); saveLocal();
            return t;
        }

        /** Annule toutes les réaffectations du mois et rend les colis à leur compte d'origine. */
        function reinitialiserTransfertsMois() {
            const mois = selectedHistoriqueMonth;
            const n = getTransfertsMois(mois).length;
            if (!n) { showToast('Aucun transfert à annuler', 'info'); return; }
            if (!verifierMoisOuvert(mois, 'réinitialisation')) return;
            if (!confirm(`Annuler les ${n} transfert(s) de ce mois ?\n\nTous les colis reviennent au compte sous lequel ils ont été livrés. Les détections restent disponibles pour être réappliquées.`)) return;
            getTransfertsMois(mois).forEach(t => journaliser(mois, 'suppression', { id: t.id, date: t.date, de: t.de, vers: t.vers, nb: t.nb, mode: t.mode, note: t.note, routes: t.routes }));
            journaliser(mois, 'reset', { n });
            data.transfertsColis[mois] = [];
            (getAnomaliesMois(mois) || []).forEach(a => { if (a.statut === 'affecte') a.statut = 'a_traiter'; });
            markUnsaved(); saveLocal();
            fermerModalesDynamiques();
            refreshHistorique();
            showToast(`${n} transfert(s) annulé(s)`, 'success');
        }

        /** Rouvre le formulaire pré-rempli pour corriger un transfert existant. */
        function modifierTransfert(mois, id) {
            const t = getTransfertsMois(mois).find(x => x.id === id);
            if (!t) { showToast('Transfert introuvable', 'error'); return; }
            fermerModalesDynamiques();
            ouvrirTransfertManuel({ date: t.date, de: t.de, vers: t.vers, nb: t.nb, note: t.note, remplaceId: id });
        }

        function supprimerTransfert(mois, id) {
            if (!verifierMoisOuvert(mois, 'annulation')) return;
            const liste = getTransfertsMois(mois);
            const i = liste.findIndex(t => t.id === id);
            if (i < 0) return;
            const t = liste[i];
            liste.splice(i, 1);
            journaliser(mois, 'suppression', { id: t.id, date: t.date, de: t.de, vers: t.vers, nb: t.nb, mode: t.mode, note: t.note, routes: t.routes });
            // La détection correspondante redevient « à traiter »
            (getAnomaliesMois(mois) || []).forEach(a => { if (a.statut === 'affecte' && a.date === t.date && a.compte === t.de) a.statut = 'a_traiter'; });
            markUnsaved(); saveLocal();
            refreshHistorique();
            showToast('Transfert annulé — les colis reviennent au compte d\'origine', 'info');
        }

        // ═══════════════════════════════════════════════════════════════════
        // DÉTECTEUR DE RENFORTS (v50) — moteur pur, sans DOM
        // ───────────────────────────────────────────────────────────────────
        // Constat sur les données réelles : quand un renfort B livre des
        // colis de A, l'export ne montre PAS B livrant sous son compte dans
        // la zone de A. Les colis restent sous le compte de A : la journée de
        // A contient alors DEUX séquences de livraison entrelacées, à
        // plusieurs kilomètres l'une de l'autre. Une personne seule ne peut
        // pas alterner 20 fois entre deux villages à 17 km en 90 minutes.
        //
        // Le moteur combine plusieurs signaux indépendants :
        //   1. double séquence sous un compte (alternance + partition +
        //      ordre planifié)                      → signal principal
        //   2. attribution du livreur B par niveau de preuve
        //      N1 : B a livré des colis de la route de A ce jour-là
        //      N2 : B est absent de sa tournée pendant la fenêtre et le
        //           détour est faisable à sa vitesse habituelle
        //      N3 : inférence (secteur connu, proximité)
        //   3. colis de B dans une zone tenue par A le même jour (vue zone,
        //      secondaire, scorée bas)
        //   4. colis dont la route diffère de la route du jour du livreur
        //      (réaffectation explicite du dispatch : fait observé)
        //
        // Toute analyse est partitionnée DÉPÔT → DATE → COMPTE : deux
        // livreurs de dépôts différents ne sont jamais comparés.
        //
        // Règle métier : un groupe < 5 colis n'entre jamais dans le calcul
        // principal ; il est signalé à part pour vérification manuelle.
        // ═══════════════════════════════════════════════════════════════════

        /** Nombre fini strict : null n'est PAS une coordonnée (isFinite(null) vaut true). */
        const _fin = v => typeof v === 'number' && isFinite(v);

        const RENFORT_PARAMS = {
            seuilColis: 5,             // règle métier absolue
            fenetreMin: 90,            // fenêtre glissante d'alternance (minutes)
            sautKm: 4,                 // saut « significatif » entre deux points consécutifs
            sautsMin: 6,               // sauts dans la fenêtre pour déclencher
            sautsFort: 12,             // saturation du signal d'alternance
            separationKm: 3,           // distance minimale entre les deux groupes
            picKm: 5,                  // pic GPS : point à > picKm de ses deux voisins
            picVoisinsKm: 2,           // … alors que les voisins sont à < picVoisinsKm
            picMaxParHeure: 2,         // sauts admis à ± 30 min autour d'un pic (ses deux propres sauts)
            arretSec: 45,              // scans groupés : Δt < arretSec et distance < arretKm = même arrêt
            arretKm: 1.5,
            vRefMin: 20, vRefMax: 80,  // bornes de la vitesse de référence (P90 observé)
            vRefDefaut: 35,
            vDetourMin: 40,            // vitesse moyenne minimale admise pour un détour routier entre communes
            celluleLat: 0.0135, celluleLon: 0.02,   // grille ≈ 1,5 km (vue zone)
            zoneMinSource: 5,          // A doit tenir la cellule avec ≥ 5 colis
            zoneClusterGapMin: 30,     // rupture temporelle d'un cluster hors zone
            ecartCandidatsMin: 20,     // écart de score entre 1er et 2e candidat
            seuils: { certain: 85, tresProbable: 70, probable: 55, possible: 40 }
        };

        function _distanceKm(lat1, lon1, lat2, lon2) {
            const dLat = (lat2 - lat1) * 111.0;
            const dLon = (lon2 - lon1) * 111.0 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
            return Math.hypot(dLat, dLon);
        }

        function _hhmm(ms) {
            const d = new Date(ms);
            return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        }

        /** Quantile d'un tableau numérique (copie triée). */
        function _quantile(arr, q) {
            if (!arr.length) return null;
            const s = [...arr].sort((a, b) => a - b);
            const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
            return s[lo] + (s[hi] - s[lo]) * (pos - lo);
        }

        function _cellule(lat, lon) {
            return Math.round(lat / RENFORT_PARAMS.celluleLat) + '_' + Math.round(lon / RENFORT_PARAMS.celluleLon);
        }

        /**
         * Nettoie la séquence d'un compte-jour :
         *  - repère les pics GPS isolés (géocodage faux) et les remplace par la
         *    position théorique quand elle est cohérente, sinon les retire de
         *    la géométrie (le colis reste compté) ;
         *  - fusionne les scans groupés en « arrêts » pour ne jamais calculer
         *    une vitesse à l'intérieur d'un arrêt.
         * @returns {{pts:Array, aberrants:number, arrets:number}}
         */
        function nettoyerSequence(colis) {
            const P = RENFORT_PARAMS;
            const pts = colis
                .filter(c => c.tsLivraison && _fin(c.lat) && _fin(c.lon))
                .sort((a, b) => a.tsLivraison - b.tsLivraison)
                .map(c => ({ ...c, geo: true, aberrant: false }));
            const n = pts.length;
            if (n < 3) { pts.forEach((p, i) => { p.arret = i; }); return { pts, aberrants: 0, arrets: n }; }

            // Candidats « pic » : loin des deux voisins, voisins proches entre eux
            const cand = [];
            for (let i = 1; i < n - 1; i++) {
                const a = pts[i - 1], p = pts[i], b = pts[i + 1];
                if (_distanceKm(p.lat, p.lon, a.lat, a.lon) > P.picKm &&
                    _distanceKm(p.lat, p.lon, b.lat, b.lon) > P.picKm &&
                    _distanceKm(a.lat, a.lon, b.lat, b.lon) < P.picVoisinsKm) cand.push(i);
            }
            // Un pic n'est « isolé » que si, à ± 30 min, les seuls sauts
            // significatifs sont les deux qu'il provoque lui-même. Une
            // alternance entre deux zones produit des sauts en continu.
            const tSauts = [];
            for (let i = 1; i < n; i++) if (_distanceKm(pts[i].lat, pts[i].lon, pts[i - 1].lat, pts[i - 1].lon) > P.sautKm) tSauts.push(pts[i].tsLivraison);
            let aberrants = 0;
            cand.forEach(i => {
                const t = pts[i].tsLivraison;
                const sautsAutour = tSauts.filter(x => Math.abs(x - t) <= 1800000).length;
                if (sautsAutour > P.picMaxParHeure) return;     // alternance : ce n'est pas un pic
                const p = pts[i], a = pts[i - 1];
                p.aberrant = true; aberrants++;
                if (_fin(p.latTheo) && _fin(p.lonTheo) &&
                    _distanceKm(p.latTheo, p.lonTheo, a.lat, a.lon) < P.picKm) {
                    p.latOrig = p.lat; p.lonOrig = p.lon;
                    p.lat = p.latTheo; p.lon = p.lonTheo;   // position théorique cohérente
                } else {
                    p.geo = false;                          // exclu de la géométrie
                }
            });

            // Arrêts : scans groupés
            let arrets = 0, prev = null;
            pts.forEach(p => {
                if (!p.geo) { p.arret = -1; return; }
                if (prev && (p.tsLivraison - prev.tsLivraison) < P.arretSec * 1000 &&
                    _distanceKm(p.lat, p.lon, prev.lat, prev.lon) < P.arretKm) {
                    p.arret = prev.arret;
                } else { p.arret = arrets++; }
                prev = p;
            });
            return { pts, aberrants, arrets };
        }

        /**
         * Segments de déplacement entre arrêts successifs, avec vitesse
         * nécessaire et niveau de plausibilité.
         */
        function analyserDeplacements(pts, vRef) {
            const geo = pts.filter(p => p.geo);
            const segs = [];
            for (let i = 1; i < geo.length; i++) {
                const a = geo[i - 1], b = geo[i];
                if (a.arret === b.arret) continue;
                const km = _distanceKm(a.lat, a.lon, b.lat, b.lon);
                const min = (b.tsLivraison - a.tsLivraison) / 60000;
                const v = min > 0 ? km / (min / 60) : (km > 0.3 ? Infinity : 0);
                let niveau = 'coherent';
                if (!_fin(v) || v > 2 * vRef || (km > 0.3 && min < 0.5)) niveau = 'impossible';
                else if (v > 1.5 * vRef) niveau = 'tres_improbable';
                else if (v > vRef) niveau = 'difficile';
                else if (v > 0.6 * vRef) niveau = 'plausible';
                segs.push({ de: a, a: b, km, min, v, niveau });
            }
            return segs;
        }

        /**
         * Partition en deux groupes des points d'une fenêtre (2-moyennes
         * initialisées sur les deux extrémités du plus grand saut).
         */
        function partitionnerFenetre(pts) {
            const geo = pts.filter(p => p.geo);
            if (geo.length < 4) return null;
            let best = 0, bi = 0;
            for (let i = 1; i < geo.length; i++) {
                const d = _distanceKm(geo[i].lat, geo[i].lon, geo[i - 1].lat, geo[i - 1].lon);
                if (d > best) { best = d; bi = i; }
            }
            let c0 = { lat: geo[bi - 1].lat, lon: geo[bi - 1].lon }, c1 = { lat: geo[bi].lat, lon: geo[bi].lon };
            let lab = new Array(geo.length).fill(0);
            for (let it = 0; it < 12; it++) {
                let changed = false;
                geo.forEach((p, i) => {
                    const l = _distanceKm(p.lat, p.lon, c0.lat, c0.lon) <= _distanceKm(p.lat, p.lon, c1.lat, c1.lon) ? 0 : 1;
                    if (l !== lab[i]) { lab[i] = l; changed = true; }
                });
                const s = [{ lat: 0, lon: 0, n: 0 }, { lat: 0, lon: 0, n: 0 }];
                geo.forEach((p, i) => { s[lab[i]].lat += p.lat; s[lab[i]].lon += p.lon; s[lab[i]].n++; });
                if (!s[0].n || !s[1].n) return null;
                c0 = { lat: s[0].lat / s[0].n, lon: s[0].lon / s[0].n };
                c1 = { lat: s[1].lat / s[1].n, lon: s[1].lon / s[1].n };
                if (!changed) break;
            }
            const g = [[], []];
            geo.forEach((p, i) => g[lab[i]].push(p));
            let alternances = 0;
            for (let i = 1; i < lab.length; i++) if (lab[i] !== lab[i - 1]) alternances++;
            return { groupes: g, centres: [c0, c1], separationKm: _distanceKm(c0.lat, c0.lon, c1.lat, c1.lon), alternances };
        }

        /** Part des paires consécutives dont l'ordre planifié va dans le même sens (0..1). */
        function _monotonie(groupe) {
            const o = groupe.map(p => p.ordre).filter(v => _fin(v) && v >= 0);
            if (o.length < 3) return null;
            let up = 0, down = 0;
            for (let i = 1; i < o.length; i++) { if (o[i] > o[i - 1]) up++; else if (o[i] < o[i - 1]) down++; }
            return Math.max(up, down) / (o.length - 1);
        }

        /**
         * Recherche les fenêtres d'alternance d'un compte-jour et construit,
         * pour chacune, le groupe de colis « orphelin ».
         */
        function detecterDoubleSequence(pts, ctx) {
            const P = RENFORT_PARAMS;
            const geo = pts.filter(p => p.geo);
            if (geo.length < 2 * P.seuilColis) return [];
            const sauts = [];
            for (let i = 1; i < geo.length; i++) {
                if (_distanceKm(geo[i].lat, geo[i].lon, geo[i - 1].lat, geo[i - 1].lon) > P.sautKm) sauts.push(geo[i].tsLivraison);
            }
            const fenetres = [];
            let restants = [...sauts];
            for (let k = 0; k < 4 && restants.length >= P.sautsMin; k++) {
                let best = null;
                restants.forEach((t0, i) => {
                    const dans = restants.filter(t => t >= t0 && t <= t0 + P.fenetreMin * 60000);
                    if (dans.length >= P.sautsMin && (!best || dans.length > best.n)) best = { t0, t1: Math.max(...dans), n: dans.length };
                });
                if (!best) break;
                fenetres.push(best);
                restants = restants.filter(t => t < best.t0 - 600000 || t > best.t1 + 600000);
            }

            const resultats = [];
            fenetres.forEach(f => {
                const debut = f.t0 - 600000, fin = f.t1 + 600000;
                const dedans = pts.filter(p => p.tsLivraison >= debut && p.tsLivraison <= fin);
                const part = partitionnerFenetre(dedans);
                if (!part || part.separationKm < P.separationKm) return;
                if (part.groupes[0].length < 2 || part.groupes[1].length < 2 || part.alternances < 3) return;

                // Continuité de chaque groupe avec le reste de la journée
                const dehors = geo.filter(p => p.tsLivraison < debut || p.tsLivraison > fin);
                const prox = part.centres.map(c => {
                    if (!dehors.length) return 0;
                    return dehors.filter(p => _distanceKm(p.lat, p.lon, c.lat, c.lon) < P.separationKm).length / dehors.length;
                });
                // Le titulaire est le groupe le plus continu avec le reste de la
                // journée ; à égalité, le plus gros. Le point de départ de
                // tournée (heureDebut) départage si connu.
                let titulaire = prox[0] > prox[1] ? 0 : prox[1] > prox[0] ? 1 : (part.groupes[0].length >= part.groupes[1].length ? 0 : 1);
                const orphelin = 1 - titulaire;
                const gO = part.groupes[orphelin], gT = part.groupes[titulaire];
                const mono = [_monotonie(gO), _monotonie(gT)];
                const monoOk = mono.every(m => m === null || m >= 0.75);
                const monoScore = (mono[0] === null && mono[1] === null) ? 0.5 : Math.min(...mono.filter(m => m !== null));

                resultats.push({
                    type: 'double_sequence',
                    debut: gO[0].tsLivraison, fin: gO[gO.length - 1].tsLivraison,
                    fenetreDebut: debut, fenetreFin: fin,
                    colis: gO, colisTitulaire: gT,
                    centre: part.centres[orphelin], centreTitulaire: part.centres[titulaire],
                    separationKm: part.separationKm, sauts: f.n, alternances: part.alternances,
                    monotonie: mono, monoOk,
                    signalDouble: Math.min(1, f.n / P.sautsFort) * 0.4
                                + Math.min(1, part.alternances / 8) * 0.3
                                + monoScore * 0.3,
                    ambiguTitulaire: Math.abs(prox[0] - prox[1]) < 0.15
                });
            });
            return resultats;
        }

        /**
         * Profils mensuels par livreur (par dépôt) : cellules, CP, vitesse de
         * référence, jours actifs, indice de polyvalence.
         */
        function construireProfils(recsDepot) {
            const P = RENFORT_PARAMS;
            const parLiv = {};
            recsDepot.forEach(r => {
                if (r.echec) return;
                const p = (parLiv[r.courier] = parLiv[r.courier] || { n: 0, cp: {}, cellules: {}, jours: new Set(), cpParJour: {}, vitesses: [], routes: {} });
                p.n++;
                if (r.cp) { p.cp[r.cp] = (p.cp[r.cp] || 0) + 1; (p.cpParJour[r.date] = p.cpParJour[r.date] || new Set()).add(r.cp); }
                if (_fin(r.lat) && _fin(r.lon)) { const c = _cellule(r.lat, r.lon); p.cellules[c] = (p.cellules[c] || 0) + 1; }
                if (r.routeId) p.routes[r.routeId] = (p.routes[r.routeId] || 0) + 1;
                p.jours.add(r.date);
            });
            // Vitesses observées (hors arrêts) par livreur
            const parLivJour = {};
            recsDepot.forEach(r => {
                if (r.echec || !r.tsLivraison || !_fin(r.lat) || !_fin(r.lon)) return;
                (parLivJour[r.courier + '|' + r.date] = parLivJour[r.courier + '|' + r.date] || []).push(r);
            });
            Object.entries(parLivJour).forEach(([k, list]) => {
                const liv = k.split('|')[0];
                const { pts } = nettoyerSequence(list);
                analyserDeplacements(pts, 999).forEach(s => { if (s.min >= 1 && _fin(s.v) && s.v < 150) parLiv[liv].vitesses.push(s.v); });
            });
            Object.values(parLiv).forEach(p => {
                const p90 = _quantile(p.vitesses, 0.9);
                p.vRef = p90 === null ? P.vRefDefaut : Math.min(P.vRefMax, Math.max(P.vRefMin, p90));
                p.nbJours = p.jours.size;
                // Polyvalence : nombre moyen de CP distincts par jour / total CP
                const cpJ = Object.values(p.cpParJour).map(s => s.size);
                const totCP = Object.keys(p.cp).length;
                p.polyvalence = (cpJ.length && totCP) ? Math.min(1, (cpJ.reduce((a, b) => a + b, 0) / cpJ.length) / Math.max(1, totCP) * 2) : 0.5;
                p.partCellule = (lat, lon) => p.n ? (p.cellules[_cellule(lat, lon)] || 0) / p.n : 0;
                p.partCP = cp => p.n ? (p.cp[cp] || 0) / p.n : 0;
            });
            return parLiv;
        }

        /**
         * Attribue le livreur source/receveur le plus probable pour un groupe de
         * colis livrés sous `compte` dans la fenêtre [debut, fin].
         */
        function attribuerSource(groupe, compte, date, ctx) {
            const P = RENFORT_PARAMS;
            const { activite, positions, profils, routesJour, routePrincipale, estTechnique } = ctx;
            const debut = groupe.debut, fin = groupe.fin;
            const creneauMin = Math.max(1, (fin - debut) / 60000);
            const centre = groupe.centre;
            const cps = {};
            groupe.colis.forEach(c => { if (c.cp) cps[String(c.cp)] = (cps[String(c.cp)] || 0) + 1; });
            const routeA = routePrincipale[date + '|' + compte];

            const candidats = [];
            Object.entries(activite[date] || {}).forEach(([autre, ts]) => {
                if (autre === compte || estTechnique(autre)) return;
                if (ts.length < 2) return;
                const prof = profils[autre] || { vRef: P.vRefDefaut, partCellule: () => 0, partCP: () => 0, polyvalence: 0.5 };

                // N1 — B a livré, sous SON compte, des colis de la route de A ce jour-là
                const colisRouteA = routeA ? ((routesJour[date + '|' + autre] || {})[routeA] || 0) : 0;
                const n1 = colisRouteA > 0;

                // N2 — trou d'activité qui recouvre la fenêtre + détour faisable
                let trouDebut = null, trouFin = null, meilleurRec = -1;
                for (let i = 1; i < ts.length; i++) {
                    const rec = Math.max(0, Math.min(ts[i], fin) - Math.max(ts[i - 1], debut));
                    if (rec > meilleurRec) { meilleurRec = rec; trouDebut = ts[i - 1]; trouFin = ts[i]; }
                }
                // Cas : B n'a rien livré avant / après (journée partielle)
                if (ts[0] > debut) { const rec = Math.max(0, Math.min(ts[0], fin) - debut); if (rec > meilleurRec) { meilleurRec = rec; trouDebut = null; trouFin = ts[0]; } }
                if (ts[ts.length - 1] < fin) { const rec = Math.max(0, fin - Math.max(ts[ts.length - 1], debut)); if (rec > meilleurRec) { meilleurRec = rec; trouDebut = ts[ts.length - 1]; trouFin = null; } }
                const recouvrement = Math.max(0, meilleurRec) / 60000 / creneauMin;
                const colisDansFenetre = ts.filter(t => t >= debut && t <= fin).length;

                const pts = (positions[date] || {})[autre] || [];
                let avant = null, apres = null;
                for (const p of pts) {
                    if (trouDebut !== null && p.ts <= trouDebut) avant = p;
                    if (trouFin !== null && p.ts >= trouFin && !apres) apres = p;
                }
                let detourKm = null, faisable = null, vraiDetour = null, vitesseNecessaire = null, tempsDispoMin = null;
                if (avant || apres) {
                    const aller = avant ? _distanceKm(avant.lat, avant.lon, centre.lat, centre.lon) : 0;
                    const retour = apres ? _distanceKm(centre.lat, centre.lon, apres.lat, apres.lon) : 0;
                    const direct = (avant && apres) ? _distanceKm(avant.lat, avant.lon, apres.lat, apres.lon) : 0;
                    detourKm = Math.round((aller + retour) * 10) / 10;
                    const t0 = avant ? avant.ts : debut, t1 = apres ? apres.ts : fin;
                    tempsDispoMin = Math.max(0, (t1 - t0) / 60000 - creneauMin);   // temps hors livraison du groupe
                    vitesseNecessaire = tempsDispoMin > 0 ? (aller + retour) / (tempsDispoMin / 60) : Infinity;
                    faisable = vitesseNecessaire <= Math.max(prof.vRef * 1.3, RENFORT_PARAMS.vDetourMin);
                    vraiDetour = (avant && apres) ? (aller + retour) > direct * 1.3 : true;
                }
                const n2 = recouvrement >= 0.7 && faisable === true;

                // N3 — connaissance de la zone
                const partZone = groupe.colis.reduce((s, c) => s + prof.partCellule(c.lat, c.lon), 0) / groupe.colis.length;
                const partCP = Object.entries(cps).reduce((s, [cp, n]) => s + prof.partCP(cp) * n, 0) / groupe.colis.length;
                const connaissance = Math.min(1, Math.max(partZone * 20, partCP * 4));
                const bary = (ctx.barycentres[date] || {})[autre];
                const distKm = bary ? _distanceKm(bary.lat, bary.lon, centre.lat, centre.lon) : 999;
                const proximite = Math.max(0, 1 - distKm / 25);

                let niveau, attribution;
                if (n1) { niveau = 1; attribution = 1; }
                else if (n2) { niveau = 2; attribution = 0.6 + 0.3 * recouvrement + 0.1 * (vraiDetour ? 1 : 0); }
                else { niveau = 3; attribution = Math.min(0.4, 0.25 * recouvrement + 0.1 * connaissance + 0.05 * proximite); }
                if (colisDansFenetre > groupe.colis.length * 0.5 && !n1) attribution *= 0.4;   // B livrait ailleurs pendant ce temps
                // Apprentissage : une paire déjà validée plusieurs fois par l'utilisateur
                // est un signal faible en faveur du même candidat (jamais décisif seul).
                const hist = ctx.historique && ctx.historique.paires && ctx.historique.paires[compte + '|' + autre];
                let histBonus = 0;
                if (hist) { if (hist.valide >= 2 && hist.valide > hist.ecarte) histBonus = Math.min(0.1, 0.05 * hist.valide); else if (hist.ecarte >= 2 && hist.ecarte > hist.valide) histBonus = -0.1; }
                attribution = Math.max(0, Math.min(1, attribution + histBonus));

                candidats.push({
                    nom: autre, niveau, attribution,
                    score: Math.round(attribution * 100),
                    colisRouteA,
                    recouvrementPct: Math.round(recouvrement * 100),
                    absentDe: trouDebut !== null ? _hhmm(trouDebut) : 'début',
                    absentA: trouFin !== null ? _hhmm(trouFin) : 'fin',
                    trouMinutes: (trouDebut !== null && trouFin !== null) ? Math.round((trouFin - trouDebut) / 60000) : null,
                    colisDansFenetre,
                    detourKm, faisable, vraiDetour,
                    vitesseNecessaire: vitesseNecessaire === null ? null : (_fin(vitesseNecessaire) ? Math.round(vitesseNecessaire * 10) / 10 : null),
                    tempsDispoMin: tempsDispoMin === null ? null : Math.round(tempsDispoMin),
                    vRef: Math.round(prof.vRef),
                    cpPctMois: Math.round(partCP * 100), cpPct: Math.round(connaissance * 100),
                    cpsCommuns: Object.keys(cps).filter(cp => prof.partCP(cp) > 0.01).slice(0, 4),
                    distanceKm: Math.round(distKm * 10) / 10,
                    detourScore: n2 ? 100 : (faisable ? 50 : 0),
                    histValide: hist ? hist.valide : 0, histEcarte: hist ? hist.ecarte : 0
                });
            });
            candidats.sort((a, b) => b.score - a.score || b.recouvrementPct - a.recouvrementPct);
            return candidats;
        }

        function _categorie(score, niveau) {
            const S = RENFORT_PARAMS.seuils;
            if (score >= S.certain && niveau && niveau <= 2) return 'Certain';
            if (score >= S.tresProbable) return 'Très probable';
            if (score >= S.probable) return 'Probable';
            if (score >= S.possible) return 'Possible';
            return 'Inconclusif';
        }
        const _CONFIANCE_LEGACY = { 'Certain': 'certain', 'Très probable': 'probable', 'Probable': 'probable', 'Possible': 'doute', 'Inconclusif': 'aucune' };

        /**
         * Score 0–100 d'une détection « double séquence ». Quatre familles
         * indépendantes, puis multiplicateur de qualité des données.
         */
        function scorerRenfort(det, cand, qualite) {
            const P = RENFORT_PARAMS;
            const n = det.colis.length;
            const double = det.signalDouble;                                  // 0..1
            const attribution = cand ? cand.attribution : 0;                  // 0..1
            const masse = Math.min(1, n / 20) * 0.7 + (det.separationKm >= P.separationKm ? 0.3 : 0);
            let externe = 0;
            if (cand) {
                if (cand.colisDansFenetre <= Math.max(1, n * 0.1)) externe += 0.5;   // B absent de sa zone pendant la fenêtre
                if (cand.colisRouteA > 0) externe += 0.5;                             // B a livré des colis de la route de A
            }
            let brut = 40 * double + 30 * attribution + 15 * masse + 15 * externe;
            if (!cand || cand.niveau === 3) brut = Math.min(brut, 55);           // auteur inconnu : jamais au-delà de « probable »
            let mult = 1;
            if (qualite.partAberrants > 0.2) mult -= 0.15;
            if (qualite.partSansGps > 0.2) mult -= 0.15;
            if (qualite.uploadsTardifs > n * 0.3) mult -= 0.1;
            mult = Math.max(0.6, mult);
            const score = Math.round(Math.max(0, Math.min(100, brut * mult)));
            return { score, categorie: _categorie(score, cand ? cand.niveau : null), familles: { double: Math.round(40 * double), attribution: Math.round(30 * attribution), masse: Math.round(15 * masse), externe: Math.round(15 * externe) }, multiplicateur: mult };
        }

        function expliquerRenfort(a) {
            const c = a.candidats[0];
            const L = [];
            L.push(`${a.nbColis} colis livrés sous le compte de ${a.compte} entre ${a.debut} et ${a.fin} (${a.dureeMinutes} min), regroupés autour de ${a.zone}.`);
            if (a.type === 'double_sequence') {
                L.push(`Fait observé : pendant cette fenêtre, le compte alterne ${a.sauts} fois entre deux zones distantes de ${a.separationKm} km (${a.alternances} changements de zone). Une personne seule ne peut pas produire cette séquence.`);
                if (a.monotonie && a.monotonie.every(m => m !== null))
                    L.push(a.monoOk ? `Les deux sous-séquences suivent chacune l'ordre planifié de la tournée (${Math.round(a.monotonie[0] * 100)} % et ${Math.round(a.monotonie[1] * 100)} % de cohérence) : deux personnes livrent en parallèle.`
                                    : `L'ordre planifié des deux sous-séquences est peu cohérent (${Math.round(a.monotonie[0] * 100)} % / ${Math.round(a.monotonie[1] * 100)} %) : la partition est incertaine.`);
                if (a.ambiguTitulaire) L.push(`Inférence : les deux groupes sont aussi continus l'un que l'autre avec le reste de la journée ; le groupe retenu comme transféré est le plus petit. Le nombre de colis peut être à ajuster.`);
            } else if (a.type === 'hors_zone') {
                L.push(`Fait observé : ces colis sont dans une zone où ${a.candidats[0] ? a.candidats[0].nom : 'un autre livreur'} a livré ${a.colisSource || '≥ 5'} colis le même jour, alors que ${a.compte} n'y livre pratiquement jamais.`);
            } else if (a.type === 'dispatch') {
                L.push(`Fait observé : ces colis portent la route ${a.routeId}, tenue ce jour-là par ${a.sourceRoute || '?'}, mais ont été livrés par ${a.compte}. Réaffectation enregistrée dans l'outil de dispatch.`);
            }
            if (c) {
                if (c.niveau === 1) L.push(`Preuve directe : ${c.nom} a livré ${c.colisRouteA} colis de la route de ${a.compte} sous son propre compte ce jour-là.`);
                if (c.niveau <= 2) L.push(`${c.nom} est absent de sa propre tournée de ${c.absentDe} à ${c.absentA}${c.trouMinutes ? ` (${c.trouMinutes} min)` : ''}, soit ${c.recouvrementPct} % de la fenêtre. Détour ${c.detourKm} km, temps disponible ${c.tempsDispoMin} min, vitesse nécessaire ${c.vitesseNecessaire === null ? '—' : c.vitesseNecessaire + ' km/h'} pour une vitesse habituelle de ${c.vRef} km/h : ${c.faisable ? 'faisable' : 'difficilement faisable'}.`);
                else L.push(`Inférence seulement : aucun livreur n'est clairement absent pendant la fenêtre. ${c.nom} est le candidat le moins improbable (disponible ${c.recouvrementPct} %, connaît la zone à ${c.cpPct} %).`);
                if (a.candidats[1] && a.candidats[0].score - a.candidats[1].score < RENFORT_PARAMS.ecartCandidatsMin)
                    L.push(`Plusieurs candidats possibles : ${a.candidats.slice(0, 3).map(x => `${x.nom} (${x.score})`).join(', ')}. Vérification manuelle recommandée.`);
            } else {
                L.push(`Aucun autre livreur actif ce jour-là dans ce dépôt : la source ne peut pas être identifiée.`);
            }
            if (a.qualite.partAberrants > 0.2 || a.qualite.partSansGps > 0.2) L.push(`Qualité des données dégradée sur ce groupe (${Math.round(a.qualite.partAberrants * 100)} % de positions aberrantes, ${Math.round(a.qualite.partSansGps * 100)} % sans GPS) : confiance réduite.`);
            if (a.sousSeuil) L.push(`Ce cas est inférieur au seuil de ${RENFORT_PARAMS.seuilColis} colis et n'est pas inclus dans les calculs de renfort.`);
            L.push(`Conclusion : ${a.categorie.toLowerCase()} — ${a.score}/100${c ? (a.directionInverse ? ` — colis de ${c.nom} livrés par ${a.compte} (déjà comptés pour ${a.compte})` : ` — ${a.compte} → ${c.nom} (${c.nom} a livré ces colis, comptés à tort pour ${a.compte})`) : ''}.`);
            return L.join('\n');
        }

        /**
         * Point d'entrée. `recs` : enregistrements normalisés d'un ou plusieurs
         * mois [{date, courier, tsLivraison, lat, lon, latTheo, lonTheo, cp,
         * waybill, routeId, ordre, depot, echec, upload}].
         * @returns {{anomalies:Array, sousSeuil:Array, qualite:Object, parDepot:Object}}
         */
        function detecterRenforts(recs, options) {
            const P = RENFORT_PARAMS;
            const estTechnique = (options && options.estCompteTechnique) || (() => false);
            const t0 = Date.now();

            // ── Qualité globale ──
            const livres = recs.filter(r => !r.echec);
            const q = {
                lignes: recs.length, livres: livres.length,
                gps: livres.filter(r => _fin(r.lat) && _fin(r.lon)).length,
                heure: livres.filter(r => r.tsLivraison).length,
                waybill: livres.filter(r => r.waybill).length,
                livreur: livres.filter(r => r.courier).length,
                depot: livres.filter(r => r.depot).length,
                ordre: livres.filter(r => _fin(r.ordre)).length,
                aberrants: 0, arrets: 0, dtNegatifs: 0, depots: {}
            };

            // ── Partition par dépôt ──
            const parDepot = {};
            livres.forEach(r => { const d = r.depot || '(dépôt inconnu)'; (parDepot[d] = parDepot[d] || []).push(r); });

            const anomalies = [], sousSeuil = [];
            Object.entries(parDepot).forEach(([depot, recsDepot]) => {
                q.depots[depot] = recsDepot.length;
                const profils = construireProfils(recsDepot);

                // Index jour → compte
                const parCompteJour = {}, activite = {}, positions = {}, barycentres = {}, routesJour = {}, routePrincipale = {};
                recsDepot.forEach(r => {
                    if (!r.tsLivraison) return;
                    const k = r.courier + '|' + r.date;
                    (parCompteJour[k] = parCompteJour[k] || []).push(r);
                    if (r.routeId) { const rj = (routesJour[r.date + '|' + r.courier] = routesJour[r.date + '|' + r.courier] || {}); rj[r.routeId] = (rj[r.routeId] || 0) + 1; }
                });
                Object.entries(parCompteJour).forEach(([k, list]) => {
                    const [compte, date] = k.split('|');
                    const withGeo = list.filter(r => _fin(r.lat) && _fin(r.lon));
                    (activite[date] = activite[date] || {})[compte] = list.map(r => r.tsLivraison).sort((a, b) => a - b);
                    (positions[date] = positions[date] || {})[compte] = withGeo.map(r => ({ ts: r.tsLivraison, lat: r.lat, lon: r.lon })).sort((a, b) => a.ts - b.ts);
                    if (withGeo.length) (barycentres[date] = barycentres[date] || {})[compte] = { lat: withGeo.reduce((s, r) => s + r.lat, 0) / withGeo.length, lon: withGeo.reduce((s, r) => s + r.lon, 0) / withGeo.length };
                    const rj = routesJour[date + '|' + compte] || {};
                    const best = Object.entries(rj).sort((a, b) => b[1] - a[1])[0];
                    if (best) routePrincipale[date + '|' + compte] = best[0];
                });
                // Titulaire d'une route par jour
                const titulaireRoute = {};
                Object.entries(routePrincipale).forEach(([k, route]) => { const [date, compte] = k.split('|'); titulaireRoute[date + '|' + route] = compte; });
                const ctx = { activite, positions, barycentres, profils, routesJour, routePrincipale, titulaireRoute, estTechnique, historique: options && options.historique };

                const pousser = (det, compte, date, cand, qual, extra) => {
                    const colisTries = [...det.colis].sort((a, b) => a.tsLivraison - b.tsLivraison);
                    const cps = {};
                    colisTries.forEach(c => { if (c.cp) cps[String(c.cp)] = (cps[String(c.cp)] || 0) + 1; });
                    const villes = {};
                    colisTries.forEach(c => { if (c.ville) villes[c.ville] = (villes[c.ville] || 0) + 1; });
                    const zone = Object.entries(villes).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]).join(' / ')
                              || Object.entries(cps).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]).join(' / ') || '—';
                    const sc = scorerRenfort(det, cand[0], qual);
                    const debut = colisTries[0].tsLivraison, fin = colisTries[colisTries.length - 1].tsLivraison;
                    const c0 = cand[0];
                    const a = {
                        id: 'an_' + date + '_' + compte.replace(/\W+/g, '') + '_' + debut,
                        type: det.type, depot, date, compte,
                        nbColis: colisTries.length,
                        debut: _hhmm(debut), fin: _hhmm(fin),
                        dureeMinutes: Math.round((fin - debut) / 60000),
                        codesPostaux: Object.entries(cps).sort((a, b) => b[1] - a[1]).slice(0, 4),
                        zone,
                        centre: det.centre ? { lat: Math.round(det.centre.lat * 1e5) / 1e5, lon: Math.round(det.centre.lon * 1e5) / 1e5 } : null,
                        separationKm: det.separationKm ? Math.round(det.separationKm * 10) / 10 : null,
                        sauts: det.sauts || 0, alternances: det.alternances || 0,
                        monotonie: det.monotonie || null, monoOk: det.monoOk !== false, ambiguTitulaire: !!det.ambiguTitulaire,
                        candidats: cand.slice(0, 3),
                        niveau: c0 ? c0.niveau : null,
                        source: c0 ? c0.nom : null,
                        distanceKm: c0 ? c0.detourKm : null,
                        tempsDispoMin: c0 ? c0.tempsDispoMin : null,
                        vitesseNecessaire: c0 ? c0.vitesseNecessaire : null,
                        score: sc.score, categorie: sc.categorie, familles: sc.familles,
                        confiance: _CONFIANCE_LEGACY[sc.categorie],
                        qualite: qual,
                        sousSeuil: colisTries.length < P.seuilColis,
                        colis: colisTries.map(c => ({ w: c.waybill || '', t: _hhmm(c.tsLivraison), ts: c.tsLivraison, lat: c.lat, lon: c.lon, cp: c.cp || '', v: c.ville || '', o: _fin(c.ordre) ? c.ordre : null, ab: !!c.aberrant })),
                        sequence: (det.colisTitulaire || []).map(c => ({ t: _hhmm(c.tsLivraison), lat: c.lat, lon: c.lon, o: _fin(c.ordre) ? c.ordre : null })),
                        statut: (extra && extra.directionInverse) ? 'info' : 'a_traiter',
                        ...(extra || {})
                    };
                    a.explication = expliquerRenfort(a);
                    a.explicationCourte = (a.type === 'double_sequence' ? `${a.sauts} alternances entre deux zones à ${a.separationKm} km` : a.type === 'hors_zone' ? `colis dans la zone du jour de ${a.source || '?'}` : `route ${a.routeId} livrée par un autre compte`)
                                        + (c0 ? ` · ${c0.nom} ${c0.niveau === 1 ? 'a livré des colis de cette route' : c0.niveau === 2 ? `absent ${c0.absentDe}–${c0.absentA}` : 'candidat par inférence'}` : ' · aucun candidat');
                    (a.sousSeuil ? sousSeuil : anomalies).push(a);
                };

                // ── Signal 1 : double séquence sous un compte ──
                Object.entries(parCompteJour).forEach(([k, list]) => {
                    const [compte, date] = k.split('|');
                    if (estTechnique(compte)) return;
                    const { pts, aberrants, arrets } = nettoyerSequence(list);
                    q.aberrants += aberrants; q.arrets += arrets;
                    for (let i = 1; i < pts.length; i++) if (pts[i].tsLivraison < pts[i - 1].tsLivraison) q.dtNegatifs++;
                    const dets = detecterDoubleSequence(pts, ctx);
                    dets.forEach(det => {
                        const cand = attribuerSource(det, compte, date, ctx);
                        const qual = {
                            partAberrants: det.colis.filter(c => c.aberrant).length / det.colis.length,
                            partSansGps: list.filter(r => !_fin(r.lat)).length / list.length,
                            uploadsTardifs: det.colis.filter(c => c.upload > 0).length
                        };
                        pousser(det, compte, date, cand, qual);
                    });
                });

                // ── Signal 3 : colis de B dans une zone tenue par A le même jour ──
                const cellJour = {};
                recsDepot.forEach(r => {
                    if (!r.tsLivraison || !_fin(r.lat) || !_fin(r.lon)) return;
                    const k = r.date + '|' + _cellule(r.lat, r.lon);
                    const c = (cellJour[k] = cellJour[k] || {}); c[r.courier] = (c[r.courier] || 0) + 1;
                });
                Object.entries(parCompteJour).forEach(([k, list]) => {
                    const [compte, date] = k.split('|');
                    if (estTechnique(compte)) return;
                    const pts = list.filter(r => _fin(r.lat) && _fin(r.lon)).sort((a, b) => a.tsLivraison - b.tsLivraison);
                    const proprietaire = c => {
                        const cell = cellJour[date + '|' + _cellule(c.lat, c.lon)] || {};
                        const top = Object.entries(cell).sort((a, b) => b[1] - a[1])[0];
                        if (!top || top[0] === compte || estTechnique(top[0])) return null;
                        if (top[1] < P.zoneMinSource || (cell[compte] || 0) > top[1] * 0.4) return null;
                        return top[0];
                    };
                    let cur = [];
                    const flush = () => {
                        if (cur.length >= 3) {
                            const owners = {}; cur.forEach(c => owners[c._own] = (owners[c._own] || 0) + 1);
                            const src = Object.entries(owners).sort((a, b) => b[1] - a[1])[0][0];
                            const lat = cur.reduce((s, c) => s + c.lat, 0) / cur.length, lon = cur.reduce((s, c) => s + c.lon, 0) / cur.length;
                            const det = { type: 'hors_zone', colis: cur, centre: { lat, lon }, debut: cur[0].tsLivraison, fin: cur[cur.length - 1].tsLivraison, signalDouble: 0, separationKm: 0 };
                            // Le « candidat » d'une vue zone est le propriétaire de la zone (source A) ;
                            // la direction est A → compte. On réutilise l'attribution pour la disponibilité.
                            const cand = attribuerSource(det, compte, date, ctx).filter(c => c.nom === src);
                            if (cand[0]) { cand[0].niveau = 3; cand[0].attribution = Math.min(0.4, cand[0].attribution + 0.2); cand[0].score = Math.round(cand[0].attribution * 100); }
                            const qual = { partAberrants: 0, partSansGps: 0, uploadsTardifs: 0 };
                            pousser(det, compte, date, cand, qual, { colisSource: (cellJour[date + '|' + _cellule(lat, lon)] || {})[src] || 0, directionInverse: true });
                        }
                        cur = [];
                    };
                    pts.forEach(r => {
                        const o = proprietaire(r);
                        if (o) {
                            if (cur.length && (r.tsLivraison - cur[cur.length - 1].tsLivraison) > P.zoneClusterGapMin * 60000) flush();
                            cur.push({ ...r, _own: o });
                        } else if (cur.length && (r.tsLivraison - cur[cur.length - 1].tsLivraison) > 15 * 60000) flush();
                    });
                    flush();
                });

                // ── Signal 4 : réaffectation explicite du dispatch ──
                const disp = {};
                recsDepot.forEach(r => {
                    if (!r.routeId || !r.tsLivraison || estTechnique(r.courier)) return;
                    const main = routePrincipale[r.date + '|' + r.courier];
                    if (!main || main === r.routeId) return;
                    const k = r.date + '|' + r.courier + '|' + r.routeId;
                    (disp[k] = disp[k] || []).push(r);
                });
                Object.entries(disp).forEach(([k, list]) => {
                    const [date, compte, routeId] = k.split('|');
                    const src = titulaireRoute[date + '|' + routeId] || null;
                    const geo = list.filter(r => _fin(r.lat) && _fin(r.lon));
                    const centre = geo.length ? { lat: geo.reduce((s, r) => s + r.lat, 0) / geo.length, lon: geo.reduce((s, r) => s + r.lon, 0) / geo.length } : { lat: 0, lon: 0 };
                    const det = { type: 'dispatch', colis: list, centre, debut: Math.min(...list.map(r => r.tsLivraison)), fin: Math.max(...list.map(r => r.tsLivraison)), signalDouble: 1, separationKm: P.separationKm };
                    const cand = src ? [{ nom: src, niveau: 1, attribution: 1, score: 100, colisRouteA: list.length, recouvrementPct: 0, absentDe: '—', absentA: '—', trouMinutes: null, colisDansFenetre: 0, detourKm: null, faisable: null, vraiDetour: null, vitesseNecessaire: null, tempsDispoMin: null, vRef: 0, cpPctMois: 0, cpPct: 0, cpsCommuns: [], distanceKm: 0, detourScore: 0 }] : [];
                    pousser(det, compte, date, cand, { partAberrants: 0, partSansGps: 0, uploadsTardifs: 0 }, { routeId, sourceRoute: src, directionInverse: true });
                });
            });

            // ── Récurrence : même paire compte → source plusieurs fois dans le mois ──
            const occ = {};
            anomalies.forEach(a => { if (a.source && !a.directionInverse) { const k = a.compte + '|' + a.source; occ[k] = (occ[k] || 0) + 1; } });
            anomalies.forEach(a => {
                if (!a.source || a.directionInverse) return;
                a.recurrence = occ[a.compte + '|' + a.source] || 1;
                if (a.recurrence >= 3) a.explication += `\nOrganisation récurrente : ${a.recurrence} renforts ${a.compte} → ${a.source} détectés ce mois-ci. Il s'agit probablement d'une aide régulière non enregistrée dans le dispatch, pas d'un cas isolé.`;
                const c0 = a.candidats[0];
                if (c0 && c0.histValide >= 2) a.explication += `\nHistorique : vous avez déjà validé ${c0.histValide} renfort(s) ${a.compte} → ${c0.nom}${c0.histEcarte ? ` (et écarté ${c0.histEcarte})` : ''}.`;
            });
            const tri = (a, b) => a.date.localeCompare(b.date) || b.score - a.score || b.nbColis - a.nbColis;
            anomalies.sort(tri); sousSeuil.sort(tri);
            q.dureeMs = Date.now() - t0;
            return { anomalies, sousSeuil, qualite: q };
        }

        /**
         * Compatibilité : l'ancien point d'entrée renvoie la liste principale.
         * Les cas < 5 colis sont rangés dans `anomalies._sousSeuil`.
         */
        function detecterTourneesSimultanees(recs) {
            let historique = null;
            try { if (typeof historiqueDecisionsRenforts === 'function' && typeof data !== 'undefined') historique = historiqueDecisionsRenforts(); } catch (e) {}
            const r = detecterRenforts(recs, { estCompteTechnique: (typeof estCompteTechnique === 'function') ? estCompteTechnique : () => false, historique });
            const out = r.anomalies;
            out._sousSeuil = r.sousSeuil;
            out._qualite = r.qualite;
            return out;
        }

        // ── Tests unitaires (console : testsRenforts()) ──────────────────
        function testsRenforts() {
            const mk = (courier, date, hhmm, lat, lon, extra) => {
                const [h, m] = hhmm.split(':').map(Number);
                return { date, courier, tsLivraison: new Date(2026, 0, 1, h, m, (extra && extra.s) || 0).getTime(), lat, lon, cp: (extra && extra.cp) || '68000', waybill: (extra && extra.w) || ('W' + Math.random().toString(36).slice(2, 8)), routeId: (extra && extra.route) || '', ordre: extra && extra.o, depot: (extra && extra.depot) || 'D1', echec: false, latTheo: lat, lonTheo: lon };
            };
            const ligne = (courier, date, t0, n, lat, lon, stepMin, dlat, route, o0, oStep, depot) => {
                const out = [];
                for (let i = 0; i < n; i++) {
                    const mins = t0 + i * stepMin;
                    out.push(mk(courier, date, `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`, lat + i * dlat, lon, { route, o: o0 + i * oStep, depot }));
                }
                return out;
            };
            const entrelacer = (a) => [...a].sort((x, y) => x.tsLivraison - y.tsLivraison);
            const run = recs => detecterRenforts(recs, { estCompteTechnique: () => false });
            const res = [];
            const check = (nom, ok, detail) => res.push({ test: nom, ok: !!ok, detail });

            // T1 impossible / T3 2 km en quelques secondes / T2 rapide mais possible
            const s1 = nettoyerSequence([mk('A', '2026-01-05', '10:00', 48.0, 7.3), mk('A', '2026-01-05', '10:00', 48.0, 7.33, { s: 40 }), mk('A', '2026-01-05', '10:05', 48.0, 7.34)]).pts;
            const seg = analyserDeplacements(s1, 35);
            check('T1/T3 déplacement impossible (2,2 km en 40 s)', seg[0] && seg[0].niveau === 'impossible', seg[0] && seg[0].niveau);
            const s2 = nettoyerSequence([mk('A', '2026-01-05', '10:00', 48.0, 7.3), mk('A', '2026-01-05', '10:04', 48.0, 7.33)]).pts;
            const seg2 = analyserDeplacements(s2, 35);
            check('T2 rapide mais possible (2,2 km en 4 min ≈ 33 km/h)', seg2[0] && ['plausible', 'difficile', 'coherent'].includes(seg2[0].niveau), seg2[0] && seg2[0].niveau);

            // T7 transfert évident A → B (deux séquences entrelacées sous A, B absent) — T4 8 colis
            const jour = '2026-01-06';
            const A_prop = ligne('A', jour, 9 * 60, 40, 48.00, 7.30, 3, 0.0008, 'R1', 1, 1);
            const A_orph = ligne('A', jour, 10 * 60 + 1, 12, 48.15, 7.30, 5, 0.0008, 'R1', 120, 1);   // 16 km plus au nord
            const B = [...ligne('B', jour, 9 * 60, 15, 48.30, 7.40, 3, 0.0008, 'R2', 1, 1), ...ligne('B', jour, 12 * 60, 15, 48.31, 7.40, 3, 0.0008, 'R2', 30, 1)];
            const C = ligne('C', jour, 9 * 60, 60, 47.90, 7.20, 3, 0.0005, 'R3', 1, 1);
            const r7 = run(entrelacer([...A_prop, ...A_orph, ...B, ...C]));
            const a7 = r7.anomalies[0];
            check('T7 transfert évident détecté sous A', a7 && a7.compte === 'A' && a7.nbColis >= 10, a7 && `${a7.compte} ${a7.nbColis} colis ${a7.score} ${a7.categorie}`);
            check('T7 candidat B (absent 09:42–12:00)', a7 && a7.source === 'B' && a7.niveau <= 2, a7 && `${a7.source} N${a7.niveau}`);
            check('T4 groupe ≥ 8 colis compté comme un seul groupe', a7 && a7.nbColis >= 8 && r7.anomalies.filter(x => x.compte === 'A').length === 1, r7.anomalies.length);

            // T5 4 colis → sous seuil ; T6 5 colis → principal (vue zone : B livre dans la cellule de A)
            const jz = '2026-01-07';
            const Az = ligne('A', jz, 9 * 60, 40, 48.00, 7.30, 3, 0.0002, 'R1', 1, 1);
            const Bz = ligne('B', jz, 9 * 60, 40, 48.20, 7.30, 3, 0.0002, 'R2', 1, 1);
            const Bz4 = ligne('B', jz, 11 * 60 + 1, 4, 48.001, 7.301, 2, 0.0001, 'R2', 200, 1);
            const r5 = run(entrelacer([...Az, ...Bz, ...Bz4]));
            check('T5 4 colis → hors calcul principal, signalés à part', r5.anomalies.filter(x => x.compte === 'B').length === 0 && r5.sousSeuil.some(x => x.compte === 'B' && x.nbColis === 4), `${r5.anomalies.length}/${r5.sousSeuil.length}`);
            const Bz5 = ligne('B', jz, 11 * 60 + 1, 5, 48.001, 7.301, 2, 0.0001, 'R2', 200, 1);
            const r6 = run(entrelacer([...Az, ...Bz, ...Bz5]));
            check('T6 5 colis → analysés (vue zone, A → B)', r6.anomalies.some(x => x.compte === 'B' && x.nbColis === 5 && x.type === 'hors_zone'), r6.anomalies.map(x => x.type + x.nbColis).join(','));

            // T8 plusieurs candidats : B et D tous deux absents
            const D = [...ligne('D', jour, 9 * 60, 15, 48.32, 7.45, 3, 0.0008, 'R4', 1, 1), ...ligne('D', jour, 12 * 60, 15, 48.33, 7.45, 3, 0.0008, 'R4', 30, 1)];
            const r8 = run(entrelacer([...A_prop, ...A_orph, ...B, ...C, ...D]));
            const a8 = r8.anomalies[0];
            check('T8 plusieurs candidats signalés dans l\'explication', a8 && /Plusieurs candidats/.test(a8.explication), a8 && a8.candidats.map(c => c.nom + c.score).join(' '));

            // T9 deux dépôts : B (dépôt D2) absent mais jamais candidat
            const B2 = B.map(r => ({ ...r, depot: 'D2' }));
            const r9 = run(entrelacer([...A_prop, ...A_orph, ...B2, ...C]));
            const a9 = r9.anomalies[0];
            check('T9 dépôts différents → B jamais candidat', a9 && !a9.candidats.some(c => c.nom === 'B'), a9 && a9.candidats.map(c => c.nom).join(','));

            // T10 GPS manquant : aucune détection, aucun plantage
            const r10 = run(entrelacer([...A_prop, ...A_orph].map(r => ({ ...r, lat: NaN, lon: NaN }))));
            check('T10 GPS manquant → 0 détection, qualité renseignée', r10.anomalies.length === 0 && r10.qualite.gps === 0, r10.qualite.gps);

            // T11 timestamp incohérent (un colis daté 3 h plus tôt au milieu) : pas de détection
            const A11 = ligne('A', '2026-01-08', 9 * 60, 30, 48.00, 7.30, 3, 0.0008, 'R1', 1, 1);
            A11[15].tsLivraison -= 3 * 3600000;
            const r11 = run(A11);
            check('T11 horodatage incohérent isolé → pas de faux positif', r11.anomalies.length === 0 && r11.qualite.dtNegatifs === 0, r11.anomalies.length);

            // T12 doublon de waybill dans la même journée : le moteur ne doit pas doubler les colis
            const A12 = ligne('A', '2026-01-09', 9 * 60, 30, 48.00, 7.30, 3, 0.0008, 'R1', 1, 1);
            const r12 = run([...A12, { ...A12[3] }]);
            check('T12 doublon de waybill → aucune anomalie créée', r12.anomalies.length === 0, r12.anomalies.length);

            // T13 livreur polyvalent : journée entière dans un autre secteur, sans A dans la zone → rien
            const E = ligne('E', '2026-01-10', 9 * 60, 80, 48.40, 7.60, 3, 0.0005, 'R5', 1, 1);
            const r13 = run(E);
            check('T13 livreur légitimement sur un autre secteur → rien', r13.anomalies.length === 0 && r13.sousSeuil.length === 0, r13.anomalies.length);

            // T15 journée avec deux groupes de renfort (deux fenêtres) sous A
            const A_orph2 = ligne('A', jour, 13 * 60 + 1, 12, 47.85, 7.30, 5, 0.0008, 'R1', 200, 1);
            const A_prop2 = ligne('A', jour, 13 * 60, 30, 48.03, 7.30, 3, 0.0008, 'R1', 41, 1);
            const r15 = run(entrelacer([...A_prop, ...A_orph, ...A_prop2, ...A_orph2, ...B, ...C]));
            check('T15 deux groupes distincts le même jour', r15.anomalies.filter(x => x.compte === 'A').length === 2, r15.anomalies.filter(x => x.compte === 'A').map(x => x.debut + '-' + x.fin).join(' ; '));

            // Pic GPS isolé : ne crée rien
            const A16 = ligne('A', '2026-01-11', 9 * 60, 30, 48.00, 7.30, 3, 0.0008, 'R1', 1, 1);
            A16[10].lat += 0.2; A16[10].latTheo = A16[10].lat;
            const r16 = run(A16);
            check('Pic GPS isolé → aucune anomalie, compté en aberrant', r16.anomalies.length === 0 && r16.qualite.aberrants === 1, r16.qualite.aberrants);

            // T14 — noms de colonnes différents (anglais, GPS non nommé) : voir testsSchemaEPOD()
            try { testsSchemaEPOD().forEach(t => res.push(t)); } catch (e) { res.push({ test: 'T14 schéma', ok: false, detail: String(e) }); }
            return res;
        }

        /** T14 — le parseur doit lire un export dont les colonnes changent de nom/langue. */
        function testsSchemaEPOD() {
            const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
            const getField = (row, keys, rowKeysNorm) => { for (const k of keys) { const n = norm(k); if (rowKeysNorm[n] !== undefined && rowKeysNorm[n] !== null && rowKeysNorm[n] !== '') return rowKeysNorm[n]; } return undefined; };
            const res = [];
            const mkRows = (noms, n) => Array.from({ length: n }, (_, i) => ({
                [noms.date]: '2026-03-05', [noms.courier]: 'Test-A', [noms.status]: noms.statusVal,
                [noms.waybill]: 'DOFR' + String(1e12 + i), [noms.time]: `05/03/2026 ${String(9 + Math.floor(i / 20)).padStart(2, '0')}:${String((i * 3) % 60).padStart(2, '0')}`,
                [noms.lat]: 48.1 + i * 0.001, [noms.lon]: 7.3 + i * 0.001, [noms.depot]: 'XPT_TEST', [noms.route]: 'R1', [noms.order]: i
            }));
            // Anglais, colonnes reconnues par leur nom
            const en = mkRows({ date: 'Task Date', courier: 'Courier Name', status: 'Task Status', statusVal: 'Sign Success', waybill: 'Waybill Number', time: 'Sign Time', lat: 'Latitude', lon: 'Longitude', depot: 'Actual Site', route: 'Dispatching Plancode', order: 'Work Group Order' }, 40);
            const r1 = parseEPODLineByLine(en, getField, norm);
            const q1 = r1._qualite.detection || {};
            res.push({ test: 'T14a colonnes anglaises (Sign Time dd/mm/yyyy, Latitude/Longitude, Actual Site)', ok: r1.totalLivres === 40 && q1.gps === 40 && q1.heure === 40 && q1.depot === 40 && q1.ordre === 40, detail: JSON.stringify({ livres: r1.totalLivres, gps: q1.gps, heure: q1.heure, depot: q1.depot, ordre: q1.ordre }) });
            // GPS sous des noms inconnus → repli par contenu + avertissement
            const inc = mkRows({ date: 'Date de la tâche', courier: 'Petit nom de membre', status: 'Statut', statusVal: 'Livraison client réussie', waybill: 'Numéro de la lettre', time: 'Délai de livraison', lat: 'Coord Y', lon: 'Coord X', depot: 'Depot', route: 'Route', order: 'Ordre' }, 40);
            const r2 = parseEPODLineByLine(inc, getField, norm);
            const q2 = r2._qualite.detection || {};
            res.push({ test: 'T14b GPS sous noms inconnus → repli par contenu, signalé', ok: q2.gps === 40 && r2._qualite.avertissements.some(w => /contenu/.test(w)), detail: JSON.stringify({ gps: q2.gps, avert: r2._qualite.avertissements }) });
            // Aucun GPS → avertissement explicite, aucune détection, pas de plantage
            const sans = inc.map(r => { const c = { ...r }; delete c['Coord Y']; delete c['Coord X']; return c; });
            const r3 = parseEPODLineByLine(sans, getField, norm);
            res.push({ test: 'T14c aucune colonne GPS → avertissement, 0 détection', ok: r3.totalLivres === 40 && r3.anomaliesTournees.length === 0 && r3._qualite.avertissements.some(w => /GPS/.test(w)), detail: r3._qualite.avertissements.join(' | ') });
            return res;
        }

