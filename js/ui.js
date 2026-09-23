        // ============== TOAST ==============
        function showToast(message, type = 'info') {
            const container = document.getElementById('toastContainer');
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            const icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-times-circle' : type === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle';
            toast.innerHTML = `<i class="fas ${icon}"></i><span>${escapeHtml(message)}</span>`;
            container.appendChild(toast);
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(100%)';
                setTimeout(() => toast.remove(), 300);
            }, 2500);
        }



        // ============== PLANIFICATION J+1 ==============
        function getDateLabel(dateStr) {
            const date = new Date(dateStr + 'T00:00:00');
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);

            const isSame = (a, b) => a.toISOString().split('T')[0] === b.toISOString().split('T')[0];

            if (isSame(date, tomorrow)) return 'demain';
            if (isSame(date, today)) return "aujourd'hui";
            if (isSame(date, yesterday)) return 'hier';
            return null;
        }

        function formatDateLong(dateStr) {
            const date = new Date(dateStr + 'T00:00:00');
            const days = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
            const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
            return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
        }

        function updatePlanningAlert() {
            // Note : on ne reset PAS window._mapHasBeenFitted ici (sinon ça re-zoome
            // à chaque updateUI, donc à chaque attribution de secteur).
            const alert = document.getElementById('planningAlert');
            if (!alert) return;
            const label = getDateLabel(selectedDate);
            const dateText = formatDateLong(selectedDate);
            let labelHtml = '';
            let icon = 'fa-calendar-day';
            if (label === 'demain') { labelHtml = ' <span style="opacity:0.8;">(demain)</span>'; icon = 'fa-calendar-plus'; }
            else if (label === "aujourd'hui") { labelHtml = ' <span style="opacity:0.8;">(aujourd\'hui)</span>'; icon = 'fa-calendar-check'; }
            else if (label === 'hier') { labelHtml = ' <span style="opacity:0.8;">(hier)</span>'; icon = 'fa-calendar-minus'; }

            alert.innerHTML = `
                <i class="fas ${icon}"></i>
                <span>Planification pour : <strong>${dateText}</strong>${labelHtml}</span>
                <button onclick="changeDateInteractive()"><i class="fas fa-edit"></i> Changer</button>
            `;
        }

        function changeDateInteractive() {
            // Reset du fit map : la date va vraiment changer
            window._mapHasBeenFitted = false;

            const current = selectedDate;
            const input = prompt('Date de planification (format AAAA-MM-JJ) :', current);
            if (!input) return;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
                showToast('Format invalide. Utilisez AAAA-MM-JJ', 'error');
                return;
            }
            const d = new Date(input + 'T00:00:00');
            if (isNaN(d.getTime())) {
                showToast('Date invalide', 'error');
                return;
            }
            selectedDate = input;
            updateUI();
            updatePlanningAlert();
            showToast(`Date changée : ${formatDateLong(selectedDate)}`, 'success');
        }

        // Confirmation avant sauvegarde si la date n'est pas demain
        function confirmDateBeforeSave() {
            const label = getDateLabel(selectedDate);
            if (label === 'demain') return true; // OK
            const dateText = formatDateLong(selectedDate);
            const msg = label
                ? `Vous êtes sur le point de sauvegarder une planification pour ${dateText} (${label}).\n\nNormalement les prévisions sont planifiées pour DEMAIN. Continuer ?`
                : `Vous êtes sur le point de sauvegarder une planification pour ${dateText}.\n\nCette date n'est ni aujourd'hui ni demain. Continuer ?`;
            return confirm(msg);
        }

        // ============== THEME MANAGEMENT ==============
        function toggleTheme() {
            const html = document.documentElement;
            const currentTheme = html.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', newTheme);
            localStorage.setItem('planification_theme', newTheme);
        }

        function loadTheme() {
            const savedTheme = localStorage.getItem('planification_theme') || 'light';
            document.documentElement.setAttribute('data-theme', savedTheme);
        }

