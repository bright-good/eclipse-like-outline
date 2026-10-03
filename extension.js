// アウトライン (Eclipse)
// Java のアウトラインを、右側の専用の欄に表示する。
// 中身は redhat.java（jdt.ls）から受け取り、操作・挙動は VS Code 既存のアウトラインに合わせる。
'use strict';

const vscode = require('vscode');
const path = require('path');

const VIEW_ID = 'eclipseLikeOutline';

// 既存のアウトラインと同じ文言（日本語の言語パックの outlinePane より）
const MESSAGES = {
  loading: (name) => `'${name}' のドキュメント シンボルを読み込んでいます...`,
  noEditor: 'アクティブなエディターはアウトライン情報を提供できません。',
  noSymbols: (name) => `ドキュメント '${name}' にシンボルが見つかりません`,
};

// 既存のアウトラインに合わせた待ち時間（ミリ秒）
const LOADING_DELAY = 100; // これより遅いときだけ「読み込んでいます」を出す
const EDIT_DELAY = 350; // 入力が止まってから取り直すまで

// 種類ごとのアイコン（vscode.SymbolKind の順）。0.0.2 で Eclipse 風のアイコンに替える
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

function toRange(r) {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

// jdt.ls の DocumentSymbol（LSP の形）を、欄で使う形に直す。
// 既存のアウトラインと同じ検査をし、通らなければ例外を投げる（呼び出し元で「シンボルが見つかりません」にする）。
// 構文が壊れているとき、jdt.ls は名前の位置が範囲の外にある結果を返すことがあり、既存のアウトラインはそれを捨てる。
function toSymbols(list, parent) {
  const seen = new Map();
  return (list || []).map((x) => {
    if (!x.name) throw new Error('name must not be falsy');
    // 同じ名前の兄弟（匿名クラスなど）があっても id が重ならないよう、出てきた順の番号を付ける
    const n = seen.get(x.name) || 0;
    seen.set(x.name, n + 1);
    const sym = {
      id: (parent ? parent.id + '/' : '') + x.name + (n ? '#' + n : ''),
      name: x.name,
      detail: x.detail || '',
      kind: x.kind - 1, // LSP は 1 始まり、vscode.SymbolKind は 0 始まり
      range: toRange(x.range),
      selectionRange: toRange(x.selectionRange),
      parent,
      children: [],
    };
    if (!sym.range.contains(sym.selectionRange)) throw new Error('selectionRange must be contained in fullRange');
    sym.children = toSymbols(x.children, sym);
    return sym;
  });
}

// --- 欄の中身 ---

class OutlineProvider {
  constructor() {
    this.roots = [];
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  setRoots(roots) {
    this.roots = roots;
    this.changed.fire();
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
    return item;
  }
}

// --- 追従と表示の切り替え ---

class Outline {
  constructor(view, provider, java) {
    this.view = view;
    this.provider = provider;
    this.java = java; // redhat.java の API を返す Promise（使えなければ null を返す）
    this.uri = null; // 表示中のファイル
    this.showingTree = false;
    this.generation = 0; // 古い問い合わせの結果を捨てるための番号
    this.pending = false; // 欄が隠れている間に更新が必要になった
    this.editTimer = null;
  }

  showMessage(text) {
    this.showingTree = false;
    this.provider.setRoots([]);
    this.view.message = text;
  }

  showTree(roots) {
    this.showingTree = true;
    this.view.message = undefined;
    this.provider.setRoots(roots);
  }

  // 既存のアウトラインと同じく、エディタグループのアクティブなエディタだけを見る
  // （下のパネルの出力やターミナルにフォーカスが移っても替えない）
  activeUri() {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab && tab.input instanceof vscode.TabInputText ? tab.input.uri : null;
  }

  async findDocument(uri) {
    const key = uri.toString();
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (open) return open;
    try {
      return await vscode.workspace.openTextDocument(uri);
    } catch {
      return null;
    }
  }

  // エディタが替わったときに呼ぶ。同じファイルのままなら何もしない
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

  async refresh() {
    clearTimeout(this.editTimer);
    if (!this.view.visible) {
      this.pending = true;
      return;
    }
    this.pending = false;
    const generation = ++this.generation;
    const uri = this.activeUri();
    this.uri = uri;
    if (!uri) return this.showMessage(MESSAGES.noEditor);

    const name = path.posix.basename(uri.path);
    // 欄にツリーが出ていないときだけ、遅ければ「読み込んでいます」を出す（既存と同じ）
    const loading = this.showingTree
      ? null
      : setTimeout(() => {
        if (generation === this.generation) this.showMessage(MESSAGES.loading(name));
      }, LOADING_DELAY);

    let result;
    try {
      const doc = await this.findDocument(uri);
      const api = doc && doc.languageId === 'java' ? await this.java : null;
      result = api ? await api.getDocumentSymbols({ textDocument: { uri: uri.toString() } }) : null;
    } catch (e) {
      console.error('[eclipse-like-outline]', e);
      result = null;
    }
    clearTimeout(loading);
    if (generation !== this.generation) return;

    if (!result) return this.showMessage(MESSAGES.noEditor);
    let roots;
    try {
      roots = toSymbols(result, null);
    } catch {
      roots = [];
    }
    if (roots.length === 0) return this.showMessage(MESSAGES.noSymbols(name));
    this.showTree(roots);
  }
}

async function activateJava() {
  const ext = vscode.extensions.getExtension('redhat.java');
  if (!ext) return null;
  try {
    return await ext.activate();
  } catch (e) {
    console.error('[eclipse-like-outline]', e);
    return null;
  }
}

function activate(context) {
  const provider = new OutlineProvider();
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider });
  const java = activateJava();
  const outline = new Outline(view, provider, java);
  const refresh = () => outline.refresh();

  context.subscriptions.push(
    view,
    vscode.window.tabGroups.onDidChangeTabGroups(() => outline.onEditorChanged()),
    vscode.window.tabGroups.onDidChangeTabs(() => outline.onEditorChanged()),
    vscode.workspace.onDidChangeTextDocument((e) => outline.onDocumentChanged(e)),
    // 言語モードの切り替え（Java に変えた、Java から外した）
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (outline.uri && d.uri.toString() === outline.uri.toString()) refresh();
    }),
    view.onDidChangeVisibility(() => {
      if (view.visible && outline.pending) refresh();
    }),
  );

  // jdt.ls の準備が整ったら取り直す（起動直後に空の結果が返ることがあるため）
  java.then((api) => {
    if (!api) return;
    if (api.onDidServerModeChange) context.subscriptions.push(api.onDidServerModeChange(refresh));
    if (api.serverReady) api.serverReady().then(refresh, () => {});
  });

  refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
