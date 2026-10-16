/* =============================================================
 * jxc_bridge.mjs —— 「金小存 → 订货系统」数据桥（自包含，不依赖金小存工程）
 * =============================================================
 * 用途：从金小存多维表拉实时库存与出库流水，按「订货门店 + 订货商品名」聚合成
 *       当前库存 / 近30天销量 / 近90天销量，供订货页面下单时参考，避免拍脑袋订货。
 *
 * 之所以要自包含：订货系统与金小存是两个独立仓库，订货的 Actions runner 上
 * 没有金小存的 server.js。所需能力（HTTP 直连 mcp-center）在这里重新实现一遍。
 *
 * 输入：
 *   token    金小存 WPS access token（仓库 Secret：JXC_TOKEN）
 *   mapsPath 对照表路径（deploy/_link_maps.json，由金小存侧 _build_link.js 生成后拷来）
 *
 * 关键坑（实测踩过，勿删注释）：
 *   1. text_value 必须分表使用：
 *        sheet9 用 'original' —— 否则 D4(商品 Link) 返回商品名字符串，拿不到记录 ID
 *        sheet11 用 'text'    —— 否则 u(站点 Link) 返回 ["ETR"] 这种 ID，拿不到站名
 *   2. 站点名两套写法：库存「秦岭服务区东站」vs 流水「秦岭服务区加油站东站（高速）」，必须归一
 *   3. 商品字典有 175 个重复条码，库存必须「按条码跨多条字典记录求和」，否则同品显示不同数字
 *   4. 网络抖动会静默返回 0 行，取数必须带重试
 * ============================================================= */
import fs from 'node:fs';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const KDOCS_API = 'https://mcp-center.wps.cn/skill_hub/api/v1/tool';
const LINK = 'ckOYsgKoz4nh';          // 金小存多维表
const CALL_TIMEOUT = 20000;

function callTool(tool, args, token) {
  return new Promise((resolve) => {
    let attempt = 0;
    const tryOnce = () => {
      const payload = JSON.stringify({ args, tool });
      let u; try { u = new URL(KDOCS_API); } catch (e) { resolve({ __err: 'API 地址非法' }); return; }
      const req = https.request({
        host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization': 'Bearer ' + token,
          'Accept': 'text/event-stream'
        }
      }, res => {
        let out = ''; res.setEncoding('utf8');
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
          if (json) { resolve(json); return; }
          if (attempt < 2) { attempt++; tryOnce(); }
          else resolve({ __err: 'kdocs 无 JSON 返回' });
        });
      });
      req.on('error', err => {
        if (attempt < 2) { attempt++; tryOnce(); }
        else resolve({ __err: 'kdocs 请求失败: ' + (err.message || err) });
      });
      req.setTimeout(CALL_TIMEOUT, () => req.destroy(new Error('timeout')));
      req.write(payload); req.end();
    };
    tryOnce();
  });
}

async function listAll(sheet, fields, label, token, tv = 'original') {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let out = [], pageToken = '';
    for (; ;) {
      const args = { link_id: LINK, sheet_id: sheet, prefer_id: true, fields, text_value: tv, page_size: 1000 };
      if (pageToken) args.page_token = pageToken;
      const j = await callTool('dbsheet.records_list', args, token);
      const d = (j.data && j.data.data) || {};
      const recs = d.records || [];
      recs.forEach(r => {
        let f = r.fields;
        if (typeof f === 'string') { try { f = JSON.parse(f); } catch (_) { f = null; } }
        if (f && typeof f === 'object') out.push(Object.assign({ __id: r.id }, f));
      });
      pageToken = d.page_token || '';
      if (!pageToken || !recs.length) break;
    }
    if (out.length) return out;
    console.warn(`  ⚠ [金小存桥] ${label} 第 ${attempt} 次取到 0 行，重试…`);
    await new Promise(r => setTimeout(r, 1500));
  }
  return [];
}

function normSite(s) {
  return String(s == null ? '' : s)
    .replace(/加油站/g, '')
    .replace(/[（(]\s*高速\s*[）)]/g, '')
    .replace(/\s+/g, '')
    .trim();
}
function parseDate(v) {
  const m = String(v == null ? '' : v).match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * @param {string} token    金小存 WPS token
 * @param {string} mapsPath 对照表 JSON 路径
 * @returns {Promise<{ok:boolean, reason?:string, stats:object, meta:object}>}
 */
export async function pullJxcStats(token, mapsPath) {
  if (!token) return { ok: false, reason: '未提供 JXC_TOKEN（金小存 WPS token）' };
  let maps;
  try { maps = JSON.parse(fs.readFileSync(mapsPath, 'utf8')); }
  catch (e) { return { ok: false, reason: '对照表读取失败：' + (e.message || e) }; }

  const s7 = await listAll(7, ['V', 'W', 'X', 'Y'], 'sheet7 商品字典', token, 'original');
  const s9 = await listAll(9, ['c', 'D4', 'C3', 'C4'], 'sheet9 实时库存', token, 'original');
  const s11 = await listAll(11, ['s', 'u', 'y', 'z', 'B0'], 'sheet11 出库流水', token, 'text');
  if (!s7.length || !s9.length) return { ok: false, reason: `金小存取数为空（s7=${s7.length}, s9=${s9.length}, s11=${s11.length}）` };

  // 库存：站点|skuId -> {qty, amt}
  const stock = new Map();
  for (const r of s9) {
    const site = r.c || ''; const sku = (r.D4 || [])[0];
    if (!site || !sku) continue;
    const k = site + '|' + sku;
    const qty = Number(r.C3) || 0, cost = Number(r.C4) || 0;
    const o = stock.get(k) || { qty: 0, amt: 0 };
    o.qty += qty; o.amt += qty * cost; stock.set(k, o);
  }
  // 条码 -> 该条码下全部字典记录 id（同条码多字典记录要跨记录求和）
  const code2ids = new Map();
  s7.forEach(r => {
    const c = String(r.Y || '').trim(); if (!c || !r.__id) return;
    if (!code2ids.has(c)) code2ids.set(c, new Set());
    code2ids.get(c).add(r.__id);
  });
  // 销量：归一站点|条码 -> 数量（30/90 天）
  const now = Date.now();
  const sales30 = new Map(), sales90 = new Map();
  let maxDate = null;
  for (const r of s11) {
    const site = r.u || ''; const code = String(r.B0 || '').trim();
    const d = parseDate(r.s); if (!site || !code || !d) continue;
    const qty = Number(r.z) || 0;
    if (!maxDate || d > maxDate) maxDate = d;
    const age = (now - d.getTime()) / 86400000;
    const k = normSite(site) + '|' + code;
    if (age <= 30) sales30.set(k, (sales30.get(k) || 0) + qty);
    if (age <= 90) sales90.set(k, (sales90.get(k) || 0) + qty);
  }
  // 门店 -> 金小存站点数组
  const siteMap = new Map();
  (maps.sites || []).forEach(s => {
    siteMap.set(s.订货门店, (s.金小存站点 && s.金小存站点 !== '(未匹配)') ? s.金小存站点.split(' + ') : []);
  });

  const stats = {};
  let nStock = 0, nSales = 0;
  for (const p of maps.products) {
    const skuId = p.金小存记录ID, code = p.条码;
    if (!skuId && !code) continue;
    for (const [storeName, jSites] of siteMap) {
      if (!jSites.length) continue;
      let qty = 0, amt = 0, s30 = 0, s90 = 0;
      const ids = (code && code2ids.get(code)) ? [...code2ids.get(code)] : (skuId ? [skuId] : []);
      for (const js of jSites) {
        for (const id of ids) { const st = stock.get(js + '|' + id); if (st) { qty += st.qty; amt += st.amt; } }
        if (code) { const nk = normSite(js) + '|' + code; s30 += sales30.get(nk) || 0; s90 += sales90.get(nk) || 0; }
      }
      if (qty > 0) nStock++;
      if (s30 > 0 || s90 > 0) nSales++;
      (stats[storeName] = stats[storeName] || {})[p.订货商品名] = {
        stock: qty, stockAmt: Math.round(amt * 100) / 100, sales30: s30, sales90: s90,
        code: code || '', skuId: skuId || ''
      };
    }
  }
  return {
    ok: true,
    stats,
    meta: {
      generatedAt: new Date().toISOString(),
      jxcSites: new Set(s9.map(r => r.c)).size,
      s9Rows: s9.length, s11Rows: s11.length, s7Rows: s7.length,
      mappedProducts: maps.products.filter(p => p.金小存记录ID).length,
      cellsWithStock: nStock, cellsWithSales: nSales,
      latestFlowDate: maxDate ? maxDate.toISOString().slice(0, 10) : null,
      note: '销量可能为空：出库流水主要覆盖便利店商品，润滑油/汽车用品多数未进入流水'
    }
  };
}

// 独立运行自检：JXC_TOKEN=xxx node jxc_bridge.mjs
if (process.argv[1] && process.argv[1].endsWith('jxc_bridge.mjs')) {
  const token = process.env.JXC_TOKEN || '';
  // scripts/ -> .github/ -> deploy/ ，对照表放在 deploy/_link_maps.json
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mp = process.env.MAPS_PATH || path.join(here, '..', '..', '_link_maps.json');
  const r = await pullJxcStats(token, mp);
  if (!r.ok) { console.error('✗', r.reason); process.exit(1); }
  console.log('✅ 金小存桥接自检通过');
  console.log('meta:', JSON.stringify(r.meta, null, 2));
  const stores = Object.keys(r.stats);
  console.log('覆盖订货门店 ' + stores.length + ' 个：' + stores.join(' / '));
  let n = 0;
  for (const s of stores) {
    const items = Object.entries(r.stats[s]).filter(([, v]) => v.stock > 0 || v.sales90 > 0);
    if (!items.length) continue;
    console.log('  [' + s + '] 有数据 ' + items.length + ' 个，样例：');
    items.slice(0, 3).forEach(([k, v]) => console.log('     ' + k + ' | 库存 ' + v.stock + ' | 30天销 ' + v.sales30 + ' | 90天销 ' + v.sales90));
    if (++n >= 4) break;
  }
}
