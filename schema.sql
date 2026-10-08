-- À exécuter dans Supabase > SQL Editor
create table if not exists institutions(
  code text primary key, nom text not null, role_simt text);
insert into institutions values
 ('DT','Direction du Travail (MTFPS)','Coordination, interface OIT, validation'),
 ('ANEFIP','ANEFIP – Observatoire National de l''Emploi et des Qualifications','Emploi, demande d''emploi, qualifications, formation'),
 ('CNSS','CNSS','Affiliation, cotisations, salaires déclarés, pensions'),
 ('INSTAD','INSTAD','Enquêtes ménages, recensements, normes et classifications'),
 ('IGT','Inspection Générale du Travail','Hébergement .Stat, sécurité, données SST'),
 ('BIT','BIT / OIT (appui)','Appui technique .Stat/SDMX, formation')
on conflict do nothing;
create table if not exists users(
  id bigserial primary key, email text unique not null, nom text,
  hash text not null,
  role text not null check (role in ('admin','data_admin','lecteur')),
  institution text references institutions(code));
create table if not exists indicators(
  code text primary key, libelle text not null, institution text references institutions(code),
  definition text, classification text default '19e CIST', unite text,
  documente boolean default false);
create table if not exists dataflows(
  id bigserial primary key, code text unique not null, libelle text,
  institution text references institutions(code), dsd text,
  statut text default 'brouillon' check (statut in ('brouillon','soumis','valide')),
  valide_le timestamptz);
create table if not exists observations(
  id bigserial primary key, indicator text references indicators(code),
  institution text references institutions(code), periode text not null,
  valeur numeric not null, sexe text default '_T', cree_le timestamptz default now());
create table if not exists transmissions(
  id bigserial primary key, institution text references institutions(code),
  nb_lignes int, cree_le timestamptz default now());
create table if not exists requests(
  id bigserial primary key, nom text, email text, organisation text,
  sujet text not null, message text, statut text default 'nouvelle', cree_le timestamptz default now());
create table if not exists actions(
  id bigserial primary key, titre text not null, responsable text, echeance date,
  statut text default 'a_faire' check (statut in ('a_faire','en_cours','fait')));
