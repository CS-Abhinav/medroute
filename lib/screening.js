/*
 * Prescription primary screening.
 * The browser extracts text (Tesseract.js OCR for images, pdf.js for PDFs) and
 * measures image sharpness; the server scores the result with weighted rule checks.
 *
 * score >= 80, all Rx medicines found and date valid -> auto-approved
 * score >= 45                                         -> pharmacist manual review
 * otherwise                                           -> rejected (customer can re-upload)
 *
 * This is screening, not legal verification: a registered pharmacist remains
 * responsible for dispensing Schedule H / H1 drugs.
 */

const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];
const MAX_BYTES = 5 * 1024 * 1024;
const VALIDITY_DAYS = 180;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
const similarity = (a, b) => 1 - levenshtein(a, b) / Math.max(a.length, b.length);

// Best fuzzy match of a word against OCR words (handles OCR errors like "Amoxici11in")
function bestMatch(word, ocrWords) {
  let best = { score: 0, found: null };
  for (const w of ocrWords) {
    if (Math.abs(w.length - word.length) > 3) continue;
    const s = similarity(word, w);
    if (s > best.score) best = { score: s, found: w };
  }
  return best;
}

function findDates(text) {
  const dates = [];
  const numeric = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g;
  let m;
  while ((m = numeric.exec(text))) {
    let y = +m[3]; if (y < 100) y += 2000;
    const d = new Date(y, +m[2] - 1, +m[1]);
    if (!isNaN(d) && d.getMonth() === +m[2] - 1) dates.push(d);
  }
  const named = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})\b/gi;
  while ((m = named.exec(text))) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon !== undefined) dates.push(new Date(+m[3], mon, +m[1]));
  }
  return dates;
}

function screen({ text = '', file, blurScore, user, rxItems, duplicateOf }) {
  const checks = [];
  const add = (name, weight, pass, detail) => checks.push({ name, weight, pass: Math.max(0, Math.min(1, pass)), detail });
  const lower = text.toLowerCase();
  const words = lower.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length >= 3);

  // 1. File type and size
  const fileOk = file && ALLOWED_MIME.includes(file.mimetype) && file.size <= MAX_BYTES;
  add('File format & size', 10, fileOk ? 1 : 0,
    fileOk ? `${file.mimetype}, ${(file.size / 1024).toFixed(0)} KB` : 'Only PDF/JPG/PNG up to 5 MB are accepted');

  // 2. Duplicate detection (SHA-256 of the file)
  add('Not a reused prescription', 10, duplicateOf ? 0 : 1,
    duplicateOf ? `Same file already used by another account (order ${duplicateOf})` : 'File hash is unique');

  // 3. Legibility: sharpness + amount of readable text
  const sharp = blurScore == null ? 1 : blurScore >= 60 ? 1 : blurScore >= 25 ? 0.5 : 0;
  const enoughText = words.length >= 12 ? 1 : words.length >= 5 ? 0.5 : 0;
  add('Image quality / legibility', 15, (sharp + enoughText) / 2,
    `Sharpness ${blurScore == null ? 'n/a (PDF text)' : blurScore.toFixed(0)}; ${words.length} readable words`);

  // 4. Doctor / clinic markers
  const docMarkers = [/\bdr\.?\s/, /\bdoctor\b/, /m\.?\s?b\.?\s?b\.?\s?s/, /\bm\.?d\b/, /\bclinic\b/, /\bhospital\b/, /\brx\b/, /℞/, /\bphysician\b/]
    .filter(r => r.test(lower)).length;
  add("Doctor / clinic details", 15, docMarkers >= 2 ? 1 : docMarkers === 1 ? 0.5 : 0,
    docMarkers ? `${docMarkers} prescriber markers found (Dr., MBBS, clinic, Rx...)` : 'No prescriber details found');

  // 5. Registration number of the doctor
  const reg = /(reg(istration)?\.?\s*(no|number)?\.?\s*[:#\-]?\s*[a-z]{0,6}[\/\-]?\s*\d{3,})|\b(tnmc|mci|nmc)\b\s*[:#\-]?\s*\d*/i.exec(text);
  add('Medical registration number', 10, reg ? 1 : 0, reg ? `Found "${reg[0].trim()}"` : 'Registration number not detected');

  // 6. Date validity
  const now = new Date();
  const dates = findDates(text).filter(d => d <= new Date(now.getTime() + 86400000));
  const latest = dates.sort((a, b) => b - a)[0];
  const ageDays = latest ? Math.floor((now - latest) / 86400000) : null;
  const dateValid = latest && ageDays <= VALIDITY_DAYS;
  add('Prescription date valid', 15, dateValid ? 1 : 0,
    latest ? `Dated ${latest.toDateString()} (${ageDays} days old, limit ${VALIDITY_DAYS})` : 'No valid date found');

  // 7. Patient name
  const nameParts = (user.name || '').toLowerCase().split(/\s+/).filter(p => p.length >= 3);
  const nameHits = nameParts.filter(p => bestMatch(p, words).score >= 0.8).length;
  add('Patient name matches account', 10, nameParts.length ? nameHits / nameParts.length : 0,
    nameHits ? `${nameHits}/${nameParts.length} name parts found` : `"${user.name}" not found on prescription`);

  // 8. Ordered Rx medicines are on the prescription
  const medResults = rxItems.map(item => {
    const brand = item.name.toLowerCase().split(/\s+/)[0];
    const generic = item.generic.toLowerCase().split(/\s+/)[0];
    const a = bestMatch(brand, words), b = bestMatch(generic, words);
    const m = a.score >= b.score ? a : b;
    return { medicine: item.name, matched: m.score >= 0.8, similarity: +m.score.toFixed(2), foundAs: m.found };
  });
  const matched = medResults.filter(r => r.matched).length;
  add('Ordered medicines on prescription', 15, rxItems.length ? matched / rxItems.length : 1,
    medResults.map(r => `${r.medicine}: ${r.matched ? `found ("${r.foundAs}", ${Math.round(r.similarity * 100)}%)` : 'NOT found'}`).join('; '));

  const totalW = checks.reduce((s, c) => s + c.weight, 0);
  const score = Math.round((checks.reduce((s, c) => s + c.weight * c.pass, 0) / totalW) * 100);
  const allMeds = matched === rxItems.length;

  let decision, summary;
  if (!fileOk || duplicateOf) {
    decision = 'rejected';
    summary = !fileOk ? 'Unsupported or oversized file.' : 'This prescription has already been used by another account.';
  } else if (score >= 80 && allMeds && dateValid) {
    decision = 'approved';
    summary = 'All key checks passed. Auto-approved by screening (logged for pharmacist audit).';
  } else if (score >= 45) {
    decision = 'pending_review';
    summary = 'Some checks were inconclusive. Sent to a pharmacist for manual review.';
  } else {
    decision = 'rejected';
    summary = 'The prescription could not be read or is missing key details. Please upload a clearer, valid prescription.';
  }
  return { score, decision, summary, checks, medicines: medResults, screenedAt: Date.now() };
}

module.exports = { screen, ALLOWED_MIME, MAX_BYTES };
