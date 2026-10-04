# 岩茶做青与焙火工序台（gbtearock）

面向武夷岩茶初制车间与茶厂的工艺留档工具：按山场批次记录晒青、做青、杀青、揉捻、焙火各道工序的温湿度与时长参数，并组织毛茶审评与拼配。核心动作是「**建山场与茶青批次 → 排做青轮次（摇青与静置交替）→ 录杀青揉捻参数 → 排焙火曲线与复焙安排 → 录审评评分 → 登记拼配方案**」。

纯前端单页应用，**无后端 / 无数据库服务 / 无 API 服务**，所有数据保存在访问者本机浏览器（IndexedDB）里。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先准备环境变量
cp .env.example .env

# 2. 一条命令构建并启动
docker compose up -d --build
```

启动后访问：**http://localhost:22823**

常用命令：

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `docker compose ps` |
| 查看日志 | `docker compose logs -f frontend` |
| 停止服务 | `docker compose down` |
| 改端口后重建 | 编辑 `.env` 中的 `FRONTEND_PORT` 后执行 `docker compose up -d --build` |
| 校验编排文件 | `docker compose config --quiet` |

> 顶层已写 `name: gbtearock` 兜底，即使本项目放在中文目录下，`docker compose config --quiet` 也不会因为项目名为空而报错。
> 端口覆盖：`.env` 里的 `FRONTEND_PORT` 是「宿主端口 → 容器 80」的左侧值，默认 `22823`。

---

## 二、项目简介

| 路由 | 模块 | 说明 |
| --- | --- | --- |
| `/gardens` | 山场与茶青批次台账 | 建山场（品种 / 土壤 / 海拔 / 朝向），卡片回显批次数、鲜叶合计与审评均分；登记批次并推进工序状态；**移走山场 / 批次入回收区（可恢复，容量 300 条明细，冲突不覆盖、列新旧工艺取舍）**；整库 JSON 导出 / 导入 |
| `/turns` | 做青轮次编排 | 摇青 / 静置交替时间线与累计时长、失水率走势；**HTML5 原生拖拽排序**写回 `roundNo`；复制上一轮参数后微调、参数模板存 / 套用 |
| `/fixing` | 杀青揉捻记录 | 锅温、杀青时长、揉捻压力与时长、操作人登记；登记后自动把批次回写为「已杀青」 |
| `/roasting` | 焙火曲线与复焙安排 | 多道次按序排列（上移 / 下移写回 `passNo`）、足火判定（轻火 / 中火 / 足火）、复焙提醒（逾期 / 今日 / 7 日内 / 已排期） |
| `/reviews` | 毛茶审评 | 香气 30% / 汤色 20% / 滋味 35% / 叶底 15% 加权换算总分，按总分排序并生成拼配候选清单；做青 / 杀青 / 焙火参数变更后相关审评自动置「待复评」、退出候选，复评保存恢复 |
| `/blending` | 拼配方案登记与结构版本导出 | 按总分组合批次与占比、**占比校验（合计必须 100%）**、方案 JSON 与整库结构版本 JSON 导出；待复评批次不进入候选清单 |

批次工序状态按工序自动流转：**做青中 → 已杀青 → 已焙火 → 已审评**（只向后推进，不回退）。

---

## 三、技术栈

| 分类 | 选型 | 版本 |
| --- | --- | --- |
| 框架 | React | 18.3 |
| 语言 | TypeScript（`strict` + `noUnusedLocals/Parameters`） | 5.6 |
| UI 组件 | Ant Design（`@ant-design/icons`） | 5.22 |
| 构建 | Vite | 5.4 |
| 状态管理 | Zustand | 4.5 |
| 路由 | React Router（`createBrowserRouter`） | 6.28 |
| 本地数据库 | Dexie（IndexedDB 封装，含结构版本号与升级迁移） | 4.0 |
| 日期处理 | dayjs | 1.11 |
| 容器 | 多阶段构建：`node:20-alpine` → `nginx:alpine` | — |

---

## 四、本地开发

```bash
cd frontend
npm install
npm run dev       # http://localhost:22823
npm run build     # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview   # 预览 dist 产物，http://localhost:22823
```

---

## 五、目录结构

```
sologsb101-1023/
├── README.md                       # 本文档
├── docker-compose.yml              # 不写 version 字段；顶层 name: gbtearock
├── .env / .env.example             # COMPOSE_PROJECT_NAME / FRONTEND_PORT（内容一致）
├── .gitignore
├── sologsb101-1023.md              # 提示词原文（只读）
└── frontend/
    ├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip + /assets/ 长缓存
    ├── .dockerignore
    ├── package.json / package-lock.json
    ├── tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx                # 入口：ConfigProvider(zhCN) + AntdApp + RouterProvider
        ├── App.tsx                 # 外壳：侧边导航、当前山场/批次、行数统计、首次初始化 + 播种
        ├── vite-env.d.ts
        ├── styles/main.css         # 墨绿/茶褐/炭金主题与拖拽、时间线样式
        ├── types/                  # 六个实体各一文件
        │   ├── garden.ts           # 山场：name / altitudeM / soil / cultivar / aspect
        │   ├── batch.ts            # 茶青批次：gardenId / pickedAt / freshLeafKg / tenderness / weather / state
        │   ├── turn.ts             # 做青轮次：batchId / roundNo / shakeMin / restMin / roomTempC / humidityPct / waterLossPct
        │   ├── fix.ts              # 杀青揉捻：batchId / wokTempC / fixMin / rollPressure / rollMin / operator
        │   ├── roast.ts            # 焙火：batchId / passNo / tempC / hours / charcoal / nextRoastDate / state
        │   └── review.ts           # 审评：batchId / reviewedAt / 四项分 / totalScore / blendNote / invalid 待复评失效
        ├── stores/                 # Zustand：跨页状态全部放这里
        │   ├── gardenStore.ts      # 山场列表、派生指标、当前选中山场、筛选、移山场入回收区
        │   ├── batchStore.ts       # 批次与工序流转、杀青/审评/拼配筛选、杀青落库联动失效、拼配草稿、移批次入回收区
        │   ├── turnStore.ts        # 当前批次轮次、参数模板、拖拽重排（写回 roundNo）、参数变更联动审评失效
        │   ├── roastStore.ts       # 焙火道次顺序、复焙提醒、足火判定、焙火参数变更联动审评失效
        │   └── archiveStore.ts     # 回收区归档包列表 / 容量 / 恢复预检与取舍 / 清理
        ├── components/
        │   ├── common/             # GradeTag / FilterBar / StatBadge / EmptyPanel
        │   └── archive/ArchiveBin.tsx # 回收区面板：容量进度、恢复冲突新旧工艺取舍、清理
        ├── hooks/
        │   ├── useTurnTimeline.ts  # 轮次累计摇青/静置时长、交替时间线段、失水率走势
        │   └── useIdbTable.ts      # Dexie 表响应式订阅 + 增删改查封装
        ├── utils/
        │   ├── tea.ts              # 嫩度/火功枚举映射、温湿度与失水率区间判定、评分加权换算、拼配候选（排除待复评）
        │   ├── db.ts               # Dexie 实例、七张表、version(1/2/3) 迁移、播种、回收区归档/恢复、审评失效、快照导入导出
        │   └── export.ts           # 批次工艺记录 / 整库存档 / 拼配方案 JSON 导出与校验（兼容旧版存档）
        ├── pages/                  # 六个页面，与路由一一对应
        │   ├── GardenList.tsx      # /gardens
        │   ├── TurnBoard.tsx       # /turns
        │   ├── FixRecord.tsx       # /fixing
        │   ├── RoastPlan.tsx       # /roasting
        │   ├── ReviewBoard.tsx     # /reviews
        │   └── BlendPlan.tsx       # /blending
        └── router/index.tsx        # 路由表：/ 与未知路径重定向到 /gardens，页面懒加载
```

---

## 六、IndexedDB 库名与数据存储说明

- **库名**：`gbtearock`（`src/utils/db.ts` 中的 `DB_NAME`）
- **结构版本号**：`DB_VERSION = 3`
  - `version(1)` 初版结构：六张分表的最小索引
  - `version(2).stores(...)` 补齐外键 / 状态 / 日期索引，并 `.upgrade()` **真实迁移历史数据**：补齐 `createdAt` / `updatedAt`、山场补齐朝向与土壤品种兜底值、批次工序状态归一化、轮次与焙火数值截断到合法区间、审评总分由「四项简单平均」改为「分项加权换算」后重算。
  - `version(3)` 新增 **回收区 `archives` 表**（可恢复归档）与审评 **待复评失效字段**（`invalid` / `invalidReason` / `invalidatedAt`）。旧库升级时：① IndexedDB 对「只加字段」不自动重写已有行，因此 `initDatabase()` 内置幂等补齐，历史审评默认有效；② 导入旧版（v2）整库存档自动补空 `archives` 与 `invalid=false`。
- **分表**：`gardens`、`batches`、`turns`、`fixes`、`roasts`、`reviews`（每条记录都有 `id` / `createdAt` / `updatedAt`）+ 回收区 `archives`
- **首屏自动播种**：`initDatabase()` 中六张正式表与回收区都为空才播种（避免把全部数据移入回收区后刷新又灌演示数据），播种 3 层互相引用的演示数据 —— 3 个山场 → 4 个茶青批次 → 每个批次下 2-3 条做青轮次、1 条杀青揉捻、1-2 道焙火、1 条审评，父→子→孙贯通；播种使用固定 id + `bulkPut`，**幂等**，重复执行不会产生重复行。
- **可恢复归档（回收区）**：山场 / 批次页的「移走」不再硬删，而是在**单个 Dexie 事务**内把主体连同六个工序表的关联记录整包写入 `archives` 再从正式表移除，保留做青 `roundNo` / 焙火 `passNo` 原顺序与 `gardenId` / `batchId` 引用。
  - **容量上限 300 条明细**（山场包含山场行 + 批次 + 轮次 + 杀青 + 焙火 + 审评），满后抛 `ArchiveQuotaError` 拒绝新移入并提示清理；事务保证容量不足时正式数据不丢、回收区不产生半包。
  - **恢复**：`planRestore()` 预检同编号（同 id）冲突。无冲突整包写回；有冲突**默认不覆盖现有记录**，弹窗逐行列出「现有（新）/ 归档（旧）」关键工艺供人取舍（保留现有 / 用归档覆盖）。写回与回收区删除在同一事务，**中途失败回滚到操作前**，回收区与正式数据都可继续处理。
  - **清理**：可彻底删除单个归档包或清空回收区以腾容量。
- **工艺变更 → 审评失效待复评**：做青轮次新增 / 改参数 / 删除、杀青揉捻参数变更或删除、焙火道次新增 / 温时炭参数变更 / 删除，会把相关批次已有审评置为 `invalid=true`（仅改复焙日期、焙火状态或轮次 / 道次顺序不失效）。失效审评从**拼配候选清单剔除**，审评页与拼配页提示待复评；重新登记 / 复评保存即清除失效、恢复候选资格。
- **导出 / 导入**：山场页支持「导出整库 JSON / 导入 JSON」（Blob + `URL.createObjectURL` + `a.download`，导入前做结构与库名校验，旧版存档自动补齐 v3 字段，回收区随整库一并导出 / 导入）；拼配页支持拼配方案 JSON 与整库结构版本 JSON 导出。
- **无命名卷、无数据库服务**：容器只托管静态文件，数据完全存在浏览器本地，换浏览器或清空站点数据即清空。

---

## 七、常见问题

1. **端口被占用**：修改 `.env` 中的 `FRONTEND_PORT`（例如 `FRONTEND_PORT=22824`）后 `docker compose up -d --build`。
2. **刷新子路由 404**：已由 `nginx.conf` 的 `try_files $uri $uri/ /index.html;` 处理，`/gardens`、`/turns` 等路径可直接刷新。
3. **favicon 403**：`public/favicon.svg` 在宿主机上是 `0600` 权限，`COPY` 会保留权限位导致 nginx worker（uid=101）读不到；`Dockerfile` 在 `COPY --from=builder /app/dist` 之后紧跟 `RUN chmod -R a+rX /usr/share/nginx/html` 归一化权限，避免 403。
4. **数据只在本浏览器**：演示数据首次打开自动生成；想恢复初始状态可在浏览器 DevTools → Application → IndexedDB 删除 `gbtearock`，或重新导入一份整库存档。
5. **修改结构版本**：调整实体字段后请把 `DB_VERSION` 加一并补充 `.upgrade()` 迁移逻辑，否则老浏览器里的历史数据不会被修正。
