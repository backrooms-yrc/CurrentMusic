// Optional Windows acceptance probe. This executable is separate from the media DLL.
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Media.Control.h>

#include <iostream>
#include <string_view>

using namespace winrt::Windows::Media::Control;

int wmain(int argc, wchar_t **argv) {
    if (argc != 3) return 2;
    try {
        winrt::init_apartment();
        auto manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().get();
        GlobalSystemMediaTransportControlsSession found{nullptr};
        auto sessions = manager.GetSessions();
        unsigned count = 0;
        for (auto const& session : sessions) {
            try {
                if (auto properties = session.TryGetMediaPropertiesAsync().get(); properties && properties.Title() == argv[1]) {
                    found = session;
                    ++count;
                }
            } catch (winrt::hresult_error const&) {
                // A session owned by another app may close while enumerating.
            }
        }
        auto action = std::wstring_view(argv[2]);
        std::wcout << L"Matching Windows media sessions: " << count << L'\n';
        if (action == L"absent") return count == 0 ? 0 : 3;
        if (count != 1) return 3;
        auto app = found.SourceAppUserModelId();
        if (app.empty()) return 3;
        unsigned appCount = 0;
        for (auto const& session : sessions) {
            if (session.SourceAppUserModelId() == app) ++appCount;
        }
        std::wcout << L"Sessions for this application: " << appCount << L'\n';
        if (appCount != 1) return 3;
        if (action == L"pause") return found.TryPauseAsync().get() ? 0 : 4;
        if (action == L"play") return found.TryPlayAsync().get() ? 0 : 4;
        if (action == L"count") return 0;
        return 2;
    } catch (winrt::hresult_error const& error) {
        std::wcerr << error.message().c_str() << L'\n';
        return 5;
    }
}
