'use strict';
// Exports : CSV (Excel), Word (.docx) et page imprimable (pour « Enregistrer en PDF »). Aucune dépendance.
const zlib = require('node:zlib');

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const decode = t => String(t).replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, m => ENT[m]);
const escH = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const escX = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

// ---------- HTML riche (éditeur) -> paragraphes sûrs : { type: 'h'|'p'|'li', ordre, runs: [{t,b,i,u,c}] } (c = couleur #RRGGBB) ----------
const couleurSure = v => { const m = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(String(v || '')); if (m) return '#' + (m[1].length === 3 ? m[1].replace(/./g, x => x + x) : m[1]).toLowerCase(); const r = /rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(String(v || '')); return r ? '#' + [r[1], r[2], r[3]].map(x => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('') : null; };
function paragraphes(html) {
  const out = []; let cur = null, b = 0, i = 0, u = 0, listes = [], couleurs = [];
  const ouvrir = (type, ordre) => { fermer(); cur = { type, ordre, runs: [] }; };
  const fermer = () => { if (cur && cur.runs.some(r => r.t.trim() || r.br)) out.push(cur); cur = null; };
  for (const tok of String(html || '').split(/(<[^>]*>)/)) {
    if (!tok) continue;
    if (tok[0] !== '<') { const t = decode(tok).replace(/\s+/g, ' '); if (!t.trim() && !cur) continue; if (!cur) ouvrir('p'); cur.runs.push({ t, b: !!b, i: !!i, u: !!u, c: couleurs.length ? couleurs[couleurs.length - 1] : null }); continue; }
    const m = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(tok); if (!m) continue;
    const fin = !!m[1], tag = m[2].toLowerCase();
    if (/^h[1-6]$/.test(tag)) { fin ? fermer() : ouvrir('h'); }
    else if (tag === 'p' || tag === 'div') { fin ? fermer() : ouvrir('p'); }
    else if (tag === 'ul' || tag === 'ol') { fin ? (listes.pop(), fermer()) : (fermer(), listes.push({ ordre: tag === 'ol', n: 0 })); }
    else if (tag === 'li') { if (fin) fermer(); else { const L = listes[listes.length - 1] || { ordre: false, n: 0 }; L.n++; ouvrir('li', L.ordre ? L.n : 0); } }
    else if (tag === 'br') { if (!cur) ouvrir('p'); cur.runs.push({ t: '', br: true }); }
    else if (tag === 'b' || tag === 'strong') b += fin ? -1 : 1;
    else if (tag === 'i' || tag === 'em') i += fin ? -1 : 1;
    else if (tag === 'u') u += fin ? -1 : 1;
    else if (tag === 'font' || tag === 'span') {
      if (fin) couleurs.pop();
      else { const att = /(?:^|\s)color\s*=\s*["']?([^"'\s>]+)/i.exec(tok), sty = /style\s*=\s*"(?:[^"]*?[;\s])?color\s*:\s*([^;"]+)/i.exec(tok);
             couleurs.push(couleurSure(att ? att[1] : sty ? sty[1] : '') || (couleurs.length ? couleurs[couleurs.length - 1] : null)); }
    }
  }
  fermer();
  return out;
}
const runsHtml = runs => runs.map(r => r.br ? '<br>' : (r.c ? `<span style="color:${r.c}">` : '') + (r.b ? '<b>' : '') + (r.i ? '<i>' : '') + (r.u ? '<u>' : '') + escH(r.t) + (r.u ? '</u>' : '') + (r.i ? '</i>' : '') + (r.b ? '</b>' : '') + (r.c ? '</span>' : '')).join('').trim();
function richHtml(html) {
  let o = '', liste = null;
  for (const p of paragraphes(html)) {
    const tag = p.type === 'li' ? (p.ordre ? 'ol' : 'ul') : null;
    if (liste && liste !== tag) { o += `</${liste}>`; liste = null; }
    if (tag && !liste) { o += `<${tag}>`; liste = tag; }
    o += p.type === 'h' ? `<h4>${runsHtml(p.runs)}</h4>` : p.type === 'li' ? `<li>${runsHtml(p.runs)}</li>` : `<p>${runsHtml(p.runs)}</p>`;
  }
  return o + (liste ? `</${liste}>` : '');
}
const texteBrut = html => paragraphes(html).map(p => (p.type === 'li' ? (p.ordre ? p.ordre + '. ' : '• ') : '') + p.runs.map(r => r.br ? '\n' : r.t).join('').trim()).join('\n');

// ---------- CSV (séparateur « ; », UTF-8 avec BOM : s'ouvre directement dans Excel en français) ----------
function cellule(v) {
  let s = v === null || v === undefined ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  if (/^[=@]/.test(s) || /^[+\-]\s*[^\d\s.()+\-]/.test(s)) s = "'" + s;      // neutralise les formules dans un tableur
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csv = (entetes, lignes) => Buffer.from('﻿' + [entetes, ...lignes].map(l => l.map(cellule).join(';')).join('\r\n') + '\r\n', 'utf8');

// ---------- Page imprimable (PDF via « Imprimer » du navigateur) ----------
function pageHtml(titre, blocs) {
  const corps = blocs.map(b => {
    switch (b.k) {
      case 'h1': return `<h1>${escH(b.t)}</h1>`;
      case 'meta': return `<p class="meta">${escH(b.t)}</p>`;
      case 'h2': return `<h2>${escH(b.t)}</h2>`;
      case 'h3': return `<h3>${escH(b.t)}</h3>`;
      case 'kv': return `<table>${b.rows.map(([k, v]) => `<tr><th>${escH(k)}</th><td>${escH(v)}</td></tr>`).join('')}</table>`;
      case 'list': return `<ul>${b.items.map(x => `<li>${escH(x)}</li>`).join('')}</ul>`;
      case 'rich': return `<div class="rich">${richHtml(b.html)}</div>`;
      default: return `<p>${escH(b.t)}</p>`;
    }
  }).join('\n');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escH(titre)}</title><style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font: 11pt/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #222; max-width: 760px; margin: 0 auto; padding: 24px; }
  .bar { position: sticky; top: 0; background: #f1e7e7; border: 1px solid #e4d2d2; border-radius: 10px; padding: 10px 14px; margin-bottom: 18px; display: flex; gap: 12px; align-items: center; justify-content: space-between; }
  .bar button { font: inherit; padding: 7px 14px; border-radius: 8px; border: 0; background: #8650a8; color: #fff; cursor: pointer; }
  h1 { font-size: 22pt; margin: 0 0 2px; } .logo { float: right; width: 44px; height: 44px; } h2 { font-size: 14pt; margin: 22px 0 6px; padding-bottom: 3px; border-bottom: 2px solid #e4d2d2; color: #5e3480; }
  h3 { font-size: 12pt; margin: 18px 0 4px; } h4 { font-size: 11pt; margin: 10px 0 2px; }
  .meta { color: #777; margin: 0 0 8px; font-size: 10pt; } p { margin: 4px 0; }
  table { border-collapse: collapse; margin: 4px 0 8px; } th { text-align: left; font-weight: 600; color: #555; padding: 2px 16px 2px 0; vertical-align: top; white-space: nowrap; } td { padding: 2px 0; }
  .rich { border-left: 3px solid #9e6bc0; padding-left: 12px; margin: 6px 0 10px; } h3, h2, h4 { break-after: avoid; } .rich, table { break-inside: auto; }
  @media print { .bar { display: none; } body { padding: 0; max-width: none; } }
  </style></head><body>
  <div class="bar"><span>Pour obtenir un PDF : choisissez <b>« Enregistrer au format PDF »</b> comme imprimante.</span><button onclick="print()">Imprimer / PDF</button></div>
  <img class="logo" src="/logo-256.png" alt="">
  ${corps}
  <script>addEventListener('load', () => setTimeout(() => print(), 300));</script></body></html>`;
}

// ---------- Word (.docx) : archive ZIP écrite à la main, sans compression ----------
function zip(fichiers) {
  const loc = [], cen = []; let off = 0;
  for (const [nom, data] of fichiers) {
    const n = Buffer.from(nom), c = zlib.crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt32LE(c, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const e = Buffer.alloc(46); e.writeUInt32LE(0x02014b50, 0); e.writeUInt16LE(20, 4); e.writeUInt16LE(20, 6); e.writeUInt16LE(0x0800, 8); e.writeUInt32LE(c, 16); e.writeUInt32LE(data.length, 20); e.writeUInt32LE(data.length, 24); e.writeUInt16LE(n.length, 28); e.writeUInt32LE(off, 42);
    loc.push(h, n, data); cen.push(e, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(cen), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(fichiers.length, 8); end.writeUInt16LE(fichiers.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...loc, cd, end]);
}
const run = (t, { b, i, u, sz, color } = {}) => `<w:r><w:rPr>${b ? '<w:b/>' : ''}${i ? '<w:i/>' : ''}${u ? '<w:u w:val="single"/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}${sz ? `<w:sz w:val="${sz}"/>` : ''}</w:rPr><w:t xml:space="preserve">${escX(t)}</w:t></w:r>`;
const para = (runs, { avant = 0, apres = 80, gauche = 0, suspendu = 0, bordure } = {}) =>
  `<w:p><w:pPr><w:keepLines/>${bordure ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="BBBBBB"/></w:pBdr>' : ''}<w:spacing w:before="${avant}" w:after="${apres}"/><w:ind w:left="${gauche}" w:hanging="${suspendu}"/></w:pPr>${runs}</w:p>`;
function docx(titre, blocs) {
  const corps = [];
  for (const b of blocs) {
    if (b.k === 'h1') corps.push(para(run(b.t, { b: 1, sz: 40 }), { apres: 40 }));
    else if (b.k === 'meta') corps.push(para(run(b.t, { sz: 18, color: '777777' }), { apres: 160 }));
    else if (b.k === 'h2') corps.push(para(run(b.t, { b: 1, sz: 28 }), { avant: 320, apres: 100, bordure: 1 }));
    else if (b.k === 'h3') corps.push(para(run(b.t, { b: 1, sz: 24 }), { avant: 260, apres: 60 }));
    else if (b.k === 'kv') b.rows.forEach(([k, v]) => corps.push(para(run(k + ' : ', { b: 1, color: '555555' }) + run(v), { apres: 30 })));
    else if (b.k === 'list') b.items.forEach(x => corps.push(para(run('• ' + x), { gauche: 360, suspendu: 240, apres: 30 })));
    else if (b.k === 'rich') for (const p of paragraphes(b.html)) {
      const r = p.runs.map(x => x.br ? '<w:r><w:br/></w:r>' : run(x.t, { b: x.b || p.type === 'h', i: x.i, u: x.u, color: x.c ? x.c.slice(1).toUpperCase() : undefined })).join('');
      if (p.type === 'li') corps.push(para(run(p.ordre ? p.ordre + '. ' : '• ') + r, { gauche: 540, suspendu: 260, apres: 30 }));
      else corps.push(para(r, { avant: p.type === 'h' ? 120 : 0, apres: 60, gauche: 0 }));
    } else corps.push(para(run(b.t)));
  }
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${corps.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="fr-FR"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`;
  return zip([
    ['[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`)],
    ['_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)],
    ['word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)],
    ['word/styles.xml', Buffer.from(styles)],
    ['word/document.xml', Buffer.from(doc)],
  ]);
}

// ---------- Markdown (.md) : lisible partout, sans logiciel particulier ----------
const mdT = t => String(t ?? '').replace(/([\\`*_])/g, '\\$1').replace(/^(\s*)([#>+-])/gm, '$1\\$2');
const mdRuns = runs => runs.map(r => {
  if (r.br) return '  \n';
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.t); let s = mdT(m[2]); if (!s) return r.t;
  if (r.i) s = '*' + s + '*'; if (r.b) s = '**' + s + '**'; if (r.u) s = '<u>' + s + '</u>';
  return m[1] + s + m[3];
}).join('').replace(/\s+$/, '');
function markdown(titre, blocs) {
  const o = [];
  for (const b of blocs) {
    if (o.length && o[o.length - 1] === null) o.pop();
    if (b.k === 'h1') o.push('# ' + mdT(b.t), '');
    else if (b.k === 'meta') o.push('*' + mdT(b.t) + '*', '');
    else if (b.k === 'h2') o.push('', '## ' + mdT(b.t), '');
    else if (b.k === 'h3') o.push('', '### ' + mdT(b.t), '');
    else if (b.k === 'kv') { b.rows.filter(([, v]) => String(v ?? '').trim()).forEach(([k, v]) => o.push(`- **${mdT(k)}** : ${mdT(v)}`)); o.push(''); }
    else if (b.k === 'list') { b.items.forEach(x => o.push('- ' + mdT(x))); o.push(''); }
    else if (b.k === 'rich') {
      let precedent = null;
      for (const p of paragraphes(b.html)) {
        const t = mdRuns(p.runs);
        if (precedent === 'li' && p.type !== 'li') o.push('');
        precedent = p.type;
        o.push(p.type === 'h' ? '#### ' + t : p.type === 'li' ? (p.ordre ? p.ordre + '. ' : '- ') + t : t, p.type === 'li' ? null : '');
      }
      o.push('');
    } else o.push(mdT(b.t), '');
  }
  return Buffer.from(o.filter(x => x !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', 'utf8');
}

module.exports = { csv, docx, pageHtml, texteBrut, paragraphes, markdown, zip };
