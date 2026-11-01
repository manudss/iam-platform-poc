# Étape 0 : spike NATS (essais réels)

Spike jetable, hors du workspace du core (`spikes/nats-step0`, son propre `Cargo.toml`). Il ne modifie ni le core, ni l'API, ni le déploiement. Aucune fusion n'est prévue : il documente ce qui marche, avec les chiffres.

Contexte : plan « POC IAM full événements » (génération 8). Le core Rust possède le bus, les plugins appellent une méthode du core, NATS doit toujours être appelé (D16). Les plugins n'ont qu'un droit minimal.

## Comment rejouer

```bash
cd spikes/nats-step0 && cargo build --release
nats-server -c conf/iam.conf &            # port 4444 (un utilisateur par plugin, JetStream)
target/release/nats-step0-spike calls     # fan-out, délai, profil partiel, fail-closed
target/release/nats-step0-spike forge     # un plugin tente d'usurper une réponse
target/release/nats-step0-spike js        # JetStream, déduplication, consommateur partagé, droits
target/release/nats-step0-spike load      # latence d'un fan-out (LOAD_N=200)
target/release/nats-step0-spike jspub     # 5000 événements JetStream
nats-server -c conf/accounts.conf &       # port 4445 (un compte par projet, quotas)
target/release/nats-step0-spike accounts 127.0.0.1:4445
python3 measure.py <nats-server> conf/iam.conf 0.1 calls jspub load   # mesure avec bridage approximatif
```

Versions : nats-server v2.15.2 (celle de la CI), async-nats 0.51.0, Rust 1.99.1.

## Résultats mesurés (tout est reproductible avec les commandes ci-dessus)

### Appels du core vers les plugins (D2, D3, profil)
- Le core envoie une requête par plugin sur `plugin.<id>.call`, avec un délai de 300 ms. Les plugins `a` (immédiat) et `b` (50 ms) répondent. `c` (muet) et `d` (2 s, trop lent) sont omis : profil = réponses reçues de `a` et `b`.
- Règle fail-closed du core : obligatoires `a`,`b` = AUTORISÉ ; obligatoires `a`,`c` (c muet) = REFUS. Un contrôle non obligatoire muet est ignoré. C'est une règle du core, pas de NATS.
- Coût de latence : un plugin muet ou lent fait attendre le délai complet (300 ms mesurés : 300,7 ms au total). Le délai est donc un réglage de la décision, pas un détail.

### Droits par plugin (utilisateur NATS distinct)
Configuration : `publish` limité à `core.in.<id>`, `subscribe` limité à `plugin.<id>.call` et à son préfixe d'inbox `_INBOX.<id>.>`, `allow_responses` (max 1, 5 s). Le client utilise `custom_inbox_prefix("_INBOX.<id>")`.
- Réponse normale : le core la reçoit, une seule fois.
- Un plugin `b`, à qui l'on fournit même le sujet de réponse exact d'une requête adressée à `a`, tente de publier dessus : `Permissions Violation for Publish`. Le core ne reçoit que la réponse de `a`.
- `b` ne peut pas publier sur `plugin.a.call`, ni s'abonner à `_INBOX.a.>` ni à `_INBOX.>` : violations côté serveur (visibles dans les erreurs du client et dans le journal du serveur).
- Attention côté client : `subscribe` retourne `Ok` même si le serveur refuse ensuite. L'erreur arrive par l'événement `ServerError` : le code du core doit écouter cet événement.

### JetStream (D5, D16, mail E3)
- Flux `EVT` (`evt.>`), consommateur durable partagé `mail`, fenêtre de déduplication 120 s.
- Même `Nats-Msg-Id` publié deux fois : `doublon=true` à la deuxième, un seul message stocké. Cela ne dédoublonne que la **publication**, dans la fenêtre de déduplication (120 s ici). Cela ne garantit pas l'absence de double effet : une relivraison (ack perdu, `ack_wait` dépassé, crash du consommateur), un message hors fenêtre, ou un chemin local plus un chemin NATS peuvent exécuter deux fois. L'exécutant doit rester idempotent avec un effectKey (identifiant d'effet déterministe) vérifié côté exécution. Ce comportement n'a pas été testé ici (voir « Non testé »).
- Deux plugins mail (`e1`, `e2`) tirent depuis le même consommateur : sur 7 messages stockés (1 dédoublonné), `e1` en traite 4 et `e2` 3, sans doublon.
- Droits JetStream minimaux qui ont suffi pour un consommateur en tirage : `publish` sur `$JS.API.CONSUMER.INFO.EVT.mail`, `$JS.API.CONSUMER.MSG.NEXT.EVT.mail`, `$JS.ACK.EVT.mail.>`, et `subscribe` sur son inbox. Le consommateur est créé par le core.
- `e1` ne peut pas créer de flux : `Permissions Violation for Publish to $JS.API.STREAM.CREATE.PIRATE`, la requête expire côté client.

### Un NATS séparé partagé entre projets (comptes)
`conf/accounts.conf` : un compte `IAM`, un compte `OTHER`, JetStream avec quotas par compte.
- Un abonné du compte `OTHER` ne reçoit pas les événements du compte `IAM` : isolé.
- Le même nom de flux (`EVT`) existe dans les deux comptes sans collision.
- Quotas appliqués : 3e flux dans `OTHER` refusé (`maximum number of streams reached`), flux de 16 Mo refusé dans un compte limité à 8 Mo (`insufficient storage resources available`).
- C'est de la capacité d'hébergement partagé. Le POC lui-même n'a pas de multi-tenant métier (D11).

### Ressources (machine de test, 2 CPU, mémoire 2 Go)
| Mesure | Résultat |
| --- | --- |
| nats-server 2.15.2 avec JetStream, sans client | 11 à 13 Mo de mémoire résidente |
| Après 5000 événements JetStream (512 o, stockage fichier, acquittés) et 500 appels | 25 Mo résidents (pic) |
| Débit JetStream, sans bridage | 5000 événements en 38 ms (environ 130 000 par seconde) |
| Débit JetStream, serveur bridé à environ 10 % de CPU | 5000 événements en 0,40 s (environ 12 500 par seconde) |
| Latence d'un appel vers 2 plugins (le plus lent répond en 50 ms) | 51 ms sans bridage, 100 ms avec bridage |

Limites de ces chiffres :
- Pas de cgroup disponible : le bridage est un cycle SIGSTOP/SIGCONT du seul nats-server (10 ms actif, 90 ms arrêté). C'est une approximation de 0,1 CPU, pas la mesure sur Render. Le client et les plugins n'étaient pas bridés ; dans le conteneur réel ils partageraient le même CPU.
- Pas de mesure sur le conteneur Render lui-même, ni en parallèle de l'API et du core.
- Charge faible (quelques centaines d'appels, 5000 événements). Pas de test de montée en charge ni de durée.
- Clients simulés dans un seul processus, pas de vrais plugins du repo.

## Hébergement : ce que disent les sources

- Render, offre gratuite (https://render.com/docs/free) : 0,1 CPU et 512 Mo, arrêt après 15 min sans trafic entrant, système de fichiers éphémère, pas de trafic privé entrant sur un service gratuit, seuls certains types de service sont gratuits (web, Postgres, Key Value). Conséquence : un nats-server séparé gratuit sur Render n'est pas possible. Il faudrait le lancer dans le même conteneur que l'application (processus supplémentaire, environ 25 Mo mesurés) avec un stockage JetStream éphémère, donc perdu à chaque redémarrage. Acceptable pour une démo, pas pour de la durabilité.
- Synadia Cloud, offre « Personal » gratuite (https://docs.synadia.com/cloud/pricing) : 2 comptes, 10 connexions, 100 abonnements par connexion, 5 Gio de stockage, 10 flux, 10 Gio de transfert. Cela couvre un POC et deux projets (un compte chacun). Il faut créer un compte Synadia : accès nouveau, à valider par l'utilisateur avant engagement. Latence depuis Render et comportement avec les droits par plugin non testés.
- NATS auto-hébergé multi-comptes (ce spike) : isolation et quotas fonctionnent. Il faut un hôte qui accepte un port TCP et du stockage. Aucun hôte gratuit n'a été évalué ni engagé.

## Non testé (reste à faire, rien d'engagé)
- Le même scénario avec les vrais plugins et le vrai core Rust (le core n'a aujourd'hui aucune dépendance NATS).
- Droits sur un serveur Synadia Cloud (authentification par identifiants et JWT, pas par mot de passe).
- Auth callout, JWT décentralisés, import/export de services entre comptes (lus dans la documentation officielle, pas essayés).
- Mesure sur le conteneur Render réel, redémarrage et perte de données JetStream.
- Crash et reprise : relivraison après `ack_wait` dépassé, plugin qui plante avant l'ack, doublon hors fenêtre de déduplication, chemin local plus chemin NATS (D16). L'idempotence par effectKey côté exécutant n'est donc pas démontrée, seulement la déduplication de publication.
- Comportement après redémarrage du serveur (relecture, durabilité), reprise des consommateurs.
- Version async-nats et nats-server : essais faits uniquement avec async-nats 0.51.0 et nats-server 2.15.2.
