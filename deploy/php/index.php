<?php
/**
 * CurrentMusic PHP 入口（可选部署方式）
 *
 * 用途：PHP 主机/共享主机没有 nginx proxy_pass 时，用本文件把请求透明转发到
 * 本机 Python 后端（默认 127.0.0.1:3010）。固定上游，不能当开放代理使用。
 *
 * 要求：
 *   · PHP >= 8.2 + curl 扩展；
 *   · **PHP 必须是 php2shell 修复版本**（8.2.35 / 8.3.36 / 8.4.27 / 8.5.12+），
 *     否则本入口直接 503，避免把未修复的 PHP 暴露到公网；
 *   · Web 服务器必须把 Authorization 头传给 PHP（Apache 见 .htaccess）。
 *
 * 部署：见同目录 README.md。静态 /app/ 仍由 Web 服务器直接托管，不走这里。
 */

declare(strict_types=1);

// ── 1. PHP 运行时门禁（php2shell：CVE-2026-109618 / CVE-2026-109619）────────
function cm_php_runtime_safe(): bool {
    $v = PHP_VERSION;
    $fixed = [
        '8.2' => '8.2.35',
        '8.3' => '8.3.36',
        '8.4' => '8.4.27',
        '8.5' => '8.5.12',
    ];
    $minor = substr($v, 0, 3);
    if (!isset($fixed[$minor])) return false;
    return version_compare($v, $fixed[$minor], '>=');
}
if (!cm_php_runtime_safe()) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo "CurrentMusic PHP entry refused: PHP runtime is not patched for php2shell.\n";
    echo "Require PHP 8.2.35 / 8.3.36 / 8.4.27 / 8.5.12 or newer.\n";
    exit;
}

// ── 2. 配置 ────────────────────────────────────────────────────────────────
$upstream = getenv('CM_UPSTREAM') ?: 'http://127.0.0.1:3010';
$parts = parse_url($upstream);
if (!is_array($parts) || !in_array($parts['scheme'] ?? '', ['http', 'https'], true)
    || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "CurrentMusic PHP entry misconfigured: CM_UPSTREAM\n";
    exit;
}
$upstreamBase = rtrim($upstream, '/');

// 挂在 /cm/ 下时自动从 SCRIPT_NAME 得到前缀；也可用 CM_PHP_PREFIX 显式覆盖。
$prefix = getenv('CM_PHP_PREFIX');
if ($prefix === false || $prefix === '') {
    $script = (string)($_SERVER['SCRIPT_NAME'] ?? '');
    $prefix = (basename($script) === 'index.php') ? dirname($script) : '';
    if ($prefix === '.' || $prefix === '/') $prefix = '';
}
$prefix = rtrim((string)$prefix, '/');
$uri = (string)($_SERVER['REQUEST_URI'] ?? '/');
if ($uri === '' || $uri[0] !== '/') {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo "invalid request URI\n";
    exit;
}
if ($prefix !== '' && ($uri === $prefix || str_starts_with($uri, $prefix . '/'))) {
    $uri = substr($uri, strlen($prefix));
}
if ($uri === '') $uri = '/';
$target = $upstreamBase . $uri;

// ── 3. 请求头（剔除 hop-by-hop；固定 Host 为公开域名）─────────────────────
$drop = [
    'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
    'content-length', 'expect', 'accept-encoding', 'te', 'trailer', 'upgrade',
    // 代理链头由本入口重建，绝不透传客户端自带的（否则可伪造限速 IP / realIP）
    'x-real-ip', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
    'forwarded', 'cf-connecting-ip',
];
$headers = [];
foreach (getallheaders() ?: [] as $name => $value) {
    $lower = strtolower($name);
    if (!in_array($lower, $drop, true)) $headers[] = $name . ': ' . $value;
}

$publicHost = (string)($_SERVER['HTTP_HOST'] ?? '');
if (preg_match('/^[A-Za-z0-9.\-:\[\]]+$/', $publicHost)) {
    $headers[] = 'Host: ' . $publicHost;
}

$remote = (string)($_SERVER['REMOTE_ADDR'] ?? '');
if ($remote !== '') {
    $headers[] = 'X-Real-IP: ' . $remote;
    $headers[] = 'X-Forwarded-For: ' . $remote;
}
$proto = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$headers[] = 'X-Forwarded-Proto: ' . $proto;

$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$body = ($method === 'GET' || $method === 'HEAD') ? null : file_get_contents('php://input');
if ($body === false) $body = '';

// ── 4. 响应输出（流式；SSE 必须逐条 flush）────────────────────────────────
$isSse = str_contains(strtolower((string)($_SERVER['HTTP_ACCEPT'] ?? '')), 'text/event-stream');
while (ob_get_level() > 0) @ob_end_clean();
ini_set('zlib.output_compression', '0');
ini_set('default_charset', 'UTF-8');
header_remove('X-Powered-By');
if ($isSse) {
    header('X-Accel-Buffering: no');
    header('Cache-Control: no-cache');
}

$ch = curl_init($target);
if ($ch === false) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "curl init failed\n";
    exit;
}

curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_HEADER => false,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => $isSse ? 3600 : 120,
    CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_CUSTOMREQUEST => $method,
    CURLOPT_NOBODY => $method === 'HEAD',
    CURLOPT_POSTFIELDS => $body ?? '',
    CURLOPT_HEADERFUNCTION => function ($curl, string $line): int {
        $len = strlen($line);
        $trim = trim($line);
        if ($trim === '') return $len;
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $trim, $m)) {
            http_response_code((int)$m[1]);
            return $len;
        }
        if (preg_match('/^([^:]+):\s*(.*)$/', $trim, $m)) {
            $name = strtolower(trim($m[1]));
            if (!in_array($name, ['connection', 'keep-alive', 'transfer-encoding'], true)) {
                header($m[1] . ': ' . $m[2], false);
            }
        }
        return $len;
    },
    CURLOPT_WRITEFUNCTION => function ($curl, string $chunk): int {
        echo $chunk;
        if (ob_get_level() > 0) @ob_flush();
        @flush();
        return strlen($chunk);
    },
]);

$ok = curl_exec($ch);
if ($ok === false && !headers_sent()) {
    $err = curl_error($ch);
    http_response_code(502);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => 'CurrentMusic 后端不可达'], JSON_UNESCAPED_UNICODE);
    error_log('cm_php_proxy: ' . $err);
}
$status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
if ($ok === false && headers_sent()) {
    error_log('cm_php_proxy: upstream failure after headers, status=' . $status);
}
