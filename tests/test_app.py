import os
import random
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

from app.accounting import allocate, decimal_units
from app.db import transaction
from app.server import create_app


class AccountingTests(unittest.TestCase):
    def test_example(self):
        self.assertEqual(allocate(3600, {'alice': 2000, 'bruno': 1500, 'chloe': 1500}), {'alice': 1440, 'bruno': 1080, 'chloe': 1080})

    def test_rounding_conserves_every_cent(self):
        rng = random.Random(42)
        for _ in range(2000):
            volumes = {str(i): rng.randint(1, 6000) for i in range(rng.randint(1, 30))}
            cost = rng.randint(0, 100000)
            shares = allocate(cost, volumes)
            self.assertEqual(sum(shares.values()), cost)
            for person, amount in shares.items():
                self.assertLess(abs(amount - cost * volumes[person] / sum(volumes.values())), 1.0000001)

    def test_ties_are_deterministic(self):
        self.assertEqual(allocate(100, {'c': 1, 'a': 1, 'b': 1}), {'c': 33, 'a': 34, 'b': 33})

    def test_empty_keg_is_unassigned(self):
        self.assertEqual(allocate(3600, {}), {})

    def test_decimal_validation(self):
        self.assertEqual(decimal_units('12,5', 10, 1, 5000, 'volume'), 125)
        for bad in ['NaN', 'Infinity', '-1', '0', '0.01', '10000', True, None]:
            with self.assertRaises(ValueError):
                decimal_units(bad, 10, 1, 5000, 'volume')


class AppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='ardoise-test-', dir=os.path.dirname(__file__))
        url = os.environ.get('TEST_DATABASE_URL', f'sqlite:///{cls.tmp.name}/test.db')
        if url.startswith('postgres') and urlsplit(url).path != '/ardoise_test':
            raise RuntimeError('La base de tests PostgreSQL doit être nommée ardoise_test.')
        cls.app = create_app({'TESTING': True, 'SECRET_KEY': 'test-' * 10, 'ADMIN_PASSWORD': 'test-password-123', 'DATABASE_URL': url})

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        with self.app.app_context(), transaction(write=True) as db:
            for table in ['audit', 'requests', 'consumptions', 'ledger', 'kegs', 'profiles', 'login_attempts']:
                db.execute(f'DELETE FROM {table}')
            db.execute('UPDATE settings SET small_ml=250,large_ml=500 WHERE id=1')
        self.client = self.app.test_client()
        response = self.post('/api/login', {'password': 'test-password-123'})
        self.assertEqual(response.status_code, 200)

    def post(self, path, data, key=None, client=None):
        return (client or self.client).post(path, json=data, headers={'X-AM-Request': '1', 'Idempotency-Key': key or str(uuid.uuid4())})

    def profile(self, name='Alice'):
        result = self.post('/api/admin/profiles', {'name': name, 'color': 'sage'})
        self.assertEqual(result.status_code, 200, result.json)
        return result.json['id']

    def keg(self, cost='36.00', quantity=1):
        result = self.post('/api/admin/kegs', {'name': 'Bière test', 'volume_l': 6, 'cost_eur': cost, 'purchased_on': '2026-11-07', 'quantity': quantity})
        self.assertEqual(result.status_code, 200, result.json)
        return result.json['ids']

    def switch(self, previous=None, next_id=None, client=None):
        return self.post('/api/switch', {'expected_keg_id': previous, 'next_keg_id': next_id}, client=client)

    def consume(self, profile, keg, volume=25, key=None, client=None):
        return self.post('/api/consume', {'profile_id': profile, 'keg_id': keg, 'volume_cl': volume}, key, client)

    def balance(self, profile):
        state = self.client.get('/api/admin').json
        return next(p['balance_cents'] for p in state['profiles'] if p['id'] == profile)

    def test_complete_lifecycle_and_partial_payment(self):
        alice, bob, guest = [self.profile(name) for name in ['Alice', 'Bob', 'Invité']]
        first, second = self.keg(quantity=2)
        self.assertEqual(self.switch(next_id=first).status_code, 200)
        for person, volume in [(alice, 200), (bob, 150), (guest, 150)]:
            self.assertEqual(self.consume(person, first, volume).status_code, 200)
        self.assertEqual(self.balance(alice), 0)
        self.assertEqual(self.switch(first, second).status_code, 200)
        self.assertEqual([self.balance(p) for p in [alice, bob, guest]], [1440, 1080, 1080])
        self.post('/api/admin/ledger', {'profile_id': alice, 'kind': 'payment', 'amount_eur': '5.00', 'note': 'Espèces'})
        self.assertEqual(self.balance(alice), 940)
        self.assertEqual(self.client.get('/api/public').json['active']['id'], second)

    def test_public_has_no_financial_data(self):
        self.profile()
        self.keg()
        result = self.app.test_client().get('/api/public')
        self.assertEqual(result.status_code, 200)
        for private in ['cost_cents', 'balance_cents', 'amount_cents', 'allocation']:
            self.assertNotIn(private, result.text)

    def test_admin_requires_authentication(self):
        public = self.app.test_client()
        self.assertEqual(public.get('/api/admin').status_code, 401)
        self.assertEqual(self.post('/api/admin/profiles', {'name': 'A'}, client=public).status_code, 401)

    def test_csrf_and_security_headers(self):
        self.assertEqual(self.client.post('/api/logout', json={}).status_code, 403)
        response = self.client.post('/api/logout', json={}, headers={'X-AM-Request': '1', 'Origin': 'https://evil.example'})
        self.assertEqual(response.status_code, 403)
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])
        response.close()
        self.assertEqual(self.client.get('/api/public').headers['Cache-Control'], 'no-store')

    def test_wrong_password_is_rate_limited(self):
        public = self.app.test_client()
        for _ in range(10):
            self.assertEqual(self.post('/api/login', {'password': 'wrong'}, client=public).status_code, 401)
        self.assertEqual(self.post('/api/login', {'password': 'test-password-123'}, client=public).status_code, 429)

    def test_idempotency_and_reused_key(self):
        p, k, key = self.profile(), self.keg()[0], str(uuid.uuid4())
        self.switch(next_id=k)
        first = self.consume(p, k, key=key)
        second = self.consume(p, k, key=key)
        self.assertEqual(first.json, second.json)
        self.assertEqual(self.consume(p, k, 50, key).status_code, 409)
        self.assertEqual(self.client.get('/api/public').json['active']['served_ml'], 250)

    def test_concurrent_identical_consumptions_count_once(self):
        p, k, key = self.profile(), self.keg()[0], str(uuid.uuid4())
        self.switch(next_id=k)
        def submit(_):
            return self.consume(p, k, key=key, client=self.app.test_client()).status_code
        with ThreadPoolExecutor(max_workers=6) as pool:
            self.assertEqual(list(pool.map(submit, range(6))), [200] * 6)
        self.assertEqual(self.client.get('/api/public').json['active']['served_ml'], 250)

    def test_concurrent_switches_only_one_wins(self):
        first, second, third = self.keg(quantity=3)
        self.switch(next_id=first)
        def submit(next_id):
            return self.switch(first, next_id, self.app.test_client()).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(submit, [second, third])), [200, 409])
        self.assertIn(self.client.get('/api/public').json['active']['id'], [second, third])

    def test_stale_tablet_cannot_charge_wrong_keg(self):
        p = self.profile()
        first, second = self.keg(quantity=2)
        self.switch(next_id=first)
        self.switch(first, second)
        self.assertEqual(self.consume(p, first).status_code, 409)
        self.assertEqual(self.client.get('/api/public').json['active']['served_ml'], 0)

    def test_invalid_replacement_rolls_back_closure(self):
        p, k = self.profile(), self.keg()[0]
        self.switch(next_id=k)
        self.consume(p, k)
        self.assertEqual(self.switch(k, str(uuid.uuid4())).status_code, 404)
        self.assertEqual(self.balance(p), 0)
        self.assertEqual(self.client.get('/api/public').json['active']['id'], k)

    def test_finish_without_replacement(self):
        k = self.keg()[0]
        self.switch(next_id=k)
        self.assertEqual(self.switch(k).status_code, 200)
        self.assertIsNone(self.client.get('/api/public').json['active'])

    def test_undo_token_and_deadline(self):
        p, k = self.profile(), self.keg()[0]
        self.switch(next_id=k)
        entry = self.consume(p, k).json
        path = f"/api/consume/{entry['id']}/undo"
        self.assertEqual(self.post(path, {'token': 'wrong'}).status_code, 403)
        with self.app.app_context(), transaction(write=True) as db:
            db.execute('UPDATE consumptions SET created_at=created_at-20 WHERE id=?', (entry['id'],))
        self.assertEqual(self.post(path, {'token': entry['undo_token']}).status_code, 409)
        entry = self.consume(p, k).json
        self.assertEqual(self.post(f"/api/consume/{entry['id']}/undo", {'token': entry['undo_token']}).status_code, 200)
        self.assertEqual(self.client.get('/api/public').json['active']['served_ml'], 250)

    def test_cannot_undo_after_closure(self):
        p, k = self.profile(), self.keg()[0]
        self.switch(next_id=k)
        entry = self.consume(p, k).json
        self.switch(k)
        self.assertEqual(self.post(f"/api/consume/{entry['id']}/undo", {'token': entry['undo_token']}).status_code, 409)

    def test_correction_reconciles_closed_keg_and_preserves_payment(self):
        a, b, k = self.profile('A'), self.profile('B'), self.keg()[0]
        self.switch(next_id=k)
        entry = self.consume(a, k, 25).json
        self.consume(b, k, 25)
        self.switch(k)
        self.post('/api/admin/ledger', {'profile_id': a, 'kind': 'payment', 'amount_eur': 10, 'note': 'Virement'})
        result = self.post('/api/admin/consumptions', {'id': entry['id'], 'profile_id': a, 'volume_cl': 50, 'note': 'Erreur de format'})
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json['recalculated'])
        self.assertEqual(self.balance(a), 1400)
        self.assertEqual(self.balance(b), 1200)

    def test_empty_keg_can_be_assigned_then_corrected(self):
        a, b, k = self.profile('A'), self.profile('Invité'), self.keg()[0]
        self.switch(next_id=k)
        self.switch(k)
        state = self.client.get('/api/admin').json
        self.assertTrue(state['kegs'][0]['unassigned'])
        self.post(f'/api/admin/kegs/{k}/assign', {'profile_id': b, 'note': 'Verres offerts'})
        self.assertEqual(self.balance(b), 3600)
        self.post('/api/admin/consumptions', {'profile_id': a, 'keg_id': k, 'volume_cl': 25, 'note': 'Saisie retrouvée'})
        self.assertEqual(self.balance(a), 3600)
        self.assertEqual(self.balance(b), 0)

    def test_archiving_preserves_balance_and_hides_profile(self):
        p, k = self.profile(), self.keg()[0]
        self.switch(next_id=k)
        self.consume(p, k)
        self.switch(k)
        self.post('/api/admin/profiles', {'id': p, 'name': 'Alice', 'active': False})
        self.assertEqual(self.client.get('/api/public').json['profiles'], [])
        self.assertEqual(self.balance(p), 3600)

    def test_excess_volume_is_allowed_and_cost_still_conserved(self):
        p, k = self.profile(), self.keg()[0]
        self.switch(next_id=k)
        self.consume(p, k, 500)
        self.consume(p, k, 500)
        self.assertEqual(self.client.get('/api/public').json['active']['served_ml'], 10000)
        self.switch(k)
        self.assertEqual(self.balance(p), 3600)

    def test_settings_and_custom_volume(self):
        self.assertEqual(self.post('/api/admin/settings', {'small_cl': '12.5', 'large_cl': '33'}).status_code, 200)
        self.assertEqual(self.client.get('/api/public').json['settings'], {'small_ml': 125, 'large_ml': 330})
        self.assertEqual(self.post('/api/admin/settings', {'small_cl': '0', 'large_cl': '33'}).status_code, 400)
        self.assertEqual(self.post('/api/admin/settings', {'small_cl': '33', 'large_cl': '33'}).status_code, 400)

    def test_signed_adjustment_and_credit(self):
        p = self.profile()
        self.post('/api/admin/ledger', {'profile_id': p, 'kind': 'adjustment', 'amount_eur': -5, 'note': 'Remise'})
        self.assertEqual(self.balance(p), -500)
        self.assertEqual(self.post('/api/admin/ledger', {'profile_id': p, 'kind': 'payment', 'amount_eur': -5, 'note': 'Invalide'}).status_code, 400)

    def test_audit_keeps_reason_and_before_state(self):
        p, k = self.profile(), self.keg()[0]
        self.switch(next_id=k)
        entry = self.consume(p, k).json
        self.post('/api/admin/consumptions', {'id': entry['id'], 'cancel': True, 'note': 'Double saisie'})
        result = self.client.get('/api/admin/audit')
        self.assertIn('Double saisie', result.json['entries'][0]['detail'] if result.json['entries'][0]['action']=='consumption.corrected' else result.text)
        self.assertNotIn('undo_hash', result.text)


if __name__ == '__main__':
    unittest.main()
