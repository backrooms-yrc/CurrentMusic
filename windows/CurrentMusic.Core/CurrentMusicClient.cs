using System.Diagnostics;
using System.Net;
using System.Text.Json;

namespace CurrentMusic.Core;

public sealed record ConnectionResult(TimeSpan Latency);

public sealed class CurrentMusicApiException(string message, HttpStatusCode? status = null)
    : Exception(message)
{
    public HttpStatusCode? StatusCode { get; } = status;
}

// HttpClient 由调用方管理；每次请求独立设置地址，便于取消和切换线路。
public sealed class CurrentMusicClient(HttpClient http)
{
    public async Task<ConnectionResult> ProbeAsync(string apiBase, CancellationToken cancellationToken = default)
    {
        var endpoint = new Uri(ClientSettings.ValidateApiBase(apiBase), "network/probe");
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.UserAgent.ParseAdd("CurrentMusic-Windows/0.1.0");
        request.Headers.CacheControl = new() { NoCache = true, NoStore = true };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(12));
        var watch = Stopwatch.StartNew();
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode)
                throw new CurrentMusicApiException($"服务返回 HTTP {(int)response.StatusCode}。", response.StatusCode);
            // 避免反代错误页或非预期服务的无限响应占用内存。
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            var bytes = new byte[8193];
            var length = 0;
            while (length < bytes.Length)
            {
                var read = await stream.ReadAsync(bytes.AsMemory(length), timeout.Token);
                if (read == 0) break;
                length += read;
            }
            if (length > 8192) throw new CurrentMusicApiException("服务响应超过连接检测的大小限制。");
            using var json = JsonDocument.Parse(bytes.AsMemory(0, length));
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("service", out var service) || service.ValueKind != JsonValueKind.String
                || service.GetString() != "CurrentMusic"
                || !root.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True)
                throw new CurrentMusicApiException("该地址未返回 CurrentMusic 服务标识。");
            return new(watch.Elapsed);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new CurrentMusicApiException("连接超时，请检查网络或服务地址。");
        }
        catch (HttpRequestException)
        {
            throw new CurrentMusicApiException("无法连接服务，请检查网络或 HTTPS 证书。");
        }
        catch (IOException)
        {
            throw new CurrentMusicApiException("读取服务响应时连接中断，请重试。");
        }
        catch (JsonException)
        {
            throw new CurrentMusicApiException("服务返回了无法识别的数据。");
        }
    }
}
