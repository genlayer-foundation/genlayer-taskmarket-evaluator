#!/usr/bin/env bash
# Run on the designated Foundation EC2 host through Systems Manager after handing off the signer.
set -euo pipefail
umask 077
: "${AWS_REGION:?}" "${BUCKET:?}" "${RECEIPTS_BUCKET:?}" "${IMAGE:?}"
[[ "$IMAGE" == *@sha256:* ]]
root=/srv/taskmarket-evaluator
network=${TASKMARKET_SETTLEMENT_NETWORK:-tempo-testnet}
suffix= port=4732 wallet_dir=pilot journal=journal.sqlite
credential_args=(credentials)
case "$network" in
  tempo-testnet) ;;
  tempo-mainnet)
    root="$root/mainnet"; suffix=-mainnet; port=4733; wallet_dir=mainnet; journal=mainnet.sqlite
    credential_args+=(tempo-mainnet)
    ;;
  *) exit 2 ;;
esac
install -d -m 0700 "$root" "$root/keys" "$root/state"
aws s3 cp "s3://$BUCKET/release/host.py" /usr/local/sbin/taskmarket-host.next --only-show-errors
chmod 0700 /usr/local/sbin/taskmarket-host.next
mv /usr/local/sbin/taskmarket-host.next /usr/local/sbin/taskmarket-host
/usr/local/sbin/taskmarket-host "${credential_args[@]}"
if [[ ! -s "$root/state/taskmarket.sqlite" ]]; then
  aws s3 cp "s3://$BUCKET/backups/$journal" "$root/state/restored.sqlite" --only-show-errors
  python3 - "$root/state/restored.sqlite" "$network" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
db.execute("SELECT id FROM jobs LIMIT 1")
allowed = (4217,) if sys.argv[2] == "tempo-mainnet" else (0, 42431)
assert db.execute("PRAGMA application_id").fetchone()[0] in allowed
PY
  mv "$root/state/restored.sqlite" "$root/state/taskmarket.sqlite"
fi
systemctl enable --now docker
config=$(mktemp -d)
trap 'rm -rf -- "$config"' EXIT
aws ecr get-login-password | docker --config "$config" login --username AWS --password-stdin "${IMAGE%%/*}"
docker --config "$config" pull "$IMAGE"
registry_args=(--log-opt max-size=10m --log-opt max-file=3 --security-opt no-new-privileges --cap-drop ALL)
state_args=(-v "$root/state:/state" -e TASKMARKET_DB=/state/taskmarket.sqlite -e TASKMARKET_SETTLEMENT_NETWORK="$network")
# Only the worker receives signing credentials. Bind the ledger to the host loopback for SSM access.
for name in "taskmarket-worker$suffix" "taskmarket-ledger$suffix"; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    docker stop --time 45 "$name"
    docker rm "$name"
  fi
done
docker run -d --name "taskmarket-worker$suffix" --restart unless-stopped "${registry_args[@]}" "${state_args[@]}" \
  -v "$root/keys/evaluator:/app/data/$wallet_dir/evaluator" -v "$root/keys/bradbury.key:/app/data/$wallet_dir/bradbury.key:ro" \
  "$IMAGE" node dist/src/taskmarket/main.js work
docker run -d --name "taskmarket-ledger$suffix" --restart unless-stopped "${registry_args[@]}" "${state_args[@]}" \
  -p "127.0.0.1:$port:3000" "$IMAGE"
if [[ "$network" == tempo-mainnet ]]; then
  install -d /etc/systemd/system/taskmarket-monitor.service.d
  printf '%s\n' '[Service]' 'Environment=MONITOR_MAINNET=1' > /etc/systemd/system/taskmarket-monitor.service.d/mainnet.conf
fi
cat > /etc/systemd/system/taskmarket-monitor.service <<UNIT
[Unit]
Description=Check the Taskmarket evaluator and back up its journal
After=docker.service network-online.target
[Service]
Type=oneshot
Environment=AWS_REGION=$AWS_REGION
Environment=RECEIPTS_BUCKET=$RECEIPTS_BUCKET
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
