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

## Release or recover

- The [CloudFormation template](stack.yaml) creates the host, an outbound-only security group, an encrypted gp3 disk retained on termination, a private ECR repository, a versioned private S3 bucket, a scoped instance role, and two CloudWatch alarms. Select an existing private subnet with outbound access. The deployment uses the same AWS account and region for each resource.
- Build the root Dockerfile for `linux/arm64`, push an immutable commit tag into the stack’s ECR repository, and record the image digest. Put [install.sh](install.sh) and [host.py](host.py) in the bucket as `release/install.sh` and `release/host.py`. The host can read release artifacts and write only the journal backup.
- The Secrets Manager secret `taskmarket-evaluator-testnet/evaluator` holds a JSON object with the evaluator’s Taskmarket device profile under `taskmarket` and its Bradbury key under `bradbury`. Only the signing container mounts the hydrated credential files. Keep the requester and worker wallets separate.
- For first installation or replacement, stop the old signing process and verify it has exited. Prefer the original retained encrypted volume. When restoring from backup, reconcile any in-flight deployment with Bradbury and Tempo before starting a replacement worker. Restore `backups/journal.sqlite` using a verified SQLite online backup and confirm its integrity and last transaction. A running SQLite WAL database requires a consistent SQLite backup.
- From the target’s Systems Manager session as root, set `AWS_REGION`, `BUCKET` and `IMAGE` to the release’s region, private bucket and full ECR image URI **with digest**. Download `release/install.sh` and invoke it with Bash. The installer restores the backup only on a fresh disk and starts the worker, private ledger and timer. Reboots restart both containers automatically.
- The timer checks the worker lock, ledger and consistent SQLite backup every minute. It publishes `Healthy` and `NeedsAttention` under `GenLayer/Taskmarket`. Jobs held for review and review deadlines within two hours raise the attention alarm. Testnet alerts stay in CloudWatch. Previous journal versions are retained for 30 days.
- Verify recovery by checking the restored recipient, amount and receipt for the [settled pilot](../../examples/taskmarket/settled-pilot.json). Run `docker exec taskmarket-worker node dist/src/taskmarket/main.js preflight` and confirm the Bradbury signer and Taskmarket network. For the Tempo address, run `docker exec -e TASKMARKET_HOME=/app/data/pilot/evaluator taskmarket-worker node node_modules/@lucid-agents/taskmarket/dist/index.js --network tempo-testnet address`.
