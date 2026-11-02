# Deployment examples

These files are templates for a self-hosted CurrentMusic backend. They are not
automatically installed.

- `backend.env.example` — required/optional environment variables. Copy to
  `/etc/currentmusic/backend.env`, fill NCM cookie paths and credentials, `chmod 600`.
- `currentmusic.service` — systemd unit; create the `currentmusic` user and place the
  checkout at `/srv/currentmusic` (or adjust paths).
- `currentmusic-lddc.service` — optional LDDC lyrics bridge (separate GPL-3.0 program).
- `install-lddc.sh` — install/upgrade LDDC under `/opt/lddc`, create a local token,
  install the bridge unit and enable `CM_LDDC_*` in a backend drop-in.
- `lddc-requirements.txt` — headless LDDC dependencies (PySide6 is not installed).
- `backup-currentmusic.sh` — daily consistent full backup of DB + user data, with
  rolling retention of the newest 3 archives.
- `currentmusic-backup.cron` — example `/etc/cron.d` entry for the daily backup.
- `nginx.conf.example` — reverse proxy with SSE locations. **Do not omit**
  `proxy_buffering off` for `/cm/live/chat` and `/cm/live/ai`, or streaming responses
  will be buffered.
- `php/` — optional PHP front-controller entry for PHP-only hosts (Apache/nginx+FPM),
  with SSE/Range streaming and a php2shell runtime gate. See `php/README.md`.

## First boot

```bash
sudo useradd --system --home /var/lib/currentmusic --shell /usr/sbin/nologin currentmusic
sudo install -d -o currentmusic -g currentmusic /var/lib/currentmusic /etc/currentmusic
python3 -m pip install -r deploy/requirements-auth.txt
sudo install -o currentmusic -g currentmusic -m 600 deploy/backend.env.example /etc/currentmusic/backend.env
# edit /etc/currentmusic/backend.env; write the NetEase cookie to CM_NCM_COOKIE
sudo -u currentmusic bash -c 'set -a; . /etc/currentmusic/backend.env; set +a; \
  python3 /srv/currentmusic/backend/manage.py init-db'
sudo -u currentmusic bash -c 'set -a; . /etc/currentmusic/backend.env; set +a; \
  python3 /srv/currentmusic/backend/manage.py create-owner admin' 
sudo install -m 644 deploy/currentmusic.service /etc/systemd/system/currentmusic.service
sudo systemctl daemon-reload && sudo systemctl enable --now currentmusic
```

The shell `source` above is only for the one-shot CLI; the service itself reads the
same file through systemd's `EnvironmentFile=` (values with spaces should be avoided
in env files).

## NCM API

The backend expects an api-enhanced/NetEaseCloudMusicApi service at `CM_NCM_BASE`
(default `http://127.0.0.1:3001`). That service is a separate project and is **not**
bundled here. The cookie file must contain a logged-in NetEase cookie; protect it like
a password.

## LDDC word-by-word lyrics (optional)

CurrentMusic already synthesizes per-character timing from line-level lyrics. For
real karaoke timing it can call [LDDC](https://github.com/chenmozhijin/LDDC), which
searches QQ Music / Kugou / NetEase and returns word-level lyrics.

LDDC is **GPL-3.0-only**, so it is installed as a separate program under `/opt/lddc`
and exposed only on loopback. Backend authentication dependencies must be installed separately.

```bash
sudo ./deploy/install-lddc.sh
```

The script:

1. clones LDDC at a pinned commit into `/opt/lddc/src`;
2. creates `/opt/lddc/venv` with the deps from `lddc-requirements.txt` (no PySide6);
3. generates `/opt/lddc/bridge.env` with a random token (mode 600);
4. installs/enables `currentmusic-lddc.service` (DynamicUser, loopback only);
5. writes `CM_LDDC_URL` / `CM_LDDC_TOKEN` into
   `/etc/systemd/system/currentmusic.service.d/lddc.conf` and restarts the backend.

Verify:

```bash
curl -fsS http://127.0.0.1:3015/health
curl -fsS 'http://127.0.0.1:3010/ncm/lyric?id=3340112781' | jq '.source, .wordLevel, (.lines|length)'
```

Expected chain: NetEase official YRC → LDDC (`lddc:kg`, `lddc:ne`, ...) → local
synthetic timing (`wSynth`). Uninstall by stopping/removing `currentmusic-lddc` and
the `lddc.conf` drop-in; the backend then returns to the synthetic fallback.

Optional tuning in `/opt/lddc/bridge.env` (restart the bridge afterwards):

```bash
LDDC_SOURCES=KG,NE,QM,LRCLIB   # priority order; drop a source if its upstream is blocked
LDDC_DEADLINE=8.5              # overall lookup budget in seconds
LDDC_CACHE_TTL=43200           # in-process positive cache, seconds
```

The bridge has no PySide6 dependency; `tools/lddc_headless/` only supplies the few
`QtCore` types LDDC's non-GUI modules import. On machines without `uv`, install
`python3-venv`/`pip` first and the script will use a normal virtualenv.

Do not expose port 3015 publicly. If you must run it on a non-loopback address,
keep `LDDC_TOKEN` set and put it behind an authenticated proxy.

## Daily full backup

`backup-currentmusic.sh` writes one self-contained archive per day:

- a consistent SQLite snapshot of `CM_DATA_DIR/cm.db` (`.backup`, then
  `PRAGMA integrity_check`);
- avatars, chat images, share images, decorations, preview, app/www and release
  directories;
- `cast/` (regenerable audio cache), `cm.db-wal/-shm` and rotated `cm.db.*`
  copies are deliberately excluded.

It keeps the **newest 3 archives** and removes the oldest after each successful
run, i.e. a rolling three-day retention. Failed backups never delete old archives.

Install:

```bash
sudo install -m 755 deploy/backup-currentmusic.sh /usr/local/sbin/currentmusic-backup
sudo install -m 644 deploy/currentmusic-backup.cron /etc/cron.d/currentmusic-backup
```

For `/srv/currentmusic` the template needs no edits. Otherwise set
`CM_DATA_DIR` in the cron entry to your deployment's data directory.
The schedule is 04:30 daily; logs go to `/var/log/currentmusic-backup.log`.

Manual run / verify:

```bash
sudo CM_DATA_DIR=/srv/currentmusic/data \
  CM_BACKUP_DIR=/var/backups/currentmusic \
  /usr/local/sbin/currentmusic-backup
sudo tar -tzf /var/backups/currentmusic/currentmusic-YYYY-MM-DD.tar.gz | head
```

Restore (service stopped):

```bash
sudo systemctl stop currentmusic
sudo tar -xzf /var/backups/currentmusic/currentmusic-YYYY-MM-DD.tar.gz -C /tmp/cm-restore
sudo install -m 600 /tmp/cm-restore/cm.db /srv/currentmusic/data/cm.db
# copy avatars/chat/share/... as needed, remove stale cm.db-wal/-shm
sudo systemctl start currentmusic
```

Local backups do not survive disk loss; copy `/var/backups/currentmusic` to
off-site storage as well.

## Health checks

```bash
curl -fsS http://127.0.0.1:3010/health
curl -fsS http://127.0.0.1:3015/health   # if LDDC is installed
curl -fsS http://127.0.0.1:3010/station/api-catalog | head
```
