# delegate-claude 改修仕様

## 目的

**delegate-claude** は、CodexがClaudeへ相談、設計、レビュー、実装、テストを委譲するための共通ゲートウェイである。

システムは次の2要素で構成する。

- **delegate-claude MCP server**：Claude Agent SDKのセッション、実行、権限判断、質問待ち、結果取得をMCPとして提供する。
- **delegate-claude skill**：Codexが依頼内容から実行権限を選び、MCP serverを呼び出し、Claudeとユーザーの対話を中継する。

MCP serverは [xihuai18/claude-code-mcp](https://github.com/xihuai18/claude-code-mcp) のcommit [`47aa47b`](https://github.com/xihuai18/claude-code-mcp/commit/47aa47b4f7f02f5dd5c6bc9174d30a42f54484f2) を基に改修する。既存の非同期実行、イベント取得、セッション継続、権限応答、キャンセル、コスト集計を引き継ぐ。

delegate-claudeは開発工程に依存しない。開発工程でいつ、どのモデルへ、何を委譲するかは、delegate-claudeを呼ぶ側が決定する。

## 実行構成

処理は次の順序で進む。

```text
ユーザー
  ↓
Codex
  ↓ delegate-claude skill
delegate-claude MCP server
  ↓
Claude Agent SDK
  ↓
Claude Code
```

各要素の責務は次のとおりとする。

| 要素 | 責務 |
|---|---|
| ユーザー | 作業目的、権限、Claudeから返された質問への回答を決定する |
| Codex | ユーザーの依頼範囲を保持し、Claudeへの委譲と最終報告に責任を持つ |
| delegate-claude skill | モデル、権限、作業ディレクトリ、セッション再利用を選び、質問と結果を中継する |
| MCP server | Agent SDKの実行、セッション状態、イベント、権限要求、質問待ちを管理する |
| Claude | コードベースと利用可能なskill・MCPを読み、委譲された作業と検証を実行する |

MCP serverはローカルのstdio transportで起動し、Codexと同じホストのファイルシステムを利用する。

## 依存バージョン

Claude Agent SDKは `0.3.220` に固定する。[npm package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.220)

`package.json` とlockfileは同じバージョンを指し、範囲指定を使用しない。SDKを更新する場合は、後述する実サービス検証をすべて再実行する。

Claude Code実行ファイルは、SDKに同梱されたバージョンを標準とする。`pathToClaudeCodeExecutable` が指定された場合はその実行ファイルだけを使用し、解決または起動できなければセッション開始を失敗させる。

Claudeの設定は次のsourceから読み込む。

```json
["user", "project", "local"]
```

これにより、ユーザー設定、プロジェクト設定、ローカル設定、`CLAUDE.md` をClaude Codeと同じ規則で利用する。

## MCPツール

既存の4ツールを維持する。

| ツール | 責務 |
|---|---|
| `claude_code` | 新しいClaudeセッションを開始する |
| `claude_code_reply` | 既存セッションへ追加の依頼または回答を送る |
| `claude_code_check` | 実行イベント、質問、権限要求、最終結果を取得する |
| `claude_code_session` | セッションの取得、一覧、割り込み、キャンセルを行う |

ツール名を変更せず、delegate-claude skillを安定した利用窓口とする。

## セッション開始

`claude_code` に次の入力を追加する。

```ts
type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

interface ClaudeCodeInput {
  prompt: string;
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  systemPrompt?: string | {
    type: "preset";
    preset: "claude_code";
    append?: string;
  };
  advanced?: ClaudeCodeAdvancedOptions;
}
```

`permissionMode` の標準値は `default` とする。

`permissionMode: "bypassPermissions"` は、同じrequestで `allowDangerouslySkipPermissions: true` が指定された場合だけ受理する。この組み合わせでは、Agent SDKへ次の値を渡す。

```ts
{
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true
}
```

`allowDangerouslySkipPermissions: true` が他のpermission modeと組み合わされた場合は `INVALID_ARGUMENT` を返す。

セッション開始結果には実際に使用されたモデル、Claude Codeバージョン、permission modeを含める。

```ts
interface SessionStartResult {
  sessionId: string;
  status: "running";
  pollInterval: number;
  model?: string;
  claudeCodeVersion?: string;
  permissionMode: PermissionMode;
  resumeToken?: string;
}
```

モデルが利用できない場合はセッションを失敗させ、別モデルへ切り替えない。

## セッション継続

`claude_code_reply` は、同じClaudeセッションの会話履歴とコードベース理解を再利用する。

追加依頼で権限を変更する必要がある場合に備え、次の入力を追加する。

```ts
interface ClaudeCodeReplyInput {
  sessionId: string;
  prompt: string;
  forkSession?: boolean;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  thinking?: ThinkingConfig;
}
```

`permissionMode` を省略した場合は、セッションが保持する値を使用する。変更する場合は、セッション開始と同じ組み合わせ検査を行う。

これにより、同じClaudeセッションで設計を相談した後、ユーザーが実装を許可した時点で権限を変更できる。

## ユーザー質問の中継

Claudeが `AskUserQuestion` を呼び出した場合、MCP serverは通常の権限要求と区別して `user_question` actionを生成する。

```ts
interface UserQuestionAction {
  type: "user_question";
  requestId: string;
  toolUseId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
      preview?: string;
    }>;
    multiSelect: boolean;
  }>;
  createdAt: string;
  expiresAt: string;
}
```

質問文、選択肢、説明、順序はClaudeが生成した内容を保持する。

`claude_code_check` に `respond_user_input` actionを追加する。

```ts
interface RespondUserInput {
  action: "respond_user_input";
  sessionId: string;
  requestId: string;
  answers: Record<string, string>;
  response?: string;
  annotations?: Record<
    string,
    {
      preview?: string;
      notes?: string;
    }
  >;
}
```

`answers` のkeyには質問文を使用する。複数選択の回答は、Claude Agent SDKの契約に従ってカンマ区切りの文字列にする。

MCP serverは元の `AskUserQuestion` inputへ回答を追加し、待機しているAgent SDK callbackへ返す。同じClaudeセッションが回答後の処理を続行する。

質問待ちは次のいずれかで終了する。

- `respond_user_input` による回答
- `claude_code_session` によるキャンセル
- MCP serverの終了
- 設定された質問待ち時間の超過

質問待ち時間の標準値は30分とする。時間を超過した場合はClaudeへ未回答を明示し、セッション結果に `USER_INPUT_TIMEOUT` を記録する。

この質問中継はすべてのpermission modeで動作し、`bypassPermissions` でも `AskUserQuestion` を自動回答しない。

## 権限要求

Claudeのツール利用にユーザー承認が必要な場合、`claude_code_check` は既存の `permission` actionを返す。

```ts
interface PermissionAction {
  type: "permission";
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  createdAt: string;
  expiresAt: string;
}
```

Codexは依頼範囲と一致する操作だけを承認する。`allow_for_session` は、同じClaudeセッションで同種の操作を継続してよい場合に使用する。

`disallowedTools` に含まれるツールは、後続の承認要求によって許可できない。

`bypassPermissions` では通常のpermission actionを生成しない。ユーザー質問は権限要求とは別に中継する。

## delegate-claude skill

skill名は `delegate-claude` とする。

skillは相談専用と実装専用の入口を分けず、ユーザーの依頼から権限を選択する。

| 依頼 | permission mode | 振る舞い |
|---|---|---|
| 相談、調査、設計、レビュー | `default` | 読み取り系ツールを事前許可し、変更操作はCodexへ承認を求める |
| 実装、修正、テスト | `acceptEdits` | ファイル編集を許可し、shellや外部操作は必要に応じてCodexへ承認を求める |
| 権限確認を省略した委譲 | `bypassPermissions` | ユーザーが明示的に許可した作業範囲で全ツールを実行する |
| 実行を伴わない計画 | `plan` | Claudeのplan modeを使用する |

skillは次の規則でセッションを扱う。

- 同じ目的、同じコードベース、同じ判断系列の依頼は既存sessionを再利用する。
- 独立した作業、異なるコードベース、独立レビューは新しいsessionを開始する。
- 権限だけが変わる場合は `claude_code_reply` で既存sessionを継続する。
- Claudeが質問した場合はユーザーへ提示し、回答を同じsessionへ返す。
- モデルが指定されている場合はその値を渡す。
- モデルが指定されていない場合はAgent SDKの設定を使用し、実際に使用されたモデルを結果から確認する。
- `fallbackModel` を設定しない。

Claudeへ実装を委譲した場合、同じClaudeセッションが対象コードの変更と必要なローカル検証を完了する。Codexは最終結果と実際の差分を確認してからユーザーへ報告する。

## 状態管理

実行中のsession、イベント、保留中の権限要求、保留中の質問はMCP serverのmemoryで管理する。

Claudeの会話履歴はAgent SDKのsession persistenceを利用する。MCP serverは独自の会話DBを持たない。

disk resumeを有効にする場合は、既存のresume tokenとHMAC検証を使用する。MCP server再起動時に失われた保留中の権限要求や質問は復元せず、再開されたClaudeセッションが必要な要求を再発行する。

## イベント取得

`claude_code` と `claude_code_reply` はsessionを開始して速やかに返る。Codexは `claude_code_check` をcursor付きで呼び出し、差分イベントを取得する。

部分的なassistant messageは `includePartialMessages` が有効な場合にeventとして返す。MCP serverはCodexの会話表示へ直接書き込まず、取得可能な構造化eventを返す。

完了結果には次を含める。

```ts
interface AgentResult {
  sessionId: string;
  result: string;
  isError: boolean;
  model: string;
  claudeCodeVersion: string;
  permissionMode: PermissionMode;
  durationMs: number;
  durationApiMs?: number;
  numTurns: number;
  totalCostUsd: number;
  usage?: Record<string, unknown>;
}
```

## エラー

MCP serverは少なくとも次のerror codeを返す。

| code | 条件 |
|---|---|
| `INVALID_ARGUMENT` | 入力値、パス、permission modeの組み合わせが不正 |
| `SESSION_NOT_FOUND` | 指定sessionが存在せず、resumeも成立しない |
| `MODEL_UNAVAILABLE` | 指定モデルをClaudeが利用できない |
| `USER_INPUT_TIMEOUT` | Claudeからの質問へ期限内に回答がない |
| `PERMISSION_TIMEOUT` | 権限要求へ期限内に回答がない |
| `SDK_START_FAILED` | Agent SDKまたはClaude Codeを開始できない |
| `SDK_PROTOCOL_ERROR` | Agent SDKとのmessage契約を処理できない |
| `RESOURCE_EXHAUSTED` | session数、event buffer、予算の上限を超えた |

error responseには、機密情報を含まない原因と復旧可能性を含める。prompt、ユーザー回答、環境変数の値は標準ログへ出力しない。

## ローカル検証とCI

品質検査の正本は `Taskfile.yml` とする。

```bash
task ci
```

`task ci` は次の検査をこの順序で実行する。

```text
format check
→ lint
→ typecheck
→ unit test
→ build
→ MCP integration test
```

GitHub Actionsはclean checkoutから `task ci` を呼び出す。CI専用の検査コマンドを作らない。

Claude認証が必要な検証は次のコマンドへ分離する。

```bash
task verify:live
task verify:codex
```

- `task verify:live`：MCP serverからClaude Agent SDKへ実接続する。
- `task verify:codex`：Codexからstdio MCP serverを呼び出し、委譲を完了する。

これらのコマンドは認証情報の内容を出力しない。

## 必須テスト

unit testとMCP integration testは、次の契約を証明する。

1. 標準のsessionが `permissionMode: "default"` で開始する。
2. `bypassPermissions` と危険権限の明示フラグがAgent SDKへ渡る。
3. 危険権限の組み合わせが不正なrequestは開始前に失敗する。
4. 指定モデルが別モデルへ切り替わらない。
5. `AskUserQuestion` が `user_question` actionへ変換される。
6. 質問文、選択肢、複数選択設定が欠落せず返る。
7. `respond_user_input` の回答で同じClaudeセッションが再開する。
8. `bypassPermissions` でもユーザー質問が中継される。
9. 通常のpermission actionとuser questionが混同されない。
10. `claude_code_reply` が会話履歴を引き継ぐ。
11. reply時の明示的なpermission mode変更が反映される。
12. cursor付きpollで既読eventが重複しない。
13. cancelとinterruptが待機中のcallbackを解放する。
14. MCP server終了時に実行中のAgent SDK queryが停止する。
15. `user`、`project`、`local` の設定と `CLAUDE.md` が読み込まれる。
16. SDK同梱のClaude Codeが標準で選択される。
17. 明示されたClaude Code実行ファイルが利用できない場合に開始が失敗する。

## 実サービス受入条件

`task verify:live` は一時ディレクトリを使い、次の動作を実際のClaudeで確認する。

- `claude-opus-5` を指定し、結果の実効モデルが一致する。
- projectの `CLAUDE.md` に置いた固有の指示をClaudeが読み取る。
- Claudeがファイルを読み、編集し、検証コマンドを実行する。
- 最初のturnで与えた情報を、`claude_code_reply` 後も保持する。
- Claudeが `AskUserQuestion` を呼び、回答後に同じsessionで処理を続ける。
- `bypassPermissions` でファイル編集とコマンド実行がpermission待ちにならない。
- `bypassPermissions` でも `AskUserQuestion` はユーザー回答を待つ。
- 利用可能なskill、plugin、MCP serverの状態を初期化結果から取得できる。

`task verify:codex` はCodexからdelegate-claude skillを起動し、次の流れを完了する。

```text
CodexがClaudeへ作業を委譲
→ Claudeがユーザーへ質問
→ Codexが質問を表示
→ ユーザーが回答
→ Claudeが同じsessionで作業を継続
→ CodexがClaudeの結果と実際の変更を確認
→ Codexがユーザーへ完了を報告
```

## 完了条件

改修は次の条件をすべて満たした時点で完了とする。

- `task ci` がclean checkoutで成功する。
- `task verify:live` が現在のClaude Agent SDKとOpus 5で成功する。
- `task verify:codex` が質問中継を含む一連の委譲を完了する。
- consultation、review、implementation、testを同じMCP入口から実行できる。
- session継続、権限変更、キャンセルが実サービスで確認されている。
- MCP serverの再起動後に通常の新規sessionを開始できる。
- Codexへ表示されるモデル、session、最終結果が実際のAgent SDK結果と一致する。
- upstreamのMITライセンス表記と著作権表示を配布物へ保持する。
