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

// 「シンボルが見つかりません」を出している間に問い合わせ直す間隔（ミリ秒）。
// VS Code 標準のアウトラインは、中身を返す拡張機能が増えたとき（JavaScript の機能が起動したときなど）に取り直すが、
// 拡張機能にはその知らせが来ないため。ファイルの中身も、中身を返す拡張機能も変わっていなければ、
// VS Code は前と同じ結果を返すので、問い合わせ直しても VS Code 標準のアウトラインと違う結果にはならない。
const RETRY_DELAY = 500; // 見つからなくなってから30秒の間
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

// 種類ごとのアイコン（vscode.SymbolKind の順）。0.2.0版で Eclipse 風のアイコンに替える
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
    item.iconPath = KIND_ICONS[sym.kind];
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
    this.emptyUri = null; // 「シンボルが見つかりません」を出しているファイル
    this.emptySince = 0; // そのファイルで見つからなくなった時刻
    this.disposed = false;
    this.changedAt = 0; // VS Code に最後に知らせた時刻
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
      this.emptyUri = null;
      return this.showMessage(MESSAGES.noEditor);
    }

    const name = path.posix.basename(uri.path);
    // ビューにツリーが出ていないときだけ、遅ければ「読み込んでいます」を出す（VS Code 標準のアウトラインと同じ）
    const loading = this.showingTree || retrying
      ? null
      : setTimeout(() => {
        if (generation === this.generation) this.showMessage(MESSAGES.loading(name));
      }, LOADING_DELAY);

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
    this.emptyUri = null;
    this.showTree(roots);
  }

  retryLater(uri) {
    const now = Date.now();
    if (this.emptyUri !== String(uri)) {
      this.emptyUri = String(uri);
      this.emptySince = now;
    }
    const delay = now - this.emptySince < RETRY_FAST_PERIOD ? RETRY_DELAY : RETRY_SLOW_DELAY;
    this.retryTimer = setTimeout(() => this.refresh(true), delay);
  }
}

function activate(context) {
  const provider = new OutlineProvider();
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider });
  const outline = new Outline(view, provider);
  const refresh = () => outline.refresh();

  context.subscriptions.push(
    view,
    outline,
    vscode.commands.registerCommand(SELECT_COMMAND, () => {}),
    vscode.window.tabGroups.onDidChangeTabGroups(() => outline.onEditorChanged()),
    vscode.window.tabGroups.onDidChangeTabs(() => outline.onEditorChanged()),
    vscode.workspace.onDidChangeTextDocument((e) => outline.onDocumentChanged(e)),
    // 言語モードの切り替え（中身を返す拡張機能が替わる）
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (outline.uri && d.uri.toString() === outline.uri.toString()) refresh();
    }),
    view.onDidChangeVisibility(() => {
      if (view.visible && outline.pending) refresh();
    }),
  );

  refresh();
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
module.exports = { activate, deactivate, toSymbols, OutlineProvider, Outline, MESSAGES, KIND_NAMES, LOADING_DELAY, EDIT_DELAY, RETRY_DELAY, RETRY_SLOW_DELAY, RETRY_FAST_PERIOD };
