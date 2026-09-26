import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "model-rigging-calibration.json");
const ledgerPath = join(__dirname, "data", "rigging-roll-ledger.json");
const port = Number(process.env.PORT || 3038);
const seed = {
  "items": [
    {
      "code": "MR-001",
      "shipType": "福船",
      "scale": "1:48",
      "mastCount": 3,
      "riggingMaterial": "蜡线",
      "owner": "周宁",
      "dueDate": "2026-06-28",
      "status": "校准中",
      "tasks": [
        {
          "id": "T-1",
          "position": "前桅侧支索",
          "tension": "偏松",
          "status": "调整中",
          "logs": [
            {
              "at": "2026-06-12",
              "note": "已缩短2mm"
            }
          ]
        }
      ],
      "logs": []
    }
  ]
};
// 卷材开卷与余量核销：规则 RG-、卷材 RL-、操作 OP- 各一套业务代码
const ledgerSeed = {
  counters: { roll: 2, op: 0 },
  rules: [
    { code: "RG-001", name: "长度预占", desc: "领料长度不得超出卷材可用余额，超出即停待复核，库存先不扣", params: {}, enabled: true },
    { code: "RG-002", name: "湿度越限停料", desc: "卷材湿度超出区间即停待复核，库存先不扣", params: { min: 40, max: 60 }, enabled: true },
    { code: "RG-003", name: "有效期停料", desc: "超过有效期的卷材不得领用，停待复核，库存先不扣", params: {}, enabled: true },
    { code: "RG-004", name: "一卷一领", desc: "一卷只接一份未完领料（预占中/待确认/待复核均占卷）", params: {}, enabled: true },
    { code: "RG-005", name: "残长偏差复核", desc: "裁切后登记残长与账面余额偏差超过阈值即转复核", params: { maxDeviationCm: 0.5 }, enabled: true },
    { code: "RG-006", name: "本人不能确认", desc: "领料/裁切本人不得确认或复核本人单据，须他人办理", params: {}, enabled: true }
  ],
  rolls: [
    { code: "RL-0001", batchNo: "P2026-0901", material: "蜡线", totalLength: 5000, remainingLength: 5000, humidity: 52, expiryDate: "2027-06-30", joints: 0, createdAt: "2026-09-26T00:00:00.000Z", logs: [{ at: "2026-09-26T00:00:00.000Z", step: "开卷", note: "开卷登记 5000cm · 湿度 52%" }] },
    { code: "RL-0002", batchNo: "P2026-0512", material: "麻线", totalLength: 3000, remainingLength: 3000, humidity: 68, expiryDate: "2026-12-31", joints: 0, createdAt: "2026-09-26T00:00:00.000Z", logs: [{ at: "2026-09-26T00:00:00.000Z", step: "开卷", note: "开卷登记 3000cm · 湿度 68%" }] }
  ],
  operations: []
};
const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
const stages = ["待检查","校准中","待复核","已交付"];
const statLabels = ["待检查","校准中","待复核","已交付"];
const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function loadLedger() {
  if (!existsSync(ledgerPath)) {
    await mkdir(dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, JSON.stringify(ledgerSeed, null, 2));
  }
  return JSON.parse(await readFile(ledgerPath, "utf8"));
}
async function saveLedger(ledger) { await writeFile(ledgerPath, JSON.stringify(ledger, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "MR-" + Date.now(); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}

// ---------- 卷材核销领域逻辑 ----------
const OPEN_STATUSES = ["预占中", "待确认", "待复核"];
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
function nextCode(ledger, key, prefix) {
  ledger.counters[key] = (ledger.counters[key] || 0) + 1;
  return prefix + "-" + String(ledger.counters[key]).padStart(4, "0");
}
function ruleOn(ledger, code) {
  const rule = ledger.rules.find(r => r.code === code);
  return rule && rule.enabled ? rule : null;
}
function opActors(op) {
  return [op.operator, op.cut && op.cut.operator].filter(Boolean);
}
// 预占口径：预占中按申请长度；已裁切未核销按实裁长度；停待复核未裁切的不占库存
function reservedOf(ledger, rollCode) {
  return round2(ledger.operations
    .filter(o => o.rollCode === rollCode)
    .reduce((n, o) => {
      if (o.status === "预占中") return n + o.reqLength;
      if ((o.status === "待确认" || o.status === "待复核") && o.cut) return n + o.cut.cutLength;
      return n;
    }, 0));
}
function rollView(ledger, roll) {
  const reserved = reservedOf(ledger, roll.code);
  const available = round2(roll.remainingLength - reserved);
  const openOp = ledger.operations.find(o => o.rollCode === roll.code && OPEN_STATUSES.includes(o.status));
  const today = new Date().toISOString().slice(0, 10);
  let status = "在库";
  if (roll.remainingLength <= 0) status = "已用完";
  else if (openOp && openOp.status === "待复核") status = "待复核";
  else if (openOp) status = "占用中";
  else if (roll.expiryDate < today) status = "已过期";
  return { ...roll, reserved, available, status, openOp: openOp ? openOp.code : null };
}
// 领料规则检查：任一命中即停待复核，库存先不扣
function checkRequisition(ledger, roll, reqLength) {
  const reasons = [];
  const today = new Date().toISOString().slice(0, 10);
  const hum = ruleOn(ledger, "RG-002");
  if (hum && (roll.humidity < Number(hum.params.min) || roll.humidity > Number(hum.params.max))) {
    reasons.push(`湿度越限：${roll.humidity}% 超出 ${hum.params.min}-${hum.params.max}%`);
  }
  if (ruleOn(ledger, "RG-003") && roll.expiryDate < today) {
    reasons.push(`已过有效期：${roll.expiryDate}`);
  }
  if (ruleOn(ledger, "RG-004")) {
    const open = ledger.operations.find(o => o.rollCode === roll.code && OPEN_STATUSES.includes(o.status));
    if (open) reasons.push(`一卷一领：${open.code} 未完（${open.status}）`);
  }
  if (ruleOn(ledger, "RG-001")) {
    const available = round2(roll.remainingLength - reservedOf(ledger, roll.code));
    if (reqLength > available) reasons.push(`长度不够：可用 ${available}cm < 申请 ${reqLength}cm`);
  }
  return reasons;
}
function ledgerSummary(ledger, rolls) {
  return {
    balanceTotal: round2(rolls.reduce((n, r) => n + r.remainingLength, 0)),
    reservedTotal: round2(rolls.reduce((n, r) => n + r.reserved, 0)),
    pending: ledger.operations.filter(o => OPEN_STATUSES.includes(o.status)).length,
    done: ledger.operations.filter(o => o.status === "已核销").length
  };
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .ledgerTitle { padding:6px 28px 0; } .ledgerTitle h2 { margin:0; }
    .ledger { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:16px 28px 26px; }
    .tableWrap { overflow-x:auto; } table { width:100%; border-collapse:collapse; font-size:13px; }
    th,td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); white-space:nowrap; } th { color:var(--muted); font-weight:600; }
    .opcard { border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:10px; background:#fff; }
    .opcard .row { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; margin-top:8px; }
    .opcard .row label { flex:1; min-width:120px; margin:0 0 4px; }
    .reasons { color:var(--warn); font-size:13px; margin-top:6px; }
    .ruleHead { display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .ruleHead label { display:inline-flex; gap:6px; align-items:center; margin:0; } .ruleHead input { width:auto; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .ledger{grid-template-columns:1fr;padding:12px 16px 20px;} .ledgerTitle{padding:6px 16px 0;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">模型、帆索任务和校准记录串联</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>新增帆索任务</h2><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>创建模型后可拆分帆索任务，逐条记录松紧状态、调整备注和完成时间。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <div class="ledgerTitle"><h2>卷材开卷与余量核销</h2><div class="meta">规则 RG-、卷材 RL-、操作 OP- 各自带业务代码；领料按索位长度预占，一卷只接一份未完领料，裁切后核销余额</div></div>
  <section class="ledger">
    <section>
      <form id="rollForm"><h2>卷材开卷登记</h2>
        <label>批号</label><input name="batchNo" required>
        <label>材料</label><input name="material" value="蜡线">
        <label>开卷长度(cm)</label><input name="totalLength" type="number" min="1" step="0.1" required>
        <label>湿度(%)</label><input name="humidity" type="number" min="0" max="100" step="0.1" required>
        <label>有效期</label><input name="expiryDate" type="date" required>
        <button>登记卷材</button>
      </form>
      <form id="reqForm" style="margin-top:14px"><h2>领料预占</h2>
        <label>卷材</label><select name="rollCode"></select>
        <label>索位</label><input name="position" placeholder="如：前桅侧支索" required>
        <label>预占长度(cm)</label><input name="reqLength" type="number" min="0.1" step="0.1" required>
        <label>领料人</label><input name="operator" required>
        <button>提交领料</button>
        <div class="meta" style="margin-top:8px">长度不够、湿度越限或过期即停待复核，库存先不扣。</div>
      </form>
      <div class="panel" style="margin-top:14px"><h2>规则</h2><div id="ruleList"></div></div>
    </section>
    <section>
      <div class="stats" id="rollStats"></div>
      <div class="panel"><h2>占用模型</h2><div class="tableWrap"><table>
        <thead><tr><th>业务代码 / 批号</th><th>材料</th><th>开卷长度</th><th>余额</th><th>预占</th><th>可用</th><th>湿度</th><th>有效期</th><th>状态</th></tr></thead>
        <tbody id="rollRows"></tbody>
      </table></div></div>
      <div class="panel" style="margin-top:14px"><h2>待处理</h2><div id="pendingList"></div></div>
      <div class="panel" style="margin-top:14px"><h2>操作流水</h2><div id="opList"></div></div>
    </section>
  </section>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+tasks+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
  <script>
    const rollForm = document.querySelector('#rollForm');
    const reqForm = document.querySelector('#reqForm');
    function cm(n) { return (Math.round((Number(n) + Number.EPSILON) * 100) / 100) + 'cm'; }
    function statHtml(label, value) { return '<div class="stat"><span>'+label+'</span><strong>'+value+'</strong></div>'; }
    function paramLabel(key) { return ({ min:'湿度下限%', max:'湿度上限%', maxDeviationCm:'偏差阈值cm' })[key] || key; }
    async function loadLedger() {
      try {
        const data = await api('/api/ledger');
        renderLedger(data);
      } catch (e) { alert(e.message); }
    }
    function renderLedger(data) {
      const s = data.summary;
      document.querySelector('#rollStats').innerHTML =
        statHtml('余额合计', cm(s.balanceTotal)) + statHtml('预占中', cm(s.reservedTotal)) +
        statHtml('待处理', s.pending + ' 单') + statHtml('已核销', s.done + ' 单');
      const hum = data.rules.find(r => r.code === 'RG-002');
      const today = new Date().toISOString().slice(0, 10);
      document.querySelector('#rollRows').innerHTML = data.rolls.map(r => {
        const humOut = hum && hum.enabled && (r.humidity < Number(hum.params.min) || r.humidity > Number(hum.params.max));
        const expired = r.expiryDate < today;
        return '<tr>' +
          '<td><b>'+r.code+'</b><div class="meta">'+r.batchNo+'</div></td>' +
          '<td>'+r.material+'</td>' +
          '<td>'+cm(r.totalLength)+'</td>' +
          '<td><b>'+cm(r.remainingLength)+'</b></td>' +
          '<td>'+cm(r.reserved)+'</td>' +
          '<td>'+cm(r.available)+'</td>' +
          '<td class="'+(humOut ? 'warn' : '')+'">'+r.humidity+'%</td>' +
          '<td class="'+(expired ? 'warn' : '')+'">'+r.expiryDate+'</td>' +
          '<td><span class="pill">'+r.status+'</span>'+(r.openOp ? '<div class="meta">'+r.openOp+'</div>' : '')+'</td>' +
        '</tr>';
      }).join('');
      reqForm.querySelector('[name=rollCode]').innerHTML = data.rolls.map(r =>
        '<option value="'+r.code+'">'+r.code+' · '+r.material+' · 可用 '+cm(r.available)+'</option>').join('');
      const pend = data.operations.filter(o => ['预占中','待确认','待复核'].includes(o.status));
      document.querySelector('#pendingList').innerHTML = pend.length ? pend.map(opCard).join('') : '<div class="meta">暂无待处理</div>';
      document.querySelector('#opList').innerHTML = data.operations.length ? data.operations.map(o =>
        '<div class="opcard"><b>'+o.code+'</b> <span class="pill">'+o.status+'</span> ' +
        '<span class="meta">'+o.rollCode+' · 索位 '+o.position+' · 预占 '+cm(o.reqLength)+' · 领料人 '+o.operator+(o.confirmer ? ' · 确认 '+o.confirmer : '')+'</span>' +
        '<div class="logs meta">'+o.logs.slice(-3).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('')+'</div></div>'
      ).join('') : '<div class="meta">暂无操作</div>';
      document.querySelector('#ruleList').innerHTML = data.rules.map(r => {
        const params = Object.entries(r.params || {}).map(([k,v]) =>
          '<label>'+paramLabel(k)+'</label><input type="number" step="0.1" data-rule-param="'+r.code+':'+k+'" value="'+v+'">').join('');
        return '<div class="opcard"><div class="ruleHead"><span><b>'+r.code+'</b> '+r.name+'</span>' +
          '<label><input type="checkbox" data-rule-toggle="'+r.code+'" '+(r.enabled ? 'checked' : '')+'> 启用</label></div>' +
          '<div class="meta">'+r.desc+'</div>'+params+'</div>';
      }).join('');
      bindLedgerActions();
    }
    function opCard(op) {
      const head = '<b>'+op.code+'</b> <span class="pill">'+op.status+'</span> ' +
        '<span class="meta">'+op.rollCode+' · 索位 '+op.position+' · 预占 '+cm(op.reqLength)+' · 领料人 '+op.operator+'</span>';
      const reasons = (op.reasons && op.reasons.length) ? '<div class="reasons">'+op.reasons.join('；')+'</div>' : '';
      let bodyHtml = '';
      if (op.status === '预占中') {
        bodyHtml = '<div class="row">' +
          '<label>实裁长度(cm)<input type="number" step="0.1" min="0.1" data-cut-len="'+op.code+'" value="'+op.reqLength+'"></label>' +
          '<label>登记残长(cm)<input type="number" step="0.1" min="0" data-cut-rem="'+op.code+'"></label>' +
          '<label>接头数<input type="number" min="0" step="1" value="0" data-cut-joints="'+op.code+'"></label>' +
          '<label>裁切人<input data-cut-by="'+op.code+'"></label>' +
          '<button data-cut-go="'+op.code+'">登记裁切</button></div>';
      } else if (op.status === '待确认') {
        bodyHtml = '<div class="meta">实裁 '+cm(op.cut.cutLength)+' · 残长 '+cm(op.cut.remainingLength)+' · 接头 '+op.cut.joints+' · 偏差 '+cm(op.cut.deviation)+' · 裁切人 '+op.cut.operator+'</div>' +
          '<div class="row"><label>确认人（本人不能确认）<input data-cfm-by="'+op.code+'"></label>' +
          '<button data-cfm-go="'+op.code+'">确认核销</button></div>';
      } else if (op.status === '待复核') {
        const cutInfo = op.cut ? '<div class="meta">实裁 '+cm(op.cut.cutLength)+' · 残长 '+cm(op.cut.remainingLength)+' · 偏差 '+cm(op.cut.deviation)+' · 裁切人 '+op.cut.operator+'</div>' : '';
        bodyHtml = cutInfo +
          '<div class="row"><label>复核人（本人不能复核）<input data-rvw-by="'+op.code+'"></label>' +
          '<button data-rvw-go="'+op.code+'" data-decision="放行">放行</button>' +
          '<button class="secondary" data-rvw-go="'+op.code+'" data-decision="退回">退回</button></div>';
      }
      return '<div class="opcard">'+head+reasons+bodyHtml+'</div>';
    }
    function fieldOf(code, attr) { const el = document.querySelector('['+attr+'="'+code+'"]'); return el ? el.value.trim() : ''; }
    function bindLedgerActions() {
      document.querySelectorAll('[data-cut-go]').forEach(btn => btn.onclick = async () => {
        const code = btn.dataset.cutGo;
        try {
          const out = await api('/api/operations/'+code+'/cut', { method:'POST', body: JSON.stringify({
            cutLength: Number(fieldOf(code, 'data-cut-len')),
            remainingLength: Number(fieldOf(code, 'data-cut-rem')),
            joints: Number(fieldOf(code, 'data-cut-joints') || 0),
            operator: fieldOf(code, 'data-cut-by')
          }) });
          if (out.status === '待复核') alert('偏差超阈值，已转复核：' + out.reasons.join('；'));
          await loadLedger();
        } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-cfm-go]').forEach(btn => btn.onclick = async () => {
        const code = btn.dataset.cfmGo;
        try {
          await api('/api/operations/'+code+'/confirm', { method:'POST', body: JSON.stringify({ confirmer: fieldOf(code, 'data-cfm-by') }) });
          await loadLedger();
        } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-rvw-go]').forEach(btn => btn.onclick = async () => {
        const code = btn.dataset.rvwGo;
        try {
          await api('/api/operations/'+code+'/review', { method:'POST', body: JSON.stringify({ reviewer: fieldOf(code, 'data-rvw-by'), decision: btn.dataset.decision }) });
          await loadLedger();
        } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-rule-toggle]').forEach(cb => cb.onchange = async () => {
        try { await api('/api/rules/'+cb.dataset.ruleToggle, { method:'PATCH', body: JSON.stringify({ enabled: cb.checked }) }); await loadLedger(); }
        catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-rule-param]').forEach(inp => inp.onchange = async () => {
        const parts = inp.dataset.ruleParam.split(':');
        const params = {}; params[parts[1]] = Number(inp.value);
        try { await api('/api/rules/'+parts[0], { method:'PATCH', body: JSON.stringify({ params }) }); await loadLedger(); }
        catch (e) { alert(e.message); }
      });
    }
    rollForm.onsubmit = async event => {
      event.preventDefault();
      try {
        await api('/api/rolls', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(rollForm).entries())) });
        rollForm.reset(); await loadLedger();
      } catch (e) { alert(e.message); }
    };
    reqForm.onsubmit = async event => {
      event.preventDefault();
      try {
        const out = await api('/api/requisitions', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(reqForm).entries())) });
        reqForm.reset();
        if (out.status === '待复核') alert('已停待复核，库存未扣：' + out.reasons.join('；'));
        await loadLedger();
      } catch (e) { alert(e.message); }
    };
    document.querySelector('#reload').addEventListener('click', loadLedger);
    loadLedger();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建模型" }] };
      item.tasks = [];
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      Object.assign(item, await body(req));
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.tasks ||= [];
      item.tasks.push({ id: "T-" + Date.now(), position: input.position, tension: input.tension, status: "待检查", logs: [{ at: new Date().toISOString(), note: input.note || "新增帆索任务" }] });
      item.status = "校准中";
      item.logs.push({ at: new Date().toISOString(), step: "帆索", note: input.position + " · " + input.tension });
      await saveDb(db);
      return send(res, 201, item);
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));

    // ---------- 卷材开卷与余量核销 ----------
    if (req.method === "GET" && url.pathname === "/api/ledger") {
      const ledger = await loadLedger();
      const rolls = ledger.rolls.map(r => rollView(ledger, r));
      return send(res, 200, { rules: ledger.rules, rolls, operations: ledger.operations, summary: ledgerSummary(ledger, rolls) });
    }
    if (req.method === "POST" && url.pathname === "/api/rolls") {
      const input = await body(req);
      const totalLength = Number(input.totalLength);
      const humidity = Number(input.humidity);
      if (!input.batchNo || !(totalLength > 0) || !(humidity >= 0 && humidity <= 100) || !input.expiryDate) {
        return send(res, 400, { error: "invalid_input", message: "批号、开卷长度、湿度、有效期必填" });
      }
      const ledger = await loadLedger();
      const roll = {
        code: nextCode(ledger, "roll", "RL"),
        batchNo: String(input.batchNo).trim(),
        material: (input.material || "蜡线").trim(),
        totalLength, remainingLength: totalLength, humidity,
        expiryDate: input.expiryDate, joints: 0,
        createdAt: new Date().toISOString(),
        logs: [{ at: new Date().toISOString(), step: "开卷", note: `开卷登记 ${totalLength}cm · 湿度 ${humidity}%` }]
      };
      ledger.rolls.unshift(roll);
      await saveLedger(ledger);
      return send(res, 201, roll);
    }
    if (req.method === "POST" && url.pathname === "/api/requisitions") {
      const input = await body(req);
      const reqLength = Number(input.reqLength);
      if (!input.position || !input.operator || !(reqLength > 0)) {
        return send(res, 400, { error: "invalid_input", message: "索位、预占长度、领料人必填" });
      }
      const ledger = await loadLedger();
      const roll = ledger.rolls.find(r => r.code === input.rollCode);
      if (!roll) return send(res, 404, { error: "roll_not_found", message: "卷材不存在" });
      const reasons = checkRequisition(ledger, roll, reqLength);
      const op = {
        code: nextCode(ledger, "op", "OP"),
        type: "领料",
        rollCode: roll.code,
        position: String(input.position).trim(),
        reqLength,
        operator: String(input.operator).trim(),
        status: reasons.length ? "待复核" : "预占中",
        reasons,
        createdAt: new Date().toISOString(),
        logs: [{ at: new Date().toISOString(), step: reasons.length ? "停待复核" : "预占", note: reasons.length ? reasons.join("；") : `按索位「${input.position}」预占 ${reqLength}cm，库存待裁切后核销` }]
      };
      ledger.operations.unshift(op);
      await saveLedger(ledger);
      return send(res, 201, op);
    }
    const cut = url.pathname.match(/^\/api\/operations\/([^/]+)\/cut$/);
    if (cut && req.method === "POST") {
      const ledger = await loadLedger();
      const op = ledger.operations.find(o => o.code === cut[1]);
      if (!op) return send(res, 404, { error: "op_not_found", message: "操作单不存在" });
      if (op.status !== "预占中") return send(res, 409, { error: "op_not_reserved", message: "仅预占中的领料可登记裁切" });
      const input = await body(req);
      const cutLength = Number(input.cutLength);
      const remainingLength = Number(input.remainingLength);
      const joints = Number(input.joints || 0);
      if (!(cutLength > 0) || !(remainingLength >= 0) || !(joints >= 0) || !input.operator) {
        return send(res, 400, { error: "invalid_input", message: "实裁长度、登记残长、接头数、裁切人必填" });
      }
      const roll = ledger.rolls.find(r => r.code === op.rollCode);
      const bookRemaining = round2(roll.remainingLength - cutLength);
      const deviation = round2(Math.abs(bookRemaining - remainingLength));
      const rg005 = ruleOn(ledger, "RG-005");
      const threshold = rg005 ? Number(rg005.params.maxDeviationCm ?? 0.5) : Infinity;
      op.cut = {
        cutLength, remainingLength, joints,
        operator: String(input.operator).trim(),
        bookRemaining, deviation,
        estimateDeviation: round2(cutLength - op.reqLength),
        at: new Date().toISOString()
      };
      if (deviation > threshold) {
        op.status = "待复核";
        op.reasons = [`残长偏差 ${deviation}cm 超阈值 ${threshold}cm（账面余 ${bookRemaining}cm，登记残长 ${remainingLength}cm）`];
      } else {
        op.status = "待确认";
        op.reasons = [];
      }
      op.logs.push({ at: new Date().toISOString(), step: "裁切", note: `实裁 ${cutLength}cm · 残长 ${remainingLength}cm · 接头 ${joints} · 偏差 ${deviation}cm` });
      await saveLedger(ledger);
      return send(res, 200, op);
    }
    const confirm = url.pathname.match(/^\/api\/operations\/([^/]+)\/confirm$/);
    if (confirm && req.method === "POST") {
      const ledger = await loadLedger();
      const op = ledger.operations.find(o => o.code === confirm[1]);
      if (!op) return send(res, 404, { error: "op_not_found", message: "操作单不存在" });
      if (op.status !== "待确认") return send(res, 409, { error: "op_not_pending_confirm", message: "仅待确认的裁切可核销" });
      const input = await body(req);
      if (!input.confirmer) return send(res, 400, { error: "invalid_input", message: "确认人必填" });
      if (ruleOn(ledger, "RG-006") && opActors(op).includes(String(input.confirmer).trim())) {
        return send(res, 409, { error: "self_confirm_forbidden", message: "本人不能确认，需他人核销" });
      }
      const roll = ledger.rolls.find(r => r.code === op.rollCode);
      roll.remainingLength = op.cut.remainingLength;
      roll.joints = (roll.joints || 0) + op.cut.joints;
      roll.logs ||= [];
      roll.logs.push({ at: new Date().toISOString(), step: "核销", note: `${op.code} 核销，余额 ${roll.remainingLength}cm · 累计接头 ${roll.joints}` });
      op.status = "已核销";
      op.confirmer = String(input.confirmer).trim();
      op.logs.push({ at: new Date().toISOString(), step: "确认", note: `${op.confirmer} 确认核销，余额写为 ${roll.remainingLength}cm` });
      await saveLedger(ledger);
      return send(res, 200, op);
    }
    const review = url.pathname.match(/^\/api\/operations\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      const ledger = await loadLedger();
      const op = ledger.operations.find(o => o.code === review[1]);
      if (!op) return send(res, 404, { error: "op_not_found", message: "操作单不存在" });
      if (op.status !== "待复核") return send(res, 409, { error: "op_not_pending_review", message: "仅待复核的单据可复核" });
      const input = await body(req);
      if (!input.reviewer || !["放行", "退回"].includes(input.decision)) {
        return send(res, 400, { error: "invalid_input", message: "复核人必填，结论为放行或退回" });
      }
      if (ruleOn(ledger, "RG-006") && opActors(op).includes(String(input.reviewer).trim())) {
        return send(res, 409, { error: "self_review_forbidden", message: "本人不能复核本人单据" });
      }
      const reviewer = String(input.reviewer).trim();
      if (input.decision === "退回") {
        op.status = "已取消";
        op.logs.push({ at: new Date().toISOString(), step: "复核退回", note: `${reviewer} 退回${input.note ? "：" + input.note : ""}，预占释放` });
      } else if (op.cut) {
        op.status = "待确认";
        op.review = { reviewer, note: input.note || "", at: new Date().toISOString() };
        op.logs.push({ at: new Date().toISOString(), step: "复核放行", note: `${reviewer} 放行，转待确认` });
      } else {
        const occupied = ledger.operations.some(o => o !== op && o.rollCode === op.rollCode && OPEN_STATUSES.includes(o.status));
        if (occupied && ruleOn(ledger, "RG-004")) {
          return send(res, 409, { error: "roll_occupied", message: "该卷已有其他未完领料，无法放行" });
        }
        op.status = "预占中";
        op.review = { reviewer, note: input.note || "", at: new Date().toISOString() };
        op.logs.push({ at: new Date().toISOString(), step: "复核放行", note: `${reviewer} 放行，恢复预占` });
      }
      await saveLedger(ledger);
      return send(res, 200, op);
    }
    const rulePatch = url.pathname.match(/^\/api\/rules\/([^/]+)$/);
    if (rulePatch && req.method === "PATCH") {
      const ledger = await loadLedger();
      const rule = ledger.rules.find(r => r.code === rulePatch[1]);
      if (!rule) return send(res, 404, { error: "rule_not_found", message: "规则不存在" });
      const input = await body(req);
      if (typeof input.enabled === "boolean") rule.enabled = input.enabled;
      if (input.params && typeof input.params === "object") rule.params = { ...rule.params, ...input.params };
      await saveLedger(ledger);
      return send(res, 200, rule);
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
