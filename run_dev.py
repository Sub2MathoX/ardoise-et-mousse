"""Aperçu local explicite avec SQLite ; Docker utilise PostgreSQL."""
import os
import secrets
from app.server import create_app

if __name__ == '__main__':
    if not os.environ.get('ADMIN_PASSWORD'):
        import getpass
        os.environ['ADMIN_PASSWORD'] = getpass.getpass('Mot de passe administrateur local (12 caractères minimum) : ')
    app = create_app({
        'DATABASE_URL': os.environ.get('DATABASE_URL', 'sqlite:///work/dev.db'),
        'SECRET_KEY': os.environ.get('SECRET_KEY') or secrets.token_hex(32),
    })
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT', 8080)), debug=False)
