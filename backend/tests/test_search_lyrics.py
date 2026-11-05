"""Lyric search must resolve retryable failures before returning a context preview."""
import io
import json
import os
import sys
import tempfile
import threading
import urllib.error
import unittest
from concurrent.futures import wait
from unittest import mock
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cm_db
import cm_ncm
import cm_search_lyrics as lyrics
import test_password_reset as harness

TEXT = '[00:01.000]前一句\n[00:02.000]测试命中行\n[00:03.000]后一句\n[00:04.000]最后一句'

def song(ident=1, snippet='<b>测试</b>命中行'):
    return {'id': ident, 'name': 'Fixture', 'ar': [], 'lyrics': [snippet]}

def document(text=TEXT):
    return {'code':200,'lrc':{'lyric':text}}


class LyricSearchTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.previous_db=cm_db.DB_PATH
        cm_db.DB_PATH=os.path.join(self.tmp.name,'test.db')
        cm_db.init()
        with lyrics._lock:
            lyrics._cache.clear()
    def tearDown(self):
        with lyrics._lock:
            jobs=list(lyrics._pending.values())
        if jobs:wait(jobs,timeout=4)
        cm_db.DB_PATH=self.previous_db
        self.tmp.cleanup()
    def enrich(self, raw=None):
        raw=raw or [song()]
        return lyrics.enrich(raw,[cm_ncm._norm_song(s) for s in raw],'测试')
    def upstream(self,path,params,**kwargs):
        if path=='/cloudsearch':
            self.assertEqual(params['type'],1006)
            return {'result':{'songs':[song()],'songCount':31}}
        self.assertEqual(path,'/lyric/new');self.assertEqual(kwargs['retries'],1)
        return document()
    def test_context_and_legacy_x_paging(self):
        with mock.patch.object(cm_ncm,'call',side_effect=self.upstream) as call:
            result=cm_ncm.search_types('测试',['lyric'],limit=1,offset=10)
            hit=result['songs'][0]
            self.assertEqual(hit['lyric'],'前一句 · 测试命中行 · 后一句')
            self.assertEqual(hit['lyricMatch'],'测试命中行')
            self.assertEqual([x['t'] for x in hit['lyricContext']],[1000,2000,3000])
            self.assertEqual([x['matched'] for x in hit['lyricContext']],[False,True,False])
            self.assertTrue(hit['lyricContextComplete'])
            self.assertEqual(hit['lyricContextStatus'],'complete')
            self.assertEqual(result['totals'],{'song':31});self.assertTrue(result['hasMore']['song'])
            cm_ncm.search_types('测试',['lyric'],limit=1)
            self.assertEqual(sum(c.args[0]=='/lyric/new' for c in call.call_args_list),1)
    def test_primary_network_retry_in_same_request(self):
        response=io.BytesIO(json.dumps(document(),ensure_ascii=False).encode())
        with mock.patch.object(cm_ncm,'ncm_cookie',return_value=''),mock.patch.object(cm_ncm.urllib.request,'urlopen',side_effect=[urllib.error.URLError('temporary'),response]) as call:
            self.assertTrue(self.enrich()[0]['lyricContextComplete'])
            self.assertEqual(call.call_count,2)
    def test_classic_fallback_after_error_or_unmatched(self):
        for mode in ['error','unmatched']:
            with lyrics._lock:lyrics._cache.clear()
            def fetch(path,params,**kwargs):
                if path=='/lyric/new':
                    if mode=='error':raise cm_ncm.NcmError('temporary')
                    return document('[00:00]另一版本的正文')
                self.assertEqual(path,'/lyric');return document()
            with mock.patch.object(cm_ncm,'call',side_effect=fetch):
                hit=self.enrich()[0]
                self.assertTrue(hit['lyricContextComplete'])
                self.assertIn('classic',hit['lyricContextSource'])
    def test_timeout_after_old_cutoff_still_completes_first_response(self):
        release=threading.Event()
        timer=threading.Timer(2.65,release.set);timer.start()
        def slow(*args,**kwargs):release.wait(timeout=4);return document()
        try:
            with mock.patch.object(cm_ncm,'call',side_effect=slow),mock.patch.object(lyrics,'PAGE_TIMEOUT',5):
                self.assertTrue(self.enrich()[0]['lyricContextComplete'])
        finally:release.set();timer.cancel()
    def test_ready_normalized_cache_avoids_network(self):
        lines=[{'t':1000,'txt':'前一句'},{'t':2000,'txt':'测试命中行'},{'t':3000,'txt':'后一句'}]
        cm_db.cache_set('lyric:v16:1',json.dumps({'lines':lines}),600)
        with mock.patch.object(cm_ncm,'call') as call:
            hit=self.enrich()[0];self.assertTrue(hit['lyricContextComplete']);call.assert_not_called()
            self.assertEqual(hit['lyricContextSource'],'currentmusic:cache')
    def test_lrc_does_not_hide_complete_yrc(self):
        data=document('[00:00]测试命中行');data['yrc']={'lyric':TEXT}
        with mock.patch.object(cm_ncm,'call',return_value=data) as call:
            hit=self.enrich()[0];self.assertTrue(hit['lyricContextComplete'])
            self.assertTrue(hit['lyricContextSource'].endswith(':yrc'));self.assertEqual(call.call_count,1)
    def test_cross_line_excerpts_plain_text_and_boundaries(self):
        lines=[(1,'前一句'),(2,'测试'),(3,'命中行'),(4,'后一句')]
        found=lyrics.context(lines,'测试 命中行','测试命中行')
        self.assertEqual([x['txt'] for x in found if x['matched']],['测试','命中行'])
        self.assertEqual(len(found),4)
        self.assertEqual(len(lyrics.context(lines,'前一句','前一句')),2)
        self.assertEqual(lyrics.context(lines,'不存在','未知'),[])
        self.assertEqual(lyrics.clean('&lt;b&gt;A &amp; B&lt;/b&gt;'),'A & B')
        with mock.patch.object(cm_ncm,'call',return_value=document('前一句\n测试命中行\n后一句')):
            hit=self.enrich()[0];self.assertTrue(hit['lyricContextComplete'])
            self.assertEqual([x['t'] for x in hit['lyricContext']],[None,None,None])
    def test_simplified_search_matches_traditional_lyrics_without_rewriting_display(self):
        lines=[(1,'前一句'),(2,'人類不會飛翔'),(3,'後一句')]
        found=lyrics.context(lines,'人类不会飞翔','人类不会飞翔')
        self.assertEqual(len(found),3)
        self.assertEqual(found[1]['txt'],'人類不會飛翔')
        self.assertTrue(found[1]['matched'])
    def test_missing_and_error_are_distinct_and_never_show_snippet_as_context(self):
        with mock.patch.object(cm_ncm,'call',return_value={'code':200,'nolyric':True}):
            hit=self.enrich()[0];self.assertEqual(hit['lyricContextStatus'],'missing')
            self.assertFalse(hit['lyricContextRetryable']);self.assertNotEqual(hit['lyric'],hit['lyricMatch'])
        with lyrics._lock:lyrics._cache.clear()
        with mock.patch.object(cm_ncm,'call',side_effect=cm_ncm.NcmError('temporary')):
            hit=self.enrich()[0];self.assertEqual(hit['lyricContextStatus'],'error')
            self.assertTrue(hit['lyricContextRetryable']);self.assertIn('重试',hit['lyric'])
        # Unlike the old 30-second failure cache, the next request can recover immediately.
        with mock.patch.object(cm_ncm,'call',return_value=document()):
            self.assertTrue(self.enrich()[0]['lyricContextComplete'])
    def test_empty_success_response_is_retryable_not_proof_of_absence(self):
        with mock.patch.object(cm_ncm,'call',return_value={'code':200}):
            hit=self.enrich()[0];self.assertEqual(hit['lyricContextStatus'],'error')
            self.assertTrue(hit['lyricContextRetryable'])
        with mock.patch.object(cm_ncm,'call',return_value=document()):
            self.assertTrue(self.enrich()[0]['lyricContextComplete'])
    def test_deadline_is_explicit_pending_and_warmed_result_is_reused(self):
        release=threading.Event()
        def blocked(*args,**kwargs):release.wait(timeout=2);return document()
        with mock.patch.object(cm_ncm,'call',side_effect=blocked):
            with mock.patch.object(lyrics,'PAGE_TIMEOUT',.05):
                try:
                    hit=self.enrich()[0]
                    self.assertEqual(hit['lyricContextStatus'],'pending');self.assertTrue(hit['lyricContextRetryable'])
                    self.assertNotEqual(hit['lyric'],hit['lyricMatch'])
                    with lyrics._lock:jobs=list(lyrics._pending.values())
                finally:release.set()
            wait(jobs)
            # The retry uses its normal budget; a 5 ms deadline also times SQLite/scheduling.
            self.assertTrue(self.enrich()[0]['lyricContextComplete'])
    def test_one_slow_song_does_not_block_another_songs_fallback(self):
        release=threading.Event()
        def fetch(path,params,**kwargs):
            if params['id']==2:release.wait(timeout=2)
            if path=='/lyric/new' and params['id']==1:raise cm_ncm.NcmError('temporary')
            return document()
        with mock.patch.object(cm_ncm,'call',side_effect=fetch),mock.patch.object(lyrics,'PAGE_TIMEOUT',.1):
            try:
                hits=self.enrich([song(1),song(2)])
                self.assertTrue(hits[0]['lyricContextComplete'])
                self.assertEqual(hits[1]['lyricContextStatus'],'pending')
                with lyrics._lock:jobs=list(lyrics._pending.values())
            finally:release.set()
            wait(jobs)
    def test_queue_capacity_is_rolled_instead_of_dropping_later_results(self):
        with mock.patch.object(lyrics,'MAX_PENDING',1),mock.patch.object(cm_ncm,'call',return_value=document()):
            hits=self.enrich([song(i) for i in range(1,7)])
            self.assertTrue(all(s['lyricContextComplete'] for s in hits))
    def test_deduplication_and_original_default_types(self):
        with mock.patch.object(cm_ncm,'call',return_value=document()) as call:
            self.assertEqual(len(self.enrich([song(),song()])),2);self.assertEqual(call.call_count,1)
        with mock.patch.object(cm_ncm,'call',return_value={'result':{}}) as call:
            result=cm_ncm.search_types('ordinary')
            self.assertEqual({c.args[1]['type'] for c in call.call_args_list},{1,10,100,1000})
            self.assertEqual(set(result['totals']),{'song','album','artist','playlist'})
        with self.assertRaises(ValueError):cm_ncm.search_types('测试',['song','lyric'])


class LyricSearchRouteTests(unittest.TestCase):
    setUp=harness.TestPasswordReset.setUp
    _cleanup=harness.TestPasswordReset._cleanup
    call=harness.TestPasswordReset.call
    def test_partial_response_not_cached_and_complete_response_cached(self):
        partial={'songs':[{'ncm_id':1,'lyricContextComplete':False}],'totals':{'song':2},'hasMore':{'song':True}}
        with mock.patch.object(cm_ncm,'search_types',return_value=partial) as search,mock.patch.object(cm_ncm,'search_multi') as multi:
            url='/ncm/search?keywords=test&type=lyric&offset=30&limit=10'
            status,result=self.call('GET',url);self.assertEqual(status,200)
            search.assert_called_once_with('test',('lyric',),limit=10,offset=30,real_ip='10.0.0.1');multi.assert_not_called()
            self.call('GET',url);self.assertEqual(search.call_count,2)
            self.assertEqual(self.call('GET','/ncm/search?keywords=test&type=lyric,song')[0],400)
            search.return_value={'songs':[{'ncm_id':1,'lyricContextComplete':True}],'totals':{'song':2},'hasMore':{'song':True}}
            self.call('GET',url);self.call('GET',url);self.assertEqual(search.call_count,3)
            self.call('GET','/ncm/search?keywords=test&type=song&offset=30&limit=10');self.assertEqual(search.call_count,4)
