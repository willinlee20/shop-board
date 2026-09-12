/* =========================================================================
   工作留言板  app.js
   三重龍門 × 西門 ── 客戶預訂單 / 任務交接 / 例行工作
   資料庫：Google Sheet「進銷存總表－dragon2gates_bot」
   ========================================================================= */

/* ----------------------------- 設定區 -----------------------------------
   要改的東西都在這裡，下面的程式不用動。
   ----------------------------------------------------------------------- */
const CONFIG = {
  // Google Cloud OAuth 用戶端 ID（與 pnl-dashboard 同一個 Google Cloud 專案）
  CLIENT_ID: '936097912364-ulp0rghvnlef9ep52sv2nm260a2qbp86.apps.googleusercontent.com',

  // 進銷存總表的試算表 ID
  SPREADSHEET_ID: '1OZsbv9IWADz0FfBxQIaDuAXXhW5U40SRzOhjIRIPIww',

  // 留言板要寫在哪個工作表（不存在時程式會自動建立）
  BOARD_SHEET: '留言板',

  // 產品庫存工作表：程式會自動找名稱含「產品」或「Products」的工作表
  PRODUCT_SHEET_KEYWORDS: ['產品', 'product'],

  // 門市：label = 畫面顯示 / col = 庫存表的欄位標題
  STORES: [
    { label: '三重龍門', col: '三重店' },
    { label: '西門',     col: '西門店' }
  ],

  SLOTS: ['13:00-15:00', '15:00-17:00', '17:00-19:00', '19:00-22:00'],
  SOURCES: ['店內', '網路', '親友'],

  ROUTINES: [
    '明天的麻煩倒垃圾喔！今天沒有倒到垃圾',
    '明天要記得盤點喔！',
    '明天要記得清潔環境喔',
    '玻璃很髒，明天該擦囉！'
  ],

  // 庫存表的欄位標題（若日後欄位改名，改這裡即可）
  H: {
    code: '產品編號', name: '產品名稱', spec: '產品規格',
    reserve: '預定專區', warehouse: '總倉數量', total: '總數',
    safety: '安全庫存值', price: '售價'
  },

  POLL_SECONDS: 45          // 每幾秒自動抓一次新留言
};

const TYPES = { ORDER: '客戶預訂單', TASK: '任務交接', ROUTINE: '例行工作' };
const STATUS = { OPEN: '待處理', DONE: '已完成', CANCEL: '已取消' };
const STOCK = { RESERVED: '已預留', SHIPPED: '已出庫', RESTORED: '已還原', FAILED: '未扣', NA: '不適用' };

const BOARD_HEADERS = [
  'id', '類型', '建立時間', '建立者', '門市', '狀態',
  '客戶名稱', '客戶來源', '取貨日期', '取貨時段',
  '品項明細', '金額', '備註', '例行工作項目',
  '完成時間', '完成者', '品項JSON', '庫存異動JSON', '庫存狀態'
];
const C = {}; BOARD_HEADERS.forEach((h, i) => C[h] = i);   // 欄位 → 索引
const BOARD_LAST_COL = 'S';

/* ----------------------------- 狀態 ------------------------------------ */
const S = {
  token: null, tokenExp: 0, user: null,
  boardTitle: null, productTitle: null,
  products: null,          // { title, cols, rows:[], byRow:Map }
  board: [],               // [{ _row, id, 類型, ... }]
  filterStore: '全部',
  busy: false, pollTimer: null
};

/* ----------------------------- 小工具 ---------------------------------- */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const money = n => 'NT$' + Number(n || 0).toLocaleString('zh-TW');

function colLetter(i) {                       // 0 → A
  let s = '', n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function nowStr() {
  const d = new Date(), p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function todayStr() {
  const d = new Date(), p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 把儲存格內容轉數字；"$1,700" → 1700，公式 "=A1+1" → null */
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s.startsWith('=')) return null;
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}
function isFormula(v) { return typeof v === 'string' && v.trim().startsWith('='); }

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('toastHost').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6000 : 3200);
}

/* ----------------------------- 登入 ------------------------------------ */
let tokenClient = null;

function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/spreadsheets ' +
           'https://www.googleapis.com/auth/userinfo.email ' +
           'https://www.googleapis.com/auth/userinfo.profile',
    callback: resp => {
      if (resp.error || !resp.access_token) {
        gateError('登入沒有完成：' + (resp.error_description || resp.error || '未知原因'));
        return;
      }
      S.token = resp.access_token;
      S.tokenExp = Date.now() + (Number(resp.expires_in || 3600) - 120) * 1000;
      sessionStorage.setItem('sb_tok', JSON.stringify({ t: S.token, e: S.tokenExp }));
      afterLogin();
    }
  });

  // 這個分頁之前登入過就直接進去
  try {
    const c = JSON.parse(sessionStorage.getItem('sb_tok') || 'null');
    if (c && c.e > Date.now() + 60000) { S.token = c.t; S.tokenExp = c.e; afterLogin(); return; }
  } catch (e) { /* ignore */ }

  $('loginBtn').disabled = false;
}

function login() { gateError(null); tokenClient.requestAccessToken({ prompt: '' }); }

function logout() {
  sessionStorage.removeItem('sb_tok');
  if (S.token && google.accounts.oauth2.revoke) google.accounts.oauth2.revoke(S.token, () => {});
  location.reload();
}

function gateError(msg) {
  const el = $('gateErr');
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg; el.classList.remove('hidden');
}

async function afterLogin() {
  try {
    const me = await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
      { headers: { Authorization: 'Bearer ' + S.token } }).then(r => r.ok ? r.json() : null);
    S.user = me || { name: '（未知帳號）', email: '' };
  } catch (e) { S.user = { name: '（未知帳號）', email: '' }; }

  $('uName').textContent = S.user.name || S.user.email || '';
  if (S.user.picture) $('uAvatar').src = S.user.picture;
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');

  try {
    await bootstrap();
  } catch (err) {
    $('loadingBox').classList.add('hidden');
    $('listWrap').innerHTML =
      `<div class="empty"><b style="color:var(--bad)">讀取失敗</b><br><br>
       <span style="font-size:13px;white-space:pre-wrap">${esc(err.message)}</span></div>`;
  }
}

/* ----------------------------- Sheets API ------------------------------ */
async function api(path, opts = {}, retry = true) {
  if (!S.token) throw new Error('尚未登入');
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  if (r.status === 401 && retry) {                // token 過期 → 靜默換一張
    await new Promise(res => {
      tokenClient.callback = resp => {
        if (resp.access_token) {
          S.token = resp.access_token;
          S.tokenExp = Date.now() + (Number(resp.expires_in || 3600) - 120) * 1000;
          sessionStorage.setItem('sb_tok', JSON.stringify({ t: S.token, e: S.tokenExp }));
        }
        res();
      };
      tokenClient.requestAccessToken({ prompt: '' });
    });
    return api(path, opts, false);
  }
  if (!r.ok) {
    let detail = '';
    try { const j = await r.json(); detail = j.error && j.error.message ? j.error.message : ''; } catch (e) {}
    if (r.status === 403) throw new Error('沒有權限存取這份試算表。\n請確認 ' + (S.user?.email || '此帳號') + ' 已被加入「進銷存總表」的編輯者。\n\n' + detail);
    if (r.status === 404) throw new Error('找不到試算表，請檢查 app.js 的 SPREADSHEET_ID。\n\n' + detail);
    throw new Error(`Google Sheets 回應錯誤（${r.status}）\n${detail}`);
  }
  return r.json();
}

const rangeOf = (title, a1) => encodeURIComponent(`'${title.replace(/'/g, "''")}'!${a1}`);

async function readRange(title, a1, render) {
  const q = render ? `?valueRenderOption=${render}` : '';
  const j = await api(`${CONFIG.SPREADSHEET_ID}/values/${rangeOf(title, a1)}${q}`);
  return j.values || [];
}
async function writeRanges(data) {          // data:[{range,values}]
  if (!data.length) return;
  return api(`${CONFIG.SPREADSHEET_ID}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data })
  });
}
async function appendRow(title, values) {
  return api(`${CONFIG.SPREADSHEET_ID}/values/${rangeOf(title, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST', body: JSON.stringify({ values: [values] })
  });
}

/* ----------------------------- 啟動流程 -------------------------------- */
async function bootstrap() {
  const meta = await api(`${CONFIG.SPREADSHEET_ID}?fields=sheets.properties(title)`);
  const titles = (meta.sheets || []).map(s => s.properties.title);

  S.productTitle = titles.find(t =>
    CONFIG.PRODUCT_SHEET_KEYWORDS.some(k => t.toLowerCase().includes(k.toLowerCase())));
  if (!S.productTitle) throw new Error('在這份試算表找不到產品庫存工作表。\n現有工作表：' + titles.join('、'));

  if (titles.includes(CONFIG.BOARD_SHEET)) {
    S.boardTitle = CONFIG.BOARD_SHEET;
  } else {
    await api(`${CONFIG.SPREADSHEET_ID}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: CONFIG.BOARD_SHEET } } }] })
    });
    S.boardTitle = CONFIG.BOARD_SHEET;
    await writeRanges([{ range: `'${CONFIG.BOARD_SHEET}'!A1:${BOARD_LAST_COL}1`, values: [BOARD_HEADERS] }]);
    toast('已在試算表建立「' + CONFIG.BOARD_SHEET + '」工作表', 'ok');
  }

  $('subhead').textContent = `三重龍門 × 西門　·　庫存來源：${S.productTitle}`;

  await loadProducts();
  await loadBoard();
  $('loadingBox').classList.add('hidden');
  render();
  startPoll();
}

/** 讀庫存表：用標題列自動對應欄位，欄位順序變動也不會壞 */
async function loadProducts() {
  const rows = await readRange(S.productTitle, 'A1:Z600', 'FORMULA');
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if ((rows[i] || []).some(c => String(c).trim() === CONFIG.H.name)) { hi = i; break; }
  }
  if (hi < 0) throw new Error(`在「${S.productTitle}」找不到標題列（需要有一欄叫「${CONFIG.H.name}」）`);

  const cols = {};
  (rows[hi] || []).forEach((c, i) => { const k = String(c).trim(); if (k && cols[k] === undefined) cols[k] = i; });

  const need = [CONFIG.H.name, CONFIG.H.spec, CONFIG.H.reserve, ...CONFIG.STORES.map(s => s.col)];
  const miss = need.filter(h => cols[h] === undefined);
  if (miss.length) throw new Error(`「${S.productTitle}」缺少欄位：${miss.join('、')}`);

  const list = [], byRow = new Map(), byName = new Map(), names = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = String(r[cols[CONFIG.H.name]] ?? '').trim();
    if (!name) continue;
    const spec = String(r[cols[CONFIG.H.spec]] ?? '').trim();
    const nums = {}, formula = {};
    Object.keys(cols).forEach(h => {
      const raw = r[cols[h]];
      nums[h] = toNum(raw) ?? 0;
      formula[h] = isFormula(raw);
    });
    const p = {
      sheetRow: i + 1, name, spec,
      label: spec ? `${name}　${spec}` : name,
      nums, formula,
      price: nums[CONFIG.H.price] || 0
    };
    list.push(p); byRow.set(p.sheetRow, p);
    if (!byName.has(name)) { byName.set(name, []); names.push(name); }
    byName.get(name).push(p);
  }
  S.products = { title: S.productTitle, cols, rows: list, byRow, byName, names };
}

async function loadBoard() {
  const rows = await readRange(S.boardTitle, `A2:${BOARD_LAST_COL}2000`);
  S.board = rows.map((r, i) => {
    const o = { _row: i + 2 };
    BOARD_HEADERS.forEach((h, ci) => o[h] = r[ci] ?? '');
    return o;
  }).filter(o => o.id);
}

function startPoll() {
  clearInterval(S.pollTimer);
  S.pollTimer = setInterval(async () => {
    if (S.busy || document.querySelector('.modal')) return;
    try { await loadBoard(); render(); } catch (e) { /* 靜默 */ }
  }, CONFIG.POLL_SECONDS * 1000);
}

async function refreshAll(msg) {
  S.busy = true;
  try { await loadProducts(); await loadBoard(); render(); if (msg) toast(msg, 'ok'); }
  finally { S.busy = false; }
}

/* ========================= 庫存計算（核心邏輯） =========================
   一張預訂單的生命週期：

   1) 建立預訂單 ── 把貨「預留」起來
        取貨門市庫存  -N（門市不夠的部分，從總倉數量補）
        預定專區      +N
        → 總數不變。貨還在公司，只是被這張單佔住了。

   2) 客戶取貨，按「確認完成」── 真正出貨
        預定專區      -N
        → 總數減少 N。

   3) 客戶取消，按「取消預訂」── 貨放回去
        預定專區      -N
        原本扣的門市/總倉  +N（照當初的紀錄原路還回）
   ===================================================================== */

/** 算出「建立預訂單」要怎麼扣（不寫入，只回傳計畫，用來預覽＋記錄） */
function planReserve(items, storeLabel) {
  const storeCol = CONFIG.STORES.find(s => s.label === storeLabel).col;
  const used = new Map();                       // sheetRow → 已規劃扣掉的門市/總倉量
  const plan = [];
  for (const it of items) {
    const p = S.products.byRow.get(it.row);
    if (!p) continue;
    const u = used.get(it.row) || { store: 0, wh: 0 };
    const storeAvail = Math.max((p.nums[storeCol] || 0) - u.store, 0);
    const fromStore = Math.min(it.qty, storeAvail);
    const fromWh = it.qty - fromStore;
    const whAvail = (p.nums[CONFIG.H.warehouse] || 0) - u.wh;
    used.set(it.row, { store: u.store + fromStore, wh: u.wh + fromWh });
    plan.push({
      row: it.row, name: p.name, spec: p.spec, qty: it.qty, price: it.price,
      storeCol, fromStore, fromWh, short: Math.max(fromWh - Math.max(whAvail, 0), 0)
    });
  }
  return plan;
}

/** 把欄位增減量套用到庫存表（會先重新讀一次庫存，避免蓋掉別人剛改的數字） */
async function applyDeltas(deltas) {            // deltas: Map(row → {欄位: 增減})
  await loadProducts();
  const { cols, byRow, title } = S.products;
  const data = [];
  for (const [row, d] of deltas) {
    const p = byRow.get(row);
    if (!p) continue;
    for (const h of Object.keys(d)) {
      if (!d[h]) continue;
      if (cols[h] === undefined) continue;
      if (p.formula[h]) { console.warn('欄位是公式，跳過寫入', h, row); continue; }
      data.push({ range: `'${title}'!${colLetter(cols[h])}${row}`, values: [[(p.nums[h] || 0) + d[h]]] });
    }
    // 「總數」若是手打的數字就幫它重算；若是公式就不動
    if (cols[CONFIG.H.total] !== undefined && !p.formula[CONFIG.H.total]) {
      const parts = [...CONFIG.STORES.map(s => s.col), CONFIG.H.reserve, CONFIG.H.warehouse];
      let t = 0;
      parts.forEach(h => { t += (p.nums[h] || 0) + (d[h] || 0); });
      data.push({ range: `'${title}'!${colLetter(cols[CONFIG.H.total])}${row}`, values: [[t]] });
    }
  }
  await writeRanges(data);
}

function deltasFromPlan(plan, mode) {
  const m = new Map();
  const add = (row, h, v) => {
    if (!v) return;
    const d = m.get(row) || {}; d[h] = (d[h] || 0) + v; m.set(row, d);
  };
  for (const p of plan) {
    if (mode === 'reserve') {
      add(p.row, p.storeCol, -p.fromStore);
      add(p.row, CONFIG.H.warehouse, -p.fromWh);
      add(p.row, CONFIG.H.reserve, +p.qty);
    } else if (mode === 'ship') {
      add(p.row, CONFIG.H.reserve, -p.qty);
    } else if (mode === 'restore') {
      add(p.row, CONFIG.H.reserve, -p.qty);
      add(p.row, p.storeCol, +p.fromStore);
      add(p.row, CONFIG.H.warehouse, +p.fromWh);
    }
  }
  return m;
}

/* ----------------------------- 畫面渲染 -------------------------------- */
function render() {
  const store = S.filterStore;
  const rows = S.board.filter(r => store === '全部' || r['門市'] === store);
  const open = rows.filter(r => r['狀態'] === STATUS.OPEN);

  // 待取貨的預訂單：依取貨日期＋時段從最早排到最晚
  const orders = open.filter(r => r['類型'] === TYPES.ORDER)
    .sort((a, b) => (a['取貨日期'] + a['取貨時段']).localeCompare(b['取貨日期'] + b['取貨時段']));
  // 交接事項：最新的在最上面
  const notes = open.filter(r => r['類型'] !== TYPES.ORDER).reverse();
  const closed = rows.filter(r => r['狀態'] !== STATUS.OPEN).reverse().slice(0, 40);

  $('pendingCount').textContent = `待處理 ${open.length}`;

  let html = '';
  if (!open.length) {
    html += `<div class="empty">目前沒有待處理的留言 🎉<br><span style="font-size:13px">交接班時記得看一下這裡</span></div>`;
  }
  if (orders.length) {
    html += `<div class="sec-title">待取貨預訂單（${orders.length}）· 依取貨時間排序</div>` + orders.map(cardHTML).join('');
  }
  if (notes.length) {
    html += `<div class="sec-title">交接事項 / 例行工作（${notes.length}）</div>` + notes.map(cardHTML).join('');
  }
  if (closed.length) {
    html += `<div class="sec-title">已完成 / 已取消（最近 ${closed.length} 筆）</div>` + closed.map(cardHTML).join('');
  }
  $('listWrap').innerHTML = html;
}

function parseJSON(s, fb) { try { return JSON.parse(s); } catch (e) { return fb; } }

function cardHTML(r) {
  const t = r['類型'], done = r['狀態'] !== STATUS.OPEN;
  const tagCls = t === TYPES.ORDER ? 'tag-order' : t === TYPES.TASK ? 'tag-task' : 'tag-routine';
  let title = '', body = '';

  if (t === TYPES.ORDER) {
    const items = parseJSON(r['品項JSON'], []);
    title = `${esc(r['客戶名稱'] || '（未填客戶）')}`;
    body = `<dl class="kv">
        <dt>客戶來源</dt><dd>${esc(r['客戶來源'] || '—')}</dd>
        <dt>取貨時間</dt><dd><b>${esc(r['取貨日期'] || '—')}</b>　${esc(r['取貨時段'] || '')}</dd>
        ${r['備註'] ? `<dt>備註</dt><dd>${esc(r['備註'])}</dd>` : ''}
      </dl>
      <div class="items">
        ${items.map(i => `<div class="it"><b>${esc(i.name)}${i.spec ? '　' + esc(i.spec) : ''}</b>
            <span>× ${i.qty}</span><span>${money(i.price * i.qty)}</span></div>`).join('')}
        <div class="it sum"><span>合計</span><span>${money(r['金額'])}</span></div>
      </div>`;
    if (r['庫存狀態'] === STOCK.FAILED) {
      body += `<div class="note bad">⚠ 這張單的庫存還沒扣成功（可能是當時網路中斷）。請按下面的「重試扣庫存」。</div>`;
    } else if (!done && r['庫存狀態'] === STOCK.RESERVED) {
      body += `<div class="note">已從庫存預留這些貨（放在「預定專區」）。客戶取貨後按「確認取貨完成」才會真正出庫。</div>`;
    }
  } else if (t === TYPES.TASK) {
    title = '任務交接';
    body = `<div style="white-space:pre-wrap">${esc(r['備註'] || '（無內容）')}</div>`;
  } else {
    title = '例行工作';
    const list = String(r['例行工作項目'] || '').split('\n').filter(Boolean);
    body = `<ul style="margin:0;padding-left:20px">${list.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
      + (r['備註'] ? `<div style="margin-top:8px;color:var(--ink-2)">${esc(r['備註'])}</div>` : '');
  }

  let statusTag = r['狀態'] === STATUS.DONE ? '<span class="tag tag-done">已完成</span>'
    : r['狀態'] === STATUS.CANCEL ? '<span class="tag tag-cancel">已取消</span>' : '';
  if (!done && t === TYPES.ORDER && r['取貨日期']) {
    const d = r['取貨日期'], today = todayStr();
    if (d < today) statusTag = '<span class="tag tag-alert">已過取貨日</span>';
    else if (d === today) statusTag = '<span class="tag tag-routine">今天取貨</span>';
  }

  let actions = '';
  if (!done) {
    if (t === TYPES.ORDER) {
      if (r['庫存狀態'] === STOCK.FAILED) {
        actions = `<button class="btn btn-sm btn-primary" data-act="retry" data-id="${esc(r.id)}">重試扣庫存</button>
                   <button class="btn btn-sm btn-danger" data-act="cancel" data-id="${esc(r.id)}">刪除此單</button>`;
      } else {
        actions = `<button class="btn btn-sm btn-ok" data-act="ship" data-id="${esc(r.id)}">✓ 確認取貨完成</button>
                   <button class="btn btn-sm btn-danger" data-act="cancel" data-id="${esc(r.id)}">取消預訂</button>`;
      }
    } else {
      actions = `<button class="btn btn-sm btn-ok" data-act="finish" data-id="${esc(r.id)}">✓ 已處理完成</button>`;
    }
  }

  return `<article class="card ${done ? 'is-done' : ''}">
    <div class="card-top">
      <span class="tag ${tagCls}">${esc(t)}</span>
      <span class="tag tag-store">${esc(r['門市'])}</span>
      <h3 class="card-title">${title}</h3>
      ${statusTag}
    </div>
    <div class="card-body">${body}</div>
    <div class="card-foot">
      <span class="meta">${esc(r['建立者'])}　${esc(r['建立時間'])}
        ${done && r['完成時間'] ? `　·　${esc(r['狀態'])}：${esc(r['完成者'])} ${esc(r['完成時間'])}` : ''}</span>
      ${actions}
    </div>
  </article>`;
}

/* ----------------------------- 動作處理 -------------------------------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const r = S.board.find(x => x.id === b.dataset.id);
  if (!r) return;
  if (S.busy) return;
  const act = b.dataset.act;

  if (act === 'ship') {
    const items = parseJSON(r['品項JSON'], []);
    if (!confirm(`確認「${r['客戶名稱']}」已經取貨？\n\n按下確定後會從庫存的「預定專區」扣掉：\n` +
      items.map(i => `・${i.name} ${i.spec} × ${i.qty}`).join('\n'))) return;
    await doAction(b, async () => {
      const plan = parseJSON(r['庫存異動JSON'], []);
      if (plan.length) await applyDeltas(deltasFromPlan(plan, 'ship'));
      await updateBoardRow(r, { 狀態: STATUS.DONE, 完成時間: nowStr(), 完成者: userName(), 庫存狀態: STOCK.SHIPPED });
      toast('已完成並扣除庫存', 'ok');
    });
  }

  if (act === 'cancel') {
    if (!confirm('要取消這張預訂單嗎？\n\n預留的貨會原路還回門市／總倉庫存。')) return;
    await doAction(b, async () => {
      const plan = parseJSON(r['庫存異動JSON'], []);
      if (plan.length && r['庫存狀態'] === STOCK.RESERVED) await applyDeltas(deltasFromPlan(plan, 'restore'));
      await updateBoardRow(r, { 狀態: STATUS.CANCEL, 完成時間: nowStr(), 完成者: userName(), 庫存狀態: STOCK.RESTORED });
      toast('已取消，庫存已還原', 'ok');
    });
  }

  if (act === 'finish') {
    await doAction(b, async () => {
      await updateBoardRow(r, { 狀態: STATUS.DONE, 完成時間: nowStr(), 完成者: userName(), 庫存狀態: STOCK.NA });
      toast('已標記完成', 'ok');
    });
  }

  if (act === 'retry') {
    await doAction(b, async () => {
      const plan = parseJSON(r['庫存異動JSON'], []);
      await applyDeltas(deltasFromPlan(plan, 'reserve'));
      await updateBoardRow(r, { 庫存狀態: STOCK.RESERVED });
      toast('庫存已預留完成', 'ok');
    });
  }
});

function userName() { return (S.user && (S.user.name || S.user.email)) || '未知'; }

async function doAction(btn, fn) {
  S.busy = true; btn.disabled = true; const old = btn.textContent; btn.textContent = '處理中…';
  try { await fn(); await refreshAll(); }
  catch (err) { alert('操作失敗：\n\n' + err.message); }
  finally { S.busy = false; btn.disabled = false; btn.textContent = old; }
}

async function updateBoardRow(r, patch) {
  const data = [];
  for (const k of Object.keys(patch)) {
    const ci = C[k];
    if (ci === undefined) continue;
    data.push({ range: `'${S.boardTitle}'!${colLetter(ci)}${r._row}`, values: [[patch[k]]] });
    r[k] = patch[k];
  }
  await writeRanges(data);
}

/* ----------------------------- 新增留言表單 ---------------------------- */
let FORM = null;

function openForm() {
  FORM = { type: TYPES.ORDER, store: CONFIG.STORES[0].label, source: CONFIG.SOURCES[0], slot: CONFIG.SLOTS[0], routines: [], items: [newItem()] };
  const host = $('modalHost');
  host.innerHTML = `<div class="modal" id="modal">
    <div class="sheet">
      <div class="sheet-head">
        <h2>新增留言</h2>
        <button class="btn btn-ghost" id="closeForm">✕</button>
      </div>
      <div class="sheet-body">
        <div class="field">
          <label>留言類型</label>
          <div class="chips" id="typeChips">
            ${Object.values(TYPES).map(t => `<button class="chip ${t === TYPES.ORDER ? 'on' : ''}" data-type="${t}">${t}</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>對應門市 <span class="req">*</span></label>
          <div class="chips" id="storeChips">
            ${CONFIG.STORES.map((s, i) => `<button class="chip ${i === 0 ? 'on' : ''}" data-store="${s.label}">${s.label}</button>`).join('')}
          </div>
        </div>
        <div id="formBody"></div>
      </div>
      <div class="sheet-foot">
        <button class="btn" id="cancelForm">取消</button>
        <button class="btn btn-primary" id="submitForm">送出留言</button>
      </div>
    </div></div>`;

  $('closeForm').onclick = $('cancelForm').onclick = closeForm;
  $('submitForm').onclick = submitForm;
  host.querySelectorAll('#typeChips .chip').forEach(c => c.onclick = () => {
    FORM.type = c.dataset.type;
    host.querySelectorAll('#typeChips .chip').forEach(x => x.classList.toggle('on', x === c));
    renderFormBody();
  });
  host.querySelectorAll('#storeChips .chip').forEach(c => c.onclick = () => {
    FORM.store = c.dataset.store;
    host.querySelectorAll('#storeChips .chip').forEach(x => x.classList.toggle('on', x === c));
    if (FORM.type === TYPES.ORDER) renderFormBody();
  });
  renderFormBody();
}
function closeForm() { $('modalHost').innerHTML = ''; FORM = null; }
function newItem() { return { name: '', row: null, qty: 1, price: 0 }; }

function renderFormBody() {
  const b = $('formBody');
  if (FORM.type === TYPES.TASK) {
    b.innerHTML = `<div class="field">
        <label>交接內容 <span class="req">*</span></label>
        <textarea id="fTask" placeholder="例如：客人訂的小海豚煙彈明天到貨，到貨後打電話給他">${esc(FORM.taskText || '')}</textarea>
      </div>`;
    $('fTask').oninput = e => FORM.taskText = e.target.value;
    return;
  }
  if (FORM.type === TYPES.ROUTINE) {
    b.innerHTML = `<div class="field">
        <label>要交辦的例行工作（可多選） <span class="req">*</span></label>
        <div class="checks" id="fRoutines">
          ${CONFIG.ROUTINES.map((x, i) => `<label class="check ${FORM.routines.includes(x) ? 'on' : ''}">
              <input type="checkbox" data-i="${i}" ${FORM.routines.includes(x) ? 'checked' : ''}><span>${esc(x)}</span></label>`).join('')}
        </div>
      </div>
      <div class="field"><label>補充說明（可不填）</label>
        <textarea id="fRNote" placeholder="其他要提醒的事">${esc(FORM.note || '')}</textarea></div>`;
    b.querySelectorAll('#fRoutines input').forEach(cb => cb.onchange = () => {
      const v = CONFIG.ROUTINES[+cb.dataset.i];
      cb.checked ? FORM.routines.push(v) : FORM.routines = FORM.routines.filter(x => x !== v);
      cb.closest('.check').classList.toggle('on', cb.checked);
    });
    $('fRNote').oninput = e => FORM.note = e.target.value;
    return;
  }

  // ───── 客戶預訂單 ─────
  b.innerHTML = `
    <div class="field"><label>客戶名稱 <span class="req">*</span></label>
      <input type="text" id="fName" placeholder="王先生 / 0912xxxxxx" value="${esc(FORM.cName || '')}"></div>
    <div class="field"><label>客戶來源 <span class="req">*</span></label>
      <div class="chips" id="srcChips">
        ${CONFIG.SOURCES.map(s => `<button class="chip ${s === FORM.source ? 'on' : ''}" data-v="${s}">${s}</button>`).join('')}
      </div></div>
    <div class="field"><label>預計取貨日期 <span class="req">*</span></label>
      <input type="date" id="fDate" value="${FORM.date || todayStr()}"></div>
    <div class="field"><label>取貨時間範圍 <span class="req">*</span></label>
      <div class="chips" id="slotChips">
        ${CONFIG.SLOTS.map(s => `<button class="chip ${s === FORM.slot ? 'on' : ''}" data-v="${s}">${s}</button>`).join('')}
      </div></div>
    <div class="field"><label>預訂品項 <span class="req">*</span></label>
      <div id="itemRows"></div>
      <button class="btn add-item" id="addItem">＋ 增加品項</button>
      <div class="total-bar"><span>預訂金額合計</span><span id="fTotal">NT$0</span></div>
    </div>
    <div class="field"><label>備註</label>
      <textarea id="fNote" placeholder="例如：客人說會晚點來、要換殼…">${esc(FORM.note || '')}</textarea></div>`;

  $('fName').oninput = e => FORM.cName = e.target.value;
  $('fDate').oninput = e => FORM.date = e.target.value;
  $('fNote').oninput = e => FORM.note = e.target.value;
  FORM.date = FORM.date || todayStr();
  b.querySelectorAll('#srcChips .chip').forEach(c => c.onclick = () => {
    FORM.source = c.dataset.v;
    b.querySelectorAll('#srcChips .chip').forEach(x => x.classList.toggle('on', x === c));
  });
  b.querySelectorAll('#slotChips .chip').forEach(c => c.onclick = () => {
    FORM.slot = c.dataset.v;
    b.querySelectorAll('#slotChips .chip').forEach(x => x.classList.toggle('on', x === c));
  });
  $('addItem').onclick = () => { FORM.items.push(newItem()); renderItems(); };
  renderItems();
}

function stockText(p) {
  const parts = CONFIG.STORES.map(s => `${s.label} ${p.nums[s.col] || 0}`);
  parts.push(`總倉 ${p.nums[CONFIG.H.warehouse] || 0}`);
  const res = p.nums[CONFIG.H.reserve] || 0;
  if (res) parts.push(`已預訂 ${res}`);
  return parts.join('　/　');
}

function stockBrief(p) {
  const parts = CONFIG.STORES.map(s => `${s.label} ${p.nums[s.col] || 0}`);
  parts.push(`倉 ${p.nums[CONFIG.H.warehouse] || 0}`);
  const storeCol = CONFIG.STORES.find(s => s.label === FORM.store).col;
  const z = (p.nums[storeCol] || 0) <= 0 ? '  ⚠本店無現貨' : '';
  return `（${parts.join(' / ')}）${z}`;
}

function renderItems() {
  const host = $('itemRows');
  const names = S.products.names;
  host.innerHTML = FORM.items.map((it, i) => {
    const p = it.row ? S.products.byRow.get(it.row) : null;
    const variants = it.name ? (S.products.byName.get(it.name) || []) : [];
    return `<div class="item-row" data-i="${i}">
      <div class="two">
        <div class="f"><label>① 產品名稱</label>
          <select class="itemName">
            <option value="">— 請選擇產品名稱（共 ${names.length} 項）—</option>
            ${names.map(n => `<option value="${esc(n)}"${n === it.name ? ' selected' : ''}>${esc(n)}</option>`).join('')}
          </select>
        </div>
        <div class="f"><label>② 產品規格</label>
          <select class="itemSpec"${it.name ? '' : ' disabled'}>
            <option value="">${it.name ? `— 請選擇規格（${variants.length} 種）—` : '請先選產品名稱'}</option>
            ${variants.map(v => `<option value="${v.sheetRow}"${v.sheetRow === it.row ? ' selected' : ''}>${esc(v.spec || '（無規格）')}${esc(stockBrief(v))}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="stockline${p ? '' : ' hidden'}">${p ? esc(stockText(p)) + '　·　售價 ' + money(p.price) : ''}</div>
      <div class="r2">
        <div class="f"><label>數量</label><input type="number" class="itemQty" min="1" step="1" value="${it.qty}"></div>
        <div class="f"><label>銷售價格（單價）</label><input type="number" class="itemPrice" min="0" step="1" value="${it.price}"></div>
        <div class="f" style="max-width:110px"><label>小計</label>
          <input type="text" value="${money(it.qty * it.price)}" readonly style="background:#f1f5f9"></div>
        ${FORM.items.length > 1 ? `<button class="del" title="刪除這個品項">✕</button>` : ''}
      </div>
    </div>`;
  }).join('');

  host.querySelectorAll('.item-row').forEach(row => {
    const i = +row.dataset.i, it = FORM.items[i];

    row.querySelector('.itemName').onchange = e => {
      it.name = e.target.value;
      it.row = null;
      const vs = S.products.byName.get(it.name) || [];
      if (vs.length === 1) { it.row = vs[0].sheetRow; it.price = vs[0].price; }   // 只有一種規格就自動選好
      renderItems(); updateTotal();
    };
    row.querySelector('.itemSpec').onchange = e => {
      it.row = +e.target.value || null;
      const p = it.row ? S.products.byRow.get(it.row) : null;
      if (p) it.price = p.price;
      renderItems(); updateTotal();
    };
    row.querySelector('.itemQty').oninput = e => { it.qty = Math.max(1, +e.target.value || 1); updateTotal(); syncSub(row, it); };
    row.querySelector('.itemPrice').oninput = e => { it.price = Math.max(0, +e.target.value || 0); updateTotal(); syncSub(row, it); };
    const del = row.querySelector('.del');
    if (del) del.onclick = () => { FORM.items.splice(i, 1); renderItems(); updateTotal(); };
  });
  updateTotal();
}
function syncSub(row, it) { row.querySelector('.r2 .f:nth-child(3) input').value = money(it.qty * it.price); }
function formTotal() { return FORM.items.reduce((s, i) => s + (i.qty * i.price), 0); }
function updateTotal() { const el = $('fTotal'); if (el) el.textContent = money(formTotal()); }

async function submitForm() {
  const btn = $('submitForm');
  const t = FORM.type;
  const id = 'M' + Date.now().toString(36).toUpperCase();
  let values = new Array(BOARD_HEADERS.length).fill('');
  values[C['id']] = id;
  values[C['類型']] = t;
  values[C['建立時間']] = nowStr();
  values[C['建立者']] = userName();
  values[C['門市']] = FORM.store;
  values[C['狀態']] = STATUS.OPEN;
  values[C['庫存狀態']] = STOCK.NA;

  let plan = null;

  if (t === TYPES.TASK) {
    if (!(FORM.taskText || '').trim()) return alert('請填寫交接內容');
    values[C['備註']] = FORM.taskText.trim();
  } else if (t === TYPES.ROUTINE) {
    if (!FORM.routines.length) return alert('請至少勾選一項例行工作');
    values[C['例行工作項目']] = FORM.routines.join('\n');
    values[C['備註']] = (FORM.note || '').trim();
  } else {
    if (!(FORM.cName || '').trim()) return alert('請填寫客戶名稱');
    if (!FORM.date) return alert('請選擇預計取貨日期');
    const items = FORM.items.filter(i => i.row).map(i => ({ row: i.row, qty: i.qty, price: i.price }));
    if (!items.length) return alert('請選擇預訂品項：先選「產品名稱」，再選「產品規格」');

    plan = planReserve(items, FORM.store);
    const shorts = plan.filter(p => p.short > 0);
    const msg = '請確認這張預訂單會怎麼動庫存：\n\n' +
      plan.map(p => {
        const bits = [];
        if (p.fromStore) bits.push(`${FORM.store} −${p.fromStore}`);
        if (p.fromWh) bits.push(`總倉 −${p.fromWh}`);
        return `・${p.name} ${p.spec} × ${p.qty}\n　　${bits.join('、')}　→　預定專區 +${p.qty}`;
      }).join('\n') +
      '\n\n（總數不變，客戶取貨按「確認完成」時才真正出庫）' +
      (shorts.length ? '\n\n⚠ 以下品項連總倉都不足，送出後庫存會變成負數，請確認是否要跟廠商調貨：\n' +
        shorts.map(p => `・${p.name} ${p.spec}（缺 ${p.short}）`).join('\n') : '');
    if (!confirm(msg)) return;

    values[C['客戶名稱']] = FORM.cName.trim();
    values[C['客戶來源']] = FORM.source;
    values[C['取貨日期']] = FORM.date;
    values[C['取貨時段']] = FORM.slot;
    values[C['金額']] = formTotal();
    values[C['備註']] = (FORM.note || '').trim();
    values[C['品項明細']] = plan.map(p => `${p.name} ${p.spec} ×${p.qty}`).join('\n');
    values[C['品項JSON']] = JSON.stringify(plan.map(p => ({ row: p.row, name: p.name, spec: p.spec, qty: p.qty, price: p.price })));
    values[C['庫存異動JSON']] = JSON.stringify(plan.map(p =>
      ({ row: p.row, qty: p.qty, storeCol: p.storeCol, fromStore: p.fromStore, fromWh: p.fromWh })));
    values[C['庫存狀態']] = STOCK.FAILED;      // 先記未扣，扣成功後改「已預留」
  }

  S.busy = true; btn.disabled = true; btn.textContent = '送出中…';
  try {
    await appendRow(S.boardTitle, values);
    if (plan) {
      try {
        await applyDeltas(deltasFromPlan(plan, 'reserve'));
        await loadBoard();
        const r = S.board.find(x => x.id === id);
        if (r) await updateBoardRow(r, { 庫存狀態: STOCK.RESERVED });
      } catch (err) {
        alert('留言已送出，但庫存預留失敗：\n' + err.message + '\n\n請在卡片上按「重試扣庫存」。');
      }
    }
    closeForm();
    await refreshAll('留言已送出');
  } catch (err) {
    alert('送出失敗：\n\n' + err.message);
  } finally {
    S.busy = false;
    if ($('submitForm')) { btn.disabled = false; btn.textContent = '送出留言'; }
  }
}

/* ----------------------------- 事件綁定 -------------------------------- */
window.addEventListener('DOMContentLoaded', () => {
  $('loginBtn').disabled = true;
  $('loginBtn').onclick = login;
  $('logoutBtn').onclick = logout;
  $('refreshBtn').onclick = () => refreshAll('已更新');
  $('newBtnTop').onclick = openForm;
  document.querySelectorAll('#storeSeg button').forEach(b => b.onclick = () => {
    S.filterStore = b.dataset.store;
    document.querySelectorAll('#storeSeg button').forEach(x => x.classList.toggle('on', x === b));
    render();
  });

  // 等 Google 登入程式庫載入
  let tries = 0;
  const wait = setInterval(() => {
    if (window.google && google.accounts && google.accounts.oauth2) { clearInterval(wait); initAuth(); }
    else if (++tries > 60) { clearInterval(wait); gateError('無法載入 Google 登入程式庫，請檢查網路後重新整理。'); }
  }, 100);
});
