namespace CurrentMusic.Core;

public enum RepeatMode { All, One, Shuffle }

public sealed class PlaybackQueue
{
    private readonly List<Song> _songs = [];
    private readonly List<int> _shuffleRemaining = [];
    private readonly Stack<int> _history = [];
    public IReadOnlyList<Song> Songs => _songs;
    public int Index { get; private set; } = -1;
    public Song? Current => Index >= 0 && Index < _songs.Count ? _songs[Index] : null;
    public RepeatMode Mode { get; set; }

    public void Replace(IEnumerable<Song> songs, long startId)
    {
        _songs.Clear();
        _songs.AddRange(songs.Where(s => s.Id > 0).DistinctBy(s => s.Id));
        Index = _songs.FindIndex(s => s.Id == startId);
        if (Index < 0 && _songs.Count > 0) Index = 0;
        _shuffleRemaining.Clear();
        _history.Clear();
    }
    public void Add(Song song)
    {
        if (_songs.Any(s => s.Id == song.Id)) return;
        _songs.Add(song);
        _shuffleRemaining.Clear();
        if (Index < 0) Index = 0;
    }
    public void Select(long id)
    {
        var index = _songs.FindIndex(s => s.Id == id);
        if (index >= 0) { if (Index >= 0) _history.Push(Index); Index = index; }
    }
    public Song? Move(int direction, bool automatic = false)
    {
        if (_songs.Count == 0) return null;
        if (automatic && Mode == RepeatMode.One) return Current;
        if (direction < 0 && Mode == RepeatMode.Shuffle && _history.TryPop(out var previous)) Index = previous;
        else
        {
            _history.Push(Index);
            if (Mode == RepeatMode.Shuffle && _songs.Count > 1)
            {
                _shuffleRemaining.Remove(Index);
                if (_shuffleRemaining.Count == 0)
                    _shuffleRemaining.AddRange(Enumerable.Range(0, _songs.Count).Where(i => i != Index).OrderBy(_ => Random.Shared.Next()));
                Index = _shuffleRemaining[^1];
                _shuffleRemaining.RemoveAt(_shuffleRemaining.Count - 1);
            }
            else Index = (Index + direction + _songs.Count) % _songs.Count;
        }
        return Current;
    }
}

public sealed record LyricWord(long Time, string Text);
public sealed record LyricLine(long Time, string Text, string Translation, IReadOnlyList<LyricWord> Words)
{
    public static List<LyricLine> Parse(System.Text.Json.JsonElement json) => json.Field("lines").Items()
        .Select(x => new LyricLine(x.Number("t"), x.Text("txt"), x.Text("trans"), x.Field("w").Items()
            .Where(w => w.ValueKind == System.Text.Json.JsonValueKind.Array && w.GetArrayLength() >= 2)
            .Select(w => new LyricWord(w[0].GetInt64(), w[1].GetString() ?? "")).ToList()))
        .OrderBy(x => x.Time).ToList();
    public static int FindIndex(IReadOnlyList<LyricLine> lines, long milliseconds)
    {
        int low = 0, high = lines.Count - 1, found = -1;
        while (low <= high)
        {
            var middle = (low + high) / 2;
            if (lines[middle].Time <= milliseconds) { found = middle; low = middle + 1; }
            else high = middle - 1;
        }
        return found;
    }
}
