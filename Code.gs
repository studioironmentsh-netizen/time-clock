/**
 * iRON MENTSH · שעון נוכחות למשרד
 * שרת ב-Google Apps Script שיושב על גיליון גוגל.
 *
 * התקנה (פעם אחת):
 *   1. בגיליון: הרחבות → Apps Script
 *   2. למחוק את מה שיש ולהדביק את כל הקובץ הזה → שמירה
 *   3. פריסה → פריסה חדשה → סוג: אפליקציית אינטרנט
 *      להפעיל בתור: אני | מי מורשה גישה: כל אחד → פריסה → לאשר הרשאות
 *   4. להעתיק את כתובת אפליקציית האינטרנט ולשלוח לקלוד
 *
 * עקרונות:
 *   - כל לחיצה היא שורה חדשה בלשונית "אירועים". שום שורה לא נמחקת.
 *     תיקון של מנהל נרשם כשורה חדשה ("ביטול" או "הוספה ידנית").
 *   - השעה נקבעת בשרת, לא בטלפון.
 *   - לעובד יכולה להיות משמרת פתוחה אחת ופרויקט פתוח אחד.
 *   - קודים וסיסמת מנהל נשמרים מוצפנים (hash), לא כטקסט.
 */

var TZ = 'Asia/Jerusalem';
var SH_EMP = 'עובדים';
var SH_EV = 'אירועים';
var SH_PRJ = 'פרויקטים';
var EMP_HEAD = ['מזהה', 'שם', 'קוד (מוצפן)', 'פעיל', 'נוצר'];
var EV_HEAD = ['מזהה', 'תאריך', 'שעה', 'זמן ISO', 'עובד_מזהה', 'עובד', 'פעולה', 'קוד_פעולה',
               'פרויקט_מזהה', 'פרויקט', 'מקור', 'הערה', 'מבטל_אירוע', 'נרשם_בשרת'];
var PRJ_HEAD = ['מזהה', 'שם', 'לקוח', 'פעיל', 'נוצר'];
var KIND_LABEL = { IN: 'כניסה', OUT: 'יציאה', PSTART: 'פתיחת פרויקט', PEND: 'סגירת פרויקט', VOID: 'ביטול' };
var MAX_FAILS = 5, LOCK_SECONDS = 600, OFFLINE_WINDOW_MS = 12 * 3600 * 1000;

/* ---------- כניסה ---------- */

function doGet(e) {
  return json_({ ok: true, app: 'iron-attendance', time: new Date().toISOString() });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'בקשה לא תקינה' }); }
  try {
    var fn = ACTIONS[req.action];
    if (!fn) return json_({ ok: false, error: 'פעולה לא מוכרת' });
    var out = fn(req);
    out.ok = true;
    return json_(out);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

var ACTIONS = {
  ping: function () { ensureSheets_(); return { time: new Date().toISOString(), hasAdmin: !!props_().getProperty('ADMIN_HASH') }; },

  listEmployees: function () {
    return { employees: readEmployees_().filter(function (x) { return x.active; })
      .map(function (x) { return { id: x.id, name: x.name }; }) };
  },

  register: function (r) {
    var name = String(r.name || '').trim().replace(/\s+/g, ' ');
    var pin = String(r.pin || '');
    if (name.length < 2 || name.length > 40) throw new Error('שם צריך להיות בין 2 ל-40 תווים');
    if (!/^\d{4}$/.test(pin)) throw new Error('קוד אישי צריך להיות 4 ספרות');
    return withLock_(function () {
      var emps = readEmployees_();
      if (emps.some(function (x) { return x.active && x.name === name; })) throw new Error('כבר קיים עובד פעיל בשם הזה');
      var id = 'E' + shortId_();
      sheet_(SH_EMP).appendRow([id, name, hash_(pin), 'כן', isoNow_()]);
      return { employee: { id: id, name: name } };
    });
  },

  status: function (r) {
    var emp = authEmployee_(r.empId, r.pin);
    return statusFor_(emp);
  },

  punch: function (r) {
    var emp = authEmployee_(r.empId, r.pin);
    var kind = String(r.kind || '');
    if (['IN', 'OUT', 'PSTART', 'PEND'].indexOf(kind) < 0) throw new Error('פעולה לא מוכרת');
    return withLock_(function () {
      var events = readEvents_();
      if (r.clientId && events.some(function (ev) { return ev.id === r.clientId; })) {
        return statusFor_(emp, events); // כבר נרשם (שליחה כפולה)
      }
      var now = new Date(), when = now, source = 'אפליקציה';
      if (r.offlineTime) { // לחיצה שנשמרה בטלפון בלי אינטרנט
        var t = new Date(r.offlineTime);
        if (isNaN(t) || t.getTime() > now.getTime() + 120000) throw new Error('שעה לא תקינה');
        if (t.getTime() < now.getTime() - OFFLINE_WINDOW_MS) throw new Error('הלחיצה ישנה מ-12 שעות ולא נשמרה. פנה למנהל.');
        var lastT = 0;
        events.forEach(function (ev) { if (ev.empId === emp.id && ev.kind !== 'VOID' && ev.time.getTime() > lastT) lastT = ev.time.getTime(); });
        if (t.getTime() < lastT) throw new Error('הלחיצה שנשמרה בטלפון מוקדמת מלחיצה שכבר נרשמה. פנה למנהל.');
        when = t; source = 'נשמר בלי אינטרנט';
      }
      if (r.source === 'kiosk' && source === 'אפליקציה') source = 'עמדת משרד';
      var st = timeline_(events, emp.id).openState[emp.id] || {};
      var rows = [], id = r.clientId || ('V' + shortId_());
      var prj = null;
      if (kind === 'IN') {
        if (st.shiftStart) throw new Error('כבר יש משמרת פתוחה מ-' + hm_(st.shiftStart));
      } else if (kind === 'OUT') {
        if (!st.shiftStart) throw new Error('אין משמרת פתוחה');
        if (st.project) rows.push(evRow_('V' + shortId_(), when, emp, 'PEND', st.project, source, 'נסגר אוטומטית ביציאה', ''));
      } else if (kind === 'PSTART') {
        if (!st.shiftStart) throw new Error('צריך קודם ללחוץ "התחלתי"');
        prj = findProject_(r.projectId);
        if (!prj || !prj.active) throw new Error('הפרויקט לא נמצא');
        if (st.project && st.project.id === prj.id) throw new Error('הפרויקט הזה כבר פתוח');
        if (st.project) rows.push(evRow_('V' + shortId_(), when, emp, 'PEND', st.project, source, 'הוחלף בפרויקט אחר', ''));
      } else if (kind === 'PEND') {
        if (!st.project) throw new Error('אין פרויקט פתוח');
        prj = st.project;
      }
      rows.push(evRow_(id, when, emp, kind, prj, source, '', ''));
      appendRows_(SH_EV, rows);
      return statusFor_(emp);
    });
  },

  /* ---------- מנהל ---------- */

  adminLogin: function (r) {
    var p = props_();
    if (!p.getProperty('ADMIN_HASH')) {
      if (String(r.password || '').length < 6) throw new Error('בכניסה הראשונה בוחרים סיסמה של 6 תווים לפחות');
      p.setProperty('ADMIN_HASH', hash_('admin:' + r.password));
      return { firstTime: true };
    }
    authAdmin_(r.password);
    return { firstTime: false };
  },

  adminData: function (r) {
    authAdmin_(r.password);
    var events = readEvents_();
    var tl = timeline_(events);
    var from = r.from ? new Date(r.from).getTime() : 0, to = r.to ? new Date(r.to).getTime() : Infinity;
    function inRange(x) { var s = x.start.getTime(), e = (x.end || new Date()).getTime(); return e >= from && s < to; }
    function ser(x) { return { empId: x.empId, projectId: x.projectId || '', start: x.start.toISOString(), end: x.end ? x.end.toISOString() : null }; }
    return {
      now: new Date().toISOString(),
      employees: readEmployees_().map(function (x) { return { id: x.id, name: x.name, active: x.active, created: x.created }; }),
      projects: readProjects_(),
      shifts: tl.shifts.filter(inRange).map(ser),
      segments: tl.segments.filter(inRange).map(ser),
      open: Object.keys(tl.openState).map(function (k) {
        var s = tl.openState[k];
        return { empId: k, shiftStart: s.shiftStart ? s.shiftStart.toISOString() : null,
                 projectId: s.project ? s.project.id : null, projectStart: s.projectStart ? s.projectStart.toISOString() : null };
      }).filter(function (x) { return x.shiftStart; }),
      events: events.filter(function (ev) { var t = ev.time.getTime(); return t >= from && t < to; })
        .map(function (ev) { return { id: ev.id, time: ev.time.toISOString(), empId: ev.empId, kind: ev.kind,
          projectId: ev.projectId, source: ev.source, note: ev.note, voids: ev.voids, voided: !!tl.voided[ev.id] }; })
    };
  },

  adminAddProject: function (r) {
    authAdmin_(r.password);
    var name = String(r.name || '').trim(), client = String(r.client || '').trim();
    if (name.length < 2) throw new Error('שם פרויקט קצר מדי');
    return withLock_(function () {
      if (readProjects_().some(function (x) { return x.active && x.name === name; })) throw new Error('כבר יש פרויקט פעיל בשם הזה');
      var id = 'P' + shortId_();
      sheet_(SH_PRJ).appendRow([id, name, client, 'כן', isoNow_()]);
      return { project: { id: id, name: name, client: client, active: true } };
    });
  },

  adminSetProjectActive: function (r) {
    authAdmin_(r.password);
    return withLock_(function () { setFlag_(SH_PRJ, r.id, !!r.active); return {}; });
  },

  adminSetEmployeeActive: function (r) {
    authAdmin_(r.password);
    return withLock_(function () { setFlag_(SH_EMP, r.id, !!r.active); return {}; });
  },

  adminResetPin: function (r) {
    authAdmin_(r.password);
    if (!/^\d{4}$/.test(String(r.pin || ''))) throw new Error('קוד אישי צריך להיות 4 ספרות');
    return withLock_(function () {
      var sh = sheet_(SH_EMP), row = findRow_(sh, r.id);
      if (!row) throw new Error('העובד לא נמצא');
      sh.getRange(row, 3).setValue(hash_(String(r.pin)));
      cache_().remove('fail_' + r.id);
      return {};
    });
  },

  adminAddEvent: function (r) {
    authAdmin_(r.password);
    var kind = String(r.kind || '');
    if (['IN', 'OUT', 'PSTART', 'PEND'].indexOf(kind) < 0) throw new Error('פעולה לא מוכרת');
    var when = new Date(r.time);
    if (isNaN(when)) throw new Error('שעה לא תקינה');
    if (when.getTime() > Date.now() + 60000) throw new Error('אי אפשר לרשום שעה עתידית');
    var emp = readEmployees_().filter(function (x) { return x.id === r.empId; })[0];
    if (!emp) throw new Error('העובד לא נמצא');
    var prj = null;
    if (kind === 'PSTART' || kind === 'PEND') { prj = findProject_(r.projectId); if (!prj) throw new Error('צריך לבחור פרויקט'); }
    return withLock_(function () {
      appendRows_(SH_EV, [evRow_('V' + shortId_(), when, emp, kind, prj, 'מנהל', String(r.note || 'הוספה ידנית'), '')]);
      return {};
    });
  },

  adminVoidEvent: function (r) {
    authAdmin_(r.password);
    return withLock_(function () {
      var ev = readEvents_().filter(function (x) { return x.id === r.eventId; })[0];
      if (!ev) throw new Error('האירוע לא נמצא');
      if (ev.kind === 'VOID') throw new Error('אי אפשר לבטל ביטול');
      var emp = { id: ev.empId, name: ev.empName };
      appendRows_(SH_EV, [evRow_('V' + shortId_(), new Date(), emp, 'VOID',
        ev.projectId ? { id: ev.projectId, name: ev.projectName } : null, 'מנהל', String(r.note || 'ביטול ידני'), ev.id)]);
      return {};
    });
  },

  adminChangePassword: function (r) {
    authAdmin_(r.password);
    if (String(r.newPassword || '').length < 6) throw new Error('סיסמה חדשה: 6 תווים לפחות');
    props_().setProperty('ADMIN_HASH', hash_('admin:' + r.newPassword));
    return {};
  }
};

/* ---------- לוגיקת זמן ---------- */

/** עובר על כל האירועים לפי סדר הזמן ובונה משמרות, קטעי פרויקט ומצב פתוח לכל עובד. */
function timeline_(events, onlyEmp) {
  var voided = {};
  events.forEach(function (ev) { if (ev.kind === 'VOID' && ev.voids) voided[ev.voids] = true; });
  var list = events.filter(function (ev) {
    return ev.kind !== 'VOID' && !voided[ev.id] && (!onlyEmp || ev.empId === onlyEmp);
  }).sort(function (a, b) { return a.time - b.time || a.order - b.order; });
  var open = {}, shifts = [], segments = [];
  list.forEach(function (ev) {
    var s = open[ev.empId] || (open[ev.empId] = { shiftStart: null, project: null, projectStart: null });
    function closeProject(t) {
      if (s.project) segments.push({ empId: ev.empId, projectId: s.project.id, start: s.projectStart, end: t });
      s.project = null; s.projectStart = null;
    }
    if (ev.kind === 'IN') {
      if (!s.shiftStart) s.shiftStart = ev.time;
    } else if (ev.kind === 'OUT') {
      closeProject(ev.time);
      if (s.shiftStart) { shifts.push({ empId: ev.empId, start: s.shiftStart, end: ev.time }); s.shiftStart = null; }
    } else if (ev.kind === 'PSTART') {
      closeProject(ev.time);
      s.project = { id: ev.projectId, name: ev.projectName }; s.projectStart = ev.time;
    } else if (ev.kind === 'PEND') {
      closeProject(ev.time);
    }
  });
  Object.keys(open).forEach(function (k) {
    var s = open[k];
    if (s.shiftStart) shifts.push({ empId: k, start: s.shiftStart, end: null });
    if (s.project) segments.push({ empId: k, projectId: s.project.id, start: s.projectStart, end: null });
  });
  return { shifts: shifts, segments: segments, openState: open, voided: voided };
}

function statusFor_(emp, events) {
  events = events || readEvents_();
  var tl = timeline_(events, emp.id);
  var st = tl.openState[emp.id] || {};
  var dayStart = startOfDay_(new Date()), now = new Date();
  var todayMin = 0;
  tl.shifts.forEach(function (s) {
    var a = Math.max(s.start.getTime(), dayStart.getTime()), b = (s.end || now).getTime();
    if (b > a) todayMin += (b - a) / 60000;
  });
  return {
    employee: { id: emp.id, name: emp.name },
    now: now.toISOString(),
    shiftStart: st.shiftStart ? st.shiftStart.toISOString() : null,
    project: st.project ? { id: st.project.id, name: st.project.name, start: st.projectStart.toISOString() } : null,
    todayMinutes: Math.round(todayMin),
    projects: readProjects_().filter(function (p) { return p.active; }).map(function (p) { return { id: p.id, name: p.name, client: p.client }; })
  };
}

/* ---------- גיליונות ---------- */

function ensureSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  [[SH_EMP, EMP_HEAD], [SH_EV, EV_HEAD], [SH_PRJ, PRJ_HEAD]].forEach(function (d) {
    var sh = ss.getSheetByName(d[0]);
    if (!sh) {
      sh = ss.insertSheet(d[0]);
      sh.getRange(1, 1, 1, d[1].length).setValues([d[1]]).setFontWeight('bold');
      sh.getRange(1, 1, 1000, d[1].length).setNumberFormat('@');
      sh.setFrozenRows(1);
      if (sh.setRightToLeft) sh.setRightToLeft(true);
    }
  });
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('גיליון1');
  if (def && ss.getSheets().length > 3 && def.getLastRow() === 0) ss.deleteSheet(def);
}

function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) { ensureSheets_(); sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }
  return sh;
}

function rows_(name) {
  var sh = sheet_(name), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, sh.getLastColumn()).getValues();
}

function appendRows_(name, rows) {
  var sh = sheet_(name);
  var start = sh.getLastRow() + 1;
  var rng = sh.getRange(start, 1, rows.length, rows[0].length);
  rng.setNumberFormat('@');
  rng.setValues(rows);
}

function readEmployees_() {
  return rows_(SH_EMP).filter(function (r) { return r[0]; }).map(function (r) {
    return { id: String(r[0]), name: String(r[1]), pinHash: String(r[2]), active: String(r[3]) === 'כן', created: String(r[4]) };
  });
}

function readProjects_() {
  return rows_(SH_PRJ).filter(function (r) { return r[0]; }).map(function (r) {
    return { id: String(r[0]), name: String(r[1]), client: String(r[2]), active: String(r[3]) === 'כן' };
  });
}

function readEvents_() {
  return rows_(SH_EV).filter(function (r) { return r[0]; }).map(function (r, i) {
    return { id: String(r[0]), time: new Date(String(r[3])), empId: String(r[4]), empName: String(r[5]),
             kind: String(r[7]), projectId: String(r[8] || ''), projectName: String(r[9] || ''),
             source: String(r[10] || ''), note: String(r[11] || ''), voids: String(r[12] || ''), order: i };
  }).filter(function (ev) { return !isNaN(ev.time); });
}

function evRow_(id, when, emp, kind, prj, source, note, voids) {
  return [id, Utilities.formatDate(when, TZ, 'yyyy-MM-dd'), Utilities.formatDate(when, TZ, 'HH:mm:ss'),
          when.toISOString(), emp.id, emp.name, KIND_LABEL[kind], kind,
          prj ? prj.id : '', prj ? prj.name : '', source, note || '', voids || '', isoNow_()];
}

function findProject_(id) { return readProjects_().filter(function (p) { return p.id === id; })[0] || null; }

function findRow_(sh, id) {
  var n = sh.getLastRow(); if (n < 2) return 0;
  var ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}

function setFlag_(name, id, on) {
  var sh = sheet_(name), row = findRow_(sh, id);
  if (!row) throw new Error('לא נמצא');
  sh.getRange(row, 4).setValue(on ? 'כן' : 'לא');
}

/* ---------- אבטחה ---------- */

function authEmployee_(empId, pin) {
  var c = cache_(), key = 'fail_' + empId;
  var fails = Number(c.get(key) || 0);
  if (fails >= MAX_FAILS) throw new Error('יותר מדי ניסיונות שגויים. נסה שוב בעוד 10 דקות או פנה למנהל.');
  var emp = readEmployees_().filter(function (x) { return x.id === empId; })[0];
  if (!emp || !emp.active) throw new Error('העובד לא נמצא או לא פעיל');
  if (emp.pinHash !== hash_(String(pin || ''))) {
    c.put(key, String(fails + 1), LOCK_SECONDS);
    throw new Error('קוד שגוי');
  }
  return emp;
}

function authAdmin_(password) {
  var c = cache_(), fails = Number(c.get('fail_admin') || 0);
  if (fails >= MAX_FAILS) throw new Error('יותר מדי ניסיונות. נסה שוב בעוד 10 דקות.');
  var h = props_().getProperty('ADMIN_HASH');
  if (!h) throw new Error('עדיין לא נקבעה סיסמת מנהל');
  if (h !== hash_('admin:' + String(password || ''))) {
    c.put('fail_admin', String(fails + 1), LOCK_SECONDS);
    throw new Error('סיסמה שגויה');
  }
}

function hash_(s) {
  var p = props_(), salt = p.getProperty('SALT');
  if (!salt) { salt = Utilities.getUuid(); p.setProperty('SALT', salt); }
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/* ---------- עזרים ---------- */

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function props_() { return PropertiesService.getScriptProperties(); }
function cache_() { return CacheService.getScriptCache(); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function isoNow_() { return new Date().toISOString(); }
function shortId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function hm_(d) { return Utilities.formatDate(d, TZ, 'HH:mm'); }
function startOfDay_(d) {
  var s = Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'00:00:00XXX");
  return new Date(s);
}
