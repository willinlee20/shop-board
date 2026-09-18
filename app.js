/* =========================================================================
   工作留言板  app.js
   三重龍門 × 西門 ── 客戶預訂單 / 任務交接 / 例行工作
   資料庫：Google Sheet「進銷存總表－dragon2gates_bot」
   ========================================================================= */

/* ----------------------------- 版本 ------------------------------------ */
const APP_VERSION = '2.6';          // 每次改版都會更新，畫面右上角看得到
const APP_DATE = '2026-09-18';

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
    category: '分類',       // ← 在庫存表新增這一欄，品項選單就會多一層分類分頁
    reserve: '預定專區', warehouse: '總倉數量', total: '總數',
    safety: '安全庫存值', price: '售價'
  },

  POLL_SECONDS: 45          // 每幾秒自動抓一次新留言
};

const TYPES = { ORDER: '客戶預訂單', STOCKUP: '備貨', TASK: '任務交接', ROUTINE: '例行工作' };
const STATUS = { OPEN: '待處理', DONE: '已完成', CANCEL: '已取消' };
const STOCK = { RESERVED: '已預留', SHIPPED: '已出庫', TRANSFERRED: '已轉入門市', RESTORED: '已還原', FAILED: '未扣', NA: '不適用' };

const BOARD_HEADERS = [
  'id', '類型', '建立時間', '建立者', '門市', '狀態',
  '客戶名稱', '客戶來源', '取貨日期', '取貨時段',
  '品項明細', '金額', '備註', '例行工作項目',
  '完成時間', '完成者', '品項JSON', '庫存異動JSON', '庫存狀態',
  '最後修改時間', '最後修改者', '修改紀錄', '關聯單號'
];
const C = {}; BOARD_HEADERS.forEach((h, i) => C[h] = i);   // 欄位 → 索引
const BOARD_LAST_COL = 'W';

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

/* --------------------- 庫存來源 / 去向（總倉 + 各門市） ------------------ */
/** 可選的庫存位置，預設第一個（總倉） */
function srcOptions() {
  return [{ col: CONFIG.H.warehouse, label: '總倉' },
          ...CONFIG.STORES.map(s => ({ col: s.col, label: s.label }))];
}
const DEFAULT_SRC = () => CONFIG.H.warehouse;
const UNCAT = '未分類';            // 分類欄空白時歸在這裡
const ALL_CAT = '__ALL__';         // 「全部」分頁
/** 欄位標題 → 畫面顯示的名字（三重店 → 三重龍門） */
function srcLabel(col) {
  const hit = srcOptions().find(o => o.col === col);
  return hit ? hit.label : (col || '總倉');
}
/** 門市名稱 → 庫存欄位標題 */
function storeCol(label) {
  const s = CONFIG.STORES.find(x => x.label === label);
  return s ? s.col : CONFIG.H.warehouse;
}

/* ----------------------------- 登入 ------------------------------------ */
let tokenClient = null;
const SCOPE_SHEETS = 'https://www.googleapis.com/auth/spreadsheets';
const SCOPES = SCOPE_SHEETS +
  ' https://www.googleapis.com/auth/userinfo.email' +
  ' https://www.googleapis.com/auth/userinfo.profile';

function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: SCOPES,
    callback: resp => {
      if (resp.error || !resp.access_token) {
        gateError('登入沒有完成：' + (resp.error_description || resp.error || '未知原因'));
        $('loginBtn').disabled = false;
        return;
      }

      // 必須真的拿到「試算表」權限，否則後面讀寫會被 Google 擋掉
      const hasSheets = !google.accounts.oauth2.hasGrantedAllScopes
        || google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE_SHEETS);
      if (!hasSheets) {
        if (!S.consentTried) {                      // 第一次遇到 → 強制跳出同意畫面再要一次
          S.consentTried = true;
          gateError('需要你授權「Google 試算表」的存取權，請在接下來的畫面按「繼續 / 允許」。');
          setTimeout(() => tokenClient.requestAccessToken({ prompt: 'consent' }), 400);
          return;
        }
        gateError('這次登入沒有授權到 Google 試算表的權限，所以讀不到庫存。\n\n'
          + '請再按一次登入，在 Google 的畫面上把「查看、編輯、建立及刪除你所有的 Google 試算表」勾起來，再按「繼續」。');
        $('loginBtn').disabled = false;
        return;
      }

      S.token = resp.access_token;
      S.scope = resp.scope || '';
      S.tokenExp = Date.now() + (Number(resp.expires_in || 3600) - 120) * 1000;
      sessionStorage.setItem('sb_tok', JSON.stringify({ t: S.token, e: S.tokenExp, s: S.scope }));
      afterLogin();
    }
  });

  // 這個分頁之前登入過、而且權限是完整的，就直接進去
  try {
    const c = JSON.parse(sessionStorage.getItem('sb_tok') || 'null');
    if (c && c.e > Date.now() + 60000 && String(c.s || '').includes('spreadsheets')) {
      S.token = c.t; S.tokenExp = c.e; S.scope = c.s; afterLogin(); return;
    }
  } catch (e) { /* ignore */ }

  $('loginBtn').disabled = false;
}

function login() { gateError(null); tokenClient.requestAccessToken({ prompt: '' }); }

/** 重新授權：清掉舊 token，強制跳出 Google 同意畫面 */
function reauth() {
  sessionStorage.removeItem('sb_tok');
  S.consentTried = true;
  S.token = null;
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

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
       <span style="font-size:13px;white-space:pre-wrap">${esc(err.message)}</span>
       ${err.needAuth ? `<br><br><button class="btn btn-primary" onclick="reauth()">重新授權 Google 試算表</button>` : ''}
       </div>`;
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
    if (r.status === 403) {
      if (/insufficient authentication scopes|SCOPE_INSUFFICIENT|ACCESS_TOKEN_SCOPE/i.test(detail)) {
        sessionStorage.removeItem('sb_tok');
        const e = new Error('登入時沒有授權到「Google 試算表」的存取權，所以讀不到庫存。\n'
          + '（這不是試算表權限的問題，是 Google 登入範圍的問題）\n\n'
          + '請按下面的按鈕重新授權，並在 Google 畫面上按「繼續 / 允許」。');
        e.needAuth = true;
        throw e;
      }
      throw new Error('這個 Google 帳號沒有存取這份試算表的權限。\n請確認 ' + (S.user?.email || '此帳號') + ' 已被加入「進銷存總表」的編輯者。\n\n' + detail);
    }
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
  const fields = '?fields=sheets.properties(sheetId,title)';
  let sheets = (await api(CONFIG.SPREADSHEET_ID + fields)).sheets || [];
  const find = t => sheets.find(s => s.properties.title === t);

  S.productTitle = sheets.map(s => s.properties.title).find(t =>
    CONFIG.PRODUCT_SHEET_KEYWORDS.some(k => t.toLowerCase().includes(k.toLowerCase())));
  if (!S.productTitle) throw new Error('在這份試算表找不到產品庫存工作表。\n現有工作表：'
    + sheets.map(s => s.properties.title).join('、'));

  if (!find(CONFIG.BOARD_SHEET)) {
    await api(`${CONFIG.SPREADSHEET_ID}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: CONFIG.BOARD_SHEET } } }] })
    });
    sheets = (await api(CONFIG.SPREADSHEET_ID + fields)).sheets || [];
    toast('已在試算表建立「' + CONFIG.BOARD_SHEET + '」工作表', 'ok');
  }
  S.boardTitle = CONFIG.BOARD_SHEET;
  S.boardSheetId = find(CONFIG.BOARD_SHEET).properties.sheetId;

  // 標題列若缺欄位（例如程式更新後多了「修改紀錄」）就自動補上
  const hdr = (await readRange(S.boardTitle, `A1:${BOARD_LAST_COL}1`))[0] || [];
  if (BOARD_HEADERS.some((h, i) => String(hdr[i] || '') !== h)) {
    await writeRanges([{ range: `'${S.boardTitle}'!A1:${BOARD_LAST_COL}1`, values: [BOARD_HEADERS] }]);
  }

  $('subhead').dataset.base = `三重龍門 × 西門　·　庫存來源：${S.productTitle}`;

  await loadProducts();
  await loadBoard();
  if (window.initSales) await window.initSales(sheets);      // 銷售紀錄模組
  $('loadingBox').classList.add('hidden');
  render();
  startPoll();
}

/** 讀庫存表：用標題列自動對應欄位，欄位順序變動也不會壞 */
async function loadProducts() {
  const rows = await readRange(S.productTitle, 'A1:Z3000', 'FORMULA');
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
    const rawCat = cols[CONFIG.H.category] !== undefined
      ? String(r[cols[CONFIG.H.category]] ?? '').trim() : '';
    const p = {
      sheetRow: i + 1, name, spec,
      cat: rawCat || UNCAT,
      label: spec ? `${name}　${spec}` : name,
      nums, formula,
      price: nums[CONFIG.H.price] || 0
    };
    list.push(p); byRow.set(p.sheetRow, p);
    if (!byName.has(name)) { byName.set(name, []); names.push(name); }
    byName.get(name).push(p);
  }

  // 分類（依照試算表由上到下的順序）
  const cats = [], byCat = new Map();
  for (const p of list) {
    if (!byCat.has(p.cat)) { byCat.set(p.cat, []); cats.push(p.cat); }
    const arr = byCat.get(p.cat);
    if (!arr.includes(p.name)) arr.push(p.name);
  }
  // 只有在庫存表真的有「分類」欄、而且有填東西時，才啟用分類分頁
  const hasCats = cols[CONFIG.H.category] !== undefined && cats.some(c => c !== UNCAT);

  S.products = { title: S.productTitle, cols, rows: list, byRow, byName, names, cats, byCat, hasCats };

  const sub = $('subhead');
  if (sub) {
    const catNote = hasCats ? `　·　${cats.length} 個分類：${cats.join('、')}` : '　·　尚未設定分類欄';
    sub.textContent = (sub.dataset.base || '三重龍門 × 西門') + `　·　${list.length} 個品項${catNote}`;
  }
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

/**
 * 算出這張單要從哪裡扣多少（不寫入，只回傳計畫，用來預覽＋記錄）
 * items: [{ row, qty, price, src }]　src = 庫存欄位標題，預設總倉
 */
function planReserve(items) {
  const used = new Map();                       // row|src → 這張單已經規劃扣掉的量
  const plan = [];
  for (const it of items) {
    const p = S.products.byRow.get(it.row);
    if (!p) continue;
    const src = it.src || DEFAULT_SRC();
    const k = it.row + '|' + src;
    const u = used.get(k) || 0;
    const avail = (p.nums[src] || 0) - u;
    used.set(k, u + it.qty);
    plan.push({
      row: it.row, name: p.name, spec: p.spec, qty: it.qty,
      price: it.price || 0, src,
      short: Math.max(it.qty - Math.max(avail, 0), 0)   // 來源不夠的數量
    });
  }
  return plan;
}

/** 舊格式（storeCol/fromStore/fromWh）轉成新格式（src/qty），保持舊單可以正常取消或完成 */
function normPlan(plan) {
  const out = [];
  for (const p of (plan || [])) {
    if (p.src) { out.push(p); continue; }
    if (p.fromStore) out.push({ ...p, src: p.storeCol, qty: p.fromStore });
    if (p.fromWh) out.push({ ...p, src: CONFIG.H.warehouse, qty: p.fromWh });
    if (!p.fromStore && !p.fromWh) out.push({ ...p, src: p.storeCol || CONFIG.H.warehouse });
  }
  return out;
}

/** 品項有可能因為庫存表插入列而位移，優先用「產品名稱＋規格」重新定位 */
/**
 * 從存下來的品項紀錄找回產品。
 * 一定要「產品名稱＋規格」優先、列號只當備援——庫存表插過列之後，
 * 舊紀錄裡的列號會指到別的產品，直接用列號會抓成完全不同的東西。
 */
function findProduct(i) {
  if (i && i.name) {
    const list = S.products.byName.get(i.name);
    if (list) {
      const hit = list.find(x => String(x.spec || '') === String(i.spec || ''));
      if (hit) return hit;
    }
  }
  return (i && i.row) ? (S.products.byRow.get(i.row) || null) : null;
}
function resolveRow(p) {
  const hit = findProduct(p);
  return hit ? hit.sheetRow : p.row;
}

/**
 * 把一張單的庫存計畫套用到庫存表：
 *   reserve  建立單子     來源 −N、預定專區 +N（總數不變）
 *   ship     客人取貨     預定專區 −N（總數 −N，真正出庫）
 *   transfer 備貨完成     預定專區 −N、目的地 +N（總數不變，只是換位置）
 *   restore  取消         預定專區 −N、目的地 +N（沒指定就退回原來源）
 * 寫入前會重新讀一次庫存，避免蓋掉別人剛改的數字。
 */
async function applyPlan(plan, mode, dest) {
  plan = normPlan(plan);
  if (!plan.length) return;
  await loadProducts();
  const m = new Map();
  const add = (row, h, v) => {
    if (!v || !h) return;
    const d = m.get(row) || {}; d[h] = (d[h] || 0) + v; m.set(row, d);
  };
  for (const p of plan) {
    const row = resolveRow(p);
    const src = p.src || DEFAULT_SRC();
    if (mode === 'reserve') {
      add(row, src, -p.qty);
      add(row, CONFIG.H.reserve, +p.qty);
    } else if (mode === 'ship') {
      add(row, CONFIG.H.reserve, -p.qty);
    } else if (mode === 'transfer' || mode === 'restore') {
      add(row, CONFIG.H.reserve, -p.qty);
      add(row, dest || src, +p.qty);
    } else if (mode === 'sell') {          // 銷售單：直接從來源扣掉（不經過預定專區）
      add(row, src, -p.qty);
    } else if (mode === 'unsell') {        // 退貨入庫 / 銷售單作廢
      add(row, src, +p.qty);
    }
  }
  await writeDeltas(m);
}

/** 把欄位增減量真正寫進庫存表 */
async function writeDeltas(deltas) {            // deltas: Map(row → {欄位: 增減})
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

/**
 * 修改單子時，算出「舊計畫 → 新計畫」的差額。
 * 不要用「先全部還原、再全部重新預留」——只要其中一步沒跑到（例如舊的
 * 庫存異動JSON 是空的、或庫存狀態不是「已預留」），沒動到的品項就會被重複扣。
 * 改成只動真正有變的量：沒改的品項差額是 0，完全不會被碰到。
 */
function planDelta(oldPlan, newPlan) {
  // 舊單可能把來源寫成門市名稱（三重龍門）而不是庫存欄位（三重店），
  // 沒對齊的話同一個品項會被當成兩筆，舊的退不掉、新的又扣一次。
  const srcCol = s => {
    if (!s) return DEFAULT_SRC();
    if (S.products.cols[s] !== undefined) return s;      // 已經是欄位標題
    const byLabel = srcOptions().find(o => o.label === s);
    return byLabel ? byLabel.col : s;
  };
  const key = p => resolveRow(p) + '|' + srcCol(p.src);
  const bag = new Map();                       // key → {row,name,spec,src,old,new}
  const put = (p, field) => {
    const k = key(p);
    const e = bag.get(k) || { row: resolveRow(p), name: p.name, spec: p.spec,
                              src: srcCol(p.src), old: 0, new: 0 };
    e[field] += Number(p.qty) || 0;
    bag.set(k, e);
  };
  normPlan(oldPlan).forEach(p => put(p, 'old'));
  normPlan(newPlan).forEach(p => put(p, 'new'));

  const more = [], less = [];                  // more：要多預留　less：要退回來
  for (const e of bag.values()) {
    const d = e.new - e.old;
    if (d > 0) more.push({ row: e.row, name: e.name, spec: e.spec, src: e.src, qty: d });
    else if (d < 0) less.push({ row: e.row, name: e.name, spec: e.spec, src: e.src, qty: -d });
  }
  return { more, less };
}

/** 依差額調整庫存：多的再預留、少的退回來。一次寫入，不會有中間狀態 */
async function applyDelta(delta) {
  if (!delta.more.length && !delta.less.length) return;
  await loadProducts();
  const m = new Map();
  const add = (row, h, v) => {
    if (!v || !h) return;
    const d = m.get(row) || {}; d[h] = (d[h] || 0) + v; m.set(row, d);
  };
  for (const p of delta.more) {                // 來源 −N、預定專區 +N
    const row = resolveRow(p);
    add(row, p.src || DEFAULT_SRC(), -p.qty);
    add(row, CONFIG.H.reserve, +p.qty);
  }
  for (const p of delta.less) {                // 預定專區 −N、退回來源 +N
    const row = resolveRow(p);
    add(row, CONFIG.H.reserve, -p.qty);
    add(row, p.src || DEFAULT_SRC(), +p.qty);
  }
  await writeDeltas(m);
}

/** 差額的說明文字 */
function deltaText(delta) {
  const out = [];
  delta.less.forEach(p => out.push(`・${`${p.name} ${p.spec || ''}`.trim()} ×${p.qty}　預定專區 −${p.qty} → ${srcLabel(p.src)} +${p.qty}（退回）`));
  delta.more.forEach(p => out.push(`・${`${p.name} ${p.spec || ''}`.trim()} ×${p.qty}　${srcLabel(p.src)} −${p.qty} → 預定專區 +${p.qty}（多預留）`));
  return out.length ? out.join('\n') : '（沒有品項或數量變動，庫存不會動）';
}

/** 把計畫轉成人看得懂的文字，用在確認視窗 */
function planText(plan, mode, dest) {
  return normPlan(plan).map(p => {
    const name = `${p.name} ${p.spec || ''}`.trim();
    const src = srcLabel(p.src || DEFAULT_SRC());
    if (mode === 'reserve') return `・${name} ×${p.qty}　${src} −${p.qty} → 預定專區 +${p.qty}`;
    if (mode === 'ship') return `・${name} ×${p.qty}　預定專區 −${p.qty}（出庫，總數減少）`;
    if (mode === 'sell') return `・${name} ×${p.qty}　${src} −${p.qty}（出售，總數減少）`;
    if (mode === 'unsell') return `・${name} ×${p.qty}　${src} +${p.qty}（回補庫存）`;
    return `・${name} ×${p.qty}　預定專區 −${p.qty} → ${srcLabel(dest || p.src)} +${p.qty}`;
  }).join('\n');
}

/* ----------------------------- 畫面渲染 -------------------------------- */
function render() {
  const store = S.filterStore;
  const rows = S.board.filter(r => store === '全部' || r['門市'] === store);
  const open = rows.filter(r => r['狀態'] === STATUS.OPEN);

  // 待取貨的預訂單：依取貨日期＋時段從最早排到最晚
  const orders = open.filter(r => r['類型'] === TYPES.ORDER)
    .sort((a, b) => (a['取貨日期'] + a['取貨時段']).localeCompare(b['取貨日期'] + b['取貨時段']));
  // 待備貨：依日期排序
  const stockups = open.filter(r => r['類型'] === TYPES.STOCKUP)
    .sort((a, b) => String(a['取貨日期']).localeCompare(String(b['取貨日期'])));
  // 交接事項：最新的在最上面
  const notes = open.filter(r => r['類型'] !== TYPES.ORDER && r['類型'] !== TYPES.STOCKUP).reverse();
  const closed = rows.filter(r => r['狀態'] !== STATUS.OPEN).reverse().slice(0, 40);

  $('pendingCount').textContent = `待處理 ${open.length}`;

  let html = '';
  if (!open.length) {
    html += `<div class="empty">目前沒有待處理的留言 🎉<br><span style="font-size:13px">交接班時記得看一下這裡</span></div>`;
  }
  if (orders.length) {
    html += `<div class="sec-title">待取貨預訂單（${orders.length}）· 依取貨時間排序</div>` + orders.map(cardHTML).join('');
  }
  if (stockups.length) {
    html += `<div class="sec-title">待備貨（${stockups.length}）· 依日期排序</div>` + stockups.map(cardHTML).join('');
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
  const tagCls = t === TYPES.ORDER ? 'tag-order' : t === TYPES.STOCKUP ? 'tag-stock'
    : t === TYPES.TASK ? 'tag-task' : 'tag-routine';
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
            ${i.src ? `<span class="src">${esc(srcLabel(i.src))} 出</span>` : ''}
            <span>× ${i.qty}</span><span>${money(i.price * i.qty)}</span></div>`).join('')}
        <div class="it sum"><span>合計</span><span>${money(r['金額'])}</span></div>
      </div>`;
    if (r['庫存狀態'] === STOCK.FAILED) {
      body += `<div class="note bad">⚠ 這張單的庫存還沒扣成功（可能是當時網路中斷）。請按下面的「重試扣庫存」。</div>`;
    } else if (!done && r['庫存狀態'] === STOCK.RESERVED) {
      body += `<div class="note">已從庫存預留這些貨（放在「預定專區」）。客戶取貨後按「確認取貨完成」才會真正出庫。</div>`;
    }
  } else if (t === TYPES.STOCKUP) {
    const items = parseJSON(r['品項JSON'], []);
    title = r['關聯單號'] ? `送貨到 ${esc(r['門市'])}` : `備貨 → ${esc(r['門市'])}`;
    body = `<dl class="kv">
        <dt>備貨日期</dt><dd><b>${esc(r['取貨日期'] || '—')}</b></dd>
        ${r['備註'] ? `<dt>備註</dt><dd>${esc(r['備註'])}</dd>` : ''}
      </dl>
      <div class="items">
        ${items.map(i => `<div class="it"><b>${esc(i.name)}${i.spec ? '　' + esc(i.spec) : ''}</b>
            <span class="src">${esc(srcLabel(i.src))} 出</span><span>× ${i.qty}</span></div>`).join('')}
      </div>`;
    if (r['關聯單號']) {
      body = `<div class="alert-box big">🚚 從總倉調度，請協助備貨
        <span>客人在 ${esc(r['門市'])} 取貨，但貨在總倉。請把下面的貨送到門市。</span></div>` + body;
    }
    if (r['庫存狀態'] === STOCK.FAILED) {
      body += `<div class="note bad">⚠ 這張備貨單的庫存還沒扣成功。請按下面的「重試扣庫存」。</div>`;
    } else if (r['關聯單號']) {
      if (!done) body += `<div class="note">這張單<b>不會動庫存</b>——貨已經在預訂單送出時預留好了。
        送到門市後按「已送達」就好，客人取貨請到那張預訂單按「確認取貨完成」。</div>`;
    } else if (!done && r['庫存狀態'] === STOCK.RESERVED) {
      body += `<div class="note">貨已經從來源移到「預定專區」等著送出。實際送到門市後按「備貨完成」，就會轉進 ${esc(r['門市'])} 的庫存（總數不變）。</div>`;
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
  if (!done && (t === TYPES.ORDER || t === TYPES.STOCKUP) && r['取貨日期']) {
    const d = r['取貨日期'], today = todayStr();
    const word = t === TYPES.ORDER ? '取貨' : '備貨';
    if (d < today) statusTag = `<span class="tag tag-alert">已過${word}日</span>`;
    else if (d === today) statusTag = `<span class="tag tag-routine">今天${word}</span>`;
  }

  // 修改紀錄（可收合）
  const chgLines = String(r['修改紀錄'] || '').split('\n').filter(Boolean);
  if (chgLines.length) {
    body += `<details class="chg"><summary>修改紀錄（${chgLines.length} 次）</summary>
      ${chgLines.map(x => `<div>${esc(x)}</div>`).join('')}</details>`;
  }

  const edit = `<button class="btn btn-sm" data-act="edit" data-id="${esc(r.id)}">✎ 修改</button>`;
  let actions = '';
  if (!done) {
    if (t === TYPES.STOCKUP) {
      actions = r['庫存狀態'] === STOCK.FAILED
        ? `<button class="btn btn-sm btn-primary" data-act="retry" data-id="${esc(r.id)}">重試扣庫存</button>
           ${edit}<button class="btn btn-sm btn-danger" data-act="cancel" data-id="${esc(r.id)}">取消備貨</button>`
        : `<button class="btn btn-sm btn-ok" data-act="transfer" data-id="${esc(r.id)}">✓ ${r['關聯單號'] ? '已送達門市' : '備貨完成'}</button>
           ${edit}<button class="btn btn-sm btn-danger" data-act="cancel" data-id="${esc(r.id)}">取消備貨</button>`;
    } else if (t === TYPES.ORDER) {
      if (r['庫存狀態'] === STOCK.FAILED) {
        actions = `<button class="btn btn-sm btn-primary" data-act="retry" data-id="${esc(r.id)}">重試扣庫存</button>
                   ${edit}
                   <button class="btn btn-sm btn-danger" data-act="cancel" data-id="${esc(r.id)}">取消此單</button>`;
      } else {
        actions = `<button class="btn btn-sm btn-ok" data-act="ship" data-id="${esc(r.id)}">✓ 確認取貨完成</button>
                   ${edit}
                   <button class="btn btn-sm btn-danger" data-act="cancel" data-id="${esc(r.id)}">取消預訂</button>`;
      }
    } else {
      actions = `<button class="btn btn-sm btn-ok" data-act="finish" data-id="${esc(r.id)}">✓ 已處理完成</button>${edit}`;
    }
  } else if (r['狀態'] === STATUS.CANCEL) {
    actions = `<button class="btn btn-sm btn-danger" data-act="del" data-id="${esc(r.id)}">🗑 刪除這筆紀錄</button>`;
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
        ${done && r['完成時間'] ? `　·　${esc(r['狀態'])}：${esc(r['完成者'])} ${esc(r['完成時間'])}` : ''}
        ${r['最後修改者'] ? `<br>✎ 最後修改：${esc(r['最後修改者'])}　${esc(r['最後修改時間'])}` : ''}</span>
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

  if (act === 'edit') { openForm(r.id); return; }

  if (act === 'ship') {
    const plan = parseJSON(r['庫存異動JSON'], []);
    const ok = await confirmModal({
      title: '確認客人已取貨？',
      lines: `<p>客戶：<b>${esc(r['客戶名稱'])}</b></p>
              <p style="color:var(--ink-2);font-size:14px">按下確定後會從庫存的「預定專區」扣掉，總數才會真正減少：</p>
              <pre class="pre">${esc(planText(plan, 'ship'))}</pre>`,
      okText: '確定，已取貨'
    });
    if (!ok) return;
    await doAction(b, async () => {
      await applyPlan(plan, 'ship');
      await updateBoardRow(r, { 狀態: STATUS.DONE, 完成時間: nowStr(), 完成者: userName(), 庫存狀態: STOCK.SHIPPED });
      let extra = '';
      if (window.createShopSaleFromOrder) {
        try { await window.createShopSaleFromOrder(r); extra = '，並開了一張來店銷售單'; }
        catch (err) { console.warn('自動建立來店銷售單失敗', err); extra = '（來店銷售單建立失敗，請手動補開）'; }
      }
      toast('已完成並扣除庫存' + extra, 'ok');
    });
  }

  if (act === 'cancel') {
    const plan = normPlan(parseJSON(r['庫存異動JSON'], []));
    const reserved = r['庫存狀態'] === STOCK.RESERVED;
    const isStock = r['類型'] === TYPES.STOCKUP;
    const backHome = [...new Set(plan.map(p => srcLabel(p.src)))].join('、') || '原來源';
    const res = await confirmModal({
      title: isStock ? '要取消這張備貨單嗎？' : '要取消這張預訂單嗎？',
      lines: `<p>${isStock ? '備貨去向：<b>' + esc(r['門市']) + '</b>' : '客戶：<b>' + esc(r['客戶名稱'] || '（無）') + '</b>'}</p>` +
        (reserved
          ? `<p style="color:var(--ink-2);font-size:14px">預定專區的貨要退回哪裡？（預設退回原來源：${esc(backHome)}）</p>`
          : `<p style="color:var(--ink-2);font-size:14px">這張單的庫存還沒扣，取消不會動到庫存。</p>`),
      choices: reserved ? {
        name: 'dest',
        options: [{ v: '', label: `原來源（${backHome}）` },
                  ...srcOptions().map(o => ({ v: o.col, label: o.label }))]
      } : null,
      preview: reserved ? dest => `<pre class="pre">${esc(planText(plan, 'restore', dest || null))}</pre>` : null,
      okText: '確定取消',
      danger: true
    });
    if (!res) return;
    await doAction(b, async () => {
      if (reserved) await applyPlan(plan, 'restore', res.dest || null);
      await updateBoardRow(r, {
        狀態: STATUS.CANCEL, 完成時間: nowStr(), 完成者: userName(), 庫存狀態: STOCK.RESTORED,
        修改紀錄: (r['修改紀錄'] ? r['修改紀錄'] + '\n' : '')
          + `${nowStr()} ${userName()}：取消${isStock ? '備貨' : '預訂'}，庫存退回 ${res.dest ? srcLabel(res.dest) : backHome}`
      });
      toast('已取消，庫存已退回 ' + (res.dest ? srcLabel(res.dest) : backHome), 'ok');
    });
  }

  // 備貨完成 → 把預定專區的貨轉進對應門市（總數不變）
  if (act === 'transfer') {
    const plan = normPlan(parseJSON(r['庫存異動JSON'], []));
    const dest = storeCol(r['門市']);
    const linked = !!r['關聯單號'];               // 跟著預訂單開的送貨提醒單：不動庫存
    const ok = await confirmModal({
      title: linked ? '貨已經送到門市了？' : '備貨已經送到門市了？',
      lines: linked
        ? `<p>去向：<b>${esc(r['門市'])}</b>　（配合預訂單 ${esc(r['關聯單號'])}）</p>
           <p style="color:var(--ink-2);font-size:14px">這張是送貨提醒單，<b>不會動到庫存</b>。
           貨還是留在「預定專區」，等客人來取貨時，請到那張預訂單按「確認取貨完成」。</p>`
        : `<p>去向：<b>${esc(r['門市'])}</b></p>
           <p style="color:var(--ink-2);font-size:14px">按下確定後，這些貨會從「預定專區」轉進 ${esc(r['門市'])} 的庫存。
           <b>總數不會變</b>，只是換了位置。</p>
           <pre class="pre">${esc(planText(plan, 'transfer', dest))}</pre>`,
      okText: linked ? '確定，已送達' : '確定，已入庫'
    });
    if (!ok) return;
    await doAction(b, async () => {
      if (!linked) await applyPlan(plan, 'transfer', dest);
      await updateBoardRow(r, {
        狀態: STATUS.DONE, 完成時間: nowStr(), 完成者: userName(),
        庫存狀態: linked ? STOCK.NA : STOCK.TRANSFERRED
      });
      toast(linked ? '已標記送達 ' + r['門市'] : '備貨完成，已轉入 ' + r['門市'], 'ok');
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
      await applyPlan(parseJSON(r['庫存異動JSON'], []), 'reserve');
      await updateBoardRow(r, { 庫存狀態: STOCK.RESERVED });
      toast('庫存已預留完成', 'ok');
    });
  }

  // 永久刪除（只開放給已取消的紀錄）
  if (act === 'del') {
    if (r['狀態'] !== STATUS.CANCEL) return alert('只有「已取消」的紀錄才能刪除。');
    const ok1 = await confirmModal({
      title: '永久刪除這筆紀錄？',
      lines: `<p>${esc(r['類型'])}　${esc(r['門市'])}</p>
              <p>客戶：<b>${esc(r['客戶名稱'] || '（無）')}</b>${r['金額'] ? '　' + money(r['金額']) : ''}</p>
              <p style="font-size:14px;color:var(--ink-2)">建立者 ${esc(r['建立者'])}　${esc(r['建立時間'])}</p>
              <div class="warn-box">這會把試算表「留言板」裡的這一列整列刪掉，<b>無法復原</b>。<br>
              庫存已經在取消時還原過了，刪除不會再動到庫存。</div>`,
      okText: '我確定，刪除',
      danger: true
    });
    if (!ok1) return;
    const ok2 = await confirmModal({
      title: '最後確認',
      lines: `<p>真的要刪除「<b>${esc(r['客戶名稱'] || r['類型'])}</b>」這筆已取消的紀錄嗎？</p>
              <p style="font-size:14px;color:var(--ink-2)">刪掉後就查不到了。若只是想留著看，按「取消」即可。</p>`,
      okText: '永久刪除',
      danger: true
    });
    if (!ok2) return;
    await doAction(b, async () => {
      await deleteBoardRow(r);
      toast('已刪除這筆紀錄', 'ok');
    });
  }
});

/** 整列刪除留言板的某一筆（刪除前先確認位置沒被別人動過） */
async function deleteBoardRow(r) {
  const check = await readRange(S.boardTitle, `A${r._row}`);
  if (String((check[0] || [])[0] || '') !== r.id) {
    throw new Error('這筆紀錄在試算表的位置已經變動（可能有人同時在操作）。\n請按右上角「↻ 更新」後再試一次。');
  }
  await api(`${CONFIG.SPREADSHEET_ID}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: { sheetId: S.boardSheetId, dimension: 'ROWS', startIndex: r._row - 1, endIndex: r._row }
        }
      }]
    })
  });
}

/**
 * 通用確認視窗。
 * 取消 → 回傳 null；確定 → 回傳物件（有 choices 時帶著選中的值，例如 { dest: '三重店' }）
 */
function confirmModal({ title, lines, okText, danger, choices, preview }) {
  return new Promise(res => {
    const host = document.createElement('div');
    const chipsHTML = choices ? `<div class="field" style="margin-bottom:10px">
        <div class="chips" id="cmChips">
          ${choices.options.map((o, i) => `<button class="chip ${i === 0 ? 'on' : ''}" data-v="${esc(o.v)}">${esc(o.label)}</button>`).join('')}
        </div>
      </div>` : '';
    host.innerHTML = `<div class="modal">
      <div class="sheet" style="max-width:460px">
        <div class="sheet-head"><h2>${esc(title)}</h2></div>
        <div class="sheet-body">${lines}${chipsHTML}<div id="cmPreview"></div></div>
        <div class="sheet-foot">
          <button class="btn" data-no>取消</button>
          <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-yes>${esc(okText || '確定')}</button>
        </div>
      </div></div>`;
    document.body.appendChild(host);

    let picked = choices ? choices.options[0].v : undefined;
    const drawPreview = () => {
      const el = host.querySelector('#cmPreview');
      if (preview && el) el.innerHTML = preview(picked);
    };
    if (choices) {
      host.querySelectorAll('#cmChips .chip').forEach(c => c.onclick = () => {
        picked = c.dataset.v;
        host.querySelectorAll('#cmChips .chip').forEach(x => x.classList.toggle('on', x === c));
        drawPreview();
      });
    }
    drawPreview();

    const done = v => { host.remove(); res(v); };
    host.querySelector('[data-no]').onclick = () => done(null);
    host.querySelector('[data-yes]').onclick = () => done(choices ? { [choices.name]: picked } : {});
    host.querySelector('.modal').onclick = ev => { if (ev.target.classList.contains('modal')) done(null); };
  });
}

function userName() { return (S.user && (S.user.name || S.user.email)) || '未知'; }

async function doAction(btn, fn) {
  S.busy = true; btn.disabled = true; const old = btn.textContent; btn.textContent = '處理中…';
  try { await fn(); await refreshAll(); }
  catch (err) { alert('操作失敗：\n\n' + err.message); }
  finally { S.busy = false; btn.disabled = false; btn.textContent = old; }
}

/** 更新留言板某一列的部分欄位 */
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

function openForm(editId) {
  const r = editId ? S.board.find(x => x.id === editId) : null;

  if (r) {
    FORM = {
      editId: r.id,
      type: r['類型'],
      store: r['門市'] || CONFIG.STORES[0].label,
      source: r['客戶來源'] || CONFIG.SOURCES[0],
      slot: r['取貨時段'] || CONFIG.SLOTS[0],
      cName: r['客戶名稱'] || '',
      date: r['取貨日期'] || todayStr(),
      note: r['備註'] || '',
      taskText: r['類型'] === TYPES.TASK ? (r['備註'] || '') : '',
      routines: String(r['例行工作項目'] || '').split('\n').filter(Boolean),
      items: parseJSON(r['品項JSON'], []).map(i => {
        const hit = findProduct(i);
        return { name: hit ? hit.name : (i.name || ''), spec: hit ? hit.spec : (i.spec || ''),
                 row: hit ? hit.sheetRow : i.row,
                 qty: i.qty, price: i.price || 0, src: i.src || i.storeCol || DEFAULT_SRC(),
                 cat: hit ? hit.cat : null, missing: !hit };
      })
    };
    const lost = FORM.items.filter(x => x.missing);
    if (lost.length) {
      FORM = null;
      return alert('這筆留言有品項在庫存表找不到，為了避免庫存算錯，先不開放修改：\n\n'
        + lost.map(x => `・${x.name} ${x.spec}`).join('\n')
        + '\n\n可能是產品被改名或刪除了。請先確認庫存表，或取消這張單重開一張。');
    }
    if (!FORM.items.length) FORM.items = [newItem()];
    FORM.groups = groupsFromItems(FORM.items);
  } else {
    FORM = {
      editId: null, type: TYPES.ORDER, store: CONFIG.STORES[0].label,
      source: CONFIG.SOURCES[0], slot: CONFIG.SLOTS[0], routines: [],
      items: [newItem()], groups: [newGroup()]
    };
  }

  const host = $('modalHost');
  host.innerHTML = `<div class="modal" id="modal">
    <div class="sheet">
      <div class="sheet-head">
        <h2>${r ? '修改' + esc(FORM.type) : '新增留言'}</h2>
        <button class="btn btn-ghost" id="closeForm">✕</button>
      </div>
      <div class="sheet-body">
        ${r ? `<div class="edit-hint">正在修改 ${esc(r['建立者'])} 於 ${esc(r['建立時間'])} 建立的這筆留言。<br>
                 送出後會記錄「${esc(userName())}」修改了哪些欄位。留言類型不能更改。</div>`
            : `<div class="field">
                 <label>留言類型</label>
                 <div class="chips" id="typeChips">
                   ${Object.values(TYPES).map(t => `<button class="chip ${t === TYPES.ORDER ? 'on' : ''}" data-type="${t}">${t}</button>`).join('')}
                 </div>
               </div>`}
        <div class="field">
          <label>對應門市 <span class="req">*</span></label>
          <div class="chips" id="storeChips">
            ${CONFIG.STORES.map(s => `<button class="chip ${s.label === FORM.store ? 'on' : ''}" data-store="${s.label}">${s.label}</button>`).join('')}
          </div>
        </div>
        <div id="formBody"></div>
      </div>
      <div class="sheet-foot">
        <button class="btn" id="cancelForm">取消</button>
        <button class="btn btn-primary" id="submitForm">${r ? '儲存修改' : '送出留言'}</button>
      </div>
    </div></div>`;

  $('closeForm').onclick = $('cancelForm').onclick = closeForm;
  $('submitForm').onclick = submitForm;
  if ($('typeChips')) {
    host.querySelectorAll('#typeChips .chip').forEach(c => c.onclick = () => {
      FORM.type = c.dataset.type;
      host.querySelectorAll('#typeChips .chip').forEach(x => x.classList.toggle('on', x === c));
      renderFormBody();
    });
  }
  host.querySelectorAll('#storeChips .chip').forEach(c => c.onclick = () => {
    FORM.store = c.dataset.store;
    host.querySelectorAll('#storeChips .chip').forEach(x => x.classList.toggle('on', x === c));
    if (FORM.type === TYPES.ORDER) renderFormBody();
  });
  renderFormBody();
}
function closeForm() { $('modalHost').innerHTML = ''; FORM = null; }
/** 備貨用：一個群組 = 一支產品 + 一個出貨來源 + 各規格的數量 */
function newGroup() {
  return { cat: S.lastCat || null, name: '', src: S.lastSrc || DEFAULT_SRC(), qty: {} };
}

function newItem() {
  // 分類與出貨來源都沿用上一次選的，同事連續選同一類時不用重選
  return { name: '', row: null, qty: 1, price: 0, src: S.lastSrc || DEFAULT_SRC(), cat: S.lastCat || null };
}

function renderFormBody() {
  const b = $('formBody');

  if (FORM.type === TYPES.STOCKUP) {
    b.innerHTML = `
      <div class="field"><label>備貨日期 <span class="req">*</span></label>
        <input type="date" id="fDate" value="${FORM.date || todayStr()}"></div>
      <div class="field"><label>備貨品項 <span class="req">*</span></label>
        <div id="groupRows"></div>
        <button class="btn add-item" id="addGroup">＋ 增加另一個產品</button>
        <div class="total-bar"><span>合計</span><span id="gTotal">0 項 · 0 件</span></div>
      </div>
      <div class="field"><label>備註</label>
        <textarea id="fNote" placeholder="例如：週三送貨車一起帶過去">${esc(FORM.note || '')}</textarea></div>`;
    FORM.date = FORM.date || todayStr();
    $('fDate').oninput = e => FORM.date = e.target.value;
    $('fNote').oninput = e => FORM.note = e.target.value;
    $('addGroup').onclick = () => { FORM.groups.push(newGroup()); renderGroups(); };
    renderGroups();
    return;
  }

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

/** 把品項清單還原成備貨用的群組（同一支產品 + 同一個來源歸成一組） */
function groupsFromItems(items) {
  const map = new Map(), out = [];
  for (const it of items) {
    const p = findProduct(it);
    if (!p) continue;
    const src = it.src || DEFAULT_SRC();
    const k = p.name + '|' + src;
    if (!map.has(k)) {
      const g = { cat: p.cat, name: p.name, src, qty: {} };
      map.set(k, g); out.push(g);
    }
    map.get(k).qty[p.sheetRow] = (map.get(k).qty[p.sheetRow] || 0) + it.qty;
  }
  return out.length ? out : [newGroup()];
}

/** 把備貨群組展開成品項清單 */
function itemsFromGroups(groups) {
  const items = [];
  for (const g of (groups || [])) {
    for (const row of Object.keys(g.qty)) {
      const n = Number(g.qty[row]) || 0;
      if (n > 0) items.push({ row: +row, qty: n, price: 0, src: g.src || DEFAULT_SRC() });
    }
  }
  return items;
}

function groupTotals(groups) {
  const items = itemsFromGroups(groups);
  return { kinds: items.length, pieces: items.reduce((s, i) => s + i.qty, 0) };
}

function updateGroupTotal() {
  const el = $('gTotal');
  if (!el) return;
  const t = groupTotals(FORM.groups);
  el.textContent = `${t.kinds} 項 · ${t.pieces} 件`;
}

/** 備貨的品項輸入：分類 → 產品名稱 → 一次填多個規格的數量 → 選出貨來源 */
function renderGroups() {
  const host = $('groupRows');
  const P = S.products;

  host.innerHTML = FORM.groups.map((g, i) => {
    const cat = g.cat || S.lastCat || (P.cats[0] || ALL_CAT);
    const names = (!P.hasCats || cat === ALL_CAT) ? P.names : (P.byCat.get(cat) || []);
    const variants = g.name ? (P.byName.get(g.name) || []) : [];
    const src = g.src || DEFAULT_SRC();

    const tabs = P.hasCats ? `<div class="cat-tabs">
        ${P.cats.map(c => `<button class="cat-tab${c === cat ? ' on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
        <button class="cat-tab${cat === ALL_CAT ? ' on' : ''}" data-cat="${ALL_CAT}">全部</button>
      </div>` : '';

    const specs = variants.length ? `
      <div class="spec-list">
        <div class="spec-head"><span>規格</span><span class="sq">${esc(srcLabel(src))}現有</span><span class="qt">數量</span></div>
        ${variants.map(v => {
          const have = v.nums[src] || 0;
          const q = g.qty[v.sheetRow] || '';
          return `<div class="spec-row${q ? ' has' : ''}" data-row="${v.sheetRow}">
            <span class="nm">${esc(v.spec || '（無規格）')}</span>
            <span class="sq${have <= 0 ? ' zero' : ''}">${have}</span>
            <input type="number" class="gq" min="0" step="1" placeholder="0" value="${q}" data-row="${v.sheetRow}">
          </div>`;
        }).join('')}
      </div>` : (g.name ? '' : `<div class="spec-empty">選好產品名稱後，這裡會列出所有規格，直接填數量即可</div>`);

    return `<div class="group-box" data-i="${i}">
      <div class="group-top">
        <span class="group-n">產品 ${i + 1}</span>
        ${FORM.groups.length > 1 ? `<button class="del" title="刪除這個產品">✕</button>` : ''}
      </div>
      ${tabs}
      <div class="f"><label>產品名稱</label>
        <select class="gName">
          <option value="">— 請選擇（${names.length} 項）—</option>
          ${names.map(n => `<option value="${esc(n)}"${n === g.name ? ' selected' : ''}>${esc(n)}</option>`).join('')}
        </select>
      </div>
      ${specs}
      <div class="f" style="margin-top:10px"><label>這批從哪裡出貨</label>
        <select class="gSrc">
          ${srcOptions().map(o => `<option value="${esc(o.col)}"${src === o.col ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
      </div>
    </div>`;
  }).join('');

  host.querySelectorAll('.group-box').forEach(box => {
    const i = +box.dataset.i, g = FORM.groups[i];

    box.querySelectorAll('.cat-tab').forEach(t => t.onclick = () => {
      g.cat = t.dataset.cat;
      S.lastCat = g.cat;
      const names = g.cat === ALL_CAT ? S.products.names : (S.products.byCat.get(g.cat) || []);
      if (g.name && !names.includes(g.name)) { g.name = ''; g.qty = {}; }
      renderGroups();
    });

    box.querySelector('.gName').onchange = e => {
      g.name = e.target.value;
      g.qty = {};                               // 換產品就清掉原本填的數量
      const p = (S.products.byName.get(g.name) || [])[0];
      if (p) g.cat = p.cat;
      renderGroups(); updateGroupTotal();
    };

    box.querySelector('.gSrc').onchange = e => {
      g.src = e.target.value;
      S.lastSrc = g.src;
      renderGroups();
    };

    box.querySelectorAll('.gq').forEach(inp => {
      inp.oninput = e => {
        const n = Math.max(0, +e.target.value || 0);
        if (n) g.qty[e.target.dataset.row] = n; else delete g.qty[e.target.dataset.row];
        e.target.closest('.spec-row').classList.toggle('has', !!n);
        updateGroupTotal();
      };
    });

    const del = box.querySelector('.del');
    if (del) del.onclick = () => { FORM.groups.splice(i, 1); renderGroups(); updateGroupTotal(); };
  });
  updateGroupTotal();
}

function stockBrief(p) {
  const parts = srcOptions().map(o => `${o.label} ${p.nums[o.col] || 0}`);
  return `（${parts.join(' / ')}）`;
}

function renderItems() {
  const host = $('itemRows');
  const P = S.products;
  const isStock = FORM.type === TYPES.STOCKUP;

  host.innerHTML = FORM.items.map((it, i) => {
    const p = it.row ? P.byRow.get(it.row) : null;
    // 這一列目前在哪個分類分頁
    const cat = it.cat || (p ? p.cat : null) || S.lastCat || (P.cats[0] || ALL_CAT);
    const names = (!P.hasCats || cat === ALL_CAT) ? P.names : (P.byCat.get(cat) || []);
    const variants = it.name ? (P.byName.get(it.name) || []) : [];
    const srcQty = p ? (p.nums[it.src || DEFAULT_SRC()] || 0) : 0;

    const tabs = P.hasCats ? `<div class="cat-tabs">
        ${P.cats.map(c => `<button class="cat-tab${c === cat ? ' on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
        <button class="cat-tab${cat === ALL_CAT ? ' on' : ''}" data-cat="${ALL_CAT}">全部</button>
      </div>` : '';

    return `<div class="item-row" data-i="${i}">
      ${tabs}
      <div class="two">
        <div class="f"><label>${P.hasCats ? '②' : '①'} 產品名稱</label>
          <select class="itemName">
            <option value="">— 請選擇（${names.length} 項）—</option>
            ${names.map(n => `<option value="${esc(n)}"${n === it.name ? ' selected' : ''}>${esc(n)}</option>`).join('')}
          </select>
        </div>
        <div class="f"><label>${P.hasCats ? '③' : '②'} 產品規格</label>
          <select class="itemSpec"${it.name ? '' : ' disabled'}>
            <option value="">${it.name ? `— 請選擇規格（${variants.length} 種）—` : '請先選產品名稱'}</option>
            ${variants.map(v => `<option value="${v.sheetRow}"${v.sheetRow === it.row ? ' selected' : ''}>${esc(v.spec || '（無規格）')}${esc(stockBrief(v))}</option>`).join('')}
          </select>
        </div>
        <div class="f"><label>${P.hasCats ? '④' : '③'} 從哪裡出貨</label>
          <select class="itemSrc">
            ${srcOptions().map(o => `<option value="${esc(o.col)}"${(it.src || DEFAULT_SRC()) === o.col ? ' selected' : ''}>${esc(o.label)}${p ? `（現有 ${p.nums[o.col] || 0}）` : ''}</option>`).join('')}
          </select>
        </div>
      </div>
      ${p ? `<div class="stockline${it.qty > srcQty ? ' short' : ''}">
          ${esc(srcLabel(it.src || DEFAULT_SRC()))}現有 <b>${srcQty}</b>${it.qty > srcQty ? `　⚠ 不足 ${it.qty - srcQty}，送出後會變負數` : ''}
          ${isStock ? '' : `　·　售價 ${money(p.price)}`}</div>` : ''}
      ${(!isStock && p && (it.src || DEFAULT_SRC()) === CONFIG.H.warehouse)
        ? `<div class="warehouse-alert">🚚 從總倉調度，請協助備貨<span>送出後會自動幫你開一張備貨單，提醒把貨送到 ${esc(FORM.store)}</span></div>` : ''}
      <div class="r2">
        <div class="f"><label>數量</label><input type="number" class="itemQty" min="1" step="1" value="${it.qty}"></div>
        ${isStock ? '' : `
        <div class="f"><label>銷售價格（單價）</label><input type="number" class="itemPrice" min="0" step="1" value="${it.price}"></div>
        <div class="f" style="max-width:110px"><label>小計</label>
          <input type="text" value="${money(it.qty * it.price)}" readonly style="background:#f1f5f9"></div>`}
        ${FORM.items.length > 1 ? `<button class="del" title="刪除這個品項">✕</button>` : ''}
      </div>
    </div>`;
  }).join('');

  host.querySelectorAll('.item-row').forEach(row => {
    const i = +row.dataset.i, it = FORM.items[i];

    row.querySelectorAll('.cat-tab').forEach(t => t.onclick = () => {
      it.cat = t.dataset.cat;
      S.lastCat = it.cat;                      // 下一個品項預設同一個分類
      if (it.name) {                            // 換分類後，原本選的品名若不在這一類就清掉
        const names = it.cat === ALL_CAT ? S.products.names : (S.products.byCat.get(it.cat) || []);
        if (!names.includes(it.name)) { it.name = ''; it.row = null; }
      }
      renderItems();
    });

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
      if (p) { it.price = p.price; it.cat = p.cat; }
      renderItems(); updateTotal();
    };
    row.querySelector('.itemSrc').onchange = e => {
      it.src = e.target.value;
      S.lastSrc = it.src;                       // 下一個品項預設同一個出貨來源
      renderItems();
    };
    row.querySelector('.itemQty').oninput = e => {
      it.qty = Math.max(1, +e.target.value || 1);
      updateTotal(); syncSub(row, it);
    };
    const pr = row.querySelector('.itemPrice');
    if (pr) pr.oninput = e => { it.price = Math.max(0, +e.target.value || 0); updateTotal(); syncSub(row, it); };
    const del = row.querySelector('.del');
    if (del) del.onclick = () => { FORM.items.splice(i, 1); renderItems(); updateTotal(); };
  });
  updateTotal();
}

function syncSub(row, it) {
  const el = row.querySelector('.r2 .f:nth-child(3) input');
  if (el) el.value = money(it.qty * it.price);
}
function formTotal() { return FORM.items.reduce((s, i) => s + (i.qty * i.price), 0); }
function updateTotal() { const el = $('fTotal'); if (el) el.textContent = money(formTotal()); }

async function submitForm() {
  const btn = $('submitForm');
  const t = FORM.type;
  const editing = !!FORM.editId;
  const r = editing ? S.board.find(x => x.id === FORM.editId) : null;
  if (editing && !r) return alert('找不到這筆留言，請按右上角「↻ 更新」後再試。');

  /* ── 先把這次填的內容整理成「要寫進試算表的欄位」 ── */
  const f = {};
  let plan = null;

  if (t === TYPES.TASK) {
    if (!(FORM.taskText || '').trim()) return alert('請填寫交接內容');
    f['備註'] = FORM.taskText.trim();
  } else if (t === TYPES.ROUTINE) {
    if (!FORM.routines.length) return alert('請至少勾選一項例行工作');
    f['例行工作項目'] = FORM.routines.join('\n');
    f['備註'] = (FORM.note || '').trim();
  } else if (t === TYPES.STOCKUP) {
    if (!FORM.date) return alert('請選擇備貨日期');
    const items = itemsFromGroups(FORM.groups);
    if (!items.length) return alert('請填寫備貨數量：選好產品名稱後，在要備的規格後面填數字');
    plan = planReserve(items);
    f['取貨日期'] = FORM.date;
    f['備註'] = (FORM.note || '').trim();
    f['品項明細'] = plan.map(p => `${p.name} ${p.spec} ×${p.qty}（${srcLabel(p.src)}出）`).join('\n');
    f['品項JSON'] = JSON.stringify(plan.map(p =>
      ({ row: p.row, name: p.name, spec: p.spec, qty: p.qty, price: 0, src: p.src })));
    f['庫存異動JSON'] = JSON.stringify(plan.map(p =>
      ({ row: p.row, name: p.name, spec: p.spec, qty: p.qty, src: p.src })));
  } else {
    if (!(FORM.cName || '').trim()) return alert('請填寫客戶名稱');
    if (!FORM.date) return alert('請選擇預計取貨日期');
    const items = FORM.items.filter(i => i.row).map(i => ({ row: i.row, qty: i.qty, price: i.price, src: i.src || DEFAULT_SRC() }));
    if (!items.length) return alert('請選擇預訂品項：先選「產品名稱」，再選「產品規格」');

    plan = planReserve(items);
    f['客戶名稱'] = FORM.cName.trim();
    f['客戶來源'] = FORM.source;
    f['取貨日期'] = FORM.date;
    f['取貨時段'] = FORM.slot;
    f['金額'] = formTotal();
    f['備註'] = (FORM.note || '').trim();
    f['品項明細'] = plan.map(p => `${p.name} ${p.spec} ×${p.qty}（${srcLabel(p.src)}出）`).join('\n');
    f['品項JSON'] = JSON.stringify(plan.map(p =>
      ({ row: p.row, name: p.name, spec: p.spec, qty: p.qty, price: p.price, src: p.src })));
    f['庫存異動JSON'] = JSON.stringify(plan.map(p =>
      ({ row: p.row, name: p.name, spec: p.spec, qty: p.qty, src: p.src })));
  }
  f['門市'] = FORM.store;

  const shorts = plan ? plan.filter(p => p.short > 0) : [];
  const shortHTML = shorts.length
    ? `<div class="warn-box">⚠ 以下品項在你選的出貨來源不足，送出後庫存會變成負數：<br>
       ${shorts.map(p => `・${esc(p.name)} ${esc(p.spec)}　${esc(srcLabel(p.src))}缺 ${p.short}`).join('<br>')}<br>
       可以改從別的門市或總倉出貨，或先確認能不能調到貨。</div>`
    : '';

  /* ══════════════ 新增 ══════════════ */
  if (!editing) {
    let wantStockup = null;              // 要不要順便開一張「從總倉調度」的備貨單
    if (plan) {
      const isStock = t === TYPES.STOCKUP;
      const fromWh = isStock ? [] : plan.filter(p => p.src === CONFIG.H.warehouse);
      const whHTML = fromWh.length ? `<div class="alert-box">🚚 <b>從總倉調度，請協助備貨</b><br>
        以下品項在總倉，不在 ${esc(FORM.store)}，客人取貨前要有人先把貨送過去：<br>
        ${fromWh.map(p => `・${esc(p.name)} ${esc(p.spec)} ×${p.qty}`).join('<br>')}</div>` : '';

      const res = await confirmModal({
        title: isStock ? '確認這張備貨單' : '確認這張預訂單',
        lines: `${whHTML}
                <p style="color:var(--ink-2);font-size:14px">送出後庫存會這樣動（總數不變，貨先移到「預定專區」）：</p>
                <pre class="pre">${esc(planText(plan, 'reserve'))}</pre>
                <p style="color:var(--ink-2);font-size:14px">${isStock
                  ? '等貨實際送到 <b>' + esc(FORM.store) + '</b> 後，按「備貨完成」就會轉進該門市的庫存。'
                  : '客人取貨按「確認取貨完成」時，總數才會真正減少。'}</p>${shortHTML}`,
        choices: fromWh.length ? {
          name: 'mkStock',
          options: [{ v: '1', label: '同時開一張備貨單（建議）' },
                    { v: '', label: '不用，我自己去總倉拿' }]
        } : null,
        okText: '確定送出'
      });
      if (!res) return;
      wantStockup = fromWh.length && res.mkStock === '1' ? fromWh : null;
    }
    const id = 'M' + Date.now().toString(36).toUpperCase();
    const values = new Array(BOARD_HEADERS.length).fill('');
    values[C['id']] = id;
    values[C['類型']] = t;
    values[C['建立時間']] = nowStr();
    values[C['建立者']] = userName();
    values[C['狀態']] = STATUS.OPEN;
    values[C['庫存狀態']] = plan ? STOCK.FAILED : STOCK.NA;   // 先記未扣，扣成功後改「已預留」
    Object.keys(f).forEach(k => { if (C[k] !== undefined) values[C[k]] = f[k]; });

    S.busy = true; btn.disabled = true; btn.textContent = '送出中…';
    try {
      await appendRow(S.boardTitle, values);
      if (plan) {
        try {
          await applyPlan(plan, 'reserve');
          await loadBoard();
          const nr = S.board.find(x => x.id === id);
          if (nr) await updateBoardRow(nr, { 庫存狀態: STOCK.RESERVED });
        } catch (err) {
          alert('留言已送出，但庫存預留失敗：\n' + err.message + '\n\n請在卡片上按「重試扣庫存」。');
        }
      }
      if (wantStockup) {
        try { await createCompanionStockup(id, wantStockup); }
        catch (err) { alert('預訂單已送出，但自動開立備貨單失敗：\n' + err.message + '\n\n請手動開一張備貨單。'); }
      }
      closeForm();
      await refreshAll(wantStockup ? '已送出，並開了一張備貨單' : '留言已送出');
    } catch (err) {
      alert('送出失敗：\n\n' + err.message);
    } finally {
      S.busy = false;
      if ($('submitForm')) { btn.disabled = false; btn.textContent = '送出留言'; }
    }
    return;
  }

  /* ══════════════ 修改 ══════════════ */
  const LABEL = {
    客戶名稱: '客戶名稱', 客戶來源: '客戶來源',
    取貨日期: (t === TYPES.STOCKUP ? '備貨日期' : '取貨日期'), 取貨時段: '取貨時段', 金額: '金額',
    備註: (t === TYPES.TASK ? '交接內容' : '備註'),
    品項明細: '品項', 例行工作項目: '例行工作', 門市: (t === TYPES.STOCKUP ? '備貨去向門市' : '對應門市')
  };
  const oneLine = s => String(s).replace(/\n/g, ' ／ ');
  const changes = [], patch = {};
  for (const k of Object.keys(f)) {
    const ov = String(r[k] ?? ''), nv = String(f[k] ?? '');
    if (ov === nv) continue;
    patch[k] = f[k];
    if (LABEL[k]) changes.push(`${LABEL[k]}：${oneLine(ov) || '（空白）'} → ${oneLine(nv) || '（空白）'}`);
  }
  const itemsChanged = patch['品項明細'] !== undefined || patch['門市'] !== undefined;
  if (plan && itemsChanged) {
    patch['品項JSON'] = f['品項JSON'];
    patch['庫存異動JSON'] = f['庫存異動JSON'];
  }
  if (!changes.length) { closeForm(); return toast('沒有任何變更'); }

  let oldPlan = parseJSON(r['庫存異動JSON'], []);
  // 有些舊單的「庫存異動JSON」是空的，但庫存狀態寫著已預留——貨其實有扣。
  // 這種情況要拿「品項JSON」當作已經扣掉的量，否則系統會以為什麼都沒扣，
  // 把原本就在單子上的品項再扣一次（＝重複扣庫存）。
  if (!oldPlan.length && r['庫存狀態'] === STOCK.RESERVED) {
    oldPlan = parseJSON(r['品項JSON'], []);
  }
  // 貨還在「預定專區」等著的單才需要動庫存；已出庫、已還原、不適用的都不動。
  const holding = r['庫存狀態'] !== STOCK.SHIPPED
                && r['庫存狀態'] !== STOCK.RESTORED
                && r['庫存狀態'] !== STOCK.NA;
  const rework = !!(plan && itemsChanged && holding);
  const delta = rework ? planDelta(oldPlan, plan) : { more: [], less: [] };
  const hasDelta = !!(delta.more.length || delta.less.length);

  const ok = await confirmModal({
    title: '確認修改內容',
    lines: `<p style="font-size:14px;color:var(--ink-2)">這些變更會存進留言板，並記下是「${esc(userName())}」改的：</p>
      <pre class="pre">${esc(changes.join('\n'))}</pre>
      ${rework ? `<p style="font-size:14px;color:var(--ink-2)">庫存<b>只會動有變的部分</b>，沒改到的品項完全不會被碰到：</p>
        <pre class="pre">${esc(deltaText(delta))}</pre>${hasDelta ? shortHTML : ''}` : ''}`,
    okText: '確定儲存'
  });
  if (!ok) return;

  S.busy = true; btn.disabled = true; btn.textContent = '儲存中…';
  try {
    if (rework) {
      await applyDelta(delta);
      if (r['庫存狀態'] !== STOCK.RESERVED) patch['庫存狀態'] = STOCK.RESERVED;
    }
    patch['最後修改時間'] = nowStr();
    patch['最後修改者'] = userName();
    patch['修改紀錄'] = (r['修改紀錄'] ? r['修改紀錄'] + '\n' : '')
      + `${nowStr()} ${userName()}：${changes.join('；')}`;
    await updateBoardRow(r, patch);
    closeForm();
    await refreshAll('已儲存修改');
  } catch (err) {
    alert('儲存失敗：\n\n' + err.message);
  } finally {
    S.busy = false;
    if ($('submitForm')) { btn.disabled = false; btn.textContent = '儲存修改'; }
  }
}

/**
 * 預訂單有品項從總倉出貨時，自動開一張「跟單備貨單」提醒把貨送到門市。
 * 這張單【不動庫存】——貨已經在預訂單送出時移到預定專區了，再扣一次會重複。
 */
async function createCompanionStockup(orderId, whItems) {
  const values = new Array(BOARD_HEADERS.length).fill('');
  const id = 'S' + Date.now().toString(36).toUpperCase();
  values[C['id']] = id;
  values[C['類型']] = TYPES.STOCKUP;
  values[C['建立時間']] = nowStr();
  values[C['建立者']] = userName();
  values[C['門市']] = FORM.store;
  values[C['狀態']] = STATUS.OPEN;
  values[C['取貨日期']] = FORM.date || todayStr();
  values[C['品項明細']] = whItems.map(p => `${p.name} ${p.spec} ×${p.qty}（總倉出）`).join('\n');
  values[C['品項JSON']] = JSON.stringify(whItems.map(p =>
    ({ row: p.row, name: p.name, spec: p.spec, qty: p.qty, price: 0, src: p.src })));
  values[C['庫存異動JSON']] = '[]';            // 空的 → 完成或取消時都不會動庫存
  values[C['庫存狀態']] = STOCK.NA;
  values[C['關聯單號']] = orderId;
  values[C['備註']] = `配合預訂單「${(FORM.cName || '').trim()}」（${orderId}）從總倉調度到 ${FORM.store}。`
    + `貨已由預訂單預留在「預定專區」，這張單只是提醒送貨，不會再動庫存。`;
  await appendRow(S.boardTitle, values);
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

  // 顯示版本，並檢查 index.html 與 app.js 是不是同一版
  const verEl = $('appVer');
  if (verEl) {
    verEl.textContent = 'v' + APP_VERSION;
    verEl.title = `版本 ${APP_VERSION}（${APP_DATE}）`;
  }
  const htmlVer = (document.querySelector('meta[name="app-version"]') || {}).content;
  if (htmlVer && htmlVer !== APP_VERSION) {
    setTimeout(() => {
      if (verEl) { verEl.textContent = 'v' + APP_VERSION + ' ⚠'; verEl.classList.add('bad'); }
      toast(`檔案版本不一致：index.html 是 v${htmlVer}、app.js 是 v${APP_VERSION}。請確認兩個檔案都有上傳，並重新整理。`, 'bad');
    }, 800);
  }

  // 等 Google 登入程式庫載入
  let tries = 0;
  const wait = setInterval(() => {
    if (window.google && google.accounts && google.accounts.oauth2) { clearInterval(wait); initAuth(); }
    else if (++tries > 60) { clearInterval(wait); gateError('無法載入 Google 登入程式庫，請檢查網路後重新整理。'); }
  }, 100);
});
