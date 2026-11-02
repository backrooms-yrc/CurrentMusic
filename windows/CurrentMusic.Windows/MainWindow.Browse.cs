using CurrentMusic.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using global::Windows.System;

namespace CurrentMusic.Windows;

public sealed partial class MainWindow
{
    private static readonly string[] SearchTypes = ["song", "artist", "album", "playlist"];
    private async void Query_Submitted(AutoSuggestBox sender, AutoSuggestBoxQuerySubmittedEventArgs e) => await GuardAsync(() => SearchAsync(false));
    private async void Search_Click(object sender, RoutedEventArgs e) => await GuardAsync(() => SearchAsync(false));
    private async void More_Click(object sender, RoutedEventArgs e) => await GuardAsync(() => SearchAsync(true));
    private async Task SearchAsync(bool more)
    {
        if (_page != "search") return;
        var query = more ? _searchQuery : QueryBox.Text.Trim();
        if (query.Length == 0) throw new ArgumentException("请输入搜索内容。");
        var type = more ? _searchType : SearchTypes[Math.Max(0, SearchType.SelectedIndex)];
        var offset = more ? _searchOffset : 0;
        var ct = NewViewRequest();
        var result = await _api.SearchAsync(query, type, offset, ct);
        ct.ThrowIfCancellationRequested();
        if (!more) _items.Clear();
        var key = type == "song" ? "songs" : type == "artist" ? "artists" : type == "album" ? "albums" : "playlists";
        var count = 0;
        if (type == "song")
            foreach (var song in result.Songs()) { _items.Add(MusicItem.FromSong(song)); count++; }
        else
            foreach (var item in result.Field(key).Items())
            {
                _items.Add(new(item.Number("id"), item.Text("name"), item.Text("artist", item.Text("creator", item.Text("alias"))), MusicItem.SafeImage(item.Text("pic")), type)); count++;
            }
        _searchQuery = query; _searchType = type; _searchOffset = offset + count;
        LoadMore.Visibility = result.Field("hasMore").Flag(type) ? Visibility.Visible : Visibility.Collapsed;
        PageDescription.Text = _items.Count == 0 ? "没有找到结果，试试其他关键词。" : $"“{query}” · 已显示 {_items.Count} 项";
    }
    private async void Results_ItemClick(object sender, ItemClickEventArgs e) => await GuardAsync(() => OpenItemAsync((MusicItem)e.ClickedItem));
    private async void Results_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter && Results.SelectedItem is MusicItem item)
        { e.Handled = true; await GuardAsync(() => OpenItemAsync(item)); }
    }
    private async Task OpenItemAsync(MusicItem item)
    {
        if (item.Track is not null)
        {
            if (_page == "queue") _queue.Select(item.Id);
            else { _queue.Replace(_items.Select(x => x.Track).OfType<Song>(), item.Id); _roamingActive = false; }
            await PlayCurrentAsync(); return;
        }
        var ct = NewViewRequest();
        var path = item.Kind switch { "album" => $"ncm/album?id={item.Id}", "artist" => $"ncm/artist?id={item.Id}&limit=100", "local-playlist" => $"playlists/{item.Id}", _ => $"ncm/playlist?id={item.Id}" };
        var json = await _api.GetAsync(path, item.Kind == "local-playlist", ct);
        ct.ThrowIfCancellationRequested();
        _playlistId = item.Kind == "local-playlist" ? item.Id : 0; _playlistReadOnly = item.ReadOnly;
        PageTitle.Text = item.Name;
        ShowSongs(json.Songs(item.Kind == "local-playlist" ? "tracks" : "songs"), json.Text("description"));
        PlaylistToolbar.Visibility = _playlistId > 0 && !item.ReadOnly ? Visibility.Visible : Visibility.Collapsed;
        LoadMore.Visibility = Visibility.Collapsed;
        if (item.Kind == "playlist") PageDescription.Text += " · 服务端公开预览最多 100 首";
        if (item.Kind == "artist") PageDescription.Text += " · 热门作品前 100 首";
    }
    private async void Daily_Click(object sender, RoutedEventArgs e) => await GuardAsync(() => LoadDailyAsync("daily"));
    private async void ForYou_Click(object sender, RoutedEventArgs e) => await GuardAsync(() => LoadDailyAsync("forYou"));
    private async Task LoadDailyAsync(string key)
    {
        var ct = NewViewRequest();
        var result = await _api.GetAsync("daily", _api.Token.Length > 0, ct);
        ct.ThrowIfCancellationRequested(); ShowSongs(result.Songs(key), key == "daily" ? "每日推荐" : "根据你的喜欢推荐");
    }
    private async void Library_Click(object sender, RoutedEventArgs e) => await GuardAsync(LoadLibraryAsync);
    private async Task LoadLibraryAsync()
    {
        var ct = NewViewRequest(); _playlistId = 0; PlaylistToolbar.Visibility = Visibility.Collapsed;
        var kind = LibraryType.SelectedIndex;
        var path = kind switch { 1 => "favs/mine", 2 => "plays/recent?limit=100", 3 => "playlists", _ => "likes/mine" };
        var result = await _api.GetAsync(path, true, ct); ct.ThrowIfCancellationRequested();
        if (kind != 3) ShowSongs(result.Songs());
        else
        {
            _items.Clear();
            foreach (var item in result.Field("playlists").Items())
            {
                var readOnly = item.Text("source") == "ncm";
                _items.Add(new(item.Number("id"), item.Text("name"), readOnly ? "网易云同步 · 只读" : "CurrentMusic 歌单", MusicItem.SafeImage(item.Text("cover")), "local-playlist", ReadOnly: readOnly));
            }
            PageDescription.Text = $"共 {_items.Count} 个歌单";
        }
    }
    private Song SelectedSong() => (Results.SelectedItem as MusicItem)?.Track ?? throw new ArgumentException("请先选中一首歌曲。");
    private async void PlayAll_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        var songs = _items.Select(x => x.Track).OfType<Song>().ToList();
        if (songs.Count == 0) throw new ArgumentException("当前列表没有歌曲。");
        _queue.Replace(songs, songs[0].Id); _roamingActive = false; await PlayCurrentAsync();
    });
    private async void PlaySelected_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    { var song = SelectedSong(); _queue.Replace(_items.Select(x => x.Track).OfType<Song>(), song.Id); _roamingActive = false; await PlayCurrentAsync(); });
    private void Enqueue_Click(object sender, RoutedEventArgs e) => _ = GuardAsync(() =>
    { _queue.Add(SelectedSong()); ShowFeedback("已加入播放队列。", false); return Task.CompletedTask; });
    private async void Like_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        var song = SelectedSong(); var result = await _api.PostAsync($"likes/{song.Id}", song);
        ShowFeedback(result.Flag("on") ? "已加入我喜欢。" : "已取消喜欢。", false);
    });
    private async Task<string?> AskTextAsync(string title, string initial = "")
    {
        var box = new TextBox { Text = initial, MaxLength = 60, MinWidth = 300 };
        var dialog = new ContentDialog { Title = title, Content = box, PrimaryButtonText = "确定", CloseButtonText = "取消", XamlRoot = Root.XamlRoot, DefaultButton = ContentDialogButton.Primary, RequestedTheme = Root.RequestedTheme };
        return await dialog.ShowAsync() == ContentDialogResult.Primary ? box.Text.Trim() : null;
    }
    private async void CreatePlaylist_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        var name = await AskTextAsync("新建歌单"); if (string.IsNullOrEmpty(name)) return;
        await _api.PostAsync("playlists", new { name, description = "" }); await LoadLibraryAsync();
    });
    private async void RenamePlaylist_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        if (_playlistId <= 0 || _playlistReadOnly) return;
        var id = _playlistId; var name = await AskTextAsync("重命名歌单", PageTitle.Text); if (string.IsNullOrEmpty(name)) return;
        await _api.SendAsync($"playlists/{id}", new { name }, "PUT", true); PageTitle.Text = name;
    });
    private async void DeletePlaylist_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        if (_playlistId <= 0 || _playlistReadOnly) return;
        var id = _playlistId;
        var dialog = new ContentDialog { Title = "删除这个歌单？", Content = "云端歌单及曲目关联将被删除，歌曲本身不受影响。", PrimaryButtonText = "删除", CloseButtonText = "取消", XamlRoot = Root.XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        await _api.SendAsync($"playlists/{id}", new { }, "DELETE", true); await LoadLibraryAsync();
    });
    private async void RemoveTrack_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        if (_playlistId <= 0 || _playlistReadOnly) return;
        var song = SelectedSong(); var id = _playlistId;
        await _api.SendAsync($"playlists/{id}/tracks", new { songs = new[] { song } }, "DELETE", true);
        var row = _items.FirstOrDefault(x => x.Id == song.Id); if (row is not null) _items.Remove(row);
    });
    private async void AddToPlaylist_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        var song = SelectedSong(); var result = await _api.GetAsync("playlists", true, _lifetime.Token);
        var playlists = result.Field("playlists").Items().Where(x => x.Text("source") != "ncm").ToList();
        if (playlists.Count == 0) throw new ArgumentException("请先在我的音乐中新建一个歌单。");
        var picker = new ComboBox { ItemsSource = playlists.Select(x => x.Text("name")).ToList(), SelectedIndex = 0, MinWidth = 280 };
        var dialog = new ContentDialog { Title = "加入歌单", Content = picker, PrimaryButtonText = "添加", CloseButtonText = "取消", XamlRoot = Root.XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        await _api.PostAsync($"playlists/{playlists[picker.SelectedIndex].Number("id")}/tracks", new { songs = new[] { song } });
        ShowFeedback("已加入歌单。", false);
    });
    private async void Roaming_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        var songs = await GetRoamingAsync(); ShowSongs(songs, "私人漫游");
        if (songs.Count > 0) { _queue.Replace(songs, songs[0].Id); _roamingActive = true; await PlayCurrentAsync(); }
    });
    private async Task<List<Song>> GetRoamingAsync()
    {
        var mode = RoamingMode.SelectedIndex switch { 1 => "FAMILIAR", 2 => "EXPLORE", 3 or 4 => "SCENE_RCMD", _ => "DEFAULT" };
        var subMode = RoamingMode.SelectedIndex switch { 3 => "RELAX", 4 => "FOCUS", _ => "" };
        return (await _api.PostAsync("roaming/songs", new { mode, subMode, limit = 20, excludeIds = _queue.Songs.TakeLast(200).Select(x => x.Id).ToArray() }, ct: _lifetime.Token)).Songs();
    }
}
