        /* ════════════════════════════════════════════════════════════════
         * auth.js — AUTHENTIFICATION (Supabase Auth uniquement).
         *
         *   Supabase Auth  →  identité (currentCloudUser)
         *        ↓
         *   table profils  →  rôle admin (affichage) ; droits réels = RLS
         *
         * L'ancien identifiant local « Admin / admin » (PBKDF2 + verrouillage
         * dans localStorage) n'était actif que si Supabase n'était PAS
         * configuré — ce qui n'est jamais le cas. Il a été retiré pour qu'un
         * seul système détermine l'identité. localStorage/IndexedDB ne servent
         * plus qu'au cache, au mode hors ligne et aux préférences.
         * ════════════════════════════════════════════════════════════════ */

        // Marqueur de dernière session (NON utilisé comme preuve d'identité :
        // il sert seulement à savoir à qui appartiennent les données locales
        // et à rouvrir ces données HORS LIGNE sur cet appareil).
        const AUTH_KEY = 'planification_auth_session';
        let _appDemarree = false;
        let _modeHorsLigne = false;

        async function checkAuth() {
            if (!CLOUD_ENABLED) {
                showLogin();
                showClientError('Configuration cloud manquante (js/core/config.js).');
                return false;
            }
            if (!initSupabase()) { demarrerHorsLigneSiPossible('bibliotheque'); return false; }
            try {
                const session = await cloudGetSession();
                if (session && session.user) {
                    currentCloudUser = { id: session.user.id, email: session.user.email };
                    await enterCloudApp(false);
                    return true;
                }
                showLogin();
            } catch (e) {
                const t = classifyError(e);
                reportError(t, e, null, { silent: true });
                if (t === ErrorType.NETWORK || !navigator.onLine) demarrerHorsLigneSiPossible('reseau');
                else showLogin();
            }
            return false;
        }

        /**
         * Pas de réseau au démarrage : si cet appareil contient les données du
         * dernier compte connecté, on les ouvre en lecture/écriture LOCALE.
         * La synchronisation reprendra automatiquement au retour du réseau
         * (et exigera une session Supabase valide).
         */
        function demarrerHorsLigneSiPossible(raison) {
            let marq = null;
            try { marq = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { /* ignore */ }
            const meta = SyncMeta.read();
            const userId = (meta && meta.userId) || (marq && marq.userId);
            if (!marq || !marq.cloud || !userId || !AppStorage.readLocalRaw()) {
                showLogin();
                showClientError(raison === 'reseau'
                    ? 'Pas de connexion Internet. Connectez-vous une première fois en ligne sur cet appareil.'
                    : 'Le service de connexion est indisponible. Réessayez dans un instant.');
                return;
            }
            _modeHorsLigne = true;
            currentCloudUser = { id: userId, email: marq.email || '' };
            currentUserIsAdmin = false;  // jamais d'élévation de droits sans vérification serveur
            isAdminSession = false;
            loadFromLocalStorage();
            afficherApplication();
            demarrerApplication();
            applyRoleVisibility();
            SyncStatus.set('offline');
            showToast('Mode hors ligne : vos données locales sont disponibles. Synchronisation au retour du réseau.', 'warning');
            // Au retour du réseau : on revalide la session avant toute synchronisation.
            window.addEventListener('online', async () => {
                if (!_modeHorsLigne) return;
                try {
                    const s = await cloudGetSession();
                    if (s && s.user && s.user.id === userId) {
                        _modeHorsLigne = false;
                        currentCloudUser = { id: s.user.id, email: s.user.email };
                        const profil = await cloudGetProfil();
                        currentUserIsAdmin = !!(profil && profil.is_admin);
                        isAdminSession = currentUserIsAdmin;
                        applyRoleVisibility();
                        Sync.push();
                    } else {
                        SyncStatus.set('error', 'Session expirée — reconnectez-vous pour synchroniser');
                    }
                } catch (e) { reportError(null, e, null, { silent: true }); }
            });
        }

        function showLogin() {
            const clientBlock = document.getElementById('clientLoginBlock');
            if (clientBlock) clientBlock.style.display = 'block';
            const loginForm = document.getElementById('loginForm');
            if (loginForm) loginForm.style.display = 'block';
            const boot = document.getElementById('bootLoader');
            if (boot) boot.style.display = 'none';
            document.getElementById('loginOverlay').style.display = 'flex';
            document.getElementById('appContent').style.display = 'none';
            const settingsBtn = document.getElementById('settingsToggleBtn');
            if (settingsBtn) settingsBtn.style.display = 'none';
            setTimeout(() => { const e = document.getElementById('clientEmail'); if (e && !e.value) e.focus(); }, 50);
        }

        function afficherApplication() {
            const boot = document.getElementById('bootLoader');
            if (boot) boot.style.display = 'none';
            document.getElementById('loginOverlay').style.display = 'none';
            document.getElementById('appContent').style.display = 'block';
            const settingsBtn = document.getElementById('settingsToggleBtn');
            if (settingsBtn) settingsBtn.style.display = 'flex';
        }

        async function logout() {
            if (!confirm('Voulez-vous vraiment vous déconnecter ?')) return;
            // 1) Sauvegarde locale immédiate, 2) envoi au cloud des modifications en attente.
            try { if (hasUnsavedChanges) saveLocal(); } catch (e) { /* ignore */ }
            if (currentCloudUser && !_modeHorsLigne) {
                const meta = SyncMeta.read();
                if (meta && meta.dirty) {
                    showToast('Envoi des dernières modifications…', 'info');
                    const ok = await Promise.race([Sync.push({ immediate: true }), new Promise(r => setTimeout(() => r(false), 10000))]);
                    if (!ok && !confirm('Certaines modifications n\'ont pas pu être envoyées au cloud (elles restent sur cet appareil et seront envoyées à la prochaine connexion).\n\nSe déconnecter quand même ?')) return;
                }
            }
            await cloudSignOut();
            AppStorage._broadcast({ type: 'logout' });
            location.reload();
        }

        function showClientError(msg) {
            const err = document.getElementById('clientLoginError');
            const txt = document.getElementById('clientLoginErrorText');
            if (err && txt) { txt.textContent = msg; err.style.display = 'flex'; }
        }

        function clientErrorFr(error) {
            const m = (error && error.message || '').toLowerCase();
            if (m.includes('invalid login')) return 'Email ou mot de passe incorrect.';
            if (m.includes('already registered') || m.includes('already been registered')) return 'Cet email a déjà un compte. Connectez-vous.';
            if (m.includes('password should be')) return 'Le mot de passe doit faire au moins 6 caractères.';
            if (m.includes('email not confirmed')) return 'Email pas encore confirmé. Vérifiez votre boîte mail.';
            if (m.includes('unable to validate email')) return 'Adresse email invalide.';
            if (m.includes('rate limit') || m.includes('too many')) return 'Trop de tentatives. Patientez quelques minutes.';
            if (classifyError(error) === ErrorType.NETWORK) return 'Pas de connexion Internet.';
            return error && error.message ? error.message : 'Une erreur est survenue.';
        }

        function _btnChargement(btn, html) { if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.innerHTML = html; } }
        function _btnFin(btn, html) { if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.innerHTML = html; } }

        async function clientLogin() {
            const email = document.getElementById('clientEmail').value.trim();
            const password = document.getElementById('clientPassword').value;
            const btn = document.getElementById('clientLoginBtn');
            document.getElementById('clientLoginError').style.display = 'none';
            if (!email || !password) { showClientError('Veuillez remplir email et mot de passe.'); return; }
            _btnChargement(btn, '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Connexion...');
            try {
                const res = await cloudSignIn(email, password);
                currentCloudUser = { id: res.user.id, email: res.user.email };
                await enterCloudApp();
            } catch (err) {
                showClientError(clientErrorFr(err));
            } finally {
                _btnFin(btn, '<i class="fas fa-sign-in-alt" aria-hidden="true"></i> Se connecter');
            }
        }

        async function clientSignup() {
            const email = document.getElementById('clientEmail').value.trim();
            const password = document.getElementById('clientPassword').value;
            const btn = document.getElementById('clientSignupBtn');
            document.getElementById('clientLoginError').style.display = 'none';
            if (!email || !password) { showClientError('Veuillez remplir email et mot de passe.'); return; }
            if (password.length < 8) { showClientError('Le mot de passe doit faire au moins 8 caractères.'); return; }
            _btnChargement(btn, '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Création...');
            try {
                const res = await cloudSignUp(email, password);
                if (res.session && res.user) {
                    currentCloudUser = { id: res.user.id, email: res.user.email };
                    await enterCloudApp(true);
                } else {
                    window._pendingSignupEmail = email;
                    document.getElementById('clientVerifyBlock').style.display = 'block';
                    document.getElementById('clientLoginBtn').style.display = 'none';
                    document.getElementById('clientSignupBtn').style.display = 'none';
                    const codeInput = document.getElementById('clientCode');
                    if (codeInput) codeInput.focus();
                    showClientError('Compte créé ! Entrez le code reçu par email ci-dessous.');
                }
            } catch (err) {
                showClientError(clientErrorFr(err));
            } finally {
                _btnFin(btn, '<i class="fas fa-user-plus" aria-hidden="true"></i> Créer un compte');
            }
        }

        async function clientVerifyCode() {
            const code = (document.getElementById('clientCode').value || '').trim().replace(/\s/g, '');
            const email = window._pendingSignupEmail;
            const btn = document.getElementById('clientVerifyBtn');
            if (!email) { showClientError('Veuillez d\'abord créer un compte.'); return; }
            if (code.length < 4) { showClientError('Entrez le code de confirmation reçu par email.'); return; }
            _btnChargement(btn, '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Vérification...');
            try {
                if (!initSupabase()) throw new Error('Cloud non configuré');
                let result = await supabaseClient.auth.verifyOtp({ email, token: code, type: 'signup' });
                if (result.error) result = await supabaseClient.auth.verifyOtp({ email, token: code, type: 'email' });
                if (result.error) throw result.error;
                const u = result.data && result.data.user;
                const sess = result.data && result.data.session;
                document.getElementById('clientVerifyBlock').style.display = 'none';
                if (u && sess) {
                    currentCloudUser = { id: u.id, email: u.email };
                    await enterCloudApp(true);
                } else {
                    showClientError('Code validé ! Vous pouvez maintenant vous connecter.');
                    document.getElementById('clientLoginBtn').style.display = '';
                    document.getElementById('clientSignupBtn').style.display = '';
                }
            } catch (err) {
                showClientError(clientErrorFr(err) || 'Code incorrect ou expiré. Réessayez ou renvoyez un code.');
            } finally {
                _btnFin(btn, '<i class="fas fa-check" aria-hidden="true"></i> Valider mon compte');
            }
        }

        async function clientResendCode() {
            const email = window._pendingSignupEmail;
            if (!email) { showClientError('Veuillez d\'abord créer un compte.'); return; }
            try {
                if (!initSupabase()) throw new Error('Cloud non configuré');
                const { error } = await supabaseClient.auth.resend({ type: 'signup', email });
                if (error) throw error;
                showClientError('Un nouveau code vous a été envoyé par email.');
            } catch (err) {
                showClientError(clientErrorFr(err) || 'Impossible de renvoyer le code pour le moment.');
            }
        }

        /** Entrée dans l'application après une connexion Supabase valide. */
        async function enterCloudApp(isNewAccount) {
            const boot = document.getElementById('bootLoader');
            if (boot) { boot.style.display = 'flex'; }
            // Statut admin lu côté serveur (affichage uniquement).
            try {
                const profil = await cloudGetProfil();
                currentUserIsAdmin = !!(profil && profil.is_admin);
            } catch (e) { currentUserIsAdmin = false; }
            isAdminSession = currentUserIsAdmin;

            let res = { source: '?' };
            try { res = await Sync.chargerAuDemarrage(!!isNewAccount); }
            catch (e) {
                reportError(null, e, 'Chargement cloud impossible : ouverture des données locales de cet appareil.');
                loadFromLocalStorage();
            }
            console.info('[Démarrage] source des données :', res.source);
            selectionnerMoisHistoriqueParDefaut();
            maybePurge();

            afficherApplication();
            try {
                localStorage.setItem(AUTH_KEY, JSON.stringify({ timestamp: Date.now(), cloud: true, email: currentCloudUser.email, userId: currentCloudUser.id }));
            } catch (e) { /* ignore */ }
            demarrerApplication();
            await initCloudMode();
            applyRoleVisibility();
            showToast('Connexion réussie', 'success');
        }

        /** Affiche/masque les éléments admin (confort d'affichage, PAS une sécurité). */
        function applyRoleVisibility() {
            const badge = document.getElementById('cloudUserBadge');
            if (badge && currentCloudUser) {
                badge.style.display = 'flex';
                const roleLabel = currentUserIsAdmin ? ' (Admin)' : '';
                badge.querySelector('span').textContent = (currentCloudUser.email || 'Hors ligne') + roleLabel;
                badge.style.background = currentUserIsAdmin ? 'rgba(220,38,38,0.3)' : 'rgba(37,99,235,0.25)';
            }
            document.body.classList.toggle('is-admin', currentUserIsAdmin);
            document.body.classList.toggle('is-client', !currentUserIsAdmin);
            document.querySelectorAll('.admin-only').forEach(el => { el.style.display = currentUserIsAdmin ? '' : 'none'; });
        }

        /** Initialisation propre au mode cloud (abonnement, retour de paiement). */
        async function initCloudMode() {
            applyOngletsVisibility();
            updateUI();
            try {
                const ab = await cloudGetAbonnement();
                if (ab) afficherBandeauAbonnement(ab);
            } catch (e) { reportError(null, e, null, { silent: true }); }
            try {
                const params = new URLSearchParams(window.location.search);
                if (params.get('abo') === 'success') {
                    showToast('Paiement reçu ! Activation de votre abonnement en cours...', 'success');
                    demarrerVerificationPaiement();
                    window.history.replaceState({}, '', window.location.pathname);
                } else if (params.get('abo') === 'cancel') {
                    showToast('Paiement annulé. Vous pouvez réessayer quand vous voulez.', 'info');
                    window.history.replaceState({}, '', window.location.pathname);
                }
            } catch (e) { /* ignore */ }
            const importResults = document.getElementById('importResults');
            if (importResults) importResults.style.display = 'none';
        }

        /** Changement du mot de passe du compte connecté (Supabase Auth). */
        async function updateCredentials() {
            const newPwdInput = document.getElementById('settingsNewPassword');
            const confirmPwdInput = document.getElementById('settingsConfirmPassword');
            const newPwd = newPwdInput?.value || '';
            const confirmPwd = confirmPwdInput?.value || '';
            if (!currentCloudUser || _modeHorsLigne) { showToast('Connexion Internet requise pour changer le mot de passe.', 'warning'); return; }
            if (newPwd.length < 8) { showToast('Mot de passe trop court (8 caractères minimum)', 'warning'); return; }
            if (newPwd !== confirmPwd) { showToast('Les mots de passe ne correspondent pas', 'error'); return; }
            try {
                const { error } = await supabaseClient.auth.updateUser({ password: newPwd });
                if (error) throw error;
                if (newPwdInput) newPwdInput.value = '';
                if (confirmPwdInput) confirmPwdInput.value = '';
                showToast('Mot de passe mis à jour', 'success');
            } catch (e) {
                reportError(ErrorType.AUTH, e, 'Changement de mot de passe refusé : ' + clientErrorFr(e));
            }
        }
