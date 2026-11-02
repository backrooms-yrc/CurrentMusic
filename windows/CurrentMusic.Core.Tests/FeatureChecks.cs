using System.Net;
using System.Text;
using System.Text.Json;
using CurrentMusic.Core;

internal static class FeatureChecks
{
    public static async Task RunAsync()
    {
        var songs = Enumerable.Range(1, 5).Select(id => new Song { Id = id, Name = $"Song {id}" }).ToList();
        var queue = new PlaybackQueue();
        Require(queue.Move(1) is null, "empty queue");
        queue.Replace(songs.Concat(songs), 2);
        Require(queue.Songs.Count == 5 && queue.Current?.Id == 2, "queue normalization");
        queue.Mode = RepeatMode.One;
        Require(queue.Move(1, automatic: true)?.Id == 2, "repeat one end-of-track");
        Require(queue.Move(1)?.Id == 3, "manual next overrides repeat one");
        queue.Replace(songs, 1); queue.Mode = RepeatMode.Shuffle;
        var seen = new HashSet<long> { 1 };
        for (var i = 0; i < 4; i++) Require(seen.Add(queue.Move(1)!.Id), "shuffle must not repeat before exhausting cycle");
        var current = queue.Current!.Id; var previous = queue.Move(-1)!.Id;
        Require(current != previous, "shuffle previous returns history");
        Console.WriteLine("PASS queue modes, shuffle without repetitions, previous history");

        using var lyricsJson = JsonDocument.Parse("{\"lines\":[{\"t\":2000,\"txt\":\"B\",\"trans\":\"乙\",\"w\":[[2000,\"B\"]]},{\"t\":1000,\"txt\":\"A\"}]}");
        var lyrics = LyricLine.Parse(lyricsJson.RootElement);
        Require(lyrics[0].Text == "A" && LyricLine.FindIndex(lyrics, 999) == -1 && LyricLine.FindIndex(lyrics, 1000) == 0 && LyricLine.FindIndex(lyrics, 2000) == 1, "lyric boundaries");
        Require(lyrics[1].Words[0].Time == 2000 && lyrics[1].Translation == "乙", "word timing and translation");
        Console.WriteLine("PASS lyric ordering, word timing, exact boundaries");

        var expired = 0; var calls = 0;
        using var http = new HttpClient(new Handler(async (request, ct) =>
        {
            calls++;
            Require(request.RequestUri!.Host == "example.com", "session must not leave API origin");
            switch (request.RequestUri.AbsolutePath)
            {
                case "/cm/public": Require(request.Headers.Authorization is null, "public call is anonymous"); return Json("{}");
                case "/cm/private": Require(request.Headers.Authorization?.Parameter == "test-session", "private call is authenticated"); return Json("{}");
                case "/cm/auth/login":
                    Require(request.Headers.Authorization is null && request.Method == HttpMethod.Post, "login contract");
                    using (var document = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct)))
                        Require(document.RootElement.GetProperty("username").GetString() == "tester", "JSON body");
                    return Json("{\"requires2FA\":true,\"challengeToken\":\"challenge\"}");
                case "/cm/binding": return Json("{\"error\":\"请先绑定网易云\"}", HttpStatusCode.Unauthorized);
                default: return Json("{\"error\":\"会话已过期\"}", HttpStatusCode.Unauthorized);
            }
        }));
        var api = new MusicApi(http, "https://example.com/cm") { Token = "test-session" };
        api.SessionExpired += () => expired++;
        await api.GetAsync("public"); await api.GetAsync("private", true);
        var challenge = await api.PostAsync("auth/login", new { username = "tester", password = "test" }, false);
        Require(challenge.Flag("requires2FA") && challenge.Text("challengeToken") == "challenge", "challenge response");
        await Expect<CurrentMusicApiException>(() => api.GetAsync("binding", true));
        Require(api.Token.Length > 0 && expired == 0, "binding 401 retains session");
        await Expect<CurrentMusicApiException>(() => api.GetAsync("expired", true));
        Require(api.Token.Length == 0 && expired == 1, "session 401 expires once");
        var before = calls;
        await Expect<CurrentMusicApiException>(() => api.GetAsync("private", true));
        foreach (var bad in new[] { "https://evil.invalid", "//evil.invalid", "../escape" })
            await Expect<ArgumentException>(() => api.GetAsync(bad, true));
        Require(calls == before, "reject unauthenticated and foreign requests before network");
        Console.WriteLine("PASS API auth isolation, login challenges, distinct 401 behavior");

        using var tooLarge = new HttpClient(new Handler((_, _) => Task.FromResult(Json(new string('x', 8 * 1024 * 1024 + 1)))));
        await Expect<CurrentMusicApiException>(() => new MusicApi(tooLarge, "https://example.com/cm").GetAsync("large"));
        using var invalid = new HttpClient(new Handler((_, _) => Task.FromResult(Json("<html>bad gateway</html>"))));
        await Expect<CurrentMusicApiException>(() => new MusicApi(invalid, "https://example.com/cm").GetAsync("invalid"));
        Console.WriteLine("PASS API bounded bodies and malformed success responses");
    }
    private static void Require(bool ok, string message) { if (!ok) throw new Exception(message); }
    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    private static async Task Expect<T>(Func<Task> task) where T : Exception
    { try { await task(); } catch (T) { return; } throw new Exception($"Expected {typeof(T).Name}"); }
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => send(request, cancellationToken); }
}
