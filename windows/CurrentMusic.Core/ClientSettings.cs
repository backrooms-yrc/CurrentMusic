using System.Text.Json;

namespace CurrentMusic.Core;

public enum ClientTheme { System, Light, Dark }

// 仅保存偏好。第二阶段的会话凭据必须使用 Windows 安全存储。
public sealed record ClientSettings
{
    public const string DefaultApiBase = "https://music.20110208.xyz/cm";
    public string ApiBase { get; init; } = DefaultApiBase;
    public ClientTheme Theme { get; init; } = ClientTheme.System;
    public string Quality { get; init; } = "lossless";
    public double Volume { get; init; } = 0.7;
    public bool MinimizeToTray { get; init; }

    public static Uri ValidateApiBase(string value)
    {
        if (string.IsNullOrWhiteSpace(value)
            || !Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps || string.IsNullOrEmpty(uri.Host)
            || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment))
            throw new ArgumentException("请输入 HTTPS API 地址，不能包含账号、查询参数或片段。");
        return new Uri(uri.AbsoluteUri.TrimEnd('/') + "/");
    }
}

public sealed class SettingsStore(string path)
{
    public ClientSettings Load()
    {
        try
        {
            var settings = JsonSerializer.Deserialize<ClientSettings>(File.ReadAllText(path));
            if (settings is null || !Enum.IsDefined(settings.Theme) || !double.IsFinite(settings.Volume) || settings.Volume is < 0 or > 1
                || !new[] { "lossless", "auto", "exhigh", "standard", "hires", "jyeffect", "jymaster", "sky" }.Contains(settings.Quality)) return new();
            ClientSettings.ValidateApiBase(settings.ApiBase);
            return settings;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException
            or JsonException or ArgumentException)
        {
            // 首次运行、损坏或旧版本配置均回到可用默认值。
            return new();
        }
    }

    public void Save(ClientSettings settings)
    {
        ClientSettings.ValidateApiBase(settings.ApiBase);
        if (!Enum.IsDefined(settings.Theme)) throw new ArgumentException("未知主题。");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(settings));
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}
