        // ============== STATE ==============
        let data = {
            livreurs: [],
            previsions: {},
            distributions: {},
            paramètres: { min_colis: 80, max_colis: 160, cible_colis: 110, limite_exceptionnelle: 160 },
            saveHistory: [],
            lastSaved: null,
            historiqueEPOD: {},
            // Frais avancés par les livreurs (gasoil, adblue, huile, pneu…) ajoutés au salaire.
            // Structure : { 'YYYY-MM': { livreurName: [{ id, categorie, montant, note, date }] } }
            fraisLivreurs: {},
            // Suivi des paiements : quelles journées / quels frais ont été réglés.
            // Structure : { 'YYYY-MM': { livreurName: { jours: {'YYYY-MM-DD': true}, fraisPaye: bool } } }
            paiementsLivreurs: {},
            // Analyses Contrôle EPOD sauvegardées par mois (listes plafonnées)
            controlEPOD: {},
            ccGapSeuil: 500,
            // Inventaire centre de tri (dernier import du fichier cumulatif)
            inventaire: null,
            // Résultats d'analyse Contrôle EPOD sauvegardés par mois (anomalies, pénalités d'appel…)
            controlCenter: {},
            // Dernier mois d'historique consulté (pour rouvrir sur les bonnes données)
            dernierMoisHistorique: null,
            downloadStats: { count: 0, lastDownload: null },
            // === NOUVELLES PROPRIÉTÉS v41 ===
            cpExceptions: {},  // CP avec capacité exceptionnelle (à configurer par l'utilisateur)
            // === v43 : une seule grille de règles métier, éditable sans toucher au code.
            // Voir GRILLE_REMUNERATION_DEFAUT et appliquerGrille().
            grilleRemuneration: null,   // initialisée à la migration
            comptesTechniques: null,    // idem (ex. « Renfort-Colmar »)
            // Seuil d'alerte pour la sous-charge d'un livreur (déclenche une alerte
            // pour réassigner ses CP au livreur le plus proche)
            seuilAlerteSousCharge: 70,
            tarifPudoPenalite: 0.80,
            ongletsVisibles: {
                accueil: true, livreurs: true, previsions: true, distribution: true,
                rapport: true, carte: true, historique: true, sync: true, aide: true
            },
            suiviMensuel: {}  // { 'YYYY-MM': { livreurId: { nom, colisLivres, jours } } }
        };

        let selectedDate = (() => {
            // PLANIFICATION J+1 : par defaut on planifie pour DEMAIN
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            return tomorrow.toISOString().split('T')[0];
        })();
        let selectedHistoriqueMonth = new Date().toISOString().slice(0, 7);
        let hasUnsavedChanges = false;
        let draggedElement = null;
        let draggedData = null;

        // Données initiales avec nouveaux champs
        const LIVREURS_INITIAUX = []; // Vide pour première utilisation


        // ====== PALETTE COULEURS LIVREUR (UNIFORME DANS TOUTE L'APP) ======
        // 1 couleur stable par livreur, basée sur l'index ou l'ID
        const LIVREUR_COLORS = [
            '#2B6E8F', // bleu cartographique
            '#E8590C', // orange signalisation
            '#5F3DC4', // violet profond
            '#2F9E44', // vert route
            '#C92A2A', // rouge
            '#1971C2', // bleu vif
            '#9C36B5', // magenta
            '#E67700', // ambre
            '#0B7285', // canard
            '#B08800', // ocre
            '#846358', // brun terre
            '#5B6B7E', // gris ardoise
            '#C2255C', // framboise
            '#1098AD', // cyan
            '#7048E8', // indigo
            '#087F5B'  // émeraude
        ];

        // Mapping stable livreurId -> couleur
        // Calculé selon la position du livreur dans data.livreurs (ordre = position de création)
        function getLivreurColor(livreurIndex) {
            if (typeof livreurIndex === 'string') {
                // Si on passe un ID, retrouver l'index
                const idx = (data?.livreurs || []).findIndex(l => l.id === livreurIndex);
                livreurIndex = idx >= 0 ? idx : 0;
            }
            return LIVREUR_COLORS[livreurIndex % LIVREUR_COLORS.length];
        }

        // Retourne la couleur du livreur qui a un secteur attribué (ou null si non attribué)
        function getColorForSecteur(codePostal) {
            const livreurs = data?.livreurs || [];
            for (let i = 0; i < livreurs.length; i++) {
                if (livreurs[i].actif && livreurs[i].secteurs_prioritaires.includes(codePostal)) {
                    return { color: getLivreurColor(i), livreur: livreurs[i] };
                }
            }
            return null;  // secteur non attribué
        }

        // Pour intensité : plus de colis = couleur plus opaque

        // Helper pour convertir hex -> RGB tuple (utilisé dans jsPDF)
        function hexToRgb(hex) {
            const m = hex.replace('#', '').match(/.{2}/g);
            return m ? m.map(h => parseInt(h, 16)) : [0, 0, 0];
        }

        function getColorWithIntensity(baseColor, colis, maxColis) {
            const ratio = maxColis > 0 ? Math.max(0.35, Math.min(1, colis / maxColis)) : 0.5;
            return { color: baseColor, fillOpacity: ratio };
        }


        const ZONES_COULEURS = {
            rouge: ['68100', '68200', '68300', '68110', '68120', '68125', '68126', '68127', '68128', '68170', '68270', '68390', '68400', '68440', '68490', '68720', '68740', '68840', '68870'],
            vert: ['68000', '68040', '68124', '68180', '68210', '68220', '68250', '68280', '68320', '68360', '68420', '68460', '68500', '68520', '68600', '68630', '68640', '68780', '68920'],
            bleu: ['68130', '68190', '68260', '68310', '68330', '68350', '68510', '68540', '68680', '68700', '68730', '68790', '68800', '68850', '68890', '68950', '68990']
        };

        // ====================================================================
