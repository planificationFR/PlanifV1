
        let mapInstance = null;
        let mapLayers = [];



        function initMap() {
            if (mapInstance) return mapInstance;
            // Verifier que Leaflet est charge
            if (typeof L === 'undefined') {
                console.warn('Leaflet pas encore charge');
                return null;
            }
            // Centre de la carte par defaut
            mapInstance = L.map('map-leaflet', {
                center: [46.8, 2.5],
                zoom: 6,
                zoomControl: true,
                attributionControl: true
            });

            // Tuiles OpenStreetMap principales
            // - retiré crossOrigin (provoquait des blocages CORS sur certains réseaux)
            // - ajout d'un compteur d'erreurs : si trop de tuiles ratent, on bascule sur CartoDB
            const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                maxNativeZoom: 18,
                subdomains: ['a', 'b', 'c'],
                attribution: '© OpenStreetMap'
            });

            let tileErrorCount = 0;
            let switchedToFallback = false;
            osmLayer.on('tileerror', (e) => {
                tileErrorCount++;
                // Si plus de 5 tuiles ratent en moins de 3s, basculer sur fallback
                if (tileErrorCount >= 5 && !switchedToFallback) {
                    switchedToFallback = true;
                    console.warn('[Carte] OSM ne répond pas. Basculement sur CartoDB Positron...');
                    mapInstance.removeLayer(osmLayer);
                    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
                        maxZoom: 19,
                        maxNativeZoom: 18,
                        subdomains: 'abcd',
                        attribution: '© OpenStreetMap, © CartoDB'
                    }).addTo(mapInstance);
                }
            });
            osmLayer.addTo(mapInstance);

            // Reset le compteur toutes les 5 secondes (les pics d'erreurs ponctuels ne déclenchent pas le fallback)
            setInterval(() => { tileErrorCount = 0; }, 5000);

            // Forcer rafraîchissement quand le conteneur change de taille
            setTimeout(() => {
                if (mapInstance) mapInstance.invalidateSize();
            }, 100);

            // Refresh des étiquettes quand le zoom change (debouncé)
            let zoomEndTimer = null;
            mapInstance.on('zoomend', () => {
                if (zoomEndTimer) clearTimeout(zoomEndTimer);
                zoomEndTimer = setTimeout(() => {
                    // On reconstruit les étiquettes mais on garde le viewport actuel
                    const fittedFlag = window._mapHasBeenFitted;
                    window._mapHasBeenFitted = true;  // empêcher le re-fit
                    if (typeof refreshMap === 'function') refreshMap();
                    window._mapHasBeenFitted = fittedFlag;
                }, 150);
            });

            return mapInstance;
        }

        function clearMapLayers() {
            mapLayers.forEach(layer => {
                if (mapInstance && mapInstance.hasLayer(layer)) {
                    mapInstance.removeLayer(layer);
                }
            });
            mapLayers = [];
        }

        function toggleItineraires() {
            window._mapShowItineraires = (typeof window._mapShowItineraires === 'undefined') ? false : !window._mapShowItineraires;
            const btn = document.getElementById('toggleItinerairesBtn');
            if (btn) {
                if (window._mapShowItineraires) {
                    btn.classList.remove('btn-secondary');
                    btn.classList.add('btn-primary');
                } else {
                    btn.classList.remove('btn-primary');
                    btn.classList.add('btn-secondary');
                }
            }
            refreshMap();
        }

        // ============== ATTRIBUTION SECTEUR DEPUIS LA CARTE ==============
        function attribuerSecteurCarte(cp, livreurId) {
            // Si livreurId === '_unassign', on retire l'attribution
            const isUnassign = livreurId === '_unassign';

            // Retirer l'attribution actuelle (si déjà attribué à un livreur)
            data.livreurs.forEach(l => {
                const idx = l.secteurs_prioritaires.indexOf(cp);
                if (idx !== -1) l.secteurs_prioritaires.splice(idx, 1);
            });

            // Attribuer au nouveau livreur (sauf si on désattribue)
            if (!isUnassign) {
                const livreur = data.livreurs.find(l => l.id === livreurId);
                if (!livreur) {
                    showToast('Livreur introuvable', 'error');
                    return;
                }
                if (!livreur.secteurs_prioritaires.includes(cp)) {
                    livreur.secteurs_prioritaires.push(cp);
                }
                showToast(`${cp} attribué à ${livreur.nom}`, 'success');
            } else {
                showToast(`${cp} retiré de l'attribution`, 'info');
            }

            saveLocal();
            // Fermer la popup en cours
            if (typeof mapInstance !== 'undefined' && mapInstance) {
                mapInstance.closePopup();
            }
            // Refresh : carte + UI
            refreshMap();
            updateUI();
        }

        // Génère le HTML d'une popup avec boutons d'attribution
        function genererPopupAttribution(cp, commune, colis, livreurActuel) {
            const livreurs = (data?.livreurs || []).filter(l => l.actif);
            const isAssigned = !!livreurActuel;

            // Header compact : CP + commune sur une seule ligne
            let html = `
                <div class="map-popup" style="font-family: 'Inter', sans-serif; min-width: 180px;">
                    <div style="font-size: 0.95rem; font-weight: 700; color: #1f2937; line-height: 1.2;">
                        ${escapeHtml(cp)} <span style="font-weight: 500; font-size: 0.8rem; color: #6b7280;">· ${escapeHtml(commune)}</span>
                    </div>
            `;
            // Ligne info compacte (livreur actuel ou non attribué) + colis
            const infoParts = [];
            if (isAssigned) {
                const c = getLivreurColor(livreurActuel.id);
                infoParts.push(`<span style="color: ${c}; font-weight: 600;">● ${escapeHtml(livreurActuel.nom)}${livreurActuel.prenom ? ' ' + escapeHtml(livreurActuel.prenom[0]) + '.' : ''}</span>`);
            } else {
                infoParts.push(`<span style="color: #94a3b8; font-style: italic;">Non attribué</span>`);
            }
            if (colis > 0) {
                infoParts.push(`<strong style="color: #1f2937;">${escapeHtml(colis)} colis</strong>`);
            }
            html += `<div style="font-size: 0.78rem; margin-top: 0.2rem; color: #6b7280; display: flex; gap: 0.4rem; align-items: center;">${infoParts.join(' · ')}</div>`;

            // Section attribution compacte
            html += `<div style="margin-top: 0.5rem; padding-top: 0.4rem; border-top: 1px solid rgba(0,0,0,0.08);">
                <div style="font-size: 0.65rem; color: #94a3b8; margin-bottom: 0.3rem; font-weight: 700; letter-spacing: 0.04em;">ATTRIBUER À</div>
                <div style="display: flex; flex-direction: column; gap: 0.2rem;">`;
            if (livreurs.length === 0) {
                html += `<em style="color:#999; font-size:0.75rem;">Aucun livreur actif</em>`;
            } else {
                livreurs.forEach(l => {
                    const isCurrent = livreurActuel && livreurActuel.id === l.id;
                    const c = getLivreurColor(l.id);
                    const nomComplet = l.nom + (l.prenom ? ' ' + l.prenom : '');
                    html += `
                        <button onclick="attribuerSecteurCarte('${escJsAttr(cp)}', '${escJsAttr(l.id)}')"
                                style="display:flex; align-items:center; gap:0.4rem; padding:0.25rem 0.5rem; border:1.5px solid ${c}; background:${isCurrent ? c : 'white'}; color:${isCurrent ? 'white' : c}; border-radius:4px; cursor:pointer; font-weight:600; font-size:0.78rem; text-align:left; line-height:1.3;"
                                ${isCurrent ? 'disabled' : ''}>
                            <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${isCurrent ? 'white' : c}; flex-shrink:0;"></span>
                            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(nomComplet)}</span>
                            ${isCurrent ? '<span style="font-size:0.7rem;">✓</span>' : ''}
                        </button>
                    `;
                });
            }
            // Bouton désattribuer (compact)
            if (isAssigned) {
                html += `
                    <button onclick="attribuerSecteurCarte('${escJsAttr(cp)}', '_unassign')"
                            style="margin-top:0.2rem; display:flex; align-items:center; justify-content:center; gap:0.3rem; padding:0.25rem; border:1px dashed #cbd5e1; background:white; color:#64748b; border-radius:4px; cursor:pointer; font-size:0.72rem;">
                        <i class="fas fa-times" style="font-size:0.7rem;"></i> Retirer
                    </button>
                `;
            }
            html += `</div></div></div>`;
            return html;
        }


        let _mapRetryCount = 0;
        function refreshMap() {
            const map = initMap();
            if (!map) {
                _mapRetryCount++;
                if (_mapRetryCount < 6) {
                    setTimeout(refreshMap, 500);
                } else {
                    const c = document.getElementById('map-leaflet');
                    if (c) {
                        c.innerHTML = `
                            <div style="padding: 3rem 1rem; text-align: center; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-secondary);">
                                <i class="fas fa-wifi" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.4;"></i>
                                <h3 style="color: var(--text); margin-bottom: 0.5rem;">Carte indisponible</h3>
                                <p>Impossible de charger la cartographie. Vérifiez votre connexion internet.</p>
                                <p style="font-size: 0.85rem; margin-top: 0.5rem;">Cliquez sur <strong>Actualiser</strong> une fois reconnecté.</p>
                            </div>
                        `;
                    }
                    _mapRetryCount = 0;
                }
                return;
            }
            _mapRetryCount = 0;
            clearMapLayers();

            const prevs = data.previsions[selectedDate] || [];
            const prevsMap = {};
            prevs.forEach(p => prevsMap[p.code_postal] = p.colis);

            const dateLabelEl = document.getElementById('mapDateLabel');
            if (dateLabelEl && typeof formatDateLong === 'function') {
                dateLabelEl.textContent = formatDateLong(selectedDate);
            }

            const livreursActifs = data.livreurs.filter(l => l.actif);
            const livreurColorMap = {};
            livreursActifs.forEach((l, idx) => { livreurColorMap[l.id] = getLivreurColor(idx); });

            let totalColis = 0;
            const secteursCouverts = new Set();
            const livreursAvecData = [];
            let maxColisPerSecteur = 0;
            livreursActifs.forEach(l => {
                l.secteurs_prioritaires.forEach(cp => {
                    const c = prevsMap[cp] || 0;
                    if (c > maxColisPerSecteur) maxColisPerSecteur = c;
                });
            });
            if (maxColisPerSecteur === 0) maxColisPerSecteur = 1;

            // Pour chaque livreur
            livreursActifs.forEach((livreur, idx) => {
                const color = livreurColorMap[livreur.id];
                const livreurTotalColis = livreur.secteurs_prioritaires.reduce((acc, cp) => acc + (prevsMap[cp] || 0), 0);
                const livreurNomComplet = livreur.nom + (livreur.prenom ? ' ' + livreur.prenom : '');
                livreursAvecData.push({
                    id: livreur.id,
                    nom: livreurNomComplet,
                    secteursCount: livreur.secteurs_prioritaires.length,
                    colis: livreurTotalColis,
                    color: color
                });

                livreur.secteurs_prioritaires.forEach(cp => {
                    const cpData = CP_FR_DATABASE[cp];
                    if (!cpData) {
                        console.warn(`CP ${cp} pas dans la base 68`);
                        return;
                    }
                    const colis = prevsMap[cp] || 0;
                    totalColis += colis;
                    secteursCouverts.add(cp);

                    // Cercle en pixels (taille indépendante du zoom)
                    // Plus de colis = plus gros, mais reste raisonnable même à fond de zoom
                    const radiusPx = 12 + (colis / maxColisPerSecteur) * 14;  // 12 à 26 px
                    const intensity = colis === 0 ? 0.30 : Math.max(0.50, Math.min(0.85, colis / maxColisPerSecteur));

                    const circle = L.circleMarker([cpData.lat, cpData.lng], {
                        radius: radiusPx,
                        color: color,
                        weight: 2.5,
                        opacity: 1,
                        fillColor: color,
                        fillOpacity: intensity
                    }).addTo(map);

                    // Popup avec boutons d'attribution
                    circle.bindPopup(() => genererPopupAttribution(cp, cpData.commune, colis, livreur), { maxWidth: 220 });
                    mapLayers.push(circle);

                    // Étiquettes TOUJOURS visibles
                    // - Au zoom faible : version compacte (juste CP en pastille colorée)
                    // - Au zoom moyen+ : version complète (CP + nb colis)
                    const z = map.getZoom();
                    const showFullLabel = z >= 9;
                    const showCompactLabel = true;

                    if (showCompactLabel) {
                        const labelHtml = showFullLabel ? `
                            <div style="background: white; padding: 4px 9px; border-radius: 6px;
                                        font-size: 11px; border: 2.5px solid ${color};
                                        box-shadow: 0 2px 8px rgba(0,0,0,0.3); text-align: center;
                                        line-height: 1.25; white-space: nowrap;
                                        transform: translate(-50%, -50%); font-family: 'Inter', sans-serif;">
                                <div style="font-weight: 800; color: ${color}; font-size: 12px;">${escapeHtml(cp)}</div>
                                <div style="font-weight: 700; color: #333; font-size: 11px;">${escapeHtml(colis)} colis</div>
                            </div>
                        ` : `
                            <div style="background: white; padding: 2px 6px; border-radius: 4px;
                                        font-size: 10px; border: 2px solid ${color};
                                        box-shadow: 0 1px 4px rgba(0,0,0,0.25);
                                        white-space: nowrap; transform: translate(-50%, -50%);
                                        font-family: 'Inter', sans-serif;
                                        font-weight: 700; color: ${color};">
                                ${escapeHtml(cp)}
                            </div>
                        `;
                        const marker = L.marker([cpData.lat, cpData.lng], {
                            icon: L.divIcon({
                                className: 'cp-marker-rich',
                                html: labelHtml,
                                iconSize: showFullLabel ? [70, 36] : [44, 18],
                                iconAnchor: showFullLabel ? [35, 18] : [22, 9]
                            }),
                            interactive: false,
                            zIndexOffset: 500
                        }).addTo(map);
                        mapLayers.push(marker);
                    }
                });
            });

            // === v41 : Lignes d'itinéraire (polyline reliant les CP du même livreur) ===
            // Approche: pour chaque livreur, on trace une polyline reliant ses CP
            // en utilisant un parcours nearest-neighbor basé sur le centroïde de départ.
            const showItineraires = (typeof window._mapShowItineraires === 'undefined') ? true : window._mapShowItineraires;
            if (showItineraires) {
                livreursActifs.forEach((livreur) => {
                    const color = livreurColorMap[livreur.id];
                    const cpsValides = livreur.secteurs_prioritaires.filter(cp => CP_FR_DATABASE[cp]);
                    if (cpsValides.length < 2) return;

                    // Parcours nearest-neighbor pour ordonner les CP de manière géographique
                    const points = cpsValides.map(cp => ({
                        cp,
                        lat: CP_FR_DATABASE[cp].lat,
                        lng: CP_FR_DATABASE[cp].lng
                    }));
                    // Démarrer par le CP le plus à l'ouest (longitude la plus basse)
                    points.sort((a, b) => a.lng - b.lng);
                    const ordered = [points.shift()];
                    while (points.length > 0) {
                        const last = ordered[ordered.length - 1];
                        let bestIdx = 0;
                        let bestDist = Infinity;
                        for (let i = 0; i < points.length; i++) {
                            const dLat = points[i].lat - last.lat;
                            const dLng = points[i].lng - last.lng;
                            const d = dLat * dLat + dLng * dLng;
                            if (d < bestDist) { bestDist = d; bestIdx = i; }
                        }
                        ordered.push(points.splice(bestIdx, 1)[0]);
                    }
                    const latLngs = ordered.map(p => [p.lat, p.lng]);
                    try {
                        const poly = L.polyline(latLngs, {
                            color: color,
                            weight: 1.5,
                            opacity: 0.45,
                            dashArray: '4, 4',
                            lineCap: 'round',
                            lineJoin: 'round',
                            interactive: false
                        }).addTo(map);
                        // Mettre les polylines en arrière-plan (sous les marqueurs)
                        if (poly.bringToBack) poly.bringToBack();
                        mapLayers.push(poly);
                    } catch (e) {
                        console.warn('Erreur polyline livreur', livreur.id, e);
                    }
                });
            }


            // === Secteurs avec colis prévus mais NON ATTRIBUÉS (en gris) ===
            const assignedCPs = new Set();
            livreursActifs.forEach(l => l.secteurs_prioritaires.forEach(cp => assignedCPs.add(cp)));
            const unassignedCPs = prevs.filter(p => !assignedCPs.has(p.code_postal) && CP_FR_DATABASE[p.code_postal]);

            unassignedCPs.forEach(p => {
                const cpData = CP_FR_DATABASE[p.code_postal];
                const colis = p.colis || 0;
                totalColis += colis;
                secteursCouverts.add(p.code_postal);

                const greyColor = '#94A3B8';
                const radiusPx = 12 + (colis / maxColisPerSecteur) * 14;
                const intensity = colis === 0 ? 0.25 : Math.max(0.35, Math.min(0.55, colis / maxColisPerSecteur));

                const circle = L.circleMarker([cpData.lat, cpData.lng], {
                    radius: radiusPx,
                    color: greyColor,
                    weight: 2.5,
                    opacity: 1,
                    fillColor: greyColor,
                    fillOpacity: intensity,
                    dashArray: '6, 4'
                }).addTo(map);
                circle.bindPopup(() => genererPopupAttribution(p.code_postal, cpData.commune, colis, null), { maxWidth: 220 });
                mapLayers.push(circle);

                const z = map.getZoom();
                const showFullLabel = z >= 9;
                const showCompactLabel = true;

                if (showCompactLabel) {
                    const labelHtml = showFullLabel ? `
                        <div style="background: white; padding: 4px 9px; border-radius: 6px; font-size: 11px;
                                    border: 2.5px dashed ${greyColor}; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                                    text-align: center; line-height: 1.25; white-space: nowrap;
                                    transform: translate(-50%, -50%); font-family: 'Inter', sans-serif;">
                            <div style="font-weight: 800; color: ${greyColor}; font-size: 12px;">${escapeHtml(p.code_postal)}</div>
                            <div style="font-weight: 700; color: #333; font-size: 11px;">${escapeHtml(colis)} colis</div>
                            <div style="font-weight: 600; color: #999; font-size: 9px; margin-top: 1px;">⚠ à attribuer</div>
                        </div>
                    ` : `
                        <div style="background: white; padding: 2px 6px; border-radius: 4px; font-size: 10px;
                                    border: 2px dashed ${greyColor}; box-shadow: 0 1px 4px rgba(0,0,0,0.25);
                                    white-space: nowrap; transform: translate(-50%, -50%);
                                    font-family: 'Inter', sans-serif; font-weight: 700; color: ${greyColor};">
                            ${escapeHtml(p.code_postal)}
                        </div>
                    `;
                    const marker = L.marker([cpData.lat, cpData.lng], {
                        icon: L.divIcon({
                            className: 'cp-marker-rich',
                            html: labelHtml,
                            iconSize: showFullLabel ? [80, 44] : [44, 18],
                            iconAnchor: showFullLabel ? [40, 22] : [22, 9]
                        }),
                        interactive: false,
                        zIndexOffset: 500
                    }).addTo(map);
                    mapLayers.push(marker);
                }
            });

            document.getElementById('mapLivreursCount').textContent = livreursActifs.length;
            document.getElementById('mapSecteursCount').textContent = secteursCouverts.size;
            document.getElementById('mapColisCount').textContent = totalColis;

            // Légende
            const legendGrid = document.getElementById('mapLegendGrid');
            if (livreursAvecData.length === 0) {
                legendGrid.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.85rem;">Aucun livreur à afficher. Ajoutez des livreurs et assignez des secteurs.</span>';
            } else {
                livreursAvecData.sort((a, b) => b.colis - a.colis);
                legendGrid.innerHTML = livreursAvecData.map(l => `
                    <div class="map-legend-item">
                        <div class="map-legend-color" style="background: ${l.color};"></div>
                        <div style="flex: 1;">
                            <div class="map-legend-label">${escapeHtml(l.nom)}</div>
                            <div class="map-legend-stats">${l.secteursCount} secteur(s) · ${escapeHtml(l.colis)} colis</div>
                        </div>
                    </div>
                `).join('');
            }

            // Auto-fit UNIQUEMENT au premier affichage de la carte
            // (sinon ça re-zoom à chaque attribution, c'est désagréable)
            if (mapLayers.length > 0 && !window._mapHasBeenFitted) {
                try {
                    const bounds = L.latLngBounds(
                        mapLayers.filter(l => l.getLatLng).map(l => l.getLatLng())
                    );
                    if (bounds.isValid()) {
                        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 11 });
                        window._mapHasBeenFitted = true;
                    }
                } catch (e) { console.warn('Bounds error', e); }
            }
        }

        // Helper : forcer le re-centrage (bouton "Actualiser" peut s'en servir)
        function recenterMap() {
            window._mapHasBeenFitted = false;
            refreshMap();
        }


        // Hook : quand on clique sur l'onglet Carte, on (re)affiche
        // Modification de switchTab pour declencher refreshMap
        const _originalSwitchTab = window.switchTab;
        window.switchTab = function(tab) {
            _originalSwitchTab.call(this, tab);
            if (tab === 'carte') {
                // Petit delai pour laisser Leaflet se redimensionner correctement
                setTimeout(() => {
                    if (mapInstance) {
                        mapInstance.invalidateSize();
                    }
                    refreshMap();
                }, 200);
            }
        };

        // Hook : apres calculerDistribution, refresh la carte si on est dessus
        if (typeof calculerDistribution === 'function') {
            const _originalCalculer = window.calculerDistribution;
            window.calculerDistribution = function() {
                const result = _originalCalculer.apply(this, arguments);
                // Si l'onglet carte est actif, on rafraichit
                const carteTab = document.getElementById('tab-carte');
                if (carteTab && carteTab.classList.contains('active')) {
                    setTimeout(refreshMap, 100);
                }
                return result;
            };
        }

