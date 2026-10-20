#!/usr/bin/env node
/**
 * arrivals_to_jxc.mjs — 到货确认 → 回写 10_订货台账 + 生成 04_入库流水
 *
 * 第二阶段（2026-10-20）：
 *  1. 读到货确认 sheet（源表 worksheet 15）
 *  2. 回写 10_订货台账：状态=已到货、到货日期、到货数量=实收、分站结果=门店
 *  3. 站级明确时（门店能对上具体站，如"富县东"），写 04_入库流水
 *     —— 入库流水的 商品名称/单位/供货商/入库单价/入库金额/商品规格 全是
 *        XLOOKUP([@条码], '01_商品字典'![条码], …) 的 Formula，
 *        所以只需写 Bg条码 + Bn日期 + Bo入库油站 + Bp入库数量 四个字段即可自动带出。
 *     门店只到服务区（如"白河"）→ 无法确定东/西，标记「待分站」，不写流水。
 *
 * 幂等：
 *  - 订货台账：靠源键(供货商|日期|服务区|商品|数量|单价)定位待更新记录
 *  - 入库流水：无源键字段，改用可写的 Bj「填写ID」存 ARRIVE|<门店>|<商品>|<实收>|<确认时间>
 *
 * 用法：node arrivals_to_jxc.mjs [--apply]
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API = 'https://mcp-center.wps.cn/skill_hub/api/v1/tool';
const DINGHUO_FID = 'R7rXsbq891M9mqCkoPYs1xBTT4HDGgJty';
const JXC_FID = 'ckOYsgKoz4nh';
const ARRIVE_SHEET_ID = 15;   // 到货确认（源表）
const ORDER_SHEET = 37;        // 10_订货台账
const IN_SHEET = 10;           // 04_入库流水
const DICT_SHEET = 7;          // 01_商品字典
const APPLY = process.argv.includes('--apply');
const BATCH = 50;

function readToken() {
  const envTok = process.env.JXC_TOKEN || process.env.KDOCS_TOKEN;
  if (envTok) return envTok.trim();
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'wps_token.txt'), 'utf8');
    const m = raw.match(/[A-Za-z0-9+/]{80,}={0,2}/);
    if (m) return m[0];
  } catch (_) { }
  return '';
}
const TOKEN = readToken();
if (!TOKEN) { console.error('缺少 JXC_TOKEN/KDOCS_TOKEN'); process.exit(1); }

function callTool(tool, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ args, tool });
    const u = new URL(API);
    const req = https.request({
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': 'Bearer ' + TOKEN,
        'Accept': 'text/event-stream'
      }
    }, res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', c => out += c);
      res.on('end', () => {
        let json = null;
        for (const l of out.split(/\r?\n/)) {
          if (l.indexOf('data:') === 0) {
            const s = l.slice(5).trim();
            if (s.charAt(0) === '{') { try { json = JSON.parse(s); break; } catch (_) { } }
          }
        }
        if (!json) {
          const s = out.indexOf('{'), e = out.lastIndexOf('}');
          if (s >= 0 && e > s) { try { json = JSON.parse(out.slice(s, e + 1)); } catch (_) { } }
        }
        if (json) resolve(json); else reject(new Error('响应非 JSON'));
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.write(payload); req.end();
  });
}

function unwrap(j) {
  const d = (j && j.data) || {};
  if (d.data !== undefined) return d.data;
  if (d.detail !== undefined) return d.detail;
  return d;
}
const s = v => (v === undefined || v === null) ? '' : String(v).trim();
function num(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(String(v).replace(/[,\s￥¥]/g, ''));
  return isNaN(n) ? 0 : n;
}
function normDate(v) {
  if (v === undefined || v === null || v === '') return '';
  const t = String(v).trim();
  const m = t.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (m) return m[1] + '/' + String(m[2]).padStart(2, '0') + '/' + String(m[3]).padStart(2, '0');
  return t.slice(0, 10).replace(/-/g, '/');
}
/** 商品名归一：去【】与末尾括号内容、去空格 */
function normGoods(v) {
  let t = s(v);
  t = t.replace(/【[^】]*】/g, '');
  t = t.replace(/[（(][^）)]*[）)]\s*$/g, '');
  return t.replace(/\s+/g, '').trim();
}
/** 服务区归一 */
function normArea(v) {
  return s(v).replace(/加油站/g, '').replace(/[（(]\s*高速\s*[）)]/g, '').replace(/服务区|停车区/g, '').replace(/站$/, '').replace(/\s+/g, '');
}
/** 服务区「主体」：再剥掉方向字，用于「富县」与「富县东/西」互相匹配 */
function areaBase(v) {
  return normArea(v).replace(/[东南西北]/g, '');
}

/* ---------- 读源表到货确认 ---------- */
async function readArrivals() {
  const j = await callTool('sheet.get_range_data', {
    file_id: DINGHUO_FID, worksheet_id: ARRIVE_SHEET_ID,
    range: { rowFrom: 0, rowTo: 500, colFrom: 0, colTo: 12 }
  });
  if (j.code !== 0) throw new Error('读 到货确认 失败 code=' + j.code + ' ' + j.message);
  const cells = (unwrap(j).rangeData) || [];
  const g = {};
  for (const c of cells) {
    if (!g[c.rowFrom]) g[c.rowFrom] = {};
    g[c.rowFrom][c.colFrom] = (c.cellText !== undefined && c.cellText !== null) ? c.cellText : c.originalCellValue;
  }
  const out = [];
  for (const r of Object.keys(g).map(Number).sort((a, b) => a - b)) {
    if (r === 0) continue;
    const row = g[r] || {};
    const confirmTime = s(row[0]);
    const area = s(row[1]);
    const store = s(row[2]);
    const supplier = s(row[3]);
    const goods = s(row[4]);
    const spec = s(row[5]);
    const unit = s(row[6]);
    const should = num(row[7]);
    const actual = num(row[8]);
    const diff = row[9] === undefined ? (actual - should) : num(row[9]);
    const reason = s(row[10]);
    if (!area || !goods) continue;
    out.push({
      row: r + 1, confirmTime, date: normDate(confirmTime), area, store,
      supplier, goods, spec, unit, should, actual, diff, reason
    });
  }
  return out;
}

/* ---------- 读金小存某表全部记录 ---------- */
async function readAll(sheetId, fields) {
  const out = [];
  let token = '', pages = 0;
  do {
    const args = { file_id: JXC_FID, sheet_id: sheetId, page_size: 1000 };
    if (fields) args.fields = fields;
    if (token) args.page_token = token;
    const j = await callTool('dbsheet.records_list', args);
    if (j.code !== 0) throw new Error('records_list sheet=' + sheetId + ' code=' + j.code + ' ' + j.message);
    const d = unwrap(j);
    for (const r of (d.records || [])) {
      let f = {};
      try { f = JSON.parse(r.fields || '{}'); } catch (_) { }
      out.push({ id: r.id, fields: f });
    }
    token = d.page_token || '';
    pages++;
  } while (token && pages < 20);
  return out;
}

/* ---------- 站点短名集合（用于判断门店是否到站级） ---------- */
function buildStationSet(siteRecords) {
  const shortSet = new Set();
  for (const r of siteRecords) {
    const nm = s(r.fields['站点名称']);
    if (!nm) continue;
    // 全称 → 短名：去掉"服务区/停车区""加油站""（高速）"，并把 东站→东
    const short = nm.replace(/[（(]\s*高速\s*[）)]/g, '').replace(/加油站/g, '')
      .replace(/服务区|停车区/g, '').replace(/站$/, '').replace(/\s+/g, '');
    shortSet.add(short);
  }
  return shortSet;
}

/* ---------- 主流程 ---------- */
(async () => {
  console.log('== 到货确认 → 订货台账/入库流水 ' + (APPLY ? '(APPLY)' : '(DRY-RUN)'));

  const arrivals = await readArrivals();
  console.log('[1/5] 到货确认 ' + arrivals.length + ' 行');

  const orders = await readAll(ORDER_SHEET);
  console.log('[2/5] 10_订货台账 ' + orders.length + ' 行');

  const sites = await readAll(8);
  const stationShort = buildStationSet(sites);
  console.log('[3/5] 站点档案 ' + sites.length + ' 个，短名 ' + stationShort.size + ' 个');

  const dictRecs = await readAll(DICT_SHEET);
  // 商品名 → 条码
  const dictExact = new Map(), dictNorm = new Map();
  for (const r of dictRecs) {
    const name = s(r.fields['商品名称']);
    const bar = s(r.fields['条码']);
    if (!name || !bar) continue;
    if (!dictExact.has(name)) dictExact.set(name, bar);
    const nk = normGoods(name);
    if (nk && !dictNorm.has(nk)) dictNorm.set(nk, bar);
  }
  console.log('      商品字典 ' + dictRecs.length + ' 条，可查名称 ' + dictExact.size + ' 个');

  const inRows = await readAll(IN_SHEET, ['填写ID']);
  const inKeys = new Set();
  for (const r of inRows) { const k = s(r.fields['填写ID']); if (k) inKeys.add(k); }
  console.log('[4/5] 04_入库流水 ' + inRows.length + ' 行，已带幂等键 ' + inKeys.size + ' 个');

  /* ---------- 匹配 + 决策 ---------- */
  const orderUpdates = [];   // {id, fields}
  const inRecords = [];      // 待写入库流水
  const pending = [];        // 待分站
  const unmatched = [];      // 找不到订货单
  const noBarcode = [];      // 查到站但商品无条码

  const updatedIds = new Set();

  for (const a of arrivals) {
    const aArea = areaBase(a.area);
    const aGoods = normGoods(a.goods);

    // 1) 找同 供货商+服务区主体+商品 的订货记录（**不限状态**，便于判定"已处理"）
    const cands = orders.filter(o => {
      if (s(o.fields['供货商']) !== a.supplier) return false;
      if (areaBase(o.fields['服务区']) !== aArea) return false;
      return normGoods(o.fields['商品名称']) === aGoods;
    });
    if (!cands.length) { unmatched.push(a); continue; }

    // 2) 幂等：已有「已到货 + 到货数量吻合 + 到货日期吻合」→ 已处理，跳过
    const already = cands.find(c => s(c.fields['状态']) === '已到货'
      && Math.abs(num(c.fields['到货数量']) - a.actual) < 0.001
      && normDate(c.fields['到货日期']) === a.date);
    if (already) continue;

    // 3) 目标：未到货里日期最早的；都被本次占用则跳过
    const openOnes = cands.filter(c => s(c.fields['状态']) !== '已到货' && !updatedIds.has(c.id))
      .sort((x, y) => String(x.fields['日期'] || '').localeCompare(String(y.fields['日期'] || '')));
    const hit = openOnes[0];
    if (!hit) continue;
    updatedIds.add(hit.id);

    // 2) 回写订货台账
    const nf = {
      '状态': '已到货',
      '到货日期': a.date,
      '到货数量': a.actual,
      '分站结果': a.store
    };
    orderUpdates.push({ id: hit.id, fields: nf });
    hit.fields['状态'] = '已到货'; // 防同一批重复匹配

    // 3) 定站：优先用订货记录自己写的站级（如"富县西"），其次用到货确认的门店
    const hitAreaShort = normArea(hit.fields['服务区']);
    const storeShort = normArea(a.store);
    let station = '';
    if (stationShort.has(hitAreaShort)) station = hitAreaShort;
    else if (stationShort.has(storeShort)) station = storeShort;
    if (!station) {
      pending.push({
        arrival: a, orderId: hit.id,
        reason: '订货与到货都只到服务区(' + (s(hit.fields['服务区']) || a.store) + ')，无法确定东/西'
      });
      continue;
    }

    // 4) 查条码
    let bar = dictExact.get(a.goods) || dictNorm.get(aGoods);
    if (!bar) {
      // 模糊：字典名包含到货名，或反之，唯一才用
      const loose = [];
      for (const [k, v] of dictNorm) {
        if (k.indexOf(aGoods) >= 0 || aGoods.indexOf(k) >= 0) loose.push(v);
      }
      if (new Set(loose).size === 1) bar = loose[0];
    }
    if (!bar) { noBarcode.push(a); continue; }

    // 5) 入库流水（条码/日期/油站/数量 → 其余 Formula 自动算）
    const key = 'ARRIVE|' + station + '|' + aGoods + '|' + a.actual + '|' + a.confirmTime;
    if (inKeys.has(key)) continue;
    inKeys.add(key);
    inRecords.push({
      fields: {
        '条码': bar,
        '日期': a.date,
        '入库油站': station,
        '入库数量': a.actual,
        '填写ID': key
      },
      _meta: a
    });
  }

  console.log('[5/5] 匹配结果：');
  console.log('      回写订货台账 ' + orderUpdates.length + ' 条');
  console.log('      可写入库流水 ' + inRecords.length + ' 条（站级明确）');
  console.log('      待分站 ' + pending.length + ' 条');
  console.log('      订货单未匹配 ' + unmatched.length + ' 条');
  console.log('      商品无条码 ' + noBarcode.length + ' 条');

  // 库内累计待分站：已到货，但分站结果只是服务区（没有东/西），需要业务补分站
  const pendingInDb = orders.filter(o => s(o.fields['状态']) === '已到货'
    && !stationShort.has(normArea(o.fields['分站结果'])));
  console.log('      ★ 库内累计待分站 ' + pendingInDb.length + ' 条（已到货但分站结果只到服务区）');
  const pArea = {};
  for (const o of pendingInDb) { const k = s(o.fields['分站结果']) || '(空)'; pArea[k] = (pArea[k] || 0) + 1; }
  if (pendingInDb.length) console.log('        分布：' + JSON.stringify(pArea));

  if (inRecords.length) {
    console.log('      入库样例：');
    for (const r of inRecords.slice(0, 6)) {
      console.log('        ' + r.fields['日期'] + ' ' + r.fields['入库油站'] + ' 条码=' +
        r.fields['条码'] + ' 数量=' + r.fields['入库数量'] + '  (' + r._meta.goods + ')');
    }
  }
  if (pending.length) {
    console.log('      待分站样例：');
    for (const p of pending.slice(0, 5)) {
      console.log('        ' + p.arrival.confirmTime + ' ' + p.arrival.store + ' ' +
        p.arrival.goods + ' 实收' + p.arrival.actual + ' — ' + p.reason);
    }
  }
  if (noBarcode.length) {
    console.log('      无条码样例：');
    for (const n of noBarcode.slice(0, 5)) console.log('        ' + n.goods);
  }

  if (!APPLY) { console.log('\n(dry-run 结束，加 --apply 才会写入)'); return; }

  /* ---------- 执行 ---------- */
  let upd = 0;
  for (let i = 0; i < orderUpdates.length; i += BATCH) {
    const chunk = orderUpdates.slice(i, i + BATCH);
    const j = await callTool('dbsheet.update_records', {
      file_id: JXC_FID, sheet_id: ORDER_SHEET, records: chunk
    });
    if (j.code !== 0) { console.error('更新订货台账失败 code=' + j.code + ' ' + (j.message || '')); process.exit(2); }
    upd += chunk.length;
  }
  console.log('已更新订货台账 ' + upd + ' 条');

  let ins = 0;
  for (let i = 0; i < inRecords.length; i += BATCH) {
    const chunk = inRecords.slice(i, i + BATCH).map(r => ({ fields: r.fields }));
    const j = await callTool('dbsheet.create_records', {
      file_id: JXC_FID, sheet_id: IN_SHEET, records: chunk
    });
    if (j.code !== 0) { console.error('写入库流水失败 code=' + j.code + ' ' + (j.message || '')); process.exit(2); }
    ins += chunk.length;
  }
  console.log('已写入库流水 ' + ins + ' 条');
})().catch(e => { console.error('ERR=' + (e && e.message)); process.exit(2); });
