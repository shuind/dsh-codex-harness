# Release

For `@shuind/dsh-codex-harness`.

## 开发与部署注意事项

- 只允许修改和发布 `@shuind/dsh-codex-harness` 插件；不要修改、发布或安装 DSH 宿主包。
- 不要自行更新 Web profile 中已安装的插件版本。发布完成后，由用户手动执行更新。
- 不要自行重启 DSH，不要停止或替换正在运行的服务，不要占用或更换 `http://127.0.0.1:3080`。
- 不要直接修改 `$HOME/.dsh`、profile、运行时 bundle 或已安装的 `node_modules`。
- 不要启动第二个 DSH Web 服务来验证修改；验证现有的 `http://127.0.0.1:3080` 即可。
- 发布前只执行插件范围内的检查、测试、构建和 `pack --dry-run`；不要因为验证方便而更新运行环境。
- 如果插件需要宿主新增 slot 或宿主 bundle 修改，不能把宿主改动作为交付方案；应改为兼容当前宿主，或先向用户说明并等待明确授权。
- 发布后只核对 npm 版本和发布内容；不要把“npm 已发布”当成“运行中的 DSH 已更新”。

### 推荐交付流程

1. 修改插件源代码和插件测试。
2. 运行插件的 `check`、相关测试、`build` 和 `pack --dry-run`。
3. 递增插件版本并只发布插件。
4. 核对 npm 的版本和 `latest` dist-tag。
5. 把更新命令和重启要求交给用户，由用户手动更新并重启。

## Publish

Run from the repository directory:

```powershell
npm whoami
npm version <version> --no-git-tag-version
pnpm run check
pnpm test
pnpm run build
pnpm pack --dry-run
git add package.json
git commit -m "release: publish v<version>"
git tag v<version>
git push origin main --tags
npm publish --access public
npm view @shuind/dsh-codex-harness@<version> version
```

`npm publish` runs the package build through `prepare`. Publish only after the
dry-run contains the current `lib/` files and `presets/codex-collaboration/`.

## Authentication

An npm token may remain configured for future releases:

```powershell
npm config set "//registry.npmjs.org/:_authToken" "<TOKEN>"
```

Do not commit or paste the token. If npm requests two-factor authentication,
publish with `--otp=<code>` or use a token authorized to publish this package.

Token cleanup is optional; if the token is removed, run `npm login` or configure
another token before the next release.
