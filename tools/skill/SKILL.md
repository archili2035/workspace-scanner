---
name: workspace-scanner
description: 扫描并维护 WorkBuddy 工作空间清单（v7 / sqlite-first + artifact/progress table
  + Explorer helper）。主数据源为 ~/.workbuddy/workbuddy.db 的 workspaces 表（含
  last_opened_at 时间戳），旧 storage.json 仅作兼容兜底。每次扫描会生成可交互表格
  HTML（支持列开关、排序、筛选、工作空间描述、主要产物链接、当前进展、Explorer 打开目录/定位文件，并由 helper 尝试切到前台）和
  Markdown 清单，并同步复制一份 workspaces.html 到当前工作空间根目录方便浏览；需要分享时可生成隐藏本机操作入口的纯静态
  workspaces_share.html。当用户说"扫描工作空间 / 看有没有新增空间 / 更新工作空间清单 / workspace 变更"等触发。
agent_created: true
---

# workspace-scanner

## 用途

维护一份准确的 WorkBuddy 工作空间清单：
1. **使用中**（inUse）：30 天内打开过，或 `.workbuddy/memory/` 30 天内有更新
2. **历史项目**（historical）：注册过但 30 天内没打开
3. **裸目录**（raw）：既无注册记录也无 `.workbuddy/memory/`
4. **散户/orphan**：文件系统里发现，但 sqlite + storage.json 都没记录

## 触发场景

- "扫描工作空间 / 扫一下工作空间"
- "有没有新增的工作空间"
- "更新工作空间清单"
- "workspace 变更 / 看看新增"
- "切换到 X 空间"前需要先确认 X 是否存在时

## 关键事实（写死在 skill 里）

### 重要前提：数据源切换

**新版 WorkBuddy PC 客户端把工作空间记录从 `storage.json` 迁到 `~/.workbuddy/workbuddy.db`（SQLite）。**

| 项 | 旧 | 新（当前权威） |
|---|---|---|
| 文件 | `AppData/Roaming/WorkBuddy/User/globalStorage/storage.json` | `~/.workbuddy/workbuddy.db` |
| 字段 | `profileAssociations.workspaces` 字典（key 是 `file:///c%3A/...` 编码 URI） | `workspaces` 表 `(path TEXT, last_opened_at INTEGER)` |
| 时间戳 | 隐式（无） | 显式毫秒时间戳，可直接给"最近打开"判定 |
| 路径大小写 | 编码后变小写 | **保留盘符原貌**（含大小写） |
| 当前状态 | 停写（自 2026-04-27） | 正常写入 |

旧 storage.json 还在（兼容用），但内容已 0 行，扫描时会回退到聚合目录扫描。

### 关键路径

| 用途 | 路径 |
|---|---|
| **workbuddy.db**（主源） | `C:/Users/archili/.workbuddy/workbuddy.db` |
| storage.json（兜底） | `C:/Users/archili/AppData/Roaming/WorkBuddy/User/globalStorage/storage.json` |
| Markdown 清单（落盘目标） | `C:/Users/archili/.workbuddy/memory/WORKSPACES.md` |
| HTML 清单（落盘目标） | `C:/Users/archili/.workbuddy/memory/workspaces.html` |
| 临时扫描 JSON | `C:/Users/archili/AppData/Local/Temp/scan_out.json` |
| Python（读 sqlite 用） | `C:/Users/archili/.workbuddy/binaries/python/versions/3.13.12/python.exe` |
| Explorer helper | `C:/Users/archili/.workbuddy/skills/workspace-scanner/scripts/open_folder_server.js` |

> 不要用 `MEMORY.md` 作为清单文件名（会被覆盖）。
> Windows node 不认 `/tmp`，临时文件用 `C:/Users/archili/AppData/Local/Temp/`。

### 聚合目录清单读取位置

读 `WORKSPACES.md` 顶部的 **"聚合目录清单"** section。
当前默认：`E:\WorkBuddyRepo`。
如果用户提到"我新空间都在 X 目录下"，把 X 加进 WORKSPACES.md 的聚合目录清单。

## 执行流程

### Step 1 — 扫描（scan.js v3）

```bash
node "C:/Users/archili/.workbuddy/skills/workspace-scanner/scripts/scan.js" \
  > "C:/Users/archili/AppData/Local/Temp/scan_out.json"
```

scan.js 会：
1. 通过 python 子进程读 `workbuddy.db` 的 `workspaces` 表（path + last_opened_at）
2. 读 storage.json 拿旧路径集合（兜底）
3. 扫聚合目录下的一级子目录（兜底）
4. 把三方并集作为候选 space 集合
5. 对每个 space 探测 `.workbuddy/memory/`：是否存在、有无 MEMORY.md、最近 daily、最后 mtime、daily 数量
6. 分类：inUse（30 天内打开/有 memory 更新） / historical / raw
7. 从 `WORKSPACES.md` 既有表格解析用途/备注，写入每个 space 的 `description` 字段；新空间无描述时用"待补充"兜底
8. 探测主要产物：先查 `ARTIFACT_OVERRIDES` 手工覆盖表；否则优先根目录 `index.html`/HTML 文件直链；多个 HTML 或 dist/build/docs/output/artifacts 等目录则链接目录；否则回退到工作目录/主要文件
9. 生成 `progress`：基于最近 daily、描述、活跃状态推断"当前进展；下一步"的简短文本
10. 输出 JSON：`{ spaces, orphans, dbOnly, storageOnly, summary }`
11. summary 含：`primarySource`（sqlite | storage.json | filesystem-only）、`dbRowCount`、`storageRowCount`、`byCategory`、`byRegistry`（dbHit/storageHit/miss）

### Step 2 — 生成 HTML（build_html.js）

```bash
node "C:/Users/archili/.workbuddy/skills/workspace-scanner/scripts/build_html.js" \
  --in  "C:/Users/archili/AppData/Local/Temp/scan_out.json" \
  --out "C:/Users/archili/.workbuddy/memory/workspaces.html"
```

HTML 是单文件、内联 CSS/JS、暗色主题、**交互表格视图**，包含：
- 顶部 stat 卡：总数 / 使用中 / 历史项目 / db 登记数 / 未注册数
- 数据源信息条：sqlite 主源时显示绿色 banner（含 db 行数）；fallback 时显示橙色 banner
- 表格列：状态、名称、描述、主要产物、当前进展、路径、最近打开、daily 数、盘符、Memory 更新、最近 daily、登记、位置
- 默认显示列与顺序：状态 / 名称 / 描述 / 主要产物 / 当前进展 / 路径 / 最近打开 / daily 数
- 列显示开关：用户可勾选显示/隐藏任意列
- 排序规则：最近打开升/降序、名称、状态、daily 数、盘符；表头点击也可切换常用排序
- 筛选条件：关键词（名称/路径/描述/产物/进展）、状态、盘符、登记状态、是否有 memory
- 描述字段：来自 `WORKSPACES.md` 的用途/备注列；新空间无描述时显示待补充
- 主要产物：HTML 文件保留 `file:///...` 网页直链，同时提供"定位文件"；目录/文件提供"打开目录/定位文件"和"复制路径"
- 路径列：提供"Explorer 打开"和"复制路径"
- Explorer 打开依赖本地 helper：`http://127.0.0.1:17365/open?path=...`，前端通过隐藏 iframe 导航触发（避免 `file://` 页面跨源 fetch 限制），helper 只允许打开扫描结果中工作空间及其子路径
- 当前进展：基于最近 daily + 描述 + 活跃状态生成简短"当前；下一步"

### Step 3 — 同步 HTML 到当前工作空间

每次生成全局 HTML 后，必须再复制一份到**当前工作空间根目录**，方便在当前项目中直接打开和预览：

```bash
cp "C:/Users/archili/.workbuddy/memory/workspaces.html" "<当前工作空间>/workspaces.html"
```

当前工作空间路径以会话上下文/实际 cwd 为准，不要写死；本 skill 自己维护时通常是 `E:/WorkBuddyRepo/WorkbuddySpaceManager/workspaces.html`。

如果用户需要发给别人看，再生成一份分享版到当前工作空间根目录：

```bash
node "C:/Users/archili/.workbuddy/skills/workspace-scanner/scripts/build_html.js" \
  --in  "C:/Users/archili/AppData/Local/Temp/scan_out.json" \
  --out "<当前工作空间>/workspaces_share.html" \
  --share
```

分享版是单文件静态快照，隐藏 Explorer/helper/file 本机操作入口，只保留表格、筛选、排序、路径文本和产物信息，适合直接发送给其他人浏览。

### Step 3.5 — 同步到部署仓库（GitHub Pages）

扫描生成的 HTML 是静态快照，线上站点不会自己更新；**每次成功生成全局 HTML 后，必须把快照同步进部署仓库并推送**，否则 https://archili2035.github.io/workspace-scanner/ 会一直停留在旧数据。

```bash
cd "E:/WorkBuddyRepo/workspace-scanner"
cp "C:/Users/archili/.workbuddy/memory/workspaces.html" "docs/workspaces_index.html"
git add docs/workspaces_index.html
git diff --cached --quiet || git commit -m "sync: 更新仪表盘快照 $(date +%F)"
git push
```

要点：
- 部署仓库固定为 `E:/WorkBuddyRepo/workspace-scanner`（archili2035/workspace-scanner，Pages 从 `/docs` 发布）
- `git diff --cached --quiet` 保证数据没变化时不产生空提交；push 失败（断网/凭据过期）不阻塞扫描主流程，报告用户即可
- 若本次同时改了 skill 本体（SKILL.md/scripts），把 `~/.workbuddy/skills/workspace-scanner/` 下对应文件同步进仓库的 `tools/skill/` 后一并提交
- 部署仓库结构由 xavierstudio-site-kit 规范维护（portal.json + docs/ + theme），不要手改 theme 文件

### Step 4 — 启动 Explorer helper（需要目录/文件定位时）

```bash
node "C:/Users/archili/.workbuddy/skills/workspace-scanner/scripts/open_folder_server.js"
```

helper 会监听 `127.0.0.1:17365`，接口：
- `GET /`：跳转到 `/workspaces.html`
- `GET /workspaces.html`：用 HTTP 托管工作空间清单页，避开 `file://` unique origin 限制
- `GET /health`：检查服务状态
- `GET /logs?limit=80`：查看 helper 服务端调试日志
- `GET /open?path=<encoded path>`：用 Windows Explorer 打开目录，或定位文件；打开后通过 PowerShell COM 枚举 Explorer 窗口，匹配目标目录 HWND，并调用 `ShowWindowAsync` + `SetForegroundWindow` 尝试切到前台

安全边界：
- 只读 `scan_out.json` 的工作空间根路径作为白名单
- 只允许打开工作空间根路径或其子路径
- 目录打开调用 `cmd.exe /c start`，文件定位调用 `explorer.exe /select,<path>`；前台切换只调用本机 PowerShell + Win32 `user32.dll` 窗口 API，不执行来自请求参数的任意命令
- HTML 里服务不可用时，会尝试复制路径并提示启动命令

### Step 5 — 更新 Markdown 清单（WORKSPACES.md）

读旧 WORKSPACES.md，按 inUse/historical/raw 分组重排，append 历史变更。若发现新空间用途仍是“待补充”，先执行 Step 6 解读并把简短用途写回本表，再重新跑一次 scan.js + build_html.js，并再次执行 Step 3 复制当前工作空间 HTML，确保全局 HTML 与当前工作空间 HTML 的 description 都同步更新。

### Step 6 — 解读用途（仅对新增/有变化的空间）

对**首次出现**或**memory 口径变了**的空间，调用 `read_purpose.js` 解读：

```bash
node "C:/Users/archili/.workbuddy/skills/workspace-scanner/scripts/read_purpose.js" "E:/WorkBuddyRepo/HongkongGTA"
# 必须用正斜杠！
```

优先级：MEMORY.md → 最新 daily → README.md → none

## 关于注册表的写操作

**保守原则：永远不写注册表**（既不写 sqlite 也不写 storage.json）。

理由：
1. 直接改 `workbuddy.db` 可能与客户端事务冲突，造成数据库损坏
2. 真正的入口是 WorkBuddy 客户端"打开工作空间"动作
3. orphan 清单本身就是给团队报问题用的现成证据

## 使用示例

用户："扫描一下最新工作空间"
→ 跑 Step 1-5（含同步一份 HTML 到当前工作空间）→ 默认自动落盘 HTML + Markdown → 简短报告告诉用户总数 / inUse 数 / 新增空间 / HTML 路径

用户："切换到 stock"
→ 先读 WORKSPACES.md 找到路径 → 切换 → 不需要重新扫描

用户："我新空间都在 D:\NewRepo 下"
→ 把 `D:\NewRepo` 加进 WORKSPACES.md 的聚合目录清单 → 再跑一次完整扫描

## 注意事项

1. **跨磁盘**：清单覆盖 C/D/E 三盘，扫描时要全跑。
2. **路径大小写**：sqlite 里盘符大小写保留原貌（`c:\` / `C:\` 都可能出现），合并时用 `path.toLowerCase()` 作 key；同一路径多次录入时取 `last_opened_at` 最大那条。
3. **20260317232323**：时间戳目录名是 WorkBuddy 自动生成的临时空间，标记"待清理"。
4. **sqlite 读取方式**：用 `python.exe -c` 短脚本读，避免引入 better-sqlite3 等本地依赖。Python 路径写在 `scan.js` 顶部 `PYTHON` 常量。
5. **bash / inline Node 反斜杠陷阱**：在 bash 里调脚本时**必须用正斜杠路径**（`E:/WorkBuddyRepo/X`），否则 `\W \D \P \H` 等会被 shell 当转义吃掉。若用 `node -e` 写路径匹配/覆盖表，不要在普通 JS 字符串里写 `"e:\workbuddyrepo\x"` 这类路径，`\w` 等会被 JS 字符串吞掉反斜杠；应使用正斜杠、`String.raw`，或先统一转成 `/` 再比较。read_purpose.js 已加路径规范化，但 for 循环拼路径时仍要用 `/`。
6. **历史变更只追加**：append-only。
7. **storage.json 兜底语义**：当 sqlite 行数为 0 时，HTML 会自动切到 storage.json 主源；都为 0 时切到 filesystem-only 模式并显示警示条。
8. **描述来源**：优先从既有 `WORKSPACES.md` 表格的用途/备注列按路径匹配；因此不要随意删除这些描述，否则下一次 HTML 会回退到"待补充"。新增空间如果先生成了 fallback 描述，必须先修正 `WORKSPACES.md` 中该行用途，再重新运行 `scan.js` 和 `build_html.js`，否则 HTML/JSON 仍会保留 fallback。
9. **HTML 双份输出**：全局 HTML 仍固定写入 `C:/Users/archili/.workbuddy/memory/workspaces.html`；每次扫描/重建后还要复制一份到当前工作空间根目录 `workspaces.html`，方便从当前项目直接浏览。若后续因为描述补齐而重新跑 scan/build，复制动作也必须重新做一次。
10. **分享版 HTML**：当用户要分享给其他人时，用 `build_html.js --share` 生成 `<当前工作空间>/workspaces_share.html`。分享版不连接 DB，不调用本地 helper，不提供 Explorer 打开/定位文件按钮；路径仅作为静态文本保留。注意：WorkBuddy 文件分享链接（`codebuddy.work/agents/share/...`）会走腾讯云文档/文件预览包装，不会把上传的 HTML 当网页直接执行；分享版 HTML 上传后可能显示空白/无数据。若要让别人直接看到可交互网页，应部署到静态托管（EdgeOne Pages/GitHub Pages/CloudBase 等）或让对方下载 HTML 后本地打开。
11. **主要产物覆盖**：少数空间需要人工指定产物时，改 `scan.js` 顶部 `ARTIFACT_OVERRIDES`。当前覆盖：Health → `E:/WorkBuddyRepo/Health/outputs/health_dashboard.html`；stock → `D:/stock/index_rebuild.html`。
12. **Explorer helper**：如果用户需要点击表格直接打开 Windows Explorer，先确保 `open_folder_server.js` 在后台运行；服务只监听 `127.0.0.1`，并只允许打开 `scan_out.json` 中工作空间及子路径。推荐从 `http://127.0.0.1:17365/workspaces.html` 打开清单，不要直接打开 `file:///.../workspaces.html`。调试日志写入 `C:/Users/archili/.workbuddy/memory/workspace-open-helper.log`，也可访问 `/logs` 查看。目录打开使用 `cmd.exe /c start "" <path>`，文件定位使用单参数 `explorer.exe /select,<path>`；打开后会尝试用 PowerShell COM 精确匹配目标 Explorer 窗口并调用 `SetForegroundWindow` 切到前台，接口返回 `focused` / `focusMethod` / `focusError` 等字段。改 helper 后必须重启服务进程。
13. **HTML 模板转义**：`build_html.js` 是模板字符串生成 HTML，若要在生成出的浏览器 JS 字符串里保留换行转义，必须写 `\\n`（不是 `\n`），否则会生成真实换行并触发 `Uncaught SyntaxError: Invalid or unexpected token`。
14. **Explorer 前端触发方式**：不要用 `fetch()` 从 `file://` 页面请求 helper，部分浏览器/预览容器会拦截；使用隐藏 iframe 设置 `src=http://127.0.0.1:17365/open?...` 更稳。
15. **新发现空间的 last_opened_at 解读**：sqlite 里 `last_opened_at` 是首次或最近一次客户端"激活"该工作空间的时间，可能晚于目录实际创建时间——所以"最近打开"≠ "最近活跃"，inUse 同时参考 memory mtime 是有意义的。
16. **Explorer 置前限制**：Windows 有前台窗口锁定机制，`SetForegroundWindow` 不是 100% 保证抢焦点；当前只实现第一级温和置前（`ShowWindowAsync` + `SetForegroundWindow`），不做 `TOPMOST/NOTOPMOST` 强制置顶 fallback，除非用户明确要求增强。
17. **PowerShell 子进程环境变量**：调用 PowerShell 做 Explorer 置前时，不要完整继承 `process.env`；WorkBuddy 会话环境变量可能超过 Windows 65535 字符限制，导致 `Add-Type` 报错。只传必要变量和 `WB_FOCUS_TARGET`。
