/* ════════════════════════════════════════════════════════════════════
 * migrations.js — VERSION DU SCHÉMA DE DONNÉES ET MIGRATIONS.
 *
 * data.schemaVersion indique la version du format des données.
 * Les documents antérieurs à la v55 n'ont pas ce champ (= version 0).
 *
 * normalizeDataAfterLoad() DOIT être appelée sur TOUS les chemins de
 * chargement : localStorage, cloud, fusion, import JSON, instantané.
 *
 * Règles :
 *   - chaque migration est idempotente (la rejouer ne change rien) ;
 *   - elle ne s'exécute que si schemaVersion < sa version ;
 *   - avant une migration qui SUPPRIME des champs obsolètes, un instantané
 *     IndexedDB est créé (« avant migration vXX ») : rien n'est perdu ;
 *   - les nouvelles migrations s'ajoutent à la fin de MIGRATIONS, puis
 *     CONFIG.schemaVersion est incrémenté.
 * ════════════════════════════════════════════════════════════════════ */

function _defautsStructure(d) {
    if (!d.distributions) d.distributions = {};
    if (!d.previsions) d.previsions = {};
    if (!d.paramètres) d.paramètres = { min_colis: 80, max_colis: 160, cible_colis: 110, limite_exceptionnelle: 160 };
    if (!Array.isArray(d.saveHistory)) d.saveHistory = [];
    if (!d.historiqueEPOD) d.historiqueEPOD = {};
    if (!d.fraisLivreurs) d.fraisLivreurs = {};
    if (!d.paiementsLivreurs) d.paiementsLivreurs = {};
    if (!d.controlEPOD) d.controlEPOD = {};
    if (d.ccGapSeuil === undefined) d.ccGapSeuil = 500;
    if (d.inventaire === undefined) d.inventaire = null;
    if (!d.controlCenter) d.controlCenter = {};
    if (!d.downloadStats) d.downloadStats = { count: 0, lastDownload: null };
    if (!Array.isArray(d.livreurs)) d.livreurs = [];
    d.livreurs = d.livreurs.map(l => ({ ...LIVREURS_INITIAUX[0], ...l, modifications: l.modifications || [] }));
    if (!d.ongletsVisibles) d.ongletsVisibles = {
        accueil: true, livreurs: true, previsions: true, distribution: true,
        rapport: true, carte: true, historique: true, controle: true, sync: true, aide: true
    };
    if (!d.suiviMensuel) d.suiviMensuel = {};
}

/**
 * Liste ordonnée des migrations. `destructive: true` = supprime des champs
 * obsolètes → instantané préalable.
 */
const MIGRATIONS = [
    {
        version: 41, description: 'Paramètres v41 (exceptions CP, pénalité PUDO, seuil sous-charge)',
        run(d) {
            if (!d.cpExceptions) d.cpExceptions = {};
            if (d.tarifPudoPenalite === undefined) d.tarifPudoPenalite = 0.80;
            if (d.seuilAlerteSousCharge === undefined) d.seuilAlerteSousCharge = 70;
        }
    },
    {
        version: 43, description: 'Grille de rémunération unique + comptes techniques',
        run(d) {
            if (!Array.isArray(d.grilleRemuneration) || d.grilleRemuneration.length === 0) {
                d.grilleRemuneration = JSON.parse(JSON.stringify(GRILLE_REMUNERATION_DEFAUT));
            }
            if (!Array.isArray(d.comptesTechniques)) d.comptesTechniques = [...COMPTES_TECHNIQUES_DEFAUT];
            if (typeof d.bonusAeVehicule !== 'number') d.bonusAeVehicule = 10;
            if (typeof d.seuilPudoPct !== 'number') d.seuilPudoPct = 3;
        }
    },
    {
        version: 44, description: 'Transferts de colis + détection d\'anomalies',
        run(d) {
            if (!d.transfertsColis) d.transfertsColis = {};
            if (!d.anomaliesTournees) d.anomaliesTournees = {};
        }
    },
    {
        version: 46, description: 'Remise à plat (anciens registres sans effet sur la paie)', destructive: true,
        needs(d) {
            return d.epodTransferts !== undefined || d.grilleSalaire !== undefined || d.grilleSalairePersonnalisee !== undefined ||
                d.seuilSupplement !== undefined || d.supplementParColis !== undefined ||
                Object.values(d.anomaliesTournees || {}).some(l => (l || []).some(a => a && a.confiance === undefined));
        },
        run(d) {
            // Ancien registre sans effet sur la paie (doublons) — supprimé.
            delete d.epodTransferts;
            // Détections antérieures sans niveau de confiance : écartées, un réimport
            // du fichier EPOD les régénère complètes.
            Object.keys(d.anomaliesTournees || {}).forEach(m => {
                const liste = d.anomaliesTournees[m] || [];
                if (liste.some(a => a.confiance === undefined)) {
                    d.anomaliesTournees[m] = liste.filter(a => a.confiance !== undefined);
                    d._detectionARefaire = true;
                }
            });
            // Anciens mécanismes de salaire remplacés par la grille v43.
            delete d.grilleSalaire;
            delete d.grilleSalairePersonnalisee;
            delete d.seuilSupplement;
            delete d.supplementParColis;
        }
    },
    {
        version: 55, description: 'Introduction de schemaVersion',
        run(d) { /* aucun changement de structure : marque simplement la version */ }
    }
];

/**
 * Applique séquentiellement les migrations nécessaires à `d`.
 * Renvoie la liste des migrations exécutées.
 */
function runMigrations(d) {
    const depart = Number(d.schemaVersion) || 0;
    const executees = [];
    for (const m of MIGRATIONS) {
        // Les migrations « historiques » (≤ 46) ont toujours été rejouées à chaque
        // chargement : on conserve ce comportement tant qu'elles restent nécessaires
        // (données importées d'une vieille sauvegarde, par exemple).
        const aFaire = depart < m.version || (m.needs && m.needs(d));
        if (!aFaire) continue;
        if (m.destructive && (!m.needs || m.needs(d))) {
            try { snapshotCreer('avant migration v' + m.version, JSON.stringify(d)); } catch (e) { /* best effort */ }
        }
        m.run(d);
        executees.push(m.version);
    }
    if (depart < CONFIG.schemaVersion) d.schemaVersion = CONFIG.schemaVersion;
    if (executees.length) console.info('[Migrations] appliquées :', executees.join(', '), '(schéma v' + depart + ' → v' + d.schemaVersion + ')');
    return executees;
}

/** Compat : ancien point d'entrée des migrations. */
function migrerDonnees() {
    // Les migrations v41–v44 sont purement additives : on les garantit à chaque
    // chargement, quel que soit schemaVersion (valeurs par défaut manquantes).
    MIGRATIONS.filter(m => !m.destructive && m.version <= 44).forEach(m => m.run(data));
    runMigrations(data);
}

/** Normalise `data` après n'importe quel chargement. */
function normalizeDataAfterLoad() {
    if (!data || typeof data !== 'object') data = {};
    _defautsStructure(data);
    migrerDonnees();
    // Cohérence (pas une migration) : un document restauré peut contenir des
    // détections marquées réaffectées dont les transferts ne sont pas revenus.
    try { reconcilierAnomaliesEtTransferts(); } catch (e) { /* données partielles */ }
}
