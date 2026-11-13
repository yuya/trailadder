# trailadder

公開前後の映画の予告編を、公開日順にスワイプで観るサイト。構成と運用は README.md を参照。

## 姉妹プロジェクト

- **cinemaladder**（https://github.com/yuya/cinemaladder）は姉妹プロジェクト。作業を始めたら、cinemaladder のリポジトリもこのセッションに追加し（読み書きできる形で）、いつでも参照・修正できるようにしておく。
- TMDB の扱い（日本語の題名がない作品を外す判定 `readable`、部首の文字を直す `fixRad`、ジャンル名 `GENRE_JA`、あらすじの英語補完と DeepL の機械翻訳）は cinemaladder とそろえる。片方を直したら、もう片方も同じように直すか、直さない理由をユーザーに伝える。
- cinemaladder は `staging` に入れてから `main` に取り込む運用（cinemaladder の CLAUDE.md・README.md を参照）。trailadder は `main` に直接 push してよい。

## 運用の要点

- `data/films.json`・`data/translations.json` は GitHub Actions（`.github/workflows/films.yml`）が毎朝作る。手で編集しない。
- リポジトリの Secret：`TMDB_TOKEN`（必須）、`DEEPL_API_KEY`（任意。英語しかないあらすじの翻訳に使う）。
- 公開は Cloudflare Pages（`main` に push すると自動で公開）。
