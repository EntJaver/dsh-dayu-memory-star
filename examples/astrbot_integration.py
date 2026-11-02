# -*- coding: utf-8 -*-
"""
示例：让 AstrBot 用上「记忆星图」的长期记忆。

AstrBot 是 Python 的，所以这边走 HTTP 接口，而不是 require 那个 JS 模块。
前提：DeepSeek Harness（DSH）装着 dsh-dayu-memory-star 插件并在跑。

它提供三个函数，AstrBot 插件里直接调用即可：
    await recall(query)            -> 取这段对话该注入的记忆文本
    await remember(text, type)     -> 写一条长期记忆
    await status()                 -> 看库里有几条、谁快被忘了

注意：接口只在本机监听、没有鉴权，别暴露到公网。
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

import httpx

# DSH 默认端口以实际为准（插件里 ctx.webServer.port 可读）
BASE = os.environ.get("DAYU_API_BASE", "http://127.0.0.1:54800/dayu-memory-star/api")
OWNER_ID = os.environ.get("DAYU_OWNER_ID", "3387982960")
TIMEOUT = 10.0


# ─────────────────────────────────────────────────────────────
# 底层调用
# ─────────────────────────────────────────────────────────────
async def _get(path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as cli:
        r = await cli.get(BASE + path, params=params or {})
        r.raise_for_status()
        return r.json()


async def _post(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as cli:
        r = await cli.post(BASE + path, json=payload)
        r.raise_for_status()
        return r.json()


# ─────────────────────────────────────────────────────────────
# 三个给智能体用的函数
# ─────────────────────────────────────────────────────────────
async def recall(query: str, budget: int = 2000) -> str:
    """取「灵魂设定 + 最近 5 条 + 检索 Top3」拼好的记忆上下文。"""
    data = await _get("/context", {"q": query, "budget": budget})
    return data.get("text", "")


async def remember(text: str, type_: str = "fact", owner: str = OWNER_ID) -> Dict[str, Any]:
    """写一条长期记忆。type_: rule / preference / goal / emotion / fact。

    相似度 ≥0.85 会自动并入已有记忆（返回值里 merged=true）。
    """
    if type_ not in {"rule", "preference", "goal", "emotion", "fact"}:
        type_ = "fact"
    return await _post("/remember", {"ownerId": owner, "type": type_, "text": text})


async def search(query: str, top_n: int = 6) -> List[Dict[str, Any]]:
    """按语义检索记忆（只返回摘要，不含细节）。"""
    data = await _post("/search", {"query": query, "topN": top_n})
    return data.get("cards", [])


async def status(owner: str = OWNER_ID) -> Dict[str, Any]:
    """库状态：卡片数、重要数、临遗忘数、保留率最低的几条。"""
    data = await _get("/status")
    stats = data.get("stats", {})
    retention = data.get("retention", {})
    return {
        "cards": stats.get("cards", 0),
        "facts": stats.get("facts", 0),
        "important": stats.get("important", 0),
        "fading": stats.get("fading", 0),
        "byType": stats.get("byType", {}),
        "dataDir": stats.get("dataDir", ""),
        "soonest": retention.get("soonest", []),
    }


async def sweep(dry_run: bool = True) -> Dict[str, Any]:
    """按艾宾浩斯曲线遗忘。默认只预演，不真删。"""
    return await _post("/sweep", {"dryRun": dry_run})


# ─────────────────────────────────────────────────────────────
# 接进 AstrBot 的最小骨架（按 AstrBot 的插件约定摆放即可）
# ─────────────────────────────────────────────────────────────
async def build_system_prompt(persona: str, user_text: str) -> str:
    """把记忆拼在人格后面，作为 system。"""
    try:
        mem = await recall(user_text)
    except Exception:
        mem = ""  # DSH 没跑也不能让机器人哑掉
    return persona + ("\n\n" + mem if mem else "")


async def after_reply(user_text: str, ai_reply: str) -> None:
    """回复之后写记忆：只在看起来有信息量的时候写，省 token。"""
    text = (user_text or "").strip()
    if len(text) < 8:
        return
    keyword_types = [
        (("不要", "不准", "必须", "禁止", "雷区", "以后别"), "rule"),
        (("喜欢", "最爱", "讨厌", "习惯", "受不了"), "preference"),
        (("打算", "计划", "目标", "下周", "明天", "要考", "出差"), "goal"),
        (("开心", "难过", "委屈", "焦虑", "感动", "生气"), "emotion"),
    ]
    picked = "fact"
    for words, t in keyword_types:
        if any(w in text for w in words):
            picked = t
            break
    try:
        await remember(text[:60], picked)
    except Exception:
        pass


if __name__ == "__main__":
    import asyncio

    async def demo() -> None:
        print("接口：", BASE)
        print("状态：", await status())
        print("写入：", await remember("主人喜欢在深夜喝冰美式，不加糖", "preference"))
        print("上下文：", (await recall("喝什么", 600))[:200], "...")
        print("预演遗忘：", await sweep(True))

    asyncio.run(demo())
