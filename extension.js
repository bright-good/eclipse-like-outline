// アウトライン (Eclipse)
// ファイルのシンボルを、右側の独自のビュー「アウトライン (Eclipse)」に表示する。
// 中身は VS Code 標準のアウトラインと同じところ（vscode.executeDocumentSymbolProvider が中で呼ぶ、VS Code の内部のコマンド）から受け取り、
// 操作・挙動は VS Code 標準のアウトラインに合わせる。Java の中身は redhat.java（jdt.ls）が返す。
'use strict';

const vscode = require('vscode');
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
  return (list || []).map((x) => {
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
    // チャットとターミナルは、その中身を読む（0.3.0版）
    item.resourceUri = rangeUri(sym);
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
  onDocumentOpened(doc) {
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

  // 問題が変わった知らせ。VS Code 標準のアウトラインは、出しているファイルの問題が変わると行を出し直し（VS Code が返した順から並べ直す）、
  // そのときにも選ぶ
  onDiagnosticsChanged(e) {
    if (!this.tracking || !e.uris.some((u) => String(u) === String(this.uri))) return;
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
    if (!this.uri || e.document.uri.toString() !== this.uri.toString()) return;
    if (e.contentChanges.length === 0) return;
    clearTimeout(this.editTimer);
    const removed = e.contentChanges.reduce((n, change) => n + change.rangeLength, 0);
    this.editTimer = setTimeout(() => this.refresh(false, removed), this.editDelay.get(e.document));
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
    if (!java) return this.showFile(roots, uri, version);

    // トークンは、シンボルが返ってから TOKENS_WAIT だけ待つ。間に合えば、アイコンを入れてから行を出す。
    // 間に合わないか、まだ取れない（jdt.ls の準備の途中）ときは、前に同じファイルで決めたアイコン（なければ VS Code 標準のアイコン）で
    // 行を出し、トークンが返ってから入れる
    const extra = await within(tokensQuery, TOKENS_WAIT);
    if (generation !== this.generation || this.disposed) return;
    this.remember(uri);
    const iconsReady = !!extra && this.applyIcons(roots, extra, doc);
    if (!iconsReady) this.applyRememberedIcons(roots);
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
  // メニューの出し分けの値は、ビューの見出しのメニューが読むので、先に入れる
  const viewState = new ViewState(context.workspaceState);
  viewState.publish();
  const provider = new OutlineProvider();
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, dragAndDropController: DRAG_AND_DROP });
  // 拡張機能の開発用の起動では、VS Code は、編集から取り直すまでの待ち時間に平均を使わない（0.3.0版のチケット29）
  const development = [vscode.ExtensionMode.Development, vscode.ExtensionMode.Test].includes(context.extensionMode);
  const outline = new Outline(view, provider, viewState, new EditDelay(development));
  const navigator = new Navigator();

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
    vscode.workspace.onDidChangeConfiguration((e) => outline.onConfigChanged(e)),
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
module.exports = { activate, deactivate, toSymbols, symbolAt, countRows, EditDelay, declarations, stripCode, javaIcon, addJavaIcons, iconSvg, iconUri, fieldType, OutlineProvider, Outline, Navigator, ViewState, MESSAGES, KIND_NAMES, LOADING_DELAY, EDIT_DELAY, EDIT_DELAY_MAX, EDIT_DELAY_DEFAULT, EDIT_DELAY_SAMPLES, EDIT_DELAY_FILES, JUMP_WAIT, JUMP_MIN_LINES, TOKENS_WAIT, RETRY_DELAY, RETRY_SLOW_DELAY, RETRY_FAST_PERIOD, OPEN_DELAY, DOUBLE_CLICK_TIME, KEY_WAIT, FOLLOW_DELAY, OPEN_STATES_SIZE };
