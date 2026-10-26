<?php
declare(strict_types=1);
// Sans « / » final (…/SkipBo), les chemins relatifs (assets/, api.php) pointeraient vers le dossier parent
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
<meta name="theme-color" content="#3a0f1b">
<title>Skip-Bo — jeu de cartes en ligne de 2 à 6 joueurs</title>
<meta name="description" content="Jouez au Skip-Bo en ligne avec vos amis : créez une partie et partagez le lien.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='14' y='6' width='72' height='88' rx='10' fill='%23fffdf7' stroke='%23e6c475' stroke-width='4'/><text x='50' y='68' font-size='46' font-weight='900' font-family='sans-serif' text-anchor='middle' fill='%23d23440'>12</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Playfair+Display:ital,wght@0,700;0,800;1,700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="<?= $asset('style.css') ?>">
</head>
<body data-game="<?= htmlspecialchars($gameId) ?>">

<!-- ============ ACCUEIL ============ -->
<div id="lobby" class="lobby" hidden>
  <div class="lobby-card">
    <div class="lobby-deco" aria-hidden="true">
      <span class="mini-card r1">1</span>
      <span class="mini-card r2">5</span>
      <span class="mini-card r3">9</span>
      <span class="mini-card wild">SB</span>
    </div>
    <h1 class="logo">Skip<span>-Bo</span></h1>
    <p class="tagline">Montez les piles de 1 à 12 et videz votre pile avant tout le monde. De 2 à 6 joueurs, en ligne.</p>

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
    <a class="brand" href="./" title="Accueil">Skip<span>-Bo</span></a>
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
        <a href="./">Retour à l'accueil</a>
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
    <div class="stock-choice" id="stockChoice">
      <label for="stockSelect">Pile de départ</label>
      <select id="stockSelect">
        <option value="0">Normale : 30 cartes (20 à 5-6)</option>
        <option value="20">Moyenne : 20 cartes</option>
        <option value="10">Courte : 10 cartes</option>
      </select>
    </div>
    <button class="btn btn-gold btn-lg" id="startBtn">Lancer la partie</button>
    <p class="muted small" id="waitHint"></p>
  </div>
</div>

<div class="modal" id="oppModal" hidden data-dismiss>
  <div class="modal-box center opp-box">
    <button class="icon-btn sm close" data-close aria-label="Fermer">✕</button>
    <h2 id="oppTitle"></h2>
    <p class="muted" id="oppText"></p>
    <div class="opp-detail" id="oppDetail"></div>
    <button class="link-btn" type="button" data-close>Fermer</button>
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

<div class="modal" id="rulesModal" hidden data-dismiss>
  <div class="modal-box rules">
    <button class="icon-btn sm close" data-close aria-label="Fermer">✕</button>
    <h2>Règles du Skip-Bo</h2>
    <p>On joue avec <strong>162 cartes</strong> : les nombres de <strong>1 à 12</strong>, douze fois chacun, et 18 cartes <strong>Skip-Bo</strong> qui remplacent n'importe quel nombre. Le but : être le premier à <strong>vider sa pile de départ</strong>.</p>
    <h3>Mise en place</h3>
    <ul>
      <li>Chacun reçoit une <strong>pile de départ</strong> de 30 cartes (20 à 5 ou 6 joueurs), face cachée : seule la carte du dessus est retournée. L'hôte peut choisir une partie plus courte.</li>
      <li>Au centre, il y a la pioche et la place pour <strong>4 piles de construction</strong>, communes à tous.</li>
      <li>Devant soi, chacun dispose de <strong>4 défausses</strong>, vides au départ.</li>
    </ul>
    <h3>Déroulement d'un tour</h3>
    <ul>
      <li>Au début de son tour, on complète automatiquement sa <strong>main à 5 cartes</strong>.</li>
      <li>On joue autant de cartes qu'on veut sur les piles centrales, depuis sa <strong>main</strong>, le dessus de sa <strong>pile de départ</strong> ou le dessus de ses <strong>défausses</strong>.</li>
      <li>Une pile centrale commence par un <strong>1</strong> (ou une Skip-Bo) et monte d'un en un : 1, 2, 3… jusqu'à <strong>12</strong>. Une carte Skip-Bo prend la valeur qui manque. Une pile qui atteint 12 est retirée, et ses cartes seront remélangées dans la pioche quand elle sera vide.</li>
      <li>Si l'on vide sa main pendant son tour, on repioche <strong>5 cartes</strong> et on continue.</li>
      <li>Le tour se termine quand on pose une carte de sa main sur l'une de ses <strong>défausses</strong>. On peut empiler n'importe quelle carte sur une défausse, mais seule celle du dessus pourra être rejouée.</li>
    </ul>
    <h3>Fin de manche et score</h3>
    <ul>
      <li>Le premier joueur qui pose la dernière carte de sa pile de départ gagne la manche.</li>
      <li>Il marque <strong>25 points</strong>, plus <strong>5 points</strong> par carte restée dans les piles de départ de ses adversaires. Le tableau des scores cumule les manches.</li>
      <li>Si plus personne ne peut jouer pendant un tour complet (pioche vide), les piles centrales sont remélangées dans la pioche.</li>
    </ul>
    <h3>Commandes</h3>
    <ul>
      <li>Touchez une carte (main, pile de départ ou défausse), puis la pile où la poser. Vous pouvez aussi la faire glisser. Un double-clic sur une carte la joue sur la première pile centrale qui l'accepte.</li>
      <li>Sous chaque pile centrale s'affiche la carte attendue.</li>
      <li>Touchez un adversaire pour voir toutes ses défausses. Un joueur absent depuis plus d'une minute peut être retiré de la partie de la même façon, pour ne pas bloquer la table.</li>
    </ul>
  </div>
</div>

<script src="<?= $asset('app.js') ?>"></script>
</body>
</html>
