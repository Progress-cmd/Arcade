/* Skip-Bo — client : rendu de la table, interactions, synchronisation par polling. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const PILES = 4;
  const cardName = (c) => (c.n === 0 ? 'Skip-Bo' : String(c.n));
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
    sel: null,       // carte choisie : 'h:<id>' (main), 'stock' (pile de départ) ou 'd:<k>' (défausse k)
    lastTap: null,   // pour le double-toucher
    ptr: null,       // pointeur en cours (glisser-déposer)
    pending: null,   // état reçu pendant un glisser-déposer, appliqué au lâcher
    busy: false,
    lastEvent: null, lastChat: null, unread: 0,
    scoreSeen: -1, autoScore: false,
    pollTimer: null,
    cw: 70, wide: false,
    sound: store.get('sb.sound') !== 'off',
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
    $('#nameInput').value = store.get('sb.name') || '';
    if (error) toast(error, 'error');
  }

  $('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#nameInput').value.trim();
    if (!name) return;
    store.set('sb.name', name);
    const btn = e.submitter || $('#createForm button');
    btn.disabled = true;
    try {
      const j = await api('create', { name });
      store.set('sb.t.' + j.game, j.token);
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
    S.token = store.get('sb.t.' + S.game) || '';
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
      $('#joinInfo').textContent = `${st.players[0].name} vous invite à une partie de Skip-Bo.`;
      $('#joinName').value = store.get('sb.name') || '';
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
    store.set('sb.name', name);
    try {
      const j = await api('join', { name });
      if (j.seat >= 0) {
        S.token = j.token;
        store.set('sb.t.' + S.game, j.token);
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
    // Pendant un glisser-déposer, on attend le lâcher pour ne pas casser le geste
    if (S.ptr && S.ptr.dragging) { S.pending = st; return; }
    const prev = S.st;
    S.st = st;
    S.view = st;
    S.v = st.v;
    S.seat = st.seat;
    if (S.sel && !srcCard(S.sel)) S.sel = null;
    if (!myTurn()) S.sel = null;

    layout(false);
    render();
    handleEvents(st.events, !prev);
    handleChat(st.chat, !prev);
    handleModals(!prev);
    if (prev && st.lastMove && JSON.stringify(st.lastMove) !== JSON.stringify(prev.lastMove)) {
      if (st.lastMove.p !== S.seat) sound(st.lastMove.done ? 'done' : 'card');
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
  const accepts = (k, c) => c.n === 0 || c.n === V().build[k].n + 1;

  /** La carte désignée par une origine 'h:<id>', 'stock' ou 'd:<k>' (null si elle n'existe pas). */
  function srcCard(src) {
    const v = V(), pl = me();
    if (!v || !pl || !src) return null;
    if (src.startsWith('h:')) return v.hand.find((c) => c.id === src.slice(2)) || null;
    if (src === 'stock') return pl.stockTop;
    const d = pl.discards[+src.slice(2)];
    return d && d.length ? d[d.length - 1] : null;
  }

  /** Emplacements où l'on peut poser la carte choisie. */
  function targetsFor(src) {
    const c = srcCard(src);
    if (!c) return [];
    const t = [];
    for (let k = 0; k < PILES; k++) if (accepts(k, c)) t.push('build:' + k);
    if (src.startsWith('h:')) for (let k = 0; k < PILES; k++) t.push(`disc:${S.seat}:${k}`);
    return t;
  }

  /** L'origine jouable sous l'élément touché, s'il y en a une. */
  function srcAt(node) {
    if (!node || S.seat < 0) return null;
    const card = node.closest('.card[data-id]');
    const spot = node.closest('[data-loc]');
    if (!spot) return null;
    const loc = spot.dataset.loc;
    if (card && loc === 'hand:' + S.seat) return 'h:' + card.dataset.id;
    if (loc === 'stock:' + S.seat && me().stockTop) return 'stock';
    if (loc.startsWith(`disc:${S.seat}:`)) {
      const k = +loc.split(':')[2];
      if (me().discards[k].length) return 'd:' + k;
    }
    return null;
  }

  /** La meilleure pile centrale pour une carte (double-toucher) : l'exacte, sinon la plus haute pour une Skip-Bo. */
  function autoTarget(src) {
    const c = srcCard(src);
    if (!c) return null;
    let best = -1;
    for (let k = 0; k < PILES; k++) {
      if (accepts(k, c) && (best < 0 || V().build[k].n > V().build[best].n)) best = k;
    }
    return best < 0 ? null : 'build:' + best;
  }

  /* ====================================================================
     Rendu
     ==================================================================== */

  const table = $('#table');

  function cardEl(c) {
    const range = c.n === 0 ? 'w' : c.n <= 4 ? 'r1' : c.n <= 8 ? 'r2' : 'r3';
    const n = el('div', 'card ' + range);
    n.dataset.id = c.id;
    const R = c.n === 0 ? 'SB' : c.n === 6 || c.n === 9 ? `<u>${c.n}</u>` : String(c.n);
    const mid = c.n === 0 ? '<b>SB</b><small>Skip-Bo</small>' : `<b>${R}</b>`;
    n.innerHTML = `<span class="ci tl">${R}</span><span class="pip">${mid}</span><span class="ci br">${R}</span>`;
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

  /** Pile de départ d'un joueur : la carte du dessus (ou un dos si on ne la connaît pas encore) et le nombre de cartes. */
  function stockEl(pl, p, cls) {
    const s = el('div', cls + ' stock');
    s.dataset.loc = 'stock:' + p;
    s.dataset.label = 'Vide';
    if (pl.stock) {
      if (pl.stock > 1) s.append(el('div', 'card back under'));
      s.append(pl.stockTop ? cardEl(pl.stockTop) : backEl(), el('span', 'count', String(pl.stock)));
    } else s.classList.add('empty');
    return s;
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
      const head = el('div', 'opp-head');
      const body = el('div', 'opp-who');
      body.append(el('div', 'name', pl.name));
      const meta = el('div', 'opp-meta');
      if (pl.out) meta.append(el('span', '', 'a quitté'));
      else if (v.status !== 'waiting') {
        meta.append(el('span', 'nb', `✋ ${pl.cards}`));
        if (pl.score) meta.append(el('span', 'pts', `${pl.score} pts`));
      }
      body.append(meta);
      head.append(avatarEl(pl, p), body);
      o.append(head);
      if (!pl.out && v.status !== 'waiting') {
        const piles = el('div', 'opp-piles');
        piles.append(stockEl(pl, p, 'mslot'));
        pl.discards.forEach((d, k) => {
          const m = el('div', 'mslot disc');
          m.dataset.loc = `disc:${p}:${k}`;
          if (d.length) {
            m.append(cardEl(d[d.length - 1]));
            if (d.length > 1) m.append(el('span', 'count small', String(d.length)));
          } else m.classList.add('empty');
          piles.append(m);
        });
        o.append(piles);
      }
      o.title = pl.out ? pl.name : `${pl.name} — voir ses défausses`;
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
    deck.dataset.label = 'Pioche';
    if (v.deck) deck.append(backEl(), el('span', 'count', String(v.deck))); else deck.classList.add('empty');
    deck.title = `Pioche : ${plural(v.deck, 'carte')}` + (v.done ? ` (+ ${v.done} dans les piles terminées)` : '');
    const dw = el('div', 'bwrap');
    dw.append(deck, el('span', 'need', 'Pioche'));
    box.append(dw);

    const builds = el('div', 'builds');
    v.build.forEach((b, k) => {
      const w = el('div', 'bwrap');
      const s = el('div', 'slot build');
      s.dataset.loc = 'build:' + k;
      s.dataset.label = '1';
      if (b.top) {
        s.append(cardEl(b.top));
        // Une carte Skip-Bo au sommet : on rappelle la valeur qu'elle représente
        if (b.top.n === 0) s.append(el('span', 'val', String(b.n)));
      } else s.classList.add('empty');
      w.append(s, el('span', 'need', b.n ? `→ ${b.n + 1}` : '→ 1'));
      builds.append(w);
    });
    box.append(builds);
  }

  function renderMine() {
    const v = V();
    const box = $('#mine');
    box.innerHTML = '';
    const pl = me();
    if (!pl || pl.out || v.status === 'waiting') { box.hidden = true; return; }
    box.hidden = false;
    const turn = myTurn();

    // Pile de départ (au centre, à côté des piles de construction, quand l'écran est peu haut)
    const sw = el('div', 'bwrap mystock');
    const stock = stockEl(pl, S.seat, 'slot');
    if (S.sel === 'stock') stock.querySelector('.card:not(.under)')?.classList.add('selected');
    if (turn && pl.stockTop) stock.classList.add('movable');
    sw.append(stock, el('span', 'need', 'Ma pile'));

    // Défausses, en éventail vertical
    const discs = el('div', 'discs');
    pl.discards.forEach((d, k) => {
      const s = el('div', 'slot dpile');
      s.dataset.loc = `disc:${S.seat}:${k}`;
      s.dataset.label = 'Défausse';
      d.forEach((c, i) => {
        const n = cardEl(c);
        if (i === d.length - 1 && S.sel === 'd:' + k) n.classList.add('selected');
        s.append(n);
      });
      if (!d.length) s.classList.add('empty');
      if (turn && d.length) s.classList.add('movable');
      discs.append(s);
    });

    const board = el('div', 'board');
    if (S.wide) $('#center').append(sw); else board.append(sw);
    board.append(discs);
    box.append(board);

    // Consigne et bouton
    const bar = el('div', 'actions');
    if (turn) {
      if (!v.hand.length) {
        bar.append(el('span', 'hint', 'Plus de carte à piocher'));
        const pass = el('button', 'btn btn-gold btn-small', 'Finir mon tour');
        pass.onclick = () => action('pass');
        bar.append(pass);
      } else {
        bar.append(el('span', 'hint', !S.sel ? (S.wide ? 'Jouez, puis défaussez pour finir' : 'Jouez au centre, puis défaussez une carte pour finir')
          : S.sel.startsWith('h:') ? (S.wide ? 'Au centre, ou en défausse pour finir' : 'Posez-la au centre, ou sur une défausse pour finir le tour')
            : 'Posez-la sur une pile du centre'));
      }
    } else if (v.status === 'playing') {
      bar.append(el('span', 'hint wait', `Tour de ${v.players[v.turn].name}…`));
    } else {
      bar.append(el('span', 'hint wait', ' '));
    }

    // Main
    const hand = el('div', 'hand');
    hand.dataset.loc = 'hand:' + S.seat;
    const sorted = [...v.hand].sort((a, b) => (a.n || 13) - (b.n || 13) || (a.id < b.id ? -1 : 1));
    for (const c of sorted) {
      const n = cardEl(c);
      n.classList.add('in-hand');
      if (S.sel === 'h:' + c.id) n.classList.add('selected');
      if (turn) n.classList.add('movable');
      hand.append(n);
    }
    const right = el('div', 'play-area');
    right.append(bar, hand);
    box.append(right);
  }

  /** Position des cartes : main en éventail, défausses en colonne. */
  function placeFans() {
    const hand = table.querySelector('.hand');
    if (hand) {
      const cards = [...hand.children];
      const W = hand.clientWidth, cw = S.cw, n = cards.length;
      const step = n > 1 ? Math.min(cw * 1.08, (W - cw) / (n - 1)) : 0;
      const x0 = Math.max(0, (W - cw - step * (n - 1)) / 2);
      cards.forEach((c, k) => { c.style.left = x0 + k * step + 'px'; c.style.zIndex = k + 1; });
    }
    table.querySelectorAll('.dpile').forEach((pile) => {
      const cards = [...pile.querySelectorAll('.card')];
      const ch = S.cw * 1.45, H = pile.clientHeight, n = cards.length;
      const step = n > 1 ? Math.min(ch * 0.24, (H - ch) / (n - 1)) : 0;
      cards.forEach((c, k) => { c.style.top = k * step + 'px'; c.style.zIndex = k + 1; });
    });
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

  function render(flipFrom) {
    if (!S.view) return;
    const snap = snapshot();
    if (flipFrom) for (const [id, r] of flipFrom) snap.set(id, r);
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
        // Carte nouvelle : piochée (dans ma main), ou jouée par un adversaire depuis sa place
        let src = null;
        if (n.closest('.hand')) src = 'deck';
        else if (lm && lm.id === n.dataset.id) src = lm.from.startsWith('hand:') ? 'seat:' + lm.p : lm.from;
        const s = src && table.querySelector(`[data-loc="${src}"]`);
        if (s) r0 = s.getBoundingClientRect();
      }
      if (!r0) return;
      const r1 = n.getBoundingClientRect();
      const dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      n.animate(
        [{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 500 }, { transform: 'none', zIndex: 500 }],
        { duration: 300, easing: 'cubic-bezier(.2, .8, .25, 1)' },
      );
      if (!snap.has(n.dataset.id)) n.classList.add('flash');
    });
  }

  /* ====================================================================
     Coups : affichage anticipé, puis envoi au serveur
     ==================================================================== */

  /** L'état tel qu'il sera après le coup, pour l'afficher sans attendre le serveur. */
  function optimistic(src, to) {
    const v = structuredClone(S.st);
    const pl = v.players[S.seat];
    const card = srcCard(src);
    if (src.startsWith('h:')) { v.hand = v.hand.filter((c) => c.id !== card.id); pl.cards--; }
    else if (src === 'stock') { pl.stock--; pl.stockTop = null; }   // la carte suivante est encore inconnue
    else pl.discards[+src.slice(2)].pop();
    if (to.startsWith('build:')) {
      const b = v.build[+to.slice(6)];
      b.n++;
      b.top = card;
    } else {
      pl.discards[+to.split(':')[2]].push(card);
      // Fin du tour : la main passe au joueur suivant encore en jeu
      do v.turn = (v.turn + 1) % v.players.length; while (v.players[v.turn].out && v.turn !== S.seat);
    }
    v.lastMove = { id: card.id, p: S.seat };
    return v;
  }

  function doMove(src, to, flipFrom) {
    if (S.busy) return;
    const card = srcCard(src);
    S.sel = null;
    S.view = optimistic(src, to);
    render(flipFrom);
    sound('card');
    if (to.startsWith('build:')) {
      const from = src.startsWith('h:') ? 'hand' : src === 'stock' ? 'stock' : 'disc';
      action('play', { from, card: card.id, pile: from === 'disc' ? +src.slice(2) : -1, to: +to.slice(6) })
        .then((ok) => { if (ok && S.st.lastMove && S.st.lastMove.done) sound('done'); });
    } else {
      action('discard', { card: card.id, pile: +to.split(':')[2] });
    }
  }

  function select(src) {
    S.sel = src;
    render();
  }
  function clearSel() {
    if (!S.sel) return;
    S.sel = null;
    render();
  }

  function refuseMove(to) {
    const b = V().build[+to.slice(6)];
    toast(`Coup impossible : cette pile attend ${b.n ? 'le ' + (b.n + 1) : 'un 1'} (ou une Skip-Bo).`, 'error', 2000);
    sound('error');
    clearSel();
  }

  /** Toucher simple : choisir une carte, puis sa destination. */
  function onTap(node) {
    const v = V();
    const spot = node.closest('#table [data-loc]');
    const loc = spot ? spot.dataset.loc : '';
    const src = srcAt(node);

    // Un adversaire : retirer s'il est absent, sinon voir ses défausses
    const opp = /^(?:seat|stock|disc):(\d+)/.exec(loc);
    if (opp && +opp[1] !== S.seat) {
      const p = +opp[1];
      clearSel();
      const pl = v.players[p];
      if (S.seat >= 0 && !pl.out && v.status !== 'waiting' && !(v.online && v.online[p])
          && confirm(`${pl.name} semble absent. Le retirer de la partie pour continuer sans lui ?`)) {
        action('kick', { target: p });
      } else if (!pl.out) openOpp(p);
      return;
    }
    if (S.seat < 0) return;

    // Double-toucher sur une carte : elle part sur la meilleure pile centrale
    const now = performance.now();
    const dbl = src && S.lastTap && S.lastTap.src === src && now - S.lastTap.t < 380;
    S.lastTap = src ? { src, t: now } : null;
    if (dbl && myTurn()) {
      const to = autoTarget(src);
      S.lastTap = null;
      if (to) doMove(src, to);
      else { toast('Aucune pile du centre ne prend cette carte.', 'error', 1800); sound('error'); clearSel(); }
      return;
    }

    if (S.sel) {
      if (src === S.sel) { clearSel(); return; }
      if (targetsFor(S.sel).includes(loc)) {
        doMove(S.sel, loc);
        return;
      }
      if (src) { select(src); return; }
      if (loc.startsWith('build:')) { refuseMove(loc); return; }
      clearSel();
      return;
    }
    if (src) {
      if (myTurn()) select(src);
      else if (playing()) toast("Ce n'est pas votre tour.", 'error', 1600);
    }
  }

  table.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !S.view) return;
    unlockAudio();
    const src = myTurn() && !S.busy ? srcAt(e.target) : null;
    S.ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, src, target: e.target, dragging: false };
    if (src) table.setPointerCapture(e.pointerId);
  });

  table.addEventListener('pointermove', (e) => {
    const p = S.ptr;
    if (!p || p.id !== e.pointerId || !p.src) return;
    if (!p.dragging) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
      startDrag(p);
    }
    p.ghost.style.transform = `translate(${e.clientX - p.x}px, ${e.clientY - p.y}px)`;
    // Surlignage neutre de l'emplacement survolé, qu'il accepte la carte ou non
    const over = dropTargetAt(e.clientX, e.clientY);
    table.querySelectorAll('.drop-hover').forEach((n) => n !== over && n.classList.remove('drop-hover'));
    if (over) over.classList.add('drop-hover');
  });

  /** La carte saisie : celle du dessus de la pile, ou la carte de la main. */
  function srcNode(src) {
    if (src.startsWith('h:')) return table.querySelector(`.hand .card[data-id="${CSS.escape(src.slice(2))}"]`);
    const loc = src === 'stock' ? 'stock:' + S.seat : `disc:${S.seat}:${src.slice(2)}`;
    const cards = table.querySelectorAll(`[data-loc="${loc}"] .card:not(.under)`);
    return cards[cards.length - 1];
  }

  function startDrag(p) {
    p.dragging = true;
    S.sel = p.src;
    render();
    p.card = srcNode(p.src);
    const r = p.card.getBoundingClientRect();
    p.ghost = el('div', 'ghost');
    const g = p.card.cloneNode(true);
    g.classList.remove('selected', 'flash');
    g.style.left = r.left + 'px';
    g.style.top = r.top + 'px';
    g.style.zIndex = '';
    p.ghost.append(g);
    p.card.classList.add('dragging');
    document.body.append(p.ghost);
  }

  function dropTargetAt(x, y) {
    const n = document.elementFromPoint(x, y);
    const spot = n && n.closest('#table [data-loc]');
    return spot && /^(build|disc):/.test(spot.dataset.loc) ? spot : null;
  }

  function endPointer(e, cancelled) {
    const p = S.ptr;
    if (!p || p.id !== e.pointerId) return;
    S.ptr = null;
    if (p.dragging) {
      const over = cancelled ? null : dropTargetAt(e.clientX, e.clientY);
      const g = p.ghost.firstChild;
      const flip = new Map([[g.dataset.id, g.getBoundingClientRect()]]);
      p.ghost.remove();
      p.card.classList.remove('dragging');
      table.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
      const to = over && over.dataset.loc;
      if (S.pending) { const st = S.pending; S.pending = null; applyState(st); }
      if (to && myTurn() && targetsFor(p.src).includes(to)) doMove(p.src, to, flip);
      else if (to && to.startsWith('build:')) { S.sel = p.src; refuseMove(to); }
      else { S.sel = null; render(flip); }
      return;
    }
    if (!cancelled) onTap(p.target);
  }
  table.addEventListener('pointerup', (e) => endPointer(e, false));
  table.addEventListener('pointercancel', (e) => endPointer(e, true));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal[data-dismiss]').forEach((m) => (m.hidden = true));
      $('#menu').hidden = true;
      clearSel();
    }
  });

  /* ---------- Détail des piles d'un adversaire ---------- */

  function openOpp(p) {
    const v = V();
    const pl = v.players[p];
    $('#oppTitle').textContent = pl.name;
    $('#oppText').textContent = `${plural(pl.stock, 'carte')} dans sa pile de départ, ${plural(pl.cards, 'carte')} en main.`
      + (pl.wins ? ` ${plural(pl.wins, 'manche')} gagnée${pl.wins > 1 ? 's' : ''}.` : '');
    const box = $('#oppDetail');
    box.innerHTML = '';
    const col = (label, cards) => {
      const c = el('div', 'od-col');
      c.append(el('span', 'od-label', label));
      const pile = el('div', 'od-pile');
      if (!cards.length) pile.append(el('span', 'od-empty', 'vide'));
      cards.forEach((card, i) => { const n = cardEl(card); n.style.top = i * 22 + 'px'; pile.append(n); });
      pile.style.height = `calc(var(--oh) + ${Math.max(0, cards.length - 1) * 22}px)`;
      c.append(pile);
      return c;
    };
    box.append(col('Pile', pl.stockTop ? [pl.stockTop] : []));
    pl.discards.forEach((d, k) => box.append(col(`Défausse ${k + 1}`, d)));
    $('#oppModal').hidden = false;
  }

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
        case 'done': toast(ev.seat === S.seat ? 'Pile terminée !' : ev.text, 'done', 2600); break;
        case 'warn': if (ev.seat !== S.seat) { toast(ev.text, 'warn', 3500); sound('buzz'); } break;
        case 'refill': if (ev.seat !== S.seat) toast(ev.text, 'info', 2200); break;
        case 'join': toast(ev.text, 'info', 3000); sound('turn'); break;
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
      $('#stockChoice').hidden = !host;
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
        const left = Object.entries(lr.stocks).reduce((s, [p, n]) => s + (+p === lr.winner ? 0 : n), 0);
        text.textContent = `${won ? 'Vous avez vidé votre' : v.players[lr.winner].name + ' a vidé sa'} pile de départ : +${lr.points} points`
          + ` (25 + 5 × ${plural(left, 'carte')} restée${left > 1 ? 's' : ''} chez les adversaires).`;
      } else text.textContent = 'Il ne reste plus assez de joueurs pour continuer.';
    } else {
      icon.textContent = '📋';
      title.textContent = 'Scores';
      text.textContent = v.status === 'waiting' ? 'La partie n\'a pas encore commencé.'
        : `Manche ${v.round} en cours. Le gagnant d'une manche marque 25 points, plus 5 par carte restée dans les piles adverses.`;
    }

    const tbl = $('#scoreTable');
    tbl.innerHTML = '<thead><tr><th>Joueur</th><th>Pile</th><th>Manches</th><th>Points</th></tr></thead>';
    const body = el('tbody');
    const rows = v.players.map((pl, p) => [pl, p]).sort(([a], [b]) => a.out - b.out || b.score - a.score || a.stock - b.stock);
    for (const [pl, p] of rows) {
      const tr = el('tr', (p === S.seat ? 'me' : '') + (ended && v.winners.includes(p) ? ' winner' : '') + (pl.out ? ' out' : ''));
      tr.append(el('td', 'nm', pl.name));
      const stock = ended && lr && lr.round === v.round ? lr.stocks[p] : pl.stock;
      tr.append(el('td', '', pl.out || v.status === 'waiting' || stock === undefined ? '—' : String(stock)));
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
  $('#startBtn').addEventListener('click', () => action('start', { stock: +$('#stockSelect').value }));

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
      try { await navigator.share({ title: 'Une partie de Skip-Bo ?', text: 'Viens jouer au Skip-Bo avec moi !', url }); return; }
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
      store.del('sb.t.' + S.game);
      location.href = './';
    }
  });

  const soundBtn = $('#soundBtn');
  soundBtn.classList.toggle('off', !S.sound);
  soundBtn.addEventListener('click', () => {
    S.sound = !S.sound;
    store.set('sb.sound', S.sound ? 'on' : 'off');
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

  function sound(kind) {
    if (!S.sound || !actx || actx.state !== 'running') return;
    try {
      if (kind === 'card') {
        const len = actx.sampleRate * 0.07;
        const buf = actx.createBuffer(1, len, actx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
        const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
        f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 0.8;
        g.gain.value = 0.5;
        src.buffer = buf;
        src.connect(f).connect(g).connect(actx.destination);
        src.start();
      } else if (kind === 'turn') { tone(660, 0, 0.18); tone(990, 0.12, 0.3); }
      else if (kind === 'msg') tone(880, 0, 0.12, 'sine', 0.08);
      else if (kind === 'error') tone(180, 0, 0.18, 'square', 0.05);
      else if (kind === 'done') [523, 659, 784].forEach((f, i) => tone(f, i * 0.08, 0.28, 'triangle', 0.14));
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
    // Écran peu haut (téléphone couché) : ma pile de départ passe au centre, la main à côté des défausses
    const wide = H < 560 && W > H * 1.2;
    // Adversaires : une rangée (qui défile sur téléphone), ou deux rangées équilibrées si la place manque
    const avail = Math.min(W, 1200) - 24;
    const gwOf = (cw) => Math.max(24, Math.min(cw * 0.5, 44));
    const oppW = (gw) => gw * 5.3 + (wide ? 130 : 30) + 8;
    // Taille des cartes adverses pour tenir sur une rangée de n emplacements
    const gwFit = (n) => (avail / n - 46) / 5.3;
    // Une seule rangée tant que les cartes adverses y gardent une taille lisible
    const fitsOneRow = (cw) => gwFit(opps) >= Math.min(gwOf(cw), 32);
    let cw, two = false;
    if (!seated) {
      // Spectateur : joueurs et piles centrales seulement
      cw = Math.min((W - 24) / 6, 80);
    } else if (wide) {
      // Hauteur : adversaires (0,73 + 16 px) + centre 1,45 + 16 px + défausses 2,1 (+ ~40 px)
      // Largeur : défausses 4,7 + main 4,9 ; et au centre, pioche + 4 piles + ma pile ≈ 7,6
      cw = Math.min((W - 40) / 9.8, (H - 72) / 4.55);
    } else {
      // Hauteur : adversaires (0,73 + 60 px par rangée) + centre 1,45 + 16 px + défausses 2,3 + consigne 30 px + main 1,7
      const size = (r) => Math.min((W - 24) / 6.1, (H - 82 - 60 * r) / (6.0 + 0.73 * r));
      cw = size(1);
      if (W >= 600 && !fitsOneRow(cw)) { two = true; cw = size(2); }
    }
    S.cw = Math.floor(Math.max(36, Math.min(cw, 96)));
    S.wide = wide;
    // Sur deux rangées, autant d'adversaires en haut qu'en bas (3 + 2 plutôt que 4 + 1)
    const perRow = Math.ceil(opps / 2);
    let gw = gwOf(S.cw);
    if (!seated) {
      // Spectateur : les joueurs passent à la ligne, avec les plus grandes cartes qui laissent la place au centre
      two = true;
      let rest = 0;
      for (gw = 44; gw > 24; gw--) {
        const rowsNeeded = Math.ceil(opps / Math.max(1, Math.floor(avail / oppW(gw))));
        rest = H - 40 - rowsNeeded * (gw * 1.45 + (wide ? 22 : 56));
        if (rest >= Math.min(S.cw, 60) * 1.45 + 30) break;
      }
      S.cw = Math.floor(Math.max(36, Math.min(S.cw, (rest - 30) / 1.45)));
      document.documentElement.style.setProperty('--cw', S.cw + 'px');
    } else if (W >= 600 && !wide) gw = Math.floor(Math.max(24, Math.min(gw, gwFit(two ? perRow : opps))));
    document.documentElement.style.setProperty('--cw', S.cw + 'px');
    document.documentElement.style.setProperty('--gw', gw + 'px');
    table.classList.toggle('wide', wide);
    table.classList.toggle('two-rows', two);
    $('#opps').style.maxWidth = two && seated ? Math.ceil(perRow * oppW(gw)) + 'px' : '';
    if (rerender && S.view) render();
  }

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 80); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.st) poll(); });

  /* ---------- Go ---------- */
  if (S.game) enterGame(); else showLobby();
})();
