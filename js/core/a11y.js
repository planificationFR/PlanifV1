/* ════════════════════════════════════════════════════════════════════
 * a11y.js — ACCESSIBILITÉ transversale, sans modifier le design.
 *
 *  - toutes les modales (.modal-overlay, .storage-diag-overlay) :
 *    role="dialog", aria-modal="true", titre associé, focus placé dans la
 *    modale à l'ouverture, piégé (Tab), restauré à la fermeture, Échap ferme ;
 *  - boutons-icônes sans texte : aria-label repris du title ;
 *  - éléments cliquables non-boutons (onglets de navigation…) : role="button",
 *    focusables, activables au clavier (Entrée / Espace) ;
 *  - libellés de formulaire associés à leur champ ;
 *  - onglet actif signalé (aria-current).
 * Tout est appliqué automatiquement, y compris au contenu généré plus tard.
 * ════════════════════════════════════════════════════════════════════ */
const Accessibilite = (() => {
    const SEL_MODALE = '.modal-overlay, .storage-diag-overlay, .tutorial-welcome';
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const pileFocus = [];       // éléments à re-focaliser, par modale ouverte
    let modalesStatiques = new WeakSet();
    let _idAuto = 0;

    function estOuverte(m) {
        if (!m || !m.isConnected) return false;
        if (m.classList.contains('active') || m.classList.contains('show')) return true;
        return false;
    }
    function modalesOuvertes() {
        return Array.from(document.querySelectorAll(SEL_MODALE)).filter(estOuverte);
    }
    function idPour(el, prefixe) {
        if (!el.id) el.id = prefixe + '-' + (++_idAuto);
        return el.id;
    }

    function preparerModale(m) {
        if (m.dataset.a11y === '1') return;
        m.dataset.a11y = '1';
        m.setAttribute('role', 'dialog');
        m.setAttribute('aria-modal', 'true');
        const titre = m.querySelector('h1, h2, h3, h4');
        if (titre && !m.hasAttribute('aria-labelledby')) m.setAttribute('aria-labelledby', idPour(titre, 'dlg-titre'));
    }

    function ouvrir(m) {
        preparerModale(m);
        if (m._a11yOuverte) return;
        m._a11yOuverte = true;
        pileFocus.push({ modale: m, retour: document.activeElement });
        setTimeout(() => {
            if (!estOuverte(m)) return;
            const cible = m.querySelector('[autofocus]') || m.querySelector('.modal-body ' + FOCUSABLE) || m.querySelector(FOCUSABLE);
            if (cible && !m.contains(document.activeElement)) { try { cible.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        }, 60);
    }

    function fermer(m) {
        if (!m._a11yOuverte) return;
        m._a11yOuverte = false;
        const i = pileFocus.findIndex(x => x.modale === m);
        if (i >= 0) {
            const { retour } = pileFocus.splice(i, 1)[0];
            if (retour && retour.isConnected && typeof retour.focus === 'function') { try { retour.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        }
    }

    /** Ferme la modale du dessus (Échap). */
    function fermerDessus() {
        const ouvertes = modalesOuvertes();
        if (!ouvertes.length) return false;
        const m = ouvertes[ouvertes.length - 1];
        if (m.classList.contains('tutorial-welcome')) return false; // géré par le tutoriel
        if (m.id && modalesStatiques.has(m)) m.classList.remove('active');
        else m.remove();                       // modale générée dynamiquement
        fermer(m);
        return true;
    }

    function ameliorerElements(racine) {
        const r = racine || document;
        // Boutons-icônes : nom accessible
        r.querySelectorAll('button, a.btn, [role="button"]').forEach(b => {
            if (b.hasAttribute('aria-label')) return;
            const texte = (b.textContent || '').trim();
            if (!texte && b.title) b.setAttribute('aria-label', b.title);
        });
        r.querySelectorAll('button > i.fas, button > i.fab, button > i.far, .btn > i').forEach(i => i.setAttribute('aria-hidden', 'true'));
        // Éléments cliquables non natifs → boutons accessibles
        r.querySelectorAll('.nav-item, .config-tab:not(button), .import-tab-btn:not(button), [data-settings-tab]:not(button), .theme-toggle:not(button)').forEach(el => {
            if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
            if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        });
        r.querySelectorAll('.nav-item').forEach(el => {
            if (el.classList.contains('active')) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
        });
        // Libellés de formulaire
        r.querySelectorAll('.form-group').forEach(g => {
            const label = g.querySelector('label.form-label, label');
            const champ = g.querySelector('input:not([type="hidden"]), select, textarea');
            if (label && champ && !label.htmlFor && !label.contains(champ)) label.htmlFor = idPour(champ, 'champ');
        });
        r.querySelectorAll(SEL_MODALE).forEach(preparerModale);
    }

    let _timer = null;
    function planifierAmelioration() {
        if (_timer) return;
        _timer = setTimeout(() => { _timer = null; try { ameliorerElements(document); } catch (e) { /* ignore */ } }, 250);
    }

    function init() {
        document.querySelectorAll(SEL_MODALE).forEach(m => { if (m.id) modalesStatiques.add(m); });
        ameliorerElements(document);

        // Ouverture / fermeture des modales (changement de classe) + contenu ajouté.
        const obs = new MutationObserver((muts) => {
            let ajout = false;
            for (const mu of muts) {
                if (mu.type === 'attributes' && mu.target.matches && mu.target.matches(SEL_MODALE)) {
                    if (estOuverte(mu.target)) ouvrir(mu.target); else fermer(mu.target);
                } else if (mu.type === 'childList') {
                    mu.addedNodes.forEach(n => { if (n.nodeType === 1) { ajout = true; if (n.matches(SEL_MODALE) && estOuverte(n)) ouvrir(n); } });
                    mu.removedNodes.forEach(n => { if (n.nodeType === 1 && n._a11yOuverte) fermer(n); });
                }
                if (mu.type === 'attributes' && mu.target.classList && mu.target.classList.contains('nav-item')) ajout = true;
            }
            if (ajout) planifierAmelioration();
        });
        obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (fermerDessus()) { e.preventDefault(); }
                return;
            }
            // Piège du focus dans la modale ouverte
            if (e.key === 'Tab') {
                const ouvertes = modalesOuvertes();
                const m = ouvertes[ouvertes.length - 1];
                if (!m || m.classList.contains('tutorial-welcome')) return;
                const f = Array.from(m.querySelectorAll(FOCUSABLE)).filter(x => x.offsetParent !== null);
                if (!f.length) return;
                const premier = f[0], dernier = f[f.length - 1];
                if (e.shiftKey && (document.activeElement === premier || !m.contains(document.activeElement))) { e.preventDefault(); dernier.focus(); }
                else if (!e.shiftKey && (document.activeElement === dernier || !m.contains(document.activeElement))) { e.preventDefault(); premier.focus(); }
                return;
            }
            // Activation clavier des pseudo-boutons
            if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.getAttribute &&
                e.target.getAttribute('role') === 'button' && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) {
                e.preventDefault();
                e.target.click();
            }
        });
    }

    return { init, ouvrir, fermer, ameliorer: ameliorerElements };
})();
