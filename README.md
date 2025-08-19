# AI Gateway Logs → GCS Poller

Cloudflare AI Gateway のログを GCS に保存し、BigQuery External Table で分析可能にする Worker です。

## 機能

- **前進取得**: `id > last_id` で新しいログを継続的に取得
- **バックフィル**: 直近 N 分のログを毎回取得（取りこぼし対策）
- **重複排除**: GCS の `ifGenerationMatch=0` で同じファイルの重複作成を防止
- **Hive パーティション**: `dt=YYYY-MM-DD/hour=HH` でBigQuery で効率的にクエリ可能
- **堅牢性**: Durable Object でチェックポイント管理・単一実行制御

## セットアップ

### 1. 設定値の更新

`wrangler.jsonc` の以下の値を環境に合わせて変更：

```jsonc
{
  "vars": {
    // GCS バケット名
    "GCS_BUCKET": "あなたのバケット名",
    
    // その他のパラメータは必要に応じて調整
  }
}
```

### 2. 必要なシークレットを設定

```bash
# Cloudflare API トークン（AI Gateway Logs 読み取り権限が必要）
wrangler secret put CF_API_TOKEN

# Cloudflare アカウント ID
wrangler secret put CF_ACCOUNT_ID

# AI Gateway の名前
wrangler secret put CF_GATEWAY_ID

# Google Service Account のメールアドレス
wrangler secret put GCP_SA_EMAIL

# Google Service Account の秘密鍵（PEM形式）
# -----BEGIN PRIVATE KEY----- から -----END PRIVATE KEY----- まで含む完全な形式
wrangler secret put GCP_SA_PRIVATE_KEY
```

### 3. 依存関係のインストールとデプロイ

```bash
# 依存関係をインストール
pnpm install

# TypeScript 型チェック
pnpm run typecheck

# ユニットテスト実行
pnpm run test:unit

# 統合テスト実行（fake GCS server が必要）
docker compose up -d
pnpm run test:integration
docker compose down

# 全テスト実行
pnpm test

# デプロイ
pnpm run deploy
```

### 4. 動作確認

```bash
# 手動実行テスト
curl https://cf-aigw-logs-poller.YOUR_SUBDOMAIN.workers.dev/run

# 成功時のレスポンス例
{
  "forward_pages": 3,
  "backfill_pages": 2,
  "uploaded": 127,
  "last_id": "01JXXXXXXXXXXXXXXXXXXXXX"
}
```

### 5. BigQuery External Table の作成

```sql
CREATE OR REPLACE EXTERNAL TABLE `your_project.ai_gateway.logs_ext`
OPTIONS (
  format = 'NEWLINE_DELIMITED_JSON',
  uris = ['gs://your-bucket-name/rows/dt=*/hour=*/*.jsonl'],
  hive_partitioning_mode = 'AUTO',
  hive_partitioning_source_uri_prefix = 'gs://your-bucket-name/rows/',
  require_hive_partition_filter = TRUE,
  autodetect = TRUE
);
```

## 運用

### Cron スケジュール

毎分実行される設定になっています：

```jsonc
"triggers": {
  "crons": ["* * * * *"]
}
```

### パフォーマンスパラメータ

`wrangler.jsonc` の `vars` で調整可能：

- `PER_PAGE`: API の1ページあたりのレコード数（デフォルト: 50）
- `PARALLEL_UPLOAD`: GCS への並列アップロード数（デフォルト: 24）
- `BACKFILL_MINUTES`: バックフィル窓の幅（デフォルト: 10分）
- `MAX_WALL_MS`: 1回の実行での最大実行時間（デフォルト: 20秒）
- `MAX_PAGES_PER_RUN`: 1回の実行での最大ページ数（デフォルト: 80）

### BigQuery でのクエリ例

```sql
-- 直近1時間のメトリクス
SELECT
  dt, hour, provider, model,
  COUNT(*) AS requests,
  SUM(tokens_in) AS tokens_in,
  SUM(tokens_out) AS tokens_out,
  APPROX_QUANTILES(duration, 101)[OFFSET(95)] AS p95_ms,
  SUM(cost) AS cost,
  AVG(IF(success, 1, 0)) AS success_rate
FROM `your_project.ai_gateway.logs_ext`
WHERE dt = FORMAT_DATE('%Y-%m-%d', CURRENT_DATE())
  AND hour = LPAD(CAST(EXTRACT(HOUR FROM CURRENT_TIMESTAMP()) AS STRING), 2, '0')
GROUP BY dt, hour, provider, model
ORDER BY requests DESC;
```

## テスト

### テストの種類

このプロジェクトには2種類のテストが含まれています：

1. **ユニットテスト** (`test/index.spec.ts`): 基本的な関数とエンドポイントのテスト
2. **統合テスト** (`test/integration.spec.ts`): fake GCS server を使った実際のアップロードテスト

### テスト実行

```bash
# ユニットテストのみ実行
pnpm run test:unit

# 統合テスト実行（Docker が必要）
docker compose up -d
pnpm run test:integration  
docker compose down

# すべてのテスト実行（統合テストはスキップ）
pnpm test

# 統合テストも含めてすべて実行
docker compose up -d
RUN_INTEGRATION_TESTS=true pnpm test
docker compose down
```

### fake GCS server について

統合テストでは [fsouza/fake-gcs-server](https://github.com/fsouza/fake-gcs-server) を使用しています。これにより、実際のGCSアカウントなしでGCSアップロード機能をテストできます。

- ポート: `localhost:4443`
- テスト用バケット: `test-bucket`
- Docker Compose で自動起動・バケット作成

## トラブルシューティング

### よくあるエラー

1. **GCS アクセスエラー**: Service Account に Storage Object Admin 権限があるか確認
2. **API レート制限**: `PER_PAGE` や `PARALLEL_UPLOAD` を下げて調整
3. **タイムアウト**: `MAX_WALL_MS` や `MAX_PAGES_PER_RUN` を調整
4. **統合テストが失敗**: `docker compose up -d` でfake GCS serverが起動しているか確認

### ログの確認

```bash
# Worker のログを確認
wrangler tail

# 特定の実行状況を確認
curl https://cf-aigw-logs-poller.YOUR_SUBDOMAIN.workers.dev/run
```

### BigQuery でのデータ確認

```sql
-- パーティションの存在確認
SELECT
  dt,
  hour,
  COUNT(*) as file_count
FROM `your_project.ai_gateway.logs_ext`
WHERE dt >= FORMAT_DATE('%Y-%m-%d', DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY))
GROUP BY dt, hour
ORDER BY dt DESC, hour DESC;
```

## アーキテクチャ

- **Durable Object**: チェックポイント（`last_id`）の永続化と単一実行制御
- **前進取得**: `id > last_id` で効率的な増分取得
- **バックフィル**: 直近 N 分を毎回取得して取りこぼしを防止
- **GCS 新規作成**: `ifGenerationMatch=0` で重複ファイルの作成を防止
- **Hive パーティション**: BigQuery で効率的なクエリのため `dt=YYYY-MM-DD/hour=HH` 構造