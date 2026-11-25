# JalonA, replay de transformation sur nouvelle copie jetable

Brouillon pour revue. Aucun passage E5 autorisé. CLI volontairement refusante.
But: expliquer le seul écart de root WORKING iam_meta/main, pas admettre le runtime.

## Entrées ancrées à conserver intactes

- work/root/dolt-evidence-57c4a92e03bd816f/work, tree50c5d879…301d2d,
  15069538octets/32fichiers. Source et incoming ne sont pas montés.
- Capture froide/root/dolt-evidence-57c4a92e03bd816f/capture.json,
  SHA0202f34a1012b3b26548258ee6c7d198d3585119700a36c3aed72bc5f5c8d23e.
- before original/opt/lyam-recovery/active/data/recovery-before.json,
  SHA19409b47a2a0c97665d30298948014410eafe873650bdd03fdb16b5c062049d8.
- after original/opt/lyam-recovery/active/data/recovery-after.json,
  SHA8d65195a90815d09ff7290bb826d12e06f1435b66ad2b85f9095e0d485176628.
  Les deux ancres ont8refs/3bases et rootWORKING, pas seulement HEAD.
  Before est une observation candidate restaurée pré0003, après arrêt source,
  jamais une ancre indépendante préarrêt.
- Image locale81aeb: preuve registre/index→amd64→config et comparaison Config
  complète+28diffIDs déjà établies. Revalidation avant toute proposition.
- DDL extrait du store.js de cette image, SHA4dc5b549…29ccae, méthode0003 liée
  à preparePieceStorage puis pieceTable par source compilée. Ne jamais importer
  l'application, démarrer l'app ni exécuter le migrations CLI sur les données.

## Opération proposée, distincte du cold read déjà fait

Créer uniquement/root/dolt-replay-<16hex> absent,root0700. Copier work en entier
vers tmpfs/data/dolt neuf de1GiB maximum, sans reset/checkout/commit.
Rehash work avant/après; workmontéRO/input,bootstrapNodecopiedans tmpfsavantspawnserveur. Seule cette nouvelle copie est writable.

Serveur Dolt jetable netnone, bind127.0.0.1:3307 dans son namespace,aucun port
hôte, rootfsreadonly/capdropALL/no-new-privileges,mem1.5GiB/no swap,CPU0.5,
PID96,OOM1000,init,GOMAXPROCS2,tmpfs/tmp64MiBnoexec. Donnéesmutablesprivées en tmpfs1GiBnosuid/nodev/noexec,
plafond d'entrée384MiB,headroom4GiBMemAvailable et2GiB+2*entrée sur disque.
Letmpfsborne lacroissancedesdonnées1GiB,comptabiliséeparcgroup1.5GiB;sonépuisementdoitrefuser,sansrelèvementautomatique. AucunarbreSQLmutablepersistantsurdisque.

Client capture distinct, netns du serveur seulement,aucun mountproduction,
cwd/data/dolt tmpfsvide corrigé explicitement dans le lotA,mem768MiB/PID96/
CPU0.5/no swap/init/GOMAXPROCS2,watchdog150s+subprocess180s,cleanup20s.
Capture avant serveur DOIT égaler tables-v3 froid intégralement. Une différence
au démarrage refuse: jamais réparer ni masquer permissions/locks dans la copie.

Client DDL séparé,readonly/netnsserveur,aucun montage,mémoire256MiB/PID64/
CPU0.5/init/GOMAXPROCS2,tmpfs16MiB. Appliquer uniquement SQL DDL hashé et pin
exact workflow_piece_state sur iam_meta/main. Pas d'autre migration autorisée.

Capturer deux fois après, égalité complète obligatoire. Vrai vérificateur0003
strict:8refs conservées;7identiques;iam_metaHEADidentique,13tablesoriginelles
hash/shape/rows/index/DDLidentiques;14etablevide+statusnewunstagedexact.
Comparer simultanément TOUS8tuples database/branch/head/WORKINGroot au after
ORIGINAL. Une divergence bloque, même si une comparaison partielle est verte.

Moniteur hôte mémoire/PID/events/OOM/état serveur+clients,aucune valeur brute.
Global900s,cleanup exactserver/client20s chacun,signaux protégéspendantcleanup,
SIGKILL/kernel failure non couvert. Aucun cleanup global ni rm source/incoming/work.
Résultat/after/pre-server privés0600 sousroot0700; conserver arbre replayprivé
pour analyse,effacement éventuelpar décisionopérateur séparée. Refus=pasderejeu.

## Qualification avant E5

Même fonction execute/bounded_execute appelée par fixture synthétique enrichie,
pas une réécriture simplifiée. Cette qualification ne donne que des ancres
synthétiques autodérivées. Le replay réel utilisera after original indépendant
de sa propre exécution, mais historiquement issu de la même restauration.
Fichiers,bindings,spec et hashes finaux à fournir après résultats et revue.

## Voie de remise en service, priorités

1. Récupérable maintenant: comparaison froid→before8/8déjà égale; replayA peut
   qualifier déterministement transformation0003 et préserver WORKINGméta.
2. Ensuite fermable par préparation/revue: preuve currentheldavecmonitorserveur,
   vrais locks/gates/bindings, capturestable; comparaisonDolt/PG/Baocourants;
   nouvelles preuves NATS état/cursors/payloads si disponiblesdansstoresbruts;
   admission3stores,closedboot/updater/CI réel et réseaurollbackindépendant.
3. Historique absent non recréable comme observation du passé: arrêtapp propre
   avant Exit137,redeliveryafter non capturé,attribution historique des28messages,
   anciensackfloor/payloads/cursorsnonenregistrés. Chercher archivesbrutes peut
   récupérer données,mais nefabrique pasuneobservation passée indépendante.
4. Si restent des écarts historiques non fermables après préparation, décision
   utilisateur à main: accepter un nouveau baseline récupéré avec limites
   explicitement décrites, ou conservermaintenance et chercher autrebackup.
   Cette décision ne peut PAS remplacer contraintes de sécurité courantes,
   autoriser silencieusement effets externes ou effacer les preuves originales.
