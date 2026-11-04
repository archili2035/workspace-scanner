# workspace-scanner

WorkBuddy 多工作空间扫描与可视化清单。扫描本机所有 WorkBuddy 工作空间，判定活跃状态，生成可交互 HTML 仪表盘与 Markdown 清单。

线上视图：https://archili2035.github.io/workspace-scanner/

## 它做什么

- **双源判定**：主源 `~/.workbuddy/workbuddy.db` 的 `workspaces` 表（`path` + `last_opened_at`），兜底旧 `storage.json` 与聚合目录扫描
- **三档分类**：inUse（30 天内打开 / memory 有更新）/ historical / raw（裸目录）
- **描述回填**：从既有 Markdown 清单解析每个空间的用途描述
- **产物识别**：自动探测每个空间的主要产物（index.html / docs / outputs 等）
- **双格式输出**：`workspaces.html` 交互仪表盘（筛选/排序/列开关）+ `WORKSPACES.md` 清单
- **Explorer 联动**：本地 helper 在浏览器里直接打开目录/定位文件，带窗口置前

## 目录

```
├── portal.json          站点契约（xavierstudio-site-kit）
├── docs/                站点根（GitHub Pages 从此发布）
│   └── workspaces_index.html   仪表盘示例快照
└── tools/skill/         workspace-scanner skill 本体备份
    ├── SKILL.md         用法、流程、注意事项（权威文档）
    ├── scripts/
    │   ├── scan.js                扫描主脚本（sqlite-first）
    │   ├── build_html.js          生成 HTML（含 --share 分享版）
    │   ├── read_purpose.js        解读空间用途（MEMORY/daily/README）
    │   └── open_folder_server.js  Explorer helper（127.0.0.1:17365）
    └── references/
        └── report_template.md
```

## 快速使用

```bash
# 1. 扫描（输出 JSON）
node tools/skill/scripts/scan.js > scan_out.json

# 2. 生成 HTML
node tools/skill/scripts/build_html.js --in scan_out.json --out workspaces.html

# 3.（可选）启动 Explorer helper，让页面里的"打开目录"按钮生效
node tools/skill/scripts/open_folder_server.js
```

完整流程、判定口径、踩坑记录见 [`tools/skill/SKILL.md`](tools/skill/SKILL.md)。

## 说明

- `docs/workspaces_index.html` 是一次扫描的静态快照，仅作展示；Explorer 打开等本机功能在网页上不可用（helper 只在本地运行）
- skill 本体随本仓库同步更新，权威版本在 `~/.workbuddy/skills/workspace-scanner/`
