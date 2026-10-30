// アウトライン (Eclipse)
// ファイルのシンボルを、右側の独自のビュー「アウトライン (Eclipse)」に表示する。
// 中身は VS Code 標準のアウトラインと同じところ（vscode.executeDocumentSymbolProvider が中で呼ぶ、VS Code の内部のコマンド）から受け取り、
// 操作・挙動は VS Code 標準のアウトラインに合わせる。Java の中身は redhat.java（jdt.ls）が返す。
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const VIEW_ID = 'eclipseLikeOutline';
const SELECT_COMMAND = 'eclipseLikeOutline.select'; // 行を押したときのコマンド（package.json には載せない）
const SELECT_BY_KEY_COMMAND = 'eclipseLikeOutline.selectByKey'; // Enter（Mac では ⌘+↓ も）のコマンド。package.json のキー割り当てから呼ぶ
const OPEN_COMMAND = 'eclipseLikeOutline.open'; // VS Code がビューごとに作る「ビューを開く」コマンド
// ビューの見出しの、すべて折りたたむボタンとすべて展開ボタンのコマンド（0.3.0版）
const COLLAPSE_ALL_COMMAND = 'eclipseLikeOutline.collapseAll';
const EXPAND_ALL_COMMAND = 'eclipseLikeOutline.expandAll';
// どちらのボタンを出すかの値（package.json のメニューの when が読む。0.3.0版）
const ALL_COLLAPSED_CONTEXT = 'eclipseLikeOutline.allCollapsed';
const OPENED_KEY = 'openedOnFirstStart'; // 導入して最初の起動でビューを開いたか（拡張機能ごとの記録 globalState に残す）
const VIEW_STATE_KEY = 'viewState'; // 「…」メニューで選んだ状態（ワークスペースごとの記録 workspaceState に残す。0.3.0版）

// VS Code 標準のアウトラインと同じ文言（日本語の言語パックの outlinePane より）
const MESSAGES = {
  loading: (name) => `'${name}' のドキュメント シンボルを読み込んでいます...`,
  noEditor: 'アクティブなエディターはアウトライン情報を提供できません。',
  noSymbols: (name) => `ドキュメント '${name}' にシンボルが見つかりません`,
};

// VS Code 標準のアウトラインに合わせた待ち時間（ミリ秒）
const LOADING_DELAY = 100; // これより遅いときだけ「読み込んでいます」を出す
// 入力が止まってから取り直すまでの、いちばん短い待ち時間。0.3.0版からは、VS Code 標準のアウトラインと同じく、ファイルごとに、
// 中身を問い合わせるのにかかった時間の平均で延びる（EditDelay。チケット29）
const EDIT_DELAY = 350;
const EDIT_DELAY_MAX = EDIT_DELAY ** 2; // いちばん長い待ち時間
const EDIT_DELAY_DEFAULT = EDIT_DELAY * 1.5; // まだどのファイルも測っていないときと、開発用の起動のときの待ち時間
const EDIT_DELAY_SAMPLES = 6; // 平均をとる回数（直近の回数）
const EDIT_DELAY_FILES = 50; // 時間を覚えるファイルの数。超えたら、古いほうから捨てて、7割にする
// 編集で取り直したとき、シンボルの数の割合（文字数あたり）が急に変わったら、出すまで待つ時間と、待つファイルの行数（0.3.0版のチケット29）
const JUMP_WAIT = 2000;
const JUMP_MIN_LINES = 25;
const OPEN_DELAY = 150; // 行を押してから、エディターのその場所へ移るまで（0.3.0版。2回続けて押したときは待たない）
// 同じ行のコマンドがこの間に続けて呼ばれたら、2回続けて押したとみなす（macOS と Windows のダブルクリックの間隔の既定。0.3.0版）
const DOUBLE_CLICK_TIME = 500;
// Enter のコマンドが VS Code の list.select を実行し終えてから、行のコマンドが届くのを待つ時間（0.3.0版）
const KEY_WAIT = 100;
const FOLLOW_DELAY = 150; // カーソルに追従：カーソルが止まってから、その場所の行を選ぶまで（0.3.0版）
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

// 開閉状態を覚えておくファイルの数（0.3.0版。VS Code 標準のアウトラインと同じ）
const OPEN_STATES_SIZE = 10;

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

// 種類ごとに行を出すか隠すかの設定の名前（vscode.SymbolKind の順。VS Code 1.140.0版の本体のプログラムにある表と同じ。0.3.0版）
const SHOW_SETTINGS = [
  'showFiles', 'showModules', 'showNamespaces', 'showPackages', 'showClasses', 'showMethods', 'showProperties', 'showFields',
  'showConstructors', 'showEnums', 'showInterfaces', 'showFunctions', 'showVariables', 'showConstants', 'showStrings', 'showNumbers',
  'showBooleans', 'showArrays', 'showObjects', 'showKeys', 'showNull', 'showEnumMembers', 'showStructs', 'showEvents',
  'showOperators', 'showTypeParameters',
];

// --- シンボル ---

// シンボルの一覧を問い合わせる VS Code の内部のコマンド（0.3.0版のチケット26）。vscode.executeDocumentSymbolProvider は、このコマンドを呼び、
// 結果を拡張機能の形に直すときに、シンボルの tags（非推奨の印）を落とす（VS Code 1.140.0版の本体のプログラムで読んだ）。
// VS Code 標準のアウトラインは、非推奨のシンボルの行の強調を消すので、このコマンドを直接呼んで tags を受け取る
const SYMBOLS_COMMAND = '_executeDocumentSymbolProvider';

// 内部のコマンドが返すシンボル（位置は1から数える）を、vscode.executeDocumentSymbolProvider が返す形に直す。
// 直し方は vscode.executeDocumentSymbolProvider と同じ（知らない種類の番号はプロパティにする）で、tags を足す
function fromInternal(list) {
  const range = (r) => new vscode.Range(r.startLineNumber - 1, r.startColumn - 1, r.endLineNumber - 1, r.endColumn - 1);
  return (list || []).map((x) => ({
    name: x.name,
    detail: x.detail,
    kind: x.kind in KIND_NAMES ? x.kind : vscode.SymbolKind.Property,
    tags: x.tags,
    range: range(x.range),
    selectionRange: range(x.selectionRange),
    children: fromInternal(x.children),
  }));
}

// VS Code が返すシンボル（vscode.DocumentSymbol）を、ビューで使う形に直す。uri はシンボルのファイルの場所。
// 名前が空のものや、名前の位置が範囲の外のものは、VS Code が拡張機能から受け取るときに捨てているので、ここでは調べない。
// 行の id は「ファイルの場所|Outer/run()」の形。ファイルの場所は0.3.0版で入れた（中身が同じ別のファイルの行と、開閉状態を分けるため）
function toSymbols(list, parent, uri = parent && parent.uri) {
  const seen = new Map();
  const out = (list || []).map((x) => {
    // 同じ名前の兄弟（匿名クラスなど）があっても id が重ならないよう、出てきた順の番号を付ける
    const n = seen.get(x.name) || 0;
    seen.set(x.name, n + 1);
    const sym = {
      id: (parent ? parent.id + '/' : uri + '|') + x.name + (n ? '#' + n : ''),
      name: x.name,
      detail: x.detail || '',
      kind: x.kind,
      deprecated: !!(x.tags && x.tags.includes(vscode.SymbolTag.Deprecated)),
      range: x.range,
      selectionRange: x.selectionRange,
      uri,
      parent,
      children: [],
    };
    sym.children = toSymbols(x.children, sym);
    return sym;
  });
  // 範囲が同じ、前の兄弟の行の数（int a = x1, b = x2; の b は1）。行の場所を分けるのに使う（0.4.0版のチケット30）
  const same = new Map();
  out.forEach((sym) => {
    const r = sym.range;
    const key = `${r.start.line},${r.start.character},${r.end.line},${r.end.character}`;
    sym.dup = same.get(key) || 0;
    same.set(key, sym.dup + 1);
  });
  return out;
}

// カーソルの位置 pos を含む、いちばん内側のシンボル（なければ null。0.3.0版）。VS Code 標準のアウトラインと同じく、範囲の端も含め、
// 範囲を含む兄弟が2つ以上あるとき（int a, b; の a と b は範囲が同じ）は先のものにする。設定で隠した行も探す
function symbolAt(list, pos) {
  const sym = list.find((s) => s.range.start.isBeforeOrEqual(pos) && pos.isBeforeOrEqual(s.range.end));
  return sym ? symbolAt(sym.children, pos) || sym : null;
}

// --- 種類ごとに行を出すか隠すか（0.3.0版） ---
// VS Code 標準のアウトラインは、設定 outline.show〇〇 の値を、そのままツリーの絞り込みの結果にする（1.140.0版の本体のプログラムで読んだ）。
// ツリーは、true と 1 の行を出し、2 の行は子の行が1つでも出るときだけ出し、ほかの値（false、0、文字列、null など）の行は出さない。
// { visibility: 値 } の形なら、その値で決める。隠した行の子の行は、種類に関係なく出ない
const SHOW = 1;
const SHOW_IF_CHILD = 2;

// 設定の値を、SHOW・SHOW_IF_CHILD・0（隠す）に読み替える
function showValue(value) {
  const v = value && value.visibility !== undefined ? value.visibility : value;
  return v === true || v === SHOW ? SHOW : v === SHOW_IF_CHILD ? SHOW_IF_CHILD : 0;
}

// scope（ファイルか、ファイルの場所）の言語の設定を読んで、行ごとに隠すか（sym.hidden）を決める。前と替わった行があれば true を返す
function applyShowSettings(roots, scope) {
  const config = vscode.workspace.getConfiguration('outline', scope);
  const values = SHOW_SETTINGS.map((name) => showValue(config.get(name, true)));
  let changed = false;
  // 子の行から先に決める（SHOW_IF_CHILD の行は、子の行が出るかで決まる）。出る行が1つでもあれば true を返す
  const walk = (list) => list.reduce((shown, sym) => {
    const childShown = walk(sym.children);
    const hidden = !(values[sym.kind] === SHOW || (values[sym.kind] === SHOW_IF_CHILD && childShown));
    if (sym.hidden !== hidden) changed = true;
    sym.hidden = hidden;
    return shown || !hidden;
  }, false);
  walk(roots);
  return changed;
}

// 出す行（設定で隠した行を除く）
const shownRows = (list) => list.filter((sym) => !sym.hidden);

// --- 並べ替え（0.3.0版のチケット27） ---
// VS Code 標準のアウトラインと同じ比べ方で、同じ親の下の行を並べる（1.140.0版の本体のプログラムで読んだ）。
// 位置：範囲の始まりの位置の順（同じなら範囲の終わりの位置の順）、同じなら名前の順。名前：名前の順、同じなら範囲の順。
// カテゴリ：種類の番号（vscode.SymbolKind）の順、同じなら名前の順。名前は、数の部分を数として比べる（x2 が x10 より前）

// 名前を比べる仕組み。VS Code の画面の部分は、言語を指定せずに作るので、表示の言語の決まりで比べることになる。拡張機能が動く部分の
// 既定の言語は、表示の言語と同じとは限らないので、表示の言語を渡す。読めない言語なら、VS Code と同じく、言語を指定せずに作り直す
function nameCollator() {
  try {
    return new Intl.Collator(vscode.env.language, { numeric: true });
  } catch {
    return new Intl.Collator(undefined, { numeric: true });
  }
}

// 範囲を、始まりの位置、次に終わりの位置で比べる（VS Code の Range.compareRangesUsingStarts と同じ）
const compareRanges = (a, b) => a.start.line - b.start.line || a.start.character - b.start.character
  || a.end.line - b.end.line || a.end.character - b.end.character;

// 並べ方 sortBy（位置 'position'、名前 'name'、カテゴリ 'kind'）で、2つの行を比べる関数
function rowComparator(sortBy) {
  const collator = nameCollator();
  const byName = (a, b) => collator.compare(a.name, b.name);
  if (sortBy === 'name') return (a, b) => byName(a, b) || compareRanges(a.range, b.range);
  if (sortBy === 'kind') return (a, b) => a.kind - b.kind || byName(a, b);
  return (a, b) => compareRanges(a.range, b.range) || byName(a, b);
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
// オーバーライドアイコン・実装アイコンの三角と、切り抜く形（三角と、まわりと下の白いふち）。synchronized とまとめた図の、左上の小さな時計（0.5.0版）
const OVERRIDE_TRIANGLE = 'M3 1h1l3 3v1H0V4Z';
const OVERRIDE_CUT = '<path d="M3 0h1l3 3v3H0V3Z"/>';
const SMALL_CLOCK = '<circle cx="2.5" cy="2.5" r="2" fill="#e6f1fb" stroke="#1c64a4"/><path d="M2 2h1v1H2z" fill="#1c3f73"/>';
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
  // オーバーライドアイコン・実装アイコン（0.5.0版のチケット35。2026-10-30 にユーザーが画像を見て了承した）。Eclipse の over_co・implm_co・
  // sync_over・sync_impl を画素ごとに読んで描いたもの。三角は、Eclipse の1倍の画像と同じく、1行下がるごとに左右に1画素ずつ広がる形で、
  // 斜めの辺が画素の半分を通るので、1倍の画面で Eclipse と同じ画素が薄い紫になる。Eclipse が白で塗るところ（三角のまわりと下の白いふち、
  // 実装アイコンの三角の中、synchronized とまとめた図の白い四角）は、白で塗らずに切り抜く
  override: [7, 8, OVERRIDE_CUT, `<path d="${OVERRIDE_TRIANGLE}" fill="#4e39a2"/><path d="M3.5 2 5 4H2Z" fill="#7fc563"/>`],
  implement: [7, 8, OVERRIDE_CUT, `<path d="${OVERRIDE_TRIANGLE}M3.5 2 5 4H2Z" fill="#6247b5" fill-rule="evenodd"/>`],
  syncOverride: [7, 8, '<rect width="7" height="8"/>', SMALL_CLOCK + '<path d="M4 5h1l2 2v1H1Z" fill="#159443"/>'],
  syncImplement: [7, 8, '<rect width="7" height="8"/>', SMALL_CLOCK + '<path d="M4 5h1l2 2v1H1ZM4 6.2 4.6 7H3.4Z" fill="#4f32a8" fill-rule="evenodd"/>'],
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
  '#1365a5': '#6aa7e6', // 情報のエラー・警告アイコンの i（0.4.0版）
  '#4e39a2': '#a594f2', '#4f32a8': '#a594f2', '#6247b5': '#b3a5f5', // オーバーライドアイコン・実装アイコンの紫の縁（0.5.0版）
};

// エラー・警告アイコン（0.4.0版のチケット33）：[描く図, 下の図を切り抜く形]。Eclipse の error_co（赤い四角に白い ×）・warning_co（黄色い三角に !）・
// info_co（青い i）を、1画素ずつ写したもの（7×8）。Eclipse が白で塗るところ（警告の三角のまわり、情報の i の後ろ）は、白で塗らずに切り抜く。
// エラーの白い × は図そのものなので白のまま（2026-10-27 にユーザーが、画像を見て決めた）
const PROBLEM_OVERLAYS = {
  error: ['<rect width="7" height="8" fill="#d8424f"/><path d="M1 2h2v1H1zM4 2h2v1H4zM1 5h2v1H1zM4 5h2v1H4z" fill="#fff"/><path d="M2 3h3v2H2z" fill="#f6d3d6"/>', '<rect width="7" height="8"/>'],
  warning: ['<path d="M2.5 .5h2l2 6.5v.5H.5V7Z" fill="#f8d880" stroke="#c7862f" stroke-linejoin="round"/><path d="M3.5 2v4" stroke="#502800"/>', '<path d="M2 -1h3l3 7v2H-1v-2Z"/>'],
  info: ['<path d="M3 1h1v1H3zM2 3h2v4h1v1H2V7h1V4H2Z" fill="#1365a5"/>', '<path d="M2 0h3v1h1v7H1V1h1Z"/>'],
};

// mask の黒いところで、図を切り抜く
const cutOut = (id, cuts, body) => (cuts ? `<mask id="${id}"><rect width="16" height="16" fill="#fff"/>${cuts}</mask><g mask="url(#${id})">${body}</g>` : body);

// 行のアイコンの部品（javaIcon の結果）から SVG を作る。dark はダーク テーマ用の図か。
// 修飾子アイコンは、16pxの右端から左へ並べる。左端を越えるものは描かず、次のものを試す（Eclipse の JavaElementImageDescriptor と同じ）。
// problem（0.4.0版）があれば、エラー・警告アイコンを、Eclipse と同じく左下（x=0、y=8）に重ねる。そのとき、メソッドとフィールドの図は、
// Eclipse と同じ位置（3px 右）に戻す（重なり方を Eclipse と同じにするため。2026-10-27 にユーザーが案C を選んだ）
function iconSvg(icon, dark = false) {
  const member = icon.base === 'method' || icon.base === 'field';
  const [shape, holes] = member ? MEMBER_SHAPES[icon.base][icon.vis] : [icon.base === 'package' ? PACKAGE_SHAPE : TYPE_SHAPES[icon.base], ''];
  const [mark, rim] = !member && icon.corner ? TYPE_CORNERS[icon.corner] : ['', ''];
  // 土台（非推奨の斜線を含む）は、フィールドの図の中と、右下の可視性の縁で切り抜く
  let base = cutOut('h', holes + rim, (icon.deprecated ? DEPRECATED[member ? 'member' : 'type'] : '') + shape) + mark;
  let boxes = '';
  let overlays = '';
  if (icon.problem) {
    const [draw, cut] = PROBLEM_OVERLAYS[icon.problem];
    if (member) base = `<g transform="translate(3 0)">${base}</g>`;
    boxes += `<g transform="translate(0 8)">${cut}</g>`;
    overlays += `<g transform="translate(0 8)">${draw}</g>`;
  }
  // オーバーライド・実装（0.5.0版）は、Eclipse と同じく右下の角（右端）に置く。synchronized のメソッドでは、時計とまとめた図にする
  const sync = icon.br.includes('synchronized');
  const br = !icon.override ? icon.br
    : [sync ? (icon.override === 'override' ? 'syncOverride' : 'syncImplement') : icon.override, ...icon.br.filter((x) => x !== 'synchronized')];
  for (const [names, top] of [[icon.tr, true], [br, false]]) {
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

// --- オーバーライド（0.5.0版のチケット34） ---
// Eclipse のアウトラインは、親の型のメソッドを書き換えているメソッドの行に、親のメソッドが abstract なら実装アイコン、そうでなければ
// オーバーライドアイコンを重ねる（Eclipse の OverrideIndicatorLabelDecorator。コンストラクター・private・static には付けない。@Override の有無は見ない）。
// 親のメソッドは、Language Support for Java by Red Hat がメソッドのホバーに足すリンク「Go to Super Implementation」から取る。リンクは、
// jdt.ls が Eclipse と同じ部品（MethodOverrideTester.findOverriddenMethod）で探したもの。jdt.ls は、インターフェイスの中のメソッドでは探さず、
// 匿名クラスのメソッドにもリンクを付けないことがある（条件は分からない）ので、そのときだけ、型の階層の問い合わせで自前で探す
// （2026-10-29 にプロトタイプで確かめた。リンクと自前の両方で取れた105個は、すべて同じ親だった）

const SUPER_LINK = 'command:java.action.navigateToSuperImplementation?';

// ホバーの中身から、親のメソッドへのリンクを読む。リンクの引数は [{ uri: ファイルの場所を base64 にしたもの, range }]、
// ツールチップは「Go to super method '型の名前.メソッドの名前'」（入れ子の型は $ でつなぐ）。
// { uri: ファイルの場所（文字）, range, type: 型の名前, method: メソッドの名前 } を返す。リンクがないか、壊れていれば null
function superLink(hovers) {
  for (const hover of hovers || []) {
    for (const c of hover.contents || []) {
      const s = typeof c === 'string' ? c : c.value;
      const i = s.indexOf(SUPER_LINK);
      if (i < 0) continue;
      let k = i + SUPER_LINK.length;
      while (k < s.length && s[k] !== ')' && s[k] !== ' ') k++;
      try {
        const [arg] = JSON.parse(decodeURIComponent(s.slice(i + SUPER_LINK.length, k)));
        const tip = /^ "Go to super method '(.*)\.([^.']+)'"/.exec(s.slice(k));
        const start = arg.range.start;
        if (typeof arg.uri !== 'string' || !Number.isInteger(start.line) || !Number.isInteger(start.character)) return null;
        return { uri: Buffer.from(arg.uri, 'base64').toString('utf8'), range: arg.range, type: tip ? tip[1] : null, method: tip ? tip[2] : null };
      } catch {
        return null;
      }
    }
  }
  return null;
}

// メソッドの宣言の文字：from（既定は名前の行の頭）から、名前の後ろの、括弧の外にある最初の { か ; まで（コメントと文字列の中は飛ばす）。
// 見つからなければ null。text は、ファイルの中身（何度も呼ぶときに、毎回作らないため）
function declText(doc, nameStart, from = new vscode.Position(nameStart.line, 0), text = doc.getText()) {
  const start = doc.offsetAt(from);
  let depth = 0;
  for (let i = doc.offsetAt(nameStart); i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
    } else if (depth === 0 && (c === '{' || c === ';')) {
      return text.slice(start, i + 1);
    }
  }
  return null;
}

// 親のメソッドが abstract か（Eclipse の JdtFlags.isAbstract と同じ意味）を、宣言の文字で決める。中身がなく、native でなければ abstract。
// インターフェイスの、何も書かないメソッドは中身がないので abstract、default・static・private のメソッドには中身がある。
// 逆コンパイルした中身（jdt.ls はセマンティックトークンを返さない）にも、ソースにも使える。宣言が見つからなければ null
const abstractByText = (decl) => (decl === null ? null : decl.endsWith(';') && !hasWord(stripCode(decl), 'native'));

// シンボルの名前「名前(A, B<C>) <U>」を、名前・引数の型（型引数と、包むパッケージを除いた名前。可変長引数は配列）・メソッドの型引数に分ける
function signature(symName) {
  const open = symName.indexOf('(');
  const close = symName.lastIndexOf(')');
  const split = (text) => {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of text) {
      if (ch === '<') depth++;
      if (ch === '>') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const erase = (t) => {
    let depth = 0;
    let out = '';
    for (const ch of t) {
      if (ch === '<') depth++;
      else if (ch === '>') depth--;
      else if (!depth) out += ch;
    }
    return out.replace(/\.\.\.$/, '[]').replace(/\s+/g, '').replace(/^.*\./, '');
  };
  const vars = /^\s*<(.*)>\s*$/.exec(symName.slice(close + 1));
  return { name: symName.slice(0, open), params: split(symName.slice(open + 1, close)).map(erase), typeVars: vars ? typeVars(vars[1]) : [] };
}

// 型引数の並び「T extends Comparable<T>, U」から、型引数の名前を取り出す
const typeVars = (text) => {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim().split(/\s+/)[0]).filter(Boolean);
};

// 2つのメソッドの名前と引数が同じか。親のメソッドの引数の型が、型引数（T など）なら、どの型とも同じとみなす（Eclipse は型引数を当てはめて
// 比べる。拡張機能から取れるのは、シンボルの名前に入った型の名前だけなので、2026-10-29 に Claude が決めた）
function sameSignature(ours, theirs, theirTypeVars) {
  if (ours.name !== theirs.name || ours.params.length !== theirs.params.length) return false;
  const vars = new Set([...theirTypeVars, ...theirs.typeVars]);
  return ours.params.every((p, i) => {
    const t = theirs.params[i];
    const base = t.replace(/(\[\])+$/, '');
    return t === p || (vars.has(base) && p.endsWith(t.slice(base.length)));
  });
}

// java.lang.Object の、書き換えられるメソッド（どれも abstract ではない）。匿名クラスの親がインターフェイスのとき、親のクラスは Object なので、
// 先にこれと比べる（Eclipse と同じく、親のクラスを先に探す）
const OBJECT_METHODS = ['equals(Object)', 'hashCode()', 'toString()', 'clone()', 'finalize()'];

// 1回の問い合わせの間、親の型のファイル（中身とシンボル）を使い回す
class ParentFiles {
  constructor() {
    this.files = new Map();
  }

  get(uri) {
    const key = String(uri);
    if (!this.files.has(key)) {
      this.files.set(key, (async () => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const symbols = (await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri)) || [];
        return { doc, symbols };
      })());
    }
    return this.files.get(key);
  }
}

// シンボルの中から、名前が name（型引数を除いて比べる）の型を、入れ子もたどって探す。path は、入れ子の型の名前の並び（外から）
function findType(symbols, path) {
  let list = symbols;
  let found = null;
  for (const name of path) {
    found = list.find((x) => TYPE_KINDS.includes(x.kind) && x.name.replace(/<.*$/, '') === name);
    if (!found) return null;
    list = found.children || [];
  }
  return found;
}

// 型の行の型引数：シンボルの名前（ワークスペースのファイルは「名前<T>」）か、宣言の文字の、名前の後ろ
// （クラスファイルのシンボルの名前には、型引数が入らない）から読む
function typeVarsOfType(doc, type) {
  const m = /<(.*)>$/.exec(type.name);
  if (m) return typeVars(m[1]);
  const after = doc.getText(new vscode.Range(type.selectionRange.end, type.selectionRange.end.translate(0, 200)));
  if (!after.startsWith('<')) return [];
  let depth = 0;
  for (let i = 0; i < after.length; i++) {
    if (after[i] === '<') depth++;
    if (after[i] === '>' && --depth === 0) return typeVars(after.slice(1, i));
  }
  return [];
}

// 型の行 type の中から、ours（signature の結果）と同じメソッドを探す。private・static のメソッドは数えない（Eclipse の
// MethodOverrideTester.findOverriddenMethodInType と同じ）。見つかれば、そのメソッドが abstract か（宣言が読めなければ false）、なければ null
function methodIn(doc, type, ours) {
  const vars = typeVarsOfType(doc, type);
  for (const m of type.children || []) {
    if (m.kind !== SK.Method || !sameSignature(ours, signature(m.name), vars)) continue;
    const head = stripCode(doc.getText(new vscode.Range(m.range.start, m.selectionRange.start)));
    if (hasWord(head, 'private') || hasWord(head, 'static')) continue;
    return !!abstractByText(declText(doc, m.selectionRange.start, m.range.start));
  }
  return null;
}

// リンクの先の親のメソッドが abstract か。ワークスペースのファイルは、リンクの位置の宣言の文字で見る。クラスファイル（jdt://）は、
// jdt.ls が逆コンパイルした中身で、リンクの位置がずれることがあるので、ツールチップの型の名前とシンボルで探し直す（2026-10-29 にプロトタイプで、
// AbstractList.get のリンクが入れ子のクラスの get を、Comparable.compareTo のリンクがファイルの先頭を指した）。決められなければ null
async function linkedParentAbstract(link, sym, files) {
  const uri = vscode.Uri.parse(link.uri);
  const { doc, symbols } = await files.get(uri);
  if (uri.scheme !== 'jdt') {
    const start = new vscode.Position(link.range.start.line, link.range.start.character);
    return abstractByText(declText(doc, start));
  }
  if (!link.type || !link.method) return null;
  const pkg = symbols.find((x) => x.kind === SK.Package);
  const name = pkg && link.type.startsWith(pkg.name + '.') ? link.type.slice(pkg.name.length + 1) : link.type.replace(/^.*\./, '');
  const type = findType(symbols, name.split('$'));
  if (!type) return null;
  const methods = (type.children || []).filter((m) => m.kind === SK.Method && m.name.startsWith(link.method + '('));
  const count = signature(sym.name).params.length;
  const m = methods.find((x) => signature(x.name).params.length === count) || methods[0];
  return m ? abstractByText(declText(doc, m.selectionRange.start, m.range.start)) : null;
}

// 型の階層の項目 item の型と、その親の型から、ours と同じメソッドを探す。Eclipse の MethodOverrideTester と同じく、
// 型のメソッド → 親のクラス → 親のインターフェイスの順に、いちばん近いものを取る。同じ型は2回調べない。
// 見つかれば abstract か、なければ null
async function findInType(item, ours, visited, files) {
  const key = `${item.uri}#${item.selectionRange.start.line}:${item.selectionRange.start.character}:${item.name}`;
  if (visited.has(key)) return null;
  visited.add(key);
  const { doc, symbols } = await files.get(item.uri);
  // 型の行は、位置で探す。クラスファイルの型は、型の階層が返す位置がファイルの先頭になるので、名前で探す
  let type = null;
  const at = (list) => list.forEach((x) => {
    if (!type && TYPE_KINDS.includes(x.kind) && x.selectionRange.start.isEqual(item.selectionRange.start)) type = x;
    at(x.children || []);
  });
  at(symbols);
  if (!type) {
    const byName = (list) => list.forEach((x) => {
      if (!type && TYPE_KINDS.includes(x.kind) && x.name.replace(/<.*$/, '') === item.name.replace(/<.*$/, '')) type = x;
      byName(x.children || []);
    });
    byName(symbols);
  }
  const found = type ? methodIn(doc, type, ours) : null;
  return found !== null ? found : findInSupertypes(item, ours, visited, files);
}

async function findInSupertypes(item, ours, visited, files) {
  const sup = (await vscode.commands.executeCommand('vscode.provideSupertypes', item)) || [];
  const order = [...sup.filter((x) => x.kind === SK.Class || x.kind === SK.Enum), ...sup.filter((x) => x.kind === SK.Interface)];
  for (const x of order) {
    const found = await findInType(x, ours, visited, files);
    if (found !== null) return found;
  }
  return null;
}

// 型の階層の問い合わせ（vscode.prepareTypeHierarchy・vscode.provideSupertypes）で、メソッド sym（宣言した型は type）の親のメソッドを探す。
// 見つかれば abstract か、なければ null
async function findInHierarchy(uri, sym, type, anonymous, files) {
  const ours = signature(sym.name);
  const items = (await vscode.commands.executeCommand('vscode.prepareTypeHierarchy', uri, type.selectionRange.start)) || [];
  if (!items.length) return null;
  const visited = new Set();
  if (!anonymous) return findInSupertypes(items[0], ours, visited, files);
  // 匿名クラスでは、型の階層は new の後ろに書いた型を返す。それがインターフェイスなら、親のクラスは Object なので、先に Object と比べる
  if (items[0].kind === SK.Interface && OBJECT_METHODS.some((m) => sameSignature(ours, signature(m), []))) return false;
  return findInType(items[0], ours, visited, files);
}

// メソッド sym のホバー hovers から、オーバーライドアイコン・実装アイコンのどちらを付けるかを決める：'override'・'implement'・null（付けない）
async function overrideKind(sym, uri, hovers, files) {
  const link = superLink(hovers);
  let parentAbstract = null;
  if (link) {
    parentAbstract = await linkedParentAbstract(link, sym, files);
  } else {
    // リンクがなく、宣言した型がインターフェイスか匿名クラスのときだけ、自前で探す（自前の比べ方は Eclipse より粗いので、範囲を狭くする）
    const type = declaringType(sym);
    const anonymous = !!type && /^new .*\{\.\.\.\}$/.test(type.name);
    if (type && (anonymous || typeName(type) === 'interface')) parentAbstract = await findInHierarchy(uri, sym, type, anonymous, files);
  }
  return parentAbstract === null ? null : parentAbstract ? 'implement' : 'override';
}

// オーバーライドを問い合わせるメソッド：Java のアイコンが決まったメソッドのうち、private・static でないもの（Eclipse が付けないものは問い合わせない）
function overrideTargets(roots) {
  const out = [];
  const walk = (list) => list.forEach((sym) => {
    if (sym.kind === SK.Method && sym.icon && !sym.mods.has('private') && !sym.mods.has('static')) out.push(sym);
    walk(sym.children);
  });
  walk(roots);
  return out;
}

// ほかの Java のファイルが変わってから、表示中のファイルのオーバーライドを問い合わせ直すまで（jdt.ls が変わったファイルを読み直すのを待つ）
const OVERRIDE_REQUERY_DELAY = 1000;

// ファイルの中身のうち、オーバーライドの決まりに関わるところ：パッケージ宣言と import の行、型の宣言（範囲の始まりから最初の { まで。
// extends・implements を含む）、メソッドの宣言（範囲の始まりから、中身の { か ; まで。修飾子・名前・引数・中身があるか）。コメント・文字列・
// アノテーションは除く。編集で取り直したとき、これが替わっていなければ、前に決めた結果をそのまま使い、問い合わせ直さない
// （メソッドの中身の編集では、オーバーライドかどうかは替わらない。問い合わせ直すと jdt.ls の仕事が増え、次の取り直しの行が遅れる。
// 2026-10-30 に E2E テストで、メソッド250個のファイルの取り直しが、問い合わせ直すと平均で約40ms 遅れると分かった）
function overrideFingerprint(roots, doc) {
  const text = doc.getText();
  const parts = text.split('\n').filter((l) => /^\s*(package|import)\s/.test(l)).map((l) => l.trim());
  const walk = (list) => list.forEach((sym) => {
    if (TYPE_KINDS.includes(sym.kind) || sym.kind === SK.Method) parts.push(stripCode(declText(doc, sym.selectionRange.start, sym.range.start, text) || sym.name));
    walk(sym.children);
  });
  walk(roots);
  return parts.join('\n');
}

// --- ビューの中身 ---

class OutlineProvider {
  constructor() {
    this.roots = [];
    // いちばん上の段の行を、並べた順に入れたもの（0.3.0版のチケット27）。行ごとの子の行の並びは sym.rows。
    // sym.children は VS Code が返した順のまま（カーソルを含むシンボルは、VS Code 標準のアウトラインと同じく、並べる前の順で探す）
    this.rows = [];
    this.compare = rowComparator('position');
    this.round = 0; // 行を作り直した回数（0.3.0版）。行の id を替えて、VS Code に、拡張機能が決めた開閉状態を使わせるときに増やす
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  // silent を true にすると、VS Code に知らせずに入れ替える（Outline.showTree の、メッセージからツリーへの切り替えで使う）
  setRoots(roots, silent = false) {
    this.roots = roots;
    this.sort();
    if (!silent) this.changed.fire();
  }

  // 並べ方を替える（0.3.0版のチケット27）。行を並べ直すのは、次に sort を呼んだとき
  setSortOrder(sortBy) {
    this.compare = rowComparator(sortBy);
  }

  // すべての段の行を並べる（0.3.0版のチケット27）。VS Code 標準のアウトラインのツリーは、行を取り直すたびに、VS Code が返した順
  // （sym.children の順）から並べ、並べ方を替えたときだけ、いま出している順から並べ直す（1.140.0版の本体のプログラムのツリーの
  // updateChildren と resort）。比べて同じになる行は、並べる前の順のまま（Array の sort は、同じになるものの順を替えない）。
  // fromShown を true にすると、いま出している順から並べる。並びが替わった段があれば true を返す
  sort(fromShown = false) {
    let changed = false;
    const walk = (list, shown = []) => {
      const rows = [...(fromShown ? shown : list)].sort(this.compare);
      if (rows.some((sym, i) => sym !== shown[i])) changed = true;
      rows.forEach((sym) => {
        sym.rows = walk(sym.children, sym.rows);
      });
      return rows;
    };
    this.rows = walk(this.roots, this.rows);
    return changed;
  }

  // 並べた順で返す。設定で隠した行は出さない（0.3.0版）
  getChildren(sym) {
    return shownRows(sym ? sym.rows : this.rows);
  }

  getParent(sym) {
    return sym.parent;
  }

  // 行の id。VS Code は id で同じ行と見なす。作り直したあとは、前と違う id にするため、頭に作り直した回数を付ける。
  // 子の行を出す行は、末尾に「/」を付ける。子の行を出していなかった行に子の行が出たとき（子ができたときと、設定で隠していた子の行を
  // 出したとき）、id が同じままだと、VS Code は前の「開閉なし」の行の続きとして折りたたんで出し、拡張機能が渡す開閉状態を使わない
  // （VS Code 標準のアウトラインは、最初の開閉状態か、隠す前の開閉状態で出す）。id を替えて、新しい行として出させる（0.3.0版）
  rowId(sym) {
    return (this.round ? this.round + '|' : '') + sym.id + (shownRows(sym.children).length ? '/' : '');
  }

  getTreeItem(sym) {
    // 子の行を出す行は、Outline が決めた開閉状態（sym.open）で出す。VS Code がこれを使うのは、知らない id の行を出すときだけで、
    // 前から出している行は、VS Code が持っている開閉状態のまま出す（0.3.0版）。
    // 子の行がすべて設定で隠れた行は、開閉なしにする。VS Code 標準のアウトラインは「開閉の矢印なし、aria-expanded は true」で出すが、
    // 拡張機能のツリーではこの組み合わせを作れないので、見た目のほうを合わせる（2026-10-16 に Claude が決めた）
    const children = shownRows(sym.children);
    const state = !children.length ? vscode.TreeItemCollapsibleState.None
      : sym.open === false ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
    // 非推奨のシンボルの行は、検索窓で一致した文字を強調しない（VS Code 標準のアウトラインと同じ。0.3.0版のチケット26）。
    // 名前に長さ0の強調を渡すと、VS Code は検索窓で一致した文字の代わりにそれを描き、何も強調しない（空の一覧は、VS Code が受け取るときに捨てる）
    const item = new vscode.TreeItem(sym.deprecated ? { label: sym.name, highlights: [[0, 0]] } : sym.name, state);
    item.id = this.rowId(sym);
    item.description = sym.detail;
    // Java のシンボルは Eclipse 風のアイコン、それ以外は VS Code 標準のアイコン
    item.iconPath = sym.icon ? iconUri(sym.icon) : KIND_ICONS[sym.kind];
    const label = `${sym.name} (${KIND_NAMES[sym.kind]})`;
    item.tooltip = label;
    item.accessibilityInformation = { label };
    // 行を押すと、エディターのその場所へ移る（Navigator）。コマンドのある行は、VS Code が開閉の矢印を押したときだけ開閉する
    // （VS Code 標準のアウトラインと同じ）
    item.command = { command: SELECT_COMMAND, title: '', arguments: [sym.uri, sym.selectionRange.start, sym.range, sym.id] };
    // 行をドラッグすると、VS Code がこの場所から、ドラッグの出来事に入れる中身（エディターで開く中身、ファイルの一覧など）を作る。
    // チャットとターミナルは、その中身を読む（0.3.0版）。エラー・警告の色とバッジ（ファイルの装飾）も、この場所に付く（0.4.0版）
    item.resourceUri = sym.place || rangeUri(sym);
    return item;
  }
}

// ファイルの場所に、シンボルの範囲（1から数えた「行,桁-行,桁」）を付けたもの。範囲の書き方は、VS Code 標準のアウトラインがドラッグで渡すものと同じ
function rangeUri(sym) {
  const r = sym.range;
  return sym.uri.with({ fragment: `${r.start.line + 1},${r.start.character + 1}-${r.end.line + 1},${r.end.character + 1}` });
}

// 行をドラッグするための仕組み（0.3.0版）。エディターに落としたとき、VS Code は、拡張機能が handleDrag で渡した
// text/uri-list だけを読んで開く。text/uri-list を dragMimeTypes に書くと、VS Code はドラッグの出来事の text/uri-list と
// ファイルの一覧（ResourceURLs）を空にするが、チャットとターミナルは、行の resourceUri から入るほかの中身を読むので困らない
const DRAG_AND_DROP = {
  dragMimeTypes: ['text/uri-list'],
  dropMimeTypes: [],
  handleDrag(rows, dataTransfer) {
    dataTransfer.set('text/uri-list', new vscode.DataTransferItem(rows.map((sym) => rangeUri(sym).toString()).join('\r\n')));
  },
};

// --- エラー・警告（0.4.0版のチケット30〜32） ---
// VS Code 標準のアウトラインと同じく、行ごとに、範囲と交わるエラー・警告（問題）を数え、名前の色とバッジ（件数か点）で出す。
// 拡張機能が行に色とバッジを付ける方法は、ファイルの装飾（FileDecoration）しかないので、行の場所（resourceUri）に付ける。
// 数える問題の位置は、VS Code 標準のアウトラインと同じく、エディターが持つ、編集に合わせて動く位置（1.140.0版の本体のプログラムの
// MarkerDecorationsService）。拡張機能には問題が出たときの位置しか届かないので、同じ決まりで動かした位置を持つ（ProblemPositions）

// VS Code の内部の問題の重さ（MarkerSeverity）。vscode.DiagnosticSeverity（エラー、警告、情報、ヒントの順に0〜3）から引く
const SEVERITY = { error: 8, warning: 4, info: 2, hint: 1 };
const MARKER_SEVERITY = [SEVERITY.error, SEVERITY.warning, SEVERITY.info, SEVERITY.hint];
const MARKER_TAKE = 500; // エディターが持つ問題の数（ファイルの問題の最初の500個）
const DECORATION_EVENT_SIZE = 250; // 装飾が替わった知らせ1回に入れられる場所の数（超えると、VS Code がフォルダーごとに1つに減らす）
const DECORATION_WAIT = 300; // 新しい場所の装飾を、VS Code が問い合わせてくるのを待つ、いちばん長い時間（ms）
const DECORATION_LIMIT = 10000; // VS Code に覚えさせる場所の数。超えたら、次に行を出すときに、全部捨てさせる
const PROBLEM_DOT = '●'; // 問題がすべて子の行にある行のバッジ（VS Code 標準のアウトラインの点の代わり。2026-10-27 にユーザーが決めた）

// --- 単語の決まり ---
// 範囲が空の問題は、VS Code がその位置の単語に広げる。単語の決まりは、言語の設定（language-configuration.json の wordPattern）にある。
// 拡張機能には、ほかの拡張機能の言語の設定が届かないので、拡張機能の package.json から探して読む

// VS Code の既定の単語の決まり（DEFAULT_WORD_REGEXP）
const DEFAULT_WORD = /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g;

// コメントと末尾のカンマを含む JSON（language-configuration.json の書き方）を読む
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
      // 末尾のカンマは読み飛ばす
    } else {
      out += c;
    }
  }
  return JSON.parse(out);
}

// 言語ごとの単語の決まり。VS Code と同じく、言語の設定を登録した順で、最後に wordPattern を書いたものを使う。
// g の付いていない決まりは、VS Code と同じく、g と i・m・u だけを付けて作り直す（ensureValidWordDefinition）
const wordPatterns = new Map();
function wordPattern(languageId) {
  if (wordPatterns.has(languageId)) return wordPatterns.get(languageId);
  let found = null;
  for (const ext of vscode.extensions.all) {
    const languages = (ext.packageJSON && ext.packageJSON.contributes && ext.packageJSON.contributes.languages) || [];
    for (const lang of languages) {
      if (lang.id !== languageId || typeof lang.configuration !== 'string') continue;
      try {
        const w = parseJsonc(fs.readFileSync(path.join(ext.extensionPath, lang.configuration), 'utf8')).wordPattern;
        if (typeof w === 'string') found = new RegExp(w);
        else if (w && typeof w.pattern === 'string') found = new RegExp(w.pattern, w.flags);
      } catch {
        // 読めない言語の設定と、正しくない wordPattern は使わない（VS Code も使わない）
      }
    }
  }
  const re = !found ? DEFAULT_WORD : found.global ? found : new RegExp(found.source, 'g' + ['i', 'm', 'u'].filter((f) => found.flags.includes(f)).join(''));
  wordPatterns.set(languageId, re);
  return re;
}

// 行 text の、0から数えた桁 column を含む単語の [始まり, 終わり]（なければ null）。VS Code の getWordAtText と同じく、
// 1000文字より長い行は、桁の前後500文字だけを見る
function wordAt(text, column, re) {
  let offset = 0;
  if (text.length > 1000) {
    offset = Math.max(0, column - 500);
    text = text.slice(offset, column + 500);
  }
  const pos = column - offset;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index <= pos && pos <= re.lastIndex) return [offset + m.index, offset + re.lastIndex];
    if (m.index > pos) return null;
    if (m[0].length === 0) re.lastIndex++;
  }
  return null;
}

// --- 問題の位置 ---

// 行の、最初と最後の空白でない文字の位置（空白はスペースとタブだけ。VS Code の firstNonWhitespaceIndex と lastNonWhitespaceIndex）
const firstNonBlank = (text) => text.search(/[^ \t]/);
function lastNonBlank(text) {
  let i = text.length - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  return i;
}

// 問題 d（vscode.Diagnostic）の範囲を、エディターが持つ範囲に直す（1.140.0版の MarkerDecorationsService の _createDecorationRange と同じ）。
// doc はそのときのファイル。ファイルの外はファイルの中に収める。範囲が空なら、単語の中ではその単語に広げる（行の終わりと空行ではそのまま）。
// 行全体の問題（桁の終わりが Number.MAX_VALUE）は、行の最初の空白でない文字から始める
function markerRange(doc, d) {
  const last = doc.lineCount - 1;
  const valid = (p) => (p.line > last ? new vscode.Position(last, doc.lineAt(last).text.length)
    : new vscode.Position(p.line, Math.min(p.character, doc.lineAt(p.line).text.length)));
  let start = valid(d.range.start);
  let end = valid(d.range.end);
  // ヒントは、始まりから2文字にする（不要なコードと非推奨の印が付いたものを除く）
  if (d.severity === vscode.DiagnosticSeverity.Hint && !(d.tags && d.tags.length)) end = valid(new vscode.Position(start.line, start.character + 2));
  const text = doc.lineAt(start.line).text;
  if (start.isEqual(end)) {
    const blankEnd = lastNonBlank(text) + 1 || text.length; // 最後の空白でない文字の後ろ（すべて空白なら行の終わり）
    if (text.length === 0 || end.character >= blankEnd) return new vscode.Range(start, end);
    const word = wordAt(text, start.character, wordPattern(doc.languageId));
    return word ? new vscode.Range(start.line, word[0], start.line, word[1]) : new vscode.Range(start, end);
  }
  if (d.range.start.character === 0 && d.range.end.character + 1 === Number.MAX_VALUE && start.line === end.line) {
    const first = firstNonBlank(text);
    if (first >= 0 && first < end.character) start = new vscode.Position(start.line, first);
  }
  return new vscode.Range(start, end);
}

// 範囲の端を、1回の書き換え（start〜end の文字を、inserted 文字に替える。位置はファイルの頭からの文字数）に合わせて動かす。
// 1.140.0版の本体のプログラムの intervalTree の nodeAcceptEdit で、stickiness が NeverGrowsWhenTypingAtEdges（問題の飾りの決まり）のときと同じ：
// 範囲の端に打った文字は範囲に入れない。範囲を含む文字を消すと、消した場所の1点になる
function acceptEdit(m, start, end, inserted) {
  // offset が check の位置で動かないか。stick は前の文字にくっつくか（範囲の終わりだけ）。how は 'stay'（動かない）か 'defined'（stick で決める）
  const stays = (offset, stick, check, how) => (offset < check ? true : offset > check ? false : how === 'stay' ? true : stick);
  const deleted = end - start;
  const common = Math.min(deleted, inserted);
  const s = m.start;
  const e = m.end;
  let sDone = false;
  let eDone = false;
  const first = deleted > 0 ? 'stay' : 'defined';
  if (stays(s, false, start, first)) sDone = true;
  if (stays(e, true, start, first)) eDone = true;
  if (common > 0) {
    const how = deleted > inserted ? 'stay' : 'defined';
    if (!sDone && stays(s, false, start + common, how)) sDone = true;
    if (!eDone && stays(e, true, start + common, how)) eDone = true;
  }
  if (!sDone && stays(s, false, end, 'defined')) {
    m.start = start + inserted;
    sDone = true;
  }
  if (!eDone && stays(e, true, end, 'defined')) {
    m.end = start + inserted;
    eDone = true;
  }
  const delta = inserted - deleted;
  if (!sDone) m.start = Math.max(0, s + delta);
  if (!eDone) m.end = Math.max(0, e + delta);
  if (m.start > m.end) m.end = m.start;
}

// 開いているファイルごとの、エディターが持つ問題の位置。VS Code と同じく、問題が出たとき（ファイルを開いたときも）に、そのときのファイルの中の
// 範囲に直して置き、そのあとは編集に合わせて動かす。提供元が問題を出し直すと、VS Code はその提供元の問題だけを置き直す（問題のオブジェクトで
// 見分ける）。拡張機能には、どの提供元が出し直したかは届かないが、出し直した問題は vscode.Diagnostic のオブジェクトが替わるので、
// 同じオブジェクトなら前の位置を引き継ぐ
class ProblemPositions {
  constructor() {
    this.files = new Map(); // ファイルの場所 → [{ diagnostic, start, end, severity }]（位置はファイルの頭からの文字数）
  }

  // ファイルの問題を持ち直す。VS Code と同じく、文言のある問題の最初の500個（どの重さも数える）
  reset(doc) {
    const before = new Map((this.files.get(String(doc.uri)) || []).map((m) => [m.diagnostic, m]));
    const list = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.message).slice(0, MARKER_TAKE);
    this.files.set(String(doc.uri), list.map((d) => {
      if (before.has(d)) return before.get(d);
      const r = markerRange(doc, d);
      return { diagnostic: d, start: doc.offsetAt(r.start), end: doc.offsetAt(r.end), severity: MARKER_SEVERITY[d.severity] };
    }));
  }

  // 編集に合わせて動かす。contentChanges は、どれも編集前のファイルの位置で書かれていて、後ろの変更から順に並んでいる
  edit(e) {
    const list = this.files.get(String(e.document.uri));
    if (!list) return;
    for (const c of e.contentChanges) for (const m of list) acceptEdit(m, c.rangeOffset, c.rangeOffset + c.rangeLength, c.text.length);
  }

  forget(doc) {
    this.files.delete(String(doc.uri));
  }

  // ファイルの問題を、いまの範囲（vscode.Range）と重さで返す。まだ持っていなければ、いま届いている問題で持つ
  get(doc) {
    if (!this.files.has(String(doc.uri))) this.reset(doc);
    return this.files.get(String(doc.uri)).map((m) => ({ range: new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end)), severity: m.severity }));
  }
}

// --- 行への割り当て ---

// 範囲が交わるか（端が接しているだけなら交わらない。VS Code の Range.areIntersecting と同じ）
const intersecting = (a, b) => !(a.end.isBeforeOrEqual(b.start) || b.end.isBeforeOrEqual(a.start));

// 問題（エラーと警告）を行に割り当て、行ごとに sym.problem（{ count: 子の行に配られなかった数, top: いちばん重い問題の重さ }。なければ undefined）
// を付ける。1.140.0版の本体のプログラムの OutlineModel.updateMarker と OutlineElement._updateMarker と同じ：問題を範囲の始まりの順に並べ、
// いちばん上の段の行から順に、範囲が交わる問題を取り、その中から子の行に配る。取った問題は、ほかの兄弟の行には配らない
function assignProblems(roots, problems) {
  const markers = problems.filter((p) => p.severity === SEVERITY.error || p.severity === SEVERITY.warning).sort((a, b) => compareRanges(a.range, b.range));
  roots.forEach((sym) => assignTo(markers, sym));
}

function assignTo(markers, sym) {
  sym.problem = undefined;
  // 行の範囲と同じか、その直前の始まりの問題から見る（VS Code と同じ二分探索）
  let low = 0;
  let high = markers.length - 1;
  let found = -1;
  while (low <= high && found < 0) {
    const mid = (low + high) >> 1;
    const c = compareRanges(markers[mid].range, sym.range);
    if (c < 0) low = mid + 1;
    else if (c > 0) high = mid - 1;
    else found = mid;
  }
  let n = found >= 0 ? found : low;
  if (found < 0 && n > 0 && intersecting(markers[n - 1].range, sym.range)) n -= 1;
  const mine = [];
  let top;
  for (; n < markers.length && intersecting(sym.range, markers[n].range); n++) {
    mine.push(markers[n]);
    if (!top || markers[n].severity > top) top = markers[n].severity;
    markers[n] = null;
  }
  sym.children.forEach((child) => assignTo(mine, child));
  if (top) sym.problem = { count: mine.length, top };
  for (let k = markers.length - 1; k >= 0; k--) if (markers[k] === null) markers.splice(k, 1);
}

// 行の問題を消す（問題を出さない設定のとき）
function clearProblems(list) {
  list.forEach((sym) => {
    sym.problem = undefined;
    clearProblems(sym.children);
  });
}

// 問題を出すか（VS Code 標準のアウトラインと同じく、problems.visibility と outline.problems.enabled の両方が true のとき。言語ごとの値は読まない）
const problemsEnabled = () => !!vscode.workspace.getConfiguration('problems').get('visibility') && !!vscode.workspace.getConfiguration('outline').get('problems.enabled');

// 行のファイルの装飾（なければ undefined）。VS Code 標準のアウトラインと同じく、いちばん重い問題がエラーなら list.errorForeground、警告なら
// list.warningForeground の色を付け、バッジは、子の行に配られなかった数（10以上は「+9」）か、すべて子の行にあれば点にする。
// outline.problems.colors が false のとき、VS Code 標準のアウトラインはバッジにだけ色を付けるが、ファイルの装飾の色は名前とバッジの両方に付くので、
// 名前に色が付かないほうを合わせて、色を付けない（2026-10-27 に Claude が決めた）。バッジにマウスを乗せたときの文字は付けない（付けると、
// 行の名前にマウスを乗せたときの文字にもつながるため。同じく Claude が決めた）
function problemDecoration(problem) {
  if (!problem) return undefined;
  const config = vscode.workspace.getConfiguration('outline');
  const color = config.get('problems.colors') ? new vscode.ThemeColor(problem.top === SEVERITY.error ? 'list.errorForeground' : 'list.warningForeground') : undefined;
  const badge = config.get('problems.badges') ? (problem.count === 0 ? PROBLEM_DOT : problem.count < 10 ? String(problem.count) : '+9') : undefined;
  return color || badge ? new vscode.FileDecoration(badge, undefined, color) : undefined;
}

// エラー・警告アイコン（0.4.0版のチケット33）の種類。Eclipse のアウトライン（JDT UI の ProblemsLabelDecorator）と同じく、問題の始まりの位置が
// 行の範囲の中にあれば、その行の問題に数え（子の行の範囲も親の範囲の中なので、子の行の問題も親の行に数える）、いちばん重いもの
// （エラー → 警告 → 情報）を1つ付ける。ヒントは Eclipse にない重さなので数えない。problems は ProblemPositions.get の結果
const PROBLEM_ICONS = { [SEVERITY.error]: 'error', [SEVERITY.warning]: 'warning', [SEVERITY.info]: 'info' };
function eclipseProblem(sym, problems) {
  let top = 0;
  for (const p of problems) {
    const inside = sym.range.start.isBeforeOrEqual(p.range.start) && !sym.range.end.isBeforeOrEqual(p.range.start);
    if (inside && p.severity > top && PROBLEM_ICONS[p.severity]) top = p.severity;
  }
  return PROBLEM_ICONS[top] || null;
}

// 装飾を比べるための文字（装飾がなければ 'none'）
const decorationKey = (d) => (d ? JSON.stringify([d.badge, d.color && d.color.id]) : 'none');

// 行の場所：ファイルの場所に、シンボルの範囲（1から数えた「行,桁-行,桁」）を付けたもの（rangeUri と同じ形）。範囲が同じ兄弟の行と、
// 装飾を入れ替えるための2つの場所（toggle が0か1）を、範囲の始まりの行の数の頭に付ける0の数で分ける（VS Code は、範囲を読み直すときに頭の0を
// 読み飛ばすので、ドラッグでエディターなどに渡る範囲は同じ）
function rowPlace(sym, toggle) {
  const r = sym.range;
  const zeros = '0'.repeat(2 * sym.dup + toggle);
  return sym.uri.with({ fragment: `${zeros}${r.start.line + 1},${r.start.character + 1}-${r.end.line + 1},${r.end.character + 1}` });
}

// 行の場所のファイルの装飾（vscode.FileDecorationProvider）。VS Code は場所ごとに装飾を覚え、替わった知らせを受けると、その場所の装飾を捨てて
// 問い合わせ直し、返るまでは「装飾なし」として描き、描き直しを0.1秒まとめる（1.140.0版の本体のプログラムの DecorationsService で読んだ）。
// 行を出し直すときに色とバッジが消えないよう、VS Code に返した装飾を覚えておき、新しい場所は、行を出す前に問い合わせさせる
class RowDecorations {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this.changed.event;
    this.values = new Map(); // 行の場所 → 問い合わせられたら返す装飾
    this.served = new Map(); // 行の場所 → VS Code に返した装飾の鍵（VS Code が覚えているもの）
    this.waiting = new Map(); // 問い合わせてくるのを待っている場所 → 問い合わせてきたら呼ぶ関数
  }

  provideFileDecoration(uri) {
    const place = String(uri);
    if (!this.values.has(place)) return undefined; // 行の場所でなければ（エクスプローラーのファイルなど）、何も付けない
    const d = this.values.get(place);
    this.served.set(place, decorationKey(d));
    const done = this.waiting.get(place);
    if (done) {
      this.waiting.delete(place);
      done();
    }
    return d;
  }

  // VS Code が覚えている、場所の装飾の鍵（まだ問い合わせてきていなければ null）
  servedKey(place) {
    return this.served.has(String(place)) ? this.served.get(String(place)) : null;
  }

  // 場所の装飾が替わったことを知らせる（250個ずつに分ける）
  fire(places) {
    for (let i = 0; i < places.length; i += DECORATION_EVENT_SIZE) this.changed.fire(places.slice(i, i + DECORATION_EVENT_SIZE));
  }

  // 場所 places の装飾を VS Code に問い合わせさせ、問い合わせ終わるまで待つ（問い合わせてこなければ DECORATION_WAIT で終える）。
  // 返した装飾が VS Code に届いてから行を出すよう、最後にひと呼吸おく
  async preload(places) {
    const asked = places.map((p) => new Promise((resolve) => this.waiting.set(String(p), resolve)));
    this.fire(places);
    let timer;
    await Promise.race([Promise.all(asked), new Promise((resolve) => { timer = setTimeout(resolve, DECORATION_WAIT); })]);
    clearTimeout(timer);
    places.forEach((p) => this.waiting.delete(String(p)));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // VS Code に覚えさせた場所が多すぎたら、全部捨てさせて true を返す（行を取り直すたびに場所が替わるので、増え続けないように）
  flushIfLarge() {
    if (this.served.size <= DECORATION_LIMIT) return false;
    this.changed.fire(undefined);
    this.served.clear();
    this.values.clear();
    return true;
  }
}

// --- 編集のあとの取り直しの待ち時間（0.3.0版のチケット29） ---
// VS Code 標準のアウトラインは、編集から取り直すまでの待ち時間を、ファイル（エディターが開いているモデル）ごとに、中身（シンボル）を
// 作るのにかかった時間の、直近6回の平均にする（最短350ms、最長350msの2乗）。まだ測っていないファイルは、ほかのファイルの平均の平均
// （どのファイルも測っていなければ525ms）。拡張機能の開発用の起動では、いつも525ms（1.140.0版の本体のプログラムの
// LanguageFeatureDebounceService と OutlineModelService で読んだ）。中身は、VS Code 標準のアウトラインやパンくずリストと共有していて、
// その版を初めて頼まれたときに作る。拡張機能からは作る時間を測れないので、その版を初めて問い合わせてから返るまでの時間で代わりにする
// （VS Code 標準のアウトラインとパンくずリストも同じ待ち時間で問い合わせるので、同じ中身ができあがるのを一緒に待つことになる）
class EditDelay {
  // fixed を true にすると、平均を使わない（開発用の起動）
  constructor(fixed = false) {
    this.fixed = fixed;
    this.files = new Map(); // ファイルの番号 → 直近の時間（古い順に並べる）
    this.ids = new WeakMap(); // vscode.TextDocument → ファイルの番号。閉じて開き直すと、別のモデルとして測り直す
    this.measured = new WeakMap(); // vscode.TextDocument → 最後に測った版
    this.count = 0;
  }

  // ファイルの直近の時間を、新しいものとして数え直して返す
  samples(doc) {
    if (!this.ids.has(doc)) this.ids.set(doc, ++this.count);
    const id = this.ids.get(doc);
    const found = this.files.get(id);
    if (found) {
      this.files.delete(id);
      this.files.set(id, found);
    }
    return found;
  }

  // 待ち時間（開発用の起動では、測らないので、いつも EDIT_DELAY_DEFAULT）
  get(doc) {
    const found = this.samples(doc);
    const average = (list) => list.reduce((n, x) => n + x, 0) / list.length;
    const value = found ? average(found) : average([...this.files.values()].map(average)) | 0 || EDIT_DELAY_DEFAULT;
    return Math.min(Math.max(value, EDIT_DELAY), EDIT_DELAY_MAX);
  }

  // 問い合わせにかかった時間 ms を覚える。その版を初めて問い合わせたときだけ（VS Code も、同じ版の中身は作り直さない）
  measure(doc, version, ms) {
    if (this.fixed || this.measured.get(doc) === version) return;
    this.measured.set(doc, version);
    let found = this.samples(doc);
    if (!found) {
      found = [];
      this.files.set(this.ids.get(doc), found);
      if (this.files.size > EDIT_DELAY_FILES) [...this.files.keys()].slice(0, this.files.size - Math.round(EDIT_DELAY_FILES * 0.7)).forEach((k) => this.files.delete(k));
    }
    found.push(ms);
    if (found.length > EDIT_DELAY_SAMPLES) found.shift();
  }
}

// すべての段の行の数（設定で隠した行も数える）
const countRows = (list) => list.reduce((n, sym) => n + 1 + countRows(sym.children), 0);

// --- 行を押したとき（0.3.0版） ---
// VS Code 標準のアウトラインと同じく、行を押す・Enter を押すと、0.15秒待ってから、エディターのカーソルを名前の先頭に移す
// （その間に次の操作が来たら、前の分は行わない）。2回続けて押すと、待たずにシンボルの範囲全体を選ぶ。
// 拡張機能の行のコマンドには、どの押し方かが渡らないので、同じ行のコマンドが続けて呼ばれたら2回続けて押した、
// Enter のコマンドから list.select を通して呼ばれたら Enter、と見分ける
class Navigator {
  constructor() {
    this.timer = null; // 待っている、1回押した分
    this.last = null; // 前に押した行と時刻（2回続けて押したかを見分ける）
    this.keyUntil = 0; // この時刻までに届いた行のコマンドは、Enter で呼ばれたもの
  }

  dispose() {
    clearTimeout(this.timer);
  }

  // 行のコマンド。uri はファイルの場所、nameStart は名前の先頭の位置、range はシンボルの範囲、id は行の id
  select(uri, nameStart, range, id) {
    const now = Date.now();
    const byKey = now < this.keyUntil;
    // 設定 workbench.list.openMode が doubleClick のときは、VS Code は2回続けて押したときだけ、行のコマンドを呼ぶ
    const doubleClickOnly = vscode.workspace.getConfiguration('workbench.list').get('openMode') === 'doubleClick';
    const twice = !byKey && (doubleClickOnly || (!!this.last && this.last.id === id && now - this.last.time < DOUBLE_CLICK_TIME));
    // 3回目は、2回続けて押したとはみなさない（3回目は VS Code 標準のアウトラインも1回押したときと同じ）
    this.last = twice || byKey ? null : { id, time: now };
    clearTimeout(this.timer);
    this.timer = null;
    // 2回続けて押したときは、待たずに範囲全体を選び、フォーカスをエディターに移して、タブを固定する
    if (twice) return this.open(uri, range, false, true);
    // 1回押したときはフォーカスをビューに残し、Enter のときはエディターに移してタブを固定する
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open(uri, new vscode.Range(nameStart, nameStart), !byKey, byKey);
    }, OPEN_DELAY);
  }

  // Enter のコマンド。VS Code の list.select で、フォーカスのある行を選ばせると、VS Code がその行のコマンドを呼ぶ。
  // 行のコマンドは、list.select が返ったあとに届くこともあるので、返ってから KEY_WAIT の間に届いたものまでを Enter とみなす
  async selectByKey() {
    this.keyUntil = Infinity;
    try {
      await vscode.commands.executeCommand('list.select');
    } finally {
      this.keyUntil = Date.now() + KEY_WAIT;
    }
  }

  // ファイルを開いて、range を選ぶ。VS Code の内部のコマンド _workbench.open を使う。拡張機能の API（showTextDocument）では、
  // スクロールのしかたを VS Code 標準のアウトラインと同じ「画面の外なら上寄せ」（selectionRevealType: 3）にできないため。
  // _workbench.open が使えなくなったときは、showTextDocument で開く（スクロールのしかただけが違う）
  open(uri, range, preserveFocus, pinned) {
    const selection = { startLineNumber: range.start.line + 1, startColumn: range.start.character + 1, endLineNumber: range.end.line + 1, endColumn: range.end.character + 1 };
    // -1 はアクティブなエディター グループ（列を省くと、VS Code は横に新しいグループを作って開く）
    return Promise.resolve(vscode.commands.executeCommand('_workbench.open', uri, [-1, { selection, selectionRevealType: 3, preserveFocus, pinned }]))
      .catch(() => vscode.window.showTextDocument(uri, { selection: range, preserveFocus, preview: pinned ? false : undefined }));
  }
}

// --- 「…」メニュー（0.3.0版） ---
// VS Code 標準のアウトラインの「…」メニューと同じく、カーソルに追従（既定はオフ）と並べ替え（既定は位置）を選べるようにし、
// 選んだ状態をワークスペースごとに覚える（VS Code 標準のアウトラインも、ワークスペースごとの保存先 outline/state に覚える）。
// 拡張機能がメニューに足した項目には、チェックを付けられない（VS Code が package.json の toggled を読まない）。
// 代わりに、項目ごとに「✓ 付き」（コマンドの名前の末尾が .checked）と「✓ なし」の2つのコマンドを package.json に書き、
// 出し分けの値（setContext）で片方だけを出す。「種類でフィルター」は出さない（2026-10-15 にユーザーが決めた。決定事項の「操作・挙動」）

const SORT_ORDERS = ['position', 'name', 'kind']; // 並べ替え：位置、名前、カテゴリ

// メニューの項目の「✓ なし」のコマンド → 選んだときの状態の変え方。「✓ 付き」のコマンドも同じ動き
const MENU_COMMANDS = {
  'eclipseLikeOutline.followCursor': (state) => ({ followCursor: !state.followCursor }),
  'eclipseLikeOutline.sortByPosition': () => ({ sortBy: 'position' }),
  'eclipseLikeOutline.sortByName': () => ({ sortBy: 'name' }),
  'eclipseLikeOutline.sortByKind': () => ({ sortBy: 'kind' }),
};

class ViewState {
  // memento はワークスペースごとの記録（context.workspaceState）。記録がないときと、読めない値のときは既定の状態
  constructor(memento) {
    this.memento = memento;
    const saved = memento.get(VIEW_STATE_KEY);
    this.followCursor = !!saved && saved.followCursor === true;
    this.sortBy = saved && SORT_ORDERS.includes(saved.sortBy) ? saved.sortBy : 'position';
  }

  // メニューの出し分けの値を入れる（package.json のメニューの when が読む）
  publish() {
    return Promise.all([
      vscode.commands.executeCommand('setContext', 'eclipseLikeOutline.followsCursor', this.followCursor),
      vscode.commands.executeCommand('setContext', 'eclipseLikeOutline.sortMode', this.sortBy),
    ]);
  }

  save() {
    return this.memento.update(VIEW_STATE_KEY, { followCursor: this.followCursor, sortBy: this.sortBy });
  }
}

// --- 追従と表示の切り替え ---

// 開いているファイルの中身（vscode.TextDocument）。拡張機能にまだ届いていなければ undefined
const docOf = (uri) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());

class Outline {
  // viewState は「…」メニューで選んだ状態（ViewState。0.3.0版）。editDelay は編集から取り直すまでの待ち時間（EditDelay。0.3.0版）
  constructor(view, provider, viewState, editDelay = new EditDelay()) {
    this.view = view;
    this.provider = provider;
    this.viewState = viewState;
    provider.setSortOrder(viewState.sortBy);
    this.editDelay = editDelay;
    // 内部のコマンド SYMBOLS_COMMAND がないと分かったか（0.3.0版のチケット26）
    this.noSymbolsCommand = false;
    // 出しているファイルで最後に出した行の数（すべての段。設定で隠した行も）。編集で取り直したときに比べる。ファイルを出し始めたら null（0.3.0版）
    this.shownCount = null;
    // エディターのアウトライン（ツリーか「シンボルが見つかりません」）を出しているか（0.3.0版）。「…」メニューで選んだ状態を保存してよいか
    this.hasOutline = false;
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
    // 開閉状態（0.3.0版）
    this.openStates = new Map(); // 覚えているファイル（古い順）：ファイルの場所 → { open: Map(行の id → 展開しているか), selected: 選ばれていた行の id }
    this.open = new Map(); // ツリーを出しているファイルの、子のある行の開閉状態（行の id → 展開しているか）
    this.openUri = null; // this.open のファイル。ツリーを出していないとき（開閉状態を覚えたあとや、ビューが隠れたあと）は null
    this.openByDefault = true; // 最初の開閉状態（設定 outline.collapseItems が alwaysCollapse でなければ展開）。null は、まだ読んでいない
    this.defaultFrom = undefined; // 最初の開閉状態の設定を、どのファイルの言語で読むか（beginFile。undefined はそのファイル、null は言語なし）
    this.nextDefaultFrom = undefined; // 次にファイルを出し始めるときの defaultFrom（onEditorChanged が決める）
    this.groupFiles = new Map(); // エディター グループごとに、テキストのエディターが出しているファイル（列 → { uri, languageId }。テキストでないエディターなら null）
    this.openedUris = new Set(); // 出しているファイルが替わってから、新しく開いたタブのファイルの場所
    this.hidden = false; // ビューが隠れて、出していたファイルの開閉状態を捨てた
    // 選び直す行のうち、折りたたまれた親の下にあって、まだ選んでいないものの id（sym.id）。親が展開されたら選ぶ（0.3.0版）
    this.hiddenSelection = null;
    // ボタンの出し分けの値に入れた値（0.3.0版）。VS Code 標準のアウトラインの既定と同じく、はじめは false（すべて折りたたむボタン）
    this.allCollapsed = false;
    // カーソルに追従（0.3.0版）
    this.followTimer = null; // カーソルが止まるのを待っている
    this.tracking = false; // ファイルの行を出していて、取り直していないか。カーソル・問題・設定の変化で選び直すのは、この間だけ
    this.shownVersion = undefined; // 出している行を問い合わせたときの、ファイルの版（vscode.TextDocument の version）
    // エラー・警告（0.4.0版）
    this.positions = new ProblemPositions(); // 開いているファイルごとの、エディターが持つ問題の位置
    this.decorations = new RowDecorations(); // 行の場所のファイルの装飾
    this.problemsVersion = 0; // 表示中のファイルの問題か、問題の設定が変わった回数
    this.problemsAt = 0; // 行を出す前に割り当てたとき（decorateRows）の problemsVersion。行を出すまでの間に変わったら、出したあとで割り当て直す
    this.editDue = 0; // 編集で取り直す予定の時刻（editTimer があるときだけ使う）
    // オーバーライド（0.5.0版）
    this.overrides = new Map(); // 表示中のファイルで決めたオーバーライド・実装（行の id → 'override'・'implement'・null）
    this.overrideRound = 0; // オーバーライドの問い合わせの回数。古い問い合わせの結果を捨てるため
    this.overrideTimer = null; // ほかの Java のファイルが変わったあとの、問い合わせ直しを待っている
    this.overrideFingerprint = null; // overrides を決めたときの、オーバーライドの決まりに関わる中身（overrideFingerprint）
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
    clearTimeout(this.followTimer);
    clearTimeout(this.overrideTimer);
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
      // 「行を見せる」（reveal）を頼む。VS Code はビューが空のとき、待たずにすぐ行を取り直すので、0.2秒遅れない。
      // 頼むのは、並べた順で、出す行の最初のもの（ほかの行だと、行の多いファイルでは、その行までスクロールしてしまう）。
      // 設定ですべての行を隠しているときは、ふつうに知らせる（0.3.0版）
      this.view.message = undefined;
      this.provider.setRoots(roots, true);
      const [first] = this.provider.getChildren();
      if (first) Promise.resolve(this.view.reveal(first, { select: false, focus: false, expand: false })).catch(() => this.provider.changed.fire());
      else this.provider.changed.fire();
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

  // エディターが替わったときに呼ぶ。同じファイルのままなら何もしない。e はタブの変化の知らせ（グループの変化の知らせのときは省く）。
  // VS Code 標準のアウトラインは、最初の開閉状態の設定 outline.collapseItems を、グループのエディターが直前に出していたファイルの言語で読む
  // （2026-10-17 にテスト用の VS Code で測った。同じグループで、前から開いていたタブに切り替えたり、タブを閉じて隣のタブが出たりすると、
  // 前のファイルの言語の値で始まる。設定画面などテキストでないエディターのあとは、言語なしの値。新しく開いたタブと、ほかのグループへの
  // 切り替えでは、そのファイルの言語の値）。同じにするため、グループごとに出していたファイルを覚えておく（0.3.0版）
  // VS Code は、新しく開いたタブの知らせ（e.opened）と、そのタブがアクティブになった知らせを、別々に送ることがあるので、
  // ファイルが替わるまでに新しく開いたタブを、openedUris にためておく
  onEditorChanged(e) {
    if (e) {
      for (const tab of e.opened) {
        const opened = tab.input && tab.input.uri;
        if (opened) this.openedUris.add(String(opened));
      }
    }
    const before = this.groupFiles.get(vscode.window.tabGroups.activeTabGroup.viewColumn);
    this.updateGroupFiles();
    const uri = this.activeUri();
    if (String(uri) === String(this.uri)) return;
    this.nextDefaultFrom = this.openedUris.has(String(uri)) ? undefined : before;
    this.openedUris.clear();
    // VS Code 標準のアウトラインは、アウトラインを出していたエディターの中身が替わると（エディターを閉じたときと、同じグループでほかのタブに
    // 替えたとき）、いったん中身のないツリーにするので、ボタンの出し分けの値が「すべて折りたたまれている」になる。次のファイルのツリーを出せば
    // 決め直すが、エディターがなければ、そのまま残る。ほかのグループに切り替えたときは、前のグループのエディターがそのままなので、替わらない
    // （1.140.0版の本体のプログラムで読み、E2E テストで確かめた。0.3.0版）。どのグループのアクティブなタブにも出していたファイルがなければ、
    // エディターの中身が替わったとみなす
    const kept = vscode.window.tabGroups.all.some((g) => g.activeTab && g.activeTab.input instanceof vscode.TabInputText && String(g.activeTab.input.uri) === String(this.uri));
    if (this.hasOutline && !kept) this.updateAllCollapsed([]);
    this.refresh();
  }

  // グループごとに、アクティブなタブがテキストのファイルならその場所と言語を、テキストでなければ null を覚える
  updateGroupFiles() {
    for (const group of vscode.window.tabGroups.all) {
      const tab = group.activeTab;
      if (!tab) continue;
      if (!(tab.input instanceof vscode.TabInputText)) {
        this.groupFiles.set(group.viewColumn, null);
        continue;
      }
      const doc = docOf(tab.input.uri);
      this.groupFiles.set(group.viewColumn, { uri: tab.input.uri, languageId: doc && doc.languageId });
    }
  }

  // 言語モードの切り替え（中身を返す拡張機能が替わる）。VS Code は、同じファイルを開き直したと知らせてくる。
  // VS Code 標準のアウトラインは、いったん中身のないツリーにしてから作り直すので、ボタンの出し分けの値も、そのとき「すべて折りたたまれている」になる。
  // 前に出していた中身も捨てるので、次の編集では、シンボルの数の割合を比べない（0.3.0版）
  // ファイルを開いたときは、VS Code がエディターの問題を置き直すので、問題の位置も持ち直す（0.4.0版）
  onDocumentOpened(doc) {
    this.positions.reset(doc);
    if (!this.uri || doc.uri.toString() !== this.uri.toString()) return;
    this.shownCount = null;
    if (this.hasOutline) this.updateAllCollapsed([]);
    this.refresh();
  }

  // ビューが隠れている間に更新が必要になっていたら、見えたときに取り直す。
  // VS Code 標準のアウトラインは、ビューが隠れるとツリーを捨て（開閉状態は覚えない）、見えたときに作り直す。同じにするため、
  // 隠れたときに、出しているファイルの開閉状態を捨て、見えたときに、行の id を替えて出し直す（0.3.0版）。
  // 問い合わせている途中の結果も捨てる（VS Code 標準のアウトラインも、隠れたときに問い合わせを取り消す。捨てないと、隠れている間に
  // 行を出して、選び直しの reveal が、隠れたビューを開いてしまう）
  onVisibilityChanged() {
    if (!this.view.visible) {
      this.openUri = null;
      this.hiddenSelection = null;
      this.hidden = true;
      this.hasOutline = false;
      this.generation++;
      this.pending = true;
      this.provider.round++;
      return;
    }
    if (this.pending) this.refresh();
  }

  // 設定が変わったとき（0.3.0版）。VS Code 標準のアウトラインは、outline の設定が変わると行を出し直し、種類ごとに隠す設定がその場で効く。
  // ツリーを出していないとき（メッセージ、読み込み中、ビューが隠れている）は、次にツリーを出すときに読むので、何もしない。
  // VS Code 標準のアウトラインは、outline・breadcrumbs・problems.visibility の設定が変わったときも、カーソルに追従で行を選び直す
  // （1.140.0版の本体のプログラムで読んだ）。隠す行が替わったときは、選んでいた行を選び直す代わりに選ぶ。
  // そのときも、行を VS Code が返した順から並べ直す（チケット27）
  onConfigChanged(e) {
    if (!this.showingTree || !this.view.visible) return;
    if (!['outline', 'breadcrumbs', 'problems.visibility'].some((name) => e.affectsConfiguration(name))) return;
    // 問題を出すかと、色とバッジの設定が変わったら、割り当て直す（0.4.0版。VS Code 標準のアウトラインも、そのときに割り当て直して描き直す）
    if (e.affectsConfiguration('outline.problems') || e.affectsConfiguration('problems.visibility')) {
      this.problemsVersion++;
      this.reapplyProblems();
    }
    const [selected] = this.view.selection;
    const before = selected && this.provider.rowId(selected);
    const hidden = this.hiddenSelection;
    if (this.tracking) this.restoreOrder();
    if (!e.affectsConfiguration('outline') || !applyShowSettings(this.provider.roots, docOf(this.uri) || this.uri)) {
      if (this.tracking) this.follow();
      return;
    }
    this.provider.changed.fire();
    this.changedAt = Date.now();
    if (this.tracking && this.follow()) return;
    if (selected) this.reselect(this.provider.roots, selected.id, before);
    else if (hidden) this.reselect(this.provider.roots, hidden);
  }

  // 「…」メニューで項目を選んだとき（0.3.0版）。change は変える状態。メニューの ✓ はすぐ替え、状態は、エディターのアウトラインを
  // 出しているときだけ保存する。VS Code 標準のアウトラインは、エディターのアウトラインを作ってから捨てるまでの間だけ、状態の変化を受けて
  // 保存する（1.140.0版の本体のプログラムで読んだ）。そのため、エディターがないとき・読み込み中・ビューが隠れているときに選んだ状態は、
  // 次に保存するまで保存されず、その前にウィンドウを閉じると戻る。同じにする
  // カーソルに追従をオンにしたときは、その場で行を選ぶ（VS Code 標準のアウトラインと同じ）
  setViewState(change) {
    const state = this.viewState;
    if (Object.keys(change).every((k) => state[k] === change[k])) return;
    Object.assign(state, change);
    state.publish();
    if (this.hasOutline) state.save();
    if (change.sortBy) this.resort();
    if (change.followCursor) this.follow();
  }

  // 並べ方を替えたとき（0.3.0版のチケット27）。VS Code 標準のアウトラインと同じく、いま出している順から、その場で並べ直す。
  // 行の id は替えないので、VS Code は開閉状態と選ばれた行を保つ。ツリーを出していないときと、ビューが隠れているときは、
  // 次に行を出すときに並べる（VS Code 標準のアウトラインも、そのときはツリーがなく、次に作るツリーで並べる）
  resort() {
    this.provider.setSortOrder(this.viewState.sortBy);
    if (!this.showingTree || !this.view.visible) return;
    this.provider.sort(true);
    this.provider.changed.fire();
    this.changedAt = Date.now();
  }

  // 行を、VS Code が返した順から並べ直す（0.3.0版のチケット27）。VS Code 標準のアウトラインは、エディターのアウトラインの「中身が変わった」
  // 知らせ（カーソルが止まったとき、問題が変わったとき、設定が変わったとき）のたびに、ツリーの行を取り直して、VS Code が返した順から
  // 並べ直す（1.140.0版の本体のプログラムで読んだ）。並べ方を替えたあと、比べて同じになる行が、前の並べ方の順のままになっていれば、
  // ここで元に戻る。並びが替わったときだけ知らせる
  restoreOrder() {
    if (!this.provider.sort()) return;
    this.provider.changed.fire();
    this.changedAt = Date.now();
  }

  // 行を展開した・折りたたんだ知らせ（0.3.0版）。開閉状態を行の id ごとに覚える。id にファイルの場所が入っているので、
  // 切り替える前のファイルの行の知らせが遅れて届いても、いま出しているファイルの行の開閉状態にはならない
  // 展開したときは、その下に、まだ選んでいない選び直す行（hiddenSelection）があれば選ぶ
  onToggled(sym, open) {
    sym.open = open;
    this.open.set(sym.id, open);
    this.updateAllCollapsed();
    if (open && this.hiddenSelection) this.reselect(this.provider.roots, this.hiddenSelection);
  }

  // 選ばれた行が替わった知らせ（0.3.0版）。行が選ばれたら、まだ選んでいない選び直す行は忘れる。
  // 行の id が替わって、VS Code が選ばれた状態を外したとき（選ばれた行がなくなる）は、何もしない
  onSelectionChanged(e) {
    if (e.selection.length) this.hiddenSelection = null;
  }

  // --- カーソルに追従（0.3.0版） ---
  // 「…」メニューでオンにしている間、VS Code 標準のアウトラインと同じく、エディターのカーソルを含むいちばん内側のシンボルの行を選ぶ。
  // 選ぶのは、カーソルが止まってから FOLLOW_DELAY 後（その間にファイルが編集されていないとき）、行を出したとき（編集で取り直したときも）、
  // 出しているファイルの問題（エラー・警告）が変わったとき、設定が変わったとき、オンにしたとき（1.140.0版の本体のプログラムで読んだ）。
  // 行を選ぶ機能（reveal）は、折りたたまれた親の行を展開し、行が見えるところまでスクロールする。キーボードのフォーカスはエディターに残す。
  // ビューが隠れている間は、エディターのアウトラインを出していない（hasOutline が false）ので選ばない（reveal は、隠れたビューを開いてしまう）。
  // VS Code 標準のアウトラインは、行がビューの画面の外にあると、ビューの中央に来るようにスクロールし、フォーカスのある行も選んだ行に移すが、
  // 拡張機能からはできない（reveal にスクロールのしかたの指定がなく、拡張機能はビューの高さも知ることができない。
  // focus: true にすると、キーボードのフォーカスをエディターから取る）

  // アウトラインを出しているエディター（アクティブなエディター グループの、表示中のファイルのテキストのエディター）か
  isOutlined(editor) {
    return editor.viewColumn === vscode.window.tabGroups.activeTabGroup.viewColumn && String(editor.document.uri) === String(this.uri);
  }

  // エディターのカーソルが動いた知らせ。VS Code 標準のアウトラインと同じく、アウトラインを出しているエディターのカーソルだけを見て、
  // 止まってから FOLLOW_DELAY 後に選ぶ。行を問い合わせたあとにファイルが編集されていたら（版が違えば）選ばず、行を出し直したときに選ぶ。
  // VS Code 標準のアウトラインは、選ぶ前に、行を VS Code が返した順から並べ直す（チケット27。追従がオフでも並べ直す）
  onCursorMoved(e) {
    if (!this.tracking || !this.isOutlined(e.textEditor)) return;
    clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => {
      if (e.textEditor.document.version !== this.shownVersion) return;
      this.restoreOrder();
      this.follow();
    }, FOLLOW_DELAY);
  }

  // 問題が変わった知らせ。開いているファイルの問題の位置を持ち直し、出しているファイルなら割り当て直す（0.4.0版）。
  // VS Code 標準のアウトラインは、出しているファイルの問題が変わると行を出し直し（VS Code が返した順から並べ直す）、そのときにも選ぶ
  onDiagnosticsChanged(e) {
    for (const u of e.uris) {
      const doc = docOf(u);
      if (doc) this.positions.reset(doc);
    }
    if (!e.uris.some((u) => String(u) === String(this.uri))) return;
    this.problemsVersion++;
    this.reapplyProblems();
    if (!this.tracking) return;
    this.restoreOrder();
    this.follow();
  }

  // カーソルに追従がオンなら、カーソルを含むいちばん内側のシンボルの行を選び、true を返す。VS Code 標準のアウトラインと同じく、
  // その行が設定で隠れているときは、親の行をたどって、出ている行を選ぶ。そのとき、隠れた行の親の行は、隠れた行も含めてすべて展開する
  // （VS Code 標準のアウトラインは、隠れた行を見せようとして、親の行を展開する）。VS Code に渡していない行（隠れた行とその中の行と、
  // 子の行がすべて隠れた行）の開閉状態は、ここで覚え、出ている行は、reveal で VS Code に展開させる（展開の知らせで onToggled が覚える）
  follow() {
    if (!this.viewState.followCursor || !this.hasOutline) return false;
    const editor = vscode.window.visibleTextEditors.find((ed) => this.isOutlined(ed));
    const found = editor && symbolAt(this.provider.roots, editor.selection.active);
    if (!found) return false;
    const chain = []; // いちばん上の段の行から found まで
    for (let s = found; s; s = s.parent) chain.unshift(s);
    const firstHidden = chain.findIndex((s) => s.hidden);
    const target = firstHidden === -1 ? found : chain[firstHidden - 1]; // いちばん上の段の行も隠れていれば undefined
    if (firstHidden !== -1) {
      const unseen = chain.slice(firstHidden, -1); // found の親の行のうち、VS Code に渡していない行
      if (target && !shownRows(target.children).length) unseen.push(target);
      const opened = unseen.filter((s) => !s.open);
      opened.forEach((s) => {
        s.open = true;
        this.open.set(s.id, true);
      });
      if (opened.length) this.updateAllCollapsed();
    }
    if (!target) return false;
    this.hiddenSelection = null;
    Promise.resolve(this.view.reveal(target, { select: true, focus: false, expand: firstHidden !== -1 })).catch(() => {});
    return true;
  }

  // --- すべて折りたたむボタン（0.3.0版） ---
  // VS Code 標準のアウトラインは、いちばん上の段の行がすべて、子のない行か折りたたまれた行なら「すべて展開」のボタンを、
  // そうでなければ「すべて折りたたむ」のボタンを出す。設定で隠した行も数え、子の行がすべて隠れた行は、子のある行として数える
  // （ツリーは、隠した行も持っているため。1.140.0版の本体のプログラムで読んだ）。行を開閉したときと、行を出し直したときに決め直す。
  // メッセージを出している間とビューが隠れている間は、前の値のまま。中身のないツリー（「シンボルが見つかりません」）は
  // 「すべて折りたたまれている」と数える
  updateAllCollapsed(roots = this.provider.roots) {
    const value = roots.every((sym) => !sym.children.length || sym.open === false);
    if (value === this.allCollapsed) return;
    this.allCollapsed = value;
    vscode.commands.executeCommand('setContext', ALL_COLLAPSED_CONTEXT, value);
  }

  // ボタンを押したとき。VS Code 標準のアウトラインと同じく、すべての段の子のある行（設定で隠した行も）を、折りたたむか展開する。
  // VS Code は、前から出している行の開閉状態を、拡張機能が渡し直しても替えないので、開閉状態を覚えてから、行の id を替えて出し直す。
  // 選ばれていた行は選び直す（折りたたまれた親の下になった行は、親が展開されたときに選ぶ）。エディターのアウトラインを出していないとき
  // （次のファイルを読み込んでいる間、メッセージを出しているとき）は何もしない。VS Code 標準のアウトラインは、エディターが替わったときに
  // ツリーを捨てるので、ツリーがない
  setAllOpen(open) {
    if (!this.hasOutline) return;
    let changed = false;
    const walk = (list) => list.forEach((sym) => {
      if (sym.children.length && sym.open !== open) {
        sym.open = open;
        this.open.set(sym.id, open);
        changed = true;
      }
      walk(sym.children);
    });
    walk(this.provider.roots);
    if (!changed) return;
    const [selected] = this.view.selection;
    const id = selected ? selected.id : this.hiddenSelection;
    this.provider.round++;
    this.provider.changed.fire();
    this.changedAt = Date.now();
    this.updateAllCollapsed();
    if (id) this.reselect(this.provider.roots, id);
  }

  // 編集の知らせ。VS Code 標準のアウトラインと同じく、知らせのたびに、そのときの待ち時間を読んで待ち直す（0.3.0版）。
  // 最後の編集で消した文字数を、取り直したときの比べ方（waitIfJumped）に渡す
  onDocumentChanged(e) {
    this.positions.edit(e); // 問題の位置を、編集に合わせて動かす（0.4.0版。表示中でないファイルも）
    if (!this.uri || e.document.uri.toString() !== this.uri.toString()) return;
    if (e.contentChanges.length === 0) return;
    clearTimeout(this.editTimer);
    const removed = e.contentChanges.reduce((n, change) => n + change.rangeLength, 0);
    const delay = this.editDelay.get(e.document);
    this.editDue = Date.now() + delay;
    this.editTimer = setTimeout(() => this.refresh(false, removed), delay);
  }

  // ファイル uri のシンボルを問い合わせる。VS Code の内部のコマンド SYMBOLS_COMMAND で、tags（非推奨の印）も受け取る。
  // 内部のコマンドがないとき（VS Code の版が替わって、なくなったときなど）は、vscode.executeDocumentSymbolProvider で受け取る。
  // どちらも同じ中身を返すので、違うのは、非推奨の行も検索窓で一致した文字を強調することだけ（0.3.0版のチケット26）。
  // コマンドがあるかは、失敗したときだけ調べる。先に調べると、その1往復の分だけ最初の問い合わせが遅れ、起動の直後に、
  // VS Code 標準のアウトラインと違う「読み込んでいます」を出すことがあるため（2026-10-21 に E2E テストで見つけた）。
  // ほかの理由の失敗は、vscode.executeDocumentSymbolProvider でも同じに失敗するので、問い合わせ直さずにそのまま返す
  async documentSymbols(uri) {
    if (!this.noSymbolsCommand) {
      try {
        return fromInternal(await vscode.commands.executeCommand(SYMBOLS_COMMAND, uri));
      } catch (e) {
        if ((await vscode.commands.getCommands().catch(() => [])).includes(SYMBOLS_COMMAND)) throw e;
        this.noSymbolsCommand = true;
      }
    }
    return vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
  }

  // retrying は、問い合わせ直しのとき。「読み込んでいます」は出さない（VS Code 標準のアウトラインも出さない）。
  // removed は、編集で取り直すときの、最後の編集で消した文字数（0.3.0版。編集のほかで取り直すときは null）
  async refresh(retrying = false, removed = null) {
    clearTimeout(this.editTimer);
    this.editTimer = null;
    clearTimeout(this.retryTimer);
    // 取り直している間は、カーソルに追従で選ばない（VS Code 標準のアウトラインも、作り直している間は、カーソルなどの知らせを受けない）
    clearTimeout(this.followTimer);
    this.tracking = false;
    if (this.disposed) return;
    if (!this.view.visible) {
      this.pending = true;
      return;
    }
    this.pending = false;
    const generation = ++this.generation;
    const uri = this.activeUri();
    // エディターが替わったか、隠れていたビューが見えた：前のファイルの開閉状態を覚え、最初の開閉状態を読み直す（0.3.0版）
    if (String(uri) !== String(this.uri) || this.hidden) this.beginFile();
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
    const doc = docOf(uri);
    const java = !!doc && doc.languageId === 'java';
    const version = doc && doc.version; // 問い合わせる時点のファイルの版（カーソルに追従。0.3.0版）
    const tokensQuery = java ? semanticTokens(uri) : null;

    // 中身を返す拡張機能がない、返せなかった、空だった、はどれも「シンボルが見つかりません」（VS Code 標準のアウトラインと同じ）
    // その版を初めて問い合わせたときは、返るまでの時間を、編集から取り直すまでの待ち時間の元にする（0.3.0版のチケット29）
    let roots;
    const started = Date.now();
    try {
      roots = toSymbols(await this.documentSymbols(uri), null, uri);
      if (doc) this.editDelay.measure(doc, version, Date.now() - started);
    } catch (e) {
      console.error('[eclipse-like-outline]', e);
      roots = [];
    }
    clearTimeout(loading);
    if (generation !== this.generation || this.disposed) return;
    this.hasOutline = true;
    if (roots.length === 0) {
      this.saveOpenStates(); // シンボルがなくなったときも覚える（VS Code 標準のアウトラインと同じ）
      this.shownCount = 0;
      this.showMessage(MESSAGES.noSymbols(name));
      this.updateAllCollapsed([]);
      return this.retryLater(uri);
    }
    this.retryUri = null;
    if (removed !== null && await this.waitIfJumped(roots, doc, removed, generation)) return;
    // エラー・警告を割り当て、VS Code がまだ覚えていない行の場所の装飾を、行を出す前に問い合わせさせる（0.4.0版）。
    // 問い合わせさせずに行を出すと、問い合わせている間（約0.1秒）、取り直した行の色とバッジが消える
    const pending = this.decorateRows(roots, uri);
    if (pending.length) {
      await this.decorations.preload(pending);
      if (generation !== this.generation || this.disposed) return;
    }
    if (!java) return this.showFile(roots, uri, version);

    // トークンは、シンボルが返ってから TOKENS_WAIT だけ待つ。間に合えば、アイコンを入れてから行を出す。
    // 間に合わないか、まだ取れない（jdt.ls の準備の途中）ときは、前に同じファイルで決めたアイコン（なければ VS Code 標準のアイコン）で
    // 行を出し、トークンが返ってから入れる
    const extra = await within(tokensQuery, TOKENS_WAIT);
    if (generation !== this.generation || this.disposed) return;
    this.remember(uri);
    const iconsReady = !!extra && this.applyIcons(roots, extra, doc);
    if (!iconsReady) this.applyRememberedIcons(roots);
    this.applyProblemIcons(roots, doc); // エラー・警告アイコン（0.4.0版）
    this.applyOverrideIcons(roots); // 前に決めたオーバーライド・実装（0.5.0版）
    this.applyFieldTypes(roots);
    this.showFile(roots, uri, version);
    await this.fillJava(roots, uri, doc, generation, iconsReady, fieldsOf(roots), extra ? null : tokensQuery);
  }

  // 編集で取り直したとき、VS Code 標準のアウトラインと同じく、ファイルが25行以上で、シンボルの数の割合（文字数あたり）が、前に出していたときの
  // 半分以下か1.5倍以上なら、出すまで2秒待つ（/* を打って、ファイルの残りがコメントになったときなどに、行が一度に消えないようにするため。
  // 1.140.0版の本体のプログラムの DocumentSymbolsOutline で読んだ。0.3.0版のチケット29）。前の割合の文字数は、いまの文字数から、最後の編集で
  // 消した文字数を引いたもの（VS Code 標準のアウトラインと同じ数え方）。待っている間に次の取り直しが始まったら、出さずにやめて true を返す
  async waitIfJumped(roots, doc, removed, generation) {
    if (this.shownCount === null || !doc || doc.lineCount < JUMP_MIN_LINES) return false;
    const length = doc.getText().length;
    const now = countRows(roots) / length;
    const before = this.shownCount / (length - removed);
    if (!(now <= before * 0.5 || now >= before * 1.5)) return false;
    await new Promise((resolve) => setTimeout(resolve, JUMP_WAIT));
    return generation !== this.generation || this.disposed;
  }

  // --- エラー・警告（0.4.0版のチケット30〜32） ---

  // 行を出す前に、問題を行に割り当て、行の場所と装飾を決める。VS Code がまだ覚えていない装飾の場所を返す（行を出す前に問い合わせさせる）
  decorateRows(roots, uri) {
    const doc = docOf(uri);
    this.problemsAt = this.problemsVersion;
    if (doc && problemsEnabled()) assignProblems(roots, this.positions.get(doc));
    const flushed = this.decorations.flushIfLarge();
    return this.pickPlaces(roots, flushed ? [] : this.provider.roots);
  }

  // Java の行のアイコンの部品に、エラー・警告アイコン（problem）を付けるか外す（0.4.0版のチケット33）。問題を出さない設定のときと、
  // ファイルの中身がまだ届いていないときは外す。アイコンの部品は、覚えておいたもの（rowIcons）と共有しているので、書き換えずに作り直す。
  // アイコンが替わった行を返す
  applyProblemIcons(roots, doc) {
    const problems = doc && problemsEnabled() ? this.positions.get(doc) : [];
    const changed = [];
    const walk = (list) => list.forEach((sym) => {
      if (sym.icon) {
        const problem = eclipseProblem(sym, problems);
        if ((sym.icon.problem || null) !== problem) {
          const { problem: _, ...rest } = sym.icon;
          sym.icon = problem ? { ...rest, problem } : rest;
          changed.push(sym);
        }
      }
      walk(sym.children);
    });
    walk(roots);
    return changed;
  }

  // 行ごとに、2つの場所（toggle が0か1）のうち、VS Code が覚えている装飾が、出したい装飾と同じものを使う（まだ問い合わせてきていない場所は、
  // 装飾がないのと同じ）。どちらも違えば、いま出している行（shownRoots）が使っていないほうを使い、その場所を返す（先に問い合わせさせる）。
  // いま出している行の場所の装飾を問い合わせ直させると、問い合わせ直している間、その行の色とバッジが消えるため
  pickPlaces(roots, shownRoots) {
    const shown = new Set();
    const collect = (list) => list.forEach((sym) => {
      if (sym.place) shown.add(String(sym.place));
      collect(sym.children);
    });
    collect(shownRoots);
    const pending = [];
    const walk = (list) => list.forEach((sym) => {
      const d = problemDecoration(sym.problem);
      const key = decorationKey(d);
      const places = [rowPlace(sym, 0), rowPlace(sym, 1)];
      const served = places.map((p) => this.decorations.servedKey(p));
      let i = served.findIndex((k) => k === key || (k === null && key === 'none'));
      if (i < 0) {
        i = shown.has(String(places[0])) ? 1 : 0;
        pending.push(places[i]);
      }
      sym.place = places[i];
      this.decorations.values.set(String(sym.place), d);
      walk(sym.children);
    });
    walk(roots);
    return pending;
  }

  // 表示中のファイルの問題か、問題の設定が変わったとき、出している行に割り当て直す（VS Code 標準のアウトラインの _applyMarkersToOutline）。
  // 前の知らせから0.2秒たっていて、編集で取り直すまで0.2秒以上あるときは、装飾が替わる行の場所を替えて、先に問い合わせさせてから、その行を
  // 出し直す（装飾が替わった知らせは、VS Code が0.1秒まとめてから描くので、それより早い）。ほかのときは、場所を替えずに、装飾が替わった
  // 知らせを送る（行を出し直すと VS Code の0.2秒のまとめが始まり、すぐあとの知らせや取り直しの行が遅れるため）。
  // 問い合わせさせている間に、取り直すまで0.2秒もなくなったときは、出し直さずに、取り直したときに出す（2026-10-28 に E2E テストで、
  // 待っている間に取り直しが近づき、取り直しの行が0.2秒遅れたのを見つけた）
  async reapplyProblems() {
    if (!this.showingTree || !this.view.visible || !this.uri) return;
    const generation = this.generation;
    const roots = this.provider.roots;
    const doc = docOf(this.uri);
    if (doc && problemsEnabled()) assignProblems(roots, this.positions.get(doc));
    else clearProblems(roots);
    // エラー・警告アイコンが替わる行（チケット33）は、どちらの出し方でも、行を出し直す（アイコンは行の中身なので、装飾の知らせでは替わらない）。
    // 編集で取り直すまで0.2秒もないときは、替えずに、取り直したときに決める（古い行に新しい位置の問題を当てた一時のアイコンを出さないため）
    const soon = !!this.editTimer && this.editDue - Date.now() < VSCODE_DEBOUNCE;
    const iconRows = soon ? [] : this.applyProblemIcons(roots, doc);
    if (!this.quiet || soon) {
      const changed = [];
      const walk = (list) => list.forEach((sym) => {
        const d = problemDecoration(sym.problem);
        const was = this.decorations.servedKey(sym.place);
        this.decorations.values.set(String(sym.place), d);
        if (was === null ? d !== undefined : was !== decorationKey(d)) changed.push(sym.place);
        walk(sym.children);
      });
      walk(roots);
      this.decorations.fire(changed);
      if (iconRows.length) {
        this.provider.changed.fire(iconRows);
        this.changedAt = Date.now();
      }
      return;
    }
    const before = new Map();
    const remember = (list) => list.forEach((sym) => {
      before.set(sym, String(sym.place));
      remember(sym.children);
    });
    remember(roots);
    const pending = this.pickPlaces(roots, roots);
    if (pending.length) await this.decorations.preload(pending);
    if (generation !== this.generation || this.disposed) return;
    if (this.editTimer && this.editDue - Date.now() < VSCODE_DEBOUNCE) return;
    const rows = [...before].filter(([sym, place]) => String(sym.place) !== place || iconRows.includes(sym)).map(([sym]) => sym);
    if (!rows.length) return;
    this.provider.changed.fire(rows);
    this.changedAt = Date.now();
  }

  // --- 開閉状態（0.3.0版） ---
  // VS Code 標準のアウトラインと同じく、ツリーを出しているファイルから離れるとき（ほかのファイルやメッセージに替わるとき）と、
  // シンボルがなくなったときに、子のある全行の開閉状態と選ばれた行を覚え、直近10ファイル分を残す。ウィンドウを閉じると忘れる

  // ファイルを出し始める（エディターが替わったとき、隠れていたビューが見えたとき）。ツリーを出していたファイルの開閉状態を覚える。
  // 最初の開閉状態は、行を初めて出すときに読む（readOpenByDefault）。隠れていたビューが見えたときは、VS Code 標準のアウトラインも
  // 作り直すので、そのファイルの言語で読む
  beginFile() {
    this.saveOpenStates();
    this.shownCount = null; // VS Code 標準のアウトラインも、エディターのアウトラインを作り直す（前に出していた中身はない。0.3.0版）
    this.hasOutline = false; // シンボルが返るまでは、VS Code 標準のアウトラインもエディターのアウトラインを作っていない
    this.defaultFrom = this.hidden ? undefined : this.nextDefaultFrom;
    this.nextDefaultFrom = undefined;
    this.hidden = false;
    this.openByDefault = null;
  }

  // 最初の開閉状態を、outline.collapseItems で決める。VS Code 標準のアウトラインは、ファイルを出し始めたときにだけ設定を読むので、
  // ファイルを出している間に設定を変えても、そのファイルの行は変わらない。読む言語は defaultFrom のファイルの言語。
  // ファイルの中身（TextDocument）がないと言語が分からないので、行を出す直前に読む（vscode.open で新しく開いたファイルは、
  // タブの変化の知らせのときには、まだ拡張機能に届いていない）
  readOpenByDefault(uri) {
    const from = this.defaultFrom === undefined ? { uri } : this.defaultFrom;
    const doc = from && docOf(from.uri);
    const scope = doc || (from && from.languageId ? from : from && from.uri);
    return vscode.workspace.getConfiguration('outline', scope).get('collapseItems') !== 'alwaysCollapse';
  }

  // ツリーを出しているファイルの、子のある全行の開閉状態と、選ばれた行を覚える（直近 OPEN_STATES_SIZE ファイル分）
  saveOpenStates() {
    if (!this.openUri) return;
    const open = new Map();
    const walk = (list) => list.forEach((sym) => {
      if (sym.children.length) open.set(sym.id, this.open.get(sym.id));
      walk(sym.children);
    });
    walk(this.provider.roots);
    // 覚えるのは出しているファイルだけで、出したときに、いちばん新しいものとして数え直してある（applyOpenStates）。
    // 選ばれた行は、まだ選んでいない選び直す行も含める（VS Code 標準のアウトラインは、折りたたまれた親の下の行も選んだまま持っている）
    const [selected] = this.view.selection;
    this.openStates.set(this.openUri, { open, selected: selected ? selected.id : this.hiddenSelection });
    if (this.openStates.size > OPEN_STATES_SIZE) this.openStates.delete(this.openStates.keys().next().value);
    this.openUri = null;
    this.hiddenSelection = null;
  }

  // 隠す行（種類ごとに隠す設定。ファイルの言語の値）と、行の開閉状態（sym.open）を決めてからツリーを出す。覚えていたファイルなら、
  // 選んでいた行を選び直す。編集で取り直したときは、選ばれている行の id が替わったら選び直す。
  // カーソルに追従がオンで、カーソルの場所の行があれば、選び直す代わりにその行を選ぶ（VS Code 標準のアウトラインも、選んでいた行を
  // 戻してから、カーソルの場所の行を選ぶ）。version は、行を問い合わせた時点のファイルの版（ファイルがまだ届いていなければ、いまの版）
  showFile(roots, uri, version) {
    this.shownCount = countRows(roots);
    applyShowSettings(roots, docOf(uri) || uri);
    const [selected] = this.openUri === String(uri) ? this.view.selection : [];
    const before = selected && this.provider.rowId(selected);
    const saved = this.applyOpenStates(roots, uri);
    this.showTree(roots);
    this.updateAllCollapsed();
    this.tracking = true;
    this.shownVersion = version !== undefined ? version : (docOf(uri) || {}).version;
    // 割り当ててから行を出すまでの間に、問題か問題の設定が変わっていたら、割り当て直す（0.4.0版）
    if (this.problemsAt !== this.problemsVersion) this.reapplyProblems();
    if (this.follow()) return;
    if (saved) this.reselect(roots, saved);
    else if (selected) this.reselect(roots, selected.id, before);
  }

  // ファイルのツリーを出し直すときは、覚えていればその状態に戻し（覚えたときになかった、子のある行は折りたたむ。
  // VS Code 標準のアウトラインと同じ）、覚えていなければ最初の開閉状態にする。編集で取り直したときは、いまの状態のまま
  // （新しく出てきた行は最初の開閉状態）。選び直す行の id を返す
  applyOpenStates(roots, uri) {
    if (this.openByDefault === null) this.openByDefault = this.readOpenByDefault(uri);
    let saved = null;
    if (this.openUri !== String(uri)) {
      saved = this.openStates.get(String(uri)) || null;
      if (saved) {
        // 戻したファイルも、いちばん新しいものとして数える
        this.openStates.delete(String(uri));
        this.openStates.set(String(uri), saved);
      }
      this.open = new Map(saved ? saved.open : []);
      this.openUri = String(uri);
    }
    const walk = (list) => list.forEach((sym) => {
      if (sym.children.length) {
        if (!this.open.has(sym.id)) this.open.set(sym.id, saved ? false : this.openByDefault);
        sym.open = this.open.get(sym.id);
      }
      walk(sym.children);
    });
    walk(roots);
    return saved && saved.selected;
  }

  // 選んでいた行（id は sym.id）を、行を選ぶ機能（reveal）で選び直す（フォーカスはエディターに残す）。設定で隠した行は選ばない。
  // VS Code 標準のアウトラインは、折りたたまれた親の下の行も、親を展開せずに選んだまま持っていて、親が展開されると、選ばれた行として出す。
  // reveal は親を展開してしまうので、そういう行は、まだ選んでいない選び直す行（hiddenSelection）として覚えておき、親が展開されたときに選ぶ（onToggled）。
  // before を渡したときは、行の id（rowId）が before から替わったときだけ選び直す（0.3.0版）。子の行を出していなかった行に子の行が出たときと、
  // 子の行がすべて隠れたときは、id が替わるので、VS Code は別の行として出し直して、選ばれた状態を外す。VS Code 標準のアウトラインは
  // 選んだままにするので、選び直す
  reselect(roots, id, before = null) {
    this.hiddenSelection = null;
    // 出す行の中から探す。見つかったら、その行と、親の行がすべて展開しているか（行が見えているか）を返す
    const find = (list, visible) => {
      for (const sym of shownRows(list)) {
        if (sym.id === id) return { sym, visible };
        const inner = find(sym.children, visible && sym.open);
        if (inner) return inner;
      }
      return null;
    };
    const found = find(roots, true);
    if (!found || (before !== null && this.provider.rowId(found.sym) === before)) return;
    if (!found.visible) {
      this.hiddenSelection = id;
      return;
    }
    Promise.resolve(this.view.reveal(found.sym, { select: true, focus: false, expand: false })).catch(() => {});
  }

  // 表示中のファイルが替わったら、前のファイルで覚えたフィールドの型とアイコンを捨てる
  remember(uri) {
    if (this.rememberedUri === String(uri)) return;
    this.rememberedUri = String(uri);
    this.fieldTypes = new Map();
    this.rowIcons = new Map();
    this.overrides = new Map();
    this.overrideFingerprint = null;
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
    this.applyProblemIcons(roots, doc); // エラー・警告アイコン（0.4.0版）
    this.applyOverrideIcons(roots); // 前に決めたオーバーライド・実装（0.5.0版）
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
  // lateTokens は、待たずに行を出したときの、まだ返っていないトークンの問い合わせ。返るのを、型の問い合わせと並べて待つ。
  // オーバーライド（0.5.0版）は、修飾子（private・static）が分かってから、フィールドの型の問い合わせのあとに問い合わせる（フィールドの型が
  // 出るまでの時間を遅らせないため）。methods は、オーバーライドを問い合わせるメソッド。null は、アイコンが決まってから全部のメソッド
  async fillJava(roots, uri, doc, generation, iconsReady, fields, lateTokens = null, methods = null) {
    const types = this.fillFieldTypes(fields, uri, generation);
    const icons = lateTokens ? lateTokens.then((extra) => this.applyIconsLater(roots, extra, doc, generation)) : iconsReady;
    const overrides = Promise.resolve(icons).then((ok) => (ok ? this.fillOverrides(methods || this.overridesToAsk(roots, doc), uri, generation) : methods));
    const [missing, ready, left] = await Promise.all([types, icons, overrides]);
    if (generation !== this.generation || this.disposed || (ready && missing.length === 0 && left.length === 0)) return;
    this.retryTimer = setTimeout(async () => {
      let ok = ready;
      if (!ok) {
        const extra = await semanticTokens(uri);
        if (generation !== this.generation || this.disposed) return;
        ok = this.applyIconsLater(roots, extra, doc, generation);
      }
      await this.fillJava(roots, uri, doc, generation, ok, missing, null, left);
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

  // --- オーバーライド（0.5.0版のチケット34） ---

  // 行のアイコンの部品に、オーバーライド・実装（override）を付けるか外す。アイコンの部品は、覚えておいたもの（rowIcons）と共有しているので、
  // 書き換えずに作り直す。替わったら true
  setOverride(sym, kind) {
    if (!sym.icon || (sym.icon.override || null) === kind) return false;
    const { override: _, ...rest } = sym.icon;
    sym.icon = kind ? { ...rest, override: kind } : rest;
    return true;
  }

  // 前に同じファイルで決めたオーバーライド・実装を、行の id（名前と親の行）が同じメソッドに先に入れる（編集のたびにアイコンが消えて見えないように。
  // フィールドの型と同じ）
  applyOverrideIcons(roots) {
    const walk = (list) => list.forEach((sym) => {
      if (this.overrides.has(sym.id)) this.setOverride(sym, this.overrides.get(sym.id));
      walk(sym.children);
    });
    walk(roots);
  }

  // 行を出したときに、オーバーライドを問い合わせるメソッド。オーバーライドの決まりに関わる中身が、前に決めたときと同じで、全部のメソッドの結果が
  // 決まっていれば、問い合わせない（前に決めた結果は applyOverrideIcons で入れてある）。中身はここで覚え、問い合わせの結果を覚えるときに使う
  overridesToAsk(roots, doc) {
    const targets = overrideTargets(roots);
    const fingerprint = overrideFingerprint(roots, doc);
    if (fingerprint === this.overrideFingerprint && targets.every((sym) => this.overrides.has(sym.id))) return [];
    this.overrideFingerprint = fingerprint;
    return targets;
  }

  // メソッドのホバーを問い合わせて、オーバーライド・実装を決め、替わった行を VS Code に知らせる。問い合わせは全部のメソッドで同時に行う
  // （プロトタイプでは、メソッド42個で0.1〜0.4秒、875個で1.7秒）。ホバーが空で返ったメソッド（jdt.ls の準備前）を返す
  async fillOverrides(methods, uri, generation) {
    const round = ++this.overrideRound;
    const files = new ParentFiles();
    const kinds = await Promise.all(methods.map(async (sym) => {
      let hovers;
      try {
        hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, sym.selectionRange.start);
      } catch {
        hovers = null;
      }
      if (!hovers || hovers.length === 0) return undefined;
      try {
        return await overrideKind(sym, uri, hovers, files);
      } catch (e) {
        console.error('[eclipse-like-outline]', e);
        return null;
      }
    }));
    if (generation !== this.generation || round !== this.overrideRound || this.disposed) return [];
    const changed = [];
    methods.forEach((sym, i) => {
      if (kinds[i] === undefined) return;
      this.overrides.set(sym.id, kinds[i]);
      if (this.setOverride(sym, kinds[i])) changed.push(sym);
    });
    if (changed.length > 0) {
      this.provider.changed.fire(changed); // 変わった行だけを VS Code に知らせる
      this.changedAt = Date.now();
    }
    return methods.filter((_, i) => kinds[i] === undefined);
  }

  // ほかの Java のファイルが保存されたときと、ディスクの上で変わったとき（ほかのアプリや Git）に、表示中のファイルのオーバーライドを問い合わせ直す。
  // Eclipse は、ビルドが終わるたびに付け直す（保存すると自動でビルドする）。拡張機能には、ほかのファイルの中身が変わった知らせが来ないため
  onJavaFileChanged(uri) {
    if (!this.showingTree || !this.uri || !uri.path.endsWith('.java') || String(uri) === String(this.uri)) return;
    clearTimeout(this.overrideTimer);
    this.overrideTimer = setTimeout(() => this.requeryOverrides(), OVERRIDE_REQUERY_DELAY);
  }

  async requeryOverrides() {
    if (!this.showingTree || !this.view.visible || !this.uri || this.disposed) return;
    const doc = docOf(this.uri);
    if (!doc || doc.languageId !== 'java') return;
    await this.fillOverrides(overrideTargets(this.provider.roots), this.uri, this.generation);
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
  // メニューの出し分けの値は、ビューの見出しのメニューが読むので、先に入れる
  const viewState = new ViewState(context.workspaceState);
  viewState.publish();
  const provider = new OutlineProvider();
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, dragAndDropController: DRAG_AND_DROP });
  // 拡張機能の開発用の起動では、VS Code は、編集から取り直すまでの待ち時間に平均を使わない（0.3.0版のチケット29）
  const development = [vscode.ExtensionMode.Development, vscode.ExtensionMode.Test].includes(context.extensionMode);
  const outline = new Outline(view, provider, viewState, new EditDelay(development));
  const navigator = new Navigator();
  const javaFiles = vscode.workspace.createFileSystemWatcher('**/*.java');

  context.subscriptions.push(
    // 「…」メニューの項目（「✓ なし」と「✓ 付き」の2つずつ）
    ...Object.entries(MENU_COMMANDS).flatMap(([id, change]) => [id, id + '.checked']
      .map((name) => vscode.commands.registerCommand(name, () => outline.setViewState(change(viewState))))),
    view,
    outline,
    navigator,
    vscode.commands.registerCommand(SELECT_COMMAND, (...args) => navigator.select(...args)),
    vscode.commands.registerCommand(SELECT_BY_KEY_COMMAND, () => navigator.selectByKey()),
    vscode.commands.registerCommand(COLLAPSE_ALL_COMMAND, () => outline.setAllOpen(false)),
    vscode.commands.registerCommand(EXPAND_ALL_COMMAND, () => outline.setAllOpen(true)),
    vscode.window.tabGroups.onDidChangeTabGroups(() => outline.onEditorChanged()),
    vscode.window.tabGroups.onDidChangeTabs((e) => outline.onEditorChanged(e)),
    vscode.window.onDidChangeTextEditorSelection((e) => outline.onCursorMoved(e)),
    vscode.languages.onDidChangeDiagnostics((e) => outline.onDiagnosticsChanged(e)),
    vscode.workspace.onDidChangeTextDocument((e) => outline.onDocumentChanged(e)),
    vscode.workspace.onDidOpenTextDocument((d) => outline.onDocumentOpened(d)),
    // エラー・警告（0.4.0版）：行の場所のファイルの装飾、閉じたファイルの問題の位置を捨てる、拡張機能が替わったら単語の決まりを読み直す
    vscode.window.registerFileDecorationProvider(outline.decorations),
    vscode.workspace.onDidCloseTextDocument((d) => outline.positions.forget(d)),
    vscode.extensions.onDidChange(() => wordPatterns.clear()),
    vscode.workspace.onDidChangeConfiguration((e) => outline.onConfigChanged(e)),
    // オーバーライド（0.5.0版）：ほかの Java のファイルが保存されたときと、ディスクの上で変わったときに、問い合わせ直す
    javaFiles,
    vscode.workspace.onDidSaveTextDocument((d) => outline.onJavaFileChanged(d.uri)),
    javaFiles.onDidChange((u) => outline.onJavaFileChanged(u)),
    javaFiles.onDidCreate((u) => outline.onJavaFileChanged(u)),
    javaFiles.onDidDelete((u) => outline.onJavaFileChanged(u)),
    view.onDidChangeVisibility(() => outline.onVisibilityChanged()),
    view.onDidExpandElement((e) => outline.onToggled(e.element, true)),
    view.onDidCollapseElement((e) => outline.onToggled(e.element, false)),
    view.onDidChangeSelection((e) => outline.onSelectionChanged(e)),
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
module.exports = { activate, deactivate, toSymbols, symbolAt, countRows, EditDelay, declarations, stripCode, javaIcon, addJavaIcons, iconSvg, iconUri, fieldType, OutlineProvider, Outline, Navigator, ViewState, MESSAGES, KIND_NAMES, LOADING_DELAY, EDIT_DELAY, EDIT_DELAY_MAX, EDIT_DELAY_DEFAULT, EDIT_DELAY_SAMPLES, EDIT_DELAY_FILES, JUMP_WAIT, JUMP_MIN_LINES, TOKENS_WAIT, RETRY_DELAY, RETRY_SLOW_DELAY, RETRY_FAST_PERIOD, OPEN_DELAY, DOUBLE_CLICK_TIME, KEY_WAIT, FOLLOW_DELAY, OPEN_STATES_SIZE,
  parseJsonc, wordPattern, wordPatterns, wordAt, markerRange, acceptEdit, ProblemPositions, assignProblems, problemDecoration, rowPlace, RowDecorations, eclipseProblem,
  SEVERITY, MARKER_TAKE, DECORATION_EVENT_SIZE, DECORATION_WAIT, DECORATION_LIMIT, PROBLEM_DOT,
  superLink, declText, abstractByText, signature, sameSignature, ParentFiles, linkedParentAbstract, findInHierarchy, overrideKind, overrideTargets, overrideFingerprint, OBJECT_METHODS, OVERRIDE_REQUERY_DELAY };
