"use strict";
/* 院内資料・参考書 検索 (iPad版)  索引はGoogle Driveから取り込み、iPad内で検索する */
const $ = id => document.getElementById(id);
const CUR_YEAR = new Date().getFullYear();
const SCOPE = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";   // 読み取り＋このアプリが作ったファイル（マイフォルダの共有用）
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const fmtSize = n => !n ? "" : (n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB") + "（" + n.toLocaleString("ja-JP") + " バイト）";
const SRC_HOSP = "院内資料", SRC_BOOK = "参考書", GRP_RN = "雑誌", SRC_NOTE = "ノート";
const isMag = f => f.src === SRC_BOOK && (f.top1 === "雑誌" || f.top1 === "レジデントノート");
const grpOf = (f) => isMag(f) ? GRP_RN : f.src;   // 区分: 院内資料 / レジデントノート / 参考書

/* ---------- 設定 ---------- */
const DEF = { clientId: "728337361784-l408enh4jdvp889ino0ig58u0e6ls1ks.apps.googleusercontent.com",   // Client IDは公開してよい値（秘密ではない）
   geminiKey: "", indexFolder: "院内検索_iPad索引", rootHosp: "St Lukes", rootBook: "参考書", fake: false, loginHint: "", folderKey: "" };
let CFG = Object.assign({}, DEF);
try { Object.assign(CFG, JSON.parse(localStorage.getItem("hs_cfg") || "{}")); } catch (e) {}
if (!CFG.clientId) CFG.clientId = DEF.clientId;
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
    try { localStorage.setItem("hs_tok", JSON.stringify({ t: p.get("access_token"), exp: Date.now() + (+p.get("expires_in") || 3600) * 1000, sc: p.get("scope") || "" })); } catch (e) {}
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
const RC_MAX = 1.2e9, RC_DAYS = 7, RC_ONE = 300e6, RCING = new Set();
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
async function renderRc() {
  const box = $("s_rc"); if (!box) return; box.innerHTML = "";
  try {
    const R = await rcList(), tot = R.reduce((a, m) => a + m.size, 0); let est = "";
    try { const e = await navigator.storage.estimate(); est = "　端末の使用量 " + Math.round(e.usage / 1e6) + "MB"; } catch (e) {}
    const sp = document.createElement("span"); sp.style.cssText = "flex:1;font-size:13px"; sp.textContent = "自動保存 " + R.length + "冊・" + Math.round(tot / 1e6) + "MB（上限1.2GB・7日で自動削除）" + est;
    const b = document.createElement("button"); b.className = "sub"; b.textContent = "全部消す"; b.onclick = async () => { if (!R.length || !confirm("最近開いた本の自動保存（" + R.length + "冊）をすべて消しますか？（Driveの元ファイルや、📥保存した本は消えません）")) return; for (const m of R) await rcDel(m.rel); renderRc(); };
    const row = document.createElement("div"); row.className = "row"; row.append(sp, b); box.appendChild(row);
  } catch (e) {}
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
  if (byName.has("vocab.json.gz")) { need.push("vocab.json.gz"); optional.add("vocab.json.gz"); }   /* 入力補助の用語集 */
  let nman = null, nkeep = false, nimgmap = null;   /* UpNoteのノートだけの小さな索引。友達と共有しない別フォルダ「院内検索_ノート索引」にある（Macが自動で更新する）。無い端末（友達など）では、ノート無しで動く */
  try { const nf = await findChild("root", "院内検索_ノート索引", true);
    if (nf) { const nl = await listChildren(nf.id); nl.forEach(x => byName.set(x.name, x)); const nmf = nl.find(x => x.name === "notes_manifest.json"); nimgmap = {}; nl.forEach(x => { const q = /^nimg_(.+)\.bin$/.exec(x.name); if (q) nimgmap[q[1]] = { id: x.id, md5: x.md5Checksum }; });   /* ノート画像の一覧だけ控える（本体はノートを開いたときに取得） */
      if (nmf) { nman = JSON.parse(new TextDecoder().decode(await downloadBuf(nmf.id))); for (const s of nman.shards) need.push(s.c, s.v); for (const sg of nman.segs) need.push(sg.bm25.terms, sg.bm25.post, sg.bm25.dl); if (nman.html) { need.push(nman.html); optional.add(nman.html); } } } } catch (e) { nman = null; nkeep = true; }   /* 通信の失敗では、前に取り込んだノートを消さない */
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
  if (nman) { await idbPut("kv", "nmanifest", nman); await idbPut("kv", "nimgmap", nimgmap || {}); try { for (const k of await idbKeys("kv")) if (typeof k === "string" && k.startsWith("nimg:") && !(nimgmap && nimgmap[k.slice(5)])) await idbDel("kv", k); } catch (e) {} } else if (!nkeep) { await idbDel("kv", "nmanifest"); await idbDel("kv", "nimgmap"); }
  setStat(todo.length ? "索引を更新しました（" + todo.length + " ファイル）" : "索引は最新です");
  return true;
}

/* ---------- 索引の読み込み ---------- */
// 索引は「本体＋追加分(セグメント)」の集まり。旧形式(v1)は、全体を1つの本体として扱う
/* コアカンの年度: 所属フォルダ「コアカン 2024年度」やファイル名から決める（索引の年度が不正確なため） */
/* 章ごとに区切ったファイル → 本全体のファイル（フォルダ作成では本全体だけを表示し、選ぶと章別ファイルも一緒に対象にする） */
const CHAPTERS = [
  { parent: "内科レジデントの鉄則 第4版.pdf", dir: "内科レジデントの鉄則/" },
  { parent: "レジデントのための感染症診療の鉄則.pdf", dir: "感染症診療の鉄則/" },
  { parent: "1-USMLE Step 1 2023.pdf", names: ["Immunology", "biochemistry", "cardiology", "dermatology", "endocrine", "gastrointestinal", "hematology", "microbiology", "nurology", "parmacology", "pathology", "psychiatry", "public health", "renal", "reproductive", "respiratory"].map(n => n + ".pdf") },
  { parent: "Year Note 2024.pdf", dir: "Year Note 2024/", ex: "過去問/" },
  { parent: "レビューブック-内科外科.pdf", dir: "レビューブック-内科外科/" },
  { parent: "レビューブック-マイナー.pdf", dir: "レビューブック-マイナー/" },
  { parent: "レビューブック-公衆衛生.pdf", dir: "レビューブック-公衆衛生/" },
  { parent: "レビューブック-小児科.pdf", dir: "レビューブック-小児科/" },
  { parent: "レビューブック-産婦人科.pdf", dir: "レビューブック-産婦人科/" },
];
function fixChapters(files) {
  const P = "@参考書/", by = new Map(files.filter(f => !f.dead).map(f => [(f.rel || "").normalize("NFC"), f]));
  CHAPTERS.forEach(g => {
    const par = by.get(P + g.parent); if (!par) return; par.nchap = 0;
    files.forEach(f => { if (f.dead || f === par || f.src !== SRC_BOOK) return; const r = (f.rel || "").normalize("NFC");
      if ((g.dir && r.startsWith(P + g.dir) && !(g.ex && r.startsWith(P + g.dir + g.ex))) || (g.names && g.names.some(n => r === P + n))) { f.parentRel = par.rel; par.nchap++; } });
  });
}
function fixCoreYear(f) {
  const t = (f.rel || f.path || "").normalize("NFC"); if (!/コアカン/.test(t)) return;
  f.core = true;
  const m = t.match(/コアカン\s*(20\d\d)\s*年度/) || t.match(/(20\d\d)\s*年度\s*コアカン/) || t.match(/コアカンファレンス\s*(20\d\d)/) || t.match(/(20\d\d)\s*コアカン/);
  if (m) f.year = +m[1]; else if (!(f.year >= 2015)) f.year = 2020;
}
function segsOf(man) {
  if (man.segs) return man.segs;
  return [{ id: 0, start: 0, n: man.nchunks, f0: 0, nfiles: man.files.length, covers: man.covers || "", bm25: { terms: man.bm25.terms, post: man.bm25.post, dl: man.bm25.dl, sumdl: man.bm25.avg * man.nchunks } }];
}
let IX = null;
async function gunzipText(buf) {
  const ds = new DecompressionStream("gzip"); const w = ds.writable.getWriter(); w.write(new Uint8Array(buf)); w.close();
  return new Response(ds.readable).text();
}
/* ノートの索引を、本の索引の後ろにつなぐ（ファイル番号・箇所の番号をずらす） */
function mergeNotes(man, nm) {
  const nb = man.nchunks, nf = man.files.length;
  return Object.assign({}, man, { nchunks: nb + nm.nchunks, files: man.files.concat(nm.files), shards: man.shards.concat(nm.shards.map(s => Object.assign({}, s, { start: s.start + nb }))), segs: segsOf(man).concat(nm.segs.map(g => Object.assign({}, g, { start: g.start + nb, f0: g.f0 + nf }))) });
}
async function loadIndex() {
  let man = await idbGet("kv", "manifest"); if (!man) return false;
  try { const nm = await idbGet("kv", "nmanifest"); if (nm && nm.files && nm.files.length && nm.dim === man.dim && nm.segs && nm.segs.length) { let ok = true; for (const x of [...nm.shards.flatMap(s => [s.c, s.v]), ...nm.segs.flatMap(g => [g.bm25.terms, g.bm25.post, g.bm25.dl])]) if (!(await idbGet("blobs", x))) ok = false; if (ok) man = mergeNotes(man, nm); } } catch (e) {}
  setStat("索引を読み込み中…（起動直後は10〜30秒かかります）");
  const dim = man.dim, N = man.nchunks;
  const Q = new Int8Array(N * dim), S = new Float32Array(N);
  for (const sh of man.shards) {
    const b = await idbGet("blobs", sh.v); if (!b) return false;
    Q.set(new Int8Array(b.data, 0, sh.n * dim), sh.start * dim);
    S.set(new Float32Array(b.data.slice(sh.n * dim, sh.n * dim + sh.n * 4)), sh.start);
  }
  const fid = new Int32Array(N); let p = 0;
  man.files.forEach((f, i) => { fid.fill(i, p, p + f.n); p += f.n; f.ptxt = norm(f.path.replace(/\.[^./]+$/, "")); f.grp = grpOf(f); fixCoreYear(f); });
  fixChapters(man.files);
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
  files.forEach((x, i) => { fm[i] = !x.dead && inScope(x, f.src) && (!f.top1 || (x.top1 || "(直下)") === f.top1) && (!f.top2 || (x.top2 || "(直下)") === f.top2) && (!f.ext || x.ext === f.ext) && (x.src === SRC_BOOK || x.year >= (f.year || 0)) ? 1 : 0; });
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
    if (f.prefNew && x.core) sc *= 1 + 0.06 * Math.max(0, x.year - 2019);   // コアカンは新しい年度ほど上に出す
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

/* ---------- 開いている本の中だけを検索（索引を使う。キーワード＋意味検索） ---------- */
async function searchInFile(q, rel) {
  const fi = IX.files.findIndex(x => x.rel === rel && !x.dead); if (fi < 0) return { results: [], mode: "none", terms: [] };
  let s0 = -1, s1 = -1; for (let i = 0; i < IX.N; i++) if (IX.fid[i] === fi) { if (s0 < 0) s0 = i; s1 = i; }
  if (s0 < 0) return { results: [], mode: "none", terms: [] };
  const mask = new Uint8Array(IX.N); mask.fill(1, s0, s1 + 1); const cand = new Map(), K = 60;
  topK(bm25(q, mask), 200, (i, s) => s > 0).forEach((i, r) => cand.set(i, (cand.get(i) || 0) + 1 / (K + r + 1)));
  let mode = "keyword";
  try {
    const qv = await embedQuery(q), dim = IX.dim, sd = new Float32Array(IX.N).fill(-9);
    for (let i = s0; i <= s1; i++) { let s = 0, o = i * dim; for (let j = 0; j < dim; j++) s += IX.Q[o + j] * qv[j]; sd[i] = s * IX.S[i]; }
    topK(sd, 200, (i, s) => s > -5).forEach((i, r) => cand.set(i, (cand.get(i) || 0) + 1 / (K + r + 1))); mode = "hybrid";
  } catch (e) {}
  const order = [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60), out = [], seen = new Set();
  for (const [i] of order) { const c = await chunkAt(i), key = c[1] + ":" + c[2]; if (seen.has(key)) continue; seen.add(key); out.push({ page: (c[1] === "p" || c[1] === "s") ? c[2] : 0, loc: locLabel(c[1], c[2]), snip: snippet(c[3], q, 130) }); if (out.length >= 15) break; }
  return { results: out, mode, terms: q.split(/[\s　]+/).filter(Boolean) };
}
function showVsp(on) {   // 検索結果の欄（幅が広いときは左、狭いときは上）。本の幅が変わるので、広いときは描き直す
  const p = $("vsp"); if (p.classList.contains("open") === on) return; p.classList.toggle("open", on);
  if (CUR && window.innerWidth >= 700) setTimeout(() => CUR && buildPages(CUR.n), 60);
}
async function runVSearch() {
  const q = $("vq").value.trim(), box = $("vres"); if (!q || !CUR) return; box.textContent = "検索中…"; showVsp(true);
  const rel = CUR.f.rel, r = await searchInFile(q, rel); if (!CUR || CUR.f.rel !== rel) return; box.innerHTML = ""; CUR.terms = r.terms; rehighlight();
  if (!r.results.length) { box.textContent = "この本の中に、見つかりませんでした"; return; }
  const h = document.createElement("div"); h.className = "vhint"; h.textContent = r.results.length + "か所（" + (r.mode === "hybrid" ? "キーワード＋意味検索" : "キーワードのみ") + "）　タップでそのページへ"; box.appendChild(h);
  r.results.forEach(x => {
    const row = document.createElement("div"); row.className = "vrow"; const b = document.createElement("b"); b.textContent = x.loc; const sn = document.createElement("div"); hl(sn, x.snip, r.terms);
    row.append(b, sn); if (x.page > 0) row.onclick = () => { goPage(x.page); if (window.innerWidth < 700) showVsp(false); }; box.appendChild(row);
  });
}
/* ---------- 入力補助（医学用語の候補）: ひらがなや先頭の数文字から、索引に出てくる用語（漢字・カタカナ・英語）を提案する ---------- */
let VOC = null;
async function loadVocab() {
  try { const b = await idbGet("blobs", "vocab.json.gz"); if (!b) { VOC = null; return; }
    const j = JSON.parse(await gunzipText(b.data)).t; VOC = { t: j.map(x => x[0]), tl: j.map(x => x[0].toLowerCase()), r: j.map(x => x[1] || "") }; } catch (e) { VOC = null; }
}
const kata2hira = s => s.replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
function suggestFor(tok0) {
  if (!VOC) return []; const tok = kata2hira(tok0.normalize("NFKC").toLowerCase()); if (!tok) return [];
  const kana = /^[\u3041-\u3096\u30fc]+$/.test(tok); if ((kana || /^[a-z0-9\-]+$/.test(tok)) && tok.length < 2) return [];
  const out = [], seen = new Set(), N = VOC.t.length;
  const take = i => { if (seen.has(i) || VOC.t[i] === tok0) return; seen.add(i); out.push(VOC.t[i]); };
  for (let i = 0; i < N && out.length < 10; i++) if (kana ? VOC.r[i].startsWith(tok) : VOC.tl[i].startsWith(tok)) take(i);
  if (out.length < 10 && tok.length >= 2) for (let i = 0; i < N && out.length < 10; i++) if (kana ? VOC.r[i].includes(tok) : VOC.tl[i].includes(tok)) take(i);
  return out;
}
/* 予測変換のように、キーボードが出ているときは、候補を「キーボードの真上」に出す（出ていないときは、これまで通り検索窓の下） */
function placeSugg(box) {
  const vv = window.visualViewport; if (!vv) return; const kb = window.innerHeight - vv.height - vv.offsetTop;
  if (window.innerHeight - vv.height > 120) { box.classList.add("dock"); box.style.bottom = Math.max(0, kb) + "px"; } else { box.classList.remove("dock"); box.style.bottom = ""; }
}
if (window.visualViewport) ["resize", "scroll"].forEach(ev => window.visualViewport.addEventListener(ev, () => document.querySelectorAll(".sugg").forEach(b => { if (b.childElementCount) placeSugg(b); })));
function attachSuggest(inp, box) {
  const upd = () => {
    box.innerHTML = ""; const v = inp.value, i = Math.max(v.lastIndexOf(" "), v.lastIndexOf("　")); const L = suggestFor(v.slice(i + 1));
    L.forEach(term => { const b = document.createElement("button"); b.className = "sg"; b.textContent = term; b.onpointerdown = e => e.preventDefault();
      b.onclick = () => { inp.value = v.slice(0, i + 1) + term + " "; box.innerHTML = ""; inp.focus(); }; box.appendChild(b); });    if (L.length) placeSugg(box);
  };
  inp.addEventListener("input", upd); inp.addEventListener("focus", upd); inp.addEventListener("blur", () => setTimeout(() => { box.innerHTML = ""; }, 250));
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
  const s = $("src").value, m = {}; IX.files.forEach(f => { if (f.dead || !inScope(f, s)) return; const a = f.top1 || "(直下)", b = f.top2 || "(直下)"; m[a] = m[a] || {}; m[a][b] = (m[a][b] || 0) + 1; }); return m;
}
function fillT1() { const t = $("t1"); t.innerHTML = '<option value="">すべての分類</option>'; Object.keys(tree()).sort().forEach(k => { const o = document.createElement("option"); o.value = o.textContent = k; t.appendChild(o); }); $("t2").innerHTML = '<option value="">すべての科/種別</option>'; }
function updFBadge() {   // 絞り込みを閉じていても、使っている条件の数が分かるようにする
  const n = [$("t1").value, $("t2").value, $("ext").value, +$("yf").value ? 1 : 0, $("pn").checked ? 0 : 1].filter(Boolean).length;
  const open = $("filters").classList.contains("open"); const b = $("ftoggle");
  b.textContent = "絞り込み" + (n ? "（" + n + "件適用中）" : "") + (open ? " ▴" : " ▾"); b.classList.toggle("on", n > 0);
}
function filters() { return { src: $("src").value, top1: $("t1").value, top2: $("t2").value, ext: $("ext").value, year: +$("yf").value, prefNew: $("pn").checked }; }
async function run() {
  const q = $("q").value.trim(); if (!q || !IX) return; setStat("検索中…");
  let r; try { r = await search(q, filters()); } catch (e) { setStat("検索エラー: " + e.message); return; }
  setStat(r.total + "件の資料がヒット（上位" + r.results.length + "件）　方式: " + (r.mode === "hybrid" ? "キーワード＋意味検索" : "キーワードのみ" + (r.err ? "（意味検索不可: " + r.err + "）" : "")) + "　" + r.ms + "ms");
  const box = $("res"); box.innerHTML = ""; if (!r.results.length) { box.innerHTML = '<div class="empty">該当なし</div>'; return; }
  const wide = () => window.matchMedia("(min-width:900px)").matches;
  r.results.forEach((x, i) => {
    const c = document.createElement("div"); c.className = "card"; c.dataset.rel = x.file.rel;
    const cands = []; [{ page: x.page, loc: x.loc }, ...x.others].forEach(o => { if (o.page > 0 && !cands.some(k => k.page === o.page)) cands.push(o); });
    const open = p => { document.querySelectorAll("#res .card.sel").forEach(e => e.classList.remove("sel")); c.classList.add("sel"); openFile(x.file, p, { cands, overlay: false, terms: r.terms }); };
    const rk = document.createElement("div"); rk.className = "rk"; rk.textContent = i + 1;
    const m = document.createElement("div"); m.className = "main";
    const t = document.createElement("div"); t.className = "title"; t.textContent = x.file.src === SRC_NOTE ? x.file.name.replace(/\.note$/, "") : x.file.name; t.style.cursor = "pointer"; t.onclick = e => { e.stopPropagation(); open(x.page); };
    const me = document.createElement("div"); me.className = "meta"; const folder = x.file.path.split("/").slice(0, -1).join("/");
    me.textContent = (x.file.src === SRC_NOTE ? "📝 UpNote ・ " : "") + (x.file.src === SRC_BOOK ? (x.file.grp === GRP_RN ? "📓 " : "📚 参考書 ・ ") : "") + (folder || (x.file.src === SRC_BOOK ? "参考書" : "")) + (x.file.src === SRC_BOOK ? "" : (x.file.src === SRC_NOTE ? " ・ " + x.file.year + "年" : " ・ " + x.file.year + "年頃"));
    if (x.file.size) { const sz = document.createElement("span"); sz.className = "sz"; sz.textContent = "　" + fmtSize(x.file.size); me.appendChild(sz); }
    const sn = document.createElement("div"); sn.className = "snip"; hl(sn, x.snip, r.terms);
    const ch = document.createElement("div"); ch.className = "chips";
    if (x.file.src !== SRC_NOTE) { const b = document.createElement("span"); b.className = "chip best"; b.textContent = "最有力: " + x.loc; b.onclick = e => { e.stopPropagation(); open(x.page); }; ch.appendChild(b); }
    if (x.file.src !== SRC_NOTE) x.others.forEach(o => { const s = document.createElement("span"); s.className = "chip"; s.textContent = o.loc; s.onclick = e => { e.stopPropagation(); open(o.page); }; ch.appendChild(s); });
    m.append(t, me, sn, ch);
    if (x.file.src === SRC_NOTE) { const pp = x.file.path.split("/"), nd = document.createElement("div"); nd.className = "ndate"; nd.textContent = [pp.length > 2 ? pp[pp.length - 2] : "", x.file.year ? x.file.year + "年" : ""].filter(Boolean).join(" ・ "); m.appendChild(nd); }
    const ac = document.createElement("div"); ac.className = "act";
    const o1 = document.createElement("button"); o1.textContent = "開く"; o1.onclick = e => { e.stopPropagation(); open(x.page); };
    ac.append(o1);
    if (gnLink(x.file)) { const o2 = document.createElement("button"); o2.className = "sub"; o2.textContent = "GoodNotes（p." + (x.page || "-") + "をコピー）"; o2.onclick = e => { e.stopPropagation(); openGN(x.file, x.page); }; ac.append(o2); }
    if (x.file.src === SRC_NOTE && x.file.nid) { const o4 = document.createElement("button"); o4.className = "sub"; o4.textContent = "UpNoteで開く"; o4.onclick = e => { e.stopPropagation(); openUpNote(x.file); }; ac.append(o4); }
    if (x.file.ext === "pdf") { const o3 = document.createElement("button"); o3.className = "sub"; o3.textContent = saveLabel(x.file); o3.onclick = e => { e.stopPropagation(); toggleSave(x.file, o3); }; ac.append(o3); }
    c.onclick = () => open(x.page);   // カード全体をタップで最有力ページを開く（ページの札・ボタンは、それぞれの動作）
    c.append(rk, coverEl(x.file, e => { if (e) e.stopPropagation(); open(x.page); }), m, ac); box.appendChild(c);
  });
}

/* ---------- 表紙 ---------- */
/* UpNoteの公式アイコン（自分のMacのUpNoteアプリから取り出した画像。個人利用） */
const UPN_ICON = '<img src="icon-upnote.png" alt="UpNote" style="width:100%;height:100%;display:block">';
function coverEl(f, onclick) {
  let u = IX.covUrl.get(f.rel);
  const cbuf = f.cv && IX.covs[f.cvf || IX.man.covers];
  if (!u && cbuf) { u = URL.createObjectURL(new Blob([new Uint8Array(cbuf, f.cv[0], f.cv[1])], { type: "image/jpeg" })); IX.covUrl.set(f.rel, u); }
  let e;
  if (u) { e = document.createElement("img"); e.className = "cv"; e.src = u; e.alt = ""; e.loading = "lazy"; }
  else if (f.src === SRC_NOTE) { e = document.createElement("div"); e.className = "cv0 upn"; e.innerHTML = UPN_ICON; }
  else { e = document.createElement("div"); e.className = "cv0"; e.textContent = f.ext.toUpperCase(); }
  e.onclick = onclick; return e;
}

/* ---------- ファイルを開く ---------- */
/* GoodNotesで開く: 設定に「ファイル名=共有リンク」を1行ずつ書いた本だけ、GoodNotes（自分の既存の書類）で開く。リンクはこの端末にだけ保存する */
function gnLink(f) {
  let t = ""; try { t = localStorage.getItem("hs_gn") || ""; } catch (e) {}
  const nm = x => x.normalize("NFC").trim().toLowerCase().replace(/\.pdf$/, "");
  const me = nm(f.name || "");
  for (const l of t.split(/\n/)) { const i = l.indexOf("="); if (i < 1) continue; const k = nm(l.slice(0, i)), u = l.slice(i + 1).trim(); if (/^https?:\/\//.test(u) && (k === me || k === nm(f.rel || ""))) return u; }
  return null;
}
function openGN(f, page, web) {
  let u = gnLink(f); if (!u) return;
  u = u.replace("://share.goodnotes.com/", "://web.goodnotes.com/").replace(/#.*$/, "");
  if (web) { setStat("GoodNotesのWeb表示で開きます" + (page > 0 ? "（p." + page + "）" : "")); window.open(page > 0 ? u + "#page-" + page : u, "_blank"); return; }
  // アプリで開くときは、ページの指定ができない（アプリが「ページは削除されました」と出す）ため、ページ番号をコピーして、開いてから移動する
  if (page > 0) { try { navigator.clipboard.writeText(String(page)); } catch (e) {} }
  setStat("GoodNotesを開きます" + (page > 0 ? "（p." + page + " をコピーしました。開いたあと、ページ番号欄に貼り付けて移動できます）" : "")); window.open(u, "_blank");
}
function setVdrive(f) { const b = $("vdrive"); b.style.display = gnLink(f) ? "" : "none"; b.textContent = "GoodNotesで開く"; b.onclick = () => openGN(f, CUR && CUR.n); }
async function openInDrive(f) {
  try { const id = await resolveDriveId(f); window.open("https://drive.google.com/file/d/" + id + "/view", "_blank"); } catch (e) { setStat(e.message); }
}

/* ---------- マイフォルダ（よく使う本だけを検索するための自分用フォルダ。この端末に保存） ---------- */
let FOLDERS = [], DELETED = {}, FMSG = ""; const FSET = new Map();
const inScope = (x, s) => !s || (s.startsWith("f:") ? ((FSET.get(s) || new Set()).has(x.rel) || (!!x.parentRel && (FSET.get(s) || new Set()).has(x.parentRel))) : x.grp === s);
function loadFolders() { try { FOLDERS = JSON.parse(localStorage.getItem("hs_folders") || "[]"); DELETED = JSON.parse(localStorage.getItem("hs_fdel") || "{}"); } catch (e) { FOLDERS = []; DELETED = {}; } FOLDERS.forEach(f => { if (!f.t) f.t = 1; }); rebuildFSet(); }
function rebuildFSet() { FSET.clear(); FOLDERS.forEach(f => FSET.set("f:" + f.id, new Set(f.rels))); }
function saveFolders() { try { localStorage.setItem("hs_folders", JSON.stringify(FOLDERS)); localStorage.setItem("hs_fdel", JSON.stringify(DELETED)); } catch (e) { alert("フォルダを保存できませんでした（端末の保存が使えません）"); } rebuildFSet(); }
function folderCount(f) { return IX ? IX.files.filter(x => !x.dead && !x.parentRel && inScope(x, "f:" + f.id)).length : f.rels.length; }
function markSeg() { [...$("seg").children].forEach(b => b.classList.toggle("on", b.dataset.v === $("src").value)); }
function renderSeg() {
  const sel = $("src"), seg = $("seg"); seg.innerHTML = "";
  [...sel.options].filter(o => o.value.startsWith("f:")).forEach(o => o.remove());
  FOLDERS.forEach(f => { const o = document.createElement("option"); o.value = "f:" + f.id; o.textContent = "📁 " + f.name; sel.appendChild(o); });
  if (![...sel.options].some(o => o.value === sel.value)) sel.value = "";
  [...sel.options].forEach(o => { const b = document.createElement("button"); b.textContent = o.value ? o.textContent : "すべて"; b.dataset.v = o.value; b.onclick = () => { sel.value = o.value; markSeg(); sel.onchange(); }; seg.appendChild(b); });
  markSeg();
}
function refreshBar() {   // 状態バーの色を、背景色に改めて決め直させる（メニューの幕で灰色になったまま残るのを防ぐ）
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => { const c = m.content, n = m.cloneNode(); n.content = c; m.replaceWith(n); });
}
function openDrawer(on) { $("drawer").classList.toggle("open", on); $("dscrim").style.display = on ? "block" : "none"; if (!on) { setTimeout(refreshBar, 50); setTimeout(refreshBar, 400); } if (on) { renderDrawer(); $("dkey").value = CFG.folderKey || ""; $("dmsg").textContent = FMSG; syncFolders(false); if (!NSYNC) showNoteStatus(); } }
function renderDrawer() {
  const box = $("dlist"); box.innerHTML = "";
  if (!FOLDERS.length) { const e = document.createElement("div"); e.className = "dempty"; e.textContent = "まだフォルダがありません。"; box.appendChild(e); }
  FOLDERS.forEach(f => {
    const r = document.createElement("div"); r.className = "drow";
    const n = document.createElement("div"); n.className = "dname"; n.innerHTML = '<svg class="fico" width="38" height="38"><use href="#ico-folder"/></svg>'; const nm = document.createElement("span"); nm.textContent = f.name; const c = document.createElement("small"); c.textContent = "　" + folderCount(f) + "冊"; nm.appendChild(c); n.appendChild(nm);
    n.onclick = () => openEditor(f);
        const de = document.createElement("button"); de.className = "sub"; de.textContent = "削除"; de.onclick = () => { if (!confirm("フォルダ「" + f.name + "」を削除しますか？（本そのものは消えません）")) return; DELETED[f.id] = Date.now(); FOLDERS = FOLDERS.filter(x => x.id !== f.id); saveFolders(); syncFolders(false); renderSeg(); renderDrawer(); $("src").onchange(); };
    r.append(n, de); box.appendChild(r);
  });
}
/* PCとの共有: Drive直下に「院内検索_マイフォルダ_<共有名>_ipad.json」を書き、PCが書く「…_mac.json」を読む（共有名が同じ端末どうしだけ共有される） */
const tokHasWrite = () => { try { const t = JSON.parse(localStorage.getItem("hs_tok") || "null"); return !!(t && /drive\.file/.test(t.sc || "")); } catch (e) { return false; } };
function mergeF(rem) {
  const fol = new Map(FOLDERS.map(f => [f.id, f])); const del = Object.assign({}, DELETED);
  (rem.folders || []).forEach(f => { const l = fol.get(f.id); if (!l || (f.t || 1) > (l.t || 1)) fol.set(f.id, f); });
  Object.entries(rem.deleted || {}).forEach(([k, t]) => { if (t > (del[k] || 0)) del[k] = t; });
  FOLDERS = [...fol.values()].filter(f => (del[f.id] || 0) < (f.t || 1)).sort((a, b) => (a.t || 1) - (b.t || 1)); DELETED = del;
  if (rem.gn) mergeGn(rem.gn);
}
async function putOwn(name, text) {
  const t = getToken(), ex = await findChild("root", name);
  if (ex) { const r = await fetch("https://www.googleapis.com/upload/drive/v3/files/" + ex.id + "?uploadType=media", { method: "PATCH", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: text }); if (!r.ok) throw new Error("保存に失敗 " + r.status); return; }
  const b = "hsb" + Date.now(), body = "--" + b + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify({ name, parents: ["root"], mimeType: "application/json" }) + "\r\n--" + b + "\r\nContent-Type: application/json\r\n\r\n" + text + "\r\n--" + b + "--";
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "multipart/related; boundary=" + b }, body });
  if (!r.ok) throw new Error("作成に失敗 " + r.status);
}
let FSYNCING = false;
async function syncFolders(interactive) {
  const msg = m => { FMSG = m; if ($("dmsg")) $("dmsg").textContent = m; };
  const key = (CFG.folderKey || "").trim();
  if (!key) { msg("共有はオフです（共有名を入れると、PCと共有できます）"); return; }
  if (!getToken()) { if (interactive) { login({}); return; } msg("共有するには、ログインが必要です（「保存して同期」を押してください）"); return; }
  if (interactive && !tokHasWrite()) { login({}); return; }       // 書き込み権限を足すため、もう一度ログイン
  if (FSYNCING) return; FSYNCING = true;
  try {
    const base = "院内検索_マイフォルダ_" + key; const mf = await findChild("root", base + "_mac.json");
    if (mf) mergeF(JSON.parse(new TextDecoder().decode(await downloadBuf(mf.id))));
    const own = await findChild("root", base + "_ipad.json");      // 入れ直し後に、自分が前に保存した分（フォルダ・GoodNotesのリンク）を取り戻す
    if (own) { try { mergeF(JSON.parse(new TextDecoder().decode(await downloadBuf(own.id)))); } catch (e) {} }
    saveFolders(); renderSeg(); if ($("drawer").classList.contains("open")) renderDrawer();
    if (tokHasWrite()) { await putOwn(base + "_ipad.json", JSON.stringify({ folders: FOLDERS, deleted: DELETED, gn: gnPayload() })); msg("同期しました" + (mf ? "" : "（PC側のファイルはまだありません）")); }
    else msg("PCの変更を取り込みました（iPadの変更をPCへ送るには、「保存して同期」で再ログイン）");
  } catch (e) { msg("同期できません: " + e.message); } finally { FSYNCING = false; }
}

/* ---------- 本棚（登録されている参考書の一覧。GoodNotesのリンク登録・保存・検索） ---------- */
const gnNm = x => x.normalize("NFC").trim().toLowerCase().replace(/\.pdf$/, "");
function gnEntries() { let t = ""; try { t = localStorage.getItem("hs_gn") || ""; } catch (e) {} return t.split(/\n/).map(l => { const i = l.indexOf("="); return i < 1 ? null : { k: l.slice(0, i).trim(), u: l.slice(i + 1).trim() }; }).filter(Boolean); }
function gnWrite(arr) { try { localStorage.setItem("hs_gn", arr.map(e => e.k + "=" + e.u).join("\n")); } catch (e) { alert("保存できませんでした"); } }
function gnTs() { try { return JSON.parse(localStorage.getItem("hs_gnt") || "{}"); } catch (e) { return {}; } }
function gnSet(f, url) {
  const arr = gnEntries().filter(e => gnNm(e.k) !== gnNm(f.name)); if (url) arr.push({ k: f.name, u: url }); gnWrite(arr);
  const T = gnTs(); T[gnNm(f.name)] = Date.now(); try { localStorage.setItem("hs_gnt", JSON.stringify(T)); } catch (e) {} syncFolders(false);
}
function gnPayload() {   // 同期用: 登録中のリンクと、消したリンク（墓石）を、時刻つきで
  const T = gnTs(), E = gnEntries(), out = [], seen = new Set();
  E.forEach(e => { const k = gnNm(e.k); seen.add(k); out.push({ k: e.k, u: e.u, t: T[k] || 1 }); });
  Object.entries(T).forEach(([k, t]) => { if (!seen.has(k)) out.push({ k, u: "", t }); });
  return out;
}
function mergeGn(list) {
  if (!Array.isArray(list)) return; const T = gnTs(); let E = gnEntries(), ch = false;
  list.forEach(r => { const k = gnNm(r.k || ""); if (!k || !(r.t > (T[k] || 0))) return; E = E.filter(e => gnNm(e.k) !== k); if (r.u) E.push({ k: r.k, u: r.u }); T[k] = r.t; ch = true; });
  if (ch) { gnWrite(E); try { localStorage.setItem("hs_gnt", JSON.stringify(T)); } catch (e) {} if ($("shelf") && $("shelf").style.display === "flex") buildShelf(); }
}
function openShelf(on) { $("shelf").style.display = on ? "flex" : "none"; if (on) { openDrawer(false); buildShelf(); } }
const natCmp = (a, b) => a.name.localeCompare(b.name, "ja", { numeric: true });
const SHELF_OPEN = new Set();
async function askOpen(f) {   // 保存されていない本は、容量を見せて確認してから開く（読み込みに時間がかかるため）
  let cached = !!SAVED.get(f.rel); if (!cached && f.ext === "pdf") { try { cached = !!(await idbGet("kv", "rcm:" + f.rel)); } catch (e) {} }
  if (!cached && f.ext === "pdf" && !confirm("「" + f.name + "」を開きます。\n\n容量: " + (f.size ? fmtSize(f.size) : "不明") + "\n\nこの端末に保存されていないため、読み込みに時間がかかります。開きますか？")) return;
  openFile(f, 1, { overlay: true });
}
function shelfBooks() { return IX.files.filter(x => !x.dead && x.src === SRC_BOOK && (!isMag(x) || $("srn").checked)).sort(natCmp); }
function buildShelf() {
  const box = $("slist"); box.innerHTML = ""; if (!IX) { box.textContent = "先に索引を取り込んでください。"; return; }
  const all = shelfBooks(), kids = new Map();
  all.forEach(f => { if (f.parentRel) { if (!kids.has(f.parentRel)) kids.set(f.parentRel, []); kids.get(f.parentRel).push(f); } });
  const mk = (f, child) => {
    const r = document.createElement("div"); r.className = "srow" + (child ? " schild" : ""); r.dataset.t = norm(f.name + " " + f.path); r.dataset.rel = f.rel; if (child) r.dataset.p = f.parentRel;
    let tap = () => askOpen(f);   // 章別を持つ本は、タップで展開（開くのは右の「開く」ボタン）
    const cv = coverEl(f, () => tap()); cv.className = cv.tagName === "IMG" ? "fcv" : "fcv0"; if (cv.tagName !== "IMG") cv.textContent = "";
    const m = document.createElement("div"); m.className = "smain";
    const t = document.createElement("div"); t.className = "sname"; const nk = (kids.get(f.rel) || []).length;
    const chev = document.createElement("span"), tt = document.createElement("span"); tt.textContent = (isMag(f) ? "📓 " : "") + f.name; tt.style.cursor = "pointer"; tt.onclick = () => tap();
    const me = document.createElement("div"); me.className = "smeta"; me.textContent = (nk ? "章別 " + nk + "件（タップで展開・開くは右のボタン）　" : "") + (f.size ? fmtSize(f.size).replace(/（.*$/, "") : "");
    if (nk) {
      const tg = () => { SHELF_OPEN.has(f.rel) ? SHELF_OPEN.delete(f.rel) : SHELF_OPEN.add(f.rel); chev.textContent = SHELF_OPEN.has(f.rel) ? "▼ " : "▶ "; filterShelf(); };
      chev.textContent = SHELF_OPEN.has(f.rel) ? "▼ " : "▶ "; chev.style.cssText = "cursor:pointer;display:inline-block;padding:4px 6px 4px 0"; chev.onclick = tg; me.style.cursor = "pointer"; me.onclick = tg; tap = tg;
    }
    t.append(chev, tt);
    const gl = document.createElement("div"); gl.className = "sgn"; const ed = document.createElement("div"); ed.className = "sedit";
    const btns = document.createElement("div"); btns.className = "sbtns"; const right = document.createElement("div"); right.className = "sright";
    const b1 = document.createElement("button"); b1.className = "openbtn"; b1.textContent = "開く"; b1.onclick = () => askOpen(f);
    btns.append(b1);
    if (f.ext === "pdf") { const b2 = document.createElement("button"); b2.className = "sub"; b2.textContent = saveLabel(f); b2.onclick = () => toggleSave(f, b2); btns.append(b2); }
    const draw = () => {
      gl.innerHTML = ""; ed.innerHTML = ""; right.style.display = ""; const u = gnLink(f);
      if (u) { const b4 = document.createElement("button"); b4.className = "sub"; b4.textContent = "GoodNotes"; b4.onclick = () => openGN(f, 0); gl.append(b4); }
      const b3 = document.createElement("button"); b3.className = "sub"; b3.textContent = u ? "🔗 変更" : "🔗 リンク追加"; b3.onclick = () => edit(); gl.append(b3);
      r.classList.toggle("nolink", !u);
    };
    const edit = () => {
      right.style.display = "none"; ed.innerHTML = ""; const inp = document.createElement("input"); inp.type = "text"; inp.placeholder = "GoodNotesの共有リンクを貼り付け"; inp.value = gnLink(f) || ""; inp.style.cssText = "width:100%;margin:6px 0";
      const sv = document.createElement("button"); sv.textContent = "保存"; sv.onclick = () => { const v = inp.value.trim(); if (v && !/^https?:\/\//.test(v)) { alert("リンク（https://…）を貼り付けてください"); return; } gnSet(f, v); draw(); filterShelf(); };
      const cn = document.createElement("button"); cn.className = "sub"; cn.textContent = "キャンセル"; cn.onclick = draw;
      const dl = document.createElement("button"); dl.className = "sub"; dl.textContent = "リンクを削除"; dl.onclick = () => { gnSet(f, ""); draw(); filterShelf(); };
      const row = document.createElement("div"); row.className = "row"; row.append(sv, cn); if (gnLink(f)) row.append(dl); ed.append(inp, row); inp.focus();
    };
    draw(); right.append(gl, btns); m.append(t, me, ed); r.append(cv, m, right); return r;
  };
  all.filter(f => !f.parentRel).forEach(f => { box.appendChild(mk(f, false)); (kids.get(f.rel) || []).forEach(k => box.appendChild(mk(k, true))); });
  filterShelf();
}
function filterShelf() {
  const q = norm($("sq").value.trim()), only = $("snl").checked, rows = [...$("slist").children].filter(r => r.dataset && r.dataset.rel), auto = !!q || only;
  const pass = r => (!q || (r.dataset.t || "").includes(q)) && (!only || r.classList.contains("nolink"));
  const okKid = new Set(); rows.forEach(r => { if (r.dataset.p && pass(r)) okKid.add(r.dataset.p); });
  rows.forEach(r => { const p = r.dataset.p; r.style.display = (p ? pass(r) && (auto || SHELF_OPEN.has(p)) : (pass(r) || okKid.has(r.dataset.rel))) ? "" : "none"; });
  const vis = rows.filter(r => r.style.display !== "none").length, lk = rows.filter(r => !r.classList.contains("nolink")).length; $("scount").textContent = vis + "/" + rows.length + "件　リンク登録 " + lk + "件";
}
function shelfCount() { filterShelf(); }
let EDIT = null, SEL = new Set();
function openEditor(f) {
  if (!IX) { alert("先に索引を取り込んでください。"); return; }
  EDIT = f; SEL = new Set(f ? f.rels : []); $("fname").value = f ? f.name : ""; $("fq").value = ""; $("frn").checked = false;
  $("ftitle").textContent = f ? "フォルダを編集" : "フォルダを作る"; $("fed").style.display = "flex"; openDrawer(false); buildEditorList();
}
function closeEditor() { $("fed").style.display = "none"; EDIT = null; }
function editorBooks() { return IX.files.filter(x => !x.dead && x.src === SRC_BOOK && !x.parentRel && (!isMag(x) || $("frn").checked || SEL.has(x.rel))).sort(natCmp); }
function buildEditorList() {
  const box = $("flist"); box.innerHTML = "";
  editorBooks().forEach(x => {
    const r = document.createElement("label"); r.className = "frow"; r.dataset.t = norm(x.name + " " + x.path);
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = SEL.has(x.rel); cb.onchange = () => { cb.checked ? SEL.add(x.rel) : SEL.delete(x.rel); countSel(); };
    const cv = coverEl(x, () => {}); cv.onclick = null; cv.className = cv.tagName === "IMG" ? "fcv" : "fcv0"; if (cv.tagName !== "IMG") cv.textContent = "";
    const t = document.createElement("span"); t.className = "ft"; t.textContent = (x.grp === GRP_RN ? "📓 " : "") + x.name + (x.nchap ? "　（章別 " + x.nchap + "件を含む）" : "");
    r.append(cb, cv, t); r.cb = cb; r.rel = x.rel; box.appendChild(r);
  });
  filterEditor(); countSel();
}
function filterEditor() { const q = norm($("fq").value.trim()); [...$("flist").children].forEach(r => { r.style.display = !q || r.dataset.t.includes(q) ? "" : "none"; }); }
function selAll(on) { [...$("flist").children].forEach(r => { if (r.style.display === "none") return; r.cb.checked = on; on ? SEL.add(r.rel) : SEL.delete(r.rel); }); countSel(); }
function countSel() { $("fcount").textContent = SEL.size + "冊 選択中"; }
function saveEditor() {
  const name = $("fname").value.trim(); if (!name) { alert("フォルダ名を入力してください。"); return; }
  if (!SEL.size) { alert("本を1冊以上選んでください。"); return; }
  const rels = [...SEL].filter(r => { const f = IX.files.find(x => x.rel === r); return !(f && f.parentRel); });
  if (EDIT) { EDIT.name = name; EDIT.rels = rels; EDIT.t = Date.now(); } else FOLDERS.push({ id: Date.now().toString(36), name, rels, t: Date.now() });
  const sel = "f:" + (EDIT ? EDIT.id : FOLDERS[FOLDERS.length - 1].id);
  saveFolders(); syncFolders(false); renderSeg(); closeEditor(); $("src").value = sel; markSeg(); $("src").onchange();
}

let PDFLIB = null, CUR = null;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("pdf.jsを読み込めません（ネット接続を確認）")); document.head.appendChild(s); }); }
let OPEN_OPTS = {};
function setViewerMode(o) { document.body.classList.toggle("vover", !!o.overlay || window.innerWidth < 900); }
async function openFile(f, page, opts) {
  if (f.src === SRC_NOTE) return openNote(f, opts);
  opts = opts || {}; OPEN_OPTS = opts; setViewerMode(opts);
  const resume = { q: $("q").value, open: { rel: f.rel, page } };
  let sv = f.ext === "pdf" && SAVED.get(f.rel), rcache = false;
  if (!sv && f.ext === "pdf") { const m = await idbGet("kv", "rcm:" + f.rel).catch(() => null); if (m) { sv = m; rcache = true; } }
  if (sv) {   // 保存済み・最近開いた本: ログインもDriveも使わず開く
    try {
      const blob = await idbGet("kv", (rcache ? "rcd:" : "offd:") + f.rel);
      if (blob && rcache) idbPut("kv", "rcm:" + f.rel, Object.assign({}, sv, { t: Date.now() })).catch(() => {});
      if (!blob && rcache) await rcDel(f.rel);
      if (blob) {
        $("viewer").style.display = "flex"; $("vtitle").textContent = f.name; $("vstat").textContent = "読み込み中…"; $("vsave").textContent = saveLabel(f); setVdrive(f);
        if (!window.pdfjsLib) await loadScript(PDFJS); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        if (CUR && CUR.io) CUR.io.disconnect();
        CUR = { doc, f, id: sv.id, zoom: 1, cands: opts.cands, terms: opts.terms }; await buildPages(Math.min(Math.max(page || 1, 1), doc.numPages)); return;
      }
    } catch (e) { $("viewer").style.display = "none"; setStat("保存データを開けませんでした。Driveから開きます: " + e.message); }
  }
  try {
    await needToken(resume); const id = await resolveDriveId(f);
    if (f.ext !== "pdf") { window.open("https://drive.google.com/file/d/" + id + "/view", "_blank"); return; }
    $("viewer").style.display = "flex"; $("vtitle").textContent = f.name; $("vstat").textContent = "読み込み中…"; $("vsave").textContent = saveLabel(f); setVdrive(f);
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
    CUR = { doc, f, id, zoom: 1, cands: opts.cands, terms: opts.terms }; rcFetch(f, id); await buildPages(Math.min(Math.max(page || 1, 1), doc.numPages));
  } catch (e) { $("vstat").textContent = "開けません: " + e.message; setStat("開けません: " + e.message); }
}
/* 連続スクロール表示: 全ページ分の枠を作り、画面の近くのページだけ描画する */
function renderCands() {
  const box = $("vcands"); box.innerHTML = ""; const L = (CUR && CUR.cands || []).filter(k => k.page > 0); if (L.length < 2) return;
  const lb = document.createElement("span"); lb.className = "vcl"; lb.textContent = "候補"; box.appendChild(lb);
  L.forEach((k, i) => { const b = document.createElement("button"); b.className = "vc"; b.dataset.p = k.page; b.textContent = (i === 0 ? "★" : "") + "p." + k.page; b.onclick = () => goPage(k.page); box.appendChild(b); });
}
async function buildPages(n, after) {
  renderCands();
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
  if (after) after(); else goPage(n);
}
async function renderPg(d) {
  if (d._r || !CUR) return; d._r = 1; const tok = d._tok = (d._tok || 0) + 1, cur = CUR;
  try {
    const page = await cur.doc.getPage(+d.dataset.n); if (CUR !== cur || d._tok !== tok) return;
    const sc = cur.cssW / page.getViewport({ scale: 1 }).width, dpr0 = Math.min(window.devicePixelRatio || 1, 2), v0 = page.getViewport({ scale: sc * dpr0 }), kk = Math.min(1, Math.sqrt(1.2e7 / (v0.width * v0.height))), dpr = dpr0 * kk, vp = page.getViewport({ scale: sc * dpr });   /* 大きく拡大しても、画面が真っ白にならないよう、絵の大きさに上限(約1200万画素)を設ける */
    const cv = document.createElement("canvas"); cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise; if (CUR !== cur || d._tok !== tok) return;
    d.style.height = Math.round(vp.height / dpr) + "px"; d.replaceChildren(cv);
    if (cur.align && +d.dataset.n <= cur.align) realign();
    if (HL_ON && cur.terms && cur.terms.length) addHighlights(d, page, sc, cur, tok);
  } catch (e) { d._r = 0; }
}
/* ---------- 検索語の蛍光マーカー（黄緑）: ページの文字の位置を調べて、検索語の上に半透明の色を重ねる ---------- */
const HL_ON = true;
function hlTerms(terms) {   /* 検索語を、マーカーを付ける単位に分ける（「急性膵炎の治療」→「急性膵炎」「治療」） */
  const out = new Set();
  (terms || []).forEach(t => { t = t.normalize("NFKC").toLowerCase();
    t.replace(/([\u4e00-\u9fff\u30a0-\u30ff])[のをはがにでともへや]([\u4e00-\u9fff\u30a0-\u30ff])/g, "$1 $2").split(/[\s、，,・]+/).forEach(w => { if (w.length >= 2 && !/^[a-z0-9]$/.test(w)) out.add(w); }); });
  return [...out];
}
async function addHighlights(d, page, sc, cur, tok) {
  try {
    const tc = await page.getTextContent(); if (CUR !== cur || d._tok !== tok || !d.firstChild) return;
    const vp = page.getViewport({ scale: sc }), layer = document.createElement("div");
    layer.style.cssText = "position:absolute;left:0;top:0;width:" + vp.width + "px;height:" + vp.height + "px;opacity:0;pointer-events:none;overflow:hidden;line-height:1;";
    layer.className = "tlayer"; layer.style.setProperty("--scale-factor", vp.scale); layer.style.setProperty("--total-scale-factor", vp.scale); d.appendChild(layer); const divs = [];
    await pdfjsLib.renderTextLayer({ textContentSource: tc, textContent: tc, container: layer, viewport: vp, textDivs: divs }).promise;
    if (CUR !== cur || d._tok !== tok) { layer.remove(); return; }
    const hl = document.createElement("div"); hl.className = "hlayer"; const box = d.getBoundingClientRect(), terms = cur.hterms || (cur.hterms = hlTerms(cur.terms));
    divs.forEach(sp => { const txt = (sp.textContent || "").toLowerCase(), node = sp.firstChild; if (!node || !txt) return;
      terms.forEach(t => { let i = txt.indexOf(t); while (i >= 0) { try { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + t.length);
        for (const q of r.getClientRects()) { if (q.width < 1) continue; const e = document.createElement("div"); e.style.cssText = "position:absolute;left:" + (q.left - box.left) + "px;top:" + (q.top - box.top) + "px;width:" + q.width + "px;height:" + q.height + "px"; hl.appendChild(e); } } catch (e) {} i = txt.indexOf(t, i + t.length); } });
    });
    layer.remove(); if (hl.children.length) d.appendChild(hl);
  } catch (e) {}
}
function rehighlight() {   /* 検索語が変わった/ON-OFFを切り替えたとき、いま描かれているページを描き直す */
  if (!CUR || !CUR.pgs) return; CUR.hterms = null;
  CUR.pgs.forEach(d => { if (d._r) { releasePg(d); renderPg(d); } });
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
function showPos() { document.querySelectorAll("#vcands .vc").forEach(b => b.classList.toggle("on", +b.dataset.p === CUR.n)); $("vpage").value = CUR.n; $("vstat").textContent = CUR.n + " / " + CUR.doc.numPages; }
let scrollT = 0;
function onVScroll() {
  if (!CUR || !CUR.pgs) return; if (CUR.setting) { CUR.setting = 0; return; }
  if (CUR.align) CUR.align = 0;   // 利用者が動かしたら、自動の位置合わせはやめる
  if (scrollT) return; scrollT = requestAnimationFrame(() => { scrollT = 0; if (CUR && CUR.pgs) { CUR.n = curPageFromScroll(); showPos(); } });
}
/* ピンチで自由に拡大・縮小: 指の間の点を中心に、動かしている間は見た目だけ拡大縮小し、離したら、その倍率で描き直す（0.5〜5倍） */
function pinchZoom(z, cx, cy) {
  if (!CUR || !CUR.pgs) return; const box = $("vbody"), wrap = $("vpages"); z = Math.min(Math.max(z, 0.5), 5);
  const wr = wrap.getBoundingClientRect(), P = CUR.pgs; let pi = 0; for (let i = 0; i < P.length; i++) { if (P[i].getBoundingClientRect().top <= cy) pi = i; else break; }
  const pr = P[pi].getBoundingClientRect(), fy = (cy - pr.top) / Math.max(1, pr.height), fx = (cx - wr.left) / Math.max(1, wr.width);
  CUR.align = 0; CUR.zoom = z; CUR.n = pi + 1;
  buildPages(pi + 1, () => {
    box.scrollTop = 0; box.scrollLeft = 0; const q = CUR.pgs[pi].getBoundingClientRect(), w2 = $("vpages").getBoundingClientRect(); CUR.setting = 1;
    box.scrollTop = Math.max(0, q.top + fy * q.height - cy); box.scrollLeft = Math.max(0, w2.left + fx * w2.width - cx); showPos();
  });
}
(function () {
  const box = document.getElementById("vbody"); let st = null;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  box.addEventListener("touchstart", e => { if (!CUR || !CUR.pgs || e.touches.length !== 2) return; const wrap = document.getElementById("vpages"), br = wrap.getBoundingClientRect(), cx = (e.touches[0].clientX + e.touches[1].clientX) / 2, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    st = { d0: dist(e.touches), s: 1, cx, cy }; wrap.style.transformOrigin = (cx - br.left) + "px " + (cy - br.top) + "px"; }, { passive: true });
  box.addEventListener("touchmove", e => { if (!st || e.touches.length !== 2) return; e.preventDefault(); const z0 = CUR.zoom || 1; st.s = Math.min(Math.max(dist(e.touches) / st.d0, 0.5 / z0), 5 / z0); document.getElementById("vpages").style.transform = "scale(" + st.s + ")"; }, { passive: false });
  const end = e => { if (!st || e.touches.length >= 2) return; const o = st; st = null; const wrap = document.getElementById("vpages"); wrap.style.transform = ""; wrap.style.transformOrigin = ""; if (Math.abs(o.s - 1) < 0.03) return; pinchZoom((CUR.zoom || 1) * o.s, o.cx, o.cy); };
  box.addEventListener("touchend", end, { passive: true }); box.addEventListener("touchcancel", end, { passive: true });
})();
function setZoom(z) { if (!CUR) return; const n = CUR.n; CUR.zoom = z; buildPages(n); }

/* ---------- ノート（UpNote）: 本文をアプリ内で表示して検索語に色を付ける。「UpNoteで開く」で元のノートへ ---------- */
let NOTE_CUR = null;
const upnoteUrl = f => f && f.nid ? "upnote://x-callback-url/openNote?noteId=" + encodeURIComponent(f.nid) : "";
function openUpNote(f) { const u = upnoteUrl(f); if (!u) { setStat("このノートのIDがありません"); return; } setStat("UpNoteを開きます（UpNoteアプリが入っている端末で動きます）"); location.href = u; }
async function noteText(f) {
  const fi = IX.files.indexOf(f); let s0 = -1; for (let i = 0; i < IX.N; i++) if (IX.fid[i] === fi) { s0 = i; break; }
  if (s0 < 0) return ""; const out = []; for (let i = s0; i < s0 + f.n; i++) out.push((await chunkAt(i))[3]); return out.join("\n");
}
/* 書式つき本文: Macが作った note_html.json.gz（ノートID→許可したタグだけのHTML）を読み、見出し・太字・箇条書き・表をそのまま表示する */
let NHTML = null;
async function noteHtmlOf(nid) {
  if (!nid) return "";
  if (!NHTML) { NHTML = {}; try { const nm = await idbGet("kv", "nmanifest"), b = nm && nm.html ? await idbGet("blobs", nm.html) : null; if (b) NHTML = JSON.parse(await gunzipText(b.data)); } catch (e) {} }
  return NHTML[nid] || "";
}
const NOTE_OK = new Set(["DIV", "P", "BR", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "COL", "COLGROUP", "BLOCKQUOTE", "HR", "SUB", "SUP", "SPAN", "A", "CODE", "PRE", "MARK"]);
function safeCopy(src, dst) {   /* 念のため、アプリ側でも許可したタグ・属性だけを写す */
  src.childNodes.forEach(n => {
    if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.nodeValue)); return; }
    if (n.nodeType === 1 && n.tagName === "IMG") {   /* UpNoteの画像: 名前と幅だけ受け取り、空の枠を作る（実体は openNote が後から入れる） */
      const i = n.getAttribute("data-i") || ""; if (!/^[0-9A-Za-z_\-]+\.\w+$/.test(i)) return;
      const e = document.createElement("img"); e.setAttribute("data-i", i); e.className = "nph"; e.alt = "";
      const mm = /^(\d{1,4})(%|px)?$/.exec(n.getAttribute("data-w") || ""); if (mm) e.style.width = mm[2] === "%" ? Math.min(100, +mm[1]) + "%" : mm[1] + "px";
      dst.appendChild(e); return; }
    if (n.nodeType !== 1 || !NOTE_OK.has(n.tagName)) return;
    const e = document.createElement(n.tagName.toLowerCase());
    if (n.tagName === "SPAN" && n.className === "nimg") e.className = "nimg";
    if ((n.tagName === "TD" || n.tagName === "TH")) ["colspan", "rowspan"].forEach(k => { const v = n.getAttribute(k); if (v && /^\d{1,2}$/.test(v)) e.setAttribute(k, v); });
    if (n.tagName === "A") { const h = n.getAttribute("href") || ""; if (/^(https?:|upnote:|mailto:)/i.test(h)) { e.setAttribute("href", h); e.setAttribute("target", "_blank"); e.setAttribute("rel", "noopener"); } }
    safeCopy(n, e); dst.appendChild(e);
  });
}
function markIn(root, terms) {   /* 書式を壊さずに、本文の文字だけにマーカーを付ける */
  const ts = terms.filter(Boolean).map(esc); if (!ts.length) return; const re = new RegExp("(" + ts.join("|") + ")", "gi");
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), list = []; let n; while ((n = w.nextNode())) list.push(n);
  list.forEach(t => { const parts = t.nodeValue.split(re); if (parts.length < 2) return; const fr = document.createDocumentFragment();
    parts.forEach((p, i) => { if (!p) return; if (i % 2) { const m = document.createElement("mark"); m.textContent = p; fr.appendChild(m); } else fr.appendChild(document.createTextNode(p)); }); t.parentNode.replaceChild(fr, t); });
}
(function () {   /* ノート本文を右へスワイプして閉じる: 指に合わせてパネルが動き、離すと右へスライドアウト（足りなければ元に戻る）。表の上は除く */
  let sx = 0, sy = 0, ok = false, drag = false, dx = 0, t0 = 0;
  const el = document.getElementById("nview");
  el.addEventListener("touchstart", e => { if (e.touches.length !== 1) { ok = false; return; } const t = e.touches[0]; sx = t.clientX; sy = t.clientY; dx = 0; drag = false; t0 = Date.now(); ok = !(e.target.closest && e.target.closest("table")); }, { passive: true });
  el.addEventListener("touchmove", e => { if (!ok) return; const t = e.touches[0]; dx = t.clientX - sx; const dy = t.clientY - sy;
    if (!drag) { if (dx > 12 && Math.abs(dy) < dx * 0.5) { drag = true; el.style.transition = "none"; } else return; }
    el.style.transform = "translateX(" + Math.max(dx, 0) + "px)"; }, { passive: true });
  el.addEventListener("touchend", () => { if (!ok) return; ok = false; if (!drag) return; drag = false; el.style.transition = ""; el.style.transform = "";
    const fast = dx / Math.max(1, Date.now() - t0) > 0.5; if (dx > 80 || (dx > 30 && fast)) closeNote(); }, { passive: true });
  el.addEventListener("touchcancel", () => { if (drag) { drag = false; ok = false; el.style.transition = ""; el.style.transform = ""; } }, { passive: true });
})();
let NOTE_T = 0;
function showNotePanel() {   /* 検索結果は左に残し、右から本文のパネルをスライドして出す。すでに開いていれば中身だけ入れ替える */
  const v = $("nview"); clearTimeout(NOTE_T); const was = v.style.display === "flex" && v.classList.contains("in");
  document.body.classList.add("npanel"); v.style.display = "flex";
  if (was) return; v.classList.remove("in"); void v.offsetWidth; requestAnimationFrame(() => v.classList.add("in"));
  const sel = document.querySelector("#res .card.sel"); if (sel) setTimeout(() => sel.scrollIntoView({ block: "nearest" }), 30);
}
let NOTE_URLS = [];
function revokeNoteImgs() { NOTE_URLS.forEach(u => URL.revokeObjectURL(u)); NOTE_URLS = []; }
async function loadNoteImages(f, body) {   /* このノートの画像だけDriveから取り（端末に保存して再利用）、開いている間だけ表示する */
  const imgs = [...body.querySelectorAll("img[data-i]")]; if (!imgs.length) return;
  const lab = im => { const s = document.createElement("span"); s.className = "nimg"; s.textContent = "🖼 画像（UpNoteで開くと見られます）"; im.replaceWith(s); };
  let buf = null;
  try {
    const map = await idbGet("kv", "nimgmap"), ent = map && f.nid && map[f.nid]; if (!ent) throw new Error("none");
    const c = await idbGet("kv", "nimg:" + f.nid);
    if (c && c.md5 === ent.md5) buf = c.data; else { buf = await downloadBuf(ent.id); await idbPut("kv", "nimg:" + f.nid, { md5: ent.md5, data: buf }); }
  } catch (e) { if (NOTE_CUR === f) imgs.forEach(lab); return; }
  if (NOTE_CUR !== f) return;
  let hd, base;
  try { const hl = new DataView(buf).getUint32(0); hd = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl))); base = 4 + hl; } catch (e) { imgs.forEach(lab); return; }
  const m = new Map((hd.i || []).map(x => [x[0], x]));
  imgs.forEach(im => { const x = m.get(im.getAttribute("data-i")); if (!x) { lab(im); return; }
    const u = URL.createObjectURL(new Blob([new Uint8Array(buf, base + x[1], x[2])], { type: "image/jpeg" })); NOTE_URLS.push(u);
    im.onerror = () => lab(im); im.onload = () => im.classList.remove("nph"); im.loading = "lazy"; im.src = u; });
}
async function openNote(f, opts) {
  opts = opts || {}; NOTE_CUR = f; revokeNoteImgs(); const body = $("nbody");
  $("ntitle").textContent = f.name.replace(/\.note$/, ""); $("npath").textContent = f.path.split("/").slice(1, -1).join(" › ") + (f.year ? "　" + f.year + "年" : "");
  $("nup").style.display = f.nid ? "" : "none"; body.className = ""; body.textContent = "読み込み中…"; showNotePanel();
  let html = ""; try { html = await noteHtmlOf(f.nid); } catch (e) {}
  const terms = hlTerms(opts.terms || []);
  if (html) {
    if (NOTE_CUR !== f) return; body.textContent = ""; body.className = "rich";
    const doc = new DOMParser().parseFromString("<body>" + html + "</body>", "text/html"); safeCopy(doc.body, body); markIn(body, terms); loadNoteImages(f, body);
  } else {
    let text = ""; try { text = await noteText(f); } catch (e) { text = "読み込めません: " + e.message; }
    if (NOTE_CUR !== f) return; body.textContent = ""; hl(body, text, terms);
  }
  body.scrollTop = 0; const m = body.querySelector("mark"); if (m) m.scrollIntoView({ block: "center" });
}
function closeNote() { const v = $("nview"); v.classList.remove("in"); NOTE_CUR = null; revokeNoteImgs(); clearTimeout(NOTE_T); NOTE_T = setTimeout(() => { v.style.display = "none"; document.body.classList.remove("npanel"); }, 190); }
/* ノートの同期: Macが自動で行う（編集の数分後・毎朝・Mac起動時）。急ぐときは「今すぐ同期」→ Driveに合図のファイルを置く → Macが数分以内に気づいて同期 → 結果をここに表示 */
const NOTE_STATUS = "院内検索_ノート状態.json", NOTE_REQ = "院内検索_ノート同期要求.json", NOTE_CFG = "院内検索_ノート設定.json"; let NSYNC = false;
const fmtT = ms => { const d = new Date(ms); return (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
function noteMsg(t) { const e = $("dnotemsg"); if (e) e.textContent = t; }
async function readNoteStatus() { const f = await findChild("root", NOTE_STATUS); if (!f) return null; return JSON.parse(new TextDecoder().decode(await downloadBuf(f.id))); }
function noteStatusText(s) { return s ? (s.ok ? "最終同期: " + fmtT(s.last_sync) + "（ノート " + s.notes + "件・除外 " + (s.excluded || 0) + "件）" : "Mac側のエラー: " + (s.message || "")) : "Macの同期状態はまだありません"; }
const intLabel = v => v === 0 ? "変化の自動同期を止めています" : (v / 60) + "分ごと";
function intMsg(s) { if (!s || s.interval === undefined) return ""; const sel = $("dnoteint"); if (sel) sel.value = String(s.interval); return "Macの設定: " + intLabel(s.interval) + (s.last_check ? "（Macが最後に確認: " + fmtT(s.last_check) + "）" : ""); }
async function showNoteStatus() { if (!getToken()) { noteMsg("最終同期の表示には、ログイン（「索引を更新」）が必要です"); return; } try { const s = await readNoteStatus(); noteMsg(noteStatusText(s)); const m = $("dnoteintmsg"); if (m) m.textContent = intMsg(s); } catch (e) { noteMsg("状態を読めません: " + e.message); } }
/* 見張りの間隔の変更: Driveに設定ファイルを書く → Macが1分ごとに読んで反映 → 状態ファイルで受け取りを確認 */
async function setNoteInterval() {
  const v = +$("dnoteint").value, m = $("dnoteintmsg");
  if (!getToken() || !tokHasWrite()) { login({}); return; }
  try {
    const t = Date.now(); m.textContent = "Macに設定を送っています…"; await putOwn(NOTE_CFG, JSON.stringify({ interval: v, t, from: "app" }));
    m.textContent = "送りました。Macが1〜2分で受け取ります（" + intLabel(v) + "）";
    for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 15000)); const s = await readNoteStatus().catch(() => null); if (s && (s.cfg_t || 0) >= t) { m.textContent = "Macが設定を受け取りました（" + intLabel(v) + "）"; return; } }
    m.textContent = "Macから返事がありません（Macが起きれば反映されます）";
  } catch (e) { m.textContent = "設定を送れません: " + e.message; }
}
async function noteSyncNow() {
  if (NSYNC) return;
  if (!getToken() || !tokHasWrite()) { login({}); return; }       // 合図のファイルを書くための権限が要る
  NSYNC = true; $("dnotego").disabled = true;
  try {
    const t = Date.now(); noteMsg("Macに同期を頼んでいます…"); await putOwn(NOTE_REQ, JSON.stringify({ t, from: "app" }));
    noteMsg("Macが気づくまで待っています（最大5分。Macが起きていて、ネットにつながっている必要があります）");
    let st = null; const t0 = Date.now();
    while (Date.now() - t0 < 300000) { await new Promise(r => setTimeout(r, 10000)); const s = await readNoteStatus().catch(() => null); if (s && (s.handled_request || 0) >= t) { st = s; break; } }
    if (!st) { noteMsg("Macから返事がありません（Macが寝ている・Driveが止まっている可能性）。Macが起きれば、自動で反映されます"); return; }
    noteMsg(noteStatusText(st) + "　索引を取り込んでいます…"); if (await syncIndex()) { if (await loadIndex()) afterLoad(); }
    noteMsg(noteStatusText(st) + "　取り込みました");
  } catch (e) { noteMsg("同期できません: " + e.message); } finally { NSYNC = false; $("dnotego").disabled = false; }
}

/* ---------- 設定 ---------- */
function openSettings() {
  $("s_cid").value = CFG.clientId; $("s_key").value = CFG.geminiKey; $("s_fold").value = CFG.indexFolder; $("s_rh").value = CFG.rootHosp; $("s_rb").value = CFG.rootBook; $("s_fake").checked = CFG.fake; $("s_hint").value = CFG.loginHint || "";
  $("s_redir").textContent = redirectUri(); $("settings").style.display = "block"; renderRc();
}
function bind() {
  $("go").onclick = () => { $("q").blur(); run(); }; $("q").addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); $("q").blur(); run(); } });
  $("src").onchange = () => { fillT1(); if ($("q").value) run(); };
  $("ftoggle").onclick = () => { $("filters").classList.toggle("open"); updFBadge(); };
  $("dkeysave").onclick = () => { CFG.folderKey = $("dkey").value.trim(); saveCfg(); $("dmsg").textContent = "同期中…"; syncFolders(true); };
  attachSuggest($("q"), $("sugg")); attachSuggest($("vq"), $("vsugg"));
  $("fchead").onclick = () => openEditor(null); $("dshelf").onclick = () => openShelf(true); $("sclose").onclick = () => openShelf(false); $("sq").oninput = filterShelf; $("snl").onchange = filterShelf; $("srn").onchange = buildShelf;
  loadFolders(); renderSeg(); $("src").value = "参考書"; markSeg(); /* 起動時は「参考書」を選んでおく */ $("menubtn").onclick = () => openDrawer(true); $("dscrim").onclick = () => openDrawer(false); $("dnew").onclick = () => openEditor(null); $("fcancel").onclick = closeEditor; $("fsave").onclick = saveEditor;
  $("fq").oninput = filterEditor; $("frn").onchange = buildEditorList; $("fall").onclick = () => selAll(true); $("fnone").onclick = () => selAll(false);
  $("t1").onchange = () => { const t = $("t2"); t.innerHTML = '<option value="">すべての科/種別</option>'; const m = tree()[$("t1").value] || {}; Object.keys(m).sort().forEach(k => { const o = document.createElement("option"); o.value = k; o.textContent = k + " (" + m[k] + ")"; t.appendChild(o); }); if ($("q").value) run(); };
  ["t1", "t2", "ext", "yf", "pn"].forEach(i => $(i).addEventListener("change", updFBadge));
  ["t2", "ext", "yf", "pn"].forEach(i => $(i).onchange = () => { if ($("q").value) run(); });
  $("nclose").onclick = closeNote; $("nup").onclick = () => NOTE_CUR && openUpNote(NOTE_CUR); $("dnotego").onclick = noteSyncNow; $("dnoteint").onchange = setNoteInterval;
  $("setbtn").onclick = openSettings; $("s_close").onclick = () => { $("settings").style.display = "none"; };
  $("s_save").onclick = () => { CFG.clientId = $("s_cid").value.replace(/\s+/g, "");   // 空白・改行は取り除く
    const okId = /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(CFG.clientId); CFG.geminiKey = $("s_key").value.trim(); CFG.indexFolder = $("s_fold").value.trim() || DEF.indexFolder; CFG.rootHosp = $("s_rh").value.trim() || DEF.rootHosp; CFG.rootBook = $("s_rb").value.trim() || DEF.rootBook; CFG.fake = $("s_fake").checked; CFG.loginHint = $("s_hint").value.trim(); saveCfg(); $("settings").style.display = "none"; setStat(CFG.clientId && !okId ? "⚠ Client IDの形がおかしいです（「数字-英数字.apps.googleusercontent.com」の1行）。Google Cloudからコピーし直してください" : "設定を保存しました"); };
  $("syncbtn").onclick = async () => { try { if (await syncIndex()) { if (await loadIndex()) afterLoad(); } } catch (e) { setStat("取り込み失敗: " + e.message); } };
  /* ページの、マーカーのない所をタップすると、マーカーを消す */
  $("vbody").addEventListener("click", e => { if (!CUR || !CUR.terms || !CUR.terms.length) return; const x = e.clientX, y = e.clientY;
    for (const el of document.querySelectorAll("#vpages .hlayer div")) { const r = el.getBoundingClientRect(); if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return; }
    CUR.terms = []; CUR.hterms = null; document.querySelectorAll("#vpages .hlayer").forEach(h => h.remove()); });
  $("vsearch").onclick = () => { const b = $("vsb"); b.classList.toggle("open"); if (b.classList.contains("open")) { $("vq").focus(); if ($("vres").children.length) showVsp(true); } else showVsp(false); }; $("vqgo").onclick = () => { $("vq").blur(); runVSearch(); }; $("vq").addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); $("vq").blur(); runVSearch(); } });
  $("vclose").onclick = () => { $("vsp").classList.remove("open"); $("vsb").classList.remove("open"); $("vres").innerHTML = ""; document.body.classList.remove("vover"); $("viewer").style.display = "none"; if (CUR && CUR.io) CUR.io.disconnect(); $("vpages").innerHTML = ""; CUR = null; };
  $("vprev").onclick = () => CUR && goPage(CUR.n - 1); $("vnext").onclick = () => CUR && goPage(CUR.n + 1);
  $("vbody").addEventListener("scroll", onVScroll, { passive: true }); $("vbody").addEventListener("touchstart", () => { if (CUR) CUR.align = 0; }, { passive: true });
  let rz = 0; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (CUR && CUR.pgs && $("viewer").style.display !== "none") buildPages(CUR.n); }, 400); });
  $("vpage").onchange = () => CUR && goPage(+$("vpage").value || 1);
  $("vzin").onclick = () => CUR && setZoom(Math.min((CUR.zoom || 1) * 1.25, 4));
  $("vzout").onclick = () => CUR && setZoom(Math.max((CUR.zoom || 1) / 1.25, 0.5));
  $("vsave").onclick = () => CUR && toggleSave(CUR.f, $("vsave"));
}
/* ノートが索引に入っている端末だけ、「ノート」の範囲タブと同期ボタンを出す（友達の端末には出さない） */
function updNoteUi(has) {
  const sel = $("src"), op = [...sel.options].find(o => o.value === SRC_NOTE);
  if (has && !op) { const o = document.createElement("option"); o.value = SRC_NOTE; o.textContent = "UpNote"; sel.appendChild(o); }
  if (!has && op) op.remove();
  const sec = $("dnotesec"); if (sec) sec.style.display = has ? "" : "none"; renderSeg();
}
function afterLoad() {
  NHTML = null;
  const c = {}; IX.files.forEach(f => { if (!f.dead) c[f.grp] = (c[f.grp] || 0) + 1; });
  $("info").textContent = "院内 " + (c[SRC_HOSP] || 0) + " ／ 雑誌 " + (c[GRP_RN] || 0) + " ／ 参考書 " + (c[SRC_BOOK] || 0) + (c[SRC_NOTE] ? " ／ UpNote " + c[SRC_NOTE] : "") + " ファイル・" + IX.N + "箇所";
  updNoteUi(!!c[SRC_NOTE]); fillT1(); setStat(""); syncFolders(false); loadVocab();
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
/* スワイプでメニュー: 画面の左端から右へ引くと開き、開いているメニューを左へ引くと閉じる */
(function () {
  let sx = 0, sy = 0, mode = "", done = false;
  const overlayOpen = () => ["viewer", "nview", "shelf", "fed", "settings"].some(i => { const e = document.getElementById(i); return e && e.style.display && e.style.display !== "none"; });
  document.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) { mode = ""; return; } const t = e.touches[0]; sx = t.clientX; sy = t.clientY; done = false;
    const dr = document.getElementById("drawer").classList.contains("open");
    mode = dr ? "close" : (sx <= 32 && !overlayOpen() ? "open" : "");
  }, { passive: true });
  document.addEventListener("touchmove", e => {
    if (!mode || done) return; const t = e.touches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    if (mode === "open" && dx > 0) { done = true; openDrawer(true); }
    else if (mode === "close" && dx < 0) { done = true; openDrawer(false); }
  }, { passive: true });
})();
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}   // 端末の保存データを、容量不足でも消されにくくする
/* 別のアプリから戻ったときに画面が拡大されたままになるのを防ぐ（iPadのホーム画面アプリの不具合対策）: 拡大率を固定し直す */
function resetZoom() { const m = document.getElementById("vpmeta"); if (!m) return; const c = m.content; m.content = "width=device-width,initial-scale=1,maximum-scale=1,minimum-scale=1,viewport-fit=cover"; setTimeout(() => { m.content = c; window.scrollTo(window.scrollX, window.scrollY); }, 120); }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resetZoom(); });
window.addEventListener("pageshow", resetZoom);
new MutationObserver(() => document.body.classList.toggle("vopen", $("viewer").style.display === "flex")).observe($("viewer"), { attributes: true, attributeFilter: ["style"] });
window.__hs = { grams, bm25: (q) => bm25(q, new Uint8Array(IX.N).fill(1)), search: (q, f) => search(q, Object.assign({ src: "", top1: "", top2: "", ext: "", year: 0, prefNew: true }, f || {})), get IX() { return IX; }, loadIndex, syncIndex, CFG };
