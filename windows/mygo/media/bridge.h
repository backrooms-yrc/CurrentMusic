#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// All functions for a handle run on the OS thread that created it.
typedef struct cm_media cm_media;

enum cm_media_state {
    CM_EMPTY, CM_OPENING, CM_BUFFERING, CM_PLAYING, CM_PAUSED, CM_FAILED
};

enum cm_media_event {
    CM_OPENED = 1, CM_SEEKED = 2, CM_ENDED = 4
};

typedef struct cm_media_snapshot {
    uint64_t generation;
    int64_t position_ms;
    int64_t duration_ms;
    uint32_t state;
    uint32_t can_seek;
    uint32_t events;
    int32_t error;
} cm_media_snapshot;

__declspec(dllexport) int32_t cm_media_create(cm_media **out);
__declspec(dllexport) void cm_media_destroy(cm_media *engine);
__declspec(dllexport) int32_t cm_media_open(cm_media *engine, const wchar_t *url, uint64_t generation);
__declspec(dllexport) int32_t cm_media_play(cm_media *engine);
__declspec(dllexport) int32_t cm_media_pause(cm_media *engine);
__declspec(dllexport) int32_t cm_media_seek(cm_media *engine, int64_t position_ms);
__declspec(dllexport) int32_t cm_media_volume(cm_media *engine, uint32_t permille);
__declspec(dllexport) int32_t cm_media_close(cm_media *engine);
__declspec(dllexport) int32_t cm_media_poll(cm_media *engine, cm_media_snapshot *out);

#ifdef __cplusplus
}
#endif
