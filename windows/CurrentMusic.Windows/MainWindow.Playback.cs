using System.Diagnostics;
using CurrentMusic.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using global::Windows.Media;
using global::Windows.Media.Core;
using global::Windows.Media.Playback;
using global::Windows.Storage.Streams;

namespace CurrentMusic.Windows;

public sealed partial class MainWindow
{
    private readonly PlaybackQueue _queue = new();
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(200) };
    private MediaPlayer? _media;
    private MediaSource? _source;
    private CancellationTokenSource? _playRequest;
    private List<LyricLine> _lyrics = [];
    private DesktopLyricsWindow? _desktopLyrics;
    private bool _updatingSeek, _seeking, _roamingActive, _recovering, _historyRecorded;
    private int _lyricIndex = -1, _wordIndex = -1, _retryCount;
    private long _generation, _listenMs;
    private long _previousTick = Stopwatch.GetTimestamp();
    private long _lastPosition, _lastTimelineMs;
    private DateTimeOffset? _bufferingSince;
    private string _streamHost = "", _streamLevel = "";
    private Song? _playingSong;
    private MusicApi? _playingApi;

    private void InitializePlayback()
    {
        _timer.Tick += (_, _) => Tick(); _timer.Start();
        SeekSlider.AddHandler(UIElement.PointerPressedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler((_, _) => _seeking = true), true);
        SeekSlider.AddHandler(UIElement.PointerReleasedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler((_, _) => { _seeking = false; SeekToSlider(); }), true);
        SeekSlider.PointerCaptureLost += (_, _) => _seeking = false;
    }
    private void EnsureMediaPlayer()
    {
        if (_media is not null) return;
        _media = new MediaPlayer { AutoPlay = false, Volume = Math.Clamp(_settings.Volume, 0, 1) };
        _media.CommandManager.IsEnabled = false;
        var smtc = _media.SystemMediaTransportControls;
        smtc.IsEnabled = true; smtc.IsPlayEnabled = smtc.IsPauseEnabled = smtc.IsNextEnabled = smtc.IsPreviousEnabled = true;
        smtc.ButtonPressed += (sender, e) => DispatcherQueue.TryEnqueue(() =>
        {
            if (e.Button == SystemMediaTransportControlsButton.Play) _media.Play();
            if (e.Button == SystemMediaTransportControlsButton.Pause) _media.Pause();
            if (e.Button == SystemMediaTransportControlsButton.Next) _ = GuardAsync(() => MoveAsync(1));
            if (e.Button == SystemMediaTransportControlsButton.Previous) _ = GuardAsync(() => MoveAsync(-1));
        });
        smtc.PlaybackPositionChangeRequested += (_, e) => DispatcherQueue.TryEnqueue(() =>
        { if (_media.PlaybackSession.CanSeek) _media.PlaybackSession.Position = e.RequestedPlaybackPosition; });
        _media.PlaybackSession.PlaybackStateChanged += (_, _) => DispatcherQueue.TryEnqueue(() =>
        {
            if (_closing) return;
            var playing = _media.PlaybackSession.PlaybackState == MediaPlaybackState.Playing;
            PlayButton.Content = new SymbolIcon(playing ? Symbol.Pause : Symbol.Play);
            smtc.PlaybackStatus = playing ? MediaPlaybackStatus.Playing : MediaPlaybackStatus.Paused;
        });
        _media.MediaEnded += (_, _) => DispatcherQueue.TryEnqueue(() => _ = GuardAsync(() => MoveAsync(1, true)));
        _media.MediaFailed += (_, _) => DispatcherQueue.TryEnqueue(() => _ = GuardAsync(RecoverAsync));
    }
    private async Task PlayCurrentAsync(bool recovery = false, TimeSpan? resumeAt = null)
    {
        var song = _queue.Current ?? throw new ArgumentException("播放队列为空，请先选择歌曲。");
        if (_api.Token.Length == 0) { Navigation.SelectedItem = Navigation.MenuItems[5]; throw new CurrentMusicApiException("请先登录后播放。"); }
        EnsureMediaPlayer();
        _playRequest?.Cancel(); _playRequest?.Dispose();
        _playRequest = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        var ct = _playRequest.Token; var api = _api; var generation = ++_generation;
        if (!recovery) { _retryCount = 0; _historyRecorded = false; }
        _ = FlushListenAsync();
        _media!.Pause(); _media.Source = null; _source?.Dispose(); _source = null;
        _playingSong = null; _lyrics.Clear(); LyricList.ItemsSource = null; _lyricIndex = _wordIndex = -1;
        _bufferingSince = null;
        StatusText.Text = $"正在解析 · {song.Name}";
        var level = _retryCount >= 2 ? "exhigh" : _settings.Quality;
        var json = await api.GetAsync($"ncm/song/url?id={song.Id}&level={Uri.EscapeDataString(level)}&alts=1{(recovery ? "&refresh=1" : "")}", true, ct);
        ct.ThrowIfCancellationRequested(); if (generation != _generation) return;
        var url = json.Text("url"); if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) url = "https://" + url[7..];
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https") throw new CurrentMusicApiException("音源地址不可用，请重试或切换音质。");
        _streamHost = uri.Host; _streamLevel = json.Text("level", level);
        _source = MediaSource.CreateFromUri(uri); _media.Source = _source;
        _playingSong = song; _playingApi = api; _lastPosition = 0; _previousTick = Stopwatch.GetTimestamp();
        _media.Volume = VolumeSlider.Value;
        if (resumeAt is not null)
        {
            var position = resumeAt.Value;
            void Opened(MediaPlayer sender, object args)
            {
                sender.MediaOpened -= Opened;
                DispatcherQueue.TryEnqueue(() => { if (generation == _generation && sender.PlaybackSession.CanSeek) sender.PlaybackSession.Position = position; });
            }
            _media.MediaOpened += Opened;
        }
        var updater = _media.SystemMediaTransportControls.DisplayUpdater;
        updater.Type = MediaPlaybackType.Music;
        updater.MusicProperties.Title = song.Name; updater.MusicProperties.Artist = song.Artists; updater.MusicProperties.AlbumTitle = song.Album;
        updater.Thumbnail = MusicItem.SafeImage(song.Picture).Length > 0 ? RandomAccessStreamReference.CreateFromUri(new Uri(song.Picture)) : null;
        updater.Update();
        NowTitle.Text = PlayerTitle.Text = song.Name; NowArtist.Text = PlayerArtist.Text = song.Subtitle;
        PlayerCover.Source = MusicItem.SafeImage(song.Picture).Length > 0 ? new BitmapImage(new Uri(song.Picture)) : null;
        _media.Play();
        StatusText.Text = $"正在播放 · {_streamLevel}";
        _ = LoadLyricsAsync(song, ct, generation);
        if (!_historyRecorded) _ = RecordWhenPlayingAsync(song, api, ct, generation);
    }
    private async Task RecordWhenPlayingAsync(Song song, MusicApi api, CancellationToken ct, long generation)
    {
        try
        {
            for (var i = 0; i < 400; i++)
            {
                await Task.Delay(200, ct);
                if (generation != _generation) return;
                if (_media?.PlaybackSession.PlaybackState == MediaPlaybackState.Playing)
                { await api.PostAsync($"plays/{song.Id}", song, ct: ct); if (generation == _generation) _historyRecorded = true; return; }
            }
        }
        catch (Exception e) when (e is OperationCanceledException or CurrentMusicApiException) { }
    }
    private async Task LoadLyricsAsync(Song song, CancellationToken ct, long generation)
    {
        try
        {
            var json = await _api.GetAsync($"ncm/lyric?id={song.Id}", ct: ct);
            ct.ThrowIfCancellationRequested(); if (generation != _generation) return;
            _lyrics = LyricLine.Parse(json); LyricList.ItemsSource = _lyrics;
            if (_lyrics.Count == 0) WordLyric.Text = "暂无歌词";
        }
        catch (OperationCanceledException) { }
        catch (Exception e) when (e is CurrentMusicApiException or System.Text.Json.JsonException or InvalidOperationException or FormatException)
        { if (generation == _generation) WordLyric.Text = "歌词暂不可用，播放不受影响。"; }
    }
    private async Task MoveAsync(int direction, bool automatic = false)
    {
        if (_roamingActive && direction > 0 && _queue.Index == _queue.Songs.Count - 1)
        {
            var songs = await GetRoamingAsync();
            if (songs.Count > 0) { foreach (var song in songs) _queue.Add(song); _queue.Select(songs[0].Id); await PlayCurrentAsync(); return; }
        }
        if (_queue.Move(direction, automatic) is not null) await PlayCurrentAsync();
    }
    private async Task RecoverAsync()
    {
        if (_closing || _recovering || _playingSong is null) return;
        if (_retryCount >= 2) { _media?.Pause(); ShowFeedback("当前音源暂时无法播放。请切换歌曲或音质后重试。", true); return; }
        _recovering = true;
        try
        {
            _retryCount++; var position = _media?.PlaybackSession.Position ?? TimeSpan.Zero;
            ShowFeedback(_retryCount >= 2 ? "正在降到极高 MP3 兼容音质重试。" : "正在刷新音源并切换 CDN 重试。", false);
            _ = QuietAsync(() => _api.PostAsync("ncm/song/url/feedback", new { id = _queue.Current?.Id, host = _streamHost, @event = "stall", level = _streamLevel }, false, _lifetime.Token));
            await PlayCurrentAsync(true, position);
        }
        finally { _recovering = false; }
    }
    private void Tick()
    {
        if (_media is null || _closing) return;
        var session = _media.PlaybackSession; var duration = session.NaturalDuration.TotalMilliseconds;
        var position = (long)session.Position.TotalMilliseconds;
        var now = Stopwatch.GetTimestamp(); var delta = (long)Stopwatch.GetElapsedTime(_previousTick, now).TotalMilliseconds; _previousTick = now;
        if (session.PlaybackState == MediaPlaybackState.Playing && position > _lastPosition && _playingSong is not null)
        {
            _listenMs += Math.Min(Math.Min(delta, position - _lastPosition), 1000);
            if (_listenMs >= 15000) _ = FlushListenAsync();
        }
        _lastPosition = position;
        if (session.PlaybackState == MediaPlaybackState.Buffering)
        {
            _bufferingSince ??= DateTimeOffset.UtcNow;
            if (DateTimeOffset.UtcNow - _bufferingSince > TimeSpan.FromSeconds(20))
            { _bufferingSince = DateTimeOffset.UtcNow; _ = GuardAsync(RecoverAsync); }
        }
        else _bufferingSince = null;
        if (!_seeking)
        {
            _updatingSeek = true; SeekSlider.Maximum = Math.Max(1, duration); SeekSlider.Value = Math.Clamp(position, 0, SeekSlider.Maximum); _updatingSeek = false;
        }
        if ((int)(position / 1000) != (int)(_lastTimelineMs / 1000) && duration > 0)
        {
            _lastTimelineMs = position;
            _media.SystemMediaTransportControls.UpdateTimelineProperties(new SystemMediaTransportControlsTimelineProperties
            { StartTime = TimeSpan.Zero, EndTime = session.NaturalDuration, MinSeekTime = TimeSpan.Zero, MaxSeekTime = session.NaturalDuration, Position = session.Position });
        }
        ElapsedText.Text = MusicItem.FormatTime(position); DurationText.Text = MusicItem.FormatTime((long)duration);
        var index = LyricLine.FindIndex(_lyrics, position);
        if (index >= 0)
        {
            var line = _lyrics[index];
            if (_lyricIndex != index)
            { _lyricIndex = index; _wordIndex = -2; LyricList.SelectedIndex = index; LyricList.ScrollIntoView(line); }
            var wordIndex = -1; for (var i = 0; i < line.Words.Count; i++) if (line.Words[i].Time <= position) wordIndex = i;
            if (_wordIndex != wordIndex || WordLyric.Inlines.Count == 0)
            {
                _wordIndex = wordIndex; WordLyric.Inlines.Clear();
                if (line.Words.Count == 0) WordLyric.Text = line.Text;
                else for (var i = 0; i < line.Words.Count; i++) WordLyric.Inlines.Add(new Run { Text = line.Words[i].Text, Foreground = (Brush)Application.Current.Resources[i <= wordIndex ? "AccentTextFillColorPrimaryBrush" : "TextFillColorSecondaryBrush"] });
            }
            _desktopLyrics?.Update(line.Text, line.Translation.Length > 0 ? line.Translation : index + 1 < _lyrics.Count ? _lyrics[index + 1].Text : "");
        }
    }
    private async Task FlushListenAsync()
    {
        var ms = _listenMs; _listenMs = 0; var song = _playingSong; var api = _playingApi;
        if (ms > 0 && song is not null && api is not null)
            await QuietAsync(() => api.PostAsync($"plays/{song.Id}", new { ms }, ct: _lifetime.Token));
    }
    private static async Task QuietAsync(Func<Task> action)
    { try { await action(); } catch (Exception e) when (e is CurrentMusicApiException or OperationCanceledException or ObjectDisposedException) { } }
    private void StopPlayback()
    {
        _generation++; _media?.Pause(); if (_media is not null) _media.Source = null;
        _source?.Dispose(); _source = null; _playingSong = null; _playingApi = null; _listenMs = 0;
        _lyrics.Clear(); LyricList.ItemsSource = null; WordLyric.Text = ""; NowTitle.Text = "尚未播放"; NowArtist.Text = "";
        PlayButton.Content = new SymbolIcon(Symbol.Play);
        if (_media is not null) { _media.SystemMediaTransportControls.PlaybackStatus = MediaPlaybackStatus.Stopped; _media.SystemMediaTransportControls.DisplayUpdater.ClearAll(); }
    }
    private void TogglePlayback()
    {
        if (_media is null || _media.Source is null) { if (_queue.Current is not null) _ = GuardAsync(() => PlayCurrentAsync()); return; }
        if (_media.PlaybackSession.PlaybackState == MediaPlaybackState.Playing) _media.Pause(); else _media.Play();
    }
    private void Toggle_Click(object sender, RoutedEventArgs e) => TogglePlayback();
    private async void Next_Click(object sender, RoutedEventArgs e) => await GuardAsync(() => MoveAsync(1));
    private async void Previous_Click(object sender, RoutedEventArgs e) => await GuardAsync(() => MoveAsync(-1));
    private void Repeat_Changed(object sender, SelectionChangedEventArgs e) { if (_ready) _queue.Mode = (RepeatMode)RepeatPicker.SelectedIndex; }
    private void Volume_Changed(object sender, Microsoft.UI.Xaml.Controls.Primitives.RangeBaseValueChangedEventArgs e) { if (_media is not null) _media.Volume = e.NewValue; }
    private void Seek_Changed(object sender, Microsoft.UI.Xaml.Controls.Primitives.RangeBaseValueChangedEventArgs e) { if (_ready && !_updatingSeek && !_seeking) SeekToSlider(); }
    private void SeekToSlider() { if (_media?.PlaybackSession.CanSeek == true) _media.PlaybackSession.Position = TimeSpan.FromMilliseconds(SeekSlider.Value); }
    private void Lyric_ItemClick(object sender, ItemClickEventArgs e) { if (_media?.PlaybackSession.CanSeek == true && e.ClickedItem is LyricLine line) _media.PlaybackSession.Position = TimeSpan.FromMilliseconds(line.Time); }
    private void DesktopLyrics_Click(object sender, RoutedEventArgs e)
    {
        if (_desktopLyrics is not null) { _desktopLyrics.Close(); return; }
        _desktopLyrics = new DesktopLyricsWindow(); _desktopLyrics.Closed += (_, _) => _desktopLyrics = null; _desktopLyrics.Activate();
    }
}
