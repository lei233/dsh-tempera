# dsh-tempera

[English](README.md) | 简体中文

让委派工作经过检验，成为可信结果。

`dsh-tempera` 计划构建一个面向委派工作的持久化 Task Manager，以
[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)
作为可插拔的 Harness 内核。Tempera 拥有工作的生命周期，执行能力由 Harness
提供；执行权限与验收权限相互独立。

## 当前状态

本仓库目前**只有工程骨架**：双包 workspace、构建与检查工具，以及 CI。
两个源码入口均为空模块。尚未实现 Task 管理、公共业务 API、DSH 接入、provider、
持久化或业务测试，也未配置发布流程。

## 目录结构

```text
packages/
  domain/       @dsh-tempera/domain — 预留给 Task 语义与不变量
  runtime/      @dsh-tempera/runtime — 预留给 Task Manager 协调逻辑
docs/           预留文档目录，目前仅包含 .gitkeep
```

所有包均为 private，初始版本为 `0.0.0`，当前互不依赖。未来允许的依赖方向为
`runtime → domain`，禁止 `domain → runtime`。领域包应独立于 DSH、具体 provider、
存储实现和 Node.js 全局对象，其 TypeScript 配置不自动引入 Node.js 类型。

## 开发环境

- Node.js 声明支持范围：`^22.19.0 || >=24.0.0`。
- 开发与 CI 基线：**Node.js 22.23.1**，记录于 `.nvmrc`。
- 包管理器：**pnpm 9.15.4**，记录于 `packageManager`。

已安装 nvm 时，使用以下命令选择开发版本：

```sh
nvm install
nvm use
```

确认 `pnpm --version` 输出 `9.15.4`，然后安装依赖：

```sh
pnpm install --frozen-lockfile
```

开发工具集中声明在根包，版本采用兼容范围；提交的 `pnpm-lock.yaml` 固定实际解析
版本。锁文件与依赖声明不一致时，冻结安装会失败，不会自动改写锁文件。
本期验证与 CI 仅使用 Node.js 22.23.1，尚未对声明范围建立多版本测试矩阵。

## 开发命令

在仓库根目录执行：

| 命令                 | 用途                                                      |
| -------------------- | --------------------------------------------------------- |
| `pnpm build`         | 使用 tsdown 构建两个包                                    |
| `pnpm typecheck`     | 使用 TypeScript 检查工具配置与两个包                      |
| `pnpm lint`          | 运行 Oxlint correctness 检查                              |
| `pnpm lint:fix`      | 应用 Oxlint 自动修复                                      |
| `pnpm format`        | 使用 Oxfmt 默认风格格式化文件                             |
| `pnpm format:check`  | 只检查格式，不改写文件                                    |
| `pnpm test`          | 在 Node 环境运行一次 Vitest                               |
| `pnpm test:watch`    | 以 watch 模式运行 Vitest                                  |
| `pnpm check:exports` | 通过包名加载两个包，需先构建                              |
| `pnpm check`         | 依次执行 lint、格式检查、类型检查、测试、构建和包入口检查 |

两个包也支持单独检查与构建：

```sh
pnpm --filter @dsh-tempera/domain typecheck
pnpm --filter @dsh-tempera/domain build
pnpm --filter @dsh-tempera/runtime typecheck
pnpm --filter @dsh-tempera/runtime build
```

TypeScript 使用 strict、ESM 和 NodeNext 模块解析。tsdown 仅输出不压缩的 ESM，
各包产物为 `dist/index.js` 与 `dist/index.d.ts`，包入口指向这些生成文件。
构建产物不提交到仓库。

Vitest 已配置，但**目前没有测试文件**。后续测试从 `packages/*/src/**/*.test.ts`
和 `packages/*/tests/**/*.test.ts` 发现。当前空测试运行会成功退出，并明确报告未找到
测试文件，这不代表业务正确性已被验证。引入业务测试后应移除允许空测试的配置。

格式化排除本地交接资料、依赖、生成文件、缓存、覆盖率文件及生成的锁文件。
EditorConfig 统一 UTF-8、LF、2 空格缩进和文件末尾换行，不安装 Git hooks。

## 持续集成

GitHub Actions 在 push 和 pull request 时触发，使用 Ubuntu、Node.js 22.23.1、
pnpm 9.15.4 和只读仓库权限，执行冻结锁文件安装、lint、格式检查、类型检查、测试、
构建与包入口加载验证。不执行发布或部署。
