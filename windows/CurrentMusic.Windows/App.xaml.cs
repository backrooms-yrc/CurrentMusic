using Microsoft.UI.Xaml;
using System.Text.Json;
using Microsoft.Windows.AppLifecycle;

namespace CurrentMusic.Windows;

public partial class App : Application
{
    private MainWindow? _window;
    private AppInstance? _instance;
    public static List<string> XamlDiagnostics { get; } = [];
    public static string? SmokeReport { get; } = Environment.GetCommandLineArgs().FirstOrDefault(x => x.StartsWith("--smoke-test="))?[13..];
    public App()
    {
        UnhandledException += (_, e) =>
        {
            try
            {
                var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CurrentMusic", "Windows", "logs");
                Directory.CreateDirectory(folder);
                // Exception messages may contain external data: retain only type and stack.
                File.WriteAllText(Path.Combine(folder, "last-crash.txt"), $"{DateTimeOffset.UtcNow:O}\n{e.Exception.GetType().FullName} 0x{e.Exception.HResult:X8}\n{e.Exception.StackTrace}");
                if (SmokeReport is not null)
                    File.WriteAllText(SmokeReport, JsonSerializer.Serialize(new { success = false, stage = "unhandled", error = e.Exception.GetType().FullName, detail = e.Exception.Message, hresult = e.Exception.HResult.ToString("X8"), stack = e.Exception.StackTrace }));
            }
            catch (IOException) { } catch (UnauthorizedAccessException) { }
        };
        InitializeComponent();
    }
    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        if (SmokeReport is not null)
        {
            DebugSettings.IsXamlResourceReferenceTracingEnabled = true;
            DebugSettings.XamlResourceReferenceFailed += (_, e) => XamlDiagnostics.Add(e.Message);
        }
        if (SmokeReport is null)
        {
            var instance = _instance = AppInstance.FindOrRegisterForKey("CurrentMusic.Windows");
            if (!instance.IsCurrent)
            {
                await instance.RedirectActivationToAsync(AppInstance.GetCurrent().GetActivatedEventArgs());
                Environment.Exit(0); return;
            }
            instance.Activated += (_, _) => _window?.DispatcherQueue.TryEnqueue(() => { _window.AppWindow.Show(); _window.Activate(); });
        }
        try { _window = new MainWindow(); _window.Activate(); }
        catch (Exception error) when (SmokeReport is not null)
        {
            File.WriteAllText(SmokeReport, JsonSerializer.Serialize(new { success = false, stage = "startup", error = error.GetType().FullName, detail = error.Message, hresult = error.HResult.ToString("X8"), stack = error.StackTrace, description = error.Data["Description"]?.ToString(), restricted = error.Data["RestrictedDescription"]?.ToString(), inner = error.InnerException?.ToString(), resources = XamlDiagnostics }));
            Environment.Exit(1);
        }
    }
}
