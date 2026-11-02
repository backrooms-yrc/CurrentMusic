using System.Net;
using System.Text;
using System.Text.Json;
using CurrentMusic.Core;
using Microsoft.UI.Xaml;

namespace CurrentMusic.Windows;

public sealed partial class MainWindow
{
    // Explicit diagnostic mode, no production accounts or network mutations.
    private async Task RunSmokeTestAsync(string report)
    {
        var checks = new List<string>();
        var target = "https://smoke.invalid/cm/";
        try
        {
            void Assert(bool ok, string name) { if (!ok) throw new InvalidOperationException(name); checks.Add(name); }
            Assert(Root.XamlRoot is not null, "Native WinUI window loaded");
            using var http = new HttpClient(new SmokeHandler());
            _api = new MusicApi(http, target);
            Navigate("account"); UsernameBox.Text = "smoke"; PasswordBox.Password = "local-test-only";
            SubmitAuth_Click(SubmitAuth, new RoutedEventArgs());
            for (var i = 0; i < 100 && AccountButton.Content?.ToString() != "Smoke User"; i++) await Task.Delay(50);
            Assert(AccountButton.Content?.ToString() == "Smoke User", "Native account form signs in through API");
            var saved = CredentialStore.Read(target);
            Assert(saved?.Username == "Smoke User", "Windows Credential Manager round trip");
            Navigate("search"); QueryBox.Text = "测试"; await SearchAsync(false);
            Assert(_items.Count == 1 && _items[0].Track?.Id == 1001, "Native search results bind normalized songs");
            _queue.Replace(_items.Select(x => x.Track).OfType<Song>(), 1001);
            Navigate("queue"); Assert(_items.Count == 1, "Queue navigation renders tracks");
            Navigate("library"); await LoadLibraryAsync();
            Assert(_items.Count == 1, "Cloud library renders through API");
            var previous = _settings;
            _settings = previous with { Theme = ClientTheme.Dark }; ApplyTheme();
            Assert(Root.RequestedTheme == ElementTheme.Dark, "Native dark theme applied");
            _settings = previous;
            _store.Save(_settings); Assert(_store.Load() == _settings, "Preferences persist");
            DesktopLyrics_Click(this, new RoutedEventArgs());
            _desktopLyrics!.Update("Current line", "Next line");
            Assert(_desktopLyrics is not null, "Native always-on-top lyrics window opens");
            _desktopLyrics!.Close();
            EnsureMediaPlayer(); Assert(_media is not null, "Native MediaPlayer and SMTC initialize");
            await VerifyNativeDecodersAsync(checks);
            Navigate("settings"); Assert(SettingsPanel.Visibility == Visibility.Visible, "Settings navigation opens");
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(report))!);
            await File.WriteAllTextAsync(report, JsonSerializer.Serialize(new { success = true, checks }));
        }
        catch (Exception e)
        {
            await File.WriteAllTextAsync(report, JsonSerializer.Serialize(new { success = false, checks, error = e.GetType().Name, detail = e.Message, stack = e.StackTrace }));
        }
        finally { CredentialStore.Delete(target); _quitting = true; Close(); }
    }
    private static async Task VerifyNativeDecodersAsync(List<string> checks)
    {
        var folder = await global::Windows.Storage.StorageFolder.GetFolderFromPathAsync(Path.GetTempPath());
        foreach (var extension in new[] { "mp3", "flac" })
        {
            var input = await global::Windows.Storage.StorageFile.GetFileFromPathAsync(Path.Combine(AppContext.BaseDirectory, "Assets", "Diagnostics", "tone." + extension));
            var output = await folder.CreateFileAsync("currentmusic-decode-" + Guid.NewGuid() + ".wav", global::Windows.Storage.CreationCollisionOption.ReplaceExisting);
            try
            {
                var transcoder = new global::Windows.Media.Transcoding.MediaTranscoder();
                var profile = global::Windows.Media.MediaProperties.MediaEncodingProfile.CreateWav(global::Windows.Media.MediaProperties.AudioEncodingQuality.Low);
                var prepared = await transcoder.PrepareFileTranscodeAsync(input, output, profile);
                if (!prepared.CanTranscode) throw new InvalidOperationException("Native " + extension + " decoder unavailable: " + prepared.FailureReason);
                await prepared.TranscodeAsync();
                var properties = await output.GetBasicPropertiesAsync();
                if (properties.Size < 1000) throw new InvalidOperationException("Native decoder produced no PCM audio");
                checks.Add("Windows Media Foundation decodes " + extension + " to PCM");
            }
            finally { await output.DeleteAsync(); }
        }
    }
    private sealed class SmokeHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            const string song = "{\"ncm_id\":1001,\"name\":\"Smoke song\",\"artists\":\"Artist\",\"album\":\"Album\",\"duration\":30000}";
            var body = request.RequestUri!.AbsolutePath switch
            {
                "/cm/auth/login" => "{\"token\":\"local-smoke-session\",\"user\":{\"nickname\":\"Smoke User\"}}",
                "/cm/ncmbind" => "{\"bound\":false}",
                _ => "{\"songs\":[" + song + "],\"hasMore\":{\"song\":false}}"
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }
}
