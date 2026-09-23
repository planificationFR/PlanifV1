(function(){
    'use strict';

    // ═══════════ STATE LOCAL ═══════════
    let terrainPoints = [];          // colis avec GPS valide
    let terrainPending = [];         // colis sans GPS, candidats au géocodage
    let terrainTours = [];           // tournées créées
    let terrainTourId = 0;
    let terrainMap = null;
    let terrainMarkersLayer = null;       // MarkerClusterGroup pour colis non-assignés
    let terrainTourMarkersLayer = null;   // LayerGroup pour marqueurs numérotés des tournées
    let terrainZoneLayer = null;
    let terrainDepotLayer = null;         // Layer pour le marqueur du dépôt
    let terrainEndpointLayer = null;      // Layer pour les marqueurs des points d'arrivée personnalisés
    let terrainWaypointsLayer = null;     // Layer pour les étapes intermédiaires
    let terrainDepot = null;              // { lat, lon, label? } - dépôt global
    let terrainPlacingDepot = false;      // Mode "clic pour placer le dépôt"
    let terrainPlacingEndpointFor = null; // ID de la tournée pour laquelle on place un endPoint
    let terrainPlacingWaypointFor = null; // ID de la tournée pour laquelle on ajoute des waypoints
    let terrainDeliveredSet = new Set();  // codes-barres des colis marqués livrés
    let terrainScanner = null;            // instance html5-qrcode active
    let terrainScannerActive = false;
    let terrainTourLines = {};       // polyligne par tournée
    let terrainInitialized = false;

    // Dessin de zone
    let terrainZoneDrawing = false;
    let terrainZonePoints = [];
    let terrainZoneMarkers = [];
    let terrainZonePolyline = null;
    let terrainZonePolygon = null;
    let terrainZoneCloseHint = null;
    let terrainCapturedPoints = []; // colis capturés par la zone fermée

    // Géocodage BAN
    const terrainGeocodeCache = new Map();
    let terrainGeocodeAbort = false;

    const TOUR_COLORS = [
        '#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899',
        '#14b8a6','#f97316','#06b6d4','#84cc16','#6366f1','#a855f7',
        '#22c55e','#eab308','#0ea5e9','#d946ef'
    ];

    // ═══════════ HOOK SUR switchTab (sans le remplacer) ═══════════
    const _origSwitchTab = window.switchTab;
    window.switchTab = function(tab){
        const result = _origSwitchTab ? _origSwitchTab.apply(this, arguments) : undefined;
        if(tab === 'terrain') terrainInit();
        return result;
    };

    // Rechargement de l'état terrain depuis le stockage (appelé après une
    // synchronisation cloud, une fusion, un autre onglet ou une restauration).
    window.terrainReloadFromStorage = function(){
        if(!terrainInitialized) return;   // la première ouverture lira le stockage
        try {
            terrainRestoreState();
            try {
                const sd = localStorage.getItem('terrain_depot_v1');
                terrainDepot = sd ? JSON.parse(sd) : null;
                terrainDrawDepot();
                terrainUpdateDepotButton();
            } catch(e){}
            try {
                const sde = localStorage.getItem('terrain_delivered_v1');
                terrainDeliveredSet = new Set(sde ? JSON.parse(sde) : []);
            } catch(e){ terrainDeliveredSet = new Set(); }
            terrainPopulateFilters();
            terrainDrawAllPoints();
            terrainEnableButtons();
            terrainRefreshTourList();
            terrainUpdateStats();
        } catch(e){ console.warn('[Terrain] rechargement', e); }
    };

    function terrainInit(){
        if(terrainInitialized){
            // Toujours invalider la taille de la carte (re-affichage onglet)
            setTimeout(() => { if(terrainMap) terrainMap.invalidateSize(); }, 50);
            // Détecter si le localStorage a été modifié par un import : si les compteurs ne matchent plus,
            // on recharge l'état terrain depuis le storage.
            try {
                const rawTours = localStorage.getItem('terrain_tours_v1');
                const rawPoints = localStorage.getItem('terrain_points_v1');
                const storedToursCount = rawTours ? (JSON.parse(rawTours).tours || []).length : 0;
                const storedPointsLen = rawPoints ? JSON.parse(rawPoints).length : 0;
                if(storedToursCount !== terrainTours.length || storedPointsLen !== terrainPoints.length){
                    // Différence détectée → rechargement
                    terrainRestoreState();
                    // Recharger dépôt aussi (au cas où il aurait été modifié par import)
                    try {
                        const sd = localStorage.getItem('terrain_depot_v1');
                        terrainDepot = sd ? JSON.parse(sd) : null;
                        terrainDrawDepot();
                        terrainUpdateDepotButton();
                    } catch(e){}
                    // Et les livrés
                    try {
                        const sde = localStorage.getItem('terrain_delivered_v1');
                        terrainDeliveredSet = new Set(sde ? JSON.parse(sde) : []);
                    } catch(e){ terrainDeliveredSet = new Set(); }
                    terrainPopulateFilters();
                    terrainDrawAllPoints();
                    terrainEnableButtons();
                    if(terrainPoints.length > 0){
                        try {
                            const bounds = L.latLngBounds(terrainPoints.map(p => [p.lat, p.lon]));
                            if(bounds.isValid()) terrainMap.fitBounds(bounds.pad(0.05));
                        } catch(e){}
                    }
                    terrainSetStatus(`<i class="fas fa-sync"></i> Données rechargées depuis le stockage.`, 'success');
                }
            } catch(e){ /* silencieux */ }
            terrainRefreshTourList();
            terrainUpdateStats();
            return;
        }
        terrainInitialized = true;

        // Init carte
        terrainMap = L.map('terrain-map', {
            center: [46.6, 2.5], zoom: 6,
            preferCanvas: true   // Rendu canvas plus rapide pour beaucoup de points
        });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap', maxZoom: 19
        }).addTo(terrainMap);

        // Layer pour les colis non-assignés : layerGroup simple avec CircleMarker en canvas
        // (le clustering est désactivé sur demande utilisateur : affichage direct des points)
        terrainMarkersLayer = L.layerGroup();
        terrainMarkersLayer.addTo(terrainMap);

        // Layer séparé pour les marqueurs numérotés des tournées (divIcon car ils ont un numéro)
        terrainTourMarkersLayer = L.layerGroup().addTo(terrainMap);

        // Layer pour le marqueur du dépôt (au-dessus de tout)
        terrainDepotLayer = L.layerGroup().addTo(terrainMap);

        // Layer pour les marqueurs de point d'arrivée personnalisé (un par tournée concernée)
        terrainEndpointLayer = L.layerGroup().addTo(terrainMap);

        // Layer pour les étapes intermédiaires des tournées
        terrainWaypointsLayer = L.layerGroup().addTo(terrainMap);

        terrainZoneLayer = L.layerGroup().addTo(terrainMap);

        // Charger le dépôt sauvegardé (localStorage)
        try {
            const saved = localStorage.getItem('terrain_depot_v1');
            if(saved){
                const obj = JSON.parse(saved);
                if(obj && isFinite(obj.lat) && isFinite(obj.lon)){
                    terrainDepot = obj;
                    terrainDrawDepot();
                    terrainUpdateDepotButton();
                }
            }
        } catch(e){ console.warn('[Terrain] dépôt sauvegardé illisible', e); }

        // Charger les colis livrés sauvegardés
        try {
            const savedDel = localStorage.getItem('terrain_delivered_v1');
            if(savedDel){
                const arr = JSON.parse(savedDel);
                if(Array.isArray(arr)) terrainDeliveredSet = new Set(arr);
            }
        } catch(e){}

        // Restaurer les tournées et les points importés
        terrainRestoreState();
        if(terrainPoints.length > 0){
            // Recharger la carte avec les points restaurés
            terrainPopulateFilters();
            terrainDrawAllPoints();
            terrainRefreshTourList();
            terrainUpdateStats();
            terrainEnableButtons();
            // Centrer sur les points
            try {
                const bounds = L.latLngBounds(terrainPoints.map(p => [p.lat, p.lon]));
                if(bounds.isValid()) terrainMap.fitBounds(bounds.pad(0.05));
            } catch(e){}
            const parts = [`<b>${terrainPoints.length.toLocaleString()}</b> colis restaurés`];
            if(terrainTours.length) parts.push(`<b>${terrainTours.length}</b> tournée(s) restaurée(s)`);
            terrainSetStatus(`<i class="fas fa-check-circle"></i> ${parts.join(' · ')} depuis la dernière session.`, 'success');
        }

        setTimeout(() => terrainMap.invalidateSize(), 100);

        // Bind import
        const dz = document.getElementById('terrain-dropZone');
        const fi = document.getElementById('terrain-fileInput');
        dz.addEventListener('click', () => fi.click());
        fi.addEventListener('change', e => { if(e.target.files[0]) terrainHandleFile(e.target.files[0]); });
        ['dragover','dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
        ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
        dz.addEventListener('drop', e => { if(e.dataTransfer.files[0]) terrainHandleFile(e.dataTransfer.files[0]); });

        // ─── Recherche (debounced) ───
        const searchInput = document.getElementById('terrain-search');
        const searchBox = searchInput.parentElement;
        let searchTimer = null;
        searchInput.addEventListener('input', () => {
            searchBox.classList.toggle('has-text', searchInput.value.length > 0);
            clearTimeout(searchTimer);
            searchTimer = setTimeout(terrainApplyFilters, 200);
        });
        searchInput.addEventListener('keydown', e => {
            if(e.key === 'Enter'){ e.preventDefault(); terrainSearchZoom(); }
            if(e.key === 'Escape'){ terrainClearSearch(); }
        });

        // Échap global : annuler placement endpoint, dépôt ou waypoint
        document.addEventListener('keydown', e => {
            if(e.key !== 'Escape') return;
            if(terrainPlacingWaypointFor != null){
                window.terrainStopAddWaypoint();
            } else if(terrainPlacingEndpointFor != null){
                terrainStopPlacingEndpoint();
                terrainSetStatus('Placement annulé.', 'info');
            } else if(terrainPlacingDepot){
                terrainStopPlacingDepot();
                terrainSetStatus('Placement du dépôt annulé.', 'info');
            }
        });
    }

    // ═══════════ RECHERCHE ET FILTRES ═══════════

    // Renvoie la liste des points visibles selon recherche + filtres actifs
    function terrainGetFilteredPoints(){
        const query = (document.getElementById('terrain-search')?.value || '').trim().toLowerCase();
        const fVille  = document.getElementById('terrain-filterVille')?.value || '';
        const fCP     = document.getElementById('terrain-filterCP')?.value || '';
        const fStatus = document.getElementById('terrain-filterStatus')?.value || '';
        const fTour   = document.getElementById('terrain-filterTour')?.value || '';

        const tourOf = new Map();
        terrainTours.forEach(t => t.barcodes.forEach(bc => tourOf.set(bc, String(t.id))));

        return terrainPoints.filter(p => {
            if(fVille  && (p.ville || '').toLowerCase() !== fVille.toLowerCase()) return false;
            if(fCP     && String(p.cp || '') !== String(fCP)) return false;
            if(fStatus && (p.status || '') !== fStatus) return false;
            if(fTour === '__none__'){ if(tourOf.has(p.barcode)) return false; }
            else if(fTour){ if(tourOf.get(p.barcode) !== fTour) return false; }
            if(query){
                const hay = [p.barcode, p.ville, p.cp, p.adresse, p.nom, p.tel, p.status]
                    .filter(Boolean).join(' ').toLowerCase();
                if(!hay.includes(query)) return false;
            }
            return true;
        });
    }

    // Peuple les <select> de filtres après import
    function terrainPopulateFilters(){
        // Compter les occurrences (pour tri par fréquence)
        const villes = new Map(), cps = new Map(), statuses = new Map();
        terrainPoints.forEach(p => {
            if(p.ville) villes.set(p.ville, (villes.get(p.ville) || 0) + 1);
            if(p.cp)    cps.set(String(p.cp), (cps.get(String(p.cp)) || 0) + 1);
            if(p.status) statuses.set(p.status, (statuses.get(p.status) || 0) + 1);
        });
        // Si trop de valeurs (>500), ne garder que celles avec ≥2 colis pour rester ergonomique
        const filterRare = (map) => {
            if(map.size <= 500) return [...map.entries()];
            return [...map.entries()].filter(([, n]) => n >= 2);
        };
        const villesArr = filterRare(villes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const cpsArr    = filterRare(cps).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const stArr     = [...statuses.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

        const fmtOpt = ([v, n]) => `<option value="${terrainEscAttr(v)}">${terrainEscHTML(v)} (${n})</option>`;

        const selVille = document.getElementById('terrain-filterVille');
        const selCP    = document.getElementById('terrain-filterCP');
        const selSt    = document.getElementById('terrain-filterStatus');
        if(selVille){
            const note = villes.size > villesArr.length ? ` — ${villesArr.length}/${villes.size} affichées` : '';
            selVille.innerHTML = `<option value="">Toutes villes (${villes.size})${note}</option>` + villesArr.map(fmtOpt).join('');
        }
        if(selCP){
            const note = cps.size > cpsArr.length ? ` — ${cpsArr.length}/${cps.size} affichés` : '';
            selCP.innerHTML = `<option value="">Tous CP (${cps.size})${note}</option>` + cpsArr.map(fmtOpt).join('');
        }
        if(selSt){
            selSt.innerHTML = `<option value="">Tous statuts (${statuses.size})</option>` + stArr.map(fmtOpt).join('');
        }
        terrainPopulateTourFilter();
    }
    function terrainPopulateTourFilter(){
        const sel = document.getElementById('terrain-filterTour');
        if(!sel) return;
        const current = sel.value;
        sel.innerHTML = '<option value="">Toutes tournées</option><option value="__none__">Non assignés</option>' +
            terrainTours.map(t => `<option value="${terrainEscHTML(t.id)}">${terrainEscHTML(t.name)}</option>`).join('');
        sel.value = current;
    }
    function terrainEscHTML(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
    function terrainEscAttr(s){ return terrainEscHTML(s); }

    // Applique les filtres : redessine les marqueurs et met à jour le compteur
    window.terrainApplyFilters = function(){
        if(!terrainInitialized) return;
        terrainDrawAllPoints();   // redraw fera de lui-même le filtrage
        // Mettre en évidence les selects actifs
        ['terrain-filterVille','terrain-filterCP','terrain-filterStatus','terrain-filterTour'].forEach(id => {
            const el = document.getElementById(id);
            if(el) el.classList.toggle('active', !!el.value);
        });
        // Si une recherche + une seule ville match, on zoome dessus
        const search = (document.getElementById('terrain-search')?.value || '').trim();
        if(search.length >= 3){
            const visible = terrainGetFilteredPoints();
            if(visible.length > 0 && visible.length < terrainPoints.length){
                terrainMap.fitBounds(L.latLngBounds(visible.map(p => [p.lat, p.lon])).pad(0.15));
            }
        }
    };

    // Bouton Entrée dans la recherche : zoome direct sur les résultats
    function terrainSearchZoom(){
        const visible = terrainGetFilteredPoints();
        if(visible.length > 0){
            terrainMap.fitBounds(L.latLngBounds(visible.map(p => [p.lat, p.lon])).pad(0.15));
        }
    }

    window.terrainClearSearch = function(){
        const input = document.getElementById('terrain-search');
        if(input){ input.value = ''; input.parentElement.classList.remove('has-text'); }
        terrainApplyFilters();
    };

    window.terrainResetFilters = function(){
        ['terrain-filterVille','terrain-filterCP','terrain-filterStatus','terrain-filterTour'].forEach(id => {
            const el = document.getElementById(id); if(el){ el.value = ''; el.classList.remove('active'); }
        });
        terrainClearSearch();
    };

    // ═══════════ DÉPÔT (POINT DE DÉPART) ═══════════
    function terrainSaveDepot(){
        try {
            if(terrainDepot) localStorage.setItem('terrain_depot_v1', JSON.stringify(terrainDepot));
            else             localStorage.removeItem('terrain_depot_v1');
        } catch(e){}
    }

    // ═══════════ SAUVEGARDE / RESTAURATION ÉTAT COMPLET ═══════════
    // Sauvegarde l'état des tournées et des colis chargés dans localStorage.
    // Appelée à chaque modification importante (création/édition/suppression).
    // Les fichiers EPOD peuvent peser plusieurs Mo : on tente d'enregistrer,
    // si le quota est dépassé on garde au moins les tournées.
    function terrainSaveState(){
        try {
            // Tournées : structure légère, toujours sauvegarder
            const toursToSave = terrainTours.map(t => ({
                id: t.id, name: t.name, color: t.color,
                barcodes: t.barcodes, order: t.order, livreurId: t.livreurId,
                endMode: t.endMode, endPoint: t.endPoint,
                waypoints: t.waypoints || []
            }));
            localStorage.setItem('terrain_tours_v1', JSON.stringify({
                tourId: terrainTourId,
                tours: toursToSave
            }));
            // Pousser aussi vers le cloud (debounced) si l'utilisateur est connecté
            if (typeof cloudScheduleSave === 'function') cloudScheduleSave();
        } catch(e){ console.warn('[Terrain] save tours failed', e); }

        try {
            // Points : potentiellement gros. On essaye d'abord, si quota dépassé on abandonne.
            const pointsToSave = terrainPoints.map(p => ({
                barcode: p.barcode, lat: p.lat, lon: p.lon,
                nom: p.nom, tel: p.tel, email: p.email,
                adresse: p.adresse, cp: p.cp, ville: p.ville,
                status: p.status
            }));
            localStorage.setItem('terrain_points_v1', JSON.stringify(pointsToSave));
            localStorage.setItem('terrain_points_savedAt', String(Date.now()));
            // OK : si on avait eu un warning auparavant, l'effacer
            terrainPointsStorageWarned = false;
        } catch(e){
            // Quota dépassé probablement : on supprime les points pour ne pas bloquer
            try { localStorage.removeItem('terrain_points_v1'); } catch(e2){}
            console.warn('[Terrain] save points failed (quota?). Les points ne seront pas restaurés au prochain démarrage.', e);
            if(!terrainPointsStorageWarned){
                terrainPointsStorageWarned = true;
                terrainSetStatus('<i class="fas fa-exclamation-triangle"></i> <b>Trop de colis pour sauvegarder automatiquement</b> (limite navigateur ~5 Mo). Les tournées sont sauvegardées, mais les colis seront perdus à la prochaine ouverture. Utilisez "Exporter JSON" pour sauvegarder manuellement.', 'error');
            }
        }
    }
    let terrainPointsStorageWarned = false;

    // Restaure les tournées et les colis depuis localStorage (au démarrage)
    function terrainRestoreState(){
        try {
            const rawTours = localStorage.getItem('terrain_tours_v1');
            if(rawTours){
                const obj = JSON.parse(rawTours);
                if(obj && Array.isArray(obj.tours)){
                    terrainTours = obj.tours;
                    if(typeof obj.tourId === 'number') terrainTourId = obj.tourId;
                }
            }
        } catch(e){ console.warn('[Terrain] restore tours failed', e); }

        try {
            const rawPoints = localStorage.getItem('terrain_points_v1');
            if(rawPoints){
                const arr = JSON.parse(rawPoints);
                if(Array.isArray(arr) && arr.length > 0){
                    terrainPoints = arr;
                }
            }
        } catch(e){ console.warn('[Terrain] restore points failed', e); }
    }

    function terrainDrawDepot(){
        if(!terrainDepotLayer) return;
        terrainDepotLayer.clearLayers();
        if(!terrainDepot) return;
        const icon = L.divIcon({
            className: '',
            html: '<div class="terrain-depot-icon"><i class="fas fa-warehouse"></i></div>',
            iconSize: [36, 36],
            iconAnchor: [18, 36],   // pointe basse du marqueur en goutte
            popupAnchor: [0, -32]
        });
        const m = L.marker([terrainDepot.lat, terrainDepot.lon], { icon, zIndexOffset: 1000 });
        m.bindPopup(`<div style="font-family:sans-serif;font-size:13px;min-width:160px">
            <b style="color:#16a34a"><i class="fas fa-warehouse"></i> Dépôt</b><br>
            ${terrainDepot.label ? terrainEscHTML(terrainDepot.label) + '<br>' : ''}
            <small style="color:#64748b">${terrainDepot.lat.toFixed(5)}, ${terrainDepot.lon.toFixed(5)}</small><br>
            <button onclick="terrainClearDepot()" style="margin-top:6px;padding:3px 8px;background:#fee2e2;border:1px solid #fecaca;color:#dc2626;border-radius:4px;cursor:pointer;font-size:11px">
                <i class="fas fa-trash"></i> Supprimer le dépôt
            </button>
        </div>`);
        m.addTo(terrainDepotLayer);
    }

    // Dessine les points d'arrivée personnalisés (un par tournée en mode 'custom')
    function terrainDrawEndpoints(){
        if(!terrainEndpointLayer) return;
        terrainEndpointLayer.clearLayers();
        terrainTours.forEach(t => {
            if(t.endMode !== 'custom' || !t.endPoint) return;
            const icon = L.divIcon({
                className: '',
                html: `<div class="terrain-endpoint-icon" style="background:linear-gradient(135deg, ${terrainEscHTML(t.color)}, ${terrainEscHTML(t.color)})"><i class="fas fa-flag-checkered"></i></div>`,
                iconSize: [30, 30],
                iconAnchor: [15, 30],
                popupAnchor: [0, -28]
            });
            const m = L.marker([t.endPoint.lat, t.endPoint.lon], { icon, zIndexOffset: 800 });
            m.bindPopup(`<div style="font-family:sans-serif;font-size:13px;min-width:160px">
                <b style="color:${terrainEscHTML(t.color)}"><i class="fas fa-flag-checkered"></i> Arrivée — ${terrainEscHTML(t.name)}</b><br>
                <small style="color:#64748b">${t.endPoint.lat.toFixed(5)}, ${t.endPoint.lon.toFixed(5)}</small><br>
                <button onclick="terrainSetEndMode(${Number(t.id)}, 'depot')" style="margin-top:6px;padding:3px 8px;background:#f1f5f9;border:1px solid #cbd5e1;color:#1e293b;border-radius:4px;cursor:pointer;font-size:11px">
                    <i class="fas fa-times"></i> Retirer ce point d'arrivée
                </button>
            </div>`);
            m.addTo(terrainEndpointLayer);
        });
    }

    function terrainUpdateDepotButton(){
        const btn = document.getElementById('terrain-btnDepot');
        const btnClear = document.getElementById('terrain-btnDepotClear');
        const label = document.getElementById('terrain-depotLabel');
        if(!btn) return;
        if(terrainDepot){
            btn.classList.add('has-depot');
            if(label) label.textContent = 'Dépôt placé';
            if(btnClear) btnClear.style.display = '';
        } else {
            btn.classList.remove('has-depot');
            if(label) label.textContent = 'Définir dépôt';
            if(btnClear) btnClear.style.display = 'none';
        }
    }

    window.terrainPlaceDepot = function(){
        // Si on est déjà en mode placement, annuler
        if(terrainPlacingDepot){
            terrainStopPlacingDepot();
            terrainSetStatus('Placement du dépôt annulé.', 'info');
            return;
        }
        // Sortir du mode dessin de zone si actif
        if(terrainZoneDrawing){
            terrainResetZone(false);
        }
        terrainPlacingDepot = true;
        const mapEl = document.getElementById('terrain-map');
        if(mapEl) mapEl.classList.add('placing-depot');
        document.getElementById('terrain-btnDepot').classList.add('placing');
        terrainMap.on('click', terrainOnDepotClick);
        terrainSetStatus('<i class="fas fa-warehouse"></i> Cliquez sur la carte pour placer le dépôt. Cliquez à nouveau sur "Définir dépôt" pour annuler.', 'info');
    };

    function terrainOnDepotClick(e){
        if(!terrainPlacingDepot) return;
        terrainDepot = { lat: e.latlng.lat, lon: e.latlng.lng };
        terrainStopPlacingDepot();
        terrainDrawDepot();
        terrainUpdateDepotButton();
        terrainSaveDepot();
        // Ré-optimiser automatiquement les tournées existantes (puisque le départ change)
        if(terrainTours.length){
            terrainTours.forEach(t => { t.order = terrainOptimizeBarcodes(t.barcodes, t); });
            terrainDrawAllPoints();
            terrainRefreshTourList();
            terrainUpdateStats();
            terrainSetStatus(`Dépôt placé. <b>${terrainTours.length}</b> tournée(s) ré-optimisée(s).`, 'success');
        } else {
            terrainSetStatus(`<i class="fas fa-check-circle"></i> Dépôt placé. Les futures tournées partiront de ce point.`, 'success');
        }
    }

    function terrainStopPlacingDepot(){
        terrainPlacingDepot = false;
        const mapEl = document.getElementById('terrain-map');
        if(mapEl) mapEl.classList.remove('placing-depot');
        document.getElementById('terrain-btnDepot').classList.remove('placing');
        try { terrainMap.off('click', terrainOnDepotClick); } catch(e){}
    }

    window.terrainClearDepot = function(){
        if(!terrainDepot) return;
        if(!confirm('Supprimer le dépôt ? Les tournées qui finissaient au dépôt seront mises en "Aucun retour".')) return;
        terrainDepot = null;
        terrainDrawDepot();
        terrainUpdateDepotButton();
        terrainSaveDepot();
        terrainMap.closePopup();
        // Basculer les tournées qui dépendaient du dépôt
        terrainTours.forEach(t => {
            if(t.endMode === 'depot') t.endMode = 'none';
        });
        if(terrainTours.length){
            terrainTours.forEach(t => { t.order = terrainOptimizeBarcodes(t.barcodes, t); });
            terrainDrawAllPoints();
            terrainRefreshTourList();
            terrainUpdateStats();
        }
        terrainSetStatus('Dépôt supprimé.', 'info');
    };

    // ═══════════ TOGGLE SIDEBAR ═══════════
    window.terrainToggleSidebar = function(){
        const layout = document.getElementById('terrain-layout');
        if(!layout) return;
        layout.classList.toggle('sidebar-collapsed');
        // Invalider la taille de la carte après l'animation pour qu'elle s'étende
        setTimeout(() => { if(terrainMap) terrainMap.invalidateSize(); }, 280);
    }

    // ═══════════ UTILS ═══════════
    function terrainSetStatus(msg, type){
        const el = document.getElementById('terrain-status');
        if(!el) return;
        el.className = 'terrain-status-inline' + (type ? ' ' + type : '');
        el.innerHTML = msg;
    }
    function terrainCellVal(sheet, r, c){
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if(!cell) return '';
        return String(cell.v == null ? '' : cell.v).trim();
    }
    function terrainNorm(s){
        return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
    }
    function terrainFindHeader(headers, candidates){
        const H = headers.map(terrainNorm);
        for(const c of candidates){
            const n = terrainNorm(c);
            const i = H.findIndex(h => h === n);
            if(i >= 0) return i;
        }
        for(const c of candidates){
            const n = terrainNorm(c);
            const i = H.findIndex(h => h.includes(n));
            if(i >= 0) return i;
        }
        return -1;
    }
    function terrainEnableButtons(){
        const has = terrainPoints.length > 0;
        document.getElementById('terrain-btnStartZone').disabled = !has;
        document.getElementById('terrain-btnPropose').disabled = !has;
        document.getElementById('terrain-btnOptAll').disabled = terrainTours.length === 0;
        document.getElementById('terrain-btnExport').disabled = terrainTours.length === 0;
        document.getElementById('terrain-btnReset').disabled = !has && terrainTours.length === 0;
    }

    // ═══════════ IMPORT FICHIER ═══════════

    // ── v45 : reconnaissance des colonnes par leur CONTENU ──
    // Les exports EPOD traduits automatiquement donnent parfois des noms de
    // colonnes trompeurs : la latitude s'appelle « Dimension » dans l'export
    // français EPOD_TASK_LIST_V2. Se fier au seul intitulé ne suffit donc pas.
    // On vérifie ce que la colonne contient réellement avant de l'accepter,
    // et à défaut d'intitulé reconnu on cherche la paire de colonnes qui se
    // comporte comme des coordonnées.

    function terrainEchantillon(sheet, range, col, max){
        const vals = [];
        const fin = Math.min(range.e.r, range.s.r + (max || 60));
        for(let r = range.s.r + 1; r <= fin; r++){
            const v = terrainCellVal(sheet, r, col);
            if(v !== '') vals.push(v);
        }
        return vals;
    }

    // Une colonne est-elle plausible comme latitude / longitude ?
    // On exige des nombres décimaux dans les bornes, et au moins un peu de
    // variation : une colonne de poids ou de largeur ne passe pas ce test.
    function terrainEstColonneCoord(sheet, range, col, borne){
        if(col < 0) return false;
        const vals = terrainEchantillon(sheet, range, col, 60);
        if(vals.length < 3) return false;
        let ok = 0, decimaux = 0;
        const nums = [];
        for(const v of vals){
            const n = parseFloat(String(v).replace(',', '.'));
            if(!isFinite(n)) continue;
            if(Math.abs(n) > borne) return false;      // hors bornes → ce n'est pas ça
            ok++; nums.push(n);
            if(Math.abs(n % 1) > 1e-6) decimaux++;
        }
        if(ok < vals.length * 0.8) return false;        // trop de valeurs non numériques
        if(decimaux < ok * 0.8) return false;           // des entiers : poids, quantité…
        const min = Math.min(...nums), max = Math.max(...nums);
        return (max - min) > 1e-4;                      // une constante n'est pas une coordonnée
    }

    // Dernier recours : trouver la paire (lat, lon) en lisant les données.
    // On privilégie les colonnes voisines, comme dans tous les exports connus.
    function terrainDevinerColonnesGPS(sheet, range, headers){
        const lats = [], lons = [];
        for(let c = range.s.c; c <= range.e.c; c++){
            if(terrainEstColonneCoord(sheet, range, c, 90)) lats.push(c);
            if(terrainEstColonneCoord(sheet, range, c, 180)) lons.push(c);
        }
        for(const la of lats){
            for(const lo of lons){
                if(la === lo) continue;
                if(Math.abs(la - lo) !== 1) continue;   // colonnes adjacentes
                return { lat: la, lon: lo };
            }
        }
        // Sinon, première combinaison plausible
        for(const la of lats) for(const lo of lons) if(la !== lo) return { lat: la, lon: lo };
        return null;
    }

    // Parse un GPS combiné "lat,lon" ou "lat;lon" ou "lat lon"
    function terrainParseLatLon(s){
        if(s == null || s === '') return null;
        const txt = String(s).trim().replace(/[;|]/g, ',').replace(/[()[\]]/g, '');
        const parts = txt.split(/[,\s]+/).filter(Boolean);
        if(parts.length < 2) return null;
        const a = parseFloat(parts[0].replace(',', '.'));
        const b = parseFloat(parts[1].replace(',', '.'));
        if(!isFinite(a) || !isFinite(b)) return null;
        if(Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b };
        if(Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lon: a };
        return null;
    }

    async function terrainHandleFile(file){
        try {
            terrainSetStatus('<i class="fas fa-spinner fa-spin"></i> Lecture du fichier...', 'info');
            // Yield UI pour laisser le navigateur respirer
            await new Promise(r => setTimeout(r, 30));

            const buf = await file.arrayBuffer();
            terrainSetStatus('<i class="fas fa-spinner fa-spin"></i> Décompression XLSX en cours...', 'info');
            await new Promise(r => setTimeout(r, 30));
            await loadXLSXLib();

            const wb = XLSX.read(buf, { type:'array' });
            const sheetName = wb.SheetNames.find(n => /parcel|task|colis/i.test(n)) || wb.SheetNames[0];
            const sheet = wb.Sheets[sheetName];
            const range = XLSX.utils.decode_range(sheet['!ref']);
            const totalRows = range.e.r - range.s.r;

            // Lire en-têtes
            const headers = [];
            for(let c = range.s.c; c <= range.e.c; c++) headers.push(terrainCellVal(sheet, range.s.r, c));

            // Détection ÉTENDUE des colonnes (compatible plusieurs formats EPOD/PARCEL_LIST)
            // Pour adresse/ville/CP/tel : on cherche les DEUX variantes (Receiver's = original, Modified = corrigé)
            // et on prendra le Modified si non-vide, sinon le Receiver's à la lecture de chaque ligne
            // v45 — les libellés exacts de l'export FR EPOD_TASK_LIST_V2 sont placés
            // en TÊTE de chaque liste. terrainFindHeader teste toutes les
            // correspondances exactes avant les correspondances partielles, ce qui
            // évite les faux positifs du type « City » → « OOH City » ou
            // « nom » → « Nom du vendeur ».
            const idx = {
                bc:    terrainFindHeader(headers, ['Numéro de la lettre', 'Tracking No', 'Waybill Number', 'LP No', 'LP Non.', 'barcode', 'tracking', 'code-barres']),
                // Format GPS COMBINÉ "lat,lon" (priorité)
                gps:   terrainFindHeader(headers, ['Receiver to (Latitude,Longitude)', 'Receiver to Latitude Longitude', 'GPS', 'coords', 'latlon', 'lat,lon']),
                // Format GPS SÉPARÉ (différent de la colonne combinée)
                lat:   -1,
                lon:   -1,
                // Adresse - originale en priorité, Modified en fallback
                adrR:  terrainFindHeader(headers, ['Adresse détaillée', 'Adresse', 'Address', "Receiver's Detail Address", "Detailed address", "Delivery address"]),
                adrM:  terrainFindHeader(headers, ["Modified Detail Address", "OOH Detail Addr"]),
                villeR:terrainFindHeader(headers, ['La ville de destination', 'Ville de destination', 'Destination City', "Receiver's City", "The destination city", "Ville", "City"]),
                villeM:terrainFindHeader(headers, ["Modified City"]),
                cpR:   terrainFindHeader(headers, ['Code postal', 'Code postal de destination', 'Destination Zip Code', "Receiver's Zip Code", "Zip Code", "destinationZipCode", "Postcode"]),
                cpM:   terrainFindHeader(headers, ["Modified Zip Code"]),
                telR:  terrainFindHeader(headers, ['Téléphone de contact', "Receiver's Phone Number", "Receiver's Contact Number", "Contact Phone", "Phone"]),
                telM:  terrainFindHeader(headers, ["Modified Phone Number"]),
                emailR:terrainFindHeader(headers, ['Courrier', 'E-mail de contact', 'Contact Email', "Receiver's Email", "Receiver's Email Address", "Email"]),
                emailM:terrainFindHeader(headers, ["Modified Email"]),
                nom:   terrainFindHeader(headers, ['Nom du contact', "Receiver's Name", "Contact Name", "name"]),
                stat:  terrainFindHeader(headers, ['Statut', 'Order Status', 'Task Status', 'status'])
            };
            // Helper : valeur Modified non-vide, sinon Receiver's
            const valModOrReceiver = (sheet, r, idxM, idxR) => {
                if(idxM >= 0){
                    const v = terrainCellVal(sheet, r, idxM);
                    if(v && v !== 'nan') return v;
                }
                if(idxR >= 0) return terrainCellVal(sheet, r, idxR);
                return '';
            };
            // ── Résolution des colonnes lat / lon séparées ──
            // « Dimension » est le nom que porte la latitude dans l'export français
            // EPOD_TASK_LIST_V2 (traduction automatique). On l'accepte, mais on
            // vérifie systématiquement le contenu : un fichier où « Dimension »
            // désignerait vraiment une dimension de colis serait rejeté par le test.
            const latCandidates = ['Dimension', 'Receiver to Latitude', 'Latitude', 'Lat'];
            const lonCandidates = ['Longitude', 'Receiver to Longitude', 'Lon', 'lng'];
            let latIdx = terrainFindHeader(headers, latCandidates);
            let lonIdx = terrainFindHeader(headers, lonCandidates);
            if(latIdx === idx.gps) latIdx = -1;
            if(lonIdx === idx.gps) lonIdx = -1;

            // Le nom ne suffit pas : la colonne doit contenir de vraies coordonnées.
            let latOk = terrainEstColonneCoord(sheet, range, latIdx, 90);
            let lonOk = terrainEstColonneCoord(sheet, range, lonIdx, 180);

            // Certains exports répètent la paire (position prévue puis position
            // réelle). Si la colonne trouvée est vide, on essaie la suivante
            // portant le même intitulé.
            const memeNom = (i, cands) => {
                if(i < 0) return [];
                const cible = terrainNorm(headers[i]);
                const out = [];
                headers.forEach((h, k) => { if(k !== i && terrainNorm(h) === cible) out.push(k); });
                return out;
            };
            if(!latOk) for(const k of memeNom(latIdx, latCandidates)){
                if(terrainEstColonneCoord(sheet, range, k, 90)){ latIdx = k; latOk = true; break; }
            }
            if(!lonOk) for(const k of memeNom(lonIdx, lonCandidates)){
                if(terrainEstColonneCoord(sheet, range, k, 180)){ lonIdx = k; lonOk = true; break; }
            }

            if(latOk) idx.lat = latIdx;
            if(lonOk) idx.lon = lonIdx;

            // Dernier recours : aucune colonne reconnue par son nom → on cherche
            // dans les données une paire qui se comporte comme des coordonnées.
            let gpsDevine = false;
            if(idx.gps < 0 && (idx.lat < 0 || idx.lon < 0)){
                const devine = terrainDevinerColonnesGPS(sheet, range, headers);
                if(devine){ idx.lat = devine.lat; idx.lon = devine.lon; gpsDevine = true; }
            }

            // Colonnes GPS secondaires : utilisées ligne par ligne quand la paire
            // principale est vide pour un colis donné.
            idx.lat2 = -1; idx.lon2 = -1;
            for(const k of memeNom(idx.lat, latCandidates)) if(terrainEstColonneCoord(sheet, range, k, 90)){ idx.lat2 = k; break; }
            for(const k of memeNom(idx.lon, lonCandidates)) if(terrainEstColonneCoord(sheet, range, k, 180)){ idx.lon2 = k; break; }

            console.log('[Terrain] Colonnes détectées:', idx, 'parmi', headers.length, 'en-têtes',
                        gpsDevine ? '(GPS déduit du contenu)' : '');

            // VALIDATION : on doit pouvoir lire un GPS (combiné ou séparé)
            if(idx.gps < 0 && (idx.lat < 0 || idx.lon < 0)){
                const apercu = headers.map((h, i) => `${i}: ${h}`).slice(0, 40).join(' · ');
                terrainSetStatus(`<i class="fas fa-times-circle"></i> <b>Aucune coordonnée GPS exploitable dans ce fichier.</b><br>
                    Le module accepte : une colonne combinée « lat,lon », deux colonnes <i>Latitude</i> / <i>Longitude</i>,
                    ou l'export EPOD français où la latitude s'intitule <i>Dimension</i>.
                    Aucune colonne du fichier ne contient de coordonnées décimales exploitables.
                    <br><br><small>Colonnes lues (${headers.length}) : ${terrainEscHTML(apercu)}${headers.length > 40 ? '…' : ''}</small>`, 'error');
                return;
            }

            terrainSetStatus(`<i class="fas fa-spinner fa-spin"></i> Lecture des ${totalRows} colis (0 %)...`, 'info');
            await new Promise(r => setTimeout(r, 30));

            const pts = [];
            const pending = [];
            const seen = new Set();
            let invalidGps = 0;
            let duplicates = 0;

            // ─── TRAITEMENT PAR CHUNKS pour ne pas bloquer le navigateur ───
            const CHUNK_SIZE = 1000;
            for(let chunkStart = range.s.r + 1; chunkStart <= range.e.r; chunkStart += CHUNK_SIZE){
                const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, range.e.r);
                for(let r = chunkStart; r <= chunkEnd; r++){
                    const bc = idx.bc >= 0 ? terrainCellVal(sheet, r, idx.bc) : terrainCellVal(sheet, r, 0);
                    if(!bc) continue;
                    if(seen.has(bc)){ duplicates++; continue; }
                    seen.add(bc);

                    // GPS : essayer en priorité le format combiné, puis séparé
                    let lat = null, lon = null;
                    if(idx.gps >= 0){
                        const ll = terrainParseLatLon(terrainCellVal(sheet, r, idx.gps));
                        if(ll){ lat = ll.lat; lon = ll.lon; }
                    }
                    const lireCoord = (cLat, cLon) => {
                        if(cLat < 0 || cLon < 0) return null;
                        const la = parseFloat(String(terrainCellVal(sheet, r, cLat)).replace(',', '.'));
                        const lo = parseFloat(String(terrainCellVal(sheet, r, cLon)).replace(',', '.'));
                        if(!isFinite(la) || !isFinite(lo)) return null;
                        if(Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
                        if(la === 0 && lo === 0) return null;   // 0,0 = coordonnée absente
                        return { la, lo };
                    };
                    if(lat == null){
                        // paire principale, puis paire secondaire si celle-ci est vide
                        const c = lireCoord(idx.lat, idx.lon) || lireCoord(idx.lat2, idx.lon2);
                        if(c){ lat = c.la; lon = c.lo; }
                    }

                    const p = {
                        barcode: bc,
                        lat, lon,
                        adresse: valModOrReceiver(sheet, r, idx.adrM, idx.adrR),
                        ville:   valModOrReceiver(sheet, r, idx.villeM, idx.villeR),
                        cp:      valModOrReceiver(sheet, r, idx.cpM, idx.cpR).replace(/\.0+$/, ''),
                        nom:     idx.nom >= 0 ? terrainCellVal(sheet, r, idx.nom) : '',
                        tel:     valModOrReceiver(sheet, r, idx.telM, idx.telR),
                        email:   valModOrReceiver(sheet, r, idx.emailM, idx.emailR),
                        status:  idx.stat >= 0 ? terrainCellVal(sheet, r, idx.stat) : ''
                    };
                    if(lat == null){
                        if(p.adresse || p.ville || p.cp) pending.push(p);
                        else invalidGps++;
                    } else {
                        pts.push(p);
                    }
                }
                // Progression + yield (laisser le navigateur respirer)
                const done = chunkEnd - range.s.r;
                const pct = Math.round(done / totalRows * 100);
                terrainSetStatus(`<i class="fas fa-spinner fa-spin"></i> Lecture en cours : <b>${done.toLocaleString()}</b> / ${totalRows.toLocaleString()} (${pct} %)`, 'info');
                await new Promise(r => setTimeout(r, 0));
            }

            terrainPoints = pts;
            terrainPending = pending;

            // Reset zones et tournées (nouveau dataset)
            terrainTours = [];
            terrainTourId = 0;
            terrainResetZone(false);

            terrainSetStatus(`<i class="fas fa-spinner fa-spin"></i> Affichage de ${terrainPoints.length.toLocaleString()} colis sur la carte...`, 'info');
            await new Promise(r => setTimeout(r, 30));

            terrainDrawAllPoints();

            if(terrainPoints.length){
                terrainMap.fitBounds(L.latLngBounds(terrainPoints.map(p => [p.lat, p.lon])).pad(0.05));
            }

            document.getElementById('terrain-dropLabel').innerHTML =
                `${terrainPoints.length.toLocaleString()} colis`;
            const parts = [`<b>${terrainPoints.length.toLocaleString()}</b> colis affichés`];
            if(terrainPending.length) parts.push(`<b style="color:var(--warning,#f59e0b)">${terrainPending.length}</b> sans GPS`);
            if(duplicates)    parts.push(`${duplicates} doublons ignorés`);
            if(invalidGps)    parts.push(`${invalidGps} sans données exploitables`);
            terrainSetStatus(`<i class="fas fa-check-circle"></i> ${parts.join(' · ')}`, 'success');

            // Peupler les dropdowns de filtres avec les valeurs trouvées
            terrainPopulateFilters();

            // Bouton géocodage si nécessaire
            document.getElementById('terrain-btnGeocode').style.display = terrainPending.length ? '' : 'none';

            terrainEnableButtons();
            terrainRefreshTourList();
            terrainUpdateStats();
        } catch(err){
            console.error(err);
            terrainSetStatus(`<i class="fas fa-times-circle"></i> Erreur : ${terrainEscHTML(err.message)}`, 'error');
        }
    }

    // ═══════════ AFFICHAGE DES POINTS ═══════════
    // Les colis NON assignés → L.circleMarker (canvas, ultra-rapide pour gros volumes)
    // Les colis ASSIGNÉS → L.marker avec divIcon numéroté
    // Les filtres recherche/ville/CP/statut/tournée s'appliquent à la volée
    function terrainDrawAllPoints(){
        // 1) Vider les layers
        terrainMarkersLayer.clearLayers();
        terrainTourMarkersLayer.clearLayers();
        Object.values(terrainTourLines).forEach(l => { try { terrainMap.removeLayer(l); } catch(e){} });
        terrainTourLines = {};

        // 2) Identifier les colis assignés
        const assignedMap = new Map();
        terrainTours.forEach(t => {
            const order = t.order && t.order.length ? t.order : t.barcodes;
            order.forEach((bc, idx) => assignedMap.set(bc, { tour: t, pos: idx + 1 }));
        });

        // 3) Appliquer les filtres pour obtenir les points visibles
        const visiblePoints = terrainGetFilteredPoints();
        const visibleSet = new Set(visiblePoints.map(p => p.barcode));

        // 4) Construire les marqueurs
        const tourMarkers = [];
        for(const p of visiblePoints){
            const info = assignedMap.get(p.barcode);
            const delivered = terrainDeliveredSet.has(p.barcode);
            if(info){
                // Colis assigné : marqueur numéroté
                const deliveredClass = delivered ? ' delivered' : '';
                const bg = delivered ? '#16a34a' : info.tour.color;
                const content = delivered ? '✓' : info.pos;
                const m = L.marker([p.lat, p.lon], {
                    icon: L.divIcon({
                        className: '',
                        html: `<div class="terrain-marker labeled${deliveredClass}" style="background:${terrainEscHTML(bg)}">${content}</div>`,
                        iconSize: [26, 26], iconAnchor: [13, 13]
                    })
                });
                m.bindPopup(terrainPopupHTML(p, info));
                tourMarkers.push(m);
            } else {
                // Colis non assigné : circleMarker (canvas, ultra-rapide)
                const color = delivered ? '#16a34a' : '#2563eb';
                const m = L.circleMarker([p.lat, p.lon], {
                    radius: 6,
                    color: '#ffffff',
                    weight: 2,
                    fillColor: color,
                    fillOpacity: 0.95,
                    opacity: 1,
                    pane: 'markerPane'
                });
                m.bindPopup(terrainPopupHTML(p, null));
                m.addTo(terrainMarkersLayer);
            }
        }
        // Ajouter les marqueurs de tournée
        tourMarkers.forEach(m => terrainTourMarkersLayer.addLayer(m));

        // 5) Polylignes par tournée : dépôt → étapes? → colis → ... → colis → étapes? → arrivée
        terrainTours.forEach(t => {
            const order = t.order && t.order.length ? t.order : t.barcodes;
            const visibleColisCoords = order
                .filter(bc => visibleSet.has(bc))
                .map(bc => terrainPoints.find(p => p.barcode === bc))
                .filter(Boolean)
                .map(p => [p.lat, p.lon]);

            const coords = [];
            const allVisible = order.length > 0 && visibleColisCoords.length === order.length;
            if(terrainDepot && allVisible){
                coords.push([terrainDepot.lat, terrainDepot.lon]);
            }
            coords.push(...visibleColisCoords);
            // Étapes intermédiaires (waypoints) entre les colis et le point d'arrivée
            if(allVisible && t.waypoints && t.waypoints.length){
                t.waypoints.forEach(wp => coords.push([wp.lat, wp.lon]));
            }
            if(allVisible){
                const endPt = terrainResolveEndPoint(t);
                if(endPt){
                    coords.push([endPt.lat, endPt.lon]);
                }
            }
            if(coords.length >= 2){
                terrainTourLines[t.id] = L.polyline(coords, {
                    color: t.color, weight: 3, opacity: 0.75
                }).addTo(terrainMap);
            }
        });

        // 6) Dessiner les points d'arrivée personnalisés
        terrainDrawEndpoints();

        // 7) Dessiner les étapes intermédiaires
        terrainDrawWaypoints();

        // 8) Mettre à jour le compteur
        const counterEl = document.getElementById('terrain-counter');
        if(counterEl){
            const total = terrainPoints.length;
            if(total === 0){
                counterEl.textContent = '— colis visibles';
            } else if(visiblePoints.length === total){
                counterEl.textContent = `${total.toLocaleString()} colis`;
            } else {
                counterEl.innerHTML = `<b>${visiblePoints.length.toLocaleString()}</b> / ${total.toLocaleString()} colis`;
            }
        }

        // 9) Auto-sauvegarder l'état dans localStorage (debounced pour éviter les pics)
        terrainScheduleSave();
    }

    // Debounce de terrainSaveState pour éviter d'écrire localStorage à chaque petit re-render
    let terrainSaveTimer = null;
    function terrainScheduleSave(){
        if(terrainSaveTimer) clearTimeout(terrainSaveTimer);
        terrainSaveTimer = setTimeout(() => {
            terrainSaveState();
            terrainSaveTimer = null;
        }, 800);
    }
    // Helpers pour les boutons d'action (téléphone, navigation, SMS, email)
    function terrainCleanPhone(tel){
        // Garde uniquement les chiffres et le + initial éventuel
        if(!tel) return '';
        const s = String(tel).trim();
        if(!s || s.replace(/[^a-z]/gi, '').length > 0 && /\*+/.test(s)) {
            // Si la chaîne ne contient que des * (anonymisée), ignorer
            if(/^[*\s]+$/.test(s)) return '';
        }
        if(/^[*\s]+$/.test(s)) return '';
        const cleaned = s.replace(/[^\d+]/g, '');
        return cleaned;
    }
    function terrainCleanEmail(email){
        if(!email) return '';
        const s = String(email).trim();
        if(/^[*\s]+$/.test(s)) return '';
        return s.includes('@') ? s : '';
    }
    function terrainBuildAddressString(p){
        const parts = [p.adresse, p.cp, p.ville].filter(x => x && !/^[*\s]+$/.test(String(x)));
        return parts.join(' ');
    }
    function terrainNavURL(p){
        // Lien universel : Google Maps en mode navigation depuis position actuelle
        const dest = `${p.lat},${p.lon}`;
        return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`;
    }

    function terrainPopupHTML(p, info){
        const tel = terrainCleanPhone(p.tel);
        const email = terrainCleanEmail(p.email);
        const adr = terrainBuildAddressString(p);
        const isDelivered = !!terrainDeliveredSet.has(p.barcode);

        let html = `<div class="terrain-popup">
            <div class="head${isDelivered ? ' delivered' : ''}">
                ${isDelivered ? '<i class="fas fa-check-circle"></i> ' : ''}<span class="val mono" style="color:white;font-family:monospace">${terrainEscHTML(p.barcode)}</span>
            </div>`;
        if(info){
            html += `<div class="field"><div class="lbl">Tournée</div>
                <div class="val"><span class="tour-pill" style="background:${terrainEscHTML(info.tour.color)};display:inline-block;padding:1px 8px;border-radius:999px;color:white;font-size:11px;font-weight:700">${terrainEscHTML(info.tour.name)} &middot; #${info.pos}</span></div></div>`;
        }
        if(p.nom && !/^[*\s]+$/.test(p.nom))     html += `<div class="field"><div class="lbl">Destinataire</div><div class="val"><b>${terrainEscHTML(p.nom)}</b></div></div>`;
        if(adr)                                  html += `<div class="field"><div class="lbl">Adresse</div><div class="val">${terrainEscHTML(adr)}</div></div>`;
        if(tel)                                  html += `<div class="field"><div class="lbl">Téléphone</div><div class="val mono">${terrainEscHTML(tel)}</div></div>`;
        if(email)                                html += `<div class="field"><div class="lbl">Email</div><div class="val mono">${terrainEscHTML(email)}</div></div>`;
        if(p.status && !/^[*\s]+$/.test(p.status)) html += `<div class="field"><div class="lbl">Statut</div><div class="val">${terrainEscHTML(p.status)}</div></div>`;

        // Actions
        html += `<div class="actions">`;
        if(tel)   html += `<a class="call" href="tel:${encodeURIComponent(tel)}"><i class="fas fa-phone"></i> Appeler</a>`;
        html += `<a class="nav" href="${terrainNavURL(p)}" target="_blank" rel="noopener"><i class="fas fa-route"></i> GPS</a>`;
        if(tel)   html += `<a class="sms" href="sms:${encodeURIComponent(tel)}"><i class="fas fa-sms"></i> SMS</a>`;
        if(email) html += `<a class="email" href="mailto:${encodeURIComponent(email)}"><i class="fas fa-envelope"></i> Email</a>`;
        html += `</div>`;
        html += `</div>`;
        return html;
    }

    // ═══════════ DESSIN DE ZONE À LA SOURIS (clic-par-clic) ═══════════
    window.terrainStartZone = function(){
        terrainResetZone(false);
        terrainZoneDrawing = true;
        document.getElementById('terrain-map').classList.add('drawing');
        document.getElementById('terrain-btnCloseZone').disabled = false;
        document.getElementById('terrain-btnClearZone').disabled = false;
        terrainMap.on('click', terrainZoneAddPoint);
        terrainSetStatus('<i class="fas fa-mouse-pointer"></i> Mode zone activé : cliquez autour du secteur. Cliquez près du premier point ou utilisez "Fermer zone" quand le contour est terminé.', 'info');
    };

    function terrainZoneAddPoint(e){
        if(!terrainZoneDrawing) return;
        // Clic près du 1er point = fermeture auto
        if(terrainZonePoints.length >= 3 && terrainMap.distance(e.latlng, terrainZonePoints[0]) < 70){
            window.terrainCloseZone();
            return;
        }
        terrainZonePoints.push(e.latlng);
        const m = L.marker(e.latlng, {
            icon: L.divIcon({
                className: '',
                html: '<div class="terrain-zone-pt"></div>',
                iconSize: [14,14], iconAnchor: [7,7]
            })
        }).addTo(terrainZoneLayer);
        terrainZoneMarkers.push(m);
        terrainRedrawZone(false);
        if(terrainZonePoints.length === 1){
            terrainZoneCloseHint = L.marker(e.latlng, {
                icon: L.divIcon({
                    className:'',
                    html:'<div class="terrain-zone-hint">Cliquez ici pour fermer</div>',
                    iconSize:[140,24], iconAnchor:[70,30]
                })
            }).addTo(terrainZoneLayer);
        }
    }

    function terrainRedrawZone(closed){
        if(terrainZonePolyline){ try{ terrainZoneLayer.removeLayer(terrainZonePolyline); }catch(e){} terrainZonePolyline = null; }
        if(terrainZonePolygon){ try{ terrainZoneLayer.removeLayer(terrainZonePolygon); }catch(e){} terrainZonePolygon = null; }
        if(terrainZonePoints.length >= 2 && !closed){
            terrainZonePolyline = L.polyline(terrainZonePoints, { color:'#0f172a', weight:3, dashArray:'8,6' }).addTo(terrainZoneLayer);
        }
        if(terrainZonePoints.length >= 3 && closed){
            terrainZonePolygon = L.polygon(terrainZonePoints, {
                color:'#0f172a', weight:3, fillColor:'#3b82f6', fillOpacity:0.13
            }).addTo(terrainZoneLayer);
            // Double-clic sur le polygone (entre 2 sommets) → ajoute un sommet à cet endroit
            terrainZonePolygon.on('dblclick', terrainZoneInsertVertex);
        }
    }

    window.terrainCloseZone = function(){
        if(!terrainZoneDrawing){ return; }
        if(terrainZonePoints.length < 3){
            terrainSetStatus('Cliquez au moins 3 points pour fermer la zone.', 'error');
            return;
        }
        terrainZoneDrawing = false;
        document.getElementById('terrain-map').classList.remove('drawing');
        terrainMap.off('click', terrainZoneAddPoint);
        if(terrainZoneCloseHint){ try{ terrainZoneLayer.removeLayer(terrainZoneCloseHint); }catch(e){} terrainZoneCloseHint = null; }

        // Remplacer les marqueurs statiques par des marqueurs DRAGGABLES
        terrainZoneMarkers.forEach(m => { try{ terrainZoneLayer.removeLayer(m); }catch(e){} });
        terrainZoneMarkers = [];
        terrainZonePoints.forEach((pt, idx) => {
            const m = terrainCreateZoneHandle(pt, idx);
            terrainZoneMarkers.push(m);
        });

        terrainRedrawZone(true);
        terrainRecomputeZoneCapture();

        const hint = terrainCapturedPoints.length === 0
            ? 'Aucun colis non-assigné dans la zone. Ajustez les sommets en les glissant, double-cliquez sur le bord pour ajouter un sommet, ou effacez la zone.'
            : `<b>${terrainCapturedPoints.length}</b> colis non-assignés dans la zone. <b>Glissez</b> les sommets pour ajuster, <b>double-clic sur le bord</b> pour ajouter, <b>clic droit sur un sommet</b> pour le supprimer. Cliquez "Créer tournée" quand prêt.`;
        terrainSetStatus(hint, terrainCapturedPoints.length === 0 ? 'error' : 'success');
    };

    // Crée un marqueur de sommet draggable pour la zone
    function terrainCreateZoneHandle(latlng, idx){
        const m = L.marker(latlng, {
            draggable: true,
            icon: L.divIcon({
                className: '',
                html: '<div class="terrain-zone-pt terrain-zone-pt-handle"></div>',
                iconSize: [16, 16], iconAnchor: [8, 8]
            }),
            zIndexOffset: 500
        }).addTo(terrainZoneLayer);

        m.on('drag', function(ev){
            const ll = ev.target.getLatLng();
            // Trouver l'index courant (peut changer si on a ajouté/supprimé des sommets)
            const currentIdx = terrainZoneMarkers.indexOf(m);
            if(currentIdx < 0) return;
            terrainZonePoints[currentIdx] = ll;
            terrainRedrawZone(true);
        });
        m.on('dragend', function(){
            terrainRecomputeZoneCapture();
        });
        // Clic droit (contextmenu) sur un sommet : supprimer ce sommet
        m.on('contextmenu', function(ev){
            ev.originalEvent && ev.originalEvent.preventDefault && ev.originalEvent.preventDefault();
            const currentIdx = terrainZoneMarkers.indexOf(m);
            if(currentIdx < 0) return;
            if(terrainZonePoints.length <= 3){
                terrainSetStatus('Une zone doit avoir au moins 3 sommets. Impossible de supprimer.', 'error');
                return;
            }
            terrainZonePoints.splice(currentIdx, 1);
            terrainZoneLayer.removeLayer(m);
            terrainZoneMarkers.splice(currentIdx, 1);
            terrainRedrawZone(true);
            terrainRecomputeZoneCapture();
        });
        return m;
    }

    // Double-clic sur le bord du polygone : insère un sommet à l'endroit cliqué
    function terrainZoneInsertVertex(e){
        if(terrainZoneDrawing) return;  // pas en mode dessin actif
        L.DomEvent.stopPropagation(e);
        const newLL = e.latlng;
        // Trouver l'arête la plus proche du point cliqué : on insère entre les 2 sommets de cette arête
        let bestEdge = 0, bestDist = Infinity;
        for(let i = 0; i < terrainZonePoints.length; i++){
            const a = terrainZonePoints[i];
            const b = terrainZonePoints[(i + 1) % terrainZonePoints.length];
            const d = terrainPointToSegmentDistance(newLL, a, b);
            if(d < bestDist){ bestDist = d; bestEdge = i; }
        }
        const insertAt = bestEdge + 1;
        terrainZonePoints.splice(insertAt, 0, newLL);
        const m = terrainCreateZoneHandle(newLL, insertAt);
        terrainZoneMarkers.splice(insertAt, 0, m);
        terrainRedrawZone(true);
        terrainRecomputeZoneCapture();
    }

    // Distance (en degrés, suffisant pour comparaison) d'un point à un segment AB
    function terrainPointToSegmentDistance(p, a, b){
        const px = p.lng, py = p.lat;
        const ax = a.lng, ay = a.lat;
        const bx = b.lng, by = b.lat;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx*dx + dy*dy;
        if(len2 === 0) return Math.hypot(px - ax, py - ay);
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const projX = ax + t * dx, projY = ay + t * dy;
        return Math.hypot(px - projX, py - projY);
    }

    // Recalcule les colis capturés par la zone fermée (utilisé après drag/insert/delete sommet)
    function terrainRecomputeZoneCapture(){
        const assigned = new Set();
        terrainTours.forEach(t => t.barcodes.forEach(bc => assigned.add(bc)));
        terrainCapturedPoints = terrainPoints.filter(p =>
            !assigned.has(p.barcode) && terrainPointInPoly([p.lat, p.lon], terrainZonePoints)
        );
        const btnCreate = document.getElementById('terrain-btnCreateTour');
        if(btnCreate) btnCreate.disabled = terrainCapturedPoints.length === 0;
        // Mettre à jour le compteur de manière discrète sans écraser le hint
        const counter = document.getElementById('terrain-counter');
        if(counter) counter.innerHTML = `<b>${terrainCapturedPoints.length}</b> colis dans la zone`;
    }

    function terrainPointInPoly(pt, poly){
        let x = pt[1], y = pt[0], inside = false;
        for(let i = 0, j = poly.length - 1; i < poly.length; j = i++){
            const xi = poly[i].lng, yi = poly[i].lat;
            const xj = poly[j].lng, yj = poly[j].lat;
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi);
            if(intersect) inside = !inside;
        }
        return inside;
    }

    window.terrainResetZone = function(showMsg){
        terrainZoneDrawing = false;
        terrainZonePoints = [];
        terrainZoneMarkers = [];
        terrainZonePolyline = null;
        terrainZonePolygon = null;
        terrainZoneCloseHint = null;
        terrainCapturedPoints = [];
        try { terrainZoneLayer.clearLayers(); } catch(e){}
        try { terrainMap.off('click', terrainZoneAddPoint); } catch(e){}
        const mapEl = document.getElementById('terrain-map');
        if(mapEl) mapEl.classList.remove('drawing');
        document.getElementById('terrain-btnCloseZone').disabled = true;
        document.getElementById('terrain-btnCreateTour').disabled = true;
        document.getElementById('terrain-btnClearZone').disabled = !terrainPoints.length;
        if(showMsg) terrainSetStatus('Zone effacée.', 'info');
    };

    window.terrainCreateTourFromZone = function(){
        if(terrainCapturedPoints.length === 0) return;
        const name = prompt(`Nom de la tournée (${terrainCapturedPoints.length} colis) :`, `Tournée ${terrainTours.length + 1}`);
        if(!name) return;
        const color = TOUR_COLORS[terrainTours.length % TOUR_COLORS.length];
        const barcodes = terrainCapturedPoints.map(p => p.barcode);
        const tour = {
            id: ++terrainTourId,
            name: name.trim(),
            color,
            barcodes,
            order: [],
            livreurId: null,
            endMode: terrainDepot ? 'depot' : 'none',   // 'depot' | 'none' | 'custom'
            endPoint: null,                             // {lat, lon, label} si endMode='custom'
            waypoints: []                               // [{lat, lon, label}] - étapes intermédiaires
        };
        tour.order = terrainOptimizeBarcodes(barcodes, tour);
        terrainTours.push(tour);
        terrainResetZone(false);
        terrainDrawAllPoints();
        terrainRefreshTourList();
        terrainUpdateStats();
        terrainEnableButtons();
        terrainSetStatus(`Tournée <b>${terrainEscHTML(name)}</b> créée avec <b>${barcodes.length}</b> colis. Pensez à l'assigner à un livreur.`, 'success');
    };

    // ═══════════ OPTIMISATION (nearest-neighbor + 2-opt + bonus CP/ville) ═══════════
    function terrainHaversine(a, b){
        const R = 6371;
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLon = toRad(b.lon - a.lon);
        const la1 = toRad(a.lat), la2 = toRad(b.lat);
        const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }
    function terrainLegCost(a, b){
        // Cout avec bonus regroupement par CP/ville
        let d = terrainHaversine(a, b);
        if(a.cp && b.cp && String(a.cp) === String(b.cp)) d *= 0.82;
        if(a.ville && b.ville && String(a.ville).toLowerCase() === String(b.ville).toLowerCase()) d *= 0.76;
        return d;
    }
    // Résout le point d'arrivée effectif d'une tournée selon son mode.
    // Retourne null si pas de retour. Fallback intelligent si dépôt non défini.
    function terrainResolveEndPoint(tour){
        if(!tour) return terrainDepot || null;
        if(tour.endMode === 'none')   return null;
        if(tour.endMode === 'custom' && tour.endPoint && isFinite(tour.endPoint.lat) && isFinite(tour.endPoint.lon)){
            return { lat: tour.endPoint.lat, lon: tour.endPoint.lon };
        }
        if(tour.endMode === 'depot')  return terrainDepot || null;
        // Rétrocompat ou cas non défini : si dépôt → boucle, sinon pas de retour
        return terrainDepot || null;
    }

    function terrainRouteDistance(pts){
        let total = 0;
        for(let i = 1; i < pts.length; i++) total += terrainHaversine(pts[i-1], pts[i]);
        return total;
    }
    // Distance totale incluant départ depuis le dépôt + waypoints + retour vers le point d'arrivée choisi
    function terrainRouteDistanceWithDepot(pts, tour){
        let total = terrainRouteDistance(pts);
        if(pts.length === 0) return total;
        // Distance dépôt → premier colis (si dépôt défini)
        if(terrainDepot){
            total += terrainHaversine(terrainDepot, pts[0]);
        }
        // Construire la séquence "fin de tournée" : [dernier colis, ...waypoints, endPoint?]
        let prev = pts[pts.length - 1];
        if(tour && tour.waypoints && tour.waypoints.length){
            for(const wp of tour.waypoints){
                total += terrainHaversine(prev, wp);
                prev = wp;
            }
        }
        const endPt = terrainResolveEndPoint(tour);
        if(endPt){
            total += terrainHaversine(prev, endPt);
        }
        return total;
    }
    // Nearest neighbor avec point de départ optionnel (le dépôt)
    function terrainNearestNeighbor(pts, startPoint){
        if(pts.length <= 1) return pts.slice();
        const remaining = pts.slice();
        let route;
        let start;
        if(startPoint){
            // Démarrer depuis le dépôt : le 1er colis est le plus proche du dépôt
            let bestIdx = 0, bestScore = Infinity;
            for(let i = 0; i < remaining.length; i++){
                const s = terrainLegCost(startPoint, remaining[i]);
                if(s < bestScore){ bestScore = s; bestIdx = i; }
            }
            route = [remaining.splice(bestIdx, 1)[0]];
        } else {
            route = [remaining.shift()];
        }
        while(remaining.length){
            const cur = route[route.length - 1];
            let bestIdx = 0, bestScore = Infinity;
            for(let i = 0; i < remaining.length; i++){
                const s = terrainLegCost(cur, remaining[i]);
                if(s < bestScore){ bestScore = s; bestIdx = i; }
            }
            route.push(remaining.splice(bestIdx, 1)[0]);
        }
        return route;
    }
    // 2-opt avec extrémités fixes optionnelles (dépôt en départ/retour)
    function terrainTwoOpt(route, startPoint, endPoint){
        if(route.length < 5) return route;
        let best = route.slice();
        let improved = true;
        let loops = 0;
        const maxLoops = best.length > 160 ? 4 : 10;

        // Helper : coût d'un segment, en remplaçant les indices "virtuels" -1 / length par les points fixes
        const legAt = (arr, i) => {
            if(i === -1)            return startPoint;
            if(i === arr.length)    return endPoint;
            return arr[i];
        };
        const segCost = (arr, i, j) => {
            const a = legAt(arr, i), b = legAt(arr, j);
            if(!a || !b) return 0;
            return terrainLegCost(a, b);
        };

        while(improved && loops < maxLoops){
            improved = false; loops++;
            // i va de 0 à length-1 (on peut inverser depuis le 1er colis si start fixé), idem pour k
            const iMin = startPoint ? 0 : 1;
            const kMax = endPoint   ? best.length - 1 : best.length - 2;
            for(let i = iMin; i < best.length - 1; i++){
                for(let k = i + 1; k <= kMax; k++){
                    const before = segCost(best, i-1, i) + segCost(best, k, k+1);
                    // Après inversion segment [i..k], le nouveau segment est:
                    //   (i-1) -> k ... i -> (k+1)
                    const after  = segCost(best, i-1, k) + segCost(best, i, k+1);
                    if(after + 0.001 < before){
                        best = best.slice(0, i).concat(best.slice(i, k+1).reverse(), best.slice(k+1));
                        improved = true;
                    }
                }
            }
        }
        return best;
    }
    // Optimisation principale d'une tournée. tour est optionnel pour récupérer endMode/endPoint.
    function terrainOptimizeBarcodes(barcodes, tour){
        const pts = barcodes.map(bc => terrainPoints.find(p => p.barcode === bc)).filter(Boolean);
        if(pts.length <= 1) return barcodes.slice();
        const start = terrainDepot;                    // départ = dépôt (peut être null)
        const end = terrainResolveEndPoint(tour);      // arrivée = selon endMode
        let r = terrainNearestNeighbor(pts, start);
        r = terrainTwoOpt(r, start, end);
        return r.map(p => p.barcode);
    }

    window.terrainOptimizeAll = function(){
        if(!terrainTours.length) return;
        let beforeTotal = 0, afterTotal = 0;
        terrainTours.forEach(t => {
            const ptsBefore = (t.order.length ? t.order : t.barcodes)
                .map(bc => terrainPoints.find(p => p.barcode === bc)).filter(Boolean);
            beforeTotal += terrainRouteDistanceWithDepot(ptsBefore, t);
            t.order = terrainOptimizeBarcodes(t.barcodes, t);
            const ptsAfter = t.order.map(bc => terrainPoints.find(p => p.barcode === bc)).filter(Boolean);
            afterTotal += terrainRouteDistanceWithDepot(ptsAfter, t);
        });
        terrainDrawAllPoints();
        terrainRefreshTourList();
        terrainUpdateStats();
        const gain = beforeTotal - afterTotal;
        const pct = beforeTotal > 0 ? (gain / beforeTotal * 100) : 0;
        terrainSetStatus(`Optimisation : <b>${beforeTotal.toFixed(1)} km → ${afterTotal.toFixed(1)} km</b> (gain ${gain.toFixed(1)} km, -${pct.toFixed(1)}%).`, 'success');
    };

    // ═══════════ PROPOSITION AUTOMATIQUE PAR K-MEANS ═══════════
    function terrainKMeansBalanced(pts, k){
        if(pts.length === 0 || k <= 0) return [];
        k = Math.min(k, pts.length);
        const centroids = [{ lat: pts[0].lat, lon: pts[0].lon }];
        while(centroids.length < k){
            let best = null, bd = -1;
            for(const p of pts){
                const d = Math.min(...centroids.map(c => terrainHaversine(p, c)));
                if(d > bd){ bd = d; best = p; }
            }
            centroids.push({ lat: best.lat, lon: best.lon });
        }
        let clusters = Array.from({length: k}, () => []);
        for(let it = 0; it < 30; it++){
            clusters = Array.from({length: k}, () => []);
            pts.forEach(p => {
                let bi = 0, bd = Infinity;
                for(let i = 0; i < k; i++){
                    const d = terrainHaversine(p, centroids[i]);
                    if(d < bd){ bd = d; bi = i; }
                }
                clusters[bi].push(p);
            });
            let moved = 0;
            for(let i = 0; i < k; i++){
                if(clusters[i].length === 0) continue;
                const nl = clusters[i].reduce((s,p)=>s+p.lat,0)/clusters[i].length;
                const no = clusters[i].reduce((s,p)=>s+p.lon,0)/clusters[i].length;
                if(Math.abs(nl - centroids[i].lat) + Math.abs(no - centroids[i].lon) > 1e-6) moved++;
                centroids[i] = { lat: nl, lon: no };
            }
            if(moved === 0) break;
        }
        // Équilibrage
        const target = Math.ceil(pts.length / k);
        for(let pass = 0; pass < 5; pass++){
            let didMove = false;
            for(let i = 0; i < k; i++){
                while(clusters[i].length > target){
                    let fi = 0, fd = -1;
                    for(let j = 0; j < clusters[i].length; j++){
                        const d = terrainHaversine(clusters[i][j], centroids[i]);
                        if(d > fd){ fd = d; fi = j; }
                    }
                    const p = clusters[i][fi];
                    let bj = -1, bd = Infinity;
                    for(let j = 0; j < k; j++){
                        if(j === i || clusters[j].length >= target) continue;
                        const d = terrainHaversine(p, centroids[j]);
                        if(d < bd){ bd = d; bj = j; }
                    }
                    if(bj < 0) break;
                    clusters[i].splice(fi, 1);
                    clusters[bj].push(p);
                    didMove = true;
                }
            }
            if(!didMove) break;
        }
        return clusters.filter(c => c.length > 0);
    }

    window.terrainProposeTours = function(){
        if(!terrainPoints.length) return;
        const k = parseInt(document.getElementById('terrain-nbTours').value, 10);
        if(!k || k < 1){ alert('Indiquez un nombre de tournées valide.'); return; }
        const assigned = new Set();
        terrainTours.forEach(t => t.barcodes.forEach(bc => assigned.add(bc)));
        const free = terrainPoints.filter(p => !assigned.has(p.barcode));
        if(free.length === 0){ alert('Tous les colis sont déjà dans une tournée.'); return; }
        if(!confirm(`Découper ${free.length} colis non-assignés en ${k} tournées équilibrées ?`)) return;
        const clusters = terrainKMeansBalanced(free, k);
        clusters.forEach((cl, i) => {
            const color = TOUR_COLORS[terrainTours.length % TOUR_COLORS.length];
            const barcodes = cl.map(p => p.barcode);
            const tour = {
                id: ++terrainTourId,
                name: `Auto-${terrainTours.length + 1}`,
                color, barcodes,
                order: [],
                livreurId: null,
                endMode: terrainDepot ? 'depot' : 'none',
                endPoint: null,
                waypoints: []
            };
            tour.order = terrainOptimizeBarcodes(barcodes, tour);
            terrainTours.push(tour);
        });
        terrainDrawAllPoints();
        terrainRefreshTourList();
        terrainUpdateStats();
        terrainEnableButtons();
        terrainSetStatus(`<b>${clusters.length}</b> tournée(s) proposée(s) par clustering géographique.`, 'success');
    };

    // ═══════════ LISTE DES TOURNÉES (UI sidebar) ═══════════
    function terrainGetLivreurs(){
        try {
            // Accès à la variable globale `data` du script principal
            const livs = (typeof data !== 'undefined' && data && Array.isArray(data.livreurs)) ? data.livreurs : [];
            return livs.filter(l => l.actif !== false);
        } catch(e){
            return [];
        }
    }

    function terrainTourDistance(tour){
        const order = tour.order && tour.order.length ? tour.order : tour.barcodes;
        const pts = order.map(bc => terrainPoints.find(p => p.barcode === bc)).filter(Boolean);
        return terrainRouteDistanceWithDepot(pts, tour);
    }

    function terrainRefreshTourList(){
        // Synchroniser le dropdown de filtre par tournée
        terrainPopulateTourFilter();
        const el = document.getElementById('terrain-tourList');
        const cnt = document.getElementById('terrain-toursCount');
        if(cnt) cnt.textContent = terrainTours.length;
        if(!terrainTours.length){
            el.innerHTML = `<div class="terrain-empty">${terrainPoints.length ? 'Dessinez une zone ou utilisez "Proposer N tournées".' : 'Importez un fichier EPOD pour commencer.'}</div>`;
            return;
        }
        const livreurs = terrainGetLivreurs();
        el.innerHTML = terrainTours.map(t => {
            const order = t.order && t.order.length ? t.order : t.barcodes;
            const dist = terrainTourDistance(t);
            const assignedLiv = livreurs.find(l => String(l.id) === String(t.livreurId));
            const assignedLabel = assignedLiv ? `${assignedLiv.prenom || ''} ${assignedLiv.nom || ''}`.trim() : 'Non assigné';
            const livClass = assignedLiv ? 'assigned' : '';
            const options = livreurs.map(l =>
                `<option value="${terrainEscHTML(l.id)}"${String(l.id) === String(t.livreurId) ? ' selected' : ''}>${terrainEscHTML((l.prenom||'') + ' ' + (l.nom||''))}</option>`
            ).join('');
            const items = order.map((bc, idx) => {
                const p = terrainPoints.find(pp => pp.barcode === bc);
                const detail = p ? `${p.cp || ''} ${p.ville || ''}`.trim() : '';
                return `<div class="terrain-point-item">
                    <span class="pos">${idx + 1}</span>
                    <span class="bc" title="${terrainEscHTML(detail)}">${terrainEscHTML(bc)}</span>
                    <span class="rm" onclick="terrainRemovePoint(${Number(t.id)},'${escJsAttr(bc)}')">×</span>
                </div>`;
            }).join('');
            return `<div class="terrain-tour-card">
                <div class="terrain-tour-head" onclick="terrainToggleBody(${Number(t.id)})">
                    <div class="terrain-tour-dot" style="background:${terrainEscHTML(t.color)}"></div>
                    <div class="terrain-tour-info">
                        <div class="terrain-tour-name">${terrainEscHTML(t.name)}</div>
                        <div class="terrain-tour-meta">
                            <span class="terrain-livreur-badge ${livClass}">${terrainEscHTML(assignedLabel)}</span>
                            <span>${t.barcodes.length} pts</span>
                            <span>${dist.toFixed(1)} km</span>
                        </div>
                    </div>
                    <div class="terrain-tour-actions" onclick="event.stopPropagation()">
                        <button class="terrain-btn sm" title="Centrer sur la carte" onclick="terrainZoomToTour(${Number(t.id)})"><i class="fas fa-search-location"></i></button>
                        <button class="terrain-btn sm" title="Ré-optimiser" onclick="terrainReoptimize(${Number(t.id)})"><i class="fas fa-bolt"></i></button>
                        <button class="terrain-btn sm danger" title="Supprimer" onclick="terrainDeleteTour(${Number(t.id)})"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
                <div class="terrain-tour-body hidden" id="terrain-body-${terrainEscHTML(t.id)}">
                    <div class="terrain-livreur-sel">
                        <label>Livreur :</label>
                        <select onchange="terrainAssignLivreur(${Number(t.id)}, this.value)">
                            <option value="">— Non assigné —</option>
                            ${options}
                        </select>
                    </div>
                    <div class="terrain-end-modes">
                        <div class="terrain-end-modes-label"><i class="fas fa-flag-checkered"></i> Fin de tournée :</div>
                        <div class="terrain-end-modes-buttons">
                            <button type="button" class="terrain-end-mode-btn ${t.endMode === 'depot' ? 'active' : ''}"
                                    ${terrainDepot ? '' : 'disabled'}
                                    title="${terrainDepot ? 'Le livreur revient au dépôt' : 'Définissez un dépôt pour activer ce mode'}"
                                    onclick="terrainSetEndMode(${Number(t.id)}, 'depot')">
                                <i class="fas fa-warehouse"></i> Dépôt
                            </button>
                            <button type="button" class="terrain-end-mode-btn ${t.endMode === 'none' ? 'active' : ''}"
                                    onclick="terrainSetEndMode(${Number(t.id)}, 'none')">
                                <i class="fas fa-ban"></i> Aucun
                            </button>
                            <button type="button" class="terrain-end-mode-btn ${t.endMode === 'custom' ? 'active' : ''}"
                                    onclick="terrainSetEndMode(${Number(t.id)}, 'custom')">
                                <i class="fas fa-map-marker-alt"></i> Personnalisé
                            </button>
                        </div>
                        ${t.endMode === 'custom' && t.endPoint ? `
                        <div class="terrain-end-custom-info">
                            <i class="fas fa-flag-checkered" style="color:${terrainEscHTML(t.color)}"></i>
                            <small>Arrivée à ${t.endPoint.lat.toFixed(4)}, ${t.endPoint.lon.toFixed(4)}</small>
                            <button type="button" class="terrain-btn sm" onclick="terrainReplaceEndpoint(${Number(t.id)})" title="Déplacer le point d'arrivée">
                                <i class="fas fa-edit"></i>
                            </button>
                        </div>` : ''}
                    </div>
                    <div class="terrain-waypoints-block">
                        <div class="terrain-waypoints-head">
                            <span><i class="fas fa-flag" style="color:${terrainEscHTML(t.color)}"></i> Étapes intermédiaires <b>(${(t.waypoints || []).length})</b></span>
                            ${terrainPlacingWaypointFor === t.id
                                ? `<button type="button" class="terrain-btn sm primary" onclick="terrainStopAddWaypoint()"><i class="fas fa-check"></i> Terminer</button>`
                                : `<button type="button" class="terrain-btn sm" onclick="terrainStartAddWaypoint(${Number(t.id)})"><i class="fas fa-plus"></i> Ajouter</button>`}
                            ${(t.waypoints || []).length > 0
                                ? `<button type="button" class="terrain-btn sm danger" onclick="terrainClearWaypoints(${Number(t.id)})" title="Effacer toutes les étapes"><i class="fas fa-times"></i></button>`
                                : ''}
                        </div>
                        ${(t.waypoints || []).length > 0 ? `
                            <div class="terrain-waypoint-list">
                                ${(t.waypoints).map((wp, idx) => `
                                    <div class="terrain-waypoint-item">
                                        <span class="terrain-waypoint-badge" style="background:${terrainEscHTML(t.color)}">${idx + 1}</span>
                                        <span class="terrain-waypoint-coords">${wp.lat.toFixed(4)}, ${wp.lon.toFixed(4)}</span>
                                        <button type="button" class="terrain-waypoint-rm" onclick="terrainRemoveWaypoint(${Number(t.id)}, ${idx})" title="Supprimer">×</button>
                                    </div>
                                `).join('')}
                            </div>
                        ` : '<div class="terrain-waypoints-empty">Cliquez sur "Ajouter" pour placer une étape sur la carte (pause, station-service…)</div>'}
                    </div>
                    <div class="terrain-point-list">${items}</div>
                    <div style="display:flex;gap:0.3rem;flex-wrap:wrap">
                        <button class="terrain-btn sm" onclick="terrainExportTourCSV(${Number(t.id)})"><i class="fas fa-file-csv"></i> CSV</button>
                        <button class="terrain-btn sm" onclick="terrainExportTourJSON(${Number(t.id)})"><i class="fas fa-file-code"></i> JSON</button>
                        <button class="terrain-btn sm" onclick="terrainRenameTour(${Number(t.id)})"><i class="fas fa-edit"></i> Renommer</button>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    window.terrainToggleBody = function(id){
        const el = document.getElementById(`terrain-body-${id}`);
        if(el) el.classList.toggle('hidden');
    };

    window.terrainAssignLivreur = function(id, livId){
        const t = terrainTours.find(t => t.id === id);
        if(!t) return;
        t.livreurId = livId || null;
        terrainRefreshTourList();
    };

    window.terrainRenameTour = function(id){
        const t = terrainTours.find(t => t.id === id);
        if(!t) return;
        const newName = prompt('Nouveau nom :', t.name);
        if(newName && newName.trim()){ t.name = newName.trim(); terrainRefreshTourList(); }
    };

    window.terrainReoptimize = function(id){
        const t = terrainTours.find(t => t.id === id);
        if(!t) return;
        const before = terrainTourDistance(t);
        t.order = terrainOptimizeBarcodes(t.barcodes, t);
        const after = terrainTourDistance(t);
        terrainDrawAllPoints();
        terrainRefreshTourList();
        terrainUpdateStats();
        terrainSetStatus(`Tournée <b>${terrainEscHTML(t.name)}</b> : ${before.toFixed(1)} km → ${after.toFixed(1)} km`, 'success');
    };

    // Change le mode de fin d'une tournée. mode = 'depot' | 'none' | 'custom'
    window.terrainSetEndMode = function(id, mode){
        const t = terrainTours.find(t => t.id === id);
        if(!t) return;
        // Si on demande 'depot' sans dépôt défini, on bascule en 'none'
        if(mode === 'depot' && !terrainDepot){
            t.endMode = 'none';
            terrainSetStatus('Aucun dépôt défini : la tournée n\'a pas de point de retour. Définissez un dépôt si vous voulez ce mode.', 'info');
        } else if(mode === 'custom'){
            // On entre en mode placement pour cette tournée
            t.endMode = 'custom';
            if(!t.endPoint){
                terrainStartPlaceEndpoint(id);
                return;  // attendre le clic
            }
        } else {
            t.endMode = mode;
        }
        // Ré-optimiser puisque le point d'arrivée change
        t.order = terrainOptimizeBarcodes(t.barcodes, t);
        terrainDrawAllPoints();
        terrainRefreshTourList();
        terrainUpdateStats();
    };

    // Mode placement actif : clic sur la carte = point d'arrivée pour la tournée id
    function terrainStartPlaceEndpoint(tourId){
        // Sortir du mode dessin de zone ou placement dépôt si actif
        if(terrainZoneDrawing) terrainResetZone(false);
        if(terrainPlacingDepot) terrainStopPlacingDepot();
        terrainPlacingEndpointFor = tourId;
        const mapEl = document.getElementById('terrain-map');
        if(mapEl) mapEl.classList.add('placing-endpoint');
        terrainMap.on('click', terrainOnEndpointClick);
        const t = terrainTours.find(t => t.id === tourId);
        terrainSetStatus(`<i class="fas fa-flag-checkered"></i> Cliquez sur la carte pour placer le point d'arrivée de <b>${t ? terrainEscHTML(t.name) : ''}</b>. Échap pour annuler.`, 'info');
    }
    function terrainOnEndpointClick(e){
        if(terrainPlacingEndpointFor == null) return;
        const t = terrainTours.find(t => t.id === terrainPlacingEndpointFor);
        if(t){
            t.endMode = 'custom';
            t.endPoint = { lat: e.latlng.lat, lon: e.latlng.lng };
            t.order = terrainOptimizeBarcodes(t.barcodes, t);
        }
        terrainStopPlacingEndpoint();
        terrainDrawAllPoints();
        terrainRefreshTourList();
        terrainUpdateStats();
        terrainSetStatus(`Point d'arrivée placé pour <b>${t ? terrainEscHTML(t.name) : ''}</b>.`, 'success');
    }
    function terrainStopPlacingEndpoint(){
        terrainPlacingEndpointFor = null;
        const mapEl = document.getElementById('terrain-map');
        if(mapEl) mapEl.classList.remove('placing-endpoint');
        try { terrainMap.off('click', terrainOnEndpointClick); } catch(e){}
    }
    // Bouton "replacer" depuis l'UI
    window.terrainReplaceEndpoint = function(tourId){
        terrainStartPlaceEndpoint(tourId);
    };

    // ═══════════ ÉTAPES INTERMÉDIAIRES (WAYPOINTS) ═══════════
    // Dessine les marqueurs des étapes intermédiaires sur la carte (un par tournée concernée)
    function terrainDrawWaypoints(){
        if(!terrainWaypointsLayer) return;
        terrainWaypointsLayer.clearLayers();
        terrainTours.forEach(t => {
            if(!t.waypoints || !t.waypoints.length) return;
            t.waypoints.forEach((wp, idx) => {
                const icon = L.divIcon({
                    className: '',
                    html: `<div class="terrain-waypoint-icon" style="background:${terrainEscHTML(t.color)}"><i class="fas fa-flag"></i><span class="terrain-waypoint-num">${idx + 1}</span></div>`,
                    iconSize: [28, 28],
                    iconAnchor: [14, 28]
                });
                const m = L.marker([wp.lat, wp.lon], { icon, zIndexOffset: 700 });
                m.bindPopup(`<div style="font-family:sans-serif;font-size:13px;min-width:160px">
                    <b style="color:${terrainEscHTML(t.color)}"><i class="fas fa-flag"></i> Étape ${idx + 1} — ${terrainEscHTML(t.name)}</b><br>
                    ${wp.label ? terrainEscHTML(wp.label) + '<br>' : ''}
                    <small style="color:#64748b">${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}</small><br>
                    <button onclick="terrainRemoveWaypoint(${Number(t.id)}, ${idx})" style="margin-top:6px;padding:3px 8px;background:#fee2e2;border:1px solid #fecaca;color:#dc2626;border-radius:4px;cursor:pointer;font-size:11px">
                        <i class="fas fa-trash"></i> Supprimer cette étape
                    </button>
                </div>`);
                m.addTo(terrainWaypointsLayer);
            });
        });
    }

    // Démarre le mode placement waypoint : chaque clic ajoute une étape jusqu'à Échap ou bouton "Terminer"
    window.terrainStartAddWaypoint = function(tourId){
        // Sortir des autres modes
        if(terrainZoneDrawing) terrainResetZone(false);
        if(terrainPlacingDepot) terrainStopPlacingDepot();
        if(terrainPlacingEndpointFor != null) terrainStopPlacingEndpoint();

        terrainPlacingWaypointFor = tourId;
        const mapEl = document.getElementById('terrain-map');
        if(mapEl) mapEl.classList.add('placing-waypoint');
        terrainMap.on('click', terrainOnWaypointClick);
        const t = terrainTours.find(t => t.id === tourId);
        terrainSetStatus(`<i class="fas fa-flag"></i> Cliquez sur la carte pour ajouter une étape à <b>${t ? terrainEscHTML(t.name) : ''}</b>. Cliquez plusieurs fois pour plusieurs étapes. <b>Échap</b> ou bouton "Terminer" pour arrêter.`, 'info');
    };

    function terrainOnWaypointClick(e){
        if(terrainPlacingWaypointFor == null) return;
        const t = terrainTours.find(t => t.id === terrainPlacingWaypointFor);
        if(!t) return;
        if(!Array.isArray(t.waypoints)) t.waypoints = [];
        t.waypoints.push({ lat: e.latlng.lat, lon: e.latlng.lng });
        // Pas de ré-optimisation : l'utilisateur a placé l'étape exprès, on respecte l'ordre
        terrainDrawAllPoints();
        terrainRefreshTourList();
        terrainUpdateStats();
        terrainSetStatus(`<i class="fas fa-flag"></i> <b>${t.waypoints.length}</b> étape(s) ajoutée(s) à <b>${terrainEscHTML(t.name)}</b>. Continuez à cliquer pour en ajouter, ou Échap pour terminer.`, 'success');
    }

    window.terrainStopAddWaypoint = function(){
        if(terrainPlacingWaypointFor == null) return;
        const tourId = terrainPlacingWaypointFor;
        terrainPlacingWaypointFor = null;
        const mapEl = document.getElementById('terrain-map');
        if(mapEl) mapEl.classList.remove('placing-waypoint');
        try { terrainMap.off('click', terrainOnWaypointClick); } catch(e){}
        const t = terrainTours.find(t => t.id === tourId);
        terrainRefreshTourList();
        if(t){
            terrainSetStatus(`Ajout d'étapes terminé pour <b>${terrainEscHTML(t.name)}</b> (${t.waypoints.length} étape(s)).`, 'success');
        }
    };

    window.terrainRemoveWaypoint = function(tourId, idx){
        const t = terrainTours.find(t => t.id === tourId);
        if(!t || !t.waypoints || idx < 0 || idx >= t.waypoints.length) return;
        t.waypoints.splice(idx, 1);
        terrainDrawAllPoints();
        terrainRefreshTourList();
        terrainUpdateStats();
        terrainMap.closePopup();
    };

    window.terrainClearWaypoints = function(tourId){
        const t = terrainTours.find(t => t.id === tourId);
        if(!t || !t.waypoints || !t.waypoints.length) return;
        if(!confirm(`Supprimer les ${t.waypoints.length} étape(s) de "${t.name}" ?`)) return;
        t.waypoints = [];
        terrainDrawAllPoints();
        terrainRefreshTourList();
        terrainUpdateStats();
    };

    window.terrainDeleteTour = function(id){
        const t = terrainTours.find(t => t.id === id);
        if(!t) return;
        if(!confirm(`Supprimer la tournée "${t.name}" ?`)) return;
        terrainTours = terrainTours.filter(t => t.id !== id);
        terrainDrawAllPoints();
        terrainRefreshTourList();
        terrainUpdateStats();
        terrainEnableButtons();
    };

    window.terrainRemovePoint = function(id, bc){
        const t = terrainTours.find(t => t.id === id);
        if(!t) return;
        t.barcodes = t.barcodes.filter(b => b !== bc);
        t.order = t.order.filter(b => b !== bc);
        if(t.barcodes.length === 0){
            terrainTours = terrainTours.filter(x => x.id !== id);
        }
        terrainDrawAllPoints();
        terrainRefreshTourList();
        terrainUpdateStats();
        terrainEnableButtons();
    };

    window.terrainZoomToTour = function(id){
        const t = terrainTours.find(t => t.id === id);
        if(!t) return;
        const pts = t.barcodes.map(bc => terrainPoints.find(p => p.barcode === bc)).filter(Boolean);
        if(pts.length) terrainMap.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lon])).pad(0.2));
    };

    // ═══════════ STATISTIQUES ═══════════
    function terrainUpdateStats(){
        const total = terrainPoints.length;
        const assigned = new Set();
        terrainTours.forEach(t => t.barcodes.forEach(bc => assigned.add(bc)));
        let totalDist = 0;
        terrainTours.forEach(t => { totalDist += terrainTourDistance(t); });
        document.getElementById('terrain-stat-total').textContent = total;
        document.getElementById('terrain-stat-assigned').textContent = assigned.size;
        document.getElementById('terrain-stat-unassigned').textContent = total - assigned.size;
        document.getElementById('terrain-stat-tours').textContent = terrainTours.length;
        document.getElementById('terrain-stat-distance').textContent = totalDist.toFixed(1) + ' km';
    }

    // ═══════════ GÉOCODAGE BAN (filet de sécurité) ═══════════
    window.terrainGeocodeMissing = async function(){
        if(!terrainPending.length){ alert('Aucun colis à géocoder.'); return; }
        if(!confirm(`Géocoder ${terrainPending.length} adresses via l'API Adresse française ?`)) return;
        terrainGeocodeAbort = false;
        const btn = document.getElementById('terrain-btnGeocode');
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-stop"></i> Arrêter';
        btn.onclick = () => { terrainGeocodeAbort = true; };

        const queue = terrainPending.slice();
        const stats = { ok: 0, ko: 0, done: 0, total: queue.length };
        const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
            while(queue.length && !terrainGeocodeAbort){
                const p = queue.shift();
                try {
                    const geo = await terrainGeocodeBAN(p);
                    if(geo){
                        p.lat = geo.lat; p.lon = geo.lon;
                        terrainPoints.push(p);
                        stats.ok++;
                    } else stats.ko++;
                } catch(e){ stats.ko++; }
                stats.done++;
                terrainSetStatus(`<i class="fas fa-satellite-dish fa-spin"></i> Géocodage : ${stats.done}/${stats.total} · ${stats.ok} trouvés · ${stats.ko} échecs`, 'info');
                if(stats.done % 5 === 0) terrainDrawAllPoints();
            }
        });
        await Promise.all(workers);

        const okBcs = new Set(terrainPoints.map(p => p.barcode));
        terrainPending = terrainPending.filter(p => !okBcs.has(p.barcode));
        terrainDrawAllPoints();
        terrainUpdateStats();
        terrainEnableButtons();
        btn.innerHTML = original;
        btn.onclick = window.terrainGeocodeMissing;
        btn.style.display = terrainPending.length ? '' : 'none';
        terrainSetStatus(`Géocodage terminé : <b>${stats.ok}</b> trouvés sur ${stats.total}${stats.ko ? `, ${stats.ko} échec(s)` : ''}.`, 'success');
    };

    async function terrainGeocodeBAN(p){
        const queries = [];
        if(p.adresse && p.cp && p.ville) queries.push(`${p.adresse} ${p.cp} ${p.ville}`);
        if(p.adresse && p.ville)         queries.push(`${p.adresse} ${p.ville}`);
        if(p.cp && p.ville)              queries.push(`${p.cp} ${p.ville}`);
        if(p.ville)                      queries.push(p.ville);
        for(const q of [...new Set(queries.map(x => x.replace(/\s+/g,' ').trim()))]){
            if(terrainGeocodeAbort) return null;
            const key = q.toLowerCase() + '|' + (p.cp || '');
            let features;
            if(terrainGeocodeCache.has(key)){
                features = terrainGeocodeCache.get(key);
            } else {
                let url = 'https://api-adresse.data.gouv.fr/search/?limit=5&autocomplete=0&q=' + encodeURIComponent(q);
                if(p.cp) url += '&postcode=' + encodeURIComponent(p.cp);
                try {
                    const r = await fetch(url);
                    if(!r.ok) continue;
                    features = (await r.json()).features || [];
                    terrainGeocodeCache.set(key, features);
                } catch(e){ continue; }
            }
            if(features.length){
                const best = features[0];
                const c = best.geometry && best.geometry.coordinates;
                if(c && c.length >= 2) return { lat: c[1], lon: c[0] };
            }
            await new Promise(r => setTimeout(r, 120));
        }
        return null;
    }

    // ═══════════ EXPORTS ═══════════
    function terrainCsvEscape(v){ return '"' + String(v == null ? '' : v).replaceAll('"','""') + '"'; }
    function terrainDownload(filename, content, mime){
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([content], { type: mime || 'text/plain;charset=utf-8' }));
        a.download = filename; a.click();
    }
    function terrainTourCSV(t){
        const order = t.order && t.order.length ? t.order : t.barcodes;
        const livreurs = terrainGetLivreurs();
        const liv = livreurs.find(l => String(l.id) === String(t.livreurId));
        const livName = liv ? `${liv.prenom || ''} ${liv.nom || ''}`.trim() : '';
        const rows = [['ordre','barcode','nom','telephone','adresse','code_postal','ville','latitude','longitude','tournee','livreur','type']];
        let ordre = 0;
        // Ligne de départ depuis le dépôt
        if(terrainDepot){
            rows.push([ordre++, 'DEPOT_START', terrainDepot.label || 'Dépôt', '', '', '', '', terrainDepot.lat, terrainDepot.lon, t.name, livName, 'depart']);
        }
        order.forEach((bc) => {
            const p = terrainPoints.find(pp => pp.barcode === bc); if(!p) return;
            rows.push([++ordre, p.barcode, p.nom, p.tel, p.adresse, p.cp, p.ville, p.lat, p.lon, t.name, livName, 'colis']);
        });
        // Étapes intermédiaires
        if(t.waypoints && t.waypoints.length){
            t.waypoints.forEach((wp, i) => {
                rows.push([++ordre, `WAYPOINT_${i+1}`, wp.label || `Étape ${i+1}`, '', '', '', '', wp.lat, wp.lon, t.name, livName, 'etape']);
            });
        }
        // Ligne d'arrivée selon le mode de fin
        const endPt = terrainResolveEndPoint(t);
        if(endPt){
            const endType = t.endMode === 'custom' ? 'arrivee_perso' : 'retour_depot';
            const endLabel = t.endMode === 'custom' ? 'Point d\'arrivée' : (terrainDepot && terrainDepot.label ? terrainDepot.label : 'Dépôt');
            rows.push([++ordre, 'END_' + endType.toUpperCase(), endLabel, '', '', '', '', endPt.lat, endPt.lon, t.name, livName, endType]);
        }
        return rows.map(r => r.map(terrainCsvEscape).join(';')).join('\n');
    }

    window.terrainExportTourCSV = function(id){
        const t = terrainTours.find(t => t.id === id); if(!t) return;
        terrainDownload(`tournee_${t.name.replace(/[^a-z0-9]+/gi,'_')}.csv`, terrainTourCSV(t), 'text/csv;charset=utf-8');
    };
    window.terrainExportTourJSON = function(id){
        const t = terrainTours.find(t => t.id === id); if(!t) return;
        const livreurs = terrainGetLivreurs();
        const liv = livreurs.find(l => String(l.id) === String(t.livreurId));
        const order = t.order && t.order.length ? t.order : t.barcodes;
        const endPt = terrainResolveEndPoint(t);
        const obj = {
            tournee: t.name,
            livreurId: t.livreurId,
            livreur: liv ? `${liv.prenom || ''} ${liv.nom || ''}`.trim() : null,
            depot: terrainDepot ? { latitude: terrainDepot.lat, longitude: terrainDepot.lon, label: terrainDepot.label || null } : null,
            finTournee: {
                mode: t.endMode || 'none',   // 'depot' | 'none' | 'custom'
                pointArrivee: endPt ? { latitude: endPt.lat, longitude: endPt.lon } : null
            },
            etapesIntermediaires: (t.waypoints || []).map((wp, i) => ({
                ordre: i + 1,
                latitude: wp.lat,
                longitude: wp.lon,
                label: wp.label || null
            })),
            distanceKm: +terrainTourDistance(t).toFixed(2),
            colis: order.map((bc, idx) => {
                const p = terrainPoints.find(pp => pp.barcode === bc) || {};
                return { ordre: idx + 1, barcode: bc, nom: p.nom, telephone: p.tel,
                         adresse: p.adresse, code_postal: p.cp, ville: p.ville,
                         latitude: p.lat, longitude: p.lon };
            })
        };
        terrainDownload(`tournee_${t.name.replace(/[^a-z0-9]+/gi,'_')}.json`, JSON.stringify(obj, null, 2), 'application/json');
    };
    window.terrainExportAll = function(){
        if(!terrainTours.length) return;
        const livreurs = terrainGetLivreurs();
        const all = terrainTours.map(t => {
            const liv = livreurs.find(l => String(l.id) === String(t.livreurId));
            const order = t.order && t.order.length ? t.order : t.barcodes;
            const endPt = terrainResolveEndPoint(t);
            return {
                tournee: t.name,
                livreurId: t.livreurId,
                livreur: liv ? `${liv.prenom || ''} ${liv.nom || ''}`.trim() : null,
                finTournee: {
                    mode: t.endMode || 'none',
                    pointArrivee: endPt ? { latitude: endPt.lat, longitude: endPt.lon } : null
                },
                distanceKm: +terrainTourDistance(t).toFixed(2),
                colis: order.map((bc, idx) => {
                    const p = terrainPoints.find(pp => pp.barcode === bc) || {};
                    return { ordre: idx + 1, barcode: bc, nom: p.nom, telephone: p.tel,
                             adresse: p.adresse, code_postal: p.cp, ville: p.ville,
                             latitude: p.lat, longitude: p.lon };
                })
            };
        });
        const payload = {
            depot: terrainDepot ? { latitude: terrainDepot.lat, longitude: terrainDepot.lon, label: terrainDepot.label || null } : null,
            tournees: all
        };
        terrainDownload('toutes_tournees.json', JSON.stringify(payload, null, 2), 'application/json');
    };

    window.terrainResetAll = function(){
        if(!confirm('Tout effacer (points + tournées + zone) ? Cette action est irréversible.')) return;
        terrainPoints = [];
        terrainPending = [];
        terrainTours = [];
        terrainTourId = 0;
        terrainResetZone(false);
        terrainMarkersLayer.clearLayers();
        if(terrainTourMarkersLayer) terrainTourMarkersLayer.clearLayers();
        Object.values(terrainTourLines).forEach(l => { try { terrainMap.removeLayer(l); } catch(e){} });
        terrainTourLines = {};
        // Nettoyer aussi le localStorage Terrain (tournées + points), garder dépôt et livrés
        try {
            localStorage.removeItem('terrain_tours_v1');
            localStorage.removeItem('terrain_points_v1');
        } catch(e){}
        document.getElementById('terrain-dropLabel').textContent = 'Glissez le fichier EPOD ici ou cliquez';
        document.getElementById('terrain-btnGeocode').style.display = 'none';
        terrainRefreshTourList();
        terrainUpdateStats();
        terrainEnableButtons();
        terrainSetStatus('Tout a été effacé.', 'info');
    };

    // ═══════════ SCANNER DE CODES-BARRES ═══════════
    let terrainScannerLibLoaded = false;
    let terrainScannerLibLoading = null; // Promise en cours

    // Charge la librairie html5-qrcode à la demande
    function terrainLoadScannerLib(){
        if(terrainScannerLibLoaded) return Promise.resolve(true);
        if(typeof Html5Qrcode !== 'undefined'){
            terrainScannerLibLoaded = true;
            return Promise.resolve(true);
        }
        if(terrainScannerLibLoading) return terrainScannerLibLoading;
        terrainScannerLibLoading = loadScriptOnce(CONFIG.libs.html5Qrcode, () => typeof Html5Qrcode !== 'undefined')
            .then(() => { terrainScannerLibLoaded = typeof Html5Qrcode !== 'undefined'; return terrainScannerLibLoaded; })
            .catch(() => { terrainScannerLibLoading = null; return false; });
        return terrainScannerLibLoading;
    }

    // Met à jour le panneau diagnostic
    function terrainUpdateDiag(state){
        const grid = document.getElementById('terrain-scanDiagGrid');
        if(!grid) return;
        const fmt = (val, cls) => `<div class="${cls || ''}">${val}</div>`;
        const ok  = (v) => fmt(v, 'ok');
        const ko  = (v) => fmt(v, 'ko');
        const warn = (v) => fmt(v, 'warn');
        const rows = [];
        // Contexte sécurisé
        rows.push(['<div>Contexte sécurisé (HTTPS)</div>', state.secureCtx ? ok('✓ Oui') : ko('✗ Non — caméra bloquée')]);
        // Protocole
        rows.push(['<div>Protocole</div>', fmt(location.protocol)]);
        // API getUserMedia
        rows.push(['<div>API caméra</div>', state.hasGetUserMedia ? ok('✓ Disponible') : ko('✗ Indisponible')]);
        // Librairie
        rows.push(['<div>Librairie html5-qrcode</div>', state.libLoaded ? ok('✓ Chargée') : (state.libLoading ? warn('⋯ Chargement') : ko('✗ Non chargée'))]);
        // Permission
        if(state.permission) rows.push(['<div>Permission caméra</div>',
            state.permission === 'granted' ? ok('✓ Accordée') :
            state.permission === 'denied' ? ko('✗ Refusée') :
            warn(terrainEscHTML(state.permission))]);
        // Plateforme
        rows.push(['<div>Navigateur</div>', fmt(terrainEscHTML(state.ua || '—'))]);
        if(state.error) rows.push(['<div>Erreur</div>', ko(terrainEscHTML(state.error))]);
        grid.innerHTML = rows.map(r => r.join('')).join('');
    }

    // Diagnostic complet : retourne un objet d'état
    async function terrainRunDiag(){
        const state = {
            secureCtx: window.isSecureContext === true,
            hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
            libLoaded: typeof Html5Qrcode !== 'undefined',
            libLoading: !!terrainScannerLibLoading && !terrainScannerLibLoaded,
            permission: null,
            ua: (navigator.userAgent || '').match(/(Chrome|Firefox|Safari|Edge|Opera|Samsung)\/\S+/)?.[0] || 'unknown',
            error: null
        };
        // Permission API (pas dispo partout)
        if(navigator.permissions && navigator.permissions.query){
            try {
                const p = await navigator.permissions.query({ name: 'camera' });
                state.permission = p.state;
            } catch(e){ /* certains navigateurs n'ont pas 'camera' comme nom valide */ }
        }
        return state;
    }

    window.terrainOpenScanner = async function(){
        const modal = document.getElementById('terrain-scanModal');
        const err = document.getElementById('terrain-scanError');
        const manualInput = document.getElementById('terrain-scanManualInput');
        if(!modal) return;

        // Toujours afficher la modale immédiatement (même si le scan échoue, la saisie manuelle marchera)
        modal.classList.add('open');
        err.style.display = 'none';
        manualInput.value = '';
        // Focus auto pour permettre saisie immédiate ou clic sur la caméra
        setTimeout(() => {
            if(window.innerWidth >= 700) manualInput.focus();
        }, 200);

        // Lancer le diagnostic et essayer de démarrer la caméra
        const state = await terrainRunDiag();
        terrainUpdateDiag(state);

        // Vérifications préalables
        if(!state.secureCtx){
            terrainShowScanError(
                `<b>Contexte non sécurisé</b> — La caméra est bloquée car la page n'est pas servie en HTTPS.<br>` +
                `Vous avez quand même la saisie manuelle ci-dessous. Pour la caméra, hébergez l'app sur HTTPS ` +
                `(ou utilisez <code>http://localhost</code> en développement).`
            );
            return;
        }
        if(!state.hasGetUserMedia){
            terrainShowScanError(
                `<b>API caméra indisponible</b> dans ce navigateur. Utilisez la saisie manuelle.`
            );
            return;
        }

        // Charger la librairie si pas encore fait
        if(!state.libLoaded){
            terrainUpdateDiag({ ...state, libLoading: true });
            const okLoad = await terrainLoadScannerLib();
            const newState = await terrainRunDiag();
            terrainUpdateDiag(newState);
            if(!okLoad){
                terrainShowScanError(
                    `<b>Librairie de scan introuvable</b>. Vérifiez votre connexion Internet ou utilisez la saisie manuelle.`
                );
                return;
            }
        }

        // Démarrer la caméra
        await terrainStartCamera();
    };

    window.terrainCloseScanner = function(){
        terrainStopCamera();
        const modal = document.getElementById('terrain-scanModal');
        if(modal) modal.classList.remove('open');
    };

    async function terrainStartCamera(){
        const container = document.getElementById('terrain-scanCamera');
        if(!container) return;
        // Vider et préparer le conteneur (un id unique par instance pour éviter les conflits)
        container.innerHTML = '<div id="terrain-scanCameraInner"></div>';

        if(typeof Html5Qrcode === 'undefined'){
            terrainShowScanError('Librairie non disponible. Utilisez la saisie manuelle.');
            return;
        }
        try {
            terrainScanner = new Html5Qrcode('terrain-scanCameraInner', { verbose: false });
            terrainScannerActive = true;
            await terrainScanner.start(
                { facingMode: 'environment' },
                {
                    fps: 10,
                    qrbox: function(viewW, viewH){
                        // qrbox adaptatif : 80% de la largeur, ratio 5:3 pour les codes-barres
                        const w = Math.floor(Math.min(viewW, viewH) * 0.8);
                        return { width: w, height: Math.floor(w * 0.6) };
                    },
                    aspectRatio: 1.0
                },
                (decodedText) => terrainOnScanSuccess(decodedText),
                () => { /* échecs silencieux par frame */ }
            );
            // Mettre à jour le diag après démarrage réussi
            const state = await terrainRunDiag();
            terrainUpdateDiag(state);
        } catch(err){
            terrainScannerActive = false;
            console.warn('[Terrain] caméra erreur:', err);
            const msg = (err && err.message) || String(err);
            // Mettre l'erreur dans le diag
            const state = await terrainRunDiag();
            terrainUpdateDiag({ ...state, error: msg });
            // Message lisible selon le type d'erreur
            let userMsg;
            if(/permission|denied|notallowed/i.test(msg)){
                userMsg = `<b>Permission caméra refusée</b>. Autorisez la caméra dans les réglages de votre navigateur, ou utilisez la saisie manuelle.`;
            } else if(/notfound|devicenotfound/i.test(msg)){
                userMsg = `<b>Aucune caméra détectée</b> sur cet appareil. Utilisez la saisie manuelle.`;
            } else if(/notreadable|aborterror/i.test(msg)){
                userMsg = `<b>Caméra inaccessible</b> (peut-être utilisée par une autre app). Fermez les autres apps et réessayez, ou utilisez la saisie manuelle.`;
            } else {
                userMsg = `<b>Caméra impossible à démarrer</b>. Détail : <code>${terrainEscHTML(msg)}</code>. Utilisez la saisie manuelle.`;
            }
            terrainShowScanError(userMsg);
        }
    }

    function terrainStopCamera(){
        if(terrainScanner && terrainScannerActive){
            terrainScanner.stop().then(() => {
                try { terrainScanner.clear(); } catch(e){}
                terrainScannerActive = false;
            }).catch(() => { terrainScannerActive = false; });
        }
        terrainScanner = null;
    }

    function terrainShowScanError(msg){
        const err = document.getElementById('terrain-scanError');
        if(err){ err.style.display = ''; err.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ' + msg; }
    }

    function terrainOnScanSuccess(decodedText){
        // Stopper la caméra dès qu'on a un résultat
        terrainStopCamera();
        terrainLookupBarcode(decodedText, true);
    }

    window.terrainSubmitManualScan = function(){
        const input = document.getElementById('terrain-scanManualInput');
        if(!input) return;
        const v = input.value.trim();
        if(!v){ input.focus(); return; }
        terrainLookupBarcode(v, false);
    };

    // Permettre Entrée pour soumettre la saisie manuelle (attaché via délégation dans terrainInit serait mieux,
    // mais on l'attache au moment de l'ouverture pour éviter les soucis de timing)
    document.addEventListener('keydown', (e) => {
        if(e.key !== 'Enter') return;
        const modal = document.getElementById('terrain-scanModal');
        if(!modal || !modal.classList.contains('open')) return;
        const input = document.getElementById('terrain-scanManualInput');
        if(document.activeElement === input){
            e.preventDefault();
            window.terrainSubmitManualScan();
        }
    });

    // Cherche un colis par code-barres et ouvre la modale détails
    function terrainLookupBarcode(rawBarcode, fromCamera){
        const cleaned = String(rawBarcode).trim();
        // Recherche stricte d'abord, puis tolérante (sous-chaîne)
        let p = terrainPoints.find(pp => pp.barcode === cleaned);
        if(!p) p = terrainPoints.find(pp => String(pp.barcode).toLowerCase() === cleaned.toLowerCase());
        if(!p) p = terrainPoints.find(pp => String(pp.barcode).includes(cleaned) || cleaned.includes(String(pp.barcode)));

        if(!p){
            // Pas trouvé
            terrainShowScanError(`<b>Colis introuvable</b> : <span style="font-family:monospace">${terrainEscHTML(cleaned)}</span><br>Vérifiez que ce colis est bien dans le fichier importé.`);
            // Si on venait de la caméra, on la relance pour réessayer
            if(fromCamera) setTimeout(() => terrainStartCamera(), 1500);
            return;
        }

        terrainCloseScanner();
        // Identifier la tournée du colis (s'il en a une)
        let info = null;
        for(const t of terrainTours){
            const order = t.order && t.order.length ? t.order : t.barcodes;
            const idx = order.indexOf(p.barcode);
            if(idx >= 0){ info = { tour: t, pos: idx + 1 }; break; }
        }
        terrainShowColisModal(p, info);
        // Zoom et highlight sur la carte
        terrainMap.setView([p.lat, p.lon], Math.max(terrainMap.getZoom(), 16), { animate: true });
    }

    // ═══════════ MODALE DÉTAILS COLIS ═══════════
    window.terrainShowColisModal = function(p, info){
        const modal = document.getElementById('terrain-colisModal');
        const body = document.getElementById('terrain-colisModalBody');
        const actions = document.getElementById('terrain-colisModalActions');
        const head = document.getElementById('terrain-colisModalHead');
        if(!modal || !body) return;

        const tel = terrainCleanPhone(p.tel);
        const email = terrainCleanEmail(p.email);
        const adr = terrainBuildAddressString(p);
        const nomReel = p.nom && !/^[*\s]+$/.test(p.nom) ? p.nom : '';
        const isDelivered = terrainDeliveredSet.has(p.barcode);
        // Détecter si toutes les infos personnelles sont anonymisées
        const allPersonalAnonymized = !nomReel && !tel && !email;

        // En-tête : barcode bien visible
        head.innerHTML = `<div><i class="fas fa-box"></i> <span style="font-family:monospace">${terrainEscHTML(p.barcode)}</span></div>
            <button type="button" class="terrain-modal-close" onclick="terrainCloseColisModal()">×</button>`;

        // Corps : tableau infos
        let html = '';

        // Bandeau RGPD si toutes les infos personnelles sont anonymisées
        if(allPersonalAnonymized){
            html += `<div class="terrain-rgpd-banner">
                <i class="fas fa-shield-alt"></i>
                <div>
                    <b>Données personnelles protégées</b><br>
                    <small>Le nom, téléphone et email du destinataire sont anonymisés dans le fichier source pour des raisons RGPD. Récupérez ces informations dans votre système métier avec le numéro de tracking ci-dessus.</small>
                </div>
            </div>`;
        }

        const row = (icon, lbl, val, iconClass) => `
            <div class="terrain-colis-row">
                <div class="ico ${iconClass || ''}"><i class="${icon}"></i></div>
                <div style="flex:1;min-width:0">
                    <div class="lbl">${lbl}</div>
                    <div class="val">${val}</div>
                </div>
            </div>`;
        const rowMono = (icon, lbl, val, iconClass) => `
            <div class="terrain-colis-row">
                <div class="ico ${iconClass || ''}"><i class="${icon}"></i></div>
                <div style="flex:1;min-width:0">
                    <div class="lbl">${lbl}</div>
                    <div class="val mono">${val}</div>
                </div>
            </div>`;

        // 1. TOURNÉE + ORDRE
        if(info){
            html += row('fas fa-route', 'Tournée',
                `<span class="tour-pill" style="background:${terrainEscHTML(info.tour.color)}">${terrainEscHTML(info.tour.name)} &middot; arrêt #${info.pos} / ${info.tour.barcodes.length}</span>`);
            const livreurs = terrainGetLivreurs();
            const liv = livreurs.find(l => String(l.id) === String(info.tour.livreurId));
            if(liv){
                html += row('fas fa-user-tag', 'Livreur', terrainEscHTML(`${liv.prenom || ''} ${liv.nom || ''}`.trim()));
            }
        } else {
            html += row('fas fa-exclamation-circle', 'Tournée', '<span class="muted">Non assigné à une tournée</span>', 'warning');
        }

        // 2. INFOS CLIENT
        html += row('fas fa-user', 'Destinataire',
            nomReel ? `<b>${terrainEscHTML(nomReel)}</b>`
                    : '<span class="muted"><i class="fas fa-lock" style="font-size:10px"></i> Anonymisé (RGPD)</span>');
        html += row('fas fa-map-marker-alt', 'Adresse',
            adr ? terrainEscHTML(adr) : '<span class="muted">Non renseignée</span>');
        if(tel) html += rowMono('fas fa-phone', 'Téléphone', terrainEscHTML(tel));
        else    html += row('fas fa-phone', 'Téléphone',
            (p.tel && /^[*\s]+$/.test(p.tel))
                ? '<span class="muted"><i class="fas fa-lock" style="font-size:10px"></i> Anonymisé (RGPD)</span>'
                : '<span class="muted">Non renseigné</span>');
        if(email) html += rowMono('fas fa-envelope', 'Email', terrainEscHTML(email));
        else      html += row('fas fa-envelope', 'Email',
            (p.email && /^[*\s]+$/.test(p.email))
                ? '<span class="muted"><i class="fas fa-lock" style="font-size:10px"></i> Anonymisé (RGPD)</span>'
                : '<span class="muted">Non renseigné</span>');

        // 3. ÉTAT LIVRÉ
        if(isDelivered)
            html += row('fas fa-check-circle', 'État', '<b style="color:#16a34a">Marqué livré</b>', 'success');

        body.innerHTML = html;

        // Boutons d'action
        let act = '';
        if(tel)   act += `<a class="terrain-action-btn call" href="tel:${encodeURIComponent(tel)}"><i class="fas fa-phone"></i> Appeler</a>`;
        else      act += `<button class="terrain-action-btn" disabled><i class="fas fa-phone"></i> Pas de tél</button>`;
        act += `<a class="terrain-action-btn nav" href="${terrainNavURL(p)}" target="_blank" rel="noopener"><i class="fas fa-route"></i> Itinéraire</a>`;
        if(tel)   act += `<a class="terrain-action-btn sms" href="sms:${encodeURIComponent(tel)}"><i class="fas fa-sms"></i> SMS</a>`;
        else      act += `<button class="terrain-action-btn" disabled><i class="fas fa-sms"></i> Pas de SMS</button>`;
        if(email) act += `<a class="terrain-action-btn email" href="mailto:${encodeURIComponent(email)}"><i class="fas fa-envelope"></i> Email</a>`;
        else      act += `<button class="terrain-action-btn" disabled><i class="fas fa-envelope"></i> Pas d'email</button>`;
        // Bouton marquer livré (sur 2 colonnes)
        if(isDelivered){
            act += `<button class="terrain-action-btn delivered is-done" onclick="terrainToggleDelivered('${escJsAttr(p.barcode)}')"><i class="fas fa-check-circle"></i> Livré — Annuler</button>`;
        } else {
            act += `<button class="terrain-action-btn delivered" onclick="terrainToggleDelivered('${escJsAttr(p.barcode)}')"><i class="fas fa-check"></i> Marquer comme livré</button>`;
        }
        actions.innerHTML = act;

        modal.classList.add('open');
    };

    window.terrainCloseColisModal = function(){
        const modal = document.getElementById('terrain-colisModal');
        if(modal) modal.classList.remove('open');
    };

    window.terrainToggleDelivered = function(barcode){
        if(terrainDeliveredSet.has(barcode)) terrainDeliveredSet.delete(barcode);
        else terrainDeliveredSet.add(barcode);
        // Persistance
        try {
            localStorage.setItem('terrain_delivered_v1', JSON.stringify([...terrainDeliveredSet]));
        } catch(e){}
        // Rafraîchir la modale et la carte
        const p = terrainPoints.find(pp => pp.barcode === barcode);
        if(p){
            let info = null;
            for(const t of terrainTours){
                const order = t.order && t.order.length ? t.order : t.barcodes;
                const idx = order.indexOf(p.barcode);
                if(idx >= 0){ info = { tour: t, pos: idx + 1 }; break; }
            }
            terrainShowColisModal(p, info);
        }
        terrainDrawAllPoints();
    };

    // ═══════════ API EXPOSÉE POUR LE MODULE SCAN ═══════════
    // Permet au module Mode Scan d'accéder aux données et fonctions sans dupliquer la logique
    window.terrainAPI = {
        // Données
        getPoints: () => terrainPoints,
        getTours: () => terrainTours,
        getDepot: () => terrainDepot,
        getDelivered: () => terrainDeliveredSet,
        getLivreurs: () => terrainGetLivreurs(),

        // Cherche un colis par code-barres (tolérant)
        findByBarcode: (raw) => {
            const cleaned = String(raw).trim();
            let p = terrainPoints.find(pp => pp.barcode === cleaned);
            if(!p) p = terrainPoints.find(pp => String(pp.barcode).toLowerCase() === cleaned.toLowerCase());
            if(!p) p = terrainPoints.find(pp => String(pp.barcode).includes(cleaned) || cleaned.includes(String(pp.barcode)));
            return p || null;
        },

        // Renvoie {tour, pos, total} pour un colis donné (ou null si pas dans une tournée)
        getTourInfo: (barcode) => {
            for(const t of terrainTours){
                const order = t.order && t.order.length ? t.order : t.barcodes;
                const idx = order.indexOf(barcode);
                if(idx >= 0) return { tour: t, pos: idx + 1, total: order.length };
            }
            return null;
        },

        // Bascule marqué/non marqué livré
        toggleDelivered: (barcode) => {
            window.terrainToggleDelivered(barcode);
        },
        isDelivered: (barcode) => terrainDeliveredSet.has(barcode),

        // Zoom sur la carte vers un point (utilisé depuis le scan pour "Voir sur carte")
        zoomToPoint: (lat, lon, zoom) => {
            if(!terrainMap) return;
            terrainMap.setView([lat, lon], zoom || 17, { animate: true });
        },

        // Helpers utiles
        buildAddress: (p) => terrainBuildAddressString(p)
    };
})();
