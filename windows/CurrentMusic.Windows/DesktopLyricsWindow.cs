using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace CurrentMusic.Windows;

internal sealed class DesktopLyricsWindow : Window
{
    private readonly TextBlock _current = new() { FontSize = 22, TextWrapping = TextWrapping.Wrap, Text = "等待歌词" };
    private readonly TextBlock _next = new() { FontSize = 14, TextWrapping = TextWrapping.Wrap };
    public DesktopLyricsWindow()
    {
        Title = "CurrentMusic 桌面歌词";
        var panel = new StackPanel { Spacing = 10, Padding = new Thickness(16) };
        panel.Children.Add(_current); panel.Children.Add(_next);
        Content = new Border { Background = (Brush)Application.Current.Resources["ApplicationPageBackgroundThemeBrush"], Child = panel };
        AppWindow.Resize(new global::Windows.Graphics.SizeInt32(540, 180));
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        { presenter.IsAlwaysOnTop = true; presenter.IsMaximizable = false; presenter.IsMinimizable = false; }
    }
    public void Update(string current, string next) { _current.Text = current; _next.Text = next; }
}
