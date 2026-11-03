"""Lyric context and route compatibility; fictional text and throwaway DB only."""
import json
import os
import sys
import time
import threading
import unittest
from concurrent.futures import wait
from unittest import mock
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cm_ncm
import cm_search_lyrics as lyrics
import cm_server
import test_password_reset as harness

TEXT = '[00:01.000]前一句\n[00:02.000]测试命中行\n[00:03.000]后一句\n[00:04.000]最后一句'

def song(ident=1, snippet='<b>测试</b>命中行'):
    return {'id': ident, 'name': 'Fixture', 'ar': [], 'lyrics': [snippet]}


class LyricSearchTests(unittest.TestCase):
    def setUp(self):
        with lyrics._lock:
            lyrics._cache.clear()
    def tearDown(self):
        with lyrics._lock:
            jobs = list(lyrics._pending.values())
        if jobs:
            wait(jobs, timeout=3)
    def upstream(self, path, params, **kwargs):
        if path == '/cloudsearch':
            self.assertEqual(params['type'],1006)
            return {'result':{'songs':[song()],'songCount':31}}
        self.assertEqual(path,'/lyric/new')
        self.assertEqual(kwargs['retries'],0)
        return {'lrc':{'lyric':TEXT}}
    def test_context_and_legacy_x_paging(self):
        with mock.patch.object(cm_ncm,'call',side_effect=self.upstream) as call:
            result=cm_ncm.search_types('测试',['lyric'],limit=1,offset=10)
            hit=result['songs'][0]
            self.assertEqual(hit['lyric'],'前一句 · 测试命中行 · 后一句')
            self.assertEqual(hit['lyricMatch'],'测试命中行')
            self.assertEqual([x['t'] for x in hit['lyricContext']],[1000,2000,3000])
            self.assertEqual([x['matched'] for x in hit['lyricContext']],[False,True,False])
            self.assertTrue(hit['lyricContextComplete'])
            self.assertEqual(result['totals'],{'song':31})
            self.assertTrue(result['hasMore']['song'])
            cm_ncm.search_types('测试',['lyric'],limit=1)
            self.assertEqual(sum(c.args[0]=='/lyric/new' for c in call.call_args_list),1)
    def test_boundaries_repeats_and_normalization(self):
        lines=[(1,'First & last'),(2,'测试，命中行！'),(3,'Other'),(4,'测试，命中行！')]
        self.assertEqual(len(lyrics.context(lines,'First &amp; last','irrelevant')),2)
        self.assertEqual(lyrics.context(lines,'测试命中行','测试')[1]['t'],2)
        self.assertEqual(lyrics.context(lines,'不存在','未知'),[])
        self.assertEqual(lyrics.snippet({'lyrics':['a','<em>hit</em>','unrelated']}),'hit')
        self.assertEqual(lyrics.snippet({'lyrics':{'txt':'A &amp; B'}}),'A & B')
    def test_timeout_failure_and_unmatched_keep_original(self):
        for value in [None, {'lrc':{'lyric':'[00:00]不匹配的正文'}}]:
            raw=[song()];normalized=[cm_ncm._norm_song(raw[0])]
            with lyrics._lock:lyrics._cache.clear()
            with mock.patch.object(cm_ncm,'call',return_value=value):lyrics.enrich(raw,normalized,'测试')
            self.assertEqual(normalized[0]['lyric'],'测试命中行')
            self.assertEqual(normalized[0]['lyricContext'],[])
            self.assertFalse(normalized[0]['lyricContextComplete'])
        release=threading.Event()
        def slow(*args,**kwargs):release.wait(timeout=2);return {'lrc':{'lyric':TEXT}}
        with lyrics._lock:lyrics._cache.clear()
        with mock.patch.object(cm_ncm,'call',side_effect=slow),mock.patch.object(lyrics,'PAGE_TIMEOUT',.005):
            try:
                out=lyrics.enrich([song()],[cm_ncm._norm_song(song())],'测试')
                self.assertFalse(out[0]['lyricContextComplete'])
                with lyrics._lock:jobs=list(lyrics._pending.values())
                self.assertTrue(jobs)
                self.assertFalse(any(j.done() for j in jobs))
            finally:release.set()
            wait(jobs)
            self.assertTrue(lyrics.enrich([song()],[cm_ncm._norm_song(song())],'测试')[0]['lyricContextComplete'])
    def test_deduplication_and_original_default_types(self):
        raw=[song(),song()]
        with mock.patch.object(cm_ncm,'call',return_value={'lrc':{'lyric':TEXT}}) as call:
            out=lyrics.enrich(raw,[cm_ncm._norm_song(s) for s in raw],'测试')
            self.assertEqual(call.call_count,1)
            self.assertEqual(len(out),2)
        self.assertNotIn('lyric',cm_ncm._SEARCH_ALL)
        with mock.patch.object(cm_ncm,'call',return_value={'result':{}}) as call:
            result=cm_ncm.search_types('ordinary')
            self.assertEqual({c.args[1]['type'] for c in call.call_args_list},{1,10,100,1000})
            self.assertEqual(set(result['totals']),{'song','album','artist','playlist'})
        with self.assertRaises(ValueError):cm_ncm.search_types('测试',['song','lyric'])


class LyricSearchRouteTests(unittest.TestCase):
    setUp=harness.TestPasswordReset.setUp
    _cleanup=harness.TestPasswordReset._cleanup
    call=harness.TestPasswordReset.call
    def test_explicit_type_offset_and_cache_isolation(self):
        data={'songs':[{'ncm_id':1,'lyric':'match','lyricContextComplete':False}], 'totals':{'song':2},'hasMore':{'song':True}}
        with mock.patch.object(cm_ncm,'search_types',return_value=data) as search, mock.patch.object(cm_ncm,'search_multi') as multi:
            status,result=self.call('GET','/ncm/search?keywords=test&type=lyric&offset=30&limit=10')
            self.assertEqual(status,200)
            search.assert_called_once_with('test',('lyric',),limit=10,offset=30)
            self.assertEqual(result['totals']['song'],2);multi.assert_not_called()
            self.call('GET','/ncm/search?keywords=test&type=lyric&offset=30&limit=10')
            self.assertEqual(search.call_count,1)
            self.assertEqual(self.call('GET','/ncm/search?keywords=test&type=lyric,song')[0],400)
            self.call('GET','/ncm/search?keywords=test&type=song&offset=30&limit=10')
            self.assertEqual(search.call_count,2)
            c=cm_server.cm_db.connect()
            try:
                cached=c.execute("SELECT * FROM cache WHERE k LIKE 'srch-lyric:v1:%'").fetchone()
                self.assertIsNotNone(cached)
            finally:c.close()
