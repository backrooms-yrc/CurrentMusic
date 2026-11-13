#include "bridge.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Media.Core.h>
#include <winrt/Windows.Media.Devices.h>
#include <winrt/Windows.Media.Playback.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <memory>

using winrt::Windows::Foundation::Uri;
using winrt::Windows::Media::Core::MediaSource;
using winrt::Windows::Media::Devices::AudioDeviceRole;
using winrt::Windows::Media::Devices::MediaDevice;
using namespace winrt::Windows::Media::Playback;
using std::chrono::milliseconds;

static_assert(sizeof(cm_media_snapshot) == 40);

namespace {
struct Notifications {
    std::atomic<uint32_t> events{0};
    std::atomic<int32_t> error{0};
};

struct Track {
    uint64_t generation;
    bool opened = false;
    bool ended = false;
    MediaPlayer player;
    std::shared_ptr<Notifications> notifications = std::make_shared<Notifications>();
    MediaPlayer::MediaOpened_revoker opened_handler;
    MediaPlayer::MediaEnded_revoker ended_handler;
    MediaPlayer::MediaFailed_revoker failed_handler;
    MediaPlaybackSession::SeekCompleted_revoker seek_handler;
    MediaDevice::DefaultAudioRenderDeviceChanged_revoker output_handler;

    Track(const wchar_t *url, uint64_t id, double volume) : generation(id) {
        player.CommandManager().IsEnabled(false);
        player.AutoPlay(false);
        player.Volume(volume);
        opened_handler = player.MediaOpened(winrt::auto_revoke, [events = notifications](auto const&, auto const&) {
            events->events.fetch_or(CM_OPENED);
        });
        ended_handler = player.MediaEnded(winrt::auto_revoke, [events = notifications](auto const&, auto const&) {
            events->events.fetch_or(CM_ENDED);
        });
        failed_handler = player.MediaFailed(winrt::auto_revoke, [events = notifications](auto const&, MediaPlayerFailedEventArgs const& args) {
            auto error = args.ExtendedErrorCode().value;
            events->error.store(error < 0 ? error : E_FAIL);
        });
        seek_handler = player.PlaybackSession().SeekCompleted(winrt::auto_revoke, [events = notifications](auto const&, auto const&) {
            events->events.fetch_or(CM_SEEKED);
        });
        try {
            output_handler = MediaDevice::DefaultAudioRenderDeviceChanged(winrt::auto_revoke,
                [events = notifications](auto const&, auto const& args) {
                    if (args.Role() == AudioDeviceRole::Default) {
                        events->events.fetch_or(CM_OUTPUT_CHANGED);
                    }
                });
        } catch (...) {
            // An unavailable device watcher must not block playback.
        }
        player.Source(MediaSource::CreateFromUri(Uri{url}));
    }

    ~Track() {
        output_handler.revoke();
        seek_handler.revoke();
        failed_handler.revoke();
        ended_handler.revoke();
        opened_handler.revoke();
        try {
            player.Close();
        } catch (...) {
            // Destruction also releases the WinRT reference.
        }
    }
};

template<typename Action>
int32_t checked(Action action) noexcept {
    try {
        action();
        return S_OK;
    } catch (...) {
        return winrt::to_hresult().value;
    }
}
}

struct cm_media {
    std::unique_ptr<Track> track;
    double volume = 0.7;
};

int32_t cm_media_create(cm_media **out) {
    *out = nullptr;
    return checked([&] {
        auto engine = std::make_unique<cm_media>();
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        *out = engine.release();
    });
}

void cm_media_destroy(cm_media *engine) {
    delete engine;
    winrt::uninit_apartment();
}

int32_t cm_media_open(cm_media *engine, const wchar_t *url, uint64_t generation) {
    return checked([&] {
        engine->track.reset();
        engine->track = std::make_unique<Track>(url, generation, engine->volume);
    });
}

int32_t cm_media_play(cm_media *engine) {
    if (!engine->track) return E_ILLEGAL_METHOD_CALL;
    return checked([&] { engine->track->player.Play(); });
}

int32_t cm_media_pause(cm_media *engine) {
    if (!engine->track) return E_ILLEGAL_METHOD_CALL;
    return checked([&] { engine->track->player.Pause(); });
}

int32_t cm_media_seek(cm_media *engine, int64_t position_ms) {
    if (!engine->track) return E_ILLEGAL_METHOD_CALL;
    return checked([&] {
        auto session = engine->track->player.PlaybackSession();
        if (!session.CanSeek()) winrt::throw_hresult(E_ILLEGAL_METHOD_CALL);
        auto duration = std::max<int64_t>(0, std::chrono::duration_cast<milliseconds>(session.NaturalDuration()).count());
        session.Position(milliseconds{std::clamp<int64_t>(position_ms, 0, duration)});
        engine->track->ended = false;
    });
}

int32_t cm_media_volume(cm_media *engine, uint32_t permille) {
    return checked([&] {
        engine->volume = std::min(permille, 1000u) / 1000.0;
        if (engine->track) engine->track->player.Volume(engine->volume);
    });
}

int32_t cm_media_close(cm_media *engine) {
    engine->track.reset();
    return S_OK;
}

int32_t cm_media_poll(cm_media *engine, cm_media_snapshot *out) {
    *out = {};
    if (!engine->track) return S_OK;
    return checked([&] {
        auto& track = *engine->track;
        out->generation = track.generation;
        out->events = track.notifications->events.exchange(0);
        out->error = track.notifications->error.load();
        track.opened = track.opened || (out->events & CM_OPENED) != 0;
        track.ended = track.ended || (out->events & CM_ENDED) != 0;
        if (out->error) {
            out->state = CM_FAILED;
            return;
        }
        auto session = track.player.PlaybackSession();
        out->position_ms = std::chrono::duration_cast<milliseconds>(session.Position()).count();
        out->duration_ms = std::chrono::duration_cast<milliseconds>(session.NaturalDuration()).count();
        out->can_seek = track.opened && session.CanSeek();
        switch (session.PlaybackState()) {
        case MediaPlaybackState::Buffering: out->state = CM_BUFFERING; break;
        case MediaPlaybackState::Playing: out->state = track.ended ? CM_PAUSED : CM_PLAYING; break;
        default: out->state = track.opened ? CM_PAUSED : CM_OPENING; break;
        }
    });
}
