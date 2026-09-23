        // ═══════════════════════════════════════════════════════════════
        // ============== RECHERCHE GLOBALE D'UN COLIS ==============
        // Un seul champ (accueil) qui interroge : Inventaire centre de tri
        // + toutes les analyses Contrôle EPOD (anomalies, Next Day, contacts).
        // ═══════════════════════════════════════════════════════════════
        function rechercheGlobaleColis(token) {
            const res = { inventaire: [], epod: [] };
            (data.inventaire?.entries || []).forEach(e => {
                if (e.w === token || e.w.includes(token)) res.inventaire.push(e);
            });
            const mois = new Set([...Object.keys(data.controlEPOD || {}), ...Object.keys(_ccMem)]);
            [...mois].sort().reverse().forEach(m => {
                const a = _ccMem[m] ? _ccMem[m].analyse : data.controlEPOD[m];
                if (!a) return;
                (a.sign || []).forEach(r => {
                    if (String(r.waybill).includes(token)) res.epod.push({ m, type: 'Anomalie : ' + (r.alerts || []).join(', '), courier: r.courier, ville: r.city, nom: r.name, tel: r.phone, adresse: r.address });
                });
                (a.next || []).forEach(r => {
                    if (String(r.waybill).includes(token)) res.epod.push({ m, type: 'Next Day (' + (a.dsp || '') + ')', courier: r.courier, ville: r.city, nom: r.name, tel: r.phone, adresse: r.address });
                });
                (a.contacts || []).forEach(r => {
                    if (String(r.waybill).includes(token)) res.epod.push({ m, type: 'Contact incomplet', courier: r.courier, ville: r.city, nom: r.name, tel: r.phone, adresse: r.address });
                });
            });
            return res;
        }
        function rechercheGlobale() {
            const el = document.getElementById('rgResults');
            if (!el) return;
            const tokens = invTokens(document.getElementById('rgInput')?.value || '');
            if (!tokens.length) { el.innerHTML = '<p style="font-size:0.84rem;color:var(--text-secondary);">Saisissez au moins un numéro de colis (6 caractères minimum, avec des chiffres).</p>'; return; }
            const blocs = tokens.slice(0, 100).map(t => {
                const r = rechercheGlobaleColis(t);
                const lignes = [];
                r.inventaire.forEach(e => lignes.push(`<div style="padding:0.3rem 0;"><i class="fas fa-boxes-stacked" style="color:var(--primary);width:18px;"></i> <b>Inventaire</b> — ${escapeHtml(e.cat)} · renvoyé au tri le <b>${escapeHtml(invFmtDate(e.d))}</b></div>`));
                r.epod.forEach(e => lignes.push(`<div style="padding:0.3rem 0;"><i class="fas fa-clipboard-check" style="color:var(--secondary);width:18px;"></i> <b>Contrôle EPOD</b> (${escapeHtml(formatMonthName(e.m))}) — ${escapeHtml(e.type)} · livreur <b>${escapeHtml(e.courier || '—')}</b>${e.nom ? ' · ' + escapeHtml(e.nom) : ''}${e.tel ? ' · ' + escapeHtml(e.tel) : ''}${e.adresse ? ' · ' + escapeHtml(e.adresse) : ''}</div>`));
                const trouve = lignes.length > 0;
                return `<div style="margin-bottom:0.6rem;padding:0.7rem 0.9rem;border-radius:8px;border:1px solid ${trouve ? 'rgba(45,212,163,0.35)' : 'rgba(231,76,60,0.3)'};background:${trouve ? 'rgba(45,212,163,0.06)' : 'rgba(231,76,60,0.05)'};">
                    <div style="font-weight:800;font-family:monospace;margin-bottom:0.25rem;">
                        <i class="fas ${trouve ? 'fa-circle-check' : 'fa-circle-xmark'}" style="color:${trouve ? 'var(--success)' : 'var(--danger)'};"></i>
                        ${escapeHtml(t)}
                    </div>
                    ${trouve ? lignes.join('') : '<div style="font-size:0.84rem;color:var(--text-secondary);">Aucune trace dans l\'inventaire ni dans les analyses Contrôle EPOD.</div>'}
                </div>`;
            });
            const nbSources = (data.inventaire ? 1 : 0) + (Object.keys(data.controlEPOD || {}).length ? 1 : 0);
            el.innerHTML = (nbSources === 0
                ? '<p style="font-size:0.82rem;color:#FF8A65;"><i class="fas fa-circle-info"></i> Aucune donnée à interroger pour l\'instant : importez un inventaire et/ou un fichier EPOD.</p>'
                : '') + blocs.join('');
        }

        // ═══════════════════════════════════════════════════════════════
        // ============== INVENTAIRE CENTRE DE TRI ==============
        // Fichier Excel cumulatif mis à jour quotidiennement :
        //  - chaque FEUILLE est une catégorie (Backlog, Retour Cainiao, Problème de scan…)
        //  - chaque COLONNE est une date (formats variés : date Excel, "18-Juin", "01_June"…)
        //  - les cellules contiennent les numéros de colis renvoyés ce jour-là.
        // L'app permet de vérifier si un colis figure dans l'inventaire, dans quelle
        // catégorie et à quelle date il a été renvoyé au centre de tri, avec filtres
        // par date / mois / année et génération de rapport.
        // ═══════════════════════════════════════════════════════════════
        const INV_MOIS = { janv: 1, jan: 1, fevr: 2, fev: 2, feb: 2, mars: 3, mar: 3, avr: 4, apr: 4, mai: 5, may: 5, juin: 6, june: 6, jukn: 6, jun: 6, juillet: 7, juil: 7, july: 7, jul: 7, aout: 8, aug: 8, sept: 9, sep: 9, oct: 10, nov: 11, dec: 12 };
        const INV_MOIS_FR = ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
        function invSerialIso(n) { const d = new Date(Math.round((n - 25569) * 86400000)); return isNaN(d) ? '' : d.toISOString().slice(0, 10); }
        function invParseHeader(h, anneeDefaut) {
            if (h == null || h === '') return null;
            if (h instanceof Date) return isNaN(h) ? null : h.toISOString().slice(0, 10);
            if (typeof h === 'number') return (h > 20000 && h < 60000) ? invSerialIso(h) : null;
            const s = String(h).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_\/.\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
            if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
            m = s.match(/^(\d{1,2})-([a-z]+)(?:-(\d{4}))?$/);
            if (m) {
                const jour = parseInt(m[1]);
                const mm = m[2];
                let mois = INV_MOIS[mm];
                if (!mois) { for (const k of Object.keys(INV_MOIS)) { if (mm.startsWith(k) || k.startsWith(mm)) { mois = INV_MOIS[k]; break; } } }
                if (mois && jour >= 1 && jour <= 31) {
                    const y = m[3] ? parseInt(m[3]) : anneeDefaut;
                    return `${y}-${String(mois).padStart(2, '0')}-${String(jour).padStart(2, '0')}`;
                }
            }
            return null;
        }
        function invParseWorkbook(wb) {
            const entries = [];
            const vus = new Set();
            wb.SheetNames.forEach(sheetName => {
                const ws = wb.Sheets[sheetName];
                if (!ws) return;
                const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
                if (!rows.length) return;
                const headers = rows[0] || [];
                const maxCols = Math.max(...rows.map(r => r.length));
                // Année par défaut : la plus fréquente parmi les dates complètes de la feuille
                const annees = {};
                headers.forEach(h => {
                    let iso = null;
                    if (h instanceof Date && !isNaN(h)) iso = h.toISOString().slice(0, 10);
                    else if (typeof h === 'number' && h > 20000 && h < 60000) iso = invSerialIso(h);
                    else { const s = String(h || ''); const m = s.match(/(\d{4})-\d{1,2}-\d{1,2}/); if (m) iso = s; }
                    if (iso) { const y = parseInt(iso.slice(0, 4)); annees[y] = (annees[y] || 0) + 1; }
                });
                const anneeDefaut = Object.keys(annees).length
                    ? parseInt(Object.entries(annees).sort((a, b) => b[1] - a[1])[0][0])
                    : new Date().getFullYear();
                let derniereDate = '';
                for (let c = 0; c < maxCols; c++) {
                    const h = headers[c];
                    let dte;
                    if (h == null || String(h).trim() === '') {
                        dte = derniereDate; // colonne sans en-tête : continuation de la date précédente
                    } else {
                        const p = invParseHeader(h, anneeDefaut);
                        dte = p || '';
                        derniereDate = dte;
                    }
                    for (let r = 1; r < rows.length; r++) {
                        const v = rows[r][c];
                        const s = String(v ?? '').trim().toUpperCase();
                        if (!s || s.length < 6 || !/[A-Z]/.test(s) || !/\d/.test(s)) continue;
                        const key = s + '|' + sheetName + '|' + dte;
                        if (vus.has(key)) continue;
                        vus.add(key);
                        entries.push({ w: s, cat: sheetName, d: dte });
                    }
                }
            });
            entries.sort((a, b) => (b.d || '').localeCompare(a.d || '') || a.w.localeCompare(b.w));
            return entries;
        }
        async function invHandleUpload(event) {
            const f = event.target.files[0];
            if (!f) return;
            event.target.value = '';
            try {
                const st = document.getElementById('invStatus');
                if (st) st.textContent = 'Lecture du fichier…';
                await loadXLSXLib();
                const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: false });
                const entries = invParseWorkbook(wb);
                if (!entries.length) { showToast('Aucun numéro de colis reconnu dans ce fichier', 'error'); invRenderAll(); return; }
                data.inventaire = { majLe: new Date().toISOString(), fichier: f.name, entries };
                markUnsaved(); saveLocal();
                invRenderAll();
                showToast(`Inventaire importé : ${entries.length} références (${wb.SheetNames.length} catégories)`, 'success');
            } catch (err) {
                console.error('[INV] import', err);
                showToast("Erreur lors de l'import de l'inventaire", 'error');
                invRenderAll();
            }
        }
        function invClear() {
            if (!data.inventaire) { showToast('Aucun inventaire enregistré', 'error'); return; }
            if (!confirm('Effacer l\'inventaire enregistré ? (vous pourrez réimporter le fichier)')) return;
            try { snapshotCreer('avant effacement inventaire'); } catch (e) {}
            data.inventaire = null;
            markUnsaved(); saveLocal();
            invRenderAll();
            showToast('Inventaire effacé', 'success');
        }
        function invFmtDate(d) {
            if (!d) return 'Date inconnue';
            const [y, m, j] = d.split('-');
            return `${j}/${m}/${y}`;
        }
        // Découpe une saisie en numéros de colis (espaces, virgules, points-virgules, retours à la ligne…)
        function invTokens(texte) {
            const t = String(texte || '').toUpperCase().split(/[^A-Z0-9]+/).filter(x => x.length >= 6 && /\d/.test(x));
            return [...new Set(t)].slice(0, 500);
        }
        function invFiltres() {
            const q = String(document.getElementById('invSearch')?.value || '').trim().toUpperCase();
            const tokens = invTokens(q);
            const cat = document.getElementById('invCat')?.value || '';
            const an = document.getElementById('invAnnee')?.value || '';
            const mo = document.getElementById('invMois')?.value || '';
            const jr = document.getElementById('invJour')?.value || '';
            let list = (data.inventaire?.entries || []);
            if (cat) list = list.filter(e => e.cat === cat);
            if (jr) list = list.filter(e => e.d === jr);
            else if (mo) list = list.filter(e => e.d.startsWith(mo));
            else if (an) list = list.filter(e => e.d.startsWith(an + '-'));
            if (tokens.length > 1) list = list.filter(e => tokens.some(t => e.w === t || e.w.includes(t)));
            else if (q) list = list.filter(e => e.w.includes(q));
            return { list, q, tokens, cat, an, mo, jr };
        }
        // Vérifie chaque numéro contre TOUT l'inventaire (sans filtres) : réponse fiable pour la hiérarchie
        function invVerif(tokens) {
            const all = data.inventaire?.entries || [];
            return tokens.map(t => {
                const occ = all.filter(e => e.w === t || e.w.includes(t));
                return { q: t, occ };
            });
        }
        function invToggleBulk() {
            const box = document.getElementById('invBulkBox');
            if (box) box.style.display = box.style.display === 'none' ? '' : 'none';
        }
        function invBulkCheck() {
            const tokens = invTokens(document.getElementById('invBulkInput')?.value || '');
            if (!tokens.length) { showToast('Aucun numéro de colis reconnu dans la liste', 'error'); return; }
            const search = document.getElementById('invSearch');
            if (search) search.value = tokens.join(' ');
            invRenderResults();
            showToast(`${tokens.length} numéro(s) vérifié(s)`, 'success');
        }
        function invBulkTokensCourants() {
            let tokens = invTokens(document.getElementById('invBulkInput')?.value || '');
            if (!tokens.length) tokens = invTokens(document.getElementById('invSearch')?.value || '');
            return tokens;
        }
        function invBulkExportCsv() {
            if (!data.inventaire) { showToast('Aucun inventaire importé', 'error'); return; }
            const tokens = invBulkTokensCourants();
            if (!tokens.length) { showToast('Collez d\'abord une liste de numéros', 'error'); return; }
            const rows = [];
            invVerif(tokens).forEach(v => {
                if (!v.occ.length) rows.push({ colis: v.q, statut: 'INTROUVABLE', categorie: '', renvoye_le: '' });
                else v.occ.forEach(e => rows.push({ colis: v.q, statut: 'TROUVÉ', categorie: e.cat, renvoye_le: invFmtDate(e.d) }));
            });
            ccCsvDownload(rows, [['N° recherché', 'colis'], ['Statut', 'statut'], ['Catégorie', 'categorie'], ['Renvoyé le', 'renvoye_le']],
                `verification_inventaire_${new Date().toISOString().slice(0, 10)}.csv`);
        }
        async function invBulkExportPdf() {
            if (!data.inventaire) { showToast('Aucun inventaire importé', 'error'); return; }
            const tokens = invBulkTokensCourants();
            if (!tokens.length) { showToast('Collez d\'abord une liste de numéros', 'error'); return; }
            const ok = await ensureJsPDF();
            if (!ok) { showToast('Librairie PDF indisponible', 'error'); return; }
            const { jsPDF } = window.jspdf || { jsPDF: window.jsPDF };
            const verif = invVerif(tokens);
            const trouves = verif.filter(v => v.occ.length).length;
            const doc = new jsPDF();
            doc.setFontSize(16);
            doc.text('Vérification inventaire — centre de tri', 14, 15);
            doc.setFontSize(9);
            doc.text(`Généré le ${new Date().toLocaleString('fr-FR')} · Inventaire mis à jour le ${new Date(data.inventaire.majLe).toLocaleDateString('fr-FR')}`, 14, 21);
            doc.text(`${tokens.length} numéro(s) vérifié(s) : ${trouves} trouvé(s), ${tokens.length - trouves} introuvable(s)`, 14, 26);
            const body = [];
            verif.forEach(v => {
                if (!v.occ.length) body.push([v.q, 'INTROUVABLE', '—', '—']);
                else v.occ.forEach(e => body.push([v.q, 'Trouvé', e.cat, invFmtDate(e.d)]));
            });
            doc.autoTable({ startY: 31, head: [['N° de colis recherché', 'Statut', 'Catégorie', 'Renvoyé le']], body, theme: 'grid', styles: { fontSize: 8 },
                didParseCell: c => { if (c.section === 'body' && c.column.index === 1 && String(c.cell.raw).startsWith('INTROUV')) { c.cell.styles.textColor = [220, 38, 38]; c.cell.styles.fontStyle = 'bold'; } } });
            doc.save(`Verification_inventaire_${new Date().toISOString().slice(0, 10)}.pdf`);
        }
        function invPopulateFiltres() {
            const entries = data.inventaire?.entries || [];
            const catSel = document.getElementById('invCat');
            const anSel = document.getElementById('invAnnee');
            const moSel = document.getElementById('invMois');
            const jrSel = document.getElementById('invJour');
            if (!catSel) return;
            const keep = (sel) => sel.value;
            const cats = [...new Set(entries.map(e => e.cat))];
            const kc = keep(catSel);
            catSel.innerHTML = '<option value="">Toutes catégories</option>' + cats.map(c => `<option value="${escAttr(c)}" ${c === kc ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
            const annees = [...new Set(entries.map(e => e.d.slice(0, 4)).filter(Boolean))].sort().reverse();
            const ka = keep(anSel);
            anSel.innerHTML = '<option value="">Toutes années</option>' + annees.map(a => `<option value="${escapeHtml(a)}" ${a === ka ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('');
            const anFiltre = anSel.value;
            const mois = [...new Set(entries.map(e => e.d.slice(0, 7)).filter(m => m && (!anFiltre || m.startsWith(anFiltre + '-'))))].sort().reverse();
            const kmv = keep(moSel);
            moSel.innerHTML = '<option value="">Tous mois</option>' + mois.map(m => `<option value="${escapeHtml(m)}" ${m === kmv ? 'selected' : ''}>${INV_MOIS_FR[parseInt(m.slice(5, 7))]} ${escapeHtml(m.slice(0, 4))}</option>`).join('');
            const moFiltre = moSel.value;
            const jours = [...new Set(entries.map(e => e.d).filter(d => d && (!moFiltre || d.startsWith(moFiltre)) && (!anFiltre || d.startsWith(anFiltre + '-'))))].sort().reverse();
            const kj = keep(jrSel);
            jrSel.innerHTML = '<option value="">Toutes dates</option>' + jours.map(d => `<option value="${escapeHtml(d)}" ${d === kj ? 'selected' : ''}>${escapeHtml(invFmtDate(d))}</option>`).join('');
        }
        function invOnAnnee() { const mo = document.getElementById('invMois'); if (mo) mo.value = ''; const jr = document.getElementById('invJour'); if (jr) jr.value = ''; invPopulateFiltres(); invRenderResults(); }
        function invOnMois() { const jr = document.getElementById('invJour'); if (jr) jr.value = ''; invPopulateFiltres(); invRenderResults(); }
        function invSetFiltre(type, val) {
            if (type === 'date') { const jr = document.getElementById('invJour'); if (jr) jr.value = val; }
            else if (type === 'mois') { const mo = document.getElementById('invMois'); if (mo) mo.value = val; const jr = document.getElementById('invJour'); if (jr) jr.value = ''; }
            else if (type === 'annee') { const an = document.getElementById('invAnnee'); if (an) an.value = val; const mo = document.getElementById('invMois'); if (mo) mo.value = ''; const jr = document.getElementById('invJour'); if (jr) jr.value = ''; invPopulateFiltres(); }
            else if (type === 'cat') { const cs = document.getElementById('invCat'); if (cs) cs.value = val; }
            invRenderResults();
        }
        function invRenderResults() {
            const table = document.getElementById('invTable');
            if (!table) return;
            if (!data.inventaire) {
                table.innerHTML = '<tbody><tr><td style="padding:1.2rem;color:var(--text-secondary);">Aucun inventaire importé. Cliquez sur « Importer l\'inventaire ».</td></tr></tbody>';
                const g = document.getElementById('invGroups'); if (g) g.innerHTML = '';
                const ans = document.getElementById('invAnswer'); if (ans) ans.innerHTML = '';
                return;
            }
            const { list, q, tokens } = invFiltres();
            // Réponse directe pour une recherche de colis (simple ou multiple)
            const ansEl = document.getElementById('invAnswer');
            if (ansEl) {
                if (tokens.length > 1) {
                    // Vérification en bloc : chaque numéro est contrôlé contre TOUT l'inventaire
                    const verif = invVerif(tokens);
                    const trouves = verif.filter(v => v.occ.length);
                    const absents = verif.filter(v => !v.occ.length);
                    const ligne = v => v.occ.length
                        ? `<div style="padding:0.45rem 0.8rem;border-radius:7px;background:rgba(45,212,163,0.08);border:1px solid rgba(45,212,163,0.3);font-size:0.84rem;margin-bottom:0.3rem;">
                            <i class="fas fa-circle-check" style="color:var(--success);"></i> <b style="font-family:monospace;">${escapeHtml(v.q)}</b> — ${v.occ.map(e => `${escapeHtml(e.cat)} le <b>${escapeHtml(invFmtDate(e.d))}</b>`).join(' ; ')}</div>`
                        : `<div style="padding:0.45rem 0.8rem;border-radius:7px;background:rgba(231,76,60,0.07);border:1px solid rgba(231,76,60,0.3);font-size:0.84rem;margin-bottom:0.3rem;">
                            <i class="fas fa-circle-xmark" style="color:var(--danger);"></i> <b style="font-family:monospace;">${escapeHtml(v.q)}</b> — introuvable dans l'inventaire</div>`;
                    ansEl.innerHTML = `
                        <div style="margin-bottom:0.6rem;padding:0.7rem 1rem;border-radius:8px;background:rgba(15,184,154,0.07);border:1px solid rgba(15,184,154,0.3);font-size:0.92rem;font-weight:700;">
                            <i class="fas fa-list-check" style="color:var(--primary);"></i> ${tokens.length} numéros vérifiés :
                            <span style="color:var(--success);">${trouves.length} trouvé(s)</span> ·
                            <span style="color:${absents.length ? 'var(--danger)' : 'var(--text-secondary)'};">${absents.length} introuvable(s)</span>
                        </div>
                        <div style="max-height:280px;overflow:auto;margin-bottom:0.8rem;">${verif.slice(0, 200).map(ligne).join('')}${verif.length > 200 ? `<p style="font-size:0.78rem;color:var(--text-secondary);">… ${verif.length - 200} autres — utilisez l'export CSV/PDF pour la liste complète.</p>` : ''}</div>`;
                } else if (q.length >= 6) {
                    const verif = invVerif([q])[0];
                    if (!verif.occ.length) {
                        ansEl.innerHTML = `<div style="margin-bottom:0.8rem;padding:0.7rem 1rem;border-radius:8px;background:rgba(231,76,60,0.08);border:1px solid rgba(231,76,60,0.3);font-size:0.9rem;">
                            <i class="fas fa-circle-xmark" style="color:var(--danger);"></i> <b>Aucune trace</b> de « ${escapeHtml(q)} » dans l'inventaire.</div>`;
                    } else if (verif.occ.length <= 5) {
                        ansEl.innerHTML = verif.occ.map(e => `<div style="margin-bottom:0.5rem;padding:0.7rem 1rem;border-radius:8px;background:rgba(45,212,163,0.08);border:1px solid rgba(45,212,163,0.35);font-size:0.9rem;">
                            <i class="fas fa-circle-check" style="color:var(--success);"></i> <b style="font-family:monospace;">${escapeHtml(e.w)}</b> figure dans l'inventaire — <b>${escapeHtml(e.cat)}</b> · renvoyé au centre de tri le <b>${escapeHtml(invFmtDate(e.d))}</b></div>`).join('');
                    } else {
                        ansEl.innerHTML = `<div style="margin-bottom:0.8rem;padding:0.7rem 1rem;border-radius:8px;background:rgba(15,184,154,0.07);border:1px solid rgba(15,184,154,0.3);font-size:0.9rem;">
                            <i class="fas fa-circle-info" style="color:var(--primary);"></i> <b>${verif.occ.length} références</b> correspondent à « ${escapeHtml(q)} ».</div>`;
                    }
                } else ansEl.innerHTML = '';
            }
            // Résumé groupé (par date / mois / année / catégorie)
            const grpEl = document.getElementById('invGroups');
            if (grpEl) {
                const mode = document.getElementById('invGroupe')?.value || 'date';
                const g = {};
                list.forEach(e => {
                    let k;
                    if (mode === 'date') k = e.d || '';
                    else if (mode === 'mois') k = e.d ? e.d.slice(0, 7) : '';
                    else if (mode === 'annee') k = e.d ? e.d.slice(0, 4) : '';
                    else k = e.cat;
                    g[k] = (g[k] || 0) + 1;
                });
                const lbl = k => {
                    if (!k) return 'Date inconnue';
                    if (mode === 'date') return invFmtDate(k);
                    if (mode === 'mois') return INV_MOIS_FR[parseInt(k.slice(5, 7))] + ' ' + k.slice(0, 4);
                    return k;
                };
                const clic = k => {
                    if (!k) return '';
                    if (mode === 'date') return `invSetFiltre('date','${escJsAttr(k)}')`;
                    if (mode === 'mois') return `invSetFiltre('mois','${escJsAttr(k)}')`;
                    if (mode === 'annee') return `invSetFiltre('annee','${escJsAttr(k)}')`;
                    return `invSetFiltre('cat','${escJsAttr(k)}')`;
                };
                const keys = Object.keys(g).sort().reverse();
                grpEl.innerHTML = keys.length ? '<div style="display:flex;gap:0.4rem;flex-wrap:wrap;">' + keys.slice(0, 60).map(k => `
                    <span onclick="${clic(k)}" style="cursor:pointer;display:inline-flex;align-items:center;gap:0.4rem;padding:4px 10px;border-radius:10px;background:var(--background-light);border:1px solid var(--border-light);font-size:0.78rem;font-weight:600;" title="Filtrer">
                        ${escapeHtml(lbl(k))} <b style="color:var(--primary);">${g[k]}</b>
                    </span>`).join('') + '</div>' : '';
            }
            // Tableau détaillé
            table.innerHTML = ccTableHtml(
                ['N° de colis', 'Catégorie', 'Renvoyé le', 'Mois', 'Année'],
                list.slice(0, 1500).map(e => `<tr>
                    <td style="padding:6px 9px;border-bottom:1px solid var(--border-light);font-family:monospace;white-space:nowrap;">${escapeHtml(e.w)}</td>
                    ${[e.cat, invFmtDate(e.d), e.d ? INV_MOIS_FR[parseInt(e.d.slice(5, 7))] + ' ' + e.d.slice(0, 4) : '—', e.d ? e.d.slice(0, 4) : '—'].map(ccTd).join('')}
                </tr>`).join('')
            );
        }
        function invRenderAll() {
            const st = document.getElementById('invStatus');
            const kp = document.getElementById('invKpis');
            if (!st || !kp) return;
            const inv = data.inventaire;
            if (!inv) {
                st.textContent = 'Aucun inventaire importé.';
                kp.innerHTML = '';
                invPopulateFiltres();
                invRenderResults();
                return;
            }
            const entries = inv.entries || [];
            const dates = entries.map(e => e.d).filter(Boolean);
            const dMin = dates.length ? dates.reduce((a, b) => a < b ? a : b) : '';
            const dMax = dates.length ? dates.reduce((a, b) => a > b ? a : b) : '';
            st.innerHTML = `<b>Dernière mise à jour :</b> ${new Date(inv.majLe).toLocaleString('fr-FR')} · <i class="fas fa-file-excel" style="color:var(--success);"></i> ${escapeHtml(inv.fichier || '')} · ${entries.length.toLocaleString('fr-FR')} références`;
            const cats = {};
            entries.forEach(e => cats[e.cat] = (cats[e.cat] || 0) + 1);
            const icones = { 'Backlog': 'fa-clock', 'Retour Cainiao': 'fa-rotate-left', 'Problème de scan': 'fa-barcode', 'Wrong hub': 'fa-shuffle', 'Outband (non reçu)': 'fa-ban' };
            kp.innerHTML = ccKpi('Total références', entries.length.toLocaleString('fr-FR'), 'var(--primary)', 'fa-boxes-stacked') +
                Object.entries(cats).map(([c, n]) => ccKpi(c, n, 'var(--secondary)', icones[c] || 'fa-box', `invSetFiltre('cat','${escJsAttr(c)}')`)).join('') +
                ccKpi('Période couverte', dMin ? `${invFmtDate(dMin).slice(0, 5)} → ${invFmtDate(dMax)}` : '—', 'var(--info)', 'fa-calendar-days');
            invPopulateFiltres();
            invRenderResults();
        }
        function invExportCsv() {
            if (!data.inventaire) { showToast('Aucun inventaire à exporter', 'error'); return; }
            const { list } = invFiltres();
            ccCsvDownload(list.map(e => ({ colis: e.w, categorie: e.cat, renvoye_le: invFmtDate(e.d), mois: e.d ? e.d.slice(0, 7) : '', annee: e.d ? e.d.slice(0, 4) : '' })),
                [['N° de colis', 'colis'], ['Catégorie', 'categorie'], ['Renvoyé le', 'renvoye_le'], ['Mois', 'mois'], ['Année', 'annee']],
                `inventaire_${new Date().toISOString().slice(0, 10)}.csv`);
        }
        async function invExportPdf() {
            if (!data.inventaire) { showToast('Aucun inventaire à exporter', 'error'); return; }
            const ok = await ensureJsPDF();
            if (!ok) { showToast('Librairie PDF indisponible', 'error'); return; }
            const { jsPDF } = window.jspdf || { jsPDF: window.jsPDF };
            const { list, q, cat, an, mo, jr } = invFiltres();
            const doc = new jsPDF();
            doc.setFontSize(16);
            doc.text('Rapport Inventaire — centre de tri', 14, 15);
            doc.setFontSize(9);
            doc.text(`Généré le ${new Date().toLocaleString('fr-FR')} · Mise à jour inventaire : ${new Date(data.inventaire.majLe).toLocaleDateString('fr-FR')}`, 14, 21);
            const filtres = [q && `Colis : ${q}`, cat && `Catégorie : ${cat}`, jr ? `Date : ${invFmtDate(jr)}` : (mo ? `Mois : ${INV_MOIS_FR[parseInt(mo.slice(5, 7))]} ${mo.slice(0, 4)}` : (an ? `Année : ${an}` : ''))].filter(Boolean).join(' · ');
            doc.text(`Filtres : ${filtres || 'aucun'} — ${list.length} référence(s)`, 14, 26);
            const parDate = {};
            list.forEach(e => { const k = e.d || 'Inconnue'; parDate[k] = (parDate[k] || 0) + 1; });
            doc.autoTable({ startY: 31, head: [['Date de renvoi', 'Nb colis']], body: Object.keys(parDate).sort().reverse().slice(0, 40).map(k => [k === 'Inconnue' ? 'Date inconnue' : invFmtDate(k), parDate[k]]), theme: 'grid', styles: { fontSize: 8 } });
            doc.autoTable({ startY: doc.lastAutoTable.finalY + 6, head: [['N° de colis', 'Catégorie', 'Renvoyé le']], body: list.slice(0, 600).map(e => [e.w, e.cat, invFmtDate(e.d)]), theme: 'striped', styles: { fontSize: 7 } });
            doc.save(`Rapport_Inventaire_${new Date().toISOString().slice(0, 10)}.pdf`);
        }

