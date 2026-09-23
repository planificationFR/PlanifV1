        // ═══════════════════════════════════════════════════════════════
        // ============== CONTRÔLE EPOD (Control Center intégré) ==============
        // Analyse qualité du fichier EPOD : contacts incomplets, anomalies
        // Sign Fail (GAP, adresse incorrecte, colis non trouvé, échec sans appel),
        // taux d'appel & pénalités (affichage seulement, en €), Next Day, anomalies priorisées.
        // Alimenté par l'import EPOD de l'Historique OU par import direct dans l'onglet.
        // Résultats sauvegardés par mois (listes plafonnées) ; le détail complet
        // reste en mémoire de session après un import.
        // ═══════════════════════════════════════════════════════════════
        const CC_CAPS = { contacts: 300, sign: 600, next: 400, control: 800 };
        let ccCurrentMonth = null;
        let ccCurrentView = 'dashboard';
        const _ccMem = {}; // { 'YYYY-MM': { rows: [enriched], analyse: {...complet} } }

        const CC_ALIAS = {
            waybill:  ['Numéro de la lettre', 'Waybill Number', 'Waybill', 'Tracking Number'],
            status:   ['Statut', 'Task Status', 'Status'],
            gap:      ['Distance', 'Delivery Gap Distance', 'Gap Distance'],
            contacts: ['Nombre de contacts', "Nombre d'appels", 'Call Times', 'Number of contacts', 'Number of contact', 'Number of calls', 'Calls'],
            exception:["Détails d'exception", "Détail d'échec de livraison", 'Delivery Fail Detail', 'Exception Detail', 'Exception'],
            anomalie: ["Type d'anormalie", "Raison d'échec de la tâche", 'Task Fail Reason', 'Anomaly Type'],
            address:  ['Adresse détaillée', 'Adresse', 'Detailed address', 'Detailed Address', 'Address'],
            courier:  ['Petit nom de membre', 'Chauffeur', 'Courier Name', 'Courier', 'Livreur', 'Driver Name', 'Driver'],
            city:     ['La ville de destination', 'Ville de destination', 'The destination city', 'Destination city', 'City', 'Ville'],
            zip:      ['Code postal', 'Code postal de destination', 'Destination Zip Code', 'Zip Code', 'Postal Code', 'Postcode'],
            name:     ['Nom du contact', 'Contact Name', 'Customer Name', 'Nom Client'],
            phone:    ['Téléphone de contact', 'Contact Phone', 'Phone Number', 'Phone', 'Mobile', 'Téléphone'],
            email:    ['Courrier', 'E-mail de contact', 'Contact Email', 'Email', 'E-mail', 'Mail'],
            task:     ['Ordre du groupe de travail', "Numéro d'arrêt", 'Stop Number', 'Task Group Order', 'Task Order'],
            dsp:      ['dspAction', 'DSP Action', 'Action DSP'],
            motif:    ["Raison d'échec de la tâche", "Type d'anormalie", 'Task Fail Reason', 'Task Failure Reason', 'Anomaly Type'],
            date:     ['Date de la tâche', 'originalPlanTaskDate', 'Task Date', 'Date']
        };
        const ccNorm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
        function ccBuildKeymap(rows) {
            const keys = new Set();
            rows.slice(0, 100).forEach(r => Object.keys(r || {}).forEach(k => keys.add(k)));
            const all = [...keys];
            const km = {};
            Object.entries(CC_ALIAS).forEach(([field, names]) => {
                let found = '';
                for (const n of names) { const k = all.find(x => ccNorm(x) === ccNorm(n)); if (k) { found = k; break; } }
                if (!found) for (const n of names) {
                    const nn = ccNorm(n);
                    const k = all.find(x => { const nx = ccNorm(x); return nx.length >= 4 && (nx.includes(nn) || nn.includes(nx)) && !/^heure|time$/.test(nx.slice(0, 5)); });
                    if (k) { found = k; break; }
                }
                km[field] = found;
            });
            return km;
        }
        const ccNum = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
        function ccDateKey(v) {
            if (v == null || v === '') return '';
            if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
            if (typeof v === 'number' && v > 20000 && v < 60000) {
                const d = new Date(Math.round((v - 25569) * 86400000));
                return isNaN(d) ? '' : d.toISOString().slice(0, 10);
            }
            const s = String(v).trim();
            let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (m) return `${m[1]}-${m[2]}-${m[3]}`;
            m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
            if (m) return `${m[3]}-${m[2]}-${m[1]}`;
            const d = new Date(s);
            return isNaN(d) ? '' : d.toISOString().slice(0, 10);
        }
        function ccEnrich(row, km) {
            const g = f => km[f] ? row[km[f]] : '';
            const date = ccDateKey(g('date'));
            return {
                date, month: date.slice(0, 7),
                waybill: String(g('waybill') ?? ''), status: String(g('status') ?? ''),
                gap: ccNum(g('gap')), contacts: ccNum(g('contacts')),
                exception: String(g('exception') ?? ''), anomalie: String(g('anomalie') ?? ''),
                address: String(g('address') ?? ''), courier: String(g('courier') || 'Inconnu'),
                city: String(g('city') ?? ''), zip: String(g('zip') ?? ''),
                name: String(g('name') ?? ''), phone: String(g('phone') ?? ''),
                email: String(g('email') ?? ''), task: String(g('task') ?? ''), dsp: String(g('dsp') ?? ''),
                motif: String(g('motif') ?? '')
            };
        }
        const ccIsFail = st => { const t = ccNorm(st); return t.includes('echec') || t.includes('failed') || t.includes('signfail') || (t.includes('livraison') && t.includes('echou')); };
        const ccIsSuccess = st => { const t = ccNorm(st); return t.includes('signsuccess') || t.includes('dropoffsuccess') || t.includes('delivered') || t.includes('deposereussie') || (t.includes('livraison') && t.includes('reussi')); };
        const CC_RX_COLIS = /(^|\b)(colis|parcel|package)\s*(non\s*trouv|not\s*found)/i;
        const CC_RX_BAL   = /\bbal\s*(non\s*trouv|not\s*found)/i;
        const CC_RX_ADDR  = /(adresse\s*incorrect|address\s*incorrect|wrong\s*address|bad\s*address|incorrect\s*address)/i;
        const ccOneName = n => { const s = String(n ?? '').trim(); if (!s) return false; const p = s.split(/[\s,;\/\\|]+/).filter(Boolean); return p.length === 1 && /^[A-Za-zÀ-ÿ'-]{2,}$/.test(p[0]); };
        /**
         * v54 — Nom de contact insuffisant pour identifier la boîte aux lettres :
         * vide, un seul mot, identifiant (chiffres), initiales, civilité seule,
         * mot répété. Renvoie le motif ('' si le nom est complet).
         */
        const CC_CIVILITES = new Set(['m', 'mr', 'mme', 'mlle', 'mrs', 'ms', 'miss', 'dr', 'madame', 'monsieur', 'mademoiselle', 'sir', 'famille', 'fam']);
        function ccMotifNomIncomplet(n) {
            const s = String(n ?? '').trim();
            if (!s) return 'vide';
            const brut = s.split(/[\s,;\/\\|]+/).filter(Boolean);
            const tokens = brut.filter(t => !CC_CIVILITES.has(t.toLowerCase().replace(/\./g, '')));
            if (!tokens.length) return 'civilité seule';
            const lettres = tokens.join('').replace(/[^A-Za-zÀ-ÿ]/g, '').length;
            if (lettres < 3 || tokens.every(t => /\d/.test(t))) return 'identifiant';
            const pleins = tokens.filter(t => t.replace(/[^A-Za-zÀ-ÿ]/g, '').length >= 2);
            if (pleins.length <= 1) return tokens.length > 1 ? 'initiale' : 'un seul mot';
            const uniq = new Set(pleins.map(t => t.toLowerCase().replace(/[^a-zà-ÿ]/g, '')));
            if (uniq.size === 1) return 'mot répété';
            return '';
        }
        function ccPenalty(rate) {
            if (rate >= 90) return ['Conforme', 0];
            if (rate >= 80) return ['Neutre', 0];
            if (rate >= 70) return ['Pénalité 70 €', 70];
            return ['Pénalité 90 €', 90];
        }
        function ccDefaultDsp(values) {
            const pref = values.find(v => { const n = ccNorm(v); return n.includes('autrejour') || n.includes('nextday'); });
            return pref || values[0] || '';
        }
        function ccAnalyseMonth(rows, gapSeuil, dspChoisi) {
            const contacts = rows.filter(r => ccOneName(r.name)).map(r => ({ waybill: r.waybill, name: r.name, phone: r.phone, email: r.email, task: r.task, courier: r.courier, city: r.city, address: r.address }));
            const sign = [];
            rows.forEach(r => {
                const txt = r.exception + ' ' + r.anomalie + ' ' + r.address + ' ' + r.status;
                const kColis = CC_RX_COLIS.test(txt) && !CC_RX_BAL.test(txt);
                const kBad = CC_RX_ADDR.test(txt);
                const kGap = r.gap > gapSeuil;
                const kC0 = ccIsFail(r.status) && r.contacts === 0; // échec de livraison sans aucun appel
                if (!(kColis || kBad || kGap || kC0)) return;
                const alerts = [];
                if (kBad) alerts.push('Adresse incorrecte');
                if (kColis) alerts.push('Colis non trouvé');
                if (kC0) alerts.push('Échec sans appel');
                if (kGap) alerts.push('GAP>' + gapSeuil);
                sign.push({ d: r.date, waybill: r.waybill, status: r.status, exception: (r.exception || r.anomalie), address: r.address, city: r.city, courier: r.courier, name: r.name, phone: r.phone, gap: Math.round(r.gap), contacts: r.contacts, alerts, kBad, kColis, kC0, kGap });
            });
            sign.sort((a, b) => (b.kBad - a.kBad) || (b.kColis - a.kColis) || (b.kC0 - a.kC0) || (b.gap - a.gap));
            // Appels par livreur ET par jour (permet le transfert de compte à compte jour par jour)
            const callsJour = {};
            rows.forEach(r => {
                const drv = r.courier || 'Inconnu';
                const dd = r.date || '';
                if (!callsJour[drv]) callsJour[drv] = {};
                if (!callsJour[drv][dd]) callsJour[drv][dd] = [0, 0];
                callsJour[drv][dd][0]++;
                if (r.contacts > 0) callsJour[drv][dd][1]++;
            });
            const calls = ccCallsFromJour(callsJour);
            const dspValues = [...new Set(rows.map(r => r.dsp).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
            const dsp = dspChoisi || ccDefaultDsp(dspValues);
            const next = rows.filter(r => r.dsp && ccNorm(r.dsp) === ccNorm(dsp))
                .sort((a, b) => String(a.courier).localeCompare(String(b.courier), 'fr', { sensitivity: 'base' }) || ((ccNum(a.task) || 999999) - (ccNum(b.task) || 999999)))
                .map(r => ({ d: r.date, task: r.task, waybill: r.waybill, courier: r.courier, city: r.city, zip: r.zip, address: r.address, name: r.name, phone: r.phone, email: r.email, gap: Math.round(r.gap), dsp: r.dsp }));
            const nm = new Map();
            next.forEach(r => { const d = r.courier || 'Sans livreur'; if (!nm.has(d)) nm.set(d, { driver: d, count: 0, cities: new Set() }); const o = nm.get(d); o.count++; if (r.city) o.cities.add(r.city); });
            const nextResume = [...nm.values()].map(o => ({ driver: o.driver, count: o.count, cities: [...o.cities] })).sort((a, b) => a.driver.localeCompare(b.driver, 'fr', { sensitivity: 'base' }));
            const control = [];
            const add = (r, type, priority, action) => control.push({ priority, d: r.d, waybill: r.waybill, type, courier: r.courier, city: r.city, name: r.name, phone: r.phone, address: r.address, action });
            sign.forEach(r => {
                if (r.kBad) add(r, 'Adresse incorrecte', 'high', 'Corriger / vérifier l\'adresse');
                if (r.kColis) add(r, 'Colis non trouvé', 'high', 'Contrôle terrain + preuve');
                if (r.kC0) add(r, 'Échec sans appel client', 'med', 'Appel client à contrôler');
                if (r.kGap) add(r, 'GAP distance élevé', 'med', 'Vérifier distance GPS');
            });
            contacts.forEach(c => add({ d: c.d, waybill: c.waybill, courier: c.courier, city: c.city, name: c.name, phone: c.phone, address: c.address }, 'Nom de contact incomplet', 'low', 'Compléter identité client'));
            next.forEach(r => {
                if (!r.address) add(r, 'Next Day sans adresse', 'high', 'Adresse obligatoire');
                if (!r.name) add(r, 'Next Day sans contact', 'med', 'Compléter contact');
                if (!r.phone) add(r, 'Next Day sans téléphone', 'med', 'Ajouter téléphone');
            });
            const ordre = { high: 0, med: 1, low: 2 };
            control.sort((a, b) => ordre[a.priority] - ordre[b.priority]);
            const kpis = {
                total: rows.length, contacts: contacts.length, sign: sign.length,
                bad: sign.filter(r => r.kBad).length, colis: sign.filter(r => r.kColis).length,
                c0: sign.filter(r => r.kC0).length, gap: sign.filter(r => r.kGap).length,
                next: next.length, penalises: calls.filter(r => r.penalite > 0).length,
                penalitesTotal: calls.reduce((s, r) => s + r.penalite, 0),
                tauxAppel: rows.length ? Number((rows.filter(r => r.contacts > 0).length / rows.length * 100).toFixed(1)) : 0,
                control: control.length
            };
            return { contacts, sign, calls, callsJour, next, nextResume, control, dspValues, dsp, gapSeuil, kpis };
        }
        /**
         * v53 — Fichier journalier (debrief, tournée) sans analyse mensuelle en
         * session : les compteurs d'appels par livreur/jour sont fusionnés dans
         * l'analyse stockée (créée vide si besoin), la ou les dates du fichier
         * remplaçant les compteurs existants de ces dates.
         */
        function ccFusionnerAppelsJournalier(m, rows, seuil) {
            const a = data.controlEPOD[m] || {
                analyseLe: null, gapSeuil: seuil, dsp: '', dspValues: [], kpis: { total: 0, contacts: 0, sign: 0, bad: 0, colis: 0, c0: 0, gap: 0, next: 0, penalises: 0, penalitesTotal: 0, tauxAppel: 0, control: 0 },
                calls: [], callsJour: {}, nextResume: [], contacts: [], sign: [], next: [], control: [], totaux: { contacts: 0, sign: 0, next: 0, control: 0 }, partiel: true
            };
            a.callsJour = a.callsJour || {};
            // Une date n'est remplacée que si le fichier entrant en contient au
            // moins autant de lignes que ce qui est stocké : le debrief du soir
            // (7 échecs) n'écrase pas la tournée du matin (599 tâches) ; l'inverse oui.
            const dates = new Set(rows.map(r => r.date).filter(Boolean));
            const stocke = d => Object.values(a.callsJour).reduce((s, j) => s + ((j[d] || [0, 0])[0]), 0);
            const aRemplacer = new Set([...dates].filter(d => rows.filter(r => r.date === d).length >= stocke(d)));
            Object.keys(a.callsJour).forEach(drv => aRemplacer.forEach(d => { delete a.callsJour[drv][d]; }));
            rows.forEach(r => {
                const drv = r.courier || 'Inconnu', d = r.date; if (!d || !aRemplacer.has(d)) return;
                if (!a.callsJour[drv]) a.callsJour[drv] = {};
                if (!a.callsJour[drv][d]) a.callsJour[drv][d] = [0, 0];
                a.callsJour[drv][d][0]++;
                if (r.contacts > 0) a.callsJour[drv][d][1]++;
            });
            a.calls = ccCallsFromJour(a.callsJour);
            let tot = 0, app = 0;
            Object.values(a.callsJour).forEach(j => Object.values(j).forEach(tc => { tot += tc[0]; app += tc[1]; }));
            a.kpis = a.kpis || {};
            a.kpis.tauxAppel = tot ? Number((app / tot * 100).toFixed(1)) : 0;
            a.kpis.penalises = a.calls.filter(r => r.penalite > 0).length;
            a.kpis.penalitesTotal = a.calls.reduce((s, r) => s + r.penalite, 0);
            a.kpis.total = tot;
            a.analyseLe = new Date().toISOString();
            data.controlEPOD[m] = a;
        }
        // Reconstruit le tableau des taux d'appel à partir des compteurs par jour
        function ccCallsFromJour(cj) {
            return Object.entries(cj || {}).map(([driver, jours]) => {
                let total = 0, calls = 0;
                Object.values(jours).forEach(tc => { total += tc[0]; calls += tc[1]; });
                const rate = total ? calls / total * 100 : 0;
                const p = total < 20 ? ['Volume faible (<20)', 0] : ccPenalty(rate);
                return { driver, total, calls, rate: Number(rate.toFixed(1)), statut: p[0], penalite: p[1] };
            }).filter(r => r.total > 0).sort((x, y) => x.rate - y.rate);
        }
        // Transfère une journée d'un COMPTE à un autre dans les analyses Contrôle EPOD
        // (taux d'appel, anomalies, Next Day, contacts). Utilisé quand un livreur travaille
        // avec deux comptes le même jour (ex : Yanis-Colmar + Lyes-Comlar).
        function ccTransfererJour(dateISO, source, target) {
            const month = String(dateISO).slice(0, 7);
            const eq = (x, y) => ccNorm(x) === ccNorm(y);
            // Cas 1 : lignes complètes en mémoire de session → renommage + ré-analyse exacte
            if (_ccMem[month]) {
                let n = 0;
                _ccMem[month].rows.forEach(r => { if (r.date === dateISO && eq(r.courier, source)) { r.courier = target; n++; } });
                if (!n) return { ok: false, raison: 'aucune ligne pour ce compte à cette date' };
                const prev = _ccMem[month].analyse;
                const analyse = ccAnalyseMonth(_ccMem[month].rows, prev.gapSeuil, prev.dsp);
                _ccMem[month].analyse = analyse;
                if (!data.controlEPOD) data.controlEPOD = {};
                data.controlEPOD[month] = ccCap(analyse);
                marquerImport('cc:' + month);
                return { ok: true, n, mode: 'session' };
            }
            // Cas 2 : analyse stockée seulement (listes plafonnées avec dates)
            const a = data.controlEPOD?.[month];
            if (!a) return { ok: false, raison: 'aucune analyse Contrôle EPOD pour ce mois' };
            if (!a.callsJour) return { ok: false, raison: 'analyse antérieure à cette version — réimportez le fichier EPOD du mois pour transférer aussi le Contrôle' };
            let n = 0;
            ['sign', 'next', 'contacts', 'control'].forEach(k => (a[k] || []).forEach(r => {
                if (r.d === dateISO && eq(r.courier, source)) { r.courier = target; n++; }
            }));
            const srcKey = Object.keys(a.callsJour).find(k => eq(k, source));
            if (srcKey && a.callsJour[srcKey][dateISO]) {
                const tc = a.callsJour[srcKey][dateISO];
                const tgtKey = Object.keys(a.callsJour).find(k => eq(k, target)) || target;
                if (!a.callsJour[tgtKey]) a.callsJour[tgtKey] = {};
                if (!a.callsJour[tgtKey][dateISO]) a.callsJour[tgtKey][dateISO] = [0, 0];
                a.callsJour[tgtKey][dateISO][0] += tc[0];
                a.callsJour[tgtKey][dateISO][1] += tc[1];
                delete a.callsJour[srcKey][dateISO];
                if (!Object.keys(a.callsJour[srcKey]).length) delete a.callsJour[srcKey];
                n += tc[0];
            }
            a.calls = ccCallsFromJour(a.callsJour);
            const nm = {};
            (a.next || []).forEach(r => { const d0 = r.courier || 'Sans livreur'; if (!nm[d0]) nm[d0] = { driver: d0, count: 0, cities: new Set() }; nm[d0].count++; if (r.city) nm[d0].cities.add(r.city); });
            a.nextResume = Object.values(nm).map(o => ({ driver: o.driver, count: o.count, cities: [...o.cities] })).sort((x, y) => x.driver.localeCompare(y.driver, 'fr', { sensitivity: 'base' }));
            if (a.kpis) {
                a.kpis.penalises = a.calls.filter(r => r.penalite > 0).length;
                a.kpis.penalitesTotal = a.calls.reduce((s, r) => s + r.penalite, 0);
                let T = 0, C = 0;
                a.calls.forEach(r => { T += r.total; C += r.calls; });
                a.kpis.tauxAppel = T ? Number((C / T * 100).toFixed(1)) : 0;
            }
            return { ok: n > 0, n, mode: 'stocké', raison: n > 0 ? undefined : 'aucune ligne pour ce compte à cette date' };
        }
        function ccCap(a) {
            // Tronque les champs longs pour limiter la taille en localStorage/cloud
            const t = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
            const trim = o => { const c = { ...o }; if ('address' in c) c.address = t(c.address, 90); if ('exception' in c) c.exception = t(c.exception, 70); if ('name' in c) c.name = t(c.name, 40); if ('status' in c) c.status = t(c.status, 40); return c; };
            return {
                analyseLe: new Date().toISOString(), gapSeuil: a.gapSeuil, dsp: a.dsp, dspValues: a.dspValues,
                kpis: a.kpis, calls: a.calls, callsJour: a.callsJour, nextResume: a.nextResume,
                contacts: a.contacts.slice(0, CC_CAPS.contacts).map(trim), sign: a.sign.slice(0, CC_CAPS.sign).map(trim),
                next: a.next.slice(0, CC_CAPS.next).map(trim), control: a.control.slice(0, CC_CAPS.control).map(trim),
                totaux: { contacts: a.contacts.length, sign: a.sign.length, next: a.next.length, control: a.control.length }
            };
        }
        function ccIngestRows(jsonData, opts = {}) {
            if (!Array.isArray(jsonData) || !jsonData.length) return { months: [], total: 0 };
            const km = ccBuildKeymap(jsonData);
            const enriched = jsonData.map(r => ccEnrich(r, km)).filter(r => r.month && /^\d{4}-\d{2}$/.test(r.month));
            // Déduplication par waybill : un colis livré ne compte qu'une fois,
            // sur le dernier compte qui l'a scanné (transferts entre comptes).
            // v43 — clé (colis, date) : une relivraison un autre jour est une journée distincte.
            const _last = new Map();
            const _cle = (r) => r.waybill + '|' + (r.date || '');
            enriched.forEach((r, i) => { if (r.waybill && ccIsSuccess(r.status)) _last.set(_cle(r), i); });
            const dedup = enriched.filter((r, i) => !(r.waybill && ccIsSuccess(r.status)) || _last.get(_cle(r)) === i);
            const parMois = {};
            dedup.forEach(r => { (parMois[r.month] = parMois[r.month] || []).push(r); });
            // v53 — un fichier journalier (debrief du soir, tournée du matin) est
            // accepté quelle que soit sa taille et FUSIONNE par journée : seules
            // les dates qu'il contient sont remplacées, le reste du mois reste.
            const months = Object.keys(parMois).filter(m => parMois[m].length >= 1).sort();
            if (!data.controlEPOD) data.controlEPOD = {};
            const seuil = ccNum(data.ccGapSeuil) || 500;
            const datesFichier = new Set(dedup.map(r => r.date).filter(Boolean));
            let classe = opts.classe;
            if (!classe) { try { classe = classifierFichierEPOD(jsonData).classe; } catch (e) { classe = 'inconnu'; } }
            const journalier = classe === 'debrief' || classe === 'tournee' || (datesFichier.size <= 3 && dedup.length < 2000);
            months.forEach(m => {
                let rows = parMois[m];
                if (journalier) {
                    if (_ccMem[m] && _ccMem[m].rows) {
                        rows = [..._ccMem[m].rows.filter(r => !datesFichier.has(r.date)), ...parMois[m]];
                    } else {
                        // Pas de détail mensuel en session : on ne refabrique pas
                        // l'analyse du mois à partir de 7 lignes, mais on fusionne
                        // les compteurs d'appels de la journée (vue « Appels »).
                        ccFusionnerAppelsJournalier(m, parMois[m], seuil);
                        return;
                    }
                }
                const analyse = ccAnalyseMonth(rows, seuil, null);
                _ccMem[m] = { rows, analyse };
                data.controlEPOD[m] = ccCap(analyse);
            });
            // Un debrief ne met à jour que les échecs du jour ; une tournée du matin
            // que les noms à vérifier ; un export complet met à jour les deux.
            ccStockerJournees(dedup, classe === 'debrief' ? 'next' : classe === 'tournee' ? 'contacts' : 'tous');
            if (months.length) {
                markUnsaved(); saveLocal();
                ccCurrentMonth = months[months.length - 1];
                ccPopulateMonths();
                if (!opts.silencieux) ccRenderAll();
                else { try { ccRenderAll(); } catch (e) {} }
            }
            return { months, total: enriched.length };
        }
        // ═══════════════════════════════════════════════════════════════
        // v53 — LISTES JOURNALIÈRES POUR LES LIVREURS
        //  · contacts : nom vide ou un seul mot → ordre, nom d'origine, email
        //  · next     : échecs avec Action DSP (à réintégrer / retour Cainiao)
        // Stockées par date (quelques lignes/jour), remplacées à chaque import
        // de la même date, purgées par la rétention.
        // ═══════════════════════════════════════════════════════════════
        const CC_DSP_REINTEGRER = /autre\s*jour|autrejour|next\s*day|nextday|reint|retent/i;
        const CC_DSP_RETOUR = /retour|return|cainiao/i;
        function ccTypeDsp(v) { const t = String(v || ''); if (!t) return ''; if (CC_DSP_REINTEGRER.test(t)) return 'reintegrer'; if (CC_DSP_RETOUR.test(t)) return 'retour'; return 'autre'; }
        function ccStockerJournees(rows, quoi) {
            if (!data.ccJour) data.ccJour = {};
            quoi = quoi || 'tous';
            const parDate = {};
            rows.forEach(r => { if (r.date) (parDate[r.date] = parDate[r.date] || []).push(r); });
            Object.entries(parDate).forEach(([d, list]) => {
                // Plusieurs colis pour le même client au même arrêt → une seule ligne (×n)
                const cm = new Map();
                list.forEach(r => {
                    const motif = ccMotifNomIncomplet(r.name);
                    if (!motif) return;
                    const k = [r.courier, ccNum(r.task) || '', ccNorm(r.name), ccNorm(r.email)].join('|');
                    if (cm.has(k)) { cm.get(k).n++; return; }
                    cm.set(k, { task: ccNum(r.task) || null, name: r.name || '', email: r.email || '', phone: r.phone || '', courier: r.courier || '', waybill: r.waybill, city: r.city || '', address: r.address || '', n: 1, motif });
                });
                const contacts = [...cm.values()];
                const next = list.filter(r => r.dsp)
                    .map(r => ({ task: ccNum(r.task) || null, waybill: r.waybill, courier: r.courier || '', name: r.name || '', phone: r.phone || '', address: r.address || '', city: r.city || '', zip: r.zip || '', motif: r.motif || '', detail: r.exception || '', dsp: r.dsp, type: ccTypeDsp(r.dsp), appels: r.contacts || 0 }));
                const tri = (a, b) => String(a.courier).localeCompare(String(b.courier), 'fr', { sensitivity: 'base' }) || ((a.task ?? 999999) - (b.task ?? 999999));
                contacts.sort(tri); next.sort(tri);
                const prec = data.ccJour[d] || { contacts: [], next: [] };
                data.ccJour[d] = {
                    importe: new Date().toISOString(), lignes: list.length,
                    contacts: quoi === 'next' ? (prec.contacts || []) : contacts,
                    next: quoi === 'contacts' ? (prec.next || []) : next,
                    importeContacts: quoi === 'next' ? prec.importeContacts : new Date().toISOString(),
                    importeNext: quoi === 'contacts' ? prec.importeNext : new Date().toISOString()
                };
                marquerImport('ccjour:' + d);
            });
        }
        function ccDatesJour(mois) {
            return Object.keys(data.ccJour || {}).filter(d => !mois || d.startsWith(mois)).sort().reverse();
        }
        let ccJourContacts = '', ccJourNext = '';
        function _ccSelecteurJour(id, valeur, onchange) {
            const dates = ccDatesJour(ccCurrentMonth);
            if (!dates.length) return '';
            const v = dates.includes(valeur) ? valeur : dates[0];
            return `<select class="form-select" id="${id}" onchange="${onchange}" style="min-width:170px;">${dates.map(d => `<option value="${escapeHtml(d)}" ${d === v ? 'selected' : ''}>${escapeHtml(d.split('-').reverse().join('/'))} (${(data.ccJour[d].contacts || []).length} noms · ${(data.ccJour[d].next || []).length} échecs)</option>`).join('')}</select>`;
        }
        function _ccGrouperLivreur(list) {
            const m = new Map();
            list.forEach(r => { const k = r.courier || 'Sans livreur'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
            return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'fr', { sensitivity: 'base' }));
        }
        const _ccDateFr = d => d ? d.split('-').reverse().join('/') : '';
        /** Texte WhatsApp : une ligne par colis, ordre d'arrêt en tête. */
        function ccTexteContacts(livreur, date, rows) {
            const L = [`*${livreur} — ${_ccDateFr(date)} — ${rows.length} nom(s) à vérifier*`];
            rows.forEach(r => L.push(`#${r.task ?? '?'} · ${r.name || '(sans nom)'} · ${r.email || '(sans email)'}${r.n > 1 ? ` (×${r.n} colis)` : ''}`));
            return L.join('\n');
        }
        function ccTexteNext(livreur, date, rows) {
            const lib = { reintegrer: 'À RÉINTÉGRER', retour: 'RETOUR CAINIAO', autre: 'AUTRE' };
            const L = [`*${livreur} — ${_ccDateFr(date)} — ${rows.length} colis*`];
            ['reintegrer', 'retour', 'autre'].forEach(t => {
                const sub = rows.filter(r => r.type === t); if (!sub.length) return;
                L.push(`_${lib[t]} (${sub.length})_`);
                sub.forEach(r => L.push(`#${r.task ?? '?'} · ${r.name || '(sans nom)'} · ${[r.address, r.zip, r.city].filter(Boolean).join(' ')}${r.motif ? ' · ' + r.motif : ''}${r.phone && r.phone !== '.' ? ' · ' + r.phone : ''}`));
            });
            return L.join('\n');
        }
        const _ccTextes = {};
        function ccCopier(cle) {
            const txt = _ccTextes[cle]; if (!txt) return;
            const ok = () => showToast('Copié — collez dans WhatsApp', 'success');
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(ok).catch(() => _ccCopierFallback(txt, ok));
            else _ccCopierFallback(txt, ok);
        }
        function _ccCopierFallback(txt, ok) {
            const ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); ok(); } catch (e) { showToast('Copie impossible : sélectionnez le texte', 'error'); }
            ta.remove();
        }
        function ccCarteLivreur(cle, livreur, sousTitre, rows, lignesHtml, texte, couleur) {
            _ccTextes[cle] = texte;
            return `<div style="border:1px solid var(--border);border-left:4px solid ${couleur};border-radius:10px;padding:0.6rem 0.75rem;margin-bottom:0.6rem;background:var(--card);">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap;">
                    <div><strong style="font-size:0.95rem;">${escapeHtml(livreur)}</strong> <span style="color:var(--text-secondary);font-size:0.8rem;">${escapeHtml(sousTitre)}</span></div>
                    <button class="btn btn-sm btn-primary" onclick="ccCopier('${escJsAttr(cle)}')" title="Copier le texte prêt à coller dans WhatsApp"><i class="fab fa-whatsapp"></i> Copier</button>
                </div>
                <div style="margin-top:0.4rem;font-size:0.84rem;line-height:1.55;">${lignesHtml}</div>
            </div>`;
        }
        function ccChangerJourContacts() { ccJourContacts = document.getElementById('ccJourContactsSel')?.value || ''; ccRenderContacts(); }
        function ccChangerJourNext() { ccJourNext = document.getElementById('ccJourNextSel')?.value || ''; ccRenderNext(); }
        let ccNextType = 'tous';
        function ccChangerTypeNext() { ccNextType = document.getElementById('ccDspFilter')?.value || 'tous'; ccRenderNext(); }

        async function ccHandleUpload(event) {
            const f = event.target.files[0];
            if (!f) return;
            event.target.value = '';
            const statusEl = document.getElementById('ccStatus');
            try {
                if (statusEl) statusEl.textContent = 'Lecture du fichier…';
                await loadXLSXLib();
                const wb = f.name.toLowerCase().endsWith('.csv')
                    ? XLSX.read(await f.text(), { type: 'string' })
                    : XLSX.read(await f.arrayBuffer(), { type: 'array' });
                const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
                if (!json.length) { showToast('Le fichier est vide', 'error'); return; }
                if (!(await verifierClasseFichier(json, 'cc', ['realise', 'debrief', 'tournee'], ['partiel']))) return;
                const res = ccIngestRows(json, { classe: classifierFichierEPOD(json).classe });
                if (res.months.length) showToast(`Analyse terminée : ${res.total} lignes (${res.months.map(formatMonthName).join(', ')})`, 'success');
                else showToast('Aucune ligne datée reconnue dans ce fichier', 'error');
            } catch (err) {
                console.error('[CC] import', err);
                showToast("Erreur lors de l'import Contrôle EPOD", 'error');
            } finally { if (statusEl) ccUpdateStatus(); }
        }
        function ccGet() {
            const m = ccCurrentMonth;
            if (!m) return null;
            if (_ccMem[m]) return { a: _ccMem[m].analyse, live: true };
            const st = data.controlEPOD?.[m];
            return st ? { a: st, live: false } : null;
        }
        function ccPopulateMonths() {
            const sel = document.getElementById('ccMonthSelect');
            if (!sel) return;
            const months = [...new Set([...Object.keys(data.controlEPOD || {}), ...Object.keys(data.ccJour || {}).map(d => d.slice(0, 7))])].sort().reverse();
            if (!ccCurrentMonth || !months.includes(ccCurrentMonth)) {
                ccCurrentMonth = months.includes(selectedHistoriqueMonth) ? selectedHistoriqueMonth : (months[0] || null);
            }
            sel.innerHTML = months.length
                ? months.map(m => `<option value="${escapeHtml(m)}" ${m === ccCurrentMonth ? 'selected' : ''}>${escapeHtml(formatMonthName(m))}</option>`).join('')
                : '<option value="">-- Aucune analyse --</option>';
        }
        function ccSelectMonth() {
            const sel = document.getElementById('ccMonthSelect');
            if (sel && sel.value) { ccCurrentMonth = sel.value; ccRenderAll(); }
        }
        function ccUpdateStatus() {
            const el = document.getElementById('ccStatus');
            if (!el) return;
            const g = ccGet();
            const nbJours = ccDatesJour().length;
            if (!g) { el.textContent = nbJours ? `${nbJours} journée(s) importée(s) (noms à vérifier / debrief) — aucune analyse mensuelle.` : 'Aucune analyse — importez un fichier EPOD.'; return; }
            if (g.a.partiel) { el.textContent = `Analyse construite à partir de fichiers journaliers (${Object.keys(g.a.callsJour || {}).length} livreurs, ${nbJours} journée(s)) — le taux d'appel porte sur les lignes importées (échecs du debrief), pas sur toutes les tâches du mois.`; return; }
            const quand = g.a.analyseLe ? new Date(g.a.analyseLe).toLocaleString('fr-FR') : '';
            el.innerHTML = `${escapeHtml((g.a.kpis?.total || 0).toLocaleString('fr-FR'))} lignes analysées${quand ? ' · ' + quand : ''} · ${g.live ? '<span style="color:var(--success);font-weight:700;">détail complet (session)</span>' : 'détail stocké'}${ccLivreur ? ` · <span style="color:var(--primary);font-weight:700;"><i class="fas fa-filter"></i> ${escapeHtml(ccLivreur)}</span>` : ''}`;
        }
        function ccSwitchView(v) {
            ccCurrentView = v;
            document.querySelectorAll('.cc-view').forEach(el => el.style.display = 'none');
            const el = document.getElementById('ccView-' + v);
            if (el) el.style.display = '';
            document.querySelectorAll('#ccPills [data-ccview]').forEach(b => {
                b.classList.toggle('btn-primary', b.dataset.ccview === v);
                b.classList.toggle('btn-secondary', b.dataset.ccview !== v);
            });
        }
        function ccKpi(label, value, color, icon, goto) {
            const click = goto ? ` onclick="${goto}" style="cursor:pointer;" title="Cliquer pour voir le détail"` : '';
            const fleche = goto ? ' <i class="fas fa-arrow-right" style="font-size:0.6rem;opacity:0.5;"></i>' : '';
            return `<div class="stat-card"${click}><div class="stat-icon"><i class="fas ${icon || 'fa-chart-simple'}" style="color:${color || 'var(--primary)'};"></i></div><div class="stat-value" style="color:${color || 'inherit'};">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}${fleche}</div></div>`;
        }
        // Navigation directe depuis le dashboard vers une vue détaillée (avec pré-filtre)
        function ccGoto(view, signFilter) {
            if (signFilter) { const f = document.getElementById('ccSignFilter'); if (f) f.value = signFilter; }
            ccSwitchView(view);
            if (view === 'signfail') ccRenderSign();
            document.getElementById('ccPills')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        // Filtre livreur global (toutes les vues + exports)
        let ccLivreur = '';
        function ccChangeLivreur() {
            ccLivreur = document.getElementById('ccLivreurFilter')?.value || '';
            ccRenderAll();
        }
        function ccFiltreLivreur(list, champ) {
            if (!ccLivreur) return list;
            const f = champ || 'courier';
            return (list || []).filter(r => String(r[f] || '') === ccLivreur);
        }
        function ccPopulateLivreurs() {
            const sel = document.getElementById('ccLivreurFilter');
            if (!sel) return;
            const g = ccGet();
            const noms = [...new Set([...(g ? (g.a.calls || []).map(c => c.driver) : []), ...Object.values(data.ccJour || {}).flatMap(j => [...(j.contacts || []), ...(j.next || [])].map(r => r.courier).filter(Boolean))])].sort((x, y) => x.localeCompare(y, 'fr', { sensitivity: 'base' }));
            const avant = ccLivreur;
            sel.innerHTML = '<option value="">Tous les livreurs</option>' + noms.map(n => `<option value="${escAttr(n)}" ${n === avant ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
            if (avant && !noms.includes(avant)) { ccLivreur = ''; sel.value = ''; }
        }
        // Suppression des analyses (le datage de chaque analyse est affiché dans le statut)
        function ccDeleteMonth() {
            const m = ccCurrentMonth;
            const jours = m ? ccDatesJour(m) : [];
            const aMois = !!(m && data.controlEPOD?.[m]);
            if (!m || (!aMois && !jours.length)) { showToast('Aucune analyse à supprimer', 'error'); return; }
            if (!confirm(`Supprimer Contrôle EPOD de ${formatMonthName(m)} ?\n\n${aMois ? '• analyse mensuelle\n' : ''}${jours.length ? `• ${jours.length} journée(s) (noms à vérifier / debrief)` : ''}`)) return;
            if (aMois) delete data.controlEPOD[m];
            delete _ccMem[m];
            jours.forEach(d => { delete data.ccJour[d]; if (data.datesImport) delete data.datesImport['ccjour:' + d]; });
            if (data.datesImport) delete data.datesImport['cc:' + m];
            ccCurrentMonth = null; ccJourContacts = ''; ccJourNext = '';
            markUnsaved(); saveLocal();
            ccRenderAll();
            showToast(`${formatMonthName(m)} supprimé`, 'success');
        }
        function ccDeleteAll() {
            const nMois = Object.keys(data.controlEPOD || {}).length;
            const nJours = Object.keys(data.ccJour || {}).length;
            if (!nMois && !nJours) { showToast('Aucune analyse à effacer', 'error'); return; }
            if (!confirm(`Effacer TOUT Contrôle EPOD (${nMois} mois, ${nJours} journée(s)) ? Cette action est définitive.`)) return;
            try { snapshotCreer('avant effacement Contrôle EPOD'); } catch (e) {}
            data.controlEPOD = {};
            data.ccJour = {};
            if (data.datesImport) Object.keys(data.datesImport).forEach(k => { if (k.startsWith('cc:') || k.startsWith('ccjour:')) delete data.datesImport[k]; });
            Object.keys(_ccMem).forEach(k => delete _ccMem[k]);
            ccCurrentMonth = null; ccJourContacts = ''; ccJourNext = '';
            markUnsaved(); saveLocal();
            ccRenderAll();
            showToast('Toutes les analyses ont été effacées', 'success');
        }
        function ccBars(id, items, color) {
            const el = document.getElementById(id);
            if (!el) return;
            const max = Math.max(1, ...items.map(i => i.value));
            el.innerHTML = items.map(i => `
                <div style="display:flex;align-items:center;gap:0.6rem;margin-bottom:0.45rem;">
                    <div style="flex:0 0 150px;font-size:0.78rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</div>
                    <div style="flex:1;height:14px;background:rgba(0,0,0,0.06);border-radius:7px;overflow:hidden;">
                        <div style="height:100%;width:${Math.round(i.value / max * 100)}%;background:${color};border-radius:7px;"></div>
                    </div>
                    <div style="flex:0 0 46px;text-align:right;font-size:0.8rem;font-weight:700;">${escapeHtml(i.value.toLocaleString('fr-FR'))}</div>
                </div>`).join('') || '<p style="font-size:0.82rem;color:var(--text-secondary);">Aucune donnée.</p>';
        }
        function ccTableHtml(headers, rowsHtml) {
            return '<thead><tr>' + headers.map(h => `<th style="position:sticky;top:0;background:var(--background-light);padding:7px 9px;text-align:left;font-size:0.76rem;border-bottom:2px solid var(--border-light);white-space:nowrap;z-index:1;">${h}</th>`).join('') + '</tr></thead><tbody>' + rowsHtml + '</tbody>';
        }
        const ccTd = v => `<td style="padding:6px 9px;border-bottom:1px solid var(--border-light);white-space:nowrap;">${escapeHtml(v ?? '')}</td>`;
        function ccNote(id, shown, total, live) {
            const el = document.getElementById(id);
            if (!el) return;
            el.innerHTML = (!live && total > shown)
                ? `<p style="font-size:0.78rem;color:#FF8A65;margin:0 0 0.5rem;"><i class="fas fa-circle-info"></i> Stockage limité aux ${shown} premières lignes sur ${escapeHtml(total)} — réimportez le fichier EPOD du mois pour le détail complet.</p>`
                : '';
        }
        function ccEmpty(tableId) {
            const t = document.getElementById(tableId);
            if (t) t.innerHTML = '<tbody><tr><td style="padding:1.2rem;color:var(--text-secondary);">Aucune analyse pour ce mois. Importez un fichier EPOD (ici ou dans l\'onglet Historique).</td></tr></tbody>';
        }
        function ccRenderDashboard() {
            const g = ccGet();
            const k = g?.a?.kpis;
            const kp = document.getElementById('ccKpis');
            if (!kp) return;
            if (!k) { kp.innerHTML = ccKpi('Lignes analysées', 0, 'var(--text-secondary)', 'fa-inbox'); ccBars('ccChartAnomalies', [], 'var(--primary)'); ccBars('ccChartDrivers', [], 'var(--danger)'); return; }
            kp.innerHTML =
                ccKpi('Lignes EPOD', k.total.toLocaleString('fr-FR'), 'var(--primary)', 'fa-database') +
                ccKpi('Taux d\'appel', k.tauxAppel + '%', 'var(--info)', 'fa-phone', "ccGoto('calls')") +
                ccKpi('Anomalies détectées', k.sign, 'var(--danger)', 'fa-triangle-exclamation', "ccGoto('signfail','all')") +
                ccKpi('Adresse incorrecte', k.bad, 'var(--danger)', 'fa-location-dot', "ccGoto('signfail','adresse')") +
                ccKpi('Colis non trouvé', k.colis, 'var(--danger)', 'fa-box-open', "ccGoto('signfail','colis')") +
                ccKpi('Échec sans appel', k.c0, 'var(--warning)', 'fa-phone-slash', "ccGoto('signfail','contact0')") +
                ccKpi('Next Day', k.next, 'var(--secondary)', 'fa-truck-fast', "ccGoto('nextday')") +
                ccKpi('Livreurs pénalisés', k.penalises, 'var(--warning)', 'fa-user-xmark', "ccGoto('calls')") +
                ccKpi('Pénalités (indicatif)', k.penalitesTotal + ' €', 'var(--warning)', 'fa-coins', "ccGoto('calls')") +
                ccKpi('À traiter (anomalies)', k.control, 'var(--danger)', 'fa-bullseye', "ccGoto('control')");
            ccBars('ccChartAnomalies', [
                { label: 'Adresse incorrecte', value: k.bad }, { label: 'Colis non trouvé', value: k.colis },
                { label: 'Échec sans appel', value: k.c0 }, { label: 'GAP > ' + (g.a.gapSeuil || 500), value: k.gap },
                { label: 'Contact nom seul', value: k.contacts }, { label: 'Next Day', value: k.next }
            ], 'var(--primary)');
            const m = {};
            (g.a.control || []).forEach(r => m[r.courier] = (m[r.courier] || 0) + 1);
            ccBars('ccChartDrivers', Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value })), 'var(--danger)');
        }
        function ccRenderContacts() {
            const note = document.getElementById('ccContactsNote');
            const table = document.getElementById('ccContactsTable');
            if (!note || !table) return;
            const q = ccNorm(document.getElementById('ccContactSearch')?.value || '');
            // v53 — vue journalière par livreur (fichier « colis à livrer dans la journée »)
            const dates = ccDatesJour(ccCurrentMonth);
            if (dates.length) {
                const d = dates.includes(ccJourContacts) ? ccJourContacts : dates[0];
                ccJourContacts = d;
                const rows = ccFiltreLivreur((data.ccJour[d] || {}).contacts || []).filter(r => !q || ccNorm([r.name, r.email, r.phone, r.courier, r.waybill].join(' ')).includes(q));
                const groupes = _ccGrouperLivreur(rows);
                const cartes = groupes.map(([liv, list], i) => {
                    const c = (typeof getLivreurColor === 'function') ? getLivreurColor(i) : 'var(--primary)';
                    const lignes = list.map(r => `<div style="display:grid;grid-template-columns:52px 1fr 1.4fr;gap:0.5rem;padding:2px 0;border-bottom:1px dashed var(--border-light);"><span style="font-weight:800;color:${c};">#${escapeHtml(r.task ?? '?')}</span><span>${r.name ? escapeHtml(r.name) : '<em style="color:var(--danger);">sans nom</em>'}${r.motif && r.motif !== 'un seul mot' ? ` <span style="font-size:0.68rem;color:var(--text-secondary);border:1px solid var(--border-light);border-radius:6px;padding:0 5px;">${escapeHtml(r.motif)}</span>` : ''}</span><span style="color:var(--text-secondary);word-break:break-all;">${escapeHtml(r.email || '—')}${r.n > 1 ? ` <strong>×${escapeHtml(r.n)}</strong>` : ''}</span></div>`).join('');
                    return ccCarteLivreur('contacts|' + d + '|' + liv, liv, `${list.length} nom(s) à vérifier · ${_ccDateFr(d)}`, list, lignes, ccTexteContacts(liv, d, list), c);
                }).join('');
                note.innerHTML = `
                    <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-bottom:0.6rem;">
                        ${_ccSelecteurJour('ccJourContactsSel', d, 'ccChangerJourContacts()')}
                        <span style="font-size:0.8rem;color:var(--text-secondary);">${rows.length} colis · ${groupes.length} livreur(s)${data.ccJour[d].importeContacts ? ` · importé le ${new Date(data.ccJour[d].importeContacts).toLocaleString('fr-FR')}` : ''}</span>
                        ${groupes.length > 1 ? `<button class="btn btn-sm btn-secondary" onclick="ccCopierTout('contacts')"><i class="fab fa-whatsapp"></i> Tout copier</button>` : ''}
                    </div>
                    ${cartes || '<p style="font-size:0.82rem;color:var(--text-secondary);">Aucun nom incomplet ce jour-là.</p>'}`;
                _ccTextes['contacts|tout'] = groupes.map(([liv, list]) => ccTexteContacts(liv, d, list)).join('\n\n');
                table.innerHTML = '';
                return;
            }
            const g = ccGet();
            if (!g) { note.innerHTML = ''; ccEmpty('ccContactsTable'); return; }
            const base = ccFiltreLivreur(g.a.contacts || []);
            const list = base.filter(r => !q || ccNorm(Object.values(r).join(' ')).includes(q));
            ccNote('ccContactsNote', (g.a.contacts || []).length, g.a.totaux ? g.a.totaux.contacts : (g.a.contacts || []).length, g.live);
            table.innerHTML = ccTableHtml(
                ['Ordre', 'Contact', 'Email', 'Téléphone', 'Adresse', 'Ville', 'Waybill', 'Livreur'],
                list.slice(0, 1000).map(r => '<tr>' + [r.task, r.name, r.email, r.phone, r.address, r.city, r.waybill, r.courier].map(ccTd).join('') + '</tr>').join('')
            );
        }
        function ccCopierTout(vue) { ccCopier(vue + '|tout'); }
        function ccRenderSign() {
            const g = ccGet();
            if (!g) { ccEmpty('ccSignTable'); const k = document.getElementById('ccSignKpis'); if (k) k.innerHTML = ''; return; }
            const seuilInput = document.getElementById('ccGapThreshold');
            if (seuilInput && g.a.gapSeuil) seuilInput.value = g.a.gapSeuil;
            const f = document.getElementById('ccSignFilter')?.value || 'all';
            const q = ccNorm(document.getElementById('ccSignSearch')?.value || '');
            const base = ccFiltreLivreur(g.a.sign || []);
            const list = base
                .filter(r => f === 'all' || (f === 'gap' && r.kGap) || (f === 'contact0' && r.kC0) || (f === 'colis' && r.kColis) || (f === 'adresse' && r.kBad))
                .filter(r => !q || ccNorm([r.waybill, r.address, r.city, r.courier, r.exception, r.name].join(' ')).includes(q));
            const k = g.a.kpis;
            document.getElementById('ccSignKpis').innerHTML =
                ccKpi('À contrôler', k.sign, 'var(--danger)', 'fa-triangle-exclamation') +
                ccKpi('Adresse incorrecte', k.bad, 'var(--danger)', 'fa-location-dot') +
                ccKpi('Colis non trouvé', k.colis, 'var(--danger)', 'fa-box-open') +
                ccKpi('Échec sans appel', k.c0, 'var(--warning)', 'fa-phone-slash') +
                ccKpi('GAP > seuil', k.gap, 'var(--warning)', 'fa-route');
            ccNote('ccSignNote', base.length, g.a.totaux ? g.a.totaux.sign : base.length, g.live);
            const badge = a => `<span style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:0.68rem;font-weight:700;margin:1px;background:${(a.includes('Adresse') || a.includes('Colis')) ? 'rgba(231,76,60,0.12)' : 'rgba(255,138,101,0.15)'};color:${(a.includes('Adresse') || a.includes('Colis')) ? 'var(--danger)' : '#FF8A65'};">${escapeHtml(a)}</span>`;
            document.getElementById('ccSignTable').innerHTML = ccTableHtml(
                ['Contact', 'Téléphone', 'Adresse', 'Ville', 'Waybill', 'Livreur', 'Exception', 'Statut', 'GAP', 'Appels', 'Alertes'],
                list.slice(0, 1200).map(r => '<tr>' + [r.name, r.phone, r.address, r.city, r.waybill, r.courier, r.exception, r.status, r.gap, r.contacts].map(ccTd).join('') + `<td style="padding:6px 9px;border-bottom:1px solid var(--border-light);">${r.alerts.map(badge).join('')}</td></tr>`).join('')
            );
        }
        function ccReanalyzeSign() {
            const m = ccCurrentMonth;
            const seuil = ccNum(document.getElementById('ccGapThreshold')?.value) || 500;
            if (!m || !_ccMem[m]) { showToast('Réimportez le fichier EPOD du mois pour recalculer avec un nouveau seuil', 'error'); return; }
            data.ccGapSeuil = seuil;
            const analyse = ccAnalyseMonth(_ccMem[m].rows, seuil, _ccMem[m].analyse.dsp);
            _ccMem[m].analyse = analyse;
            data.controlEPOD[m] = ccCap(analyse);
            markUnsaved(); saveLocal();
            ccRenderAll();
            showToast(`Analyse recalculée (seuil GAP ${seuil} m)`, 'success');
        }
        function ccRenderCalls() {
            const g = ccGet();
            if (!g) { ccEmpty('ccCallsTable'); const k = document.getElementById('ccCallKpis'); if (k) k.innerHTML = ''; return; }
            const q = ccNorm(document.getElementById('ccCallSearch')?.value || '');
            const list = ccFiltreLivreur(g.a.calls || [], 'driver').filter(r => !q || ccNorm(r.driver).includes(q));
            const k = g.a.kpis;
            document.getElementById('ccCallKpis').innerHTML =
                ccKpi('Taux d\'appel global', k.tauxAppel + '%', 'var(--info)', 'fa-phone') +
                ccKpi('Livreurs pénalisés', k.penalises, 'var(--danger)', 'fa-user-xmark') +
                ccKpi('Total pénalités', k.penalitesTotal + ' €', 'var(--warning)', 'fa-coins') +
                ccKpi('Livreurs', (g.a.calls || []).length, 'var(--primary)', 'fa-users');
            const pill = (statut, pen) => `<span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:0.72rem;font-weight:700;background:${pen > 0 ? (pen >= 90 ? 'rgba(231,76,60,0.12)' : 'rgba(255,138,101,0.15)') : 'rgba(45,212,163,0.15)'};color:${pen > 0 ? (pen >= 90 ? 'var(--danger)' : '#FF8A65') : 'var(--success)'};">${escapeHtml(statut)}</span>`;
            document.getElementById('ccCallsTable').innerHTML = ccTableHtml(
                ['Livreur', 'Tâches', 'Avec appel', 'Taux', 'Statut', 'Pénalité (indicatif)'],
                list.map(r => '<tr>' + [r.driver, r.total, r.calls].map(ccTd).join('') + `<td style="padding:6px 9px;border-bottom:1px solid var(--border-light);font-weight:700;">${escapeHtml(r.rate)}%</td><td style="padding:6px 9px;border-bottom:1px solid var(--border-light);">${pill(r.statut, r.penalite)}</td><td style="padding:6px 9px;border-bottom:1px solid var(--border-light);font-weight:700;">${r.penalite > 0 ? escapeHtml(r.penalite) + ' €' : '—'}</td></tr>`).join('')
            );
        }
        function ccRenderNext() {
            const dspSel = document.getElementById('ccDspFilter');
            const kp = document.getElementById('ccNextKpis'), dr = document.getElementById('ccNextDrivers'), nt = document.getElementById('ccNextNote'), tb = document.getElementById('ccNextTable');
            if (!kp || !dr || !nt || !tb) return;
            const dates = ccDatesJour(ccCurrentMonth);
            if (!dates.length) {
                // Aucune journée stockée : rien à afficher (l'ancienne vue mensuelle est remplacée)
                if (dspSel) dspSel.innerHTML = '<option value="tous">Tous</option>';
                kp.innerHTML = ''; dr.innerHTML = '<p style="font-size:0.82rem;color:var(--text-secondary);">Importez le fichier de debrief du soir (échecs avec Action DSP) ou l\'export du mois.</p>'; nt.innerHTML = ''; tb.innerHTML = '';
                return;
            }
            const d = dates.includes(ccJourNext) ? ccJourNext : dates[0];
            ccJourNext = d;
            if (dspSel) {
                const opts = [['tous', 'Toutes les actions'], ['reintegrer', 'À réintégrer (à livrer un autre jour)'], ['retour', 'Retour Cainiao']];
                dspSel.innerHTML = opts.map(([v, l]) => `<option value="${v}" ${v === ccNextType ? 'selected' : ''}>${l}</option>`).join('');
                dspSel.setAttribute('onchange', 'ccChangerTypeNext()');
            }
            const tous = (data.ccJour[d] || {}).next || [];
            const rows = ccFiltreLivreur(tous).filter(r => ccNextType === 'tous' || r.type === ccNextType);
            const nR = tous.filter(r => r.type === 'reintegrer').length, nRet = tous.filter(r => r.type === 'retour').length;
            kp.innerHTML =
                ccKpi('À réintégrer', nR, 'var(--secondary)', 'fa-rotate-left') +
                ccKpi('Retour Cainiao', nRet, 'var(--danger)', 'fa-truck-ramp-box') +
                ccKpi('Livreurs', _ccGrouperLivreur(tous).length, 'var(--primary)', 'fa-users') +
                ccKpi('Sans téléphone', tous.filter(r => !r.phone || r.phone === '.').length, 'var(--warning)', 'fa-phone-slash');
            const groupes = _ccGrouperLivreur(rows);
            const badge = t => t === 'reintegrer' ? '<span style="background:rgba(232,89,12,0.14);color:var(--secondary);padding:1px 7px;border-radius:6px;font-size:0.7rem;font-weight:800;">À RÉINTÉGRER</span>' : t === 'retour' ? '<span style="background:rgba(231,76,60,0.14);color:var(--danger);padding:1px 7px;border-radius:6px;font-size:0.7rem;font-weight:800;">RETOUR</span>' : '<span style="background:var(--background-light);padding:1px 7px;border-radius:6px;font-size:0.7rem;font-weight:800;">AUTRE</span>';
            dr.style.display = 'block';
            dr.innerHTML = `
                <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-bottom:0.6rem;">
                    ${_ccSelecteurJour('ccJourNextSel', d, 'ccChangerJourNext()')}
                    <span style="font-size:0.8rem;color:var(--text-secondary);">${rows.length} colis${data.ccJour[d].importeNext ? ` · debrief importé le ${new Date(data.ccJour[d].importeNext).toLocaleString('fr-FR')}` : ''}</span>
                    ${groupes.length > 1 ? `<button class="btn btn-sm btn-secondary" onclick="ccCopierTout('next')"><i class="fab fa-whatsapp"></i> Tout copier</button>` : ''}
                </div>` + (groupes.map(([liv, list], i) => {
                    const c = (typeof getLivreurColor === 'function') ? getLivreurColor(i) : 'var(--primary)';
                    const lignes = list.map(r => `<div style="display:grid;grid-template-columns:52px 110px 1fr 1.2fr auto;gap:0.5rem;padding:3px 0;border-bottom:1px dashed var(--border-light);align-items:center;">
                        <span style="font-weight:800;color:${c};">#${escapeHtml(r.task ?? '?')}</span>${badge(r.type)}
                        <span><strong>${escapeHtml(r.name || '(sans nom)')}</strong>${r.phone && r.phone !== '.' ? ` <span style="color:var(--text-secondary);">${escapeHtml(r.phone)}</span>` : ''}</span>
                        <span style="color:var(--text-secondary);">${escapeHtml([r.address, r.zip, r.city].filter(Boolean).join(' '))}</span>
                        <span style="font-size:0.74rem;color:var(--danger);white-space:nowrap;" title="${escAttr(r.detail || '')}">${escapeHtml(r.motif || '')}</span></div>`).join('');
                    return ccCarteLivreur('next|' + d + '|' + liv, liv, `${list.length} colis · ${_ccDateFr(d)}`, list, lignes, ccTexteNext(liv, d, list), c);
                }).join('') || '<p style="font-size:0.82rem;color:var(--text-secondary);">Aucun colis pour ce filtre.</p>');
            _ccTextes['next|tout'] = groupes.map(([liv, list]) => ccTexteNext(liv, d, list)).join('\n\n');
            nt.innerHTML = ''; tb.innerHTML = '';
        }
        function ccReanalyzeNext() { ccChangerTypeNext(); }
        function ccRenderControl() {
            const g = ccGet();
            if (!g) { ccEmpty('ccControlTable'); return; }
            const q = ccNorm(document.getElementById('ccControlSearch')?.value || '');
            const p = document.getElementById('ccPriorityFilter')?.value || 'all';
            const base = ccFiltreLivreur(g.a.control || []);
            const list = base.filter(r => (p === 'all' || r.priority === p) && (!q || ccNorm(Object.values(r).join(' ')).includes(q)));
            ccNote('ccControlNote', base.length, g.a.totaux ? g.a.totaux.control : base.length, g.live);
            const prio = pr => pr === 'high' ? '<span style="color:var(--danger);font-weight:800;">🔴 Critique</span>' : pr === 'med' ? '<span style="color:#FF8A65;font-weight:800;">🟠 Moyen</span>' : '<span style="color:var(--info);font-weight:800;">🟡 Faible</span>';
            document.getElementById('ccControlTable').innerHTML = ccTableHtml(
                ['Priorité', 'Contact', 'Téléphone', 'Adresse', 'Anomalie', 'Ville', 'Waybill', 'Livreur', 'Action'],
                list.slice(0, 1500).map(r => `<tr><td style="padding:6px 9px;border-bottom:1px solid var(--border-light);white-space:nowrap;">${prio(r.priority)}</td>` + [r.name, r.phone, r.address, r.type, r.city, r.waybill, r.courier, r.action].map(ccTd).join('') + '</tr>').join('')
            );
        }
        function ccRenderAll() {
            ccPopulateMonths();
            ccPopulateLivreurs();
            ccUpdateStatus();
            ccSwitchView(ccCurrentView);
            ccRenderDashboard();
            ccRenderContacts();
            ccRenderSign();
            ccRenderCalls();
            ccRenderNext();
            ccRenderControl();
        }
        function ccCsvDownload(rows, headers, filename) {
            if (!rows.length) { showToast('Rien à exporter', 'error'); return; }
            const escCsv = v => { const s = String(v ?? ''); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
            const csv = '\uFEFF' + headers.map(h => h[0]).join(';') + '\n' + rows.map(r => headers.map(h => escCsv(r[h[1]])).join(';')).join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(a.href);
        }
        function ccExportCsv(kind) {
            if (kind === 'nextday' && ccJourNext && data.ccJour?.[ccJourNext]) {
                const rows = ccFiltreLivreur(data.ccJour[ccJourNext].next || []).filter(r => ccNextType === 'tous' || r.type === ccNextType);
                return ccCsvDownload(rows.map(r => [r.courier, r.task, r.dsp, r.name, r.phone, r.address, r.zip, r.city, r.motif, r.waybill]), ['Livreur', 'Ordre', 'Action DSP', 'Contact', 'Téléphone', 'Adresse', 'CP', 'Ville', 'Motif', 'Waybill'], `Debrief_${ccJourNext}.csv`);
            }
            if (kind === 'contacts' && ccJourContacts && data.ccJour?.[ccJourContacts]) {
                const rows = ccFiltreLivreur(data.ccJour[ccJourContacts].contacts || []);
                return ccCsvDownload(rows.map(r => [r.courier, r.task, r.name, r.email, r.phone, r.address, r.city, r.waybill]), ['Livreur', 'Ordre', 'Nom', 'Email', 'Téléphone', 'Adresse', 'Ville', 'Waybill'], `Noms_a_verifier_${ccJourContacts}.csv`);
            }
            const g = ccGet();
            if (!g) { showToast('Aucune analyse à exporter', 'error'); return; }
            const m = ccCurrentMonth + (ccLivreur ? '_' + ccLivreur.replace(/[^a-zA-Z0-9]+/g, '-') : '');
            if (kind === 'contacts') ccCsvDownload(ccFiltreLivreur(g.a.contacts || []), [['Waybill', 'waybill'], ['Contact', 'name'], ['Téléphone', 'phone'], ['Email', 'email'], ['Ordre', 'task'], ['Livreur', 'courier'], ['Ville', 'city'], ['Adresse', 'address']], `controle_contacts_${m}.csv`);
            else if (kind === 'badaddress') ccCsvDownload(ccFiltreLivreur(g.a.sign || []).filter(r => r.kBad), [['Waybill', 'waybill'], ['Adresse', 'address'], ['Ville', 'city'], ['Livreur', 'courier'], ['Contact', 'name'], ['Téléphone', 'phone'], ['Exception', 'exception']], `controle_adresses_incorrectes_${m}.csv`);
            else if (kind === 'calls') ccCsvDownload(ccFiltreLivreur(g.a.calls || [], 'driver'), [['Livreur', 'driver'], ['Tâches', 'total'], ['Avec appel', 'calls'], ['Taux %', 'rate'], ['Statut', 'statut'], ['Pénalité €', 'penalite']], `controle_taux_appel_${m}.csv`);
            else if (kind === 'nextday') ccCsvDownload(ccFiltreLivreur(g.a.next || []), [['Ordre', 'task'], ['Waybill', 'waybill'], ['Livreur', 'courier'], ['Ville', 'city'], ['CP', 'zip'], ['Adresse', 'address'], ['Contact', 'name'], ['Téléphone', 'phone'], ['GAP', 'gap']], `controle_nextday_${m}.csv`);
            else if (kind === 'control') ccCsvDownload(ccFiltreLivreur(g.a.control || []), [['Priorité', 'priority'], ['Waybill', 'waybill'], ['Anomalie', 'type'], ['Livreur', 'courier'], ['Ville', 'city'], ['Contact', 'name'], ['Téléphone', 'phone'], ['Adresse', 'address'], ['Action', 'action']], `controle_anomalies_${m}.csv`);
        }
        async function ccExportExcel() {
            const g = ccGet();
            if (!g) { showToast('Aucune analyse à exporter', 'error'); return; }
            await loadXLSXLib();
            const wb = XLSX.utils.book_new();
            const add = (name, rows) => { if (rows && rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31)); };
            add('Contacts nom seul', ccFiltreLivreur(g.a.contacts));
            add('Anomalies Sign Fail', ccFiltreLivreur(g.a.sign || []).map(r => ({ Waybill: r.waybill, Statut: r.status, Exception: r.exception, Adresse: r.address, Ville: r.city, Livreur: r.courier, Contact: r.name, 'Téléphone': r.phone, GAP: r.gap, Appels: r.contacts, Alertes: r.alerts.join(' | ') })));
            add('Taux appel', ccFiltreLivreur(g.a.calls, 'driver'));
            add('Next Day', ccFiltreLivreur(g.a.next));
            add('Anomalies', ccFiltreLivreur(g.a.control));
            XLSX.writeFile(wb, `Controle_EPOD_${ccCurrentMonth}${ccLivreur ? '_' + ccLivreur.replace(/[^a-zA-Z0-9]+/g, '-') : ''}.xlsx`);
        }
        async function ccExportPdf() {
            const g = ccGet();
            if (!g) { showToast('Aucune analyse à exporter', 'error'); return; }
            const ok = await ensureJsPDF();
            if (!ok) { showToast('Librairie PDF indisponible', 'error'); return; }
            const { jsPDF } = window.jspdf || { jsPDF: window.jsPDF };
            const doc = new jsPDF('landscape');
            const k = g.a.kpis;
            doc.setFontSize(16);
            doc.text(`Rapport Contrôle EPOD — ${formatMonthName(ccCurrentMonth)}${ccLivreur ? ' — ' + ccLivreur : ''}`, 14, 15);
            doc.setFontSize(9);
            doc.text(new Date().toLocaleString('fr-FR'), 14, 21);
            doc.autoTable({ startY: 26, head: [['Indicateur', 'Valeur']], body: [
                ['Lignes EPOD', k.total], ['Taux d\'appel global', k.tauxAppel + ' %'],
                ['Anomalies détectées', k.sign], ['Adresse incorrecte', k.bad], ['Colis non trouvé', k.colis],
                ['Échec sans appel', k.c0], ['GAP > ' + (g.a.gapSeuil || 500), k.gap],
                ['Next Day', k.next], ['Livreurs pénalisés', k.penalises], ['Pénalités (indicatif)', k.penalitesTotal + ' €']
            ], theme: 'grid', styles: { fontSize: 9 } });
            doc.autoTable({ startY: doc.lastAutoTable.finalY + 8, head: [['Priorité', 'Waybill', 'Anomalie', 'Livreur', 'Ville', 'Action']],
                body: ccFiltreLivreur(g.a.control || []).slice(0, 90).map(r => [r.priority === 'high' ? 'Critique' : r.priority === 'med' ? 'Moyen' : 'Faible', r.waybill, r.type, r.courier, r.city, r.action]),
                styles: { fontSize: 7 }, theme: 'striped' });
            doc.save(`Rapport_Controle_EPOD_${ccCurrentMonth}${ccLivreur ? '_' + ccLivreur.replace(/[^a-zA-Z0-9]+/g, '-') : ''}.pdf`);
        }
        async function ccExportNextPdf() {
            const d = ccJourNext;
            const tous = ((data.ccJour || {})[d] || {}).next || [];
            const rowsAll = ccFiltreLivreur(tous).filter(r => ccNextType === 'tous' || r.type === ccNextType);
            if (!rowsAll.length) { showToast('Aucun colis à exporter pour cette journée', 'error'); return; }
            const ok = await ensureJsPDF();
            if (!ok) { showToast('Librairie PDF indisponible', 'error'); return; }
            const { jsPDF } = window.jspdf || { jsPDF: window.jsPDF };
            const doc = new jsPDF('landscape');
            const lib = { reintegrer: 'À réintégrer', retour: 'Retour Cainiao', autre: 'Autre' };
            doc.setFontSize(15);
            doc.text(`Debrief du ${_ccDateFr(d)} — échecs avec action DSP`, 14, 15);
            const groupes = _ccGrouperLivreur(rowsAll);
            doc.autoTable({ startY: 22, head: [['Livreur', 'Colis', 'À réintégrer', 'Retour']], body: groupes.map(([liv, l]) => [liv, l.length, l.filter(r => r.type === 'reintegrer').length, l.filter(r => r.type === 'retour').length]), theme: 'grid', styles: { fontSize: 9 } });
            groupes.forEach(([liv, list]) => {
                doc.addPage('a4', 'landscape');
                doc.setFontSize(14);
                doc.text('Livreur : ' + liv, 14, 15);
                doc.autoTable({ startY: 22, head: [['Ordre', 'Action', 'Contact', 'Téléphone', 'Adresse', 'CP', 'Ville', 'Motif', 'Waybill']], body: list.map(r => [r.task ?? '', lib[r.type] || r.dsp, r.name, r.phone, r.address, r.zip, r.city, r.motif, r.waybill]), styles: { fontSize: 7 }, theme: 'grid' });
            });
            doc.save(`Debrief_${d}${ccLivreur ? '_' + ccLivreur.replace(/[^a-zA-Z0-9]+/g, '-') : ''}.pdf`);
        }



