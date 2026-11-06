# 大肥鱼记忆星图 · Dayu Memory Star

> 把智能体的长期记忆变成一片**可以漫游的星图**——每条记忆是一颗星星，最重要的那颗在中央。
> 内置**艾宾浩斯遗忘曲线 + 权重系统**的记忆模型：重要的留住，琐碎的自动淡出。
> 纯本地 JSON 存储 · 零依赖 · 零外部服务 · 无需 API Key。

- 插件名（npm / 安装 spec）：`dsh-dayu-memory-star`
- 版本：`1.1.1`
- 许可证：MIT
- 适配：DeepSeek Harness（DSH）≥ 0.1.5；记忆核心可独立用于 QQBridge / AstrBot / 任何 Node.js 项目

---

## 一、这是什么

一句话：**它不聊天，它负责"记得"。**

大多数智能体"有记忆"，其实只是把最近几十条聊天记录重新塞回上下文——越聊越贵，越聊越忘，重启就清空。本项目把记忆从"上下文窗口"里剥出来，变成一份**长期、可衰减、可检索、可视化的记忆库**：

| 传统做法 | 本插件 |
| --- | --- |
| 记忆 = 最近 N 条聊天记录 | 记忆 = 结构化的「卡片 + 细节」长期库 |
| 上下文一满就裁剪，早期的全丢 | 重要记忆永不过期，琐碎的按遗忘曲线淡出 |
| 记忆是黑盒，出了问题没法查 | 记忆是星图，一颗一颗可以点开看、可以改 |
| 换模型就失忆 | 记忆与模型解耦，存在本地 JSON 里 |

---

## 二、运行原理

### 2.1 三层结构

```
   ┌──────────────────────────────────────────┐
   │  Host 半侧（Node，跑在 DSH 宿主进程里）      │
   │  lib/index.js                            │
   │   · 注册 HTTP 路由 /dayu-memory-star/api   │
   │   · tapIndex 注入前端脚本到首屏 HTML        │
   │   · 注册智能体工具 dayu_memory_search /     │
   │     dayu_memory_remember                  │
   └───────────────┬──────────────────────────┘
                   │ 同一套函数调用
   ┌───────────────▼──────────────────────────┐
   │  记忆核心（纯 JS，零依赖）                  │
   │  lib/memory-core.js                       │
   │   · 相似度引擎（MinHash + Jaccard）        │
   │   · 权重 / 艾宾浩斯保留率 / 遗忘            │
   │   · 3 路检索注入 / 关系图 / 上下文统计       │
   │   · 读写 memory/cards.json + facts.json   │
   └───────────────┬──────────────────────────┘
                   │ 同源 fetch('/dayu-memory-star/api/…')
   ┌───────────────▼──────────────────────────┐
   │  浏览器半侧（IIFE，无依赖，无构建）           │
   │  lib/client.js                            │
   │   · Canvas 2D 手工投影的伪 3D 星图           │
   │   · 右侧 400px 侧栏：记忆 / 关系 / 上下文 / 状态 │
   └──────────────────────────────────────────┘
```

**为什么不用 client-plugin 打包链？** 因为本插件只需要"一页画布 + 一个接口"。Host 侧用 `webServer.tapIndex()` 把一小段脚本注入首屏 HTML，前端就是一个普通 `<script>`——不需要 React、不需要打包器、不需要 `pnpm build`。这也是社区插件能"装完即用、构建脚本默认不运行"的前提。

### 2.2 记忆的数据形态

记忆被拆成**摘要卡片（cards）** 与 **细节外挂（facts）** 两层，这是省 Token 的关键：

```json
// memory/cards.json —— 一句话摘要，用于检索与星图
{
  "id": "c1a2b3", "owner_id": "3387982960", "type": "preference",
  "summary": "主人喜欢在深夜写代码时喝冰美式，不加糖",
  "keywords": ["冰美式", "深夜", "写代码"],
  "important": true, "freq": 5,
  "created": 1793449182111, "last_used": 1793500000000,
  "weightOverride": null, "snippet": "……"
}

// memory/facts.json —— 挂在卡片下的原始细节，只在真正需要时展开
{ "id": "f9x8y7", "card_id": "c1a2b3", "fact": "10 月 30 日说便利店的冰美式比咖啡机的好喝", "origin": "qq", "ts": 1793500000000 }
```

检索时先匹配摘要（便宜），命中后再按需拉细节（贵）——这就是"摘要索引 + 细节外挂"。

### 2.3 写入流水线

```
消息进来
  │
  ├─ shouldExtract(text)        太短 / 纯闲聊 → 直接丢弃，不调 LLM（省钱）
  │
  ├─ extractMemory(...)         LLM 提炼成 [{type, text}]，失败则关键词兜底
  │
  ├─ classifyByKeyword(text)    rule / preference / goal / emotion / fact 五类
  │
  └─ addFact(ownerId, fact)
        │
        ├─ 与库中每张卡算相似度 similarity()
        │     └─ ≥ 0.85 → 合并进已有卡片（freq+1，刷新 last_used，更新摘要）
        └─ < 0.85 → 新建卡片
```

### 2.4 相似度引擎（为什么没装向量库）

只有本地算力，就不要假装有 embedding。这里用两个经典算法的**混合**：

- **MinHash**：把文本切成字符 3-gram，用 64 个哈希种子（`HASH_SEEDS=[31,131,137,139,149,151]` 派生）取最小哈希，得到 64 维签名，两签名逐位相等比例 ≈ Jaccard。
- **Jaccard**：去虚词（`/[的了啊呢吧吗呀嘛啥哦喔嘻呐]/g`）后的 3-gram 集合交集/并集。

```
similarity = 0.5 * minhash + 0.5 * jaccard
```

单用 MinHash 对"火锅"和"火锅了"太敏感（多了个虚词就不像），所以先 `normalize()` 去虚词，再两者平均——实测这类口语变体能正确合并。

> 已知局限：**同义替换抓不到**（"爱喝咖啡" vs "喜欢喝咖啡" 相似度只有 0.13）。这是无向量库的固有限制，换来的是：零依赖、零费用、零网络、数据不出本机。语义相近的复述会在若干轮内以两张卡并存，靠"最近 5 条 + 关键词检索"补上。

### 2.5 艾宾浩斯遗忘曲线 + 权重系统

记忆的保留率不是一个固定天数，而是**按重要度缩放的时间常数**：

```
weight      = important ? 1.0 : TYPE_BASE_WEIGHT[type] + min(freq,12) * 0.03
              （若手动设了 weightOverride，则直接用它，范围 0~1）
stability S = weight * 90 天
anchor      = max(created, last_used)        ← 被想起就会"续命"
retention   = e ^ ( -ageDays / S )
```

基础权重按类型给出"它值不值得留"的先验：

| 类型 | 含义 | 基础权重 |
| --- | --- | --- |
| `rule` | 硬规则 / 禁忌 | 1.00 |
| `preference` | 喜好与口味 | 0.90 |
| `goal` | 目标与计划 | 0.85 |
| `emotion` | 情绪与重要时刻 | 0.80 |
| `fact` | 普通日常事实 | 0.45 |

于是：一条 `fact` 若被反复提起（freq 高），权重会爬升、寿命变长；一条 `rule` 哪怕只说过一次，也几乎不衰减。

**遗忘判定**（`sweepMemory`）三条同时满足才会动：

1. `retention < 0.2`
2. 不是 `important`
3. `freq < 4`（被提过 4 次以上就免死）

**"忘掉"是软删除**：`sweepMemory` 只给卡片打上 `archived: true` 标记，**文件里一个字都不删**。
所以`想不起来 ≠ 彻底消失`——被归档的记忆可以在状态页的「已归档」里翻出来一键恢复；如果以后聊天里又提起同一件事，写入时还会**自动复活**它（不会重复造一张新卡）。
只有你明确点「清空已归档」，才会真正删掉文件里的记录。

也就是说，日常碎话大约几十天自然淡出，而"主人雷区""生日"这类东西永不过期。

### 2.6 上下文怎么取（不再靠聊天记录）

每次要说话时，按 3 路拼装，总预算默认 2000 字：

1. **灵魂设定**（常驻，不可裁剪）：身份、称呼、口癖、底线规则
2. **最近 5 张卡片**：按 `last_used` 倒序，保证"刚才聊的"接得上
3. **向量检索 Top-10 → Rerank Top-3**：按当前这句 query 做相似度召回，再用 Rerank 重排，只把最相关的 3 张卡片（含其 facts 细节）塞进去

聊天历史本身只保留最近几条用于语气连贯（`HIST_MAX` 默认 10），长期信息一律走记忆库。这样上下文占用与"聊了多久"无关，只与"这次需要多少记忆"有关。

---

## 三、整体模型（一张图）

```
                     ┌──────────────┐
     聊天 / 私信 ───▶ │  消息进来     │
                     └──────┬───────┘
                            │
              ┌─────────────▼─────────────┐
              │  上下文装配（≤2000 字）      │
              │  灵魂设定 + 最近5 + 检索3   │◀──── 记忆库
              └─────────────┬─────────────┘
                            │
                     ┌──────▼───────┐
                     │   LLM 生成    │
                     └──────┬───────┘
                            │
              ┌─────────────▼─────────────┐
              │  写入流水线（过滤→提炼→合并）│───▶ 记忆库
              └───────────────────────────┘
                            │
              ┌─────────────▼─────────────┐
              │  遗忘调度（艾宾浩斯+权重）    │───▶ 记忆库
              └───────────────────────────┘

   记忆库 ──▶ 星图可视化（星星/星云/连线/关系图）──▶ 人可以直接看、直接改
```

---

## 四、功能清单

### 4.1 记忆星图（可视化）

打开 DSH → 右下角「记忆星图」按钮（或访问 `/dayu-memory-star/client.js` 注入的入口），进入全屏星图：

- **每条记忆 = 一颗星**，按类型上色：规则金、偏好紫、目标青、情绪粉、事实灰蓝
- **中央大星 = 当前最重要的那条记忆**（排序：`important` → `weight` → `freq`，会随记忆变化自动换）
- **所有星都与中央星有连线**；**有关联的记忆之间还有青色连线**（共享关键词，或摘要相似度 ≥ 0.3）
- **重要记忆**：带 16 长 + 16 短的星芒（光纤射线感）、带柔光晕、名字直接悬浮在星星上方
- 背景：5 层星云 + 46 团大气雾 + 1500 颗背景星，各自缓慢漂移
- 保留率低的记忆会**变暗变透明**——一眼能看出"它快被忘了"

交互：

| 操作 | 效果 |
| --- | --- |
| 拖动 | 旋转星图 |
| 滚轮 | 缩放 |
| **Shift + 拖动** | 整体平移（像 3D 建模软件） |
| 悬停 | 显示记忆名 tooltip，并且**该星停止自转** |
| 点击星星 | 打开右侧详情：改摘要 / 改类型 / 标记重要 / **改权重** / 删除 / 加细节 / 加卡片 |

侧栏四个标签：

1. **记忆** —— 卡片详情与编辑、facts 列表、手动新增卡片
2. **关系** —— 人物关系图（SVG 力导向环），可改名、可加人、可连线、可删线，以及分别编辑「主人与 TA 的关系」「大肥鱼与 TA 的关系」
3. **上下文** —— 「本次请求已用 / 剩余」与「历史累计」两条横条 + 分会话明细
4. **状态** —— 数据目录、卡片数、细节数、重要数、临遗忘数、**已归档数**、模型阈值、类型分布、保留率最低的 6 条，以及「预演归档 / 执行遗忘 / 查看已归档（可逐条恢复）/ 清空已归档 / 刷新」

删除一条记忆**只删它自己**（以及它挂着的 facts），不会连带删掉和它相连的另一张卡——连线只是关系，不是从属。

### 4.2 记忆模型（可复用核心）

`lib/memory-core.js` 是零依赖的纯 JS 模块，**不装 DSH 也能用**：

```js
const Mem = require('dsh-dayu-memory-star/memory-core');
Mem.configure({ dataDir: '/path/to/memory', ownerId: '123456' });

// 写
Mem.addFact('123456', { type: 'preference', text: '主人喜欢冰美式，不加糖' });

// 读（3 路注入，返回可直接拼进 system 的字符串）
const ctx = Mem.buildMemoryContext('123456', '今天想喝点什么', 2000);

// 维护
Mem.sweepMemory();                       // 按艾宾浩斯曲线遗忘
Mem.retentionReport('123456');           // 看看谁快不行了
Mem.getRelatedEdges('123456');           // 记忆之间的关联边
```

导出的能力：

- 文本相似度：`normalize` / `shingles` / `jaccard` / `similarity` / `minhashSignature`
- 分类与关键词：`classifyByKeyword` / `extractKeywords` / `TYPE_BASE_WEIGHT`
- 权重与遗忘：`memoryWeight` / `cardRetention` / `retentionReport` / `sweepMemory`（软删除归档）
- 归档管理：`archivedCards` / `restoreCard` / `purgeArchived`
- 增删改查：`addFact` / `addCard` / `updateCard` / `deleteCard` / `addCardFact` / `deleteCardFact` / `listCards` / `listOwners`
- 检索注入：`getRecentCards` / `getFreshCards` / `buildFreshContext` / `searchByQuery` / `rerank` / `buildMemoryContext` / `getRelatedEdges`
- 关系图：`getRelations` / `renameRelation` / `addRelationNode` / `deleteRelationNode` / `addRelationEdge` / `deleteRelationEdge` / `setRelationRels`
- 统计与提炼：`getContextUsage` / `stats` / `buildExtractionPrompt` / `parseExtraction` / `extractMemory` / `shouldExtract`

### 4.3 智能体工具

装了插件后，智能体在对话中会自动获得两个工具：

- `dayu_memory_search` —— 按语义检索长期记忆（返回最相关的若干卡片及其细节）
- `dayu_memory_remember` —— 主动写入一条记忆（类型 + 文本）

### 4.4 HTTP 接口

同源 `GET/POST /dayu-memory-star/api/…`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/all` | 全量：卡片（含权重/保留率/关联边）+ 关系图 + 上下文 + 画像 |
| GET | `/status` | 状态：数据目录、计数、阈值、类型分布、最低保留率 |
| GET | `/context?q=&budget=` | 取 3 路注入后的上下文字符串 |
| POST | `/card/update` | 改卡片（summary/type/important/weightOverride/snippet） |
| POST | `/card/delete` | 删卡片（只删自己与其 facts） |
| POST | `/card/add` | 手动新建卡片 |
| POST | `/fact/add` `/fact/delete` | 增删细节 |
| POST | `/remember` | 一句话写入（内部走提炼 + 去重合并） |
| POST | `/search` | 检索 |
| POST | `/sweep` | 预演 / 执行遗忘（`{"dryRun":true}`；忘掉的只是打上归档标记，不删文件） |
| GET | `/archived` | 已归档（软删除）的记忆列表 |
| POST | `/card/restore` | 把一条归档记忆恢复回来（`{"id":"c_..."}`） |
| POST | `/card/purgeArchived` | 彻底清空已归档（不可恢复，需明确调用） |
| POST | `/relations/rename` `/addNode` `/deleteNode` `/addEdge` `/deleteEdge` `/setRels` | 关系图编辑 |

---

## 五、分类

本插件归属：**工具类 · 记忆与知识管理（Memory & Knowledge）· 数据可视化**

- 一级分类：**Utility / 工具**
- 二级分类：**Memory（记忆管理）**——提供长期记忆的存储、检索、衰减与编辑
- 附带能力：**Visualization（可视化）**——星图与关系图

它**不是**模型、不是渠道、不是人格设定包；它不产生回复，只负责"记住什么、忘掉什么、取回什么"。

---

## 六、功能与权限声明（重要）

DSH 在安装第三方插件时会按能力分类提示用户。本插件声明如下：

| 能力分类 | 是否使用 | 具体说明 |
| --- | --- | --- |
| **文件与环境** | ✅ 使用 | 读写插件自己的数据目录下的 `cards.json` / `facts.json` / `relations.json` / `context_usage.json` / `*_profile.json`。目录由 `dataDir` 配置或按候选顺序自动探测（见下）。**不扫描、不读取、不上传任何其它目录的文件。** |
| **网络** | ❌ 不发起外部请求 | 插件自身**不发任何出站请求**，不联网、不打点、不校验授权。仅在 Host 侧注册**本机同源** HTTP 路由 `/dayu-memory-star/*`（供自己的前端页面取数据），以及可选的 `bridgeUrl`（若你主动配置，用于查询本地 QQBridge 的在线状态，缺省不使用）。 |
| **执行** | ⚠️ 有限 | 不执行 shell 命令、不启动子进程、不加载原生二进制。仅注册两个智能体工具（`dayu_memory_search` / `dayu_memory_remember`），由模型在对话中调用，读写范围限于上述数据目录。 |
| **构建脚本** | ❌ 无 | 本包**没有任何 `postinstall` / `prepare` / 编译步骤**，纯 JS 源码直接运行。安装时无需批准任何构建脚本（`approvedBuilds` 可以不传）。 |

其它声明：

- **无遥测**、**无账号体系**、**无 API Key 需求**
- 数据 100% 留在本机，删除插件目录 + 数据目录即彻底清除
- 记忆内容可能包含个人隐私（姓名、住址片段、情绪记录），请自行保护数据目录

### 数据目录的自动探测顺序

插件会按顺序找第一个"已经有 `cards.json` 或 `facts.json`"的目录，都不命中则用默认值：

1. 配置项 `dataDir`（推荐显式指定）
2. 环境变量 `DAYU_MEMORY_DIR`
3. `~/.dsh/dayu-memory`
4. `~/.dayu-memory/memory`
5. `~/.dayu-memory`
6. `<当前工作目录>/memory`
7. `<当前工作目录>/data/memory`
8. `<当前工作目录>/dayu-memory`
9. `%TEMP%/ds-shichuan/memory`（"大肥鱼"老部署的兼容路径）
10. `%TEMP%/ds-shichuan`
11. 默认新建：`~/.dsh/dayu-memory`

所以你**已有的记忆库不用搬家**——把 `dataDir` 指过去，或直接放在上面任一位置即可。

### 完全没有记忆库的新手，装上是怎么工作的

| 你的情况 | 插件会做什么 |
| --- | --- |
| 刚装 DSH，机器上没有任何记忆目录 | 落到 `~/.dsh/dayu-memory`，**不会立刻建文件**；星图打开是一片空星空 + 一句「记忆库还是空的」；写第一条记忆时才自动建目录、建 `cards.json` / `facts.json` |
| 已经有 `%TEMP%\ds-shichuan\memory` 的"大肥鱼"老部署 | 自动认出它，状态页显示「识别方式：auto-detected」，**不用搬文件、不用改配置** |
| 记忆库放在别处 | 设 `DAYU_MEMORY_DIR`（或配置项 `dataDir`）指过去 |
| 一个库里有多个人（群聊池） | 配 `ownerId`，只显示这个主人的记忆 |
| 你的智能体不叫"大肥鱼" | 配 `soul` 换成你自己的常驻设定（默认三条是中性的，**不含任何"大肥鱼"人格**） |
| 记忆库是别人写的、字段不全（缺 `type` / `last_used` / `freq`） | 缺 `type` 兜底成「日常」，缺时间按 `created` 算保留率，不报错 |

上面这几条都有自动化测试覆盖（`test/cold-start.js`，51 项断言，含真实 Chromium 打开空库页面）。

### 可配置项

| 配置项 / 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `dataDir` / `DAYU_MEMORY_DIR` | 自动探测 | 记忆目录 |
| `ownerId` / `DAYU_OWNER_ID` | 空 = 全部 | 只显示这个主人的记忆 |
| `ownerName` / `DAYU_OWNER_NAME` | 「主人」 | 关系图里主人的显示名 |
| `selfId` / `DAYU_SELF_ID` | `self` | 智能体自己（大肥鱼）的标识 |
| `selfName` / `DAYU_SELF_NAME` | 「大肥鱼」 | 关系图里自己的显示名 |
| `soul` / `DAYU_SOUL` | 中性三条 | 常驻灵魂设定；数组，或换行 / 竖线分隔的字符串 |
| `showLauncher` | `true` | 是否显示右下角「记忆星图」按钮 |
| `bridgeUrl` / `bridgeToken` | 空 | 可选：顺带显示 NapCat 的在线状态 |

---

## 七、安装

### 7.1 从 GitHub Gist 链接安装（推荐，本文档配套方式）

1. 打开 Gist 页面，复制 **Raw** 地址（形如 `https://gist.githubusercontent.com/<user>/<id>/raw/<file>.tgz`）
2. DSH → 设置 → 插件 → **添加插件**
3. 粘贴链接，回车
4. 如弹出"允许构建脚本"，**本插件不需要**，直接跳过/拒绝均可
5. 重启 DSH 或刷新页面 → 右下角出现「记忆星图」

> 万一按钮没出现（宿主版本较老，`tapIndex` 注入不进首屏），直接在地址栏打开
> `http://127.0.0.1:54800/dayu-memory-star`（端口换成你 DSH 实际用的）也能进星图——插件会注册这个独立页面作为兜底。

### 7.2 从本地目录安装（开发/离线）

```
DSH → 设置 → 插件 → 添加插件 → 填本地绝对路径
例：D:\plugins\dsh-dayu-memory-star
```

或命令行：

```bash
dsh plugin --profile desktop add file:D:/plugins/dsh-dayu-memory-star
```

> 目录安装时 `files` 字段不过滤，整个目录都会被读取。

### 7.3 安装后验证

- 左下/右下出现「记忆星图」按钮
- 点开能看到星图（没有记忆时是一片空星云，提示"还没有记忆"）
- 设置 → 插件 里能看到 `dsh-dayu-memory-star`，图标是深空星云
- 让智能体调用一次 `dayu_memory_remember`，星图里应立刻多一颗星

---

## 八、怎么接到你自己的智能体上

> 现成示例在 `examples/` 里：`qqbridge-integration.js`（Node，`node examples/qqbridge-integration.js` 会跑一遍离线演示）、`astrbot_integration.py`（Python，走本机 HTTP 接口）。

### 8.1 QQBridge（Node）

```js
const Mem = require('dsh-dayu-memory-star/memory-core');
Mem.configure({ dataDir: './memory', ownerId: String(OWNER_UIN) });

// 说话前：取记忆（替代把聊天记录整个塞进 prompt）
const memCtx = Mem.buildMemoryContext(ownerId, userText, 2000);
const messages = [
  { role: 'system', content: SOUL + '\n\n' + memCtx },
  ...recentHistory.slice(-10),
  { role: 'user', content: userText },
];

// 收到回复后：写记忆
if (Mem.shouldExtract(userText)) {
  const facts = Mem.extractMemory(userText, aiReply, callDeepSeek);
  for (const f of facts) Mem.addFact(ownerId, f);
}

// 定时维护（建议每 5 分钟）
setInterval(() => Mem.sweepMemory(), 5 * 60 * 1000);
```

### 8.2 AstrBot（Python 侧，通过 HTTP）

AstrBot 插件里直接打本机接口即可（DSH 默认监听在本机）：

```python
import httpx

BASE = "http://127.0.0.1:54800/dayu-memory-star/api"

async def recall(query: str) -> str:
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(f"{BASE}/context", params={"q": query, "budget": 2000})
        return r.json().get("context", "")

async def remember(text: str, type_: str = "fact",
                   owner: str = "default") -> None:
    async with httpx.AsyncClient(timeout=10) as cli:
        await cli.post(f"{BASE}/remember",
                       json={"ownerId": owner, "type": type_, "text": text})
```

> 端口以 DSH 实际监听为准（`ctx.webServer.port`）。若 AstrBot 与 DSH 不在同一台机器，请自行加一层反向代理，并注意本接口**没有鉴权**——不要直接暴露到公网。

### 8.3 只要模型、不要 DSH？

`lib/memory-core.js` 是单文件零依赖 CJS 模块，`cp` 到任何 Node 项目里 `require` 即可。它不引用 DSH 的任何 API。

---

## 九、数据结构与迁移

```
<dataDir>/
  cards.json            摘要卡片（数组）
  facts.json            细节外挂（数组）
  relations.json        关系图增量（renames / extraNodes / extraEdges / hidden / nodeRels）
  relations_extra.json  同上（兼容旧名）
  context_usage.json    上下文用量累计
  owner_profile.json    主人画像（可选，由你的智能体生成）
  self_profile.json     自我画像（可选）
  members.json          群成员映射（可选，关系图数据源）
```

全部是 UTF-8 JSON，可以直接 `git` 版本化、可以手改、可以 `jq` 处理。删除文件即清空对应数据。

---

## 十、常见问题

**Q：星图里怎么一颗星都没有？**
A：数据目录里还没有记忆。先让智能体调用一次 `dayu_memory_remember`，或在「记忆」标签页手动新建一张卡片。状态标签页会显示当前实际使用的数据目录——如果指向了空目录，把它改成你真实记忆库的位置。

**Q：记忆会自己消失吗？**
A：不会真的消失。满足「保留率 < 0.2 且非重要 且 被提起少于 4 次」的记忆只会被**归档**（打标记、文件里还在），在状态页「已归档」里随时能恢复；以后再聊到同一件事还会自动复活。想保住某条，点开它勾上「重要」，或把权重调到 1；先点「预演归档」可以看看这次会归档哪些。

**Q：能关掉自动遗忘吗？**
A：可以。不调用 `sweepMemory` 就不会遗忘；或在配置里不让智能体注册维护定时器。手动模式只在状态页点「执行遗忘」时才生效。

**Q：支持多人/多智能体共用一个库吗？**
A：支持。每条记忆都有 `owner_id`，不同人/不同智能体的记忆互相隔离；星图可以按 owner 过滤。

**Q：前端为什么不是 React？**
A：为了"装完即用"。React 版需要 client-plugin 打包链（`pnpm build`），而社区插件默认不运行构建脚本。手写 IIFE + Canvas 2D 让这个包**解压即可运行**。

**Q：会不会偷偷联网？**
A：不会。插件自身零出站请求（可自行 `grep -n "http" lib/*.js` 验证：只有路由注册与本地 URL 构造）。

---

## 十一、目录结构

```
dsh-dayu-memory-star/
├─ package.json          dsh.manifestVersion / bundle.patch / icon
├─ cordis.patch.yml      bundle 插入声明
├─ icon.svg              插件图标
├─ LICENSE               MIT
├─ 记忆模型说明.md     记忆模型完整说明书（新手可读；第十节可直接喂给 DSH 复刻）
├─ README.md             英文说明
├─ README.zh.md          本文件
├─ lib/
│  ├─ index.js           Host 半侧：路由 + 注入 + 工具
│  ├─ memory-core.js     记忆核心（零依赖，可独立复用）
│  └─ client.js          浏览器半侧：星图 + 关系图 + 侧栏
├─ locale/
│  ├─ zh.json            中文标题/描述
│  └─ en.json            英文标题/描述
├─ examples/
│  ├─ qqbridge-integration.js   QQBridge / Node 机器人接入示例（可 node 直接跑）
│  └─ astrbot_integration.py    AstrBot / Python 接入示例（走 HTTP 接口）
└─ test/smoke.js         冒烟测试（node test/smoke.js）
```

---

## 十二、致谢与出处

- 遗忘曲线模型源自 Hermann Ebbinghaus（1885）的保留率曲线，本插件把它与"类型权重 + 使用频率 + 手动权重"结合，形成可解释、可调参的衰减函数。
- 相似度引擎用 MinHash（Broder, 1997）与 Jaccard 系数，纯 JS 实现，无外部依赖。
- 由「大肥鱼」智能体的实际部署需求演化而来：先是一个 Electron 桌面星图程序，现在改写成可从 Gist 安装的 DSH 社区插件。

## 十三、更新记录

**v1.1.1** — 记忆不再「真删」：遗忘改成软删除归档（`archived` 标记，文件里一个字都不删），状态页新增「已归档」入口，可逐条恢复或一键清空；再次提起同一件事会自动复活归档卡、不产生重复卡（`important` 与 `freq≥4` 永不归档）。检索加 60 秒短缓存，同一句话重复问不重算，卡片一更新缓存自动失效。新增《记忆模型说明.md》——写给新手看的完整说明书，第十节可整段粘给 DSH 复刻同一套模型。smoke 142 → 169 项，另加 10 项浏览器端归档 UI 检查。

**v1.1.0** — 添加记忆更顺手：新建卡片可「自动判断类型」（规则/偏好/目标/情绪/日常），自动算关键词并**自动连到最相关的 3 条记忆**（星图上立刻出现连线）；关联边额度 80→160 且新卡优先，不会再被旧卡挤掉；星图中心大星固定为「主人相关的那条关键记忆」（找不到才退回最重要的一张）。

同时把「遗忘」改成**软删除归档**：`sweepMemory` 不再从文件里删记忆，只打 `archived` 标记；状态页新增「已归档」入口，可逐条恢复或一键清空；聊天里再次提起同一件事会**自动复活**归档卡（不重复建卡）。检索加了 60 秒短缓存（同一句话重复问不再重算）。新增 smoke 用例 27 项（合计 169 项）+ 10 项浏览器端检查。

MIT License · 欢迎 fork、提 issue、改成你自己的记忆星图。
