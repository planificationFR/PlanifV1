/* ════════════════════════════════════════════════════════════════════
 * errors.js — gestion centralisée des erreurs.
 *
 * reportError(type, erreur, messageUtilisateur?)
 *   - trace technique complète dans console.error ;
 *   - message compréhensible pour l'utilisateur (toast) ;
 *   - jamais d'exception relancée : une erreur non critique ne doit pas
 *     faire planter l'application.
 * ════════════════════════════════════════════════════════════════════ */
const ErrorType = Object.freeze({
    NETWORK: 'reseau',
    SUPABASE: 'supabase',
    AUTH: 'auth',
    IMPORT: 'import',
    EXCEL: 'excel',
    LOCAL_STORAGE: 'stockage_local',
    QUOTA: 'quota',
    INDEXEDDB: 'indexeddb',
    CONFLICT: 'conflit',
    PDF: 'pdf',
    LIBRARY: 'bibliotheque',
    UNKNOWN: 'inconnue'
});

const ERROR_MESSAGES = {
    reseau: 'Connexion Internet indisponible. Vos données restent sauvegardées sur cet appareil.',
    supabase: 'Le serveur cloud a refusé l\'opération. Vos données restent sauvegardées sur cet appareil.',
    auth: 'Votre session a expiré ou n\'est pas valide. Reconnectez-vous.',
    import: 'Le fichier n\'a pas pu être importé.',
    excel: 'Fichier Excel invalide ou illisible.',
    stockage_local: 'La sauvegarde locale a échoué.',
    quota: 'Stockage local saturé : purgez des mois anciens (Diagnostic de sauvegarde).',
    indexeddb: 'La copie de sécurité IndexedDB est indisponible sur ce navigateur.',
    conflit: 'Des modifications ont été faites sur un autre appareil ou onglet.',
    pdf: 'La génération du PDF a échoué.',
    bibliotheque: 'Une bibliothèque n\'a pas pu être chargée (connexion ?).',
    inconnue: 'Une erreur inattendue est survenue.'
};

/** Déduit le type d'une erreur technique (réseau, auth, quota…). */
function classifyError(err) {
    if (!err) return ErrorType.UNKNOWN;
    const msg = String(err.message || err.error_description || err || '').toLowerCase();
    const code = String(err.code || err.status || '');
    if (err.name === 'QuotaExceededError' || /quota/.test(msg) || code === '22') return ErrorType.QUOTA;
    if ((typeof navigator !== 'undefined' && navigator.onLine === false) ||
        /failed to fetch|networkerror|network request failed|load failed|fetch|timeout|err_internet/.test(msg)) return ErrorType.NETWORK;
    if (code === '401' || code === '403' || /jwt|token|session|not authenticated|refresh/.test(msg)) return ErrorType.AUTH;
    if (/indexeddb|idb/.test(msg)) return ErrorType.INDEXEDDB;
    if (code && /^(PGRST|42|23|40)/.test(code)) return ErrorType.SUPABASE;
    return ErrorType.UNKNOWN;
}

let _lastErrorToast = { key: '', t: 0 };

/**
 * Signale une erreur : console détaillée + message utilisateur (dédoublonné 5 s).
 * @param {string} type  un des ErrorType (ou null pour détection automatique)
 * @param {*} err        l'erreur technique
 * @param {string} [userMessage] message métier spécifique (sinon message générique)
 * @param {{silent?: boolean}} [opts] silent = console uniquement
 */
function reportError(type, err, userMessage, opts) {
    const t = type || classifyError(err);
    try { console.error('[' + t + ']', userMessage || '', err); } catch (e) { /* console indisponible */ }
    if (opts && opts.silent) return t;
    const msg = userMessage || ERROR_MESSAGES[t] || ERROR_MESSAGES.inconnue;
    const key = t + '|' + msg;
    const now = Date.now();
    if (_lastErrorToast.key === key && now - _lastErrorToast.t < 5000) return t;
    _lastErrorToast = { key, t: now };
    try {
        if (typeof showToast === 'function') showToast(msg, t === ErrorType.CONFLICT || t === ErrorType.NETWORK ? 'warning' : 'error');
    } catch (e) { /* UI pas encore prête */ }
    return t;
}

// Filets de sécurité globaux : une erreur non interceptée est tracée dans la
// console (sans toast, pour ne pas inonder l'écran d'erreurs bénignes de
// bibliothèques) ; seule la saturation du stockage est signalée à l'utilisateur.
window.addEventListener('error', (ev) => {
    if (!ev.error) return; // échec de chargement d'une ressource : géré ailleurs
    reportError(null, ev.error, null, { silent: true });
});
window.addEventListener('unhandledrejection', (ev) => {
    const t = classifyError(ev.reason);
    reportError(t, ev.reason, null, { silent: t !== ErrorType.QUOTA });
});
