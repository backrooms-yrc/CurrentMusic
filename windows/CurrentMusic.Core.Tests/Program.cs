using System.Net;
using System.Text;
using CurrentMusic.Core;

var passed = 0;
await Check("地址规范化并保留 API 路径", () =>
{
    Assert(ClientSettings.ValidateApiBase(" https://example.com/cm ").AbsoluteUri == "https://example.com/cm/");
    foreach (var invalid in new[] { "http://example.com/cm", "https://user:password@example.com/cm", "https://example.com/cm?q=1", "https://example.com/cm#x", "relative", "" })
        Throws<ArgumentException>(() => ClientSettings.ValidateApiBase(invalid));
    return Task.CompletedTask;
});
await Check("偏好首次加载、原子保存和损坏恢复", () =>
{
    var directory = Path.Combine(Path.GetTempPath(), "currentmusic-windows-" + Guid.NewGuid());
    var path = Path.Combine(directory, "settings.json");
    try
    {
        var store = new SettingsStore(path);
        Assert(store.Load() == new ClientSettings());
        var settings = new ClientSettings { ApiBase = "https://example.com/cm", Theme = ClientTheme.Dark };
        store.Save(settings);
        Assert(store.Load() == settings);
        Assert(Directory.GetFiles(directory).Length == 1);
        foreach (var broken in new[] { "{broken", "null", "{\"Theme\":99}", "{\"ApiBase\":null}", "{\"ApiBase\":\"http://example.com\"}" })
        {
            File.WriteAllText(path, broken);
            Assert(store.Load() == new ClientSettings());
        }
    }
    finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
    return Task.CompletedTask;
});
await Check("真实探针契约与路径、匿名请求", async () =>
{
    using var http = new HttpClient(new StubHandler((request, _) =>
    {
        Assert(request.RequestUri!.AbsoluteUri == "https://example.com/cm/network/probe");
        Assert(request.Headers.Authorization is null);
        Assert(request.Headers.UserAgent.ToString().Contains("CurrentMusic-Windows"));
        return Task.FromResult(Json("{\"service\":\"CurrentMusic\",\"ok\":true,\"now\":123}"));
    }));
    Assert((await new CurrentMusicClient(http).ProbeAsync("https://example.com/cm")).Latency >= TimeSpan.Zero);
});
await Check("拒绝非服务数据、畸形 JSON 与过大响应", async () =>
{
    foreach (var body in new[] { "{}", "[]", "null", "<html>error</html>", "{\"service\":\"Other\",\"ok\":true}", "{\"service\":12,\"ok\":true}", "{\"service\":\"CurrentMusic\",\"ok\":false}", new string('x', 8193) })
    {
        using var http = new HttpClient(new StubHandler((_, _) => Task.FromResult(Json(body))));
        await ThrowsAsync<CurrentMusicApiException>(() => new CurrentMusicClient(http).ProbeAsync("https://example.com/cm"));
    }
});
await Check("HTTP 故障保留状态码", async () =>
{
    foreach (var status in new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden, HttpStatusCode.TooManyRequests, HttpStatusCode.BadGateway, HttpStatusCode.Redirect })
    {
        using var http = new HttpClient(new StubHandler((_, _) => Task.FromResult(new HttpResponseMessage(status))));
        var error = await ThrowsAsync<CurrentMusicApiException>(() => new CurrentMusicClient(http).ProbeAsync("https://example.com/cm"));
        Assert(error.StatusCode == status);
    }
});
await Check("调用者取消被保留", async () =>
{
    using var cancellation = new CancellationTokenSource();
    using var http = new HttpClient(new StubHandler(async (_, token) =>
    {
        cancellation.Cancel();
        await Task.Delay(Timeout.Infinite, token);
        return Json("{}");
    }));
    await ThrowsAsync<OperationCanceledException>(() => new CurrentMusicClient(http).ProbeAsync("https://example.com/cm", cancellation.Token));
});
await Check("传输失败与内部超时归一", async () =>
{
    using var disconnected = new HttpClient(new StubHandler((_, _) => throw new HttpRequestException("test")));
    await ThrowsAsync<CurrentMusicApiException>(() => new CurrentMusicClient(disconnected).ProbeAsync("https://example.com/cm"));
    using var timedOut = new HttpClient(new StubHandler((_, _) => throw new TaskCanceledException()));
    var error = await ThrowsAsync<CurrentMusicApiException>(() => new CurrentMusicClient(timedOut).ProbeAsync("https://example.com/cm"));
    Assert(error.Message.Contains("超时"));
});
await Check("播放、歌词与会话功能契约", FeatureChecks.RunAsync);
if (args.Contains("--live"))
    await Check("公网 CurrentMusic 探针", async () =>
    {
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
        var result = await new CurrentMusicClient(http).ProbeAsync(ClientSettings.DefaultApiBase);
        Console.WriteLine($"  公网 HTTPS 探针: {result.Latency.TotalMilliseconds:F0} ms");
    });
if (args.Contains("--live"))
    await Check("公网搜索与歌词契约", async () =>
    {
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
        var api = new MusicApi(http, ClientSettings.DefaultApiBase);
        var result = await api.SearchAsync("Beyond", "song", 0, CancellationToken.None);
        var songs = result.Songs();
        Assert(songs.Count > 0 && songs[0].Id > 0 && songs[0].Name.Length > 0);
        var json = await api.GetAsync($"ncm/lyric?id={songs[0].Id}");
        var lyrics = LyricLine.Parse(json);
        Console.WriteLine($"  公网搜索: {songs.Count} 首；歌词: {lyrics.Count} 行");
    });
Console.WriteLine($"通过 {passed} 组检查。");

async Task Check(string name, Func<Task> test)
{
    await test();
    passed++;
    Console.WriteLine($"PASS {name}");
}
static void Assert(bool condition) { if (!condition) throw new Exception("断言失败"); }
static void Throws<T>(Action action) where T : Exception
{
    try { action(); } catch (T) { return; }
    throw new Exception($"预期异常 {typeof(T).Name}");
}
static async Task<T> ThrowsAsync<T>(Func<Task> action) where T : Exception
{
    try { await action(); } catch (T error) { return error; }
    throw new Exception($"预期异常 {typeof(T).Name}");
}
static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
{
    Content = new StringContent(body, Encoding.UTF8, "application/json")
};

sealed class StubHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        => handler(request, cancellationToken);
}
