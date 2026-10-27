<?php
declare(strict_types=1);
// Sans « / » final (…/Uno), les chemins relatifs (assets/, api.php) pointeraient vers le dossier parent
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (!str_ends_with($path, '/') && !str_ends_with($path, '.php')) {
    $query = $_SERVER['QUERY_STRING'] ?? '';
    header('Location: ' . $path . '/' . ($query !== '' ? "?$query" : ''), true, 301);
    exit;
}
$gameId = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string)($_GET['g'] ?? '')));
$asset = fn(string $f) => "assets/$f?v=" . filemtime(__DIR__ . "/assets/$f");
?><!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#5a0c14">
<title>Uno — jeu de cartes en ligne de 2 à 6 joueurs</title>
<meta name="description" content="Jouez à Uno en ligne avec vos amis : même couleur ou même nombre, videz votre main le premier.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='14' y='6' width='72' height='88' rx='10' fill='%23c42430' stroke='%23e6c475' stroke-width='5'/><text x='50' y='70' font-size='52' font-weight='900' font-family='sans-serif' text-anchor='middle' fill='%23f6dc98'>7</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Playfair+Display:ital,wght@0,700;0,800;1,700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="<?= $asset('style.css') ?>">
</head>
<body data-game="<?= htmlspecialchars($gameId) ?>">

<!-- ============ ACCUEIL ============ -->
<div id="lobby" class="lobby" hidden>
  <a class="site-link" href="../">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>Tous les jeux
  </a>
  <div class="lobby-card">
    <div class="lobby-deco" aria-hidden="true">
      <span class="mini-card" style="--cc: var(--c-r)">3<i>●</i></span>
      <span class="mini-card" style="--cc: var(--c-b)">3<i>■</i></span>
      <span class="mini-card" style="--cc: var(--c-v)">8<i>▲</i></span>
      <span class="mini-card wild">+4<b><em>+4</em></b></span>
    </div>
    <h1 class="logo">Uno</h1>
    <p class="tagline">Même couleur ou même nombre : videz votre main avant tout le monde. De 2 à 6 joueurs, en ligne.</p>

    <form id="createForm" class="lobby-form">
      <label for="nameInput">Votre pseudo</label>
      <input id="nameInput" name="name" maxlength="20" autocomplete="nickname" placeholder="Ex. : Tante Huguette" required>
      <button class="btn btn-gold btn-lg" type="submit">Créer une partie</button>
    </form>

    <div class="sep"><span>ou rejoindre avec un code</span></div>

    <form id="joinCodeForm" class="join-row">
      <input id="codeInput" maxlength="6" placeholder="CODE" autocomplete="off" spellcheck="false" aria-label="Code de la partie">
      <button class="btn btn-ghost" type="submit">Rejoindre</button>
    </form>

    <button class="link-btn" type="button" data-open="rulesModal">Comment jouer ?</button>
  </div>
</div>

<!-- ============ PARTIE ============ -->
<div id="app" class="app" hidden>
  <header class="topbar">
    <a class="brand" href="./" title="Accueil">Uno</a>
    <div class="status-pill" id="statusPill"></div>
    <div class="top-actions">
      <button class="icon-btn" id="scoresBtn" title="Scores" aria-label="Scores">
        <svg viewBox="0 0 24 24"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>
      </button>
      <button class="icon-btn" id="shareBtn" title="Inviter des amis" aria-label="Inviter des amis">
        <svg viewBox="0 0 24 24"><path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>
      </button>
      <button class="icon-btn" id="chatBtn" title="Discussion" aria-label="Discussion">
        <svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>
        <span class="badge" id="chatBadge" hidden></span>
      </button>
      <button class="icon-btn" id="soundBtn" title="Son" aria-label="Activer/couper le son">
        <svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path class="wave" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/><path class="mute" d="m16 9 6 6m0-6-6 6"/></svg>
      </button>
      <button class="icon-btn" data-open="rulesModal" title="Règles" aria-label="Règles">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/></svg>
      </button>
      <button class="icon-btn" id="menuBtn" title="Menu" aria-label="Menu">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>
      </button>
      <div class="menu" id="menu" hidden>
        <button id="leaveBtn">Quitter la partie</button>
        <a href="./">Accueil de Uno</a>
        <a href="../">Tous les jeux</a>
      </div>
    </div>
  </header>

  <main id="table" class="table">
    <section class="opps" id="opps"></section>
    <section class="center" id="center"></section>
    <section class="mine" id="mine"></section>
  </main>

  <div id="toasts" class="toasts" aria-live="polite"></div>

  <aside id="chat" class="chat" hidden>
    <div class="chat-head"><strong>Discussion</strong><button class="icon-btn sm" id="chatClose" aria-label="Fermer">✕</button></div>
    <div class="chat-log" id="chatLog"></div>
    <form class="chat-form" id="chatForm">
      <input id="chatInput" maxlength="200" placeholder="Votre message…" autocomplete="off">
      <button class="btn btn-gold" type="submit">Envoyer</button>
    </form>
  </aside>
</div>

<!-- ============ FENÊTRES ============ -->
<div class="modal" id="joinModal" hidden>
  <form class="modal-box" id="joinForm">
    <h2>Rejoindre la partie</h2>
    <p class="muted" id="joinInfo"></p>
    <label for="joinName">Votre pseudo</label>
    <input id="joinName" maxlength="20" autocomplete="nickname" required>
    <button class="btn btn-gold btn-lg" type="submit">S'asseoir à la table</button>
    <button class="link-btn" type="button" id="watchBtn">Regarder seulement</button>
  </form>
</div>

<div class="modal" id="waitModal" hidden>
  <div class="modal-box center">
    <div class="spinner-cards" aria-hidden="true"><span></span><span></span><span></span></div>
    <h2>La table se remplit</h2>
    <ul class="seat-list" id="seatList"></ul>
    <p class="muted">Envoyez ce lien aux personnes avec qui vous voulez jouer (jusqu'à 6) :</p>
    <div class="share-box">
      <input id="shareLink" readonly>
      <button class="btn btn-gold" id="copyLink">Copier</button>
    </div>
    <p class="muted small">Code de la partie : <strong class="code" id="shareCode"></strong></p>
    <button class="btn btn-gold btn-lg" id="startBtn">Lancer la partie</button>
    <p class="muted small" id="waitHint"></p>
  </div>
</div>

<div class="modal" id="scoreModal" hidden data-dismiss>
  <div class="modal-box center score-box">
    <button class="icon-btn sm close" data-close aria-label="Fermer">✕</button>
    <div class="trophy" id="scoreIcon"></div>
    <h2 id="scoreTitle"></h2>
    <p class="muted" id="scoreText"></p>
    <table class="score-table" id="scoreTable"></table>
    <button class="btn btn-gold btn-lg" id="nextBtn">Nouvelle manche</button>
    <button class="link-btn" type="button" data-close>Voir la table</button>
  </div>
</div>

<div class="modal" id="colorModal" hidden data-dismiss>
  <div class="modal-box center color-box">
    <h2>Quelle couleur ?</h2>
    <p class="muted">Le joueur suivant devra jouer cette couleur (ou un Joker).</p>
    <div class="color-pick">
      <button type="button" class="c-r" data-color="r"><i>●</i>Rouge</button>
      <button type="button" class="c-b" data-color="b"><i>■</i>Bleu</button>
      <button type="button" class="c-v" data-color="v"><i>▲</i>Vert</button>
      <button type="button" class="c-j" data-color="j"><i>◆</i>Jaune</button>
    </div>
    <button class="link-btn" type="button" data-close>Annuler</button>
  </div>
</div>

<div class="modal" id="rulesModal" hidden data-dismiss>
  <div class="modal-box rules">
    <button class="icon-btn sm close" data-close aria-label="Fermer">✕</button>
    <h2>Règles de Uno</h2>
    <p>On joue avec <strong>104 cartes</strong>. Quatre couleurs (rouge&nbsp;●, bleu&nbsp;■, vert&nbsp;▲ et jaune&nbsp;◆) avec, dans chaque couleur, les nombres de <strong>1 à 9</strong> deux fois chacun, et deux cartes de chaque sorte spéciale : <strong>Passe</strong>, <strong>Inversion</strong> et <strong>+2</strong>. S'y ajoutent 4 <strong>Jokers</strong> et 4 <strong>Jokers +4</strong>, sans couleur. Le but : être le premier à <strong>poser toutes ses cartes</strong>.</p>
    <h3>Mise en place</h3>
    <ul>
      <li>Chacun reçoit <strong>7 cartes</strong>. Le reste forme la pioche, et sa première carte numérotée est retournée pour commencer la défausse.</li>
    </ul>
    <h3>Déroulement d'un tour</h3>
    <ul>
      <li>On pose <strong>une carte</strong> sur la défausse : elle doit être de la <strong>même couleur</strong>, du <strong>même nombre</strong> ou du <strong>même symbole</strong> que la carte du dessus. Un 5 bleu se pose sur n'importe quel bleu ou sur n'importe quel 5 ; un +2 vert sur n'importe quel vert ou sur un autre +2.</li>
      <li>Un <strong>Joker</strong> se pose sur n'importe quelle carte.</li>
      <li>On ne peut pas <strong>terminer sur une carte noire</strong> : si votre dernière carte est un Joker ou un Joker +4, vous devez piocher.</li>
      <li>Si l'on ne peut pas (ou ne veut pas) poser, on <strong>pioche une carte</strong>. On peut alors la poser si elle convient, ou la garder : le tour passe au joueur suivant.</li>
      <li>Quand la pioche est vide, la défausse est mélangée pour la reformer (sauf sa carte du dessus).</li>
    </ul>
    <h3>Cartes spéciales</h3>
    <ul>
      <li><strong>⊘ Passe</strong> : le joueur suivant passe son tour.</li>
      <li><strong>⇄ Inversion</strong> : le sens du jeu change (la flèche entre la pioche et la défausse l'indique). À deux joueurs, on rejoue aussitôt.</li>
      <li><strong>+2</strong> : le joueur suivant doit poser à son tour un <strong>+2</strong> (de n'importe quelle couleur) : la pénalité s'ajoute et passe au joueur d'après (+4, +6…). S'il n'en pose pas, il pioche toutes les cartes accumulées et passe son tour.</li>
      <li><strong>★ Joker</strong> : on choisit la couleur que le joueur suivant devra jouer.</li>
      <li><strong>+4 Joker +4</strong> : on choisit la couleur, et le joueur suivant pioche 4 cartes et passe son tour.</li>
      <li>Seuls les +2 se cumulent : on ne peut pas renvoyer un Joker +4.</li>
    </ul>
    <h3>Annonce « Uno ! »</h3>
    <ul>
      <li>Quand il ne vous reste plus qu'<strong>une carte</strong>, vous devez annoncer <strong>« Uno ! »</strong> avec le bouton prévu. Vous pouvez le faire pendant votre tour avant de poser votre avant-dernière carte, ou juste après.</li>
      <li>Si un adversaire vous attrape en appuyant sur « Uno ! » avant votre annonce (après un délai de 3 secondes), vous <strong>piochez 2 cartes</strong> de pénalité.</li>
      <li>Appuyer sur le bouton quand il n'y a rien à annoncer ni personne à attraper ne fait rien.</li>
    </ul>
    <h3>Fin de manche et score</h3>
    <ul>
      <li>Le premier qui pose sa <strong>dernière carte</strong> gagne la manche.</li>
      <li>Il marque la <strong>valeur des cartes</strong> restées dans les mains de ses adversaires (un nombre vaut sa valeur, une Passe, une Inversion ou un +2 vaut 10 points, un Joker 20 points). Le tableau des scores cumule les manches.</li>
      <li>Si plus rien ne peut être pioché et que personne ne peut jouer pendant un tour complet, la manche s'arrête : la main la plus légère l'emporte.</li>
    </ul>
    <h3>Commandes</h3>
    <ul>
      <li>Touchez une carte de votre main pour la poser, ou la pioche pour piocher.</li>
      <li>Après une pioche, touchez la carte piochée (mise en évidence) pour la poser, ou « Garder » pour finir votre tour.</li>
      <li>Un joueur absent depuis plus d'une minute peut être retiré de la partie en touchant son nom, pour ne pas bloquer la table.</li>
    </ul>
  </div>
</div>

<script src="<?= $asset('app.js') ?>"></script>
</body>
</html>
