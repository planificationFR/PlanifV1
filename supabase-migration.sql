-- ════════════════════════════════════════════════════════════════════════════
--  Planification Livraisons — migration Supabase v55
--
--  À EXÉCUTER UNE FOIS dans Supabase → SQL Editor → New query → Run,
--  AVANT de mettre en ligne la nouvelle version des fichiers.
--
--  Ce script est pensé pour une base EXISTANTE contenant des données :
--    • aucune donnée n'est supprimée ni modifiée (seules des colonnes,
--      index, fonctions, triggers et règles d'accès sont ajoutés/remplacés) ;
--    • il peut être relancé sans risque (idempotent) ;
--    • tout est exécuté dans une transaction : en cas d'erreur, RIEN n'est
--      appliqué (la base reste exactement dans son état précédent) ;
--    • les anciennes règles d'accès (policies) sont copiées dans la table
--      public._rls_policies_backup_v55 avant d'être remplacées.
--
--  Ce qu'il fait :
--    1. user_data : colonne `revision` + trigger qui l'incrémente à chaque
--       écriture → détection des conflits entre appareils (plus d'écrasement
--       silencieux) ; propriétaire (user_id) non modifiable.
--    2. user_data_versions : conserve automatiquement les 10 versions
--       précédentes de chaque document (filet de sécurité côté serveur).
--    3. Row Level Security stricte :
--         user_data            : chaque utilisateur lit/crée/modifie SA ligne ;
--                                aucune suppression depuis l'application ;
--         user_data_versions   : lecture de SES versions uniquement ;
--         profils              : lecture de SA ligne uniquement ;
--         abonnements          : lecture de SA ligne uniquement
--                                (seul le webhook Stripe, en service_role, écrit) ;
--       + le rôle « anon » (visiteur non connecté) n'a plus aucun accès.
--    4. profils.is_admin : un trigger interdit toute modification (ou création
--       d'un profil admin) sauf par le SQL Editor / service_role.
--
--  Les Edge Functions (create-checkout, webhook Stripe) utilisent la clé
--  service_role côté serveur : elles ne sont PAS concernées par ces règles.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ─── 0. Vérifications préalables ────────────────────────────────────────────
do $$
begin
  if to_regclass('public.user_data') is null then
    raise exception 'Table public.user_data introuvable : ce script est prévu pour la base existante de l''application.';
  end if;
end $$;

-- Sauvegarde des policies existantes (pour pouvoir revenir en arrière)
create table if not exists public._rls_policies_backup_v55 as
  select now() as saved_at, p.* from pg_policies p where false;
insert into public._rls_policies_backup_v55
  select now(), p.* from pg_policies p
  where p.schemaname = 'public' and p.tablename in ('user_data', 'profils', 'abonnements');
alter table public._rls_policies_backup_v55 enable row level security;   -- aucune policy : invisible pour l'application
revoke all on table public._rls_policies_backup_v55 from anon, authenticated;

-- ─── 1. user_data : révision + horodatage serveur ───────────────────────────
alter table public.user_data add column if not exists revision bigint not null default 1;
alter table public.user_data add column if not exists updated_at timestamptz not null default now();

-- Unicité de user_id (une ligne par utilisateur ; indispensable à la synchro).
do $$
declare
  deja_unique boolean;
begin
  select exists (
    select 1
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = 'public.user_data'::regclass
      and i.indisunique and i.indnkeyatts = 1 and a.attname = 'user_id'
  ) into deja_unique;
  if not deja_unique then
    if exists (select user_id from public.user_data group by user_id having count(*) > 1) then
      raise notice 'ATTENTION : plusieurs lignes user_data pour un même user_id — index unique NON créé. Contactez le support avant de continuer.';
    else
      create unique index user_data_user_id_unique_v55 on public.user_data (user_id);
    end if;
  end if;
end $$;

create or replace function public.user_data_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.revision   := 1;
    new.updated_at := now();
    return new;
  end if;
  -- UPDATE : la révision et l'horodatage sont décidés par le serveur,
  -- le propriétaire de la ligne ne peut pas changer.
  new.user_id    := old.user_id;
  new.revision   := old.revision + 1;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_user_data_before_write on public.user_data;
create trigger trg_user_data_before_write
  before insert or update on public.user_data
  for each row execute function public.user_data_before_write();

-- ─── 2. Historique serveur des versions (10 dernières par utilisateur) ──────
create table if not exists public.user_data_versions (
  id          bigserial primary key,
  user_id     uuid        not null,
  revision    bigint,
  data        jsonb,
  updated_at  timestamptz,
  archived_at timestamptz not null default now()
);
create index if not exists user_data_versions_user_idx
  on public.user_data_versions (user_id, archived_at desc);

create or replace function public.user_data_archive_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.data is distinct from new.data then
    insert into public.user_data_versions (user_id, revision, data, updated_at)
    values (old.user_id, old.revision, old.data, old.updated_at);
    delete from public.user_data_versions v
     where v.user_id = old.user_id
       and v.id not in (
         select id from public.user_data_versions
          where user_id = old.user_id
          order by archived_at desc, id desc
          limit 10);
  end if;
  return null;
end $$;

drop trigger if exists trg_user_data_archive on public.user_data;
create trigger trg_user_data_archive
  after update on public.user_data
  for each row execute function public.user_data_archive_version();

-- ─── 3. Row Level Security ──────────────────────────────────────────────────
-- On repart d'un état connu : toutes les policies existantes de ces tables
-- sont retirées (copie dans _rls_policies_backup_v55), puis recréées.
do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('user_data', 'user_data_versions', 'profils', 'abonnements')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- user_data
alter table public.user_data enable row level security;
revoke all on table public.user_data from anon;
grant select, insert, update on table public.user_data to authenticated;
revoke delete on table public.user_data from authenticated;

create policy user_data_select_own on public.user_data
  for select to authenticated using ((select auth.uid()) = user_id);
create policy user_data_insert_own on public.user_data
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy user_data_update_own on public.user_data
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
-- (pas de policy DELETE : un document ne peut pas être supprimé depuis l'application)

-- user_data_versions
alter table public.user_data_versions enable row level security;
revoke all on table public.user_data_versions from anon;
revoke insert, update, delete on table public.user_data_versions from authenticated;
grant select on table public.user_data_versions to authenticated;
create policy user_data_versions_select_own on public.user_data_versions
  for select to authenticated using ((select auth.uid()) = user_id);

-- profils
do $$
begin
  if to_regclass('public.profils') is not null then
    execute 'alter table public.profils enable row level security';
    execute 'revoke all on table public.profils from anon';
    execute 'revoke insert, update, delete on table public.profils from authenticated';
    execute 'grant select on table public.profils to authenticated';
    execute 'create policy profils_select_own on public.profils for select to authenticated using ((select auth.uid()) = user_id)';
  else
    raise notice 'Table public.profils absente : étape ignorée.';
  end if;
end $$;

-- abonnements
do $$
begin
  if to_regclass('public.abonnements') is not null then
    execute 'alter table public.abonnements enable row level security';
    execute 'revoke all on table public.abonnements from anon';
    execute 'revoke insert, update, delete on table public.abonnements from authenticated';
    execute 'grant select on table public.abonnements to authenticated';
    execute 'create policy abonnements_select_own on public.abonnements for select to authenticated using ((select auth.uid()) = user_id)';
  else
    raise notice 'Table public.abonnements absente : étape ignorée.';
  end if;
end $$;

-- ─── 4. Protection de profils.is_admin ──────────────────────────────────────
-- Même si une policy UPDATE était ajoutée un jour par erreur, personne ne peut
-- se donner le statut admin depuis l'application : seuls le SQL Editor
-- (postgres) et les fonctions serveur (service_role) le peuvent.
do $$
begin
  if to_regclass('public.profils') is not null then
    execute $f$
      create or replace function public.profils_proteger_is_admin()
      returns trigger
      language plpgsql
      set search_path = public
      as $body$
      declare
        role_jwt text := coalesce(current_setting('request.jwt.claim.role', true),
                                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), '');
      begin
        if (tg_op = 'INSERT' and coalesce(new.is_admin, false))
           or (tg_op = 'UPDATE' and new.is_admin is distinct from old.is_admin) then
          if current_user not in ('postgres', 'supabase_admin', 'service_role') and role_jwt <> 'service_role' then
            raise exception 'Modification du statut administrateur interdite';
          end if;
        end if;
        return new;
      end
      $body$;
    $f$;
    execute 'drop trigger if exists trg_profils_proteger_is_admin on public.profils';
    execute 'create trigger trg_profils_proteger_is_admin before insert or update on public.profils
             for each row execute function public.profils_proteger_is_admin()';
  end if;
end $$;

commit;

-- ════════════════════════════════════════════════════════════════════════════
--  VÉRIFICATION (lecture seule) — le résultat doit lister 6 policies :
--  user_data (select/insert/update), user_data_versions (select),
--  profils (select), abonnements (select).
-- ════════════════════════════════════════════════════════════════════════════
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('user_data', 'user_data_versions', 'profils', 'abonnements')
order by tablename, cmd;

-- ════════════════════════════════════════════════════════════════════════════
--  OPTIONNEL — NE PAS EXÉCUTER MAINTENANT.
--  Blocage serveur des données pour les abonnements expirés/annulés.
--  Aujourd'hui, l'écran « abonnement expiré » est affiché par le navigateur :
--  un utilisateur technique peut le contourner et continuer à lire/écrire ses
--  PROPRES données (il ne peut jamais accéder à celles des autres).
--  Pour rendre ce blocage réel, remplacez les 3 policies user_data par les
--  versions ci-dessous. À n'activer qu'après avoir vérifié que la table
--  abonnements est correctement renseignée pour TOUS les comptes (sinon des
--  clients légitimes perdraient l'accès à leurs données).
-- ════════════════════════════════════════════════════════════════════════════
-- create or replace function public.acces_donnees_autorise(uid uuid)
-- returns boolean language sql stable security definer set search_path = public as $$
--   select coalesce((select is_admin from public.profils where user_id = uid), false)
--       or exists (select 1 from public.abonnements a
--                   where a.user_id = uid
--                     and (a.statut = 'actif' or (a.statut = 'essai' and a.fin_essai > now())));
-- $$;
-- drop policy user_data_select_own on public.user_data;
-- drop policy user_data_insert_own on public.user_data;
-- drop policy user_data_update_own on public.user_data;
-- create policy user_data_select_own on public.user_data for select to authenticated
--   using ((select auth.uid()) = user_id and public.acces_donnees_autorise((select auth.uid())));
-- create policy user_data_insert_own on public.user_data for insert to authenticated
--   with check ((select auth.uid()) = user_id and public.acces_donnees_autorise((select auth.uid())));
-- create policy user_data_update_own on public.user_data for update to authenticated
--   using ((select auth.uid()) = user_id and public.acces_donnees_autorise((select auth.uid())))
--   with check ((select auth.uid()) = user_id);
