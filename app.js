"use strict";
/* 院内資料・参考書 検索 (iPad版)  索引はGoogle Driveから取り込み、iPad内で検索する */
const $ = id => document.getElementById(id);
const CUR_YEAR = new Date().getFullYear();
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const fmtSize = n => !n ? "" : (n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB") + "（" + n.toLocaleString("ja-JP") + " バイト）";
const SRC_HOSP = "院内資料", SRC_BOOK = "参考書", GRP_RN = "レジデントノート";
const grpOf = (f) => (f.src === SRC_BOOK && f.top1 === GRP_RN) ? GRP_RN : f.src;   // 区分: 院内資料 / レジデントノート / 参考書

/* ---------- 設定 ---------- */
const DEF = { clientId: "", geminiKey: "", indexFolder: "院内検索_iPad索引", rootHosp: "St Lukes", rootBook: "参考書", fake: false, loginHint: "" };
let CFG = Object.assign({}, DEF);
try { Object.assign(CFG, JSON.parse(localStorage.getItem("hs_cfg") || "{}")); } catch (e) {}
function saveCfg() { try { localStorage.setItem("hs_cfg", JSON.stringify(CFG)); } catch (e) {} }

/* ---------- IndexedDB ---------- */
let _db = null;
function idb() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const r = indexedDB.open("hsearch", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("blobs"); r.result.createObjectStore("kv"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return _db;
}
async function idbOp(store, mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction(store, mode); const s = t.objectStore(store); const q = fn(s); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}
const idbGet = (s, k) => idbOp(s, "readonly", st => st.get(k));
const idbPut = (s, k, v) => idbOp(s, "readwrite", st => st.put(v, k));
const idbDel = (s, k) => idbOp(s, "readwrite", st => st.delete(k));
const idbKeys = s => idbOp(s, "readonly", st => st.getAllKeys());

/* ---------- テキスト処理（Mac側 hs_common.py と同一） ---------- */
const PUNCT = /[、。，．・\(\)（）「」『』\[\]【】:：;；!！?？/／\\|｜"“”'’‘…→←↑↓■□●○◆◇▲▽※＊\*#,\.]/g;
const norm = s => s.normalize("NFKC").toLowerCase();
function grams(s) {
  s = norm(s).replace(PUNCT, " "); const out = []; const re = /[a-z0-9][a-z0-9\-\+]*|[^\sa-z0-9]+/g; let m;
  while ((m = re.exec(s))) {
    const w = m[0];
    if (w.charCodeAt(0) < 128) out.push(w);
    else { const cp = Array.from(w); if (cp.length === 1) out.push(w); else for (let i = 0; i < cp.length - 1; i++) out.push(cp[i] + cp[i + 1]); }
  }
  return out;
}
let _crc = null;
function crc32(str) {
  if (!_crc) { _crc = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; _crc[n] = c >>> 0; } }
  let c = 0xFFFFFFFF; const b = new TextEncoder().encode(str);
  for (let i = 0; i < b.length; i++) c = _crc[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function fakeEmbed(q, dim) {
  const v = new Float32Array(dim); for (const g of grams(q)) v[crc32(g) % dim] += 1;
  let n = 0; for (let i = 0; i < dim; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; for (let i = 0; i < dim; i++) v[i] /= n; return v;
}
function locLabel(k, n) {
  if (k === "p") return "p." + n; if (k === "s") return "slide " + n; if (k === "c") return "§" + n;
  if (k.startsWith("sh:")) return "シート「" + k.slice(3) + "」"; return k + " " + n;
}

/* ---------- 認証（画面移動方式。ホーム画面アプリでも動く） ---------- */
function redirectUri() { return location.origin + location.pathname; }
function getToken() {
  try { const t = JSON.parse(localStorage.getItem("hs_tok") || "null"); if (t && t.exp > Date.now() + 60000) return t.t; } catch (e) {}
  return null;
}
function handleAuthReturn() {
  if (!location.hash || location.hash.length < 3) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("access_token")) {
    try { localStorage.setItem("hs_tok", JSON.stringify({ t: p.get("access_token"), exp: Date.now() + (+p.get("expires_in") || 3600) * 1000 })); } catch (e) {}
    history.replaceState(null, "", location.pathname + location.search); return "ok";
  }
  if (p.get("error")) { history.replaceState(null, "", location.pathname + location.search); return p.get("error"); }
  return null;
}
function login(resume, silent) {
  if (!CFG.clientId) { openSettings(); setStat("先に設定で「Client ID」を入力してください"); return; }
  try { sessionStorage.setItem("hs_resume", JSON.stringify(resume || {})); } catch (e) {}
  const q = new URLSearchParams({ client_id: CFG.clientId, redirect_uri: redirectUri(), response_type: "token", scope: SCOPE, include_granted_scopes: "true" });
  if (CFG.loginHint) q.set("login_hint", CFG.loginHint);   // ログインに使うGoogleアカウント（他のアカウントで自動ログインされるのを防ぐ）
  q.set("prompt", silent ? "none" : "select_account");      // 通常はアカウント選択画面を必ず出す
  location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + q;
}
async function needToken(resume) {
  const t = getToken(); if (t) return t;
  login(resume, !!localStorage.getItem("hs_tried")); try { localStorage.setItem("hs_tried", "1"); } catch (e) {}
  return await new Promise(() => {});
}

/* ---------- Drive API ---------- */
const API = "https://www.googleapis.com/drive/v3/";
async function driveJSON(path, params) {
  const t = await needToken(); const u = API + path + "?" + new URLSearchParams(params || {});
  const r = await fetch(u, { headers: { Authorization: "Bearer " + t } });
  if (r.status === 401) { try { localStorage.removeItem("hs_tok"); } catch (e) {} await needToken(); }
  if (!r.ok) throw new Error("Drive " + r.status + ": " + (await r.text()).slice(0, 150));
  return r.json();
}
const esc1 = s => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
async function findChild(parent, name, folderOnly) {
  const tries = [name.normalize("NFC"), name.normalize("NFD")];
  for (const nm of [...new Set(tries)]) {
    let q = "name='" + esc1(nm) + "' and '" + parent + "' in parents and trashed=false"; if (folderOnly) q += " and mimeType='application/vnd.google-apps.folder'";
    const d = await driveJSON("files", { q, fields: "files(id,name,mimeType)", pageSize: 5, spaces: "drive" });
    if (d.files && d.files.length) return d.files[0];
  }
  if (parent === "root" && folderOnly) {   // 友達などから共有されたフォルダ（「共有アイテム」）も探す
    for (const nm of [...new Set(tries)]) {
      const q = "name='" + esc1(nm) + "' and sharedWithMe=true and trashed=false and mimeType='application/vnd.google-apps.folder'";
      const d = await driveJSON("files", { q, fields: "files(id,name,mimeType)", pageSize: 5, spaces: "drive" });
      if (d.files && d.files.length) return d.files[0];
    }
  }
  return null;
}
async function listChildren(parent) {
  let out = [], tok = "";
  do {
    const d = await driveJSON("files", { q: "'" + parent + "' in parents and trashed=false", fields: "nextPageToken,files(id,name,md5Checksum,size)", pageSize: "1000", pageToken: tok });
    out = out.concat(d.files || []); tok = d.nextPageToken || "";
  } while (tok);
  return out;
}
async function downloadBuf(id, onProg) {
  const t = await needToken();
  const r = await fetch(API + "files/" + id + "?alt=media", { headers: { Authorization: "Bearer " + t } });
  if (!r.ok) throw new Error("ダウンロード失敗 " + r.status);
  const total = +r.headers.get("content-length") || 0; const rd = r.body.getReader(); const parts = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; if (onProg) onProg(got, total); }
  const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}
async function downloadBlob(id, onProg) {   // 大きいPDF用: 連結せずBlobのまま保持（メモリを節約）
  const t = await needToken();
  const r = await fetch(API + "files/" + id + "?alt=media", { headers: { Authorization: "Bearer " + t } });
  if (!r.ok) throw new Error("ダウンロード失敗 " + r.status);
  const total = +r.headers.get("content-length") || 0; const rd = r.body.getReader(); const parts = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; if (onProg) onProg(got, total); }
  return new Blob(parts, { type: "application/pdf" });
}
/* ---------- 最近開いた本の自動キャッシュ（一度開いたら、しばらくは端末から即開く。上限を超えたら古い順に削除） ---------- */
const RC_MAX = 1.2e9, RC_DAYS = 14, RC_ONE = 300e6, RCING = new Set();
async function rcDel(rel) { await idbDel("kv", "rcd:" + rel); await idbDel("kv", "rcm:" + rel); }
async function rcList() { const out = []; for (const k of await idbKeys("kv")) if (typeof k === "string" && k.startsWith("rcm:")) { const m = await idbGet("kv", k); if (m) out.push(m); } return out; }
async function rcPrune() {
  try { const L = (await rcList()).sort((a, b) => b.t - a.t); const now = Date.now(); let tot = 0;
    for (const m of L) { if (now - m.t > RC_DAYS * 864e5 || tot + m.size > RC_MAX) await rcDel(m.rel); else tot += m.size; } } catch (e) {}
}
async function rcStore(f, id, blob) {
  try { await idbPut("kv", "rcd:" + f.rel, blob); await idbPut("kv", "rcm:" + f.rel, { rel: f.rel, id, name: f.name, size: blob.size, t: Date.now() }); await rcPrune(); }
  catch (e) { try { await rcDel(f.rel); } catch (e2) {} }
}
async function rcFetch(f, id) {    // 開いている間に、裏で全体を取り込む（次回から即開く）
  if (f.ext !== "pdf" || SAVED.has(f.rel) || RCING.has(f.rel) || (f.size && f.size > RC_ONE)) return;
  RCING.add(f.rel);
  try { if (await idbGet("kv", "rcm:" + f.rel)) return; const blob = await downloadBlob(id); if (blob.size <= RC_ONE) await rcStore(f, id, blob); } catch (e) {}
  finally { RCING.delete(f.rel); }
}
/* ---------- オフライン保存（よく使う本をこの端末に保存して、Driveを使わず即開く） ---------- */
const SAVED = new Map();
async function loadSaved() { SAVED.clear(); try { for (const k of await idbKeys("kv")) if (typeof k === "string" && k.startsWith("offm:")) { const m = await idbGet("kv", k); if (m) SAVED.set(m.rel, m); } } catch (e) {} }
async function savePdf(f, onProg) {
  const id = await resolveDriveId(f); const blob = await downloadBlob(id, onProg);
  if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) {} }
  await idbPut("kv", "offd:" + f.rel, blob);
  const m = { rel: f.rel, id, name: f.name, size: blob.size, t: Date.now() }; await idbPut("kv", "offm:" + f.rel, m); SAVED.set(f.rel, m);
}
async function unsavePdf(rel) { await idbDel("kv", "offd:" + rel); await idbDel("kv", "offm:" + rel); SAVED.delete(rel); }
const saveLabel = f => SAVED.has(f.rel) ? "✅ 保存済み" : "📥 保存";
async function toggleSave(f, btn) {
  if (SAVED.has(f.rel)) { if (!confirm("この端末に保存した「" + f.name + "」を削除しますか？（Driveの元ファイルは消えません）")) return; await unsavePdf(f.rel); btn.textContent = saveLabel(f); return; }
  btn.disabled = true;
  try { await savePdf(f, (g, t) => { btn.textContent = "保存中 " + Math.round(g / 1e6) + (t ? "/" + Math.round(t / 1e6) : "") + "MB"; }); setStat("保存しました: " + f.name); }
  catch (e) { setStat("保存できません: " + (e && e.name === "QuotaExceededError" ? "端末の空き容量が足りません" : (e && e.message) || e)); }
  btn.disabled = false; btn.textContent = saveLabel(f);
}
async function renderSaved() {
  const box = $("s_saved"); box.innerHTML = ""; const L = [...SAVED.values()].sort((a, b) => b.t - a.t); let tot = 0;
  L.forEach(m => { tot += m.size; const r = document.createElement("div"); r.className = "row"; r.style.cssText = "justify-content:space-between;font-size:13px;margin:4px 0";
    const sp = document.createElement("span"); sp.style.cssText = "flex:1;word-break:break-all"; sp.textContent = m.name + "（" + Math.round(m.size / 1e6) + "MB）";
    const b = document.createElement("button"); b.className = "sub"; b.textContent = "削除"; b.onclick = async () => { await unsavePdf(m.rel); renderSaved(); }; r.append(sp, b); box.appendChild(r); });
  let est = ""; try { const e = await navigator.storage.estimate(); est = "　端末の使用量 " + Math.round(e.usage / 1e6) + "MB（上限の目安 " + (Math.round(e.quota / 1e8) / 10) + "GB）"; } catch (e) {}
  const h = document.createElement("div"); h.style.cssText = "font-size:12px;color:var(--mu)"; h.textContent = (L.length ? "保存済み " + L.length + "冊・合計 " + Math.round(tot / 1e6) + "MB" : "まだ保存した本はありません（検索結果の「📥 保存」で保存できます）") + est; box.prepend(h);
  try { const R = await rcList(); const rt = R.reduce((a, m) => a + m.size, 0); const d = document.createElement("div"); d.className = "row"; d.style.cssText = "justify-content:space-between;font-size:12px;color:var(--mu);margin-top:8px";
    const sp = document.createElement("span"); sp.textContent = "最近開いた本の自動保存 " + R.length + "冊・" + Math.round(rt / 1e6) + "MB（上限1.2GB・14日で自動削除）";
    const b = document.createElement("button"); b.className = "sub"; b.textContent = "全部消す"; b.onclick = async () => { for (const m of R) await rcDel(m.rel); renderSaved(); }; d.append(sp, b); box.appendChild(d); } catch (e) {}
}
const pathCache = new Map();
async function resolveDriveId(f) {
  const key = f.rel; if (pathCache.has(key)) return pathCache.get(key);
  const cached = await idbGet("kv", "id:" + key); if (cached) { pathCache.set(key, cached); return cached; }
  const rootName = f.src === SRC_BOOK ? CFG.rootBook : CFG.rootHosp;
  let cur = await findChild("root", rootName, true); if (!cur) throw new Error("Driveに「" + rootName + "」フォルダが見つかりません");
  const parts = f.path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const c = await findChild(cur.id, parts[i], i < parts.length - 1);
    if (!c) throw new Error("Driveに見つかりません: " + parts.slice(0, i + 1).join("/"));
    cur = c;
  }
  pathCache.set(key, cur.id); await idbPut("kv", "id:" + key, cur.id); return cur.id;
}

/* ---------- 索引の取り込み ---------- */
async function syncIndex() {
  setStat("Driveから索引の一覧を取得中…");
  const folder = await findChild("root", CFG.indexFolder, true);
  if (!folder) { setStat("Driveに「" + CFG.indexFolder + "」フォルダがありません。Mac側で索引を書き出し、Driveに同期してください。"); return false; }
  const list = await listChildren(folder.id); const byName = new Map(list.map(x => [x.name, x]));
  const mf = byName.get("manifest.json"); if (!mf) { setStat("manifest.json がありません"); return false; }
  const man = JSON.parse(new TextDecoder().decode(await downloadBuf(mf.id)));
  const need = [], optional = new Set();
  for (const s of man.shards) need.push(s.c, s.v);
  for (const sg of segsOf(man)) { need.push(sg.bm25.terms, sg.bm25.post, sg.bm25.dl); if (sg.covers) { need.push(sg.covers); optional.add(sg.covers); } }
  const have = new Set(await idbKeys("blobs")); let total = 0;
  const todo = [];
  for (const n of need) {
    const d = byName.get(n); if (!d) { if (optional.has(n)) continue; throw new Error("Driveに " + n + " がありません（同期が終わっていない可能性）"); }   // 表紙は無くても動く
    const h = have.has(n) ? await idbGet("blobs", n) : null;
    if (!h || h.md5 !== d.md5Checksum) { todo.push(d); total += +d.size || 0; }
  }
  let doneB = 0, i = 0;
  for (const d of todo) {
    i++;
    const buf = await downloadBuf(d.id, (g) => setStat("索引をダウンロード中 " + i + "/" + todo.length + "（" + Math.round((doneB + g) / 1e6) + " / " + Math.round(total / 1e6) + " MB）"));
    doneB += buf.byteLength; await idbPut("blobs", d.name, { md5: d.md5Checksum, data: buf });
  }
  for (const k of have) if (!need.includes(k)) await idbDel("blobs", k);
  await idbPut("kv", "manifest", man);
  setStat(todo.length ? "索引を更新しました（" + todo.length + " ファイル）" : "索引は最新です");
  return true;
}

/* ---------- 索引の読み込み ---------- */
// 索引は「本体＋追加分(セグメント)」の集まり。旧形式(v1)は、全体を1つの本体として扱う
function segsOf(man) {
  if (man.segs) return man.segs;
  return [{ id: 0, start: 0, n: man.nchunks, f0: 0, nfiles: man.files.length, covers: man.covers || "", bm25: { terms: man.bm25.terms, post: man.bm25.post, dl: man.bm25.dl, sumdl: man.bm25.avg * man.nchunks } }];
}
let IX = null;
async function gunzipText(buf) {
  const ds = new DecompressionStream("gzip"); const w = ds.writable.getWriter(); w.write(new Uint8Array(buf)); w.close();
  return new Response(ds.readable).text();
}
async function loadIndex() {
  const man = await idbGet("kv", "manifest"); if (!man) return false;
  setStat("索引を読み込み中…（起動直後は10〜30秒かかります）");
  const dim = man.dim, N = man.nchunks;
  const Q = new Int8Array(N * dim), S = new Float32Array(N);
  for (const sh of man.shards) {
    const b = await idbGet("blobs", sh.v); if (!b) return false;
    Q.set(new Int8Array(b.data, 0, sh.n * dim), sh.start * dim);
    S.set(new Float32Array(b.data.slice(sh.n * dim, sh.n * dim + sh.n * 4)), sh.start);
  }
  const fid = new Int32Array(N); let p = 0;
  man.files.forEach((f, i) => { fid.fill(i, p, p + f.n); p += f.n; f.ptxt = norm(f.path.replace(/\.[^./]+$/, "")); f.grp = grpOf(f); });
  const segs = []; let sumdl = 0; const covs = {};
  for (const sg of segsOf(man)) {
    const tb = await idbGet("blobs", sg.bm25.terms), pb = await idbGet("blobs", sg.bm25.post), db = await idbGet("blobs", sg.bm25.dl);
    if (!tb || !pb || !db) return false;
    const terms = JSON.parse(await gunzipText(tb.data)); Object.setPrototypeOf(terms, null);
    segs.push({ start: sg.start, n: sg.n, terms, post: new Uint8Array(pb.data), dl: new Uint16Array(db.data) }); sumdl += sg.bm25.sumdl;
    if (sg.covers) { const cb = await idbGet("blobs", sg.covers); if (cb) covs[sg.covers] = cb.data; }
  }
  IX = { covs, covUrl: new Map(), man, dim, N, Q, S, fid, files: man.files, segs, avg: sumdl / Math.max(1, N), lru: new Map() };
  return true;
}
async function shardChunks(si) {
  if (IX.lru.has(si)) { const v = IX.lru.get(si); IX.lru.delete(si); IX.lru.set(si, v); return v; }
  const b = await idbGet("blobs", IX.man.shards[si].c); const arr = JSON.parse(await gunzipText(b.data));
  IX.lru.set(si, arr); if (IX.lru.size > 16) IX.lru.delete(IX.lru.keys().next().value); return arr;
}
function shardOf(i) { const sh = IX.man.shards; let lo = 0, hi = sh.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (sh[m].start <= i) lo = m; else hi = m - 1; } return lo; }
async function chunkAt(i) { const si = shardOf(i); const arr = await shardChunks(si); return arr[i - IX.man.shards[si].start]; }

/* ---------- 検索 ---------- */
function bm25(q, mask) {
  const N = IX.N, sb = new Float32Array(N), k1 = 1.2, b = 0.75, avg = IX.avg;
  for (const g of new Set(grams(q))) {
    let df = 0; const es = [];
    for (const sg of IX.segs) { const e = sg.terms[g]; if (e) { df += e[2]; es.push([sg, e]); } }
    if (!df) continue;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (const [sg, e] of es) {
      const post = sg.post; let ptr = e[0]; const end = ptr + e[1]; let doc = 0;
      while (ptr < end) {
        let d = 0, sh = 0, by; do { by = post[ptr++]; d |= (by & 127) << sh; sh += 7; } while (by & 128);
        doc += d; const tf = post[ptr++]; const gd = sg.start + doc;
        if (mask[gd]) sb[gd] += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * sg.dl[doc] / avg));
      }
    }
  }
  return sb;
}
function topK(scores, k, valid) {
  const idx = []; for (let i = 0; i < scores.length; i++) if (valid(i, scores[i])) idx.push(i);
  if (idx.length > k) { idx.sort((a, b) => scores[b] - scores[a]); idx.length = k; } else idx.sort((a, b) => scores[b] - scores[a]);
  return idx;
}
async function embedQuery(q) {
  if (CFG.fake) return fakeEmbed(q, IX.dim);
  if (!CFG.geminiKey) throw new Error("Geminiキー未設定");
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent", {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": CFG.geminiKey },
    body: JSON.stringify({ model: "models/gemini-embedding-001", content: { parts: [{ text: q }] }, taskType: "RETRIEVAL_QUERY", outputDimensionality: IX.dim })
  });
  if (!r.ok) throw new Error("Gemini " + r.status);
  const v = new Float32Array((await r.json()).embedding.values); let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n; return v;
}
function snippet(text, q, w = 170) {
  const t = text.replace(/\s+/g, " "), tn = norm(t); const words = [...new Set(q.split(/[\s　]+/).filter(Boolean).map(norm))].sort((a, b) => b.length - a.length);
  let p = -1; for (const x of words) { p = tn.indexOf(x); if (p >= 0) break; }
  if (p < 0) for (const g of grams(q)) { p = tn.indexOf(g); if (p >= 0) break; }
  p = Math.max(p, 0); const s = Math.max(0, p - 40);
  return (s ? "…" : "") + t.slice(s, s + w) + (s + w < t.length ? "…" : "");
}
async function search(q, f) {
  const t0 = performance.now(); const files = IX.files, N = IX.N;
  const fm = new Uint8Array(files.length);
  files.forEach((x, i) => { fm[i] = !x.dead && (!f.src || x.grp === f.src) && (!f.top1 || (x.top1 || "(直下)") === f.top1) && (!f.top2 || (x.top2 || "(直下)") === f.top2) && (!f.ext || x.ext === f.ext) && (x.src === SRC_BOOK || x.year >= (f.year || 0)) ? 1 : 0; });
  const mask = new Uint8Array(N); for (let i = 0; i < N; i++) mask[i] = fm[IX.fid[i]];
  const qn = norm(q), qg = [...new Set(grams(q))];
  const sb = bm25(q, mask); const cand = new Map(); const K = 60, M = 300;
  topK(sb, M, (i, s) => s > 0).forEach((i, r) => cand.set(i, (cand.get(i) || 0) + 1 / (K + r + 1)));
  let mode = "keyword", err = "";
  try {
    const qv = await embedQuery(q); const dim = IX.dim, sd = new Float32Array(N).fill(-9); const Q = IX.Q;
    for (let i = 0; i < N; i++) { if (!mask[i]) continue; let s = 0, o = i * dim; for (let j = 0; j < dim; j++) s += Q[o + j] * qv[j]; sd[i] = s * IX.S[i]; }
    topK(sd, M, (i, s) => s > -5).forEach((i, r) => cand.set(i, (cand.get(i) || 0) + 1 / (K + r + 1)));
    mode = "hybrid";
  } catch (e) { err = String(e.message || e); }
  const byf = new Map();
  for (const [i, s] of cand) { const fi = IX.fid[i]; if (!byf.has(fi)) byf.set(fi, []); byf.get(fi).push([s, i]); }
  const res = [];
  for (const [fi, lst] of byf) {
    lst.sort((a, b) => b[0] - a[0]); const x = files[fi];
    let sc = lst[0][0] + (lst.length > 1 ? 0.25 * lst[1][0] : 0) + (lst.length > 2 ? 0.1 * lst[2][0] : 0);
    if (x.ptxt.includes(qn)) sc += 0.010; else if (qg.length) sc += 0.006 * qg.filter(g => x.ptxt.includes(g)).length / qg.length;
    if (f.prefNew && x.src === SRC_HOSP) sc *= Math.max(0.8, 1 - 0.02 * Math.max(0, CUR_YEAR - x.year));
    if (x.rel.includes("未分類")) sc *= 0.97;
    res.push([sc, fi, lst]);
  }
  res.sort((a, b) => b[0] - a[0]); const mx = res.length ? res[0][0] : 1; const out = [];
  for (const [sc, fi, lst] of res.slice(0, 30)) {
    const x = files[fi]; const best = await chunkAt(lst[0][1]); const seen = new Set([best[1] + ":" + best[2]]); const others = [];
    for (const [, i] of lst.slice(1, 12)) { if (others.length >= 4) break; const c = await chunkAt(i); const k = c[1] + ":" + c[2]; if (!seen.has(k)) { seen.add(k); others.push({ loc: locLabel(c[1], c[2]), page: (c[1] === "p" || c[1] === "s") ? c[2] : 0 }); } }
    out.push({ file: x, score: Math.round(100 * sc / mx), loc: locLabel(best[1], best[2]), page: best[1] === "p" ? best[2] : (best[1] === "s" ? best[2] : 0), snip: snippet(best[3], q), others });
  }
  return { results: out, total: res.length, mode, err, ms: Math.round(performance.now() - t0), terms: q.split(/[\s　]+/).filter(Boolean) };
}

/* ---------- 画面 ---------- */
function setStat(t) { $("stat").textContent = t; }
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function hl(el, text, terms) {
  const ts = terms.filter(Boolean).map(esc); if (!ts.length) { el.textContent = text; return; }
  const re = new RegExp("(" + ts.join("|") + ")", "gi");
  text.split(re).forEach((p, i) => { if (i % 2) { const m = document.createElement("mark"); m.textContent = p; el.appendChild(m); } else el.appendChild(document.createTextNode(p)); });
}
function tree() {
  const s = $("src").value, m = {}; IX.files.forEach(f => { if (f.dead || (s && f.grp !== s)) return; const a = f.top1 || "(直下)", b = f.top2 || "(直下)"; m[a] = m[a] || {}; m[a][b] = (m[a][b] || 0) + 1; }); return m;
}
function fillT1() { const t = $("t1"); t.innerHTML = '<option value="">すべての分類</option>'; Object.keys(tree()).sort().forEach(k => { const o = document.createElement("option"); o.value = o.textContent = k; t.appendChild(o); }); $("t2").innerHTML = '<option value="">すべての科/種別</option>'; }
function filters() { return { src: $("src").value, top1: $("t1").value, top2: $("t2").value, ext: $("ext").value, year: +$("yf").value, prefNew: $("pn").checked }; }
async function run() {
  const q = $("q").value.trim(); if (!q || !IX) return; setStat("検索中…");
  let r; try { r = await search(q, filters()); } catch (e) { setStat("検索エラー: " + e.message); return; }
  setStat(r.total + "件の資料がヒット（上位" + r.results.length + "件）　方式: " + (r.mode === "hybrid" ? "キーワード＋意味検索" : "キーワードのみ" + (r.err ? "（意味検索不可: " + r.err + "）" : "")) + "　" + r.ms + "ms");
  const box = $("res"); box.innerHTML = ""; if (!r.results.length) { box.innerHTML = '<div class="empty">該当なし</div>'; return; }
  r.results.forEach((x, i) => {
    const c = document.createElement("div"); c.className = "card";
    const rk = document.createElement("div"); rk.className = "rk"; rk.textContent = i + 1;
    const m = document.createElement("div"); m.className = "main";
    const t = document.createElement("div"); t.className = "title"; t.textContent = x.file.name;
    const me = document.createElement("div"); me.className = "meta"; const folder = x.file.path.split("/").slice(0, -1).join("/");
    me.textContent = (x.file.src === SRC_BOOK ? (x.file.grp === GRP_RN ? "📓 " : "📚 参考書 ・ ") : "") + (folder || (x.file.src === SRC_BOOK ? "参考書" : "")) + (x.file.src === SRC_BOOK ? "" : " ・ " + x.file.year + "年頃");
    if (x.file.size) { const sz = document.createElement("span"); sz.className = "sz"; sz.textContent = "　" + fmtSize(x.file.size); me.appendChild(sz); }
    const sn = document.createElement("div"); sn.className = "snip"; hl(sn, x.snip, r.terms);
    const ch = document.createElement("div"); ch.className = "chips";
    const b = document.createElement("span"); b.className = "chip best"; b.textContent = "最有力: " + x.loc; b.onclick = () => openFile(x.file, x.page); ch.appendChild(b);
    x.others.forEach(o => { const s = document.createElement("span"); s.className = "chip"; s.textContent = o.loc; s.onclick = () => openFile(x.file, o.page); ch.appendChild(s); });
    const br = document.createElement("div"); br.className = "bar"; br.innerHTML = "<i style='width:" + x.score + "%'></i>";
    m.append(t, me, sn, ch, br);
    const ac = document.createElement("div"); ac.className = "act";
    const o1 = document.createElement("button"); o1.textContent = "開く"; o1.onclick = () => openFile(x.file, x.page);
    const o2 = document.createElement("button"); o2.className = "sub"; o2.textContent = "Driveで開く"; o2.onclick = () => openInDrive(x.file);
    ac.append(o1, o2); if (x.file.ext === "pdf") { const o3 = document.createElement("button"); o3.className = "sub"; o3.textContent = saveLabel(x.file); o3.onclick = () => toggleSave(x.file, o3); ac.append(o3); }
    c.append(rk, coverEl(x.file, () => openFile(x.file, x.page)), m, ac); box.appendChild(c);
  });
}

/* ---------- 表紙 ---------- */
function coverEl(f, onclick) {
  let u = IX.covUrl.get(f.rel);
  const cbuf = f.cv && IX.covs[f.cvf || IX.man.covers];
  if (!u && cbuf) { u = URL.createObjectURL(new Blob([new Uint8Array(cbuf, f.cv[0], f.cv[1])], { type: "image/jpeg" })); IX.covUrl.set(f.rel, u); }
  let e;
  if (u) { e = document.createElement("img"); e.className = "cv"; e.src = u; e.alt = ""; e.loading = "lazy"; }
  else { e = document.createElement("div"); e.className = "cv0"; e.textContent = f.ext.toUpperCase(); }
  e.onclick = onclick; return e;
}

/* ---------- ファイルを開く ---------- */
async function openInDrive(f) {
  try { const id = await resolveDriveId(f); window.open("https://drive.google.com/file/d/" + id + "/view", "_blank"); } catch (e) { setStat(e.message); }
}
let PDFLIB = null, CUR = null;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("pdf.jsを読み込めません（ネット接続を確認）")); document.head.appendChild(s); }); }
async function openFile(f, page) {
  const resume = { q: $("q").value, open: { rel: f.rel, page } };
  let sv = f.ext === "pdf" && SAVED.get(f.rel), rcache = false;
  if (!sv && f.ext === "pdf") { const m = await idbGet("kv", "rcm:" + f.rel).catch(() => null); if (m) { sv = m; rcache = true; } }
  if (sv) {   // 保存済み・最近開いた本: ログインもDriveも使わず開く
    try {
      const blob = await idbGet("kv", (rcache ? "rcd:" : "offd:") + f.rel);
      if (blob && rcache) idbPut("kv", "rcm:" + f.rel, Object.assign({}, sv, { t: Date.now() })).catch(() => {});
      if (!blob && rcache) await rcDel(f.rel);
      if (blob) {
        $("viewer").style.display = "flex"; $("vtitle").textContent = f.name; $("vstat").textContent = "読み込み中…"; $("vsave").textContent = saveLabel(f);
        if (!window.pdfjsLib) await loadScript(PDFJS); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        if (CUR && CUR.io) CUR.io.disconnect();
        CUR = { doc, f, id: sv.id, zoom: 1 }; await buildPages(Math.min(Math.max(page || 1, 1), doc.numPages)); return;
      }
    } catch (e) { $("viewer").style.display = "none"; setStat("保存データを開けませんでした。Driveから開きます: " + e.message); }
  }
  try {
    await needToken(resume); const id = await resolveDriveId(f);
    if (f.ext !== "pdf") { window.open("https://drive.google.com/file/d/" + id + "/view", "_blank"); return; }
    $("viewer").style.display = "flex"; $("vtitle").textContent = f.name; $("vstat").textContent = "読み込み中…"; $("vsave").textContent = saveLabel(f);
    if (!window.pdfjsLib) { await loadScript(PDFJS); }
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const tok = getToken(); const url = API + "files/" + id + "?alt=media"; let doc;
    try { doc = await pdfjsLib.getDocument({ url, httpHeaders: { Authorization: "Bearer " + tok }, rangeChunkSize: 1 << 20, disableAutoFetch: true }).promise; }
    catch (e) {
      const blob = await downloadBlob(id, (g, t) => { $("vstat").textContent = "ダウンロード中 " + Math.round(g / 1e6) + (t ? " / " + Math.round(t / 1e6) : "") + " MB"; });
      if (blob.size <= RC_ONE) rcStore(f, id, blob);
      doc = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    }
    if (CUR && CUR.io) CUR.io.disconnect();
    CUR = { doc, f, id, zoom: 1 }; rcFetch(f, id); await buildPages(Math.min(Math.max(page || 1, 1), doc.numPages));
  } catch (e) { $("vstat").textContent = "開けません: " + e.message; setStat("開けません: " + e.message); }
}
/* 連続スクロール表示: 全ページ分の枠を作り、画面の近くのページだけ描画する */
async function buildPages(n) {
  const box = $("vbody"), wrap = $("vpages"), doc = CUR.doc; wrap.innerHTML = "";
  const p1 = await doc.getPage(1), v1 = p1.getViewport({ scale: 1 });
  const cssW = Math.max(120, (box.clientWidth - 8) * (CUR.zoom || 1)); CUR.cssW = cssW;
  const h0 = Math.round(cssW * v1.height / v1.width); CUR.pgs = [];
  const fr = document.createDocumentFragment();
  for (let i = 1; i <= doc.numPages; i++) { const d = document.createElement("div"); d.className = "pg"; d.dataset.n = i; d.style.width = cssW + "px"; d.style.height = h0 + "px"; fr.appendChild(d); CUR.pgs.push(d); }
  wrap.appendChild(fr);
  if (CUR.io) CUR.io.disconnect();
  CUR.io = new IntersectionObserver(es => es.forEach(e => e.isIntersecting ? renderPg(e.target) : releasePg(e.target)), { root: box, rootMargin: "1400px 0px" });
  CUR.pgs.forEach(d => CUR.io.observe(d));
  goPage(n);
}
async function renderPg(d) {
  if (d._r || !CUR) return; d._r = 1; const tok = d._tok = (d._tok || 0) + 1, cur = CUR;
  try {
    const page = await cur.doc.getPage(+d.dataset.n); if (CUR !== cur || d._tok !== tok) return;
    const sc = cur.cssW / page.getViewport({ scale: 1 }).width, dpr = Math.min(window.devicePixelRatio || 1, 2), vp = page.getViewport({ scale: sc * dpr });
    const cv = document.createElement("canvas"); cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise; if (CUR !== cur || d._tok !== tok) return;
    d.style.height = Math.round(vp.height / dpr) + "px"; d.replaceChildren(cv);
    if (cur.align && +d.dataset.n <= cur.align) realign();
  } catch (e) { d._r = 0; }
}
function releasePg(d) { if (!d._r) return; d._tok = (d._tok || 0) + 1; d._r = 0; const c = d.firstChild; if (c) { c.width = c.height = 0; } d.replaceChildren(); }
function realign() { if (!CUR || !CUR.align) return; const d = CUR.pgs[CUR.align - 1], box = $("vbody"); if (d && Math.abs(box.scrollTop - d.offsetTop) > 2) { CUR.setting = 1; box.scrollTop = d.offsetTop; } }
function goPage(n) {
  if (!CUR) return; n = Math.min(Math.max(n, 1), CUR.doc.numPages); CUR.n = n; CUR.align = n;
  const box = $("vbody"); CUR.setting = 1; box.scrollTop = CUR.pgs[n - 1].offsetTop; showPos();
  setTimeout(realign, 500); setTimeout(realign, 1500); setTimeout(() => { if (CUR && CUR.align === n) CUR.align = 0; }, 2500);
}
function curPageFromScroll() {
  const box = $("vbody"), y = box.scrollTop + box.clientHeight * 0.3, P = CUR.pgs; let lo = 0, hi = P.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (P[m].offsetTop <= y) lo = m; else hi = m - 1; } return lo + 1;
}
function showPos() { $("vpage").value = CUR.n; $("vstat").textContent = CUR.n + " / " + CUR.doc.numPages; }
let scrollT = 0;
function onVScroll() {
  if (!CUR || !CUR.pgs) return; if (CUR.setting) { CUR.setting = 0; return; }
  if (CUR.align) CUR.align = 0;   // 利用者が動かしたら、自動の位置合わせはやめる
  if (scrollT) return; scrollT = requestAnimationFrame(() => { scrollT = 0; if (CUR && CUR.pgs) { CUR.n = curPageFromScroll(); showPos(); } });
}
function setZoom(z) { if (!CUR) return; const n = CUR.n; CUR.zoom = z; buildPages(n); }

/* ---------- 設定 ---------- */
function openSettings() {
  $("s_cid").value = CFG.clientId; $("s_key").value = CFG.geminiKey; $("s_fold").value = CFG.indexFolder; $("s_rh").value = CFG.rootHosp; $("s_rb").value = CFG.rootBook; $("s_fake").checked = CFG.fake; $("s_hint").value = CFG.loginHint || "";
  $("s_redir").textContent = redirectUri(); $("settings").style.display = "block"; renderSaved();
}
function bind() {
  $("go").onclick = run; $("q").addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) run(); });
  $("src").onchange = () => { fillT1(); if ($("q").value) run(); };
  $("t1").onchange = () => { const t = $("t2"); t.innerHTML = '<option value="">すべての科/種別</option>'; const m = tree()[$("t1").value] || {}; Object.keys(m).sort().forEach(k => { const o = document.createElement("option"); o.value = k; o.textContent = k + " (" + m[k] + ")"; t.appendChild(o); }); if ($("q").value) run(); };
  ["t2", "ext", "yf", "pn"].forEach(i => $(i).onchange = () => { if ($("q").value) run(); });
  $("setbtn").onclick = openSettings; $("s_close").onclick = () => { $("settings").style.display = "none"; };
  $("s_save").onclick = () => { CFG.clientId = $("s_cid").value.replace(/\s+/g, "");   // 空白・改行は取り除く
    const okId = /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(CFG.clientId); CFG.geminiKey = $("s_key").value.trim(); CFG.indexFolder = $("s_fold").value.trim() || DEF.indexFolder; CFG.rootHosp = $("s_rh").value.trim() || DEF.rootHosp; CFG.rootBook = $("s_rb").value.trim() || DEF.rootBook; CFG.fake = $("s_fake").checked; CFG.loginHint = $("s_hint").value.trim(); saveCfg(); $("settings").style.display = "none"; setStat(CFG.clientId && !okId ? "⚠ Client IDの形がおかしいです（「数字-英数字.apps.googleusercontent.com」の1行）。Google Cloudからコピーし直してください" : "設定を保存しました"); };
  $("syncbtn").onclick = async () => { try { if (await syncIndex()) { if (await loadIndex()) afterLoad(); } } catch (e) { setStat("取り込み失敗: " + e.message); } };
  $("vclose").onclick = () => { $("viewer").style.display = "none"; if (CUR && CUR.io) CUR.io.disconnect(); $("vpages").innerHTML = ""; CUR = null; };
  $("vprev").onclick = () => CUR && goPage(CUR.n - 1); $("vnext").onclick = () => CUR && goPage(CUR.n + 1);
  $("vbody").addEventListener("scroll", onVScroll, { passive: true }); $("vbody").addEventListener("touchstart", () => { if (CUR) CUR.align = 0; }, { passive: true });
  let rz = 0; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (CUR && CUR.pgs && $("viewer").style.display !== "none") buildPages(CUR.n); }, 400); });
  $("vpage").onchange = () => CUR && goPage(+$("vpage").value || 1);
  $("vzin").onclick = () => CUR && setZoom(Math.min((CUR.zoom || 1) * 1.25, 4));
  $("vzout").onclick = () => CUR && setZoom(Math.max((CUR.zoom || 1) / 1.25, 0.5));
  $("vsave").onclick = () => CUR && toggleSave(CUR.f, $("vsave"));
  $("vdrive").onclick = () => CUR && window.open("https://drive.google.com/file/d/" + CUR.id + "/view", "_blank");
}
function afterLoad() {
  const c = {}; IX.files.forEach(f => { if (!f.dead) c[f.grp] = (c[f.grp] || 0) + 1; });
  $("info").textContent = "院内 " + (c[SRC_HOSP] || 0) + " ／ レジデントノート " + (c[GRP_RN] || 0) + " ／ 参考書 " + (c[SRC_BOOK] || 0) + " ファイル・" + IX.N + "箇所";
  fillT1(); setStat("");
}
async function boot() {
  bind(); await loadSaved(); if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const ar = handleAuthReturn(); let resume = null;
  try { resume = JSON.parse(sessionStorage.getItem("hs_resume") || "null"); sessionStorage.removeItem("hs_resume"); } catch (e) {}
  if (ar && ar !== "ok") { if (ar === "login_required" || ar === "interaction_required" || ar === "consent_required") { try { localStorage.removeItem("hs_tried"); } catch (e) {} setStat("Googleへのログインが必要です。「索引を更新」か「開く」を押してください。"); } else setStat("ログインに失敗しました: " + ar); }
  let ok = false; try { ok = await loadIndex(); } catch (e) { setStat("索引の読み込みに失敗: " + e.message); }
  if (ok) afterLoad();
  else if (!CFG.clientId) { setStat("初回設定: 右上の「設定」でClient IDなどを入れ、「索引を更新」を押してください"); }
  else if (ar === "ok") { try { if (await syncIndex() && await loadIndex()) afterLoad(); } catch (e) { setStat("取り込み失敗: " + e.message); } }
  else setStat("索引がありません。「索引を更新」を押してください。");
  if (resume && resume.q && IX) { $("q").value = resume.q; await run(); if (resume.open && ar === "ok") { const f = IX.files.find(x => x.rel === resume.open.rel && !x.dead); if (f) openFile(f, resume.open.page); } }
}
window.addEventListener("load", boot);
window.__hs = { grams, bm25: (q) => bm25(q, new Uint8Array(IX.N).fill(1)), search: (q, f) => search(q, Object.assign({ src: "", top1: "", top2: "", ext: "", year: 0, prefNew: true }, f || {})), get IX() { return IX; }, loadIndex, syncIndex, CFG };
