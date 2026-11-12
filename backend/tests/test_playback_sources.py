"""Client IP isolation and verified grey-track fallback; never uses production data."""
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cm_db
import cm_ncm
import cm_server
import test_password_reset as harness

IP_A, IP_B = '198.51.100.21', '198.51.100.22'
MATCHED = {'url': 'https://audio.example.test/song.mp3', 'level': 'matched', 'source': 'netease-match',
           'type': 'mp3', 'br': 0, 'size': 200000, 'sr': 0, 'bits': 0, 'ch': 0}
VERIFIED = {'url': MATCHED['url'], 'validated': True, 'validationVersion': 1, 'type': 'mp3', 'size': 200000,
            'durationMs': 299000, 'expectedDurationMs': 299000, 'source': 'fixture'}


class PlaybackSourceTests(unittest.TestCase):
    setUp = harness.TestPasswordReset.setUp
    _cleanup = harness.TestPasswordReset._cleanup
    call = harness.TestPasswordReset.call

    def token(self):
        return cm_db.issue_token(cm_db.create_user('audio-fixture', 'fixture-password', 'Fixture'))

    def test_official_song_url_keeps_user_realip(self):
        response = {'data': [{'url': 'https://audio.example.test/song.flac', 'level': 'lossless'}]}
        with mock.patch.object(cm_ncm, '_bounded_call', return_value=response) as upstream:
            cm_ncm.song_url(1, real_ip=IP_A, probe=False)
        self.assertEqual(upstream.call_args.args[1]['realIP'], IP_A)

    def test_official_preview_cannot_win_quality_selection_or_skip_fallback(self):
        response = {'data': [{'url': 'https://audio.example.test/preview.mp3',
                             'level': 'standard', 'freeTrialInfo': {'start': 0, 'end': 60}}]}
        with mock.patch.object(cm_ncm, '_bounded_call', return_value=response), \
             mock.patch.object(cm_ncm, 'probe_audio') as probe:
            for checked in (True, False):
                with self.assertRaisesRegex(cm_ncm.NcmError, '试听'):
                    cm_ncm.song_url(1, real_ip=IP_A, probe=checked)
            probe.assert_not_called()
            with mock.patch.object(cm_ncm, 'song_url_match', return_value=MATCHED) as match:
                out = cm_server.resolve_play_url(1, real_ip=IP_A)
                self.assertEqual(out['level'], 'matched')
                match.assert_called_once_with(1, real_ip=IP_A)

    def test_auto_dolby_is_preferred_only_for_capable_clients_with_no_cap(self):
        token = self.token()
        requested = []

        def upstream(path, q, *args, **kwargs):
            level = q['level']
            requested.append(level)
            return {'data': [{'url': f'https://audio.example.test/{level}',
                              'level': level, 'br': 5_085_163 if level == 'jymaster' else 768_000}]}

        with mock.patch.object(cm_ncm, '_bounded_call', side_effect=upstream), \
             mock.patch.object(cm_ncm, 'probe_audio', return_value=(True, {})):
            route = '/ncm/song/url?id=1'
            self.assertEqual(self.call('GET', route, token=token)[1]['level'], 'jymaster')
            self.assertNotIn('dolby', requested)
            self.assertEqual(self.call('GET', route + '&supportsDolby=1', token=token)[1]['level'], 'dolby')
            requested.clear()
            self.assertEqual(self.call('GET', route, token=token)[1]['level'], 'jymaster')
            self.assertEqual(self.call('GET', route + '&supportsDolby=1&maxBr=907568',
                                       token=token)[1]['level'], 'lossless')
            self.assertEqual(self.call('GET', route + '&supportsDolby=1&level=jymaster',
                                       token=token)[1]['level'], 'jymaster')
            self.assertNotIn('dolby', requested)

    def test_auto_dolby_falls_back_on_downgrade_missing_level_or_failed_probe(self):
        def upstream(path, q, *args, **kwargs):
            level = q['level']
            actual = dolby_level if level == 'dolby' else level
            return {'data': [{'url': f'https://audio.example.test/{level}', 'level': actual,
                              'br': 5_085_163 if level == 'jymaster' else 768_000}]}

        def probe(url, **kwargs):
            return not (url.endswith('/dolby') and reject_probe), {}

        with mock.patch.object(cm_ncm, '_bounded_call', side_effect=upstream), \
             mock.patch.object(cm_ncm, 'probe_audio', side_effect=probe), \
             mock.patch.object(cm_ncm, 'song_url_match') as match:
            for sid, (dolby_level, reject_probe) in enumerate(
                    [('jyeffect', False), (None, False), ('dolby', True)], start=1):
                with self.subTest(dolby_level=dolby_level, reject_probe=reject_probe):
                    out = cm_server.resolve_play_url(sid, real_ip=IP_A, supports_dolby=True)
                    self.assertEqual(out['level'], 'jymaster')
            dolby_level, reject_probe = 'dolby', False
            self.assertEqual(cm_server.resolve_play_url(4, real_ip=IP_A, supports_dolby=True)['level'], 'dolby')
            dolby_level = 'jyeffect'
            self.assertEqual(cm_server.resolve_play_url(4, real_ip=IP_A, supports_dolby=True,
                                                        refresh=True)['level'], 'jymaster')
            self.assertEqual(cm_server.resolve_play_url(4, real_ip=IP_A, supports_dolby=True)['level'], 'jymaster')
            match.assert_not_called()

    def test_match_forwards_realip_without_cookie_and_reports_verified_quality(self):
        with mock.patch.dict('os.environ', {'CM_NCM_MATCH_SOURCE': 'fixture'}), \
             mock.patch.object(cm_ncm, '_ts', return_value=123), \
             mock.patch.object(cm_ncm, '_bounded_call', return_value={'data': MATCHED['url'], 'matchInfo': VERIFIED}) as upstream, \
             mock.patch.object(cm_ncm, 'probe_audio', return_value=(True, {'type': 'mp3', 'size': 200000})) as probe:
            result = cm_ncm.song_url_match(1, real_ip=IP_A)
        self.assertEqual(result, {**MATCHED, 'md5': '', 'durationMs': 299000, 'expectedDurationMs': 299000, 'matchSource': 'fixture'})
        self.assertEqual(upstream.call_args.args[:2], ('/song/url/match', {'id': 1, 'source': 'fixture', 'timestamp': 123}))
        self.assertEqual(upstream.call_args.kwargs['real_ip'], IP_A)
        self.assertFalse(upstream.call_args.kwargs['with_cookie'])
        probe.assert_called_once_with(MATCHED['url'], timeout=2.5, strict=True)

    def test_match_rejects_missing_addresses_and_html(self):
        with mock.patch.object(cm_ncm, '_bounded_call') as upstream, \
             mock.patch.object(cm_ncm, 'probe_audio', return_value=(False, {})):
            for response in ({'data': []}, {'data': 'file:///etc/passwd'}, {'data': 'https://audio.example.test/error.html'}):
                upstream.return_value = response
                with self.subTest(response=response), self.assertRaises(cm_ncm.NcmError):
                    cm_ncm.song_url_match(1, real_ip=IP_A)

    def test_match_rejects_unverified_and_short_audio_before_caching(self):
        with mock.patch.object(cm_ncm, '_bounded_call') as upstream, mock.patch.object(cm_ncm, 'probe_audio') as probe:
            for info in ({}, 'invalid', {**VERIFIED, 'durationMs': float('nan')}, {**VERIFIED, 'durationMs': -1, 'expectedDurationMs': 1}, {**VERIFIED, 'durationMs': 2610}, {**VERIFIED, 'validated': False}, {**VERIFIED, 'url': 'https://other.example.test/music.mp3'}):
                upstream.return_value = {'data': MATCHED['url'], 'matchInfo': info}
                with self.subTest(info=info), self.assertRaisesRegex(cm_ncm.NcmError, '时长校验'):
                    cm_ncm.song_url_match(1, real_ip=IP_A)
            probe.assert_not_called()

    def test_strict_probe_rejects_errors_and_timeouts_and_reads_real_file_headers(self):
        def response(body):
            stream = io.BytesIO(body)
            stream.status = 206
            stream.headers = {'Content-Range': 'bytes 0-2047/200000'}
            return stream
        with mock.patch.object(cm_ncm.urllib.request, 'urlopen', return_value=response(b'<!DOCTYPE html>' * 150)):
            self.assertFalse(cm_ncm._probe_audio_once(MATCHED['url'], 1, strict=True)[0])
        with mock.patch.object(cm_ncm.urllib.request, 'urlopen', return_value=response(b'ID3' + b'\0' * 2045)):
            self.assertEqual(cm_ncm._probe_audio_once(MATCHED['url'], 1, strict=True), (True, {'type': 'mp3', 'size': 200000}))
        with mock.patch.object(cm_ncm.urllib.request, 'urlopen', side_effect=TimeoutError):
            self.assertFalse(cm_ncm._probe_audio_once(MATCHED['url'], 1, strict=True)[0])
            self.assertTrue(cm_ncm._probe_audio_once(MATCHED['url'], 1)[0])
        with mock.patch.object(cm_ncm, '_run_with_wall_clock', return_value=None):
            self.assertEqual(cm_ncm.probe_audio(MATCHED['url'], strict=True), (False, {}))

    def test_route_uses_trusted_ip_for_fallback_and_isolates_cache_and_refresh(self):
        token = self.token()
        with mock.patch.object(cm_server, '_resolve_official_play_url', side_effect=cm_ncm.NcmError('no official URL')), \
             mock.patch.object(cm_ncm, 'song_url_match', return_value=MATCHED) as match:
            route = '/ncm/song/url?id=1&realIP=203.0.113.99'
            status, first = self.call('GET', route, token=token, ip=IP_A)
            self.assertEqual(status, 200)
            self.assertFalse(first['fromCache'])
            self.assertEqual(first['level'], 'matched')
            self.assertEqual(first['hosts'], [])
            self.assertEqual(self.call('GET', route, token=token, ip=IP_A)[1]['fromCache'], True)
            self.call('GET', route, token=token, ip=IP_B)
            self.call('GET', route + '&refresh=1', token=token, ip=IP_A)
            self.assertEqual([c.kwargs['real_ip'] for c in match.call_args_list], [IP_A, IP_B, IP_A])

    def test_official_success_never_calls_match(self):
        with mock.patch.object(cm_server, '_resolve_official_play_url', return_value={'url': 'official'}) as official, \
             mock.patch.object(cm_ncm, 'song_url_match') as match:
            self.assertEqual(cm_server.resolve_play_url(1, real_ip=IP_A), {'url': 'official'})
            official.assert_called_once()
            match.assert_not_called()

    def test_match_failure_is_retryable_and_not_cached(self):
        token = self.token()
        with mock.patch.object(cm_server, '_resolve_official_play_url', side_effect=cm_ncm.NcmError('no URL')), \
             mock.patch.object(cm_ncm, 'song_url_match', side_effect=cm_ncm.NcmError('temporary')) as match:
            for _ in range(2):
                status, out = self.call('GET', '/ncm/song/url?id=1', token=token, ip=IP_A)
                self.assertEqual(status, 502)
                self.assertEqual(out['code'], 'playback_match_failed')
                self.assertIn('请稍后重试', out['error'])
            self.assertEqual(match.call_count, 2)

    def test_match_failure_logs_only_known_codes_from_upstream(self):
        private_value = 'https://audio.example.test/private?token=fixture'
        body = {'msg': private_value, 'reason': 'no_verified_source', 'attempts': [
            {'source': private_value, 'reason': 'duration_mismatch'},
            {'reason': private_value}, {'reason': ['malformed']},
        ]}
        upstream = cm_ncm.urllib.error.HTTPError('http://localhost/match', 502, 'Bad Gateway', {},
                                                 io.BytesIO(json.dumps(body).encode()))
        with mock.patch.object(cm_server, '_resolve_official_play_url', side_effect=cm_ncm.NcmError('no URL')), \
             mock.patch.object(cm_ncm.urllib.request, 'urlopen', side_effect=upstream), \
             self.assertLogs(cm_server.log, level='WARNING') as logs:
            with self.assertRaisesRegex(cm_ncm.NcmError, '请稍后重试') as error:
                cm_server.resolve_play_url(1, 'jymaster', real_ip=IP_A)
        self.assertIn('song=1 level=jymaster', logs.output[0])
        self.assertIn('reason=no_verified_source attempts=duration_mismatch', logs.output[0])
        self.assertNotIn(IP_A, logs.output[0])
        self.assertNotIn(private_value, logs.output[0])
        self.assertNotIn(private_value, str(error.exception))

    def test_best_level_cache_is_scoped_to_client_ip(self):
        result = {'url': 'https://audio.example.test/song.flac', 'level': 'lossless', 'type': 'flac', 'br': 900000}
        with mock.patch.object(cm_ncm, 'song_url', return_value=result) as upstream, \
             mock.patch.object(cm_ncm, 'probe_audio', return_value=(True, {})):
            self.assertIsNotNone(cm_server.best_level(1, real_ip=IP_A)[1])
            self.assertIsNone(cm_server.best_level(1, real_ip=IP_A)[1])
            self.assertIsNotNone(cm_server.best_level(1, real_ip=IP_B)[1])
            self.assertEqual(upstream.call_count, 8)
            self.assertEqual({c.kwargs['real_ip'] for c in upstream.call_args_list}, {IP_A, IP_B})

    def test_generic_media_cache_also_keeps_trusted_user_ip(self):
        token = self.token()
        with mock.patch.object(cm_ncm, 'call', return_value={'code': 200, 'data': []}) as upstream:
            for ip in (IP_A, IP_A, IP_B):
                self.assertEqual(self.call('GET', '/ncm/song/url/v1?id=1&level=exhigh&realIP=203.0.113.99', token=token, ip=ip)[0], 200)
            self.assertEqual([c.args[1]['realIP'] for c in upstream.call_args_list], [IP_A, IP_B])

    def test_guest_cannot_trigger_fallback(self):
        with mock.patch.object(cm_ncm, 'song_url_match') as match:
            self.assertEqual(self.call('GET', '/ncm/song/url?id=1')[0], 401)
            match.assert_not_called()
