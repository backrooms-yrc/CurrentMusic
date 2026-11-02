using System.Text.Json;
using CurrentMusic.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace CurrentMusic.Windows;

public sealed partial class MainWindow
{
    private DateTimeOffset _nextCode;
    private void AuthMode_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready) return;
        var mode = AuthMode.SelectedIndex;
        UsernameBox.Visibility = mode is 0 or 2 ? Visibility.Visible : Visibility.Collapsed;
        PasswordBox.Visibility = mode is 0 or 2 or 3 ? Visibility.Visible : Visibility.Collapsed;
        ContactBox.Visibility = CodeBox.Visibility = SendCode.Visibility = mode != 0 ? Visibility.Visible : Visibility.Collapsed;
        NicknameBox.Visibility = mode == 2 ? Visibility.Visible : Visibility.Collapsed;
        SubmitAuth.Content = mode switch { 2 => "注册并登录", 3 => "重置密码", _ => "登录" };
        PasswordBox.Password = ""; CodeBox.Text = "";
    }
    private async Task RestoreSessionAsync()
    {
        var api = _api;
        var saved = CredentialStore.Read(_settings.ApiBase);
        if (saved is null) return;
        api.Token = saved.Token;
        var profile = await api.GetAsync("auth/me", true, _lifetime.Token);
        if (!ReferenceEquals(api, _api)) return;
        _username = profile.Text("nickname", profile.Text("username"));
        AccountButton.Content = _username; ProfileText.Text = $"已登录 · {_username}";
    }
    private async void SubmitAuth_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        SubmitAuth.IsEnabled = false;
        try
        {
            var api = _api; var mode = AuthMode.SelectedIndex;
            var username = UsernameBox.Text.Trim(); var password = PasswordBox.Password; var contact = ContactBox.Text.Trim(); var code = CodeBox.Text.Trim();
            if ((mode is 0 or 2) && username.Length == 0) throw new ArgumentException("请输入用户名。");
            if ((mode is 0 or 2 or 3) && password.Length == 0) throw new ArgumentException("请输入密码。");
            if (mode != 0 && (contact.Length == 0 || code.Length == 0)) throw new ArgumentException("请填写联系方式和验证码。");
            JsonElement result;
            if (mode == 3)
            {
                await api.PostAsync("auth/password/reset", new { email = contact, code, newPassword = password }, false, _lifetime.Token);
                PasswordBox.Password = ""; ShowFeedback("密码已重置，请重新登录。", false); return;
            }
            if (mode == 2)
            {
                var phone = !contact.Contains('@');
                result = await api.PostAsync("auth/register", new { username, password, nickname = NicknameBox.Text.Trim(), email = phone ? "" : contact, emailCode = phone ? "" : code, phone = phone ? contact : "", phoneCode = phone ? code : "", device = "CurrentMusic for Windows", platform = "windows" }, false, _lifetime.Token);
            }
            else if (mode == 1)
                result = await api.PostAsync("auth/login/email", new { email = contact, code, device = "CurrentMusic for Windows", platform = "windows" }, false, _lifetime.Token);
            else
                result = await api.PostAsync("auth/login", new { username, password, device = "CurrentMusic for Windows", platform = "windows" }, false, _lifetime.Token);
            PasswordBox.Password = "";
            if (!ReferenceEquals(api, _api)) return;
            if (result.Flag("requires2FA") || result.Flag("requiresSecurityQuestion"))
            {
                var question = result.Flag("requiresSecurityQuestion");
                var answer = new PasswordBox { Header = question ? result.Text("securityQuestion") : "验证器代码或恢复码", MinWidth = 300 };
                var dialog = new ContentDialog { Title = question ? "密保验证" : "两步验证", Content = answer, PrimaryButtonText = "验证", CloseButtonText = "取消", XamlRoot = Root.XamlRoot };
                if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
                var challengeToken = result.Text("challengeToken");
                result = question ? await api.PostAsync("auth/security-question/login", new { challengeToken, answer = answer.Password }, false, _lifetime.Token)
                    : await api.PostAsync("auth/2fa/login", new { challengeToken, code = answer.Password }, false, _lifetime.Token);
                answer.Password = "";
            }
            if (!ReferenceEquals(api, _api)) return;
            var token = result.Text("token"); if (token.Length == 0) throw new CurrentMusicApiException("登录响应缺少会话，请重试。");
            _username = result.Field("user").Text("nickname", result.Field("user").Text("username"));
            // 持久化失败仍可在当前进程使用会话，明确提示用户。
            api.Token = token;
            try { CredentialStore.Save(api.BaseAddress, new(token, _username)); }
            catch (System.ComponentModel.Win32Exception) { ShowFeedback("已登录，但 Windows 凭据管理器保存失败；关闭程序后需重新登录。", true); }
            AccountButton.Content = _username; ProfileText.Text = $"已登录 · {_username}";
            CodeBox.Text = ""; await RefreshBindingAsync();
        }
        finally { SubmitAuth.IsEnabled = true; PasswordBox.Password = ""; }
    });
    private async void SendCode_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        if (DateTimeOffset.UtcNow < _nextCode) throw new ArgumentException("验证码已发送，请等待一分钟再试。");
        var mode = AuthMode.SelectedIndex; var contact = ContactBox.Text.Trim();
        if (contact.Length == 0) throw new ArgumentException("请输入邮箱或手机号。");
        var phone = mode == 2 && !contact.Contains('@');
        var path = mode switch { 1 => "auth/login/email/code", 3 => "auth/password/code", _ => phone ? "auth/phone/code" : "auth/email/code" };
        SendCode.IsEnabled = false;
        try
        {
            await _api.PostAsync(path, phone ? new { phone = contact } : (object)new { email = contact }, false, _lifetime.Token);
            _nextCode = DateTimeOffset.UtcNow.AddMinutes(1); ShowFeedback("验证码已发送，请查收。", false);
        }
        finally { SendCode.IsEnabled = true; }
    });
    private async void Logout_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    {
        var api = _api;
        var revoke = new MusicApi(_http, api.BaseAddress) { Token = api.Token };
        _ = FlushListenAsync(); CredentialStore.Delete(api.BaseAddress); api.Token = "";
        _viewRequest?.Cancel(); _playRequest?.Cancel();
        StopPlayback(); _queue.Replace([], 0); _items.Clear();
        _username = ""; AccountButton.Content = "登录"; ProfileText.Text = "已退出登录";
        PasswordBox.Password = ""; CodeBox.Text = "";
        if (revoke.Token.Length > 0) await revoke.PostAsync("auth/logout", new { }, ct: _lifetime.Token);

    });
    private async Task RefreshBindingAsync()
    {
        if (_api.Token.Length == 0) { BindingText.Text = "请先登录 CurrentMusic。"; return; }
        var result = await _api.GetAsync("ncmbind", true, _lifetime.Token);
        BindingText.Text = result.Flag("bound") ? $"已绑定网易云 · {result.Text("nickname")}" : "尚未绑定网易云";
    }
    private async void NcmCode_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    { await _api.PostAsync("ncmbind/phone/code", new { phone = NcmPhone.Text.Trim(), ctcode = "86" }, ct: _lifetime.Token); ShowFeedback("网易云验证码已发送。", false); });
    private async void NcmLogin_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    { await _api.PostAsync("ncmbind/phone/login", new { phone = NcmPhone.Text.Trim(), captcha = NcmCode.Text.Trim(), ctcode = "86" }, ct: _lifetime.Token); NcmCode.Text = ""; await RefreshBindingAsync(); });
    private async void SyncNcm_Click(object sender, RoutedEventArgs e) => await GuardAsync(async () =>
    { await _api.PostAsync("ncmbind/sync", new { }, ct: _lifetime.Token); ShowFeedback("网易云歌单同步完成。", false); });
}
