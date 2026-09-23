        // ============== DRAG & DROP ==============
        function handleDragStart(e, secteur, fromLivreurId, colis) {
            draggedElement = e.target;
            draggedData = { secteur, fromLivreurId, colis };
            e.target.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        }

        function handleDragEnd(e) {
            e.target.classList.remove('dragging');
            document.querySelectorAll('.livreur-drop-zone').forEach(z => z.classList.remove('drag-over'));
            draggedElement = null;
            draggedData = null;
        }

        function handleDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            e.currentTarget.classList.add('drag-over');
        }

        function handleDragLeave(e) {
            e.currentTarget.classList.remove('drag-over');
        }

        function handleDrop(e) {
            e.preventDefault();
            e.currentTarget.classList.remove('drag-over');
            if (!draggedData) return;
            const toLivreurId = e.currentTarget.dataset.livreurId;
            const { secteur, fromLivreurId } = draggedData;
            if (fromLivreurId === toLivreurId) return;

            if (fromLivreurId !== 'unassigned') {
                const fromLivreur = data.livreurs.find(l => l.id === fromLivreurId);
                if (fromLivreur) fromLivreur.secteurs_prioritaires = fromLivreur.secteurs_prioritaires.filter(s => s !== secteur);
            }
            if (toLivreurId !== 'unassigned') {
                const toLivreur = data.livreurs.find(l => l.id === toLivreurId);
                if (toLivreur && !toLivreur.secteurs_prioritaires.includes(secteur)) toLivreur.secteurs_prioritaires.push(secteur);
            }
            markUnsaved();
            updateDragDropUI();
            updateUI();
            const livreurName = toLivreurId === 'unassigned' ? 'Non assigné' : data.livreurs.find(l => l.id === toLivreurId)?.nom;
            showToast(`${secteur} → ${livreurName}`, 'info');
        }

        function addSecteurToLivreur(livreurId) {
            const input = document.getElementById(`addSecteur_${livreurId}`);
            if (!input) return;
            const secteur = input.value.trim();
            if (!secteur) return;
            const livreur = data.livreurs.find(l => l.id === livreurId);
            if (livreur && !livreur.secteurs_prioritaires.includes(secteur)) {
                livreur.secteurs_prioritaires.push(secteur);
                input.value = '';
                markUnsaved();
                updateDragDropUI();
                updateUI();
                showToast(`${secteur} ajouté à ${livreur.nom}`, 'success');
            }
        }

        function removeSecteur(livreurId, secteur) {
            const livreur = data.livreurs.find(l => l.id === livreurId);
            if (livreur) {
                livreur.secteurs_prioritaires = livreur.secteurs_prioritaires.filter(s => s !== secteur);
                markUnsaved();
                updateDragDropUI();
                updateUI();
            }
        }

        function updateDragDropUI() {
            const container = document.getElementById('dragDropContainer');
            if (!container) return;
            const prevs = data.previsions[selectedDate] || [];
            const prevsMap = {};
            prevs.forEach(p => prevsMap[p.code_postal] = p.colis);

            const assignedSecteurs = new Set();
            data.livreurs.forEach(l => l.secteurs_prioritaires.forEach(s => assignedSecteurs.add(s)));
            const unassigned = prevs.filter(p => !assignedSecteurs.has(p.code_postal));

            document.getElementById('unassignedSecteurs').innerHTML = unassigned.length > 0
                ? unassigned.map(p => `<div class="secteur-draggable" style="background: #94A3B8;" draggable="true" ondragstart="handleDragStart(event, '${escJsAttr(p.code_postal)}', 'unassigned', ${safeNum(p.colis)})" ondragend="handleDragEnd(event)">${escapeHtml(p.code_postal)}<span class="secteur-colis">${escapeHtml(p.colis)}</span></div>`).join('')
                : '<span style="color: var(--text-secondary); font-size: 0.85rem;">Aucun secteur non assigné</span>';
            document.getElementById('unassignedCount').textContent = `${unassigned.length} secteur${unassigned.length > 1 ? 's' : ''}`;

            container.innerHTML = data.livreurs.filter(l => l.actif).map(livreur => {
                const secteurs = livreur.secteurs_prioritaires;
                const totalColis = secteurs.reduce((acc, s) => acc + (prevsMap[s] || 0), 0);
                const statusClass = totalColis === 0 ? '' : (totalColis < 90 ? 'warning' : (totalColis > 160 ? 'danger' : 'optimal'));
                return `
                    <div class="livreur-drop-zone" data-livreur-id="${escapeHtml(livreur.id)}" ondragover="handleDragOver(event)" ondrop="handleDrop(event)" ondragleave="handleDragLeave(event)">
                        <div class="drop-zone-header">
                            <div class="drop-zone-avatar" style="background: ${getLivreurColor(livreur.id)};">${escapeHtml(livreur.nom[0])}</div>
                            <div class="drop-zone-info">
                                <div class="drop-zone-name">${escapeHtml(livreur.nom)}${livreur.prenom ? " " + escapeHtml(livreur.prenom) : ""}</div>
                                <div class="drop-zone-count">${secteurs.length} secteur${secteurs.length > 1 ? 's' : ''}</div>
                            </div>
                            <div class="drop-zone-stats">
                                <div class="drop-zone-total ${statusClass}">${escapeHtml(totalColis)}</div>
                                <div style="font-size: 0.7rem; color: var(--text-secondary);">colis</div>
                            </div>
                        </div>
                        <div class="secteurs-drop-area">
                            ${secteurs.map(s => `<div class="secteur-draggable" style="background: ${getLivreurColor(livreur.id)}; box-shadow: 0 1px 4px ${getLivreurColor(livreur.id)}40;" draggable="true" ondragstart="handleDragStart(event, '${escJsAttr(s)}', '${escJsAttr(livreur.id)}', ${safeNum(prevsMap[s] || 0)})" ondragend="handleDragEnd(event)">${escapeHtml(s)}${prevsMap[s] ? `<span class="secteur-colis">${escapeHtml(prevsMap[s])}</span>` : ''}<button class="remove-secteur" onclick="removeSecteur('${escJsAttr(livreur.id)}', '${escJsAttr(s)}')" title="Retirer">×</button></div>`).join('') || '<span style="color: var(--text-secondary); font-size: 0.85rem;">Glissez des secteurs ici</span>'}
                        </div>
                        <div class="add-secteur-inline">
                            <input type="text" id="addSecteur_${escapeHtml(livreur.id)}" placeholder="+ Ajouter secteur" onkeypress="if(event.key==='Enter'){addSecteurToLivreur('${escJsAttr(livreur.id)}');event.preventDefault();}">
                            <button class="btn btn-sm btn-primary" onclick="addSecteurToLivreur('${escJsAttr(livreur.id)}')">+</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // ============== DISTRIBUTION ==============
        function calculerDistribution() {
            if (!confirmDateBeforeSave()) return;

            const prevs = data.previsions[selectedDate] || [];
            if (prevs.length === 0) {
                showToast('Aucune prévision pour cette date', 'error');
                return;
            }
            const livreursActifs = data.livreurs.filter(l => l.actif);
            const prevsMap = {};
            prevs.forEach(p => prevsMap[p.code_postal] = p.colis);

            let totalColis = 0, totalLivreurs = 0, sousMin = 0, auDessusMax = 0;
            livreursActifs.forEach(l => {
                const total = l.secteurs_prioritaires.reduce((acc, s) => acc + (prevsMap[s] || 0), 0);
                if (total > 0) {
                    totalLivreurs++;
                    totalColis += total;
                    if (total < data.paramètres.min_colis) sousMin++;
                    if (total > data.paramètres.max_colis) auDessusMax++;
                }
            });

            const moyenne = totalLivreurs > 0 ? Math.round(totalColis / totalLivreurs) : 0;
            document.getElementById('distributionStats').innerHTML = `
                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; margin-bottom: 1.5rem;">
                    <div class="stat-card"><div class="stat-value">${escapeHtml(totalColis)}</div><div class="stat-label">Total colis</div></div>
                    <div class="stat-card"><div class="stat-value">${totalLivreurs}</div><div class="stat-label">Livreurs actifs</div></div>
                    <div class="stat-card"><div class="stat-value">${escapeHtml(moyenne)}</div><div class="stat-label">Moyenne</div></div>
                </div>
                ${sousMin > 0 ? `<div class="alert alert-warning"><i class="fas fa-exclamation-triangle"></i> ${sousMin} livreur(s) sous ${escapeHtml(data.paramètres.min_colis)} colis</div>` : ''}
                ${auDessusMax > 0 ? `<div class="alert alert-danger"><i class="fas fa-exclamation-circle"></i> ${auDessusMax} livreur(s) au-dessus de ${escapeHtml(data.paramètres.max_colis)} colis</div>` : ''}
            `;
            showToast('Distribution calculée', 'success');
        }

        // ============== UI UPDATES ==============
        function updateUI() {
            updatePlanningAlert();
            updateStats();
            updateLivreursPreview();
            updateLivreursGrid();
            updatePrevisions();
            updateParameters();
            updateSaveHistory();
            updateDragDropUI();
            updateRapportDate();
            refreshHistorique();
        }

        function updateStats() {
            const livreursActifs = data.livreurs.filter(l => l.actif);
            const totalSecteurs = data.livreurs.reduce((acc, l) => acc + l.secteurs_prioritaires.length, 0);
            document.getElementById('statsGrid').innerHTML = `
                <div class="stat-card"><div class="stat-icon"><i class="fas fa-users" style="color: var(--primary);"></i></div><div class="stat-value">${livreursActifs.length}</div><div class="stat-label">Livreurs actifs</div></div>
                <div class="stat-card"><div class="stat-icon"><i class="fas fa-map-marker-alt" style="color: var(--success);"></i></div><div class="stat-value">${totalSecteurs}</div><div class="stat-label">Secteurs assignés</div></div>
                <div class="stat-card"><div class="stat-icon"><i class="fas fa-bullseye" style="color: var(--warning);"></i></div><div class="stat-value">${escapeHtml(data.paramètres.cible_colis)}</div><div class="stat-label">Cible/tournée</div></div>
                <div class="stat-card"><div class="stat-icon"><i class="fas fa-box" style="color: var(--info);"></i></div><div class="stat-value">${escapeHtml(data.paramètres.min_colis)}-${escapeHtml(data.paramètres.max_colis)}</div><div class="stat-label">Plage colis</div></div>
            `;
        }

        function updateLivreursPreview() {
            const livreursActifs = data.livreurs.filter(l => l.actif);
            document.getElementById('livreursPreview').innerHTML = livreursActifs.map(l => `
                <div style="display: inline-flex; align-items: center; gap: 0.75rem; background: var(--card); padding: 1rem 1.25rem; border-radius: var(--radius-sm); margin: 0.5rem; border: 1px solid var(--border-light); box-shadow: var(--shadow);">
                    <div style="width: 40px; height: 40px; border-radius: 50%; background: var(--primary); display: flex; align-items: center; justify-content: center; font-weight: 700; color: white;">${escapeHtml(l.nom[0])}</div>
                    <div>
                        <div style="font-weight: 700; color: var(--text);">${escapeHtml(l.nom)}${l.prenom ? ' ' + escapeHtml(l.prenom) : ''}</div>
                        <div style="font-size: 0.8rem; color: var(--text-secondary);">${l.secteurs_prioritaires.length} secteurs</div>
                    </div>
                </div>
            `).join('');
        }

        function updateLivreursGrid() {
            const searchTerm = document.getElementById('searchLivreurs')?.value.toLowerCase() || '';
            const filteredLivreurs = data.livreurs.filter(l => 
                l.nom.toLowerCase().includes(searchTerm) || 
                (l.prenom && l.prenom.toLowerCase().includes(searchTerm)) ||
                l.secteurs_prioritaires.some(s => s.includes(searchTerm))
            );

            document.getElementById('livreursGrid').innerHTML = `
                <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 1.5rem;">
                    ${filteredLivreurs.map(l => `
                        <div class="card" data-testid="livreur-card-${escapeHtml(l.id)}">
                            <div style="display: flex; align-items: center; margin-bottom: 1rem;">
                                <div style="width: 60px; height: 60px; border-radius: 50%; background: var(--primary); display: flex; align-items: center; justify-content: center; font-size: 1.5rem; font-weight: 700; color: white; margin-right: 1rem;">${escapeHtml(l.nom[0])}</div>
                                <div style="flex: 1;">
                                    <h3 style="font-size: 1.25rem; color: var(--text); margin-bottom: 0.25rem;">${escapeHtml(l.nom)}${l.prenom ? ' ' + escapeHtml(l.prenom) : ''}</h3>
                                    <p style="color: var(--text-secondary); font-size: 0.9rem;">${l.secteurs_prioritaires.length} secteurs</p>
                                </div>
                                <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 0.25rem;">
                                    <span class="badge ${l.actif ? 'badge-success' : 'badge-danger'}">${l.actif ? 'Actif' : 'Inactif'}</span>
                                    <span class="badge-${l.contrat === 'salarie' ? 'salarie' : 'autoentrepreneur'}">${l.contrat === 'salarie' ? 'Salarié' : (l.contrat === 'autoentrepreneur-vehicule' ? 'AE véhicule entreprise' : 'Auto-entrepreneur')}</span>
                                </div>
                            </div>
                            <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem;">
                                ${l.secteurs_prioritaires.slice(0, 6).map(s => `<span style="background: var(--primary); padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.8rem; color: white; font-weight: 600;">${escapeHtml(s)}</span>`).join('')}
                                ${l.secteurs_prioritaires.length > 6 ? `<span style="background: var(--background); padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.8rem; color: var(--text-secondary);">+${l.secteurs_prioritaires.length - 6}</span>` : ''}
                            </div>
                            <div style="display: flex; gap: 0.5rem; padding-top: 1rem; border-top: 1px solid var(--border-light);">
                                <div style="flex: 1; text-align: center; padding: 0.5rem; background: var(--background); border-radius: var(--radius-sm);">
                                    <div style="font-weight: 700; color: var(--success);">${escapeHtml(l.taux)}€</div>
                                    <div style="font-size: 0.75rem; color: var(--text-secondary);">/${(l.contrat === 'salarie' || l.contrat === 'autoentrepreneur-vehicule') ? 'heure' : 'colis'}</div>
                                </div>
                                <button class="btn btn-warning btn-sm" onclick="editLivreur('${escJsAttr(l.id)}')" data-testid="edit-livreur-${escapeHtml(l.id)}"><i class="fas fa-edit"></i></button>
                                <button class="btn btn-danger btn-sm" onclick="deleteLivreur('${escJsAttr(l.id)}')" data-testid="delete-livreur-${escapeHtml(l.id)}"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        function filterLivreurs() {
            updateLivreursGrid();
        }

        function updatePrevisions() {
            document.getElementById('selectedDate').textContent = selectedDate;
            document.getElementById('prevDate').textContent = selectedDate;
            document.getElementById('previsionDate').textContent = selectedDate;
            const prevs = data.previsions[selectedDate] || [];
            const totalColis = prevs.reduce((acc, p) => acc + p.colis, 0);

            document.getElementById('previsionStats').innerHTML = `
                <div class="stat-card"><div class="stat-value">${prevs.length}</div><div class="stat-label">Secteurs</div></div>
                <div class="stat-card"><div class="stat-value">${escapeHtml(totalColis)}</div><div class="stat-label">Total colis</div></div>
                <div class="stat-card"><div class="stat-value">${prevs.length > 0 ? Math.round(totalColis / prevs.length) : 0}</div><div class="stat-label">Moyenne</div></div>
            `;

            document.getElementById('previsionsList').innerHTML = prevs.length === 0
                ? '<div class="empty-state"><i class="fas fa-inbox"></i><h4>Aucune prévision</h4><p>Importez un fichier Excel/CSV ou ajoutez manuellement des prévisions</p></div>'
                : prevs.map(p => `<div class="prevision-item"><div class="prevision-cp">${escapeHtml(p.code_postal)}</div><div class="prevision-colis">${escapeHtml(p.colis)} colis</div><button class="prevision-delete" onclick="deletePrevision('${escJsAttr(p.id)}')"><i class="fas fa-times"></i></button></div>`).join('');
        }

        function updateParameters() {
            document.getElementById('minColis').value = data.paramètres.min_colis;
            document.getElementById('maxColis').value = data.paramètres.max_colis;
            document.getElementById('cibleColis').value = data.paramètres.cible_colis;
            document.getElementById('limiteColis').value = data.paramètres.limite_exceptionnelle;
        }

        function updateSaveHistory() {
            const history = data.saveHistory || [];
            const localSize = new Blob([localStorage.getItem(STORAGE_KEY) || '']).size;
            document.getElementById('localStorageInfo').textContent = `Dernière: ${data.lastSaved ? new Date(data.lastSaved).toLocaleString('fr-FR') : 'Jamais'} | ${(localSize / 1024).toFixed(1)} Ko`;

            document.getElementById('saveHistory').innerHTML = history.length === 0
                ? '<p style="color: var(--text-secondary); text-align: center; padding: 2rem;">Aucune sauvegarde</p>'
                : history.slice(0, 10).map(h => `
                    <div style="display: flex; align-items: center; gap: 1rem; padding: 1rem; background: var(--card); border-radius: var(--radius-sm); margin-bottom: 0.75rem; border: 1px solid var(--border-light);">
                        <i class="fas fa-hdd" style="color: var(--primary); font-size: 1.25rem;"></i>
                        <div style="flex: 1;">
                            <div style="font-size: 0.95rem; color: var(--text); font-weight: 600;">Stockage Local</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">${new Date(h.date).toLocaleString('fr-FR')}</div>
                        </div>
                    </div>
                `).join('');
        }

        function updateRapportDate() {
            const [year, month, day] = selectedDate.split('-');
            const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
            document.getElementById('rapportDate').textContent = `${parseInt(day)} ${months[parseInt(month) - 1]} ${year}`;
        }

        // ============== NAVIGATION ==============
        function switchTab(tab) {
            document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
            document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.getElementById(`tab-${tab}`).classList.add('active');
            if (tab === 'distribution') updateDragDropUI();
            else if (tab === 'rapport') generateRapport();
            else if (tab === 'controle') { try { ccRenderAll(); } catch (e) { console.warn('[CC]', e); } }
            else if (tab === 'inventaire') { try { invRenderAll(); } catch (e) { console.warn('[INV]', e); } }
            else if (tab === 'sync') { try { renderSnapshots(); } catch (e) { console.warn('[SNAP]', e); } }
        }

        function changeDate(days) {
            const date = new Date(selectedDate);
            date.setDate(date.getDate() + days);
            selectedDate = date.toISOString().split('T')[0];
            updatePrevisions();
            updateDragDropUI();
            document.getElementById('distributionStats').innerHTML = '';
        }

        // ============== MODALS ==============
        function openModal(type) {
            const modalId = `modal${type.charAt(0).toUpperCase() + type.slice(1)}`;
            document.getElementById(modalId)?.classList.add('active');
            if (type === 'dataManager') updateDataManagerList();
            if (type === 'settingsPanel' && typeof preparerSettingsModal === 'function') {
                preparerSettingsModal();
            }
        }

        function closeModal(type) {
            const modalId = `modal${type.charAt(0).toUpperCase() + type.slice(1)}`;
            document.getElementById(modalId)?.classList.remove('active');
        }

        function switchConfigTab(tab) {
            document.querySelectorAll('.config-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.config-tab-content').forEach(c => c.style.display = 'none');
            event.target.classList.add('active');
            document.getElementById(`configTab${tab.charAt(0).toUpperCase() + tab.slice(1)}`).style.display = 'block';
        }

