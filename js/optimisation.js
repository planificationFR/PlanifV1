        // =====================================================================
        // ============== OPTIMISATION AUTOMATIQUE DES TOURNÉES ================
        // =====================================================================
        //
        // Algorithme greedy intelligent :
        // 1. Tri des CP par nombre de colis décroissant
        // 2. Pour chaque CP : calcul d'un score pour chaque livreur
        // 3. Score = total_actuel + (distance_centroide * poidsDistance) + pénalités
        // 4. CP attribué au livreur avec le score le plus faible
        //
        // Distances : equirectangular (corrigée cos lat) pour précision sur la France
        // Performance : O(n*m) où n = nb CP, m = nb livreurs. Optimisé via Map.
        // =====================================================================

        // Variable globale qui stocke la répartition proposée (pour validation post-aperçu)
        window._optimisationApercu = null;

        // ============== DISTANCE GÉOGRAPHIQUE ==============
        // Equirectangular approximation : pour la France, ~99% précis vs Haversine
        // mais beaucoup plus rapide
        function distanceCP(cp1, cp2) {
            const a = CP_FR_DATABASE[cp1];
            const b = CP_FR_DATABASE[cp2];
            if (!a || !b) return 999;  // CP inconnu = distance énorme (pénalisé)
            const R = 6371;  // rayon Terre en km
            const lat1 = a.lat * Math.PI / 180;
            const lat2 = b.lat * Math.PI / 180;
            const dLat = (b.lat - a.lat) * Math.PI / 180;
            const dLng = (b.lng - a.lng) * Math.PI / 180;
            // Formule equirectangular
            const x = dLng * Math.cos((lat1 + lat2) / 2);
            const y = dLat;
            return R * Math.sqrt(x * x + y * y);
        }

        // Centroïde d'un ensemble de CP : moyenne pondérée par les colis
        function centroideCPs(cps, prevsMap) {
            let totalLat = 0, totalLng = 0, totalPoids = 0;
            for (const cp of cps) {
                const data = CP_FR_DATABASE[cp];
                if (!data) continue;
                const poids = (prevsMap.get ? prevsMap.get(cp) : prevsMap[cp]) || 1;
                totalLat += data.lat * poids;
                totalLng += data.lng * poids;
                totalPoids += poids;
            }
            if (totalPoids === 0) return null;
            return { lat: totalLat / totalPoids, lng: totalLng / totalPoids };
        }

        // Distance d'un CP à un point (lat, lng)
        function distanceCPToPoint(cp, point) {
            const a = CP_FR_DATABASE[cp];
            if (!a || !point) return 999;
            const R = 6371;
            const lat1 = a.lat * Math.PI / 180;
            const lat2 = point.lat * Math.PI / 180;
            const dLat = (point.lat - a.lat) * Math.PI / 180;
            const dLng = (point.lng - a.lng) * Math.PI / 180;
            const x = dLng * Math.cos((lat1 + lat2) / 2);
            const y = dLat;
            return R * Math.sqrt(x * x + y * y);
        }

        // ============== ALGO PRINCIPAL ==============
        /**
         * Optimise la répartition des CP entre livreurs.
         * @param {Array<{cp, colis}>} previsions - liste des CP+colis à répartir
         * @param {Array} livreurs - livreurs actifs
         * @param {Object} options - { poidsDistance, plafondColis, mode }
         * @returns {Object} { attributions: Map(livreurId -> [cps]), nonAttribues: [], stats: {...} }
         */
        function optimiserTournees(previsions, livreurs, options = {}) {
            const t0 = performance.now();
            const poidsDistance = options.poidsDistance ?? 50;
            const plafondColis = options.plafondColis ?? (data.paramètres?.max_colis || 160);
            const mode = options.mode ?? 'replace';
            const cpExceptions = data.cpExceptions || {};

            // Pré-attributions : si mode 'add', on garde les CP déjà attribués
            const dejaAttribues = new Map();
            if (mode === 'add') {
                livreurs.forEach(l => {
                    l.secteurs_prioritaires.forEach(cp => dejaAttribues.set(cp, l.id));
                });
            }

            // État du processus pour chaque livreur
            const etatLivreurs = new Map();
            livreurs.forEach(l => {
                const cpsInitiaux = (mode === 'add') ? l.secteurs_prioritaires.slice() : [];
                const prevsMap = new Map(previsions.map(p => [p.cp, p.colis]));
                const totalInitial = cpsInitiaux.reduce((s, cp) => s + (prevsMap.get(cp) || 0), 0);
                etatLivreurs.set(l.id, {
                    livreur: l,
                    cps: cpsInitiaux,
                    total: totalInitial,
                    centroide: cpsInitiaux.length > 0 ? centroideCPs(cpsInitiaux, prevsMap) : null
                });
            });

            // Détection des CP "volumineux" qui dépassent la capacité standard
            // Ils nécessitent une multi-affectation (split sur plusieurs livreurs)
            const aTraiterBrut = previsions
                .filter(p => !dejaAttribues.has(p.cp))
                .filter(p => CP_FR_DATABASE[p.cp]);

            const cpInconnus = previsions
                .filter(p => !dejaAttribues.has(p.cp))
                .filter(p => !CP_FR_DATABASE[p.cp]);

            // === SPLIT des CP très volumineux ===
            // Si un CP a plus de colis que sa capacité (cpException ou plafond standard),
            // ET que le nombre de livreurs disponibles le permet,
            // on le découpe en plusieurs "shards" qui seront attribués à différents livreurs.
            // Cela permet la multi-affectation pour les CP urbains comme 68000 (Colmar).
            const aTraiter = [];
            for (const p of aTraiterBrut) {
                const capCP = cpExceptions[p.cp] !== undefined ? cpExceptions[p.cp] : plafondColis;
                // Un livreur peut absorber jusqu'à capCP colis sur ce CP (ou plafondColis selon CP)
                // Si volume du CP > plafondColis, on le découpe pour faciliter la répartition
                if (p.colis > plafondColis && livreurs.length > 1) {
                    // Nombre de shards nécessaires pour que chaque shard tienne dans le plafond standard
                    const nbShards = Math.min(livreurs.length, Math.ceil(p.colis / plafondColis));
                    const colisParShard = Math.ceil(p.colis / nbShards);
                    for (let i = 0; i < nbShards; i++) {
                        const c = (i === nbShards - 1) ? (p.colis - colisParShard * (nbShards - 1)) : colisParShard;
                        aTraiter.push({ cp: p.cp, colis: c, isShard: true, shardIdx: i, shardTotal: nbShards });
                    }
                } else {
                    aTraiter.push({ cp: p.cp, colis: p.colis, isShard: false });
                }
            }
            // Trier par colis décroissant
            aTraiter.sort((a, b) => b.colis - a.colis);

            // Map<cp, colis> globale pour retrouver le poids des CP existants
            const prevsMapGlobal = new Map(previsions.map(p => [p.cp, p.colis]));

            // Boucle greedy : pour chaque CP/shard (du plus gros au plus petit), attribuer au meilleur livreur
            for (const prev of aTraiter) {
                let bestLivreur = null;
                let bestScore = Infinity;

                // Capacité spécifique pour ce CP (ex: 400 pour 68000)
                const capCP = cpExceptions[prev.cp] !== undefined ? cpExceptions[prev.cp] : plafondColis;

                for (const [, etat] of etatLivreurs) {
                    // Pour les shards : interdire d'attribuer le même CP au même livreur deux fois
                    if (prev.isShard && etat.cps.includes(prev.cp)) continue;

                    let score = etat.total;

                    if (etat.centroide) {
                        const dist = distanceCPToPoint(prev.cp, etat.centroide);
                        score += dist * poidsDistance;
                    }

                    if (etat.cps.length > 0) {
                        let minDist = Infinity;
                        for (const existingCp of etat.cps) {
                            if (existingCp === prev.cp) { minDist = 0; break; }
                            const d = distanceCP(prev.cp, existingCp);
                            if (d < minDist) minDist = d;
                            if (d < 5) break;
                        }
                        if (minDist < 15) {
                            score -= (15 - minDist) * 5;
                        }
                    }

                    // Pénalité dépassement plafond standard du livreur
                    const totalSiAjoute = etat.total + prev.colis;
                    if (totalSiAjoute > plafondColis) {
                        // Pour les CP avec exception (ex: 68000 → 400), un dépassement est tolérable
                        // mais on garde une pénalité plus douce
                        const tolerance = (capCP > plafondColis && etat.cps.length === 0) ? capCP : plafondColis;
                        if (totalSiAjoute > tolerance) {
                            score += (totalSiAjoute - tolerance) * 10;
                        } else {
                            score += (totalSiAjoute - plafondColis) * 3;
                        }
                    }

                    if (score < bestScore) {
                        bestScore = score;
                        bestLivreur = etat;
                    }
                }

                if (bestLivreur) {
                    // Pour les shards, on n'ajoute le CP qu'une seule fois dans secteurs_prioritaires
                    if (!bestLivreur.cps.includes(prev.cp)) {
                        bestLivreur.cps.push(prev.cp);
                    }
                    bestLivreur.total += prev.colis;
                    bestLivreur.centroide = centroideCPs(bestLivreur.cps, prevsMapGlobal);
                }
            }

            // Construire le résultat
            const attributions = new Map();
            etatLivreurs.forEach((etat, livreurId) => {
                attributions.set(livreurId, {
                    livreur: etat.livreur,
                    cps: etat.cps,
                    total: etat.total
                });
            });

            const dureeMs = Math.round(performance.now() - t0);
            return {
                attributions,
                cpInconnus,
                stats: {
                    totalCP: aTraiterBrut.length,
                    cpInconnusCount: cpInconnus.length,
                    livreursActifs: livreurs.length,
                    dureeMs,
                    poidsDistance,
                    plafondColis,
                    mode
                }
            };
        }


        // =====================================================================
        // ============== RECUIT SIMULÉ (amélioration de la solution greedy) ==
        // =====================================================================
        //
        // Principe : prend une solution greedy et tente des échanges aléatoires
        // entre livreurs pour l'améliorer. Accepte parfois des solutions moins bonnes
        // pour échapper aux optima locaux (température décroissante).
        //
        // Score d'une solution = somme(écart-type des charges) + somme(distances internes)
        // Plus le score est bas, meilleure est la solution.
        // =====================================================================

        /**
         * Calcule le score d'une solution (plus bas = meilleur)
         * Combine : équilibrage des charges + cohérence géographique
         */
        function scoreRepartition(attributions, prevsMap, poidsDistance) {
            let totalScore = 0;
            let charges = [];

            attributions.forEach((info) => {
                const total = info.cps.reduce((s, cp) => s + (prevsMap.get(cp) || 0), 0);
                charges.push(total);

                // Cohérence géographique : somme des distances entre CP et centroïde
                if (info.cps.length > 1) {
                    const centroide = centroideCPs(info.cps, prevsMap);
                    if (centroide) {
                        for (const cp of info.cps) {
                            totalScore += distanceCPToPoint(cp, centroide) * poidsDistance;
                        }
                    }
                }
            });

            // Pénalité d'équilibrage : écart-type des charges
            if (charges.length > 0) {
                const moyenne = charges.reduce((s, c) => s + c, 0) / charges.length;
                const variance = charges.reduce((s, c) => s + (c - moyenne) ** 2, 0) / charges.length;
                totalScore += Math.sqrt(variance) * 5;  // poids écart-type
            }

            return totalScore;
        }

        /**
         * Recuit simulé : améliore une solution greedy par échanges aléatoires
         * @param {Map} attributions - Solution greedy initiale
         * @param {Map} prevsMap - Map<cp, colis>
         * @param {Object} options - { iterations, poidsDistance, plafondColis }
         * @returns {Object} { attributions amélioré, scoreInitial, scoreFinal, ameliorations }
         */
        function recuitSimule(attributions, prevsMap, options = {}) {
            const t0 = performance.now();
            const iterations = options.iterations ?? 3000;
            const poidsDistance = options.poidsDistance ?? 50;
            const plafondColis = options.plafondColis ?? 160;

            // Cloner les attributions pour ne pas modifier l'original
            const cloner = (att) => {
                const c = new Map();
                att.forEach((info, id) => {
                    c.set(id, { livreur: info.livreur, cps: info.cps.slice(), total: info.total });
                });
                return c;
            };

            let current = cloner(attributions);
            let best = cloner(current);
            let scoreInitial = scoreRepartition(current, prevsMap, poidsDistance);
            let scoreCurrent = scoreInitial;
            let scoreBest = scoreInitial;
            let ameliorations = 0;

            // Paramètres du recuit
            let temperature = 100;
            const cooling = Math.pow(0.001, 1 / iterations);  // cool down to ~0 après iterations

            const livreurIds = Array.from(current.keys());
            if (livreurIds.length < 2) return { attributions: current, scoreInitial, scoreFinal: scoreInitial, ameliorations: 0, dureeMs: 0 };

            for (let i = 0; i < iterations; i++) {
                // Choisir 2 livreurs au hasard
                const idxA = Math.floor(Math.random() * livreurIds.length);
                let idxB = Math.floor(Math.random() * (livreurIds.length - 1));
                if (idxB >= idxA) idxB++;
                const idA = livreurIds[idxA];
                const idB = livreurIds[idxB];

                const livA = current.get(idA);
                const livB = current.get(idB);

                if (livA.cps.length === 0) continue;

                // Type d'opération : 50% transfert, 50% échange
                const opType = Math.random();
                let oldA, oldB, oldTotalA, oldTotalB;

                if (opType < 0.5 || livB.cps.length === 0) {
                    // TRANSFERT : déplacer un CP de A vers B
                    const cpIdx = Math.floor(Math.random() * livA.cps.length);
                    const cp = livA.cps[cpIdx];
                    const colis = prevsMap.get(cp) || 0;

                    // Vérifier que ça ne fait pas exploser le plafond
                    if (livB.total + colis > plafondColis * 1.5) continue;  // pénalité trop forte

                    oldA = livA.cps.slice();
                    oldB = livB.cps.slice();
                    oldTotalA = livA.total;
                    oldTotalB = livB.total;

                    livA.cps.splice(cpIdx, 1);
                    livA.total -= colis;
                    livB.cps.push(cp);
                    livB.total += colis;
                } else {
                    // ÉCHANGE : swap entre A et B
                    const cpIdxA = Math.floor(Math.random() * livA.cps.length);
                    const cpIdxB = Math.floor(Math.random() * livB.cps.length);
                    const cpA = livA.cps[cpIdxA];
                    const cpB = livB.cps[cpIdxB];
                    const colisA = prevsMap.get(cpA) || 0;
                    const colisB = prevsMap.get(cpB) || 0;

                    oldA = livA.cps.slice();
                    oldB = livB.cps.slice();
                    oldTotalA = livA.total;
                    oldTotalB = livB.total;

                    livA.cps[cpIdxA] = cpB;
                    livA.total = livA.total - colisA + colisB;
                    livB.cps[cpIdxB] = cpA;
                    livB.total = livB.total - colisB + colisA;
                }

                // Évaluer
                const scoreNew = scoreRepartition(current, prevsMap, poidsDistance);
                const delta = scoreNew - scoreCurrent;

                // Critère d'acceptation Metropolis
                if (delta < 0 || Math.random() < Math.exp(-delta / temperature)) {
                    scoreCurrent = scoreNew;
                    if (scoreNew < scoreBest) {
                        scoreBest = scoreNew;
                        best = cloner(current);
                        ameliorations++;
                    }
                } else {
                    // Rollback
                    livA.cps = oldA;
                    livA.total = oldTotalA;
                    livB.cps = oldB;
                    livB.total = oldTotalB;
                }

                temperature *= cooling;
            }

            const dureeMs = Math.round(performance.now() - t0);
            return {
                attributions: best,
                scoreInitial,
                scoreFinal: scoreBest,
                ameliorations,
                dureeMs,
                gainPourcent: scoreInitial > 0 ? Math.round((scoreInitial - scoreBest) / scoreInitial * 1000) / 10 : 0
            };
        }

        // =====================================================================
        // ============== UI : MODALE D'OPTIMISATION ===========================
        // =====================================================================

        function ouvrirModaleOptimisation() {
            // Sécurités
            const livreursActifs = data.livreurs.filter(l => l.actif);
            const previsions = data.previsions[selectedDate] || [];
            if (livreursActifs.length === 0) {
                showToast('Ajoutez d\'abord des livreurs actifs', 'warning');
                return;
            }
            if (previsions.length === 0) {
                showToast('Aucune prévision pour cette date. Importez des données d\'abord.', 'warning');
                return;
            }

            // Reset UI
            document.getElementById('optStep1').style.display = 'block';
            document.getElementById('optStep2').style.display = 'none';
            document.getElementById('optApplyBtn').style.display = 'none';
            document.getElementById('optBackBtn').style.display = 'none';

            // Résumé
            const totalColis = previsions.reduce((s, p) => s + p.colis, 0);
            const seuilAlerte = (typeof data.seuilAlerteSousCharge === 'number') ? data.seuilAlerteSousCharge : 70;
            document.getElementById('optResume').innerHTML = `
                <strong>${previsions.length}</strong> code(s) postal(aux) à répartir ·
                <strong>${escapeHtml(totalColis)}</strong> colis ·
                <strong>${livreursActifs.length}</strong> livreur(s) actif(s) ·
                Cible : <strong>${Math.round(totalColis / livreursActifs.length)}</strong> colis/livreur en moyenne
                <div style="margin-top: 0.4rem; font-size: 0.82rem; color: var(--text-secondary);">
                    <i class="fas fa-exclamation-triangle" style="color: var(--warning);"></i>
                    Alerte sous-charge active : seuil <strong>${seuilAlerte} colis</strong>
                    (modifiable dans Paramètres → Grille de salaire)
                </div>
            `;

            // Plafond par défaut = max_colis paramètre
            document.getElementById('optPlafondSlider').value = data.paramètres?.max_colis || 160;
            document.getElementById('optPlafondLabel').textContent = data.paramètres?.max_colis || 160;

            document.getElementById('optimisationModal').classList.add('active');
        }

        function fermerModaleOptimisation() {
            document.getElementById('optimisationModal').classList.remove('active');
            window._optimisationApercu = null;
        }

        function updatePoidsLabel(val) {
            const v = parseInt(val);
            const label = document.getElementById('optPoidsLabel');
            if (v < 30) label.textContent = 'Équilibre des colis (priorité)';
            else if (v < 70) label.textContent = 'Légèrement équilibre';
            else if (v < 130) label.textContent = 'Mixte (équilibré)';
            else label.textContent = 'Proximité géographique (priorité)';
        }

        function lancerOptimisation() {
            const livreursActifs = data.livreurs.filter(l => l.actif);
            const previsions = (data.previsions[selectedDate] || []).map(p => ({
                cp: p.code_postal,
                colis: p.colis
            }));
            const poidsDistance = parseInt(document.getElementById('optPoidsSlider').value);
            const plafondColis = parseInt(document.getElementById('optPlafondSlider').value);
            const mode = document.querySelector('input[name="optMode"]:checked').value;
            const algo = document.querySelector('input[name="optAlgo"]:checked')?.value || 'recuit';

            // Étape 1 : greedy (toujours, sert de point de départ)
            const result = optimiserTournees(previsions, livreursActifs, {
                poidsDistance, plafondColis, mode
            });

            // Étape 2 : si choisi, appliquer le recuit simulé pour améliorer
            if (algo === 'recuit') {
                // Adapter le nombre d'itérations au volume
                const nbCP = result.stats.totalCP;
                const iterations = Math.min(5000, Math.max(1000, nbCP * 30));
                const prevsMap = new Map(previsions.map(p => [p.cp, p.colis]));

                const recuitResult = recuitSimule(result.attributions, prevsMap, {
                    iterations, poidsDistance, plafondColis
                });

                // Mettre à jour avec la meilleure solution
                result.attributions = recuitResult.attributions;
                result.stats.algo = 'greedy + recuit simulé';
                result.stats.recuitDureeMs = recuitResult.dureeMs;
                result.stats.recuitGainPourcent = recuitResult.gainPourcent;
                result.stats.recuitAmeliorations = recuitResult.ameliorations;
                result.stats.recuitIterations = iterations;
                // Total durée
                result.stats.dureeMs = result.stats.dureeMs + recuitResult.dureeMs;
            } else {
                result.stats.algo = 'greedy';
            }

            window._optimisationApercu = result;
            afficherApercuOptimisation(result);
        }

        function afficherApercuOptimisation(result) {
            const { attributions, cpInconnus, stats } = result;

            // Calcul des stats globales
            let totalColis = 0, livreursAvecCP = 0, depassements = 0, sousMin = 0;
            const minColis = data.paramètres?.min_colis || 80;
            // v42 : seuil d'alerte sous-charge (par défaut 70)
            const seuilAlerte = (typeof data.seuilAlerteSousCharge === 'number') ? data.seuilAlerteSousCharge : 70;
            const livreursSousCharge = [];  // [{ livreurId, livreur, cps, total }]

            attributions.forEach(({ livreur, cps, total }, livreurId) => {
                totalColis += total;
                if (cps.length > 0) livreursAvecCP++;
                if (total > stats.plafondColis) depassements++;
                if (total > 0 && total < minColis) sousMin++;
                // v42 : détection sous-charge stricte
                if (cps.length > 0 && total < seuilAlerte) {
                    livreursSousCharge.push({ livreurId, livreur, cps, total });
                }
            });

            // Stats grid (4 cards + badge recuit si appliqué)
            const recuitBadge = stats.recuitGainPourcent > 0
                ? `<div style="grid-column: 1/-1; padding: 0.6rem 0.85rem; background: linear-gradient(135deg, rgba(15,184,154,0.12), rgba(45,212,163,0.12)); border-left: 3px solid var(--primary); border-radius: var(--radius-sm); font-size: 0.85rem; color: var(--text); margin-top: 0.25rem;">
                    <i class="fas fa-fire" style="color: var(--primary);"></i>
                    <strong>Recuit simulé</strong> : ${stats.recuitAmeliorations} amélioration(s) sur ${stats.recuitIterations} itérations · gain ${stats.recuitGainPourcent}% · ${stats.recuitDureeMs} ms supplémentaires
                </div>`
                : '';

            document.getElementById('optApercuStats').innerHTML = `
                <div class="stat-card" style="padding: 0.65rem;"><div class="stat-value" style="font-size: 1.3rem;">${stats.totalCP}</div><div class="stat-label" style="font-size: 0.78rem;">CP traités</div></div>
                <div class="stat-card" style="padding: 0.65rem;"><div class="stat-value" style="font-size: 1.3rem;">${escapeHtml(totalColis)}</div><div class="stat-label" style="font-size: 0.78rem;">Colis répartis</div></div>
                <div class="stat-card" style="padding: 0.65rem;"><div class="stat-value" style="font-size: 1.3rem;">${livreursAvecCP}/${stats.livreursActifs}</div><div class="stat-label" style="font-size: 0.78rem;">Livreurs assignés</div></div>
                <div class="stat-card" style="padding: 0.65rem;"><div class="stat-value" style="font-size: 1.3rem;">${stats.dureeMs} ms</div><div class="stat-label" style="font-size: 0.78rem;">Calculé en</div></div>
                ${recuitBadge}
            `;

            // Liste des livreurs avec leur répartition
            const sorted = [...attributions.entries()].sort((a, b) => b[1].total - a[1].total);
            const html = sorted.map(([livreurId, { livreur, cps, total }]) => {
                const color = (typeof getLivreurColor === 'function') ? getLivreurColor(livreurId) : '#2B6E8F';
                const aperçu = cps.slice(0, 10).join(', ') + (cps.length > 10 ? `… (+${cps.length - 10})` : '');
                const charge = stats.plafondColis > 0 ? Math.round((total / stats.plafondColis) * 100) : 0;
                const sousChargeCritique = cps.length > 0 && total < seuilAlerte;
                const chargeClass = total > stats.plafondColis ? 'danger' : (sousChargeCritique ? 'warning' : (total > 0 && total < minColis ? 'warning' : 'success'));
                const badgeAlerte = sousChargeCritique
                    ? `<span style="display: inline-block; margin-left: 0.4rem; padding: 0.1rem 0.45rem; background: var(--warning); color: white; border-radius: 999px; font-size: 0.7rem; font-weight: 700;">⚠ &lt; ${seuilAlerte}</span>`
                    : '';
                return `
                    <div style="padding: 0.85rem; background: var(--background); border: 1px solid var(--border); border-left: 4px solid ${color}; border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
                            <strong style="color: ${color}; font-size: 0.95rem;">${escapeHtml(livreur.nom)}${livreur.prenom ? ' ' + escapeHtml(livreur.prenom) : ''}${badgeAlerte}</strong>
                            <span style="font-size: 0.85rem; color: var(--text-secondary);">
                                <strong style="color: var(--${chargeClass});">${escapeHtml(total)}</strong> colis · ${cps.length} secteur(s) · ${charge}% charge
                            </span>
                        </div>
                        <div style="font-size: 0.78rem; color: var(--text-secondary); font-family: 'Courier New', monospace;">
                            ${cps.length === 0 ? '<em>Aucun CP attribué</em>' : escapeHtml(aperçu)}
                        </div>
                    </div>
                `;
            }).join('');
            document.getElementById('optApercuList').innerHTML = html;

            // Avertissements
            const warnings = [];
            if (cpInconnus.length > 0) {
                warnings.push(`<div class="alert alert-warning"><i class="fas fa-exclamation-triangle"></i> ${cpInconnus.length} CP introuvable(s) dans la base : ${escapeHtml(cpInconnus.map(c => c.cp).join(', '))} (non répartis)</div>`);
            }
            if (depassements > 0) {
                warnings.push(`<div class="alert alert-warning"><i class="fas fa-exclamation-triangle"></i> ${depassements} livreur(s) au-dessus du plafond ${stats.plafondColis} colis</div>`);
            }

            // === v42 : ALERTE SOUS-CHARGE ===
            // Si un livreur a moins que le seuilAlerte (par défaut 70 colis), proposer
            // de réassigner ses CP au livreur le plus proche pour optimiser la tournée.
            if (livreursSousCharge.length > 0) {
                const liste = livreursSousCharge.map(({ livreur, total, cps }) => {
                    const nom = livreur.nom + (livreur.prenom ? ' ' + livreur.prenom : '');
                    return `<li><strong>${escapeHtml(nom)}</strong> : ${escapeHtml(total)} colis sur ${cps.length} CP (${escapeHtml(cps.join(', '))})</li>`;
                }).join('');
                warnings.push(`
                    <div class="alert" style="background: rgba(255,149,0,0.12); color: var(--text); border-left: 4px solid var(--warning); padding: 0.85rem 1rem; border-radius: var(--radius-sm);">
                        <div style="display: flex; align-items: flex-start; gap: 0.75rem;">
                            <i class="fas fa-exclamation-triangle" style="color: var(--warning); font-size: 1.3rem; margin-top: 0.1rem;"></i>
                            <div style="flex: 1;">
                                <strong style="color: var(--warning);">Alerte sous-charge — ${livreursSousCharge.length} livreur(s) sous ${seuilAlerte} colis</strong>
                                <p style="margin: 0.4rem 0 0.5rem 0; font-size: 0.85rem;">
                                    Pour une tournée optimale, vous pouvez réassigner leurs CP au livreur le plus proche géographiquement.
                                </p>
                                <ul style="margin: 0.4rem 0 0.6rem 1.2rem; font-size: 0.82rem; color: var(--text-secondary);">${liste}</ul>
                                <button class="btn btn-warning btn-sm" onclick="reassignerSousCharge()" style="margin-top: 0.3rem;">
                                    <i class="fas fa-route"></i> Réassigner au livreur le plus proche
                                </button>
                            </div>
                        </div>
                    </div>
                `);
            } else if (sousMin > 0) {
                // Cas plus léger : sous min_colis mais au-dessus du seuil d'alerte
                warnings.push(`<div class="alert alert-warning"><i class="fas fa-info-circle"></i> ${sousMin} livreur(s) sous ${minColis} colis (charge faible mais ≥ ${seuilAlerte})</div>`);
            }

            if (warnings.length === 0) {
                warnings.push(`<div class="alert" style="background: rgba(45,212,163,0.1); color: var(--success); border-left: 3px solid var(--success); padding: 0.75rem 1rem; border-radius: var(--radius-sm);"><i class="fas fa-check-circle"></i> Répartition équilibrée, aucun problème détecté.</div>`);
            }
            document.getElementById('optWarnings').innerHTML = warnings.join('');

            // Switch UI
            document.getElementById('optStep1').style.display = 'none';
            document.getElementById('optStep2').style.display = 'block';
            document.getElementById('optApplyBtn').style.display = 'inline-block';
            document.getElementById('optBackBtn').style.display = 'inline-block';
        }

        // ====================================================================
        // v42 : RÉASSIGNATION SOUS-CHARGE
        // ====================================================================
        // Pour chaque livreur sous le seuil d'alerte (par défaut 70 colis),
        // on retire ses CP de son attribution et on les réassigne au livreur
        // le plus proche géographiquement (qui a au moins un CP attribué et
        // qui n'est pas lui-même sous-chargé).
        // ====================================================================
        function reassignerSousCharge() {
            if (!window._optimisationApercu) {
                showToast('Aucune répartition en aperçu', 'error');
                return;
            }
            const { attributions, stats } = window._optimisationApercu;
            const seuilAlerte = (typeof data.seuilAlerteSousCharge === 'number') ? data.seuilAlerteSousCharge : 70;

            // Récupérer la map prévisions pour calculer les centroïdes
            const previsions = data.previsions[selectedDate] || [];
            const prevsMap = new Map(previsions.map(p => [p.code_postal, p.colis]));

            // Identifier les livreurs sous-chargés et les livreurs "réceptionnaires" (au-dessus du seuil)
            const sousCharge = [];
            const receptionnaires = [];
            attributions.forEach((info, livreurId) => {
                if (info.cps.length === 0) return;
                if (info.total < seuilAlerte) {
                    sousCharge.push({ livreurId, ...info });
                } else {
                    // Calculer le centroïde du livreur
                    const centroide = centroideCPs(info.cps, prevsMap);
                    receptionnaires.push({ livreurId, ...info, centroide });
                }
            });

            if (sousCharge.length === 0) {
                showToast('Aucun livreur sous-chargé à réassigner', 'info');
                return;
            }
            if (receptionnaires.length === 0) {
                showToast('Aucun livreur disponible pour récupérer les CP (tous sous-chargés)', 'warning');
                return;
            }

            let cpsReassignes = 0;
            const transferts = [];  // [{ from, to, cps[] }]

            // Pour chaque livreur sous-chargé, attribuer chacun de ses CP au receptionnaire
            // dont le centroïde est le plus proche du CP.
            sousCharge.forEach(sc => {
                const cpsAReassigner = sc.cps.slice();
                cpsAReassigner.forEach(cp => {
                    let bestRec = null, bestDist = Infinity;
                    for (const rec of receptionnaires) {
                        if (!rec.centroide) continue;
                        const d = distanceCPToPoint(cp, rec.centroide);
                        if (d < bestDist) {
                            bestDist = d;
                            bestRec = rec;
                        }
                    }
                    if (bestRec) {
                        // Retirer du sous-chargé
                        const recoCP = attributions.get(sc.livreurId);
                        recoCP.cps = recoCP.cps.filter(c => c !== cp);
                        recoCP.total -= (prevsMap.get(cp) || 0);
                        // Ajouter au receptionnaire
                        const recoTo = attributions.get(bestRec.livreurId);
                        if (!recoTo.cps.includes(cp)) recoTo.cps.push(cp);
                        recoTo.total += (prevsMap.get(cp) || 0);

                        // Mettre à jour le centroïde du receptionnaire pour les prochains CP
                        bestRec.centroide = centroideCPs(recoTo.cps, prevsMap);

                        // Tracker le transfert
                        let t = transferts.find(t => t.fromId === sc.livreurId && t.toId === bestRec.livreurId);
                        if (!t) {
                            t = {
                                fromId: sc.livreurId,
                                fromNom: sc.livreur.nom + (sc.livreur.prenom ? ' ' + sc.livreur.prenom : ''),
                                toId: bestRec.livreurId,
                                toNom: bestRec.livreur.nom + (bestRec.livreur.prenom ? ' ' + bestRec.livreur.prenom : ''),
                                cps: []
                            };
                            transferts.push(t);
                        }
                        t.cps.push(cp);
                        cpsReassignes++;
                    }
                });
            });

            // Re-render l'aperçu
            afficherApercuOptimisation(window._optimisationApercu);

            // Toast récapitulatif
            const resume = transferts.map(t => `${t.fromNom} → ${t.toNom} (${t.cps.length} CP)`).join(' · ');
            showToast(`${cpsReassignes} CP réassigné(s) : ${resume}`, 'success');
        }

        function retourParamsOpt() {
            document.getElementById('optStep1').style.display = 'block';
            document.getElementById('optStep2').style.display = 'none';
            document.getElementById('optApplyBtn').style.display = 'none';
            document.getElementById('optBackBtn').style.display = 'none';
        }

        function appliquerOptimisation() {
            if (!window._optimisationApercu) {
                showToast('Aucune répartition à appliquer', 'error');
                return;
            }
            const { attributions, stats } = window._optimisationApercu;

            // Appliquer : remplacer les secteurs_prioritaires de chaque livreur
            attributions.forEach(({ livreur, cps }, livreurId) => {
                const real = data.livreurs.find(l => l.id === livreurId);
                if (real) {
                    real.secteurs_prioritaires = cps.slice();
                }
            });

            saveLocal();
            updateUI();
            fermerModaleOptimisation();

            showToast(`Optimisation appliquée : ${stats.totalCP} CP répartis en ${stats.dureeMs} ms`, 'success');
        }

