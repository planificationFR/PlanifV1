        // ============== LIVREURS CRUD ==============
        function updateTauxLabel(prefix) {
            const contrat = document.getElementById(`${prefix}LivreurContrat`).value;
            const label = document.getElementById(`${prefix}TauxLabel`);
            const tauxInput = document.getElementById(`${prefix}LivreurTaux`);
            if (contrat === 'salarie') {
                label.textContent = 'Taux (€/heure) — info uniquement, le salaire utilise la grille';
                if (tauxInput) tauxInput.placeholder = '11.65';
            } else if (contrat === 'autoentrepreneur-vehicule') {
                label.textContent = 'Taux (€/h) — info uniquement, le salaire utilise la grille +10€';
                if (tauxInput) tauxInput.placeholder = '11.65';
            } else {
                label.textContent = 'Taux (€/colis)';
                if (tauxInput) tauxInput.placeholder = '1.40';
            }
        }

        function updateCostPreview() {
            const taux = parseFloat(document.getElementById('newLivreurTaux')?.value) || 0;
            const preview = document.getElementById('costPreview');
            if (preview) preview.innerHTML = `Pour 100 colis : <strong>${(taux * 100).toFixed(2)} €</strong>`;
        }

        function addLivreur(e) {
            e.preventDefault();
            const nom = document.getElementById('newLivreurNom').value.trim();
            const prenom = document.getElementById('newLivreurPrenom')?.value.trim() || '';
            const tel = document.getElementById('newLivreurTel')?.value.trim() || '';
            const email = document.getElementById('newLivreurEmail')?.value.trim() || '';
            const contrat = document.getElementById('newLivreurContrat')?.value || 'auto-entrepreneur';
            const taux = parseFloat(document.getElementById('newLivreurTaux')?.value) || 1.4;
            const dateContrat = document.getElementById('newLivreurDateContrat')?.value || '';
            const iban = document.getElementById('newLivreurIBAN')?.value.trim() || '';
            const minColis = parseInt(document.getElementById('newLivreurMinColis')?.value) || 80;
            const maxColis = parseInt(document.getElementById('newLivreurMaxColis')?.value) || 160;
            const secteurs = document.getElementById('newLivreurSecteurs')?.value.split(',').map(s => s.trim()).filter(s => s) || [];
            const notes = document.getElementById('newLivreurNotes')?.value.trim() || '';
            
            const disponibilites = [];
            ['lun','mar','mer','jeu','ven','sam','dim'].forEach(d => {
                if (document.getElementById(`newDispo_${d}`)?.checked) disponibilites.push(d);
            });

            data.livreurs.push({
                id: Date.now().toString(),
                nom, prenom, tel, email, contrat, taux, dateContrat, iban, minColis, maxColis,
                secteurs_prioritaires: secteurs,
                disponibilites, notes, actif: true,
                modifications: [{ date: new Date().toISOString(), action: 'Création' }]
            });

            // Reset form
            document.getElementById('newLivreurNom').value = '';
            document.getElementById('newLivreurPrenom').value = '';
            closeModal('addLivreur');
            markUnsaved();
            updateUI();
            showToast(`${nom} ajouté`, 'success');
        }

        function editLivreur(id) {
            const livreur = data.livreurs.find(l => l.id === id);
            if (!livreur) return;
            
            document.getElementById('editLivreurId').value = id;
            document.getElementById('editLivreurNom').value = livreur.nom;
            document.getElementById('editLivreurPrenom').value = livreur.prenom || '';
            document.getElementById('editLivreurTel').value = livreur.tel || '';
            document.getElementById('editLivreurEmail').value = livreur.email || '';
            document.getElementById('editLivreurActif').checked = livreur.actif;
            document.getElementById('editLivreurContrat').value = livreur.contrat || 'auto-entrepreneur';
            document.getElementById('editLivreurTaux').value = livreur.taux || 1.4;
            document.getElementById('editLivreurDateContrat').value = livreur.dateContrat || '';
            document.getElementById('editLivreurIBAN').value = livreur.iban || '';
            document.getElementById('editLivreurMinColis').value = livreur.minColis || 80;
            document.getElementById('editLivreurMaxColis').value = livreur.maxColis || 160;
            document.getElementById('editLivreurSecteurs').value = livreur.secteurs_prioritaires.join(', ');
            document.getElementById('editLivreurNotes').value = livreur.notes || '';

            ['lun','mar','mer','jeu','ven','sam','dim'].forEach(d => {
                const checkbox = document.getElementById(`editDispo_${d}`);
                if (checkbox) checkbox.checked = (livreur.disponibilites || []).includes(d);
            });

            // Historique des modifications
            const historyHtml = (livreur.modifications || []).length > 0
                ? livreur.modifications.map(m => `
                    <div style="padding: 0.75rem; background: var(--background-light); border-radius: var(--radius-sm); margin-bottom: 0.5rem; border-left: 3px solid var(--primary);">
                        <div style="font-weight: 600; color: var(--text);">${escapeHtml(m.action)}</div>
                        <div style="font-size: 0.85rem; color: var(--text-secondary);">${new Date(m.date).toLocaleString('fr-FR')}</div>
                    </div>
                `).join('')
                : '<p style="color: var(--text-secondary); text-align: center;">Aucune modification enregistrée</p>';
            document.getElementById('livreurModificationHistory').innerHTML = historyHtml;

            updateTauxLabel('edit');
            openModal('editLivreur');
        }

        function updateLivreur(e) {
            e.preventDefault();
            const id = document.getElementById('editLivreurId').value;
            const index = data.livreurs.findIndex(l => l.id === id);
            if (index === -1) return;

            const disponibilites = [];
            ['lun','mar','mer','jeu','ven','sam','dim'].forEach(d => {
                if (document.getElementById(`editDispo_${d}`)?.checked) disponibilites.push(d);
            });

            data.livreurs[index] = {
                ...data.livreurs[index],
                nom: document.getElementById('editLivreurNom').value.trim(),
                prenom: document.getElementById('editLivreurPrenom').value.trim(),
                tel: document.getElementById('editLivreurTel').value.trim(),
                email: document.getElementById('editLivreurEmail').value.trim(),
                actif: document.getElementById('editLivreurActif').checked,
                contrat: document.getElementById('editLivreurContrat').value,
                taux: parseFloat(document.getElementById('editLivreurTaux').value) || 1.4,
                dateContrat: document.getElementById('editLivreurDateContrat').value,
                iban: document.getElementById('editLivreurIBAN').value.trim(),
                minColis: parseInt(document.getElementById('editLivreurMinColis').value) || 80,
                maxColis: parseInt(document.getElementById('editLivreurMaxColis').value) || 160,
                secteurs_prioritaires: document.getElementById('editLivreurSecteurs').value.split(',').map(s => s.trim()).filter(s => s),
                disponibilites,
                notes: document.getElementById('editLivreurNotes').value.trim()
            };

            data.livreurs[index].modifications = data.livreurs[index].modifications || [];
            data.livreurs[index].modifications.unshift({ date: new Date().toISOString(), action: 'Modification' });

            closeModal('editLivreur');
            markUnsaved();
            updateUI();
            showToast('Livreur modifié', 'success');
        }

        function duplicateLivreur() {
            const id = document.getElementById('editLivreurId').value;
            const livreur = data.livreurs.find(l => l.id === id);
            if (!livreur) return;

            const newLivreur = {
                ...JSON.parse(JSON.stringify(livreur)),
                id: Date.now().toString(),
                nom: livreur.nom + ' (copie)',
                modifications: [{ date: new Date().toISOString(), action: 'Dupliqué depuis ' + livreur.nom }]
            };

            data.livreurs.push(newLivreur);
            closeModal('editLivreur');
            markUnsaved();
            updateUI();
            showToast(`${newLivreur.nom} créé`, 'success');
        }

        function deleteLivreur(id) {
            const livreur = data.livreurs.find(l => l.id === id);
            if (!confirm(`Supprimer ${livreur?.nom} ?`)) return;
            data.livreurs = data.livreurs.filter(l => l.id !== id);
            markUnsaved();
            updateUI();
            showToast('Livreur supprimé', 'success');
        }

        function addPrevision(e) {
            e.preventDefault();
            const cp = document.getElementById('newPrevisionCP').value.trim();
            const colis = parseInt(document.getElementById('newPrevisionColis').value);
            if (!data.previsions[selectedDate]) data.previsions[selectedDate] = [];
            const existingIndex = data.previsions[selectedDate].findIndex(p => p.code_postal === cp);
            if (existingIndex >= 0) data.previsions[selectedDate][existingIndex].colis = colis;
            else data.previsions[selectedDate].push({ id: Date.now().toString(), code_postal: cp, colis });
            document.getElementById('newPrevisionCP').value = '';
            document.getElementById('newPrevisionColis').value = '';
            closeModal('addPrevision');
            markUnsaved();
            updateUI();
            showToast('Prévision ajoutée', 'success');
        }

        function deletePrevision(id) {
            if (!data.previsions[selectedDate]) return;
            data.previsions[selectedDate] = data.previsions[selectedDate].filter(p => p.id !== id);
            markUnsaved();
            updateUI();
        }

