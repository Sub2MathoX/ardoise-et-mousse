"""Crée la configuration initiale sans écraser un fichier existant."""
import getpass
import os
import secrets
from pathlib import Path

root = Path(__file__).resolve().parents[1]
target = root / '.env'
if target.exists():
    raise SystemExit('Le fichier .env existe déjà. Modifiez-le directement si nécessaire.')
password = getpass.getpass('Mot de passe administrateur (12 caractères minimum) : ')
if len(password) < 12 or any(c in password for c in "\r\n'\\"):
    raise SystemExit("Minimum 12 caractères, sans apostrophe, antislash ni retour à la ligne.")
if password != getpass.getpass('Confirmer le mot de passe : '):
    raise SystemExit('Les mots de passe diffèrent.')
content = (
    f'POSTGRES_PASSWORD={secrets.token_hex(24)}\n'
    f'SECRET_KEY={secrets.token_hex(32)}\n'
    f"ADMIN_PASSWORD='{password}'\n"
    'APP_PORT=8080\nBIND_ADDRESS=0.0.0.0\nCOOKIE_SECURE=false\n'
)
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as output:
    output.write(content)
print('Configuration créée. Vous pouvez lancer : docker compose up -d --build')
