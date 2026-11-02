using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CurrentMusic.Core;

public sealed record Song
{
    [JsonPropertyName("ncm_id")] public long Id { get; init; }
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("artists")] public string Artists { get; init; } = "";
    [JsonPropertyName("album")] public string Album { get; init; } = "";
    [JsonPropertyName("pic")] public string Picture { get; init; } = "";
    [JsonPropertyName("duration")] public long Duration { get; init; }
    [JsonIgnore] public string Subtitle => $"{Artists} · {Album}";
}

public static class JsonFields
{
    public static JsonElement Field(this JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var field) ? field : default;
    public static string Text(this JsonElement value, string name, string fallback = "") =>
        value.Field(name) is var field && field.ValueKind == JsonValueKind.String ? field.GetString() ?? fallback : fallback;
    public static long Number(this JsonElement value, string name) =>
        value.Field(name) is var field && field.ValueKind == JsonValueKind.Number && field.TryGetInt64(out var n) ? n : 0;
    public static bool Flag(this JsonElement value, string name) => value.Field(name).ValueKind == JsonValueKind.True;
    public static IEnumerable<JsonElement> Items(this JsonElement value) =>
        value.ValueKind == JsonValueKind.Array ? value.EnumerateArray() : [];
    public static List<Song> Songs(this JsonElement value, string name = "songs") =>
        value.Field(name).Items().Select(x => x.Deserialize<Song>()).OfType<Song>().Where(x => x.Id > 0 && !string.IsNullOrEmpty(x.Name)).ToList();
}

public sealed class MusicApi(HttpClient http, string apiBase)
{
    public string BaseAddress { get; } = ClientSettings.ValidateApiBase(apiBase).AbsoluteUri;
    public string Token { get; set; } = "";
    public event Action? SessionExpired;

    public async Task<JsonElement> SendAsync(string path, object? body = null, string method = "GET",
        bool authenticated = false, CancellationToken cancellationToken = default)
    {
        // 令牌只发往当前 API 基址，调用方不能传入跨域绝对地址。
        if (path.StartsWith('/') || path.Contains(":") || path.Split('?')[0].Contains(".."))
            throw new ArgumentException("API 路径无效。");
        using var request = new HttpRequestMessage(new HttpMethod(method), new Uri(new Uri(BaseAddress), path));
        request.Headers.UserAgent.ParseAdd("CurrentMusic-Windows/1.0.0");
        request.Headers.Accept.Add(new("application/json"));
        var sentToken = authenticated ? Token : "";
        if (authenticated && sentToken.Length == 0) throw new CurrentMusicApiException("请先登录 CurrentMusic。", HttpStatusCode.Unauthorized);
        if (sentToken.Length > 0) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", sentToken);
        if (body is not null) request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(80));
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            await using var input = await response.Content.ReadAsStreamAsync(deadline.Token);
            using var output = new MemoryStream();
            var buffer = new byte[16384];
            while (true)
            {
                var count = await input.ReadAsync(buffer, deadline.Token);
                if (count == 0) break;
                if (output.Length + count > 8 * 1024 * 1024) throw new CurrentMusicApiException("服务响应过大，请减少单次请求数量。");
                output.Write(buffer, 0, count);
            }
            JsonElement result = default;
            try { using var document = JsonDocument.Parse(output.ToArray()); result = document.RootElement.Clone(); }
            catch (JsonException) when (!response.IsSuccessStatusCode) { }
            if (!response.IsSuccessStatusCode)
            {
                var message = result.Text("error", $"请求失败：HTTP {(int)response.StatusCode}");
                if (response.StatusCode == HttpStatusCode.Unauthorized && sentToken.Length > 0
                    && Token == sentToken && !message.Contains("绑定"))
                {
                    Token = "";
                    SessionExpired?.Invoke();
                }
                throw new CurrentMusicApiException(message, response.StatusCode);
            }
            return result;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { throw new CurrentMusicApiException("请求超时，请稍后重试。"); }
        catch (HttpRequestException) { throw new CurrentMusicApiException("网络连接失败，请检查网络与服务地址。"); }
        catch (IOException) { throw new CurrentMusicApiException("连接已中断，请重试。"); }
        catch (JsonException) { throw new CurrentMusicApiException("服务返回了无法识别的数据。"); }
    }

    public Task<JsonElement> GetAsync(string path, bool auth = false, CancellationToken ct = default) => SendAsync(path, authenticated: auth, cancellationToken: ct);
    public Task<JsonElement> PostAsync(string path, object body, bool auth = true, CancellationToken ct = default) => SendAsync(path, body, "POST", auth, ct);
    public Task<JsonElement> SearchAsync(string query, string type, int offset, CancellationToken ct) =>
        GetAsync($"ncm/search?keywords={Uri.EscapeDataString(query)}&type={type}&offset={offset}&limit=30", ct: ct);
}
