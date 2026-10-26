# Crapette en ligne

Jeu de Crapette à deux joueurs, en PHP simple, sans base de données.
Variante jouée : un jeu de tarot complet (78 cartes, atouts et Excuse) partagé, sans tas « crapette ». Chaque joueur a une pioche de 35 cartes et une défausse, avec 8 maisons (cartes face cachée au départ, une retournée au début de chaque tour) et sans fondations.

## Installation

- PHP 8.1 ou plus récent, sans extension particulière (`mbstring` conseillée).
- Copier le dossier sur l'hébergement. Le dossier `data/games/` doit être accessible en écriture par PHP.
- Test en local : `php -S localhost:8000` puis ouvrir http://localhost:8000

## Comment ça marche

- `index.php` : accueil et table de jeu.
- `api.php` : API JSON (créer, rejoindre, jouer…).
- `lib/game.php` : moteur et règles, côté serveur, qui valide chaque coup.
- `assets/` : interface (CSS et JS, sans dépendance).
- Les parties sont stockées dans `data/games/<CODE>.json`, avec verrouillage de fichier. Elles sont supprimées après 3 jours d'inactivité.
- Les joueurs se synchronisent en interrogeant le serveur environ toutes les secondes.
- Chaque joueur est identifié par un jeton stocké dans son navigateur. Un 3ᵉ visiteur peut regarder la partie en spectateur.

Les dossiers `data/` et `lib/` contiennent un `.htaccess` qui en interdit l'accès direct sous Apache. Sous Nginx, ajoutez une règle `deny all` équivalente.
