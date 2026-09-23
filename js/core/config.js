/* ════════════════════════════════════════════════════════════════════
 * config.js — CONFIGURATION CENTRALE de l'application.
 *
 * C'est le SEUL endroit où modifier les paramètres techniques.
 *
 * La clé Supabase « anon » ci-dessous est PUBLIQUE par conception : elle
 * identifie le projet mais ne donne aucun droit à elle seule. La sécurité
 * repose sur Supabase Auth + Row Level Security (voir supabase-migration.sql).
 * NE JAMAIS placer ici une clé « service_role ».
 * ════════════════════════════════════════════════════════════════════ */
const CONFIG = Object.freeze({
    appVersion: 'v55',

    // --- Supabase (Project Settings → API) ---
    supabaseUrl: 'https://kbgkglstvvbpdeoermll.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtiZ2tnbHN0dnZicGRlb2VybWxsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2NjgyMzAsImV4cCI6MjA5NjI0NDIzMH0.yaEyCHrTBsuaHdYHZOOeTEwWQvrCKPU25OHgowN2HoY',
    tables: { userData: 'user_data', profils: 'profils', abonnements: 'abonnements' },

    // --- Stockage local (NE PAS RENOMMER : compatibilité avec les données existantes) ---
    storageKey: 'planification_livraisons_68_v4',
    idbName: 'planif68_db',
    idbStore: 'kv',
    syncMetaKey: 'planif_sync_meta_v1',     // état de synchronisation (révision cloud connue…)
    localRevKey: 'planif_local_rev_v1',     // compteur d'écritures locales (multi-onglets)
    broadcastChannel: 'planif-livraisons-sync',

    // --- Version du schéma de données (voir js/core/migrations.js) ---
    schemaVersion: 55,

    // --- Temporisations ---
    cloudSyncDebounceMs: 1500,     // délai après une modification avant envoi cloud
    cloudSafetyIntervalMs: 60000,  // filet de sécurité : tentative de synchro toutes les 60 s
    autoSaveIntervalMs: 10000,     // sauvegarde locale périodique si modifications
    remoteCheckIntervalMs: 120000, // vérification des modifications faites sur un autre appareil
    snapshotMax: 10,               // instantanés IndexedDB conservés

    // --- Bibliothèques : copie locale d'abord (vendor/), CDN en secours ---
    libs: {
        xlsx: ['vendor/xlsx-0.18.5.full.min.js',
               'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'],
        jspdf: ['vendor/jspdf-2.5.1.umd.min.js',
                'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'],
        jspdfAutotable: ['vendor/jspdf.plugin.autotable-3.5.31.min.js',
                         'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js'],
        html5Qrcode: ['vendor/html5-qrcode-2.3.8.min.js',
                      'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js']
    }
});

// Alias historiques utilisés dans tout le code (ne pas supprimer).
const SUPABASE_URL = CONFIG.supabaseUrl;
const SUPABASE_ANON_KEY = CONFIG.supabaseAnonKey;
const CLOUD_ENABLED = SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 20;
const STORAGE_KEY = CONFIG.storageKey;
const IDB_NAME = CONFIG.idbName;
const IDB_STORE = CONFIG.idbStore;
const APP_VERSION = CONFIG.appVersion;
