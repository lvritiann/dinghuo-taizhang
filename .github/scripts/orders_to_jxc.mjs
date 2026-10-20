#!/usr/bin/env node
/**
 * orders_to_jxc.mjs — 订货台账（金山在线表格）→ 金小存 10_订货台账（多维表）
 *
 * 设计要点（2026-10-20 定稿）：
 *  - 数据源 = 订货系统源表（在线表格 R7rXsbq891M9mqCkoPYs1xBTT4HDGgJty），
 *    与本地「供应商订货台账.xlsx」是同一文件的云端本体，**不依赖本地文件**。
 *  - 订货天生是**服务区级**（门店列写"白河""韩城"），而 04_入库流水 是站级（东/西），
 *    强行落站级会产生歧义 ⇒ 订货只落 10_订货台账（服务区级），
 *    等「到货确认」再分站，届时补 分站结果 并写 04_入库流水。
 *  - 幂等：源键 = 供货商|日期|服务区|商品名称|数量|单价；已存在的源键跳过，绝不重写。
 *
 * 用法：
 *   node orders_to_jxc.mjs            # dry-run，只统计不写
 *   node orders_to_jxc.mjs --apply    # 真正写入
 *
 * 环境变量：KDOCS_TOKEN（GitHub Actions 用 Secret）；缺省回退读 ./wps_token.txt
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API = 'https://mcp-center.wps.cn/skill_hub/api/v1/tool';
const DINGHUO_FID = 'R7rXsbq891M9mqCkoPYs1xBTT4HDGgJty'; // 订货系统源表
const JXC_FID = 'ckOYsgKoz4nh';                            // 金小存多维表
const ORDER_SHEET = 37;                                    // 10_订货台账
const APPLY = process.argv.includes('--apply');
const STATUS_INIT = '已下单';
const BATCH = 50;

/* ---------------- token ---------------- */
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
if (!TOKEN) { console.error('缺少 KDOCS_TOKEN'); process.exit(1); }

/* ---------------- kdocs 调用（SSE 解析） ---------------- */
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

/* ---------------- 读订货源表 ---------------- */
async function listSheets() {
  const j = await callTool('sheet.get_sheets_info', { file_id: DINGHUO_FID });
  if (j.code !== 0) throw new Error('get_sheets_info code=' + j.code + ' ' + j.message);
  const d = unwrap(j);
  return d.sheetsInfo || d.sheets || [];
}

async function readRange(sheetId, r0, r1, c0, c1) {
  const j = await callTool('sheet.get_range_data', {
    file_id: DINGHUO_FID, worksheet_id: sheetId,
    range: { rowFrom: r0, rowTo: r1, colFrom: c0, colTo: c1 }
  });
  if (j.code !== 0) throw new Error('get_range_data code=' + j.code + ' ' + j.message);
  const d = unwrap(j);
  return d.rangeData || [];
}

function toGrid(cells) {
  const g = {};
  for (const c of cells) {
    if (!g[c.rowFrom]) g[c.rowFrom] = {};
    g[c.rowFrom][c.colFrom] = (c.cellText !== undefined && c.cellText !== null) ? c.cellText : c.originalCellValue;
  }
  return g;
}

const ORDER_HEADER = ['日期', '门店', '商品名称', '规格', '单位', '数量'];

function isOrderSheet(hdr) {
  if (!hdr) return false;
  const norm = hdr.map(x => String(x === undefined || x === null ? '' : x).trim());
  return ORDER_HEADER.every((h, i) => norm[i] === h);
}

function normDate(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (m) return m[1] + '/' + String(m[2]).padStart(2, '0') + '/' + String(m[3]).padStart(2, '0');
  if (/^\d{5}$/.test(s)) { // Excel 序列号
    const dt = new Date((Number(s) - 25569) * 86400000);
    return dt.getUTCFullYear() + '/' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '/' + String(dt.getUTCDate()).padStart(2, '0');
  }
  return s;
}
function num(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(String(v).replace(/[,\s￥¥]/g, ''));
  return isNaN(n) ? 0 : n;
}
function s(v) { return v === undefined || v === null ? '' : String(v).trim(); }

/* ---------------- 读金小存已有源键 ---------------- */
async function existingKeys() {
  const set = new Set();
  let token = '', pages = 0;
  do {
    const args = { file_id: JXC_FID, sheet_id: ORDER_SHEET, page_size: 1000, fields: ['源键'] };
    if (token) args.page_token = token;
    const j = await callTool('dbsheet.records_list', args);
    if (j.code !== 0) throw new Error('records_list code=' + j.code + ' ' + j.message);
    const d = unwrap(j);
    for (const r of (d.records || [])) {
      let f = {};
      try { f = JSON.parse(r.fields || '{}'); } catch (_) { }
      if (f['源键']) set.add(String(f['源键']));
    }
    token = d.page_token || '';
    pages++;
  } while (token && pages < 20);
  return set;
}

/* ---------------- 主流程 ---------------- */
(async () => {
  console.log('== 订货台账 → 金小存 10_订货台账 ' + (APPLY ? '(APPLY)' : '(DRY-RUN)'));

  const sheets = await listSheets();
  console.log('[1/3] 源表工作表 ' + sheets.length + ' 个');

  const orderSheets = [];
  for (const sh of sheets) {
    const sid = sh.sheetId;
    const name = sh.sheetName;
    if (sid === undefined || sid === null) continue;
    const cells = await readRange(sid, 0, 0, 0, 5);
    const g = toGrid(cells);
    const hdr = g[0] ? [0, 1, 2, 3, 4, 5].map(c => g[0][c]) : null;
    if (isOrderSheet(hdr)) orderSheets.push({ id: sid, name, rows: (sh.rowTo || 0) + 1 });
  }
  console.log('      识别订单 sheet ' + orderSheets.length + ' 个：' +
    orderSheets.map(o => o.name + '(' + o.rows + ')').join('、'));

  const orders = [];
  for (const os of orderSheets) {
    if (os.rows <= 1) continue;
    const cells = await readRange(os.id, 0, Math.min(os.rows - 1, 5000), 0, 9);
    const g = toGrid(cells);
    const rows = Object.keys(g).map(Number).sort((a, b) => a - b);
    for (const r of rows) {
      if (r === 0) continue;
      const row = g[r] || {};
      const date = normDate(row[0]);
      const area = s(row[1]);
      const goods = s(row[2]);
      const qty = num(row[5]);
      const price = num(row[6]);
      if (!date || !area || !goods || !qty) continue;
      const key = [os.name, date, area, goods, qty, price].join('|');
      orders.push({
        supplier: os.name, date, area, goods,
        spec: s(row[3]), unit: s(row[4]), qty, price,
        amount: num(row[7]) || Math.round(qty * price * 100) / 100,
        key
      });
    }
  }
  console.log('[2/3] 解析订单明细 ' + orders.length + ' 行');

  const have = await existingKeys();
  const todo = orders.filter(o => !have.has(o.key));
  console.log('      库内已有源键 ' + have.size + ' 个；本次待写入 ' + todo.length + ' 行');

  if (!todo.length) { console.log('== 无新增，结束'); return; }

  console.log('      样例：');
  for (const o of todo.slice(0, 5)) {
    console.log('        ' + o.date + ' | ' + o.supplier + ' | ' + o.area + ' | ' +
      o.goods + ' x' + o.qty + ' @' + o.price + ' = ' + o.amount);
  }

  if (!APPLY) { console.log('\n(dry-run 结束，加 --apply 才会写入)'); return; }

  let written = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const records = chunk.map(o => ({
      fields: {
        '日期': o.date,
        '供货商': o.supplier,
        '服务区': o.area,
        '商品名称': o.goods,
        '规格': o.spec,
        '单位': o.unit,
        '数量': o.qty,
        '单价': o.price,
        '金额': o.amount,
        '状态': STATUS_INIT,
        '源键': o.key
      }
    }));
    const j = await callTool('dbsheet.create_records', {
      file_id: JXC_FID, sheet_id: ORDER_SHEET, records
    });
    if (j.code !== 0) {
      console.error('写入失败（已成功 ' + written + ' 条）：code=' + j.code + ' ' + (j.message || ''));
      process.exit(2);
    }
    written += chunk.length;
  }
  console.log('[3/3] 已写入 ' + written + ' 条');
})().catch(e => { console.error('ERR=' + (e && e.message)); process.exit(2); });
