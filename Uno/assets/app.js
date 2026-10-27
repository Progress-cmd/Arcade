/* Uno — client : rendu de la table, interactions, synchronisation par polling. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const COLORS = { r: 'rouge', b: 'bleu', v: 'vert', j: 'jaune' };
  const SYMBOL = { r: '●', b: '■', v: '▲', j: '◆' };
  const ORDER = 'rbvjw';
  const KINDS = { skip: 'Passe', rev: 'Inversion', p2: '+2', w: 'Joker', w4: 'Joker +4' };
  const LABEL = { skip: '⊘', rev: '⇄', p2: '+2', w: '★', w4: '+4' };
  const KORDER = ['skip', 'rev', 'p2', 'w', 'w4'];
  // Passe et Inversion sont féminins : bleue, verte
  const fem = (c) => (['skip', 'rev'].includes(c.k) && 'bv'.includes(c.c) ? 'e' : '');
  const cardName = (c) => (!c.k ? `${c.n} ${COLORS[c.c]}` : c.c === 'w' ? KINDS[c.k] : `${KINDS[c.k]} ${COLORS[c.c]}${fem(c)}`);
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* stockage indisponible */ } },
  };

  const S = {
    game: document.body.dataset.game || '',
    token: '',
    seat: -1,
    st: null,        // dernier état reçu du serveur
    view: null,      // état affiché : celui du serveur, ou une version anticipée après un coup
    v: 0,
    busy: false,
    lastEvent: null, lastChat: null, unread: 0,
    scoreSeen: -1, autoScore: false,
    pollTimer: null,
    cw: 70, rows: 1, wide: false,
    sound: store.get('ch.sound') !== 'off',
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /* ====================================================================
     Réseau
     ==================================================================== */

  async function api(action, data = {}) {
    const res = await fetch('api.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, game: S.game, token: S.token, ...data }),
    });
    let j;
    try { j = await res.json(); } catch { throw new Error('Réponse invalide du serveur.'); }
    if (j.error) throw new Error(j.error);
    return j;
  }

  async function poll() {
    clearTimeout(S.pollTimer);
    if (!S.busy) {
      try {
        const j = await api('state', { v: S.v });
        if (j.same) updateOnline(j.online);
        else applyState(j.state);
      } catch (e) { /* coupure réseau passagère : on réessaie */ }
    }
    S.pollTimer = setTimeout(poll, document.hidden ? 4000 : 900);
  }

  async function action(name, data = {}) {
    if (S.busy) return false;
    S.busy = true;
    try {
      const j = await api(name, data);
      S.busy = false;
      applyState(j.state, true);
      return true;
    } catch (e) {
      S.busy = false;
      toast(e.message, 'error');
      sound('error');
      // Le coup anticipé est annulé : on revient à l'état du serveur
      if (S.view !== S.st) { S.view = S.st; render(); }
      return false;
    }
  }

  /* ====================================================================
     Démarrage
     ==================================================================== */

  function showLobby(error) {
    $('#lobby').hidden = false;
    $('#app').hidden = true;
    $('#nameInput').value = store.get('ch.name') || '';
    if (error) toast(error, 'error');
  }

  $('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#nameInput').value.trim();
    if (!name) return;
    store.set('ch.name', name);
    const btn = e.submitter || $('#createForm button');
    btn.disabled = true;
    try {
      const j = await api('create', { name });
      store.set('ch.t.' + j.game, j.token);
      location.href = '?g=' + j.game;
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });

  $('#joinCodeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#codeInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length === 6) location.href = '?g=' + code;
    else toast('Le code fait 6 caractères.', 'error');
  });

  async function enterGame() {
    S.token = store.get('ch.t.' + S.game) || '';
    $('#app').hidden = false;
    let j;
    try {
      j = await api('state', { v: 0 });
    } catch (e) {
      showLobby(e.message);
      return;
    }
    const st = j.state;
    applyState(st);
    if (st.seat < 0 && st.status === 'waiting' && st.players.length < 6) {
      // Une place est libre : on propose de s'asseoir
      $('#joinInfo').textContent = `${st.players[0].name} vous invite à une partie de Uno.`;
      $('#joinName').value = store.get('ch.name') || '';
      $('#joinModal').hidden = false;
      $('#joinName').focus();
      return;
    }
    poll();
  }

  $('#joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#joinName').value.trim();
    if (!name) return;
    store.set('ch.name', name);
    try {
      const j = await api('join', { name });
      if (j.seat >= 0) {
        S.token = j.token;
        store.set('ch.t.' + S.game, j.token);
      } else {
        toast('La partie a déjà commencé : vous la regardez en spectateur.', 'info');
      }
      $('#joinModal').hidden = true;
      applyState(j.state);
      poll();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#watchBtn').addEventListener('click', () => {
    $('#joinModal').hidden = true;
    poll();
  });

  /* ====================================================================
     Application d'un nouvel état
     ==================================================================== */

  function applyState(st, fromAction = false) {
    if (S.st && st.v < S.v) return;
    if (S.busy && !fromAction) return;
    const prev = S.st;
    S.st = st;
    S.view = st;
    S.v = st.v;
    S.seat = st.seat;

    layout(false);
    render();
    handleEvents(st.events, !prev);
    handleChat(st.chat, !prev);
    handleModals(!prev);
    if (prev && st.lastMove && JSON.stringify(st.lastMove) !== JSON.stringify(prev.lastMove)) {
      if (st.lastMove.p !== S.seat && st.lastMove.kind !== 'penalty') sound(st.lastMove.kind === 'draw' ? 'draw' : 'card');
    }
  }

  function updateOnline(online) {
    if (!S.st) return;
    S.st.online = online;
    document.querySelectorAll('.opp').forEach((c) => c.classList.toggle('offline', !online[+c.dataset.p]));
  }

  /* ====================================================================
     Règles (miroir de lib/game.php, pour guider le joueur)
     ==================================================================== */

  const V = () => S.view;
  const me = () => (V() && S.seat >= 0 ? V().players[S.seat] : null);
  const playing = () => V() && V().status === 'playing' && me() && !me().out;
  const myTurn = () => playing() && V().turn === S.seat;
  function fits(c) {
    const top = V().top;
    if (!top) return false;
    if (c.c === 'w' || c.c === V().color) return true;
    if (top.c === 'w') return false;
    return c.k ? c.k === top.k : !top.k && c.n === top.n;
  }
  /** Peut-on poser cette carte maintenant ? (après une pioche, seulement la carte piochée) */
  // +2 en attente : seul un autre +2 peut être posé, sinon on pioche le tout
  // On ne peut pas terminer sur une carte noire
  const blackLast = (c) => c.c === 'w' && V().hand.length === 1;
  const canPlay = (c) => myTurn() && fits(c) && (!V().drawn || V().drawn === c.id) && (!V().pending || c.k === 'p2') && !blackLast(c);
  const canDraw = () => myTurn() && !V().drawn && (V().canDraw || V().pending > 0);
  // Aucune aide visuelle sur les cartes jouables : c'est au joueur de voir ce qui convient.

  /* ====================================================================
     Rendu
     ==================================================================== */

  const table = $('#table');

  function cardEl(c) {
    const n = el('div', 'card c-' + c.c + (c.k ? ' sp k-' + c.k : ''));
    n.dataset.id = c.id;
    const R = c.k ? LABEL[c.k] : c.n === 6 || c.n === 9 ? `<u>${c.n}</u>` : String(c.n);
    const s = c.c === 'w' ? '' : `<i>${SYMBOL[c.c]}</i>`;
    // Joker : une roue aux quatre couleurs, avec « +4 » pour le Joker +4
    const mid = c.c === 'w' ? `<b class="wheel">${c.k === 'w4' ? '<em>+4</em>' : ''}</b>` : `<b>${R}</b>`;
    n.innerHTML = `<span class="ci tl">${R}${s}</span><span class="pip">${mid}</span><span class="ci br">${R}${s}</span>`;
    n.title = cardName(c);
    return n;
  }

  const backEl = () => el('div', 'card back');
  const AVATAR = ['#3b74c4', '#cf3b4d', '#2a9d55', '#d59a12', '#8b4fd1', '#1aa3a3'];

  function avatarEl(pl, p) {
    const av = el('div', 'avatar', pl.name.charAt(0).toUpperCase());
    av.style.setProperty('--av', AVATAR[p % AVATAR.length]);
    av.append(el('span', 'dot'));
    return av;
  }

  function renderOpps() {
    const v = V();
    const box = $('#opps');
    box.innerHTML = '';
    v.players.forEach((pl, p) => {
      if (p === S.seat) return;
      const o = el('div', 'opp');
      o.dataset.loc = 'seat:' + p;
      o.dataset.p = p;
      o.classList.toggle('active', v.status === 'playing' && v.turn === p);
      o.classList.toggle('out', pl.out);
      o.classList.toggle('offline', !(v.online && v.online[p]));
      o.classList.toggle('winner', v.status === 'finished' && v.winners.includes(p));
      const who = el('div', 'opp-who');
      const top = el('div', 'opp-top');
      top.append(avatarEl(pl, p), el('div', 'name', pl.name));
      if (pl.score) top.append(el('span', 'pts', `${pl.score} pts`));
      who.append(top);
      if (pl.out) who.append(el('div', 'opp-meta', 'a quitté'));
      else if (v.status !== 'waiting') {
        // Les cartes de l'adversaire, en éventail de dos, et leur nombre
        const meta = el('div', 'opp-meta');
        const fan = el('span', 'fan');
        for (let k = 0; k < Math.min(pl.cards, 10); k++) fan.append(el('i'));
        meta.append(fan, el('span', 'nb', String(pl.cards)));
        if (pl.called) meta.append(el('span', 'called', 'Uno !'));
        who.append(meta);
      }
      o.append(who);
      o.title = pl.out ? pl.name : `${pl.name} : ${plural(pl.cards, 'carte')} en main`;
      box.append(o);
    });
    box.hidden = !box.children.length;
  }

  function renderCenter() {
    const v = V();
    const box = $('#center');
    box.innerHTML = '';
    if (v.status === 'waiting') return;

    const deck = el('div', 'slot deck');
    deck.dataset.loc = 'deck';
    deck.dataset.label = 'Vide';
    if (v.deck) {
      if (v.deck > 1) deck.append(el('div', 'card back under'));
      deck.append(backEl(), el('span', 'count', String(v.deck)));
    } else deck.classList.add('empty');
    if (canDraw()) deck.classList.add('movable');
    deck.title = `Pioche : ${plural(v.deck, 'carte')}`;
    const dw = el('div', 'bwrap');
    dw.append(deck, el('span', 'need', 'Pioche'));

    const pile = el('div', 'slot discard');
    pile.dataset.loc = 'discard';
    if (v.under) {
      const u = cardEl(v.under);
      u.classList.add('under');
      pile.append(u);
    }
    if (v.top) pile.append(cardEl(v.top));
    if (v.discard > 1) pile.append(el('span', 'count', String(v.discard)));
    if (v.pending) pile.append(el('span', 'stack', '+' + v.pending));
    const pw = el('div', 'bwrap');
    // Après un Joker, la couleur choisie est indiquée sous la défausse
    const need = el('span', 'need', 'Défausse');
    if (v.top && v.top.c === 'w' && v.color) {
      need.className = 'need ask c-' + v.color;
      need.textContent = `${SYMBOL[v.color]} ${COLORS[v.color]}`;
      pile.classList.add('ask', 'c-' + v.color);
    }
    pw.append(pile, need);
    // Sens du jeu
    const dir = el('span', 'dir' + (v.dir < 0 ? ' rev' : ''), v.dir < 0 ? '↺' : '↻');
    dir.title = v.dir < 0 ? 'Sens inversé' : 'Sens normal';

    box.append(dw, dir, pw);
  }

  function renderMine() {
    const v = V();
    const box = $('#mine');
    box.innerHTML = '';
    const pl = me();
    if (!pl || pl.out || v.status === 'waiting') { box.hidden = true; return; }
    box.hidden = false;
    const turn = myTurn();

    // Consigne et bouton
    const bar = el('div', 'actions');
    const button = (label, act) => {
      const b = el('button', 'btn btn-gold btn-small', label);
      b.onclick = () => action(act);
      bar.append(b);
    };
    if (turn) {
      if (v.pending) {
        bar.append(el('span', 'hint', `+${v.pending} : posez un +2, ou piochez ${v.pending} cartes`));
      } else if (v.drawn) {
        bar.append(el('span', 'hint', 'Posez la carte piochée, ou gardez-la'));
        button('Garder', 'pass');
      } else if (!v.canDraw) {
        bar.append(el('span', 'hint', 'Plus rien à piocher'));
        button('Passer', 'pass');
      } else {
        bar.append(el('span', 'hint', 'Posez une carte, ou piochez'));
      }
    } else if (v.status === 'playing') {
      const who = v.players[v.turn].name;
      bar.append(el('span', 'hint wait', v.hasDrawn ? `${who} a pioché…` : `Tour de ${who}…`));
    } else {
      bar.append(el('span', 'hint wait', ' '));
    }
    if (v.status === 'playing') {
      // Toujours présent : annoncer sa dernière carte, ou attraper un adversaire qui l'a oubliée
      const call = el('button', 'btn btn-call btn-small' + (pl.called ? ' done' : ''), pl.called ? 'Uno ✓' : 'Uno !');
      call.title = 'Annoncer sa dernière carte, ou attraper un adversaire qui a oublié de le faire';
      call.onclick = () => { unlockAudio(); action('uno'); };
      bar.append(call);
    }

    // Main, triée par couleur puis par nombre
    const hand = el('div', 'hand');
    hand.dataset.loc = 'hand:' + S.seat;
    const rank = (c) => (c.k ? 10 + KORDER.indexOf(c.k) : c.n);
    const sorted = [...v.hand].sort((a, b) => ORDER.indexOf(a.c) - ORDER.indexOf(b.c) || rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
    for (const c of sorted) {
      const n = cardEl(c);
      n.classList.add('in-hand');
      if (turn) n.classList.add('playable');
      if (v.drawn === c.id) n.classList.add('drawn');
      hand.append(n);
    }
    box.append(bar, hand);
  }

  /** Position des cartes de la main : en éventail, sur deux rangées si elles sont trop nombreuses. */
  function placeFans() {
    const hand = table.querySelector('.hand');
    if (!hand) return;
    const cw = S.cw, ch = cw * 1.45;
    const cards = [...hand.children];
    const rows = S.rows;
    hand.style.height = ch * (1.12 + (rows - 1) * 0.55) + 'px';
    const W = hand.clientWidth;
    const per = Math.ceil(cards.length / rows);
    for (let r = 0; r < rows; r++) {
      const row = cards.slice(r * per, (r + 1) * per);
      const n = row.length;
      const step = n > 1 ? Math.min(cw * 1.06, (W - cw) / (n - 1)) : 0;
      const x0 = Math.max(0, (W - cw - step * (n - 1)) / 2);
      row.forEach((c, k) => {
        c.style.left = x0 + k * step + 'px';
        c.style.setProperty('--y', ch * (0.1 + r * 0.55) + 'px');
        c.style.zIndex = r * 100 + k + 1;
      });
    }
  }

  function renderTopbar() {
    const v = V();
    let text = '', mine = false;
    if (v.status === 'waiting') text = 'En attente des joueurs…';
    else if (v.status === 'finished') text = winnersText(v);
    else if (myTurn()) { mine = true; text = 'À vous de jouer'; }
    else text = `Tour de ${v.players[v.turn].name}…`;
    const pill = $('#statusPill');
    pill.innerHTML = '';
    pill.append(el('span', mine ? 'mine' : '', text));
  }

  function winnersText(v) {
    if (!v.winners.length) return 'Partie terminée';
    if (v.winners[0] === S.seat) return 'Vous avez gagné !';
    return v.players[v.winners[0]].name + ' gagne !';
  }

  function render() {
    if (!S.view) return;
    const snap = snapshot();
    renderTopbar();
    renderOpps();
    renderCenter();
    renderMine();
    placeFans();
    animateFrom(snap);
  }

  /* ---------- Animations FLIP ---------- */

  function snapshot() {
    const m = new Map();
    table.querySelectorAll('.card[data-id]').forEach((n) => m.set(n.dataset.id, n.getBoundingClientRect()));
    return m;
  }

  function animateFrom(snap) {
    const lm = V().lastMove;
    table.querySelectorAll('.card[data-id]').forEach((n) => {
      let r0 = snap.get(n.dataset.id);
      if (!r0) {
        // Carte nouvelle : piochée (dans ma main), ou posée par un adversaire depuis sa place
        let src = null;
        if (n.closest('.hand')) src = 'deck';
        else if (lm && lm.id === n.dataset.id && lm.p !== S.seat) src = 'seat:' + lm.p;
        const s = src && table.querySelector(`[data-loc="${src}"]`);
        if (s) r0 = s.getBoundingClientRect();
      }
      if (!r0) return;
      const r1 = n.getBoundingClientRect();
      const dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      n.animate(
        [{ translate: `${dx}px ${dy}px`, zIndex: 500 }, { translate: '0 0', zIndex: 500 }],
        { duration: 320, easing: 'cubic-bezier(.2, .8, .25, 1)' },
      );
      if (!snap.has(n.dataset.id)) n.classList.add('flash');
    });
  }

  /* ====================================================================
     Coups : affichage anticipé, puis envoi au serveur
     ==================================================================== */

  /** L'état tel qu'il sera après avoir posé la carte, pour l'afficher sans attendre le serveur. */
  function optimistic(card, color) {
    const v = structuredClone(S.st);
    v.hand = v.hand.filter((c) => c.id !== card.id);
    v.players[S.seat].cards--;
    v.under = v.top;
    v.top = card;
    v.color = card.c === 'w' ? color : card.c;
    v.discard++;
    v.drawn = null;
    v.hasDrawn = false;
    // Le tour passe au joueur suivant encore en jeu (sauf si c'était ma dernière carte), selon l'effet de la carte
    if (v.hand.length) {
      const N = v.players.length;
      const step = (from) => { let s = from; do s = (s + v.dir + N) % N; while (v.players[s].out && s !== from); return s; };
      if (card.k === 'rev') {
        v.dir = -v.dir;
        v.turn = v.players.filter((pl) => !pl.out).length === 2 ? S.seat : step(S.seat);
      } else {
        v.turn = step(S.seat);
        if (card.k === 'p2') v.pending = (v.pending || 0) + 2;
        else if (['skip', 'w4'].includes(card.k)) v.turn = step(v.turn);
      }
    }
    v.lastMove = { id: card.id, kind: 'play', p: S.seat };
    return v;
  }

  function play(card, color = '') {
    if (S.busy) return;
    // Joker : on demande d'abord la couleur
    if (card.c === 'w' && !color) { S.wild = card; $('#colorModal').hidden = false; return; }
    S.view = optimistic(card, color);
    layout(false);
    render();
    sound('card');
    action('play', { card: card.id, color });
  }

  document.querySelectorAll('#colorModal [data-color]').forEach((b) => b.addEventListener('click', () => {
    $('#colorModal').hidden = true;
    const card = S.wild;
    S.wild = null;
    if (card && canPlay(card)) play(card, b.dataset.color);
  }));

  table.addEventListener('click', (e) => {
    const v = V();
    if (!v) return;
    unlockAudio();
    const spot = e.target.closest('#table [data-loc]');
    const loc = spot ? spot.dataset.loc : '';

    // Un adversaire absent : on peut le retirer de la partie
    const opp = /^seat:(\d+)/.exec(loc);
    if (opp) {
      const p = +opp[1];
      const pl = v.players[p];
      if (S.seat >= 0 && !me().out && !pl.out && v.status !== 'waiting' && !(v.online && v.online[p])
          && confirm(`${pl.name} semble absent. Le retirer de la partie pour continuer sans lui ?`)) {
        action('kick', { target: p });
      }
      return;
    }
    if (!playing() || S.busy) return;

    if (loc === 'deck') {
      if (canDraw()) { sound('draw'); action('draw'); }
      else if (!myTurn()) toast("Ce n'est pas votre tour.", 'error', 1600);
      else if (v.drawn) toast('Vous avez déjà pioché : posez la carte ou gardez-la.', 'error', 2000);
      return;
    }

    const node = e.target.closest('.hand .card[data-id]');
    if (!node) return;
    const card = v.hand.find((c) => c.id === node.dataset.id);
    if (!card) return;
    if (!myTurn()) { toast("Ce n'est pas votre tour.", 'error', 1600); return; }
    if (canPlay(card)) { play(card); return; }
    sound('error');
    if (v.pending) toast(`Posez un +2, ou piochez ${v.pending} cartes.`, 'error', 2200);
    else if (blackLast(card)) toast('On ne peut pas terminer sur une carte noire : piochez.', 'error', 2400);
    else if (v.drawn) toast('Après avoir pioché, seule la carte piochée peut être posée.', 'error', 2200);
    else toast('Cette carte ne va pas sur la défausse.', 'error', 2000);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal[data-dismiss]').forEach((m) => (m.hidden = true));
      $('#menu').hidden = true;
    }
  });

  /* ====================================================================
     Événements, discussion, fenêtres
     ==================================================================== */

  function handleEvents(evs, initial) {
    const maxId = evs.length ? evs[evs.length - 1].id : 0;
    if (initial || S.lastEvent === null) { S.lastEvent = maxId; return; }
    for (const ev of evs) {
      if (ev.id <= S.lastEvent) continue;
      switch (ev.kind) {
        case 'turn':
          if (ev.seat === S.seat) { toast('À vous de jouer !', 'turn', 2200); sound('turn'); }
          break;
        case 'call': toast(ev.seat === S.seat ? 'Vous annoncez « Uno ! »' : ev.text, 'call', 2600); sound('call'); break;
        case 'penalty':
          toast(ev.seat === S.seat ? "Attrapé ! Vous n'aviez pas dit « Uno ! » : 2 cartes de pénalité." : ev.text, 'warn', 4000);
          sound('buzz');
          break;
        case 'join': toast(ev.text, 'info', 3000); sound('turn'); break;
        case 'stack':
          toast(ev.seat === S.seat ? `+2 ! Posez un +2 ou piochez ${S.st.pending} cartes.` : ev.text, ev.seat === S.seat ? 'warn' : 'info', 3000);
          break;
        case 'win': break; // géré par la fenêtre des scores
        default: toast(ev.text, 'info', 3000);
      }
    }
    S.lastEvent = maxId;
  }

  function handleChat(chat, initial) {
    const maxId = chat.length ? chat[chat.length - 1].id : 0;
    const isNew = (m) => S.lastChat !== null && m.id > S.lastChat;
    const fresh = initial ? [] : chat.filter((m) => isNew(m) && m.p !== S.seat);
    S.lastChat = maxId;
    renderChat();
    if (!fresh.length) return;
    if ($('#chat').hidden) {
      S.unread += fresh.length;
      updateBadge();
      for (const m of fresh) toast(`💬 ${S.st.players[m.p]?.name ?? ''} : ${m.text}`, 'info', 4000);
    }
    sound('msg');
  }

  function renderChat() {
    const log = $('#chatLog');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.innerHTML = '';
    const chat = S.st ? S.st.chat : [];
    if (!chat.length) log.append(el('div', 'empty', 'Aucun message pour le moment.'));
    for (const m of chat) {
      const d = el('div', 'msg' + (m.p === S.seat ? ' mine' : ''));
      d.append(el('b', '', S.st.players[m.p]?.name ?? ''), document.createTextNode(m.text));
      log.append(d);
    }
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function updateBadge() {
    const b = $('#chatBadge');
    b.hidden = !S.unread;
    b.textContent = S.unread > 9 ? '9+' : String(S.unread);
  }

  function handleModals(initial) {
    const v = S.st;
    // Salle d'attente
    const wait = v.status === 'waiting' && S.seat >= 0;
    $('#waitModal').hidden = !wait;
    if (wait) {
      $('#shareLink').value = shareUrl();
      $('#shareCode').textContent = v.id;
      const list = $('#seatList');
      list.innerHTML = '';
      v.players.forEach((pl, p) => {
        const li = el('li', '', pl.name + (p === S.seat ? ' (vous)' : '') + (p === 0 ? ' — hôte' : ''));
        li.style.setProperty('--av', AVATAR[p % AVATAR.length]);
        list.append(li);
      });
      const host = S.seat === 0;
      $('#startBtn').hidden = !host;
      $('#startBtn').disabled = v.players.length < 2;
      $('#waitHint').textContent = host
        ? (v.players.length < 2 ? 'Il faut au moins 2 joueurs pour commencer.' : `${plural(v.players.length, 'joueur')} à table : vous pouvez lancer !`)
        : `En attente que ${v.players[0].name} lance la partie…`;
    }
    $('#waitModal').querySelector('.spinner-cards').hidden = S.seat === 0 && v.players.length > 1;

    // Fin de manche : la fenêtre des scores s'ouvre une fois
    const modal = $('#scoreModal');
    if (v.status === 'finished' && S.scoreSeen !== v.round) {
      S.scoreSeen = v.round;
      S.autoScore = true;
      fillScores();
      modal.hidden = false;
      if (!initial) sound(v.winners.includes(S.seat) ? 'win' : 'buzz');
    } else if (v.status === 'playing' && S.autoScore) {
      // Quelqu'un a relancé une manche : on ferme la fenêtre ouverte automatiquement
      S.autoScore = false;
      modal.hidden = true;
    } else if (!modal.hidden) {
      fillScores();
    }
  }

  function fillScores() {
    const v = S.st;
    const lr = v.lastResult;
    const ended = v.status === 'finished';
    const icon = $('#scoreIcon'), title = $('#scoreTitle'), text = $('#scoreText');
    if (ended) {
      const won = v.winners.includes(S.seat);
      icon.textContent = won ? '🏆' : '🎴';
      title.textContent = won ? 'Victoire !' : winnersText(v);
      if (lr && lr.round === v.round) {
        const who = won ? 'Vous marquez' : v.players[lr.winner].name + ' marque';
        text.textContent = (lr.blocked
          ? 'Plus personne ne pouvait jouer : la main la plus légère l\'emporte. '
          : `${won ? 'Vous avez posé votre' : v.players[lr.winner].name + ' a posé sa'} dernière carte. `)
          + `${who} ${plural(lr.points, 'point')}, la valeur des cartes restées chez les adversaires.`;
      } else text.textContent = 'Il ne reste plus assez de joueurs pour continuer.';
    } else {
      icon.textContent = '📋';
      title.textContent = 'Scores';
      text.textContent = v.status === 'waiting' ? 'La partie n\'a pas encore commencé.'
        : `Manche ${v.round} en cours. Le gagnant d'une manche marque la valeur des cartes restées dans les mains adverses.`;
    }

    const tbl = $('#scoreTable');
    tbl.innerHTML = '<thead><tr><th>Joueur</th><th>Cartes</th><th>Manches</th><th>Points</th></tr></thead>';
    const body = el('tbody');
    const rows = v.players.map((pl, p) => [pl, p]).sort(([a], [b]) => a.out - b.out || b.score - a.score || a.cards - b.cards);
    for (const [pl, p] of rows) {
      const tr = el('tr', (p === S.seat ? 'me' : '') + (ended && v.winners.includes(p) ? ' winner' : '') + (pl.out ? ' out' : ''));
      tr.append(el('td', 'nm', pl.name));
      tr.append(el('td', '', pl.out || v.status === 'waiting' ? '—' : String(pl.cards)));
      tr.append(el('td', '', String(pl.wins)));
      tr.append(el('td', 'tot', String(pl.score)));
      body.append(tr);
    }
    tbl.append(body);

    const nb = $('#nextBtn');
    nb.hidden = !ended || S.seat < 0 || v.players[S.seat].out || v.players.filter((pl) => !pl.out).length < 2;
  }

  $('#nextBtn').addEventListener('click', async () => {
    const ok = await action('rematch');
    if (ok) $('#scoreModal').hidden = true;
  });
  $('#scoresBtn').addEventListener('click', () => {
    if (!S.st) return;
    S.autoScore = false;
    fillScores();
    $('#scoreModal').hidden = false;
  });
  $('#startBtn').addEventListener('click', () => action('start'));

  /* ---------- Barre du haut ---------- */

  const shareUrl = () => location.origin + location.pathname + '?g=' + S.game;

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const i = $('#shareLink'); i.value = text; i.select();
      try { return document.execCommand('copy'); } catch { return false; }
    }
  }

  $('#copyLink').addEventListener('click', async () => {
    if (await copy(shareUrl())) { $('#copyLink').textContent = 'Copié !'; setTimeout(() => ($('#copyLink').textContent = 'Copier'), 1600); }
  });

  $('#shareBtn').addEventListener('click', async () => {
    const url = shareUrl();
    if (navigator.share) {
      try { await navigator.share({ title: 'Une partie de Uno ?', text: 'Viens jouer à Uno avec moi !', url }); return; }
      catch { /* partage annulé */ }
    }
    if (await copy(url)) toast('Lien de la partie copié !', 'info', 2000);
  });

  $('#chatBtn').addEventListener('click', () => {
    const c = $('#chat');
    c.hidden = !c.hidden;
    if (!c.hidden) {
      S.unread = 0; updateBadge();
      const log = $('#chatLog'); log.scrollTop = log.scrollHeight;
      if (S.seat >= 0 && matchMedia('(pointer: fine)').matches) $('#chatInput').focus();
    }
  });
  $('#chatClose').addEventListener('click', () => ($('#chat').hidden = true));
  $('#chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const i = $('#chatInput');
    const text = i.value.trim();
    if (!text || S.seat < 0) return;
    i.value = '';
    try { const j = await api('chat', { text }); applyState(j.state, true); }
    catch (err) { toast(err.message, 'error'); i.value = text; }
  });

  $('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; });
  document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) $('#menu').hidden = true; });
  $('#leaveBtn').addEventListener('click', async () => {
    $('#menu').hidden = true;
    if (!S.st || S.seat < 0 || me().out) return;
    if (!confirm('Quitter la partie ? Les autres joueurs continueront sans vous.')) return;
    if (await action('leave') && S.st.status === 'waiting') {
      store.del('ch.t.' + S.game);
      location.href = './';
    }
  });

  const soundBtn = $('#soundBtn');
  soundBtn.classList.toggle('off', !S.sound);
  soundBtn.addEventListener('click', () => {
    S.sound = !S.sound;
    store.set('ch.sound', S.sound ? 'on' : 'off');
    soundBtn.classList.toggle('off', !S.sound);
    if (S.sound) { unlockAudio(); sound('card'); }
  });

  document.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => ($('#' + b.dataset.open).hidden = false)));
  document.querySelectorAll('.modal[data-dismiss]').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; });
  });

  /* ---------- Toasts ---------- */

  function toast(text, kind = 'info', ms = 3200) {
    const box = $('#toasts');
    const t = el('div', 'toast t-' + kind, text);
    box.append(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, ms);
  }

  /* ====================================================================
     Sons (synthétisés, aucun fichier)
     ==================================================================== */

  let actx = null;
  function unlockAudio() {
    if (!S.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch { actx = null; }
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  function tone(freq, start, dur, type = 'sine', vol = 0.15) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, actx.currentTime + start);
    g.gain.setValueAtTime(0.0001, actx.currentTime + start);
    g.gain.exponentialRampToValueAtTime(vol, actx.currentTime + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + start + dur);
    o.connect(g).connect(actx.destination);
    o.start(actx.currentTime + start);
    o.stop(actx.currentTime + start + dur + 0.05);
  }

  /** Bruit filtré : le frottement d'une carte. */
  function swish(freq, vol, dur) {
    const len = actx.sampleRate * dur;
    const buf = actx.createBuffer(1, len, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
    g.gain.value = vol;
    src.buffer = buf;
    src.connect(f).connect(g).connect(actx.destination);
    src.start();
  }

  function sound(kind) {
    if (!S.sound || !actx || actx.state !== 'running') return;
    try {
      if (kind === 'card') swish(2400, 0.5, 0.07);
      else if (kind === 'draw') swish(1300, 0.35, 0.12);
      else if (kind === 'call') [784, 988, 1175].forEach((f, i) => tone(f, i * 0.07, 0.2, 'triangle', 0.12));
      else if (kind === 'turn') { tone(660, 0, 0.18); tone(990, 0.12, 0.3); }
      else if (kind === 'msg') tone(880, 0, 0.12, 'sine', 0.08);
      else if (kind === 'error') tone(180, 0, 0.18, 'square', 0.05);
      else if (kind === 'buzz') { tone(220, 0, 0.25, 'sawtooth', 0.08); tone(165, 0.2, 0.4, 'sawtooth', 0.08); }
      else if (kind === 'win') [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.35, 'triangle', 0.14));
    } catch { /* audio indisponible */ }
  }

  /* ====================================================================
     Mise en page responsive : taille des cartes selon l'écran
     ==================================================================== */

  function layout(rerender = true) {
    const W = window.innerWidth, H = window.innerHeight - $('.topbar').offsetHeight;
    const v = S.view;
    const seated = v && S.seat >= 0 && v.status !== 'waiting' && !v.players[S.seat].out;
    const opps = v ? v.players.filter((_, p) => p !== S.seat).length : 1;
    const n = seated ? v.hand.length : 0;
    // Écran peu haut (téléphone couché) : pioche et défausse à gauche, main à droite
    const wide = seated && H < 540 && W > H * 1.25;
    // Adversaires : des étiquettes d'environ 150 px, qui passent à la ligne
    const oppRows = opps ? Math.ceil(opps / Math.max(1, Math.floor((Math.min(W, 1200) - 24) / 160))) : 0;
    const oppH = oppRows * 70 + 10;
    // Deux rangées de main si, sur une seule, les cartes se chevauchent trop
    const rowsFor = (cw, handW) => (n > 1 && (handW - cw) / (n - 1) < cw * 0.36 ? 2 : 1);
    const handH = (r) => 1.45 * (1.12 + (r - 1) * 0.55);
    let cw, rows = 1, big = 1;   // big : taille de la pioche et de la défausse par rapport à la main
    if (!seated) {
      // Spectateur : joueurs, pioche et défausse seulement
      cw = Math.min((W - 24) / 3.4, (H - oppH - 60) / 1.6);
    } else if (wide) {
      // Largeur : pioche, sens du jeu et défausse ≈ 3,4 cartes, puis la main ; hauteur : la main et sa consigne
      const fit = (r) => Math.min((W - 56) / 8.7, (H - oppH - 50) / handH(r));
      cw = fit(1);
      if (rowsFor(cw, W - 56 - 3.4 * cw) > 1) { rows = 2; cw = fit(2); }
    } else {
      // Hauteur : adversaires + pioche et défausse, un peu plus grandes (1,3 × 1,45 + 24 px) + consigne 34 px + main
      const fit = (r) => Math.min((W - 24) / 4.6, (H - oppH - 100) / (1.45 * 1.3 + handH(r)));
      cw = fit(1);
      if (rowsFor(cw, Math.min(W - 24, cw * 9)) > 1) { rows = 2; cw = fit(2); }
      big = 1.3;
    }
    S.cw = Math.floor(Math.max(40, Math.min(cw, 112)));
    document.documentElement.style.setProperty('--kw', Math.floor(S.cw * big) + 'px');
    S.rows = rows;
    S.wide = wide;
    document.documentElement.style.setProperty('--cw', S.cw + 'px');
    table.classList.toggle('wide', wide);
    if (rerender && S.view) render();
  }

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 80); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.st) poll(); });

  /* ---------- Go ---------- */
  if (S.game) enterGame(); else showLobby();
})();
