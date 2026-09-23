        // ============== DÉMARRAGE ==============
        document.addEventListener('DOMContentLoaded', function() {
            loadTheme();
            // Entrée dans le formulaire de connexion → connexion
            ['clientEmail', 'clientPassword'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clientLogin(); } });
            });
            const code = document.getElementById('clientCode');
            if (code) code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clientVerifyCode(); } });
            if (typeof Accessibilite !== 'undefined') Accessibilite.init();
            checkAuth().catch(e => { reportError(null, e, 'Démarrage impossible. Rechargez la page.'); showLogin(); });
        });

        // ============== TUTORIEL ONBOARDING (v42) ==============
        // Bumpé en v2 pour relancer le tutoriel auprès des utilisateurs existants
        // afin de leur présenter les nouveautés (alerte sous-charge, fiche tri PDF,
        // grille salariale enrichie).
        const TUTORIAL_KEY = 'planification_tutorial_completed_v2';
        let currentTutorialStep = 0;

        const TUTORIAL_STEPS = [
            {
                title: 'Le tableau de bord',
                icon: 'fa-tachometer-alt',
                content: 'Voici votre <strong>page d\'accueil</strong>. Elle affiche en un coup d\'œil vos statistiques : nombre de livreurs actifs, secteurs assignés et paramètres.',
                target: '#statsGrid',
                tab: 'accueil',
                position: 'bottom'
            },
            {
                title: 'Naviguer entre les sections',
                icon: 'fa-bars',
                content: 'Utilisez ces <strong>onglets</strong> pour naviguer dans l\'application.',
                target: '.nav',
                position: 'bottom'
            },
            {
                title: 'Ajouter vos livreurs',
                icon: 'fa-user-plus',
                content: 'Première étape : <strong>ajoutez vos livreurs</strong>. Choisissez leur type de contrat (salarié ou auto-entrepreneur) et leurs secteurs prioritaires.',
                target: '[data-testid="add-livreur-btn"]',
                tab: 'livreurs',
                position: 'bottom'
            },
            {
                title: 'Importer les prévisions',
                icon: 'fa-file-excel',
                content: 'Dans cet onglet, <strong>importez votre fichier Excel/CSV</strong> contenant les prévisions du jour (codes postaux + nb de colis).',
                target: '#uploadZone',
                tab: 'previsions',
                position: 'top'
            },
            {
                title: 'Optimisation automatique',
                icon: 'fa-magic',
                content: 'Cliquez ici pour <strong>répartir automatiquement</strong> les CP entre vos livreurs en équilibrant charge et géographie. Vous pouvez aussi faire du drag & drop manuel.',
                target: '[data-testid="optimisation-auto-btn"]',
                tab: 'distribution',
                position: 'bottom'
            },
            {
                title: '⚠ Alerte sous-charge',
                icon: 'fa-exclamation-triangle',
                content: '<strong>NOUVEAU :</strong> si un livreur reçoit moins de <strong>70 colis</strong> à l\'optimisation, une alerte vous propose de réassigner ses CP au livreur le plus proche. Vous pouvez régler ce seuil dans les paramètres.',
                target: '[data-testid="optimisation-auto-btn"]',
                tab: 'distribution',
                position: 'bottom'
            },
            {
                title: 'Générer la fiche tri PDF',
                icon: 'fa-file-pdf',
                content: '<strong>NOUVEAU :</strong> exportez la <strong>fiche tri</strong> en PDF — une seule page dense, optimisée pour être envoyée aux trieurs par WhatsApp ou email. Aucun blanc, tout est lisible d\'un coup d\'œil.',
                target: '[data-testid="export-rapport-btn"]',
                tab: 'rapport',
                position: 'left'
            },
            {
                title: 'Grille de salaire personnalisable',
                icon: 'fa-euro-sign',
                content: 'Dans <strong>Paramètres → Grille de salaire</strong>, vous définissez les paliers (ex : 80 colis = 80 €, 108 colis = 85 €…) et le <strong>supplément par colis au-delà du seuil</strong> (ex : 0,80 € par colis au-delà de 150).',
                target: '[data-testid="settings-btn"]',
                position: 'bottom'
            },
            {
                title: 'Importer les données EPOD',
                icon: 'fa-database',
                content: 'Après les livraisons, importez le rapport EPOD dans <strong>Historique &amp; Salaires</strong>. Les salaires sont calculés automatiquement selon votre grille et le type de contrat.',
                target: '[data-tab="historique"]',
                position: 'bottom'
            },
            {
                title: 'Sauvegarder vos données',
                icon: 'fa-save',
                content: 'N\'oubliez pas de <strong>sauvegarder régulièrement</strong> ! Cliquez ici ou utilisez Ctrl+S.',
                target: '[data-testid="save-btn"]',
                position: 'bottom'
            },
            {
                title: 'C\'est parti !',
                icon: 'fa-check-circle',
                content: 'Vous êtes prêt. Vous pouvez relancer ce tutoriel à tout moment depuis l\'onglet <strong>Aide</strong>, où vous trouverez aussi le manuel d\'utilisation complet. Bon travail !',
                target: '[data-testid="nav-aide"]',
                position: 'bottom',
                isLast: true
            }
        ];

        function shouldShowTutorial() {
            return !localStorage.getItem(TUTORIAL_KEY);
        }

        function startTutorial() {
            currentTutorialStep = -1;
            const overlay = document.getElementById('tutorialOverlay');
            const welcome = document.getElementById('tutorialWelcome');
            if (overlay) overlay.classList.add('show');
            if (welcome) welcome.classList.add('show');
            document.body.style.overflow = 'hidden';
        }

        function startTutorialSteps() {
            const welcome = document.getElementById('tutorialWelcome');
            if (welcome) welcome.classList.remove('show');
            currentTutorialStep = 0;
            showTutorialStep(0);
        }

        function showTutorialStep(idx) {
            if (idx < 0 || idx >= TUTORIAL_STEPS.length) {
                endTutorial(true);
                return;
            }
            const step = TUTORIAL_STEPS[idx];
            currentTutorialStep = idx;

            if (step.tab && typeof switchTab === 'function') {
                switchTab(step.tab);
            }

            setTimeout(() => {
                const target = document.querySelector(step.target);
                const tooltip = document.getElementById('tutorialTooltip');
                const spotlight = document.getElementById('tutorialSpotlight');
                if (!tooltip || !spotlight) return;

                document.getElementById('tutorialBadge').textContent = `ETAPE ${idx + 1}`;
                document.getElementById('tutorialTitle').innerHTML = `<i class="fas ${step.icon}"></i> ${step.title}`;
                document.getElementById('tutorialContent').innerHTML = step.content;
                document.getElementById('tutorialProgress').textContent = `${idx + 1} / ${TUTORIAL_STEPS.length}`;

                document.getElementById('tutorialPrev').style.visibility = idx === 0 ? 'hidden' : 'visible';
                document.getElementById('tutorialNext').innerHTML = step.isLast
                    ? 'Terminer <i class="fas fa-check"></i>'
                    : 'Suivant <i class="fas fa-arrow-right"></i>';

                if (target) {
                    const rect = target.getBoundingClientRect();
                    const padding = 8;
                    spotlight.style.top    = (rect.top - padding) + 'px';
                    spotlight.style.left   = (rect.left - padding) + 'px';
                    spotlight.style.width  = (rect.width + padding * 2) + 'px';
                    spotlight.style.height = (rect.height + padding * 2) + 'px';
                    spotlight.classList.add('show');

                    if (rect.top < 0 || rect.bottom > window.innerHeight) {
                        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        setTimeout(() => positionTooltip(target, step.position), 400);
                        return;
                    }
                    positionTooltip(target, step.position);
                } else {
                    spotlight.classList.remove('show');
                    tooltip.style.top = '50%';
                    tooltip.style.left = '50%';
                    tooltip.style.transform = 'translate(-50%, -50%)';
                }

                tooltip.classList.add('show');
            }, step.tab ? 300 : 50);
        }

        function positionTooltip(target, position) {
            const tooltip = document.getElementById('tutorialTooltip');
            if (!tooltip || !target) return;
            const rect = target.getBoundingClientRect();
            const tw = 380, th = 220;
            let top, left;

            switch (position) {
                case 'top':
                    top = rect.top - th - 20;
                    left = rect.left + rect.width / 2 - tw / 2;
                    break;
                case 'left':
                    top = rect.top + rect.height / 2 - th / 2;
                    left = rect.left - tw - 20;
                    break;
                case 'right':
                    top = rect.top + rect.height / 2 - th / 2;
                    left = rect.right + 20;
                    break;
                default:
                    top = rect.bottom + 20;
                    left = rect.left + rect.width / 2 - tw / 2;
            }

            top = Math.max(20, Math.min(top, window.innerHeight - th - 20));
            left = Math.max(20, Math.min(left, window.innerWidth - tw - 20));

            tooltip.style.top = top + 'px';
            tooltip.style.left = left + 'px';
            tooltip.style.transform = 'none';
        }

        function nextTutorialStep() {
            if (currentTutorialStep === -1) {
                startTutorialSteps();
                return;
            }
            const step = TUTORIAL_STEPS[currentTutorialStep];
            if (step && step.isLast) {
                endTutorial(true);
                return;
            }
            showTutorialStep(currentTutorialStep + 1);
        }

        function prevTutorialStep() {
            if (currentTutorialStep > 0) {
                showTutorialStep(currentTutorialStep - 1);
            }
        }

        function endTutorial(completed) {
            const overlay = document.getElementById('tutorialOverlay');
            const welcome = document.getElementById('tutorialWelcome');
            const tooltip = document.getElementById('tutorialTooltip');
            const spotlight = document.getElementById('tutorialSpotlight');
            if (overlay) overlay.classList.remove('show');
            if (welcome) welcome.classList.remove('show');
            if (tooltip) tooltip.classList.remove('show');
            if (spotlight) spotlight.classList.remove('show');
            document.body.style.overflow = '';
            localStorage.setItem(TUTORIAL_KEY, JSON.stringify({
                completed: completed, skipped: !completed, date: Date.now()
            }));
            if (completed && typeof showToast === 'function') {
                showToast('Tutoriel terminé !', 'success');
            }
        }

        function resetTutorial() {
            localStorage.removeItem(TUTORIAL_KEY);
            startTutorial();
        }

        function maybeAutoStartTutorial() {
            // appContent visible si user connecte
            const appEl = document.getElementById('appContent');
            if (!appEl || appEl.style.display === 'none') return;
            if (shouldShowTutorial()) {
                setTimeout(() => startTutorial(), 800);
            }
        }

        // Echap + fleches
        document.addEventListener('keydown', (e) => {
            const overlay = document.getElementById('tutorialOverlay');
            const tooltip = document.getElementById('tutorialTooltip');
            if (!overlay || !overlay.classList.contains('show')) return;
            if (e.key === 'Escape') endTutorial(false);
            if (tooltip && tooltip.classList.contains('show')) {
                if (e.key === 'ArrowRight') { e.preventDefault(); nextTutorialStep(); }
                if (e.key === 'ArrowLeft')  { e.preventDefault(); prevTutorialStep(); }
            }
        });

        window.addEventListener('resize', () => {
            const tooltip = document.getElementById('tutorialTooltip');
            if (currentTutorialStep >= 0 && tooltip && tooltip.classList.contains('show')) {
                showTutorialStep(currentTutorialStep);
            }
        });

        // Hook : declencher le tutoriel apres le 1er login reussi
        // On utilise un MutationObserver sur appContent pour detecter qu'il devient visible
        document.addEventListener('DOMContentLoaded', () => {
            const appEl = document.getElementById('appContent');
            if (!appEl) return;
            const observer = new MutationObserver(() => {
                if (appEl.style.display !== 'none' && appEl.style.display !== '') {
                    maybeAutoStartTutorial();
                }
            });
            observer.observe(appEl, { attributes: true, attributeFilter: ['style'] });
        });


