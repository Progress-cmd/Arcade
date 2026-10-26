<?php
declare(strict_types=1);

/*
 * Moteur de jeu de la Crapette — toute la logique et les règles côté serveur.
 * Une partie est un tableau PHP sérialisé en JSON dans data/games/<ID>.json.
 *
 * Variante jouée : un seul jeu de tarot (78 cartes) partagé, sans tas « crapette ».
 *   - 4 enseignes de 14 cartes : As, 2…10, Valet, Cavalier, Dame, Roi (rangs 1 à 14)
 *   - 21 atouts (enseigne « T », rangs 1 à 21) et l'Excuse (enseigne « E », joker)
 * Chaque joueur a sa pioche (talon) et sa défausse ; 8 maisons, pas de fondations :
 * les cartes ne se posent que sur les maisons ou sur la défausse adverse.
 * Les 8 cartes des maisons sont distribuées face cachée ($g['hidden']) : au début de
 * chaque tour, le joueur doit en retourner une ($g['mustFlip']) tant qu'il en reste.
 * Une maison cachée est bloquée : on ne la déplace pas et on ne pose rien dessus.
 *
 * Emplacements (« loc ») : type:index
 *   stock:p  talon du joueur p        waste:p  défausse du joueur p
 *   hand:p   carte retournée du joueur p
 *   tab:i    maison i (0-7)
 */

const DATA_DIR = __DIR__ . '/../data/games';
const SUIT_SYM = ['S' => '♠', 'H' => '♥', 'D' => '♦', 'C' => '♣'];
const RANK_LBL = [1 => 'A', 11 => 'V', 12 => 'C', 13 => 'D', 14 => 'R'];
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const N_TAB = 8;
const CRAPETTE_PENALTY = 1;   // cartes données au fautif quand la crapette est justifiée

class GameError extends RuntimeException {}

/* ---------- Cartes ---------- */

function rank_label(int $r): string { return RANK_LBL[$r] ?? (string)$r; }

function card_name(array $c): string
{
    return match ($c['s']) {
        'T' => "l'atout {$c['r']}",
        'E' => "l'Excuse",
        default => 'le ' . rank_label($c['r']) . SUIT_SYM[$c['s']],
    };
}

function is_red(array $c): bool { return $c['s'] === 'H' || $c['s'] === 'D'; }

function new_deck(): array
{
    $deck = [];
    foreach (['S', 'H', 'D', 'C'] as $s) {
        for ($r = 1; $r <= 14; $r++) $deck[] = ['id' => $s . $r, 's' => $s, 'r' => $r];
    }
    for ($r = 1; $r <= 21; $r++) $deck[] = ['id' => 'T' . $r, 's' => 'T', 'r' => $r];
    $deck[] = ['id' => 'E0', 's' => 'E', 'r' => 0];
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

/* ---------- Création / donne ---------- */

function new_player(string $name, string $token): array
{
    return ['name' => $name, 'token' => $token, 'stock' => [], 'waste' => [],
            'hand' => null, 'falseCall' => false];
}

function new_game(string $id, string $name, string $token): array
{
    return [
        'id' => $id, 'v' => 1, 'created' => time(), 'status' => 'waiting',
        'players' => [new_player($name, $token), null],
        'tableau' => array_fill(0, N_TAB, []), 'removed' => 0, 'hidden' => array_fill(0, N_TAB, false), 'mustFlip' => false,
        'turn' => random_int(0, 1), 'fault' => null, 'callable' => null, 'winner' => null,
        'scores' => [0, 0], 'rematch' => [false, false], 'round' => 0, 'lastMove' => null,
        'events' => [], 'eventSeq' => 0, 'chat' => [], 'chatSeq' => 0,
    ];
}

function deal(array &$g): void
{
    $g['tableau'] = array_fill(0, N_TAB, []);
    $deck = new_deck();
    for ($i = 0; $i < N_TAB; $i++) {
        $g['tableau'][$i][] = array_pop($deck);
    }
    // Les 70 cartes restantes sont partagées : 35 dans le talon de chacun
    $half = intdiv(count($deck), 2);
    foreach ([0, 1] as $p) {
        $pl = &$g['players'][$p];
        $pl['stock'] = array_splice($deck, 0, $half);
        $pl['waste'] = [];
        $pl['hand'] = null;
        $pl['falseCall'] = false;
        unset($pl);
    }
    // Les joueurs commencent chacun leur tour d'une manche à l'autre
    if ($g['round'] > 0) $g['turn'] = 1 - $g['turn'];
    $g['status'] = 'playing';
    $g['fault'] = null;
    $g['callable'] = null;
    $g['winner'] = null;
    $g['rematch'] = [false, false];
    $g['lastMove'] = null;
    $g['removed'] = 0;
    $g['hidden'] = array_fill(0, N_TAB, true);
    $g['mustFlip'] = true;
    $g['round']++;
    add_event($g, 'Nouvelle donne ! ' . $g['players'][$g['turn']]['name'] . ' commence.', 'deal');
}

function add_event(array &$g, string $text, string $kind = 'info', ?int $seat = null): void
{
    $g['events'][] = ['id' => ++$g['eventSeq'], 'text' => $text, 'kind' => $kind, 'seat' => $seat];
    $g['events'] = array_slice($g['events'], -30);
}

/* ---------- Emplacements ---------- */

function parse_loc(string $loc): array
{
    if (!preg_match('/^(stock|waste|hand|tab):([0-9])$/', $loc, $m)) {
        throw new GameError('Emplacement invalide.');
    }
    $i = (int)$m[2];
    $max = $m[1] === 'tab' ? N_TAB : 2;
    if ($i >= $max) throw new GameError('Emplacement invalide.');
    return [$m[1], $i];
}

function top_of(array $g, string $type, int $i): ?array
{
    return match ($type) {
        'waste' => last($g['players'][$i]['waste']),
        'stock' => last($g['players'][$i]['stock']),
        'hand' => $g['players'][$i]['hand'],
        'tab' => last($g['tableau'][$i]),
    };
}

/**
 * Indice de la première carte de la suite du dessus d'une maison : une suite ne se casse
 * pas, on la déplace toujours en entier (4, 3, 2 empilés partent ensemble).
 */
function run_start(array $pile): int
{
    $k = count($pile) - 1;
    while ($k > 0 && can_stack($pile[$k], $pile[$k - 1])) $k--;
    return max($k, 0);
}

function is_hidden(array $g, int $i): bool { return !empty($g['hidden'][$i]); }

/**
 * Une maison est complète quand elle forme toute la suite : du Roi à l'As (14 cartes,
 * couleurs alternées) ou de l'atout 21 à l'atout 1. L'Excuse peut y tenir lieu de n'importe quelle carte.
 */
function pile_complete(array $pile): bool
{
    if (!$pile || run_start($pile) !== 0) return false;
    $trumps = (bool)array_filter($pile, fn($c) => $c['s'] === 'T');
    $len = $trumps ? 21 : 14;
    $first = $pile[0];
    $last = $pile[count($pile) - 1];
    return count($pile) === $len
        && ($first['s'] === 'E' || $first['r'] === $len)
        && ($last['s'] === 'E' || $last['r'] === 1);
}

/** Retire du jeu une maison complète. */
function clear_complete_pile(array &$g, int $i): void
{
    $pile = $g['tableau'][$i];
    if (!pile_complete($pile)) return;
    $g['tableau'][$i] = [];
    $g['removed'] = ($g['removed'] ?? 0) + count($pile);
    $named = array_filter($pile, fn($c) => $c['s'] !== 'E');
    $what = $named && reset($named)['s'] === 'T' ? 'des atouts (21 à 1)' : 'du Roi à l\'As';
    add_event($g, "Suite complète $what : elle est retirée du jeu.", 'info');
}

/** Carte qui détermine où un coup peut aller : la carte du bas de la suite déplacée. */
function moving_card(array $g, string $type, int $i): ?array
{
    if ($type === 'hand') return $g['players'][$i]['hand'];
    if ($type === 'waste') return last($g['players'][$i]['waste']);
    if (is_hidden($g, $i)) return null;
    $pile = $g['tableau'][$i];
    return $pile ? $pile[run_start($pile)] : null;
}

/** Retire la carte retournée, le dessus d'une défausse, ou toute la suite du dessus d'une maison. */
function take(array &$g, string $type, int $i): array
{
    if ($type === 'hand') {
        $c = $g['players'][$i]['hand'];
        $g['players'][$i]['hand'] = null;
        return [$c];
    }
    if ($type === 'waste') return [array_pop($g['players'][$i]['waste'])];
    return array_splice($g['tableau'][$i], run_start($g['tableau'][$i]));
}

function put(array &$g, string $type, int $i, array $cards): void
{
    foreach ($cards as $card) {
        match ($type) {
            'waste' => $g['players'][$i]['waste'][] = $card,
            'tab' => $g['tableau'][$i][] = $card,
        };
    }
}

function is_source(int $p, string $type, int $i): bool
{
    // Les deux défausses aussi : on peut en prendre la carte du dessus pour la poser au centre
    return ($type === 'hand' && $i === $p) || $type === 'waste' || $type === 'tab';
}

/* ---------- Règles de pose ---------- */

/**
 * Empilement en descendant (maisons et défausse adverse) :
 * enseignes = une valeur en dessous, couleurs alternées ; atouts = un atout en dessous ;
 * l'Excuse se pose sur tout et accepte tout.
 */
function can_stack(array $card, array $top): bool
{
    if ($card['s'] === 'E' || $top['s'] === 'E') return true;
    if ($card['s'] === 'T' || $top['s'] === 'T') {
        return $card['s'] === 'T' && $top['s'] === 'T' && $card['r'] === $top['r'] - 1;
    }
    return $card['r'] === $top['r'] - 1 && is_red($card) !== is_red($top);
}

function can_place(array $g, int $p, array $card, string $type, int $i): bool
{
    $top = top_of($g, $type, $i);
    switch ($type) {
        case 'tab':     // Maison vide = n'importe quelle carte ; maison cachée = bloquée
            if (is_hidden($g, $i)) return false;
            return $top === null || can_stack($card, $top);
        case 'waste':   // Charger la défausse adverse, même règle que les maisons
            return $i !== $p && $top !== null && can_stack($card, $top);
    }
    return false;
}

/** Cartes jouables par p : sa carte retournée et le dessus des maisons. */
function sources_of(array $g, int $p): array
{
    $out = [];
    if ($g['players'][$p]['hand']) $out[] = ['hand', $p, $g['players'][$p]['hand']];
    foreach ([$p, 1 - $p] as $w) {
        if ($c = last($g['players'][$w]['waste'])) $out[] = ['waste', $w, $c];
    }
    for ($t = 0; $t < N_TAB; $t++) {
        if ($c = moving_card($g, 'tab', $t)) $out[] = ['tab', $t, $c];
    }
    return $out;
}

/**
 * Coup « utile » d'une carte (pour détecter les oublis) : sur une maison
 * non vide ou sur la défausse adverse. L'Excuse est ignorée (elle irait partout).
 * Renvoie une description du coup ou null.
 */
function useful_move(array $g, int $p, string $type, int $i, array $card): ?string
{
    if ($card['s'] === 'E') return null;
    for ($t = 0; $t < N_TAB; $t++) {
        if (($type === 'tab' && $t === $i) || is_hidden($g, $t)) continue;
        $top = last($g['tableau'][$t]);
        if ($top && $top['s'] !== 'E' && can_stack($card, $top)) return card_name($card) . ' sur ' . card_name($top);
    }
    $wtop = $type === 'waste' ? null : last($g['players'][1 - $p]['waste']);
    if ($wtop && $wtop['s'] !== 'E' && can_stack($card, $wtop)) return card_name($card) . ' sur la défausse adverse';
    return null;
}

function any_useful_move(array $g, int $p): ?string
{
    foreach (sources_of($g, $p) as [$type, $i, $c]) {
        if ($m = useful_move($g, $p, $type, $i, $c)) return $m;
    }
    return null;
}

function set_fault(array &$g, int $p, string $reason): void
{
    // Seule la première faute du tour compte ; elle pourra être dénoncée au début du tour suivant
    if ($g['fault'] === null) $g['fault'] = ['player' => $p, 'reason' => $reason];
}

function require_turn(array $g, int $p): void
{
    if ($p < 0) throw new GameError('Vous êtes spectateur.');
    if ($g['status'] !== 'playing') throw new GameError("La partie n'est pas en cours.");
    if ($g['turn'] !== $p) throw new GameError("Ce n'est pas votre tour.");
}

/** Pour jouer, il faut d'abord avoir retourné la carte des maisons de ce tour. */
function require_play(array $g, int $p): void
{
    require_turn($g, $p);
    if (!empty($g['mustFlip'])) throw new GameError("Retournez d'abord une carte cachée des maisons.");
}

/** Le joueur actif agit : il renonce à crier « Crapette ! » pour le tour précédent. */
function close_call_window(array &$g): void
{
    $g['callable'] = null;
}

function player_empty(array $pl): bool
{
    return !$pl['stock'] && !$pl['waste'] && $pl['hand'] === null;
}

function check_win(array &$g, int $p): void
{
    if ($g['status'] === 'playing' && player_empty($g['players'][$p])) {
        $g['status'] = 'finished';
        $g['winner'] = $p;
        $g['scores'][$p]++;
        $g['fault'] = null;
        $g['callable'] = null;
        add_event($g, $g['players'][$p]['name'] . ' a posé toutes ses cartes et remporte la partie !', 'win', $p);
    }
}

function end_turn(array &$g): void
{
    $p = $g['turn'];
    if ($g['players'][$p]['hand'] !== null) {
        $g['players'][$p]['waste'][] = $g['players'][$p]['hand'];
        $g['players'][$p]['hand'] = null;
    }
    $g['turn'] = 1 - $p;
    // L'adversaire pourra dénoncer une faute de ce tour avant de jouer son premier coup
    $g['callable'] = ['fault' => $g['fault']];
    $g['fault'] = null;
    $g['players'][0]['falseCall'] = $g['players'][1]['falseCall'] = false;
    $g['mustFlip'] = in_array(true, $g['hidden'] ?? [], true);
}

/** Retourner une carte cachée des maisons (obligatoire, une fois au début de chaque tour). */
function act_flip(array &$g, int $p, string $loc): void
{
    require_turn($g, $p);
    if (empty($g['mustFlip'])) throw new GameError('Vous avez déjà retourné une carte ce tour-ci.');
    [$t, $i] = parse_loc($loc);
    if ($t !== 'tab' || !is_hidden($g, $i)) throw new GameError("Choisissez une carte face cachée des maisons.");
    $g['hidden'][$i] = false;
    $g['mustFlip'] = false;
    $g['lastMove'] = ['id' => last($g['tableau'][$i])['id'], 'from' => $loc, 'to' => $loc, 'p' => $p, 'flip' => true];
}

/* ---------- Actions ---------- */

function act_move(array &$g, int $p, string $from, string $to): void
{
    require_play($g, $p);
    [$ft, $fi] = parse_loc($from);
    [$tt, $ti] = parse_loc($to);
    if (!is_source($p, $ft, $fi)) throw new GameError('Vous ne pouvez pas jouer cette carte.');
    if ($ft === 'waste' && $tt !== 'tab') throw new GameError("La carte d'une défausse ne peut aller que sur une maison.");
    if ($from === $to) throw new GameError('Coup impossible.');
    $card = moving_card($g, $ft, $fi);
    if (!$card) throw new GameError('Il n\'y a pas de carte ici.');

    // Poser la carte retournée sur sa propre défausse
    if ($tt === 'waste' && $ti === $p) {
        if ($ft !== 'hand') throw new GameError('Seule la carte retournée du talon peut aller sur votre défausse.');
        close_call_window($g);
        // Si elle continue la suite de la défausse (3 sur 4, couleurs alternées), le tour continue
        $wtop = last($g['players'][$p]['waste']);
        if ($wtop && can_stack($card, $wtop)) {
            put($g, 'waste', $p, take($g, 'hand', $p));
            $g['lastMove'] = ['id' => $card['id'], 'from' => $from, 'to' => $to, 'p' => $p];
            return;
        }
        // Sinon, c'est la fin du tour
        if ($m = useful_move($g, $p, 'hand', $p, $card)) {
            set_fault($g, $p, "a défaussé alors qu'un coup était possible : $m");
        }
        $g['lastMove'] = ['id' => $card['id'], 'from' => $from, 'to' => $to, 'p' => $p];
        end_turn($g);
        add_event($g, 'Au tour de ' . $g['players'][$g['turn']]['name'] . '.', 'turn', $g['turn']);
        return;
    }

    if (!can_place($g, $p, $card, $tt, $ti)) throw new GameError('Coup impossible : ' . card_name($card) . ' ne va pas ici.');
    close_call_window($g);

    $cards = take($g, $ft, $fi);
    put($g, $tt, $ti, $cards);
    if ($tt === 'tab') clear_complete_pile($g, $ti);
    $g['lastMove'] = ['id' => $card['id'], 'from' => $from, 'to' => $to, 'p' => $p];

    if ($tt === 'waste') {
        $what = count($cards) > 1 ? 'une suite de ' . count($cards) . ' cartes' : card_name($card);
        add_event($g, $g['players'][$p]['name'] . ' charge la défausse de ' . $g['players'][$ti]['name']
            . " avec $what.", 'load', $p);
    }
    check_win($g, $p);
}

function act_draw(array &$g, int $p): void
{
    require_play($g, $p);
    $pl = &$g['players'][$p];
    if ($pl['hand'] !== null) throw new GameError("Jouez ou défaussez d'abord la carte retournée.");
    if (!$pl['stock'] && !$pl['waste']) throw new GameError('Votre talon et votre défausse sont vides.');
    close_call_window($g);

    if ($m = any_useful_move($g, $p)) {
        set_fault($g, $p, "a pioché alors qu'un coup était possible : $m");
    }

    if (!$pl['stock']) {
        // Talon épuisé : la défausse est mélangée pour reformer le talon
        $pl['stock'] = shuffled($pl['waste']);
        $pl['waste'] = [];
        add_event($g, $pl['name'] . ' mélange sa défausse pour reformer son talon.', 'info', $p);
    }
    $pl['hand'] = array_pop($pl['stock']);
    $g['lastMove'] = ['id' => $pl['hand']['id'], 'from' => "stock:$p", 'to' => "hand:$p", 'p' => $p];
}

/** Talon et défausse vides : le joueur ne peut plus piocher, il passe la main. */
function act_pass(array &$g, int $p): void
{
    require_play($g, $p);
    $pl = $g['players'][$p];
    if ($pl['hand'] !== null || $pl['stock'] || $pl['waste']) {
        throw new GameError('Vous ne pouvez passer que si votre talon et votre défausse sont vides.');
    }
    close_call_window($g);
    if ($m = any_useful_move($g, $p)) {
        set_fault($g, $p, "a passé alors qu'un coup était possible : $m");
    }
    end_turn($g);
    add_event($g, $pl['name'] . ' passe. Au tour de ' . $g['players'][$g['turn']]['name'] . '.', 'turn', $g['turn']);
}

/**
 * « Crapette ! » se crie au début de son propre tour, avant tout coup, pour dénoncer
 * une faute commise par l'adversaire pendant le tour qu'il vient de finir.
 * Si elle est justifiée, le fautif reçoit des cartes du talon de celui qui crie.
 */
function act_crapette(array &$g, int $p): void
{
    require_turn($g, $p);
    if ($g['callable'] === null) {
        throw new GameError('« Crapette ! » se crie au début de votre tour, avant de jouer.');
    }
    if ($g['players'][$p]['falseCall']) throw new GameError('Vous avez déjà crié à tort.');

    $me = $g['players'][$p]['name'];
    $opp = $g['players'][1 - $p]['name'];
    $fault = $g['callable']['fault'];
    if ($fault && $fault['player'] === 1 - $p) {
        // Pénalité : le fautif récupère des cartes du talon (puis de la défausse) de celui qui crie
        $given = 0;
        $mine = &$g['players'][$p];
        $his = &$g['players'][1 - $p];
        for ($k = 0; $k < CRAPETTE_PENALTY; $k++) {
            if ($mine['stock']) $c = array_pop($mine['stock']);
            elseif ($mine['waste']) $c = array_pop($mine['waste']);
            else break;
            $his['stock'][] = $c;
            $given++;
        }
        unset($mine, $his);
        close_call_window($g);
        $pen = $given ? " $opp reçoit $given carte" . ($given > 1 ? 's' : '') . " de $me." : '';
        add_event($g, "Crapette ! $opp $fault[reason].$pen", 'crapette', $p);
        check_win($g, $p);
    } else {
        $g['players'][$p]['falseCall'] = true;
        close_call_window($g);
        add_event($g, "Fausse crapette de $me : $opp n'a commis aucune faute.", 'false', $p);
    }
}

function act_resign(array &$g, int $p): void
{
    if ($p < 0 || $g['status'] !== 'playing') throw new GameError("La partie n'est pas en cours.");
    $g['status'] = 'finished';
    $g['winner'] = 1 - $p;
    $g['scores'][1 - $p]++;
    $g['fault'] = null;
    $g['callable'] = null;
    add_event($g, $g['players'][$p]['name'] . ' abandonne. ' . $g['players'][1 - $p]['name'] . ' gagne la partie.', 'win', 1 - $p);
}

function act_rematch(array &$g, int $p): void
{
    if ($p < 0 || $g['status'] !== 'finished') throw new GameError("La partie n'est pas terminée.");
    $g['rematch'][$p] = true;
    if ($g['rematch'][0] && $g['rematch'][1]) {
        deal($g);
    } else {
        add_event($g, $g['players'][$p]['name'] . ' propose une revanche.', 'info', $p);
    }
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
    foreach ($g['players'] as $i => $pl) {
        if (!$pl) { $players[] = null; continue; }
        $players[] = [
            'name' => $pl['name'],
            'stock' => count($pl['stock']),
            'waste' => ['n' => count($pl['waste']), 'top' => last($pl['waste'])],
            'hand' => $pl['hand'],
            'falseCall' => $pl['falseCall'],
        ];
    }
    return [
        'id' => $g['id'], 'v' => $g['v'], 'seat' => $seat, 'status' => $g['status'],
        'turn' => $g['turn'], 'winner' => $g['winner'], 'scores' => $g['scores'],
        'rematch' => $g['rematch'], 'round' => $g['round'], 'players' => $players,
        // On indique seulement si l'on peut crier, jamais s'il y a eu faute
        'canCall' => ($g['callable'] ?? null) !== null,
        // Les cartes cachées des maisons sont envoyées sans leur valeur
        'tableau' => array_map(
            fn($pile, $i) => is_hidden($g, $i) ? array_map(fn() => ['back' => true], $pile) : $pile,
            $g['tableau'], array_keys($g['tableau'])
        ),
        'mustFlip' => !empty($g['mustFlip']),
        'removed' => $g['removed'] ?? 0,
        'lastMove' => $g['lastMove'], 'events' => $g['events'], 'chat' => $g['chat'],
        'online' => presence($g['id']),
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
        if ($pl && hash_equals($pl['token'], $token)) return $i;
    }
    return -1;
}

function touch_presence(string $id, int $seat): void
{
    if ($seat >= 0) @touch(DATA_DIR . "/$id.p$seat");
}

function presence(string $id): array
{
    clearstatcache();
    $out = [];
    foreach ([0, 1] as $s) {
        $f = DATA_DIR . "/$id.p$s";
        $out[] = is_file($f) && filemtime($f) > time() - 8;
    }
    return $out;
}

/** Supprime les parties inactives depuis plus de 3 jours. */
function cleanup_old_games(): void
{
    foreach (glob(DATA_DIR . '/*') ?: [] as $f) {
        if (basename($f) !== '.htaccess' && filemtime($f) < time() - 3 * 86400) @unlink($f);
    }
}
