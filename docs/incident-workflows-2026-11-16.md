# Incident Workflows - 16 novembre 2026

## Deux problèmes distincts

1. **Ouverture directe de `/workflows`** : le garde lit `/plugins` avant que le shell ait ouvert la branche personnelle. En workspace mode, cette API refuse les lectures sans branche. Le garde transformait cette erreur en « plugin désactivé ». Après chargement de My applications, le clic Workflows fonctionne. Ce n'est pas une désactivation effective du moteur.
2. **Erreur de manipulation pendant le diagnostic** : désactivation/réactivation sur `personal/demo-alice`, puis Apply vers main, a changé une seule ligne de `plugin_runtime_state`, pour `acme-demo / workflows-iga` :
   - avant : installed=1, enabled=1, faulted=0, grants_json=`{"install":true}` ;
   - après : mêmes indicateurs, grants_json=`{"hooks":[],"install":false,"uiComponents":false}`.

Le grant `install` autorise les migrations/seeds à l'installation. `isActive` ne consulte pas ce grant. Sa perte n'arrête donc pas le moteur déjà installé/activé, mais reste une modification indue de la configuration. Aucun grant supplémentaire n'est nécessaire pour afficher Workflows.

## Preuves live relues en lecture seule

- Source antérieure : commit Dolt `bbekruc3q1ej303tu23o7j3u1a35a3nf`, lecture `AS OF` de la ligne : `{"install":true}`.
- Disable : `jjbi969p368s46r89dqts8pgr2qui9is`, 16:47:25 UTC.
- Enable : `90glhrg6rtfg5aijachp7q4922jpo98q`, 16:47:44 UTC.
- Apply : `h2psqme55ikbip7cha1l2cete1f5duq0`, 16:50:55 UTC, « Apply workspace personal/demo-alice ».
- Lecture main vers 17:03 UTC : ligne toujours dégradée, installed/enabled/faulted inchangés.

Ces preuves ne sont pas une restauration. Aucun UPDATE, Apply, reseed, redémarrage ou changement de grant n'a été exécuté lors de cette réparation.

## Correctifs

- Le shell et le garde partagent une initialisation de branche dédupliquée. Le garde ouvre/réutilise la branche personnelle avant les lectures branchées, sans remplacer une branche déjà choisie ou une branche de test.
- Le cache de disponibilité est lié à la branche. Le garde revalide lors de chaque entrée dans Workflows.
- L'UI conserve les grants existants lorsqu'on ouvre le panneau. Enable ne transmet plus `install`, réservé à Install.
- Le contrôleur préserve les grants omis. Enable ignore tout champ `install`, vrai ou faux : il ne peut ni le retirer, ni l'accorder.

## Restauration stricte : opérateur, après décision du propriétaire

La console SQL bloque volontairement les écritures sur `plugin_runtime_*`. Cette protection reste inchangée. L'UI ne propose pas la réinstallation d'un plugin déjà installé. Ne pas contourner ces protections ou réinitialiser toute la démo.

Le script `scripts/repair-workflows-grant-20261116.mjs` est une commande opérateur ponctuelle, pas un endpoint et pas une migration automatique. Son intégration à la PR ne restaure pas main. Il utilise uniquement l'accès Dolt opérateur existant. Aucun accès serveur n'a été ouvert pour l'exécuter.

1. Sauvegarder par les moyens opérateur existants. Se connecter au serveur Dolt avec le compte opérateur existant, depuis son environnement sécurisé. Renseigner les variables `DOLT_DB`, `DOLT_HOST`, `DOLT_PORT`, `DOLT_USER`, `DOLT_PASSWORD` par la configuration sécurisée habituelle, jamais dans un commit ou un message.
2. Depuis le dépôt après installation des dépendances API, lancer `node scripts/repair-workflows-grant-20261116.mjs`. Mode par défaut : lecture seule, vérification de main, du working set propre, de la source antérieure et de l'état exact attendu.
3. Si les contrôles passent et si le propriétaire a autorisé cette préparation opérateur : `node scripts/repair-workflows-grant-20261116.mjs --prepare`. Crée seulement `repair/workflows-grant-20261116` depuis le HEAD d'incident vérifié, puis modifie uniquement la ligne et la colonne précitées, avec contrôle de concurrence. Commit limité à cette table. Aucun merge de main.
4. Dans Lyam, sélectionner la branche de réparation, inspecter Review & Apply. Le diff doit être exactement une ligne, uniquement grants_json vers `{"install":true}`. Tout autre changement : arrêter. Appliquer uniquement avec autorité du propriétaire. Vérifier main après Apply, le diff vide et la disponibilité via clic puis lien direct après déploiement du correctif.
5. Si main, la ligne ou le working set ont changé, le script s'arrête. Ne pas supprimer les contrôles, ne pas remplacer les hashes pour « faire passer » la commande. Reprendre l'analyse sur les nouvelles preuves. Ne pas automatiser un reset/reseed.

Si aucun accès opérateur existant n'est disponible, la restauration reste bloquée. Ce script ne prétend pas fournir un accès inexistant. Le merge de la PR ne doit jamais être présenté comme la restauration de cette ligne.

## Vérifications

- Tests web : garde initial, refresh, branche de test, cache par branche, erreur distincte et déduplication ; réactivation UI sans effacement des grants.
- Test unitaire contrôleur : omission conserve, révocation runtime explicite conserve sa sémantique, `install` ignoré dans les deux sens.
- Test HTTP de non-régression ajouté dans `plugins-admin.spec.ts` ; nécessite NATS + core, non disponibles sur l'environnement de ce correctif. À exécuter par la CI complète.
- Script de restauration : tests négatifs + test sur vrai Dolt isolé. Vérifie que seule la branche est corrigée, main et un autre tenant restent inchangés, deuxième exécution refusée.
- `workflows-deeplink-ui-check.mjs` : vrai bundle web production + API **simulée locale**, ouverture directe et rechargement, plugin désactivé toujours bloqué. Ce n'est pas un test live après déploiement.

## Extension demandée : départ de démonstration reproductible

Cette PR prépare un **nouveau jeu de données**. Elle ne déploie rien et ne restaure pas les grants de l'instance existante. Emmanuel a indiqué ne pas disposer de l'accès opérateur Dolt : la restauration ciblée ci-dessus reste bloquée. Ne pas supprimer les données ou redémarrer le service pour obtenir une « réparation » par réinitialisation.

### Configuration de départ

Le lanceur hébergé `demo/start.sh` activait déjà workspace mode, store plugins Dolt, authentification annuaire, seeds d'authentification et métier, contrôle des écrans et administrateur de démonstration. Aucune manipulation préalable dans Plugins ou Apply n'est nécessaire sur une base vide. `scripts/demo-start.sh` utilise désormais ces mêmes opt-ins, le gate d'authentification et un issuer commun core/API. `scripts/demo-setup.sh` installe aussi les dépendances plugins à la racine. Ces scripts locaux ne sont pas un lanceur de production.

Le seed existant prépare les personnes fictives, organisations, rôles, affectations, applications SSO et plugins métier. Workflows conserve son grant d'installation après Enable. Le plugin `auth-password-lockout` reste disponible mais **non installé** pour garder le geste Install / Enable / Disable pendant la séance, uniquement sur la branche personnelle si aucun Apply n'est voulu.

Les 11 définitions de workflows sont conservées. Aucun scénario Google réel n'est ajouté pour atteindre artificiellement 12. Le scénario Google optionnel existant reste conditionné à des métadonnées explicites et inactif ; cette PR ne le configure pas.

Les trois candidats simulés démarrent désormais avec `process=En cours`, `cree` vide. Le watcher ne doit donc créer aucun run RH au démarrage. La feuille est en RAM : un redémarrage de processus réinitialise ces lignes, même si Dolt persiste. Ce n'est pas un journal durable de l'état RH.

Les blocs Google/Jira du seed par défaut portent explicitement `executionMode=simulation`. Les transformations et écritures IAM sont réelles sur la branche du run, mais la mise à jour Google est simulée : sortie attendue `dryRun:true, updated:false`, cellule `cree` inchangée. Le webhook d'intake simule lui aussi l'ajout, il n'ajoute pas de ligne. Les textes du seed le disent, même si le badge générique du catalogue/run indique encore qu'un type de bloc est « REAL-capable ». Ne pas présenter ce badge comme preuve d'un effet externe.

### Ce qui n'est pas semé

Aucun compte `bernard.lea`, rôle de répétition, branche `workflow/*` ou `ai/*`, run terminé, session MCP, trace ni pull request de données. Ces résultats doivent être produits et observés pendant la démonstration. Aucun jeton, clé Google/Jira ou session de répétition n'est ajouté au dépôt.

### Second démarrage et limites

`DemoDataService` ne fait rien si les organisations du tenant existent déjà sur main. Il ne répare donc ni un plugin désactivé ni un grant existant : les choix de configuration ne sont pas écrasés. `WorkflowDemoSeed` ajoute les définitions manquantes avec leurs IDs fixes et ne réécrit aucune définition existante. Les nouveaux textes/configs de workflows ne remplacent donc pas les anciennes définitions d'une instance déjà initialisée. Il n'y a pas de migration de droits cachée dans cette PR.

### Vérifications après un futur déploiement choisi par Emmanuel

1. Conserver/sauvegarder les données existantes et déterminer si le stockage est réellement vide ou conservé. Un redéploiement sur stockage éphémère peut perdre branches, runs et historique : ce n'est pas une restauration ciblée.
2. Sur une base réellement neuve : connexion `demo-alice`, accès direct `/workflows` puis rechargement sans redirection, 11 définitions par défaut, graphe RH 8 nœuds / 7 liens ; workflows et connecteurs activés, grant Workflows `install:true`, lockout non installé. Aucun run RH lancé spontanément après le premier tick du watcher.
3. Modifier la ligne Bernard : `En cours` vers `OK`. Attendre le watcher (premier tick vers 12 secondes après boot, puis environ chaque minute). Vérifier le run terminé, le compte `bernard.lea` à login désactivé et le rôle employee sur une branche isolée. Main doit rester inchangé. Vérifier `dryRun:true, updated:false` à l'étape mark. Ouvrir la revue, sans merge.
4. Le chemin SSO local n'exige pas de rediriger PeopleHub : utiliser `node demo/oidc-test-client.mjs <origine>/api/sso/acme-demo/oidc wiki 4300` et suivre le vrai consentement/PKCE. Le callback localhost:4300 est déjà enregistré. Ne pas modifier les destinations des applications hébergées en douce.
5. Vérifier Cedar SoD (refus), puis une vraie session MCP : écriture sur sa branche IA, `mysql.user` refusé, revue sans merge. Ne pas semer ces preuves à l'avance.
6. Au second démarrage avec les mêmes données : pas de réécriture des définitions personnalisées, pas de réactivation d'un plugin volontairement désactivé. Vérifier séparément les lignes RAM réinitialisées et la conservation effective des données Dolt. La restauration de la ligne d'incident existante demeure un sujet distinct.
