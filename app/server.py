import hashlib
import json
import os
import secrets
import time
import uuid
from datetime import date, timedelta
from functools import wraps
from urllib.parse import urlsplit

from flask import Flask, jsonify, request, session, send_from_directory
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

from .accounting import allocate, decimal_units
from .db import initialize, transaction


class Problem(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


def uid():
    return str(uuid.uuid4())


def now():
    return int(time.time())


def text_value(data, key, limit=100):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise Problem(f'Champ {key} requis (maximum {limit} caractères).')
    return value.strip()


def get_record(db, table, identifier):
    # Les noms de table proviennent uniquement des constantes internes.
    row = db.one(f'SELECT * FROM {table} WHERE id=?', (identifier,))
    if not row:
        raise Problem('Élément introuvable.', 404)
    return row


def audit(db, action, detail):
    db.execute('INSERT INTO audit VALUES(?,?,?,?)', (uid(), action, json.dumps(detail, ensure_ascii=False), now()))


def ledger(db, profile, amount, kind, note, keg=None):
    db.execute('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)', (uid(), profile, keg, amount, kind, note, now()))


def keg_totals(db, identifier):
    return {r['profile_id']: r['volume_ml'] for r in db.all(
        'SELECT profile_id,SUM(volume_ml) AS volume_ml FROM consumptions WHERE keg_id=? AND cancelled_at IS NULL GROUP BY profile_id', (identifier,))}


def reconcile(db, keg):
    volumes = keg_totals(db, keg['id'])
    target = allocate(keg['cost_cents'], volumes)
    if not volumes and keg['manual_assignee']:
        target = {keg['manual_assignee']: keg['cost_cents']}
    previous = {r['profile_id']: r['amount'] for r in db.all(
        "SELECT profile_id,SUM(amount_cents) AS amount FROM ledger WHERE keg_id=? AND kind='allocation' GROUP BY profile_id", (keg['id'],))}
    for profile in sorted(set(target) | set(previous)):
        difference = target.get(profile, 0) - previous.get(profile, 0)
        if difference:
            ledger(db, profile, difference, 'allocation', f"Répartition : {keg['name']}", keg['id'])


def create_app(config=None):
    app = Flask(__name__, static_folder='static')
    app.config.update(
        SECRET_KEY=os.environ.get('SECRET_KEY', ''),
        ADMIN_PASSWORD=os.environ.get('ADMIN_PASSWORD', ''),
        DATABASE_URL=os.environ.get('DATABASE_URL', ''),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Strict',
        SESSION_COOKIE_SECURE=os.environ.get('COOKIE_SECURE', 'false').lower() == 'true',
        PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
        MAX_CONTENT_LENGTH=32_768,
    )
    if config:
        app.config.update(config)
    if len(app.config['SECRET_KEY']) < 32 or len(app.config['ADMIN_PASSWORD']) < 12:
        raise RuntimeError('SECRET_KEY (32 caractères minimum) et ADMIN_PASSWORD (12 minimum) requis.')
    if not app.config['DATABASE_URL']:
        raise RuntimeError('DATABASE_URL requis.')
    password_hash = generate_password_hash(app.config.pop('ADMIN_PASSWORD'))
    with app.app_context():
        initialize()

    @app.errorhandler(Problem)
    def problem(error):
        return jsonify(error=error.message), error.status

    @app.errorhandler(ValueError)
    def bad_value(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error='Requête invalide.' if error.code != 404 else 'Page introuvable.'), error.code

    @app.errorhandler(Exception)
    def unexpected(error):
        app.logger.exception('Erreur de traitement')
        return jsonify(error='Le serveur est indisponible. Réessayez avec la même opération.'), 503

    @app.before_request
    def protect_requests():
        if request.method == 'POST':
            if request.headers.get('X-AM-Request') != '1' or not request.is_json:
                raise Problem('Requête non autorisée.', 403)
            origin = request.headers.get('Origin')
            if origin and urlsplit(origin).netloc != request.host:
                raise Problem('Origine non autorisée.', 403)
            if request.headers.get('Sec-Fetch-Site') == 'cross-site':
                raise Problem('Origine non autorisée.', 403)

    @app.after_request
    def headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        if request.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    def admin_only(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            if not session.get('admin'):
                raise Problem('Connexion administrateur requise.', 401)
            return fn(*args, **kwargs)
        return wrapped

    def mutation(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            data = request.get_json()
            if not isinstance(data, dict):
                raise Problem('Objet JSON attendu.')
            key = request.headers.get('Idempotency-Key', '')
            try:
                uuid.UUID(key)
            except ValueError:
                raise Problem('Identifiant de requête invalide.') from None
            signature = hashlib.sha256((request.path + json.dumps(data, sort_keys=True)).encode()).hexdigest()
            with transaction(write=True) as db:
                cached = db.one('SELECT * FROM requests WHERE id=?', (key,))
                if cached:
                    if cached['signature'] != signature:
                        raise Problem('Cet identifiant désigne une autre opération.', 409)
                    return jsonify(json.loads(cached['response']))
                result = fn(db, data, *args, **kwargs)
                db.execute('INSERT INTO requests VALUES(?,?,?,?)', (key, signature, json.dumps(result), now()))
                return jsonify(result)
        return wrapped

    @app.get('/')
    @app.get('/admin')
    def index():
        return send_from_directory(app.static_folder, 'index.html')

    @app.get('/health')
    def health():
        with transaction() as db:
            db.one('SELECT 1 AS ok')
        return jsonify(status='ok')

    @app.get('/api/public')
    def public_state():
        with transaction() as db:
            profiles = db.all('SELECT id,name,color FROM profiles WHERE active=1 ORDER BY position,created_at,id')
            active = db.one("SELECT id,name,volume_ml,opened_at FROM kegs WHERE status='active'")
            if active:
                active['served_ml'] = sum(keg_totals(db, active['id']).values())
            stock = db.all("SELECT id,name,volume_ml,purchased_on FROM kegs WHERE status='stock' ORDER BY purchased_on,created_at,id")
            settings = db.one('SELECT small_ml,large_ml FROM settings WHERE id=1')
            return jsonify(profiles=profiles, active=active, stock=stock, settings=settings)

    @app.post('/api/consume')
    @mutation
    def consume(db, data):
        active = db.one("SELECT * FROM kegs WHERE status='active'")
        if not active or active['id'] != data.get('keg_id'):
            raise Problem('Le fût a changé. Actualisez avant de servir.', 409)
        profile = get_record(db, 'profiles', data.get('profile_id'))
        if not profile['active']:
            raise Problem('Ce profil est archivé.', 409)
        ml = decimal_units(data.get('volume_cl'), 10, 1, 5000, 'Volume (0,1 à 500 cl)')
        token = secrets.token_urlsafe(32)
        identifier = uid()
        db.execute('INSERT INTO consumptions VALUES(?,?,?,?,?,?,?)',
                   (identifier, profile['id'], active['id'], ml, now(), None, hashlib.sha256(token.encode()).hexdigest()))
        audit(db, 'consumption.created', {'id': identifier, 'profile': profile['name'], 'ml': ml})
        return {'id': identifier, 'undo_token': token, 'undo_until': now() + 10, 'message': f"{profile['name']} · {ml / 10:g} cl enregistré"}

    @app.post('/api/consume/<identifier>/undo')
    @mutation
    def undo(db, data, identifier):
        entry = get_record(db, 'consumptions', identifier)
        token = str(data.get('token', ''))
        if not secrets.compare_digest(hashlib.sha256(token.encode()).hexdigest(), entry['undo_hash']):
            raise Problem('Annulation non autorisée.', 403)
        if now() > entry['created_at'] + 10:
            raise Problem('Délai dépassé. La correction reste possible dans le back-office.', 409)
        keg = get_record(db, 'kegs', entry['keg_id'])
        if keg['status'] != 'active':
            raise Problem('Fût clôturé : contactez l’administrateur.', 409)
        db.execute('UPDATE consumptions SET cancelled_at=? WHERE id=?', (now(), identifier))
        audit(db, 'consumption.undone', {'id': identifier})
        return {'ok': True}

    @app.post('/api/switch')
    @mutation
    def switch(db, data):
        active = db.one("SELECT * FROM kegs WHERE status='active'")
        if (active['id'] if active else None) != data.get('expected_keg_id'):
            raise Problem('Le fût a déjà changé. Actualisez la tablette.', 409)
        next_id = data.get('next_keg_id')
        if not active and not next_id:
            raise Problem('Sélectionnez un fût à ouvrir.')
        if next_id:
            target = get_record(db, 'kegs', next_id)
            if target['status'] != 'stock':
                raise Problem('Ce fût n’est plus en stock.', 409)
        if active:
            reconcile(db, active)
            db.execute("UPDATE kegs SET status='closed',closed_at=? WHERE id=?", (now(), active['id']))
        if next_id:
            db.execute("UPDATE kegs SET status='active',opened_at=? WHERE id=?", (now(), next_id))
        audit(db, 'keg.switched', {'closed': active['id'] if active else None, 'opened': next_id})
        return {'ok': True}

    @app.post('/api/login')
    def login():
        data = request.get_json()
        if not isinstance(data, dict) or not isinstance(data.get('password'), str):
            raise Problem('Mot de passe requis.')
        address = request.remote_addr or 'unknown'
        accepted = False
        with transaction(write=True) as db:
            attempt = db.one('SELECT * FROM login_attempts WHERE address=?', (address,))
            if attempt and now() - attempt['started_at'] < 300 and attempt['count'] >= 10:
                raise Problem('Trop de tentatives. Réessayez dans cinq minutes.', 429)
            if attempt is None or now() - attempt['started_at'] >= 300:
                db.execute('DELETE FROM login_attempts WHERE address=?', (address,))
                db.execute('INSERT INTO login_attempts VALUES(?,?,?)', (address, 0, now()))
            accepted = check_password_hash(password_hash, data['password'])
            if accepted:
                db.execute('DELETE FROM login_attempts WHERE address=?', (address,))
            else:
                db.execute('UPDATE login_attempts SET count=count+1 WHERE address=?', (address,))
        if not accepted:
            raise Problem('Mot de passe incorrect.', 401)
        session.clear()
        session['admin'] = True
        session.permanent = True
        return jsonify(ok=True)

    @app.post('/api/logout')
    def logout():
        session.clear()
        return jsonify(ok=True)

    @app.get('/api/admin')
    @admin_only
    def admin_state():
        with transaction() as db:
            profiles = db.all('SELECT * FROM profiles ORDER BY position,created_at,id')
            for profile in profiles:
                profile['balance_cents'] = db.one('SELECT COALESCE(SUM(amount_cents),0) AS amount FROM ledger WHERE profile_id=?', (profile['id'],))['amount']
            kegs = db.all('SELECT * FROM kegs ORDER BY created_at DESC,id')
            for keg in kegs:
                totals = keg_totals(db, keg['id'])
                keg['served_ml'] = sum(totals.values())
                keg['allocation'] = allocate(keg['cost_cents'], totals)
                keg['unassigned'] = keg['status'] == 'closed' and not totals and not keg['manual_assignee']
            return jsonify(profiles=profiles, kegs=kegs,
                           settings=db.one('SELECT small_ml,large_ml FROM settings WHERE id=1'))

    @app.get('/api/admin/kegs/<identifier>')
    @admin_only
    def keg_details(identifier):
        with transaction() as db:
            keg = get_record(db, 'kegs', identifier)
            totals = keg_totals(db, identifier)
            keg['served_ml'] = sum(totals.values())
            keg['allocation'] = allocate(keg['cost_cents'], totals)
            entries = db.all('SELECT c.id,c.profile_id,c.volume_ml,c.created_at,c.cancelled_at,p.name FROM consumptions c JOIN profiles p ON p.id=c.profile_id WHERE keg_id=? ORDER BY c.created_at DESC,c.id', (identifier,))
            return jsonify(keg=keg, entries=entries)

    @app.get('/api/admin/profiles/<identifier>/ledger')
    @admin_only
    def profile_ledger(identifier):
        with transaction() as db:
            get_record(db, 'profiles', identifier)
            return jsonify(entries=db.all('SELECT * FROM ledger WHERE profile_id=? ORDER BY created_at DESC,id', (identifier,)))

    @app.post('/api/admin/profiles')
    @admin_only
    @mutation
    def save_profile(db, data):
        name = text_value(data, 'name', 40)
        color = data.get('color', 'sage')
        if color not in ['sage', 'amber', 'rose', 'blue', 'lavender', 'clay']:
            raise Problem('Couleur invalide.')
        position = data.get('position', 0)
        if type(position) is not int or not 0 <= position <= 999:
            raise Problem('Ordre invalide (0 à 999).')
        active = data.get('active', True)
        if not isinstance(active, bool):
            raise Problem('État du profil invalide.')
        identifier = data.get('id') or uid()
        if data.get('id'):
            get_record(db, 'profiles', identifier)
            db.execute('UPDATE profiles SET name=?,color=?,position=?,active=? WHERE id=?', (name, color, position, int(active), identifier))
        else:
            db.execute('INSERT INTO profiles VALUES(?,?,?,?,?,?)', (identifier, name, color, int(active), position, now()))
        audit(db, 'profile.saved', {'id': identifier, 'name': name, 'active': active})
        return {'id': identifier}

    @app.post('/api/admin/kegs')
    @admin_only
    @mutation
    def save_keg(db, data):
        name = text_value(data, 'name', 80)
        volume = decimal_units(data.get('volume_l'), 1000, 1, 100000, 'Volume en litres')
        cost = decimal_units(data.get('cost_eur'), 100, 0, 1000000, 'Coût en euros')
        purchased = data.get('purchased_on', '')
        try:
            purchased = date.fromisoformat(purchased).isoformat()
        except (ValueError, TypeError):
            raise Problem('Date d’achat invalide.') from None
        quantity = data.get('quantity', 1)
        if type(quantity) is not int or not 1 <= quantity <= 100:
            raise Problem('Quantité : de 1 à 100.')
        if data.get('id'):
            keg = get_record(db, 'kegs', data['id'])
            if keg['status'] != 'stock':
                raise Problem('Seuls les fûts en stock peuvent être modifiés.', 409)
            db.execute('UPDATE kegs SET name=?,volume_ml=?,cost_cents=?,purchased_on=? WHERE id=?', (name, volume, cost, purchased, keg['id']))
            ids = [keg['id']]
        else:
            ids = [uid() for _ in range(quantity)]
            for identifier in ids:
                db.execute('INSERT INTO kegs VALUES(?,?,?,?,?,?,?,?,?,?)', (identifier, name, volume, cost, 'stock', purchased, now(), None, None, None))
        audit(db, 'keg.saved', {'ids': ids, 'name': name})
        return {'ids': ids}

    @app.post('/api/admin/settings')
    @admin_only
    @mutation
    def settings(db, data):
        small = decimal_units(data.get('small_cl'), 10, 1, 5000, 'Premier format')
        large = decimal_units(data.get('large_cl'), 10, 1, 5000, 'Deuxième format')
        if small == large:
            raise Problem('Choisissez deux formats différents.')
        db.execute('UPDATE settings SET small_ml=?,large_ml=? WHERE id=1', (small, large))
        audit(db, 'settings.changed', {'small_ml': small, 'large_ml': large})
        return {'ok': True}

    @app.post('/api/admin/ledger')
    @admin_only
    @mutation
    def add_ledger(db, data):
        profile = get_record(db, 'profiles', data.get('profile_id'))
        kind = data.get('kind')
        if kind not in ('payment', 'adjustment'):
            raise Problem('Type d’écriture invalide.')
        note = text_value(data, 'note', 250)
        amount = decimal_units(data.get('amount_eur'), 100, 1 if kind == 'payment' else -1000000, 1000000, 'Montant')
        if amount == 0:
            raise Problem('Le montant doit être différent de zéro.')
        ledger(db, profile['id'], -amount if kind == 'payment' else amount, kind, note)
        audit(db, 'ledger.created', {'profile': profile['id'], 'kind': kind, 'amount_cents': amount, 'note': note})
        return {'ok': True}

    @app.post('/api/admin/consumptions')
    @admin_only
    @mutation
    def correct_consumption(db, data):
        note = text_value(data, 'note', 250)
        existing = get_record(db, 'consumptions', data['id']) if data.get('id') else None
        keg = get_record(db, 'kegs', existing['keg_id'] if existing else data.get('keg_id'))
        if keg['status'] == 'stock':
            raise Problem('Ce fût n’a pas été ouvert.')
        before = dict(existing) if existing else None
        if before:
            before.pop('undo_hash')
        if existing and data.get('cancel') is True:
            db.execute('UPDATE consumptions SET cancelled_at=? WHERE id=?', (now(), existing['id']))
        else:
            profile = get_record(db, 'profiles', data.get('profile_id'))
            volume = decimal_units(data.get('volume_cl'), 10, 1, 5000, 'Volume en cl')
            if existing:
                db.execute('UPDATE consumptions SET profile_id=?,volume_ml=?,cancelled_at=NULL WHERE id=?', (profile['id'], volume, existing['id']))
            else:
                db.execute('INSERT INTO consumptions VALUES(?,?,?,?,?,?,?)', (uid(), profile['id'], keg['id'], volume, now(), None, 'admin'))
        if keg['status'] == 'closed':
            reconcile(db, keg)
        audit(db, 'consumption.corrected', {'before': before, 'change': data, 'note': note})
        return {'ok': True, 'recalculated': keg['status'] == 'closed'}

    @app.post('/api/admin/kegs/<identifier>/assign')
    @admin_only
    @mutation
    def assign(db, data, identifier):
        keg = get_record(db, 'kegs', identifier)
        profile = get_record(db, 'profiles', data.get('profile_id'))
        note = text_value(data, 'note', 250)
        if keg['status'] != 'closed' or keg_totals(db, identifier):
            raise Problem('Seul un fût clôturé sans consommation peut être affecté.')
        keg['manual_assignee'] = profile['id']
        db.execute('UPDATE kegs SET manual_assignee=? WHERE id=?', (profile['id'], identifier))
        reconcile(db, keg)
        audit(db, 'keg.assigned', {'id': identifier, 'profile': profile['id'], 'note': note})
        return {'ok': True}

    @app.get('/api/admin/audit')
    @admin_only
    def audit_log():
        with transaction() as db:
            return jsonify(entries=db.all('SELECT * FROM audit ORDER BY created_at DESC,id LIMIT 200'))

    return app
