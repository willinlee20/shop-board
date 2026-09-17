/* =========================================================================
   西門龍門儀錶板 ── 銷售紀錄模組 sales.js
   相依：app.js（S / CONFIG / api / applyPlan / confirmModal / toast …）
   ========================================================================= */

/* ----------------------------- 設定 ------------------------------------ */
const SALES = {
  // 銷售單分頁（沒有就自動建立）
  SHEET: {
    shop:   'ShopSales店頭銷售',
    online: 'Online網路',
    mini:   'miniSales小賣銷售',
    dist:   'Distributors經銷銷售'
  },
  LABEL: { shop: '來店', online: '網路', mini: '小賣', dist: '經銷' },

  // 名單分頁：先用分頁名稱找，找不到再用「標題列有什麼欄位」認（改名也不會壞）
  LIST_SHEET: { staff: 'Sales業務同仁名單', mini: '', dist: '' },
  LIST_SIG: { staff: '負責業務', mini: '小賣名稱', dist: '經銷商名稱' },

  // 網路單：前台只選收款方式，系統自己推結帳狀態
  COLLECT: ['已收貨款', '貨到付款'],
  COLLECT_PAID: '已收貨款',              // 選這個 → 結帳狀態直接帶「已結帳」
  VOID: '已作廢',
  // 網路單：這兩種情況不扣總倉庫存（貨不是從我們倉庫出的）
  NOSTOCK: [
    { key: 'agent', label: '本訂單廠商代出（不扣總倉庫存）', tag: '廠商代出' },
    { key: 'order', label: '非常備商品，待調貨後出貨（不扣總倉庫存）', tag: '待調貨' }
  ],

  SHIP:   ['未寄出', '已寄出'],
  PICK:   ['未取件', '已取件', '已送達', '未送達', '即將退貨', '退貨路上', '包裹異常'],
  PAY:    ['未結帳', '已結帳'],
  DONE_PICK: ['已取件', '已送達'],          // 這兩種都算貨態完成
  RETURN_PICK: ['即將退貨', '退貨路上', '包裹異常'],   // 這幾種可以按「退貨入庫」
  RETURNED: '已退貨入庫',
  SEND_WAY:      ['7-11', '全家'],
  DIST_SEND_WAY: ['7-11店到店', '全家店到店', '宅配'],
  HOME_DELIVERY: '宅配',
  PICKUP: ['三重店取', '西門店取', '寄送'],
  PICK_STORE: { '三重店取': '三重龍門', '西門店取': '西門' },
  NA: 'N/A'
};

const SH_HEAD = {
  shop: ['id', '訂單日期', '建立時間', '建立者', '門市', '負責業務', '品項明細', '金額', '成本',
         '備註', '品項JSON', '庫存異動JSON', '庫存狀態', '關聯單號', '狀態',
         '最後修改時間', '最後修改者', '修改紀錄'],
  online: ['id', '訂單日期', '建立時間', '建立者', '客戶名稱', '電話', '訂單內容', '價格', '運費', '成本',
           '收款方式', '寄送方式', '店名',
           '寄件狀態', '取貨狀態', '寄件代碼', '結帳狀態', '結帳日', '負責業務', '備註',
           '品項JSON', '庫存異動JSON', '結帳確認者', '封存', '狀態', '庫存狀態'],
  mini: ['id', '訂單日期', '建立時間', '建立者', '銷售小賣', '客戶名稱', '小賣自取', '電話', '取貨方式',
         '訂單內容', '價格', '運費', '成本', '寄送方式', '店名',
         '寄件狀態', '取貨狀態', '寄件代碼', '結帳狀態', '結帳日', '負責業務', '獎金', '備註',
         '品項JSON', '庫存異動JSON', '結帳確認者', '封存', '狀態'],
  dist: ['id', '訂單日期', '建立時間', '建立者', '經銷名稱', '經銷聯絡電話', '訂單內容', '價格', '運費', '成本',
         '寄送方式', '收貨門市', '收貨人', '收貨人電話',
         '寄件狀態', '取貨狀態', '寄件代碼', '結帳狀態', '結帳日', '負責業務', '備註',
         '品項JSON', '庫存異動JSON', '結帳確認者', '封存', '狀態', '宅配地址']
};
const SH_COL = {};                       // kind → {欄位: 索引}
Object.keys(SH_HEAD).forEach(k => { SH_COL[k] = {}; SH_HEAD[k].forEach((h, i) => SH_COL[k][h] = i); });
const lastCol = k => colLetter(SH_HEAD[k].length - 1);

/* ----------------------------- 狀態 ------------------------------------ */
const SALE = {
  mode: 'board',            // board | sales
  view: 'home',
  titles: {},               // kind → 分頁名稱
  rows: { shop: [], online: [], mini: [], dist: [] },
  lists: { staff: [], mini: [], dist: [] },
  form: null,
  loaded: false
};

/* ----------------------------- 啟動 ------------------------------------ */
window.initSales = async function (sheets) {
  const titles = (sheets || []).map(s => s.properties.title);

  // 1) 銷售分頁：沒有就建，並寫好標題列
  const need = [];
  for (const k of Object.keys(SALES.SHEET)) {
    const t = SALES.SHEET[k];
    SALE.titles[k] = t;
    if (!titles.includes(t)) need.push(t);
  }
  if (need.length) {
    await api(`${CONFIG.SPREADSHEET_ID}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: need.map(t => ({ addSheet: { properties: { title: t } } })) })
    });
    toast('已建立銷售分頁：' + need.join('、'), 'ok');
  }
  // 標題列比對（缺欄位自動補）
  for (const k of Object.keys(SH_HEAD)) {
    const t = SALE.titles[k];
    const hdr = (await readRange(t, `A1:${lastCol(k)}1`))[0] || [];
    if (SH_HEAD[k].some((h, i) => String(hdr[i] || '') !== h)) {
      await writeRanges([{ range: `'${t}'!A1:${lastCol(k)}1`, values: [SH_HEAD[k]] }]);
    }
  }

  // 2) 名單分頁：掃每個分頁的標題列，用欄位特徵認人
  const ranges = titles.map(t => rangeOf(t, 'A1:E1')).map(r => 'ranges=' + r).join('&');
  let heads = {};
  try {
    const j = await api(`${CONFIG.SPREADSHEET_ID}/values:batchGet?${ranges}`);
    (j.valueRanges || []).forEach((vr, i) => { heads[titles[i]] = (vr.values || [])[0] || []; });
  } catch (e) { console.warn('讀取分頁標題失敗', e); }

  for (const key of Object.keys(SALES.LIST_SIG)) {
    const sig = SALES.LIST_SIG[key];
    const want = (SALES.LIST_SHEET || {})[key];
    // 先用分頁名稱找，找不到再用標題列特徵認
    const hit = (want && titles.find(t => t === want))
      || titles.find(t => (heads[t] || []).some(c => String(c).trim() === sig));
    if (!hit) continue;
    SALE.titles['list_' + key] = hit;
    const rows = await readRange(hit, 'A2:F400');
    SALE.lists[key] = rows.filter(r => String(r[0] || '').trim()).map(r => ({
      name: String(r[0]).trim(), contact: String(r[1] || '').trim(),
      // 經銷名單：C 收貨門市／D 宅配地址／E 收貨人／F 電話
      c: String(r[2] || '').trim(), addr: String(r[3] || '').trim(),
      d: String(r[4] || '').trim(), e: String(r[5] || '').trim()
    }));
  }

  await loadSales();
  wireSalesUI();
  SALE.loaded = true;
};

async function loadSales() {
  for (const k of Object.keys(SH_HEAD)) {
    const t = SALE.titles[k];
    const rows = await readRange(t, `A2:${lastCol(k)}3000`);
    SALE.rows[k] = rows.map((r, i) => {
      const o = { _row: i + 2, _kind: k };
      SH_HEAD[k].forEach((h, ci) => o[h] = r[ci] ?? '');
      return o;
    }).filter(o => o.id);
  }
}

/* ----------------------------- 共用小工具 ------------------------------ */
const sEsc = s => esc(s);
const numIn = (cls, val, ph, extra) =>
  `<input type="number" inputmode="decimal" class="${cls}" min="0" step="1" value="${val ?? ''}" placeholder="${ph || ''}" ${extra || ''}>`;
const telIn = (cls, val) => `<input type="tel" inputmode="tel" class="${cls}" value="${sEsc(val || '')}">`;
const opts = (list, cur) => list.map(o => `<option value="${sEsc(o)}"${o === cur ? ' selected' : ''}>${sEsc(o)}</option>`).join('');

/** 依登入 email 猜負責業務 */
function defaultStaff() {
  const email = String((S.user && S.user.email) || '').toLowerCase();
  const hit = SALE.lists.staff.find(x => x.contact && x.contact.toLowerCase() === email);
  return hit ? hit.name : '';
}
function staffNames() { return SALE.lists.staff.map(x => x.name); }

/** 一張單的成本合計 */
function costOf(items) {
  return items.reduce((sum, it) => {
    const p = S.products.byRow.get(it.row);
    const c = p ? (p.nums['成本'] || 0) : 0;
    return sum + c * it.qty;
  }, 0);
}
const itemsText = items => items.map(i => `${i.name} ${i.spec} ×${i.qty}`).join('\n');
const itemsTotal = items => items.reduce((s, i) => s + (i.qty * (i.price || 0)), 0);

/** 把品項補上 name/spec（從庫存表查） */
function fillItems(list, src) {
  return list.map(i => {
    const p = S.products.byRow.get(i.row);
    return { row: i.row, name: p ? p.name : '', spec: p ? p.spec : '', qty: i.qty, price: i.price || 0, src };
  });
}

/* ----------------------------- 模式切換 -------------------------------- */
function wireSalesUI() {
  document.querySelectorAll('.mode-tab').forEach(t => t.onclick = () => setMode(t.dataset.mode));
}
function setMode(m) {
  SALE.mode = m;
  document.querySelectorAll('.mode-tab').forEach(x => x.classList.toggle('on', x.dataset.mode === m));
  $('boardView').classList.toggle('hidden', m !== 'board');
  $('salesView').classList.toggle('hidden', m !== 'sales');
  if (m === 'sales') renderSalesView();
}

/* ----------------------------- 畫面分派 -------------------------------- */
function renderSalesView() {
  const v = SALE.view;
  if (v === 'new') return renderNewPicker();
  if (v === 'query') return renderQuery();
  if (v === 'shoplog') return renderShopLog();
  if (v.startsWith('recv-')) return reRenderRecv(v.slice(5));
  SALE.view = 'home';
  return renderSales();
}

/* ----------------------------- 銷售首頁 -------------------------------- */
function unsettled(kind) {
  return SALE.rows[kind].filter(r => String(r['封存']) !== '是');
}

function renderSales() {
  if (SALE.view !== 'home') return;
  const n = k => unsettled(k).length;
  $('salesView').innerHTML = `
    <div class="pos-row">
      <button class="pos-btn primary" data-sv="new"><span class="ico">＋</span>新增銷售
        <span class="sub">來店 · 網路 · 小賣 · 經銷</span></button>
      <button class="pos-btn" data-sv="query"><span class="ico">🔍</span>查詢
        <span class="sub">日期 · 單別 · 客戶 · 業務</span></button>
    </div>
    <div class="pos-row">
      <button class="pos-btn" data-sv="shoplog"><span class="ico">🏬</span>來店銷售紀錄
        <span class="sub">看明細 · 修改 · 作廢</span></button>
    </div>
    <div class="pos-row">
      <button class="pos-btn" data-sv="recv-dist"><span class="ico">🏪</span>經銷應收待結
        ${n('dist') ? `<span class="badge">${n('dist')}</span>` : '<span class="sub">目前沒有</span>'}</button>
      <button class="pos-btn" data-sv="recv-online"><span class="ico">📦</span>網路應收待結
        ${n('online') ? `<span class="badge">${n('online')}</span>` : '<span class="sub">目前沒有</span>'}</button>
      <button class="pos-btn" data-sv="recv-mini"><span class="ico">🛍️</span>小賣應收待結
        ${n('mini') ? `<span class="badge">${n('mini')}</span>` : '<span class="sub">目前沒有</span>'}</button>
    </div>
    <div class="sec-title">今日銷售</div>
    ${todayBrief()}`;
}

/** 今天（只有今天）開的每一張單，逐筆列出 */
function todayBrief() {
  const t = todayStr();
  const all = [];
  for (const k of Object.keys(SH_HEAD)) {
    SALE.rows[k].filter(r => String(r['訂單日期']) === t).forEach(r => all.push(r));
  }
  if (!all.length) return `<div class="empty">今天還沒有銷售紀錄</div>`;

  const dead = r => String(r['狀態']) === SALES.VOID || String(r['狀態']) === SALES.RETURNED;
  const live = all.filter(r => !dead(r));
  const sum = live.reduce((s, r) => s + (Number(r['金額'] || r['價格']) || 0), 0);
  const by = {};
  live.forEach(r => { by[r._kind] = (by[r._kind] || 0) + 1; });

  // 晚開的排前面
  all.sort((a, b) => String(b['建立時間'] || '').localeCompare(String(a['建立時間'] || '')));

  const who = r => r._kind === 'shop' ? r['門市']
    : r._kind === 'dist' ? r['經銷名稱']
      : r._kind === 'mini' ? `${r['銷售小賣']}${r['客戶名稱'] ? '　' + r['客戶名稱'] : '（自取）'}`
        : r['客戶名稱'];

  return `<div class="day-sum">
      <span class="n">${live.length} 筆</span>
      <span class="amt">${money(sum)}</span>
      <span class="by">${Object.keys(by).map(k => `${SALES.LABEL[k]} ${by[k]}`).join('　·　') || '—'}</span>
    </div>
    <div class="day-list">
      ${all.map(r => {
        const paid = r._kind === 'shop' ? '' : String(r['結帳狀態'] || '');
        const time = String(r['建立時間'] || '').split(' ')[1] || '';
        return `<div class="day-row${dead(r) ? ' is-void' : ''}">
          <span class="tm">${sEsc(time)}</span>
          <span class="kd k-${r._kind}">${SALES.LABEL[r._kind]}</span>
          <span class="nm">${sEsc(who(r) || '（未填）')}
            ${dead(r) ? `<i class="void-tag">${sEsc(r['狀態'])}</i>` : ''}</span>
          <span class="it">${sEsc(String(r['品項明細'] || r['訂單內容'] || '').replace(/\n/g, '、'))}</span>
          <span class="st">${paid ? `<i class="pill-pay ${paid === '已結帳' ? 'yes' : 'no'}">${sEsc(paid)}</i>` : ''}
            ${sEsc(r['負責業務'] || '')}</span>
          <span class="mn">${money(r['金額'] || r['價格'])}</span>
        </div>`;
      }).join('')}
    </div>`;
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-sv]');
  if (!b) return;
  const v = b.dataset.sv;
  if (v === 'new') return renderNewPicker();
  if (v === 'home') { SALE.view = 'home'; return renderSales(); }
  if (v === 'query') return renderQuery();
  if (v === 'shoplog') return renderShopLog();
  if (v.startsWith('recv-')) return renderRecv(v.slice(5));
});

function backBar(title) {
  return `<div class="sales-head">
    <button class="btn btn-sm" data-sv="home">← 返回</button>
    <h2>${sEsc(title)}</h2>
  </div>`;
}

/* ----------------------------- 新增銷售：選單別 ------------------------ */
function renderNewPicker() {
  SALE.view = 'new';
  $('salesView').innerHTML = backBar('新增銷售單') + `
    <div class="pos-row">
      ${Object.keys(SALES.SHEET).map(k => `
        <button class="pos-btn" data-newsale="${k}">
          <span class="ico">${{ shop: '🏬', online: '🌐', mini: '🛍️', dist: '🏪' }[k]}</span>${SALES.LABEL[k]}
          <span class="sub">${{ shop: '客人在店裡買', online: '網路訂單，總倉出', mini: '小賣訂貨', dist: '經銷商訂貨' }[k]}</span>
        </button>`).join('')}
    </div>`;
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-newsale]');
  if (b) openSaleForm(b.dataset.newsale);
});

/* ----------------------------- 銷售單表單 ------------------------------ */
function newSaleItem() { return { cat: S.lastCat || null, name: '', row: null, qty: 1, price: 0 }; }
function newDistGroup() { return { cat: S.lastCat || null, name: '', qty: {}, price: {} }; }

function openSaleForm(kind) {
  SALE.form = {
    kind, date: todayStr(), staff: defaultStaff(),
    store: CONFIG.STORES[0].label,
    items: [newSaleItem()], groups: [newDistGroup()],
    cName: '', tel: '', note: '', fee: '', payStatus: SALES.PAY[0], payDate: '',
    collect: SALES.COLLECT[0],
    noStock: '',                       // 網路單庫存處理：'' = 扣總倉；agent／order = 不扣
    miniName: (SALE.lists.mini[0] || {}).name || '', selfPick: false, pickup: SALES.PICKUP[0],
    sendWay: SALES.SEND_WAY[0], storeName: '',
    distName: (SALE.lists.dist[0] || {}).name || '', distTel: '',
    dSendWay: SALES.DIST_SEND_WAY[0], useDefault: true, rShop: '', rAddr: '', rName: '', rTel: '',
    editRow: null
  };
  applyDistDefaults();
  const host = $('modalHost');
  host.innerHTML = `<div class="modal"><div class="sheet sale-form">
      <div class="sheet-head"><h2>新增${SALES.LABEL[kind]}銷售單</h2>
        <button class="btn btn-ghost" id="closeSale">✕</button></div>
      <div class="sheet-body" id="saleBody"></div>
      <div class="sheet-foot">
        <button class="btn" id="cancelSale">取消</button>
        <button class="btn btn-primary" id="submitSale">送出銷售單</button>
      </div></div></div>`;
  $('closeSale').onclick = $('cancelSale').onclick = () => { host.innerHTML = ''; SALE.form = null; };
  $('submitSale').onclick = submitSale;
  renderSaleBody();
}

function applyDistDefaults() {
  const f = SALE.form;
  if (f.kind !== 'dist' || !f.useDefault) return;
  const d = SALE.lists.dist.find(x => x.name === f.distName);
  if (d) { f.rShop = d.c; f.rAddr = d.addr || ''; f.rName = d.d; f.rTel = d.e; }
}

/** 這張單的庫存來源欄位 */
function saleSrc() {
  const f = SALE.form;
  if (f.kind === 'shop') return storeCol(f.store);
  if (f.kind === 'mini') return f.pickup === '寄送' ? CONFIG.H.warehouse : storeCol(SALES.PICK_STORE[f.pickup]);
  return CONFIG.H.warehouse;
}
/** 網路單勾了「廠商代出」或「待調貨」就不扣庫存 */
function noStockTags() {
  const f = SALE.form;
  if (!f || f.kind !== 'online' || !f.noStock) return [];
  const hit = SALES.NOSTOCK.find(o => o.key === f.noStock);
  return hit ? [hit.tag] : [];
}
const skipStock = () => noStockTags().length > 0;

/** 小賣可選的取貨方式：勾了「小賣自取」就沒有寄送 */
function pickupOptions() {
  const f = SALE.form;
  return f && f.selfPick ? SALES.PICKUP.filter(p => p !== '寄送') : SALES.PICKUP;
}
function srcNote() {
  return `<div class="hint-row">這張單的庫存會扣在 <b>${sEsc(srcLabel(saleSrc()))}</b></div>`;
}

/** 網路單：庫存怎麼處理（三選一） */
function noStockBlock() {
  const f = SALE.form, cur = f.noStock || '';
  const opt = (key, html) => `<label class="opt${cur === key ? ' on' : ''}">
      <input type="radio" name="nsMode" value="${key}"${cur === key ? ' checked' : ''}>
      <span>${html}</span></label>`;
  return `<div class="field">
    <label>庫存處理 <span class="req">*</span></label>
    <div class="opt-list">
      ${opt('', `這張單的庫存扣在 <b>${sEsc(srcLabel(saleSrc()))}</b>（一般情況）`)}
      ${SALES.NOSTOCK.map(o => opt(o.key, sEsc(o.label))).join('')}
    </div>
    ${skipStock() ? `<div class="opt-warn">🚫 這張單<b>不扣庫存</b>（${sEsc(noStockTags().join('、'))}），只記錄銷售、營收與成本</div>` : ''}
  </div>`;
}

function renderSaleBody() {
  const f = SALE.form, b = $('saleBody');
  const staffField = `<div class="field"><label>負責業務 <span class="req">*</span></label>
      <select id="fStaff">${opts([''].concat(staffNames()), f.staff)}</select>
      ${f.staff ? '<div class="hint-row">已依你的登入帳號自動帶入，可以改</div>' : ''}</div>`;
  const dateField = `<div class="field"><label>訂單日期 <span class="req">*</span></label>
      <input type="date" id="fDate2" value="${f.date}"></div>`;
  const noteField = `<div class="field"><label>備註</label>
      <textarea id="fNote2" placeholder="特殊狀況、客人交代的事">${sEsc(f.note)}</textarea></div>`;
  const payFields = `
    <div class="field"><label>結帳狀態 <span class="req">*</span></label>
      <div class="chips big-chips" id="payChips">
        ${SALES.PAY.map(p => `<button class="chip${p === f.payStatus ? ' on' : ''}" data-pay="${p}">${p}</button>`).join('')}
      </div></div>
    <div class="field"><label>結帳日（未結帳可空白）</label>
      <input type="date" id="fPayDate" value="${f.payDate}"></div>`;
  const feeField = `<div class="field"><label>運費</label>${numIn('fFee', f.fee, '0')}</div>`;

  let html = dateField;

  if (f.kind === 'shop') {
    html += `<div class="field"><label>門市 <span class="req">*</span></label>
        <div class="chips big-chips" id="storeChips2">
          ${CONFIG.STORES.map(s => `<button class="chip${s.label === f.store ? ' on' : ''}" data-store="${s.label}">${s.label}</button>`).join('')}
        </div>${srcNote()}</div>` + staffField + itemsBlock() + noteField;
  }

  if (f.kind === 'online') {
    html += `<div class="field"><label>客戶名稱 <span class="req">*</span></label>
        <input type="text" id="fCName" value="${sEsc(f.cName)}"></div>
      <div class="field"><label>電話 <span class="req">*</span></label>${telIn('fTel', f.tel)}</div>`
      + itemsBlock() + noStockBlock()
      + `<div class="field"><label>寄送方式 <span class="req">*</span></label>
          <div class="chips big-chips" id="wayChips">
            ${SALES.SEND_WAY.map(w => `<button class="chip${w === f.sendWay ? ' on' : ''}" data-way="${w}">${w}</button>`).join('')}
          </div></div>
        <div class="field"><label>店名</label>
          <input type="text" id="fStoreName" value="${sEsc(f.storeName)}" placeholder="例如：7-11 興一門市"></div>`
      + feeField
      + `<div class="field"><label>結帳狀態 <span class="req">*</span></label>
          <div class="chips big-chips" id="collectChips">
            ${SALES.COLLECT.map(p => `<button class="chip${p === f.collect ? ' on' : ''}" data-collect="${p}">${p}</button>`).join('')}
          </div>
          <div class="hint-row">${f.collect === SALES.COLLECT_PAID
            ? '款已收到 → 試算表的結帳狀態直接記「<b>已結帳</b>」'
            : '貨到付款 → 先記「<b>未結帳</b>」，收到錢後在「網路應收待結」按已結帳'}</div></div>
        ${f.collect === SALES.COLLECT_PAID
          ? `<div class="field"><label>結帳日</label><input type="date" id="fPayDate" value="${f.payDate}"></div>` : ''}`
      + staffField + noteField
      + `<div class="hint-row" style="margin-top:-6px">寄件狀態、取貨狀態、寄件代碼開單時不用填，之後在「網路應收待結」補。成本會自動從庫存表的「成本」帶進試算表。</div>`;
  }

  if (f.kind === 'mini') {
    html += `<div class="field"><label>銷售小賣 <span class="req">*</span></label>
        <select id="fMini">${opts(SALE.lists.mini.map(x => x.name), f.miniName)}</select></div>
      <div class="field"><label>客戶名稱 ${f.selfPick ? '' : '<span class="req">*</span>'}</label>
        <input type="text" id="fCName" value="${sEsc(f.cName)}" ${f.selfPick ? 'placeholder="小賣自取，可不填"' : ''}>
        <div style="margin-top:8px">
          <label class="check-inline${f.selfPick ? ' on' : ''}"><input type="checkbox" id="fSelf" ${f.selfPick ? 'checked' : ''}>小賣自取</label>
        </div></div>
      ${f.selfPick ? '' : `<div class="field"><label>電話</label>${telIn('fTel', f.tel)}</div>`}
      <div class="field"><label>取貨方式 <span class="req">*</span></label>
        <div class="chips big-chips" id="pickChips">
          ${pickupOptions().map(p => `<button class="chip${p === f.pickup ? ' on' : ''}" data-pick="${p}">${p}</button>`).join('')}
        </div>${f.selfPick ? '<div class="hint-row">小賣自取 → 只能選店取，「寄送」已隱藏</div>' : ''}${srcNote()}</div>`
      + itemsBlock()
      + (f.pickup === '寄送' ? `
        <div class="field"><label>寄送方式</label>
          <div class="chips big-chips" id="wayChips">
            ${SALES.SEND_WAY.map(w => `<button class="chip${w === f.sendWay ? ' on' : ''}" data-way="${w}">${w}</button>`).join('')}
          </div></div>
        <div class="field"><label>店名</label><input type="text" id="fStoreName" value="${sEsc(f.storeName)}"></div>
        ${feeField}` : '')
      + payFields + staffField + noteField;
  }

  if (f.kind === 'dist') {
    html += `<div class="field"><label>經銷名稱 <span class="req">*</span></label>
        <select id="fDist">${opts(SALE.lists.dist.map(x => x.name), f.distName)}</select></div>
      <div class="field"><label>經銷聯絡電話</label>${telIn('fDistTel', f.distTel)}</div>`
      + distBlock()
      + `<div class="field"><label>寄送方式</label>
          <div class="chips big-chips" id="dwayChips">
            ${SALES.DIST_SEND_WAY.map(w => `<button class="chip${w === f.dSendWay ? ' on' : ''}" data-dway="${w}">${w}</button>`).join('')}
          </div></div>
        <div class="field">
          <label class="check-inline${f.useDefault ? ' on' : ''}"><input type="checkbox" id="fUseDef" ${f.useDefault ? 'checked' : ''}>使用預設收件資料</label>
        </div>
        ${f.dSendWay === SALES.HOME_DELIVERY
          ? `<div class="field"><label>宅配地址 <span class="req">*</span></label>
              <input type="text" id="fRAddr" value="${sEsc(f.rAddr)}" placeholder="例如：桃園市中壢區○○路 123 號 5 樓"></div>`
          : `<div class="field"><label>收貨門市</label><input type="text" id="fRShop" value="${sEsc(f.rShop)}"></div>`}
        <div class="field"><label>收貨人</label><input type="text" id="fRName" value="${sEsc(f.rName)}"></div>
        <div class="field"><label>收貨人電話</label>${telIn('fRTel', f.rTel)}</div>`
      + feeField + payFields + staffField + noteField;
  }

  b.innerHTML = html;
  wireSaleBody();
}

function itemsBlock() {
  return `<div class="field"><label>訂單內容 <span class="req">*</span></label>
    <div id="saleItems"></div>
    <button class="btn add-item" id="addSaleItem">＋ 增加品項</button>
    <div class="total-bar"><span>金額合計</span><span id="saleTotal">NT$0</span></div></div>`;
}
function distBlock() {
  return `<div class="field"><label>訂單內容 <span class="req">*</span></label>
    <div id="distGroups"></div>
    <button class="btn add-item" id="addDistGroup">＋ 增加另一個產品</button>
    <div class="total-bar"><span>金額合計</span><span id="saleTotal">NT$0</span></div></div>`;
}

function wireSaleBody() {
  const f = SALE.form;
  const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
  on('fDate2', 'oninput', e => f.date = e.target.value);
  on('fStaff', 'onchange', e => f.staff = e.target.value);
  on('fNote2', 'oninput', e => f.note = e.target.value);
  on('fCName', 'oninput', e => f.cName = e.target.value);
  on('fPayDate', 'oninput', e => f.payDate = e.target.value);
  on('fStoreName', 'oninput', e => f.storeName = e.target.value);
  on('fRShop', 'oninput', e => f.rShop = e.target.value);
  on('fRAddr', 'oninput', e => f.rAddr = e.target.value);
  on('fRName', 'oninput', e => f.rName = e.target.value);
  document.querySelectorAll('.fTel').forEach(el => el.oninput = e => f.tel = e.target.value);
  document.querySelectorAll('.fDistTel').forEach(el => el.oninput = e => f.distTel = e.target.value);
  document.querySelectorAll('.fRTel').forEach(el => el.oninput = e => f.rTel = e.target.value);
  document.querySelectorAll('.fFee').forEach(el => el.oninput = e => f.fee = e.target.value);

  document.querySelectorAll('#storeChips2 .chip').forEach(c => c.onclick = () => { f.store = c.dataset.store; renderSaleBody(); });
  document.querySelectorAll('#payChips .chip').forEach(c => c.onclick = () => { f.payStatus = c.dataset.pay; renderSaleBody(); });
  document.querySelectorAll('#pickChips .chip').forEach(c => c.onclick = () => { f.pickup = c.dataset.pick; renderSaleBody(); });
  document.querySelectorAll('#wayChips .chip').forEach(c => c.onclick = () => { f.sendWay = c.dataset.way; renderSaleBody(); });
  document.querySelectorAll('input[name="nsMode"]').forEach(el => el.onchange = e => {
    if (e.target.checked) { f.noStock = el.value; renderSaleBody(); }
  });
  document.querySelectorAll('#collectChips .chip').forEach(c => c.onclick = () => {
    f.collect = c.dataset.collect;
    if (f.collect === SALES.COLLECT_PAID && !f.payDate) f.payDate = f.date || todayStr();
    renderSaleBody();
  });
  document.querySelectorAll('#dwayChips .chip').forEach(c => c.onclick = () => { f.dSendWay = c.dataset.dway; renderSaleBody(); });

  on('fSelf', 'onchange', e => {
    f.selfPick = e.target.checked;
    // 勾了小賣自取就沒有「寄送」這個選項了，原本選寄送的自動切回店取
    if (f.selfPick && !pickupOptions().includes(f.pickup)) f.pickup = pickupOptions()[0];
    renderSaleBody();
  });
  on('fMini', 'onchange', e => { f.miniName = e.target.value; });
  on('fDist', 'onchange', e => { f.distName = e.target.value; applyDistDefaults(); renderSaleBody(); });
  on('fUseDef', 'onchange', e => { f.useDefault = e.target.checked; applyDistDefaults(); renderSaleBody(); });

  on('addSaleItem', 'onclick', () => { f.items.push(newSaleItem()); renderSaleItems(); });
  on('addDistGroup', 'onclick', () => { f.groups.push(newDistGroup()); renderDistGroups(); });
  if ($('saleItems')) renderSaleItems();
  if ($('distGroups')) renderDistGroups();
}

/* ---- 品項（來店 / 網路 / 小賣）：分類 → 品名 → 規格 → 數量 → 單價 ---- */
function renderSaleItems() {
  const host = $('saleItems'), P = S.products, f = SALE.form;
  host.innerHTML = f.items.map((it, i) => {
    const p = it.row ? P.byRow.get(it.row) : null;
    const cat = it.cat || (p ? p.cat : null) || S.lastCat || (P.cats[0] || ALL_CAT);
    const names = (!P.hasCats || cat === ALL_CAT) ? P.names : (P.byCat.get(cat) || []);
    const variants = it.name ? (P.byName.get(it.name) || []) : [];
    const have = p ? (p.nums[saleSrc()] || 0) : 0;
    const tabs = P.hasCats ? `<div class="cat-tabs">
        ${P.cats.map(c => `<button class="cat-tab${c === cat ? ' on' : ''}" data-cat="${sEsc(c)}">${sEsc(c)}</button>`).join('')}
        <button class="cat-tab${cat === ALL_CAT ? ' on' : ''}" data-cat="${ALL_CAT}">全部</button></div>` : '';
    return `<div class="item-row" data-i="${i}">
      ${tabs}
      <div class="two">
        <div class="f"><label>產品名稱</label>
          <select class="itemName"><option value="">— 請選擇（${names.length} 項）—</option>
            ${names.map(n => `<option value="${sEsc(n)}"${n === it.name ? ' selected' : ''}>${sEsc(n)}</option>`).join('')}
          </select></div>
        <div class="f"><label>產品規格</label>
          <select class="itemSpec"${it.name ? '' : ' disabled'}>
            <option value="">${it.name ? '— 請選擇規格 —' : '請先選產品名稱'}</option>
            ${variants.map(v => `<option value="${v.sheetRow}"${v.sheetRow === it.row ? ' selected' : ''}>${sEsc(v.spec || '（無規格）')}（${srcLabel(saleSrc())} ${v.nums[saleSrc()] || 0}）</option>`).join('')}
          </select></div>
      </div>
      ${p ? `<div class="stockline${it.qty > have ? ' short' : ''}">${sEsc(srcLabel(saleSrc()))}現有 <b>${have}</b>${it.qty > have ? `　⚠ 不足 ${it.qty - have}` : ''}　·　售價 ${money(p.price)}</div>` : ''}
      <div class="r2">
        <div class="f"><label>數量</label>${numIn('itemQty', it.qty, '1', 'min="1"')}</div>
        <div class="f"><label>單價</label>${numIn('itemPrice', it.price, '0')}</div>
        <div class="f" style="max-width:110px"><label>小計</label>
          <input type="text" value="${money(it.qty * it.price)}" readonly style="background:#f1f5f9"></div>
        ${f.items.length > 1 ? `<button class="del">✕</button>` : ''}
      </div></div>`;
  }).join('');

  host.querySelectorAll('.item-row').forEach(row => {
    const i = +row.dataset.i, it = f.items[i];
    row.querySelectorAll('.cat-tab').forEach(t => t.onclick = () => {
      it.cat = t.dataset.cat; S.lastCat = it.cat;
      const ns = it.cat === ALL_CAT ? S.products.names : (S.products.byCat.get(it.cat) || []);
      if (it.name && !ns.includes(it.name)) { it.name = ''; it.row = null; }
      renderSaleItems();
    });
    row.querySelector('.itemName').onchange = e => {
      it.name = e.target.value; it.row = null;
      const vs = S.products.byName.get(it.name) || [];
      if (vs.length === 1) { it.row = vs[0].sheetRow; it.price = vs[0].price; }
      renderSaleItems(); saleTotal();
    };
    row.querySelector('.itemSpec').onchange = e => {
      it.row = +e.target.value || null;
      const p = it.row ? S.products.byRow.get(it.row) : null;
      if (p) { it.price = p.price; it.cat = p.cat; }
      renderSaleItems(); saleTotal();
    };
    row.querySelector('.itemQty').oninput = e => { it.qty = Math.max(1, +e.target.value || 1); saleTotal(); };
    row.querySelector('.itemPrice').oninput = e => { it.price = Math.max(0, +e.target.value || 0); saleTotal(); };
    const d = row.querySelector('.del');
    if (d) d.onclick = () => { f.items.splice(i, 1); renderSaleItems(); saleTotal(); };
  });
  saleTotal();
}

/* ---- 經銷：同系列一次列出，每個規格都有「數量 + 單價」 ---- */
function renderDistGroups() {
  const host = $('distGroups'), P = S.products, f = SALE.form;
  host.innerHTML = f.groups.map((g, i) => {
    const cat = g.cat || S.lastCat || (P.cats[0] || ALL_CAT);
    const names = (!P.hasCats || cat === ALL_CAT) ? P.names : (P.byCat.get(cat) || []);
    const variants = g.name ? (P.byName.get(g.name) || []) : [];
    const tabs = P.hasCats ? `<div class="cat-tabs">
        ${P.cats.map(c => `<button class="cat-tab${c === cat ? ' on' : ''}" data-cat="${sEsc(c)}">${sEsc(c)}</button>`).join('')}
        <button class="cat-tab${cat === ALL_CAT ? ' on' : ''}" data-cat="${ALL_CAT}">全部</button></div>` : '';
    const specs = variants.length ? `<div class="spec-list">
        <div class="spec-head"><span>規格</span><span class="sq">總倉</span><span class="qt">數量</span><span class="qt">單價</span></div>
        ${variants.map(v => {
          const q = g.qty[v.sheetRow] || '', pr = g.price[v.sheetRow] ?? '';
          return `<div class="spec-row${q ? ' has' : ''}" data-row="${v.sheetRow}">
            <span class="nm">${sEsc(v.spec || '（無規格）')}</span>
            <span class="sq">${v.nums[CONFIG.H.warehouse] || 0}</span>
            ${numIn('gq', q, '0', `data-row="${v.sheetRow}"`)}
            ${numIn('gp', pr, String(v.price || 0), `data-row="${v.sheetRow}"`)}
          </div>`;
        }).join('')}</div>`
      : (g.name ? '' : `<div class="spec-empty">選好產品名稱後，這裡會列出所有規格，填數量和單價</div>`);
    return `<div class="group-box" data-i="${i}">
      <div class="group-top"><span class="group-n">產品 ${i + 1}</span>
        ${f.groups.length > 1 ? `<button class="del">✕</button>` : ''}</div>
      ${tabs}
      <div class="f"><label>產品名稱</label>
        <select class="gName"><option value="">— 請選擇（${names.length} 項）—</option>
          ${names.map(n => `<option value="${sEsc(n)}"${n === g.name ? ' selected' : ''}>${sEsc(n)}</option>`).join('')}
        </select></div>
      ${specs}</div>`;
  }).join('');

  host.querySelectorAll('.group-box').forEach(box => {
    const i = +box.dataset.i, g = f.groups[i];
    box.querySelectorAll('.cat-tab').forEach(t => t.onclick = () => {
      g.cat = t.dataset.cat; S.lastCat = g.cat;
      const ns = g.cat === ALL_CAT ? S.products.names : (S.products.byCat.get(g.cat) || []);
      if (g.name && !ns.includes(g.name)) { g.name = ''; g.qty = {}; g.price = {}; }
      renderDistGroups();
    });
    box.querySelector('.gName').onchange = e => {
      g.name = e.target.value; g.qty = {}; g.price = {};
      const p = (S.products.byName.get(g.name) || [])[0];
      if (p) g.cat = p.cat;
      renderDistGroups(); saleTotal();
    };
    box.querySelectorAll('.gq').forEach(inp => inp.oninput = ev => {
      const n = Math.max(0, +ev.target.value || 0), r = ev.target.dataset.row;
      if (n) { g.qty[r] = n; if (g.price[r] === undefined) { const p = S.products.byRow.get(+r); g.price[r] = p ? p.price : 0; } }
      else delete g.qty[r];
      ev.target.closest('.spec-row').classList.toggle('has', !!n);
      const pe = ev.target.closest('.spec-row').querySelector('.gp');
      if (pe && n && !pe.value) pe.value = g.price[r];
      saleTotal();
    });
    box.querySelectorAll('.gp').forEach(inp => inp.oninput = ev => {
      g.price[ev.target.dataset.row] = Math.max(0, +ev.target.value || 0); saleTotal();
    });
    const d = box.querySelector('.del');
    if (d) d.onclick = () => { f.groups.splice(i, 1); renderDistGroups(); saleTotal(); };
  });
  saleTotal();
}

function saleItemList() {
  const f = SALE.form, src = saleSrc();
  if (f.kind === 'dist') {
    const out = [];
    f.groups.forEach(g => Object.keys(g.qty).forEach(r => {
      const n = Number(g.qty[r]) || 0;
      if (n > 0) out.push({ row: +r, qty: n, price: Number(g.price[r]) || 0 });
    }));
    return fillItems(out, src);
  }
  return fillItems(f.items.filter(i => i.row).map(i => ({ row: i.row, qty: i.qty, price: i.price })), src);
}
function saleTotal() {
  const el = $('saleTotal');
  if (el) el.textContent = money(itemsTotal(saleItemList()));
}

/* ----------------------------- 送出銷售單 ------------------------------ */
async function submitSale() {
  const f = SALE.form, k = f.kind, btn = $('submitSale');
  if (f.editRow) return submitShopEdit();
  const items = saleItemList();
  if (!f.date) return alert('請選擇訂單日期');
  if (!items.length) return alert('請選擇訂單內容');
  if (!f.staff) return alert('請選擇負責業務');
  if (k === 'online' && !f.cName.trim()) return alert('請填寫客戶名稱');
  if (k === 'online' && !f.tel.trim()) return alert('請填寫電話');
  if (k === 'mini' && !f.selfPick && !f.cName.trim()) return alert('請填寫客戶名稱，或勾選「小賣自取」');
  if (k === 'dist' && f.dSendWay === SALES.HOME_DELIVERY && !f.rAddr.trim()) return alert('選擇宅配時請填寫宅配地址');

  const src = saleSrc();
  const noStock = skipStock(), tags = noStockTags();
  const short = noStock ? [] : items.filter(i => {
    const p = S.products.byRow.get(i.row);
    return p && i.qty > (p.nums[src] || 0);
  });
  const total = itemsTotal(items), cost = costOf(items);

  const ok = await confirmModal({
    title: `確認這張${SALES.LABEL[k]}銷售單`,
    lines: `${noStock
        ? `<div class="alert-box">🚫 這張單<b>不扣庫存</b>（${sEsc(tags.join('、'))}）<br>
             <span style="font-weight:400;font-size:13px">貨不是從我們倉庫出的，所以只記錄銷售、營收和成本，庫存數字完全不動。</span></div>
           <p style="font-size:14px;color:var(--ink-2)">這張單的內容：</p>`
        : `<p style="font-size:14px;color:var(--ink-2)">送出後會直接從 <b>${sEsc(srcLabel(src))}</b> 扣掉庫存（總數減少）：</p>`}
      <pre class="pre">${esc(items.map(i => `・${i.name} ${i.spec} ×${i.qty}　${money(i.price * i.qty)}`).join('\n'))}</pre>
      <p style="font-size:15px"><b>合計 ${money(total)}</b>${f.fee ? `　運費 ${money(f.fee)}` : ''}</p>
      ${k === 'dist' ? `<p style="font-size:14px;color:var(--ink-2)">寄送方式：<b>${sEsc(f.dSendWay)}</b><br>
        ${f.dSendWay === SALES.HOME_DELIVERY
          ? `宅配地址：<b>${sEsc(f.rAddr.trim()) || '（未填）'}</b>`
          : `收貨門市：<b>${sEsc(f.rShop.trim()) || '（未填）'}</b>`}
        　收貨人：<b>${sEsc(f.rName.trim()) || '（未填）'}</b></p>` : ''}
      ${k === 'online' ? `<p style="font-size:14px;color:var(--ink-2)">寄送方式：<b>${sEsc(f.sendWay)}</b>${f.storeName.trim() ? `　店名：<b>${sEsc(f.storeName.trim())}</b>` : '　（店名未填）'}<br>
        結帳狀態：<b>${sEsc(f.collect)}</b> → 試算表記「<b>${f.collect === SALES.COLLECT_PAID ? '已結帳' : '未結帳'}</b>」</p>` : ''}
      ${short.length ? `<div class="warn-box">⚠ 以下品項在${sEsc(srcLabel(src))}庫存不足，送出後會變負數：<br>
        ${short.map(i => `・${sEsc(i.name)} ${sEsc(i.spec)}`).join('<br>')}</div>` : ''}`,
    okText: '確定送出'
  });
  if (!ok) return;

  S.busy = true; btn.disabled = true; btn.textContent = '送出中…';
  try {
    const id = 'X' + Date.now().toString(36).toUpperCase();
    const v = new Array(SH_HEAD[k].length).fill('');
    const set = (key, val) => { if (SH_COL[k][key] !== undefined) v[SH_COL[k][key]] = val; };
    const na = SALES.NA;
    const isSelf = k === 'mini' && f.selfPick;

    set('id', id); set('訂單日期', f.date); set('建立時間', nowStr()); set('建立者', userName());
    set('負責業務', f.staff); set('備註', f.note.trim()); set('成本', cost); set('狀態', '有效');
    set('品項JSON', JSON.stringify(items.map(i => ({ row: i.row, name: i.name, spec: i.spec, qty: i.qty, price: i.price }))));
    // 不扣庫存的單：庫存異動JSON 留空陣列，之後作廢／退貨才不會把貨「還」回去
    set('庫存異動JSON', noStock ? '[]'
      : JSON.stringify(items.map(i => ({ row: i.row, name: i.name, spec: i.spec, qty: i.qty, src }))));
    set('庫存狀態', noStock ? `不扣（${tags.join('、')}）` : '已扣庫存');

    if (k === 'shop') {
      set('門市', f.store); set('品項明細', itemsText(items)); set('金額', total);
      set('庫存狀態', '已扣庫存');
    } else {
      set('訂單內容', itemsText(items)); set('價格', total); set('運費', Number(f.fee) || 0);
      set('結帳狀態', f.payStatus); set('結帳日', f.payDate);
      set('寄件狀態', isSelf ? na : SALES.SHIP[0]);
      set('取貨狀態', isSelf ? na : SALES.PICK[0]);
      set('寄件代碼', isSelf ? na : '');
      set('封存', '');
    }
    if (k === 'online') {
      set('客戶名稱', f.cName.trim()); set('電話', f.tel.trim());
      set('寄送方式', f.sendWay); set('店名', f.storeName.trim());
      // 前台只選收款方式，結帳狀態由系統推：已收貨款 → 已結帳
      const paidNow = f.collect === SALES.COLLECT_PAID;
      set('收款方式', f.collect);
      set('結帳狀態', paidNow ? '已結帳' : '未結帳');
      set('結帳日', paidNow ? (f.payDate || f.date) : '');
      set('結帳確認者', paidNow ? userName() + ' ' + nowStr() : '');
    }
    if (k === 'mini') {
      set('銷售小賣', f.miniName); set('客戶名稱', f.cName.trim());
      set('小賣自取', f.selfPick ? '是' : '否'); set('電話', isSelf ? na : f.tel.trim());
      set('取貨方式', f.pickup);
      const posting = f.pickup === '寄送';
      set('寄送方式', isSelf ? na : (posting ? f.sendWay : na));
      set('店名', isSelf ? na : (posting ? f.storeName.trim() : na));
      if (isSelf) { set('結帳狀態', f.payStatus); }
    }
    if (k === 'dist') {
      set('經銷名稱', f.distName); set('經銷聯絡電話', f.distTel.trim());
      const home = f.dSendWay === SALES.HOME_DELIVERY;
      set('寄送方式', f.dSendWay);
      set('收貨門市', home ? SALES.NA : f.rShop.trim());
      set('宅配地址', home ? f.rAddr.trim() : SALES.NA);
      set('收貨人', f.rName.trim()); set('收貨人電話', f.rTel.trim());
    }

    await appendRow(SALE.titles[k], v);
    if (!noStock) await applyPlan(items, 'sell');
    $('modalHost').innerHTML = ''; SALE.form = null;
    await loadSales(); await loadProducts();
    SALE.view = 'home'; renderSales();
    toast(noStock ? `${SALES.LABEL[k]}銷售單已送出（${tags.join('、')}，未扣庫存）`
                  : `${SALES.LABEL[k]}銷售單已送出，庫存已扣`, 'ok');
  } catch (err) {
    alert('送出失敗：\n\n' + err.message);
  } finally {
    S.busy = false;
    if ($('submitSale')) { btn.disabled = false; btn.textContent = '送出銷售單'; }
  }
}

/* --------------- 預訂單取貨完成 → 自動開來店銷售單（不扣庫存） --------- */
window.createShopSaleFromOrder = async function (r) {
  if (!SALE.titles.shop) return;
  const items = parseJSON(r['品項JSON'], []);
  if (!items.length) return;
  const k = 'shop';
  const v = new Array(SH_HEAD[k].length).fill('');
  const set = (key, val) => { v[SH_COL[k][key]] = val; };
  const srcs = [...new Set(items.map(i => srcLabel(i.src || CONFIG.H.warehouse)))].join('、');
  set('id', 'X' + Date.now().toString(36).toUpperCase());
  set('訂單日期', todayStr()); set('建立時間', nowStr()); set('建立者', userName());
  set('門市', r['門市']); set('負責業務', defaultStaff());
  set('品項明細', items.map(i => `${i.name} ${i.spec} ×${i.qty}`).join('\n'));
  set('金額', Number(r['金額']) || 0);
  set('成本', costOf(items.map(i => ({ row: i.row, qty: i.qty }))));
  set('備註', `由預訂單「${r['客戶名稱'] || ''}」（${r.id}）自動產生。實際出貨來源：${srcs}。`);
  set('品項JSON', r['品項JSON']);
  set('庫存異動JSON', '[]');                    // 空的 → 不會再動庫存
  set('庫存狀態', '不扣（來自預訂單）');
  set('關聯單號', r.id); set('狀態', '有效');
  await appendRow(SALE.titles.shop, v);
  await loadSales();
};

/* ----------------------------- 來店銷售紀錄 ---------------------------- */
const shopVoided = r => String(r['狀態']) === SALES.VOID;
const shopLinked = r => !!String(r['關聯單號'] || '').trim();

function renderShopLog() {
  SALE.view = 'shoplog';
  const rows = SALE.rows.shop.slice().reverse().slice(0, 80);
  const live = rows.filter(r => !shopVoided(r));
  const sum = live.reduce((s, r) => s + (Number(r['金額']) || 0), 0);
  $('salesView').innerHTML = backBar('來店銷售紀錄') +
    `<div class="hint-row" style="margin:0 0 10px">最近 ${rows.length} 筆　·　有效 ${live.length} 筆　·　合計 ${money(sum)}</div>` +
    (rows.length ? rows.map(shopCard).join('') : `<div class="empty">還沒有來店銷售紀錄</div>`);
  wireShopLog();
}

function shopCard(r) {
  const voided = shopVoided(r), linked = shopLinked(r);
  const items = parseJSON(r['品項JSON'], []);
  return `<div class="rec-card${voided ? ' is-void' : ''}" data-id="${sEsc(r.id)}" data-row="${r._row}">
    <div class="rec-top">
      <span class="who2">${sEsc(r['門市'] || '—')}</span>
      <span class="pill-pay ${voided ? 'no' : 'yes'}">${voided ? '已作廢' : '有效'}</span>
      <span class="amt">${money(r['金額'])}</span>
    </div>
    <div class="rec-meta">${sEsc(r['訂單日期'])}　·　業務 <b>${sEsc(r['負責業務'] || '—')}</b>　·　${sEsc(r.id)}
      ${r['建立者'] ? `　·　開單 ${sEsc(r['建立者'])}` : ''}</div>
    <div class="rec-items">${items.length
      ? items.map(i => `${sEsc(i.name)} ${sEsc(i.spec)} ×${i.qty}　${money((i.price || 0) * i.qty)}`).join('<br>')
      : sEsc(r['品項明細'] || '（無明細）')}</div>
    ${r['備註'] ? `<div class="rec-meta">備註：${sEsc(r['備註'])}</div>` : ''}
    ${linked ? `<div class="note">🔗 由預訂單 ${sEsc(r['關聯單號'])} 自動產生，<b>不扣庫存</b>。品項要改請回留言板改那張預訂單。</div>` : ''}
    ${voided ? `<div class="note">已作廢，庫存${parseJSON(r['庫存異動JSON'], []).length ? '已退回' : '本來就沒扣'}。</div>` : ''}
    ${r['最後修改時間'] ? `<div class="rec-meta">✎ 最後修改：${sEsc(r['最後修改者'])} ${sEsc(r['最後修改時間'])}</div>` : ''}
    ${String(r['修改紀錄'] || '').trim() ? `<details class="chg"><summary>修改紀錄</summary>
      ${String(r['修改紀錄']).split('\n').filter(Boolean).map(x => `<div>${sEsc(x)}</div>`).join('')}</details>` : ''}
    ${voided ? '' : `<div class="rec-foot"><span class="meta"></span>
      <button class="btn btn-sm" data-shopedit="1">✎ 修改</button>
      <button class="btn btn-sm btn-danger" data-shopvoid="1">🗑 作廢（退回庫存）</button>
    </div>`}</div>`;
}

function wireShopLog() {
  document.querySelectorAll('.rec-card[data-id]').forEach(card => {
    const r = SALE.rows.shop.find(x => x.id === card.dataset.id);
    if (!r) return;
    const ed = card.querySelector('[data-shopedit]');
    if (ed) ed.onclick = () => openShopEdit(r);
    const vd = card.querySelector('[data-shopvoid]');
    if (vd) vd.onclick = () => voidShopSale(r);
  });
}

/* ---- 修改來店單 ---- */
function openShopEdit(r) {
  const items = parseJSON(r['品項JSON'], []);
  openSaleForm('shop');
  const f = SALE.form;
  f.editRow = r;
  f.date = r['訂單日期'] || todayStr();
  f.store = r['門市'] || CONFIG.STORES[0].label;
  f.staff = r['負責業務'] || '';
  f.note = r['備註'] || '';
  f.items = items.length
    ? items.map(i => ({ cat: (S.products.byRow.get(i.row) || {}).cat || null, name: i.name, row: i.row, qty: Number(i.qty) || 1, price: Number(i.price) || 0 }))
    : [newSaleItem()];
  const head = document.querySelector('.sale-form .sheet-head h2');
  if (head) head.textContent = '修改來店銷售單';
  const btn = $('submitSale');
  if (btn) btn.textContent = '儲存修改';
  renderSaleBody();
}

function shopDiff(r, f, items) {
  const out = [];
  const cmp = (label, oldV, newV) => {
    if (String(oldV ?? '') !== String(newV ?? '')) out.push(`${label}：${oldV || '（空）'} → ${newV || '（空）'}`);
  };
  cmp('訂單日期', r['訂單日期'], f.date);
  cmp('門市', r['門市'], f.store);
  cmp('負責業務', r['負責業務'], f.staff);
  cmp('備註', r['備註'], f.note.trim());
  const oldT = itemsText(parseJSON(r['品項JSON'], []));
  const newT = itemsText(items);
  if (oldT !== newT) out.push(`品項：\n${oldT || '（空）'}\n→\n${newT}`);
  const oldA = Number(r['金額']) || 0, newA = itemsTotal(items);
  if (oldA !== newA) out.push(`金額：${money(oldA)} → ${money(newA)}`);
  return out;
}

async function submitShopEdit() {
  const f = SALE.form, r = f.editRow, btn = $('submitSale');
  const items = saleItemList();
  if (!f.date) return alert('請選擇訂單日期');
  if (!items.length) return alert('請選擇訂單內容');
  if (!f.staff) return alert('請選擇負責業務');

  const linked = shopLinked(r);
  const oldPlan = normPlan(parseJSON(r['庫存異動JSON'], []));
  const newPlan = linked ? [] : items.map(i => ({ row: i.row, name: i.name, spec: i.spec, qty: i.qty, src: i.src }));
  const diff = shopDiff(r, f, items);
  if (!diff.length) return alert('沒有任何變更。');

  const stockLines = linked
    ? '<p style="font-size:14px;color:var(--ink-2)">這張單來自預訂單，<b>不會動到庫存</b>。</p>'
    : `${oldPlan.length ? `<p style="font-size:14px;color:var(--ink-2)">① 先把原本扣的<b>還回去</b>：</p>
        <pre class="pre">${esc(planText(oldPlan, 'unsell'))}</pre>` : ''}
       <p style="font-size:14px;color:var(--ink-2)">② 再依新內容<b>重新扣</b>：</p>
       <pre class="pre">${esc(planText(newPlan, 'sell'))}</pre>`;

  const ok = await confirmModal({
    title: '確認儲存這些修改？',
    lines: `<pre class="pre">${esc(diff.join('\n'))}</pre>${stockLines}`,
    okText: '確定，儲存修改'
  });
  if (!ok) return;

  S.busy = true; btn.disabled = true; btn.textContent = '儲存中…';
  try {
    if (!linked) {
      if (oldPlan.length) await applyPlan(oldPlan, 'unsell');
      await applyPlan(newPlan, 'sell');
    }
    const log = (String(r['修改紀錄'] || '') + `\n${nowStr()} ${userName()}：${diff.join('；').replace(/\n/g, ' ')}`).trim();
    await patchSale('shop', r, {
      訂單日期: f.date, 門市: f.store, 負責業務: f.staff, 備註: f.note.trim(),
      品項明細: itemsText(items), 金額: itemsTotal(items), 成本: costOf(items),
      品項JSON: JSON.stringify(items.map(i => ({ row: i.row, name: i.name, spec: i.spec, qty: i.qty, price: i.price }))),
      庫存異動JSON: linked ? '[]' : JSON.stringify(newPlan),
      最後修改時間: nowStr(), 最後修改者: userName(), 修改紀錄: log
    });
    $('modalHost').innerHTML = ''; SALE.form = null;
    await loadSales(); await loadProducts();
    renderShopLog();
    toast('已儲存修改', 'ok');
  } catch (err) {
    alert('儲存失敗：\n\n' + err.message);
  } finally {
    S.busy = false;
    if ($('submitSale')) { btn.disabled = false; btn.textContent = '儲存修改'; }
  }
}

/* ---- 作廢來店單 ---- */
async function voidShopSale(r) {
  const plan = normPlan(parseJSON(r['庫存異動JSON'], []));
  const ok = await confirmModal({
    title: '確認作廢這張來店銷售單？',
    lines: `<p><b>${sEsc(r['門市'])}</b>　${money(r['金額'])}　${sEsc(r['訂單日期'])}</p>
      <pre class="pre">${esc(r['品項明細'] || '')}</pre>
      ${plan.length
        ? `<p style="font-size:14px;color:var(--ink-2)">當初扣掉的貨會<b>原路加回去</b>：</p>
           <pre class="pre">${esc(planText(plan, 'unsell'))}</pre>`
        : `<div class="alert-box">這張單<b>本來就沒扣庫存</b>（來自預訂單），作廢只是把這筆營收作廢，庫存不會變。</div>`}
      <div class="alert-box">作廢後這筆會標成「已作廢」留在試算表裡，不會消失，也不會再算進業績。</div>`,
    okText: '確定，作廢',
    danger: true
  });
  if (!ok) return;
  try {
    if (plan.length) await applyPlan(plan, 'unsell');
    await patchSale('shop', r, {
      狀態: SALES.VOID,
      庫存狀態: plan.length ? '已退回庫存' : '不扣（來自預訂單）',
      最後修改時間: nowStr(), 最後修改者: userName(),
      修改紀錄: (String(r['修改紀錄'] || '') + `\n${nowStr()} ${userName()}：作廢${plan.length ? '，庫存已退回' : ''}`).trim()
    });
    await loadSales(); await loadProducts();
    renderShopLog();
    toast(plan.length ? '已作廢，庫存已退回' : '已作廢', 'ok');
  } catch (err) { alert('作廢失敗：\n' + err.message); }
}

/* ----------------------------- 應收待結 -------------------------------- */
/** 這一筆的「對象」——彙整就是照這個分組 */
function recvWho(r, kind) {
  return String((kind === 'dist' ? r['經銷名稱']
    : kind === 'mini' ? r['銷售小賣']
      : r['客戶名稱']) || '（未填）').trim() || '（未填）';
}
const owedOf = r => (Number(r['價格']) || 0) + (Number(r['運費']) || 0);

/** 第一層：依對象彙整，顯示未結金額。點進去才進第二層 */
function renderRecv(kind) {
  SALE.view = 'recv-' + kind;
  SALE.recvWho = null;
  const name = { dist: '經銷', online: '網路', mini: '小賣' }[kind];
  const rows = unsettled(kind).filter(r => String(r['結帳狀態']) !== '已結帳');
  const done = unsettled(kind).filter(r => String(r['結帳狀態']) === '已結帳');

  const bag = new Map();
  rows.forEach(r => {
    const w = recvWho(r, kind);
    const e = bag.get(w) || { who: w, n: 0, owe: 0, oldest: '', ship: 0 };
    e.n++; e.owe += owedOf(r);
    if (!e.oldest || String(r['訂單日期']) < e.oldest) e.oldest = String(r['訂單日期']);
    if (String(r['寄件狀態']) === SALES.SHIP[0]) e.ship++;
    bag.set(w, e);
  });
  const groups = [...bag.values()].sort((a, b) => b.owe - a.owe);
  const total = groups.reduce((s, g) => s + g.owe, 0);

  $('salesView').innerHTML = backBar(name + '應收待結') +
    (groups.length ? `
      <div class="recv-total"><span>${groups.length} 個${name === '網路' ? '客戶' : name}未結　·　${rows.length} 張單</span>
        <b>${money(total)}</b></div>
      ${groups.map(g => `<button class="sum-card" data-who="${sEsc(g.who)}">
          <span class="who3">${sEsc(g.who)}</span>
          <span class="owe">${money(g.owe)}</span>
          <span class="sub2">${g.n} 張未結　·　最早 ${sEsc(g.oldest || '—')}${g.ship ? `　·　${g.ship} 張未寄出` : ''}<i class="go">點開處理 ›</i></span>
        </button>`).join('')}`
      : `<div class="empty">目前沒有未結的${name}訂單 🎉</div>`) +
    (done.length ? `<div class="sec-title">已結帳、等收起（${done.length}）</div>
      ${done.map(r => `<button class="sum-card" data-who="${sEsc(recvWho(r, kind))}">
          <span class="who3">${sEsc(recvWho(r, kind))}</span>
          <span class="owe" style="color:var(--ok)">${money(owedOf(r))}</span>
          <span class="sub2">${sEsc(r['訂單日期'])}　·　${sEsc(r['取貨狀態'] || '')}<i class="go">點開處理 ›</i></span>
        </button>`).join('')}` : '');

  document.querySelectorAll('#salesView .sum-card').forEach(b =>
    b.onclick = () => renderRecvOne(kind, b.dataset.who));
}

/** 第二層：這個對象的每一張單，到這裡才能改狀態 */
function renderRecvOne(kind, who) {
  SALE.view = 'recv-' + kind;
  SALE.recvWho = who;
  const name = { dist: '經銷', online: '網路', mini: '小賣' }[kind];
  const rows = unsettled(kind).filter(r => recvWho(r, kind) === who)
    .sort((a, b) => String(a['訂單日期']).localeCompare(String(b['訂單日期'])));
  const owe = rows.filter(r => String(r['結帳狀態']) !== '已結帳').reduce((s, r) => s + owedOf(r), 0);

  $('salesView').innerHTML = `<div class="sales-head">
      <button class="btn btn-sm" data-recback="1">← ${sEsc(name)}應收待結</button>
      <h2>${sEsc(who)}</h2>
    </div>
    <div class="recv-total"><span>${rows.length} 張單　·　未結</span><b>${money(owe)}</b></div>` +
    (rows.length ? rows.map(r => recvCard(r, kind)).join('')
      : `<div class="empty">這個${name}沒有待處理的單了</div>`);

  const back = document.querySelector('[data-recback]');
  if (back) back.onclick = () => renderRecv(kind);
  wireRecv(kind);
}

/** 存回之後重畫：還在某個對象裡就留在第二層 */
function reRenderRecv(kind) {
  if (SALE.recvWho) return renderRecvOne(kind, SALE.recvWho);
  return renderRecv(kind);
}

function recvCard(r, kind) {
  const who = kind === 'dist' ? r['經銷名稱'] : kind === 'mini' ? `${r['銷售小賣']}　${r['客戶名稱'] || '（小賣自取）'}` : r['客戶名稱'];
  const paid = r['結帳狀態'] === '已結帳';
  const returned = String(r['狀態']) === SALES.RETURNED;
  const canReturn = SALES.RETURN_PICK.includes(String(r['取貨狀態'])) && !returned;
  const canClose = (paid && SALES.DONE_PICK.includes(String(r['取貨狀態']))) || returned;
  const na = v => String(v) === SALES.NA;
  return `<div class="rec-card" data-id="${sEsc(r.id)}" data-row="${r._row}">
    <div class="rec-top">
      <span class="who2">${sEsc(who || '（未填）')}</span>
      <span class="pill-pay ${paid ? 'yes' : 'no'}">${sEsc(r['結帳狀態'] || '未結帳')}</span>
      <span class="amt">${money(r['價格'])}${Number(r['運費']) ? ` <span style="font-size:12px;font-weight:400;color:var(--ink-3)">+運 ${money(r['運費'])}</span>` : ''}</span>
    </div>
    <div class="rec-meta">${sEsc(r['訂單日期'])}　·　${sEsc(r['負責業務'] || '—')}　·　${sEsc(r.id)}
      ${r['電話'] && !na(r['電話']) ? '　·　' + sEsc(r['電話']) : ''}
      ${kind === 'dist' ? `　·　${sEsc((String(r['寄送方式']) === SALES.HOME_DELIVERY ? r['宅配地址'] : r['收貨門市']) || '')} ${sEsc(r['收貨人'] || '')} ${sEsc(r['收貨人電話'] || '')}` : ''}</div>
    <div class="rec-items">${sEsc(r['訂單內容'] || '')}</div>
    ${r['備註'] ? `<div class="rec-meta">備註：${sEsc(r['備註'])}</div>` : ''}
    <div class="st-grid">
      <div><label>寄件狀態</label><select class="rSel" data-f="寄件狀態">${opts([SALES.NA].concat(SALES.SHIP), r['寄件狀態'])}</select></div>
      <div><label>取貨狀態</label><select class="rSel" data-f="取貨狀態">${opts([SALES.NA].concat(SALES.PICK), r['取貨狀態'])}</select></div>
      <div><label>寄件代碼</label><input class="rInp" data-f="寄件代碼" value="${sEsc(r['寄件代碼'] || '')}"></div>
      <div><label>寄送方式</label><select class="rSel" data-f="寄送方式">${opts([SALES.NA].concat(kind === 'dist' ? SALES.DIST_SEND_WAY : SALES.SEND_WAY), r['寄送方式'])}</select></div>
      ${(() => {
        const fld = kind !== 'dist' ? '店名'
          : (String(r['寄送方式']) === SALES.HOME_DELIVERY ? '宅配地址' : '收貨門市');
        return `<div${fld === '宅配地址' ? ' style="grid-column:1/-1"' : ''}><label>${fld}</label>
          <input class="rInp" data-f="${fld}" value="${sEsc(r[fld] || '')}"></div>`;
      })()}
      <div><label>運費</label><input class="rInp" data-f="運費" type="number" inputmode="decimal" value="${sEsc(r['運費'] || '')}"></div>
      <div><label>結帳狀態</label><select class="rSel" data-f="結帳狀態">${opts(SALES.PAY, r['結帳狀態'])}</select></div>
      <div><label>結帳日</label><input class="rInp" data-f="結帳日" type="date" value="${sEsc(r['結帳日'] || '')}"></div>
    </div>
    ${String(r['庫存狀態'] || '').startsWith('不扣')
      ? `<div class="note">🚫 這筆<b>${sEsc(r['庫存狀態'])}</b>，沒有動到庫存。貨到再出貨，作廢或退貨時庫存也不會變。</div>` : ''}
    ${returned ? `<div class="note">↩ 這筆已經<b>退貨入庫</b>，庫存已經加回去了。</div>` : ''}
    <div class="rec-foot">
      <span class="meta">${r['結帳確認者'] ? '結帳確認：' + sEsc(r['結帳確認者']) : ''}</span>
      <button class="btn btn-sm" data-recsave="1">儲存變更</button>
      ${canReturn ? `<button class="btn btn-sm btn-danger" data-recreturn="1">↩ 退貨入庫</button>` : ''}
      ${canClose ? `<button class="btn btn-sm btn-ok" data-recclose="1">✓ 完成並收起</button>` : ''}
    </div></div>`;
}

function wireRecv(kind) {
  document.querySelectorAll('.rec-card').forEach(card => {
    const id = card.dataset.id;
    const r = SALE.rows[kind].find(x => x.id === id);
    const patch = {};
    card.querySelectorAll('.rSel, .rInp').forEach(el => {
      const ev = el.tagName === 'SELECT' ? 'onchange' : 'oninput';
      el[ev] = e => { patch[el.dataset.f] = e.target.value; };
    });
    const save = card.querySelector('[data-recsave]');
    if (save) save.onclick = async () => {
      if (!Object.keys(patch).length) return toast('沒有變更');
      if (patch['結帳狀態'] === '已結帳' && r['結帳狀態'] !== '已結帳') patch['結帳確認者'] = userName() + ' ' + nowStr();
      save.disabled = true; save.textContent = '儲存中…';
      try { await patchSale(kind, r, patch); await loadSales(); reRenderRecv(kind); toast('已儲存', 'ok'); }
      catch (err) { alert('儲存失敗：\n' + err.message); save.disabled = false; save.textContent = '儲存變更'; }
    };
    const ret = card.querySelector('[data-recreturn]');
    if (ret) ret.onclick = async () => {
      const plan = normPlan(parseJSON(r['庫存異動JSON'], []));
      if (!plan.length) return alert('這筆沒有庫存紀錄，無法自動入庫。');
      const ok = await confirmModal({
        title: '確認貨已經退回來了？',
        lines: `<p><b>${sEsc(r['客戶名稱'] || r['經銷名稱'] || r['銷售小賣'] || '')}</b>　${money(r['價格'])}</p>
          <p style="font-size:14px;color:var(--ink-2)">目前取貨狀態：<b>${sEsc(r['取貨狀態'])}</b>。
          按下確定後，這些貨會<b>加回原本扣的地方</b>：</p>
          <pre class="pre">${esc(planText(plan, 'unsell'))}</pre>
          <div class="alert-box">請先確認<b>貨真的回到手上、也清點過了</b>再按。按錯的話庫存會多算。</div>`,
        okText: '確定，貨已退回入庫',
        danger: true
      });
      if (!ok) return;
      ret.disabled = true; ret.textContent = '處理中…';
      try {
        await applyPlan(plan, 'unsell');
        await patchSale(kind, r, {
          狀態: SALES.RETURNED,
          備註: (r['備註'] ? r['備註'] + ' / ' : '') + `${nowStr()} ${userName()} 退貨入庫`
        });
        await loadSales(); await loadProducts(); reRenderRecv(kind);
        toast('已退貨入庫，庫存已加回', 'ok');
      } catch (err) { alert('失敗：\n' + err.message); ret.disabled = false; ret.textContent = '↩ 退貨入庫'; }
    };

    const close = card.querySelector('[data-recclose]');
    if (close) close.onclick = async () => {
      const ok = await confirmModal({
        title: '確認這筆已經完成？',
        lines: `<p><b>${sEsc(kind === 'dist' ? r['經銷名稱'] : r['客戶名稱'] || r['銷售小賣'])}</b>　${money(r['價格'])}</p>
          <p style="font-size:14px;color:var(--ink-2)">結帳狀態：<b>${sEsc(r['結帳狀態'])}</b>　取貨狀態：<b>${sEsc(r['取貨狀態'])}</b></p>
          <div class="alert-box">收起後這筆<b>不會再顯示在應收待結</b>，但試算表的資料完整保留，「查詢」也查得到。</div>`,
        okText: '確定，收起'
      });
      if (!ok) return;
      try {
        await patchSale(kind, r, { 封存: '是', 結帳確認者: r['結帳確認者'] || (userName() + ' ' + nowStr()) });
        await loadSales(); reRenderRecv(kind); toast('已收起', 'ok');
      } catch (err) { alert('失敗：\n' + err.message); }
    };
  });
}

async function patchSale(kind, r, patch) {
  const t = SALE.titles[kind], data = [];
  for (const key of Object.keys(patch)) {
    const ci = SH_COL[kind][key];
    if (ci === undefined) continue;
    data.push({ range: `'${t}'!${colLetter(ci)}${r._row}`, values: [[patch[key]]] });
  }
  await writeRanges(data);
  Object.assign(r, patch);      // 本機同步，重新讀取失敗也不會顯示舊狀態
}

/* ----------------------------- 查詢 ------------------------------------ */
function renderQuery() {
  SALE.view = 'query';
  const q = SALE.query || (SALE.query = { from: '', to: '', kind: '全部', kw: '', staff: '' });
  $('salesView').innerHTML = backBar('查詢') + `
    <div class="rec-card">
      <div class="st-grid">
        <div><label>從</label><input type="date" id="qFrom" value="${q.from}"></div>
        <div><label>到</label><input type="date" id="qTo" value="${q.to}"></div>
        <div><label>單別</label><select id="qKind">${opts(['全部'].concat(Object.values(SALES.LABEL)), q.kind)}</select></div>
        <div><label>負責業務</label><select id="qStaff">${opts([''].concat(staffNames()), q.staff)}</select></div>
        <div style="grid-column:1/-1"><label>關鍵字（客戶／經銷／小賣／單號／品項）</label>
          <input id="qKw" value="${sEsc(q.kw)}" placeholder="留空就不篩"></div>
      </div>
      <div class="rec-foot"><span class="meta"></span>
        <button class="btn btn-primary btn-sm" id="qRun">查詢</button></div>
    </div>
    <div id="qResult"></div>`;
  const upd = () => {
    q.from = $('qFrom').value; q.to = $('qTo').value; q.kind = $('qKind').value;
    q.staff = $('qStaff').value; q.kw = $('qKw').value;
  };
  ['qFrom', 'qTo', 'qKind', 'qStaff', 'qKw'].forEach(id => { $(id).onchange = upd; $(id).oninput = upd; });
  $('qRun').onclick = () => { upd(); runQuery(); };
  runQuery();
}

function runQuery() {
  const q = SALE.query, kw = q.kw.trim().toLowerCase();
  let out = [];
  for (const k of Object.keys(SH_HEAD)) {
    if (q.kind !== '全部' && SALES.LABEL[k] !== q.kind) continue;
    SALE.rows[k].forEach(r => {
      const d = String(r['訂單日期'] || '');
      if (q.from && d < q.from) return;
      if (q.to && d > q.to) return;
      if (q.staff && r['負責業務'] !== q.staff) return;
      if (kw) {
        const hay = [r.id, r['客戶名稱'], r['經銷名稱'], r['銷售小賣'], r['品項明細'], r['訂單內容'], r['備註']]
          .join(' ').toLowerCase();
        if (!hay.includes(kw)) return;
      }
      out.push(r);
    });
  }
  out.sort((a, b) => String(b['訂單日期']).localeCompare(String(a['訂單日期'])));
  const dead = r => String(r['狀態']) === SALES.VOID || String(r['狀態']) === SALES.RETURNED;
  const sum = out.filter(r => !dead(r)).reduce((s, r) => s + (Number(r['金額'] || r['價格']) || 0), 0);
  const nDead = out.filter(dead).length;
  $('qResult').innerHTML = `<div class="sec-title">共 ${out.length} 筆　·　合計 ${money(sum)}${nDead ? `（不含 ${nDead} 筆作廢／退貨）` : ''}</div>` +
    (out.length ? out.slice(0, 200).map(r => `<div class="rec-card${dead(r) ? ' is-void' : ''}">
        <div class="rec-top">
          <span class="tag tag-order">${SALES.LABEL[r._kind]}</span>
          ${dead(r) ? `<span class="tag tag-cancel">${sEsc(r['狀態'])}</span>` : ''}
          <span class="who2">${sEsc(r['客戶名稱'] || r['經銷名稱'] || r['銷售小賣'] || r['門市'] || '')}</span>
          <span class="amt">${money(r['金額'] || r['價格'])}</span></div>
        <div class="rec-meta">${sEsc(r['訂單日期'])}　·　${sEsc(r['負責業務'] || '—')}　·　${sEsc(r.id)}
          ${r['結帳狀態'] ? '　·　' + sEsc(r['結帳狀態']) : ''}${String(r['封存']) === '是' ? '　·　已收起' : ''}</div>
        <div class="rec-items">${sEsc(r['品項明細'] || r['訂單內容'] || '')}</div>
      </div>`).join('')
      : `<div class="empty">沒有符合的訂單</div>`);
}
