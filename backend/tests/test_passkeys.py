import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import base64
import hashlib
import json
import struct
import unittest
from unittest.mock import patch
import cbor2
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
import cm_db
import cm_2fa
import cm_passkeys as pk

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

    def setUp(self):
        cm_db.init()
        self.uid=cm_db.create_user('pk_'+pk.secrets.token_hex(6),'password','Test')
        self.sid=cm_db.issue_token(self.uid)
        self.origin='https://music.ctcehs.com'
        self.private=ec.generate_private_key(ec.SECP256R1())
        self.cid=pk.secrets.token_bytes(32)
    def client(self,options,kind,origin=None):
        return json.dumps({'type':kind,'challenge':options['publicKey']['challenge'],'origin':origin or self.origin,'crossOrigin':False}).encode()
    def register(self):
        start=pk.begin(self.origin,self.uid,self.sid,'password')
        pub=self.private.public_key().public_numbers()
        cose=cbor2.dumps({1:2,3:-7,-1:1,-2:pub.x.to_bytes(32,'big'),-3:pub.y.to_bytes(32,'big')})
        data=hashlib.sha256(b'music.ctcehs.com').digest()+bytes([0x45])+struct.pack('>I',0)+bytes(16)+struct.pack('>H',len(self.cid))+self.cid+cose
        credential={'id':pk.b64(self.cid),'rawId':pk.b64(self.cid),'type':'public-key','response':{'clientDataJSON':pk.b64(self.client(start,'webauthn.create')),'attestationObject':pk.b64(cbor2.dumps({'fmt':'none','attStmt':{},'authData':data}))}}
        pk.finish(self.origin,start['challengeToken'],credential,self.uid,self.sid)
        return start,credential
    def assertion(self,start,uv=True,origin=None):
        client=self.client(start,'webauthn.get',origin)
        data=hashlib.sha256(b'music.ctcehs.com').digest()+bytes([5 if uv else 1])+struct.pack('>I',1)
        signature=self.private.sign(data+hashlib.sha256(client).digest(),ec.ECDSA(hashes.SHA256()))
        c=pk.connect();handle=c.execute('SELECT handle FROM passkey_users WHERE uid=?',(self.uid,)).fetchone()[0];c.close()
        return {'id':pk.b64(self.cid),'rawId':pk.b64(self.cid),'type':'public-key','response':{'clientDataJSON':pk.b64(client),'authenticatorData':pk.b64(data),'signature':pk.b64(signature),'userHandle':pk.b64(handle)}}
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
