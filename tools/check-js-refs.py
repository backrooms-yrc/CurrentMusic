#!/usr/bin/env python3
"""前端「跨文件用了但没 import」检查（P0 复发防线）。

背景（2026-10-01 P0）：player.js 调用了 songurl.js 导出的 `resolveSongUrl`，
但漏了 import。esbuild 不报错（未声明标识符当全局引用），构建与 CI 全绿，
进浏览器即 `ReferenceError` → 全站无法播放。

本工具只查**这一类**：某模块导出的名字，被另一个文件用到却没有 import。
不做完整 JS 解析（那需要真 parser），因此刻意收窄口径换取零误报：
  - 只认项目模块的导出名（export function/const/class/let、export {…}）
  - 字符串与注释先剥掉，避免把文案/链接里的词当成引用
  - 同名对象键属于罕见情况，宁可放过不误杀

用法：python3 tools/check-js-refs.py
退出码：有漏 import → 1（CI 挂）；干净 → 0
"""
from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "web", "src")

# 运行环境提供的全局（库/原生桥）：不该出现在 export_owner 里报错
GLOBAL_ALLOW = {"mdui", "MDUI", "NativeApi", "cmbridge"}

IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
EXPORT_RE = re.compile(
    r"export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)")
EXPORT_LIST_RE = re.compile(r"export\s*\{([^}]*)\}")
IMPORT_RE = re.compile(
    r"""import\s+(?:[\w$]+\s*,\s*)?(?:\*\s+as\s+[\w$]+|[\w$]+|\{[^}]*\})?\s*(?:,[^;]*)?\s*from\s*['"][^'"]+['"]"""
    r"""|import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]""", re.X)


def strip_comments_strings(text: str) -> str:
    """剥掉 // 与 /* */ 注释、'…"…' 与 `…` 字符串（保留换行以便报行号）。"""
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            if j < 0:
                break
            i = j      # 行注释直接跳到换行，换行由下一轮按普通字符处理
        elif c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i)
            if j < 0:
                break
            seg = text[i:j + 2]
            out.append("".join("\n" if ch == "\n" else " " for ch in seg))
            i = j + 2
        elif c in ("'", '"', "`"):
            q = c
            out.append(" ")          # 引号本身也变空格：**保持字符数与行号不变**
            i += 1
            while i < n:
                if text[i] == "\\":
                    out.append("  " if text[i + 1:i + 2] != "\n" else " \n")
                    i += 2
                    continue
                if q == "`":
                    # 模板串整体剥掉：${} 里常嵌 HTML/CSS 类名（如 class="... on"），
                    # 保留会大量误报。代价是模板内独有的引用可能漏报——可接受。
                    pass
                if text[i] == q:
                    out.append(" ")
                    i += 1
                    break
                out.append("\n" if text[i] == "\n" else " ")
                i += 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


# ---------- 第二道检查：模板串 ${...} 里的裸标识符是否真的存在 ----------
# 事故（2026-10-01 v1.24.0）：一次字符串手术误删了 home.js 的数据请求段，
# 模板里却仍写着 ${bannerHTML} → 首页加载即 "bannerHTML is not defined"。
#
# 口径刻意收窄到**高信号**的一种：整个插值恰好是一个裸标识符（`${foo}` 而非
# `${foo.bar}` / `${f(x)}`），且本文件从无该名字的声明。这样几乎不会误报
# （属性访问、调用、参数、解构都已排除），但正好覆盖上述事故形态。

KEYWORDS = {
    "true", "false", "null", "undefined", "this", "new", "typeof", "instanceof",
    "in", "of", "return", "function", "class", "const", "let", "var", "await",
    "async", "delete", "void", "yield", "super", "import", "export", "from", "as",
}

RUNTIME_GLOBALS = {
    "Math", "JSON", "Date", "Object", "Array", "String", "Number", "Boolean",
    "RegExp", "Error", "Promise", "Symbol", "Map", "Set", "NaN", "Infinity",
    "globalThis", "window", "document", "navigator", "location", "localStorage",
    "sessionStorage", "console", "fetch", "URL", "URLSearchParams", "performance",
    "setTimeout", "setInterval", "clearTimeout", "clearInterval", "arguments",
    "requestAnimationFrame", "queueMicrotask", "parseInt", "parseFloat", "isNaN",
    "isFinite", "encodeURIComponent", "decodeURIComponent", "Intl", "crypto",
    "mdui", "MDUI", "NativeApi", "cmbridge",
}

BARE_IDENT = re.compile(r"^[A-Za-z_$][\w$]*$")


def _decl_names(seg: str) -> set:
    """单个声明片段里被声明的名字（`m = 1` → m；`{a, b} = x` → a,b）。"""
    out = set()
    left = seg.split("=", 1)[0]
    for w in re.findall(r"([A-Za-z_$][\w$]*)\s*(?=[:,}=\]])", left):
        out.add(w)
    for w in re.findall(r"^\s*([A-Za-z_$][\w$]*)", left):
        out.add(w)
    return out


def strip_comments_only(text: str) -> str:
    """只去注释（保留字符串与模板串），且**等长替换**以保持行号。

    注释里常出现反引号（如「见 `resolveSongUrl`」），不先去掉会让后面的模板扫描
    从注释中间开始、把大段代码当成插值——这正是第一版检查器刷出上千条误报的原因。
    """
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            if j < 0:
                j = n
            out.append(" " * (j - i))
            i = j
        elif c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i)
            j = n if j < 0 else j + 2
            seg = text[i:j]
            out.append("".join("\n" if ch == "\n" else " " for ch in seg))
            i = j
        elif c in ("'", '"', "`"):
            q = c
            start = i
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == q:
                    i += 1
                    break
                i += 1
            out.append(text[start:i])
        else:
            out.append(c)
            i += 1
    return "".join(out)


def template_exprs(text: str):
    """提取模板串里 ${...} 的表达式（正确处理嵌套字符串与模板串）。"""
    out, i, n = [], 0, len(text)
    while i < n:
        if text[i] != "`":
            i += 1
            continue
        i += 1
        while i < n:
            c = text[i]
            if c == "\\":
                i += 2
                continue
            if c == "`":
                i += 1
                break
            if c == "$" and i + 1 < n and text[i + 1] == "{":
                depth, j = 1, i + 2
                start = j
                while j < n and depth:
                    ch = text[j]
                    if ch in ("'", '"', "`"):          # 表达式内部的字符串/嵌套模板串
                        iq = ch
                        j += 1
                        while j < n:
                            if text[j] == "\\":
                                j += 2
                                continue
                            if text[j] == iq:
                                j += 1
                                break
                            j += 1
                        continue
                    if ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                        if depth == 0:
                            break
                    j += 1
                out.append(text[start:j])
                i = j + 1
                continue
            i += 1
    return out


def file_scope(text: str) -> set:
    """本文件能引用的名字：import + 各类声明 + 形参/解构/catch/for-of + 运行时全局。"""
    names = set(RUNTIME_GLOBALS) | KEYWORDS
    for m in re.finditer(r"import\s+([^;]+?)\s+from", text):
        clause = m.group(1)
        for part in re.findall(r"\{([^}]*)\}", clause):
            for one in part.split(","):
                mm = re.match(r"(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?", one.strip())
                if mm:
                    names.add(mm.group(2) or mm.group(1))
        for w in re.findall(r"[\w$]+", re.sub(r"\{[^}]*\}", "", clause)):
            names.add(w)
    for m in re.finditer(r"\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)", text):
        names.add(m.group(1))
    for m in re.finditer(r"\b(?:const|let|var)\s*[\{\[][^\}\]]*[\}\]]\s*=", text):
        for w in re.findall(r"([A-Za-z_$][\w$]*)\s*(?=[:,}=\]])", m.group(0)):
            names.add(w)
    # 逗号连声明：const h = a, m = b —— 只取第一个名字会漏掉后面全部，
    # 于是 `${m}` 被误报（ui.js 的时长格式化就是这么写的）。
    for m in re.finditer(r"\b(?:const|let|var)\s+", text):
        i = m.end()
        depth = 0
        seg_start = i
        n = len(text)
        while i < n:
            c = text[i]
            if c in "{[(":
                depth += 1
            elif c in "}])":
                if depth == 0:
                    break
                depth -= 1
            elif c == ";" and depth == 0:
                break
            elif c == "," and depth == 0:
                names |= _decl_names(text[seg_start:i])
                seg_start = i + 1
            elif c == "\n" and depth == 0 and "=" not in text[seg_start:i]:
                break        # 只声明不给值的换行写法（少见）保守收手
            i += 1
        # 只认**声明左侧**：早先这里对整条声明扫标识符，会把
        # `const J = f().then(() => { bannerHTML = html })` 里的 bannerHTML
        # 当成"已声明"，于是正好漏掉本次事故形态（已用模拟事故数据回归验证）。
        names |= _decl_names(text[seg_start:i])
    for m in re.finditer(r"\(([^()]*)\)\s*(?:=>|\{)", text):
        for w in re.findall(r"[A-Za-z_$][\w$]*", m.group(1)):
            names.add(w)
    for m in re.finditer(r"([A-Za-z_$][\w$]*)\s*=>", text):
        names.add(m.group(1))
    for m in re.finditer(r"catch\s*\(\s*([A-Za-z_$][\w$]*)", text):
        names.add(m.group(1))
    for m in re.finditer(r"\b([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{", text):
        names.add(m.group(1))
    return names


def check_template_scope(rel: str, raw: str) -> list:
    code = strip_comments_only(raw)
    scope = file_scope(code)
    bad = {}
    for expr in template_exprs(code):
        t = expr.strip()
        if not BARE_IDENT.match(t) or t in scope:
            continue
        line = code.count("\n", 0, code.find("${" + expr + "}")) + 1
        bad.setdefault(t, line)
    return sorted(bad.items())


def module_exports(code: str) -> set:
    names = set()
    for m in EXPORT_RE.finditer(code):
        names.add(m.group(1))
    for m in EXPORT_LIST_RE.finditer(code):
        for part in m.group(1).split(","):
            part = part.strip()
            if not part:
                continue
            mm = re.match(r"([\w$]+)(?:\s+as\s+([\w$]+))?", part)
            if mm:
                names.add(mm.group(2) or mm.group(1))
    return names


def file_imports(code: str) -> set:
    names = set()
    for m in re.finditer(r"import\s+([^;]+?)\s+from", code):
        clause = m.group(1)
        for part in re.findall(r"[\w$]+", re.sub(r"['\"/].*$", "", clause)):
            names.add(part)
        for m2 in re.finditer(r"\{([^}]*)\}", clause):
            for one in m2.group(1).split(","):
                one = one.strip()
                if not one:
                    continue
                mm = re.match(r"(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?", one)
                if mm:
                    names.add(mm.group(2) or mm.group(1))
    # import 'xxx' / 动态 import() 不引入绑定
    return names


def main() -> int:
    files = {}
    for base, _dirs, fns in os.walk(SRC):
        for fn in sorted(fns):
            if fn.endswith(".js"):
                path = os.path.join(base, fn)
                files[os.path.relpath(path, SRC)] = open(path, encoding="utf-8").read()

    # 全项目导出名 → 属于哪个模块（同名多模块导出时不算：无法确定指向，放过）
    export_owner = {}
    dup = set()
    for rel, text in files.items():
        code = strip_comments_strings(text)
        for name in module_exports(code):
            if name in export_owner:
                dup.add(name)
            export_owner[name] = rel
    for name in dup:
        export_owner.pop(name, None)

    problems = []
    for rel, text in files.items():
        code = strip_comments_strings(text)
        # 兜底：在**原始源码**里出现过声明就视为本地。剥离器对正则字面量等无法完美处理，
        # 这一步保证「宁少报不误报」——CI 因误报变红比漏报更糟。
        local_raw = set(re.findall(r"\b(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)", text))
        imported = file_imports(code)
        # 本文件自己声明的名字（同名本地变量/函数/形参/解构不算漏 import）
        local = set()
        for m in re.finditer(r"\b(?:function|const|let|var|class)\s+([\w$]+)", code):
            local.add(m.group(1))
        # 解构声明：const { a, b: c } = / let [x, y] =（含 await import() 解构）
        for m in re.finditer(r"\b(?:const|let|var)\s*[\{\[][^\}\]]*[\}\]]\s*=", code):
            head = m.group(0)
            for name in re.findall(r"([A-Za-z_$][\w$]*)\s*(?=[:,}=\]])", head):
                local.add(name)
            for name in re.findall(r"([A-Za-z_$][\w$]*)\s*$", head.split("=")[0].rstrip()):
                local.add(name)
        # 形参（含解构形参、箭头函数单参）
        for m in re.finditer(r"\(([^()]*)\)\s*(?:=>|\{)", code):
            for name in re.findall(r"([A-Za-z_$][\w$]*)", m.group(1)):
                local.add(name)
        for m in re.finditer(r"([A-Za-z_$][\w$]*)\s*=>", code):
            local.add(m.group(1))
        # 对象方法简写 / 类字段
        for m in re.finditer(r"\b([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{", code):
            local.add(m.group(1))
        for name, owner in export_owner.items():
            if (owner == rel or name in imported or name in local
                    or name in local_raw or name in GLOBAL_ALLOW):
                continue
            for m in re.finditer(r"(?<![\w$.])" + re.escape(name) + r"(?![\w$])", code):
                # 出现在 import/export 语句里则跳过
                line_start = code.rfind("\n", 0, m.start()) + 1
                if code[line_start:m.start()].lstrip().startswith(("import", "export")):
                    continue
                # 对象字面量的键：`{ name:` / `, name:` —— 不是标识符引用
                nxt = code[m.end():m.end() + 1]
                if nxt == ":":
                    k = m.start() - 1
                    while k >= 0 and code[k] in " \t\n\r":
                        k -= 1
                    if k >= 0 and code[k] in "{,":
                        continue
                problems.append((rel, name, owner, code.count("\n", 0, m.start()) + 1))
                break

    # 第二道：模板串里的未声明引用（同一文件内可判定）
    tpl_problems = []
    for rel, text in files.items():
        for name, line in check_template_scope(rel, text):
            tpl_problems.append((rel, name, line))

    if tpl_problems:
        for rel, name, line in sorted(tpl_problems):
            print(f"✗ {rel}:{line}  模板串里引用了未声明的 `{name}`（运行时会 ReferenceError）")
    if problems:
        for rel, name, owner, line in sorted(problems):
            print(f"✗ {rel}:{line}  用了 `{name}`（{owner} 导出）但没有 import")
    if problems or tpl_problems:
        print(f"\n共 {len(problems)} 处漏 import、{len(tpl_problems)} 处模板串未声明引用"
              f" —— 这类错误 esbuild 不报，进浏览器就是 ReferenceError")
        return 1
    print(f"✓ 检查 {len(files)} 个文件：跨模块引用全部有 import，模板串引用全部有声明")
    return 0


if __name__ == "__main__":
    sys.exit(main())
