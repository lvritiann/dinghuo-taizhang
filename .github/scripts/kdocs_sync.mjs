#!/usr/bin/env node
/* =============================================================
 * kdocs_sync.mjs —— GitHub Actions 中转：GitHub ⇄ 金山在线表格
 * =============================================================
 * 由 .github/workflows/kdocs-sync.yml 调用，运行在 GitHub 云端 runner 上。
 * 之所以必须走 runner：金山网关会 403 掉一切带 Origin 头的请求，
 * 浏览器（含 GitHub Pages 页面）无法直连金山，必须由无 Origin 的服务器代发。
 *
 * 流程：
 *   0. 读回上一次的 data.json，取出「已写过的 cid」建立幂等基线（防重复入账）
 *   1. mode=order  时按 payload.orders 逐笔 POST 写入金山「供应商 Sheet」（cid 已写过的直接跳过）
 *      mode=arrive 时按 payload.arrive 调用到货确认（新增 / 改数量 / 撤销整行）
 *   2. POST dump 拉回全量数据（商品档案 + 全部订单 + 到货确认 + 算好的余额）
 *   3. 生成 data.json（含 arrivals + recentCids 幂等基线）
 *   4. git commit + push（用 workflow 自带的 GITHUB_TOKEN）
 *
 * 环境变量：
 *   KDOCS_WEBHOOK 金山 AirScript webhook URL     （Secrets）
 *   KDOCS_TOKEN   AirScript-Token                （Secrets）
 *   APP_TOKEN     自定义二次口令，防 PAT 泄露被滥用（Secrets）
 *   PAYLOAD_JSON  dispatch 传入的 JSON（含 appToken + orders / arrive）
 *   MODE          probe | sync | order | arrive
 *
 * PAYLOAD_JSON 里 arrive 的三种形状（与 AirScript 的 arrive/arriveFix/arriveVoid 一一对应）：
 *   {"arrive":{"action":"new", "cid":"…", "site":"秦岭", "by":"秦岭东",
 *              "items":[{"supplier":"天朗","store":"秦岭东","product":"红牛维生素功能饮料","qtyGot":20}]}}
 *   {"arrive":{"action":"fix",  "cid":"…", "row":12, "qtyGot":18, "reason":"少送 2 箱","admin":false}}
 *   {"arrive":{"action":"void", "cid":"…", "row":12, "admin":false}}
 * ============================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const KD_WEBHOOK = process.env.KDOCS_WEBHOOK || '';
const KD_TOKEN   = process.env.KDOCS_TOKEN   || '';
const APP_TOKEN  = process.env.APP_TOKEN  || '';
const MODE       = (process.env.MODE || 'sync').toLowerCase();
const ROOT       = process.env.GITHUB_WORKSPACE || process.cwd();

function die(msg) { console.error('✗ ' + msg); process.exit(1); }

if (!KD_WEBHOOK) die('缺少 Secrets.KDOCS_WEBHOOK（金山 webhook URL）');
if (!KD_TOKEN)   die('缺少 Secrets.KDOCS_TOKEN（AirScript-Token）');

let payload = {};
try { payload = JSON.parse(process.env.PAYLOAD_JSON || '{}'); }
catch (e) { die('PAYLOAD_JSON 解析失败：' + e.message); }

// 口令校验：仅对「写入类」动作（order / arrive）强校验；probe/sync 为只读，无需口令
// （手动/定时触发时 payload 里没有 appToken，但仍应放行只读动作）
if (APP_TOKEN && (MODE === 'order' || MODE === 'arrive')) {
  if (payload.appToken !== APP_TOKEN) die('appToken 不匹配，拒绝执行（防止令牌泄露后被滥用）');
}

// ---------- 调用金山 webhook ----------
async function kdocs(argv) {
  const body = JSON.stringify({ Context: { argv } });
  const res = await fetch(KD_WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'AirScript-Token': KD_TOKEN
      // 关键：不发送 Origin 头
    },
    body
  });
  const text = await res.text();
  if (!res.ok) die(`金山 HTTP ${res.status}（若 403 请检查是否带了 Origin 头 / Token 是否正确）: ${text.slice(0, 300)}`);
  let j;
  try { j = JSON.parse(text); } catch (e) { die('金山返回非 JSON：' + text.slice(0, 300)); }
  const d = (j && j.data !== undefined) ? j.data : j;
  const r = (d && d.result !== undefined) ? d.result : d;
  if (!r) die('金山返回格式异常：' + text.slice(0, 300));
  return r;
}

// ---------- 主流程 ----------
const today = new Date().toISOString().slice(0, 10);

if (MODE === 'probe') {
  const r = await kdocs({ mode: 'probe', appToken: payload.appToken || '' });
  console.log('探针结果：', JSON.stringify(r, null, 2));
  if (!r.ok) die('自检未通过：' + (r.error || JSON.stringify(r)));
  console.log('✓ 商品档案与 8 家供应商 Sheet 均就位');
  process.exit(0);
}

// 0) 服务端幂等（第二道防线）：读回上一次的 data.json，取出「已写过的客户端单号 cid」
//    场景：油站提交后页面没等到回执就关了/刷了 → 人工点「确认重发」时会带同一个 cid 再来一次。
//    这里直接跳过，保证金山台账绝不因为重试而重复入账。
let recentCids = [];
try {
  const prev = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
  recentCids = Array.isArray(prev.recentCids) ? prev.recentCids.filter(Boolean) : [];
} catch (e) {
  console.log('· 首次运行：workspace 内没有 data.json，幂等基线为空');
}
const seenCids = new Set(recentCids);

// 1) 逐笔下单
const rawOrders = Array.isArray(payload.orders) ? payload.orders : [];
const orders = [];
let dupSkipped = 0;
for (const o of rawOrders) {
  if (o && o.cid && seenCids.has(o.cid)) { dupSkipped++; continue; }   // ★ 幂等：cid 已写过，跳过
  orders.push(o);
}
if (dupSkipped) console.log(`· 幂等跳过 ${dupSkipped} 笔重复提交（cid 已在历史记录中）`);

let done = 0, amountSum = 0, failed = [];
const writtenCids = [];
for (const o of orders) {
  if (!o || !o.supplier || !o.product || !o.store || !(Number(o.qty) > 0)) {
    failed.push('订单格式错误：' + JSON.stringify(o));
    continue;
  }
  try {
    const r = await kdocs({
      mode: 'order',
      supplier: o.supplier, store: o.store, product: o.product,
      qty: Number(o.qty), date: o.date || today,
      expireDate: o.expireDate || '', note: o.note || '',
      force: !!o.force,
      appToken: payload.appToken || '', today
    });
    if (r && r.ok) {
      done++; amountSum += Number(r.amount || 0);
      if (o.cid) writtenCids.push(o.cid);
      console.log(`  ✓ ${o.supplier} / ${o.store} / ${o.product} × ${o.qty} → ¥${r.amount}（余额 ${r.balQty}${r.unit || ''}）`);
    } else {
      failed.push(`${o.supplier} ${o.store} ${o.product} → ${(r && r.error) || '未知'}`);
    }
  } catch (e) {
    failed.push(`${o.supplier} ${o.store} ${o.product} → ${e.message}`);
  }
}
if (orders.length) console.log(`下单完成：成功 ${done} / 共 ${orders.length}，合计 ¥${amountSum.toFixed(2)}`);

// 1b) 到货确认（ARRIVE-PATCH v1）：新增 / 改数量 / 撤销整行
//     与 order 共用同一套 cid 幂等基线（前缀 a: 区分，避免与订单 cid 撞号）
let arrLabel = '';
if (MODE === 'arrive') {
  const ar = (payload.arrive && typeof payload.arrive === 'object') ? payload.arrive : {};
  const action = String(ar.action || 'new').toLowerCase();       // new | fix | void
  const arrCid = ar.cid ? 'a:' + ar.cid : '';

  if (arrCid && seenCids.has(arrCid)) {
    console.log(`· 幂等跳过：这笔到货确认（cid ${ar.cid}）已经在历史记录里，不重复写入`);
  } else {
    const argv = { mode: 'arrive', appToken: payload.appToken || '', today };
    if (action === 'new') {
      argv.site = String(ar.site || '').trim();
      argv.by   = String(ar.by || '').trim();
      argv.items = Array.isArray(ar.items) ? ar.items : [];
      if (!argv.site) die('arrive 缺少 site（服务区）');
      if (!argv.items.length) die('arrive 缺少 items（要确认的到货明细）');
    } else if (action === 'fix') {
      argv.mode = 'arriveFix';
      argv.row = Number(ar.row); argv.qtyGot = Number(ar.qtyGot);
      argv.reason = ar.reason || ''; argv.note = ar.note || ''; argv.admin = !!ar.admin;
      if (!(argv.row > 1)) die('arriveFix 缺少有效的 row（《到货确认》里的行号）');
    } else if (action === 'void') {
      argv.mode = 'arriveVoid';
      argv.row = Number(ar.row); argv.admin = !!ar.admin;
      if (!(argv.row > 1)) die('arriveVoid 缺少有效的 row（《到货确认》里的行号）');
    } else {
      die('arrive.action 只能是 new / fix / void，收到：' + action);
    }

    const r = await kdocs(argv);
    if (r && r.ok && action === 'new') {
      // 逐项报告成功/被拦，方便油站当场看到「哪一项没进」
      for (const w of (r.wrote || [])) {
        done++;
        console.log(`  ✓ 确认 ${w.store} / ${w.supplier} / ${w.product} 应收 ${w.qtyShould}${w.unit || ''} 实收 ${w.qtyGot}（差异 ${w.diff >= 0 ? '+' : ''}${w.diff}）`);
      }
      for (const b of (r.blocked || [])) {
        failed.push(`到货确认被拦：${b.product} → ${b.why}`);
      }
      arrLabel = `确认到货 ${(r.wrote || []).length} 项` + ((r.blocked || []).length ? `，被拦 ${(r.blocked || []).length} 项` : '');
      if (arrCid && (r.wrote || []).length) writtenCids.push(arrCid);
    } else if (r && r.ok) {
      done++;
      arrLabel = action === 'fix' ? `改到货数量（第 ${r.row} 行）` : `撤销到货记录（第 ${r.row} 行）`;
      console.log('  ✓ ' + arrLabel + '：' + JSON.stringify(r.after || r.before || r));
      if (arrCid) writtenCids.push(arrCid);
    } else {
      failed.push('到货确认失败：' + ((r && r.error) || JSON.stringify(r)));
    }
  }
}

// 2) 拉全量
const dump = await kdocs({ mode: 'dump', appToken: payload.appToken || '', today });
if (!dump.ok) die('dump 失败：' + (dump.error || JSON.stringify(dump)));

// 3) 生成 data.json
// ★ 防御：丢掉没有供应商/商品名的残行 —— 老版式表格里那行「合计」小计
//   会被 AirScript 当成一条订单读回来（日期=合计、商品为空、数量 0），
//   在这里统一滤掉，保证 data.json 永远是干净数据。
const cleanOrders = (dump.orders || []).filter(o => o && o.supplier && o.product);
const dropped = (dump.orders || []).length - cleanOrders.length;
if (dropped > 0) console.log(`· 已过滤 ${dropped} 条无效行（无供应商/商品名，通常是表格小计行）`);

// 幂等基线：本次写成功的 cid + 历史 cid，最多留 1000 条（够覆盖任意重试窗口）
recentCids = Array.from(new Set(writtenCids.concat(recentCids).filter(Boolean))).slice(0, 1000);

// ★ 到货确认也过滤残行（供应商 + 商品名都得有），与订单同口径
const cleanArrivals = (dump.arrivals || []).filter(a => a && a.supplier && a.product);

const data = {
  updatedAt: dump.updatedAt || new Date().toISOString(),
  source: 'kdocs',
  today: dump.today || today,
  products: dump.products,
  orders: cleanOrders,
  productBal: dump.productBal,
  supplierBal: dump.supplierBal,
  catCaps: dump.catCaps || [],
  arrivals: cleanArrivals,
  expiring: (dump.expiring || []).filter(o => o && o.supplier && o.product),
  missingSheets: dump.missingSheets || [],
  recentCids: recentCids
};

const outPath = path.join(ROOT, 'data.json');
fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
console.log(`✓ data.json 已更新：商品 ${data.products.length} 款 / 订单 ${data.orders.length} 笔 / 到货确认 ${data.arrivals.length} 条 / 供应商 ${data.supplierBal.length} 家 / 品类额度 ${(data.catCaps || []).length} 类（幂等基线 ${recentCids.length} 条）`);
// 4) 提交
const hasChange = execSync('git status --porcelain data.json', { cwd: ROOT }).toString().trim();
if (!hasChange) {
  console.log('· data.json 无变化，跳过提交');
} else {
  execSync('git config user.name  "kdocs-sync[bot]"', { cwd: ROOT });
  execSync('git config user.email "kdocs-sync[bot]@users.noreply.github.com"', { cwd: ROOT });
  execSync('git add data.json', { cwd: ROOT });
  const parts = [];
  if (done && MODE === 'order') parts.push(`新增订单 ${done} 笔`);
  if (arrLabel) parts.push(arrLabel);
  const msg = `chore(data): 同步金山台账 ${today}${parts.length ? '（' + parts.join('；') + '）' : ''}`;
  execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: ROOT });
  execSync('git push', { cwd: ROOT });
  console.log('✓ 已提交并推送');
}

if (failed.length) {
  console.error('⚠ 部分写入未成功：');
  for (const f of failed) console.error('  - ' + f);
  // 一条都没写成功才判定失败；部分成功视为成功（避免一条坏数据卡死整批）
  process.exit(done === 0 ? 1 : 0);
}
console.log('✓ 全部完成');
