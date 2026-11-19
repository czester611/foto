'use strict';
/* Budynki Foto – wersja webowa (PWA) dla iPhone'a. Odpowiednik aplikacji na Androida (MainActivity/Drive/Sheet). */

const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================ pamięć (IndexedDB) + ustawienia
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('foto', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('f', { keyPath: 'k' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(mode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction('f', mode), rq = fn(t.objectStore('f'));
    t.oncomplete = () => res(rq && rq.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const dbGet = k => tx('readonly', s => s.get(k)).catch(() => undefined);
const dbPut = (k, o) => tx('readwrite', s => s.put({ k, t: Date.now(), ...o })).catch(() => { });
const dbDel = k => tx('readwrite', s => s.delete(k)).catch(() => { });

/** Sprzątanie: kasuje wpisy starsze niż 7 dni oraz najstarsze ponad limit 1,5 GB (arkusz zostaje). */
async function purge() {
  try {
    const db = await dbp, all = [];
    await new Promise(res => {
      const c = db.transaction('f', 'readonly').objectStore('f').openCursor();
      c.onsuccess = () => { const cur = c.result; if (!cur) return res(); const v = cur.value; all.push({ k: v.k, t: v.t, n: v.blob ? v.blob.size : 0 }); cur.continue(); };
      c.onerror = () => res();
    });
    const now = Date.now(), keep = [];
    for (const x of all) {
      if (x.k === 'sheet') continue;
      if (now - x.t > 7 * 864e5) await dbDel(x.k); else keep.push(x);
    }
    let total = keep.reduce((a, x) => a + x.n, 0);
    keep.sort((a, b) => a.t - b.t);
    for (const x of keep) { if (total <= 1536 * 1024 * 1024) break; total -= x.n; await dbDel(x.k); }
  } catch (_) { }
}

const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { } },
};

// ============================================================ logowanie Google (przepływ z przekierowaniem)
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
class AuthError extends Error { constructor() { super('Wymagane logowanie'); } }

function getTok() { const t = ls.get('tok', null); return t && t.exp > Date.now() + 60000 ? t.v : null; }

function handleAuthRedirect() {
  const h = location.hash;
  if (!h || h.length < 2) return null;
  const p = new URLSearchParams(h.slice(1));
  if (!p.has('access_token') && !p.has('error')) return null;
  history.replaceState(null, '', location.pathname + location.search);
  if (p.get('state') !== ls.get('oauthState', '')) return 'Niezgodny parametr state – spróbuj ponownie';
  ls.del('oauthState');
  if (p.has('error')) return p.get('error');
  ls.set('tok', { v: p.get('access_token'), exp: Date.now() + (+p.get('expires_in') || 3600) * 1000 });
  return null;
}

function login() {
  if (!window.CONFIG || !CONFIG.CLIENT_ID || CONFIG.CLIENT_ID.startsWith('WKLEJ')) {
    setStatus('✖ Brak CLIENT_ID w config.js (patrz README.md)'); return;
  }
  ls.set('resume', { num: $('#num').value.trim(), t: Date.now() });
  ls.set('loginAt', Date.now());
  const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
  ls.set('oauthState', state);
  const q = new URLSearchParams({
    client_id: CONFIG.CLIENT_ID, redirect_uri: location.origin + location.pathname, response_type: 'token',
    scope: SCOPE, state, include_granted_scopes: 'true',
  });
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
}

/** Wywoływane po AuthError: przy braku sieci nie przekierowujemy (praca na danych zapamiętanych). */
function needLogin() {
  if (!navigator.onLine) return false;
  login();
  return true;
}

async function api(url) {
  const t = getTok();
  if (!t) throw new AuthError();
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t } });
  if (r.status === 401) { ls.del('tok'); throw new AuthError(); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}

// ============================================================ Drive
const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = "mimeType='application/vnd.google-apps.folder' and trashed=false";
const isPdf = it => it.mime === 'application/pdf';

async function dlist(q, fields) {
  const out = [];
  let page = null;
  do {
    const url = API + '?q=' + encodeURIComponent(q) + '&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true'
      + '&fields=' + encodeURIComponent('nextPageToken,files(' + fields + ')') + (page ? '&pageToken=' + encodeURIComponent(page) : '');
    const j = await (await api(url)).json();
    for (const f of j.files || []) out.push({ id: f.id, name: f.name || '', mime: f.mimeType || '', thumb: f.thumbnailLink || null, parents: f.parents || [] });
    page = j.nextPageToken;
  } while (page);
  return out;
}

let idx = null, idxAt = 0;
async function loadIndex() {
  if (idx && Date.now() - idxAt < 10 * 60 * 1000) return idx; // indeks ważny 10 min
  const audit = [], weeks = [];
  for (const r of await dlist(FOLDER + " and name contains 'IMPULS'", 'id,name,mimeType'))
    if (r.name.toLowerCase().includes('audyt impuls')) audit.push(...await dlist(`'${r.id}' in parents and ${FOLDER}`, 'id,name,mimeType'));
  for (const r of await dlist(FOLDER + " and name contains 'INSTALACJI'", 'id,name,mimeType'))
    if (r.name.toLowerCase().includes('z instalacji'))
      for (const w of await dlist(`'${r.id}' in parents and ${FOLDER}`, 'id,name,mimeType'))
        for (const b of await dlist(`'${w.id}' in parents and ${FOLDER}`, 'id,name,mimeType')) { b.group = w.name; weeks.push(b); }
  idx = { audit, weeks }; idxAt = Date.now();
  return idx;
}

/** Foldery budynku: audyt IMPULS (SR_/STR_/S_<nr>_...) i zdjęcia z instalacji (folder = sam numer). */
async function find(num) {
  const { audit, weeks } = await loadIndex();
  const pa = new RegExp('^[A-Za-z]+_0*' + num + '(?!\\d)'), pw = new RegExp('^\\s*0*' + num + '\\s*$');
  const out = [];
  for (const i of audit) if (pa.test(i.name)) out.push({ folder: i, label: 'Audyt IMPULS · ' + i.name });
  for (const i of weeks) if (pw.test(i.name)) out.push({ folder: i, label: 'Zdjęcia z instalacji · ' + i.group });
  return out;
}

/** Zdjęcia i PDF-y w folderze, rekurencyjnie (do 3 poziomów). */
async function images(folderId, depth) {
  const res = [];
  for (const i of await dlist(`'${folderId}' in parents and trashed=false`, 'id,name,mimeType,thumbnailLink')) {
    if (i.mime.startsWith('image/') || isPdf(i)) res.push(i);
    else if (i.mime === 'application/vnd.google-apps.folder' && depth > 0) res.push(...await images(i.id, depth - 1));
  }
  res.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return res;
}

async function saveList(folderId, l) { await dbPut('l:' + folderId, { json: l.map(i => ({ id: i.id, name: i.name, mime: i.mime, thumb: i.thumb })) }); }
async function loadList(folderId) { const r = await dbGet('l:' + folderId); return r && r.json ? r.json.map(i => ({ ...i, parents: [] })) : null; }

/** Zmniejsza obraz do max. `max` px dłuższego boku (z poprawną orientacją EXIF) → JPEG. */
async function downscale(blob, max) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (k === 1 && blob.type === 'image/jpeg') { bmp.close && bmp.close(); return blob; }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  c.width = c.height = 0;
  return out || blob;
}

let thumbLinkOk = true; // jeśli przeglądarka zablokuje thumbnailLink (CORS), przechodzimy na pobieranie pliku
/** Zdjęcie z cache lub z Dysku. size: 1600 (pełne) albo 320 (miniatura). */
async function imageBlob(it, size) {
  const key = (size === 320 ? 't:' : 'i:') + it.id;
  const hit = await dbGet(key);
  if (hit && hit.blob && hit.blob.size) return hit.blob;
  let blob = null;
  if (it.thumb && thumbLinkOk) {
    try {
      const r = await fetch(it.thumb.replace(/=s\d+$/, '') + '=s' + size, { headers: { Authorization: 'Bearer ' + (getTok() || '') } });
      if (r.ok) blob = await r.blob();
    } catch (e) { thumbLinkOk = false; }
  }
  if (!blob) {
    const full = await (await api(`${API}/${it.id}?alt=media&supportsAllDrives=true`)).blob();
    blob = await downscale(full, size);
  }
  await dbPut(key, { blob });
  return blob;
}

async function dropCache(it) {
  await dbDel('i:' + it.id); await dbDel('t:' + it.id); await dbDel('p:' + it.id);
  if (!isPdf(it)) {
    const j = await (await api(`${API}/${it.id}?supportsAllDrives=true&fields=thumbnailLink`)).json();
    it.thumb = j.thumbnailLink || null;
  }
}

// ---- PDF (pdf.js ładowany dopiero przy pierwszym PDF-ie)
let pdfLoad = null; const pdfDocs = new Map();
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  return pdfLoad || (pdfLoad = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/pdf.min.js';
    s.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; res(); };
    s.onerror = () => { pdfLoad = null; rej(new Error('nie wczytano pdf.js')); };
    document.head.appendChild(s);
  }));
}
async function pdfFile(it) {
  const hit = await dbGet('p:' + it.id);
  if (hit && hit.blob && hit.blob.size) return hit.blob;
  const blob = await (await api(`${API}/${it.id}?alt=media&supportsAllDrives=true`)).blob();
  await dbPut('p:' + it.id, { blob });
  return blob;
}
async function pdfPageBlob(it, page, width) {
  await loadPdfJs();
  let doc = pdfDocs.get(it.id);
  if (!doc) {
    doc = await pdfjsLib.getDocument({ data: new Uint8Array(await (await pdfFile(it)).arrayBuffer()) }).promise;
    if (pdfDocs.size >= 3) pdfDocs.delete(pdfDocs.keys().next().value);
    pdfDocs.set(it.id, doc);
  }
  it.pdfPages = doc.numPages;
  const pg = await doc.getPage(Math.min(page, doc.numPages - 1) + 1);
  const vp0 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: width / vp0.width });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  c.width = c.height = 0;
  return blob;
}

// ============================================================ arkusz "Lista lokalizacji"
async function sheetRows(force) {
  const hit = await dbGet('sheet');
  const fresh = hit && Date.now() - hit.t < 30 * 60 * 1000;
  let buf = hit && hit.data;
  if (force || !fresh) {
    try {
      const sheet = (await dlist("trashed=false and mimeType!='application/vnd.google-apps.folder' and name contains 'Lista'", 'id,name,mimeType'))
        .find(i => i.name.toLowerCase().includes('lista lokalizacji'));
      if (!sheet) throw new Error('brak pliku Lista lokalizacji');
      const url = sheet.mime === 'application/vnd.google-apps.spreadsheet'
        ? `${API}/${sheet.id}/export?mimeType=${encodeURIComponent('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}`
        : `${API}/${sheet.id}?alt=media&supportsAllDrives=true`;
      buf = await (await api(url)).arrayBuffer();
      await dbPut('sheet', { data: buf });
    } catch (e) {
      if (!buf || e instanceof AuthError && navigator.onLine) throw e; // offline: ostatnia zapamiętana wersja
    }
  }
  const wb = XLSX.read(buf, { type: 'array' });
  const name = wb.SheetNames.find(n => n.trim().toLowerCase() === 'harmonogram prac') || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
  return rows.map(r => r.map(v => v == null ? '' : String(v)));
}

function matchRows(rows, num) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const m = /(\d+)/.exec(rows[i][0] || '');
    if (m && m[1].replace(/^0+(?=\d)/, '') === num) out.push(rows[i]);
  }
  return out;
}

/** Czytelna wartość pola: daty/godziny z Excela, telefony zapisane jako 1.26E8, mailto: itp. */
function fmt(header, v) {
  if (v == null) return '';
  v = String(v).trim();
  if (!v) return '';
  const h = (header || '').toLowerCase();
  v = v.replace(/mailto:/g, '').trim();
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = parseFloat(v);
    if (h.startsWith('data') && n > 30000 && n < 80000) {
      const d = new Date(Math.round((n - 25569) * 86400000));
      const p = x => String(x).padStart(2, '0');
      return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
    }
    if (h.startsWith('godzina') && n >= 0 && n < 1) {
      const min = Math.round(n * 1440);
      return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    }
    return v.endsWith('.0') ? v.slice(0, -2) : v;
  }
  if (/^\d+(\.\d+)?[Ee]\+?\d+$/.test(v)) { try { return BigInt(Math.round(Number(v))).toString(); } catch (_) { } }
  return v;
}

// ============================================================ stan i UI
const input = $('#num'), statusEl = $('#status'), chipsEl = $('#chips'), thumbsEl = $('#thumbs'), infoPane = $('#infoPane');
const S = {
  reqGen: 0, infoGen: 0, preGen: 0,
  folders: [], selectedId: null, imgs: [], infoOpen: false, searchEmpty: false,
  infoState: 0, infoErr: '', infoNum: '', infoHeader: null, infoHit: null,
};

function setStatus(t, tap) { statusEl.textContent = t; statusEl.className = tap ? 'tap' : ''; statusEl.onclick = tap || null; }
let toastT;
function msg(t) { const e = $('#toast'); e.textContent = t; e.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => e.hidden = true, 3500); }
function showLoader(t) { $('#loaderText').textContent = t; $('#loader').hidden = false; }
function hideLoader() { $('#loader').hidden = true; }

// ---- historia + zapamiętane foldery
const cachedFor = num => { const a = (ls.get('cache', {}))[num]; return a && a.length ? a.map(o => ({ folder: { id: o.id, name: o.name }, label: o.label })) : null; };
function saveCache(num, found) {
  const all = ls.get('cache', {});
  all[num] = found.map(f => ({ id: f.folder.id, name: f.folder.name, label: f.label }));
  ls.set('cache', all);
}
function remember(num) {
  const h = ls.get('hist', []).filter(x => x !== num);
  h.unshift(num);
  ls.set('hist', h.slice(0, 20));
  refreshHistory();
}
function refreshHistory() {
  const row = $('#history'); row.textContent = '';
  for (const n of ls.get('hist', []).slice(0, 4)) { // tylko 4 ostatnio szukane
    const b = el('button', 'chip hist', n); b.type = 'button';
    b.onclick = () => { input.value = n; go(false); };
    row.appendChild(b);
  }
}

// ---- wyszukiwanie
function go(refresh) {
  const n = input.value.trim();
  S.reqGen++; S.infoGen++;
  chipsEl.textContent = ''; thumbsEl.textContent = ''; infoPane.textContent = ''; infoPane.hidden = true; thumbsEl.hidden = false;
  Object.assign(S, { infoHit: null, infoHeader: null, searchEmpty: false, infoOpen: false, infoState: 0, infoNum: '', infoErr: '', folders: [], selectedId: null });
  hideLoader();
  if (!/^\d{1,3}$/.test(n)) { setStatus('Wpisz 1-3 cyfry'); input.focus(); return; }
  input.blur();
  const num = n.replace(/^0+(?=\d)/, ''); // 007 -> 7
  if (refresh) idx = null; // odśwież też listę folderów z Dysku
  const cached = refresh ? null : cachedFor(num);
  if (cached) { remember(num); showResults(num, cached, true); showInfo(num, refresh); return; }
  if (!getTok()) {
    if (!needLogin()) setStatus('Brak połączenia – tego budynku nie ma w pamięci');
    return;
  }
  search(num); showInfo(num, refresh);
}

async function search(num) {
  setStatus(`Szukam budynku ${num}…`);
  showLoader(`SZUKAM BUDYNKU ${num}…`);
  const g = S.reqGen;
  try {
    const found = await find(num);
    if (found.length) { saveCache(num, found); remember(num); }
    if (g !== S.reqGen) return; // w międzyczasie wyszukano inny budynek
    hideLoader(); showResults(num, found, false);
  } catch (e) {
    if (g !== S.reqGen) return;
    hideLoader();
    if (e instanceof AuthError && needLogin()) return;
    setStatus('Błąd: ' + e.message);
  }
}

function showResults(num, found, fromCache) {
  setStatus((getTok() ? '✔ ' : '') + `Budynek ${num}: folderów ${found.length}` + (fromCache ? ' (z pamięci – przytrzymaj „Pokaż”, aby odświeżyć)' : ''));
  S.folders = found; S.selectedId = null; S.infoOpen = false;
  rebuildChips();
  if (!found.length) {
    msg('Nie znaleziono folderu dla budynku ' + num);
    S.searchEmpty = true;
    if (S.infoHit && S.infoHit.length) showInfoPane();
    return;
  }
  openFolder(found[0].folder); // od razu miniatury pierwszego folderu
}

// ---- INFO z arkusza
async function showInfo(num, force) {
  const g = S.infoGen;
  S.infoNum = num; S.infoState = 0; S.infoErr = '';
  rebuildChips();
  try {
    const rows = await sheetRows(force);
    if (g !== S.infoGen) return;
    S.infoHeader = rows[0] || []; S.infoHit = matchRows(rows, num);
    S.infoState = S.infoHit.length ? 1 : 2;
    rebuildChips();
    if (S.searchEmpty && S.infoHit.length) showInfoPane(); // budynek bez zdjęć, ale jest w pliku
  } catch (e) {
    if (g !== S.infoGen) return;
    if (e instanceof AuthError && needLogin()) return;
    S.infoState = 3; S.infoErr = e.message; rebuildChips();
  }
}

function chipText(f) {
  const l = f.label || '';
  if (l.startsWith('Audyt IMPULS')) {
    const audits = S.folders.filter(x => (x.label || '').startsWith('Audyt IMPULS')).length;
    return audits > 1 ? 'Audyt · ' + f.folder.name.replace('_Krakow', '').replace('__', '') : 'Audyt IMPULS';
  }
  const wk = l.includes('·') ? l.slice(l.indexOf('·') + 1).trim() : l;
  const m = /TYDZIE\S*\s+(\d+)\s+do\s+(\d+)\s+(\d+)/i.exec(wk);
  if (m) return `Instalacja ${m[1]}–${m[2]}.${m[3]}` + (wk.toUpperCase().includes('WEW') ? ' wew.' : '');
  return 'Instalacja';
}

function chip(text, sel, onclick) {
  const b = el('button', 'chip' + (sel ? ' sel' : ''), text); b.type = 'button'; b.onclick = onclick; return b;
}

/** Rząd przycisków: ⓘ INFO (jeśli jest wpis w pliku) + foldery budynku. */
function rebuildChips() {
  chipsEl.textContent = '';
  if (S.infoState === 1 && S.infoHit && S.infoHit.length) chipsEl.appendChild(chip('ⓘ INFO', S.infoOpen, showInfoPane));
  else if (S.infoState === 0 && S.infoNum) chipsEl.appendChild(chip('ⓘ …', false, () => msg('Wczytuję Listę lokalizacji…')));
  else if (S.infoState === 2) chipsEl.appendChild(chip('ⓘ brak wpisu', false, () => msg(`Budynek ${S.infoNum} nie występuje w Liście lokalizacji (arkusz „Harmonogram prac”)`)));
  else if (S.infoState === 3) chipsEl.appendChild(chip('ⓘ błąd', false, () => msg('Nie udało się wczytać Listy lokalizacji: ' + S.infoErr)));
  for (const f of S.folders)
    chipsEl.appendChild(chip(chipText(f), !S.infoOpen && f.folder.id === S.selectedId, () => {
      if (f.folder.id === S.selectedId && thumbsEl.childElementCount) showThumbsPane(); else openFolder(f.folder);
    }));
}

function showThumbsPane() { S.infoOpen = false; infoPane.hidden = true; thumbsEl.hidden = false; rebuildChips(); }

// grupy pól: [tytuł sekcji, "klucz nagłówka|etykieta", ...]
const GROUPS = [
  ['📞  KONTAKT', 'kontakt|Osoba / telefon', 'e-mail|E-mail'],
  ['🔧  INSTALACJA ZEWNĘTRZNA', 'data instalacja zewnętrzna|Data', 'godzina instalacja zewnętrzna|Godzina', 'ekipa instalacja zewnętrzna|Ekipa', 'zdjęcia|Zdjęcia'],
  ['🏠  INSTALACJA WEWNĘTRZNA', 'data instalacja wewnętrzna|Data', 'godzina instalacja wewnętrzna|Godzina', 'ekipa instalacja wewnętrzna|Ekipa',
    '900 skrzynka|Skrzynka 900', 'zdjęcia wewnętrzne|Zdjęcia', 'uwagi po instalacji wew.|Uwagi po instalacji'],
  ['📡  OBIEKT I ZAKRES PRAC', 'ilość głośników 600 4 głośniki / 900 6 głośników|Głośniki', 'maszt|Maszt', 'odgrom jest|Odgromnik', 'zwyżka|Zwyżka', 'zakres prac|Zakres prac'],
  ['📝  UWAGI', 'uwagi/zmiany|'],
];

/** Nawigacja do adresu: Apple Maps na iPhonie (tryb jazdy), Mapy Google gdzie indziej. */
function navigate(address) {
  if (!address || !address.trim()) { msg('Brak adresu'); return; }
  const q = encodeURIComponent(/Krak/.test(address) ? address : address + ', Kraków');
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  location.href = ios ? `https://maps.apple.com/?daddr=${q}&dirflg=d` : `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`;
}

function showInfoPane() {
  if (!S.infoHit || !S.infoHit.length) return;
  S.infoOpen = true;
  infoPane.textContent = '';
  buildInfo(infoPane);
  thumbsEl.hidden = true; infoPane.hidden = false;
  rebuildChips();
}

/** Tekst z klikalnymi e-mailami i numerami telefonów. */
function linkify(text) {
  const f = document.createDocumentFragment();
  const re = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|(\+?\d[\d \-]{7,}\d)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) f.append(text.slice(last, m.index));
    const a = el('a', null, m[0]);
    a.href = m[1] ? 'mailto:' + m[1] : 'tel:' + m[2].replace(/[ \-]/g, '');
    f.append(a); last = m.index + m[0].length;
  }
  if (last < text.length) f.append(text.slice(last));
  return f;
}

function sectionCard(title, rows) {
  const card = el('div', 'card');
  card.appendChild(el('h3', null, title));
  for (const [label, v] of rows) {
    const line = el('div', 'line');
    if (label) line.appendChild(el('div', 'lbl', label));
    const vl = v.trim().toLowerCase();
    if (vl === 'tak' || vl === 'nie') line.appendChild(el('span', 'badge ' + (vl === 'tak' ? 'yes' : 'no'), vl.toUpperCase()));
    else { const d = el('div', 'val'); d.appendChild(linkify(v)); line.appendChild(d); }
    card.appendChild(line);
  }
  return card;
}

function buildInfo(col) {
  const hdr = S.infoHeader || [];
  for (const r of S.infoHit) {
    const cell = i => i < r.length ? r[i] : '';
    const band = el('div', 'band');
    band.appendChild(el('div', 'code', cell(0).trim().toUpperCase()));
    band.appendChild(el('div', 'name', cell(3).trim()));
    const address = fmt('address', cell(4));
    const adr = el('button', 'adr', `📍  ${address}   ➤`); adr.type = 'button';
    adr.onclick = () => navigate(address); // dotknięcie pinezki = nawigacja
    band.appendChild(adr);
    const cat = fmt('category', cell(1)).replace(/[.\s]+$/, '');
    if (cat) band.appendChild(el('div', 'cat', '🏘  ' + cat));
    col.appendChild(band);

    const vals = new Map(); // klucz nagłówka -> wartość
    for (let c = 0; c < r.length; c++) {
      if (c === 0 || c === 1 || c === 3 || c === 4) continue;
      const h = (hdr[c] || '').trim(), val = fmt(h, r[c]);
      if (!val) continue;
      let key = h.toLowerCase();
      if (!key) { if (val.includes('@')) key = 'e-mail'; else continue; }
      vals.set(key, val);
    }
    const used = new Set();
    for (const g of GROUPS) {
      const out = [];
      for (const spec of g.slice(1)) {
        const [k, l] = spec.split('|');
        if (vals.has(k)) { out.push([l, vals.get(k)]); used.add(k); }
      }
      if (out.length) col.appendChild(sectionCard(g[0], out));
    }
    const rest = [...vals].filter(([k]) => !used.has(k));
    if (rest.length) col.appendChild(sectionCard('➕  POZOSTAŁE', rest));
  }
}

// ---- foldery i miniatury
async function openFolder(folder) {
  setStatus('Ładuję listę zdjęć…');
  thumbsEl.textContent = '';
  S.selectedId = folder.id; S.infoOpen = false; infoPane.hidden = true; thumbsEl.hidden = false;
  rebuildChips();
  const g = ++S.reqGen;
  showLoader('ŁADUJĘ ZDJĘCIA…');
  let list;
  try {
    list = await images(folder.id, 3);
    saveList(folder.id, list);
  } catch (e) {
    if (e instanceof AuthError && needLogin()) return;
    list = await loadList(folder.id); // offline: lista z pamięci
    if (g !== S.reqGen) return;
    if (!list) { hideLoader(); msg('Błąd: ' + e.message); return; }
    msg('Brak połączenia – pokazuję zapamiętane zdjęcia');
  }
  if (g !== S.reqGen) return; // użytkownik wybrał już coś innego
  hideLoader();
  setStatus(`✔ ${folder.name}: ${list.length} plików (dotknij miniaturę)`);
  if (!list.length) { msg('Brak zdjęć w folderze ' + folder.name); return; }
  S.imgs = list;
  renderThumbs(list);
  prefetch(list);
}

/** Pula równoległych zadań (jak 4 wątki io w wersji na Androida). */
function pool(n) {
  const q = []; let run = 0;
  const next = () => { while (run < n && q.length) { run++; q.shift()().finally(() => { run--; next(); }); } };
  return fn => { q.push(fn); next(); };
}
const io = pool(4);
let thumbEpoch = 0;

function renderThumbs(list) {
  thumbsEl.textContent = '';
  const epoch = ++thumbEpoch;
  list.forEach((it, i) => {
    const t = el('button', 'tile'); t.type = 'button';
    t.onclick = () => openGallery(i);
    thumbsEl.appendChild(t);
    if (isPdf(it)) { t.classList.add('pdf'); t.textContent = 'PDF'; return; }
    io(async () => {
      if (epoch !== thumbEpoch) return;
      try {
        const url = URL.createObjectURL(await imageBlob(it, 320));
        const im = new Image(); im.src = url; im.alt = '';
        im.onload = () => URL.revokeObjectURL(url);
        t.appendChild(im);
      } catch (_) { }
    });
  });
}

/** Pobiera wszystkie zdjęcia folderu w tle (także do pracy offline). PDF-y dopiero po otwarciu. */
async function prefetch(list) {
  const gen = ++S.preGen;
  for (const it of list) {
    if (gen !== S.preGen) return;
    if (isPdf(it)) continue;
    try { await imageBlob(it, 1600); } catch (e) { if (e instanceof AuthError) return; }
  }
}

// ============================================================ galeria
const gal = $('#gallery'), photo = $('#photo'), counter = $('#counter');
const G = { pos: 0, page: 0, zoom: 1, tx: 0, ty: 0 };
const mem = new Map(); // klucz -> object URL (LRU)

function memGet(k) { const v = mem.get(k); if (v) { mem.delete(k); mem.set(k, v); } return v; }
function memPut(k, url) {
  mem.set(k, url);
  while (mem.size > 24) { const [ok, ou] = mem.entries().next().value; mem.delete(ok); if (photo.src !== ou) URL.revokeObjectURL(ou); }
}

function openGallery(i) {
  G.pos = i; G.page = 0;
  gal.hidden = false;
  history.pushState({ g: 1 }, '');
  show();
}
function closeGallery() { if (gal.hidden) return; gal.hidden = true; photo.removeAttribute('src'); if (history.state && history.state.g) history.back(); }
window.addEventListener('popstate', () => { if (!gal.hidden) { gal.hidden = true; photo.removeAttribute('src'); } });
$('#closeGal').addEventListener('pointerdown', e => e.stopPropagation());
$('#closeGal').addEventListener('click', closeGallery);

function applyT() { photo.style.transform = `translate(${G.tx}px,${G.ty}px) scale(${G.zoom})`; }
function resetZoom() { G.zoom = 1; G.tx = G.ty = 0; applyT(); }

function caption() {
  const it = S.imgs[G.pos];
  const pg = isPdf(it) ? '  PDF' + (it.pdfPages ? ` str. ${G.page + 1}/${it.pdfPages}` : '') : '';
  counter.textContent = `${G.pos + 1} / ${S.imgs.length}  ${it.name}${pg}`;
}

function show() {
  resetZoom(); caption();
  load(G.pos, true); load(G.pos + 1, false); load(G.pos - 1, false);
}

async function load(i, display) {
  if (i < 0 || i >= S.imgs.length) return;
  const it = S.imgs[i];
  if (isPdf(it) && !display) return; // PDF-ów nie ładujemy "na zapas"
  const pg = display ? G.page : 0;
  const key = isPdf(it) ? `${it.id}#${pg}` : it.id;
  const c = memGet(key);
  if (c) { if (display) photo.src = c; return; }
  if (display) photo.removeAttribute('src');
  try {
    const blob = isPdf(it) ? await pdfPageBlob(it, pg, 1600) : await imageBlob(it, 1600);
    const url = URL.createObjectURL(blob);
    memPut(key, url);
    if (display && !gal.hidden && G.pos === i && G.page === pg) { photo.src = url; caption(); }
  } catch (e) {
    if (e instanceof AuthError) { if (display) needLogin(); return; }
    if (display) msg('Błąd: ' + e.message);
  }
}

/** Pociągnięcie w dół: pobierz bieżące zdjęcie/PDF ponownie z Dysku. */
async function refreshCurrent() {
  const it = S.imgs[G.pos], at = G.pos;
  counter.textContent = '⟳ Pobieram ponownie…';
  photo.removeAttribute('src');
  try {
    await dropCache(it);
    for (const k of [...mem.keys()]) if (k === it.id || k.startsWith(it.id + '#')) { URL.revokeObjectURL(mem.get(k)); mem.delete(k); }
    pdfDocs.delete(it.id);
    if (!gal.hidden && G.pos === at) show();
  } catch (e) {
    if (e instanceof AuthError && needLogin()) return;
    msg('Błąd odświeżania: ' + e.message);
    if (!gal.hidden && G.pos === at) show();
  }
}

function step(d) {
  const it = S.imgs[G.pos];
  if (isPdf(it)) {
    if (d > 0 && G.page + 1 < it.pdfPages) { G.page++; show(); return; }
    if (d < 0 && G.page > 0) { G.page--; show(); return; }
  }
  const n = G.pos + d;
  if (n < 0 || n >= S.imgs.length) return;
  G.pos = n; G.page = 0; show();
}

// gesty: stuknięcie (lewa/prawa połowa), przeciągnięcie w bok, pinch-zoom, przesuwanie powiększenia, pociągnięcie w dół = odśwież
const ptrs = new Map();
let g0 = null;
gal.addEventListener('pointerdown', e => {
  gal.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; g0 = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: G.zoom, pinch: true }; }
  else if (ptrs.size === 1) g0 = { x: e.clientX, y: e.clientY, t: Date.now(), lx: e.clientX, ly: e.clientY, moved: false };
});
gal.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId); if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (!g0) return;
  if (g0.pinch && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    G.zoom = Math.max(1, Math.min(6, g0.zoom * Math.hypot(a.x - b.x, a.y - b.y) / g0.dist));
    if (G.zoom === 1) G.tx = G.ty = 0;
    applyT(); return;
  }
  if (g0.pinch) return;
  if (Math.hypot(e.clientX - g0.x, e.clientY - g0.y) > 8) g0.moved = true;
  if (G.zoom > 1) { G.tx += dx; G.ty += dy; applyT(); }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
  const st = g0;
  if (ptrs.size === 0) g0 = null; else if (st && st.pinch) { g0 = { pinch: true, dist: 1, zoom: G.zoom }; return; }
  if (!st || st.pinch || e.type === 'pointercancel' || G.zoom > 1) return;
  const dx = p.x - st.x, dy = p.y - st.y;
  if (dy > 110 && Math.abs(dx) < dy / 2) { refreshCurrent(); return; } // pociągnięcie w dół
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) { step(dx < 0 ? 1 : -1); return; } // przeciągnięcie
  if (!st.moved) step(p.x > gal.clientWidth / 2 ? 1 : -1); // stuknięcie
}
gal.addEventListener('pointerup', endPtr);
gal.addEventListener('pointercancel', endPtr);
document.addEventListener('keydown', e => {
  if (gal.hidden) return;
  if (e.key === 'ArrowRight') step(1); else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'Escape') closeGallery();
});
// iOS: blokada systemowego pinch-zoom / double-tap zoom na całej stronie
for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, e => e.preventDefault());

// ============================================================ start
$('#searchRow').addEventListener('submit', e => { e.preventDefault(); go(false); });
// długie dotknięcie „Pokaż” = odśwież z Dysku
{
  const b = $('#goBtn'); let t = null, long = false;
  b.addEventListener('pointerdown', () => { long = false; t = setTimeout(() => { long = true; go(true); }, 650); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(t));
  b.addEventListener('click', e => { if (long) { e.preventDefault(); e.stopImmediatePropagation(); long = false; } }, true);
  b.addEventListener('contextmenu', e => e.preventDefault());
}

async function start() {
  const err = handleAuthRedirect();
  refreshHistory();
  purge();
  if ('serviceWorker' in navigator) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => { });
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) location.reload(); }); // nowa wersja aplikacji
  }
  navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(() => { }); // prośba o niewygaszanie cache

  if (err) { setStatus('✖ Logowanie nieudane: ' + err + ' (dotknij, aby spróbować ponownie)', login); return; }
  if (getTok()) {
    setStatus('✔ Zalogowano do Google Drive');
    const r = ls.get('resume', null); ls.del('resume');
    if (r && r.num && Date.now() - r.t < 10 * 60 * 1000) { input.value = r.num; go(false); }
  } else if (!navigator.onLine) {
    setStatus('Tryb offline – dostępne zapamiętane budynki');
  } else if (Date.now() - ls.get('loginAt', 0) > 20000) {
    login(); // jak na Androidzie: logowanie od razu po uruchomieniu
  } else {
    setStatus('Nie zalogowano do Google Drive (dotknij, aby zalogować)', login);
  }
}
start();
