# Phase 10 en ligne

Jeu de Phase 10 de 2 à 6 joueurs, en PHP simple, sans base de données.
Règles standard : 108 cartes (1 à 12 en quatre couleurs, en double, 8 Jokers, 4 cartes Passe), 10 cartes par joueur, les 10 phases dans l'ordre. Le premier à réussir la phase 10 gagne ; en cas d'égalité, le plus petit score l'emporte.

## Installation

- PHP 8.1 ou plus récent, sans extension particulière (`mbstring` conseillée).
- Copier le dossier sur l'hébergement. Le dossier `data/games/` doit être accessible en écriture par PHP.
- Test en local : `php -S localhost:8000` puis ouvrir http://localhost:8000

## Comment ça marche

- `index.php` : accueil et table de jeu.
- `api.php` : API JSON (créer, rejoindre, lancer, piocher, poser, compléter, défausser…).
- `lib/game.php` : moteur et règles, côté serveur, qui valide chaque coup.
- `assets/` : interface (CSS et JS, sans dépendance).
- Les parties sont stockées dans `data/games/<CODE>.json`, avec verrouillage de fichier. Elles sont supprimées après 3 jours d'inactivité.
- Le créateur de la partie (l'hôte) la lance quand au moins 2 joueurs sont assis. Les visiteurs suivants regardent en spectateurs.
- Les joueurs se synchronisent en interrogeant le serveur environ toutes les secondes. Chaque joueur est identifié par un jeton stocké dans son navigateur.
- Un joueur absent depuis plus d'une minute peut être retiré de la partie par les autres (en touchant son nom), pour ne pas bloquer la table.

Les dossiers `data/` et `lib/` contiennent un `.htaccess` qui en interdit l'accès direct sous Apache. Sous Nginx, ajoutez une règle `deny all` équivalente.
