# Ardoise & Mousse

Le comptoir de la maison : une application privée pour compter les verres servis à la tireuse, gérer les fûts achetés à l’avance et partager leur coût entre les consommateurs.

## Installation sur Debian

Prérequis : Git, Python 3 et Docker Engine avec le plugin `docker compose`. Guide officiel Docker pour Debian : <https://docs.docker.com/engine/install/debian/>.

Après publication du dépôt :

```sh
git clone https://github.com/Sub2MathoX/ardoise-et-mousse.git
cd ardoise-et-mousse
python3 scripts/configure.py
docker compose up -d --build
docker compose ps
```

Le script demande le mot de passe du back-office, génère les secrets et crée `.env` sans écraser de configuration existante. Ce fichier est exclu de Git. Le mot de passe doit comporter au moins 12 caractères. Les apostrophes et antislashs ne sont pas acceptés par ce script de configuration. Les autres caractères, dont `$` et `#`, sont conservés grâce aux quotes simples du fichier Compose.

- Tablette : `http://ADRESSE_IP_DU_SERVEUR:8080/`
- Administration : `http://ADRESSE_IP_DU_SERVEUR:8080/admin`
- État du service : `http://ADRESSE_IP_DU_SERVEUR:8080/health`

Remplacez `ADRESSE_IP_DU_SERVEUR` par l’adresse LAN de Debian. Une réservation DHCP évite les changements d’adresse. La configuration est destinée au réseau privé : ne créez pas de redirection de port Internet. HTTP est utilisé par défaut pour le LAN ; le mot de passe n’est alors pas chiffré en transit. Si vous avez déjà un reverse proxy HTTPS, utilisez-le et passez `COOKIE_SECURE=true` dans `.env`. Le proxy doit conserver l’en-tête Host d’origine.

`APP_PORT` et `BIND_ADDRESS` sont configurables dans `.env`. La valeur par défaut `0.0.0.0` écoute sur les interfaces du serveur ; vous pouvez la remplacer par son IP LAN. PostgreSQL n’a aucun port publié. La construction des images requiert Internet ; leur utilisation ne dépend d’aucun service externe, police distante ou CDN.

## Première utilisation

La base démarre vide, sans profil, fût, ardoise ni compte de démonstration.

1. Ouvrez `/admin` et entrez le mot de passe choisi.
2. Dans **Les profils**, créez les habitués, votre profil et éventuellement **Invité**. Invité est un profil classique avec une ardoise indépendante.
3. Dans **Les fûts**, ajoutez les achats : bière, volume, coût unitaire, date et quantité. Chaque exemplaire devient un fût distinct, modifiable tant qu’il est en stock.
4. Ouvrez la tablette et choisissez **Ouvrir un fût**.
5. Pour servir : prénom, puis format. Les boutons valent 25 et 50 cl par défaut ; ils sont modifiables dans **Réglages**. Le champ libre accepte de 0,1 à 500 cl, au dixième de cl.
6. À la fin du fût : **Changer le fût**, sélectionner un remplaçant, confirmer. Vous pouvez aussi terminer le fût sans remplaçant. Aucune connexion ni aucun code n’est demandé sur la tablette.
7. Après clôture, consultez **Les ardoises** et enregistrez manuellement les règlements reçus, complets ou partiels.

La tablette n’affiche aucun prix ni solde. Les profils et le stock sont actualisés toutes les quinze secondes lorsque personne ne remplit un champ. Le back-office charge ses données à l’ouverture et après chaque action ; actualisez la page pour voir les changements effectués depuis un autre appareil.

## Règles des comptes

- Les montants sont conservés en **centimes entiers**, les volumes en **millilitres entiers**.
- Part de chaque profil : coût du fût × volume de la personne / somme des volumes enregistrés.
- Les centimes indivisibles sont attribués selon la méthode des plus forts restes. Une égalité est départagée de manière stable par l’identifiant du profil. Le total correspond exactement au coût du fût.
- Les pertes et la mousse sont absorbées dans ce partage. Le volume restant affiché est une estimation, jamais une mesure physique.
- Un dépassement de capacité est signalé et ne bloque pas les consommations.
- Aucun coût provisoire n’entre dans l’ardoise : la comptabilisation se fait à la clôture.
- Sans consommation, un fût clôturé reste **à affecter**. Son coût peut être attribué à un profil dans son détail, ou réparti après ajout des consommations oubliées.
- Une correction après clôture recalcule les parts et ajoute uniquement les écarts au journal comptable. Les règlements déjà enregistrés restent intacts.
- Un solde positif est une dette ; un solde négatif est un crédit. Les soldes commencent à zéro.
- Un règlement diminue l’ardoise. Un ajustement signé permet une remise ou une correction motivée. Pour annuler un règlement erroné, ajoutez un ajustement positif du même montant.

Exemple : fût à 36 €, volumes enregistrés de 2 L, 1,5 L et 1,5 L : parts de 14,40 €, 10,80 € et 10,80 €, même si le fût contenait initialement 6 L.

## Fiabilité et corrections

Une consommation est confirmée uniquement après enregistrement serveur. Le bouton **Annuler** est disponible pendant dix secondes et nécessite le jeton associé à cette saisie. Après ce délai ou après clôture, la correction passe par le back-office, dans le détail du fût.

Chaque écriture utilise une clé d’idempotence. En cas de réponse perdue, un bandeau propose **Vérifier et réessayer** : la même opération est rejouée avec la même clé et ne compte pas deux fois. L’opération en attente reste dans le stockage de session de l’onglet après actualisation. Ne fermez pas cet onglet tant que la confirmation n’est pas résolue ; s’il a été fermé, vérifiez le journal avant de ressaisir. Ce mécanisme ne constitue pas un mode hors ligne.

Les changements de fût et les consommations sont sérialisés par un verrou transactionnel PostgreSQL partagé entre les processus. L’identifiant du fût attendu est vérifié côté serveur. Une tablette qui affiche un ancien fût ne peut pas débiter le suivant par erreur. La base impose également un seul fût actif.

Les profils peuvent être archivés et réordonnés, sans supprimer leur historique. Le journal conserve les opérations et les motifs des corrections. Les actions tablette restent anonymes : le profil consommateur n’identifie pas la personne ayant effectué la saisie. La session administrateur expire après douze heures ; les tentatives de connexion sont limitées par adresse réseau.

## Sauvegarde et restauration

Le service `backup` crée un export PostgreSQL à son démarrage puis toutes les 24 heures, dans `./backups`. Il conserve trente jours d’exports. Un redémarrage du service réinitialise ce rythme ; il ne s’agit pas d’une heure fixe quotidienne. Vérifiez régulièrement ses journaux :

```sh
docker compose logs --tail=30 backup
docker compose exec backup sh /usr/local/bin/backup.sh
```

Les fichiers sont au format `pg_dump` personnalisé, avec permissions restrictives. Copiez régulièrement le dossier de sauvegarde sur un autre support ; une copie sur le même disque ne protège pas d’une panne du disque. Conservez aussi `.env` dans un emplacement privé. Les exports contiennent les profils et leurs comptes et ne sont pas chiffrés.

Pour restaurer un export existant :

```sh
sh scripts/restore.sh backups/ardoise-YYYYMMDDTHHMMSSZ-PID.dump
```

Le script demande de saisir `RESTAURER`, vérifie le format, arrête l’application et les sauvegardes, puis remplace les données dans une seule transaction. Il redémarre les services après réussite. En cas d’échec, la transaction est annulée et les services restent arrêtés pour diagnostic. Remplacez le nom d’exemple par un vrai fichier. Sur un serveur neuf, lancez d’abord Compose pour créer la base et son volume.

Ne lancez pas `docker compose down -v` pour une mise à jour : cette commande supprime le volume de données.

## Mise à jour

```sh
docker compose exec backup sh /usr/local/bin/backup.sh
git pull --ff-only
docker compose up -d --build
docker compose ps
```

Les images PostgreSQL restent sur la version majeure 17. Une future montée majeure demandera une procédure dédiée. Le schéma initial est créé de manière idempotente ; les futures évolutions de schéma devront inclure des migrations explicites. Ne régénérez pas `POSTGRES_PASSWORD` une fois le volume créé : PostgreSQL conserve le mot de passe initial dans sa base.

## Développement et tests

Architecture : Flask et Gunicorn pour le serveur, PostgreSQL 17 en production, interface HTML/CSS/JavaScript sans compilation. SQLite sert uniquement aux tests locaux et à l’aperçu de développement.

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m unittest discover -s tests -v
node --test tests/frontend.test.cjs
python run_dev.py
```

Sous Windows, activez l’environnement avec `.venv\Scripts\Activate.ps1`. `run_dev.py` demande un mot de passe local et écoute uniquement sur `127.0.0.1:8080`. La base de développement est dans `work/dev.db`, exclue de Git. Le serveur de développement n’est pas utilisé dans Docker.

Les tests couvrent les montants, les arrondis, les corrections, les remboursements, les protections d’accès, la concurrence, les reprises après interruption et le rendu des états principaux de l’interface. La CI GitHub exécute également les tests sur une base PostgreSQL jetable nommée `ardoise_test`, valide Compose et construit l’image. Pour lancer cette variante localement, fournissez `TEST_DATABASE_URL` pointant uniquement vers une base dédiée portant ce nom ; ses tables sont vidées à chaque test.

Structure :

```text
app/accounting.py       Calcul exact et validation des quantités
app/db.py               Schéma et transactions PostgreSQL / SQLite
app/server.py           API, authentification, règles métier
app/static/             Interface tablette et back-office
scripts/                Configuration, sauvegarde et restauration
tests/                  Tests métier, API, concurrence et interface
compose.yaml            Application, base et sauvegardes
```

Références techniques : [Flask / Gunicorn](https://flask.palletsprojects.com/en/stable/deploying/gunicorn/), [Psycopg](https://www.psycopg.org/psycopg3/docs/basic/install.html), [démarrage Compose](https://docs.docker.com/compose/how-tos/startup-order/).
