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
