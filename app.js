import { firebaseConfig } from './config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
let F = {}, A = {}, auth, fs;
let user = null, ready = false, recipes = new Map(), fromCache = true, pending = false, unsub = null;

/* ---------- Starter recipes (only used for a brand-new, empty account) ---------- */
const SEED = [
 {id:'seed-shawarma',category:'meat',title:'Oven chicken shawarma',prepTime:'1 h 30 min',servings:'4',sample:true,
  ingredients:['1 kg boneless chicken thighs','3 tbsp olive oil','Juice of 1 lemon','4 garlic cloves, crushed','2 tsp cumin','2 tsp sweet paprika','1 tsp turmeric','½ tsp cinnamon','1 tsp salt','1 red onion, sliced'],
  steps:['Mix the oil, lemon juice, garlic, spices and salt in a bowl.','Coat the chicken well and marinate for at least 1 hour, or overnight in the fridge.','Heat the oven to 220°C.','Spread the chicken and onion on a lined tray in one layer.','Roast 25–30 minutes, until the edges char.','Slice thinly and serve in pita with tahini and chopped salad.'],notes:''},
 {id:'seed-majadra',category:'vegan',title:'Majadra (lentils and rice)',prepTime:'1 h',servings:'4',sample:true,
  ingredients:['1 cup green or brown lentils','1 cup basmati rice, rinsed','3 large onions, thinly sliced','½ cup olive oil','1 tsp cumin','½ tsp allspice','1½ tsp salt','Black pepper'],
  steps:['Cook the lentils in plenty of water for 15 minutes; drain.','Fry the onions in the oil over medium heat for 25–30 minutes, until deep brown.','Take out half the onions for topping.','Add rice and spices to the pot and stir for a minute.','Add the lentils and 2 cups boiling water, cover and cook on low for 20 minutes.','Rest 10 minutes off the heat, fluff, and top with the reserved onions.'],notes:''}
];

/* ---------- Helpers ---------- */
const app = document.getElementById('app');
const LABEL = {meat:'Meat', vegan:'Vegan'};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Turns web addresses into tappable links (text is escaped first, so it stays safe).
const linkify = s => esc(s).replace(/\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]'"])/gi, m => {
  const href = /^https?:/i.test(m) ? m : 'https://' + m;
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${m}</a>`;
});
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const lines = t => t.split('\n').map(s => s.trim()).filter(Boolean);
const count = n => n === 1 ? '1 recipe' : `${n} recipes`;
const list = () => [...recipes.values()];
const setTheme = c => { document.body.className = c ? 'theme-' + c : '';
  document.querySelector('meta[name=theme-color]').content = c === 'meat' ? '#7A2630' : c === 'vegan' ? '#3E6B3A' : '#1F2420'; };
const BACK_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
const topbar = (back, title, right = '') => `<header class="top"><a class="back" href="${back}" aria-label="Back">${BACK_ICON}</a><h1 dir="auto">${esc(title)}</h1><div class="top-r">${right}</div></header>`;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2800); }
function resizeImage(file, max = 1000) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('bad image')); };
    img.src = url;
  });
}

/* ---------- Cloud data ---------- */
const recDoc = id => F.doc(fs, 'users', user.uid, 'recipes', id);
function saveRecipe(r) {
  const clean = JSON.parse(JSON.stringify(r));
  recipes.set(clean.id, clean);                       // show it right away
  F.setDoc(recDoc(clean.id), clean).catch(e => toast('Couldn’t save: ' + (e.code || e.message)));
}
function removeRecipe(id) {
  recipes.delete(id);
  F.deleteDoc(recDoc(id)).catch(e => toast('Couldn’t delete: ' + (e.code || e.message)));
}
function syncState() {
  if (!navigator.onLine || fromCache) return {ok:false, text:'Offline. Changes are saved on this device and sync when you’re back online.'};
  if (pending) return {ok:false, text:'Syncing changes…'};
  return {ok:true, text:'All changes synced'};
}
function updateStatus() {
  const el = document.getElementById('sync'); if (!el) return;
  const s = syncState(); el.innerHTML = `<span class="dot ${s.ok ? '' : 'wait'}"></span>${s.text}`;
}
window.addEventListener('online', updateStatus);
window.addEventListener('offline', updateStatus);

/* Recipes from the earlier, phone-only version are uploaded once. */
function readLegacy() {
  return new Promise(res => {
    let r;
    try { r = indexedDB.open('my-cookings'); } catch { return res([]); }
    r.onupgradeneeded = () => { r.transaction.abort(); };
    r.onerror = () => res([]);
    r.onsuccess = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('recipes')) { d.close(); return res([]); }
      const g = d.transaction('recipes').objectStore('recipes').getAll();
      g.onsuccess = () => { d.close(); res(g.result || []); };
      g.onerror = () => { d.close(); res([]); };
    };
  });
}
let migrating = false;
async function maybeMigrate() {
  const key = 'migrated-' + user.uid;
  if (migrating || localStorage.getItem(key)) return;
  migrating = true;
  const legacy = await readLegacy(), serverEmpty = recipes.size === 0;
  let n = 0;
  for (const r of legacy) {
    if (!r || !r.id || !r.title || !LABEL[r.category]) continue;
    if (r.sample && !serverEmpty) continue;            // don't bring back examples deleted elsewhere
    const cur = recipes.get(r.id);
    if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) { saveRecipe(r); n++; }
  }
  if (!legacy.length && serverEmpty) SEED.forEach(r => saveRecipe({...r, photo:null, createdAt:Date.now(), updatedAt:0}));
  localStorage.setItem(key, '1');
  migrating = false;
  if (n) { toast(`Uploaded ${n} recipes from this device`); render(); }
}

function subscribe() {
  const col = F.collection(fs, 'users', user.uid, 'recipes');
  unsub = F.onSnapshot(col, {includeMetadataChanges:true}, snap => {
    const changed = snap.docChanges().length > 0 || !ready;
    recipes = new Map(snap.docs.map(d => [d.id, d.data()]));
    fromCache = snap.metadata.fromCache; pending = snap.metadata.hasPendingWrites;
    const first = !ready; ready = true;
    if (!fromCache) maybeMigrate();
    const editing = /^#\/(edit|new)\//.test(location.hash);
    if (first || (changed && !editing)) render(); else updateStatus();
  }, err => toast('Sync error: ' + (err.code || err.message)));
}

/* ---------- Home illustrations (inline, so they work offline) ---------- */
const ART={meat:`<svg class="art" viewBox="0 0 240 220" aria-hidden="true">
<defs><clipPath id="mc"><path d="M58 104C54 66 96 44 132 52c40 9 60 40 51 74-8 31-40 46-76 42-35-4-47-31-49-64z"/></clipPath></defs>
<path d="M44 104C38 56 88 26 134 36c50 11 76 50 64 92-10 39-50 59-94 54-43-5-57-38-60-78z" fill="#F3DCC8"/>
<path d="M58 104C54 66 96 44 132 52c40 9 60 40 51 74-8 31-40 46-76 42-35-4-47-31-49-64z" fill="#B8464F"/>
<g clip-path="url(#mc)">
 <path d="M70 70c18 6 30 2 44 10s26 4 40 12M64 112c22-4 34 6 52 2s30 6 50 0M84 146c14-6 30 0 44-4" stroke="#E7A9A0" stroke-width="3" fill="none" stroke-linecap="round" opacity=".7"/>
 <g stroke="#5E1A23" stroke-width="9" stroke-linecap="round" opacity=".55"><path d="M40 92l120 -60M40 130l150 -75M60 165l150 -75M100 185l120 -60"/></g>
</g>
<path d="M118 50c-3 30-4 70 2 118" stroke="#F7F1EA" stroke-width="12" stroke-linecap="round" fill="none"/>
<path d="M104 52c8-6 20-6 28 0" stroke="#F7F1EA" stroke-width="12" stroke-linecap="round" fill="none"/>
<g transform="translate(176 150) rotate(-35)">
 <path d="M0 0v70" stroke="#6E5A3C" stroke-width="3" stroke-linecap="round"/>
 <g fill="#8FB07A">
  <ellipse cx="-7" cy="8" rx="3.4" ry="10" transform="rotate(-35 -7 8)"/><ellipse cx="7" cy="14" rx="3.4" ry="10" transform="rotate(35 7 14)"/>
  <ellipse cx="-7" cy="24" rx="3.4" ry="10" transform="rotate(-35 -7 24)"/><ellipse cx="7" cy="30" rx="3.4" ry="10" transform="rotate(35 7 30)"/>
  <ellipse cx="-7" cy="40" rx="3.4" ry="10" transform="rotate(-35 -7 40)"/><ellipse cx="7" cy="46" rx="3.4" ry="10" transform="rotate(35 7 46)"/>
  <ellipse cx="-6" cy="56" rx="3" ry="9" transform="rotate(-35 -6 56)"/><ellipse cx="6" cy="62" rx="3" ry="9" transform="rotate(35 6 62)"/>
 </g>
</g>
<g fill="#2B0E12"><circle cx="34" cy="176" r="4"/><circle cx="46" cy="186" r="3.2"/><circle cx="28" cy="192" r="3.6"/></g>
<g fill="#F7F1EA"><circle cx="200" cy="40" r="3"/><circle cx="212" cy="52" r="2.2"/><circle cx="192" cy="58" r="2.6"/></g>
</svg>`,vegan:`<svg class="art" viewBox="0 0 240 220" aria-hidden="true">
<g transform="translate(150 20) rotate(28)">
 <path d="M-8 6c-10-14-6-30 2-38M0 4c0-16 6-30 16-38M6 8c10-12 24-16 34-12" stroke="#8DC06A" stroke-width="7" stroke-linecap="round" fill="none"/>
 <path d="M-16 10c10-8 26-8 34 0 4 30-6 100-17 118-11-18-21-88-17-118z" fill="#E9883A"/>
 <path d="M-10 36h10M2 58h10M-8 82h9M0 104h7" stroke="#C56A24" stroke-width="3" stroke-linecap="round"/>
</g>
<path d="M30 70c30-34 86-34 104 2-24 26-76 34-104-2z" fill="#9CC680"/>
<path d="M30 70c34 2 70 2 104 2M70 71l-10-16M96 72l-6-18M76 71l-8 14M104 72l-4 14" stroke="#5E8F4C" stroke-width="3" stroke-linecap="round" fill="none"/>
<g transform="translate(92 150) rotate(-18)">
 <path d="M0-62c26 0 40 26 44 52 5 36-16 66-44 66s-49-30-44-66C-40-36-26-62 0-62z" fill="#2C4D29"/>
 <path d="M0-52c21 0 32 22 35 44 4 30-12 54-35 54s-39-24-35-54C-32-30-21-52 0-52z" fill="#C9DC86"/>
 <path d="M0-36c15 0 24 18 25 34 2 22-9 38-25 38s-27-16-25-38C-24-18-15-36 0-36z" fill="#E4EEB4"/>
 <circle cx="0" cy="10" r="17" fill="#8A5A3B"/><circle cx="-5" cy="4" r="5" fill="#A87553"/>
</g>
<g fill="#C7303A"><circle cx="186" cy="176" r="18"/><circle cx="214" cy="160" r="12"/></g>
<path d="M180 160c4-6 10-6 14-2M210 149c3-4 7-4 9-1" stroke="#6E9F48" stroke-width="3.5" stroke-linecap="round" fill="none"/>
<circle cx="180" cy="170" r="4" fill="#E86A6F" opacity=".7"/>
</svg>`};

/* ---------- Screens ---------- */
function viewSetup(msg) {
  setTheme(null);
  app.innerHTML = `<div class="login"><h1>My Cookings</h1><p>${msg || 'Sync isn’t connected yet. Paste your Firebase settings into <b>config.js</b> and upload it to GitHub.'}</p></div>`;
}

function viewLogin() {
  setTheme(null);
  app.innerHTML = `<div class="login">
    <h1>My Cookings</h1>
    <p>Sign in to see your recipes on all your devices.</p>
    <form id="lf">
      <label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn btn-primary" type="submit">Sign in</button>
      <p class="err" id="lerr" role="alert"></p>
    </form></div>`;
  const f = document.getElementById('lf'), err = document.getElementById('lerr');
  f.onsubmit = async e => {
    e.preventDefault(); err.textContent = '';
    const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
    try { await A.signInWithEmailAndPassword(auth, f.email.value.trim(), f.password.value); }
    catch (x) {
      err.textContent = x.code === 'auth/network-request-failed' ? 'No internet connection. Signing in needs internet the first time on each device.'
        : x.code === 'auth/too-many-requests' ? 'Too many attempts. Wait a few minutes and try again.'
        : 'Email or password is wrong.';
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  };
}

function viewHome() {
  setTheme(null);
  const all = list(), n = c => all.filter(r => r.category === c).length;
  app.innerHTML = `<div class="home">
    <header class="home-head"><h1>My Cookings</h1></header>
    <a class="door door-meat" href="#/list/meat">${ART.meat}<h2>Meat</h2><span>${count(n('meat'))}</span></a>
    <a class="door door-vegan" href="#/list/vegan">${ART.vegan}<h2>Vegan</h2><span>${count(n('vegan'))}</span></a>
    <a class="home-foot" href="#/backup" id="sync"></a>
  </div>`;
  updateStatus();
}

function viewList(cat) {
  if (!LABEL[cat]) return go('#/');
  setTheme(cat);
  const items = list().filter(r => r.category === cat).sort((a, b) => a.title.localeCompare(b.title));
  app.innerHTML = `${topbar('#/', LABEL[cat], `<a href="#/new/${cat}">Add recipe</a>`)}
    <div class="wrap">
      ${items.length ? `<input class="search" type="search" id="q" dir="auto" placeholder="Search by name or ingredient" aria-label="Search recipes">` : ''}
      <ul class="list" id="list"></ul>
    </div>`;
  const ul = document.getElementById('list');
  const draw = (q = '') => {
    q = q.trim().toLowerCase();
    const shown = q ? items.filter(r => (r.title + ' ' + (r.ingredients || []).join(' ')).toLowerCase().includes(q)) : items;
    if (!items.length) { ul.innerHTML = `<li class="empty"><p>No ${LABEL[cat].toLowerCase()} recipes yet.</p><a class="btn btn-primary" href="#/new/${cat}">Add your first recipe</a></li>`; return; }
    if (!shown.length) { ul.innerHTML = `<li class="empty"><p>Nothing matches “${esc(q)}”.</p></li>`; return; }
    ul.innerHTML = shown.map(r => `<li><a href="#/r/${encodeURIComponent(r.id)}">
      ${r.photo ? `<img class="thumb" src="${r.photo}" alt="">` : `<span class="thumb" aria-hidden="true">${esc(r.title.charAt(0).toUpperCase())}</span>`}
      <span><b dir="auto">${esc(r.title)}</b><small dir="auto">${[r.prepTime, r.servings && `serves ${r.servings}`].filter(Boolean).map(esc).join(', ') || '&nbsp;'}</small></span>
    </a></li>`).join('');
  };
  const q = document.getElementById('q'), keep = q && sessionStorage.getItem('q-' + cat) || '';
  if (q) { q.value = keep; q.addEventListener('input', () => { sessionStorage.setItem('q-' + cat, q.value); draw(q.value); }); }
  draw(keep);
}

function viewRecipe(id) {
  const r = recipes.get(id); if (!r) return go('#/');
  setTheme(r.category);
  const ing = r.ingredients || [], steps = r.steps || [];
  const meta = [r.prepTime && `Time: ${esc(r.prepTime)}`, r.servings && `Serves ${esc(r.servings)}`].filter(Boolean);
  app.innerHTML = `${topbar('#/list/' + r.category, LABEL[r.category], `<a href="#/edit/${encodeURIComponent(r.id)}">Edit</a>`)}
    <article class="recipe">
      ${r.photo ? `<img class="hero" src="${r.photo}" alt="">` : ''}
      <div class="wrap">
        <h1 class="r-title" dir="auto">${esc(r.title)}</h1>
        ${meta.length ? `<p class="meta">${meta.map(m => `<span dir="auto">${m}</span>`).join('')}</p>` : ''}
        ${r.sample ? `<p class="sample">This is a starter example. Edit it into one of yours, or delete it.</p>` : ''}
        ${ing.length ? `<h2>Ingredients</h2><ul class="ing">${ing.map(i => `<li dir="auto">${linkify(i)}</li>`).join('')}</ul><p class="hint">Tap an ingredient to tick it off while you cook.</p>` : ''}
        ${steps.length ? `<h2>Steps</h2><ol class="steps">${steps.map(s => `<li dir="auto">${linkify(s)}</li>`).join('')}</ol>` : ''}
        ${r.notes ? `<h2>Notes</h2><p class="notes" dir="auto">${linkify(r.notes)}</p>` : ''}
        <button class="btn btn-danger" id="del">Delete recipe</button>
      </div>
    </article>`;
  app.querySelectorAll('.ing li').forEach(li => li.addEventListener('click', e => { if (!e.target.closest('a')) li.classList.toggle('done'); }));
  document.getElementById('del').onclick = () => {
    if (!confirm(`Delete “${r.title}” from all your devices?`)) return;
    removeRecipe(r.id); toast('Recipe deleted'); go('#/list/' + r.category);
  };
}

function viewEdit(id, cat) {
  const existing = id ? recipes.get(id) : null;
  if (id && !existing) return go('#/');
  const r = existing || {category: LABEL[cat] ? cat : 'meat', title:'', ingredients:[], steps:[], photo:null, prepTime:'', servings:'', notes:''};
  let photo = r.photo || null;
  setTheme(r.category);
  const cancel = id ? '#/r/' + encodeURIComponent(id) : '#/list/' + r.category;
  app.innerHTML = `${topbar(cancel, id ? 'Edit recipe' : 'New recipe')}
    <form class="wrap form" id="f" novalidate>
      <fieldset class="seg"><legend>Category</legend>
        ${['meat','vegan'].map(c => `<label><input type="radio" name="category" value="${c}" ${r.category === c ? 'checked' : ''}><span>${LABEL[c]}</span></label>`).join('')}
      </fieldset>
      <label class="field"><span>Recipe name</span><input name="title" dir="auto" value="${esc(r.title)}" autocomplete="off"></label>
      <div class="field"><span>Photo</span>
        <div class="photo-box" id="pbox"></div>
        <div class="photo-actions">
          <label class="btn">Choose photo<input type="file" accept="image/*" id="pfile"></label>
          <button type="button" class="btn" id="prm">Remove photo</button>
        </div>
      </div>
      <div class="row">
        <label class="field"><span>Time</span><input name="prepTime" dir="auto" value="${esc(r.prepTime)}" placeholder="45 min"></label>
        <label class="field"><span>Servings</span><input name="servings" dir="auto" value="${esc(r.servings)}" placeholder="4"></label>
      </div>
      <label class="field"><span>Ingredients</span><small>One ingredient per line</small><textarea name="ingredients" dir="auto" rows="8">${esc((r.ingredients || []).join('\n'))}</textarea></label>
      <label class="field"><span>Steps</span><small>One step per line</small><textarea name="steps" dir="auto" rows="9">${esc((r.steps || []).join('\n'))}</textarea></label>
      <label class="field"><span>Notes</span><small>Web addresses become tappable links</small><textarea name="notes" dir="auto" rows="3">${esc(r.notes)}</textarea></label>
      <div class="actions"><a class="btn" href="${cancel}">Cancel</a><button class="btn btn-primary" type="submit">Save recipe</button></div>
    </form>`;
  const f = document.getElementById('f'), pbox = document.getElementById('pbox'), prm = document.getElementById('prm');
  const drawPhoto = () => { pbox.innerHTML = photo ? `<img src="${photo}" alt="Recipe photo">` : ''; prm.hidden = !photo; };
  drawPhoto();
  f.querySelectorAll('input[name=category]').forEach(i => i.addEventListener('change', () => setTheme(i.value)));
  document.getElementById('pfile').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try { photo = await resizeImage(file); drawPhoto(); } catch { toast('That file couldn’t be opened as a photo.'); }
  });
  prm.onclick = () => { photo = null; drawPhoto(); };
  f.onsubmit = e => {
    e.preventDefault();
    const d = new FormData(f), title = d.get('title').trim();
    if (!title) { toast('Add a recipe name to save.'); f.title.focus(); return; }
    const now = Date.now();
    const rec = {...(existing || {}), id: existing ? existing.id : uid(), category: d.get('category'), title,
      ingredients: lines(d.get('ingredients')), steps: lines(d.get('steps')), notes: d.get('notes').trim(),
      prepTime: d.get('prepTime').trim(), servings: d.get('servings').trim(), photo,
      createdAt: existing?.createdAt || now, updatedAt: now};
    delete rec.sample;
    saveRecipe(rec); toast('Recipe saved'); go('#/r/' + encodeURIComponent(rec.id));
  };
}

/* ---------- Backup (extra safety on top of sync) ---------- */
function downloadBackup() {
  const json = JSON.stringify({app:'my-cookings', version:1, exportedAt:new Date().toISOString(), recipes:list()});
  const url = URL.createObjectURL(new Blob([json], {type:'application/json'}));
  const a = Object.assign(document.createElement('a'), {href:url, download:`my-cookings-backup-${new Date().toISOString().slice(0,10)}.json`});
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Backup saved to Downloads');
}
async function importBackup(file) {
  let data; try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (!data || data.app !== 'my-cookings' || !Array.isArray(data.recipes)) { toast('That file isn’t a My Cookings backup.'); return; }
  let added = 0, updated = 0;
  for (const r of data.recipes) {
    if (!r || !r.id || !r.title || !LABEL[r.category]) continue;
    const cur = recipes.get(r.id);
    if (!cur) { saveRecipe(r); added++; } else if ((r.updatedAt || 0) > (cur.updatedAt || 0)) { saveRecipe(r); updated++; }
  }
  toast(`Restored ${added} new and ${updated} updated recipes`); render();
}
function viewBackup() {
  setTheme(null);
  app.innerHTML = `${topbar('#/', 'Sync and backup')}
    <div class="wrap backup">
      <section>
        <h2>Sync</h2>
        <p>Recipes you add, edit or delete appear on every device where you’re signed in.</p>
        <p class="status" id="sync"></p>
        <p>Signed in as <b>${esc(user.email)}</b></p>
        <button class="btn" id="out">Sign out</button>
      </section>
      <section>
        <h2>Backup file</h2>
        <p>Your recipes are already stored safely in the cloud. A backup file is an extra copy you can keep yourself.</p>
        <div class="btn-row">
          <button class="btn btn-primary" id="dl">Download backup file</button>
          <label class="btn">Restore from file<input type="file" accept=".json,.txt,application/json,text/plain" id="imp"></label>
        </div>
      </section>
    </div>`;
  updateStatus();
  document.getElementById('dl').onclick = downloadBackup;
  document.getElementById('out').onclick = () => { if (confirm('Sign out on this device? Your recipes stay in the cloud.')) A.signOut(auth); };
  document.getElementById('imp').addEventListener('change', e => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; });
}

/* ---------- Router ---------- */
function go(h) { if (location.hash === h) render(); else location.hash = h; }
function render() {
  if (!user) return;
  if (!ready) { app.innerHTML = '<div class="login"><p>Loading your recipes…</p></div>'; return; }
  const [, view, arg] = (location.hash.slice(1) || '/').split('/');
  const a = arg && decodeURIComponent(arg);
  if (view === 'list') return viewList(a);
  if (view === 'r') return viewRecipe(a);
  if (view === 'edit') return viewEdit(a);
  if (view === 'new') return viewEdit(null, a);
  if (view === 'backup') return viewBackup();
  return viewHome();
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

/* ---------- Start ---------- */
(async () => {
  if ('serviceWorker' in navigator) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', {updateViaCache:'none'}).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !window.__r) { window.__r = 1; location.reload(); } });
  }
  if (!firebaseConfig || !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('PASTE')) return viewSetup();
  let appM, authM;
  try {
    [appM, authM, F] = await Promise.all([import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js')]);
  } catch { return viewSetup('The app needs internet the very first time it opens on a device. Connect and reload.'); }
  A = authM;
  const fbApp = appM.initializeApp(firebaseConfig);
  auth = A.getAuth(fbApp);
  fs = F.initializeFirestore(fbApp, {localCache: F.persistentLocalCache({tabManager: F.persistentMultipleTabManager()})});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  app.innerHTML = '<div class="login"><p>Loading…</p></div>';
  A.onAuthStateChanged(auth, u => {
    if (unsub) { unsub(); unsub = null; }
    user = u; ready = false; recipes = new Map();
    if (!u) return viewLogin();
    render(); subscribe();
  });
})();
