#!/usr/bin/env python3
"""从实际 Python 路由、网关登记表和已有专题文档构建静态 API 文档。"""
import argparse
import ast
from collections import defaultdict
import csv
import hashlib
import html
import itertools
import json
import os
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'backend'))
import cm_ncm_registry
import cm_ncm_gateway

GROUPS = {
    'auth': '账号与认证', 'profile': '个人资料', 'passport': '通行证与应用授权',
    'users': '用户与社交', 'ncmbind': '网易云绑定与同步', 'ncm': '音乐与媒体',
    'network': '线路测速', 'rooms': '一起听房间', 'chat': '聊天与 AI', 'ai': '聊天与 AI',
    'admin': '管理接口', 'announcements': '公告', 'posts': '动态', 'playlists': '歌单',
    'likes': '收藏与红心', 'favs': '收藏与红心', 'songs': '音乐与媒体',
    'roaming': '私人漫游', 'share': '分享', 'plays': '播放历史', 'decorations': '头像挂件',
    'download': '客户端与资源', 'x': '客户端与资源', 'cast': '客户端与资源',
}
GUIDES = {
    'passkeys-api': '通行密钥登录与绑定',
    'two-factor-api': '登录两步验证', 'passport-api': '通行证完整接入', 'password-api': '密码找回与修改', 'lyrics-api': '歌词与逐字轴',
    'private-roaming-api': '私人漫游', 'play-history-sync': '网易云听歌历史同步',
    'currentmusic-ai': '聊天 AI 与 SSE', 'share-api': '分享元数据与图片',
    'realip': 'RealIP 规则', 'third-party-ncm-sync': '第三方客户端绑定同步',
    'rooms-design': '听歌房协议与设计参考', 'network-lines-api': '线路测速',
}


def literal(node, env=None):
    if isinstance(node, ast.JoinedStr):
        return ''.join(v.value if isinstance(v, ast.Constant) else str((env or {}).get(getattr(v.value, 'id', ''), '{value}')) for v in node.values)
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError):
        return None


def condition_values(test, name):
    for node in ast.walk(test):
        if isinstance(node, ast.Compare) and isinstance(node.left, ast.Name) and node.left.id == name:
            v = literal(node.comparators[0])
            if isinstance(node.ops[0], ast.Eq) and isinstance(v, str):
                return [v]
            if isinstance(node.ops[0], ast.In) and isinstance(v, (tuple, list, set)):
                return sorted(v)
    return []


def path_templates(pattern):
    pieces, i, ident = [], 0, 0
    while i < len(pattern):
        if pattern[i] != '(':
            pieces.append([pattern[i]])
            i += 1
            continue
        start, depth, j = i, 1, i+1
        while depth and j < len(pattern):
            if pattern[j] == '\\':
                j += 2
                continue
            if pattern[j] == '(': depth += 1
            if pattern[j] == ')': depth -= 1
            j += 1
        g = pattern[start+1:j-1]
        optional = j < len(pattern) and pattern[j] == '?'
        if re.fullmatch(r'[a-zA-Z_-]+(?:\|[a-zA-Z_-]+)+', g):
            choices = g.split('|')
        elif g == '/image':
            choices = ['/image']
        elif g.startswith('?:\\.'):
            choices = ['.gif', '.png', '.apng']
        else:
            ident += 1
            name = 'filename' if pattern.startswith(('/avatar/','/chat/image/','/download/','/x/download/')) else 'id' if ident==1 else 'id'+str(ident)
            if pattern.startswith('/passport/apps/'): name='client_id'
            if pattern.startswith('/passport/grants/'): name='grant_id'
            choices = ['{' + name + '}']
        pieces.append(([''] if optional else []) + choices)
        i = j + int(optional)
    for combo in itertools.product(*pieces):
        yield ''.join(combo).replace('\\.', '.').rstrip('$').lstrip('^')


def routes(tree):
    route = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'route')
    found = {}
    def scan(statements, env=None, inherited_paths=None, prefix=None):
        patterns = {}
        previous = list(prefix or [])
        for node in statements:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == 'fullmatch':
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        patterns[target.id] = literal(node.value.args[0], env)
            if isinstance(node, ast.For) and isinstance(node.target, ast.Name):
                vals = literal(node.iter)
                if isinstance(vals, (tuple, list)):
                    for value in vals:
                        scan(node.body, {**(env or {}), node.target.id: value})
            if isinstance(node, ast.Try):
                scan(node.body, env, inherited_paths, previous)
                scan(node.orelse, env, inherited_paths, previous)
            if not isinstance(node, ast.If):
                previous.append(node)
                continue
            paths = condition_values(node.test, 'path')
            methods = condition_values(node.test, 'method')
            if not paths:
                for n in ast.walk(node.test):
                    if isinstance(n, ast.Name) and patterns.get(n.id):
                        paths = list(path_templates(patterns[n.id]))
                        break
            # 分享族由 startswith + 方法门禁包围，内部统一用正则解析。
            if not paths and methods:
                for n in node.body:
                    if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Attribute) and n.value.func.attr=='fullmatch':
                        pattern=literal(n.value.args[0],env)
                        if pattern: paths=list(path_templates(pattern))
            if not paths and methods and inherited_paths:
                paths = inherited_paths
            if paths and methods:
                documented = node
                if inherited_paths:
                    documented = ast.If(test=node.test,body=previous+node.body,orelse=[])
                    documented.lineno=node.lineno
                    if not any(isinstance(x,ast.Return) for x in ast.walk(node)):
                        documented.body += [x for x in statements if isinstance(x,ast.Return)]
                for path in paths:
                    for method in methods:
                        found[method, path.rstrip('/') or '/'] = documented
            # 嵌套 method 分支仍归属于同一匹配规则。
            if not paths or not methods:
                scan(node.body, env, paths or inherited_paths)
            if node.orelse:
                scan(node.orelse,env,inherited_paths,previous)
            if not methods:
                previous.append(node)
    scan(route.body)
    return found


def expression(node):
    return html.escape(ast.unparse(node)).replace('|', '&#124;').replace('\n', ' ')[:180]


def params(node):
    out = {}
    parents = {child: parent for parent in ast.walk(node) for child in ast.iter_child_nodes(parent)}
    for n in ast.walk(node):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == 'get' and n.args:
            key = literal(n.args[0])
            origin = ast.unparse(n.func.value)
            if origin in ('q', 'body', 'body or {}', '(body or {})') and isinstance(key, str):
                default = expression(n.args[1]) if len(n.args) > 1 else '未在 get 中指定'
                parent = parents.get(n)
                if len(n.args) == 1 and isinstance(parent, ast.BoolOp) and isinstance(parent.op, ast.Or):
                    default = expression(parent.values[-1]) + '（空值时回退）'
                out[('query' if origin == 'q' else 'JSON body', key)] = default
        if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name) and n.value.id in ('q', 'body'):
            key = literal(n.slice)
            if isinstance(key, str):
                out[('query' if n.value.id == 'q' else 'JSON body', key)] = '直接读取；须提供'
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == '_int' and n.args:
            key = literal(n.args[0])
            if isinstance(key, str):
                out['query', key] = ' / '.join(expression(x) for x in n.args[1:]) + '（默认 / 下限 / 上限）'
    return out


def auth(node):
    names = {getattr(n.func, 'id', '') for n in ast.walk(node) if isinstance(n, ast.Call)}
    if 'require_admin' in names:
        return '管理员 Bearer；角色、目标用户等级等限制另见校验说明'
    if names & {'require_user', '_get_room', '_roaming_binding'}:
        return 'CurrentMusic Bearer 登录态；房间/绑定等条件另见校验'
    if 'optional_user' in names:
        return '可选 Bearer；登录态可能改变返回字段'
    return '路由未直接调用登录检查；委托处理器可能另行校验，见说明'


def endpoint_text(method, path, node, title, access=None):
    permission = access or auth(node)
    text = [f'## {method} /cm{path}', '', title, '', f'**权限**：{permission}。', '']
    if method == 'PATCH':
        text += ['> 路由分支含 PATCH 别名，但当前 HTTP Handler 没有实现 do_PATCH；公网请使用同路径的 PUT，PATCH 不作为可用入口承诺。', '']
    path_params = re.findall(r'\{([^}]+)\}', path)
    items = [('path', key, '路径占位符；按业务替换') for key in path_params]
    items += [(where, key, default) for (where, key), default in sorted(params(node).items())]
    if items:
        text += ['### 请求参数', '', '| 位置 | 字段 | 默认/读取方式 |', '| --- | --- | --- |']
        text += [f'| {where} | `{key}` | {default} |' for where, key, default in items]
        text += ['', '> 表格列出实际代码读取的字段；get 的默认值不等于业务可省略。必填、长度和取值约束见下方校验及关联专题。', '']
    errors = set()
    responses = []
    assignments = {target.id: n.value for n in ast.walk(node) if isinstance(n, ast.Assign)
                   for target in n.targets if isinstance(target, ast.Name) and isinstance(n.value, ast.Dict)}
    for n in ast.walk(node):
        if not isinstance(n, ast.Call):
            continue
        if isinstance(n.func, ast.Name) and n.func.id == 'ApiError' and len(n.args) > 1:
            errors.add((expression(n.args[0]), expression(n.args[1])))
        if isinstance(n.func, ast.Name) and n.func.id == 'jresp' and len(n.args) > 2:
            code, value = expression(n.args[1]), n.args[2]
            if isinstance(value, ast.Name) and value.id in assignments:
                value = assignments[value.id]
            if isinstance(value, ast.Dict):
                rows = [(literal(k), expression(v)) for k, v in zip(value.keys, value.values) if isinstance(k, ast.Constant)]
                responses += [(code, rows)]
            else:
                responses += [(code, [('响应体', expression(value))])]
    if errors:
        text += ['### 参数校验与业务错误', '', '| HTTP | 服务端校验说明 |', '| --- | --- |']
        text += [f'| {code} | {msg} |' for code, msg in sorted(errors)]
        text += ['', '说明中的变量表达式表示运行时值；另有统一的认证、频控和上游错误。', '']
    text += ['### 请求模板', '', '将 `{id}` 等占位符和字段值替换为实际数据，令牌只使用你自己的 CurrentMusic 会话。', '', '```bash']
    url = 'https://music.20110208.xyz/cm' + path
    query = [(key, '<' + key + '>') for (where, key) in params(node) if where == 'query']
    if query:
        url += '?' + '&'.join(k+'='+v for k,v in query)
    cmd = f"curl --request {method} '{url}'"
    if 'Bearer' in permission or '登录' in permission or '管理员' in permission:
        cmd += " \\\n  --header 'Authorization: Bearer YOUR_CURRENTMUSIC_TOKEN'"
    body = {key: '<' + key + '>' for (where, key) in params(node) if where == 'JSON body'}
    if body and method not in ('GET', 'HEAD'):
        cmd += " \\\n  --header 'Content-Type: application/json' \\\n  --data '" + json.dumps(body, ensure_ascii=False) + "'"
    text += [cmd, '```', '']
    if responses:
        text += ['### 返回结构', '', '以下是实现中直接返回的字段与取值表达式，**不是一次真实请求的响应示例**。条件分支可能返回不同结构。', '']
        seen = set()
        for code, fields in responses:
            marker = repr((code, fields))
            if marker in seen:
                continue
            seen.add(marker)
            text += [f'HTTP {code}', '', '| 字段 | 取值/生成逻辑 |', '| --- | --- |']
            text += [f'| `{key}` | <code>{value}</code> |' for key, value in fields]
            text += ['']
    else:
        text += ['### 返回类型', '', '此分支使用专用处理器、文件或事件流响应，或在共享分支中组装 JSON。具体结构见对应专题；文件流不能按 JSON 解析。', '']
    text += [f'实现定位：`backend/cm_server.py:{node.lineno}`。接口参数和返回条件均来自该路由分支。', '']
    return '\n'.join(text)


def build(output, upstream):
    output.mkdir(parents=True, exist_ok=True)
    for name in ('index.html', 'site.css'):
        shutil.copy2(ROOT / 'api-docs' / name, output / name)
    for name in ('vendor', 'licenses'):
        shutil.copytree(ROOT / 'api-docs' / name, output / name, dirs_exist_ok=True)
    # 删除主题中的 Google Fonts 请求；全部资源在本站托管。
    css = output / 'vendor/vue.css'
    css.write_text(re.sub(r'@import\s+url\([^;]+;', '', css.read_text()), encoding='utf-8')
    source = (ROOT / 'backend/cm_server.py').read_text()
    tree = ast.parse(source)
    extracted = routes(tree)
    titles = {}
    accesses = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.Tuple) and len(n.elts) == 4 and all(isinstance(x, ast.Constant) for x in n.elts):
            m,p,a,t = [x.value for x in n.elts]
            if isinstance(p,str) and p.startswith('/'):
                for method in re.split(r'[|/]', str(m)):
                    titles[method,p] = str(t)
                    accesses[method,p] = str(a)
    own = defaultdict(list)
    manifest = []
    for (method,path),node in sorted(extracted.items(), key=lambda x:(x[0][1],x[0][0])):
        key = path.strip('/').split('/')[0]
        group = GROUPS.get(key, '平台与其他接口')
        title = titles.get((method,path), GROUPS.get(key,'平台接口') + ' · ' + path)
        own[group].append(endpoint_text(method,path,node,title,accesses.get((method,path))))
        manifest.append(dict(method=method,path='/cm'+path,group=group,line=node.lineno))
    sidebar = ['- **开始接入**', '  - [概览](README.md)', '  - [快速开始](quickstart.md)',
               '  - [认证、错误与请求约定](conventions.md)', '  - [接口完整索引](endpoints.md)', '- **自有后端接口**']
    endpoint_index = ['# 接口完整索引', '', '从实际路由自动构建；路径占位符按各接口业务解释。', '', '| 方法 | 路径 | 分类 |', '| --- | --- | --- |']
    for i,(group,articles) in enumerate(sorted(own.items())):
        filename = f'backend-{i}.md'
        (output/filename).write_text(f'# {group}\n\n'+ '\n\n'.join(articles))
        sidebar.append(f'  - [{group} · {len(articles)} 项]({filename})')
        for m in (x for x in manifest if x['group']==group):
            endpoint_index.append(f"| {m['method']} | [`{m['path']}`]({filename}) | {group} |")
    sidebar += ['- **接入专题**']
    for name,title in GUIDES.items():
        src = ROOT/'docs'/f'{name}.md'
        if src.exists():
            text = src.read_text()
            text = re.sub(r'\]\((?:\./|docs/)?([a-z0-9-]+)\.md(#[^)]*)?\)',
                          lambda m: '](' + ('guide-' if m[1] in GUIDES else '') + m[1] + '.md' + (m[2] or '') + ')', text)
            if name=='rooms-design':
                text = '> 这是一份设计参考；实际路由索引与当前实现优先。\n\n'+text
            (output/f'guide-{name}.md').write_text(text)
            sidebar.append(f'  - [{title}](guide-{name}.md)')
    build_upstream(output, upstream, sidebar, endpoint_index, manifest)
    sidebar += ['- **维护**', '  - [来源、许可与更新](about.md)']
    (output/'_sidebar.md').write_text('\n'.join(sidebar)+'\n')
    (output/'endpoints.md').write_text('\n'.join(endpoint_index)+'\n')
    (output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    (output/'build-info.json').write_text(json.dumps({
        'contentFormat': 'markdown', 'backendOperations': len(extracted),
        'upstreamPaths': len(cm_ncm_registry.REGISTRY),
        'sourceHashes': {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest()
                         for name in ['backend/cm_server.py','backend/cm_ncm_registry.py','docs/api-endpoint-phase-map.csv']},
        'upstreamDocsSha256': hashlib.sha256((upstream/'public/docs/home.md').read_bytes()).hexdigest()
                              if (upstream/'public/docs/home.md').is_file() else None,
        'upstreamDocumentationIncluded': (upstream/'public/docs/home.md').is_file(),
    }, ensure_ascii=False, indent=2))
    for p in (ROOT/'api-docs/pages').glob('*.md'):
        shutil.copy2(p,output/p.name)
    with (output/'README.md').open('a') as f:
        f.write(f'\n\n当前目录：**{len(extracted)} 项自有路由/方法组合**，**{len(cm_ncm_registry.REGISTRY)} 项上游登记路径**。\n')
    print(f'API docs: {len(extracted)} backend operations, {len(cm_ncm_registry.REGISTRY)} upstream paths → {output}')


def build_upstream(output, upstream, sidebar, index, manifest):
    home = upstream/'public/docs/home.md'
    sections = re.split(r'(?m)(?=^### )', home.read_text()) if home.is_file() else []
    if not home.is_file():
        print('Upstream docs unavailable: building registry and local routes only; set NCM_API_DIR for excerpts')
    upstream_docs = {}
    for section in sections:
        paths = re.findall(r'接口地址\s*[:：]?[^`\n]*`(/[A-Za-z0-9_/-]+)`', section)
        for path in paths:
            upstream_docs[path] = section
    with (ROOT/'docs/api-endpoint-phase-map.csv').open() as f:
        names = {r['path']:r['title'] for r in csv.DictReader(f)}
    groups = defaultdict(list)
    sidebar += ['- **网易云代理（按权限分级）**']
    for path,(tier,ttl,phase) in sorted(cm_ncm_registry.REGISTRY.items()):
        title = names.get(path, path)
        text = [f'## /cm/ncm{path}', '', title, '', f'权限层级 **T{tier}** · 网关缓存 **{ttl} 秒** · 登记阶段 **{phase}**。', '']
        if tier==3:
            text += ['> 此路径不允许泛化代理，调用返回 403。请使用账号、绑定等项目专用接口。下面的上游资料只作协议参考。', '']
        elif tier==2:
            text += ['> 写操作请使用 POST、CurrentMusic Bearer、有效网易云绑定，并在 JSON 中传 `confirm: true`；confirm 也可按网关约定传 1。不要用 GET 发起写操作。', '']
        elif tier==1:
            text += ['需要 CurrentMusic Bearer 和有效的网易云绑定；使用该用户的网易云登录态，不共享账号缓存。', '']
        else:
            text += ['媒体地址族：必须 CurrentMusic Bearer 登录后访问。' if cm_ncm_gateway.is_media_url_path(path) else '公开只读，按当前网关策略处理。项目专用路由若与此路径同名，专用路由规则优先。', '']
        # 专用实现的权限优先，不能把 T0 音源解析误写成公开。
        if path.startswith('/song/url') or path in ('/lyric','/song/detail','/playlist'):
            text += ['> 注意：该族包含项目专用封装，先查“音乐与媒体”中的同名接口。`/cm/ncm/song/url` 必须登录；`/cm/ncm/lyric` 返回归一化歌词。', '']
        raw = upstream_docs.get(path)
        if raw:
            raw = re.sub(r'^### .*\n', '', raw, count=1)
            raw = re.sub(r'(?m)^#{1,5} ', lambda m:'#'*(min(len(m[0].strip())+2,6))+' ', raw)
            raw = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', raw)
            text += ['### 上游参数与业务说明', '', '> 下述来自已部署上游版本。原始路径与 Cookie 登录说明属于上游；本站统一加 `/cm/ncm` 前缀，禁止传 Cookie、token、realIP、randomCNIP 等保留参数。', '', raw]
        else:
            module = upstream/'module'/(path.strip('/').replace('/','_')+'.js')
            if module.is_file():
                code = module.read_text()
                fields = sorted(set(re.findall(r'query\.([A-Za-z_][\w]*)',code)) - {'cookie','realIP','randomCNIP','proxy','ua'})
                text += ['### 上游模块读取的参数', '', ', '.join('`'+x+'`' for x in fields) or '模块未直接读取业务参数。', '', '该路径未匹配到上游独立说明段。字段来自已部署模块；必填条件与默认值请对照模块，不将未验证信息标为完整响应示例。', '']
                if fields:
                    text += ['| 参数 | 模块中的读取/默认表达式 |', '| --- | --- |']
                    for field in fields:
                        relevant = [line.strip() for line in code.splitlines() if re.search(r'query\.'+re.escape(field)+r'\b', line)]
                        value = html.escape(' ; '.join(relevant)).replace('|','&#124;')[:400]
                        text.append(f'| `{field}` | <code>{value}</code> |')
                    text += ['']
            else:
                text += ['该路径没有对应的上游说明段或同名模块；保留登记信息，实际可用性以接口响应为准。', '']
        text += ['### 调用模板', '', '```bash', f"curl 'https://music.20110208.xyz/cm/ncm{path}'" if tier==0 else f"curl --request POST 'https://music.20110208.xyz/cm/ncm{path}' \\\n  --header 'Authorization: Bearer YOUR_CURRENTMUSIC_TOKEN' \\\n  --header 'Content-Type: application/json' \\\n  --data '{{\"confirm\":true}}'" if tier==2 else f"curl 'https://music.20110208.xyz/cm/ncm{path}' \\\n  --header 'Authorization: Bearer YOUR_CURRENTMUSIC_TOKEN'", '```', '', '模板须补齐该接口的业务参数；T3 模板不表示可经泛化网关调用。响应结构由上游接口决定，项目专用封装见自有路由。', '']
        groups[tier].append('\n'.join(text))
        manifest.append(dict(method='POST' if tier==2 else 'BLOCKED' if tier==3 else 'GET/POST',path='/cm/ncm'+path,tier=tier,group='netease'))
        index.append(f'| {"POST" if tier==2 else "禁用泛化" if tier==3 else "GET/POST"} | [`/cm/ncm{path}`](netease-t{tier}.md) | T{tier} · {title} |')
    for tier,texts in sorted(groups.items()):
        (output/f'netease-t{tier}.md').write_text(f'# 网易云代理 T{tier}\n\n详见[统一请求约定](conventions.md)，上游说明不能覆盖本站权限边界。\n\n'+'\n'.join(texts))
        sidebar.append(f'  - [T{tier} · {len(texts)} 条登记](netease-t{tier}.md)')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',type=Path,default=ROOT/'api-docs/.generated/raw')
    p.add_argument('--upstream',type=Path,default=Path(os.environ.get('NCM_API_DIR', ROOT.parent/'ncm-api')))
    args=p.parse_args()
    build(args.output,args.upstream)
