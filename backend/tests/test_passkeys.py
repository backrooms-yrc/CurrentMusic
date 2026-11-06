import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import hashlib
import json
import struct
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch
import cbor2
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
import cm_db
import cm_2fa
import cm_passkeys as pk

ANDROID_RP = 'music.20110208.xyz'
ANDROID_ORIGIN = 'android:apk-key-hash:_D5jB5uOaa6nq3NIKEbaCTnWzRLa8K__qpouk_v8zzU'
ANDROID_ORIGINS = {ANDROID_ORIGIN: ANDROID_RP}


class PasskeyTests(unittest.TestCase):
    def test_self_hosted_origins_are_explicit_and_fail_closed(self):
        configured = pk.configured_origins('https://music.example.com, https://other.example.com:8443')
        with patch.object(pk, 'ORIGINS', configured):
            self.assertEqual(pk.origin_check('https://music.example.com'), 'music.example.com')
            with self.assertRaises(pk.Error):
                pk.origin_check('https://attacker.example.com')
        for invalid in ('', 'http://music.example.com', 'https://*.example.com',
                        'https://user:password@example.com', 'https://example.com/path',
                        'https://example.com?query=1', 'https://example.com:99999',
                        'https://example.com invalid'):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                pk.configured_origins(invalid)

    def test_android_configuration_requires_canonical_hash_and_allowed_dns_name(self):
        with patch.dict(os.environ, CM_PASSKEY_ANDROID_ORIGINS=json.dumps(ANDROID_ORIGINS)):
            self.assertEqual(pk.configured_android_origins(pk.DEFAULT_ORIGINS), ANDROID_ORIGINS)
        self.assertEqual(pk.configured_android_origins(pk.DEFAULT_ORIGINS, '{}'), {})
        for invalid in ('', '[]', 'null', 'bad JSON'):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                pk.configured_android_origins(pk.DEFAULT_ORIGINS, invalid)
        for origin, rp in (
            ('android:anything', ANDROID_RP), (ANDROID_ORIGIN + '=', ANDROID_RP),
            (ANDROID_ORIGIN[:-1] + 'V', ANDROID_RP), (ANDROID_ORIGIN[:-1], ANDROID_RP),
            (ANDROID_ORIGIN, 'https://' + ANDROID_RP), (ANDROID_ORIGIN, ANDROID_RP + ':443'),
            (ANDROID_ORIGIN, '*.20110208.xyz'), (ANDROID_ORIGIN, 'other.example.com'),
            (ANDROID_ORIGIN, '127.0.0.1'), (ANDROID_ORIGIN, 'bad_name.example.com'),
            (ANDROID_ORIGIN, None),
        ):
            with self.subTest(origin=origin, rp=rp), self.assertRaises(ValueError):
                pk.configured_android_origins(pk.DEFAULT_ORIGINS | {'https://127.0.0.1', 'https://bad_name.example.com'},
                                              json.dumps({origin: rp}))

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = patch.object(cm_db, 'DB_PATH', os.path.join(tmp.name, 'passkeys.db'))
        db_path.start()
        self.addCleanup(db_path.stop)
        cm_db.init()
        self.uid=cm_db.create_user('pk_'+pk.secrets.token_hex(6),'password','Test')
        self.sid=cm_db.issue_token(self.uid)
        self.origin='https://music.ctcehs.com'
        self.private=ec.generate_private_key(ec.SECP256R1())
        self.cid=pk.secrets.token_bytes(32)
    def client(self,options,kind,origin=None,challenge=None):
        return json.dumps({'type':kind,'challenge':challenge or options['publicKey']['challenge'],'origin':origin or self.origin,'crossOrigin':False}).encode()
    def register(self):
        start=pk.begin(self.origin,self.uid,self.sid,'password')
        pub=self.private.public_key().public_numbers()
        cose=cbor2.dumps({1:2,3:-7,-1:1,-2:pub.x.to_bytes(32,'big'),-3:pub.y.to_bytes(32,'big')})
        rp = start['publicKey']['rp']['id']
        data=hashlib.sha256(rp.encode()).digest()+bytes([0x45])+struct.pack('>I',0)+bytes(16)+struct.pack('>H',len(self.cid))+self.cid+cose
        credential={'id':pk.b64(self.cid),'rawId':pk.b64(self.cid),'type':'public-key','response':{'clientDataJSON':pk.b64(self.client(start,'webauthn.create')),'attestationObject':pk.b64(cbor2.dumps({'fmt':'none','attStmt':{},'authData':data}))}}
        pk.finish(self.origin,start['challengeToken'],credential,self.uid,self.sid)
        return start,credential
    def assertion(self,start,uv=True,origin=None,rp=None,challenge=None,counter=1):
        client=self.client(start,'webauthn.get',origin,challenge)
        rp = rp or start['publicKey']['rpId']
        data=hashlib.sha256(rp.encode()).digest()+bytes([5 if uv else 1])+struct.pack('>I',counter)
        signature=self.private.sign(data+hashlib.sha256(client).digest(),ec.ECDSA(hashes.SHA256()))
        c=pk.connect();handle=c.execute('SELECT handle FROM passkey_users WHERE uid=?',(self.uid,)).fetchone()[0];c.close()
        return {'id':pk.b64(self.cid),'rawId':pk.b64(self.cid),'type':'public-key','response':{'clientDataJSON':pk.b64(client),'authenticatorData':pk.b64(data),'signature':pk.b64(signature),'userHandle':pk.b64(handle)}}

    def test_android_options_are_opt_in_and_do_not_change_web_origins(self):
        with patch.object(pk, 'ANDROID_ORIGINS', {}):
            with self.assertRaises(pk.Error) as error:
                pk.begin(ANDROID_ORIGIN)
            self.assertEqual(error.exception.status, 403)
        with patch.object(pk, 'ANDROID_ORIGINS', ANDROID_ORIGINS):
            options = pk.begin(ANDROID_ORIGIN)
            self.assertEqual(options['expiresIn'], 300)
            self.assertEqual(options['publicKey']['rpId'], ANDROID_RP)
            self.assertEqual(options['publicKey']['userVerification'], 'required')
            self.assertEqual(options['publicKey']['allowCredentials'], [])
            for origin in ('', 'android:unknown', 'https://unlisted.example.com',
                           'android:apk-key-hash:' + pk.b64(bytes(32))):
                with self.subTest(origin=origin), self.assertRaises(pk.Error) as error:
                    pk.begin(origin)
                self.assertEqual(error.exception.status, 403)
            for origin in pk.DEFAULT_ORIGINS:
                with self.subTest(origin=origin):
                    self.origin = origin
                    self.cid = pk.secrets.token_bytes(32)
                    self.register()
                    web = pk.begin(origin)
                    self.assertEqual(web['publicKey']['rpId'], origin.removeprefix('https://'))
                    self.assertEqual(pk.finish(origin, web['challengeToken'], self.assertion(web))['uid'], self.uid)

    @patch.object(pk, 'ANDROID_ORIGINS', ANDROID_ORIGINS)
    def test_android_login_reuses_web_credential_for_same_rp(self):
        self.origin = 'https://' + ANDROID_RP
        self.register()
        native = pk.begin(ANDROID_ORIGIN)
        credential = self.assertion(native, origin=ANDROID_ORIGIN, counter=2)
        result = pk.finish(ANDROID_ORIGIN, native['challengeToken'], credential, device='Android test', platform='app')
        self.assertEqual(result['uid'], self.uid)
        self.assertEqual(cm_db.user_by_token(result['token'])['id'], self.uid)
        with self.assertRaises(pk.Error):
            pk.finish(ANDROID_ORIGIN, native['challengeToken'], credential)
        next_challenge = pk.begin(ANDROID_ORIGIN)
        with self.assertRaises(pk.Error):
            pk.finish(ANDROID_ORIGIN, next_challenge['challengeToken'], self.assertion(next_challenge, origin=ANDROID_ORIGIN))

    @patch.object(pk, 'ANDROID_ORIGINS', ANDROID_ORIGINS)
    def test_android_assertion_rejections_consume_challenge(self):
        self.origin = 'https://' + ANDROID_RP
        self.register()
        other_user = cm_db.create_user('other', 'password', 'Other')
        pk.begin(self.origin, other_user, cm_db.issue_token(other_user), 'password')
        with closing(cm_db.connect()) as conn:
            row = conn.execute('SELECT handle FROM passkey_users WHERE uid=?', (other_user,)).fetchone()
            other_handle = pk.b64(row['handle'])
        for options, response in (
            ({'origin': self.origin}, {}), ({'rp': 'music.ctcehs.com'}, {}),
            ({'challenge': pk.b64(bytes(32))}, {}), ({'uv': False}, {}),
            ({}, {'signature': pk.b64(bytes(64))}), ({}, {'userHandle': other_handle}),
        ):
            with self.subTest(options=options, response=response):
                native = pk.begin(ANDROID_ORIGIN)
                credential = self.assertion(native, **({'origin': ANDROID_ORIGIN} | options))
                credential['response'].update(response)
                with self.assertRaises(pk.Error):
                    pk.finish(ANDROID_ORIGIN, native['challengeToken'], credential)
                with self.assertRaises(pk.Error):
                    pk.finish(ANDROID_ORIGIN, native['challengeToken'], self.assertion(native, origin=ANDROID_ORIGIN))

    @patch.object(pk, 'ANDROID_ORIGINS', ANDROID_ORIGINS)
    def test_android_registration_uses_mapped_rp(self):
        self.origin = ANDROID_ORIGIN
        options, _ = self.register()
        self.assertEqual(options['publicKey']['rp']['id'], ANDROID_RP)
        self.origin = 'https://' + ANDROID_RP
        web = pk.begin(self.origin)
        self.assertEqual(pk.finish(self.origin, web['challengeToken'], self.assertion(web))['uid'], self.uid)

    @patch.object(pk, 'ANDROID_ORIGINS', ANDROID_ORIGINS)
    def test_android_challenge_bound_to_origin_and_original_rp(self):
        self.origin = 'https://' + ANDROID_RP
        self.register()
        for start_origin, finish_origin in ((self.origin, ANDROID_ORIGIN), (ANDROID_ORIGIN, self.origin)):
            start = pk.begin(start_origin)
            with self.assertRaises(pk.Error):
                pk.finish(finish_origin, start['challengeToken'], self.assertion(start, origin=finish_origin))
        native = pk.begin(ANDROID_ORIGIN)
        self.origin = 'https://music.ctcehs.com'
        self.cid = pk.secrets.token_bytes(32)
        self.register()
        with patch.object(pk, 'ANDROID_ORIGINS', {ANDROID_ORIGIN: 'music.ctcehs.com'}):
            credential = self.assertion(native, origin=ANDROID_ORIGIN, rp='music.ctcehs.com')
            with self.assertRaises(pk.Error):
                pk.finish(ANDROID_ORIGIN, native['challengeToken'], credential)

    def test_legacy_https_challenge_survives_rp_column_migration(self):
        token = pk.secrets.token_urlsafe(32)
        challenge = pk.secrets.token_bytes(32)
        conn = cm_db.connect()
        try:
            conn.execute('''CREATE TABLE passkey_challenges(id TEXT PRIMARY KEY,kind TEXT NOT NULL,uid INTEGER,
                         sid TEXT NOT NULL,origin TEXT NOT NULL,challenge BLOB NOT NULL,expires INTEGER NOT NULL)''')
            conn.execute('INSERT INTO passkey_challenges VALUES(?,?,?,?,?,?,?)',
                         (hashlib.sha256(token.encode()).hexdigest(), 'login', None,
                          hashlib.sha256(b'').hexdigest(), self.origin, challenge, int(pk.time.time()) + 300))
            conn.commit()
        finally:
            conn.close()
        self.register()
        options = {'publicKey': {'challenge': pk.b64(challenge), 'rpId': 'music.ctcehs.com'}}
        self.assertEqual(pk.finish(self.origin, token, self.assertion(options))['uid'], self.uid)
    def test_real_signatures_bypass_question_and_replay(self):
        self.register()
        cm_2fa.enable_question(self.uid,self.sid,'password','测试问题','answer')
        start=pk.begin(self.origin);cred=self.assertion(start)
        r=pk.finish(self.origin,start['challengeToken'],cred)
        self.assertEqual(r['uid'],self.uid);self.assertTrue(r['token'])
        with self.assertRaises(pk.Error):pk.finish(self.origin,start['challengeToken'],cred)
        with self.assertRaises(pk.Error):pk.begin(self.origin,self.uid,self.sid,'password','wrong')
    def test_security_rejections_and_revoke(self):
        self.register()
        for uv,origin in [(False,None),(True,'https://evil.test')]:
            start=pk.begin(self.origin)
            with self.assertRaises(pk.Error):pk.finish(self.origin,start['challengeToken'],self.assertion(start,uv,origin))
        start=pk.begin(self.origin);cred=self.assertion(start)
        pk.remove(self.uid,pk.b64(self.cid),'password','')
        with self.assertRaises(pk.Error):pk.finish(self.origin,start['challengeToken'],cred)
        with self.assertRaises(pk.Error):pk.begin('https://evil.test')
    def test_totp_login_requires_no_extra_code(self):
        self.register()
        setup=cm_2fa.setup(self.uid,self.sid,'password')
        step=int(pk.time.time())//30
        cm_2fa.enable(self.uid,self.sid,cm_2fa.totp(setup['secret'],step-1))
        self.assertTrue(cm_2fa.challenge(self.uid,'test','web')['requires2FA'])
        start=pk.begin(self.origin)
        self.assertTrue(pk.finish(self.origin,start['challengeToken'],self.assertion(start))['token'])
        with self.assertRaises(pk.Error):pk.begin(self.origin,self.uid,self.sid,'password','000000')
    def test_expired_and_wrong_session(self):
        start=pk.begin(self.origin,self.uid,self.sid,'password')
        with self.assertRaises(pk.Error):pk.finish(self.origin,start['challengeToken'],{},self.uid,'another-session')
        start=pk.begin(self.origin)
        c=pk.connect();c.execute('UPDATE passkey_challenges SET expires=0');c.commit();c.close()
        with self.assertRaises(pk.Error):pk.finish(self.origin,start['challengeToken'],{})
    def test_session_origin_expiry_and_disabled(self):
        start,cred=self.register()
        with self.assertRaises(pk.Error):pk.finish(self.origin,start['challengeToken'],cred,self.uid,'wrong')
        start=pk.begin(self.origin);cred=self.assertion(start)
        c=pk.connect();c.execute('UPDATE users SET disabled=1 WHERE id=?',(self.uid,));c.commit();c.close()
        with self.assertRaises(pk.Error):pk.finish(self.origin,start['challengeToken'],cred)
