# Microsoft Store の更新を自動で提出する

公開済みの Local TeX Web Editor に対して，テスト済みの MSIX，英語・日本語の説明文，画像を GitHub Actions から提出する．製品 ID は `9P6QF32N19HG` である．Microsoft が審査を完了すると，更新を Store に公開する．

最初に Partner Center と自動提出用の Microsoft Entra アプリを関連付け，GitHub に接続情報を登録する．その後は，新しいバージョンのテストと GitHub Release の公開が完了すると，同じバージョンを Store へ提出する．前の提出が審査中の場合は待機し，6 時間ごとの実行で最新の公開済みリリースを調べ直して提出を再試行する．[Microsoft の提出 API の説明](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)

## 初回に用意するもの

対象のアプリについて，Partner Center で最初の提出と年齢区分の回答を済ませ，Store で公開済みであることを確認する．次に **Account settings → User management → Microsoft Entra applications** を開けることを確認する．

Entra アプリの登録に使える画面や権限は，開発者アカウントによって異なる．特に個人アカウントでは，この項目を利用できることを先に確認する．Microsoft は個人アカウントに複数のユーザーを追加できないと説明しているが，その説明だけではサービス用アプリの登録可否までは確認できない．項目が見つからない場合は，登録しているアカウントで MSIX submission API を利用できるかを [Microsoft の開発者サポート](https://developer.microsoft.com/windows/support/) へ確認する．[ユーザー管理の説明](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/manage-users-in-partner-center)

### 1. Microsoft Entra アプリを関連付ける

1. Partner Center の **Account settings** から，使用する Microsoft Entra テナントを関連付ける．既存のテナントがある場合は，そのテナントの管理者権限を持つアカウントで進める．
2. Microsoft Entra の **App registrations** で，自動提出に使うアプリを登録する．表示名は，例えば `Local TeX Web Editor Store publishing` とする．
3. Partner Center の **User management → Microsoft Entra applications** で，そのアプリを追加し，**Manager** の役割を付ける．
4. 登録したアプリの **Directory (tenant) ID** と **Application (client) ID** を控える．
5. アプリの **Client secrets** で新しい secret を作る．作成直後に表示される **Value** を，次の GitHub の Secret 欄に直接入力する．有効期限も控える．

画面の操作と必要な権限は，[提出 API の初回設定](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services#step-1-complete-prerequisites-for-using-the-microsoft-store-submission-api) を参照する．

### 2. GitHub に接続情報を登録する

[このリポジトリの Actions secrets](https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/settings/secrets/actions) を開き，**New repository secret** で次の 3 件を登録する．

| Name | 入力する値 |
| --- | --- |
| `PARTNER_CENTER_TENANT_ID` | Directory (tenant) ID |
| `PARTNER_CENTER_CLIENT_ID` | Application (client) ID |
| `PARTNER_CENTER_CLIENT_SECRET` | Client secret の Value |

Client secret の Value は，リポジトリのファイルやチャットには記載しない．期限を更新したときは，同じ名前の GitHub Secret の値も更新する．

### 3. 提出する内容を確認する

1. [GitHub Actions](https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/actions/workflows/submit-microsoft-store.yml) で **Prepare and submit Microsoft Store updates** を開く．
2. **Run workflow** で `main` を選ぶ．**store_run_id** には，提出するリリースと同じ `main` のコミットで成功した **Build Microsoft Store package** の実行番号を入力する．実行ページの URL の `/actions/runs/` に続く数字を使う．
3. **operation** を `prepare` にして実行する．
4. 完了した実行の **Artifacts** から，対象のタグが付いた `store-submission-<タグ>` をダウンロードする．例えば v0.1.18 の場合は `store-submission-v0.1.18` となる．`metadata.json` に説明文と各画像の説明，`prepared/plan.json` に提出予定のファイル，`prepared/submission.zip` に MSIX と画像が入っている．

この操作は，GitHub にあるテスト済みファイルを確認し，提出に使うファイルを作る．Microsoft の提出 API への接続は行わないので，接続情報の登録前にも実行できる．Store 用の MSIX と `microsoft-store-listing.zip` は，対象バージョンの GitHub Release にも添付する．

### 4. 自動提出を有効にする

[Actions variables](https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/settings/variables/actions) で，次の Repository variable を追加する．

| Name | Value |
| --- | --- |
| `MICROSOFT_STORE_AUTOMATIC_SUBMISSION` | `true` |

初回に接続と提出を確認するには，同じ workflow をもう一度 **Run workflow** から開く．準備したファイルと同じ `store_run_id` を指定し，`operation` を `submit` にして実行する．

以後のバージョンでは，次の条件がそろったときに自動で進む．

- `main` の同じコミットで，Windows / Mac の **Build and test** と，実際の MSIX をインストールする **Build Microsoft Store package** が成功している．
- そのコミットを指す正式な GitHub Release が公開され，最新の正式版になっている．
- `MICROSOFT_STORE_AUTOMATIC_SUBMISSION` が `true` で，3 件の Secret が登録されている．

上の 2 件の workflow が完了したときに加え，6 時間ごとにも実行する．定期実行では，最新の正式な GitHub Release のタグからコミットを確認し，そのコミットで成功した Windows / Mac と Store 用の workflow を探す．両方の成功を確認できた版を提出する．その間に別の版が公開された場合は，新しい正式版が次の対象となる．

定期実行では，最初に Microsoft Store の提出の状態と公開済みの版を確認する．前の提出を処理中の場合や，同じ版がすでに公開済みの場合は，その結果を記録して実行を終える．新しい提出が必要な場合に，テスト済みの MSIX，画像，説明文を取得する．

この確認結果は `store-publication-status/result.json` に書き，**microsoft-store-retry-status** の artifact に 14 日間保存する．`appVersion` と `storeVersion` は提出しようとしているアプリと Store パッケージのバージョンであり，`updateRequired: true` の場合にファイルの取得と提出へ進む．Store の公開版を確認できた場合は，そのパッケージのバージョンを `publishedStoreVersions` に記録する．

この変数を `false` にするか削除すると，定期的な再試行は止まり，ビルドの完了を受けた実行ではファイルの準備まで進む．すでに Store へ送った提出は，Microsoft 側で処理を続ける．

## 各バージョンで提出される内容

成功した Store 用 workflow の成果物から，MSIX と画像・説明文を取得する．ダウンロードした成果物の SHA-256，パッケージのバージョンと製品情報，スクリーンショットの取得元を確認する．

英語・日本語の説明文と特徴，画像の説明は，その成果物の `microsoft-store-listing.md` から読む．更新履歴には，同じ文書の **What's new** と **このバージョンの最新情報** を使う．文中のバージョンが MSIX と一致することも確認する．各バージョンの掲載文を直すときは，通常どおり [Store 用の文書](microsoft-store-listing.md) を更新する．

インストールした MSIX から撮影した 8 枚のスクリーンショットと，`store-logo-300.png` を使う．Markdown の画像は直接編集の画面である．価格，公開地域，年齢区分などは，最後に公開した Store の提出の設定を引き継ぐ．

提出 ID と，最後に取得した時点の状態は `prepared/result.json` に記録する．主な結果は次のとおりである．

| `outcome` | 状態と次の動作 |
| --- | --- |
| `submitted` | 提出を確定した．`published: false` の場合は Microsoft の審査や公開処理が続いている． |
| `deferred` | 前の提出を処理中である．その提出 ID と状態，`retryAfterPublication: true` を記録し，次の定期実行で確認し直す． |
| `already-published` | 対象の版が Store で公開済みである．公開済みの提出 ID を記録して終了する． |
| `blocked` | 編集中の提出，認証の問題など，確認が必要な内容を記録する．結果のエラーと実行ログに沿って対応する． |

公開の状態は，次の確認用 workflow でも取得できる．[Microsoft の提出の状態](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-status-for-an-app-submission)

## 提出後の公開状況を確認する

[Check Microsoft Store publication](https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/actions/workflows/check-microsoft-store-publication.yml) は，提出用の workflow が成功した後と，その後は 6 時間ごとに，Microsoft Store の現在の状態を取得する．`MICROSOFT_STORE_AUTOMATIC_SUBMISSION` が `true` のときに動作する．手動で確認する場合も，同じページの **Run workflow** から実行できる．

実行の **Summary** には，製品 ID，提出 ID，状態，公開済みかどうかを表示する．同じ内容を `microsoft-store-publication-status` の `result.json` に保存する．対象は，処理中の提出があればその提出，なければ最後に公開した提出である．提出処理が返した ID と照合して，対象の更新の進行を確認する．

`CommitStarted` は提出内容の受付処理中，`PreProcessing` は前処理中，`Certification` は審査中，`Published` は公開済みを表す．Microsoft が失敗の状態を返した場合，確認用の workflow も失敗として終了する．[各状態の説明](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-status-for-an-app-submission)

状態の取得には GET リクエストを使う．

## 既存の提出がある場合

Partner Center に審査中や公開処理中の提出がある場合は，`outcome: deferred` として，その提出 ID と状態を保存して実行を終える．6 時間ごとの提出用 workflow が Microsoft 側の状態を確認し，前の処理が完了したら，その時点で最新の公開済みリリースを提出する．待機している間にさらに新しいリリースが公開された場合も，最新の版を使う．

Store で同じバージョンが公開済みなら，`outcome: already-published` として公開済みの提出 ID を記録する．次の提出の作成は，より新しい版を公開したときに進む．Store ですでに新しい版が公開されている場合は，古いパッケージを送る操作を停止する．

編集中の提出や Microsoft が失敗を報告した提出がある場合は，`outcome: blocked` として理由を表示する．元の提出を扱った手順で内容を確認し，完了または取り消した後に提出用 workflow を再実行する．

API から作成した提出を編集するときは，引き続き API を使用する．Microsoft は，同じ提出を Partner Center の画面から編集すると，API からの変更や確定ができなくなる場合があると説明している．[提出 API に関する注意](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)

## 実装と確認

Workflow は [submit-microsoft-store.yml](../.github/workflows/submit-microsoft-store.yml)，テスト済みリリースの取得は [prepare-store-release.mjs](../scripts/prepare-store-release.mjs)，Microsoft への提出は [submit-microsoft-store.mjs](../scripts/submit-microsoft-store.mjs) にある．

提出処理のテストは Microsoft へ接続せず，API の応答を用意して実行する．実際のアカウントの認証と提出は，初回設定後の `submit` で確認する．

```bash
node --test tests/prepare-store-release.test.mjs tests/microsoft-store-submission.test.mjs
```

パッケージ，掲載情報，画像を ZIP にまとめてアップロードし，提出を確定する手順は，[Microsoft の MSIX 用提出 API](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions#create-an-app-submission) に基づく．
