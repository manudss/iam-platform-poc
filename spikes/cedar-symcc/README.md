# Spike 0 — Cedar SymCC (analyse formelle) : faisabilité

**Jetable.** Aucun chemin de production modifié : ce dossier est un crate Rust autonome
(hors workspace `core/`), plus un job de CI séparé. Verdict : **GO** pour SymCC, avec les
réserves listées en bas.

Date : 5 nov 2026. Machine de mesure : sandbox Linux x86_64 (CPU partagé), Rust 1.99.1 et 1.89.0.

## Ce qui est testé

`src/main.rs` compare deux jeux de politiques Cedar sur **tous les environnements de requête**
du schéma : pour chaque action, `check_implies_opt` dans les deux sens, avec contre-exemple
(`--cex`). Verdicts : `EQUIVALENT`, `A_NARROWER` (B autorise strictement plus), `A_WIDER`,
`INCOMPARABLE`. `run.sh` rejoue toutes les paires et échoue si un verdict est inattendu.

Fixtures : les vraies politiques du POC — `fixtures/demo-main.cedar` (main) et
`fixtures/demo-gateway.cedar` (branche `fix/mcp-upstream-session`, PR24, ajoute `mcp:proxy`
avec `context.mcp_grants`) — plus des variantes synthétiques (rétrécie, incomparable,
élargie, 200 règles).

## Versions et build

| Brique | Version | Licence | Vérifié |
| --- | --- | --- | --- |
| cedar-policy-symcc | 0.8.1 | Apache-2.0 | compile avec Rust **1.89.0** (MSRV annoncé 1.89, `rust-version = "1.89"` dans le crate) et 1.99.1 ; build release frais ~1 min 30 – 3 min |
| cedar-policy | 4.14.1 | Apache-2.0 | même version que le cœur (4.14.0 requis, ^4.14 résout 4.14.1) |
| cvc5 | 1.3.1 | BSD (asset `cvc5-Linux-x86_64-static.zip`, **pas** la variante `-gpl`) | binaire statique 31 Mo, tourne tel quel (zip 42 Mo) |

SymCC pilote cvc5 en **sous-processus** (binaire pointé par la variable `CVC5`). Pas de
liaison native : n'importe quel Linux fait l'affaire, y compris `node:22-bookworm-slim`.

## Résultats mesurés (verdicts tous corrects)

| Comparaison | Verdict | Temps solveur (par env) | Total | RSS pic |
| --- | --- | --- | --- | --- |
| main vs main | EQUIVALENT | < 5 µs (constantes) | 4,5 ms | ~10 Mo |
| main vs gateway | A_NARROWER + contre-exemple lisible | 26 ms sur `mcp:proxy` | 34 ms | 10,5 Mo |
| main vs rétréci (bob retiré) | A_WIDER | 2,6 ms | 10 ms | 10,3 Mo |
| main vs incomparable | INCOMPARABLE | ~ms | 11 ms | 10,4 Mo |
| gateway vs gateway sans condition grant | A_NARROWER | 3,6 / 2,1 ms | 11 ms | 10,5 Mo |
| 40 règles disjointes vs 40 | INCOMPARABLE | 23–25 ms par sens | 60 ms | 10,9 Mo |
| 200 règles vs relaxée | A_NARROWER | 46 / 73 ms | 150 ms | 15 Mo |
| 200 règles, `ulimit -v` 256 Mo | A_NARROWER | idem | 150 ms | 15 Mo |

Le contre-exemple est une requête concrète (principal, action, resource, contexte avec
`roles={"mcp-operator"}` et `mcp_grants`) : exactement ce qu'il faut pour un rapport
d'impact de PR.

## CI (GitHub Actions)

Job `symcc-spike` ajouté à `ci.yml` (déclenchement manuel `workflow_dispatch`, comme le
reste de la CI) : télécharge cvc5 (même méthode `curl` que Dolt/NATS), `run.sh`.
Runner standard `ubuntu-latest`, timeout 25 min. Les runs existants de la CI montrent que
le réseau vers les releases GitHub fonctionne.

## Image Render (demo/Dockerfile)

Mécanisme validé, pas construit faute d'autorisation de preview/deploy :

- **Build** : stage `rust:1-bookworm` (Rust 1.x récent ≥ 1.89) — la compilation du crate y
  est équivalente au build local vérifié ci-dessus.
- **Runtime** : ajouter cvc5 comme Dolt et NATS le sont déjà :

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip && rm -rf /var/lib/apt/lists/*
ARG CVC5_VERSION=cvc5-1.3.1
RUN curl -sSfL "https://github.com/cvc5/cvc5/releases/download/${CVC5_VERSION}/cvc5-Linux-x86_64-static.zip" -o /tmp/cvc5.zip \
 && cd /tmp && unzip -q cvc5.zip && cp cvc5-Linux-x86_64-static/bin/cvc5 /usr/local/bin/ && rm -rf /tmp/cvc5*
ENV CVC5=/usr/local/bin/cvc5
```

- **Mémoire** : pic ~15 Mo par comparaison, compatible avec les 512 Mo du free tier (Dolt
  déjà plafonné à 250 Mio). Image +31 Mo.
- **Latence** : < 200 ms par comparaison à 200 règles — un rapport d'impact **synchrone**
  à la revue de PR est jouable ; pas besoin d'asynchrone à cette échelle.

## Découverte structurante : le schéma est un prérequis

SymCC ne travaille que sur des politiques **bien typées par un schéma** (`CompiledSchema`).
L'analyse d'impact (étape 6) dépend donc du schéma de l'étape 2 — l'ordre du plan est
confirmé. Un schéma de spike couvrant les 6 actions du POC est écrit et validé
(`fixtures/schema.cedarschema`). Points à reprendre à l'étape 2 :

- `context.sod_conflict` est lu **sans garde** `has` par le forbid SoD → déclaré **requis**
  dans le schéma (le cœur l'injecte toujours en mode tenant). Les autres attributs restent
  optionnels car gardés par `has`.
- Le validateur a immédiatement attrapé un accès non gardé dans un de nos fichiers de test
  (`UnsafeOptionalAttributeAccess`) — la validation par schéma rendra service dès l'étape 2.
- `mcp:proxy` : `resource` et `mcp_grants` typés `UpstreamTool`.
- Un invariant « jamais » se réduit à `check_implies` : « P n'autorise approve que si
  `sod_conflict == false` » ⇔ `P` implique `permit(...) when { context.sod_conflict == false }`.

## Éditeur web (coloration + erreurs en direct)

- **`@cedar-policy/cedar-wasm` 4.14.0** (Apache-2.0, wasm 4,3 Mo) — testé réellement sous
  Node (`wasm-editor-check.mjs`) : parse de politiques et de schéma, **validation par schéma
  avec erreurs localisées et suggestions** (« did you mean `roles`? », positions
  start/end), formatage. Suffisant pour les erreurs en direct dans la console Angular.
- **Grammaire** : `cedar.tmLanguage.json` + `cedarschema.tmLanguage.json` du repo officiel
  `cedar-policy/vscode-cedar` (Apache-2.0) — TextMate JSON, réutilisable dans Monaco via
  `monaco-textmate` (+ oniguruma wasm). Pas de grammaire Monarch ou CodeMirror toute faite
  trouvée ; la syntaxe Cedar est petite, un mode Monarch maison resterait simple.

## Réserves / non vérifié

- Image Render réelle **non construite** (pas de preview/deploy pour un spike ; pas de
  Docker dans l'environnement de dev). Le risque est faible : binaire statique + pattern
  déjà utilisé pour Dolt/NATS.
- Temps de build CI du job mesuré au prochain run (build release frais ~2–4 min attendu).
- Les contre-exemples sortent en format Debug Rust brut ; un rendu lisible reste à écrire.
- Vocabulaire : le verdict compare les **décisions** (allow global) ; « plus large » =
  « autorise strictement plus de requêtes ».
- cvc5 en sous-processus : prévoir un timeout/annulation côté cœur si l'étape 6 l'embarque
  (un solveur peut toujours exploser sur des politiques pathologiques — non testé ici).
