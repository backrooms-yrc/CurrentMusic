"""CurrentMusic's QQ Music API v3.3.6 allowlist and catalog source."""
from dataclasses import dataclass
import re

PREFIX = "/qqmusic"
UPSTREAM_VERSION = "v3.3.6"
PUBLIC = "公开"
OPTIONAL = "公开 / 可选 Bearer + QQ 会话"
LOGIN = "Bearer"
PRIVATE = "Bearer + QQ 会话"
WRITE = PRIVATE + " + confirm=1"


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    upstream: str
    auth: str
    title: str
    kind: str
    params: tuple = ()


_COMPAT = (
    ("GET", "/search", "/search", OPTIONAL, "按歌曲、歌手、专辑和歌单搜索"),
    ("GET", "/song/detail", "/song/batch", PUBLIC, "按 QQ song MID 批量读取歌曲详情"),
    ("GET", "/lyric", "/getLyric", PUBLIC, "读取归一化歌词、翻译和估算逐字轴"),
    ("GET", "/album", "/getAlbumInfo", PUBLIC, "读取专辑资料和曲目"),
    ("GET", "/artist", "/singer/detail", PUBLIC, "读取歌手资料、作品及首屏专辑"),
    ("GET", "/artist/albums", "/getSingerAlbum", PUBLIC, "分页读取歌手专辑"),
    ("GET", "/playlist", "/getSongListDetail", OPTIONAL, "读取歌单资料和曲目"),
    ("GET", "/song/url", "/getMusicPlay", PRIVATE, "按用户 QQ 会话获取完整播放地址"),
)

_SESSION = (
    ("GET", "/login/channels", "/login/channels", PUBLIC, "发现扫码登录通道"),
    ("POST", "/login/qr/key", "/login/qr/key", LOGIN, "建立扫码登录"),
    ("POST", "/login/qr/create", "/login/qr/create", LOGIN, "创建二维码"),
    ("POST", "/login/qr/check", "/login/qr/check", LOGIN, "轮询扫码结果"),
    ("POST", "/login/qr/cancel", "/login/qr/cancel", LOGIN, "取消扫码"),
    ("GET", "/login/status", "/login/status", PRIVATE, "查询 QQ 会话状态"),
    ("POST", "/login/refresh", "/login/refresh", PRIVATE, "续期 QQ 会话"),
    ("POST", "/logout", "/logout", WRITE, "撤销 QQ 会话"),
)

# The native list mirrors the pinned upstream manifest, with gateway-specific media auth.
# Upstream routes that manage login are exposed only through _SESSION.
_NATIVE = (
    ('GET', '/comment/count', PUBLIC, 'Common', ('id',)),
    ('GET', '/comment/hot', PUBLIC, 'Common', ('id', 'offset', 'limit')),
    ('GET', '/comment/list', PUBLIC, 'Common', ('id', 'page', 'limit', 'cursor', 'biztype', 'cid', 'cmd', 'reqtype')),
    ('GET', '/comment/new', PUBLIC, 'Common', ('id', 'offset', 'limit')),
    ('GET', '/getAlbumInfo/:albummid?', PUBLIC, 'Album', ('albummid',)),
    ('GET', '/getLyric/:songmid?/:isFormat?', PUBLIC, 'Song', ('songmid', 'isFormat', 'trans')),
    ('GET', '/getMusicPlay/:songmid?', PRIVATE, 'Song', ('songmid',)),
    ('GET', '/getSingerAlbum/:singermid?/:limit?/:page?', PUBLIC, 'Singer', ('singermid', 'limit', 'page')),
    ('GET', '/getSingerHotsong/:singermid?/:limit?/:page?', PUBLIC, 'Singer', ('singermid', 'limit', 'page')),
    ('GET', '/getSongInfo/:songmid?/:songid?', PUBLIC, 'Song', ('songmid', 'songid')),
    ('GET', '/getSongListDetail/:disstid?', OPTIONAL, 'Song Lists', ('disstid',)),
    ('GET', '/mv/detail', PUBLIC, 'MV', ('vid',)),
    ('GET', '/mv/list', PUBLIC, 'MV', ('area', 'version', 'offset', 'limit')),
    ('GET', '/mv/url', PRIVATE, 'MV', ('vid',)),
    ('GET', '/radio/categories', PUBLIC, 'Radio', ()),
    ('GET', '/radio/list', PRIVATE, 'Recommend', ()),
    ('GET', '/radio/recommendation-modes', PRIVATE, 'Recommend', ()),
    ('GET', '/radio/recommendation-tracks', PRIVATE, 'Recommend', ('id',)),
    ('GET', '/radio/tracks', PRIVATE, 'Recommend', ('id',)),
    ('GET', '/recommend/categories', PUBLIC, 'Recommend', ()),
    ('GET', '/recommend/categories/all', PUBLIC, 'Recommend', ()),
    ('GET', '/recommend/category-playlists', PUBLIC, 'Recommend', ('id', 'page', 'limit')),
    ('GET', '/recommend/category-playlists/sorted', PUBLIC, 'Recommend', ('id', 'offset', 'limit', 'sortId')),
    ('GET', '/recommend/feed', PRIVATE, 'Recommend', ()),
    ('GET', '/recommend/new-albums', PUBLIC, 'Recommend', ('area', 'offset', 'limit')),
    ('GET', '/recommend/new-songs', PUBLIC, 'Recommend', ('area',)),
    ('GET', '/recommend/playlists', OPTIONAL, 'Recommend', ('limit',)),
    ('GET', '/recommend/radar', OPTIONAL, 'Recommend', ('page',)),
    ('GET', '/recommend/toplist', PUBLIC, 'Recommend', ('id', 'period', 'offset', 'limit')),
    ('GET', '/recommend/toplists', PUBLIC, 'Recommend', ()),
    ('GET', '/search', OPTIONAL, 'Search', ('keyword', 'type', 'page', 'limit')),
    ('GET', '/search/hot', PUBLIC, 'Search', ()),
    ('GET', '/search/match', PUBLIC, 'Search', ('keyword',)),
    ('GET', '/search/suggest', PUBLIC, 'Search', ('keyword',)),
    ('GET', '/search/users', PRIVATE, 'Search', ('keyword', 'page', 'limit')),
    ('GET', '/singer/detail', PUBLIC, 'Singer', ('mid',)),
    ('GET', '/singer/homepage', PUBLIC, 'Singer', ('mid',)),
    ('GET', '/singer/list', PUBLIC, 'Singer', ('area', 'sex', 'genre', 'index', 'offset', 'limit')),
    ('GET', '/singer/mvs', PUBLIC, 'Singer', ('mid', 'offset', 'limit')),
    ('GET', '/singer/similar', PUBLIC, 'Singer', ('mid',)),
    ('GET', '/singer/songs', PUBLIC, 'Singer', ('mid', 'offset', 'limit')),
    ('POST', '/song/batch', PUBLIC, 'Song', ()),
    ('GET', '/song/fav-count', PUBLIC, 'Song', ('ids',)),
    ('GET', '/song/labels', PUBLIC, 'Song', ('id',)),
    ('GET', '/song/mvs', PUBLIC, 'MV', ('id',)),
    ('GET', '/song/related-playlists', PRIVATE, 'Song', ('id',)),
    ('GET', '/song/replacement', PRIVATE, 'Song', ('mid',)),
    ('GET', '/song/similar', PRIVATE, 'Song', ('id',)),
    ('GET', '/song/versions', PUBLIC, 'Song', ('id', 'mid')),
    ('POST', '/user/album/subscribe', WRITE, 'User', ()),
    ('GET', '/user/albums', PRIVATE, 'User', ('offset', 'limit')),
    ('GET', '/user/blacklist', PRIVATE, 'User', ('type',)),
    ('POST', '/user/blacklist/add', WRITE, 'User', ()),
    ('POST', '/user/blacklist/remove', WRITE, 'User', ()),
    ('GET', '/user/blacklist/style-options', PRIVATE, 'User', ('songId',)),
    ('GET', '/user/cloud', PRIVATE, 'User', ('limit', 'offset')),
    ('GET', '/user/daily-songs', PRIVATE, 'User', ()),
    ('GET', '/user/daily-songs/history', PRIVATE, 'User', ('date',)),
    ('GET', '/user/daily-songs/history/dates', PRIVATE, 'User', ()),
    ('GET', '/user/detail', PRIVATE, 'User', ()),
    ('GET', '/user/guess-you-like', PRIVATE, 'User', ()),
    ('GET', '/user/guess-you-like/modes', PRIVATE, 'User', ()),
    ('GET', '/user/guess-you-like/tracks', PRIVATE, 'User', ('pool',)),
    ('GET', '/user/liked-songs', PRIVATE, 'User', ('offset', 'limit')),
    ('GET', '/user/listening-rank', PRIVATE, 'User', ('range', 'date')),
    ('GET', '/user/music-gene', PRIVATE, 'User', ()),
    ('GET', '/user/personal-fm', PRIVATE, 'User', ('page',)),
    ('GET', '/user/playlist', PRIVATE, 'User', ('uid', 'favoriteOffset', 'playCount')),
    ('GET', '/user/playlist-detail', PRIVATE, 'User', ('tid', 'dirid', 'offset', 'limit', 'playCount')),
    ('POST', '/user/playlist/create', WRITE, 'User', ()),
    ('POST', '/user/playlist/delete', WRITE, 'User', ()),
    ('POST', '/user/playlist/rename', WRITE, 'User', ()),
    ('POST', '/user/playlist/subscribe', WRITE, 'User', ()),
    ('POST', '/user/playlist/tracks', WRITE, 'User', ()),
    ('GET', '/user/recommendation-preferences', PRIVATE, 'User', ()),
    ('POST', '/user/recommendation-preferences/update', WRITE, 'User', ()),
    ('POST', '/user/song/like', WRITE, 'User', ()),
    ('GET', '/user/subscription-status', PRIVATE, 'User', ('type', 'ids')),
    ('GET', '/user/vip', PRIVATE, 'User', ()),
)


def _native_path(path):
    return "/native" + re.sub(r":(\w+)\??", r"{\1?}", path)


ROUTES = (
    *(Route(*row, "compat") for row in _COMPAT),
    *(Route(*row, "session") for row in _SESSION),
    *(Route(method, _native_path(path), path, auth, group, "native", params)
      for method, path, auth, group, params in _NATIVE),
)

_FIXED = {route.path: route for route in ROUTES if route.kind != "native"}


def _native_pattern(path):
    return re.compile("".join(
        r"(?:/[A-Za-z0-9][A-Za-z0-9_,~-]{0,255})?" if part.startswith(":")
        else "/" + re.escape(part) for part in path.strip("/").split("/")
    ))


_NATIVE_MATCHERS = [(_native_pattern(route.upstream), route) for route in ROUTES if route.kind == "native"]


def match(path):
    if path in _FIXED:
        return _FIXED[path]
    if path.startswith("/native/"):
        upstream = path[len("/native"):]
        return next((route for pattern, route in _NATIVE_MATCHERS if pattern.fullmatch(upstream)), None)
    return None


def catalog(base):
    return [
        dict(method=route.method, path=PREFIX + route.path, auth=route.auth, title=route.title,
             kind=route.kind, url=f"{base}/cm{PREFIX}{route.path}")
        for route in ROUTES
    ]
