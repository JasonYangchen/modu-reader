# 墨读 Modu Reader

一个零构建、隐私友好的本地 Markdown 双栏阅读器。文件只在浏览器中读取，不需要登录，也不会被上传到服务器。


<img width="2549" height="1403" alt="墨读封面" src="https://github.com/user-attachments/assets/2be5e036-416d-4d6c-bf7a-a4eb411ca4d0" />

## 为什么做这个项目

很多 Markdown 工具需要安装桌面应用、注册账号或把文件传到云端。墨读专注于一个更小的目标：打开网页，把本地 Markdown 拖进去，立即获得舒适、可同步滚动的阅读体验。

## 功能

- 本地文件选择和拖拽打开，支持 UTF-8 与常见 GB18030 中文文本
- 左侧原文编辑、右侧实时预览
- 依据章节锚点进行双向滚动同步，比单纯百分比同步更贴近内容
- 自动生成文档目录，支持点击跳转
- 文档内全文查找、结果计数和上下条导航
- GitHub Flavored Markdown：表格、任务列表、删除线、围栏代码块
- 代码块一键复制
- 明暗主题、阅读字号调整、专注阅读模式
- 下载 Markdown、导出独立 HTML、浏览器打印
- 可拖动分隔线，支持桌面端和移动端布局
- 无遥测、无网络请求、无内容持久化

## 快速开始

### Windows

双击仓库根目录中的 `启动墨读.cmd`。脚本会启动本地服务并打开浏览器，关闭命令窗口即可停止服务。

### Node.js

```bash
npm run serve
```

然后访问 `http://127.0.0.1:4173/`。

### Python

```bash
python -m http.server 4173
```

### 直接打开

也可以直接双击 `index.html`。本地文件选择和渲染仍然可用；受浏览器 `file://` 安全策略影响，内置示例可能无法自动载入。

## 使用方法

1. 点击右上角“打开 Markdown”，或把 `.md` 文件拖进页面。
2. 在左侧查看或编辑原文，右侧会实时更新。
3. 点击“目录”快速跳转章节；点击“查找”检索渲染后的内容。
4. 通过“专注”隐藏原文，只保留阅读视图。
5. 使用“保存 MD”“导出 HTML”或“打印”带走结果。

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl/Cmd + O` | 打开 Markdown |
| `Ctrl/Cmd + S` | 保存 Markdown 副本 |
| `Ctrl/Cmd + F` | 在预览中查找 |
| `Esc` | 关闭查找或目录 |
| `Alt + ←/→` | 上一条/下一条查找结果 |

## 项目结构

```text
modu-reader/
├─ assets/
│  ├─ app.css          # 界面与打印样式
│  ├─ app.js           # 浏览器交互
│  └─ core.js          # 可测试的纯函数
├─ examples/
│  └─ ARCHITECTURE.md  # 示例文档
├─ scripts/
│  ├─ serve.cjs        # 零依赖 Node 静态服务器
│  ├─ start.ps1        # Windows 启动器
│  └─ start.sh         # macOS/Linux 启动器
├─ tests/              # Node 内置测试
├─ vendor/             # 固定版本的 Marked 与许可证
├─ index.html
├─ LICENSE
└─ README.md
```

## 开发

项目没有构建步骤，也没有需要安装的 npm 依赖。修改文件并刷新浏览器即可。

运行检查：

```bash
npm test
npm run check
```

## 发布到 GitHub Pages

1. 将仓库推送到 GitHub。
2. 打开仓库的 **Settings → Pages**。
3. 在 **Build and deployment** 中选择从分支部署。
4. 选择 `main` 分支和根目录 `/`。

部署后，用户可直接打开网页并选择本地文件。文件内容仍然只在用户浏览器中处理。

## 隐私与安全

- 墨读不会主动发起网络请求，也没有分析统计代码。
- 文件内容保存在当前页面内存中，刷新或关闭页面后即消失。
- 主题、字号等界面偏好保存在浏览器本地存储中，不保存文档内容。
- Markdown 转换后的 HTML 会经过安全过滤，但仍建议只打开可信来源的文件。

安全问题请参阅 [SECURITY.md](SECURITY.md)。

## 参与贡献

欢迎提交问题、功能建议和 Pull Request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 第三方软件

项目内置 [Marked 17.0.5](https://github.com/markedjs/marked)，采用 MIT License。完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

墨读采用 [MIT License](LICENSE)。
