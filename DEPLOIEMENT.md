# Déploiement — Planification Livraisons v55

## 1. Supabase (une seule fois, AVANT l'envoi des fichiers)

1. Supabase → **SQL Editor** → **New query**.
2. Collez tout le contenu de `supabase-migration.sql` → **Run**.
3. Vérifiez qu'il n'y a **aucune erreur**. Le tableau affiché à la fin doit lister **6 policies**.
   En cas d'erreur, rien n'a été modifié (transaction) : envoyez le message d'erreur avant de continuer.

## 2. GitHub

1. Dans le dépôt, remplacez l'ancien `index.html` et ajoutez les dossiers `css/`, `js/`, `vendor/`
   (glisser-déposer du contenu du dossier dans **Add file → Upload files**, puis **Commit**).
   Conservez vos autres fichiers existants (`confidentialite.html`, etc.).
2. Attendez la fin du déploiement GitHub Pages (onglet **Actions**, coche verte, 1 à 2 minutes).

## 3. Vérification

1. Ouvrez l'application et rechargez **sur chaque appareil** avec **Ctrl + F5** (ou fermez/rouvrez l'onglet sur mobile).
   Le badge en haut doit indiquer **v55**. Important : un appareil resté sur l'ancienne version n'a pas la détection de conflit.
2. Connectez-vous : vos livreurs et votre historique doivent apparaître.
3. L'indicateur en haut doit passer à **« Synchronisé avec le cloud »**.
4. Cliquez dessus : la ligne **« Détection de conflit »** doit afficher **Active (numéro de révision)**.

## Recommandé (sécurité des données)

L'ancien `index.html` contenait des données réelles (salaires nominatifs, n° de colis, e-mail admin).
Le remplacer ne l'efface pas de l'**historique Git**, qui reste public. Pour le retirer définitivement :
supprimez puis recréez le dépôt avec les nouveaux fichiers (le plus simple), ou purgez l'historique
(`git filter-repo`). Le fichier `sauvegarde-privee-livreurs-salaires.html` fourni à part ne doit
**jamais** être envoyé sur GitHub.
