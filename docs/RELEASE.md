# 发布与验收

本项目独立的桥接代码使用 MIT。SnowLuma 是另外的依赖，其 source-available non-commercial 许可和 EULA 不等于 MIT；发布包不含 SnowLuma 或 QQ，不能用本项目许可覆盖它们。外部用户自行从官方渠道下载并按其条款使用。

## 本机生成公开包

```powershell
npm ci
npm run check
npm test
npm run smoke
npm run release
```

`dist/qq-codex-bridge-版本-windows.zip` 按 package.json 的显式文件名单生成。包含源码、锁定依赖清单、公开文档、测试和 CI；不含 node_modules、真实 config.json、state/、私人测试材料、日志或数据库。包内 `RELEASE-MANIFEST.json` 记录各文件 SHA-256，旁边 `.zip.sha256` 校验 ZIP。相同内容生成相同 ZIP。发布脚本还检查模板为空、敏感文件类型及常见密钥格式；这是额外检查，不能替代人工审查。

发布前在另一目录解压 ZIP，运行 `npm ci` 与 `npm run smoke`。smoke 复制源码到临时目录，用本机模拟 API 和 OneBot 完成首次启动、默认暂停、鉴权、模型测试、QQ 登录与私聊往返；不使用真实 QQ、真实模型或 Codex 登录。结束删除的只是它自己的临时目录。

CI 在 Windows/Ubuntu、Node 22.13/24 执行检查、测试和冒烟，上传 Windows ZIP 作为构建产物。它不自动公开发布、不调用付费模型、不连接真实 QQ。上传到 GitHub 后需查看首次 CI 是否成功；本地成功不能当作云端 CI 已通过。

## 外部试用门槛

- [ ] 至少一台不依赖开发者目录的 Windows 电脑按文档完成安装。
- [ ] 新用户分别完成 Codex 登录聊天和兼容接口聊天。
- [ ] 用其自己的 SnowLuma/机器人 QQ 验证群 @、管理员私聊、掉线重连。
- [ ] 在其 Windows 上验证截图 OCR 与语言包；用自定义路径读取正确账号消息库。
- [ ] 验证关闭、重启、备份恢复，确认配置、长期记忆与用量保留。
- [ ] 验证 API 慢响应/错误、无效令牌和退出 QQ 后的提示。
- [ ] 复核干净包和 Git 索引，确认没有私人数据或来源许可遗漏。

这些真实外部环境步骤尚需用户参与，模拟测试无法替代。不应把当前版本描述成跨平台一键可用；正式支持范围先限定 Windows 10/11 本地部署。

## GitHub 上传

在 GitHub 创建目标仓库后，把此目录的公开源文件提交。`.gitignore` 默认排除配置、运行状态与本地材料；推送前运行 `git diff --cached --stat` 并审查实际内容。README 中用实际仓库地址替换介绍链接后，可创建带版本号的 Release 上传 ZIP 和校验文件。没有用户指定目标仓库和账号时，准备包不等于已经上传。
