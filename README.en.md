# Dayu Memory Star · 大肥鱼记忆星图

> Turn an agent's long-term memory into a **navigable star map** — every memory is a star, the most important one sits at the centre.
> Ships an **Ebbinghaus forgetting curve + weight system** memory model: what matters stays, small talk fades.
> Pure local JSON · zero dependencies · zero external services · no API key.

- Package / install spec: `dsh-dayu-memory-star`
- Version: `1.1.1` · License: MIT
- Requires: DeepSeek Harness (DSH) ≥ 0.1.5; the memory core also works standalone in QQBridge / AstrBot / any Node.js project

中文文档见 [README.zh.md](./README.zh.md)。

---

## What it is

It does not chat — **it remembers.**

Instead of replaying the last N chat messages into the context window (expensive, forgetful, wiped on restart), this plugin keeps memory in a long-lived, decaying, searchable, visualisable store:

| The usual approach | This plugin |
| --- | --- |
| Memory = last N messages | Memory = structured long-term **cards + facts** |
| Early history is dropped when context fills | Important memories never expire; trivia fades on a curve |
| Memory is a black box | Memory is a star map — every star can be opened and edited |
| Switching models loses memory | Memory is decoupled from the model, stored as local JSON |

---

## How it works

### Three layers

```
Host side (Node, inside the DSH process)   lib/index.js
  · HTTP routes  /dayu-memory-star/api/…
  · tapIndex injection of the browser script
  · agent tools  dayu_memory_search / dayu_memory_remember
        │  (same function calls)
Memory core (pure JS, zero deps)           lib/memory-core.js
  · similarity engine (MinHash + Jaccard)
  · weight / Ebbinghaus retention / forgetting
  · 3-way retrieval context / relations / usage stats
  · reads & writes memory/cards.json + facts.json
        │  same-origin fetch('/dayu-memory-star/api/…')
Browser side (IIFE, no deps, no build)     lib/client.js
  · Canvas 2D hand-projected pseudo-3D star map
  · 400px side panel: Memory / Relations / Context / Status
```

No client-plugin build chain is used on purpose: the plugin only needs "one canvas + one API", so the host injects a plain `<script>` into the first screen with `webServer.tapIndex()`. That is why it can be installed and used immediately, with **no build scripts ever run**.

### Memory shape — summary cards + attached details

```json
// memory/cards.json — one-line summary, used for retrieval and the star map
{
  "id": "c1a2b3", "owner_id": "3387982960", "type": "preference",
  "summary": "The owner likes an iced americano, no sugar, when coding late",
  "keywords": ["americano", "late night", "coding"],
  "important": true, "freq": 5,
  "created": 1793449182111, "last_used": 1793500000000,
  "weightOverride": null
}

// memory/facts.json — raw detail hanging off a card, expanded only when needed
{ "id": "f9x8y7", "card_id": "c1a2b3", "fact": "Said on Oct 30 that the convenience-store americano beats the machine", "origin": "qq", "ts": 1793500000000 }
```

Match the cheap summary first, pull the expensive detail only on a hit. That is the whole point of the split.

### Write pipeline

```
incoming message
  ├─ shouldExtract(text)      too short / pure small talk → drop, no LLM call (saves money)
  ├─ extractMemory(...)       LLM distils into [{type, text}]; keyword fallback on failure
  ├─ classifyByKeyword(text)  rule / preference / goal / emotion / fact
  └─ addFact(ownerId, fact)
        ├─ similarity() against every card
        │    └─ ≥ 0.85 → merge (freq+1, refresh last_used, update summary)
        └─ < 0.85 → new card
```

### Similarity engine (why no vector DB)

With only local compute, do not pretend to have embeddings. Two classic algorithms, blended:

- **MinHash** — character 3-grams, 64 hash seeds (`HASH_SEEDS=[31,131,137,139,149,151]` derived), 64-dim signature; the fraction of matching positions approximates Jaccard.
- **Jaccard** — on 3-gram sets after stripping filler particles (`/[的了啊呢吧吗呀嘛啥哦喔嘻呐]/g`).

```
similarity = 0.5 * minhash + 0.5 * jaccard
```

Known limit: **synonym paraphrases are missed** ("loves coffee" vs "likes coffee" scores 0.13). That is the price of having no embedding model — and what it buys is zero deps, zero cost, zero network, data never leaving the machine. Near-duplicate paraphrases may coexist as two cards for a while; the "recent 5 + keyword retrieval" path covers the gap.

### Ebbinghaus forgetting curve + weight system

Retention is not a fixed day count — it is a time constant **scaled by importance**:

```
weight      = important ? 1.0 : TYPE_BASE_WEIGHT[type] + min(freq,12) * 0.03
              (an explicit weightOverride in 0..1 replaces it entirely)
stability S = weight * 90 days
anchor      = max(created, last_used)      ← being recalled extends its life
retention   = e ^ ( -ageDays / S )
```

| Type | Meaning | Base weight |
| --- | --- | --- |
| `rule` | hard rule / taboo | 1.00 |
| `preference` | tastes and likes | 0.90 |
| `goal` | goals and plans | 0.85 |
| `emotion` | feelings and moments | 0.80 |
| `fact` | plain everyday fact | 0.45 |

Forgetting (`sweepMemory`) requires **all three**:

1. `retention < 0.2`
2. not `important`
3. `freq < 4` (mentioned 4+ times → immune)

Everyday small talk fades in tens of days; taboos and birthdays never expire.

### How context is assembled (memory, not chat logs)

Three sources, default budget 2000 characters:

1. **Soul / persona block** (always present, never trimmed)
2. **The 5 most recent cards** by `last_used`
3. **Vector-style recall Top-10 → rerank Top-3**, with their attached facts

Only the last few turns of raw chat are kept, for tone continuity (`HIST_MAX`, default 10). Context usage therefore depends on "how much memory this turn needs", not on "how long we have been talking".

---

## Features

### Star map (visualisation)

Full-screen map: one star per memory, coloured by type; the **central big star is the currently most important memory** (`important` → `weight` → `freq`); every star links to the centre, and **related memories are linked to each other in cyan** (shared keywords or summary similarity ≥ 0.3). Important stars get 16 long + 16 short light rays, a soft halo, and a floating name label. Background: 5 nebula layers, 46 fog puffs, 1500 background stars, all drifting slowly. Low-retention memories visibly dim.

| Action | Effect |
| --- | --- |
| drag | rotate |
| wheel | zoom |
| **Shift + drag** | pan the whole scene |
| hover | name tooltip; that star stops spinning |
| click a star | detail panel: edit summary / type / important / **weight** / delete / add fact / add card |

Side panel tabs: **Memory** (edit cards and facts), **Relations** (SVG force-ring people graph — rename, add person, add/remove edge, and edit "owner↔person" and "assistant↔person" relations separately), **Context** (this-request and lifetime bars + per-session), **Status** (data dir, counts, thresholds, type distribution, 6 lowest-retention cards, preview/run forgetting).

Deleting a memory deletes only itself and its facts — it never cascades to a connected card.

### Memory model (reusable core)

```js
const Mem = require('dsh-dayu-memory-star/memory-core');
Mem.configure({ dataDir: '/path/to/memory', ownerId: '123456' });

Mem.addFact('123456', { type: 'preference', text: 'Likes iced americano, no sugar' });

const ctx = Mem.buildMemoryContext('123456', 'what should I drink', 2000);

Mem.sweepMemory();                 // forget along the Ebbinghaus curve
Mem.retentionReport('123456');     // who is about to fade
Mem.getRelatedEdges('123456');     // memory-to-memory links
```

Exports: similarity (`normalize`/`shingles`/`jaccard`/`similarity`/`minhashSignature`), classification (`classifyByKeyword`/`extractKeywords`/`TYPE_BASE_WEIGHT`), weight & forgetting (`memoryWeight`/`cardRetention`/`retentionReport`/`sweepMemory`), CRUD (`addFact`/`addCard`/`updateCard`/`deleteCard`/`addCardFact`/`deleteCardFact`/`listCards`/`listOwners`), retrieval (`getRecentCards`/`getFreshCards`/`buildFreshContext`/`searchByQuery`/`rerank`/`buildMemoryContext`/`getRelatedEdges`), relations (`getRelations`/`renameRelation`/`addRelationNode`/`deleteRelationNode`/`addRelationEdge`/`deleteRelationEdge`/`setRelationRels`), stats & extraction (`getContextUsage`/`stats`/`buildExtractionPrompt`/`parseExtraction`/`extractMemory`/`shouldExtract`).

### Agent tools

- `dayu_memory_search` — semantic recall over long-term memory
- `dayu_memory_remember` — write a memory (type + text)

### HTTP API

Same origin, `GET/POST /dayu-memory-star/api/…`: `/all`, `/status`, `/context?q=&budget=`, `/card/update`, `/card/delete`, `/card/add`, `/fact/add`, `/fact/delete`, `/remember`, `/search`, `/sweep`, `/relations/{rename,addNode,deleteNode,addEdge,deleteEdge,setRels}`.

---

## Category

**Utility → Memory & Knowledge Management → (with) Visualisation.**

It is not a model, not a channel, not a persona pack. It never produces replies — it decides what is remembered, what is forgotten, and what is recalled.

---

## Capability declaration

| Capability | Used | Detail |
| --- | --- | --- |
| **File & environment** | ✅ | Reads/writes only its own data dir (`cards.json`, `facts.json`, `relations*.json`, `context_usage.json`, `*_profile.json`). Never scans or uploads anything else. |
| **Network** | ❌ no outbound | The plugin makes **no outbound requests** — no telemetry, no licence check. It only registers same-origin local routes `/dayu-memory-star/*` for its own UI. An optional `bridgeUrl` is used only if you configure it, to read your local QQBridge status. |
| **Execution** | ⚠️ limited | No shell, no subprocess, no native binaries. Only two agent tools, scoped to the data dir above. |
| **Build scripts** | ❌ none | No `postinstall` / `prepare` / compile step. Pure JS runs as-is; `approvedBuilds` can stay empty. |

Data dir resolution order: `dataDir` config → `DAYU_MEMORY_DIR` → `~/.dsh/dayu-memory` → `~/.dayu-memory/memory` → `~/.dayu-memory` → `cwd/memory` → `cwd/data/memory` → `cwd/dayu-memory` → `%TEMP%/ds-shichuan/memory` → `%TEMP%/ds-shichuan` → default `~/.dsh/dayu-memory`. The first one that already contains `cards.json` or `facts.json` wins, so **an existing memory store needs no migration**.

---

## Install

### From a GitHub Gist link (recommended)

1. Open the Gist, copy the **Raw** URL (e.g. `https://gist.githubusercontent.com/<user>/<id>/raw/<file>.tgz`)
2. DSH → Settings → Plugins → **Add plugin**
3. Paste the URL, press Enter
4. If a build-script prompt appears, this plugin does not need it — skipping is fine
5. Restart DSH or refresh the page → the "记忆星图" button appears

### From a local directory

```
DSH → Settings → Plugins → Add plugin → absolute path
e.g. D:\plugins\dsh-dayu-memory-star
```

or `dsh plugin --profile desktop add file:D:/plugins/dsh-dayu-memory-star`.

---

## Wiring it to your own agent

Ready-to-run samples live in examples/: `qqbridge-integration.js` (Node, runs a full offline demo with 
ode examples/qqbridge-integration.js) and `astrbot_integration.py` (Python, over the local HTTP API).

### QQBridge (Node)

```js
const Mem = require('dsh-dayu-memory-star/memory-core');
Mem.configure({ dataDir: './memory', ownerId: String(OWNER_UIN) });

const memCtx = Mem.buildMemoryContext(ownerId, userText, 2000);
const messages = [
  { role: 'system', content: SOUL + '\n\n' + memCtx },
  ...recentHistory.slice(-10),
  { role: 'user', content: userText },
];

if (Mem.shouldExtract(userText)) {
  for (const f of Mem.extractMemory(userText, aiReply, callLLM)) Mem.addFact(ownerId, f);
}

setInterval(() => Mem.sweepMemory(), 5 * 60 * 1000);
```

### AstrBot (Python, over HTTP)

```python
import httpx
BASE = "http://127.0.0.1:54800/dayu-memory-star/api"

async def recall(query: str) -> str:
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(f"{BASE}/context", params={"q": query, "budget": 2000})
        return r.json().get("context", "")

async def remember(text: str, type_: str = "fact", owner: str = "default") -> None:
    async with httpx.AsyncClient(timeout=10) as cli:
        await cli.post(f"{BASE}/remember", json={"ownerId": owner, "type": type_, "text": text})
```

The API has **no authentication** — bind it to localhost, never expose it publicly.

---

## FAQ

**No stars at all?** The data dir has no memories yet. Call `dayu_memory_remember` once, or create a card in the Memory tab. The Status tab shows the data dir actually in use.

**Do memories disappear on their own?** Only when retention < 0.2 **and** not important **and** mentioned fewer than 4 times. Mark a card important (or set weight to 1) to keep it. Use "preview forgetting" before running it.

**Can I disable forgetting?** Yes — just never call `sweepMemory`.

**Multiple people / agents?** Every memory carries `owner_id`; stores are isolated per owner.

**Why not React?** Because it must be install-and-run, and community plugins do not run build scripts. A hand-written IIFE + Canvas 2D keeps the package unpack-and-go.

**Does it phone home?** No. `grep -n "http" lib/*.js` shows only route registration and local URL building.

MIT · fork it, file issues, or turn it into your own memory star map.

## Changelog

**v1.1.1** — Forgetting is now a soft delete: `sweepMemory` only sets an `archived` flag, nothing is removed from disk. The status tab gains an “archived” section where entries can be restored one by one or purged explicitly; mentioning the same thing again automatically revives the archived card instead of creating a duplicate (`important` and `freq≥4` are never archived). Retrieval gets a 60-second cache. New “记忆模型说明.md” (Chinese) is a beginner-friendly spec whose section 10 can be pasted into DSH to recreate the whole model. Smoke tests 142 → 169, plus 10 browser-side archive-UI checks.

**v1.1.0** — Adding a memory is now one step: type is auto-classified (rule / preference / goal / emotion / fact), keywords are derived automatically, and the new card is auto-linked to the 3 most related memories (edges appear on the map immediately). Edge budget 80 → 160 with newest-first priority. The center star is pinned to the owner-related key memory when one exists.

Forgetting is now a **soft delete (archive)**: `sweepMemory` never removes memories from disk, it only stamps `archived`. The Status tab lists archived memories so you can restore them one by one (or purge them explicitly), and mentioning the same thing again later automatically revives the archived card instead of creating a duplicate. Retrieval also gained a 60-second cache. Smoke suite: 169 assertions + 10 browser checks.
