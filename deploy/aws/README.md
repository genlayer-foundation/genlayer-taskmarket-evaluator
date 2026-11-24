# Operate Internet Court on Foundation AWS

The Tempo testnet worker runs on one private ARM64 EC2 instance in the Foundation Apps account, in `us-east-1`. Systems Manager provides administrative access. The read-only ledger listens on the host’s loopback interface at port 4732. The worker checks enrolled tasks every ten seconds. The public Taskmarket listing links buyers to [Internet Court](https://internetcourt.org/) to arrange enrollment.

## Inspect the installation

Use the Foundation Apps SSO profile below or equivalent account credentials. Run these commands from an operator terminal.

```sh
export AWS_PROFILE=foundation-apps AWS_REGION=us-east-1
stack=taskmarket-evaluator-testnet
aws sts get-caller-identity
instance=$(aws cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].Outputs[?OutputKey=='HostId'].OutputValue | [0]" --output text)
bucket=$(aws cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].Outputs[?OutputKey=='Bucket'].OutputValue | [0]" --output text)
aws cloudwatch describe-alarms --alarm-name-prefix "$stack"
aws ssm start-session --target "$instance"
```

In the host session, use `sudo docker ps`, `sudo docker logs --tail 40 taskmarket-worker`, or `sudo systemctl status taskmarket-monitor.timer`. To view the live ledger, use a separate operator terminal with the AWS Session Manager plugin. Open localhost port 14732 while the session runs.

```sh
aws ssm start-session --target "$instance" --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["4732"],"localPortNumber":["14732"]}'
```

## Enroll a buyer

Agree the public text and the milestone prices with the buyer before they post. Have them select **Internet Court** in Taskmarket. For the shipped fixed-price agreement, run these commands on the host after receiving the task ID.

```sh
sudo docker exec taskmarket-worker node dist/src/taskmarket/main.js track <task-id> examples/taskmarket/fixed.json
sudo docker exec taskmarket-worker node dist/src/taskmarket/main.js show <task-id>
```

For other agreed terms, copy the approved public JSON into the worker container and pass its path to `track`. Enrollment stores the agreement in the persistent journal. Keep one signing worker active for this identity. The default deployment takes explicitly enrolled tasks.

A legacy v1 jury can withhold the payment decision. After a Taskmarket evaluator timeout, the requester may reject a delivered claim under its frozen terms. To publish that separate buyer decision, run `node dist/src/taskmarket/main.js record-requester-rejection TASK_ID TIMEOUT_TX REJECTION_TX` inside the matching worker. This reads both public receipts and records the refund and worker rejection fee only if the task events and token transfers agree. It sends no transaction.

## Tempo mainnet worker

The same private host runs `taskmarket-worker-mainnet` and `taskmarket-ledger-mainnet` on a separate data volume directory at `/srv/taskmarket-evaluator/mainnet`. The private ledger binds to loopback port 4733. The mainnet containers receive their own journal and only the worker mounts its dedicated credentials. The backup is `backups/mainnet.sqlite`. The shared monitor checks both workers and publishes network-labelled public receipts.

Set `TASKMARKET_SETTLEMENT_NETWORK=tempo-mainnet` when running the installer for this pair. Its secret is `taskmarket-evaluator-testnet/mainnet-evaluator`. On a replacement host, restore only the matching mainnet journal and reconcile in-flight jobs. The initial empty backup is written once using a conditional S3 put. The installer requires a valid backup whenever the state directory is empty.

The mainnet evaluator wallet is `0x967571C1332800D72eEE2E381984155748599246` on Tempo. The dedicated Bradbury signer is `0xBcbD6e1A10b89a24459786Fa12D7d3e4Db852c22`. Confirm the mainnet identity, available OUSD and Bradbury deposit before accepting a job. Confirm the buyer understands the public testnet ruling controls real OUSD via the operator relay. Generate the public description from the agreed file with `TASKMARKET_SETTLEMENT_NETWORK=tempo-mainnet npm run --silent taskmarket:evaluator -- describe examples/taskmarket/hybrid.json`. Use the full output when posting and enroll the same agreement on the mainnet worker.

```sh
sudo docker exec taskmarket-worker-mainnet node dist/src/taskmarket/main.js track <mainnet-task-id> examples/taskmarket/hybrid.json
```

## Release or recover

The signing worker watches enrolled cases independently of its settlement loop. Its publisher socket at `/run/taskmarket-live/publish.sock` accepts only the public case projection and acknowledges each upload to S3. CloudFront disables caching on `/cases/*`. Taskmarket must accept a case-link email for both onchain wallets before a fresh ruling can start. Ask participants to register their Taskmarket inboxes and prepare a funded Bradbury wallet before delivery. A delivery acknowledgment means the inbox accepted the message. Participants should keep their live case open to see updates without waiting for mail.

The SQLite tables `live_cases` and `notice_deliveries` preserve the last public record and per-wallet delivery receipts across restarts. Check `taskmarket-publisher.service` or `taskmarket-publisher-mainnet.service` on the host if case publication stops. A local signing worker also needs this publisher. Run `AWS_PROFILE=foundation-apps AWS_REGION=us-east-1 python3 deploy/aws/host.py publish-cases "$receipts" tempo-testnet "$TMPDIR/taskmarket-cases/publish.sock"` with the appropriate bucket and set `TASKMARKET_PUBLISH_SOCKET` to that socket. Operators hosting their own site set `TASKMARKET_PUBLIC_URL` to its HTTPS origin. The local simulation requires neither publication nor email.

The `PublicSite` stack output is the standalone Internet Court × Taskmarket landing page. Its `/explorer` reads the same-origin `ReceiptFeed` output. The monitor indexes enrolled jobs from each network’s bound journal. The `inProgress` list includes cases awaiting a submission and milestones still before the AI jury. The explorer reads each active case’s public live record for provisional decisions and appeals. Once every milestone has a finalized ruling, the case leaves the in-progress list. In `completed.json`, the `unsettled` list includes the agreed reward and jury reasons. Once the evaluator verifies a Tempo payment or refund, the job moves to `evaluations` with the transfer amount and receipt. The monitor publishes changes every minute and requests one minute of caching.

To release a site change, run the following from the repository root with the Foundation AWS profile and region set. The evaluator publishes the feed independently.

```sh
receipts=$(aws cloudformation describe-stack-resource --stack-name "$stack" --logical-resource-id Receipts --query StackResourceDetail.PhysicalResourceId --output text)
aws s3 cp site/assets/ "s3://$receipts/assets/" --recursive --cache-control "public, max-age=60"
preview_dir=$(mktemp -d)
python3 deploy/aws/render_explorer_previews.py "$preview_dir"
aws s3 cp "$preview_dir/" "s3://$receipts/assets/previews/" --recursive --content-type text/html --cache-control "public, max-age=60"
aws s3 cp site/explorer.html "s3://$receipts/explorer.html" --content-type text/html --cache-control "public, max-age=60"
aws s3 cp site/case.html "s3://$receipts/case.html" --content-type text/html --cache-control "public, max-age=60"
aws s3 cp site/index.html "s3://$receipts/index.html" --content-type text/html --cache-control "public, max-age=60"
```

- The [CloudFormation template](stack.yaml) creates the host, an outbound-only security group, an encrypted gp3 disk retained on termination, a private ECR repository, a versioned private S3 bucket, a scoped instance role, and two CloudWatch alarms. Select an existing private subnet with outbound access. The deployment uses the same AWS account and region for each resource.
- Build the root Dockerfile for `linux/arm64`, push an immutable commit tag into the stack’s ECR repository, and record the image digest. Put [install.sh](install.sh) and [host.py](host.py) in the private backup bucket as `release/install.sh` and `release/host.py`. The host can write the journal backup for each network there and the public index in the dedicated receipts bucket.
- The Secrets Manager secret `taskmarket-evaluator-testnet/evaluator` holds a JSON object with the evaluator’s Taskmarket device profile under `taskmarket` and its Bradbury key under `bradbury`. Only the signing container mounts the hydrated credential files. Keep the requester and worker wallets separate.
- For first installation or replacement, stop the old signing process and verify it has exited. Prefer the original retained encrypted volume. When restoring from backup, reconcile any in-flight deployment with Bradbury and Tempo before starting a replacement worker. Restore `backups/journal.sqlite` using a verified SQLite online backup and confirm its integrity and last transaction. A running SQLite WAL database requires a consistent SQLite backup.
- From the target’s Systems Manager session as root, set `AWS_REGION`, `BUCKET`, `RECEIPTS_BUCKET` and `IMAGE` to the release’s region, private backup bucket, dedicated receipt bucket (the stack’s `Receipts` resource) and full ECR image URI **with digest**. Download `release/install.sh` and invoke it with Bash. The installer restores the backup only on a fresh disk and starts the worker, private ledger and timer. Reboots restart both containers automatically.
- The timer checks the worker lock, ledger and consistent SQLite backup every minute. It publishes `Healthy` and `NeedsAttention` under `GenLayer/Taskmarket`. Jobs held for review and review deadlines within two hours raise the attention alarm. Testnet alerts stay in CloudWatch. Previous journal versions are retained for 30 days.
- Verify recovery by checking the restored recipient, amount and receipt for the [settled pilot](../../examples/taskmarket/settled-pilot.json). Run `docker exec taskmarket-worker node dist/src/taskmarket/main.js preflight` and confirm the Bradbury signer and Taskmarket network. For the Tempo address, run `docker exec -e TASKMARKET_HOME=/app/data/pilot/evaluator taskmarket-worker node node_modules/@lucid-agents/taskmarket/dist/index.js --network tempo-testnet address`.
