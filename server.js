import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS } from "./rules.js";
import { registerRoll, balanceView } from "./rolls.js";
import { createRequisition, reviewRequisition, registerCutting, reviewCutting, pendingView, occupancyView } from "./operations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "model-rigging-calibration.json");
const coilDbPath = join(__dirname, "data", "coil-ledger.json");
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

const coilSeed = {
  rolls: [
    {
      id: "R-001", batchNo: "B2026-041", material: "蜡线",
      totalLength: 6000, remainingLength: 6000, humidity: 11.5, expiryDate: "2027-06-30",
      status: "在库", currentRequisitionId: null, createdBy: "周宁",
      createdAt: "2026-09-20T08:00:00.000Z",
      logs: [{ at: "2026-09-20T08:00:00.000Z", step: "开卷登记", note: "批号 B2026-041，6000cm，湿度 11.5%，有效期至 2027-06-30" }],
    },
    {
      id: "R-002", batchNo: "B2026-042", material: "麻线",
      totalLength: 4500, remainingLength: 4500, humidity: 12.1, expiryDate: "2027-03-31",
      status: "在库", currentRequisitionId: null, createdBy: "周宁",
      createdAt: "2026-09-21T08:00:00.000Z",
      logs: [{ at: "2026-09-21T08:00:00.000Z", step: "开卷登记", note: "批号 B2026-042，4500cm，湿度 12.1%，有效期至 2027-03-31" }],
    },
  ],
  requisitions: [],
};
async function loadCoilDb() {
  if (!existsSync(coilDbPath)) {
    await mkdir(dirname(coilDbPath), { recursive: true });
    await writeFile(coilDbPath, JSON.stringify(coilSeed, null, 2));
  }
  return JSON.parse(await readFile(coilDbPath, "utf8"));
}
async function saveCoilDb(db) { await writeFile(coilDbPath, JSON.stringify(db, null, 2)); }
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
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">模型、帆索任务和校准记录串联 · <a href="/coils">卷材开卷与余量核销</a></div></div><button id="reload">刷新</button></header>
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
      if (!res.ok) throw new Error(data.error || '请求失败');
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
</body>
</html>`;
}

function coilPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>卷材开卷与余量核销</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.warn { background:var(--warn); }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .panel { margin-bottom:14px; } table { width:100%; border-collapse:collapse; font-size:14px; } th,td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); } th { color:var(--muted); font-weight:400; }
    .pending-item { display:flex; justify-content:space-between; align-items:center; gap:10px; border:1px solid var(--line); border-radius:6px; padding:10px; margin-bottom:8px; }
    .pending-item .actions { display:flex; gap:8px; } .pending-item button { padding:6px 10px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>卷材开卷与余量核销</h1><div class="meta">批号 · 长度 · 湿度 · 有效期；预占不扣库存，裁切后核销 · <a href="/">帆索校准</a></div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="rollForm"><h2>卷材开卷登记</h2>
        <label>批号</label><input name="batchNo" required>
        <label>材料</label><input name="material" value="蜡线">
        <label>登记长度(cm)</label><input name="totalLength" type="number" step="0.1" min="0.1" required>
        <label>湿度(%)</label><input name="humidity" type="number" step="0.1" min="0" required>
        <label>有效期</label><input name="expiryDate" type="date" required>
        <label>操作人</label><input name="operator" required>
        <button>开卷登记</button>
      </form>
      <form id="reqForm" style="margin-top:14px"><h2>领料预占</h2>
        <label>选择卷材</label><select name="rollId" id="rollSelect"></select>
        <label>索位</label><input name="position" placeholder="如：前桅侧支索" required>
        <label>索位长度(cm)</label><input name="requiredLength" type="number" step="0.1" min="0.1" required>
        <label>领料人</label><input name="operator" required>
        <button>预占（库存先不扣）</button>
      </form>
      <form id="cutForm" style="margin-top:14px"><h2>裁切登记</h2>
        <label>预占中领料单</label><select name="reqId" id="reqSelect"></select>
        <label>实报残长(cm)</label><input name="actualRemaining" type="number" step="0.1" min="0" required>
        <label>接头数</label><input name="joints" type="number" min="0" value="0">
        <label>裁切人</label><input name="operator" required>
        <button>登记并核销</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel"><h2>余额</h2><table id="balance"></table></div>
      <div class="panel"><h2>待处理</h2><div id="pending"></div></div>
      <div class="panel"><h2>占用模型</h2><table id="occupancy"></table></div>
      <div class="panel"><h2>卷材档案</h2><div class="grid" id="rolls"></div></div>
      <div class="panel"><h2>领料单</h2><div id="reqs"></div></div>
    </section>
  </main>
  <script>
    let data = { rolls: [], requisitions: [], balance: { rows: [] }, pending: [], occupancy: [], limits: {} };
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || '请求失败');
      return body;
    }
    async function run(fn) { try { await fn(); await load(); } catch (e) { alert(e.message); } }
    function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])); }
    function render() {
      const occ = data.occupancy.filter(o => o.occupiedBy).length;
      document.querySelector('#stats').innerHTML =
        '<div class="stat"><span>卷材数</span><strong>'+data.rolls.length+'</strong></div>'+
        '<div class="stat"><span>总余额(cm)</span><strong>'+data.balance.totalRemaining+'</strong></div>'+
        '<div class="stat"><span>占用中</span><strong>'+occ+'</strong></div>'+
        '<div class="stat"><span>待处理</span><strong>'+data.pending.length+'</strong></div>';
      document.querySelector('#balance').innerHTML = '<tr><th>批号</th><th>材料</th><th>登记长度</th><th>已核销</th><th>余额</th><th>状态</th></tr>'+
        data.balance.rows.map(r => '<tr><td>'+esc(r.batchNo)+'</td><td>'+esc(r.material)+'</td><td>'+r.totalLength+'</td><td>'+r.used+'</td><td><b>'+r.remainingLength+'</b></td><td>'+r.status+'</td></tr>').join('');
      document.querySelector('#pending').innerHTML = data.pending.length ? data.pending.map((p, i) =>
        '<div class="pending-item"><div><b>'+p.kind+'</b> '+esc(p.id)+' · '+esc(p.batchNo)+' · '+esc(p.position)+'<div class="meta warn">'+esc(p.reason)+' · 操作人 '+esc(p.operator)+'</div></div>'+
        '<div class="actions"><button data-ok="'+i+'">通过</button><button class="warn" data-no="'+i+'">驳回</button></div></div>').join('') : '<div class="meta">暂无待处理</div>';
      document.querySelector('#occupancy').innerHTML = '<tr><th>批号</th><th>状态</th><th>卷余</th><th>占用</th><th>可用</th></tr>'+
        data.occupancy.map(o => '<tr><td>'+esc(o.batchNo)+'</td><td>'+o.status+'</td><td>'+o.remainingLength+'</td><td>'+(o.occupiedBy ? esc(o.occupiedBy.position)+' · '+o.occupiedBy.requiredLength+'cm · '+esc(o.occupiedBy.operator)+'（'+o.occupiedBy.status+'）' : '<span class="meta">空闲</span>')+'</td><td><b>'+o.available+'</b></td></tr>').join('');
      document.querySelector('#rolls').innerHTML = data.rolls.map(r =>
        '<article class="card"><h3>'+esc(r.batchNo)+' <span class="pill">'+r.status+'</span></h3>'+
        '<div class="meta">'+esc(r.material)+' · 登记 '+r.totalLength+'cm · 余 <b>'+r.remainingLength+'</b>cm</div>'+
        '<div class="meta">湿度 '+r.humidity+'%（允许 '+data.limits.humidityMin+'~'+data.limits.humidityMax+'%） · 有效期至 '+esc(r.expiryDate)+'</div>'+
        '<div class="logs meta">'+r.logs.slice(-5).map(l => '<div>'+l.step+'：'+esc(l.note)+'</div>').join('')+'</div></article>').join('');
      document.querySelector('#reqs').innerHTML = data.requisitions.length ? data.requisitions.map(q => {
        const roll = data.rolls.find(r => r.id === q.rollId) || {};
        const cut = q.cutting ? ' · 裁切：残长 '+q.cutting.actualRemaining+'cm，接头 '+q.cutting.joints+' 个，偏差 '+q.cutting.deviation+'cm（'+q.cutting.status+'）' : '';
        return '<div class="pending-item"><div><b>'+esc(q.id)+'</b> <span class="pill">'+q.status+'</span> '+esc(roll.batchNo)+' · '+esc(q.position)+' · '+q.requiredLength+'cm · '+esc(q.operator)+'<div class="meta">'+q.logs.map(l => l.step+'：'+esc(l.note)).join('；')+esc(cut)+'</div></div></div>';
      }).join('') : '<div class="meta">暂无领料单</div>';
      document.querySelector('#rollSelect').innerHTML = data.rolls.filter(r => r.status !== '用完').map(r => '<option value="'+r.id+'">'+esc(r.batchNo)+' · '+esc(r.material)+' · 余 '+r.remainingLength+'cm</option>').join('');
      document.querySelector('#reqSelect').innerHTML = data.requisitions.filter(q => q.status === '预占中').map(q => '<option value="'+q.id+'">'+esc(q.id)+' · '+esc(q.position)+' · '+q.requiredLength+'cm</option>').join('');
      document.querySelectorAll('[data-ok]').forEach(b => b.onclick = () => review(data.pending[b.dataset.ok], '通过'));
      document.querySelectorAll('[data-no]').forEach(b => b.onclick = () => review(data.pending[b.dataset.no], '驳回'));
    }
    function review(p, decision) {
      const reviewer = prompt(decision + ' · 复核人姓名（本人不能确认）');
      if (!reviewer) return;
      const path = p.kind === '裁切复核' ? '/api/coils/requisitions/'+p.id+'/cutting/review' : '/api/coils/requisitions/'+p.id+'/review';
      run(() => api(path, { method:'POST', body: JSON.stringify({ reviewer, decision }) }));
    }
    async function load() { data = await api('/api/coils'); render(); }
    document.querySelector('#rollForm').onsubmit = e => { e.preventDefault(); run(() => api('/api/coils/rolls', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) }).then(() => e.target.reset())); };
    document.querySelector('#reqForm').onsubmit = e => { e.preventDefault(); run(() => api('/api/coils/requisitions', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) }).then(() => e.target.reset())); };
    document.querySelector('#cutForm').onsubmit = e => { e.preventDefault(); run(() => api('/api/coils/requisitions/'+new FormData(e.target).get('reqId')+'/cutting', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) }).then(() => e.target.reset())); };
    document.querySelector('#reload').onclick = load;
    load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/coils") return html(res, coilPage());
    if (url.pathname.startsWith("/api/coils")) {
      const cdb = await loadCoilDb();
      try {
        if (req.method === "GET" && url.pathname === "/api/coils") {
          return send(res, 200, { rolls: cdb.rolls, requisitions: cdb.requisitions, balance: balanceView(cdb), pending: pendingView(cdb), occupancy: occupancyView(cdb), limits: LIMITS });
        }
        if (req.method === "POST" && url.pathname === "/api/coils/rolls") {
          const input = await body(req);
          const roll = registerRoll(cdb, input, input.operator);
          await saveCoilDb(cdb);
          return send(res, 201, roll);
        }
        if (req.method === "POST" && url.pathname === "/api/coils/requisitions") {
          const req2 = createRequisition(cdb, await body(req));
          await saveCoilDb(cdb);
          return send(res, 201, req2);
        }
        const cut = url.pathname.match(/^\/api\/coils\/requisitions\/([^/]+)\/cutting$/);
        if (cut && req.method === "POST") {
          const req2 = registerCutting(cdb, cut[1], await body(req));
          await saveCoilDb(cdb);
          return send(res, 201, req2);
        }
        const cutReview = url.pathname.match(/^\/api\/coils\/requisitions\/([^/]+)\/cutting\/review$/);
        if (cutReview && req.method === "POST") {
          const req2 = reviewCutting(cdb, cutReview[1], await body(req));
          await saveCoilDb(cdb);
          return send(res, 200, req2);
        }
        const review = url.pathname.match(/^\/api\/coils\/requisitions\/([^/]+)\/review$/);
        if (review && req.method === "POST") {
          const req2 = reviewRequisition(cdb, review[1], await body(req));
          await saveCoilDb(cdb);
          return send(res, 200, req2);
        }
        return send(res, 404, { error: "not_found" });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
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
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
