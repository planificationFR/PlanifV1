        // ============== EXCEL/CSV IMPORT ==============
        function handleFilesDragOver(e) {
            e.preventDefault();
            document.getElementById('uploadZone').classList.add('drag-over');
        }

        function handleFilesDragLeave(e) {
            e.preventDefault();
            document.getElementById('uploadZone').classList.remove('drag-over');
        }

        function handleFilesDrop(e) {
            e.preventDefault();
            document.getElementById('uploadZone').classList.remove('drag-over');
            const files = e.dataTransfer.files;
            if (files.length > 0) processExcelFile(files[0]);
        }

        function handleExcelUpload(event) {
            const file = event.target.files[0];
            if (file) processExcelFile(file);
            event.target.value = '';
        }

        async function processExcelFile(file) {
            const fileName = file.name.toLowerCase();
            if (!fileName.endsWith('.xlsx') && !fileName.endsWith('.xls') && !fileName.endsWith('.csv')) {
                showToast('Format non supporté. Utilisez .xlsx, .xls ou .csv', 'error');
                return;
            }
            await loadXLSXLib();
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    let rows = [];
                    if (fileName.endsWith('.csv')) {
                        const text = e.target.result;
                        rows = parseCSV(text);
                    } else {
                        const data = new Uint8Array(e.target.result);
                        const workbook = XLSX.read(data, { type: 'array' });
                        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                        rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
                    }
                    if (rows.length < 2) {
                        showToast('Fichier vide ou invalide', 'error');
                        return;
                    }
                    // Détection format tournée FR_EXP_xxx
                    const texteAplati = rows.map(r => Array.isArray(r) ? r.join(' ') : String(r)).join('\n');
                    const tourneesDetectees = parserFormatTournees(texteAplati);
                    if (tourneesDetectees.length > 0 &&
                        tourneesDetectees.some(t => /^[A-Z]{2,}_/.test(t.tournee) || t.lignes.length >= 3)) {
                        ouvrirModaleSelectionTournees(tourneesDetectees);
                        return;
                    }
                    // v52 — garde : un export réalisé (livraisons faites) n'est pas une prévision
                    if (!(await verifierClasseFichier(rows, 'import', ['prevision', 'agrege'], ['inconnu', 'tournee']))) return;
                    const result = processImportedData(rows);
                    if (result.success) {
                        showImportResults(result);
                        markUnsaved();
                        updateUI();
                    }
                } catch (err) {
                    console.error('Erreur import:', err);
                    showToast('Erreur lors de la lecture du fichier', 'error');
                }
            };
            if (fileName.endsWith('.csv')) reader.readAsText(file);
            else reader.readAsArrayBuffer(file);
        }

        function parseCSV(text) {
            const lines = text.split(/\r?\n/);
            return lines.map(line => {
                const separator = line.includes(';') ? ';' : ',';
                return line.split(separator).map(cell => cell.trim().replace(/^["']|["']$/g, ''));
            }).filter(row => row.some(cell => cell));
        }

        function processImportedData(rows) {
            // v52 — une liste de tâches EPOD (1 ligne = 1 colis, 84 colonnes) est
            // agrégée automatiquement par code postal. Si le fichier ne porte
            // qu'une seule date, elle devient la date de planification.
            rows = _agregerListeTachesSiBesoin(rows);
            const header = rows[0].map(h => String(h).toLowerCase().trim());
            let cpIndex = -1, colisIndex = -1;
            const cpNames = ['code postal', 'codepostal', 'cp', 'code_postal', 'postal', 'secteur', 'zip'];
            const colisNames = ['colis', 'nombre', 'quantité', 'quantite', 'qty', 'nb', 'total', 'count', 'packages'];

            header.forEach((h, i) => {
                if (cpNames.some(name => h.includes(name))) cpIndex = i;
                if (colisNames.some(name => h.includes(name))) colisIndex = i;
            });

            if (cpIndex === -1) cpIndex = 0;
            if (colisIndex === -1) colisIndex = 1;

            const previsions = [];
            let totalColis = 0, secteursAssignes = 0, secteursNonAssignes = 0;
            const secteurToLivreur = {};
            data.livreurs.forEach(l => l.secteurs_prioritaires.forEach(s => secteurToLivreur[s] = l.nom));

            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (!row || row.length < 2) continue;
                let codePostal = String(row[cpIndex] || '').trim();
                let colis = parseInt(row[colisIndex]) || 0;
                if (!codePostal || colis <= 0) continue;
                if (/^\d{3}$/.test(codePostal)) codePostal = '68' + codePostal;
                else if (/^\d+$/.test(codePostal)) codePostal = codePostal.padStart(5, '0');

                previsions.push({ id: Date.now().toString() + '_' + i, code_postal: codePostal, colis });
                totalColis += colis;
                if (secteurToLivreur[codePostal]) secteursAssignes++;
                else secteursNonAssignes++;
            }

            if (previsions.length === 0) {
                showToast('Aucune donnée valide trouvée', 'error');
                return { success: false };
            }
            data.previsions[selectedDate] = previsions;
            marquerImport('previsions:' + selectedDate);
            return { success: true, totalSecteurs: previsions.length, totalColis, secteursAssignes, secteursNonAssignes };
        }

        function _agregerListeTachesSiBesoin(rows) {
            const objets = fichierEnObjets(rows);
            if (!objets.length) return rows;
            const cles = {}; Object.keys(objets[0]).forEach(k => cles[_fcNorm(k)] = k);
            const trouve = (...c) => { for (const x of c) { const k = cles[_fcNorm(x)]; if (k) return k; } return null; };
            const colCP = trouve('Code postal de destination', 'Destination Zip Code', 'Code postal', 'Zip Code', 'Postal Code', "Receiver's Zip Code");
            const colStatut = trouve('Statut', 'Task Status', 'Status');
            const colDate = trouve('Date de la tâche', 'Task Date');
            const colColis = trouve('Numéro de la lettre', 'Waybill Number', 'Waybill', 'Tracking Number', 'Code de tâche');
            if (!colCP || !(colStatut || colColis) || Object.keys(cles).length <= 6) return rows;   // fichier agrégé classique
            const parCP = {}, dates = new Set(); let n = 0;
            objets.forEach(o => {
                let cp = String(o[colCP] ?? '').trim(); if (!cp) return;
                if (/^\d+$/.test(cp)) cp = cp.padStart(5, '0');   // « 1234 » → « 01234 » (aucune règle propre à un département)
                parCP[cp] = (parCP[cp] || 0) + 1; n++;
                if (colDate && o[colDate]) { const d = o[colDate] instanceof Date ? o[colDate].toISOString().slice(0, 10) : String(o[colDate]).slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d); }
            });
            if (dates.size === 1) {
                const d = [...dates][0];
                if (d !== selectedDate) { selectedDate = d; try { updateUI(); } catch (e) {} showToast(`Date de planification : ${formatDateLong(d)} (date du fichier)`, 'info'); }
            } else if (dates.size > 1) {
                showToast(`Le fichier contient ${dates.size} dates : tout est planifié sur ${selectedDate}`, 'warning');
            }
            showToast(`${n} colis agrégés en ${Object.keys(parCP).length} codes postaux`, 'info');
            return [['Code postal', 'Colis'], ...Object.entries(parCP).sort((a, b) => b[1] - a[1]).map(([cp, c]) => [cp, c])];
        }

        function showImportResults(result) {
            const importResults = document.getElementById('importResults');
            importResults.style.display = 'block';
            document.getElementById('importSummary').innerHTML = `
                <div class="import-stat"><div class="value">${result.totalSecteurs}</div><div class="label">Secteurs importés</div></div>
                <div class="import-stat"><div class="value">${result.totalColis}</div><div class="label">Total colis</div></div>
                <div class="import-stat"><div class="value" style="color: var(--success)">${result.secteursAssignes}</div><div class="label">Assignés</div></div>
                <div class="import-stat"><div class="value" style="color: ${result.secteursNonAssignes > 0 ? 'var(--warning)' : 'var(--success)'}">${result.secteursNonAssignes}</div><div class="label">Non assignés</div></div>
            `;
            showToast(`${result.totalSecteurs} prévisions importées`, 'success');
            setTimeout(() => importResults.style.display = 'none', 10000);
        }

        function clearPrevisions() {
            if (!confirm(`Effacer toutes les prévisions du ${selectedDate} ?`)) return;
            data.previsions[selectedDate] = [];
            markUnsaved();
            updateUI();
            showToast('Prévisions effacées', 'info');
        }

