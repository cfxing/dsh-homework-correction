/*
 * 作业批改 · 本机中转（OpenAI 兼容转发）
 * ------------------------------------------------------------
 * 作用：让「窗口1 · 作业批改」页面在浏览器直连模型服务被跨域拦住时，
 *       改走本机 http://127.0.0.1:8899 转发，Key 只留在本机、不进网页。
 *
 * 启动：双击同目录的「作业批改-启动中转.bat」（或 node hwgrade-relay.cjs）
 * 停止：关闭那个黑窗口
 *
 * 可选参数：
 *   --port 8899
 *   --key sk-xxxx             （默认自动从 DSH 配置里找）
 *   --upstream https://.../v1 （默认取 DSH 里 describe-image 的 baseURL）
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SETTINGS = path.join(DSH_HOME, 'settings.yaml');
const CREDS = path.join(DSH_HOME, '.credentials.yaml');

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

/* DSH 凭据库 refs: 段（NAME: 值） */
function readCreds() {
  const map = {};
  const lines = readText(CREDS).split(/\r?\n/);
  let inRefs = false;
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (!inRefs) continue;
    const m = /^\s{2}([A-Za-z0-9_]+)\s*:\s*(\S+)\s*$/.exec(line);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

/* 从 DSH 配置里找出「baseURL + apiKey」配对的可用上游（找不到也不影响手工传参） */
function discoverFromSettings() {
  const out = { keys: [], upstream: '', model: '' };
  const s = readText(SETTINGS);
  if (!s) return out;
  const creds = readCreds();

  const blocks = [];
  let block = null;
  const flush = () => { if (block) blocks.push(block); };
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top) { flush(); block = { name: top[1], base: '', key: '', model: '' }; continue; }
    if (!block) continue;
    const kv = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const k = kv[1];
    const v = kv[2].trim().replace(/^["']|["']$/g, '');
    if (!v) continue;
    if (/^(baseURL|apiBaseUrl)$/.test(k) && /^https?:\/\//.test(v) && !block.base) block.base = v.replace(/\/+$/, '');
    else if (k === 'apiKey' && !block.key) {
      const cred = /^cred:(.+)$/.exec(v);
      block.key = cred ? (creds[cred[1]] || '') : v;
    } else if (k === 'model' && !block.model) block.model = v;
  }
  flush();

  const usable = blocks.filter((b) => b.base && b.key);
  usable.sort((a, b) => score(b) - score(a));
  function score(b) {
    let n = 0;
    if (/aliyuncs|dashscope/i.test(b.base)) n += 3;
    if (b.name === 'describe-image') n += 2;
    if (b.name === 'image-vision') n += 1;
    return n;
  }
  if (usable[0]) {
    out.upstream = usable[0].base;
    out.keys.push(usable[0].key);
    out.model = usable[0].model || '';
  }
  for (const b of blocks) if (b.key) out.keys.push(b.key);
  out.keys = out.keys.filter((v, i) => v && out.keys.indexOf(v) === i);
  return out;
}

const found = discoverFromSettings();
const UPSTREAM = (arg('upstream', process.env.JOBGRADE_UPSTREAM || found.upstream || 'https://dashscope.aliyuncs.com/compatible-mode/v1')).replace(/\/+$/, '');
const API_KEY = arg('key', process.env.JOBGRADE_KEY || process.env.DASHSCOPE_API_KEY || found.keys[0] || '');
const PORT = Number(arg('port', process.env.JOBGRADE_PORT || 8899));
const HOST = '127.0.0.1';

const up = new URL(UPSTREAM);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-requested-with, x-api-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': '*'
};

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS));
  res.end(body);
}

const server = http.createServer((req, res) => {
  let p = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (/\/health$/.test(p) || p === '/') {
    json(res, 200, {
      ok: true,
      service: '作业批改 · 本机中转',
      upstream: UPSTREAM,
      hasKey: !!API_KEY,
      port: PORT,
      hint: '把这个地址填进「窗口1 · 作业批改」的中转地址：http://127.0.0.1:' + PORT + '/v1'
    });
    return;
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  // /v1/chat/completions -> upstream + /chat/completions ；GET /v1/models 也一并转发（供「检测可用模型」用）
  let tail = p.replace(/^\/v1(?=\/)/, '');
  if (tail === '/v1') tail = '/';
  const target = new URL((up.pathname.replace(/\/+$/, '')) + tail, up.origin);

  if (req.method === 'GET') {
    const greq = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Accept': 'application/json' }
    }, (pres) => {
      const out = { 'Content-Type': pres.headers['content-type'] || 'application/json; charset=utf-8' };
      Object.assign(out, CORS);
      res.writeHead(pres.statusCode || 502, out);
      pres.pipe(res);
    });
    greq.on('error', (e) => json(res, 502, { error: '转发失败：' + e.message, upstream: UPSTREAM }));
    greq.setTimeout(30000, () => greq.destroy(new Error('上游超时')));
    greq.end();
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'Authorization': 'Bearer ' + API_KEY,
      'Accept': 'application/json'
    };
    const preq = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: 'POST',
      headers
    }, (pres) => {
      const out = {
        'Content-Type': pres.headers['content-type'] || 'application/json; charset=utf-8'
      };
      Object.assign(out, CORS);
      res.writeHead(pres.statusCode || 502, out);
      pres.pipe(res);
    });
    preq.on('error', (e) => {
      json(res, 502, { error: '转发失败：' + e.message, upstream: UPSTREAM });
    });
    preq.setTimeout(300000, () => { preq.destroy(new Error('上游超时')); });
    preq.end(body);
  });
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log('[!] 端口 ' + PORT + ' 已被占用：可能中转已经在运行了。直接回到网页点「开始批改」即可。');
  } else {
    console.log('[!] 启动失败：' + (e && e.message ? e.message : e));
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  作业批改 · 本机中转已启动');
  console.log('  ----------------------------------------');
  console.log('  中转地址 : http://' + HOST + ':' + PORT + '/v1');
  console.log('  上游服务 : ' + UPSTREAM);
  console.log('  密钥     : ' + (API_KEY ? ('已读取（' + API_KEY.slice(0, 6) + '…' + API_KEY.slice(-4) + '）') : '未找到，请用 --key 传入'));
  console.log('  健康检查 : http://' + HOST + ':' + PORT + '/health');
  console.log('  ----------------------------------------');
  console.log('  保持这个窗口开着，回到「窗口1 · 作业批改」点「开始批改」。');
  console.log('  用完直接关闭本窗口即可停止。');
  console.log('');
});
