# Jalon B, observation held actuelle, préparation seulement

Statut: NON exécutable. CLI refuse toujours. Aucun passage E5 autorisé.
A est rapporté réussi par opérateur; postchecks/preuves restent la source de sa
clôture. B distingue état présent et after historique, sans admission.

## Code séparé

`dolt-current-observation.py` ajoute une orchestration. Aucun des six fichiers
qualifiés489ce n'est modifié. Modules fixes et hashbound:
- restored-runtime-check.py, runtime direct existant;
- dolt-held-capture.py, même lecteur réseau isolé qualifié synthétiquement;
- dolt-copy-capture.py, moniteur ressources du client réutilisé sans reimport non lié;
- qualification-container.mjs, SQL identique.

Spec exacte format1/kind reviewed-current-held-observation:
`runtime_controller`, `helper`, `resources`, `source`, `reference_after`,
`journal`, `pause` sont bindings {path,sha256}; `root` doit être neuf sous
/root/dolt-current-<16hex>. `executed_source_sha256` lie le watchdog+source.
`runtime` est la spec stricte restored-epoch-direct-held-check existante.
`expected` contient container_id/image_id/pid/started_at/netns_inode/cgroup.
`limits` contient memory_current_max/pids_current_max/cpu_usec_per_second_max.
Aucune valeur réelle ou seuil n'est inventé. Le paquet concret reste à assembler.

## Locks et état figé

Deux locks EXISTANTS, ouverture O_RDONLY|O_NOFOLLOW, jamais création/troncature:
/opt/lyam-recovery/active/deploy-queue/state.json.lock et .update.lock.
Ancêtres root non modifiables, inode régulier unique, flock exclusif non bloquant.
Le runtime vérifie la preuve d'exclusivité depuis une seconde ouverture et
l'inode toujours nommé. Bindings conservés jusqu'à la fin; fd transmis aux
clients, sans montage de ces fichiers dans le lecteur.
Les chemins effectifs LYAM_LOCK_FILE/LYAM_QUEUE_STATE/LYAM_PAUSE_FILE doivent
pointer sur ces chemins fixes. Journal et UPDATE_PAUSED sont hashbound, ainsi
que les deux gates, env/config/helper/proof/policy. Écart = refus, pas réparation.
Ces locks bloquent seulement les acteurs qui les respectent. Ils ne bloquent pas
un SQL manuel ou tout writer de l'app; la stabilité double reste nécessaire.

## Vérification actuelle et charges

Avant/après: runtime.verify existant, qui exécute le helper installé en mode
postcheck, inspecte conteneur/image/env/capabilités/confinement, et trois GET
HTTPS /healthz locaux SNI certifiés503. Cela inclut docker exec Node en lecture
de l'IPv6, deux lectures firewall nsenter. Aucun probe externe ni lancement app,
mais cette portée doit être explicitement acceptée en revue, pas appelée zéro
exécution dans le serveur held. Aucun helper preflight/launch ni migrations CLI.

Guard hôte pendant les captures: toutes2s environ, inspect timeout5s + fichiers
hashbound + locks, PID/StartedAt/containerID/imageID/restart0/running/nonOOM,
netns inode et cgroup enfant exact. memory.current et pids.current sous seuils
à revoir sur mesures présentes; CPU delta usage_usec/seconde sous seuil explicite.
Événements memory max/oom/oom_kill et pids max ne doivent pas augmenter depuis
baseline. Mesure manquante, intervalle >10s, identité ou hash changé = refus.
memory.peak lu à titre diagnostic, jamais assimilé à une charge actuelle.
L'échantillonnage ne prouve pas l'absence d'un pic entre deux lectures.

Le guard signale uniquement son propre processus Python pour interrompre le
client Docker. Cleanup du lecteur via helper dans finally, jamais arrêt held.
Pas de mutation/relèvement limites du cgroup serveur. Pas de processus tué
par recherche large de nom. Global900s, deux captures séquentielles chacune
watchdog150s/subprocess180s/cleanup20s. Lecteur init/netns held/rootfsRO/capsdrop,
768MiB/no swap/PID96/CPU0.5, aucun mount production, tmpfs isolés.

Captures privées écrites immédiatement après chaque retour valide, même si
comparaison ultérieure refuse. result.json0600 contient étape, mesures et verdict.
Deux captures doivent être exactement égales et leur champ dolt doit égaler
l'after réel produit par A, hashbound, pas une nouvelle ancre auto-générée.
Toute différence reste preuve privée: aucun reset/commit/DDL/adoption ancre.
Succès B = état présent Dolt stable et égal à A, pas PG/Bao/bus/non-perte/admission.

## Tests et blocages actuels

Six tests locaux B: seuils/events/CPU/mesures manquantes; refus ancestry writable;
guard fail-closed et signal seulement à lui-même (double); vrais deux flock avec
refus déverrouillage/remplacement; spec inconnue avant read; vrai CLI refusant.
Trois tests runtime existants et deux helper existants passent également.
Aucune qualification Docker du guard B ni orchestration B complète à ce stade.
La CLI ne sera pas activée avant cette qualification + revue indépendante.

À obtenir via main/opérateur avant spec finale: hashes et chemins non secrets
ci-dessus, afterA récupéré, exact état présent identité/cgroup et profil charge,
origins SNI effectifs. Aucun contenu env/secret dans les rapports. Écart de
fichier/env/proof/lock => remonter le fait, ne jamais élargir ancestry ni créer
un lock pour contourner le refus. Aucun run E5 demandé par ce document.
