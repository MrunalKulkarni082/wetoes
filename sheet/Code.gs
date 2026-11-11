/**
 * Wetoes → Google Sheet collector.
 * Paste into the sheet's Extensions → Apps Script, then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone). Put the /exec URL in docs/config.js → sheetUrl.
 *
 * Writes to two tabs, created on first use:
 *   signups:  time | email | name | language | page
 *   feedback: time | email | kind | rating | comment | pick | page
 */
const MAX = 1000;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (_) { return ok(); }
  const email = clean(d.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return ok();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (d.type === 'signup') {
      const sh = tab('signups', ['time', 'email', 'name', 'language', 'page']);
      // One row per email.
      const last = sh.getLastRow();
      if (last > 1 && sh.getRange(2, 2, last - 1, 1).createTextFinder(email).matchEntireCell(true).findNext()) return ok();
      sh.appendRow([new Date(), email, clean(d.name, 40), clean(d.lang, 20), clean(d.page, 200)]);
    } else if (d.type === 'feedback') {
      const rating = ['good', 'okay', 'bad'].indexOf(d.rating) >= 0 ? d.rating : '';
      const kind = d.kind === 'pick' ? 'pick' : 'session';
      const comment = clean(d.comment, MAX);
      if (!rating && !comment) return ok();
      tab('feedback', ['time', 'email', 'kind', 'rating', 'comment', 'pick', 'page'])
        .appendRow([new Date(), email, kind, rating, comment, clean(d.pick, 200), clean(d.page, 200)]);
    }
  } finally { lock.releaseLock(); }
  return ok();
}

function doGet() { return ok(); }

function tab(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); }
  return sh;
}

// Plain text only; a leading = + - @ would make Sheets run it as a formula.
function clean(s, n) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function ok() { return ContentService.createTextOutput('ok'); }
