// Turns a manager's WhatsApp message into { task, deadline }.
// Example: "@8801712345678 design the Puja banner by 30 Oct"  →
//          { task: "Design the Puja banner", deadline: "2026-10-30" }
import * as chrono from 'chrono-node';

const DATE_WORDS = /\b(by|deadline|due|within|before|until|till|on|eod|eow|today|tonight|tomorrow|tmrw|tmr|next|in \d+ (day|days|week|weeks))\b/i;

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function normalise(text) {
  return text
    .replace(/\bwithin\b/gi, 'in')
    .replace(/\btmrw?\b/gi, 'tomorrow')
    .replace(/\beod\b/gi, 'today')
    .replace(/\beow\b/gi, 'thursday') // Bangladesh work-week ends Thursday
    .replace(/\btill\b/gi, 'until');
}

/** Find the deadline date in free text. Returns { date: 'YYYY-MM-DD', text } or null. */
function findDate(text, ref = new Date()) {
  const t = normalise(text);
  const results = chrono.en.GB.parse(t, ref, { forwardDate: true }); // GB = day/month order (30/10)
  if (!results.length) return null;
  const r = results[results.length - 1]; // the deadline is usually stated last
  return { date: ymd(r.start.date()), text: r.text, index: r.index, normalised: t };
}

/**
 * @param {string} body    raw message text
 * @param {number} mentionCount  how many people were @tagged
 * @returns {null | {task, deadline, needsDeadline?}}
 */
function parseTask(body, mentionCount, ref = new Date()) {
  const raw = String(body || '').trim();
  const explicit = /^#task\b/i.test(raw);
  if (!mentionCount) return null;
  if (!explicit && !DATE_WORDS.test(raw)) return null;
  if (!explicit && /\?\s*$/.test(raw)) return null; // questions aren't assignments

  const found = findDate(raw, ref);
  if (!found) return explicit ? { task: cleanTask(raw), deadline: '', needsDeadline: true } : null;

  // Remove the date phrase and the word that introduced it ("by", "deadline:", "due")
  let t = found.normalised;
  const before = t.slice(0, found.index).replace(/\b(by|deadline|due|before|until|on|in)\s*[:\-–]?\s*$/i, '');
  t = before + ' ' + t.slice(found.index + found.text.length);
  return { task: cleanTask(t), deadline: found.date };
}

function cleanTask(t) {
  let s = String(t)
    .replace(/^#task\b/i, '')
    .replace(/@\d{6,}/g, '')           // mention tokens
    .replace(/\b(deadline|due)\s*[:\-–]?\s*$/i, '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,:;\-–&]+|[\s,:;\-–&]+$/g, '')
    .replace(/^(please|pls|plz)\s+/i, '')
    .replace(/[.,]+$/, '')
    .trim();
  if (!s) s = '(no description)';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export { parseTask, findDate, ymd };
