<?php
declare(strict_types=1);

/*
 * Moteur de jeu de Skip-Bo — toute la logique et les règles côté serveur.
 * Une partie est un tableau PHP sérialisé en JSON dans data/games/<ID>.json.
 *
 * Paquet de 162 cartes : les nombres 1 à 12, douze fois chacun (144 cartes), et 18 cartes Skip-Bo
 * qui remplacent n'importe quel nombre.
 *   Carte : ['id' => '7-3', 'n' => 1…12] ou ['id' => 'SB4', 'n' => 0] pour une carte Skip-Bo
 *
 * Chaque joueur a une pile de départ (dont seule la carte du dessus est visible), une main de
 * 5 cartes et 4 défausses personnelles. Au centre, 4 piles de construction communes se montent
 * de 1 à 12 ; une pile terminée est mise de côté puis remélangée dans la pioche.
 * Un tour : compléter sa main à 5 cartes → jouer sur les piles centrales depuis sa main, sa pile
 * de départ ou ses défausses (on repioche 5 cartes si la main se vide) → défausser une carte.
 * Le premier qui vide sa pile de départ gagne la manche.
 */

const DATA_DIR = __DIR__ . '/../data/games';
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 6;
const HAND_SIZE = 5;
const PILES = 4;           // piles de construction, et défausses par joueur
const STOCK_SIZES = [0, 20, 10];   // 0 = règle officielle : 30 cartes, 20 à partir de 5 joueurs
const OFFLINE_KICK = 60;   // secondes d'absence avant de pouvoir retirer un joueur

class GameError extends RuntimeException {}

/* ---------- Cartes ---------- */

function card_name(array $c): string
{
    return $c['n'] === 0 ? 'une carte Skip-Bo' : 'le ' . $c['n'];
}

function new_deck(): array
{
    $deck = [];
    for ($n = 1; $n <= 12; $n++) {
        for ($k = 1; $k <= 12; $k++) $deck[] = ['id' => "$n-$k", 'n' => $n];
    }
    for ($i = 1; $i <= 18; $i++) $deck[] = ['id' => "SB$i", 'n' => 0];
    return shuffled($deck);
}

/** Mélange de Fisher-Yates avec un générateur cryptographique. */
function shuffled(array $cards): array
{
    for ($i = count($cards) - 1; $i > 0; $i--) {
        $j = random_int(0, $i);
        [$cards[$i], $cards[$j]] = [$cards[$j], $cards[$i]];
    }
    return $cards;
}

function last(array $a): ?array { return $a ? $a[count($a) - 1] : null; }

/** Nombre de cartes de la pile de départ pour $players joueurs. */
function stock_size(int $option, int $players): int
{
    return $option ?: ($players >= 5 ? 20 : 30);
}

/* ---------- Création / donne ---------- */

function new_player(string $name, string $token): array
{
    return ['name' => $name, 'token' => $token, 'hand' => [], 'stock' => [],
            'discards' => array_fill(0, PILES, []), 'score' => 0, 'wins' => 0, 'out' => false];
}

function new_game(string $id, string $name, string $token): array
{
    return [
        'id' => $id, 'v' => 1, 'created' => time(), 'status' => 'waiting',
        'players' => [new_player($name, $token)],
        'deck' => [], 'done' => [], 'build' => array_fill(0, PILES, []),
        'turn' => 0, 'starter' => null, 'round' => 0, 'stockOption' => 0, 'passes' => 0,
        'lastResult' => null, 'winners' => [], 'lastMove' => null,
        'events' => [], 'eventSeq' => 0, 'chat' => [], 'chatSeq' => 0,
    ];
}

function add_event(array &$g, string $text, string $kind = 'info', ?int $seat = null): void
{
    $g['events'][] = ['id' => ++$g['eventSeq'], 'text' => $text, 'kind' => $kind, 'seat' => $seat];
    $g['events'] = array_slice($g['events'], -30);
}

/** Sièges des joueurs encore en jeu (ceux qui n'ont pas quitté la partie). */
function active_seats(array $g): array
{
    return array_keys(array_filter($g['players'], fn($pl) => !$pl['out']));
}

/** Joueur suivant (dans le sens du jeu) parmi ceux encore en jeu. */
function next_active(array $g, int $from): int
{
    $n = count($g['players']);
    for ($k = 1; $k <= $n; $k++) {
        $s = ($from + $k) % $n;
        if (!$g['players'][$s]['out']) return $s;
    }
    return $from;
}

function deal(array &$g): void
{
    $deck = new_deck();
    $size = stock_size($g['stockOption'], count(active_seats($g)));
    foreach ($g['players'] as &$pl) {
        $pl['stock'] = $pl['out'] ? [] : array_splice($deck, 0, $size);
        $pl['hand'] = [];
        $pl['discards'] = array_fill(0, PILES, []);
        unset($pl);
    }
    $g['deck'] = $deck;
    $g['done'] = [];
    $g['build'] = array_fill(0, PILES, []);
    $g['passes'] = 0;
    $g['winners'] = [];
    $g['status'] = 'playing';
    $g['round']++;
    // Celui qui commence change à chaque manche
    $seats = active_seats($g);
    $g['starter'] = $g['starter'] === null ? $seats[random_int(0, count($seats) - 1)] : next_active($g, $g['starter']);
    $g['lastMove'] = null;
    add_event($g, "Manche {$g['round']} : $size cartes dans chaque pile de départ.", 'deal');
    start_turn($g, $g['starter']);
}

/** Pioche une carte ; si la pioche est vide, on y remélange les piles de construction terminées. */
function draw_card(array &$g): ?array
{
    if (!$g['deck'] && $g['done']) {
        $g['deck'] = shuffled($g['done']);
        $g['done'] = [];
        add_event($g, 'La pioche est épuisée : les piles terminées sont mélangées.', 'info');
    }
    return array_pop($g['deck']);
}

/** Complète la main du joueur à 5 cartes (moins s'il ne reste plus rien à piocher). */
function refill(array &$g, int $p): void
{
    while (count($g['players'][$p]['hand']) < HAND_SIZE && ($c = draw_card($g))) {
        $g['players'][$p]['hand'][] = $c;
    }
}

function start_turn(array &$g, int $p): void
{
    $g['turn'] = $p;
    refill($g, $p);
    add_event($g, 'Au tour de ' . $g['players'][$p]['name'] . '.', 'turn', $p);
}

/* ---------- Vérifications ---------- */

function require_turn(array $g, int $p): void
{
    if ($p < 0) throw new GameError('Vous êtes spectateur.');
    if ($g['status'] !== 'playing') throw new GameError("La manche n'est pas en cours.");
    if ($g['players'][$p]['out']) throw new GameError('Vous avez quitté la partie.');
    if ($g['turn'] !== $p) throw new GameError("Ce n'est pas votre tour.");
}

function check_pile(int $k): void
{
    if ($k < 0 || $k >= PILES) throw new GameError('Pile introuvable.');
}

/** Retire de la main du joueur la carte demandée et la renvoie. */
function take_from_hand(array &$g, int $p, string $id): array
{
    foreach ($g['players'][$p]['hand'] as $k => $c) {
        if ($c['id'] === $id) {
            array_splice($g['players'][$p]['hand'], $k, 1);
            return $c;
        }
    }
    throw new GameError("Cette carte n'est pas dans votre main.");
}

/* ---------- Actions ---------- */

function act_start(array &$g, int $p, int $stockOption): void
{
    if ($p !== 0) throw new GameError("Seul l'hôte peut lancer la partie.");
    if ($g['status'] !== 'waiting') throw new GameError('La partie a déjà commencé.');
    if (count($g['players']) < 2) throw new GameError('Il faut au moins 2 joueurs.');
    if (!in_array($stockOption, STOCK_SIZES, true)) throw new GameError('Taille de pile inconnue.');
    $g['stockOption'] = $stockOption;
    add_event($g, 'La partie commence avec ' . count($g['players']) . ' joueurs !', 'info');
    deal($g);
}

/**
 * Jouer une carte sur la pile de construction $to, depuis :
 *   'hand' (la carte $id de sa main), 'stock' (sa pile de départ) ou 'disc' (le dessus de sa défausse $pile).
 * La pile accepte la carte qui suit sa hauteur actuelle (1 sur une pile vide), ou une carte Skip-Bo.
 */
function act_play(array &$g, int $p, string $from, string $id, int $pile, int $to): void
{
    require_turn($g, $p);
    check_pile($to);
    $pl = &$g['players'][$p];
    $card = match ($from) {
        'hand' => (function () use ($pl, $id) {
            foreach ($pl['hand'] as $c) if ($c['id'] === $id) return $c;
            throw new GameError("Cette carte n'est pas dans votre main.");
        })(),
        'stock' => last($pl['stock']) ?? throw new GameError('Votre pile de départ est vide.'),
        'disc' => (function () use ($pl, $pile) {
            check_pile($pile);
            return last($pl['discards'][$pile]) ?? throw new GameError('Cette défausse est vide.');
        })(),
        default => throw new GameError('Origine inconnue.'),
    };
    $need = count($g['build'][$to]) + 1;
    if ($card['n'] !== 0 && $card['n'] !== $need) {
        throw new GameError('Coup impossible : cette pile attend ' . ($need === 1 ? 'un 1' : "le $need") . ', pas ' . card_name($card) . '.');
    }

    $src = match ($from) {
        'hand' => "hand:$p",
        'stock' => "stock:$p",
        'disc' => "disc:$p:$pile",
    };
    match ($from) {
        'hand' => take_from_hand($g, $p, $card['id']),
        'stock' => array_pop($pl['stock']),
        'disc' => array_pop($pl['discards'][$pile]),
    };
    $g['build'][$to][] = $card;
    $g['passes'] = 0;
    $g['lastMove'] = ['id' => $card['id'], 'from' => $src, 'to' => "build:$to", 'p' => $p];

    if (count($g['build'][$to]) === 12) {
        // Pile terminée : elle quitte la table et rejoindra la pioche quand celle-ci sera vide
        array_push($g['done'], ...$g['build'][$to]);
        $g['build'][$to] = [];
        $g['lastMove']['done'] = true;
        add_event($g, $pl['name'] . ' termine une pile !', 'done', $p);
    }

    if ($from === 'stock') {
        $left = count($pl['stock']);
        if ($left === 0) { unset($pl); win($g, $p); return; }
        if ($left === 3 || $left === 1) {
            add_event($g, $pl['name'] . ($left === 1 ? " n'a plus qu'une carte" : " n'a plus que 3 cartes") . ' dans sa pile !', 'warn', $p);
        }
    }
    if (!$pl['hand']) {
        refill($g, $p);
        if ($pl['hand']) add_event($g, $pl['name'] . ' a vidé sa main et repioche.', 'refill', $p);
    }
    unset($pl);
}

/** Défausser une carte de sa main sur une de ses 4 défausses, ce qui termine le tour. */
function act_discard(array &$g, int $p, string $id, int $pile): void
{
    require_turn($g, $p);
    check_pile($pile);
    $card = take_from_hand($g, $p, $id);
    $g['players'][$p]['discards'][$pile][] = $card;
    $g['lastMove'] = ['id' => $id, 'from' => "hand:$p", 'to' => "disc:$p:$pile", 'p' => $p];
    start_turn($g, next_active($g, $p));
}

/** Finir son tour sans défausser : seulement possible si la main est vide et la pioche épuisée. */
function act_pass(array &$g, int $p): void
{
    require_turn($g, $p);
    if ($g['players'][$p]['hand']) throw new GameError('Terminez votre tour en défaussant une carte.');
    add_event($g, $g['players'][$p]['name'] . ' n\'a plus de carte à défausser et passe.', 'info', $p);
    // Table bloquée (personne n'a pu jouer pendant un tour complet) : les piles centrales repartent dans la pioche
    if (++$g['passes'] >= count(active_seats($g))) {
        foreach ($g['build'] as $b) array_push($g['deck'], ...$b);
        $g['deck'] = shuffled($g['deck']);
        $g['build'] = array_fill(0, PILES, []);
        $g['passes'] = 0;
        add_event($g, 'Plus personne ne peut jouer : les piles centrales sont mélangées dans la pioche.', 'info');
    }
    start_turn($g, next_active($g, $p));
}

/** Le joueur $p a vidé sa pile de départ : il marque 25 points, plus 5 par carte restée dans les piles adverses. */
function win(array &$g, int $p): void
{
    $stocks = [];
    $points = 25;
    foreach ($g['players'] as $s => $pl) {
        if ($pl['out']) continue;
        $stocks[$s] = count($pl['stock']);
        $points += 5 * $stocks[$s];
    }
    $g['players'][$p]['score'] += $points;
    $g['players'][$p]['wins']++;
    $g['lastResult'] = ['round' => $g['round'], 'winner' => $p, 'points' => $points, 'stocks' => $stocks];
    finish($g, [$p]);
}

function finish(array &$g, array $winners): void
{
    $g['status'] = 'finished';
    $g['winners'] = $winners;
    if ($winners) add_event($g, $g['players'][$winners[0]]['name'] . ' gagne la manche !', 'win', $winners[0]);
}

function act_rematch(array &$g, int $p): void
{
    if ($p < 0 || $g['players'][$p]['out']) throw new GameError('Vous ne participez pas à cette partie.');
    if ($g['status'] !== 'finished') throw new GameError("La manche n'est pas terminée.");
    if (count(active_seats($g)) < 2) throw new GameError('Il faut au moins 2 joueurs pour rejouer.');
    add_event($g, $g['players'][$p]['name'] . ' relance une manche !', 'info', $p);
    deal($g);
}

/** Un joueur quitte la partie (ou en est retiré) : on continue sans lui, ses cartes sont écartées. */
function remove_player(array &$g, int $s, string $why): void
{
    if ($g['status'] === 'waiting') {
        array_splice($g['players'], $s, 1);
        add_event($g, $why, 'info');
        return;
    }
    $pl = &$g['players'][$s];
    $pl['out'] = true;
    $pl['hand'] = [];
    $pl['stock'] = [];
    $pl['discards'] = array_fill(0, PILES, []);
    unset($pl);
    add_event($g, $why, 'info');
    $left = active_seats($g);
    if (count($left) < 2) {
        if ($g['status'] !== 'finished') {
            $g['lastResult'] = null;
            finish($g, $left);
        }
    } elseif ($g['status'] === 'playing' && $g['turn'] === $s) {
        start_turn($g, next_active($g, $s));
    }
}

function act_leave(array &$g, int $p): void
{
    if ($p < 0 || $g['players'][$p]['out']) throw new GameError('Vous ne participez pas à cette partie.');
    if ($g['status'] === 'waiting' && $p === 0 && count($g['players']) > 1) {
        throw new GameError("L'hôte ne peut pas quitter une partie qui n'a pas commencé.");
    }
    remove_player($g, $p, $g['players'][$p]['name'] . ' quitte la partie.');
}

/** Retirer un joueur absent depuis un moment, pour ne pas bloquer la table. */
function act_kick(array &$g, int $p, int $target): void
{
    if ($p < 0 || $g['players'][$p]['out']) throw new GameError('Vous ne participez pas à cette partie.');
    if ($target === $p || !isset($g['players'][$target]) || $g['players'][$target]['out']) throw new GameError('Joueur introuvable.');
    if ($g['status'] === 'waiting') throw new GameError("La partie n'a pas commencé.");
    if (seconds_offline($g, $target) < OFFLINE_KICK) {
        throw new GameError($g['players'][$target]['name'] . " est toujours là : patientez un peu.");
    }
    remove_player($g, $target, $g['players'][$target]['name'] . ' est absent et a été retiré de la partie.');
}

function act_chat(array &$g, int $p, string $text): void
{
    if ($p < 0) throw new GameError('Les spectateurs ne peuvent pas écrire.');
    $text = trim(preg_replace('/\s+/u', ' ', $text) ?? '');
    if ($text === '') return;
    $g['chat'][] = ['id' => ++$g['chatSeq'], 'p' => $p, 'text' => mb_substr($text, 0, 200)];
    $g['chat'] = array_slice($g['chat'], -60);
}

/* ---------- Vue envoyée au client (sans informations cachées) ---------- */

function public_view(array $g, int $seat): array
{
    $players = [];
    foreach ($g['players'] as $pl) {
        $players[] = [
            'name' => $pl['name'], 'cards' => count($pl['hand']),
            'stock' => count($pl['stock']), 'stockTop' => last($pl['stock']),
            'discards' => $pl['discards'], 'score' => $pl['score'], 'wins' => $pl['wins'], 'out' => $pl['out'],
        ];
    }
    return [
        'id' => $g['id'], 'v' => $g['v'], 'seat' => $seat, 'status' => $g['status'],
        'players' => $players, 'hand' => $seat >= 0 ? $g['players'][$seat]['hand'] : [],
        'turn' => $g['turn'], 'round' => $g['round'],
        'deck' => count($g['deck']), 'done' => count($g['done']),
        'build' => array_map(fn($b) => ['n' => count($b), 'top' => last($b)], $g['build']),
        'stockOption' => $g['stockOption'], 'lastResult' => $g['lastResult'], 'winners' => $g['winners'],
        'lastMove' => $g['lastMove'], 'events' => $g['events'], 'chat' => $g['chat'],
        'online' => presence($g),
    ];
}

/* ---------- Stockage fichier ---------- */

function valid_id(string $id): bool { return (bool)preg_match('/^[A-Z2-9]{6}$/', $id); }
function game_path(string $id): string { return DATA_DIR . "/$id.json"; }

function ensure_data_dir(): void
{
    if (!is_dir(DATA_DIR) && !mkdir(DATA_DIR, 0775, true) && !is_dir(DATA_DIR)) {
        throw new GameError('Impossible de créer le dossier de données.');
    }
}

function new_game_id(): string
{
    do {
        $id = '';
        for ($i = 0; $i < 6; $i++) $id .= ID_CHARS[random_int(0, strlen(ID_CHARS) - 1)];
    } while (file_exists(game_path($id)));
    return $id;
}

function game_save_new(array $g): void
{
    $fh = fopen(game_path($g['id']), 'x');
    if (!$fh) throw new GameError('Impossible de créer la partie.');
    fwrite($fh, json_encode($g, JSON_UNESCAPED_UNICODE));
    fclose($fh);
}

function game_read(string $id): array
{
    if (!valid_id($id) || !is_file(game_path($id))) throw new GameError('Partie introuvable.');
    $fh = fopen(game_path($id), 'r');
    flock($fh, LOCK_SH);
    $g = json_decode(stream_get_contents($fh), true);
    flock($fh, LOCK_UN);
    fclose($fh);
    if (!is_array($g)) throw new GameError('Partie illisible.');
    return $g;
}

/** Lit, modifie via $fn(&$g) et réécrit la partie sous verrou exclusif. */
function game_update(string $id, callable $fn): array
{
    if (!valid_id($id) || !is_file(game_path($id))) throw new GameError('Partie introuvable.');
    $fh = fopen(game_path($id), 'r+');
    flock($fh, LOCK_EX);
    try {
        $g = json_decode(stream_get_contents($fh), true);
        if (!is_array($g)) throw new GameError('Partie illisible.');
        $fn($g);
        $g['v']++;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, json_encode($g, JSON_UNESCAPED_UNICODE));
        fflush($fh);
        return $g;
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

function seat_of(array $g, string $token): int
{
    if ($token === '') return -1;
    foreach ($g['players'] as $i => $pl) {
        if (hash_equals($pl['token'], $token)) return $i;
    }
    return -1;
}

/* Présence : un fichier par joueur, touché à chaque requête (nommé par jeton, stable si les sièges bougent). */

function presence_file(string $id, string $token): string { return DATA_DIR . "/$id." . substr(hash('sha256', $token), 0, 12) . '.p'; }

function touch_presence(array $g, int $seat): void
{
    if ($seat >= 0) @touch(presence_file($g['id'], $g['players'][$seat]['token']));
}

function seconds_offline(array $g, int $seat): int
{
    $f = presence_file($g['id'], $g['players'][$seat]['token']);
    clearstatcache();
    return is_file($f) ? time() - filemtime($f) : PHP_INT_MAX;
}

function presence(array $g): array
{
    clearstatcache();
    return array_map(function ($pl) use ($g) {
        $f = presence_file($g['id'], $pl['token']);
        return is_file($f) && filemtime($f) > time() - 8;
    }, $g['players']);
}

/** Supprime les parties inactives depuis plus de 3 jours. */
function cleanup_old_games(): void
{
    foreach (glob(DATA_DIR . '/*') ?: [] as $f) {
        if (basename($f) !== '.htaccess' && filemtime($f) < time() - 3 * 86400) @unlink($f);
    }
}
