# Planification Livraisons — architecture, audit et vérifications (v55)

Application HTML/CSS/JavaScript vanilla servie par GitHub Pages, sans build.
Supabase fournit l'authentification et la synchronisation. localStorage et IndexedDB servent de cache local et permettent le travail hors ligne.

## 1. Structure

```
index.html                 structure HTML (plus aucune donnée intégrée)
css/app.css                styles d'origine (inchangés)
css/terrain.css            styles Optimisation Terrain + Mode Scan (inchangés)
css/ameliorations.css      ajouts v55 : état de synchro, chargement, focus, mobile
js/core/config.js          CONFIGURATION CENTRALE (Supabase, clés, délais, schemaVersion, bibliothèques)
js/core/utils.js           escapeHtml / escJsAttr / el() / loadScriptOnce…
js/core/errors.js          gestion centralisée des erreurs (reportError, ErrorType)
js/core/merge.js           fusion à 3 voies (conflits appareils / onglets)
js/core/storage.js         AppStorage : localStorage, IndexedDB, instantanés, multi-onglets
js/core/sync.js            Supabase : auth, synchro avec révision, état de synchro
js/core/migrations.js      schemaVersion + migrations séquentielles
js/core/a11y.js            modales accessibles, focus, clavier
js/state.js … js/carte.js  modules métier (découpés sans modification fonctionnelle)
js/auth.js                 connexion Supabase, mode hors ligne, déconnexion
js/app-core.js             démarrage, sauvegarde, export/import JSON, diagnostic
js/terrain.js, js/scan.js  modules Terrain et Scan (IIFE d'origine)
js/data/cp-fr.js           base des codes postaux (420 Ko, fichier séparé mis en cache)
js/workers/xlsx-worker.js  lecture Excel hors du thread principal
vendor/                    bibliothèques en copie locale, versions figées
```

Les scripts sont des scripts **classiques** (pas de modules ES). Ils partagent la portée globale, comme dans l'ancien fichier unique.
**L'ordre des balises `<script>` dans index.html compte** : `core/` d'abord, puis les modules métier dans l'ordre d'origine.
Les gestionnaires `onclick="…"` du HTML appellent directement ces fonctions globales.

## 2. Données locales (compatibilité conservée)

| Clé / base | Contenu |
|---|---|
| `planification_livraisons_68_v4` | document principal (format inchangé, + `schemaVersion`) |
| `terrain_tours_v1`, `terrain_points_v1`, `terrain_depot_v1`, `terrain_delivered_v1`, `terrain_points_savedAt` | module Terrain |
| `planif_fe_*`, `planif_last_facture_num`, `planif_fe_tvaTaux` | préférences de facture |
| `planification_theme`, `planification_tutorial_completed_v2` | préférences |
| `planif_last_snapshot`, `__last_purge__` | minuteries |
| `planification_auth_session` | dernier compte connecté : sert à identifier le propriétaire des données locales, **ce n'est pas une preuve d'identité** |
| `planif_sync_meta_v1` (nouveau) | révision cloud connue, modifications en attente, dernière synchro |
| `planif_local_rev_v1` (nouveau) | compteur d'écritures pour la coordination entre onglets |
| IndexedDB `planif68_db` / `kv` | miroir du document, `__terrain_keys__`, instantanés `backup:*` (10), instantanés quotidiens `__snapshot_*` (7 jours), base commune de synchro `__cloud_base__` |

Les anciennes clés de l'identifiant local (`planification_credentials_v8`, `planification_lockout`, `planification_attempts`) ne sont plus lues. Elles sont laissées telles quelles.

## 3. Synchronisation et conflits

Supabase garde **une ligne par utilisateur** dans `user_data` : le document compressé `{__v:2, c}`, `updated_at` et `revision` (nouvelle colonne).

1. Au chargement, l'application mémorise la révision reçue et une copie de la version (la « base », dans IndexedDB).
2. Chaque écriture est **conditionnelle** : `UPDATE … WHERE user_id = moi AND revision = <connue>`. Un trigger serveur incrémente la révision.
3. Si 0 ligne est modifiée, un autre appareil a écrit entre-temps. L'application relit alors la version cloud, l'enregistre dans un **instantané IndexedDB** (« version cloud avant fusion »), puis **fusionne** base, version locale et version distante (`merge.js`). Elle réécrit ensuite le résultat. Si le même élément a été modifié différemment des deux côtés, la version de l'appareil est gardée, l'état « ⚠ Conflit détecté » s'affiche avec la liste des éléments, et l'autre version reste restaurable.
4. Si le SQL n'a pas encore été exécuté (pas de colonne `revision`), la même logique s'applique sur `updated_at`. Le diagnostic affiche alors « mode dégradé ».
5. Le serveur conserve aussi les **10 versions précédentes** (`user_data_versions`).
6. **Onglets** : une écriture locale prévient les autres onglets (BroadcastChannel, ou l'événement `storage` en secours). Un onglet sans modification en cours se recharge. Un onglet avec des modifications fusionne à sa prochaine sauvegarde. Les envois vers le cloud sont sérialisés (Web Locks).
7. **Autre appareil** : vérification toutes les 2 min, au retour sur l'onglet et au retour du réseau.
8. **Hors ligne** : sauvegarde locale uniquement, état « ⚠ Hors ligne ». L'envoi se fait automatiquement au retour du réseau. Si Supabase est injoignable au démarrage, les données locales du dernier compte connecté s'ouvrent, avec les droits non-admin.
9. **Sauvegardes** : écriture synchrone dans localStorage à chaque `saveLocal()`, sauvegarde toutes les 10 s si des modifications sont en attente, et au passage en arrière-plan (`visibilitychange`/`pagehide`). `beforeunload` ne sert que de complément.

## 4. Sécurité

| Sujet | Avant | Après |
|---|---|---|
| Données dans index.html | page enregistrée avec salaires nominatifs, ~1 500 n° de colis, e-mail admin, **publique** | HTML vide de données. Bouton « Télécharger l'application » (cause de la fuite) neutralisé |
| RLS | inconnue, non vérifiable depuis le code | `supabase-migration.sql` : chaque utilisateur ne lit/écrit que SA ligne, aucune suppression, `anon` sans accès. Testé sur PostgreSQL 16 |
| Admin | `is_admin` lu côté serveur, mais aucune protection serveur contre la modification | policy en lecture seule + trigger qui refuse toute modification de `is_admin` hors SQL Editor / service_role. `.admin-only` ne sert qu'à l'affichage |
| Abonnement | `abonnements` éventuellement modifiable selon les policies existantes | lecture seule pour l'utilisateur. Le blocage « abonnement expiré » reste côté navigateur (option SQL fournie, désactivée) |
| Double authentification | identifiant local `Admin/admin` (PBKDF2) en plus de Supabase | Supabase Auth uniquement. Le changement de mot de passe passe par Supabase |
| Mélange de comptes | la connexion d'un compte B fusionnait des mois de données locales du compte A dans le cloud de B | les données locales ne sont reprises que si elles appartiennent au compte connecté |
| XSS | `showToast` insérait du HTML brut (~190 appels). Noms, adresses, n° de colis et `err.message` injectés sans échappement à de nombreux endroits. `escAttr` contournable (`&#39;`) | échappement central (`escapeHtml`, `escJsAttr`) sur toutes les données externes. Voir le §5 pour le détail |
| Restauration d'instantané | écrasée par le cloud au rechargement | restauration en mémoire, puis envoi comme nouvelle révision |
| Import JSON | instantané pris **après** l'écrasement des livreurs | instantané pris avant toute modification |
| CDN | 8 bibliothèques chargées depuis 3 CDN | copies locales dans `vendor/`, le CDN ne sert qu'en secours pour les chargements à la demande |

### Risques résiduels (non corrigés, à connaître)

- **CSP avec `'unsafe-inline'`** : ~800 gestionnaires `onclick="…"` dans le HTML et beaucoup d'autres dans les gabarits JS l'imposent. La CSP limite quand même les origines des scripts, les connexions réseau (Supabase + API Adresse), interdit les plugins et `<base>`. Pour la retirer, il faudrait remplacer progressivement les `onclick` par des écouteurs délégués (`data-action`). `frame-ancestors` ne peut pas être défini par une balise meta (limite de GitHub Pages).
- **SheetJS 0.18.5** (dernière version publiée sur npm) a deux vulnérabilités connues sur les fichiers piégés : pollution de prototype et ReDoS. Elles sont corrigées en 0.20.x, qui n'est distribué que sur `cdn.sheetjs.com`. Pour mettre à jour : télécharger `xlsx.full.min.js` 0.20.3 dans `vendor/`, puis changer le chemin dans `CONFIG.libs.xlsx` et `js/workers/xlsx-worker.js`. Le risque est limité aux fichiers Excel que vous importez vous-même.
- **Abonnement** : un utilisateur technique peut contourner l'écran de blocage et continuer d'accéder à **ses propres** données. Le bloc SQL optionnel rend ce blocage réel côté serveur.
- **Appareil partagé** : les données restent dans le navigateur après déconnexion, comme avant.
- Pas de « mot de passe oublié » dans l'application : il existait déjà via le tableau de bord Supabase.

## 5. XSS — règles

- Texte ou attribut HTML : `${escapeHtml(valeur)}`.
- Chaîne JS dans un attribut d'événement : `onclick="f('${escJsAttr(valeur)}')"`.
- `showToast(message)` échappe lui-même son message : passer du texte, jamais du HTML.
- Popups et infobulles Leaflet (`bindPopup`, `bindTooltip`, `divIcon`) : ce sont aussi des insertions HTML, même règle.
- Chaque insertion HTML a été relue dans les 22 fichiers JS : plus de 200 valeurs externes sont désormais échappées.

## 6. Migrations

`CONFIG.schemaVersion = 55`. Les documents sans `schemaVersion` sont en version 0.
Pour ajouter une migration :

1. ajouter `{ version: 56, description, run(d) {…} }` à la fin de `MIGRATIONS` dans `js/core/migrations.js` ;
2. passer `CONFIG.schemaVersion` à 56.

Une migration qui supprime des champs (`destructive: true`) crée d'abord un instantané.

## 7. Vérifications effectuées

Tests automatisés (Playwright + faux Supabase respectant la sémantique `revision`), tous passés :

- connexion, chargement cloud vide → création révision 1 ;
- **données v54** (localStorage) : migration, `schemaVersion` 55, instantané « avant migration v46 », livreurs, historique et clés Terrain conservés ;
- **document cloud v54 compressé** sans colonne `revision` : lecture et mode dégradé `updated_at`, fusion correcte ;
- **deux appareils**, champs différents → fusion sans conflit ; même champ → conflit signalé, version distante conservée dans un instantané ;
- **deux onglets** avec modifications simultanées → fusion, aucune perte ;
- **hors ligne** → état « Hors ligne », envoi au retour du réseau ; démarrage avec Supabase injoignable → données locales ;
- **changement de compte** sur le même navigateur → aucune donnée de l'autre compte ;
- **XSS** : nom de livreur `<img onerror>`, identifiant avec guillemets, secteur `<b>` → aucune exécution ;
- import Excel EPOD (Worker), import prévisions, jsPDF + autoTable, QR code, cartes Leaflet, Terrain, Scan, export et import JSON, restauration d'instantané, avec les CDN bloqués (bibliothèques locales) ;
- accessibilité : modales `role=dialog`, focus placé puis restauré, Échap, onglets au clavier ;
- mobile 360 px et tablette 768 px : aucun débordement horizontal sur les 13 onglets.
- SQL : exécuté deux fois sur PostgreSQL 16 avec des rôles de type Supabase. Vérifié : lecture limitée à sa ligne, écriture sur la ligne d'autrui refusée, révision périmée → 0 ligne, `user_id` non modifiable, suppression refusée, `is_admin` et `abonnements` non modifiables par l'utilisateur, `anon` refusé.

### À vérifier manuellement après déploiement (données réelles)

- [ ] Connexion admin et connexion d'un client ; le client ne voit ni « Partage » ni son statut admin.
- [ ] Livreurs, historique des salaires, factures PDF, Contrôle EPOD, Inventaire : identiques à avant.
- [ ] Import d'un vrai fichier EPOD mensuel et d'un fichier de prévisions.
- [ ] Deux appareils ouverts : modifier sur l'un → l'autre se met à jour (≤ 2 min ou en revenant sur l'onglet).
- [ ] Mode avion : modifier → « Hors ligne » → réseau rétabli → « Synchronisé ».
- [ ] Diagnostic de sauvegarde : « Détection de conflit : Active ».
