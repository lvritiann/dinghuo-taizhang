#!/usr/bin/env node
/* =============================================================
 * kdocs_sync.mjs —— GitHub Actions 中转：GitHub ⇄ 金山在线表格
 * =============================================================
 * 由 .github/workflows/kdocs-sync.yml 调用，运行在 GitHub 云端 runner 上。
 * 之所以必须走 runner：金山网关会 403 掉一切带 Origin 头的请求，
 * 浏览器（含 GitHub Pages 页面）无法直连金山，必须由无 Origin 的服务器代发。
 *
 * 流程：
 *   1. （可选）按 client_payload.rows 逐行 POST append 到金山「入库」/「出库」
 *   2. POST dump 拉回全量数据
 *   3. 生成 data.json
 *   4. git commit + push（用 workflow 自带的 GITHUB_TOKEN）
 *
 * 环境变量：
 *   KD_WEBHOOK   金山 AirScript webhook URL      （Secrets）
 *   KD_TOKEN     AirScript-Token                 （Secrets）
 *   APP_TOKEN    自定义二次口令，防 PAT 泄露被滥用（Secrets）
 *   PAYLOAD_JSON dispatch 的 client_payload JSON
 *   MODE         append | sync | probe
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

// 口令校验：仅对「写入类」动作（order）强校验；probe/sync 为只读，无需口令
// （手动/定时触发时 payload 里没有 appToken，但仍应放行只读动作）
if (APP_TOKEN && MODE === 'order') {
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
  console.log('✓ 三张表（批次/入库/出库）均就位');
  process.exit(0);
}

// 1) 逐笔下单
const orders = Array.isArray(payload.orders) ? payload.orders : [];
let done = 0, amountSum = 0, failed = [];
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
      console.log(`  ✓ ${o.supplier} / ${o.store} / ${o.product} × ${o.qty} → ¥${r.amount}（余额 ${r.balQty}${r.unit || ''}）`);
    } else {
      failed.push(`${o.supplier} ${o.store} ${o.product} → ${(r && r.error) || '未知'}`);
    }
  } catch (e) {
    failed.push(`${o.supplier} ${o.store} ${o.product} → ${e.message}`);
  }
}
if (orders.length) console.log(`下单完成：成功 ${done} / 共 ${orders.length}，合计 ¥${amountSum.toFixed(2)}`);

// 2) 拉全量
const dump = await kdocs({ mode: 'dump', appToken: payload.appToken || '', today });
if (!dump.ok) die('dump 失败：' + (dump.error || JSON.stringify(dump)));

// 3) 生成 data.json
const data = {
  updatedAt: dump.updatedAt || new Date().toISOString(),
  source: 'kdocs',
  today: dump.today || today,
  products: dump.products,
  orders: dump.orders,
  productBal: dump.productBal,
  supplierBal: dump.supplierBal,
  expiring: dump.expiring || [],
  missingSheets: dump.missingSheets || []
};

const outPath = path.join(ROOT, 'data.json');
fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
console.log(`✓ data.json 已更新：商品 ${data.products.length} 款 / 订单 ${data.orders.length} 笔 / 供应商 ${data.supplierBal.length} 家`);

// 4) 提交
const hasChange = execSync('git status --porcelain data.json', { cwd: ROOT }).toString().trim();
if (!hasChange) {
  console.log('· data.json 无变化，跳过提交');
} else {
  execSync('git config user.name  "kdocs-sync[bot]"', { cwd: ROOT });
  execSync('git config user.email "kdocs-sync[bot]@users.noreply.github.com"', { cwd: ROOT });
  execSync('git add data.json', { cwd: ROOT });
  const msg = `chore(data): 同步金山台账 ${today}（新增订单 ${done} 笔）`;
  execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: ROOT });
  execSync('git push', { cwd: ROOT });
  console.log('✓ 已提交并推送');
}

if (failed.length) {
  console.error('⚠ 部分流水写入失败：');
  for (const f of failed) console.error('  - ' + f);
  process.exit(failed.length && appended === 0 ? 1 : 0);
}
console.log('✓ 全部完成');
