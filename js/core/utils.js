/* ════════════════════════════════════════════════════════════════════
 * utils.js — fonctions utilitaires partagées (échappement, DOM sûr).
 * Chargé juste après config.js : tout le reste de l'application peut
 * utiliser ces fonctions.
 *
 * RÈGLE XSS : toute valeur venant d'un fichier importé (Excel, EPOD, JSON),
 * de Supabase ou d'un champ de formulaire doit passer par l'une de ces
 * fonctions AVANT d'être insérée dans une chaîne HTML (innerHTML, template).
 *
 *   escapeHtml(v)   → texte ou valeur d'attribut HTML  : <td>${escapeHtml(nom)}</td>
 *                                                        title="${escapeHtml(t)}"
 *   escAttr(v)      → alias de escapeHtml pour les attributs (value, title…)
 *   escJsAttr(v)    → chaîne JS à l'intérieur d'un attribut d'événement :
 *                     onclick="maFonction('${escJsAttr(nom)}')"
 *   textContent / el() → préférer la création DOM quand c'est simple.
 * ════════════════════════════════════════════════════════════════════ */

/** Échappe une valeur pour l'insérer dans du HTML (texte ou attribut entre guillemets). */
function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"'`]/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
    }[m]));
}

/** Compatibilité : ancien nom utilisé dans le module Paramètres. */
function escapeHtmlSettings(s) { return escapeHtml(s); }

/** Valeur d'attribut HTML classique (value="", title="", data-x=""). */
function escAttr(s) { return escapeHtml(s); }

/**
 * Chaîne littérale JavaScript placée DANS un attribut HTML d'événement,
 * entre apostrophes ou guillemets : onclick="f('${escJsAttr(v)}')".
 * Tous les caractères dangereux (\ ' " < > & ` retours ligne) sont encodés
 * en séquences \uXXXX : le HTML n'y voit aucun caractère spécial et le
 * moteur JavaScript reconstitue la valeur exacte.
 */
function escJsAttr(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[\\'"<>&`\n\r\u2028\u2029]/g,
        c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Échappe une valeur pour une URL (paramètre). */
function escUrl(s) { return encodeURIComponent(s === null || s === undefined ? '' : String(s)); }

/** Nombre sûr pour interpolation HTML (évite d'injecter une chaîne arbitraire). */
function safeNum(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Création DOM explicite : el('div', { class: 'x', title: t }, ['texte', autreNoeud])
 * Les chaînes enfants sont insérées comme TEXTE (jamais interprétées en HTML).
 */
function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v === true ? '' : String(v));
        }
    }
    (Array.isArray(children) ? children : (children !== undefined ? [children] : [])).forEach(c => {
        if (c === null || c === undefined || c === false) return;
        node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
}

/** Copie profonde d'une structure JSON (données de l'application). */
function deepCloneJSON(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }

/** Signature rapide d'une chaîne (détection de changement, pas de sécurité). */
function _quickHash(str) {
    let h = 5381, i = str.length;
    while (i) { h = (h * 33) ^ str.charCodeAt(--i); }
    return (h >>> 0).toString(16) + ':' + str.length;
}

/** Heure locale HH:MM:SS. */
function formatHeure(ts) {
    try { return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch (e) { return ''; }
}

/** Charge un script une seule fois : essaie chaque URL dans l'ordre (local d'abord, CDN ensuite). */
const _scriptsCharges = {};
function loadScriptOnce(urls, testFn) {
    const liste = Array.isArray(urls) ? urls : [urls];
    const cle = liste[0];
    if (testFn && testFn()) return Promise.resolve(true);
    if (_scriptsCharges[cle]) return _scriptsCharges[cle];
    _scriptsCharges[cle] = (async () => {
        let derniereErreur = null;
        for (const url of liste) {
            try {
                await new Promise((res, rej) => {
                    const s = document.createElement('script');
                    s.src = url;
                    s.async = true;
                    s.onload = () => res(true);
                    s.onerror = () => { s.remove(); rej(new Error('Échec du chargement : ' + url)); };
                    document.head.appendChild(s);
                });
                if (!testFn || testFn()) return true;
            } catch (e) { derniereErreur = e; }
        }
        delete _scriptsCharges[cle];
        throw derniereErreur || new Error('Bibliothèque indisponible');
    })();
    return _scriptsCharges[cle];
}
