/* ============================================================
   EVENT KRAFT – automat powiadomień
   Uruchamia go GitHub Actions co ~15 minut (plik
   .github/workflows/powiadomienia.yml). Sprawdza bazę i wysyła
   powiadomienia push:
   - o nowych zadaniach (albo nowo przypisanych osobach),
   - dzień przed terminem (od 17:00) i w dniu terminu (od 8:00),
   - dzień przed wydarzeniem (od 17:00) do wszystkich,
   - powiadomienie testowe po włączeniu powiadomień.
   Klucz dostępu do Firebase jest w sekretach GitHuba
   (FIREBASE_SERVICE_ACCOUNT), nie w tym pliku.
   ============================================================ */
const SITE = (process.env.SITE_URL || 'https://krystian-webs.github.io/stowarzyszenie/').replace(/\/?$/, '/');
const TZ = 'Europe/Warsaw';

function warsawNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return x.toISOString().slice(0, 10);
}
const MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
const plDate = s => { const [, m, d] = s.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };

async function main({ db, fcm, now = new Date(), log = console.log }) {
  const [pS, tS, eS, kS, sS, metaSnap] = await Promise.all([
    db.collection('people').get(), db.collection('tasks').get(), db.collection('events').get(),
    db.collection('tokens').get(), db.collection('sent').get(), db.doc('system/notify').get()
  ]);
  const docs = s => s.docs.map(d => ({ id: d.id, ...d.data() }));
  const people = docs(pS), tasks = docs(tS), events = docs(eS), tokens = docs(kS);
  const sent = new Set(sS.docs.map(d => d.id));
  const firstRun = !metaSnap.exists;

  const byId = Object.fromEntries(people.map(p => [p.id, p]));
  const evById = Object.fromEntries(events.map(e => [e.id, e]));
  const active = people.filter(p => !p.pending);
  const shortName = p => p ? (p.nick || String(p.name || '').split(' ')[0]) : '';
  const assignees = t => (t.personIds || (t.personId ? [t.personId] : [])).filter(id => byId[id] && !byId[id].pending);
  const recipients = t => t.all ? active.map(p => p.id) : assignees(t);
  const tEnd = t => (t.endDate && t.endDate > t.date ? t.endDate : t.date);
  const linkFor = t => SITE + (evById[t.eventId] ? '#/e/' + t.eventId : '#/me/zadania');
  const { date: today, hour } = warsawNow(now);

  const queue = [];   // {key, pid, title, body, link}
  const mark = [];    // klucze do zapisania jako wysłane
  const push = (key, pid, title, body, link) => {
    if (sent.has(key)) return;
    sent.add(key); mark.push(key);
    if (!firstRun) queue.push({ key, pid, title, body, link });
  };

  for (const t of tasks) {
    if (t.done) continue;
    const ev = evById[t.eventId];
    const creator = byId[t.createdBy];
    for (const pid of recipients(t)) {
      // nowe zadanie / nowo przypisana osoba (nie powiadamiamy autora o jego własnym zadaniu)
      if (pid !== t.createdBy) {
        const due = t.date ? (tEnd(t) !== t.date ? ` · od ${plDate(t.date)} do ${plDate(tEnd(t))}` : ` · do ${plDate(t.date)}`) : '';
        push(`new_${t.id}_${pid}`, pid,
          'Nowe zadanie' + (ev ? ` · ${ev.name}` : ''),
          t.title + (creator ? ` (od ${shortName(creator)})` : '') + due,
          linkFor(t));
      }
      if (!t.date) continue;
      const end = tEnd(t);
      if (today === addDays(end, -1) && hour >= 17)
        push(`due1_${t.id}_${pid}_${end}`, pid, 'Jutro mija termin', t.title + (ev ? ` · ${ev.name}` : ''), linkFor(t));
      if (today === end && hour >= 8)
        push(`due0_${t.id}_${pid}_${end}`, pid, 'Dziś mija termin', t.title + (ev ? ` · ${ev.name}` : ''), linkFor(t));
    }
  }
  for (const e of events) {
    if (!e.date || !(today === addDays(e.date, -1) && hour >= 17)) continue;
    for (const p of active)
      push(`ev1_${e.id}_${p.id}_${e.date}`, p.id, `Jutro: ${e.name}`,
        [e.time ? 'godz. ' + e.time + (e.endTime ? '–' + e.endTime : '') : '', e.place].filter(Boolean).join(' · ') || 'Do zobaczenia!',
        SITE + '#/e/' + e.id);
  }

  // wysyłka
  const tokensOf = pid => tokens.filter(k => k.personId === pid && k.token);
  const dead = new Set();
  let ok = 0, fail = 0;
  const sendTo = async (k, title, body, link) => {
    if (dead.has(k.id)) return;
    try {
      await fcm.send({
        token: k.token,
        webpush: {
          notification: { title, body, icon: SITE + 'icon-192.png', badge: SITE + 'icon-192.png' },
          fcmOptions: { link }
        }
      });
      ok++;
    } catch (e) {
      fail++;
      const code = e && (e.code || (e.errorInfo && e.errorInfo.code));
      log('Błąd wysyłki', k.id, code || e);
      if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'].includes(code)) dead.add(k.id);
    }
  };
  for (const q of queue) for (const k of tokensOf(q.pid)) await sendTo(k, q.title, q.body, q.link);

  // powiadomienie testowe po włączeniu
  const welcomed = [];
  for (const k of tokens) {
    if (k.welcomed || dead.has(k.id)) continue;
    await sendTo(k, 'Powiadomienia działają ✅', 'Będziemy Ci przypominać o nowych zadaniach i terminach.', SITE + '#/me');
    if (!dead.has(k.id)) welcomed.push(k.id);
  }

  // zapis stanu
  const writes = [];
  if (firstRun) writes.push(['set', 'system/notify', { since: now.getTime() }]);
  for (const key of mark) writes.push(['set', 'sent/' + key, { at: now.getTime() }]);
  for (const id of welcomed) writes.push(['update', 'tokens/' + id, { welcomed: true }]);
  for (const id of dead) writes.push(['delete', 'tokens/' + id]);
  for (let i = 0; i < writes.length; i += 400) {
    const b = db.batch();
    for (const [op, path, data] of writes.slice(i, i + 400)) {
      const ref = db.doc(path);
      if (op === 'set') b.set(ref, data); else if (op === 'update') b.update(ref, data); else b.delete(ref);
    }
    await b.commit();
  }
  log(`${firstRun ? 'Pierwsze uruchomienie (bez wysyłki zaległości). ' : ''}Wysłano: ${ok}, błędy: ${fail}, oznaczono: ${mark.length}, nowe urządzenia: ${welcomed.length}, usunięte: ${dead.size}.`);
  return { ok, fail, marked: mark.length, queue, welcomed, dead: [...dead], firstRun };
}

module.exports = { main, warsawNow, addDays };

if (require.main === module) {
  (async () => {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) { console.error('Brak sekretu FIREBASE_SERVICE_ACCOUNT w ustawieniach repozytorium.'); process.exit(1); }
    const { initializeApp, cert } = require('firebase-admin/app');
    const { getFirestore } = require('firebase-admin/firestore');
    const { getMessaging } = require('firebase-admin/messaging');
    initializeApp({ credential: cert(JSON.parse(raw)) });
    await main({ db: getFirestore(), fcm: getMessaging() });
  })().catch(e => { console.error(e); process.exit(1); });
}
