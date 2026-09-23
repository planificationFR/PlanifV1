/* ════════════════════════════════════════════════════════════════════
 * merge.js — FUSION À 3 VOIES de deux versions des données.
 *
 * Utilisée quand deux appareils (ou deux onglets) ont modifié les données
 * à partir de la même version de départ (« base ») :
 *
 *   base   : dernière version commune connue
 *   local  : version de cet appareil
 *   remote : version de l'autre appareil / onglet / du cloud
 *
 * Règles (appliquées récursivement, clé par clé) :
 *   - modifié d'un seul côté              → on garde la modification ;
 *   - modifié à l'identique des deux côtés → identique ;
 *   - ajouté d'un seul côté               → ajouté ;
 *   - supprimé d'un côté, inchangé de l'autre → supprimé ;
 *   - supprimé d'un côté, MODIFIÉ de l'autre  → la version modifiée est
 *     conservée (aucune perte) et un conflit est signalé ;
 *   - modifié différemment des deux côtés (valeur simple) → la version
 *     LOCALE est conservée, un conflit est signalé. L'appelant sauvegarde
 *     la version distante complète dans un instantané AVANT la fusion :
 *     rien n'est perdu, l'utilisateur peut revenir à l'autre version.
 *
 * Listes d'objets portant un `id` (ex. livreurs) : fusion élément par
 * élément. Autres listes : traitées comme des valeurs simples.
 * ════════════════════════════════════════════════════════════════════ */

function _isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function _jsonEq(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
}
function _isIdList(arr) {
    return Array.isArray(arr) && arr.length > 0 && arr.every(x => _isPlainObject(x) && x.id !== undefined && x.id !== null);
}

// Champs traités de façon spécifique (métadonnées qui changent à chaque sauvegarde)
const _MERGE_SPECIAL = {
    lastSaved: (b, l, r) => ((l || '') > (r || '') ? l : r),
    schemaVersion: (b, l, r) => Math.max(Number(l) || 0, Number(r) || 0),
    saveHistory: (b, l, r) => {
        const all = [...(Array.isArray(l) ? l : []), ...(Array.isArray(r) ? r : [])];
        const vus = new Set();
        return all.filter(e => { const k = JSON.stringify(e); if (vus.has(k)) return false; vus.add(k); return true; })
            .sort((a, b2) => String(b2 && b2.date || '').localeCompare(String(a && a.date || '')))
            .slice(0, 20);
    },
    // Horodatages « première vue » posés automatiquement par la purge (rétention) :
    // fusion clé par clé, en cas de double création on garde la date la plus ancienne.
    datesImport: (b, l, r) => {
        const base = _isPlainObject(b) ? b : {}, loc = _isPlainObject(l) ? l : {}, dist = _isPlainObject(r) ? r : {};
        const out = {};
        new Set([...Object.keys(loc), ...Object.keys(dist)]).forEach(k => {
            const inL = k in loc, inR = k in dist, inB = k in base;
            if (inL && inR) out[k] = String(loc[k]) < String(dist[k]) ? loc[k] : dist[k];
            else if (inL) { if (!(inB && base[k] === loc[k])) out[k] = loc[k]; }
            else if (!(inB && base[k] === dist[k])) out[k] = dist[k];
        });
        return out;
    },
    // Recalculé automatiquement à partir des distributions : on prend la version locale.
    suiviMensuel: (b, l, r) => (l !== undefined ? l : r),
    // Préférence d'affichage propre à l'appareil.
    dernierMoisHistorique: (b, l, r) => (l !== undefined ? l : r)
};

function _merge3(base, local, remote, path, conflicts) {
    if (_jsonEq(local, remote)) return local;
    if (_jsonEq(base, local)) return remote;
    if (_jsonEq(base, remote)) return local;

    // Les deux côtés ont changé différemment.
    if (_isPlainObject(local) && _isPlainObject(remote)) {
        const b = _isPlainObject(base) ? base : {};
        const out = {};
        const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
        for (const k of keys) {
            const p = path ? path + '.' + k : k;
            const inL = Object.prototype.hasOwnProperty.call(local, k);
            const inR = Object.prototype.hasOwnProperty.call(remote, k);
            const inB = Object.prototype.hasOwnProperty.call(b, k);
            if (!path && _MERGE_SPECIAL[k]) { const v = _MERGE_SPECIAL[k](b[k], local[k], remote[k]); if (v !== undefined) out[k] = v; continue; }
            if (inL && inR) { out[k] = _merge3(b[k], local[k], remote[k], p, conflicts); continue; }
            if (inL && !inR) {
                if (inB && _jsonEq(b[k], local[k])) continue;           // supprimé à distance, inchangé ici
                if (inB) conflicts.push({ path: p, type: 'supprime-distant-modifie-local' });
                out[k] = local[k];                                     // ajouté ici (ou conservé)
                continue;
            }
            // !inL && inR
            if (inB && _jsonEq(b[k], remote[k])) continue;              // supprimé ici, inchangé à distance
            if (inB) conflicts.push({ path: p, type: 'supprime-local-modifie-distant' });
            out[k] = remote[k];
        }
        return out;
    }

    if (_isIdList(local) && _isIdList(remote)) {
        const bList = _isIdList(base) ? base : [];
        const byId = (arr) => { const m = new Map(); arr.forEach(x => m.set(String(x.id), x)); return m; };
        const mB = byId(bList), mL = byId(local), mR = byId(remote);
        const out = [];
        const traite = new Set();
        const pousser = (id) => {
            if (traite.has(id)) return;
            traite.add(id);
            const inL = mL.has(id), inR = mR.has(id), inB = mB.has(id);
            const p = (path || '') + '[' + id + ']';
            if (inL && inR) { out.push(_merge3(mB.get(id), mL.get(id), mR.get(id), p, conflicts)); return; }
            if (inL) {
                if (inB && _jsonEq(mB.get(id), mL.get(id))) return;
                if (inB) conflicts.push({ path: p, type: 'supprime-distant-modifie-local' });
                out.push(mL.get(id)); return;
            }
            if (inB && _jsonEq(mB.get(id), mR.get(id))) return;
            if (inB) conflicts.push({ path: p, type: 'supprime-local-modifie-distant' });
            out.push(mR.get(id));
        };
        local.forEach(x => pousser(String(x.id)));   // ordre local d'abord
        remote.forEach(x => pousser(String(x.id)));  // puis éléments ajoutés à distance
        return out;
    }

    conflicts.push({ path: path || '(racine)', type: 'modifie-des-deux-cotes' });
    return local;
}

/**
 * Fusionne trois versions complètes. Ne modifie aucun des objets reçus.
 * @returns {{doc: object, conflicts: Array<{path:string,type:string}>}}
 */
function mergeDocuments(base, local, remote) {
    const conflicts = [];
    const doc = _merge3(base || {}, local || {}, remote || {}, '', conflicts);
    return { doc: JSON.parse(JSON.stringify(doc)), conflicts };
}

/** Libellé lisible d'un chemin de conflit (« historiqueEPOD.2026-09.Hamza » …). */
function libelleConflit(c) {
    const p = String(c.path || '');
    const racine = p.split(/[.[]/)[0];
    const noms = {
        livreurs: 'Livreurs', historiqueEPOD: 'Historique / salaires', distributions: 'Distributions',
        previsions: 'Prévisions', fraisLivreurs: 'Frais livreurs', paiementsLivreurs: 'Paiements',
        transfertsColis: 'Transferts de colis', anomaliesTournees: 'Détections', grilleRemuneration: 'Grille de rémunération',
        paramètres: 'Paramètres', __terrain__: 'Optimisation Terrain', inventaire: 'Inventaire', controlEPOD: 'Contrôle EPOD'
    };
    return (noms[racine] || racine) + (p.length > racine.length ? ' — ' + p.slice(racine.length + 1, racine.length + 80) : '');
}
