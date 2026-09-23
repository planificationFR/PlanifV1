/* ═══════════════════════════════════════════════════════════════
   MODULE MODE SCAN — onglet plein écran pour douchette code-barres
   Aucune autorisation système requise (douchette = clavier HID).
   La caméra optionnelle utilise html5-qrcode (chargé à la demande).
   ═══════════════════════════════════════════════════════════════ */
(function(){
    'use strict';

    // État local
    let scanInitialized = false;
    let scanFocusInterval = null;
    let scanSessionTotal = 0;
    let scanSessionFound = 0;
    let scanSessionMissed = 0;
    let scanHistory = []; // [{barcode, found, ts}]
    let scanLastSearchTs = 0;
    let scanCameraActive = false;
    let scanCameraInstance = null;

    // Hook sur switchTab pour initialiser et reprendre le focus à chaque venue sur l'onglet
    const _origSwitchTab = window.switchTab;
    window.switchTab = function(tab){
        const result = _origSwitchTab ? _origSwitchTab.apply(this, arguments) : undefined;
        if(tab === 'scan'){
            scanInit();
            scanRequestFocus();
            scanUpdateStatus();
        } else {
            scanStopFocusGuard();
            // Désactiver la caméra si on quitte l'onglet
            if(scanCameraActive) scanCloseCamera();
        }
        return result;
    };

    function scanInit(){
        if(scanInitialized) return;
        scanInitialized = true;

        const input = document.getElementById('scan-mainInput');
        if(!input) return;

        // Soumission au Entrée
        input.addEventListener('keydown', (e) => {
            if(e.key === 'Enter'){
                e.preventDefault();
                scanSubmit();
            }
        });

        // Détection automatique de submit "à la douchette" :
        // les douchettes envoient un \n ou \r à la fin. Si le texte se termine par \n ou \r → on submit.
        input.addEventListener('input', () => {
            const v = input.value;
            if(v.endsWith('\n') || v.endsWith('\r')){
                input.value = v.replace(/[\r\n]+$/, '');
                scanSubmit();
            }
        });

        // Coller (Ctrl+V) → submit auto
        input.addEventListener('paste', (e) => {
            setTimeout(() => {
                if(input.value.trim()) scanSubmit();
            }, 0);
        });

        // Mettre à jour le badge "focus actif" en temps réel
        input.addEventListener('focus', () => {
            document.querySelector('.scan-input-bar')?.classList.add('focused');
            const badge = document.getElementById('scan-focusBadge');
            if(badge){ badge.classList.remove('lost'); badge.innerHTML = '<i class="fas fa-keyboard"></i> Auto-focus actif'; }
            scanUpdateStatus('listening');
        });
        input.addEventListener('blur', () => {
            document.querySelector('.scan-input-bar')?.classList.remove('focused');
            // Au prochain tick du timer, le focus sera repris automatiquement
        });

        // ═══ CAPTURE GLOBALE "DOUCHETTE" (filaire ou Bluetooth HID) ═══
        // Les douchettes émulent un clavier et tapent très vite (< 35 ms entre touches),
        // terminé par Entrée. Ce filet capture un scan même si le champ a perdu le focus
        // (ex : l'utilisateur vient de cliquer un bouton). Aucune config nécessaire :
        // toute douchette en mode HID (USB ou Bluetooth) est reconnue automatiquement.
        let wedgeBuf = '';
        let wedgeLast = 0;
        document.addEventListener('keydown', (e) => {
            // Uniquement sur l'onglet scan, et pas si l'utilisateur tape dans un autre champ
            const scanTab = document.getElementById('tab-scan');
            if (!scanTab || !scanTab.classList.contains('active')) return;
            const ae = document.activeElement;
            if (ae === input) return; // le champ scan gère déjà
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') ) {
                // Autre champ actif : seule une frappe ultra-rapide (douchette) est interceptée
                const now = performance.now();
                if (now - wedgeLast > 80) { wedgeBuf = ''; }
                wedgeLast = now;
            } else {
                const now = performance.now();
                if (now - wedgeLast > 250) wedgeBuf = ''; // pause humaine → reset
                wedgeLast = now;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                if (wedgeBuf.length >= 4) {
                    e.preventDefault();
                    input.value = wedgeBuf;
                    wedgeBuf = '';
                    scanSubmit();
                }
                return;
            }
            if (e.key.length === 1) wedgeBuf += e.key;
        }, true);
    }

    // Soumet le contenu du champ pour recherche
    function scanSubmit(){
        const input = document.getElementById('scan-mainInput');
        if(!input) return;
        const raw = input.value.trim();
        if(!raw) return;
        // Debounce : éviter double-submit si la douchette envoie Enter + \n
        const now = Date.now();
        if(now - scanLastSearchTs < 150) return;
        scanLastSearchTs = now;

        scanLookupAndDisplay(raw);

        // Vider et refocus pour le prochain scan
        input.value = '';
        // Refocus immédiat (sans attendre le timer)
        setTimeout(() => input.focus(), 10);
    }

    // Cherche un colis et affiche le résultat
    function scanLookupAndDisplay(rawBarcode){
        scanSessionTotal++;
        if(!window.terrainAPI){
            scanShowResult(null, rawBarcode);
            scanSessionMissed++;
            scanUpdateStats();
            return;
        }
        const p = window.terrainAPI.findByBarcode(rawBarcode);
        if(!p){
            scanShowResult(null, rawBarcode);
            scanSessionMissed++;
        } else {
            const info = window.terrainAPI.getTourInfo(p.barcode);
            scanShowResult(p, rawBarcode, info);
            scanSessionFound++;
            scanHistory.unshift({ barcode: p.barcode, found: true, ts: Date.now() });
            if(scanHistory.length > 20) scanHistory.pop();
        }
        scanUpdateStats();
        // Beep audio si trouvé/échec (utile sur smartphone bruyant)
        scanPlayBeep(p ? 'found' : 'missed');
    }

    function scanShowResult(p, rawBarcode, info){
        const container = document.getElementById('scan-result');
        if(!container) return;

        if(!p){
            // Colis NON trouvé
            container.innerHTML = `
                <div class="scan-notfound">
                    <i class="fas fa-times-circle"></i>
                    <div class="scan-notfound-title">Colis introuvable</div>
                    <div class="scan-notfound-bc">${scanEsc(rawBarcode)}</div>
                    <div class="scan-notfound-hint">Vérifiez que le fichier EPOD a bien été importé dans "Optimisation Terrain".</div>
                </div>`;
            return;
        }

        // Colis trouvé : affichage XXL épuré (tracking + tournée + adresse uniquement)
        const adrRue = p.adresse && !/^[*\s]+$/.test(String(p.adresse)) ? p.adresse : '';
        const cpVille = [p.cp, p.ville].filter(x => x && !/^[*\s]+$/.test(String(x))).join(' ');
        const isDelivered = window.terrainAPI.isDelivered(p.barcode);
        const livreurs = window.terrainAPI.getLivreurs();
        const liv = info ? livreurs.find(l => String(l.id) === String(info.tour.livreurId)) : null;
        const livName = liv ? `${liv.prenom || ''} ${liv.nom || ''}`.trim() : '';

        // BLOC 1 : TRACKING (en très gros)
        let html = `<div class="scan-xxl-tracking ${isDelivered ? 'delivered' : 'success'}">
            <div class="scan-xxl-tracking-label">${isDelivered ? 'COLIS DÉJÀ LIVRÉ' : 'COLIS TROUVÉ'}</div>
            <div class="scan-xxl-tracking-bc">${scanEsc(p.barcode)}</div>
        </div>`;

        // BLOC 2 : TOURNÉE (en gros)
        if(info){
            html += `<div class="scan-xxl-tour" style="border-color:${scanEsc(info.tour.color)}">
                <div class="scan-xxl-tour-label"><i class="fas fa-route"></i> TOURNÉE</div>
                <div class="scan-xxl-tour-name" style="color:${scanEsc(info.tour.color)}">${scanEsc(info.tour.name)}</div>
                <div class="scan-xxl-tour-detail">
                    <span class="scan-xxl-pos" style="background:${scanEsc(info.tour.color)}">Arrêt n° ${info.pos} / ${info.total}</span>
                    ${livName ? `<span class="scan-xxl-livreur"><i class="fas fa-user-tag"></i> ${scanEsc(livName)}</span>` : ''}
                </div>
            </div>`;
        } else {
            html += `<div class="scan-xxl-tour scan-xxl-tour-unassigned">
                <div class="scan-xxl-tour-label"><i class="fas fa-exclamation-triangle"></i> TOURNÉE</div>
                <div class="scan-xxl-tour-name">Pas encore assigné</div>
                <div class="scan-xxl-tour-detail">Retournez sur "Optimisation Terrain" pour placer ce colis</div>
            </div>`;
        }

        // BLOC 3 : ADRESSE (en très gros)
        html += `<div class="scan-xxl-address">
            <div class="scan-xxl-address-label"><i class="fas fa-map-marker-alt"></i> ADRESSE DE LIVRAISON</div>
            <div class="scan-xxl-address-rue">${adrRue ? scanEsc(adrRue) : '<span class="scan-xxl-muted">Adresse non renseignée</span>'}</div>
            ${cpVille ? `<div class="scan-xxl-address-cpville">${scanEsc(cpVille)}</div>` : ''}
        </div>

        <div class="scan-result-actions">
            <button class="scan-btn scan-btn-primary" onclick="scanShowOnMap('${escJsAttr(p.barcode)}')"><i class="fas fa-map"></i> Voir sur la carte</button>
            <button class="scan-btn scan-btn-${isDelivered ? 'success is-done' : 'success'}" onclick="scanMarkDelivered('${escJsAttr(p.barcode)}')">
                <i class="fas fa-${isDelivered ? 'undo' : 'check'}"></i> ${isDelivered ? 'Annuler livraison' : 'Marquer comme livré'}
            </button>
        </div>`;

        container.innerHTML = html;
    }

    // Force le focus dans l'input (toutes les 500ms)
    function scanStartFocusGuard(){
        if(scanFocusInterval) return;
        scanFocusInterval = setInterval(() => {
            const tab = document.getElementById('tab-scan');
            if(!tab || !tab.classList.contains('active')) return;
            const input = document.getElementById('scan-mainInput');
            if(!input) return;
            // Ne pas voler le focus à un autre input visible (ex: caméra ouverte avec bouton)
            const active = document.activeElement;
            if(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active !== input){
                return;
            }
            // Ne pas voler le focus si une modale est ouverte
            if(document.querySelector('.terrain-modal-overlay.open')) return;
            // Ne pas voler le focus si la caméra est active (l'user peut interagir avec)
            if(scanCameraActive) return;
            if(document.activeElement !== input){
                input.focus();
            }
        }, 500);
    }
    function scanStopFocusGuard(){
        if(scanFocusInterval){
            clearInterval(scanFocusInterval);
            scanFocusInterval = null;
        }
    }
    function scanRequestFocus(){
        scanStartFocusGuard();
        setTimeout(() => {
            const input = document.getElementById('scan-mainInput');
            if(input) input.focus();
        }, 100);
    }

    function scanUpdateStatus(state){
        const led = document.getElementById('scan-statusLed');
        const text = document.getElementById('scan-statusText');
        if(!led || !text) return;
        if(state === 'listening'){
            led.className = 'scan-status-led active';
            text.textContent = 'Prêt à scanner';
        } else if(state === 'error'){
            led.className = 'scan-status-led error';
            text.textContent = 'Erreur';
        } else {
            led.className = 'scan-status-led';
            text.textContent = 'En attente du focus...';
        }
    }

    function scanUpdateStats(){
        const elTotal = document.getElementById('scan-sessionCount');
        const elFound = document.getElementById('scan-sessionFound');
        const elMissed = document.getElementById('scan-sessionMissed');
        if(elTotal) elTotal.textContent = scanSessionTotal;
        if(elFound) elFound.textContent = scanSessionFound;
        if(elMissed) elMissed.textContent = scanSessionMissed;
    }

    window.scanResetSession = function(){
        if(!confirm('Remettre les compteurs de la session à zéro ?')) return;
        scanSessionTotal = 0;
        scanSessionFound = 0;
        scanSessionMissed = 0;
        scanHistory = [];
        scanUpdateStats();
    };

    window.scanShowOnMap = function(barcode){
        const p = window.terrainAPI && window.terrainAPI.findByBarcode(barcode);
        if(!p) return;
        // Switcher sur l'onglet terrain et zoomer sur le point
        window.switchTab('terrain');
        setTimeout(() => {
            window.terrainAPI.zoomToPoint(p.lat, p.lon, 17);
        }, 300);
    };

    window.scanMarkDelivered = function(barcode){
        if(!window.terrainAPI) return;
        window.terrainAPI.toggleDelivered(barcode);
        // Rafraîchir l'affichage
        const p = window.terrainAPI.findByBarcode(barcode);
        const info = window.terrainAPI.getTourInfo(barcode);
        scanShowResult(p, barcode, info);
    };

    // Petit beep audio (Web Audio API, pas de fichier)
    let scanAudioCtx = null;
    function scanPlayBeep(type){
        try {
            if(!scanAudioCtx){
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if(!Ctx) return;
                scanAudioCtx = new Ctx();
            }
            const osc = scanAudioCtx.createOscillator();
            const gain = scanAudioCtx.createGain();
            osc.connect(gain); gain.connect(scanAudioCtx.destination);
            const now = scanAudioCtx.currentTime;
            if(type === 'found'){
                // 2 beeps aigus rapides
                osc.frequency.setValueAtTime(880, now);
                gain.gain.setValueAtTime(0.18, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
                osc.start(now); osc.stop(now + 0.15);
            } else {
                // 1 beep grave plus long
                osc.frequency.setValueAtTime(220, now);
                gain.gain.setValueAtTime(0.22, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
                osc.start(now); osc.stop(now + 0.4);
            }
        } catch(e){ /* silencieux */ }
    }

    // ═══════════ CAMÉRA OPTIONNELLE (smartphone) ═══════════
    let scanLibLoading = null;
    function scanLoadLib(){
        if(typeof Html5Qrcode !== 'undefined') return Promise.resolve(true);
        if(scanLibLoading) return scanLibLoading;
        scanLibLoading = loadScriptOnce(CONFIG.libs.html5Qrcode, () => typeof Html5Qrcode !== 'undefined')
            .then(() => typeof Html5Qrcode !== 'undefined')
            .catch(() => { scanLibLoading = null; return false; });
        return scanLibLoading;
    }

    window.scanToggleCamera = async function(){
        if(scanCameraActive){
            scanCloseCamera();
            return;
        }
        // Vérifications préalables
        if(!window.isSecureContext){
            alert('La caméra nécessite HTTPS pour fonctionner.\n\nUtilisez la douchette ou tapez le code-barres manuellement.\nProtocole actuel : ' + location.protocol);
            return;
        }
        if(!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)){
            alert('API caméra indisponible sur ce navigateur. Utilisez la douchette ou tapez le code-barres manuellement.');
            return;
        }
        const ok = await scanLoadLib();
        if(!ok){
            alert('Librairie de scan introuvable (problème de connexion ?). Utilisez la douchette ou tapez le code-barres manuellement.');
            return;
        }
        const area = document.getElementById('scan-cameraArea');
        if(!area) return;
        area.style.display = '';
        area.innerHTML = '<div id="scan-cameraInner"></div><button class="scan-btn scan-btn-cam-close" onclick="scanToggleCamera()" title="Fermer la caméra"><i class="fas fa-times"></i></button>';
        document.getElementById('scan-btnCamera')?.classList.add('active');
        try {
            scanCameraInstance = new Html5Qrcode('scan-cameraInner', { verbose: false });
            scanCameraActive = true;
            await scanCameraInstance.start(
                { facingMode: 'environment' },
                {
                    fps: 10,
                    qrbox: function(vw, vh){
                        const w = Math.floor(Math.min(vw, vh) * 0.8);
                        return { width: w, height: Math.floor(w * 0.6) };
                    },
                    aspectRatio: 1.0
                },
                (decodedText) => {
                    // Scan réussi : injecter dans l'input et soumettre
                    const input = document.getElementById('scan-mainInput');
                    if(input){
                        input.value = decodedText;
                        scanSubmit();
                    }
                },
                () => { /* échecs silencieux */ }
            );
        } catch(err){
            console.warn('[Scan] caméra erreur:', err);
            const msg = (err && err.message) || String(err);
            let userMsg = 'Caméra impossible à démarrer.';
            if(/permission|denied|notallowed/i.test(msg)) userMsg = 'Permission caméra refusée. Autorisez la caméra dans les réglages.';
            else if(/notfound/i.test(msg)) userMsg = 'Aucune caméra détectée.';
            else if(/notreadable|aborterror/i.test(msg)) userMsg = 'Caméra utilisée par une autre app.';
            alert(userMsg);
            scanCloseCamera();
        }
    };

    function scanCloseCamera(){
        if(scanCameraInstance){
            try { scanCameraInstance.stop().then(() => { try { scanCameraInstance.clear(); } catch(e){} }); } catch(e){}
            scanCameraInstance = null;
        }
        scanCameraActive = false;
        const area = document.getElementById('scan-cameraArea');
        if(area) area.style.display = 'none';
        document.getElementById('scan-btnCamera')?.classList.remove('active');
        // Remettre le focus dans le champ
        setTimeout(() => {
            const input = document.getElementById('scan-mainInput');
            if(input) input.focus();
        }, 100);
    }

    // Helpers d'échappement
    function scanEsc(s){
        return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    }
    function scanEscAttr(s){ return escJsAttr(s); }
})();
