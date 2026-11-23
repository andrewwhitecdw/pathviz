'use strict';

const SVG = 'http://www.w3.org/2000/svg';
const $ = (sel) => document.querySelector(sel);

// Geometry of the diagram. There are two arrangements of the same parts:
//   wide     interface cards in columns left and right of the hooks (wideLayout)
//   compact  interface cards in a row above the hooks, everything closer
// The compact one keeps the text readable when the page gets half a screen.
// In both, the chips of a hook are laid out along one axis.
// wideLayout builds the wide arrangement for the width the diagram gets. Between
// WIDE_MIN and WIDE_FULL px, the cards, the boxes, and the text keep their size
// and only the connecting lines get shorter. Above WIDE_FULL, everything grows
// together.
const WIDE_MIN = 1100, WIDE_FULL = 1540;
// The widths that never change: two interface cards, three hook boxes, the side
// margins. The rest of the width is the connecting lines.
const WIDE_FIXED = 846, WIDE_LINES = 694;

// nicCount is how many interface cards a column has: in the hooks-only view the
// part below the hooks is short, and the socket bar must stay below the cards.
function wideLayout(avail, hooksOnly, nicCount) {
  const W = Math.round(Math.max(WIDE_MIN, Math.min(WIDE_FULL, avail)));
  const g = (W - WIDE_FIXED) / WIDE_LINES; // 1 at full width
  let x = 10;
  const step = (px) => { x = Math.round(x + px); return x; };
  const cardL = x + 65; step(130);
  const busL = step(35 * g);
  const inX = step(35 * g);
  const preL = step(99 * g); step(242);
  const route1 = step(89 * g);
  const fwdL = step(109 * g); step(162);
  const merge = step(109 * g);
  const postL = step(59 * g); step(162);
  const out = step(89 * g);
  const busR = step(35 * g);
  step(35 * g); const cardR = x + 65;
  const mid = (a, b) => Math.round((a + b) / 2);
  // An arrowhead needs a line that is long enough to carry it.
  // Without the stage chips, the INPUT and OUTPUT boxes need much less height.
  const boxY = hooksOnly ? 160 : 205;
  const route2Y = hooksOnly ? 214 : 318;
  const sockY = hooksOnly ? Math.max(246, 70 + (Math.max(nicCount, 1) - 1) * 42 + 33) : 345;
  const arrows = [[route1, 112, 90], [route1, hooksOnly ? mid(182, sockY) : 306, 90], [merge, 106, -90], [mid(busL, busR), 8, 180]];
  for (const [from, to] of [[inX, preL], [route1, fwdL], [fwdL + 162, merge], [postL + 162, out]]) {
    if (to - from >= 44) arrows.push([mid(from, to), 70, 0]);
  }
  const roomAtRoute1 = fwdL - (preL + 242);
  return {
    compact: false, key: `wide${W}`,
    viewX: 0, viewY: -18, viewW: W, lineY: 70, centerX: W / 2,
    headings: { in: 'Packets arrive on', out: 'Packets leave through' },
    nodes: {
      in: [inX, 70], out: [out, 70],
      route1: [route1, 70], merge: [merge, 70], route2: [merge, route2Y],
      procIn: [route1, sockY], procOut: [merge, sockY],
    },
    hooks: {
      PREROUTING: { x: preL + 41, y: 70, dx: 80, dy: 0, entry: 'in', exit: 'route1' },
      FORWARD: { x: fwdL + 41, y: 70, dx: 80, dy: 0, entry: 'route1', exit: 'merge' },
      POSTROUTING: { x: postL + 41, y: 70, dx: 80, dy: 0, entry: 'merge', exit: 'out' },
      INPUT: { x: route1, y: 160, dx: 0, dy: 40, entry: 'route1', exit: 'procIn' },
      OUTPUT: { x: merge, y: 270, dx: 0, dy: -38, entry: 'route2', exit: 'merge' },
    },
    chip: { w: 62, h: 24 },
    // In the hooks-only view, every hook is one box.
    hookBox: { w: 150, h: 44 },
    hookCenter: { PREROUTING: [preL + 121, 70], FORWARD: [fwdL + 81, 70], POSTROUTING: [postL + 81, 70], INPUT: [route1, boxY], OUTPUT: [merge, boxY] },
    nic: { w: 130, h: 34, max: 7 },
    // The loopback line leaves the "out" side and re-enters on the "in" side.
    loop: [[busR, 70], [busR, 8], [busL, 8], [busL, 70]],
    loopLabel: { x: mid(busL, busR), y: -2, text: 'loopback traffic re-enters here' },
    arrows,
    routeLabels: {
      route1: [0, -20, 'middle', roomAtRoute1 >= 130 ? 'routing decision' : 'routing'],
      route2: [18, 4, 'start', 'routing decision'],
    },
    sock: { x: 10, w: W - 20, y: sockY, h: 22, mid: sockY + 11 },
    proc: { x0: 10, y0: sockY + 40, w: 180, h: 46, gap: 10, rowStep: 56, perRow: Math.floor((W - 10) / 190), max: 2 * Math.floor((W - 10) / 190) },
    // nicCards places the cards of one side and says how each one is wired to its node.
    nicCards(side, count) {
      const cx = side === 'in' ? cardL : cardR, bus = side === 'in' ? busL : busR;
      const edge = side === 'in' ? cx + 65 : cx - 65;
      const cards = [];
      for (let i = 0; i < count; i++) {
        const y = 70 + i * 42;
        cards.push({ cx, cy: y, wire: [[edge, y], [bus, y], [bus, 70]] });
      }
      return { cards, heading: { x: cx, y: 40, anchor: 'middle' }, more: { x: cx, y: 70 + count * 42 - 4, anchor: 'middle' } };
    },
  };
}

// compactLayout builds the compact arrangement. Its hooks-only variant has no
// stage chips to make room for, so it is narrower and shorter: the same boxes
// and text then come out larger in a narrow place.
//
// width is the width to lay the diagram out for, in its own units. Anything
// above the natural width goes into the connecting lines. This is how the
// diagram fills a place that is wider than its natural shape (an iframe of a
// fixed height) instead of leaving blank space on its sides.
function compactLayout(hooksOnly, width) {
  const X = hooksOnly
    ? { in: 28, route1: 232, merge: 436, out: 640 }
    : { in: 30, route1: 284, merge: 495, out: 710 };
  const naturalWidth = X.out - X.in + 112;
  const extra = Math.max(0, Math.round((width || 0) - naturalWidth));
  if (extra) {
    const f = (X.out - X.in + extra) / (X.out - X.in);
    X.route1 = Math.round(X.in + (X.route1 - X.in) * f);
    X.merge = Math.round(X.in + (X.merge - X.in) * f);
    X.out += extra;
  }
  const center = (a, b) => Math.round((a + b) / 2);
  const Y = hooksOnly
    ? { box: 236, route2: 286, sock: 316 }
    : { box: 286, route2: 402, sock: 428 };
  const nic = { w: 104, h: 34, max: 3 };
  // The outermost cards sit right above the "in" and "out" nodes.
  const left = X.in - nic.w / 2 - 4, right = X.out + nic.w / 2 + 4;
  const mid = Math.round((X.in + X.out) / 2);
  const sockW = right - left - 8;
  return {
    compact: true, key: `compact${extra}`, naturalWidth,
    viewX: left, viewY: 0, viewW: right - left, lineY: 160, centerX: mid,
    // The headings are as narrow as a card, so they need no extra margins.
    headings: { in: 'Arriving on', out: 'Leaving through' },
    nodes: {
      in: [X.in, 160], out: [X.out, 160],
      route1: [X.route1, 160], merge: [X.merge, 160], route2: [X.merge, Y.route2],
      procIn: [X.route1, Y.sock], procOut: [X.merge, Y.sock],
    },
    hooks: {
      // The chips of a hook are centered between the nodes around it.
      PREROUTING: { x: center(X.in, X.route1) - 58, y: 160, dx: 58, dy: 0, entry: 'in', exit: 'route1' },
      FORWARD: { x: center(X.route1, X.merge) - 29, y: 160, dx: 58, dy: 0, entry: 'route1', exit: 'merge' },
      POSTROUTING: { x: center(X.merge, X.out) - 29, y: 160, dx: 58, dy: 0, entry: 'merge', exit: 'out' },
      INPUT: { x: X.route1, y: 246, dx: 0, dy: 38, entry: 'route1', exit: 'procIn' },
      OUTPUT: { x: X.merge, y: 354, dx: 0, dy: -36, entry: 'route2', exit: 'merge' },
    },
    chip: { w: 52, h: 24 },
    hookBox: { w: 124, h: 40 },
    hookCenter: {
      PREROUTING: [center(X.in, X.route1), 160],
      FORWARD: [center(X.route1, X.merge), 160],
      POSTROUTING: [center(X.merge, X.out), 160],
      INPUT: [X.route1, Y.box], OUTPUT: [X.merge, Y.box],
    },
    nic,
    // The loopback line runs between the cards and the hooks.
    loop: [[X.out, 106], [X.in, 106]],
    loopLabel: { x: mid, y: 99, text: 'loopback' },
    arrows: hooksOnly
      ? [[X.route1, 198, 90], [X.route1, 290, 90], [X.merge, 196, -90], [mid + 60, 106, 180]]
      : [[X.route1, 202, 90], [X.route1, 394, 90], [X.merge, 200, -90], [mid + 60, 106, 180]],
    routeLabels: { route1: [0, -19, 'middle', 'routing'], route2: [17, 4, 'start', 'routing'] },
    sock: { x: left + 4, w: sockW, y: Y.sock, h: 22, mid: Y.sock + 11 },
    proc: { x0: left + 4, y0: Y.sock + 40, w: Math.floor((sockW - 30) / 4), h: 46, gap: 10, rowStep: 56, perRow: 4, max: 8 },
    nicCards(side, count) {
      const nodeX = side === 'in' ? X.in : X.out;
      const cards = [];
      for (let i = 0; i < count; i++) {
        // The outermost card sits right above its node, so its wire is straight.
        const cx = side === 'in' ? nodeX + i * 110 : nodeX - i * 110;
        cards.push({ cx, cy: 44, wire: i === 0 ? [[cx, 61]] : [[cx, 61], [cx, 82], [nodeX, 82]] });
      }
      // The heading is centered above the row of cards.
      const rowCenter = count ? (cards[0].cx + cards[count - 1].cx) / 2 : nodeX;
      return {
        cards,
        heading: { x: rowCenter, y: 13, anchor: 'middle' },
        more: { x: side === 'in' ? nodeX + count * 110 - 44 : nodeX - count * 110 + 44, y: 48, anchor: side === 'in' ? 'start' : 'end' },
      };
    },
  };
}

// G is the arrangement in use. buildDiagram picks it for the box the diagram
// gets, the view, and the number of interface cards and processes.
// diagramHeight is Infinity when the page is free to grow (the full view).
let diagramWidth = WIDE_FULL, diagramHeight = Infinity;
let G = wideLayout(WIDE_FULL, false, 1);

function pickLayout(hooksOnly, nicCount, procCount) {
  if (diagramWidth >= WIDE_MIN) return wideLayout(diagramWidth, hooksOnly, nicCount);
  const base = compactLayout(hooksOnly, 0);
  if (!Number.isFinite(diagramHeight) || diagramHeight <= 0) return base;
  // The box has a fixed height. When the diagram at its natural shape would
  // be limited by that height, lay it out wider, so that it fills the width too.
  const height = diagramBottom(base, Math.min(procCount, base.proc.max), procCount > base.proc.max);
  const fit = (diagramWidth * height) / diagramHeight;
  if (fit < base.viewW * 1.03) return base;
  // Steps of 8 units keep a slow resize from rebuilding the diagram all the time.
  const width = Math.min(Math.round(fit / 8) * 8, Math.round(base.viewW * 1.6));
  return compactLayout(hooksOnly, base.naturalWidth + (width - base.viewW));
}

// diagramBottom is the y coordinate where a diagram that draws that many
// processes ends: right under its last row of them (and the note about the ones
// that do not fit, if there is one).
function diagramBottom(layout, procCount, withNote) {
  // The view asked for no processes at all (?procs=): the socket bar is the end.
  if (!procCount && view.procs) return layout.sock.y + layout.sock.h + 2;
  const { proc } = layout;
  const rows = Math.max(1, Math.ceil(procCount / proc.perRow));
  return proc.y0 + (rows - 1) * proc.rowStep + proc.h + (withNote ? 20 : 2);
}

// layoutCounts tells how many interface cards and processes the diagram draws.
function layoutCounts() {
  return [
    Math.min(state.host.ifaces.filter(ifaceShown).length, 7),
    state.host.procs.filter(procShown).length + state.extras.length,
  ];
}
const MAX_ROWS = 300;

// What this page shows comes from its URL, so that a view can be embedded:
//   ?view=embed         only the diagram, no filter fields and no tables. An
//                       embedded view is read-only: its cards cannot be clicked.
//   ?tables=packets,stages  which tables to show. In the full view the others
//                       start collapsed (a click on a table's header folds and
//                       unfolds it). In an embedded view it puts the tables
//                       below the diagram, and without it the view has a switch
//                       between the packet's path and the packets.
//   ?ifaces=eth0,lo     only these interface cards
//   ?procs=nginx,:8080  only these processes (by name or by a port they listen on)
//   ?detail=hooks       one box per hook, without the raw/mangle/nat/filter stages
//   ?theme=dark|light   force the colors (index.html applies it before the first paint)
//   ?speed=0.5          how fast a packet travels through the diagram, as a
//                       playback rate: 1 is normal, and the range is 0.25 to 2
//                       in steps of 0.25. slow, medium, and fast stand for 0.5,
//                       1, and 1.5.
// A list parameter that is present but empty hides all the cards of its kind.
//
// An embedded view also has its own display filter. It picks what to show out
// of the packets pathviz traces, so several embeds of one pathviz can show
// different traffic. It comes from the URL, with the names of the command-line
// flags: ?proto=tcp&port=8080&ip=10.0.0.1&iface=in:eth0.
const params = new URLSearchParams(location.search);

// The access token. PathViz prints the address of the page with the token in
// it. The page takes the token out of the address bar, keeps it for the next
// visits, and sends it with every call of the API. It is kept in the storage
// of this origin (host and port) and not in a cookie: a browser sends the
// cookies of a host to every port of it, so another web server of the same
// machine would get the token.
const TOKEN_KEY = 'pathviz.token';
let token = params.get('token') || '';
function keepToken(value) {
  token = value;
  try { localStorage.setItem(TOKEN_KEY, value); } catch { /* the token then lives as long as the page */ }
}
if (token) {
  keepToken(token);
  params.delete('token');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
} else {
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch { /* no storage, no kept token */ }
}

// api calls the API of PathViz with the token.
function api(path, opts = {}) {
  const headers = { ...opts.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(path, { ...opts, headers });
}
const listParam = (name) => (params.has(name) ? params.get(name).split(',').map((v) => v.trim()).filter(Boolean) : null);
const view = {
  embed: params.get('view') === 'embed',
  hooksOnly: params.get('detail') === 'hooks',
  ifaces: listParam('ifaces'),
  procs: listParam('procs'),
};
// The speed is a playback rate, like in a video player: x1 is normal.
const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SPEED_NAMES = { slow: 0.5, medium: 1, normal: 1, fast: 1.5 };
// The rates the full view offers as chips.
const SPEED_CHIPS = [0.5, 1, 1.5];
const speedLabel = (rate) => `x${rate}`;

function speedParam() {
  const raw = (params.get('speed') || '1').trim().toLowerCase();
  if (raw in SPEED_NAMES) return SPEED_NAMES[raw];
  const rate = Number(raw.replace(/^x|x$/, ''));
  if (!Number.isFinite(rate) || rate <= 0) return 1;
  // Snap to the nearest step of the range.
  return Math.min(2, Math.max(0.25, Math.round(rate * 4) / 4));
}
let speed = speedParam();

const urlFilter = {
  proto: ['tcp', 'udp', 'icmp'].includes(params.get('proto')) ? params.get('proto') : 'any',
  ifaces: (listParam('iface') || []).sort(),
  ips: listParam('ip') || [],
  ports: (listParam('port') || []).map(Number).filter(Number.isInteger).sort((a, b) => a - b),
};
const tables = listParam('tables') || [];
// An embedded view with ?tables= shows them below the diagram. Without it, the
// view switches between the diagram and the tables.
const tablesBelow = view.embed && tables.length > 0;
const hasSwitch = view.embed && !tablesBelow;
document.body.classList.toggle('embed', view.embed);
document.body.classList.toggle('below', tablesBelow);

// An embed with ?tables= shows exactly the tables it was asked for. Everywhere
// else both tables are on the page.
document.body.classList.toggle('show-packets', !tablesBelow || tables.includes('packets'));
document.body.classList.toggle('show-stages', !tablesBelow || tables.includes('stages'));

// collapsed tells which tables are folded down to their header. The full view
// remembers it. ?tables= sets how the full view starts.
const COLLAPSED_KEY = 'pathviz.collapsed';
const collapsed = (() => {
  if (!view.embed && params.has('tables')) return { packets: !tables.includes('packets'), stages: !tables.includes('stages') };
  if (!view.embed) {
    try {
      const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY));
      if (saved) return { packets: saved.packets === true, stages: saved.stages === true };
    } catch { /* no storage, or nothing sensible in it */ }
  }
  return { packets: false, stages: false };
})();

function applyCollapsed() {
  for (const head of document.querySelectorAll('.section-head[data-table]')) {
    const folded = collapsed[head.dataset.table];
    head.parentElement.classList.toggle('collapsed', folded);
    head.setAttribute('aria-expanded', String(!folded));
  }
  $('.lower').classList.toggle('has-collapsed', collapsed.packets || collapsed.stages);
  $('.lower').classList.toggle('all-collapsed', collapsed.packets && collapsed.stages);
}

const ifaceShown = (ifc) => !view.ifaces || view.ifaces.includes(ifc.name);
const procShown = (proc) => !view.procs || view.procs.some((item) => {
  const port = /^:?\d+$/.test(item) ? Number(item.replace(':', '')) : null;
  return port === null ? proc.name === item : proc.sockets.some((s) => s.port === port);
});

const state = {
  journeys: [],          // newest last
  selected: null,        // journey shown in the diagram
  live: true,            // follow new packets
  queue: [],             // journeys waiting for their turn in the diagram
  hooks: [],             // hooks and stages, as the server lists them
  host: { ifaces: [], procs: [] },
  // capture is what pathviz traces. filter is the same thing in the full view
  // (the clicks in the diagram change it) and the display filter in an embed.
  capture: { proto: 'any', ifaces: [], ips: [], ports: [] },
  filter: view.embed ? urlFilter : { proto: 'any', ifaces: [], ips: [], ports: [] },
  hookEls: {},           // hooks-only view: hook name -> { el, pos }
  chips: {},             // "HOOK/stage" -> { el, pos }
  nodeEls: {},           // node name -> element
  nics: { in: {}, out: {} },  // interface name -> { el, y }
  procs: {},             // pid -> { el, cx, cy }
  extras: [],            // processes of the selected packet that listen on nothing
  timers: [],
  trailAnim: null,
};

function el(name, attrs = {}, text) {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

// button makes an SVG group behave like a button.
function button(g, label, onPick) {
  if (view.embed) return; // an embedded view is read-only
  g.setAttribute('role', 'button');
  g.setAttribute('tabindex', '0');
  g.setAttribute('aria-label', label);
  g.append(el('title', {}, label));
  g.addEventListener('click', (e) => { e.stopPropagation(); onPick(); });
  g.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onPick(); }
  });
}

// ---- Filter picks ----------------------------------------------------------

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const EMPTY_FILTER = { proto: 'any', ifaces: [], ips: [], ports: [] };

function sameFilter(a, b) {
  return a.proto === b.proto && sameList(a.ifaces, b.ifaces) && sameList(a.ips, b.ips) && sameList(a.ports, b.ports);
}

// pick traces exactly the clicked thing: it replaces the whole filter. Picking
// the thing that is already traced goes back to tracing everything.
function pick(filter) {
  const next = { ...EMPTY_FILTER, ...filter };
  applyFilter(sameFilter(next, state.filter) ? EMPTY_FILTER : next);
}

// side is "in" for the cards packets arrive on and "out" for the cards they leave through.
function pickIface(side, name) {
  pick({ ifaces: [`${side}:${name}`] });
}

function ifacePicked(side, name) {
  return !view.embed && (state.filter.ifaces.includes(`${side}:${name}`) || state.filter.ifaces.includes(name));
}

function socketsFilter(sockets) {
  const protos = [...new Set(sockets.map((s) => s.proto))];
  return {
    proto: protos.length === 1 ? protos[0] : 'any',
    ports: [...new Set(sockets.map((s) => s.port))].sort((a, b) => a - b),
  };
}

function pickSockets(sockets) {
  pick(socketsFilter(sockets));
}

// A socket or a process counts as picked only when the filter is nothing but its ports.
function socketsPicked(sockets) {
  return !view.embed && sameFilter({ ...EMPTY_FILTER, ...socketsFilter(sockets) }, state.filter);
}

// tag marks a picked box. It differs from the highlight of a passing packet.
function tracedTag(x, y) {
  const g = el('g', { class: 'tag' });
  g.append(el('rect', { x: x - 44, y: y - 8, width: 44, height: 15, rx: 7.5 }), el('text', { x: x - 22, y: y + 3, 'text-anchor': 'middle' }, 'traced'));
  return g;
}

// describeFilter says in words what is traced.
function describeFilter(f) {
  const subject = f.proto === 'any' ? 'packets' : `${f.proto.toUpperCase()} packets`;
  const parts = [];
  if (f.ports.length) parts.push(`on ${f.ports.length > 1 ? 'ports' : 'port'} ${f.ports.join(', ')}`);
  if (f.ips.length) parts.push(`from or to ${f.ips.join(', ')}`);
  for (const entry of f.ifaces) {
    if (entry.startsWith('in:')) parts.push(`arriving on ${entry.slice(3)}`);
    else if (entry.startsWith('out:')) parts.push(`leaving through ${entry.slice(4)}`);
    else parts.push(`crossing ${entry}`);
  }
  if (!parts.length && f.proto === 'any') return 'Tracing all packets.';
  return `Tracing ${[subject, ...parts].join(', ').replace(', ', ' ')}.`;
}

// ---- Display filter (embedded view) ----------------------------------------

function parseEndpoint(text) {
  let m = text.match(/^\[(.+)\]:(\d+)$/);
  if (m) return { ip: m[1], port: Number(m[2]) };
  m = text.match(/^([\d.]+):(\d+)$/);
  if (m) return { ip: m[1], port: Number(m[2]) };
  return { ip: text, port: null };
}

function ipv4Number(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

// An item is an address or an IPv4 prefix such as 10.0.0.0/8.
function ipMatches(ip, item) {
  if (!item.includes('/')) return ip === item;
  const [net, bitsText] = item.split('/');
  const a = ipv4Number(ip), n = ipv4Number(net), bits = Number(bitsText);
  if (a === null || n === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(a / size) === Math.floor(n / size);
}

// A journey is shown when one of its hops satisfies the whole filter. It is the
// rule the probes follow: a packet that matched once stays in view.
function hopMatches(hop, j, f) {
  if (f.proto !== 'any') {
    const ok = f.proto === 'icmp' ? j.proto === 'icmp' || j.proto === 'icmpv6' : j.proto === f.proto;
    if (!ok) return false;
  }
  const src = parseEndpoint(hop.src), dst = parseEndpoint(hop.dst);
  if (f.ports.length && !f.ports.includes(src.port) && !f.ports.includes(dst.port)) return false;
  if (f.ips.length && !f.ips.some((item) => ipMatches(src.ip, item) || ipMatches(dst.ip, item))) return false;
  if (f.ifaces.length) {
    const ok = f.ifaces.some((entry) => {
      const dir = entry.startsWith('in:') ? 'in' : entry.startsWith('out:') ? 'out' : '';
      const name = dir ? entry.slice(dir.length + 1) : entry;
      return (dir !== 'out' && hop.in === name) || (dir !== 'in' && hop.out === name);
    });
    if (!ok) return false;
  }
  return true;
}

const journeyShown = (j) => !view.embed || j.hops.some((hop) => hopMatches(hop, j, state.filter));

// stageLabel names a stage the way the current view draws it.
const stageLabel = (hook, stage) => (view.hooksOnly ? hook : `${stage}/${hook}`);

// ---- Diagram ---------------------------------------------------------------

function buildDiagram() {
  const svg = $('#diagram');
  svg.replaceChildren();
  G = pickLayout(view.hooksOnly, ...layoutCounts());
  svg.classList.toggle('compact', G.compact);
  state.chips = {};
  state.nodeEls = {};
  state.nics = { in: {}, out: {} };
  state.procs = {};
  state.hookEls = {};

  const { nodes, lineY } = G;
  const allIfaces = state.host.ifaces.filter(ifaceShown);
  const ifaces = allIfaces.slice(0, G.nic.max);
  const P = G.proc;
  const allProcs = state.host.procs.filter(procShown);
  const procs = [...allProcs.slice(0, P.max - state.extras.length), ...state.extras];
  // The rows of processes sit in the middle of the socket bar.
  const rowWidth = Math.min(Math.max(procs.length, 1), P.perRow) * (P.w + P.gap) - P.gap;
  const procShift = Math.max(0, (G.sock.w - rowWidth) / 2);
  const hidden = allProcs.length + state.extras.length - procs.length;
  const height = diagramBottom(G, procs.length, hidden > 0);
  svg.setAttribute('viewBox', `${G.viewX} ${G.viewY} ${G.viewW} ${height - G.viewY}`);
  const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');

  // Tracks
  svg.append(
    el('path', { class: 'track loop', d: line([nodes.out, ...G.loop, nodes.in]) }),
    el('path', { class: 'track', d: line([nodes.in, nodes.out]) }),
    el('path', { class: 'track', d: line([nodes.route1, nodes.procIn]) }),
    el('path', { class: 'track', d: line([nodes.procOut, nodes.merge]) }),
  );
  for (const [x, y, rot] of G.arrows) {
    svg.append(el('path', { class: 'arrow', d: 'M-6 -5 L5 0 L-6 5 Z', transform: `translate(${x} ${y}) rotate(${rot})` }));
  }
  svg.append(el('text', { class: 'label', x: G.loopLabel.x, y: G.loopLabel.y, 'text-anchor': 'middle' }, G.loopLabel.text));

  // Trail of the selected packet: above the tracks, below everything else
  svg.append(el('path', { id: 'trail', d: '' }));

  // Network interfaces: the same cards on both ends
  const nicSide = (side, heading) => {
    const placed = G.nicCards(side, ifaces.length);
    const h = placed.heading;
    svg.append(el('text', { class: 'label', x: h.x, y: h.y, 'text-anchor': h.anchor }, heading));
    ifaces.forEach((ifc, i) => {
      const card = placed.cards[i];
      const left = card.cx - G.nic.w / 2, top = card.cy - G.nic.h / 2;
      svg.append(el('path', { class: 'track', d: line([...card.wire, nodes[side]]) }));
      // In the compact arrangement a card sits above its wire, so its text is centered.
      const centered = G.compact;
      const textX = centered ? card.cx : left + 10, anchor = centered ? 'middle' : 'start';
      const g = el('g', { class: 'nic' });
      if (!ifc.up) g.classList.add('down');
      const picked = ifacePicked(side, ifc.name);
      if (picked) g.classList.add('picked');
      g.append(
        el('rect', { x: left, y: top, width: G.nic.w, height: G.nic.h, rx: 6 }),
        el('text', { class: 'nic-name', x: textX, y: card.cy - 2, 'text-anchor': anchor }, ifc.name),
        el('text', { class: 'nic-addr', x: textX, y: card.cy + 11, 'text-anchor': anchor }, ifc.up ? (ifc.addrs[0] || 'no address') : 'down'),
      );
      const what = side === 'in' ? `packets arriving on ${ifc.name}` : `packets leaving through ${ifc.name}`;
      button(g, picked ? `Stop tracing only ${what}` : `Trace only ${what}`, () => pickIface(side, ifc.name));
      if (picked) g.append(tracedTag(left + G.nic.w - 4, top));
      svg.append(g);
      state.nics[side][ifc.name] = { el: g, wire: card.wire };
    });
    if (allIfaces.length > ifaces.length) {
      const m = placed.more;
      svg.append(el('text', { class: 'label', x: m.x, y: m.y, 'text-anchor': m.anchor }, `and ${allIfaces.length - ifaces.length} more`));
    }
  };
  nicSide('in', G.headings.in);
  nicSide('out', G.headings.out);

  // Sockets and the processes that own them
  const bar = el('rect', { class: 'proc', x: G.sock.x, y: G.sock.y, width: G.sock.w, height: G.sock.h, rx: 6 });
  svg.append(bar, el('text', { class: 'proc-label', x: G.centerX, y: G.sock.y + 15, 'text-anchor': 'middle' }, 'Sockets'));
  state.nodeEls.procIn = bar;
  state.nodeEls.procOut = bar;
  if (!procs.length && !view.procs) {
    svg.append(el('text', { class: 'label', x: G.centerX, y: P.y0 + 26, 'text-anchor': 'middle' }, 'No process listens on a TCP or UDP port.'));
  }
  const procPos = (i) => [P.x0 + procShift + (i % P.perRow) * (P.w + P.gap), P.y0 + Math.floor(i / P.perRow) * P.rowStep];
  // The connectors from the socket bar are drawn first: the boxes of an upper
  // row then cover the connectors of the rows below them.
  procs.forEach((proc, i) => {
    const [x, y] = procPos(i);
    svg.append(el('path', { class: 'track thin', d: `M${x + P.w / 2} ${G.sock.y + G.sock.h} V${y}` }));
  });
  procs.forEach((proc, i) => {
    const [x, y] = procPos(i);
    const g = el('g', { class: 'procchip' });
    if (proc.extra) g.classList.add('extra');
    const body = el('g', { class: 'procbody' });
    // The name gets the room the pid leaves.
    const pidText = `pid ${proc.pid}`;
    const fit = Math.max(4, Math.floor((P.w - 24 - pidText.length * 6.4) / 7));
    const name = proc.name.length > fit ? `${proc.name.slice(0, fit - 1)}…` : proc.name;
    body.append(
      el('rect', { x, y, width: P.w, height: P.h, rx: 8 }),
      el('text', { class: 'proc-name', x: x + 10, y: y + 17 }, name),
      el('text', { class: 'proc-pid', x: x + P.w - 10, y: y + 17, 'text-anchor': 'end' }, pidText),
    );
    const procPicked = socketsPicked(proc.sockets);
    button(body, procPicked ? `Stop tracing only ${proc.name}` : `Trace only the ports of ${proc.name} (pid ${proc.pid})`, () => pickSockets(proc.sockets));
    g.append(body);
    if (procPicked) g.classList.add('picked');
    // One pill per socket, as many as fit
    let px = x + 8;
    let shown = 0;
    for (const sock of proc.sockets) {
      const label = `${sock.proto} :${sock.port}`;
      const w = label.length * 6.4 + 14;
      const room = shown < proc.sockets.length - 1 ? 30 : 0;
      if (px + w > x + P.w - 8 - room) break;
      const pill = el('g', { class: 'sock' });
      const sockPicked = !procPicked && socketsPicked([sock]);
      if (sockPicked) pill.classList.add('picked');
      pill.append(
        el('rect', { x: px, y: y + 24, width: w, height: 16, rx: 8 }),
        el('text', { x: px + w / 2, y: y + 35.5, 'text-anchor': 'middle' }, label),
      );
      button(pill, sockPicked ? `Stop tracing only ${sock.proto.toUpperCase()} port ${sock.port}` : `Trace only ${sock.proto.toUpperCase()} port ${sock.port}`, () => pickSockets([sock]));
      g.append(pill);
      px += w + 5;
      shown++;
    }
    if (shown < proc.sockets.length) {
      g.append(el('text', { class: 'proc-pid', x: px + 2, y: y + 35.5 }, `+${proc.sockets.length - shown}`));
    }
    if (procPicked) g.append(tracedTag(x + P.w - 4, y));
    svg.append(g);
    state.procs[proc.pid] = { el: g, cx: x + P.w / 2, cy: y };
  });
  if (hidden > 0) {
    svg.append(el('text', { class: 'label', x: G.sock.x + G.sock.w, y: height - 2, 'text-anchor': 'end' }, `and ${hidden} more processes`));
  }

  // Hooks with their stage chips
  const { w: chipW, h: chipH } = G.chip;
  for (const hook of state.hooks) {
    const lay = G.hooks[hook.name];
    if (!lay) continue;
    if (view.hooksOnly) {
      const [cx, cy] = G.hookCenter[hook.name];
      const g = el('g', { class: 'hook' });
      g.append(
        el('rect', { x: cx - G.hookBox.w / 2, y: cy - G.hookBox.h / 2, width: G.hookBox.w, height: G.hookBox.h, rx: 10 }),
        el('text', { class: 'hookname', x: cx, y: cy + 4, 'text-anchor': 'middle' }, hook.name),
        el('title'),
      );
      svg.append(g);
      state.hookEls[hook.name] = { el: g, pos: [cx, cy] };
      continue;
    }
    const n = hook.stages.length;
    const x1 = lay.x + lay.dx * (n - 1), y1 = lay.y + lay.dy * (n - 1);
    const left = Math.min(lay.x, x1) - chipW / 2 - 10, right = Math.max(lay.x, x1) + chipW / 2 + 10;
    const top = Math.min(lay.y, y1) - chipH / 2 - 12, bottom = Math.max(lay.y, y1) + chipH / 2 + 12;
    svg.append(el('rect', { class: 'hookbox', x: left, y: top, width: right - left, height: bottom - top, rx: 10 }));
    if (lay.dx) {
      svg.append(el('text', { class: 'hookname', x: (left + right) / 2, y: bottom + 17, 'text-anchor': 'middle' }, hook.name));
    } else if (hook.name === 'INPUT') {
      svg.append(el('text', { class: 'hookname', x: left - 10, y: (top + bottom) / 2 + 4, 'text-anchor': 'end' }, hook.name));
    } else {
      svg.append(el('text', { class: 'hookname', x: right + 10, y: (top + bottom) / 2 + 4 }, hook.name));
    }
    hook.stages.forEach((stage, i) => {
      const cx = lay.x + lay.dx * i, cy = lay.y + lay.dy * i;
      const g = el('g', { class: 'chip' });
      g.append(
        el('rect', { x: cx - chipW / 2, y: cy - chipH / 2, width: chipW, height: chipH, rx: chipH / 2 }),
        el('text', { x: cx, y: cy + 4, 'text-anchor': 'middle' }, stage.name),
        el('title'),
      );
      svg.append(g);
      state.chips[`${hook.name}/${stage.name}`] = { el: g, pos: [cx, cy] };
    });
  }

  // Network ends and routing decisions
  for (const name of ['in', 'out']) {
    const c = el('circle', { class: 'node', cx: nodes[name][0], cy: nodes[name][1], r: 8 });
    svg.append(c);
    state.nodeEls[name] = c;
  }
  for (const name of ['route1', 'route2']) {
    const [x, y] = nodes[name];
    const [lx, ly, anchor, label] = G.routeLabels[name];
    const d = el('path', { class: 'diamond', d: `M${x} ${y - 11} L${x + 11} ${y} L${x} ${y + 11} L${x - 11} ${y} Z` });
    svg.append(d, el('text', { class: 'label', x: x + lx, y: y + ly, 'text-anchor': anchor }, label));
    state.nodeEls[name] = d;
  }
  const merge = el('circle', { class: 'diamond', cx: nodes.merge[0], cy: nodes.merge[1], r: 5 });
  svg.append(merge);
  state.nodeEls.merge = merge;

  // Marker of the place where the selected packet stopped
  const stop = el('g', { id: 'stopmark', visibility: 'hidden' });
  stop.append(el('circle', { r: 8 }), el('path', { d: 'M-3 -3 L3 3 M3 -3 L-3 3' }));
  svg.append(stop);
}

// redraw rebuilds the diagram (new interfaces, processes, or filter picks) and
// puts the selected packet back.
function redraw() {
  buildDiagram();
  showJourney(state.selected, false);
}

// waypoints turns a journey into the points its trail goes through. Every point
// may light up a chip, a node, an interface, or a process when the trail reaches it.
function waypoints(j) {
  const pts = [];
  const push = (xy, target, cls) => pts.push({ x: xy[0], y: xy[1], target, cls });
  const node = (name) => push(G.nodes[name], state.nodeEls[name], 'lit');
  let prevHook = null;
  let prevHop = null;
  let boxPoint = null;   // hooks-only view: the point of the current hook's box
  const box = (hop) => {
    const b = state.hookEls[hop.hook];
    if (boxPoint || !b) return;
    push(b.pos, b.el, 'lit');
    boxPoint = pts[pts.length - 1];
    boxPoint.mark = [b.pos[0] + G.hookBox.w / 2 - 3, b.pos[1] - G.hookBox.h / 2 + 3];
    b.el.querySelector('title').textContent = `${hop.src} to ${hop.dst}`;
  };

  j.hops.forEach((hop, i) => {
    const lay = G.hooks[hop.hook];
    if (!lay) return;
    if (hop.hook !== prevHook) {
      // A partial journey starts in the middle of a hook: how the packet got
      // there is unknown, so the trail starts at the first stage that saw it.
      const unknownStart = prevHook === null && j.partial;
      if (prevHook === 'POSTROUTING' && hop.hook === 'PREROUTING') {
        // Loopback: the packet that left comes back in.
        const out = state.nics.out[prevHop.out], back = state.nics.in[hop.in];
        G.loop.forEach((p, k) => {
          if (k === 0) push(p, out && out.el, 'lit');
          else if (k === G.loop.length - 1) push(p, back && back.el, 'lit');
          else push(p);
        });
      } else if (hop.hook === 'PREROUTING' && prevHook === null && !unknownStart) {
        const nic = state.nics.in[hop.in];
        if (nic) nic.wire.forEach((p, k) => (k === 0 ? push(p, nic.el, 'lit') : push(p)));
      } else if (hop.hook === 'OUTPUT' && prevHook === null && !unknownStart) {
        const proc = j.from && state.procs[j.from.pid];
        if (proc) {
          push([proc.cx, proc.cy], proc.el, 'lit');
          push([proc.cx, G.sock.mid]);
          push([G.nodes.procOut[0], G.sock.mid]);
        }
        node('procOut');
      }
      if (!unknownStart) node(lay.entry);
      prevHook = hop.hook;
      boxPoint = null;
    }
    prevHop = hop;
    if (view.hooksOnly) {
      box(hop);
      // A hook whose stage rewrote the packet (NAT) is marked like that stage.
      if (hop.rewrote && boxPoint && !boxPoint.cls.includes('rewrote')) boxPoint.cls += ' rewrote';
      if (hop.exit) node(lay.exit);
      else if (i === j.hops.length - 1 && j.verdict === 'stopped' && boxPoint) boxPoint.cls += ' stopped';
      return;
    }
    if (hop.exit) {
      node(lay.exit);
      return;
    }
    const chip = state.chips[`${hop.hook}/${hop.stage}`];
    if (!chip) return;
    const last = i === j.hops.length - 1;
    let cls = 'lit';
    if (hop.rewrote) cls += ' rewrote';
    if (last && j.verdict === 'stopped') cls += ' stopped';
    push(chip.pos, chip.el, cls);
    pts[pts.length - 1].chip = true;
    chip.el.querySelector('title').textContent = `${hop.src} to ${hop.dst}`;
  });

  if (j.verdict === 'sent' && prevHop) {
    const nic = state.nics.out[prevHop.out];
    if (nic) {
      const wire = [...nic.wire].reverse();
      wire.forEach((p, k) => (k === wire.length - 1 ? push(p, nic.el, 'lit') : push(p)));
    }
  }
  if (j.verdict === 'delivered') {
    const proc = j.to && state.procs[j.to.pid];
    if (proc) {
      push([G.nodes.procIn[0], G.sock.mid]);
      push([proc.cx, G.sock.mid]);
      push([proc.cx, proc.cy], proc.el, 'lit');
    }
  }
  if (j.verdict === 'stopped' && pts.length) {
    const last = pts[pts.length - 1];
    last.stop = true;
    if (j.stoppedStage === 'routing') last.cls = 'stopped';
  }
  return pts;
}

function resetDiagram() {
  state.timers.forEach(clearTimeout);
  state.timers = [];
  if (state.trailAnim) { state.trailAnim.cancel(); state.trailAnim = null; }
  document.querySelectorAll('#diagram .lit, #diagram .stopped').forEach((e) => e.classList.remove('lit', 'rewrote', 'stopped'));
  $('#trail').setAttribute('d', '');
  $('#stopmark').setAttribute('visibility', 'hidden');
}

// extraProcs lists the processes at the ends of a journey that have no box in
// the diagram because they listen on nothing (e.g. a client).
function extraProcs(j) {
  if (!j) return [];
  const out = [];
  for (const o of [j.from, j.to]) {
    if (!o || state.host.procs.some((p) => p.pid === o.pid) || out.some((p) => p.pid === o.pid)) continue;
    const proc = { pid: o.pid, name: o.name, sockets: [{ proto: o.proto, port: o.port }], extra: true };
    if (procShown(proc)) out.push(proc);
  }
  return out;
}

function showJourney(j, animate) {
  const extras = extraProcs(j);
  if (JSON.stringify(extras) !== JSON.stringify(state.extras)) {
    state.extras = extras;
    buildDiagram();
  }
  resetDiagram();
  state.selected = j;
  renderVerdict(j);
  renderHops(j);
  document.querySelectorAll('#packets tr.selected').forEach((r) => r.classList.remove('selected'));
  if (!j) return 0;
  const row = document.getElementById(`j${j.id}`);
  if (row) row.classList.add('selected');

  const pts = waypoints(j);
  if (!pts.length) return 0;
  let d = '', total = 0;
  const at = [];
  pts.forEach((p, i) => {
    if (i) total += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
    at.push(total);
    d += `${i ? 'L' : 'M'}${p.x} ${p.y} `;
  });
  const trail = $('#trail');
  trail.setAttribute('d', d);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const duration = animate && !reduced && total > 0 ? Math.min(1100, Math.max(350, total * 0.7)) / speed : 0;
  const reach = (p) => {
    if (p.target && p.cls) p.target.classList.add(...p.cls.split(' '));
    if (p.stop) {
      const mark = $('#stopmark');
      // On a chip, the mark sits at the end the packet did not get past.
      const [mx, my] = p.mark || (p.chip ? [p.x + G.chip.w / 2 + 2, p.y - G.chip.h / 2 + 2] : [p.x + 18, p.y - 18]);
      mark.setAttribute('transform', `translate(${mx} ${my})`);
      mark.setAttribute('visibility', 'visible');
    }
  };
  if (!duration) {
    trail.style.strokeDasharray = 'none';
    pts.forEach(reach);
    return 0;
  }
  trail.style.strokeDasharray = `${total} ${total}`;
  state.trailAnim = trail.animate(
    [{ strokeDashoffset: total }, { strokeDashoffset: 0 }],
    { duration, easing: 'linear', fill: 'forwards' },
  );
  pts.forEach((p, i) => state.timers.push(setTimeout(() => reach(p), (at[i] / total) * duration)));
  return duration;
}

// ---- Text views ------------------------------------------------------------

function outcomeText(j) {
  if (j.verdict === 'delivered') return j.to ? `Delivered to ${j.to.name}` : 'Delivered locally';
  if (j.verdict === 'sent') {
    const last = j.hops[j.hops.length - 1];
    const verb = j.path.includes('FORWARD') ? 'Forwarded' : 'Sent';
    return last.out ? `${verb} via ${last.out}` : verb;
  }
  if (j.stoppedStage === 'routing') return `Lost after ${j.stoppedHook}`;
  return `Stopped in ${stageLabel(j.stoppedHook, j.stoppedStage)}`;
}

function verdictSentence(j) {
  if (j.verdict === 'delivered') {
    if (j.to) {
      return [`Delivered to ${j.to.name} (pid ${j.to.pid}).`, `The packet passed INPUT and reached the ${j.to.proto.toUpperCase()} socket on port ${j.to.port}.`];
    }
    return ['Delivered locally.', 'The packet passed INPUT and went up to the transport layer of this machine.'];
  }
  if (j.verdict === 'sent') {
    const last = j.hops[j.hops.length - 1];
    return [`${outcomeText(j)}.`, 'The packet passed POSTROUTING and was handed to the network device.'];
  }
  if (j.stoppedStage === 'routing') {
    if (j.stoppedHook === 'PREROUTING') {
      return ['Lost after PREROUTING.', 'The packet reached neither INPUT nor FORWARD. The routing decision discarded it: no route, forwarding disabled, or a reverse path check.'];
    }
    return [`Lost after ${j.stoppedHook}.`, 'The packet left this hook and never reached POSTROUTING.'];
  }
  if (view.hooksOnly) {
    return [`Stopped in ${j.stoppedHook}.`, 'The packet entered this hook and was not seen after it. A rule in it dropped, rejected, or queued the packet.'];
  }
  return [`Stopped in ${j.stoppedStage}/${j.stoppedHook}.`, 'The packet entered this stage and was not seen after it. A rule at this point dropped, rejected, or queued it.'];
}

function renderVerdict(j) {
  const box = $('#verdict');
  box.className = 'verdict';
  // The sentence is one element, so that the box can center it as a whole.
  const p = document.createElement('span');
  box.replaceChildren(p);
  if (!j) {
    p.textContent = 'Waiting for a matching packet.';
    return;
  }
  const [head, rest] = verdictSentence(j);
  const strong = document.createElement('strong');
  strong.textContent = head;
  p.append(strong, ' ', rest);
  if (j.from) p.append(` It was sent by ${j.from.name} (pid ${j.from.pid}).`);
  if (j.partial) {
    const h = j.hops[0];
    const where = h.exit ? `the end of ${h.hook}` : stageLabel(h.hook, h.stage);
    p.append(` The packet started to match the filter at ${where}, so the earlier stages are not shown.`);
  }
  if (j.unreliable) p.append(' Some probe events were lost around this packet, so the path may be incomplete.');
  box.classList.add(j.verdict === 'stopped' ? 'stopped' : 'done');
}

function td(text, cls) {
  const c = document.createElement('td');
  if (cls) c.className = cls;
  c.textContent = text;
  return c;
}

function timeText(iso) {
  const t = new Date(iso);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}.${p(t.getMilliseconds(), 3)}`;
}

function addRow(j) {
  const tr = document.createElement('tr');
  tr.id = `j${j.id}`;
  tr.tabIndex = 0;
  tr.append(
    td(timeText(j.time), 'mono'),
    td(j.proto.toUpperCase()),
    td(j.src, 'mono'),
    td(j.dst, 'mono'),
    td(j.info, 'mono'),
    td(outcomeText(j), j.verdict === 'stopped' ? 'outcome-stopped' : 'outcome-done'),
  );
  // The button opens the packet view. It must not select the row as well.
  const act = td('', 'act');
  const inspect = document.createElement('button');
  inspect.type = 'button';
  inspect.className = 'inspect';
  inspect.textContent = 'Inspect';
  inspect.title = 'Show the headers and the bytes of this packet';
  inspect.addEventListener('click', (e) => { e.stopPropagation(); openPacket(j); });
  inspect.addEventListener('keydown', (e) => e.stopPropagation());
  act.append(inspect);
  tr.append(act);
  const pick = () => { setLive(false); showJourney(j, true); };
  tr.addEventListener('click', pick);
  tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
  const body = $('#packets tbody');
  body.prepend(tr);
  while (body.rows.length > MAX_ROWS) body.deleteRow(-1);
}

function renderHops(j) {
  const body = $('#hops tbody');
  body.replaceChildren();
  $('#hops-empty').hidden = !!j;
  $('#hops-summary').textContent = j ? [j.proto.toUpperCase(), j.info, j.detail, `${j.len} bytes`].filter(Boolean).join(', ') : '';
  if (!j) return;
  if (view.hooksOnly) {
    renderHookRows(j, body);
    return;
  }
  let prev = null;
  j.hops.forEach((hop, i) => {
    const tr = document.createElement('tr');
    const stage = td(hop.exit ? `left ${hop.hook}` : `${hop.stage}/${hop.hook}`, 'mono wrap');
    const note = (text) => {
      const s = document.createElement('span');
      s.className = 'note';
      s.textContent = text;
      stage.append(s);
    };
    if (hop.exit) tr.classList.add('exit');
    if (hop.rewrote) { tr.classList.add('rewrote'); note(`This stage rewrote the ${hop.rewrote}.`); }
    if (i === j.hops.length - 1 && j.verdict === 'stopped') {
      tr.classList.add('stopped');
      note(j.stoppedStage === 'routing' ? 'The packet was not seen after this point.' : 'The packet did not leave this stage.');
    }
    const src = td(hop.src, 'mono'), dst = td(hop.dst, 'mono');
    if (prev && prev.src !== hop.src) src.classList.add('changed');
    if (prev && prev.dst !== hop.dst) dst.classList.add('changed');
    tr.append(stage, td(hop.in || '', 'mono'), td(hop.out || '', 'mono'), src, dst, td(String(hop.ttl), 'mono'), td(`${hop.us} µs`, 'mono'));
    body.append(tr);
    prev = hop;
  });
}

// renderHookRows fills the table with one row per hook the packet crossed.
function renderHookRows(j, body) {
  const groups = [];
  j.hops.forEach((hop, i) => {
    let g = groups[groups.length - 1];
    if (!g || g.hook !== hop.hook) {
      g = { hook: hop.hook, first: hop, hops: [] };
      groups.push(g);
    }
    g.hops.push(hop);
    g.last = i === j.hops.length - 1;
  });
  let prev = null;
  for (const g of groups) {
    const tr = document.createElement('tr');
    const name = td(g.hook, 'mono wrap');
    const note = (text) => {
      const span = document.createElement('span');
      span.className = 'note';
      span.textContent = text;
      name.append(span);
    };
    const rewrites = g.hops.filter((h) => h.rewrote).map((h) => h.rewrote);
    if (rewrites.length) { tr.classList.add('rewrote'); note(`This hook rewrote the ${rewrites.join(', ')}.`); }
    if (g.last && j.verdict === 'stopped') {
      tr.classList.add('stopped');
      note(j.stoppedStage === 'routing' ? 'The packet was not seen after this hook.' : 'The packet did not leave this hook.');
    }
    const out = [...g.hops].reverse().find((h) => h.out);
    const src = td(g.first.src, 'mono'), dst = td(g.first.dst, 'mono');
    if (prev && prev.src !== g.first.src) src.classList.add('changed');
    if (prev && prev.dst !== g.first.dst) dst.classList.add('changed');
    tr.append(name, td(g.first.in || '', 'mono'), td(out ? out.out : '', 'mono'), src, dst, td(String(g.first.ttl), 'mono'), td(`${g.first.us} µs`, 'mono'));
    body.append(tr);
    prev = g.first;
  }
}

// The packet view: the headers and the bytes of one packet, as every probe saw them.

const packetView = { j: null, entries: [], at: 0, cells: [] };

function base64Bytes(text) {
  const raw = atob(text || '');
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function packetMessage(text) {
  $('#pd-hops').replaceChildren();
  $('#pd-note').textContent = text;
  $('#pd-body').hidden = true;
}

async function openPacket(j) {
  packetView.j = j;
  packetView.entries = [];
  $('#pd-title').textContent = `${j.proto.toUpperCase()} packet ${j.src} → ${j.dst}`;
  packetMessage('Loading the packet…');
  const dialog = $('#packet-dialog');
  if (!dialog.open) dialog.showModal();
  let data;
  try {
    const res = await api(`api/packet?id=${j.id}`);
    if (res.status === 404) throw new Error('PathViz does not keep this packet anymore, so its bytes cannot be shown.');
    if (!res.ok) throw new Error(`Cannot load the packet: ${(await res.text()).trim()}`);
    data = await res.json();
  } catch (err) {
    if (packetView.j === j) packetMessage(err.message);
    return;
  }
  // Another packet may have been opened while this one was loading.
  if (packetView.j !== j) return;
  const hops = data.hops.map((h) => ({ ...h, bytes: base64Bytes(h.bytes) }));
  hops.forEach((h, i) => {
    const before = i > 0 ? hops[i - 1].bytes : h.bytes;
    h.changed = before.length !== h.bytes.length || before.some((v, k) => v !== h.bytes[k]);
  });
  // With ?detail=hooks the switcher has one entry per hook, plus the probes
  // that saw the packet changed.
  packetView.entries = hops.filter((h, i) => !view.hooksOnly || i === 0 || h.hook !== hops[i - 1].hook || h.changed);
  if (!packetView.entries.length) { packetMessage('No bytes of this packet were captured.'); return; }
  $('#pd-body').hidden = false;
  showPacketHop(0);
}

// The packet view names the stages in full, with ?detail=hooks as well: there
// it has entries for the stages that changed the packet.
const hopName = (h) => (h.exit ? `the end of ${h.hook}` : `${h.stage}/${h.hook}`);

// fieldKeys names the fields of a hop so that the same field of another hop
// gets the same key: the layer, the field, and its number among its namesakes.
function fieldKeys(hop) {
  const keys = new Map(), seen = new Map();
  hop.layers.forEach((layer, li) => {
    for (const f of layer.fields) {
      const base = `${li}|${layer.name}|${f.name}`;
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      keys.set(f, `${base}|${n}`);
    }
  });
  return keys;
}

// linkPacketHooks finds the hooks of the switcher that wrapped to a new row,
// and sizes the line that links each of them to the last hook of the row above.
function linkPacketHooks() {
  const bar = $('#pd-hops');
  const groups = [...bar.querySelectorAll('.pd-hook')];
  // A hook that starts a row is wider (it has the turn of the line before its
  // box), so the rows are found in order, each with the earlier ones marked.
  for (const g of groups) g.classList.remove('wrap-in', 'wrap-out');
  for (const run of bar.querySelectorAll('.pd-run')) run.remove();
  let wrapped = false;
  groups.forEach((g, i) => {
    const prev = groups[i - 1];
    if (!prev || g.offsetTop <= prev.offsetTop) return;
    wrapped = true;
    g.classList.add('wrap-in');
    prev.classList.add('wrap-out');
    // The part of the line between the rows: from the turn after the previous
    // hook back to the turn before this one.
    const run = document.createElement('span');
    run.className = 'pd-run';
    run.style.width = `${prev.offsetLeft + prev.offsetWidth - (g.offsetLeft + 26)}px`;
    g.append(run);
  });
  bar.classList.toggle('wrapped', wrapped);
}
new ResizeObserver(linkPacketHooks).observe($('#pd-hops'));

// packetStart tells where a packet came from before its first probe, and
// whether that is known: the diagram starts the trail of a packet the same way.
function packetStart(j) {
  const first = j.hops[0];
  if (j.partial || !first) return ['The packet started to match the filter here, so the earlier stages are not shown.', false];
  if (first.hook === 'PREROUTING') return [first.in ? `The packet arrived on the ${first.in} interface.` : 'The packet arrived on a network interface.', true];
  if (first.hook === 'OUTPUT') return [j.from ? `The packet was sent by ${j.from.name} (pid ${j.from.pid}).` : 'The packet was sent by a local process.', true];
  return [`The packet was first seen in ${first.hook}.`, false];
}

function showPacketHop(at) {
  const entries = packetView.entries;
  packetView.at = at;
  const hop = entries[at], prev = at > 0 ? entries[at - 1] : null;

  // The switcher draws the hooks like the diagram does, in the order the
  // packet crossed them, on one line: a node where the line starts, then for
  // every hook a box with the hook's name below and a chip for every stage
  // that saw the packet, and after the box a node for the probe at the end of
  // the hook. The line ends where the packet was seen last.
  const bar = $('#pd-hops');
  bar.replaceChildren();
  const part = (cls) => { const e = document.createElement('span'); e.className = cls; return e; };
  let group = null, box = null;
  entries.forEach((h, i) => {
    const first = !group || group.dataset.hook !== h.hook || i === 0;
    if (first) {
      group = part('pd-hook');
      group.dataset.hook = h.hook;
      box = part('pd-box');
      const name = part('lbl');
      name.textContent = h.hook;
      if (i === 0) {
        // The node where the line starts tells where the packet came from:
        // pointing at it shows that in place of the note about the shown probe.
        const [text, known] = packetStart(packetView.j);
        const start = part('pd-in'), node = part(known ? 'node' : 'node unknown');
        node.addEventListener('mouseenter', () => { $('#pd-note').textContent = text; });
        node.addEventListener('mouseleave', () => { $('#pd-note').textContent = packetView.note; });
        node.setAttribute('role', 'img');
        node.setAttribute('aria-label', text);
        start.append(node);
        group.append(start);
      }
      group.append(box, name);
      bar.append(group);
    }
    const b = document.createElement('button');
    b.type = 'button';
    let to = box;
    // The end of a hook is not a stage: it is a node after the box, like the
    // nodes between the hooks of the diagram.
    if (h.exit) {
      b.className = 'exit';
      b.setAttribute('aria-label', `The end of ${h.hook}`);
      to = part('pd-out');
      group.append(to);
    } else {
      b.textContent = view.hooksOnly && first ? 'entry' : h.stage;
    }
    b.title = h.exit ? `The packet as it left ${h.hook}` : `The packet as it entered ${hopName(h)}`;
    if (h.changed) { b.classList.add('changed'); b.title += ' (it differs from what the previous probe saw)'; }
    if (i === at) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => { showPacketHop(i); $('#pd-hops [aria-current]').focus(); });
    to.append(b);
  });
  const groups = [...bar.children];
  groups.forEach((g, i) => {
    const last = i === groups.length - 1;
    let out = g.querySelector('.pd-out');
    // A hook without a probe at its end still has the line to the next hook.
    if (!out && !last) { out = part('pd-out'); g.append(out); }
    if (out) g.querySelector('.pd-box').classList.add('leaves');
    if (out && last) out.classList.add('end');
  });

  linkPacketHooks();

  // The fields that the previous probe saw with another value.
  const before = new Map();
  if (prev) for (const [f, key] of fieldKeys(prev)) before.set(key, f.value);
  const keys = fieldKeys(hop);
  let changedFields = 0;

  const fields = $('#pd-fields'), hex = $('#pd-hex');
  const scroll = [fields.scrollTop, hex.scrollTop];
  fields.replaceChildren();
  for (const layer of hop.layers) {
    const section = document.createElement('section');
    section.className = `pd-layer k-${layer.kind}`;
    const head = document.createElement('h3');
    head.dataset.off = layer.off;
    head.dataset.len = layer.len;
    head.textContent = layer.name;
    if (layer.summary) {
      const s = document.createElement('span');
      s.className = 'muted mono';
      s.textContent = layer.summary;
      head.append(s);
    }
    section.append(head);
    for (const f of layer.fields) {
      const row = document.createElement('div');
      row.className = 'pd-field';
      row.tabIndex = 0;
      row.dataset.off = f.off;
      row.dataset.len = f.len;
      const name = document.createElement('span');
      name.className = 'n';
      name.textContent = f.name;
      const value = document.createElement('span');
      value.className = 'v mono';
      value.textContent = f.value;
      const was = before.get(keys.get(f));
      if (was !== undefined && was !== f.value) {
        changedFields++;
        row.classList.add('changed');
        const old = document.createElement('span');
        old.className = 'was';
        old.textContent = `was ${was || 'empty'}`;
        value.append(old);
      }
      row.append(name, value);
      section.append(row);
    }
    fields.append(section);
  }

  // The bytes: 16 in a row, colored by their layer, with their text on the right.
  const kinds = [];
  for (const layer of hop.layers) for (let i = layer.off; i < layer.off + layer.len; i++) kinds[i] = layer.kind;
  hex.replaceChildren();
  packetView.cells = [];
  const bytes = hop.bytes;
  for (let start = 0; start < bytes.length; start += 16) {
    const line = document.createElement('div');
    const off = document.createElement('span');
    off.className = 'off';
    off.textContent = start.toString(16).padStart(4, '0');
    const hexPart = document.createElement('span');
    hexPart.className = 'bytes';
    const textPart = document.createElement('span');
    textPart.className = 'text';
    for (let i = start; i < Math.min(start + 16, bytes.length); i++) {
      const v = bytes[i];
      const cls = `k-${kinds[i] || 'data'}${prev && prev.bytes[i] !== v ? ' changed' : ''}`;
      const b = document.createElement('span');
      b.className = `b ${cls}${i % 16 === 8 ? ' mid' : ''}`;
      b.dataset.i = i;
      b.textContent = v.toString(16).padStart(2, '0');
      const c = document.createElement('span');
      c.className = `c ${cls}`;
      c.dataset.i = i;
      c.textContent = v >= 0x20 && v <= 0x7e ? String.fromCharCode(v) : '·';
      hexPart.append(b);
      textPart.append(c);
      packetView.cells.push([b, c]);
    }
    line.append(off, hexPart, textPart);
    hex.append(line);
  }
  fields.scrollTop = scroll[0];
  hex.scrollTop = scroll[1];

  const notes = [`The packet as it ${hop.exit ? `left ${hop.hook}` : `entered ${hopName(hop)}`}.`];
  notes.push(hop.total > bytes.length
    ? `The first ${bytes.length} of its ${hop.total} bytes were captured.`
    : `${bytes.length} bytes, from the IP header on.`);
  if (prev && hop.changed) {
    notes.push(`The highlighted ${changedFields === 1 ? 'field differs' : 'fields differ'} from what the probe at ${hopName(prev)} saw.`);
  } else if (prev) {
    notes.push(`Nothing changed since the probe at ${hopName(prev)}.`);
  }
  packetView.note = notes.join(' ');
  $('#pd-note').textContent = packetView.note;
}

// Pointing at a field marks its bytes, and pointing at a byte marks its field.
function markPacketRange(off, len, rows) {
  for (const el of document.querySelectorAll('#packet-dialog .on')) el.classList.remove('on');
  for (let i = off; i < off + len; i++) for (const el of packetView.cells[i] || []) el.classList.add('on');
  for (const row of rows) row.classList.add('on');
}

function markPacketField(e) {
  const row = e.target.closest('[data-off]');
  if (!row) return;
  const off = Number(row.dataset.off), len = Number(row.dataset.len);
  markPacketRange(off, len, [row]);
  const cell = packetView.cells[off];
  if (cell) cell[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function markPacketByte(e) {
  if (!e.target.dataset || e.target.dataset.i === undefined) return;
  const i = Number(e.target.dataset.i);
  // The smallest field that holds the byte, and every field of the same bytes.
  let best = null;
  const rows = [...document.querySelectorAll('#pd-fields .pd-field')].filter((row) => {
    const off = Number(row.dataset.off), len = Number(row.dataset.len);
    if (i < off || i >= off + len) return false;
    if (!best || len < best.len) best = { off, len };
    return true;
  });
  if (!best) { markPacketRange(i, 1, []); return; }
  const same = rows.filter((row) => Number(row.dataset.off) === best.off && Number(row.dataset.len) === best.len);
  markPacketRange(best.off, best.len, same);
  same[0].scrollIntoView({ block: 'nearest' });
}

$('#pd-fields').addEventListener('mouseover', markPacketField);
$('#pd-fields').addEventListener('focusin', markPacketField);
$('#pd-hex').addEventListener('mouseover', markPacketByte);
for (const id of ['#pd-fields', '#pd-hex']) $(id).addEventListener('mouseleave', () => markPacketRange(0, 0, []));

// The left and right arrows step through the probes.
$('#packet-dialog').addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  const next = packetView.at + (step || 0);
  if (!step || next < 0 || next >= packetView.entries.length) return;
  e.preventDefault();
  showPacketHop(next);
  $('#pd-hops [aria-current]').focus();
});
$('#packet-dialog').addEventListener('close', () => { packetView.j = null; });

function refreshCounts() {
  const n = state.journeys.length;
  $('#count').textContent = n ? `${n} shown` : '';
  $('#empty').hidden = n > 0;
}

// ---- Live flow -------------------------------------------------------------

function setLive(on) {
  state.live = on;
  const b = $('#live-btn');
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? 'Following new packets' : 'Follow new packets';
  if (!on) state.queue = [];
}

let playing = false;
function playNext() {
  if (playing || !state.live) return;
  // When packets arrive faster than they can be drawn, skip to the recent ones.
  if (state.queue.length > 4) state.queue = state.queue.slice(-2);
  const j = state.queue.shift();
  if (!j) return;
  playing = true;
  const d = showJourney(j, true);
  setTimeout(() => { playing = false; playNext(); }, d + 250 / speed);
}

function onJourney(j) {
  if (!journeyShown(j)) return;
  state.journeys.push(j);
  if (state.journeys.length > MAX_ROWS) state.journeys.shift();
  addRow(j);
  refreshCounts();
  if (state.live) { state.queue.push(j); playNext(); }
}

function clearAll() {
  state.journeys = [];
  state.queue = [];
  $('#packets tbody').replaceChildren();
  showJourney(null);
  refreshCounts();
}

// loadJourneys replaces the listed packets and selects the newest one.
function loadJourneys(list) {
  clearAll();
  for (const j of list.filter(journeyShown)) { state.journeys.push(j); addRow(j); }
  refreshCounts();
  if (state.journeys.length) showJourney(state.journeys[state.journeys.length - 1], false);
}

function showFilter(f) {
  state.capture = { proto: f.proto || 'any', ifaces: f.ifaces || [], ips: f.ips || [], ports: f.ports || [] };
  if (!view.embed) state.filter = state.capture;
  $('#f-proto').value = f.proto || 'any';
  $('#f-ifaces').value = (f.ifaces || []).join(', ');
  $('#f-ips').value = (f.ips || []).join(', ');
  $('#f-ports').value = (f.ports || []).join(', ');
  $('#tracing').textContent = describeFilter(state.filter);
  markDirty();
}

// askToken shows the dialog that asks for the access token. It stays until
// the right token is entered.
function askToken() {
  const conn = $('#conn');
  conn.className = 'conn down';
  conn.textContent = 'Token needed';
  const dialog = $('#token-dialog');
  if (!dialog.open) dialog.showModal();
}

$('#token-dialog').addEventListener('cancel', (e) => e.preventDefault());
$('#token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#token-msg');
  // The whole address that PathViz printed can be pasted as well.
  const text = $('#token-input').value.trim();
  const fromUrl = /[?&]token=([^&#\s]+)/.exec(text);
  const candidate = fromUrl ? decodeURIComponent(fromUrl[1]) : text;
  if (!candidate) return;
  try {
    const res = await fetch('api/session', { headers: { Authorization: `Bearer ${candidate}` } });
    if (res.status === 401) { msg.textContent = 'This is not the token of this PathViz.'; return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    msg.textContent = `Cannot reach PathViz: ${err.message}`;
    return;
  }
  msg.textContent = '';
  $('#token-input').value = '';
  keepToken(candidate);
  $('#token-dialog').close();
  connect();
});

async function connect() {
  const conn = $('#conn');
  const retry = () => { conn.className = 'conn down'; conn.textContent = 'Reconnecting'; setTimeout(connect, 2000); };
  // An EventSource does not tell why it failed, so the token is checked first.
  try {
    const res = await api('api/session');
    if (res.status === 401) { askToken(); return; }
    if (!res.ok) { retry(); return; }
  } catch {
    retry();
    return;
  }
  const es = new EventSource(token ? `api/events?token=${encodeURIComponent(token)}` : 'api/events');
  es.onopen = () => { conn.className = 'conn up'; conn.textContent = 'Connected'; };
  es.onerror = () => {
    conn.className = 'conn down';
    conn.textContent = 'Reconnecting';
    // A refused EventSource gives up for good. A restarted PathViz has a new
    // token, so the token is checked again.
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
  };
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'hello':
        document.title = `PathViz on ${msg.data.host}`;
        state.hooks = msg.data.hooks;
        state.host = msg.data.state || state.host;
        // Without the packet view (--no-packet-view) the rows have no Inspect button.
        document.body.classList.toggle('no-packet-view', !msg.data.packetView);
        showFilter(msg.data.filter);
        buildDiagram();
        loadJourneys(msg.data.journeys || []);
        break;
      case 'journey': onJourney(msg.data); break;
      case 'filter': showFilter(msg.data); redraw(); break;
      case 'host': state.host = msg.data; redraw(); break;
      case 'clear': clearAll(); setLive(true); break;
      case 'stats':
        if (msg.data.lost > 0) {
          conn.className = 'conn up warn';
          conn.textContent = `Connected, ${msg.data.lost} probe events lost`;
        }
        break;
    }
  };
}

// ---- Controls --------------------------------------------------------------

// applyFilter asks pathviz to trace other traffic. The page updates when the
// server announces the new filter.
async function applyFilter(filter) {
  const msg = $('#filter-msg');
  try {
    const res = await api('api/filter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filter) });
    if (!res.ok) throw new Error((await res.text()).trim());
    msg.className = 'ok';
    msg.textContent = 'Probes updated.';
    setTimeout(() => { if (msg.textContent === 'Probes updated.') msg.textContent = ''; }, 2500);
  } catch (err) {
    msg.className = '';
    msg.textContent = `Filter not applied: ${err.message}`;
  }
}

// formFilter reads the filter the user typed. It returns null for bad ports.
function formFilter() {
  const split = (v) => v.split(/[\s,]+/).filter(Boolean);
  const ports = split($('#f-ports').value).map(Number);
  if (ports.some((p) => !Number.isInteger(p))) return null;
  return {
    proto: $('#f-proto').value,
    ifaces: split($('#f-ifaces').value).sort(),
    ips: split($('#f-ips').value),
    ports: ports.sort((a, b) => a - b),
  };
}

// The button applies a typed filter, so it is active only while the fields
// differ from what is traced. Picks in the diagram apply right away.
function markDirty() {
  const f = formFilter();
  $('#apply-btn').disabled = !!f && sameFilter(f, state.capture);
}

$('#filter').addEventListener('input', markDirty);

$('#filter').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = formFilter();
  if (!f) {
    $('#filter-msg').className = '';
    $('#filter-msg').textContent = 'Ports must be numbers.';
    return;
  }
  applyFilter(f);
});

$('#live-btn').addEventListener('click', () => {
  setLive(!state.live);
  if (state.live && state.journeys.length) showJourney(state.journeys[state.journeys.length - 1], true);
});

$('#clear-btn').addEventListener('click', () => api('api/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));

$('#help-btn').addEventListener('click', async () => {
  const res = await api('api/ruleset');
  // The comments are dimmed, and their [static] and [filter] labels stand out.
  const pre = $('#rules-text');
  pre.textContent = '';
  for (const line of (await res.text()).split('\n')) {
    const at = line.indexOf('#');
    if (at < 0 || line.slice(0, at).trim() !== '') {
      pre.append(line + '\n');
      continue;
    }
    const span = document.createElement('span');
    span.className = 'comment';
    for (const part of line.split(/(\[static\]|\[filter\])/)) {
      if (part === '[static]' || part === '[filter]') {
        const tag = document.createElement('span');
        tag.className = part === '[filter]' ? 'tag dynamic' : 'tag';
        tag.textContent = part;
        span.append(tag);
      } else {
        span.append(part);
      }
    }
    pre.append(span, '\n');
  }
  $('#rules-dialog').showModal();
});

if (view.hooksOnly) {
  $('#hops-title').textContent = 'Hooks of the selected packet';
  $('#hops-first').textContent = 'Hook';
  $('#hops-empty p').textContent = 'Select a packet to see what every hook saw.';
}
// The diagram switches between its two arrangements with the width it gets.
// Below WIDE_MIN it is the compact one. Above, the wide one is rebuilt for the
// exact width, so its lines stretch and shrink while the rest keeps its size.
const EMBED_MIN_WIDTH = 540;
let layoutFrame = 0;
// An embedded view without tables fits the diagram into the height it has.
const fitsHeight = view.embed && !tablesBelow;
// A fitted diagram sits in the middle of the height it has (the full view and an
// embed with tables below keep it at the top of its box).
if (fitsHeight) $('#diagram').setAttribute('preserveAspectRatio', 'xMidYMid meet');
new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  // The diagram is hidden while an embedded view shows its tables.
  if (!width) return;
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    // An embedded diagram does not shrink below EMBED_MIN_WIDTH (see style.css):
    // its box scrolls sideways then, and the layout is made for that width.
    diagramWidth = view.embed ? Math.max(width, EMBED_MIN_WIDTH) : width;
    diagramHeight = fitsHeight ? height : Infinity;
    if (state.hooks.length && pickLayout(view.hooksOnly, ...layoutCounts()).key !== G.key) redraw();
  });
}).observe($('#diagram-box'));
// ---- Tables fold and unfold ------------------------------------------------

// A click on the header of a table folds it down to that header, and back.
for (const head of document.querySelectorAll('.section-head[data-table]')) {
  const toggle = () => {
    collapsed[head.dataset.table] = !collapsed[head.dataset.table];
    applyCollapsed();
    // Only the full view remembers the choice: an embed starts the way its URL says.
    if (view.embed) return;
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed)); } catch { /* not saved, still applied */ }
  };
  head.addEventListener('click', (e) => { if (!e.target.closest('button')) toggle(); });
  head.addEventListener('keydown', (e) => {
    if (e.target !== head || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    toggle();
  });
}
applyCollapsed();

// ---- The header row of an embedded view --------------------------------------

// The connection badge is in the header row of an embedded view, and on the
// line under the filter in the full view.
if (view.embed) {
  $('#embedbar').hidden = false;
  $('#embedbar').append($('#conn'));
}

// The speed choice: a dropdown in the header (of the full view and of an
// embedded one), and chips in its place in the full view on a small screen.
const speedSelects = [...document.querySelectorAll('.speed-select')];
for (const sel of speedSelects) {
  for (const rate of SPEED_STEPS) sel.append(new Option(speedLabel(rate), String(rate)));
  sel.addEventListener('change', () => setSpeed(Number(sel.value)));
}
// A rate from the URL that is not one of the chips gets a chip of its own.
const chipRates = [...new Set([...SPEED_CHIPS, speed])].sort((a, b) => a - b);
for (const rate of chipRates) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.dataset.rate = String(rate);
  chip.textContent = speedLabel(rate);
  chip.addEventListener('click', () => setSpeed(rate));
  $('#speed-chips').append(chip);
}

function setSpeed(rate) {
  speed = rate;
  for (const sel of speedSelects) sel.value = String(rate);
  for (const chip of document.querySelectorAll('#speed-chips button')) {
    chip.setAttribute('aria-pressed', String(Number(chip.dataset.rate) === rate));
  }
}
setSpeed(speed);

// ---- The header of the full view ---------------------------------------------

// The header has three arrangements (see style.css). It is wide while the
// filter fits in one row between the logo and the speed dropdown, small on a
// narrow window, and mid in between.
const SMALL_HEADER = 560;
if (!view.embed) {
  const bar = $('.bar'), form = $('#filter');
  const fitHeader = () => {
    bar.classList.remove('mid', 'small');
    if (window.innerWidth < SMALL_HEADER) bar.classList.add('small');
    else if (form.scrollWidth > form.clientWidth + 1) bar.classList.add('mid');
    // The line under the filter is as wide as the fields with their button.
    const tracing = $('.tracing');
    if (bar.classList.contains('small')) {
      tracing.style.maxWidth = '';
    } else {
      const left = form.getBoundingClientRect().left;
      const right = Math.max(...[...form.querySelectorAll('label, #apply-btn')].map((el) => el.getBoundingClientRect().right));
      tracing.style.maxWidth = `${Math.round(right - left)}px`;
    }
  };
  new ResizeObserver(fitHeader).observe(bar);
  fitHeader();
}

// An embedded view: a switch between the packet's path and the packets.
if (hasSwitch) {
  $('#view-group').hidden = false;
  for (const btn of document.querySelectorAll('#viewswitch button')) {
    btn.addEventListener('click', () => {
      const tabular = btn.dataset.show === 'tables';
      document.body.classList.toggle('tabular', tabular);
      for (const b of document.querySelectorAll('#viewswitch button')) b.setAttribute('aria-pressed', String(b === btn));
    });
  }
}

connect();
