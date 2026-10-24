"""Generate deterministic MinerU-like Markdown textbook fixtures.

The fixtures intentionally model the hosted V4 ZIP observed by this project:
full.md, Content List V1/V2, layout.json, and relative image assets.  They are
synthetic test data, not a claim that every MinerU version emits identical
members or every optional field.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import zlib
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent
AUXILIARY_TYPES = {"header", "footer", "page_number", "aside_text", "page_footnote"}
IMAGE_REFERENCE = re.compile(r"!\[[^]]*\]\(([^)]+)\)")


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def _placeholder_png(seed: str, width: int = 320, height: int = 160) -> bytes:
    """Create a small deterministic RGB PNG without optional dependencies."""
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    base = tuple(72 + digest[index] % 120 for index in range(3))
    accent = tuple(32 + digest[index + 3] % 160 for index in range(3))
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            band = ((x // 40) + (y // 32)) % 2
            color = base if band == 0 else accent
            if 12 < x < width - 12 and 12 < y < height - 12:
                row.extend(color)
            else:
                row.extend((245, 247, 250))
        rows.append(bytes(row))
    payload = zlib.compress(b"".join(rows), level=9)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + _png_chunk(b"IDAT", payload)
        + _png_chunk(b"IEND", b"")
    )


def _text_span(content: str) -> list[dict[str, str]]:
    return [{"type": "text", "content": content}]


class MinerUFixtureBuilder:
    def __init__(self, slug: str, title: str, page_count: int, image_style: str):
        self.slug = slug
        self.title = title
        self.page_count = page_count
        self.image_style = image_style
        self.pages_v1: list[list[dict]] = [[] for _ in range(page_count)]
        self.pages_v2: list[list[dict]] = [[] for _ in range(page_count)]
        self.markdown_parts: list[str] = []
        self.assets: dict[str, bytes] = {}
        self._asset_ordinals: dict[tuple[int, str], int] = {}

    def _bbox(self, page: int) -> list[int]:
        order = len([block for block in self.pages_v1[page] if block.get("type") not in AUXILIARY_TYPES])
        top = 95 + min(order, 10) * 68
        return [72, top, 928, min(930, top + 54)]

    def _asset(self, page: int, kind: str, seed: str) -> str:
        key = (page, kind)
        ordinal = self._asset_ordinals.get(key, 0) + 1
        self._asset_ordinals[key] = ordinal
        if self.image_style == "historical-hash":
            name = hashlib.sha256(f"{self.slug}:{page}:{kind}:{ordinal}:{seed}".encode("utf-8")).hexdigest() + ".png"
        else:
            name = f"page_{page}_{kind}_{ordinal}.png"
        path = f"images/{name}"
        self.assets[path] = _placeholder_png(seed)
        return path

    def title_block(self, page: int, text: str, level: int) -> None:
        bbox = self._bbox(page)
        self.pages_v1[page].append({"type": "text", "text": text, "text_level": level, "bbox": bbox, "page_idx": page})
        self.pages_v2[page].append({"type": "title", "content": {"title_content": _text_span(text), "level": level}, "bbox": bbox})
        self.markdown_parts.append(f"{'#' * max(1, min(level, 6))} {text}\n")

    def paragraph(self, page: int, text: str) -> None:
        bbox = self._bbox(page)
        self.pages_v1[page].append({"type": "text", "text": text, "text_level": 0, "bbox": bbox, "page_idx": page})
        self.pages_v2[page].append({"type": "paragraph", "content": {"paragraph_content": _text_span(text)}, "bbox": bbox})
        self.markdown_parts.append(text + "\n")

    def list_block(self, page: int, items: list[str], *, subtype: str = "text") -> None:
        bbox = self._bbox(page)
        self.pages_v1[page].append({"type": "list", "sub_type": subtype, "list_items": items, "bbox": bbox, "page_idx": page})
        self.pages_v2[page].append({"type": "list", "content": {"list_items": [_text_span(item) for item in items]}, "bbox": bbox})
        self.markdown_parts.append("\n".join(f"- {item}" for item in items) + "\n")

    def equation(self, page: int, latex: str, caption: str) -> None:
        bbox = self._bbox(page)
        path = self._asset(page, "equation", caption)
        rendered = f"$$\n{latex}\n$$"
        self.pages_v1[page].append({
            "type": "equation", "img_path": path, "text": rendered,
            "text_format": "latex", "bbox": bbox, "page_idx": page,
        })
        self.pages_v2[page].append({
            "type": "equation_interline",
            "content": {"math_content": [{"type": "latex", "content": latex}], "math_type": "latex", "image_source": {"path": path}},
            "bbox": bbox,
        })
        self.markdown_parts.append(rendered + "\n")

    def image(self, page: int, caption: str, alt: str) -> None:
        bbox = self._bbox(page)
        path = self._asset(page, "image", caption)
        self.pages_v1[page].append({
            "type": "image", "img_path": path, "image_caption": [caption],
            "image_footnote": [], "content": "", "bbox": bbox, "page_idx": page,
        })
        self.pages_v2[page].append({
            "type": "image",
            "content": {"image_source": {"path": path}, "content": "", "image_caption": _text_span(caption), "image_footnote": []},
            "bbox": bbox,
        })
        self.markdown_parts.append(f"![{alt}]({path})<br>\n{caption}\n")

    def table(self, page: int, caption: str, headers: list[str], rows: list[list[str]], footnote: str = "") -> None:
        bbox = self._bbox(page)
        path = self._asset(page, "table", caption)
        header_html = "".join(f"<th>{cell}</th>" for cell in headers)
        rows_html = "".join("<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in rows)
        html = f"<table><thead><tr>{header_html}</tr></thead><tbody>{rows_html}</tbody></table>"
        footnotes = [footnote] if footnote else []
        self.pages_v1[page].append({
            "type": "table", "img_path": path, "table_caption": [caption],
            "table_footnote": footnotes, "table_body": html, "bbox": bbox, "page_idx": page,
        })
        self.pages_v2[page].append({
            "type": "table",
            "content": {
                "image_source": {"path": path}, "table_body": html,
                "table_caption": _text_span(caption), "table_footnote": _text_span(footnote) if footnote else [],
            },
            "bbox": bbox,
        })
        self.markdown_parts.append(f"**{caption}**\n\n{html}\n" + (f"\n{footnote}\n" if footnote else ""))

    def code(self, page: int, body: str, caption: str, language: str = "python", subtype: str = "code") -> None:
        bbox = self._bbox(page)
        self.pages_v1[page].append({
            "type": "code", "sub_type": subtype, "code_caption": [caption],
            "code_body": body, "code_footnote": [], "bbox": bbox, "page_idx": page,
        })
        v2_type = "algorithm" if subtype == "algorithm" else "code"
        self.pages_v2[page].append({
            "type": v2_type,
            "content": {
                f"{v2_type}_content": _text_span(body), f"{v2_type}_caption": _text_span(caption),
                f"{v2_type}_footnote": [], "code_language": language,
            },
            "bbox": bbox,
        })
        self.markdown_parts.append(f"**{caption}**\n\n```{language}\n{body}\n```\n")

    def add_page_furniture(self) -> None:
        for page in range(self.page_count):
            header = f"COURSE STUDIO / {self.title}"
            footer = "原创测试教材 · 仿 MinerU 结构化产物"
            page_number = str(page + 1)
            for kind, text, bbox in (
                ("header", header, [65, 24, 600, 48]),
                ("footer", footer, [65, 948, 610, 972]),
                ("page_number", page_number, [900, 948, 940, 972]),
            ):
                self.pages_v1[page].append({"type": kind, "text": text, "bbox": bbox, "page_idx": page})
                v2_kind = {"header": "page_header", "footer": "page_footer", "page_number": "page_number"}[kind]
                payload_key = {"header": "page_header_content", "footer": "page_footer_content", "page_number": "page_number_content"}[kind]
                self.pages_v2[page].append({"type": v2_kind, "content": {payload_key: _text_span(text)}, "bbox": bbox})

    def write(self, expected: dict) -> None:
        output = ROOT / self.slug
        images = output / "images"
        images.mkdir(parents=True, exist_ok=True)
        self.add_page_furniture()

        full_md = "\n".join(part.rstrip() for part in self.markdown_parts).rstrip() + "\n"
        content_v1 = [block for page in self.pages_v1 for block in page]
        layout = {
            "pdf_info": [
                {
                    "page_idx": page_index,
                    "page_size": [595, 842],
                    "para_blocks": [block for block in blocks if block.get("type") not in AUXILIARY_TYPES],
                    "discarded_blocks": [block for block in blocks if block.get("type") in AUXILIARY_TYPES],
                }
                for page_index, blocks in enumerate(self.pages_v1)
            ],
            "_backend": "vlm",
            "_version_name": "synthetic-hosted-v4-compatible",
        }

        (output / "full.md").write_text(full_md, encoding="utf-8", newline="\n")
        (output / f"{self.slug}_content_list.json").write_bytes(_json_bytes(content_v1))
        (output / f"{self.slug}_content_list_v2.json").write_bytes(_json_bytes(self.pages_v2))
        (output / "layout.json").write_bytes(_json_bytes(layout))
        for relative, payload in sorted(self.assets.items()):
            target = output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)

        zip_path = output / "result.zip"
        members = [
            output / "full.md",
            output / f"{self.slug}_content_list.json",
            output / f"{self.slug}_content_list_v2.json",
            output / "layout.json",
            *(output / relative for relative in sorted(self.assets)),
        ]
        with ZipFile(zip_path, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
            for member in members:
                relative = member.relative_to(output).as_posix()
                info = ZipInfo(relative, date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, member.read_bytes())

        expected = {
            **expected,
            "fixture_schema": "course-studio-mineru-fixture/1.0",
            "slug": self.slug,
            "title": self.title,
            "page_count": self.page_count,
            "markdown_chars": len(full_md),
            "content_block_count": len(content_v1),
            "asset_count": len(self.assets),
            "artifacts": {
                "full.md": _sha256(output / "full.md"),
                f"{self.slug}_content_list.json": _sha256(output / f"{self.slug}_content_list.json"),
                f"{self.slug}_content_list_v2.json": _sha256(output / f"{self.slug}_content_list_v2.json"),
                "layout.json": _sha256(output / "layout.json"),
                "result.zip": _sha256(zip_path),
            },
        }
        (output / "expected.json").write_bytes(_json_bytes(expected))


def _build_small() -> None:
    builder = MinerUFixtureBuilder("small", "传感器数据校验入门", 6, "historical-hash")
    builder.title_block(0, "传感器数据校验入门", 1)
    builder.paragraph(0, "从采样时间到可靠告警：一本用于 Markdown 导入链路的原创微型教材。")
    builder.paragraph(0, "本书面向刚接触物联网数据处理的学习者，所有数值与示例均为测试用途。")

    builder.title_block(1, "目录", 2)
    builder.paragraph(1, "1 采样与数据质量 …… 3\n1.1 采样间隔与时间戳 …… 3\n1.2 缺失值与异常值 …… 4\n2 平滑与告警 …… 5\n2.1 移动平均 …… 5\n2.2 阈值与迟滞 …… 6")
    builder.paragraph(1, "目录页码是原始 PDF 的印刷页码；content_list 中 page_idx 从 0 开始。")

    builder.title_block(2, "1 采样与数据质量", 2)
    builder.title_block(2, "1.1 采样间隔与时间戳", 3)
    builder.paragraph(2, "采样间隔 Δt 是相邻两次观测时间戳之差。均匀采样要求大多数相邻间隔接近设定值，但网络抖动可能让到达时间偏离采集时间，因此必须区分设备时间戳和服务器接收时间。")
    builder.equation(2, r"f_s = \frac{1}{\Delta t}", "采样频率与采样间隔")
    builder.paragraph(2, "例如每 5 秒采集一次，理论采样频率为 0.2 Hz。判断遗漏记录时应比较时间戳间隔，而不能只统计当前文件共有多少行。")
    builder.list_block(2, ["时间戳统一到同一时区", "保留原始时间与校正时间", "记录允许的采样抖动范围"])

    builder.title_block(3, "1.2 缺失值与异常值", 3)
    builder.paragraph(3, "缺失值表示本应存在的观测没有获得；异常值表示获得了数值，但数值违反物理范围或变化规律。二者的处理策略不同，不能把所有可疑值都直接改成零。")
    builder.table(3, "表 1 数据质量状态", ["状态", "示例", "推荐动作"], [
        ["有效", "22.4 ℃", "保留"], ["缺失", "时间戳存在但无读数", "标记并评估插值"],
        ["越界", "温度 310 ℃", "隔离并检查设备"], ["突变", "一分钟上升 35 ℃", "结合邻近记录复核"],
    ], "阈值必须结合传感器量程与业务场景设定。")
    builder.title_block(3, "边界检查", 4)
    builder.paragraph(3, "恰好等于量程上限的数值是否有效，取决于规范采用闭区间还是开区间。规则必须写进配置并保持可追踪。")

    builder.title_block(4, "2 平滑与告警", 2)
    builder.title_block(4, "2.1 移动平均", 3)
    builder.paragraph(4, "移动平均使用最近 w 个有效观测的平均值减弱短时噪声。窗口越大，曲线越平稳，但对真实变化的响应也越慢。遇到缺失值时必须约定分母使用窗口宽度还是有效观测数量。")
    builder.equation(4, r"m_t = \frac{1}{w}\sum_{i=0}^{w-1} x_{t-i}", "长度为 w 的简单移动平均")
    builder.image(4, "图 1 原始读数与三点移动平均的示意", "移动平均示意")
    builder.paragraph(4, "平滑后的值适合观察趋势，但不应覆盖原始数据。诊断传感器故障时仍要回查原始读数和质量标记。")

    builder.title_block(5, "2.2 阈值与迟滞", 3)
    builder.paragraph(5, "只有一个阈值时，读数在阈值附近轻微波动会让告警反复开关。迟滞使用进入阈值和退出阈值形成缓冲区：高于 80 开启告警，低于 75 才解除。")
    builder.table(5, "表 2 告警状态迁移", ["当前状态", "条件", "下一状态"], [
        ["正常", "值 > 80", "告警"], ["正常", "值 ≤ 80", "正常"],
        ["告警", "值 < 75", "正常"], ["告警", "值 ≥ 75", "告警"],
    ])
    builder.code(5, "if not alarm and value > 80:\n    alarm = True\nelif alarm and value < 75:\n    alarm = False", "算法 1 带迟滞的状态更新", subtype="algorithm")
    builder.title_block(5, "边界检查", 4)
    builder.paragraph(5, "等于 80 或 75 时的行为必须由比较符号明确表达。测试既要覆盖越过阈值，也要覆盖恰好等于阈值。")

    builder.write({
        "chapters": [
            {"number": "1", "title": "采样与数据质量", "page": 3, "point_numbers": ["1.1", "1.2"]},
            {"number": "2", "title": "平滑与告警", "page": 5, "point_numbers": ["2.1", "2.2"]},
        ],
        "textbook_points": ["采样间隔与时间戳", "缺失值与异常值", "移动平均", "阈值与迟滞"],
        "sequence": {
            "cluster_edges": [["1", "2"]],
            "point_edges": [["1.1", "1.2"], ["1.2", "2.1"], ["2.1", "2.2"]],
        },
        "extension_opportunities": [
            {"title": "采样抖动的统计描述", "anchor": "1.1", "status": "textbook-supported-suggestion"},
            {"title": "稳健平滑方法", "anchor": "2.1", "status": "model-only-suggestion"},
        ],
        "outline_only_headings": ["目录", "边界检查"],
        "coverage_features": ["heading-levels", "inline-and-display-formula", "html-table", "relative-image", "algorithm", "repeated-local-heading", "page-furniture"],
        "minimum_markdown_chars": 1800,
    })


LARGE_POINTS = [
    {
        "number": "1.1", "chapter": "1", "title": "后进先出与栈顶",
        "definition": "栈是一种只允许在同一端插入和删除元素的线性结构，这个开放端叫栈顶，另一端叫栈底。最后进入的元素最先离开，因此访问规则称为后进先出。",
        "mechanism": "把状态写成 [A, B, C] 时，本书约定左侧为栈底、右侧为栈顶。下一次标准出栈取得 C；若想访问 A，必须先移走 C 和 B。",
        "example": "空栈依次执行 push(8)、push(2)、pop()、push(5)、pop()，两次返回值依次是 2 和 5，8 仍留在栈中。",
        "pitfall": "后进先出并不意味着任何输入都会整体反转；只有先完成全部入栈再连续出栈时，输出才恰好是输入的逆序。",
        "invariant": "任一时刻只能通过栈顶改变栈；未被弹出的旧元素保持相对顺序。",
        "exercise": "从空栈执行 push(A)、push(B)、push(C)、pop()、pop()，写出两次返回值和最终状态。",
        "visual": "三个元素从栈底到栈顶的排列",
    },
    {
        "number": "1.2", "chapter": "1", "title": "入栈操作与状态变化",
        "definition": "入栈 push(x) 把新元素 x 放到唯一开放的栈顶，并让长度增加一。旧元素既不移动也不重排，相同的值可以作为不同元素多次入栈。",
        "mechanism": "无界列表可以在尾部追加元素；有界栈还要先比较当前长度和容量。若容量已满，操作应报告失败并保持原状态。",
        "example": "容量为 3、初始状态为 [6]，连续尝试入栈 7、7、8。前两次成功，第三次失败，最终状态为 [6, 7, 7]。",
        "pitfall": "不能因为两个值相等就自动合并，也不能在写入后才发现容量超限并留下半更新状态。",
        "invariant": "成功后长度增加一且新栈顶等于 x；失败后长度、栈顶和已有元素顺序均不变。",
        "exercise": "为容量为 4 的栈设计三组测试：正常入栈、恰好填满、已满时再次入栈。",
        "code": "def push_bounded(stack, item, capacity):\n    if len(stack) >= capacity:\n        return False\n    stack.append(item)\n    return True",
    },
    {
        "number": "1.3", "chapter": "1", "title": "出栈操作与空栈保护",
        "definition": "出栈 pop() 返回当前栈顶并将它删除；查看栈顶 peek() 只读取而不改变状态。空栈没有合法栈顶，两个操作都必须有明确的失败约定。",
        "mechanism": "调用方应先检查是否为空，或让接口同时返回成功标记与元素。这样即使 None 是合法数据，也不会与失败结果混淆。",
        "example": "状态 [None] 第一次 safe_pop 返回 (True, None)，第二次返回 (False, None)。成功标记说明两次 None 的含义不同。",
        "pitfall": "只想比较栈顶却调用 pop 会过早丢失状态；已经完成配对却只调用 peek，又会让旧元素错误地残留。",
        "invariant": "非空栈成功出栈后长度减少一；空栈失败出栈不创建元素，也不让长度变成负数。",
        "exercise": "比较 peek 和 pop 对 [3, 9] 的返回值与操作后状态，并说明为什么需要分别提供两个接口。",
        "table": (["操作", "返回内容", "长度变化"], [["peek", "当前栈顶", "不变"], ["pop", "被删除的栈顶", "减一"], ["is_empty", "布尔值", "不变"]]),
    },
    {
        "number": "1.4", "chapter": "1", "title": "顺序栈的存储与不变量",
        "definition": "顺序栈使用连续存储区域保存元素，并用 size 或 top 记录有效范围。容量描述最多可存多少元素，长度描述当前实际存了多少元素。",
        "mechanism": "采用 size 语义时，有效元素位于 data[0:size]，栈顶索引是 size-1；采用 top 语义时，空栈常写 top=-1。两种语义不能混用。",
        "example": "capacity=5、size=3 时，有效区是 data[0] 到 data[2]，data[3] 即使保留旧值也不属于当前栈。",
        "pitfall": "清空栈只更新 size 时，底层数组可能仍含旧值。直接遍历整个数组会把无效槽位误当作栈元素。",
        "invariant": "始终满足 0 ≤ size ≤ capacity，且对非空栈 top=size-1。每个公开操作都要保持该约束。",
        "exercise": "给出 capacity=4、size=0 和 size=4 时的有效索引范围，并判断能否分别 pop 与 push。",
        "formula": r"\mathrm{top}=\mathrm{size}-1,\qquad 0\leq \mathrm{size}\leq \mathrm{capacity}",
    },
    {
        "number": "2.1", "chapter": "2", "title": "括号配对与合法序列",
        "definition": "合法括号序列同时满足类型对应、嵌套顺序正确和数量闭合。只有左右括号总数相同，不能保证序列合法。",
        "mechanism": "遇到左括号就记录它；遇到右括号时，必须与最近尚未闭合的左括号配对。最近未闭合关系正好符合后进先出。",
        "example": "([]{}) 合法；([)] 虽然左右括号数量分别相等，但右圆括号遇到的最近未闭合符号是左方括号，因此立即失败。",
        "pitfall": "分别统计圆括号、方括号和花括号数量会漏掉交叉嵌套错误，也无法指出第一次出错的位置。",
        "invariant": "扫描任一前缀后，栈从底到顶保存仍未闭合的左括号，并保持它们在输入中的出现顺序。",
        "exercise": "判断 {a+[b*(c+d)]} 与 {(])}，并为非法输入指出第一个不能继续配对的字符。",
        "visual": "合法嵌套和交叉嵌套的对比",
    },
    {
        "number": "2.2", "chapter": "2", "title": "未闭合左括号的栈表示",
        "definition": "括号扫描栈不保存所有已读字符，只保存尚未找到对应右括号的左括号。完成一次合法配对后，对应左括号就从栈中移除。",
        "mechanism": "左括号入栈；普通字符不改变栈；右括号先检查栈非空并比较类型，匹配后再出栈。栈状态是已读前缀的压缩摘要。",
        "example": "扫描 a([b])：读到 ( 后为 [(]，读到 [ 后为 [(, []，读到 ] 后回到 [(]，读到 ) 后变为空栈。",
        "pitfall": "若右括号到来时先 pop 再比较，失败时会丢失导致错误的左括号，也让诊断信息难以还原。",
        "invariant": "只要尚未失败，栈内每个元素都是已出现但未闭合的左括号；栈顶是下一次唯一允许配对的对象。",
        "exercise": "逐字符写出 ({x}[y]) 的栈状态，并标出哪些字符不会改变栈。",
        "table": (["当前字符", "前置检查", "动作"], [["左括号", "无", "入栈"], ["普通字符", "无", "忽略"], ["右括号", "非空且类型匹配", "出栈"]]),
    },
    {
        "number": "2.3", "chapter": "2", "title": "括号匹配的逐字符扫描",
        "definition": "逐字符算法从左到右只扫描一次输入，并对每个字符执行入栈、配对出栈或忽略三种动作之一。第一次违反规则时即可停止。",
        "mechanism": "右括号需要映射到期望的左括号。若栈为空，属于多余右括号；若栈顶类型不符，属于类型错配；扫描结束栈非空，属于左括号未闭合。",
        "example": "输入 ([a]) 的动作依次为 push('(')、push('[')、忽略 a、匹配并 pop、匹配并 pop，最终空栈表示成功。",
        "pitfall": "循环结束时忘记检查空栈会把 ((a) 误判为合法；把普通字符当错误则会拒绝包含变量或运算符的正常表达式。",
        "invariant": "每处理一个字符，扫描位置严格前进；若目标仍可能合法，所有待闭合左括号完整保存在栈内。",
        "exercise": "手工运行算法处理 [{x}+(y)]，记录每次 push 和 pop 的位置及操作后状态。",
        "code": "pairs = {')': '(', ']': '[', '}': '{'}\nstack = []\nfor index, char in enumerate(text):\n    if char in pairs.values():\n        stack.append((char, index))\n    elif char in pairs:\n        if not stack or stack[-1][0] != pairs[char]:\n            return False, index\n        stack.pop()\nreturn (not stack), None",
    },
    {
        "number": "2.4", "chapter": "2", "title": "失败定位与边界测试",
        "definition": "高质量实现除了返回真假，还应指出失败位置和原因。不同失败类型需要不同证据，测试集也必须逐类覆盖。",
        "mechanism": "多余右括号和类型错配可在扫描中定位当前字符；未闭合左括号只能在扫描结束后确认，位置通常取栈中最早或最近的未闭合项，接口必须写清约定。",
        "example": "输入 a] 在位置 1 遇到空栈右括号；输入 ([)] 在位置 2 类型错配；输入 ((a) 扫描结束仍有位置 0 的左括号未闭合。",
        "pitfall": "只测试合法输入容易遗漏空栈读取、错误比较符号和末尾检查。只返回统一的“格式错误”又不利于教学和调试。",
        "invariant": "一旦报告第一个失败位置，之前的前缀必须满足当前算法规则；错误分类应与该位置的可观察状态一致。",
        "exercise": "为六类输入各设计一个最小样例：空串、无括号、合法单对、多余右括号、类型错配、未闭合左括号。",
        "table": (["输入", "预期", "原因"], [["空串", "成功", "没有待闭合项"], ["a]", "失败@1", "多余右括号"], ["([)]", "失败@2", "类型错配"], ["((a)", "失败@结束", "仍有未闭合项"]]),
    },
    {
        "number": "3.1", "chapter": "3", "title": "栈操作的时间与空间开销",
        "definition": "分析复杂度时要说明数据规模和实现模型。动态数组尾部入栈通常是摊还 O(1)，出栈和查看栈顶是 O(1)，括号扫描总时间是 O(n)。",
        "mechanism": "每个字符最多被检查一次，每个左括号最多入栈一次并出栈一次。栈的最大深度等于扫描过程中同时未闭合左括号的最大数量。",
        "example": "完全嵌套的 (((()))) 会让栈深度达到 4；连续的 ()()() 每次很快清空，最大深度只有 1，但二者都扫描 8 或 6 个字符。",
        "pitfall": "O(n) 不表示所有输入耗时完全相同，也不能因为单次 push 是常数时间就声称整个长度为 n 的扫描是 O(1)。",
        "invariant": "时间上界由已检查字符数决定，额外空间上界由未闭合括号最大深度决定，二者不能混为一个指标。",
        "exercise": "分别估计长度为 n 的全普通字符、全左括号和成对括号输入的扫描次数与最大栈深度。",
        "formula": r"T(n)=O(n),\qquad S(n)=O(d),\quad 0\leq d\leq n",
    },
    {
        "number": "3.2", "chapter": "3", "title": "浏览器前进后退的双栈模型",
        "definition": "简化的浏览历史可以用后退栈、当前页和前进栈表示。访问新页面、后退和前进分别改变三个部分，但都只操作相应栈顶。",
        "mechanism": "访问新页面时把当前页压入后退栈并清空前进栈；后退时把当前页压入前进栈，再从后退栈取出新当前页；前进执行对称操作。",
        "example": "依次访问 A、B、C 后后退到 B，前进栈含 C。此时访问 D，会形成 A→B→D 的新分支，旧的 C 前进历史被清空。",
        "pitfall": "若访问新页面后仍保留旧前进栈，用户可能前进到已经不属于当前历史分支的页面，状态模型就不再一致。",
        "invariant": "后退栈顶是最近的上一页，前进栈顶是最近的下一页；当前页不同时出现在两个栈顶作为可立即访问项。",
        "exercise": "从 A 开始依次访问 B、C，后退一次，访问 D，再尝试前进。写出每一步的三个状态。",
        "visual": "后退栈、当前页与前进栈的状态迁移",
    },
    {
        "number": "3.3", "chapter": "3", "title": "撤销与重做的状态管理",
        "definition": "撤销与重做可以保存完整快照，也可以保存可逆命令。两种方案都常用两个栈组织过去与未来，但保存对象和恢复成本不同。",
        "mechanism": "执行新编辑时把可撤销记录压入 undo 栈并清空 redo 栈；撤销把记录移到 redo 栈并恢复旧状态；重做执行相反移动。",
        "example": "文本 ab 撤销到 a 后，redo 栈保存恢复 ab 的记录。若此时输入 x 得到 ax，旧分支 ab 应从 redo 栈清除。",
        "pitfall": "只存新值而不存恢复所需信息，会让撤销无法重建旧状态；无限保存快照又可能带来不可接受的内存占用。",
        "invariant": "undo 栈描述当前状态之前的可回退步骤，redo 栈只描述最近撤销形成的未来分支；新编辑使该分支失效。",
        "exercise": "比较保存完整文本快照与保存“插入字符”命令的空间、实现难度和恢复速度。",
        "table": (["方案", "优点", "代价"], [["完整快照", "恢复直接", "占用空间较大"], ["可逆命令", "增量较小", "命令必须可逆"], ["定期快照+命令", "折中", "实现更复杂"]]),
    },
    {
        "number": "3.4", "chapter": "3", "title": "后缀表达式的栈式求值",
        "definition": "后缀表达式把运算符写在操作数之后，因此不需要括号表示优先级。扫描到数字就入栈，扫描到二元运算符就弹出两个操作数并把结果入栈。",
        "mechanism": "二元运算的弹出顺序不能颠倒：第一次弹出的是右操作数，第二次弹出的是左操作数。扫描结束时必须恰好剩一个结果。",
        "example": "表达式 8 3 - 2 *：8、3 入栈，减法得到 5，再将 2 入栈，乘法得到 10。若写成 3-8 会错误得到 -10。",
        "pitfall": "操作数不足、非法记号和结束时剩余多个值都应报告错误。只检查每一步能否计算，仍可能接受不完整表达式。",
        "invariant": "处理任一合法前缀后，栈保存该前缀中已经完成的子表达式结果；每个二元运算让栈长度净减少一。",
        "exercise": "逐记号计算 12 3 / 2 5 + *，写出每一步栈状态，并检查最终是否只剩一个值。",
        "code": "stack = []\nfor token in tokens:\n    if token.lstrip('-').isdigit():\n        stack.append(int(token))\n    else:\n        right = stack.pop()\n        left = stack.pop()\n        stack.append(apply(token, left, right))\nassert len(stack) == 1",
    },
]


def _point_paragraphs(point: dict) -> tuple[str, str, str, str]:
    first = (
        f"{point['definition']} 这个知识点的目标不是背诵术语，而是能从操作前状态推导操作后状态，并说明改变发生在哪个位置。"
        f"教材使用清晰的状态表示避免方向歧义；遇到不同实现时，应先确认接口约定，再迁移同一条抽象规则。"
    )
    second = (
        f"工作机制：{point['mechanism']} 每一次状态变化都应能够用输入、前置条件、动作和后置条件四部分描述。"
        "把这四部分写全，可以把直觉推演变成可测试的算法步骤，也能为后续知识点提供可靠的上下文。"
    )
    third = (
        f"推演示例：{point['example']} 推演时要保留中间状态，因为只看最终答案无法判断操作顺序是否正确。"
        "如果结果与预期不同，应回到第一次状态分歧处，而不是在最后一步凭猜测修补。"
    )
    fourth = (
        f"常见错误：{point['pitfall']} 本节不把错误样例当作附带内容，而把它作为规则边界的一部分。"
        f"完成本节后应能复述并检查这条不变量：{point['invariant']}"
    )
    return first, second, third, fourth


def _build_large() -> None:
    builder = MinerUFixtureBuilder("large", "栈与括号匹配：模型、算法与应用", 30, "page-based")
    builder.title_block(0, "栈与括号匹配：模型、算法与应用", 1)
    builder.paragraph(0, "一本用于知识森林生成链路的原创测试教材。内容从后进先出模型出发，经过括号匹配算法，最后迁移到双栈历史、撤销重做和后缀表达式求值。")
    builder.paragraph(0, "测试版保留三十个原始页索引、十二个教材知识点、多级标题、重复局部标题、公式、表格、图片、代码与页眉页脚。")
    builder.image(0, "封面示意：栈顶操作与状态流动", "封面栈示意")

    builder.title_block(1, "阅读指南", 2)
    builder.paragraph(1, "第一章建立栈的状态模型，第二章把模型用于括号匹配，第三章比较复杂度并迁移到三个应用。建议按教材顺序学习，但教材顺序不等同于每两个相邻知识点都存在严格先修关系。")
    builder.paragraph(1, "正文中的“教材约定”用于固定方向、边界和返回值；“推演示例”展示可观察状态；“常见错误”用于生成边界测试。模型扩写时可以增加解释和新例子，但应保留这些原始规则及来源位置。")
    builder.list_block(1, ["列表左侧表示栈底，右侧表示栈顶", "字符位置从 0 开始", "括号算法识别英文半角 ()、[]、{}", "后缀表达式使用空格分隔整数和二元运算符"])

    builder.title_block(2, "目录", 2)
    toc_lines = [
        "1 栈的基本模型 …… 4", "1.1 后进先出与栈顶 …… 4", "1.2 入栈操作与状态变化 …… 6",
        "1.3 出栈操作与空栈保护 …… 8", "1.4 顺序栈的存储与不变量 …… 10",
        "2 括号匹配算法 …… 12", "2.1 括号配对与合法序列 …… 12", "2.2 未闭合左括号的栈表示 …… 14",
        "2.3 括号匹配的逐字符扫描 …… 16", "2.4 失败定位与边界测试 …… 18",
        "3 栈的应用与分析 …… 20", "3.1 栈操作的时间与空间开销 …… 20", "3.2 浏览器前进后退的双栈模型 …… 22",
        "3.3 撤销与重做的状态管理 …… 24", "3.4 后缀表达式的栈式求值 …… 26",
        "附录 学习回顾与练习 …… 28",
    ]
    builder.paragraph(2, "\n".join(toc_lines))
    builder.paragraph(2, "目录中的数字是模拟原教材印刷页码；结构化块使用从 0 开始的 page_idx。")

    chapters = {"1": "栈的基本模型", "2": "括号匹配算法", "3": "栈的应用与分析"}
    first_point = {"1": "1.1", "2": "2.1", "3": "3.1"}
    for point_index, point in enumerate(LARGE_POINTS):
        first_page = 3 + point_index * 2
        second_page = first_page + 1
        if point["number"] == first_point[point["chapter"]]:
            builder.title_block(first_page, f"{point['chapter']} {chapters[point['chapter']]}", 2)
        builder.title_block(first_page, f"{point['number']} {point['title']}", 3)
        first, second, third, fourth = _point_paragraphs(point)
        builder.paragraph(first_page, first)
        builder.paragraph(first_page, second)
        if "visual" in point:
            builder.image(first_page, f"图 {point['number']} {point['visual']}", point["title"])
        if "formula" in point:
            builder.equation(first_page, point["formula"], f"公式 {point['number']} 的状态约束")
        if "table" in point:
            headers, rows = point["table"]
            builder.table(first_page, f"表 {point['number']} 规则对照", headers, rows)

        builder.title_block(second_page, "推演、边界与自查", 4)
        builder.paragraph(second_page, third)
        builder.paragraph(second_page, fourth)
        builder.list_block(second_page, [
            f"状态不变量：{point['invariant']}",
            "先写操作前状态，再写触发条件与动作，最后核对操作后状态。",
            "把成功路径、边界值和失败路径分别列为测试，不用一个例子代替全部情况。",
        ])
        if "code" in point:
            builder.code(second_page, point["code"], f"算法 {point['number']} 可执行规则", subtype="algorithm")
        builder.paragraph(second_page, f"自查问题：{point['exercise']} 答案应包含至少一个中间状态和一条理由。")

    builder.title_block(27, "附录 A 学习回顾", 2)
    builder.paragraph(27, "十二个知识点可以组织为三条主线：状态表示规定栈里保存什么，算法规则规定每个输入触发什么动作，应用迁移规定同一种后进先出约束如何保存不同对象。理解主线比孤立记忆函数名更重要。")
    builder.table(27, "表 A-1 三章之间的衔接", ["章节", "核心问题", "主要产物"], [
        ["栈的基本模型", "状态如何改变", "入栈、出栈与不变量"],
        ["括号匹配算法", "字符如何驱动状态", "扫描规则与失败证据"],
        ["栈的应用与分析", "模型如何迁移", "复杂度、双栈与求值"],
    ])
    builder.paragraph(27, "教材顺序为阅读提供稳定路径，但语义关系还要另行判断。例如浏览器双栈与撤销重做互为类比，不表示学习前者是理解后者的绝对必要条件。")
    builder.paragraph(27, "复习时可以把每个知识点写成一张状态卡：卡片正面记录输入、允许的操作和栈顶方向，背面记录不变量、最小成功样例与最小失败样例。若两张卡片只有应用对象不同而状态规则相同，可以建立相关关系；若后一张卡片的推演必须引用前一张卡片的规则，才考虑建立严格先修关系。")
    builder.paragraph(27, "内容生成也应遵循同样的证据顺序。先复述教材已经给出的定义、约定和例子，再补充解释、类比或练习；新增材料若超出教材范围，应清楚标记为模型丰富。这样既能保留原教材的教学意图，也能让使用者判断某条结论来自教材正文还是后续扩展。")

    builder.title_block(28, "附录 B 综合练习", 2)
    builder.list_block(28, [
        "解释为什么 [A, B, C] 必须声明哪一侧是栈顶，并写出一次 pop 后的状态。",
        "逐字符检查输入 {[a+(b*c)]}，列出所有改变栈的步骤。",
        "为括号匹配设计覆盖多余右括号、类型错配和未闭合左括号的最小测试集。",
        "推演访问 A、B、C，后退到 B，再访问 D 后的后退栈、当前页和前进栈。",
        "计算后缀表达式 9 3 / 2 4 + *，并说明左右操作数为什么不能交换。",
    ])
    builder.paragraph(28, "开放任务：比较完整快照和可逆命令两种撤销设计；再判断这个比较应作为教材原有知识点的内容补充，还是作为一个新的模型扩展知识点。给出你的划分理由。")

    builder.title_block(29, "附录 C 参考答案与扩展边界", 2)
    builder.paragraph(29, "第一题一次 pop 返回 C，状态变为 [A, B]。第二题只有左括号入栈和与栈顶匹配的右括号出栈，普通字符不改变状态。第三题至少分别包含 a]、([)] 和 ((a) 一类输入。")
    builder.paragraph(29, "浏览历史题在访问 D 后，旧的前进分支 C 被清空。后缀表达式题依次得到 3、6 和 18。除法与减法必须保留第二次弹出值作为左操作数。")
    builder.paragraph(29, "教材没有系统讲解栈与队列比较、递归调用栈、单调栈以及中缀表达式转后缀表达式。模型可以提出这些扩展候选，但必须标记为模型补充，说明锚点与范围，并接受结构审核。")
    builder.paragraph(29, "结构审核时还要区分三种顺序：目录给出的阅读顺序、算法要求的先修顺序，以及只表示概念相近的相关关系。阅读顺序可以用虚线箭头展示，先修关系需要教材规则或可靠推理支持，相关关系则不规定方向。三种关系若混存在同一字段里，前端很难解释，后端也无法独立校验是否成环。")
    builder.paragraph(29, "本教材的十二个编号标题属于教材原有知识点；附录标题、重复出现的“推演、边界与自查”只是组织材料，不应机械转换成新的知识点。结构模型可以参考标题层级，但还必须结合正文范围、编号模式和重复语义进行判断，并保留可回查的页码与块位置，供审核界面展示来源证据。")

    builder.write({
        "chapters": [
            {"number": "1", "title": "栈的基本模型", "page": 4, "point_numbers": ["1.1", "1.2", "1.3", "1.4"]},
            {"number": "2", "title": "括号匹配算法", "page": 12, "point_numbers": ["2.1", "2.2", "2.3", "2.4"]},
            {"number": "3", "title": "栈的应用与分析", "page": 20, "point_numbers": ["3.1", "3.2", "3.3", "3.4"]},
        ],
        "textbook_points": [point["title"] for point in LARGE_POINTS],
        "point_page_ranges": {point["number"]: [4 + index * 2, 5 + index * 2] for index, point in enumerate(LARGE_POINTS)},
        "sequence": {
            "cluster_edges": [["1", "2"], ["2", "3"]],
            "point_edges": [[LARGE_POINTS[index]["number"], LARGE_POINTS[index + 1]["number"]] for index in range(len(LARGE_POINTS) - 1)],
        },
        "extension_opportunities": [
            {"title": "栈与队列的访问规则比较", "anchor": "1.1", "status": "model-enrichment-suggestion"},
            {"title": "中缀表达式转后缀表达式", "anchor": "3.4", "status": "model-only-advanced-suggestion"},
        ],
        "outline_only_headings": ["目录", "阅读指南", "推演、边界与自查", "附录 A 学习回顾", "附录 B 综合练习", "附录 C 参考答案与扩展边界"],
        "structure_notes": ["附录应保留为教材结构或材料范围，但不自动成为主知识簇或教材知识点。", "十二次重复的三级标题属于各知识点内部组织，不应合并成一个全局知识点。"],
        "coverage_features": [
            "30-page-ledger", "multi-level-headings", "12-textbook-points", "repeated-local-heading",
            "display-formula", "html-table", "relative-images", "code-and-algorithm", "lists",
            "page-furniture", "appendix-material", "explicit-extension-boundary",
        ],
        "minimum_markdown_chars": 14000,
    })


def validate_fixture(slug: str) -> dict:
    root = ROOT / slug
    expected = json.loads((root / "expected.json").read_text(encoding="utf-8"))
    markdown = (root / "full.md").read_text(encoding="utf-8")
    content_path = root / f"{slug}_content_list.json"
    content = json.loads(content_path.read_text(encoding="utf-8"))
    content_v2 = json.loads((root / f"{slug}_content_list_v2.json").read_text(encoding="utf-8"))
    layout = json.loads((root / "layout.json").read_text(encoding="utf-8"))

    assert len(content_v2) == expected["page_count"]
    assert len(layout["pdf_info"]) == expected["page_count"]
    assert len(markdown) >= expected["minimum_markdown_chars"]
    pages = {block["page_idx"] for block in content}
    assert pages == set(range(expected["page_count"]))
    assert all(0 <= coordinate <= 1000 for block in content for coordinate in block.get("bbox", []))
    for title in expected["textbook_points"]:
        assert title in markdown

    referenced = set(IMAGE_REFERENCE.findall(markdown))
    for block in content:
        path = block.get("img_path")
        if isinstance(path, str):
            referenced.add(path)
    for relative in referenced:
        pure = Path(relative)
        assert not pure.is_absolute() and ".." not in pure.parts
        assert (root / pure).is_file(), relative

    for name, digest in expected["artifacts"].items():
        assert _sha256(root / name) == digest, name
    with ZipFile(root / "result.zip") as archive:
        names = set(archive.namelist())
        assert "full.md" in names
        assert f"{slug}_content_list.json" in names
        assert all(not Path(name).is_absolute() and ".." not in Path(name).parts for name in names)

    return {
        "slug": slug,
        "pages": expected["page_count"],
        "chapters": len(expected["chapters"]),
        "points": len(expected["textbook_points"]),
        "markdown_chars": len(markdown),
        "blocks": len(content),
        "assets": len(referenced),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-only", action="store_true", help="Validate already generated fixtures without rewriting them")
    args = parser.parse_args()
    if not args.check_only:
        _build_small()
        _build_large()
    summaries = [validate_fixture("small"), validate_fixture("large")]
    print(json.dumps(summaries, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
