// parse.js — a dependency-free Markdown renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (GFM on, breaks off, pedantic off, async off).
// Written from scratch from the CommonMark 0.31.2 and GFM 0.29 specifications:
// a block parser builds the document tree, then an inline parser renders
// paragraphs, headings and table cells with a delimiter stack.

const RE_UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const RE_UNICODE_SPACE = /^\s$/;

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || (ch !== '' && RE_UNICODE_SPACE.test(ch));
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

function isPunct(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunct(ch);
  return RE_UNICODE_PUNCT.test(ch);
}

function isLetter(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
  return /\p{L}/u.test(ch);
}

// Escape text content: & < > " '
function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > start) out += s.slice(start, i);
      out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// Escape attribute values: & < > " '
function escAttr(s) {
  return escText(s);
}

// Is the text at s[i] === '&' the start of an entity-like reference
// (&name; / &#123; / &#x1f; with alphanumeric content)? Used to leave
// such references alone when escaping URLs and titles, which are not
// entity-decoded.
function entityLikeAt(s, i) {
  const len = s.length;
  let j = i + 1;
  if (j < len && s[j] === '#') {
    j++;
    if (j < len && (s[j] === 'x' || s[j] === 'X')) j++;
    const start = j;
    while (j < len && ((s[j] >= '0' && s[j] <= '9') || (s[j] >= 'a' && s[j] <= 'f') || (s[j] >= 'A' && s[j] <= 'F'))) j++;
    return j > start && j < len && s[j] === ';';
  }
  const start = j;
  while (j < len && ((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z') || (s[j] >= '0' && s[j] <= '9'))) j++;
  return j > start && j < len && s[j] === ';';
}

// Escape a URL for an href: percent-encode (encodeURI), then escape ' and
// & (leaving entity-like references alone). < > " are already percent-encoded.
// A '%' that starts a valid %XX sequence is left alone (encodeURI would
// double-encode it to %25).
function escHref(s) {
  // '%' is never percent-encoded (a bare '%' stays literal, and a
  // valid %XX sequence is left alone as-is), so encode each '%'-free
  // segment in one encodeURI call instead of per character.
  let u;
  if (s.indexOf('%') < 0) {
    try { u = encodeURI(s); } catch (e) { u = s; }
  } else {
    const parts = s.split('%');
    for (let k = 0; k < parts.length; k++) {
      try { parts[k] = encodeURI(parts[k]); } catch (e) { /* keep as-is */ }
    }
    u = parts.join('%');
  }
  let out = '';
  let start = 0;
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    if (c === 39) {
      if (i > start) out += u.slice(start, i);
      out += '&#39;';
      start = i + 1;
    } else if (c === 38) {
      if (entityLikeAt(u, i)) continue;
      if (i > start) out += u.slice(start, i);
      out += '&amp;';
      start = i + 1;
    }
  }
  if (start === 0) return u;
  if (start < u.length) out += u.slice(start);
  return out;
}

// Escape a link title: " ' < > and & (leaving entity-like references alone).
function escTitle(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > start) out += s.slice(start, i);
      out += c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    } else if (c === 38) {
      if (entityLikeAt(s, i)) continue;
      if (i > start) out += s.slice(start, i);
      out += '&amp;';
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// ---------------------------------------------------------------------------
// HTML5 named character references (the set used by CommonMark documents,
// plus the wider common set). The legacy names are also valid without a
// trailing semicolon; every other name needs the semicolon.
// ---------------------------------------------------------------------------

const ENTITIES = {
  quot: '"', amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', apos: "'",
  iexcl: '\u00a1', cent: '\u00a2', pound: '\u00a3', curren: '\u00a4', yen: '\u00a5',
  brvbar: '\u00a6', sect: '\u00a7', uml: '\u00a8', copy: '\u00a9', ordf: '\u00aa',
  laquo: '\u00ab', not: '\u00ac', shy: '\u00ad', reg: '\u00ae', macr: '\u00af',
  deg: '\u00b0', plusmn: '\u00b1', sup2: '\u00b2', sup3: '\u00b3', acute: '\u00b4',
  micro: '\u00b5', para: '\u00b6', middot: '\u00b7', cedil: '\u00b8', sup1: '\u00b9',
  ordm: '\u00ba', raquo: '\u00bb', frac14: '\u00bc', frac12: '\u00bd', frac34: '\u00be',
  iquest: '\u00bf', Agrave: '\u00c0', Aacute: '\u00c1', Acirc: '\u00c2', Atilde: '\u00c3',
  Auml: '\u00c4', Aring: '\u00c5', AElig: '\u00c6', Ccedil: '\u00c7', Egrave: '\u00c8',
  Eacute: '\u00c9', Ecirc: '\u00ca', Euml: '\u00cb', Igrave: '\u00cc', Iacute: '\u00cd',
  Icirc: '\u00ce', Iuml: '\u00cf', ETH: '\u00d0', Ntilde: '\u00d1', Ograve: '\u00d2',
  Oacute: '\u00d3', Ocirc: '\u00d4', Otilde: '\u00d5', Ouml: '\u00d6', times: '\u00d7',
  Oslash: '\u00d8', Ugrave: '\u00d9', Uacute: '\u00da', Ucirc: '\u00db', Uuml: '\u00dc',
  Yacute: '\u00dd', THORN: '\u00de', szlig: '\u00df', agrave: '\u00e0', aacute: '\u00e1',
  acirc: '\u00e2', atilde: '\u00e3', auml: '\u00e4', aring: '\u00e5', aelig: '\u00e6',
  ccedil: '\u00e7', egrave: '\u00e8', eacute: '\u00e9', ecirc: '\u00ea', euml: '\u00eb',
  igrave: '\u00ec', iacute: '\u00ed', icirc: '\u00ee', iuml: '\u00ef', eth: '\u00f0',
  ntilde: '\u00f1', ograve: '\u00f2', oacute: '\u00f3', ocirc: '\u00f4', otilde: '\u00f5',
  ouml: '\u00f6', divide: '\u00f7', oslash: '\u00f8', ugrave: '\u00f9', uacute: '\u00fa',
  ucirc: '\u00fb', uuml: '\u00fc', yacute: '\u00fd', thorn: '\u00fe', yuml: '\u00ff',
  OElig: '\u0152', oelig: '\u0153', Scaron: '\u0160', scaron: '\u0161', Yuml: '\u0178',
  fnof: '\u0192', circ: '\u02c6', tilde: '\u02dc',
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394', Epsilon: '\u0395',
  Zeta: '\u0396', Eta: '\u0397', Theta: '\u0398', Iota: '\u0399', Kappa: '\u039a',
  Lambda: '\u039b', Mu: '\u039c', Nu: '\u039d', Xi: '\u039e', Omicron: '\u039f',
  Pi: '\u03a0', Rho: '\u03a1', Sigma: '\u03a3', Tau: '\u03a4', Upsilon: '\u03a5',
  Phi: '\u03a6', Chi: '\u03a7', Psi: '\u03a8', Omega: '\u03a9',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4', epsilon: '\u03b5',
  zeta: '\u03b6', eta: '\u03b7', theta: '\u03b8', iota: '\u03b9', kappa: '\u03ba',
  lambda: '\u03bb', mu: '\u03bc', nu: '\u03bd', xi: '\u03be', omicron: '\u03bf',
  pi: '\u03c0', rho: '\u03c1', sigmaf: '\u03c2', sigma: '\u03c3', tau: '\u03c4',
  upsilon: '\u03c5', phi: '\u03c6', chi: '\u03c7', psi: '\u03c8', omega: '\u03c9',
  thetasym: '\u03d1', upsih: '\u03d2', piv: '\u03d6',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
  lrm: '\u200e', rlm: '\u200f', ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018',
  rsquo: '\u2019', sbquo: '\u201a', ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e',
  dagger: '\u2020', Dagger: '\u2021', bull: '\u2022', hellip: '\u2026', permil: '\u2030',
  prime: '\u2032', Prime: '\u2033', lsaquo: '\u2039', rsaquo: '\u203a', oline: '\u203e',
  frasl: '\u2044', euro: '\u20ac', image: '\u2111', weierp: '\u2118', real: '\u211c',
  trade: '\u2122', alefsym: '\u2135', larr: '\u2190', uarr: '\u2191', rarr: '\u2192',
  darr: '\u2193', harr: '\u2194', crarr: '\u21b5', lArr: '\u21d0', uArr: '\u21d1',
  rArr: '\u21d2', dArr: '\u21d3', hArr: '\u21d4', forall: '\u2200', part: '\u2202',
  exist: '\u2203', empty: '\u2205', nabla: '\u2207', isin: '\u2208', notin: '\u2209',
  ni: '\u220b', prod: '\u220f', sum: '\u2211', minus: '\u2212', lowast: '\u2217',
  radic: '\u221a', prop: '\u221d', infin: '\u221e', ang: '\u2220', and: '\u2227',
  or: '\u2228', cap: '\u2229', cup: '\u222a', int: '\u222b', there4: '\u2234',
  sim: '\u223c', cong: '\u2245', asymp: '\u2248', ne: '\u2260', equiv: '\u2261',
  le: '\u2264', ge: '\u2265', sub: '\u2282', sup: '\u2283', nsub: '\u2284',
  sube: '\u2286', supe: '\u2287', oplus: '\u2295', otimes: '\u2297', perp: '\u22a5',
  sdot: '\u22c5', lceil: '\u2308', rceil: '\u2309', lfloor: '\u230a', rfloor: '\u230b',
  lang: '\u27e8', rang: '\u27e9', loz: '\u25ca', spades: '\u2660', clubs: '\u2663',
  hearts: '\u2665', diams: '\u2666',
  Dcaron: '\u010e', dcaron: '\u010f', HilbertSpace: '\u210b', DifferentialD: '\u2146',
  ClockwiseContourIntegral: '\u2232', ngE: '\u2267\u0338', NotEqualTilde: '\u2242\u0338',
  Tab: '\u0009', NewLine: '\n', colon: ':', comma: ',', period: '.', sol: '/',
  bsol: '\\', semi: ';', equals: '=', quest: '?', commat: '@', dollar: '$',
  AMP: '&', COPY: '\u00a9', GT: '>', LT: '<', QUOT: '"', REG: '\u00ae',
  Hat: '^', check: '\u2713', cross: '\u2717', star: '\u2605',
};

function decodeNumericEntity(body) {
  // body is like '#35' or '#x1F600' (without the leading & and trailing ;)
  let code;
  if (body[1] === 'x' || body[1] === 'X') {
    code = parseInt(body.slice(2), 16);
  } else {
    code = parseInt(body.slice(1), 10);
  }
  if (!isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return '\ufffd';
  }
  return String.fromCodePoint(code);
}

// Entity references in text. Named references pass through literally
// (raw); only numeric references decode, and only when the digit count
// fits (decimal 1-7, hex 1-6): 0 and surrogates become U+FFFD, a code
// above 0x10FFFF also becomes U+FFFD. Anything else shaped like an
// entity but invalid is not an entity at all (the '&' is literal).
// Returns [text, nextIndex, isRaw] or null.
function entityAt(s, i) {
  const len = s.length;
  if (i + 1 >= len) return null;
  const c1 = s[i + 1];
  if (c1 === '#') {
    let j = i + 2;
    let hex = false;
    if (j < len && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    while (j < len) {
      const c = s[j];
      if (hex) {
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) break;
      } else if (c < '0' || c > '9') break;
      j++;
    }
    const count = j - start;
    const max = hex ? 6 : 7;
    if (count < 1 || count > max || j >= len || s[j] !== ';') return null;
    const code = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return ['\ufffd', j + 1, false];
    return [String.fromCodePoint(code), j + 1, false];
  }
  if (!((c1 >= 'a' && c1 <= 'z') || (c1 >= 'A' && c1 <= 'Z') || (c1 >= '0' && c1 <= '9'))) return null;
  let j = i + 1;
  while (j < len && ((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z') || (s[j] >= '0' && s[j] <= '9'))) j++;
  if (j < len && s[j] === ';') return [s.slice(i, j + 1), j + 1, true];
  return null;
}

// Decode one entity reference starting at s[i] === '&'.
// Returns [decodedString, nextIndex] or null when there is no entity here.
function tryDecodeEntity(s, i) {
  const len = s.length;
  if (i + 1 >= len) return null;
  const c1 = s[i + 1];
  if (c1 === '#') {
    // numeric reference: &#...;  (semicolon required)
    let j = i + 2;
    if (j < len && (s[j] === 'x' || s[j] === 'X')) j++;
    const start = j;
    while (j < len && ((s[j] >= '0' && s[j] <= '9') || (s[j] >= 'a' && s[j] <= 'f') || (s[j] >= 'A' && s[j] <= 'F'))) j++;
    if (j === start || j >= len || s[j] !== ';') return null;
    return [decodeNumericEntity(s.slice(i + 1, j)), j + 1];
  }
  if (!((c1 >= 'a' && c1 <= 'z') || (c1 >= 'A' && c1 <= 'Z'))) return null;
  // named reference: the name must be followed by a semicolon (marked
  // does not decode entities without one)
  let j = i + 1;
  while (j < len && j < i + 33 && ((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z') || (s[j] >= '0' && s[j] <= '9'))) j++;
  if (j < len && s[j] === ';') {
    const name = s.slice(i + 1, j);
    const v = ENTITIES[name];
    if (v !== undefined) return [v, j + 1];
  }
  return null;
}

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let start = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '&') {
      const d = tryDecodeEntity(s, i);
      if (d) {
        if (i > start) out += s.slice(start, i);
        out += d[0];
        i = d[1];
        start = i;
        continue;
      }
    }
    i++;
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// ---------------------------------------------------------------------------
// Lines. A line is {s, pos, col, pend}: s is the line text (no newline),
// pos the current index, col the current column, pend the number of virtual
// spaces left from a partially consumed tab.
// ---------------------------------------------------------------------------

function lch(ln) {
  if (ln.pend > 0) return ' ';
  return ln.pos < ln.s.length ? ln.s[ln.pos] : '';
}

function ladv(ln) {
  if (ln.pend > 0) { ln.pend--; ln.col++; return; }
  const ch = ln.s[ln.pos];
  if (ch === '\t') ln.col += 4 - (ln.col % 4); else ln.col++;
  ln.pos++;
}

function ladvCols(ln, n) {
  while (n > 0) {
    if (ln.pend > 0) {
      const take = n < ln.pend ? n : ln.pend;
      ln.pend -= take; ln.col += take; n -= take;
    } else if (ln.pos < ln.s.length) {
      const ch = ln.s[ln.pos];
      if (ch === '\t') {
        const w = 4 - (ln.col % 4);
        if (w > n) { ln.pend = w - n; ln.col += n; ln.pos++; n = 0; }
        else { ln.col += w; ln.pos++; n -= w; }
      } else if (ch === ' ') { ln.col++; ln.pos++; n--; }
      else break;
    } else break;
  }
}

// Columns of indentation (spaces/tabs) from the current position.
function lindent(ln) {
  let i = ln.pos;
  let col = ln.col + ln.pend;
  let n = ln.pend;
  while (i < ln.s.length) {
    const ch = ln.s[i];
    if (ch === ' ') { n++; col++; i++; }
    else if (ch === '\t') { const w = 4 - (col % 4); n += w; col += w; i++; }
    else break;
  }
  return n;
}

function lblank(ln) {
  for (let i = ln.pos; i < ln.s.length; i++) {
    const ch = ln.s[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

function lrest(ln) {
  if (ln.pend > 0) return ' '.repeat(ln.pend) + ln.s.slice(ln.pos);
  return ln.s.slice(ln.pos);
}

// Expand tabs in the leading whitespace run of a code line to spaces,
// tracking columns from startCol (tabs later in the line stay literal).
function expandLeadingTabs(s, startCol) {
  let col = startCol;
  let i = 0;
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { out += ' '; col++; i++; }
    else if (ch === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  if (i === 0) return s;
  return out + s.slice(i);
}

function saveLine(ln) { return { pos: ln.pos, col: ln.col, pend: ln.pend }; }
function restoreLine(ln, sv) { ln.pos = sv.pos; ln.col = sv.col; ln.pend = sv.pend; }

// ---------------------------------------------------------------------------
// Block tree nodes.
// ---------------------------------------------------------------------------

function mknode(t) {
  return { t, c: [], open: true };
}

function lastChild(b) {
  return b.c.length ? b.c[b.c.length - 1] : null;
}

// Block tag names for HTML block type 6 (CommonMark 0.31.2).
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// ---------------------------------------------------------------------------
// Link labels, destinations and titles (shared by block and inline parsing).
// ---------------------------------------------------------------------------

// Parse a link label starting at s[i] === '['.
// Returns [rawLabel, nextIndex] or null. A label may not contain an
// unescaped '[' (even a balanced one), nor a blank line.
function parseLinkLabel(s, i) {
  const len = s.length;
  let j = i + 1;
  let prevNl = false;
  while (j < len) {
    const ch = s[j];
    if (ch === '\n') {
      if (prevNl) return null; // blank line inside a label
      prevNl = true;
      j++;
      continue;
    }
    prevNl = false;
    if (ch === '\\' && j + 1 < len && isAsciiPunct(s[j + 1])) { j += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') {
      const raw = s.slice(i + 1, j);
      if (raw.length === 0 || raw.length > 999) return null;
      return [raw, j + 1];
    }
    j++;
  }
  return null;
}

// Normalize a link label for matching: collapse whitespace, trim, and
// fold case (Unicode case folding: ß/ẞ fold to "ss", ligatures unfold).
// Backslash escapes are NOT resolved: a label written with "\!" does
// not match one written with "!".
function normalizeLabel(raw) {
  let out = '';
  let start = 0;
  let ws = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (isSpace(ch)) {
      if (!ws) {
        if (i > start) out += raw.slice(start, i);
        out += ' ';
        ws = true;
      }
      start = i + 1;
    } else {
      ws = false;
    }
  }
  if (raw.length > start) out += raw.slice(start);
  let folded = out.trim().toLowerCase();
  // Unicode case folding special cases that toLowerCase misses
  folded = folded.replace(/ß/g, 'ss').replace(/ẞ/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
  return folded;
}

// Parse a link destination starting at s[i] (whitespace before it is skipped).
// Returns [dest, nextIndex] or null. The destination has backslash escapes
// resolved but entities are NOT decoded.
function parseLinkDestination(s, i) {
  const len = s.length;
  let j = i;
  while (j < len && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= len) return null;
  if (s[j] === '<') {
    let k = j + 1;
    let dest = '';
    while (k < len) {
      const ch = s[k];
      if (ch === '\n' || ch === '<') return null;
      if (ch === '>') return [dest, k + 1];
      if (ch === '\\' && k + 1 < len && isAsciiPunct(s[k + 1])) { dest += s[k + 1]; k += 2; continue; }
      dest += ch;
      k++;
    }
    return null;
  }
  let depth = 0;
  let dest = '';
  let k = j;
  while (k < len) {
    const ch = s[k];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 32) break;
    if (ch === '\\' && k + 1 < len && isAsciiPunct(s[k + 1])) { dest += s[k + 1]; k += 2; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
    dest += ch;
    k++;
  }
  if (dest === '' || depth !== 0) return null;
  return [dest, k];
}

// Parse a link title starting at s[i] (whitespace before it is skipped).
// Returns [title, nextIndex] or null. Backslash escapes are resolved;
// entities are NOT decoded.
function parseLinkTitle(s, i) {
  const len = s.length;
  let j = i;
  while (j < len && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= len) return null;
  const q = s[j];
  if (q === '"' || q === "'") {
    let k = j + 1;
    let title = '';
    while (k < len) {
      const ch = s[k];
      if (ch === q) return [title, k + 1];
      if (ch === '\\' && k + 1 < len && isAsciiPunct(s[k + 1])) { title += s[k + 1]; k += 2; continue; }
      title += ch;
      k++;
    }
    return null;
  }
  if (q === '(') {
    let k = j + 1;
    let title = '';
    while (k < len) {
      const ch = s[k];
      if (ch === ')') return [title, k + 1];
      if (ch === '(') return null;
      if (ch === '\\' && k + 1 < len && isAsciiPunct(s[k + 1])) { title += s[k + 1]; k += 2; continue; }
      title += ch;
      k++;
    }
    return null;
  }
  return null;
}

// Parse an HTML tag starting at s[i] === '<'.
// Returns [tagText, nextIndex, kind] or null when no valid tag starts here.
// kind is 'open', 'close', 'comment', 'pi', 'decl' or 'cdata'.
function parseHtmlTag(s, i) {
  const len = s.length;
  if (s[i] !== '<' || i + 1 >= len) return null;
  const c1 = s[i + 1];
  // comment: <!-- ... -->
  if (c1 === '!' && s[i + 2] === '-' && s[i + 3] === '-') {
    // abrupt closing: <!--> and <!---> are complete comments
    if (s[i + 4] === '>') return [s.slice(i, i + 5), i + 5, 'comment'];
    if (s[i + 4] === '-' && s[i + 5] === '>') return [s.slice(i, i + 6), i + 6, 'comment'];
    const end = s.indexOf('-->', i + 4);
    if (end < 0) return null;
    return [s.slice(i, end + 3), end + 3, 'comment'];
  }
  // CDATA: <![CDATA[ ... ]]>
  if (c1 === '!' && s.slice(i + 2, i + 9) === '[CDATA[') {
    const end = s.indexOf(']]>', i + 9);
    if (end < 0) return null;
    return [s.slice(i, end + 3), end + 3, 'cdata'];
  }
  // processing instruction: <? ... ?>
  if (c1 === '?') {
    const end = s.indexOf('?>', i + 2);
    if (end < 0) return null;
    return [s.slice(i, end + 2), end + 2, 'pi'];
  }
  // declaration: <!A ... > (letter right after <!)
  if (c1 === '!' && i + 2 < len && isLetter(s[i + 2])) {
    const end = s.indexOf('>', i + 2);
    if (end < 0) return null;
    return [s.slice(i, end + 1), end + 1, 'decl'];
  }
  // closing tag: </name ws* >
  if (c1 === '/') {
    let j = i + 2;
    if (j >= len || !isLetter(s[j])) return null;
    while (j < len && (isLetter(s[j]) || isDigit(s[j]) || s[j] === '-')) j++;
    while (j < len && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j >= len || s[j] !== '>') return null;
    return [s.slice(i, j + 1), j + 1, 'close'];
  }
  // open tag: <name (ws+ attr)* ws* /? >
  if (!isLetter(c1)) return null;
  let j = i + 1;
  while (j < len && (isLetter(s[j]) || isDigit(s[j]) || s[j] === '-')) j++;
  while (true) {
    // skip whitespace before an attribute, '/' or '>'
    let k = j;
    while (k < len && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (k >= len) return null;
    if (s[k] === '>') return [s.slice(i, k + 1), k + 1, 'open'];
    if (s[k] === '/') {
      if (k + 1 < len && s[k + 1] === '>') return [s.slice(i, k + 2), k + 2, 'open'];
      return null;
    }
    if (k === j) return null; // attribute must be preceded by whitespace
    j = k;
    // attribute name
    if (!(isLetter(s[j]) || s[j] === '_' || s[j] === ':')) return null;
    j++;
    while (j < len && (isLetter(s[j]) || isDigit(s[j]) || s[j] === '_' || s[j] === ':' || s[j] === '.' || s[j] === '-')) j++;
    // optional = value
    let m = j;
    while (m < len && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
    if (m < len && s[m] === '=') {
      m++;
      while (m < len && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
      if (m >= len) return null;
      const q = s[m];
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, m + 1);
        if (end < 0) return null;
        j = end + 1;
      } else {
        let n = m;
        while (n < len) {
          const c = s[n];
          if (c === ' ' || c === '\t' || c === '\n' || c === '"' || c === "'" || c === '=' || c === '<' || c === '>' || c === '`') break;
          n++;
        }
        if (n === m) return null;
        j = n;
      }
    }
    // (no '=': the attribute has no value; j stays right after the
    // attribute name so the loop can skip the separating whitespace)
  }
}

// ---------------------------------------------------------------------------
// Block parsing.
// ---------------------------------------------------------------------------

function addChild(P, parent, child) {
  const last = lastChild(parent);
  if (last && last.t === 'paragraph' && last.open) finalizeBlock(P, last);
  if (parent.t === 'item' && parent.c.length > 0 && P.lastLineBlank) {
    if (parent.p) parent.p.tight = false;
  }
  if (child.t === 'item' && parent.t === 'list' && parent.c.length > 0 && P.lastLineBlank) {
    parent.tight = false;
  }
  child.p = parent;
  parent.c.push(child);
  P.tip = child;
}

function closeBelow(P, container) {
  let b = P.tip;
  while (b !== container) {
    finalizeBlock(P, b);
    b = b.p;
  }
  P.tip = container;
}

// Finalize a block: close it and, for paragraphs, parse link reference
// definitions and possibly turn it into a table.
function finalizeBlock(P, block) {
  if (!block.open) return;
  block.open = false;
  if (block.t === 'paragraph') {
    finalizeParagraph(P, block);
  } else if (block.t === 'code') {
    if (block.fenced) {
      // Fenced: a trailing blank line (the last line before the
      // closing fence) is dropped, but earlier blank lines are kept;
      // a literal of only blank lines keeps all but one newline.
      if (block.lit.replace(/\n+$/, '') === '') {
        block.lit = block.lit.length > 0 ? block.lit.slice(0, -1) : '';
      } else if (block.lit.endsWith('\n\n')) {
        block.lit = block.lit.slice(0, -1);
      }
    } else {
      // Indented: strip all trailing blank lines, keep one '\n'
      block.lit = block.lit.replace(/\n+$/, '');
      if (block.lit !== '') block.lit += '\n';
    }
  } else if (block.t === 'html') {
    // An HTML block loses its trailing newline unless it ended at its
    // end marker (types 1-5) and the line that closes it is not truly
    // empty, or it ends at the end of the document with a trailing
    // newline in the source. If the source does not end with a newline,
    // the last line's newline is spurious and is dropped.
    let strip;
    if (P.atEof) strip = !P.endsWithNl;
    else strip = !block.endReached || P.curEmpty;
    if (strip && block.lit.endsWith('\n')) {
      block.lit = block.lit.slice(0, -1);
    }
  }
}

// Try to parse link reference definitions from the start of a paragraph.
// Returns the remaining lines (or null when the paragraph is fully consumed).
function parseRefDefs(P, text) {
  let i = 0;
  const len = text.length;
  let consumed = 0;
  while (true) {
    // skip up to 3 spaces of indent, then expect '['
    let j = i;
    let ind = 0;
    while (j < len && text[j] === ' ' && ind < 3) { j++; ind++; }
    if (j >= len || text[j] !== '[') break;
    const lab = parseLinkLabel(text, j);
    if (!lab) break;
    const label = normalizeLabel(lab[0]);
    if (label === '') break;
    let k = lab[1];
    // optional whitespace (incl. newlines), then ':'
    while (k < len && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
    if (k >= len || text[k] !== ':') break;
    k++;
    const dest = parseLinkDestination(text, k);
    if (!dest) break;
    k = dest[1];
    // end of the destination's line
    let lineEnd = k;
    while (lineEnd < len && text[lineEnd] !== '\n') lineEnd++;
    // optional title: skip whitespace (spaces, tabs, newlines) to
    // reach a title opener, on the same line or a following line
    let title = null;
    let endPos = lineEnd;
    let k2 = k;
    let crossedNl = false;
    while (k2 < len && (text[k2] === ' ' || text[k2] === '\t' || text[k2] === '\n')) {
      if (text[k2] === '\n') crossedNl = true;
      k2++;
    }
    if (k2 < len && (text[k2] === '"' || text[k2] === "'" || text[k2] === '(')) {
      if (k2 === k) break; // a title must be separated from the destination
      const t = parseLinkTitle(text, k2);
      if (t) {
        // after the title: only whitespace to the end of its line
        let titleLineEnd = t[1];
        while (titleLineEnd < len && text[titleLineEnd] !== '\n') titleLineEnd++;
        let k3 = t[1];
        while (k3 < titleLineEnd && (text[k3] === ' ' || text[k3] === '\t')) k3++;
        if (k3 === titleLineEnd) {
          title = t[0];
          endPos = titleLineEnd;
        } else if (crossedNl) {
          // invalid title on a later line: accept dest-only
          title = null;
          endPos = lineEnd;
        } else {
          break; // trailing junk after a same-line title fails the ref def
        }
      } else if (crossedNl) {
        // invalid title on a later line: accept dest-only
        title = null;
        endPos = lineEnd;
      } else {
        break; // an invalid title on the same line fails the ref def
      }
    } else {
      // no title opener: dest-only, unless there is junk on the dest line
      if (!crossedNl && k2 < lineEnd) break;
      title = null;
      endPos = lineEnd;
    }
    // consume through the end of the ref def and its newline (if any)
    let k3 = endPos;
    if (k3 < len && text[k3] === '\n') k3++;
    if (!P.refs.has(label)) P.refs.set(label, { dest: dest[0], title });
    i = k3;
    consumed = k3;
  }
  if (consumed === 0) return text;
  return text.slice(consumed);
}

function finalizeParagraph(P, para) {
  // Trailing whitespace-only lines are stripped, except when the
  // paragraph is finalized at the end of the document. A trailing
  // tab-only line in a table is an empty row, not trailing whitespace,
  // so it is kept.
  if (!P.atEof) {
    while (para.lines.length > 0 && para.lines[para.lines.length - 1].trim() === '') {
      const last = para.lines[para.lines.length - 1];
      if (last.includes('\t') && paraIsTable(para)) break;
      para.lines.pop();
    }
  }
  const text = para.lines.join('\n');
  const rest = parseRefDefs(P, text);
  if (rest === '') {
    // fully consumed by definitions: remove the paragraph from its parent
    const parent = para.p;
    const idx = parent.c.indexOf(para);
    if (idx >= 0) parent.c.splice(idx, 1);
    para.removed = true;
    return;
  }
  para.text = rest;
  // GFM table? The paragraph must have at least 2 lines: header + delimiter.
  const table = tryParseTable(rest);
  if (table) {
    para.t = 'table';
    para.align = table.align;
    para.header = table.header;
    para.rows = table.rows;
    delete para.lines;
    delete para.text;
  }
}

// Split a table row line into cells (unescaped pipes separate cells;
// a leading/trailing pipe marks the edge and is dropped).
function splitTableRow(line) {
  let s = line;
  // trim one leading and one trailing pipe (after trimming spaces around them)
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ' ') start++;
  if (start < end && s[start] === '|') start++;
  while (end > start && s[end - 1] === ' ') end--;
  if (end > start && s[end - 1] === '|') end--;
  s = s.slice(start, end);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// Does this paragraph's lines so far form a table header + delimiter?
// (Used to decide whether a tab-only line continues the table as an
// empty row instead of ending the paragraph.)
function paraIsTable(para) {
  if (para.lines.length < 2) return false;
  return tryParseTable(para.lines.join('\n')) !== null;
}

function tryParseTable(text) {
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  const headerLine = text.slice(0, nl);
  const rest = text.slice(nl + 1);
  const nl2 = rest.indexOf('\n');
  const delimLine = nl2 < 0 ? rest : rest.slice(0, nl2);
  const bodyText = nl2 < 0 ? '' : rest.slice(nl2 + 1);
  // the delimiter line may be indented at most 3 columns
  {
    let di = 0, dcol = 0;
    while (di < delimLine.length) {
      const c = delimLine[di];
      if (c === ' ') { dcol++; di++; }
      else if (c === '\t') { dcol += 4 - (dcol % 4); di++; }
      else break;
    }
    if (dcol >= 4) return null;
  }
  const header = splitTableRow(headerLine);
  const delim = splitTableRow(delimLine);
  if (header.length !== delim.length) return null;
  const align = [];
  for (let i = 0; i < delim.length; i++) {
    const d = delim[i];
    if (!/^:?-+:?$/.test(d)) return null;
    align.push(d[0] === ':' && d[d.length - 1] === ':' ? 'center' : d[0] === ':' ? 'left' : d[d.length - 1] === ':' ? 'right' : null);
  }
  const rows = [];
  if (bodyText !== '') {
    const lines = bodyText.split('\n');
    for (const line of lines) {
      const cells = splitTableRow(line);
      while (cells.length < header.length) cells.push('');
      if (cells.length > header.length) cells.length = header.length;
      rows.push(cells);
    }
  }
  return { align, header, rows };
}

// --- container matching ----------------------------------------------------

function matchBlockquote(ln) {
  const save = saveLine(ln);
  let ind = 0;
  while (ind < 3 && lch(ln) === ' ') { ladv(ln); ind++; }
  if (lch(ln) !== '>') { restoreLine(ln, save); return false; }
  ladv(ln);
  if (lch(ln) === ' ') ladv(ln);
  else if (lch(ln) === '\t') ladvCols(ln, 1);
  return true;
}

function matchItem(ln, item) {
  if (lblank(ln)) return true;
  const ind = lindent(ln);
  if (ind >= item.contentIndent) {
    ladvCols(ln, item.contentIndent);
    return true;
  }
  return false;
}

// --- new block starters ----------------------------------------------------

function matchATX(ln) {
  const save = saveLine(ln);
  let ind = 0;
  while (ind < 3 && lch(ln) === ' ') { ladv(ln); ind++; }
  if (lch(ln) !== '#') { restoreLine(ln, save); return null; }
  let level = 0;
  while (lch(ln) === '#') { ladv(ln); level++; }
  if (level > 6) { restoreLine(ln, save); return null; }
  const after = lch(ln);
  if (after !== '' && after !== ' ' && after !== '\t') { restoreLine(ln, save); return null; }
  // skip whitespace after the hashes
  while (lch(ln) === ' ' || lch(ln) === '\t') ladv(ln);
  let content = lrest(ln);
  // strip trailing spaces, then a closing sequence of #'s preceded by a space
  content = content.replace(/[ \t]+$/, '');
  const m = /^(.*?)[ \t]+#+$/.exec(content);
  if (m) content = m[1];
  else if (/^#+$/.test(content)) content = '';
  return { level, content };
}

function matchFenceStart(ln) {
  const save = saveLine(ln);
  let ind = 0;
  while (ind < 3 && lch(ln) === ' ') { ladv(ln); ind++; }
  const ch = lch(ln);
  if (ch !== '`' && ch !== '~') { restoreLine(ln, save); return null; }
  let len = 0;
  while (lch(ln) === ch) { ladv(ln); len++; }
  if (len < 3) { restoreLine(ln, save); return null; }
  const info = lrest(ln);
  if (ch === '`' && info.indexOf('`') >= 0) { restoreLine(ln, save); return null; }
  return { ch, len, info: info.trim(), ind };
}

function matchClosingFence(ln, fenceCh, fenceLen) {
  const save = saveLine(ln);
  let ind = 0;
  while (ind < 3 && lch(ln) === ' ') { ladv(ln); ind++; }
  if (lch(ln) !== fenceCh) { restoreLine(ln, save); return false; }
  let len = 0;
  while (lch(ln) === fenceCh) { ladv(ln); len++; }
  if (len < fenceLen) { restoreLine(ln, save); return false; }
  if (!lblank(ln)) { restoreLine(ln, save); return false; }
  return true;
}

// Returns the HTML block type (1-7) that starts at the current position, or 0.
function matchHtmlStart(ln) {
  const save = saveLine(ln);
  let ind = 0;
  while (ind < 3 && lch(ln) === ' ') { ladv(ln); ind++; }
  if (lch(ln) !== '<') { restoreLine(ln, save); return 0; }
  const rest = lrest(ln);
  const lower = rest.toLowerCase();
  // type 1: <script, <pre, <style, <textarea (open tag form only)
  if (/^<(script|pre|style|textarea)([\s>]|$)/.test(lower)) return 1;
  // type 2: <!--
  if (lower.startsWith('<!--')) return 2;
  // type 3: <?
  if (lower.startsWith('<?')) return 3;
  // type 4: <! followed by a letter
  if (/^<![a-z]/.test(lower)) return 4;
  // type 5: <![CDATA[
  if (lower.startsWith('<![cdata[')) return 5;
  // type 6: block tag open/close followed by space, >, />, or EOL
  const m6 = /^<\/?([a-z][a-z0-9-]*)(\s|\/?>|$)/.exec(lower);
  if (m6 && BLOCK_TAGS.has(m6[1])) return 6;
  // type 7: a complete open or closing tag followed only by whitespace/EOL
  const tag = parseHtmlTag(rest, 0);
  if (tag && (tag[2] === 'open' || tag[2] === 'close')) {
    let k = tag[1];
    let onlyWs = true;
    while (k < rest.length) {
      if (rest[k] !== ' ' && rest[k] !== '\t') { onlyWs = false; break; }
      k++;
    }
    if (onlyWs) return 7;
  }
  restoreLine(ln, save);
  return 0;
}

function matchSetext(ln) {
  const save = saveLine(ln);
  let ind = 0;
  while (ind < 3 && lch(ln) === ' ') { ladv(ln); ind++; }
  const ch = lch(ln);
  if (ch !== '=' && ch !== '-') { restoreLine(ln, save); return 0; }
  while (lch(ln) === ch) ladv(ln);
  if (!lblank(ln)) { restoreLine(ln, save); return 0; }
  return ch === '=' ? 1 : 2;
}

function matchThematicBreak(ln) {
  const save = saveLine(ln);
  let ind = 0;
  while (ind < 3 && lch(ln) === ' ') { ladv(ln); ind++; }
  const ch = lch(ln);
  if (ch !== '*' && ch !== '-' && ch !== '_') { restoreLine(ln, save); return false; }
  let n = 0;
  while (true) {
    const c = lch(ln);
    if (c === ch) { ladv(ln); n++; }
    else if (c === ' ' || c === '\t') ladv(ln);
    else break;
  }
  if (n >= 3 && lblank(ln)) return true;
  restoreLine(ln, save);
  return false;
}

// Try to match a list item marker. Returns the item node or null.
// On success the line is positioned just past the marker; the caller must
// advance past the padding before the item's content is parsed.
function matchList(P, ln, cont) {
  const save = saveLine(ln);
  let ind = 0;
  while (ind < 3 && lch(ln) === ' ') { ladv(ln); ind++; }
  const markerOff = ind;
  const ch = lch(ln);
  let bullet = null;
  let delim = null;
  let start = 0;
  let width = 0;
  if (ch === '-' || ch === '+' || ch === '*') {
    bullet = ch;
    width = 1;
    ladv(ln);
  } else if (isDigit(ch)) {
    let num = '';
    let ndig = 0;
    while (ndig < 9 && isDigit(lch(ln))) { num += lch(ln); ladv(ln); ndig++; }
    if (isDigit(lch(ln))) { restoreLine(ln, save); return null; }
    const d = lch(ln);
    if (d !== '.' && d !== ')') { restoreLine(ln, save); return null; }
    delim = d;
    start = parseInt(num, 10);
    width = num.length + 1;
    ladv(ln);
  } else {
    restoreLine(ln, save);
    return null;
  }
  const after = lch(ln);
  if (after !== ' ' && after !== '\t' && after !== '') { restoreLine(ln, save); return null; }
  // count whitespace columns after the marker
  let i = ln.pos;
  let col = ln.col;
  let spaces = 0;
  while (i < ln.s.length) {
    const c = ln.s[i];
    if (c === ' ') { spaces++; col++; i++; }
    else if (c === '\t') { const w = 4 - (col % 4); spaces += w; col += w; i++; }
    else break;
  }
  const isEmpty = i >= ln.s.length;
  let padding;
  if (isEmpty) padding = 1;
  else if (spaces >= 5) padding = 1;
  else padding = spaces;
  const contentIndent = markerOff + width + padding;
  // interruption rules: a list item cannot interrupt a paragraph when it
  // is empty, or when it is an ordered list not starting with 1 — unless
  // the paragraph sits inside a list, where any item interrupts
  const last = lastChild(cont);
  const para = last && last.t === 'paragraph' && last.open ? last : null;
  if (para) {
    let inList = false;
    for (let b = cont; b; b = b.p) {
      if (b.t === 'list') { inList = true; break; }
      if (b.t === 'document') break;
    }
    if (!inList) {
      if (isEmpty) { restoreLine(ln, save); return null; }
      if (bullet === null && start !== 1) { restoreLine(ln, save); return null; }
    }
  }
  // find or create the list
  let list = null;
  if (last && last.t === 'list' && last.open) {
    if (bullet !== null && last.listType === 'bullet' && last.bullet === bullet) list = last;
    if (bullet === null && last.listType === 'ordered' && last.delim === delim) list = last;
  }
  if (!list) {
    list = mknode('list');
    list.listType = bullet !== null ? 'bullet' : 'ordered';
    list.bullet = bullet;
    list.delim = delim;
    list.start = bullet !== null ? 1 : start;
    list.tight = true;
    addChild(P, cont, list);
  }
  const item = mknode('item');
  item.markerOff = markerOff;
  item.contentIndent = contentIndent;
  addChild(P, list, item);
  ladvCols(ln, padding);
  return item;
}

// Does the line (from its current position) end an HTML block of the given type?
function htmlEndReached(ln, htmlType) {
  const rest = lrest(ln);
  const lower = rest.toLowerCase();
  if (htmlType === 1) {
    return lower.indexOf('</script') >= 0 || lower.indexOf('</pre') >= 0 ||
      lower.indexOf('</style') >= 0 || lower.indexOf('</textarea') >= 0;
  }
  if (htmlType === 2) return rest.indexOf('-->') >= 0;
  if (htmlType === 3) return rest.indexOf('?>') >= 0;
  if (htmlType === 4) return rest.indexOf('>') >= 0;
  if (htmlType === 5) return rest.indexOf(']]>') >= 0;
  return false;
}

// Lightweight list-start check for the lazy-interrupt test: does this
// line start a list item that could interrupt a paragraph? (bullet or
// ordered marker + space/tab.) In strict mode (a paragraph at document
// level) an empty item, or an ordered list not starting with 1, cannot
// interrupt; inside a list any item interrupts. Does not mutate the
// line or the tree.
function lineStartsList(ln, strict) {
  const save = saveLine(ln);
  let ind = 0;
  while (ind < 3 && lch(ln) === ' ') { ladv(ln); ind++; }
  const ch = lch(ln);
  let bullet = false;
  let start = 0;
  if (ch === '-' || ch === '+' || ch === '*') {
    bullet = true;
    ladv(ln);
  } else if (isDigit(ch)) {
    let num = '';
    let ndig = 0;
    while (ndig < 9 && isDigit(lch(ln))) { num += lch(ln); ladv(ln); ndig++; }
    if (isDigit(lch(ln))) { restoreLine(ln, save); return false; }
    const d = lch(ln);
    if (d !== '.' && d !== ')') { restoreLine(ln, save); return false; }
    start = parseInt(num, 10);
    ladv(ln);
  } else {
    restoreLine(ln, save);
    return false;
  }
  const after = lch(ln);
  if (after !== ' ' && after !== '\t' && after !== '') { restoreLine(ln, save); return false; }
  if (strict) {
    while (lch(ln) === ' ' || lch(ln) === '\t') ladv(ln);
    if (lch(ln) === '') { restoreLine(ln, save); return false; }
    if (!bullet && start !== 1) { restoreLine(ln, save); return false; }
  }
  restoreLine(ln, save);
  return true;
}

// Parse a list-item marker at the current line position (dry run).
// Returns {bullet, delim} or null. Does not mutate the line.
function parseListMarker(ln) {
  const save = saveLine(ln);
  let ind = 0;
  while (ind < 3 && lch(ln) === ' ') { ladv(ln); ind++; }
  const ch = lch(ln);
  let bullet = null, delim = null;
  if (ch === '-' || ch === '+' || ch === '*') {
    bullet = ch;
    ladv(ln);
  } else if (isDigit(ch)) {
    let num = '';
    let ndig = 0;
    while (ndig < 9 && isDigit(lch(ln))) { num += lch(ln); ladv(ln); ndig++; }
    if (isDigit(lch(ln))) { restoreLine(ln, save); return null; }
    const d = lch(ln);
    if (d !== '.' && d !== ')') { restoreLine(ln, save); return null; }
    delim = d;
    ladv(ln);
  } else {
    restoreLine(ln, save);
    return null;
  }
  const after = lch(ln);
  if (after !== ' ' && after !== '\t' && after !== '') { restoreLine(ln, save); return null; }
  restoreLine(ln, save);
  return { bullet, delim };
}

// Find where a new block (that does not continue the open containers)
// belongs. Returns {closeTo, startIn}: close everything below closeTo,
// then start the new block as a child of startIn. The line matched
// `container` and everything above it, so the new block belongs inside
// the innermost matched container that can hold it: for a list that is
// its parent (a paragraph cannot be a list's child; a compatible item
// is found again by matchList in startBlocks), otherwise the container
// itself. It is never walked up past a blockquote, item or document,
// which the line matched.
function interruptTarget(ln, container) {
  if (container.t === 'list') {
    return { closeTo: container, startIn: container.p };
  }
  return { closeTo: container, startIn: container };
}

// Dry-run check: would this line start a new block that interrupts a
// paragraph (when the containers do not match)? The line position is
// saved and restored.
function lineInterruptsPara(ln, inList) {
  const save = saveLine(ln);
  if (matchBlockquote(ln)) { restoreLine(ln, save); return true; }
  if (matchATX(ln)) { restoreLine(ln, save); return true; }
  if (matchFenceStart(ln)) { restoreLine(ln, save); return true; }
  const ht = matchHtmlStart(ln);
  if (ht && ht !== 7) { restoreLine(ln, save); return true; }
  restoreLine(ln, save);
  if (matchThematicBreak(ln)) { restoreLine(ln, save); return true; }
  if (lineStartsList(ln, !inList)) { restoreLine(ln, save); return true; }
  restoreLine(ln, save);
  return false;
}

// Is this lazy-line text a setext level-1 underline (0-3 leading spaces,
// '=' run, optional trailing whitespace)?
function isSetextEqLine(s) {
  let i = 0;
  while (i < 3 && s[i] === ' ') i++;
  if (s[i] !== '=') return false;
  while (s[i] === '=') i++;
  while (s[i] === ' ' || s[i] === '\t') i++;
  return i === s.length;
}

function incorporateInner(P, ln, blank) {
  const doc = P.doc;
  let container = doc;
  let allMatched = true;
  while (true) {
    const last = lastChild(container);
    if (!last || !last.open) break;
    if (last.t === 'blockquote') {
      if (!matchBlockquote(ln)) { allMatched = false; break; }
      container = last;
    } else if (last.t === 'list') {
      // A list whose last item is closed (e.g. left open after a
      // ref-def-only line consumed no block) is finished unless the
      // line starts a new list item, which continues it (a blank line
      // between items does not end a list). Close it and do not descend
      // otherwise, so the next block starts outside the list.
      const li = lastChild(last);
      if ((!li || !li.open) && !lineStartsList(ln, false)) {
        finalizeBlock(P, last);
        break;
      }
      container = last;
    } else if (last.t === 'item') {
      if (!matchItem(ln, last)) {
        // A fenced code block keeps a line as content even when the
        // list item does not match (the line is not indented to the
        // item's content level); the block only ends at its closing
        // fence. Other blocks close when the item does not match.
        // (A blockquote that does not match still closes the block.)
        if (P.tip.t === 'code' && P.tip.fenced) {
          container = last;
          break;
        }
        allMatched = false; break;
      }
      container = last;
    } else break;
  }
  // A line whose rest after container matching is empty (only markers,
  // e.g. '>') is effectively blank: it ends a paragraph but does not
  // close any container and does not start a block.
  const effBlank = blank || lrest(ln) === '';
  P.curBlank = effBlank;
  P.curEmpty = lrest(ln) === '';
  const tip = P.tip;
  if (!allMatched && tip.t === 'paragraph' && !effBlank) {
    // Whether the paragraph sits inside a list (then any list item
    // interrupts it) or not (then only a non-empty item starting at 1
    // interrupts it).
    let inList = false;
    for (let b = tip.p; b; b = b.p) {
      if (b.t === 'list') { inList = true; break; }
      if (b.t === 'document') break;
    }
    if (lineInterruptsPara(ln, inList)) {
      const tgt = interruptTarget(ln, container);
      closeBelow(P, tgt.closeTo);
      startBlocks(P, ln, tgt.startIn);
      return;
    }
    // Lazy continuation: a lazy line inside a container loses up to
    // four columns of its own indent.
    if (lindent(ln) >= 4) ladvCols(ln, 4);
    // Blockquote lazy setext-underline quirk: a lazy '===' line gets
    // four spaces prepended when a lazy line was already added to this
    // paragraph and the paragraph is a direct child of a blockquote.
    let text = lrest(ln);
    if (tip.p && tip.p.t === 'blockquote' && tip.hadLazy && isSetextEqLine(text)) {
      text = '    ' + text.replace(/^[ \t]+/, '');
    }
    tip.lines.push(text);
    tip.hadLazy = true;
    return;
  }
  if (!allMatched) {
    if (effBlank) {
      // A blank line (or a line whose rest is empty after container
      // matching, e.g. a lone '>') closes the containers it does not
      // match (e.g. an inner blockquote); a list is never failed by a
      // blank line.
      closeBelow(P, container);
    } else if (!effBlank) {
      const tgt = interruptTarget(ln, container);
      closeBelow(P, tgt.closeTo);
      container = tgt.startIn;
    }
  }
  // If the innermost matched container is a list (its item is closed
  // or absent), the new block belongs in the list's parent: a paragraph
  // cannot be a list's child, while a list item joins the list again.
  // (Only when the list is actually an ancestor of the tip.)
  if (container.t === 'list') {
    let anc = P.tip;
    while (anc && anc !== container) anc = anc.p;
    if (anc === container) {
      const tgt = interruptTarget(ln, container);
      closeBelow(P, tgt.closeTo);
      container = tgt.startIn;
    }
  }
  let t2 = P.tip;
  // indented code block continuation
  if (t2.t === 'code' && !t2.fenced) {
    if (effBlank) { ladvCols(ln, 4); t2.lit += lrest(ln) + '\n'; return; }
    const ind = lindent(ln);
    if (ind >= 4) { ladvCols(ln, 4); t2.lit += lrest(ln) + '\n'; return; }
    finalizeBlock(P, t2);
    P.tip = container;
    t2 = container;
  }
  // fenced code block continuation
  if (t2.t === 'code' && t2.fenced) {
    if (matchClosingFence(ln, t2.fenceCh, t2.fenceLen)) {
      finalizeBlock(P, t2);
      P.tip = container;
      return;
    }
    // Up to the opening fence's indent is stripped from content lines
    // — but only for backtick fences; a tilde fence keeps the content
    // lines' indentation as-is (marked quirk).
    ladvCols(ln, t2.fenceCh === '`' ? (t2.fenceIndent || 0) : 0);
    let lit = lrest(ln);
    // A tab at the start of a fenced code line is expanded to spaces
    // only when the code block is nested inside a container (list
    // item, blockquote, ...); at the top level a tab stays a tab.
    // The expansion column is relative to the fence's indent: a
    // backtick fence strips that indent first, so ln.col is already
    // relative; a tilde fence keeps its content indentation, so the
    // fence indent is subtracted for the column calculation. A tab
    // directly after blockquote markers expands as if at column 2
    // no matter how deep the quote nests, so each blockquote level
    // beyond the first contributes 2 fewer columns.
    if (t2.p && t2.p.t !== 'document') {
      let bq = 0;
      for (let a = t2.p; a; a = a.p) if (a.t === 'blockquote') bq++;
      const extra = bq > 1 ? 2 * (bq - 1) : 0;
      const startCol = t2.fenceCh === '~' ? ln.col - (t2.fenceIndent || 0) - extra : ln.col - extra;
      lit = expandLeadingTabs(lit, startCol);
    }
    t2.lit += lit + '\n';
    return;
  }
  // HTML block continuation
  if (t2.t === 'html') {
    if (t2.endReached) {
      // The block ended at its end marker on a previous line; it closes
      // now, dropping its trailing newline only when this line is truly
      // empty (a whitespace-only line keeps the newline).
      if (lrest(ln) === '' && t2.lit.endsWith('\n')) t2.lit = t2.lit.slice(0, -1);
      finalizeBlock(P, t2);
      P.tip = container;
    } else if ((t2.htmlType === 6 || t2.htmlType === 7) && effBlank) {
      finalizeBlock(P, t2);
      P.tip = container;
    } else {
      t2.lit += lrest(ln) + '\n';
      if (t2.htmlType !== 6 && t2.htmlType !== 7 && htmlEndReached(ln, t2.htmlType)) {
        t2.endReached = true;
      }
      return;
    }
  }
  // blank line
  if (effBlank) {
    // A blank line inside a blockquote does not make an outer list
    // loose (it separates blocks inside the quote, not list items).
    if (container.t !== 'blockquote') P.lastLineBlank = true;
    if (P.tip.t === 'paragraph') {
      // A whitespace-only line that contains a tab does not end a
      // table: it becomes an empty row. (A spaces-only or empty line
      // does end the table, as it ends any paragraph.)
      if (blank && ln.s.includes('\t') && paraIsTable(P.tip)) {
        P.tip.lines.push(ln.s);
        return;
      }
      finalizeBlock(P, P.tip); P.tip = container;
    }
    else if (P.tip.t === 'item' && P.tip.c.length === 0 && P.tip.p && P.tip.p.t === 'list') {
      // an empty list item followed by a blank line ends the item (the
      // list stays open for a following item; other blocks go to the
      // list's parent, see incorporateInner)
      const list = P.tip.p;
      finalizeBlock(P, P.tip);
      P.tip = list;
    }
    return;
  }
  startBlocks(P, ln, container);
}

function incorporateLine(P, ln) {
  const blank = lblank(ln);
  incorporateInner(P, ln, blank);
  // clear after the line is processed, so a block added by this line
  // still sees the flag; use the effective blank (a line whose rest is
  // empty after container matching counts as blank here too)
  if (!P.curBlank) P.lastLineBlank = false;
}

function startBlocks(P, ln, cont) {
  while (true) {
    const last = lastChild(cont);
    const para = last && last.t === 'paragraph' && last.open ? last : null;
    // block quote
    if (matchBlockquote(ln)) {
      const bq = mknode('blockquote');
      addChild(P, cont, bq);
      cont = bq;
      continue;
    }
    // ATX heading
    const atx = matchATX(ln);
    if (atx) {
      const h = mknode('heading');
      h.level = atx.level;
      h.lines = [atx.content];
      addChild(P, cont, h);
      P.tip = cont;
      return;
    }
    // fenced code block
    const fence = matchFenceStart(ln);
    if (fence) {
      const cb = mknode('code');
      cb.fenced = true;
      cb.fenceCh = fence.ch;
      cb.fenceLen = fence.len;
      cb.info = fence.info;
      cb.fenceIndent = fence.ind;
      cb.lit = '';
      addChild(P, cont, cb);
      return;
    }
    // HTML block (types 1-6 can interrupt a paragraph; type 7 cannot)
    const htmlSave = saveLine(ln);
    const htmlType = matchHtmlStart(ln);
    restoreLine(ln, htmlSave);
    if (htmlType && (htmlType !== 7 || !para)) {
      const hb = mknode('html');
      hb.htmlType = htmlType;
      hb.lit = lrest(ln) + '\n';
      addChild(P, cont, hb);
      // types 1-5 can end on their first line (end marker present);
      // the block still closes on the next line (see incorporateInner).
      if (htmlType >= 1 && htmlType <= 5 && htmlEndReached(ln, htmlType)) {
        hb.endReached = true;
      }
      return;
    }
    // setext heading underline
    if (para) {
      const setextSave = saveLine(ln);
      const lvl = matchSetext(ln);
      if (lvl) {
        // Link reference definitions at the paragraph start are consumed
        // first; the remaining lines become the heading. If the paragraph
        // is fully consumed by definitions there is no heading: the
        // underline line itself becomes a fresh paragraph.
        const text = para.lines.join('\n');
        const rest = parseRefDefs(P, text);
        const trimmed = rest.trim();
        if (trimmed === '') {
          const parent = para.p;
          const idx = parent.c.indexOf(para);
          if (idx >= 0) parent.c.splice(idx, 1);
          para.removed = true;
          P.tip = cont;
          restoreLine(ln, setextSave);
          continue;
        }
        para.lines = trimmed.split('\n');
        para.t = 'heading';
        para.level = lvl;
        para.open = false;
        P.tip = cont;
        return;
      }
    }
    // thematic break
    if (matchThematicBreak(ln)) {
      addChild(P, cont, mknode('thematic_break'));
      P.tip = cont;
      return;
    }
    // list item
    const item = matchList(P, ln, cont);
    if (item) {
      cont = item;
      continue;
    }
    // indented code block (cannot interrupt a paragraph)
    if (!para) {
      const ind = lindent(ln);
      if (ind >= 4) {
        const cb = mknode('code');
        cb.fenced = false;
        cb.lit = '';
        ladvCols(ln, 4);
        cb.lit += lrest(ln) + '\n';
        addChild(P, cont, cb);
        return;
      }
    }
    // paragraph (new or continued); a blank line does not start one
    if (para) {
      para.lines.push(lrest(ln));
    } else if (lrest(ln).trim() !== '') {
      const p = mknode('paragraph');
      p.lines = [lrest(ln)];
      addChild(P, cont, p);
    }
    return;
  }
}

function parseBlocks(src) {
  src = src.replace(/\r\n?/g, '\n');
  const endsWithNl = src.endsWith('\n');
  let raw = src.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const doc = mknode('document');
  const P = { doc, tip: doc, refs: new Map(), lastLineBlank: false, atEof: false, endsWithNl };
  for (let i = 0; i < raw.length; i++) {
    incorporateLine(P, { s: raw[i], pos: 0, col: 0, pend: 0 });
  }
  P.atEof = true;
  closeBelow(P, doc);
  finalizeBlock(P, doc);
  return { doc, refs: P.refs };
}

// ---------------------------------------------------------------------------
// Inline parsing.
// ---------------------------------------------------------------------------

// Whitespace test for flanking ('' = start/end of text, treated as whitespace).
function isWsC(c) {
  if (c === '') return true;
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\u1680' || (c >= '\u2000' && c <= '\u200a') || c === '\u2028' || c === '\u2029' || c === '\u202f' || c === '\u205f' || c === '\u3000' || c === '\ufeff';
}

function isPunctC(c) {
  if (c === '') return false;
  return isPunct(c);
}

function leftFlanking(prev, next) {
  if (isWsC(next)) return false;
  if (!isPunctC(next)) return true;
  return isWsC(prev) || isPunctC(prev);
}

function rightFlanking(prev, next) {
  if (isWsC(prev)) return false;
  if (!isPunctC(prev)) return true;
  return isWsC(next) || isPunctC(next);
}

// Chars stripped from the end of an autolink URL while trimming.
const TRAIL_PUNCT = new Set(['?', '!', '.', ',', ':', ';', '*', '_', '~', '"', "'"]);

// Trim a scanned autolink run per the GFM rules: unmatched '(' truncation,
// entity exclusion, trailing punctuation, and paren balancing. Loops to fixpoint.
function trimAutolinkUrl(url) {
  let u = url;
  while (true) {
    const before = u;
    // (1) unmatched '(' truncation: cut at the last '(' with no ')' after it
    while (true) {
      const lp = u.lastIndexOf('(');
      if (lp < 0) break;
      if (u.indexOf(')', lp) >= 0) break;
      u = u.slice(0, lp);
    }
    // (2) entity rule: a trailing ; whose &...; span is all alphanumerics
    // means the &...; is an entity and is cut off entirely
    if (u.endsWith(';')) {
      const amp = u.lastIndexOf('&', u.length - 2);
      if (amp >= 0) {
        const inner = u.slice(amp + 1, u.length - 1);
        if (inner.length > 0 && /^[A-Za-z0-9]+$/.test(inner)) u = u.slice(0, amp);
      }
    }
    // (3) trailing punctuation
    while (u.length > 0 && TRAIL_PUNCT.has(u[u.length - 1])) u = u.slice(0, -1);
    // (4) paren rule: strip a trailing ')' only when it is unmatched,
    // i.e. when no '(' is open just before it (unmatched ')' earlier
    // in the run do not count against a matched trailing one)
    while (u.endsWith(')')) {
      let depth = 0;
      for (let k = 0; k < u.length - 1; k++) {
        if (u[k] === '(') depth++;
        else if (u[k] === ')') depth = Math.max(0, depth - 1);
      }
      if (depth === 0) u = u.slice(0, -1);
      else break;
    }
    if (u === before) break;
  }
  return u;
}

function isLocalChar(c) {
  if (c === undefined || c === '') return false;
  const code = c.charCodeAt(0);
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  return '.!#$%&\'*+/=?^_`{|}~-'.indexOf(c) >= 0;
}

function isDomainChar(c) {
  if (c === undefined || c === '') return false;
  const code = c.charCodeAt(0);
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  return c === '-' || c === '_';
}

function isAlnum(c) {
  if (c === undefined || c === '') return false;
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// Scan an email address starting at text[i] (first char must be a local char).
// Returns [emailText, endIndex] or null.
// When trimUnderscore is true (an '_' emphasis delimiter is open), a
// trailing run of '_' is dropped from the domain (it closes the
// emphasis instead of belonging to the address); a trailing '-' never
// is — an address whose domain ends in '-' is not an autolink.
function scanEmail(text, i, trimUnderscore) {
  const len = text.length;
  let j = i;
  while (j < len && isLocalChar(text[j])) j++;
  if (j === i) return null;
  if (j >= len || text[j] !== '@') return null;
  const dStart = j + 1;
  let k = dStart;
  while (k < len && (isDomainChar(text[k]) || text[k] === '.')) k++;
  let dEnd = k;
  while (dEnd > dStart && text[dEnd - 1] === '.') dEnd--;
  if (trimUnderscore) {
    while (dEnd > dStart && text[dEnd - 1] === '_') dEnd--;
  }
  if (dEnd <= dStart) return null;
  const domain = text.slice(dStart, dEnd);
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  for (const lab of labels) if (lab.length === 0) return null;
  const last = labels[labels.length - 1];
  if (!isAlnum(last[last.length - 1])) return null;
  return [text.slice(i, dEnd), dEnd];
}

function isWwwFirst(c) {
  return isAlnum(c) || c === '_' || c === '-';
}

function isSchemeFirst(c) {
  return isAlnum(c) || c === '-';
}

function isXmppPathChar(c) {
  return isAlnum(c) || c === '@' || c === '.';
}

// Try an extended autolink (www. / scheme:// / mailto: / xmpp: / bare email)
// starting at text[i]. Returns [href, linkText, endIndex] or null.
function tryExtendedAutolink(text, i, delims, brackets) {
  const len = text.length;
  const ch = text[i];
  const prev = i > 0 ? text[i - 1] : '';
  const prevOk = prev === '' || isWsC(prev) || prev === '(' || prev === '*' || prev === '_' || prev === '~';
  // Does a ']' at this point close an active link bracket? Only then
  // does it end an autolink URL run (the ']' belongs to the outer
  // link); inside a deactivated bracket the ']' is literal text and
  // the URL run continues past it.
  const bracketCloses = brackets.length > 0 && brackets[brackets.length - 1].active;
  // Is an '_' emphasis delimiter currently open? (A trailing run of
  // '_' after an email address then closes it, not the domain.)
  // Computed lazily: only the mailto:/xmpp:/bare-email paths need it.
  let openUnderscore = null;
  const getOpenUnderscore = () => {
    if (openUnderscore !== null) return openUnderscore;
    openUnderscore = false;
    if (delims) {
      for (let d = 0; d < delims.length; d++) {
        const dl = delims[d];
        if (dl.ch === '_' && dl.canOpen && !dl.removed) { openUnderscore = true; break; }
      }
    }
    return openUnderscore;
  };
  // www.
  if (ch === 'w' && text.startsWith('www.', i)) {
    if (prevOk && i + 4 < len && isWwwFirst(text[i + 4])) {
      let j = i;
      while (j < len && !isWsC(text[j]) && text[j] !== '<') {
        // Stop before a ']' that closes link text (followed by '(' or
        // '['): the ']' belongs to the outer link, not to this URL.
        if (bracketCloses && text[j] === ']' && j + 1 < len && (text[j + 1] === '(' || text[j + 1] === '[')) break;
        j++;
      }
      const url = trimAutolinkUrl(text.slice(i, j));
      if (url.length > 4 && isWwwFirst(url[4])) {
        return ['http://' + url, url, i + url.length];
      }
    }
  }
  // scheme:// (http, https, ftp; case-insensitive; no preceding-char rule)
  if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') {
    const head = text.slice(i, i + 8).toLowerCase();
    let schemeLen = 0;
    if (head.startsWith('http://')) schemeLen = 7;
    else if (head.startsWith('https://')) schemeLen = 8;
    else if (head.startsWith('ftp://')) schemeLen = 6;
    if (schemeLen > 0) {
      const after = i + schemeLen;
      if (after < len && isSchemeFirst(text[after])) {
        let j = after;
        while (j < len && !isWsC(text[j]) && text[j] !== '<') {
          if (bracketCloses && text[j] === ']' && j + 1 < len && (text[j + 1] === '(' || text[j + 1] === '[')) break;
          j++;
        }
        const url = trimAutolinkUrl(text.slice(i, j));
        if (url.length > schemeLen) return [url, url, i + url.length];
      }
    }
  }
  // mailto: / xmpp: (lowercase only; same preceding-char rule as www.)
  if (ch === 'm' || ch === 'x') {
    let scheme = null;
    if (text.startsWith('mailto:', i)) scheme = 'mailto:';
    else if (text.startsWith('xmpp:', i)) scheme = 'xmpp:';
    if (scheme && prevOk) {
      const em = scanEmail(text, i + scheme.length, getOpenUnderscore());
      if (em) {
        let end = em[1];
        if (scheme === 'xmpp:' && end < len && text[end] === '/') {
          let q = end + 1;
          while (q < len && isXmppPathChar(text[q])) q++;
          let pEnd = q;
          while (pEnd > end + 1 && text[pEnd - 1] === '.') pEnd--;
          if (pEnd > end + 1) end = pEnd;
        }
        const full = text.slice(i, end);
        return [full, full, end];
      }
    }
  }
  // bare email
  if (isLocalChar(ch) && (i === 0 || !isLocalChar(text[i - 1]))) {
    const em = scanEmail(text, i, getOpenUnderscore());
    if (em) return ['mailto:' + em[0], em[0], em[1]];
  }
  return null;
}

// Try to parse an inline link destination/title starting at text[i] === '('.
// Returns {dest, title, end} or null.
function tryInlineLink(text, i) {
  const len = text.length;
  let j = i + 1;
  while (j < len && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  if (j >= len) return null;
  if (text[j] === ')') return { dest: '', title: null, end: j + 1 };
  const d = parseLinkDestination(text, j);
  if (!d) return null;
  const dest = d[0];
  let k = d[1];
  let title = null;
  const t = parseLinkTitle(text, k);
  if (t) { title = t[0]; k = t[1]; }
  while (k < len && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
  if (k >= len || text[k] !== ')') return null;
  return { dest, title, end: k + 1 };
}

// Plain text content of inline nodes (for link labels and image alt text).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 'text' || nd.k === 'code' || nd.k === 'html' || nd.k === 'raw') out += nd.s;
    else if (nd.k === 'delim') out += nd.ch.repeat(nd.n);
    else if (nd.k === 'bracket') out += nd.image ? '![' : '[';
    else if (nd.k === 'br' || nd.k === 'nl') out += '\n';
    else if (nd.c) out += plainText(nd.c);
  }
  return out;
}

// Plain text for an image's alt attribute: like plainText, but emphasis
// delimiters are dropped (emphasis is not rendered in alt text).
function altText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 'text' || nd.k === 'code' || nd.k === 'html' || nd.k === 'raw') out += nd.s;
    else if (nd.k === 'delim') { /* dropped */ }
    else if (nd.k === 'bracket') out += nd.image ? '![' : '[';
    else if (nd.k === 'br' || nd.k === 'nl') out += '\n';
    else if (nd.c) out += altText(nd.c);
  }
  return out;
}

// Process emphasis in a node list using its delimiter list.
// Mutates `nodes` in place (wrapping matched ranges into em/strong/del
// nodes and removing exhausted delimiters). Delimiters left over stay in
// the list and render as literal characters.
function processEmphasis(nodes, delims) {
  let di = 0;
  while (di < delims.length) {
    const closer = delims[di];
    if (closer.removed || closer.n === 0 || !closer.canClose) { di++; continue; }
    const ch = closer.ch;
    // find the nearest usable opener before this closer
    let opener = null;
    // consumed delimiters that formed an inner emphasis whose opener could
    // only open and whose closer could both open and close: they can bar
    // this closer from reaching an earlier opener (see below)
    const blockers = [];
    for (let j = di - 1; j >= 0; j--) {
      const op = delims[j];
      if (op.ch !== ch || !op.canOpen) continue;
      if (op.removed || op.n === 0) {
        if (op.blocks) blockers.push(op);
        continue;
      }
      // odd-match rule: skip when either can both open and close and the
      // counts sum to a multiple of 3 (unless both are multiples of 3)
      if ((op.canClose || closer.canOpen) && (op.n + closer.n) % 3 === 0 &&
          !(op.n % 3 === 0 && closer.n % 3 === 0)) continue;
      // blocking rule: an inner emphasis whose opener could only open
      // and whose closer could both open and close bars this closer from
      // an opener it cannot fully match: blocked when the opener has more
      // delimiters than this closer, or the inner closer originally had
      // more than this closer (e.g. `*a **b**c*` leaves the outer `*`
      // literal, while `*foo**bar**baz*` and `*a *b*c*` still form it);
      // also blocked when the inner closer originally had more delimiters
      // than this opener while this closer has at least that many (the
      // closer then pairs with an opener of its own size, e.g. the outer
      // `**` in `**x *y **z**w* v**` forms `<strong>`, not `<em>`)
      let blocked = false;
      for (let b = 0; b < blockers.length; b++) {
        if (op.n > closer.n || blockers[b].on > closer.n || (blockers[b].on > op.n && closer.n >= blockers[b].on)) { blocked = true; break; }
      }
      if (blocked) continue;
      opener = op;
      break;
    }
    if (!opener) { di++; continue; }
    const use = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
    // a closer whose opener could only open, while the closer itself could
    // both open and close, can bar a later closer from an earlier opener
    if (!opener.canClose && closer.canOpen && closer.canClose) closer.blocks = true;
    const opIdx = nodes.indexOf(opener);
    const clIdx = nodes.indexOf(closer);
    if (opIdx < 0 || clIdx < 0 || clIdx <= opIdx) { di++; continue; }
    const children = nodes.slice(opIdx + 1, clIdx);
    // delimiters enclosed by this wrap can no longer be used
    for (let k = opIdx + 1; k < clIdx; k++) {
      if (nodes[k].k === 'delim') nodes[k].removed = true;
    }
    // A partially-consumed closer leaves its leftover delimiters inside
    // the wrap when this forms a strong (use 2) and an inner emphasis
    // whose closer could both open and close (blocks) lies between this
    // opener and closer (e.g. `**a *b*c***` gives
    // `<strong>a <em>b</em>c*</strong>`); otherwise they stay after it
    // (e.g. `**a b***` gives `<strong>a b</strong>*`, and
    // `*changes *else*returns**` gives `<em>…returns</em>*`). The inner
    // delimiter is gone from `nodes` once consumed, so look in `delims`.
    let innerBlocks = false;
    const opDi = delims.indexOf(opener);
    if (opDi >= 0) {
      for (let k = opDi + 1; k < di; k++) {
        if (delims[k].blocks) { innerBlocks = true; break; }
      }
    }
    if (innerBlocks && use === 2 && closer.n - use > 0) {
      children.push({ k: 'text', s: ch.repeat(closer.n - use) });
      closer.n = use;
    }
    const wrap = { k: ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em'), c: children };
    nodes.splice(opIdx + 1, clIdx - opIdx - 1, wrap);
    opener.n -= use;
    closer.n -= use;
    if (opener.n === 0) {
      opener.removed = true;
      const oi2 = nodes.indexOf(opener);
      if (oi2 >= 0) nodes.splice(oi2, 1);
    }
    if (closer.n === 0) {
      closer.removed = true;
      const ci2 = nodes.indexOf(closer);
      if (ci2 >= 0) nodes.splice(ci2, 1);
      di++;
    }
    // if the closer still has delimiters left, reprocess it in place
  }
}

// Parse inline content of a block (paragraph, heading, table cell) into a
// flat node list. `refs` maps normalized labels to {dest, title}.
function parseInline(text, refs) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  let buf = '';
  const len = text.length;
  let i = 0;
  function flush() {
    if (buf !== '') { nodes.push({ k: 'text', s: buf }); buf = ''; }
  }
  while (i < len) {
    const ch = text[i];
    // newline: hard break (2+ trailing spaces) or soft break
    if (ch === '\n') {
      let trailing = 0;
      for (let k = buf.length - 1; k >= 0 && buf[k] === ' '; k--) trailing++;
      if (trailing >= 2) buf = buf.slice(0, buf.length - trailing);
      flush();
      const hard = trailing >= 2;
      nodes.push(hard ? { k: 'br' } : { k: 'nl' });
      i++;
      // after a hard break, the next line's leading whitespace is dropped
      if (hard) while (i < len && (text[i] === ' ' || text[i] === '\t')) i++;
      continue;
    }
    // backslash escapes and backslash-newline hard break
    if (ch === '\\') {
      const nx = i + 1 < len ? text[i + 1] : '';
      if (nx === '\n') {
        flush();
        nodes.push({ k: 'br' });
        i += 2;
        while (i < len && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      if (nx !== '' && isAsciiPunct(nx)) { buf += nx; i += 2; continue; }
      buf += '\\';
      i++;
      continue;
    }
    // code span
    if (ch === '`') {
      let n = 0;
      while (i + n < len && text[i + n] === '`') n++;
      let match = -1;
      let k = i + n;
      while (k < len) {
        if (text[k] === '`') {
          let m = 0;
          while (k + m < len && text[k + m] === '`') m++;
          if (m === n) { match = k; break; }
          k += m;
        } else k++;
      }
      if (match >= 0) {
        let content = text.slice(i + n, match).replace(/\n/g, ' ');
        let allSpaces = true;
        for (let c = 0; c < content.length; c++) {
          if (content[c] !== ' ') { allSpaces = false; break; }
        }
        if (content.length > 0 && content[0] === ' ' && content[content.length - 1] === ' ' && !allSpaces) {
          content = content.slice(1, -1);
        }
        flush();
        nodes.push({ k: 'code', s: content });
        i = match + n;
        continue;
      }
      buf += '`'.repeat(n);
      i += n;
      continue;
    }
    // '<': autolink, then inline HTML tag
    if (ch === '<') {
      const gt = text.indexOf('>', i + 1);
      if (gt >= 0) {
        const inner = text.slice(i + 1, gt);
        if (inner.length > 0 && inner.indexOf(' ') < 0 && inner.indexOf('\t') < 0 &&
            inner.indexOf('\n') < 0 && inner.indexOf('<') < 0) {
          const em = scanEmail(text, i + 1);
          if (em && em[1] === gt) {
            flush();
            nodes.push({ k: 'link', dest: 'mailto:' + em[0], title: null, c: [{ k: 'text', s: em[0] }] });
            i = gt + 1;
            continue;
          }
          if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(inner)) {
            flush();
            nodes.push({ k: 'link', dest: inner, title: null, c: [{ k: 'text', s: inner }] });
            i = gt + 1;
            continue;
          }
        }
      }
      const tag = parseHtmlTag(text, i);
      if (tag) {
        flush();
        nodes.push({ k: 'html', s: tag[0] });
        i = tag[1];
        continue;
      }
      buf += '<';
      i++;
      continue;
    }
    // '&': entity reference (named pass through raw; valid numeric decode)
    if (ch === '&') {
      const ent = entityAt(text, i);
      if (ent) {
        if (ent[2]) { flush(); nodes.push({ k: 'raw', s: ent[0] }); }
        else buf += ent[0];
        i = ent[1];
        continue;
      }
      buf += '&';
      i++;
      continue;
    }
    // '[' or '![': open a bracket
    if (ch === '[' || (ch === '!' && i + 1 < len && text[i + 1] === '[')) {
      flush();
      const image = ch === '!';
      // pos: index in the source just after the '[' (used to recover the
      // raw label text for shortcut/collapsed references, backslashes
      // included)
      const node = { k: 'bracket', image, active: true, pos: i + (image ? 2 : 1) };
      nodes.push(node);
      brackets.push(node);
      i += image ? 2 : 1;
      continue;
    }
    // ']': try to form a link or image
    if (ch === ']') {
      flush();
      if (brackets.length === 0) { buf += ']'; i++; continue; }
      const br = brackets[brackets.length - 1];
      if (!br.active) {
        // a deactivated bracket cannot form a link; ']' is literal
        brackets.pop();
        buf += ']';
        i++;
        continue;
      }
      const brIdx = nodes.indexOf(br);
      const children = nodes.slice(brIdx + 1);
      let dest = null, title = null, end = -1;
      let blockShortcut = false;
      if (i + 1 < len && text[i + 1] === '(') {
        const il = tryInlineLink(text, i + 1);
        if (il) { dest = il.dest; title = il.title; end = il.end; }
        // a failed inline link does not block the shortcut
      }
      if (dest === null && i + 1 < len && text[i + 1] === '[') {
        const lab = parseLinkLabel(text, i + 1);
        if (lab) {
          const label = normalizeLabel(lab[0]);
          if (label !== '') {
            const ref = refs.get(label);
            if (ref) { dest = ref.dest; title = ref.title; end = lab[1]; }
            else blockShortcut = true; // a [label] was present but undefined
          }
        }
      }
      if (dest === null && !blockShortcut && i + 2 < len && text[i + 1] === '[' && text[i + 2] === ']') {
        // collapsed reference: label is the bracket's raw source text
        const label = normalizeLabel(text.slice(br.pos, i));
        if (label !== '') {
          const ref = refs.get(label);
          if (ref) { dest = ref.dest; title = ref.title; end = i + 3; }
          else blockShortcut = true; // a [] was present but the label is undefined
        }
      }
      if (dest === null && !blockShortcut) {
        // shortcut reference: label is the bracket's raw source text
        const label = normalizeLabel(text.slice(br.pos, i));
        if (label !== '') {
          const ref = refs.get(label);
          if (ref) { dest = ref.dest; title = ref.title; end = i + 1; }
        }
      }
      if (dest === null) {
        // no link: deactivate the top bracket, ']' is literal
        brackets.pop();
        buf += ']';
        i++;
        continue;
      }
      // a link/image forms: collect its delimiters, process emphasis inside
      const linkDelims = [];
      for (const nd of children) if (nd.k === 'delim') linkDelims.push(nd);
      for (const d of linkDelims) {
        const di = delims.indexOf(d);
        if (di >= 0) delims.splice(di, 1);
      }
      // Extended autolinks do not form inside link text: turn any
      // extended-autolink node among the children back into plain
      // text (angle-bracket autolinks stay as links). Do this before
      // emphasis processing so the text is seen, not a link.
      for (let ci = 0; ci < children.length; ci++) {
        const cn = children[ci];
        if (cn.k === 'link' && cn.ext) {
          children[ci] = { k: 'text', s: cn.c && cn.c[0] ? cn.c[0].s : '' };
        }
      }
      // capture the child count before processEmphasis mutates `children`
      const childCount = children.length;
      let linkNode;
      if (br.image) {
        linkNode = { k: 'image', dest, title, c: children };
      } else {
        linkNode = { k: 'link', dest, title, c: children };
        processEmphasis(children, linkDelims);
      }
      nodes.splice(brIdx, childCount + 1, linkNode);
      if (br.image) {
        // an image forms: only its own bracket leaves the stack
        brackets.pop();
      } else {
        // a link forms: its own bracket leaves, and every link bracket
        // below it is deactivated (a link cannot contain a link) but
        // stays on the stack, so the next ']' pairs with it and is
        // literal instead of reaching a bracket further down; an image
        // bracket below it stays active
        brackets.pop();
        for (let j = brackets.length - 1; j >= 0; j--) {
          if (!brackets[j].image) brackets[j].active = false;
        }
      }
      i = end;
      continue;
    }
    // '*' / '_' / '~' delimiter runs
    if (ch === '*' || ch === '_' || ch === '~') {
      let n = 0;
      while (i + n < len && text[i + n] === ch) n++;
      const prev = i > 0 ? text[i - 1] : '';
      const next = i + n < len ? text[i + n] : '';
      const lf = leftFlanking(prev, next);
      const rf = rightFlanking(prev, next);
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = lf && (!rf || isPunctC(prev));
        canClose = rf && (!lf || isPunctC(next));
      } else {
        canOpen = lf;
        canClose = rf;
      }
      // GFM strikethrough: a run of three or more tildes cannot open
      // or close a <del> (~~~text~~~ stays literal)
      if (ch === '~' && n >= 3) {
        canOpen = false;
        canClose = false;
      }
      flush();
      const d = { k: 'delim', ch, n, on: n, canOpen, canClose };
      nodes.push(d);
      delims.push(d);
      i += n;
      continue;
    }
    // extended autolinks (www. / scheme:// / mailto: / xmpp: / bare email);
    // only a character that can start one is worth the scan, and never
    // when the previous character is alphanumeric (inside a word)
    const _pc = i > 0 ? text.charCodeAt(i - 1) : 0;
    const _inWord = (_pc >= 48 && _pc <= 57) || (_pc >= 65 && _pc <= 90) || (_pc >= 97 && _pc <= 122);
    const al = !_inWord && (ch === 'w' || ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'm' || ch === 'x' || isLocalChar(ch))
      ? tryExtendedAutolink(text, i, delims, brackets) : null;
    if (al) {
      flush();
      nodes.push({ k: 'link', dest: al[0], title: null, c: [{ k: 'text', s: al[1] }], ext: true });
      i = al[2];
      continue;
    }
    // ordinary character
    buf += ch;
    i++;
  }
  flush();
  processEmphasis(nodes, delims);
  return nodes;
}

// Render inline nodes to HTML.
function renderInline(nodes, refs) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 'text') out += escText(nd.s);
    else if (nd.k === 'code') out += '<code>' + escText(nd.s) + '</code>';
    else if (nd.k === 'br') out += '<br>';
    else if (nd.k === 'nl') out += '\n';
    else if (nd.k === 'html') out += nd.s;
    else if (nd.k === 'raw') out += nd.s;
    else if (nd.k === 'link') {
      out += '<a href="' + escHref(nd.dest) + '"';
      if (nd.title) out += ' title="' + escTitle(nd.title) + '"';
      out += '>' + renderInline(nd.c, refs) + '</a>';
    } else if (nd.k === 'image') {
      out += '<img src="' + escHref(nd.dest) + '" alt="' + escText(altText(nd.c)) + '"';
      if (nd.title) out += ' title="' + escTitle(nd.title) + '"';
      out += '>';
    } else if (nd.k === 'em') out += '<em>' + renderInline(nd.c, refs) + '</em>';
    else if (nd.k === 'strong') out += '<strong>' + renderInline(nd.c, refs) + '</strong>';
    else if (nd.k === 'del') out += '<del>' + renderInline(nd.c, refs) + '</del>';
    else if (nd.k === 'delim') out += nd.ch.repeat(nd.n);
    else if (nd.k === 'bracket') out += nd.image ? '![' : '[';
  }
  return out;
}

// If a paragraph is a task-list item (starts with [ ]/[x]/[X] followed by
// a space/tab and more content), return its text with the checkbox HTML
// substituted; otherwise return the paragraph text unchanged.
function taskText(para) {
  const text = para.text;
  if (!text || text[0] !== '[') return text;
  const m = /^\[( |x|X)\][ \t]+/.exec(text);
  if (!m) return text;
  if (text.length <= m[0].length) return text;
  const checked = m[1] === 'x' || m[1] === 'X';
  const box = checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
  return box + ' ' + text.slice(m[0].length);
}

// Render a block node (and its children) to HTML.
function renderBlock(block, refs) {
  switch (block.t) {
    case 'document': {
      let out = '';
      for (const child of block.c) out += renderBlock(child, refs);
      return out;
    }
    case 'paragraph': {
      return '<p>' + renderInline(parseInline(block.text, refs), refs) + '</p>\n';
    }
    case 'heading': {
      const text = block.lines.join('\n');
      return '<h' + block.level + '>' + renderInline(parseInline(text, refs), refs) + '</h' + block.level + '>\n';
    }
    case 'thematic_break':
      return '<hr>\n';
    case 'code': {
      let out = '<pre><code';
      if (block.fenced && block.info) {
        const info = block.info.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
        const lang = info.split(/[ \t]/)[0];
        if (lang) out += ' class="language-' + escTitle(lang) + '"';
      }
      out += '>' + escText(block.lit) + '</code></pre>\n';
      return out;
    }
    case 'html':
      return block.lit;
    case 'blockquote': {
      let out = '<blockquote>\n';
      for (const child of block.c) out += renderBlock(child, refs);
      out += '</blockquote>\n';
      return out;
    }
    case 'list': {
      const tag = block.listType === 'bullet' ? 'ul' : 'ol';
      let out = '<' + tag;
      if (block.listType === 'ordered' && block.start !== 1) out += ' start="' + block.start + '"';
      out += '>\n';
      for (const item of block.c) out += renderBlock(item, refs);
      out += '</' + tag + '>\n';
      return out;
    }
    case 'item': {
      let out = '<li>';
      const list = block.p;
      const tight = list ? list.tight : true;
      for (let ci = 0; ci < block.c.length; ci++) {
        const child = block.c[ci];
        if (child.t === 'paragraph') {
          const text = ci === 0 ? taskText(child) : child.text;
          if (tight) out += renderInline(parseInline(text, refs), refs);
          else out += '<p>' + renderInline(parseInline(text, refs), refs) + '</p>\n';
        } else {
          out += renderBlock(child, refs);
        }
      }
      out += '</li>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < block.header.length; i++) {
        const a = block.align[i];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInline(block.header[i], refs), refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (block.rows.length > 0) {
        out += '<tbody>';
        for (const row of block.rows) {
          out += '<tr>\n';
          for (let i = 0; i < row.length; i++) {
            const a = block.align[i];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInline(row[i], refs), refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
  }
  return '';
}

export function parse(markdown) {
  const { doc, refs } = parseBlocks(markdown);
  return renderBlock(doc, refs);
}
