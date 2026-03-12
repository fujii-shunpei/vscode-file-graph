# File Graph - VS Code Extension

ファイルの依存関係をインタラクティブなグラフで可視化する VS Code 拡張機能。

開いているファイルの `import` / `use` を解析し、DDD のレイヤー構造に沿った段組みレイアウトで表示します。タブを切り替えるだけでグラフが自動更新されます。

![概要](docs/screenshot.png)

## 特徴

- **レイヤー段組み表示** - Controller → UseCase → Service → Repository → Model の流れが上から下に一目でわかる
- **アクティブファイル追従** - タブを切り替えるだけでグラフが自動更新
- **双方向探索** - このファイルが使うもの＋このファイルを使っているもの
- **深さ制御** - 依存の深さを 1〜3 段階で切り替え
- **レイヤーフィルター** - 凡例クリックで特定レイヤーを表示/非表示
- **ホバーハイライト** - ノードにマウスを乗せると接続先だけ強調
- **クリックでジャンプ** - ノードをクリックするとそのファイルをエディタで開く
- **Force モード** - ボタンで自由配置のフォースグラフに切り替え可能
- **ドラッグ & ズーム** - ノードのドラッグ、マウスホイールでズーム

## 対応言語

| 言語 | 検出するパターン | 状態 |
|------|----------------|------|
| PHP / Laravel | `use App\...`, `require`, `include` | 対応済み |
| TypeScript / JavaScript | `import`, `require` | 予定 |
| Python | `import`, `from ... import` | 予定 |
| Go | `import` | 予定 |

PHP は `composer.json` の PSR-4 autoload 設定を読んでパス解決します。

## DDD レイヤー自動判定

ファイルパスからレイヤーを自動判定し、色分けします。

| レイヤー | 色 | 判定パターン |
|---------|-----|-------------|
| Route | 黄 | `routes/` |
| Controller | 水色 | `controllers/`, `*Controller.php` |
| Request | 紫 | `requests/`, `*Request.php` |
| UseCase | 緑 | `usecases/`, `actions/` |
| Service | 黄緑 | `services/`, `*Service.php` |
| Model | オレンジ | `models/`, `entities/` |
| Repository | 赤橙 | `repositories/`, `*Repository.php` |
| Event | ピンク | `events/`, `*Event.php` |
| Job | 紫 | `jobs/`, `*Job.php` |

## インストール

### ソースからビルド（推奨）

```bash
# 1. リポジトリをクローン
git clone https://github.com/fujii-shunpei/vscode-file-graph.git
cd vscode-file-graph

# 2. 依存インストール & ビルド
npm install
npm run compile

# 3. .vsix にパッケージング
npx @vscode/vsce package --allow-missing-repository

# 4. VS Code にインストール
code --install-extension file-graph-0.0.1.vsix
```

### .vsix から直接インストール

1. [Releases](https://github.com/fujii-shunpei/vscode-file-graph/releases) から `.vsix` ファイルをダウンロード
2. VS Code を開く
3. `Cmd+Shift+P` → `Extensions: Install from VSIX...` → ダウンロードした `.vsix` を選択

## 使い方

1. VS Code でプロジェクトを開く
2. PHP ファイルを開いた状態で `Cmd+Shift+P` → **`File Graph: Show Graph from Current File`**
3. 隣のパネルにグラフが表示される
4. 別のファイルタブに切り替えると自動でグラフが更新される

### 操作

| 操作 | 動作 |
|------|------|
| ノードをクリック | そのファイルをエディタで開く |
| ノードにホバー | 接続先をハイライト |
| ノードをドラッグ | 位置を移動 |
| マウスホイール | ズーム |
| 背景をドラッグ | パン（全体移動） |
| 左上 `1` `2` `3` | 依存の探索深さを変更 |
| 左上 `Force` | Force モード / レイヤーモード切替 |
| 左上 `Reset` | ズーム・パンをリセット |
| 右の凡例をクリック | レイヤーのフィルタリング |

## 開発

```bash
npm run watch    # ファイル変更を監視して自動コンパイル
```

VS Code で `F5` を押すと、拡張機能が読み込まれたデバッグ用ウィンドウが起動します。

## ライセンス

MIT
