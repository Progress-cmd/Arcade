<?php
declare(strict_types=1);

require __DIR__ . '/lib/game.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function reply(array $data): never
{
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function clean_name(mixed $name): string
{
    $name = trim(preg_replace('/\s+/u', ' ', (string)$name) ?? '');
    $name = mb_substr($name, 0, 20);
    if ($name === '') throw new GameError('Choisissez un pseudo.');
    return $name;
}

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') throw new GameError('Méthode non autorisée.');
    $in = json_decode(file_get_contents('php://input') ?: '', true);
    if (!is_array($in)) throw new GameError('Requête invalide.');

    ensure_data_dir();
    $action = (string)($in['action'] ?? '');
    $id = strtoupper((string)($in['game'] ?? ''));
    $token = (string)($in['token'] ?? '');

    switch ($action) {
        case 'create':
            $name = clean_name($in['name'] ?? '');
            if (random_int(1, 20) === 1) cleanup_old_games();
            $id = new_game_id();
            $token = bin2hex(random_bytes(16));
            $g = new_game($id, $name, $token);
            add_event($g, "$name a créé la partie.", 'info', 0);
            game_save_new($g);
            touch_presence($g, 0);
            reply(['game' => $id, 'token' => $token, 'seat' => 0]);

        case 'join':
            $g = game_read($id);
            $seat = seat_of($g, $token);
            if ($seat < 0 && $g['status'] === 'waiting' && count($g['players']) < MAX_PLAYERS) {
                $name = clean_name($in['name'] ?? '');
                $token = bin2hex(random_bytes(16));
                $g = game_update($id, function (array &$g) use ($name, $token, &$seat) {
                    if ($g['status'] !== 'waiting') throw new GameError('La partie vient de commencer.');
                    if (count($g['players']) >= MAX_PLAYERS) throw new GameError('La table est complète.');
                    $g['players'][] = new_player($name, $token);
                    $seat = count($g['players']) - 1;
                    add_event($g, "$name rejoint la table.", 'join', $seat);
                });
            }
            touch_presence($g, $seat);
            reply(['game' => $id, 'token' => $seat >= 0 ? $token : '', 'seat' => $seat, 'state' => public_view($g, $seat)]);

        case 'state':
            $g = game_read($id);
            $seat = seat_of($g, $token);
            touch_presence($g, $seat);
            if ((int)($in['v'] ?? 0) === $g['v']) {
                reply(['same' => true, 'v' => $g['v'], 'online' => presence($g)]);
            }
            reply(['state' => public_view($g, $seat)]);

        case 'start':
        case 'draw':
        case 'lay':
        case 'hit':
        case 'discard':
        case 'next':
        case 'rematch':
        case 'leave':
        case 'kick':
        case 'chat':
            $seat = -1;
            $g = game_update($id, function (array &$g) use ($action, $token, $in, &$seat) {
                $seat = seat_of($g, $token);
                if ($seat < 0) throw new GameError('Vous ne participez pas à cette partie.');
                $target = isset($in['target']) && is_numeric($in['target']) ? (int)$in['target'] : null;
                match ($action) {
                    'start' => act_start($g, $seat),
                    'draw' => act_draw($g, $seat, (string)($in['from'] ?? '')),
                    'lay' => act_lay($g, $seat, is_array($in['groups'] ?? null) ? $in['groups'] : []),
                    'hit' => act_hit($g, $seat, (string)($in['card'] ?? ''), (int)($in['group'] ?? -1), (string)($in['end'] ?? '')),
                    'discard' => act_discard($g, $seat, (string)($in['card'] ?? ''), $target),
                    'next' => act_next($g, $seat),
                    'rematch' => act_rematch($g, $seat),
                    'leave' => act_leave($g, $seat),
                    'kick' => act_kick($g, $seat, $target ?? -1),
                    'chat' => act_chat($g, $seat, (string)($in['text'] ?? '')),
                };
            });
            // Le joueur qui a quitté une partie en attente n'a plus de siège
            $seat = seat_of($g, $token);
            touch_presence($g, $seat);
            reply(['state' => public_view($g, $seat)]);

        default:
            throw new GameError('Action inconnue.');
    }
} catch (GameError $e) {
    reply(['error' => $e->getMessage()]);
} catch (Throwable $e) {
    http_response_code(500);
    error_log('[phase10] ' . $e);
    reply(['error' => 'Erreur interne du serveur.']);
}
