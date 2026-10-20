#!/usr/bin/env node
/**
 * sku_to_jxc.mjs — 销售SKU明细中转表 → 金小存 05_出库流水（云端版）
 *
 * 替代本地 sync_sales.py + WorkBuddy automation，全程 GitHub Actions，零本机依赖。
 *
 * 链路：站端 FeiyouSubmit → webhook → 中转表 Sheet1(A~K)  →  本脚本  →  05_出库流水
 *
 * 幂等：**不依赖中转表 L 列**（历史上从未写过），改为读 05_出库流水 现有记录，
 *       按 「日期|站点记录id|条码」 建键集合，已存在的跳过。与 sync_sales.py 口径一致。
 *
 * 列映射（已逐列核对）：
 *   A日期 B站点 C方向 D条码 E品名 F规格 G数量 H金额 I成本 J毛利 K归类 L同步标记
 *
 * 用法：node sku_to_jxc.mjs [--apply]
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API = 'https://mcp-center.wps.cn/skill_hub/api/v1/tool';
const TRANSFER_FID = 'q8bXx7WFfxMaUtk3ZkSRxxfxTQPoSUMBv'; // 销售SKU明细中转表（在线表格）
const JXC_FID = 'ckOYsgKoz4nh';
const SITE_SHEET = 8;
const OUT_SHEET = 11;
const OUT_TYPE = '销售';
const BATCH = 50;
const READ_ROWS = 500;   // 中转表每批读取行数
const APPLY = process.argv.includes('--apply');

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

/* ---------- 站点名归一（与 sync_sales.py 完全一致） ---------- */
function normSite(v) {
  if (v === undefined || v === null) return '';
  let t = String(v).replace(/[（(]\s*高速\s*[）)]/g, '').replace(/加油站/g, '');
  return t.replace(/\s+/g, '').trim();
}
function tightSite(v) {
  return normSite(v).replace(/服务区/g, '').replace(/停车区/g, '').replace(/站$/, '');
}
const DIR_OV = { '南/东': '东', '北/西': '西', '南东': '东', '北西': '西', '东区': '东', '西区': '西', '南区': '南', '北区': '北' };
function extractDir(area) {
  if (!area) return '';
  const a = String(area).replace(/\s+/g, '');
  if (DIR_OV[a]) return DIR_OV[a];
  const ds = [];
  for (const ch of a) if ('东南西北'.indexOf(ch) >= 0) ds.push(ch);
  return ds.length === 1 ? ds[0] : '';
}
function normDate(v) {
  if (v === undefined || v === null || v === '') return '';
  const t = String(v).trim();
  const m = t.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (m) return m[1] + '/' + String(m[2]).padStart(2, '0') + '/' + String(m[3]).padStart(2, '0');
  if (/^\d{5}$/.test(t)) {
    const dt = new Date((Number(t) - 25569) * 86400000);
    return dt.getUTCFullYear() + '/' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '/' + String(dt.getUTCDate()).padStart(2, '0');
  }
  return t.slice(0, 10);
}
function num(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(String(v).replace(/[,\s¥￥]/g, ''));
  return isNaN(n) ? 0 : n;
}

/* ---------- 读中转表（分批） ---------- */
async function readTransfer() {
  const info = await callTool('sheet.get_sheets_info', { file_id: TRANSFER_FID });
  if (info.code !== 0) throw new Error('get_sheets_info code=' + info.code + ' ' + info.message);
  const si = (unwrap(info).sheetsInfo) || [];
  if (!si.length) throw new Error('中转表无工作表');
  const sh = si[0];
  const lastRow = (sh.rowTo === undefined ? 0 : sh.rowTo) + 1;  // 1-based 行数
  console.log('      中转表 ' + sh.sheetName + ' 共 ' + lastRow + ' 行');

  const rows = [];
  for (let r0 = 0; r0 < lastRow; r0 += READ_ROWS) {
    const r1 = Math.min(r0 + READ_ROWS - 1, lastRow - 1);
    const j = await callTool('sheet.get_range_data', {
      file_id: TRANSFER_FID, worksheet_id: sh.sheetId,
      range: { rowFrom: r0, rowTo: r1, colFrom: 0, colTo: 11 }
    });
    if (j.code !== 0) throw new Error('get_range_data code=' + j.code + ' ' + j.message);
    const cells = (unwrap(j).rangeData) || [];
    const g = {};
    for (const c of cells) {
      if (!g[c.rowFrom]) g[c.rowFrom] = {};
      // ★ 必须优先 originalCellValue：中转表 D 列条码被 Excel 当数字，cellText 会变成
      //   科学计数法 "6.92345E+12"（丢掉后几位），而 originalCellValue 是完整值。
      //   日期列 originalCellValue 是序列号(如 46234)，由 normDate 负责还原。
      g[c.rowFrom][c.colFrom] = (c.originalCellValue !== undefined && c.originalCellValue !== null)
        ? c.originalCellValue
        : c.cellText;
    }
    for (const rr of Object.keys(g).map(Number).sort((a, b) => a - b)) {
      const row = g[rr] || {};
      rows.push({
        idx: rr + 1,
        date: normDate(row[0]),
        station: s(row[1]),
        area: s(row[2]),
        barcode: s(row[3]).replace(/\s/g, ''),
        qty: num(row[6]),
        mark: s(row[11])
      });
    }
  }
  return rows;
}

/* ---------- 读金小存某表全部 ---------- */
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
  } while (token && pages < 30);
  return out;
}

/* ---------- 主流程 ---------- */
(async () => {
  console.log('== 销售SKU 中转表 → 05_出库流水 ' + (APPLY ? '(APPLY)' : '(DRY-RUN)'));

  const rows = await readTransfer();
  console.log('[1/4] 读中转表 ' + rows.length + ' 行');

  const sites = await readAll(SITE_SHEET);
  const siteMap = {};
  for (const r of sites) {
    const nm = s(r.fields['站点名称']);
    const t = tightSite(nm);
    if (t && !siteMap[t]) siteMap[t] = r.id;
  }
  console.log('[2/4] 站点档案 ' + sites.length + ' 个，映射键 ' + Object.keys(siteMap).length + ' 个');

  // 站名 → 站点 id
  const parsed = [], unmatched = [], ambiguous = [];
  for (const r of rows) {
    if (r.idx === 1) continue;                     // 表头
    if (r.mark) continue;                           // L 列已标记（历史兼容）
    if (!r.date || !r.station || !r.barcode) continue;
    if (!r.qty) continue;
    const base = tightSite(r.station);
    let sid = siteMap[base + extractDir(r.area)];
    if (!sid) {
      const cands = Object.keys(siteMap).filter(k => base && k.indexOf(base) === 0);
      if (cands.length === 1) sid = siteMap[cands[0]];
      else if (cands.length > 1) ambiguous.push({ row: r.idx, station: r.station, area: r.area, cands });
    }
    if (!sid) { unmatched.push({ row: r.idx, station: r.station, area: r.area }); continue; }
    parsed.push({ date: r.date, sid, barcode: r.barcode, qty: r.qty });
  }
  console.log('[3/4] 可映射 ' + parsed.length + ' 行；站名未匹配 ' + unmatched.length +
    '；方向歧义 ' + ambiguous.length);

  // 归并：日期|站点|条码
  const merged = new Map();
  for (const p of parsed) {
    const k = p.date + '|' + p.sid + '|' + p.barcode;
    if (!merged.has(k)) merged.set(k, { ...p, qty: 0 });
    merged.get(k).qty += p.qty;
  }

  const existing = await readAll(OUT_SHEET, ['日期', '站点', '商品编码']);
  const have = new Set();
  for (const r of existing) {
    const dv = normDate(r.fields['日期']);
    const st = r.fields['站点'];
    const sid = Array.isArray(st) ? (st[0] || '') : s(st);
    const bar = s(r.fields['商品编码']);
    if (dv && sid && bar) have.add(dv + '|' + sid + '|' + bar);
  }
  console.log('      05_出库流水 ' + existing.length + ' 行，已有键 ' + have.size + ' 个');

  const todo = [];
  for (const [k, v] of merged) if (!have.has(k)) todo.push({ key: k, ...v });
  console.log('[4/4] 归并后 ' + merged.size + ' 条；待写入 ' + todo.length + ' 条');

  for (const t of todo.slice(0, 5)) {
    console.log('        ' + t.date + ' ' + t.sid + ' 条码=' + t.barcode + ' 数量=' + t.qty);
  }
  if (unmatched.length) console.log('      未匹配样例：' + JSON.stringify(unmatched.slice(0, 5)));
  if (ambiguous.length) console.log('      歧义样例：' + JSON.stringify(ambiguous.slice(0, 5)));

  if (!APPLY) { console.log('\n(dry-run 结束，加 --apply 才会写入)'); return; }
  if (!todo.length) { console.log('== 无新增，结束'); return; }

  let written = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const records = chunk.map(t => ({
      fields: {
        '日期': t.date,
        '站点': [t.sid],
        '出库类型': OUT_TYPE,
        '出库数量': t.qty,
        '商品编码': t.barcode
      }
    }));
    const j = await callTool('dbsheet.create_records', {
      file_id: JXC_FID, sheet_id: OUT_SHEET, records, link_value: 'id'
    });
    if (j.code !== 0) {
      console.error('写入失败（已成功 ' + written + ' 条）code=' + j.code + ' ' + (j.message || ''));
      process.exit(2);
    }
    written += chunk.length;
  }
  console.log('已写入 ' + written + ' 条');
})().catch(e => { console.error('ERR=' + (e && e.message)); process.exit(2); });
