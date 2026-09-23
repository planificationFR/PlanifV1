        function afficherBandeauAbonnement(ab) {
            const banner = document.getElementById('aboBanner');
            if (!banner) return;

            // L'admin n'est jamais concerné par les abonnements
            if (currentUserIsAdmin) { banner.style.display = 'none'; masquerBlocageAbonnement(); return; }

            const now = new Date();

            if (ab.statut === 'actif') {
                // Abonné : aucun bandeau, accès complet
                banner.style.display = 'none';
                masquerBlocageAbonnement();
                return;
            }

            if (ab.statut === 'essai') {
                const fin = ab.fin_essai ? new Date(ab.fin_essai) : null;
                const jours = fin ? Math.ceil((fin - now) / (1000*60*60*24)) : 0;
                if (fin && jours > 0) {
                    // Essai en cours : bandeau d'information, accès complet
                    masquerBlocageAbonnement();
                    banner.style.display = 'flex';
                    banner.style.background = '#eff6ff'; banner.style.color = '#1e40af';
                    banner.innerHTML = `<i class="fas fa-gift"></i> Essai gratuit — ${jours} jour${jours>1?'s':''} restant${jours>1?'s':''}. <button onclick="ouvrirAbonnement()" style="margin-left:auto;padding:0.3rem 0.8rem;border:none;background:#2563eb;color:white;border-radius:6px;cursor:pointer;font-weight:600">S'abonner</button>`;
                } else {
                    // Essai terminé : BLOCAGE COMPLET
                    afficherBlocageAbonnement('Votre essai gratuit est terminé.');
                }
                return;
            }

            // statut 'expire', 'annule', ou autre → BLOCAGE COMPLET
            if (ab.statut === 'expire' || ab.statut === 'annule') {
                afficherBlocageAbonnement(
                    ab.statut === 'annule' ? 'Votre abonnement a été annulé.' : 'Votre abonnement a expiré (paiement échoué).'
                );
                return;
            }

            banner.style.display = 'none';
        }

        // Affiche un écran de blocage plein écran (accès interdit tant que non payé)
        function afficherBlocageAbonnement(message) {
            if (currentUserIsAdmin) return;   // jamais l'admin
            let overlay = document.getElementById('subscriptionBlockOverlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'subscriptionBlockOverlay';
                overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,0.97);display:flex;align-items:center;justify-content:center;padding:1.5rem;';
                document.body.appendChild(overlay);
            }
            overlay.innerHTML = `
                <div style="max-width:460px;width:100%;background:white;border-radius:16px;padding:2rem;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.4)">
                    <div style="font-size:3rem;margin-bottom:0.5rem">🔒</div>
                    <h2 style="margin:0 0 0.5rem;color:#1e293b;font-size:1.5rem">${escapeHtml(message)}</h2>
                    <p style="color:#64748b;font-size:0.95rem;line-height:1.5;margin-bottom:1.5rem">
                        Pour continuer à utiliser l'application et accéder à vos données, abonnez-vous pour 50&nbsp;€/mois.
                    </p>
                    <button id="blockSubscribeBtn" onclick="ouvrirAbonnement()" style="width:100%;padding:0.9rem;border:none;border-radius:10px;background:#2563eb;color:white;font-weight:700;font-size:1.05rem;cursor:pointer">
                        <i class="fas fa-credit-card"></i> S'abonner maintenant
                    </button>
                    <button onclick="logout()" style="width:100%;margin-top:0.6rem;padding:0.7rem;border:1px solid #e2e8f0;border-radius:10px;background:white;color:#64748b;font-weight:600;cursor:pointer">
                        Se déconnecter
                    </button>
                    <p style="color:#94a3b8;font-size:0.8rem;margin-top:1rem;margin-bottom:0">
                        Vos données sont conservées en sécurité et seront accessibles dès votre abonnement.
                    </p>
                </div>`;
            overlay.style.display = 'flex';
        }

        function masquerBlocageAbonnement() {
            const overlay = document.getElementById('subscriptionBlockOverlay');
            if (overlay) overlay.style.display = 'none';
        }

        // Lance le paiement : appelle l'Edge Function create-checkout et ouvre Stripe
        async function ouvrirAbonnement() {
            if (!supabaseClient || !currentCloudUser) {
                showToast('Vous devez être connecté pour vous abonner.', 'error');
                return;
            }
            // Retour visuel sur le bouton de blocage si présent
            const blockBtn = document.getElementById('blockSubscribeBtn');
            if (blockBtn) { blockBtn.disabled = true; blockBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Ouverture du paiement...'; }
            showToast('Préparation du paiement sécurisé...', 'info');
            try {
                const { data: res, error } = await supabaseClient.functions.invoke('create-checkout', {
                    body: { origin: window.location.origin }
                });
                if (error) throw error;
                if (res && typeof res.url === 'string' && /^https:\/\//i.test(res.url)) {
                    // Ouvrir la page de paiement Stripe dans un nouvel onglet
                    window.open(res.url, '_blank', 'noopener');
                    showToast('La page de paiement s\'est ouverte dans un nouvel onglet.', 'success');
                    // Après retour, vérifier périodiquement si le paiement a été pris en compte
                    demarrerVerificationPaiement();
                } else {
                    throw new Error(res?.error || 'Réponse inattendue du serveur');
                }
            } catch (e) {
                console.error('[abo] checkout', e);
                showToast('Impossible d\'ouvrir le paiement : ' + (e.message || e), 'error');
            } finally {
                if (blockBtn) { blockBtn.disabled = false; blockBtn.innerHTML = '<i class="fas fa-credit-card"></i> S\'abonner maintenant'; }
            }
        }

        // Vérifie périodiquement le statut d'abonnement (après un paiement, le webhook
        // met quelques secondes à activer le compte). On vérifie toutes les 4s, 10 fois.
        let _verifPaiementTimer = null;
        function demarrerVerificationPaiement() {
            let tentatives = 0;
            if (_verifPaiementTimer) clearInterval(_verifPaiementTimer);
            _verifPaiementTimer = setInterval(async () => {
                tentatives++;
                try {
                    const ab = await cloudGetAbonnement();
                    if (ab && ab.statut === 'actif') {
                        clearInterval(_verifPaiementTimer);
                        masquerBlocageAbonnement();
                        afficherBandeauAbonnement(ab);
                        showToast('Abonnement activé, merci ! Accès complet débloqué.', 'success');
                    }
                } catch(e){}
                if (tentatives >= 10) clearInterval(_verifPaiementTimer);
            }, 4000);
        }

        // Pousse les données locales actuelles vers le cloud (migration manuelle)
        async function migrerVersCloud() {
            if (!currentCloudUser) {
                showToast('Vous devez être connecté à un compte client pour migrer.', 'error');
                return;
            }
            if (!confirm('Transférer toutes vos données actuelles vers votre compte cloud ?\n\nCela remplacera les données cloud existantes de ce compte par celles de cet appareil.')) return;
            try {
                const ok = await cloudSaveData(data);
                if (ok) {
                    showToast('Données transférées vers le cloud avec succès', 'success');
                    showStorageDiagnostic();
                } else {
                    showToast('Échec du transfert. Vérifiez votre connexion.', 'error');
                }
            } catch (e) {
                showToast('Erreur : ' + e.message, 'error');
            }
        }


