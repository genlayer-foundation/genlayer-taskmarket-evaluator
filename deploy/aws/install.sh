#!/usr/bin/env bash
# Run on the designated Foundation EC2 host through Systems Manager after handing off the signer.
set -euo pipefail
umask 077
: "${AWS_REGION:?}" "${BUCKET:?}" "${IMAGE:?}"
[[ "$IMAGE" == *@sha256:* ]]
root=/srv/taskmarket-evaluator
install -d -m 0700 "$root" "$root/keys" "$root/state"
aws s3 cp "s3://$BUCKET/release/host.py" /usr/local/sbin/taskmarket-host --only-show-errors
chmod 0700 /usr/local/sbin/taskmarket-host
/usr/local/sbin/taskmarket-host credentials
if [[ ! -s "$root/state/taskmarket.sqlite" ]]; then
  aws s3 cp "s3://$BUCKET/backups/journal.sqlite" "$root/state/restored.sqlite" --only-show-errors
  python3 -c 'import sqlite3, sys; db=sqlite3.connect(sys.argv[1]); assert db.execute("PRAGMA integrity_check").fetchone()==("ok",); db.execute("SELECT id FROM jobs LIMIT 1")' "$root/state/restored.sqlite"
  mv "$root/state/restored.sqlite" "$root/state/taskmarket.sqlite"
fi
systemctl enable --now docker
config=$(mktemp -d)
trap 'rm -rf -- "$config"' EXIT
aws ecr get-login-password | docker --config "$config" login --username AWS --password-stdin "${IMAGE%%/*}"
docker --config "$config" pull "$IMAGE"
registry_args=(--log-opt max-size=10m --log-opt max-file=3 --security-opt no-new-privileges --cap-drop ALL)
state_args=(-v "$root/state:/state" -e TASKMARKET_DB=/state/taskmarket.sqlite)
# Only the worker receives signing credentials. Bind the ledger to the host loopback for SSM access.
for name in taskmarket-worker taskmarket-ledger; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    docker stop --time 45 "$name"
    docker rm "$name"
  fi
done
docker run -d --name taskmarket-worker --restart unless-stopped "${registry_args[@]}" "${state_args[@]}" \
  -v "$root/keys/evaluator:/app/data/pilot/evaluator" -v "$root/keys/bradbury.key:/app/data/pilot/bradbury.key:ro" \
  "$IMAGE" node dist/src/taskmarket/main.js work
docker run -d --name taskmarket-ledger --restart unless-stopped "${registry_args[@]}" "${state_args[@]}" \
  -p 127.0.0.1:4732:3000 "$IMAGE"
cat > /etc/systemd/system/taskmarket-monitor.service <<UNIT
[Unit]
Description=Check the Taskmarket evaluator and back up its journal
After=docker.service network-online.target
[Service]
Type=oneshot
Environment=AWS_REGION=$AWS_REGION
ExecStart=/usr/local/sbin/taskmarket-host monitor $BUCKET
UNIT
cat > /etc/systemd/system/taskmarket-monitor.timer <<'UNIT'
[Unit]
Description=Monitor the testnet evaluator every minute
[Timer]
OnBootSec=45s
OnUnitActiveSec=60s
AccuracySec=2s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now taskmarket-monitor.timer
