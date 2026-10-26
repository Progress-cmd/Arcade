# Skip-Bo en ligne

Jeu de Skip-Bo de 2 à 6 joueurs, en PHP simple, sans base de données.
Règles standard : 162 cartes (les nombres 1 à 12, douze fois chacun, et 18 cartes Skip-Bo), une pile de départ de 30 cartes (20 à 5 ou 6 joueurs ; l'hôte peut choisir 20 ou 10 pour une partie plus courte), 4 piles de construction communes de 1 à 12, 4 défausses par joueur, une main de 5 cartes. Le premier qui vide sa pile de départ gagne la manche et marque 25 points, plus 5 par carte restée dans les piles adverses.

## Installation

- PHP 8.1 ou plus récent, sans extension particulière (`mbstring` conseillée).
- Copier le dossier sur l'hébergement. Le dossier `data/games/` doit être accessible en écriture par PHP.
- Test en local : `php -S localhost:8000` dans ce dossier puis ouvrir http://localhost:8000 (ou depuis le dossier parent, puis http://localhost:8000/SkipBo/). Ne pas passer `index.php` en argument : il servirait de routeur pour toutes les requêtes.

## Comment ça marche

- `index.php` : accueil et table de jeu.
- `api.php` : API JSON (créer, rejoindre, lancer, jouer, défausser, passer, rejouer…).
- `lib/game.php` : moteur et règles, côté serveur, qui valide chaque coup.
- `assets/` : interface (CSS et JS, sans dépendance). On joue en touchant une carte puis sa destination, ou par glisser-déposer ; un double-toucher envoie la carte sur la meilleure pile centrale.
- Les parties sont stockées dans `data/games/<CODE>.json`, avec verrouillage de fichier. Elles sont supprimées après 3 jours d'inactivité.
- Le créateur de la partie (l'hôte) la lance quand au moins 2 joueurs sont assis. Les visiteurs suivants regardent en spectateurs.
- Les joueurs se synchronisent en interrogeant le serveur environ toutes les secondes. Chaque joueur est identifié par un jeton stocké dans son navigateur.
- Un joueur absent depuis plus d'une minute peut être retiré de la partie par les autres (en touchant son nom), pour ne pas bloquer la table.
- Si la pioche est vide et que plus personne ne peut jouer pendant un tour complet, les piles centrales sont remélangées dans la pioche (cas rare, surtout à 6 joueurs).

Les dossiers `data/` et `lib/` contiennent un `.htaccess` qui en interdit l'accès direct sous Apache. Sous Nginx, ajoutez une règle `deny all` équivalente.
