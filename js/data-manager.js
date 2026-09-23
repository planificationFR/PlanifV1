        // ============== DATA MANAGER ==============
        function updateDataManagerList() {
            const container = document.getElementById('dataManagerList');
            const months = Object.keys(data.historiqueEPOD || {}).sort().reverse();

            if (months.length === 0) {
                container.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><h4>Aucune importation</h4><p>Importez un fichier EPOD dans l\'onglet Historique</p></div>';
                return;
            }

            container.innerHTML = months.map(monthKey => {
                const monthData = data.historiqueEPOD[monthKey];
                const livreurs = Object.keys(monthData).length;
                const totalColis = Object.values(monthData).reduce((sum, l) => sum + l.totalLivres, 0);
                
                return `
                    <div class="data-item">
                        <div class="data-item-info">
                            <div class="data-item-title">${escapeHtml(formatMonthName(monthKey))}</div>
                            <div class="data-item-meta">${livreurs} livreurs • ${escapeHtml(totalColis)} colis</div>
                        </div>
                        <div class="data-item-actions">
                            <button class="btn btn-sm btn-warning" onclick="editMonthData('${escJsAttr(monthKey)}')"><i class="fas fa-edit"></i></button>
                            <button class="btn btn-sm btn-danger" onclick="deleteMonthData('${escJsAttr(monthKey)}')"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>
                `;
            }).join('');

            // Update livreur select for edit
            const select = document.getElementById('editDataLivreur');
            const allLivreurs = new Set();
            Object.values(data.historiqueEPOD).forEach(monthData => {
                Object.keys(monthData).forEach(l => allLivreurs.add(l));
            });
            select.innerHTML = '<option value="">-- Sélectionner --</option>' + Array.from(allLivreurs).sort().map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
        }

        function deleteMonthData(monthKey) {
            if (!confirm(`Supprimer toutes les données de ${formatMonthName(monthKey)} ?`)) return;
            delete data.historiqueEPOD[monthKey];
            saveLocal();
            updateDataManagerList();
            refreshHistorique();
            showToast('Données supprimées', 'success');
        }

        function editMonthData(monthKey) {
            selectedHistoriqueMonth = monthKey;
            const [year, month] = monthKey.split('-');
            document.getElementById('editDataDate').value = `${year}-${month}-01`;
        }

        function applyDataEdit() {
            const date = document.getElementById('editDataDate').value;
            const livreur = document.getElementById('editDataLivreur').value;
            const livres = parseInt(document.getElementById('editDataLivres').value);
            const prevus = parseInt(document.getElementById('editDataPrevus').value);

            if (!date || !livreur) {
                showToast('Veuillez remplir tous les champs', 'error');
                return;
            }

            const monthKey = date.slice(0, 7);
            if (!data.historiqueEPOD[monthKey]) data.historiqueEPOD[monthKey] = {};
            if (!data.historiqueEPOD[monthKey][livreur]) data.historiqueEPOD[monthKey][livreur] = { jours: {}, totalLivres: 0, totalPrevus: 0 };

            data.historiqueEPOD[monthKey][livreur].jours[date] = { livres: livres || 0, prevus: prevus || 0 };
            
            // Recalculate totals
            const liv = data.historiqueEPOD[monthKey][livreur];
            liv.totalLivres = Object.values(liv.jours).reduce((sum, j) => sum + j.livres, 0);
            liv.totalPrevus = Object.values(liv.jours).reduce((sum, j) => sum + j.prevus, 0);

            saveLocal();
            updateDataManagerList();
            refreshHistorique();
            showToast('Données mises à jour', 'success');
        }

        function exportHistoriqueJSON() {
            const exportData = {
                historiqueEPOD: data.historiqueEPOD,
                exportDate: new Date().toISOString(),
                type: 'corrections'
            };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `historique_corrections_${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Corrections exportées', 'success');
        }

        // ============== SHARE & DOWNLOAD ==============
        function generateShareLink() {
            // Réservé à l'administrateur
            if (CLOUD_ENABLED && !currentUserIsAdmin) {
                showToast('Le partage de l\'application est réservé à l\'administrateur.', 'error');
                return;
            }
            const shareSection = document.getElementById('shareSection');
            shareSection.style.display = 'block';
            
            // Generate the current page URL for download
            const currentUrl = window.location.href;
            document.getElementById('shareLink').value = currentUrl;

            // Generate QR code
            const qrcodeContainer = document.getElementById('qrcode');
            qrcodeContainer.innerHTML = '';
            
            if (typeof QRCode !== 'undefined') {
                new QRCode(qrcodeContainer, {
                    text: currentUrl,
                    width: 200,
                    height: 200,
                    colorDark: '#007AFF',
                    colorLight: '#ffffff'
                });
            }

            // Update download stats
            document.getElementById('downloadStats').innerHTML = `
                <p><i class="fas fa-download"></i> Téléchargements: ${escapeHtml(data.downloadStats?.count || 0)}</p>
                ${data.downloadStats?.lastDownload ? `<p><i class="fas fa-clock"></i> Dernier: ${new Date(data.downloadStats.lastDownload).toLocaleString('fr-FR')}</p>` : ''}
            `;

            showToast('Lien généré', 'success');
        }

        function copyShareLink() {
            const input = document.getElementById('shareLink');
            input.select();
            document.execCommand('copy');
            showToast('Lien copié !', 'success');
        }

        /**
         * ANCIEN « Télécharger l'application » : enregistrait la page affichée
         * (document.outerHTML) AVEC toutes les données visibles (salaires, colis,
         * adresses…). C'est ainsi qu'une copie remplie de données s'est retrouvée
         * publiée sur GitHub Pages. Fonction neutralisée : l'application se met à
         * jour via le dépôt GitHub, et se partage par son lien.
         */
        function downloadApp() {
            showToast('Le téléchargement de la page est désactivé (il copiait vos données dans le fichier). Partagez le lien de l\'application à la place.', 'info');
            try { generateShareLink(); } catch (e) { /* réservé à l'administrateur */ }
        }




