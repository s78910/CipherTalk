# ciphertalk-plugin-sdk

[CipherTalk（密语）](https://github.com/ILoveBingLu/CipherTalk) 插件开发 SDK 与脚手架 CLI。

插件是运行在沙箱中的纯前端应用，通过本 SDK 调用宿主能力：聊天数据查询、
媒体解密、语音转写、全文搜索、统计、导出、朋友圈、AI 等。

> 运行环境：浏览器 / 打包器（Vite、esbuild、Rollup）。SDK 依赖 `window`、
> `MessageChannel` 等浏览器 API，不用于纯 Node 环境。

## 安装

```bash
npm install ciphertalk-plugin-sdk
```

或用脚手架直接起步（无需先安装）：

```bash
npx ciphertalk-plugin init my-plugin           # 纯静态骨架
npx ciphertalk-plugin init my-plugin --vite     # Vite + TypeScript 模板
```

## 快速使用

```ts
import { connect } from 'ciphertalk-plugin-sdk'

const api = await connect()
const { sessions } = await api.data.sessions.list({ limit: 20 })
console.log(`共 ${sessions.length} 个会话`)
```

## CLI

| 命令 | 作用 |
|---|---|
| `ciphertalk-plugin init <目录> [--vite]` | 创建插件骨架（开发者名称必填），`--vite` 生成 Vite+TS 模板 |
| `ciphertalk-plugin pack [目录]` | 校验 manifest + 打包为 `<id>-<version>.ctp` |

## API 一览

`data`（会话/联系人/消息）、`media`、`stt`、`search`、`stats`、`export`、
`sns`、`ai`、`ui`、`storage`、`clipboard`、`notify`、`window`、`events`。
每类能力对应一个权限，在 `manifest.json` 声明、用户启用时确认。

完整参考（manifest 全字段、全 API、权限清单、UI 组件、限额、FAQ）见主仓库
[PLUGIN_DEV_GUIDE.md](https://github.com/ILoveBingLu/CipherTalk/blob/main/PLUGIN_DEV_GUIDE.md)。

## 版本

- `API_VERSION` — 本 SDK 实现的插件 API 主版本，须与 `manifest.apiVersion` 一致
- `SDK_VERSION` — SDK 语义化版本
- `await api.capabilities()` — 运行时探测宿主支持的方法集，用于优雅降级

## 许可

CC-BY-NC-SA-4.0，随主项目。
