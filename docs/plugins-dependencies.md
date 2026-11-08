# Dépendances des plugins (étape 4)

**Règle : un plugin possède ses dépendances.** Son dossier porte tout son code ET la déclaration de
chaque paquet externe que ce code importe, dans son propre `plugins/<id>/package.json`. Le code du
plugin ancre son `createRequire` sur ce fichier — jamais sur le `package.json` de l'API.

## Mécanisme

- La résolution Node part du dossier du plugin et remonte : `plugins/<id>/node_modules`, puis
  `node_modules` **à la racine du dépôt**, où vit l'installation partagée contrôlée.
- `scripts/plugin-deps.mjs` génère le `package.json` racine comme l'union exacte des déclarations des
  plugins (rien d'autre ne s'installe là) ; `--check` vérifie en CI que déclarations, imports réels du
  code et paquet racine sont d'accord, et que tout est installé.
- Le `package.json` du plugin est couvert par sa signature Ed25519 : la déclaration de dépendances
  d'un plugin signé ne peut pas dériver de son code signé sans être détectée.
- Les specs qui déplacent les plugins dans un dossier temporaire reproduisent la mise en page en
  symlinkant le `node_modules` racine à côté du dossier copié.

## Limite assumée du POC

Une seule version partagée par paquet pour tous les plugins (l'installation contrôlée est commune, à
la racine) : pas encore d'isolation de version par plugin. Deux plugins exigeant des versions
incompatibles du même paquet sont refusés par `--check`. L'installation par plugin
(`plugins/<id>/node_modules`) reste possible plus tard sans changer le contrat : la résolution la
trouve avant l'installation partagée.

## Importer un plugin tiers

L'archive importée doit contenir son `package.json` déclaré ; la validation refuse le code qui
importe un paquet non déclaré. L'administrateur installe ensuite la dépendance via
`scripts/plugin-deps.mjs` + `npm install` à la racine (étape contrôlée, jamais automatique au
téléversement).
