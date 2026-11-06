// Prints recent feedback.  docker exec <app container> node dist/feedback-report.js [days]
import { openDb } from './db.js';

const days = Number(process.argv[2] ?? 30);
const db = openDb();
const since = Date.now() - days * 86_400_000;
const summary = db
  .prepare(`SELECT kind, rating, COUNT(*) AS n FROM feedback WHERE created_at > ? GROUP BY kind, rating ORDER BY kind, rating`)
  .all(since);
const rows = db
  .prepare(
    `SELECT f.created_at, f.kind, f.rating, f.comment, u.email, i.title, e.category
     FROM feedback f JOIN users u ON u.id = f.user_id
     LEFT JOIN events e ON e.id = f.event_id LEFT JOIN items i ON i.id = e.item_id
     WHERE f.created_at > ? ORDER BY f.id DESC LIMIT 200`,
  )
  .all(since) as Array<Record<string, unknown>>;
console.log(`feedback, last ${days} days`);
console.table(summary);
for (const r of rows) {
  const when = new Date(r.created_at as number).toISOString().slice(0, 16).replace('T', ' ');
  const what = r.title ? ` on "${r.title}" (${r.category})` : '';
  console.log(`${when}  ${r.kind}  ${r.rating ?? '-'}${what}  ${r.email}${r.comment ? `\n    “${r.comment}”` : ''}`);
}
db.close();
