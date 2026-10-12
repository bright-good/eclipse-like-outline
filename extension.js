// アウトライン (Eclipse)
// ファイルのシンボルを、右側の独自のビュー「アウトライン (Eclipse)」に表示する。
// 中身は VS Code 標準のアウトラインと同じところ（vscode.executeDocumentSymbolProvider）から受け取り、
// 操作・挙動は VS Code 標準のアウトラインに合わせる。Java の中身は redhat.java（jdt.ls）が返す。
'use strict';

const vscode = require('vscode');
const path = require('path');

const VIEW_ID = 'eclipseLikeOutline';
const SELECT_COMMAND = 'eclipseLikeOutline.select'; // 行を押したときのコマンド（package.json には載せない）
const OPEN_COMMAND = 'eclipseLikeOutline.open'; // VS Code がビューごとに作る「ビューを開く」コマンド
const OPENED_KEY = 'openedOnFirstStart'; // 導入して最初の起動でビューを開いたか（拡張機能ごとの記録 globalState に残す）

// VS Code 標準のアウトラインと同じ文言（日本語の言語パックの outlinePane より）
const MESSAGES = {
  loading: (name) => `'${name}' のドキュメント シンボルを読み込んでいます...`,
  noEditor: 'アクティブなエディターはアウトライン情報を提供できません。',
  noSymbols: (name) => `ドキュメント '${name}' にシンボルが見つかりません`,
};

// VS Code 標準のアウトラインに合わせた待ち時間（ミリ秒）
const LOADING_DELAY = 100; // これより遅いときだけ「読み込んでいます」を出す
const EDIT_DELAY = 350; // 入力が止まってから取り直すまで
// シンボルが返ってから、セマンティックトークン（Java の修飾子）を待つ時間（0.2.0版）。ふだんは同時に返る（数ms）。
// ウィンドウの再読み込みの直後など、jdt.ls が忙しいときは、トークンだけが0.4〜1.4秒遅れる（2026-10-12 に確かめた）。
// VS Code 標準のアウトラインは、シンボルが返るとすぐ行を出すので、それより長くは待たずに行を出し、トークンはあとで入れる
const TOKENS_WAIT = 100;

// 「シンボルが見つかりません」を出している間に問い合わせ直す間隔（ミリ秒）。
// VS Code 標準のアウトラインは、中身を返す拡張機能が増えたとき（JavaScript の機能が起動したときなど）に取り直すが、
// 拡張機能にはその知らせが来ないため。ファイルの中身も、中身を返す拡張機能も変わっていなければ、
// VS Code は前と同じ結果を返すので、問い合わせ直しても VS Code 標準のアウトラインと違う結果にはならない。
// Java の行のアイコン（修飾子）とフィールドの型が取れないときも、同じ間隔で、取れていないものだけを問い合わせ直す（0.2.0版）
const RETRY_DELAY = 500; // 取れなくなってから30秒の間
const RETRY_SLOW_DELAY = 5000; // それより後
const RETRY_FAST_PERIOD = 30000;

// VS Code は、拡張機能のツリーの「中身が変わった」「メッセージが変わった」の知らせを、
// しばらく知らせがなかったあとの最初の1つはすぐ反映し、そのあと0.2秒以内に続いたものはまとめて、最後の知らせの0.2秒後に反映する
// （拡張機能ホストの debounce）。メッセージと行を両方替えるときに、片方だけが0.2秒遅れないように、この長さを使って出し方を選ぶ
const VSCODE_DEBOUNCE = 200;

// 種類の名前（vscode.SymbolKind の順。日本語の言語パックの vs/editor/common/languages より）。
// VS Code 標準のアウトラインは、行の読み上げ用の名前とツールチップを「名前 (種類)」の形にしている
const KIND_NAMES = [
  'ファイル', 'モジュール', '名前空間', 'パッケージ', 'クラス', 'メソッド', 'プロパティ', 'フィールド',
  'コンストラクター', '列挙型', 'インターフェイス', '関数', '変数', '定数', '文字列', '数値',
  'ブール値', '配列', 'オブジェクト', 'キー', 'NULL', '列挙型メンバー', '構造体', 'イベント',
  '演算子', '型パラメーター',
];

// 種類ごとの VS Code 標準のアイコン（vscode.SymbolKind の順）。Java 以外のシンボルの行と、修飾子を受け取れなかったときに使う
const KIND_ICONS = [
  ['file', 'file'], ['module', 'module'], ['namespace', 'namespace'], ['package', 'package'],
  ['class', 'class'], ['method', 'method'], ['property', 'property'], ['field', 'field'],
  ['constructor', 'constructor'], ['enum', 'enumerator'], ['interface', 'interface'], ['function', 'function'],
  ['variable', 'variable'], ['constant', 'constant'], ['string', 'string'], ['number', 'number'],
  ['boolean', 'boolean'], ['array', 'array'], ['object', 'object'], ['key', 'key'],
  ['null', 'null'], ['enum-member', 'enumeratorMember'], ['struct', 'struct'], ['event', 'event'],
  ['operator', 'operator'], ['type-parameter', 'typeParameter'],
].map(([icon, color]) => new vscode.ThemeIcon('symbol-' + icon, new vscode.ThemeColor(`symbolIcon.${color}Foreground`)));

// --- シンボル ---

// VS Code が返すシンボル（vscode.DocumentSymbol）を、ビューで使う形に直す。
// 名前が空のものや、名前の位置が範囲の外のものは、VS Code が拡張機能から受け取るときに捨てているので、ここでは調べない。
function toSymbols(list, parent) {
  const seen = new Map();
  return (list || []).map((x) => {
    // 同じ名前の兄弟（匿名クラスなど）があっても id が重ならないよう、出てきた順の番号を付ける
    const n = seen.get(x.name) || 0;
    seen.set(x.name, n + 1);
    const sym = {
      id: (parent ? parent.id + '/' : '') + x.name + (n ? '#' + n : ''),
      name: x.name,
      detail: x.detail || '',
      kind: x.kind,
      range: x.range,
      selectionRange: x.selectionRange,
      parent,
      children: [],
    };
    sym.children = toSymbols(x.children, sym);
    return sym;
  });
}

// --- Java のアイコンの決め方（0.2.0版） ---
// Eclipse のアウトラインと同じ規則（Eclipse の JavaElementImageProvider と JdtFlags）で、行のアイコンの部品を決める。
// 修飾子は jdt.ls のセマンティックトークンから受け取り、jdt.ls が返さない synchronized・transient・volatile・default はソースから見る。

const SK = vscode.SymbolKind;
const TYPE_KINDS = [SK.Class, SK.Interface, SK.Enum];

// 宣言のトークンの種類と、それを付けてよいシンボルの種類（コンストラクターのトークンは、型の種類 class か enum で返る）。
// jdt.ls は、本体のある enum の定数の下に挟む `{...}`（種類は Enum）に、定数と同じ位置を返すので、種類で見分ける
const TOKEN_KINDS = {
  class: [SK.Class, SK.Constructor], interface: [SK.Interface], decorator: [SK.Interface], enum: [SK.Enum, SK.Constructor],
  enumMember: [SK.EnumMember], property: [SK.Field, SK.Constant], method: [SK.Method], annotationMember: [SK.Method],
};

// セマンティックトークン（5つずつの数の並び）から、宣言のトークンだけを「行:桁」ごとに取り出す
function declarations(legend, tokens) {
  const map = new Map();
  const data = tokens.data;
  let line = 0;
  let ch = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    line += data[i];
    ch = data[i] === 0 ? ch + data[i + 1] : data[i + 1];
    const mods = new Set(legend.tokenModifiers.filter((_, k) => data[i + 4] & (1 << k)));
    if (mods.has('declaration')) map.set(line + ':' + ch, { type: legend.tokenTypes[data[i + 3]], mods });
  }
  return map;
}

// コメント・文字列と文字のリテラル・アノテーション（括弧の中身ごと）を空白に置き換える
function stripCode(text) {
  const s = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, ' ');
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '@') {
      out += s[i++];
      continue;
    }
    // @ の後ろの名前と、括弧があれば括弧の中身まで
    i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    while (i < s.length && /[\p{L}\p{N}_$.]/u.test(s[i])) i++;
    let j = i;
    while (j < s.length && /\s/.test(s[j])) j++;
    if (s[j] === '(') {
      for (let depth = 0, k = j; k < s.length; k++) {
        if (s[k] === '(') depth++;
        else if (s[k] === ')' && --depth === 0) { i = k + 1; break; }
      }
    }
    out += ' ';
  }
  return out;
}

// 単語として含まれるか（大文字と小文字を区別する。日本語の名前の一部は単語に数えない）
const hasWord = (text, word) => new RegExp(`(?<![\\p{L}\\p{N}_$])${word}(?![\\p{L}\\p{N}_$])`, 'u').test(text);

// いちばん近い外側の型のシンボル
function declaringType(sym) {
  let p = sym.parent;
  while (p && !TYPE_KINDS.includes(p.kind)) p = p.parent;
  return p;
}

// 型の種類（class・interface・enum・annotation）。匿名クラスと、jdt.ls が enum の定数の下に挟む `{...}` は class
function typeName(sym) {
  if (!sym) return null;
  if (!sym.token && sym.name.endsWith('{...}')) return 'class';
  if (sym.kind === SK.Interface) return sym.token && sym.token.type === 'decorator' ? 'annotation' : 'interface';
  return sym.kind === SK.Enum ? 'enum' : 'class';
}

const visibility = (mods) => ['public', 'protected', 'private'].find((v) => mods.has(v)) || null;

// main メソッドとみなすもの（対象は Java 11版）：public static void main(String[])
const isMain = (s) => s.kind === SK.Method && /^main\(String(\[\]|\.\.\.)\)$/.test(s.name) && s.detail === ' : void'
  && s.mods.has('public') && s.mods.has('static');

// 行のアイコンの部品を決める。Java のシンボルでなければ null（VS Code 標準のアイコンを使う）。doc はシンボルのファイル（vscode.TextDocument）。
// base：土台（package・class・interface・enum・annotation・method・field）。vis：メソッドとフィールドの可視性。
// corner：型アイコンの右下に付ける可視性。tr・br：右上・右下に重ねる修飾子アイコン（右から置く順）。deprecated：非推奨の斜線
function javaIcon(sym, doc) {
  const mods = sym.mods;
  const decl = declaringType(sym);
  const declName = typeName(decl);
  const inInterface = declName === 'interface' || declName === 'annotation';
  // 範囲の先頭から名前の直前まで（修飾子が書かれるところ）と、名前の後ろから範囲の終わりまで
  const head = () => stripCode(doc.getText(new vscode.Range(sym.range.start, sym.selectionRange.start)));
  const tail = () => stripCode(doc.getText(new vscode.Range(sym.selectionRange.end, sym.range.end)));
  const icon = { base: null, vis: null, corner: null, tr: [], br: [], deprecated: mods.has('deprecated') };
  if (sym.kind === SK.Package) {
    icon.base = 'package';
  } else if (TYPE_KINDS.includes(sym.kind)) {
    icon.base = typeName(sym);
    const vis = visibility(mods);
    if (!sym.parent) icon.corner = vis ? null : 'package';
    else icon.corner = vis === 'public' || inInterface ? null : vis || 'package';
    if (icon.base === 'class' && mods.has('abstract')) icon.tr.push('abstract');
    if (icon.base === 'class' && mods.has('readonly')) icon.tr.push('final');
    if (mods.has('static')) icon.tr.push('static');
    if (sym.children.some(isMain)) icon.br.push('run');
  } else if (sym.kind === SK.Method || sym.kind === SK.Constructor) {
    icon.base = 'method';
    icon.vis = visibility(mods) || (sym.kind === SK.Constructor && declName === 'enum' ? 'private' : inInterface ? 'public' : 'package');
    const words = head();
    if (mods.has('abstract')) icon.tr.push('abstract');
    if (sym.kind === SK.Constructor) icon.tr.push('constructor');
    if (mods.has('readonly')) icon.tr.push('final');
    if (mods.has('static')) icon.tr.push('static');
    if (mods.has('native')) icon.tr.push('native');
    // default メソッドと、既定値のあるアノテーションの要素（既定値は、引数の括弧より後ろに書かれる）
    const annotationDefault = declName === 'annotation' && hasWord(tail().replace(/^[^)]*\)/, ''), 'default');
    if ((declName === 'interface' && hasWord(words, 'default')) || annotationDefault) icon.tr.push('default');
    if (hasWord(words, 'synchronized')) icon.br.push('synchronized');
  } else if (sym.kind === SK.Field || sym.kind === SK.Constant || sym.kind === SK.EnumMember) {
    icon.base = 'field';
    const constant = inInterface || sym.kind === SK.EnumMember;
    icon.vis = constant ? 'public' : visibility(mods) || 'package';
    const words = head();
    if (mods.has('readonly') || constant) icon.tr.push('final');
    if (hasWord(words, 'volatile')) icon.tr.push('volatile');
    if (mods.has('static') || constant) icon.tr.push('static');
    if (hasWord(words, 'transient')) icon.br.push('transient');
  } else {
    return null;
  }
  return icon;
}

// promise が ms 以内に返れば、その結果を返す。返らなければ null を返す（promise は、そのあとも待てる）
function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
}

// セマンティックトークンの凡例とトークンを問い合わせる。失敗したら [] を返す
function semanticTokens(uri) {
  const ask = (id) => vscode.commands.executeCommand(id, uri);
  return Promise.all([ask('vscode.provideDocumentSemanticTokensLegend'), ask('vscode.provideDocumentSemanticTokens')]).catch(() => []);
}

// セマンティックトークンから修飾子を受け取れたら、シンボルに行のアイコンの部品を付けて true を返す。
// jdt.ls の準備が終わる前は、トークンが返らないか、空で返る（宣言のトークンが1つもない）。そのときは何も付けずに false を返す
// （修飾子なしとしてアイコンを決めると、間違ったアイコンになるため）。パッケージ宣言の行しかないファイルは、修飾子が要らないので true
function applyJavaIcons(roots, legend, tokens, doc) {
  const decls = legend && tokens ? declarations(legend, tokens) : new Map();
  if (decls.size === 0 && roots.some((sym) => sym.kind !== SK.Package)) return false;
  addJavaIcons(roots, decls, doc);
  return true;
}

// シンボルに、宣言のトークン（修飾子）と、行のアイコンの部品を付ける
function addJavaIcons(roots, decls, doc) {
  const walk = (list) => list.forEach((sym) => {
    const t = decls.get(sym.selectionRange.start.line + ':' + sym.selectionRange.start.character);
    sym.token = t && TOKEN_KINDS[t.type] && TOKEN_KINDS[t.type].includes(sym.kind) ? t : null;
    sym.mods = sym.token ? sym.token.mods : new Set();
    walk(sym.children);
  });
  const icons = (list) => list.forEach((sym) => {
    sym.icon = javaIcon(sym, doc);
    icons(sym.children);
  });
  walk(roots);
  icons(roots); // main メソッドを見るために、子の修飾子を付け終えてから決める
}

// --- Java のアイコンの図（0.2.0版） ---
// Eclipse のアイコンの形と色を真似て描いた SVG（Eclipse の画像は、ライセンスの都合で使わない）。
// 座標は16×16の画素。1倍の画面でにじまないよう、1pxの線は画素の中心（.5）に置く。
// Eclipse はアイコンを幅22pxで描くが、VS Code のツリーは幅16pxまでなので、ユーザーが選んだ案C（2026-10-11）で収める：
// メソッドとフィールドの図は Eclipse の位置から3px左へ寄せ、型の図とパッケージ宣言の図は12pxの大きさ（Eclipse の0.75倍）で描く。
// Eclipse は、修飾子アイコンの下、型アイコンの右下の可視性の縁、フィールドの図の中を白で塗る。ダーク テーマで白く浮くので、
// 白で塗らずに、その形で図を切り抜いて背景を透かす（2026-10-11 にユーザーが決めた。ライト テーマでは Eclipse と同じに見える）。
// 白い四角がないと、濃い色の文字や図がダーク テーマの背景に沈むので、ダーク テーマ用の図では色を明るくする（DARK_COLORS）

// 上から下へのグラデーション。id は1つの SVG の中で重ならない名前にする
const gradient = (id, top, bottom) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`;

// メソッドとフィールドの図（可視性アイコン）：[描く図, 切り抜く形]。public は丸、protected はひし形、package は三角、private は四角。
// フィールドは、同じ形を小さくして中を抜く
const MEMBER_SHAPES = {
  method: {
    public: [gradient('m', '#a9cf8f', '#3c8c4c') + '<circle cx="5" cy="9" r="3.5" fill="url(#m)" stroke="#11834a"/>', ''],
    protected: [gradient('m', '#fff0b4', '#f3c457') + '<path d="M5 5.4 8.6 9 5 12.6 1.4 9Z" fill="url(#m)" stroke="#bf9b2b"/>', ''],
    package: [gradient('m', '#5d93c8', '#1f5f9e') + '<path d="M5 6.6 9.3 12.5H.7Z" fill="url(#m)" stroke="#1f63a2" stroke-linejoin="round"/>', ''],
    private: [gradient('m', '#f9a0a0', '#ec5a60') + '<rect x="2.5" y="6.5" width="6" height="6" fill="url(#m)" stroke="#c92a36"/>', ''],
  },
  field: {
    public: ['<circle cx="5" cy="8" r="2.5" fill="#7cbc80" stroke="#118a4c"/>', '<circle cx="5" cy="8" r="1"/>'],
    protected: ['<path d="M5.5 5.4 8.6 8.5 5.5 11.6 2.4 8.5Z" fill="#f2cd68" stroke="#bf9b2b"/>', '<path d="M5.5 7.3 6.7 8.5 5.5 9.7 4.3 8.5Z"/>'],
    package: ['<path d="M5.5 5.6 8.6 10.5H2.4Z" fill="#3a78b4" stroke="#2468a6" stroke-linejoin="round"/>', '<path d="M5.5 7.6v2M4.5 8.6h2" stroke="#000"/>'],
    private: ['<rect x="3.5" y="6.5" width="4" height="4" fill="#e85f66" stroke="#cd333d"/>', '<path d="M5.5 7v3M4 8.5h3" stroke="#000"/>'],
  },
};

// 型アイコン（12pxの大きさ）。クラスは緑の丸に C、インターフェイスは紫の丸に I、enum は茶の丸に E、アノテーション型は青い @
const typeCircle = (top, bottom, edge, letter) => gradient('t', top, bottom)
  + `<circle cx="5.5" cy="7" r="4.5" fill="url(#t)" stroke="${edge}"/><path d="${letter}" fill="none" stroke="#fff" stroke-width="1.3"/>`;
const TYPE_SHAPES = {
  class: typeCircle('#a3d27f', '#3c8c46', '#1d7a40', 'M7.4 5.3A2.3 2.3 0 1 0 7.4 8.7'),
  interface: typeCircle('#ab9fd6', '#5e4ca6', '#5b47a0', 'M5.5 4.6v4.8M4.3 4.6h2.4M4.3 9.4h2.4'),
  enum: typeCircle('#d0ab82', '#8f5d2c', '#8a5a27', 'M7.3 4.6H4.7v4.8h2.6M4.7 7h2.2'),
  annotation: '<path d="M8.4 10.6A4.4 4.4 0 1 1 9.9 7v.8c0 1.1-.6 1.6-1.3 1.6S7.4 8.9 7.4 7.8V4.8" fill="none" stroke="#2a6aa3" stroke-width="1.1"/><circle cx="5.6" cy="7" r="1.8" fill="none" stroke="#2a6aa3" stroke-width="1.1"/>',
};

// 型アイコンの右下に付ける可視性：[描く図, 切り抜く縁]。縁で丸を切り抜いて、丸と分ける（縁の外側は、画素の境目にそろえる）
const corner = (shape, fill, edge) => [`<${shape} fill="${fill}" stroke="${edge}" stroke-linejoin="round"/>`, `<${shape} stroke="#000" stroke-width="3" stroke-linejoin="round"/>`];
const TYPE_CORNERS = {
  protected: corner('path d="M8.7 7.6 11.4 10.3 8.7 13 6 10.3Z"', '#f2cd68', '#bf9b2b'),
  private: corner('rect x="6.5" y="8.5" width="5" height="5"', '#ef6f75', '#c92a36'),
  package: corner('path d="M8.5 8.4 11.6 13.5H5.4Z"', '#3a78b4', '#1f63a2'),
};

// パッケージ宣言の図（12pxの大きさ）。オリーブ色の箱に、十字のひも
const PACKAGE_SHAPE = '<rect x="1.5" y="3.5" width="9" height="9" fill="#cfcfa6" stroke="#7e7e5e"/><path d="M6 2.5v11M.5 8h11" stroke="#5f5f42"/>';

// 非推奨の斜線。土台の図の後ろに、左下から右上へ引く。メソッドとフィールドは3px左へ寄せた図に、型は12pxの図に合わせる
const deprecatedLine = (d) => `<path d="${d}" stroke="#d4d2d5" stroke-width="2.6"/><path d="${d}" stroke="#aba3a9" stroke-width="1.2"/>`;
const DEPRECATED = { member: deprecatedLine('M-2 15.5 12.5 1'), type: deprecatedLine('M.5 13.5 11.5 2') };

// 修飾子アイコン：[幅, 高さ, 切り抜く四角, 図]。図は左上を0,0として描く。
// 下の図は、Eclipse が白い四角を置くところで切り抜く。文字は、1倍の画面でにじまないよう、画素の中心を通る直線と、角を落とした斜めの線で描く
const overlay = (w, h, box, body) => [w, h, `<rect ${box}/>`, body];
const letter = (w, h, box, d, color) => overlay(w, h, box, `<path d="${d}" fill="none" stroke="${color}"/>`);
const OVERLAYS = {
  abstract: letter(7, 8, 'width="7" height="8"', 'M1 7.6 3.5.7 6 7.6M2.2 4.5h2.6', '#208142'),
  constructor: letter(7, 8, 'x="1" width="5" height="7"', 'M5.5 1.5 4.5.5h-2l-1 1v4l1 1h2l1-1M2.5 1.5v4', '#3aa655'),
  final: letter(7, 7, 'x="1" width="6" height="7"', 'M1.5 7V.5h4M1.5 3.5h3', '#286296'),
  volatile: letter(7, 7, 'width="7" height="7"', 'M1 .3 3.5 6.6 6 .3', '#c7022d'),
  static: letter(7, 7, 'x="1" width="6" height="7"', 'M5.5 1.5 4.5.5h-2l-1 1v1l1 1h2l1 1v1l-1 1h-2l-1-1', '#d12e51'),
  native: letter(7, 7, 'x="1" width="6" height="7"', 'M1.5 7V.6l4 5.8V0', '#286296'),
  default: letter(7, 7, 'x="1" width="6" height="7"', 'M1.5.5v6h3l1-1v-4l-1-1Z', '#894c1f'),
  transient: letter(7, 8, 'width="7" height="8"', 'M1 1.5h5M3.5 1.5V8', '#7562b6'),
  synchronized: overlay(7, 8, 'width="7" height="8"', '<circle cx="3.5" cy="4" r="3" fill="#e6f1fb" stroke="#1c64a4"/><path d="M3.5 2v2.5h1.5" fill="none" stroke="#1c3f73"/>'),
  run: overlay(7, 8, 'y="1" width="7" height="7"', gradient('r', '#9bd394', '#2f8f4f') + '<path d="M1.5 1.5 6 4.5 1.5 7.5Z" fill="url(#r)" stroke="#1e7048" stroke-linejoin="round"/>'),
};

// ダーク テーマ用の図で替える色（ライト テーマ用の色 → ダーク テーマ用の色）。ここにない色は、ダーク テーマ用でも同じ。
// 白い四角をなくしたので、濃い色の文字や図が暗い背景に沈まないよう、明るくする（2026-10-11）
const DARK_COLORS = {
  '#208142': '#4cc47a', // abstract の A
  '#3aa655': '#5fd27d', // コンストラクターの C
  '#286296': '#6aa7e6', // final の F、native の N
  '#c7022d': '#ff5c7a', // volatile の V
  '#d12e51': '#ff6b8b', // static の S
  '#894c1f': '#d09060', // default の D
  '#7562b6': '#a898ea', // transient の T
  '#e6f1fb': '#1d3a5a', '#1c64a4': '#6aa7e6', '#1c3f73': '#d6e8fa', // synchronized の時計（文字盤・縁・針）
  '#2a6aa3': '#5d9ee0', // アノテーション型の @
  '#5d93c8': '#8cc0f2', '#1f5f9e': '#4a8ad0', '#1f63a2': '#7ab4ec', // package の三角（メソッドの図の塗りと縁、型アイコンの右下の縁）
  '#3a78b4': '#5d9ee0', '#2468a6': '#7ab4ec', // package の三角（フィールドの図と、型アイコンの右下の塗り）
};

// mask の黒いところで、図を切り抜く
const cutOut = (id, cuts, body) => (cuts ? `<mask id="${id}"><rect width="16" height="16" fill="#fff"/>${cuts}</mask><g mask="url(#${id})">${body}</g>` : body);

// 行のアイコンの部品（javaIcon の結果）から SVG を作る。dark はダーク テーマ用の図か。
// 修飾子アイコンは、16pxの右端から左へ並べる。左端を越えるものは描かず、次のものを試す（Eclipse の JavaElementImageDescriptor と同じ）
function iconSvg(icon, dark = false) {
  const member = icon.base === 'method' || icon.base === 'field';
  const [shape, holes] = member ? MEMBER_SHAPES[icon.base][icon.vis] : [icon.base === 'package' ? PACKAGE_SHAPE : TYPE_SHAPES[icon.base], ''];
  const [mark, rim] = !member && icon.corner ? TYPE_CORNERS[icon.corner] : ['', ''];
  // 土台（非推奨の斜線を含む）は、フィールドの図の中と、右下の可視性の縁で切り抜く
  const base = cutOut('h', holes + rim, (icon.deprecated ? DEPRECATED[member ? 'member' : 'type'] : '') + shape) + mark;
  let boxes = '';
  let overlays = '';
  for (const [names, top] of [[icon.tr, true], [icon.br, false]]) {
    let right = 16;
    for (const name of names) {
      const [w, h, box, svg] = OVERLAYS[name];
      if (right - w < 0) continue;
      right -= w;
      const at = `translate(${right} ${top ? 0 : 16 - h})`;
      boxes += `<g transform="${at}">${box}</g>`;
      overlays += `<g transform="${at}">${svg}</g>`;
    }
  }
  // 修飾子アイコンの下は、右下の可視性も含めて切り抜く
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${cutOut('k', boxes, base)}${overlays}</svg>`;
  return dark ? svg.replace(/#[0-9a-f]{6}/g, (color) => DARK_COLORS[color] || color) : svg;
}

// 行の iconPath に渡す、ライト テーマ用とダーク テーマ用の図の組（VS Code は、ハイ コントラストのテーマでも、暗い背景ならダーク用を使う）。
// 同じ部品のアイコンは、1つの組を使い回す
const iconUris = new Map();
const svgUri = (svg) => vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
function iconUri(icon) {
  const key = JSON.stringify(icon);
  if (!iconUris.has(key)) iconUris.set(key, { light: svgUri(iconSvg(icon)), dark: svgUri(iconSvg(icon, true)) });
  return iconUris.get(key);
}

// --- フィールドの型（0.2.0版） ---
// Eclipse のアウトラインは、フィールドの名前の後ろに「 : 型」を付ける（enum の定数には付けない）。
// 型は jdt.ls のホバー（vscode.executeHoverProvider）から取る。ホバーの最初のコードブロックが「型 名前」の形で、
// 定数のときは「型 名前 = 値」になる。型は、パッケージ名を付けない名前（List<String> など）で返る（Eclipse と同じ書き方）
const FIELD_KINDS = [SK.Field, SK.Constant];

// フィールドと定数のシンボル（enum の定数を除く。型を出すもの）
function fieldsOf(roots) {
  const out = [];
  const walk = (list) => list.forEach((sym) => {
    if (FIELD_KINDS.includes(sym.kind)) out.push(sym);
    walk(sym.children);
  });
  walk(roots);
  return out;
}

function fieldType(hovers, name) {
  const decl = new RegExp(`^(.+?) ${name.replace(/[$]/g, '\\$&')}(?: = .*)?$`);
  for (const hover of hovers || []) {
    for (const c of hover.contents) {
      const code = /```java\n(.*)\n```/.exec(typeof c === 'string' ? c : c.value);
      const m = code && decl.exec(code[1]);
      if (m) return m[1];
    }
  }
  return null;
}

// --- ビューの中身 ---

class OutlineProvider {
  constructor() {
    this.roots = [];
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  // silent を true にすると、VS Code に知らせずに入れ替える（Outline.showTree の、メッセージからツリーへの切り替えで使う）
  setRoots(roots, silent = false) {
    this.roots = roots;
    if (!silent) this.changed.fire();
  }

  getChildren(sym) {
    return sym ? sym.children : this.roots;
  }

  getParent(sym) {
    return sym.parent;
  }

  getTreeItem(sym) {
    const state = sym.children.length
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(sym.name, state);
    item.id = sym.id;
    item.description = sym.detail;
    // Java のシンボルは Eclipse 風のアイコン、それ以外は VS Code 標準のアイコン
    item.iconPath = sym.icon ? iconUri(sym.icon) : KIND_ICONS[sym.kind];
    const label = `${sym.name} (${KIND_NAMES[sym.kind]})`;
    item.tooltip = label;
    item.accessibilityInformation = { label };
    // コマンドのある行は、VS Code が開閉の矢印を押したときだけ開閉する（VS Code 標準のアウトラインと同じ）。
    // 押したときにその場所へ移る動きは0.3.0版で作るので、いまは何もしないコマンド
    item.command = { command: SELECT_COMMAND, title: '' };
    return item;
  }
}

// --- 追従と表示の切り替え ---

class Outline {
  constructor(view, provider) {
    this.view = view;
    this.provider = provider;
    this.uri = null; // 表示中のファイル
    this.showingTree = false;
    this.generation = 0; // 古い問い合わせの結果を捨てるための番号
    this.pending = false; // ビューが隠れている間に更新が必要になった
    this.editTimer = null;
    this.retryTimer = null;
    this.retryUri = null; // 取れないもの（シンボル、Java の修飾子とフィールドの型）を問い合わせ直しているファイル
    this.retrySince = 0; // そのファイルで問い合わせ直し始めた時刻
    this.disposed = false;
    this.changedAt = 0; // VS Code に最後に知らせた時刻
    this.fieldTypes = new Map(); // 表示中のファイルで取ったフィールドの型（行の id → 説明欄）
    this.rowIcons = new Map(); // 表示中のファイルで決めた行のアイコンの部品（行の id → 部品）
    this.rememberedUri = null; // fieldTypes と rowIcons のファイル
  }

  // 前の知らせから0.2秒より長くたっていて、次の知らせがすぐ反映されるか
  get quiet() {
    return Date.now() - this.changedAt > VSCODE_DEBOUNCE + 50;
  }

  // 拡張機能を止めるときに、待っている取り直しを取り消す
  dispose() {
    this.disposed = true;
    clearTimeout(this.editTimer);
    clearTimeout(this.retryTimer);
  }

  showMessage(text) {
    if (!this.showingTree && this.view.message === text) return; // 同じメッセージのまま
    if (this.showingTree) {
      // ツリーからメッセージへ：行を消す知らせとメッセージの知らせを同じまとまりに入れて、一度に替える
      // （別々に反映されると、0.2秒のあいだ真っ白になるか、古い行の上にメッセージが出る）
      if (this.quiet) this.view.message = undefined; // まとまりを始めるためだけの知らせ。見た目は変わらない
      this.provider.setRoots([]);
    }
    this.showingTree = false;
    this.view.message = text;
    this.changedAt = Date.now();
  }

  showTree(roots) {
    if (this.showingTree) {
      this.provider.setRoots(roots); // ツリーからツリーへ：行の知らせだけ
    } else if (this.quiet && this.view.visible) {
      // メッセージからツリーへ：メッセージを消す知らせはすぐ反映される。行は、VS Code に知らせずに入れ替えてから
      // 「行を見せる」（reveal）を頼む。VS Code はビューが空のとき、待たずにすぐ行を取り直すので、0.2秒遅れない
      this.view.message = undefined;
      this.provider.setRoots(roots, true);
      Promise.resolve(this.view.reveal(roots[0], { select: false, focus: false, expand: false })).catch(() => this.provider.changed.fire());
    } else {
      // 直前に知らせたばかり：両方を同じまとまりに入れて、一度に替える
      this.provider.setRoots(roots);
      this.view.message = undefined;
    }
    this.showingTree = true;
    this.changedAt = Date.now();
  }

  // VS Code 標準のアウトラインと同じく、エディター グループのアクティブなエディターだけを見る
  // （下のパネルの出力やターミナルにフォーカスが移っても替えない）。
  // テキストのエディターならそのファイル。比較エディターなどほかのエディターは null（VS Code 標準のアウトラインも、比較エディターではメッセージを出す）
  activeUri() {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab && tab.input instanceof vscode.TabInputText ? tab.input.uri : null;
  }

  // エディターが替わったときに呼ぶ。同じファイルのままなら何もしない
  onEditorChanged() {
    const uri = this.activeUri();
    if (String(uri) === String(this.uri)) return;
    this.refresh();
  }

  // 言語モードの切り替え（中身を返す拡張機能が替わる）。VS Code は、同じファイルを開き直したと知らせてくる
  onDocumentOpened(doc) {
    if (this.uri && doc.uri.toString() === this.uri.toString()) this.refresh();
  }

  // ビューが隠れている間に更新が必要になっていたら、見えたときに取り直す
  onVisibilityChanged() {
    if (this.view.visible && this.pending) this.refresh();
  }

  onDocumentChanged(e) {
    if (!this.uri || e.document.uri.toString() !== this.uri.toString()) return;
    if (e.contentChanges.length === 0) return;
    clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => this.refresh(), EDIT_DELAY);
  }

  // retrying は、問い合わせ直しのとき。「読み込んでいます」は出さない（VS Code 標準のアウトラインも出さない）
  async refresh(retrying = false) {
    clearTimeout(this.editTimer);
    clearTimeout(this.retryTimer);
    if (this.disposed) return;
    if (!this.view.visible) {
      this.pending = true;
      return;
    }
    this.pending = false;
    const generation = ++this.generation;
    const uri = this.activeUri();
    this.uri = uri;
    if (!uri) {
      this.retryUri = null;
      return this.showMessage(MESSAGES.noEditor);
    }

    const name = path.posix.basename(uri.path);
    // ビューにツリーが出ていないときだけ、遅ければ「読み込んでいます」を出す（VS Code 標準のアウトラインと同じ）
    const loading = this.showingTree || retrying
      ? null
      : setTimeout(() => {
        if (generation === this.generation) this.showMessage(MESSAGES.loading(name));
      }, LOADING_DELAY);

    // Java のファイルなら、シンボルと同時に、修飾子の入ったセマンティックトークンも問い合わせる（0.2.0版）
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const java = !!doc && doc.languageId === 'java';
    const tokensQuery = java ? semanticTokens(uri) : null;

    // 中身を返す拡張機能がない、返せなかった、空だった、はどれも「シンボルが見つかりません」（VS Code 標準のアウトラインと同じ）
    let roots;
    try {
      roots = toSymbols(await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri), null);
    } catch (e) {
      console.error('[eclipse-like-outline]', e);
      roots = [];
    }
    clearTimeout(loading);
    if (generation !== this.generation || this.disposed) return;
    if (roots.length === 0) {
      this.showMessage(MESSAGES.noSymbols(name));
      return this.retryLater(uri);
    }
    this.retryUri = null;
    if (!java) return this.showTree(roots);

    // トークンは、シンボルが返ってから TOKENS_WAIT だけ待つ。間に合えば、アイコンを入れてから行を出す。
    // 間に合わないか、まだ取れない（jdt.ls の準備の途中）ときは、前に同じファイルで決めたアイコン（なければ VS Code 標準のアイコン）で
    // 行を出し、トークンが返ってから入れる
    const extra = await within(tokensQuery, TOKENS_WAIT);
    if (generation !== this.generation || this.disposed) return;
    this.remember(uri);
    const iconsReady = !!extra && this.applyIcons(roots, extra, doc);
    if (!iconsReady) this.applyRememberedIcons(roots);
    this.applyFieldTypes(roots);
    this.showTree(roots);
    await this.fillJava(roots, uri, doc, generation, iconsReady, fieldsOf(roots), extra ? null : tokensQuery);
  }

  // 表示中のファイルが替わったら、前のファイルで覚えたフィールドの型とアイコンを捨てる
  remember(uri) {
    if (this.rememberedUri === String(uri)) return;
    this.rememberedUri = String(uri);
    this.fieldTypes = new Map();
    this.rowIcons = new Map();
  }

  // セマンティックトークン（[凡例, トークン]）から修飾子を受け取れたら、行のアイコンの部品を付けて覚えておき、true を返す
  applyIcons(roots, [legend, tokens], doc) {
    if (!applyJavaIcons(roots, legend, tokens, doc)) return false;
    const walk = (list) => list.forEach((sym) => {
      this.rowIcons.set(sym.id, sym.icon);
      walk(sym.children);
    });
    walk(roots);
    return true;
  }

  // 行を出したあとで返ったトークンから、アイコンを入れて VS Code に知らせる。入れられたら true
  applyIconsLater(roots, extra, doc, generation) {
    if (generation !== this.generation || this.disposed || !this.applyIcons(roots, extra, doc)) return false;
    this.provider.changed.fire(); // 全部の行のアイコンが替わる
    this.changedAt = Date.now();
    return true;
  }

  // トークンがまだないとき、前に同じファイルで決めたアイコンを先に入れる（編集のたびにアイコンが替わって見えないように）
  applyRememberedIcons(roots) {
    const walk = (list) => list.forEach((sym) => {
      if (this.rowIcons.has(sym.id)) sym.icon = this.rowIcons.get(sym.id);
      walk(sym.children);
    });
    walk(roots);
  }

  // Java のファイルの行に、フィールドの型を埋める。修飾子（アイコン）かフィールドの型が取れなかったときは、間をおいて、
  // 取れていないものだけを問い合わせ直す。jdt.ls の準備が終わる前に開いたファイルでは、シンボルは先に返るが、
  // セマンティックトークンとホバーはしばらく空で返り、返るようになっても拡張機能には知らせが来ないため（2026-10-12 に確かめた）
  // lateTokens は、待たずに行を出したときの、まだ返っていないトークンの問い合わせ。返るのを、型の問い合わせと並べて待つ
  async fillJava(roots, uri, doc, generation, iconsReady, fields, lateTokens = null) {
    const [missing, ready] = await Promise.all([
      this.fillFieldTypes(fields, uri, generation),
      lateTokens ? lateTokens.then((extra) => this.applyIconsLater(roots, extra, doc, generation)) : iconsReady,
    ]);
    if (generation !== this.generation || this.disposed || (ready && missing.length === 0)) return;
    this.retryTimer = setTimeout(async () => {
      let ok = ready;
      if (!ok) {
        const extra = await semanticTokens(uri);
        if (generation !== this.generation || this.disposed) return;
        ok = this.applyIconsLater(roots, extra, doc, generation);
      }
      await this.fillJava(roots, uri, doc, generation, ok, missing);
    }, this.retryDelay(uri));
  }

  // フィールドの行の説明欄に、前に同じファイルで取った型を先に入れる（編集のたびに型が消えて見えないように）
  applyFieldTypes(roots) {
    const walk = (list) => list.forEach((sym) => {
      if (FIELD_KINDS.includes(sym.kind) && this.fieldTypes.has(sym.id)) sym.detail = this.fieldTypes.get(sym.id);
      walk(sym.children);
    });
    walk(roots);
  }

  // フィールドの型をホバーで問い合わせて、説明欄に「 : 型」を埋める。行は型を待たずに出し、取れた型を後から埋める。
  // 問い合わせは全部のフィールドで同時に行う（フィールド500個で約0.4秒）。返らなかったフィールドは、説明欄をそのままにする。
  // 型が取れなかったフィールドを返す
  async fillFieldTypes(fields, uri, generation) {
    const types = await Promise.all(fields.map((sym) => vscode.commands.executeCommand('vscode.executeHoverProvider', uri, sym.selectionRange.start)
      .then((hovers) => fieldType(hovers, sym.name), () => null)));
    if (generation !== this.generation || this.disposed) return [];
    const changed = [];
    const missing = fields.filter((sym, i) => !types[i]);
    fields.forEach((sym, i) => {
      if (!types[i]) return;
      const detail = ' : ' + types[i];
      this.fieldTypes.set(sym.id, detail);
      if (sym.detail !== detail) {
        sym.detail = detail;
        changed.push(sym);
      }
    });
    if (changed.length > 0) {
      this.provider.changed.fire(changed); // 変わった行だけを VS Code に知らせる
      this.changedAt = Date.now();
    }
    return missing;
  }

  // 「シンボルが見つかりません」の間、間をおいて取り直す
  retryLater(uri) {
    this.retryTimer = setTimeout(() => this.refresh(true), this.retryDelay(uri));
  }

  // 問い合わせ直すまでの間隔。同じファイルで問い合わせ直し始めてから30秒たったら、5秒おきに減らす
  retryDelay(uri) {
    const now = Date.now();
    if (this.retryUri !== String(uri)) {
      this.retryUri = String(uri);
      this.retrySince = now;
    }
    return now - this.retrySince < RETRY_FAST_PERIOD ? RETRY_DELAY : RETRY_SLOW_DELAY;
  }
}

function activate(context) {
  const provider = new OutlineProvider();
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider });
  const outline = new Outline(view, provider);

  context.subscriptions.push(
    view,
    outline,
    vscode.commands.registerCommand(SELECT_COMMAND, () => {}),
    vscode.window.tabGroups.onDidChangeTabGroups(() => outline.onEditorChanged()),
    vscode.window.tabGroups.onDidChangeTabs(() => outline.onEditorChanged()),
    vscode.workspace.onDidChangeTextDocument((e) => outline.onDocumentChanged(e)),
    vscode.workspace.onDidOpenTextDocument((d) => outline.onDocumentOpened(d)),
    view.onDidChangeVisibility(() => outline.onVisibilityChanged()),
  );

  outline.refresh();
  openOnFirstStart(context);
}

// 導入して最初の起動のときだけ、ビューを開く（フォーカスはエディターのまま）。
// 右側のサイド バーにアウトライン (Eclipse) しかないとき（チャットを止めているときなど）、導入して最初の起動では、
// VS Code が見出しだけ出して、中にチャットの空の画面を開いたままにするので、真っ白になる。
// 一度ビューを開けば、次の起動からは VS Code が覚えていて、中身が出る。開けなかったときは、次の起動でもう一度試す
async function openOnFirstStart(context) {
  if (context.globalState.get(OPENED_KEY)) return;
  try {
    await vscode.commands.executeCommand(OPEN_COMMAND, { preserveFocus: true });
    await context.globalState.update(OPENED_KEY, true);
  } catch {
    // 記録しないので、次の起動でもう一度試す
  }
}

function deactivate() {}

// activate と deactivate のほかは、ユニットテスト（公開しないファイル）から呼ぶために出している
module.exports = { activate, deactivate, toSymbols, declarations, stripCode, javaIcon, addJavaIcons, iconSvg, iconUri, fieldType, OutlineProvider, Outline, MESSAGES, KIND_NAMES, LOADING_DELAY, EDIT_DELAY, TOKENS_WAIT, RETRY_DELAY, RETRY_SLOW_DELAY, RETRY_FAST_PERIOD };
