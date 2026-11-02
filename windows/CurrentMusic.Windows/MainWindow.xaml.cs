using System.Collections.ObjectModel;
using System.Text.Json;
using CurrentMusic.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using global::Windows.System;

namespace CurrentMusic.Windows;

public sealed record MusicItem(long Id, string Name, string Detail, string Picture, string Kind, Song? Track = null, bool ReadOnly = false)
{
    public string Badge => Kind == "song" && Track is not null ? FormatTime(Track.Duration) : Kind switch { "artist" => "歌手", "album" => "专辑", _ => "歌单" };
    public static string FormatTime(long ms) => $"{ms / 60000}:{ms / 1000 % 60:00}";
    public static MusicItem FromSong(Song song) => new(song.Id, song.Name, song.Subtitle, SafeImage(song.Picture), "song", song);
    public static string SafeImage(string uri) => Uri.TryCreate(uri, UriKind.Absolute, out var parsed) && parsed.Scheme == "https" ? uri : "";
}

public sealed partial class MainWindow : Window
{
    private static readonly string DataFolder = App.SmokeReport is not null ? Path.Combine(Path.GetTempPath(), "CurrentMusic-smoke-" + Environment.ProcessId) : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CurrentMusic", "Windows");
    private readonly SettingsStore _store = new(Path.Combine(DataFolder, "settings.json"));
    private readonly HttpClient _http = new(new HttpClientHandler { AllowAutoRedirect = false });
    private readonly CancellationTokenSource _lifetime = new();
    private readonly ObservableCollection<MusicItem> _items = [];
    private ClientSettings _settings = new();
    private MusicApi _api = null!;
    private bool _ready, _closing, _quitting, _shutdownReady;
    private string _page = "home", _username = "";
    private int _working;
    private long _playlistId;
    private bool _playlistReadOnly;
    private CancellationTokenSource? _viewRequest;
    private string _searchQuery = "", _searchType = "song";
    private int _searchOffset;
    private NativeTray? _tray;
    private static readonly string[] Qualities = ["lossless", "auto", "exhigh", "standard", "hires", "jyeffect", "jymaster", "sky"];

    public MainWindow()
    {
        InitializeComponent();
        AppWindow.Resize(new global::Windows.Graphics.SizeInt32(1240, 860));
        _settings = _store.Load();
        ApiBaseBox.Text = _settings.ApiBase;
        ThemePicker.SelectedIndex = (int)_settings.Theme;
        QualityPicker.SelectedIndex = Math.Max(0, Array.IndexOf(Qualities, _settings.Quality));
        TrayOption.IsChecked = _settings.MinimizeToTray;
        VolumeSlider.Value = Math.Clamp(_settings.Volume, 0, 1);
        Results.ItemsSource = _items;
        ConfigureApi();
        ApplyTheme();
        InitializePlayback();
        RegisterKeys();
        _ready = true;
        Navigation.SelectedItem = Navigation.MenuItems[0];
        AuthMode_Changed(AuthMode, null!);
        var handle = WinRT.Interop.WindowNative.GetWindowHandle(this);
        _tray = new NativeTray(handle, () => { AppWindow.Show(); Activate(); }, () => { _quitting = true; Close(); });
        AppWindow.Closing += async (_, args) =>
        {
            if (!_quitting && _settings.MinimizeToTray && _tray.Available)
            { args.Cancel = true; AppWindow.Hide(); return; }
            if (_shutdownReady) return;
            args.Cancel = true; _quitting = true; _media?.Pause();
            await Task.WhenAny(FlushListenAsync(), Task.Delay(2000));
            _shutdownReady = true;
            DispatcherQueue.TryEnqueue(Close);
        };
        Closed += (_, _) => Shutdown();
        Root.Loaded += async (_, _) =>
        {
            if (App.SmokeReport is not null) { await RunSmokeTestAsync(App.SmokeReport); return; }
            await GuardAsync(RestoreSessionAsync);
        };
    }

    private void ConfigureApi()
    {
        _api = new MusicApi(_http, _settings.ApiBase);
        var configured = _api;
        _api.SessionExpired += () => DispatcherQueue.TryEnqueue(() =>
        {
            if (!ReferenceEquals(configured, _api)) return;
            CredentialStore.Delete(configured.BaseAddress);
            _username = ""; AccountButton.Content = "登录";
            _playRequest?.Cancel(); StopPlayback();
            Feedback.Message = "登录已过期，请重新登录。"; Feedback.Severity = InfoBarSeverity.Warning; Feedback.IsOpen = true;
        });
    }
    private void ApplyTheme() => Root.RequestedTheme = _settings.Theme switch { ClientTheme.Light => ElementTheme.Light, ClientTheme.Dark => ElementTheme.Dark, _ => ElementTheme.Default };
    private void ThemePicker_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready) return;
        var previous = _settings;
        try { _settings = _settings with { Theme = (ClientTheme)ThemePicker.SelectedIndex }; _store.Save(_settings); ApplyTheme(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { _settings = previous; ShowFeedback("主题保存失败，请检查配置目录权限。", true); }
    }
    private async void SaveSettings_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        var normalized = ClientSettings.ValidateApiBase(ApiBaseBox.Text).AbsoluteUri.TrimEnd('/');
        var changed = normalized != _settings.ApiBase;
        var updated = _settings with { ApiBase = normalized, Quality = Qualities[Math.Max(0, QualityPicker.SelectedIndex)], MinimizeToTray = TrayOption.IsChecked == true, Volume = VolumeSlider.Value };
        _store.Save(updated); _settings = updated;
        if (changed)
        {
            _viewRequest?.Cancel(); _playRequest?.Cancel(); _ = FlushListenAsync(); StopPlayback();
            _queue.Replace([], 0); _items.Clear(); _username = ""; AccountButton.Content = "登录";
            ConfigureApi(); await RestoreSessionAsync();
        }
        ShowFeedback("设置已保存。", false);
    });
    private async void Probe_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        var result = await new CurrentMusicClient(_http).ProbeAsync(_settings.ApiBase, _lifetime.Token);
        StatusText.Text = $"已连接 CurrentMusic · {result.Latency.TotalMilliseconds:F0} ms";
    });
    private void Navigation_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs e)
    {
        if (!_ready) return;
        Navigate(e.IsSettingsSelected ? "settings" : (e.SelectedItem as NavigationViewItem)?.Tag as string ?? "home");
    }
    private void Navigate(string page)
    {
        _page = page; _playlistId = 0;
        _viewRequest?.Cancel();
        foreach (var panel in new FrameworkElement[] { ResultsPanel, SettingsPanel, AccountPanel, PlayerPanel, HomeToolbar, SearchPanel, LibraryToolbar, TrackToolbar, PlaylistToolbar }) panel.Visibility = Visibility.Collapsed;
        PageTitle.Text = page switch { "search" => "搜索", "library" => "我的音乐", "queue" => "播放队列", "player" => "正在播放", "account" => "账号", "settings" => "设置", _ => "为你推荐" };
        PageDescription.Text = ""; LoadMore.Visibility = Visibility.Collapsed;
        if (page == "settings") SettingsPanel.Visibility = Visibility.Visible;
        else if (page == "account") { AccountPanel.Visibility = Visibility.Visible; _ = GuardAsync(RefreshBindingAsync); }
        else if (page == "player") PlayerPanel.Visibility = Visibility.Visible;
        else
        {
            ResultsPanel.Visibility = TrackToolbar.Visibility = Visibility.Visible;
            if (page == "home") { HomeToolbar.Visibility = Visibility.Visible; _ = GuardAsync(() => LoadDailyAsync("daily")); }
            if (page == "search") { SearchPanel.Visibility = Visibility.Visible; _items.Clear(); QueryBox.Focus(FocusState.Programmatic); }
            if (page == "library") { LibraryToolbar.Visibility = Visibility.Visible; _ = GuardAsync(LoadLibraryAsync); }
            if (page == "queue") ShowSongs(_queue.Songs, "按顺序播放；双击或点击歌曲立即切换。");
        }
    }
    private CancellationToken NewViewRequest()
    {
        _viewRequest?.Cancel(); _viewRequest?.Dispose();
        _viewRequest = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        return _viewRequest.Token;
    }
    private void ShowSongs(IEnumerable<Song> songs, string description = "")
    {
        _items.Clear(); foreach (var song in songs) _items.Add(MusicItem.FromSong(song));
        PageDescription.Text = $"{description}  共 {_items.Count} 首";
        if (_items.Count == 0) PageDescription.Text = "暂无歌曲，请刷新或尝试其他内容。";
    }
    private async Task GuardAsync(Func<Task> action)
    {
        if (_closing) return;
        _working++; Busy.Visibility = Visibility.Visible;
        try { await action(); }
        catch (OperationCanceledException) { }
        catch (Exception error) when (error is CurrentMusicApiException or ArgumentException or IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or System.Runtime.InteropServices.COMException or System.Text.Json.JsonException or InvalidOperationException or FormatException)
        { if (!_closing) ShowFeedback(error is CurrentMusicApiException or ArgumentException ? error.Message : "操作未完成，请重试或检查本地权限。", true); }
        finally { _working--; if (!_closing && _working == 0) Busy.Visibility = Visibility.Collapsed; }
    }
    private void ShowFeedback(string message, bool error)
    { Feedback.Message = message; Feedback.Severity = error ? InfoBarSeverity.Error : InfoBarSeverity.Success; Feedback.IsOpen = true; }
    private void Account_Click(object sender, RoutedEventArgs e) => Navigation.SelectedItem = Navigation.MenuItems[5];
    private void RegisterKeys()
    {
        void Add(VirtualKey key, Action action)
        {
            var accelerator = new KeyboardAccelerator { Key = key, Modifiers = VirtualKeyModifiers.Control };
            accelerator.Invoked += (_, e) => { action(); e.Handled = true; };
            Root.KeyboardAccelerators.Add(accelerator);
        }
        Add(VirtualKey.Space, TogglePlayback);
        Add(VirtualKey.Left, () => _ = GuardAsync(() => MoveAsync(-1)));
        Add(VirtualKey.Right, () => _ = GuardAsync(() => MoveAsync(1)));
        Add(VirtualKey.F, () => { Navigation.SelectedItem = Navigation.MenuItems[1]; QueryBox.Focus(FocusState.Programmatic); });
    }
    private void Shutdown()
    {
        if (_closing) return;
        _closing = true; _timer.Stop(); _lifetime.Cancel(); _viewRequest?.Cancel(); _playRequest?.Cancel();
        try { _store.Save(_settings with { Volume = VolumeSlider.Value }); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        _desktopLyrics?.Close(); _tray?.Dispose(); _media?.Dispose(); _http.Dispose();
    }
    private async void Updates_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        var dialog = new ContentDialog { Title = "安装与升级", Content = "运行新版 MSI 即可升级，偏好和安全保存的会话会保留。升级前请从托盘退出 CurrentMusic。可在 Windows 设置中修复或卸载程序；卸载前退出登录可移除保存的会话。当前版本：1.0.0。", CloseButtonText = "知道了", XamlRoot = Root.XamlRoot };
        await dialog.ShowAsync();
    });
}
