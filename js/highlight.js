// Syntax colouring for the Dev file reader, IDE style, with no dependency. Each language is a list of rules tried
// in order at each position; a word is then sorted into keyword, literal, type or function. It reads like an
// editor's colours without parsing: good enough to read code, not to check it.
// highlight(text, language) returns lines, each a list of [class, text] runs ('' for plain).

const words = (list) => new Set(list.split(' '));

const JS_KEYWORDS = words('as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield declare namespace abstract keyof infer is');
const LITERALS = words('true false null undefined NaN Infinity None True False nil');

const C_LIKE = {
  comments: [/\/\/[^\n]*/y, /\/\*[\s\S]*?(?:\*\/|$)/y],
  strings: [/"(?:\\[\s\S]|[^"\\\n])*"?/y, /'(?:\\[\s\S]|[^'\\\n])*'?/y],
};

const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?\b/y;
const WORD = /[A-Za-z_$][\w$]*/y;

const LANGS = {
  js: {
    rules: [...C_LIKE.comments.map((r) => ['comment', r]), ['string', /`(?:\\[\s\S]|[^`\\])*`?/y], ...C_LIKE.strings.map((r) => ['string', r]), ['meta', /@[\w.]+/y], ['number', NUMBER]],
    keywords: JS_KEYWORDS,
    types: true,
  },
  json: {
    rules: [['property', /"(?:\\.|[^"\\\n])*"(?=\s*:)/y], ['string', /"(?:\\.|[^"\\\n])*"?/y], ['comment', /\/\/[^\n]*/y], ['number', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y]],
    keywords: words(''),
  },
  css: {
    rules: [['comment', /\/\*[\s\S]*?(?:\*\/|$)/y], ['comment', /\/\/[^\n]*/y], ...C_LIKE.strings.map((r) => ['string', r]), ['meta', /@[\w-]+/y], ['number', /#[\da-fA-F]{3,8}\b/y], ['property', /--?[A-Za-z][\w-]*(?=\s*:)/y], ['property', /[a-z][\w-]*(?=\s*:[^:{]*[;}\n])/y], ['number', /-?\d*\.?\d+(?:%|[a-z]+)?/y], ['keyword', /!important/y], ['function', /[\w-]+(?=\()/y], ['tag', /[.#][\w-]+/y], ['variable', /\$[\w-]+/y]],
    keywords: words(''),
    word: /[A-Za-z_-][\w-]*/y,
  },
  html: {
    rules: [['comment', /<!--[\s\S]*?(?:-->|$)/y], ['meta', /<![^>]*>/y], ['tag', /<\/?[A-Za-z][\w:.-]*/y], ['tag', /\/?>/y], ['attr', /[A-Za-z_:@#.][\w:.-]*(?=\s*=)/y], ['string', /"[^"]*"?/y], ['string', /'[^']*'?/y], ['variable', /&[#\w]+;/y]],
    keywords: words(''),
    plainWords: true,
  },
  md: {
    rules: [['keyword', /^#{1,6} [^\n]*/my], ['string', /^```[\s\S]*?(?:^```|$(?![\s\S]))/my], ['string', /`[^`\n]+`/y], ['keyword', /\*\*[^*\n]+\*\*/y], ['type', /(?<![\w*])\*[^*\n]+\*(?!\*)/y], ['function', /!?\[[^\]\n]*\]\([^)\n]*\)/y], ['number', /^\s*(?:[-*+]|\d+\.)(?= )/my], ['comment', /^>[^\n]*/my], ['comment', /<!--[\s\S]*?(?:-->|$)/y]],
    keywords: words(''),
    plainWords: true,
  },
  py: {
    rules: [['comment', /#[^\n]*/y], ['string', /[rRbBuUfF]{0,2}"""[\s\S]*?(?:"""|$)/y], ['string', /[rRbBuUfF]{0,2}'''[\s\S]*?(?:'''|$)/y], ['string', /[rRbBuUfF]{0,2}"(?:\\.|[^"\\\n])*"?/y], ['string', /[rRbBuUfF]{0,2}'(?:\\.|[^'\\\n])*'?/y], ['meta', /@[\w.]+/y], ['number', NUMBER]],
    keywords: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls print'),
    types: true,
  },
  sh: {
    rules: [['comment', /(?<![\w$])#[^\n]*/y], ['string', /"(?:\\.|[^"\\])*"?/y], ['string', /'[^']*'?/y], ['variable', /\$(?:\{[^}\n]*\}?|[\w@#?$!*-])/y], ['number', /\b\d+\b/y], ['property', /^[A-Za-z_][\w]*(?==)/my], ['meta', /--?[A-Za-z][\w-]*/y]],
    keywords: words('if then else elif fi for while until do done case esac in function return local export source alias unset set shift exit break continue select readonly declare eval exec trap cd echo'),
  },
  yaml: {
    rules: [['comment', /#[^\n]*/y], ['property', /[\w.$/-]+(?=:(?:\s|$))/y], ['string', /"(?:\\.|[^"\\\n])*"?/y], ['string', /'[^'\n]*'?/y], ['meta', /[&*][\w-]+/y], ['number', /-?\b\d+(?:\.\d+)?\b/y], ['keyword', /^---$/my]],
    keywords: words('true false null yes no on off'),
    plainWords: true,
  },
  toml: {
    rules: [['comment', /[#;][^\n]*/y], ['type', /^\s*\[\[?[^\]\n]*\]\]?/my], ['property', /^\s*[\w.-]+(?=\s*=)/my], ['string', /"""[\s\S]*?(?:"""|$)/y], ['string', /"(?:\\.|[^"\\\n])*"?/y], ['string', /'[^'\n]*'?/y], ['number', /-?\b\d[\d_:.-]*\b/y]],
    keywords: words('true false'),
    plainWords: true,
  },
  sql: {
    rules: [['comment', /--[^\n]*/y], ['comment', /\/\*[\s\S]*?(?:\*\/|$)/y], ['string', /'(?:''|[^'])*'?/y], ['number', NUMBER]],
    keywords: words('select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer on group by order having limit offset as distinct union all null is in like between case when then else end returning default unique constraint'),
    caseless: true,
  },
};

// C-like languages share the JS rules with their own keywords.
const cLike = (keywords, extra = []) => ({ rules: [...extra, ...LANGS.js.rules.filter(([kind]) => kind !== 'meta')], keywords: words(keywords), types: true });
Object.assign(LANGS, {
  sol: cLike('pragma solidity contract interface library abstract function modifier event error emit struct enum mapping returns return public private internal external view pure payable constant immutable override virtual memory storage calldata if else for while do break continue new delete import using is require revert assert unchecked try catch constructor fallback receive address bool string bytes uint int uint8 uint16 uint32 uint64 uint128 uint256 int256 bytes32 bytes4 msg block tx this super indexed anonymous assembly type'),
  rs: cLike('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while i8 i16 i32 i64 u8 u16 u32 u64 usize isize f32 f64 bool char str String Vec Option Result Some Ok Err', [['meta', /#!?\[[^\]\n]*\]/y], ['function', /\b[a-z_]\w*!/y]]),
  go: cLike('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var string int int64 int32 uint uint64 float64 bool byte rune error any'),
  c: cLike('auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual override new delete using bool true false nullptr', [['meta', /#\s*\w+/y]]),
  java: cLike('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while var val fun when object companion data sealed open override internal lateinit suspend'),
  swift: cLike('associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is throw throws try async await self Self some any'),
});

const EXTENSIONS = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'html', svelte: 'html', astro: 'html',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', plist: 'html',
  md: 'md', mdx: 'md', markdown: 'md',
  py: 'py', pyi: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', env: 'sh',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'toml', cfg: 'toml', conf: 'toml',
  sql: 'sql',
  sol: 'sol', rs: 'rs', go: 'go', c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', m: 'c', java: 'java', kt: 'java', kts: 'java', scala: 'java', swift: 'swift', cs: 'java', dart: 'java', php: 'java',
};
const NAMES = { Dockerfile: 'sh', Makefile: 'sh', '.gitignore': 'sh', '.npmrc': 'toml', '.editorconfig': 'toml', '.zshrc': 'sh', '.bashrc': 'sh' };

// The language of a file name, or '' for plain text.
export function languageOf(name) {
  if (NAMES[name]) return NAMES[name];
  if (/^\.env(\.|$)/.test(name)) return 'sh';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return EXTENSIONS[ext] ?? '';
}

const LABELS = { js: 'JavaScript', json: 'JSON', css: 'CSS', html: 'HTML', md: 'Markdown', py: 'Python', sh: 'Shell', yaml: 'YAML', toml: 'TOML', sql: 'SQL', sol: 'Solidity', rs: 'Rust', go: 'Go', c: 'C', java: 'Java', swift: 'Swift' };
export const languageLabel = (lang, name = '') => (lang === 'js' && /\.(ts|tsx|mts|cts)$/.test(name) ? 'TypeScript' : LABELS[lang] ?? 'Plain text');

function tokens(text, lang) {
  const def = LANGS[lang];
  const out = [];
  const push = (cls, value) => {
    const last = out.at(-1);
    if (last && last[0] === cls) last[1] += value;
    else out.push([cls, value]);
  };
  const word = def.word ?? WORD;
  let i = 0;
  while (i < text.length) {
    // Spaces inside a line can start no token; rules anchored at a line start still see its indent.
    if ((text[i] === ' ' || text[i] === '\t') && i && text[i - 1] !== '\n') {
      let end = i + 1;
      while (text[end] === ' ' || text[end] === '\t') end++;
      push('', text.slice(i, end));
      i = end;
      continue;
    }
    let matched = false;
    for (const [cls, re] of def.rules) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m[0]) {
        push(cls, m[0]);
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    word.lastIndex = i;
    const w = word.exec(text);
    if (w) {
      const value = w[0];
      const key = def.caseless ? value.toLowerCase() : value;
      let cls = '';
      if (!def.plainWords || def.keywords.size) {
        if (def.keywords.has(key)) cls = 'keyword';
        else if (LITERALS.has(value)) cls = 'literal';
        else if (!def.plainWords && /^\s*\(/.test(text.slice(i + value.length, i + value.length + 3))) cls = 'function';
        else if (def.types && /^[A-Z][a-z]/.test(value)) cls = 'type';
      }
      push(cls, value);
      i += value.length;
      continue;
    }
    push('', text[i]);
    i++;
  }
  return out;
}

// Files past this size are shown without colours: the reader stays quick.
const COLOR_MAX = 300_000;

export function highlight(text, lang) {
  const runs = lang && LANGS[lang] && text.length <= COLOR_MAX ? tokens(text, lang) : [['', text]];
  const lines = [[]];
  for (const [cls, value] of runs) {
    const parts = value.split('\n');
    parts.forEach((part, n) => {
      if (n) lines.push([]);
      if (part) lines.at(-1).push([cls, part]);
    });
  }
  return lines;
}
